import { Prisma } from '@prisma/client';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  allocatePaymentAmount,
  matchPaymentReceipt,
  PaymentAllocationService,
  reversalAmount,
  type PaymentMatchOrder,
} from './payment-allocation.service';

const orders: PaymentMatchOrder[] = [
  {
    financeOrderId: 'fo-42',
    invoiceExternalId: 'invoice-42',
    invoiceNumber: 'СЧ-0042',
    invoiceCurrency: 'RUB',
    orderReference: 'PLENKA_ORDER=ЗК-0042',
    counterpartyExternalId: 'counterparty-1',
  },
  {
    financeOrderId: 'fo-43',
    invoiceExternalId: 'invoice-43',
    invoiceNumber: 'СЧ-0043',
    invoiceCurrency: 'RUB',
    orderReference: 'PLENKA_ORDER=ЗК-0043',
    counterpartyExternalId: 'counterparty-1',
  },
];

describe('payment receipt matching', () => {
  it('matches an exact invoice Ref_Key before every secondary reference', () => {
    expect(
      matchPaymentReceipt(
        {
          invoiceExternalId: 'invoice-42',
          invoiceNumberReference: 'СЧ-0043',
          orderReference: 'PLENKA_ORDER=ЗК-0043',
          counterpartyExternalId: 'counterparty-1',
          currency: 'RUB',
        },
        orders,
      ),
    ).toEqual({ kind: 'invoice_ref', financeOrderId: 'fo-42' });
  });

  it('matches an exact marker only with the same counterparty and currency', () => {
    expect(
      matchPaymentReceipt(
        {
          invoiceExternalId: null,
          invoiceNumberReference: null,
          orderReference: 'PLENKA_ORDER=ЗК-0042',
          counterpartyExternalId: 'counterparty-1',
          currency: 'RUB',
        },
        orders,
      ),
    ).toEqual({ kind: 'order_marker', financeOrderId: 'fo-42' });

    expect(
      matchPaymentReceipt(
        {
          invoiceExternalId: null,
          invoiceNumberReference: null,
          orderReference: 'PLENKA_ORDER=ЗК-0042',
          counterpartyExternalId: 'another-counterparty',
          currency: 'RUB',
        },
        orders,
      ),
    ).toEqual({ kind: 'unmatched', candidateFinanceOrderIds: [] });
  });

  it('keeps invoice-number-only matches as a proposal', () => {
    expect(
      matchPaymentReceipt(
        {
          invoiceExternalId: null,
          invoiceNumberReference: 'СЧ-0042',
          orderReference: null,
          counterpartyExternalId: 'counterparty-1',
          currency: 'RUB',
        },
        orders,
      ),
    ).toEqual({
      kind: 'invoice_number_proposal',
      candidateFinanceOrderIds: ['fo-42'],
    });
  });
});

describe('payment allocation arithmetic', () => {
  it('fills earliest schedule balances and preserves overpayment as an order-level row', () => {
    expect(
      allocatePaymentAmount('1500.00', [
        { scheduleId: 'schedule-1', remaining: '600.00' },
        { scheduleId: 'schedule-2', remaining: '600.00' },
      ]),
    ).toEqual([
      { scheduleId: 'schedule-1', amount: '600.00' },
      { scheduleId: 'schedule-2', amount: '600.00' },
      { scheduleId: null, amount: '300.00' },
    ]);
  });

  it('uses exact cents and creates a negative compensating amount', () => {
    expect(
      allocatePaymentAmount('0.03', [{ scheduleId: 'schedule-1', remaining: '0.02' }]),
    ).toEqual([
      { scheduleId: 'schedule-1', amount: '0.02' },
      { scheduleId: null, amount: '0.01' },
    ]);
    expect(reversalAmount('600.00')).toBe('-600.00');
  });
});

function serviceSetup() {
  const schedules = [
    {
      id: 'schedule-1',
      amount: new Prisma.Decimal(600),
      status: 'unpaid',
      dueDate: new Date('2026-08-02T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      allocations: [],
    },
    {
      id: 'schedule-2',
      amount: new Prisma.Decimal(600),
      status: 'unpaid',
      dueDate: new Date('2026-09-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      allocations: [],
    },
  ];
  const order = {
    id: 'fo-42',
    commercialOrderId: 'co-42',
    productionClearedAt: null,
    invoiceStatus: 'invoiced',
    invoiceSyncState: 'posted',
    paymentTermsType: null,
    policy: {
      id: 'policy-42',
      stages: [{ id: 'prepay-stage', trigger: 'invoice_issued' }],
    },
    amountValue: new Prisma.Decimal(1200),
    schedules: [
      {
        ...schedules[0],
        paymentPolicyStageId: 'prepay-stage',
        kind: 'invoice_prepayment',
      },
      {
        ...schedules[1],
        paymentPolicyStageId: 'postpay-stage',
        kind: 'post_delivery',
      },
    ],
  };
  const refreshedOrder = {
    ...order,
    paymentAllocations: [
      { amount: new Prisma.Decimal(600) },
      { amount: new Prisma.Decimal(600) },
      { amount: new Prisma.Decimal(300) },
    ],
    schedules: [
      {
        ...order.schedules[0],
        allocations: [{ amount: new Prisma.Decimal(600) }],
      },
      {
        ...order.schedules[1],
        allocations: [{ amount: new Prisma.Decimal(600) }],
      },
    ],
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    paymentReceipt: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'receipt-1',
        externalId: 'payment-1',
        sourceVersion: 'payment-v1',
        amount: new Prisma.Decimal(1500),
        posted: true,
        deleted: false,
        allocations: [],
      }),
      update: jest.fn(),
    },
    financePaymentAllocationCommand: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'command-1',
        receiptId: 'receipt-1',
        requestFingerprint: requestFingerprint({
          command: 'manual_payment_allocation',
          receiptId: 'receipt-1',
          reason: 'Проверено бухгалтером по банковской выписке',
          targets: [{ financeOrderId: 'fo-42', amount: '1500.00' }],
        }),
        result: null,
      }),
      update: jest.fn(),
    },
    financeOrder: {
      update: jest.fn(),
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(order)
        .mockResolvedValueOnce(refreshedOrder)
        .mockResolvedValue({
          ...refreshedOrder,
          schedules: [
            { ...refreshedOrder.schedules[0], status: 'paid' },
            refreshedOrder.schedules[1],
          ],
        }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    financePaymentAllocation: {
      create: jest.fn().mockImplementation(({ data }: { data: { amount: string } }) =>
        Promise.resolve({
          id: `allocation-${tx.financePaymentAllocation.create.mock.calls.length}`,
          ...data,
          amount: new Prisma.Decimal(data.amount),
        }),
      ),
    },
    paymentOperation: { create: jest.fn() },
    paymentSchedule: { update: jest.fn() },
    commercialOrder: { update: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const audit = { record: jest.fn() };
  return {
    audit,
    service: new PaymentAllocationService(prisma as never, audit as never),
    tx,
  };
}

describe('PaymentAllocationService', () => {
  it('manually splits one receipt across schedules and keeps overpayment', async () => {
    const { audit, service, tx } = serviceSetup();

    await expect(
      service.resolve({ userId: 'finance-1', role: 'finance' }, 'receipt-1', {
        operationKey: '2cc610b7-f906-414b-b62d-a43c514b2139',
        reason: 'Проверено бухгалтером по банковской выписке',
        allocations: [{ financeOrderId: 'fo-42', amount: 1500 }],
      }),
    ).resolves.toMatchObject({
      allocatedAmount: '1500.00',
      allocations: [
        { scheduleId: 'schedule-1', amount: '600.00' },
        { scheduleId: 'schedule-2', amount: '600.00' },
        { scheduleId: null, amount: '300.00' },
      ],
    });
    expect(tx.financePaymentAllocation.create).toHaveBeenCalledTimes(3);
    expect(tx.paymentOperation.create).toHaveBeenCalledTimes(3);
    expect(tx.paymentOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentAllocationId: 'allocation-1',
        paymentScheduleId: 'schedule-1',
        source: '1C',
      }),
    });
    expect(tx.financePaymentAllocationCommand.update).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:payment_status_imported',
        reason: 'Проверено бухгалтером по банковской выписке',
      }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:finance_production_cleared',
        objectId: 'fo-42',
      }),
      tx,
    );
  });
});
