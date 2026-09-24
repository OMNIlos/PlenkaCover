import {
  calculateActualEpisodeUsageKg,
  calculateExpectedActiveResidueKg,
  resolveCanonicalShiftBagUsageFacts,
  type ShiftBagEpisodeFact,
} from './shift-bag-episode-balance';

const released = (startKg: number, endKg: number): ShiftBagEpisodeFact => ({
  startKg,
  endKg,
  closeKind: 'released',
});

const active = (startKg: number): ShiftBagEpisodeFact => ({
  startKg,
  endKg: null,
  closeKind: null,
});

describe('shift BigBag episode balance', () => {
  it('reports zero residue and exact usage for a shift without BigBag episodes', () => {
    expect(calculateExpectedActiveResidueKg([], 0)).toBe(0);
    expect(calculateActualEpisodeUsageKg([])).toBe(0);
  });

  it('subtracts canonical expected usage from every active BigBag start', () => {
    expect(calculateExpectedActiveResidueKg([active(500)], 100)).toBe(400);
    expect(calculateExpectedActiveResidueKg([active(500), active(300)], 100)).toBe(700);
  });

  it('does not count a returned remainder as consumption when the same bag is re-added', () => {
    const episodes = [released(500, 450), active(450)];

    expect(calculateExpectedActiveResidueKg(episodes, 100)).toBe(400);
  });

  it('sums each episode delta once after every final weight is known', () => {
    const episodes: ShiftBagEpisodeFact[] = [
      released(500, 450),
      { startKg: 450, endKg: 400, closeKind: 'shift_closed' },
    ];

    expect(calculateActualEpisodeUsageKg(episodes)).toBe(100);
  });

  it('keeps actual usage pending while any episode has no final weight', () => {
    expect(calculateActualEpisodeUsageKg([released(500, 450), active(450)])).toBeNull();
  });

  it('rounds only the public kilogram result to three decimals', () => {
    expect(calculateExpectedActiveResidueKg([released(0.3334, 0.1111), active(0.1111)], 0.1)).toBe(
      0.233,
    );
    expect(
      calculateActualEpisodeUsageKg([
        released(0.3334, 0.1111),
        { startKg: 0.1111, endKg: 0.01, closeKind: 'shift_closed' },
      ]),
    ).toBe(0.323);
  });

  it('exposes all confirmed episode deltas instead of the latest stable-link projection', () => {
    const facts = resolveCanonicalShiftBagUsageFacts({
      startKg: 450,
      endKg: 400,
      closedAt: new Date('2026-08-08T10:00:00.000Z'),
      releasedReason: null,
      episodes: [
        {
          sequence: 1,
          startKg: 500,
          endKg: 450,
          closeKind: 'released',
          closedAt: new Date('2026-08-08T09:00:00.000Z'),
        },
        {
          sequence: 2,
          startKg: 450,
          endKg: 400,
          closeKind: 'shift_closed',
          closedAt: new Date('2026-08-08T10:00:00.000Z'),
        },
      ],
    });

    expect(facts).toEqual(
      expect.objectContaining({ episodeCount: 2, confirmedUsageKg: 100, actualUsageKg: 100 }),
    );
  });

  it('keeps a safe legacy fallback until old stable links acquire episodes', () => {
    expect(
      resolveCanonicalShiftBagUsageFacts({
        startKg: 500,
        endKg: 450,
        closedAt: new Date('2026-08-08T09:00:00.000Z'),
        releasedReason: 'legacy release',
        episodes: [],
      }),
    ).toEqual(
      expect.objectContaining({ episodeCount: 1, confirmedUsageKg: 50, actualUsageKg: 50 }),
    );
  });

  it('exposes confirmed history but withholds exact actual usage while an episode is open', () => {
    expect(
      resolveCanonicalShiftBagUsageFacts({
        startKg: 450,
        endKg: null,
        closedAt: null,
        releasedReason: null,
        episodes: [
          {
            sequence: 1,
            startKg: 500,
            endKg: 450,
            closeKind: 'released',
            closedAt: new Date('2026-08-08T09:00:00.000Z'),
          },
          { sequence: 2, startKg: 450, endKg: null, closeKind: null, closedAt: null },
        ],
      }),
    ).toEqual(
      expect.objectContaining({ episodeCount: 2, confirmedUsageKg: 50, actualUsageKg: null }),
    );
  });

  it('fails closed on an episode close kind outside the database contract', () => {
    expect(() =>
      resolveCanonicalShiftBagUsageFacts({
        startKg: 500,
        endKg: 450,
        closedAt: new Date('2026-08-08T09:00:00.000Z'),
        releasedReason: null,
        episodes: [
          {
            sequence: 1,
            startKg: 500,
            endKg: 450,
            closeKind: 'rewritten_history',
            closedAt: new Date('2026-08-08T09:00:00.000Z'),
          },
        ],
      }),
    ).toThrow(RangeError);
  });
});
