import type {
  CommercialLoadStatus,
  CommercialNextActionContract,
  CommercialOrderDetailContract,
} from './contracts';
import type { RawMaterialCatalogItem, RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import { CommercialOrderOverview, type CommercialActionFeedback } from './CommercialOrderOverview';
import { CommercialCoverPanel } from './CommercialCoverPanel';
import { CommercialOrderComment } from './CommercialOrderComment';
import type { CommercialOrderCommentCommand } from './api';
import {
  CommercialOrderPositions,
  type CommercialPositionCreateCommand,
  type CommercialPositionUpdateCommand,
} from './CommercialOrderPositions';
import { CommercialFinanceNotePanel } from './CommercialFinanceNotePanel';
import { CommercialOrderLifecycleActions } from './CommercialOrderLifecycleActions';

export function CommercialOrderDetail({
  detail,
  status,
  error,
  onRetry,
  onAction,
  onCommentUpdate,
  onPositionUpdate,
  onPositionAmend,
  onPositionAdd,
  onFinanceNoteUpdate,
  onCancel,
  onDelete,
  materials,
  recipes,
  mutationFeedback,
}: {
  detail: CommercialOrderDetailContract | null;
  status: CommercialLoadStatus;
  error: string | null;
  onRetry: () => void;
  onAction?: (action: CommercialNextActionContract) => void;
  onCommentUpdate?: (command: CommercialOrderCommentCommand) => Promise<boolean>;
  onPositionUpdate?: (
    positionId: string,
    command: CommercialPositionUpdateCommand,
  ) => Promise<boolean>;
  onPositionAmend?: (
    positionId: string,
    command: CommercialPositionUpdateCommand,
    reason: string,
  ) => Promise<boolean>;
  onPositionAdd?: (command: CommercialPositionCreateCommand, reason: string) => Promise<boolean>;
  onFinanceNoteUpdate?: (value: string | null) => Promise<boolean>;
  onCancel?: (reason: string) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  materials?: readonly RawMaterialCatalogItem[];
  recipes?: readonly RecipeCatalogItem[];
  mutationFeedback?: CommercialActionFeedback;
}) {
  if (status === 'loading' && !detail) {
    return <section aria-live="polite">Загрузка заявки…</section>;
  }
  if (status === 'error' && !detail) {
    return (
      <section role="alert">
        <strong>Не удалось загрузить заявку</strong>
        {error && <p>{error}</p>}
        <button type="button" onClick={onRetry}>
          Повторить
        </button>
      </section>
    );
  }
  if (!detail) return <section className="muted">Выберите заявку в очереди.</section>;
  const active = detail.cancellation?.status !== 'cancelled';
  const busy = mutationFeedback?.status === 'loading';

  return (
    <article className="commercial-live-detail" aria-busy={status === 'refreshing'}>
      <CommercialOrderOverview
        detail={detail}
        onAction={onAction}
        mutationFeedback={mutationFeedback}
      />
      {onCommentUpdate && (
        <CommercialOrderComment
          comment={detail.comment}
          version={detail.commentVersion}
          editable={active}
          onSave={onCommentUpdate}
        />
      )}
      {detail.requestType !== 'stock_reserve' && onFinanceNoteUpdate ? (
        <CommercialFinanceNotePanel
          value={detail.commercialFinanceNote}
          editable={active}
          onSave={onFinanceNoteUpdate}
        />
      ) : null}
      {detail.warehouseCoverageWorkflowVersion === 2 && detail.warehouseCoverage && (
        <CommercialCoverPanel
          warehouseCoverageWorkflowVersion={2}
          coverage={detail.warehouseCoverage}
        />
      )}
      <div id="commercial-order-positions" tabIndex={-1}>
        <CommercialOrderPositions
          positions={detail.positions}
          editable={detail.edit.parametersAllowed}
          amendable={active && detail.edit.parametersAmendable}
          lockReason={detail.edit.parametersLockReason}
          materials={materials}
          recipes={recipes}
          onUpdate={onPositionUpdate}
          onAmend={onPositionAmend}
          onAdd={onPositionAdd}
        />
      </div>
      {onCancel && onDelete && (
        <CommercialOrderLifecycleActions
          orderNumber={detail.orderNumber}
          cancelled={!active}
          busy={busy}
          onCancel={onCancel}
          onDelete={onDelete}
        />
      )}
      {detail.requestType !== 'stock_reserve' && detail.counterparty && (
        <details className="commercial-secondary-facts">
          <summary>Клиент и бухгалтерия</summary>
          <dl>
            <div>
              <dt>Юридическое имя</dt>
              <dd>{detail.counterparty.legalName || 'Не указано'}</dd>
            </div>
            <div>
              <dt>ИНН</dt>
              <dd>{detail.counterparty.inn || 'Не указан'}</dd>
            </div>
            <div>
              <dt>Счёт</dt>
              <dd>
                {detail.financeSummary?.invoiceStatus === 'invoiced'
                  ? 'Счёт выставлен'
                  : detail.financeSummary?.invoiceStatus === 'not_invoiced'
                    ? 'Счёт не выставлен'
                    : 'Статус счёта уточняется'}
              </dd>
            </div>
          </dl>
        </details>
      )}
    </article>
  );
}
