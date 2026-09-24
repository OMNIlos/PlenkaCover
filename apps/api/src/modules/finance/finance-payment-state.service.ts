import { Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENT_UPDATE_STATUSES, type PaymentUpdateStatus } from '@plenka/contracts';
import { Prisma } from '@prisma/client';

type PaymentStateInput = {
  invoiceAmount: Prisma.Decimal | null;
  schedules: Array<{ status: string }>;
  reconciledAmounts: Prisma.Decimal[];
  paymentUpdates: Array<{
    id: string;
    requestedStatus: string | null;
    createdAt: Date;
  }>;
  correctedPaymentUpdateIds: ReadonlySet<string>;
  fallbackStatus: PaymentUpdateStatus;
};

export type RecomputedPaymentState = {
  paymentStatus: PaymentUpdateStatus;
  productionClearedAt: Date | null;
};

function paymentStatus(value: string | null): PaymentUpdateStatus | null {
  return value && PAYMENT_UPDATE_STATUSES.includes(value as PaymentUpdateStatus)
    ? (value as PaymentUpdateStatus)
    : null;
}

export function deriveCorrectedPaymentStatus(input: PaymentStateInput): PaymentUpdateStatus {
  const reconciledAmount = input.reconciledAmounts.reduce(
    (total, amount) => total.plus(amount),
    new Prisma.Decimal(0),
  );
  if (reconciledAmount.gt(0)) {
    return input.invoiceAmount &&
      input.invoiceAmount.gt(0) &&
      reconciledAmount.gte(input.invoiceAmount)
      ? 'paid'
      : 'partial';
  }

  const activeSchedules = input.schedules.filter(({ status }) => status !== 'cancelled');
  if (activeSchedules.length > 0 && activeSchedules.every(({ status }) => status === 'paid')) {
    return 'paid';
  }
  if (activeSchedules.some(({ status }) => status === 'paid')) return 'partial';
  if (activeSchedules.some(({ status }) => status === 'overdue')) return 'overdue';

  const latestUpdate = [...input.paymentUpdates]
    .filter((command) => !input.correctedPaymentUpdateIds.has(command.id))
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
    )
    .find((command) => paymentStatus(command.requestedStatus));
  return paymentStatus(latestUpdate?.requestedStatus ?? null) ?? input.fallbackStatus;
}

@Injectable()
export class FinancePaymentStateService {
  async recompute(
    tx: Prisma.TransactionClient,
    financeOrderId: string,
    fallbackStatus: PaymentUpdateStatus,
  ): Promise<RecomputedPaymentState> {
    const order = await tx.financeOrder.findUnique({
      where: { id: financeOrderId },
      select: {
        id: true,
        commercialOrderId: true,
        amountValue: true,
        productionClearedAt: true,
        schedules: {
          where: { kind: { in: ['invoice_prepayment', 'post_delivery'] } },
          select: { status: true },
        },
        operations: {
          where: { reconciled: true },
          select: { amount: true },
        },
        paymentUpdateCommands: {
          select: { id: true, requestedStatus: true, createdAt: true },
        },
        paymentCorrections: {
          where: { targetKind: 'payment_update' },
          select: { targetId: true },
        },
      },
    });
    if (!order) throw new NotFoundException(`Finance order ${financeOrderId} not found`);

    const nextStatus = deriveCorrectedPaymentStatus({
      invoiceAmount: order.amountValue,
      schedules: order.schedules,
      reconciledAmounts: order.operations.map(({ amount }) => amount),
      paymentUpdates: order.paymentUpdateCommands,
      correctedPaymentUpdateIds: new Set(order.paymentCorrections.map(({ targetId }) => targetId)),
      fallbackStatus,
    });
    await tx.financeOrder.update({
      where: { id: order.id },
      data: { paymentStatus: nextStatus },
    });
    await tx.commercialOrder.update({
      where: { id: order.commercialOrderId },
      data: { paymentStatus: nextStatus },
    });
    return {
      paymentStatus: nextStatus,
      productionClearedAt: order.productionClearedAt,
    };
  }
}
