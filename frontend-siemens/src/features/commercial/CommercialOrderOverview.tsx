import type { CommercialNextActionContract, CommercialOrderDetailContract } from './contracts';
import { COMMERCIAL_COMPLETION_LABELS } from './completionPresentation';
import {
  commercialBlockerLabel,
  commercialStageLabel,
  formatCommercialDateTime,
} from './commercialPresentation';
import { CommercialOrderPipeline } from './CommercialOrderPipeline';
import { projectCommercialPipeline } from './commercialPipeline';

export type CommercialOrderOverviewProps = {
  detail: CommercialOrderDetailContract;
  onAction?: (action: CommercialNextActionContract) => void;
  mutationFeedback?: CommercialActionFeedback;
};

export type CommercialActionFeedback = {
  status: 'loading' | 'success' | 'error';
  message: string;
};

export function CommercialOrderOverview({
  detail,
  onAction,
  mutationFeedback,
}: CommercialOrderOverviewProps) {
  const pipeline = projectCommercialPipeline(detail);
  const coveredQty = detail.positions.reduce((total, position) => total + position.coveredQty, 0);
  const productionQty = detail.positions.reduce(
    (total, position) => total + position.productionQty,
    0,
  );
  const cancelled = detail.cancellation?.status === 'cancelled';
  const completionLabel = cancelled
    ? 'Отменён'
    : COMMERCIAL_COMPLETION_LABELS[detail.commercialCompletion.state];
  const isStockOrder = detail.requestType === 'stock_reserve';

  return (
    <section className="commercial-order-overview">
      <header>
        <div>
          <span className="eyebrow">
            {detail.orderNumber} · {cancelled ? 'Отменён' : commercialStageLabel(detail.commercialStage)}
          </span>
          <h2 id="commercial-order-detail-heading" tabIndex={-1}>
            {detail.title || detail.orderNumber}
            {isStockOrder && <span className="commercial-stock-badge">На запас</span>}
          </h2>
          <p>
            {isStockOrder
              ? `Складской запас${detail.stockBatchCode ? ` · ${detail.stockBatchCode}` : ''}`
              : detail.counterparty?.displayName || 'Контрагент не указан'}
          </p>
        </div>
        <time dateTime={detail.updatedAt}>{formatCommercialDateTime(detail.updatedAt)}</time>
      </header>

      <CommercialOrderPipeline
        projection={pipeline}
        onAction={onAction ? () => onAction(detail.nextAction) : undefined}
        feedback={mutationFeedback}
      />

      <section className="commercial-fulfillment" aria-label="Исполнение заявки">
        <div className="commercial-fulfillment-summary">
          <strong>
            {detail.commercialCompletion.fulfilledQty} из{' '}
            {detail.commercialCompletion.requestedQty} рул.
          </strong>
          <span>{completionLabel}</span>
        </div>
        <details>
          <summary>Состав исполнения</summary>
          <dl>
            <div>
              <dt>Заказано</dt>
              <dd>{detail.commercialCompletion.requestedQty} рул.</dd>
            </div>
            <div>
              <dt>Со склада</dt>
              <dd>{coveredQty} рул.</dd>
            </div>
            <div>
              <dt>В производство</dt>
              <dd>{productionQty} рул.</dd>
            </div>
            <div>
              <dt>Выполнено</dt>
              <dd>{detail.commercialCompletion.fulfilledQty} рул.</dd>
            </div>
          </dl>
          {detail.commercialCompletion.blockingReasons.length > 0 && (
            <ul>
              {detail.commercialCompletion.blockingReasons.map((blocker) => (
                <li key={blocker}>{commercialBlockerLabel(blocker)}</li>
              ))}
            </ul>
          )}
        </details>
      </section>
    </section>
  );
}
