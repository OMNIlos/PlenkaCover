import { assertPrintCommandSettled } from '../../common/printing/assert-print-command-settled';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import type { Actor } from '../../common/auth/actor';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  AdminPalletPrintReconciliationDto,
  AdminPalletPrintReconciliationResponseDto,
  AdminUnresolvedPalletPrintJobResponseDto,
  PalletPrintReconciliationOutcome,
} from './dto/admin-pallet-print-reconciliation.dto';

interface ReconciliationRecord {
  operationKey: string;
  printJobId: string;
  palletListDocumentId: string;
  outcome: string;
  reason: string;
  result: Prisma.JsonValue;
}

type SafeResult = AdminPalletPrintReconciliationResponseDto;

@Injectable()
export class AdminPalletPrintReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listUnresolved(limit?: number): Promise<AdminUnresolvedPalletPrintJobResponseDto[]> {
    const take =
      typeof limit === 'number' && Number.isFinite(limit) && Number.isInteger(limit)
        ? Math.min(50, Math.max(1, limit))
        : 25;
    const jobs = await this.prisma.palletPrintJob.findMany({
      where: {
        status: 'delivery_unknown',
        reconciliation: { is: null },
      },
      select: {
        id: true,
        palletListDocumentId: true,
        status: true,
        createdAt: true,
        completedAt: true,
        document: { select: { palletId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return jobs.map((job) => ({
      printJobId: job.id,
      palletListDocumentId: job.palletListDocumentId,
      palletId: job.document.palletId,
      status: 'delivery_unknown',
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    }));
  }

  async reconcile(
    actor: Pick<Actor, 'userId' | 'role'>,
    printJobId: string,
    dto: AdminPalletPrintReconciliationDto,
  ): Promise<SafeResult> {
    const actorId = this.requireActorId(actor);
    const reason = dto.reason.trim();
    const replay = await this.prisma.palletPrintReconciliation.findUnique({
      where: { operationKey: dto.operationKey },
      select: this.replaySelect(),
    });
    if (replay) return this.exactReplayOrConflict(replay, printJobId, dto.outcome, reason);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.reconcileLocked(tx, actor.role as Role, actorId, printJobId, dto, reason),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (this.isSerializationConflict(error)) {
          if (attempt === 0) continue;
          break;
        }
        if (this.isUniqueConflict(error)) {
          const concurrent = await this.prisma.palletPrintReconciliation.findUnique({
            where: { operationKey: dto.operationKey },
            select: this.replaySelect(),
          });
          if (concurrent) {
            return this.exactReplayOrConflict(concurrent, printJobId, dto.outcome, reason);
          }
          const resolved = await this.prisma.palletPrintReconciliation.findFirst({
            where: { printJobId },
            select: { operationKey: true },
          });
          if (resolved) this.alreadyResolved();
        }
        throw error;
      }
    }
    throw new ConflictException({
      code: 'ADMIN_PALLET_PRINT_RECONCILIATION_CONCURRENT',
      message: 'Concurrent reconciliation; retry with the same operation key.',
    });
  }

  private async reconcileLocked(
    tx: Prisma.TransactionClient,
    actorRole: Role,
    actorId: string,
    printJobId: string,
    dto: AdminPalletPrintReconciliationDto,
    reason: string,
  ): Promise<SafeResult> {
    const immediateReplay = await tx.palletPrintReconciliation.findUnique({
      where: { operationKey: dto.operationKey },
      select: this.replaySelect(),
    });
    if (immediateReplay) {
      return this.exactReplayOrConflict(immediateReplay, printJobId, dto.outcome, reason);
    }

    const snapshot = await tx.palletPrintJob.findUnique({
      where: { id: printJobId },
      select: this.jobSelect(),
    });
    if (!snapshot) throw new NotFoundException(`Pallet print job ${printJobId} not found`);
    const previousResolution = await tx.palletPrintReconciliation.findFirst({
      where: { printJobId },
      select: { operationKey: true },
    });
    if (previousResolution) this.alreadyResolved();
    this.assertReconcilable(snapshot.status);

    const lockedDocument = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "pallet_list_documents" WHERE "id" = ${snapshot.palletListDocumentId} FOR UPDATE`,
    );
    if (lockedDocument.length === 0) this.invalidConcurrentState();
    const lockedJob = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "pallet_print_jobs" WHERE "id" = ${printJobId} FOR UPDATE`,
    );
    if (lockedJob.length === 0) {
      throw new NotFoundException(`Pallet print job ${printJobId} not found`);
    }

    const replay = await tx.palletPrintReconciliation.findUnique({
      where: { operationKey: dto.operationKey },
      select: this.replaySelect(),
    });
    if (replay) return this.exactReplayOrConflict(replay, printJobId, dto.outcome, reason);
    const resolved = await tx.palletPrintReconciliation.findFirst({
      where: { printJobId },
      select: { operationKey: true },
    });
    if (resolved) this.alreadyResolved();

    const job = await tx.palletPrintJob.findUnique({
      where: { id: printJobId },
      select: this.jobSelect(),
    });
    if (!job || !this.sameLockedTarget(snapshot, job)) this.invalidConcurrentState();
    this.assertReconcilable(job.status);
    await assertPrintCommandSettled(tx, job.gatewayCommandId, { kind: 'pallet_label',
      printerId: job.printerId, documentId: job.palletListDocumentId });

    const status = dto.outcome === 'label_observed' ? 'submitted' : 'failed';
    const result: SafeResult = {
      operationKey: dto.operationKey,
      printJobId,
      palletListDocumentId: job.palletListDocumentId,
      outcome: dto.outcome,
      status,
    };
    await tx.palletPrintJob.update({
      where: { id: printJobId },
      data: {
        status,
        failureReason:
          dto.outcome === 'label_observed'
            ? 'admin_reconciled_label_observed'
            : 'admin_reconciled_not_printed',
        completedAt: job.completedAt ?? new Date(),
      },
    });
    await tx.palletPrintReconciliation.create({
      data: {
        operationKey: dto.operationKey,
        printJobId,
        palletListDocumentId: job.palletListDocumentId,
        actorId,
        outcome: dto.outcome,
        reason,
        result: result as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(
      {
        type: 'audit:pallet_list_print_reconciled',
        actorRole,
        actorId,
        objectId: job.palletListDocumentId,
        oldValue: { printStatus: 'delivery_unknown' },
        newValue: { printStatus: status },
        reason,
        detail: {
          operationKey: dto.operationKey,
          printJobId,
          outcome: dto.outcome,
        },
      },
      tx,
    );
    return result;
  }

  private jobSelect() {
    return {
      id: true,
      palletListDocumentId: true,
      requestId: true,
      printerId: true,
      gatewayCommandId: true,
      status: true,
      failureReason: true,
      completedAt: true,
    } as const;
  }

  private sameLockedTarget(
    before: {
      id: string;
      palletListDocumentId: string;
      requestId: string;
      printerId: string;
      gatewayCommandId: string | null;
      status: string;
      failureReason: string | null;
      completedAt: Date | null;
    },
    after: {
      id: string;
      palletListDocumentId: string;
      requestId: string;
      printerId: string;
      gatewayCommandId: string | null;
      status: string;
      failureReason: string | null;
      completedAt: Date | null;
    },
  ): boolean {
    return (
      after.id === before.id &&
      after.palletListDocumentId === before.palletListDocumentId &&
      after.requestId === before.requestId &&
      after.printerId === before.printerId &&
      after.gatewayCommandId === before.gatewayCommandId &&
      after.status === before.status &&
      after.failureReason === before.failureReason &&
      after.completedAt?.getTime() === before.completedAt?.getTime()
    );
  }

  private assertReconcilable(status: string): void {
    if (status !== 'delivery_unknown') this.invalidConcurrentState();
  }

  private exactReplayOrConflict(
    record: ReconciliationRecord,
    printJobId: string,
    outcome: PalletPrintReconciliationOutcome,
    reason: string,
  ): SafeResult {
    if (
      record.printJobId !== printJobId ||
      record.outcome !== outcome ||
      record.reason !== reason
    ) {
      throw new ConflictException({
        code: 'ADMIN_PALLET_PRINT_RECONCILIATION_KEY_CONFLICT',
        message: 'The operation key was already used for another reconciliation intent.',
      });
    }
    const stored = record.result;
    if (!stored || Array.isArray(stored) || typeof stored !== 'object') {
      this.invalidConcurrentState();
    }
    const status = stored.status;
    if (status !== 'submitted' && status !== 'failed') this.invalidConcurrentState();
    const expected = outcome === 'label_observed' ? 'submitted' : 'failed';
    if (status !== expected) this.invalidConcurrentState();
    return {
      operationKey: record.operationKey,
      printJobId: record.printJobId,
      palletListDocumentId: record.palletListDocumentId,
      outcome,
      status,
    };
  }

  private replaySelect() {
    return {
      operationKey: true,
      printJobId: true,
      palletListDocumentId: true,
      outcome: true,
      reason: true,
      result: true,
    } as const;
  }

  private requireActorId(actor: Pick<Actor, 'userId'>): string {
    if (!actor.userId) throw new UnauthorizedException('Authenticated admin identity required.');
    return actor.userId;
  }

  private alreadyResolved(): never {
    throw new ConflictException({
      code: 'ADMIN_PALLET_PRINT_RECONCILIATION_ALREADY_RESOLVED',
      message: 'This pallet print job already has an immutable reconciliation.',
    });
  }

  private invalidConcurrentState(): never {
    throw new ConflictException({
      code: 'ADMIN_PALLET_PRINT_RECONCILIATION_INVALID_STATE',
      message: 'Only an unresolved pallet-label delivery can be reconciled.',
    });
  }

  private isSerializationConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code === 'P2034') return true;
    if (error.code !== 'P2010' || !error.meta) return false;
    const sqlState = error.meta.code;
    return sqlState === '40001' || sqlState === '40P01';
  }

  private isUniqueConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
