import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type {
  CreateRecipeCatalogCommand,
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../../api/materialRecipeCatalog';
import {
  useMaterialRecipeCatalog,
  type MaterialRecipeCatalog,
} from './useMaterialRecipeCatalog';

const material: RawMaterialCatalogItem = {
  id: 'rmd-base-primary',
  name: 'Первичное',
  kind: 'base',
};

const recipe: RecipeCatalogItem = {
  id: 'recipe-1',
  name: 'Первичное 70 / Вторичное 30',
  version: {
    id: 'recipe-version-1',
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
};

const createdRecipe: RecipeCatalogItem = {
  id: 'recipe-created',
  name: 'Айка 100',
  version: {
    id: 'recipe-version-created',
    version: 1,
    ingredients: [
      {
        rawMaterialDefinitionId: 'rmd-base-aika',
        name: 'Айка',
        shareBasisPoints: 10_000,
      },
    ],
  },
};

type RecipeDraft = Omit<CreateRecipeCatalogCommand, 'clientRequestId'>;

let latest: MaterialRecipeCatalog | null = null;
let renderer: ReactTestRenderer | null = null;

function CatalogHarness({ enabled }: { enabled: boolean }) {
  latest = useMaterialRecipeCatalog(enabled);
  return null;
}

function current(): MaterialRecipeCatalog {
  if (!latest) throw new Error('Catalog hook has not rendered.');
  return latest;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderCatalog(enabled = true) {
  await act(async () => {
    renderer = TestRenderer.create(createElement(CatalogHarness, { enabled }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  latest = null;
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
  }
  renderer = null;
  vi.unstubAllGlobals();
});

describe('useMaterialRecipeCatalog', () => {
  it('starts both catalog requests in parallel and publishes only the complete pair', async () => {
    const materialsResponse = deferred<Response>();
    const recipesResponse = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => materialsResponse.promise)
      .mockImplementationOnce(() => recipesResponse.promise);
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      renderer = TestRenderer.create(createElement(CatalogHarness, { enabled: true }));
    });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/material-catalog',
      '/api/recipe-catalog',
    ]);
    expect(current().status).toBe('loading');
    expect(current().materials).toEqual([]);
    expect(current().recipes).toEqual([]);

    await act(async () => {
      materialsResponse.resolve(jsonResponse([material]));
      await Promise.resolve();
    });
    expect(current().status).toBe('loading');
    expect(current().materials).toEqual([]);

    await act(async () => {
      recipesResponse.resolve(jsonResponse([recipe]));
      await Promise.resolve();
    });
    expect(current()).toMatchObject({
      status: 'ready',
      materials: [material],
      recipes: [recipe],
      error: null,
    });
  });

  it('retains prior catalogs on refresh error and retries successfully', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([material]))
      .mockResolvedValueOnce(jsonResponse([recipe]))
      .mockResolvedValueOnce(
        jsonResponse({ message: 'Каталог временно недоступен.' }, 503),
      )
      .mockResolvedValueOnce(jsonResponse([recipe]))
      .mockResolvedValueOnce(jsonResponse([material]))
      .mockResolvedValueOnce(jsonResponse([recipe, createdRecipe]));
    vi.stubGlobal('fetch', fetchMock);
    await renderCatalog();

    const previousMaterials = current().materials;
    const previousRecipes = current().recipes;
    await act(async () => {
      await current().reload();
    });

    expect(current().status).toBe('error');
    expect(current().error).toBe('Каталог временно недоступен.');
    expect(current().materials).toBe(previousMaterials);
    expect(current().recipes).toBe(previousRecipes);

    await act(async () => {
      await current().reload();
    });
    expect(current()).toMatchObject({
      status: 'ready',
      materials: [material],
      recipes: [recipe, createdRecipe],
      error: null,
    });
  });

  it('treats a loaded empty catalog as refreshable prior data', async () => {
    const materialsResponse = deferred<Response>();
    const recipesResponse = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockImplementationOnce(() => materialsResponse.promise)
      .mockImplementationOnce(() => recipesResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    await renderCatalog();

    expect(current().status).toBe('ready');
    let reloadPromise!: Promise<void>;
    act(() => {
      reloadPromise = current().reload();
    });
    expect(current().status).toBe('refreshing');

    await act(async () => {
      materialsResponse.resolve(jsonResponse([]));
      recipesResponse.resolve(jsonResponse([]));
      await reloadPromise;
    });
    expect(current().status).toBe('ready');
  });

  it('upserts a successful create and ignores an older refresh result', async () => {
    const staleMaterialsResponse = deferred<Response>();
    const staleRecipesResponse = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([material]))
      .mockResolvedValueOnce(jsonResponse([recipe]))
      .mockImplementationOnce(() => staleMaterialsResponse.promise)
      .mockImplementationOnce(() => staleRecipesResponse.promise)
      .mockResolvedValueOnce(jsonResponse(createdRecipe, 201));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
    });
    await renderCatalog();

    let reloadPromise!: Promise<void>;
    act(() => {
      reloadPromise = current().reload();
    });
    await act(async () => {
      await current().createRecipe({
        name: 'Айка 100',
        ingredients: [
          { rawMaterialDefinitionId: 'rmd-base-aika', shareBasisPoints: 10_000 },
        ],
      });
    });
    expect(current().recipes).toEqual([recipe, createdRecipe]);

    await act(async () => {
      staleMaterialsResponse.resolve(jsonResponse([material]));
      staleRecipesResponse.resolve(jsonResponse([recipe]));
      await reloadPromise;
    });
    expect(current().recipes).toEqual([recipe, createdRecipe]);
  });

  it('keeps the UUID for unchanged failures and rotates it after edit or success', async () => {
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'Исправьте название.' }, 400))
      .mockResolvedValueOnce(jsonResponse({ message: 'Исправьте название.' }, 400))
      .mockResolvedValueOnce(jsonResponse({ message: 'Исправьте состав.' }, 400))
      .mockResolvedValueOnce(jsonResponse(createdRecipe, 201))
      .mockResolvedValueOnce(jsonResponse(createdRecipe, 201));
    vi.stubGlobal('crypto', { randomUUID });
    vi.stubGlobal('fetch', fetchMock);
    await renderCatalog(false);

    const original: RecipeDraft = {
      name: 'Айка',
      ingredients: [
        { rawMaterialDefinitionId: 'rmd-base-aika', shareBasisPoints: 10_000 },
      ],
    };
    const edited: RecipeDraft = { ...original, name: 'Айка 100' };

    await act(async () => {
      await expect(current().createRecipe(original)).rejects.toBeInstanceOf(ApiError);
    });
    await act(async () => {
      await expect(current().createRecipe(original)).rejects.toBeInstanceOf(ApiError);
    });
    await act(async () => {
      await expect(current().createRecipe(edited)).rejects.toBeInstanceOf(ApiError);
    });
    await act(async () => {
      await current().createRecipe(edited);
    });
    await act(async () => {
      await current().createRecipe(edited);
    });

    const requestIds = fetchMock.mock.calls.map(([, init]) => {
      const command = JSON.parse((init as RequestInit).body as string) as CreateRecipeCatalogCommand;
      return command.clientRequestId;
    });
    expect(requestIds).toEqual([ids[0], ids[0], ids[1], ids[1], ids[2]]);
    expect(randomUUID).toHaveBeenCalledTimes(3);
  });

  it('uses different fingerprints for different catalog material identifiers', async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Проверка состава.' }, 400));
    vi.stubGlobal('crypto', { randomUUID });
    vi.stubGlobal('fetch', fetchMock);
    await renderCatalog(false);

    await act(async () => {
      await expect(
        current().createRecipe({
            name: 'Рецептура',
            ingredients: [
            { rawMaterialDefinitionId: 'material-one', shareBasisPoints: 10_000 },
            ],
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });
    await act(async () => {
      await expect(
        current().createRecipe({
          name: 'Рецептура',
          ingredients: [
            { rawMaterialDefinitionId: 'material-two', shareBasisPoints: 10_000 },
          ],
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    const requestIds = fetchMock.mock.calls.map(([, init]) => {
      const command = JSON.parse((init as RequestInit).body as string) as CreateRecipeCatalogCommand;
      return command.clientRequestId;
    });
    expect(requestIds).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('reloads after RECIPE_COMPONENT_STALE without mutating the caller draft', async () => {
    const draft: RecipeDraft = {
      name: 'Новая рецептура',
      ingredients: [
        {
          rawMaterialDefinitionId: 'rmd-base-primary',
          shareBasisPoints: 10_000,
        },
      ],
    };
    const draftSnapshot = structuredClone(draft);
    Object.freeze(draft.ingredients[0]);
    Object.freeze(draft.ingredients);
    Object.freeze(draft);

    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/recipe-catalog' && init?.method === 'POST') {
        return jsonResponse(
          {
            code: 'RECIPE_COMPONENT_STALE',
            message: 'Состав каталога изменился.',
          },
          409,
        );
      }
      if (path === '/api/material-catalog') return jsonResponse([material]);
      if (path === '/api/recipe-catalog') return jsonResponse([recipe]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderCatalog(false);

    await act(async () => {
      await expect(current().createRecipe(draft)).rejects.toMatchObject({
        code: 'RECIPE_COMPONENT_STALE',
      });
    });

    expect(draft).toEqual(draftSnapshot);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/recipe-catalog',
      '/api/material-catalog',
      '/api/recipe-catalog',
    ]);
    expect(current()).toMatchObject({
      status: 'ready',
      materials: [material],
      recipes: [recipe],
      error: null,
    });
  });

  it('reloads after the backend material-unavailable code and keeps the retry UUID', async () => {
    const draft: RecipeDraft = {
      name: 'Рецептура с выбранным сырьём',
      ingredients: [
        {
          rawMaterialDefinitionId: 'material-now-inactive',
          shareBasisPoints: 10_000,
        },
      ],
    };
    const draftSnapshot = structuredClone(draft);
    Object.freeze(draft.ingredients[0]);
    Object.freeze(draft.ingredients);
    Object.freeze(draft);

    let postCount = 0;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/recipe-catalog' && init?.method === 'POST') {
        postCount += 1;
        return postCount === 1
          ? jsonResponse(
              {
                code: 'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
                message: 'Выбранное сырьё больше недоступно.',
              },
              409,
            )
          : jsonResponse(createdRecipe, 201);
      }
      if (path === '/api/material-catalog') return jsonResponse([material]);
      if (path === '/api/recipe-catalog') return jsonResponse([recipe]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderCatalog(false);

    await act(async () => {
      await expect(current().createRecipe(draft)).rejects.toMatchObject({
        code: 'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
      });
    });
    await act(async () => {
      await current().createRecipe(draft);
    });

    expect(draft).toEqual(draftSnapshot);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/recipe-catalog',
      '/api/material-catalog',
      '/api/recipe-catalog',
      '/api/recipe-catalog',
    ]);
    const postRequestIds = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit).method === 'POST')
      .map(([, init]) => {
        const command = JSON.parse(
          (init as RequestInit).body as string,
        ) as CreateRecipeCatalogCommand;
        return command.clientRequestId;
      });
    expect(postRequestIds).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it.each(['RAW_MATERIAL_NAME_CONFLICT', 'RECIPE_CATALOG_CONFLICT'])(
    'does not reload for the user-resolved create conflict %s',
    async (code) => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code,
            message: 'Измените рецептуру или повторите исходную операцию.',
          },
          409,
        ),
      );
      vi.stubGlobal('crypto', {
        randomUUID: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
      });
      vi.stubGlobal('fetch', fetchMock);
      await renderCatalog(false);

      await act(async () => {
        await expect(
          current().createRecipe({
            name: 'Конфликтная рецептура',
            ingredients: [
              {
                rawMaterialDefinitionId: 'rmd-base-primary',
                shareBasisPoints: 10_000,
              },
            ],
          }),
        ).rejects.toMatchObject({ code });
      });

      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
        '/api/recipe-catalog',
      ]);
    },
  );
});
