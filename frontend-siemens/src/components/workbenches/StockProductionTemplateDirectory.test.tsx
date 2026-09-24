import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStockProductionTemplate,
  type StockProductionTemplate,
} from '../../api/stockProductionTemplates';
import {
  StockProductionTemplateDirectory,
  TemplateDirectoryModeTabs,
} from './StockProductionTemplateDirectory';

const materials = [{ id: 'rmd-base-primary', name: 'ПВД 15803-020', kind: 'base' as const }];

const recipes = [
  {
    id: 'recipe-1',
    name: 'Молочная 80',
    version: {
      id: 'recipe-version-2',
      version: 2,
      ingredients: [
        {
          rawMaterialDefinitionId: 'rmd-base-primary',
          name: 'ПВД 15803-020',
          shareBasisPoints: 10_000,
        },
      ],
    },
  },
];

const firstPosition = {
  rollCount: 2,
  filmType: 'Полотно',
  actualThickness: '80 мкм',
  accountingThickness: '80 мкм',
  widthMm: 1700,
  plannedLengthM: 275,
  baseRawMaterialDefinitionId: 'rmd-base-primary',
  plannedWeightKg: 40,
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
  manualBirka: 'Маркировка А-17',
  comment: 'Первая позиция',
  recipeParameters: [],
};

function stockTemplate(overrides: Partial<StockProductionTemplate> = {}): StockProductionTemplate {
  const id = overrides.id ?? 'stock-template-1';
  const positions = overrides.positions ?? [firstPosition];
  return {
    id,
    name: 'Запас 80',
    description: 'Базовый запас',
    status: 'active',
    version: 3,
    positions,
    versions: [
      {
        id: 'stock-template-version-3',
        templateId: id,
        version: 3,
        positions,
        createdAt: '2026-07-27T09:00:00.000Z',
      },
    ],
    usageCount: 7,
    lastUsedAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T11:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((item) => item.children.join('') === label);
}

function change(root: ReactTestInstance, ariaLabel: string, value: string) {
  root.findByProps({ 'aria-label': ariaLabel }).props.onChange({
    target: { value },
    currentTarget: { value },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function renderDirectory(
  templates: StockProductionTemplate[],
  { readOnly = false }: { readOnly?: boolean } = {},
) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(templates));
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <StockProductionTemplateDirectory
        materials={materials}
        recipes={recipes}
        materialCatalogStatus="ready"
        materialCatalogError={null}
        onRetryMaterialCatalog={vi.fn()}
        readOnly={readOnly}
      />,
    );
    await Promise.resolve();
  });
  return renderer;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StockProductionTemplateDirectory', () => {
  it('exposes stable client and stock template modes with the stock create action', () => {
    const tabsMarkup = renderToStaticMarkup(
      <TemplateDirectoryModeTabs mode="stock" onChange={vi.fn()} />,
    );
    const directoryMarkup = renderToStaticMarkup(
      <StockProductionTemplateDirectory
        materials={[]}
        recipes={[]}
        materialCatalogStatus="ready"
        materialCatalogError={null}
        onRetryMaterialCatalog={vi.fn()}
      />,
    );

    expect(tabsMarkup).toContain('Клиентские шаблоны');
    expect(tabsMarkup).toContain('Шаблоны на запас');
    expect(directoryMarkup).toContain('Добавить шаблон на запас');
  });

  it('renders live rows in read-only mode without durable write affordances', async () => {
    const renderer = await renderDirectory([stockTemplate()], { readOnly: true });
    const markup = JSON.stringify(renderer.toJSON());

    expect(markup).toContain('Запас 80');
    expect(markup).toContain('Каталог доступен только для просмотра');
    expect(button(renderer.root, 'Добавить шаблон на запас')).toBeUndefined();
    expect(button(renderer.root, 'Редактировать')).toBeUndefined();
    expect(markup).not.toContain('Дублировать');
    expect(markup).not.toContain('Сохранить шаблон');
  });

  it('clears previously loaded rows when a refresh fails', async () => {
    const renderer = await renderDirectory([stockTemplate()]);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ message: 'Service unavailable' }, 503),
    );

    await act(async () => {
      button(renderer.root, 'Обновить каталог')!.props.onClick();
      await Promise.resolve();
    });

    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).not.toContain('Запас 80');
    expect(markup).toContain('Не удалось загрузить каталог шаблонов.');
  });

  it('aborts superseded requests and ignores their stale successful responses', async () => {
    const renderer = await renderDirectory([stockTemplate()]);
    const stale = deferred<Response>();
    const current = deferred<Response>();
    vi.mocked(globalThis.fetch)
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise);

    await act(async () => {
      button(renderer.root, 'Обновить каталог')!.props.onClick();
      await Promise.resolve();
    });
    const staleSignal = (vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit | undefined)
      ?.signal;

    await act(async () => {
      button(renderer.root, 'Обновить каталог')!.props.onClick();
      await Promise.resolve();
    });
    expect(staleSignal?.aborted).toBe(true);

    await act(async () => {
      stale.resolve(jsonResponse([stockTemplate({ id: 'stale', name: 'Устаревший шаблон' })]));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Устаревший шаблон');
    expect(JSON.stringify(renderer.toJSON())).toContain('Загружаем шаблоны');

    await act(async () => {
      current.resolve(jsonResponse([stockTemplate({ id: 'current', name: 'Текущий шаблон' })]));
      await Promise.resolve();
    });
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain('Текущий шаблон');
    expect(markup).not.toContain('Устаревший шаблон');
  });

  it('opens the flexible multi-position editor as an overlay dialog', async () => {
    const renderer = await renderDirectory([]);

    act(() => button(renderer.root, 'Добавить шаблон на запас')!.props.onClick());

    const dialog = renderer.root.findByProps({
      role: 'dialog',
      'aria-modal': 'true',
    });
    expect(dialog.props.className).toContain('stock-template-editor-modal');
    expect(dialog.props['aria-label']).toBe('Создание шаблона на запас');
    expect(renderer.root.findByProps({ 'aria-label': 'Удалить позицию 1' }).props.disabled).toBe(
      true,
    );

    act(() => button(renderer.root, 'Добавить тип рулона')!.props.onClick());
    act(() => {
      change(renderer.root, 'Тип плёнки, позиция 1', 'Полотно');
      change(renderer.root, 'Тип плёнки, позиция 2', 'Рукав');
    });

    expect(renderer.root.findByProps({ 'aria-label': 'Тип плёнки, позиция 1' }).props.value).toBe(
      'Полотно',
    );
    expect(renderer.root.findByProps({ 'aria-label': 'Тип плёнки, позиция 2' }).props.value).toBe(
      'Рукав',
    );
    expect(renderer.root.findByProps({ 'aria-label': 'Удалить позицию 1' }).props.disabled).toBe(
      false,
    );

    act(() => renderer.root.findByProps({ 'aria-label': 'Дублировать позицию 1' }).props.onClick());
    expect(renderer.root.findByProps({ 'aria-label': 'Тип плёнки, позиция 3' }).props.value).toBe(
      'Полотно',
    );
    act(() => change(renderer.root, 'Тип плёнки, позиция 1', 'Пакет'));
    expect(renderer.root.findByProps({ 'aria-label': 'Тип плёнки, позиция 3' }).props.value).toBe(
      'Полотно',
    );

    act(() => renderer.root.findByProps({ 'aria-label': 'Закрыть' }).props.onClick());
    expect(renderer.root.findAllByProps({ role: 'dialog', 'aria-modal': 'true' })).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('creates a two-position template through POST and updates the list in place', async () => {
    const renderer = await renderDirectory([]);
    const createButton = button(renderer.root, 'Добавить шаблон на запас');
    expect(createButton).toBeDefined();

    act(() => createButton!.props.onClick());
    act(() => {
      change(renderer.root, 'Название шаблона на запас', 'Резервная серия 80');
      change(renderer.root, 'Описание шаблона на запас', 'Два вида материала');
      change(renderer.root, 'Количество рулонов, позиция 1', '2');
      change(renderer.root, 'Тип плёнки, позиция 1', 'Полотно');
      change(renderer.root, 'Фактическая толщина, позиция 1', '80 мкм');
      change(renderer.root, 'Бухгалтерская толщина, позиция 1', '80 мкм');
      change(renderer.root, 'Ширина, мм, позиция 1', '1700');
      change(renderer.root, 'Метраж, м, позиция 1', '275');
      change(renderer.root, 'Материал, позиция 1', 'material:rmd-base-primary');
      change(renderer.root, 'Плановый вес, позиция 1', '40');
      change(renderer.root, 'Шпуля, позиция 1', 'Тонкая');
      change(renderer.root, 'Бирка, позиция 1', 'ГОСТ');
      change(renderer.root, 'Ручная бирка, позиция 1', 'Маркировка А-17');
    });

    act(() => button(renderer.root, 'Добавить тип рулона')!.props.onClick());
    act(() => {
      change(renderer.root, 'Количество рулонов, позиция 2', '3');
      change(renderer.root, 'Тип плёнки, позиция 2', 'Рукав');
      change(renderer.root, 'Фактическая толщина, позиция 2', '100 мкм');
      change(renderer.root, 'Бухгалтерская толщина, позиция 2', '100 мкм');
      change(renderer.root, 'Ширина, мм, позиция 2', '1500');
      change(renderer.root, 'Метраж, м, позиция 2', '300');
      change(renderer.root, 'Материал, позиция 2', 'recipe:recipe-version-2');
      change(renderer.root, 'Плановый вес, позиция 2', '55');
      change(renderer.root, 'Шпуля, позиция 2', 'Толстая');
      change(renderer.root, 'Бирка, позиция 2', 'Тех');
      change(renderer.root, 'Ручная бирка, позиция 2', 'Маркировка М-60');
    });

    const created = stockTemplate({
      name: 'Резервная серия 80',
      description: 'Два вида материала',
      version: 1,
      positions: [
        {
          ...firstPosition,
          comment: undefined,
        },
        {
          rollCount: 3,
          filmType: 'Рукав',
          actualThickness: '100 мкм',
          accountingThickness: '100 мкм',
          recipeDefinitionVersionId: 'recipe-version-2',
          plannedWeightKg: 55,
          spoolType: 'Толстая',
          birka: 'Тех',
          recipeParameters: [],
        },
      ],
      versions: [],
      usageCount: 0,
      lastUsedAt: null,
    });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(created, 201));

    await act(async () => {
      await button(renderer.root, 'Сохранить шаблон')!.props.onClick();
    });

    const postCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([, init]) => init?.method === 'POST');
    expect(postCall?.[0]).toBe('/api/commercial/stock-production-templates');
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      name: 'Резервная серия 80',
      description: 'Два вида материала',
      positions: [
        {
          rollCount: 2,
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
          baseRawMaterialDefinitionId: 'rmd-base-primary',
          plannedWeightKg: 40,
          spoolType: 'Тонкая',
          birka: 'ГОСТ',
          manualBirka: 'Маркировка А-17',
          recipeParameters: [],
        },
        {
          rollCount: 3,
          filmType: 'Рукав',
          actualThickness: '100 мкм',
          accountingThickness: '100 мкм',
          widthMm: 1500,
          plannedLengthM: 300,
          recipeDefinitionVersionId: 'recipe-version-2',
          plannedWeightKg: 55,
          spoolType: 'Толстая',
          birka: 'Тех',
          manualBirka: 'Маркировка М-60',
          recipeParameters: [],
        },
      ],
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Резервная серия 80');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('updates with expectedVersion through PATCH and replaces the saved card without reload', async () => {
    const renderer = await renderDirectory([stockTemplate()]);

    act(() => button(renderer.root, 'Редактировать')!.props.onClick());
    act(() => change(renderer.root, 'Название шаблона на запас', 'Запас 80 · обновлён'));

    const updated = stockTemplate({
      name: 'Запас 80 · обновлён',
      version: 4,
      updatedAt: '2026-07-27T12:00:00.000Z',
    });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(updated));

    await act(async () => {
      await button(renderer.root, 'Сохранить шаблон')!.props.onClick();
    });

    const patchCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall?.[0]).toBe('/api/commercial/stock-production-templates/stock-template-1');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      name: 'Запас 80 · обновлён',
      expectedVersion: 3,
    });
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain('Запас 80 · обновлён');
    expect(
      renderer.root.findByProps({ className: 'stock-template-version' }).children.join(''),
    ).toBe('v4');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('shows a clear conflict message for a stale write', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ message: 'Conflict' }, 409));

    await expect(
      createStockProductionTemplate({
        name: 'Конфликтный шаблон',
        positions: [firstPosition],
      }),
    ).rejects.toThrow('Шаблон уже изменён на другом рабочем месте. Обновите каталог и повторите.');
  });
});
