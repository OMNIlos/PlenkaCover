import { Prisma } from '@prisma/client';

const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export type FinanceScheduleFact = {
  id: string;
  dueDate: Date | null;
  amount: Prisma.Decimal;
  allocatedAmount: Prisma.Decimal;
};

export type FinanceBusinessPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'overdue';

const zero = () => new Prisma.Decimal(0);
const nonNegative = (value: Prisma.Decimal) => Prisma.Decimal.max(value, zero());

export function confirmedFinancePaidAmount(input: {
  allocations: Array<{ amount: Prisma.Decimal }>;
  operations: Array<{ amount: Prisma.Decimal; paymentAllocationId?: string | null }>;
  fallbackPaidAmount: Prisma.Decimal;
}): Prisma.Decimal {
  const independentOperations = input.operations.filter(
    (operation) =>
      operation.paymentAllocationId === null || operation.paymentAllocationId === undefined,
  );
  if (input.allocations.length === 0 && independentOperations.length === 0) {
    return input.fallbackPaidAmount;
  }

  const allocatedAmount = input.allocations.reduce(
    (sum, allocation) => sum.add(allocation.amount),
    zero(),
  );
  return independentOperations.reduce(
    (sum, operation) => sum.add(operation.amount),
    allocatedAmount,
  );
}

export function moscowBusinessDate(now: Date): string {
  return MOSCOW_DATE_FORMATTER.format(now);
}

function calendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function projectFinancePaymentState(input: {
  invoiceAmount: Prisma.Decimal | null;
  paidAmount: Prisma.Decimal;
  schedules: FinanceScheduleFact[];
  now: Date;
}) {
  const today = moscowBusinessDate(input.now);
  const invoiceRemaining =
    input.invoiceAmount === null ? null : nonNegative(input.invoiceAmount.sub(input.paidAmount));
  const schedules = input.schedules.map((schedule) => {
    const paidAmount = nonNegative(schedule.allocatedAmount);
    const remainingAmount = nonNegative(schedule.amount.sub(paidAmount));
    const dueDate = schedule.dueDate ? calendarDate(schedule.dueDate) : null;
    const isOverdue = Boolean(dueDate && dueDate < today && remainingAmount.greaterThan(0));
    const status: FinanceBusinessPaymentStatus = remainingAmount.isZero()
      ? 'paid'
      : isOverdue
        ? 'overdue'
        : paidAmount.greaterThan(0)
          ? 'partial'
          : 'unpaid';

    return {
      id: schedule.id,
      dueDate,
      dueLabel: dueDate ?? 'Срок не установлен',
      amount: schedule.amount.toFixed(2),
      paidAmount: paidAmount.toFixed(2),
      remainingAmount: remainingAmount.toFixed(2),
      status,
      isOverdue,
    };
  });
  const scheduledOverdueAmount = schedules.reduce(
    (sum, schedule) => (schedule.isOverdue ? sum.add(schedule.remainingAmount) : sum),
    zero(),
  );
  const overdueAmount =
    invoiceRemaining === null
      ? scheduledOverdueAmount
      : Prisma.Decimal.min(scheduledOverdueAmount, invoiceRemaining);
  const isPaid = invoiceRemaining?.isZero() ?? false;
  const isOverdue = !isPaid && overdueAmount.greaterThan(0);
  const status: FinanceBusinessPaymentStatus = isPaid
    ? 'paid'
    : isOverdue
      ? 'overdue'
      : input.paidAmount.greaterThan(0)
        ? 'partial'
        : 'unpaid';

  return {
    businessDate: today,
    status,
    isOverdue,
    paidAmount: nonNegative(input.paidAmount).toFixed(2),
    remainingAmount: invoiceRemaining?.toFixed(2) ?? null,
    overdueAmount: overdueAmount.toFixed(2),
    schedules,
  };
}
