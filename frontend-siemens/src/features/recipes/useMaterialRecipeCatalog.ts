import { useCallback, useEffect, useReducer, useRef } from 'react';

import { ApiError } from '../../api/client';
import { createOperationKey } from '../../api/idempotentOperation';
import {
  createRecipeCatalogItem,
  fetchRawMaterialCatalog,
  fetchRecipeCatalog,
  type CreateRecipeCatalogCommand,
  type RawMaterialCatalogItem,
  type RecipeCatalogItem,
} from '../../api/materialRecipeCatalog';

export type MaterialRecipeCatalogStatus =
  | 'idle'
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'error';

export type MaterialRecipeCatalog = {
  materials: readonly RawMaterialCatalogItem[];
  recipes: readonly RecipeCatalogItem[];
  status: MaterialRecipeCatalogStatus;
  error: string | null;
  reload(): Promise<void>;
  createRecipe(
    input: Omit<CreateRecipeCatalogCommand, 'clientRequestId'>,
  ): Promise<RecipeCatalogItem>;
};

type CatalogState = {
  materials: readonly RawMaterialCatalogItem[];
  recipes: readonly RecipeCatalogItem[];
  status: MaterialRecipeCatalogStatus;
  error: string | null;
  loaded: boolean;
};

type CatalogAction =
  | { type: 'load_requested' }
  | {
      type: 'load_succeeded';
      materials: RawMaterialCatalogItem[];
      recipes: RecipeCatalogItem[];
    }
  | { type: 'load_failed'; message: string }
  | { type: 'recipe_created'; recipe: RecipeCatalogItem };

const initialState: CatalogState = {
  materials: [],
  recipes: [],
  status: 'idle',
  error: null,
  loaded: false,
};

function upsertRecipe(
  recipes: readonly RecipeCatalogItem[],
  recipe: RecipeCatalogItem,
): RecipeCatalogItem[] {
  const index = recipes.findIndex(
    (item) => item.id === recipe.id || item.version.id === recipe.version.id,
  );
  if (index < 0) return [...recipes, recipe];
  return recipes.map((item, itemIndex) => (itemIndex === index ? recipe : item));
}

function catalogReducer(state: CatalogState, action: CatalogAction): CatalogState {
  switch (action.type) {
    case 'load_requested':
      return {
        ...state,
        status: state.loaded ? 'refreshing' : 'loading',
        error: null,
      };
    case 'load_succeeded':
      return {
        materials: action.materials,
        recipes: action.recipes,
        status: 'ready',
        error: null,
        loaded: true,
      };
    case 'load_failed':
      return {
        ...state,
        status: 'error',
        error: action.message,
      };
    case 'recipe_created':
      return {
        ...state,
        recipes: upsertRecipe(state.recipes, action.recipe),
        status: 'ready',
        error: null,
        loaded: true,
      };
  }
}

function userMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось загрузить каталог.';
}

type RecipeDraft = Omit<CreateRecipeCatalogCommand, 'clientRequestId'>;

function projectDraftIngredient(
  ingredient: RecipeDraft['ingredients'][number],
): RecipeDraft['ingredients'][number] {
  return {
    rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
    shareBasisPoints: ingredient.shareBasisPoints,
  };
}

function projectDraft(input: RecipeDraft): RecipeDraft {
  return {
    name: input.name,
    ingredients: input.ingredients.map(projectDraftIngredient),
  };
}

function draftFingerprint(input: RecipeDraft): string {
  const draft = projectDraft(input);
  return JSON.stringify({
    name: draft.name,
    ingredients: draft.ingredients.map((ingredient) => ({
      rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
      shareBasisPoints: ingredient.shareBasisPoints,
    })),
  });
}

type PendingCreate = {
  fingerprint: string;
  clientRequestId: string;
};

const STALE_RECIPE_COMPONENT_CODES = new Set([
  'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
  'RECIPE_COMPONENT_STALE',
]);

export function useMaterialRecipeCatalog(enabled = true): MaterialRecipeCatalog {
  const [state, dispatch] = useReducer(catalogReducer, initialState);
  const generationRef = useRef(0);
  const pendingCreateRef = useRef<PendingCreate | null>(null);

  const reload = useCallback(async () => {
    const generation = ++generationRef.current;
    dispatch({ type: 'load_requested' });
    try {
      const [materials, recipes] = await Promise.all([
        fetchRawMaterialCatalog(),
        fetchRecipeCatalog(),
      ]);
      if (generation === generationRef.current) {
        dispatch({ type: 'load_succeeded', materials, recipes });
      }
    } catch (error) {
      if (generation === generationRef.current) {
        dispatch({ type: 'load_failed', message: userMessage(error) });
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    return () => {
      generationRef.current += 1;
    };
  }, [enabled, reload]);

  const createRecipe = useCallback(
    async (input: RecipeDraft) => {
      const draft = projectDraft(input);
      const fingerprint = draftFingerprint(draft);
      let pending = pendingCreateRef.current;
      if (pending?.fingerprint !== fingerprint) {
        pending = { fingerprint, clientRequestId: createOperationKey() };
        pendingCreateRef.current = pending;
      }

      try {
        const recipe = await createRecipeCatalogItem({
          clientRequestId: pending.clientRequestId,
          name: draft.name,
          ingredients: draft.ingredients,
        });
        generationRef.current += 1;
        if (
          pendingCreateRef.current?.fingerprint === pending.fingerprint &&
          pendingCreateRef.current.clientRequestId === pending.clientRequestId
        ) {
          pendingCreateRef.current = null;
        }
        dispatch({ type: 'recipe_created', recipe });
        return recipe;
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code !== null &&
          STALE_RECIPE_COMPONENT_CODES.has(error.code)
        ) {
          await reload();
        }
        throw error;
      }
    },
    [reload],
  );

  return {
    materials: state.materials,
    recipes: state.recipes,
    status: state.status,
    error: state.error,
    reload,
    createRecipe,
  };
}
