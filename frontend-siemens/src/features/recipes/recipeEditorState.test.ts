import { describe, expect, it } from 'vitest';

import type { RawMaterialCatalogItem } from '../../api/materialRecipeCatalog';
import {
  createRecipeDraft,
  percentTextToBasisPoints,
  recipeEditorReducer,
  toCreateRecipeCommand,
  validateRecipeDraft,
  type RecipeEditorDraft,
} from './recipeEditorState';

const materials: RawMaterialCatalogItem[] = [
  { id: 'material-primary', name: 'ПВД Первичное', kind: 'base' },
  { id: 'material-secondary', name: 'ПВД Вторичное', kind: 'base' },
  { id: 'material-blue', name: 'Краситель синий', kind: 'custom' },
];

function validDraft(): RecipeEditorDraft {
  return {
    name: 'Синяя смесь',
    activeIngredientId: 'ingredient-2',
    nextIngredientNumber: 3,
    ingredients: [
      {
        id: 'ingredient-1',
        rawMaterialDefinitionId: 'material-primary',
        sharePercentText: '66,67',
      },
      {
        id: 'ingredient-2',
        rawMaterialDefinitionId: 'material-blue',
        sharePercentText: '33.33',
      },
    ],
  };
}

describe('recipeEditorState', () => {
  it('starts with one deterministic active catalog-material row', () => {
    expect(createRecipeDraft()).toEqual({
      name: '',
      activeIngredientId: 'ingredient-1',
      nextIngredientNumber: 2,
      ingredients: [
        {
          id: 'ingredient-1',
          rawMaterialDefinitionId: '',
          sharePercentText: '100',
        },
      ],
    });
    expect(createRecipeDraft()).toEqual(createRecipeDraft());
  });

  it('adds catalog rows up to fifty and activates the appended row', () => {
    let draft = createRecipeDraft();
    for (let index = 1; index < 50; index += 1) {
      draft = recipeEditorReducer(draft, { type: 'add_existing' });
    }

    expect(draft.ingredients).toHaveLength(50);
    expect(draft.activeIngredientId).toBe('ingredient-50');
    expect(draft.ingredients[49]).toMatchObject({
      id: 'ingredient-50',
      rawMaterialDefinitionId: '',
    });
    expect(recipeEditorReducer(draft, { type: 'add_existing' })).toEqual(draft);
  });

  it('never removes the last row and activates the nearest survivor', () => {
    const twoRows = recipeEditorReducer(createRecipeDraft(), {
      type: 'add_existing',
    });
    const threeRows = recipeEditorReducer(twoRows, { type: 'add_existing' });
    const middleActive = recipeEditorReducer(threeRows, {
      type: 'activate',
      ingredientId: 'ingredient-2',
    });
    const afterMiddle = recipeEditorReducer(middleActive, {
      type: 'remove',
      ingredientId: 'ingredient-2',
    });

    expect(afterMiddle.ingredients.map((row) => row.id)).toEqual([
      'ingredient-1',
      'ingredient-3',
    ]);
    expect(afterMiddle.activeIngredientId).toBe('ingredient-3');
    expect(
      recipeEditorReducer(createRecipeDraft(), {
        type: 'remove',
        ingredientId: 'ingredient-1',
      }),
    ).toEqual(createRecipeDraft());
  });

  it.each([
    ['33,33', 3333],
    ['33.33', 3333],
    ['0.01', 1],
    ['100', 10_000],
    ['01,20', 120],
  ])('parses %s using digit arithmetic', (text, expected) => {
    expect(percentTextToBasisPoints(text)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    '+1',
    '-1',
    '1e2',
    '1,234',
    '.5',
    '0',
    '0.00',
    '100.01',
    '101',
    'NaN',
  ])('rejects invalid percentage %j', (text) => {
    expect(percentTextToBasisPoints(text)).toBeNull();
  });

  it('accepts only existing, available catalog products with an exact total', () => {
    expect(validateRecipeDraft(validDraft(), materials)).toEqual({
      valid: true,
      errors: {},
    });

    const malformed = {
      ...validDraft(),
      ingredients: [
        {
          id: 'ingredient-1',
          sharePercentText: '100',
          newMaterialName: 'Нельзя создать здесь',
        },
      ],
    } as unknown as RecipeEditorDraft;
    expect(validateRecipeDraft(malformed, materials)).toMatchObject({
      valid: false,
      errors: {
        rows: {
          'ingredient-1': { material: 'Выберите сырье.' },
        },
      },
    });
  });

  it('rejects duplicate and stale catalog products', () => {
    const duplicate = validDraft();
    duplicate.ingredients[1].rawMaterialDefinitionId = 'material-primary';
    expect(validateRecipeDraft(duplicate, materials)).toMatchObject({
      valid: false,
      errors: {
        rows: {
          'ingredient-2': { material: 'Это сырье уже добавлено.' },
        },
      },
    });

    const stale = validDraft();
    stale.ingredients[0].rawMaterialDefinitionId = 'material-gone';
    expect(validateRecipeDraft(stale, materials)).toMatchObject({
      valid: false,
      errors: {
        rows: {
          'ingredient-1': {
            material: 'Выбранное сырье больше недоступно.',
          },
        },
      },
    });
  });

  it('validates recipe name, shares, total, and ingredient-count boundaries', () => {
    const draft = validDraft();
    draft.name = '  ';
    draft.ingredients[0].sharePercentText = '0';
    draft.ingredients[1].sharePercentText = '33.333';

    expect(validateRecipeDraft(draft, materials)).toEqual({
      valid: false,
      errors: {
        name: 'Введите название рецептуры.',
        rows: {
          'ingredient-1': {
            share: 'Укажите долю от 0,01% до 100%.',
          },
          'ingredient-2': {
            share: 'Используйте не более двух знаков после запятой.',
          },
        },
        total: 'Сумма долей должна быть ровно 100%.',
      },
    });

    draft.ingredients = [];
    expect(validateRecipeDraft(draft, materials)).toMatchObject({
      valid: false,
      errors: {
        ingredientCount: 'Добавьте от 1 до 50 компонентов.',
      },
    });
  });

  it('projects a safe ordered command with catalog identifiers only', () => {
    const command = toCreateRecipeCommand(validDraft(), materials);

    expect(command).toEqual({
      name: 'Синяя смесь',
      ingredients: [
        {
          rawMaterialDefinitionId: 'material-primary',
          shareBasisPoints: 6667,
        },
        {
          rawMaterialDefinitionId: 'material-blue',
          shareBasisPoints: 3333,
        },
      ],
    });
    expect(command).not.toHaveProperty('clientRequestId');
    for (const ingredient of command.ingredients) {
      expect(Object.keys(ingredient).sort()).toEqual([
        'rawMaterialDefinitionId',
        'shareBasisPoints',
      ]);
      expect(ingredient).not.toHaveProperty('newMaterial');
    }
  });
});
