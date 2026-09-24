import { describe, expect, it } from 'vitest';

import type { StockProductionTemplate } from '../api/stockProductionTemplates';
import { createEmptyCommercialIntakeDraft } from '../features/commercial/CommercialIntakeForm';
import { applyStockProductionTemplate } from './stockProductionTemplates';

const multiPositionTemplate: StockProductionTemplate = {
  id: 'stock-template-1',
  name: 'Ходовой запас',
  description: null,
  status: 'active',
  version: 2,
  positions: [
    {
      rollCount: 3,
      filmType: 'Полотно',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      baseRawMaterialDefinitionId: 'rmd-base-primary',
      recipeDefinitionVersionId: null,
      spoolType: 'Тонкая',
      birka: 'ГОСТ',
      comment: 'Основная позиция',
      plannedWeightKg: 40,
      recipeParameters: [],
    },
    {
      rollCount: 2,
      filmType: 'Рукав',
      actualThickness: '60 мкм',
      accountingThickness: '58 мкм',
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'recipe-version-2',
      spoolType: 'Толстая',
      birka: 'i',
      comment: null,
      plannedWeightKg: null,
      recipeParameters: [{ label: 'Сырьё', value: 'Рецептура 30/70' }],
    },
  ],
  versions: [
    {
      id: 'stock-template-version-2',
      templateId: 'stock-template-1',
      version: 2,
      positions: [],
      createdAt: '2026-07-27T10:00:00.000Z',
    },
  ],
  usageCount: 4,
  lastUsedAt: '2026-07-27T11:00:00.000Z',
  updatedAt: '2026-07-27T10:00:00.000Z',
};

describe('stock production templates', () => {
  it('replaces the draft positions while preserving each exact material selector', () => {
    const applied = applyStockProductionTemplate(
      createEmptyCommercialIntakeDraft(),
      multiPositionTemplate,
    );

    expect(applied.stockProductionTemplateId).toBe('stock-template-1');
    expect(applied.positions).toHaveLength(2);
    expect(applied.positions[0]).toMatchObject({
      id: 'stock-template-1-position-1',
      rollCount: '3',
      baseRawMaterialDefinitionId: 'rmd-base-primary',
      recipeDefinitionVersionId: '',
    });
    expect(applied.positions[1]).toMatchObject({
      id: 'stock-template-1-position-2',
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: 'recipe-version-2',
    });
  });
});
