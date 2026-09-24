import type { RecipeIngredientShare } from '@plenka/contracts';

export type RecipeSnapshotIngredients =
  | { kind: 'legacy' }
  | { kind: 'valid'; ingredients: RecipeIngredientShare[] }
  | { kind: 'invalid'; identifiableDefinitionIds: string[] };

export type AuthoritativeRecipeIngredient = {
  sequence: number;
  shareBasisPoints: number;
  rawMaterialDefinition: { id: string; name: string };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseRecipeSnapshotIngredients(
  value: unknown,
  structuredSelectionPresent: boolean,
): RecipeSnapshotIngredients {
  if (value == null) {
    return structuredSelectionPresent
      ? { kind: 'invalid', identifiableDefinitionIds: [] }
      : { kind: 'legacy' };
  }
  if (!Array.isArray(value)) {
    return { kind: 'invalid', identifiableDefinitionIds: [] };
  }

  const identifiableDefinitionIds = [
    ...new Set(
      value.flatMap((item) => {
        if (!isObject(item)) return [];
        const id = item.rawMaterialDefinitionId;
        return typeof id === 'string' && id.trim() === id && id.length > 0 ? [id] : [];
      }),
    ),
  ];
  if (value.length < 1 || value.length > 50) {
    return { kind: 'invalid', identifiableDefinitionIds };
  }

  const ingredients: RecipeIngredientShare[] = [];
  const materialIds = new Set<string>();
  let totalShareBasisPoints = 0;
  for (const item of value) {
    if (!isObject(item)) {
      return { kind: 'invalid', identifiableDefinitionIds };
    }
    const { rawMaterialDefinitionId, name, shareBasisPoints } = item;
    if (
      typeof rawMaterialDefinitionId !== 'string' ||
      rawMaterialDefinitionId.trim() !== rawMaterialDefinitionId ||
      rawMaterialDefinitionId.length === 0 ||
      typeof name !== 'string' ||
      name.trim() !== name ||
      name.length === 0 ||
      name.length > 120 ||
      typeof shareBasisPoints !== 'number' ||
      !Number.isInteger(shareBasisPoints) ||
      shareBasisPoints <= 0 ||
      materialIds.has(rawMaterialDefinitionId)
    ) {
      return { kind: 'invalid', identifiableDefinitionIds };
    }
    materialIds.add(rawMaterialDefinitionId);
    totalShareBasisPoints += shareBasisPoints;
    ingredients.push({ rawMaterialDefinitionId, name, shareBasisPoints });
  }
  if (totalShareBasisPoints !== 10_000) {
    return { kind: 'invalid', identifiableDefinitionIds };
  }

  return { kind: 'valid', ingredients };
}

export function recipeSnapshotMatchesVersion(
  snapshot: readonly RecipeIngredientShare[],
  authoritative: readonly AuthoritativeRecipeIngredient[],
): boolean {
  return (
    snapshot.length === authoritative.length &&
    snapshot.every((ingredient, index) => {
      const expected = authoritative[index];
      return (
        expected?.sequence === index + 1 &&
        ingredient.rawMaterialDefinitionId === expected.rawMaterialDefinition.id &&
        ingredient.name === expected.rawMaterialDefinition.name &&
        ingredient.shareBasisPoints === expected.shareBasisPoints
      );
    })
  );
}
