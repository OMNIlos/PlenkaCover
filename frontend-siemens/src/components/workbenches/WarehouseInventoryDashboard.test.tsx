import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RawMaterialCatalogItem, RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import { warehouseWorkObjects } from '../../domain/fixtures/warehouse';
import { liveRawMaterialsToWorkObject } from '../../api/warehouse';
import { buildWarehouseInventoryDashboard } from '../../domain/warehouseInventoryDashboard';
import type { WarehouseCoverFreeRoll, WarehouseCoverTask } from '../../domain/types';
import type { MaterialRecipeCatalog } from '../../features/recipes/useMaterialRecipeCatalog';
import {
  composeWarehouseRawMaterialReceiptReason,
  runWarehouseRawMaterialAdjustment,
  runWarehouseRawMaterialReceipt,
  shouldShowWarehouseRawMaterialReceiptValidation,
  warehouseRawMaterialReceiptValidationError,
  WarehouseInventoryDashboard,
} from './WarehouseInventoryDashboard';

const componentSource = readFileSync(
  new URL('./WarehouseInventoryDashboard.tsx', import.meta.url),
  'utf8',
);

type WarehouseRecipeCatalogFixture = Pick<
  MaterialRecipeCatalog,
  'materials' | 'recipes' | 'status' | 'error' | 'reload' | 'createRecipe'
>;

const recipeMaterials: RawMaterialCatalogItem[] = [
  { id: 'material-primary', name: 'Первичное', kind: 'base' },
  { id: 'material-secondary', name: 'Вторичное', kind: 'base' },
];
const recipeCreateCapabilities = ['recipe_catalog:create'] as const;
const bigBagCreateCapabilities = ['bigbag:create'] as const;

const createdRecipe: RecipeCatalogItem = {
  id: 'recipe-warehouse-1',
  name: 'Складская смесь',
  version: {
    id: 'recipe-warehouse-version-1',
    version: 1,
    ingredients: [
      {
        rawMaterialDefinitionId: 'material-primary',
        name: 'Первичное',
        shareBasisPoints: 10_000,
      },
    ],
  },
};

function recipeCatalog(
  overrides: Partial<WarehouseRecipeCatalogFixture> = {},
): WarehouseRecipeCatalogFixture {
  return {
    materials: recipeMaterials,
    recipes: [createdRecipe],
    status: 'ready',
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    createRecipe: vi.fn().mockResolvedValue(createdRecipe),
    ...overrides,
  };
}

function liveRawInventory(rowCount = 1) {
  return liveRawMaterialsToWorkObject(
    Array.from({ length: rowCount }, (_, index) => ({
      id: `server-stock-${index + 1}`,
      rawMaterialId: `server-material-${index + 1}`,
      label: `Материал ${String(index + 1).padStart(2, '0')}`,
      materialKind: 'primary' as const,
      qty: 125 + index,
      actualQty: 125 + index,
      unit: 'кг',
      source: 'warehouse_fact' as const,
      sourceOfTruthStatus: 'актуально' as const,
      updatedAt: '2026-07-17T08:00:00.000Z',
    })),
  );
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

function reserveLifecycleTab(root: ReactTestInstance, label: string) {
  const tab = root
    .findAllByProps({ role: 'tab' })
    .find((candidate) => nodeText(candidate) === label);
  if (!tab) throw new Error(`Reserve lifecycle tab not found: ${label}`);
  return tab;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

function filterButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root
    .findAllByProps({ role: 'radio' })
    .find((candidate) => nodeText(candidate).startsWith(label));
  if (!found) throw new Error(`Filter button not found: ${label}`);
  return found;
}

function inputByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const labelNode = root
    .findAllByType('label')
    .find((candidate) => nodeText(candidate).includes(label));
  if (!labelNode) throw new Error(`Label not found: ${label}`);
  return labelNode.findByType('input');
}

function selectByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const labelNode = root
    .findAllByType('label')
    .find((candidate) => nodeText(candidate).includes(label));
  if (!labelNode) throw new Error(`Label not found: ${label}`);
  return labelNode.findByType('select');
}

function makeRecipeValid(root: ReactTestInstance, name = 'Складская смесь') {
  act(() => {
    inputByLabel(root, 'Название рецептуры').props.onChange({
      currentTarget: { value: name },
    });
    selectByLabel(root, 'Сырье').props.onChange({
      currentTarget: { value: 'material-primary' },
    });
  });
}

const coverTask: WarehouseCoverTask = {
  caseId: 'case-1',
  orderId: 'order-1',
  orderNumber: 'A-1001',
  customerAlias: 'Клиент 12',
  state: 'open',
  requestedAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:05:00.000Z',
  positions: [
    {
      id: 'position-1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      rawMaterialId: 'rm-pvd',
      spoolType: 'Шпуля 76 мм',
      birka: 'ГОСТ',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'not_checked',
    },
  ],
};

describe('WarehouseInventoryDashboard reserve lifecycle URL', () => {
  it('honors the legacy reserve alias only when stockBucket explicitly selects processed', () => {
    installBrowserLocation(
      `?section=${encodeURIComponent('Запасы / резерв')}&stockBucket=processed`,
    );
    const processed = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Запасы и сырьё"
        finishedStockEnabled
      />,
    );

    installBrowserLocation(`?section=${encodeURIComponent('Запасы / резерв')}`);
    const rolls = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Запасы и сырьё"
        finishedStockEnabled
      />,
    );

    expect(processed).toContain('История обработанных рулонов');
    expect(processed).toMatch(/warehouse-stock-tab-processed[^>]*aria-selected="true"/u);
    expect(rolls).toContain('Рулоны на складе');
    expect(rolls).toMatch(/warehouse-stock-tab-current[^>]*aria-selected="true"/u);
    expect(rolls).not.toContain('warehouse-finished-stock');
  });

  it('hydrates only the canonical processed view and fails an unknown value closed to rolls', () => {
    installBrowserLocation('?view=processed&tab=finished-stock&foo=bar');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [],
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseInventoryDashboard
          object={liveRawInventory()}
          activeSection="Запасы и сырьё"
          finishedStockEnabled
        />,
      );
    });

    expect(reserveLifecycleTab(renderer.root, 'Обработанные').props['aria-selected']).toBe(true);

    renderer.unmount();
    installBrowserLocation('?view=unknown&tab=finished-stock');
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseInventoryDashboard
          object={liveRawInventory()}
          activeSection="Запасы и сырьё"
          finishedStockEnabled
        />,
      );
    });

    expect(renderer.root.findAllByProps({ role: 'tab' })).toHaveLength(2);
    expect(reserveLifecycleTab(renderer.root, 'Рулоны').props['aria-selected']).toBe(true);
    expect(nodeText(renderer.root)).toContain('Рулоны на складе');
  });

  it('replaces the processed view, removes legacy stock params and preserves unrelated params', () => {
    const { location, replaceState } = installBrowserLocation(
      '?view=processed&stockBucket=processed&availability=available&tab=finished-stock&foo=bar',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [],
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <WarehouseInventoryDashboard
          object={liveRawInventory()}
          activeSection="Запасы и сырьё"
          finishedStockEnabled
        />,
      );
    });
    act(() => reserveLifecycleTab(renderer.root, 'Рулоны').props.onClick());

    expect(replaceState).toHaveBeenCalledOnce();
    expect(location.search).not.toContain('view=');
    expect(location.search).not.toContain('stockBucket=');
    expect(location.search).toContain('tab=finished-stock');
    expect(location.search).toContain('foo=bar');
    expect(location.search).not.toContain('availability=');
  });
});

describe('WarehouseInventoryDashboard heading', () => {
  it('uses the shared business Big-Bag register above visible warehouse controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const requestPath = typeof input === 'string' ? input : input.toString();
        const body = requestPath.startsWith('/api/raw-materials/big-bags?')
          ? {
              items: [
                {
                  id: 'host-bag-1',
                  code: 'BB-HOST-001',
                  material: 'ПВД 10803-020',
                  batch: 'HOST-77',
                  createdAt: '2026-08-08T06:30:00.000Z',
                  status: 'available',
                  location: { kind: 'warehouse', postCode: null, postName: null },
                  operatorName: null,
                  currentWeightKg: 249.5,
                  totalKopecks: 623_750,
                },
              ],
              page: 1,
              pageSize: 25,
              total: 1,
            }
          : [];
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseInventoryDashboard
          object={liveRawInventory()}
          activeSection="Сырье"
          effectiveCapabilities={[
            'bigbag:create',
            'warehouse_task:read',
            'bigbag:move',
            'bigbag:print',
          ]}
          onCreateBigBag={vi.fn().mockResolvedValue(true)}
          materialRecipeCatalog={recipeCatalog()}
        />,
      );
    });

    const register = renderer.root.findByProps({ 'aria-label': 'Реестр Big-Bag' });
    expect(register.findAllByType('th').map(nodeText)).toEqual([
      'Название Big-Bag',
      'Сырьё',
      'Дата создания',
      'Статус',
      'Оператор',
      'Текущий вес',
      'Денежный эквивалент',
    ]);
    const registerContent = nodeText(register);
    expect(registerContent).toContain('BB-HOST-001');
    expect(registerContent).toContain('ПВД 10803-020');
    expect(registerContent).toContain('На складе');
    expect(register.findByProps({ 'data-label': 'Оператор' }).children).toEqual(['—']);
    expect(registerContent).toContain('249,5 кг');
    expect(register.findByProps({ 'data-label': 'Денежный эквивалент' })).toBeDefined();
    expect(registerContent).not.toContain('Партия HOST-77');
    expect(registerContent).not.toContain('Где находится');
    expect(registerContent).not.toMatch(/Подтвердить сканирование|Печать QR-этикетки|Создать/u);

    const hostContent = nodeText(renderer.root);
    expect(hostContent).toContain('+ Создать Big-Bag');
    expect(hostContent).toContain('Подтвердить сканирование');
    expect(hostContent).toContain('Печать QR-этикетки');
  });

  it('maps only explicitly fetched safe rolls into truthful live category counts', () => {
    const liveObject = liveRawMaterialsToWorkObject([
      {
        id: 'server-stock-1',
        rawMaterialId: 'server-material-1',
        label: 'ПВД с сервера',
        materialKind: 'primary',
        qty: 125,
        actualQty: 125,
        unit: 'кг',
        source: 'warehouse_fact',
        sourceOfTruthStatus: 'актуально',
        updatedAt: '2026-07-17T08:00:00.000Z',
      },
      {
        id: 'server-stock-2',
        rawMaterialId: 'server-material-2',
        label: 'ПНД с сервера',
        materialKind: 'primary',
        qty: 80,
        actualQty: 80,
        unit: 'кг',
        source: 'warehouse_fact',
        sourceOfTruthStatus: 'актуально',
        updatedAt: '2026-07-17T08:00:00.000Z',
      },
    ]);
    const freeRolls: WarehouseCoverFreeRoll[] = [
      {
        id: 'server-roll-1',
        rollCode: 'R-LIVE-001',
        warehouseStatus: 'received',
        facts: {
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          birka: 'ГОСТ',
          spoolType: '76 мм',
          plannedWeightKg: 41.2,
        },
      },
    ];

    const dashboard = buildWarehouseInventoryDashboard(liveObject, freeRolls);
    const counts = Object.fromEntries(
      dashboard.categories.map((category) => [category.id, category.rows.length]),
    );
    const roll = dashboard.categories.find((category) => category.id === 'rolls')?.rows[0];

    expect(counts).toEqual({ raw: 2, rolls: 1, reserve: 0, consumables: 0, movements: 0 });
    expect(roll).toEqual(
      expect.objectContaining({
        id: 'server-roll-1',
        title: 'R-LIVE-001',
        subtitle: 'Без заказчика',
        characteristic: 'Рукав · 80 мкм',
        secondaryQty: '41.2 кг',
        actions: [],
      }),
    );
    expect(JSON.stringify(roll)).not.toMatch(/rawPayload|positionSnapshot|sourceVersion/u);

    const demoObject = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-INV-RAW');
    if (!demoObject) throw new Error('WH-INV-RAW fixture is missing');
    const demoRolls = buildWarehouseInventoryDashboard(demoObject, freeRolls).categories.find(
      (category) => category.id === 'rolls',
    )?.rows;
    expect(demoRolls?.length).toBeGreaterThan(0);
    expect(demoRolls?.some((row) => row.id === 'server-roll-1')).toBe(false);
  });

  it('does not mix demo roll, reserve, consumable, or movement rows into live inventory', () => {
    const liveObject = liveRawMaterialsToWorkObject([
      {
        id: 'server-stock-1',
        rawMaterialId: 'server-material-1',
        label: 'ПВД с сервера',
        materialKind: 'primary',
        qty: 125,
        actualQty: 125,
        unit: 'кг',
        source: 'warehouse_fact',
        sourceOfTruthStatus: 'актуально',
        updatedAt: '2026-07-17T08:00:00.000Z',
      },
    ]);

    const dashboard = buildWarehouseInventoryDashboard(liveObject);
    expect(dashboard.categories.find((category) => category.id === 'raw')?.rows).toHaveLength(1);
    expect(
      dashboard.categories
        .filter((category) => category.id !== 'raw')
        .flatMap((category) => category.rows),
    ).toEqual([]);
    expect(JSON.stringify(dashboard)).not.toMatch(/WH-INV-RAW|A-17|WH-2606-044/u);
  });

  it('keeps accounting projections outside the roll-only reserve section', () => {
    installBrowserLocation('?view=processed');
    const object = liveRawInventory();
    const raw = renderToStaticMarkup(
      <WarehouseInventoryDashboard object={object} activeSection="Сырье" />,
    );
    const reserve = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={object}
        activeSection="Запасы и сырьё"
        finishedStockEnabled
      />,
    );
    const consumables = renderToStaticMarkup(
      <WarehouseInventoryDashboard object={object} activeSection="Расходники" />,
    );
    const movements = renderToStaticMarkup(
      <WarehouseInventoryDashboard object={object} activeSection="Движения" />,
    );

    expect(raw).not.toContain('aria-label="Сырье: серверная проекция"');
    expect(raw).not.toContain('Физический факт ERP и операции');
    expect(reserve).toContain('История обработанных рулонов');
    expect(reserve).not.toContain('Учетный остаток 1С');
    expect(consumables).toContain('Расходники');
    expect(consumables).not.toContain('1С');
    expect(movements).toContain('Движения');
    expect(movements).not.toContain('1С');
  });

  it('shows one read-only QR inspector for both physical object types when scan is allowed', () => {
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Сырье"
        effectiveCapabilities={['warehouse:scan']}
      />,
    );

    expect(html).toContain('aria-label="Проверка QR"');
    expect(html).toContain('QR-код рулона, палеты или Big-Bag');
    expect(html).toContain('без приёмки и перемещения');
    expect(html).not.toContain('Подтвердить сканирование');
  });

  it('uses the server-owned stock workspace instead of the legacy physical-roll empty projection', () => {
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Запасы и сырьё"
        coverFreeRolls={[]}
        finishedStockEnabled
      />,
    );

    expect(html).toContain('Рулоны на складе');
    expect(html).toContain('Загрузка рулонов');
    expect(html).not.toContain('Физические рулоны пока не приняты');
    expect(html).not.toContain('Измените поиск или сбросьте фильтры');
  });

  it('never falls back to demo reserve rows when the live finished-stock panel is disabled', () => {
    installBrowserLocation('?view=processed');
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Запасы и сырьё"
        finishedStockEnabled={false}
      />,
    );

    expect(html).toContain('Все рулоны временно недоступны');
    expect(html).not.toContain('Учетный остаток 1С');
    expect(html).not.toContain('Подготовить резерв З-2606-019');
  });

  it('does not repeat the page title or the raw-material object title above the inventory table', () => {
    const object = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-INV-RAW');
    if (!object) throw new Error('WH-INV-RAW fixture is missing');

    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={object}
        activeSection="Запасы и сырьё"
        finishedStockEnabled
      />,
    );

    expect(html).not.toContain('warehouse-inventory-object-context');
    expect(html).not.toContain('<h3>Сырье и резерв</h3>');
    expect(html).toContain('Рулоны на складе');
  });

  it('does not repeat the raw-material heading in the fixture route', () => {
    const object = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-INV-RAW');
    if (!object) throw new Error('WH-INV-RAW fixture is missing');

    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard object={object} activeSection="Сырье" />,
    );

    expect(html).not.toContain('<strong>Сырье</strong>');
    expect(html).not.toContain('<h2>Сырье</h2>');
  });

  it('never renders fixture raw rows in Запасы / резерв', () => {
    installBrowserLocation('?view=processed');
    const rawObject = warehouseWorkObjects.find((item) => item.id === 'WH-INV-RAW');
    if (!rawObject) throw new Error('WH-INV-RAW fixture is missing');
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={rawObject}
        activeSection="Запасы и сырьё"
        coverTasks={[coverTask]}
        coverFreeRolls={[]}
        finishedStockEnabled
      />,
    );

    expect(html).toContain('История обработанных рулонов');
    expect(html).not.toContain('Проверки покрытия заказов');
    expect(html).not.toContain('warehouse-finished-stock');
    expect(html).not.toContain('warehouse-inventory-layout');
    expect(html).not.toMatch(/Гранула|Сырье и резерв|Принять сырьё/u);
  });

  it('shows an explicit unavailable reserve state instead of raw rows when live stock is disabled', () => {
    installBrowserLocation('?view=processed');
    const rawObject = warehouseWorkObjects.find((item) => item.id === 'WH-INV-RAW');
    if (!rawObject) throw new Error('WH-INV-RAW fixture is missing');
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={rawObject}
        activeSection="Запасы и сырьё"
        coverTasks={[]}
        coverFreeRolls={[]}
        finishedStockEnabled={false}
      />,
    );

    expect(html).toContain('Все рулоны временно недоступны');
    expect(html).not.toContain('warehouse-inventory-layout');
    expect(html).not.toMatch(/Гранула|Принять сырьё/u);
  });

  it('keeps raw materials and Big-Bag actions in Сырье', () => {
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Сырье"
        onCreateBigBag={vi.fn()}
      />,
    );
    expect(html).toContain('warehouse-inventory-layout');
    expect(html).toContain('Сырье');
    expect(html).not.toContain('warehouse-finished-stock');
  });

  it('renders one raw-material workspace without duplicate search or architecture narration', () => {
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Сырье"
        effectiveCapabilities={['warehouse_task:read', 'bigbag:move', 'bigbag:print']}
      />,
    );

    expect(html.match(/placeholder="Поиск"/gu)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Поиск сырья"');
    expect(html).not.toContain('<h2>Сырье</h2>');
    expect(html).not.toContain('<strong>Сырье</strong>');
    expect(html).not.toMatch(
      /Операционный контур склада|Физический факт ERP и операции|Корректировки и приходы ниже/u,
    );
    expect(html).toContain('aria-label="Реестр Big-Bag"');
    expect(html).toContain('aria-label="Фильтр Big-Bag"');
  });

  it('keeps coverage checks reachable beside the unified stock workspace', () => {
    installBrowserLocation('?view=processed');
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Запасы и сырьё"
        coverTasks={[coverTask]}
        coverFreeRolls={[]}
        onCoverPropose={vi.fn()}
        onCoverRefresh={vi.fn()}
        finishedStockEnabled
      />,
    );

    expect(html).toContain('warehouse-stock-workspace');
    expect(html).toContain('aria-label="Проверки покрытия заказов"');
    expect(html).not.toContain('warehouse-finished-stock');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
  });

  it('omits meaningless pagination controls when the active inventory category is empty', () => {
    installBrowserLocation('?view=processed');
    const emptyLiveInventory = liveRawMaterialsToWorkObject([]);

    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={emptyLiveInventory}
        activeSection="Запасы и сырьё"
        coverTasks={[]}
        coverFreeRolls={[]}
        finishedStockEnabled
      />,
    );

    expect(html).toContain('История обработанных рулонов');
    expect(html).not.toContain('aria-label="Пагинация таблицы"');
    expect(html).not.toContain('Стр. 1/1');
    expect(html).not.toContain('aria-label="Строк на странице"');
  });

  it('omits pagination when every visible warehouse row fits on one page', () => {
    const object = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-INV-RAW');
    if (!object) throw new Error('WH-INV-RAW fixture is missing');

    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={object}
        activeSection="Запасы и сырьё"
        finishedStockEnabled
      />,
    );

    expect(html).toContain('Рулоны на складе');
    expect(html).not.toContain('aria-label="Пагинация таблицы"');
    expect(html).not.toContain('Стр. 1/1');
    expect(html).not.toContain('aria-label="Строк на странице"');
  });

  it('shows pagination as soon as the desktop page boundary is exceeded', () => {
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard object={liveRawInventory(26)} activeSection="Сырье" />,
    );

    expect(html).toContain('aria-label="Пагинация таблицы"');
    expect(html).toContain('Стр. 1/2');
    expect(html).toContain('aria-label="Строк на странице"');
  });

  it('shows the explicit demo-1C write only when the server-authorized handler is supplied', () => {
    const object = liveRawMaterialsToWorkObject([]);
    const unauthorized = renderToStaticMarkup(
      <WarehouseInventoryDashboard object={object} activeSection="Сырье" />,
    );
    const authorized = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={object}
        activeSection="Сырье"
        onOneCStockPush={vi.fn()}
      />,
    );
    const busy = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={object}
        activeSection="Сырье"
        onOneCStockPush={vi.fn()}
        oneCStockPushBusy
      />,
    );

    expect(unauthorized).not.toContain('Проверить учёт');
    expect(authorized).toContain('Проверить учёт');
    expect(authorized).toContain('проверяет серверную готовность записи');
    expect(busy).toMatch(/disabled=""[^>]*>[^<]*Проверить учёт/u);
  });

  it('keeps live correction without the raw-material receipt shortcut', () => {
    const object = liveRawMaterialsToWorkObject([
      {
        id: 'server-stock-1',
        rawMaterialId: 'server-material-1',
        label: 'ПВД с сервера',
        materialKind: 'primary',
        qty: 125,
        actualQty: 125,
        unit: 'кг',
        source: 'warehouse_fact',
        sourceOfTruthStatus: 'актуально',
        updatedAt: '2026-07-17T08:00:00.000Z',
      },
    ]);

    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={object}
        activeSection="Сырье"
        onAdjustRawMaterial={vi.fn().mockResolvedValue(true)}
        onReceiveRawMaterial={vi.fn().mockResolvedValue(true)}
        onStockMutation={vi.fn()}
      />,
    );

    expect(html).toContain('Корректировать остаток');
    expect(html).not.toContain('+ Приход сырья');
    expect(html).not.toMatch(
      /\+ Новый материал|Оприходовать|>Правка<|\+ Новый рулон|>Сохранить<|>Записать изменение</u,
    );
  });

  it('does not expose a live correction action without the authorized handler', () => {
    const object = liveRawMaterialsToWorkObject([
      {
        id: 'server-stock-1',
        rawMaterialId: 'server-material-1',
        label: 'ПВД с сервера',
        materialKind: 'primary',
        qty: 125,
        actualQty: 125,
        unit: 'кг',
        source: 'warehouse_fact',
        sourceOfTruthStatus: 'актуально',
        updatedAt: '2026-07-17T08:00:00.000Z',
      },
    ]);

    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard object={object} activeSection="Сырье" />,
    );

    expect(html).not.toContain('Корректировать остаток');
    expect(html).not.toMatch(/\+ Новый материал|\+ Приход сырья|>Правка<|>Сохранить</u);
  });

  it('opens Big-Bag creation only in live raw materials with capability and handler', () => {
    const onCreateBigBag = vi.fn().mockResolvedValue(true);
    const renderer = TestRenderer.create(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Сырье"
        effectiveCapabilities={bigBagCreateCapabilities}
        onCreateBigBag={onCreateBigBag}
        materialRecipeCatalog={recipeCatalog()}
      />,
    );

    act(() => button(renderer.root, '+ Создать Big-Bag').props.onClick());

    expect(renderer.root.findByProps({ role: 'dialog' })).toBeDefined();
    expect(nodeText(renderer.root)).toContain('Создать Big-Bag');
    expect(nodeText(renderer.root)).toContain('Материал 01');
  });

  it('hides Big-Bag creation without capability, handler, or the raw-material section', () => {
    const object = liveRawInventory();
    const onCreateBigBag = vi.fn().mockResolvedValue(true);
    const variants = [
      <WarehouseInventoryDashboard
        key="no-capability"
        object={object}
        activeSection="Сырье"
        onCreateBigBag={onCreateBigBag}
      />,
      <WarehouseInventoryDashboard
        key="no-handler"
        object={object}
        activeSection="Сырье"
        effectiveCapabilities={bigBagCreateCapabilities}
      />,
      <WarehouseInventoryDashboard
        key="wrong-section"
        object={object}
        activeSection="Запасы и сырьё"
        effectiveCapabilities={bigBagCreateCapabilities}
        onCreateBigBag={onCreateBigBag}
      />,
    ];

    for (const variant of variants) {
      expect(renderToStaticMarkup(variant)).not.toContain('+ Создать Big-Bag');
    }
  });

  it('mounts spool receipt controls only for the fully capable live raw-material surface', () => {
    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Сырье"
        effectiveCapabilities={['spool_price:manage', 'spool_stock:receive', 'spool_stock:read']}
      />,
    );

    expect(html).toContain('aria-label="Цена и приход шпуль"');
    expect(html).toContain('aria-label="Приход шпуль"');
    expect(html).toContain('Загрузка видов шпуль…');
    const bigBagRegisterStart = html.indexOf('aria-label="Реестр Big-Bag"');
    const priceFormStart = html.indexOf('<section class="warehouse-spool-price-form"');
    expect(bigBagRegisterStart).toBeGreaterThanOrEqual(0);
    expect(priceFormStart).toBeGreaterThan(bigBagRegisterStart);
    expect(html.slice(bigBagRegisterStart, priceFormStart)).toMatch(/<\/section>$/u);
  });

  it('keeps spool receipt controls out of fixtures, other categories, and partial capabilities', () => {
    const demoObject = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-INV-RAW');
    if (!demoObject) throw new Error('WH-INV-RAW fixture is missing');
    const variants = [
      <WarehouseInventoryDashboard
        key="no-capability"
        object={liveRawInventory()}
        activeSection="Сырье"
      />,
      <WarehouseInventoryDashboard
        key="missing-receive"
        object={liveRawInventory()}
        activeSection="Сырье"
        effectiveCapabilities={['spool_price:manage', 'spool_stock:read']}
      />,
      <WarehouseInventoryDashboard
        key="missing-read"
        object={liveRawInventory()}
        activeSection="Сырье"
        effectiveCapabilities={['spool_price:manage', 'spool_stock:receive']}
      />,
      <WarehouseInventoryDashboard
        key="fixture"
        object={demoObject}
        activeSection="Сырье"
        effectiveCapabilities={['spool_price:manage', 'spool_stock:receive', 'spool_stock:read']}
      />,
      <WarehouseInventoryDashboard
        key="other-category"
        object={liveRawInventory()}
        activeSection="Расходники"
        effectiveCapabilities={['spool_price:manage', 'spool_stock:receive', 'spool_stock:read']}
      />,
    ];

    for (const variant of variants) {
      expect(renderToStaticMarkup(variant)).not.toContain('aria-label="Цена и приход шпуль"');
    }
  });

  it('keeps create and row-edit controls without the raw-material receipt shortcut', () => {
    const object = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-INV-RAW');
    if (!object) throw new Error('WH-INV-RAW fixture is missing');

    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={object}
        activeSection="Сырье"
        onStockMutation={vi.fn()}
      />,
    );

    expect(html).toContain('+ Новый материал');
    expect(html).not.toContain('+ Приход сырья');
    expect(html).toContain('>Правка</button>');
  });

  it('guards live correction against duplicate submits before React rerenders', () => {
    expect(componentSource).toContain('const adjustmentInFlightRef = useRef(false);');
    expect(componentSource).toContain('if (adjustmentInFlightRef.current ||');
    expect(componentSource).toContain('adjustmentInFlightRef.current = true;');
    expect(componentSource).toContain('adjustmentInFlightRef.current = false;');
  });

  it('guards live receipts against duplicate submits and keeps the modal on a failed request', () => {
    expect(componentSource).toContain('const receiptInFlightRef = useRef(false);');
    expect(componentSource).toContain(
      'const receiptOperationKeyRef = useRef<string | null>(null);',
    );
    expect(componentSource).toContain('receiptOperationKeyRef.current = createOperationKey();');
    expect(componentSource).toContain('if (receiptInFlightRef.current || receiptBusy) return;');
    expect(componentSource).toContain('receiptInFlightRef.current = true;');
    expect(componentSource).toContain('receiptInFlightRef.current = false;');
    expect(componentSource).toContain('operationKey: receiptOperationKeyRef.current,');
    expect(componentSource).toContain('if (!result.success)');
    expect(componentSource).toContain('setReceiptError(result.error);');
    expect(componentSource).toContain('receiptOperationKeyRef.current = null;');
    expect(componentSource).toContain('setMaterialDialogMode(null);');
  });

  it('uses the backend quantity precision for a live receipt', () => {
    expect(componentSource).toContain('min={isLiveReceiptDialog ? 0.001 : 0}');
    expect(componentSource).toContain(
      "step={isLiveReceiptDialog ? '0.001' : isRolls ? '1' : '0.1'}",
    );
  });

  it('requires an explicit quantity draft while preserving literal zero as valid', () => {
    expect(componentSource).toContain(
      'const hasExplicitManualQty = selectedManualQty.trim().length > 0;',
    );
    expect(componentSource).toMatch(/!adjustmentBusy\s*&&\s*hasExplicitManualQty/u);
  });
});

describe('WarehouseInventoryDashboard recipe creation', () => {
  it.each([
    { status: 'loading' as const, error: null },
    { status: 'error' as const, error: 'Каталог недоступен' },
  ])(
    'keeps the live raw-material trigger visible while the catalog is $status',
    ({ status, error }) => {
      const html = renderToStaticMarkup(
        <WarehouseInventoryDashboard
          object={liveRawInventory()}
          activeSection="Сырье"
          materialRecipeCatalog={recipeCatalog({
            materials: [],
            status,
            error,
          })}
          effectiveCapabilities={recipeCreateCapabilities}
        />,
      );

      expect(html).toContain('>Создать рецептуру</button>');
      expect(html).not.toContain('aria-selected="true"');
    },
  );

  it.each(['Склад рулонов', 'Запасы / резерв', 'Расходники', 'Движения'])(
    'does not expose recipe creation in the live %s category',
    (activeSection) => {
      const html = renderToStaticMarkup(
        <WarehouseInventoryDashboard
          object={liveRawInventory()}
          activeSection={activeSection}
          materialRecipeCatalog={recipeCatalog()}
        />,
      );

      expect(html).not.toContain('Создать рецептуру');
    },
  );

  it('does not expose recipe creation for fixture inventory with the same catalog contract', () => {
    const object = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-INV-RAW');
    if (!object) throw new Error('WH-INV-RAW fixture is missing');

    const html = renderToStaticMarkup(
      <WarehouseInventoryDashboard
        object={object}
        activeSection="Сырье"
        materialRecipeCatalog={recipeCatalog()}
      />,
    );

    expect(html).not.toContain('Создать рецептуру');
  });

  it('opens, retries, and closes the shared editor without requiring a selected row', () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const renderer = TestRenderer.create(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Сырье"
        materialRecipeCatalog={recipeCatalog({
          materials: [],
          status: 'error',
          error: 'Каталог недоступен',
          reload,
        })}
        effectiveCapabilities={recipeCreateCapabilities}
      />,
    );

    expect(renderer.root.findAllByProps({ 'aria-selected': true })).toHaveLength(0);
    act(() => button(renderer.root, 'Создать рецептуру').props.onClick());
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(1);
    expect(nodeText(renderer.root)).toContain('Каталог сырья недоступен.');

    act(() => button(renderer.root, 'Повторить').props.onClick());
    expect(reload).toHaveBeenCalledOnce();

    act(() => button(renderer.root, 'Отмена').props.onClick());
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('saves only through the injected recipe creator and never mutates warehouse stock', async () => {
    const createRecipe = vi.fn().mockResolvedValue(createdRecipe);
    const onAction = vi.fn();
    const onStockMutation = vi.fn();
    const onAdjustRawMaterial = vi.fn().mockResolvedValue(true);
    const onReceiveRawMaterial = vi.fn().mockResolvedValue(true);
    const onCoverPropose = vi.fn().mockResolvedValue(undefined);
    const onCoverRefresh = vi.fn();
    const onOneCStockPush = vi.fn();
    const renderer = TestRenderer.create(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Сырье"
        materialRecipeCatalog={recipeCatalog({ createRecipe })}
        effectiveCapabilities={recipeCreateCapabilities}
        onAction={onAction}
        onStockMutation={onStockMutation}
        onAdjustRawMaterial={onAdjustRawMaterial}
        onReceiveRawMaterial={onReceiveRawMaterial}
        onCoverPropose={onCoverPropose}
        onCoverRefresh={onCoverRefresh}
        onOneCStockPush={onOneCStockPush}
      />,
    );

    act(() => button(renderer.root, 'Создать рецептуру').props.onClick());
    makeRecipeValid(renderer.root);
    await act(async () => {
      button(renderer.root, 'Сохранить рецептуру').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createRecipe).toHaveBeenCalledOnce();
    expect(createRecipe).toHaveBeenCalledWith({
      name: 'Складская смесь',
      ingredients: [
        {
          rawMaterialDefinitionId: 'material-primary',
          shareBasisPoints: 10_000,
        },
      ],
    });
    for (const callback of [
      onAction,
      onStockMutation,
      onAdjustRawMaterial,
      onReceiveRawMaterial,
      onCoverPropose,
      onCoverRefresh,
      onOneCStockPush,
    ]) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('keeps the recipe draft and modal open when creation fails', async () => {
    const createRecipe = vi.fn().mockRejectedValue(new Error('network failed'));
    const renderer = TestRenderer.create(
      <WarehouseInventoryDashboard
        object={liveRawInventory()}
        activeSection="Сырье"
        materialRecipeCatalog={recipeCatalog({ createRecipe })}
        effectiveCapabilities={recipeCreateCapabilities}
      />,
    );

    act(() => button(renderer.root, 'Создать рецептуру').props.onClick());
    makeRecipeValid(renderer.root, 'Рецепт после сбоя');
    await act(async () => {
      button(renderer.root, 'Сохранить рецептуру').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(1);
    expect(inputByLabel(renderer.root, 'Название рецептуры').props.value).toBe('Рецепт после сбоя');
    expect(nodeText(renderer.root)).toContain(
      'Не удалось сохранить рецептуру. Проверьте соединение и повторите.',
    );
  });

  it('preserves search, filter, page, and selection after successful creation', async () => {
    const renderer = TestRenderer.create(
      <WarehouseInventoryDashboard
        object={liveRawInventory(26)}
        activeSection="Сырье"
        materialRecipeCatalog={recipeCatalog()}
        effectiveCapabilities={recipeCreateCapabilities}
      />,
    );

    const search = renderer.root.findByProps({ placeholder: 'Поиск' });
    act(() => search.props.onChange({ target: { value: 'сырье' } }));
    act(() => filterButton(renderer.root, 'Норма').props.onClick());
    const firstVisibleRow = renderer.root.findAllByProps({ role: 'button' })[0];
    if (!firstVisibleRow) throw new Error('Interactive inventory row is missing');
    act(() => firstVisibleRow.props.onClick());
    act(() => button(renderer.root, 'Вперед').props.onClick());

    expect(nodeText(renderer.root)).toContain('Стр. 2/2');
    expect(renderer.root.findAllByProps({ 'aria-label': 'Закрыть позицию склада' })).toHaveLength(
      1,
    );
    expect(nodeText(renderer.root)).toContain('Материал 01');

    act(() => button(renderer.root, 'Создать рецептуру').props.onClick());
    makeRecipeValid(renderer.root);
    await act(async () => {
      button(renderer.root, 'Сохранить рецептуру').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ placeholder: 'Поиск' }).props.value).toBe('сырье');
    expect(filterButton(renderer.root, 'Норма').props['aria-checked']).toBe(true);
    expect(nodeText(renderer.root)).toContain('Стр. 2/2');
    expect(renderer.root.findAllByProps({ 'aria-label': 'Закрыть позицию склада' })).toHaveLength(
      1,
    );
    expect(nodeText(renderer.root)).toContain('Материал 01');
  });
});

describe('runWarehouseRawMaterialAdjustment', () => {
  const input = {
    materialId: 'server-material-1',
    actualQty: 0,
    reason: 'Полный расход',
  };

  it('awaits a successful handler result', async () => {
    let resolveRequest: ((value: boolean) => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const resultPromise = runWarehouseRawMaterialAdjustment(handler, input);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(input);
    expect(settled).toBe(false);

    resolveRequest?.(true);
    await expect(resultPromise).resolves.toEqual({ success: true, error: null });
  });

  it('returns a retryable result when the handler declines the adjustment', async () => {
    await expect(
      runWarehouseRawMaterialAdjustment(vi.fn().mockResolvedValue(false), input),
    ).resolves.toEqual({
      success: false,
      error: 'Остаток не изменён. Повторите попытку.',
    });
  });

  it('turns a rejected request into a retryable error', async () => {
    await expect(
      runWarehouseRawMaterialAdjustment(
        vi.fn().mockRejectedValue(new Error('Сеть недоступна')),
        input,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Сеть недоступна. Повторите попытку.',
    });
  });
});

describe('runWarehouseRawMaterialReceipt', () => {
  const input = {
    materialId: 'server-material-1',
    operationKey: '11111111-1111-4111-8111-111111111111',
    receivedQty: 25,
    reason: 'Накладная № 42',
  };

  it('awaits a successful receipt handler', async () => {
    await expect(
      runWarehouseRawMaterialReceipt(vi.fn().mockResolvedValue(true), input),
    ).resolves.toEqual({ success: true, error: null });
  });

  it('keeps a failed receipt retryable with a clear error', async () => {
    await expect(
      runWarehouseRawMaterialReceipt(
        vi.fn().mockRejectedValue(new Error('Сеть недоступна')),
        input,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Сеть недоступна. Повторите попытку.',
    });
  });

  it('passes the exact same operation key across an uncertain failed retry', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(true);

    await expect(runWarehouseRawMaterialReceipt(handler, input)).resolves.toMatchObject({
      success: false,
    });
    await expect(runWarehouseRawMaterialReceipt(handler, input)).resolves.toEqual({
      success: true,
      error: null,
    });

    expect(handler.mock.calls.map(([payload]) => payload.operationKey)).toEqual([
      input.operationKey,
      input.operationKey,
    ]);
  });
});

describe('warehouse raw-material receipt validation', () => {
  const validDraft = {
    qty: '25.125',
    reason: 'Приход по накладной',
    documentRef: '№ 42',
    comment: 'Проверено кладовщиком',
  };

  it('matches the backend quantity range and precision exactly', () => {
    expect(warehouseRawMaterialReceiptValidationError(validDraft)).toBeNull();
    expect(warehouseRawMaterialReceiptValidationError({ ...validDraft, qty: '0,001' })).toBeNull();
    expect(
      warehouseRawMaterialReceiptValidationError({ ...validDraft, qty: '1000000' }),
    ).toBeNull();

    for (const qty of ['', '0', '0.0001', '1.0001', '1000000.001', '-1', 'NaN']) {
      expect(warehouseRawMaterialReceiptValidationError({ ...validDraft, qty })).toMatch(
        /Количество/u,
      );
    }
  });

  it('validates the exact composed audit reason sent to the backend', () => {
    expect(composeWarehouseRawMaterialReceiptReason(validDraft)).toBe(
      'Приход по накладной · Документ: № 42 · Комментарий: Проверено кладовщиком',
    );
    expect(
      warehouseRawMaterialReceiptValidationError({
        ...validDraft,
        reason: 'Р'.repeat(480),
        documentRef: '1234567890',
      }),
    ).toMatch(/500 знаков/u);
  });

  it('never renders an empty validation alert for a valid receipt', () => {
    expect(shouldShowWarehouseRawMaterialReceiptValidation(null, '0.001')).toBe(false);
    expect(
      shouldShowWarehouseRawMaterialReceiptValidation(
        'Количество: от 0,001 до 1 000 000.',
        '0.0001',
      ),
    ).toBe(true);
  });
});
