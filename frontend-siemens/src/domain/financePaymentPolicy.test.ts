import { describe, expect, it } from 'vitest';
import {
  immediate100Template,
  net30Template,
  paymentPolicySummary,
  paymentPolicyDraftError,
  paymentStageCountLabel,
  postpay100Template,
  prepay50Template,
  split50Template,
} from './financePaymentPolicy';

describe('finance payment policy drafts', () => {
  it('uses correct stage grammar and does not describe full prepayment as post-shipment', () => {
    expect(paymentStageCountLabel(1)).toBe('1 этап');
    expect(paymentStageCountLabel(5)).toBe('5 этапов');
    expect(
      paymentPolicySummary({
        installmentDays: 0,
        stages: [
          {
            sequence: 1,
            trigger: 'invoice_issued',
            percentageBasisPoints: 10000,
            offsetDays: 0,
          },
        ],
      }),
    ).toBe('1 этап · полностью при выставлении счёта');
  });

  it('builds a 50/50 template with a configurable final day', () => {
    expect(prepay50Template(45)).toEqual({
      installmentDays: 45,
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
          offsetDays: 45,
        },
      ],
    });
  });

  it('builds a full postpayment template with a configurable final day', () => {
    expect(postpay100Template(60)).toEqual({
      installmentDays: 60,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 60,
        },
      ],
    });
  });

  it('builds the three accountant quick presets with exact agreed conditions', () => {
    expect(immediate100Template()).toEqual({
      installmentDays: 0,
      stages: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 10000,
          offsetDays: 0,
        },
      ],
    });
    expect(split50Template()).toEqual(prepay50Template(30));
    expect(net30Template()).toEqual(postpay100Template(30));
  });

  it('reports the exact percentage remainder', () => {
    expect(
      paymentPolicyDraftError({
        installmentDays: 30,
        stages: [
          {
            sequence: 1,
            trigger: 'full_shipment',
            percentageBasisPoints: 9900,
            offsetDays: 30,
          },
        ],
      }),
    ).toBe('Распределите ещё 1,00%');
  });

  it('accepts a complete ordered policy', () => {
    expect(paymentPolicyDraftError(prepay50Template(30))).toBeNull();
  });

  it('rejects more than one invoice-day prepayment', () => {
    expect(
      paymentPolicyDraftError({
        installmentDays: 0,
        stages: [
          { sequence: 1, trigger: 'invoice_issued', percentageBasisPoints: 5000, offsetDays: 0 },
          { sequence: 2, trigger: 'invoice_issued', percentageBasisPoints: 5000, offsetDays: 0 },
        ],
      }),
    ).toBe('Добавьте не больше одной предоплаты в день выставления счёта');
  });

  it('requires the final deferred stage on the final installment day', () => {
    expect(
      paymentPolicyDraftError({
        installmentDays: 30,
        stages: [
          { sequence: 1, trigger: 'full_shipment', percentageBasisPoints: 10000, offsetDays: 15 },
        ],
      }),
    ).toBe('Последний платёж должен быть назначен на 30-й день рассрочки');
  });

  it('requires a zero term for a full prepayment policy', () => {
    expect(
      paymentPolicyDraftError({
        installmentDays: 30,
        stages: [
          { sequence: 1, trigger: 'invoice_issued', percentageBasisPoints: 10000, offsetDays: 0 },
        ],
      }),
    ).toBe('Для 100% предоплаты срок рассрочки должен быть 0 дней');
  });

  it('limits a policy to fifty stages', () => {
    expect(
      paymentPolicyDraftError({
        installmentDays: 49,
        stages: Array.from({ length: 51 }, (_, index) => ({
          sequence: index + 1,
          trigger: 'full_shipment' as const,
          percentageBasisPoints: index === 50 ? 9950 : 1,
          offsetDays: index,
        })),
      }),
    ).toBe('Добавьте не больше 50 этапов оплаты');
  });
});
