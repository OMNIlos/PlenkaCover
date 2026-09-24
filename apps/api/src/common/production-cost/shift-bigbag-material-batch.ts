import { createHash } from 'node:crypto';
import type { ProductionCostUnresolvedReason } from '@plenka/contracts';
import {
  allocateIntegerStrict,
  fingerprintAllocationDenominator,
  type AllocationDenominator,
  type FrozenShiftBigBagSource,
  type ShiftBigBagAllocationMaterialBasis,
} from './production-cost-calculator';

export type ShiftBigBagBatchRoll = {
  rollDispatchItemId: string;
  canonicalCaptureId: string;
  weightGrams: number;
  producedAt: Date;
  isCanonicalLeaf: boolean;
  isFinishedGood: boolean;
};

export type ShiftBigBagBatchUsage = {
  usageId: string;
  bigBagId: string;
  materialDefinitionId?: string;
  label: string;
  startGrams: number;
  endGrams: number | null;
  priceKopecksPerKg: number | null;
  effectiveAt: Date | null;
};

type ClosedScopeInput = {
  id: string;
  status: string;
  endedAt: Date | null;
};

export type ShiftBigBagMaterialBatchInput = {
  rootSession: ClosedScopeInput;
  shift: ClosedScopeInput;
  rolls: ShiftBigBagBatchRoll[];
  usages: ShiftBigBagBatchUsage[];
};

export type ShiftBigBagMaterialBatchResult =
  | { kind: 'absent' }
  | {
      kind: 'unresolved';
      reason: Extract<
        ProductionCostUnresolvedReason,
        | 'material_usage_unresolved'
        | 'material_price_unresolved'
        | 'canonical_capture_unresolved'
        | 'post_session_not_closed'
        | 'shift_not_closed'
      >;
      observedSources: Array<{
        usageId: string | null;
        bigBagId: string | null;
        materialDefinitionId: string | null;
      }>;
      safeInputFingerprint: string;
    }
  | {
      kind: 'resolved';
      batchFingerprint: string;
      rollBases: Array<{
        rollDispatchItemId: string;
        materialBasis: ShiftBigBagAllocationMaterialBasis;
      }>;
    };

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function halfUpSafe(numerator: bigint, denominator: bigint): number {
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  if (rounded < 0n || rounded > MAX_SAFE_BIGINT) {
    throw new RangeError('ShiftBagUsage amount exceeds the safe integer range');
  }
  return Number(rounded);
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fingerprintInteger(value: unknown): number | string {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : `invalid:${String(value)}`;
}

function fingerprintDate(value: unknown): string | null {
  return isFiniteDate(value) ? value.toISOString() : null;
}

function safeUnresolvedProvenance(input: ShiftBigBagMaterialBatchInput) {
  const observedSources = (Array.isArray(input.usages) ? input.usages : [])
    .map((usage) => ({
      usageId: isNonBlank(usage?.usageId) ? usage.usageId : null,
      bigBagId: isNonBlank(usage?.bigBagId) ? usage.bigBagId : null,
      materialDefinitionId: isNonBlank(usage?.materialDefinitionId)
        ? usage.materialDefinitionId
        : null,
    }))
    .sort(
      (left, right) =>
        (left.usageId ?? '').localeCompare(right.usageId ?? '') ||
        (left.bigBagId ?? '').localeCompare(right.bigBagId ?? '') ||
        (left.materialDefinitionId ?? '').localeCompare(right.materialDefinitionId ?? ''),
    );
  const rolls = (Array.isArray(input.rolls) ? input.rolls : [])
    .map((roll) => ({
      rollDispatchItemId: isNonBlank(roll?.rollDispatchItemId) ? roll.rollDispatchItemId : null,
      canonicalCaptureId: isNonBlank(roll?.canonicalCaptureId) ? roll.canonicalCaptureId : null,
      weightGrams: fingerprintInteger(roll?.weightGrams),
      producedAt: fingerprintDate(roll?.producedAt),
      isCanonicalLeaf: roll?.isCanonicalLeaf === true,
      isFinishedGood: roll?.isFinishedGood === true,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const usages = (Array.isArray(input.usages) ? input.usages : [])
    .map((usage) => ({
      usageId: typeof usage?.usageId === 'string' ? usage.usageId : null,
      bigBagId: typeof usage?.bigBagId === 'string' ? usage.bigBagId : null,
      materialDefinitionId:
        typeof usage?.materialDefinitionId === 'string' ? usage.materialDefinitionId : null,
      label: typeof usage?.label === 'string' ? usage.label : null,
      startGrams: fingerprintInteger(usage?.startGrams),
      endGrams: fingerprintInteger(usage?.endGrams),
      priceKopecksPerKg: fingerprintInteger(usage?.priceKopecksPerKg),
      effectiveAt: fingerprintDate(usage?.effectiveAt),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    observedSources,
    safeInputFingerprint: hash({
      rootSession: {
        id: typeof input.rootSession?.id === 'string' ? input.rootSession.id : null,
        status: typeof input.rootSession?.status === 'string' ? input.rootSession.status : null,
        endedAt: fingerprintDate(input.rootSession?.endedAt),
      },
      shift: {
        id: typeof input.shift?.id === 'string' ? input.shift.id : null,
        status: typeof input.shift?.status === 'string' ? input.shift.status : null,
        endedAt: fingerprintDate(input.shift?.endedAt),
      },
      rolls,
      usages,
    }),
  };
}

export function resolveShiftBigBagMaterialBatch(
  input: ShiftBigBagMaterialBatchInput,
): ShiftBigBagMaterialBatchResult {
  if (input.usages.length === 0) return { kind: 'absent' };
  const unresolved = (
    reason: Extract<ShiftBigBagMaterialBatchResult, { kind: 'unresolved' }>['reason'],
  ): Extract<ShiftBigBagMaterialBatchResult, { kind: 'unresolved' }> => ({
    kind: 'unresolved',
    reason,
    ...safeUnresolvedProvenance(input),
  });
  if (input.rootSession.status !== 'closed' || !isFiniteDate(input.rootSession.endedAt)) {
    return unresolved('post_session_not_closed');
  }
  if (input.shift.status !== 'closed' || !isFiniteDate(input.shift.endedAt)) {
    return unresolved('shift_not_closed');
  }
  if (input.rolls.length === 0) {
    return unresolved('canonical_capture_unresolved');
  }

  const orderedRolls = [...input.rolls].sort((left, right) =>
    left.rollDispatchItemId.localeCompare(right.rollDispatchItemId),
  );
  const rollIds = new Set<string>();
  const captureIds = new Set<string>();
  for (const roll of orderedRolls) {
    if (
      !isNonBlank(roll.rollDispatchItemId) ||
      !isNonBlank(roll.canonicalCaptureId) ||
      rollIds.has(roll.rollDispatchItemId) ||
      captureIds.has(roll.canonicalCaptureId) ||
      !isSafeInteger(roll.weightGrams, 1) ||
      !isFiniteDate(roll.producedAt) ||
      !roll.isCanonicalLeaf ||
      !roll.isFinishedGood
    ) {
      return unresolved('canonical_capture_unresolved');
    }
    rollIds.add(roll.rollDispatchItemId);
    captureIds.add(roll.canonicalCaptureId);
  }

  const orderedUsages = [...input.usages].sort((left, right) =>
    left.usageId.localeCompare(right.usageId),
  );
  const usageIds = new Set<string>();
  const sources: FrozenShiftBigBagSource[] = [];
  for (const usage of orderedUsages) {
    if (
      !isNonBlank(usage.usageId) ||
      usageIds.has(usage.usageId) ||
      !isNonBlank(usage.bigBagId) ||
      !isNonBlank(usage.label) ||
      !isSafeInteger(usage.startGrams) ||
      !isSafeInteger(usage.endGrams) ||
      usage.startGrams - usage.endGrams <= 0
    ) {
      return unresolved('material_usage_unresolved');
    }
    usageIds.add(usage.usageId);
    if (
      !isSafeInteger(usage.priceKopecksPerKg, 1) ||
      !isFiniteDate(usage.effectiveAt) ||
      orderedRolls.some((roll) => (usage.effectiveAt as Date) > roll.producedAt)
    ) {
      return unresolved('material_price_unresolved');
    }
    const totalConsumedGrams = usage.startGrams - usage.endGrams;
    let totalAmountKopecks: number;
    try {
      totalAmountKopecks = halfUpSafe(
        BigInt(totalConsumedGrams) * BigInt(usage.priceKopecksPerKg),
        1_000n,
      );
    } catch {
      return unresolved('material_price_unresolved');
    }
    const weights = orderedRolls.map((roll) => ({
      id: roll.rollDispatchItemId,
      weight: roll.weightGrams,
    }));
    const allocatedGrams = allocateIntegerStrict(
      totalConsumedGrams,
      weights,
      `ShiftBagUsage(${usage.usageId}).grams`,
    );
    const allocatedAmounts = allocateIntegerStrict(
      totalAmountKopecks,
      weights,
      `ShiftBagUsage(${usage.usageId}).amount`,
    );
    const denominator: AllocationDenominator = {
      sealed: true,
      algorithmVersion: 'largest-remainder-v1',
      rows: orderedRolls.map((roll) => ({
        rollDispatchItemId: roll.rollDispatchItemId,
        canonicalCaptureId: roll.canonicalCaptureId,
        weightGrams: roll.weightGrams,
        allocatedGrams: allocatedGrams.get(roll.rollDispatchItemId) as number,
        allocatedAmountKopecks: allocatedAmounts.get(roll.rollDispatchItemId) as number,
      })),
    };
    sources.push({
      usageId: usage.usageId,
      bigBagId: usage.bigBagId,
      ...(usage.materialDefinitionId === undefined
        ? {}
        : { materialDefinitionId: usage.materialDefinitionId }),
      label: usage.label,
      effectiveAt: usage.effectiveAt,
      totalConsumedGrams,
      totalAmountKopecks,
      priceKopecksPerKg: usage.priceKopecksPerKg,
      denominator,
      denominatorFingerprint: fingerprintAllocationDenominator(denominator),
    });
  }

  const batchFingerprint = hash({
    rootSession: {
      id: input.rootSession.id,
      endedAt: input.rootSession.endedAt.toISOString(),
    },
    shift: { id: input.shift.id, endedAt: input.shift.endedAt.toISOString() },
    rolls: orderedRolls.map((roll) => ({
      rollDispatchItemId: roll.rollDispatchItemId,
      canonicalCaptureId: roll.canonicalCaptureId,
      weightGrams: roll.weightGrams,
      producedAt: roll.producedAt.toISOString(),
    })),
    sources: sources.map((source) => ({
      usageId: source.usageId,
      bigBagId: source.bigBagId,
      materialDefinitionId: source.materialDefinitionId ?? null,
      effectiveAt: source.effectiveAt.toISOString(),
      totalConsumedGrams: source.totalConsumedGrams,
      totalAmountKopecks: source.totalAmountKopecks,
      priceKopecksPerKg: source.priceKopecksPerKg,
      denominatorFingerprint: source.denominatorFingerprint,
    })),
  });

  return {
    kind: 'resolved',
    batchFingerprint,
    rollBases: orderedRolls.map((roll) => ({
      rollDispatchItemId: roll.rollDispatchItemId,
      materialBasis: {
        kind: 'shift_bigbag_allocation',
        rollDispatchItemId: roll.rollDispatchItemId,
        sources,
      },
    })),
  };
}
