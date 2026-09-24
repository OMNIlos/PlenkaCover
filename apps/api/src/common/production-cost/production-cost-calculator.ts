import { createHash } from 'node:crypto';
import {
  PRODUCTION_COST_UNRESOLVED_REASONS,
  type ProductionCostBasis,
  type ProductionCostUnresolvedReason,
} from '@plenka/contracts';

export type EffectiveMaterialPrice = {
  id: string;
  priceKopecksPerKg: number;
  source: string;
  effectiveFrom: Date;
};

export type MaterialCostInput = {
  rawMaterialDefinitionId: string;
  label: string;
  shareBasisPoints: number;
  prices: EffectiveMaterialPrice[];
};

export type RecipeReferenceMaterialBasis = {
  kind: 'recipe_reference';
  components: MaterialCostInput[];
};

export type PositionObservedMaterialBasis = {
  kind: 'position_observed_rate';
  sourceFingerprint: string;
  sourceSnapshotCount: number;
  observedWeightGrams: number;
  observedMaterialAmountKopecks: number;
};

export type AllocationDenominatorRow = {
  rollDispatchItemId: string;
  canonicalCaptureId: string;
  weightGrams: number;
  allocatedGrams?: number;
  allocatedAmountKopecks: number;
};

export type AllocationDenominator = {
  sealed: true;
  algorithmVersion: string;
  rows: AllocationDenominatorRow[];
};

export type ProductionOrderSealProofRow = {
  rollDispatchItemId: string;
  status: string;
  replacementAttemptId: string | null;
  canonicalCaptureId: string | null;
  weightGrams: number | null;
  hasDefect: boolean;
};

export type ProductionOrderSealProof = {
  sealed: true;
  algorithmVersion: string;
  productionOrderId: string;
  rows: ProductionOrderSealProofRow[];
};

export type FrozenShiftBigBagSource = {
  usageId: string;
  bigBagId: string;
  materialDefinitionId?: string;
  label: string;
  effectiveAt: Date;
  totalConsumedGrams: number;
  totalAmountKopecks: number;
  priceKopecksPerKg: number;
  denominator: AllocationDenominator;
  denominatorFingerprint: string;
};

export type ShiftBigBagAllocationMaterialBasis = {
  kind: 'shift_bigbag_allocation';
  rollDispatchItemId: string;
  sources: FrozenShiftBigBagSource[];
};

export type ProductionCostMaterialBasis =
  | RecipeReferenceMaterialBasis
  | PositionObservedMaterialBasis
  | ShiftBigBagAllocationMaterialBasis
  | {
      kind: 'unresolved';
      reason: Extract<
        ProductionCostUnresolvedReason,
        'material_usage_unresolved' | 'material_price_unresolved'
      >;
    };

export type EffectiveSpoolPrice = {
  id: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  priceKopecksPerMeter: number;
  source: string;
  effectiveFrom: Date;
};

export type SpoolCostInput = {
  label: string | null;
  knownTypeLabels: string[];
  widthMicrometers: number | null;
  prices: EffectiveSpoolPrice[];
};

export type PayrollCostInput = {
  tariffOrderId: string;
  tariffOrderName: string;
  effectiveFrom: Date;
  rateKopecksPerKg: number;
  basisLabel: string;
};

type AdditionalCostBase = {
  id: string;
  source: string;
  effectiveAt: Date;
  reason: string;
};

export type DirectAdditionalCostInput = AdditionalCostBase & {
  kind: 'direct';
  allocatedAmountKopecks: number;
};

export type OrderAllocationAdditionalCostInput = AdditionalCostBase & {
  kind: 'order_allocation';
  productionOrderId: string;
  rollDispatchItemId: string;
  totalAmountKopecks: number;
  denominator: AllocationDenominator;
  denominatorFingerprint: string;
  sealProof: ProductionOrderSealProof;
  sealFingerprint: string;
};

export type UnresolvedAdditionalCostInput = AdditionalCostBase & {
  kind: 'unresolved';
  unresolvedReason: 'order_cost_allocation_unresolved';
};

export type AdditionalCostInput =
  | DirectAdditionalCostInput
  | OrderAllocationAdditionalCostInput
  | UnresolvedAdditionalCostInput;

export type RollProductionCostCalculationInput = {
  basis: { kind: ProductionCostBasis['kind']; weightGrams: number | null };
  producedAt: Date;
  materialBasis: ProductionCostMaterialBasis;
  spool: SpoolCostInput | null;
  payroll: PayrollCostInput | null;
  additionalCosts: AdditionalCostInput[];
};

export type RecipeMaterialCostSource = {
  kind: 'recipe_reference';
  sourceId: string;
  rawMaterialDefinitionId: string;
  label: string;
  shareBasisPoints: number;
  componentGrams: number;
  priceKopecksPerKg: number;
  source: string;
  effectiveFrom: Date;
  allocatedAmountKopecks: number;
};

export type ShiftBigBagMaterialCostSource = {
  kind: 'shift_bigbag_allocation';
  sourceId: string;
  bigBagId: string;
  materialDefinitionId?: string;
  label: string;
  componentGrams: number;
  priceKopecksPerKg: number;
  effectiveFrom: Date;
  allocatedAmountKopecks: number;
  totalConsumedGrams: number;
  totalAmountKopecks: number;
  denominatorFingerprint: string;
};

export type PositionObservedMaterialCostSource = {
  kind: 'position_observed_rate';
  sourceId: string;
  sourceSnapshotCount: number;
  componentGrams: number;
  observedWeightGrams: number;
  observedMaterialAmountKopecks: number;
  allocatedAmountKopecks: number;
};

export type MaterialCostSource =
  | RecipeMaterialCostSource
  | PositionObservedMaterialCostSource
  | ShiftBigBagMaterialCostSource;

export type SpoolCostSource = {
  sourceId: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  widthMicrometers: number;
  priceKopecksPerMeter: number;
  source: string;
  effectiveFrom: Date;
  allocatedAmountKopecks: number;
};

export type ResolvedAdditionalCostSource =
  | DirectAdditionalCostInput
  | OrderAllocationAdditionalCostInput;

export type RollProductionCostCalculation = {
  status: 'complete' | 'partial';
  basis: { kind: ProductionCostBasis['kind']; weightGrams: number | null };
  materialAmountKopecks: number | null;
  spoolAmountKopecks: number | null;
  payrollAmountKopecks: number | null;
  additionalAmountKopecks: number;
  totalAmountKopecks: number | null;
  totalKopecksPerKg: number | null;
  materialSources: MaterialCostSource[];
  spoolSource: SpoolCostSource | null;
  payrollSource: PayrollCostInput | null;
  additionalSources: ResolvedAdditionalCostSource[];
  unresolvedReasons: ProductionCostUnresolvedReason[];
};

type SpoolPriceResolution =
  | { kind: 'resolved'; price: EffectiveSpoolPrice }
  | {
      kind: 'unresolved';
      reason: Extract<
        ProductionCostUnresolvedReason,
        'spool_type_unresolved' | 'spool_price_unresolved'
      >;
    };

function safeInteger(value: number, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function safeDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${field} must be a finite date`);
  }
  return value;
}

function safeNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field} exceeds the safe integer range`);
  }
  return Number(value);
}

function halfUp(numerator: bigint, denominator: bigint, field: string): number {
  if (numerator < 0n || denominator <= 0n) throw new RangeError(`${field} is invalid`);
  return safeNumber((numerator * 2n + denominator) / (denominator * 2n), field);
}

function sumSafe(values: readonly number[], field: string): number {
  return safeNumber(
    values.reduce((sum, value) => sum + BigInt(value), 0n),
    field,
  );
}

function nonBlank(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new RangeError(`${field} must be non-blank and trimmed`);
  }
  return value;
}

function orderedReasons(values: ReadonlySet<ProductionCostUnresolvedReason>) {
  return PRODUCTION_COST_UNRESOLVED_REASONS.filter((reason) => values.has(reason));
}

function canonicalDenominator(denominator: AllocationDenominator): object {
  return {
    algorithmVersion: denominator.algorithmVersion,
    rows: [...denominator.rows]
      .map((row) => ({
        allocatedAmountKopecks: row.allocatedAmountKopecks,
        ...(row.allocatedGrams === undefined ? {} : { allocatedGrams: row.allocatedGrams }),
        canonicalCaptureId: row.canonicalCaptureId,
        rollDispatchItemId: row.rollDispatchItemId,
        weightGrams: row.weightGrams,
      }))
      .sort((left, right) => left.rollDispatchItemId.localeCompare(right.rollDispatchItemId)),
    sealed: denominator.sealed,
  };
}

export function fingerprintAllocationDenominator(denominator: AllocationDenominator): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalDenominator(denominator)))
    .digest('hex');
}

function canonicalProductionOrderSealProof(sealProof: ProductionOrderSealProof): object {
  return {
    algorithmVersion: sealProof.algorithmVersion,
    productionOrderId: sealProof.productionOrderId,
    rows: [...sealProof.rows]
      .map((row) => ({
        rollDispatchItemId: row.rollDispatchItemId,
        status: row.status,
        replacementAttemptId: row.replacementAttemptId,
        canonicalCaptureId: row.canonicalCaptureId,
        weightGrams: row.weightGrams,
        hasDefect: row.hasDefect,
      }))
      .sort((left, right) => left.rollDispatchItemId.localeCompare(right.rollDispatchItemId)),
    sealed: sealProof.sealed,
  };
}

export function fingerprintProductionOrderSealProof(sealProof: ProductionOrderSealProof): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalProductionOrderSealProof(sealProof)))
    .digest('hex');
}

export function validateAllocationDenominator(
  denominator: AllocationDenominator,
  fingerprint: string,
  field: string,
  totals: { grams?: number; amountKopecks: number },
): void {
  if (denominator?.sealed !== true) throw new RangeError(`${field} must be sealed`);
  if (denominator.algorithmVersion !== 'largest-remainder-v1') {
    throw new RangeError(`${field}.algorithmVersion is unsupported`);
  }
  if (!Array.isArray(denominator.rows) || denominator.rows.length === 0) {
    throw new RangeError(`${field}.rows must be non-empty`);
  }
  const ids = new Set<string>();
  const canonicalCaptureIds = new Set<string>();
  for (const [index, row] of denominator.rows.entries()) {
    nonBlank(row.rollDispatchItemId, `${field}.rows[${index}].rollDispatchItemId`);
    nonBlank(row.canonicalCaptureId, `${field}.rows[${index}].canonicalCaptureId`);
    if (ids.has(row.rollDispatchItemId)) throw new RangeError(`${field}.rows must be unique`);
    if (canonicalCaptureIds.has(row.canonicalCaptureId)) {
      throw new RangeError(`${field}.rows canonical capture ids must be unique`);
    }
    ids.add(row.rollDispatchItemId);
    canonicalCaptureIds.add(row.canonicalCaptureId);
    safeInteger(row.weightGrams, `${field}.rows[${index}].weightGrams`, 1);
    safeInteger(row.allocatedAmountKopecks, `${field}.rows[${index}].allocatedAmountKopecks`);
    if (totals.grams !== undefined) {
      safeInteger(row.allocatedGrams as number, `${field}.rows[${index}].allocatedGrams`);
    } else if (row.allocatedGrams !== undefined) {
      throw new RangeError(`${field}.rows[${index}].allocatedGrams is not allowed`);
    }
  }
  if (
    sumSafe(
      denominator.rows.map(({ allocatedAmountKopecks }) => allocatedAmountKopecks),
      `${field}.allocatedAmountSum`,
    ) !== totals.amountKopecks
  ) {
    throw new RangeError(`${field} amount sum does not match its source total`);
  }
  if (
    totals.grams !== undefined &&
    sumSafe(
      denominator.rows.map(({ allocatedGrams }) => allocatedGrams as number),
      `${field}.allocatedGramSum`,
    ) !== totals.grams
  ) {
    throw new RangeError(`${field} gram sum does not match its source total`);
  }
  const weights = denominator.rows.map((row) => ({
    id: row.rollDispatchItemId,
    weight: row.weightGrams,
  }));
  const expectedAmounts = allocateIntegerStrict(
    totals.amountKopecks,
    weights,
    `${field}.expectedAmounts`,
  );
  const expectedGrams =
    totals.grams === undefined
      ? null
      : allocateIntegerStrict(totals.grams, weights, `${field}.expectedGrams`);
  for (const [index, row] of denominator.rows.entries()) {
    if (
      row.allocatedAmountKopecks !== expectedAmounts.get(row.rollDispatchItemId) ||
      (expectedGrams !== null && row.allocatedGrams !== expectedGrams.get(row.rollDispatchItemId))
    ) {
      throw new RangeError(`${field}.rows[${index}] does not match the allocation algorithm`);
    }
  }
  if (fingerprintAllocationDenominator(denominator) !== fingerprint) {
    throw new RangeError(`${field} fingerprint does not match its frozen rows`);
  }
}

export function validateProductionOrderSeal(
  sealProof: ProductionOrderSealProof,
  sealFingerprint: string,
  productionOrderId: string,
  denominator: AllocationDenominator,
  field: string,
): void {
  nonBlank(productionOrderId, `${field}.productionOrderId`);
  if (
    sealProof?.sealed !== true ||
    sealProof.algorithmVersion !== 'production-order-terminal-leaves-v1' ||
    sealProof.productionOrderId !== productionOrderId
  ) {
    throw new RangeError(`${field}.sealProof is not a supported sealed ProductionOrder`);
  }
  if (!Array.isArray(sealProof.rows) || sealProof.rows.length === 0) {
    throw new RangeError(`${field}.sealProof.rows must be non-empty`);
  }
  const byId = new Map<string, ProductionOrderSealProofRow>();
  const incomingReplacementIds = new Set<string>();
  const captureIds = new Set<string>();
  for (const [index, row] of sealProof.rows.entries()) {
    nonBlank(row.rollDispatchItemId, `${field}.sealProof.rows[${index}].rollDispatchItemId`);
    if (byId.has(row.rollDispatchItemId)) {
      throw new RangeError(`${field}.sealProof roll ids must be unique`);
    }
    if (!['done', 'cancelled', 'defect'].includes(row.status)) {
      throw new RangeError(`${field}.sealProof contains a nonterminal roll`);
    }
    if (row.replacementAttemptId !== null) {
      nonBlank(row.replacementAttemptId, `${field}.sealProof.rows[${index}].replacementAttemptId`);
      if (incomingReplacementIds.has(row.replacementAttemptId)) {
        throw new RangeError(`${field}.sealProof replacement targets must be unique`);
      }
      incomingReplacementIds.add(row.replacementAttemptId);
    }
    if (row.canonicalCaptureId !== null) {
      nonBlank(row.canonicalCaptureId, `${field}.sealProof.rows[${index}].canonicalCaptureId`);
      if (captureIds.has(row.canonicalCaptureId)) {
        throw new RangeError(`${field}.sealProof canonical capture ids must be unique`);
      }
      captureIds.add(row.canonicalCaptureId);
    }
    if (row.weightGrams !== null) {
      safeInteger(row.weightGrams, `${field}.sealProof.rows[${index}].weightGrams`, 1);
    }
    if (typeof row.hasDefect !== 'boolean') {
      throw new RangeError(`${field}.sealProof.rows[${index}].hasDefect must be boolean`);
    }
    byId.set(row.rollDispatchItemId, row);
  }
  for (const row of sealProof.rows) {
    if (row.replacementAttemptId !== null && !byId.has(row.replacementAttemptId)) {
      throw new RangeError(`${field}.sealProof replacement target is missing`);
    }
    const visited = new Set<string>();
    let current: ProductionOrderSealProofRow | undefined = row;
    while (current && current.replacementAttemptId !== null) {
      if (visited.has(current.rollDispatchItemId)) {
        throw new RangeError(`${field}.sealProof replacement chain is cyclic`);
      }
      visited.add(current.rollDispatchItemId);
      current = byId.get(current.replacementAttemptId);
    }
  }
  const finishedLeaves = sealProof.rows.filter(
    (row) => row.replacementAttemptId === null && row.status === 'done' && !row.hasDefect,
  );
  if (finishedLeaves.length !== denominator.rows.length) {
    throw new RangeError(`${field}.sealProof does not match the allocation denominator`);
  }
  const denominatorById = new Map(
    denominator.rows.map((row) => [row.rollDispatchItemId, row] as const),
  );
  for (const row of finishedLeaves) {
    const denominatorRow = denominatorById.get(row.rollDispatchItemId);
    if (
      row.canonicalCaptureId === null ||
      row.weightGrams === null ||
      !denominatorRow ||
      denominatorRow.canonicalCaptureId !== row.canonicalCaptureId ||
      denominatorRow.weightGrams !== row.weightGrams
    ) {
      throw new RangeError(`${field}.sealProof finished leaves do not match the denominator`);
    }
  }
  if (fingerprintProductionOrderSealProof(sealProof) !== sealFingerprint) {
    throw new RangeError(`${field}.sealProof fingerprint does not match its frozen rows`);
  }
}

export function allocateIntegerStrict(
  total: number,
  inputs: readonly { id: string; weight: number }[],
  field: string,
): Map<string, number> {
  safeInteger(total, `${field}.total`);
  if (inputs.length === 0) throw new RangeError(`${field}.inputs must be non-empty`);
  const ids = new Set<string>();
  for (const input of inputs) {
    nonBlank(input.id, `${field}.id`);
    if (ids.has(input.id)) throw new RangeError(`${field}.ids must be unique`);
    ids.add(input.id);
    safeInteger(input.weight, `${field}.weight`, 1);
  }
  const totalWeight = inputs.reduce((sum, input) => sum + BigInt(input.weight), 0n);
  const totalBigInt = BigInt(total);
  const allocations = inputs.map((input) => {
    const numerator = totalBigInt * BigInt(input.weight);
    return {
      id: input.id,
      amount: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });
  let remainder = totalBigInt - allocations.reduce((sum, row) => sum + row.amount, 0n);
  allocations.sort(
    (left, right) =>
      (left.remainder === right.remainder ? 0 : left.remainder > right.remainder ? -1 : 1) ||
      left.id.localeCompare(right.id),
  );
  for (let index = 0; remainder > 0n; index = (index + 1) % allocations.length) {
    allocations[index].amount += 1n;
    remainder -= 1n;
  }
  return new Map(allocations.map(({ id, amount }) => [id, safeNumber(amount, field)]));
}

export function selectEffectiveMaterialPrice(
  prices: readonly EffectiveMaterialPrice[],
  producedAt: Date,
): EffectiveMaterialPrice | null {
  for (const [index, price] of prices.entries()) {
    nonBlank(price.id, `material.prices[${index}].id`);
    safeInteger(price.priceKopecksPerKg, `material.prices[${index}].priceKopecksPerKg`, 1);
    safeDate(price.effectiveFrom, `material.prices[${index}].effectiveFrom`);
  }
  const eligible = prices
    .filter((price) => price.effectiveFrom <= producedAt)
    .sort(
      (left, right) =>
        right.effectiveFrom.getTime() - left.effectiveFrom.getTime() ||
        right.id.localeCompare(left.id),
    );
  if (
    eligible.length > 1 &&
    eligible[0].effectiveFrom.getTime() === eligible[1].effectiveFrom.getTime()
  ) {
    return null;
  }
  return eligible[0] ?? null;
}

export function normalizeSpoolTypeKey(value: string): string {
  return normalizeSpoolTypeLabel(value).toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
}

export function normalizeSpoolTypeLabel(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function selectEffectiveSpoolPrice(
  label: string | null,
  knownTypeLabels: readonly string[],
  prices: readonly EffectiveSpoolPrice[],
  producedAt: Date,
): SpoolPriceResolution {
  safeDate(producedAt, 'producedAt');
  const normalizedLabel = typeof label === 'string' ? normalizeSpoolTypeLabel(label) : '';
  const key = normalizeSpoolTypeKey(normalizedLabel);
  if (!key) return { kind: 'unresolved', reason: 'spool_type_unresolved' };
  const matchingKnownLabels = new Set(
    knownTypeLabels
      .map(normalizeSpoolTypeLabel)
      .filter((knownLabel) => normalizeSpoolTypeKey(knownLabel) === key),
  );
  if (matchingKnownLabels.size !== 1 || !matchingKnownLabels.has(normalizedLabel)) {
    return { kind: 'unresolved', reason: 'spool_type_unresolved' };
  }

  for (const [index, price] of prices.entries()) {
    nonBlank(price.id, `spool.prices[${index}].id`);
    safeInteger(price.priceKopecksPerMeter, `spool.prices[${index}].priceKopecksPerMeter`, 1);
    safeDate(price.effectiveFrom, `spool.prices[${index}].effectiveFrom`);
  }
  const matching = prices.filter((price) => normalizeSpoolTypeKey(price.spoolTypeKey) === key);
  if (
    matching.some(
      (price) =>
        price.spoolTypeKey !== normalizeSpoolTypeKey(price.spoolTypeLabel) ||
        normalizeSpoolTypeLabel(price.spoolTypeLabel) !== normalizedLabel,
    )
  ) {
    return { kind: 'unresolved', reason: 'spool_type_unresolved' };
  }
  const eligible = matching
    .filter((price) => price.effectiveFrom <= producedAt)
    .sort(
      (left, right) =>
        right.effectiveFrom.getTime() - left.effectiveFrom.getTime() ||
        right.id.localeCompare(left.id),
    );
  if (eligible.length === 0) {
    return { kind: 'unresolved', reason: 'spool_price_unresolved' };
  }
  if (
    eligible.length > 1 &&
    eligible[0].effectiveFrom.getTime() === eligible[1].effectiveFrom.getTime()
  ) {
    return { kind: 'unresolved', reason: 'spool_type_unresolved' };
  }
  return { kind: 'resolved', price: eligible[0] };
}

function resolveRecipeMaterials(
  basis: RecipeReferenceMaterialBasis,
  producedAt: Date,
  weightGrams: number | null,
  unresolved: Set<ProductionCostUnresolvedReason>,
): { amount: number | null; sources: MaterialCostSource[] } {
  const ids = new Set(
    basis.components.map(({ rawMaterialDefinitionId }) => rawMaterialDefinitionId),
  );
  const validRecipe =
    basis.components.length > 0 &&
    ids.size === basis.components.length &&
    basis.components.every(
      ({ rawMaterialDefinitionId, shareBasisPoints }) =>
        rawMaterialDefinitionId.trim() === rawMaterialDefinitionId &&
        rawMaterialDefinitionId.length > 0 &&
        Number.isSafeInteger(shareBasisPoints) &&
        shareBasisPoints > 0 &&
        shareBasisPoints <= 10_000,
    ) &&
    basis.components.reduce((sum, component) => sum + component.shareBasisPoints, 0) === 10_000;
  if (!validRecipe || weightGrams === null) {
    if (!validRecipe) unresolved.add('material_usage_unresolved');
    return { amount: null, sources: [] };
  }

  const componentGrams = allocateIntegerStrict(
    weightGrams,
    basis.components.map(({ rawMaterialDefinitionId: id, shareBasisPoints: weight }) => ({
      id,
      weight,
    })),
    'recipeComponentGrams',
  );
  const sources: RecipeMaterialCostSource[] = [];
  for (const component of basis.components) {
    const price = selectEffectiveMaterialPrice(component.prices, producedAt);
    if (price === null) {
      unresolved.add('material_price_unresolved');
      return { amount: null, sources: [] };
    }
    const grams = componentGrams.get(component.rawMaterialDefinitionId) as number;
    const amount = halfUp(
      BigInt(grams) * BigInt(price.priceKopecksPerKg),
      1_000n,
      'material.allocatedAmountKopecks',
    );
    sources.push({
      kind: 'recipe_reference',
      sourceId: price.id,
      rawMaterialDefinitionId: component.rawMaterialDefinitionId,
      label: component.label,
      shareBasisPoints: component.shareBasisPoints,
      componentGrams: grams,
      priceKopecksPerKg: price.priceKopecksPerKg,
      source: price.source,
      effectiveFrom: price.effectiveFrom,
      allocatedAmountKopecks: amount,
    });
  }
  return {
    amount: sumSafe(
      sources.map(({ allocatedAmountKopecks }) => allocatedAmountKopecks),
      'materialAmountKopecks',
    ),
    sources,
  };
}

function resolveShiftBigBagMaterials(
  basis: ShiftBigBagAllocationMaterialBasis,
  producedAt: Date,
  weightGrams: number | null,
  unresolved: Set<ProductionCostUnresolvedReason>,
): { amount: number | null; sources: MaterialCostSource[] } {
  nonBlank(basis.rollDispatchItemId, 'materialBasis.rollDispatchItemId');
  if (basis.sources.length === 0) {
    unresolved.add('material_usage_unresolved');
    return { amount: null, sources: [] };
  }
  if (weightGrams === null) return { amount: null, sources: [] };
  const sources: ShiftBigBagMaterialCostSource[] = [];
  const usageIds = new Set<string>();
  for (const [index, source] of basis.sources.entries()) {
    nonBlank(source.usageId, `materialBasis.sources[${index}].usageId`);
    if (usageIds.has(source.usageId)) {
      throw new RangeError('materialBasis usage ids must be unique');
    }
    usageIds.add(source.usageId);
    nonBlank(source.bigBagId, `materialBasis.sources[${index}].bigBagId`);
    safeDate(source.effectiveAt, `materialBasis.sources[${index}].effectiveAt`);
    safeInteger(source.totalConsumedGrams, `materialBasis.sources[${index}].totalConsumedGrams`, 1);
    safeInteger(source.totalAmountKopecks, `materialBasis.sources[${index}].totalAmountKopecks`);
    safeInteger(source.priceKopecksPerKg, `materialBasis.sources[${index}].priceKopecksPerKg`, 1);
    const expectedTotalAmount = halfUp(
      BigInt(source.totalConsumedGrams) * BigInt(source.priceKopecksPerKg),
      1_000n,
      `materialBasis.sources[${index}].totalAmountKopecks`,
    );
    if (expectedTotalAmount !== source.totalAmountKopecks) {
      throw new RangeError('materialBasis source total does not match consumed grams and price');
    }
    validateAllocationDenominator(
      source.denominator,
      source.denominatorFingerprint,
      `materialBasis.sources[${index}].denominator`,
      {
        grams: source.totalConsumedGrams,
        amountKopecks: source.totalAmountKopecks,
      },
    );
    const allocation = source.denominator.rows.find(
      ({ rollDispatchItemId }) => rollDispatchItemId === basis.rollDispatchItemId,
    );
    if (!allocation) throw new RangeError('material allocation is missing the current roll');
    if (allocation.weightGrams !== weightGrams) {
      throw new RangeError('material allocation current roll weight does not match the basis');
    }
    if (source.effectiveAt > producedAt) {
      unresolved.add('material_price_unresolved');
      return { amount: null, sources: [] };
    }
    sources.push({
      kind: 'shift_bigbag_allocation',
      sourceId: source.usageId,
      bigBagId: source.bigBagId,
      ...(source.materialDefinitionId === undefined
        ? {}
        : { materialDefinitionId: source.materialDefinitionId }),
      label: source.label,
      componentGrams: allocation.allocatedGrams as number,
      priceKopecksPerKg: source.priceKopecksPerKg,
      effectiveFrom: source.effectiveAt,
      allocatedAmountKopecks: allocation.allocatedAmountKopecks,
      totalConsumedGrams: source.totalConsumedGrams,
      totalAmountKopecks: source.totalAmountKopecks,
      denominatorFingerprint: source.denominatorFingerprint,
    });
  }
  return {
    amount: sumSafe(
      sources.map(({ allocatedAmountKopecks }) => allocatedAmountKopecks),
      'materialAmountKopecks',
    ),
    sources,
  };
}

function resolvePositionObservedMaterials(
  basis: PositionObservedMaterialBasis,
  weightGrams: number | null,
): { amount: number | null; sources: MaterialCostSource[] } {
  if (!/^[0-9a-f]{64}$/u.test(basis.sourceFingerprint)) {
    throw new RangeError('materialBasis.sourceFingerprint must be a lowercase SHA-256');
  }
  safeInteger(basis.sourceSnapshotCount, 'materialBasis.sourceSnapshotCount', 1);
  safeInteger(basis.observedWeightGrams, 'materialBasis.observedWeightGrams', 1);
  safeInteger(
    basis.observedMaterialAmountKopecks,
    'materialBasis.observedMaterialAmountKopecks',
    1,
  );
  if (weightGrams === null) return { amount: null, sources: [] };
  const amount = halfUp(
    BigInt(weightGrams) * BigInt(basis.observedMaterialAmountKopecks),
    BigInt(basis.observedWeightGrams),
    'material.allocatedAmountKopecks',
  );
  return {
    amount,
    sources: [
      {
        kind: 'position_observed_rate',
        sourceId: basis.sourceFingerprint,
        sourceSnapshotCount: basis.sourceSnapshotCount,
        componentGrams: weightGrams,
        observedWeightGrams: basis.observedWeightGrams,
        observedMaterialAmountKopecks: basis.observedMaterialAmountKopecks,
        allocatedAmountKopecks: amount,
      },
    ],
  };
}

function resolveMaterials(
  input: RollProductionCostCalculationInput,
  weightGrams: number | null,
  unresolved: Set<ProductionCostUnresolvedReason>,
): { amount: number | null; sources: MaterialCostSource[] } {
  if (input.materialBasis.kind === 'unresolved') {
    unresolved.add(input.materialBasis.reason);
    return { amount: null, sources: [] };
  }
  if (input.materialBasis.kind === 'recipe_reference') {
    return resolveRecipeMaterials(input.materialBasis, input.producedAt, weightGrams, unresolved);
  }
  return input.materialBasis.kind === 'position_observed_rate'
    ? resolvePositionObservedMaterials(input.materialBasis, weightGrams)
    : resolveShiftBigBagMaterials(input.materialBasis, input.producedAt, weightGrams, unresolved);
}

function resolveSpool(
  input: RollProductionCostCalculationInput,
  unresolved: Set<ProductionCostUnresolvedReason>,
): { amount: number | null; source: SpoolCostSource | null } {
  if (input.spool === null) {
    unresolved.add('spool_type_unresolved');
    unresolved.add('spool_geometry_unresolved');
    return { amount: null, source: null };
  }
  if (input.spool.widthMicrometers !== null) {
    safeInteger(input.spool.widthMicrometers, 'spool.widthMicrometers', 1);
  }
  const price = selectEffectiveSpoolPrice(
    input.spool.label,
    input.spool.knownTypeLabels,
    input.spool.prices,
    input.producedAt,
  );
  if (price.kind === 'unresolved') unresolved.add(price.reason);
  if (input.spool.widthMicrometers === null) unresolved.add('spool_geometry_unresolved');
  if (price.kind === 'unresolved' || input.spool.widthMicrometers === null) {
    return { amount: null, source: null };
  }
  const amount = halfUp(
    BigInt(input.spool.widthMicrometers) * BigInt(price.price.priceKopecksPerMeter),
    1_000_000n,
    'spoolAmountKopecks',
  );
  return {
    amount,
    source: {
      sourceId: price.price.id,
      spoolTypeKey: normalizeSpoolTypeKey(price.price.spoolTypeKey),
      spoolTypeLabel: price.price.spoolTypeLabel,
      widthMicrometers: input.spool.widthMicrometers,
      priceKopecksPerMeter: price.price.priceKopecksPerMeter,
      source: price.price.source,
      effectiveFrom: price.price.effectiveFrom,
      allocatedAmountKopecks: amount,
    },
  };
}

function resolvePayroll(
  payroll: PayrollCostInput | null,
  producedAt: Date,
  weightGrams: number | null,
  unresolved: Set<ProductionCostUnresolvedReason>,
): number | null {
  if (payroll === null || weightGrams === null) {
    if (payroll === null) unresolved.add('payroll_unresolved');
    return null;
  }
  nonBlank(payroll.tariffOrderId, 'payroll.tariffOrderId');
  nonBlank(payroll.tariffOrderName, 'payroll.tariffOrderName');
  nonBlank(payroll.basisLabel, 'payroll.basisLabel');
  safeInteger(payroll.rateKopecksPerKg, 'payroll.rateKopecksPerKg');
  safeDate(payroll.effectiveFrom, 'payroll.effectiveFrom');
  if (payroll.effectiveFrom > producedAt) {
    unresolved.add('payroll_unresolved');
    return null;
  }
  return halfUp(
    BigInt(weightGrams) * BigInt(payroll.rateKopecksPerKg),
    1_000n,
    'payrollAmountKopecks',
  );
}

function resolveAdditional(
  costs: readonly AdditionalCostInput[],
  weightGrams: number | null,
  unresolved: Set<ProductionCostUnresolvedReason>,
): { amount: number; sources: ResolvedAdditionalCostSource[] } {
  const amounts: number[] = [];
  const sources: ResolvedAdditionalCostSource[] = [];
  for (const [index, cost] of costs.entries()) {
    safeDate(cost.effectiveAt, `additionalCosts[${index}].effectiveAt`);
    if (cost.kind === 'unresolved') {
      unresolved.add(cost.unresolvedReason);
      continue;
    }
    if (cost.kind === 'direct') {
      if (!Number.isSafeInteger(cost.allocatedAmountKopecks)) {
        unresolved.add('additional_cost_unresolved');
        continue;
      }
      amounts.push(
        safeInteger(
          cost.allocatedAmountKopecks,
          `additionalCosts[${index}].allocatedAmountKopecks`,
        ),
      );
      sources.push(cost);
      continue;
    }
    safeInteger(cost.totalAmountKopecks, `additionalCosts[${index}].totalAmountKopecks`);
    validateAllocationDenominator(
      cost.denominator,
      cost.denominatorFingerprint,
      `additionalCosts[${index}].denominator`,
      {
        amountKopecks: cost.totalAmountKopecks,
      },
    );
    validateProductionOrderSeal(
      cost.sealProof,
      cost.sealFingerprint,
      cost.productionOrderId,
      cost.denominator,
      `additionalCosts[${index}]`,
    );
    const allocation = cost.denominator.rows.find(
      ({ rollDispatchItemId }) => rollDispatchItemId === cost.rollDispatchItemId,
    );
    if (!allocation || weightGrams === null || allocation.weightGrams !== weightGrams) {
      throw new RangeError(`additionalCosts[${index}] is missing the current roll basis`);
    }
    amounts.push(allocation.allocatedAmountKopecks);
    sources.push(cost);
  }
  return { amount: sumSafe(amounts, 'additionalAmountKopecks'), sources };
}

export function calculateRollProductionCost(
  input: RollProductionCostCalculationInput,
): RollProductionCostCalculation {
  safeDate(input.producedAt, 'producedAt');
  const unresolved = new Set<ProductionCostUnresolvedReason>();
  const weightGrams =
    input.basis.weightGrams === null
      ? null
      : safeInteger(input.basis.weightGrams, 'weightGrams', 1);
  if (weightGrams === null) unresolved.add('weight_unresolved');

  const material = resolveMaterials(input, weightGrams, unresolved);
  const spool = resolveSpool(input, unresolved);
  const payrollAmountKopecks = resolvePayroll(
    input.payroll,
    input.producedAt,
    weightGrams,
    unresolved,
  );
  const additional = resolveAdditional(input.additionalCosts, weightGrams, unresolved);
  const unresolvedReasons = orderedReasons(unresolved);
  const totalAmountKopecks =
    unresolvedReasons.length === 0 &&
    material.amount !== null &&
    spool.amount !== null &&
    payrollAmountKopecks !== null
      ? sumSafe(
          [material.amount, spool.amount, payrollAmountKopecks, additional.amount],
          'totalAmountKopecks',
        )
      : null;
  const totalKopecksPerKg =
    totalAmountKopecks === null || weightGrams === null
      ? null
      : halfUp(BigInt(totalAmountKopecks) * 1_000n, BigInt(weightGrams), 'totalKopecksPerKg');

  return {
    status: unresolvedReasons.length === 0 ? 'complete' : 'partial',
    basis: { kind: input.basis.kind, weightGrams },
    materialAmountKopecks: material.amount,
    spoolAmountKopecks: spool.amount,
    payrollAmountKopecks,
    additionalAmountKopecks: additional.amount,
    totalAmountKopecks,
    totalKopecksPerKg,
    materialSources: material.sources,
    spoolSource: spool.source,
    payrollSource: input.payroll,
    additionalSources: additional.sources,
    unresolvedReasons,
  };
}
