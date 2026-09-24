import {
  evaluateRollProductionCostEligibility,
  type RollProductionCostEligibilityFact,
} from './roll-production-cost-eligibility';

function fact(
  overrides: Partial<RollProductionCostEligibilityFact> = {},
): RollProductionCostEligibilityFact {
  return {
    canonicalCaptureId: 'capture-1',
    canonicalCaptureIsLeaf: true,
    basisWeightGrams: 10_000,
    producedAt: new Date('2026-08-02T10:00:00Z'),
    hasDefect: false,
    operatorStep: 'warehouse',
    dispatchStatus: 'done',
    dispatchCompletedAt: new Date('2026-08-02T17:00:00Z'),
    rootPostSessionId: 'session-1',
    rootPostSessionStatus: 'closed',
    rootPostSessionEndedAt: new Date('2026-08-02T17:30:00Z'),
    machineAssignmentId: 'assignment-1',
    machineAssignmentStatus: 'completed',
    shiftId: 'shift-1',
    shiftStatus: 'closed',
    shiftEndedAt: new Date('2026-08-02T18:00:00Z'),
    ...overrides,
  };
}

describe('roll production-cost snapshot eligibility', () => {
  it('returns producedAt from the root capture and max dispatch/shift closedAt', () => {
    expect(evaluateRollProductionCostEligibility(fact())).toEqual({
      eligible: true,
      basisWeightGrams: 10_000,
      producedAt: new Date('2026-08-02T10:00:00Z'),
      closedAt: new Date('2026-08-02T18:00:00Z'),
      unresolvedReasons: [],
    });
    expect(
      evaluateRollProductionCostEligibility(
        fact({ dispatchCompletedAt: new Date('2026-08-02T19:00:00Z') }),
      ).closedAt,
    ).toEqual(new Date('2026-08-02T19:00:00Z'));
  });

  it.each([
    ['missing capture', { canonicalCaptureId: null }, 'canonical_capture_unresolved'],
    ['non-leaf capture', { canonicalCaptureIsLeaf: false }, 'canonical_capture_unresolved'],
    ['zero weight', { basisWeightGrams: 0 }, 'weight_unresolved'],
    ['missing root producedAt', { producedAt: null }, 'canonical_capture_unresolved'],
    ['defect', { hasDefect: true }, 'defect_present'],
    ['operator step', { operatorStep: 'roll' }, 'operator_step_unresolved'],
    ['dispatch status', { dispatchStatus: 'ready_for_warehouse' }, 'dispatch_not_completed'],
    ['dispatch completion time', { dispatchCompletedAt: null }, 'dispatch_not_completed'],
    ['post session id', { rootPostSessionId: null }, 'post_session_not_closed'],
    ['post session status', { rootPostSessionStatus: 'active' }, 'post_session_not_closed'],
    ['post session end', { rootPostSessionEndedAt: null }, 'post_session_not_closed'],
    ['assignment id', { machineAssignmentId: null }, 'machine_assignment_not_completed'],
    [
      'assignment status',
      { machineAssignmentStatus: 'active' },
      'machine_assignment_not_completed',
    ],
    ['shift id', { shiftId: null }, 'shift_not_closed'],
    ['shift status', { shiftStatus: 'open' }, 'shift_not_closed'],
    ['shift end', { shiftEndedAt: null }, 'shift_not_closed'],
  ] as const)('fails closed independently for %s', (_label, patch, reason) => {
    const result = evaluateRollProductionCostEligibility(fact(patch as never));
    expect(result.eligible).toBe(false);
    expect(result.unresolvedReasons).toContain(reason);
  });

  it('orders and deduplicates multiple failures deterministically', () => {
    const result = evaluateRollProductionCostEligibility(
      fact({
        canonicalCaptureId: null,
        basisWeightGrams: null,
        operatorStep: 'roll',
        dispatchStatus: 'new',
        dispatchCompletedAt: null,
      }),
    );
    expect(result.unresolvedReasons).toEqual([
      'weight_unresolved',
      'canonical_capture_unresolved',
      'operator_step_unresolved',
      'dispatch_not_completed',
    ]);
  });
});
