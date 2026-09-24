import { ApiResponseParseError, apiGet, apiPost, apiPut, type ApiRequestOptions } from './client';
import { refreshOneCInvoice } from './financeOneC';
import { paymentStageConditionLabel } from '../domain/financePaymentPolicy';
import { financePaymentSourceLabel } from '../domain/financePaymentSources';
import {
  normalizeFinanceWarehouseCoverage,
  normalizeFinanceWarehouseCoverageWithCase,
  type DecideWarehouseCoverageDto,
  type FinanceWarehouseCoverageView,
  type FinanceWarehouseCoverageWithCaseView,
  type RefreshWarehouseCoverageDto,
  type RequestWarehouseCoverageRecheckDto,
} from '../domain/warehouseCoverage';
import type {
  CommercialOrderRequest,
  FinanceInvoiceView,
  FinancePaymentSummary,
  FinanceBusinessPayment,
  FinancePaymentCorrectionFact,
  FinancePaymentCorrectionCommand,
  FinancePaymentCorrectionResult,
  FinanceCorrectablePayment,
  FinancePaymentTimelineEntry,
  OneCInvoiceSyncState,
  PaymentPolicyDraft,
  PaymentPolicyPreview,
  PaymentPolicyPreviewRow,
  PaymentPolicyStageDraft,
  PaymentPolicyView,
  PaymentTermType,
  Severity,
  WorkObject,
} from '../domain/types';

type ServerCounterparty = {
  id: string;
  displayName: string;
  legalName: string | null;
  inn: string | null;
  billingSource: string;
  syncStatus: string;
};

type ServerFinanceOrderPosition = {
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
};

type ServerFinanceCommercialOrder = {
  id: string;
  orderNumber: string;
  creatorRole: 'commercial' | 'production_lead';
  counterpartyId: string;
  requestType: 'client_order' | 'stock_reserve';
  productionIndicator: string;
  warehouseCoverStatus: string;
  paymentStatus: string;
  shipmentStatus: string;
  shipmentCompletedAt: string | null;
  warehouseCoverageWorkflowVersion: 1 | 2;
  createdAt: string;
  updatedAt: string;
  externalId: string | null;
  sourceVersion: string | null;
  commercialFinanceNote: string | null;
  comment: string | null;
  positions?: ServerFinanceOrderPosition[];
  counterparty: ServerCounterparty;
};

type ServerPaymentSchedule = {
  id: string;
  kind: 'invoice_prepayment' | 'post_delivery';
  sequence: number | null;
  trigger: 'invoice_issued' | 'full_shipment' | null;
  percentageBasisPoints: number | null;
  offsetDays: number | null;
  startsAt: string | null;
  dueDate: string | null;
  dateKind: 'actual' | 'condition' | 'unavailable';
  amount: number;
  status: 'unpaid' | 'partial' | 'paid' | 'overdue' | 'sync_error';
  source: string;
  paidAmount: string;
  remainingAmount: string;
  isOverdue: boolean;
};

type ServerPaymentPolicy = Omit<PaymentPolicyView, 'stages'> & {
  stages: Array<Omit<PaymentPolicyStageDraft, 'label'> & { id?: string; label?: string | null }>;
};

type ServerPaymentPolicyPreviewRow = PaymentPolicyPreviewRow;

type ServerPaymentPolicyPreview = {
  rows: ServerPaymentPolicyPreviewRow[];
};

type ServerPaymentOperation = {
  id: string;
  paymentAllocationId?: string | null;
  operationType: string;
  amount: string;
  source: string;
  createdAt: string;
};

type ServerFinanceInvoice = {
  externalId: string;
  sourceVersion: string | null;
  sourceKind: string;
  staleness: string;
  capturedAt: string | null;
  importedAt: string | null;
  checkedAt: string | null;
  invoiceNumber: string | null;
  date: string | null;
  amount?: string | null;
  subtotal?: string | null;
  taxTotal?: string | null;
  currency: string | null;
  posted: boolean;
  counterpartyExternalId: string | null;
  organizationExternalId: string | null;
  lines?: Array<{
    lineNumber: number;
    nomenclatureExternalId?: string | null;
    name?: string | null;
    quantity: number;
    price: string;
    amount: string;
    unitExternalId?: string | null;
    taxRate?: string | null;
    taxAmount?: string | null;
  }>;
};

type ServerFinancePaymentTimelineEntry = {
  id: string;
  receiptId: string;
  receiptExternalId: string;
  receiptNumber: string;
  receivedAt: string | null;
  receiptAmount: string;
  currency: string;
  sourceStatus: string;
  scheduleId: string | null;
  amount: string;
  status: string;
  matchKind: string;
  reversesId: string | null;
  createdAt: string;
};

type ServerFinancePaymentSummary = {
  invoiceAmount: string | null;
  paidAmount: string;
  remainingAmount: string | null;
  overpaidAmount: string;
};

type ServerFinanceBusinessPayment = FinanceBusinessPayment & {
  schedules: Array<{
    id: string;
    dueDate: string | null;
    dueLabel: string;
    amount: string;
    paidAmount: string;
    remainingAmount: string;
    status: FinanceBusinessPayment['status'];
    isOverdue: boolean;
  }>;
};

type ServerFinanceOrder = {
  id: string;
  commercialOrderId: string;
  invoiceStatus: string;
  paymentStatus: string;
  paymentTermsType: PaymentTermType | null;
  paymentPolicy: ServerPaymentPolicy | null;
  amountValue: string | null;
  amountLabel: string | null;
  invoiceIssuedAt: string | null;
  sourceStatus: string;
  productionClearedAt: string | null;
  invoiceSyncState: OneCInvoiceSyncState;
  invoiceNumber: string | null;
  invoiceCurrency: string | null;
  invoiceSourceCheckedAt: string | null;
  invoice: ServerFinanceInvoice | null;
  paymentSummary: ServerFinancePaymentSummary;
  paymentTimeline: ServerFinancePaymentTimelineEntry[];
  businessPayment: ServerFinanceBusinessPayment;
  paymentCorrections: FinancePaymentCorrectionFact[];
  createdAt: string;
  updatedAt: string;
  externalId: string | null;
  sourceVersion: string | null;
  commercialOrder: ServerFinanceCommercialOrder;
  schedules: ServerPaymentSchedule[];
  operations: ServerPaymentOperation[];
  correctablePayments: FinanceCorrectablePayment[];
};

export function fetchFinanceOrders(options?: ApiRequestOptions): Promise<WorkObject[]> {
  return apiGet<unknown>('/api/finance/orders', options)
    .then(parseFinanceOrdersResponse)
    .then((orders) => orders.map(serverFinanceOrderToWorkObject));
}

const FINANCE_PAYMENT_STATUSES = new Set(['unpaid', 'partial', 'paid', 'overdue', 'sync_error']);
const FINANCE_SOURCE_STATUSES = new Set([
  'ready',
  'waiting',
  'error',
  'manual_review',
  'retry_requested',
]);
const FINANCE_INVOICE_SYNC_STATES = new Set([
  'not_synced',
  'not_found',
  'draft_found',
  'posted',
  'ambiguous',
  'stale',
  'error',
]);
const FINANCE_PRODUCTION_INDICATORS = new Set([
  'not_started',
  'needs_production',
  'in_production',
  'ready',
  'needs_approval',
  'defect',
]);
const FINANCE_WAREHOUSE_COVER_STATUSES = new Set([
  'not_checked',
  'partial_proposed',
  'full_proposed',
  'partial_confirmed',
  'full_confirmed',
  'needs_production',
  'recheck_requested',
  'rejected',
]);
const FINANCE_SHIPMENT_STATUSES = new Set([
  'not_shipped',
  'partial_shipped',
  'shipped',
  'shipment_problem',
]);
const FINANCE_SOURCE_KINDS = new Set(['1C', 'mock_1C', 'manual_platform', 'warehouse_runtime']);
const FINANCE_PAYMENT_SCHEDULE_SOURCES = new Set([...FINANCE_SOURCE_KINDS, 'payment_policy']);
const FINANCE_PAYMENT_OPERATION_RESERVED_SOURCES = new Set(['payment_policy']);
const FINANCE_COUNTERPARTY_SYNC_STATUSES = new Set(['ready', 'needs_discovery', 'stale']);
function parseFinanceOrdersResponse(value: unknown): ServerFinanceOrder[] {
  if (!Array.isArray(value) || !value.every(isFinanceOrderResponse)) {
    throw new Error('Некорректный ответ финансовых заказов.');
  }
  const ids = value.map((order) => order.id);
  const commercialOrderIds = value.map((order) => order.commercialOrderId);
  if (new Set(ids).size !== ids.length || new Set(commercialOrderIds).size !== value.length) {
    throw new Error('Некорректный ответ финансовых заказов.');
  }
  return value;
}

function parseFinanceOrderResponse(value: unknown): ServerFinanceOrder {
  if (!isFinanceOrderResponse(value)) {
    throw new Error('Некорректный ответ финансового заказа.');
  }
  return value;
}

function isFinanceOrderResponse(value: unknown): value is ServerFinanceOrder {
  if (!isFinanceRecord(value)) return false;
  const requiredKeys = [
    'id',
    'commercialOrderId',
    'invoiceStatus',
    'invoiceSyncState',
    'invoiceNumber',
    'invoiceCurrency',
    'invoiceSourceCheckedAt',
    'paymentStatus',
    'paymentTermsType',
    'amountValue',
    'amountLabel',
    'invoiceIssuedAt',
    'sourceStatus',
    'productionClearedAt',
    'createdAt',
    'updatedAt',
    'externalId',
    'sourceVersion',
    'commercialOrder',
    'paymentPolicy',
    'schedules',
    'operations',
    'invoice',
    'paymentSummary',
    'paymentTimeline',
    'businessPayment',
    'paymentCorrections',
    'correctablePayments',
  ] as const;
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !isFinanceText(value.id) ||
    !isFinanceText(value.commercialOrderId) ||
    !['not_invoiced', 'invoiced'].includes(String(value.invoiceStatus)) ||
    !FINANCE_INVOICE_SYNC_STATES.has(String(value.invoiceSyncState)) ||
    !isFinanceNullableText(value.invoiceNumber) ||
    !isFinanceNullableText(value.invoiceCurrency) ||
    !isFinanceNullableTimestamp(value.invoiceSourceCheckedAt) ||
    !FINANCE_PAYMENT_STATUSES.has(String(value.paymentStatus)) ||
    !(
      value.paymentTermsType === null ||
      ['prepay_50_postpay_50_30d', 'postpay_100_30d'].includes(String(value.paymentTermsType))
    ) ||
    !isFinanceNullableMoney(value.amountValue, false) ||
    !isFinanceNullableText(value.amountLabel) ||
    !isFinanceNullableTimestamp(value.invoiceIssuedAt) ||
    !FINANCE_SOURCE_STATUSES.has(String(value.sourceStatus)) ||
    !isFinanceNullableTimestamp(value.productionClearedAt) ||
    !isFinanceTimestamp(value.createdAt) ||
    !isFinanceTimestamp(value.updatedAt) ||
    !isFinanceNullableText(value.externalId) ||
    !isFinanceNullableText(value.sourceVersion) ||
    !isFinanceCommercialOrder(value.commercialOrder, String(value.commercialOrderId)) ||
    !isFinancePaymentPolicy(value.paymentPolicy) ||
    !Array.isArray(value.schedules) ||
    !value.schedules.every(isFinanceSchedule) ||
    !Array.isArray(value.operations) ||
    !value.operations.every(isFinanceOperation) ||
    !isFinanceInvoice(value.invoice) ||
    !isFinancePaymentSummary(value.paymentSummary) ||
    !Array.isArray(value.paymentTimeline) ||
    !value.paymentTimeline.every(isFinancePaymentTimelineEntry) ||
    !isFinanceBusinessPayment(value.businessPayment) ||
    !Array.isArray(value.paymentCorrections) ||
    !value.paymentCorrections.every(isFinancePaymentCorrectionFact) ||
    !Array.isArray(value.correctablePayments) ||
    !value.correctablePayments.every(isFinanceCorrectablePayment)
  ) {
    return false;
  }
  const nestedIds = [
    ...value.schedules.map((item) => item.id),
    ...value.operations.map((item) => item.id),
    ...value.paymentTimeline.map((item) => item.id),
    ...value.paymentCorrections.map((item) => item.id),
  ];
  if (new Set(nestedIds).size !== nestedIds.length) return false;
  const workflowVersion = value.commercialOrder.warehouseCoverageWorkflowVersion;
  if (workflowVersion === 2) {
    if (!Object.hasOwn(value, 'coverage') || !isFinanceRecord(value.coverage)) return false;
    try {
      normalizeFinanceWarehouseCoverage(value.coverage);
    } catch {
      return false;
    }
  } else if (Object.hasOwn(value, 'coverage')) {
    return false;
  }
  return true;
}

function isFinanceCommercialOrder(
  value: unknown,
  expectedId: string,
): value is ServerFinanceCommercialOrder {
  if (!isFinanceRecord(value)) return false;
  const requiredKeys = [
    'id',
    'orderNumber',
    'creatorRole',
    'counterpartyId',
    'requestType',
    'productionIndicator',
    'warehouseCoverStatus',
    'paymentStatus',
    'shipmentStatus',
    'shipmentCompletedAt',
    'warehouseCoverageWorkflowVersion',
    'createdAt',
    'updatedAt',
    'externalId',
    'sourceVersion',
    'commercialFinanceNote',
    'comment',
    'counterparty',
  ] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    value.id === expectedId &&
    isFinanceText(value.id) &&
    isFinanceText(value.orderNumber) &&
    ['commercial', 'production_lead'].includes(String(value.creatorRole)) &&
    isFinanceText(value.counterpartyId) &&
    value.requestType === 'client_order' &&
    FINANCE_PRODUCTION_INDICATORS.has(String(value.productionIndicator)) &&
    FINANCE_WAREHOUSE_COVER_STATUSES.has(String(value.warehouseCoverStatus)) &&
    FINANCE_PAYMENT_STATUSES.has(String(value.paymentStatus)) &&
    FINANCE_SHIPMENT_STATUSES.has(String(value.shipmentStatus)) &&
    isFinanceNullableTimestamp(value.shipmentCompletedAt) &&
    [1, 2].includes(Number(value.warehouseCoverageWorkflowVersion)) &&
    isFinanceTimestamp(value.createdAt) &&
    isFinanceTimestamp(value.updatedAt) &&
    isFinanceNullableText(value.externalId) &&
    isFinanceNullableText(value.sourceVersion) &&
    isFinanceNullableText(value.commercialFinanceNote) &&
    isFinanceNullableText(value.comment) &&
    (!Object.hasOwn(value, 'positions') ||
      (Array.isArray(value.positions) &&
        value.positions.length <= 100 &&
        value.positions.every(isFinanceOrderPosition))) &&
    isFinanceCounterparty(value.counterparty, value.counterpartyId)
  );
}

function isFinanceOrderPosition(value: unknown): value is ServerFinanceOrderPosition {
  return (
    isFinanceRecord(value) &&
    isFinanceText(value.id) &&
    Number.isSafeInteger(value.rollCount) &&
    Number(value.rollCount) >= 1 &&
    Number(value.rollCount) <= 10_000 &&
    isFinanceText(value.filmType) &&
    isFinanceText(value.actualThickness) &&
    isFinanceText(value.accountingThickness) &&
    isFinanceNullableText(value.spoolType) &&
    isFinanceNullableText(value.birka) &&
    isFinanceNullableNumber(value.plannedWeightKg, 0.001, 100_000) &&
    isFinanceNullableNumber(value.widthMm, 0.001, 100_000) &&
    isFinanceNullableNumber(value.plannedLengthM, 0.001, 10_000_000)
  );
}

function isFinanceCounterparty(value: unknown, expectedId: unknown): value is ServerCounterparty {
  return (
    isFinanceRecord(value) &&
    value.id === expectedId &&
    isFinanceText(value.id) &&
    isFinanceText(value.displayName) &&
    Object.hasOwn(value, 'legalName') &&
    isFinanceNullableText(value.legalName) &&
    Object.hasOwn(value, 'inn') &&
    isFinanceNullableText(value.inn) &&
    FINANCE_SOURCE_KINDS.has(String(value.billingSource)) &&
    FINANCE_COUNTERPARTY_SYNC_STATUSES.has(String(value.syncStatus))
  );
}

function isFinancePaymentPolicy(value: unknown): value is ServerPaymentPolicy | null {
  if (value === null) return true;
  if (!isFinanceRecord(value)) return false;
  const requiredKeys = [
    'id',
    'installmentDays',
    'capturedProductionLeadDays',
    'revision',
    'invoiceExternalId',
    'invoiceSourceVersion',
    'capturedInvoiceAmount',
    'capturedInvoiceCurrency',
    'stages',
  ] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    isFinanceText(value.id) &&
    Number.isSafeInteger(value.installmentDays) &&
    Number(value.installmentDays) >= 0 &&
    Number.isSafeInteger(value.capturedProductionLeadDays) &&
    Number(value.capturedProductionLeadDays) >= 0 &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    isFinanceNullableText(value.invoiceExternalId) &&
    isFinanceNullableText(value.invoiceSourceVersion) &&
    isFinanceNullableMoney(value.capturedInvoiceAmount, false) &&
    isFinanceNullableText(value.capturedInvoiceCurrency) &&
    Array.isArray(value.stages) &&
    value.stages.every(isFinancePaymentPolicyStage)
  );
}

function isFinancePaymentPolicyStage(value: unknown): boolean {
  return (
    isFinanceRecord(value) &&
    isFinanceText(value.id) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 1 &&
    ['invoice_issued', 'full_shipment'].includes(String(value.trigger)) &&
    Number.isSafeInteger(value.percentageBasisPoints) &&
    Number(value.percentageBasisPoints) > 0 &&
    Number(value.percentageBasisPoints) <= 10_000 &&
    Number.isSafeInteger(value.offsetDays) &&
    Number(value.offsetDays) >= 0 &&
    Object.hasOwn(value, 'label') &&
    isFinanceNullableText(value.label)
  );
}

function isFinanceSchedule(value: unknown): value is ServerPaymentSchedule {
  if (!isFinanceRecord(value)) return false;
  const requiredKeys = [
    'id',
    'kind',
    'sequence',
    'trigger',
    'percentageBasisPoints',
    'offsetDays',
    'startsAt',
    'dueDate',
    'dateKind',
    'amount',
    'status',
    'source',
    'paidAmount',
    'remainingAmount',
    'isOverdue',
  ] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    isFinanceText(value.id) &&
    ['invoice_prepayment', 'post_delivery'].includes(String(value.kind)) &&
    isFinanceNullableInteger(value.sequence, 1) &&
    (value.trigger === null ||
      ['invoice_issued', 'full_shipment'].includes(String(value.trigger))) &&
    isFinanceNullableInteger(value.percentageBasisPoints, 1, 10_000) &&
    isFinanceNullableInteger(value.offsetDays, 0) &&
    isFinanceNullableTimestamp(value.startsAt) &&
    isFinanceNullableDate(value.dueDate) &&
    ['actual', 'condition', 'unavailable'].includes(String(value.dateKind)) &&
    typeof value.amount === 'number' &&
    Number.isFinite(value.amount) &&
    value.amount >= 0 &&
    FINANCE_PAYMENT_STATUSES.has(String(value.status)) &&
    FINANCE_PAYMENT_SCHEDULE_SOURCES.has(String(value.source)) &&
    isFinanceMoney(value.paidAmount, false) &&
    isFinanceMoney(value.remainingAmount, false) &&
    typeof value.isOverdue === 'boolean'
  );
}

function isFinanceBusinessPayment(value: unknown): value is ServerFinanceBusinessPayment {
  if (!isFinanceRecord(value)) return false;
  return (
    isCanonicalFinanceDate(value.businessDate) &&
    ['unpaid', 'partial', 'paid', 'overdue'].includes(String(value.status)) &&
    typeof value.isOverdue === 'boolean' &&
    isFinanceMoney(value.paidAmount, false) &&
    isFinanceNullableMoney(value.remainingAmount, false) &&
    isFinanceMoney(value.overdueAmount, false) &&
    Array.isArray(value.schedules) &&
    value.schedules.every(
      (schedule) =>
        isFinanceRecord(schedule) &&
        isFinanceText(schedule.id) &&
        isFinanceNullableDate(schedule.dueDate) &&
        isFinanceText(schedule.dueLabel) &&
        isFinanceMoney(schedule.amount, false) &&
        isFinanceMoney(schedule.paidAmount, false) &&
        isFinanceMoney(schedule.remainingAmount, false) &&
        ['unpaid', 'partial', 'paid', 'overdue'].includes(String(schedule.status)) &&
        typeof schedule.isOverdue === 'boolean',
    )
  );
}

function isFinancePaymentCorrectionFact(value: unknown): value is FinancePaymentCorrectionFact {
  return (
    isFinanceRecord(value) &&
    isFinanceText(value.id) &&
    ['payment_update', 'schedule_confirmation', 'payment_operation'].includes(
      String(value.targetKind),
    ) &&
    isFinanceText(value.reason) &&
    isFinanceText(value.actorRole) &&
    isFinanceNullableText(value.resultingStatus) &&
    isFinanceTimestamp(value.createdAt)
  );
}

function isFinanceOperation(value: unknown): value is ServerPaymentOperation {
  if (!isFinanceRecord(value)) return false;
  const requiredKeys = ['id', 'operationType', 'amount', 'source', 'createdAt'] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    (!Object.hasOwn(value, 'paymentAllocationId') ||
      isFinanceNullableText(value.paymentAllocationId)) &&
    isFinanceText(value.id) &&
    ['invoice', 'cash', 'cash_to_non_cash', 'manual_adjustment', 'unknown'].includes(
      String(value.operationType),
    ) &&
    isFinanceMoney(value.amount, true) &&
    isFinanceText(value.source) &&
    !FINANCE_PAYMENT_OPERATION_RESERVED_SOURCES.has(String(value.source)) &&
    isFinanceTimestamp(value.createdAt)
  );
}

function isFinanceInvoice(value: unknown): value is ServerFinanceInvoice | null {
  if (value === null) return true;
  if (!isFinanceRecord(value)) return false;
  const requiredKeys = [
    'externalId',
    'sourceVersion',
    'sourceKind',
    'staleness',
    'capturedAt',
    'importedAt',
    'checkedAt',
    'invoiceNumber',
    'date',
    'currency',
    'posted',
    'counterpartyExternalId',
    'organizationExternalId',
  ] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    isFinanceText(value.externalId) &&
    isFinanceNullableText(value.sourceVersion) &&
    FINANCE_SOURCE_KINDS.has(String(value.sourceKind)) &&
    isFinanceText(value.staleness) &&
    isFinanceNullableTimestamp(value.capturedAt) &&
    isFinanceNullableTimestamp(value.importedAt) &&
    isFinanceNullableTimestamp(value.checkedAt) &&
    isFinanceNullableText(value.invoiceNumber) &&
    isFinanceNullableDate(value.date) &&
    isFinanceNullableText(value.currency) &&
    typeof value.posted === 'boolean' &&
    isFinanceNullableText(value.counterpartyExternalId) &&
    isFinanceNullableText(value.organizationExternalId)
  );
}

function isFinancePaymentSummary(value: unknown): value is ServerFinancePaymentSummary {
  return (
    isFinanceRecord(value) &&
    Object.hasOwn(value, 'invoiceAmount') &&
    isFinanceNullableMoney(value.invoiceAmount, false) &&
    isFinanceMoney(value.paidAmount, false) &&
    Object.hasOwn(value, 'remainingAmount') &&
    isFinanceNullableMoney(value.remainingAmount, false) &&
    isFinanceMoney(value.overpaidAmount, false)
  );
}

function isFinancePaymentTimelineEntry(value: unknown): value is ServerFinancePaymentTimelineEntry {
  if (!isFinanceRecord(value)) return false;
  const requiredKeys = [
    'id',
    'receiptId',
    'receiptExternalId',
    'receiptNumber',
    'receivedAt',
    'receiptAmount',
    'currency',
    'sourceStatus',
    'scheduleId',
    'amount',
    'status',
    'matchKind',
    'reversesId',
    'createdAt',
  ] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    isFinanceText(value.id) &&
    isFinanceText(value.receiptId) &&
    isFinanceText(value.receiptExternalId) &&
    isFinanceText(value.receiptNumber) &&
    isFinanceNullableTimestamp(value.receivedAt) &&
    isFinanceMoney(value.receiptAmount, false) &&
    isFinanceText(value.currency) &&
    isFinanceText(value.sourceStatus) &&
    isFinanceNullableText(value.scheduleId) &&
    isFinanceMoney(value.amount, true) &&
    isFinanceText(value.status) &&
    isFinanceText(value.matchKind) &&
    isFinanceNullableText(value.reversesId) &&
    isFinanceTimestamp(value.createdAt)
  );
}

function isFinanceCorrectablePayment(value: unknown): value is FinanceCorrectablePayment {
  return (
    isFinanceRecord(value) &&
    isFinanceRecord(value.target) &&
    ['payment_update', 'schedule_confirmation', 'payment_operation'].includes(
      String(value.target.kind),
    ) &&
    isFinanceText(value.target.id) &&
    isFinanceText(value.label) &&
    isFinanceNullableMoney(value.amount, true) &&
    ['manual_platform', '1C'].includes(String(value.source)) &&
    typeof value.canCorrect === 'boolean' &&
    Object.hasOwn(value, 'blockedReason') &&
    isFinanceNullableText(value.blockedReason)
  );
}

function isFinanceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFinanceKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isFinanceText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFinanceNullableText(value: unknown): boolean {
  return value === null || isFinanceText(value);
}

function isFinanceTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isFinanceNullableTimestamp(value: unknown): boolean {
  return value === null || isFinanceTimestamp(value);
}

function isFinanceDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  );
}

function isCanonicalFinanceDate(value: unknown): value is string {
  return (
    isFinanceDate(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}

function isCanonicalFinanceTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isFinanceNullableDate(value: unknown): boolean {
  return value === null || isFinanceDate(value);
}

function isFinanceMoney(value: unknown, signed: boolean): value is string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(value)) return false;
  if (!signed && value.startsWith('-')) return false;
  return Number.isFinite(Number(value));
}

function isFinanceNullableMoney(value: unknown, signed: boolean): boolean {
  return value === null || isFinanceMoney(value, signed);
}

function isFinanceNullableInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  return (
    value === null || (Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max)
  );
}

function isFinanceNullableNumber(value: unknown, min: number, max: number) {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
  );
}

export const financeCoverageApi: {
  read(financeOrderId: string): Promise<FinanceWarehouseCoverageView>;
  refresh(
    financeOrderId: string,
    input: RefreshWarehouseCoverageDto,
  ): Promise<FinanceWarehouseCoverageView>;
  decide(
    financeOrderId: string,
    input: DecideWarehouseCoverageDto,
  ): Promise<FinanceWarehouseCoverageView>;
  requestRecheck(
    financeOrderId: string,
    input: RequestWarehouseCoverageRecheckDto,
  ): Promise<FinanceWarehouseCoverageWithCaseView>;
} = {
  async read(financeOrderId) {
    const response = await apiGet<unknown>(financeCoverageBasePath(financeOrderId));
    return normalizeFinanceWarehouseCoverage(response);
  },
  async refresh(financeOrderId, input) {
    const response = await apiPost<unknown>(financeCoveragePath(financeOrderId, 'refresh'), input);
    return normalizeFinanceWarehouseCoverage(response);
  },
  async decide(financeOrderId, input) {
    const response = await apiPost<unknown>(financeCoveragePath(financeOrderId, 'decide'), input);
    return normalizeFinanceWarehouseCoverage(response);
  },
  async requestRecheck(financeOrderId, input) {
    const response = await apiPost<unknown>(financeCoveragePath(financeOrderId, 'recheck'), input);
    return normalizeFinanceWarehouseCoverageWithCase(response);
  },
};

function financeCoverageBasePath(financeOrderId: string): string {
  return `/api/finance/orders/${encodeURIComponent(financeOrderId)}/warehouse-coverage`;
}

function financeCoveragePath(
  financeOrderId: string,
  action: 'refresh' | 'decide' | 'recheck',
): string {
  return `${financeCoverageBasePath(financeOrderId)}/${action}`;
}

export async function previewFinancePaymentPolicy(
  orderId: string,
  dto: { amount?: number; paymentPolicy: PaymentPolicyDraft },
): Promise<PaymentPolicyPreview> {
  const preview = parsePaymentPolicyPreviewResponse(
    await apiPost<unknown>(
      `/api/finance/orders/${encodeURIComponent(orderId)}/payment-policy/preview`,
      dto,
    ),
    dto.paymentPolicy,
  );
  return { rows: preview.rows.map(paymentPolicyPreviewRow) };
}

function parsePaymentPolicyPreviewResponse(
  value: unknown,
  policy: PaymentPolicyDraft,
): ServerPaymentPolicyPreview {
  const expectedStages = [...policy.stages].sort((left, right) => left.sequence - right.sequence);
  if (
    !isFinanceRecord(value) ||
    !hasExactFinanceKeys(value, ['rows']) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== expectedStages.length ||
    !value.rows.every((row, index) => isPaymentPolicyPreviewRow(row, expectedStages[index]))
  ) {
    throw new Error('Некорректный ответ предварительного графика оплаты.');
  }
  return value as ServerPaymentPolicyPreview;
}

function isPaymentPolicyPreviewRow(
  value: unknown,
  expected: PaymentPolicyStageDraft | undefined,
): value is ServerPaymentPolicyPreviewRow {
  if (!expected || !isFinanceRecord(value)) return false;
  const requiredKeys = [
    'sequence',
    'trigger',
    'percentageBasisPoints',
    'offsetDays',
    'amount',
    'date',
    'dateKind',
  ] as const;
  if (!hasExactFinanceKeys(value, requiredKeys, ['label'])) return false;
  const amountInKopecks =
    typeof value.amount === 'number' && Number.isFinite(value.amount)
      ? value.amount * 100
      : Number.NaN;
  const hasSafeAmount =
    typeof value.amount === 'number' &&
    value.amount >= 0 &&
    Number.isSafeInteger(Math.round(amountInKopecks)) &&
    Math.abs(amountInKopecks - Math.round(amountInKopecks)) < 1e-7;
  const hasCanonicalDateFact =
    (value.dateKind === 'condition' && value.date === null) ||
    (value.dateKind === 'actual' && isCanonicalFinanceDate(value.date));
  return (
    value.sequence === expected.sequence &&
    value.trigger === expected.trigger &&
    value.percentageBasisPoints === expected.percentageBasisPoints &&
    value.offsetDays === expected.offsetDays &&
    hasSafeAmount &&
    hasCanonicalDateFact &&
    (!Object.hasOwn(value, 'label') ||
      (typeof value.label === 'string' &&
        value.label.length <= 120 &&
        value.label === expected.label))
  );
}

function parseFinancePaymentCorrectionResponse(
  value: unknown,
  command: FinancePaymentCorrectionCommand,
): FinancePaymentCorrectionResult {
  const keys = [
    'commandId',
    'targetKind',
    'targetId',
    'reversalOperationId',
    'paymentStatus',
    'productionClearedAt',
  ] as const;
  if (
    !isFinanceRecord(value) ||
    !hasExactFinanceKeys(value, keys) ||
    !isFinanceText(value.commandId) ||
    value.commandId !== value.commandId.trim() ||
    value.targetKind !== command.target.kind ||
    value.targetId !== command.target.id ||
    !isFinanceText(value.targetId) ||
    (value.reversalOperationId !== null &&
      (!isFinanceText(value.reversalOperationId) ||
        value.reversalOperationId !== value.reversalOperationId.trim())) ||
    !FINANCE_PAYMENT_STATUSES.has(String(value.paymentStatus)) ||
    (value.productionClearedAt !== null && !isCanonicalFinanceTimestamp(value.productionClearedAt))
  ) {
    throw new Error('Некорректный ответ корректировки оплаты.');
  }
  return value as FinancePaymentCorrectionResult;
}

export async function setFinancePaymentPolicy(
  orderId: string,
  dto: { expectedRevision: number; reason?: string; paymentPolicy: PaymentPolicyDraft },
): Promise<WorkObject> {
  const order = parseFinanceOrderResponse(
    await apiPut<unknown>(`/api/finance/orders/${encodeURIComponent(orderId)}/payment-policy`, dto),
  );
  return serverFinanceOrderToWorkObject(order);
}

export async function updateFinancePayment(
  orderId: string,
  dto: {
    operationKey: string;
    paymentStatus: 'partial' | 'paid';
  },
): Promise<WorkObject> {
  const response = await apiPost<unknown>(
    `/api/finance/orders/${encodeURIComponent(orderId)}/payment-updates`,
    dto,
  );
  let order: ServerFinanceOrder;
  try {
    order = parseFinanceOrderResponse(response);
  } catch (error) {
    if (error instanceof ApiResponseParseError) throw error;
    throw new ApiResponseParseError(201, error);
  }
  return serverFinanceOrderToWorkObject(order);
}

export async function setFinancePaymentTerms(
  orderId: string,
  dto: { paymentTermsType: PaymentTermType; reason?: string },
): Promise<WorkObject> {
  const order = parseFinanceOrderResponse(
    await apiPut<unknown>(`/api/finance/orders/${encodeURIComponent(orderId)}/payment-terms`, dto),
  );
  return serverFinanceOrderToWorkObject(order);
}

export async function confirmFinancePaymentSchedule(
  orderId: string,
  scheduleId: string,
  operationKey: string,
): Promise<WorkObject> {
  const order = parseFinanceOrderResponse(
    await apiPost<unknown>(
      `/api/finance/orders/${encodeURIComponent(orderId)}/payment-schedules/${encodeURIComponent(scheduleId)}/confirm`,
      { operationKey },
    ),
  );
  return serverFinanceOrderToWorkObject(order);
}

export async function correctFinancePayment(
  orderId: string,
  command: FinancePaymentCorrectionCommand,
): Promise<FinancePaymentCorrectionResult> {
  const response = await apiPost<unknown>(
    `/api/finance/orders/${encodeURIComponent(orderId)}/payment-corrections`,
    command,
  );
  try {
    return parseFinancePaymentCorrectionResponse(response, command);
  } catch (error) {
    throw new ApiResponseParseError(201, error);
  }
}

export async function createFinancePaymentOperation(
  orderId: string,
  dto: {
    operationKey: string;
    operationType: 'invoice' | 'cash' | 'cash_to_non_cash' | 'manual_adjustment';
    amount: number;
  },
): Promise<WorkObject> {
  const response = await apiPost<unknown>(
    `/api/finance/orders/${encodeURIComponent(orderId)}/payment-operations`,
    dto,
  );
  let order: ServerFinanceOrder;
  try {
    order = parseFinanceOrderResponse(response);
  } catch (error) {
    if (error instanceof ApiResponseParseError) throw error;
    throw new ApiResponseParseError(201, error);
  }
  return serverFinanceOrderToWorkObject(order);
}

export async function recordFinancePayment(
  orderId: string,
  dto: {
    operationKey: string;
    operationType: 'cash' | 'cash_to_non_cash' | 'manual_adjustment';
    amount: number;
  },
): Promise<WorkObject> {
  let operationOrder: WorkObject;
  try {
    operationOrder = await createFinancePaymentOperation(orderId, dto);
  } catch (error) {
    if (error instanceof ApiResponseParseError) throw error;
    // The server can commit the fact before a later canonical projection fails. Preserve the
    // UUID whenever the composite caller cannot prove whether the first leg committed.
    throw new ApiResponseParseError(201, error);
  }
  const remainingValue = operationOrder.financePaymentSummary?.remainingAmount;
  const remaining =
    remainingValue === null || remainingValue === undefined ? Number.NaN : Number(remainingValue);
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new ApiResponseParseError(
      201,
      new Error('Payment operation response has no canonical remaining amount.'),
    );
  }
  try {
    return await updateFinancePayment(orderId, {
      operationKey: dto.operationKey,
      paymentStatus: remaining === 0 ? 'paid' : 'partial',
    });
  } catch (error) {
    if (error instanceof ApiResponseParseError) throw error;
    // The money fact is already committed. Treat every failure of the status leg as an
    // uncertain composite outcome so IdempotentOperationGate retains the exact UUID.
    throw new ApiResponseParseError(201, error);
  }
}

export async function createFinanceInvoice(
  orderId: string,
  dto: {
    amount: number;
    paymentPolicy: PaymentPolicyDraft;
  },
): Promise<WorkObject> {
  const order = parseFinanceOrderResponse(
    await apiPost<unknown>(`/api/finance/orders/${encodeURIComponent(orderId)}/invoices`, dto),
  );
  return serverFinanceOrderToWorkObject(order);
}

export async function retryFinanceSource(
  orderId: string,
  operationKey = crypto.randomUUID(),
): Promise<WorkObject> {
  await refreshOneCInvoice(orderId, operationKey);
  const order = parseFinanceOrderResponse(
    await apiGet<unknown>(`/api/finance/orders/${encodeURIComponent(orderId)}`),
  );
  return serverFinanceOrderToWorkObject(order);
}

export async function createFinanceProblem(
  orderId: string,
  dto: { reason: string; kind?: 'sync' | 'overdue' | 'other'; evidence?: string },
): Promise<void> {
  await apiPost(`/api/finance/orders/${encodeURIComponent(orderId)}/problems`, dto);
}

function moneyNumber(value: number | string | null | undefined): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function safeFinanceInvoice(invoice?: ServerFinanceInvoice | null): FinanceInvoiceView | undefined {
  if (!invoice) return undefined;
  return {
    externalId: invoice.externalId,
    sourceVersion: invoice.sourceVersion,
    sourceKind: invoice.sourceKind,
    staleness: invoice.staleness,
    capturedAt: invoice.capturedAt,
    importedAt: invoice.importedAt,
    checkedAt: invoice.checkedAt,
    invoiceNumber: invoice.invoiceNumber,
    date: invoice.date,
    amount: null,
    subtotal: null,
    taxTotal: null,
    currency: invoice.currency,
    posted: invoice.posted,
    counterpartyExternalId: invoice.counterpartyExternalId,
    organizationExternalId: invoice.organizationExternalId,
    lines: [],
  };
}

function safePaymentTimelineEntry(
  entry: ServerFinancePaymentTimelineEntry,
): FinancePaymentTimelineEntry {
  return {
    id: entry.id,
    receiptId: entry.receiptId,
    receiptExternalId: entry.receiptExternalId,
    receiptNumber: entry.receiptNumber,
    receivedAt: entry.receivedAt,
    receiptAmount: entry.receiptAmount,
    currency: entry.currency,
    sourceStatus: entry.sourceStatus,
    scheduleId: entry.scheduleId,
    amount: entry.amount,
    status: entry.status,
    matchKind: entry.matchKind,
    reversesId: entry.reversesId,
    createdAt: entry.createdAt,
  };
}

function safePaymentSummary(summary: ServerFinancePaymentSummary): FinancePaymentSummary {
  return {
    invoiceAmount: summary.invoiceAmount,
    paidAmount: summary.paidAmount,
    remainingAmount: summary.remainingAmount,
    overpaidAmount: summary.overpaidAmount,
  };
}

function serverFinanceOrderToWorkObject(order: ServerFinanceOrder): WorkObject {
  const commercial = order.commercialOrder;
  const warehouseCoverageWorkflowVersion = requireWarehouseCoverageWorkflowVersion(
    commercial.warehouseCoverageWorkflowVersion,
  );
  const counterparty = counterpartyLabel(commercial.counterparty);
  const statusLabel = financeStatusLabel(order);
  const invoiceAmount = moneyNumber(order.amountValue);
  const hasInvoiceAmount = invoiceAmount > 0;
  const amountLabel = hasInvoiceAmount
    ? order.amountLabel || amountValueLabel(invoiceAmount)
    : 'не указана — оформите счёт вручную';
  const paidAmount = financePaidAmount(order);
  const remainingAmount = financeRemainingAmount(order, paidAmount);
  const nextSchedule = nextOpenSchedule(order.schedules);
  const paidLabel = amountValueLabel(paidAmount);
  const remainingLabel = hasInvoiceAmount
    ? amountValueLabel(remainingAmount)
    : 'появится после ручного оформления счёта';
  const severity = financeSeverity(order);
  const invoice = safeFinanceInvoice(order.invoice);
  const paymentSummary = safePaymentSummary(order.paymentSummary);
  const paymentTimeline = order.paymentTimeline.map(safePaymentTimelineEntry);

  return {
    id: order.id,
    kind: 'financeOrder',
    warehouseCoverageWorkflowVersion,
    title: `Финансы ${commercial.orderNumber}`,
    statusLabel,
    nextOwner: 'Бухгалтерия',
    severity,
    filterTags: financeTags(order, statusLabel),
    facts: [
      { label: 'Номер', value: commercial.orderNumber, scope: 'finance' },
      {
        label: 'Номер счета',
        value:
          order.invoiceNumber ??
          invoice?.invoiceNumber ??
          (order.invoiceStatus === 'invoiced' ? 'Счёт без номера' : 'Счёт не выставлен'),
        scope: 'sensitiveFinance',
      },
      {
        label: 'Дата выставления',
        value: order.invoiceIssuedAt
          ? new Date(order.invoiceIssuedAt).toLocaleDateString('ru-RU', {
              timeZone: 'Europe/Moscow',
            })
          : 'Не выставлен',
        scope: 'sensitiveFinance',
      },
      { label: 'Контрагент', value: counterparty, scope: 'legal' },
      { label: 'Заказ-наряд', value: 'Согласован', scope: 'finance' },
      {
        label: 'Статус счета',
        value: invoiceStatusLabel(order.invoiceStatus),
        scope: 'sensitiveFinance',
      },
      {
        label: 'Статус оплаты',
        value: paymentStatusLabel(order.paymentStatus),
        scope: 'sensitiveFinance',
      },
      { label: 'Сумма', value: amountLabel, scope: 'sensitiveFinance' },
      { label: 'Оплачено', value: paidLabel, scope: 'sensitiveFinance' },
      { label: 'Остаток', value: remainingLabel, scope: 'sensitiveFinance' },
      {
        label: 'Следующий платеж',
        value: nextPaymentLabel(nextSchedule),
        scope: 'sensitiveFinance',
      },
      {
        label: 'Дата отгрузки',
        value: financeShipmentLabel(commercial),
        scope: 'sensitiveFinance',
      },
      { label: 'Вид оплаты', value: 'ручная проверка', scope: 'sensitiveFinance' },
      { label: 'Рассрочка', value: installmentLabel(order), scope: 'sensitiveFinance' },
      {
        label: 'График',
        value: scheduleLabel(order.schedules),
        scope: 'sensitiveFinance',
      },
      ...(commercial.commercialFinanceNote
        ? [
            {
              label: 'Комментарий коммерции',
              value: commercial.commercialFinanceNote,
              scope: 'finance' as const,
            },
          ]
        : []),
      ...(commercial.comment
        ? [
            {
              label: 'Комментарий заказа',
              value: commercial.comment,
              scope: 'finance' as const,
            },
          ]
        : []),
    ],
    sections: [
      {
        id: 'finance-live-summary',
        title: 'Сводка заказа',
        facts: [
          { label: 'Сумма к счету', value: amountLabel, scope: 'sensitiveFinance' },
          { label: 'Остаток', value: remainingLabel, scope: 'sensitiveFinance' },
          { label: 'Статус после действия', value: statusLabel, scope: 'finance' },
        ],
      },
    ],
    actions: financeActions(order),
    financeAmountValue: invoiceAmount,
    financeCreatedAt: order.createdAt,
    commercialFinanceNote: commercial.commercialFinanceNote ?? null,
    oneCInvoiceSyncState: order.invoiceSyncState,
    ...(invoice ? { oneCInvoice: invoice } : {}),
    financePaymentSummary: paymentSummary,
    financePaymentTimeline: paymentTimeline,
    financeBusinessPayment: {
      businessDate: order.businessPayment.businessDate,
      status: order.businessPayment.status,
      isOverdue: order.businessPayment.isOverdue,
      paidAmount: order.businessPayment.paidAmount,
      remainingAmount: order.businessPayment.remainingAmount,
      overdueAmount: order.businessPayment.overdueAmount,
    },
    financePaymentCorrections: order.paymentCorrections,
    financePaymentStatus: paymentStatus(order.paymentStatus),
    correctablePayments: order.correctablePayments,
    paymentPolicy: paymentPolicyView(order.paymentPolicy),
    paymentTermsType: order.paymentTermsType ?? undefined,
    paymentSchedules: order.schedules.map(paymentScheduleEntry),
    paymentOperations: order.operations.map(paymentOperationEntry),
    problems:
      order.sourceStatus === 'error'
        ? [
            {
              id: `${order.id}-source`,
              objectId: order.id,
              stage: 'Источник данных',
              title: 'Поступление не подтверждено',
              severity: 'warning',
              ownerRole: 'Бухгалтерия',
              due: 'до оплаты',
              reason: 'Платформа не получила подтверждение поступления',
              recovery: 'Обновить счёт или обратиться к администратору интеграции',
              status: 'open',
            },
          ]
        : [],
    audit: [],
    commercialOrder: commercialOrderForFinance(order),
  };
}

function paymentStatus(value: string): FinancePaymentCorrectionCommand['expectedPaymentStatus'] {
  if (
    value === 'unpaid' ||
    value === 'partial' ||
    value === 'paid' ||
    value === 'overdue' ||
    value === 'sync_error'
  ) {
    return value;
  }
  throw new TypeError(`Invalid finance payment status: ${value}`);
}

function requireWarehouseCoverageWorkflowVersion(value: unknown): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new TypeError('Invalid commercialOrder.warehouseCoverageWorkflowVersion: expected 1 or 2');
}

function paymentScheduleEntry(
  schedule: ServerPaymentSchedule,
): NonNullable<WorkObject['paymentSchedules']>[number] {
  const startsAtIso = schedule.startsAt?.slice(0, 10) || undefined;
  const dueDateIso = schedule.dueDate?.slice(0, 10) || undefined;
  const dateKind =
    schedule.dateKind === 'actual' ||
    schedule.dateKind === 'condition' ||
    schedule.dateKind === 'unavailable'
      ? schedule.dateKind
      : dueDateIso
        ? 'actual'
        : schedule.trigger === 'full_shipment'
          ? 'condition'
          : 'unavailable';
  const conditionLabel =
    dateKind === 'condition' &&
    schedule.trigger === 'full_shipment' &&
    Number.isSafeInteger(schedule.offsetDays)
      ? paymentStageConditionLabel('full_shipment', schedule.offsetDays!)
      : undefined;
  return {
    id: schedule.id,
    kind:
      schedule.kind === 'invoice_prepayment' || schedule.kind === 'post_delivery'
        ? schedule.kind
        : undefined,
    amountValue: moneyNumber(schedule.amount),
    sequence: schedule.sequence ?? undefined,
    trigger: schedule.trigger ?? undefined,
    percentageBasisPoints: schedule.percentageBasisPoints ?? undefined,
    offsetDays: schedule.offsetDays ?? undefined,
    startsAtIso,
    dueDateIso,
    dateKind,
    dueDateLabel: dueDateIso
      ? new Date(dueDateIso).toLocaleDateString('ru-RU')
      : (conditionLabel ?? 'дата не задана'),
    amountLabel: amountValueLabel(moneyNumber(schedule.amount)),
    paidAmountLabel: amountValueLabel(moneyNumber(schedule.paidAmount)),
    remainingAmountLabel: amountValueLabel(moneyNumber(schedule.remainingAmount)),
    isOverdue: schedule.isOverdue,
    status: paymentScheduleStatus(schedule.status),
    source: schedule.source ?? undefined,
  };
}

type ServerFinanceHistoryEntry = {
  id: string;
  occurredAt: string;
  actor: string;
  actorRole: string;
  action: string;
  field: string | null;
  previousValue: string | null;
  currentValue: string | null;
  reason: string | null;
};

const MOSCOW_HISTORY_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  dateStyle: 'short',
  timeStyle: 'short',
});

function isFinanceHistoryEntry(value: unknown): value is ServerFinanceHistoryEntry {
  return (
    isFinanceRecord(value) &&
    isFinanceText(value.id) &&
    isFinanceTimestamp(value.occurredAt) &&
    isFinanceText(value.actor) &&
    isFinanceText(value.actorRole) &&
    isFinanceText(value.action) &&
    !String(value.action).includes(':') &&
    !/[a-z]+_[a-z]+/u.test(String(value.action)) &&
    isFinanceNullableText(value.field) &&
    isFinanceNullableText(value.previousValue) &&
    isFinanceNullableText(value.currentValue) &&
    isFinanceNullableText(value.reason)
  );
}

export function fetchFinanceOrderHistory(financeOrderId: string, options?: ApiRequestOptions) {
  return apiGet<unknown>(
    `/api/finance/orders/${encodeURIComponent(financeOrderId)}/audit`,
    options,
  ).then((value) => {
    if (!Array.isArray(value) || !value.every(isFinanceHistoryEntry)) {
      throw new Error('Некорректный ответ истории счёта.');
    }
    return value.map((entry) => ({
      id: entry.id,
      objectId: financeOrderId,
      time: MOSCOW_HISTORY_TIME.format(new Date(entry.occurredAt)),
      actorLabel: `${entry.actor} · ${entry.actorRole}`,
      actionLabel: entry.action,
      detail: entry.field ?? 'Изменение без доступных деталей',
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.previousValue !== null ? { oldValue: entry.previousValue } : {}),
      ...(entry.currentValue !== null ? { newValue: entry.currentValue } : {}),
      scope: 'finance' as const,
    }));
  });
}

function paymentPolicyView(policy?: ServerPaymentPolicy | null): PaymentPolicyView | undefined {
  if (!policy) return undefined;
  return {
    id: policy.id,
    installmentDays: policy.installmentDays,
    capturedProductionLeadDays: policy.capturedProductionLeadDays,
    revision: policy.revision,
    invoiceExternalId: policy.invoiceExternalId ?? null,
    invoiceSourceVersion: policy.invoiceSourceVersion ?? null,
    capturedInvoiceAmount: policy.capturedInvoiceAmount ?? null,
    capturedInvoiceCurrency: policy.capturedInvoiceCurrency ?? null,
    stages: policy.stages.map((stage) => ({
      sequence: stage.sequence,
      trigger: stage.trigger,
      percentageBasisPoints: stage.percentageBasisPoints,
      offsetDays: stage.offsetDays,
      ...(stage.label == null ? {} : { label: stage.label }),
    })),
  };
}

function paymentPolicyPreviewRow(row: ServerPaymentPolicyPreviewRow): PaymentPolicyPreviewRow {
  return {
    sequence: row.sequence,
    trigger: row.trigger,
    percentageBasisPoints: row.percentageBasisPoints,
    offsetDays: row.offsetDays,
    ...(row.label === undefined ? {} : { label: row.label }),
    amount: row.amount,
    date: row.date,
    dateKind: row.dateKind,
  };
}

function paymentScheduleStatus(
  value: string,
): NonNullable<WorkObject['paymentSchedules']>[number]['status'] {
  if (value === 'paid') return 'paid';
  if (value === 'overdue') return 'overdue';
  if (value === 'due_today') return 'due_today';
  return 'scheduled';
}

const paymentOperationLabels: Record<string, string> = {
  invoice: 'Оплата по счету',
  cash: 'Наличная операция',
  cash_to_non_cash: 'Перевод нал → безнал',
  manual_adjustment: 'Разнесение выплаты вручную',
  manual_payment: 'Оплата отмечена вручную',
};

function paymentOperationEntry(
  operation: ServerPaymentOperation,
): NonNullable<WorkObject['paymentOperations']>[number] {
  return {
    id: operation.id,
    ...(operation.paymentAllocationId ? { allocationId: operation.paymentAllocationId } : {}),
    label: paymentOperationLabels[operation.operationType] ?? operation.operationType,
    amountLabel: amountValueLabel(moneyNumber(operation.amount)),
    dateLabel: operation.createdAt
      ? new Date(operation.createdAt).toLocaleDateString('ru-RU')
      : undefined,
    source: financePaymentSourceLabel(operation.source),
  };
}

function financeActions(order: ServerFinanceOrder): WorkObject['actions'] {
  const diagnosticActions =
    order.sourceStatus === 'error' || order.paymentStatus === 'overdue'
      ? [
          {
            id: `finance-create-problem:${order.id}`,
            label: 'Создать проблему директору',
            level: 'destructive' as const,
            enabled: true,
          },
        ]
      : [];

  if (order.paymentStatus === 'paid') {
    return [
      {
        id: `finance-view-payments:${order.id}`,
        label: 'Показать выплаты',
        level: 'recommended',
        enabled: true,
      },
      ...diagnosticActions,
    ];
  }

  if (order.invoiceStatus === 'not_invoiced') {
    return [
      {
        id: `finance-create-invoice:${order.id}`,
        label: 'Выставить счёт',
        level: 'recommended',
        enabled: true,
        helpText: 'Укажите сумму счёта и условия оплаты вручную.',
      },
      ...diagnosticActions,
    ];
  }

  const schedules = order.schedules ?? [];
  const confirmableSchedule = schedules.find(
    (schedule) => schedule.status !== 'paid' && Boolean(schedule.dueDate),
  );
  const termsCanChange = schedules.every((schedule) => schedule.status !== 'paid');

  return [
    ...(confirmableSchedule
      ? [
          {
            id: `finance-confirm-schedule:${confirmableSchedule.id}`,
            label: 'Проверить поступление',
            level: 'recommended' as const,
            enabled: true,
            helpText: 'Подтвердить поступление только по выбранной выплате.',
          },
        ]
      : [
          {
            id: `finance-wait-delivery:${order.id}`,
            label: 'Ожидается полная выдача',
            level: 'disabled' as const,
            enabled: false,
            disabledReason: 'Дата выплаты появится через 30 дней после полной выдачи со склада.',
          },
        ]),
    {
      id: `finance-update-payment:${order.id}`,
      label: 'Обновить оплату вручную',
      level: 'secondary',
      enabled: true,
    },
    {
      id: `finance-payment-terms:${order.id}`,
      label: 'Изменить условия оплаты',
      level: 'secondary',
      enabled: termsCanChange && moneyNumber(order.amountValue) > 0,
      helpText: 'Выбрать быстрый вариант или настроить собственный график.',
    },
    ...diagnosticActions,
  ];
}

function financeStatusLabel(order: ServerFinanceOrder) {
  if (order.invoiceSyncState === 'draft_found') return 'Черновик счета найден';
  if (order.invoiceSyncState === 'ambiguous') return 'Нужно выбрать счет';
  if (order.invoiceStatus === 'not_invoiced') return 'Ждет счет';
  if (order.paymentStatus === 'paid') return 'Оплачено';
  if (order.paymentStatus === 'partial') return 'Частично оплачен';
  if (order.paymentStatus === 'overdue') return 'Просрочка';
  return 'Ожидает оплаты';
}

function financeSeverity(order: ServerFinanceOrder): Severity {
  if (
    order.sourceStatus === 'error' ||
    order.invoiceSyncState === 'error' ||
    order.paymentStatus === 'overdue'
  )
    return 'critical';
  if (
    order.sourceStatus !== 'ready' ||
    order.invoiceSyncState === 'ambiguous' ||
    order.invoiceSyncState === 'stale' ||
    order.paymentStatus === 'partial'
  )
    return 'warning';
  return 'info';
}

function financeTags(order: ServerFinanceOrder, statusLabel: string) {
  const tags = [statusLabel, 'Счета', 'Требуют действия'];
  if (order.paymentPolicy || order.schedules.length > 0) tags.push('Рассрочка');
  if (order.businessPayment.isOverdue) tags.push('Просрочки');
  return tags;
}

function invoiceStatusLabel(value: string) {
  if (value === 'invoiced') return 'Счет выставлен';
  if (value === 'issued') return 'Счет выставлен';
  if (value === 'sent') return 'Счет отправлен';
  if (value === 'source_error') return 'Источник не подтвердил';
  return 'Не выставлен';
}

function paymentStatusLabel(value: string) {
  if (value === 'paid') return 'Оплачено';
  if (value === 'partial') return 'Частично оплачен';
  if (value === 'overdue') return 'Просрочка оплаты';
  if (value === 'unpaid') return 'Ожидает оплаты';
  return 'Не ожидается до счета';
}

function amountValueLabel(value: number) {
  if (!value) return '0 ₽';
  return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
}

function financePaidAmount(order: ServerFinanceOrder) {
  return moneyNumber(order.paymentSummary.paidAmount);
}

function financeRemainingAmount(order: ServerFinanceOrder, _paidAmount: number) {
  return order.paymentSummary.remainingAmount === null
    ? 0
    : moneyNumber(order.paymentSummary.remainingAmount);
}

function nextOpenSchedule(schedules: ServerPaymentSchedule[]) {
  return schedules
    .filter((schedule) => schedule.status !== 'paid')
    .sort(
      (a, b) =>
        dateSortValue(a.dueDate) - dateSortValue(b.dueDate) ||
        (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER),
    )[0];
}

function dateSortValue(value?: string | null) {
  return value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
}

function nextPaymentLabel(schedule: ServerPaymentSchedule | undefined) {
  if (!schedule) return 'нет данных';
  const dateLabel = schedule.dueDate
    ? new Date(schedule.dueDate).toLocaleDateString('ru-RU')
    : schedule.trigger === 'full_shipment' && Number.isSafeInteger(schedule.offsetDays)
      ? paymentStageConditionLabel('full_shipment', schedule.offsetDays!)
      : 'дата не задана';
  return `${amountValueLabel(moneyNumber(schedule.amount))} · ${dateLabel}`;
}

function installmentLabel(order: ServerFinanceOrder) {
  if (!order.schedules?.length)
    return order.paymentStatus === 'partial' ? 'остаток открыт' : 'не началась';
  if (order.paymentStatus === 'paid') return 'закрыта';
  return 'активна';
}

function scheduleLabel(schedules: ServerPaymentSchedule[]) {
  if (!schedules.length) return 'нет данных';
  const openCount = schedules.filter((schedule) => schedule.status !== 'paid').length;
  return openCount ? `${openCount} открыто из ${schedules.length}` : `${schedules.length} закрыто`;
}

function commercialOrderForFinance(order: ServerFinanceOrder): CommercialOrderRequest {
  const commercial = order.commercialOrder;
  const createdBy =
    commercial.creatorRole === 'production_lead' ? 'Зав. производства' : 'Коммерция';
  return {
    id: commercial.id,
    createdBy,
    creatorRole: commercial.creatorRole,
    counterpartyId: commercial.counterpartyId,
    billingSnapshot: {
      id: `${commercial.id}-billing`,
      counterpartyId: commercial.counterpartyId,
      label: counterpartyLabel(commercial.counterparty),
      type: 'legal_entity',
      inn: commercial.counterparty.inn ?? undefined,
      source:
        commercial.counterparty.billingSource === 'manual_platform'
          ? 'manual_order_entry'
          : 'counterparty_card_snapshot',
      syncStatus:
        commercial.counterparty.syncStatus === 'ready' ? 'mock_snapshot' : 'needs_1C_discovery',
      createdBy: 'Система',
      createdAt: commercial.createdAt,
    },
    requestType:
      commercial.requestType === 'stock_reserve' ? 'на склад/резерв' : 'клиентский заказ',
    status: 'in_work',
    productionStatus:
      commercial.productionIndicator === 'in_production' ? 'in_production' : 'needs_production',
    warehouseCoverStatus:
      commercial.warehouseCoverStatus === 'needs_production' ? 'needs_production' : 'not_checked',
    paymentStatus: commercialPaymentStatus(commercial.paymentStatus),
    shipmentStatus: commercial.shipmentStatus === 'shipped' ? 'отгружено' : 'не отгружено',
    createdAt: commercial.createdAt,
    submittedAt: commercial.createdAt,
    positions: (commercial.positions ?? []).map((position) => ({
      id: position.id,
      draftId: commercial.id,
      rollCount: position.rollCount,
      filmType: position.filmType,
      actualThickness: position.actualThickness,
      accountingThickness: position.accountingThickness,
      plannedWeightKg: position.plannedWeightKg ?? undefined,
      widthMm: position.widthMm ?? undefined,
      plannedLengthM: position.plannedLengthM ?? undefined,
      rawMaterialLabel: 'Не указано',
      spoolType: position.spoolType ?? 'Не указана',
      birka: position.birka ?? 'Не указана',
      recipeSnapshot: {
        id: `${position.id}-finance`,
        positionId: position.id,
        recipeOwnerRole: 'commercial',
        parameters: [],
        source:
          commercial.creatorRole === 'production_lead' ? 'production_lead_form' : 'commercial_form',
        createdBy,
        createdAt: commercial.createdAt,
        version: 'v1',
      },
      warehouseCoverStatus:
        commercial.warehouseCoverStatus === 'needs_production' ? 'needs_production' : 'not_checked',
    })),
  };
}

function financeShipmentLabel(commercial: ServerFinanceCommercialOrder): string {
  if (commercial.shipmentStatus !== 'shipped') return 'Не отгружено';
  const date = commercial.shipmentCompletedAt?.slice(0, 10);
  return date ? `Отгружено · ${date}` : 'Отгружено';
}

function counterpartyLabel(counterparty: ServerCounterparty) {
  return counterparty.displayName || counterparty.legalName || counterparty.id;
}

function commercialPaymentStatus(value: string): CommercialOrderRequest['paymentStatus'] {
  if (value === 'paid') return 'оплачен';
  if (value === 'partial') return 'частично оплачен';
  if (value === 'overdue') return 'просрочка';
  return 'не оплачен';
}
