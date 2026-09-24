import { describe, expect, it } from 'vitest';
import type { WorkObject } from './types';
import { buildFinancePaymentOperationIntent } from './financePaymentAction';

function financeObject(remainingAmount: string | null): WorkObject {
  return {
    id: 'finance-order-1',
    kind: 'financeOrder',
    title: 'Финансы A-1',
    statusLabel: 'Частично оплачен',
    nextOwner: 'Бухгалтерия',
    severity: 'warning',
    facts: [{ label: 'Сумма', value: '1 000 ₽', scope: 'sensitiveFinance' }],
    sections: [],
    actions: [],
    problems: [],
    audit: [],
    financePaymentSummary: {
      invoiceAmount: '1000.00',
      paidAmount: '400.00',
      remainingAmount,
      overpaidAmount: '0.00',
    },
  };
}

describe('finance payment action intent', () => {
  it('uses the canonical remaining amount instead of the invoice total for manual paid', () => {
    expect(buildFinancePaymentOperationIntent(financeObject('600.00'))).toEqual({
      intent:
        'finance:payment-operation:["finance-order-1","manual_adjustment",600]',
      operationType: 'manual_adjustment',
      amount: 600,
    });
  });

  it('binds a distributed amount into a distinct exact idempotency intent', () => {
    expect(buildFinancePaymentOperationIntent(financeObject('600.00'), 400)).toEqual({
      intent:
        'finance:payment-operation:["finance-order-1","manual_adjustment",400]',
      operationType: 'manual_adjustment',
      amount: 400,
    });
  });

  it.each([null, '0.00', '-1.00'])('rejects a non-positive canonical remainder %p', (remaining) => {
    expect(buildFinancePaymentOperationIntent(financeObject(remaining))).toBeNull();
  });
});
