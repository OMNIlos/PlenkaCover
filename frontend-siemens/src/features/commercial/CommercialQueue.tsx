import type {
  CommercialLoadStatus,
  CommercialOrderSummaryContract,
  CommercialQueueModeLabel,
} from './contracts';
import { formatCommercialQueueTime } from './commercialPresentation';
import { COMMERCIAL_COMPLETION_LABELS } from './completionPresentation';
import { projectCommercialPipeline } from './commercialPipeline';

export function commercialQueueCompletionPercent(item: CommercialOrderSummaryContract) {
  const requested = item.commercialCompletion.requestedQty;
  if (requested <= 0) return 0;
  return Math.min(
    100,
    Math.round((item.commercialCompletion.fulfilledQty / requested) * 100),
  );
}

export function nextCommercialQueueSelection(
  items: ReadonlyArray<{ id: string }>,
  selectedId: string | null,
  key: string,
): string | null {
  if (items.length === 0 || (key !== 'ArrowDown' && key !== 'ArrowUp')) return null;
  const selectedIndex = items.findIndex((item) => item.id === selectedId);
  const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const offset = key === 'ArrowDown' ? 1 : -1;
  return items[(currentIndex + offset + items.length) % items.length]?.id ?? null;
}

export function focusCommercialQueueItem(id: string) {
  window.requestAnimationFrame(() => {
    const target = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-commercial-order-id]'),
    ].find((item) => item.dataset.commercialOrderId === id);
    target?.focus();
  });
}

export function CommercialQueue({
  items,
  selectedId,
  status,
  stale,
  error,
  hasMore,
  onSelect,
  onRetry,
  onLoadMore,
  filters,
  onFiltersChange,
  onResetFilters,
}: {
  items: CommercialOrderSummaryContract[];
  selectedId: string | null;
  status: CommercialLoadStatus;
  stale: boolean;
  error: string | null;
  hasMore: boolean;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  filters?: { mode: CommercialQueueModeLabel; from: string; to: string };
  onFiltersChange?: (filters: { mode: CommercialQueueModeLabel; from: string; to: string }) => void;
  onResetFilters?: () => void;
}) {
  const initialLoading =
    items.length === 0 && (status === 'idle' || status === 'loading');
  const hasError = status === 'error' || Boolean(error);
  const resultState = initialLoading
    ? 'loading'
    : hasError && items.length === 0
      ? 'error'
      : items.length === 0
        ? 'empty'
        : 'ready';

  return (
    <section className="commercial-live-queue" aria-label="Очередь заявок">
      {filters && onFiltersChange && onResetFilters && (
        <fieldset className="commercial-live-filters">
          <legend className="sr-only">Фильтры очереди</legend>
          <div className="commercial-queue-mode" role="group" aria-label="Режим очереди">
            {(['Текущие', 'Требуют действий'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={filters.mode === mode}
                onClick={() => onFiltersChange({ ...filters, mode })}
              >
                {mode === 'Текущие' ? 'Актуальные' : mode}
              </button>
            ))}
          </div>
          <details className="commercial-queue-period" open={Boolean(filters.from || filters.to)}>
            <summary>Период{filters.from || filters.to ? ' · выбран' : ''}</summary>
            <div>
              <label>
                Дата от включительно
                <input
                  type="date"
                  value={filters.from}
                  onChange={(event) =>
                    onFiltersChange({ ...filters, from: event.target.value })
                  }
                />
              </label>
              <label>
                Дата до включительно
                <input
                  type="date"
                  value={filters.to}
                  onChange={(event) => onFiltersChange({ ...filters, to: event.target.value })}
                />
              </label>
              <button
                type="button"
                onClick={onResetFilters}
                disabled={!filters.from && !filters.to}
              >
                Сбросить период
              </button>
            </div>
          </details>
        </fieldset>
      )}
      <span className="commercial-queue-count">Загружено: {items.length}</span>
      <div className="commercial-live-results" data-state={resultState} aria-live="polite">
        {initialLoading && (
          <div
            className="commercial-live-skeleton"
            aria-label="Загрузка коммерческих заявок"
          >
            <span />
            <span />
            <span />
          </div>
        )}

        {hasError && (
          <div className="commercial-live-error-state" role="alert">
            <strong>{stale ? 'Данные могли устареть' : 'Не удалось загрузить очередь'}</strong>
            <p>
              {stale
                ? 'Показываем ранее загруженные заявки.'
                : 'Проверьте подключение и повторите попытку.'}
            </p>
            <button type="button" onClick={onRetry}>
              Повторить
            </button>
          </div>
        )}

        {!initialLoading && !hasError && items.length === 0 && (
          <div className="commercial-live-empty-state">
            <strong>В очереди нет заявок</strong>
            <p>Новые заявки появятся здесь.</p>
          </div>
        )}

        {items.length > 0 && (
          <ol className="commercial-live-order-list">
            {items.map((item) => {
              const percent = commercialQueueCompletionPercent(item);
              const focus = projectCommercialPipeline(item).focus;

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    data-commercial-order-id={item.id}
                    className="commercial-live-order-row"
                    aria-pressed={selectedId === item.id}
                    onClick={() => onSelect(item.id)}
                    onKeyDown={(event) => {
                      const nextId = nextCommercialQueueSelection(items, item.id, event.key);
                      if (!nextId) return;
                      event.preventDefault();
                      onSelect(nextId);
                      focusCommercialQueueItem(nextId);
                    }}
                  >
                    <span className="commercial-queue-identity">
                      <strong>
                        {item.title || item.orderNumber}
                        {item.requestType === 'stock_reserve' && (
                          <span className="commercial-stock-badge">На запас</span>
                        )}
                      </strong>
                      <small>
                        {item.requestType === 'stock_reserve'
                          ? item.stockBatchCode || 'Складской запас'
                          : item.counterparty?.displayName || 'Контрагент не указан'}
                      </small>
                    </span>
                    <span className="commercial-queue-meta">
                      <span>
                        {item.orderNumber}
                        <small className={`commercial-queue-priority is-${focus.mode}`}>
                          {focus.mode === 'action'
                            ? 'Ваше действие'
                            : focus.owner}
                        </small>
                      </span>
                      <time dateTime={item.updatedAt}>
                        {formatCommercialQueueTime(item.updatedAt)}
                      </time>
                    </span>
                    <span className="commercial-queue-progress">
                      <span
                        role="progressbar"
                        aria-label="Исполнение заявки"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                      >
                        <span style={{ width: `${percent}%` }} />
                      </span>
                      <small>
                        Готово {item.commercialCompletion.fulfilledQty}/
                        {item.commercialCompletion.requestedQty} ·{' '}
                        {item.cancellation?.status === 'cancelled'
                          ? 'Отменён'
                          : COMMERCIAL_COMPLETION_LABELS[item.commercialCompletion.state]}
                      </small>
                    </span>
                    <span className={`commercial-queue-action is-${focus.mode}`}>
                      <strong>{focus.title}</strong>
                      <small>{focus.owner}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={status === 'refreshing'}
          aria-busy={status === 'refreshing'}
        >
          {status === 'refreshing' ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
    </section>
  );
}
