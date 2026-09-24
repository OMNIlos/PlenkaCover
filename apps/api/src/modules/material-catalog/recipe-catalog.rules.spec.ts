import { plainToInstance } from 'class-transformer';
import { CreateRecipeCatalogDto } from './dto/create-recipe-catalog.dto';
import {
  assertRecipeIngredients,
  assertRecipeName,
  normalizeCatalogName,
  recipeCreateFingerprintInput,
  type RecipeIngredientCommand,
} from './recipe-catalog.rules';

describe('recipe catalog rules', () => {
  it('normalizes trim, Unicode compatibility, and Russian case', () => {
    expect(normalizeCatalogName('  ПЕРВИЧНОЕ  ')).toBe('первичное');
    expect(normalizeCatalogName('Ａйка')).toBe('айка');
  });

  it('rejects blank, overlong, and reserved recipe names', () => {
    expect(() => assertRecipeName('')).toThrow();
    expect(() => assertRecipeName('x'.repeat(121))).toThrow();
    expect(() => assertRecipeName(' первичное ')).toThrow('reserved');
  });

  it('accepts one through fifty unique positive ingredients totaling 10000', () => {
    expect(() =>
      assertRecipeIngredients([
        { rawMaterialDefinitionId: 'm-1', shareBasisPoints: 6000 },
        { rawMaterialDefinitionId: 'm-2', shareBasisPoints: 4000 },
      ]),
    ).not.toThrow();
    expect(() =>
      assertRecipeIngredients(
        Array.from({ length: 50 }, (_, index) => ({
          rawMaterialDefinitionId: `m-${index}`,
          shareBasisPoints: 200,
        })),
      ),
    ).not.toThrow();
  });

  it('rejects ingredient counts outside one through fifty', () => {
    expect(() => assertRecipeIngredients([])).toThrow('1');
    expect(() =>
      assertRecipeIngredients(
        Array.from({ length: 51 }, (_, index) => ({
          rawMaterialDefinitionId: `m-${index}`,
          shareBasisPoints: index === 50 ? 9950 : 1,
        })),
      ),
    ).toThrow('50');
  });

  it('requires integer positive shares totaling exactly 10000', () => {
    expect(() =>
      assertRecipeIngredients([{ rawMaterialDefinitionId: 'm-1', shareBasisPoints: 9999 }]),
    ).toThrow('10000');
    expect(() =>
      assertRecipeIngredients([
        { rawMaterialDefinitionId: 'm-1', shareBasisPoints: 9999.5 },
        { rawMaterialDefinitionId: 'm-2', shareBasisPoints: 0.5 },
      ]),
    ).toThrow('integer');
    expect(() =>
      assertRecipeIngredients([
        { rawMaterialDefinitionId: 'm-1', shareBasisPoints: 10_001 },
        { rawMaterialDefinitionId: 'm-2', shareBasisPoints: -1 },
      ]),
    ).toThrow('positive');
  });

  it('requires exactly one existing catalog material per ingredient', () => {
    expect(() =>
      assertRecipeIngredients([
        {
          rawMaterialDefinitionId: 'm-1',
          newMaterial: { name: 'Добавка синяя' },
          shareBasisPoints: 10_000,
        },
      ]),
    ).toThrow('exactly one');
    expect(() =>
      assertRecipeIngredients([
        {
          shareBasisPoints: 10_000,
        },
      ]),
    ).toThrow('exactly one');
    expect(() =>
      assertRecipeIngredients([
        {
          newMaterial: { name: 'Добавка синяя' },
          shareBasisPoints: 10_000,
        },
      ]),
    ).toThrow('admin');
  });

  it.each([
    [
      'existing-only null',
      {
        rawMaterialDefinitionId: null,
        shareBasisPoints: 10_000,
      },
    ],
    [
      'new-only null',
      {
        newMaterial: null,
        shareBasisPoints: 10_000,
      },
    ],
    [
      'existing null next to valid new material',
      {
        rawMaterialDefinitionId: null,
        newMaterial: { name: 'Добавка' },
        shareBasisPoints: 10_000,
      },
    ],
    [
      'new null next to valid existing material',
      {
        rawMaterialDefinitionId: 'm-1',
        newMaterial: null,
        shareBasisPoints: 10_000,
      },
    ],
  ])('rejects %s without throwing TypeError', (_case, ingredient) => {
    const run = () => assertRecipeIngredients([ingredient as unknown as RecipeIngredientCommand]);

    expect(run).toThrow('null');
    try {
      run();
    } catch (error) {
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it('rejects duplicate existing ids', () => {
    expect(() =>
      assertRecipeIngredients([
        { rawMaterialDefinitionId: 'm-1', shareBasisPoints: 5000 },
        { rawMaterialDefinitionId: 'm-1', shareBasisPoints: 5000 },
      ]),
    ).toThrow('duplicate');
  });

  it('builds a normalized actor-scoped fingerprint while preserving ingredient order', () => {
    const dto = plainToInstance(CreateRecipeCatalogDto, {
      clientRequestId: 'a6b84db0-a6d2-4c57-92d5-70c4bb721df3',
      name: '  СИНЯЯ СМЕСЬ ',
      ingredients: [
        { rawMaterialDefinitionId: 'm-2', shareBasisPoints: 4000 },
        {
          rawMaterialDefinitionId: 'm-1',
          shareBasisPoints: 6000,
        },
      ],
    });

    expect(recipeCreateFingerprintInput({ userId: 'u-1', role: 'commercial' }, dto)).toEqual({
      actorId: 'u-1',
      actorRole: 'commercial',
      name: 'синяя смесь',
      ingredients: [
        { rawMaterialDefinitionId: 'm-2', shareBasisPoints: 4000 },
        {
          rawMaterialDefinitionId: 'm-1',
          shareBasisPoints: 6000,
        },
      ],
    });
  });
});
