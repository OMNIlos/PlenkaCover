import { createHash } from 'node:crypto';
import {
  allocateIntegerStrict,
  fingerprintAllocationDenominator,
  fingerprintProductionOrderSealProof,
  type AllocationDenominator,
  type OrderAllocationAdditionalCostInput,
  type ProductionOrderSealProof,
} from './production-cost-calculator';

export type ProductionOrderCostAllocationRoll = {
  rollDispatchItemId: string;
  status: string;
  replacementAttemptId: string | null;
  canonicalCaptureId: string | null;
  weightGrams: number | null;
  hasDefect: boolean;
};

export type ProductionOrderCostAllocationInput = {
  cost: {
    id: string;
    productionOrderId: string;
    allocationBasis: string;
    amountKopecks: number;
    source: string;
    effectiveAt: Date;
    reason: string;
  };
  rolls: ProductionOrderCostAllocationRoll[];
};

export type ProductionOrderCostAllocationResult =
  | {
      kind: 'unresolved';
      reason: 'order_cost_allocation_unresolved';
      observedRollIds: Array<string | null>;
      safeInputFingerprint: string;
    }
  | {
      kind: 'resolved';
      sealProof: ProductionOrderSealProof;
      sealFingerprint: string;
      rollCosts: Array<{
        rollDispatchItemId: string;
        input: OrderAllocationAdditionalCostInput;
      }>;
    };

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'defect']);

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function safeFact(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return `invalid:${String(value)}`;
}

function safeInput(input: ProductionOrderCostAllocationInput): object {
  return {
    cost: {
      id: safeFact(input.cost?.id),
      productionOrderId: safeFact(input.cost?.productionOrderId),
      allocationBasis: safeFact(input.cost?.allocationBasis),
      amountKopecks: safeFact(input.cost?.amountKopecks),
      source: safeFact(input.cost?.source),
      effectiveAt: safeFact(input.cost?.effectiveAt),
      reason: safeFact(input.cost?.reason),
    },
    rolls: (Array.isArray(input.rolls) ? input.rolls : [])
      .map((roll) => ({
        rollDispatchItemId: safeFact(roll?.rollDispatchItemId),
        status: safeFact(roll?.status),
        replacementAttemptId: safeFact(roll?.replacementAttemptId),
        canonicalCaptureId: safeFact(roll?.canonicalCaptureId),
        weightGrams: safeFact(roll?.weightGrams),
        hasDefect: safeFact(roll?.hasDefect),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

function unresolved(
  input: ProductionOrderCostAllocationInput,
): ProductionOrderCostAllocationResult {
  const observedRollIds = (Array.isArray(input.rolls) ? input.rolls : [])
    .map((roll) => (isNonBlank(roll?.rollDispatchItemId) ? roll.rollDispatchItemId : null))
    .sort((left, right) => (left ?? '').localeCompare(right ?? ''));
  return {
    kind: 'unresolved',
    reason: 'order_cost_allocation_unresolved',
    observedRollIds,
    safeInputFingerprint: createHash('sha256')
      .update(JSON.stringify(safeInput(input)))
      .digest('hex'),
  };
}

function hasValidReplacementGraph(rows: readonly ProductionOrderCostAllocationRoll[]): boolean {
  const byId = new Map(rows.map((row) => [row.rollDispatchItemId, row]));
  const incoming = new Set<string>();
  for (const row of rows) {
    if (row.replacementAttemptId === null) continue;
    if (!byId.has(row.replacementAttemptId) || incoming.has(row.replacementAttemptId)) return false;
    incoming.add(row.replacementAttemptId);
  }
  for (const row of rows) {
    const visited = new Set<string>();
    let current: ProductionOrderCostAllocationRoll | undefined = row;
    while (current && current.replacementAttemptId !== null) {
      if (visited.has(current.rollDispatchItemId)) return false;
      visited.add(current.rollDispatchItemId);
      current = byId.get(current.replacementAttemptId);
    }
    if (!current) return false;
  }
  return true;
}

export function resolveProductionOrderCostAllocation(
  input: ProductionOrderCostAllocationInput,
): ProductionOrderCostAllocationResult {
  const { cost } = input;
  if (
    !cost ||
    !isNonBlank(cost.id) ||
    !isNonBlank(cost.productionOrderId) ||
    cost.allocationBasis !== 'finished_net_kg' ||
    !isSafeInteger(cost.amountKopecks) ||
    !isNonBlank(cost.source) ||
    !isFiniteDate(cost.effectiveAt) ||
    !isNonBlank(cost.reason) ||
    !Array.isArray(input.rolls) ||
    input.rolls.length === 0
  ) {
    return unresolved(input);
  }

  const rows = [...input.rolls].sort((left, right) =>
    left.rollDispatchItemId.localeCompare(right.rollDispatchItemId),
  );
  const rollIds = new Set<string>();
  const captureIds = new Set<string>();
  for (const row of rows) {
    if (
      !isNonBlank(row.rollDispatchItemId) ||
      rollIds.has(row.rollDispatchItemId) ||
      !isNonBlank(row.status) ||
      !TERMINAL_STATUSES.has(row.status) ||
      (row.replacementAttemptId !== null && !isNonBlank(row.replacementAttemptId)) ||
      typeof row.hasDefect !== 'boolean'
    ) {
      return unresolved(input);
    }
    rollIds.add(row.rollDispatchItemId);
    if (row.canonicalCaptureId !== null) {
      if (!isNonBlank(row.canonicalCaptureId) || captureIds.has(row.canonicalCaptureId)) {
        return unresolved(input);
      }
      captureIds.add(row.canonicalCaptureId);
    }
    if (row.weightGrams !== null && !isSafeInteger(row.weightGrams, 1)) {
      return unresolved(input);
    }
  }
  if (!hasValidReplacementGraph(rows)) return unresolved(input);

  const finishedLeaves = rows.filter(
    (row) => row.replacementAttemptId === null && row.status === 'done' && !row.hasDefect,
  );
  if (
    finishedLeaves.length === 0 ||
    finishedLeaves.some(
      (row) => row.canonicalCaptureId === null || !isSafeInteger(row.weightGrams, 1),
    )
  ) {
    return unresolved(input);
  }

  const sealProof: ProductionOrderSealProof = {
    sealed: true,
    algorithmVersion: 'production-order-terminal-leaves-v1',
    productionOrderId: cost.productionOrderId,
    rows,
  };
  const sealFingerprint = fingerprintProductionOrderSealProof(sealProof);
  const weights = finishedLeaves.map((row) => ({
    id: row.rollDispatchItemId,
    weight: row.weightGrams as number,
  }));
  const allocated = allocateIntegerStrict(cost.amountKopecks, weights, 'productionOrderCost');
  const denominator: AllocationDenominator = {
    sealed: true,
    algorithmVersion: 'largest-remainder-v1',
    rows: finishedLeaves.map((row) => ({
      rollDispatchItemId: row.rollDispatchItemId,
      canonicalCaptureId: row.canonicalCaptureId as string,
      weightGrams: row.weightGrams as number,
      allocatedAmountKopecks: allocated.get(row.rollDispatchItemId) as number,
    })),
  };
  const denominatorFingerprint = fingerprintAllocationDenominator(denominator);
  return {
    kind: 'resolved',
    sealProof,
    sealFingerprint,
    rollCosts: finishedLeaves.map((row) => ({
      rollDispatchItemId: row.rollDispatchItemId,
      input: {
        kind: 'order_allocation',
        id: cost.id,
        productionOrderId: cost.productionOrderId,
        source: cost.source,
        effectiveAt: cost.effectiveAt,
        reason: cost.reason,
        rollDispatchItemId: row.rollDispatchItemId,
        totalAmountKopecks: cost.amountKopecks,
        denominator,
        denominatorFingerprint,
        sealProof,
        sealFingerprint,
      },
    })),
  };
}
