import type { Role } from '@plenka/contracts';
import type { CreateRecipeCatalogDto } from './dto/create-recipe-catalog.dto';

export const RESERVED_BASE_MATERIAL_NAMES = [
  'Первичное',
  'Вторичное',
  'Вторичка',
  'Айка',
  'Первичка ленты',
  'ПВД ТСП',
  'Данафлекс',
  'Стрейч',
] as const;

export type RecipeIngredientCommand = {
  rawMaterialDefinitionId?: string;
  /** Deprecated input retained only so domain validation rejects old clients safely. */
  newMaterial?: { name: string };
  shareBasisPoints: number;
};

export function normalizeCatalogName(name: string): string {
  const normalizedName = name.trim().normalize('NFKC').toLocaleLowerCase('ru-RU');
  return normalizedName === 'aйка' ? 'айка' : normalizedName;
}

const RESERVED_NORMALIZED_NAMES = new Set(RESERVED_BASE_MATERIAL_NAMES.map(normalizeCatalogName));

export function assertRecipeName(name: string): void {
  const normalizedName = normalizeCatalogName(name);
  if (normalizedName.length < 1 || normalizedName.length > 120) {
    throw new Error('Catalog name must contain between 1 and 120 characters');
  }
  if (RESERVED_NORMALIZED_NAMES.has(normalizedName)) {
    throw new Error('Catalog name is reserved for a base material');
  }
}

export function assertRecipeIngredients(ingredients: readonly RecipeIngredientCommand[]): void {
  if (ingredients.length < 1 || ingredients.length > 50) {
    throw new Error('Recipe must contain between 1 and 50 ingredients');
  }

  const existingMaterialIds = new Set<string>();
  let totalShareBasisPoints = 0;

  for (const ingredient of ingredients) {
    if (!Number.isInteger(ingredient.shareBasisPoints)) {
      throw new Error('Ingredient shareBasisPoints must be an integer');
    }
    if (ingredient.shareBasisPoints <= 0) {
      throw new Error('Ingredient shareBasisPoints must be positive');
    }

    const existingMaterialId = ingredient.rawMaterialDefinitionId as unknown;
    const newMaterial = ingredient.newMaterial as unknown;
    if (existingMaterialId === null || newMaterial === null) {
      throw new Error('Ingredient material sources cannot be null');
    }
    if (existingMaterialId !== undefined && typeof existingMaterialId !== 'string') {
      throw new Error('Ingredient rawMaterialDefinitionId must be a string');
    }
    if (
      newMaterial !== undefined &&
      (typeof newMaterial !== 'object' || Array.isArray(newMaterial))
    ) {
      throw new Error('Ingredient newMaterial must be an object');
    }

    const hasExistingMaterial = typeof existingMaterialId === 'string';
    const hasNewMaterial = newMaterial !== undefined;
    if (Number(hasExistingMaterial) + Number(hasNewMaterial) !== 1) {
      throw new Error('Ingredient must have exactly one material source');
    }
    if (hasNewMaterial) {
      throw new Error('New raw materials can only be created by the admin catalog');
    }

    if (hasExistingMaterial) {
      if (existingMaterialId.trim().length === 0) {
        throw new Error('Ingredient rawMaterialDefinitionId cannot be blank');
      }
      if (existingMaterialIds.has(existingMaterialId)) {
        throw new Error('Recipe contains a duplicate existing material');
      }
      existingMaterialIds.add(existingMaterialId);
    }

    totalShareBasisPoints += ingredient.shareBasisPoints;
  }

  if (totalShareBasisPoints !== 10_000) {
    throw new Error('Recipe ingredient shares must total exactly 10000 basis points');
  }
}

export function recipeCreateFingerprintInput(
  actor: { userId: string | null; role: Role },
  dto: CreateRecipeCatalogDto,
): object {
  return {
    actorId: actor.userId,
    actorRole: actor.role,
    name: normalizeCatalogName(dto.name),
    ingredients: dto.ingredients.map((ingredient) => ({
      rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
      shareBasisPoints: ingredient.shareBasisPoints,
    })),
  };
}
