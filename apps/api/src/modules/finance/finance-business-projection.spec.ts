import { Prisma } from '@prisma/client';
import {
  confirmedFinancePaidAmount,
  moscowBusinessDate,
  projectFinancePaymentState,
  type FinanceScheduleFact,
} from './finance-business-projection';

const schedule = (overrides: Partial<FinanceScheduleFact> = {}): FinanceScheduleFact => ({
  id: 'schedule-1',
  dueDate: new Date('2026-08-10T00:00:00.000Z'),
  amount: new Prisma.Decimal('100.00'),
  allocatedAmount: new Prisma.Decimal('25.00'),
  ...overrides,
});

describe('finance business payment projection', () => {
  it('adds independent operations to allocations without counting mirrored operations twice', () => {
    expect(
      confirmedFinancePaidAmount({
        allocations: [{ amount: new Prisma.Decimal('40.00') }],
        operations: [
          {
            amount: new Prisma.Decimal('40.00'),
            paymentAllocationId: 'allocation-1',
          },
          { amount: new Prisma.Decimal('10.00'), paymentAllocationId: null },
        ],
        fallbackPaidAmount: new Prisma.Decimal('100.00'),
      }).toFixed(2),
    ).toBe('50.00');
  });

  it('uses the fallback only when no canonical allocation or independent operation exists', () => {
    expect(
      confirmedFinancePaidAmount({
        allocations: [],
        operations: [],
        fallbackPaidAmount: new Prisma.Decimal('100.00'),
      }).toFixed(2),
    ).toBe('100.00');
  });

  it.each([
    ['an empty fallback', ['400.00', '600.00'], '0.00', '1000.00'],
    ['a paid-schedule fallback', ['400.00'], '1000.00', '400.00'],
  ])(
    'uses independent operations instead of %s',
    (_label, operationAmounts, fallbackPaidAmount, expectedPaidAmount) => {
      expect(
        confirmedFinancePaidAmount({
          allocations: [],
          operations: operationAmounts.map((amount) => ({
            amount: new Prisma.Decimal(amount),
            paymentAllocationId: null,
          })),
          fallbackPaidAmount: new Prisma.Decimal(fallbackPaidAmount),
        }).toFixed(2),
      ).toBe(expectedPaidAmount);
    },
  );

  it('does not resurrect a stale fallback when canonical facts cancel to zero', () => {
    expect(
      confirmedFinancePaidAmount({
        allocations: [
          { amount: new Prisma.Decimal('40.00') },
          { amount: new Prisma.Decimal('-40.00') },
        ],
        operations: [],
        fallbackPaidAmount: new Prisma.Decimal('100.00'),
      }).toFixed(2),
    ).toBe('0.00');
  });

  it('uses Europe/Moscow calendar boundaries instead of UTC dates', () => {
    expect(moscowBusinessDate(new Date('2026-08-10T21:30:00.000Z'))).toBe('2026-08-11');
  });

  it('keeps the due day current and marks it overdue only after Moscow midnight', () => {
    expect(
      projectFinancePaymentState({
        invoiceAmount: new Prisma.Decimal('100.00'),
        paidAmount: new Prisma.Decimal('25.00'),
        schedules: [schedule()],
        now: new Date('2026-08-10T20:59:59.999Z'),
      }),
    ).toMatchObject({ status: 'partial', isOverdue: false, overdueAmount: '0.00' });

    expect(
      projectFinancePaymentState({
        invoiceAmount: new Prisma.Decimal('100.00'),
        paidAmount: new Prisma.Decimal('25.00'),
        schedules: [schedule()],
        now: new Date('2026-08-10T21:00:00.000Z'),
      }),
    ).toMatchObject({ status: 'overdue', isOverdue: true, overdueAmount: '75.00' });
  });

  it('does not invent an overdue date for an undated condition or keep a paid item overdue', () => {
    expect(
      projectFinancePaymentState({
        invoiceAmount: new Prisma.Decimal('100.00'),
        paidAmount: new Prisma.Decimal('100.00'),
        schedules: [schedule({ dueDate: null, allocatedAmount: new Prisma.Decimal('100.00') })],
        now: new Date('2026-08-15T10:00:00.000Z'),
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'paid',
        isOverdue: false,
        remainingAmount: '0.00',
        schedules: [
          expect.objectContaining({
            status: 'paid',
            dueDate: null,
            dueLabel: 'Срок не установлен',
            isOverdue: false,
          }),
        ],
      }),
    );
  });
});
