import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { defaultIntakeDraft } from '../../domain/prototypeRuntime';
import type { Counterparty } from '../../domain/types';
import { CounterpartySearchPicker } from './CounterpartySearchPicker';
import { IntakeCreateSurface } from './intakeCreateSurface';

const materials = [
  { id: 'base-primary', name: 'Первичное', kind: 'base' as const },
  { id: 'base-secondary', name: 'Вторичное', kind: 'base' as const },
  { id: 'base-aika', name: 'Айка', kind: 'base' as const },
  { id: 'custom-dye', name: 'Краситель', kind: 'custom' as const },
];

const recipes = [
  {
    id: 'recipe-green',
    name: 'Зелёная 30/70',
    version: {
      id: 'recipe-green-v3',
      version: 3,
      ingredients: [
        {
          rawMaterialDefinitionId: 'base-primary',
          name: 'Первичное',
          shareBasisPoints: 10_000,
        },
      ],
    },
  },
];

describe('commercial intake material selectors', () => {
  it('disables editable controls and closing while creation is pending', () => {
    const renderer = TestRenderer.create(
      createElement(IntakeCreateSurface, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        submitting: true,
      }),
    );
    const group = renderer.root.findByProps({ className: 'intake-form' });
    expect(group.type).toBe('fieldset');
    expect(group.props.disabled).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': 'Закрыть форму' }).props.disabled).toBe(true);
    renderer.unmount();
  });

  it('renders required width and planned length inputs for every position', () => {
    const renderer = TestRenderer.create(
      createElement(IntakeCreateSurface, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready',
      }),
    );

    expect(
      renderer.root.findByProps({ 'aria-label': 'Ширина, мм, позиция 1' }).props.value,
    ).toBe('1700');
    expect(
      renderer.root.findByProps({ 'aria-label': 'Метраж, м, позиция 1' }).props.value,
    ).toBe('275');
  });

  it('renders a separate bounded free-form note for accounting without parsing its value', () => {
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: {
          ...defaultIntakeDraft,
          commercialFinanceNote: '1200 за 20 рулонов',
        },
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready',
      }),
    );

    expect(markup).toContain('Комментарий для бухгалтерии / ориентир цены');
    expect(markup).toContain('1200 за 20 рулонов');
    expect(markup).toContain('maxLength="2000"');
    expect(markup).toContain('Сумму счёта бухгалтерия укажет вручную');
    expect(markup).not.toContain('сумма появится только из проведённого счёта 1С');
  });

  it('keeps the fixed action summary compact without repeating the position count', () => {
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready',
      }),
    );

    expect(markup.match(/class="intake-create-summary-item"/g)).toHaveLength(2);
    expect(markup).not.toContain('<span>Позиции</span>');
    expect(markup).toContain('<h3>2 поз. · 5 рул. всего</h3>');
    expect(markup).toContain('class="intake-create-summary-warning"');
    expect(markup).not.toContain('<ix-message-bar');
  });

  it('places the incomplete-request warning in the bottom action area', () => {
    const renderer = TestRenderer.create(
      createElement(IntakeCreateSurface, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready',
      }),
    );
    const actionArea = renderer.root.findByProps({ className: 'drawer-actions' });
    const summary = renderer.root.findByProps({
      className: 'intake-create-summary state-blocked',
    });

    expect(summary.parent).toBe(actionArea);
    expect(actionArea.children[0]).toBe(summary);
  });

  it('associates the counterparty combobox with a dedicated non-label field caption', () => {
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );
    const captionId = /<span id="([^"]+)">Контрагент<\/span>/u.exec(markup)?.[1];

    expect(captionId).toBeTruthy();
    expect(markup).toContain('class="intake-counterparty-field"');
    expect(markup).toContain(`aria-labelledby="${captionId}"`);
    expect(markup).not.toMatch(/<label[^>]*>[\s\S]*?counterparty-search-picker/u);
  });

  it('does not show a manual-details helper before a counterparty is selected', () => {
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: {
          ...defaultIntakeDraft,
          counterparty: '',
          templateId: undefined,
        },
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(markup).not.toContain('Реквизиты нового клиента вводятся вручную');
  });

  it('omits unavailable INN autofill from counterparty quick-create', () => {
    vi.stubGlobal('window', {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
    });
    const renderer = TestRenderer.create(
      createElement(IntakeCreateSurface, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    try {
      act(() => {
        renderer.root
          .findByType(CounterpartySearchPicker)
          .findByType('select')
          .props.onChange({ target: { value: '__create__' } });
      });

      const sheet = JSON.stringify(renderer.toJSON());
      expect(sheet).not.toContain('Заполнить по ИНН');
      expect(sheet).not.toContain('Автозаполнение не подключено');
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('stores the canonical counterparty id even when display names are duplicated', () => {
    const onChange = vi.fn();
    const renderer = TestRenderer.create(
      createElement(IntakeCreateSurface, {
        value: { ...defaultIntakeDraft, counterparty: '', counterpartyId: undefined },
        onChange,
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        counterpartyCatalog: [
          { id: 'cp-first', legalName: 'Одинаковое имя', alias: 'Первый' } as Counterparty,
          { id: 'cp-second', legalName: 'Одинаковое имя', alias: 'Второй' } as Counterparty,
        ],
      }),
    );

    act(() => {
      renderer.root
        .findByType(CounterpartySearchPicker)
        .findByType('select')
        .props.onChange({ target: { value: 'cp-second' } });
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        counterparty: 'Одинаковое имя',
        counterpartyId: 'cp-second',
      }),
    );
  });

  it('renders exact production vocabularies and the same persisted recipe in both selectors', () => {
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: {
          ...defaultIntakeDraft,
          positions: [
            {
              ...defaultIntakeDraft.positions[0],
              baseRawMaterialDefinitionId: '',
              recipeDefinitionVersionId: 'recipe-green-v3',
            },
          ],
        },
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready',
        materialCatalogError: null,
        onRetryMaterialCatalog: vi.fn(),
        onCreateRecipe: vi.fn(),
      }),
    );

    expect(markup).toContain('<span>Рецептуры</span>');
    expect(markup).not.toContain('<span>Сырье</span>');
    expect(markup).toContain(
      'aria-label="Поиск рецептур, позиция 1"',
    );
    expect(markup).toContain(
      '<option value="" disabled="">Выберите продукт или рецептуру</option>',
    );
    expect(markup).toContain('<optgroup label="Базовые продукты">');
    expect(markup).toContain('<optgroup label="Сохранённые рецептуры">');
    expect(markup.match(/Зелёная 30\/70/g)).toHaveLength(1);
    expect(markup).toContain('value="material:base-primary"');
    expect(markup).toContain('value="material:custom-dye"');
    for (const value of ['Рукав', 'Полотно', 'Полурукав', 'Фальц']) {
      expect(markup).toContain(`>${value}</option>`);
    }
    for (const value of ['ГОСТ', 'i', 'Тех', 'ГОСТ103', 'ГОСТ259']) {
      expect(markup).toContain(`>${value}</option>`);
    }
    for (const value of ['Тонкая', 'Толстая']) {
      expect(markup).toContain(`>${value}</option>`);
    }
    expect(markup).not.toMatch(/>Гост<|>\(i\)<|>Шпуля 76 мм</);
    expect(
      ['Первичное', 'Вторичное', 'Айка', 'Краситель', 'Зелёная 30/70'].map((label) =>
        markup.indexOf(`>${label}</option>`),
      ),
    ).toEqual([...new Set(
      ['Первичное', 'Вторичное', 'Айка', 'Краситель', 'Зелёная 30/70'].map((label) =>
        markup.indexOf(`>${label}</option>`),
      ),
    )].sort((left, right) => left - right));
  });

  it('stores the immutable recipe version id selected through the unified selector', () => {
      const onChange = vi.fn();
      const renderer = TestRenderer.create(
        createElement(IntakeCreateSurface, {
          value: {
            ...defaultIntakeDraft,
            positions: [
              {
                ...defaultIntakeDraft.positions[0],
                baseRawMaterialDefinitionId: '',
                recipeDefinitionVersionId: '',
              },
            ],
          },
          onChange,
          onClose: vi.fn(),
          onSubmit: vi.fn(),
          materials,
          recipes,
          materialCatalogStatus: 'ready',
        }),
      );

      act(() => {
        renderer.root
          .findByProps({ 'aria-label': 'Рецептуры, позиция 1' })
          .props.onChange({
          target: { value: 'recipe:recipe-green-v3' },
        });
      });

      expect(onChange.mock.calls[0][0].positions[0]).toMatchObject({
        baseRawMaterialDefinitionId: '',
        recipeDefinitionVersionId: 'recipe-green-v3',
      });
  });

  it('searches base products and saved recipes without losing the current choice', () => {
    const renderer = TestRenderer.create(
      createElement(IntakeCreateSurface, {
        value: {
          ...defaultIntakeDraft,
          positions: [
            {
              ...defaultIntakeDraft.positions[0],
              baseRawMaterialDefinitionId: 'base-primary',
              recipeDefinitionVersionId: '',
            },
          ],
        },
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready',
      }),
    );

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Поиск рецептур, позиция 1' })
        .props.onChange({ target: { value: 'зелён' } });
    });

    const labels = renderer.root
      .findAllByType('option')
      .flatMap((option) => option.children)
      .filter((child): child is string => typeof child === 'string');
    expect(labels).toContain('Зелёная 30/70');
    expect(labels).toContain('Первичное');
    expect(labels).not.toContain('Вторичное');
  });

  it('keeps a catalog retry local to the form and exposes recipe creation per position', () => {
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: {
          ...defaultIntakeDraft,
          positions: [
            {
              ...defaultIntakeDraft.positions[0],
              baseRawMaterialDefinitionId: '',
              recipeDefinitionVersionId: '',
              rawMaterial: '',
            },
          ],
        },
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials: [],
        recipes: [],
        materialCatalogStatus: 'error',
        materialCatalogError: 'Каталог недоступен',
        onRetryMaterialCatalog: vi.fn(),
        onCreateRecipe: vi.fn(),
        effectiveCapabilities: ['recipe_catalog:create'],
        creatorRole: 'production_lead',
      }),
    );

    expect(markup).toContain('Каталог недоступен');
    expect(markup).toContain('Повторить загрузку');
    expect(markup).toContain('Создать рецептуру');
    expect(markup).toContain(
      'Каталог сырья и рецептур недоступен. Повторите загрузку.',
    );
  });

  it('keeps production-lead creation submit-only without assignment promises or fields', () => {
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        creatorRole: 'production_lead',
        materials,
        recipes,
        materialCatalogStatus: 'ready',
      }),
    );

    expect(markup).toContain('>Создать заявку</button>');
    expect(markup).toContain('требует подтверждения коммерции');
    expect(markup).not.toContain('Создать и назначить');
    expect(markup).not.toContain('Сохранить черновик');
    expect(markup).not.toContain('<span>Оператор</span>');
    expect(markup).not.toContain('<span>Приоритет</span>');
  });

  it('fails closed and hides recipe creation while effective capabilities are unavailable', () => {
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        onCreateRecipe: vi.fn(),
      }),
    );

    expect(markup).not.toContain('Создать рецептуру');
  });

  it.each(['commercial', 'production_lead'] as const)(
    'exposes recipe creation to %s only through the effective capability',
    (creatorRole) => {
      const markup = renderToStaticMarkup(
        createElement(IntakeCreateSurface, {
          value: defaultIntakeDraft,
          onChange: vi.fn(),
          onClose: vi.fn(),
          onSubmit: vi.fn(),
          onCreateRecipe: vi.fn(),
          creatorRole,
          effectiveCapabilities: ['recipe_catalog:create'],
        }),
      );

      expect(markup).toContain('Создать рецептуру');
    },
  );

  it('blocks retry until a stale persisted selector is explicitly reselected', () => {
    const position = {
      ...defaultIntakeDraft.positions[0],
      id: 'stale-position',
      baseRawMaterialDefinitionId: 'base-primary',
      recipeDefinitionVersionId: '',
    };
    const markup = renderToStaticMarkup(
      createElement(IntakeCreateSurface, {
        value: { ...defaultIntakeDraft, positions: [position] },
        onChange: vi.fn(),
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready',
        materialSelectionInvalidPositionIds: new Set(['stale-position']),
      }),
    );

    expect(markup).toContain(
      'Каталог изменился. Повторно выберите сырьё или рецептуру.',
    );
    expect(markup).toContain(
      'class="primary-button" disabled="" title="Каталог изменился.',
    );
    expect(markup).not.toContain('value="material:base-primary" selected=""');
    expect(position.baseRawMaterialDefinitionId).toBe('base-primary');
  });

  it('controls the stale selector as blank and accepts choosing the same catalog item again', () => {
    const position = {
      ...defaultIntakeDraft.positions[0],
      id: 'stale-position',
      baseRawMaterialDefinitionId: 'base-primary',
      recipeDefinitionVersionId: '',
    };
    const onChange = vi.fn();
    const onConfirmed = vi.fn();
    const renderer = TestRenderer.create(
      createElement(IntakeCreateSurface, {
        value: { ...defaultIntakeDraft, positions: [position] },
        onChange,
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready',
        materialSelectionInvalidPositionIds: new Set(['stale-position']),
        onMaterialSelectionConfirmed: onConfirmed,
      }),
    );
    const selector = renderer.root.findByProps({
      'aria-label': 'Рецептуры, позиция 1',
    });

    expect(selector.props.value).toBe('');

    act(() => {
      selector.props.onChange({ target: { value: 'material:base-primary' } });
    });

    expect(onConfirmed).toHaveBeenCalledWith('stale-position');
    expect(onChange.mock.calls[0][0].positions[0]).toMatchObject({
      baseRawMaterialDefinitionId: 'base-primary',
      recipeDefinitionVersionId: '',
    });
  });

  it('keeps template normalization when the template dropdown applies legacy values and an archived recipe', () => {
    const template = {
      id: 'tpl-legacy-structured',
      counterpartyId: 'cp-uralpak',
      name: 'Старый структурный шаблон',
      activeVersionId: 'tplv-legacy-structured',
      status: 'active' as const,
      ownerRole: 'Коммерция',
      usageCount: 1,
      lastUsedAt: 'сегодня',
      updatedAt: '2026-07-23',
    };
    const version = {
      id: template.activeVersionId,
      templateId: template.id,
      version: 'legacy',
      fields: [],
      reason: 'legacy fixture',
      createdBy: 'Коммерция',
      createdAt: '2026-07-23',
      affectsProduction: true,
      affectsMoney: false,
    };
    const onChange = vi.fn();
    const renderer = TestRenderer.create(
      createElement(IntakeCreateSurface, {
        value: { ...defaultIntakeDraft, templateId: undefined },
        onChange,
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        creatorRole: 'production_lead',
        templateCatalog: [template],
        templateVersions: [version],
        templateDraftPositions: {
          [template.id]: [
            {
              ...defaultIntakeDraft.positions[0],
              filmType: 'Пакет',
              birka: 'Гост',
              spoolType: 'Шпуля 76 мм',
              rawMaterial: 'Архивная рецептура',
              baseRawMaterialDefinitionId: '',
              recipeDefinitionVersionId: 'recipe-archived-v1',
            },
          ],
        },
        materials,
        recipes,
        materialCatalogStatus: 'ready',
      }),
    );
    const templateSelect = renderer.root.findByProps({
      value: '__new_template__',
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Без шаблона');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Новый шаблон клиента');

    act(() => {
      templateSelect.props.onChange({ target: { value: template.id } });
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].templateVersionId).toBe('tplv-legacy-structured');
    expect(onChange.mock.calls[0][0].positions[0]).toMatchObject({
      filmType: '',
      birka: '',
      spoolType: '',
      rawMaterial: '',
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
    });
  });

  it('clears a stale selector on duplicate so deleting the original cannot bypass reselection', () => {
    const originalPosition = {
      ...defaultIntakeDraft.positions[0],
      id: 'stale-original',
      rawMaterial: 'Первичное',
      rawMaterialId: 'legacy-raw-material',
      baseRawMaterialDefinitionId: 'base-primary',
      recipeDefinitionVersionId: '',
    };
    let currentValue = {
      ...defaultIntakeDraft,
      positions: [originalPosition],
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    const invalidIds = new Set(['stale-original']);
    const onChange = vi.fn((nextValue: typeof currentValue) => {
      currentValue = nextValue;
      renderer.update(renderSurface());
    });
    const renderSurface = () =>
      createElement(IntakeCreateSurface, {
        value: currentValue,
        onChange,
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        materials,
        recipes,
        materialCatalogStatus: 'ready' as const,
        materialSelectionInvalidPositionIds: invalidIds,
      });

    act(() => {
      renderer = TestRenderer.create(renderSurface());
    });
    const duplicateButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Дублировать'));

    act(() => {
      duplicateButton?.props.onClick();
    });

    expect(currentValue.positions[1]).toMatchObject({
      rawMaterial: '',
      rawMaterialId: '',
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: '',
    });

    const removeOriginalButton = renderer.root
      .findAllByType('button')
      .filter((button) => button.children.includes('Удалить'))[0];
    act(() => {
      removeOriginalButton.props.onClick();
    });

    expect(currentValue.positions).toHaveLength(1);
    expect(currentValue.positions[0].id).not.toBe('stale-original');
    const primaryButton = renderer.root.findByProps({
      className: 'primary-button',
    });
    expect(primaryButton.props.disabled).toBe(true);
    expect(primaryButton.props.title).toContain('сырье');
  });

  it.each([
    ['loading', 'Дождитесь загрузки каталога сырья и рецептур.'],
    ['error', 'Каталог сырья и рецептур недоступен. Повторите загрузку.'],
  ] as const)(
    'blocks an otherwise complete order while the material catalog is %s',
    (materialCatalogStatus, expectedReason) => {
      const markup = renderToStaticMarkup(
        createElement(IntakeCreateSurface, {
          value: {
            ...defaultIntakeDraft,
            positions: [
              {
                ...defaultIntakeDraft.positions[0],
                baseRawMaterialDefinitionId: 'base-primary',
                recipeDefinitionVersionId: '',
              },
            ],
          },
          onChange: vi.fn(),
          onClose: vi.fn(),
          onSubmit: vi.fn(),
          materials,
          recipes,
          materialCatalogStatus,
        }),
      );

      expect(markup).toContain(expectedReason);
      expect(markup).toContain('class="primary-button" disabled=""');
    },
  );
});
