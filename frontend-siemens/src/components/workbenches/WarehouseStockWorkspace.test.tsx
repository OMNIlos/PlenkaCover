import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type {
  WarehouseInventoryQuery,
  WarehouseInventoryRollDetail,
  WarehouseInventoryRollItem,
  WarehouseInventoryRollPage,
  WarehouseReserveRoll,
  WarehouseReserveRollCreateInput,
} from '../../api/warehouse';
import { WarehouseStockWorkspace } from './WarehouseStockWorkspace';

const clientRoll: WarehouseInventoryRollItem = {
  id: 'roll-client-1',
  rollCode: 'CLIENT-001',
  origin: 'client',
  lifecycleStatus: 'awaiting_shipment',
  lifecycleStatusLabel: 'Ожидает отгрузки',
  orderNumber: 'ORD-001',
  positionId: 'position-1',
  positionSequence: 1,
  warehouseStatus: 'received',
  warehouseStatusLabel: 'Принят складом',
  nextRoute: 'delivery',
  nextRouteLabel: 'Выдача',
  counterpartyName: 'ООО Контур',
  batchCode: 'BATCH-CLIENT',
  weightKg: 42.25,
  specification: 'Рукав · 80 мкм · 1200 мм',
  receivedAt: '2026-08-06T08:00:00.000Z',
  processedAt: null,
};

const reserveRoll: WarehouseInventoryRollItem = {
  id: 'roll-reserve-1',
  rollCode: 'RESERVE-001',
  origin: 'reserve',
  lifecycleStatus: 'available',
  lifecycleStatusLabel: 'Доступен',
  orderNumber: null,
  positionId: null,
  positionSequence: null,
  warehouseStatus: 'received',
  warehouseStatusLabel: 'Принят складом',
  nextRoute: 'reserve',
  nextRouteLabel: 'Складской резерв',
  counterpartyName: 'Резерв',
  batchCode: 'BATCH-RESERVE',
  weightKg: 38.5,
  specification: 'Полотно · 60 мкм · 900 мм',
  receivedAt: '2026-08-05T08:00:00.000Z',
  processedAt: null,
};

const processedRoll: WarehouseInventoryRollItem = {
  ...reserveRoll,
  id: 'roll-processed-1',
  rollCode: 'PROCESSED-001',
  lifecycleStatus: 'processed',
  lifecycleStatusLabel: 'Обработан',
  processedAt: '2026-08-07T08:00:00.000Z',
};

const clientDetail: WarehouseInventoryRollDetail = {
  ...clientRoll,
  specificationDetails: {
    filmType: 'Рукав',
    actualThicknessMicron: 80,
    accountingThicknessMicron: 78,
    widthMm: 1_200,
    plannedLengthM: 800,
    netKg: 42.25,
    spoolType: 'Тонкая',
    birka: 'ГОСТ',
    recipeName: 'ПВД 70/30',
    ingredients: ['ПВД первичный', 'Антиблок'],
  },
  provenance: {
    kind: 'client_order',
    orderNumber: 'ORD-001',
    batchCode: 'BATCH-CLIENT',
  },
};

const reserveDetail: WarehouseInventoryRollDetail = {
  ...reserveRoll,
  specificationDetails: {
    filmType: 'Полотно',
    actualThicknessMicron: 60,
    accountingThicknessMicron: null,
    widthMm: 900,
    plannedLengthM: null,
    netKg: 38.5,
    spoolType: null,
    birka: null,
    recipeName: null,
    ingredients: [],
  },
  provenance: {
    kind: 'manual',
    orderNumber: null,
    batchCode: 'BATCH-RESERVE',
  },
};

const createdReserveRoll: WarehouseReserveRoll = {
  id: 'roll-created',
  rollCode: 'RES-NEW',
  batchCode: 'BATCH-NEW',
  sourceOrderId: 'order-reserve',
  sourceOrderNumber: 'WR-NEW',
  filmType: 'Рукав',
  actualThicknessMicron: 80,
  accountingThicknessMicron: 78,
  widthMm: 1_200,
  plannedLengthM: 800,
  grossKg: 41.9,
  spoolKg: 0.7,
  netKg: 41.2,
  plannedNetKg: 41,
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
  materialLabel: 'ПВД первичный',
  source: 'platform',
  availability: 'available',
  receivedAt: '2026-08-07T08:00:00.000Z',
  qrReady: true,
};

const materials = [{ id: 'material-primary', name: 'ПВД первичный', kind: 'base' as const }];

function page(
  items: WarehouseInventoryRollItem[],
  nextCursor: string | null = null,
): WarehouseInventoryRollPage {
  return { items, nextCursor };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

async function flush() {
  await Promise.resolve();
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

function button(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
}

function input(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findByProps({ 'aria-label': label });
}

async function renderWorkspace(
  props: Partial<React.ComponentProps<typeof WarehouseStockWorkspace>> = {},
) {
  const fetchPage = vi.fn(async () => page([clientRoll, reserveRoll]));
  const fetchDetail = vi.fn(async (rollId: string) =>
    rollId === clientRoll.id ? clientDetail : reserveDetail,
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <WarehouseStockWorkspace fetchPage={fetchPage} fetchDetail={fetchDetail} {...props} />,
    );
    await flush();
  });
  return { renderer, fetchPage, fetchDetail };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WarehouseStockWorkspace', () => {
  it('renders the canonical counterparty for every client and reserve roll', async () => {
    const { renderer } = await renderWorkspace();
    const table = renderer.root.findByType('table');
    const rows = table.findAllByType('tbody')[0].findAllByType('tr');

    expect(
      table.findAllByType('th').map((header) => nodeText(header).replace(/[↕↑↓]/gu, '')),
    ).toEqual([
      'Код рулона',
      'Заказ',
      'Позиция',
      'Контрагент',
      'Фактический статус',
      'Следующий маршрут',
    ]);
    expect(nodeText(rows.find((row) => nodeText(row).includes('CLIENT-001'))!)).toContain(
      'ООО Контур',
    );
    expect(nodeText(rows.find((row) => nodeText(row).includes('RESERVE-001'))!)).toContain(
      'Резерв',
    );
  });

  it('renders client and reserve facts in one shared server-backed table without totals', async () => {
    const { renderer, fetchPage } = await renderWorkspace();

    expect(renderer.root.findAllByType('table')).toHaveLength(1);
    expect(nodeText(renderer.root)).toContain('CLIENT-001');
    expect(nodeText(renderer.root)).toContain('ORD-001');
    expect(nodeText(renderer.root)).toContain('Позиция 1');
    expect(nodeText(renderer.root)).toContain('Принят складом');
    expect(nodeText(renderer.root)).toContain('Выдача');
    expect(nodeText(renderer.root)).toContain('RESERVE-001');
    expect(nodeText(renderer.root)).toContain('Свободный резерв');
    expect(nodeText(renderer.root)).toContain('Складской резерв');
    expect(nodeText(renderer.root)).toContain('Все рулоны');
    expect(nodeText(renderer.root)).not.toContain('Всего рулонов');
    expect(fetchPage).toHaveBeenCalledWith(
      {
        view: 'current',
        sort: 'receivedAt',
        direction: 'desc',
        limit: 25,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('renders a missing client order as unknown instead of a free reserve', async () => {
    const unknownClient = {
      ...clientRoll,
      id: 'roll-client-unknown-order',
      rollCode: 'CLIENT-UNKNOWN-ORDER',
      orderNumber: null,
    };
    const { renderer } = await renderWorkspace({
      fetchPage: vi.fn(async () => page([unknownClient])),
    });
    const row = renderer.root
      .findAllByType('tr')
      .find((candidate) => nodeText(candidate).includes(unknownClient.rollCode));

    expect(row).toBeDefined();
    expect(nodeText(row!)).toContain('Нет данных');
    expect(nodeText(row!)).not.toContain('Свободный резерв');
  });

  it('sends every filter and only supported sorts to the server', async () => {
    const { renderer, fetchPage } = await renderWorkspace();

    await act(async () => {
      input(renderer, 'Поиск рулонов').props.onChange({ currentTarget: { value: '  CLIENT  ' } });
      input(renderer, 'Партия').props.onChange({ currentTarget: { value: '  BATCH  ' } });
      input(renderer, 'Возраст от, дней').props.onChange({ currentTarget: { value: '2' } });
      input(renderer, 'Возраст до, дней').props.onChange({ currentTarget: { value: '9' } });
      input(renderer, 'Статус').props.onChange({ currentTarget: { value: 'reserved' } });
      input(renderer, 'Контрагент').props.onChange({ currentTarget: { value: '  Контур  ' } });
      await flush();
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      {
        view: 'current',
        q: 'CLIENT',
        batch: 'BATCH',
        minAgeDays: 2,
        maxAgeDays: 9,
        status: 'reserved',
        counterparty: 'Контур',
        sort: 'receivedAt',
        direction: 'desc',
        limit: 25,
      },
      { signal: expect.any(AbortSignal) },
    );

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Сортировать по коду рулона' }).props.onClick();
      await flush();
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'rollCode', direction: 'asc' }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('passes processed as the API view and removes the incompatible status selector', async () => {
    const fetchPage = vi.fn(async (query: WarehouseInventoryQuery) =>
      page(query.view === 'processed' ? [processedRoll] : [reserveRoll]),
    );
    const { renderer } = await renderWorkspace({ fetchPage });
    const currentStatusOptions = input(renderer, 'Статус')
      .findAllByType('option')
      .map((option) => option.props.value);

    expect(currentStatusOptions).toEqual([
      '',
      'awaiting_shipment',
      'available',
      'reserved',
      'defect',
      'delivered',
    ]);
    expect(currentStatusOptions).not.toContain('processed');

    await act(async () => {
      button(renderer, 'Обработанные')?.props.onClick();
      await flush();
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      {
        view: 'processed',
        sort: 'receivedAt',
        direction: 'desc',
        limit: 25,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(renderer.root.findAllByProps({ 'aria-label': 'Статус' })).toHaveLength(0);
    expect(nodeText(renderer.root)).toContain('PROCESSED-001');
    expect(nodeText(renderer.root)).toContain('История обработанных рулонов');
    expect(nodeText(renderer.root)).not.toContain('Рулоны на складе');
  });

  it('waits for its controlled view owner before requesting another view', async () => {
    const fetchPage = vi.fn(async () => page([reserveRoll]));
    const onViewChange = vi.fn();
    const { renderer } = await renderWorkspace({
      fetchPage,
      view: 'current',
      onViewChange,
    });

    await act(async () => {
      button(renderer, 'Обработанные')?.props.onClick();
      await flush();
    });

    expect(onViewChange).toHaveBeenCalledWith('processed');
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'current' }), {
      signal: expect.any(AbortSignal),
    });
  });

  it('appends each cursor item exactly once', async () => {
    const fetchPage = vi.fn(async (query: WarehouseInventoryQuery) =>
      query.cursor
        ? page([reserveRoll, processedRoll])
        : page([clientRoll, reserveRoll], 'cursor-2'),
    );
    const { renderer } = await renderWorkspace({ fetchPage });

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
      await flush();
    });

    const rowCodes = renderer.root
      .findAllByType('tbody')[0]
      .findAllByProps({ role: 'button' })
      .map((row) => nodeText(row));
    expect(rowCodes.filter((text) => text.includes('RESERVE-001'))).toHaveLength(1);
    expect(rowCodes.filter((text) => text.includes('PROCESSED-001'))).toHaveLength(1);
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-2' }), {
      signal: expect.any(AbortSignal),
    });
  });

  it('aborts and ignores a stale list when a filter resets cursor-owned items', async () => {
    const first = deferred<WarehouseInventoryRollPage>();
    const filtered = deferred<WarehouseInventoryRollPage>();
    const signals: AbortSignal[] = [];
    const fetchPage = vi.fn(
      (_query: WarehouseInventoryQuery, options?: { signal?: AbortSignal }) => {
        if (options?.signal) signals.push(options.signal);
        return signals.length === 1 ? first.promise : filtered.promise;
      },
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseStockWorkspace fetchPage={fetchPage} fetchDetail={vi.fn()} />,
      );
      await flush();
    });

    await act(async () => {
      input(renderer, 'Поиск рулонов').props.onChange({ currentTarget: { value: 'reserve' } });
      await flush();
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(nodeText(renderer.root)).not.toContain('CLIENT-001');

    await act(async () => {
      first.resolve(page([clientRoll]));
      filtered.resolve(page([reserveRoll]));
      await flush();
    });

    expect(nodeText(renderer.root)).not.toContain('CLIENT-001');
    expect(nodeText(renderer.root)).toContain('RESERVE-001');
  });

  it('retries a failed cursor page without duplicating an existing row', async () => {
    const appendFailure = deferred<WarehouseInventoryRollPage>();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([clientRoll, reserveRoll], 'cursor-2'))
      .mockImplementationOnce(() => appendFailure.promise)
      .mockResolvedValueOnce(page([reserveRoll, processedRoll]));
    const { renderer } = await renderWorkspace({ fetchPage });

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
      appendFailure.reject(new Error('temporary'));
      await flush();
    });
    expect(nodeText(renderer.root)).toContain('Не удалось обновить список.');
    expect(button(renderer, 'Загрузить ещё')?.props.disabled).toBe(true);

    await act(async () => {
      button(renderer, 'Повторить')?.props.onClick();
      await flush();
    });

    const rowCodes = renderer.root
      .findAllByType('tbody')[0]
      .findAllByProps({ role: 'button' })
      .map((row) => nodeText(row));
    expect(rowCodes.filter((text) => text.includes('RESERVE-001'))).toHaveLength(1);
    expect(rowCodes.filter((text) => text.includes('PROCESSED-001'))).toHaveLength(1);
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-2' }), {
      signal: expect.any(AbortSignal),
    });
  });

  it('restarts from the first page after the server rejects an expired cursor', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([clientRoll, reserveRoll], 'expired-cursor'))
      .mockRejectedValueOnce(new ApiError(400, 'Некорректный курсор склада.'))
      .mockResolvedValueOnce(page([processedRoll]));
    const { renderer } = await renderWorkspace({ fetchPage });

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
      await flush();
    });

    expect(nodeText(renderer.root)).toContain('Список изменился');
    expect(button(renderer, 'Обновить список')).toBeDefined();

    await act(async () => {
      button(renderer, 'Обновить список')?.props.onClick();
      await flush();
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      {
        view: 'current',
        sort: 'receivedAt',
        direction: 'desc',
        limit: 25,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(nodeText(renderer.root)).toContain('PROCESSED-001');
    expect(nodeText(renderer.root)).not.toContain('CLIENT-001');
  });

  it('aborts stale detail and focuses the exact row before the modal owns restoration', async () => {
    const firstDetail = deferred<WarehouseInventoryRollDetail>();
    const secondDetail = deferred<WarehouseInventoryRollDetail>();
    const signals: AbortSignal[] = [];
    const fetchDetail = vi.fn((rollId: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal);
      return rollId === clientRoll.id ? firstDetail.promise : secondDetail.promise;
    });
    const { renderer } = await renderWorkspace({ fetchDetail });
    const focus = vi.fn();
    const openingRow = {
      isConnected: true,
      matches: vi.fn((selector: string) => selector !== ':disabled'),
      getAttribute: vi.fn(() => null),
      ownerDocument: {
        defaultView: {
          getComputedStyle: vi.fn(() => ({ display: 'block', visibility: 'visible' })),
        },
      },
      getClientRects: vi.fn(() => [{ width: 1, height: 1 }]),
      focus,
    } as unknown as HTMLElement;
    const rows = renderer.root.findAllByType('tr').filter((row) => row.props.role === 'button');

    await act(async () => {
      rows[0]?.props.onClick({ currentTarget: openingRow });
      await flush();
    });
    expect(renderer.root.findByProps({ role: 'dialog' }).props['aria-label']).toBe('CLIENT-001');
    expect(focus).toHaveBeenCalledOnce();

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Закрыть' }).props.onClick();
      await flush();
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(focus).toHaveBeenCalledOnce();

    const refreshedRows = renderer.root
      .findAllByType('tr')
      .filter((row) => row.props.role === 'button');
    await act(async () => {
      refreshedRows[1]?.props.onClick({
        currentTarget: { ...openingRow, focus: vi.fn() },
      });
      firstDetail.resolve(clientDetail);
      secondDetail.resolve(reserveDetail);
      await flush();
    });

    expect(nodeText(renderer.root.findByProps({ role: 'dialog' }))).toContain('Полотно');
    expect(nodeText(renderer.root.findByProps({ role: 'dialog' }))).not.toContain('ORD-001');
  });

  it('uses the existing reserve create modal and refreshes the current list after creation', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([reserveRoll]))
      .mockResolvedValueOnce(page([{ ...reserveRoll, id: 'roll-created', rollCode: 'RES-NEW' }]));
    const createRoll = vi.fn(async (_input: WarehouseReserveRollCreateInput) => createdReserveRoll);
    const { renderer } = await renderWorkspace({
      fetchPage,
      canCreate: true,
      materials,
      catalogStatus: 'ready',
      createRoll,
    });

    await act(async () => {
      button(renderer, '+ Добавить рулон')?.props.onClick();
      await flush();
    });

    const fields: Array<[string, string]> = [
      ['Код рулона', 'RES-NEW'],
      ['Партия рулона', 'BATCH-NEW'],
      ['Тип плёнки', 'Рукав'],
      ['Тип шпули', 'Тонкая'],
      ['Фактическая толщина, мкм', '80'],
      ['Бухгалтерская толщина, мкм', '78'],
      ['Ширина, мм', '1200'],
      ['Метраж, м', '800'],
      ['Брутто, кг', '41.9'],
      ['Вес шпули, кг', '0.7'],
      ['План нетто, кг', '41'],
      ['Бирка рулона', 'ГОСТ'],
      ['Сырьё или рецептура рулона', 'material:material-primary'],
    ];
    for (const [label, value] of fields) {
      await act(async () => {
        input(renderer, label).props.onChange({ currentTarget: { value } });
      });
    }
    await act(async () => {
      button(renderer, 'Добавить в резерв')?.props.onClick();
      await flush();
    });

    expect(createRoll).toHaveBeenCalledOnce();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenLastCalledWith(
      {
        view: 'current',
        sort: 'receivedAt',
        direction: 'desc',
        limit: 25,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(nodeText(renderer.root)).toContain('RES-NEW');
  });
});
