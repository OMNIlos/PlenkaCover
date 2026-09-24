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
import { settleReconciledRollPrintOperation } from '../../common/printing/gateway-print-failure-reconciliation';
import type {
  AdminLabelPrintReconciliationDto,
  LabelPrintReconciliationOutcome,
} from './dto/admin-label-print-reconciliation.dto';

export interface SafeReconciliationResult {
  operationKey: string;
  printJobId: string;
  rollCode: string;
  outcome: LabelPrintReconciliationOutcome;
  step: 'qr_check' | 'qr_print' | 'handover';
  labelState: 'not_printed' | 'submitted' | 'reprint_requested';
}

interface ReconciliationRecord {
  operationKey: string;
  printJobId: string;
  outcome: string;
  reason: string;
  result: Prisma.JsonValue;
}

@Injectable()
export class AdminLabelPrintReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async reconcile(
    actor: Pick<Actor, 'userId' | 'role'>,
    printJobId: string,
    dto: AdminLabelPrintReconciliationDto,
  ): Promise<SafeReconciliationResult> {
    const actorId = this.requireActorId(actor);
    const reason = dto.reason.trim();
    const replay = await this.prisma.labelPrintReconciliation.findUnique({
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
          const concurrent = await this.prisma.labelPrintReconciliation.findUnique({
            where: { operationKey: dto.operationKey },
            select: this.replaySelect(),
          });
          if (concurrent) {
            return this.exactReplayOrConflict(concurrent, printJobId, dto.outcome, reason);
          }
        }
        throw error;
      }
    }
    throw new ConflictException({
      code: 'ADMIN_LABEL_RECONCILIATION_CONCURRENT',
      message: 'Concurrent reconciliation; retry with the same operation key.',
    });
  }

  private async reconcileLocked(
    tx: Prisma.TransactionClient,
    actorRole: Role,
    actorId: string,
    printJobId: string,
    dto: AdminLabelPrintReconciliationDto,
    reason: string,
  ): Promise<SafeReconciliationResult> {
    const immediateReplay = await tx.labelPrintReconciliation.findUnique({
      where: { operationKey: dto.operationKey },
      select: this.replaySelect(),
    });
    if (immediateReplay) {
      return this.exactReplayOrConflict(immediateReplay, printJobId, dto.outcome, reason);
    }

    const snapshot = await tx.labelPrintJob.findUnique({
      where: { id: printJobId },
      select: this.jobSelect(),
    });
    if (!snapshot) throw new NotFoundException(`Label print job ${printJobId} not found`);
    this.assertReconcilable(snapshot);
    const postId = snapshot.postId as string;

    // Global device/lifecycle order: Post before Session/roll work; once Post is held,
    // mirror operator print finalization's Roll -> Job -> Line downstream order.
    const lockedPost = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`,
    );
    if (lockedPost.length === 0) this.invalidConcurrentState();
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "roll_dispatch_items" WHERE "id" = ${snapshot.line.rollDispatchItem.id} FOR UPDATE`,
    );
    const lockedJob = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "label_print_jobs" WHERE "id" = ${printJobId} FOR UPDATE`,
    );
    if (lockedJob.length === 0) {
      throw new NotFoundException(`Label print job ${printJobId} not found`);
    }

    const replay = await tx.labelPrintReconciliation.findUnique({
      where: { operationKey: dto.operationKey },
      select: this.replaySelect(),
    });
    if (replay) return this.exactReplayOrConflict(replay, printJobId, dto.outcome, reason);

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "operator_roll_lines" WHERE "id" = ${snapshot.line.id} FOR UPDATE`,
    );
    const [post, job] = await Promise.all([
      tx.post.findUnique({ where: { id: postId }, select: { id: true } }),
      tx.labelPrintJob.findUnique({ where: { id: printJobId }, select: this.jobSelect() }),
    ]);
    if (!post || !job || !this.sameLockedTarget(snapshot, job)) this.invalidConcurrentState();
    this.assertReconcilable(job);
    await assertPrintCommandSettled(tx, job.gatewayCommandId, { kind: 'roll_label',
      ...(job.printerId ? { printerId: job.printerId } : {}), rollCode: job.line.rollDispatchItem.rollCode });

    const observed = dto.outcome === 'label_observed';
    const priorPrintedJob = observed
      ? null
      : await tx.labelPrintJob.findFirst({
          where: {
            operatorRollLineId: job.operatorRollLineId,
            status: { in: ['submitted', 'printed'] },
          },
          select: { id: true },
        });
    const predecessor = job.line.step as SafeReconciliationResult['step'];
    const result: SafeReconciliationResult = {
      operationKey: dto.operationKey,
      printJobId,
      rollCode: job.line.rollDispatchItem.rollCode,
      outcome: dto.outcome,
      step: observed ? 'qr_check' : predecessor,
      labelState: observed
        ? 'submitted'
        : priorPrintedJob
          ? 'reprint_requested'
          : 'not_printed',
    };

    await tx.labelPrintJob.update({
      where: { id: printJobId },
      data: {
        status: observed ? 'submitted' : 'failed',
        failureReason: observed
          ? 'admin_reconciled_label_observed'
          : 'admin_reconciled_not_printed',
        completedAt: job.completedAt ?? new Date(),
      },
    });
    await tx.operatorRollLine.update({
      where: { id: job.line.id },
      data: { step: result.step, labelState: result.labelState },
    });
    await settleReconciledRollPrintOperation(tx, printJobId, observed);
    await tx.labelPrintReconciliation.create({
      data: {
        operationKey: dto.operationKey,
        printJobId,
        operatorRollLineId: job.operatorRollLineId,
        postId,
        actorId,
        outcome: dto.outcome,
        reason,
        result: result as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(
      {
        type: 'audit:operator_label_print_reconciled',
        actorRole,
        actorId,
        objectId: result.rollCode,
        oldValue: {
          printStatus: 'delivery_unknown',
          step: predecessor,
          labelState: 'delivery_unknown',
        },
        newValue: {
          printStatus: observed ? 'submitted' : 'failed',
          step: result.step,
          labelState: result.labelState,
        },
        reason,
        detail: { operationKey: dto.operationKey, printJobId, postId, outcome: dto.outcome },
      },
      tx,
    );
    return result;
  }

  private jobSelect() {
    return {
      id: true,
      status: true,
      completedAt: true,
      postId: true,
      printerId: true,
      gatewayCommandId: true,
      operatorRollLineId: true,
      line: {
        select: {
          id: true,
          step: true,
          labelState: true,
          warehouseState: true,
          rollDispatchItem: { select: { id: true, rollCode: true, status: true } },
        },
      },
    } as const;
  }

  private sameLockedTarget(
    before: {
      id: string;
      status: string;
      postId: string | null;
      operatorRollLineId: string;
      line: {
        id: string;
        step: string;
        labelState: string;
        warehouseState: string;
        rollDispatchItem: { id: string; rollCode: string; status: string };
      };
    },
    after: {
      id: string;
      status: string;
      postId: string | null;
      operatorRollLineId: string;
      line: {
        id: string;
        step: string;
        labelState: string;
        warehouseState: string;
        rollDispatchItem: { id: string; rollCode: string; status: string };
      };
    },
  ): boolean {
    return (
      after.id === before.id &&
      after.status === before.status &&
      after.postId === before.postId &&
      after.operatorRollLineId === before.operatorRollLineId &&
      after.line.id === before.line.id &&
      after.line.step === before.line.step &&
      after.line.labelState === before.line.labelState &&
      after.line.warehouseState === before.line.warehouseState &&
      after.line.rollDispatchItem.id === before.line.rollDispatchItem.id &&
      after.line.rollDispatchItem.rollCode === before.line.rollDispatchItem.rollCode &&
      after.line.rollDispatchItem.status === before.line.rollDispatchItem.status
    );
  }

  private invalidConcurrentState(): never {
    throw new ConflictException({
      code: 'ADMIN_LABEL_RECONCILIATION_INVALID_STATE',
      message: 'Print job topology or state changed before reconciliation.',
    });
  }

  private assertReconcilable(job: {
    status: string;
    postId: string | null;
    line: {
      step: string;
      labelState: string;
      warehouseState: string;
      rollDispatchItem: { status: string };
    };
  }): void {
    const valid =
      job.status === 'delivery_unknown' &&
      job.postId !== null &&
      ['qr_print', 'qr_check', 'handover'].includes(job.line.step) &&
      job.line.labelState === 'delivery_unknown' &&
      job.line.warehouseState === 'not_ready' &&
      !['ready_for_warehouse', 'done'].includes(job.line.rollDispatchItem.status);
    if (!valid) {
      throw new ConflictException({
        code: 'ADMIN_LABEL_RECONCILIATION_INVALID_STATE',
        message: 'Only an unresolved label delivery can be reconciled.',
      });
    }
  }

  private exactReplayOrConflict(
    record: ReconciliationRecord,
    printJobId: string,
    outcome: LabelPrintReconciliationOutcome,
    reason: string,
  ): SafeReconciliationResult {
    if (
      record.printJobId !== printJobId ||
      record.outcome !== outcome ||
      record.reason !== reason
    ) {
      throw new ConflictException({
        code: 'ADMIN_LABEL_RECONCILIATION_KEY_CONFLICT',
        message: 'The operation key was already used for another reconciliation intent.',
      });
    }
    const stored = record.result;
    if (!stored || Array.isArray(stored) || typeof stored !== 'object') {
      throw new ConflictException({
        code: 'ADMIN_LABEL_RECONCILIATION_INVALID_STATE',
        message: 'Stored reconciliation result is invalid.',
      });
    }
    const step = stored.step;
    const labelState = stored.labelState;
    const rollCode = stored.rollCode;
    if (
      (step !== 'qr_check' && step !== 'qr_print' && step !== 'handover') ||
      (labelState !== 'not_printed' &&
        labelState !== 'submitted' &&
        labelState !== 'reprint_requested') ||
      typeof rollCode !== 'string'
    ) {
      throw new ConflictException({
        code: 'ADMIN_LABEL_RECONCILIATION_INVALID_STATE',
        message: 'Stored reconciliation result is invalid.',
      });
    }
    return {
      operationKey: record.operationKey,
      printJobId: record.printJobId,
      rollCode,
      outcome,
      step,
      labelState,
    };
  }

  private replaySelect() {
    return {
      operationKey: true,
      printJobId: true,
      outcome: true,
      reason: true,
      result: true,
    } as const;
  }

  private requireActorId(actor: Pick<Actor, 'userId'>): string {
    if (!actor.userId) throw new UnauthorizedException('Authenticated admin identity required.');
    return actor.userId;
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
