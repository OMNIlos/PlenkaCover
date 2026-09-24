import {
  resolveCanonicalRollCaptureEvidence,
  resolveCanonicalRollCaptures,
  type RollCaptureFact,
} from './canonical-roll-capture';

const CAPTURED_AT = new Date('2026-07-22T09:00:00.000Z');

function capture(id: string, overrides: Partial<RollCaptureFact> = {}): RollCaptureFact {
  return {
    id,
    operatorRollLineId: 'line-1',
    kind: 'roll',
    stable: true,
    netKg: 10,
    supersedesCaptureId: null,
    createdAt: CAPTURED_AT,
    ...overrides,
  };
}

describe('resolveCanonicalRollCaptures', () => {
  it('returns one eligible base capture', () => {
    const base = capture('base');

    expect(resolveCanonicalRollCaptures([base])).toEqual([base]);
  });

  it.each([
    ['zero', 0],
    ['negative', -0.55],
    ['non-finite', Number.NaN],
  ])('does not treat a %s net weight as a canonical production fact', (_label, netKg) => {
    expect(resolveCanonicalRollCaptures([capture('invalid', { netKg })])).toEqual([]);
  });

  it('keeps an invalid root available as recovery evidence without publishing it as a fact', () => {
    const invalid = capture('invalid', { netKg: -0.55 });

    expect(resolveCanonicalRollCaptureEvidence([invalid])).toEqual([invalid]);
    expect(resolveCanonicalRollCaptures([invalid])).toEqual([]);
  });

  it('publishes a valid append-only successor of an invalid recovery root', () => {
    const invalid = capture('invalid', { netKg: -0.55 });
    const recovered = capture('recovered', {
      netKg: 3,
      supersedesCaptureId: invalid.id,
      createdAt: new Date('2026-08-13T12:00:00.000Z'),
    });

    expect(resolveCanonicalRollCaptureEvidence([recovered, invalid])).toEqual([recovered]);
    expect(resolveCanonicalRollCaptures([recovered, invalid])).toEqual([recovered]);
  });

  it('returns the tail of an explicit base to reweigh to reweigh chain', () => {
    const base = capture('base', {
      createdAt: new Date('2026-07-22T09:00:00.000Z'),
    });
    const firstReweigh = capture('reweigh-1', {
      netKg: 10.2,
      supersedesCaptureId: base.id,
      createdAt: new Date('2026-07-22T09:01:00.000Z'),
    });
    const secondReweigh = capture('reweigh-2', {
      netKg: 10.4,
      supersedesCaptureId: firstReweigh.id,
      createdAt: new Date('2026-07-22T09:02:00.000Z'),
    });

    expect(resolveCanonicalRollCaptures([secondReweigh, base, firstReweigh])).toEqual([
      secondReweigh,
    ]);
  });

  it('keeps the earliest base when a legacy duplicate is unlinked', () => {
    const base = capture('base', {
      createdAt: new Date('2026-07-22T09:00:00.000Z'),
    });
    const duplicate = capture('legacy-duplicate', {
      netKg: 11,
      createdAt: new Date('2026-07-22T09:01:00.000Z'),
    });

    expect(resolveCanonicalRollCaptures([duplicate, base])).toEqual([base]);
  });

  it('stops at the last unambiguous capture when a chain forks', () => {
    const base = capture('base');
    const firstFork = capture('fork-1', {
      supersedesCaptureId: base.id,
      createdAt: new Date('2026-07-22T09:01:00.000Z'),
    });
    const secondFork = capture('fork-2', {
      supersedesCaptureId: base.id,
      createdAt: new Date('2026-07-22T09:02:00.000Z'),
    });

    expect(resolveCanonicalRollCaptures([base, firstFork, secondFork])).toEqual([base]);
  });

  it('returns no canonical capture for a cycle-only graph', () => {
    const first = capture('first', {
      supersedesCaptureId: 'second',
      createdAt: new Date('2026-07-22T09:00:00.000Z'),
    });
    const second = capture('second', {
      supersedesCaptureId: first.id,
      createdAt: new Date('2026-07-22T09:01:00.000Z'),
    });

    expect(resolveCanonicalRollCaptures([first, second])).toEqual([]);
  });

  it('returns no canonical capture when the only predecessor is missing', () => {
    const orphan = capture('orphan', {
      supersedesCaptureId: 'missing',
      createdAt: new Date('2026-07-22T09:01:00.000Z'),
    });

    expect(resolveCanonicalRollCaptures([orphan])).toEqual([]);
  });

  it('returns no canonical capture for a rootless cross-line graph', () => {
    const firstLineCapture = capture('line-1-linked', {
      supersedesCaptureId: 'missing',
      createdAt: new Date('2026-07-22T09:00:00.000Z'),
    });
    const crossLineCapture = capture('line-2-cross-link', {
      operatorRollLineId: 'line-2',
      supersedesCaptureId: firstLineCapture.id,
      createdAt: new Date('2026-07-22T09:01:00.000Z'),
    });

    expect(resolveCanonicalRollCaptures([crossLineCapture, firstLineCapture])).toEqual([]);
  });

  it('breaks equal createdAt ties by explicit string id order', () => {
    const laterId = capture('a-base');
    const earlierId = capture('Z-base');

    expect(resolveCanonicalRollCaptures([laterId, earlierId])).toEqual([earlierId]);
  });
});
