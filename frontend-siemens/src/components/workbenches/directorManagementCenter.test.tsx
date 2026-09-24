import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDirectorAnalytics,
  fetchDirectorBigBagEvidence,
  fetchDirectorShiftBalances,
  type ServerDirectorAnalyticsResponse,
  type ServerDirectorAnalyticsShiftBalanceEvidence,
} from '../../api/director';
import type { DirectorDashboardProjection } from '../../domain/runtime';
import { DirectorProductionCharts } from './DirectorProductionCharts';
import { DirectorCalendarMonth, ManagementCenter } from './directorManagementCenter';

vi.mock('../../api/director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/director')>();
  return {
    ...actual,
    fetchDirectorAnalytics: vi.fn(),
    fetchDirectorShiftBalances: vi.fn(),
    fetchDirectorBigBagEvidence: vi.fn(),
  };
});

const fetchAnalyticsMock = vi.mocked(fetchDirectorAnalytics);
const fetchShiftBalancesMock = vi.mocked(fetchDirectorShiftBalances);
const fetchBigBagEvidenceMock = vi.mocked(fetchDirectorBigBagEvidence);

const drilldown = {
  section: 'Производство',
  view: 'orders',
  filter: 'risk',
} as const;

const shiftEvidenceRow: ServerDirectorAnalyticsShiftBalanceEvidence = {
  sessionId: 'session-1',
  shiftId: 'shift-1',
  shiftLabel: 'Смена 1',
  operatorId: 'operator-1',
  operatorName: 'Ахметов Булат',
  postId: 'post-1',
  postCode: 'POST-1',
  postName: 'Бегемот',
  startedAt: '2026-08-05T11:47:09.110Z',
  endedAt: '2026-08-05T12:41:24.300Z',
  bigBags: [
    {
      usageId: 'usage-1',
      bigBagId: 'bag-1',
      bigBagCode: 'BB-ПВД-АЙКА-01',
      materialId: null,
      material: 'ПВД Айка',
      bigBagStatus: 'consumed',
      startKg: 999,
      endKg: 980,
      currentKg: 980,
      currentMeasuredAt: '2026-08-05T12:41:24.300Z',
      currentFreshness: 'fresh',
      openedAt: '2026-08-05T11:47:09.110Z',
      closedAt: '2026-08-05T12:41:24.300Z',
    },
  ],
  startKg: 999,
  endKg: 980,
  currentKg: 980,
  actualUsageKg: 19,
  expectedUsageKg: 15.7,
  producedKg: 7.95,
  rollCount: 1,
  defectKg: 7.75,
  defectCount: 1,
  unverifiedDefectCount: 0,
  deviationKg: 3.3,
  deviationPercent: 21.019,
  status: 'mismatch',
  source: {
    usage: 'shift_bag_usage',
    production: 'canonical_roll_weight_capture',
    defects: 'linked_stable_defect_weight_capture',
    latestEvidenceAt: '2026-08-05T12:41:24.300Z',
    freshness: 'fresh',
  },
};

const dashboard = {
  situations: [],
  healthSignals: [],
  secondaryMetrics: [],
  evidence: {
    periodLabel: 'Период',
    sourceLabel: 'Источник',
    denominatorLabel: 'Основание',
  },
  controlReport: {
    periodLabel: 'Демо-период',
    sourceLabel: 'Демо-источник',
    denominatorLabel: 'Демо-основание',
    selectedPeriod: 'current_month',
    comparisonPeriod: 'previous_month',
    availablePeriods: [],
    kpis: [
      {
        id: 'demo-live-leak-kpi',
        label: 'DEMO-LIVE-LEAK-KPI',
        value: '777',
        caption: 'DEMO-LIVE-LEAK-KPI-CAPTION',
        tone: 'risk',
        actionLabel: 'Открыть',
        drilldown,
      },
    ],
    periodMetrics: [
      {
        id: 'period-output',
        label: 'Демо-выработка',
        currentLabel: '999 кг',
        previousLabel: '888 кг',
        currentValue: 999,
        previousValue: 888,
        deltaLabel: '+111 кг',
        tone: 'production',
        periodLabel: 'Демо-период',
        sourceLabel: 'Демо-источник',
        stalenessLabel: 'Демо-срез',
        basisLabel: 'Демо-основание',
        actionLabel: 'Открыть',
        drilldown,
      },
    ],
    periodRows: [
      {
        id: 'period-row-kg',
        label: 'Демо-строка',
        currentLabel: '999 кг',
        previousLabel: '888 кг',
        deltaLabel: '+111 кг',
        sourceLabel: 'Демо-источник',
        drilldown,
      },
    ],
    financeRows: [
      {
        id: 'demo-live-leak-finance',
        orderId: 'DEMO-LIVE-LEAK-FINANCE',
        customerLabel: 'Демо-клиент',
        amountLabel: '777 ₽',
        paidLabel: '0 ₽',
        remainingLabel: '777 ₽',
        dueLabel: 'Демо-срок',
        statusLabel: 'Демо-статус',
        sourceLabel: 'Демо-источник',
        riskLabel: 'Демо-риск',
        severity: 'warning',
        amountValue: 777,
        remainingValue: 777,
        dueRank: 1,
      },
    ],
    productionRows: [
      {
        id: 'demo-live-leak-production',
        label: 'DEMO-LIVE-LEAK-PRODUCTION',
        factLabel: '777 кг',
        planLabel: '888 кг',
        varianceLabel: '−111 кг',
        sourceLabel: 'Демо-источник',
      },
    ],
    defectBags: {
      totalCount: 1,
      totalWeightKg: 12.5,
      byStatus: [
        { status: 'weighed', count: 0, weightKg: 0 },
        { status: 'ready_for_warehouse', count: 0, weightKg: 0 },
        { status: 'received', count: 0, weightKg: 0 },
        { status: 'shipped', count: 1, weightKg: 12.5 },
      ],
      byType: [
        { defectType: 'secondary', count: 0, weightKg: 0 },
        { defectType: 'aika', count: 0, weightKg: 0 },
        { defectType: 'primary', count: 1, weightKg: 12.5 },
      ],
      unclassified: { count: 0, weightKg: 0 },
      recent: [
        {
          id: 'defect-bag-1',
          code: 'DB-20260907-0001',
          status: 'shipped',
          defectType: 'primary',
          weightKg: 12.5,
          recordedDefectKg: 12,
          differenceKg: 0.5,
          operatorName: 'Оператор Брака',
          postCode: 'POST-1',
          postName: 'Бегемот',
          shiftLabel: 'Дневная смена',
          weighedAt: '2026-09-07T08:00:00.000Z',
          receivedAt: '2026-09-07T09:00:00.000Z',
          receivedBy: 'Кладовщик Иван',
          shippedAt: '2026-09-07T10:00:00.000Z',
          shippedBy: 'Кладовщик Пётр',
        },
      ],
      hasMore: false,
    },
  },
} satisfies DirectorDashboardProjection;

const analyticsResponse: ServerDirectorAnalyticsResponse = {
  range: {
    timezone: 'Europe/Moscow',
    requested: { from: '2026-07-01', to: '2026-07-27' },
    effective: {
      fromUtc: '2026-06-30T21:00:00.000Z',
      toExclusiveUtc: '2026-07-27T21:00:00.000Z',
    },
    bucket: 'day',
    generatedAt: '2026-07-27T10:00:00.000Z',
  },
  productionSeries: [],
  materialSeries: [],
  shiftBalances: [],
  bigBags: [],
  operatorOverPlan: {
    series: [],
    totals: [],
    topOperators: [],
    missingPlanCount: 0,
    missingActorCount: 0,
  },
  productionQualitySeries: [],
  materialSpendSeries: [],
  spoolEvidence: {
    availability: 'measured_evidence_only',
    explanation: 'Только подтверждённые факты.',
  },
  commercialApplications: {
    definition: 'submitted',
    asOfDate: '2026-07-27',
    periods: [],
  },
  accountingProduction: {
    source: {
      sourceKind: '1C',
      label: '1С · Отчет производства за смену',
      latestImportedAt: null,
      latestDocumentDate: null,
      stale: true,
    },
    coverage: {
      documentCount: 0,
      excludedOutputLineCount: 0,
      excludedMaterialLineCount: 0,
    },
    productionSeries: [],
    materialSeries: [],
  },
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function requestWithSignal() {
  return expect.objectContaining({ signal: expect.any(AbortSignal) });
}

function installLocation(search = '?role=director') {
  const replaceState = vi.fn();
  vi.stubGlobal('window', {
    location: { search, pathname: '/', hash: '' },
    history: { replaceState },
  });
  return replaceState;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushRequests(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderLiveCenter(search = '?role=director') {
  const replaceState = installLocation(search);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ManagementCenter dashboard={dashboard} onDrilldown={vi.fn()} useLiveData />,
    );
    await Promise.resolve();
  });
  await flushRequests();
  return { renderer, replaceState };
}

describe('ManagementCenter analytics boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchAnalyticsMock.mockReset().mockResolvedValue(analyticsResponse);
    fetchShiftBalancesMock.mockReset().mockImplementation(async (query) => ({
      items: [],
      nextCursor: query.cursor ? null : 'shift-next',
    }));
    fetchBigBagEvidenceMock.mockReset().mockImplementation(async (query) => ({
      items: [],
      nextCursor: query.cursor ? null : 'bag-next',
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails closed to live loading and never renders demo period values', () => {
    const markup = renderToStaticMarkup(
      <ManagementCenter dashboard={dashboard} onDrilldown={vi.fn()} useLiveData />,
    );

    expect(markup).toContain('Загрузка производственной аналитики');
    expect(markup).toContain('<h2>Производственная аналитика</h2>');
    expect(markup).toContain('Время: Москва');
    expect(markup).not.toContain('Демо-выработка');
    expect(markup).not.toContain('999 кг');
    expect(markup).not.toContain('сравнение с предыдущим периодом');
    expect(markup).not.toContain('DEMO-LIVE-LEAK-KPI');
    expect(markup).not.toContain('DEMO-LIVE-LEAK-FINANCE');
    expect(markup).not.toContain('DEMO-LIVE-LEAK-PRODUCTION');
  });

  it('renders one period control and a separately labelled grouping select', () => {
    const markup = renderToStaticMarkup(
      <ManagementCenter dashboard={dashboard} onDrilldown={vi.fn()} useLiveData />,
    );

    expect(markup).toContain('aria-label="Быстрый выбор периода"');
    expect(markup.match(/aria-label="Быстрый выбор периода"/gu)).toHaveLength(1);
    expect(markup).toMatch(/<label[^>]*class="management-period-granularity"/u);
    expect(markup).toContain('<span>Группировка</span>');
    expect(markup).toContain('<select aria-label="Группировка"');
    expect(markup).not.toContain('aria-label="Группировка аналитики"');
  });

  it('renders the live defect-bag summary and warehouse lifecycle', () => {
    const markup = renderToStaticMarkup(
      <ManagementCenter dashboard={dashboard} onDrilldown={vi.fn()} useLiveData />,
    );

    expect(markup).toContain('Мешки брака');
    expect(markup).toContain('DB-20260907-0001');
    expect(markup).toContain('12,5 кг');
    expect(markup).toContain('Оператор Брака');
    expect(markup).toContain('POST-1 · Бегемот');
    expect(markup).toContain('Кладовщик Иван');
    expect(markup).toContain('Кладовщик Пётр');
    expect(markup).toContain('Отгружен');
    expect(markup).toContain('По типу брака');
    expect(markup).toContain('Первичка');
  });

  it('restores period, grouping and evidence filters from the URL on first render', () => {
    vi.stubGlobal('window', {
      location: {
        search:
          '?role=director&period=week&bucket=week&sb_open=1&sb_operatorQuery=operator-1&sb_status=mismatch&sb_q=%D0%BD%D0%BE%D1%87%D1%8C&bb_usageState=closed',
        pathname: '/',
        hash: '',
      },
      history: { replaceState: vi.fn() },
    });

    const markup = renderToStaticMarkup(
      <ManagementCenter dashboard={dashboard} onDrilldown={vi.fn()} useLiveData />,
    );

    expect(markup).toMatch(/value="week" selected="">Недели/u);
    expect(markup).toMatch(/>Неделя<\/button>/u);
    expect(markup.match(/<details[^>]*open=""/gu)).toHaveLength(1);
    expect(markup).toContain('value="operator-1"');
    expect(markup).toContain('value="mismatch" selected=""');
    expect(markup).toContain('value="ночь"');
    expect(markup).toContain('value="closed" selected=""');
    expect(markup).not.toContain('aria-label="Фильтры фактов смен и BigBag"');
    expect(markup).not.toContain('director-analytics-evidence-filters');
  });

  it('keeps fixture comparison only in an explicitly labelled demo branch', () => {
    const markup = renderToStaticMarkup(
      <ManagementCenter dashboard={dashboard} onDrilldown={vi.fn()} useLiveData={false} />,
    );

    expect(markup).toContain('Демонстрационный расчёт');
    expect(markup).toContain('Демо-выработка');
    expect(markup).toContain('999 кг');
    expect(markup).toContain('DEMO-LIVE-LEAK-KPI');
    expect(markup).toContain('DEMO-LIVE-LEAK-FINANCE');
    expect(markup).toContain('DEMO-LIVE-LEAK-PRODUCTION');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('aborts a superseded analytics request and ignores its late result', async () => {
    const first = deferred<ServerDirectorAnalyticsResponse>();
    const second = deferred<ServerDirectorAnalyticsResponse>();
    fetchAnalyticsMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { renderer } = await renderLiveCenter();
    const firstSignal = fetchAnalyticsMock.mock.calls[0]?.[1]?.signal;
    expect(firstSignal?.aborted).toBe(false);

    act(() => findButton(renderer.root, 'Неделя').props.onClick());
    await flushRequests();

    const secondSignal = fetchAnalyticsMock.mock.calls[1]?.[1]?.signal;
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);

    await act(async () => second.resolve(analyticsResponse));
    const charts = () => renderer.root.findByType(DirectorProductionCharts);
    expect(charts().props.state).toEqual(expect.objectContaining({ status: 'empty' }));

    await act(async () =>
      first.resolve({
        ...analyticsResponse,
        productionSeries: [{ bucketStartDate: '2026-07-01', rollCount: 99, producedKg: 999 }],
      }),
    );
    expect(charts().props.state).toEqual(expect.objectContaining({ status: 'empty' }));
    expect(charts().props.state.view?.productionSeries).toEqual([]);
  });

  it('keeps the prior analytics view while refreshing and keeps failure unavailable', async () => {
    const { renderer } = await renderLiveCenter();
    const charts = () => renderer.root.findByType(DirectorProductionCharts);
    expect(charts().props.state.view).not.toBeNull();

    const refresh = deferred<ServerDirectorAnalyticsResponse>();
    fetchAnalyticsMock.mockImplementationOnce(() => refresh.promise);
    act(() => findButton(renderer.root, 'Неделя').props.onClick());
    await flushRequests();

    // The charts stay up while the new period loads; only the failure clears them.
    expect(charts().props.state).toEqual(
      expect.objectContaining({ status: 'loading', view: expect.any(Object), error: null }),
    );

    await act(async () => refresh.reject(new Error('offline')));
    expect(charts().props.state).toEqual(expect.objectContaining({ status: 'error', view: null }));
  });

  it('keeps historical calendar dates available and disables future dates with full labels', () => {
    const markup = renderToStaticMarkup(
      <DirectorCalendarMonth
        month={6}
        year={2026}
        title="Июль 2026"
        range={{ preset: 'custom', from: '2026-07-01', to: '2026-07-22' }}
        maxDate="2026-07-22"
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Выбрать дату 01.07.2026"');
    expect(markup).toMatch(/aria-label="Выбрать дату 22\.07\.2026"[^>]*>/u);
    expect(markup).toMatch(/aria-label="Выбрать дату 23\.07\.2026"[^>]*disabled=""/u);
  });

  it('debounces shift search for 300 ms without reloading BigBag evidence', async () => {
    const { renderer, replaceState } = await renderLiveCenter();
    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(1);
    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(1);

    const search = renderer.root.findByProps({ id: 'shift-search' });
    act(() => search.props.onChange({ currentTarget: { value: 'Анна' } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushRequests();

    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(2);
    expect(fetchShiftBalancesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'Анна' }),
      requestWithSignal(),
    );
    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(1);
    expect(String(replaceState.mock.calls.at(-1)?.[2])).toContain('sb_q=%D0%90%D0%BD%D0%BD%D0%B0');
    expect(String(replaceState.mock.calls.at(-1)?.[2])).not.toContain('bb_q=');
  });

  it('applies a BigBag select immediately and leaves the shift request untouched', async () => {
    const { renderer } = await renderLiveCenter();
    const usageState = renderer.root.findByProps({ id: 'big-bag-filter-usageState' });

    act(() => usageState.props.onChange({ currentTarget: { value: 'closed' } }));
    await flushRequests();

    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(2);
    expect(fetchBigBagEvidenceMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ usageState: 'closed' }),
      requestWithSignal(),
    );
    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(1);
  });

  it('resets only the changed table cursor and resets both on a period change', async () => {
    const { renderer } = await renderLiveCenter();
    const pagination = (label: string) =>
      renderer.root.findAllByType('nav').find((nav) => nav.props['aria-label'] === label)!;
    const shiftPagination = pagination('Страницы баланса смен');
    const bigBagPagination = pagination('Страницы фактов BigBag');

    act(() => {
      shiftPagination
        .findAllByType('button')
        .find((button) => nodeText(button) === 'Следующая')!
        .props.onClick();
      bigBagPagination
        .findAllByType('button')
        .find((button) => nodeText(button) === 'Следующая')!
        .props.onClick();
    });
    await flushRequests();
    expect(fetchShiftBalancesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'shift-next' }),
      requestWithSignal(),
    );
    expect(fetchBigBagEvidenceMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'bag-next' }),
      requestWithSignal(),
    );

    const shiftCalls = fetchShiftBalancesMock.mock.calls.length;
    const bigBagCalls = fetchBigBagEvidenceMock.mock.calls.length;
    const search = renderer.root.findByProps({ id: 'shift-search' });
    act(() => search.props.onChange({ currentTarget: { value: 'ночь' } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flushRequests();

    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(shiftCalls + 1);
    expect(fetchShiftBalancesMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ cursor: expect.anything() }),
      requestWithSignal(),
    );
    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(bigBagCalls);
    expect(
      renderer.root
        .findAllByType('nav')
        .find((nav) => nav.props['aria-label'] === 'Страницы фактов BigBag')
        ?.findByType('span')
        .children.join(''),
    ).toBe('Стр. 2');

    const shiftCallsBeforePeriod = fetchShiftBalancesMock.mock.calls.length;
    const bigBagCallsBeforePeriod = fetchBigBagEvidenceMock.mock.calls.length;
    const previousShiftQuery = fetchShiftBalancesMock.mock.calls.at(-1)?.[0];
    act(() => findButton(renderer.root, 'Неделя').props.onClick());
    await flushRequests();
    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(shiftCallsBeforePeriod + 1);
    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(bigBagCallsBeforePeriod + 1);
    expect(fetchShiftBalancesMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ cursor: expect.anything() }),
      requestWithSignal(),
    );
    expect(fetchBigBagEvidenceMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ cursor: expect.anything() }),
      requestWithSignal(),
    );
    const currentShiftQuery = fetchShiftBalancesMock.mock.calls.at(-1)?.[0];
    expect(currentShiftQuery).toEqual(
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    );
    expect(currentShiftQuery?.from).not.toBe(previousShiftQuery?.from);
    expect(pagination('Страницы баланса смен').findByType('span').children.join('')).toBe('Стр. 1');
    expect(pagination('Страницы фактов BigBag').findByType('span').children.join('')).toBe(
      'Стр. 1',
    );
  });

  it('shows a local invalid range and does not request that table', async () => {
    const { renderer } = await renderLiveCenter();
    const initialCalls = fetchShiftBalancesMock.mock.calls.length;
    const minimum = renderer.root.findByProps({ id: 'shift-filter-producedKgMin' });
    const maximum = renderer.root.findByProps({ id: 'shift-filter-producedKgMax' });

    act(() => {
      minimum.props.onChange({ currentTarget: { value: '20' } });
      maximum.props.onChange({ currentTarget: { value: '10' } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flushRequests();

    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(initialCalls);
    expect(
      renderer.root
        .findAllByProps({ role: 'alert' })
        .some((alert) => nodeText(alert).includes('Минимум не может быть больше максимума')),
    ).toBe(true);
    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(1);
  });

  it('debounces BigBag text and number filters and blocks an invalid numeric range', async () => {
    const { renderer } = await renderLiveCenter();
    const initialShiftCalls = fetchShiftBalancesMock.mock.calls.length;
    const search = renderer.root.findByProps({ id: 'big-bag-search' });

    act(() => search.props.onChange({ currentTarget: { value: 'ПНД' } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushRequests();
    expect(fetchBigBagEvidenceMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'ПНД' }),
      requestWithSignal(),
    );
    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(initialShiftCalls);

    const callsBeforeInvalid = fetchBigBagEvidenceMock.mock.calls.length;
    const minimum = renderer.root.findByProps({ id: 'big-bag-filter-currentKgMin' });
    const maximum = renderer.root.findByProps({ id: 'big-bag-filter-currentKgMax' });
    act(() => {
      minimum.props.onChange({ currentTarget: { value: '50' } });
      maximum.props.onChange({ currentTarget: { value: '10' } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flushRequests();
    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(callsBeforeInvalid);
    expect(
      renderer.root
        .findAllByProps({ role: 'alert' })
        .some((alert) => nodeText(alert).includes('Минимум не может быть больше максимума')),
    ).toBe(true);
  });

  it('keeps the previous rows on screen while a refetch is in flight', async () => {
    // Emptying the table on every committed keystroke is what reads as blinking.
    fetchShiftBalancesMock.mockResolvedValueOnce({
      items: [shiftEvidenceRow],
      nextCursor: null,
    });
    const { renderer } = await renderLiveCenter('?role=director&sb_open=1');
    const previousSignal = fetchShiftBalancesMock.mock.calls.at(-1)?.[1]?.signal;
    expect(
      renderer.root.findByType(DirectorProductionCharts).props.shiftBalanceState.page,
    ).not.toBeNull();
    expect(nodeText(renderer.root)).toContain('Ахметов Булат');
    const pending = deferred<Awaited<ReturnType<typeof fetchDirectorShiftBalances>>>();
    fetchShiftBalancesMock.mockImplementationOnce(() => pending.promise);

    act(() =>
      renderer.root
        .findByProps({ id: 'shift-search' })
        .props.onChange({ currentTarget: { value: 'Анна' } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const currentSignal = fetchShiftBalancesMock.mock.calls.at(-1)?.[1]?.signal;
    expect(previousSignal?.aborted).toBe(true);
    expect(currentSignal?.aborted).toBe(false);

    const shiftDetails = renderer.root
      .findAllByType('details')
      .find((details) =>
        details
          .findAllByType('summary')
          .some((summary) => nodeText(summary).includes('Баланс смен')),
      );
    expect(shiftDetails?.props.open).toBe(true);
    expect(renderer.root.findByType(DirectorProductionCharts).findAllByType('table')).toHaveLength(
      2,
    );
    // The rows stay put and the table simply reports itself busy.
    expect(
      renderer.root.findByType(DirectorProductionCharts).props.shiftBalanceState.page,
    ).not.toBeNull();
    expect(nodeText(renderer.root)).toContain('Ахметов Булат');
    expect(
      renderer.root
        .findAllByProps({ role: 'status' })
        .some((status) => nodeText(status).includes('Загрузка баланса смен')),
    ).toBe(false);

    await act(async () => pending.resolve({ items: [], nextCursor: null }));
    expect(shiftDetails?.props.open).toBe(true);
    expect(renderer.root.findByType(DirectorProductionCharts).findAllByType('table')).toHaveLength(
      2,
    );
    expect(nodeText(renderer.root)).not.toContain('Ахметов Булат');
  });

  it('keeps the previous rows on screen when a refetch fails', async () => {
    fetchShiftBalancesMock.mockResolvedValueOnce({
      items: [shiftEvidenceRow],
      nextCursor: null,
    });
    const { renderer } = await renderLiveCenter('?role=director&sb_open=1');
    fetchShiftBalancesMock.mockRejectedValueOnce(new Error('offline'));

    act(() =>
      renderer.root
        .findByProps({ id: 'shift-search' })
        .props.onChange({ currentTarget: { value: 'Анна' } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await flushRequests();

    expect(nodeText(renderer.root)).toContain('Ахметов Булат');
    expect(nodeText(renderer.root)).toContain('Не удалось загрузить данные');
  });

  it('retries a rejected shift request without reloading BigBag evidence', async () => {
    fetchShiftBalancesMock.mockRejectedValueOnce(new Error('offline'));
    const { renderer } = await renderLiveCenter('?role=director&sb_open=1');
    const shiftCalls = fetchShiftBalancesMock.mock.calls.length;
    const bigBagCalls = fetchBigBagEvidenceMock.mock.calls.length;
    fetchShiftBalancesMock.mockResolvedValueOnce({ items: [], nextCursor: null });

    act(() => findButton(renderer.root, 'Повторить баланс смен').props.onClick());
    await flushRequests();

    expect(fetchShiftBalancesMock).toHaveBeenCalledTimes(shiftCalls + 1);
    expect(fetchBigBagEvidenceMock).toHaveBeenCalledTimes(bigBagCalls);
  });

  it('serializes namespaced table state and restores the same fields on remount', async () => {
    const { renderer, replaceState } = await renderLiveCenter('?role=director&sb_open=1');
    act(() => {
      renderer.root
        .findByProps({ id: 'shift-filter-status' })
        .props.onChange({ currentTarget: { value: 'mismatch' } });
      renderer.root
        .findByProps({ id: 'big-bag-filter-usageState' })
        .props.onChange({ currentTarget: { value: 'closed' } });
    });
    await flushRequests();

    const href = String(replaceState.mock.calls.at(-1)?.[2]);
    expect(href).toContain('sb_open=1');
    expect(href).not.toContain('bb_open=1');
    expect(href).toContain('sb_status=mismatch');
    expect(href).toContain('bb_usageState=closed');
    expect(href).not.toMatch(/[?&]status=/u);

    const search = href.slice(href.indexOf('?'));
    vi.stubGlobal('window', {
      location: { search, pathname: '/', hash: '' },
      history: { replaceState: vi.fn() },
    });
    const markup = renderToStaticMarkup(
      <ManagementCenter dashboard={dashboard} onDrilldown={vi.fn()} useLiveData />,
    );
    expect(markup.match(/<details[^>]*open=""/gu)).toHaveLength(1);
    expect(markup).toContain('value="mismatch" selected=""');
    expect(markup).toContain('value="closed" selected=""');
  });
});
