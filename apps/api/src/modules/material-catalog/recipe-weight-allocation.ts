import type { RecipeIngredientShare } from '@plenka/contracts';

export function allocateRecipeWeight(
  totalKg: number,
  ingredients: readonly Pick<
    RecipeIngredientShare,
    'rawMaterialDefinitionId' | 'shareBasisPoints'
  >[],
): Array<{ rawMaterialDefinitionId: string; plannedNeedKg: number }> {
  const totalMilliKg = Math.round(totalKg * 1000);
  let assignedMilliKg = 0;

  return ingredients.map((ingredient, index) => {
    const milliKg =
      index === ingredients.length - 1
        ? totalMilliKg - assignedMilliKg
        : Math.floor((totalMilliKg * ingredient.shareBasisPoints) / 10_000);
    assignedMilliKg += milliKg;

    return {
      rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
      plannedNeedKg: milliKg / 1000,
    };
  });
}
