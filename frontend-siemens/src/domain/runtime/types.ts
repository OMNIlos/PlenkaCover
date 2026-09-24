import type { OperatorOrderRuntime } from '../operator/types';
import type { WorkObjectsByRole } from '../selectors';
import type { OperatorRollLine, OperatorShift, OrderRollGroup, Role, Severity } from '../types';
import type { DefectBagType } from '../defectBagLabels';

export type DomainEventFamily =
  | 'OperationalEvent'
  | 'AuditEvent'
  | 'ProblemEvent'
  | 'MasterKpiEvent'
  | 'IntegrationEvent';

export type DomainEvent = {
  id: string;
  family: DomainEventFamily;
  type: string;
  objectId: string;
  role: Role;
  label: string;
  detail: string;
  createdAt: string;
};

export type RuntimeProblemStatus = 'open' | 'resolved';

export type ProblemCaseRuntime = {
  id: string;
  objectId: string;
  scope: 'operator' | 'warehouse' | 'finance' | 'director' | 'device' | 'material';
  title: string;
  severity: Severity;
  ownerRole: string;
  reason: string;
  recovery: string;
  status: RuntimeProblemStatus;
  createdAt: string;
};

export type LabelPrintJobRuntime = {
  jobId: string;
  rollId: string;
  printerId: string;
  status: 'requested' | 'printed' | 'failed' | 'reprinted' | 'voided';
  reason?: string;
  replacesJobId?: string;
  createdAt: string;
};

export type DefectRuntime = {
  id: string;
  rollId: string;
  taskId: string;
  orderId?: string;
  acceptanceId?: string;
  sourceRole: 'operator' | 'warehouse';
  weightKg?: number;
  comment: string;
  blocking: boolean;
  createdAt: string;
};

export type QualityDefectStats = {
  totalCount: number;
  operatorCount: number;
  warehouseCount: number;
  blockingCount: number;
  totalWeightKg: number;
  latestLabel: string;
  latestObjectId?: string;
  sourceEventCount: number;
};

export type QualityDefectStatsProjection = {
  summary: QualityDefectStats;
  byTaskId: Record<string, QualityDefectStats>;
  byAcceptanceId: Record<string, QualityDefectStats>;
};

export type CommercialOrderDraftRuntime = {
  id: string;
  sourceObjectId: string;
  status: 'delegated' | 'transferred';
  counterpartyLabel: string;
  positionsLabel: string;
  createdBy: string;
  delegatedAt: string;
};

export type ProductionOrderRuntime = {
  id: string;
  sourceDraftId: string;
  counterpartyLabel: string;
  status: 'waiting_order' | 'approved' | 'operator_task_ready';
  ownerRole: 'Зав. производства';
  assignedOperatorId?: string;
  operatorTaskId?: string;
  blockingReasons: string[];
  approvedAt?: string;
  createdAt: string;
};

export type FinanceOrderRuntime = {
  id: string;
  orderId: string;
  status: 'waiting_invoice' | 'waiting_payment' | 'installment_running' | 'overdue';
  source: 'production_approval' | 'warehouse_delivery';
  counterpartyLabel?: string;
  amountLabel?: string;
  amountPaidLabel?: string;
  amountRemainingLabel?: string;
  dueDateLabel?: string;
  paymentTriggerId?: string;
  createdAt: string;
};

export type WarehouseRollRuntime = {
  id: string;
  sequenceNumber: number;
  status: 'wait_scan' | 'accepted' | 'duplicate' | 'wrong' | 'missing' | 'damaged' | 'blocked_weight' | 'delivered';
  filmType: string;
  micron: string;
  sizeMeters: string;
  plannedNetKg: number;
  tolerancePercent: number;
  qrCode: string;
  controlWeightKg?: number;
  deviationPercent?: number;
};

export type WarehouseAcceptanceRuntime = {
  id: string;
  orderId: string;
  sourceTaskId: string;
  handoverId: string;
  status: 'ready_scan' | 'scan_error' | 'accepted' | 'partial' | 'delivery_ready';
  expectedRollIds: string[];
  scannedRollIds: string[];
  acceptedRollIds: string[];
  missingRollIds: string[];
  excessPayloads: string[];
  lastScan: string;
  scanResult?: string;
  rolls: WarehouseRollRuntime[];
  shiftEvidence?: OperatorShift;
  rollGroups: OrderRollGroup[];
  createdAt: string;
};

export type DeliveryRuntime = {
  id: string;
  acceptanceId: string;
  orderId: string;
  status: 'ready' | 'closed' | 'blocked';
  rollIds: string[];
  closedAt?: string;
};

export type PaymentTriggerRuntime = {
  triggerId: string;
  orderId: string;
  deliveryId: string;
  kind: 'delivery_closed';
  status: 'created' | 'applied';
  createdAt: string;
  installmentStartRule?: 'shipment_plus_1_day';
  installmentStartsAt?: string;
};

export type PenaltyRuntime = {
  penaltyId: string;
  employeeId: string;
  employeeName: string;
  employeeRole: string;
  targetRole: 'operator' | 'production_lead';
  scopeObjectId: string;
  reason: string;
  amountLabel: string;
  author: string;
  status: 'created' | 'issued' | 'notified' | 'disputed' | 'cancelled';
  createdAt: string;
  updatedAt?: string;
  history: {
    id: string;
    time: string;
    actorLabel: string;
    actionLabel: string;
    detail: string;
    oldValue?: string;
    newValue?: string;
  }[];
};

export type PenaltyTrend = 'rising' | 'stable' | 'falling';

export type PenaltyReasonSummary = {
  reason: string;
  count: number;
  amountLabel: string;
  shareLabel: string;
};

export type PenaltyOperatorStats = {
  operatorId: string;
  operatorName: string;
  workplace: string;
  shift: string;
  totalCount: number;
  activeCount: number;
  closedCount: number;
  totalAmountLabel: string;
  lastReason: string;
  lastScopeObjectId: string;
  latestAt: string;
  penaltiesPerTenShiftsLabel: string;
  penaltiesPerHundredRollsLabel: string;
  trend: PenaltyTrend;
  auditCompletenessLabel: string;
  penaltyIds: string[];
};

export type PenaltyPeriodSummary = {
  periodLabel: string;
  totalCount: number;
  activeCount: number;
  closedCount: number;
  totalAmountLabel: string;
  topReasonLabel: string;
  operatorCount: number;
  sourceLabel: string;
  denominatorLabel: string;
};

export type PenaltyAnalyticsProjection = {
  summary: PenaltyPeriodSummary;
  operatorStats: PenaltyOperatorStats[];
  reasonSummary: PenaltyReasonSummary[];
  selectedOperatorId?: string;
};

export type KickbackRuntime = {
  id: string;
  financeOrderId: string;
  amountLabel: string;
  status: 'draft' | 'confirmed' | 'voided';
  visibility: 'director_only' | 'finance_allowed';
  oldValue?: string;
  newValue: string;
  updatedBy: string;
  updatedAt: string;
};

export type DirectorDecisionScope = 'production' | 'finance' | 'warehouse' | 'material' | 'penalty' | 'risk';

export type DirectorDecisionRuntime = {
  id: string;
  scope: DirectorDecisionScope;
  objectId: string;
  summary: string;
  evidence: string;
  ownerRole: string;
  status: 'open' | 'approved' | 'returned';
  severity: Severity;
  createdAt: string;
};

export type DirectorDashboardTone = 'production' | 'money' | 'warehouse' | 'risk' | 'admin';
export type DirectorDashboardScope = DirectorDecisionScope;
export type DashboardTier = 'first_layer' | 'secondary';
export type DashboardSourceFamily = 'OperationalEvent' | 'AuditEvent' | 'ProblemEvent' | 'MasterKpiEvent' | 'runtimeProblem' | 'runtimeDecision';

export type DirectorDashboardDrilldown = {
  section: 'Контроль' | 'Дашборд' | 'Требуют решения' | 'Производство' | 'Финансы' | 'Склад' | 'Сырье' | 'Штрафы' | 'Аудит / QR';
  view: 'decisions' | 'orders';
  filter: 'all' | 'money' | 'warehouse' | 'risk';
  targetObjectId?: string;
};

export type DirectorDashboardMetric = {
  id: string;
  title: string;
  value: string;
  detail: string;
  tone: DirectorDashboardTone;
  severity: Severity;
  periodLabel: string;
  sourceLabel: string;
  denominatorLabel: string;
  actionLabel: string;
  drilldown: DirectorDashboardDrilldown;
};

export type DashboardSituation = {
  id: string;
  title: string;
  detail: string;
  objectId: string;
  scope: DirectorDashboardScope;
  severity: Severity;
  ownerRole: string;
  dueLabel: string;
  recovery: string;
  primaryActionLabel: string;
  evidence: string[];
  sourceLabel: string;
  denominatorLabel: string;
  stalenessLabel?: string;
  basisLabel?: string;
  effectiveAtLabel?: string;
  auditCompletenessLabel?: string;
  allowedActionIds?: string[];
  requiresReason?: boolean;
  drilldown: DirectorDashboardDrilldown;
  sourceEventIds?: string[];
  relatedProblemIds?: string[];
};

export type DashboardHealthSignal = {
  id: string;
  title: string;
  value: string;
  detail: string;
  scope: DirectorDashboardScope;
  severity: Severity;
  ownerRole: string;
  sourceLabel: string;
  denominatorLabel: string;
  stalenessLabel?: string;
  basisLabel?: string;
  effectiveAtLabel?: string;
  drilldown: DirectorDashboardDrilldown;
};

export type DashboardMetricCatalogEntry = {
  id: string;
  role: 'director' | 'productionLead' | 'warehouse' | 'finance' | 'operator';
  tier: DashboardTier;
  sourceLabel: string;
  denominatorLabel: string;
  ownerRole: string;
  drilldownSection: DirectorDashboardDrilldown['section'];
  allowedFirstLayer: boolean;
  sourceEventFamilies: DashboardSourceFamily[];
};

export type DashboardSecondaryMetric = DirectorDashboardMetric & {
  tier: 'secondary';
  catalogId: string;
  ownerRole: string;
  sourceEventFamilies: DashboardSourceFamily[];
};

export type DirectorControlReportTone = 'money' | 'production' | 'risk' | 'neutral';
export type DirectorControlPeriodId = 'today' | 'yesterday' | 'current_week' | 'current_month' | 'previous_month';

export type DirectorControlPeriodOption = {
  id: DirectorControlPeriodId;
  label: string;
  rangeLabel: string;
};

export type DirectorControlReportKpi = {
  id: string;
  label: string;
  value: string;
  caption: string;
  tone: DirectorControlReportTone;
  actionLabel: string;
  drilldown: DirectorDashboardDrilldown;
};

export type DirectorControlPeriodMetric = {
  id: string;
  label: string;
  currentLabel: string;
  previousLabel: string;
  currentValue: number;
  previousValue: number;
  deltaLabel: string;
  tone: DirectorControlReportTone;
  periodLabel: string;
  sourceLabel: string;
  stalenessLabel: string;
  basisLabel: string;
  actionLabel: string;
  drilldown: DirectorDashboardDrilldown;
};

export type DirectorControlFinanceRow = {
  id: string;
  orderId: string;
  customerLabel: string;
  amountLabel: string;
  paidLabel: string;
  remainingLabel: string;
  dueLabel: string;
  statusLabel: string;
  sourceLabel: string;
  riskLabel: string;
  severity: Severity;
  amountValue: number | null;
  remainingValue: number | null;
  dueRank: number | null;
};

export type DirectorControlProductionRow = {
  id: string;
  label: string;
  factLabel: string;
  planLabel: string;
  varianceLabel: string;
  sourceLabel: string;
};

export type DirectorDefectBagStatus =
  | 'weighed'
  | 'ready_for_warehouse'
  | 'received'
  | 'shipped';

export type DirectorDefectBagRegister = {
  totalCount: number;
  totalWeightKg: number;
  byStatus: Array<{
    status: DirectorDefectBagStatus;
    count: number;
    weightKg: number;
  }>;
  byType: Array<{
    defectType: DefectBagType;
    count: number;
    weightKg: number;
  }>;
  unclassified: {
    count: number;
    weightKg: number;
  };
  recent: Array<{
    id: string;
    code: string;
    status: DirectorDefectBagStatus;
    defectType: DefectBagType | null;
    weightKg: number;
    recordedDefectKg: number;
    differenceKg: number;
    operatorName: string;
    postCode: string;
    postName: string;
    shiftLabel: string | null;
    weighedAt: string;
    receivedAt: string | null;
    receivedBy: string | null;
    shippedAt: string | null;
    shippedBy: string | null;
  }>;
  hasMore: boolean;
};

export type DirectorControlPeriodRow = {
  id: string;
  label: string;
  currentLabel: string;
  previousLabel: string;
  deltaLabel: string;
  sourceLabel: string;
  drilldown: DirectorDashboardDrilldown;
};

export type DirectorControlReport = {
  periodLabel: string;
  sourceLabel: string;
  denominatorLabel: string;
  selectedPeriod: DirectorControlPeriodId;
  comparisonPeriod: DirectorControlPeriodId;
  availablePeriods: DirectorControlPeriodOption[];
  kpis: DirectorControlReportKpi[];
  periodMetrics: DirectorControlPeriodMetric[];
  periodRows: DirectorControlPeriodRow[];
  financeRows: DirectorControlFinanceRow[];
  productionRows: DirectorControlProductionRow[];
  defectBags?: DirectorDefectBagRegister | null;
};

export type DirectorDashboardProjection = {
  situations: DashboardSituation[];
  healthSignals: DashboardHealthSignal[];
  secondaryMetrics: DashboardSecondaryMetric[];
  controlReport: DirectorControlReport;
  selectedSituationId?: string;
  evidence: {
    periodLabel: string;
    sourceLabel: string;
    denominatorLabel: string;
  };
};

export type DeviceMockContract = {
  id: string;
  kind: 'scale' | 'scanner' | 'printer' | 'financeSource';
  label?: string;
  workplaceId?: string;
  connectionKind?: string;
  notes?: string;
  sourceSystem?: string;
  severity?: Severity;
  statusLabel?: string;
  testActionLabel?: string;
  status: 'ready' | 'offline' | 'unstable' | 'error' | 'not_required';
  ownerRole: 'Админ' | 'Склад' | 'Бухгалтерия';
  lastSeenAt: string;
  rawPayload: string;
  parsedPayload: string;
  recovery: string;
  secondaryActions?: Array<{
    id: string;
    label: string;
    level?: 'recommended' | 'secondary' | 'destructive';
  }>;
};

export type ProductionRuntimeState = {
  events: DomainEvent[];
  warehouseAcceptances: WarehouseAcceptanceRuntime[];
  deliveries: DeliveryRuntime[];
  paymentTriggers: PaymentTriggerRuntime[];
  problems: ProblemCaseRuntime[];
  labelPrintJobs: LabelPrintJobRuntime[];
  defects: DefectRuntime[];
  penalties: PenaltyRuntime[];
  devices: DeviceMockContract[];
  commercialDrafts: CommercialOrderDraftRuntime[];
  orders: ProductionOrderRuntime[];
  financeOrders: FinanceOrderRuntime[];
  directorDecisions: DirectorDecisionRuntime[];
  kickbacks: KickbackRuntime[];
};

export type RuntimeProjectionByRole = WorkObjectsByRole;

export type RuntimeAction =
  | { type: 'commercial.intake.delegated'; objectId: string; counterpartyLabel?: string; positionsLabel?: string; status?: CommercialOrderDraftRuntime['status'] }
  | { type: 'production.order.approved'; objectId: string; counterpartyLabel?: string }
  | { type: 'operator.handover'; order: OperatorOrderRuntime; roll: OperatorRollLine; shift: OperatorShift }
  | { type: 'operator.label.reprinted'; order: OperatorOrderRuntime; roll: OperatorRollLine; reason: string }
  | { type: 'operator.defect.recorded'; order: OperatorOrderRuntime; roll: OperatorRollLine; comment: string; weightKg?: number }
  | { type: 'warehouse.scan'; acceptanceId: string }
  | { type: 'warehouse.scan_duplicate'; acceptanceId: string }
  | { type: 'warehouse.scan_wrong'; acceptanceId: string; payload?: string }
  | { type: 'warehouse.partial_accept'; acceptanceId: string }
  | { type: 'warehouse.roll_damaged'; acceptanceId: string; rollId: string; reason?: string }
  | { type: 'warehouse.control_weight'; acceptanceId: string; rollId: string }
  | { type: 'warehouse.delivery.close'; acceptanceId: string }
  | { type: 'director.penalty.created'; employeeId: string; employeeName: string; employeeRole: string; scopeObjectId: string; reason: string; amountLabel: string; author: string; authorRole?: 'director' | 'production' }
  | { type: 'director.penalty.updated'; penaltyId: string; employeeId: string; employeeName: string; employeeRole: string; scopeObjectId: string; reason: string; amountLabel: string; author: string; authorRole?: 'director' | 'production' }
  | { type: 'director.kickback.updated'; financeOrderId: string; status: KickbackRuntime['status'] }
  | { type: 'admin.device.created'; device: DeviceMockContract }
  | { type: 'admin.device.updated'; device: DeviceMockContract }
  | { type: 'admin.device.tested'; deviceId: string };
