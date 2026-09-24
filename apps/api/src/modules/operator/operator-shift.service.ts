import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  OperatorBigBagView,
  OperatorShiftBalance,
  OperatorShiftBagReleaseResult,
  OperatorShiftCloseResult,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { resolveCanonicalRollCaptures } from '../../common/weight-capture/canonical-roll-capture';
import { OperatorSessionService } from './operator-session.service';
import { OperatorPayrollService } from './operator-payroll.service';
import type { OperatorActor } from './operator.service';
import type {
  AddShiftBagDto,
  CloseShiftDto,
  OpenShiftDto,
  ReleaseShiftBagDto,
} from './dto/shift.dto';
import {
  calculateActualEpisodeUsageKg,
  resolveCanonicalShiftBagUsageFacts,
  type ShiftBagEpisodeFact,
} from './shift-bag-episode-balance';

export type CloseShiftResult = OperatorShiftCloseResult;

/** Bag is «consumed» below this residue; above it returns to the warehouse pool. */
const CONSUMED_THRESHOLD_KG = 1;
const DEFERRED_STARTED_STEPS = new Set<string>([
  'spool_weight',
  'roll_weight',
  'qr_print',
  'qr_check',
  'handover',
]);

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function shiftLifecycleConflict(message: string): ConflictException {
  return new ConflictException({ code: 'OPERATOR_SHIFT_LIFECYCLE_CONFLICT', message });
}

function shiftCloseConflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function releaseFingerprintInput(
  actor: OperatorActor & { userId: string },
  bigBagId: string,
  endKg: number,
) {
  return {
    command: 'operator_shift_bag_release',
    operatorId: actor.userId,
    actorRole: actor.role,
    bigBagId,
    endKg,
  };
}

function parseReleaseResult(value: Prisma.JsonValue): OperatorShiftBagReleaseResult | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const result = value as Record<string, Prisma.JsonValue>;
  if (
    Object.keys(result).sort().join(',') !== 'active,bagId,code,endKg,releasedAt,startKg,status' ||
    typeof result.bagId !== 'string' ||
    typeof result.code !== 'string' ||
    typeof result.startKg !== 'number' ||
    !Number.isFinite(result.startKg) ||
    typeof result.endKg !== 'number' ||
    !Number.isFinite(result.endKg) ||
    result.active !== false ||
    typeof result.releasedAt !== 'string' ||
    Number.isNaN(Date.parse(result.releasedAt)) ||
    new Date(result.releasedAt).toISOString() !== result.releasedAt ||
    (result.status !== 'available' && result.status !== 'consumed')
  ) {
    return null;
  }
  return result as OperatorShiftBagReleaseResult;
}

export function operatorShiftCloseFingerprintInput(actor: OperatorActor, dto: CloseShiftDto) {
  return {
    operatorId: actor.userId,
    actorRole: actor.role,
    bags: [...(dto.bags ?? [])]
      .map(({ bigBagId, endKg }) => ({ bigBagId, endKg }))
      .sort(
        (left, right) => left.bigBagId.localeCompare(right.bigBagId) || left.endKg - right.endKg,
      ),
  };
}

/** Raw material is accounted one-to-one with the canonical stable net capture per roll. */
export const ONE_TO_ONE_MATERIAL_USAGE_RATIO = 1;

export function balanceTolerance(): number {
  const parsed = Number(process.env.OPERATOR_BALANCE_TOLERANCE ?? 0.02);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.02;
}

/**
 * Operator shift with big bags (design 2026-07-13 §6–7): the shift cannot start
 * without a weighed bag; closing requires the final weight of every still-open usage and runs
 * the raw-material balance anti-fraud check. Weights are the explicit manual exception
 * (ТЗ §9) — every entry is audited.
 */
@Injectable()
export class OperatorShiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: OperatorSessionService,
    private readonly payroll: OperatorPayrollService,
  ) {}

  /** Bags the operator may pick at shift open: warehouse pool + bags already in work. */
  async listBigBags(): Promise<OperatorBigBagView[]> {
    const bags = await this.prisma.bigBagUnit.findMany({
      where: {
        status: { in: ['available', 'in_use'] },
        registrationStatus: 'registered',
        location: 'production',
      },
      orderBy: { code: 'asc' },
    });
    return bags.map((bag) => ({
      id: bag.id,
      code: bag.code,
      material: bag.material,
      materialId: bag.materialId ?? null,
      warehouseKg: bag.initialKg ?? null,
      currentKg: bag.currentKg ?? null,
      status: bag.status as OperatorBigBagView['status'],
    }));
  }

  /**
   * «Открыть смену»: post session (S3 assignment checks) + first bag with its start
   * weight, atomically. The session may pre-exist (opened bagless) — then this only
   * registers the bag; an exact retry returns the already committed first bag.
   */
  async open(actor: OperatorActor, dto: OpenShiftDto) {
    this.requirePositiveWeight(dto.startKg);
    const postCode = dto.postCode ?? (await this.resolveAssignedPostCode(actor));
    return this.prisma.$transaction(async (tx) => {
      const session = await this.sessions.openInTransaction(tx, actor, postCode);
      const existingBags = await tx.shiftBagUsage.count({ where: { sessionId: session.id } });
      if (existingBags > 0) {
        const existingUsage = await tx.shiftBagUsage.findUnique({
          where: {
            sessionId_bigBagId: {
              sessionId: session.id,
              bigBagId: dto.bigBagId,
            },
          },
        });
        if (
          existingBags === 1 &&
          existingUsage?.sequence === 1 &&
          existingUsage.startKg === dto.startKg &&
          existingUsage.endKg === null &&
          existingUsage.closedAt === null
        ) {
          return { session, usage: existingUsage };
        }
        throw new ConflictException('Смена уже открыта — добавьте мешок отдельным действием.');
      }
      const usage = await this.registerBag(tx, actor, session.id, {
        bigBagId: dto.bigBagId,
        startKg: dto.startKg,
        sequence: 1,
        addedReason: null,
      });
      await this.audit.record(
        {
          type: 'audit:operator_shift_opened',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: session.id,
          detail: {
            sessionId: session.id,
            postId: session.postId,
            bigBagId: dto.bigBagId,
            startKg: usage.startKg,
          },
        },
        tx,
      );
      return { session, usage };
    });
  }

  /** Add one more available bag to an active shift. */
  async addBag(actor: OperatorActor, dto: AddShiftBagDto) {
    this.requirePositiveWeight(dto.startKg);
    const addedReason = dto.reason?.replace(/\s+/gu, ' ').trim() || null;
    return this.prisma.$transaction(async (tx) => {
      const session = await this.sessions.lockActiveInTransaction(tx, actor.userId);
      const currentUsage = await tx.shiftBagUsage.findUnique({
        where: {
          sessionId_bigBagId: {
            sessionId: session.id,
            bigBagId: dto.bigBagId,
          },
        },
      });
      if (currentUsage && currentUsage.closedAt == null) {
        if (currentUsage.startKg !== dto.startKg) {
          throw shiftLifecycleConflict(
            'Big-Bag уже активен в этой смене с другим стартовым весом. Обновите экран.',
          );
        }
        return currentUsage;
      }
      const sequence = (await tx.shiftBagUsage.count({ where: { sessionId: session.id } })) + 1;
      if (sequence === 1) {
        throw new ConflictException('Смена ещё не открыта — сначала откройте смену с мешком.');
      }
      const usage = await this.registerBag(tx, actor, session.id, {
        bigBagId: dto.bigBagId,
        startKg: dto.startKg,
        sequence,
        addedReason,
      });
      await this.audit.record(
        {
          type: 'audit:operator_shift_bag_added',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: session.id,
          ...(addedReason ? { reason: addedReason } : {}),
          detail: {
            sessionId: session.id,
            bigBagId: dto.bigBagId,
            startKg: usage.startKg,
            sequence,
          },
        },
        tx,
      );
      return usage;
    });
  }

  /**
   * Records the operator's final control weight for one Big-Bag and releases it while
   * leaving the post session and production shift active. The warehouse accepts it in
   * a separate scan/weight fact later; no historical operator weight is overwritten.
   */
  async releaseBag(
    actor: OperatorActor,
    bigBagId: string,
    dto: ReleaseShiftBagDto,
  ): Promise<OperatorShiftBagReleaseResult> {
    this.requirePositiveOrZeroWeight(dto.endKg);
    if (!actor.userId) {
      throw shiftLifecycleConflict('Для сдачи Big-Bag требуется полная сессия оператора.');
    }

    const identifiedActor = { ...actor, userId: actor.userId };
    const operationKey = dto.operationKey.trim().toLowerCase();
    const fingerprint = requestFingerprint(
      releaseFingerprintInput(identifiedActor, bigBagId, dto.endKg),
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`operator-bigbag-release:${operationKey}`}, 0)
        )::text AS "lock"`,
      );
      const replay = await tx.bigBagMovement.findUnique({
        where: { operationKey },
        select: {
          requestFingerprint: true,
          kind: true,
          bigBagId: true,
          actorId: true,
          actorRole: true,
          resultSnapshot: true,
        },
      });
      if (replay) {
        const result = parseReleaseResult(replay.resultSnapshot);
        if (
          replay.kind !== 'operator_shift_release' ||
          replay.requestFingerprint !== fingerprint ||
          replay.bigBagId !== bigBagId ||
          replay.actorId !== identifiedActor.userId ||
          replay.actorRole !== identifiedActor.role ||
          !result
        ) {
          throw shiftLifecycleConflict(
            'Ключ сдачи Big-Bag уже использован для другой операции. Обновите экран.',
          );
        }
        return result;
      }

      const session = await this.sessions.lockActiveInTransaction(tx, actor.userId);
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "shift_bag_usages"
          WHERE "sessionId" = ${session.id}
            AND "bigBagId" = ${bigBagId}
          FOR UPDATE`,
      );
      const usage = await tx.shiftBagUsage.findFirst({
        where: {
          sessionId: session.id,
          bigBagId,
          closedAt: null,
        },
        include: { bigBag: true },
      });
      if (!usage) {
        throw shiftLifecycleConflict(
          'Big-Bag не используется текущей сменой или уже был освобождён.',
        );
      }
      if (dto.endKg > usage.startKg) {
        throw new BadRequestException(
          'Финальный вес Big-Bag не может превышать его стартовый вес в этой смене.',
        );
      }

      const now = new Date();
      const released = await tx.shiftBagUsage.updateMany({
        where: { id: usage.id, closedAt: null },
        data: {
          endKg: dto.endKg,
          releasedReason: null,
          closedAt: now,
        },
      });
      if (released.count !== 1) {
        throw shiftLifecycleConflict('Big-Bag уже был освобождён.');
      }
      await this.closeEpisode(tx, usage.id, usage.startKg, dto.endKg, now, 'released');

      const status = dto.endKg > CONSUMED_THRESHOLD_KG ? 'available' : 'consumed';
      const updatedBag = await tx.bigBagUnit.updateMany({
        where: {
          id: bigBagId,
          status: 'in_use',
          registrationStatus: 'registered',
          location: 'production',
        },
        data: {
          currentKg: dto.endKg,
          lastMeasuredKg: dto.endKg,
          lastActorRole: actor.role,
          lastMeasuredAt: now,
          status,
        },
      });
      if (updatedBag.count !== 1) {
        throw shiftLifecycleConflict('Состояние или местоположение Big-Bag изменилось.');
      }

      const result: OperatorShiftBagReleaseResult = {
        bagId: bigBagId,
        code: usage.bigBag.code,
        startKg: usage.startKg,
        endKg: dto.endKg,
        active: false,
        releasedAt: now.toISOString(),
        status,
      };
      await tx.bigBagMovement.create({
        data: {
          bigBagId,
          operationKey,
          requestFingerprint: fingerprint,
          kind: 'operator_shift_release',
          fromLocation: 'production',
          toLocation: 'production',
          locationRevision: usage.bigBag.locationRevision,
          operatorReportedKg: dto.endKg,
          warehouseMeasuredKg: null,
          differenceKg: null,
          differencePercent: null,
          actorId: identifiedActor.userId,
          actorRole: identifiedActor.role,
          resultSnapshot: result,
        },
      });

      await this.audit.record(
        {
          type: 'audit:bigbag_weight_recorded',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: usage.bigBag.code,
          oldValue: { currentKg: usage.bigBag.currentKg },
          newValue: { currentKg: dto.endKg },
          detail: { sessionId: session.id, usageId: usage.id },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'audit:operator_shift_bag_released',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: usage.bigBag.code,
          detail: {
            sessionId: session.id,
            usageId: usage.id,
            bigBagId,
            startKg: usage.startKg,
            endKg: dto.endKg,
            status,
          },
        },
        tx,
      );

      return result;
    });
  }

  /**
   * «Сдать смену»: final weight for every still-open bag, then the balance check —
   * actual granule consumption vs what the produced rolls (+ recorded defects)
   * explain. Beyond tolerance → problem for the production lead; the shift still
   * closes (facts are recorded, the dispute is routed, ТЗ §3).
   */
  async close(actor: OperatorActor, dto: CloseShiftDto): Promise<CloseShiftResult> {
    if (!actor.userId) {
      throw shiftLifecycleConflict('Для сдачи смены требуется полная сессия оператора.');
    }
    const operatorId = actor.userId;
    const operationKey = dto.operationKey.trim().toLowerCase();
    const fingerprint = requestFingerprint(operatorShiftCloseFingerprintInput(actor, dto));
    const provided = new Map<string, number>();
    for (const entry of dto.bags ?? []) {
      this.requirePositiveOrZeroWeight(entry.endKg);
      if (provided.has(entry.bigBagId)) {
        throw new BadRequestException(`Big-Bag ${entry.bigBagId} указан более одного раза.`);
      }
      provided.set(entry.bigBagId, entry.endKg);
    }
    // Атомарное закрытие (codex-ревью #8): claim сессии, веса мешков, события,
    // mismatch-проблема и закрытие сессии — одной транзакцией. Падение любого шага
    // откатывает всё; параллельное закрытие получает 409, а не дубли событий.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`operator-shift-close:${operationKey}`}, 0)
        )::text AS "lock"`,
      );
      const replay = await tx.operatorShiftCloseCommand.findUnique({
        where: { operationKey },
        select: {
          requestFingerprint: true,
          operatorId: true,
          sessionId: true,
          shiftId: true,
          postId: true,
          assignmentId: true,
          actorRole: true,
          resultSnapshot: true,
          session: {
            select: {
              operatorId: true,
              shiftId: true,
              postId: true,
              status: true,
              endedAt: true,
            },
          },
          assignment: {
            select: {
              operatorId: true,
              shiftId: true,
              postId: true,
              status: true,
            },
          },
        },
      });
      if (replay) {
        if (
          replay.requestFingerprint !== fingerprint ||
          replay.operatorId !== operatorId ||
          replay.actorRole !== actor.role
        ) {
          throw shiftCloseConflict(
            'OPERATOR_SHIFT_CLOSE_OPERATION_KEY_CONFLICT',
            'operationKey уже связан с другой сдачей смены.',
          );
        }
        if (
          replay.session.operatorId !== replay.operatorId ||
          replay.session.shiftId !== replay.shiftId ||
          replay.session.postId !== replay.postId ||
          replay.session.status !== 'closed' ||
          !(replay.session.endedAt instanceof Date) ||
          !Number.isFinite(replay.session.endedAt.getTime()) ||
          replay.assignment.operatorId !== replay.operatorId ||
          replay.assignment.shiftId !== replay.shiftId ||
          replay.assignment.postId !== replay.postId ||
          replay.assignment.status !== 'completed'
        ) {
          throw shiftCloseConflict(
            'OPERATOR_SHIFT_CLOSE_REPLAY_INVALID',
            'Связи сохранённой сдачи смены повреждены.',
          );
        }
        return this.payroll.parseClosingResult(tx, replay.resultSnapshot, {
          sessionId: replay.sessionId,
          shiftId: replay.shiftId,
          postId: replay.postId,
        });
      }

      const activeSnapshot = await tx.operatorPostSession.findFirst({
        where: { operatorId, status: 'active' },
      });
      if (!activeSnapshot) {
        return this.closeLegacySession(tx, actor, operatorId, operationKey, fingerprint, provided);
      }
      const { session, assignment } = await this.lockCloseContext(tx, actor, activeSnapshot);
      const defectBags = await this.lockReadyDefectBags(tx, session.id);
      const defectBagFacts = defectBags.map(({ id, code, defectType, weightKg, status }) => ({
        id,
        code,
        defectType,
        weightKg,
        status,
      }));
      const mismatchOrderAnchor = await tx.rollDispatchItem.findFirst({
        where: {
          assignedOperatorId: operatorId,
          plannedShiftId: session.shiftId!,
          postId: session.postId,
          cancelledAt: null,
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: { productionOrder: { select: { commercialOrderId: true } } },
      });
      const mismatchOrderId = mismatchOrderAnchor?.productionOrder.commercialOrderId ?? null;
      const releasedRollIds = await this.prepareRollsForShiftClose(tx, actor, session);
      const usages = await tx.shiftBagUsage.findMany({
        where: { sessionId: session.id },
        include: {
          bigBag: true,
          episodes: { orderBy: { sequence: 'asc' } },
        },
        orderBy: { sequence: 'asc' },
      });
      if (usages.length === 0) {
        throw new ConflictException('Смена без мешков — открывать и сдавать нечего.');
      }
      const openUsages = usages.filter((usage) => usage.closedAt == null);
      const missing = openUsages.filter((usage) => !provided.has(usage.bigBagId));
      if (missing.length > 0) {
        throw new BadRequestException(
          `Не взвешены мешки: ${missing.map((usage) => usage.bigBag.code).join(', ')}. ` +
            'Для сдачи смены нужен финальный вес каждого активного мешка.',
        );
      }
      const openBagIds = new Set(openUsages.map(({ bigBagId }) => bigBagId));
      const unexpected = [...provided.keys()].filter((bigBagId) => !openBagIds.has(bigBagId));
      if (unexpected.length > 0) {
        throw new BadRequestException(
          `Лишние финальные веса Big-Bag: ${unexpected.sort().join(', ')}.`,
        );
      }

      const finalWeights = new Map<string, number>();
      for (const usage of usages) {
        const endKg = usage.closedAt == null ? provided.get(usage.bigBagId) : usage.endKg;
        if (endKg == null) {
          throw shiftLifecycleConflict(
            `У ранее освобождённого Big-Bag ${usage.bigBag.code} отсутствует финальный вес.`,
          );
        }
        if (usage.closedAt == null && endKg > usage.startKg) {
          throw new BadRequestException(
            `Финальный вес Big-Bag ${usage.bigBag.code} не может превышать стартовый вес.`,
          );
        }
        finalWeights.set(usage.bigBagId, endKg);
      }

      const balance = await this.computeBalance(session, usages, finalWeights, tx);
      const now = new Date();
      const claimed = await tx.operatorPostSession.updateMany({
        where: { id: session.id, status: 'active' },
        data: { status: 'closed', endedAt: now },
      });
      if (claimed.count === 0) {
        throw new ConflictException('Смена уже закрыта.');
      }
      await this.sessions.handoffPostBacklogAfterCloseInTransaction(tx, actor, session);
      let problemId: string | null = null;
      for (const usage of openUsages) {
        const endKg = provided.get(usage.bigBagId)!;
        await tx.shiftBagUsage.update({
          where: { id: usage.id },
          data: { endKg, releasedReason: null, closedAt: now },
        });
        await this.closeEpisode(tx, usage.id, usage.startKg, endKg, now, 'shift_closed');
        await tx.bigBagUnit.update({
          where: { id: usage.bigBagId },
          data: {
            currentKg: endKg,
            lastMeasuredKg: endKg,
            lastActorRole: actor.role,
            lastMeasuredAt: now,
            status: endKg > CONSUMED_THRESHOLD_KG ? 'available' : 'consumed',
          },
        });
        await this.audit.record(
          {
            type: 'audit:bigbag_weight_recorded',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: usage.bigBag.code,
            oldValue: { currentKg: usage.bigBag.currentKg },
            newValue: { currentKg: endKg },
            reason: 'Сдача смены',
          },
          tx,
        );
      }
      if (balance.status === 'mismatch') {
        problemId = await this.reportMismatch(actor, session.id, balance, mismatchOrderId, tx);
      }
      const completedAssignment = await tx.operatorShiftMachineAssignment.updateMany({
        where: {
          id: assignment.id,
          shiftId: session.shiftId!,
          operatorId: actor.userId!,
          postId: session.postId,
          status: { in: ['locked', 'breakdown_reassigned'] },
        },
        data: { status: 'completed' },
      });
      if (completedAssignment.count !== 1) {
        throw shiftLifecycleConflict('Назначение оператора уже завершено или изменилось.');
      }
      const remainingAssignments = await tx.operatorShiftMachineAssignment.count({
        where: { shiftId: session.shiftId!, status: { not: 'completed' } },
      });
      let shiftClosed = false;
      if (remainingAssignments === 0) {
        const closedShift = await tx.shift.updateMany({
          where: { id: session.shiftId!, status: 'open' },
          data: { status: 'closed', endedAt: now },
        });
        if (closedShift.count !== 1) {
          throw shiftLifecycleConflict('Производственная смена уже закрыта или изменилась.');
        }
        shiftClosed = true;
      }
      const closingPayroll = await this.payroll.getClosingPayroll(tx, {
        operatorId,
        sessionId: session.id,
        shiftId: session.shiftId!,
        postId: session.postId,
        generatedAt: now,
      });
      const result: OperatorShiftCloseResult = {
        balance,
        problemId,
        releasedRollIds,
        closingPayroll,
      };
      await this.audit.record(
        {
          type: 'audit:operator_shift_closed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: session.id,
          detail: {
            sessionId: session.id,
            shiftId: session.shiftId,
            assignmentId: assignment.id,
            shiftClosed,
            balance,
            problemId,
            operationKey,
            closingPayroll: {
              status: closingPayroll.status,
              payableKg: closingPayroll.summary.payableKg,
              payableAmountKopecks: closingPayroll.summary.payableAmountKopecks,
              unresolvedFactCount: closingPayroll.summary.unresolvedFactCount,
            },
            defectBags: defectBagFacts,
            defectBag: defectBagFacts[0],
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'audit:operator_post_session_closed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: session.postId,
          detail: { sessionId: session.id },
        },
        tx,
      );
      const command = await tx.operatorShiftCloseCommand.create({
        data: {
          operationKey,
          requestFingerprint: fingerprint,
          operatorId,
          sessionId: session.id,
          shiftId: session.shiftId!,
          postId: session.postId,
          assignmentId: assignment.id,
          actorRole: actor.role,
          resultSnapshot: result as unknown as Prisma.InputJsonValue,
        },
        select: { resultSnapshot: true },
      });
      return this.payroll.parseClosingResult(tx, command.resultSnapshot, {
        sessionId: session.id,
        shiftId: session.shiftId!,
        postId: session.postId,
      });
    });
  }

  private async prepareRollsForShiftClose(
    tx: Prisma.TransactionClient,
    actor: OperatorActor,
    session: { id: string; shiftId: string | null; postId: string },
  ): Promise<string[]> {
    const rolls = await tx.rollDispatchItem.findMany({
      where: {
        assignedOperatorId: actor.userId!,
        plannedShiftId: session.shiftId!,
        postId: session.postId,
        status: { notIn: ['new', 'defect', 'ready_for_warehouse', 'done'] },
      },
      select: {
        id: true,
        rollCode: true,
        assignedOperatorId: true,
        plannedShiftId: true,
        postId: true,
        status: true,
        operatorLine: {
          select: { id: true, step: true, deferredFromStep: true },
        },
      },
      orderBy: [{ queueRank: 'asc' }, { id: 'asc' }],
    });
    if (rolls.length === 0) return [];

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
        WHERE "id" IN (${Prisma.join(rolls.map(({ id }) => id).sort())})
        ORDER BY "id" FOR UPDATE`,
    );

    const untouched = rolls.filter(({ operatorLine }) => {
      if (!operatorLine || operatorLine.step === 'assigned') return true;
      return operatorLine.step === 'deferred' && operatorLine.deferredFromStep === 'assigned';
    });
    const untouchedIds = new Set(untouched.map(({ id }) => id));
    const paused = rolls.filter(
      ({ status, operatorLine }) =>
        status === 'deferred' &&
        operatorLine?.step === 'deferred' &&
        operatorLine.deferredFromStep !== null &&
        DEFERRED_STARTED_STEPS.has(operatorLine.deferredFromStep),
    );
    const pausedIds = new Set(paused.map(({ id }) => id));
    const started = rolls.filter(({ id }) => !untouchedIds.has(id) && !pausedIds.has(id));
    const automaticallyDeferred = started.filter(
      ({ status, operatorLine }) =>
        status === 'assigned' &&
        operatorLine !== null &&
        operatorLine.deferredFromStep === null &&
        DEFERRED_STARTED_STEPS.has(operatorLine.step),
    );
    const automaticallyDeferredIds = new Set(automaticallyDeferred.map(({ id }) => id));
    const blocked = started.filter(({ id }) => !automaticallyDeferredIds.has(id));
    if (blocked.length > 0) {
      throw new ConflictException({
        code: 'OPERATOR_SHIFT_STARTED_ROLLS_INCOMPLETE',
        message: 'Завершите начатый рулон перед сдачей смены.',
        rollCodes: blocked.map(({ rollCode }) => rollCode),
      });
    }
    if (automaticallyDeferred.length > 0) {
      for (const { operatorLine } of automaticallyDeferred) {
        const deferred = await tx.operatorRollLine.updateMany({
          where: {
            id: operatorLine!.id,
            step: operatorLine!.step,
            deferredFromStep: null,
          },
          data: { step: 'deferred', deferredFromStep: operatorLine!.step },
        });
        if (deferred.count !== 1) {
          throw shiftLifecycleConflict('Состояние начатого рулона изменилось перед сдачей смены.');
        }
      }
    }
    const deferredBacklog = [...paused, ...automaticallyDeferred];
    if (deferredBacklog.length > 0) {
      const deferredDispatches = await tx.rollDispatchItem.updateMany({
        where: {
          id: { in: deferredBacklog.map(({ id }) => id) },
          assignedOperatorId: actor.userId!,
          plannedShiftId: session.shiftId!,
          postId: session.postId,
          status: { in: ['assigned', 'deferred'] },
        },
        data: {
          assignedOperatorId: null,
          plannedShiftId: null,
          status: 'deferred',
        },
      });
      if (deferredDispatches.count !== deferredBacklog.length) {
        throw shiftLifecycleConflict('Состояние начатых рулонов изменилось перед сдачей смены.');
      }
    }
    if (automaticallyDeferred.length > 0) {
      for (const { rollCode, operatorLine } of automaticallyDeferred) {
        await this.audit.record(
          {
            type: 'audit:roll_deferred',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: rollCode,
            oldValue: { step: operatorLine!.step, status: 'assigned' },
            newValue: {
              step: 'deferred',
              deferredFromStep: operatorLine!.step,
              status: 'deferred',
            },
            reason: 'Автоматически отложен при сдаче смены',
            detail: {
              sessionId: session.id,
              postId: session.postId,
              automaticShiftClose: true,
            },
          },
          tx,
        );
      }
    }

    const deferredLines = untouched
      .map(({ operatorLine }) => operatorLine)
      .filter(
        (
          line,
        ): line is {
          id: string;
          step: string;
          deferredFromStep: string | null;
        } => Boolean(line?.step === 'deferred' && line.deferredFromStep === 'assigned'),
      );
    if (deferredLines.length > 0) {
      const reset = await tx.operatorRollLine.updateMany({
        where: {
          id: { in: deferredLines.map(({ id }) => id) },
          step: 'deferred',
          deferredFromStep: 'assigned',
        },
        data: { step: 'assigned', deferredFromStep: null },
      });
      if (reset.count !== deferredLines.length) {
        throw shiftLifecycleConflict('Состояние неначатых рулонов изменилось перед сдачей смены.');
      }
    }

    if (untouched.length > 0) {
      const released = await tx.rollDispatchItem.updateMany({
        where: {
          id: { in: untouched.map(({ id }) => id) },
          assignedOperatorId: actor.userId!,
          plannedShiftId: session.shiftId!,
          postId: session.postId,
          status: { in: ['assigned', 'deferred'] },
        },
        data: {
          assignedOperatorId: null,
          plannedShiftId: null,
          status: 'assigned',
        },
      });
      if (released.count !== untouched.length) {
        throw shiftLifecycleConflict('Назначения рулонов изменились перед сдачей смены.');
      }
    }

    await this.audit.record(
      {
        type: 'audit:roll_assignment_released',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: session.shiftId!,
        oldValue: {
          operatorId: actor.userId,
          shiftId: session.shiftId,
          postId: session.postId,
        },
        newValue: { operatorId: null, shiftId: null, postId: session.postId },
        reason: 'Незавершённые рулоны оставлены на производственном посту при сдаче смены',
        detail: {
          sessionId: session.id,
          rollIds: rolls.map(({ id }) => id),
          rollCodes: rolls.map(({ rollCode }) => rollCode),
          reasonCode: 'operator_shift_closed_post_backlog',
        },
      },
      tx,
    );
    return untouched.map(({ rollCode }) => rollCode);
  }

  private async closeLegacySession(
    tx: Prisma.TransactionClient,
    actor: OperatorActor,
    operatorId: string,
    operationKey: string,
    fingerprint: string,
    provided: ReadonlyMap<string, number>,
  ): Promise<OperatorShiftCloseResult> {
    const candidate = await tx.operatorPostSession.findFirst({
      where: {
        operatorId,
        status: 'closed',
        shiftId: { not: null },
      },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
    });
    if (!candidate) {
      throw shiftLifecycleConflict('Нет активной или ранее закрытой сессии для сдачи смены.');
    }

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "operator_post_sessions"
        WHERE "id" = ${candidate.id} FOR UPDATE`,
    );
    const session = await tx.operatorPostSession.findUnique({
      where: { id: candidate.id },
      include: { closeCommand: { select: { operationKey: true } } },
    });
    if (
      !session ||
      session.operatorId !== operatorId ||
      session.status !== 'closed' ||
      session.shiftId === null ||
      session.endedAt === null
    ) {
      throw shiftLifecycleConflict('Закрытая сессия изменилась; обновите экран и повторите.');
    }
    if (session.closeCommand) {
      throw shiftCloseConflict(
        'OPERATOR_SHIFT_ALREADY_CLOSED',
        'Эта смена уже сдана с другим operationKey.',
      );
    }

    const assignments = await tx.operatorShiftMachineAssignment.findMany({
      where: {
        shiftId: session.shiftId,
        operatorId,
        postId: session.postId,
        status: 'completed',
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    if (assignments.length !== 1) {
      throw shiftLifecycleConflict(
        'Нельзя однозначно определить завершённое назначение закрытой сессии.',
      );
    }

    const usages = await tx.shiftBagUsage.findMany({
      where: { sessionId: session.id },
      include: { episodes: { orderBy: { sequence: 'asc' } } },
      orderBy: { sequence: 'asc' },
    });
    if (usages.length === 0 || usages.some(({ endKg }) => endKg === null)) {
      throw shiftLifecycleConflict('У закрытой сессии нет полного финального баланса Big-Bag.');
    }
    const persistedRequestWeights = usages.filter(
      ({ closedAt }) => closedAt?.getTime() === session.endedAt!.getTime(),
    );
    if (
      provided.size !== persistedRequestWeights.length ||
      persistedRequestWeights.some(
        ({ bigBagId, endKg }) => !provided.has(bigBagId) || provided.get(bigBagId) !== endKg,
      )
    ) {
      throw new BadRequestException(
        'Финальные веса не совпадают с сохранённой сдачей закрытой сессии.',
      );
    }
    const finalWeights = new Map(usages.map(({ bigBagId, endKg }) => [bigBagId, endKg!] as const));
    const balance = await this.computeBalance(session, usages, finalWeights, tx);
    const closingPayroll = await this.payroll.getClosingPayroll(tx, {
      operatorId,
      sessionId: session.id,
      shiftId: session.shiftId,
      postId: session.postId,
      generatedAt: session.endedAt,
    });
    const result: OperatorShiftCloseResult = {
      balance,
      problemId: null,
      releasedRollIds: [],
      closingPayroll,
    };
    const command = await tx.operatorShiftCloseCommand.create({
      data: {
        operationKey,
        requestFingerprint: fingerprint,
        operatorId,
        sessionId: session.id,
        shiftId: session.shiftId,
        postId: session.postId,
        assignmentId: assignments[0]!.id,
        actorRole: actor.role,
        resultSnapshot: result as unknown as Prisma.InputJsonValue,
      },
      select: { resultSnapshot: true },
    });
    return this.payroll.parseClosingResult(tx, command.resultSnapshot, {
      sessionId: session.id,
      shiftId: session.shiftId,
      postId: session.postId,
    });
  }

  /**
   * Close follows the same global lock order as open/breakdown:
   * post -> shift -> assignment -> active session. Physical roll work enters at Post with
   * KEY SHARE before locking Session/Roll, so the two paths cannot invert each other.
   */
  private async lockCloseContext(
    tx: Prisma.TransactionClient,
    actor: OperatorActor,
    activeSnapshot?: {
      id: string;
      operatorId: string;
      postId: string;
      shiftId: string | null;
    },
  ) {
    if (!actor.userId) {
      throw shiftLifecycleConflict('Для сдачи смены требуется полная сессия оператора.');
    }
    const operatorId = actor.userId;
    const snapshot =
      activeSnapshot ??
      (await tx.operatorPostSession.findFirst({
        where: { operatorId, status: 'active' },
      }));
    if (!snapshot) {
      throw shiftLifecycleConflict('Нет активной сессии поста для сдачи смены.');
    }
    if (!snapshot.shiftId) {
      throw shiftLifecycleConflict('Активная сессия не привязана к производственной смене.');
    }
    const assignmentSnapshot = await tx.operatorShiftMachineAssignment.findFirst({
      where: {
        shiftId: snapshot.shiftId,
        operatorId,
        status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!assignmentSnapshot || assignmentSnapshot.postId !== snapshot.postId) {
      throw shiftLifecycleConflict('Назначение оператора не соответствует активной сессии.');
    }

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${snapshot.postId} FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${snapshot.shiftId} FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments" WHERE "id" = ${assignmentSnapshot.id} FOR UPDATE`,
    );

    const session = await this.sessions.lockActiveInTransaction(tx, operatorId);
    const [shift, assignment] = await Promise.all([
      tx.shift.findUnique({ where: { id: snapshot.shiftId } }),
      tx.operatorShiftMachineAssignment.findUnique({ where: { id: assignmentSnapshot.id } }),
    ]);
    if (
      session.id !== snapshot.id ||
      session.shiftId !== snapshot.shiftId ||
      session.postId !== snapshot.postId
    ) {
      throw shiftLifecycleConflict('Активная сессия изменилась; обновите экран и повторите.');
    }
    if (!shift || shift.status !== 'open') {
      throw shiftLifecycleConflict('Производственная смена уже закрыта или изменилась.');
    }
    if (
      !assignment ||
      assignment.id !== assignmentSnapshot.id ||
      assignment.shiftId !== session.shiftId ||
      assignment.operatorId !== operatorId ||
      assignment.postId !== session.postId ||
      !['locked', 'breakdown_reassigned'].includes(assignment.status)
    ) {
      throw shiftLifecycleConflict('Назначение оператора уже завершено или изменилось.');
    }
    return { session, assignment };
  }

  private async lockReadyDefectBags(tx: Prisma.TransactionClient, postSessionId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "defect_bags" WHERE "postSessionId" = ${postSessionId} ORDER BY "id" COLLATE "C" FOR UPDATE`,
    );
    const bags = await tx.defectBag.findMany({
      where: { postSessionId },
      orderBy: [{ weighedAt: 'asc' }, { id: 'asc' }],
    });
    if (bags.length === 0) {
      throw new ConflictException({
        code: 'DEFECT_BAG_REQUIRED',
        message: 'Для сдачи смены взвесьте мешок брака.',
      });
    }
    if (
      bags.some(
        (bag) =>
          bag.weightKg !== 0 &&
          !['ready_for_warehouse', 'received', 'shipped'].includes(bag.status),
      )
    ) {
      throw new ConflictException({
        code: 'DEFECT_BAG_LABEL_REQUIRED',
        message: 'Для сдачи смены напечатайте этикетки всех мешков брака.',
      });
    }
    return bags;
  }

  /**
   * Shift raw-material balance. producedKg is the canonical stable net capture for each
   * roll line attributed to this exact post session. defectKg is reported separately
   * and does not increase expected raw-material usage.
   */
  async computeBalance(
    session: { id: string; postId: string; startedAt: Date },
    usages?: Array<{
      startKg: number;
      endKg?: number | null;
      closedAt?: Date | null;
      releasedReason?: string | null;
      bigBagId: string;
      episodes?: Array<
        Omit<ShiftBagEpisodeFact, 'closeKind'> & {
          closeKind: string | null;
          sequence: number;
          closedAt: Date | null;
        }
      >;
    }>,
    endWeights?: Map<string, number>,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<OperatorShiftBalance> {
    const bagUsages =
      usages ??
      (await client.shiftBagUsage.findMany({
        where: { sessionId: session.id },
        include: { episodes: { orderBy: { sequence: 'asc' } } },
        orderBy: { sequence: 'asc' },
      }));
    const candidateLines = await client.weightCapture.findMany({
      where: {
        postSessionId: session.id,
        kind: 'roll',
        stable: true,
        netKg: { not: null },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
    });
    const candidateLineIds = [
      ...new Set(candidateLines.map(({ operatorRollLineId }) => operatorRollLineId)),
    ];
    const captures =
      candidateLineIds.length === 0
        ? []
        : await client.weightCapture.findMany({
            where: {
              kind: 'roll',
              stable: true,
              netKg: { not: null },
              operatorRollLineId: { in: candidateLineIds },
            },
            select: {
              id: true,
              operatorRollLineId: true,
              postSessionId: true,
              kind: true,
              stable: true,
              netKg: true,
              supersedesCaptureId: true,
              createdAt: true,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
    const canonicalCaptures = resolveCanonicalRollCaptures(captures).filter(
      (capture) => capture.postSessionId === session.id,
    );
    const producedKg = round3(
      canonicalCaptures.reduce((sum, capture) => sum + (capture.netKg ?? 0), 0),
    );
    const defects = await client.defectRecord.findMany({
      where: {
        weightCapture: {
          postSessionId: session.id,
          kind: 'roll',
          stable: true,
          netKg: { not: null },
        },
      },
      select: { weightCapture: { select: { netKg: true } } },
    });
    const defectKg = round3(
      defects.reduce(
        (sum: number, defect: { weightCapture: { netKg: number | null } | null }) =>
          sum + (defect.weightCapture?.netKg ?? 0),
        0,
      ),
    );
    const expectedUsageKg = round3(producedKg / ONE_TO_ONE_MATERIAL_USAGE_RATIO);

    const canonicalEpisodes = bagUsages.flatMap((usage) => {
      const facts = resolveCanonicalShiftBagUsageFacts({
        startKg: usage.startKg,
        endKg: usage.endKg ?? null,
        closedAt: usage.closedAt ?? null,
        releasedReason: usage.releasedReason ?? null,
        episodes: usage.episodes ?? [],
      });
      const finalWeight = endWeights?.get(usage.bigBagId);
      return facts.episodes.map((episode) =>
        episode.endKg === null && finalWeight !== undefined
          ? { ...episode, endKg: finalWeight, closeKind: 'shift_closed' as const }
          : episode,
      );
    });
    const actualUsageKg = calculateActualEpisodeUsageKg(canonicalEpisodes);
    if (actualUsageKg == null) {
      return {
        producedKg,
        defectKg,
        expectedUsageKg,
        actualUsageKg: null,
        deviationPercent: null,
        status: 'pending',
      };
    }
    const deviation =
      expectedUsageKg > 0
        ? (actualUsageKg - expectedUsageKg) / expectedUsageKg
        : actualUsageKg === 0
          ? 0
          : actualUsageKg > 0
            ? 1
            : -1;
    const tolerance = balanceTolerance();
    const comparisonEpsilon =
      Number.EPSILON * Math.max(1, Math.abs(deviation), Math.abs(tolerance)) * 8;
    return {
      producedKg,
      defectKg,
      expectedUsageKg,
      actualUsageKg,
      deviationPercent: round3(deviation * 100),
      status: Math.abs(deviation) <= tolerance + comparisonEpsilon ? 'ok' : 'mismatch',
    };
  }

  private async reportMismatch(
    actor: OperatorActor,
    sessionId: string,
    balance: OperatorShiftBalance,
    orderId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const reason =
      `Расхождение баланса сырья при сдаче смены: израсходовано ${balance.actualUsageKg} кг, ` +
      `производство объясняет ${balance.expectedUsageKg} кг (отклонение ${balance.deviationPercent}%).`;
    let problemId: string | null = null;
    if (orderId) {
      const problem = await tx.productionProblem.create({
        data: {
          type: 'shift_balance_mismatch',
          orderId,
          actorRole: actor.role,
          reason,
        },
      });
      problemId = problem.id;
    }
    const detail = { sessionId, balance, problemId };
    await this.audit.record(
      {
        type: 'problem:shift_balance_mismatch',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: orderId ?? sessionId,
        reason,
        detail,
      },
      tx,
    );
    await this.audit.record(
      {
        type: 'notification:production_problem_received',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: orderId ?? sessionId,
        label: 'Расхождение баланса сырья при сдаче смены',
        reason,
        detail,
      },
      tx,
    );
    return problemId;
  }

  private async registerBag(
    tx: Prisma.TransactionClient,
    actor: OperatorActor,
    sessionId: string,
    input: { bigBagId: string; startKg: number; sequence: number; addedReason: string | null },
  ) {
    const bag = await tx.bigBagUnit.findUnique({ where: { id: input.bigBagId } });
    if (!bag) throw new NotFoundException(`Big bag ${input.bigBagId} not found`);
    const existingUsage = await tx.shiftBagUsage.findUnique({
      where: {
        sessionId_bigBagId: {
          sessionId,
          bigBagId: input.bigBagId,
        },
      },
    });
    if (
      bag.status !== 'available' ||
      bag.registrationStatus !== 'registered' ||
      bag.location !== 'production'
    ) {
      throw new ConflictException(`Мешок ${bag.code} недоступен (статус: ${bag.status}).`);
    }
    const canonicalStartKg = bag.currentKg ?? input.startKg;
    if (bag.currentKg !== null && bag.currentKg !== input.startKg) {
      throw new ConflictException({
        code: 'OPERATOR_BIGBAG_STALE_WEIGHT',
        message: 'Вес Big-Bag изменился. Обновите список и используйте последнее значение.',
        currentKg: bag.currentKg,
      });
    }
    // Условный захват: параллельная попытка второго оператора получает 409, а не тот же мешок.
    const claimed = await tx.bigBagUnit.updateMany({
      where: {
        id: bag.id,
        status: 'available',
        registrationStatus: 'registered',
        location: 'production',
        currentKg: bag.currentKg,
      },
      data: {
        status: 'in_use',
        currentKg: canonicalStartKg,
        lastMeasuredKg: canonicalStartKg,
        lastActorRole: actor.role,
        lastMeasuredAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException(`Мешок ${bag.code} уже взят другим оператором.`);
    }
    let usage;
    if (existingUsage) {
      if (existingUsage.closedAt == null) {
        throw shiftLifecycleConflict(`Big-Bag ${bag.code} уже активен в этой смене.`);
      }
      const latestEpisode = await tx.shiftBagUsageEpisode.findFirst({
        where: { usageId: existingUsage.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true, closedAt: true },
      });
      if (latestEpisode && latestEpisode.closedAt == null) {
        throw shiftLifecycleConflict(`История Big-Bag ${bag.code} содержит активный интервал.`);
      }
      usage = await tx.shiftBagUsage.update({
        where: { id: existingUsage.id },
        data: {
          startKg: canonicalStartKg,
          endKg: null,
          addedReason: input.addedReason,
          releasedReason: null,
          closedAt: null,
        },
      });
      await tx.shiftBagUsageEpisode.create({
        data: {
          usageId: existingUsage.id,
          sequence: (latestEpisode?.sequence ?? 0) + 1,
          startKg: canonicalStartKg,
        },
      });
    } else {
      usage = await tx.shiftBagUsage.create({
        data: {
          sessionId,
          bigBagId: bag.id,
          startKg: canonicalStartKg,
          sequence: input.sequence,
          addedReason: input.addedReason,
        },
      });
      await tx.shiftBagUsageEpisode.create({
        data: {
          usageId: usage.id,
          sequence: 1,
          startKg: canonicalStartKg,
        },
      });
    }
    // Big-bag weighing is the explicit MANUAL exception — always audited (ТЗ §9).
    await this.audit.record(
      {
        type: 'audit:bigbag_weight_recorded',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: bag.code,
        oldValue: { currentKg: bag.currentKg },
        newValue: { currentKg: canonicalStartKg },
        reason:
          input.addedReason ??
          (input.sequence === 1 ? 'Открытие смены' : 'Добавление Big-Bag оператором'),
      },
      tx,
    );
    return usage;
  }

  private async closeEpisode(
    tx: Prisma.TransactionClient,
    usageId: string,
    startKg: number,
    endKg: number,
    closedAt: Date,
    closeKind: 'released' | 'shift_closed',
  ): Promise<void> {
    const closed = await tx.shiftBagUsageEpisode.updateMany({
      where: { usageId, closedAt: null },
      data: { endKg, closedAt, closeKind },
    });
    if (closed.count === 1) return;
    if (closed.count > 1) {
      throw shiftLifecycleConflict('У Big-Bag найдено несколько активных интервалов.');
    }
    const latest = await tx.shiftBagUsageEpisode.findFirst({
      where: { usageId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    if (latest) {
      throw shiftLifecycleConflict('У активного Big-Bag отсутствует открытый интервал.');
    }
    await tx.shiftBagUsageEpisode.create({
      data: {
        usageId,
        sequence: 1,
        startKg,
        endKg,
        closedAt,
        closeKind,
      },
    });
  }

  private async resolveAssignedPostCode(actor: OperatorActor): Promise<string> {
    if (!actor.userId) {
      throw new ConflictException('Post sessions require a logged-in operator account.');
    }
    const now = new Date();
    const assignment = await this.prisma.operatorShiftMachineAssignment.findFirst({
      where: {
        operatorId: actor.userId,
        status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
        shift: {
          status: { in: ['planned', 'open'] },
          OR: [
            { plannedStartAt: null, plannedEndAt: null },
            {
              plannedStartAt: { lte: now },
              plannedEndAt: { gt: now },
            },
          ],
        },
      },
      include: { post: { select: { code: true } } },
      orderBy: [{ shift: { createdAt: 'desc' } }, { createdAt: 'desc' }],
    });
    if (!assignment) {
      throw new ConflictException('No machine is assigned to this operator for the current shift');
    }
    return assignment.post.code;
  }

  private requirePositiveWeight(kg: number) {
    if (!Number.isFinite(kg) || kg <= 0) {
      throw new BadRequestException('Вес мешка должен быть положительным числом.');
    }
  }

  private requirePositiveOrZeroWeight(kg: number) {
    if (!Number.isFinite(kg) || kg < 0) {
      throw new BadRequestException('Финальный вес мешка не может быть отрицательным.');
    }
  }
}
