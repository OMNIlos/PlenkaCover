import { apiGet, apiPost, type ApiRequestOptions } from './client';
import { auditEntry } from '../domain/prototypeRuntime';
import type { ActionDescriptor, Fact, WorkObject } from '../domain/types';
import type {
  DirectorDashboardProjection,
  DirectorDefectBagRegister,
  DirectorDefectBagStatus,
} from '../domain/runtime/types';
import type { WarehouseBusinessPage, WarehouseBusinessQuery } from './commercialPerformance';
import {
  parseDirectorAnalyticsResponse,
  parseDirectorBigBagEvidencePage,
  parseDirectorOperatorRollVariancePage,
  parseDirectorShiftBalancePage,
} from './directorAnalyticsValidation';
import { parseWarehouseBusinessPage } from './warehouseBusinessValidation';
import type {
  ServerDirectorPayrollTariffRule,
  ServerDirectorPayrollUnresolvedReason,
} from './directorPayroll';
import type { ServerPayrollTariffOrderReference } from './payrollTariffOrders';
import type { ServerProductionProblem } from './production';
import { DEFECT_BAG_TYPES, isDefectBagType } from '../domain/defectBagLabels';

export { parseDirectorAnalyticsResponse } from './directorAnalyticsValidation';

export { fetchDirectorPayrollPreview } from './directorPayroll';
export type {
  DirectorPayrollQuery,
  ServerDirectorPayrollBreakdownRow,
  ServerDirectorPayrollMachineFamily,
  ServerDirectorPayrollMaterialClass,
  ServerDirectorPayrollOperatorSummary,
  ServerDirectorPayrollPreview,
  ServerDirectorPayrollPreviewStatus,
  ServerDirectorPayrollShiftDuration,
  ServerDirectorPayrollTariffRule,
  ServerDirectorPayrollUnresolvedFact,
  ServerDirectorPayrollUnresolvedReason,
} from './directorPayroll';
export type {
  WarehouseBusinessPage,
  WarehouseBusinessQuery,
  WarehouseBusinessRow,
  WarehouseBusinessStatus,
  WarehouseBusinessTemplate,
} from './commercialPerformance';

export async function fetchDirectorWarehouseBusiness(
  query: WarehouseBusinessQuery = {},
  options?: ApiRequestOptions,
): Promise<WarehouseBusinessPage> {
  const params = new URLSearchParams({
    page: String(query.page ?? 1),
    pageSize: String(query.pageSize ?? 50),
  });
  const response = await apiGet<unknown>(
    `/api/director/performance/warehouse?${params.toString()}`,
    options,
  );
  return parseWarehouseBusinessPage(response);
}

// Серверные контракты роли директора (apps/api DirectorController/DirectorService).
// Директор = надзиратель: видит все контуры, мутирует только аудируемыми override +
// одобрением решений + штрафами (ТЗ §4, §5.6).

export type ServerDirectorControl = {
  pendingDecisions: number;
  penalties: number;
  overdueOrders: number;
  penaltiesAmount: number;
  plannedInvoicedAmount: number;
  paidAmount: number;
  unbilledAmount: number;
  overdueAmount: number;
  producedKg: number;
  defectKg: number;
  warehouseAcceptedRolls: number;
  defectBags?: DirectorDefectBagRegister | null;
};

const DIRECTOR_DEFECT_BAG_STATUSES = [
  'weighed',
  'ready_for_warehouse',
  'received',
  'shipped',
] as const satisfies readonly DirectorDefectBagStatus[];

const DIRECTOR_CONTROL_COUNT_KEYS = [
  'pendingDecisions',
  'penalties',
  'overdueOrders',
  'warehouseAcceptedRolls',
] as const;
const DIRECTOR_CONTROL_VALUE_KEYS = [
  'penaltiesAmount',
  'plannedInvoicedAmount',
  'paidAmount',
  'unbilledAmount',
  'overdueAmount',
  'producedKg',
  'defectKg',
] as const;

function isDirectorControlCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDirectorControlWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isDirectorDefectBagStatus(value: unknown): value is DirectorDefectBagStatus {
  return (
    typeof value === 'string' && DIRECTOR_DEFECT_BAG_STATUSES.includes(value as never)
  );
}

function isNullableResponseTimestamp(value: unknown): value is string | null {
  return value === null || isResponseTimestamp(value);
}

function isNullableResponseName(value: unknown): value is string | null {
  return value === null || isResponseString(value);
}

function parseDirectorDefectBags(value: unknown): DirectorDefectBagRegister {
  if (
    !isResponseRecord(value) ||
    !isDirectorControlCount(value.totalCount) ||
    !isDirectorControlWeight(value.totalWeightKg) ||
    !Array.isArray(value.byStatus) ||
    value.byStatus.length !== DIRECTOR_DEFECT_BAG_STATUSES.length ||
    !Array.isArray(value.byType) ||
    value.byType.length !== DEFECT_BAG_TYPES.length ||
    !isResponseRecord(value.unclassified) ||
    !isDirectorControlCount(value.unclassified.count) ||
    !isDirectorControlWeight(value.unclassified.weightKg) ||
    !Array.isArray(value.recent) ||
    value.recent.length > 100 ||
    typeof value.hasMore !== 'boolean'
  ) {
    throw new Error('Некорректные данные панели контроля директора.');
  }

  const byStatus = value.byStatus.map((item) => {
    if (
      !isResponseRecord(item) ||
      !isDirectorDefectBagStatus(item.status) ||
      !isDirectorControlCount(item.count) ||
      !isDirectorControlWeight(item.weightKg)
    ) {
      throw new Error('Некорректные данные панели контроля директора.');
    }
    return { status: item.status, count: item.count, weightKg: item.weightKg };
  });
  if (
    new Set(byStatus.map(({ status }) => status)).size !== DIRECTOR_DEFECT_BAG_STATUSES.length
  ) {
    throw new Error('Некорректные данные панели контроля директора.');
  }

  const byType = value.byType.map((item) => {
    if (
      !isResponseRecord(item) ||
      !isDefectBagType(item.defectType) ||
      !isDirectorControlCount(item.count) ||
      !isDirectorControlWeight(item.weightKg)
    ) {
      throw new Error('Некорректные данные панели контроля директора.');
    }
    return { defectType: item.defectType, count: item.count, weightKg: item.weightKg };
  });
  if (new Set(byType.map(({ defectType }) => defectType)).size !== DEFECT_BAG_TYPES.length) {
    throw new Error('Некорректные данные панели контроля директора.');
  }

  const recent = value.recent.map((item) => {
    if (
      !isResponseRecord(item) ||
      !isResponseString(item.id) ||
      !isResponseString(item.code) ||
      !isDirectorDefectBagStatus(item.status) ||
      (item.defectType !== null && !isDefectBagType(item.defectType)) ||
      !isDirectorControlWeight(item.weightKg) ||
      !isDirectorControlWeight(item.recordedDefectKg) ||
      typeof item.differenceKg !== 'number' ||
      !Number.isFinite(item.differenceKg) ||
      !isResponseString(item.operatorName) ||
      !isResponseString(item.postCode) ||
      !isResponseString(item.postName) ||
      !isNullableResponseName(item.shiftLabel) ||
      !isResponseTimestamp(item.weighedAt) ||
      !isNullableResponseTimestamp(item.receivedAt) ||
      !isNullableResponseName(item.receivedBy) ||
      !isNullableResponseTimestamp(item.shippedAt) ||
      !isNullableResponseName(item.shippedBy)
    ) {
      throw new Error('Некорректные данные панели контроля директора.');
    }
    return {
      id: item.id,
      code: item.code,
      status: item.status,
      defectType: item.defectType,
      weightKg: item.weightKg,
      recordedDefectKg: item.recordedDefectKg,
      differenceKg: item.differenceKg,
      operatorName: item.operatorName,
      postCode: item.postCode,
      postName: item.postName,
      shiftLabel: item.shiftLabel,
      weighedAt: item.weighedAt,
      receivedAt: item.receivedAt,
      receivedBy: item.receivedBy,
      shippedAt: item.shippedAt,
      shippedBy: item.shippedBy,
    };
  });

  return {
    totalCount: value.totalCount,
    totalWeightKg: value.totalWeightKg,
    byStatus,
    byType,
    unclassified: {
      count: value.unclassified.count,
      weightKg: value.unclassified.weightKg,
    },
    recent,
    hasMore: value.hasMore,
  };
}

function parseDirectorControl(value: unknown): ServerDirectorControl {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Некорректные данные панели контроля директора.');
  }
  const source = value as Record<string, unknown>;
  const countsAreValid = DIRECTOR_CONTROL_COUNT_KEYS.every(
    (key) =>
      Object.hasOwn(source, key) &&
      typeof source[key] === 'number' &&
      Number.isSafeInteger(source[key]) &&
      source[key] >= 0,
  );
  const valuesAreValid = DIRECTOR_CONTROL_VALUE_KEYS.every(
    (key) =>
      Object.hasOwn(source, key) && typeof source[key] === 'number' && Number.isFinite(source[key]),
  );
  if (!countsAreValid || !valuesAreValid) {
    throw new Error('Некорректные данные панели контроля директора.');
  }
  const defectBags = Object.hasOwn(source, 'defectBags')
    ? source.defectBags === null
      ? null
      : parseDirectorDefectBags(source.defectBags)
    : null;
  return {
    pendingDecisions: source.pendingDecisions as number,
    penalties: source.penalties as number,
    overdueOrders: source.overdueOrders as number,
    penaltiesAmount: source.penaltiesAmount as number,
    plannedInvoicedAmount: source.plannedInvoicedAmount as number,
    paidAmount: source.paidAmount as number,
    unbilledAmount: source.unbilledAmount as number,
    overdueAmount: source.overdueAmount as number,
    producedKg: source.producedKg as number,
    defectKg: source.defectKg as number,
    warehouseAcceptedRolls: source.warehouseAcceptedRolls as number,
    defectBags,
  };
}

export type ServerDirectorDecision = {
  id: string;
  scope: 'finance' | 'production' | 'warehouse';
  objectId: string | null;
  evidence: string | null;
  ownerRole: string;
  status: 'pending' | 'approved' | 'returned';
  severity: 'info' | 'warning' | 'critical';
  createdAt: string;
  updatedAt: string;
};

export type ServerDirectorPenaltySummary = {
  total: number;
  byRole: Array<{ targetRole: string; count: number; totalAmount: number }>;
};

export type ServerDirectorPenalty = {
  id: string;
  targetRole: string;
  amount: number;
  reason: string;
  employeeId?: string | null;
  sourceObjectId?: string | null;
  authorRole: string;
  createdAt: string;
};

export type ServerDirectorPenaltyTarget = {
  id: string;
  displayName: string;
  role: 'operator' | 'production_lead';
  isActive: boolean;
};

export type ServerDirectorAuditEvent = {
  id: string;
  type: string;
  family: string;
  objectId?: string | null;
  actorRole: string;
  label?: string | null;
  reason?: string | null;
  createdAt: string;
};

export type DirectorOverrideInput = {
  reason: string;
  evidence: string;
  value?: string;
};

export const TRACEABILITY_OBJECT_TYPES = [
  'order',
  'position',
  'roll',
  'big_bag',
  'pallet',
  'warehouse_task',
  'warehouse_operation',
] as const;
export type TraceabilityObjectType = (typeof TRACEABILITY_OBJECT_TYPES)[number];

export type TraceabilitySearchItem = {
  objectType: TraceabilityObjectType;
  objectId: string;
  displayName: string;
  secondaryLabel: string | null;
  matchKind: 'exact' | 'prefix' | 'contains';
};

export type TraceabilitySearchPage = {
  items: TraceabilitySearchItem[];
  nextCursor: string | null;
};

export type TraceabilityContext = {
  objectType: TraceabilityObjectType;
  objectId: string;
  displayName: string;
  statuses: Array<{ title: string; valueLabel: string }>;
  links: Array<{
    objectType: TraceabilityObjectType;
    objectId: string;
    displayName: string;
    relationLabel: string;
  }>;
  timeline: Array<{
    eventId: string;
    actionLabel: string;
    reason: string | null;
    actor: { displayName: string; roleLabel: string };
    occurredAt: string;
  }>;
  problems: Array<{
    id: string;
    title: string;
    statusLabel: string;
    reason: string | null;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  defects: Array<{
    id: string;
    statusLabel: string;
    reason: string;
    weightKg: number | null;
    recordedAt: string;
  }>;
  productionFacts: TraceabilityFact[];
  warehouseFacts: TraceabilityFact[];
};

export type TraceabilityFact = {
  title: string;
  valueLabel: string;
  recordedAt: string;
  isCurrent: boolean | null;
};

export type DirectorTraceabilitySearchQuery = {
  q: string;
  cursor?: string;
  limit?: number;
};

const TRACEABILITY_MATCH_KINDS = ['exact', 'prefix', 'contains'] as const;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isTraceabilityTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isTraceabilityObjectType(value: unknown): value is TraceabilityObjectType {
  return typeof value === 'string' && TRACEABILITY_OBJECT_TYPES.includes(value as never);
}

function isTraceabilitySearchItem(value: unknown): value is TraceabilitySearchItem {
  return (
    isResponseRecord(value) &&
    isTraceabilityObjectType(value.objectType) &&
    isResponseString(value.objectId) &&
    isResponseString(value.displayName) &&
    isNullableString(value.secondaryLabel) &&
    typeof value.matchKind === 'string' &&
    TRACEABILITY_MATCH_KINDS.includes(value.matchKind as never)
  );
}

function parseTraceabilitySearchPage(value: unknown): TraceabilitySearchPage {
  if (
    !isResponseRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isTraceabilitySearchItem) ||
    !(value.nextCursor === null || isResponseString(value.nextCursor))
  ) {
    throw new Error('Некорректные данные поиска прослеживаемости');
  }
  return { items: value.items, nextCursor: value.nextCursor };
}

function isTraceabilityFact(value: unknown): value is TraceabilityFact {
  return (
    isResponseRecord(value) &&
    hasOnlyTraceabilityKeys(value, ['title', 'valueLabel', 'recordedAt', 'isCurrent']) &&
    isResponseString(value.title) &&
    isResponseString(value.valueLabel) &&
    isTraceabilityTimestamp(value.recordedAt) &&
    (value.isCurrent === null || typeof value.isCurrent === 'boolean')
  );
}

function hasOnlyTraceabilityKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseTraceabilityContext(
  value: unknown,
  expectedObjectType: TraceabilityObjectType,
  expectedObjectId: string,
): TraceabilityContext {
  if (
    !isResponseRecord(value) ||
    value.objectType !== expectedObjectType ||
    value.objectId !== expectedObjectId ||
    !isResponseString(value.displayName) ||
    !hasOnlyTraceabilityKeys(value, [
      'objectType',
      'objectId',
      'displayName',
      'statuses',
      'links',
      'timeline',
      'problems',
      'defects',
      'productionFacts',
      'warehouseFacts',
    ]) ||
    !Array.isArray(value.statuses) ||
    !value.statuses.every(
      (item) =>
        isResponseRecord(item) &&
        hasOnlyTraceabilityKeys(item, ['title', 'valueLabel']) &&
        isResponseString(item.title) &&
        isResponseString(item.valueLabel),
    ) ||
    !Array.isArray(value.links) ||
    !value.links.every(
      (item) =>
        isResponseRecord(item) &&
        isTraceabilityObjectType(item.objectType) &&
        isResponseString(item.objectId) &&
        isResponseString(item.displayName) &&
        hasOnlyTraceabilityKeys(item, ['objectType', 'objectId', 'displayName', 'relationLabel']) &&
        isResponseString(item.relationLabel),
    ) ||
    !Array.isArray(value.timeline) ||
    !value.timeline.every(
      (item) =>
        isResponseRecord(item) &&
        hasOnlyTraceabilityKeys(item, [
          'eventId',
          'actionLabel',
          'reason',
          'actor',
          'occurredAt',
        ]) &&
        isResponseString(item.eventId) &&
        isResponseString(item.actionLabel) &&
        isNullableString(item.reason) &&
        isResponseRecord(item.actor) &&
        hasOnlyTraceabilityKeys(item.actor, ['displayName', 'roleLabel']) &&
        isResponseString(item.actor.displayName) &&
        isResponseString(item.actor.roleLabel) &&
        isTraceabilityTimestamp(item.occurredAt),
    ) ||
    !Array.isArray(value.problems) ||
    !value.problems.every(
      (item) =>
        isResponseRecord(item) &&
        hasOnlyTraceabilityKeys(item, [
          'id',
          'title',
          'statusLabel',
          'reason',
          'createdAt',
          'resolvedAt',
        ]) &&
        isResponseString(item.id) &&
        isResponseString(item.title) &&
        isResponseString(item.statusLabel) &&
        isNullableString(item.reason) &&
        isTraceabilityTimestamp(item.createdAt) &&
        (item.resolvedAt === null || isTraceabilityTimestamp(item.resolvedAt)),
    ) ||
    !Array.isArray(value.defects) ||
    !value.defects.every(
      (item) =>
        isResponseRecord(item) &&
        hasOnlyTraceabilityKeys(item, ['id', 'statusLabel', 'reason', 'weightKg', 'recordedAt']) &&
        isResponseString(item.id) &&
        isResponseString(item.statusLabel) &&
        isResponseString(item.reason) &&
        (item.weightKg === null ||
          (typeof item.weightKg === 'number' && Number.isFinite(item.weightKg))) &&
        isTraceabilityTimestamp(item.recordedAt),
    ) ||
    !Array.isArray(value.productionFacts) ||
    !value.productionFacts.every(isTraceabilityFact) ||
    !Array.isArray(value.warehouseFacts) ||
    !value.warehouseFacts.every(isTraceabilityFact)
  ) {
    throw new Error('Некорректные данные контекста прослеживаемости');
  }
  return value as TraceabilityContext;
}

export const DIRECTOR_ANALYTICS_BUCKETS = ['day', 'week', 'month'] as const;
export type DirectorAnalyticsBucket = (typeof DIRECTOR_ANALYTICS_BUCKETS)[number];

export const DIRECTOR_ANALYTICS_FIXED_PERIODS = ['week', 'month'] as const;
export type DirectorAnalyticsFixedPeriod = (typeof DIRECTOR_ANALYTICS_FIXED_PERIODS)[number];

export const DIRECTOR_APPLICATION_PERIODS = ['week', 'month', '3_months', '6_months'] as const;
export type DirectorApplicationPeriod = (typeof DIRECTOR_APPLICATION_PERIODS)[number];

export const DIRECTOR_ROLL_PROVENANCE = [
  'post_session',
  'operation_actor',
  'actor_missing',
  'plan_missing',
] as const;
export type DirectorRollProvenance = (typeof DIRECTOR_ROLL_PROVENANCE)[number];

export type DirectorAnalyticsQuery = {
  from: string;
  to: string;
  bucket: DirectorAnalyticsBucket;
};

export const DIRECTOR_ANALYTICS_EVIDENCE_STATUSES = ['pending', 'ok', 'mismatch'] as const;
export type DirectorAnalyticsEvidenceStatus = (typeof DIRECTOR_ANALYTICS_EVIDENCE_STATUSES)[number];

export const DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type DirectorAnalyticsEvidenceFreshness =
  (typeof DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS)[number];

export const DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES = ['open', 'closed'] as const;
export type DirectorAnalyticsBigBagUsageState =
  (typeof DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES)[number];

export const BIG_BAG_STATUSES = ['available', 'in_use', 'consumed'] as const;
export type BigBagStatus = (typeof BIG_BAG_STATUSES)[number];

export type DirectorAnalyticsEvidenceQueryBase = DirectorAnalyticsQuery & {
  operatorId?: string;
  postId?: string;
  shiftId?: string;
  bigBagId?: string;
  q?: string;
  operatorQuery?: string;
  postQuery?: string;
  shiftQuery?: string;
  status?: DirectorAnalyticsEvidenceStatus;
  freshness?: DirectorAnalyticsEvidenceFreshness;
  latestEvidenceFrom?: string;
  latestEvidenceTo?: string;
  cursor?: string;
  limit?: number;
};

type DirectorAnalyticsShiftEvidenceFields = {
  startedFrom?: string;
  startedTo?: string;
  endedFrom?: string;
  endedTo?: string;
  startKgMin?: number;
  startKgMax?: number;
  remainingKgMin?: number;
  remainingKgMax?: number;
  actualUsageKgMin?: number;
  actualUsageKgMax?: number;
  expectedUsageKgMin?: number;
  expectedUsageKgMax?: number;
  producedKgMin?: number;
  producedKgMax?: number;
  rollCountMin?: number;
  rollCountMax?: number;
  defectKgMin?: number;
  defectKgMax?: number;
  defectCountMin?: number;
  defectCountMax?: number;
  unverifiedDefectCountMin?: number;
  unverifiedDefectCountMax?: number;
  deviationKgMin?: number;
  deviationKgMax?: number;
  deviationPercentMin?: number;
  deviationPercentMax?: number;
};

type DirectorAnalyticsBigBagEvidenceFields = {
  bigBagQuery?: string;
  materialQuery?: string;
  bigBagStatus?: BigBagStatus;
  openedFrom?: string;
  openedTo?: string;
  closedFrom?: string;
  closedTo?: string;
  usageState?: DirectorAnalyticsBigBagUsageState;
  startKgMin?: number;
  startKgMax?: number;
  endKgMin?: number;
  endKgMax?: number;
  currentKgMin?: number;
  currentKgMax?: number;
  bagUsageKgMin?: number;
  bagUsageKgMax?: number;
  actualUsageKgMin?: number;
  actualUsageKgMax?: number;
  expectedUsageKgMin?: number;
  expectedUsageKgMax?: number;
  producedKgMin?: number;
  producedKgMax?: number;
  rollCountMin?: number;
  rollCountMax?: number;
  defectKgMin?: number;
  defectKgMax?: number;
  defectCountMin?: number;
  defectCountMax?: number;
  unverifiedDefectCountMin?: number;
  unverifiedDefectCountMax?: number;
  deviationKgMin?: number;
  deviationKgMax?: number;
  deviationPercentMin?: number;
  deviationPercentMax?: number;
};

export type DirectorAnalyticsShiftEvidenceQuery = DirectorAnalyticsEvidenceQueryBase &
  DirectorAnalyticsShiftEvidenceFields;

export type DirectorAnalyticsBigBagEvidenceQuery = DirectorAnalyticsEvidenceQueryBase &
  DirectorAnalyticsBigBagEvidenceFields;

/** @deprecated Use the endpoint-specific evidence query type. */
export type DirectorAnalyticsEvidenceQuery = DirectorAnalyticsEvidenceQueryBase;

export type DirectorOperatorRollVarianceQuery = {
  from: string;
  to: string;
  cursor?: string;
  limit?: number;
};

export type ServerDirectorOperatorRollVariance = {
  operatorId: string | null;
  operatorName: string | null;
  orderId: string;
  orderNumber: string;
  rollId: string;
  rollCode: string;
  producedAt: string;
  actualCapturedAt: string;
  plannedKg: number | null;
  actualKg: number;
  varianceKg: number | null;
  overPlanKg: number | null;
  provenance: DirectorRollProvenance;
};

export type ServerDirectorOperatorRollVariancePage = {
  items: ServerDirectorOperatorRollVariance[];
  nextCursor: string | null;
};

export type ServerDirectorAnalyticsRange = {
  timezone: 'Europe/Moscow';
  requested: { from: string; to: string };
  effective: { fromUtc: string; toExclusiveUtc: string };
  bucket: DirectorAnalyticsBucket;
  generatedAt: string;
};

export type ServerDirectorAnalyticsProductionPoint = {
  bucketStartDate: string;
  rollCount: number;
  producedKg: number;
};

export type ServerDirectorAnalyticsMaterialPoint = {
  bucketStartDate: string;
  expectedUsageKg: number;
  actualUsageKg: number;
};

export type ServerDirectorAccountingProduction = {
  source: {
    sourceKind: '1C';
    label: '1С · Отчет производства за смену';
    latestImportedAt: string | null;
    latestDocumentDate: string | null;
    stale: boolean;
  };
  coverage: {
    documentCount: number;
    excludedOutputLineCount: number;
    excludedMaterialLineCount: number;
  };
  productionSeries: Array<{
    bucketStartDate: string;
    documentCount: number;
    producedKg: number;
  }>;
  materialSeries: Array<{
    bucketStartDate: string;
    consumedKg: number;
  }>;
};

export type ServerDirectorAnalyticsOverPlanSeriesPoint = {
  bucketStartDate: string;
  affectedRollCount: number;
  affectedOperatorCount: number;
  overPlanKg: number;
};

export type ServerDirectorAnalyticsOverPlanTotal = {
  period: DirectorAnalyticsFixedPeriod;
  fromDate: string;
  toDate: string;
  affectedRollCount: number;
  affectedOperatorCount: number;
  overPlanKg: number;
};

export type ServerDirectorAnalyticsTopOperator = {
  operatorId: string;
  operatorName: string;
  affectedRollCount: number;
  overPlanKg: number;
};

export type ServerDirectorAnalyticsOperatorOverPlan = {
  series: ServerDirectorAnalyticsOverPlanSeriesPoint[];
  totals: ServerDirectorAnalyticsOverPlanTotal[];
  topOperators: ServerDirectorAnalyticsTopOperator[];
  missingPlanCount: number;
  missingActorCount: number;
};

export type ServerDirectorAnalyticsProductionQualityPoint = {
  id: string;
  bucketStartDate: string;
  producedRollCount: number;
  producedKg: number;
  defectRecordCount: number;
  defectiveRollCount: number;
  verifiedDefectKg: number;
  unverifiedDefectCount: number;
  returnedSpoolCount?: number;
};

export type ServerDirectorAnalyticsMaterialSpendPoint = {
  bucketStartDate: string;
  consumedGranulesKg: number;
  recordedSpoolCount: number;
  recordedSpoolTareKg: number;
  missingSpoolEvidenceCount: number;
};

export type ServerDirectorAnalyticsSpoolEvidence = {
  availability: 'measured_evidence_only';
  explanation: string;
};

export type ServerDirectorCommercialApplicationPeriod = {
  period: DirectorApplicationPeriod;
  fromDate: string;
  toDate: string;
  totalCount: number;
  clientOrderCount: number;
  stockReserveCount: number;
};

export type ServerDirectorCommercialApplications = {
  definition: 'submitted';
  asOfDate: string;
  periods: ServerDirectorCommercialApplicationPeriod[];
};

export type ServerDirectorAnalyticsShiftBalance = {
  sessionId: string;
  shiftId: string | null;
  shiftLabel: string | null;
  operatorId: string;
  operatorName: string;
  postId: string;
  postCode: string;
  postName: string;
  startedAt: string;
  endedAt: string;
  rollCount: number;
  producedKg: number;
  expectedUsageKg: number;
  actualUsageKg: number | null;
  deviationPercent: number | null;
  status: 'pending' | 'ok' | 'mismatch';
  payroll: ServerDirectorAnalyticsShiftPayroll;
};

export type ServerDirectorAnalyticsShiftPayroll =
  | {
      status: 'resolved';
      tariffOrder: ServerPayrollTariffOrderReference;
      rateKopecksPerKg: number | null;
      amountKopecks: number;
      tariffRule: ServerDirectorPayrollTariffRule | null;
      basisLabel: string;
    }
  | {
      status: 'unresolved';
      reasons: ServerDirectorPayrollUnresolvedReason[];
    };

export type ServerDirectorAnalyticsBigBagUsage = {
  id: string;
  sessionId: string;
  shiftId: string | null;
  shiftLabel: string | null;
  operatorId: string;
  operatorName: string;
  postId: string;
  postCode: string;
  postName: string;
  startKg: number;
  endKg: number | null;
  deltaKg: number | null;
  openedAt: string;
  closedAt: string | null;
};

export type ServerDirectorAnalyticsBigBag = {
  id: string;
  code: string;
  materialId: string | null;
  material: string;
  status: BigBagStatus;
  initialKg: number | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceEffectiveAt: string | null;
  currentSnapshot: {
    measuredKg: number | null;
    measuredAt: string | null;
  };
  usageHistory: ServerDirectorAnalyticsBigBagUsage[];
};

export type ServerDirectorAnalyticsEvidenceSource = {
  usage: 'shift_bag_usage';
  production: 'canonical_roll_weight_capture';
  defects: 'linked_stable_defect_weight_capture';
  latestEvidenceAt: string | null;
  freshness: DirectorAnalyticsEvidenceFreshness;
};

export type ServerDirectorAnalyticsShiftBigBag = {
  usageId: string;
  bigBagId: string;
  bigBagCode: string;
  materialId: string | null;
  material: string;
  bigBagStatus: ServerDirectorAnalyticsBigBag['status'];
  startKg: number;
  endKg: number | null;
  currentKg: number | null;
  currentMeasuredAt: string | null;
  currentFreshness: ServerDirectorAnalyticsEvidenceSource['freshness'];
  openedAt: string;
  closedAt: string | null;
};

export type ServerDirectorAnalyticsShiftBalanceEvidence = {
  sessionId: string;
  shiftId: string | null;
  shiftLabel: string | null;
  operatorId: string;
  operatorName: string;
  postId: string;
  postCode: string;
  postName: string;
  startedAt: string;
  endedAt: string;
  bigBags: ServerDirectorAnalyticsShiftBigBag[];
  startKg: number | null;
  endKg: number | null;
  currentKg: number | null;
  actualUsageKg: number | null;
  expectedUsageKg: number;
  producedKg: number;
  rollCount: number;
  defectKg: number;
  defectCount: number;
  unverifiedDefectCount: number;
  deviationKg: number | null;
  deviationPercent: number | null;
  status: DirectorAnalyticsEvidenceStatus;
  source: ServerDirectorAnalyticsEvidenceSource;
};

export type ServerDirectorAnalyticsShiftBalancePage = {
  items: ServerDirectorAnalyticsShiftBalanceEvidence[];
  nextCursor: string | null;
};

export type ServerDirectorAnalyticsBigBagEvidence = {
  id: string;
  bigBagId: string;
  bigBagCode: string;
  materialId: string | null;
  material: string;
  bigBagStatus: ServerDirectorAnalyticsBigBag['status'];
  sessionId: string;
  shiftId: string | null;
  shiftLabel: string | null;
  operatorId: string;
  operatorName: string;
  postId: string;
  postCode: string;
  postName: string;
  openedAt: string;
  closedAt: string | null;
  startKg: number;
  endKg: number | null;
  currentKg: number | null;
  currentMeasuredAt: string | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceEffectiveAt: string | null;
  bagUsageKg: number | null;
  actualUsageKg: number | null;
  expectedUsageKg: number | null;
  calculatedRemainderKg: number | null;
  producedKg: number | null;
  rollCount: number | null;
  defectKg: number | null;
  defectCount: number | null;
  unverifiedDefectCount: number | null;
  deviationKg: number | null;
  deviationPercent: number | null;
  balanceScope: 'usage_episodes';
  status: DirectorAnalyticsEvidenceStatus;
  source: ServerDirectorAnalyticsEvidenceSource;
};

export type ServerDirectorAnalyticsBigBagEvidencePage = {
  items: ServerDirectorAnalyticsBigBagEvidence[];
  nextCursor: string | null;
};

export type ServerDirectorAnalyticsResponse = {
  range: ServerDirectorAnalyticsRange;
  productionSeries: ServerDirectorAnalyticsProductionPoint[];
  materialSeries: ServerDirectorAnalyticsMaterialPoint[];
  shiftBalances: ServerDirectorAnalyticsShiftBalance[];
  bigBags: ServerDirectorAnalyticsBigBag[];
  operatorOverPlan: ServerDirectorAnalyticsOperatorOverPlan;
  productionQualitySeries: ServerDirectorAnalyticsProductionQualityPoint[];
  materialSpendSeries: ServerDirectorAnalyticsMaterialSpendPoint[];
  spoolEvidence: ServerDirectorAnalyticsSpoolEvidence;
  commercialApplications: ServerDirectorCommercialApplications;
  accountingProduction: ServerDirectorAccountingProduction;
};

// --- Control / decisions ----------------------------------------------------

export function fetchDirectorControl(options?: ApiRequestOptions): Promise<ServerDirectorControl> {
  return apiGet<unknown>('/api/director/control', options).then(parseDirectorControl);
}

export function fetchDirectorProblems(
  options?: ApiRequestOptions,
): Promise<ServerProductionProblem[]> {
  return apiGet<ServerProductionProblem[]>('/api/director/problems', options);
}

export function fetchDirectorTraceabilitySearch(
  query: DirectorTraceabilitySearchQuery,
  options?: ApiRequestOptions,
): Promise<TraceabilitySearchPage> {
  const params = new URLSearchParams({ q: query.q });
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return apiGet<unknown>(`/api/director/traceability/search?${params.toString()}`, options).then(
    parseTraceabilitySearchPage,
  );
}

export function fetchDirectorTraceabilityContext(
  objectType: TraceabilityObjectType,
  objectId: string,
  options?: ApiRequestOptions,
): Promise<TraceabilityContext> {
  return apiGet<unknown>(
    `/api/director/traceability/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`,
    options,
  ).then((value) => parseTraceabilityContext(value, objectType, objectId));
}

export async function fetchDirectorAnalytics(
  query: DirectorAnalyticsQuery,
  options?: ApiRequestOptions,
): Promise<ServerDirectorAnalyticsResponse> {
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
    bucket: query.bucket,
  });
  const response = await apiGet<unknown>(`/api/director/analytics?${params.toString()}`, options);
  return parseDirectorAnalyticsResponse(response, query);
}

const evidenceCommonKeys = [
  'operatorId',
  'postId',
  'shiftId',
  'bigBagId',
  'status',
  'q',
  'operatorQuery',
  'postQuery',
  'shiftQuery',
] as const satisfies readonly (keyof DirectorAnalyticsEvidenceQueryBase)[];

const evidenceSourceKeys = [
  'freshness',
  'latestEvidenceFrom',
  'latestEvidenceTo',
] as const satisfies readonly (keyof DirectorAnalyticsEvidenceQueryBase)[];

const shiftEvidenceDateKeys = [
  'startedFrom',
  'startedTo',
  'endedFrom',
  'endedTo',
] as const satisfies readonly (keyof DirectorAnalyticsShiftEvidenceQuery)[];

const shiftEvidenceNumberKeys = [
  'startKgMin',
  'startKgMax',
  'remainingKgMin',
  'remainingKgMax',
  'actualUsageKgMin',
  'actualUsageKgMax',
  'expectedUsageKgMin',
  'expectedUsageKgMax',
  'producedKgMin',
  'producedKgMax',
  'rollCountMin',
  'rollCountMax',
  'defectKgMin',
  'defectKgMax',
  'defectCountMin',
  'defectCountMax',
  'unverifiedDefectCountMin',
  'unverifiedDefectCountMax',
  'deviationKgMin',
  'deviationKgMax',
  'deviationPercentMin',
  'deviationPercentMax',
] as const satisfies readonly (keyof DirectorAnalyticsShiftEvidenceQuery)[];

const bigBagEvidenceFieldKeys = [
  'bigBagQuery',
  'materialQuery',
  'bigBagStatus',
  'openedFrom',
  'openedTo',
  'closedFrom',
  'closedTo',
  'usageState',
] as const satisfies readonly (keyof DirectorAnalyticsBigBagEvidenceQuery)[];

const bigBagEvidenceNumberKeys = [
  'startKgMin',
  'startKgMax',
  'endKgMin',
  'endKgMax',
  'currentKgMin',
  'currentKgMax',
  'bagUsageKgMin',
  'bagUsageKgMax',
  'actualUsageKgMin',
  'actualUsageKgMax',
  'expectedUsageKgMin',
  'expectedUsageKgMax',
  'producedKgMin',
  'producedKgMax',
  'rollCountMin',
  'rollCountMax',
  'defectKgMin',
  'defectKgMax',
  'defectCountMin',
  'defectCountMax',
  'unverifiedDefectCountMin',
  'unverifiedDefectCountMax',
  'deviationKgMin',
  'deviationKgMax',
  'deviationPercentMin',
  'deviationPercentMax',
] as const satisfies readonly (keyof DirectorAnalyticsBigBagEvidenceQuery)[];

function appendDefinedQueryValues<T, K extends keyof T>(
  params: URLSearchParams,
  query: T,
  keys: readonly K[],
): void {
  for (const key of keys) {
    const value = query[key];
    if (value !== undefined) params.set(String(key), String(value));
  }
}

function directorAnalyticsEvidenceBaseParams(
  query: DirectorAnalyticsEvidenceQueryBase,
): URLSearchParams {
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
    bucket: query.bucket,
  });
  appendDefinedQueryValues(params, query, evidenceCommonKeys);
  return params;
}

function directorShiftEvidenceParams(query: DirectorAnalyticsShiftEvidenceQuery): URLSearchParams {
  const params = directorAnalyticsEvidenceBaseParams(query);
  appendDefinedQueryValues(params, query, shiftEvidenceDateKeys);
  appendDefinedQueryValues(params, query, shiftEvidenceNumberKeys);
  appendDefinedQueryValues(params, query, evidenceSourceKeys);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return params;
}

function directorBigBagEvidenceParams(
  query: DirectorAnalyticsBigBagEvidenceQuery,
): URLSearchParams {
  const params = directorAnalyticsEvidenceBaseParams(query);
  appendDefinedQueryValues(params, query, bigBagEvidenceFieldKeys);
  appendDefinedQueryValues(params, query, bigBagEvidenceNumberKeys);
  appendDefinedQueryValues(params, query, evidenceSourceKeys);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return params;
}

export function fetchDirectorShiftBalances(
  query: DirectorAnalyticsShiftEvidenceQuery,
  options?: ApiRequestOptions,
): Promise<ServerDirectorAnalyticsShiftBalancePage> {
  const params = directorShiftEvidenceParams(query);
  return apiGet<unknown>(
    `/api/director/analytics/shift-balances?${params.toString()}`,
    options,
  ).then(parseDirectorShiftBalancePage);
}

export function fetchDirectorBigBagEvidence(
  query: DirectorAnalyticsBigBagEvidenceQuery,
  options?: ApiRequestOptions,
): Promise<ServerDirectorAnalyticsBigBagEvidencePage> {
  const params = directorBigBagEvidenceParams(query);
  return apiGet<unknown>(`/api/director/analytics/big-bags?${params.toString()}`, options).then(
    parseDirectorBigBagEvidencePage,
  );
}

export function fetchBusinessShiftBalances(
  query: DirectorAnalyticsShiftEvidenceQuery,
  options?: ApiRequestOptions,
): Promise<ServerDirectorAnalyticsShiftBalancePage> {
  const params = directorShiftEvidenceParams(query);
  return apiGet<unknown>(
    `/api/commercial/performance/control/shift-balances?${params.toString()}`,
    options,
  ).then(parseDirectorShiftBalancePage);
}

export function fetchBusinessBigBagEvidence(
  query: DirectorAnalyticsBigBagEvidenceQuery,
  options?: ApiRequestOptions,
): Promise<ServerDirectorAnalyticsBigBagEvidencePage> {
  const params = directorBigBagEvidenceParams(query);
  return apiGet<unknown>(
    `/api/commercial/performance/control/big-bags?${params.toString()}`,
    options,
  ).then(parseDirectorBigBagEvidencePage);
}

export function fetchDirectorOperatorRollVariances(
  query: DirectorOperatorRollVarianceQuery,
  options?: ApiRequestOptions,
): Promise<ServerDirectorOperatorRollVariancePage> {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return apiGet<unknown>(
    `/api/director/analytics/operator-rolls?${params.toString()}`,
    options,
  ).then(parseDirectorOperatorRollVariancePage);
}

export function fetchDirectorDecisions(
  filter?: {
    scope?: string;
    status?: string;
  },
  options?: ApiRequestOptions,
): Promise<ServerDirectorDecision[]> {
  const params = new URLSearchParams();
  if (filter?.scope) params.set('scope', filter.scope);
  if (filter?.status) params.set('status', filter.status);
  const query = params.toString();
  return apiGet<unknown>(`/api/director/decisions${query ? `?${query}` : ''}`, options).then(
    parseDirectorDecisions,
  );
}

export function approveDirectorDecision(decisionId: string): Promise<ServerDirectorDecision> {
  return apiPost<unknown>(`/api/director/decisions/${encodeURIComponent(decisionId)}/approve`).then(
    (value) => parseDirectorDecisionMutation(value, decisionId, 'approved'),
  );
}

export function returnDirectorDecision(
  decisionId: string,
  note: string,
): Promise<ServerDirectorDecision> {
  return apiPost<unknown>(`/api/director/decisions/${encodeURIComponent(decisionId)}/return`, {
    note,
  }).then((value) => parseDirectorDecisionMutation(value, decisionId, 'returned'));
}

// --- Drilldowns + override (мутирующие, аудируемые) -------------------------

export function fetchDirectorFinance(objectId: string): Promise<unknown> {
  return apiGet<unknown>(`/api/director/finance/${encodeURIComponent(objectId)}`);
}

export function fetchDirectorProduction(objectId: string): Promise<unknown> {
  return apiGet<unknown>(`/api/director/production/${encodeURIComponent(objectId)}`);
}

export function overrideDirectorFinance(objectId: string, input: DirectorOverrideInput) {
  return apiPost<unknown>(
    `/api/director/finance/${encodeURIComponent(objectId)}/override`,
    input,
  ).then((value) => parseDirectorOverrideResult(value, objectId));
}

export function overrideDirectorProduction(objectId: string, input: DirectorOverrideInput) {
  return apiPost<unknown>(
    `/api/director/production/${encodeURIComponent(objectId)}/override`,
    input,
  ).then((value) => parseDirectorOverrideResult(value, objectId));
}

export function overrideDirectorWarehouse(objectId: string, input: DirectorOverrideInput) {
  return apiPost<unknown>(
    `/api/director/warehouse/${encodeURIComponent(objectId)}/override`,
    input,
  ).then((value) => parseDirectorOverrideResult(value, objectId));
}

// --- Penalties + audit ------------------------------------------------------

export function fetchDirectorPenaltiesSummary(): Promise<ServerDirectorPenaltySummary> {
  return apiGet<ServerDirectorPenaltySummary>('/api/director/penalties/summary');
}

export function fetchDirectorPenaltiesForOperator(
  operatorId: string,
): Promise<ServerDirectorPenalty[]> {
  return apiGet<ServerDirectorPenalty[]>(
    `/api/director/penalties/operators/${encodeURIComponent(operatorId)}`,
  );
}

export function fetchDirectorPenaltyTargets(
  options?: ApiRequestOptions,
): Promise<ServerDirectorPenaltyTarget[]> {
  return apiGet<ServerDirectorPenaltyTarget[]>('/api/director/penalty-targets', options);
}

export function fetchDirectorAudit(objectId: string): Promise<ServerDirectorAuditEvent[]> {
  return apiGet<ServerDirectorAuditEvent[]>(
    `/api/director/audit?objectId=${encodeURIComponent(objectId)}`,
  );
}

// --- Списочные проекции контуров → WorkObject (директорский надзор) ----------

type ServerDirectorCounterparty = { displayName: string; legalName: string | null };

type ServerDirectorFinanceOrder = {
  id: string;
  invoiceStatus: string;
  paymentStatus: string;
  amountValue: number | string | null;
  amountLabel: string | null;
  commercialOrder: {
    orderNumber: string;
    counterparty: ServerDirectorCounterparty | null;
  };
};

type ServerDirectorProductionOrder = {
  id: string;
  indicator: (typeof PRODUCTION_INDICATORS)[number];
  approvalState: (typeof PRODUCTION_APPROVAL_STATES)[number];
  commercialOrder: {
    orderNumber: string;
    counterparty: ServerDirectorCounterparty | null;
  };
  rollCount: number;
};

type ServerDirectorWarehouseProblem = {
  id: string;
  type: string;
  status: string;
  orderId: string | null;
  rollId: string | null;
  postId: string | null;
  reason: string;
  recovery: string | null;
  actorRole: string;
  createdAt: string;
  resolvedAt: string | null;
  order: { id: string; orderNumber: string } | null;
  post: { id: string; code: string; name: string; status: (typeof POST_STATUSES)[number] } | null;
};

const PAYMENT_STATUSES = [
  'unpaid',
  'partial',
  'paid',
  'overdue',
  'sync_error',
  'not_applicable',
] as const;
const INVOICE_STATUSES = ['not_invoiced', 'invoiced'] as const;
const PRODUCTION_INDICATORS = [
  'not_started',
  'needs_production',
  'in_production',
  'ready',
  'needs_approval',
  'defect',
] as const;
const PRODUCTION_INDICATOR_LABEL: Record<(typeof PRODUCTION_INDICATORS)[number], string> = {
  not_started: 'Не начато',
  needs_production: 'Требует производства',
  in_production: 'В производстве',
  ready: 'Готово',
  needs_approval: 'Готов к согласованию',
  defect: 'Брак',
};
const PRODUCTION_APPROVAL_STATES = ['pending', 'approved'] as const;
const PRODUCTION_PROBLEM_TYPES = [
  'general',
  'raw_material_shortage',
  'defect',
  'shift_balance_mismatch',
  'machine_breakdown',
] as const;
const PRODUCTION_PROBLEM_STATUSES = ['open', 'resolved'] as const;
const ROLES = [
  'commercial',
  'production_lead',
  'operator',
  'warehouse',
  'finance',
  'director',
  'admin',
] as const;
const POST_STATUSES = ['active', 'inactive', 'maintenance', 'broken'] as const;
const DIRECTOR_DECISION_SCOPES = ['finance', 'production', 'warehouse'] as const;
const DIRECTOR_DECISION_STATUSES = ['pending', 'approved', 'returned'] as const;
const DIRECTOR_DECISION_SEVERITIES = ['info', 'warning', 'critical'] as const;

function isResponseRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isResponseString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isResponseTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isAllowedString<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function isRequiredNullableString(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && (record[key] === null || isResponseString(record[key]));
}

function isOptionalNullableString(record: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(record, key) || record[key] === null || typeof record[key] === 'string';
}

function isCounterparty(value: unknown): value is ServerDirectorCounterparty {
  return (
    isResponseRecord(value) &&
    isResponseString(value.displayName) &&
    Object.hasOwn(value, 'legalName') &&
    (value.legalName === null || isResponseString(value.legalName))
  );
}

function hasSafeCommercialOrder(value: unknown): boolean {
  if (
    !isResponseRecord(value) ||
    !Object.hasOwn(value, 'orderNumber') ||
    !isResponseString(value.orderNumber) ||
    !Object.hasOwn(value, 'counterparty')
  ) {
    return false;
  }
  return value.counterparty === null || isCounterparty(value.counterparty);
}

function isFinanceProjectionSource(value: unknown): value is ServerDirectorFinanceOrder {
  if (
    !isResponseRecord(value) ||
    !isResponseString(value.id) ||
    !Object.hasOwn(value, 'invoiceStatus') ||
    !Object.hasOwn(value, 'paymentStatus') ||
    !Object.hasOwn(value, 'amountValue') ||
    !Object.hasOwn(value, 'amountLabel') ||
    !Object.hasOwn(value, 'commercialOrder') ||
    !isAllowedString(value.paymentStatus, PAYMENT_STATUSES) ||
    !isAllowedString(value.invoiceStatus, INVOICE_STATUSES) ||
    (value.amountLabel !== null && typeof value.amountLabel !== 'string') ||
    (value.amountValue !== null && !isFinanceAmount(value.amountValue)) ||
    !hasSafeCommercialOrder(value.commercialOrder)
  ) {
    return false;
  }
  return true;
}

function isFinanceAmount(value: unknown): value is number | string {
  if (typeof value === 'number') {
    return (
      Number.isFinite(value) &&
      Number.isSafeInteger(Math.round(value * 100)) &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-7
    );
  }
  return (
    typeof value === 'string' &&
    /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(value) &&
    Number.isFinite(Number(value))
  );
}

function normalizedFinanceAmount(value: number | string | null | undefined) {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!match || (match[3]?.length ?? 0) > 2) return undefined;
  const minorUnits = BigInt(`${match[1]}${match[2]}${(match[3] ?? '').padEnd(2, '0')}`);
  if (
    minorUnits > BigInt(Number.MAX_SAFE_INTEGER) ||
    minorUnits < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return undefined;
  }
  const amount = Number(value);
  return Number.isFinite(amount) && Math.round(amount * 100) === Number(minorUnits)
    ? amount
    : undefined;
}

function financeAmountText(value: number | string | null): string | undefined {
  if (value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

function isProductionProjectionSource(value: unknown): value is ServerDirectorProductionOrder {
  if (
    !isResponseRecord(value) ||
    !isResponseString(value.id) ||
    !Object.hasOwn(value, 'indicator') ||
    !Object.hasOwn(value, 'approvalState') ||
    !Object.hasOwn(value, 'commercialOrder') ||
    !Object.hasOwn(value, 'rollCount') ||
    !isAllowedString(value.indicator, PRODUCTION_INDICATORS) ||
    !isAllowedString(value.approvalState, PRODUCTION_APPROVAL_STATES) ||
    !hasSafeCommercialOrder(value.commercialOrder) ||
    !Number.isSafeInteger(value.rollCount) ||
    (value.rollCount as number) < 0
  ) {
    return false;
  }
  return true;
}

function isWarehouseProjectionSource(value: unknown): value is ServerDirectorWarehouseProblem {
  if (
    !isResponseRecord(value) ||
    !isResponseString(value.id) ||
    !isAllowedString(value.type, PRODUCTION_PROBLEM_TYPES) ||
    !isAllowedString(value.status, PRODUCTION_PROBLEM_STATUSES) ||
    !isResponseString(value.reason) ||
    !isAllowedString(value.actorRole, ROLES) ||
    !isResponseTimestamp(value.createdAt) ||
    !isRequiredNullableString(value, 'orderId') ||
    !isRequiredNullableString(value, 'rollId') ||
    !isRequiredNullableString(value, 'postId') ||
    !isRequiredNullableString(value, 'recovery') ||
    !Object.hasOwn(value, 'resolvedAt') ||
    (value.resolvedAt !== null && !isResponseTimestamp(value.resolvedAt)) ||
    !Object.hasOwn(value, 'order') ||
    !Object.hasOwn(value, 'post')
  ) {
    return false;
  }
  if (
    value.order !== null &&
    (!isResponseRecord(value.order) ||
      !isResponseString(value.order.id) ||
      !isResponseString(value.order.orderNumber))
  ) {
    return false;
  }
  return (
    value.post === null ||
    (isResponseRecord(value.post) &&
      isResponseString(value.post.id) &&
      isResponseString(value.post.code) &&
      isResponseString(value.post.name) &&
      isAllowedString(value.post.status, POST_STATUSES))
  );
}

function isDirectorDecision(value: unknown): value is ServerDirectorDecision {
  return (
    isResponseRecord(value) &&
    isResponseString(value.id) &&
    isAllowedString(value.scope, DIRECTOR_DECISION_SCOPES) &&
    (value.objectId === null || isResponseString(value.objectId)) &&
    (value.evidence === null || isResponseString(value.evidence)) &&
    isAllowedString(value.ownerRole, ROLES) &&
    isAllowedString(value.status, DIRECTOR_DECISION_STATUSES) &&
    isAllowedString(value.severity, DIRECTOR_DECISION_SEVERITIES) &&
    isResponseTimestamp(value.createdAt) &&
    isResponseTimestamp(value.updatedAt)
  );
}

function parseDirectorDecisionMutation(
  value: unknown,
  expectedId: string,
  expectedStatus: 'approved' | 'returned',
): ServerDirectorDecision {
  if (!isDirectorDecision(value) || value.id !== expectedId || value.status !== expectedStatus) {
    throw new Error('Некорректный результат решения директора');
  }
  return value;
}

function parseDirectorOverrideResult(
  value: unknown,
  expectedObjectId: string,
): { applied: true; objectId: string } {
  if (
    !isResponseRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.applied !== true ||
    value.objectId !== expectedObjectId
  ) {
    throw new Error('Некорректный результат директорского override');
  }
  return { applied: true, objectId: expectedObjectId };
}

function parseDirectorDecisions(value: unknown): ServerDirectorDecision[] {
  if (!Array.isArray(value) || !value.every(isDirectorDecision)) {
    throw new Error('Некорректные данные очереди решений директора');
  }
  return value;
}

function parseProjectionSources<T>(
  value: unknown,
  validate: (item: unknown) => item is T,
  label: string,
): T[] {
  if (!Array.isArray(value) || !value.every(validate)) {
    throw new Error(`Некорректные данные: ${label}`);
  }
  return value;
}

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  paid: 'Оплачен',
  partial: 'Частично оплачен',
  unpaid: 'Не оплачен',
  overdue: 'Просрочка',
  sync_error: 'Ошибка синхронизации',
  not_applicable: 'Не применяется',
};

const DECISION_SCOPE_LABEL: Record<string, string> = {
  finance: 'Финансы',
  production: 'Производство',
  warehouse: 'Склад',
};

const DECISION_STATUS_LABEL: Record<string, string> = {
  pending: 'Ждёт решения',
  approved: 'Согласовано',
  returned: 'Возвращено',
};

function decisionToWorkObject(d: ServerDirectorDecision): WorkObject {
  const scopeLabel = DECISION_SCOPE_LABEL[d.scope] ?? d.scope;
  const statusLabel = DECISION_STATUS_LABEL[d.status] ?? d.status;
  const objectLabel = d.objectId ?? 'Объект не указан';
  const pending = d.status === 'pending';
  const facts: Fact[] = [
    { label: 'Контур', value: scopeLabel, scope: 'director' },
    { label: 'Объект', value: objectLabel, scope: 'director' },
    { label: 'Статус', value: statusLabel, scope: 'director' },
    { label: 'Основание', value: d.evidence ?? '—', scope: 'director' },
  ];
  const actions: ActionDescriptor[] = pending
    ? [
        {
          id: `director-decision-approve:${d.id}`,
          label: 'Согласовать',
          level: 'recommended',
          enabled: true,
        },
        {
          id: `director-decision-return:${d.id}`,
          label: 'Вернуть',
          level: 'secondary',
          enabled: true,
        },
      ]
    : [];
  return {
    id: d.id,
    kind: 'directorDecision',
    title: `Решение · ${scopeLabel} · ${objectLabel}`,
    statusLabel,
    nextOwner: 'Директор',
    severity:
      d.severity === 'critical' ? 'critical' : d.severity === 'warning' ? 'warning' : 'info',
    filterTags: ['Требуют решения', ...(pending ? [] : ['Решено'])],
    facts,
    sections: [],
    actions,
    problems: pending
      ? [
          {
            id: `${d.id}-decision`,
            objectId: d.id,
            stage: 'Решение директора',
            title: `Решение по ${scopeLabel.toLowerCase()}`,
            severity: 'warning',
            ownerRole: 'Директор',
            due: 'ждёт решения',
            reason: d.evidence ?? 'Требует директорского решения',
            recovery: 'Согласовать или вернуть с причиной',
            status: 'open',
          },
        ]
      : [],
    audit: [],
  };
}

export function projectDirectorDecisionObjects(
  decisions: readonly ServerDirectorDecision[],
): WorkObject[] {
  return decisions.map(decisionToWorkObject);
}

export function fetchDirectorDecisionObjects(options?: ApiRequestOptions): Promise<WorkObject[]> {
  return fetchDirectorDecisions(undefined, options).then(projectDirectorDecisionObjects);
}

const PROBLEM_TYPE_LABEL: Record<string, string> = {
  defect: 'Брак рулона',
  machine_breakdown: 'Поломка станка',
  shift_balance_mismatch: 'Расхождение баланса смены',
  raw_material_shortage: 'Нехватка сырья',
  general: 'Проблема контура',
};

function counterpartyName(cp: ServerDirectorCounterparty | null): string {
  return cp?.displayName ?? 'На запас';
}

function financeOrderToWorkObject(fo: ServerDirectorFinanceOrder): WorkObject {
  const number = fo.commercialOrder.orderNumber;
  const cp = counterpartyName(fo.commercialOrder.counterparty);
  const overdue = fo.paymentStatus === 'overdue';
  const amountValue = normalizedFinanceAmount(fo.amountValue);
  const amountText = financeAmountText(fo.amountValue);
  const facts: Fact[] = [
    { label: 'Номер', value: number, scope: 'production' },
    { label: 'Контрагент', value: cp, scope: 'legal' },
    {
      label: 'Сумма',
      value: amountText === undefined ? (fo.amountLabel ?? 'Нет данных') : `${amountText} ₽`,
      scope: 'production',
    },
    {
      label: 'Статус оплаты',
      value: PAYMENT_STATUS_LABEL[fo.paymentStatus] ?? fo.paymentStatus,
      scope: 'production',
    },
  ];
  const actions: ActionDescriptor[] = [
    {
      id: `director-finance-override-confirm:${fo.id}`,
      label: 'Подтвердить решение',
      level: 'peer',
      enabled: true,
    },
    {
      id: `director-finance-override-return:${fo.id}`,
      label: 'Вернуть бухгалтерии',
      level: 'secondary',
      enabled: true,
    },
  ];
  return {
    id: fo.id,
    kind: 'financeOrder',
    title: `Финансы ${number} · ${cp}`,
    statusLabel: PAYMENT_STATUS_LABEL[fo.paymentStatus] ?? fo.paymentStatus,
    nextOwner: 'Директор',
    severity: overdue ? 'warning' : 'info',
    filterTags: ['Финансы', ...(overdue ? ['Просрочка'] : [])],
    facts,
    sections: [],
    actions,
    problems: [],
    audit: [],
    financeAmountValue: amountValue,
  };
}

function productionOrderToWorkObject(po: ServerDirectorProductionOrder): WorkObject {
  const number = po.commercialOrder.orderNumber;
  const cp = counterpartyName(po.commercialOrder.counterparty);
  const statusLabel = PRODUCTION_INDICATOR_LABEL[po.indicator];
  const facts: Fact[] = [
    { label: 'Номер', value: number, scope: 'production' },
    { label: 'Контрагент', value: cp, scope: 'legal' },
    { label: 'Рулоны', value: `${po.rollCount} рул.`, scope: 'production' },
    {
      label: 'Статус',
      value: statusLabel,
      scope: 'production',
    },
  ];
  const actions: ActionDescriptor[] = [
    {
      id: `director-production-override-confirm:${po.id}`,
      label: 'Подтвердить исключение',
      level: 'peer',
      enabled: true,
    },
    {
      id: `director-production-override-priority:${po.id}`,
      label: 'Изменить приоритет',
      level: 'secondary',
      enabled: true,
    },
  ];
  return {
    id: po.id,
    kind: 'productionOrder',
    title: `Производство ${number} · ${cp}`,
    statusLabel,
    nextOwner: 'Директор',
    severity: po.indicator === 'defect' ? 'critical' : 'info',
    filterTags: ['Производство'],
    facts,
    sections: [],
    actions,
    problems: [],
    audit: [],
  };
}

function warehouseProblemToWorkObject(p: ServerDirectorWarehouseProblem): WorkObject {
  const label = PROBLEM_TYPE_LABEL[p.type] ?? p.type;
  const context = [p.order?.orderNumber, p.rollId, p.post?.name].filter(Boolean).join(' · ');
  const critical = p.type === 'defect' || p.type === 'machine_breakdown';
  const facts: Fact[] = [
    { label: 'Номер', value: p.order?.orderNumber ?? label, scope: 'warehouse' },
    { label: 'Тип', value: label, scope: 'warehouse' },
    { label: 'Контекст', value: context || '—', scope: 'warehouse' },
    { label: 'Причина', value: p.reason, scope: 'warehouse' },
    { label: 'Статус', value: p.status === 'open' ? 'Открыта' : 'Решена', scope: 'warehouse' },
  ];
  const actions: ActionDescriptor[] =
    p.status === 'open'
      ? [
          {
            id: `director-warehouse-override-confirm:${p.id}`,
            label: 'Подтвердить исключение',
            level: 'peer',
            enabled: true,
          },
        ]
      : [];
  return {
    id: p.id,
    kind: 'warehouseJob',
    title: `Склад: ${label}${context ? ` · ${context}` : ''}`,
    statusLabel: p.status === 'open' ? 'Открыта' : 'Решена',
    nextOwner: 'Директор',
    severity: p.status === 'open' ? (critical ? 'critical' : 'warning') : 'info',
    filterTags: ['Склад', ...(p.status === 'open' ? ['Проблемы'] : [])],
    facts,
    sections: [],
    actions,
    problems: [],
    audit: [],
  };
}

export function fetchDirectorFinanceObjects(options?: ApiRequestOptions): Promise<WorkObject[]> {
  return apiGet<unknown>('/api/director/finance', options).then((response) =>
    parseProjectionSources(response, isFinanceProjectionSource, 'финансовые решения').map(
      financeOrderToWorkObject,
    ),
  );
}

export function fetchDirectorProductionObjects(options?: ApiRequestOptions): Promise<WorkObject[]> {
  return apiGet<unknown>('/api/director/production', options).then((response) =>
    parseProjectionSources(response, isProductionProjectionSource, 'производственные решения').map(
      productionOrderToWorkObject,
    ),
  );
}

export function fetchDirectorWarehouseObjects(options?: ApiRequestOptions): Promise<WorkObject[]> {
  return apiGet<unknown>('/api/director/warehouse', options).then((response) =>
    parseProjectionSources(response, isWarehouseProjectionSource, 'складские исключения').map(
      warehouseProblemToWorkObject,
    ),
  );
}

// --- Live-наложение дашборда «Контроль» --------------------------------------

function factValueOf(object: WorkObject, label: string): string | undefined {
  return object.facts.find((fact) => fact.label === label)?.value;
}

/** Строит live-проекцию только из серверных фактов, без demo-каркаса. */
export function buildLiveDirectorControl(
  control: ServerDirectorControl,
  financeObjects: WorkObject[] = [],
): DirectorDashboardProjection {
  const kg = (n: number) => `${n} кг`;
  const productionRows = [
    {
      id: 'output-kg',
      label: 'Готовая продукция · вся история',
      factLabel: kg(control.producedKg),
      planLabel: 'Нет данных',
      varianceLabel: 'Сравнение недоступно',
      sourceLabel: 'За весь доступный период',
    },
    {
      id: 'rolls',
      label: 'Принятые складом рулоны · вся история',
      factLabel: `${control.warehouseAcceptedRolls}`,
      planLabel: 'Нет данных',
      varianceLabel: 'Сравнение недоступно',
      sourceLabel: 'За весь доступный период',
    },
    {
      id: 'defects',
      label: 'Брак и потери · вся история',
      factLabel: kg(control.defectKg),
      planLabel: 'Нет данных',
      varianceLabel: 'Сравнение недоступно',
      sourceLabel: 'За весь доступный период',
    },
  ];
  const liveFinanceRows = financeObjects.slice(0, 40).map((object) => {
    const amountLabel = factValueOf(object, 'Сумма') ?? 'Нет данных';
    const statusLabel = factValueOf(object, 'Статус оплаты') ?? '—';
    const overdue = statusLabel === 'Просрочка';
    return {
      id: object.id,
      orderId: factValueOf(object, 'Номер') ?? object.id,
      customerLabel: factValueOf(object, 'Контрагент') ?? 'клиент не указан',
      amountLabel,
      paidLabel: 'Нет данных',
      remainingLabel: 'Нет данных',
      dueLabel: 'Нет данных',
      statusLabel,
      sourceLabel: 'Текущий заказ',
      riskLabel: overdue ? 'просрочка' : 'в норме',
      severity: overdue ? ('critical' as const) : ('info' as const),
      amountValue: object.financeAmountValue ?? null,
      remainingValue: null,
      dueRank: null,
    };
  });
  return {
    situations: [],
    healthSignals: [],
    secondaryMetrics: [],
    controlReport: {
      periodLabel: 'Период не предоставлен',
      sourceLabel: 'За весь доступный период',
      denominatorLabel: 'Сравнение периодов и плановые основания недоступны.',
      selectedPeriod: 'current_month',
      comparisonPeriod: 'previous_month',
      availablePeriods: [],
      kpis: [],
      periodMetrics: [],
      periodRows: [],
      financeRows: liveFinanceRows,
      productionRows,
      defectBags: control.defectBags,
    },
    evidence: {
      periodLabel: 'Период не предоставлен',
      sourceLabel: 'За весь доступный период',
      denominatorLabel: 'Сравнение периодов и плановые основания недоступны.',
    },
  };
}

/** @deprecated Используйте buildLiveDirectorControl: demo-аргумент намеренно игнорируется. */
export function overlayLiveDirectorControl(
  _dashboard: DirectorDashboardProjection,
  control: ServerDirectorControl,
  financeObjects: WorkObject[] = [],
): DirectorDashboardProjection {
  return buildLiveDirectorControl(control, financeObjects);
}
