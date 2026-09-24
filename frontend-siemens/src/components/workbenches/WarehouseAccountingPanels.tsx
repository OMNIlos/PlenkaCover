import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchWarehouseAccountingMovements,
  fetchWarehouseAccountingStock,
  type WarehouseAccountingMovementPage,
  type WarehouseAccountingMovementQuery,
  type WarehouseAccountingStockPage,
  type WarehouseAccountingStockQuery,
  type WarehouseAccountingStockScope,
} from '../../api/warehouseAccounting';

export type WarehouseAccountingStockFetcher = (
  query: WarehouseAccountingStockQuery,
  options?: { signal?: AbortSignal },
) => Promise<WarehouseAccountingStockPage>;

export type WarehouseAccountingMovementFetcher = (
  query: WarehouseAccountingMovementQuery,
  options?: { signal?: AbortSignal },
) => Promise<WarehouseAccountingMovementPage>;

type LoadState = 'loading' | 'ready' | 'empty' | 'error';

export function WarehouseAccountingStockPanel({
  scope,
  fetchPage = fetchWarehouseAccountingStock,
}: {
  scope: WarehouseAccountingStockScope;
  fetchPage?: WarehouseAccountingStockFetcher;
}) {
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState<WarehouseAccountingStockPage | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0);
  const requestGeneration = useRef(0);
  const query = useMemo(
    () => ({ scope, ...(searchQuery ? { q: searchQuery } : {}), limit: 50 }),
    [scope, searchQuery],
  );

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setPage(null);
    setLoadState('loading');
    setLoadingMore(false);
    void fetchPage(query, { signal: controller.signal })
      .then((nextPage) => {
        if (generation !== requestGeneration.current) return;
        setPage(nextPage);
        setLoadState(nextPage.items.length > 0 ? 'ready' : 'empty');
      })
      .catch((error) => {
        if (generation !== requestGeneration.current || controller.signal.aborted) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        setLoadState('error');
      });
    return () => {
      controller.abort();
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [fetchPage, query, reload]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchQuery(searchDraft.trim());
    setReload((current) => current + 1);
  }

  async function loadMore() {
    if (!page?.nextCursor || loadingMore) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    try {
      const nextPage = await fetchPage({ ...query, cursor: page.nextCursor });
      if (generation !== requestGeneration.current) return;
      const items = Array.from(
        new Map(
          [...page.items, ...nextPage.items].map((item) => [item.nomenclatureExternalId, item]),
        ).values(),
      );
      setPage({ ...nextPage, items });
      setLoadState(items.length > 0 ? 'ready' : 'empty');
    } catch {
      if (generation === requestGeneration.current) setLoadState('error');
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  }

  const title = scope === 'consumables' ? 'Расходники' : 'Учетные остатки';

  return (
    <section className="safe-inventory-surface warehouse-accounting-panel" aria-label={title}>
      <header className="safe-inventory-header">
        <div>
          <span className="eyebrow">Склад · только чтение</span>
          <h2>{title}</h2>
          <p>Количество по проведенным складским документам.</p>
        </div>
        {page ? <time dateTime={page.generatedAt}>{formatDateTime(page.generatedAt)}</time> : null}
      </header>

      <form className="safe-inventory-toolbar warehouse-accounting-search" onSubmit={submitSearch}>
        <label className="safe-inventory-search">
          <span className="sr-only">Поиск в остатках</span>
          <input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            placeholder="Название"
          />
        </label>
        <button type="submit">Найти</button>
        {searchQuery ? (
          <button
            type="button"
            onClick={() => {
              setSearchDraft('');
              setSearchQuery('');
              setReload((current) => current + 1);
            }}
          >
            Сбросить
          </button>
        ) : null}
      </form>

      {loadState === 'loading' ? (
        <AccountingMessage>Загружаем остатки…</AccountingMessage>
      ) : null}
      {loadState === 'error' ? (
        <AccountingMessage alert>
          Не удалось загрузить остатки.
          <button type="button" onClick={() => setReload((current) => current + 1)}>
            Повторить
          </button>
        </AccountingMessage>
      ) : null}
      {loadState === 'empty' ? (
        <AccountingMessage>В выбранной группе нет позиций.</AccountingMessage>
      ) : null}

      {page && page.items.length > 0 ? (
        <div
          className="safe-inventory-table warehouse-accounting-table"
          role="table"
          aria-label={title}
        >
          <div className="safe-inventory-row warehouse-accounting-row is-head" role="row">
            <span role="columnheader">Номенклатура</span>
            <span role="columnheader">Вид</span>
            <span role="columnheader">Количество</span>
            <span role="columnheader">Ед.</span>
            <span role="columnheader">Проверено</span>
            <span role="columnheader">Импорт</span>
            <span role="columnheader">Физический QR</span>
          </div>
          {page.items.map((item) => (
            <article
              key={item.nomenclatureExternalId}
              className={`safe-inventory-row warehouse-accounting-row state-${item.balanceStatus}`}
              role="row"
            >
              <span role="cell" data-label="Номенклатура">
                <strong>{item.name}</strong>
                <small>Не является физическим рулоном</small>
              </span>
              <span role="cell" data-label="Вид">
                {item.kind ?? 'Не указан'}
              </span>
              <span role="cell" data-label="Количество">
                <strong>{formatQuantity(item.quantity, null)}</strong>
                {item.quantity < 0 ? <small>Отрицательный учетный остаток</small> : null}
              </span>
              <span role="cell" data-label="Ед.">
                {item.unit ?? 'Не указана'}
              </span>
              <span role="cell" data-label="Проверено">
                <time dateTime={item.capturedAt}>{formatDateTime(item.capturedAt)}</time>
              </span>
              <span role="cell" data-label="Импорт">
                <time dateTime={item.importedAt}>{formatDateTime(item.importedAt)}</time>
                {item.stale ? <small>Устарел</small> : null}
              </span>
              <span role="cell" data-label="Физический QR">
                Не прослеживается
              </span>
            </article>
          ))}
        </div>
      ) : null}

      {page?.nextCursor ? (
        <div className="safe-inventory-pagination">
          <button
            type="button"
            className="warehouse-accounting-load-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Загружаем…' : 'Показать ещё'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function WarehouseAccountingMovementsPanel({
  fetchPage = fetchWarehouseAccountingMovements,
}: {
  fetchPage?: WarehouseAccountingMovementFetcher;
}) {
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState<WarehouseAccountingMovementPage | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0);
  const requestGeneration = useRef(0);
  const query = useMemo(
    () => ({ ...(searchQuery ? { q: searchQuery } : {}), limit: 20 }),
    [searchQuery],
  );

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setPage(null);
    setLoadState('loading');
    setLoadingMore(false);
    void fetchPage(query, { signal: controller.signal })
      .then((nextPage) => {
        if (generation !== requestGeneration.current) return;
        setPage(nextPage);
        setLoadState(nextPage.items.length > 0 ? 'ready' : 'empty');
      })
      .catch((error) => {
        if (generation !== requestGeneration.current || controller.signal.aborted) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        setLoadState('error');
      });
    return () => {
      controller.abort();
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [fetchPage, query, reload]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchQuery(searchDraft.trim());
    setReload((current) => current + 1);
  }

  async function loadMore() {
    if (!page?.nextCursor || loadingMore) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    try {
      const nextPage = await fetchPage({ ...query, cursor: page.nextCursor });
      if (generation !== requestGeneration.current) return;
      const items = Array.from(
        new Map([...page.items, ...nextPage.items].map((item) => [item.externalId, item])).values(),
      );
      setPage({ ...nextPage, items });
      setLoadState(items.length > 0 ? 'ready' : 'empty');
    } catch {
      if (generation === requestGeneration.current) setLoadState('error');
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  }

  return (
    <section
      className="safe-inventory-surface warehouse-accounting-panel"
      aria-label="Движения"
    >
      <header className="safe-inventory-header">
        <div>
          <span className="eyebrow">Склад · только чтение</span>
          <h2>Движения</h2>
          <p>Проведенные складские документы.</p>
        </div>
        {page ? <time dateTime={page.generatedAt}>{formatDateTime(page.generatedAt)}</time> : null}
      </header>

      <form className="safe-inventory-toolbar warehouse-accounting-search" onSubmit={submitSearch}>
        <label className="safe-inventory-search">
          <span className="sr-only">Поиск в движениях</span>
          <input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            placeholder="Номер документа или товар"
          />
        </label>
        <button type="submit">Найти</button>
      </form>

      {loadState === 'loading' ? (
        <AccountingMessage>Загружаем движения…</AccountingMessage>
      ) : null}
      {loadState === 'error' ? (
        <AccountingMessage alert>
          Не удалось загрузить движения.
          <button type="button" onClick={() => setReload((current) => current + 1)}>
            Повторить
          </button>
        </AccountingMessage>
      ) : null}
      {loadState === 'empty' ? (
        <AccountingMessage>Движения не найдены.</AccountingMessage>
      ) : null}

      {page && page.items.length > 0 ? (
        <div className="safe-inventory-table" role="table" aria-label="Движения">
          <div className="safe-inventory-row is-head" role="row">
            <span role="columnheader">Документ</span>
            <span role="columnheader">Дата</span>
            <span role="columnheader">Позиций</span>
            <span role="columnheader">Импорт</span>
            <span role="columnheader">Направление</span>
            <span role="columnheader">Физический QR</span>
          </div>
          {page.items.map((movement) => (
            <article key={movement.externalId} className="safe-inventory-row" role="row">
              <span role="cell" data-label="Документ">
                <strong>{movement.documentNumber}</strong>
              </span>
              <span role="cell" data-label="Дата">
                <time dateTime={movement.documentDate}>
                  {formatDateTime(movement.documentDate)}
                </time>
              </span>
              <span role="cell" data-label="Позиций">
                {movement.lines.length}
              </span>
              <span role="cell" data-label="Импорт">
                <time dateTime={movement.importedAt}>{formatDateTime(movement.importedAt)}</time>
              </span>
              <span role="cell" data-label="Направление">
                Расход
              </span>
              <span role="cell" data-label="Физический QR">
                Не прослеживается
              </span>
              <footer>
                {movement.lines.map((line) => (
                  <span key={line.lineNumber}>
                    {line.name} · <strong>{formatQuantity(line.quantity, line.unit)}</strong>
                  </span>
                ))}
              </footer>
            </article>
          ))}
        </div>
      ) : null}

      {page?.nextCursor ? (
        <div className="safe-inventory-pagination">
          <button
            type="button"
            className="warehouse-accounting-load-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Загружаем…' : 'Показать ещё'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function AccountingMessage({
  children,
  alert = false,
}: {
  children: React.ReactNode;
  alert?: boolean;
}) {
  return (
    <div
      className="safe-inventory-message warehouse-accounting-message"
      role={alert ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

function formatQuantity(value: number, unit: string | null) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value)}${
    unit ? ` ${unit}` : ''
  }`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('ru-RU', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
}
