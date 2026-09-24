import { describe, expect, it } from 'vitest';
import type {
  CommercialOrderPosition,
  CounterpartyOrderTemplateVersion,
  RawMaterialStock,
} from './types';
import {
  buildCommercialPositionMutationPlan,
  buildCommercialPositionOptionSources,
  type CommercialPositionDraft,
} from './commercialPositionEditing';

const position: CommercialOrderPosition = {
  id: 'position-1',
  draftId: 'order-1',
  rollCount: 3,
  filmType: 'Рукав',
  actualThickness: '90 мкм',
  accountingThickness: '90 мкм',
  plannedWeightKg: 40,
  rawMaterialId: 'rm-current',
  rawMaterialLabel: 'ПВД текущий',
  spoolType: 'Шпуля 76 мм',
  birka: 'Гост 259',
  comment: 'Клиентский комментарий',
  recipeSnapshot: {
    id: 'recipe-1',
    positionId: 'position-1',
    recipeOwnerRole: 'commercial',
    parameters: [],
    source: 'commercial_form',
    createdBy: 'commercial',
    createdAt: '2026-07-13T09:00:00.000Z',
    version: 'v1',
  },
  warehouseCoverStatus: 'not_checked',
};

const templateVersion: CounterpartyOrderTemplateVersion = {
  id: 'template-version-1',
  templateId: 'template-1',
  version: 'v2',
  fields: [
    { label: 'Тип пленки', value: 'Полурукав', kind: 'production' },
    { label: 'Толщина', value: '90', kind: 'production' },
    { label: 'Толщина', value: '70 мкм', kind: 'production' },
    { label: 'Цвет', value: 'Бирка клиента', kind: 'production' },
    { label: 'Шпуля', value: 'Шпуля 152 мм', kind: 'production' },
    { label: 'Сырье', value: 'Сырье только из шаблона', kind: 'production' },
  ],
  reason: 'Активный шаблон контрагента',
  createdBy: 'commercial',
  createdAt: '2026-07-13T09:00:00.000Z',
  affectsProduction: true,
  affectsMoney: false,
};

const stocks: RawMaterialStock[] = [
  {
    id: 'stock-live',
    rawMaterialId: 'rm-live',
    label: 'ПЭ 100% складской факт',
    materialKind: 'primary',
    qty: 812,
    actualQty: 812,
    unit: 'кг',
    source: 'warehouse_fact',
    sourceOfTruthStatus: 'актуально',
    updatedAt: '2026-07-13T09:10:00.000Z',
  },
];

const siblingPosition: CommercialOrderPosition = {
  ...position,
  id: 'position-2',
  rawMaterialId: 'rm-sibling',
  rawMaterialLabel: 'ПВД из соседней позиции',
};

describe('commercial position editing sources', () => {
  it('builds unique normalized suggestions from the saved order and active templates', () => {
    const options = buildCommercialPositionOptionSources({
      positions: [position],
      templateVersions: [templateVersion],
      rawMaterialStocks: stocks,
    });

    expect(options.filmType).toEqual(expect.arrayContaining(['Рукав', 'Полурукав']));
    expect(options.actualThickness).toEqual(expect.arrayContaining(['90 мкм', '70 мкм']));
    expect(options.actualThickness.filter((value) => value === '90 мкм')).toHaveLength(1);
    expect(options.spoolType).toEqual(expect.arrayContaining(['Шпуля 76 мм', 'Шпуля 152 мм']));
  });

  it('offers raw materials from live warehouse stock and the persisted position only', () => {
    const options = buildCommercialPositionOptionSources({
      positions: [position],
      templateVersions: [templateVersion],
      rawMaterialStocks: stocks,
    });

    expect(options.rawMaterialLabel).toEqual(
      expect.arrayContaining(['ПЭ 100% складской факт', 'ПВД текущий']),
    );
    expect(options.rawMaterialLabel).not.toContain('Сырье только из шаблона');
    expect(options.rawMaterialLabel).not.toContain('ПВД 108');
  });
});

describe('commercial position mutation plan', () => {
  it('resolves a live material id and routes needs-production at position level', () => {
    const draft: CommercialPositionDraft = {
      rollCount: '4',
      filmType: 'Полурукав',
      actualThickness: '90 мкм',
      accountingThickness: '70 мкм',
      birka: 'Гост 259',
      manualBirka: '',
      spoolType: 'Шпуля 152 мм',
      rawMaterialLabel: 'ПЭ 100% складской факт',
      warehouseCoverStatus: 'needs_production',
      warehousePartialCoverQty: '0',
    };

    const plan = buildCommercialPositionMutationPlan({
      draft,
      position,
      rawMaterialStocks: stocks,
    });

    expect(plan.positionUpdate).toMatchObject({
      rollCount: 4,
      filmType: 'Полурукав',
      accountingThickness: '70 мкм',
      rawMaterialId: 'rm-live',
      spoolType: 'Шпуля 152 мм',
      birka: 'Гост 259',
    });
    expect(plan.route).toEqual({
      status: 'needs_production',
      reason: 'Коммерция выбрала маршрут покрытия в правке позиции',
    });
  });

  it('resolves material suggestions backed by another persisted order position', () => {
    const draft: CommercialPositionDraft = {
      rollCount: '3',
      filmType: 'Рукав',
      actualThickness: '90 мкм',
      accountingThickness: '90 мкм',
      birka: 'Гост 259',
      manualBirka: '',
      spoolType: 'Шпуля 76 мм',
      rawMaterialLabel: siblingPosition.rawMaterialLabel,
      warehouseCoverStatus: 'not_checked',
      warehousePartialCoverQty: '0',
    };

    const plan = buildCommercialPositionMutationPlan({
      draft,
      position,
      rawMaterialStocks: [],
      sourcePositions: [position, siblingPosition],
    });

    expect(plan.positionUpdate.rawMaterialId).toBe('rm-sibling');
  });
});
