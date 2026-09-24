import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Role } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import { hasIrreversiblePhysicalFacts } from '../../common/production/roll-reversibility';
import type { AssignmentCancellationDto } from './dto/assignment-cancellation.dto';

type AssignmentCancellationActor = { userId: string | null; role: Role };

export type AssignmentCancellationResult = {
  commandId: string;
  assignmentId: string;
  shiftId: string;
  status: 'cancelled';
  releasedDispatchItemIds: string[];
  shiftClosed: false;
};

const CANCELLATION_DISPATCH_SELECT = {
  id: true,
  status: true,
  assignedOperatorId: true,
  plannedShiftId: true,
  postId: true,
  completedAt: true,
  coverageFact: { select: { id: true } },
  operatorLine: {
    select: {
      spoolKg: true,
      grossKg: true,
      netKg: true,
      warehouseState: true,
      weightCaptures: { select: { id: true } },
      labelJobs: { select: { id: true } },
      operations: { select: { id: true } },
    },
  },
} satisfies Prisma.RollDispatchItemSelect;

type CancellationDispatchItem = Prisma.RollDispatchItemGetPayload<{
  select: typeof CANCELLATION_DISPATCH_SELECT;
}>;

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function compareOpaqueIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function physicalFacts(row: CancellationDispatchItem) {
  return {
    status: row.status,
    completedAt: row.completedAt,
    coverageFactId: row.coverageFact?.id ?? null,
    operatorLine: row.operatorLine,
  };
}

function resultFromJson(value: Prisma.JsonValue | null): AssignmentCancellationResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.commandId !== 'string' ||
    typeof candidate.assignmentId !== 'string' ||
    typeof candidate.shiftId !== 'string' ||
    candidate.status !== 'cancelled' ||
    !Array.isArray(candidate.releasedDispatchItemIds) ||
    candidate.releasedDispatchItemIds.some((id) => typeof id !== 'string') ||
    candidate.shiftClosed !== false
  ) {
    throw conflict(
      'MACHINE_ASSIGNMENT_CANCELLATION_REPLAY_INVALID',
      'Сохранённый результат отмены назначения повреждён.',
    );
  }
  return {
    commandId: candidate.commandId,
    assignmentId: candidate.assignmentId,
    shiftId: candidate.shiftId,
    status: 'cancelled',
    releasedDispatchItemIds: candidate.releasedDispatchItemIds as string[],
    shiftClosed: false,
  };
}

export function assignmentCancellationFingerprintInput(
  shiftId: string,
  assignmentId: string,
  dto: AssignmentCancellationDto,
) {
  return {
    shiftId,
    assignmentId,
    operationKey: dto.operationKey.trim().toLowerCase(),
    reason: dto.reason.trim(),
  };
}

@Injectable()
export class ProductionAssignmentCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  cancel(
    actor: AssignmentCancellationActor,
    shiftId: string,
    assignmentId: string,
    dto: AssignmentCancellationDto,
  ): Promise<AssignmentCancellationResult> {
    const operationKey = dto.operationKey.trim().toLowerCase();
    const reason = dto.reason.trim();
    const fingerprint = requestFingerprint(
      assignmentCancellationFingerprintInput(shiftId, assignmentId, dto),
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`machine-assignment-cancellation:${operationKey}`}, 0)
        )::text AS "lock"`,
      );
      const replayCommand =
        await tx.operatorShiftMachineAssignmentCancellationCommand.findUnique({
          where: { operationKey },
        });
      if (replayCommand) {
        if (
          replayCommand.assignmentId !== assignmentId ||
          replayCommand.requestFingerprint !== fingerprint
        ) {
          throw conflict(
            'MACHINE_ASSIGNMENT_CANCELLATION_OPERATION_KEY_CONFLICT',
            'operationKey уже связан с другой отменой назначения.',
          );
        }
        const replay = resultFromJson(replayCommand.result);
        if (replay) return replay;
        throw conflict(
          'MACHINE_ASSIGNMENT_CANCELLATION_IN_PROGRESS',
          'Отмена назначения уже выполняется. Обновите смену.',
        );
      }

      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${shiftId} FOR UPDATE`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments"
                   WHERE "id" = ${assignmentId} FOR UPDATE`,
      );
      const assignment = await tx.operatorShiftMachineAssignment.findUnique({
        where: { id: assignmentId },
        include: { shift: { select: { id: true, status: true } } },
      });
      if (!assignment || assignment.shiftId !== shiftId) {
        throw new NotFoundException(`Assignment ${assignmentId} not found in shift ${shiftId}`);
      }
      if (
        assignment.shift.status !== 'planned' ||
        assignment.status !== 'planned' ||
        assignment.lockedAt !== null
      ) {
        throw conflict(
          'MACHINE_ASSIGNMENT_ALREADY_STARTED',
          'Отменить назначение можно только до начала плановой смены.',
        );
      }

      const session = await tx.operatorPostSession.findFirst({
        where: {
          shiftId,
          operatorId: assignment.operatorId,
          postId: assignment.postId,
        },
        select: { id: true, status: true },
      });
      if (session) {
        throw conflict(
          'MACHINE_ASSIGNMENT_ALREADY_STARTED',
          'По назначению уже существует сессия оператора; физические факты сохраняются.',
        );
      }

      const dispatchWhere = {
        plannedShiftId: shiftId,
        assignedOperatorId: assignment.operatorId,
        postId: assignment.postId,
      } satisfies Prisma.RollDispatchItemWhereInput;
      const initialDispatchItems = await tx.rollDispatchItem.findMany({
        where: dispatchWhere,
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const dispatchIds = initialDispatchItems
        .map(({ id }) => id)
        .sort(compareOpaqueIds);
      if (dispatchIds.length > 0) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
                     WHERE "id" IN (${Prisma.join(dispatchIds)})
                     ORDER BY "id" COLLATE "C" FOR UPDATE`,
        );
        if (
          locked.length !== dispatchIds.length ||
          locked.some((row, index) => row.id !== dispatchIds[index])
        ) {
          throw conflict(
            'MACHINE_ASSIGNMENT_DISPATCH_SET_CONFLICT',
            'Набор заданий назначения изменился. Обновите смену.',
          );
        }
      }
      const dispatchItems = await tx.rollDispatchItem.findMany({
        where: dispatchWhere,
        select: CANCELLATION_DISPATCH_SELECT,
        orderBy: { id: 'asc' },
      });
      if (
        dispatchItems.length !== dispatchIds.length ||
        dispatchItems.some((row, index) => row.id !== dispatchIds[index])
      ) {
        throw conflict(
          'MACHINE_ASSIGNMENT_DISPATCH_SET_CONFLICT',
          'Набор заданий назначения изменился. Обновите смену.',
        );
      }
      if (dispatchItems.some((row) => hasIrreversiblePhysicalFacts(physicalFacts(row)))) {
        throw conflict(
          'MACHINE_ASSIGNMENT_HAS_PHYSICAL_FACTS',
          'Назначение уже содержит физические факты и не может быть отменено.',
        );
      }

      const claimed =
        await tx.operatorShiftMachineAssignmentCancellationCommand.createMany({
          data: [
            {
              assignmentId,
              operationKey,
              requestFingerprint: fingerprint,
              reason,
              actorRole: actor.role,
              actorId: actor.userId,
            },
          ],
          skipDuplicates: true,
        });
      const command = await tx.operatorShiftMachineAssignmentCancellationCommand.findUnique({
        where: { operationKey },
      });
      if (
        claimed.count !== 1 ||
        !command ||
        command.assignmentId !== assignmentId ||
        command.requestFingerprint !== fingerprint
      ) {
        throw conflict(
          'MACHINE_ASSIGNMENT_CANCELLATION_CONFLICT',
          'Назначение уже отменяется другой командой. Обновите смену.',
        );
      }

      for (const row of dispatchItems) {
        const released = await tx.rollDispatchItem.updateMany({
          where: {
            id: row.id,
            status: row.status,
            assignedOperatorId: assignment.operatorId,
            plannedShiftId: shiftId,
            postId: assignment.postId,
          },
          data: {
            assignedOperatorId: null,
            postId: null,
            machineId: null,
            workplaceId: null,
            plannedShiftId: null,
            status: 'new',
          },
        });
        if (released.count !== 1) {
          throw conflict(
            'MACHINE_ASSIGNMENT_DISPATCH_SET_CONFLICT',
            'Задание назначения изменилось. Обновите смену.',
          );
        }
      }

      const cancelledAt = new Date();
      const cancelled = await tx.operatorShiftMachineAssignment.updateMany({
        where: {
          id: assignmentId,
          shiftId,
          status: 'planned',
          lockedAt: null,
        },
        data: {
          status: 'cancelled',
          cancelledAt,
          cancellationReason: reason,
        },
      });
      if (cancelled.count !== 1) {
        throw conflict(
          'MACHINE_ASSIGNMENT_ALREADY_STARTED',
          'Назначение изменилось или смена уже началась. Обновите смену.',
        );
      }

      const result: AssignmentCancellationResult = {
        commandId: command.id,
        assignmentId,
        shiftId,
        status: 'cancelled',
        releasedDispatchItemIds: dispatchIds,
        shiftClosed: false,
      };
      await tx.operatorShiftMachineAssignmentCancellationCommand.update({
        where: { id: command.id },
        data: { result: result as unknown as Prisma.InputJsonValue },
      });
      await this.audit.record(
        {
          type: 'audit:operator_shift_machine_assignment_cancelled',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: assignmentId,
          oldValue: {
            shiftId,
            operatorId: assignment.operatorId,
            postId: assignment.postId,
            status: assignment.status,
            dispatchItemIds: dispatchIds,
          },
          newValue: {
            shiftId,
            status: 'cancelled',
            cancelledAt: cancelledAt.toISOString(),
            releasedDispatchItemIds: dispatchIds,
            shiftClosed: false,
          },
          reason,
        },
        tx,
      );
      return result;
    });
  }
}
