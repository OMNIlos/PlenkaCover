import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRecipeCatalogItem,
  fetchRawMaterialCatalog,
  fetchRecipeCatalog,
  parseMaterialCatalog,
  parseRecipe,
  parseRecipeCatalog,
  type CreateRecipeCatalogCommand,
} from './materialRecipeCatalog';

const material = {
  id: 'rmd-base-primary',
  name: 'Первичное',
  kind: 'base',
} as const;

const recipe = {
  id: 'recipe-primary-secondary',
  name: 'Первичное 70 / Вторичное 30',
  version: {
    id: 'recipe-version:1',
    version: 1,
    ingredients: [
      {
        rawMaterialDefinitionId: 'rmd-base-primary',
        name: 'Первичное',
        shareBasisPoints: 7000,
      },
      {
        rawMaterialDefinitionId: 'rmd-base-secondary',
        name: 'Вторичное',
        shareBasisPoints: 3000,
      },
    ],
  },
} as const;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('material recipe catalog parsers', () => {
  it('projects only the exact safe material fields into new objects', () => {
    const serverItem = { ...material };
    const result = parseMaterialCatalog([serverItem]);

    expect(result).toEqual([material]);
    expect(result[0]).not.toBe(serverItem);
    expect(Object.keys(result[0])).toEqual(['id', 'name', 'kind']);
  });

  it.each([
    ['non-array root', material],
    ['extra material key', [{ ...material, rawPayload: { secret: true } }]],
    ['blank material id', [{ ...material, id: '' }]],
    ['non-string material name', [{ ...material, name: 7 }]],
    ['trimmed material id', [{ ...material, id: ' rmd-base-primary' }]],
    ['trimmed material name', [{ ...material, name: 'Первичное ' }]],
    ['invalid material kind', [{ ...material, kind: 'legacy' }]],
    ['duplicate material id', [material, { ...material, name: 'Другое' }]],
  ])('rejects an unsafe material catalog: %s', (_label, value) => {
    expect(() => parseMaterialCatalog(value)).toThrow(/каталог сырья/iu);
  });

  it('projects the exact recipe shape without retaining server objects', () => {
    const serverRecipe = structuredClone(recipe);
    const result = parseRecipeCatalog([serverRecipe]);

    expect(result).toEqual([recipe]);
    expect(result[0]).not.toBe(serverRecipe);
    expect(result[0].version).not.toBe(serverRecipe.version);
    expect(result[0].version.ingredients[0]).not.toBe(serverRecipe.version.ingredients[0]);
    expect(Object.keys(result[0])).toEqual(['id', 'name', 'version']);
    expect(Object.keys(result[0].version)).toEqual(['id', 'version', 'ingredients']);
    expect(Object.keys(result[0].version.ingredients[0])).toEqual([
      'rawMaterialDefinitionId',
      'name',
      'shareBasisPoints',
    ]);
  });

  it.each([
    ['non-array root', recipe],
    ['extra recipe key', [{ ...recipe, sourceSnapshot: 'unsafe' }]],
    ['blank recipe id', [{ ...recipe, id: '' }]],
    ['trimmed recipe id', [{ ...recipe, id: 'recipe-1 ' }]],
    ['blank recipe name', [{ ...recipe, name: '' }]],
    ['trimmed recipe name', [{ ...recipe, name: ' Рецептура' }]],
    [
      'extra version key',
      [{ ...recipe, version: { ...recipe.version, current: true } }],
    ],
    ['blank version id', [{ ...recipe, version: { ...recipe.version, id: ' ' } }]],
    [
      'string version number',
      [{ ...recipe, version: { ...recipe.version, version: '1' } }],
    ],
    ['zero version', [{ ...recipe, version: { ...recipe.version, version: 0 } }]],
    ['fractional version', [{ ...recipe, version: { ...recipe.version, version: 1.5 } }]],
    [
      'extra ingredient key',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              { ...recipe.version.ingredients[0], rawPayload: 'unsafe' },
              recipe.version.ingredients[1],
            ],
          },
        },
      ],
    ],
    [
      'blank ingredient id',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              { ...recipe.version.ingredients[0], rawMaterialDefinitionId: '' },
              recipe.version.ingredients[1],
            ],
          },
        },
      ],
    ],
    [
      'trimmed ingredient id',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              {
                ...recipe.version.ingredients[0],
                rawMaterialDefinitionId: 'rmd-base-primary ',
              },
              recipe.version.ingredients[1],
            ],
          },
        },
      ],
    ],
    [
      'blank ingredient name',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              { ...recipe.version.ingredients[0], name: '' },
              recipe.version.ingredients[1],
            ],
          },
        },
      ],
    ],
    [
      'trimmed ingredient name',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              { ...recipe.version.ingredients[0], name: 'Первичное ' },
              recipe.version.ingredients[1],
            ],
          },
        },
      ],
    ],
    [
      'empty ingredients',
      [
        {
          ...recipe,
          version: { ...recipe.version, ingredients: [] },
        },
      ],
    ],
    [
      'over fifty ingredients',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: Array.from({ length: 51 }, (_, index) => ({
              rawMaterialDefinitionId: `material-${index}`,
              name: `Сырьё ${index}`,
              shareBasisPoints: index === 50 ? 9950 : 1,
            })),
          },
        },
      ],
    ],
    [
      'duplicate ingredients',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              recipe.version.ingredients[0],
              {
                ...recipe.version.ingredients[1],
                rawMaterialDefinitionId:
                  recipe.version.ingredients[0].rawMaterialDefinitionId,
              },
            ],
          },
        },
      ],
    ],
    [
      'non-positive ingredient share',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              { ...recipe.version.ingredients[0], shareBasisPoints: 0 },
              { ...recipe.version.ingredients[1], shareBasisPoints: 10_000 },
            ],
          },
        },
      ],
    ],
    [
      'fractional ingredient share',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              { ...recipe.version.ingredients[0], shareBasisPoints: 7000.5 },
              { ...recipe.version.ingredients[1], shareBasisPoints: 2999.5 },
            ],
          },
        },
      ],
    ],
    [
      'ingredient share above maximum',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              { ...recipe.version.ingredients[0], shareBasisPoints: 10_001 },
            ],
          },
        },
      ],
    ],
    [
      'string ingredient share',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              { ...recipe.version.ingredients[0], shareBasisPoints: '7000' },
              recipe.version.ingredients[1],
            ],
          },
        },
      ],
    ],
    [
      'ingredient shares below exact total',
      [
        {
          ...recipe,
          version: {
            ...recipe.version,
            ingredients: [
              recipe.version.ingredients[0],
              { ...recipe.version.ingredients[1], shareBasisPoints: 2999 },
            ],
          },
        },
      ],
    ],
    ['duplicate recipe id', [recipe, { ...recipe, name: 'Другая рецептура' }]],
    [
      'duplicate version id',
      [
        recipe,
        {
          ...recipe,
          id: 'recipe-second',
          name: 'Другая рецептура',
        },
      ],
    ],
  ])('rejects an unsafe recipe catalog: %s', (_label, value) => {
    expect(() => parseRecipeCatalog(value)).toThrow(/каталог рецептур/iu);
  });

  it('uses the same strict validation for a created recipe', () => {
    expect(parseRecipe(recipe)).toEqual(recipe);
    expect(() => parseRecipe({ ...recipe, requestFingerprint: 'secret' })).toThrow(
      /рецептур/iu,
    );
  });
});

describe('material recipe catalog API', () => {
  it('loads both catalogs and creates a recipe through the canonical endpoints', async () => {
    const command: CreateRecipeCatalogCommand = {
      clientRequestId: '11111111-1111-4111-8111-111111111111',
      name: recipe.name,
      ingredients: recipe.version.ingredients.map((ingredient) => ({
        rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
        shareBasisPoints: ingredient.shareBasisPoints,
      })),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([material]))
      .mockResolvedValueOnce(jsonResponse([recipe]))
      .mockResolvedValueOnce(jsonResponse(recipe, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRawMaterialCatalog()).resolves.toEqual([material]);
    await expect(fetchRecipeCatalog()).resolves.toEqual([recipe]);
    await expect(createRecipeCatalogItem(command)).resolves.toEqual(recipe);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/material-catalog',
      '/api/recipe-catalog',
      '/api/recipe-catalog',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(command),
    });
  });

  it('rejects an unsafe successful response instead of exposing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([{ ...material, rawPayload: 'secret' }])),
    );

    await expect(fetchRawMaterialCatalog()).rejects.toThrow(/каталог сырья/iu);
  });
});
