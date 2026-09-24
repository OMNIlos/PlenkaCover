import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { loadBusinessPerformanceSection } from '../../api/businessPerformance';
import {
  type CommercialPerformanceControl,
  type CommercialPerformanceFinanceItem,
  type CommercialPerformancePage,
  type CommercialPerformanceProductionItem,
  type CommercialPerformanceSection,
  type CommercialPerformanceSource,
} from '../../api/commercialPerformance';
import {
  DirectorProductionPanel,
  type ControlSort,
} from '../../components/workbenches/director-analytics/DirectorProductionPanel';
import { DirectorDefectBagsPanel } from '../../components/workbenches/directorManagementCenter';
import type { DirectorDefectBagRegister } from '../../domain/runtime';
import type {
  DirectorAnalyticsDisplayMode,
  DirectorAnalyticsQualityUnit,
} from '../../components/workbenches/director-analytics/DirectorAnalyticsDetails';
import { businessClockAt } from '../../domain/runtime/businessClock';
import { ProductionRollDrilldown } from './ProductionRollDrilldown';
import { businessPaymentStatusLabel } from './businessPerformancePresentation';
import { BusinessControlEvidence } from './BusinessControlEvidence';
import { SharedWarehouseBusinessTable } from '../warehouse/SharedWarehouseBusinessTable';

export const BUSINESS_PERFORMANCE_SECTIONS = [
  'Контроль',
  'Финансы',
  'Производство',
  'Склад',
] as const satisfies readonly CommercialPerformanceSection[];

type PerformanceSnapshot =
  | { section: 'Контроль'; data: CommercialPerformanceControl }
  | {
      section: 'Финансы';
      data: CommercialPerformancePage<CommercialPerformanceFinanceItem>;
    }
  | {
      section: 'Производство';
      data: CommercialPerformancePage<CommercialPerformanceProductionItem>;
    };

export type BusinessControlRange = {
  from: string;
  to: string;
  bucket: 'day' | 'week' | 'month';
};

const MAX_INCLUSIVE_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

function calendarDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.round(parsed.getTime() / DAY_MS);
}

function dateFromCalendarDay(value: number) {
  const date = new Date(value * DAY_MS);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(
    date.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function isIsoDate(value: string) {
  return calendarDay(value) !== null;
}

function defaultRange(): BusinessControlRange {
  const to = businessClockAt().dateIso;
  const toDay = calendarDay(to);
  if (toDay === null) throw new RangeError('Moscow business date is invalid.');
  return { from: dateFromCalendarDay(toDay - 29), to, bucket: 'day' };
}

function loadSnapshot(
  section: Exclude<CommercialPerformanceSection, 'Склад'>,
  signal: AbortSignal,
  range: BusinessControlRange,
  cursor?: string,
): Promise<PerformanceSnapshot> {
  if (section === 'Контроль') {
    return loadBusinessPerformanceSection(section, range, { signal });
  }
  const query = { from: range.from, to: range.to, cursor, limit: 50 };
  return loadBusinessPerformanceSection(section, query, { signal });
}

function appendSnapshot(
  current: PerformanceSnapshot | null,
  next: PerformanceSnapshot,
): PerformanceSnapshot {
  if (!current || current.section !== next.section) return next;
  if (current.section === 'Финансы' && next.section === 'Финансы') {
    return {
      ...next,
      data: { ...next.data, items: [...current.data.items, ...next.data.items] },
    };
  }
  if (current.section === 'Производство' && next.section === 'Производство') {
    return {
      ...next,
      data: { ...next.data, items: [...current.data.items, ...next.data.items] },
    };
  }
  return next;
}

function sourceLabel(source: CommercialPerformanceSource) {
  const status = {
    ready: 'данные готовы',
    partial: 'данные частичные',
    unavailable: 'данные недоступны',
  }[source.status];
  return `${status} · обновлено ${new Date(source.generatedAt).toLocaleString('ru-RU')}`;
}

function number(value: number | null, unit = '') {
  if (value === null) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value)}${unit}`;
}

function date(value: string | null) {
  return value ? new Date(value).toLocaleDateString('ru-RU') : '—';
}

function EmptyPerformance() {
  return <p className="commercial-performance-empty">Данных за выбранный период нет.</p>;
}

function ControlView({
  data,
  displayMode,
  qualityUnit,
  onDisplayModeChange,
  onQualityUnitChange,
  sort,
  onSortChange,
}: {
  data: CommercialPerformanceControl;
  displayMode: DirectorAnalyticsDisplayMode;
  qualityUnit: DirectorAnalyticsQualityUnit;
  onDisplayModeChange: (mode: DirectorAnalyticsDisplayMode) => void;
  onQualityUnitChange: (unit: DirectorAnalyticsQualityUnit) => void;
  sort: ControlSort | null;
  onSortChange: (sort: ControlSort | null) => void;
}) {
  const metrics = [
    ['Выставлено', number(data.summary.invoicedAmount, ' ₽')],
    ['Оплачено', number(data.summary.paidAmount, ' ₽')],
    ['Осталось оплатить', number(data.summary.receivableAmount, ' ₽')],
    ['Просрочено', number(data.summary.overdueAmount, ' ₽')],
    ['Произведено', number(data.summary.producedKg, ' кг')],
    ['Готовые рулоны', number(data.summary.producedRolls)],
    ['Брак', number(data.summary.defectKg, ' кг')],
    ['Бракованные рулоны', number(data.summary.defectRollCount ?? 0)],
    ['Принято складом', number(data.summary.warehouseAcceptedRolls)],
  ] as const;

  return (
    <>
      <div className="commercial-performance-metrics">
        {metrics.map(([label, value]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <section className="commercial-performance-series" aria-label="Производство по периодам">
        <div className="commercial-performance-view-controls" aria-label="Вид графика">
          <button
            type="button"
            aria-pressed={displayMode === 'chart'}
            onClick={() => onDisplayModeChange('chart')}
          >
            График
          </button>
          <button
            type="button"
            aria-pressed={displayMode === 'table'}
            onClick={() => onDisplayModeChange('table')}
          >
            Таблица
          </button>
          <button
            type="button"
            aria-pressed={qualityUnit === 'kg'}
            onClick={() => onQualityUnitChange('kg')}
          >
            кг
          </button>
          <button
            type="button"
            aria-pressed={qualityUnit === 'count'}
            onClick={() => onQualityUnitChange('count')}
          >
            шт.
          </button>
        </div>
        <DirectorProductionPanel
          series={data.productionQualitySeries}
          accounting={data.accountingProduction}
          displayMode={displayMode}
          qualityUnit={qualityUnit}
          sort={sort}
          onSortChange={onSortChange}
        />
      </section>
    </>
  );
}

function FinanceView({ items }: { items: CommercialPerformanceFinanceItem[] }) {
  if (items.length === 0) return <EmptyPerformance />;
  return (
    <table>
      <thead>
        <tr>
          <th>Заказ</th>
          <th>Контрагент</th>
          <th>Выставлено</th>
          <th>Оплачено</th>
          <th>Осталось</th>
          <th>Ближайший срок</th>
          <th>Условия оплаты</th>
          <th>Статус</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{item.orderNumber}</td>
            <td>{item.counterpartyName ?? '—'}</td>
            <td>{number(item.invoicedAmount, ' ₽')}</td>
            <td>{number(item.paidAmount, ' ₽')}</td>
            <td>{number(item.remainingAmount, ' ₽')}</td>
            <td>{date(item.nextConfirmedDueAt)}</td>
            <td>{item.paymentPlanLabel}</td>
            <td>{businessPaymentStatusLabel(item.paymentStatus)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProductionView({
  items,
  refreshGeneration,
  showCustomer,
}: {
  items: CommercialPerformanceProductionItem[];
  refreshGeneration: string | number;
  showCustomer: boolean;
}) {
  if (items.length === 0) return <EmptyPerformance />;
  return (
    <table>
      <thead>
        <tr>
          <th>Заказ</th>
          {showCustomer ? <th>Заказчик</th> : null}
          <th>План рулонов</th>
          <th>Готово рулонов</th>
          <th>План</th>
          <th>Факт</th>
          <th>Брак, кг</th>
          <th>Брак, рул.</th>
          <th>Создан</th>
          <th>Завершён</th>
          <th>Статус</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <ProductionRollDrilldown
            key={item.id}
            item={item}
            refreshGeneration={refreshGeneration}
            showCustomer={showCustomer}
          />
        ))}
      </tbody>
    </table>
  );
}

export function BusinessPerformanceWorkspace({
  section,
  refreshGeneration = 0,
  role = 'commercial',
  headerAction,
  defectBags,
}: {
  section: CommercialPerformanceSection;
  refreshGeneration?: string | number;
  role?: 'commercial' | 'director';
  headerAction?: ReactNode;
  defectBags?: DirectorDefectBagRegister | null;
}) {
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'refreshing' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const initialRange = useMemo(defaultRange, []);
  const [draftRange, setDraftRange] = useState<BusinessControlRange>(initialRange);
  const [appliedRange, setAppliedRange] = useState<BusinessControlRange>(initialRange);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DirectorAnalyticsDisplayMode>('chart');
  const [qualityUnit, setQualityUnit] = useState<DirectorAnalyticsQualityUnit>('kg');
  const [controlSort, setControlSort] = useState<ControlSort | null>(null);
  const loadMoreController = useRef<AbortController | null>(null);
  const visibleSnapshot = snapshot?.section === section ? snapshot : null;
  const drilldownRefreshGeneration = JSON.stringify([
    refreshGeneration,
    revision,
    appliedRange.from,
    appliedRange.to,
    appliedRange.bucket,
  ]);

  useEffect(() => {
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoadingMore(false);
    if (section === 'Склад') {
      setError(null);
      return;
    }
    const controller = new AbortController();
    setStatus(visibleSnapshot ? 'refreshing' : 'loading');
    setError(null);
    void loadSnapshot(section, controller.signal, appliedRange)
      .then((data) => {
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setStatus('ready');
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить данные.');
        setStatus('error');
      });
    return () => {
      controller.abort();
      loadMoreController.current?.abort();
    };
  }, [appliedRange, refreshGeneration, section, revision]);

  function applyRange() {
    if (!isIsoDate(draftRange.from) || !isIsoDate(draftRange.to)) {
      setRangeError('Укажите корректные даты начала и окончания');
      return;
    }
    if (draftRange.from > draftRange.to) {
      setRangeError('Дата начала не может быть позже даты окончания');
      return;
    }
    const fromDay = calendarDay(draftRange.from);
    const toDay = calendarDay(draftRange.to);
    if (fromDay === null || toDay === null || toDay - fromDay + 1 > MAX_INCLUSIVE_RANGE_DAYS) {
      setRangeError('Период не может превышать 366 календарных дней');
      return;
    }
    setRangeError(null);
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoadingMore(false);
    setSnapshot(null);
    setAppliedRange({ ...draftRange });
  }

  async function loadMore() {
    if (
      !visibleSnapshot ||
      visibleSnapshot.section === 'Контроль' ||
      !visibleSnapshot.data.nextCursor ||
      loadingMore
    ) {
      return;
    }

    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await loadSnapshot(
        visibleSnapshot.section,
        controller.signal,
        appliedRange,
        visibleSnapshot.data.nextCursor,
      );
      if (!controller.signal.aborted) setSnapshot((current) => appendSnapshot(current, next));
    } catch (loadError: unknown) {
      if (!controller.signal.aborted) {
        setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить данные.');
      }
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  }

  if (section === 'Склад') {
    return (
      <section className="commercial-performance-workspace">
        <header>
          <h1>Склад</h1>
          {headerAction}
        </header>
        <div className="commercial-performance-content">
          <SharedWarehouseBusinessTable role={role} refreshGeneration={refreshGeneration} />
        </div>
      </section>
    );
  }

  const rangeEditor = (
    <>
      <div className="commercial-performance-range" role="group" aria-label="Период показателей">
        <label>
          Дата с
          <input
            type="date"
            aria-label="Дата с"
            value={draftRange.from}
            onChange={(event) => {
              setRangeError(null);
              setDraftRange((current) => ({ ...current, from: event.target.value }));
            }}
          />
        </label>
        <label>
          Дата по
          <input
            type="date"
            aria-label="Дата по"
            value={draftRange.to}
            onChange={(event) => {
              setRangeError(null);
              setDraftRange((current) => ({ ...current, to: event.target.value }));
            }}
          />
        </label>
        <label>
          Группировка
          <select
            aria-label="Группировка"
            value={draftRange.bucket}
            onChange={(event) => {
              setRangeError(null);
              setDraftRange((current) => ({
                ...current,
                bucket: event.target.value as BusinessControlRange['bucket'],
              }));
            }}
          >
            <option value="day">День</option>
            <option value="week">Неделя</option>
            <option value="month">Месяц</option>
          </select>
        </label>
        <button type="button" onClick={applyRange}>
          Применить
        </button>
      </div>
      {rangeError && <p role="alert">{rangeError}</p>}
    </>
  );

  if (!visibleSnapshot && status === 'error') {
    return (
      <section className="commercial-performance-workspace" aria-live="polite">
        <header>
          <h1>{section}</h1>
          {headerAction}
        </header>
        {rangeEditor}
        <p role="alert">{error}</p>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          Повторить
        </button>
      </section>
    );
  }

  if (!visibleSnapshot) {
    return (
      <section className="commercial-performance-workspace" aria-busy="true">
        <header>
          <h1>{section}</h1>
          {headerAction}
        </header>
        <p>Загрузка показателей…</p>
      </section>
    );
  }

  const data = visibleSnapshot.data;
  return (
    <section className="commercial-performance-workspace" aria-live="polite">
      <header>
        <div>
          <span className="eyebrow">Бизнес-показатели</span>
          <h1>{section}</h1>
          <p>
            {date(appliedRange.from)} — {date(appliedRange.to)}
          </p>
        </div>
        <div className="commercial-performance-refresh">
          <small>{sourceLabel(data.source)}</small>
          {headerAction ?? (
            <button
              type="button"
              disabled={status === 'refreshing'}
              onClick={() => setRevision((value) => value + 1)}
            >
              Обновить
            </button>
          )}
        </div>
      </header>
      {rangeEditor}
      {error && <p role="alert">{error}</p>}
      <div className="commercial-performance-content">
        {visibleSnapshot.section === 'Контроль' ? (
          <>
            <ControlView
              data={visibleSnapshot.data}
              displayMode={displayMode}
              qualityUnit={qualityUnit}
              onDisplayModeChange={setDisplayMode}
              onQualityUnitChange={setQualityUnit}
              sort={controlSort}
              onSortChange={setControlSort}
            />
            <BusinessControlEvidence
              role={role}
              range={appliedRange}
              refreshGeneration={drilldownRefreshGeneration}
            />
            <DirectorDefectBagsPanel defectBags={role === 'director' ? defectBags : null} />
          </>
        ) : visibleSnapshot.section === 'Финансы' ? (
          <FinanceView items={visibleSnapshot.data.items} />
        ) : (
          <ProductionView
            items={visibleSnapshot.data.items}
            refreshGeneration={drilldownRefreshGeneration}
            showCustomer={role === 'director'}
          />
        )}
      </div>
      {visibleSnapshot.section !== 'Контроль' && visibleSnapshot.data.nextCursor ? (
        <div className="commercial-performance-pagination">
          <button type="button" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? 'Загружаем…' : 'Загрузить ещё'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
