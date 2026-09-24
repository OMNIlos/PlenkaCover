import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  FinanceWarehouseCoverageProjection,
  PaymentPolicyInput,
  PaymentScheduleDateKind,
  PaymentPolicyStageInput,
  PaymentStageTrigger,
  Role,
} from '@plenka/contracts';
import { capabilitiesForRole } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import type { RuntimeConfig } from '../../common/runtime-config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { lockInvoiceBoundaryForFinanceOrder } from '../../common/invoice-boundary/commercial-invoice-boundary';
import { projectCounterparty } from '../commercial/projection';
import { ONEC_ADAPTER, type OneCAdapter } from '../../integrations/onec/onec.adapter';
import type { CreateInvoiceDto } from './dto/invoice.dto';
import type { PreviewPaymentPolicyDto, UpdatePaymentPolicyDto } from './dto/payment-policy.dto';
import { MANUAL_PAYMENT_UPDATE_STATUSES, type PaymentUpdateDto } from './dto/payment-update.dto';
import {
  MAX_PAYMENT_OPERATION_AMOUNT,
  type PaymentOperationDto,
} from './dto/payment-operation.dto';
import type { FinanceProblemDto } from './dto/problem.dto';
import type { SetPaymentTermsDto } from './dto/payment-terms.dto';
import type { SourceRetryDto } from './dto/source-retry.dto';
import {
  isExactCalendarDate,
  isFinanceOrderBucket,
  type FinanceOrderBucket,
} from './dto/finance-query.dto';
import { ACTIVE_PAYMENT_SCHEDULE_KINDS, DeferredPaymentService } from './deferred-payment.service';
import {
  addCalendarDays,
  allocatePaymentPolicy,
  buildDeferredPaymentRows,
  paymentPolicyFromLegacyType,
  projectedScheduleDate,
  validatePaymentPolicy,
} from './deferred-payment.calculator';
import { lockFinanceOrderAggregate } from './finance-aggregate-lock';
import { WarehouseCoverageCalculationService } from '../warehouse-coverage/warehouse-coverage-calculation.service';
import { projectFinanceContextHistory } from './finance-context-history';
import {
  confirmedFinancePaidAmount,
  moscowBusinessDate,
  projectFinancePaymentState,
} from './finance-business-projection';
import { captureProductionClearance } from './payment-production-gate';

export interface FinanceActor {
  userId: string | null;
  role: Role;
}

type FinanceProjectionActor = Role | Actor;

function projectionActor(actor: FinanceProjectionActor): Actor {
  return typeof actor === 'string'
    ? {
        userId: null,
        role: actor,
        capabilities: [...capabilitiesForRole(actor)],
      }
    : actor;
}

const FINANCE_INVOICE_SNAPSHOT_SELECT = {
  id: true,
  externalId: true,
  sourceVersion: true,
  sourceKind: true,
  capturedAt: true,
  importedAt: true,
  checkedAt: true,
  staleness: true,
  parsed: true,
} as const;

const FINANCE_ORDER_PROJECTION_SELECT = {
  id: true,
  commercialOrderId: true,
  invoiceStatus: true,
  invoiceSyncState: true,
  invoiceNumber: true,
  invoiceCurrency: true,
  invoiceSourceCheckedAt: true,
  paymentStatus: true,
  amountValue: true,
  amountLabel: true,
  paymentTermsType: true,
  invoiceIssuedAt: true,
  sourceStatus: true,
  productionClearedAt: true,
  createdAt: true,
  updatedAt: true,
  externalId: true,
  sourceVersion: true,
  commercialOrder: {
    select: {
      id: true,
      orderNumber: true,
      creatorRole: true,
      counterpartyId: true,
      requestType: true,
      productionIndicator: true,
      warehouseCoverStatus: true,
      paymentStatus: true,
      shipmentStatus: true,
      shipmentCompletedAt: true,
      warehouseCoverageWorkflowVersion: true,
      createdAt: true,
      updatedAt: true,
      externalId: true,
      sourceVersion: true,
      commercialFinanceNote: true,
      comment: true,
      positions: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          rollCount: true,
          filmType: true,
          actualThickness: true,
          accountingThickness: true,
          spoolType: true,
          birka: true,
          plannedWeightKg: true,
          widthMm: true,
          plannedLengthM: true,
        },
      },
      counterparty: {
        select: {
          id: true,
          displayName: true,
          legalName: true,
          inn: true,
          billingSource: true,
          syncStatus: true,
        },
      },
    },
  },
  policy: {
    select: {
      id: true,
      installmentDays: true,
      capturedProductionLeadDays: true,
      invoiceExternalId: true,
      invoiceSourceVersion: true,
      capturedInvoiceAmount: true,
      capturedInvoiceCurrency: true,
      revision: true,
      stages: {
        select: {
          id: true,
          sequence: true,
          trigger: true,
          percentageBasisPoints: true,
          offsetDays: true,
          label: true,
        },
        orderBy: { sequence: 'asc' },
      },
    },
  },
  schedules: {
    where: { kind: { in: [...ACTIVE_PAYMENT_SCHEDULE_KINDS] } },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      paymentPolicyStageId: true,
      percentageBasisPoints: true,
      offsetDays: true,
      kind: true,
      startsAt: true,
      terms: true,
      dueDate: true,
      amount: true,
      status: true,
      source: true,
    },
  },
  operations: {
    select: {
      id: true,
      operationType: true,
      amount: true,
      source: true,
      createdAt: true,
      paymentAllocationId: true,
      paymentScheduleId: true,
      reversesOperationId: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  snapshots: {
    where: { subjectType: 'invoice' },
    orderBy: [{ checkedAt: 'desc' }, { createdAt: 'desc' }],
    take: 1,
    select: FINANCE_INVOICE_SNAPSHOT_SELECT,
  },
  paymentAllocations: {
    select: {
      id: true,
      amount: true,
      status: true,
      matchKind: true,
      scheduleId: true,
      reversesId: true,
      createdAt: true,
      receipt: {
        select: {
          id: true,
          externalId: true,
          number: true,
          receivedAt: true,
          amount: true,
          currency: true,
          sourceStatus: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
  paymentUpdateCommands: {
    select: {
      id: true,
      requestedStatus: true,
      previousStatus: true,
      amountPaid: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  paymentCorrections: {
    select: {
      id: true,
      targetKind: true,
      targetId: true,
      reason: true,
      actorRole: true,
      result: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.FinanceOrderSelect;

const INVOICE_LOCK_INCLUDE = {
  commercialOrder: { select: { orderNumber: true, shipmentCompletedAt: true } },
  policy: { include: { stages: { orderBy: { sequence: 'asc' } } } },
  schedules: {
    where: { kind: { in: [...ACTIVE_PAYMENT_SCHEDULE_KINDS] } },
  },
} satisfies Prisma.FinanceOrderInclude;

type FinanceOverviewBucket = Extract<
  FinanceOrderBucket,
  'actual' | 'actions' | 'problems' | 'completed'
>;
type FinanceOrderWithRelations = Prisma.FinanceOrderGetPayload<{
  select: typeof FINANCE_ORDER_PROJECTION_SELECT;
}>;
type FinancePaymentPolicy = NonNullable<FinanceOrderWithRelations['policy']>;
type FinancePaymentSchedule = FinanceOrderWithRelations['schedules'][number];
type FinancePaymentPolicyProjection = Pick<
  FinancePaymentPolicy,
  'id' | 'installmentDays' | 'capturedProductionLeadDays' | 'revision'
> & {
  invoiceExternalId: string | null;
  invoiceSourceVersion: string | null;
  capturedInvoiceAmount: string | null;
  capturedInvoiceCurrency: string | null;
  stages: Array<
    Pick<
      FinancePaymentPolicy['stages'][number],
      'id' | 'sequence' | 'trigger' | 'percentageBasisPoints' | 'offsetDays' | 'label'
    >
  >;
};
type FinancePaymentScheduleProjection = {
  id: string;
  kind: string;
  sequence: number | null;
  trigger: PaymentStageTrigger | null;
  percentageBasisPoints: number | null;
  offsetDays: number | null;
  startsAt: Date | null;
  amount: number;
  dueDate: string | null;
  dateKind: PaymentScheduleDateKind;
  status: string;
  source: string;
  paidAmount: string;
  remainingAmount: string;
  isOverdue: boolean;
};
type FinancePaymentOperationProjection = {
  id: string;
  operationType: string;
  amount: string;
  source: string;
  createdAt: Date;
  paymentAllocationId: string | null;
};
type FinanceOrderProjection = {
  id: string;
  commercialOrderId: string;
  invoiceStatus: string;
  invoiceSyncState: string;
  invoiceNumber: string | null;
  invoiceCurrency: string | null;
  invoiceSourceCheckedAt: Date | null;
  paymentStatus: string;
  amountValue: string | null;
  amountLabel: string | null;
  paymentTermsType: string | null;
  invoiceIssuedAt: Date | null;
  sourceStatus: string;
  productionClearedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  externalId: string | null;
  sourceVersion: string | null;
  commercialOrder: {
    id: string;
    orderNumber: string;
    creatorRole: Role;
    counterpartyId: string | null;
    requestType: string;
    productionIndicator: string;
    warehouseCoverStatus: string;
    paymentStatus: string;
    shipmentStatus: string;
    shipmentCompletedAt: Date | null;
    warehouseCoverageWorkflowVersion: number;
    createdAt: Date;
    updatedAt: Date;
    externalId: string | null;
    sourceVersion: string | null;
    commercialFinanceNote: string | null;
    comment: string | null;
    positions: Array<{
      id: string;
      rollCount: number;
      filmType: string;
      actualThickness: string;
      accountingThickness: string;
      spoolType: string | null;
      birka: string | null;
      plannedWeightKg: number | null;
      widthMm: number | null;
      plannedLengthM: number | null;
    }>;
    counterparty: ReturnType<typeof projectCounterparty>;
  };
  paymentPolicy: FinancePaymentPolicyProjection | null;
  schedules: FinancePaymentScheduleProjection[];
  operations: FinancePaymentOperationProjection[];
  invoice: Record<string, unknown> | null;
  paymentSummary: {
    invoiceAmount: string | null;
    paidAmount: string;
    remainingAmount: string | null;
    overpaidAmount: string;
  };
  paymentTimeline: Array<Record<string, unknown>>;
  businessPayment: ReturnType<typeof projectFinancePaymentState>;
  paymentCorrections: Array<{
    id: string;
    targetKind: string;
    reason: string;
    actorRole: string;
    resultingStatus: string | null;
    createdAt: string;
  }>;
  correctablePayments: CorrectablePaymentTarget[];
  coverage?: FinanceWarehouseCoverageProjection;
};
type CorrectablePaymentTarget = {
  target: {
    kind: 'payment_update' | 'schedule_confirmation' | 'payment_operation';
    id: string;
  };
  label: string;
  amount: string | null;
  source: 'manual_platform' | '1C';
  canCorrect: boolean;
  blockedReason: string | null;
};
type FinanceOverviewAction = { kind: string; label: string; dueDate: string | null };
type FinanceOverviewCase = FinanceOrderProjection & {
  bucket: FinanceOverviewBucket;
  action: FinanceOverviewAction;
  paidAmount: number | null;
  remainingAmount: number | null;
  hasInstallment: boolean;
};

/** Fields safe to expose for a source snapshot — rawPayload is admin-only (ТЗ §8). */
const SNAPSHOT_SAFE_SELECT = {
  id: true,
  financeOrderId: true,
  subjectType: true,
  subjectId: true,
  externalId: true,
  sourceVersion: true,
  sourceKind: true,
  ownerRole: true,
  capturedAt: true,
  importedAt: true,
  checkedAt: true,
  staleness: true,
  parsed: true,
  createdAt: true,
} as const;

type InvoiceRetryOrder = Prisma.FinanceOrderGetPayload<{ include: typeof INVOICE_LOCK_INCLUDE }>;
type ComparablePaymentStage = Pick<
  PaymentPolicyStageInput,
  'sequence' | 'percentageBasisPoints' | 'offsetDays'
> & {
  trigger: string;
  label?: string | null;
};

type PulledInvoice = Awaited<ReturnType<OneCAdapter['pullInvoice']>>;
type SourceRetryClaim =
  | { kind: 'replay' }
  | {
      kind: 'claimed';
      journalId: string;
      invoiceExternalId: string;
      activeScopeKey: string;
    };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ONEC_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCE_RETRY_LEASE_MARGIN_MS = 60_000;
const MAX_FINANCE_ORDER_ROWS = 2_000;
const MAX_FINANCE_PROJECTION_ROWS = 20_000;
const MAX_FINANCE_COVERAGE_PROJECTIONS = 100;
const MAX_FINANCE_PROJECTION_CONCURRENCY = 8;
const SOURCE_RETRY_FAILED_RESPONSE = {
  code: 'FINANCE_SOURCE_RETRY_FAILED',
  message: 'The source retry failed. Use a new operation key for another attempt.',
} as const;

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function moneyString(value: Prisma.Decimal | number | string | null | undefined): string | null {
  if (value == null) return null;
  try {
    return new Prisma.Decimal(value).toFixed(2);
  } catch {
    return null;
  }
}

function safeInvoiceProjection(order: FinanceOrderWithRelations): Record<string, unknown> | null {
  const snapshot = order.snapshots?.[0];
  const parsed = jsonRecord(snapshot?.parsed);
  if (!snapshot || !parsed) return null;
  return {
    externalId: snapshot.externalId,
    sourceVersion: snapshot.sourceVersion,
    sourceKind: snapshot.sourceKind,
    staleness: snapshot.staleness,
    capturedAt: snapshot.capturedAt?.toISOString() ?? null,
    importedAt: snapshot.importedAt?.toISOString() ?? null,
    checkedAt: snapshot.checkedAt?.toISOString() ?? null,
    invoiceNumber: typeof parsed.invoiceNo === 'string' ? parsed.invoiceNo : order.invoiceNumber,
    date: typeof parsed.date === 'string' ? parsed.date : null,
    currency: typeof parsed.currency === 'string' ? parsed.currency : order.invoiceCurrency,
    posted: parsed.posted === true,
    counterpartyExternalId:
      typeof parsed.counterpartyExternalId === 'string' ? parsed.counterpartyExternalId : null,
    organizationExternalId:
      typeof parsed.organizationExternalId === 'string' ? parsed.organizationExternalId : null,
  };
}

function sameAmount(left: number | Prisma.Decimal | null, right: number): boolean {
  return left !== null && Math.round(Number(left) * 100) === Math.round(right * 100);
}

function dateKey(value: Date): string {
  return moscowBusinessDate(value);
}

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  if (!left || !right) return left === right;
  return left.getTime() === right.getTime();
}

function retryScheduleMatches(
  order: InvoiceRetryOrder,
  current: InvoiceRetryOrder['schedules'][number],
  expected: PaymentPolicyStageInput & { amount: number },
  requireSnapshots: boolean,
): boolean {
  const expectedKind =
    expected.trigger === 'invoice_issued' ? 'invoice_prepayment' : 'post_delivery';
  if (
    current.kind !== expectedKind ||
    !sameAmount(current.amount, expected.amount) ||
    (requireSnapshots &&
      (current.percentageBasisPoints !== expected.percentageBasisPoints ||
        current.offsetDays !== expected.offsetDays)) ||
    (!requireSnapshots &&
      ((current.percentageBasisPoints != null &&
        current.percentageBasisPoints !== expected.percentageBasisPoints) ||
        (current.offsetDays != null && current.offsetDays !== expected.offsetDays)))
  ) {
    return false;
  }

  const shipmentCompletedAt = order.commercialOrder.shipmentCompletedAt;
  const expectedStartsAt =
    expected.trigger === 'invoice_issued' ? order.invoiceIssuedAt : shipmentCompletedAt;
  if (!sameTimestamp(current.startsAt, expectedStartsAt)) return false;

  const expectedDueDate =
    expected.trigger === 'invoice_issued'
      ? order.invoiceIssuedAt
        ? dateKey(order.invoiceIssuedAt)
        : null
      : shipmentCompletedAt
        ? addCalendarDays(dateKey(shipmentCompletedAt), expected.offsetDays)
        : null;
  return (current.dueDate ? dateKey(current.dueDate) : null) === expectedDueDate;
}

function canonicalStage(stage: ComparablePaymentStage): PaymentPolicyStageInput {
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
  stages: ComparablePaymentStage[];
}): PaymentPolicyInput {
  return {
    installmentDays: policy.installmentDays,
    stages: [...policy.stages]
      .sort((left, right) => left.sequence - right.sequence)
      .map(canonicalStage),
  };
}

function paymentPoliciesEqual(left: PaymentPolicyInput, right: PaymentPolicyInput): boolean {
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

function legacyPolicy(type: string | null): PaymentPolicyInput | null {
  if (type === 'prepay_50_postpay_50_30d' || type === 'postpay_100_30d') {
    return paymentPolicyFromLegacyType(type);
  }
  return null;
}

function currentInvoicePolicy(order: InvoiceRetryOrder): PaymentPolicyInput | null {
  return order.policy ? canonicalPolicy(order.policy) : legacyPolicy(order.paymentTermsType);
}

function invoicePolicyValidationError(error: unknown): never {
  if (error instanceof Error) {
    throw new BadRequestException({ code: 'PAYMENT_POLICY_INVALID', message: error.message });
  }
  throw error;
}

function validateInvoicePolicy(amount: number, paymentPolicy: PaymentPolicyInput): void {
  try {
    validatePaymentPolicy(paymentPolicy);
    allocatePaymentPolicy(amount, paymentPolicy);
  } catch (error) {
    invoicePolicyValidationError(error);
  }
}

function invoiceRetryIsCompatible(
  order: InvoiceRetryOrder,
  amount: number,
  paymentPolicy: PaymentPolicyInput,
): boolean {
  if (
    order.invoiceStatus !== 'invoiced' ||
    !sameAmount(order.amountValue, amount) ||
    !order.invoiceIssuedAt
  ) {
    return false;
  }
  const persistedPolicy = currentInvoicePolicy(order);
  if (!persistedPolicy || !paymentPoliciesEqual(persistedPolicy, paymentPolicy)) return false;

  let expectedRows: ReturnType<typeof allocatePaymentPolicy>;
  try {
    expectedRows = allocatePaymentPolicy(amount, paymentPolicy);
  } catch {
    return false;
  }
  const activeRows = order.schedules.filter((schedule) =>
    ACTIVE_PAYMENT_SCHEDULE_KINDS.includes(
      schedule.kind as (typeof ACTIVE_PAYMENT_SCHEDULE_KINDS)[number],
    ),
  );
  if (activeRows.length !== expectedRows.length) return false;

  const policyStages = order.policy?.stages ?? [];
  const canonicalSchedulesMatch = expectedRows.every((expected) => {
    const stage = policyStages.find((candidate) => candidate.sequence === expected.sequence);
    const expectedKind =
      expected.trigger === 'invoice_issued' ? 'invoice_prepayment' : 'post_delivery';
    const current = stage
      ? activeRows.find((schedule) => schedule.paymentPolicyStageId === stage.id)
      : activeRows.find(
          (schedule) =>
            schedule.kind === expectedKind &&
            (schedule.percentageBasisPoints == null ||
              schedule.percentageBasisPoints === expected.percentageBasisPoints) &&
            (schedule.offsetDays == null || schedule.offsetDays === expected.offsetDays),
        );
    return current ? retryScheduleMatches(order, current, expected, order.policy !== null) : false;
  });
  if (canonicalSchedulesMatch) return true;

  const legacyType =
    order.paymentTermsType === 'prepay_50_postpay_50_30d' ||
    order.paymentTermsType === 'postpay_100_30d'
      ? order.paymentTermsType
      : null;
  if (!legacyType) return false;
  const legacyTemplate = paymentPolicyFromLegacyType(legacyType);
  if (
    !paymentPoliciesEqual(persistedPolicy, legacyTemplate) ||
    !paymentPoliciesEqual(paymentPolicy, legacyTemplate)
  ) {
    return false;
  }
  const legacyRows = buildDeferredPaymentRows(amount, legacyType, dateKey(order.invoiceIssuedAt));
  if (legacyRows.length !== activeRows.length) return false;
  return legacyRows.every((expected, index) => {
    const expectedStage = legacyTemplate.stages[index];
    const stage = policyStages.find((candidate) => candidate.sequence === expectedStage.sequence);
    const current = stage
      ? activeRows.find((schedule) => schedule.paymentPolicyStageId === stage.id)
      : activeRows.find((schedule) => schedule.kind === expected.kind);
    return current
      ? retryScheduleMatches(
          order,
          current,
          { ...expectedStage, amount: expected.amount },
          stage !== undefined,
        )
      : false;
  });
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ONEC_ADAPTER) private readonly onec: OneCAdapter,
    private readonly deferredPayment: DeferredPaymentService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    private readonly coverageProjection: WarehouseCoverageCalculationService,
  ) {}

  async listOrders(actorInput: FinanceProjectionActor, bucket?: string) {
    const actor = projectionActor(actorInput);
    const where = this.whereForBucket(bucket);
    const orders = await this.loadProjectionOrders(bucket === 'overdue' ? {} : where);
    const projected = await this.mapProjection(orders, (order) => this.project(order, actor));
    return bucket === 'overdue'
      ? projected.filter((order) => order.businessPayment.isOverdue)
      : projected;
  }

  async getOverview(actorInput: FinanceProjectionActor, date?: string) {
    const actor = projectionActor(actorInput);
    if (date !== undefined && !isExactCalendarDate(date)) {
      throw new BadRequestException({
        code: 'INVALID_FINANCE_OVERVIEW_DATE',
        message: 'Date must be a real calendar date in YYYY-MM-DD format.',
      });
    }
    const selectedDate = date ?? moscowBusinessDate(new Date());
    const orders = await this.loadProjectionOrders({});
    const cases = await this.mapProjection(orders, (order) => this.projectCase(order, actor));

    const buckets = {
      actual: cases.filter((order) => order.bucket === 'actual'),
      actions: cases.filter((order) => order.bucket === 'actions'),
      problems: cases.filter((order) => order.bucket === 'problems'),
      completed: cases.filter((order) => order.bucket === 'completed'),
    };
    const agenda = cases.filter((order) =>
      this.openCalendarEntries(order).some((entry) => entry.date === selectedDate),
    );

    return {
      summary: {
        awaitingInvoice: buckets.actual.length,
        dueToday: agenda.length,
        overdue: buckets.problems.length,
        installment: cases.filter((order) => order.hasInstallment && order.paymentStatus !== 'paid')
          .length,
      },
      buckets,
      agenda,
      calendar: this.buildCalendar(cases),
    };
  }

  private assertSafeOrderCount(count: number): void {
    if (count <= MAX_FINANCE_ORDER_ROWS) return;
    throw new UnprocessableEntityException({
      code: 'FINANCE_ORDER_CATALOG_TOO_LARGE',
      message: 'Слишком много финансовых заказов для безопасной выдачи. Уточните рабочую выборку.',
    });
  }

  async getOrder(actorInput: FinanceProjectionActor, orderId: string) {
    const actor = projectionActor(actorInput);
    const order = await this.loadProjectionOrder(orderId);
    if (!order) throw new NotFoundException(`Finance order ${orderId} not found`);
    return this.project(order, actor);
  }

  private loadProjectionOrders(
    where: Prisma.FinanceOrderWhereInput,
  ): Promise<FinanceOrderWithRelations[]> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertSafeProjectionBudget(tx, where);
        const orders = await tx.financeOrder.findMany({
          where,
          select: FINANCE_ORDER_PROJECTION_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        this.assertLoadedProjectionBudget(orders);
        return orders;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private loadProjectionOrder(orderId: string): Promise<FinanceOrderWithRelations | null> {
    const where = { id: orderId } satisfies Prisma.FinanceOrderWhereInput;
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertSafeProjectionBudget(tx, where);
        const order = await tx.financeOrder.findUnique({
          where: { id: orderId },
          select: FINANCE_ORDER_PROJECTION_SELECT,
        });
        if (order) this.assertLoadedProjectionBudget([order]);
        return order;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async assertSafeProjectionBudget(
    tx: Prisma.TransactionClient,
    where: Prisma.FinanceOrderWhereInput,
  ): Promise<void> {
    const orderCount = await tx.financeOrder.count({ where });
    this.assertSafeOrderCount(orderCount);
    if (orderCount === 0) return;

    const [
      policyCount,
      policyStageCount,
      scheduleCount,
      operationCount,
      allocationCount,
      paymentUpdateCount,
      paymentCorrectionCount,
      positionCount,
      coverageCount,
    ] = await Promise.all([
      tx.paymentPolicy.count({ where: { financeOrder: where } }),
      tx.paymentPolicyStage.count({ where: { paymentPolicy: { financeOrder: where } } }),
      tx.paymentSchedule.count({
        where: { financeOrder: where, kind: { in: [...ACTIVE_PAYMENT_SCHEDULE_KINDS] } },
      }),
      tx.paymentOperation.count({ where: { financeOrder: where } }),
      tx.financePaymentAllocation.count({ where: { financeOrder: where } }),
      tx.financePaymentUpdateCommand.count({ where: { financeOrder: where } }),
      tx.financePaymentCorrectionCommand.count({ where: { financeOrder: where } }),
      tx.commercialOrderPosition.count({ where: { order: { financeOrder: where } } }),
      tx.financeOrder.count({
        where: {
          AND: [where, { commercialOrder: { warehouseCoverageWorkflowVersion: 2 } }],
        },
      }),
    ]);
    const projectionRows =
      orderCount +
      policyCount +
      policyStageCount +
      scheduleCount +
      operationCount +
      orderCount +
      allocationCount +
      paymentUpdateCount +
      paymentCorrectionCount +
      positionCount;
    if (projectionRows > MAX_FINANCE_PROJECTION_ROWS) {
      throw new UnprocessableEntityException({
        code: 'FINANCE_PROJECTION_TOO_LARGE',
        message: 'Финансовая выборка содержит слишком много вложенных фактов.',
      });
    }
    this.assertSafeCoverageCount(coverageCount);
  }

  private assertLoadedProjectionBudget(orders: FinanceOrderWithRelations[]): void {
    this.assertSafeOrderCount(orders.length);
    const projectionRows = orders.reduce(
      (count, order) =>
        count +
        1 +
        (order.policy ? 1 + order.policy.stages.length : 0) +
        order.schedules.length +
        order.operations.length +
        order.snapshots.length +
        order.paymentAllocations.length +
        order.paymentUpdateCommands.length +
        order.paymentCorrections.length +
        order.commercialOrder.positions.length,
      0,
    );
    if (projectionRows > MAX_FINANCE_PROJECTION_ROWS) {
      throw new UnprocessableEntityException({
        code: 'FINANCE_PROJECTION_TOO_LARGE',
        message: 'Финансовая выборка содержит слишком много вложенных фактов.',
      });
    }
    this.assertSafeCoverageCount(
      orders.filter(({ commercialOrder }) => commercialOrder.warehouseCoverageWorkflowVersion === 2)
        .length,
    );
  }

  private assertSafeCoverageCount(count: number): void {
    if (count <= MAX_FINANCE_COVERAGE_PROJECTIONS) return;
    throw new UnprocessableEntityException({
      code: 'FINANCE_COVERAGE_PROJECTION_TOO_LARGE',
      message: 'Слишком много V2-расчётов покрытия для одной финансовой выборки.',
    });
  }

  private async mapProjection<T>(
    orders: FinanceOrderWithRelations[],
    project: (order: FinanceOrderWithRelations) => Promise<T>,
  ): Promise<T[]> {
    const projected = new Array<T>(orders.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < orders.length) {
        const index = nextIndex;
        nextIndex += 1;
        projected[index] = await project(orders[index]);
      }
    };
    const workerCount = Math.min(MAX_FINANCE_PROJECTION_CONCURRENCY, orders.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return projected;
  }

  async previewPaymentPolicy(_actor: FinanceActor, orderId: string, dto: PreviewPaymentPolicyDto) {
    const order = await this.prisma.financeOrder.findUnique({
      where: { id: orderId },
      select: {
        amountValue: true,
        invoiceStatus: true,
        invoiceIssuedAt: true,
        commercialOrder: {
          select: {
            shipmentCompletedAt: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException(`Finance order ${orderId} not found`);
    const recordedAmount = order.amountValue === null ? null : Number(order.amountValue);
    const amount = order.invoiceStatus === 'invoiced' ? recordedAmount : (dto.amount ?? null);
    if (amount === null || amount <= 0) {
      throw new ConflictException({
        code: 'PAYMENT_POLICY_MANUAL_INVOICE_REQUIRED',
        message:
          order.invoiceStatus === 'invoiced'
            ? 'Расчёт доступен после ручного оформления суммы счёта.'
            : 'Укажите сумму счёта для предварительного расчёта.',
      });
    }

    let allocated: ReturnType<typeof allocatePaymentPolicy>;
    try {
      allocated = allocatePaymentPolicy(amount, dto.paymentPolicy);
    } catch (error) {
      if (error instanceof Error) throw new BadRequestException(error.message);
      throw error;
    }

    const invoiceDate = this.dateKey(order.invoiceIssuedAt);
    const shipmentDate = this.dateKey(order.commercialOrder.shipmentCompletedAt);

    return {
      rows: allocated.map((row) => {
        const projected = projectedScheduleDate({
          invoiceDate,
          shipmentDate,
          trigger: row.trigger,
          offsetDays: row.offsetDays,
        });
        return {
          sequence: row.sequence,
          trigger: row.trigger,
          percentageBasisPoints: row.percentageBasisPoints,
          offsetDays: row.offsetDays,
          amount: row.amount,
          date: projected.date,
          dateKind: projected.kind,
        };
      }),
    };
  }

  async createInvoice(actor: FinanceActor, orderId: string, dto: CreateInvoiceDto) {
    const hasNullPaymentInput = dto.paymentPolicy === null || dto.paymentTermsType === null;
    const hasPaymentPolicy = dto.paymentPolicy != null;
    const hasPaymentTermsType = dto.paymentTermsType != null;
    if (hasNullPaymentInput || hasPaymentPolicy === hasPaymentTermsType) {
      throw new BadRequestException({
        code: 'FINANCE_PAYMENT_INPUT_SELECTION_INVALID',
        message: 'Provide exactly one of paymentPolicy or paymentTermsType.',
      });
    }
    const paymentPolicy = canonicalPolicy(
      hasPaymentPolicy ? dto.paymentPolicy! : paymentPolicyFromLegacyType(dto.paymentTermsType!),
    );
    validateInvoicePolicy(dto.amount, paymentPolicy);

    await this.prisma.$transaction(async (tx) => {
      await lockInvoiceBoundaryForFinanceOrder(tx, orderId);
      const fo = await tx.financeOrder.findUnique({
        where: { id: orderId },
        include: INVOICE_LOCK_INCLUDE,
      });
      if (!fo) throw new NotFoundException(`Finance order ${orderId} not found`);
      if (fo.invoiceStatus === 'invoiced') {
        if (invoiceRetryIsCompatible(fo, dto.amount, paymentPolicy)) return;
        throw new ConflictException({
          code: 'FINANCE_INVOICE_RETRY_CONFLICT',
          message: 'Счёт уже зафиксирован с другими параметрами. Обновите заявку.',
        });
      }
      const invoiceIssuedAt = fo.invoiceIssuedAt ?? new Date();
      const claimed = await tx.financeOrder.updateMany({
        where: {
          id: orderId,
          invoiceStatus: fo.invoiceStatus,
          amountValue: fo.amountValue,
          amountLabel: fo.amountLabel,
          paymentTermsType: fo.paymentTermsType,
          invoiceIssuedAt: fo.invoiceIssuedAt,
        },
        data: {
          invoiceStatus: 'invoiced',
          amountValue: dto.amount,
          amountLabel: dto.label,
          invoiceIssuedAt,
        },
      });
      if (claimed.count !== 1) {
        const winner = await tx.financeOrder.findUnique({
          where: { id: orderId },
          include: INVOICE_LOCK_INCLUDE,
        });
        if (!winner) throw new NotFoundException(`Finance order ${orderId} not found`);
        if (invoiceRetryIsCompatible(winner, dto.amount, paymentPolicy)) return;
        throw new ConflictException({
          code: 'FINANCE_INVOICE_RETRY_CONFLICT',
          message: 'Счёт уже зафиксирован с другими параметрами. Обновите заявку.',
        });
      }
      await this.deferredPayment.replacePolicy(tx, {
        actor,
        orderId,
        amountValue: dto.amount,
        invoiceIssuedAt,
        shipmentCompletedAt: fo.commercialOrder.shipmentCompletedAt,
        previousPolicy: fo.policy,
        paymentPolicy,
      });
      await this.audit.record(
        {
          type: 'audit:invoice_status_updated',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          oldValue: { invoiceStatus: fo.invoiceStatus },
          newValue: {
            invoiceStatus: 'invoiced',
            amount: dto.amount,
            paymentPolicy,
          },
          detail: {
            commercialOrderId: fo.commercialOrderId,
            financeOrderId: fo.id,
            orderNumber: fo.commercialOrder.orderNumber,
          },
        },
        tx,
      );
    });
    return this.getOrder(actor.role, orderId);
  }

  async setPaymentTerms(actor: FinanceActor, orderId: string, dto: SetPaymentTermsDto) {
    await this.deferredPayment.setTerms(actor, orderId, dto);
    return this.getOrder(actor.role, orderId);
  }

  async setPaymentPolicy(actor: FinanceActor, orderId: string, dto: UpdatePaymentPolicyDto) {
    await this.deferredPayment.setPolicy(actor, orderId, dto);
    return this.getOrder(actor.role, orderId);
  }

  async confirmSchedule(
    actor: FinanceActor,
    orderId: string,
    scheduleId: string,
    operationKey?: string,
  ) {
    await this.deferredPayment.confirmSchedule(actor, orderId, scheduleId, operationKey);
    return this.getOrder(actor.role, orderId);
  }

  async updatePayment(actor: FinanceActor, orderId: string, dto: PaymentUpdateDto) {
    if (!MANUAL_PAYMENT_UPDATE_STATUSES.includes(dto.paymentStatus)) {
      throw new BadRequestException('Manual payment status must be backed by a payment fact.');
    }
    await this.prisma.$transaction(async (tx) => {
      await lockFinanceOrderAggregate(tx, orderId);
      const fo = await tx.financeOrder.findUnique({
        where: { id: orderId },
        include: {
          commercialOrder: { select: { orderNumber: true } },
          schedules: { select: { id: true, status: true } },
          operations: { select: { amount: true, paymentAllocationId: true } },
          paymentAllocations: { select: { amount: true } },
        },
      });
      if (!fo) throw new NotFoundException(`Finance order ${orderId} not found`);
      const scheduleTransitions =
        dto.paymentStatus === 'paid'
          ? fo.schedules
              .filter((schedule) => schedule.status !== 'paid')
              .map((schedule) => ({
                scheduleId: schedule.id,
                previousStatus: schedule.status,
                requestedStatus: 'paid',
              }))
          : [];
      const fingerprint = requestFingerprint({
        actorRole: actor.role,
        paymentStatus: dto.paymentStatus,
      });
      const operationKey = {
        financeOrderId_operationKey: {
          financeOrderId: orderId,
          operationKey: dto.operationKey,
        },
      };
      const existingCommand = await tx.financePaymentUpdateCommand.findUnique({
        where: operationKey,
      });
      if (existingCommand) {
        if (
          existingCommand.requestFingerprint !== fingerprint ||
          existingCommand.actorRole !== actor.role
        ) {
          throw new ConflictException({
            code: 'FINANCE_PAYMENT_UPDATE_KEY_CONFLICT',
            message: 'Payment update key is already bound to different data.',
          });
        }
        return;
      }
      const confirmedPaid = Prisma.Decimal.max(
        confirmedFinancePaidAmount({
          allocations: fo.paymentAllocations,
          operations: fo.operations,
          fallbackPaidAmount: new Prisma.Decimal(0),
        }),
        new Prisma.Decimal(0),
      );
      const invoiceAmount = fo.amountValue === null ? null : new Prisma.Decimal(fo.amountValue);
      const canonicalStatus =
        invoiceAmount !== null && invoiceAmount.greaterThan(0) && confirmedPaid.gte(invoiceAmount)
          ? 'paid'
          : confirmedPaid.greaterThan(0)
            ? 'partial'
            : 'unpaid';
      if (canonicalStatus !== dto.paymentStatus) {
        throw new ConflictException({
          code: 'FINANCE_PAYMENT_STATUS_FACT_CONFLICT',
          message: 'Payment status does not match confirmed payment facts.',
        });
      }
      const claimed = await tx.financePaymentUpdateCommand.createMany({
        data: [
          {
            financeOrderId: orderId,
            operationKey: dto.operationKey,
            requestFingerprint: fingerprint,
            actorRole: actor.role,
            requestedStatus: dto.paymentStatus,
            previousStatus: fo.paymentStatus,
            result: {
              paymentStatus: dto.paymentStatus,
              previousStatus: fo.paymentStatus,
              scheduleTransitions,
            },
          },
        ],
        skipDuplicates: true,
      });
      const command = await tx.financePaymentUpdateCommand.findUnique({
        where: operationKey,
      });
      if (
        !command ||
        command.requestFingerprint !== fingerprint ||
        command.actorRole !== actor.role
      ) {
        throw new ConflictException({
          code: 'FINANCE_PAYMENT_UPDATE_KEY_CONFLICT',
          message: 'Payment update key is already bound to different data.',
        });
      }
      if (claimed.count === 0) return;
      const safeDetail = {
        commercialOrderId: fo.commercialOrderId,
        financeOrderId: fo.id,
        orderNumber: fo.commercialOrder.orderNumber,
      };

      await tx.financeOrder.update({
        where: { id: orderId },
        data: { paymentStatus: dto.paymentStatus },
      });
      const confirmation = dto.paymentStatus === 'partial' || dto.paymentStatus === 'paid';
      const confirmedAt = new Date();
      // Keep the commercial order's independent payment indicator in sync (ТЗ §5.1).
      await tx.commercialOrder.update({
        where: { id: fo.commercialOrderId },
        data: {
          paymentStatus: dto.paymentStatus,
          ...(confirmation
            ? {
                commercialStage: 'in_work',
                financeConfirmedAt: confirmedAt,
                commercialLockedAt: confirmedAt,
              }
            : {}),
        },
      });
      if (dto.paymentStatus === 'paid') {
        await tx.paymentSchedule.updateMany({
          where: { financeOrderId: orderId, status: { not: 'paid' } },
          data: { status: 'paid' },
        });
      }
      await captureProductionClearance(
        tx,
        this.audit,
        actor,
        orderId,
        'Manual payment update now allows production.',
      );
      await tx.domainEvent.create({
        data: {
          family: 'audit',
          type: 'audit:payment_status_updated',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          oldValue: { paymentStatus: fo.paymentStatus } as unknown as Prisma.InputJsonValue,
          newValue: {
            paymentStatus: dto.paymentStatus,
          } as unknown as Prisma.InputJsonValue,
          detail: safeDetail,
        },
      });
      if (confirmation) {
        await tx.domainEvent.create({
          data: {
            family: 'audit',
            type: 'audit:commercial_order_locked_by_payment',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: fo.commercialOrderId,
            oldValue: {
              paymentStatus: fo.paymentStatus,
            } as unknown as Prisma.InputJsonValue,
            newValue: {
              paymentStatus: dto.paymentStatus,
              commercialStage: 'in_work',
              commercialLockedAt: confirmedAt,
            } as unknown as Prisma.InputJsonValue,
            detail: {
              ...safeDetail,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
    });
    return this.getOrder(actor.role, orderId);
  }

  async recordOperation(actor: FinanceActor, orderId: string, dto: PaymentOperationDto) {
    const operationKey = typeof dto.operationKey === 'string' ? dto.operationKey.toLowerCase() : '';
    if (!UUID_V4.test(operationKey)) {
      throw new BadRequestException('Payment operation key must be a UUIDv4.');
    }
    if (
      !Number.isFinite(dto.amount) ||
      dto.amount <= 0 ||
      dto.amount > MAX_PAYMENT_OPERATION_AMOUNT ||
      Number(dto.amount.toFixed(2)) !== dto.amount
    ) {
      throw new BadRequestException('Payment operation amount must be positive with two decimals.');
    }
    const source = 'manual_platform' as const;
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.financeOrder.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException(`Finance order ${orderId} not found`);
      const claimed = await tx.paymentOperation.createMany({
        data: [
          {
            financeOrderId: orderId,
            operationKey,
            operationType: dto.operationType,
            amount: dto.amount,
            source,
            createdByRole: actor.role,
          },
        ],
        skipDuplicates: true,
      });
      const op = await tx.paymentOperation.findUnique({
        where: {
          financeOrderId_operationKey: {
            financeOrderId: orderId,
            operationKey,
          },
        },
      });
      if (!op) {
        throw new ConflictException({
          code: 'FINANCE_OPERATION_CLAIM_LOST',
          message: 'Payment operation claim was not retained. Refresh and retry.',
        });
      }
      const compatible =
        op.operationType === dto.operationType &&
        Math.round(Number(op.amount) * 100) === Math.round(dto.amount * 100) &&
        op.source === source &&
        op.createdByRole === actor.role;
      if (!compatible) {
        throw new ConflictException({
          code: 'FINANCE_OPERATION_KEY_CONFLICT',
          message: 'Payment operation key is already bound to different data.',
        });
      }
      if (claimed.count === 0) return op;
      const isCash = dto.operationType === 'cash' || dto.operationType === 'cash_to_non_cash';
      await this.audit.record(
        {
          type: isCash ? 'audit:cash_operation_recorded' : 'audit:payment_status_imported',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          detail: {
            operationId: op.id,
            operationKey,
            operationType: dto.operationType,
            amount: dto.amount,
            source,
          },
        },
        tx,
      );
      return op;
    });
  }

  async sourceRetry(actor: FinanceActor, orderId: string, dto: SourceRetryDto) {
    const operationKey = typeof dto.operationKey === 'string' ? dto.operationKey.toLowerCase() : '';
    if (!UUID_V4.test(operationKey)) {
      throw new BadRequestException('Source retry operation key must be a UUIDv4.');
    }
    const claim = await this.claimSourceRetry(actor, orderId, operationKey);
    if (claim.kind === 'replay') return this.getOrder(actor.role, orderId);

    let pulled: PulledInvoice;
    try {
      // The network call stays outside a database transaction. The durable claim prevents a
      // second key from issuing another pull while this one is in flight.
      pulled = await this.onec.pullInvoice(claim.invoiceExternalId);
    } catch {
      await this.failSourceRetry(actor, orderId, operationKey, claim);
      throw new ServiceUnavailableException(SOURCE_RETRY_FAILED_RESPONSE);
    }

    await this.completeSourceRetry(actor, orderId, operationKey, claim, pulled);
    return this.getOrder(actor.role, orderId);
  }

  async reportProblem(actor: FinanceActor, orderId: string, dto: FinanceProblemDto) {
    const reason = dto.reason?.trim();
    const evidence = dto.evidence?.trim() || reason;
    if (!reason || reason.length < 3 || reason.length > 500) {
      throw new BadRequestException('A bounded finance problem reason is required.');
    }
    if (!evidence || evidence.length > 500) {
      throw new BadRequestException('Finance problem evidence is invalid.');
    }
    const type = dto.kind === 'overdue' ? 'problem:payment_overdue' : 'problem:payment_sync_error';
    await this.serializable(async (tx) => {
      const order = await tx.financeOrder.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException(`Finance order ${orderId} not found`);
      await tx.productionProblem.create({
        data: {
          orderId: order.commercialOrderId,
          actorRole: actor.role,
          reason,
        },
      });
      await tx.directorDecision.create({
        data: {
          scope: 'finance',
          objectId: orderId,
          evidence,
          severity: dto.kind === 'overdue' ? 'critical' : 'warning',
        },
      });
      await this.audit.record(
        {
          type,
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          reason,
        },
        tx,
      );
    });
    return { ok: true };
  }

  /** Source snapshot — parsed business interpretation only; rawPayload never leaks (ТЗ §8). */
  async getSourceSnapshot(snapshotId: string) {
    const snap = await this.prisma.sourceSnapshot.findUnique({
      where: { id: snapshotId },
      select: SNAPSHOT_SAFE_SELECT,
    });
    if (!snap) throw new NotFoundException(`Source snapshot ${snapshotId} not found`);
    return snap;
  }

  async getAudit(orderId: string) {
    const order = await this.prisma.financeOrder.findUnique({
      where: { id: orderId },
      select: { id: true, commercialOrderId: true },
    });
    if (!order) throw new NotFoundException(`Finance order ${orderId} not found`);
    const events = await this.prisma.domainEvent.findMany({
      where: {
        family: 'audit',
        objectId: { in: [order.id, order.commercialOrderId] },
      },
      select: {
        id: true,
        objectId: true,
        type: true,
        actorRole: true,
        actorId: true,
        actor: { select: { displayName: true } },
        createdAt: true,
        reason: true,
        oldValue: true,
        newValue: true,
        detail: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5_001,
    });
    if (events.length > 5_000) {
      throw new UnprocessableEntityException({
        code: 'FINANCE_CONTEXT_HISTORY_TOO_LARGE',
        message: 'История счёта содержит слишком много событий для безопасной выдачи.',
      });
    }
    return projectFinanceContextHistory(
      events.map((event) => ({
        ...event,
        objectId: event.objectId ?? order.id,
        actorRole: event.actorRole ?? null,
        actorDisplayName: event.actor?.displayName ?? null,
      })),
    );
  }

  private async requireOrder(orderId: string) {
    const fo = await this.prisma.financeOrder.findUnique({ where: { id: orderId } });
    if (!fo) throw new NotFoundException(`Finance order ${orderId} not found`);
    return fo;
  }

  private async claimSourceRetry(
    actor: FinanceActor,
    orderId: string,
    operationKey: string,
  ): Promise<SourceRetryClaim> {
    const activeScopeKey = `finance-source-retry:${orderId}`;
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.financeOrder.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException(`Finance order ${orderId} not found`);
      const invoiceExternalId = order.externalId;
      if (!invoiceExternalId || !ONEC_GUID.test(invoiceExternalId)) {
        throw new ConflictException({
          code: 'FINANCE_ONEC_INVOICE_NOT_LINKED',
          message: 'Finance order is not linked to an exact 1С invoice GUID.',
        });
      }
      const nowMs = Date.now();
      const now = new Date(nowMs);
      const activeBeforeClaim = await tx.syncJournal.findUnique({ where: { activeScopeKey } });
      if (
        activeBeforeClaim?.status === 'retry_requested' &&
        activeBeforeClaim.leaseExpiresAt &&
        activeBeforeClaim.leaseExpiresAt <= now
      ) {
        const expired = await tx.syncJournal.updateMany({
          where: {
            id: activeBeforeClaim.id,
            operationKey: activeBeforeClaim.operationKey,
            activeScopeKey,
            status: 'retry_requested',
            leaseExpiresAt: { lte: now },
          },
          data: {
            status: 'error',
            activeScopeKey: null,
            leaseExpiresAt: null,
            recovery: 'Source retry lease expired before completion.',
            completedAt: now,
          },
        });
        if (expired.count === 1) {
          await this.audit.record(
            {
              type: 'integration.onec_import_failed',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              detail: {
                operationKey: activeBeforeClaim.operationKey,
                code: 'SOURCE_RETRY_LEASE_EXPIRED',
              },
            },
            tx,
          );
        } else {
          const winner = await tx.syncJournal.findUnique({
            where: { id: activeBeforeClaim.id },
          });
          if (winner?.operationKey === operationKey) {
            if (winner.status === 'ready' && winner.sourceSnapshotId) {
              return { kind: 'replay' };
            }
            if (winner.status === 'error') {
              throw new ServiceUnavailableException(SOURCE_RETRY_FAILED_RESPONSE);
            }
            if (winner.status === 'retry_requested') {
              throw new ConflictException({
                code: 'FINANCE_SOURCE_RETRY_IN_PROGRESS',
                message: 'This source retry is still in progress.',
              });
            }
          }
          throw new ConflictException({
            code: 'FINANCE_SOURCE_RETRY_STATE_CHANGED',
            message: 'The source retry owner completed while expiry was being claimed.',
          });
        }
      }
      const attempt = (await tx.syncJournal.count({ where: { financeOrderId: orderId } })) + 1;
      const claimed = await tx.syncJournal.createMany({
        data: [
          {
            financeOrderId: orderId,
            operationKey,
            activeScopeKey,
            entity: 'finance_order',
            status: 'retry_requested',
            ownerRole: actor.role,
            retries: attempt,
            leaseExpiresAt: new Date(
              nowMs + this.config.onecTimeoutMs + SOURCE_RETRY_LEASE_MARGIN_MS,
            ),
          },
        ],
        skipDuplicates: true,
      });

      if (claimed.count === 0) {
        const sameKey = await tx.syncJournal.findUnique({ where: { operationKey } });
        if (sameKey) {
          if (sameKey.financeOrderId !== orderId) {
            throw new ConflictException({
              code: 'FINANCE_SOURCE_RETRY_KEY_CONFLICT',
              message: 'Source retry key is already bound to another finance order.',
            });
          }
          if (sameKey.status === 'ready' && sameKey.sourceSnapshotId) return { kind: 'replay' };
          if (sameKey.status === 'error') {
            throw new ServiceUnavailableException(SOURCE_RETRY_FAILED_RESPONSE);
          }
          throw new ConflictException({
            code: 'FINANCE_SOURCE_RETRY_IN_PROGRESS',
            message: 'This source retry is still in progress.',
          });
        }
        const active = await tx.syncJournal.findUnique({ where: { activeScopeKey } });
        if (active) {
          throw new ConflictException({
            code: 'FINANCE_SOURCE_RETRY_ACTIVE_CONFLICT',
            message: 'Another source retry is already active for this finance order.',
          });
        }
        throw new ConflictException({
          code: 'FINANCE_SOURCE_RETRY_CLAIM_LOST',
          message: 'Source retry claim was not retained. Refresh and retry.',
        });
      }

      const journal = await tx.syncJournal.findUnique({ where: { operationKey } });
      if (!journal || journal.financeOrderId !== orderId) {
        throw new ConflictException({
          code: 'FINANCE_SOURCE_RETRY_CLAIM_LOST',
          message: 'Source retry claim was not retained. Refresh and retry.',
        });
      }
      await tx.financeOrder.update({
        where: { id: orderId },
        data: { sourceStatus: 'retry_requested' },
      });
      await this.audit.record(
        {
          type: 'audit:sync_retry_requested',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          oldValue: { sourceStatus: order.sourceStatus },
          newValue: { sourceStatus: 'retry_requested' },
          detail: { operationKey, attempt },
        },
        tx,
      );
      return {
        kind: 'claimed',
        journalId: journal.id,
        invoiceExternalId,
        activeScopeKey,
      };
    });
  }

  private async completeSourceRetry(
    actor: FinanceActor,
    orderId: string,
    operationKey: string,
    claim: Extract<SourceRetryClaim, { kind: 'claimed' }>,
    pulled: PulledInvoice,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.sourceSnapshot.create({
        data: {
          financeOrderId: orderId,
          subjectType: 'invoice',
          subjectId: orderId,
          externalId: pulled.externalId,
          sourceVersion: pulled.sourceVersion,
          sourceKind: pulled.sourceKind,
          ownerRole: actor.role,
          capturedAt: new Date(pulled.capturedAt),
          importedAt: new Date(),
          checkedAt: new Date(),
          staleness: pulled.staleness,
          parsed: pulled.parsed as unknown as Prisma.InputJsonValue,
          rawPayload: pulled.rawPayload as Prisma.InputJsonValue,
        },
      });
      const completed = await tx.syncJournal.updateMany({
        where: {
          id: claim.journalId,
          operationKey,
          status: 'retry_requested',
          activeScopeKey: claim.activeScopeKey,
        },
        data: {
          status: 'ready',
          activeScopeKey: null,
          leaseExpiresAt: null,
          sourceSnapshotId: snapshot.id,
          completedAt: new Date(),
        },
      });
      if (completed.count !== 1) {
        throw new ConflictException({
          code: 'FINANCE_SOURCE_RETRY_CLAIM_LOST',
          message: 'Source retry claim changed before completion.',
        });
      }
      await tx.financeOrder.update({
        where: { id: orderId },
        data: { sourceStatus: 'ready' },
      });
      await this.audit.record(
        {
          type: 'integration.onec_imported',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          sourceSnapshotId: snapshot.id,
          detail: {
            operationKey,
            sourceKind: pulled.sourceKind,
            externalId: pulled.externalId,
            sourceVersion: pulled.sourceVersion,
          },
        },
        tx,
      );
    });
  }

  private async failSourceRetry(
    actor: FinanceActor,
    orderId: string,
    operationKey: string,
    claim: Extract<SourceRetryClaim, { kind: 'claimed' }>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const failed = await tx.syncJournal.updateMany({
        where: {
          id: claim.journalId,
          operationKey,
          status: 'retry_requested',
          activeScopeKey: claim.activeScopeKey,
        },
        data: {
          status: 'error',
          activeScopeKey: null,
          leaseExpiresAt: null,
          recovery: 'Retry with a new operation key after checking 1C availability.',
          completedAt: new Date(),
        },
      });
      if (failed.count !== 1) return;
      await tx.financeOrder.update({ where: { id: orderId }, data: { sourceStatus: 'error' } });
      await this.audit.record(
        {
          type: 'integration.onec_import_failed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          detail: { operationKey, code: 'ONEC_PULL_FAILED' },
        },
        tx,
      );
    });
  }

  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException({
          code: 'FINANCE_MUTATION_CONFLICT',
          message: 'The finance object changed concurrently. Refresh and retry.',
        });
      }
      throw error;
    }
  }

  private whereForBucket(bucket?: string): Prisma.FinanceOrderWhereInput {
    if (bucket !== undefined && !isFinanceOrderBucket(bucket)) {
      throw new BadRequestException({
        code: 'INVALID_FINANCE_ORDER_BUCKET',
        message: 'Unsupported finance order bucket.',
      });
    }
    switch (bucket) {
      case 'actual':
        return { invoiceStatus: 'not_invoiced' };
      case 'actions':
        return {
          invoiceStatus: 'invoiced',
          paymentStatus: { notIn: ['paid', 'overdue', 'sync_error'] },
        };
      case 'problems':
        return { paymentStatus: { in: ['overdue', 'sync_error'] } };
      case 'completed':
        return { paymentStatus: 'paid' };
      case 'unpaid':
        return { paymentStatus: 'unpaid' };
      case 'overdue':
        return { paymentStatus: 'overdue' };
      case undefined:
        return {};
    }
  }

  private async projectCase(
    order: FinanceOrderWithRelations,
    actor: Actor,
  ): Promise<FinanceOverviewCase> {
    const projected = await this.project(order, actor);
    const paidAmount = Number(projected.paymentSummary.paidAmount);
    const remainingAmount =
      projected.paymentSummary.remainingAmount === null
        ? null
        : Number(projected.paymentSummary.remainingAmount);
    const action = this.nextAction(projected);

    return {
      ...projected,
      bucket: this.bucketFor(order, projected.businessPayment.status),
      action,
      paidAmount,
      remainingAmount,
      hasInstallment: order.schedules.length > 0,
    };
  }

  private bucketFor(
    order: FinanceOrderWithRelations,
    businessStatus: FinanceOrderProjection['businessPayment']['status'],
  ): FinanceOverviewBucket {
    if (order.invoiceStatus === 'not_invoiced') return 'actual';
    if (businessStatus === 'paid') return 'completed';
    if (businessStatus === 'overdue' || order.paymentStatus === 'sync_error') return 'problems';
    return 'actions';
  }

  private nextAction(order: FinanceOrderProjection): FinanceOverviewAction {
    const openSchedule = [...order.schedules]
      .filter((schedule) => schedule.status !== 'paid' && schedule.dueDate)
      .sort((left, right) => left.dueDate!.localeCompare(right.dueDate!))[0];
    const effectiveDate = openSchedule?.dueDate ?? null;
    const hasConditionalSchedule = order.schedules.some(
      (schedule) => schedule.status !== 'paid' && schedule.dateKind === 'condition',
    );

    if (order.invoiceStatus === 'not_invoiced') {
      return { kind: 'create_invoice', label: 'Открыть счет', dueDate: null };
    }
    if (!order.paymentTermsType && !order.paymentPolicy) {
      return { kind: 'select_payment_terms', label: 'Выбрать условия оплаты', dueDate: null };
    }
    if (order.paymentStatus === 'overdue') {
      return {
        kind: 'resolve_overdue',
        label: 'Разобрать просрочку',
        dueDate: effectiveDate,
      };
    }
    if (order.paymentStatus === 'paid') {
      return { kind: 'history', label: 'Открыть историю', dueDate: null };
    }
    if (!openSchedule && hasConditionalSchedule) {
      return {
        kind: 'wait_for_full_shipment',
        label: 'Ожидать полной отгрузки',
        dueDate: null,
      };
    }
    return {
      kind: 'check_payment',
      label: 'Проверить оплату',
      dueDate: effectiveDate,
    };
  }

  private buildCalendar(cases: FinanceOverviewCase[]) {
    const byDate = new Map<string, { actionOrderIds: Set<string>; overdueOrderIds: Set<string> }>();
    for (const item of cases) {
      for (const entry of this.calendarEntries(item)) {
        const current = byDate.get(entry.date) ?? {
          actionOrderIds: new Set<string>(),
          overdueOrderIds: new Set<string>(),
        };
        if (entry.actionable) current.actionOrderIds.add(item.id);
        if (entry.overdue) current.overdueOrderIds.add(item.id);
        byDate.set(entry.date, current);
      }
    }
    return [...byDate.entries()]
      .map(([date, counts]) => ({
        date,
        actionCount: counts.actionOrderIds.size,
        overdueCount: counts.overdueOrderIds.size,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private calendarEntries(order: FinanceOverviewCase) {
    const schedules = order.schedules
      .filter((schedule) => schedule.dueDate)
      .map((schedule) => ({
        date: schedule.dueDate!,
        actionable: schedule.status !== 'paid',
        overdue:
          schedule.status !== 'paid' &&
          (schedule.status === 'overdue' || order.paymentStatus === 'overdue'),
      }));
    if (schedules.length > 0) return schedules;
    return order.action.dueDate
      ? [
          {
            date: order.action.dueDate,
            actionable: order.action.kind !== 'history',
            overdue: order.paymentStatus === 'overdue',
          },
        ]
      : [];
  }

  private openCalendarEntries(order: FinanceOverviewCase) {
    const schedules = order.schedules
      .filter((schedule) => schedule.status !== 'paid' && schedule.dueDate)
      .map((schedule) => ({
        date: schedule.dueDate!,
        overdue: schedule.status === 'overdue' || order.paymentStatus === 'overdue',
      }));
    if (schedules.length > 0) return schedules;
    return order.action.dueDate
      ? [{ date: order.action.dueDate, overdue: order.paymentStatus === 'overdue' }]
      : [];
  }

  private dateKey(value?: Date | string | null) {
    if (!value) return null;
    return moscowBusinessDate(new Date(value));
  }

  private projectSchedule(
    order: FinanceOrderWithRelations,
    schedule: FinancePaymentSchedule,
  ): FinancePaymentScheduleProjection {
    const stage = order.policy?.stages.find(
      (candidate) => candidate.id === schedule.paymentPolicyStageId,
    );
    const dueDate = this.dateKey(schedule.dueDate);
    const dateKind: PaymentScheduleDateKind = dueDate
      ? 'actual'
      : stage?.trigger === 'full_shipment' && !order.commercialOrder.shipmentCompletedAt
        ? 'condition'
        : 'unavailable';

    return {
      id: schedule.id,
      kind: schedule.kind,
      sequence: stage?.sequence ?? null,
      trigger: (stage?.trigger as PaymentStageTrigger | undefined) ?? null,
      percentageBasisPoints: schedule.percentageBasisPoints,
      offsetDays: schedule.offsetDays,
      startsAt: schedule.startsAt,
      amount: new Prisma.Decimal(schedule.amount).toNumber(),
      dueDate,
      dateKind,
      status: schedule.status,
      source: schedule.source,
      paidAmount: '0.00',
      remainingAmount: moneyString(schedule.amount) ?? '0.00',
      isOverdue: false,
    };
  }

  private async project(
    order: FinanceOrderWithRelations,
    actor: Actor,
  ): Promise<FinanceOrderProjection> {
    const paymentPolicy = order.policy
      ? {
          id: order.policy.id,
          installmentDays: order.policy.installmentDays,
          capturedProductionLeadDays: order.policy.capturedProductionLeadDays,
          revision: order.policy.revision,
          invoiceExternalId: order.policy.invoiceExternalId,
          invoiceSourceVersion: order.policy.invoiceSourceVersion,
          capturedInvoiceAmount: moneyString(order.policy.capturedInvoiceAmount),
          capturedInvoiceCurrency: order.policy.capturedInvoiceCurrency,
          stages: [...order.policy.stages]
            .sort((left, right) => left.sequence - right.sequence)
            .map((stage) => ({
              id: stage.id,
              sequence: stage.sequence,
              trigger: stage.trigger,
              percentageBasisPoints: stage.percentageBasisPoints,
              offsetDays: stage.offsetDays,
              label: stage.label,
            })),
        }
      : null;

    const coverage =
      order.commercialOrder.warehouseCoverageWorkflowVersion === 2
        ? await this.coverageProjection.readForFinance(actor, order.id)
        : null;
    const invoice = safeInvoiceProjection(order);
    const invoiceAmount = order.amountValue === null ? null : new Prisma.Decimal(order.amountValue);
    const fallbackPaid = order.policy
      ? order.schedules
          .filter((schedule) => schedule.status === 'paid')
          .reduce((sum, schedule) => sum.add(schedule.amount), new Prisma.Decimal(0))
      : order.paymentStatus === 'paid' && invoiceAmount !== null
        ? invoiceAmount
        : order.operations.reduce(
            (sum, operation) => sum.add(operation.amount),
            new Prisma.Decimal(0),
          );
    const paid = confirmedFinancePaidAmount({
      allocations: order.paymentAllocations,
      operations: order.operations,
      fallbackPaidAmount: fallbackPaid,
    });
    const paidAmount = paid.comparedTo(0) < 0 ? new Prisma.Decimal(0) : paid;
    const remainingAmount =
      invoiceAmount === null
        ? null
        : Prisma.Decimal.max(invoiceAmount.sub(paidAmount), new Prisma.Decimal(0));
    const overpaidAmount =
      invoiceAmount === null
        ? new Prisma.Decimal(0)
        : Prisma.Decimal.max(paidAmount.sub(invoiceAmount), new Prisma.Decimal(0));
    const allocatedBySchedule = new Map<string, Prisma.Decimal>();
    for (const allocation of order.paymentAllocations) {
      if (!allocation.scheduleId) continue;
      allocatedBySchedule.set(
        allocation.scheduleId,
        (allocatedBySchedule.get(allocation.scheduleId) ?? new Prisma.Decimal(0)).add(
          allocation.amount,
        ),
      );
    }
    const businessPayment = projectFinancePaymentState({
      invoiceAmount,
      paidAmount,
      schedules: order.schedules.map((schedule) => ({
        id: schedule.id,
        dueDate: schedule.dueDate,
        amount: new Prisma.Decimal(schedule.amount),
        allocatedAmount:
          allocatedBySchedule.get(schedule.id) ??
          (schedule.status === 'paid'
            ? new Prisma.Decimal(schedule.amount)
            : new Prisma.Decimal(0)),
      })),
      now: new Date(),
    });
    const businessScheduleById = new Map(
      businessPayment.schedules.map((schedule) => [schedule.id, schedule]),
    );
    const paymentTimeline = order.paymentAllocations.map((allocation) => ({
      id: allocation.id,
      receiptId: allocation.receipt.id,
      receiptExternalId: allocation.receipt.externalId,
      receiptNumber: allocation.receipt.number,
      receivedAt: allocation.receipt.receivedAt?.toISOString() ?? null,
      receiptAmount: moneyString(allocation.receipt.amount),
      currency: allocation.receipt.currency,
      sourceStatus: allocation.receipt.sourceStatus,
      scheduleId: allocation.scheduleId,
      amount: moneyString(allocation.amount),
      status: allocation.status,
      matchKind: allocation.matchKind,
      reversesId: allocation.reversesId,
      createdAt: allocation.createdAt.toISOString(),
    }));

    return {
      id: order.id,
      commercialOrderId: order.commercialOrderId,
      invoiceStatus: order.invoiceStatus,
      invoiceSyncState: order.invoiceSyncState,
      invoiceNumber: order.invoiceNumber,
      invoiceCurrency: order.invoiceCurrency,
      invoiceSourceCheckedAt: order.invoiceSourceCheckedAt,
      paymentStatus: businessPayment.status,
      amountValue: moneyString(order.amountValue),
      amountLabel: order.amountLabel,
      paymentTermsType: order.paymentTermsType,
      invoiceIssuedAt: order.invoiceIssuedAt,
      sourceStatus: order.sourceStatus,
      productionClearedAt: order.productionClearedAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      externalId: order.externalId,
      sourceVersion: order.sourceVersion,
      commercialOrder: {
        id: order.commercialOrder.id,
        orderNumber: order.commercialOrder.orderNumber,
        creatorRole: order.commercialOrder.creatorRole,
        counterpartyId: order.commercialOrder.counterpartyId,
        requestType: order.commercialOrder.requestType,
        productionIndicator: order.commercialOrder.productionIndicator,
        warehouseCoverStatus: order.commercialOrder.warehouseCoverStatus,
        paymentStatus: order.commercialOrder.paymentStatus,
        shipmentStatus: order.commercialOrder.shipmentStatus,
        shipmentCompletedAt: order.commercialOrder.shipmentCompletedAt,
        warehouseCoverageWorkflowVersion: order.commercialOrder.warehouseCoverageWorkflowVersion,
        createdAt: order.commercialOrder.createdAt,
        updatedAt: order.commercialOrder.updatedAt,
        externalId: order.commercialOrder.externalId,
        sourceVersion: order.commercialOrder.sourceVersion,
        commercialFinanceNote: order.commercialOrder.commercialFinanceNote,
        comment: order.commercialOrder.comment,
        positions: order.commercialOrder.positions
          .filter((position) => position.rollCount > 0)
          .map((position) => ({
            id: position.id,
            rollCount: position.rollCount,
            filmType: position.filmType,
            actualThickness: position.actualThickness,
            accountingThickness: position.accountingThickness,
            spoolType: position.spoolType,
            birka: position.birka,
            plannedWeightKg: position.plannedWeightKg,
            widthMm: position.widthMm,
            plannedLengthM: position.plannedLengthM,
          })),
        counterparty: projectCounterparty(order.commercialOrder.counterparty, actor.role),
      },
      paymentPolicy,
      schedules: order.schedules.map((schedule) => {
        const projected = this.projectSchedule(order, schedule);
        const business = businessScheduleById.get(schedule.id);
        return {
          ...projected,
          status: business?.status ?? projected.status,
          paidAmount: business?.paidAmount ?? '0.00',
          remainingAmount: business?.remainingAmount ?? moneyString(schedule.amount) ?? '0.00',
          isOverdue: business?.isOverdue ?? false,
        };
      }),
      operations: order.operations.map((operation) => ({
        id: operation.id,
        operationType: operation.operationType,
        amount: new Prisma.Decimal(operation.amount).toFixed(2),
        source: operation.source,
        createdAt: operation.createdAt,
        paymentAllocationId: operation.paymentAllocationId,
      })),
      invoice,
      paymentSummary: {
        invoiceAmount: moneyString(invoiceAmount),
        paidAmount: paidAmount.toFixed(2),
        remainingAmount: moneyString(remainingAmount),
        overpaidAmount: overpaidAmount.toFixed(2),
      },
      paymentTimeline,
      businessPayment,
      paymentCorrections: order.paymentCorrections.map((correction) => {
        const result =
          correction.result &&
          typeof correction.result === 'object' &&
          !Array.isArray(correction.result)
            ? (correction.result as Record<string, unknown>)
            : null;
        const resultingStatus =
          typeof result?.paymentStatus === 'string' ? result.paymentStatus : null;
        return {
          id: correction.id,
          targetKind: correction.targetKind,
          reason: correction.reason,
          actorRole:
            correction.actorRole === 'finance' ? 'Бухгалтерия' : 'Авторизованный сотрудник',
          resultingStatus,
          createdAt: correction.createdAt.toISOString(),
        };
      }),
      correctablePayments: this.correctablePayments(order, actor),
      ...(coverage ? { coverage } : {}),
    };
  }

  private correctablePayments(
    order: FinanceOrderWithRelations,
    actor: Actor,
  ): CorrectablePaymentTarget[] {
    const capabilityAllowed = actor.capabilities.includes('payment:correct');
    const corrected = new Set(
      (order.paymentCorrections ?? []).map(
        ({ targetKind, targetId }) => `${targetKind}:${targetId}`,
      ),
    );
    const result: CorrectablePaymentTarget[] = [];
    for (const command of order.paymentUpdateCommands ?? []) {
      const targetKey = `payment_update:${command.id}`;
      const addressable = Boolean(command.requestedStatus && command.previousStatus);
      const stale = command.requestedStatus !== order.paymentStatus;
      const alreadyCorrected = corrected.has(targetKey);
      result.push({
        target: { kind: 'payment_update', id: command.id },
        label: `Ручное подтверждение статуса «${command.requestedStatus ?? 'неизвестно'}»`,
        amount: moneyString(command.amountPaid),
        source: 'manual_platform',
        canCorrect: capabilityAllowed && addressable && !stale && !alreadyCorrected,
        blockedReason: alreadyCorrected
          ? 'Подтверждение уже отменено'
          : !addressable
            ? 'Старая запись не содержит снимка для безопасной отмены'
            : stale
              ? 'После подтверждения появились новые платёжные факты'
              : capabilityAllowed
                ? null
                : 'Недостаточно прав',
      });
    }

    const allocatedBySchedule = new Map<string, Prisma.Decimal>();
    for (const allocation of order.paymentAllocations ?? []) {
      if (!allocation.scheduleId) continue;
      allocatedBySchedule.set(
        allocation.scheduleId,
        (allocatedBySchedule.get(allocation.scheduleId) ?? new Prisma.Decimal(0)).plus(
          allocation.amount,
        ),
      );
    }
    const manualOperationBySchedule = new Map(
      order.operations
        .filter(
          (operation) =>
            operation.paymentScheduleId &&
            operation.source === 'manual_platform' &&
            new Prisma.Decimal(operation.amount).gt(0) &&
            !operation.reversesOperationId,
        )
        .map((operation) => [operation.paymentScheduleId!, operation]),
    );
    for (const schedule of order.schedules.filter(({ status }) => status === 'paid')) {
      const targetKey = `schedule_confirmation:${schedule.id}`;
      const fromOneC = (allocatedBySchedule.get(schedule.id) ?? new Prisma.Decimal(0)).gt(0);
      const addressable = manualOperationBySchedule.has(schedule.id);
      const alreadyCorrected = corrected.has(targetKey);
      const source = fromOneC ? '1C' : 'manual_platform';
      result.push({
        target: { kind: 'schedule_confirmation', id: schedule.id },
        label: `Подтверждение этапа оплаты${schedule.terms ? `: ${schedule.terms}` : ''}`,
        amount: moneyString(schedule.amount),
        source,
        canCorrect:
          capabilityAllowed && source === 'manual_platform' && addressable && !alreadyCorrected,
        blockedReason: alreadyCorrected
          ? 'Подтверждение уже отменено'
          : source === '1C'
            ? 'Исправьте платёж в 1С'
            : !addressable
              ? 'Для этапа нет адресуемого ручного платёжного факта'
              : capabilityAllowed
                ? null
                : 'Недостаточно прав',
      });
    }

    for (const operation of order.operations.filter(
      (candidate) =>
        new Prisma.Decimal(candidate.amount).gt(0) &&
        !candidate.reversesOperationId &&
        !candidate.paymentScheduleId,
    )) {
      const targetKey = `payment_operation:${operation.id}`;
      const source = operation.source === 'manual_platform' ? 'manual_platform' : '1C';
      const alreadyCorrected = corrected.has(targetKey);
      result.push({
        target: { kind: 'payment_operation', id: operation.id },
        label: 'Платёжная операция',
        amount: moneyString(operation.amount),
        source,
        canCorrect: capabilityAllowed && source === 'manual_platform' && !alreadyCorrected,
        blockedReason: alreadyCorrected
          ? 'Операция уже компенсирована'
          : source === '1C'
            ? 'Исправьте платёж в 1С'
            : capabilityAllowed
              ? null
              : 'Недостаточно прав',
      });
    }
    return result;
  }
}
