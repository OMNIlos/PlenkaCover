import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchSafeRawMaterialInventory,
  type SafeInventoryItem,
  type SafeInventoryPage,
  type SafeInventoryQuery,
  type SafeInventoryRole,
} from '../../api/rawMaterialInventory';

export type SafeInventoryFetcher = (
  role: SafeInventoryRole,
  query: SafeInventoryQuery,
  options?: { signal?: AbortSignal },
) => Promise<SafeInventoryPage>;

export function SafeRawMaterialInventorySurface({
  role,
  fetchPage = fetchSafeRawMaterialInventory,
  bigBagRegister,
  refreshGeneration = 0,
  headerAction,
}: {
  role: SafeInventoryRole;
  fetchPage?: SafeInventoryFetcher;
  bigBagRegister?: ReactNode;
  refreshGeneration?: string | number;
  headerAction?: ReactNode;
}) {
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState<SafeInventoryQuery['category']>();
  const [availability, setAvailability] = useState<SafeInventoryQuery['availability']>();
  const [loadedPage, setLoadedPage] = useState<{
    scope: string;
    value: SafeInventoryPage;
  } | null>(null);
  const [loadState, setLoadState] = useState<{
    scope: string | null;
    value: 'loading' | 'ready' | 'empty' | 'error';
  }>({ scope: null, value: 'loading' });
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestGeneration = useRef(0);
  const paginationController = useRef<AbortController | null>(null);
  const pageRef = useRef<SafeInventoryPage | null>(null);

  const query = useMemo<SafeInventoryQuery>(
    () => ({
      ...(searchQuery ? { q: searchQuery } : {}),
      ...(category ? { category } : {}),
      ...(availability ? { availability } : {}),
      limit: 25,
    }),
    [availability, category, searchQuery],
  );
  const requestScope = JSON.stringify([role, searchQuery, category, availability]);
  const page = loadedPage?.scope === requestScope ? loadedPage.value : null;
  const visibleLoadState = loadState.scope === requestScope ? loadState.value : 'loading';
  pageRef.current = page;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    paginationController.current?.abort();
    paginationController.current = null;
    setLoadState((current) =>
      current.scope === requestScope && pageRef.current !== null
        ? current
        : { scope: requestScope, value: 'loading' },
    );
    setLoadingMore(false);
    void fetchPage(role, query, { signal: controller.signal })
      .then((nextPage) => {
        if (generation !== requestGeneration.current) return;
        setLoadedPage({ scope: requestScope, value: nextPage });
        setLoadState({
          scope: requestScope,
          value: nextPage.items.length === 0 ? 'empty' : 'ready',
        });
      })
      .catch((error) => {
        if (
          generation !== requestGeneration.current ||
          controller.signal.aborted ||
          isAbortError(error)
        ) {
          return;
        }
        setLoadState({ scope: requestScope, value: 'error' });
      });
    return () => {
      controller.abort();
      paginationController.current?.abort();
      paginationController.current = null;
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [fetchPage, query, refreshGeneration, reloadGeneration, requestScope, role]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchQuery(searchDraft.trim());
    setReloadGeneration((current) => current + 1);
  }

  function resetFilters() {
    setSearchDraft('');
    setSearchQuery('');
    setCategory(undefined);
    setAvailability(undefined);
    setReloadGeneration((current) => current + 1);
  }

  async function loadMore() {
    if (!page?.nextCursor || loadingMore) return;
    const generation = requestGeneration.current;
    const controller = new AbortController();
    paginationController.current?.abort();
    paginationController.current = controller;
    setLoadingMore(true);
    try {
      const nextPage = await fetchPage(
        role,
        { ...query, cursor: page.nextCursor },
        { signal: controller.signal },
      );
      if (generation !== requestGeneration.current) return;
      const items = mergeInventoryItems(page.items, nextPage.items);
      setLoadedPage({
        scope: requestScope,
        value: {
          ...nextPage,
          items,
        },
      });
      setLoadState({
        scope: requestScope,
        value: items.length === 0 ? 'empty' : 'ready',
      });
    } catch (error) {
      if (
        generation !== requestGeneration.current ||
        controller.signal.aborted ||
        isAbortError(error)
      ) {
        return;
      }
      setLoadState({ scope: requestScope, value: 'error' });
    } finally {
      if (paginationController.current === controller) paginationController.current = null;
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  }

  const roleLabel =
    role === 'production' ? 'Зав. производства' : role === 'warehouse' ? 'Склад' : 'Директор';

  return (
    <section
      className="safe-inventory-surface"
      aria-label="Сырье: складской учёт"
      aria-busy={visibleLoadState === 'loading'}
    >
      <header className="safe-inventory-header">
        <div>
          <span className="eyebrow">{roleLabel}</span>
          <h2>Сырье</h2>
        </div>
        <div className="safe-inventory-header-actions">
          {page ? (
            <div className="safe-inventory-freshness">
              <span>{page.items.length} поз.</span>
            </div>
          ) : null}
          {headerAction}
        </div>
      </header>

      {bigBagRegister}

      <form className="safe-inventory-toolbar" aria-label="Поиск сырья" onSubmit={submitSearch}>
        <label className="safe-inventory-search">
          <span>Поиск</span>
          <input
            aria-label="Поиск по сырью"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Название или код"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="safe-inventory-submit">
          Найти
        </button>
        <label>
          <span>Категория</span>
          <select
            aria-label="Категория сырья"
            value={category ?? ''}
            onChange={(event) =>
              setCategory((event.target.value || undefined) as SafeInventoryQuery['category'])
            }
          >
            <option value="">Все</option>
            <option value="primary">Первичное</option>
            <option value="secondary">Вторичное</option>
            <option value="additive">Добавки</option>
            <option value="custom">Другое</option>
          </select>
        </label>
        <label>
          <span>Доступность</span>
          <select
            aria-label="Доступность сырья"
            value={availability ?? ''}
            onChange={(event) =>
              setAvailability(
                (event.target.value || undefined) as SafeInventoryQuery['availability'] | undefined,
              )
            }
          >
            <option value="">Все</option>
            <option value="available">Доступно</option>
            <option value="unavailable">Нет / не подтверждено</option>
          </select>
        </label>
        <button type="button" className="safe-inventory-reset" onClick={resetFilters}>
          Сбросить
        </button>
      </form>

      {visibleLoadState === 'loading' ? (
        <InventoryMessage title="Загружаем данные о сырье…" busy />
      ) : null}
      {visibleLoadState === 'error' ? (
        <InventoryMessage title="Не удалось загрузить данные о сырье">
          <button
            type="button"
            data-safe-inventory-retry
            onClick={() => setReloadGeneration((current) => current + 1)}
          >
            Повторить
          </button>
        </InventoryMessage>
      ) : null}
      {visibleLoadState === 'empty' ? (
        <InventoryMessage title="Материалы не найдены">
          <span>Измените поиск или фильтры.</span>
        </InventoryMessage>
      ) : null}

      {page && page.items.length > 0 ? (
        <div className="safe-inventory-table" role="table" aria-label="Остатки сырья">
          <div className="safe-inventory-row is-head" role="row">
            <span role="columnheader">Материал</span>
            <span role="columnheader">На складе</span>
            <span role="columnheader">Резерв</span>
            <span role="columnheader">Доступно</span>
            <span role="columnheader">Расход</span>
            <span role="columnheader">Big-bag</span>
          </div>
          {page.items.map((item) => (
            <InventoryRow key={item.materialId} item={item} />
          ))}
        </div>
      ) : null}
      {page?.nextCursor ? (
        <div className="safe-inventory-pagination" aria-label="Пагинация сырья">
          <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore
              ? 'Загружаем…'
              : page.items.length === 0
                ? 'Искать дальше'
                : 'Показать ещё'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function InventoryRow({ item }: { item: SafeInventoryItem }) {
  return (
    <article
      className={`safe-inventory-row state-${item.sourceStatus}`}
      role="row"
      data-material-id={item.materialId}
    >
      <span role="cell" data-label="Материал">
        <strong>{item.materialName}</strong>
        <small>{categoryLabel(item.category)}</small>
      </span>
      <span role="cell" data-label="На складе">
        {formatQuantity(item.erpActualQty, item.unit)}
      </span>
      <span role="cell" data-label="Резерв">
        {formatQuantity(item.reservedQty, item.unit)}
      </span>
      <span role="cell" data-label="Доступно">
        {formatQuantity(item.availableQty, item.unit)}
      </span>
      <span role="cell" data-label="Расход">
        {formatQuantity(item.expectedUsageQty, item.unit)}
      </span>
      <span role="cell" data-label="Big-bag">
        {formatQuantity(item.openBigBagQty, item.unit)}
      </span>
    </article>
  );
}

function InventoryMessage({
  title,
  busy = false,
  children,
}: {
  title: string;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="safe-inventory-message" role={busy ? 'status' : undefined}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

function mergeInventoryItems(
  current: SafeInventoryItem[],
  next: SafeInventoryItem[],
): SafeInventoryItem[] {
  return Array.from(new Map([...current, ...next].map((item) => [item.materialId, item])).values());
}

function categoryLabel(category: string | null) {
  const labels: Record<string, string> = {
    primary: 'Первичное',
    secondary: 'Вторичное',
    additive: 'Добавка',
    custom: 'Другое',
  };
  return category ? (labels[category] ?? 'Другое') : 'Без категории';
}

function formatQuantity(value: number | null, unit: string | null) {
  if (value === null) return 'Не подтверждено';
  const formatted = Number(value.toFixed(3)).toLocaleString('ru-RU', {
    maximumFractionDigits: 3,
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}
