import { ConflictException } from '@nestjs/common';
import type { WarehouseCoverageWorkflowVersion } from '@plenka/contracts';
import {
  canonicalDimension,
  canonicalizeCoveragePosition,
  type CanonicalCoveragePosition,
  normalizeIngredients,
  parseKgToMilliKg,
  parseThicknessMilliMicron,
} from './warehouse-coverage-canonical';

interface CoverageRecipeInput {
  id?: unknown;
  version?: unknown;
  recipeDefinitionId?: unknown;
  recipeDefinitionVersionId?: unknown;
  recipeVersionNumber?: unknown;
  ingredients?: unknown;
}

interface CoveragePositionInput {
  id?: unknown;
  rollCount?: unknown;
  filmType?: unknown;
  actualThickness?: unknown;
  accountingThickness?: unknown;
  widthMm?: unknown;
  plannedLengthM?: unknown;
  birka?: unknown;
  manualBirka?: unknown;
  spoolType?: unknown;
  plannedWeightKg?: unknown;
  baseRawMaterialDefinitionId?: unknown;
  recipeDefinitionVersionId?: unknown;
  recipe?: CoverageRecipeInput | null;
}

export interface CoverageOrderInput {
  counterpartyId?: unknown;
  positions?: readonly CoveragePositionInput[] | unknown;
}

type CompletenessResult =
  | { ok: true; positions: CanonicalCoveragePosition[] }
  | { ok: false; reasonCode: 'order_spec_incomplete'; missing: string[] };

export function workflowVersionForNewOrder(enabled: boolean): WarehouseCoverageWorkflowVersion {
  return enabled ? 2 : 1;
}

export function assertCoverageWorkflow(
  actual: WarehouseCoverageWorkflowVersion,
  expected: WarehouseCoverageWorkflowVersion,
): void {
  if (actual !== expected) {
    throw new ConflictException({
      statusCode: 409,
      code: 'warehouse_coverage_workflow_mismatch',
      expected,
      actual,
    });
  }
}

export function validateV2CoverageCompleteness(order: CoverageOrderInput): CompletenessResult {
  const missing: string[] = [];
  const positions: CanonicalCoveragePosition[] = [];
  if (!isOpaqueId(order.counterpartyId)) missing.push('counterpartyId');
  if (!Array.isArray(order.positions) || order.positions.length === 0) {
    missing.push('positions');
    return incomplete(missing);
  }

  order.positions.forEach((position, index) => {
    const path = (field: string) => `positions[${index}].${field}`;
    if (!position || typeof position !== 'object' || Array.isArray(position)) {
      missing.push(`positions[${index}]`);
      return;
    }

    const positionId = validOrMissing(() => requireOpaqueId(position.id), path('id'), missing);
    const rollCount = validOrMissing(
      () => requireRollCount(position.rollCount),
      path('rollCount'),
      missing,
    );
    const filmType = validOrMissing(
      () => requireNonEmptyText(position.filmType),
      path('filmType'),
      missing,
    );
    const actualThicknessMilliMicron = validOrMissing(
      () => parseThicknessMilliMicron(requireString(position.actualThickness)),
      path('actualThickness'),
      missing,
    );
    const accountingThicknessMilliMicron = validOrMissing(
      () => parseThicknessMilliMicron(requireString(position.accountingThickness)),
      path('accountingThickness'),
      missing,
    );
    const widthMilliMm = validOrMissing(
      () => requireCanonicalDimension(position.widthMm),
      path('widthMm'),
      missing,
    );
    const plannedLengthMilliM = validOrMissing(
      () => requireCanonicalDimension(position.plannedLengthM),
      path('plannedLengthM'),
      missing,
    );
    const birka = validOrMissing(
      () =>
        requireNonEmptyText(
          typeof position.birka === 'string' && position.birka.normalize('NFKC').trim()
            ? position.birka
            : position.manualBirka,
        ),
      path('birka'),
      missing,
    );
    const spoolType = validOrMissing(
      () => requireNonEmptyText(position.spoolType),
      path('spoolType'),
      missing,
    );
    const plannedWeightMilliKg = validOrMissing(
      () => parsePersistedKg(position.plannedWeightKg),
      path('plannedWeightKg'),
      missing,
    );

    const recipe = isRecord(position.recipe) ? position.recipe : null;
    if (!recipe) missing.push(path('recipe'));
    const recipeId = validOrMissing(() => requireOpaqueId(recipe?.id), path('recipe.id'), missing);
    const recipeVersion = validOrMissing(
      () => requireOpaqueId(recipe?.version),
      path('recipe.version'),
      missing,
    );
    const ingredients = validOrMissing(
      () => mapIngredients(recipe?.ingredients),
      path('recipe.ingredients'),
      missing,
    );

    const baseSelector = parseNullableOpaqueId(position.baseRawMaterialDefinitionId);
    const recipeSelector = parseNullableOpaqueId(position.recipeDefinitionVersionId);
    const selectorsValid = baseSelector.valid && recipeSelector.valid;
    const provenance =
      selectorsValid && recipe && ingredients
        ? validateMaterialSelection(baseSelector.value, recipeSelector.value, recipe, ingredients)
        : { ok: false as const };
    if (!selectorsValid || (recipe !== null && ingredients !== null && !provenance.ok)) {
      missing.push(path('materialSelection'));
    }

    if (
      positionId === null ||
      rollCount === null ||
      filmType === null ||
      actualThicknessMilliMicron === null ||
      accountingThicknessMilliMicron === null ||
      widthMilliMm === null ||
      plannedLengthMilliM === null ||
      birka === null ||
      spoolType === null ||
      plannedWeightMilliKg === null ||
      recipeId === null ||
      recipeVersion === null ||
      ingredients === null ||
      !provenance.ok
    ) {
      return;
    }

    try {
      positions.push(
        canonicalizeCoveragePosition({
          positionId,
          rollCount,
          filmType,
          actualThicknessMilliMicron,
          accountingThicknessMilliMicron,
          widthMilliMm,
          plannedLengthMilliM,
          birka,
          spoolType,
          plannedWeightMilliKg,
          ingredients,
          recipeId,
          recipeVersion,
          ...provenance.values,
        }),
      );
    } catch {
      missing.push(`positions[${index}]`);
    }
  });

  return missing.length > 0 ? incomplete(unique(missing)) : { ok: true, positions };
}

function requireCanonicalDimension(value: unknown): number {
  const canonical = canonicalDimension(value);
  if (canonical === null) throw new Error('dimension must be positive and finite');
  return canonical;
}

function validateMaterialSelection(
  baseId: string | null,
  selectedRecipeVersionId: string | null,
  recipe: Record<string, unknown> | null,
  ingredients: Array<{ rawMaterialDefinitionId: string; shareBasisPoints: number }> | null,
):
  | {
      ok: true;
      values: {
        recipeDefinitionId: string | null;
        recipeDefinitionVersionId: string | null;
        recipeVersionNumber: number | null;
      };
    }
  | { ok: false } {
  if (!recipe || !ingredients || (baseId === null) === (selectedRecipeVersionId === null)) {
    return { ok: false };
  }
  if (baseId !== null) {
    const valid =
      recipe.recipeDefinitionId == null &&
      recipe.recipeDefinitionVersionId == null &&
      recipe.recipeVersionNumber == null &&
      ingredients.length === 1 &&
      ingredients[0]?.rawMaterialDefinitionId === baseId &&
      ingredients[0]?.shareBasisPoints === 10_000;
    return valid
      ? {
          ok: true,
          values: {
            recipeDefinitionId: null,
            recipeDefinitionVersionId: null,
            recipeVersionNumber: null,
          },
        }
      : { ok: false };
  }

  const definitionId = nullableOpaqueId(recipe.recipeDefinitionId);
  const snapshotVersionId = nullableOpaqueId(recipe.recipeDefinitionVersionId);
  const versionNumber = recipe.recipeVersionNumber;
  const valid =
    definitionId !== null &&
    snapshotVersionId === selectedRecipeVersionId &&
    Number.isSafeInteger(versionNumber) &&
    (versionNumber as number) > 0;
  return valid
    ? {
        ok: true,
        values: {
          recipeDefinitionId: definitionId,
          recipeDefinitionVersionId: snapshotVersionId,
          recipeVersionNumber: versionNumber as number,
        },
      }
    : { ok: false };
}

function mapIngredients(
  value: unknown,
): Array<{ rawMaterialDefinitionId: string; shareBasisPoints: number }> {
  if (!Array.isArray(value) || value.length === 0) throw new Error('invalid ingredients');
  const stripped = value.map((ingredient) => {
    if (!isRecord(ingredient)) throw new Error('invalid ingredient');
    return {
      rawMaterialDefinitionId: requireOpaqueId(ingredient.rawMaterialDefinitionId),
      shareBasisPoints: requirePositiveSafeInteger(ingredient.shareBasisPoints),
    };
  });
  return normalizeIngredients(stripped);
}

function parsePersistedKg(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('invalid weight');
  return parseKgToMilliKg(String(value));
}

function requireRollCount(value: unknown): number {
  const parsed = requirePositiveSafeInteger(value);
  if (parsed > 10_000) throw new Error('invalid roll count');
  return parsed;
}

function requirePositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('invalid positive integer');
  }
  return value as number;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid string');
  return value;
}

function requireNonEmptyText(value: unknown): string {
  const text = requireString(value);
  if (!text.normalize('NFKC').trim()) throw new Error('invalid text');
  return text;
}

function requireOpaqueId(value: unknown): string {
  if (!isOpaqueId(value)) throw new Error('invalid opaque id');
  return value;
}

function nullableOpaqueId(value: unknown): string | null {
  return value == null ? null : isOpaqueId(value) ? value : null;
}

function parseNullableOpaqueId(
  value: unknown,
): { valid: true; value: string | null } | { valid: false; value: null } {
  if (value == null) return { valid: true, value: null };
  return isOpaqueId(value) ? { valid: true, value } : { valid: false, value: null };
}

function isOpaqueId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validOrMissing<T>(work: () => T, path: string, missing: string[]): T | null {
  try {
    return work();
  } catch {
    missing.push(path);
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function incomplete(missing: string[]): CompletenessResult {
  return { ok: false, reasonCode: 'order_spec_incomplete', missing };
}
