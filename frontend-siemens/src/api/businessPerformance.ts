import type {
  CommercialPerformanceControl,
  CommercialPerformanceControlQuery,
  CommercialPerformanceFinanceItem,
  CommercialPerformancePage,
  CommercialPerformancePageQuery,
  CommercialPerformanceProductionItem,
  CommercialPerformanceSection,
  CommercialPerformanceSource,
  CommercialPerformanceWarehouseItem,
  PaymentPlanKind,
  PaymentPlanLabel,
  ProductionLifecycleStatus,
} from './commercialPerformance';
import { apiGet, apiPost, type ApiRequestOptions } from './client';
import { parseRollProductionCost, type RollProductionCostView } from './productionCost';

export {
  PRODUCTION_COST_CALCULATION_VERSION,
  PRODUCTION_COST_UNRESOLVED_LABELS,
  PRODUCTION_COST_UNRESOLVED_REASONS,
  parseRollProductionCost,
} from './productionCost';
export type {
  PersistedRollProductionCostSnapshotView,
  ProductionCostUnresolvedReason,
  RollProductionCostPendingView,
  RollProductionCostPlannedPreviewView,
  RollProductionCostView,
} from './productionCost';

export type BusinessPerformanceSectionQuery = CommercialPerformancePageQuery & {
  bucket?: CommercialPerformanceControlQuery['bucket'];
};

export type BusinessPerformanceSnapshot =
  | { section: 'Контроль'; data: CommercialPerformanceControl }
  | {
      section: 'Финансы';
      data: CommercialPerformancePage<CommercialPerformanceFinanceItem>;
    }
  | {
      section: 'Производство';
      data: CommercialPerformancePage<CommercialPerformanceProductionItem>;
    }
  | {
      section: 'Склад';
      data: CommercialPerformancePage<CommercialPerformanceWarehouseItem>;
    };

export type BusinessPerformanceSnapshotFor<S extends CommercialPerformanceSection> = Extract<
  BusinessPerformanceSnapshot,
  { section: S }
>;

export type BusinessPerformanceRollItem = {
  id: string;
  rollName: string;
  rollCode: string | null;
  orderNumber: string;
  parameters: {
    filmType: string | null;
    actualThicknessUm: number | null;
    accountingThicknessUm: number | null;
    widthMm: number | null;
    plannedLengthM: number | null;
    weightKg: number | null;
  };
  operatorName: string | null;
  machineName: string | null;
  priority: number | null;
  status: ProductionLifecycleStatus;
  lifecycleStatus: ProductionLifecycleStatus;
  createdAt: string | null;
  completedAt: string | null;
  weights: {
    plannedNetKg: number | null;
    actualNetKg: number | null;
    actualGrossKg: number | null;
    deviationKg: number | null;
  };
  productionCost: RollProductionCostView;
};

export type BusinessPerformanceRollPage = {
  items: BusinessPerformanceRollItem[];
  nextCursor: string | null;
};

export type BusinessOperationalProblemKind =
  | 'general'
  | 'raw_material_shortage'
  | 'weight_deviation'
  | 'defect'
  | 'machine_breakdown';

export type BusinessOperationalProblem = {
  id: string;
  orderId: string | null;
  kind: BusinessOperationalProblemKind;
  status: 'open' | 'resolved';
  label: string;
  createdAt: string;
  orderNumber: string | null;
  rollCode: string | null;
  machineName: string | null;
  reason: string | null;
};

export type BusinessOperationalProblemPage = {
  items: BusinessOperationalProblem[];
  nextCursor: string | null;
};

export type BusinessProductionRollQuery = {
  cursor?: string;
  limit?: number;
};

export type BusinessOperationalProblemQuery = {
  filter?: 'open' | 'resolved' | 'all';
  cursor?: string;
  limit?: number;
};

const INVALID_RESPONSE = 'Некорректные данные бизнес-показателей.';
const PAYMENT_LABEL_BY_KIND = {
  full: '100%',
  half_split: '50/50',
  custom: 'Индивидуально',
  not_set: 'Не задано',
} as const satisfies Record<PaymentPlanKind, PaymentPlanLabel>;

function invalid(): never {
  throw new Error(INVALID_RESPONSE);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const item = record(value);
  const keys = Object.keys(item);
  if (keys.length !== fields.length || !keys.every((key) => fields.includes(key))) invalid();
  return item;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (value === undefined) invalid();
  return stringValue(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (value === undefined) invalid();
  return numberValue(value);
}

function arrayValue<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) invalid();
  return value.map(parse);
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid();
  return value as T[number];
}

function parseSource(value: unknown): CommercialPerformanceSource {
  const source = record(value);
  return {
    kind: enumValue(source.kind, ['platform_runtime'] as const),
    status: enumValue(source.status, ['ready', 'partial', 'unavailable'] as const),
    freshness: enumValue(source.freshness, ['fresh', 'stale', 'unknown'] as const),
    generatedAt: stringValue(source.generatedAt),
  };
}

function parseControl(value: unknown): CommercialPerformanceControl {
  const control = record(value);
  const range = record(control.range);
  const requested = record(range.requested);
  const effective = record(range.effective);
  const summary = record(control.summary);
  const accounting = record(control.accountingProduction);
  const accountingSource = record(accounting.source);
  const accountingCoverage = record(accounting.coverage);
  const applications = record(control.commercialApplications);

  return {
    range: {
      timezone: enumValue(range.timezone, ['Europe/Moscow'] as const),
      requested: {
        from: stringValue(requested.from),
        to: stringValue(requested.to),
      },
      effective: {
        fromUtc: stringValue(effective.fromUtc),
        toExclusiveUtc: stringValue(effective.toExclusiveUtc),
      },
      bucket: enumValue(range.bucket, ['day', 'week', 'month'] as const),
      generatedAt: stringValue(range.generatedAt),
    },
    source: parseSource(control.source),
    summary: {
      invoicedAmount: numberValue(summary.invoicedAmount),
      paidAmount: numberValue(summary.paidAmount),
      receivableAmount: numberValue(summary.receivableAmount),
      overdueAmount: numberValue(summary.overdueAmount),
      producedKg: numberValue(summary.producedKg),
      producedRolls: numberValue(summary.producedRolls),
      defectKg: numberValue(summary.defectKg),
      defectRollCount: numberValue(summary.defectRollCount),
      returnedSpoolCount: numberValue(summary.returnedSpoolCount),
      warehouseAcceptedRolls: numberValue(summary.warehouseAcceptedRolls),
    },
    productionSeries: arrayValue(control.productionSeries, (value) => {
      const point = record(value);
      return {
        bucketStartDate: stringValue(point.bucketStartDate),
        rollCount: numberValue(point.rollCount),
        producedKg: numberValue(point.producedKg),
      };
    }),
    productionQualitySeries: arrayValue(control.productionQualitySeries, (value) => {
      const point = record(value);
      return {
        id: stringValue(point.id),
        bucketStartDate: stringValue(point.bucketStartDate),
        producedRollCount: numberValue(point.producedRollCount),
        producedKg: numberValue(point.producedKg),
        defectRecordCount: numberValue(point.defectRecordCount),
        defectiveRollCount: numberValue(point.defectiveRollCount),
        verifiedDefectKg: numberValue(point.verifiedDefectKg),
        unverifiedDefectCount: numberValue(point.unverifiedDefectCount),
        returnedSpoolCount: numberValue(point.returnedSpoolCount),
      };
    }),
    accountingProduction: {
      source: {
        sourceKind: enumValue(accountingSource.sourceKind, ['1C'] as const),
        label: enumValue(accountingSource.label, ['1С · Отчет производства за смену'] as const),
        latestImportedAt: nullableString(accountingSource.latestImportedAt),
        latestDocumentDate: nullableString(accountingSource.latestDocumentDate),
        stale: booleanValue(accountingSource.stale),
      },
      coverage: {
        documentCount: numberValue(accountingCoverage.documentCount),
        excludedOutputLineCount: numberValue(accountingCoverage.excludedOutputLineCount),
        excludedMaterialLineCount: numberValue(accountingCoverage.excludedMaterialLineCount),
      },
      productionSeries: arrayValue(accounting.productionSeries, (value) => {
        const point = record(value);
        return {
          bucketStartDate: stringValue(point.bucketStartDate),
          documentCount: numberValue(point.documentCount),
          producedKg: numberValue(point.producedKg),
        };
      }),
      materialSeries: arrayValue(accounting.materialSeries, (value) => {
        const point = record(value);
        return {
          bucketStartDate: stringValue(point.bucketStartDate),
          consumedKg: numberValue(point.consumedKg),
        };
      }),
    },
    commercialApplications: {
      definition: enumValue(applications.definition, ['submitted'] as const),
      asOfDate: stringValue(applications.asOfDate),
      periods: arrayValue(applications.periods, (value) => {
        const period = record(value);
        return {
          period: enumValue(period.period, ['week', 'month', '3_months', '6_months'] as const),
          fromDate: stringValue(period.fromDate),
          toDate: stringValue(period.toDate),
          totalCount: numberValue(period.totalCount),
          clientOrderCount: numberValue(period.clientOrderCount),
          stockReserveCount: numberValue(period.stockReserveCount),
        };
      }),
    },
  };
}

function parseFinanceItem(value: unknown): CommercialPerformanceFinanceItem {
  const item = record(value);
  const paymentPlanKind = enumValue(item.paymentPlanKind, [
    'full',
    'half_split',
    'custom',
    'not_set',
  ] as const);
  const paymentPlanLabel = enumValue(item.paymentPlanLabel, [
    '100%',
    '50/50',
    'Индивидуально',
    'Не задано',
  ] as const);
  if (PAYMENT_LABEL_BY_KIND[paymentPlanKind] !== paymentPlanLabel) invalid();

  return {
    id: stringValue(item.id),
    orderNumber: stringValue(item.orderNumber),
    counterpartyName: nullableString(item.counterpartyName),
    invoiceStatus: stringValue(item.invoiceStatus),
    paymentStatus: stringValue(item.paymentStatus),
    paymentPlanKind,
    paymentPlanLabel,
    invoicedAmount: nullableNumber(item.invoicedAmount),
    paidAmount: numberValue(item.paidAmount),
    remainingAmount: nullableNumber(item.remainingAmount),
    nextConfirmedDueAt: nullableString(item.nextConfirmedDueAt),
    updatedAt: stringValue(item.updatedAt),
  };
}

function parseProductionItem(value: unknown): CommercialPerformanceProductionItem {
  const item = record(value);
  return {
    id: stringValue(item.id),
    orderNumber: stringValue(item.orderNumber),
    counterpartyName: nullableString(item.counterpartyName),
    productionStatus: stringValue(item.productionStatus),
    lifecycleStatus: enumValue(item.lifecycleStatus, [
      'in_production',
      'ready_for_warehouse',
      'warehouse_handed_off',
      'warehouse_accepted',
      'warehouse_delivered',
      'defect',
      'unknown',
    ] as const),
    createdAt: stringValue(item.createdAt),
    completedAt: nullableString(item.completedAt),
    plannedRollCount: numberValue(item.plannedRollCount),
    completedRollCount: numberValue(item.completedRollCount),
    plannedKg: nullableNumber(item.plannedKg),
    actualKg: nullableNumber(item.actualKg),
    defectKg: numberValue(item.defectKg),
    defectRollCount: numberValue(item.defectRollCount),
    returnedSpoolCount: numberValue(item.returnedSpoolCount),
    updatedAt: stringValue(item.updatedAt),
  };
}

function parseWarehouseItem(value: unknown): CommercialPerformanceWarehouseItem {
  const item = record(value);
  return {
    id: stringValue(item.id),
    orderNumber: stringValue(item.orderNumber),
    warehouseCoverageStatus: stringValue(item.warehouseCoverageStatus),
    shipmentStatus: stringValue(item.shipmentStatus),
    readyRollCount: numberValue(item.readyRollCount),
    reservedRollCount: numberValue(item.reservedRollCount),
    acceptedRollCount: numberValue(item.acceptedRollCount),
    shippedRollCount: numberValue(item.shippedRollCount),
    updatedAt: stringValue(item.updatedAt),
  };
}

function parsePerformancePage<T>(
  value: unknown,
  parseItem: (item: unknown) => T,
): CommercialPerformancePage<T> {
  const page = record(value);
  return {
    items: arrayValue(page.items, parseItem),
    nextCursor: nullableString(page.nextCursor),
    source: parseSource(page.source),
  };
}

function parseRollItem(value: unknown): BusinessPerformanceRollItem {
  const item = record(value);
  const parameters = record(item.parameters);
  const weights = record(item.weights);
  const lifecycleStatus = enumValue(item.lifecycleStatus, [
    'in_production',
    'ready_for_warehouse',
    'warehouse_handed_off',
    'warehouse_accepted',
    'warehouse_delivered',
    'defect',
    'unknown',
  ] as const);
  return {
    id: stringValue(item.id),
    rollName: stringValue(item.rollName),
    rollCode: nullableString(item.rollCode),
    orderNumber: stringValue(item.orderNumber),
    parameters: {
      filmType: nullableString(parameters.filmType),
      actualThicknessUm: nullableNumber(parameters.actualThicknessUm),
      accountingThicknessUm: nullableNumber(parameters.accountingThicknessUm),
      widthMm: nullableNumber(parameters.widthMm),
      plannedLengthM: nullableNumber(parameters.plannedLengthM),
      weightKg: nullableNumber(parameters.weightKg),
    },
    operatorName: nullableString(item.operatorName),
    machineName: nullableString(item.machineName),
    priority: nullableNumber(item.priority),
    status: lifecycleStatus,
    lifecycleStatus,
    createdAt: nullableString(item.createdAt),
    completedAt: nullableString(item.completedAt),
    weights: {
      plannedNetKg: nullableNumber(weights.plannedNetKg),
      actualNetKg: nullableNumber(weights.actualNetKg),
      actualGrossKg: nullableNumber(weights.actualGrossKg),
      deviationKg: nullableNumber(weights.deviationKg),
    },
    productionCost: parseRollProductionCost(item.productionCost),
  };
}

function parseRollPage(value: unknown): BusinessPerformanceRollPage {
  const page = record(value);
  return {
    items: arrayValue(page.items, parseRollItem),
    nextCursor: nullableString(page.nextCursor),
  };
}

const BUSINESS_OPERATIONAL_PROBLEM_FIELDS = [
  'id',
  'orderId',
  'kind',
  'status',
  'label',
  'createdAt',
  'orderNumber',
  'rollCode',
  'machineName',
  'reason',
] as const;

function parseProblem(value: unknown, exact = false): BusinessOperationalProblem {
  const item = exact ? exactRecord(value, BUSINESS_OPERATIONAL_PROBLEM_FIELDS) : record(value);
  return {
    id: stringValue(item.id),
    orderId: nullableString(item.orderId),
    kind: enumValue(item.kind, [
      'general',
      'raw_material_shortage',
      'weight_deviation',
      'defect',
      'machine_breakdown',
    ] as const),
    status: enumValue(item.status, ['open', 'resolved'] as const),
    label: stringValue(item.label),
    createdAt: stringValue(item.createdAt),
    orderNumber: nullableString(item.orderNumber),
    rollCode: nullableString(item.rollCode),
    machineName: nullableString(item.machineName),
    reason: nullableString(item.reason),
  };
}

function parseProblemPage(value: unknown): BusinessOperationalProblemPage {
  const page = record(value);
  return {
    items: arrayValue(page.items, parseProblem),
    nextCursor: nullableString(page.nextCursor),
  };
}

function rangeParams(query: CommercialPerformancePageQuery) {
  return new URLSearchParams({ from: query.from, to: query.to });
}

function pageParams(query: CommercialPerformancePageQuery) {
  const params = rangeParams(query);
  params.set('limit', String(query.limit ?? 20));
  if (query.cursor) params.set('cursor', query.cursor);
  return params;
}

export async function loadBusinessPerformanceSection<S extends CommercialPerformanceSection>(
  section: S,
  query: BusinessPerformanceSectionQuery,
  options?: ApiRequestOptions,
): Promise<BusinessPerformanceSnapshotFor<S>> {
  if (section === 'Контроль') {
    const bucket = enumValue(query.bucket, ['day', 'week', 'month'] as const);
    const params = rangeParams(query);
    params.set('bucket', bucket);
    const response = await apiGet<unknown>(
      `/api/commercial/performance/control?${params.toString()}`,
      options,
    );
    return {
      section,
      data: parseControl(response),
    } as BusinessPerformanceSnapshotFor<S>;
  }

  const params = pageParams(query);
  if (section === 'Финансы') {
    const response = await apiGet<unknown>(
      `/api/commercial/performance/finance?${params.toString()}`,
      options,
    );
    return {
      section,
      data: parsePerformancePage(response, parseFinanceItem),
    } as BusinessPerformanceSnapshotFor<S>;
  }
  if (section === 'Производство') {
    const response = await apiGet<unknown>(
      `/api/commercial/performance/production?${params.toString()}`,
      options,
    );
    return {
      section,
      data: parsePerformancePage(response, parseProductionItem),
    } as BusinessPerformanceSnapshotFor<S>;
  }
  if (section === 'Склад') {
    const response = await apiGet<unknown>(
      `/api/commercial/performance/warehouse?${params.toString()}`,
      options,
    );
    return {
      section,
      data: parsePerformancePage(response, parseWarehouseItem),
    } as BusinessPerformanceSnapshotFor<S>;
  }
  return invalid();
}

export async function loadBusinessProductionRolls(
  productionOrderId: string,
  query: BusinessProductionRollQuery = {},
  options?: ApiRequestOptions,
): Promise<BusinessPerformanceRollPage> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 20) });
  if (query.cursor) params.set('cursor', query.cursor);
  const response = await apiGet<unknown>(
    `/api/commercial/performance/production/${encodeURIComponent(
      productionOrderId,
    )}/rolls?${params.toString()}`,
    options,
  );
  return parseRollPage(response);
}

export async function loadBusinessOperationalProblems(
  query: BusinessOperationalProblemQuery = {},
  options?: ApiRequestOptions,
): Promise<BusinessOperationalProblemPage> {
  const params = new URLSearchParams();
  if (query.filter) params.set('filter', query.filter);
  params.set('limit', String(query.limit ?? 20));
  if (query.cursor) params.set('cursor', query.cursor);
  const response = await apiGet<unknown>(
    `/api/commercial/performance/problems?${params.toString()}`,
    options,
  );
  return parseProblemPage(response);
}

export async function loadBusinessOperationalProblem(
  problemId: string,
  options?: ApiRequestOptions,
): Promise<BusinessOperationalProblem> {
  const response = await apiGet<unknown>(
    `/api/commercial/performance/problems/${encodeURIComponent(problemId)}`,
    options,
  );
  const problem = parseProblem(response, true);
  if (problem.id !== problemId) invalid();
  return problem;
}

export function resolveBusinessOperationalProblem(
  problemId: string,
  input: {
    resolution: 'rework' | 'writeoff' | 'confirm' | 'reject';
    note: string;
  },
) {
  return apiPost<unknown>(
    `/api/commercial/performance/problems/${encodeURIComponent(problemId)}/resolve`,
    {
      resolution: input.resolution,
      note: input.note,
    },
  );
}
