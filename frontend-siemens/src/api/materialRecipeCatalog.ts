import { apiGet, apiPost } from './client';

export type RawMaterialCatalogItem = {
  id: string;
  name: string;
  kind: 'base' | 'custom';
};

export type RecipeIngredientShare = {
  rawMaterialDefinitionId: string;
  name: string;
  shareBasisPoints: number;
};

export type RecipeCatalogItem = {
  id: string;
  name: string;
  version: {
    id: string;
    version: number;
    ingredients: RecipeIngredientShare[];
  };
};

export type CreateRecipeCatalogCommand = {
  clientRequestId: string;
  name: string;
  ingredients: Array<{
    rawMaterialDefinitionId: string;
    shareBasisPoints: number;
  }>;
};

type JsonRecord = Record<string, unknown>;

function exactRecord(value: unknown, fields: readonly string[], context: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Некорректный ${context}.`);
  }
  const record = value as JsonRecord;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || !keys.every((key) => fields.includes(key))) {
    throw new Error(`Некорректный ${context}.`);
  }
  return record;
}

function identity(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`Некорректный ${context}.`);
  }
  return value;
}

function parseMaterial(value: unknown): RawMaterialCatalogItem {
  const record = exactRecord(value, ['id', 'name', 'kind'], 'каталог сырья');
  const id = identity(record.id, 'каталог сырья');
  const name = identity(record.name, 'каталог сырья');
  if (record.kind !== 'base' && record.kind !== 'custom') {
    throw new Error('Некорректный каталог сырья.');
  }
  return { id, name, kind: record.kind };
}

function parseIngredient(value: unknown): RecipeIngredientShare {
  const record = exactRecord(
    value,
    ['rawMaterialDefinitionId', 'name', 'shareBasisPoints'],
    'каталог рецептур',
  );
  const rawMaterialDefinitionId = identity(record.rawMaterialDefinitionId, 'каталог рецептур');
  const name = identity(record.name, 'каталог рецептур');
  const shareBasisPoints = record.shareBasisPoints;
  if (
    typeof shareBasisPoints !== 'number' ||
    !Number.isSafeInteger(shareBasisPoints) ||
    shareBasisPoints < 1 ||
    shareBasisPoints > 10_000
  ) {
    throw new Error('Некорректный каталог рецептур.');
  }
  return { rawMaterialDefinitionId, name, shareBasisPoints };
}

function parseRecipeItem(value: unknown): RecipeCatalogItem {
  const record = exactRecord(value, ['id', 'name', 'version'], 'каталог рецептур');
  const id = identity(record.id, 'каталог рецептур');
  const name = identity(record.name, 'каталог рецептур');
  const versionRecord = exactRecord(
    record.version,
    ['id', 'version', 'ingredients'],
    'каталог рецептур',
  );
  const versionId = identity(versionRecord.id, 'каталог рецептур');
  const version = versionRecord.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('Некорректный каталог рецептур.');
  }
  if (
    !Array.isArray(versionRecord.ingredients) ||
    versionRecord.ingredients.length < 1 ||
    versionRecord.ingredients.length > 50
  ) {
    throw new Error('Некорректный каталог рецептур.');
  }
  const ingredients = versionRecord.ingredients.map(parseIngredient);
  const ingredientIds = new Set(
    ingredients.map((ingredient) => ingredient.rawMaterialDefinitionId),
  );
  const total = ingredients.reduce((sum, ingredient) => sum + ingredient.shareBasisPoints, 0);
  if (ingredientIds.size !== ingredients.length || total !== 10_000) {
    throw new Error('Некорректный каталог рецептур.');
  }

  return {
    id,
    name,
    version: {
      id: versionId,
      version,
      ingredients,
    },
  };
}

export function parseMaterialCatalog(value: unknown): RawMaterialCatalogItem[] {
  if (!Array.isArray(value)) throw new Error('Некорректный каталог сырья.');
  const materials = value.map(parseMaterial);
  if (new Set(materials.map((item) => item.id)).size !== materials.length) {
    throw new Error('Некорректный каталог сырья.');
  }
  return materials;
}

export function parseRecipeCatalog(value: unknown): RecipeCatalogItem[] {
  if (!Array.isArray(value)) throw new Error('Некорректный каталог рецептур.');
  const recipes = value.map(parseRecipeItem);
  if (
    new Set(recipes.map((item) => item.id)).size !== recipes.length ||
    new Set(recipes.map((item) => item.version.id)).size !== recipes.length
  ) {
    throw new Error('Некорректный каталог рецептур.');
  }
  return recipes;
}

export function parseRecipe(value: unknown): RecipeCatalogItem {
  const [recipe] = parseRecipeCatalog([value]);
  if (!recipe) throw new Error('Некорректный каталог рецептур.');
  return recipe;
}

export async function fetchRawMaterialCatalog(query = ''): Promise<RawMaterialCatalogItem[]> {
  const normalized = query.trim();
  const suffix = normalized ? `?q=${encodeURIComponent(normalized)}` : '';
  return parseMaterialCatalog(await apiGet<unknown>(`/api/material-catalog${suffix}`));
}

export async function createRawMaterialCatalogItem(name: string): Promise<RawMaterialCatalogItem> {
  return parseMaterial(await apiPost<unknown>('/api/material-catalog', { name }));
}

export async function fetchRecipeCatalog(): Promise<RecipeCatalogItem[]> {
  return parseRecipeCatalog(await apiGet<unknown>('/api/recipe-catalog'));
}

export async function createRecipeCatalogItem(
  command: CreateRecipeCatalogCommand,
): Promise<RecipeCatalogItem> {
  const request: CreateRecipeCatalogCommand = {
    clientRequestId: command.clientRequestId,
    name: command.name,
    ingredients: command.ingredients.map((ingredient) => ({
      rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
      shareBasisPoints: ingredient.shareBasisPoints,
    })),
  };
  return parseRecipe(await apiPost<unknown>('/api/recipe-catalog', request));
}
