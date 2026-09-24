import type {
  PaymentPolicyDraft,
  PaymentPolicyPreview,
  PaymentPolicyStageDraft,
} from '../../domain/types';
import {
  immediate100Template,
  net30Template,
  paymentStageConditionLabel,
  split50Template,
} from '../../domain/financePaymentPolicy';

const MAX_PAYMENT_STAGES = 50;

function renumberStages(stages: PaymentPolicyStageDraft[]): PaymentPolicyStageDraft[] {
  return stages.map((stage, index) => ({ ...stage, sequence: index + 1 }));
}

function finalDeferredStageIndex(stages: PaymentPolicyStageDraft[]): number {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (stages[index].trigger === 'full_shipment') return index;
  }
  return -1;
}

function percentageLabel(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2).replace('.', ',')}%`;
}

function moneyLabel(amount: number): string {
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount)} ₽`;
}

function dateLabel(date: string): string {
  if (!date) return 'Дата не определена';
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString('ru-RU', {
    timeZone: 'UTC',
  });
}

export function insertPaymentStage(policy: PaymentPolicyDraft): PaymentPolicyDraft {
  if (policy.stages.length >= MAX_PAYMENT_STAGES) return policy;
  const insertionIndex = Math.max(0, policy.stages.length - 1);
  const finalStage = policy.stages[insertionIndex];
  const previousDeferredOffset = policy.stages
    .slice(0, insertionIndex)
    .filter((stage) => stage.trigger === 'full_shipment')
    .at(-1)?.offsetDays;
  const lowerBound = previousDeferredOffset ?? 0;
  const upperBound =
    finalStage?.trigger === 'full_shipment' ? finalStage.offsetDays : policy.installmentDays;
  const offsetDays = Math.floor((lowerBound + Math.max(lowerBound, upperBound)) / 2);
  const nextStage: PaymentPolicyStageDraft = {
    sequence: insertionIndex + 1,
    trigger: 'full_shipment',
    percentageBasisPoints: 0,
    offsetDays,
  };
  const stages = [...policy.stages];
  stages.splice(insertionIndex, 0, nextStage);
  return { ...policy, stages: renumberStages(stages) };
}

export function removePaymentStage(
  policy: PaymentPolicyDraft,
  sequence: number,
): PaymentPolicyDraft {
  if (policy.stages.length <= 1) return policy;
  const stages = renumberStages(policy.stages.filter((stage) => stage.sequence !== sequence));
  const finalDeferredIndex = finalDeferredStageIndex(stages);
  if (finalDeferredIndex >= 0) {
    stages[finalDeferredIndex] = {
      ...stages[finalDeferredIndex],
      offsetDays: policy.installmentDays,
    };
  }
  return { ...policy, stages };
}

export function updatePolicyInstallmentDays(
  policy: PaymentPolicyDraft,
  installmentDays: number,
): PaymentPolicyDraft {
  const finalDeferredIndex = finalDeferredStageIndex(policy.stages);
  return {
    ...policy,
    installmentDays,
    stages: policy.stages.map((stage, index) =>
      index === finalDeferredIndex && stage.offsetDays === policy.installmentDays
        ? { ...stage, offsetDays: installmentDays }
        : { ...stage },
    ),
  };
}

function updateStage(
  policy: PaymentPolicyDraft,
  sequence: number,
  patch: Partial<PaymentPolicyStageDraft>,
): PaymentPolicyDraft {
  return {
    ...policy,
    stages: policy.stages.map((stage) =>
      stage.sequence === sequence ? { ...stage, ...patch } : { ...stage },
    ),
  };
}

export function FinancePaymentPolicyEditor({
  value,
  preview,
  error,
  onChange,
  disabled = false,
}: {
  value: PaymentPolicyDraft;
  preview?: PaymentPolicyPreview | null;
  error: string | null;
  onChange: (value: PaymentPolicyDraft) => void;
  disabled?: boolean;
}) {
  const percentageTotal = value.stages.reduce(
    (total, stage) => total + stage.percentageBasisPoints,
    0,
  );
  const percentageRemainder = 10_000 - percentageTotal;

  return (
    <div className="finance-payment-policy-editor">
      <div className="finance-policy-template-actions" aria-label="Шаблоны условий оплаты">
        <button type="button" disabled={disabled} onClick={() => onChange(immediate100Template())}>
          100% сразу
        </button>
        <button type="button" disabled={disabled} onClick={() => onChange(split50Template())}>
          50/50
        </button>
        <button type="button" disabled={disabled} onClick={() => onChange(net30Template())}>
          100% через 30 дней
        </button>
      </div>

      <label className="finance-policy-term-field">
        <span>Срок рассрочки</span>
        <span className="finance-policy-input-unit">
          <input
            type="number"
            min="0"
            max="3650"
            step="1"
            value={value.installmentDays}
            disabled={disabled}
            onChange={(event) =>
              onChange(updatePolicyInstallmentDays(value, Number(event.currentTarget.value || 0)))
            }
          />
          <small>дней после полной отгрузки</small>
        </span>
      </label>

      <div className="finance-policy-stage-list" aria-label="Этапы оплаты">
        {value.stages.map((stage) => {
          const previewRow = preview?.rows.find((row) => row.sequence === stage.sequence);
          const timingLabel =
            stage.trigger === 'invoice_issued'
              ? 'Сразу после выставления счёта'
              : paymentStageConditionLabel(stage.trigger, stage.offsetDays);
          return (
            <article className="finance-policy-stage" key={stage.sequence}>
              <header>
                <div>
                  <b>{stage.sequence}</b>
                  <strong>Этап {stage.sequence}</strong>
                </div>
                {value.stages.length > 1 ? (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Удалить этап ${stage.sequence}`}
                    onClick={() => onChange(removePaymentStage(value, stage.sequence))}
                  >
                    Удалить
                  </button>
                ) : null}
              </header>

              <div className="finance-policy-stage-fields">
                <label>
                  <span>Доля платежа</span>
                  <span className="finance-policy-input-unit">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      inputMode="decimal"
                      value={stage.percentageBasisPoints / 100}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange(
                          updateStage(value, stage.sequence, {
                            percentageBasisPoints: Math.round(
                              Number(event.currentTarget.value || 0) * 100,
                            ),
                          }),
                        )
                      }
                    />
                    <small>%</small>
                  </span>
                </label>

                <label>
                  <span>Точка отсчёта</span>
                  <select
                    value={stage.trigger}
                    disabled={disabled}
                    onChange={(event) => {
                      const trigger = event.currentTarget
                        .value as PaymentPolicyStageDraft['trigger'];
                      onChange(
                        updateStage(value, stage.sequence, {
                          trigger,
                          offsetDays: trigger === 'invoice_issued' ? 0 : stage.offsetDays,
                        }),
                      );
                    }}
                  >
                    <option value="invoice_issued">Выставление счёта</option>
                    <option value="full_shipment">Полная отгрузка</option>
                  </select>
                </label>

                {stage.trigger === 'full_shipment' ? (
                  <label>
                    <span>День платежа</span>
                    <span className="finance-policy-input-unit">
                      <input
                        type="number"
                        min="0"
                        max={value.installmentDays}
                        step="1"
                        value={stage.offsetDays}
                        disabled={disabled}
                        onChange={(event) =>
                          onChange(
                            updateStage(value, stage.sequence, {
                              offsetDays: Number(event.currentTarget.value || 0),
                            }),
                          )
                        }
                      />
                      <small>дней</small>
                    </span>
                  </label>
                ) : (
                  <div className="finance-policy-fixed-date">
                    <span>День платежа</span>
                    <strong>Сразу после выставления счёта</strong>
                  </div>
                )}
              </div>

              <div className={`finance-policy-preview is-${previewRow?.dateKind ?? 'unavailable'}`}>
                <span>{percentageLabel(stage.percentageBasisPoints)}</span>
                <small>{timingLabel}</small>
                {previewRow ? (
                  <>
                    <strong>{moneyLabel(previewRow.amount)}</strong>
                    <span>
                      {previewRow.dateKind === 'actual'
                        ? 'Дата'
                        : paymentStageConditionLabel(previewRow.trigger, previewRow.offsetDays)}
                      {previewRow.date ? ` · ${dateLabel(previewRow.date)}` : ''}
                    </span>
                  </>
                ) : (
                  <span>Дата рассчитывается</span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <button
        className="finance-installment-add-row"
        type="button"
        disabled={disabled || value.stages.length >= MAX_PAYMENT_STAGES}
        onClick={() => onChange(insertPaymentStage(value))}
      >
        Добавить этап
      </button>

      <div className="finance-policy-total" aria-live="polite">
        <span>Распределено</span>
        <strong>{percentageLabel(percentageTotal)}</strong>
        <small>
          {percentageRemainder === 0
            ? `Количество этапов: ${value.stages.length}`
            : percentageRemainder > 0
              ? `Осталось распределить ${percentageLabel(percentageRemainder)}`
              : `Превышение ${percentageLabel(Math.abs(percentageRemainder))}`}
        </small>
      </div>

      {error ? (
        <div className="finance-installment-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
