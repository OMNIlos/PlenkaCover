import type { WorkObject } from './types';

export type FinancePaymentOperationIntent = {
  intent: string;
  operationType: 'manual_adjustment';
  amount: number;
};

export function buildFinancePaymentOperationIntent(
  order: WorkObject,
  explicitAmount?: number,
): FinancePaymentOperationIntent | null {
  const remaining = order.financePaymentSummary?.remainingAmount;
  const amount = explicitAmount ?? (remaining === null || remaining === undefined ? 0 : Number(remaining));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const operationType = 'manual_adjustment' as const;
  return {
    intent: `finance:payment-operation:${JSON.stringify([order.id, operationType, amount])}`,
    operationType,
    amount,
  };
}
