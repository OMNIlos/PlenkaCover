import type {
  CreateRecipeCatalogCommand,
  RawMaterialCatalogItem,
} from '../../api/materialRecipeCatalog';

export type RecipeIngredientDraft = {
  id: string;
  rawMaterialDefinitionId: string;
  sharePercentText: string;
};

export type RecipeEditorDraft = {
  name: string;
  ingredients: RecipeIngredientDraft[];
  activeIngredientId: string;
  nextIngredientNumber: number;
};

export type RecipeEditorAction =
  | { type: 'set_name'; value: string }
  | { type: 'activate'; ingredientId: string }
  | { type: 'set_share'; ingredientId: string; value: string }
  | {
      type: 'select_existing';
      ingredientId: string;
      rawMaterialDefinitionId: string;
    }
  | { type: 'add_existing' }
  | { type: 'remove'; ingredientId: string };

export type RecipeEditorRowErrors = {
  material?: string;
  share?: string;
};

export type RecipeEditorErrors = {
  name?: string;
  ingredientCount?: string;
  rows?: Record<string, RecipeEditorRowErrors>;
  total?: string;
};

export type RecipeDraftValidation =
  | { valid: true; errors: Record<string, never> }
  | { valid: false; errors: RecipeEditorErrors };

const MAX_INGREDIENTS = 50;
const PERCENT_PATTERN = /^(\d{1,3})(?:[.,](\d{1,2}))?$/u;

function ingredientId(number: number): string {
  return `ingredient-${number}`;
}

export function createRecipeDraft(): RecipeEditorDraft {
  return {
    name: '',
    activeIngredientId: ingredientId(1),
    nextIngredientNumber: 2,
    ingredients: [
      {
        id: ingredientId(1),
        rawMaterialDefinitionId: '',
        sharePercentText: '100',
      },
    ],
  };
}

function updateIngredient(
  draft: RecipeEditorDraft,
  rowId: string,
  update: (row: RecipeIngredientDraft) => RecipeIngredientDraft,
): RecipeEditorDraft {
  if (!draft.ingredients.some((row) => row.id === rowId)) return draft;
  return {
    ...draft,
    ingredients: draft.ingredients.map((row) =>
      row.id === rowId ? update(row) : row,
    ),
  };
}

export function recipeEditorReducer(
  draft: RecipeEditorDraft,
  action: RecipeEditorAction,
): RecipeEditorDraft {
  switch (action.type) {
    case 'set_name':
      return { ...draft, name: action.value };
    case 'activate':
      return draft.ingredients.some((row) => row.id === action.ingredientId)
        ? { ...draft, activeIngredientId: action.ingredientId }
        : draft;
    case 'set_share':
      return updateIngredient(draft, action.ingredientId, (row) => ({
        ...row,
        sharePercentText: action.value,
      }));
    case 'select_existing':
      return updateIngredient(draft, action.ingredientId, (row) => ({
        ...row,
        rawMaterialDefinitionId: action.rawMaterialDefinitionId,
      }));
    case 'add_existing': {
      if (draft.ingredients.length >= MAX_INGREDIENTS) return draft;
      const id = ingredientId(draft.nextIngredientNumber);
      return {
        ...draft,
        activeIngredientId: id,
        nextIngredientNumber: draft.nextIngredientNumber + 1,
        ingredients: [
          ...draft.ingredients,
          {
            id,
            rawMaterialDefinitionId: '',
            sharePercentText: '',
          },
        ],
      };
    }
    case 'remove': {
      if (draft.ingredients.length <= 1) return draft;
      const removedIndex = draft.ingredients.findIndex(
        (row) => row.id === action.ingredientId,
      );
      if (removedIndex < 0) return draft;
      const ingredients = draft.ingredients.filter(
        (row) => row.id !== action.ingredientId,
      );
      const activeIngredientId =
        draft.activeIngredientId === action.ingredientId
          ? ingredients[Math.min(removedIndex, ingredients.length - 1)].id
          : draft.activeIngredientId;
      return { ...draft, ingredients, activeIngredientId };
    }
  }
}

export function percentTextToBasisPoints(text: string): number | null {
  const match = PERCENT_PATTERN.exec(text);
  if (!match) return null;
  const whole = Number(match[1]);
  const decimal = (match[2] ?? '').padEnd(2, '0');
  const basisPoints = whole * 100 + Number(decimal || '0');
  if (basisPoints < 1 || basisPoints > 10_000) return null;
  return basisPoints;
}

function displayName(value: string): string {
  return value.trim().normalize('NFKC');
}

function setRowError(
  errors: RecipeEditorErrors,
  rowId: string,
  field: keyof RecipeEditorRowErrors,
  message: string,
) {
  errors.rows ??= {};
  errors.rows[rowId] = {
    ...errors.rows[rowId],
    [field]: message,
  };
}

function rowRecord(row: RecipeIngredientDraft): Record<string, unknown> {
  return row as unknown as Record<string, unknown>;
}

function shareError(text: string): string {
  if (/^\d{1,3}[.,]\d{3,}$/u.test(text)) {
    return 'Используйте не более двух знаков после запятой.';
  }
  return 'Укажите долю от 0,01% до 100%.';
}

export function validateRecipeDraft(
  draft: RecipeEditorDraft,
  materials: readonly RawMaterialCatalogItem[] = [],
): RecipeDraftValidation {
  const errors: RecipeEditorErrors = {};
  const normalizedRecipeName = displayName(draft.name);
  if (normalizedRecipeName.length === 0) {
    errors.name = 'Введите название рецептуры.';
  } else if (normalizedRecipeName.length > 120) {
    errors.name = 'Название рецептуры должно содержать не более 120 символов.';
  }

  if (
    !Array.isArray(draft.ingredients) ||
    draft.ingredients.length < 1 ||
    draft.ingredients.length > MAX_INGREDIENTS
  ) {
    errors.ingredientCount = 'Добавьте от 1 до 50 компонентов.';
  }

  const availableIds = new Set(materials.map((material) => material.id));
  const seenExistingIds = new Set<string>();
  let total = 0;

  for (const row of Array.isArray(draft.ingredients) ? draft.ingredients : []) {
    const record = rowRecord(row);
    const rowId = typeof record.id === 'string' ? record.id : '';
    const id =
      typeof record.rawMaterialDefinitionId === 'string'
        ? record.rawMaterialDefinitionId
        : '';
    if (id.length === 0) {
      setRowError(errors, rowId, 'material', 'Выберите сырье.');
    } else if (seenExistingIds.has(id)) {
      setRowError(errors, rowId, 'material', 'Это сырье уже добавлено.');
    } else if (!availableIds.has(id)) {
      setRowError(
        errors,
        rowId,
        'material',
        'Выбранное сырье больше недоступно.',
      );
    }
    if (id.length > 0) {
      seenExistingIds.add(id);
    }

    const shareText =
      typeof record.sharePercentText === 'string'
        ? record.sharePercentText
        : '';
    const shareBasisPoints = percentTextToBasisPoints(shareText);
    if (shareBasisPoints === null) {
      setRowError(errors, rowId, 'share', shareError(shareText));
    } else {
      total += shareBasisPoints;
    }
  }

  if (total !== 10_000) {
    errors.total = 'Сумма долей должна быть ровно 100%.';
  }

  return Object.keys(errors).length === 0
    ? { valid: true, errors: {} }
    : { valid: false, errors };
}

export function toCreateRecipeCommand(
  draft: RecipeEditorDraft,
  materials: readonly RawMaterialCatalogItem[] = [],
): Omit<CreateRecipeCatalogCommand, 'clientRequestId'> {
  const result = validateRecipeDraft(draft, materials);
  if (!result.valid) {
    throw new Error('Некорректный черновик рецептуры.');
  }

  return {
    name: displayName(draft.name),
    ingredients: draft.ingredients.map((row) => {
      const shareBasisPoints = percentTextToBasisPoints(row.sharePercentText);
      if (shareBasisPoints === null) {
        throw new Error('Некорректная доля рецептуры.');
      }
      return {
        rawMaterialDefinitionId: row.rawMaterialDefinitionId,
        shareBasisPoints,
      };
    }),
  };
}
