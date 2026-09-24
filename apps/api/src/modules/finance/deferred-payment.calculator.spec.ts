import type { PaymentPolicyInput } from '@plenka/contracts';
import {
  addCalendarDays,
  allocatePaymentPolicy,
  buildDeferredPaymentRows,
  paymentPolicyFromLegacyType,
  postDeliveryDueDate,
  projectedScheduleDate,
  validatePaymentPolicy,
} from './deferred-payment.calculator';

const customPolicy: PaymentPolicyInput = {
  installmentDays: 30,
  stages: [
    {
      sequence: 1,
      trigger: 'invoice_issued',
      percentageBasisPoints: 2000,
      offsetDays: 0,
    },
    {
      sequence: 2,
      trigger: 'full_shipment',
      percentageBasisPoints: 3000,
      offsetDays: 0,
    },
    {
      sequence: 3,
      trigger: 'full_shipment',
      percentageBasisPoints: 2500,
      offsetDays: 15,
    },
    {
      sequence: 4,
      trigger: 'full_shipment',
      percentageBasisPoints: 2500,
      offsetDays: 30,
    },
  ],
};

const invalidPolicies: Array<{
  name: string;
  policy: PaymentPolicyInput;
  message: string;
}> = [
  {
    name: 'an empty stage list',
    policy: { installmentDays: 30, stages: [] },
    message: 'от 1 до 50',
  },
  {
    name: 'more than 50 stages',
    policy: {
      installmentDays: 50,
      stages: Array.from({ length: 51 }, (_, index) => ({
        sequence: index + 1,
        trigger: 'full_shipment' as const,
        percentageBasisPoints: index === 50 ? 9950 : 1,
        offsetDays: index,
      })),
    },
    message: 'от 1 до 50',
  },
  {
    name: 'a negative installment term',
    policy: {
      installmentDays: -1,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 0,
        },
      ],
    },
    message: 'неотрицательным целым числом',
  },
  {
    name: 'a fractional installment term',
    policy: {
      installmentDays: 30.5,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 30,
        },
      ],
    },
    message: 'неотрицательным целым числом',
  },
  {
    name: 'duplicate sequence values',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 15,
        },
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 30,
        },
      ],
    },
    message: 'без пропусков и повторов',
  },
  {
    name: 'a sequence gap',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 15,
        },
        {
          sequence: 3,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 30,
        },
      ],
    },
    message: 'без пропусков и повторов',
  },
  {
    name: 'a fractional sequence value',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1.5,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 30,
        },
      ],
    },
    message: 'без пропусков и повторов',
  },
  {
    name: 'zero basis points',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 0,
          offsetDays: 30,
        },
      ],
    },
    message: 'от 1 до 10000',
  },
  {
    name: 'more than 10000 basis points in one stage',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10001,
          offsetDays: 30,
        },
      ],
    },
    message: 'от 1 до 10000',
  },
  {
    name: 'fractional basis points',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000.5,
          offsetDays: 30,
        },
      ],
    },
    message: 'от 1 до 10000',
  },
  {
    name: 'a basis-point total below 10000',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 9999,
          offsetDays: 30,
        },
      ],
    },
    message: '100,00%',
  },
  {
    name: 'an unsupported trigger',
    policy: {
      installmentDays: 0,
      stages: [
        {
          sequence: 1,
          trigger: 'manual' as never,
          percentageBasisPoints: 10000,
          offsetDays: 0,
        },
      ],
    },
    message: 'триггер',
  },
  {
    name: 'more than one prepayment',
    policy: {
      installmentDays: 0,
      stages: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 5000,
          offsetDays: 0,
        },
        {
          sequence: 2,
          trigger: 'invoice_issued',
          percentageBasisPoints: 5000,
          offsetDays: 0,
        },
      ],
    },
    message: 'Максимум одна предоплата',
  },
  {
    name: 'a non-zero prepayment offset',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 5000,
          offsetDays: 1,
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 30,
        },
      ],
    },
    message: 'Предоплата',
  },
  {
    name: 'a negative deferred offset',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: -1,
        },
      ],
    },
    message: 'от 0 до срока рассрочки',
  },
  {
    name: 'a deferred offset after the installment term',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 31,
        },
      ],
    },
    message: 'от 0 до срока рассрочки',
  },
  {
    name: 'a fractional deferred offset',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 29.5,
        },
      ],
    },
    message: 'от 0 до срока рассрочки',
  },
  {
    name: 'decreasing deferred offsets',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 3000,
          offsetDays: 20,
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 3000,
          offsetDays: 10,
        },
        {
          sequence: 3,
          trigger: 'full_shipment',
          percentageBasisPoints: 4000,
          offsetDays: 30,
        },
      ],
    },
    message: 'строго возрастать',
  },
  {
    name: 'duplicate deferred offsets',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 3000,
          offsetDays: 15,
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 3000,
          offsetDays: 15,
        },
        {
          sequence: 3,
          trigger: 'full_shipment',
          percentageBasisPoints: 4000,
          offsetDays: 30,
        },
      ],
    },
    message: 'строго возрастать',
  },
  {
    name: 'a final deferred offset different from the installment term',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 15,
        },
      ],
    },
    message: 'последнего отложенного этапа',
  },
  {
    name: 'a non-zero installment term for full prepayment',
    policy: {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 10000,
          offsetDays: 0,
        },
      ],
    },
    message: '100% предоплаты',
  },
];

describe('deferred payment calculator', () => {
  it('allocates arbitrary percentages with an exact kopeck total', () => {
    expect(allocatePaymentPolicy(1000.01, customPolicy)).toEqual([
      expect.objectContaining({ sequence: 1, amount: 200 }),
      expect.objectContaining({ sequence: 2, amount: 300.01 }),
      expect.objectContaining({ sequence: 3, amount: 250 }),
      expect.objectContaining({ sequence: 4, amount: 250 }),
    ]);
  });

  it('breaks equal allocation remainders by sequence and returns sequence order', () => {
    const tiePolicy: PaymentPolicyInput = {
      installmentDays: 3,
      stages: [
        {
          sequence: 4,
          trigger: 'full_shipment',
          percentageBasisPoints: 2500,
          offsetDays: 3,
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 2500,
          offsetDays: 1,
        },
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 2500,
          offsetDays: 0,
        },
        {
          sequence: 3,
          trigger: 'full_shipment',
          percentageBasisPoints: 2500,
          offsetDays: 2,
        },
      ],
    };

    expect(
      allocatePaymentPolicy(0.01, tiePolicy).map(({ sequence, amount }) => ({ sequence, amount })),
    ).toEqual([
      { sequence: 1, amount: 0.01 },
      { sequence: 2, amount: 0 },
      { sequence: 3, amount: 0 },
      { sequence: 4, amount: 0 },
    ]);
  });

  it('allocates the largest safe kopeck total by exact remainder order', () => {
    const precisionBoundaryPolicy: PaymentPolicyInput = {
      installmentDays: 1,
      stages: [
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 6494,
          offsetDays: 1,
        },
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 3506,
          offsetDays: 0,
        },
      ],
    };
    const amount = Number.MAX_SAFE_INTEGER / 100;

    const allocation = allocatePaymentPolicy(amount, precisionBoundaryPolicy);

    expect(
      allocation.map(({ sequence, amount: stageAmount }) => ({ sequence, stageAmount })),
    ).toEqual([
      { sequence: 1, stageAmount: 31_579_240_587_121.91 },
      { sequence: 2, stageAmount: 58_492_751_960_288 },
    ]);
    expect(allocation.reduce((total, stage) => total + stage.amount, 0)).toBe(amount);
  });

  it('rejects an invoice total outside the safe kopeck range', () => {
    expect(() => allocatePaymentPolicy((Number.MAX_SAFE_INTEGER + 1) / 100, customPolicy)).toThrow(
      'Сумма счета превышает безопасный диапазон.',
    );
  });

  it('accepts a single 100% invoice-issued stage with a zero installment term', () => {
    expect(() =>
      validatePaymentPolicy({
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
    ).not.toThrow();
  });

  it.each(invalidPolicies)('rejects $name', ({ policy, message }) => {
    expect(() => validatePaymentPolicy(policy)).toThrow(message);
  });

  it('maps both legacy payment types to fixed canonical policies', () => {
    expect(paymentPolicyFromLegacyType('prepay_50_postpay_50_30d')).toEqual({
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
    expect(paymentPolicyFromLegacyType('postpay_100_30d')).toEqual({
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

  it('adds calendar days with date-only semantics', () => {
    expect(addCalendarDays('2026-07-20', 30)).toBe('2026-08-19');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it.each([-1, 1.5])('rejects an invalid calendar-day count (%s)', (days) => {
    expect(() => addCalendarDays('2026-07-20', days)).toThrow('неотрицательным целым числом');
  });

  it('returns the invoice date as an actual date for prepayment', () => {
    expect(
      projectedScheduleDate({
        invoiceDate: '2026-07-10',
        shipmentDate: null,
        trigger: 'invoice_issued',
        offsetDays: 0,
      }),
    ).toEqual({ date: '2026-07-10', kind: 'actual' });
  });

  it('keeps an invoice stage undated until the invoice is issued', () => {
    expect(
      projectedScheduleDate({
        invoiceDate: null,
        shipmentDate: null,
        trigger: 'invoice_issued',
        offsetDays: 0,
      }),
    ).toEqual({ date: null, kind: 'condition' });
  });

  it('keeps a full-shipment stage undated until shipment and dates it after shipment', () => {
    expect(
      projectedScheduleDate({
        invoiceDate: '2026-07-10',
        shipmentDate: null,
        trigger: 'full_shipment',
        offsetDays: 30,
      }),
    ).toEqual({ date: null, kind: 'condition' });
    expect(
      projectedScheduleDate({
        invoiceDate: '2026-07-10',
        shipmentDate: '2026-07-15',
        trigger: 'full_shipment',
        offsetDays: 30,
      }),
    ).toEqual({ date: '2026-08-14', kind: 'actual' });
  });

  it('does not turn the invoice date into a full-shipment payment date', () => {
    expect(
      projectedScheduleDate({
        invoiceDate: '2026-07-10',
        shipmentDate: null,
        trigger: 'full_shipment',
        offsetDays: 5,
      }),
    ).toEqual({ date: null, kind: 'condition' });
  });

  it('builds exact 50/50 rows and dates only the prepayment', () => {
    expect(buildDeferredPaymentRows(1000.01, 'prepay_50_postpay_50_30d', '2026-07-11')).toEqual([
      { kind: 'invoice_prepayment', amount: 500, dueDate: '2026-07-11' },
      { kind: 'post_delivery', amount: 500.01, dueDate: null },
    ]);
  });

  it('builds one undated row for full post-payment', () => {
    expect(buildDeferredPaymentRows(150000, 'postpay_100_30d', '2026-07-11')).toEqual([
      { kind: 'post_delivery', amount: 150000, dueDate: null },
    ]);
  });

  it('adds exactly 30 calendar days across month boundaries', () => {
    expect(postDeliveryDueDate('2026-07-31')).toBe('2026-08-30');
  });

  it('rejects an invalid invoice amount', () => {
    expect(() => buildDeferredPaymentRows(0, 'postpay_100_30d', '2026-07-11')).toThrow(
      'Сумма счета должна быть больше нуля',
    );
  });

  it('rejects an implausible business date', () => {
    expect(() => postDeliveryDueDate('0026-07-11')).toThrow('Указана неверная дата');
  });
});
