import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  calculateRollProductionCost,
  normalizeSpoolTypeLabel,
  normalizeSpoolTypeKey,
  selectEffectiveMaterialPrice,
  type AdditionalCostInput,
  type EffectiveSpoolPrice,
  type PositionObservedMaterialBasis,
  type ProductionCostMaterialBasis,
  type RollProductionCostCalculation,
  type RollProductionCostCalculationInput,
} from '../../common/production-cost/production-cost-calculator';
import {
  resolveProductionOrderCostAllocation,
  type ProductionOrderCostAllocationResult,
  type ProductionOrderCostAllocationRoll,
} from '../../common/production-cost/production-order-cost-allocation';
import type { ProductionCostSourceSnapshotInput } from '../../common/production-cost/production-cost-source-snapshot';
import {
  resolveShiftBigBagMaterialBatch,
  type ShiftBigBagMaterialBatchResult,
} from '../../common/production-cost/shift-bigbag-material-batch';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  PayrollTariffOrderRepository,
  type PayrollTariffSchedule,
} from '../../common/payroll-tariffs/payroll-tariff-order.repository';
import { PayrollTariffResolver } from '../../common/payroll-tariffs/payroll-tariff-resolver';
import { resolveCanonicalShiftBagUsageFacts } from '../../common/shift-bag/canonical-shift-bag-episodes';
import {
  DirectorPayrollFactsService,
  type DirectorPayrollProductionFact,
} from './director-payroll-facts.service';
import {
  evaluateRollProductionCostEligibility,
  type RollProductionCostEligibilityFact,
} from './roll-production-cost-eligibility';
import type {
  PreparedRollProductionCost,
  RollProductionCostAssemblerPort,
} from './roll-production-cost-snapshot.service';

const QUERY_CHUNK_SIZE = 500;
const MAX_OBSERVED_SPOOL_TYPES = 500;

type RollRow = {
  id: string;
  productionOrderId: string;
  orderLineId: string | null;
  status: string;
  completedAt: Date | null;
  plannedWeightKg: number | null;
  widthMm: number | null;
  characteristicsSnapshot: Prisma.JsonValue | null;
};

type OrderRollRow = {
  id: string;
  productionOrderId: string;
  status: string;
  replacementAttempt: { id: string } | null;
  operatorLine: { defects: Array<{ id: string }> } | null;
};

type PositionRow = { id: string; spoolType: string | null };
type MaterialDefinitionRow = { id: string; name: string };
type MaterialPriceRow = {
  id: string;
  rawMaterialDefinitionId: string;
  priceKopecksPerKg: number;
  source: string;
  effectiveFrom: Date;
};
type ObservedMaterialSnapshotRow = {
  id: string;
  rollDispatchItemId: string;
  version: number;
  basisWeightGrams: number;
  materialAmountKopecks: bigint | null;
  rollDispatchItem: { orderLineId: string | null };
};
type SpoolPriceRow = {
  id: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  priceKopecksPerMeter: bigint;
  source: string;
  effectiveFrom: Date;
};
type ShiftUsageRow = {
  id: string;
  sessionId: string;
  startKg: number;
  endKg: number | null;
  closedAt: Date | null;
  releasedReason: string | null;
  episodes: Array<{
    sequence: number;
    startKg: number;
    endKg: number | null;
    closeKind: string | null;
    closedAt: Date | null;
  }>;
  bigBag: {
    id: string;
    code: string;
    material: string;
    baseRawMaterialDefinitionId: string | null;
    priceKopecksPerKg: number | null;
    priceSource: string | null;
    priceEffectiveAt: Date | null;
    createdAt: Date;
  };
};
type AdditionalCostRow = {
  id: string;
  rollDispatchItemId: string | null;
  productionOrderId: string | null;
  allocationBasis: string;
  amountKopecks: number;
  source: string;
  effectiveAt: Date;
  reason: string;
};

type RecipeComponent = {
  rawMaterialDefinitionId: string;
  name: string;
  shareBasisPoints: number;
};

type MaterialPreparation = {
  basis: ProductionCostMaterialBasis;
  unresolvedProvenance?: Extract<
    ProductionCostSourceSnapshotInput['material'],
    { kind: 'unresolved' }
  >;
};

type UnresolvedAdditionalSnapshot = Extract<
  ProductionCostSourceSnapshotInput['additional'][number],
  { kind: 'unresolved' }
>;

type AdditionalPreparation = {
  inputs: AdditionalCostInput[];
  unresolvedSnapshots: UnresolvedAdditionalSnapshot[];
};

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_CHUNK_SIZE) {
    result.push(values.slice(index, index + QUERY_CHUNK_SIZE));
  }
  return result;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function finiteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function kilogramsToGrams(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const grams = Math.round(value * 1_000);
  return Number.isSafeInteger(grams) && grams > 0 ? grams : null;
}

function kilogramsToPossiblyInvalidGrams(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.NaN;
  const grams = Math.round(value * 1_000);
  return Number.isSafeInteger(grams) ? grams : Number.NaN;
}

function millimetersToMicrometers(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const micrometers = Math.round(value * 1_000);
  return Number.isSafeInteger(micrometers) && micrometers > 0 ? micrometers : null;
}

function safeBigInt(value: bigint): number | null {
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function snapshotText(snapshot: Prisma.JsonValue | null, key: string): string | null {
  if (!isRecord(snapshot)) return null;
  const value = snapshot[key];
  return nonBlank(value) ? value : null;
}

function snapshotWidthMicrometers(snapshot: Prisma.JsonValue | null): number | null {
  if (!isRecord(snapshot)) return null;
  const value = snapshot.widthMm;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const result = Math.round(value * 1_000);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function snapshotRecipeIds(
  snapshot: Prisma.JsonValue | null,
): Array<{ rawMaterialDefinitionId: string; shareBasisPoints: number }> {
  if (!isRecord(snapshot) || !isRecord(snapshot.recipe)) return [];
  const ingredients = snapshot.recipe.ingredients;
  if (!Array.isArray(ingredients) || ingredients.length === 0) return [];
  const result: Array<{ rawMaterialDefinitionId: string; shareBasisPoints: number }> = [];
  const ids = new Set<string>();
  for (const ingredient of ingredients) {
    if (!isRecord(ingredient)) return [];
    const rawMaterialDefinitionId = ingredient.rawMaterialDefinitionId;
    const shareBasisPoints = ingredient.shareBasisPoints;
    if (
      !nonBlank(rawMaterialDefinitionId) ||
      ids.has(rawMaterialDefinitionId) ||
      typeof shareBasisPoints !== 'number' ||
      !Number.isSafeInteger(shareBasisPoints) ||
      shareBasisPoints <= 0 ||
      shareBasisPoints > 10_000
    ) {
      return [];
    }
    ids.add(rawMaterialDefinitionId);
    result.push({ rawMaterialDefinitionId, shareBasisPoints });
  }
  return result.reduce((sum, component) => sum + component.shareBasisPoints, 0) === 10_000
    ? result
    : [];
}

function validComponents(components: readonly RecipeComponent[]): boolean {
  return (
    components.length > 0 &&
    new Set(components.map(({ rawMaterialDefinitionId }) => rawMaterialDefinitionId)).size ===
      components.length &&
    components.every(
      ({ rawMaterialDefinitionId, name, shareBasisPoints }) =>
        nonBlank(rawMaterialDefinitionId) &&
        nonBlank(name) &&
        Number.isSafeInteger(shareBasisPoints) &&
        shareBasisPoints > 0 &&
        shareBasisPoints <= 10_000,
    ) &&
    components.reduce((sum, component) => sum + component.shareBasisPoints, 0) === 10_000
  );
}

function isFinishedGood(fact: DirectorPayrollProductionFact): boolean {
  return (
    kilogramsToGrams(fact.actualKg) !== null &&
    nonBlank(fact.canonicalCaptureId) &&
    nonBlank(fact.rootCaptureId) &&
    !fact.hasDefect &&
    fact.operatorStep === 'warehouse' &&
    (fact.dispatchStatus === 'ready_for_warehouse' || fact.dispatchStatus === 'done')
  );
}

function shiftPostKey(fact: DirectorPayrollProductionFact): string | null {
  return fact.shift && fact.post ? `${fact.shift.id}\u0000${fact.post.id}` : null;
}

function firstFactsByRoll(
  facts: readonly DirectorPayrollProductionFact[],
): Map<string, DirectorPayrollProductionFact> {
  const grouped = new Map<string, DirectorPayrollProductionFact[]>();
  for (const fact of facts) {
    const current = grouped.get(fact.rollId);
    if (current) current.push(fact);
    else grouped.set(fact.rollId, [fact]);
  }
  return new Map(
    [...grouped]
      .filter(([, candidates]) => {
        const signatures = new Set(
          candidates.map((candidate) =>
            JSON.stringify({
              canonicalCaptureId: candidate.canonicalCaptureId ?? null,
              rootCaptureId: candidate.rootCaptureId ?? null,
              actualKg: candidate.actualKg,
              producedAt: candidate.producedAt.toISOString(),
              rootSessionId: candidate.rootSessionId,
            }),
          ),
        );
        return signatures.size === 1;
      })
      .map(([rollId, candidates]) => [rollId, candidates[0]]),
  );
}

function payrollInput(
  schedule: PayrollTariffSchedule,
  resolver: PayrollTariffResolver,
  fact: DirectorPayrollProductionFact | undefined,
  shiftOutputKg: number,
  weightGrams: number | null,
  materialNames: readonly string[],
  openSessionEndedAt: Date | null = null,
): RollProductionCostCalculationInput['payroll'] {
  if (!fact || weightGrams === null) return null;
  const provisionalOpenSession =
    fact.rootSessionStatus === 'active' && finiteDate(openSessionEndedAt);
  const operatorWorkCompleted =
    fact.rootSessionStatus === 'closed' &&
    finiteDate(fact.rootSessionEndedAt) &&
    fact.machineAssignment?.status === 'completed';
  if (
    fact.operatorId === null ||
    !nonBlank(fact.operatorName) ||
    !nonBlank(fact.rootSessionId) ||
    fact.shift === null ||
    fact.post === null ||
    (fact.shift.status !== 'closed' && !operatorWorkCompleted && !provisionalOpenSession)
  ) {
    return null;
  }
  const resolution = resolver.resolveRoll(schedule, {
    producedAt: fact.producedAt,
    postName: fact.post.name,
    shiftStartedAt: fact.rootSessionStartedAt ?? null,
    shiftEndedAt: fact.rootSessionEndedAt ?? (provisionalOpenSession ? openSessionEndedAt : null),
    shiftOutputGrams: kilogramsToPossiblyInvalidGrams(shiftOutputKg),
    rollGrams: weightGrams,
    materialNames,
    birka: fact.birka,
    filmType: fact.filmType,
    counterpartyLegalName: fact.counterpartyLegalName,
  });
  if (resolution.kind === 'unresolved') return null;
  return {
    tariffOrderId: resolution.tariffOrder.id,
    tariffOrderName: resolution.tariffOrder.name,
    effectiveFrom: new Date(`${resolution.tariffOrder.effectiveFrom}T00:00:00+03:00`),
    rateKopecksPerKg: resolution.rateKopecksPerKg,
    basisLabel: resolution.basisLabel,
  };
}

function spoolInput(
  label: string | null,
  knownTypeLabels: readonly string[],
  widthMicrometers: number | null,
  prices: readonly EffectiveSpoolPrice[],
): RollProductionCostCalculationInput['spool'] {
  return { label, knownTypeLabels: [...knownTypeLabels], widthMicrometers, prices: [...prices] };
}

function eligibilityFact(fact: DirectorPayrollProductionFact): RollProductionCostEligibilityFact {
  return {
    canonicalCaptureId: fact.canonicalCaptureId ?? null,
    canonicalCaptureIsLeaf: nonBlank(fact.canonicalCaptureId) && nonBlank(fact.rootCaptureId),
    basisWeightGrams: kilogramsToGrams(fact.actualKg),
    producedAt: finiteDate(fact.producedAt) ? fact.producedAt : null,
    hasDefect: fact.hasDefect,
    operatorStep: fact.operatorStep,
    dispatchStatus: fact.dispatchStatus,
    dispatchCompletedAt: fact.dispatchCompletedAt ?? null,
    rootPostSessionId: fact.rootSessionId,
    rootPostSessionStatus: fact.rootSessionStatus ?? null,
    rootPostSessionEndedAt: fact.rootSessionEndedAt ?? null,
    machineAssignmentId: fact.machineAssignment?.id ?? null,
    machineAssignmentStatus: fact.machineAssignment?.status ?? null,
    shiftId: fact.shift?.id ?? null,
    shiftStatus: fact.shift?.status ?? null,
    shiftEndedAt: fact.shift?.endedAt ?? null,
  };
}

function unresolvedRecipeProvenance(
  reason: 'material_usage_unresolved' | 'material_price_unresolved',
  components: readonly RecipeComponent[],
  pricesByDefinition: ReadonlyMap<string, readonly MaterialPriceRow[]>,
): Extract<ProductionCostSourceSnapshotInput['material'], { kind: 'unresolved' }> {
  return {
    kind: 'unresolved',
    reason,
    sources: components.map(({ rawMaterialDefinitionId }) => ({
      usageId: null,
      bigBagId: null,
      materialDefinitionId: rawMaterialDefinitionId,
    })),
    safeInputFingerprint: requestFingerprint({
      components: components.map((component) => ({
        ...component,
        prices: (pricesByDefinition.get(component.rawMaterialDefinitionId) ?? []).map((price) => ({
          id: price.id,
          priceKopecksPerKg: price.priceKopecksPerKg,
          source: price.source,
          effectiveFrom: price.effectiveFrom.toISOString(),
        })),
      })),
    }),
  };
}

function materialFromRecipe(
  components: readonly RecipeComponent[],
  pricesByDefinition: ReadonlyMap<string, readonly MaterialPriceRow[]>,
): MaterialPreparation {
  if (!validComponents(components)) {
    return {
      basis: { kind: 'unresolved', reason: 'material_usage_unresolved' },
      unresolvedProvenance: unresolvedRecipeProvenance(
        'material_usage_unresolved',
        components,
        pricesByDefinition,
      ),
    };
  }
  return {
    basis: {
      kind: 'recipe_reference',
      components: components.map((component) => ({
        rawMaterialDefinitionId: component.rawMaterialDefinitionId,
        label: component.name,
        shareBasisPoints: component.shareBasisPoints,
        prices: [...(pricesByDefinition.get(component.rawMaterialDefinitionId) ?? [])],
      })),
    },
  };
}

function observedPositionMaterialRates(
  rows: readonly ObservedMaterialSnapshotRow[],
): Map<string, PositionObservedMaterialBasis> {
  const latestByRoll = new Map<string, ObservedMaterialSnapshotRow>();
  for (const row of [...rows].sort(
    (left, right) =>
      left.rollDispatchItemId.localeCompare(right.rollDispatchItemId) ||
      right.version - left.version ||
      right.id.localeCompare(left.id),
  )) {
    if (!latestByRoll.has(row.rollDispatchItemId)) latestByRoll.set(row.rollDispatchItemId, row);
  }
  const grouped = new Map<
    string,
    { amountKopecks: bigint; weightGrams: bigint; snapshots: ObservedMaterialSnapshotRow[] }
  >();
  for (const row of latestByRoll.values()) {
    const positionId = row.rollDispatchItem.orderLineId;
    if (
      !nonBlank(positionId) ||
      !Number.isSafeInteger(row.basisWeightGrams) ||
      row.basisWeightGrams <= 0 ||
      row.materialAmountKopecks === null ||
      row.materialAmountKopecks <= 0n
    ) {
      continue;
    }
    const current = grouped.get(positionId) ?? {
      amountKopecks: 0n,
      weightGrams: 0n,
      snapshots: [],
    };
    current.amountKopecks += row.materialAmountKopecks;
    current.weightGrams += BigInt(row.basisWeightGrams);
    current.snapshots.push(row);
    grouped.set(positionId, current);
  }
  const result = new Map<string, PositionObservedMaterialBasis>();
  for (const [positionId, group] of grouped) {
    const observedMaterialAmountKopecks = safeBigInt(group.amountKopecks);
    const observedWeightGrams = safeBigInt(group.weightGrams);
    if (observedMaterialAmountKopecks === null || observedWeightGrams === null) continue;
    const snapshots = group.snapshots
      .map((row) => ({
        id: row.id,
        version: row.version,
        basisWeightGrams: row.basisWeightGrams,
        materialAmountKopecks: (row.materialAmountKopecks as bigint).toString(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    result.set(positionId, {
      kind: 'position_observed_rate',
      sourceFingerprint: requestFingerprint({ positionId, snapshots }),
      sourceSnapshotCount: snapshots.length,
      observedWeightGrams,
      observedMaterialAmountKopecks,
    });
  }
  return result;
}

function unresolvedMeasuredMaterial(
  result: Extract<ShiftBigBagMaterialBatchResult, { kind: 'unresolved' }>,
): MaterialPreparation {
  const reason =
    result.reason === 'material_price_unresolved'
      ? 'material_price_unresolved'
      : 'material_usage_unresolved';
  return {
    basis: { kind: 'unresolved', reason },
    unresolvedProvenance: {
      kind: 'unresolved',
      reason,
      sources: result.observedSources,
      safeInputFingerprint: result.safeInputFingerprint,
    },
  };
}

function materialSnapshot(
  preparation: MaterialPreparation,
  calculation: RollProductionCostCalculation,
): ProductionCostSourceSnapshotInput['material'] {
  if (preparation.unresolvedProvenance) return preparation.unresolvedProvenance;
  if (preparation.basis.kind === 'unresolved') {
    return {
      kind: 'unresolved',
      reason: preparation.basis.reason,
      sources: [],
      safeInputFingerprint: requestFingerprint(preparation.basis),
    };
  }
  if (preparation.basis.kind === 'shift_bigbag_allocation') {
    return {
      kind: 'shift_bigbag_allocation',
      sources: preparation.basis.sources.map((source) => ({
        kind: 'shift_bigbag_allocation',
        usageId: source.usageId,
        bigBagId: source.bigBagId,
        materialDefinitionId: source.materialDefinitionId ?? null,
        label: source.label,
        totalConsumedGrams: source.totalConsumedGrams,
        totalAmountKopecks: source.totalAmountKopecks,
        priceKopecksPerKg: source.priceKopecksPerKg,
        effectiveAt: source.effectiveAt,
        denominator: source.denominator,
        denominatorFingerprint: source.denominatorFingerprint,
      })),
    };
  }
  if (preparation.basis.kind === 'position_observed_rate') {
    throw new RangeError('position-observed material is provisional and cannot be persisted');
  }
  const sources = calculation.materialSources.filter(
    (source) => source.kind === 'recipe_reference',
  );
  if (sources.length !== preparation.basis.components.length) {
    const reason = calculation.unresolvedReasons.includes('material_price_unresolved')
      ? 'material_price_unresolved'
      : 'material_usage_unresolved';
    return {
      kind: 'unresolved',
      reason,
      sources: preparation.basis.components.map(({ rawMaterialDefinitionId }) => ({
        usageId: null,
        bigBagId: null,
        materialDefinitionId: rawMaterialDefinitionId,
      })),
      safeInputFingerprint: requestFingerprint({
        reason,
        components: preparation.basis.components.map((component) => ({
          rawMaterialDefinitionId: component.rawMaterialDefinitionId,
          label: component.label,
          shareBasisPoints: component.shareBasisPoints,
          prices: component.prices.map((price) => ({
            ...price,
            effectiveFrom: price.effectiveFrom.toISOString(),
          })),
        })),
      }),
    };
  }
  return {
    kind: 'recipe_reference',
    sources: sources.map((source) => ({
      kind: 'recipe_reference',
      sourceId: source.sourceId,
      materialDefinitionId: source.rawMaterialDefinitionId,
      label: source.label,
      componentGrams: source.componentGrams,
      shareBasisPoints: source.shareBasisPoints,
      priceKopecksPerKg: source.priceKopecksPerKg,
      effectiveAt: source.effectiveFrom,
      allocatedAmountKopecks: source.allocatedAmountKopecks,
    })),
  };
}

function additionalSnapshot(
  calculation: RollProductionCostCalculation,
  unresolved: readonly UnresolvedAdditionalSnapshot[],
): ProductionCostSourceSnapshotInput['additional'] {
  const resolved: ProductionCostSourceSnapshotInput['additional'] =
    calculation.additionalSources.map((source) =>
      source.kind === 'direct'
        ? {
            kind: 'direct',
            sourceId: source.id,
            source: source.source,
            reason: source.reason,
            effectiveAt: source.effectiveAt,
            allocatedAmountKopecks: source.allocatedAmountKopecks,
          }
        : {
            kind: 'order_allocation',
            sourceId: source.id,
            source: source.source,
            reason: source.reason,
            effectiveAt: source.effectiveAt,
            productionOrderId: source.productionOrderId,
            rollDispatchItemId: source.rollDispatchItemId,
            totalAmountKopecks: source.totalAmountKopecks,
            denominator: source.denominator,
            denominatorFingerprint: source.denominatorFingerprint,
            sealProof: source.sealProof,
            sealFingerprint: source.sealFingerprint,
          },
    );
  return [...resolved, ...unresolved].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
}

function unresolvedOrderSnapshot(
  cost: AdditionalCostRow,
  result: Extract<ProductionOrderCostAllocationResult, { kind: 'unresolved' }>,
): UnresolvedAdditionalSnapshot {
  return {
    kind: 'unresolved',
    sourceId: cost.id,
    productionOrderId: cost.productionOrderId as string,
    source: cost.source,
    reason: cost.reason,
    effectiveAt: cost.effectiveAt,
    unresolvedReason: result.reason,
    observedRollIds: result.observedRollIds,
    safeInputFingerprint: result.safeInputFingerprint,
  };
}

@Injectable()
export class RollProductionCostAssemblerService implements RollProductionCostAssemblerPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: DirectorPayrollFactsService,
    private readonly tariffOrders: PayrollTariffOrderRepository,
    private readonly tariffResolver: PayrollTariffResolver,
  ) {}

  async prepare(
    rollDispatchItemIds: readonly string[],
    generatedAt: Date,
  ): Promise<Map<string, PreparedRollProductionCost>> {
    const ids = unique(rollDispatchItemIds.filter(nonBlank));
    if (ids.length === 0) return new Map();
    if (!finiteDate(generatedAt)) throw new RangeError('generatedAt must be a finite date');

    const [rollRows, requestedFacts] = await Promise.all([
      this.loadRolls(ids),
      this.facts.loadForRollDispatchItems(ids, generatedAt),
    ]);
    const maxPayrollBasisMs = requestedFacts.reduce(
      (max, fact) => Math.max(max, fact.producedAt.getTime()),
      Number.NEGATIVE_INFINITY,
    );
    const payrollSchedule = Number.isFinite(maxPayrollBasisMs)
      ? await this.tariffOrders.loadPublishedSchedule(new Date(maxPayrollBasisMs))
      : [];
    const rollById = new Map(rollRows.map((row) => [row.id, row]));
    const requestedFactByRoll = firstFactsByRoll(requestedFacts);
    const productionOrderIds = unique(rollRows.map(({ productionOrderId }) => productionOrderId));
    const positionIds = unique(
      rollRows.flatMap(({ orderLineId }) => (orderLineId === null ? [] : [orderLineId])),
    );
    const shiftPostPairs = unique(
      requestedFacts.flatMap((fact) => {
        const key = shiftPostKey(fact);
        return key === null ? [] : [key];
      }),
    );

    const [positions, orderFacts, relatedSessions, knownSpoolLabels] = await Promise.all([
      this.loadPositions(positionIds),
      this.facts.loadForProductionOrders(productionOrderIds, generatedAt),
      this.loadRelatedSessions(shiftPostPairs),
      this.loadKnownSpoolLabels(),
    ]);
    const requestedSessionIds = unique(
      requestedFacts.flatMap(({ rootSessionId }) => (rootSessionId ? [rootSessionId] : [])),
    );
    const payrollSessionIds = unique([
      ...requestedSessionIds,
      ...relatedSessions.map(({ id }) => id),
    ]);
    const [loadedSessionFacts, usageRows] = await Promise.all([
      this.facts.loadForRootSessions(payrollSessionIds, generatedAt),
      this.loadShiftUsages(requestedSessionIds),
    ]);
    const sessionFacts = [...firstFactsByRoll([...loadedSessionFacts, ...requestedFacts]).values()];
    const allOrderFacts = [...firstFactsByRoll([...orderFacts, ...requestedFacts]).values()];

    const recipeSeedsByRoll = new Map(
      rollRows.map((roll) => [roll.id, snapshotRecipeIds(roll.characteristicsSnapshot)]),
    );
    const definitionIds = unique([
      ...requestedFacts.flatMap((fact) =>
        (fact.materialComponents ?? []).map(
          ({ rawMaterialDefinitionId }) => rawMaterialDefinitionId,
        ),
      ),
      ...[...recipeSeedsByRoll.values()].flatMap((components) =>
        components.map(({ rawMaterialDefinitionId }) => rawMaterialDefinitionId),
      ),
      ...usageRows.flatMap(({ bigBag }) =>
        bigBag.baseRawMaterialDefinitionId === null ? [] : [bigBag.baseRawMaterialDefinitionId],
      ),
    ]);
    const positionById = new Map(positions.map((position) => [position.id, position]));
    const spoolTypeKeys = unique(knownSpoolLabels.map(normalizeSpoolTypeKey));

    const [definitions, materialPrices, spoolPrices, orderCostBasis, observedMaterialSnapshots] =
      await Promise.all([
        this.loadMaterialDefinitions(definitionIds),
        this.loadMaterialPrices(definitionIds, generatedAt),
        this.loadSpoolPrices(spoolTypeKeys, generatedAt),
        this.loadLockedOrderCostBasis(ids, productionOrderIds, generatedAt, allOrderFacts),
        this.loadObservedMaterialSnapshots(positionIds, generatedAt),
      ]);
    const { additionalRows, orderAllocationByCost } = orderCostBasis;
    const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
    const pricesByDefinition = new Map<string, MaterialPriceRow[]>();
    for (const price of materialPrices) {
      const current = pricesByDefinition.get(price.rawMaterialDefinitionId);
      if (current) current.push(price);
      else pricesByDefinition.set(price.rawMaterialDefinitionId, [price]);
    }
    const effectiveSpoolPrices = spoolPrices.flatMap((price): EffectiveSpoolPrice[] => {
      const amount = safeBigInt(price.priceKopecksPerMeter);
      return amount === null ? [] : [{ ...price, priceKopecksPerMeter: amount }];
    });
    const observedMaterialByPosition = observedPositionMaterialRates(observedMaterialSnapshots);
    const componentsByRoll = new Map<string, RecipeComponent[]>();
    for (const roll of rollRows) {
      const factComponents = requestedFactByRoll.get(roll.id)?.materialComponents ?? [];
      if (factComponents.length > 0) {
        componentsByRoll.set(roll.id, [...factComponents]);
        continue;
      }
      componentsByRoll.set(
        roll.id,
        (recipeSeedsByRoll.get(roll.id) ?? []).map((component) => {
          const definition = definitionById.get(component.rawMaterialDefinitionId);
          return { ...component, name: definition?.name ?? '' };
        }),
      );
    }

    const measuredByRoll = this.resolveMeasuredMaterials(
      requestedFacts,
      sessionFacts,
      usageRows,
      pricesByDefinition,
    );
    const thresholdKg = this.thresholdKg(sessionFacts);
    const payrollMaterialNamesBySession = new Map<string, string[]>();
    for (const usage of usageRows) {
      const names = payrollMaterialNamesBySession.get(usage.sessionId) ?? [];
      names.push(usage.bigBag.material);
      payrollMaterialNamesBySession.set(usage.sessionId, names);
    }

    const result = new Map<string, PreparedRollProductionCost>();
    for (const id of ids) {
      const roll = rollById.get(id);
      if (!roll) continue;
      const fact = requestedFactByRoll.get(id);
      const plannedWeightGrams = kilogramsToGrams(roll.plannedWeightKg);
      const components = componentsByRoll.get(id) ?? [];
      const recipeMaterial = () => materialFromRecipe(components, pricesByDefinition);
      const label =
        snapshotText(roll.characteristicsSnapshot, 'spoolType') ??
        (roll.orderLineId === null
          ? null
          : (positionById.get(roll.orderLineId)?.spoolType ?? null)) ??
        fact?.spoolType ??
        null;
      const widthMicrometers =
        snapshotWidthMicrometers(roll.characteristicsSnapshot) ??
        millimetersToMicrometers(roll.widthMm) ??
        fact?.widthMicrometers ??
        null;
      const key = fact ? shiftPostKey(fact) : null;
      const shiftOutputKg = key === null ? 0 : (thresholdKg.get(key) ?? 0);
      const payrollMaterialNames = fact
        ? (payrollMaterialNamesBySession.get(fact.rootSessionId ?? '') ??
          (fact.materialComponents ?? []).map(({ name }) => name))
        : [];
      const plannedAdditional = this.additionalForRoll(
        roll,
        generatedAt,
        plannedWeightGrams,
        additionalRows,
        orderAllocationByCost,
        true,
      );
      const plannedInput =
        plannedWeightGrams === null
          ? null
          : ({
              basis: { kind: 'planned', weightGrams: plannedWeightGrams },
              producedAt: generatedAt,
              materialBasis: recipeMaterial().basis,
              spool: spoolInput(label, knownSpoolLabels, widthMicrometers, effectiveSpoolPrices),
              payroll: payrollInput(
                payrollSchedule,
                this.tariffResolver,
                fact,
                shiftOutputKg,
                plannedWeightGrams,
                payrollMaterialNames,
              ),
              additionalCosts: plannedAdditional.inputs,
            } satisfies RollProductionCostCalculationInput);

      if (!fact) {
        result.set(id, {
          rollDispatchItemId: id,
          eligibility: null,
          actualInput: null,
          pendingInput: null,
          plannedInput,
          sourceSnapshot: null,
        });
        continue;
      }

      const actualWeightGrams = kilogramsToGrams(fact.actualKg);
      const actualMaterial = measuredByRoll.get(id) ?? recipeMaterial();
      const actualAdditional = this.additionalForRoll(
        roll,
        fact.producedAt,
        actualWeightGrams,
        additionalRows,
        orderAllocationByCost,
        false,
      );
      const actualInput: RollProductionCostCalculationInput = {
        basis: { kind: 'actual', weightGrams: actualWeightGrams },
        producedAt: fact.producedAt,
        materialBasis: actualMaterial.basis,
        spool: spoolInput(label, knownSpoolLabels, widthMicrometers, effectiveSpoolPrices),
        payroll: payrollInput(
          payrollSchedule,
          this.tariffResolver,
          fact,
          shiftOutputKg,
          actualWeightGrams,
          payrollMaterialNames,
        ),
        additionalCosts: actualAdditional.inputs,
      };
      const pendingMaterialCandidate =
        actualMaterial.basis.kind === 'unresolved' ? recipeMaterial() : actualMaterial;
      const pendingMaterial =
        calculateRollProductionCost({
          ...actualInput,
          materialBasis: pendingMaterialCandidate.basis,
        }).materialAmountKopecks === null && roll.orderLineId !== null
          ? (observedMaterialByPosition.get(roll.orderLineId) ?? pendingMaterialCandidate.basis)
          : pendingMaterialCandidate.basis;
      const pendingInput: RollProductionCostCalculationInput = {
        ...actualInput,
        materialBasis: pendingMaterial,
        payroll:
          actualInput.payroll ??
          payrollInput(
            payrollSchedule,
            this.tariffResolver,
            fact,
            shiftOutputKg,
            actualWeightGrams,
            payrollMaterialNames,
            generatedAt,
          ),
      };
      const eligibility = eligibilityFact(fact);
      const evaluated = evaluateRollProductionCostEligibility(eligibility);
      const sourceSnapshot = evaluated.eligible
        ? this.sourceSnapshot(
            roll,
            fact,
            actualInput,
            actualMaterial,
            actualAdditional.unresolvedSnapshots,
            evaluated.closedAt as Date,
          )
        : null;
      result.set(id, {
        rollDispatchItemId: id,
        eligibility,
        actualInput,
        pendingInput,
        plannedInput,
        sourceSnapshot,
      });
    }
    return result;
  }

  private async loadRolls(ids: readonly string[]): Promise<RollRow[]> {
    return (
      await Promise.all(
        chunks(ids).map((idChunk) =>
          this.prisma.rollDispatchItem.findMany({
            where: { id: { in: idChunk } },
            select: {
              id: true,
              productionOrderId: true,
              orderLineId: true,
              status: true,
              completedAt: true,
              plannedWeightKg: true,
              widthMm: true,
              characteristicsSnapshot: true,
            },
            orderBy: { id: 'asc' },
          }),
        ),
      )
    ).flat();
  }

  private async loadPositions(ids: readonly string[]): Promise<PositionRow[]> {
    return (
      await Promise.all(
        chunks(ids).map((idChunk) =>
          this.prisma.commercialOrderPosition.findMany({
            where: { id: { in: idChunk } },
            select: { id: true, spoolType: true },
            orderBy: { id: 'asc' },
          }),
        ),
      )
    ).flat();
  }

  private async loadKnownSpoolLabels(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ label: string }>>(Prisma.sql`
      SELECT label
      FROM (
        SELECT DISTINCT "spoolType" AS label
        FROM "commercial_order_positions"
        WHERE "spoolType" IS NOT NULL
        UNION
        SELECT DISTINCT "characteristicsSnapshot" ->> 'spoolType' AS label
        FROM "roll_dispatch_items"
        WHERE jsonb_typeof("characteristicsSnapshot") = 'object'
          AND jsonb_typeof("characteristicsSnapshot" -> 'spoolType') = 'string'
      ) observed_spool_types
      WHERE label IS NOT NULL
      ORDER BY label
      LIMIT ${MAX_OBSERVED_SPOOL_TYPES + 1}
    `);
    if (rows.length > MAX_OBSERVED_SPOOL_TYPES) return [];
    return unique(
      rows.flatMap(({ label }) => {
        if (typeof label !== 'string') return [];
        const normalized = normalizeSpoolTypeLabel(label);
        return normalized.length === 0 ? [] : [normalized];
      }),
    );
  }

  private async loadLockedOrderCostBasis(
    rollIds: readonly string[],
    productionOrderIds: readonly string[],
    generatedAt: Date,
    orderFacts: readonly DirectorPayrollProductionFact[],
  ): Promise<{
    additionalRows: AdditionalCostRow[];
    orderAllocationByCost: Map<string, ProductionOrderCostAllocationResult>;
  }> {
    const orderChunks = chunks(productionOrderIds);
    return this.prisma.$transaction(
      async (tx) => {
        for (const idChunk of orderChunks) {
          await tx.$queryRaw(
            Prisma.sql`
              SELECT "id"
              FROM "production_orders"
              WHERE "id" IN (${Prisma.join(idChunk)})
              ORDER BY "id"
              FOR UPDATE
            `,
          );
        }
        for (const idChunk of orderChunks) {
          await tx.$queryRaw(
            Prisma.sql`
              SELECT "id"
              FROM "roll_dispatch_items"
              WHERE "productionOrderId" IN (${Prisma.join(idChunk)})
              ORDER BY "id"
              FOR UPDATE
            `,
          );
        }
        const orderRollRows = (
          await Promise.all(
            orderChunks.map((idChunk) =>
              tx.rollDispatchItem.findMany({
                where: { productionOrderId: { in: idChunk } },
                select: {
                  id: true,
                  productionOrderId: true,
                  status: true,
                  replacementAttempt: { select: { id: true } },
                  operatorLine: {
                    select: {
                      defects: {
                        where: { createdAt: { lte: generatedAt } },
                        select: { id: true },
                      },
                    },
                  },
                },
                orderBy: { id: 'asc' },
              }),
            ),
          )
        ).flat();
        const additionalRows = await this.loadAdditionalCosts(
          tx,
          rollIds,
          productionOrderIds,
          generatedAt,
        );
        const allocationRolls = this.orderAllocationRolls(orderRollRows, orderFacts);
        return {
          additionalRows,
          orderAllocationByCost: this.resolveOrderAllocations(additionalRows, allocationRolls),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async loadRelatedSessions(keys: readonly string[]) {
    return (
      await Promise.all(
        chunks(keys).map((keyChunk) =>
          this.prisma.operatorPostSession.findMany({
            where: {
              OR: keyChunk.map((key) => {
                const [shiftId, postId] = key.split('\u0000');
                return { shiftId, postId };
              }),
            },
            select: { id: true, shiftId: true, postId: true },
            orderBy: { id: 'asc' },
          }),
        ),
      )
    ).flat();
  }

  private async loadMaterialDefinitions(
    definitionIds: readonly string[],
  ): Promise<MaterialDefinitionRow[]> {
    return (
      await Promise.all(
        chunks(definitionIds).map((idChunk) =>
          this.prisma.rawMaterialDefinition.findMany({
            where: { id: { in: idChunk } },
            select: { id: true, name: true },
            orderBy: { id: 'asc' },
          }),
        ),
      )
    ).flat();
  }

  private async loadMaterialPrices(
    definitionIds: readonly string[],
    generatedAt: Date,
  ): Promise<MaterialPriceRow[]> {
    return (
      await Promise.all(
        chunks(definitionIds).map((idChunk) =>
          this.prisma.materialPriceReference.findMany({
            where: {
              rawMaterialDefinitionId: { in: idChunk },
              effectiveFrom: { lte: generatedAt },
            },
            select: {
              id: true,
              rawMaterialDefinitionId: true,
              priceKopecksPerKg: true,
              source: true,
              effectiveFrom: true,
            },
            orderBy: [
              { rawMaterialDefinitionId: 'asc' },
              { effectiveFrom: 'desc' },
              { id: 'desc' },
            ],
          }),
        ),
      )
    ).flat();
  }

  private async loadObservedMaterialSnapshots(
    positionIds: readonly string[],
    generatedAt: Date,
  ): Promise<ObservedMaterialSnapshotRow[]> {
    return (
      await Promise.all(
        chunks(positionIds).map((idChunk) =>
          this.prisma.rollProductionCostSnapshot.findMany({
            where: {
              status: 'complete',
              materialAmountKopecks: { not: null },
              createdAt: { lte: generatedAt },
              rollDispatchItem: { orderLineId: { in: idChunk } },
            },
            select: {
              id: true,
              rollDispatchItemId: true,
              version: true,
              basisWeightGrams: true,
              materialAmountKopecks: true,
              rollDispatchItem: { select: { orderLineId: true } },
            },
            orderBy: [{ rollDispatchItemId: 'asc' }, { version: 'desc' }, { id: 'desc' }],
          }),
        ),
      )
    ).flat();
  }

  private async loadSpoolPrices(
    spoolTypeKeys: readonly string[],
    generatedAt: Date,
  ): Promise<SpoolPriceRow[]> {
    return (
      await Promise.all(
        chunks(spoolTypeKeys).map((keyChunk) =>
          this.prisma.spoolPriceReference.findMany({
            where: { spoolTypeKey: { in: keyChunk }, effectiveFrom: { lte: generatedAt } },
            select: {
              id: true,
              spoolTypeKey: true,
              spoolTypeLabel: true,
              priceKopecksPerMeter: true,
              source: true,
              effectiveFrom: true,
            },
            orderBy: [{ spoolTypeKey: 'asc' }, { effectiveFrom: 'desc' }, { id: 'desc' }],
          }),
        ),
      )
    ).flat();
  }

  private async loadShiftUsages(sessionIds: readonly string[]): Promise<ShiftUsageRow[]> {
    return (
      await Promise.all(
        chunks(sessionIds).map((idChunk) =>
          this.prisma.shiftBagUsage.findMany({
            where: { sessionId: { in: idChunk } },
            select: {
              id: true,
              sessionId: true,
              startKg: true,
              endKg: true,
              closedAt: true,
              releasedReason: true,
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
              bigBag: {
                select: {
                  id: true,
                  code: true,
                  material: true,
                  baseRawMaterialDefinitionId: true,
                  priceKopecksPerKg: true,
                  priceSource: true,
                  priceEffectiveAt: true,
                  createdAt: true,
                },
              },
            },
            orderBy: [{ sessionId: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
          }),
        ),
      )
    ).flat();
  }

  private async loadAdditionalCosts(
    client: Prisma.TransactionClient,
    rollIds: readonly string[],
    productionOrderIds: readonly string[],
    generatedAt: Date,
  ): Promise<AdditionalCostRow[]> {
    const rollChunks = chunks(rollIds);
    const orderChunks = chunks(productionOrderIds);
    const queryCount = Math.max(rollChunks.length, orderChunks.length);
    const queries = Array.from({ length: queryCount }, (_, index) => {
      const rollChunk = rollChunks[index] ?? [];
      const orderChunk = orderChunks[index] ?? [];
      return client.additionalProductionCost.findMany({
        where: {
          effectiveAt: { lte: generatedAt },
          OR: [
            ...(rollChunk.length > 0 ? [{ rollDispatchItemId: { in: rollChunk } }] : []),
            ...(orderChunk.length > 0 ? [{ productionOrderId: { in: orderChunk } }] : []),
          ],
        },
        select: {
          id: true,
          rollDispatchItemId: true,
          productionOrderId: true,
          allocationBasis: true,
          amountKopecks: true,
          source: true,
          effectiveAt: true,
          reason: true,
        },
        orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }],
      });
    });
    return (await Promise.all(queries)).flat();
  }

  private thresholdKg(facts: readonly DirectorPayrollProductionFact[]): Map<string, number> {
    const gramsByKey = new Map<string, number>();
    for (const fact of facts) {
      const key = shiftPostKey(fact);
      const grams = kilogramsToGrams(fact.actualKg);
      if (key === null || grams === null || !isFinishedGood(fact)) continue;
      gramsByKey.set(key, (gramsByKey.get(key) ?? 0) + grams);
    }
    return new Map([...gramsByKey].map(([key, grams]) => [key, grams / 1_000]));
  }

  private resolveMeasuredMaterials(
    requestedFacts: readonly DirectorPayrollProductionFact[],
    sessionFacts: readonly DirectorPayrollProductionFact[],
    usages: readonly ShiftUsageRow[],
    pricesByDefinition: ReadonlyMap<string, readonly MaterialPriceRow[]>,
  ): Map<string, MaterialPreparation> {
    const usagesBySession = new Map<string, ShiftUsageRow[]>();
    for (const usage of usages) {
      const current = usagesBySession.get(usage.sessionId);
      if (current) current.push(usage);
      else usagesBySession.set(usage.sessionId, [usage]);
    }
    const factsBySession = new Map<string, DirectorPayrollProductionFact[]>();
    for (const fact of sessionFacts) {
      if (!fact.rootSessionId) continue;
      const current = factsBySession.get(fact.rootSessionId);
      if (current) current.push(fact);
      else factsBySession.set(fact.rootSessionId, [fact]);
    }
    const result = new Map<string, MaterialPreparation>();
    const sessions = unique(
      requestedFacts.flatMap(({ rootSessionId }) => (rootSessionId ? [rootSessionId] : [])),
    );
    for (const sessionId of sessions) {
      const sessionUsages = usagesBySession.get(sessionId) ?? [];
      if (sessionUsages.length === 0) continue;
      const peers = (factsBySession.get(sessionId) ?? []).sort((left, right) =>
        left.rollId.localeCompare(right.rollId),
      );
      const scope = peers[0] ?? requestedFacts.find((fact) => fact.rootSessionId === sessionId);
      if (!scope) continue;
      const finishedPeers = peers.filter(isFinishedGood);
      const firstProducedAt = finishedPeers.reduce<Date | null>(
        (earliest, fact) =>
          earliest === null || fact.producedAt < earliest ? fact.producedAt : earliest,
        null,
      );
      const batch = resolveShiftBigBagMaterialBatch({
        rootSession: {
          id: sessionId,
          status: scope.rootSessionStatus ?? '',
          endedAt: scope.rootSessionEndedAt ?? null,
        },
        shift: {
          id: scope.shift?.id ?? '',
          status: scope.shift?.status ?? '',
          endedAt: scope.shift?.endedAt ?? null,
        },
        rolls: finishedPeers.map((fact) => ({
          rollDispatchItemId: fact.rollId,
          canonicalCaptureId: fact.canonicalCaptureId as string,
          weightGrams: kilogramsToGrams(fact.actualKg) as number,
          producedAt: fact.producedAt,
          isCanonicalLeaf: true,
          isFinishedGood: true,
        })),
        usages: sessionUsages.map((usage) => {
          const canonical = resolveCanonicalShiftBagUsageFacts(usage);
          const totalStartKg = canonical.episodes.reduce(
            (sum, episode) => sum + episode.startKg,
            0,
          );
          const aggregateEndKg =
            canonical.actualUsageKg === null ? null : totalStartKg - canonical.actualUsageKg;
          const materialDefinitionId = usage.bigBag.baseRawMaterialDefinitionId;
          const reference =
            usage.bigBag.priceKopecksPerKg === null &&
            materialDefinitionId !== null &&
            firstProducedAt !== null
              ? selectEffectiveMaterialPrice(
                  pricesByDefinition.get(materialDefinitionId) ?? [],
                  firstProducedAt,
                )
              : null;
          const priceSource = usage.bigBag.priceSource ?? reference?.source ?? null;
          return {
            usageId: usage.id,
            bigBagId: usage.bigBag.id,
            ...(usage.bigBag.baseRawMaterialDefinitionId === null
              ? {}
              : { materialDefinitionId: usage.bigBag.baseRawMaterialDefinitionId }),
            label: [usage.bigBag.code, usage.bigBag.material, priceSource]
              .filter(nonBlank)
              .join(' · '),
            startGrams: kilogramsToPossiblyInvalidGrams(totalStartKg),
            endGrams:
              aggregateEndKg === null ? null : kilogramsToPossiblyInvalidGrams(aggregateEndKg),
            priceKopecksPerKg:
              usage.bigBag.priceKopecksPerKg ?? reference?.priceKopecksPerKg ?? null,
            effectiveAt:
              usage.bigBag.priceKopecksPerKg === null
                ? (reference?.effectiveFrom ?? usage.bigBag.createdAt)
                : (usage.bigBag.priceEffectiveAt ?? usage.bigBag.createdAt),
          };
        }),
      });
      if (batch.kind === 'unresolved') {
        const unresolved = unresolvedMeasuredMaterial(batch);
        for (const fact of peers) result.set(fact.rollId, unresolved);
      } else if (batch.kind === 'resolved') {
        for (const roll of batch.rollBases) {
          result.set(roll.rollDispatchItemId, { basis: roll.materialBasis });
        }
      }
    }
    return result;
  }

  private orderAllocationRolls(
    rows: readonly OrderRollRow[],
    facts: readonly DirectorPayrollProductionFact[],
  ): Map<string, ProductionOrderCostAllocationRoll[]> {
    const factByRoll = firstFactsByRoll(facts);
    const byOrder = new Map<string, ProductionOrderCostAllocationRoll[]>();
    for (const row of rows) {
      const fact = factByRoll.get(row.id);
      const hasDefect = (row.operatorLine?.defects.length ?? 0) > 0 || fact?.hasDefect === true;
      const current = byOrder.get(row.productionOrderId) ?? [];
      current.push({
        rollDispatchItemId: row.id,
        status: hasDefect ? 'defect' : row.status,
        replacementAttemptId: row.replacementAttempt?.id ?? null,
        canonicalCaptureId: fact?.canonicalCaptureId ?? null,
        weightGrams: fact ? kilogramsToGrams(fact.actualKg) : null,
        hasDefect,
      });
      byOrder.set(row.productionOrderId, current);
    }
    return byOrder;
  }

  private resolveOrderAllocations(
    costs: readonly AdditionalCostRow[],
    rollsByOrder: ReadonlyMap<string, readonly ProductionOrderCostAllocationRoll[]>,
  ): Map<string, ProductionOrderCostAllocationResult> {
    const result = new Map<string, ProductionOrderCostAllocationResult>();
    for (const cost of costs) {
      if (!cost.productionOrderId || cost.allocationBasis !== 'finished_net_kg') continue;
      result.set(
        cost.id,
        resolveProductionOrderCostAllocation({
          cost: {
            id: cost.id,
            productionOrderId: cost.productionOrderId,
            allocationBasis: cost.allocationBasis,
            amountKopecks: cost.amountKopecks,
            source: cost.source,
            effectiveAt: cost.effectiveAt,
            reason: cost.reason,
          },
          rolls: [...(rollsByOrder.get(cost.productionOrderId) ?? [])],
        }),
      );
    }
    return result;
  }

  private additionalForRoll(
    roll: RollRow,
    effectiveAt: Date,
    basisWeightGrams: number | null,
    costs: readonly AdditionalCostRow[],
    allocations: ReadonlyMap<string, ProductionOrderCostAllocationResult>,
    planned: boolean,
  ): AdditionalPreparation {
    const inputs: AdditionalCostInput[] = [];
    const unresolvedSnapshots: UnresolvedAdditionalSnapshot[] = [];
    for (const cost of costs) {
      if (cost.effectiveAt > effectiveAt) continue;
      if (
        cost.rollDispatchItemId === roll.id &&
        cost.productionOrderId === null &&
        cost.allocationBasis === 'direct'
      ) {
        inputs.push({
          kind: 'direct',
          id: cost.id,
          source: cost.source,
          effectiveAt: cost.effectiveAt,
          reason: cost.reason,
          allocatedAmountKopecks: cost.amountKopecks,
        });
        continue;
      }
      if (cost.productionOrderId !== roll.productionOrderId) continue;
      const allocation = allocations.get(cost.id);
      if (!allocation) continue;
      if (allocation.kind === 'unresolved') {
        inputs.push({
          kind: 'unresolved',
          id: cost.id,
          source: cost.source,
          effectiveAt: cost.effectiveAt,
          reason: cost.reason,
          unresolvedReason: allocation.reason,
        });
        unresolvedSnapshots.push(unresolvedOrderSnapshot(cost, allocation));
        continue;
      }
      const rollCost = allocation.rollCosts.find(
        ({ rollDispatchItemId }) => rollDispatchItemId === roll.id,
      );
      if (!rollCost) continue;
      const denominatorWeight = rollCost.input.denominator.rows.find(
        ({ rollDispatchItemId }) => rollDispatchItemId === roll.id,
      )?.weightGrams;
      if (planned && denominatorWeight !== basisWeightGrams) {
        inputs.push({
          kind: 'unresolved',
          id: cost.id,
          source: cost.source,
          effectiveAt: cost.effectiveAt,
          reason: cost.reason,
          unresolvedReason: 'order_cost_allocation_unresolved',
        });
        continue;
      }
      inputs.push(rollCost.input);
    }
    return { inputs, unresolvedSnapshots };
  }

  private sourceSnapshot(
    roll: RollRow,
    fact: DirectorPayrollProductionFact,
    input: RollProductionCostCalculationInput,
    material: MaterialPreparation,
    unresolvedAdditional: readonly UnresolvedAdditionalSnapshot[],
    closedAt: Date,
  ): ProductionCostSourceSnapshotInput {
    const calculation = calculateRollProductionCost(input);
    const eligibility = eligibilityFact(fact);
    return {
      basis: {
        rollDispatchItemId: roll.id,
        basisWeightGrams: input.basis.weightGrams as number,
        producedAt: fact.producedAt,
        closedAt,
      },
      eligibility: {
        canonicalCaptureId: eligibility.canonicalCaptureId as string,
        rootCaptureId: fact.rootCaptureId as string,
        rootPostSessionId: eligibility.rootPostSessionId as string,
        shiftId: eligibility.shiftId as string,
        machineAssignmentId: eligibility.machineAssignmentId as string,
        dispatchCompletedAt: eligibility.dispatchCompletedAt as Date,
        sessionEndedAt: eligibility.rootPostSessionEndedAt as Date,
        shiftEndedAt: eligibility.shiftEndedAt as Date,
      },
      material: materialSnapshot(material, calculation),
      spool: calculation.spoolSource
        ? {
            sourceId: calculation.spoolSource.sourceId,
            spoolTypeKey: calculation.spoolSource.spoolTypeKey,
            spoolTypeLabel: calculation.spoolSource.spoolTypeLabel,
            widthMicrometers: calculation.spoolSource.widthMicrometers,
            priceKopecksPerMeter: calculation.spoolSource.priceKopecksPerMeter,
            effectiveAt: calculation.spoolSource.effectiveFrom,
            allocatedAmountKopecks: calculation.spoolSource.allocatedAmountKopecks,
          }
        : null,
      payroll:
        calculation.payrollSource && calculation.payrollAmountKopecks !== null
          ? {
              tariffOrderId: calculation.payrollSource.tariffOrderId,
              tariffOrderName: calculation.payrollSource.tariffOrderName,
              effectiveFrom: calculation.payrollSource.effectiveFrom,
              rateKopecksPerKg: calculation.payrollSource.rateKopecksPerKg,
              basisLabel: calculation.payrollSource.basisLabel,
              allocatedAmountKopecks: calculation.payrollAmountKopecks,
            }
          : null,
      additional: additionalSnapshot(calculation, unresolvedAdditional),
    };
  }
}
