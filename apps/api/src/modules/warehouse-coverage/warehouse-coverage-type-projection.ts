import type {
  WarehouseCoverageProjection,
  WarehouseCoverageTypeProjection,
} from '@plenka/contracts';
import { compareOpaqueIdsBinary, isWeightWithinFivePercent } from './warehouse-coverage-canonical';

interface NamedIngredient {
  name: string;
  shareBasisPoints: number;
}

interface CoverageTypeSpecificationInput {
  filmType: string;
  actualThicknessMilliMicron: number;
  accountingThicknessMilliMicron: number;
  widthMilliMm: number;
  plannedLengthMilliM: number;
  spoolType: string;
  birka: string;
  recipeName: string | null;
  ingredients: readonly NamedIngredient[];
}

export interface SelectedCoveragePosition extends CoverageTypeSpecificationInput {
  positionId: string;
  label: string;
  requiredRollCount: number;
  plannedWeightMilliKg: number;
}

export interface PublishedCoverageMatch extends CoverageTypeSpecificationInput {
  positionId: string;
  actualWeightMilliKg: number;
}

export interface TypeCoverageProjectionInput {
  base: WarehouseCoverageProjection;
  positions: readonly SelectedCoveragePosition[];
  matches: readonly PublishedCoverageMatch[];
}

export function projectTypeCoverage(
  input: TypeCoverageProjectionInput,
): WarehouseCoverageTypeProjection[] {
  if (
    input.base.stale ||
    input.base.state === 'calculating' ||
    input.base.state === 'stale' ||
    input.base.availability !== 'verified_full'
  ) {
    return [];
  }

  const positions = [...input.positions].sort((left, right) =>
    compareOpaqueIdsBinary(left.positionId, right.positionId),
  );
  const matchesByPosition = new Map<string, PublishedCoverageMatch[]>();
  for (const match of input.matches) {
    const matches = matchesByPosition.get(match.positionId) ?? [];
    matches.push(match);
    matchesByPosition.set(match.positionId, matches);
  }

  const requiredRollCount = positions.reduce(
    (total, position) => safeCountSum(total, position.requiredRollCount),
    0,
  );
  const matchedRollCount = positions.reduce(
    (total, position) =>
      safeCountSum(total, matchesByPosition.get(position.positionId)?.length ?? 0),
    0,
  );
  if (
    new Set(positions.map(({ positionId }) => positionId)).size !== positions.length ||
    requiredRollCount !== input.base.requiredRollCount ||
    matchedRollCount !== input.base.matchedRollCount ||
    matchedRollCount !== input.matches.length
  ) {
    return [];
  }

  return positions.map((position) =>
    projectPosition(position, matchesByPosition.get(position.positionId) ?? []),
  );
}

function projectPosition(
  position: SelectedCoveragePosition,
  matches: readonly PublishedCoverageMatch[],
): WarehouseCoverageTypeProjection {
  const firstMatch = matches[0] ?? null;
  const requestedIngredients = projectIngredients(position.ingredients);
  const matchedIngredients = firstMatch ? projectIngredients(firstMatch.ingredients) : [];

  return {
    positionId: position.positionId,
    label: position.label,
    requiredRollCount: position.requiredRollCount,
    matchedRollCount: matches.length,
    uncertainRollCount: 0,
    requested: {
      filmType: position.filmType,
      actualThicknessMicron: fromMilli(position.actualThicknessMilliMicron),
      accountingThicknessMicron: fromMilli(position.accountingThicknessMilliMicron),
      widthMm: fromMilli(position.widthMilliMm),
      plannedLengthM: fromMilli(position.plannedLengthMilliM),
      weightKg: fromMilli(position.plannedWeightMilliKg),
      spoolType: position.spoolType,
      birka: position.birka,
      recipeName: position.recipeName,
      ingredients: requestedIngredients,
    },
    matched: {
      filmType: firstMatch?.filmType ?? null,
      actualThicknessMicron: nullableFromMilli(firstMatch?.actualThicknessMilliMicron),
      accountingThicknessMicron: nullableFromMilli(firstMatch?.accountingThicknessMilliMicron),
      widthMm: nullableFromMilli(firstMatch?.widthMilliMm),
      plannedLengthM: nullableFromMilli(firstMatch?.plannedLengthMilliM),
      weightKg: projectWeights(matches),
      spoolType: firstMatch?.spoolType ?? null,
      birka: firstMatch?.birka ?? null,
      recipeName: firstMatch?.recipeName ?? null,
      ingredients: matchedIngredients,
    },
    comparison: {
      filmType: matches.every((match) => sameText(match.filmType, position.filmType)),
      actualThickness: matches.every(
        (match) => match.actualThicknessMilliMicron === position.actualThicknessMilliMicron,
      ),
      accountingThickness: matches.every(
        (match) => match.accountingThicknessMilliMicron === position.accountingThicknessMilliMicron,
      ),
      width: matches.every((match) => match.widthMilliMm === position.widthMilliMm),
      plannedLength: matches.every(
        (match) => match.plannedLengthMilliM === position.plannedLengthMilliM,
      ),
      weightTolerance: matches.every((match) =>
        isWeightWithinFivePercent(match.actualWeightMilliKg, position.plannedWeightMilliKg),
      ),
      spoolType: matches.every((match) => sameText(match.spoolType, position.spoolType)),
      birka: matches.every((match) => sameText(match.birka, position.birka)),
      ingredients: matches.every((match) =>
        ingredientsEqual(projectIngredients(match.ingredients), requestedIngredients),
      ),
    },
  };
}

function projectWeights(
  matches: readonly PublishedCoverageMatch[],
): { min: number; max: number; total: number } | null {
  if (matches.length === 0) return null;
  let min = matches[0]!.actualWeightMilliKg;
  let max = min;
  let total = 0n;
  for (const { actualWeightMilliKg } of matches) {
    requirePositiveSafeInteger(actualWeightMilliKg, 'actualWeightMilliKg');
    min = Math.min(min, actualWeightMilliKg);
    max = Math.max(max, actualWeightMilliKg);
    total += BigInt(actualWeightMilliKg);
  }
  return {
    min: fromMilli(min),
    max: fromMilli(max),
    total: fromMilliBigInt(total),
  };
}

function projectIngredients(
  ingredients: readonly NamedIngredient[],
): Array<{ name: string; shareBasisPoints: number }> {
  const collapsed = new Map<string, { name: string; shareBasisPoints: number }>();
  for (const ingredient of ingredients) {
    const name = displayText(ingredient.name);
    const normalizedName = comparisonText(name);
    const shareBasisPoints = requirePositiveSafeInteger(
      ingredient.shareBasisPoints,
      'shareBasisPoints',
    );
    const current = collapsed.get(normalizedName);
    collapsed.set(normalizedName, {
      name: current && compareOpaqueIdsBinary(current.name, name) <= 0 ? current.name : name,
      shareBasisPoints: safeCountSum(current?.shareBasisPoints ?? 0, shareBasisPoints),
    });
  }
  return [...collapsed.entries()]
    .sort(([left], [right]) => compareOpaqueIdsBinary(left, right))
    .map(([, ingredient]) => ingredient);
}

function ingredientsEqual(
  left: readonly NamedIngredient[],
  right: readonly NamedIngredient[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ingredient, index) =>
        comparisonText(ingredient.name) === comparisonText(right[index]!.name) &&
        ingredient.shareBasisPoints === right[index]!.shareBasisPoints,
    )
  );
}

function sameText(left: string, right: string): boolean {
  return comparisonText(left) === comparisonText(right);
}

function displayText(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized) throw new Error('ingredient name must be a non-empty string');
  return normalized;
}

function comparisonText(value: string): string {
  return displayText(value).toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
}

function nullableFromMilli(value: number | undefined): number | null {
  return value === undefined ? null : fromMilli(value);
}

function fromMilli(value: number): number {
  requirePositiveSafeInteger(value, 'milli-unit');
  return Number((value / 1_000).toFixed(3));
}

function fromMilliBigInt(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('milli-unit total must be a positive safe integer');
  }
  return fromMilli(Number(value));
}

function safeCountSum(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new Error('coverage count must be a non-negative safe integer sum');
  }
  return left + right;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}
