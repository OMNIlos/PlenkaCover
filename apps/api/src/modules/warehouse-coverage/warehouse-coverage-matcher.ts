import {
  WAREHOUSE_COVERAGE_REASON_CODES,
  type WarehouseCoverageAvailability,
  type WarehouseCoverageReasonCode,
} from '@plenka/contracts';
import {
  compareOpaqueIdsBinary,
  coverageSpecsCompatible,
  isWeightWithinFivePercent,
  type CanonicalCoveragePosition,
  type CanonicalIngredient,
  type CanonicalRollCoverageSpec,
} from './warehouse-coverage-canonical';

type UncertaintyReasonCode = Extract<
  WarehouseCoverageReasonCode,
  'roll_facts_incomplete' | 'roll_ownership_unverified' | 'unsupported_policy_version'
>;

const UNCERTAINTY_REASON_CODES = new Set<UncertaintyReasonCode>([
  'roll_facts_incomplete',
  'roll_ownership_unverified',
  'unsupported_policy_version',
]);

export interface CandidateKnownCoverageFields {
  filmType: string | null;
  actualThicknessMilliMicron: number | null;
  accountingThicknessMilliMicron: number | null;
  widthMilliMm: number | null;
  plannedLengthMilliM: number | null;
  birka: string | null;
  spoolType: string | null;
  actualWeightMilliKg: number | null;
  plannedWeightMilliKg: number | null;
  ingredients: readonly CanonicalIngredient[] | null;
  policyVersion: string | null;
}

export interface VerifiedCoverageCandidate {
  rollId: string;
  coverageFactId: string;
  ownerScope: 'counterparty' | 'company_stock';
  spec: CanonicalRollCoverageSpec;
}

export interface UncertainCoverageCandidate {
  rollId: string;
  rollCode: string;
  ownerCounterpartyId: string | null;
  sourceOrderId: string | null;
  sourcePositionId: string | null;
  recheckCaseId: string | null;
  recheckOrderId: string | null;
  coverageFactId: string | null;
  companyStock?: boolean;
  known: CandidateKnownCoverageFields;
  reasonCodes: readonly UncertaintyReasonCode[];
}

export interface WarehouseCoverageMatcherInput {
  orderId: string;
  counterpartyId: string;
  positions: readonly CanonicalCoveragePosition[];
  verifiedRolls: readonly VerifiedCoverageCandidate[];
  uncertainRolls: readonly UncertainCoverageCandidate[];
}

export interface WarehouseCoverageMatchPlan {
  availability: WarehouseCoverageAvailability;
  reasonCodes: WarehouseCoverageReasonCode[];
  requiredRollCount: number;
  matchedRollCount: number;
  uncertainRollCount: number;
  matches: Array<{
    rollId: string;
    positionId: string;
    slotIndex: number;
    coverageFactId: string;
  }>;
}

export interface VerifiedCoverageFactCandidateInput {
  rollId: string;
  coverageFactId: string;
  ownerScope?: 'counterparty' | 'company_stock';
  spec: CanonicalRollCoverageSpec;
}

interface PreparedCandidate {
  rollId: string;
  rollCode: string;
  compatiblePositionIds: readonly string[];
}

interface CapacityMatching {
  assignmentByRollId: ReadonlyMap<string, string>;
  size: number;
}

interface MatchingPositionCapacity {
  positionId: string;
  capacity: number;
}

export function buildVerifiedCandidate(
  input: VerifiedCoverageFactCandidateInput,
): VerifiedCoverageCandidate {
  requireOpaqueId(input.rollId, 'rollId');
  requireOpaqueId(input.coverageFactId, 'coverageFactId');
  const ownerScope = input.ownerScope ?? 'counterparty';
  if (ownerScope === 'counterparty' && input.spec.ownerCounterpartyId === null) {
    throw new Error('verified owner must be non-null');
  }
  if (ownerScope === 'company_stock' && input.spec.ownerCounterpartyId !== null) {
    throw new Error('company stock owner must be null');
  }
  if (input.spec.ownerCounterpartyId !== null) {
    requireOpaqueId(input.spec.ownerCounterpartyId, 'verified owner');
  }
  return {
    rollId: input.rollId,
    coverageFactId: input.coverageFactId,
    ownerScope,
    spec: input.spec,
  };
}

export function sortCandidateCode(
  candidate: VerifiedCoverageCandidate | UncertainCoverageCandidate,
): string {
  return 'spec' in candidate ? candidate.spec.rollCode : candidate.rollCode;
}

export function matchWarehouseCoverage(
  input: WarehouseCoverageMatcherInput,
): WarehouseCoverageMatchPlan {
  validateMatcherInput(input);
  const positions = [...input.positions].sort((left, right) =>
    compareOpaqueIdsBinary(left.positionId, right.positionId),
  );
  const positionIds = new Set(positions.map(({ positionId }) => positionId));
  const requiredRollCount = positions.reduce((total, position) => {
    if (total > Number.MAX_SAFE_INTEGER - position.rollCount) {
      throw new Error('requiredRollCount must be a positive safe integer sum');
    }
    return total + position.rollCount;
  }, 0);

  const verified = input.verifiedRolls
    .filter(
      ({ ownerScope, spec }) =>
        ownerScope === 'company_stock' || spec.ownerCounterpartyId === input.counterpartyId,
    )
    .map((candidate) => prepareVerifiedCandidate(candidate, positions))
    .sort(comparePreparedCandidates);
  const relevantUncertain = input.uncertainRolls.filter((candidate) =>
    isOrderRelevantUncertain(candidate, input.orderId, input.counterpartyId, positionIds),
  );
  const uncertain = relevantUncertain
    .map((candidate) => prepareUncertainCandidate(candidate, positions))
    .filter(({ prepared }) => prepared.compatiblePositionIds.length > 0)
    .sort((left, right) => comparePreparedCandidates(left.prepared, right.prepared));

  const positionCapacities = positions.map(({ positionId, rollCount }) => ({
    positionId,
    capacity: rollCount,
  }));
  const optimisticCandidates = [...verified, ...uncertain.map(({ prepared }) => prepared)].sort(
    comparePreparedCandidates,
  );
  const selectedVerified = selectMaximumCandidates(positionCapacities, verified);
  const lowerSize = selectedVerified.length;
  const optimisticSize = maximumCapacityMatchingSize(positionCapacities, optimisticCandidates);
  const uncertainRollCount = uncertain.length;

  if (lowerSize === requiredRollCount) {
    const lower = assignSelectedCandidatesLexicographically(positionCapacities, selectedVerified);
    return {
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      requiredRollCount,
      matchedRollCount: lowerSize,
      uncertainRollCount,
      matches: materializeVerifiedMatches(lower, verified, input.verifiedRolls),
    };
  }
  if (optimisticSize < requiredRollCount) {
    return {
      availability: 'unavailable',
      reasonCodes: [optimisticSize === 0 ? 'no_compatible_rolls' : 'only_partial_cover'],
      requiredRollCount,
      matchedRollCount: lowerSize,
      uncertainRollCount,
      matches: [],
    };
  }
  return {
    availability: 'unknown',
    reasonCodes: sortedUncertaintyReasons(uncertain),
    requiredRollCount,
    matchedRollCount: lowerSize,
    uncertainRollCount,
    matches: [],
  };
}

function maximumCapacityMatchingSize(
  positions: readonly MatchingPositionCapacity[],
  candidates: readonly PreparedCandidate[],
): number {
  return runForwardCapacityAugment(positions, candidates);
}

function selectMaximumCandidates(
  positions: readonly MatchingPositionCapacity[],
  candidates: readonly PreparedCandidate[],
): PreparedCandidate[] {
  const selected: PreparedCandidate[] = [];
  runForwardCapacityAugment(positions, candidates, (candidate) => {
    selected.push(candidate);
  });
  return selected;
}

function runForwardCapacityAugment(
  positions: readonly MatchingPositionCapacity[],
  candidates: readonly PreparedCandidate[],
  onCardinalityIncrease?: (candidate: PreparedCandidate) => void,
): number {
  const candidateByRollId = new Map(candidates.map((candidate) => [candidate.rollId, candidate]));
  const positionById = new Map(
    positions.map(({ positionId, capacity }) => [
      positionId,
      { capacity, occupants: [] as string[] },
    ]),
  );

  const augment = (
    rollId: string,
    visitedRollIds: Set<string>,
    visitedPositionIds: Set<string>,
  ): boolean => {
    const candidate = candidateByRollId.get(rollId);
    if (!candidate) throw new Error(`matching candidate ${rollId} is missing`);
    for (const positionId of candidate.compatiblePositionIds) {
      if (visitedPositionIds.has(positionId)) continue;
      visitedPositionIds.add(positionId);
      const position = positionById.get(positionId);
      if (!position) throw new Error(`matching position ${positionId} is missing`);
      if (position.occupants.length < position.capacity) {
        position.occupants.push(rollId);
        return true;
      }
      for (const occupantRollId of [...position.occupants]) {
        if (visitedRollIds.has(occupantRollId)) continue;
        visitedRollIds.add(occupantRollId);
        if (augment(occupantRollId, visitedRollIds, visitedPositionIds)) {
          const occupantIndex = position.occupants.indexOf(occupantRollId);
          if (occupantIndex < 0) throw new Error('matching occupant disappeared');
          position.occupants[occupantIndex] = rollId;
          return true;
        }
      }
    }
    return false;
  };

  const totalCapacity = positions.reduce((total, position) => total + position.capacity, 0);
  let size = 0;
  for (const candidate of candidates) {
    if (size === totalCapacity) break;
    if (augment(candidate.rollId, new Set([candidate.rollId]), new Set())) {
      size += 1;
      onCardinalityIncrease?.(candidate);
    }
  }
  return size;
}

function assignSelectedCandidatesLexicographically(
  positions: readonly MatchingPositionCapacity[],
  selectedCandidates: readonly PreparedCandidate[],
): CapacityMatching {
  const residualPositions = positions.map((position) => ({ ...position }));
  const residualByPositionId = new Map(
    residualPositions.map((position) => [position.positionId, position]),
  );
  const assignmentByRollId = new Map<string, string>();

  for (let candidateIndex = 0; candidateIndex < selectedCandidates.length; candidateIndex += 1) {
    const candidate = selectedCandidates[candidateIndex];
    const availablePositionIds = candidate.compatiblePositionIds.filter((positionId) => {
      const position = residualByPositionId.get(positionId);
      if (!position) {
        throw new Error(`matching position ${positionId} is missing`);
      }
      return position.capacity > 0;
    });
    for (const positionId of availablePositionIds) {
      const position = residualByPositionId.get(positionId);
      if (!position) throw new Error(`matching position ${positionId} is missing`);

      position.capacity -= 1;
      const preservesTarget =
        availablePositionIds.length === 1 ||
        assignmentByRollId.size +
          1 +
          maximumCapacityMatchingSize(
            residualPositions,
            selectedCandidates.slice(candidateIndex + 1),
          ) ===
          selectedCandidates.length;
      if (preservesTarget) {
        assignmentByRollId.set(candidate.rollId, positionId);
        break;
      }
      position.capacity += 1;
    }
  }
  if (assignmentByRollId.size !== selectedCandidates.length) {
    throw new Error('canonical matching did not reach the selected size');
  }
  return { assignmentByRollId, size: selectedCandidates.length };
}

function prepareVerifiedCandidate(
  candidate: VerifiedCoverageCandidate,
  positions: readonly CanonicalCoveragePosition[],
): PreparedCandidate {
  return {
    rollId: candidate.rollId,
    rollCode: candidate.spec.rollCode,
    compatiblePositionIds: positions
      .filter((position) => coverageSpecsCompatible(position, candidate.spec))
      .map(({ positionId }) => positionId),
  };
}

function prepareUncertainCandidate(
  candidate: UncertainCoverageCandidate,
  positions: readonly CanonicalCoveragePosition[],
): { candidate: UncertainCoverageCandidate; prepared: PreparedCandidate } {
  return {
    candidate,
    prepared: {
      rollId: candidate.rollId,
      rollCode: candidate.rollCode,
      compatiblePositionIds: positions
        .filter((position) => knownFieldsAllowOptimisticEdge(position, candidate.known))
        .map(({ positionId }) => positionId),
    },
  };
}

function knownFieldsAllowOptimisticEdge(
  position: CanonicalCoveragePosition,
  known: CandidateKnownCoverageFields,
): boolean {
  return (
    nullableEquals(known.filmType, position.filmType) &&
    nullableEquals(known.actualThicknessMilliMicron, position.actualThicknessMilliMicron) &&
    nullableEquals(known.accountingThicknessMilliMicron, position.accountingThicknessMilliMicron) &&
    nullableEquals(known.widthMilliMm, position.widthMilliMm) &&
    nullableEquals(known.plannedLengthMilliM, position.plannedLengthMilliM) &&
    nullableEquals(known.birka, position.birka) &&
    nullableEquals(known.spoolType, position.spoolType) &&
    (known.ingredients === null || ingredientsEqual(known.ingredients, position.ingredients)) &&
    (known.actualWeightMilliKg === null ||
      isWeightWithinFivePercent(known.actualWeightMilliKg, position.plannedWeightMilliKg))
  );
}

function isOrderRelevantUncertain(
  candidate: UncertainCoverageCandidate,
  orderId: string,
  counterpartyId: string,
  positionIds: ReadonlySet<string>,
): boolean {
  if (candidate.ownerCounterpartyId !== null) {
    return candidate.ownerCounterpartyId === counterpartyId;
  }
  if (candidate.companyStock === true) return true;
  if (candidate.recheckCaseId !== null) {
    return candidate.recheckOrderId === orderId;
  }
  return (
    candidate.sourceOrderId === orderId &&
    candidate.sourcePositionId !== null &&
    positionIds.has(candidate.sourcePositionId)
  );
}

function materializeVerifiedMatches(
  matching: CapacityMatching,
  preparedCandidates: readonly PreparedCandidate[],
  candidates: readonly VerifiedCoverageCandidate[],
): WarehouseCoverageMatchPlan['matches'] {
  const candidateByRollId = new Map(candidates.map((candidate) => [candidate.rollId, candidate]));
  const slotByPositionId = new Map<string, number>();
  return preparedCandidates.flatMap(({ rollId }) => {
    const positionId = matching.assignmentByRollId.get(rollId);
    if (!positionId) return [];
    const candidate = candidateByRollId.get(rollId);
    if (!candidate) throw new Error(`verified candidate ${rollId} is missing`);
    const slotIndex = (slotByPositionId.get(positionId) ?? 0) + 1;
    slotByPositionId.set(positionId, slotIndex);
    return [{ rollId, positionId, slotIndex, coverageFactId: candidate.coverageFactId }];
  });
}

function sortedUncertaintyReasons(
  uncertain: readonly {
    candidate: UncertainCoverageCandidate;
    prepared: PreparedCandidate;
  }[],
): WarehouseCoverageReasonCode[] {
  const reasons = new Set<WarehouseCoverageReasonCode>();
  for (const { candidate } of uncertain) {
    for (const reason of candidate.reasonCodes) reasons.add(reason);
  }
  return WAREHOUSE_COVERAGE_REASON_CODES.filter((reason) => reasons.has(reason));
}

function validateMatcherInput(input: WarehouseCoverageMatcherInput): void {
  requireOpaqueId(input.orderId, 'orderId');
  requireOpaqueId(input.counterpartyId, 'counterpartyId');
  if (input.positions.length === 0) {
    throw new Error('warehouse coverage requires at least one position');
  }
  assertUnique(
    input.positions.map(({ positionId }) => positionId),
    'positionId',
  );
  for (const position of input.positions) {
    requireOpaqueId(position.positionId, 'positionId');
    requirePositiveCapacity(position.rollCount);
  }

  const rollIds: string[] = [];
  const coverageFacts: Array<{ factId: string; rollId: string }> = [];
  for (const candidate of input.verifiedRolls) {
    requireOpaqueId(candidate.rollId, 'rollId');
    requireOpaqueId(candidate.coverageFactId, 'coverageFactId');
    requireOpaqueId(candidate.spec.rollCode, 'rollCode');
    if (candidate.ownerScope === 'counterparty') {
      requireOpaqueId(candidate.spec.ownerCounterpartyId, 'verified owner');
    } else if (
      candidate.ownerScope !== 'company_stock' ||
      candidate.spec.ownerCounterpartyId !== null
    ) {
      throw new Error('invalid verified owner scope');
    }
    rollIds.push(candidate.rollId);
    coverageFacts.push({ factId: candidate.coverageFactId, rollId: candidate.rollId });
  }
  for (const candidate of input.uncertainRolls) {
    validateUncertainCandidate(candidate);
    rollIds.push(candidate.rollId);
    if (candidate.coverageFactId !== null) {
      coverageFacts.push({ factId: candidate.coverageFactId, rollId: candidate.rollId });
    }
  }
  assertUnique(rollIds, 'rollId');
  const factOwnerById = new Map<string, string>();
  for (const { factId, rollId } of coverageFacts) {
    const previousRollId = factOwnerById.get(factId);
    if (previousRollId !== undefined && previousRollId !== rollId) {
      throw new Error(`duplicate coverageFactId: ${factId}`);
    }
    factOwnerById.set(factId, rollId);
  }
}

function validateUncertainCandidate(candidate: UncertainCoverageCandidate): void {
  requireOpaqueId(candidate.rollId, 'rollId');
  requireOpaqueId(candidate.rollCode, 'rollCode');
  requireNullableOpaqueId(candidate.ownerCounterpartyId, 'ownerCounterpartyId');
  requireNullableOpaqueId(candidate.sourceOrderId, 'sourceOrderId');
  requireNullableOpaqueId(candidate.sourcePositionId, 'sourcePositionId');
  requireNullableOpaqueId(candidate.recheckCaseId, 'recheckCaseId');
  requireNullableOpaqueId(candidate.recheckOrderId, 'recheckOrderId');
  requireNullableOpaqueId(candidate.coverageFactId, 'coverageFactId');
  if (candidate.companyStock !== undefined && typeof candidate.companyStock !== 'boolean') {
    throw new Error('companyStock must be boolean');
  }
  if ((candidate.recheckCaseId === null) !== (candidate.recheckOrderId === null)) {
    throw new Error('recheckCaseId and recheckOrderId must be provided together');
  }
  if (candidate.reasonCodes.length === 0) {
    throw new Error('uncertain reasonCodes must be non-empty');
  }
  for (const reasonCode of candidate.reasonCodes) {
    if (!UNCERTAINTY_REASON_CODES.has(reasonCode)) {
      throw new Error(`unsupported uncertain reasonCode: ${reasonCode}`);
    }
  }
  for (const value of [
    candidate.known.actualThicknessMilliMicron,
    candidate.known.accountingThicknessMilliMicron,
    candidate.known.widthMilliMm,
    candidate.known.plannedLengthMilliM,
    candidate.known.actualWeightMilliKg,
    candidate.known.plannedWeightMilliKg,
  ]) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('known numeric coverage fields must be positive safe integers');
    }
  }
}

function comparePreparedCandidates(left: PreparedCandidate, right: PreparedCandidate): number {
  const codeOrder = compareOpaqueIdsBinary(left.rollCode, right.rollCode);
  return codeOrder || compareOpaqueIdsBinary(left.rollId, right.rollId);
}

function nullableEquals<T>(known: T | null, expected: T): boolean {
  return known === null || known === expected;
}

function ingredientsEqual(
  left: readonly CanonicalIngredient[],
  right: readonly CanonicalIngredient[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ingredient, index) =>
        ingredient.rawMaterialDefinitionId === right[index].rawMaterialDefinitionId &&
        ingredient.shareBasisPoints === right[index].shareBasisPoints,
    )
  );
}

function requireOpaqueId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty opaque ID`);
  }
  compareOpaqueIdsBinary(value, value);
}

function requireNullableOpaqueId(value: string | null, field: string): void {
  if (value !== null) requireOpaqueId(value, field);
}

function requirePositiveCapacity(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new Error('rollCount must be a positive safe integer no greater than 10_000');
  }
}

function assertUnique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${field}: ${value}`);
    seen.add(value);
  }
}
