import { Fragment, useCallback, useEffect, useId, useReducer, useRef } from 'react';

import {
  loadBusinessProductionRolls,
  type BusinessPerformanceRollItem,
} from '../../api/businessPerformance';
import type { CommercialPerformanceProductionItem } from '../../api/commercialPerformance';
import { RollCostCell } from '../production/RollCostCell';

type CacheEntry = {
  items: BusinessPerformanceRollItem[];
  firstPageIds: string[];
  nextCursor: string | null;
  consumedCursors: string[];
  pendingCursor: string | null;
  requestId: number;
  status: 'loading' | 'ready' | 'error';
  loadingMore: boolean;
  error: string | null;
};

type DrilldownState = {
  expanded: boolean;
  activeKey: string;
  cache: Record<string, CacheEntry>;
};

type DrilldownAction =
  | { type: 'toggle' }
  | { type: 'activate'; key: string }
  | {
      type: 'request';
      key: string;
      requestId: number;
      append: boolean;
      preserveCurrent: boolean;
      cursor: string | null;
    }
  | {
      type: 'success';
      key: string;
      requestId: number;
      append: boolean;
      preserveCurrent: boolean;
      requestedCursor: string | null;
      items: BusinessPerformanceRollItem[];
      nextCursor: string | null;
    }
  | {
      type: 'failure';
      key: string;
      requestId: number;
      append: boolean;
      preserveCurrent: boolean;
      error: string;
    };

type ActiveRequest = {
  key: string;
  requestId: number;
  controller: AbortController;
};

const ROLL_PAGE_LIMIT = 20;
const MAX_CONSUMED_CURSORS = 100;
const NUMBER_FORMAT = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 3,
});
const MOSCOW_DATE_TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const PRODUCTION_STATUS_LABELS: Readonly<Record<string, string>> = {
  not_started: 'Не начато',
  needs_production: 'Требуется производство',
  needs_approval: 'На согласовании',
  in_production: 'В производстве',
  ready: 'Готово',
  active: 'В работе',
  new: 'Новый',
  queued: 'В очереди',
  assigned: 'Назначен',
  in_progress: 'В работе',
  in_work: 'В работе',
  blocked: 'Заблокирован',
  deferred: 'Отложен',
  defect: 'Брак',
  ready_for_warehouse: 'Готов к передаче',
  warehouse_handed_off: 'Передан на склад',
  warehouse_accepted: 'Принят складом',
  warehouse_delivered: 'Выдан со склада',
  handover_ready: 'Готов к передаче',
  warehouse_pending: 'Ждёт склад',
  done: 'Завершён',
  completed: 'Завершён',
};

export function productionStatusLabel(status: string) {
  const normalized = status.trim();
  if (!normalized) return 'Не определён';
  return (
    PRODUCTION_STATUS_LABELS[normalized] ??
    (/[А-ЯЁа-яё]/u.test(normalized) ? normalized : 'Не определён')
  );
}

function formatMoscowTimestamp(value: string | null) {
  if (value === null) return '—';
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? MOSCOW_DATE_TIME_FORMAT.format(timestamp) : '—';
}

function uniqueRolls(
  current: readonly BusinessPerformanceRollItem[],
  incoming: readonly BusinessPerformanceRollItem[],
) {
  const seen = new Set(current.map((item) => item.id));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  ];
}

function revalidateFirstPage(
  current: readonly BusinessPerformanceRollItem[],
  incoming: readonly BusinessPerformanceRollItem[],
  previousFirstPageIds: readonly string[],
) {
  const replacedIds = new Set([...previousFirstPageIds, ...incoming.map((item) => item.id)]);
  return [...incoming, ...current.filter((item) => !replacedIds.has(item.id))];
}

function appendConsumedCursor(current: readonly string[], cursor: string | null) {
  if (!cursor || current.includes(cursor) || current.length >= MAX_CONSUMED_CURSORS) {
    return [...current];
  }
  return [...current, cursor];
}

function safeNextCursor({
  candidate,
  requested,
  consumed,
}: {
  candidate: string | null;
  requested: string | null;
  consumed: readonly string[];
}) {
  if (
    !candidate ||
    candidate === requested ||
    consumed.includes(candidate) ||
    consumed.length >= MAX_CONSUMED_CURSORS
  ) {
    return null;
  }
  return candidate;
}

function reducer(state: DrilldownState, action: DrilldownAction): DrilldownState {
  if (action.type === 'toggle') {
    return { ...state, expanded: !state.expanded };
  }

  if (action.type === 'activate') {
    if (state.activeKey === action.key) return state;
    return { ...state, activeKey: action.key, cache: {} };
  }

  if (state.activeKey !== action.key) return state;

  if (action.type === 'request') {
    const current = state.cache[action.key];
    return {
      ...state,
      cache: {
        [action.key]: action.append
          ? {
              items: current?.items ?? [],
              firstPageIds: current?.firstPageIds ?? [],
              nextCursor: current?.nextCursor ?? null,
              consumedCursors: current?.consumedCursors ?? [],
              pendingCursor: action.cursor,
              requestId: action.requestId,
              status: 'ready',
              loadingMore: true,
              error: null,
            }
          : action.preserveCurrent && current
            ? {
                ...current,
                pendingCursor: null,
                requestId: action.requestId,
                status: 'ready',
                loadingMore: false,
                error: null,
              }
            : {
                items: [],
                firstPageIds: [],
                nextCursor: null,
                consumedCursors: [],
                pendingCursor: null,
                requestId: action.requestId,
                status: 'loading',
                loadingMore: false,
                error: null,
              },
      },
    };
  }

  const current = state.cache[action.key];
  if (!current || current.requestId !== action.requestId) return state;

  if (action.type === 'success') {
    if (current.pendingCursor !== action.requestedCursor) return state;
    const consumedCursors = action.append
      ? appendConsumedCursor(current.consumedCursors, action.requestedCursor)
      : [];
    return {
      ...state,
      cache: {
        [action.key]: {
          items: action.append
            ? uniqueRolls(current.items, action.items)
            : action.preserveCurrent
              ? revalidateFirstPage(current.items, action.items, current.firstPageIds)
              : uniqueRolls([], action.items),
          firstPageIds: action.append ? current.firstPageIds : action.items.map((item) => item.id),
          nextCursor: safeNextCursor({
            candidate: action.nextCursor,
            requested: action.requestedCursor,
            consumed: consumedCursors,
          }),
          consumedCursors,
          pendingCursor: null,
          requestId: action.requestId,
          status: 'ready',
          loadingMore: false,
          error: null,
        },
      },
    };
  }

  return {
    ...state,
    cache: {
      [action.key]: {
        ...current,
        status: action.append || action.preserveCurrent ? 'ready' : 'error',
        loadingMore: false,
        pendingCursor: null,
        error: action.preserveCurrent ? null : action.error,
      },
    },
  };
}

function number(value: number | null, unit = '') {
  return value === null ? '—' : `${NUMBER_FORMAT.format(value)}${unit}`;
}

function recordedWeight(value: number | null) {
  return value === null ? 'Не зафиксирован' : number(value, ' кг');
}

function parameterChips(item: BusinessPerformanceRollItem) {
  const parameters = item.parameters;
  return [
    parameters.filmType ? `Тип: ${parameters.filmType}` : null,
    parameters.actualThicknessUm === null
      ? null
      : `Факт: ${number(parameters.actualThicknessUm, ' мкм')}`,
    parameters.accountingThicknessUm === null
      ? null
      : `Бух.: ${number(parameters.accountingThicknessUm, ' мкм')}`,
    parameters.widthMm === null ? null : `Ширина: ${number(parameters.widthMm, ' мм')}`,
    parameters.plannedLengthM === null
      ? null
      : `Метраж: ${number(parameters.plannedLengthM, ' м')}`,
    parameters.weightKg === null ? null : `Вес: ${number(parameters.weightKg, ' кг')}`,
  ].filter((chip): chip is string => chip !== null);
}

function RollTable({ items }: { items: readonly BusinessPerformanceRollItem[] }) {
  return (
    <table className="production-roll-drilldown-table">
      <thead>
        <tr>
          <th scope="col">Рулон</th>
          <th scope="col">Заказ</th>
          <th scope="col">Параметры</th>
          <th scope="col">Оператор</th>
          <th scope="col">Станок</th>
          <th scope="col">Приоритет</th>
          <th scope="col">План нетто</th>
          <th scope="col">Факт нетто</th>
          <th scope="col">Факт брутто</th>
          <th scope="col">Отклонение</th>
          <th scope="col">Статус</th>
          <th scope="col">Себестоимость</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const chips = parameterChips(item);
          return (
            <tr
              key={item.id}
              className="production-roll-drilldown-item"
              data-order-status={item.lifecycleStatus}
            >
              <td>
                <strong>{item.rollName}</strong>
                {item.rollCode ? <small>{item.rollCode}</small> : null}
              </td>
              <td>{item.orderNumber}</td>
              <td>
                {chips.length > 0 ? (
                  <div className="production-roll-parameters">
                    {chips.map((chip) => (
                      <span key={chip} className="production-roll-parameter-chip">
                        {chip}
                      </span>
                    ))}
                  </div>
                ) : (
                  '—'
                )}
              </td>
              <td>{item.operatorName ?? '—'}</td>
              <td>{item.machineName ?? '—'}</td>
              <td>{number(item.priority)}</td>
              <td>{recordedWeight(item.weights.plannedNetKg)}</td>
              <td>{recordedWeight(item.weights.actualNetKg)}</td>
              <td>{recordedWeight(item.weights.actualGrossKg)}</td>
              <td>
                {item.weights.deviationKg === null
                  ? 'Не зафиксирован'
                  : `${item.weights.deviationKg > 0 ? '+' : ''}${number(
                      item.weights.deviationKg,
                      ' кг',
                    )}`}
              </td>
              <td>{productionStatusLabel(item.lifecycleStatus)}</td>
              <td className="production-roll-cost-column">
                <RollCostCell cost={item.productionCost} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ProductionRollDrilldown({
  item,
  refreshGeneration,
  showCustomer,
}: {
  item: CommercialPerformanceProductionItem;
  refreshGeneration: string | number;
  showCustomer: boolean;
}) {
  const cacheKey = item.id;
  const refreshRequestKey = JSON.stringify([cacheKey, refreshGeneration]);
  const lastRequestedRefreshKey = useRef(refreshRequestKey);
  const activeKeyRef = useRef(cacheKey);
  activeKeyRef.current = cacheKey;
  const [state, dispatch] = useReducer(reducer, cacheKey, (activeKey) => ({
    expanded: false,
    activeKey,
    cache: {},
  }));
  const requestSequence = useRef(0);
  const activeRequest = useRef<ActiveRequest | null>(null);
  const detailsId = `production-rolls-${useId().replaceAll(':', '')}`;
  const entry = state.activeKey === cacheKey ? state.cache[cacheKey] : undefined;

  const requestPage = useCallback(
    (cursor: string | undefined, append: boolean, preserveCurrent = false) => {
      activeRequest.current?.controller.abort();
      const controller = new AbortController();
      const requestId = ++requestSequence.current;
      const request: ActiveRequest = { key: cacheKey, requestId, controller };
      activeRequest.current = request;
      dispatch({
        type: 'request',
        key: cacheKey,
        requestId,
        append,
        preserveCurrent,
        cursor: cursor ?? null,
      });

      void loadBusinessProductionRolls(
        item.id,
        { cursor, limit: ROLL_PAGE_LIMIT },
        { signal: controller.signal },
      )
        .then((page) => {
          if (controller.signal.aborted || activeKeyRef.current !== cacheKey) return;
          dispatch({
            type: 'success',
            key: cacheKey,
            requestId,
            append,
            preserveCurrent,
            requestedCursor: cursor ?? null,
            items: page.items,
            nextCursor: page.nextCursor,
          });
        })
        .catch(() => {
          if (controller.signal.aborted || activeKeyRef.current !== cacheKey) return;
          dispatch({
            type: 'failure',
            key: cacheKey,
            requestId,
            append,
            preserveCurrent,
            error: 'Не удалось загрузить рулоны.',
          });
        })
        .finally(() => {
          if (activeRequest.current === request) activeRequest.current = null;
        });
    },
    [cacheKey, item.id],
  );

  useEffect(() => {
    dispatch({ type: 'activate', key: cacheKey });
    return () => activeRequest.current?.controller.abort();
  }, [cacheKey]);

  useEffect(() => {
    if (state.expanded && state.activeKey === cacheKey && !entry) {
      requestPage(undefined, false);
    }
  }, [cacheKey, entry, requestPage, state.activeKey, state.expanded]);

  useEffect(() => {
    if (!state.expanded) {
      lastRequestedRefreshKey.current = refreshRequestKey;
      return;
    }
    if (
      state.activeKey !== cacheKey ||
      !entry ||
      lastRequestedRefreshKey.current === refreshRequestKey
    ) {
      return;
    }
    lastRequestedRefreshKey.current = refreshRequestKey;
    requestPage(undefined, false, entry.status === 'ready');
  }, [cacheKey, entry, refreshRequestKey, requestPage, state.activeKey, state.expanded]);

  const retry = () => {
    if (entry?.items.length && entry.nextCursor) {
      requestPage(entry.nextCursor, true);
      return;
    }
    requestPage(undefined, false);
  };

  return (
    <Fragment>
      <tr
        className="production-roll-drilldown-order-row"
        data-order-status={item.lifecycleStatus}
      >
        <td>
          <button
            type="button"
            className="production-roll-drilldown-toggle"
            aria-expanded={state.expanded}
            aria-controls={detailsId}
            aria-label={`${state.expanded ? 'Скрыть' : 'Показать'} рулоны заказа ${
              item.orderNumber
            }`}
            onClick={() => dispatch({ type: 'toggle' })}
          >
            <span
              className="production-roll-drilldown-chevron"
              aria-hidden="true"
              data-expanded={state.expanded}
            >
              ▶
            </span>
            <span className="production-roll-drilldown-order">{item.orderNumber}</span>
          </button>
        </td>
        {showCustomer ? <td>{item.counterpartyName ?? 'На запас'}</td> : null}
        <td>{number(item.plannedRollCount)}</td>
        <td>{number(item.completedRollCount)}</td>
        <td>{number(item.plannedKg, ' кг')}</td>
        <td>{number(item.actualKg, ' кг')}</td>
        <td>{number(item.defectKg, ' кг')}</td>
        <td>{number(item.defectRollCount ?? 0)}</td>
        <td>{formatMoscowTimestamp(item.createdAt)}</td>
        <td>{formatMoscowTimestamp(item.completedAt)}</td>
        <td>{productionStatusLabel(item.lifecycleStatus)}</td>
      </tr>
      {state.expanded ? (
        <tr className="production-roll-drilldown-detail-row">
          <td
            id={detailsId}
            colSpan={showCustomer ? 11 : 10}
            className="production-roll-drilldown-cell"
            aria-live="polite"
            aria-busy={!entry || entry.status === 'loading' || entry.loadingMore}
          >
            {!entry || entry.status === 'loading' ? (
              <p className="production-roll-drilldown-message">Загрузка рулонов…</p>
            ) : entry.status === 'error' ? (
              <div className="production-roll-drilldown-message">
                <span>{entry.error}</span>
                <button type="button" onClick={retry}>
                  Повторить
                </button>
              </div>
            ) : entry.items.length === 0 ? (
              <p className="production-roll-drilldown-message">Рулонов пока нет.</p>
            ) : (
              <>
                <RollTable items={entry.items} />
                {entry.error ? (
                  <div className="production-roll-drilldown-message">
                    <span>{entry.error}</span>
                    <button type="button" onClick={retry}>
                      Повторить
                    </button>
                  </div>
                ) : null}
                {entry.nextCursor && !entry.error ? (
                  <div className="production-roll-drilldown-pagination">
                    <button
                      type="button"
                      disabled={entry.loadingMore}
                      onClick={() => requestPage(entry.nextCursor ?? undefined, true)}
                    >
                      {entry.loadingMore ? 'Загружаем…' : 'Загрузить ещё'}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
