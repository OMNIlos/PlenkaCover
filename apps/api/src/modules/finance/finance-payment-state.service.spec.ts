import { Prisma } from '@prisma/client';
import {
  deriveCorrectedPaymentStatus,
  FinancePaymentStateService,
} from './finance-payment-state.service';

describe('deriveCorrectedPaymentStatus', () => {
  it('uses the latest uncorrected status-only fact', () => {
    expect(
      deriveCorrectedPaymentStatus({
        invoiceAmount: null,
        schedules: [],
        reconciledAmounts: [],
        paymentUpdates: [
          { id: 'old', requestedStatus: 'partial', createdAt: new Date('2026-08-04T09:00:00Z') },
          { id: 'mistake', requestedStatus: 'paid', createdAt: new Date('2026-08-04T10:00:00Z') },
        ],
        correctedPaymentUpdateIds: new Set(['mistake']),
        fallbackStatus: 'unpaid',
      }),
    ).toBe('partial');
  });

  it('derives partial and unpaid after one selected schedule is restored', () => {
    expect(
      deriveCorrectedPaymentStatus({
        invoiceAmount: new Prisma.Decimal(1000),
        schedules: [{ status: 'paid' }, { status: 'unpaid' }],
        reconciledAmounts: [],
        paymentUpdates: [],
        correctedPaymentUpdateIds: new Set(),
        fallbackStatus: 'unpaid',
      }),
    ).toBe('partial');
    expect(
      deriveCorrectedPaymentStatus({
        invoiceAmount: new Prisma.Decimal(1000),
        schedules: [{ status: 'unpaid' }, { status: 'unpaid' }],
        reconciledAmounts: [],
        paymentUpdates: [],
        correctedPaymentUpdateIds: new Set(),
        fallbackStatus: 'unpaid',
      }),
    ).toBe('unpaid');
  });

  it('uses the net reconciled amount before schedule projections', () => {
    expect(
      deriveCorrectedPaymentStatus({
        invoiceAmount: new Prisma.Decimal(1000),
        schedules: [{ status: 'paid' }],
        reconciledAmounts: [new Prisma.Decimal(1000), new Prisma.Decimal(-400)],
        paymentUpdates: [],
        correctedPaymentUpdateIds: new Set(),
        fallbackStatus: 'unpaid',
      }),
    ).toBe('partial');
  });
});

describe('FinancePaymentStateService', () => {
  it('updates only payment projections and preserves sticky production clearance', async () => {
    const productionClearedAt = new Date('2026-08-04T08:00:00.000Z');
    const tx = {
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'finance-1',
          commercialOrderId: 'order-1',
          amountValue: new Prisma.Decimal(1000),
          paymentStatus: 'paid',
          productionClearedAt,
          schedules: [{ status: 'unpaid' }],
          operations: [{ amount: new Prisma.Decimal(1000) }, { amount: new Prisma.Decimal(-1000) }],
          paymentUpdateCommands: [],
          paymentCorrections: [],
        }),
        update: jest.fn(),
      },
      commercialOrder: { update: jest.fn() },
    };
    const service = new FinancePaymentStateService();

    await expect(service.recompute(tx as never, 'finance-1', 'unpaid')).resolves.toEqual({
      paymentStatus: 'unpaid',
      productionClearedAt,
    });
    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'finance-1' },
      data: { paymentStatus: 'unpaid' },
    });
    expect(tx.commercialOrder.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { paymentStatus: 'unpaid' },
    });
    expect(JSON.stringify(tx.financeOrder.update.mock.calls)).not.toContain('productionClearedAt');
  });
});
