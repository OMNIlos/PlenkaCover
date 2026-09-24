import type { SourceKind } from './events';
import type { RecipeIngredientShare } from './recipe-catalog';
import type { Role } from './roles';
import type {
  CommercialWarehouseCoverageProjection,
  WarehouseCoverageProjection,
} from './warehouse-coverage';
import type {
  CommercialStage,
  BigBagLocation,
  BigBagStatus,
  OrderCancellationStatus,
  PaymentStatus,
  PaymentUpdateStatus,
  ProductionIndicator,
  RequestType,
  ShipmentStatus,
  ShipmentUpdateStatus,
  WarehouseCoverStatus,
} from './statuses';

export const COMMERCIAL_BUCKETS = ['incoming', 'drafts', 'in_work', 'completed'] as const;
export type CommercialBucket = (typeof COMMERCIAL_BUCKETS)[number];

export const COMMERCIAL_FILM_TYPES = ['Рукав', 'Полотно', 'Полурукав', 'Фальц'] as const;
export type CommercialFilmType = (typeof COMMERCIAL_FILM_TYPES)[number];

export const COMMERCIAL_BIRKA_OPTIONS = ['ГОСТ', 'i', 'Тех', 'ГОСТ103', 'ГОСТ259'] as const;
export type CommercialBirka = (typeof COMMERCIAL_BIRKA_OPTIONS)[number];

export const COMMERCIAL_SPOOL_OPTIONS = ['Тонкая', 'Толстая'] as const;
export type CommercialSpoolType = (typeof COMMERCIAL_SPOOL_OPTIONS)[number];

export const COMMERCIAL_QUEUE_MODES = ['current', 'action_required'] as const;
export type CommercialQueueMode = (typeof COMMERCIAL_QUEUE_MODES)[number];

export const COMMERCIAL_COMPLETION_STATES = [
  'incomplete',
  'ready_for_shipment',
  'shipped',
] as const;
export type CommercialCompletionState = (typeof COMMERCIAL_COMPLETION_STATES)[number];

export const COMMERCIAL_COMPLETION_BLOCKERS = [
  'cover_unresolved',
  'production_incomplete',
  'warehouse_acceptance_incomplete',
  'warehouse_batch_open',
  'blocking_problem',
  'facts_unavailable',
] as const;
export type CommercialCompletionBlocker = (typeof COMMERCIAL_COMPLETION_BLOCKERS)[number];

export type CommercialCompletion = {
  state: CommercialCompletionState;
  requestedQty: number;
  fulfilledQty: number;
  blockingReasons: CommercialCompletionBlocker[];
};

export const COMMERCIAL_NEXT_ACTION_CODES = [
  'delete_order',
  'order_delete_blocked',
  'promote_draft',
  'resolve_problem',
  'send_to_production',
  'wait_fulfillment',
  'stock_available',
  'review_cover',
  'technical_approve_cover',
  'request_cover',
  'submit_to_finance',
  'prepare_shipment',
  'wait_coverage',
  'correct_order_spec',
  'wait_coverage_decision',
  'wait_invoice',
  'wait_payment_terms',
  'wait_prepayment',
  'wait_delete_order',
  'wait_promote_draft',
  'wait_resolve_problem',
  'wait_send_to_production',
  'wait_submit_to_finance',
  'wait_prepare_shipment',
  'wait_correct_order_spec',
  'wait_coverage_calculating',
  'wait_coverage_awaiting_finance',
  'wait_coverage_production_required',
  'wait_coverage_unknown',
  'wait_coverage_recheck_requested',
  'wait_coverage_warehouse_reserved',
  'wait_coverage_stale',
  'wait_coverage_order_spec_changed',
] as const;
export type CommercialNextActionCode = (typeof COMMERCIAL_NEXT_ACTION_CODES)[number];

export type CommercialWaitableActionCode =
  | 'delete_order'
  | 'promote_draft'
  | 'resolve_problem'
  | 'send_to_production'
  | 'submit_to_finance'
  | 'prepare_shipment'
  | 'correct_order_spec';

export type CommercialNextAction = {
  code: CommercialNextActionCode;
  ownerRole: Role;
  label: string;
  allowed: boolean;
};

export type CommercialOrderIndicators = {
  production: ProductionIndicator;
  warehouseCover: WarehouseCoverStatus;
  payment: PaymentStatus;
  shipment: ShipmentStatus;
};

export type CommercialOrderCancellation = {
  status: OrderCancellationStatus;
  version: number;
  cancelledAt: string | null;
  reason: string | null;
  completedRollCount: number;
  remainingCancelledRollCount: number;
};

export type CommercialRequestSemantics =
  | {
      requestType: 'client_order';
      counterpartyId: string;
      stockBatchCode?: never;
      paymentStatus: PaymentUpdateStatus;
      shipmentStatus: ShipmentUpdateStatus;
    }
  | {
      requestType: 'stock_reserve';
      counterpartyId?: never;
      stockBatchCode?: string;
      paymentStatus: 'not_applicable';
      shipmentStatus: 'not_applicable';
    };

export type CommercialWorkspaceCounterparty = {
  id: string;
  displayName: string;
  legalName: string | null;
  inn: string | null;
};

export type CommercialRecipeSnapshot = {
  recipeDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeVersionNumber: number | null;
  recipeName: string | null;
  ingredients: RecipeIngredientShare[] | null;
};

export type StockProductionTemplateProvenance = {
  id: string;
  name: string;
  versionId: string;
  version: number;
};

export type CommercialOrderComment = {
  comment: string | null;
  commentVersion: number;
};

export type CommercialWorkspaceOrderSummary = CommercialOrderComment & {
  id: string;
  orderNumber: string;
  title: string | null;
  version: number;
  bucket: CommercialBucket;
  requestType: RequestType;
  counterparty: CommercialWorkspaceCounterparty | null;
  stockProductionTemplate: StockProductionTemplateProvenance | null;
  stockBatchCode: string | null;
  positionCount: number;
  requestedQty: number;
  indicators: CommercialOrderIndicators;
  cancellation: CommercialOrderCancellation;
  commercialCompletion: CommercialCompletion;
  nextAction: CommercialNextAction;
  actionPriority: number;
  createdAt: string;
  updatedAt: string;
  warehouseCoverageWorkflowVersion?: 2;
  warehouseCoverage?: WarehouseCoverageProjection;
};

export type CommercialWorkspacePosition = {
  id: string;
  version: number;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  rawMaterialId: string | null;
  baseRawMaterialDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipe: CommercialRecipeSnapshot | null;
  spoolType: string | null;
  birka: string | null;
  manualBirka: string | null;
  comment: string | null;
  plannedWeightKg: number | null;
  widthMm: number | null;
  plannedLengthM: number | null;
  warehouseCoverStatus: WarehouseCoverStatus;
  coveredQty: number;
  productionQty: number;
  fulfilledQty: number;
  blockingReasons: CommercialCompletionBlocker[];
  coverProposals: WarehouseCoverProposalProjection[];
};

export const COMMERCIAL_CURRENT_ROLL_RESOLUTIONS = [
  'finish_old_version',
  'stop_and_apply_new',
] as const;
export type CommercialCurrentRollResolution = (typeof COMMERCIAL_CURRENT_ROLL_RESOLUTIONS)[number];

export type CommercialRecipeParameter = { label: string; value: string };

export type CommercialCorrectionCandidateRoll = {
  rollId: string;
  rollCode: string;
  positionSequence: number;
  status: string;
  eligible: boolean;
};

export type CommercialProductionProblem = {
  id: string;
  type: string;
  status: string;
  reason: string;
  recovery: string | null;
  positionId: string;
  reportedRollId: string;
  currentRollSequence: number;
  completedRolls: number;
  totalRolls: number;
  ownerRole: 'commercial';
  currentRecipe: {
    snapshotId: string;
    version: string;
    parameters: CommercialRecipeParameter[];
  };
  candidateRolls: CommercialCorrectionCandidateRoll[];
  createdAt: string;
};

export type CommercialWorkspaceOrderDetail = Omit<
  CommercialWorkspaceOrderSummary,
  'warehouseCoverage'
> & {
  warehouseCoverage?: CommercialWarehouseCoverageProjection;
  /** Present only in commercial/finance/director projections. */
  commercialFinanceNote?: string | null;
  creatorRole: Role;
  commercialStage: CommercialStage;
  ownerRole: Role;
  productionOrderId: string | null;
  financeSummary: {
    invoiceStatus: string;
    paymentStatus: PaymentStatus;
  } | null;
  edit: {
    parametersAllowed: boolean;
    parametersAmendable: boolean;
    parametersLockReason: 'invoice_issued' | null;
    promoteDraftAllowed: boolean;
    lockedAt: string | null;
  };
  positions: CommercialWorkspacePosition[];
  productionProblems: CommercialProductionProblem[];
};

export const WAREHOUSE_COVER_ROUTES = ['production_only', 'partial_cover', 'full_cover'] as const;
export type WarehouseCoverRoute = (typeof WAREHOUSE_COVER_ROUTES)[number];

export const WAREHOUSE_COVER_CRITERIA = [
  'filmType',
  'actualThickness',
  'birka',
  'spoolType',
  'weight',
] as const;
export type WarehouseCoverCriterion = (typeof WAREHOUSE_COVER_CRITERIA)[number];

export type WarehouseCoverCriterionResult = {
  expected: string | number | null;
  actual: string | number | null;
  matches: boolean;
};

export type WarehouseCoverCriteria = Record<WarehouseCoverCriterion, WarehouseCoverCriterionResult>;

export type WarehouseCoverMatchProjection = {
  rollId: string;
  rollCode: string;
  compatible: boolean;
  criteria: WarehouseCoverCriteria;
};

export type WarehouseCoverProposalProjection = {
  id: string;
  orderId: string;
  positionId: string;
  version: number;
  route: WarehouseCoverRoute;
  status: WarehouseCoverStatus;
  coverQty: number;
  reserveQty: number;
  productionQty: number;
  sourceCapturedAt: string;
  expiresAt: string | null;
  stale: boolean;
  commercialApproved: boolean;
  technicalApproved: boolean;
  matches: WarehouseCoverMatchProjection[];
};

export type CommercialOrderQuery = {
  bucket: CommercialBucket;
  mode: CommercialQueueMode;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};

export type CommercialOrderPage<T = unknown> = {
  items: T[];
  nextCursor: string | null;
};

export const COMMERCIAL_PROBLEM_FILTERS = ['open', 'resolved', 'all'] as const;
export type CommercialProblemFilter = (typeof COMMERCIAL_PROBLEM_FILTERS)[number];

export type CommercialProblemListItem = {
  id: string;
  orderId: string;
  orderNumber: string;
  orderTitle: string | null;
  positionId: string | null;
  positionFilmType: string | null;
  type: string;
  status: string;
  reason: string;
  recovery: string | null;
  reportedByRole: Role;
  ownerRole: Role | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type CommercialProblemPage = {
  items: CommercialProblemListItem[];
  nextCursor: string | null;
};

export const COMMERCIAL_NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type CommercialNotificationSeverity = (typeof COMMERCIAL_NOTIFICATION_SEVERITIES)[number];

export type CommercialNotification = {
  id: string;
  eventType: string;
  severity: CommercialNotificationSeverity;
  orderId: string;
  orderNumber: string;
  title: string;
  body: string;
  createdAt: string;
  unread: boolean;
  nextOwnerRole: Role;
  cta: { kind: 'order' | 'raw_materials'; targetId: string };
};

export type CommercialNotificationPage = CommercialOrderPage<CommercialNotification>;

export const COMMERCIAL_MATERIAL_RISK_STATES = ['ok', 'attention', 'deficit', 'unknown'] as const;
export type CommercialMaterialRiskState = (typeof COMMERCIAL_MATERIAL_RISK_STATES)[number];

export type CommercialRawMaterialRisk = {
  rawMaterialDefinitionId: string;
  materialId: string | null;
  label: string;
  stockAvailability: 'available' | 'unavailable';
  reason: 'stock_fact_missing' | null;
  actualQty: number | null;
  unit: string | null;
  package: string | null;
  oneCQty: number | null;
  oneCUnit: string | null;
  oneCSource: {
    capturedAt: string;
    importedAt: string;
    stale: boolean;
  } | null;
  reservedQty: number | null;
  plannedNeedQty: number | null;
  deficitQty: number | null;
  affectedOrders: Array<{ id: string; orderNumber: string; rollCount: number }>;
  rollsInMovement: number | null;
  risk: CommercialMaterialRiskState;
  source: {
    kind: SourceKind | 'warehouse_fact';
    capturedAt: string;
    stale: boolean;
  } | null;
  planningAvailability: 'available' | 'unavailable';
  planningUnavailableReason:
    | 'planned_weight_missing'
    | 'production_route_unresolved'
    | 'production_facts_inconsistent'
    | 'recipe_snapshot_invalid'
    | null;
  reservationAvailability: 'available' | 'unavailable';
  reservationUnavailableReason: 'reservation_fact_unavailable' | null;
  monetaryMetrics: { available: false };
};

export type CommercialRawMaterialRiskPage = CommercialOrderPage<CommercialRawMaterialRisk>;

export type CommercialBigBagValue = {
  id: string;
  code: string;
  material: string;
  status: BigBagStatus;
  location: BigBagLocation;
  currentKg: number;
  currentMeasuredAt: string | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceEffectiveAt: string | null;
};
