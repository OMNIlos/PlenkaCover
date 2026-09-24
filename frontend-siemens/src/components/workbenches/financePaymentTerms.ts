import type { PaymentTermType } from '../../domain/types';
import {
  paymentStageConditionLabel,
  postpay100Template,
  prepay50Template,
} from '../../domain/financePaymentPolicy';

export { paymentStageConditionLabel };

export const PREPAY_50_TEMPLATE = prepay50Template(30);
export const POSTPAY_100_TEMPLATE = postpay100Template(30);

export const FINANCE_PAYMENT_TERM_OPTIONS: ReadonlyArray<{
  value: PaymentTermType;
  title: string;
  description: string;
}> = [
  {
    value: 'prepay_50_postpay_50_30d',
    title: '50% сейчас + 50% через 30 дней',
    description: '50% — после выставления счета. Остаток — через 30 дней после выдачи заказа.',
  },
  {
    value: 'postpay_100_30d',
    title: '100% через 30 дней',
    description: 'Вся сумма — через 30 дней после выдачи заказа.',
  },
];

export function financePaymentTermTitle(type: PaymentTermType) {
  return FINANCE_PAYMENT_TERM_OPTIONS.find((option) => option.value === type)?.title ?? '';
}
