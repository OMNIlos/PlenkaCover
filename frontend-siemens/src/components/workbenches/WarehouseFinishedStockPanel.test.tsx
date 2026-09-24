import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  liveRawMaterialsToWorkObject,
  type WarehouseFinishedStockPage,
  type WarehouseFinishedStockQuery,
} from '../../api/warehouse';
import { warehouseWorkObjects } from '../../domain/fixtures/warehouse';
import { WarehouseInventoryDashboard } from './WarehouseInventoryDashboard';
import { WarehouseFinishedStockPanel } from './WarehouseFinishedStockPanel';

const stockPage: WarehouseFinishedStockPage = {
  items: [
    {
      id: 'warehouse-roll-1',
      rollCode: 'R-STOCK-001',
      batchCode: 'STOCK-S-17',
      weightKg: 40.25,
      recipe: 'ПВД 70/30',
      specification: 'Полотно · 80 мкм · Тонкая',
      ageDays: 4,
      processedAt: null,
    },
  ],
  summary: {
    totalCount: 1,
    totalWeightKg: 40.25,
    pageCount: 1,
    pageWeightKg: 40.25,
  },
  nextCursor: 'cursor-2',
};

const inventoryPage = {
  items: [
    {
      id: 'warehouse-roll-1',
      rollCode: 'R-STOCK-001',
      origin: 'reserve',
      lifecycleStatus: 'processed',
      lifecycleStatusLabel: 'Обработан',
      orderNumber: null,
      positionId: null,
      positionSequence: null,
      warehouseStatus: 'delivered',
      warehouseStatusLabel: 'Выдан',
      nextRoute: 'completed',
      nextRouteLabel: 'Маршрут завершён',
      counterpartyName: 'Резерв',
      batchCode: 'STOCK-S-17',
      weightKg: 40.25,
      specification: 'ПВД 70/30 · Полотно · 80 мкм · Тонкая',
      receivedAt: '2026-08-01T08:00:00.000Z',
      processedAt: '2026-08-06T08:00:00.000Z',
    },
  ],
  nextCursor: null,
};

function liveInventory() {
  return liveRawMaterialsToWorkObject([]);
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function installBrowserLocation(search: string) {
  const location = {
    pathname: '/',
    search,
    hash: '#stock',
  };
  const replaceState = vi.fn((_state: unknown, _title: string, nextUrl?: string | URL | null) => {
    if (!nextUrl) return;
    const parsed = new URL(String(nextUrl), 'http://warehouse.test');
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  });
  vi.stubGlobal('window', {
    location,
    history: { state: { preserved: true }, replaceState },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return { location, replaceState };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WarehouseFinishedStockPanel', () => {
  it('renders the available reserve as a compact table with the full inventory total', async () => {
    const page: WarehouseFinishedStockPage = {
      ...stockPage,
      items: [
        {
          ...stockPage.items[0],
          recipe: 'Антиблок · антиблок',
          specification: 'Полотно · 80 мкм · Тонкая',
        },
      ],
      summary: { totalCount: 26, totalWeightKg: 1_024.5, pageCount: 1, pageWeightKg: 40.25 },
      nextCursor: null,
    };
    const fetchPage = vi.fn(async () => page);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseFinishedStockPanel fetchPage={fetchPage} />);
      await flush();
    });

    const text = nodeText(renderer.root);
    const headers = renderer.root
      .findAllByProps({ role: 'columnheader' })
      .map((header) => nodeText(header));
    const ageHeader = renderer.root.findAllByProps({ role: 'columnheader' }).at(-1);

    expect(text).not.toContain('Рулоны на складе. Резерв назначается системой из заказа.');
    expect(text).not.toContain('Доступность');
    expect(text).not.toContain('Заказ');
    expect(text).not.toContain('Статус');
    expect(text).toContain('Всего1 024,5 кг');
    expect(text).not.toContain('На странице');
    expect(headers).toEqual(['Рулон / партия', 'Вес', 'Рецептура / параметры', 'Возраст']);
    expect(ageHeader?.props.className).toContain('warehouse-finished-stock-cell-age');
    expect(text.match(/Антиблок/gu)).toHaveLength(1);
  });

  it('adds one used-on date column for processed reserve rolls', async () => {
    const fetchPage = vi.fn(async (query: WarehouseFinishedStockQuery) =>
      query.bucket === 'processed'
        ? {
            ...stockPage,
            items: [{ ...stockPage.items[0], processedAt: '2026-08-06T08:00:00.000Z' }],
            nextCursor: null,
          }
        : stockPage,
    );
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseFinishedStockPanel fetchPage={fetchPage} />);
      await flush();
    });
    await act(async () => {
      renderer.root
        .findAllByProps({ role: 'tab' })
        .find((tab) => nodeText(tab) === 'Обработанные')
        ?.props.onClick();
      await flush();
    });

    const headers = renderer.root
      .findAllByProps({ role: 'columnheader' })
      .map((header) => nodeText(header));
    const text = nodeText(renderer.root);

    expect(headers).toEqual([
      'Рулон / партия',
      'Вес',
      'Рецептура / параметры',
      'Возраст',
      'Использован',
    ]);
    expect(text.match(/Использован/gu)).toHaveLength(1);
    expect(text).toContain('06.08.2026');
  });

  it('loads the available bucket by default and exposes an accessible lifecycle tab panel', async () => {
    const fetchPage = vi.fn(async () => stockPage);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseFinishedStockPanel fetchPage={fetchPage} />);
      await flush();
    });

    const tabList = renderer.root.findByProps({ role: 'tablist' });
    const availableTab = renderer.root.findByProps({ role: 'tab', 'aria-selected': true });
    const panel = renderer.root.findByProps({ role: 'tabpanel' });
    expect(nodeText(tabList)).toContain('Доступные');
    expect(nodeText(availableTab)).toBe('Доступные');
    expect(availableTab.props['aria-controls']).toBe(panel.props.id);
    expect(panel.props['aria-labelledby']).toBe(availableTab.props.id);
    expect(fetchPage).toHaveBeenCalledWith(
      { bucket: 'available', limit: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('switches to processed with retained text filters and a reset cursor history', async () => {
    const fetchPage = vi.fn(async () => stockPage);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseFinishedStockPanel fetchPage={fetchPage} />);
      await flush();
    });
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Поиск готовой продукции' }).props.onChange({
        target: { value: 'R-STOCK-001' },
      });
      renderer.root.findByProps({ 'aria-label': 'Партия' }).props.onChange({
        target: { value: 'STOCK-S-17' },
      });
      renderer.root.findByProps({ 'aria-label': 'Возраст от, дней' }).props.onChange({
        target: { value: '3' },
      });
      renderer.root.findByProps({ 'aria-label': 'Возраст до, дней' }).props.onChange({
        target: { value: '10' },
      });
      await flush();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((item) => nodeText(item) === 'Далее')
        ?.props.onClick();
      await flush();
    });

    await act(async () => {
      renderer.root
        .findAllByProps({ role: 'tab' })
        .find((tab) => nodeText(tab) === 'Обработанные')
        ?.props.onClick();
      await flush();
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      {
        bucket: 'processed',
        q: 'R-STOCK-001',
        batch: 'STOCK-S-17',
        minAgeDays: 3,
        maxAgeDays: 10,
        limit: 25,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      renderer.root.findAllByType('button').find((item) => nodeText(item) === 'Назад')?.props
        .disabled,
    ).toBe(true);
  });

  it('clears available rows and ignores their late response after switching to processed', async () => {
    const initialAvailable = deferred<WarehouseFinishedStockPage>();
    const lateAvailable = deferred<WarehouseFinishedStockPage>();
    const processed = deferred<WarehouseFinishedStockPage>();
    const availableRequests = [initialAvailable, lateAvailable];
    const fetchPage = vi.fn(
      (query: WarehouseFinishedStockQuery, _options?: { signal?: AbortSignal }) =>
        query.bucket === 'processed' ? processed.promise : availableRequests.shift()!.promise,
    );
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseFinishedStockPanel fetchPage={fetchPage} />);
      await flush();
    });
    await act(async () => {
      initialAvailable.resolve(stockPage);
      await flush();
    });
    expect(nodeText(renderer.root)).toContain('R-STOCK-001');

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Поиск готовой продукции' }).props.onChange({
        target: { value: 'pending-available' },
      });
      await flush();
    });

    await act(async () => {
      renderer.root
        .findAllByProps({ role: 'tab' })
        .find((tab) => nodeText(tab) === 'Обработанные')
        ?.props.onClick();
      await flush();
    });
    expect(nodeText(renderer.root)).not.toContain('R-STOCK-001');
    expect(
      (fetchPage.mock.calls[1]?.[1] as { signal?: AbortSignal } | undefined)?.signal?.aborted,
    ).toBe(true);

    await act(async () => {
      lateAvailable.resolve(stockPage);
      await flush();
    });
    expect(nodeText(renderer.root)).not.toContain('R-STOCK-001');

    await act(async () => {
      processed.resolve({
        ...stockPage,
        items: [
          {
            ...stockPage.items[0],
            rollCode: 'PROCESSED-001',
            processedAt: '2026-08-06T08:00:00.000Z',
          },
        ],
      });
      await flush();
    });
    expect(nodeText(renderer.root)).toContain('PROCESSED-001');
  });

  it('keeps the processed bucket for retry and uses its distinct empty state', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(stockPage)
      .mockRejectedValueOnce(new Error('Сеть недоступна'))
      .mockResolvedValueOnce({
        ...stockPage,
        items: [],
        summary: { totalCount: 0, totalWeightKg: 0, pageCount: 0, pageWeightKg: 0 },
        nextCursor: null,
      });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseFinishedStockPanel fetchPage={fetchPage} />);
      await flush();
    });
    await act(async () => {
      renderer.root
        .findAllByProps({ role: 'tab' })
        .find((tab) => nodeText(tab) === 'Обработанные')
        ?.props.onClick();
      await flush();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((item) => nodeText(item) === 'Повторить')
        ?.props.onClick();
      await flush();
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      { bucket: 'processed', limit: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(nodeText(renderer.root)).toContain('Обработанных рулонов нет');
  });

  it('offers platform roll creation only with the dedicated effective capability', async () => {
    installBrowserLocation('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => inventoryPage,
      })),
    );
    const catalog = {
      materials: [{ id: 'material-primary', name: 'ПВД первичный', kind: 'base' as const }],
      recipes: [],
      status: 'ready' as const,
      error: null,
      reload: vi.fn(async () => undefined),
      createRecipe: vi.fn(),
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseInventoryDashboard
          object={liveInventory()}
          activeSection="Запасы и сырьё"
          finishedStockEnabled
          materialRecipeCatalog={catalog}
          effectiveCapabilities={[]}
        />,
      );
      await flush();
    });

    expect(nodeText(renderer.root)).not.toContain('+ Добавить рулон');

    await act(async () => {
      renderer.update(
        <WarehouseInventoryDashboard
          object={liveInventory()}
          activeSection="Запасы и сырьё"
          finishedStockEnabled
          materialRecipeCatalog={catalog}
          effectiveCapabilities={['reserve_roll:create']}
        />,
      );
      await flush();
    });
    const createButton = renderer.root
      .findAllByType('button')
      .find((button) => nodeText(button).includes('+ Добавить рулон'));
    expect(createButton).toBeDefined();

    await act(async () => {
      createButton?.props.onClick();
    });
    expect(renderer.root.findByProps({ 'aria-label': 'Код рулона' })).toBeDefined();
  });

  it('loads the safe finished-stock projection independently of the selected fixture object', async () => {
    installBrowserLocation('?view=processed');
    const rawObject = warehouseWorkObjects.find((item) => item.id === 'WH-INV-RAW');
    if (!rawObject) throw new Error('WH-INV-RAW fixture is missing');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => inventoryPage,
    }));
    vi.stubGlobal('fetch', fetchMock);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseInventoryDashboard
          object={rawObject}
          activeSection="Запасы и сырьё"
          finishedStockEnabled
        />,
      );
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/inventory/rolls?view=processed&sort=receivedAt&direction=desc&limit=25',
      expect.objectContaining({ method: 'GET' }),
    );
    const text = nodeText(renderer.root);
    expect(text).toContain('История обработанных рулонов');
    expect(text).toContain('R-STOCK-001');
    expect(text).toContain('Свободный резерв');
    expect(text).toContain('Выдан');
    expect(text).toContain('Маршрут завершён');
    expect(text).not.toMatch(/Зарезервировать|Резервировать рулон|Выбрать для заказа/u);
  });

  it('sends the processed bucket with code, recipe, batch, and age filters to the server', async () => {
    installBrowserLocation('?view=processed');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => inventoryPage,
    }));
    vi.stubGlobal('fetch', fetchMock);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseInventoryDashboard
          object={liveInventory()}
          activeSection="Запасы и сырьё"
          finishedStockEnabled
        />,
      );
      await flush();
    });

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Поиск рулонов' }).props.onChange({
        currentTarget: { value: 'ПВД 70/30' },
      });
      renderer.root.findByProps({ 'aria-label': 'Партия' }).props.onChange({
        currentTarget: { value: 'STOCK-S-17' },
      });
      renderer.root.findByProps({ 'aria-label': 'Возраст от, дней' }).props.onChange({
        currentTarget: { value: '3' },
      });
      renderer.root.findByProps({ 'aria-label': 'Возраст до, дней' }).props.onChange({
        currentTarget: { value: '10' },
      });
      await flush();
    });

    const lastCall = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(String(lastCall[0])).toBe(
      '/api/warehouse/inventory/rolls?view=processed&q=%D0%9F%D0%92%D0%94+70%2F30&batch=STOCK-S-17&minAgeDays=3&maxAgeDays=10&sort=receivedAt&direction=desc&limit=25',
    );
  });

  it('uses a compact empty state without pagination space', async () => {
    installBrowserLocation('?view=processed');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          items: [],
          nextCursor: null,
        }),
      })),
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseInventoryDashboard
          object={liveInventory()}
          activeSection="Запасы и сырьё"
          finishedStockEnabled
        />,
      );
      await flush();
    });

    const text = nodeText(renderer.root);
    expect(text).toContain('Обработанные рулоны не найдены');
    expect(text).not.toContain('Стр. 1/1');
    expect(renderer.root.findAllByProps({ 'aria-label': 'Пагинация готовой продукции' })).toEqual(
      [],
    );
  });

  it('hydrates every finished-stock filter from the URL before the first request', async () => {
    installBrowserLocation(
      `?role=warehouse&section=${encodeURIComponent('Запасы / резерв')}&q=${encodeURIComponent(
        'ПВД 70/30',
      )}&batch=STOCK-S-17&minAgeDays=3&maxAgeDays=10`,
    );
    const fetchMock = vi.fn(async () => stockPage);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseFinishedStockPanel fetchPage={fetchMock} />);
      await flush();
    });

    expect(renderer.root.findByProps({ 'aria-label': 'Поиск готовой продукции' }).props.value).toBe(
      'ПВД 70/30',
    );
    expect(renderer.root.findByProps({ 'aria-label': 'Партия' }).props.value).toBe('STOCK-S-17');
    expect(renderer.root.findByProps({ 'aria-label': 'Возраст от, дней' }).props.value).toBe('3');
    expect(renderer.root.findByProps({ 'aria-label': 'Возраст до, дней' }).props.value).toBe('10');
    expect(fetchMock).toHaveBeenCalledWith(
      {
        bucket: 'available',
        q: 'ПВД 70/30',
        batch: 'STOCK-S-17',
        minAgeDays: 3,
        maxAgeDays: 10,
        limit: 25,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('updates owned URL filters without a reload or loss of unrelated query params', async () => {
    const { replaceState } = installBrowserLocation(
      `?role=warehouse&section=${encodeURIComponent('Запасы / резерв')}&object=WH-INV-RAW&keep=1`,
    );
    const fetchMock = vi.fn(async () => stockPage);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<WarehouseFinishedStockPanel fetchPage={fetchMock} />);
      await flush();
    });

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Поиск готовой продукции' }).props.onChange({
        target: { value: 'R-STOCK-001' },
      });
      renderer.root.findByProps({ 'aria-label': 'Партия' }).props.onChange({
        target: { value: 'STOCK-S-17' },
      });
      renderer.root.findByProps({ 'aria-label': 'Возраст от, дней' }).props.onChange({
        target: { value: '2' },
      });
      renderer.root.findByProps({ 'aria-label': 'Возраст до, дней' }).props.onChange({
        target: { value: '12' },
      });
      await flush();
    });

    expect(replaceState).toHaveBeenCalled();
    const nextUrl = new URL(String(replaceState.mock.calls.at(-1)?.[2]), 'http://warehouse.test');
    expect(nextUrl.searchParams.get('role')).toBe('warehouse');
    expect(nextUrl.searchParams.get('section')).toBe('Запасы / резерв');
    expect(nextUrl.searchParams.get('object')).toBe('WH-INV-RAW');
    expect(nextUrl.searchParams.get('keep')).toBe('1');
    expect(nextUrl.searchParams.get('q')).toBe('R-STOCK-001');
    expect(nextUrl.searchParams.get('batch')).toBe('STOCK-S-17');
    expect(nextUrl.searchParams.get('minAgeDays')).toBe('2');
    expect(nextUrl.searchParams.get('maxAgeDays')).toBe('12');
    expect(nextUrl.searchParams.get('availability')).toBeNull();
    expect(nextUrl.hash).toBe('#stock');
  });
});
