import { useEffect, useRef, useState } from 'react';

import {
  createWarehouseReserveRoll,
  fetchWarehouseFinishedStock,
  type WarehouseFinishedStockBucket,
  type WarehouseFinishedStockPage,
  type WarehouseFinishedStockQuery,
  type WarehouseReserveRoll,
  type WarehouseReserveRollCreateInput,
} from '../../api/warehouse';
import type { RawMaterialCatalogItem, RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import type { MaterialRecipeCatalogStatus } from '../../features/recipes/useMaterialRecipeCatalog';
import { WarehouseReserveRollCreateModal } from './WarehouseReserveRollCreateModal';

type FinishedStockFetcher = (
  query: WarehouseFinishedStockQuery,
  options?: { signal?: AbortSignal },
) => Promise<WarehouseFinishedStockPage>;

const EMPTY_PAGE: WarehouseFinishedStockPage = {
  items: [],
  summary: { totalCount: 0, totalWeightKg: 0, pageCount: 0, pageWeightKg: 0 },
  nextCursor: null,
};

const FINISHED_STOCK_URL_KEYS = ['q', 'batch', 'minAgeDays', 'maxAgeDays'] as const;

type FinishedStockUrlFilters = {
  query: string;
  batch: string;
  minAgeDays: string;
  maxAgeDays: string;
};

function optionalAge(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function readFinishedStockUrlFilters(): FinishedStockUrlFilters {
  const params =
    typeof window === 'undefined'
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const minAgeDays = params.get('minAgeDays') ?? '';
  const maxAgeDays = params.get('maxAgeDays') ?? '';
  return {
    query: params.get('q') ?? '',
    batch: params.get('batch') ?? '',
    minAgeDays: optionalAge(minAgeDays) === undefined ? '' : minAgeDays,
    maxAgeDays: optionalAge(maxAgeDays) === undefined ? '' : maxAgeDays,
  };
}

function formatWeight(value: number | null) {
  if (value === null) return '—';
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кг`;
}

function formatProcessedDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function normalizeRecipe(value: string | null) {
  if (!value?.trim()) return 'Без рецептуры';
  const seen = new Set<string>();
  return value
    .split('·')
    .map((token) => token.trim())
    .filter((token) => {
      const normalized = token.toLocaleLowerCase('ru-RU');
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join(' · ');
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Не удалось загрузить готовую продукцию.';
}

export function WarehouseFinishedStockPanel({
  fetchPage = fetchWarehouseFinishedStock,
  bucket: controlledBucket,
  onBucketChange,
  canCreate = false,
  materials = [],
  recipes = [],
  catalogStatus = 'idle',
  catalogError = null,
  onReloadCatalog = () => undefined,
  createRoll = createWarehouseReserveRoll,
}: {
  fetchPage?: FinishedStockFetcher;
  bucket?: WarehouseFinishedStockBucket;
  onBucketChange?: (bucket: WarehouseFinishedStockBucket) => void;
  canCreate?: boolean;
  materials?: readonly RawMaterialCatalogItem[];
  recipes?: readonly RecipeCatalogItem[];
  catalogStatus?: MaterialRecipeCatalogStatus;
  catalogError?: string | null;
  onReloadCatalog?: () => void;
  createRoll?: (input: WarehouseReserveRollCreateInput) => Promise<WarehouseReserveRoll>;
}) {
  const initialFiltersRef = useRef<ReturnType<typeof readFinishedStockUrlFilters> | null>(null);
  if (!initialFiltersRef.current) initialFiltersRef.current = readFinishedStockUrlFilters();
  const initialFilters = initialFiltersRef.current;
  const [query, setQuery] = useState(initialFilters.query);
  const [batch, setBatch] = useState(initialFilters.batch);
  const [minAgeDays, setMinAgeDays] = useState(initialFilters.minAgeDays);
  const [maxAgeDays, setMaxAgeDays] = useState(initialFilters.maxAgeDays);
  const [uncontrolledBucket, setUncontrolledBucket] = useState<WarehouseFinishedStockBucket>(
    'available',
  );
  const bucket = controlledBucket ?? uncontrolledBucket;
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [page, setPage] = useState<WarehouseFinishedStockPage>(EMPTY_PAGE);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const latestRequestRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const skipUrlSyncRef = useRef(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (skipUrlSyncRef.current) {
      skipUrlSyncRef.current = false;
      return;
    }
    const params = new URLSearchParams(window.location.search);
    FINISHED_STOCK_URL_KEYS.forEach((key) => params.delete(key));
    if (query.trim()) params.set('q', query.trim());
    if (batch.trim()) params.set('batch', batch.trim());
    const parsedMinAge = optionalAge(minAgeDays);
    const parsedMaxAge = optionalAge(maxAgeDays);
    if (parsedMinAge !== undefined) params.set('minAgeDays', String(parsedMinAge));
    if (parsedMaxAge !== undefined) params.set('maxAgeDays', String(parsedMaxAge));
    const search = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, [batch, maxAgeDays, minAgeDays, query]);

  useEffect(() => {
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setStatus('loading');
    setError(null);
    void fetchPage(
      {
        bucket,
        ...(query.trim() ? { q: query.trim() } : {}),
        ...(batch.trim() ? { batch: batch.trim() } : {}),
        ...(optionalAge(minAgeDays) !== undefined ? { minAgeDays: optionalAge(minAgeDays) } : {}),
        ...(optionalAge(maxAgeDays) !== undefined ? { maxAgeDays: optionalAge(maxAgeDays) } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 25,
      },
      { signal: controller.signal },
    )
      .then((nextPage) => {
        if (latestRequestRef.current !== requestId) return;
        setPage(nextPage);
        setStatus('ready');
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted || latestRequestRef.current !== requestId) return;
        setStatus('error');
        setError(errorMessage(loadError));
      });
    return () => {
      controller.abort();
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    };
  }, [batch, bucket, cursor, fetchPage, maxAgeDays, minAgeDays, query, revision]);

  const updateFilter = (update: () => void) => {
    setCursor(undefined);
    setCursorHistory([]);
    update();
  };

  const selectBucket = (nextBucket: WarehouseFinishedStockBucket) => {
    if (nextBucket === bucket) return;
    latestRequestRef.current += 1;
    requestControllerRef.current?.abort();
    setPage(EMPTY_PAGE);
    setCursor(undefined);
    setCursorHistory([]);
    setStatus('loading');
    setError(null);
    setUncontrolledBucket(nextBucket);
    onBucketChange?.(nextBucket);
  };

  return (
    <section className="warehouse-finished-stock" aria-label="Готовая продукция">
      <header className="warehouse-finished-stock-header">
        <div>
          <span className="eyebrow">Запасы / резерв</span>
          <h2>Готовая продукция</h2>
        </div>
        <div className="warehouse-finished-stock-header-actions">
          <dl className="warehouse-finished-stock-summary">
            <div>
              <dt>Рулонов</dt>
              <dd>{page.summary.totalCount.toLocaleString('ru-RU')}</dd>
            </div>
            <div>
              <dt>Всего</dt>
              <dd>{formatWeight(page.summary.totalWeightKg)}</dd>
            </div>
          </dl>
          {canCreate ? (
            <button
              type="button"
              className="action-recommended"
              onClick={() => setCreateOpen(true)}
            >
              + Добавить рулон
            </button>
          ) : null}
        </div>
      </header>

      <div
        className="warehouse-finished-stock-tabs"
        role="tablist"
        aria-label="Жизненный цикл резерва"
      >
        <button
          id="warehouse-finished-stock-tab-available"
          type="button"
          role="tab"
          aria-selected={bucket === 'available'}
          aria-controls="warehouse-finished-stock-panel"
          onClick={() => selectBucket('available')}
        >
          Доступные
        </button>
        <button
          id="warehouse-finished-stock-tab-processed"
          type="button"
          role="tab"
          aria-selected={bucket === 'processed'}
          aria-controls="warehouse-finished-stock-panel"
          onClick={() => selectBucket('processed')}
        >
          Обработанные
        </button>
      </div>

      <div
        id="warehouse-finished-stock-panel"
        role="tabpanel"
        aria-labelledby={`warehouse-finished-stock-tab-${bucket}`}
      >
        <div className="warehouse-finished-stock-filters" aria-label="Фильтры готовой продукции">
          <label className="is-wide">
            <span>Поиск</span>
            <input
              aria-label="Поиск готовой продукции"
              value={query}
              placeholder="Код рулона, рецептура"
              onChange={(event) => updateFilter(() => setQuery(event.target.value))}
            />
          </label>
          <label>
            <span>Партия</span>
            <input
              aria-label="Партия"
              value={batch}
              placeholder="STOCK-…"
              onChange={(event) => updateFilter(() => setBatch(event.target.value))}
            />
          </label>
          <label>
            <span>Возраст от</span>
            <input
              aria-label="Возраст от, дней"
              type="number"
              min="0"
              value={minAgeDays}
              onChange={(event) => updateFilter(() => setMinAgeDays(event.target.value))}
            />
          </label>
          <label>
            <span>Возраст до</span>
            <input
              aria-label="Возраст до, дней"
              type="number"
              min="0"
              value={maxAgeDays}
              onChange={(event) => updateFilter(() => setMaxAgeDays(event.target.value))}
            />
          </label>
        </div>

        {status === 'error' && (
          <div className="warehouse-finished-stock-state" role="alert">
            <strong>Готовая продукция недоступна</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setRevision((value) => value + 1)}>
              Повторить
            </button>
          </div>
        )}

        {status === 'loading' && page.items.length === 0 && (
          <div className="warehouse-finished-stock-state" aria-live="polite">
            Загрузка готовой продукции…
          </div>
        )}

        {status === 'ready' && page.items.length === 0 && (
          <div className="warehouse-finished-stock-state is-empty">
            <strong>
              {bucket === 'available' ? 'Доступных рулонов нет' : 'Обработанных рулонов нет'}
            </strong>
            <span>
              {bucket === 'available'
                ? 'Измените фильтры или дождитесь приёмки рулонов.'
                : 'В этом разделе ещё нет завершённых резервов.'}
            </span>
          </div>
        )}

        {page.items.length > 0 && (
          <div
            className="warehouse-finished-stock-table"
            role="table"
            aria-label="Готовая продукция"
          >
            <div
              className={`warehouse-finished-stock-row is-head${
                bucket === 'processed' ? ' is-processed' : ''
              }`}
              role="row"
            >
              <span role="columnheader">Рулон / партия</span>
              <span role="columnheader">Вес</span>
              <span role="columnheader">Рецептура / параметры</span>
              <span className="warehouse-finished-stock-cell-age" role="columnheader">
                Возраст
              </span>
              {bucket === 'processed' ? <span role="columnheader">Использован</span> : null}
            </div>
            {page.items.map((item) => (
              <div
                className={`warehouse-finished-stock-row${
                  bucket === 'processed' ? ' is-processed' : ''
                }`}
                role="row"
                key={item.id}
              >
                <span role="cell" data-label="Рулон / партия">
                  <strong>{item.rollCode}</strong>
                  <small>{item.batchCode}</small>
                </span>
                <span role="cell" data-label="Вес">
                  <strong>{formatWeight(item.weightKg)}</strong>
                </span>
                <span role="cell" data-label="Рецептура / параметры">
                  <strong>{normalizeRecipe(item.recipe)}</strong>
                  <small className="warehouse-finished-stock-parameters">
                    {item.specification || 'Параметры не указаны'}
                  </small>
                </span>
                <span role="cell" data-label="Возраст">
                  {item.ageDays} дн.
                </span>
                {bucket === 'processed' ? (
                  <span role="cell" data-label="Использован">
                    {formatProcessedDate(item.processedAt)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {(cursorHistory.length > 0 || page.nextCursor) && (
          <nav
            className="warehouse-finished-stock-pagination"
            aria-label="Пагинация готовой продукции"
          >
            <button
              type="button"
              disabled={cursorHistory.length === 0 || status === 'loading'}
              onClick={() => {
                const previous = cursorHistory.at(-1);
                setCursorHistory((items) => items.slice(0, -1));
                setCursor(previous);
              }}
            >
              Назад
            </button>
            <span>{page.summary.pageCount} на странице</span>
            <button
              type="button"
              disabled={!page.nextCursor || status === 'loading'}
              onClick={() => {
                setCursorHistory((items) => [...items, cursor]);
                setCursor(page.nextCursor || undefined);
              }}
            >
              Далее
            </button>
          </nav>
        )}
      </div>
      {createOpen && canCreate ? (
        <WarehouseReserveRollCreateModal
          materials={materials}
          recipes={recipes}
          catalogStatus={catalogStatus}
          catalogError={catalogError}
          onReloadCatalog={onReloadCatalog}
          onCreate={createRoll}
          onCreated={() => setRevision((value) => value + 1)}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </section>
  );
}
