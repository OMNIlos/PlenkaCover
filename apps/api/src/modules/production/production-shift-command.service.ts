import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateIndividualShiftInput,
  CancelMachineChangeInput,
  FinalizeMachineChangeInput,
  IndividualShiftCommandResult,
  MachineChangeCancellationView,
  MachineChangeFinalizationView,
  MachineChangePendingBigBag,
  MachineChangeRequestInput,
  MachineChangeView,
  Role,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PostDeviceReadinessService } from '../../common/device-readiness/post-device-readiness.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SCALE_ADAPTER, type ScaleAdapter } from '../../integrations/scale/scale.adapter';
import { ProductionService } from './production.service';

const MACHINE_CHANGE_RUNTIME_INCLUDE = {
  fromPost: { select: { id: true, code: true, name: true } },
  toPost: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.OperatorMachineChangeInclude;

type RuntimeMachineChange = Prisma.OperatorMachineChangeGetPayload<{
  include: typeof MACHINE_CHANGE_RUNTIME_INCLUDE;
}>;

type PreparedBagCapture = {
  sessionId: string;
  usageId: string;
  bigBagId: string;
};

const MACHINE_CHANGE_PHYSICAL_EVENT_TYPES = [
  'audit:operator_weight_captured',
  'audit:operator_roll_reweighed',
  'audit:operator_label_print_submitted',
  'audit:operator_label_print_reconciled',
  'audit:operator_qr_verified',
  'audit:operator_physical_operation_recovered',
  'audit:bigbag_weight_recorded',
  'audit:bigbag_scan_recorded',
];
const MOSCOW_SHIFT_DATE = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
});

function defaultIndividualShiftLabel(at: Date, operatorName: string, postCode: string): string {
  return `Смена ${MOSCOW_SHIFT_DATE.format(at)} · ${operatorName} · ${postCode}`;
}

function machineChangeConflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

export function machineChangeCancellationFingerprintInput(
  changeId: string,
  input: CancelMachineChangeInput,
) {
  return {
    changeId,
    operationKey: input.operationKey.trim().toLowerCase(),
    reason: input.reason.trim(),
  };
}

@Injectable()
export class ProductionShiftCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly production: ProductionService,
    private readonly deviceReadiness: PostDeviceReadinessService,
    @Optional() @Inject(SCALE_ADAPTER) private readonly scale?: ScaleAdapter,
  ) {}

  async createIndividualShift(
    actor: { userId: string | null; role: Role },
    input: CreateIndividualShiftInput,
  ): Promise<IndividualShiftCommandResult> {
    if (!actor.userId) {
      throw new ConflictException('Для создания смены требуется пользовательская сессия.');
    }
    const requestedLabel = input.label?.trim() || null;
    const fingerprintLabel = requestedLabel ?? `Смена оператора ${input.operatorId}`;
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          actorId: actor.userId,
          operatorId: input.operatorId,
          postId: input.postId,
          label: fingerprintLabel,
        }),
      )
      .digest('hex');

    const replay = await this.findShiftReplay(input.operationKey, requestFingerprint);
    if (replay) {
      await this.publishProductionOrdersForDispatchItems(actor, replay.dispatchItemIds);
      return replay;
    }
    let result: IndividualShiftCommandResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Serializes operator commands without blocking FK checks during post handover.
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${input.operatorId} FOR NO KEY UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${input.postId} FOR UPDATE`,
        );
        const lockedReplay = await this.findShiftReplay(input.operationKey, requestFingerprint, tx);
        if (lockedReplay) return lockedReplay;

        const [operator, post] = await Promise.all([
          tx.user.findUnique({ where: { id: input.operatorId } }),
          tx.post.findUnique({ where: { id: input.postId } }),
        ]);
        if (!operator || operator.role !== 'operator' || !operator.isActive) {
          throw new NotFoundException('Активный оператор не найден.');
        }
        if (!post || post.status !== 'active') {
          throw new ConflictException('Выбранный пост недоступен.');
        }
        const label =
          requestedLabel ??
          defaultIndividualShiftLabel(new Date(), operator.displayName, post.code);
        const conflictingAssignment = await tx.operatorShiftMachineAssignment.findFirst({
          where: {
            operatorId: input.operatorId,
            status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
            shift: {
              status: { in: ['planned', 'open'] },
            },
          },
          select: { id: true },
        });
        if (conflictingAssignment) {
          throw new ConflictException('У оператора уже есть активная смена.');
        }

        const assignedWhere = {
          assignedOperatorId: input.operatorId,
          status: { notIn: ['done', 'ready_for_warehouse'] },
        } satisfies Prisma.RollDispatchItemWhereInput;
        let dispatchWhere: Prisma.RollDispatchItemWhereInput = {
          ...assignedWhere,
          plannedShiftId: null,
        };
        let dispatchItems = await tx.rollDispatchItem.findMany({
          where: dispatchWhere,
          select: {
            id: true,
            productionOrderId: true,
          },
        });
        if (dispatchItems.length === 0) {
          dispatchWhere = { ...assignedWhere, plannedShift: { status: 'closed' } };
          dispatchItems = await tx.rollDispatchItem.findMany({
            where: dispatchWhere,
            select: {
              id: true,
              productionOrderId: true,
            },
          });
        }
        const dispatchItemIds = dispatchItems.map(({ id }) => id).sort();
        const productionOrderIds = [
          ...new Set(dispatchItems.map(({ productionOrderId }) => productionOrderId)),
        ].sort();
        for (const productionOrderId of productionOrderIds) {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "production_orders"
              WHERE "id" = ${productionOrderId} FOR UPDATE`,
          );
        }
        if (dispatchItemIds.length > 0) {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
              WHERE "id" IN (${Prisma.join(dispatchItemIds)})
              ORDER BY "id" FOR UPDATE`,
          );
        }

        const shift = await tx.shift.create({
          data: {
            label,
            plannedStartAt: null,
            plannedEndAt: null,
            operationKey: input.operationKey,
            requestFingerprint,
          },
        });
        const assignment = await tx.operatorShiftMachineAssignment.create({
          data: {
            shiftId: shift.id,
            operatorId: input.operatorId,
            postId: input.postId,
            createdById: actor.userId,
          },
        });
        if (dispatchItemIds.length > 0) {
          const moved = await tx.rollDispatchItem.updateMany({
            where: {
              ...dispatchWhere,
              id: { in: dispatchItemIds },
            },
            data: {
              assignedOperatorId: input.operatorId,
              postId: input.postId,
              machineId: post.code,
              workplaceId: input.postId,
              plannedShiftId: shift.id,
            },
          });
          if (moved.count !== dispatchItemIds.length) {
            throw new ConflictException('Назначения изменились во время создания смены.');
          }
        }
        const result: IndividualShiftCommandResult = {
          shift: {
            id: shift.id,
            label,
            plannedStartAt: null,
            plannedEndAt: null,
            status: 'planned',
            operationKey: input.operationKey,
          },
          assignment: {
            id: assignment.id,
            shiftId: shift.id,
            operatorId: input.operatorId,
            postId: input.postId,
            status: 'planned',
          },
          dispatchItemIds,
        };
        await tx.shift.update({
          where: { id: shift.id },
          data: { commandResult: result as unknown as Prisma.InputJsonValue },
        });
        await this.audit.record(
          {
            type: 'audit:operator_shift_machine_assigned',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: assignment.id,
            detail: {
              shiftId: shift.id,
              operatorId: input.operatorId,
              postId: input.postId,
              dispatchItemIds,
              individual: true,
            },
          },
          tx,
        );
        return result;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const racedReplay = await this.findShiftReplay(input.operationKey, requestFingerprint);
        if (racedReplay) {
          result = racedReplay;
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    // Approval takes the full shop topology itself. Run it only after the shift transaction
    // releases its production-order and roll locks, and retry it on idempotent command replay.
    await this.publishProductionOrdersForDispatchItems(actor, result.dispatchItemIds);
    return result;
  }

  private async publishProductionOrdersForDispatchItems(
    actor: { userId: string | null; role: Role },
    dispatchItemIds: readonly string[],
  ): Promise<void> {
    if (dispatchItemIds.length === 0) return;
    const dispatchItems = await this.prisma.rollDispatchItem.findMany({
      where: { id: { in: [...dispatchItemIds] } },
      select: { productionOrderId: true },
    });
    const productionOrderIds = [
      ...new Set(dispatchItems.map(({ productionOrderId }) => productionOrderId)),
    ].sort();
    for (const productionOrderId of productionOrderIds) {
      await this.production.publishProductionOrderWhenReady(actor, productionOrderId, {
        requireComplete: false,
      });
    }
  }

  async requestMachineChange(
    actor: { userId: string | null; role: Role },
    assignmentId: string,
    input: MachineChangeRequestInput,
  ) {
    if (!actor.userId) {
      throw new ConflictException('Для смены станка требуется пользовательская сессия.');
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException('Причина смены станка обязательна.');
    }
    const replay = await this.findMachineChangeReplay(input.operationKey, {
      assignmentId,
      toPostId: input.postId,
      reason,
    });
    if (replay) return replay;
    const assignmentSnapshot = await this.prisma.operatorShiftMachineAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, shiftId: true, postId: true },
    });
    if (!assignmentSnapshot) {
      throw new NotFoundException('Назначение оператора не найдено.');
    }
    if (assignmentSnapshot.postId === input.postId) {
      throw new ConflictException('Новый пост совпадает с текущим.');
    }
    await this.deviceReadiness.require(input.postId, 'production.assignment');

    try {
      return await this.prisma.$transaction(async (tx) => {
        for (const postId of [assignmentSnapshot.postId, input.postId].sort()) {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`,
          );
        }
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "shifts"
            WHERE "id" = ${assignmentSnapshot.shiftId} FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments"
            WHERE "id" = ${assignmentId} FOR UPDATE`,
        );
        const assignment = await tx.operatorShiftMachineAssignment.findUnique({
          where: { id: assignmentId },
          include: { post: true },
        });
        if (!assignment) throw new NotFoundException('Назначение оператора не найдено.');
        if (
          assignment.shiftId !== assignmentSnapshot.shiftId ||
          assignment.postId !== assignmentSnapshot.postId
        ) {
          throw new ConflictException('Назначение оператора изменилось; обновите экран.');
        }
        if (assignment.status !== 'locked') {
          throw new ConflictException('Смена станка доступна только в активной смене оператора.');
        }
        if (assignment.postId === input.postId) {
          throw new ConflictException('Новый пост совпадает с текущим.');
        }

        const [fromPost, toPost] = await Promise.all([
          tx.post.findUnique({ where: { id: assignment.postId } }),
          tx.post.findUnique({ where: { id: input.postId } }),
        ]);
        if (!fromPost || fromPost.status !== 'active') {
          throw new ConflictException('Текущий пост уже недоступен или переведён в аварию.');
        }
        if (!toPost || toPost.status !== 'active') {
          throw new ConflictException('Целевой пост недоступен.');
        }
        await this.deviceReadiness.require(toPost.id, 'production.assignment', tx);
        const [activeSession, occupiedSession, occupiedAssignment, pendingChange] =
          await Promise.all([
            tx.operatorPostSession.findFirst({
              where: {
                operatorId: assignment.operatorId,
                shiftId: assignment.shiftId,
                postId: assignment.postId,
                status: 'active',
              },
            }),
            tx.operatorPostSession.findFirst({
              where: {
                postId: input.postId,
                status: 'active',
                operatorId: { not: assignment.operatorId },
              },
              select: { id: true },
            }),
            tx.operatorShiftMachineAssignment.findFirst({
              where: {
                id: { not: assignment.id },
                postId: input.postId,
                status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
                shift: { status: { in: ['planned', 'open'] } },
              },
              select: { id: true },
            }),
            tx.operatorMachineChange.findFirst({
              where: {
                assignmentId,
                status: { in: ['requested', 'awaiting_final_weight', 'ready'] },
              },
              select: { id: true },
            }),
          ]);
        if (!activeSession) {
          throw new ConflictException('У оператора нет активной сессии на текущем посту.');
        }
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "operator_post_sessions"
            WHERE "id" = ${activeSession.id} FOR UPDATE`,
        );
        if (occupiedSession || occupiedAssignment) {
          throw new ConflictException('Целевой пост уже занят.');
        }
        if (pendingChange) {
          throw new ConflictException('Для назначения уже выполняется смена станка.');
        }
        const openBagUsage = await tx.shiftBagUsage.findFirst({
          where: { sessionId: activeSession.id, closedAt: null },
          select: { id: true },
        });
        const status = openBagUsage ? 'awaiting_final_weight' : 'ready';
        const change = await tx.operatorMachineChange.create({
          data: {
            assignmentId,
            shiftId: assignment.shiftId,
            operatorId: assignment.operatorId,
            fromPostId: assignment.postId,
            toPostId: input.postId,
            reason,
            operationKey: input.operationKey,
            status,
            ...(status === 'ready' ? { readyAt: new Date() } : {}),
          },
        });
        await this.audit.record(
          {
            type: 'audit:operator_machine_change_requested',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: assignmentId,
            reason,
            oldValue: { postId: assignment.postId },
            newValue: { postId: input.postId },
            detail: {
              changeId: change.id,
              shiftId: assignment.shiftId,
              operatorId: assignment.operatorId,
              status,
            },
          },
          tx,
        );
        await this.audit.record(
          {
            type: 'notification:operator_machine_change_requested',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: assignmentId,
            reason,
            detail: {
              changeId: change.id,
              shiftId: assignment.shiftId,
              operatorId: assignment.operatorId,
              fromPostId: assignment.postId,
              toPostId: input.postId,
              status,
              recipientRoles: ['operator', 'production_lead', 'director'],
              recipientUserIds: [assignment.operatorId],
            },
          },
          tx,
        );
        if (status === 'ready') {
          await this.audit.record(
            {
              type: 'audit:operator_machine_change_ready',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: assignmentId,
              reason,
              detail: {
                changeId: change.id,
                shiftId: assignment.shiftId,
                operatorId: assignment.operatorId,
                noOpenBigBag: true,
              },
            },
            tx,
          );
          await this.audit.record(
            {
              type: 'notification:operator_machine_change_ready',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: assignmentId,
              reason,
              detail: {
                changeId: change.id,
                operatorId: assignment.operatorId,
                recipientRoles: ['operator', 'production_lead', 'director'],
                recipientUserIds: [assignment.operatorId],
              },
            },
            tx,
          );
        }
        return change;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const racedReplay = await this.findMachineChangeReplay(input.operationKey, {
          assignmentId,
          toPostId: input.postId,
          reason,
        });
        if (racedReplay) return racedReplay;
      }
      throw error;
    }
  }

  async finalizeMachineChange(
    actor: { userId: string | null; role: Role },
    changeId: string,
    input: FinalizeMachineChangeInput = {},
  ): Promise<MachineChangeFinalizationView> {
    if (!actor.userId) {
      throw new ConflictException('Для завершения смены станка требуется сессия оператора.');
    }
    const snapshot = await this.prisma.operatorMachineChange.findUnique({
      where: { id: changeId },
    });
    if (!snapshot) throw new NotFoundException('Операция смены станка не найдена.');
    if (snapshot.operatorId !== actor.userId) {
      throw new ForbiddenException('Эту смену станка должен завершить назначенный оператор.');
    }
    if (snapshot.status === 'completed') {
      return {
        changeId: snapshot.id,
        status: 'completed',
        remainingBigBags: [],
        completedAt: snapshot.completedAt?.toISOString() ?? null,
      };
    }
    if (!['awaiting_final_weight', 'ready'].includes(snapshot.status)) {
      throw new ConflictException('Операция смены станка не готова к завершению.');
    }

    const prepared =
      snapshot.status === 'awaiting_final_weight'
        ? await this.prepareFinalBagCapture(snapshot, input.bigBagId)
        : null;
    const evidence = prepared ? await this.readFinalBagWeight(snapshot, prepared) : null;

    return this.prisma.$transaction(async (tx) => {
      for (const postId of [snapshot.fromPostId, snapshot.toPostId].sort()) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`);
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${snapshot.shiftId} FOR UPDATE`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments"
          WHERE "id" = ${snapshot.assignmentId} FOR UPDATE`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_machine_changes"
          WHERE "id" = ${changeId} FOR UPDATE`,
      );
      const change = await tx.operatorMachineChange.findUnique({ where: { id: changeId } });
      if (!change) throw new NotFoundException('Операция смены станка не найдена.');
      if (change.operatorId !== actor.userId) {
        throw new ForbiddenException('Эту смену станка должен завершить назначенный оператор.');
      }
      if (change.status === 'completed') {
        return {
          changeId: change.id,
          status: 'completed',
          remainingBigBags: [],
          completedAt: change.completedAt?.toISOString() ?? null,
        };
      }
      if (!['awaiting_final_weight', 'ready'].includes(change.status)) {
        throw new ConflictException('Операция смены станка изменилась; обновите экран.');
      }

      const [assignment, fromPost, toPost, session] = await Promise.all([
        tx.operatorShiftMachineAssignment.findUnique({ where: { id: change.assignmentId } }),
        tx.post.findUnique({ where: { id: change.fromPostId } }),
        tx.post.findUnique({ where: { id: change.toPostId } }),
        tx.operatorPostSession.findFirst({
          where: {
            operatorId: change.operatorId,
            shiftId: change.shiftId,
            postId: change.fromPostId,
            status: 'active',
          },
        }),
      ]);
      if (
        !assignment ||
        assignment.operatorId !== change.operatorId ||
        assignment.shiftId !== change.shiftId ||
        assignment.postId !== change.fromPostId ||
        assignment.status !== 'locked'
      ) {
        throw new ConflictException('Назначение оператора изменилось до завершения переноса.');
      }
      if (!fromPost || fromPost.status !== 'active') {
        throw new ConflictException('Исходный пост больше не находится в исправном состоянии.');
      }
      if (!toPost || toPost.status !== 'active') {
        throw new ConflictException('Целевой пост больше недоступен.');
      }
      await this.deviceReadiness.require(toPost.id, 'production.assignment', tx);
      if (!session) {
        throw new ConflictException('Активная сессия исходного поста не найдена.');
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_post_sessions"
          WHERE "id" = ${session.id} FOR UPDATE`,
      );
      const [occupiedSession, occupiedAssignment] = await Promise.all([
        tx.operatorPostSession.findFirst({
          where: {
            postId: change.toPostId,
            status: 'active',
            operatorId: { not: change.operatorId },
          },
          select: { id: true },
        }),
        tx.operatorShiftMachineAssignment.findFirst({
          where: {
            id: { not: assignment.id },
            postId: change.toPostId,
            status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
            shift: { status: { in: ['planned', 'open'] } },
          },
          select: { id: true },
        }),
      ]);
      if (occupiedSession || occupiedAssignment) {
        throw new ConflictException('Целевой пост занят; перенос не выполнен.');
      }

      let openUsages = await tx.shiftBagUsage.findMany({
        where: { sessionId: session.id, closedAt: null },
        include: { bigBag: { select: { id: true, code: true, currentKg: true } } },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      });
      if (openUsages.length > 0) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "shift_bag_usages"
            WHERE "id" IN (${Prisma.join(openUsages.map(({ id }) => id).sort())})
            ORDER BY "id" FOR UPDATE`,
        );
        openUsages = await tx.shiftBagUsage.findMany({
          where: { sessionId: session.id, closedAt: null },
          include: { bigBag: { select: { id: true, code: true, currentKg: true } } },
          orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
        });
      }

      if (change.status === 'ready' && openUsages.length > 0) {
        const awaiting = await tx.operatorMachineChange.update({
          where: { id: change.id },
          data: { status: 'awaiting_final_weight', readyAt: null },
        });
        await this.audit.record(
          {
            type: 'audit:operator_machine_change_requested',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: assignment.id,
            reason: change.reason,
            oldValue: { status: 'ready' },
            newValue: { status: 'awaiting_final_weight' },
            detail: {
              changeId: change.id,
              sessionId: session.id,
              cause: 'bigbag_opened_after_request',
            },
          },
          tx,
        );
        return {
          changeId: awaiting.id,
          status: 'awaiting_final_weight',
          remainingBigBags: this.projectPendingBigBags(openUsages),
          completedAt: null,
        };
      }

      if (change.status === 'awaiting_final_weight') {
        if (openUsages.length > 0) {
          if (!evidence || evidence.sessionId !== session.id) {
            throw new ConflictException('Финальный вес относится к другой сессии поста.');
          }
          const usage = openUsages.find(
            (candidate) =>
              candidate.id === evidence.usageId && candidate.bigBagId === evidence.bigBagId,
          );
          if (!usage) {
            return {
              changeId: change.id,
              status: 'awaiting_final_weight',
              remainingBigBags: this.projectPendingBigBags(openUsages),
              completedAt: null,
            };
          }
          const capturedAt = new Date();
          await tx.shiftBagUsage.update({
            where: { id: usage.id },
            data: { endKg: evidence.grossKg, closedAt: capturedAt },
          });
          await tx.bigBagUnit.update({
            where: { id: usage.bigBagId },
            data: {
              currentKg: evidence.grossKg,
              lastMeasuredKg: evidence.grossKg,
              lastActorRole: actor.role,
              lastMeasuredAt: capturedAt,
              status: evidence.grossKg > 1 ? 'available' : 'consumed',
            },
          });
          await this.audit.record(
            {
              type: 'audit:bigbag_weight_recorded',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: usage.bigBag.code,
              oldValue: { currentKg: usage.bigBag.currentKg },
              newValue: { currentKg: evidence.grossKg },
              reason: `Финальный вес перед сменой станка: ${change.reason}`,
              detail: {
                changeId: change.id,
                sessionId: session.id,
                bigBagId: usage.bigBagId,
                deviceId: evidence.deviceId,
                stable: true,
              },
            },
            tx,
          );
          await this.audit.record(
            {
              type: 'audit:operator_machine_change_final_weight_recorded',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: assignment.id,
              oldValue: { currentKg: usage.bigBag.currentKg },
              newValue: { currentKg: evidence.grossKg },
              reason: change.reason,
              detail: {
                changeId: change.id,
                sessionId: session.id,
                bigBagId: usage.bigBagId,
                deviceId: evidence.deviceId,
                stable: true,
              },
            },
            tx,
          );
          openUsages = openUsages.filter((candidate) => candidate.id !== usage.id);
          if (openUsages.length > 0) {
            return {
              changeId: change.id,
              status: 'awaiting_final_weight',
              remainingBigBags: this.projectPendingBigBags(openUsages),
              completedAt: null,
            };
          }
        }
        await tx.operatorMachineChange.update({
          where: { id: change.id },
          data: { status: 'ready', readyAt: new Date() },
        });
        await this.recordMachineChangeReady(tx, actor, change, assignment.id, session.id);
      }

      const dispatchRows = await tx.rollDispatchItem.findMany({
        where: {
          assignedOperatorId: change.operatorId,
          plannedShiftId: change.shiftId,
          status: { notIn: ['ready_for_warehouse', 'done'] },
        },
        select: { id: true, rollCode: true },
        orderBy: { id: 'asc' },
      });
      if (dispatchRows.length > 0) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
            WHERE "id" IN (${Prisma.join(dispatchRows.map(({ id }) => id))})
            ORDER BY "id" FOR UPDATE`,
        );
      }
      const now = new Date();
      const closed = await tx.operatorPostSession.updateMany({
        where: {
          id: session.id,
          operatorId: change.operatorId,
          postId: change.fromPostId,
          shiftId: change.shiftId,
          status: 'active',
        },
        data: { status: 'closed', endedAt: now },
      });
      if (closed.count !== 1) {
        throw new ConflictException('Сессия исходного поста изменилась во время переноса.');
      }
      const movedAssignment = await tx.operatorShiftMachineAssignment.updateMany({
        where: {
          id: assignment.id,
          operatorId: change.operatorId,
          shiftId: change.shiftId,
          postId: change.fromPostId,
          status: 'locked',
        },
        data: {
          previousPostId: change.fromPostId,
          postId: change.toPostId,
          reassignedAt: now,
        },
      });
      if (movedAssignment.count !== 1) {
        throw new ConflictException('Назначение оператора изменилось во время переноса.');
      }
      const movedRolls = await tx.rollDispatchItem.updateMany({
        where: {
          id: { in: dispatchRows.map(({ id }) => id) },
          assignedOperatorId: change.operatorId,
          plannedShiftId: change.shiftId,
          status: { notIn: ['ready_for_warehouse', 'done'] },
        },
        data: {
          postId: change.toPostId,
          workplaceId: change.toPostId,
          machineId: toPost.code,
        },
      });
      if (movedRolls.count !== dispatchRows.length) {
        throw new ConflictException('Очередь оператора изменилась во время переноса.');
      }
      const completed = await tx.operatorMachineChange.update({
        where: { id: change.id },
        data: { status: 'completed', completedAt: now },
      });
      await this.audit.record(
        {
          type: 'audit:operator_post_session_closed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: change.fromPostId,
          reason: change.reason,
          detail: {
            changeId: change.id,
            sessionId: session.id,
            shiftId: change.shiftId,
            source: 'intentional_machine_change',
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'audit:operator_machine_change_completed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: assignment.id,
          reason: change.reason,
          oldValue: { postId: change.fromPostId },
          newValue: { postId: change.toPostId },
          detail: {
            changeId: change.id,
            shiftId: change.shiftId,
            operatorId: change.operatorId,
            movedDispatchItemIds: dispatchRows.map(({ id }) => id),
            movedRollCodes: dispatchRows.map(({ rollCode }) => rollCode),
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'notification:operator_machine_change_completed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: assignment.id,
          reason: change.reason,
          detail: {
            changeId: change.id,
            shiftId: change.shiftId,
            operatorId: change.operatorId,
            fromPostId: change.fromPostId,
            toPostId: change.toPostId,
            recipientRoles: ['operator', 'production_lead', 'director'],
            recipientUserIds: [change.operatorId],
          },
        },
        tx,
      );
      return {
        changeId: completed.id,
        status: 'completed',
        remainingBigBags: [],
        completedAt: completed.completedAt?.toISOString() ?? now.toISOString(),
      };
    });
  }

  async cancelMachineChange(
    actor: { userId: string | null; role: Role },
    changeId: string,
    input: CancelMachineChangeInput,
  ): Promise<MachineChangeCancellationView> {
    if (!actor.userId) {
      throw machineChangeConflict(
        'MACHINE_CHANGE_CANCELLATION_ACTOR_REQUIRED',
        'Для отмены смены станка требуется пользовательская сессия.',
      );
    }
    const operationKey = input.operationKey.trim().toLowerCase();
    const reason = input.reason.trim();
    const fingerprint = requestFingerprint(
      machineChangeCancellationFingerprintInput(changeId, input),
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`machine-change-cancellation:${operationKey}`}, 0)
        )::text AS "lock"`,
      );
      const keyedReplay = await tx.operatorMachineChange.findUnique({
        where: { cancelOperationKey: operationKey },
      });
      if (keyedReplay) {
        return this.machineChangeCancellationReplay(
          keyedReplay,
          changeId,
          operationKey,
          fingerprint,
        );
      }

      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_machine_changes"
          WHERE "id" = ${changeId} FOR UPDATE`,
      );
      const change = await tx.operatorMachineChange.findUnique({ where: { id: changeId } });
      if (!change) throw new NotFoundException('Операция смены станка не найдена.');
      if (change.status === 'cancelled') {
        return this.machineChangeCancellationReplay(change, changeId, operationKey, fingerprint);
      }
      if (
        !['requested', 'awaiting_final_weight', 'ready'].includes(change.status) ||
        change.completedAt !== null
      ) {
        throw machineChangeConflict(
          'MACHINE_CHANGE_HAS_PHYSICAL_FACTS',
          'Смена станка уже завершена или содержит необратимые физические факты.',
        );
      }
      if (change.cancelOperationKey !== null) {
        throw machineChangeConflict(
          'MACHINE_CHANGE_CANCELLATION_CONFLICT',
          'Команда отмены уже изменилась. Обновите экран.',
        );
      }

      const session = await tx.operatorPostSession.findFirst({
        where: {
          operatorId: change.operatorId,
          shiftId: change.shiftId,
          postId: change.fromPostId,
        },
        select: { id: true },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      });
      if (session) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "operator_post_sessions"
            WHERE "id" = ${session.id} FOR UPDATE`,
        );
      }
      const physicalFact = await tx.domainEvent.findFirst({
        where: {
          createdAt: { gte: change.requestedAt },
          OR: [
            {
              type: 'audit:operator_machine_change_final_weight_recorded',
              detail: { path: ['changeId'], equals: change.id },
            },
            {
              type: { in: MACHINE_CHANGE_PHYSICAL_EVENT_TYPES },
              actorId: change.operatorId,
              detail: { path: ['postId'], equals: change.fromPostId },
            },
            ...(session
              ? [
                  {
                    type: { in: MACHINE_CHANGE_PHYSICAL_EVENT_TYPES },
                    detail: { path: ['sessionId'], equals: session.id },
                  },
                ]
              : []),
          ],
        },
        select: { id: true, type: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (physicalFact) {
        throw machineChangeConflict(
          'MACHINE_CHANGE_HAS_PHYSICAL_FACTS',
          'После запроса смены станка уже записан физический факт; используйте новую смену.',
        );
      }

      const cancelledAt = new Date();
      const cancelled = await tx.operatorMachineChange.updateMany({
        where: {
          id: changeId,
          status: { in: ['requested', 'awaiting_final_weight', 'ready'] },
          cancelOperationKey: null,
        },
        data: {
          status: 'cancelled',
          cancelledAt,
          cancelOperationKey: operationKey,
          cancelRequestFingerprint: fingerprint,
          cancellationReason: reason,
          cancelledById: actor.userId,
        },
      });
      if (cancelled.count !== 1) {
        throw machineChangeConflict(
          'MACHINE_CHANGE_CANCELLATION_CONFLICT',
          'Смена станка изменилась во время отмены. Обновите экран.',
        );
      }

      await this.audit.record(
        {
          type: 'audit:operator_machine_change_cancelled',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: change.assignmentId,
          oldValue: {
            changeId: change.id,
            status: change.status,
            fromPostId: change.fromPostId,
            toPostId: change.toPostId,
          },
          newValue: {
            changeId: change.id,
            status: 'cancelled',
            cancelledAt: cancelledAt.toISOString(),
            assignmentPostId: change.fromPostId,
          },
          reason,
          detail: {
            changeId: change.id,
            shiftId: change.shiftId,
            operatorId: change.operatorId,
            fromPostId: change.fromPostId,
            toPostId: change.toPostId,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'notification:operator_machine_change_cancelled',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: change.assignmentId,
          reason,
          detail: {
            changeId: change.id,
            shiftId: change.shiftId,
            operatorId: change.operatorId,
            fromPostId: change.fromPostId,
            toPostId: change.toPostId,
            recipientRoles: ['operator', 'production_lead'],
            recipientUserIds: [change.operatorId],
          },
        },
        tx,
      );
      return {
        changeId: change.id,
        status: 'cancelled',
        cancelledAt: cancelledAt.toISOString(),
        cancellationReason: reason,
      };
    });
  }

  async getCurrentMachineChange(actor: {
    userId: string | null;
  }): Promise<MachineChangeView | null> {
    if (!actor.userId) return null;
    const change = await this.prisma.operatorMachineChange.findFirst({
      where: {
        operatorId: actor.userId,
        shift: { status: { in: ['planned', 'open'] } },
      },
      include: MACHINE_CHANGE_RUNTIME_INCLUDE,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
    if (!change || change.status === 'cancelled') return null;
    let pendingBigBags: MachineChangePendingBigBag[] = [];
    if (['awaiting_final_weight', 'ready'].includes(change.status)) {
      const session = await this.prisma.operatorPostSession.findFirst({
        where: {
          operatorId: change.operatorId,
          shiftId: change.shiftId,
          postId: change.fromPostId,
          status: 'active',
        },
        select: { id: true },
      });
      if (session) {
        const usages = await this.prisma.shiftBagUsage.findMany({
          where: { sessionId: session.id, closedAt: null },
          select: { bigBag: { select: { id: true, code: true } } },
          orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
        });
        pendingBigBags = usages.map(({ bigBag }) => bigBag);
      }
    }
    return this.projectMachineChange(change, pendingBigBags);
  }

  private projectMachineChange(
    change: RuntimeMachineChange,
    pendingBigBags: MachineChangePendingBigBag[],
  ): MachineChangeView {
    return {
      id: change.id,
      assignmentId: change.assignmentId,
      shiftId: change.shiftId,
      operatorId: change.operatorId,
      fromPostId: change.fromPostId,
      toPostId: change.toPostId,
      fromPost: change.fromPost,
      toPost: change.toPost,
      needsFinalWeight: change.status === 'awaiting_final_weight' || pendingBigBags.length > 0,
      pendingBigBags,
      reason: change.reason,
      status: change.status as MachineChangeView['status'],
      operationKey: change.operationKey,
      requestedAt: change.requestedAt.toISOString(),
      readyAt: change.readyAt?.toISOString() ?? null,
      completedAt: change.completedAt?.toISOString() ?? null,
      cancelledAt: change.cancelledAt?.toISOString() ?? null,
      cancellationReason: change.cancellationReason,
      cancelledById: change.cancelledById,
      updatedAt: change.updatedAt.toISOString(),
    };
  }

  private machineChangeCancellationReplay(
    change: {
      id: string;
      status: string;
      cancelOperationKey: string | null;
      cancelRequestFingerprint: string | null;
      cancelledAt: Date | null;
      cancellationReason: string | null;
    },
    expectedChangeId: string,
    operationKey: string,
    fingerprint: string,
  ): MachineChangeCancellationView {
    if (
      change.id !== expectedChangeId ||
      change.cancelOperationKey !== operationKey ||
      change.cancelRequestFingerprint !== fingerprint
    ) {
      if (
        change.id === expectedChangeId &&
        change.status === 'cancelled' &&
        change.cancelOperationKey !== operationKey
      ) {
        throw machineChangeConflict(
          'MACHINE_CHANGE_ALREADY_CANCELLED',
          'Смена станка уже отменена другой командой.',
        );
      }
      throw machineChangeConflict(
        'MACHINE_CHANGE_CANCELLATION_OPERATION_KEY_CONFLICT',
        'operationKey уже связан с другой отменой смены станка.',
      );
    }
    if (
      change.status !== 'cancelled' ||
      change.cancelledAt === null ||
      change.cancellationReason === null
    ) {
      throw machineChangeConflict(
        'MACHINE_CHANGE_CANCELLATION_REPLAY_INVALID',
        'Сохранённый результат отмены смены станка повреждён.',
      );
    }
    return {
      changeId: change.id,
      status: 'cancelled',
      cancelledAt: change.cancelledAt.toISOString(),
      cancellationReason: change.cancellationReason,
    };
  }

  private async prepareFinalBagCapture(
    snapshot: {
      id: string;
      operatorId: string;
      shiftId: string;
      fromPostId: string;
    },
    requestedBigBagId?: string,
  ): Promise<PreparedBagCapture | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_machine_changes"
          WHERE "id" = ${snapshot.id} FOR UPDATE`,
      );
      const change = await tx.operatorMachineChange.findUnique({ where: { id: snapshot.id } });
      if (!change || change.operatorId !== snapshot.operatorId) {
        throw new ConflictException('Операция смены станка изменилась; обновите экран.');
      }
      if (change.status === 'completed') return null;
      if (change.status !== 'awaiting_final_weight') {
        throw new ConflictException('Финальный вес Big-Bag больше не требуется.');
      }
      const session = await tx.operatorPostSession.findFirst({
        where: {
          operatorId: change.operatorId,
          shiftId: change.shiftId,
          postId: change.fromPostId,
          status: 'active',
        },
        select: { id: true },
      });
      if (!session) {
        throw new ConflictException('Активная сессия исходного поста не найдена.');
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_post_sessions"
          WHERE "id" = ${session.id} FOR UPDATE`,
      );
      let usages = await tx.shiftBagUsage.findMany({
        where: { sessionId: session.id, closedAt: null },
        select: { id: true, bigBagId: true, bigBag: { select: { code: true } } },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      });
      if (usages.length === 0) return null;
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "shift_bag_usages"
          WHERE "id" IN (${Prisma.join(usages.map(({ id }) => id).sort())})
          ORDER BY "id" FOR UPDATE`,
      );
      usages = await tx.shiftBagUsage.findMany({
        where: { sessionId: session.id, closedAt: null },
        select: { id: true, bigBagId: true, bigBag: { select: { code: true } } },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      });
      if (usages.length === 0) return null;
      if (!requestedBigBagId && usages.length > 1) {
        throw new BadRequestException({
          code: 'OPERATOR_MACHINE_CHANGE_BIGBAG_REQUIRED',
          message: 'Укажите Big-Bag, который сейчас установлен на весы.',
          pendingBigBags: usages.map(({ bigBagId, bigBag }) => ({
            id: bigBagId,
            code: bigBag.code,
          })),
        });
      }
      const usage = requestedBigBagId
        ? usages.find(({ bigBagId }) => bigBagId === requestedBigBagId)
        : usages[0];
      if (!usage) {
        throw new ConflictException('Выбранный Big-Bag уже закрыт или относится к другой сессии.');
      }
      return {
        sessionId: session.id,
        usageId: usage.id,
        bigBagId: usage.bigBagId,
      };
    });
  }

  private async readFinalBagWeight(
    change: {
      fromPostId: string;
    },
    prepared: PreparedBagCapture,
  ) {
    if (!this.scale) {
      throw new ServiceUnavailableException('Адаптер весов недоступен.');
    }
    const devices = await this.prisma.deviceRuntime.findMany({
      where: {
        postId: change.fromPostId,
        kind: 'scale',
        isEnabled: true,
      },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    if (devices.length !== 1 || devices[0].status !== 'ready') {
      throw new ServiceUnavailableException('Весы исходного поста не готовы.');
    }
    const reading = await this.scale.read(
      {
        deviceId: devices[0].id,
        expectedPostId: change.fromPostId,
        expectedKind: 'scale',
      },
      'control',
    );
    if (
      reading.status !== 'ready' ||
      !reading.stable ||
      !Number.isFinite(reading.grossKg) ||
      reading.grossKg < 0
    ) {
      throw new ConflictException('Нужен стабильный финальный вес Big-Bag.');
    }
    return {
      ...prepared,
      deviceId: reading.deviceId,
      grossKg: reading.grossKg,
    };
  }

  private projectPendingBigBags(
    usages: Array<{ bigBag: { id: string; code: string } }>,
  ): MachineChangePendingBigBag[] {
    return usages.map(({ bigBag }) => ({ id: bigBag.id, code: bigBag.code }));
  }

  private async recordMachineChangeReady(
    tx: Prisma.TransactionClient,
    actor: { userId: string | null; role: Role },
    change: {
      id: string;
      operatorId: string;
      reason: string;
    },
    assignmentId: string,
    sessionId: string,
  ): Promise<void> {
    await this.audit.record(
      {
        type: 'audit:operator_machine_change_ready',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: assignmentId,
        reason: change.reason,
        detail: { changeId: change.id, sessionId },
      },
      tx,
    );
    await this.audit.record(
      {
        type: 'notification:operator_machine_change_ready',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: assignmentId,
        reason: change.reason,
        detail: {
          changeId: change.id,
          operatorId: change.operatorId,
          recipientRoles: ['operator', 'production_lead', 'director'],
          recipientUserIds: [change.operatorId],
        },
      },
      tx,
    );
  }

  private async findShiftReplay(
    operationKey: string,
    requestFingerprint: string,
    client: Pick<Prisma.TransactionClient, 'shift'> = this.prisma,
  ) {
    const existing = await client.shift.findUnique({
      where: { operationKey },
      select: { requestFingerprint: true, commandResult: true },
    });
    if (!existing) return null;
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new ConflictException('operationKey уже использован для другой команды.');
    }
    return this.readStoredShiftResult(existing.commandResult);
  }

  private readStoredShiftResult(value: Prisma.JsonValue | null): IndividualShiftCommandResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConflictException('Сохранённый результат команды смены повреждён.');
    }
    const result = value as Prisma.JsonObject;
    if (
      !result.shift ||
      typeof result.shift !== 'object' ||
      Array.isArray(result.shift) ||
      !result.assignment ||
      typeof result.assignment !== 'object' ||
      Array.isArray(result.assignment) ||
      !Array.isArray(result.dispatchItemIds) ||
      result.dispatchItemIds.some((id) => typeof id !== 'string')
    ) {
      throw new ConflictException('Сохранённый результат команды смены повреждён.');
    }
    return result as unknown as IndividualShiftCommandResult;
  }

  private async findMachineChangeReplay(
    operationKey: string,
    expected: { assignmentId: string; toPostId: string; reason: string },
  ) {
    const existing = await this.prisma.operatorMachineChange.findUnique({
      where: { operationKey },
    });
    if (!existing) return null;
    if (
      existing.assignmentId !== expected.assignmentId ||
      existing.toPostId !== expected.toPostId ||
      existing.reason !== expected.reason
    ) {
      throw new ConflictException('operationKey уже использован для другой смены станка.');
    }
    return existing;
  }
}
