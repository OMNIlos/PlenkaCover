import type {
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../api/materialRecipeCatalog';
import type { IntakeDraftForm, IntakeDraftPosition } from './prototypeRuntime';

export const COMMERCIAL_FILM_TYPES = [
  'Рукав',
  'Полотно',
  'Полурукав',
  'Фальц',
] as const;

export const COMMERCIAL_BIRKA_OPTIONS = [
  'ГОСТ',
  'i',
  'Тех',
  'ГОСТ103',
  'ГОСТ259',
] as const;

export const COMMERCIAL_SPOOL_OPTIONS = ['Тонкая', 'Толстая'] as const;

export type CommercialMaterialSelector =
  | { baseRawMaterialDefinitionId: string; recipeDefinitionVersionId?: never }
  | { recipeDefinitionVersionId: string; baseRawMaterialDefinitionId?: never };

export type CommercialMaterialSelectorValue =
  | `material:${string}`
  | `recipe:${string}`;

export type CommercialOrderMaterialPayload =
  | {
      baseRawMaterialDefinitionId: string;
      recipeDefinitionVersionId?: never;
    }
  | {
      recipeDefinitionVersionId: string;
      baseRawMaterialDefinitionId?: never;
    };

const COMMERCIAL_ORDER_CATALOG_STALE_CODES = new Set([
  'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
  'RECIPE_VERSION_UNAVAILABLE',
  'RECIPE_VERSION_STALE',
  'RECIPE_COMPONENT_UNAVAILABLE',
]);

function isIdentity(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

export function encodeBaseMaterialSelectorValue(
  rawMaterialDefinitionId: string,
): CommercialMaterialSelectorValue {
  if (!isIdentity(rawMaterialDefinitionId)) {
    throw new Error('Некорректный идентификатор сырья.');
  }
  return `material:${rawMaterialDefinitionId}`;
}

export function encodeRecipeSelectorValue(
  recipeDefinitionVersionId: string,
): CommercialMaterialSelectorValue {
  if (!isIdentity(recipeDefinitionVersionId)) {
    throw new Error('Некорректный идентификатор рецептуры.');
  }
  return `recipe:${recipeDefinitionVersionId}`;
}

export function decodeCommercialMaterialSelectorValue(
  value: string,
): CommercialMaterialSelector | null {
  if (value.startsWith('material:')) {
    const id = value.slice('material:'.length);
    return isIdentity(id) && value.trim() === value
      ? { baseRawMaterialDefinitionId: id }
      : null;
  }
  if (value.startsWith('recipe:')) {
    const id = value.slice('recipe:'.length);
    return isIdentity(id) && value.trim() === value
      ? { recipeDefinitionVersionId: id }
      : null;
  }
  return null;
}

export function commercialMaterialSelectorValueForPosition(
  position: Pick<
    IntakeDraftPosition,
    'baseRawMaterialDefinitionId' | 'recipeDefinitionVersionId'
  >,
): CommercialMaterialSelectorValue | '' {
  const baseId = position.baseRawMaterialDefinitionId.trim();
  const recipeId = position.recipeDefinitionVersionId.trim();
  if (baseId && !recipeId) return encodeBaseMaterialSelectorValue(baseId);
  if (recipeId && !baseId) return encodeRecipeSelectorValue(recipeId);
  return '';
}

export function commercialOrderMaterialPayloadForPosition(
  position: Pick<
    IntakeDraftPosition,
    'baseRawMaterialDefinitionId' | 'recipeDefinitionVersionId'
  >,
): CommercialOrderMaterialPayload {
  const selected = commercialMaterialSelectorValueForPosition(position);
  const decoded = decodeCommercialMaterialSelectorValue(selected);
  if (!decoded) {
    throw new Error('Выберите сырьё или сохранённую рецептуру.');
  }
  return decoded;
}

function requiredDimension(value: string, label: string, max: number): number {
  const normalized = value.trim().replace(',', '.');
  const number = Number(normalized);
  if (
    !/^\d+(?:\.\d{1,3})?$/.test(normalized) ||
    !Number.isFinite(number) ||
    number < 0.001 ||
    number > max
  ) {
    throw new Error(
      `${label}: укажите число от 0,001 до ${max}, не более трёх знаков после запятой.`,
    );
  }
  return number;
}

export function commercialOrderPositionPayloadForDraft(position: IntakeDraftPosition) {
  const plannedWeightKg = position.plannedWeightKg.trim()
    ? Number(position.plannedWeightKg.replace(',', '.'))
    : undefined;
  return {
    rollCount: Number(position.rollCount),
    filmType: position.filmType.trim(),
    actualThickness: position.actualThickness.trim(),
    accountingThickness: position.accountingThickness.trim(),
    widthMm: requiredDimension(position.widthMm, 'Ширина, мм', 100_000),
    plannedLengthM: requiredDimension(position.plannedLengthM, 'Метраж, м', 10_000_000),
    ...commercialOrderMaterialPayloadForPosition(position),
    ...(position.spoolType.trim() ? { spoolType: position.spoolType.trim() } : {}),
    ...(position.birka.trim() ? { birka: position.birka.trim() } : {}),
    ...(position.manualBirka.trim() ? { manualBirka: position.manualBirka.trim() } : {}),
    ...(position.comment.trim() ? { comment: position.comment.trim() } : {}),
    ...(plannedWeightKg !== undefined ? { plannedWeightKg } : {}),
  };
}

export function isCommercialMaterialSelectionAvailable(
  position: Pick<
    IntakeDraftPosition,
    'baseRawMaterialDefinitionId' | 'recipeDefinitionVersionId'
  >,
  materials: readonly RawMaterialCatalogItem[],
  recipes: readonly RecipeCatalogItem[],
): boolean {
  const selector = decodeCommercialMaterialSelectorValue(
    commercialMaterialSelectorValueForPosition(position),
  );
  if (!selector) return false;
  if ('baseRawMaterialDefinitionId' in selector) {
    return materials.some(
      (material) => material.id === selector.baseRawMaterialDefinitionId,
    );
  }
  return recipes.some(
    (recipe) => recipe.version.id === selector.recipeDefinitionVersionId,
  );
}

export function applyCommercialMaterialSelector(
  position: IntakeDraftPosition,
  value: string,
  materials: readonly RawMaterialCatalogItem[],
  recipes: readonly RecipeCatalogItem[],
): IntakeDraftPosition {
  if (!value) {
    return {
      ...position,
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
      rawMaterial: '',
      rawMaterialId: '',
    };
  }

  const selection = decodeCommercialMaterialSelectorValue(value);
  if (!selection) throw new Error('Некорректный выбор сырья.');

  if ('baseRawMaterialDefinitionId' in selection) {
    const material = materials.find(
      (item) => item.id === selection.baseRawMaterialDefinitionId,
    );
    if (!material) throw new Error('Сырьё больше недоступно. Обновите каталог.');
    return {
      ...position,
      baseRawMaterialDefinitionId: material.id,
      recipeDefinitionVersionId: '',
      rawMaterial: material.name,
      rawMaterialId: '',
    };
  }

  const recipe = recipes.find(
    (item) => item.version.id === selection.recipeDefinitionVersionId,
  );
  if (!recipe) throw new Error('Рецептура больше недоступна. Обновите каталог.');
  return {
    ...position,
    baseRawMaterialDefinitionId: '',
    recipeDefinitionVersionId: recipe.version.id,
    rawMaterial: recipe.name,
    rawMaterialId: '',
  };
}

export function applyCreatedRecipeToIntakeDraft(
  form: IntakeDraftForm,
  positionId: string,
  recipe: RecipeCatalogItem,
  materials: readonly RawMaterialCatalogItem[],
  recipes: readonly RecipeCatalogItem[],
): IntakeDraftForm {
  return {
    ...form,
    positions: form.positions.map((position) =>
      position.id === positionId
        ? applyCommercialMaterialSelector(
            position,
            encodeRecipeSelectorValue(recipe.version.id),
            materials,
            [...recipes, recipe],
          )
        : position,
    ),
  };
}

export function isCommercialOrderCatalogStaleCode(
  code: string | null | undefined,
): boolean {
  return code !== null && code !== undefined && COMMERCIAL_ORDER_CATALOG_STALE_CODES.has(code);
}

export function isCommercialOrderCatalogStaleError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return isCommercialOrderCatalogStaleCode(
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null,
  );
}

export const COMMERCIAL_ORDER_CATALOG_STALE_MESSAGE =
  'Каталог сырья и рецептур обновлён. Проверьте выбор в заявке и повторите отправку.';
