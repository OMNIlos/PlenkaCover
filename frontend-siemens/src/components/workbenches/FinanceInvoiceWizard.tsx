import { useEffect, useRef, useState } from 'react';

import { createFinanceInvoice, previewFinancePaymentPolicy } from '../../api/finance';
import { immediate100Template, paymentPolicyDraftError } from '../../domain/financePaymentPolicy';
import type {
  ActionDescriptor,
  PaymentPolicyDraft,
  PaymentPolicyPreview,
  WorkObject,
} from '../../domain/types';
import { moneyDraftLabel, parseMoneyDraft } from './financeMoney';
import { FinancePaymentPolicyEditor } from './FinancePaymentPolicyEditor';

export function FinanceInvoiceWizard({
  action,
  financeOrderId,
  commercialFinanceNote,
  initialAmount,
  onClose,
  onCreated,
}: {
  action: ActionDescriptor;
  financeOrderId: string;
  commercialFinanceNote?: string | null;
  initialAmount?: number;
  onClose: () => void;
  onCreated?: (object: WorkObject) => void;
}) {
  const [amountDraft, setAmountDraft] = useState(
    initialAmount && initialAmount > 0 ? String(initialAmount) : '',
  );
  const [paymentPolicy, setPaymentPolicy] = useState<PaymentPolicyDraft>(immediate100Template);
  const [preview, setPreview] = useState<PaymentPolicyPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const amount = parseMoneyDraft(amountDraft);
  const policyError = paymentPolicyDraftError(paymentPolicy);
  const canSubmit =
    action.enabled &&
    amount !== undefined &&
    !policyError &&
    preview !== null &&
    !previewBusy &&
    !busy;

  useEffect(() => {
    const requestId = ++previewRequest.current;
    if (amount === undefined || policyError) {
      setPreview(null);
      setPreviewBusy(false);
      setPreviewError(null);
      return;
    }
    setPreview(null);
    setPreviewBusy(true);
    setPreviewError(null);
    const timeoutId = globalThis.setTimeout(() => {
      void previewFinancePaymentPolicy(financeOrderId, { amount, paymentPolicy })
        .then((result) => {
          if (previewRequest.current !== requestId) return;
          setPreview(result);
        })
        .catch((cause) => {
          if (previewRequest.current !== requestId) return;
          setPreview(null);
          setPreviewError(
            cause instanceof Error ? cause.message : 'Не удалось рассчитать график оплаты.',
          );
        })
        .finally(() => {
          if (previewRequest.current === requestId) setPreviewBusy(false);
        });
    }, 250);
    return () => {
      globalThis.clearTimeout(timeoutId);
      if (previewRequest.current === requestId) previewRequest.current += 1;
    };
  }, [amount, financeOrderId, paymentPolicy, policyError]);

  async function submit() {
    if (!canSubmit || amount === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createFinanceInvoice(financeOrderId, {
        amount,
        paymentPolicy,
      });
      onCreated?.(created);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Не удалось оформить счёт. Повторите попытку.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="finance-installment-wizard-overlay"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        className="finance-installment-wizard finance-invoice-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finance-invoice-wizard-title"
      >
        <header className="finance-installment-wizard-header">
          <div>
            <span>Бухгалтерия</span>
            <h2 id="finance-invoice-wizard-title">Оформить счёт вручную</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Закрыть окно">
            ×
          </button>
        </header>

        <div className="finance-installment-wizard-body">
          <div className="finance-invoice-wizard-step">
            <div className="finance-installment-section-heading">
              <span>Сумма и условия оплаты</span>
              <h3>Введите сумму счёта</h3>
              <p>Сумма и строки счёта фиксируются вручную в платформе.</p>
            </div>

            <label className="finance-manual-invoice-amount">
              <span>Сумма счёта, ₽</span>
              <input
                autoFocus
                inputMode="decimal"
                value={amountDraft}
                disabled={busy}
                onChange={(event) => {
                  setAmountDraft(event.currentTarget.value);
                  setError(null);
                }}
                placeholder="Например, 120000"
              />
              <small>{amount ? moneyDraftLabel(amount) : 'Введите сумму больше нуля'}</small>
            </label>

            <div className="finance-manual-payment-presets">
              <span>Метод платежа</span>
              <p>Выберите быстрый вариант или настройте собственный график.</p>
              <FinancePaymentPolicyEditor
                value={paymentPolicy}
                preview={preview}
                error={policyError ?? previewError}
                disabled={busy}
                onChange={(nextPolicy) => {
                  setPaymentPolicy(nextPolicy);
                  setPreview(null);
                  setPreviewError(null);
                  setError(null);
                }}
              />
              {previewBusy ? (
                <small className="finance-payment-preview-status" role="status">
                  Рассчитываем график…
                </small>
              ) : null}
            </div>

            <div className="onec-invoice-commercial-note">
              <span>Комментарий коммерции</span>
              <strong>{commercialFinanceNote?.trim() || 'Комментарий не добавлен'}</strong>
            </div>

            {error ? (
              <div className="finance-installment-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        <footer className="finance-installment-wizard-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="is-primary"
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? 'Оформляем…' : 'Оформить счёт'}
          </button>
        </footer>
      </section>
    </div>
  );
}
