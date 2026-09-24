import {
  resolveShiftBigBagMaterialBatch,
  type ShiftBigBagMaterialBatchInput,
} from './shift-bigbag-material-batch';

const PRODUCED_AT = new Date('2026-08-02T10:00:00.000Z');

function input(
  overrides: Partial<ShiftBigBagMaterialBatchInput> = {},
): ShiftBigBagMaterialBatchInput {
  return {
    rootSession: {
      id: 'session-1',
      status: 'closed',
      endedAt: new Date('2026-08-02T18:00:00.000Z'),
    },
    shift: {
      id: 'shift-1',
      status: 'closed',
      endedAt: new Date('2026-08-02T18:00:00.000Z'),
    },
    rolls: [
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 1,
        producedAt: PRODUCED_AT,
        isCanonicalLeaf: true,
        isFinishedGood: true,
      },
      {
        rollDispatchItemId: 'roll-2',
        canonicalCaptureId: 'capture-2',
        weightGrams: 1,
        producedAt: PRODUCED_AT,
        isCanonicalLeaf: true,
        isFinishedGood: true,
      },
    ],
    usages: [
      {
        usageId: 'usage-1',
        bigBagId: 'bag-1',
        materialDefinitionId: 'material-1',
        label: 'BB-1 · ПНД',
        startGrams: 2,
        endGrams: 0,
        priceKopecksPerKg: 333,
        effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ],
    ...overrides,
  };
}

describe('strict ShiftBagUsage material batch resolver', () => {
  it('rounds a usage total first, then allocates grams and money independently', () => {
    const result = resolveShiftBigBagMaterialBatch(input());

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    const [first, second] = result.rollBases;
    expect(first.materialBasis.sources[0].denominator.rows).toEqual([
      expect.objectContaining({
        rollDispatchItemId: 'roll-1',
        allocatedGrams: 1,
        allocatedAmountKopecks: 1,
      }),
      expect.objectContaining({
        rollDispatchItemId: 'roll-2',
        allocatedGrams: 1,
        allocatedAmountKopecks: 0,
      }),
    ]);
    expect(first.materialBasis.sources[0].totalAmountKopecks).toBe(1);
    expect(second.materialBasis.sources[0].denominatorFingerprint).toBe(
      first.materialBasis.sources[0].denominatorFingerprint,
    );
  });

  it('preserves existing 10/20 kg proportional material allocations', () => {
    const result = resolveShiftBigBagMaterialBatch(
      input({
        rolls: [
          { ...input().rolls[0], weightGrams: 10_000 },
          { ...input().rolls[1], weightGrams: 20_000 },
        ],
        usages: [
          {
            ...input().usages[0],
            startGrams: 300_000,
            priceKopecksPerKg: 1_000,
          },
        ],
      }),
    );

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    const rows = result.rollBases[0].materialBasis.sources[0].denominator.rows;
    expect(rows.map(({ allocatedAmountKopecks }) => allocatedAmountKopecks)).toEqual([
      100_000, 200_000,
    ]);
  });

  it('allocates every usage independently and is input-order independent', () => {
    const second = {
      ...input().usages[0],
      usageId: 'usage-2',
      bigBagId: 'bag-2',
      startGrams: 3,
      priceKopecksPerKg: 500,
    };
    const forward = resolveShiftBigBagMaterialBatch(input({ usages: [...input().usages, second] }));
    const reversed = resolveShiftBigBagMaterialBatch(
      input({ rolls: [...input().rolls].reverse(), usages: [second, ...input().usages] }),
    );

    expect(forward.kind).toBe('resolved');
    expect(reversed.kind).toBe('resolved');
    if (forward.kind !== 'resolved' || reversed.kind !== 'resolved') return;
    expect(forward.batchFingerprint).toBe(reversed.batchFingerprint);
    expect(forward.rollBases[0].materialBasis.sources).toHaveLength(2);
  });

  it.each([
    [
      'canonical capture',
      { rolls: [{ ...input().rolls[0], canonicalCaptureId: 'changed' }, input().rolls[1]] },
    ],
    ['membership', { rolls: [input().rolls[0]] }],
    ['weight', { rolls: [{ ...input().rolls[0], weightGrams: 2 }, input().rolls[1]] }],
    ['usage', { usages: [{ ...input().usages[0], usageId: 'changed' }] }],
    ['price', { usages: [{ ...input().usages[0], priceKopecksPerKg: 334 }] }],
    ['date', { usages: [{ ...input().usages[0], effectiveAt: new Date('2026-07-31T00:00:00Z') }] }],
  ] as const)('changes its fingerprint when %s changes', (_label, patch) => {
    const baseline = resolveShiftBigBagMaterialBatch(input());
    const changed = resolveShiftBigBagMaterialBatch(input(patch as never));
    expect(baseline.kind).toBe('resolved');
    expect(changed.kind).toBe('resolved');
    if (baseline.kind !== 'resolved' || changed.kind !== 'resolved') return;
    expect(changed.batchFingerprint).not.toBe(baseline.batchFingerprint);
  });

  it.each([
    [
      'null end',
      { usages: [{ ...input().usages[0], endGrams: null }] },
      'material_usage_unresolved',
    ],
    [
      'nonpositive usage',
      { usages: [{ ...input().usages[0], endGrams: 2 }] },
      'material_usage_unresolved',
    ],
    [
      'future price',
      { usages: [{ ...input().usages[0], effectiveAt: new Date('2026-08-03T00:00:00Z') }] },
      'material_price_unresolved',
    ],
    [
      'open post session',
      { rootSession: { ...input().rootSession, status: 'active', endedAt: null } },
      'post_session_not_closed',
    ],
    [
      'open global shift',
      { shift: { ...input().shift, status: 'active', endedAt: null } },
      'shift_not_closed',
    ],
    [
      'noncanonical roll',
      { rolls: [{ ...input().rolls[0], isCanonicalLeaf: false }, input().rolls[1]] },
      'canonical_capture_unresolved',
    ],
  ] as const)(
    'keeps measured facts unresolved with no recipe fallback for %s',
    (_label, patch, reason) => {
      const result = resolveShiftBigBagMaterialBatch(input(patch as never));
      expect(result).toMatchObject({ kind: 'unresolved', reason });
    },
  );

  it('returns absent only when the session has no measured usage', () => {
    expect(resolveShiftBigBagMaterialBatch(input({ usages: [] }))).toEqual({ kind: 'absent' });
  });

  it('fingerprints safe observed facts when a measured usage is unresolved', () => {
    const firstInput = input({
      usages: [{ ...input().usages[0], usageId: 'usage-a', endGrams: null }],
    });
    const retry = resolveShiftBigBagMaterialBatch(firstInput);
    const same = resolveShiftBigBagMaterialBatch(firstInput);
    const changed = resolveShiftBigBagMaterialBatch(
      input({ usages: [{ ...input().usages[0], usageId: 'usage-b', endGrams: null }] }),
    );

    expect(retry).toMatchObject({
      kind: 'unresolved',
      observedSources: [
        { usageId: 'usage-a', bigBagId: 'bag-1', materialDefinitionId: 'material-1' },
      ],
      safeInputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(same).toEqual(retry);
    expect(changed).toMatchObject({
      kind: 'unresolved',
      observedSources: [
        { usageId: 'usage-b', bigBagId: 'bag-1', materialDefinitionId: 'material-1' },
      ],
    });
    if (retry.kind !== 'unresolved' || changed.kind !== 'unresolved') return;
    expect(changed.safeInputFingerprint).not.toBe(retry.safeInputFingerprint);
  });
});
