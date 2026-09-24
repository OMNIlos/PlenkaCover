import type { AdminBagPrintReconciliationResponseDto } from './dto/admin-print-recovery.dto';
import { assertPrintCommandSettled } from '../../common/printing/assert-print-command-settled';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { BagPrintRecoveryKind, UnresolvedPrintJob } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import type { Actor } from '../../common/auth/actor';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AdminLabelPrintReconciliationDto } from './dto/admin-label-print-reconciliation.dto';

const RECONCILIATION_EVENTS = [
  'audit:defect_bag_label_print_reconciled',
  'audit:bigbag_label_print_reconciled',
];

@Injectable()
export class AdminPrintRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listUnresolved(): Promise<UnresolvedPrintJob[]> {
    const orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
    const [rolls, defects, bags, pallets] = await Promise.all([
      this.prisma.labelPrintJob.findMany({
        where: { status: 'delivery_unknown', reconciliations: { none: {} } },
        select: {
          id: true,
          createdAt: true,
          line: { select: { rollDispatchItem: { select: { rollCode: true } } } },
        },
        orderBy,
        take: 50,
      }),
      this.prisma.defectBagLabelPrintJob.findMany({
        where: { status: 'delivery_unknown' },
        select: { id: true, createdAt: true, defectBag: { select: { code: true } } },
        orderBy,
        take: 50,
      }),
      this.prisma.bigBagLabelPrintJob.findMany({
        where: { status: 'uncertain', channel: 'gateway' },
        select: { id: true, createdAt: true, bigBag: { select: { code: true } } },
        orderBy,
        take: 50,
      }),
      this.prisma.palletPrintJob.findMany({
        where: { status: 'delivery_unknown', reconciliation: { is: null } },
        select: { id: true, createdAt: true, document: { select: { palletId: true } } },
        orderBy,
        take: 50,
      }),
    ]);
    return [
      ...rolls.map(
        (job): UnresolvedPrintJob => ({
          kind: 'roll',
          printJobId: job.id,
          objectCode: job.line.rollDispatchItem.rollCode,
          createdAt: job.createdAt.toISOString(),
        }),
      ),
      ...defects.map(
        (job): UnresolvedPrintJob => ({
          kind: 'defect_bag',
          printJobId: job.id,
          objectCode: job.defectBag.code,
          createdAt: job.createdAt.toISOString(),
        }),
      ),
      ...bags.map(
        (job): UnresolvedPrintJob => ({
          kind: 'big_bag',
          printJobId: job.id,
          objectCode: job.bigBag.code,
          createdAt: job.createdAt.toISOString(),
        }),
      ),
      ...pallets.map(
        (job): UnresolvedPrintJob => ({
          kind: 'pallet',
          printJobId: job.id,
          objectCode: job.document.palletId,
          createdAt: job.createdAt.toISOString(),
        }),
      ),
    ].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.printJobId.localeCompare(b.printJobId),
    );
  }

  async reconcileBag(
    actor: Pick<Actor, 'userId' | 'role'>,
    kind: BagPrintRecoveryKind,
    printJobId: string,
    dto: AdminLabelPrintReconciliationDto,
  ): Promise<AdminBagPrintReconciliationResponseDto> {
    if (!actor.userId) throw new UnauthorizedException('Authentication required.');
    const reason = dto.reason.trim();
    const operationKey = dto.operationKey.toLowerCase();
    const status = dto.outcome === 'label_observed' ? 'submitted' : 'failed';
    const result: AdminBagPrintReconciliationResponseDto = {
      operationKey,
      printJobId,
      kind,
      outcome: dto.outcome,
      status,
    };
    return this.prisma.$transaction(
      async (tx) => {
        // One writer, one lock per decision: a lost response must replay the same durable audit fact.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`bag-print-reconcile:${operationKey}`}))::text`;
        const replay = await tx.domainEvent.findFirst({
          where: {
            type: { in: RECONCILIATION_EVENTS },
            detail: { path: ['operationKey'], equals: operationKey },
          },
          select: { actorId: true, reason: true, detail: true },
        });
        if (replay) {
          const detail = replay.detail as Prisma.JsonObject;
          if (
            replay.actorId !== actor.userId ||
            replay.reason !== reason ||
            detail.kind !== kind ||
            detail.printJobId !== printJobId ||
            detail.outcome !== dto.outcome
          ) {
            throw new ConflictException({
              code: 'ADMIN_PRINT_RECONCILIATION_KEY_CONFLICT',
              message: 'Это решение уже использовано с другими данными.',
            });
          }
          return result;
        }

        const change =
          kind === 'defect_bag'
            ? await this.reconcileDefect(tx, printJobId, status)
            : await this.reconcileBigBag(tx, printJobId, status);
        await this.audit.record(
          {
            type: kind === 'defect_bag' ? RECONCILIATION_EVENTS[0] : RECONCILIATION_EVENTS[1],
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: change.objectId,
            reason,
            detail: { ...result },
            oldValue: change.oldValue,
            newValue: change.newValue,
          },
          tx,
        );
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async reconcileDefect(tx: Prisma.TransactionClient, id: string, status: string) {
    const snapshot = await tx.defectBagLabelPrintJob.findUnique({ where: { id } });
    if (!snapshot) throw new NotFoundException('Задание печати не найдено.');
    // NO KEY UPDATE permits another bag's FK insert while its printer claim holds the session.
    // A closed original session is also recoverable.
    await tx.$queryRaw`SELECT "id" FROM "posts" WHERE "id" = ${snapshot.postId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "operator_post_sessions" WHERE "id" = ${snapshot.postSessionId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "defect_bag_label_print_jobs" WHERE "id" = ${id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "defect_bags" WHERE "id" = ${snapshot.defectBagId} FOR UPDATE`;
    const job = await tx.defectBagLabelPrintJob.findUniqueOrThrow({
      where: { id },
      include: { defectBag: true, postSession: { select: { postId: true, operatorId: true } } },
    });
    const bag = job.defectBag;
    if (
      job.status !== 'delivery_unknown' ||
      job.postId !== snapshot.postId ||
      job.postSessionId !== snapshot.postSessionId ||
      bag.id !== snapshot.defectBagId ||
      bag.postSessionId !== job.postSessionId ||
      job.postSession.postId !== job.postId ||
      job.postSession.operatorId !== job.actorId
    )
      this.changedState();
    const newer = await tx.defectBagLabelPrintJob.count({
      where: {
        defectBagId: bag.id,
        id: { not: id },
        OR: [{ status: 'queued' }, { createdAt: { gte: job.createdAt } }],
      },
    });
    if (newer) this.changedState();
    await assertPrintCommandSettled(tx, job.gatewayCommandId, {
      kind: 'big_bag_label',
      printerId: job.printerId,
      bigBagCode: bag.code,
    });
    const bagStatus =
      status === 'submitted' && bag.status === 'weighed' ? 'ready_for_warehouse' : bag.status;
    await tx.defectBagLabelPrintJob.update({
      where: { id },
      data: {
        status,
        failureReason:
          status === 'submitted'
            ? 'admin_reconciled_label_observed'
            : 'admin_reconciled_not_printed',
        completedAt: job.completedAt ?? new Date(),
      },
    });
    if (bagStatus !== bag.status)
      await tx.defectBag.update({ where: { id: bag.id }, data: { status: bagStatus } });
    return {
      objectId: bag.id,
      oldValue: { printStatus: job.status, bagStatus: bag.status },
      newValue: { printStatus: status, bagStatus },
    };
  }

  private async reconcileBigBag(tx: Prisma.TransactionClient, id: string, status: string) {
    const snapshot = await tx.bigBagLabelPrintJob.findUnique({ where: { id } });
    if (!snapshot) throw new NotFoundException('Задание печати не найдено.');
    // Warehouse gateway and browser print claims also lock the bag before changing its jobs.
    await tx.$queryRaw`SELECT "id" FROM "big_bag_units" WHERE "id" = ${snapshot.bigBagId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "big_bag_label_print_jobs" WHERE "id" = ${id} FOR UPDATE`;
    const job = await tx.bigBagLabelPrintJob.findUniqueOrThrow({
      where: { id },
      include: { bigBag: { select: { code: true } } },
    });
    if (
      job.status !== 'uncertain' ||
      job.channel !== 'gateway' ||
      job.bigBagId !== snapshot.bigBagId
    )
      this.changedState();
    const newer = await tx.bigBagLabelPrintJob.count({
      where: {
        bigBagId: job.bigBagId,
        id: { not: id },
        OR: [{ status: 'queued' }, { createdAt: { gte: job.createdAt } }],
      },
    });
    if (newer) this.changedState();
    await assertPrintCommandSettled(tx, job.gatewayCommandId, {
      kind: 'big_bag_label',
      ...(job.printerId ? { printerId: job.printerId } : {}),
      bigBagCode: job.bigBag.code,
    });
    await tx.bigBagLabelPrintJob.update({
      where: { id },
      data: {
        status,
        failureReason:
          status === 'submitted'
            ? 'admin_reconciled_label_observed'
            : 'admin_reconciled_not_printed',
      },
    });
    return {
      objectId: job.bigBag.code,
      oldValue: { printStatus: job.status },
      newValue: { printStatus: status },
    };
  }

  private changedState(): never {
    throw new ConflictException({
      code: 'ADMIN_PRINT_RECONCILIATION_STATE_CHANGED',
      message: 'Состояние печати изменилось. Обновите список и проверьте этикетку повторно.',
    });
  }
}
