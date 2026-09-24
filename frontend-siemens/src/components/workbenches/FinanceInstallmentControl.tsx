import { useState } from 'react';

import { paymentPolicySummary } from '../../domain/financePaymentPolicy';
import type { WorkObject } from '../../domain/types';
import { FinanceInstallmentWizard } from './FinanceInstallmentWizard';

export function FinanceInstallmentControl({
  object,
  onSaved,
}: {
  object: WorkObject;
  onSaved?: (object: WorkObject) => void;
}) {
  const [open, setOpen] = useState(false);
  const action = object.actions.find((item) => item.id.startsWith('finance-payment-terms:'));

  if (!action) return null;

  const policyLabel = object.paymentPolicy
    ? paymentPolicySummary(object.paymentPolicy)
    : object.paymentTermsType === 'postpay_100_30d'
      ? '100% через 30 дней'
      : '50% сейчас + 50% через 30 дней';

  return (
    <>
      <div className="finance-installment-entry" aria-label="Условия оплаты заказа">
        <div>
          <span>Условия оплаты</span>
          <strong>{policyLabel}</strong>
        </div>
        <button
          type="button"
          disabled={!action.enabled}
          aria-label="Открыть визард условий оплаты"
          onClick={() => setOpen(true)}
        >
          {action.label}
        </button>
      </div>
      {open ? (
        <FinanceInstallmentWizard
          object={object}
          onClose={() => setOpen(false)}
          onSaved={(updated) => onSaved?.(updated)}
        />
      ) : null}
    </>
  );
}
