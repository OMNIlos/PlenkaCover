import { Injectable } from '@nestjs/common';
import type { DirectorPayrollMaterialClass } from '@plenka/contracts';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { payrollBirkaFromSnapshot } from '../../common/payroll-tariffs/payroll-tariff-engine';
import { resolveCanonicalRollCaptures } from '../../common/weight-capture/canonical-roll-capture';
import type { ParsedDirectorAnalyticsRange } from './director-analytics.time';

export type DirectorPayrollProductionFact = {
  lineId: string;
  rollId: string;
  rollCode: string;
  orderId: string;
  orderNumber: string;
  productionOrderId?: string;
  actualKg: number;
  producedAt: Date;
  canonicalCaptureId?: string;
  rootCaptureId?: string;
  operatorId: string | null;
  operatorName: string | null;
  rootSessionId: string | null;
  rootSessionStatus?: string | null;
  rootSessionStartedAt?: Date | null;
  rootSessionEndedAt?: Date | null;
  shift: {
    id: string;
    label: string;
    status: string;
    plannedStartAt: Date | null;
    plannedEndAt: Date | null;
    endedAt?: Date | null;
  } | null;
  post: { id: string; code: string; name: string } | null;
  dispatchStatus: string;
  dispatchCompletedAt?: Date | null;
  operatorStep: string;
  hasDefect: boolean;
  filmType: string | null;
  birka?: string | null;
  counterpartyLegalName: string | null;
  materialKinds: string[];
  materialComponents?: Array<{
    rawMaterialDefinitionId: string;
    name: string;
    shareBasisPoints: number;
  }>;
  machineAssignment?: { id: string; status: string } | null;
  spoolType?: string | null;
  widthMicrometers?: number | null;
  plannedWeightGrams?: number | null;
};

/**
 * One operator's stint on one post. Pay is earned per session: the operator is
 * paid for the canonical net weight of non-defective rolls produced during it.
 */
export type DirectorPayrollSessionFact = {
  sessionId: string;
  operatorId: string | null;
  operatorName: string | null;
  post: { id: string; code: string; name: string };
  shift: { id: string; label: string; status: string } | null;
  startedAt: Date;
  endedAt: Date | null;
  /** Canonical net weight of non-defective rolls produced in this session. */
  processedKg: number | null;
  /** Big-Bag material names, as the warehouse named them. */
  materialNames: string[];
  rolls?: Array<{ grams: number; birka: string | null }>;
};

export type DirectorPayrollFactsSnapshot = {
  periodFacts: DirectorPayrollProductionFact[];
  thresholdFacts: DirectorPayrollProductionFact[];
  sessionFacts: DirectorPayrollSessionFact[];
};

export type DirectorPayrollFactsClient = Prisma.TransactionClient | PrismaService;

export type DirectorPayrollRootSessionScope = {
  operatorId: string;
  rootSessionId: string;
  shiftId: string;
  postId: string;
};

const MATERIAL_QUERY_CHUNK_SIZE = 1_000;
const CANONICAL_BASE_MATERIAL_CLASSES = new Map<string, DirectorPayrollMaterialClass>([
  ['rmd-base-primary', 'primary'],
  ['rmd-base-secondary', 'secondary'],
]);

const payrollCaptureSelect = {
  id: true,
  operatorRollLineId: true,
  kind: true,
  stable: true,
  netKg: true,
  postSessionId: true,
  supersedesCaptureId: true,
  createdAt: true,
  postSession: {
    select: {
      id: true,
      status: true,
      startedAt: true,
      endedAt: true,
      operator: { select: { id: true, displayName: true, role: true } },
      post: { select: { id: true, code: true, name: true } },
      shift: {
        select: {
          id: true,
          label: true,
          status: true,
          plannedStartAt: true,
          plannedEndAt: true,
          endedAt: true,
          machineAssignments: {
            select: { id: true, operatorId: true, postId: true, status: true },
          },
        },
      },
    },
  },
  operation: {
    select: {
      status: true,
      actor: { select: { id: true, displayName: true } },
    },
  },
  line: {
    select: {
      id: true,
      step: true,
      defects: { select: { id: true, createdAt: true } },
      rollDispatchItem: {
        select: {
          id: true,
          rollCode: true,
          status: true,
          completedAt: true,
          plannedWeightKg: true,
          widthMm: true,
          rawMaterialId: true,
          filmType: true,
          characteristicsSnapshot: true,
          productionOrder: {
            select: {
              id: true,
              commercialOrder: {
                select: {
                  id: true,
                  orderNumber: true,
                  counterparty: { select: { legalName: true } },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

type PayrollCaptureRow = Prisma.WeightCaptureGetPayload<{
  select: typeof payrollCaptureSelect;
}>;

type PayrollFactDraft = {
  fact: DirectorPayrollProductionFact;
  directMaterialId: string | null;
  recipeDefinitionIds: string[];
  recipeComponents: Array<{
    rawMaterialDefinitionId: string;
    shareBasisPoints: number;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function payrollMaterialClass(
  definitionId: string,
  kind: string,
): DirectorPayrollMaterialClass | undefined {
  if (kind === 'primary' || kind === 'secondary') return kind;
  if (kind !== 'base') return undefined;
  return CANONICAL_BASE_MATERIAL_CLASSES.get(definitionId);
}

function recipeDefinitionIds(snapshot: Prisma.JsonValue | null): string[] {
  if (!isRecord(snapshot) || !isRecord(snapshot.recipe)) return [];
  const ingredients = snapshot.recipe.ingredients;
  if (!Array.isArray(ingredients)) return [];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const ingredient of ingredients) {
    if (!isRecord(ingredient)) return [];
    const id = ingredient.rawMaterialDefinitionId;
    if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) return [];
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function recipeComponents(snapshot: Prisma.JsonValue | null): PayrollFactDraft['recipeComponents'] {
  if (!isRecord(snapshot) || !isRecord(snapshot.recipe)) return [];
  const ingredients = snapshot.recipe.ingredients;
  if (!Array.isArray(ingredients)) return [];

  const result: PayrollFactDraft['recipeComponents'] = [];
  const seen = new Set<string>();
  for (const ingredient of ingredients) {
    if (!isRecord(ingredient)) return [];
    const id = ingredient.rawMaterialDefinitionId;
    const shareBasisPoints = ingredient.shareBasisPoints;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.trim() !== id ||
      typeof shareBasisPoints !== 'number' ||
      !Number.isSafeInteger(shareBasisPoints) ||
      shareBasisPoints <= 0 ||
      shareBasisPoints > 10_000
    ) {
      return [];
    }
    if (!seen.has(id)) {
      seen.add(id);
      result.push({ rawMaterialDefinitionId: id, shareBasisPoints });
    }
  }
  return result.reduce((sum, component) => sum + component.shareBasisPoints, 0) === 10_000
    ? result
    : [];
}

function rootCapture(
  leaf: PayrollCaptureRow,
  rowsById: ReadonlyMap<string, PayrollCaptureRow>,
): PayrollCaptureRow | null {
  let current = leaf;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    if (current.supersedesCaptureId === null) return current;

    const predecessor = rowsById.get(current.supersedesCaptureId);
    if (!predecessor || predecessor.operatorRollLineId !== leaf.operatorRollLineId) return null;
    current = predecessor;
  }
}

function producer(root: PayrollCaptureRow): {
  operatorId: string | null;
  operatorName: string | null;
} {
  if (root.postSession?.operator.role === 'operator') {
    return {
      operatorId: root.postSession.operator.id,
      operatorName: root.postSession.operator.displayName,
    };
  }
  if (root.operation?.status === 'succeeded') {
    return {
      operatorId: root.operation.actor.id,
      operatorName: root.operation.actor.displayName,
    };
  }
  return { operatorId: null, operatorName: null };
}

function completedMachineAssignment(
  candidates: readonly { id: string; operatorId: string; postId: string; status: string }[],
  operatorId: string | undefined,
  postId: string | undefined,
): { id: string; status: string } | null {
  if (!operatorId || !postId) return null;
  const completed = candidates.filter(
    (candidate) =>
      candidate.operatorId === operatorId &&
      candidate.postId === postId &&
      candidate.status === 'completed',
  );
  return completed.length === 1 ? { id: completed[0].id, status: completed[0].status } : null;
}

function compareFacts(
  left: DirectorPayrollProductionFact,
  right: DirectorPayrollProductionFact,
): number {
  return (
    right.producedAt.getTime() - left.producedAt.getTime() ||
    left.rollId.localeCompare(right.rollId)
  );
}

function orderedCapturedRows(
  rows: readonly PayrollCaptureRow[],
  generatedAt: Date,
): PayrollCaptureRow[] {
  return rows
    .filter(({ createdAt }) => createdAt.getTime() <= generatedAt.getTime())
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
    );
}

function buildDrafts(
  sourceRows: readonly PayrollCaptureRow[],
  generatedAt: Date,
): PayrollFactDraft[] {
  const rows = orderedCapturedRows(sourceRows, generatedAt);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const draftsByLine = new Map<string, PayrollFactDraft>();

  for (const leaf of resolveCanonicalRollCaptures(rows)) {
    if (
      leaf.netKg === null ||
      !Number.isFinite(leaf.netKg) ||
      leaf.netKg <= 0 ||
      draftsByLine.has(leaf.operatorRollLineId)
    ) {
      continue;
    }
    const root = rootCapture(leaf, rowsById);
    if (root === null) continue;

    const roll = root.line.rollDispatchItem;
    const order = roll.productionOrder.commercialOrder;
    const resolvedProducer = producer(root);
    const shift = root.postSession?.shift;
    const post = root.postSession?.post;
    const assignment = completedMachineAssignment(
      shift?.machineAssignments ?? [],
      root.postSession?.operator.id,
      root.postSession?.post.id,
    );
    const characteristics = isRecord(roll.characteristicsSnapshot)
      ? roll.characteristicsSnapshot
      : {};
    const spoolType =
      typeof characteristics.spoolType === 'string' &&
      characteristics.spoolType.trim() === characteristics.spoolType &&
      characteristics.spoolType.length > 0
        ? characteristics.spoolType
        : null;
    const widthMm =
      typeof characteristics.widthMm === 'number' && Number.isFinite(characteristics.widthMm)
        ? characteristics.widthMm
        : roll.widthMm;
    const widthMicrometers =
      typeof widthMm === 'number' &&
      Number.isFinite(widthMm) &&
      widthMm > 0 &&
      Number.isSafeInteger(Math.round(widthMm * 1_000))
        ? Math.round(widthMm * 1_000)
        : null;
    const plannedWeightGrams =
      typeof roll.plannedWeightKg === 'number' &&
      Number.isFinite(roll.plannedWeightKg) &&
      roll.plannedWeightKg > 0 &&
      Number.isSafeInteger(Math.round(roll.plannedWeightKg * 1_000))
        ? Math.round(roll.plannedWeightKg * 1_000)
        : null;
    draftsByLine.set(leaf.operatorRollLineId, {
      fact: {
        lineId: root.line.id,
        rollId: roll.id,
        rollCode: roll.rollCode,
        orderId: order.id,
        orderNumber: order.orderNumber,
        productionOrderId: roll.productionOrder.id,
        actualKg: leaf.netKg,
        producedAt: root.createdAt,
        canonicalCaptureId: leaf.id,
        rootCaptureId: root.id,
        operatorId: resolvedProducer.operatorId,
        operatorName: resolvedProducer.operatorName,
        rootSessionId: root.postSessionId,
        rootSessionStatus: root.postSession?.status ?? null,
        rootSessionStartedAt: root.postSession?.startedAt ?? null,
        rootSessionEndedAt: root.postSession?.endedAt ?? null,
        shift: shift
          ? {
              id: shift.id,
              label: shift.label,
              status: shift.status,
              plannedStartAt: shift.plannedStartAt,
              plannedEndAt: shift.plannedEndAt,
              endedAt: shift.endedAt,
            }
          : null,
        post: post ? { id: post.id, code: post.code, name: post.name } : null,
        dispatchStatus: roll.status,
        dispatchCompletedAt: roll.completedAt,
        operatorStep: root.line.step,
        hasDefect: root.line.defects.some(
          ({ createdAt }) => createdAt.getTime() <= generatedAt.getTime(),
        ),
        filmType: roll.filmType,
        birka: payrollBirkaFromSnapshot(characteristics),
        counterpartyLegalName: order.counterparty?.legalName ?? null,
        materialKinds: [],
        materialComponents: [],
        machineAssignment: assignment,
        spoolType,
        widthMicrometers,
        plannedWeightGrams,
      },
      directMaterialId: roll.rawMaterialId,
      recipeDefinitionIds: recipeDefinitionIds(roll.characteristicsSnapshot),
      recipeComponents: recipeComponents(roll.characteristicsSnapshot),
    });
  }
  return [...draftsByLine.values()];
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += MATERIAL_QUERY_CHUNK_SIZE) {
    result.push(values.slice(index, index + MATERIAL_QUERY_CHUNK_SIZE));
  }
  return result;
}

function inPeriod(fact: DirectorPayrollProductionFact, range: ParsedDirectorAnalyticsRange) {
  return fact.producedAt >= range.fromUtc && fact.producedAt < range.toExclusiveUtc;
}

@Injectable()
export class DirectorPayrollFactsService {
  constructor(private readonly prisma: PrismaService) {}

  async load(
    range: ParsedDirectorAnalyticsRange,
    generatedAt: Date,
    client: DirectorPayrollFactsClient = this.prisma,
  ): Promise<DirectorPayrollFactsSnapshot> {
    const periodCandidates = await client.weightCapture.findMany({
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        createdAt: {
          gte: range.fromUtc,
          lt: range.toExclusiveUtc,
          lte: generatedAt,
        },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
      orderBy: [{ operatorRollLineId: 'asc' }],
    });
    // Anchored on handover, exactly like the control tab's shift evidence, so a
    // session lands in the same period on both surfaces.
    const sessionFacts = await this.loadSessions(
      { status: 'closed', endedAt: { gte: range.fromUtc, lt: range.toExclusiveUtc } },
      generatedAt,
      client,
    );
    const periodLineIds = [
      ...new Set(periodCandidates.map(({ operatorRollLineId }) => operatorRollLineId)),
    ].sort();
    if (periodLineIds.length === 0) {
      return { periodFacts: [], thresholdFacts: [], sessionFacts };
    }

    const periodRows = await this.loadChains(periodLineIds, generatedAt, client);
    const periodDrafts = buildDrafts(periodRows, generatedAt).filter(({ fact }) =>
      inPeriod(fact, range),
    );
    const shiftIds = [
      ...new Set(periodDrafts.flatMap(({ fact }) => (fact.shift === null ? [] : [fact.shift.id]))),
    ].sort();

    const shiftCandidates =
      shiftIds.length === 0
        ? []
        : await client.weightCapture.findMany({
            where: {
              kind: 'roll',
              stable: true,
              netKg: { not: null },
              supersedesCaptureId: null,
              postSession: { shiftId: { in: shiftIds } },
              createdAt: { lte: generatedAt },
            },
            select: { operatorRollLineId: true },
            distinct: ['operatorRollLineId'],
            orderBy: [{ operatorRollLineId: 'asc' }],
          });
    const allLineIds = [
      ...new Set([
        ...periodLineIds,
        ...shiftCandidates.map(({ operatorRollLineId }) => operatorRollLineId),
      ]),
    ].sort();
    const allRows = await this.loadChains(allLineIds, generatedAt, client);
    const periodCanonicalLineIds = new Set(periodDrafts.map(({ fact }) => fact.lineId));
    const relevantShiftIds = new Set(shiftIds);
    const drafts = buildDrafts(allRows, generatedAt).filter(
      ({ fact }) =>
        periodCanonicalLineIds.has(fact.lineId) ||
        (fact.shift !== null && relevantShiftIds.has(fact.shift.id)),
    );
    await this.enrichMaterials(drafts, client);

    const thresholdFacts = drafts.map(({ fact }) => fact).sort(compareFacts);
    return {
      periodFacts: thresholdFacts.filter((fact) => inPeriod(fact, range)),
      thresholdFacts,
      sessionFacts,
    };
  }

  async loadForOperatorRootSession(
    scope: DirectorPayrollRootSessionScope,
    generatedAt: Date,
    client: DirectorPayrollFactsClient = this.prisma,
  ): Promise<DirectorPayrollFactsSnapshot> {
    const periodCandidates = await client.weightCapture.findMany({
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        postSessionId: scope.rootSessionId,
        createdAt: { lte: generatedAt },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
      orderBy: [{ operatorRollLineId: 'asc' }],
    });
    const periodLineIds = [
      ...new Set(periodCandidates.map(({ operatorRollLineId }) => operatorRollLineId)),
    ].sort();
    const periodDrafts = buildDrafts(
      await this.loadChains(periodLineIds, generatedAt, client),
      generatedAt,
    ).filter(
      ({ fact }) =>
        fact.operatorId === scope.operatorId && fact.rootSessionId === scope.rootSessionId,
    );

    const thresholdCandidates = await client.weightCapture.findMany({
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        supersedesCaptureId: null,
        postSession: { shiftId: scope.shiftId },
        createdAt: { lte: generatedAt },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
      orderBy: [{ operatorRollLineId: 'asc' }],
    });
    const allLineIds = [
      ...new Set([
        ...periodLineIds,
        ...thresholdCandidates.map(({ operatorRollLineId }) => operatorRollLineId),
      ]),
    ].sort();
    const periodCanonicalLineIds = new Set(periodDrafts.map(({ fact }) => fact.lineId));
    const drafts = buildDrafts(
      await this.loadChains(allLineIds, generatedAt, client),
      generatedAt,
    ).filter(
      ({ fact }) =>
        periodCanonicalLineIds.has(fact.lineId) ||
        (fact.shift?.id === scope.shiftId && fact.post?.id === scope.postId),
    );
    await this.enrichMaterials(drafts, client);

    const thresholdFacts = drafts
      .map(({ fact }) => fact)
      .filter((fact) => fact.shift?.id === scope.shiftId && fact.post?.id === scope.postId)
      .sort(compareFacts);
    return {
      sessionFacts: await this.loadSessions({ id: scope.rootSessionId }, generatedAt, client),
      periodFacts: drafts
        .map(({ fact }) => fact)
        .filter(
          (fact) =>
            fact.operatorId === scope.operatorId &&
            fact.rootSessionId === scope.rootSessionId &&
            periodCanonicalLineIds.has(fact.lineId),
        )
        .sort(compareFacts),
      thresholdFacts,
    };
  }

  async loadForProductionOrders(
    productionOrderIds: readonly string[],
    generatedAt: Date,
    client: DirectorPayrollFactsClient = this.prisma,
  ): Promise<DirectorPayrollProductionFact[]> {
    const uniqueIds = [...new Set(productionOrderIds)].sort();
    if (uniqueIds.length === 0) return [];
    const candidates = (
      await Promise.all(
        chunks(uniqueIds).map((idChunk) =>
          client.weightCapture.findMany({
            where: {
              kind: 'roll',
              stable: true,
              netKg: { not: null },
              createdAt: { lte: generatedAt },
              line: { rollDispatchItem: { productionOrderId: { in: idChunk } } },
            },
            select: { operatorRollLineId: true },
            distinct: ['operatorRollLineId'],
            orderBy: [{ operatorRollLineId: 'asc' }],
          }),
        ),
      )
    ).flat();
    const lineIds = [
      ...new Set(candidates.map(({ operatorRollLineId }) => operatorRollLineId)),
    ].sort();
    if (lineIds.length === 0) return [];

    const drafts = buildDrafts(await this.loadChains(lineIds, generatedAt, client), generatedAt);
    await this.enrichMaterials(drafts, client);
    return drafts.map(({ fact }) => fact).sort(compareFacts);
  }

  async loadForRollDispatchItems(
    rollDispatchItemIds: readonly string[],
    generatedAt: Date,
    client: DirectorPayrollFactsClient = this.prisma,
  ): Promise<DirectorPayrollProductionFact[]> {
    const uniqueIds = [...new Set(rollDispatchItemIds)].sort();
    if (uniqueIds.length === 0) return [];
    const candidates = (
      await Promise.all(
        chunks(uniqueIds).map((idChunk) =>
          client.weightCapture.findMany({
            where: {
              kind: 'roll',
              stable: true,
              createdAt: { lte: generatedAt },
              line: { rollDispatchItemId: { in: idChunk } },
            },
            select: { operatorRollLineId: true },
            distinct: ['operatorRollLineId'],
            orderBy: [{ operatorRollLineId: 'asc' }],
          }),
        ),
      )
    ).flat();
    const lineIds = [
      ...new Set(candidates.map(({ operatorRollLineId }) => operatorRollLineId)),
    ].sort();
    if (lineIds.length === 0) return [];
    const drafts = buildDrafts(await this.loadChains(lineIds, generatedAt, client), generatedAt);
    await this.enrichMaterials(drafts, client);
    return drafts.map(({ fact }) => fact).sort(compareFacts);
  }

  async loadForRootSessions(
    rootSessionIds: readonly string[],
    generatedAt: Date,
    client: DirectorPayrollFactsClient = this.prisma,
  ): Promise<DirectorPayrollProductionFact[]> {
    const uniqueIds = [...new Set(rootSessionIds)].sort();
    if (uniqueIds.length === 0) return [];
    const candidates = (
      await Promise.all(
        chunks(uniqueIds).map((idChunk) =>
          client.weightCapture.findMany({
            where: {
              kind: 'roll',
              stable: true,
              createdAt: { lte: generatedAt },
              postSessionId: { in: idChunk },
            },
            select: { operatorRollLineId: true },
            distinct: ['operatorRollLineId'],
            orderBy: [{ operatorRollLineId: 'asc' }],
          }),
        ),
      )
    ).flat();
    const lineIds = [
      ...new Set(candidates.map(({ operatorRollLineId }) => operatorRollLineId)),
    ].sort();
    if (lineIds.length === 0) return [];
    const drafts = buildDrafts(await this.loadChains(lineIds, generatedAt, client), generatedAt);
    await this.enrichMaterials(drafts, client);
    return drafts.map(({ fact }) => fact).sort(compareFacts);
  }

  /**
   * Post sessions are the unit of pay, while their output comes from canonical
   * roll chains so a mismatching Big-Bag balance cannot change wages.
   */
  private async loadSessions(
    where: Prisma.OperatorPostSessionWhereInput,
    generatedAt: Date,
    client: DirectorPayrollFactsClient,
  ): Promise<DirectorPayrollSessionFact[]> {
    const rows = await client.operatorPostSession.findMany({
      where: { ...where, startedAt: { lte: generatedAt } },
      select: {
        id: true,
        status: true,
        startedAt: true,
        endedAt: true,
        operator: { select: { id: true, displayName: true, role: true } },
        post: { select: { id: true, code: true, name: true } },
        shift: { select: { id: true, label: true, status: true } },
        bagUsages: {
          select: {
            startKg: true,
            endKg: true,
            closedAt: true,
            releasedReason: true,
            bigBag: { select: { material: true } },
            episodes: {
              select: {
                sequence: true,
                startKg: true,
                endKg: true,
                closeKind: true,
                closedAt: true,
              },
              orderBy: { sequence: 'asc' },
            },
          },
          orderBy: { sequence: 'asc' },
        },
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });

    const productionFacts = await this.loadForRootSessions(
      rows.map(({ id }) => id),
      generatedAt,
      client,
    );
    const processedGramsBySessionId = new Map<string, number>();
    const rollsBySessionId = new Map<string, NonNullable<DirectorPayrollSessionFact['rolls']>>();
    for (const fact of productionFacts) {
      if (fact.rootSessionId === null || fact.hasDefect) continue;
      const rolls = rollsBySessionId.get(fact.rootSessionId) ?? [];
      rolls.push({ grams: Math.round(fact.actualKg * 1_000), birka: fact.birka ?? null });
      rollsBySessionId.set(fact.rootSessionId, rolls);
      processedGramsBySessionId.set(
        fact.rootSessionId,
        (processedGramsBySessionId.get(fact.rootSessionId) ?? 0) +
          Math.round(fact.actualKg * 1_000),
      );
    }

    return rows.map((row) => ({
      sessionId: row.id,
      operatorId: row.operator.role === 'operator' ? row.operator.id : null,
      operatorName: row.operator.role === 'operator' ? row.operator.displayName : null,
      post: row.post,
      shift: row.shift,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      processedKg: (processedGramsBySessionId.get(row.id) ?? 0) / 1_000,
      materialNames: row.bagUsages.map(({ bigBag }) => bigBag.material),
      rolls: rollsBySessionId.get(row.id) ?? [],
    }));
  }

  private loadChains(
    lineIds: string[],
    generatedAt: Date,
    client: DirectorPayrollFactsClient,
  ): Promise<PayrollCaptureRow[]> {
    if (lineIds.length === 0) return Promise.resolve([]);
    return client.weightCapture.findMany({
      where: {
        operatorRollLineId: { in: lineIds },
        createdAt: { lte: generatedAt },
      },
      select: payrollCaptureSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async loadStockMaterialKinds(
    drafts: readonly PayrollFactDraft[],
    client: DirectorPayrollFactsClient,
  ): Promise<Map<string, { id: string; name: string; kind: string }>> {
    const materialIds = [
      ...new Set(
        drafts.flatMap(({ directMaterialId }) =>
          directMaterialId === null ? [] : [directMaterialId],
        ),
      ),
    ].sort();
    const rows = (
      await Promise.all(
        chunks(materialIds).map((materialIdChunk) =>
          client.rawMaterialStock.findMany({
            where: { materialId: { in: materialIdChunk } },
            select: {
              materialId: true,
              rawMaterialDefinition: { select: { id: true, name: true, kind: true } },
            },
            orderBy: { materialId: 'asc' },
          }),
        ),
      )
    ).flat();
    return new Map(
      rows.flatMap(({ materialId, rawMaterialDefinition }) =>
        rawMaterialDefinition === null ? [] : [[materialId, rawMaterialDefinition] as const],
      ),
    );
  }

  private async loadDefinitionKinds(
    drafts: readonly PayrollFactDraft[],
    stockKinds: ReadonlyMap<string, { id: string; name: string; kind: string }>,
    client: DirectorPayrollFactsClient,
  ): Promise<Map<string, { name: string; kind: string }>> {
    const stockDefinitionIds = new Set([...stockKinds.values()].map(({ id }) => id));
    const definitionIds = [...new Set(drafts.flatMap(({ recipeDefinitionIds: ids }) => ids))]
      .filter((id) => !stockDefinitionIds.has(id))
      .sort();
    const rows = (
      await Promise.all(
        chunks(definitionIds).map((definitionIdChunk) =>
          client.rawMaterialDefinition.findMany({
            where: { id: { in: definitionIdChunk } },
            select: { id: true, name: true, kind: true },
            orderBy: { id: 'asc' },
          }),
        ),
      )
    ).flat();
    return new Map(rows.map(({ id, name, kind }) => [id, { name, kind }]));
  }

  private async enrichMaterials(
    drafts: readonly PayrollFactDraft[],
    client: DirectorPayrollFactsClient,
  ): Promise<void> {
    const definitionsByStockMaterialId = await this.loadStockMaterialKinds(drafts, client);
    const definitionsById = await this.loadDefinitionKinds(
      drafts,
      definitionsByStockMaterialId,
      client,
    );
    const stockDefinitionsById = new Map(
      [...definitionsByStockMaterialId.values()].map((definition) => [definition.id, definition]),
    );

    for (const draft of drafts) {
      const direct =
        draft.directMaterialId === null
          ? undefined
          : definitionsByStockMaterialId.get(draft.directMaterialId);
      const components =
        draft.recipeComponents.length > 0
          ? draft.recipeComponents.flatMap((component) => {
              const definition =
                definitionsById.get(component.rawMaterialDefinitionId) ??
                stockDefinitionsById.get(component.rawMaterialDefinitionId);
              return definition === undefined || typeof definition.name !== 'string'
                ? []
                : [
                    {
                      rawMaterialDefinitionId: component.rawMaterialDefinitionId,
                      name: definition.name,
                      shareBasisPoints: component.shareBasisPoints,
                    },
                  ];
            })
          : direct && typeof direct.name === 'string'
            ? [
                {
                  rawMaterialDefinitionId: direct.id,
                  name: direct.name,
                  shareBasisPoints: 10_000,
                },
              ]
            : [];
      const expectedComponentCount =
        draft.recipeComponents.length > 0 ? draft.recipeComponents.length : direct ? 1 : 0;
      draft.fact.materialComponents =
        components.length === expectedComponentCount ? components : [];

      const kinds: DirectorPayrollMaterialClass[] = [];
      if (direct !== undefined) {
        const materialClass = payrollMaterialClass(direct.id, direct.kind);
        if (materialClass !== undefined && !kinds.includes(materialClass)) {
          kinds.push(materialClass);
        }
      }
      for (const definitionId of draft.recipeDefinitionIds) {
        const definition =
          definitionsById.get(definitionId) ?? stockDefinitionsById.get(definitionId);
        if (definition === undefined) continue;
        const materialClass = payrollMaterialClass(definitionId, definition.kind);
        if (materialClass !== undefined && !kinds.includes(materialClass)) {
          kinds.push(materialClass);
        }
      }
      draft.fact.materialKinds = kinds;
    }
  }
}
