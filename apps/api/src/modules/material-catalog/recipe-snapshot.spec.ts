import { parseRecipeSnapshotIngredients, recipeSnapshotMatchesVersion } from './recipe-snapshot';

describe('parseRecipeSnapshotIngredients', () => {
  const first = {
    rawMaterialDefinitionId: 'm-1',
    name: 'Первичное',
    shareBasisPoints: 8000,
  };
  const second = {
    rawMaterialDefinitionId: 'm-2',
    name: 'Краситель',
    shareBasisPoints: 2000,
  };

  it('preserves an exact ordered server snapshot', () => {
    expect(parseRecipeSnapshotIngredients([first, second], true)).toEqual({
      kind: 'valid',
      ingredients: [first, second],
    });
  });

  it('treats null as legacy only when no structured selector exists', () => {
    expect(parseRecipeSnapshotIngredients(null, false)).toEqual({ kind: 'legacy' });
    expect(parseRecipeSnapshotIngredients(null, true)).toEqual({
      kind: 'invalid',
      identifiableDefinitionIds: [],
    });
  });

  it.each([
    { ingredients: [] },
    { ingredients: [{ ...first, shareBasisPoints: 9000 }] },
    {
      ingredients: [first, { ...second, rawMaterialDefinitionId: first.rawMaterialDefinitionId }],
    },
    { ingredients: [first, { ...second, name: '' }] },
    { ingredients: [{ ...first, rawMaterialDefinitionId: ' m-1' }, second] },
    { ingredients: [{ ...first, name: ' Первичное ' }, second] },
    { ingredients: [{ ...first, name: 'x'.repeat(121) }, second] },
  ])('rejects malformed composition without partially accepting it', ({ ingredients }) => {
    expect(parseRecipeSnapshotIngredients(ingredients, true)).toEqual(
      expect.objectContaining({ kind: 'invalid' }),
    );
  });

  it('retains safe identifiers from malformed rows for fail-safe risk projection', () => {
    expect(
      parseRecipeSnapshotIngredients(
        [
          { ...first, shareBasisPoints: 9000 },
          { rawMaterialDefinitionId: 'm-2', name: 42, shareBasisPoints: 1000 },
        ],
        true,
      ),
    ).toEqual({
      kind: 'invalid',
      identifiableDefinitionIds: ['m-1', 'm-2'],
    });
  });

  it('matches only the exact authoritative ordered ids, names, and shares', () => {
    const authoritative = [
      {
        sequence: 1,
        shareBasisPoints: 8000,
        rawMaterialDefinition: { id: 'm-1', name: 'Первичное' },
      },
      {
        sequence: 2,
        shareBasisPoints: 2000,
        rawMaterialDefinition: { id: 'm-2', name: 'Краситель' },
      },
    ];

    expect(recipeSnapshotMatchesVersion([first, second], authoritative)).toBe(true);
    expect(
      recipeSnapshotMatchesVersion([first, { ...second, name: 'Подменённое имя' }], authoritative),
    ).toBe(false);
    expect(
      recipeSnapshotMatchesVersion(
        [first, { ...second, rawMaterialDefinitionId: 'm-ghost' }],
        authoritative,
      ),
    ).toBe(false);
    expect(
      recipeSnapshotMatchesVersion(
        [
          { ...first, shareBasisPoints: 7000 },
          { ...second, shareBasisPoints: 3000 },
        ],
        authoritative,
      ),
    ).toBe(false);
  });
});
