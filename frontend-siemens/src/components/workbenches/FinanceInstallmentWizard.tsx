import { useEffect, useRef, useState } from 'react';
import { previewFinancePaymentPolicy, setFinancePaymentPolicy } from '../../api/finance';
import {
  paymentPolicyDraftError,
  paymentStageConditionLabel,
  paymentStageCountLabel,
  postpay100Template,
  prepay50Template,
} from '../../domain/financePaymentPolicy';
import type { PaymentPolicyDraft, PaymentPolicyPreview, WorkObject } from '../../domain/types';
import { FinancePaymentPolicyEditor } from './FinancePaymentPolicyEditor';

type WizardStep = 1 | 2 | 3 | 4;

const STEP_LABELS = ['Условия', 'График', 'Проверка', 'Готово'];

function factValue(object: WorkObject, ...labels: string[]) {
  return labels
    .map((label) => object.facts.find((fact) => fact.label === label)?.value)
    .find(Boolean);
}

function amountFromLabel(value?: string) {
  const amount = Number(
    value
      ?.replace(/\s/g, '')
      .replace(',', '.')
      .replace(/[^\d.-]/g, ''),
  );
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function moneyLabel(value: number) {
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)} ₽`;
}

function initialPaymentPolicy(object: WorkObject): PaymentPolicyDraft {
  if (object.paymentPolicy) {
    return {
      installmentDays: object.paymentPolicy.installmentDays,
      stages: object.paymentPolicy.stages.map((stage) => ({ ...stage })),
    };
  }
  return object.paymentTermsType === 'postpay_100_30d'
    ? postpay100Template(30)
    : prepay50Template(30);
}

function previewDateLabel(row: PaymentPolicyPreview['rows'][number]): string {
  if (!row.date) return `Условие · ${paymentStageConditionLabel(row.trigger, row.offsetDays)}`;
  const date = new Date(`${row.date}T00:00:00.000Z`).toLocaleDateString('ru-RU', {
    timeZone: 'UTC',
  });
  return `Дата платежа · ${date}`;
}

export function FinanceInstallmentReview({
  paymentPolicy,
  preview,
  changed,
  reason,
  onReasonChange,
}: {
  paymentPolicy: PaymentPolicyDraft;
  preview: PaymentPolicyPreview | null;
  changed: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
}) {
  return (
    <div className="finance-installment-conditions is-review">
      <div className="finance-installment-review-panel">
        <div className="finance-installment-section-heading">
          <span>Проверка</span>
          <h3>Проверьте условия перед сохранением</h3>
          <p>Убедитесь, что график соответствует договорённости с клиентом.</p>
        </div>

        {changed ? (
          <label className="finance-installment-reason-card">
            <span>Основание изменения</span>
            <textarea
              value={reason}
              onChange={(event) => onReasonChange(event.currentTarget.value)}
              maxLength={500}
              placeholder="Например: согласовано с клиентом"
            />
          </label>
        ) : (
          <div className="finance-installment-review-ready">
            <strong>Условия не изменены</strong>
            <span>Можно закрыть окно без сохранения.</span>
          </div>
        )}
      </div>

      <aside className="finance-installment-context">
        <span>Условия оплаты</span>
        <strong>{paymentStageCountLabel(paymentPolicy.stages.length)}</strong>
        <small>Срок рассрочки: {paymentPolicy.installmentDays} дней после полной отгрузки.</small>
        {preview?.rows.map((row) => (
          <span key={row.sequence}>
            {row.sequence}. {(row.percentageBasisPoints / 100).toFixed(2).replace('.', ',')}% ·{' '}
            {previewDateLabel(row)}
          </span>
        ))}
      </aside>
    </div>
  );
}

export function FinanceInstallmentWizard({
  object,
  onClose,
  onSaved,
}: {
  object: WorkObject;
  onClose: () => void;
  onSaved: (updated: WorkObject) => void;
}) {
  const initialPolicy = useRef(initialPaymentPolicy(object));
  const [step, setStep] = useState<WizardStep>(1);
  const [paymentPolicy, setPaymentPolicy] = useState<PaymentPolicyDraft>(initialPolicy.current);
  const [preview, setPreview] = useState<PaymentPolicyPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const totalAmount =
    object.financeAmountValue && object.financeAmountValue > 0
      ? object.financeAmountValue
      : amountFromLabel(factValue(object, 'Сумма', 'Сумма к счету', 'Остаток'));
  const policyError = paymentPolicyDraftError(paymentPolicy);
  const changed = JSON.stringify(initialPolicy.current) !== JSON.stringify(paymentPolicy);
  const revision = object.paymentPolicy?.revision ?? 0;
  const reasonRequired = changed && revision > 0;
  const orderNumber = factValue(object, 'Номер') ?? object.title;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose]);

  useEffect(() => {
    const requestId = ++previewRequest.current;
    if (!(totalAmount > 0) || policyError) {
      setPreview(null);
      setPreviewBusy(false);
      setPreviewError(totalAmount > 0 ? null : 'Сначала укажите сумму счёта.');
      return;
    }
    setPreviewBusy(true);
    setPreviewError(null);
    const timeoutId = window.setTimeout(() => {
      void previewFinancePaymentPolicy(object.id, { paymentPolicy })
        .then((result) => {
          if (previewRequest.current !== requestId) return;
          setPreview(result);
        })
        .catch((caught) => {
          if (previewRequest.current !== requestId) return;
          setPreview(null);
          setPreviewError(
            caught instanceof Error ? caught.message : 'Не удалось рассчитать график оплаты.',
          );
        })
        .finally(() => {
          if (previewRequest.current === requestId) setPreviewBusy(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timeoutId);
      if (previewRequest.current === requestId) previewRequest.current += 1;
    };
  }, [object.id, paymentPolicy, policyError, totalAmount]);

  function updatePolicy(next: PaymentPolicyDraft) {
    setPaymentPolicy(next);
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
  }

  async function save() {
    if (!changed) {
      setStep(4);
      return;
    }
    if (policyError || !preview) {
      setSaveError(policyError ?? 'Дождитесь расчёта графика оплаты.');
      return;
    }
    if (reasonRequired && !reason.trim()) {
      setSaveError('Укажите причину изменения условий оплаты.');
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const updated = await setFinancePaymentPolicy(object.id, {
        expectedRevision: revision,
        reason: reason.trim() || undefined,
        paymentPolicy,
      });
      onSaved(updated);
      setStep(4);
    } catch (caught) {
      setSaveError(
        caught instanceof Error ? caught.message : 'Не удалось сохранить условия оплаты.',
      );
    } finally {
      setBusy(false);
    }
  }

  function next() {
    if (step < 3) setStep((step + 1) as WizardStep);
    if (step === 3) void save();
  }

  const nextDisabled =
    busy ||
    ((step === 1 || step === 2) &&
      (!preview || previewBusy || Boolean(policyError || previewError))) ||
    (step === 3 && reasonRequired && !reason.trim());

  return (
    <div
      className="finance-installment-wizard-overlay"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        className="finance-installment-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finance-installment-wizard-title"
      >
        <header className="finance-installment-wizard-header">
          <div>
            <span>Условия оплаты</span>
            <h2 id="finance-installment-wizard-title">{orderNumber}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Закрыть визард">
            ×
          </button>
        </header>

        <nav className="finance-installment-stepper" aria-label={`Шаг ${step} из 4`}>
          {STEP_LABELS.map((label, index) => {
            const itemStep = (index + 1) as WizardStep;
            return (
              <span
                key={label}
                className={itemStep === step ? 'is-active' : itemStep < step ? 'is-done' : ''}
              >
                <b>{itemStep}</b>
                {label}
              </span>
            );
          })}
          <small>Шаг {step} из 4</small>
        </nav>

        <div className="finance-installment-wizard-body">
          {step === 1 ? (
            <div className="finance-installment-conditions">
              <div className="finance-installment-main">
                <div className="finance-installment-section-heading">
                  <span>Условия</span>
                  <h3>Настройте этапы оплаты</h3>
                  <p>Предоплата считается от счёта, остальные дни — от полной отгрузки.</p>
                </div>
                <FinancePaymentPolicyEditor
                  value={paymentPolicy}
                  preview={preview}
                  error={policyError ?? previewError}
                  onChange={updatePolicy}
                />
                {previewBusy ? (
                  <p className="finance-policy-loading">Рассчитываем график…</p>
                ) : null}
              </div>
              <aside className="finance-installment-context">
                <span>Сумма счета</span>
                <strong>{totalAmount > 0 ? moneyLabel(totalAmount) : 'не задана'}</strong>
                <small>Количество этапов: {paymentPolicy.stages.length}</small>
              </aside>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="finance-installment-review">
              <div className="finance-installment-section-heading">
                <span>График выплат</span>
                <h3>Порядок оплаты</h3>
                <p>Прогноз автоматически заменится фактической датой после полной отгрузки.</p>
              </div>
              <div className="finance-installment-review-summary">
                {preview?.rows.map((row) => (
                  <article key={row.sequence}>
                    <b>{row.sequence}</b>
                    <div>
                      <strong>{moneyLabel(row.amount)}</strong>
                      <span>
                        {(row.percentageBasisPoints / 100).toFixed(2).replace('.', ',')}% ·{' '}
                        {previewDateLabel(row)}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <FinanceInstallmentReview
              paymentPolicy={paymentPolicy}
              preview={preview}
              changed={changed}
              reason={reason}
              onReasonChange={setReason}
            />
          ) : null}

          {step === 4 ? (
            <div className="finance-installment-complete" role="status">
              <span>✓</span>
              <h3>{changed ? 'Условия сохранены' : 'Условия не изменены'}</h3>
              <p>График выплат готов.</p>
              <small>Даты отображаются в календаре заказа и общем календаре.</small>
            </div>
          ) : null}

          {saveError ? (
            <div className="finance-installment-error" role="alert">
              {saveError}
            </div>
          ) : null}
        </div>

        <footer className="finance-installment-wizard-actions">
          {step > 1 && step < 4 ? (
            <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={busy}>
              Назад
            </button>
          ) : (
            <span />
          )}
          {step < 4 ? (
            <button className="is-primary" type="button" onClick={next} disabled={nextDisabled}>
              {busy ? 'Сохраняем…' : step === 3 ? (changed ? 'Сохранить' : 'Готово') : 'Далее'}
            </button>
          ) : (
            <button className="is-primary" type="button" onClick={onClose}>
              Закрыть
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
