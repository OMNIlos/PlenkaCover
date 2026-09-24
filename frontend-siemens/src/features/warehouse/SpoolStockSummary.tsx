import { useEffect, useState } from 'react';

import type { ApiRequestOptions } from '../../api/client';
import {
  fetchWarehouseSpoolStock,
  type SpoolStockSummaryItem,
} from '../../api/warehouseSpoolPrice';

const METER_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

type LoadStock = (options?: ApiRequestOptions) => Promise<SpoolStockSummaryItem[]>;

export function SpoolStockSummary({
  refreshRevision = 0,
  loadStock = fetchWarehouseSpoolStock,
}: {
  refreshRevision?: number;
  loadStock?: LoadStock;
}) {
  const [items, setItems] = useState<SpoolStockSummaryItem[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void loadStock({ signal: controller.signal }).then(
      (next) => {
        if (controller.signal.aborted) return;
        setItems(next);
        setStatus('ready');
      },
      () => {
        if (controller.signal.aborted) return;
        setItems(null);
        setStatus('error');
      },
    );
    return () => controller.abort();
  }, [loadStock, refreshRevision, retryRevision]);

  return (
    <section
      className="spool-stock-summary"
      aria-label="Приход шпуль"
      aria-busy={status === 'loading'}
    >
      <h3>Приход шпуль</h3>
      {status === 'loading' && !items ? (
        <p role="status" aria-live="polite">
          Загрузка прихода шпуль…
        </p>
      ) : status === 'error' ? (
        <div role="alert">
          <span>Не удалось загрузить приход шпуль.</span>
          <button
            type="button"
            className="action-secondary"
            onClick={() => setRetryRevision((value) => value + 1)}
          >
            Повторить
          </button>
        </div>
      ) : items?.length === 0 ? (
        <p>Приход шпуль пока не зафиксирован.</p>
      ) : (
        <dl>
          {items?.map((item) => (
            <div key={item.spoolTypeKey}>
              <dt>{item.spoolTypeLabel}</dt>
              <dd>
                Принято на склад: {METER_FORMAT.format(item.totalReceivedMillimeters / 1_000)} пог.
                м
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
