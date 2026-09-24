import { useEffect, useMemo, useReducer, useRef } from 'react';

import type { RawMaterialCatalogItem, RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import { ApiError } from '../../api/client';
import {
  createWarehouseReserveRoll,
  fetchWarehouseInventory,
  fetchWarehouseInventoryRoll,
  type WarehouseInventoryLifecycleStatus,
  type WarehouseInventoryQuery,
  type WarehouseInventoryRollDetail,
  type WarehouseInventoryRollItem,
  type WarehouseInventoryRollPage,
  type WarehouseInventorySortDirection,
  type WarehouseInventorySortKey,
  type WarehouseReserveRoll,
  type WarehouseReserveRollCreateInput,
} from '../../api/warehouse';
import type { MaterialRecipeCatalogStatus } from '../../features/recipes/useMaterialRecipeCatalog';
import {
  PlenkiDataTable,
  PlenkiModal,
  type PlenkiDataTableColumn,
} from '../plenki-ui/PlenkiPrimitives';
import { WarehouseReserveRollCreateModal } from './WarehouseReserveRollCreateModal';

type InventoryView = 'current' | 'processed';

type InventoryFetcher = (
  query: WarehouseInventoryQuery,
  options?: { signal?: AbortSignal },
) => Promise<WarehouseInventoryRollPage>;

type InventoryDetailFetcher = (
  rollId: string,
  options?: { signal?: AbortSignal },
) => Promise<WarehouseInventoryRollDetail>;

export type WarehouseStockWorkspaceProps = {
  fetchPage?: InventoryFetcher;
  fetchDetail?: InventoryDetailFetcher;
  view?: InventoryView;
  onViewChange?: (view: InventoryView) => void;
  canCreate?: boolean;
  materials?: readonly RawMaterialCatalogItem[];
  recipes?: readonly RecipeCatalogItem[];
  catalogStatus?: MaterialRecipeCatalogStatus;
  catalogError?: string | null;
  onReloadCatalog?: () => void;
  createRoll?: (input: WarehouseReserveRollCreateInput) => Promise<WarehouseReserveRoll>;
  showBatchAgeFilters?: boolean;
};

type QueryState = {
  view: InventoryView;
  q: string;
  batch: string;
  minAgeDays: string;
  maxAgeDays: string;
  status: '' | Exclude<WarehouseInventoryLifecycleStatus, 'processed'>;
  counterparty: string;
  sort: WarehouseInventorySortKey;
  direction: WarehouseInventorySortDirection;
};

type WorkspaceState = {
  query: QueryState;
  cursor: string | undefined;
  items: WarehouseInventoryRollItem[];
  nextCursor: string | null;
  listStatus: 'loading' | 'loading_more' | 'ready' | 'error';
  listErrorKind: 'transient' | 'cursor' | null;
  listRevision: number;
  selected: WarehouseInventoryRollItem | null;
  detail: WarehouseInventoryRollDetail | null;
  detailStatus: 'idle' | 'loading' | 'ready' | 'error';
  detailRevision: number;
  createOpen: boolean;
};

type WorkspaceAction =
  | { type: 'query'; patch: Partial<QueryState> }
  | { type: 'load_more' }
  | { type: 'list_started'; append: boolean }
  | { type: 'list_succeeded'; page: WarehouseInventoryRollPage; append: boolean }
  | { type: 'list_failed'; errorKind: 'transient' | 'cursor' }
  | { type: 'retry_list' }
  | { type: 'refresh_list' }
  | { type: 'open_detail'; item: WarehouseInventoryRollItem }
  | { type: 'close_detail' }
  | { type: 'detail_started' }
  | { type: 'detail_succeeded'; detail: WarehouseInventoryRollDetail }
  | { type: 'detail_failed' }
  | { type: 'retry_detail' }
  | { type: 'open_create' }
  | { type: 'close_create' };

const CURRENT_STATUS_OPTIONS: Array<{
  value: QueryState['status'];
  label: string;
}> = [
  { value: '', label: 'Все статусы' },
  { value: 'awaiting_shipment', label: 'Ожидает отгрузки' },
  { value: 'available', label: 'Доступен' },
  { value: 'reserved', label: 'Зарезервирован' },
  { value: 'defect', label: 'Брак' },
  { value: 'delivered', label: 'Выдан' },
];

function initialState(view: InventoryView): WorkspaceState {
  return {
    query: {
      view,
      q: '',
      batch: '',
      minAgeDays: '',
      maxAgeDays: '',
      status: '',
      counterparty: '',
      sort: 'receivedAt',
      direction: 'desc',
    },
    cursor: undefined,
    items: [],
    nextCursor: null,
    listStatus: 'loading',
    listErrorKind: null,
    listRevision: 0,
    selected: null,
    detail: null,
    detailStatus: 'idle',
    detailRevision: 0,
    createOpen: false,
  };
}

function appendUniqueItems(
  current: WarehouseInventoryRollItem[],
  incoming: WarehouseInventoryRollItem[],
): WarehouseInventoryRollItem[] {
  const ids = new Set(current.map((item) => item.id));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (ids.has(item.id)) return false;
      ids.add(item.id);
      return true;
    }),
  ];
}

function reducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'query': {
      const query = { ...state.query, ...action.patch };
      if (query.view === 'processed') query.status = '';
      if (
        Object.entries(action.patch).every(
          ([key, value]) => state.query[key as keyof QueryState] === value,
        )
      ) {
        return state;
      }
      return {
        ...state,
        query,
        cursor: undefined,
        items: [],
        nextCursor: null,
        listStatus: 'loading',
        listErrorKind: null,
        selected: null,
        detail: null,
        detailStatus: 'idle',
      };
    }
    case 'load_more':
      if (!state.nextCursor || state.listStatus !== 'ready') return state;
      return {
        ...state,
        cursor: state.nextCursor,
        listStatus: 'loading_more',
      };
    case 'list_started':
      return {
        ...state,
        listStatus: action.append ? 'loading_more' : 'loading',
        listErrorKind: null,
      };
    case 'list_succeeded':
      return {
        ...state,
        items: action.append
          ? appendUniqueItems(state.items, action.page.items)
          : action.page.items,
        nextCursor: action.page.nextCursor,
        listStatus: 'ready',
        listErrorKind: null,
      };
    case 'list_failed':
      return { ...state, listStatus: 'error', listErrorKind: action.errorKind };
    case 'retry_list':
      return {
        ...state,
        listStatus: state.cursor ? 'loading_more' : 'loading',
        listErrorKind: null,
        listRevision: state.listRevision + 1,
      };
    case 'refresh_list':
      return {
        ...state,
        cursor: undefined,
        items: [],
        nextCursor: null,
        listStatus: 'loading',
        listErrorKind: null,
        listRevision: state.listRevision + 1,
      };
    case 'open_detail':
      return {
        ...state,
        selected: action.item,
        detail: null,
        detailStatus: 'loading',
        detailRevision: 0,
      };
    case 'close_detail':
      return {
        ...state,
        selected: null,
        detail: null,
        detailStatus: 'idle',
      };
    case 'detail_started':
      return { ...state, detailStatus: 'loading' };
    case 'detail_succeeded':
      return { ...state, detail: action.detail, detailStatus: 'ready' };
    case 'detail_failed':
      return { ...state, detailStatus: 'error' };
    case 'retry_detail':
      return {
        ...state,
        detail: null,
        detailStatus: 'loading',
        detailRevision: state.detailRevision + 1,
      };
    case 'open_create':
      return { ...state, createOpen: true };
    case 'close_create':
      return { ...state, createOpen: false };
  }
}

function optionalAge(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function buildQuery(query: QueryState, cursor?: string): WarehouseInventoryQuery {
  const minAgeDays = optionalAge(query.minAgeDays);
  const maxAgeDays = optionalAge(query.maxAgeDays);
  return {
    view: query.view,
    ...(query.q.trim() ? { q: query.q.trim() } : {}),
    ...(query.batch.trim() ? { batch: query.batch.trim() } : {}),
    ...(minAgeDays !== undefined ? { minAgeDays } : {}),
    ...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
    ...(query.view === 'current' && query.status ? { status: query.status } : {}),
    ...(query.counterparty.trim() ? { counterparty: query.counterparty.trim() } : {}),
    sort: query.sort,
    direction: query.direction,
    ...(cursor ? { cursor } : {}),
    limit: 25,
  };
}

function formatKg(value: number | null): string {
  return value === null
    ? 'Нет данных'
    : `${value.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кг`;
}

function formatDate(value: string | null): string {
  if (!value) return 'Нет данных';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Нет данных';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }).format(date);
}

function positionLabel(item: WarehouseInventoryRollItem): string {
  return item.positionSequence === null ? 'Нет данных' : `Позиция ${item.positionSequence}`;
}

function orderLabel(item: WarehouseInventoryRollItem): string {
  if (item.orderNumber !== null) return item.orderNumber;
  return item.origin === 'reserve' ? 'Свободный резерв' : 'Нет данных';
}

function detailSource(detail: WarehouseInventoryRollDetail): string {
  if (detail.provenance.kind === 'client_order') return 'Клиентский заказ';
  if (detail.provenance.kind === 'stock_reserve') return 'Резерв';
  return 'Добавлен вручную';
}

function DetailValue({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value === null || value === '' ? 'Нет данных' : value}</dd>
    </div>
  );
}

function RollDetail({ detail }: { detail: WarehouseInventoryRollDetail }) {
  const specification = detail.specificationDetails;
  return (
    <div className="warehouse-stock-detail">
      <dl className="warehouse-stock-detail-facts">
        <DetailValue label="Заказ" value={orderLabel(detail)} />
        <DetailValue label="Позиция" value={positionLabel(detail)} />
        <DetailValue label="Фактический статус" value={detail.warehouseStatusLabel} />
        <DetailValue label="Следующий маршрут" value={detail.nextRouteLabel} />
        <DetailValue label="Статус учёта" value={detail.lifecycleStatusLabel} />
        <DetailValue label="Контрагент" value={detail.counterpartyName} />
        <DetailValue label="Партия" value={detail.batchCode} />
        <DetailValue
          label="Вес"
          value={detail.weightKg === null ? null : formatKg(detail.weightKg)}
        />
        <DetailValue label="Параметры" value={detail.specification} />
        <DetailValue label="Принят" value={formatDate(detail.receivedAt)} />
        <DetailValue label="Обработан" value={formatDate(detail.processedAt)} />
      </dl>
      <section aria-label="Спецификация рулона">
        <h4>Спецификация</h4>
        <dl className="warehouse-stock-detail-facts">
          <DetailValue label="Тип плёнки" value={specification.filmType} />
          <DetailValue
            label="Фактическая толщина"
            value={
              specification.actualThicknessMicron === null
                ? null
                : `${specification.actualThicknessMicron} мкм`
            }
          />
          <DetailValue
            label="Бухгалтерская толщина"
            value={
              specification.accountingThicknessMicron === null
                ? null
                : `${specification.accountingThicknessMicron} мкм`
            }
          />
          <DetailValue
            label="Ширина"
            value={specification.widthMm === null ? null : `${specification.widthMm} мм`}
          />
          <DetailValue
            label="Плановый метраж"
            value={
              specification.plannedLengthM === null ? null : `${specification.plannedLengthM} м`
            }
          />
          <DetailValue
            label="Нетто"
            value={specification.netKg === null ? null : formatKg(specification.netKg)}
          />
          <DetailValue label="Тип шпули" value={specification.spoolType} />
          <DetailValue label="Бирка" value={specification.birka} />
          <DetailValue label="Рецептура" value={specification.recipeName} />
        </dl>
        {specification.ingredients.length > 0 ? (
          <div className="warehouse-stock-detail-ingredients">
            <strong>Компоненты</strong>
            <ul>
              {specification.ingredients.map((ingredient) => (
                <li key={ingredient}>{ingredient}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      <section aria-label="Источник рулона">
        <h4>Источник</h4>
        <dl className="warehouse-stock-detail-facts">
          <DetailValue label="Тип" value={detailSource(detail)} />
          <DetailValue label="Заказ" value={detail.provenance.orderNumber} />
          <DetailValue label="Партия источника" value={detail.provenance.batchCode} />
        </dl>
      </section>
    </div>
  );
}

export function WarehouseStockWorkspace({
  fetchPage = fetchWarehouseInventory,
  fetchDetail = fetchWarehouseInventoryRoll,
  view: controlledView,
  onViewChange,
  canCreate = false,
  materials = [],
  recipes = [],
  catalogStatus = 'idle',
  catalogError = null,
  onReloadCatalog = () => undefined,
  createRoll = createWarehouseReserveRoll,
  showBatchAgeFilters = true,
}: WarehouseStockWorkspaceProps) {
  const [state, dispatch] = useReducer(reducer, controlledView ?? 'current', initialState);
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);

  useEffect(() => {
    if (controlledView && state.query.view !== controlledView) {
      dispatch({ type: 'query', patch: { view: controlledView } });
    }
  }, [controlledView, state.query.view]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++listGenerationRef.current;
    const append = Boolean(state.cursor);
    dispatch({ type: 'list_started', append });
    void fetchPage(buildQuery(state.query, state.cursor), { signal: controller.signal })
      .then((nextPage) => {
        if (generation === listGenerationRef.current && !controller.signal.aborted) {
          dispatch({ type: 'list_succeeded', page: nextPage, append });
        }
      })
      .catch((error: unknown) => {
        if (generation === listGenerationRef.current && !controller.signal.aborted) {
          dispatch({
            type: 'list_failed',
            errorKind:
              append && error instanceof ApiError && error.status === 400 ? 'cursor' : 'transient',
          });
        }
      });
    return () => {
      controller.abort();
    };
  }, [
    fetchPage,
    state.cursor,
    state.listRevision,
    state.query.batch,
    state.query.counterparty,
    state.query.direction,
    state.query.maxAgeDays,
    state.query.minAgeDays,
    state.query.q,
    state.query.sort,
    state.query.status,
    state.query.view,
  ]);

  useEffect(() => {
    if (!state.selected) return undefined;
    const controller = new AbortController();
    const generation = ++detailGenerationRef.current;
    dispatch({ type: 'detail_started' });
    void fetchDetail(state.selected.id, { signal: controller.signal })
      .then((detail) => {
        if (generation === detailGenerationRef.current && !controller.signal.aborted) {
          dispatch({ type: 'detail_succeeded', detail });
        }
      })
      .catch(() => {
        if (generation === detailGenerationRef.current && !controller.signal.aborted) {
          dispatch({ type: 'detail_failed' });
        }
      });
    return () => {
      controller.abort();
    };
  }, [fetchDetail, state.detailRevision, state.selected]);

  function changeQuery(patch: Partial<QueryState>) {
    dispatch({ type: 'query', patch });
  }

  function selectView(nextView: InventoryView) {
    if (nextView === state.query.view) return;
    onViewChange?.(nextView);
    if (!controlledView) changeQuery({ view: nextView, status: '' });
  }

  function changeSort(sort: WarehouseInventorySortKey) {
    const direction =
      state.query.sort === sort ? (state.query.direction === 'asc' ? 'desc' : 'asc') : 'asc';
    changeQuery({ sort, direction });
  }

  function closeDetail() {
    dispatch({ type: 'close_detail' });
  }

  const columns = useMemo<Array<PlenkiDataTableColumn<WarehouseInventoryRollItem>>>(
    () => [
      {
        id: 'rollCode',
        header: 'Код рулона',
        width: '150px',
        sortable: true,
        sortDirection: state.query.sort === 'rollCode' ? state.query.direction : 'none',
        ariaLabel: 'Сортировать по коду рулона',
        onSort: () => changeSort('rollCode'),
        render: (item) => <strong>{item.rollCode}</strong>,
      },
      {
        id: 'order',
        header: 'Заказ',
        width: '180px',
        render: orderLabel,
      },
      {
        id: 'position',
        header: 'Позиция',
        width: '140px',
        render: positionLabel,
      },
      {
        id: 'counterparty',
        header: 'Контрагент',
        width: '190px',
        render: (item) => item.counterpartyName,
      },
      {
        id: 'warehouseStatus',
        header: 'Фактический статус',
        width: '180px',
        render: (item) => (
          <span className={`warehouse-stock-status is-${item.warehouseStatus}`}>
            {item.warehouseStatusLabel}
          </span>
        ),
      },
      {
        id: 'nextRoute',
        header: 'Следующий маршрут',
        width: '190px',
        render: (item) => item.nextRouteLabel,
      },
    ],
    [state.query.direction, state.query.sort],
  );

  const emptyState =
    state.listStatus === 'loading' ? (
      <div className="warehouse-stock-state" role="status">
        Загрузка рулонов…
      </div>
    ) : state.listStatus === 'error' ? (
      <div className="warehouse-stock-state">
        <strong>Не удалось загрузить рулоны.</strong>
        <button type="button" onClick={() => dispatch({ type: 'retry_list' })}>
          Повторить
        </button>
      </div>
    ) : (
      <div className="warehouse-stock-state is-empty">
        <strong>
          {state.query.view === 'processed'
            ? 'Обработанные рулоны не найдены'
            : 'Рулоны не найдены'}
        </strong>
      </div>
    );

  return (
    <section className="warehouse-stock-workspace" aria-label="Все рулоны">
      <header className="warehouse-stock-header">
        <div>
          <span className="eyebrow">Все рулоны</span>
          <h2>
            {state.query.view === 'processed' ? 'История обработанных рулонов' : 'Рулоны на складе'}
          </h2>
        </div>
        {canCreate && state.query.view === 'current' ? (
          <button
            type="button"
            className="action-recommended"
            onClick={() => dispatch({ type: 'open_create' })}
          >
            + Добавить рулон
          </button>
        ) : null}
      </header>

      <div className="warehouse-stock-tabs" role="tablist" aria-label="Состояние запасов">
        <button
          id="warehouse-stock-tab-current"
          type="button"
          role="tab"
          aria-selected={state.query.view === 'current'}
          aria-controls="warehouse-stock-panel"
          onClick={() => selectView('current')}
        >
          Рулоны
        </button>
        <button
          id="warehouse-stock-tab-processed"
          type="button"
          role="tab"
          aria-selected={state.query.view === 'processed'}
          aria-controls="warehouse-stock-panel"
          onClick={() => selectView('processed')}
        >
          Обработанные
        </button>
      </div>

      <div
        id="warehouse-stock-panel"
        role="tabpanel"
        aria-labelledby={`warehouse-stock-tab-${state.query.view}`}
      >
        <div className="warehouse-stock-filters" aria-label="Фильтры рулонов">
          <label className="is-wide">
            <span>Поиск</span>
            <input
              aria-label="Поиск рулонов"
              value={state.query.q}
              placeholder="Код, параметры"
              onChange={(event) => changeQuery({ q: event.currentTarget.value })}
            />
          </label>
          {showBatchAgeFilters ? (
            <>
              <label>
                <span>Партия</span>
                <input
                  aria-label="Партия"
                  value={state.query.batch}
                  onChange={(event) => changeQuery({ batch: event.currentTarget.value })}
                />
              </label>
              <label>
                <span>Возраст от</span>
                <input
                  aria-label="Возраст от, дней"
                  type="number"
                  min="0"
                  value={state.query.minAgeDays}
                  onChange={(event) => changeQuery({ minAgeDays: event.currentTarget.value })}
                />
              </label>
              <label>
                <span>Возраст до</span>
                <input
                  aria-label="Возраст до, дней"
                  type="number"
                  min="0"
                  value={state.query.maxAgeDays}
                  onChange={(event) => changeQuery({ maxAgeDays: event.currentTarget.value })}
                />
              </label>
            </>
          ) : null}
          {state.query.view === 'current' ? (
            <label>
              <span>Статус</span>
              <select
                aria-label="Статус"
                value={state.query.status}
                onChange={(event) =>
                  changeQuery({ status: event.currentTarget.value as QueryState['status'] })
                }
              >
                {CURRENT_STATUS_OPTIONS.map((option) => (
                  <option key={option.value || 'all'} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>Контрагент</span>
            <input
              aria-label="Контрагент"
              value={state.query.counterparty}
              onChange={(event) => changeQuery({ counterparty: event.currentTarget.value })}
            />
          </label>
        </div>

        {state.listStatus === 'error' && state.items.length > 0 ? (
          <div className="warehouse-stock-state is-inline">
            {state.listErrorKind === 'cursor' ? (
              <>
                <strong>Список изменился. Загрузите актуальные данные.</strong>
                <button type="button" onClick={() => dispatch({ type: 'refresh_list' })}>
                  Обновить список
                </button>
              </>
            ) : (
              <>
                <strong>Не удалось обновить список.</strong>
                <button type="button" onClick={() => dispatch({ type: 'retry_list' })}>
                  Повторить
                </button>
              </>
            )}
          </div>
        ) : null}

        <PlenkiDataTable
          caption={
            state.query.view === 'processed' ? 'Обработанные складские рулоны' : 'Складские рулоны'
          }
          columns={columns}
          rows={state.items}
          getRowKey={(item) => item.id}
          isRowSelected={(item) => item.id === state.selected?.id}
          onRowClick={(item) => dispatch({ type: 'open_detail', item })}
          empty={emptyState}
          className="warehouse-stock-table"
          tableClassName="warehouse-stock-data-table"
        />

        {state.nextCursor || state.listStatus === 'loading_more' ? (
          <div className="warehouse-stock-pagination">
            <button
              type="button"
              disabled={!state.nextCursor || state.listStatus !== 'ready'}
              onClick={() => dispatch({ type: 'load_more' })}
            >
              {state.listStatus === 'loading_more' ? 'Загрузка…' : 'Загрузить ещё'}
            </button>
          </div>
        ) : null}
      </div>

      {state.selected ? (
        <PlenkiModal
          eyebrow="Складской рулон"
          title={state.selected.rollCode}
          className="warehouse-stock-detail-modal"
          onClose={closeDetail}
        >
          {state.detailStatus === 'loading' ? (
            <div className="warehouse-stock-state" role="status">
              Загрузка карточки…
            </div>
          ) : state.detailStatus === 'error' ? (
            <div className="warehouse-stock-state">
              <strong>Не удалось загрузить карточку рулона.</strong>
              <button type="button" onClick={() => dispatch({ type: 'retry_detail' })}>
                Повторить
              </button>
            </div>
          ) : state.detail ? (
            <RollDetail detail={state.detail} />
          ) : null}
        </PlenkiModal>
      ) : null}

      {state.createOpen && canCreate && state.query.view === 'current' ? (
        <WarehouseReserveRollCreateModal
          materials={materials}
          recipes={recipes}
          catalogStatus={catalogStatus}
          catalogError={catalogError}
          onReloadCatalog={onReloadCatalog}
          onCreate={createRoll}
          onCreated={() => dispatch({ type: 'refresh_list' })}
          onClose={() => dispatch({ type: 'close_create' })}
        />
      ) : null}
    </section>
  );
}
