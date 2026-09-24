import { describe, expect, it } from 'vitest';

import {
  applyCommercialMaterialSelector,
  applyCreatedRecipeToIntakeDraft,
  COMMERCIAL_BIRKA_OPTIONS,
  COMMERCIAL_FILM_TYPES,
  COMMERCIAL_SPOOL_OPTIONS,
  commercialMaterialSelectorValueForPosition,
  commercialOrderPositionPayloadForDraft,
  decodeCommercialMaterialSelectorValue,
  encodeBaseMaterialSelectorValue,
  encodeRecipeSelectorValue,
  isCommercialOrderCatalogStaleCode,
  isCommercialOrderCatalogStaleError,
} from './materialRecipeCatalog';
import { createIntakeDraftPosition } from './prototypeRuntime';

const materials = [
  { id: 'base-primary', name: 'Первичное', kind: 'base' as const },
  { id: 'base-secondary', name: 'Вторичное', kind: 'base' as const },
  { id: 'base-aika', name: 'Айка', kind: 'base' as const },
  { id: 'admin-pnd', name: 'ПНД гранула', kind: 'custom' as const },
];

const recipe = {
  id: 'recipe-green',
  name: 'Зелёная 30/70',
  version: {
    id: 'recipe-green-v3',
    version: 3,
    ingredients: [
      { rawMaterialDefinitionId: 'base-primary', name: 'Первичное', shareBasisPoints: 3_000 },
      {
        rawMaterialDefinitionId: 'base-secondary',
        name: 'Вторичное',
        shareBasisPoints: 7_000,
      },
    ],
  },
};

describe('commercial catalog option contracts', () => {
  it.each(['', '0', '-1', 'NaN', '0.0001', '1.1234', '10000001'])(
    'rejects invalid draft dimensions locally: %j',
    (value) => {
      const position = {
        ...createIntakeDraftPosition(1),
        baseRawMaterialDefinitionId: 'base-primary',
        widthMm: '1200',
        plannedLengthM: '300',
      };
      expect(() => commercialOrderPositionPayloadForDraft({ ...position, widthMm: value })).toThrow(
        'Ширина',
      );
      expect(() =>
        commercialOrderPositionPayloadForDraft({ ...position, plannedLengthM: value }),
      ).toThrow('Метраж');
    },
  );

  it('accepts comma decimals and the supported dimension boundaries', () => {
    const position = {
      ...createIntakeDraftPosition(1),
      baseRawMaterialDefinitionId: 'base-primary',
      widthMm: '0,001',
      plannedLengthM: '10000000',
    };
    expect(commercialOrderPositionPayloadForDraft(position)).toMatchObject({
      widthMm: 0.001,
      plannedLengthM: 10000000,
    });
    expect(() =>
      commercialOrderPositionPayloadForDraft({ ...position, widthMm: '100000.001' }),
    ).toThrow('Ширина');
  });

  it('keeps the exact approved production vocabularies', () => {
    expect(COMMERCIAL_FILM_TYPES).toEqual(['Рукав', 'Полотно', 'Полурукав', 'Фальц']);
    expect(COMMERCIAL_BIRKA_OPTIONS).toEqual(['ГОСТ', 'i', 'Тех', 'ГОСТ103', 'ГОСТ259']);
    expect(COMMERCIAL_SPOOL_OPTIONS).toEqual(['Тонкая', 'Толстая']);
  });

  it('encodes material and recipe identities without collisions', () => {
    expect(encodeBaseMaterialSelectorValue('shared-id')).toBe('material:shared-id');
    expect(encodeRecipeSelectorValue('shared-id')).toBe('recipe:shared-id');
  });

  it('decodes opaque identities containing colons without splitting them', () => {
    expect(decodeCommercialMaterialSelectorValue('material:tenant:material:17')).toEqual({
      baseRawMaterialDefinitionId: 'tenant:material:17',
    });
    expect(decodeCommercialMaterialSelectorValue('recipe:tenant:recipe-version:3')).toEqual({
      recipeDefinitionVersionId: 'tenant:recipe-version:3',
    });
  });

  it.each(['', 'shared-id', 'material:', 'recipe:', ' material:id', 'recipe:id '])(
    'rejects an invalid selector value: %j',
    (value) => {
      expect(decodeCommercialMaterialSelectorValue(value)).toBeNull();
    },
  );

  it('keeps base material and persisted recipe selection mutually exclusive', () => {
    const position = createIntakeDraftPosition(1);
    const withBase = applyCommercialMaterialSelector(
      position,
      'material:base-primary',
      materials,
      [recipe],
    );
    const withRecipe = applyCommercialMaterialSelector(
      withBase,
      'recipe:recipe-green-v3',
      materials,
      [recipe],
    );

    expect(withBase).toMatchObject({
      baseRawMaterialDefinitionId: 'base-primary',
      recipeDefinitionVersionId: '',
      rawMaterial: 'Первичное',
      rawMaterialId: '',
    });
    expect(withRecipe).toMatchObject({
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: 'recipe-green-v3',
      rawMaterial: 'Зелёная 30/70',
      rawMaterialId: '',
    });
    expect(commercialMaterialSelectorValueForPosition(withRecipe)).toBe(
      'recipe:recipe-green-v3',
    );
  });

  it('accepts an admin-created selectable material returned by the shared catalog', () => {
    const selected = applyCommercialMaterialSelector(
      createIntakeDraftPosition(1),
      'material:admin-pnd',
      materials,
      [recipe],
    );

    expect(selected).toMatchObject({
      baseRawMaterialDefinitionId: 'admin-pnd',
      recipeDefinitionVersionId: '',
      rawMaterial: 'ПНД гранула',
    });
  });

  it('clears both selectors for no recipe and rejects unavailable catalog identities', () => {
    const position = {
      ...createIntakeDraftPosition(1),
      recipeDefinitionVersionId: 'recipe-green-v3',
      rawMaterial: 'Зелёная 30/70',
    };

    expect(
      applyCommercialMaterialSelector(position, '', materials, [recipe]),
    ).toMatchObject({
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
      rawMaterial: '',
    });
    expect(() =>
      applyCommercialMaterialSelector(position, 'recipe:missing', materials, [recipe]),
    ).toThrow('Рецептура больше недоступна');
  });

  it('applies a created recipe only to its originating position without mutating siblings', () => {
    const first = createIntakeDraftPosition(1);
    const second = { ...createIntakeDraftPosition(2), id: 'second-position' };
    const form = {
      counterparty: 'Клиент',
      counterpartyQuickCreateSaved: false,
      newCounterpartyType: 'legal_entity' as const,
      newCounterpartyName: '',
      newCounterpartyInn: '',
      newCounterpartyKpp: '',
      newCounterpartyOgrn: '',
      newCounterpartyLegalAddress: '',
      newCounterpartyContactName: '',
      newCounterpartyContactPhone: '',
      newCounterpartyContactEmail: '',
      templateId: undefined,
      template: '',
      positions: [first, second],
      comment: '',
      saveAsTemplate: false,
      assignedOperatorId: '',
      priority: 'обычный' as const,
    };

    const result = applyCreatedRecipeToIntakeDraft(
      form,
      first.id,
      recipe,
      materials,
      [],
    );

    expect(result.positions[0]).toMatchObject({
      recipeDefinitionVersionId: 'recipe-green-v3',
      baseRawMaterialDefinitionId: '',
    });
    expect(result.positions[1]).toBe(second);
    expect(form.positions[0].recipeDefinitionVersionId).toBe('');
  });

  it.each([
    'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
    'RECIPE_VERSION_UNAVAILABLE',
    'RECIPE_VERSION_STALE',
    'RECIPE_COMPONENT_UNAVAILABLE',
  ])('recognizes order catalog staleness code %s', (code) => {
    expect(isCommercialOrderCatalogStaleCode(code)).toBe(true);
  });

  it('does not treat the recipe-editor compatibility code as an order stale response', () => {
    expect(isCommercialOrderCatalogStaleCode('RECIPE_COMPONENT_STALE')).toBe(false);
    expect(
      isCommercialOrderCatalogStaleError({ code: 'RECIPE_VERSION_STALE' }),
    ).toBe(true);
    expect(isCommercialOrderCatalogStaleError(new Error('network'))).toBe(false);
  });
});
