import { hasIrreversiblePhysicalFacts, type RollReversibilityFacts } from './roll-reversibility';

function untouched(status = 'new'): RollReversibilityFacts {
  return {
    status,
    completedAt: null,
    coverageFactId: null,
    operatorLine: null,
  };
}

function assignedLine(): NonNullable<RollReversibilityFacts['operatorLine']> {
  return {
    spoolKg: null,
    grossKg: null,
    netKg: null,
    warehouseState: 'not_ready',
    weightCaptures: [],
    labelJobs: [],
    operations: [],
  };
}

describe('hasIrreversiblePhysicalFacts', () => {
  it.each(['new', 'assigned'])('keeps an untouched %s row reversible', (status) => {
    expect(hasIrreversiblePhysicalFacts(untouched(status))).toBe(false);
    expect(
      hasIrreversiblePhysicalFacts({
        ...untouched(status),
        operatorLine: assignedLine(),
      }),
    ).toBe(false);
  });

  it.each(['in_progress', 'blocked', 'deferred', 'defect', 'ready_for_warehouse', 'done'])(
    'treats %s as irreversible',
    (status) => {
      expect(hasIrreversiblePhysicalFacts(untouched(status))).toBe(true);
    },
  );

  it.each([
    { completedAt: new Date('2026-08-04T10:00:00.000Z') },
    { coverageFactId: 'coverage-fact-1' },
    { operatorLine: { ...assignedLine(), spoolKg: 1.2 } },
    { operatorLine: { ...assignedLine(), grossKg: 42 } },
    { operatorLine: { ...assignedLine(), netKg: 40 } },
    { operatorLine: { ...assignedLine(), warehouseState: 'ready_for_handover' } },
    { operatorLine: { ...assignedLine(), weightCaptures: [{}] } },
    { operatorLine: { ...assignedLine(), labelJobs: [{}] } },
    { operatorLine: { ...assignedLine(), operations: [{}] } },
  ])('preserves any physical evidence: %#', (patch) => {
    expect(hasIrreversiblePhysicalFacts({ ...untouched(), ...patch })).toBe(true);
  });
});
