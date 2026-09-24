import { describe, expect, it } from 'vitest';
import {
  FINANCE_PAYMENT_TERM_OPTIONS,
  POSTPAY_100_TEMPLATE,
  PREPAY_50_TEMPLATE,
  financePaymentTermTitle,
} from './financePaymentTerms';

describe('finance payment-term copy', () => {
  it('uses only approved product-facing descriptions', () => {
    expect(FINANCE_PAYMENT_TERM_OPTIONS).toEqual([
      {
        value: 'prepay_50_postpay_50_30d',
        title: '50% сейчас + 50% через 30 дней',
        description:
          '50% — после выставления счета. Остаток — через 30 дней после выдачи заказа.',
      },
      {
        value: 'postpay_100_30d',
        title: '100% через 30 дней',
        description: 'Вся сумма — через 30 дней после выдачи заказа.',
      },
    ]);
    expect(financePaymentTermTitle('postpay_100_30d')).toBe('100% через 30 дней');
    expect(JSON.stringify(FINANCE_PAYMENT_TERM_OPTIONS)).not.toMatch(
      /Бухгалтерия|ручное редактирование|недоступно/,
    );
  });

  it('exports canonical templates for legacy quick choices', () => {
    expect(PREPAY_50_TEMPLATE).toEqual({
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 5000,
          offsetDays: 0,
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 30,
        },
      ],
    });
    expect(POSTPAY_100_TEMPLATE).toEqual({
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 30,
        },
      ],
    });
  });
});
