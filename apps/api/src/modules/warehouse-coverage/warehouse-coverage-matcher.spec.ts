import type { WarehouseCoverageAvailability } from '@plenka/contracts';
import { Worker } from 'node:worker_threads';
import * as canonicalModule from './warehouse-coverage-canonical';
import {
  canonicalizeCoveragePosition,
  canonicalizeRollCoverageSpec,
  type CanonicalCoveragePosition,
} from './warehouse-coverage-canonical';
import {
  buildVerifiedCandidate,
  matchWarehouseCoverage,
  type CandidateKnownCoverageFields,
  type UncertainCoverageCandidate,
  type VerifiedCoverageCandidate,
  type WarehouseCoverageMatcherInput,
} from './warehouse-coverage-matcher';

const orderId = 'order-A';
const counterpartyId = 'counterparty-A';
const ingredients = [{ rawMaterialDefinitionId: 'material-A', shareBasisPoints: 10_000 }] as const;

function position(
  positionId: string,
  plannedWeightMilliKg: number,
  rollCount = 1,
): CanonicalCoveragePosition {
  return canonicalizeCoveragePosition({
    positionId,
    rollCount,
    filmType: 'Плёнка ПЭ',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 78_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: 'прозрачная',
    spoolType: '76 мм',
    plannedWeightMilliKg,
    ingredients,
    recipeId: null,
    recipeVersion: null,
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
  });
}

function verified(
  rollId: string,
  rollCode: string,
  actualWeightMilliKg: number,
): VerifiedCoverageCandidate {
  return buildVerifiedCandidate({
    rollId,
    coverageFactId: `fact-${rollId.replace(/^roll-/u, '')}`,
    spec: canonicalizeRollCoverageSpec({
      rollCode,
      sourceOrderId: null,
      sourcePositionId: null,
      ownerCounterpartyId: counterpartyId,
      filmType: 'пленка пэ',
      actualThicknessMilliMicron: 80_000,
      accountingThicknessMilliMicron: 78_000,
      widthMilliMm: 1_700_000,
      plannedLengthMilliM: 275_000,
      birka: 'прозрачная',
      spoolType: '76mm',
      actualWeightMilliKg,
      plannedWeightMilliKg: 100_000,
      ingredients,
      recipeId: null,
      recipeVersion: null,
      recipeDefinitionId: null,
      recipeDefinitionVersionId: null,
      recipeVersionNumber: null,
      policyVersion: 'warehouse-coverage-policy/v2',
    }),
  });
}

function uncertain(rollId: string, actualWeightMilliKg: number | null): UncertainCoverageCandidate {
  return {
    rollId,
    rollCode: rollId.toUpperCase(),
    ownerCounterpartyId: counterpartyId,
    sourceOrderId: null,
    sourcePositionId: null,
    recheckCaseId: null,
    recheckOrderId: null,
    coverageFactId: null,
    known: {
      filmType: 'пленка пэ',
      actualThicknessMilliMicron: 80_000,
      accountingThicknessMilliMicron: 78_000,
      widthMilliMm: 1_700_000,
      plannedLengthMilliM: 275_000,
      birka: 'прозрачная',
      spoolType: '76 мм',
      actualWeightMilliKg,
      plannedWeightMilliKg: null,
      ingredients,
      policyVersion: null,
    },
    reasonCodes: ['roll_facts_incomplete'],
  };
}

function input(
  positions: readonly CanonicalCoveragePosition[],
  verifiedRolls: readonly VerifiedCoverageCandidate[],
  uncertainRolls: readonly UncertainCoverageCandidate[] = [],
): WarehouseCoverageMatcherInput {
  return { orderId, counterpartyId, positions, verifiedRolls, uncertainRolls };
}

function greedyTrapFixture() {
  return input(
    [position('position-a', 100_000), position('position-b', 106_000)],
    [verified('roll-flex', 'A-FLEX', 102_000), verified('roll-only-a', 'B-ONLY-A', 96_000)],
  );
}

const graphPositionFeatures = [
  { filmType: 'film-0', actualThicknessMilliMicron: 80_000, birka: 'label-0' },
  { filmType: 'film-0', actualThicknessMilliMicron: 81_000, birka: 'label-1' },
  { filmType: 'film-1', actualThicknessMilliMicron: 80_000, birka: 'label-1' },
] as const;

function graphPosition(index: number, rollCount: number): CanonicalCoveragePosition {
  const feature = graphPositionFeatures[index];
  return canonicalizeCoveragePosition({
    positionId: `graph-position-${index}`,
    rollCount,
    ...feature,
    accountingThicknessMilliMicron: 78_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    spoolType: '76 мм',
    plannedWeightMilliKg: 100_000,
    ingredients,
    recipeId: null,
    recipeVersion: null,
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
  });
}

function graphVerifiedCandidate(index: number): VerifiedCoverageCandidate {
  const rollId = `graph-roll-${index}`;
  return buildVerifiedCandidate({
    rollId,
    coverageFactId: `graph-fact-${index}`,
    spec: canonicalizeRollCoverageSpec({
      rollCode: rollId,
      sourceOrderId: null,
      sourcePositionId: null,
      ownerCounterpartyId: counterpartyId,
      ...graphPositionFeatures[0],
      accountingThicknessMilliMicron: 78_000,
      widthMilliMm: 1_700_000,
      plannedLengthMilliM: 275_000,
      spoolType: '76 мм',
      actualWeightMilliKg: 100_000,
      plannedWeightMilliKg: 100_000,
      ingredients,
      recipeId: null,
      recipeVersion: null,
      recipeDefinitionId: null,
      recipeDefinitionVersionId: null,
      recipeVersionNumber: null,
      policyVersion: 'warehouse-coverage-policy/v2',
    }),
  });
}

function graphUncertainCandidate(
  index: number,
  edgeMask: number,
  positionCount: number,
): UncertainCoverageCandidate {
  const rollId = `graph-roll-${index}`;
  return {
    rollId,
    rollCode: rollId,
    ownerCounterpartyId: counterpartyId,
    sourceOrderId: null,
    sourcePositionId: null,
    recheckCaseId: null,
    recheckOrderId: null,
    coverageFactId: null,
    known: graphKnownFields(edgeMask, positionCount),
    reasonCodes: ['roll_facts_incomplete'],
  };
}

function graphKnownFields(edgeMask: number, positionCount: number): CandidateKnownCoverageFields {
  const known: CandidateKnownCoverageFields = {
    filmType: null,
    actualThicknessMilliMicron: null,
    accountingThicknessMilliMicron: null,
    widthMilliMm: null,
    plannedLengthMilliM: null,
    birka: null,
    spoolType: null,
    actualWeightMilliKg: null,
    plannedWeightMilliKg: null,
    ingredients: null,
    policyVersion: null,
  };
  const fullMask = (1 << positionCount) - 1;
  if (edgeMask === fullMask) return known;
  if (edgeMask === 0) return { ...known, filmType: 'never-matches' };
  const indexes = Array.from({ length: positionCount }, (_, index) => index).filter(
    (index) => (edgeMask & (1 << index)) !== 0,
  );
  if (indexes.length === 1) {
    return { ...known, ...graphPositionFeatures[indexes[0]] };
  }
  if (edgeMask === 0b011) return { ...known, filmType: 'film-0' };
  if (edgeMask === 0b101) {
    return { ...known, actualThicknessMilliMicron: 80_000 };
  }
  if (edgeMask === 0b110) return { ...known, birka: 'label-1' };
  throw new Error(`unsupported graph edge mask ${edgeMask}`);
}

interface BruteForceCanonicalMatching {
  size: number;
  positionIndexByRoll: Array<number | null>;
}

function bruteForceCanonicalMatching(
  edgeMasks: readonly number[],
  capacities: readonly number[],
): BruteForceCanonicalMatching {
  const remainingCapacity = [...capacities];
  const positionIndexByRoll = Array<number | null>(edgeMasks.length).fill(null);
  let best: BruteForceCanonicalMatching | null = null;
  const isBetter = (candidate: BruteForceCanonicalMatching): boolean => {
    if (best === null || candidate.size !== best.size) {
      return best === null || candidate.size > best.size;
    }
    for (let rollIndex = 0; rollIndex < edgeMasks.length; rollIndex += 1) {
      const candidateMatched = candidate.positionIndexByRoll[rollIndex] !== null;
      const bestMatched = best.positionIndexByRoll[rollIndex] !== null;
      if (candidateMatched !== bestMatched) return candidateMatched;
    }
    for (let rollIndex = 0; rollIndex < edgeMasks.length; rollIndex += 1) {
      const candidatePosition = candidate.positionIndexByRoll[rollIndex];
      const bestPosition = best.positionIndexByRoll[rollIndex];
      if (
        candidatePosition !== null &&
        bestPosition !== null &&
        candidatePosition !== bestPosition
      ) {
        return candidatePosition < bestPosition;
      }
    }
    return false;
  };
  const search = (rollIndex: number, size: number): void => {
    if (rollIndex === edgeMasks.length) {
      const candidate = { size, positionIndexByRoll: [...positionIndexByRoll] };
      if (isBetter(candidate)) best = candidate;
      return;
    }
    positionIndexByRoll[rollIndex] = null;
    search(rollIndex + 1, size);
    for (let positionIndex = 0; positionIndex < capacities.length; positionIndex += 1) {
      if (
        (edgeMasks[rollIndex] & (1 << positionIndex)) === 0 ||
        remainingCapacity[positionIndex] === 0
      ) {
        continue;
      }
      remainingCapacity[positionIndex] -= 1;
      positionIndexByRoll[rollIndex] = positionIndex;
      search(rollIndex + 1, size + 1);
      remainingCapacity[positionIndex] += 1;
    }
    positionIndexByRoll[rollIndex] = null;
  };
  search(0, 0);
  if (best === null) throw new Error('brute-force matching did not produce a result');
  return best;
}

function bruteForceMaximum(edgeMasks: readonly number[], capacities: readonly number[]): number {
  return bruteForceCanonicalMatching(edgeMasks, capacities).size;
}

describe('warehouse coverage grouped-capacity matcher', () => {
  it('escapes the greedy trap and emits only a verified perfect set', () => {
    const result = matchWarehouseCoverage(greedyTrapFixture());
    expect(result.availability).toBe('verified_full');
    expect(
      result.matches.map(
        ({
          rollId,
          positionId,
          coverageFactId,
        }: {
          rollId: string;
          positionId: string;
          coverageFactId: string;
        }) => [rollId, positionId, coverageFactId],
      ),
    ).toEqual([
      ['roll-flex', 'position-b', 'fact-flex'],
      ['roll-only-a', 'position-a', 'fact-only-a'],
    ]);
  });

  it.each<{
    fixture: WarehouseCoverageMatcherInput;
    availability: WarehouseCoverageAvailability;
    matched: number;
    rows: number;
  }>([
    {
      fixture: input(
        [position('position-a', 100_000, 2)],
        [verified('roll-a', 'A', 100_000), verified('roll-b', 'B', 100_000)],
      ),
      availability: 'verified_full',
      matched: 2,
      rows: 2,
    },
    {
      fixture: input(
        [position('position-a', 100_000, 3)],
        [verified('roll-a', 'A', 100_000)],
        [uncertain('roll-u', 100_000)],
      ),
      availability: 'unavailable',
      matched: 1,
      rows: 0,
    },
    {
      fixture: input(
        [position('position-a', 100_000, 2)],
        [verified('roll-a', 'A', 100_000)],
        [uncertain('roll-u', 100_000)],
      ),
      availability: 'unknown',
      matched: 1,
      rows: 0,
    },
  ])('classifies lower and optimistic upper bounds', ({ fixture, availability, matched, rows }) => {
    const result = matchWarehouseCoverage(fixture);
    expect(result.availability).toBe(availability);
    expect(result.matchedRollCount).toBe(matched);
    expect(result.matches).toHaveLength(rows);
  });

  it('counts an optimistic-edge roll without letting a partial deficit block production', () => {
    const result = matchWarehouseCoverage(
      input(
        [position('position-a', 100_000, 4)],
        [verified('roll-a', 'A', 100_000)],
        [uncertain('roll-u', 100_000)],
      ),
    );
    expect(result).toMatchObject({
      availability: 'unavailable',
      uncertainRollCount: 1,
      matches: [],
    });
  });

  it('does not expand ten thousand requested slots', () => {
    const result = matchWarehouseCoverage(
      input(
        [position('position-a', 100_000, 10_000)],
        [verified('roll-a', 'A', 100_000), verified('roll-b', 'B', 100_000)],
      ),
    );
    expect(result.requiredRollCount).toBe(10_000);
    expect(result.matchedRollCount).toBe(2);
    expect(result.matches).toHaveLength(0);
    expect(result.availability).toBe('unavailable');
  });

  it('canonically matches ten thousand candidates within the default Jest timeout', async () => {
    const expectedRollIds = Array.from({ length: 10_000 }, (_, index) => {
      const suffix = index.toString().padStart(5, '0');
      return `roll-${suffix}`;
    });
    const verifiedRolls = expectedRollIds
      .map((rollId, index) =>
        verified(
          rollId,
          `CODE-${Math.floor(index / 2)
            .toString()
            .padStart(5, '0')}`,
          100_000,
        ),
      )
      .reverse();

    const worker = new Worker(
      `
        require('ts-node/register/transpile-only');
        const { parentPort, workerData } = require('node:worker_threads');
        const { matchWarehouseCoverage } = require(workerData.matcherPath);
        parentPort.postMessage(matchWarehouseCoverage(workerData.matcherInput));
      `,
      {
        eval: true,
        workerData: {
          matcherPath: require.resolve('./warehouse-coverage-matcher'),
          matcherInput: input([position('position-a', 100_000, 10_000)], verifiedRolls),
        },
      },
    );
    worker.unref();
    const result = await new Promise<ReturnType<typeof matchWarehouseCoverage>>(
      (resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      },
    );

    expect(result.availability).toBe('verified_full');
    expect(result.matches.map(({ rollId }) => rollId)).toEqual(expectedRollIds);
    expect(result.matches[0]).toMatchObject({
      rollId: 'roll-00000',
      positionId: 'position-a',
      slotIndex: 1,
    });
    expect(result.matches.at(-1)).toMatchObject({
      rollId: 'roll-09999',
      positionId: 'position-a',
      slotIndex: 10_000,
    });
  });

  it('is deterministic across position and candidate input permutations', () => {
    const baseline = greedyTrapFixture();
    expect(
      matchWarehouseCoverage({
        ...baseline,
        positions: [...baseline.positions].reverse(),
        verifiedRolls: [...baseline.verifiedRolls].reverse(),
      }),
    ).toEqual(matchWarehouseCoverage(baseline));
  });

  it('gives the earliest candidate the earliest feasible position in ambiguous perfect matches', () => {
    const baseline = input(
      [position('position-b', 100_000), position('position-a', 100_000)],
      [verified('roll-b', 'B', 100_000), verified('roll-a', 'A', 100_000)],
    );
    const expected = [
      { rollId: 'roll-a', positionId: 'position-a', slotIndex: 1 },
      { rollId: 'roll-b', positionId: 'position-b', slotIndex: 1 },
    ];
    expect(
      matchWarehouseCoverage(baseline).matches.map(({ rollId, positionId, slotIndex }) => ({
        rollId,
        positionId,
        slotIndex,
      })),
    ).toEqual(expected);
    expect(
      matchWarehouseCoverage({
        ...baseline,
        positions: [...baseline.positions].reverse(),
        verifiedRolls: [...baseline.verifiedRolls].reverse(),
      }).matches.map(({ rollId, positionId, slotIndex }) => ({
        rollId,
        positionId,
        slotIndex,
      })),
    ).toEqual(expected);
  });

  it('preserves the earliest compatible roll when one position has one slot', () => {
    const baseline = input(
      [position('position-a', 100_000)],
      [verified('roll-b', 'B', 100_000), verified('roll-a', 'A', 100_000)],
    );
    const expected = [
      {
        rollId: 'roll-a',
        positionId: 'position-a',
        slotIndex: 1,
        coverageFactId: 'fact-a',
      },
    ];
    expect(matchWarehouseCoverage(baseline).matches).toEqual(expected);
    expect(
      matchWarehouseCoverage({
        ...baseline,
        verifiedRolls: [...baseline.verifiedRolls].reverse(),
      }).matches,
    ).toEqual(expected);
  });

  it('constructs the globally lexicographic maximum across input permutations', () => {
    const position1 = position('p1', 100_000);
    const position2 = position('p2', 100_000);
    const position3 = position('p3', 100_000);
    const rollA = verified('roll-a', 'A', 100_000);
    const rollB = verified('roll-b', 'B', 100_000);
    const rollC = verified('roll-c', 'C', 100_000);
    const compatiblePositions = new Map([
      ['A', new Set(['p1', 'p3'])],
      ['B', new Set(['p2', 'p3'])],
      ['C', new Set(['p1', 'p2'])],
    ]);
    const compatibility = jest
      .spyOn(canonicalModule, 'coverageSpecsCompatible')
      .mockImplementation((candidatePosition, roll) =>
        Boolean(compatiblePositions.get(roll.rollCode)?.has(candidatePosition.positionId)),
      );
    const positionPermutations = [
      [position1, position2, position3],
      [position1, position3, position2],
      [position2, position1, position3],
      [position2, position3, position1],
      [position3, position1, position2],
      [position3, position2, position1],
    ];
    const rollPermutations = [
      [rollA, rollB, rollC],
      [rollA, rollC, rollB],
      [rollB, rollA, rollC],
      [rollB, rollC, rollA],
      [rollC, rollA, rollB],
      [rollC, rollB, rollA],
    ];
    const expected = [
      { rollId: 'roll-a', positionId: 'p1', slotIndex: 1 },
      { rollId: 'roll-b', positionId: 'p3', slotIndex: 1 },
      { rollId: 'roll-c', positionId: 'p2', slotIndex: 1 },
    ];
    try {
      for (const positions of positionPermutations) {
        for (const verifiedRolls of rollPermutations) {
          expect(
            matchWarehouseCoverage(input(positions, verifiedRolls)).matches.map(
              ({ rollId, positionId, slotIndex }) => ({
                rollId,
                positionId,
                slotIndex,
              }),
            ),
          ).toEqual(expected);
        }
      }
    } finally {
      compatibility.mockRestore();
    }
  });

  it('isolates foreign recheck cases from the target order', () => {
    const positionA = position('position-a', 100_000);
    const candidate = {
      ...uncertain('roll-case', 100_000),
      ownerCounterpartyId: null,
      recheckCaseId: 'recheck-case',
      recheckOrderId: 'foreign-order',
    };
    expect(matchWarehouseCoverage(input([positionA], [], [candidate]))).toMatchObject({
      availability: 'unavailable',
      uncertainRollCount: 0,
    });
  });

  it('requires recheck case and order provenance together', () => {
    const positionA = position('position-a', 100_000);
    const candidate = {
      ...uncertain('roll-case', 100_000),
      ownerCounterpartyId: null,
      recheckCaseId: 'recheck-case',
      recheckOrderId: orderId,
    };
    expect(() =>
      matchWarehouseCoverage(input([positionA], [], [{ ...candidate, recheckOrderId: null }])),
    ).toThrow('recheckCaseId and recheckOrderId');
    expect(() =>
      matchWarehouseCoverage(
        input([positionA], [], [{ ...candidate, recheckCaseId: null, recheckOrderId: orderId }]),
      ),
    ).toThrow('recheckCaseId and recheckOrderId');
  });

  it('does not count an order-relevant uncertain roll without an optimistic edge', () => {
    expect(
      matchWarehouseCoverage(
        input([position('position-a', 100_000)], [], [uncertain('roll-incompatible', 200_000)]),
      ),
    ).toMatchObject({
      availability: 'unavailable',
      uncertainRollCount: 0,
      reasonCodes: ['no_compatible_rolls'],
    });
  });

  it('rejects duplicate positions, physical rolls, and coverage facts', () => {
    const positionA = position('position-a', 100_000);
    const rollA = verified('roll-a', 'A', 100_000);
    const rollB = verified('roll-b', 'B', 100_000);
    expect(() => matchWarehouseCoverage(input([positionA, positionA], [rollA]))).toThrow(
      'duplicate positionId',
    );
    expect(() =>
      matchWarehouseCoverage(input([positionA], [rollA], [uncertain('roll-a', 100_000)])),
    ).toThrow('duplicate rollId');
    expect(() =>
      matchWarehouseCoverage(
        input([positionA], [rollA, { ...rollB, coverageFactId: rollA.coverageFactId }]),
      ),
    ).toThrow('duplicate coverageFactId');
  });

  it('rejects an empty position universe instead of reporting a vacuous full cover', () => {
    expect(() => matchWarehouseCoverage(input([], []))).toThrow('at least one position');
  });

  it('matches brute-force lower and upper maxima for every graph up to four rolls and three positions', () => {
    let activeEdges = new Map<string, ReadonlySet<string>>();
    const compatibility = jest
      .spyOn(canonicalModule, 'coverageSpecsCompatible')
      .mockImplementation((position, roll) =>
        Boolean(activeEdges.get(roll.rollCode)?.has(position.positionId)),
      );
    try {
      for (let positionCount = 1; positionCount <= 3; positionCount += 1) {
        const capacityVariants = [
          Array.from({ length: positionCount }, () => 1),
          Array.from({ length: positionCount }, (_, index) => (index === 0 ? 2 : 1)),
        ];
        for (const capacities of capacityVariants) {
          const positions = capacities.map((capacity, index) => graphPosition(index, capacity));
          const required = capacities.reduce((sum, capacity) => sum + capacity, 0);
          for (let rollCount = 0; rollCount <= 4; rollCount += 1) {
            const graphCount = 1 << (positionCount * rollCount);
            for (let graph = 0; graph < graphCount; graph += 1) {
              const edgeMasks = Array.from({ length: rollCount }, (_, rollIndex) => {
                const shift = rollIndex * positionCount;
                return (graph >> shift) & ((1 << positionCount) - 1);
              });
              const verifiedRolls: VerifiedCoverageCandidate[] = [];
              const uncertainRolls: UncertainCoverageCandidate[] = [];
              const promotedRolls: VerifiedCoverageCandidate[] = [];
              const lowerEdgeMasks: number[] = [];
              activeEdges = new Map();
              edgeMasks.forEach((edgeMask, rollIndex) => {
                const verifiedRoll = graphVerifiedCandidate(rollIndex);
                promotedRolls.push(verifiedRoll);
                activeEdges.set(
                  verifiedRoll.spec.rollCode,
                  new Set(
                    positions
                      .filter((_, positionIndex) => (edgeMask & (1 << positionIndex)) !== 0)
                      .map(({ positionId: graphPositionId }) => graphPositionId),
                  ),
                );
                if ((graph + rollIndex) % 2 === 0) {
                  verifiedRolls.push(verifiedRoll);
                  lowerEdgeMasks.push(edgeMask);
                } else {
                  uncertainRolls.push(graphUncertainCandidate(rollIndex, edgeMask, positionCount));
                }
              });

              const lower = bruteForceMaximum(lowerEdgeMasks, capacities);
              const canonicalUpper = bruteForceCanonicalMatching(edgeMasks, capacities);
              const upper = canonicalUpper.size;
              const result = matchWarehouseCoverage(
                input(positions, verifiedRolls, uncertainRolls),
              );
              const promoted = matchWarehouseCoverage(input(positions, promotedRolls));
              expect(result.matchedRollCount).toBe(lower);
              expect(promoted.matchedRollCount).toBe(upper);
              expect(result.availability).toBe(
                lower === required ? 'verified_full' : upper < required ? 'unavailable' : 'unknown',
              );
              const expectedCanonicalMatches =
                upper === required
                  ? canonicalUpper.positionIndexByRoll.flatMap((positionIndex, rollIndex) =>
                      positionIndex === null
                        ? []
                        : [
                            {
                              rollId: `graph-roll-${rollIndex}`,
                              positionId: `graph-position-${positionIndex}`,
                            },
                          ],
                    )
                  : [];
              const actualCanonicalMatches = promoted.matches.map(({ rollId, positionId }) => ({
                rollId,
                positionId,
              }));
              if (
                JSON.stringify(actualCanonicalMatches) !== JSON.stringify(expectedCanonicalMatches)
              ) {
                throw new Error(
                  `canonical mismatch ${JSON.stringify({
                    capacities,
                    edgeMasks,
                    expectedCanonicalMatches,
                    actualCanonicalMatches,
                  })}`,
                );
              }
            }
          }
        }
      }
    } finally {
      compatibility.mockRestore();
    }
  });
});
