import { describe, expect, it } from 'vitest';
import { applyTemplateToIntakeDraft, refreshIntakeDraftFromSelectedTemplate } from './intakeTemplates';
import { defaultIntakeDraft } from './prototypeRuntime';
import type { CounterpartyOrderTemplate, CounterpartyOrderTemplateVersion } from './types';

describe('applyTemplateToIntakeDraft', () => {
  it('fills the order form from legacy backend positions when the template has no version row', () => {
    const template = {
      id: 'tpl-legacy-live',
      counterpartyId: 'cp-paketprom',
      name: 'ПакетПром · молочная пленка 60',
      activeVersionId: '',
      status: 'active' as const,
      ownerRole: 'Зав. производства',
      usageCount: 0,
      lastUsedAt: '',
      updatedAt: '',
    };
    const structuredPositions = [
      {
        ...defaultIntakeDraft.positions[0],
        id: 'tpl-legacy-live-position-1',
        rollCount: '2',
        filmType: 'Полотно',
        actualThickness: '60 мкм',
        accountingThickness: '60 мкм',
        plannedWeightKg: '78',
        baseRawMaterialDefinitionId: 'rmd-base-primary',
      },
    ];

    const result = applyTemplateToIntakeDraft(
      defaultIntakeDraft,
      template,
      [],
      structuredPositions,
    );

    expect(result).toMatchObject({
      templateId: 'tpl-legacy-live',
      template: 'ПакетПром · молочная пленка 60',
      positions: [
        {
          rollCount: '2',
          filmType: 'Полотно',
          actualThickness: '60 мкм',
          accountingThickness: '60 мкм',
          plannedWeightKg: '78',
          baseRawMaterialDefinitionId: 'rmd-base-primary',
        },
      ],
    });
    expect(result.templateVersionId).toBeUndefined();
  });

  it('preserves an immutable structured selector supplied by a backend template', () => {
    const template = {
      id: 'tpl-structured',
      counterpartyId: 'cp-uralpak',
      name: 'Структурный шаблон',
      activeVersionId: 'tplv-structured',
      status: 'active',
      ownerRole: 'Зав. производства',
      usageCount: 0,
      lastUsedAt: 'сегодня',
      updatedAt: '2026-07-23',
    } satisfies CounterpartyOrderTemplate;
    const versions = [
      {
        id: 'tplv-structured',
        templateId: template.id,
        version: 'backend snapshot',
        fields: [
          { label: 'Тип пленки', value: 'Фальц', kind: 'production', required: true },
          { label: 'Сырье', value: 'Зелёная 30/70', kind: 'production', required: true },
          { label: 'Бирка', value: 'ГОСТ103', kind: 'production', required: true },
          { label: 'Шпуля', value: 'Толстая', kind: 'production', required: true },
        ],
        reason: 'backend',
        createdBy: 'Зав. производства',
        createdAt: '2026-07-23',
        affectsProduction: true,
        affectsMoney: false,
      },
    ] satisfies CounterpartyOrderTemplateVersion[];
    const structuredPositions = [
      {
        ...defaultIntakeDraft.positions[0],
        id: 'template-position',
        baseRawMaterialDefinitionId: '',
        recipeDefinitionVersionId: 'recipe-green-v3',
        filmType: 'Фальц',
        birka: 'ГОСТ103',
        spoolType: 'Толстая',
      },
    ];

    const result = applyTemplateToIntakeDraft(
      defaultIntakeDraft,
      template,
      versions,
      structuredPositions,
    );

    expect(result.positions[0]).toMatchObject({
      id: 'template-position',
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: 'recipe-green-v3',
      filmType: 'Фальц',
      birka: 'ГОСТ103',
      spoolType: 'Толстая',
    });
    expect(result.templateVersionId).toBe('tplv-structured');
    expect(result.positions[0]).not.toBe(structuredPositions[0]);
  });

  it('clears unsupported legacy option values instead of silently submitting them', () => {
    const template = {
      id: 'tpl-legacy',
      counterpartyId: 'cp-uralpak',
      name: 'Старый шаблон',
      activeVersionId: 'tplv-legacy',
      status: 'active',
      ownerRole: 'Зав. производства',
      usageCount: 0,
      lastUsedAt: 'сегодня',
      updatedAt: '2026-07-23',
    } satisfies CounterpartyOrderTemplate;
    const versions = [
      {
        id: 'tplv-legacy',
        templateId: template.id,
        version: 'legacy',
        fields: [
          { label: 'Тип пленки', value: 'Пакет', kind: 'production', required: true },
          { label: 'Бирка', value: 'Гост', kind: 'production', required: true },
          { label: 'Шпуля', value: 'Шпуля 76 мм', kind: 'production', required: true },
        ],
        reason: 'legacy',
        createdBy: 'Зав. производства',
        createdAt: '2026-07-23',
        affectsProduction: true,
        affectsMoney: false,
      },
    ] satisfies CounterpartyOrderTemplateVersion[];

    const result = applyTemplateToIntakeDraft(defaultIntakeDraft, template, versions);

    expect(result.positions[0]).toMatchObject({
      filmType: '',
      birka: '',
      spoolType: '',
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
    });
  });

  it('clears a structured selector that is absent from the loaded catalog', () => {
    const template = {
      id: 'tpl-stale-structured',
      counterpartyId: 'cp-uralpak',
      name: 'Устаревшая рецептура',
      activeVersionId: 'tplv-stale-structured',
      status: 'active',
      ownerRole: 'Зав. производства',
      usageCount: 0,
      lastUsedAt: 'сегодня',
      updatedAt: '2026-07-23',
    } satisfies CounterpartyOrderTemplate;
    const versions = [
      {
        id: template.activeVersionId,
        templateId: template.id,
        version: 'backend',
        fields: [],
        reason: 'backend',
        createdBy: 'Зав. производства',
        createdAt: '2026-07-23',
        affectsProduction: true,
        affectsMoney: false,
      },
    ] satisfies CounterpartyOrderTemplateVersion[];
    const structuredPositions = [
      {
        ...defaultIntakeDraft.positions[0],
        baseRawMaterialDefinitionId: '',
        recipeDefinitionVersionId: 'recipe-archived-v1',
        rawMaterial: 'Архивная рецептура',
      },
    ];

    const result = applyTemplateToIntakeDraft(
      defaultIntakeDraft,
      template,
      versions,
      structuredPositions,
      {
        materials: [
          { id: 'rmd-base-primary', name: 'Первичное', kind: 'base' },
        ],
        recipes: [],
      },
    );

    expect(result.positions[0]).toMatchObject({
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
      rawMaterial: '',
    });
  });

  it('copies the selected production template values into the intake draft', () => {
    const template: CounterpartyOrderTemplate = {
      id: 'tpl-custom-production-70',
      counterpartyId: 'cp-uralpak',
      name: 'УралПак · рукав 70 мкм',
      activeVersionId: 'tplv-custom-production-70',
      status: 'active',
      ownerRole: 'Зав. производства',
      usageCount: 0,
      lastUsedAt: 'еще не применялся',
      updatedAt: '2026-07-09',
    };
    const versions: CounterpartyOrderTemplateVersion[] = [
      {
        id: 'tplv-custom-production-70',
        templateId: template.id,
        version: 'v1.0',
        fields: [
          { label: 'Тип пленки', value: 'Рукав', kind: 'production', required: true },
          { label: 'Толщина', value: '70 мкм', kind: 'production', required: true },
          { label: 'Рулоны', value: '5 шт. по 32.5 кг', kind: 'production', required: true },
          { label: 'Сырье', value: 'ПВД 10803-020', kind: 'production', required: true },
          { label: 'Шпуля', value: 'Шпуля 152 мм', kind: 'production', required: true },
        ],
        reason: 'Создан зав. производства',
        createdBy: 'Зав. производства',
        createdAt: '2026-07-09',
        affectsProduction: true,
        affectsMoney: false,
      },
    ];

    const result = applyTemplateToIntakeDraft(defaultIntakeDraft, template, versions);

    expect(result.templateId).toBe('tpl-custom-production-70');
    expect(result.template).toContain('70 мкм');
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({
      rollCount: '5',
      actualThickness: '70 мкм',
      accountingThickness: '70 мкм',
      plannedWeightKg: '32.5',
      rawMaterial: 'ПВД 10803-020',
      rawMaterialId: '',
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
      spoolType: '',
    });
  });

  it('copies width and meterage from a client template into the order position', () => {
    const template: CounterpartyOrderTemplate = {
      id: 'tpl-client-dimensions',
      counterpartyId: 'cp-uralpak',
      name: 'Рукав 80 мкм',
      activeVersionId: 'tplv-client-dimensions',
      status: 'active',
      ownerRole: 'Зав. производства',
      usageCount: 0,
      lastUsedAt: 'еще не применялся',
      updatedAt: '2026-08-05',
    };
    const versions: CounterpartyOrderTemplateVersion[] = [
      {
        id: template.activeVersionId,
        templateId: template.id,
        version: 'v1.0',
        fields: [
          { label: 'Тип пленки', value: 'Рукав', kind: 'production', required: true },
          { label: 'Толщина', value: '80 мкм', kind: 'production', required: true },
          { label: 'Ширина, мм', value: '1650', kind: 'production', required: true },
          { label: 'Метраж, м', value: '420', kind: 'production', required: true },
        ],
        reason: 'Создан зав. производства',
        createdBy: 'Зав. производства',
        createdAt: '2026-08-05',
        affectsProduction: true,
        affectsMoney: false,
      },
    ];

    const result = applyTemplateToIntakeDraft(
      {
        ...defaultIntakeDraft,
        positions: [
          {
            ...defaultIntakeDraft.positions[0],
            widthMm: '',
            plannedLengthM: '',
          },
        ],
      },
      template,
      versions,
    );

    expect(result.positions[0]).toMatchObject({
      widthMm: '1650',
      plannedLengthM: '420',
    });
  });

  it('reads planned weight from baseline templates that use kg plan wording', () => {
    const template: CounterpartyOrderTemplate = {
      id: 'tpl-paketprom-milk-60',
      counterpartyId: 'cp-paketprom',
      name: 'ПакетПром · молочная пленка 60',
      activeVersionId: 'tplv-paketprom-milk-60-v21',
      status: 'active',
      ownerRole: 'Зав. производства',
      usageCount: 0,
      lastUsedAt: 'еще не применялся',
      updatedAt: '2026-07-09',
    };
    const versions: CounterpartyOrderTemplateVersion[] = [
      {
        id: 'tplv-paketprom-milk-60-v21',
        templateId: template.id,
        version: 'v2.1',
        fields: [
          { label: 'Тип пленки', value: 'Полотно', kind: 'production', required: true },
          { label: 'Толщина', value: '60 мкм', kind: 'production', required: true },
          { label: 'Рулоны', value: '2 шт., 78 кг план', kind: 'production', required: true },
          { label: 'Сырье', value: 'ПВД 15803-020', kind: 'production', required: true },
          { label: 'Шпуля', value: 'Шпуля 76 мм', kind: 'production', required: true },
        ],
        reason: 'baseline',
        createdBy: 'Зав. производства',
        createdAt: '2026-07-09',
        affectsProduction: true,
        affectsMoney: false,
      },
    ];

    const result = applyTemplateToIntakeDraft(defaultIntakeDraft, template, versions);

    expect(result.positions[0]).toMatchObject({
      rollCount: '2',
      plannedWeightKg: '78',
    });
  });

  it('refreshes the default selected template from the live template catalog', () => {
    const template: CounterpartyOrderTemplate = {
      id: 'tpl-uralpak-sleeve-80',
      counterpartyId: 'cp-uralpak',
      name: 'УралПак · рукав 80 мкм',
      activeVersionId: 'tpl-uralpak-sleeve-80-backend',
      status: 'active',
      ownerRole: 'Зав. производства',
      usageCount: 0,
      lastUsedAt: 'сегодня',
      updatedAt: '2026-07-09',
    };
    const versions: CounterpartyOrderTemplateVersion[] = [
      {
        id: 'tpl-uralpak-sleeve-80-backend',
        templateId: template.id,
        version: 'backend snapshot',
        fields: [
          { label: 'Тип пленки', value: 'Рукав', kind: 'production', required: true },
          { label: 'Толщина', value: '80 мкм', kind: 'production', required: true },
          { label: 'Рулоны', value: '10 шт. по 41.2 кг', kind: 'production', required: true },
          { label: 'Сырье', value: 'ПВД 15803-020', kind: 'production', required: true },
          { label: 'Шпуля', value: 'Шпуля 76 мм', kind: 'production', required: true },
        ],
        reason: 'edited in production',
        createdBy: 'Зав. производства',
        createdAt: '2026-07-09',
        affectsProduction: true,
        affectsMoney: false,
      },
    ];

    const result = refreshIntakeDraftFromSelectedTemplate(defaultIntakeDraft, [template], versions);

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({
      rollCount: '10',
      actualThickness: '80 мкм',
      plannedWeightKg: '41.2',
    });
  });
});
