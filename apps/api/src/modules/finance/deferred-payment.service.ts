import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  PaymentPolicyInput,
  PaymentPolicyStageInput,
  PaymentStageTrigger,
  PaymentTermType,
} from '@plenka/contracts';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  addCalendarDays,
  allocatePaymentPolicy,
  type CalculatedPaymentStage,
  paymentPolicyFromLegacyType,
  validatePaymentPolicy,
} from './deferred-payment.calculator';
import type { UpdatePaymentPolicyDto } from './dto/payment-policy.dto';
import type { SetPaymentTermsDto } from './dto/payment-terms.dto';
import { lockFinanceOrderAggregate } from './finance-aggregate-lock';
import { moscowBusinessDate } from './finance-business-projection';
import type { FinanceActor } from './finance.service';
import { captureProductionClearance } from './payment-production-gate';

export const ACTIVE_PAYMENT_SCHEDULE_KINDS = ['invoice_prepayment', 'post_delivery'] as const;

type ActivePaymentScheduleKind = (typeof ACTIVE_PAYMENT_SCHEDULE_KINDS)[number];
type FinanceTransaction = Prisma.TransactionClient;
type PolicyStageSnapshot = {
  sequence: number;
  trigger: string;
  percentageBasisPoints: number;
  offsetDays: number;
  label?: string | null;
};
type PaymentPolicySnapshot = {
  id: string;
  installmentDays: number;
  capturedProductionLeadDays: number;
  invoiceExternalId?: string | null;
  invoiceSourceVersion?: string | null;
  capturedInvoiceAmount?: Prisma.Decimal | number | null;
  capturedInvoiceCurrency?: string | null;
  revision: number;
  stages: PolicyStageSnapshot[];
};
type LegacyTermsRetry = { observedRevision: number };

const CAPTURED_PRODUCTION_LEAD_DAYS = 2;

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateKey(value: Date): string {
  return moscowBusinessDate(value);
}

function isActiveKind(value: string): value is ActivePaymentScheduleKind {
  return ACTIVE_PAYMENT_SCHEDULE_KINDS.includes(value as ActivePaymentScheduleKind);
}

function canonicalStage(stage: PolicyStageSnapshot): PaymentPolicyStageInput {
  const canonical: PaymentPolicyStageInput = {
    sequence: stage.sequence,
    trigger: stage.trigger as PaymentStageTrigger,
    percentageBasisPoints: stage.percentageBasisPoints,
    offsetDays: stage.offsetDays,
  };
  return stage.label == null ? canonical : { ...canonical, label: stage.label };
}

function canonicalPolicy(policy: {
  installmentDays: number;
  stages: PolicyStageSnapshot[];
}): PaymentPolicyInput {
  return {
    installmentDays: policy.installmentDays,
    stages: [...policy.stages]
      .sort((left, right) => left.sequence - right.sequence)
      .map(canonicalStage),
  };
}

function policiesEqual(
  left: { installmentDays: number; stages: PolicyStageSnapshot[] },
  right: PaymentPolicyInput,
): boolean {
  const leftPolicy = canonicalPolicy(left);
  const rightPolicy = canonicalPolicy(right);
  return (
    leftPolicy.installmentDays === rightPolicy.installmentDays &&
    leftPolicy.stages.length === rightPolicy.stages.length &&
    leftPolicy.stages.every((stage, index) => {
      const candidate = rightPolicy.stages[index];
      return (
        stage.sequence === candidate.sequence &&
        stage.trigger === candidate.trigger &&
        stage.percentageBasisPoints === candidate.percentageBasisPoints &&
        stage.offsetDays === candidate.offsetDays &&
        (stage.label ?? null) === (candidate.label ?? null)
      );
    })
  );
}

function compatibilityLabel(policy: PaymentPolicyInput): PaymentTermType | null {
  const canonical = canonicalPolicy(policy);
  if (policiesEqual(canonical, paymentPolicyFromLegacyType('prepay_50_postpay_50_30d'))) {
    return 'prepay_50_postpay_50_30d';
  }
  if (policiesEqual(canonical, paymentPolicyFromLegacyType('postpay_100_30d'))) {
    return 'postpay_100_30d';
  }
  return null;
}

function policyValidationError(error: unknown): never {
  if (error instanceof Error) {
    throw new BadRequestException({ code: 'PAYMENT_POLICY_INVALID', message: error.message });
  }
  throw error;
}

function assertValidPolicy(policy: PaymentPolicyInput): void {
  try {
    validatePaymentPolicy(policy);
  } catch (error) {
    policyValidationError(error);
  }
}

function allocatePolicy(amount: number, policy: PaymentPolicyInput): CalculatedPaymentStage[] {
  try {
    validatePaymentPolicy(policy);
    return allocatePaymentPolicy(amount, policy);
  } catch (error) {
    policyValidationError(error);
  }
}

@Injectable()
export class DeferredPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** @deprecated Use setPolicy with the canonical payment policy contract. */
  async setTerms(actor: FinanceActor, orderId: string, dto: SetPaymentTermsDto): Promise<void> {
    const currentPolicy = await this.prisma.paymentPolicy.findUnique({
      where: { financeOrderId: orderId },
      select: { revision: true },
    });
    const observedRevision = currentPolicy?.revision ?? 0;
    await this.setPolicy(
      actor,
      orderId,
      {
        expectedRevision: observedRevision,
        reason: dto.reason,
        paymentPolicy: paymentPolicyFromLegacyType(dto.paymentTermsType),
      },
      { observedRevision },
    );
  }

  async setPolicy(
    actor: FinanceActor,
    orderId: string,
    dto: UpdatePaymentPolicyDto,
    legacyRetry?: LegacyTermsRetry,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockFinanceOrderAggregate(tx, orderId);
      const order = await tx.financeOrder.findUnique({
        where: { id: orderId },
        include: {
          policy: { include: { stages: { orderBy: { sequence: 'asc' } } } },
          schedules: {
            where: { kind: { in: [...ACTIVE_PAYMENT_SCHEDULE_KINDS] } },
          },
          commercialOrder: {
            select: { shipmentCompletedAt: true },
          },
        },
      });
      if (!order) throw new NotFoundException(`Finance order ${orderId} not found`);
      if (
        order.invoiceStatus !== 'invoiced' ||
        !order.invoiceIssuedAt ||
        order.amountValue === null ||
        Number(order.amountValue) <= 0
      ) {
        throw new ConflictException({
          code: 'DEFERRED_PAYMENT_INVOICE_REQUIRED',
          message: 'Сначала выставьте счет с положительной суммой.',
        });
      }
      const currentRevision = order.policy?.revision ?? 0;
      if (legacyRetry && legacyRetry.observedRevision !== currentRevision) {
        if (order.policy && policiesEqual(order.policy, dto.paymentPolicy)) return;
        if (order.schedules.some((schedule) => schedule.status !== 'unpaid')) {
          throw new ConflictException({
            code: 'DEFERRED_PAYMENT_ALREADY_STARTED',
            message: 'Нельзя изменить условия после подтверждения платежа.',
          });
        }
        throw new ConflictException({
          code: 'DEFERRED_PAYMENT_TERMS_RETRY_CONFLICT',
          message: 'Условия оплаты уже изменены другим запросом. Обновите заявку.',
        });
      }
      if (dto.expectedRevision !== currentRevision) {
        throw new ConflictException({
          code: 'PAYMENT_POLICY_REVISION_CONFLICT',
          message: 'Политика оплаты уже изменена другим запросом. Обновите заявку.',
        });
      }

      assertValidPolicy(dto.paymentPolicy);
      if (order.policy && policiesEqual(order.policy, dto.paymentPolicy)) return;

      if (order.schedules.some((schedule) => schedule.status !== 'unpaid')) {
        throw new ConflictException({
          code: 'DEFERRED_PAYMENT_ALREADY_STARTED',
          message: 'Нельзя изменить условия после подтверждения платежа.',
        });
      }
      const reason = dto.reason?.trim();
      if (order.policy && !reason) {
        throw new BadRequestException({
          code: 'DEFERRED_PAYMENT_REASON_REQUIRED',
          message: 'Для изменения условий оплаты укажите причину.',
        });
      }

      await this.replacePolicy(tx, {
        actor,
        orderId,
        amountValue: Number(order.amountValue),
        invoiceIssuedAt: order.invoiceIssuedAt,
        shipmentCompletedAt: order.commercialOrder.shipmentCompletedAt,
        previousPolicy: order.policy,
        paymentPolicy: dto.paymentPolicy,
        invoiceExternalId: order.externalId,
        invoiceSourceVersion: order.sourceVersion,
        invoiceCurrency: order.invoiceCurrency,
        reason,
      });
    });
  }

  async replacePolicy(
    tx: FinanceTransaction,
    input: {
      actor: FinanceActor;
      orderId: string;
      amountValue: number;
      invoiceIssuedAt: Date;
      shipmentCompletedAt: Date | null;
      previousPolicy: PaymentPolicySnapshot | null;
      paymentPolicy: PaymentPolicyInput;
      invoiceExternalId?: string | null;
      invoiceSourceVersion?: string | null;
      invoiceCurrency?: string | null;
      reason?: string;
    },
  ): Promise<void> {
    const paymentPolicy = canonicalPolicy(input.paymentPolicy);
    const rows = allocatePolicy(input.amountValue, paymentPolicy);
    await tx.paymentSchedule.deleteMany({
      where: {
        financeOrderId: input.orderId,
        kind: { in: [...ACTIVE_PAYMENT_SCHEDULE_KINDS] },
      },
    });
    if (input.previousPolicy) {
      await tx.paymentPolicyStage.deleteMany({
        where: { paymentPolicyId: input.previousPolicy.id },
      });
    }
    const persistedPolicy = await tx.paymentPolicy.upsert({
      where: { financeOrderId: input.orderId },
      create: {
        financeOrderId: input.orderId,
        installmentDays: paymentPolicy.installmentDays,
        capturedProductionLeadDays: CAPTURED_PRODUCTION_LEAD_DAYS,
        invoiceExternalId: input.invoiceExternalId,
        invoiceSourceVersion: input.invoiceSourceVersion,
        capturedInvoiceAmount: input.amountValue,
        capturedInvoiceCurrency: input.invoiceCurrency,
        revision: 1,
      },
      update: {
        installmentDays: paymentPolicy.installmentDays,
        capturedProductionLeadDays: CAPTURED_PRODUCTION_LEAD_DAYS,
        invoiceExternalId: input.invoiceExternalId,
        invoiceSourceVersion: input.invoiceSourceVersion,
        capturedInvoiceAmount: input.amountValue,
        capturedInvoiceCurrency: input.invoiceCurrency,
        revision: { increment: 1 },
      },
      select: {
        id: true,
        installmentDays: true,
        capturedProductionLeadDays: true,
        revision: true,
      },
    });
    const stageIds = rows.map(() => randomUUID());
    await tx.paymentPolicyStage.createMany({
      data: rows.map((row, index) => ({
        id: stageIds[index],
        paymentPolicyId: persistedPolicy.id,
        sequence: row.sequence,
        trigger: row.trigger,
        percentageBasisPoints: row.percentageBasisPoints,
        offsetDays: row.offsetDays,
        label: row.label ?? null,
      })),
    });
    const schedules = rows.map((row, index) =>
      this.scheduleData(
        input.orderId,
        stageIds[index],
        row,
        input.invoiceIssuedAt,
        input.shipmentCompletedAt,
      ),
    );
    await tx.paymentSchedule.createMany({
      data: schedules,
    });
    await tx.financeOrder.update({
      where: { id: input.orderId },
      data: { paymentTermsType: compatibilityLabel(paymentPolicy) },
    });
    const paymentAuditRows = rows.map((row, index) => ({
      sequence: row.sequence,
      trigger: row.trigger,
      percentageBasisPoints: row.percentageBasisPoints,
      offsetDays: row.offsetDays,
      amount: row.amount,
      kind: schedules[index].kind,
      paymentPolicyStageId: stageIds[index],
      startsAt:
        row.trigger === 'invoice_issued'
          ? input.invoiceIssuedAt.toISOString()
          : (input.shipmentCompletedAt?.toISOString() ?? null),
      dueDate: schedules[index].dueDate
        ? dateKey(
            schedules[index].dueDate instanceof Date
              ? schedules[index].dueDate
              : new Date(schedules[index].dueDate),
          )
        : null,
    }));
    const previousCanonical = input.previousPolicy
      ? {
          id: input.previousPolicy.id,
          revision: input.previousPolicy.revision,
          capturedProductionLeadDays: input.previousPolicy.capturedProductionLeadDays,
          invoiceExternalId: input.previousPolicy.invoiceExternalId ?? null,
          invoiceSourceVersion: input.previousPolicy.invoiceSourceVersion ?? null,
          capturedInvoiceAmount:
            input.previousPolicy.capturedInvoiceAmount == null
              ? null
              : Number(input.previousPolicy.capturedInvoiceAmount).toFixed(2),
          capturedInvoiceCurrency: input.previousPolicy.capturedInvoiceCurrency ?? null,
          ...canonicalPolicy(input.previousPolicy),
        }
      : null;
    await this.audit.record(
      {
        type: input.previousPolicy
          ? 'audit:payment_policy_updated'
          : 'audit:payment_policy_created',
        actorRole: input.actor.role,
        actorId: input.actor.userId,
        objectId: input.orderId,
        oldValue: { paymentPolicy: previousCanonical } as Prisma.InputJsonValue,
        newValue: {
          paymentPolicy: {
            id: persistedPolicy.id,
            revision: persistedPolicy.revision,
            capturedProductionLeadDays: persistedPolicy.capturedProductionLeadDays,
            invoiceExternalId: input.invoiceExternalId ?? null,
            invoiceSourceVersion: input.invoiceSourceVersion ?? null,
            capturedInvoiceAmount: input.amountValue.toFixed(2),
            capturedInvoiceCurrency: input.invoiceCurrency ?? null,
            ...paymentPolicy,
          },
          payments: paymentAuditRows,
        } as Prisma.InputJsonValue,
        reason: input.reason,
      },
      tx,
    );
    await captureProductionClearance(
      tx,
      this.audit,
      input.actor,
      input.orderId,
      input.reason ?? 'Payment policy now allows production.',
    );
  }

  async confirmSchedule(
    actor: FinanceActor,
    orderId: string,
    scheduleId: string,
    requestedOperationKey?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockFinanceOrderAggregate(tx, orderId);
      const order = await tx.financeOrder.findUnique({
        where: { id: orderId },
        include: {
          schedules: true,
          commercialOrder: { select: { orderNumber: true } },
        },
      });
      if (!order) throw new NotFoundException(`Finance order ${orderId} not found`);
      const activeSchedules = order.schedules.filter((schedule) => isActiveKind(schedule.kind));
      const schedule = activeSchedules.find((item) => item.id === scheduleId);
      if (!schedule) throw new NotFoundException(`Payment schedule ${scheduleId} not found`);
      if (schedule.status === 'paid') return;
      if (!schedule.dueDate) {
        throw new ConflictException({
          code: 'DEFERRED_PAYMENT_WAITING_DELIVERY',
          message: 'Дата платежа появится после полной выдачи заказа.',
        });
      }
      const resultingStatus = activeSchedules.every(
        (item) => item.id === schedule.id || item.status === 'paid',
      )
        ? 'paid'
        : 'partial';
      const confirmedAt = new Date();
      const claimed = await tx.paymentSchedule.updateMany({
        where: {
          id: schedule.id,
          financeOrderId: order.id,
          status: schedule.status,
          dueDate: schedule.dueDate,
        },
        data: { status: 'paid' },
      });
      if (claimed.count !== 1) {
        const winner = await tx.paymentSchedule.findUnique({ where: { id: schedule.id } });
        if (!winner) throw new NotFoundException(`Payment schedule ${scheduleId} not found`);
        if (winner.status === 'paid') return;
        throw new ConflictException({
          code: 'DEFERRED_PAYMENT_SCHEDULE_RETRY_CONFLICT',
          message: 'Состояние платежа уже изменено другим запросом. Обновите заявку.',
        });
      }
      await tx.paymentOperation.create({
        data: {
          financeOrderId: order.id,
          paymentScheduleId: schedule.id,
          operationKey: requestedOperationKey?.toLowerCase() ?? randomUUID(),
          operationType: 'invoice',
          amount: schedule.amount,
          source: 'manual_platform',
          createdByRole: actor.role,
          reconciled: true,
        },
      });
      await tx.financeOrder.update({
        where: { id: order.id },
        data: { paymentStatus: resultingStatus },
      });
      await tx.commercialOrder.update({
        where: { id: order.commercialOrderId },
        data: {
          paymentStatus: resultingStatus,
          commercialStage: 'in_work',
          financeConfirmedAt: confirmedAt,
          commercialLockedAt: confirmedAt,
        },
      });
      await this.audit.record(
        {
          type: 'audit:payment_schedule_item_confirmed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: order.id,
          oldValue: { scheduleId: schedule.id, status: schedule.status },
          newValue: {
            scheduleId: schedule.id,
            status: 'paid',
            amount: schedule.amount,
            paymentStatus: resultingStatus,
          },
          detail: {
            commercialOrderId: order.commercialOrderId,
            financeOrderId: order.id,
            orderNumber: order.commercialOrder.orderNumber,
            scheduleId: schedule.id,
          },
        },
        tx,
      );
      await captureProductionClearance(
        tx,
        this.audit,
        actor,
        order.id,
        'Confirmed payment schedule now allows production.',
      );
    });
  }

  async activatePostDeliveryPayments(
    input: {
      actor: FinanceActor;
      orderIds?: string[];
      orderNumbers: string[];
      shipmentCompletedAt: Date;
      warehouseTaskId: string;
    },
    externalTx?: FinanceTransaction,
  ): Promise<void> {
    const orderIds = [...new Set((input.orderIds ?? []).filter(Boolean))];
    const orderNumbers = [...new Set(input.orderNumbers.filter(Boolean))];
    if (orderIds.length === 0 && orderNumbers.length === 0) return;

    const activate = async (tx: FinanceTransaction) => {
      const orderFilters: Prisma.CommercialOrderWhereInput[] = [];
      if (orderIds.length > 0) orderFilters.push({ id: { in: orderIds } });
      if (orderNumbers.length > 0) orderFilters.push({ orderNumber: { in: orderNumbers } });
      const orders = await tx.commercialOrder.findMany({
        where: {
          shipmentCompletedAt: null,
          OR: orderFilters,
        },
        select: {
          id: true,
          orderNumber: true,
          financeOrder: {
            select: { id: true },
          },
        },
      });
      const orderedOrders = [...orders].sort((left, right) => {
        const leftKey = left.financeOrder?.id ?? left.id;
        const rightKey = right.financeOrder?.id ?? right.id;
        return leftKey.localeCompare(rightKey);
      });

      for (const order of orderedOrders) {
        if (order.financeOrder) {
          await lockFinanceOrderAggregate(tx, order.financeOrder.id);
        }
      }

      for (const order of orderedOrders) {
        const shipmentClaimed = await tx.commercialOrder.updateMany({
          where: { id: order.id, shipmentCompletedAt: null },
          data: {
            shipmentStatus: 'shipped',
            shipmentCompletedAt: input.shipmentCompletedAt,
          },
        });
        if (shipmentClaimed.count !== 1) continue;
        const financeOrder = order.financeOrder;
        if (!financeOrder) continue;

        const schedules = await tx.paymentSchedule.findMany({
          where: {
            financeOrderId: financeOrder.id,
            kind: 'post_delivery',
            dueDate: null,
            status: 'unpaid',
          },
          select: { id: true, offsetDays: true },
        });
        const claimedPayments: Array<{
          scheduleId: string;
          offsetDays: number;
          dueDate: string;
        }> = [];
        for (const schedule of [...schedules].sort((left, right) =>
          left.id.localeCompare(right.id),
        )) {
          const offsetDays = schedule.offsetDays ?? 30;
          const dueDateKey = addCalendarDays(dateKey(input.shipmentCompletedAt), offsetDays);
          const claimed = await tx.paymentSchedule.updateMany({
            where: {
              id: schedule.id,
              financeOrderId: financeOrder.id,
              kind: 'post_delivery',
              dueDate: null,
              status: 'unpaid',
            },
            data: {
              startsAt: input.shipmentCompletedAt,
              dueDate: dateOnly(dueDateKey),
            },
          });
          if (claimed.count === 1) {
            claimedPayments.push({
              scheduleId: schedule.id,
              offsetDays,
              dueDate: dueDateKey,
            });
          }
        }
        if (claimedPayments.length === 0) continue;
        await this.audit.record(
          {
            type: 'audit:deferred_payment_due_scheduled',
            actorRole: input.actor.role,
            actorId: input.actor.userId,
            objectId: financeOrder.id,
            newValue: {
              orderNumber: order.orderNumber,
              shipmentCompletedAt: input.shipmentCompletedAt.toISOString(),
              paymentCount: claimedPayments.length,
              payments: claimedPayments,
            },
            detail: {
              commercialOrderId: order.id,
              financeOrderId: financeOrder.id,
              orderNumber: order.orderNumber,
              warehouseTaskId: input.warehouseTaskId,
            },
          },
          tx,
        );
      }
    };

    if (externalTx) {
      await activate(externalTx);
      return;
    }
    await this.prisma.$transaction(activate);
  }

  private scheduleData(
    orderId: string,
    stageId: string,
    row: CalculatedPaymentStage,
    invoiceIssuedAt: Date,
    shipmentCompletedAt: Date | null,
  ): Prisma.PaymentScheduleCreateManyInput {
    const shipmentDate = shipmentCompletedAt ? dateKey(shipmentCompletedAt) : null;
    const dueDateKey =
      row.trigger === 'invoice_issued'
        ? dateKey(invoiceIssuedAt)
        : shipmentDate
          ? addCalendarDays(shipmentDate, row.offsetDays)
          : null;
    return {
      financeOrderId: orderId,
      paymentPolicyStageId: stageId,
      percentageBasisPoints: row.percentageBasisPoints,
      offsetDays: row.offsetDays,
      kind: row.trigger === 'invoice_issued' ? 'invoice_prepayment' : 'post_delivery',
      startsAt: row.trigger === 'invoice_issued' ? invoiceIssuedAt : shipmentCompletedAt,
      dueDate: dueDateKey ? dateOnly(dueDateKey) : null,
      amount: row.amount,
      status: 'unpaid',
      source: 'payment_policy',
    };
  }
}
