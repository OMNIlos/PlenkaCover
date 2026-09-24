import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { oneCOrderReference } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PaymentAllocationResolveDto } from './dto/payment-allocation-resolve.dto';
import { lockFinanceOrderAggregate } from './finance-aggregate-lock';
import { captureProductionClearance } from './payment-production-gate';
import { financeAuditActor, type OneCFinanceActor } from './onec-finance-actor';

export interface PaymentMatchOrder {
  financeOrderId: string;
  invoiceExternalId: string | null;
  invoiceNumber: string | null;
  invoiceCurrency: string | null;
  orderReference: string;
  counterpartyExternalId: string | null;
}

export interface PaymentMatchReceipt {
  invoiceExternalId: string | null;
  invoiceNumberReference: string | null;
  orderReference: string | null;
  counterpartyExternalId: string | null;
  currency: string;
}

export type PaymentReceiptMatch =
  | { kind: 'invoice_ref' | 'order_marker'; financeOrderId: string }
  | {
      kind: 'invoice_number_proposal' | 'ambiguous' | 'unmatched';
      candidateFinanceOrderIds: string[];
    };

export interface PaymentScheduleBalance {
  scheduleId: string;
  remaining: string;
}

export interface PaymentAmountAllocation {
  scheduleId: string | null;
  amount: string;
}

function uniqueOrderIds(orders: PaymentMatchOrder[]): string[] {
  return [...new Set(orders.map((order) => order.financeOrderId))].sort();
}

function exactResult(
  kind: 'invoice_ref' | 'order_marker',
  candidates: PaymentMatchOrder[],
): PaymentReceiptMatch | null {
  if (candidates.length === 1) {
    return { kind, financeOrderId: candidates[0].financeOrderId };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', candidateFinanceOrderIds: uniqueOrderIds(candidates) };
  }
  return null;
}

/** Deterministic matching only: no fuzzy text, dates, amounts or nearest-number heuristics. */
export function matchPaymentReceipt(
  receipt: PaymentMatchReceipt,
  orders: PaymentMatchOrder[],
): PaymentReceiptMatch {
  if (receipt.invoiceExternalId) {
    const byInvoice = exactResult(
      'invoice_ref',
      orders.filter((order) => order.invoiceExternalId === receipt.invoiceExternalId),
    );
    if (byInvoice) return byInvoice;
  }

  if (receipt.orderReference && receipt.counterpartyExternalId && receipt.currency) {
    const byMarker = exactResult(
      'order_marker',
      orders.filter(
        (order) =>
          order.orderReference === receipt.orderReference &&
          order.counterpartyExternalId === receipt.counterpartyExternalId &&
          order.invoiceCurrency === receipt.currency,
      ),
    );
    if (byMarker) return byMarker;
  }

  if (receipt.invoiceNumberReference) {
    const candidates = orders.filter(
      (order) =>
        order.invoiceNumber === receipt.invoiceNumberReference &&
        (!receipt.counterpartyExternalId ||
          order.counterpartyExternalId === receipt.counterpartyExternalId) &&
        order.invoiceCurrency === receipt.currency,
    );
    if (candidates.length > 0) {
      return {
        kind: 'invoice_number_proposal',
        candidateFinanceOrderIds: uniqueOrderIds(candidates),
      };
    }
  }

  return { kind: 'unmatched', candidateFinanceOrderIds: [] };
}

function cents(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`Invalid money value: ${value}`);
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const absolute = BigInt(match[2]) * 100n + BigInt(fraction || '0');
  return match[1] === '-' ? -absolute : absolute;
}

function money(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function allocatePaymentAmount(
  paymentAmount: string,
  schedules: PaymentScheduleBalance[],
): PaymentAmountAllocation[] {
  let remaining = cents(paymentAmount);
  if (remaining <= 0n) throw new Error('Payment amount must be positive.');

  const result: PaymentAmountAllocation[] = [];
  for (const schedule of schedules) {
    const balance = cents(schedule.remaining);
    if (balance <= 0n || remaining === 0n) continue;
    const allocated = balance < remaining ? balance : remaining;
    result.push({ scheduleId: schedule.scheduleId, amount: money(allocated) });
    remaining -= allocated;
  }
  if (remaining > 0n) result.push({ scheduleId: null, amount: money(remaining) });
  return result;
}

export function reversalAmount(amount: string): string {
  const value = cents(amount);
  if (value <= 0n) throw new Error('Only a positive allocation can be reversed.');
  return money(-value);
}

export type PaymentAllocationActor = OneCFinanceActor;

type PaymentTransaction = Prisma.TransactionClient;
export type PaymentReceiptWithAllocations = Prisma.PaymentReceiptGetPayload<{
  include: { allocations: true };
}>;

interface ApplyReceiptInput {
  amount: string;
  commandId?: string;
  financeOrderId: string;
  matchKind: 'invoice_ref' | 'order_marker' | 'manual';
  reason?: string;
}

function decimal(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function paymentState(paid: Prisma.Decimal, invoiceAmount: Prisma.Decimal): string {
  if (paid.lte(0)) return 'unpaid';
  if (paid.lt(invoiceAmount)) return 'partial';
  return 'paid';
}

@Injectable()
export class PaymentAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async reconciliation() {
    const receipts = await this.prisma.paymentReceipt.findMany({
      include: {
        allocations: {
          select: {
            id: true,
            financeOrderId: true,
            scheduleId: true,
            amount: true,
            status: true,
            matchKind: true,
            reversesId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return receipts
      .map((receipt) => {
        const allocated = receipt.allocations.reduce(
          (total, allocation) => total.plus(allocation.amount),
          new Prisma.Decimal(0),
        );
        return {
          id: receipt.id,
          externalId: receipt.externalId,
          sourceVersion: receipt.sourceVersion,
          number: receipt.number,
          receivedAt: receipt.receivedAt?.toISOString() ?? null,
          amount: receipt.amount.toFixed(2),
          allocatedAmount: allocated.toFixed(2),
          remainingAmount: Prisma.Decimal.max(receipt.amount.minus(allocated), 0).toFixed(2),
          currency: receipt.currency,
          counterpartyExternalId: receipt.counterpartyExternalId,
          invoiceExternalId: receipt.invoiceExternalId,
          invoiceNumberReference: receipt.invoiceNumberReference,
          orderReference: receipt.orderReference,
          posted: receipt.posted,
          deleted: receipt.deleted,
          sourceStatus: receipt.sourceStatus,
          matchState: receipt.matchState,
          matchKind: receipt.matchKind,
          candidateFinanceOrderIds: Array.isArray(receipt.candidateFinanceOrderIds)
            ? receipt.candidateFinanceOrderIds
            : [],
          capturedAt: receipt.capturedAt.toISOString(),
          allocations: receipt.allocations.map((allocation) => ({
            ...allocation,
            amount: allocation.amount.toFixed(2),
            createdAt: allocation.createdAt.toISOString(),
          })),
        };
      })
      .filter(
        (receipt) =>
          receipt.remainingAmount !== '0.00' ||
          receipt.sourceStatus !== 'fresh' ||
          receipt.matchState !== 'matched',
      );
  }

  async resolve(
    actor: PaymentAllocationActor,
    receiptId: string,
    dto: PaymentAllocationResolveDto,
  ) {
    const operationKey = dto.operationKey?.toLowerCase();
    const reason = dto.reason?.trim();
    if (!operationKey || !reason || reason.length < 4 || reason.length > 500) {
      throw new BadRequestException('A valid operation key and bounded reason are required.');
    }
    const targets = this.canonicalTargets(dto.allocations);
    const fingerprint = requestFingerprint({
      command: 'manual_payment_allocation',
      receiptId,
      reason,
      targets,
    });

    return this.prisma.$transaction(async (tx) => {
      await this.lockReceipt(tx, receiptId);
      const receipt = await tx.paymentReceipt.findUnique({
        where: { id: receiptId },
        include: { allocations: true },
      });
      if (!receipt) throw new NotFoundException(`Payment receipt ${receiptId} not found`);
      if (!receipt.posted || receipt.deleted) {
        throw new ConflictException({
          code: 'PAYMENT_RECEIPT_NOT_POSTED',
          message: 'Распределять можно только проведённое поступление 1С.',
        });
      }

      const claimed = await tx.financePaymentAllocationCommand.createMany({
        data: [
          {
            receiptId,
            operationKey,
            requestFingerprint: fingerprint,
            reason,
            actorRole: actor.role,
            actorId: actor.userId,
          },
        ],
        skipDuplicates: true,
      });
      const command = await tx.financePaymentAllocationCommand.findUnique({
        where: { operationKey },
      });
      if (
        !command ||
        command.receiptId !== receiptId ||
        command.requestFingerprint !== fingerprint
      ) {
        throw new ConflictException({
          code: 'PAYMENT_ALLOCATION_KEY_CONFLICT',
          message: 'Ключ операции уже использован для другого распределения.',
        });
      }
      if (claimed.count === 0) return command.result;

      const allocated = receipt.allocations.reduce(
        (total, allocation) => total.plus(allocation.amount),
        new Prisma.Decimal(0),
      );
      const available = receipt.amount.minus(allocated);
      const requested = targets.reduce(
        (total, target) => total.plus(target.amount),
        new Prisma.Decimal(0),
      );
      if (requested.gt(available)) {
        throw new ConflictException({
          code: 'PAYMENT_ALLOCATION_EXCEEDS_RECEIPT',
          message: 'Сумма распределения превышает нераспределённый остаток поступления.',
        });
      }

      const rows = [];
      for (const target of targets) {
        rows.push(
          ...(await this.applyToOrder(tx, actor, receipt, {
            amount: target.amount,
            commandId: command.id,
            financeOrderId: target.financeOrderId,
            matchKind: 'manual',
            reason,
          })),
        );
      }
      const result = {
        receiptId,
        allocatedAmount: requested.toFixed(2),
        allocations: rows,
      };
      await tx.financePaymentAllocationCommand.update({
        where: { id: command.id },
        data: { result: result as unknown as Prisma.InputJsonValue },
      });
      await tx.paymentReceipt.update({
        where: { id: receiptId },
        data: {
          matchState: 'matched',
          matchKind: 'manual',
          candidateFinanceOrderIds: targets.map(
            (target) => target.financeOrderId,
          ) as unknown as Prisma.InputJsonValue,
          lastMatchedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          ...financeAuditActor(actor),
          type: 'audit:payment_status_imported',
          objectId: receiptId,
          reason,
          detail: {
            operationKey,
            source: '1C',
            matchKind: 'manual',
            allocations: rows,
          },
        },
        tx,
      );
      return result;
    });
  }

  async matchOrders(
    client: Pick<PaymentTransaction, 'financeOrder'> = this.prisma,
  ): Promise<PaymentMatchOrder[]> {
    const orders = await client.financeOrder.findMany({
      where: { invoiceSyncState: 'posted', externalId: { not: null } },
      select: {
        id: true,
        externalId: true,
        invoiceNumber: true,
        invoiceCurrency: true,
        commercialOrder: {
          select: {
            orderNumber: true,
            counterparty: { select: { externalId: true } },
          },
        },
      },
    });
    return orders.map((order) => ({
      financeOrderId: order.id,
      invoiceExternalId: order.externalId,
      invoiceNumber: order.invoiceNumber,
      invoiceCurrency: order.invoiceCurrency,
      orderReference: oneCOrderReference(order.commercialOrder.orderNumber),
      counterpartyExternalId: order.commercialOrder.counterparty?.externalId ?? null,
    }));
  }

  async autoApply(
    tx: PaymentTransaction,
    actor: PaymentAllocationActor,
    receipt: PaymentReceiptWithAllocations,
    match: Extract<PaymentReceiptMatch, { financeOrderId: string }>,
  ) {
    const allocated = receipt.allocations.reduce(
      (total, allocation) => total.plus(allocation.amount),
      new Prisma.Decimal(0),
    );
    const available = receipt.amount.minus(allocated);
    if (available.lte(0)) return [];
    return this.applyToOrder(tx, actor, receipt, {
      amount: available.toFixed(2),
      financeOrderId: match.financeOrderId,
      matchKind: match.kind,
    });
  }

  async reverseReceipt(
    tx: PaymentTransaction,
    actor: PaymentAllocationActor,
    receipt: PaymentReceiptWithAllocations,
    reason: string,
  ) {
    const reversedIds = new Set(
      receipt.allocations
        .filter((allocation) => allocation.reversesId)
        .map((allocation) => allocation.reversesId),
    );
    const originals = receipt.allocations.filter(
      (allocation) => allocation.amount.gt(0) && !reversedIds.has(allocation.id),
    );
    const rows = [];
    for (const original of originals) {
      const allocationKey = requestFingerprint({
        command: 'reverse_payment_allocation',
        allocationId: original.id,
        receiptVersion: receipt.sourceVersion,
      });
      const negativeAmount = original.amount.negated();
      const reversal = await tx.financePaymentAllocation.create({
        data: {
          allocationKey,
          receiptId: receipt.id,
          financeOrderId: original.financeOrderId,
          scheduleId: original.scheduleId,
          amount: negativeAmount,
          status: 'reversal',
          matchKind: original.matchKind,
          reason,
          reversesId: original.id,
          createdByRole: actor.role,
          createdById: actor.userId,
        },
      });
      await tx.paymentOperation.create({
        data: {
          financeOrderId: original.financeOrderId,
          operationKey: allocationKey,
          operationType: 'invoice',
          amount: negativeAmount,
          source: '1C',
          createdByRole: actor.role,
          reconciled: true,
          sourceVersion: receipt.sourceVersion,
          paymentAllocationId: reversal.id,
          paymentScheduleId: original.scheduleId,
        },
      });
      rows.push({
        id: reversal.id,
        financeOrderId: original.financeOrderId,
        scheduleId: original.scheduleId,
        amount: negativeAmount.toFixed(2),
        reversesId: original.id,
      });
    }
    for (const financeOrderId of [
      ...new Set(originals.map((allocation) => allocation.financeOrderId)),
    ]) {
      await this.refreshOrderPaymentState(tx, financeOrderId, actor);
    }
    if (rows.length > 0) {
      await this.audit.record(
        {
          ...financeAuditActor(actor),
          type: 'audit:payment_status_imported',
          objectId: receipt.id,
          reason,
          oldValue: { sourceVersion: receipt.sourceVersion },
          newValue: { reversals: rows },
          detail: { source: '1C', action: 'compensating_reversal' },
        },
        tx,
      );
    }
    return rows;
  }

  private canonicalTargets(
    targets: PaymentAllocationResolveDto['allocations'],
  ): Array<{ financeOrderId: string; amount: string }> {
    const grouped = new Map<string, Prisma.Decimal>();
    for (const target of targets) {
      const financeOrderId = target.financeOrderId?.trim();
      const amount = decimal(target.amount);
      if (!financeOrderId || !amount.isPositive() || amount.decimalPlaces() > 2) {
        throw new BadRequestException('Every allocation requires an order and positive money.');
      }
      grouped.set(
        financeOrderId,
        (grouped.get(financeOrderId) ?? new Prisma.Decimal(0)).plus(amount),
      );
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([financeOrderId, amount]) => ({
        financeOrderId,
        amount: amount.toFixed(2),
      }));
  }

  private async applyToOrder(
    tx: PaymentTransaction,
    actor: PaymentAllocationActor,
    receipt: PaymentReceiptWithAllocations,
    input: ApplyReceiptInput,
  ) {
    await lockFinanceOrderAggregate(tx, input.financeOrderId);
    const order = await tx.financeOrder.findUnique({
      where: { id: input.financeOrderId },
      include: {
        schedules: {
          include: { allocations: true },
          where: { kind: { in: ['invoice_prepayment', 'post_delivery'] } },
        },
      },
    });
    if (!order) throw new NotFoundException(`Finance order ${input.financeOrderId} not found`);
    if (order.invoiceSyncState !== 'posted' || order.amountValue === null) {
      throw new ConflictException({
        code: 'PAYMENT_ALLOCATION_POSTED_INVOICE_REQUIRED',
        message: 'Поступление можно связать только с проведённым счётом 1С.',
      });
    }

    const schedules = [...order.schedules].sort((left, right) => {
      if (left.dueDate && right.dueDate) return left.dueDate.getTime() - right.dueDate.getTime();
      if (left.dueDate) return -1;
      if (right.dueDate) return 1;
      return left.createdAt.getTime() - right.createdAt.getTime();
    });
    const balances = schedules.map((schedule) => {
      const paid = schedule.allocations.reduce(
        (total, allocation) => total.plus(allocation.amount),
        new Prisma.Decimal(0),
      );
      return {
        scheduleId: schedule.id,
        remaining: Prisma.Decimal.max(schedule.amount.minus(paid), 0).toFixed(2),
      };
    });
    const calculated = allocatePaymentAmount(input.amount, balances);
    const rows = [];
    for (const [index, row] of calculated.entries()) {
      const allocationKey = requestFingerprint({
        command: 'apply_payment_allocation',
        receiptExternalId: receipt.externalId,
        receiptSourceVersion: receipt.sourceVersion,
        financeOrderId: input.financeOrderId,
        scheduleId: row.scheduleId,
        amount: row.amount,
        matchKind: input.matchKind,
        index,
      });
      const allocation = await tx.financePaymentAllocation.create({
        data: {
          allocationKey,
          receiptId: receipt.id,
          financeOrderId: input.financeOrderId,
          scheduleId: row.scheduleId,
          amount: row.amount,
          status: 'applied',
          matchKind: input.matchKind,
          reason: input.reason,
          commandId: input.commandId,
          createdByRole: actor.role,
          createdById: actor.userId,
        },
      });
      await tx.paymentOperation.create({
        data: {
          financeOrderId: input.financeOrderId,
          operationKey: allocationKey,
          operationType: 'invoice',
          amount: row.amount,
          source: '1C',
          createdByRole: actor.role,
          reconciled: true,
          sourceVersion: receipt.sourceVersion,
          paymentAllocationId: allocation.id,
          paymentScheduleId: row.scheduleId,
        },
      });
      rows.push({
        id: allocation.id,
        financeOrderId: input.financeOrderId,
        scheduleId: row.scheduleId,
        amount: row.amount,
        matchKind: input.matchKind,
      });
    }
    await this.refreshOrderPaymentState(tx, input.financeOrderId, actor);
    return rows;
  }

  private async refreshOrderPaymentState(
    tx: PaymentTransaction,
    financeOrderId: string,
    actor: PaymentAllocationActor,
  ) {
    const order = await tx.financeOrder.findUnique({
      where: { id: financeOrderId },
      include: {
        schedules: {
          include: { allocations: true },
          where: { kind: { in: ['invoice_prepayment', 'post_delivery'] } },
        },
        paymentAllocations: { select: { amount: true } },
      },
    });
    if (!order || order.amountValue === null) return;
    for (const schedule of order.schedules) {
      const paid = schedule.allocations.reduce(
        (total, allocation) => total.plus(allocation.amount),
        new Prisma.Decimal(0),
      );
      const status = paymentState(paid, schedule.amount);
      if (status !== schedule.status) {
        await tx.paymentSchedule.update({ where: { id: schedule.id }, data: { status } });
      }
    }
    const paid = order.paymentAllocations.reduce(
      (total, allocation) => total.plus(allocation.amount),
      new Prisma.Decimal(0),
    );
    const status = paymentState(paid, order.amountValue);
    await tx.financeOrder.update({
      where: { id: financeOrderId },
      data: { paymentStatus: status },
    });
    await tx.commercialOrder.update({
      where: { id: order.commercialOrderId },
      data: {
        paymentStatus: status,
        ...(paid.gt(0)
          ? {
              commercialStage: 'in_work',
              financeConfirmedAt: new Date(),
              commercialLockedAt: new Date(),
            }
          : {}),
      },
    });
    await captureProductionClearance(
      tx,
      this.audit,
      actor,
      financeOrderId,
      'Imported payment allocation now allows production.',
    );
  }

  private async lockReceipt(tx: PaymentTransaction, receiptId: string) {
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "finance_payment_receipts"
      WHERE "id" = ${receiptId}
      FOR UPDATE
    `);
  }
}
