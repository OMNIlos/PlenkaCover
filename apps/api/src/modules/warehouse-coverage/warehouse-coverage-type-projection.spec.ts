import type { WarehouseCoverageProjection } from '@plenka/contracts';
import {
  projectTypeCoverage,
  type PublishedCoverageMatch,
  type SelectedCoveragePosition,
} from './warehouse-coverage-type-projection';

const BASE: WarehouseCoverageProjection = {
  workflowVersion: 2,
  state: 'awaiting_finance',
  stateVersion: 3,
  generation: 2,
  availability: 'verified_full',
  reasonCodes: ['full_cover_available'],
  nextOwner: 'finance',
  availableActions: [],
  requiredRollCount: 3,
  matchedRollCount: 3,
  uncertainRollCount: 0,
  calculatedAt: '2026-08-06T08:30:00.000Z',
  stale: false,
};

const POSITIONS: SelectedCoveragePosition[] = [
  {
    positionId: 'position-b',
    label: 'Плёнка Б',
    requiredRollCount: 1,
    filmType: 'пвд',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 82_000,
    widthMilliMm: 1_200_000,
    plannedLengthMilliM: 600_000,
    plannedWeightMilliKg: 52_000,
    spoolType: '76 мм',
    birka: 'гост',
    recipeName: 'Белая',
    ingredients: [
      { name: ' Мел ', shareBasisPoints: 2_000 },
      { name: 'ПВД', shareBasisPoints: 8_000 },
    ],
  },
  {
    positionId: 'position-a',
    label: 'Плёнка А',
    requiredRollCount: 2,
    filmType: 'пнд',
    actualThicknessMilliMicron: 60_000,
    accountingThicknessMilliMicron: 62_000,
    widthMilliMm: 1_000_000,
    plannedLengthMilliM: 500_000,
    plannedWeightMilliKg: 40_000,
    spoolType: '76 мм',
    birka: 'стандарт',
    recipeName: 'Синяя',
    ingredients: [
      { name: 'ПНД', shareBasisPoints: 7_000 },
      { name: ' краситель ', shareBasisPoints: 1_000 },
      { name: 'Краситель', shareBasisPoints: 2_000 },
    ],
  },
];

function publishedMatch(
  position: SelectedCoveragePosition,
  actualWeightMilliKg: number,
  overrides: Partial<PublishedCoverageMatch> = {},
): PublishedCoverageMatch {
  return {
    positionId: position.positionId,
    filmType: position.filmType,
    actualThicknessMilliMicron: position.actualThicknessMilliMicron,
    accountingThicknessMilliMicron: position.accountingThicknessMilliMicron,
    widthMilliMm: position.widthMilliMm,
    plannedLengthMilliM: position.plannedLengthMilliM,
    actualWeightMilliKg,
    spoolType: position.spoolType,
    birka: position.birka,
    recipeName: position.recipeName,
    ingredients: position.ingredients,
    ...overrides,
  };
}

describe('projectTypeCoverage', () => {
  it('emits one stable row per position and preserves base required and matched totals', () => {
    const projected = projectTypeCoverage({
      base: BASE,
      positions: POSITIONS,
      matches: [
        publishedMatch(POSITIONS[1]!, 39_000),
        publishedMatch(POSITIONS[0]!, 52_000),
        publishedMatch(POSITIONS[1]!, 41_000),
      ],
    });

    expect(projected).toHaveLength(2);
    expect(projected.map(({ positionId }) => positionId)).toEqual(['position-a', 'position-b']);
    expect(projected.reduce((sum, row) => sum + row.requiredRollCount, 0)).toBe(
      BASE.requiredRollCount,
    );
    expect(projected.reduce((sum, row) => sum + row.matchedRollCount, 0)).toBe(
      BASE.matchedRollCount,
    );
  });

  it('aggregates matched weights as minimum, maximum, and total kilograms', () => {
    const [projected] = projectTypeCoverage({
      base: { ...BASE, requiredRollCount: 2, matchedRollCount: 2 },
      positions: [POSITIONS[1]!],
      matches: [publishedMatch(POSITIONS[1]!, 39_125), publishedMatch(POSITIONS[1]!, 40_875)],
    });

    expect(projected?.requested.weightKg).toBe(40);
    expect(projected?.matched.weightKg).toEqual({
      min: 39.125,
      max: 40.875,
      total: 80,
    });
  });

  it('derives all nine comparison flags from every published match fact', () => {
    const position = POSITIONS[1]!;
    const [projected] = projectTypeCoverage({
      base: { ...BASE, requiredRollCount: 1, matchedRollCount: 1 },
      positions: [{ ...position, requiredRollCount: 1 }],
      matches: [
        publishedMatch(position, 50_000, {
          filmType: 'пвд',
          actualThicknessMilliMicron: 61_000,
          accountingThicknessMilliMicron: 63_000,
          widthMilliMm: 1_100_000,
          plannedLengthMilliM: 510_000,
          spoolType: '152 мм',
          birka: 'другая',
          ingredients: [{ name: 'ПНД', shareBasisPoints: 10_000 }],
        }),
      ],
    });

    expect(projected?.comparison).toEqual({
      filmType: false,
      actualThickness: false,
      accountingThickness: false,
      width: false,
      plannedLength: false,
      weightTolerance: false,
      spoolType: false,
      birka: false,
      ingredients: false,
    });
  });

  it('keeps ingredient order stable and collapses duplicate normalized names', () => {
    const projectedForward = projectTypeCoverage({
      base: { ...BASE, requiredRollCount: 2, matchedRollCount: 2 },
      positions: [POSITIONS[1]!],
      matches: [publishedMatch(POSITIONS[1]!, 39_000), publishedMatch(POSITIONS[1]!, 41_000)],
    });
    const projectedReverse = projectTypeCoverage({
      base: { ...BASE, requiredRollCount: 2, matchedRollCount: 2 },
      positions: [
        {
          ...POSITIONS[1]!,
          ingredients: [...POSITIONS[1]!.ingredients].reverse(),
        },
      ],
      matches: [
        publishedMatch(POSITIONS[1]!, 41_000, {
          ingredients: [...POSITIONS[1]!.ingredients].reverse(),
        }),
        publishedMatch(POSITIONS[1]!, 39_000),
      ],
    });

    expect(projectedForward[0]?.requested.ingredients).toEqual([
      { name: 'Краситель', shareBasisPoints: 3_000 },
      { name: 'ПНД', shareBasisPoints: 7_000 },
    ]);
    expect(projectedReverse[0]?.requested.ingredients).toEqual(
      projectedForward[0]?.requested.ingredients,
    );
    expect(projectedReverse[0]?.matched.ingredients).toEqual(
      projectedForward[0]?.matched.ingredients,
    );
  });

  it.each([
    ['stale', { stale: true }],
    ['unknown', { availability: 'unknown' as const }],
    ['unavailable', { availability: 'unavailable' as const }],
    ['calculating', { state: 'calculating' as const, availability: null, generation: null }],
  ])('returns no type coverage for a %s base projection', (_label, overrides) => {
    expect(
      projectTypeCoverage({
        base: { ...BASE, ...overrides },
        positions: POSITIONS,
        matches: [publishedMatch(POSITIONS[0]!, 52_000)],
      }),
    ).toEqual([]);
  });

  it('serializes no physical-roll, fact, calculation, fingerprint, or raw keys', () => {
    const projected = projectTypeCoverage({
      base: BASE,
      positions: POSITIONS,
      matches: [
        publishedMatch(POSITIONS[0]!, 52_000),
        publishedMatch(POSITIONS[1]!, 39_000),
        publishedMatch(POSITIONS[1]!, 41_000),
      ],
    });

    expect(JSON.stringify(projected)).not.toMatch(
      /roll(Id|Code)|factId|calculationId|fingerprint|raw/iu,
    );
  });
});
