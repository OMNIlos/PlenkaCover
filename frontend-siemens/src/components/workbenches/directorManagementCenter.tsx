import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  fetchDirectorAnalytics,
  fetchDirectorBigBagEvidence,
  fetchDirectorShiftBalances,
  type DirectorAnalyticsBucket,
  type DirectorAnalyticsBigBagEvidenceQuery,
  type DirectorAnalyticsShiftEvidenceQuery,
  type ServerDirectorAnalyticsBigBagEvidencePage,
  type ServerDirectorAnalyticsShiftBalancePage,
} from '../../api/director';
import type {
  DirectorControlFinanceRow,
  DirectorControlPeriodMetric,
  DirectorControlPeriodRow,
  DirectorControlProductionRow,
  DirectorControlReport,
  DirectorDashboardDrilldown,
  DirectorDashboardProjection,
  DirectorDefectBagRegister,
  DirectorDefectBagStatus,
} from '../../domain/runtime';
import {
  defectBagDisplayLabel,
  defectBagShiftDisplayLabel,
  defectBagTypeLabel,
} from '../../domain/defectBagLabels';
import {
  DirectorAnalyticsRequestGate,
  createDirectorAnalyticsRange,
  defaultDirectorAnalyticsBucket,
  directorAnalyticsReducer,
  initialDirectorAnalyticsState,
  normalizeDirectorDateRange,
  parseDirectorAnalyticsLocation,
  serializeDirectorAnalyticsLocation,
  updateDirectorDateRangeBoundary,
  type DirectorAnalyticsLocationState,
  type DirectorDateRange,
  type DirectorRangePreset,
} from '../../domain/runtime/directorAnalyticsView';
import {
  buildBigBagEvidenceQuery,
  buildShiftEvidenceQuery,
  emptyBigBagEvidenceFilterDraft,
  emptyShiftEvidenceFilterDraft,
  parseDirectorEvidenceLocation,
  serializeDirectorEvidenceLocation,
  validateEvidenceFilterDraft,
  type DirectorBigBagEvidenceFilterDraft,
  type DirectorEvidenceLocationState,
  type DirectorShiftEvidenceFilterDraft,
} from '../../domain/runtime/directorEvidenceFilters';
import {
  PlenkiDataTable,
  PlenkiMetricStrip,
  type PlenkiDataTableColumn,
} from '../plenki-ui/PlenkiPrimitives';
import { SiemensIcon } from '../shell/SiemensIcon';
import {
  DirectorProductionCharts,
  type DirectorEvidencePageState,
} from './DirectorProductionCharts';

type FinanceSortKey = 'remaining' | 'amount' | 'due' | 'customer';
type FinanceSortColumn = {
  key: FinanceSortKey;
  label: string;
  align?: 'num';
};
type DirectorPeriodView = Pick<DirectorControlReport, 'periodMetrics' | 'periodRows'>;
type DirectorDefectBagRow = DirectorDefectBagRegister['recent'][number];
type CursorNavigation = { queryKey: string; stack: string[] };

const financeSortColumns: FinanceSortColumn[] = [
  { key: 'customer', label: 'Заказ / клиент' },
  { key: 'amount', label: 'Сумма', align: 'num' },
  { key: 'remaining', label: 'Остаток', align: 'num' },
  { key: 'due', label: 'Срок / статус' },
];
const defectBagStatusMeta: Record<
  DirectorDefectBagStatus,
  { label: string; metricLabel: string; tone: 'risk' | 'warning' | 'production' | 'neutral' }
> = {
  weighed: { label: 'QR не готов', metricLabel: 'Ждут QR', tone: 'risk' },
  ready_for_warehouse: {
    label: 'Ожидает приёмки',
    metricLabel: 'Ждут склад',
    tone: 'warning',
  },
  received: { label: 'На складе', metricLabel: 'На складе', tone: 'production' },
  shipped: { label: 'Отгружен', metricLabel: 'Отгружено', tone: 'neutral' },
};
const demoDirectorRangeToday = new Date(2026, 6, 6);
const directorRangePresets: Array<{ id: DirectorRangePreset; label: string }> = [
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
];
const directorAnalyticsBuckets: Array<{ id: DirectorAnalyticsBucket; label: string }> = [
  { id: 'day', label: 'Дни' },
  { id: 'week', label: 'Недели' },
  { id: 'month', label: 'Месяцы' },
];
const demoCalendarMonths = [
  { month: 5, year: 2026, title: 'Июнь 2026' },
  { month: 6, year: 2026, title: 'Июль 2026' },
];
const shiftImmediateFilterKeys = new Set<keyof DirectorShiftEvidenceFilterDraft>([
  'status',
  'freshness',
]);
const bigBagImmediateFilterKeys = new Set<keyof DirectorBigBagEvidenceFilterDraft>([
  'bigBagStatus',
  'usageState',
  'status',
  'freshness',
]);

function currentDirectorAnalyticsLocation(useLiveData: boolean): DirectorAnalyticsLocationState {
  if (!useLiveData || typeof window === 'undefined') return {};
  return parseDirectorAnalyticsLocation(window.location.search);
}

function restoredDirectorRange(
  location: DirectorAnalyticsLocationState,
  useLiveData: boolean,
): DirectorDateRange {
  if (useLiveData && location.from && location.to) {
    return normalizeDirectorDateRange({
      preset: location.period ?? 'custom',
      from: location.from,
      to: location.to,
    });
  }
  const preset = location.period && location.period !== 'custom' ? location.period : 'month';
  return selectedDirectorRangeForPreset(preset, useLiveData);
}

function currentDirectorEvidenceLocation(useLiveData: boolean): DirectorEvidenceLocationState {
  if (!useLiveData || typeof window === 'undefined') {
    return parseDirectorEvidenceLocation('');
  }
  return parseDirectorEvidenceLocation(window.location.search);
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => setDebounced(value), delayMs);
    return () => globalThis.clearTimeout(timeout);
  }, [delayMs, value]);

  return debounced;
}

function useDirectorEvidencePage<TQuery extends { cursor?: string }, TPage>(
  enabled: boolean,
  query: TQuery | null,
  queryKey: string,
  cursor: string | undefined,
  retryGeneration: number,
  load: (query: TQuery, options?: { signal?: AbortSignal }) => Promise<TPage>,
): DirectorEvidencePageState<TPage> {
  const [state, setState] = useState<DirectorEvidencePageState<TPage>>({
    status: 'loading',
    page: null,
    error: null,
  });
  const requestGate = useRef(new DirectorAnalyticsRequestGate());

  useEffect(() => {
    if (!enabled || query === null) {
      setState({ status: 'loading', page: null, error: null });
      return undefined;
    }
    const generation = requestGate.current.begin();
    const controller = new AbortController();
    // Keep the rows on screen while the next page is in flight: dropping them
    // emptied the table on every committed keystroke, which reads as blinking.
    setState((current) => ({ status: 'loading', page: current.page, error: null }));
    void load({ ...query, cursor }, { signal: controller.signal }).then(
      (page) => {
        if (controller.signal.aborted || !requestGate.current.isCurrent(generation)) return;
        setState({ status: 'ready', page, error: null });
      },
      () => {
        if (controller.signal.aborted || !requestGate.current.isCurrent(generation)) return;
        setState((current) => ({
          status: 'error',
          page: current.page,
          error: 'Не удалось загрузить данные. Повторите запрос.',
        }));
      },
    );
    return () => {
      controller.abort();
      requestGate.current.invalidate(generation);
    };
  }, [cursor, enabled, load, queryKey, retryGeneration]);

  return state;
}

export function ManagementCenter({
  dashboard,
  onDrilldown,
  useLiveData = false,
}: {
  dashboard: DirectorDashboardProjection;
  onDrilldown: (drilldown: DirectorDashboardDrilldown) => void;
  useLiveData?: boolean;
}) {
  const [financeSort, setFinanceSort] = useState<FinanceSortKey>('remaining');
  const [initialLocation] = useState<DirectorAnalyticsLocationState>(() =>
    currentDirectorAnalyticsLocation(useLiveData),
  );
  const [initialEvidenceLocation] = useState<DirectorEvidenceLocationState>(() =>
    currentDirectorEvidenceLocation(useLiveData),
  );
  const [dateRange, setDateRange] = useState<DirectorDateRange>(() =>
    restoredDirectorRange(initialLocation, useLiveData),
  );
  const [analyticsBucket, setAnalyticsBucket] = useState<DirectorAnalyticsBucket>(() => {
    if (initialLocation.bucket) return initialLocation.bucket;
    return defaultDirectorAnalyticsBucket(restoredDirectorRange(initialLocation, useLiveData));
  });
  const [shiftDraft, setShiftDraft] = useState<DirectorShiftEvidenceFilterDraft>(
    initialEvidenceLocation.shift,
  );
  const [bigBagDraft, setBigBagDraft] = useState<DirectorBigBagEvidenceFilterDraft>(
    initialEvidenceLocation.bigBag,
  );
  const [committedShiftDraft, setCommittedShiftDraft] = useState<DirectorShiftEvidenceFilterDraft>(
    initialEvidenceLocation.shift,
  );
  const [committedBigBagDraft, setCommittedBigBagDraft] =
    useState<DirectorBigBagEvidenceFilterDraft>(initialEvidenceLocation.bigBag);
  const [shiftOpen, setShiftOpen] = useState(initialEvidenceLocation.shiftOpen);
  const [bigBagOpen, setBigBagOpen] = useState(initialEvidenceLocation.bigBagOpen);
  const debouncedShiftDraft = useDebouncedValue(shiftDraft, 300);
  const debouncedBigBagDraft = useDebouncedValue(bigBagDraft, 300);
  useEffect(() => setCommittedShiftDraft(debouncedShiftDraft), [debouncedShiftDraft]);
  useEffect(() => setCommittedBigBagDraft(debouncedBigBagDraft), [debouncedBigBagDraft]);
  const shiftErrors = useMemo(() => validateEvidenceFilterDraft(shiftDraft), [shiftDraft]);
  const bigBagErrors = useMemo(() => validateEvidenceFilterDraft(bigBagDraft), [bigBagDraft]);
  const [analyticsState, dispatchAnalytics] = useReducer(
    directorAnalyticsReducer,
    initialDirectorAnalyticsState,
  );
  const analyticsRequestGate = useRef(new DirectorAnalyticsRequestGate());
  const [analyticsRetryGeneration, setAnalyticsRetryGeneration] = useState(0);
  const [shiftRetryGeneration, setShiftRetryGeneration] = useState(0);
  const [bigBagRetryGeneration, setBigBagRetryGeneration] = useState(0);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const evidenceQueryContext = useMemo(
    () => ({
      from: dateRange.from,
      to: dateRange.to,
      bucket: analyticsBucket,
      limit: 20,
    }),
    [analyticsBucket, dateRange.from, dateRange.to],
  );
  const shiftQueryBuild = useMemo(
    () => buildShiftEvidenceQuery(evidenceQueryContext, committedShiftDraft),
    [committedShiftDraft, evidenceQueryContext],
  );
  const bigBagQueryBuild = useMemo(
    () => buildBigBagEvidenceQuery(evidenceQueryContext, committedBigBagDraft),
    [committedBigBagDraft, evidenceQueryContext],
  );
  const shiftEvidenceQuery = shiftQueryBuild.ok ? shiftQueryBuild.query : null;
  const bigBagEvidenceQuery = bigBagQueryBuild.ok ? bigBagQueryBuild.query : null;
  const shiftEvidenceQueryKey = shiftQueryBuild.ok
    ? JSON.stringify(shiftQueryBuild.query)
    : `invalid:${JSON.stringify(committedShiftDraft)}`;
  const bigBagEvidenceQueryKey = bigBagQueryBuild.ok
    ? JSON.stringify(bigBagQueryBuild.query)
    : `invalid:${JSON.stringify(committedBigBagDraft)}`;
  const [shiftNavigation, setShiftNavigation] = useState<CursorNavigation>({
    queryKey: '',
    stack: [],
  });
  const [bigBagNavigation, setBigBagNavigation] = useState<CursorNavigation>({
    queryKey: '',
    stack: [],
  });
  const shiftCursorStack =
    shiftNavigation.queryKey === shiftEvidenceQueryKey ? shiftNavigation.stack : [];
  const bigBagCursorStack =
    bigBagNavigation.queryKey === bigBagEvidenceQueryKey ? bigBagNavigation.stack : [];
  const shiftBalanceState = useDirectorEvidencePage<
    DirectorAnalyticsShiftEvidenceQuery,
    ServerDirectorAnalyticsShiftBalancePage
  >(
    useLiveData && shiftQueryBuild.ok,
    shiftEvidenceQuery,
    shiftEvidenceQueryKey,
    shiftCursorStack.at(-1),
    shiftRetryGeneration,
    fetchDirectorShiftBalances,
  );
  const bigBagState = useDirectorEvidencePage<
    DirectorAnalyticsBigBagEvidenceQuery,
    ServerDirectorAnalyticsBigBagEvidencePage
  >(
    useLiveData && bigBagQueryBuild.ok,
    bigBagEvidenceQuery,
    bigBagEvidenceQueryKey,
    bigBagCursorStack.at(-1),
    bigBagRetryGeneration,
    fetchDirectorBigBagEvidence,
  );
  const report = dashboard.controlReport;
  const demoPeriodView = useMemo<DirectorPeriodView>(
    () =>
      useLiveData
        ? { periodMetrics: [], periodRows: [] }
        : buildDirectorPeriodView(report, dateRange),
    [report, dateRange, useLiveData],
  );
  const calendarMonths = useMemo(
    () => (useLiveData ? liveDirectorCalendarMonths(dateRange.to) : demoCalendarMonths),
    [dateRange.to, useLiveData],
  );
  const liveToday = createDirectorAnalyticsRange('today').to;
  const financeRows = useMemo(
    () => sortFinanceRows(report.financeRows, financeSort),
    [report.financeRows, financeSort],
  );
  useEffect(() => {
    if (!useLiveData) return undefined;

    const generation = analyticsRequestGate.current.begin();
    const controller = new AbortController();
    dispatchAnalytics({ type: 'load_started', generation });
    void fetchDirectorAnalytics(
      {
        from: dateRange.from,
        to: dateRange.to,
        bucket: analyticsBucket,
      },
      { signal: controller.signal },
    ).then(
      (response) => {
        if (controller.signal.aborted || !analyticsRequestGate.current.isCurrent(generation))
          return;
        dispatchAnalytics({ type: 'load_succeeded', generation, response });
      },
      () => {
        if (controller.signal.aborted || !analyticsRequestGate.current.isCurrent(generation))
          return;
        dispatchAnalytics({
          type: 'load_failed',
          generation,
          message: 'Не удалось загрузить подтверждённые данные. Повторите запрос.',
        });
      },
    );

    return () => {
      controller.abort();
      analyticsRequestGate.current.invalidate(generation);
    };
  }, [analyticsBucket, analyticsRetryGeneration, dateRange.from, dateRange.to, useLiveData]);

  useEffect(() => {
    if (!useLiveData || typeof window === 'undefined') return;
    const analyticsSearch = serializeDirectorAnalyticsLocation(
      {
        period: dateRange.preset,
        from: dateRange.from,
        to: dateRange.to,
        bucket: analyticsBucket,
      },
      window.location.search,
    );
    const search = serializeDirectorEvidenceLocation(analyticsSearch, {
      shiftOpen,
      bigBagOpen,
      shift: shiftDraft,
      bigBag: bigBagDraft,
    });
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search}${window.location.hash}`,
    );
  }, [analyticsBucket, bigBagDraft, bigBagOpen, dateRange, shiftDraft, shiftOpen, useLiveData]);

  const selectPreset = (preset: DirectorRangePreset) => {
    const range = selectedDirectorRangeForPreset(preset, useLiveData);
    setDateRange(range);
    if (useLiveData) setAnalyticsBucket(defaultDirectorAnalyticsBucket(range));
    setCalendarOpen(false);
  };
  const updateDateRange = (range: DirectorDateRange) => {
    setDateRange(
      useLiveData ? normalizeDirectorDateRange(range) : normalizeDemoDirectorRange(range),
    );
  };
  const updateShiftFilter = (key: keyof DirectorShiftEvidenceFilterDraft, value: string) => {
    setShiftDraft((current) => ({ ...current, [key]: value }));
    if (shiftImmediateFilterKeys.has(key)) {
      setCommittedShiftDraft((current) => ({ ...current, [key]: value }));
    }
  };
  const updateBigBagFilter = (key: keyof DirectorBigBagEvidenceFilterDraft, value: string) => {
    setBigBagDraft((current) => ({ ...current, [key]: value }));
    if (bigBagImmediateFilterKeys.has(key)) {
      setCommittedBigBagDraft((current) => ({ ...current, [key]: value }));
    }
  };
  const resetShiftFilters = () => {
    setShiftDraft(emptyShiftEvidenceFilterDraft);
    setCommittedShiftDraft(emptyShiftEvidenceFilterDraft);
  };
  const resetBigBagFilters = () => {
    setBigBagDraft(emptyBigBagEvidenceFilterDraft);
    setCommittedBigBagDraft(emptyBigBagEvidenceFilterDraft);
  };
  const nextShiftPage = () => {
    if (shiftBalanceState.status !== 'ready' || !shiftBalanceState.page.nextCursor) return;
    setShiftNavigation((current) => ({
      queryKey: shiftEvidenceQueryKey,
      stack: [
        ...(current.queryKey === shiftEvidenceQueryKey ? current.stack : []),
        shiftBalanceState.page.nextCursor!,
      ],
    }));
  };
  const previousShiftPage = () => {
    setShiftNavigation((current) => ({
      queryKey: shiftEvidenceQueryKey,
      stack: current.queryKey === shiftEvidenceQueryKey ? current.stack.slice(0, -1) : [],
    }));
  };
  const nextBigBagPage = () => {
    if (bigBagState.status !== 'ready' || !bigBagState.page.nextCursor) return;
    setBigBagNavigation((current) => ({
      queryKey: bigBagEvidenceQueryKey,
      stack: [
        ...(current.queryKey === bigBagEvidenceQueryKey ? current.stack : []),
        bigBagState.page.nextCursor!,
      ],
    }));
  };
  const previousBigBagPage = () => {
    setBigBagNavigation((current) => ({
      queryKey: bigBagEvidenceQueryKey,
      stack: current.queryKey === bigBagEvidenceQueryKey ? current.stack.slice(0, -1) : [],
    }));
  };
  const periodTableColumns: Array<PlenkiDataTableColumn<DirectorControlPeriodRow>> = [
    {
      id: 'metric',
      header: 'Показатель',
      dataLabel: 'Показатель',
      render: (row) => <strong>{row.label}</strong>,
    },
    { id: 'current', header: 'Текущий', dataLabel: 'Текущий', render: (row) => row.currentLabel },
    {
      id: 'previous',
      header: 'Предыдущий',
      dataLabel: 'Предыдущий',
      render: (row) => row.previousLabel,
    },
    {
      id: 'delta',
      header: 'Дельта',
      dataLabel: 'Дельта',
      render: (row) => <span className="management-period-delta">{row.deltaLabel}</span>,
    },
    { id: 'source', header: 'Источник', dataLabel: 'Источник', render: (row) => row.sourceLabel },
    {
      id: 'action',
      header: 'Переход',
      dataLabel: 'Переход',
      render: (row) => (
        <button type="button" onClick={() => onDrilldown(row.drilldown)}>
          Открыть
        </button>
      ),
    },
  ];
  const financeTableColumns: Array<PlenkiDataTableColumn<DirectorControlFinanceRow>> = [
    ...financeSortColumns.slice(0, 2).map(
      (column): PlenkiDataTableColumn<DirectorControlFinanceRow> => ({
        id: column.key,
        header: column.label,
        dataLabel: column.label,
        align: column.align === 'num' ? 'right' : 'left',
        sortable: true,
        sortDirection: financeSort === column.key ? 'desc' : 'none',
        onSort: () => setFinanceSort(column.key),
        ariaLabel: `Сортировать финансы: ${column.label}`,
        render: (row) =>
          column.key === 'customer' ? (
            <span className="management-report-order">
              <strong>{row.orderId}</strong>
              <span>{row.customerLabel}</span>
            </span>
          ) : (
            row.amountLabel
          ),
      }),
    ),
    {
      id: 'paid',
      header: 'Оплачено',
      dataLabel: 'Оплачено',
      align: 'right',
      render: (row) => row.paidLabel,
    },
    ...financeSortColumns.slice(2).map(
      (column): PlenkiDataTableColumn<DirectorControlFinanceRow> => ({
        id: column.key,
        header: column.label,
        dataLabel: column.label,
        align: column.align === 'num' ? 'right' : 'left',
        sortable: true,
        sortDirection: financeSort === column.key ? 'desc' : 'none',
        onSort: () => setFinanceSort(column.key),
        ariaLabel: `Сортировать финансы: ${column.label}`,
        render: (row) => {
          if (column.key === 'remaining') return <strong>{row.remainingLabel}</strong>;
          if (column.key === 'due') {
            return (
              <span className="management-report-stack">
                <strong>{row.dueLabel}</strong>
                <small>{row.statusLabel}</small>
              </span>
            );
          }
          return row.customerLabel;
        },
      }),
    ),
    { id: 'source', header: 'Источник', dataLabel: 'Источник', render: (row) => row.sourceLabel },
    {
      id: 'risk',
      header: 'Риск',
      dataLabel: 'Риск',
      render: (row) => (
        <span className={`management-risk-pill severity-${row.severity}`}>{row.riskLabel}</span>
      ),
    },
  ];
  return (
    <section className="surface management-center" aria-label="Управленческий отчет директора">
      <div className="management-control-board">
        <header className="management-control-header is-report">
          <div>
            <span className="eyebrow">Контроль</span>
            <h2>{useLiveData ? 'Производственная аналитика' : 'Финансы и производство'}</h2>
          </div>
          <div className="management-report-actions" aria-label="Переходы директора">
            <button
              type="button"
              onClick={() =>
                onDrilldown({ section: 'Требуют решения', view: 'decisions', filter: 'all' })
              }
            >
              <SiemensIcon name="tasks-open" size="16" />
              <span>Очередь решений</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onDrilldown({ section: 'Финансы', view: 'decisions', filter: 'money' })
              }
            >
              <SiemensIcon name="table-tag" size="16" />
              <span>Финансы</span>
            </button>
          </div>
        </header>

        {!useLiveData ? (
          <PlenkiMetricStrip
            className="management-executive-kpis"
            cardClassName="management-report-kpi"
            metrics={report.kpis.map((kpi) => ({
              id: kpi.id,
              label: kpi.label,
              value: kpi.value,
              caption: kpi.caption,
              tone: kpi.tone,
              actionLabel: kpi.actionLabel,
              onClick: () => onDrilldown(kpi.drilldown),
            }))}
          />
        ) : null}

        <section className="management-period-comparison" aria-label="Периодическая статистика">
          <header className="management-period-toolbar">
            <div>
              <span className="eyebrow">Периоды</span>
              <strong>{formatDirectorRange(dateRange)}</strong>
              <small>
                {useLiveData
                  ? 'Время: Москва'
                  : 'Демонстрационный расчёт · сравнение с предыдущим периодом'}
              </small>
            </div>
            <div className="management-period-controls">
              {useLiveData ? (
                <label className="management-period-granularity">
                  <span>Группировка</span>
                  <select
                    aria-label="Группировка"
                    value={analyticsBucket}
                    onChange={(event) =>
                      setAnalyticsBucket(event.currentTarget.value as DirectorAnalyticsBucket)
                    }
                  >
                    {directorAnalyticsBuckets.map((bucket) => (
                      <option key={bucket.id} value={bucket.id}>
                        {bucket.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="management-period-selector" aria-label="Быстрый выбор периода">
                {directorRangePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`management-period-chip ${dateRange.preset === preset.id ? 'is-selected' : ''}`}
                    aria-pressed={dateRange.preset === preset.id}
                    onClick={() => selectPreset(preset.id)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="management-period-calendar-wrap">
                <button
                  type="button"
                  className={`management-period-calendar-toggle ${dateRange.preset === 'custom' ? 'is-selected' : ''}`}
                  aria-expanded={calendarOpen}
                  onClick={() => setCalendarOpen((open) => !open)}
                >
                  <SiemensIcon name="calendar" size="16" />
                  <span>
                    {dateRange.from} — {dateRange.to}
                  </span>
                </button>
                {calendarOpen ? (
                  <DirectorPeriodCalendar
                    range={dateRange}
                    months={calendarMonths}
                    maxDate={useLiveData ? liveToday : undefined}
                    onPreset={selectPreset}
                    onChange={updateDateRange}
                    onClose={() => setCalendarOpen(false)}
                  />
                ) : null}
              </div>
            </div>
          </header>

          {useLiveData ? (
            <DirectorProductionCharts
              state={analyticsState}
              shiftBalanceState={shiftBalanceState}
              bigBagState={bigBagState}
              shiftPageNumber={shiftCursorStack.length + 1}
              bigBagPageNumber={bigBagCursorStack.length + 1}
              onPreviousShiftPage={previousShiftPage}
              onNextShiftPage={nextShiftPage}
              onPreviousBigBagPage={previousBigBagPage}
              onNextBigBagPage={nextBigBagPage}
              shiftOpen={shiftOpen}
              bigBagOpen={bigBagOpen}
              shiftFilters={shiftDraft}
              bigBagFilters={bigBagDraft}
              shiftErrors={shiftErrors}
              bigBagErrors={bigBagErrors}
              onShiftOpenChange={setShiftOpen}
              onBigBagOpenChange={setBigBagOpen}
              onShiftFilterChange={updateShiftFilter}
              onBigBagFilterChange={updateBigBagFilter}
              onResetShiftFilters={resetShiftFilters}
              onResetBigBagFilters={resetBigBagFilters}
              onRetryShift={() => setShiftRetryGeneration((generation) => generation + 1)}
              onRetryBigBag={() => setBigBagRetryGeneration((generation) => generation + 1)}
              onRetry={() => setAnalyticsRetryGeneration((generation) => generation + 1)}
            />
          ) : (
            <div className="management-period-dashboard">
              <PlenkiMetricStrip
                className="management-period-summary-strip"
                cardClassName="management-period-summary"
                metrics={demoPeriodView.periodMetrics.map((metric) => ({
                  id: metric.id,
                  label: metric.label,
                  value: metric.currentLabel,
                  caption: metric.deltaLabel,
                  tone: metric.tone,
                  actionLabel: metric.actionLabel,
                  onClick: () => onDrilldown(metric.drilldown),
                }))}
              />
            </div>
          )}
        </section>

        <DirectorDefectBagsPanel defectBags={useLiveData ? report.defectBags : null} />

        {!useLiveData ? (
          <section className="management-period-table-panel" aria-label="Производство по периодам">
            <div className="management-section-header">
              <span className="eyebrow">Производство по периодам</span>
            </div>
            <PlenkiDataTable
              caption="Производство по периодам"
              tableClassName="management-period-table"
              columns={periodTableColumns}
              rows={demoPeriodView.periodRows}
              getRowKey={(row) => row.id}
            />
          </section>
        ) : null}

        {!useLiveData ? (
          <section
            className="management-report-layout"
            aria-label="Финансовая отчетность и производство"
          >
            <div className="management-finance-report">
              <div className="management-section-header">
                <span className="eyebrow">Финансовая таблица</span>
              </div>
              <PlenkiDataTable
                caption="Финансовая таблица"
                tableClassName="management-report-table"
                columns={financeTableColumns}
                rows={financeRows}
                getRowKey={(row) => row.id}
                getRowClassName={(row) => `severity-${row.severity}`}
                onRowClick={(row) =>
                  onDrilldown({
                    section: 'Финансы',
                    view: 'decisions',
                    filter: 'money',
                    targetObjectId: row.id,
                  })
                }
              />
            </div>

            <aside className="management-production-report" aria-label="Производственная сводка">
              <div className="management-section-header">
                <span className="eyebrow">Производство</span>
              </div>
              <div className="management-production-list">
                {report.productionRows.map((row) => (
                  <DirectorProductionRow key={row.id} row={row} />
                ))}
              </div>
              <button
                type="button"
                onClick={() =>
                  onDrilldown({ section: 'Производство', view: 'orders', filter: 'risk' })
                }
              >
                <SiemensIcon name="tasks-open" size="16" />
                <span>Открыть производство</span>
              </button>
            </aside>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function DirectorPeriodCalendar({
  range,
  months,
  minDate,
  maxDate,
  onPreset,
  onChange,
  onClose,
}: {
  range: DirectorDateRange;
  months: Array<{ month: number; year: number; title: string }>;
  minDate?: string;
  maxDate?: string;
  onPreset: (preset: DirectorRangePreset) => void;
  onChange: (range: DirectorDateRange) => void;
  onClose: () => void;
}) {
  return (
    <div className="management-period-calendar" role="dialog" aria-label="Выбор периода">
      <div className="management-period-calendar-head">
        <div>
          <strong>Период отчета</strong>
          <span>{formatDirectorRange(range)}</span>
        </div>
        <button type="button" aria-label="Закрыть календарь" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="management-period-calendar-body">
        <div className="management-period-calendar-presets">
          {directorRangePresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={range.preset === preset.id ? 'is-selected' : ''}
              aria-pressed={range.preset === preset.id}
              onClick={() => onPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className={range.preset === 'custom' ? 'is-selected' : ''}
            aria-pressed={range.preset === 'custom'}
            onClick={() => onChange({ ...range, preset: 'custom' })}
          >
            Диапазон
          </button>
        </div>
        <div className="management-period-calendar-main">
          <div className="management-period-date-fields">
            <label>
              <span>Начало</span>
              <input
                type="date"
                value={range.from}
                min={minDate}
                max={maxDate}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!isDirectorDateWithinBounds(value, minDate, maxDate)) return;
                  onChange(updateDirectorDateRangeBoundary(range, 'from', value));
                }}
              />
            </label>
            <label>
              <span>Конец</span>
              <input
                type="date"
                value={range.to}
                min={minDate}
                max={maxDate}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!isDirectorDateWithinBounds(value, minDate, maxDate)) return;
                  onChange(updateDirectorDateRangeBoundary(range, 'to', value));
                }}
              />
            </label>
          </div>
          <div className="management-period-months">
            {months.map((month) => (
              <DirectorCalendarMonth
                key={`${month.year}-${month.month}`}
                month={month.month}
                year={month.year}
                title={month.title}
                range={range}
                minDate={minDate}
                maxDate={maxDate}
                onSelect={(day) => onChange(selectDirectorCalendarDay(range, day))}
              />
            ))}
          </div>
          <div className="management-period-calendar-foot">
            <button type="button" onClick={onClose}>
              Применить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DirectorCalendarMonth({
  month,
  year,
  title,
  range,
  minDate,
  maxDate,
  onSelect,
}: {
  month: number;
  year: number;
  title: string;
  range: DirectorDateRange;
  minDate?: string;
  maxDate?: string;
  onSelect: (day: string) => void;
}) {
  const days = buildCalendarMonthDays(year, month);

  return (
    <div className="management-period-month">
      <strong>{title}</strong>
      <div className="management-period-weekdays">
        {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="management-period-days">
        {days.map((day, index) =>
          day ? (
            <button
              key={day}
              type="button"
              aria-label={`Выбрать дату ${formatDirectorFullDate(day)}`}
              className={[
                isDirectorRangeEdge(range, day) ? 'is-edge' : '',
                isDirectorRangeInner(range, day) ? 'is-range' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={
                (minDate !== undefined && day < minDate) || (maxDate !== undefined && day > maxDate)
              }
              onClick={() => onSelect(day)}
            >
              {Number(day.slice(-2))}
            </button>
          ) : (
            <span key={`blank-${index}`} />
          ),
        )}
      </div>
    </div>
  );
}

function DirectorProductionRow({ row }: { row: DirectorControlProductionRow }) {
  return (
    <div className="management-production-row">
      <span>{row.label}</span>
      <strong>{row.factLabel}</strong>
      <dl>
        <div>
          <dt>План</dt>
          <dd>{row.planLabel}</dd>
        </div>
        <div>
          <dt>Отклонение</dt>
          <dd>{row.varianceLabel}</dd>
        </div>
      </dl>
      <small>{row.sourceLabel}</small>
    </div>
  );
}

export function DirectorDefectBagsPanel({
  defectBags,
}: {
  defectBags?: DirectorDefectBagRegister | null;
}) {
  if (!defectBags) return null;
  const statusMetrics = [
    {
      id: 'defect-bags-total',
      label: 'Всего мешков',
      value: `${defectBags.totalCount}`,
      caption: formatDirectorDefectBagKg(defectBags.totalWeightKg),
      tone: 'neutral' as const,
    },
    ...defectBags.byStatus.map((summary) => ({
      id: `defect-bags-${summary.status}`,
      label: defectBagStatusMeta[summary.status].metricLabel,
      value: `${summary.count}`,
      caption: formatDirectorDefectBagKg(summary.weightKg),
      tone: defectBagStatusMeta[summary.status].tone,
    })),
  ];
  const typeMetrics = [
    ...defectBags.byType.map((summary) => ({
      id: `defect-bags-type-${summary.defectType}`,
      label: defectBagTypeLabel(summary.defectType),
      value: `${summary.count}`,
      caption: formatDirectorDefectBagKg(summary.weightKg),
      tone: 'neutral' as const,
    })),
    {
      id: 'defect-bags-type-unclassified',
      label: 'Тип не указан',
      value: `${defectBags.unclassified.count}`,
      caption: formatDirectorDefectBagKg(defectBags.unclassified.weightKg),
      tone: 'neutral' as const,
    },
  ];
  const columns: Array<PlenkiDataTableColumn<DirectorDefectBagRow>> = [
    {
      id: 'bag',
      header: 'Мешок / статус',
      dataLabel: 'Мешок / статус',
      render: (row) => (
        <span className="management-report-stack">
          <strong>{defectBagDisplayLabel(row)}</strong>
          <small>
            {defectBagStatusMeta[row.status].label} · {defectBagTypeLabel(row.defectType)}
          </small>
        </span>
      ),
    },
    {
      id: 'weight',
      header: 'Вес',
      dataLabel: 'Вес',
      align: 'right',
      render: (row) => (
        <span className="management-report-stack">
          <strong>{formatDirectorDefectBagKg(row.weightKg)}</strong>
        </span>
      ),
    },
    {
      id: 'origin',
      header: 'Оператор / пост',
      dataLabel: 'Оператор / пост',
      render: (row) => (
        <span className="management-report-stack">
          <strong>{row.operatorName}</strong>
          <small>
            {row.postCode} · {row.postName}
          </small>
        </span>
      ),
    },
    {
      id: 'shift',
      header: 'Смена',
      dataLabel: 'Смена',
      render: (row) => defectBagShiftDisplayLabel(row),
    },
    {
      id: 'weighed',
      header: 'Взвешен',
      dataLabel: 'Взвешен',
      render: (row) => formatDirectorDefectBagTimestamp(row.weighedAt),
    },
    {
      id: 'received',
      header: 'Приёмка',
      dataLabel: 'Приёмка',
      render: (row) => directorDefectBagMovement(row.receivedAt, row.receivedBy),
    },
    {
      id: 'shipped',
      header: 'Отгрузка',
      dataLabel: 'Отгрузка',
      render: (row) => directorDefectBagMovement(row.shippedAt, row.shippedBy),
    },
  ];

  return (
    <section className="management-period-table-panel" aria-label="Мешки брака">
      <div className="management-section-header">
        <span className="eyebrow">Складская логистика</span>
        <strong>Мешки брака</strong>
        <small>
          Полная сводка · показано: {defectBags.recent.length}
          {defectBags.hasMore ? ' из более чем 100' : ''}
        </small>
      </div>
      <PlenkiMetricStrip
        className="management-executive-kpis"
        cardClassName="management-report-kpi"
        metrics={statusMetrics}
      />
      <span className="eyebrow">По типу брака</span>
      <PlenkiMetricStrip
        className="management-executive-kpis"
        cardClassName="management-report-kpi"
        metrics={typeMetrics}
      />
      <PlenkiDataTable
        caption="Реестр мешков брака"
        className="management-report-table-wrap"
        tableClassName="management-report-table"
        columns={columns}
        rows={defectBags.recent}
        getRowKey={(row) => row.id}
        empty={
          <div className="plenki-empty-state">
            <strong>Мешков брака пока нет</strong>
            <span>Они появятся после взвешивания оператором.</span>
          </div>
        }
      />
    </section>
  );
}

function formatDirectorDefectBagKg(value: number) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value)} кг`;
}

function formatDirectorDefectBagTimestamp(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}

function directorDefectBagMovement(at: string | null, actor: string | null) {
  if (!at) return '—';
  return (
    <span className="management-report-stack">
      <strong>{formatDirectorDefectBagTimestamp(at)}</strong>
      <small>{actor ?? 'Исполнитель не указан'}</small>
    </span>
  );
}

function sortFinanceRows(rows: DirectorControlFinanceRow[], sortKey: FinanceSortKey) {
  const descendingNullable = (left: number | null, right: number | null) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right - left;
  };
  const ascendingNullable = (left: number | null, right: number | null) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left - right;
  };
  return [...rows].sort((a, b) => {
    if (sortKey === 'customer') return a.customerLabel.localeCompare(b.customerLabel, 'ru');
    if (sortKey === 'amount') return descendingNullable(a.amountValue, b.amountValue);
    if (sortKey === 'due') {
      return (
        ascendingNullable(a.dueRank, b.dueRank) ||
        descendingNullable(a.remainingValue, b.remainingValue)
      );
    }
    return descendingNullable(a.remainingValue, b.remainingValue);
  });
}

function directorIso(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function directorDateFromIso(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, (month || 1) - 1, day || 1);
  return date;
}

function selectedDirectorRangeForPreset(
  preset: DirectorRangePreset,
  useLiveData: boolean,
): DirectorDateRange {
  return useLiveData ? createDirectorAnalyticsRange(preset) : demoDirectorRangeForPreset(preset);
}

function demoDirectorRangeForPreset(preset: DirectorRangePreset): DirectorDateRange {
  if (preset === 'today') {
    const today = directorIso(demoDirectorRangeToday);
    return { preset, from: today, to: today };
  }
  if (preset === 'yesterday') {
    const yesterday = directorIso(addDirectorDays(demoDirectorRangeToday, -1));
    return { preset, from: yesterday, to: yesterday };
  }
  if (preset === 'week') {
    return {
      preset,
      from: directorIso(addDirectorDays(demoDirectorRangeToday, -6)),
      to: directorIso(demoDirectorRangeToday),
    };
  }
  if (preset === 'custom') {
    return { preset, from: '2026-07-01', to: directorIso(demoDirectorRangeToday) };
  }
  return {
    preset: 'month',
    from: '2026-07-01',
    to: directorIso(demoDirectorRangeToday),
  };
}

function addDirectorDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function normalizeDemoDirectorRange(range: DirectorDateRange): DirectorDateRange {
  if (range.from <= range.to) return range;
  return { ...range, from: range.to, to: range.from };
}

function liveDirectorCalendarMonths(today: string) {
  const current = directorDateFromIso(today);
  const starts = [
    new Date(current.getFullYear(), current.getMonth() - 1, 1),
    new Date(current.getFullYear(), current.getMonth(), 1),
  ];
  return starts.map((start) => ({
    month: start.getMonth(),
    year: start.getFullYear(),
    title: new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(start),
  }));
}

function formatDirectorRange(range: DirectorDateRange) {
  if (range.from === range.to) return formatDirectorShortDate(range.from);
  return `${formatDirectorShortDate(range.from)} — ${formatDirectorShortDate(range.to)}`;
}

function formatDirectorShortDate(value: string) {
  const date = directorDateFromIso(value);
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date);
}

function formatDirectorFullDate(value: string) {
  const date = directorDateFromIso(value);
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function buildDirectorPeriodView(
  report: DirectorControlReport,
  range: DirectorDateRange,
): DirectorPeriodView {
  const config = directorRangeComparisonConfig(range);
  const periodMetrics = report.periodMetrics.map((metric) =>
    scaleDirectorPeriodMetric(metric, config),
  );
  return {
    periodMetrics,
    periodRows: report.periodRows.map((row) => scaleDirectorPeriodRow(row, periodMetrics, config)),
  };
}

function directorRangeComparisonConfig(range: DirectorDateRange) {
  const days = countDirectorDays(range);
  const monthDaysToDate = countDirectorDays(demoDirectorRangeForPreset('month'));
  const baseCurrentRatio = Math.max(0.12, Math.min(1, days / monthDaysToDate));
  const preset = range.preset;
  if (preset === 'today') {
    return {
      currentRatio: 0.2,
      previousRatio: 0.17,
      previousFromCurrent: true,
      periodLabel: 'Сегодня / вчера',
      stalenessLabel: 'срез дня, обновлено сегодня',
    };
  }
  if (preset === 'yesterday') {
    return {
      currentRatio: 0.17,
      previousRatio: 0.15,
      previousFromCurrent: true,
      periodLabel: 'Вчера / позавчера',
      stalenessLabel: 'архив дня',
    };
  }
  if (preset === 'week') {
    return {
      currentRatio: 1,
      previousRatio: 0.82,
      previousFromCurrent: false,
      periodLabel: 'Неделя / прошлая неделя',
      stalenessLabel: 'срез недели, обновлено сегодня',
    };
  }
  if (preset === 'custom') {
    return {
      currentRatio: baseCurrentRatio,
      previousRatio: Math.max(0.08, baseCurrentRatio * 0.84),
      previousFromCurrent: false,
      periodLabel: `${formatDirectorRange(range)} / предыдущий период`,
      stalenessLabel: 'выбранный диапазон',
    };
  }
  return {
    currentRatio: 1,
    previousRatio: 1,
    previousFromCurrent: false,
    periodLabel: 'Этот месяц / прошлый месяц',
    stalenessLabel: 'архив периода, обновлено сегодня',
  };
}

function countDirectorDays(range: DirectorDateRange) {
  const from = directorDateFromIso(range.from);
  const to = directorDateFromIso(range.to);
  const diff = to.getTime() - from.getTime();
  return Math.max(1, Math.round(diff / 86_400_000) + 1);
}

function scaleDirectorPeriodMetric(
  metric: DirectorControlPeriodMetric,
  config: ReturnType<typeof directorRangeComparisonConfig>,
): DirectorControlPeriodMetric {
  const currentValue = scaleDirectorValue(metric.currentValue, config.currentRatio);
  const previousBase = config.previousFromCurrent ? metric.currentValue : metric.previousValue;
  const previousValue = scaleDirectorValue(previousBase, config.previousRatio);
  return {
    ...metric,
    currentValue,
    previousValue,
    currentLabel: formatDirectorPeriodMetricValue(metric, currentValue),
    previousLabel: formatDirectorPeriodMetricValue(metric, previousValue),
    deltaLabel: signedDirectorPeriodDelta(metric, currentValue, previousValue),
    periodLabel: config.periodLabel,
    stalenessLabel: config.stalenessLabel,
    tone: periodMetricTone(metric, currentValue, previousValue),
  };
}

function scaleDirectorPeriodRow(
  row: DirectorControlPeriodRow,
  metrics: DirectorControlPeriodMetric[],
  config: ReturnType<typeof directorRangeComparisonConfig>,
): DirectorControlPeriodRow {
  const metricByRowId: Record<string, string> = {
    'period-row-rolls': 'period-rolls',
    'period-row-kg': 'period-output',
    'period-row-defects': 'period-defects',
    'period-row-accepted': 'period-rolls',
  };
  const metric = metrics.find((item) => item.id === metricByRowId[row.id]);
  if (metric) {
    return {
      ...row,
      currentLabel:
        metric.id === 'period-penalties'
          ? metric.currentLabel.split(' · ')[0]
          : metric.currentLabel,
      previousLabel:
        metric.id === 'period-penalties'
          ? metric.previousLabel.split(' · ')[0]
          : metric.previousLabel,
      deltaLabel: metric.deltaLabel,
    };
  }

  const currentOpen = scaleDirectorValue(
    parseDirectorNumeric(row.currentLabel),
    config.currentRatio,
  );
  const previousOpen = scaleDirectorValue(
    parseDirectorNumeric(row.previousLabel),
    config.previousRatio,
  );
  return {
    ...row,
    currentLabel: countDirectorLabel(currentOpen, 'рул.'),
    previousLabel: countDirectorLabel(previousOpen, 'рул.'),
    deltaLabel: signedDirectorDelta(currentOpen, previousOpen, (value) =>
      countDirectorLabel(value, 'рул.'),
    ),
  };
}

function scaleDirectorValue(value: number, ratio: number) {
  if (value <= 0) return 0;
  return Math.max(value < 10 ? 0 : 1, Math.round(value * ratio * 10) / 10);
}

function formatDirectorPeriodMetricValue(metric: DirectorControlPeriodMetric, value: number) {
  if (metric.id === 'period-rolls') return countDirectorLabel(value, 'рул.');
  if (metric.id === 'period-output' || metric.id === 'period-defects')
    return directorKgLabel(value);
  if (metric.id === 'period-penalties') {
    const baseAmount = Math.max(1, metric.currentValue);
    const amountRatio = value / baseAmount;
    const baseCount = parseDirectorNumeric(metric.currentLabel);
    return `${countDirectorLabel(scaleDirectorValue(baseCount, amountRatio), 'шт.')} · ${directorMoneyLabel(value)}`;
  }
  return directorMoneyLabel(value);
}

function signedDirectorPeriodDelta(
  metric: DirectorControlPeriodMetric,
  current: number,
  previous: number,
) {
  if (metric.id === 'period-rolls')
    return signedDirectorDelta(current, previous, (value) => countDirectorLabel(value, 'рул.'));
  if (metric.id === 'period-output' || metric.id === 'period-defects')
    return signedDirectorDelta(current, previous, directorKgLabel);
  return signedDirectorDelta(current, previous, directorMoneyLabel);
}

function periodMetricTone(
  metric: DirectorControlPeriodMetric,
  current: number,
  previous: number,
): DirectorControlPeriodMetric['tone'] {
  if (
    metric.id === 'period-defects' ||
    metric.id === 'period-penalties' ||
    metric.id === 'period-overdue'
  ) {
    return current > previous ? 'risk' : 'neutral';
  }
  return metric.tone;
}

function countDirectorLabel(value: number, unit: string) {
  const count = value > 0 && value < 1 ? 1 : Math.max(0, Math.round(value));
  return `${new Intl.NumberFormat('ru-RU').format(count)} ${unit}`;
}

function directorKgLabel(value: number) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Math.max(0, value))} кг`;
}

function directorMoneyLabel(value: number) {
  return `${new Intl.NumberFormat('ru-RU').format(Math.max(0, Math.round(value)))} ₽`;
}

function signedDirectorDelta(
  current: number,
  previous: number,
  formatter: (value: number) => string,
) {
  const delta = Math.round((current - previous) * 10) / 10;
  if (delta === 0) return formatter(0);
  return `${delta > 0 ? '+' : '-'}${formatter(Math.abs(delta))}`;
}

function parseDirectorNumeric(value: string) {
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  const match = normalized.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function buildCalendarMonthDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const days: Array<string | null> = Array.from({ length: mondayOffset }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push(directorIso(new Date(year, month, day)));
  }
  return days;
}

function isDirectorRangeEdge(range: DirectorDateRange, day: string) {
  return day === range.from || day === range.to;
}

function isDirectorRangeInner(range: DirectorDateRange, day: string) {
  return day > range.from && day < range.to;
}

function isDirectorDateWithinBounds(value: string, minDate?: string, maxDate?: string) {
  if (!value) return false;
  if (minDate !== undefined && value < minDate) return false;
  return maxDate === undefined || value <= maxDate;
}

function selectDirectorCalendarDay(range: DirectorDateRange, day: string): DirectorDateRange {
  if (range.preset !== 'custom' || range.from === range.to) {
    return { preset: 'custom', from: day, to: day };
  }
  if (day < range.from) return { preset: 'custom', from: day, to: range.from };
  return { preset: 'custom', from: range.from, to: day };
}
