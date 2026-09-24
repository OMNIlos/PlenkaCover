import type {
  DirectorAccountingProduction,
  DirectorAnalyticsProductionPoint,
  DirectorAnalyticsProductionQualityPoint,
  DirectorAnalyticsRange,
  DirectorCommercialApplications,
} from './director-analytics';
import type {
  PaymentStatus,
  ProductionIndicator,
  ShipmentStatus,
  WarehouseCoverStatus,
} from './statuses';
import type { RollProductionCostView } from './production-cost';

export type CommercialPerformanceSource = {
  kind: 'platform_runtime';
  status: 'ready' | 'partial' | 'unavailable';
  freshness: 'fresh' | 'stale' | 'unknown';
  generatedAt: string;
};

export type CommercialPerformanceControlSummary = {
  invoicedAmount: number;
  paidAmount: number;
  receivableAmount: number;
  overdueAmount: number;
  producedKg: number;
  producedRolls: number;
  defectKg: number;
  defectRollCount: number;
  returnedSpoolCount: number;
  warehouseAcceptedRolls: number;
};

export type CommercialPerformanceControl = {
  range: DirectorAnalyticsRange;
  source: CommercialPerformanceSource;
  summary: CommercialPerformanceControlSummary;
  productionSeries: DirectorAnalyticsProductionPoint[];
  productionQualitySeries: DirectorAnalyticsProductionQualityPoint[];
  accountingProduction: DirectorAccountingProduction;
  commercialApplications: DirectorCommercialApplications;
};

export type CommercialPerformanceFinanceItem = {
  id: string;
  orderNumber: string;
  counterpartyName: string | null;
  invoiceStatus: string;
  paymentStatus: PaymentStatus;
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
  status: string;
  productionCost: RollProductionCostView;
};

export type BusinessPerformanceRollPage = {
  items: BusinessPerformanceRollItem[];
  nextCursor: string | null;
};

type BusinessOperationalProblemBase = {
  id: string;
  orderId: string | null;
  status: 'open' | 'resolved';
  label: string;
  createdAt: string;
  orderNumber: string | null;
  rollCode: string | null;
  machineName: string | null;
  reason: string | null;
};

export type BusinessOperationalProblem =
  | (BusinessOperationalProblemBase & { kind: 'weight_deviation' })
  | (BusinessOperationalProblemBase & { kind: 'general' })
  | (BusinessOperationalProblemBase & { kind: 'raw_material_shortage' })
  | (BusinessOperationalProblemBase & { kind: 'defect' })
  | (BusinessOperationalProblemBase & { kind: 'machine_breakdown' });

export type BusinessOperationalProblemPage = {
  items: BusinessOperationalProblem[];
  nextCursor: string | null;
};

export type CommercialPerformanceProductionItem = {
  id: string;
  orderNumber: string;
  counterpartyName: string | null;
  productionStatus: ProductionIndicator;
  plannedRollCount: number;
  completedRollCount: number;
  plannedKg: number | null;
  actualKg: number | null;
  defectKg: number;
  defectRollCount: number;
  returnedSpoolCount: number;
  updatedAt: string;
};

export type CommercialPerformanceWarehouseItem = {
  id: string;
  orderNumber: string;
  warehouseCoverageStatus: WarehouseCoverStatus;
  shipmentStatus: ShipmentStatus;
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
