import type {
  DirectorAnalyticsBigBagEvidence,
  DirectorAnalyticsBigBagEvidenceQuery,
  DirectorAnalyticsShiftEvidence,
  DirectorAnalyticsShiftEvidenceQuery,
} from '@plenka/contracts';
import { matchesBigBagEvidence, matchesShiftEvidence } from './director-evidence.filter';

const baseQuery = {
  from: '2026-07-01',
  to: '2026-07-31',
  bucket: 'day',
} as const;

const shiftRow: DirectorAnalyticsShiftEvidence = {
  sessionId: 'session-1',
  shiftId: 'shift-1',
  shiftLabel: 'Ночная смена',
  operatorId: 'operator-1',
  operatorName: 'Анна Смирнова',
  postId: 'post-1',
  postCode: 'POST-1',
  postName: 'Экструдер 1',
  startedAt: '2026-07-14T20:30:00.000Z',
  endedAt: '2026-07-15T01:30:00.000Z',
  bigBags: [
    {
      usageId: 'usage-1',
      bigBagId: 'bag-1',
      bigBagCode: 'BB-001',
      materialId: 'material-1',
      material: 'ПВД гранула',
      bigBagStatus: 'available',
      startKg: 100,
      endKg: 70,
      currentKg: 70,
      currentMeasuredAt: '2026-07-14T21:30:00.000Z',
      currentFreshness: 'fresh',
      openedAt: '2026-07-14T20:30:00.000Z',
      closedAt: '2026-07-15T01:30:00.000Z',
    },
  ],
  startKg: 100,
  endKg: 70,
  currentKg: 70,
  actualUsageKg: 30,
  expectedUsageKg: 25,
  producedKg: 25,
  rollCount: 2,
  defectKg: 1,
  defectCount: 1,
  unverifiedDefectCount: 1,
  deviationKg: 5,
  deviationPercent: 20,
  status: 'mismatch',
  source: {
    usage: 'shift_bag_usage',
    production: 'canonical_roll_weight_capture',
    defects: 'linked_stable_defect_weight_capture',
    latestEvidenceAt: '2026-07-14T21:30:00.000Z',
    freshness: 'fresh',
  },
};

const bigBagRow: DirectorAnalyticsBigBagEvidence = {
  id: 'usage-1',
  bigBagId: 'bag-1',
  bigBagCode: 'BB-001',
  materialId: 'material-1',
  material: 'ПВД гранула',
  bigBagStatus: 'available',
  sessionId: 'session-1',
  shiftId: 'shift-1',
  shiftLabel: 'Ночная смена',
  operatorId: 'operator-1',
  operatorName: 'Анна Смирнова',
  postId: 'post-1',
  postCode: 'POST-1',
  postName: 'Экструдер 1',
  openedAt: '2026-07-14T20:30:00.000Z',
  closedAt: '2026-07-15T01:30:00.000Z',
  startKg: 100,
  endKg: 70,
  currentKg: 69,
  currentMeasuredAt: '2026-07-14T21:30:00.000Z',
  priceKopecksPerKg: null,
  totalKopecks: null,
  priceEffectiveAt: null,
  bagUsageKg: 30,
  actualUsageKg: 30,
  expectedUsageKg: 25,
  producedKg: 25,
  rollCount: 2,
  defectKg: 1,
  defectCount: 1,
  unverifiedDefectCount: 1,
  deviationKg: 5,
  deviationPercent: 20,
  balanceScope: 'usage_episodes',
  status: 'mismatch',
  source: {
    usage: 'shift_bag_usage',
    production: 'canonical_roll_weight_capture',
    defects: 'linked_stable_defect_weight_capture',
    latestEvidenceAt: '2026-07-14T21:30:00.000Z',
    freshness: 'fresh',
  },
};

function shiftQuery(
  filter: Partial<DirectorAnalyticsShiftEvidenceQuery> = {},
): DirectorAnalyticsShiftEvidenceQuery {
  return { ...baseQuery, ...filter };
}

function bigBagQuery(
  filter: Partial<DirectorAnalyticsBigBagEvidenceQuery> = {},
): DirectorAnalyticsBigBagEvidenceQuery {
  return { ...baseQuery, ...filter };
}

describe('matchesShiftEvidence', () => {
  it.each<[Partial<DirectorAnalyticsShiftEvidenceQuery>, boolean]>([
    [{ shiftQuery: 'ночная' }, true],
    [{ startedFrom: '2026-07-15' }, false],
    [{ endedFrom: '2026-07-15', endedTo: '2026-07-15' }, true],
    [{ operatorQuery: 'смирнова', postQuery: 'экструдер' }, true],
    [{ startKgMin: 101 }, false],
    [{ remainingKgMin: 69, remainingKgMax: 71 }, true],
    [{ actualUsageKgMax: 29 }, false],
    [{ expectedUsageKgMin: 25, expectedUsageKgMax: 25 }, true],
    [{ producedKgMin: 25 }, true],
    [{ rollCountMax: 1 }, false],
    [{ defectKgMin: 1, defectKgMax: 1 }, true],
    [{ defectCountMax: 0 }, false],
    [{ unverifiedDefectCountMin: 1 }, true],
    [{ deviationKgMin: 4, deviationKgMax: 6 }, true],
    [{ deviationPercentMin: 21 }, false],
    [{ status: 'ok' }, false],
    [{ freshness: 'stale' }, false],
    [{ operatorId: 'operator-1', postId: 'post-1', shiftId: 'shift-1' }, true],
    [{ bigBagId: 'bag-2' }, false],
  ])('matches shift column filter %j as %s', (filter, expected) => {
    expect(matchesShiftEvidence(shiftRow, shiftQuery(filter))).toBe(expected);
  });

  it('uses currentKg before endKg and falls back to endKg', () => {
    expect(
      matchesShiftEvidence(
        { ...shiftRow, currentKg: 70, endKg: 40 },
        shiftQuery({ remainingKgMin: 69, remainingKgMax: 71 }),
      ),
    ).toBe(true);
    expect(
      matchesShiftEvidence(
        { ...shiftRow, currentKg: null, endKg: 40 },
        shiftQuery({ remainingKgMin: 39, remainingKgMax: 41 }),
      ),
    ).toBe(true);
  });

  it.each([
    ['startKg', { startKgMin: 0 }],
    ['remainingKg', { remainingKgMin: 0 }],
    ['actualUsageKg', { actualUsageKgMin: 0 }],
    ['deviationKg', { deviationKgMin: -10 }],
  ] as const)('does not treat null %s as zero', (field, filter) => {
    const row =
      field === 'remainingKg'
        ? { ...shiftRow, currentKg: null, endKg: null }
        : { ...shiftRow, [field]: null };

    expect(matchesShiftEvidence(row, shiftQuery(filter))).toBe(false);
  });

  it('accepts a negative deviation inside a signed range', () => {
    expect(
      matchesShiftEvidence(
        { ...shiftRow, deviationKg: -5, deviationPercent: -20 },
        shiftQuery({
          deviationKgMin: -6,
          deviationKgMax: -4,
          deviationPercentMin: -21,
          deviationPercentMax: -19,
        }),
      ),
    ).toBe(true);
  });

  it.each([
    [{ shiftQuery: 'SESSION-1' }, true],
    [{ operatorQuery: 'аНнА' }, true],
    [{ postQuery: 'post-1' }, true],
    [{ q: 'bb-001' }, true],
    [{ q: 'пвд ГРАНУЛА' }, true],
  ] satisfies Array<[Partial<DirectorAnalyticsShiftEvidenceQuery>, boolean]>)(
    'matches shift text case-insensitively for %j',
    (filter, expected) => {
      expect(matchesShiftEvidence(shiftRow, shiftQuery(filter))).toBe(expected);
    },
  );

  it('restricts free search to safe projected fields', () => {
    const rowWithRawPayload = {
      ...shiftRow,
      rawPayload: 'device-secret-needle',
      bigBags: shiftRow.bigBags.map((bag) => ({
        ...bag,
        rawPayload: 'bag-secret-needle',
      })),
    };

    expect(matchesShiftEvidence(rowWithRawPayload, shiftQuery({ q: 'secret-needle' }))).toBe(false);
    expect(matchesShiftEvidence(rowWithRawPayload, shiftQuery({ q: 'экструдер' }))).toBe(true);
  });
});

describe('matchesBigBagEvidence', () => {
  it.each<[Partial<DirectorAnalyticsBigBagEvidenceQuery>, boolean]>([
    [{ bigBagQuery: 'bb-001', materialQuery: 'пвд' }, true],
    [{ bigBagStatus: 'consumed' }, false],
    [{ shiftQuery: 'ночная', operatorQuery: 'анна', postQuery: 'post-1' }, true],
    [{ openedFrom: '2026-07-15' }, false],
    [{ closedFrom: '2026-07-15', closedTo: '2026-07-15' }, true],
    [{ usageState: 'closed' }, true],
    [{ startKgMin: 101 }, false],
    [{ endKgMin: 69, endKgMax: 71 }, true],
    [{ currentKgMax: 68 }, false],
    [{ bagUsageKgMin: 30, bagUsageKgMax: 30 }, true],
    [{ actualUsageKgMax: 29 }, false],
    [{ expectedUsageKgMin: 25, expectedUsageKgMax: 25 }, true],
    [{ producedKgMin: 25 }, true],
    [{ rollCountMax: 1 }, false],
    [{ defectKgMin: 1, defectKgMax: 1 }, true],
    [{ defectCountMax: 0 }, false],
    [{ unverifiedDefectCountMin: 1 }, true],
    [{ deviationKgMin: 4, deviationKgMax: 6 }, true],
    [{ deviationPercentMin: 21 }, false],
    [{ status: 'ok' }, false],
    [{ freshness: 'stale' }, false],
    [
      {
        operatorId: 'operator-1',
        postId: 'post-1',
        shiftId: 'shift-1',
        bigBagId: 'bag-1',
      },
      true,
    ],
  ])('matches BigBag column filter %j as %s', (filter, expected) => {
    expect(matchesBigBagEvidence(bigBagRow, bigBagQuery(filter))).toBe(expected);
  });

  it('requires closedAt null for open usage state', () => {
    expect(
      matchesBigBagEvidence(
        { ...bigBagRow, closedAt: null, endKg: null, bagUsageKg: null },
        bigBagQuery({ usageState: 'open' }),
      ),
    ).toBe(true);
    expect(matchesBigBagEvidence(bigBagRow, bigBagQuery({ usageState: 'open' }))).toBe(false);
  });

  it.each([
    ['endKg', { endKgMin: 0 }],
    ['currentKg', { currentKgMin: 0 }],
    ['bagUsageKg', { bagUsageKgMin: 0 }],
    ['actualUsageKg', { actualUsageKgMin: 0 }],
    ['deviationPercent', { deviationPercentMin: -10 }],
  ] as const)('does not treat null %s as zero', (field, filter) => {
    expect(matchesBigBagEvidence({ ...bigBagRow, [field]: null }, bigBagQuery(filter))).toBe(false);
  });

  it('accepts a negative deviation inside a signed range', () => {
    expect(
      matchesBigBagEvidence(
        { ...bigBagRow, deviationKg: -5, deviationPercent: -20 },
        bigBagQuery({
          deviationKgMin: -6,
          deviationKgMax: -4,
          deviationPercentMin: -21,
          deviationPercentMax: -19,
        }),
      ),
    ).toBe(true);
  });

  it.each([
    [{ bigBagQuery: 'BAG-1' }, true],
    [{ materialQuery: 'MATERIAL-1' }, true],
    [{ shiftQuery: 'SESSION-1' }, true],
    [{ operatorQuery: 'сМиРнОвА' }, true],
    [{ postQuery: 'ЭКСТРУДЕР' }, true],
    [{ q: 'bb-001' }, true],
    [{ q: 'пвд гранула' }, true],
  ] satisfies Array<[Partial<DirectorAnalyticsBigBagEvidenceQuery>, boolean]>)(
    'matches BigBag text case-insensitively for %j',
    (filter, expected) => {
      expect(matchesBigBagEvidence(bigBagRow, bigBagQuery(filter))).toBe(expected);
    },
  );

  it('restricts free search to safe projected fields', () => {
    const rowWithRawPayload = { ...bigBagRow, rawPayload: 'device-secret-needle' };

    expect(matchesBigBagEvidence(rowWithRawPayload, bigBagQuery({ q: 'secret-needle' }))).toBe(
      false,
    );
    expect(matchesBigBagEvidence(rowWithRawPayload, bigBagQuery({ q: 'ночная' }))).toBe(true);
  });
});

describe('Moscow-local inclusive evidence bounds', () => {
  it.each([
    [
      matchesShiftEvidence,
      shiftRow,
      shiftQuery({ latestEvidenceFrom: '2026-07-15', latestEvidenceTo: '2026-07-15' }),
    ],
    [
      matchesBigBagEvidence,
      bigBagRow,
      bigBagQuery({ latestEvidenceFrom: '2026-07-15', latestEvidenceTo: '2026-07-15' }),
    ],
  ] as const)('matches UTC evidence after Moscow midnight', (predicate, row, query) => {
    expect(predicate(row as never, query as never)).toBe(true);
  });

  it.each([
    [
      matchesShiftEvidence,
      { ...shiftRow, source: { ...shiftRow.source, latestEvidenceAt: null } },
      shiftQuery({ latestEvidenceFrom: '2026-07-01' }),
    ],
    [
      matchesBigBagEvidence,
      { ...bigBagRow, source: { ...bigBagRow.source, latestEvidenceAt: null } },
      bigBagQuery({ latestEvidenceFrom: '2026-07-01' }),
    ],
  ] as const)('rejects null latest evidence when a date bound exists', (predicate, row, query) => {
    expect(predicate(row as never, query as never)).toBe(false);
  });
});
