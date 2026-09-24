import {
  PRODUCTION_COST_UNRESOLVED_REASONS,
  type ProductionCostUnresolvedReason,
} from '@plenka/contracts';

export type RollProductionCostEligibilityFact = {
  canonicalCaptureId: string | null;
  canonicalCaptureIsLeaf: boolean;
  basisWeightGrams: number | null;
  producedAt: Date | null;
  hasDefect: boolean;
  operatorStep: string | null;
  dispatchStatus: string;
  dispatchCompletedAt: Date | null;
  rootPostSessionId: string | null;
  rootPostSessionStatus: string | null;
  rootPostSessionEndedAt: Date | null;
  machineAssignmentId: string | null;
  machineAssignmentStatus: string | null;
  shiftId: string | null;
  shiftStatus: string | null;
  shiftEndedAt: Date | null;
};

export type RollProductionCostEligibility = {
  eligible: boolean;
  basisWeightGrams: number | null;
  producedAt: Date | null;
  closedAt: Date | null;
  unresolvedReasons: ProductionCostUnresolvedReason[];
};

function finiteDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function nonBlank(value: string | null): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

export function evaluateRollProductionCostEligibility(
  fact: RollProductionCostEligibilityFact,
): RollProductionCostEligibility {
  const failures = new Set<ProductionCostUnresolvedReason>();
  const basisWeightGrams =
    fact.basisWeightGrams !== null &&
    Number.isSafeInteger(fact.basisWeightGrams) &&
    fact.basisWeightGrams > 0
      ? fact.basisWeightGrams
      : null;
  if (basisWeightGrams === null) failures.add('weight_unresolved');

  const producedAt = finiteDate(fact.producedAt) ? fact.producedAt : null;
  if (!nonBlank(fact.canonicalCaptureId) || !fact.canonicalCaptureIsLeaf || producedAt === null) {
    failures.add('canonical_capture_unresolved');
  }
  if (fact.hasDefect) failures.add('defect_present');
  if (fact.operatorStep !== 'warehouse') failures.add('operator_step_unresolved');

  const dispatchCompletedAt = finiteDate(fact.dispatchCompletedAt)
    ? fact.dispatchCompletedAt
    : null;
  if (fact.dispatchStatus !== 'done' || dispatchCompletedAt === null) {
    failures.add('dispatch_not_completed');
  }
  if (
    !nonBlank(fact.rootPostSessionId) ||
    fact.rootPostSessionStatus !== 'closed' ||
    !finiteDate(fact.rootPostSessionEndedAt)
  ) {
    failures.add('post_session_not_closed');
  }
  if (!nonBlank(fact.machineAssignmentId) || fact.machineAssignmentStatus !== 'completed') {
    failures.add('machine_assignment_not_completed');
  }
  const shiftEndedAt = finiteDate(fact.shiftEndedAt) ? fact.shiftEndedAt : null;
  if (!nonBlank(fact.shiftId) || fact.shiftStatus !== 'closed' || shiftEndedAt === null) {
    failures.add('shift_not_closed');
  }
  const unresolvedReasons = PRODUCTION_COST_UNRESOLVED_REASONS.filter((reason) =>
    failures.has(reason),
  );
  const closedAt =
    dispatchCompletedAt && shiftEndedAt
      ? new Date(Math.max(dispatchCompletedAt.getTime(), shiftEndedAt.getTime()))
      : null;

  return {
    eligible: unresolvedReasons.length === 0,
    basisWeightGrams,
    producedAt,
    closedAt,
    unresolvedReasons,
  };
}
