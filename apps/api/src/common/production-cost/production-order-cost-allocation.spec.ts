import {
  resolveProductionOrderCostAllocation,
  type ProductionOrderCostAllocationInput,
} from './production-order-cost-allocation';

const EFFECTIVE_AT = new Date('2026-08-01T00:00:00.000Z');

function input(
  overrides: Partial<ProductionOrderCostAllocationInput> = {},
): ProductionOrderCostAllocationInput {
  return {
    cost: {
      id: 'order-cost-1',
      productionOrderId: 'production-order-1',
      allocationBasis: 'finished_net_kg',
      amountKopecks: 3,
      source: 'Акт',
      effectiveAt: EFFECTIVE_AT,
      reason: 'Наладка',
    },
    rolls: [
      {
        rollDispatchItemId: 'defect-source',
        status: 'defect',
        replacementAttemptId: 'roll-1',
        canonicalCaptureId: 'capture-defect',
        weightGrams: 9_000,
        hasDefect: true,
      },
      {
        rollDispatchItemId: 'roll-1',
        status: 'done',
        replacementAttemptId: null,
        canonicalCaptureId: 'capture-1',
        weightGrams: 10_000,
        hasDefect: false,
      },
      {
        rollDispatchItemId: 'roll-2',
        status: 'done',
        replacementAttemptId: null,
        canonicalCaptureId: 'capture-2',
        weightGrams: 10_000,
        hasDefect: false,
      },
      {
        rollDispatchItemId: 'written-off-defect',
        status: 'done',
        replacementAttemptId: null,
        canonicalCaptureId: 'capture-written-off',
        weightGrams: 5_000,
        hasDefect: true,
      },
    ],
    ...overrides,
  };
}

describe('strict ProductionOrder additional-cost allocation', () => {
  it('seals the whole terminal replacement population and allocates only finished leaves', () => {
    const result = resolveProductionOrderCostAllocation(input());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(
      result.rollCosts.map(({ rollDispatchItemId, input: cost }) => [
        rollDispatchItemId,
        cost.denominator.rows.find((row) => row.rollDispatchItemId === rollDispatchItemId)
          ?.allocatedAmountKopecks,
      ]),
    ).toEqual([
      ['roll-1', 2],
      ['roll-2', 1],
    ]);
    expect(result.sealProof.rows).toEqual([
      expect.objectContaining({ rollDispatchItemId: 'defect-source', hasDefect: true }),
      expect.objectContaining({ rollDispatchItemId: 'roll-1', hasDefect: false }),
      expect.objectContaining({ rollDispatchItemId: 'roll-2', hasDefect: false }),
      expect.objectContaining({ rollDispatchItemId: 'written-off-defect', hasDefect: true }),
    ]);
    expect(result.rollCosts[0].input).toMatchObject({
      productionOrderId: 'production-order-1',
      sealFingerprint: result.sealFingerprint,
    });
  });

  it.each([
    ['nonterminal row', { rolls: [{ ...input().rolls[1], status: 'in_progress' }] }],
    [
      'missing replacement target',
      {
        rolls: [
          {
            ...input().rolls[0],
            replacementAttemptId: 'missing',
          },
          input().rolls[1],
        ],
      },
    ],
    [
      'duplicate roll id',
      { rolls: [input().rolls[1], { ...input().rolls[2], rollDispatchItemId: 'roll-1' }] },
    ],
    [
      'duplicate canonical capture',
      {
        rolls: [input().rolls[1], { ...input().rolls[2], canonicalCaptureId: 'capture-1' }],
      },
    ],
    ['missing finished capture', { rolls: [{ ...input().rolls[1], canonicalCaptureId: null }] }],
    ['nonpositive finished weight', { rolls: [{ ...input().rolls[1], weightGrams: 0 }] }],
    ['no finished leaves', { rolls: [input().rolls[0], input().rolls[3]] }],
  ] as const)('keeps an unsealed or ambiguous population unresolved: %s', (_label, patch) => {
    expect(resolveProductionOrderCostAllocation(input(patch as never))).toMatchObject({
      kind: 'unresolved',
      reason: 'order_cost_allocation_unresolved',
      safeInputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('is input-order independent and fingerprints every seal fact', () => {
    const baseline = resolveProductionOrderCostAllocation(input());
    const reordered = resolveProductionOrderCostAllocation(
      input({ rolls: [...input().rolls].reverse() }),
    );
    const changed = resolveProductionOrderCostAllocation(
      input({
        rolls: input().rolls.map((roll) =>
          roll.rollDispatchItemId === 'written-off-defect'
            ? { ...roll, canonicalCaptureId: 'capture-defect-changed' }
            : roll,
        ),
      }),
    );

    expect(baseline.kind).toBe('resolved');
    expect(reordered.kind).toBe('resolved');
    expect(changed.kind).toBe('resolved');
    if (
      baseline.kind !== 'resolved' ||
      reordered.kind !== 'resolved' ||
      changed.kind !== 'resolved'
    ) {
      return;
    }
    expect(reordered.sealFingerprint).toBe(baseline.sealFingerprint);
    expect(changed.sealFingerprint).not.toBe(baseline.sealFingerprint);
  });

  it('keeps unresolved population changes version-visible and retries stable', () => {
    const first = resolveProductionOrderCostAllocation(
      input({ rolls: [{ ...input().rolls[1], status: 'new' }] }),
    );
    const retry = resolveProductionOrderCostAllocation(
      input({ rolls: [{ ...input().rolls[1], status: 'new' }] }),
    );
    const changed = resolveProductionOrderCostAllocation(
      input({ rolls: [{ ...input().rolls[1], status: 'assigned' }] }),
    );

    expect(first).toEqual(retry);
    expect(first.kind).toBe('unresolved');
    expect(changed.kind).toBe('unresolved');
    if (first.kind !== 'unresolved' || changed.kind !== 'unresolved') return;
    expect(changed.safeInputFingerprint).not.toBe(first.safeInputFingerprint);
  });
});
