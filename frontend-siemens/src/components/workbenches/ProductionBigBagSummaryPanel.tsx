import { useEffect, useState } from 'react';

import {
  fetchProductionBigBagSummary,
  type ProductionBigBagSummary,
  type ProductionBigBagSummaryItem,
} from '../../api/productionBigBags';

function formatKg(value: number | null): string {
  if (value === null) return 'Вес не указан';
  return `${new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 3,
  }).format(value)} кг`;
}

function classificationLabel(bag: ProductionBigBagSummaryItem): string {
  if (bag.classification === 'in_use') return 'В работе';
  if (bag.classification === 'idle_required') return 'Нужен текущим заказам';
  if (bag.classification === 'idle_not_required') {
    return 'Можно вернуть на склад';
  }
  return 'Не предлагать к возврату автоматически';
}

export function ProductionBigBagSummaryPanel({
  loadSummary = fetchProductionBigBagSummary,
  refreshGeneration = 0,
  showRefreshAction = true,
}: {
  loadSummary?: () => Promise<ProductionBigBagSummary>;
  refreshGeneration?: string | number;
  showRefreshAction?: boolean;
}) {
  const [summary, setSummary] = useState<ProductionBigBagSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadSummary()
      .then((nextSummary) => {
        if (!cancelled) setSummary(nextSummary);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Не удалось загрузить сводку Big-Bag.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSummary, refreshGeneration, reloadRevision]);

  return (
    <section className="production-bigbag-summary" aria-label="Big-Bag в производстве">
      <header>
        <div>
          <span className="eyebrow">ПРОИЗВОДСТВО · СЫРЬЁ</span>
          <h2>Big-Bag в производстве</h2>
          <p>Сводка по всем зарегистрированным мешкам на производственной площадке.</p>
        </div>
        {showRefreshAction ? (
          <button
            type="button"
            className="action-secondary"
            disabled={loading}
            onClick={() => setReloadRevision((current) => current + 1)}
          >
            Обновить
          </button>
        ) : null}
      </header>

      {loading && !summary ? <p role="status">Загружаем сводку Big-Bag…</p> : null}
      {error ? (
        <div className="production-bigbag-error" role="alert">
          {error}
        </div>
      ) : null}

      {summary ? (
        <>
          <div className="production-bigbag-metrics">
            <span>
              <strong>Всего {summary.counts.total}</strong>
            </span>
            <span>В работе {summary.counts.inUse}</span>
            <span>Не используются {summary.counts.idle}</span>
            <span>Не нужны заказам {summary.counts.notRequired}</span>
          </div>

          <div className="production-bigbag-summary-grid">
            <section>
              <header>
                <h3>Кандидаты на возврат</h3>
                <span>{summary.returnCandidates.length}</span>
              </header>
              {summary.returnCandidates.length === 0 ? (
                <p className="production-bigbag-empty">
                  Сейчас нет мешков, которые точно не требуются незавершённым заказам.
                </p>
              ) : (
                <ul className="production-bigbag-candidates">
                  {summary.returnCandidates.map((bag) => (
                    <li key={bag.id}>
                      <span>
                        <strong>{bag.code}</strong>
                        <small>{bag.material}</small>
                      </span>
                      <strong>{formatKg(bag.currentKg)}</strong>
                    </li>
                  ))}
                </ul>
              )}
              <div className="production-bigbag-verbal-note" role="note">
                <strong>Сообщить складу устно</strong>
                <span>
                  Системная заявка не создаётся. Склад выполнит возврат своим QR-сканированием и
                  контрольным взвешиванием.
                </span>
              </div>
            </section>

            <section>
              <header>
                <h3>Все мешки на производстве</h3>
                <span>{summary.bags.length}</span>
              </header>
              {summary.bags.length === 0 ? (
                <p className="production-bigbag-empty">
                  На производстве нет зарегистрированных Big-Bag.
                </p>
              ) : (
                <ul className="production-bigbag-overview">
                  {summary.bags.map((bag) => (
                    <li key={bag.id}>
                      <span>
                        <strong>{bag.code}</strong>
                        <small>{bag.material}</small>
                      </span>
                      <span>
                        <strong>{formatKg(bag.currentKg)}</strong>
                        <small>{classificationLabel(bag)}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}
