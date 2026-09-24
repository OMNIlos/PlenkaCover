import { allocateRecipeWeight } from './recipe-weight-allocation';

describe('allocateRecipeWeight', () => {
  it('assigns the milligram rounding remainder to the last ingredient', () => {
    expect(
      allocateRecipeWeight(1, [
        { rawMaterialDefinitionId: 'a', shareBasisPoints: 3333 },
        { rawMaterialDefinitionId: 'b', shareBasisPoints: 3333 },
        { rawMaterialDefinitionId: 'c', shareBasisPoints: 3334 },
      ]),
    ).toEqual([
      { rawMaterialDefinitionId: 'a', plannedNeedKg: 0.333 },
      { rawMaterialDefinitionId: 'b', plannedNeedKg: 0.333 },
      { rawMaterialDefinitionId: 'c', plannedNeedKg: 0.334 },
    ]);
  });

  it('rounds the total once and preserves the exact milligram total', () => {
    const allocation = allocateRecipeWeight(10.0006, [
      { rawMaterialDefinitionId: 'a', shareBasisPoints: 5000 },
      { rawMaterialDefinitionId: 'b', shareBasisPoints: 5000 },
    ]);

    expect(allocation).toEqual([
      { rawMaterialDefinitionId: 'a', plannedNeedKg: 5 },
      { rawMaterialDefinitionId: 'b', plannedNeedKg: 5.001 },
    ]);
    expect(allocation.reduce((sum, ingredient) => sum + ingredient.plannedNeedKg, 0)).toBeCloseTo(
      10.001,
      10,
    );
  });
});
