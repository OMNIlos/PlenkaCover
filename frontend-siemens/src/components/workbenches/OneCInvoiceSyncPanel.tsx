import type { FinanceInvoiceView, OneCInvoiceSyncState } from '../../domain/types';

const SYNC_STATE_LABELS: Record<OneCInvoiceSyncState, string> = {
  not_synced: 'Счёт ещё не проверялся',
  not_found: 'Счёт с маркером пока не найден',
  draft_found: 'Найден черновик счёта',
  posted: 'Проведённый счёт получен',
  ambiguous: 'Найдено несколько подходящих счетов',
  stale: 'Данные счёта требуют обновления',
  error: 'Источник 1С временно недоступен',
};

function dateLabel(value?: string | null): string {
  if (!value) return 'Не указана';
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toLocaleDateString('ru-RU', {
    timeZone: 'UTC',
  });
}

export function OneCInvoiceSyncPanel({
  orderReference,
  commercialFinanceNote,
  invoiceSyncState,
  invoice,
  refreshDisabled = false,
  onRefresh,
}: {
  orderReference: string;
  commercialFinanceNote?: string | null;
  invoiceSyncState: OneCInvoiceSyncState;
  invoice?: FinanceInvoiceView;
  refreshDisabled?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <section className="onec-invoice-sync-panel" aria-label="Синхронизация счёта с 1С">
      <div className="finance-installment-section-heading">
        <span>Источник 1С</span>
        <h3>Счёт по заявке</h3>
        <p>
          1С используется только для номера документа и сопоставления банковских поступлений.
          Сумма и условия оплаты вводятся вручную в платформе.
        </p>
      </div>

      <div className="onec-invoice-reference">
        <span>Точный маркер заказа</span>
        <code>{orderReference}</code>
      </div>

      <div className="onec-invoice-commercial-note">
        <span>Комментарий коммерции</span>
        <strong>{commercialFinanceNote?.trim() || 'Комментарий не добавлен'}</strong>
      </div>

      <div className={`onec-invoice-sync-state state-${invoiceSyncState}`}>
        <span>Состояние синхронизации</span>
        <strong>{SYNC_STATE_LABELS[invoiceSyncState]}</strong>
      </div>

      {invoice ? (
        <div className="onec-invoice-safe-data">
          <div className="onec-invoice-summary">
            <article>
              <span>Номер</span>
              <strong>{invoice.invoiceNumber || 'Не указан'}</strong>
            </article>
            <article>
              <span>Дата</span>
              <strong>{dateLabel(invoice.date)}</strong>
            </article>
            <article>
              <span>Валюта</span>
              <strong>{invoice.currency || 'Не указана'}</strong>
            </article>
          </div>
        </div>
      ) : null}

      {onRefresh ? (
        <button className="is-primary" type="button" disabled={refreshDisabled} onClick={onRefresh}>
          Обновить из 1С
        </button>
      ) : null}
    </section>
  );
}
