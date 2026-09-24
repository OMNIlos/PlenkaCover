import { requestFingerprint } from '../../common/idempotency/request-fingerprint';

export const WAREHOUSE_COVERAGE_POLICY_VERSION = 'warehouse-coverage-policy/v2' as const;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const COVERAGE_POSITION_KEYS = new Set([
  'positionId',
  'rollCount',
  'filmType',
  'actualThicknessMilliMicron',
  'accountingThicknessMilliMicron',
  'widthMilliMm',
  'plannedLengthMilliM',
  'birka',
  'spoolType',
  'plannedWeightMilliKg',
  'ingredients',
  'recipeId',
  'recipeVersion',
  'recipeDefinitionId',
  'recipeDefinitionVersionId',
  'recipeVersionNumber',
]);
const ROLL_COVERAGE_SPEC_KEYS = new Set([
  'rollCode',
  'sourceOrderId',
  'sourcePositionId',
  'ownerCounterpartyId',
  'filmType',
  'actualThicknessMilliMicron',
  'accountingThicknessMilliMicron',
  'widthMilliMm',
  'plannedLengthMilliM',
  'birka',
  'spoolType',
  'actualWeightMilliKg',
  'plannedWeightMilliKg',
  'ingredients',
  'recipeId',
  'recipeVersion',
  'recipeDefinitionId',
  'recipeDefinitionVersionId',
  'recipeVersionNumber',
  'policyVersion',
]);

export interface CanonicalIngredient {
  rawMaterialDefinitionId: string;
  shareBasisPoints: number;
}

export interface CanonicalCoveragePosition {
  positionId: string;
  rollCount: number;
  filmType: string;
  actualThicknessMilliMicron: number;
  accountingThicknessMilliMicron: number;
  widthMilliMm: number;
  plannedLengthMilliM: number;
  birka: string;
  spoolType: string;
  plannedWeightMilliKg: number;
  ingredients: readonly CanonicalIngredient[];
  recipeId: string | null;
  recipeVersion: string | null;
  recipeDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeVersionNumber: number | null;
}

export interface CanonicalRollCoverageSpec {
  rollCode: string;
  sourceOrderId: string | null;
  sourcePositionId: string | null;
  ownerCounterpartyId: string | null;
  filmType: string;
  actualThicknessMilliMicron: number;
  accountingThicknessMilliMicron: number;
  widthMilliMm: number;
  plannedLengthMilliM: number;
  birka: string;
  spoolType: string;
  actualWeightMilliKg: number;
  plannedWeightMilliKg: number;
  ingredients: readonly CanonicalIngredient[];
  recipeId: string | null;
  recipeVersion: string | null;
  recipeDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeVersionNumber: number | null;
  policyVersion: typeof WAREHOUSE_COVERAGE_POLICY_VERSION;
}

type CanonicalRecipeProvenance = Pick<
  CanonicalCoveragePosition,
  | 'recipeId'
  | 'recipeVersion'
  | 'recipeDefinitionId'
  | 'recipeDefinitionVersionId'
  | 'recipeVersionNumber'
>;

export function normalizeCoverageText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('coverage text must be a non-empty string');
  }
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е');
  if (!normalized) throw new Error('coverage text must be a non-empty string');
  return normalized;
}

export function normalizeSpool(value: unknown): string {
  let normalized = normalizeCoverageText(value)
    .replace(/^шпуля(?:\s+|$)/u, '')
    .trim();
  normalized = normalized.replace(/\s*(?:mm|мм)$/u, ' мм').trim();
  if (!normalized) throw new Error('spoolType must be a non-empty string');
  return normalized;
}

export function compareOpaqueIdsBinary(left: string, right: string): number {
  assertWellFormedUnicode(left, 'left opaque ID');
  assertWellFormedUnicode(right, 'right opaque ID');
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function parseKgToMilliKg(value: string): number {
  return parsePositiveDecimal(
    value,
    /^(?<whole>\d+)(?:[.,](?<fraction>\d+))?(?:\s*(?:кг|kg))?$/u,
    'weight',
  );
}

export function parseThicknessMilliMicron(value: string): number {
  return parsePositiveDecimal(
    value,
    /^(?<whole>\d+)(?:[.,](?<fraction>\d+))?(?:\s*(?:мкм|µm|μm|um))?$/u,
    'thickness',
  );
}

export function canonicalDimension(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const scaled = Math.round(value * 1_000);
  return Number.isSafeInteger(scaled) && scaled > 0 ? scaled : null;
}

export function normalizeIngredients(input: unknown): CanonicalIngredient[] {
  if (!Array.isArray(input) || input.length < 1) {
    throw new Error('ingredients must contain at least one item');
  }
  const ingredients = input.map((value, index) => {
    const source = requireRecord(value, `ingredients[${index}]`);
    const keys = Object.keys(source);
    if (
      keys.length !== 2 ||
      !hasOwn(source, 'rawMaterialDefinitionId') ||
      !hasOwn(source, 'shareBasisPoints')
    ) {
      throw new Error(
        `ingredients[${index}] must contain only rawMaterialDefinitionId and shareBasisPoints`,
      );
    }
    return {
      rawMaterialDefinitionId: requireOpaqueId(
        required(source, 'rawMaterialDefinitionId'),
        `ingredients[${index}].rawMaterialDefinitionId`,
      ),
      shareBasisPoints: requirePositiveSafeInteger(
        required(source, 'shareBasisPoints'),
        `ingredients[${index}].shareBasisPoints`,
      ),
    };
  });
  ingredients.sort((left, right) =>
    compareOpaqueIdsBinary(left.rawMaterialDefinitionId, right.rawMaterialDefinitionId),
  );
  for (let index = 1; index < ingredients.length; index += 1) {
    if (
      ingredients[index - 1].rawMaterialDefinitionId === ingredients[index].rawMaterialDefinitionId
    ) {
      throw new Error('ingredients contain a duplicate rawMaterialDefinitionId');
    }
  }
  const total = ingredients.reduce(
    (sum, ingredient) => sum + BigInt(ingredient.shareBasisPoints),
    0n,
  );
  if (total !== 10_000n) throw new Error('ingredient shares must total exactly 10_000');
  return ingredients;
}

export function canonicalizeCoveragePosition(input: unknown): CanonicalCoveragePosition {
  const source = requireRecord(input, 'coverage position');
  assertExactKeys(source, COVERAGE_POSITION_KEYS);
  return {
    positionId: requireOpaqueId(required(source, 'positionId'), 'positionId'),
    rollCount: requirePositiveSafeInteger(required(source, 'rollCount'), 'rollCount', 10_000),
    filmType: normalizeCoverageText(required(source, 'filmType')),
    actualThicknessMilliMicron: requirePositiveSafeInteger(
      required(source, 'actualThicknessMilliMicron'),
      'actualThicknessMilliMicron',
    ),
    accountingThicknessMilliMicron: requirePositiveSafeInteger(
      required(source, 'accountingThicknessMilliMicron'),
      'accountingThicknessMilliMicron',
    ),
    widthMilliMm: requirePositiveSafeInteger(required(source, 'widthMilliMm'), 'widthMilliMm'),
    plannedLengthMilliM: requirePositiveSafeInteger(
      required(source, 'plannedLengthMilliM'),
      'plannedLengthMilliM',
    ),
    birka: normalizeCoverageText(required(source, 'birka')),
    spoolType: normalizeSpool(required(source, 'spoolType')),
    plannedWeightMilliKg: requirePositiveSafeInteger(
      required(source, 'plannedWeightMilliKg'),
      'plannedWeightMilliKg',
    ),
    ingredients: normalizeIngredients(required(source, 'ingredients')),
    ...canonicalizeRecipeProvenance(source),
  };
}

export function canonicalizeRollCoverageSpec(input: unknown): CanonicalRollCoverageSpec {
  const source = requireRecord(input, 'roll coverage spec');
  assertExactKeys(source, ROLL_COVERAGE_SPEC_KEYS);
  const policyVersion = required(source, 'policyVersion');
  if (policyVersion !== WAREHOUSE_COVERAGE_POLICY_VERSION) {
    throw new Error(`policyVersion must be ${WAREHOUSE_COVERAGE_POLICY_VERSION}`);
  }
  return {
    rollCode: requireOpaqueId(required(source, 'rollCode'), 'rollCode'),
    sourceOrderId: requireNullableOpaqueId(source, 'sourceOrderId'),
    sourcePositionId: requireNullableOpaqueId(source, 'sourcePositionId'),
    ownerCounterpartyId: requireNullableOpaqueId(source, 'ownerCounterpartyId'),
    filmType: normalizeCoverageText(required(source, 'filmType')),
    actualThicknessMilliMicron: requirePositiveSafeInteger(
      required(source, 'actualThicknessMilliMicron'),
      'actualThicknessMilliMicron',
    ),
    accountingThicknessMilliMicron: requirePositiveSafeInteger(
      required(source, 'accountingThicknessMilliMicron'),
      'accountingThicknessMilliMicron',
    ),
    widthMilliMm: requirePositiveSafeInteger(required(source, 'widthMilliMm'), 'widthMilliMm'),
    plannedLengthMilliM: requirePositiveSafeInteger(
      required(source, 'plannedLengthMilliM'),
      'plannedLengthMilliM',
    ),
    birka: normalizeCoverageText(required(source, 'birka')),
    spoolType: normalizeSpool(required(source, 'spoolType')),
    actualWeightMilliKg: requirePositiveSafeInteger(
      required(source, 'actualWeightMilliKg'),
      'actualWeightMilliKg',
    ),
    plannedWeightMilliKg: requirePositiveSafeInteger(
      required(source, 'plannedWeightMilliKg'),
      'plannedWeightMilliKg',
    ),
    ingredients: normalizeIngredients(required(source, 'ingredients')),
    ...canonicalizeRecipeProvenance(source),
    policyVersion,
  };
}

export function fingerprintRollFact(spec: CanonicalRollCoverageSpec): string {
  return requestFingerprint(canonicalizeRollCoverageSpec(spec));
}

export function isWeightWithinFivePercent(actual: number, planned: number): boolean {
  const actualInteger = requirePositiveSafeInteger(actual, 'actualWeightMilliKg');
  const plannedInteger = requirePositiveSafeInteger(planned, 'plannedWeightMilliKg');
  const actualBigInt = BigInt(actualInteger);
  const plannedBigInt = BigInt(plannedInteger);
  const difference =
    actualBigInt >= plannedBigInt ? actualBigInt - plannedBigInt : plannedBigInt - actualBigInt;
  return difference * 100n <= plannedBigInt * 5n;
}

export function coverageSpecsCompatible(
  position: CanonicalCoveragePosition,
  roll: CanonicalRollCoverageSpec,
): boolean {
  return (
    roll.policyVersion === WAREHOUSE_COVERAGE_POLICY_VERSION &&
    position.filmType === roll.filmType &&
    position.actualThicknessMilliMicron === roll.actualThicknessMilliMicron &&
    position.accountingThicknessMilliMicron === roll.accountingThicknessMilliMicron &&
    position.widthMilliMm === roll.widthMilliMm &&
    position.plannedLengthMilliM === roll.plannedLengthMilliM &&
    position.birka === roll.birka &&
    position.spoolType === roll.spoolType &&
    ingredientsEqual(position.ingredients, roll.ingredients) &&
    isWeightWithinFivePercent(roll.actualWeightMilliKg, position.plannedWeightMilliKg)
  );
}

function parsePositiveDecimal(value: string, pattern: RegExp, field: string): number {
  if (typeof value !== 'string') throw new Error(`${field} must be one positive decimal`);
  const match = pattern.exec(value.normalize('NFKC').trim().toLocaleLowerCase('ru-RU'));
  if (!match?.groups) throw new Error(`${field} must be one positive decimal`);
  const fraction = match.groups.fraction ?? '';
  if (fraction.length > 3) throw new Error(`${field} must have at most 3 decimal places`);
  const scaled = BigInt(match.groups.whole) * 1_000n + BigInt(fraction.padEnd(3, '0') || '0');
  if (scaled <= 0n) throw new Error(`${field} must be one positive decimal`);
  if (scaled > MAX_SAFE_BIGINT) throw new Error(`${field} exceeds a safe integer`);
  return Number(scaled);
}

function canonicalizeRecipeProvenance(source: Record<string, unknown>): CanonicalRecipeProvenance {
  return {
    recipeId: requireNullableOpaqueId(source, 'recipeId'),
    recipeVersion: requireNullableOpaqueId(source, 'recipeVersion'),
    recipeDefinitionId: requireNullableOpaqueId(source, 'recipeDefinitionId'),
    recipeDefinitionVersionId: requireNullableOpaqueId(source, 'recipeDefinitionVersionId'),
    recipeVersionNumber: requireNullablePositiveSafeInteger(source, 'recipeVersionNumber'),
  };
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

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function required(source: Record<string, unknown>, key: string): unknown {
  if (!hasOwn(source, key) || source[key] === undefined) {
    throw new Error(`${key} is required`);
  }
  return source[key];
}

function requireOpaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty opaque ID`);
  }
  assertWellFormedUnicode(value, field);
  return value;
}

function requireNullableOpaqueId(source: Record<string, unknown>, key: string): string | null {
  const value = required(source, key);
  return value === null ? null : requireOpaqueId(value, key);
}

function requirePositiveSafeInteger(value: unknown, field: string, maximum?: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireNullablePositiveSafeInteger(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = required(source, key);
  return value === null ? null : requirePositiveSafeInteger(value, key);
}

function assertExactKeys(source: Record<string, unknown>, expectedKeys: ReadonlySet<string>): void {
  for (const key of Object.keys(source)) {
    if (!expectedKeys.has(key)) throw new Error(`unexpected key ${key}`);
  }
}

function assertWellFormedUnicode(value: string, field: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new Error(`${field} must contain well-formed Unicode`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${field} must contain well-formed Unicode`);
    }
  }
}
