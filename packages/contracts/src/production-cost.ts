import type { Role } from './roles';

export const PRODUCTION_COST_UNRESOLVED_REASONS = [
  'weight_unresolved',
  'material_usage_unresolved',
  'material_price_unresolved',
  'spool_type_unresolved',
  'spool_price_unresolved',
  'spool_geometry_unresolved',
  'payroll_unresolved',
  'order_cost_allocation_unresolved',
  'additional_cost_unresolved',
  'canonical_capture_unresolved',
  'defect_present',
  'operator_step_unresolved',
  'dispatch_not_completed',
  'post_session_not_closed',
  'machine_assignment_not_completed',
  'shift_not_closed',
  'snapshot_pending',
] as const;

export type ProductionCostUnresolvedReason = (typeof PRODUCTION_COST_UNRESOLVED_REASONS)[number];

export const PRODUCTION_COST_UNRESOLVED_LABELS: Record<ProductionCostUnresolvedReason, string> = {
  weight_unresolved: 'Нет подтверждённого веса рулона',
  material_usage_unresolved: 'Не определена рецептура или расход сырья',
  material_price_unresolved: 'Нет цены сырья на дату выпуска',
  spool_type_unresolved: 'Не определён тип шпули',
  spool_price_unresolved: 'Нет цены шпули на дату выпуска',
  spool_geometry_unresolved: 'Нет ширины шпули',
  payroll_unresolved: 'Не рассчитана работа оператора',
  order_cost_allocation_unresolved: 'Не закрыта база распределения расходов заказа',
  additional_cost_unresolved: 'Не определена дополнительная производственная затрата',
  canonical_capture_unresolved: 'Нет канонического замера веса',
  defect_present: 'Рулон отмечен как брак',
  operator_step_unresolved: 'Рулон не передан на склад',
  dispatch_not_completed: 'Выпуск рулона не завершён',
  post_session_not_closed: 'Сеанс оператора не закрыт',
  machine_assignment_not_completed: 'Назначение на станок не завершено',
  shift_not_closed: 'Смена не закрыта',
  snapshot_pending: 'Себестоимость ожидает фонового расчёта',
};

export const PRODUCTION_COST_CALCULATION_VERSION = 'production-cost-v1' as const;

export type ProductionCostBasis =
  | { kind: 'planned'; weightGrams: number }
  | { kind: 'actual'; weightGrams: number };

export type ProductionCostNullableBasis =
  | ProductionCostBasis
  | { kind: 'actual'; weightGrams: null };

export type NonEmptyProductionCostReasons = [
  ProductionCostUnresolvedReason,
  ...ProductionCostUnresolvedReason[],
];

export type ProductionCostPayrollSource = {
  tariffOrderId: string;
  tariffOrderName: string;
  effectiveFrom: string;
  rateKopecksPerKg: number;
  basisLabel: string;
};

export type ProductionCostCompleteAmounts = {
  materialAmountKopecks: number;
  spoolAmountKopecks: number;
  payrollAmountKopecks: number;
  payrollSource: ProductionCostPayrollSource | null;
  additionalAmountKopecks: number;
  totalAmountKopecks: number;
  totalKopecksPerKg: number;
  unresolvedReasons: [];
};

export type ProductionCostPartialAmounts = {
  materialAmountKopecks: number | null;
  spoolAmountKopecks: number | null;
  payrollAmountKopecks: number | null;
  payrollSource: ProductionCostPayrollSource | null;
  additionalAmountKopecks: number;
  totalAmountKopecks: null;
  totalKopecksPerKg: null;
  unresolvedReasons: NonEmptyProductionCostReasons;
};

type RollProductionCostPlannedPreviewBase = {
  kind: 'planned_preview';
  calculationVersion: typeof PRODUCTION_COST_CALCULATION_VERSION;
  basis: Extract<ProductionCostBasis, { kind: 'planned' }>;
};

export type RollProductionCostPlannedPreviewView = RollProductionCostPlannedPreviewBase &
  (
    | (ProductionCostCompleteAmounts & { status: 'complete' })
    | (ProductionCostPartialAmounts & { status: 'partial' })
  );

type PersistedRollProductionCostSnapshotBase = {
  kind: 'actual_snapshot';
  calculationVersion: string;
  snapshotId: string;
  version: number;
  producedAt: string;
  closedAt: string;
  createdAt: string;
  basis: Extract<ProductionCostBasis, { kind: 'actual' }>;
};

export type PersistedRollProductionCostSnapshotView = PersistedRollProductionCostSnapshotBase &
  (
    | (ProductionCostCompleteAmounts & { status: 'complete' })
    | (ProductionCostPartialAmounts & { status: 'partial' })
  );

export type RollProductionCostPendingView = ProductionCostPartialAmounts & {
  kind: 'actual_pending';
  status: 'pending';
  calculationVersion: typeof PRODUCTION_COST_CALCULATION_VERSION;
  basis: Extract<ProductionCostNullableBasis, { kind: 'actual' }>;
};

export type RollProductionCostView =
  | RollProductionCostPlannedPreviewView
  | PersistedRollProductionCostSnapshotView
  | RollProductionCostPendingView;

export type RollProductionCostActualSnapshotView = PersistedRollProductionCostSnapshotView;
export type RollProductionCostActualPendingView = RollProductionCostPendingView;

export type RecordSpoolPriceReferenceInput = {
  operationKey: string;
  spoolTypeLabel: string;
  priceKopecksPerMeter: number;
  source: string;
  effectiveFrom: string;
  reason: string;
};

export type SpoolPriceReferenceView = {
  id: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  priceKopecksPerMeter: number;
  source: string;
  effectiveFrom: string;
  reason: string;
  createdById: string;
  createdByRole: Role;
  createdAt: string;
};

export type SpoolPriceTypeView = {
  key: string;
  label: string;
};

export type RecordSpoolStockReceiptInput = RecordSpoolPriceReferenceInput & {
  quantityMillimeters: number;
};

export type SpoolStockReceiptView = {
  id: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  quantityMillimeters: number;
  priceReferenceId: string;
  priceKopecksPerMeter: number;
  effectiveFrom: string;
  receivedAt: string;
  receivedById: string;
  receivedByRole: Role;
  createdAt: string;
};

export type SpoolStockSummaryItemView = {
  spoolTypeKey: string;
  spoolTypeLabel: string;
  totalReceivedMillimeters: number;
  lastReceivedAt: string | null;
};

export type CorrectRollProductionCostInput = {
  operationKey: string;
  expectedVersion: number;
  reason: string;
};

export type SetMaterialPriceInput = {
  operationKey: string;
  rawMaterialDefinitionId: string;
  priceKopecksPerKg: number;
  source: string;
  effectiveFrom: string;
  reason: string;
};

export type MaterialPriceReferenceView = {
  id: string;
  rawMaterialDefinitionId: string;
  materialName: string;
  priceKopecksPerKg: number;
  source: string;
  effectiveFrom: string;
  reason: string;
  createdAt: string;
};

export type AdditionalProductionCostAllocationBasis = 'direct' | 'finished_net_kg';

export type RecordAdditionalProductionCostInput = {
  operationKey: string;
  rollDispatchItemId?: string;
  productionOrderId?: string;
  amountKopecks: number;
  source: string;
  effectiveAt: string;
  reason: string;
};

export type AdditionalProductionCostView = {
  id: string;
  targetKind: 'roll' | 'order';
  targetId: string;
  allocationBasis: AdditionalProductionCostAllocationBasis;
  amountKopecks: number;
  source: string;
  effectiveAt: string;
  reason: string;
  createdAt: string;
};

export type DirectorRollCostQuery = {
  from: string;
  to: string;
};

export type DirectorRollCostMaterialSource = {
  kind: 'shift_bigbag' | 'material_reference';
  sourceId: string;
  label: string;
  effectiveAt: string;
  consumedKg: number;
  priceKopecksPerKg: number;
  allocatedAmountKopecks: number;
};

export type DirectorRollCostAdditionalSource = {
  id: string;
  allocationBasis: AdditionalProductionCostAllocationBasis;
  source: string;
  effectiveAt: string;
  reason: string;
  allocatedAmountKopecks: number;
};

export type DirectorRollCostPayrollSource = ProductionCostPayrollSource;

export type DirectorRollCostRow = {
  rollId: string;
  rollCode: string;
  orderId: string;
  orderNumber: string;
  producedAt: string;
  netKg: number;
  operatorName: string | null;
  status: 'complete' | 'partial';
  materialAmountKopecks: number | null;
  payrollAmountKopecks: number | null;
  payrollSource: DirectorRollCostPayrollSource | null;
  additionalAmountKopecks: number;
  totalAmountKopecks: number | null;
  materialSources: DirectorRollCostMaterialSource[];
  additionalSources: DirectorRollCostAdditionalSource[];
  unresolvedReasons: ProductionCostUnresolvedReason[];
};

export type DirectorRollCostPreview = {
  status: 'empty' | 'complete' | 'partial';
  range: {
    fromDate: string;
    toDate: string;
    timezone: string;
    generatedAt: string;
  };
  summary: {
    rollCount: number;
    completeRollCount: number;
    partialRollCount: number;
    completeCostKopecks: number;
  };
  rows: DirectorRollCostRow[];
};
