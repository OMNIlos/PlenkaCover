import type {
  CommercialWarehouseCoverageEnvelopeView,
  WarehouseCoverageState,
  WarehouseCoverageWorkflowVersion,
} from '../../domain/warehouseCoverage';

export type CommercialBucket = 'incoming' | 'drafts' | 'in_work' | 'completed';
export type CommercialQueueMode = 'current' | 'action_required';
export type CommercialOrderSection = 'Входящие заявки' | 'Черновики' | 'В работе' | 'Выполненные';
export type CommercialQueueModeLabel = 'Текущие' | 'Требуют действий';
export type CommercialRequestType = 'client_order' | 'stock_reserve';

export type CommercialOrderCommentContract = {
  comment: string | null;
  commentVersion: number;
};

export type CommercialTemplatePositionContract = {
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  widthMm?: number | null;
  plannedLengthM?: number | null;
  rawMaterialId?: string | null;
  baseRawMaterialDefinitionId?: string | null;
  recipeDefinitionVersionId?: string | null;
  spoolType?: string | null;
  birka?: string | null;
  manualBirka?: string | null;
  comment?: string | null;
  plannedWeightKg?: number | null;
  recipeParameters?: Array<{ label: string; value: string }> | null;
};

export type CommercialTemplateVersionContract = {
  id: string;
  templateId: string;
  version: number;
  positions: CommercialTemplatePositionContract[];
  createdAt: string;
};

export type CommercialCompletionBlocker =
  | 'cover_unresolved'
  | 'production_incomplete'
  | 'warehouse_acceptance_incomplete'
  | 'warehouse_batch_open'
  | 'blocking_problem'
  | 'facts_unavailable';

export type WarehouseCoverRouteContract = 'production_only' | 'partial_cover' | 'full_cover';

export type WarehouseCoverCriterionContract = {
  expected: string | number | null;
  actual: string | number | null;
  matches: boolean;
};

export type WarehouseCoverCriteriaContract = Record<
  'filmType' | 'actualThickness' | 'birka' | 'spoolType' | 'weight',
  WarehouseCoverCriterionContract
>;

export type WarehouseCoverProposalContract = {
  id: string;
  orderId: string;
  positionId: string;
  version: number;
  route: WarehouseCoverRouteContract;
  status: CommercialOrderSummaryContract['indicators']['warehouseCover'];
  coverQty: number;
  reserveQty: number;
  productionQty: number;
  sourceCapturedAt: string;
  expiresAt: string | null;
  stale: boolean;
  commercialApproved: boolean;
  technicalApproved: boolean;
  matches: Array<{
    rollId: string;
    rollCode: string;
    compatible: boolean;
    criteria: WarehouseCoverCriteriaContract;
  }>;
};

export type CommercialCompletionContract = {
  state: 'incomplete' | 'ready_for_shipment' | 'shipped';
  requestedQty: number;
  fulfilledQty: number;
  blockingReasons: CommercialCompletionBlocker[];
};

export type CommercialCurrentRollResolution = 'finish_old_version' | 'stop_and_apply_new';

export type CommercialProductionProblemContract = {
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
    parameters: Array<{ label: string; value: string }>;
  };
  candidateRolls: Array<{
    rollId: string;
    rollCode: string;
    positionSequence: number;
    status: string;
    eligible: boolean;
  }>;
  createdAt: string;
};

export type CommercialPipelineActionCode =
  | 'promote_draft'
  | 'submit_to_finance'
  | 'request_cover'
  | 'review_cover'
  | 'correct_order_spec'
  | 'send_to_production'
  | 'resolve_problem'
  | 'prepare_shipment';

type CommercialWaitableActionCode =
  | 'delete_order'
  | 'promote_draft'
  | 'resolve_problem'
  | 'send_to_production'
  | 'submit_to_finance'
  | 'prepare_shipment'
  | 'correct_order_spec';

export type CommercialNextActionCode =
  | CommercialPipelineActionCode
  | 'delete_order'
  | 'order_delete_blocked'
  | 'wait_fulfillment'
  | 'stock_available'
  | 'technical_approve_cover'
  | 'wait_coverage'
  | 'wait_coverage_decision'
  | 'wait_invoice'
  | 'wait_payment_terms'
  | 'wait_prepayment'
  | `wait_${CommercialWaitableActionCode}`
  | `wait_coverage_${WarehouseCoverageState}`;

export type CommercialNextActionContract = {
  code: CommercialNextActionCode;
  ownerRole:
    | 'commercial'
    | 'production_lead'
    | 'operator'
    | 'warehouse'
    | 'finance'
    | 'director'
    | 'admin';
  label: string;
  allowed: boolean;
};

export type CommercialOrderSummaryContract = CommercialOrderCommentContract & {
  id: string;
  orderNumber: string;
  title: string | null;
  version: number;
  bucket: CommercialBucket;
  requestType: CommercialRequestType;
  stockBatchCode?: string | null;
  counterparty: {
    id: string;
    displayName: string;
    legalName: string | null;
    inn: string | null;
  } | null;
  positionCount: number;
  requestedQty: number;
  indicators: {
    production:
      | 'not_started'
      | 'needs_production'
      | 'in_production'
      | 'ready'
      | 'needs_approval'
      | 'defect';
    warehouseCover:
      | 'not_checked'
      | 'partial_proposed'
      | 'full_proposed'
      | 'partial_confirmed'
      | 'full_confirmed'
      | 'needs_production'
      | 'recheck_requested'
      | 'rejected';
    payment: 'unpaid' | 'partial' | 'paid' | 'overdue' | 'sync_error' | 'not_applicable';
    shipment: 'not_shipped' | 'partial_shipped' | 'shipped' | 'shipment_problem' | 'not_applicable';
  };
  cancellation?: {
    status: 'active' | 'cancelled';
    version: number;
    cancelledAt: string | null;
    reason: string | null;
    completedRollCount: number;
    remainingCancelledRollCount: number;
  };
  commercialCompletion: CommercialCompletionContract;
  nextAction: CommercialNextActionContract;
  actionPriority: number;
  createdAt: string;
  updatedAt: string;
};

export type CommercialOrderPositionContract = {
  id: string;
  version: number;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  widthMm?: number | null;
  plannedLengthM?: number | null;
  rawMaterialId: string | null;
  baseRawMaterialDefinitionId?: string | null;
  recipeDefinitionVersionId?: string | null;
  recipe?: {
    recipeDefinitionId: string | null;
    recipeDefinitionVersionId: string | null;
    recipeVersionNumber: number | null;
    recipeName: string | null;
    ingredients: Array<{
      rawMaterialDefinitionId: string;
      name: string;
      shareBasisPoints: number;
    }> | null;
  } | null;
  spoolType: string | null;
  birka: string | null;
  manualBirka?: string | null;
  comment: string | null;
  plannedWeightKg: number | null;
  warehouseCoverStatus: CommercialOrderSummaryContract['indicators']['warehouseCover'];
  coveredQty: number;
  productionQty: number;
  fulfilledQty: number;
  blockingReasons: CommercialCompletionBlocker[];
  coverProposals: WarehouseCoverProposalContract[];
};

export type CommercialOrderWarehouseCoverageContract =
  CommercialWarehouseCoverageEnvelopeView;

export type CommercialOrderDetailContract = CommercialOrderSummaryContract & {
  commercialFinanceNote?: string | null;
  creatorRole: CommercialNextActionContract['ownerRole'];
  commercialStage: 'draft' | 'incoming' | 'sent_to_finance' | 'in_work';
  ownerRole: CommercialNextActionContract['ownerRole'];
  productionOrderId: string | null;
  financeSummary: {
    invoiceStatus: string;
    paymentStatus: CommercialOrderSummaryContract['indicators']['payment'];
  } | null;
  edit: {
    parametersAllowed: boolean;
    parametersAmendable: boolean;
    parametersLockReason: 'invoice_issued' | null;
    promoteDraftAllowed: boolean;
    lockedAt: string | null;
  };
  warehouseCoverageWorkflowVersion?: WarehouseCoverageWorkflowVersion;
  warehouseCoverage?: CommercialOrderWarehouseCoverageContract;
  positions: CommercialOrderPositionContract[];
  productionProblems: CommercialProductionProblemContract[];
};

export type CommercialOrderAmendmentResultContract = {
  commandId: string;
  orderId: string;
  orderVersion: number;
  reconciliation: 'applied' | 'needs_production_review';
  affectedPositionIds: string[];
  changedFutureRollIds: string[];
  preservedPhysicalRollIds: string[];
};

export type CommercialOrderCancellationResultContract = CommercialOrderAmendmentResultContract & {
  cancellationStatus: 'active' | 'cancelled';
  cancellationVersion: number;
  completedRollCount: number;
  remainingCancelledRollCount: number;
};

export type CommercialOrderQueryContract = {
  bucket: CommercialBucket;
  mode: CommercialQueueMode;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};

export type CommercialOrderPageContract = {
  items: CommercialOrderSummaryContract[];
  nextCursor: string | null;
};

export type CommercialProblemFilterContract = 'open' | 'resolved' | 'all';

export type CommercialProblemRoleContract =
  | 'commercial'
  | 'production_lead'
  | 'operator'
  | 'warehouse'
  | 'finance'
  | 'director'
  | 'admin';

export type CommercialProblemListItemContract = {
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
  reportedByRole: CommercialProblemRoleContract;
  ownerRole: CommercialProblemRoleContract | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type CommercialProblemPageContract = {
  items: CommercialProblemListItemContract[];
  nextCursor: string | null;
};

export type CommercialProblemQueryContract = {
  filter: CommercialProblemFilterContract;
  cursor?: string;
  limit?: number;
};

export type CommercialRawMaterialRiskContract = {
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
  risk: 'ok' | 'attention' | 'deficit' | 'unknown';
  source: {
    kind: '1C' | 'mock_1C' | 'manual_platform' | 'warehouse_runtime' | 'warehouse_fact';
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

export type CommercialRawMaterialRiskPageContract = {
  items: CommercialRawMaterialRiskContract[];
  nextCursor: string | null;
};

export type CommercialBigBagValueContract = {
  id: string;
  code: string;
  material: string;
  status: 'available' | 'in_use' | 'consumed';
  location: 'warehouse' | 'production';
  currentKg: number;
  currentMeasuredAt: string | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceEffectiveAt: string | null;
};

export type CommercialLoadStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
