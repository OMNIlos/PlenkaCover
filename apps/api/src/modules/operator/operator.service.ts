import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  OperatorRuntime,
  OperatorRuntimeOrder,
  OperatorRuntimeRoll,
  OperatorRuntimeShift,
  OperatorShiftDefectBag,
  OperatorStep,
  Role,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { SCALE_ADAPTER, type ScaleAdapter } from '../../integrations/scale/scale.adapter';
import type { BigBagWeightDto } from './dto/bigbag.dto';
import type { OperatorProblemDto } from './dto/problem.dto';
import { OperatorSessionService } from './operator-session.service';
import { ONE_TO_ONE_MATERIAL_USAGE_RATIO, OperatorShiftService } from './operator-shift.service';
import { OperatorDeviceBindingService } from './operator-device-binding.service';
import { resolveSpoolPolicy } from './operator-spool-policy';
import { resolveCanonicalRollCaptures } from '../../common/weight-capture/canonical-roll-capture';

export interface OperatorActor {
  userId: string | null;
  role: Role;
}

const LINE_INCLUDE = {
  rollDispatchItem: {
    include: {
      productionOrder: {
        select: {
          id: true,
          commercialOrder: { select: { orderNumber: true, comment: true } },
        },
      },
      post: { select: { name: true } },
    },
  },
} as const;

const COMPLETED_STEPS = new Set<OperatorStep>(['warehouse']);

const REPORTED_PROBLEM_SELECT = {
  id: true,
  type: true,
  status: true,
  orderId: true,
  positionId: true,
  rollId: true,
  actorRole: true,
  reason: true,
  recovery: true,
  createdAt: true,
} satisfies Prisma.ProductionProblemSelect;

type ReportedProblem = Prisma.ProductionProblemGetPayload<{
  select: typeof REPORTED_PROBLEM_SELECT;
}>;

type ProblemReplayClient = Pick<Prisma.TransactionClient, 'productionProblem' | 'domainEvent'>;

function safeBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function projectRecipeSnapshot(
  value: unknown,
): NonNullable<NonNullable<OperatorRuntimeRoll['characteristicsSnapshot']>['recipe']> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const name = safeBoundedText(source.name, 120);
  if (!name || !Array.isArray(source.ingredients) || source.ingredients.length === 0) return null;
  if (source.ingredients.length > 100) return null;

  const ingredients = source.ingredients.flatMap((ingredient) => {
    if (!ingredient || typeof ingredient !== 'object' || Array.isArray(ingredient)) return [];
    const item = ingredient as Record<string, unknown>;
    const ingredientName = safeBoundedText(item.name, 120);
    const shareBasisPoints = item.shareBasisPoints;
    if (
      !ingredientName ||
      !Number.isInteger(shareBasisPoints) ||
      Number(shareBasisPoints) <= 0 ||
      Number(shareBasisPoints) > 10_000
    ) {
      return [];
    }
    return [{ name: ingredientName, shareBasisPoints: Number(shareBasisPoints) }];
  });
  if (
    ingredients.length !== source.ingredients.length ||
    ingredients.reduce((sum, ingredient) => sum + ingredient.shareBasisPoints, 0) !== 10_000
  ) {
    return null;
  }

  const version =
    source.version === null
      ? null
      : Number.isSafeInteger(source.version) && Number(source.version) > 0
        ? Number(source.version)
        : null;
  return { name, version, ingredients };
}

function projectLegacyRecipeName(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  for (const parameter of value) {
    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) continue;
    const source = parameter as Record<string, unknown>;
    const label = safeBoundedText(source.label, 100)?.toLocaleLowerCase('ru-RU');
    if (label !== 'сырьё' && label !== 'сырье') continue;
    return safeBoundedText(source.value, 1000);
  }
  return null;
}

function projectCharacteristicsSnapshot(
  snapshot: unknown,
): OperatorRuntimeRoll['characteristicsSnapshot'] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;

  const source = snapshot as Record<string, unknown>;
  const safeValue = (value: unknown) =>
    typeof value === 'string' || value === null ? value : undefined;
  const safeNumber = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : value === null ? null : undefined;
  const recipe = projectRecipeSnapshot(source.recipe);
  const legacyRecipeName = projectLegacyRecipeName(source.recipeParameters);
  return {
    actualThickness: safeValue(source.actualThickness),
    accountingThickness: safeValue(source.accountingThickness),
    widthMm: safeNumber(source.widthMm),
    spoolType: safeValue(source.spoolType),
    birka: safeValue(source.birka),
    manualBirka: safeValue(source.manualBirka),
    comment: safeValue(source.comment),
    ...(recipe ? { recipe } : {}),
    ...(legacyRecipeName ? { legacyRecipeName } : {}),
  };
}

@Injectable()
export class OperatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: OperatorSessionService,
    @Inject(SCALE_ADAPTER) private readonly scale: ScaleAdapter,
    private readonly shiftBalance: OperatorShiftService,
    private readonly bindings: OperatorDeviceBindingService,
  ) {}

  async getCurrentTask(operatorId?: string) {
    const line = await this.prisma.operatorRollLine.findFirst({
      where: {
        step: { notIn: ['warehouse', 'defect'] },
        rollDispatchItem: {
          ...(operatorId ? { assignedOperatorId: operatorId } : {}),
          status: { not: 'new' },
        },
      },
      include: LINE_INCLUDE,
      orderBy: { rollDispatchItem: { priority: 'desc' } },
    });
    return line ? this.projectLine(line) : null;
  }

  async listRolls(operatorId?: string, status?: string) {
    const lines = await this.prisma.operatorRollLine.findMany({
      where: {
        ...(status ? { step: status } : {}),
        rollDispatchItem: {
          ...(operatorId ? { assignedOperatorId: operatorId } : {}),
          status: { not: 'new' },
        },
      },
      include: LINE_INCLUDE,
      orderBy: { sequence: 'asc' },
    });
    return lines.map((l) => this.projectLine(l));
  }

  /** Aggregate operator read-model (V2 S5): shift + orders grouped from this operator's rolls. */
  async getRuntime(actor: OperatorActor): Promise<OperatorRuntime> {
    if (!actor.userId) {
      return { shift: null, orders: [], generatedAt: new Date().toISOString() };
    }
    const session = actor.userId ? await this.sessions.getCurrent(actor.userId) : null;
    if (session && !session.shiftId) {
      throw new ConflictException({
        code: 'OPERATOR_ACTIVE_SESSION_SHIFT_REQUIRED',
        message: 'Active operator session is not bound to a production shift.',
      });
    }

    const allLines = await this.prisma.operatorRollLine.findMany({
      where: {
        rollDispatchItem: {
          assignedOperatorId: actor.userId,
          ...(session
            ? {
                OR: [
                  { plannedShiftId: session.shiftId },
                  { status: { in: ['defect', 'ready_for_warehouse', 'done'] } },
                ],
              }
            : {}),
          status: { not: 'new' },
        },
      },
      include: LINE_INCLUDE,
      orderBy: [{ rollDispatchItem: { queueRank: 'asc' } }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    // Written-off defects (resolved by the production lead) leave the operator's queue.
    const lines = allLines.filter(
      (l) =>
        !((l.step === 'deferred' || l.step === 'defect') && l.rollDispatchItem.status === 'done'),
    );

    const materialIds = [
      ...new Set(
        lines
          .map((line) => line.rollDispatchItem.rawMaterialId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const materials = materialIds.length
      ? await this.prisma.rawMaterialStock.findMany({
          where: { materialId: { in: materialIds } },
          select: { materialId: true, label: true },
        })
      : [];
    const materialLabels = new Map(materials.map((item) => [item.materialId, item.label]));

    // Normalize progress inside each production order; queueRank remains global dispatch data.
    const byOrder = new Map<string, { orderNumber: string; lines: typeof lines }>();
    for (const l of lines) {
      const productionOrder = l.rollDispatchItem.productionOrder;
      const orderNumber = productionOrder.commercialOrder?.orderNumber ?? l.rollDispatchItemId;
      const bucket = byOrder.get(productionOrder.id) ?? { orderNumber, lines: [] };
      bucket.lines.push(l);
      byOrder.set(productionOrder.id, bucket);
    }

    const orders: OperatorRuntimeOrder[] = [...byOrder.values()].map(({ orderNumber, lines }) => {
      const group = [...lines].sort((left, right) => {
        const queueRankDifference =
          left.rollDispatchItem.queueRank - right.rollDispatchItem.queueRank;
        if (queueRankDifference !== 0) return queueRankDifference;
        const createdAtDifference = left.createdAt.getTime() - right.createdAt.getTime();
        if (createdAtDifference !== 0) return createdAtDifference;
        if (left.id < right.id) return -1;
        if (left.id > right.id) return 1;
        return 0;
      });
      const attempts = group.map((l) => {
        const characteristicsSnapshot = projectCharacteristicsSnapshot(
          l.rollDispatchItem.characteristicsSnapshot,
        );
        return {
          id: l.rollDispatchItem.rollCode,
          dispatchItemId: l.rollDispatchItemId,
          replacesDispatchItemId: l.rollDispatchItem.replacesDispatchItemId ?? null,
          queueRank: l.rollDispatchItem.queueRank,
          priority: l.rollDispatchItem.priority,
          machineId: l.rollDispatchItem.machineId,
          machineLabel: l.rollDispatchItem.post?.name ?? l.rollDispatchItem.machineId,
          plannedLengthM: l.rollDispatchItem.plannedLengthM,
          orderLineId: l.rollDispatchItem.orderLineId,
          positionSequence: l.rollDispatchItem.positionSequence,
          filmType: l.rollDispatchItem.filmType ?? null,
          rawMaterialId: l.rollDispatchItem.rawMaterialId,
          rawMaterialLabel: l.rollDispatchItem.rawMaterialId
            ? (materialLabels.get(l.rollDispatchItem.rawMaterialId) ?? null)
            : null,
          recipeVersion: l.rollDispatchItem.recipeVersion,
          characteristicsSnapshot,
          updatedAt: l.rollDispatchItem.updatedAt.toISOString(),
          status: l.step as OperatorStep,
          plannedNetKg: l.planKg,
          spoolWeightPolicy: resolveSpoolPolicy({
            spoolType: characteristicsSnapshot?.spoolType,
          }).mode,
          spoolKg: l.spoolKg,
          grossKg: l.grossKg,
          netKg: l.netKg,
          toleranceOk: l.toleranceOk,
          labelState: l.labelState,
          warehouseState: l.warehouseState,
        };
      });
      const rollByDispatchId = new Map(attempts.map((roll) => [roll.dispatchItemId, roll]));
      const rootDispatchId = (roll: (typeof attempts)[number]) => {
        let current = roll;
        const visited = new Set<string>();
        while (current.replacesDispatchItemId && !visited.has(current.dispatchItemId)) {
          visited.add(current.dispatchItemId);
          const parent = rollByDispatchId.get(current.replacesDispatchItemId);
          if (!parent) return current.replacesDispatchItemId;
          current = parent;
        }
        return current.dispatchItemId;
      };
      const attemptNumber = (roll: (typeof attempts)[number]) => {
        let current = roll;
        let number = 1;
        const visited = new Set<string>();
        while (current.replacesDispatchItemId && !visited.has(current.dispatchItemId)) {
          visited.add(current.dispatchItemId);
          number += 1;
          const parent = rollByDispatchId.get(current.replacesDispatchItemId);
          if (!parent) break;
          current = parent;
        }
        return number;
      };
      const plannedRootIds: string[] = [];
      for (const roll of attempts) {
        const rootId = rootDispatchId(roll);
        if (!plannedRootIds.includes(rootId)) plannedRootIds.push(rootId);
      }
      const rolls: OperatorRuntimeRoll[] = attempts.map((roll) => ({
        ...roll,
        sequenceNumber: plannedRootIds.indexOf(rootDispatchId(roll)) + 1,
        attemptNumber: attemptNumber(roll),
      }));
      const completed = plannedRootIds.filter((rootId) =>
        rolls.some((roll) => rootDispatchId(roll) === rootId && COMPLETED_STEPS.has(roll.status)),
      ).length;
      const active =
        rolls.find((roll) => !COMPLETED_STEPS.has(roll.status) && roll.status !== 'defect') ??
        rolls.at(-1)!;
      const activeRootIndex = plannedRootIds.indexOf(rootDispatchId(active));
      const progress = {
        current: Math.max(activeRootIndex + 1, 1),
        completed,
        total: plannedRootIds.length,
      };
      const current = active;
      const commercialComment =
        group[0].rollDispatchItem.productionOrder.commercialOrder?.comment?.trim() || null;
      return {
        id: orderNumber,
        title: orderNumber,
        commercialComment,
        filmType: group[0].rollDispatchItem.filmType ?? null,
        status: current.status,
        progress,
        plannedRolls: progress.total,
        completedRolls: progress.completed,
        currentRoll: current.sequenceNumber,
        currentDispatchItemId: current.dispatchItemId,
        rollPlanKg: current.plannedNetKg,
        spoolKg: current.spoolKg,
        rollNetKg: current.netKg,
        rolls,
      };
    });

    const assignmentAt = new Date();
    const plannedAssignment = !session
      ? await this.prisma.operatorShiftMachineAssignment.findFirst({
          where: {
            operatorId: actor.userId,
            status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
            shift: {
              status: { in: ['planned', 'open'] },
              OR: [
                { plannedStartAt: null, plannedEndAt: null },
                { plannedEndAt: { gt: assignmentAt } },
              ],
            },
          },
          include: {
            shift: {
              select: {
                id: true,
                status: true,
                plannedStartAt: true,
                plannedEndAt: true,
              },
            },
            post: { select: { code: true } },
            operator: { select: { displayName: true } },
          },
          orderBy: [{ shift: { createdAt: 'desc' } }, { createdAt: 'desc' }],
        })
      : null;
    let shift: OperatorRuntimeShift | null = null;
    if (session) {
      shift = await this.projectSessionShift(session, orders);
    } else if (plannedAssignment) {
      const { plannedStartAt, plannedEndAt } = plannedAssignment.shift;
      shift = {
        id: plannedAssignment.shiftId,
        status: plannedStartAt && plannedStartAt > assignmentAt ? 'scheduled' : 'start_missing',
        operatorName: plannedAssignment.operator.displayName,
        workplace: plannedAssignment.post.code,
        ...(plannedStartAt ? { plannedStartAt: plannedStartAt.toISOString() } : {}),
        ...(plannedEndAt ? { plannedEndAt: plannedEndAt.toISOString() } : {}),
      };
    }

    return { shift, orders, generatedAt: new Date().toISOString() };
  }

  /**
   * Shift block of the runtime (design 2026-07-13 §6): bags with weights, planned
   * consumption («выработка»), a rough duration estimate and the pending balance.
   * A session without a single registered bag is still «Нужен старт» — the shift
   * only opens through the bag-weighing gate.
   */
  private async projectSessionShift(
    session: {
      id: string;
      shiftId: string | null;
      postId: string;
      status: string;
      startedAt: Date;
      operator?: { displayName: string } | null;
      post?: { code: string } | null;
    },
    orders: OperatorRuntimeOrder[],
  ): Promise<OperatorRuntimeShift> {
    const [usages, defectBagRows] = await Promise.all([
      this.prisma.shiftBagUsage.findMany({
        where: { sessionId: session.id },
        include: {
          bigBag: true,
          episodes: { orderBy: { sequence: 'asc' } },
        },
        orderBy: { sequence: 'asc' },
      }),
      this.prisma.defectBag.findMany({
        where: { postSessionId: session.id },
        orderBy: [{ weighedAt: 'asc' }, { id: 'asc' }],
        include: {
          labelPrintJobs: {
            select: { status: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      }),
    ]);
    const bags = usages.map((usage) => ({
      bagId: usage.bigBagId,
      code: usage.bigBag.code,
      material: usage.bigBag.material,
      materialId: usage.bigBag.materialId ?? null,
      warehouseKg: usage.bigBag.initialKg ?? null,
      startKg: usage.startKg,
      endKg: usage.endKg ?? null,
      addedReason: usage.addedReason ?? null,
      releasedReason: usage.releasedReason ?? null,
      active: usage.closedAt == null,
      releasedAt: usage.closedAt?.toISOString() ?? null,
      sequence: usage.sequence,
    }));
    const ratio = ONE_TO_ONE_MATERIAL_USAGE_RATIO;
    const rollMinutes = Number(process.env.OPERATOR_ROLL_MINUTES ?? 25) || 25;
    const remaining = orders
      .flatMap((order) => order.rolls)
      .filter(
        (roll) =>
          roll.status !== 'warehouse' && roll.status !== 'deferred' && roll.status !== 'defect',
      );
    const unweighedRemaining = remaining.filter((roll) => roll.netKg === null);
    const plannedConsumptionKg = Number(
      (unweighedRemaining.reduce((sum, roll) => sum + (roll.plannedNetKg ?? 0), 0) / ratio).toFixed(
        3,
      ),
    );
    const balance = await this.shiftBalance.computeBalance(session);
    const defectBags = defectBagRows.map((bag): OperatorShiftDefectBag => {
      const printStatus = bag.labelPrintJobs[0]?.status;
      return {
        id: bag.id,
        code: bag.code,
        status: bag.status as OperatorShiftDefectBag['status'],
        defectType: bag.defectType as OperatorShiftDefectBag['defectType'],
        weightKg: bag.weightKg,
        recordedDefectKg: bag.recordedDefectKg,
        differenceKg: bag.differenceKg,
        labelState: ['submitted', 'failed', 'delivery_unknown'].includes(printStatus ?? '')
          ? (printStatus as OperatorShiftDefectBag['labelState'])
          : 'not_printed',
        weighedAt: bag.weighedAt.toISOString(),
      };
    });
    const activeBags = bags.filter((bag) => bag.active);
    const activeUsage = usages.find((usage) => usage.closedAt == null);
    const activeEpisode = activeUsage
      ? [...(activeUsage.episodes ?? [])]
          .sort((left, right) => right.sequence - left.sequence)
          .find((episode) => episode.closedAt === null)
      : undefined;
    const activeEpisodeOpenedAt = activeUsage
      ? (activeEpisode?.openedAt ?? activeUsage.createdAt ?? session.startedAt)
      : null;
    const capturedInActiveEpisodeKg = activeEpisodeOpenedAt
      ? await this.canonicalRollKgCapturedSince(session.id, activeEpisodeOpenedAt)
      : 0;
    const projectedEndKg = activeUsage
      ? Number(
          (
            (activeEpisode?.startKg ?? activeUsage.startKg) -
            capturedInActiveEpisodeKg / ratio -
            plannedConsumptionKg
          ).toFixed(3),
        )
      : undefined;
    const expectedEndKg = projectedEndKg === undefined ? undefined : Math.max(0, projectedEndKg);
    const plannedShortageKg =
      projectedEndKg === undefined ? undefined : Math.max(0, -projectedEndKg);
    const first = activeBags[0] ?? bags[0];
    return {
      id: session.shiftId ?? session.id,
      status:
        session.status !== 'active'
          ? 'closed'
          : bags.length === 0
            ? 'start_missing'
            : activeBags.length === 0
              ? 'bag_missing'
              : 'active',
      operatorName: session.operator?.displayName ?? 'Оператор',
      workplace: session.post?.code ?? '',
      bags,
      defectBags,
      ...(defectBags[0] ? { defectBag: defectBags[0] } : {}),
      balance,
      plannedConsumptionKg,
      yieldRatio: ratio,
      estimatedMinutes: remaining.length * rollMinutes,
      bigBagId: first?.code,
      startKg: first?.startKg,
      endKg: first?.endKg ?? undefined,
      expectedEndKg,
      plannedShortageKg,
      plannedUsageKg: plannedConsumptionKg,
      actualUsageKg: balance.actualUsageKg ?? undefined,
      deviationPercent: balance.deviationPercent ?? undefined,
    };
  }

  private async canonicalRollKgCapturedSince(sessionId: string, openedAt: Date): Promise<number> {
    const candidateLines = await this.prisma.weightCapture.findMany({
      where: {
        postSessionId: sessionId,
        kind: 'roll',
        stable: true,
        netKg: { not: null },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
    });
    const lineIds = [
      ...new Set(
        candidateLines
          .map(({ operatorRollLineId }) => operatorRollLineId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (lineIds.length === 0) return 0;

    const captures = await this.prisma.weightCapture.findMany({
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        operatorRollLineId: { in: lineIds },
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
    const capturedAtByLine = new Map<string, Date>();
    for (const capture of captures) {
      if (
        capture.supersedesCaptureId !== null ||
        capturedAtByLine.has(capture.operatorRollLineId)
      ) {
        continue;
      }
      capturedAtByLine.set(capture.operatorRollLineId, capture.createdAt);
    }

    return Number(
      resolveCanonicalRollCaptures(captures)
        .filter(
          (capture) =>
            capture.postSessionId === sessionId &&
            (capturedAtByLine.get(capture.operatorRollLineId)?.getTime() ?? 0) >=
              openedAt.getTime(),
        )
        .reduce((sum, capture) => sum + (capture.netKg ?? 0), 0)
        .toFixed(3),
    );
  }

  listPenalties(actor: OperatorActor) {
    if (!actor.userId) return Promise.resolve([]);
    return this.prisma.penalty.findMany({
      where: { employeeId: actor.userId, targetRole: 'operator' },
      include: { employee: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Живое чтение весов поста для интерактивного виджета (промпт: «интерактивные весы,
   * которые передают информацию с наших физических весов»). НИЧЕГО не фиксирует:
   * фиксация веса — только capture-эндпоинты. Требует активной пост-сессии.
   */
  async readScale(actor: OperatorActor, kind: 'spool' | 'roll') {
    const session = await this.sessions.requireActive(actor.userId);
    const device = await this.bindings.resolve(session.postId, 'scale');
    const reading = await this.scale.read(
      { deviceId: device.id, expectedPostId: session.postId, expectedKind: 'scale' },
      kind,
    );
    return {
      kind,
      status: reading.status,
      stable: reading.stable,
      grossKg: reading.grossKg,
      at: new Date().toISOString(),
    };
  }

  async bigBagWeight(actor: OperatorActor, bigBagId: string, dto: BigBagWeightDto) {
    const bag = await this.prisma.bigBagUnit.findUnique({ where: { code: bigBagId } });
    if (!bag) throw new NotFoundException(`Big bag ${bigBagId} not found`);
    const updated = await this.prisma.bigBagUnit.update({
      where: { code: bigBagId },
      data: {
        currentKg: dto.kg,
        lastMeasuredKg: dto.kg,
        lastActorRole: actor.role,
        lastMeasuredAt: new Date(),
      },
    });
    // Big-bag is the explicit MANUAL exception — always audited (ТЗ §9).
    await this.audit.record({
      type: 'audit:bigbag_weight_recorded',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: bigBagId,
      oldValue: { currentKg: bag.currentKg },
      newValue: { currentKg: dto.kg },
      reason: dto.reason,
    });
    return updated;
  }

  async reportProblem(actor: OperatorActor, dto: OperatorProblemDto) {
    const requestedType = dto.type as string | undefined;
    if (
      requestedType != null &&
      requestedType !== 'general' &&
      requestedType !== 'raw_material_shortage'
    ) {
      throw new BadRequestException({
        code:
          requestedType === 'defect'
            ? 'OPERATOR_DEFECT_PHYSICAL_CAPTURE_REQUIRED'
            : 'OPERATOR_PROBLEM_TYPE_NOT_REPORTABLE',
        message:
          requestedType === 'defect'
            ? 'Брак рулона фиксируется только через специальный сценарий со взвешиванием.'
            : 'Этот тип проблемы создаётся только специальным системным сценарием.',
      });
    }
    if (!dto.rollId) {
      throw new BadRequestException('rollId is required to route an operator problem.');
    }
    const operatorId = actor.userId;
    if (!operatorId) {
      throw new UnauthorizedException('Authentication required.');
    }
    const type = dto.type ?? 'general';
    const reason = dto.reason.trim();
    const recovery = dto.recovery?.trim() || null;
    const fingerprint = requestFingerprint({
      action: 'operator_problem_report',
      operatorId,
      type,
      rollId: dto.rollId,
      reason,
      recovery,
    });
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const replay = await this.replayReportedProblem(tx, dto.operationKey, fingerprint);
          if (replay) return replay;

          const session = await tx.operatorPostSession.findFirst({
            where: { operatorId, status: 'active' },
          });
          if (!session) {
            throw new ConflictException(
              'No active post session — open a post session before reporting a problem.',
            );
          }
          const line = await tx.operatorRollLine.findFirst({
            where: {
              rollDispatchItem: {
                rollCode: dto.rollId,
                assignedOperatorId: operatorId,
                postId: session.postId,
                plannedShiftId: session.shiftId,
                status: { notIn: ['new', 'ready_for_warehouse', 'done'] },
              },
              warehouseState: { notIn: ['sent', 'received', 'delivered'] },
            },
            include: {
              rollDispatchItem: {
                include: { productionOrder: true },
              },
            },
          });
          if (!line) throw new NotFoundException(`Operator roll ${dto.rollId} not found`);

          const orderId = line.rollDispatchItem.productionOrder.commercialOrderId;
          const positionId = line.rollDispatchItem.orderLineId;
          if (type === 'raw_material_shortage' && !positionId) {
            throw new ConflictException('The roll has no commercial position snapshot.');
          }

          const problem = await tx.productionProblem.create({
            data: {
              id: dto.operationKey,
              type,
              orderId,
              positionId,
              rollId: dto.rollId,
              actorRole: actor.role,
              reason,
              recovery,
            },
            select: REPORTED_PROBLEM_SELECT,
          });
          const detail = {
            problemId: problem.id,
            problemType: type,
            orderId,
            positionId,
            rollId: dto.rollId,
            operatorId,
            postId: session.postId,
            reason,
            recovery,
            requestFingerprint: fingerprint,
          };
          await this.audit.record(
            {
              type: 'problem:operator_reported',
              actorRole: actor.role,
              actorId: operatorId,
              objectId: problem.id,
              label: 'Оператор сообщил о проблеме',
              reason,
              detail,
            },
            tx,
          );
          return problem;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          const replay = await this.replayReportedProblem(
            this.prisma,
            dto.operationKey,
            fingerprint,
          );
          if (replay) return replay;
        }
        if (error.code === 'P2034') {
          const replay = await this.replayReportedProblem(
            this.prisma,
            dto.operationKey,
            fingerprint,
          );
          if (replay) return replay;
          throw new ConflictException(
            'Problem reporting conflicted with concurrent operator state.',
          );
        }
      }
      throw error;
    }
  }

  private async replayReportedProblem(
    client: ProblemReplayClient,
    operationKey: string,
    fingerprint: string,
  ): Promise<ReportedProblem | null> {
    const [problem, event] = await Promise.all([
      client.productionProblem.findUnique({
        where: { id: operationKey },
        select: REPORTED_PROBLEM_SELECT,
      }),
      client.domainEvent.findFirst({
        where: {
          type: 'problem:operator_reported',
          objectId: operationKey,
        },
        select: { detail: true },
      }),
    ]);
    if (!problem && !event) return null;

    const detail =
      event?.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
        ? event.detail
        : null;
    if (!problem || !detail || detail.requestFingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'OPERATOR_PROBLEM_OPERATION_KEY_REUSED',
        message: 'Этот ключ уже относится к другому сообщению о проблеме.',
      });
    }
    return problem;
  }

  private projectLine(line: {
    step: string;
    planKg: number | null;
    spoolKg: number | null;
    netKg: number | null;
    toleranceOk: boolean | null;
    labelState: string;
    warehouseState: string;
    rollDispatchItem: {
      rollCode: string;
      productionOrder?: {
        commercialOrder?: {
          orderNumber: string;
        };
      } | null;
    };
  }) {
    const co = line.rollDispatchItem.productionOrder?.commercialOrder;
    return {
      rollCode: line.rollDispatchItem.rollCode,
      orderNumber: co?.orderNumber ?? null,
      step: line.step,
      planKg: line.planKg,
      spoolKg: line.spoolKg,
      netKg: line.netKg,
      toleranceOk: line.toleranceOk,
      labelState: line.labelState,
      warehouseState: line.warehouseState,
    };
  }
}
