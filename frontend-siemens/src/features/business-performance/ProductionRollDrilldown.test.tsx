import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BusinessPerformanceRollItem } from '../../api/businessPerformance';
import { BusinessPerformanceWorkspace } from './BusinessPerformanceWorkspace';
import { productionStatusLabel } from './ProductionRollDrilldown';

const SOURCE = {
  kind: 'platform_runtime',
  status: 'ready',
  freshness: 'fresh',
  generatedAt: '2026-08-07T02:00:00.000Z',
} as const;

const PRODUCTION_ORDER = {
  id: 'production-1',
  orderNumber: 'A-5',
  counterpartyName: 'Контур Пак',
  productionStatus: 'in_production',
  lifecycleStatus: 'in_production',
  createdAt: '2026-08-07T02:00:00.000Z',
  completedAt: null,
  plannedRollCount: 2,
  completedRollCount: 1,
  plannedKg: 80,
  actualKg: 42.3,
  defectKg: 0,
  defectRollCount: 0,
  returnedSpoolCount: 0,
  updatedAt: '2026-08-07T02:00:00.000Z',
} as const;

const ROLL_ONE: BusinessPerformanceRollItem = {
  id: 'dispatch-1',
  rollName: 'Рулон 1',
  rollCode: 'ROLL-001',
  orderNumber: 'A-5',
  parameters: {
    filmType: 'Рукав',
    actualThicknessUm: 60,
    accountingThicknessUm: 58,
    widthMm: 1_700,
    plannedLengthM: 275,
    weightKg: 42.3,
  },
  operatorName: 'Оператор 1',
  machineName: 'Экструдер 1',
  priority: 2,
  status: 'warehouse_accepted',
  lifecycleStatus: 'warehouse_accepted',
  createdAt: '2026-08-07T00:30:00.000Z',
  completedAt: '2026-08-07T01:00:00.000Z',
  weights: {
    plannedNetKg: 42,
    actualNetKg: 42.3,
    actualGrossKg: 43.8,
    deviationKg: 0.3,
  },
  productionCost: {
    kind: 'actual_snapshot',
    status: 'complete',
    calculationVersion: 'production-cost-v1',
    snapshotId: 'cost-snapshot-1',
    version: 2,
    producedAt: '2026-08-07T00:30:00.000Z',
    closedAt: '2026-08-07T01:00:00.000Z',
    createdAt: '2026-08-07T01:00:01.000Z',
    basis: { kind: 'actual', weightGrams: 42_300 },
    materialAmountKopecks: 30_000,
    spoolAmountKopecks: 9_000,
    payrollAmountKopecks: 4_000,
    additionalAmountKopecks: 500,
    totalAmountKopecks: 43_500,
    totalKopecksPerKg: 1_028,
    unresolvedReasons: [],
  },
};

const ROLL_TWO: BusinessPerformanceRollItem = {
  ...ROLL_ONE,
  id: 'dispatch-2',
  rollName: 'Рулон 2',
  rollCode: 'ROLL-002',
};

const ROLL_THREE: BusinessPerformanceRollItem = {
  ...ROLL_ONE,
  id: 'dispatch-3',
  rollName: 'Рулон 3',
  rollCode: 'ROLL-003',
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function productionPage() {
  return response({
    items: [PRODUCTION_ORDER],
    nextCursor: null,
    source: SOURCE,
  });
}

function rollPage(items: readonly BusinessPerformanceRollItem[], nextCursor: string | null = null) {
  return response({ items, nextCursor });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function orderToggle(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({
    className: 'production-roll-drilldown-toggle',
  });
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('button')
    .find((candidate) => textContent(candidate) === label);
}

async function renderProduction(
  fetchMock: ReturnType<typeof vi.fn>,
  refreshGeneration = 0,
  role: 'commercial' | 'director' = 'commercial',
) {
  vi.stubGlobal('fetch', fetchMock);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <BusinessPerformanceWorkspace
        section="Производство"
        refreshGeneration={refreshGeneration}
        role={role}
      />,
    );
  });
  return renderer;
}

async function expand(renderer: ReactTestRenderer) {
  await act(async () => {
    orderToggle(renderer).props.onClick();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('production roll drilldown', () => {
  it.each([
    ['in_production', 'В производстве'],
    ['assigned', 'Назначен'],
    ['defect', 'Брак'],
    ['ready_for_warehouse', 'Готов к передаче'],
    ['warehouse_handed_off', 'Передан на склад'],
    ['warehouse_accepted', 'Принят складом'],
    ['warehouse_delivered', 'Выдан со склада'],
    ['done', 'Завершён'],
  ])('renders internal status %s as %s', (status, label) => {
    expect(productionStatusLabel(status)).toBe(label);
  });

  it('never leaks a new internal English status into the interface', () => {
    expect(productionStatusLabel('backend_new_status')).toBe('Не определён');
    expect(productionStatusLabel('Ожидает проверки')).toBe('Ожидает проверки');
  });

  it('renders a native expandable control with a centered chevron before the order name', async () => {
    const renderer = await renderProduction(vi.fn().mockResolvedValue(productionPage()));

    const toggle = orderToggle(renderer);
    const orderRow = renderer.root.findByProps({
      className: 'production-roll-drilldown-order-row',
    });
    const content = toggle.findAllByType('span');

    expect(orderRow.props['data-order-status']).toBe('in_production');
    expect(toggle.type).toBe('button');
    expect(toggle.props.type).toBe('button');
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(toggle.props['aria-label']).toBe('Показать рулоны заказа A-5');
    expect(toggle.props.className).toBe('production-roll-drilldown-toggle');
    expect(content.map((node) => node.props.className)).toEqual([
      'production-roll-drilldown-chevron',
      'production-roll-drilldown-order',
    ]);
    expect(textContent(content[1])).toBe('A-5');
  });

  it('colors the director order row by the displayed lifecycle when the indicator is stale', async () => {
    const acceptedOrder = {
      ...PRODUCTION_ORDER,
      productionStatus: 'in_production',
      lifecycleStatus: 'warehouse_accepted',
    } as const;
    const renderer = await renderProduction(
      vi.fn().mockResolvedValue(
        response({ items: [acceptedOrder], nextCursor: null, source: SOURCE }),
      ),
      0,
      'director',
    );
    const row = renderer.root.findByProps({
      className: 'production-roll-drilldown-order-row',
    });

    expect(textContent(row)).toContain('Принят складом');
    expect(row.props['data-order-status']).toBe('warehouse_accepted');
  });

  it('shows the counterparty column only to the director', async () => {
    const director = await renderProduction(
      vi.fn().mockResolvedValue(productionPage()),
      0,
      'director',
    );
    const commercial = await renderProduction(vi.fn().mockResolvedValue(productionPage()));

    expect(director.root.findByType('thead').findAllByType('th').map(textContent)).toContain(
      'Заказчик',
    );
    expect(
      textContent(
        director.root.findByProps({ className: 'production-roll-drilldown-order-row' }),
      ),
    ).toContain('Контур Пак');
    expect(commercial.root.findByType('thead').findAllByType('th').map(textContent)).not.toContain(
      'Заказчик',
    );
    expect(
      textContent(
        commercial.root.findByProps({ className: 'production-roll-drilldown-order-row' }),
      ),
    ).not.toContain('Контур Пак');
  });

  it('shows canonical lifecycle dates and removes spool inventory from the order table', async () => {
    const renderer = await renderProduction(vi.fn().mockResolvedValue(productionPage()));
    const headers = renderer.root.findByType('thead').findAllByType('th').map(textContent);

    expect(headers).toContain('Создан');
    expect(headers).toContain('Завершён');
    expect(headers).not.toContain('Шпули на складе');
    expect(textContent(renderer.root)).toContain('07.08.2026');
    expect(textContent(renderer.root)).toContain('В производстве');
  });

  it('shows per-roll planned, net, gross and signed deviation facts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([ROLL_ONE]));
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);
    const rollTable = renderer.root.findByProps({ className: 'production-roll-drilldown-table' });
    const text = textContent(rollTable);

    expect(text).toContain('План нетто');
    expect(text).toContain('Факт нетто');
    expect(text).toContain('Факт брутто');
    expect(text).toContain('+0,3 кг');
    expect(text).toContain('Принят складом');
    expect(
      rollTable.findByProps({ className: 'production-roll-drilldown-item' }).props[
        'data-order-status'
      ],
    ).toBe('warehouse_accepted');
  });

  it('activates through the native button contract and fetches rolls on first expand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([ROLL_ONE]));
    const renderer = await renderProduction(fetchMock);

    await expand(renderer);

    expect(orderToggle(renderer).props['aria-expanded']).toBe(true);
    expect(orderToggle(renderer).props['aria-label']).toBe('Скрыть рулоны заказа A-5');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/api/commercial/performance/production/production-1/rolls',
    );
    expect(textContent(renderer.root)).toContain('Рулон 1');
  });

  it('reuses a completed cache when an order is collapsed and expanded again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([ROLL_ONE]));
    const renderer = await renderProduction(fetchMock);

    await expand(renderer);
    await expand(renderer);
    await expand(renderer);

    expect(orderToggle(renderer).props['aria-expanded']).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(textContent(renderer.root)).toContain('Рулон 1');
  });

  it('does not duplicate the first roll request after refreshing while collapsed', async () => {
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      return Promise.resolve(rollPage([ROLL_ONE]));
    });
    const renderer = await renderProduction(fetchMock);

    await act(async () => {
      renderer.update(
        <BusinessPerformanceWorkspace section="Производство" refreshGeneration={1} />,
      );
    });
    await expand(renderer);

    expect(rollRequest).toBe(1);
    expect(textContent(renderer.root)).toContain('Рулон 1');
  });

  it('invalidates the roll cache when the workspace refresh generation changes', async () => {
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      return Promise.resolve(rollPage(rollRequest === 1 ? [ROLL_ONE] : [ROLL_TWO]));
    });
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      renderer.update(
        <BusinessPerformanceWorkspace section="Производство" refreshGeneration={1} />,
      );
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(rollRequest).toBe(2);
    expect(textContent(renderer.root)).toContain('Рулон 2');
    expect(textContent(renderer.root)).not.toContain('Рулон 1');
  });

  it('keeps the expanded roll table visible while a background refresh is pending', async () => {
    const refreshedRolls = deferred<Response>();
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      return rollRequest === 1 ? Promise.resolve(rollPage([ROLL_ONE])) : refreshedRolls.promise;
    });
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      renderer.update(
        <BusinessPerformanceWorkspace section="Производство" refreshGeneration={1} />,
      );
    });

    expect(textContent(renderer.root)).toContain('Рулон 1');
    expect(textContent(renderer.root)).not.toContain('Загрузка рулонов…');

    await act(async () => {
      refreshedRolls.resolve(rollPage([ROLL_TWO]));
    });

    expect(textContent(renderer.root)).toContain('Рулон 2');
    expect(textContent(renderer.root)).not.toContain('Рулон 1');
  });

  it('preserves the expanded order and draft period through two polling intervals', async () => {
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      return Promise.resolve(rollPage([ROLL_ONE]));
    });
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);
    const fromInput = renderer.root.findByProps({ 'aria-label': 'Дата с' });
    act(() => fromInput.props.onChange({ target: { value: '2026-08-01' } }));

    for (const generation of [1, 2]) {
      await act(async () => {
        renderer.update(
          <BusinessPerformanceWorkspace section="Производство" refreshGeneration={generation} />,
        );
      });
    }

    expect(orderToggle(renderer).props['aria-expanded']).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': 'Дата с' }).props.value).toBe('2026-08-01');
    expect(rollRequest).toBe(3);
    expect(textContent(renderer.root)).toContain('Рулон 1');
  });

  it('does not invent missing per-roll weight facts', async () => {
    const missingWeights = {
      ...ROLL_ONE,
      weights: {
        plannedNetKg: null,
        actualNetKg: null,
        actualGrossKg: null,
        deviationKg: null,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([missingWeights]));
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);
    const row = renderer.root.findByProps({ className: 'production-roll-drilldown-item' });

    expect(textContent(row).match(/Не зафиксирован/gu)).toHaveLength(4);
  });

  it('preserves already loaded roll pages when the first page is revalidated', async () => {
    const updatedRollOne = {
      ...ROLL_ONE,
      rollName: 'Рулон 1 обновлён',
      status: 'warehouse_accepted' as const,
    };
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      if (rollRequest === 1) return Promise.resolve(rollPage([ROLL_ONE], 'next-page'));
      if (rollRequest === 2) return Promise.resolve(rollPage([ROLL_TWO]));
      return Promise.resolve(rollPage([updatedRollOne], 'next-page'));
    });
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
    });
    await act(async () => {
      renderer.update(
        <BusinessPerformanceWorkspace section="Производство" refreshGeneration={1} />,
      );
    });

    expect(textContent(renderer.root)).toContain('Рулон 1 обновлён');
    expect(textContent(renderer.root)).toContain('Рулон 2');
    expect(
      renderer.root.findAllByProps({ className: 'production-roll-drilldown-item' }),
    ).toHaveLength(2);
  });

  it('does not duplicate a roll that moves from a later page into the refreshed first page', async () => {
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      if (rollRequest === 1) {
        return Promise.resolve(rollPage([ROLL_ONE, ROLL_TWO], 'next-page'));
      }
      if (rollRequest === 2) return Promise.resolve(rollPage([ROLL_THREE]));
      return Promise.resolve(rollPage([ROLL_ONE, ROLL_THREE], 'next-page'));
    });
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
    });
    await act(async () => {
      renderer.update(
        <BusinessPerformanceWorkspace section="Производство" refreshGeneration={1} />,
      );
    });

    const rows = renderer.root.findAllByProps({
      className: 'production-roll-drilldown-item',
    });
    expect(rows.map(textContent)).toEqual([
      expect.stringContaining('Рулон 1'),
      expect.stringContaining('Рулон 3'),
    ]);
  });

  it('keeps the initial loading state when refresh starts before the first roll page arrives', async () => {
    const initialRolls = deferred<Response>();
    const refreshedRolls = deferred<Response>();
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      return rollRequest === 1 ? initialRolls.promise : refreshedRolls.promise;
    });
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      renderer.update(
        <BusinessPerformanceWorkspace section="Производство" refreshGeneration={1} />,
      );
    });

    expect(textContent(renderer.root)).toContain('Загрузка рулонов…');
    expect(textContent(renderer.root)).not.toContain('Рулонов пока нет.');

    await act(async () => {
      refreshedRolls.resolve(rollPage([ROLL_TWO]));
    });

    expect(textContent(renderer.root)).toContain('Рулон 2');
  });

  it('aborts an in-flight roll request when the workspace unmounts', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockImplementationOnce(() => pending.promise);
    const renderer = await renderProduction(fetchMock);

    await act(async () => {
      orderToggle(renderer).props.onClick();
    });
    const rollSignal = fetchMock.mock.calls[1][1]?.signal as AbortSignal;
    expect(rollSignal.aborted).toBe(false);

    act(() => renderer.unmount());

    expect(rollSignal.aborted).toBe(true);
  });

  it('ignores a stale completion from the previous refresh generation', async () => {
    const stale = deferred<Response>();
    const current = deferred<Response>();
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      return rollRequest === 1 ? stale.promise : current.promise;
    });
    const renderer = await renderProduction(fetchMock);

    await act(async () => {
      orderToggle(renderer).props.onClick();
    });
    await act(async () => {
      renderer.update(
        <BusinessPerformanceWorkspace section="Производство" refreshGeneration={1} />,
      );
    });
    await act(async () => {
      stale.resolve(rollPage([ROLL_ONE]));
    });

    expect(textContent(renderer.root)).not.toContain('Рулон 1');

    await act(async () => {
      current.resolve(rollPage([ROLL_TWO]));
    });

    expect(textContent(renderer.root)).toContain('Рулон 2');
  });

  it('appends the next page without rendering duplicate rolls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([ROLL_ONE], 'next-page'))
      .mockResolvedValueOnce(rollPage([ROLL_ONE, ROLL_TWO]));
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
    });

    const rows = renderer.root.findAllByProps({ className: 'production-roll-drilldown-item' });
    expect(rows.map(textContent)).toEqual([
      expect.stringContaining('Рулон 1'),
      expect.stringContaining('Рулон 2'),
    ]);
  });

  it('stops pagination when an append response repeats the requested cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([ROLL_ONE], 'cursor-a'))
      .mockResolvedValueOnce(rollPage([ROLL_TWO], 'cursor-a'));
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
    });

    expect(button(renderer, 'Загрузить ещё')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(textContent(renderer.root)).toContain('Рулон 2');
  });

  it('stops pagination when a later page returns an already consumed cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([ROLL_ONE], 'cursor-a'))
      .mockResolvedValueOnce(rollPage([ROLL_TWO], 'cursor-b'))
      .mockResolvedValueOnce(rollPage([ROLL_THREE], 'cursor-a'));
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
    });
    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
    });

    expect(button(renderer, 'Загрузить ещё')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(textContent(renderer.root)).toContain('Рулон 3');
  });

  it('allows a failed append cursor to be retried', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([ROLL_ONE], 'cursor-a'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(rollPage([ROLL_TWO]));
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
    });
    expect(button(renderer, 'Повторить')).toBeDefined();

    await act(async () => {
      button(renderer, 'Повторить')?.props.onClick();
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(textContent(renderer.root)).toContain('Рулон 2');
    expect(button(renderer, 'Повторить')).toBeUndefined();
  });

  it('resets consumed cursors without dropping loaded pages on refresh', async () => {
    let rollRequest = 0;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (!input.includes('/rolls')) return Promise.resolve(productionPage());
      rollRequest += 1;
      if (rollRequest === 1) return Promise.resolve(rollPage([ROLL_ONE], 'cursor-a'));
      if (rollRequest === 2) return Promise.resolve(rollPage([ROLL_TWO], 'cursor-a'));
      return Promise.resolve(rollPage([ROLL_THREE], 'cursor-a'));
    });
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    await act(async () => {
      button(renderer, 'Загрузить ещё')?.props.onClick();
    });
    await act(async () => {
      renderer.update(
        <BusinessPerformanceWorkspace section="Производство" refreshGeneration={1} />,
      );
    });

    expect(button(renderer, 'Загрузить ещё')).toBeDefined();
    expect(textContent(renderer.root)).toContain('Рулон 3');
    expect(textContent(renderer.root)).toContain('Рулон 2');
  });

  it('renders exact roll columns and wraps parameters as indivisible semantic chips', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(productionPage())
      .mockResolvedValueOnce(rollPage([ROLL_ONE]));
    const renderer = await renderProduction(fetchMock);
    await expand(renderer);

    const table = renderer.root.findByProps({
      className: 'production-roll-drilldown-table',
    });
    const headings = table.findAllByType('th').map(textContent);
    const chips = renderer.root
      .findAllByProps({ className: 'production-roll-parameter-chip' })
      .map(textContent);

    expect(headings).toEqual([
      'Рулон',
      'Заказ',
      'Параметры',
      'Оператор',
      'Станок',
      'Приоритет',
      'План нетто',
      'Факт нетто',
      'Факт брутто',
      'Отклонение',
      'Статус',
      'Себестоимость',
    ]);
    expect(chips).toEqual([
      'Тип: Рукав',
      'Факт: 60 мкм',
      'Бух.: 58 мкм',
      'Ширина: 1 700 мм',
      'Метраж: 275 м',
      'Вес: 42,3 кг',
    ]);
    expect(textContent(renderer.root)).toContain('В производстве');
    expect(textContent(renderer.root)).toContain('Принят складом');
    expect(textContent(renderer.root)).not.toContain('in_production');
    expect(textContent(renderer.root)).not.toContain('done');
    expect(textContent(renderer.root)).toContain('435 ₽');
    expect(textContent(renderer.root)).toContain('10,28 ₽/кг');
    expect(textContent(renderer.root)).toContain('Версия 2');
    expect(renderer.root.findByProps({ className: 'production-roll-cost-column' })).toBeDefined();
  });
});
