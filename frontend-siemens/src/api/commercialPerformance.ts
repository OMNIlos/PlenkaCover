import { loadBusinessPerformanceSection } from './businessPerformance';
import { apiGet, type ApiRequestOptions } from './client';
import type { ServerDirectorAccountingProduction } from './director';

export {
  loadBusinessOperationalProblems,
  loadBusinessPerformanceSection,
  loadBusinessProductionRolls,
} from './businessPerformance';
export type {
  BusinessOperationalProblem,
  BusinessOperationalProblemKind,
  BusinessOperationalProblemPage,
  BusinessOperationalProblemQuery,
  BusinessPerformanceRollItem,
  BusinessPerformanceRollPage,
  BusinessPerformanceSectionQuery,
  BusinessPerformanceSnapshot,
  BusinessPerformanceSnapshotFor,
  BusinessProductionRollQuery,
} from './businessPerformance';

export type CommercialPerformanceSection = 'Контроль' | 'Финансы' | 'Производство' | 'Склад';

export type CommercialPerformanceSource = {
  kind: 'platform_runtime';
  status: 'ready' | 'partial' | 'unavailable';
  freshness: 'fresh' | 'stale' | 'unknown';
  generatedAt: string;
};

export type CommercialPerformanceRangeQuery = {
  from: string;
  to: string;
};

export type CommercialPerformanceControlQuery = CommercialPerformanceRangeQuery & {
  bucket: 'day' | 'week' | 'month';
};

export type CommercialPerformancePageQuery = CommercialPerformanceRangeQuery & {
  cursor?: string;
  limit?: number;
};

export type CommercialPerformanceControl = {
  range: {
    timezone: 'Europe/Moscow';
    requested: CommercialPerformanceRangeQuery;
    effective: { fromUtc: string; toExclusiveUtc: string };
    bucket: CommercialPerformanceControlQuery['bucket'];
    generatedAt: string;
  };
  source: CommercialPerformanceSource;
  summary: {
    invoicedAmount: number;
    paidAmount: number;
    receivableAmount: number;
    overdueAmount: number;
    producedKg: number;
    producedRolls: number;
    defectKg: number;
    defectRollCount?: number;
    returnedSpoolCount?: number;
    warehouseAcceptedRolls: number;
  };
  productionSeries: Array<{
    bucketStartDate: string;
    rollCount: number;
    producedKg: number;
  }>;
  productionQualitySeries: Array<{
    id: string;
    bucketStartDate: string;
    producedRollCount: number;
    producedKg: number;
    defectRecordCount: number;
    defectiveRollCount: number;
    verifiedDefectKg: number;
    unverifiedDefectCount: number;
    returnedSpoolCount?: number;
  }>;
  accountingProduction: ServerDirectorAccountingProduction;
  commercialApplications: {
    definition: 'submitted';
    asOfDate: string;
    periods: Array<{
      period: 'week' | 'month' | '3_months' | '6_months';
      fromDate: string;
      toDate: string;
      totalCount: number;
      clientOrderCount: number;
      stockReserveCount: number;
    }>;
  };
};

export type CommercialPerformanceFinanceItem = {
  id: string;
  orderNumber: string;
  counterpartyName: string | null;
  invoiceStatus: string;
  paymentStatus: string;
  paymentPlanKind: PaymentPlanKind;
  paymentPlanLabel: PaymentPlanLabel;
  invoicedAmount: number | null;
  paidAmount: number;
  remainingAmount: number | null;
  nextConfirmedDueAt: string | null;
  updatedAt: string;
};

export type PaymentPlanKind = 'full' | 'half_split' | 'custom' | 'not_set';

export type PaymentPlanLabel = '100%' | '50/50' | 'Индивидуально' | 'Не задано';

export type ProductionLifecycleStatus =
  | 'in_production'
  | 'ready_for_warehouse'
  | 'warehouse_handed_off'
  | 'warehouse_accepted'
  | 'warehouse_delivered'
  | 'defect'
  | 'unknown';

export type CommercialPerformanceProductionItem = {
  id: string;
  orderNumber: string;
  counterpartyName: string | null;
  productionStatus: string;
  lifecycleStatus: ProductionLifecycleStatus;
  createdAt: string;
  completedAt: string | null;
  plannedRollCount: number;
  completedRollCount: number;
  plannedKg: number | null;
  actualKg: number | null;
  defectKg: number;
  defectRollCount?: number;
  returnedSpoolCount?: number;
  updatedAt: string;
};

export type CommercialPerformanceWarehouseItem = {
  id: string;
  orderNumber: string;
  warehouseCoverageStatus: string;
  shipmentStatus: string;
  readyRollCount: number;
  reservedRollCount: number;
  acceptedRollCount: number;
  shippedRollCount: number;
  updatedAt: string;
};

export type CommercialPerformancePage<T> = {
  items: T[];
  nextCursor: string | null;
  source: CommercialPerformanceSource;
};

export type WarehouseBusinessStatus = 'awaiting_shipment' | 'reserve' | 'processing';

export type WarehouseBusinessTemplate = {
  fingerprint: string;
  filmType: string;
  actualThicknessMicron: number;
  accountingThicknessMicron: number;
  widthMm: number;
  plannedLengthM: number;
  birka: string;
  spoolType: string;
  plannedWeightKg: number;
  recipeVersion: string | null;
};

export type WarehouseBusinessRow = {
  kind: 'client_order' | 'reserve';
  id: string;
  templates: WarehouseBusinessTemplate[];
  status: WarehouseBusinessStatus;
  orderNumber: string | null;
  counterpartyName: string | null;
};

export type WarehouseBusinessPage = {
  items: WarehouseBusinessRow[];
  page: number;
  pageSize: number;
  total: number;
};

export type WarehouseBusinessQuery = {
  page?: number;
  pageSize?: number;
};

function warehouseBusinessParams(query: WarehouseBusinessQuery) {
  return new URLSearchParams({
    page: String(query.page ?? 1),
    pageSize: String(query.pageSize ?? 50),
  });
}

export function fetchCommercialWarehouseBusiness(
  query: WarehouseBusinessQuery = {},
  options?: ApiRequestOptions,
): Promise<WarehouseBusinessPage> {
  const params = warehouseBusinessParams(query);
  return apiGet<WarehouseBusinessPage>(
    `/api/commercial/performance/warehouse?${params.toString()}`,
    options,
  );
}

export async function fetchCommercialPerformanceControl(
  query: CommercialPerformanceControlQuery,
  options?: ApiRequestOptions,
) {
  const snapshot = await loadBusinessPerformanceSection('Контроль', query, options);
  return snapshot.data;
}

export async function fetchCommercialPerformanceFinance(
  query: CommercialPerformancePageQuery,
  options?: ApiRequestOptions,
) {
  const snapshot = await loadBusinessPerformanceSection('Финансы', query, options);
  return snapshot.data;
}

export async function fetchCommercialPerformanceProduction(
  query: CommercialPerformancePageQuery,
  options?: ApiRequestOptions,
) {
  const snapshot = await loadBusinessPerformanceSection('Производство', query, options);
  return snapshot.data;
}

export async function fetchCommercialPerformanceWarehouse(
  query: CommercialPerformancePageQuery,
  options?: ApiRequestOptions,
) {
  const snapshot = await loadBusinessPerformanceSection('Склад', query, options);
  return snapshot.data;
}
