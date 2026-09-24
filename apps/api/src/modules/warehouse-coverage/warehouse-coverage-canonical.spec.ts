import {
  canonicalizeCoveragePosition,
  canonicalizeRollCoverageSpec,
  compareOpaqueIdsBinary,
  coverageSpecsCompatible,
  fingerprintRollFact,
  isWeightWithinFivePercent,
  normalizeCoverageText,
  normalizeIngredients,
  normalizeSpool,
  parseKgToMilliKg,
  parseThicknessMilliMicron,
} from './warehouse-coverage-canonical';
import {
  buildVerifiedCandidate,
  sortCandidateCode,
  type UncertainCoverageCandidate,
  type VerifiedCoverageCandidate,
} from './warehouse-coverage-matcher';

const orderId = 'order-A';
const positionId = 'position-A';
const ownerCounterpartyId = 'counterparty-A';
const recipeDefinitionId = 'recipe-definition-A';
const recipeDefinitionVersionId = 'recipe-definition-version-A';
const coverageFactId = 'coverage-fact-A';
const recheckCaseId = 'recheck-case-A';

const ingredients = [
  { rawMaterialDefinitionId: 'material-b', shareBasisPoints: 4_000 },
  { rawMaterialDefinitionId: 'material-a', shareBasisPoints: 6_000 },
] as const;

function completePositionInput(overrides: Record<string, unknown> = {}) {
  return {
    positionId,
    rollCount: 1,
    filmType: 'Плёнка   ПЭ',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 78_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: '  Прозрачная ',
    spoolType: 'Шпуля 76 мм',
    plannedWeightMilliKg: 275_000,
    ingredients,
    recipeId: 'recipe-A',
    recipeVersion: 'v7',
    recipeDefinitionId,
    recipeDefinitionVersionId,
    recipeVersionNumber: 7,
    ...overrides,
  };
}

function completeRollFactInput(overrides: Record<string, unknown> = {}) {
  return {
    rollCode: 'ROLL-A',
    sourceOrderId: orderId,
    sourcePositionId: positionId,
    ownerCounterpartyId,
    filmType: 'пленка пэ',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 78_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: 'прозрачная',
    spoolType: '76mm',
    actualWeightMilliKg: 275_125,
    plannedWeightMilliKg: 275_000,
    ingredients,
    recipeId: 'recipe-A',
    recipeVersion: 'v7',
    recipeDefinitionId,
    recipeDefinitionVersionId,
    recipeVersionNumber: 7,
    policyVersion: 'warehouse-coverage-policy/v2',
    ...overrides,
  };
}

function without(source: Record<string, unknown>, key: string) {
  const result = { ...source };
  delete result[key];
  return result;
}

describe('warehouse coverage canonical specification', () => {
  it.each([
    ['Плёнка   ПЭ', 'пленка пэ'],
    ['пленка пе', 'пленка пе'],
  ])('normalizes business text %s', (source, expected) => {
    expect(normalizeCoverageText(source)).toBe(expected);
  });

  it('keeps IDs opaque and rejects imprecise measurements', () => {
    expect(compareOpaqueIdsBinary('A', 'a')).not.toBe(0);
    expect(() => compareOpaqueIdsBinary('\ud800', 'valid-id')).toThrow('well-formed Unicode');
    expect(() => parseKgToMilliKg('1.0001')).toThrow('at most 3 decimal places');
    expect(parseKgToMilliKg('275,125')).toBe(275_125);
    expect(parseThicknessMilliMicron('80 мкм')).toBe(80_000);
    expect(() => parseThicknessMilliMicron('80/90 мкм')).toThrow('one positive decimal');
    expect(normalizeSpool('Шпуля 76 мм')).toBe('76 мм');
    expect(normalizeSpool('76mm')).toBe('76 мм');
    expect(isWeightWithinFivePercent(95_000, 100_000)).toBe(true);
    expect(isWeightWithinFivePercent(94_999, 100_000)).toBe(false);
  });

  it('requires an exact ten-thousand basis-point recipe', () => {
    expect(() =>
      normalizeIngredients([
        { rawMaterialDefinitionId: 'b', shareBasisPoints: 4_999 },
        { rawMaterialDefinitionId: 'a', shareBasisPoints: 5_000 },
      ]),
    ).toThrow('10_000');
    expect(
      normalizeIngredients([
        { rawMaterialDefinitionId: 'b', shareBasisPoints: 5_000 },
        { rawMaterialDefinitionId: 'a', shareBasisPoints: 5_000 },
      ]).map((part: { rawMaterialDefinitionId: string }) => part.rawMaterialDefinitionId),
    ).toEqual(['a', 'b']);
    expect(() =>
      normalizeIngredients([
        { rawMaterialDefinitionId: 'same', shareBasisPoints: 5_000 },
        { rawMaterialDefinitionId: 'same', shareBasisPoints: 5_000 },
      ]),
    ).toThrow('duplicate');
  });

  it('accepts a complete recipe with more than fifty components', () => {
    const manyIngredients = Array.from({ length: 51 }, (_, index) => ({
      rawMaterialDefinitionId: `material-${String(index).padStart(2, '0')}`,
      shareBasisPoints: index === 50 ? 200 : 196,
    }));
    expect(normalizeIngredients(manyIngredients)).toHaveLength(51);
    expect(
      normalizeIngredients(manyIngredients).reduce(
        (sum, ingredient) => sum + ingredient.shareBasisPoints,
        0,
      ),
    ).toBe(10_000);
  });

  it('rejects unexpected top-level fact and position fields', () => {
    expect(() =>
      canonicalizeCoveragePosition({
        ...completePositionInput(),
        actualWeightKg: '275.000',
      }),
    ).toThrow('unexpected key actualWeightKg');
    expect(() =>
      canonicalizeRollCoverageSpec({
        ...completeRollFactInput(),
        rawDevicePayload: { stable: true },
      }),
    ).toThrow('unexpected key rawDevicePayload');
  });

  it('preserves nullable fact provenance and fingerprints recipe provenance', () => {
    const fact = canonicalizeRollCoverageSpec(completeRollFactInput());
    expect(fact).toMatchObject({
      sourceOrderId: orderId,
      sourcePositionId: positionId,
      ownerCounterpartyId,
      plannedWeightMilliKg: 275_000,
      widthMilliMm: 1_700_000,
      plannedLengthMilliM: 275_000,
      recipeVersion: 'v7',
      recipeDefinitionId,
      recipeDefinitionVersionId,
      recipeVersionNumber: 7,
      policyVersion: 'warehouse-coverage-policy/v2',
    });
    for (const missing of [
      'sourceOrderId',
      'sourcePositionId',
      'plannedWeightMilliKg',
      'recipeVersion',
    ] as const) {
      expect(() => canonicalizeRollCoverageSpec(without(completeRollFactInput(), missing))).toThrow(
        missing,
      );
    }
    expect(
      canonicalizeRollCoverageSpec({
        ...completeRollFactInput(),
        sourceOrderId: null,
        sourcePositionId: null,
        ownerCounterpartyId: null,
      }),
    ).toMatchObject({
      sourceOrderId: null,
      sourcePositionId: null,
      ownerCounterpartyId: null,
    });
    expect(fingerprintRollFact(fact)).not.toBe(
      fingerprintRollFact({
        ...fact,
        recipeVersion: 'v8',
        recipeVersionNumber: 8,
      }),
    );
    expect(
      fingerprintRollFact(
        canonicalizeRollCoverageSpec({
          ...completeRollFactInput(),
          ingredients: [...ingredients].reverse(),
        }),
      ),
    ).toBe(fingerprintRollFact(fact));
  });

  it('preserves recipe provenance but ignores recipe identity in compatibility', () => {
    const position = canonicalizeCoveragePosition(
      completePositionInput({ recipeId: 'recipe-order', recipeVersion: 'v3' }),
    );
    const roll = canonicalizeRollCoverageSpec(
      completeRollFactInput({
        recipeId: 'recipe-roll',
        recipeVersion: 'v9',
        ingredients: position.ingredients,
      }),
    );
    expect(coverageSpecsCompatible(position, roll)).toBe(true);
    expect(
      coverageSpecsCompatible(position, {
        ...roll,
        ingredients: [{ rawMaterialDefinitionId: 'different', shareBasisPoints: 10_000 }],
      }),
    ).toBe(false);
    expect(coverageSpecsCompatible(position, { ...roll, widthMilliMm: 1_600_000 })).toBe(false);
    expect(coverageSpecsCompatible(position, { ...roll, plannedLengthMilliM: 300_000 })).toBe(
      false,
    );
  });

  it('locks verified and uncertain candidate boundaries at compile time and runtime', () => {
    const verified = buildVerifiedCandidate({
      rollId: 'roll-A',
      coverageFactId,
      spec: canonicalizeRollCoverageSpec(completeRollFactInput()),
    }) satisfies VerifiedCoverageCandidate;
    const uncertain = {
      rollId: 'roll-uncertain',
      rollCode: 'ROLL-UNCERTAIN',
      ownerCounterpartyId: null,
      sourceOrderId: orderId,
      sourcePositionId: positionId,
      recheckCaseId,
      recheckOrderId: orderId,
      coverageFactId: null,
      known: {
        filmType: 'пленка пэ',
        actualThicknessMilliMicron: 80_000,
        accountingThicknessMilliMicron: 78_000,
        widthMilliMm: 1_700_000,
        plannedLengthMilliM: 275_000,
        birka: 'прозрачная',
        spoolType: '76 мм',
        actualWeightMilliKg: null,
        plannedWeightMilliKg: null,
        ingredients: null,
        policyVersion: null,
      },
      reasonCodes: ['roll_ownership_unverified'],
    } satisfies UncertainCoverageCandidate;
    expect(verified).toMatchObject({
      coverageFactId,
      spec: expect.objectContaining({
        ownerCounterpartyId,
        sourceOrderId: orderId,
        sourcePositionId: positionId,
      }),
    });
    expect(uncertain).toMatchObject({
      ownerCounterpartyId: null,
      coverageFactId: null,
      recheckCaseId,
      recheckOrderId: orderId,
      known: expect.objectContaining({ plannedWeightMilliKg: null }),
      reasonCodes: ['roll_ownership_unverified'],
    });
  });

  it('derives verified ownership, source and roll code only from the immutable fact', () => {
    const verified = buildVerifiedCandidate({
      rollId: 'roll-A',
      coverageFactId,
      spec: canonicalizeRollCoverageSpec(completeRollFactInput()),
    });
    expect(verified.spec.ownerCounterpartyId).toBe(ownerCounterpartyId);
    expect(sortCandidateCode(verified)).toBe(verified.spec.rollCode);
    expect(() =>
      buildVerifiedCandidate({
        rollId: 'roll-A',
        coverageFactId,
        spec: canonicalizeRollCoverageSpec(completeRollFactInput({ ownerCounterpartyId: null })),
      }),
    ).toThrow('verified owner');
  });
});
