import { useState, type ReactNode } from 'react';
import type {
  CommercialBigBagValueContract,
  CommercialLoadStatus,
  CommercialRawMaterialRiskContract,
} from './contracts';
import { formatCommercialDateTime, formatCommercialQuantity } from './commercialPresentation';

const RISK_LABELS: Record<CommercialRawMaterialRiskContract['risk'], string> = {
  ok: 'Достаточно',
  attention: 'Требует внимания',
  deficit: 'Ожидается дефицит',
  unknown: 'Риск не рассчитан',
};

const PLANNING_REASON_LABELS: Record<
  Exclude<CommercialRawMaterialRiskContract['planningUnavailableReason'], null>,
  string
> = {
  planned_weight_missing: 'Нет явного планового веса',
  production_route_unresolved: 'Маршрут покрытия ещё не подтверждён',
  production_facts_inconsistent: 'Факты производства требуют обновления',
  recipe_snapshot_invalid: 'Снимок рецептуры недоступен',
};

const SOURCE_LABELS: Record<
  NonNullable<CommercialRawMaterialRiskContract['source']>['kind'],
  string
> = {
  '1C': 'Учетный снимок',
  mock_1C: 'Тестовый учетный снимок',
  manual_platform: 'Ручной факт платформы',
  warehouse_runtime: 'Складской runtime',
  warehouse_fact: 'Факт склада',
};

const RISK_WEIGHT: Record<CommercialRawMaterialRiskContract['risk'], number> = {
  deficit: 0,
  attention: 1,
  unknown: 2,
  ok: 3,
};

const PILOT_PRESENTATION_PREFIX = 'Пилот · ';

export function commercialRawMaterialDisplayLabel(label: string) {
  return label.startsWith(PILOT_PRESENTATION_PREFIX)
    ? label.slice(PILOT_PRESENTATION_PREFIX.length)
    : label;
}

export function commercialRawMaterialRowKey(
  item: Pick<CommercialRawMaterialRiskContract, 'rawMaterialDefinitionId' | 'materialId'>,
) {
  return item.rawMaterialDefinitionId;
}

export function sortCommercialMaterialRisks(items: CommercialRawMaterialRiskContract[]) {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        RISK_WEIGHT[left.item.risk] - RISK_WEIGHT[right.item.risk] || left.index - right.index,
    )
    .map(({ item }) => item);
}

export function commercialMaterialRiskSummary(items: CommercialRawMaterialRiskContract[]) {
  return {
    total: items.length,
    critical: items.filter((item) => item.risk === 'deficit').length,
    attention: items.filter((item) => item.risk === 'attention').length,
    unavailable: items.filter((item) => item.risk === 'unknown').length,
  };
}

export function CommercialRawMaterials({
  items,
  bigBags = [],
  status,
  error,
  hasMore,
  activeQuery = '',
  onSearch = () => undefined,
  onRetry,
  onLoadMore,
  onOpenOrder,
  bigBagRegister,
}: {
  items: CommercialRawMaterialRiskContract[];
  bigBags?: CommercialBigBagValueContract[];
  status: CommercialLoadStatus;
  error: string | null;
  hasMore: boolean;
  activeQuery?: string;
  onSearch?: (query: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpenOrder: (orderId: string) => void;
  bigBagRegister?: ReactNode;
}) {
  const [searchDraft, setSearchDraft] = useState(activeQuery);

  if ((status === 'idle' || status === 'loading') && items.length === 0) {
    return (
      <section aria-live="polite">
        {bigBagRegister}
        Загрузка складских фактов…
      </section>
    );
  }

  const summary = commercialMaterialRiskSummary(items);

  return (
    <section className="commercial-raw-materials" aria-label="Риски сырья">
      <header>
        <span className="eyebrow">Физический остаток · учетный остаток · план производства</span>
        <h2>Сырьё</h2>
        <p>Физический и учетный остатки склада показаны отдельно.</p>
      </header>

      {bigBagRegister}

      <form
        className="safe-inventory-toolbar commercial-raw-material-toolbar"
        aria-label="Поиск сырья"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(searchDraft);
        }}
      >
        <label className="safe-inventory-search">
          <span>Поиск</span>
          <input
            aria-label="Поиск по сырью"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Название сырья"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="safe-inventory-submit">
          Найти
        </button>
        <button
          type="button"
          className="safe-inventory-reset"
          onClick={() => {
            setSearchDraft('');
            onSearch('');
          }}
        >
          Сбросить
        </button>
      </form>

      {bigBags.length > 0 ? (
        <section className="commercial-bigbag-values" aria-label="Стоимость Big-Bag">
          <header>
            <h3>Big-Bag</h3>
            <span>Актуальный вес и стоимость</span>
          </header>
          <div>
            {bigBags.map((bag) => (
              <article key={bag.id}>
                <span>
                  <strong>{bag.code}</strong>
                  <small>{bag.material}</small>
                </span>
                <dl>
                  <div>
                    <dt>Вес</dt>
                    <dd>{formatCommercialQuantity(bag.currentKg, 'кг', '—')}</dd>
                  </div>
                  <div>
                    <dt>Цена</dt>
                    <dd>{formatMoneyPerKg(bag.priceKopecksPerKg)}</dd>
                  </div>
                  <div>
                    <dt>Стоимость</dt>
                    <dd>{formatMoney(bag.totalKopecks)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {status === 'error' && (
        <div role="alert">
          <strong>Не удалось обновить риски сырья</strong>
          {error && <p>{error}</p>}
          <button type="button" onClick={onRetry}>
            Повторить
          </button>
        </div>
      )}

      {items.length === 0 && status !== 'loading' ? (
        <p className="muted">
          {activeQuery ? `По запросу «${activeQuery}» ничего не найдено.` : 'Сырьё не найдено.'}
        </p>
      ) : (
        <>
          <dl className="commercial-material-summary" aria-label="Сводка рисков сырья">
            <div>
              <dt>Материалов</dt>
              <dd>{summary.total}</dd>
            </div>
            <div>
              <dt>Дефицит</dt>
              <dd>{summary.critical}</dd>
            </div>
            <div>
              <dt>Внимание</dt>
              <dd>{summary.attention}</dd>
            </div>
            <div>
              <dt>Нет расчёта</dt>
              <dd>{summary.unavailable}</dd>
            </div>
          </dl>

          <div className="commercial-raw-material-list">
            {sortCommercialMaterialRisks(items).map((item) => {
              const planningUnavailable = item.planningUnavailableReason
                ? PLANNING_REASON_LABELS[item.planningUnavailableReason]
                : 'Планирование недоступно';
              const deficitUnavailable = item.source?.stale
                ? 'Данные источника устарели'
                : 'Дефицит не рассчитан';
              const actualUnavailable =
                item.reason === 'stock_fact_missing' ? 'Нет складского факта' : 'Недоступно';
              const planCellCount =
                (item.planningAvailability === 'available' ? 2 : 1) +
                (item.rollsInMovement === null ? 0 : 1);
              return (
                <article key={commercialRawMaterialRowKey(item)} className={`risk-${item.risk}`}>
                  <header>
                    <div>
                      <h3>{commercialRawMaterialDisplayLabel(item.label)}</h3>
                      {item.package && (
                        <small className="commercial-material-package">{item.package}</small>
                      )}
                    </div>
                    <strong>{RISK_LABELS[item.risk]}</strong>
                  </header>

                  <div className="commercial-material-actual">
                    <span>Факт склада · Фактический остаток</span>
                    <strong className="commercial-material-actual-value">
                      {formatCommercialQuantity(
                        item.stockAvailability === 'available' ? item.actualQty : null,
                        item.unit,
                        actualUnavailable,
                      )}
                    </strong>
                  </div>

                  <div className="commercial-material-actual commercial-material-accounting">
                    <span>Учетный остаток</span>
                    <span>
                      <strong>
                        {formatCommercialQuantity(
                          item.oneCQty ?? null,
                          item.oneCUnit ?? null,
                          'Нет учетного остатка',
                        )}
                      </strong>
                      {item.oneCSource ? (
                        <small className="commercial-material-package">
                          Обновлено:{' '}
                          <time dateTime={item.oneCSource.importedAt}>
                            {formatCommercialDateTime(item.oneCSource.importedAt)}
                          </time>
                          {item.oneCSource.stale ? ' · данные устарели' : ''}
                        </small>
                      ) : (
                        <small className="commercial-material-package">Обновление недоступно</small>
                      )}
                    </span>
                  </div>

                  <dl className="commercial-material-plan" data-plan-cells={planCellCount}>
                    {item.planningAvailability === 'available' ? (
                      <>
                        <div>
                          <dt>Плановая потребность</dt>
                          <dd>
                            {formatCommercialQuantity(
                              item.plannedNeedQty,
                              item.unit,
                              planningUnavailable,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Ожидаемый дефицит</dt>
                          <dd>
                            {formatCommercialQuantity(
                              item.deficitQty,
                              item.unit,
                              deficitUnavailable,
                            )}
                          </dd>
                        </div>
                      </>
                    ) : (
                      <div className="commercial-material-plan-unavailable">
                        <dt>План производства</dt>
                        <dd>План не рассчитан</dd>
                        <small>{planningUnavailable}</small>
                      </div>
                    )}
                    {item.rollsInMovement !== null && (
                      <div>
                        <dt>Рулоны в движении</dt>
                        <dd>{item.rollsInMovement}</dd>
                      </div>
                    )}
                  </dl>

                  {item.source ? (
                    <p className="commercial-material-source">
                      Источник: {SOURCE_LABELS[item.source.kind]} ·{' '}
                      <time dateTime={item.source.capturedAt}>
                        {formatCommercialDateTime(item.source.capturedAt)}
                      </time>
                      {item.source.stale && <strong> · Данные устарели</strong>}
                    </p>
                  ) : (
                    <p className="commercial-material-source">Источник: Недоступно</p>
                  )}

                  <details className="commercial-material-orders">
                    <summary>Затронутые заявки · {item.affectedOrders.length}</summary>
                    {item.affectedOrders.length === 0 ? (
                      <p className="muted">Активной потребности нет.</p>
                    ) : (
                      <div>
                        {item.affectedOrders.map((order) => (
                          <button
                            key={order.id}
                            type="button"
                            aria-label={`Открыть заявку ${order.orderNumber}`}
                            onClick={() => onOpenOrder(order.id)}
                          >
                            {order.orderNumber} · {order.rollCount} рул.
                          </button>
                        ))}
                      </div>
                    )}
                  </details>
                </article>
              );
            })}
          </div>
        </>
      )}

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

function formatMoney(kopecks: number | null): string {
  if (kopecks === null) return 'Не указана';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: kopecks % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(kopecks / 100);
}

function formatMoneyPerKg(kopecks: number | null): string {
  return kopecks === null ? 'Не указана' : `${formatMoney(kopecks)}/кг`;
}
