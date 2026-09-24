import type { WarehouseCoverageView } from './warehouseCoverage';
import type { OperatorReportableProblemType } from './operatorProblem';
import type { PalletListTemplateVersion } from './palletListProfiles';
import type { DefectBagType } from './defectBagLabels';

export type { PalletListTemplateVersion } from './palletListProfiles';

export type Role =
  | 'commercial'
  | 'production'
  | 'finance'
  | 'director'
  | 'operator'
  | 'warehouse'
  | 'admin';

export type PermissionCapability =
  | 'commercial.view'
  | 'commercial.manage'
  | 'business_performance.view_safe'
  | 'finance.view_safe'
  | 'finance.view_full'
  | 'finance.mutate'
  | 'finance.override'
  | 'production.view'
  | 'production.mutate'
  | 'production.override'
  | 'warehouse.view'
  | 'warehouse.scan'
  | 'qr.history.view'
  | 'qr.print'
  | 'qr.scan'
  | 'qr.reprint_with_reason'
  | 'warehouse.override'
  | 'raw_material.view_summary'
  | 'raw_material.view_usage'
  | 'raw_material.mutate_stock'
  | 'raw_material.view_accounting_reference'
  | 'material_cost.view'
  | 'material_cost.edit'
  | 'material_cost.override'
  | 'material_cost.source_config'
  | 'audit.view'
  | 'audit.view_full'
  | 'sensitive_finance.view'
  | 'penalty.view'
  | 'penalty.create'
  | 'admin.raw_diagnostics'
  | 'admin.access_manage'
  | 'pallet_label_layout:manage'
  | 'device.recover'
  | 'operator.execute'
  | 'operator.payroll.view_self';

export type SeniorAccessScope = 'none' | 'senior_commercial' | 'supervisor_override';

export type OverrideReason = {
  required: boolean;
  label: string;
  evidenceRequired: boolean;
};

export type OverrideAction = {
  id: string;
  label: string;
  capability: PermissionCapability;
  reason: OverrideReason;
  auditEvent:
    | 'audit:director_finance_override_requested'
    | 'audit:director_finance_override_applied'
    | 'audit:director_production_override_applied'
    | 'audit:director_warehouse_override_applied'
    | 'audit:senior_access_viewed';
};

export type RoleAccessPolicy = {
  role: Role;
  seniorAccessScope: SeniorAccessScope;
  visibleSections: string[];
  hiddenScopes: FactScope[];
  capabilities: PermissionCapability[];
  accessSummary: string[];
};

export type Severity = 'info' | 'warning' | 'critical';

export type ActionLevel = 'recommended' | 'peer' | 'secondary' | 'destructive' | 'disabled';

export type ActionIntent =
  | 'mutate'
  | 'advance'
  | 'navigate'
  | 'inspect'
  | 'disclose'
  | 'destructive';

export type WorkObjectKind =
  | 'intake'
  | 'productionOrder'
  | 'financeOrder'
  | 'directorDecision'
  | 'operatorTask'
  | 'warehouseJob'
  | 'adminEntity';

export type WorkQueueBucket = 'active' | 'scheduled' | 'blocked' | 'completed' | 'archived';

export type QueueDateScope = 'all' | 'undated' | string;

export type ReportableEntityKind =
  | 'order'
  | 'production_order'
  | 'position'
  | 'roll'
  | 'qr_label'
  | 'weight_device'
  | 'warehouse_acceptance'
  | 'warehouse_delivery'
  | 'payment'
  | 'invoice'
  | 'source'
  | 'inventory'
  | 'access'
  | 'admin_device'
  | 'problem';

export type ProblemType =
  | 'production_change'
  | 'weight_deviation'
  | 'device_failure'
  | 'qr_exception'
  | 'warehouse_exception'
  | 'payment_issue'
  | 'source_sync'
  | 'inventory_conflict'
  | 'access_issue'
  | 'manual_review';

export type RequestCreatorRole = 'commercial' | 'production_lead';

export type RecipeOwnerRole = 'commercial';

export type CommercialConfirmationPolicy = 'required' | 'bypassed_by_delegation';

export type CommercialRequestType = 'клиентский заказ' | 'на склад/резерв';

export type CommercialRequestStatus = 'draft' | 'in_work' | 'closed';

export type CounterpartyType = 'legal_entity' | 'individual_entrepreneur' | 'individual';

export type ProductionStatus = 'not_started' | 'needs_production' | 'in_production' | 'ready';

export type WarehouseCoverStatus =
  | 'not_checked'
  | 'partial_proposed'
  | 'full_proposed'
  | 'partial_confirmed'
  | 'full_confirmed'
  | 'needs_production'
  | 'recheck_requested'
  | 'rejected';

export type CommercialPaymentStatus = 'оплачен' | 'частично оплачен' | 'не оплачен' | 'просрочка';

export type ShipmentStatus =
  | 'не отгружено'
  | 'частично отгружено'
  | 'отгружено'
  | 'проблема отгрузки';

export type WarehouseRollOwnership =
  | 'customer_owned'
  | 'free_reserve'
  | 'reserved_for_order'
  | 'shipped';

export type ProductionPriority = 'обычный' | 'срочно' | 'критично';

export type RollStickerStatus =
  | 'not_printed'
  | 'submitted'
  | 'printed'
  | 'applied'
  | 'verified'
  | 'error';

export type RollWarehouseUiStatus = 'not_sent' | 'sent' | 'in_stock' | 'shipped' | 'error';

export type RecipeSnapshot = {
  id: string;
  positionId: string;
  recipeOwnerRole: RecipeOwnerRole;
  parameters: Array<{ label: string; value: string }>;
  source: 'commercial_form' | 'production_lead_form' | 'template';
  createdBy: string;
  createdAt: string;
  version: string;
};

export type RecipeMaterialLineKind = 'raw_material' | 'additive' | 'consumable';

export type OrderRawMaterial = {
  rawMaterialId: string;
  label: string;
  materialKind?: RecipeMaterialLineKind;
  nominalQty: number;
  unit: string;
  recipeSharePct?: number;
  costReferenceId?: string;
  accountingSource: 'order_entry' | '1C_snapshot' | 'manual_reference';
  referenceSnapshotId?: string;
};

export type CommercialOrderPosition = {
  id: string;
  draftId: string;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  widthMm?: number;
  plannedLengthM?: number;
  plannedWeightKg?: number;
  rawMaterialId?: string;
  rawMaterialLabel: string;
  rawMaterials?: OrderRawMaterial[];
  spoolType: string;
  birka: string;
  manualBirka?: string;
  comment?: string;
  recipeSnapshot: RecipeSnapshot;
  warehouseCoverStatus: WarehouseCoverStatus;
};

export type PositionTemplateApplication = {
  id: string;
  orderId: string;
  positionId: string;
  templateId: string;
  templateVersionId: string;
  diffAcceptedAt: string;
  appliedAt?: string;
  createdFromPosition?: boolean;
  appliesFromRollNumber?: number;
};

export type WarehouseCoverProposal = {
  id: string;
  positionId: string;
  matchedRolls: Array<{
    id: string;
    ownership: WarehouseRollOwnership;
    qty: number;
    label: string;
    plannedNetKg?: number;
    stickerStatus?: RollStickerStatus;
    warehouseUiStatus?: RollWarehouseUiStatus;
  }>;
  coverType: 'partial' | 'full';
  coverQty: number;
  missingQty: number;
  reserveQty?: number;
  productionQty?: number;
  warehouseCoverStatus: WarehouseCoverStatus;
  requiresConfirmation: true;
  decision?: 'pending' | 'confirmed' | 'rejected' | 'edited_then_confirmed';
  confirmedBy?: string;
  confirmedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  editedPositionVersion?: string;
};

export type WarehouseCoverTaskPosition = {
  id: string;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  rawMaterialId: string | null;
  spoolType: string | null;
  birka: string | null;
  plannedWeightKg: number | null;
  warehouseCoverStatus: WarehouseCoverStatus;
};

/** Safe warehouse-owned projection. Legal, finance and diagnostics fields are not part of it. */
export type WarehouseCoverTask = {
  caseId: string;
  orderId: string;
  orderNumber: string;
  customerAlias: string;
  state: 'open';
  requestedAt: string;
  updatedAt: string;
  positions: WarehouseCoverTaskPosition[];
};

export type WarehouseCoverFreeRollFacts = {
  filmType: string | null;
  actualThickness: string | null;
  birka: string | null;
  spoolType: string | null;
  plannedWeightKg: number | null;
};

/** Deliberately excludes raw position snapshots and source identifiers. */
export type WarehouseCoverFreeRoll = {
  id: string;
  rollCode: string;
  warehouseStatus: string;
  facts: WarehouseCoverFreeRollFacts;
};

export type CommercialPaymentIndicator = {
  orderId: string;
  paymentStatus: CommercialPaymentStatus;
  label: string;
  severity: Severity;
  lastUpdatedAt: string;
  source: '1C' | 'mock_1C';
  syncedAt?: string;
};

export type ProductionRollMachineAssignmentSource =
  | 'shift_default'
  | 'manual_override'
  | 'manual'
  | 'unassigned';

export type OperatorLoadState = 'available' | 'near_limit' | 'overloaded' | 'blocked';

export type OperatorWorkload = {
  operatorId: string;
  operatorLabel: string;
  shiftId?: string;
  defaultMachineId?: string;
  defaultMachineLabel?: string;
  assignedRollIds: string[];
  assignedRollCount: number;
  plannedWeightKg?: number;
  plannedMeterageMeters: number;
  estimatedMinutesTotal: number;
  capacityKnown: boolean;
  shiftCapacityMinutes: number;
  remainingShiftMinutes: number;
  availableCapacityMinutes: number;
  averageRollMinutes: number;
  capacityBasisLabel: string;
  overCapacityMinutes: number;
  canAcceptRollCount: number;
  loadState: OperatorLoadState;
};

export type ProductionRollDispatchItem = {
  id: string;
  productionOrderId: string;
  orderId: string;
  orderNumber?: string;
  orderLineId: string;
  rollId: string;
  sequenceNumber: number;
  queueRank?: number;
  customerAlias: string;
  operatorId: string;
  operatorLabel: string;
  machineId: string;
  machineLabel: string;
  defaultMachineIdSnapshot?: string;
  defaultMachineLabelSnapshot?: string;
  machineAssignmentSource?: ProductionRollMachineAssignmentSource;
  manualMachineOverride?: boolean;
  machineOverrideReason?: string;
  machineAssignedBy: string;
  machineAssignedAt: string;
  machineAssignmentRequired: true;
  shiftId?: string;
  publicationState?: 'draft' | 'published';
  assignedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  priority: ProductionPriority;
  plannedNetKg?: number;
  actualNetKg?: number;
  meterageMeters?: number;
  estimatedMinutes?: number;
  characteristics: string;
  filmType: string;
  actualThickness?: string;
  accountingThickness?: string;
  widthMm?: number;
  plannedLengthM?: number;
  micron: string;
  sizeMeters: string;
  status:
    | 'queued'
    | 'assigned'
    | 'in_work'
    | 'handover_ready'
    | 'warehouse_pending'
    | 'warehouse_handed_off'
    | 'warehouse_accepted'
    | 'warehouse_delivered'
    | 'blocked';
  blocker?: string;
  auditEvent:
    | 'audit:roll_dispatch_assigned'
    | 'audit:machine_assigned'
    | 'audit:production_roll_machine_default_applied'
    | 'audit:production_roll_machine_overridden'
    | 'audit:production_queue_reordered'
    | 'audit:production_priority_changed';
};

export type BigBagUnit = {
  id: string;
  qrCode: string;
  materialLabel: string;
  startKg?: number;
  endKg?: number;
  expectedEndKg?: number;
  lastActorLabel: string;
  lastEventAt: string;
  weightSource: 'manual_after_physical_weighing' | 'scale_contract_mock';
  linkedRollIds: string[];
  auditEvent: 'audit:bigbag_weight_recorded' | 'audit:bigbag_scan_recorded';
};

export type MaterialCostBasis =
  | 'material_price_reference'
  | 'accounting_1c'
  | 'manual_override'
  | 'purchase_actual'
  | 'weighted_average'
  | 'batch'
  | 'unknown';

export type MaterialCostSource = '1C_snapshot' | 'manual_platform' | 'discovery_pending';

export type MaterialCostReference = {
  id: string;
  materialId: string;
  label: string;
  materialKind?: RecipeMaterialLineKind;
  basis: MaterialCostBasis;
  unitPriceRub?: number;
  valueLabel: string;
  currency: 'RUB';
  source: MaterialCostSource;
  sourceLabel: string;
  status: 'accounting_reference' | 'manual_override' | 'source_missing' | 'ready_after_discovery';
  effectiveAt: string;
  updatedAt: string;
  updatedBy: string;
  approvedBy?: string;
  reason: string;
  auditTrail: Array<{
    id: string;
    actorLabel: string;
    actionLabel: 'audit:material_cost_reference_updated' | 'audit:material_cost_reference_approved';
    oldValue?: string;
    newValue: string;
    reason: string;
    time: string;
  }>;
};

export type PalletListDocument = {
  id: string;
  palletId: string;
  status: 'mock_preview' | 'contract_only' | 'ready';
  formatLabel:
    | 'mock preview'
    | 'client sample required'
    | 'согласуем по образцу клиента'
    | 'системная печать'
    | 'PDF'
    | 'Excel'
    | 'Word';
  fields: Fact[];
  rollIds: string[];
  orderIds?: string[];
  warehousePalletId?: string | null;
  origin?: 'physical_pallet' | 'legacy';
  /** Server-owned lifecycle. Physical documents without a recognized value are fail-closed. */
  documentStatus?: 'sealed' | 'voided' | 'unknown';
  rollCount?: number;
  orderId?: string | null;
  generatedBy?: string;
  generatedAt?: string;
  templateVersion?: PalletListTemplateVersion;
  printReady?: boolean;
  printStatus?: 'not_printed' | 'submitted' | 'failed' | 'needs_admin';
  fieldSetStatus?: 'client_sample_required' | 'contract_ready' | 'mock_only';
  availableFormats?: Array<'word' | 'excel' | 'pdf'>;
  exportRequests?: Array<{
    id: string;
    format: 'word' | 'excel' | 'pdf';
    status: 'ready_to_request' | 'requested' | 'download_ready' | 'failed';
    requestedBy?: string;
    requestedAt?: string;
  }>;
  sourceLabel: string;
  auditEvent:
    | 'audit:pallet_list_print_requested'
    | 'audit:pallet_list_export_requested'
    | 'integration:pallet_list_export_requested';
};

export type CounterpartyBillingSnapshot = {
  id: string;
  counterpartyId?: string;
  label: string;
  type: CounterpartyType;
  inn?: string;
  kpp?: string;
  ogrn?: string;
  legalAddress?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  source: 'manual_order_entry' | 'counterparty_card_snapshot' | 'mock_1C_snapshot';
  syncStatus: 'manual_not_synced' | 'needs_1C_discovery' | 'mock_snapshot';
  createdBy: string;
  createdAt: string;
};

export type RawMaterialStock = {
  id: string;
  rawMaterialId: string;
  rawMaterialDefinitionId?: string | null;
  label: string;
  materialKind: 'primary' | 'secondary' | 'additive' | 'unclassified';
  qty: number;
  actualQty: number;
  unit: string;
  packageQty?: string;
  source: '1C' | 'warehouse_fact' | 'manual_platform' | 'mock' | 'unknown';
  sourceOfTruthStatus:
    | 'актуально'
    | 'ручная корректировка'
    | 'расхождение с 1С'
    | 'требует пересчета';
  updatedAt: string;
  referenceQty?: number;
  referenceSource?: string;
  referenceSnapshotId?: string;
  warehouseZone?: string;
  updatedByRole?: 'warehouse';
};

export type WarehouseInventoryCategory = 'raw' | 'rolls' | 'reserve' | 'consumables' | 'movements';

export type WarehouseInventoryOverride = {
  id: string;
  category: WarehouseInventoryCategory;
  title: string;
  subtitle: string;
  characteristic?: string;
  characteristicDetail?: string;
  actualQty: number;
  weightKg?: number;
  unit: string;
  secondaryQty?: string;
  status: string;
  source: 'warehouse_fact' | 'manual_platform';
  severity?: Severity;
  packageQty?: string;
  warehouseZone?: string;
  linkedOrderId?: string;
  documentRef?: string;
  comment?: string;
  reason: string;
  updatedAt: string;
  updatedByRole: 'warehouse';
};

export type InventoryMutationKind =
  | 'create'
  | 'edit'
  | 'receive'
  | 'write_off'
  | 'reserve'
  | 'release_reserve'
  | 'correction';

export type InventoryMutation = {
  id: string;
  materialId: string;
  materialLabel: string;
  kind: InventoryMutationKind;
  oldQty: number;
  deltaQty: number;
  newQty: number;
  unit: string;
  reason: string;
  actorRole: 'warehouse';
  actorLabel: string;
  createdAt: string;
  source: 'warehouse_fact' | 'manual_platform';
  linkedOrderId?: string;
  blocked?: boolean;
  recovery?: string;
};

export type WarehouseStockMutationDraft = {
  materialId: string;
  kind: InventoryMutationKind;
  qty: number;
  weightKg?: number;
  reason: string;
  category?: WarehouseInventoryCategory;
  linkedOrderId?: string;
  label?: string;
  subtitle?: string;
  characteristic?: string;
  characteristicDetail?: string;
  materialKind?: RawMaterialStock['materialKind'];
  unit?: string;
  packageQty?: string;
  warehouseZone?: string;
  documentRef?: string;
  comment?: string;
};

export type RawMaterialUsageSummary = {
  rawMaterialId: string;
  label: string;
  materialKind: RawMaterialStock['materialKind'];
  actualQty: number;
  plannedUsageQty: number;
  recordedUsageQty: number;
  reservedQty: number;
  availableAfterPlanQty: number;
  unit: string;
  source: RawMaterialStock['source'] | 'order_positions' | 'audit_events';
  sourceStatus: 'актуально' | 'план' | 'записано событием' | 'дефицит' | 'расхождение с учетом';
  lastUpdatedAt: string;
  referenceQty?: number;
  sourceSnapshotId?: string;
};

export type MaterialShortageBlocker = {
  id: string;
  subtype: 'ProductionProblem';
  orderId: string;
  commercialOrderId?: string;
  positionId: string;
  productionOrderId?: string;
  rawMaterialStockId: string;
  rawMaterialId: string;
  label: string;
  requiredQty: number;
  factQty: number;
  usableReserveQty: number;
  shortageQty: number;
  unit: string;
  blocks: string;
  ownerRole: 'production_lead' | 'warehouse' | 'commercial';
  source: 'warehouse_fact' | 'mock';
  createdAt: string;
};

export type MaterialReceivingGate = {
  id: string;
  materialId: string;
  materialLabel: string;
  acceptedQty: number;
  discrepancyQty: number;
  unit: string;
  warehouse: string;
  acceptedBy: string;
  source: 'warehouse_fact' | 'mock';
  evidence: Fact[];
  receivedAt: string;
};

export type InventoryReconciliation = {
  id: string;
  rawMaterialId: string;
  actualQty: number;
  nominalQty: number;
  unit: string;
  overrideAllowed: true;
  status: 'aligned' | 'inventory_source_conflict';
  auditEvent: 'audit:inventory_fact_overrode_accounting_snapshot';
  problemEvent?: 'problem:inventory_source_conflict';
  sourceSnapshotId?: string;
};

export type InventoryMovementSignature = {
  role: 'production_lead';
  signerId: string;
  signerLabel: string;
  signedAt?: string;
};

export type InventoryMovement = {
  id: string;
  materialKind: RawMaterialStock['materialKind'];
  rawMaterialId: string;
  qty: number;
  unit: string;
  fromWorkshop: string;
  toWorkshop: string;
  status: 'draft' | 'requires_second_signature' | 'signed' | 'rejected';
  signatures: InventoryMovementSignature[];
  createdAt: string;
};

export type TapeConsumptionNorm = {
  id: string;
  label: string;
  productType: string;
  qtyPerRoll: number;
  unit: string;
  status: 'draft' | 'approved';
  templateEditable: boolean;
  manualValueAllowed: boolean;
  updatedAt: string;
};

export type TapeConsumptionCorrection = {
  id: string;
  normId: string;
  reason: string;
  oldValue: string;
  newValue: string;
  approvedByRole: 'director' | 'commercial_director';
  createdAt: string;
};

export type WarehouseTask = {
  id: string;
  type: 'prepare_reserved_rolls_for_order';
  orderId: string;
  rollIds: string[];
  qty: number;
  status: 'new' | 'in_work' | 'done';
  createdAt: string;
};

export type InstallmentSchedule = {
  id: string;
  orderId: string;
  shipmentCompletedAt: string;
  startRule: 'shipment_plus_1_day';
  startsAt: string;
  source: 'warehouse_delivery_mock';
};

export type ProductionLeadCreatedRequest = {
  id: string;
  createdBy: string;
  creatorRole: 'production_lead';
  createdOnBehalfOfRole?: RecipeOwnerRole;
  createdOnBehalfOfUserId?: string;
  commercialDelegationConfirmed?: boolean;
  commercialConfirmationPolicy: CommercialConfirmationPolicy;
  commercialConfirmationReason?: string;
  counterpartyId?: string;
  requestType: CommercialRequestType;
  positions: CommercialOrderPosition[];
  assignedOperatorId?: string;
  priority: ProductionPriority;
  recipeOwnerRole: RecipeOwnerRole;
  createdAt: string;
};

export type QRActionPanelContext = {
  qrCode: string;
  rollId: string;
  orderId: string;
  positionId: string;
  currentRole: Role;
  allowedActions: string[];
  blockedActions: string[];
  state:
    | 'read_only'
    | 'actions_available'
    | 'blocked_by_role'
    | 'blocked_by_status'
    | 'requires_reason';
};

export type QRPanelComment = {
  id: string;
  qrCode: string;
  role: Role;
  author: string;
  text: string;
  createdAt: string;
};

export type QRPanelAttachment = {
  id: string;
  qrCode: string;
  name: string;
  kind: 'photo' | 'document';
  createdAt: string;
};

export type CommercialOrderRequest = {
  id: string;
  createdBy: string;
  creatorRole: RequestCreatorRole;
  counterpartyId?: string;
  billingSnapshot?: CounterpartyBillingSnapshot;
  requestType: CommercialRequestType;
  status: CommercialRequestStatus;
  productionStatus: ProductionStatus;
  warehouseCoverStatus: WarehouseCoverStatus;
  paymentStatus: CommercialPaymentStatus;
  shipmentStatus: ShipmentStatus;
  createdAt: string;
  submittedAt?: string;
  assignedOperatorId?: string;
  priority?: ProductionPriority;
  createdOnBehalfOfRole?: RecipeOwnerRole;
  createdOnBehalfOfUserId?: string;
  commercialDelegationConfirmed?: boolean;
  commercialConfirmationPolicy?: CommercialConfirmationPolicy;
  commercialConfirmationReason?: string;
  requiresCommercialRecipeConfirmation?: boolean;
  positions: CommercialOrderPosition[];
};

export type ProductionProblem = {
  id: string;
  orderId: string;
  commercialOrderId: string;
  positionId?: string;
  rollId?: string;
  reportedByRole: 'production_lead' | 'operator';
  reportedByUserId?: string;
  targetRole: 'commercial';
  ownerRole: 'Коммерция';
  comment: string;
  reason: string;
  recovery: string;
  severity: Severity;
  status: 'open' | 'seen_by_commercial' | 'correction_requested' | 'resolved';
  currentRollNumber?: number;
  completedRolls?: number;
  totalRolls?: number;
  createdAt: string;
  resolvedAt?: string;
};

export type CommercialProductionProgress = {
  orderId: string;
  completedRolls: number;
  currentRollNumber: number;
  totalRolls: number;
  activeProblemIds: string[];
  updatedAt: string;
  source: 'production_runtime' | 'operator_runtime' | 'mock';
};

export type OrderResolutionOwnerRole =
  | 'commercial'
  | 'warehouse'
  | 'production_lead'
  | 'operator'
  | 'director'
  | 'finance';

export type OrderResolutionCaseType =
  | 'warehouse_cover_resolution'
  | 'warehouse_cover_dispute'
  | 'commercial_position_correction'
  | 'production_problem'
  | 'production_current_roll_resolution'
  | 'delegation_confirmation';

export type OrderResolutionCaseStatus =
  | 'open'
  | 'awaiting_commercial'
  | 'awaiting_warehouse'
  | 'awaiting_production'
  | 'awaiting_director'
  | 'applied'
  | 'cancelled'
  | 'resolved';

export type WarehouseCoverResolutionOutcome =
  | 'accepted_with_missing_to_production'
  | 'edited_position'
  | 'warehouse_recheck_requested'
  | 'rejected_send_all_to_production';

export type CurrentRollResolution =
  | 'finish_old_version'
  | 'stop_and_apply_new'
  | 'mark_defect'
  | 'requires_production_decision';

export type WarehouseCoverResolution = {
  caseId: string;
  proposalIds: string[];
  requestedQty: number;
  coveredQty: number;
  missingQty: number;
  outcome?: WarehouseCoverResolutionOutcome;
  warehouseRecheckTaskId?: string;
  productionDeltaOrderId?: string;
};

export type RecipeCorrectionRequest = {
  caseId: string;
  problemId?: string;
  positionId?: string;
  oldRecipeSnapshotId?: string;
  newRecipeSnapshotId?: string;
  reason: string;
  appliesFromRollNumber: number;
  currentRollResolution: CurrentRollResolution;
  notifiedRoles: OrderResolutionOwnerRole[];
};

export type OrderResolutionCase = {
  id: string;
  orderId: string;
  type: OrderResolutionCaseType;
  status: OrderResolutionCaseStatus;
  ownerRole: OrderResolutionOwnerRole;
  affectedPositionIds: string[];
  affectedRollIds?: string[];
  reason: string;
  outcome?: WarehouseCoverResolutionOutcome | CurrentRollResolution;
  nextOwnerRole?: OrderResolutionOwnerRole;
  createdByRole: OrderResolutionOwnerRole;
  createdAt: string;
  resolvedAt?: string;
  warehouseCoverResolution?: WarehouseCoverResolution;
  recipeCorrectionRequest?: RecipeCorrectionRequest;
};

export type FactScope =
  | 'common'
  | 'commercial'
  | 'production'
  | 'finance'
  | 'director'
  | 'operator'
  | 'warehouse'
  | 'admin'
  | 'sensitiveFinance'
  | 'legal'
  | 'recipeAnalytics'
  | 'rawDiagnostics';

export type Fact = {
  label: string;
  value: string;
  scope?: FactScope;
  helpText?: string;
};

export type Section = {
  id: string;
  title: string;
  facts: Fact[];
  scope?: FactScope;
};

export type ProblemCase = {
  id: string;
  objectId: string;
  type?: ProblemType;
  entityKind?: ReportableEntityKind;
  entityId?: string;
  createdByRole?: Role;
  targetRole?: Role;
  sourceActionId?: string;
  stage: string;
  title: string;
  severity: Severity;
  ownerRole: string;
  due: string;
  reason: string;
  recovery: string;
  status: 'open' | 'resolved';
};

export type ProblemReportDraft = {
  type: ProblemType;
  operatorProblemType?: OperatorReportableProblemType;
  entityKind: ReportableEntityKind;
  entityId: string;
  ownerRole: string;
  targetRole?: Role;
  due: string;
  severity: Severity;
  reason: string;
  createLinkedDuplicate: boolean;
};

export type ProblemReportPayload = ProblemReportDraft & {
  objectId: string;
  sourceActionId: string;
  createdByRole: Role;
  actorLabel: string;
  title: string;
  stage: string;
  recovery: string;
  auditEvent: string;
  notificationRole?: Role;
  notificationTitle: string;
  notificationBody: string;
  duplicateProblemId?: string;
};

export type ProblemReportContext = {
  role: Role;
  actionId: string;
  objectId: string;
  objectTitle: string;
  objectStatus: string;
  actorLabel: string;
  title: string;
  stage: string;
  recovery: string;
  auditEvent: string;
  notificationRole?: Role;
  notificationTitle: string;
  notificationBody: string;
  duplicateProblem?: ProblemCase;
  lockedTarget: boolean;
  readOnlyFacts: Fact[];
  draft: ProblemReportDraft;
};

export type AuditEntry = {
  id: string;
  objectId: string;
  time: string;
  actorLabel: string;
  actionLabel: string;
  detail: string;
  reason?: string;
  oldValue?: string;
  newValue?: string;
  sourceSnapshot?: string;
  scope?: FactScope;
};

export type ActionDescriptor = {
  id: string;
  label: string;
  level: ActionLevel;
  enabled: boolean;
  actionIntent?: ActionIntent;
  disabledReason?: string;
  recoveryOwner?: string;
  recoveryAction?: string;
  confirmation?: string;
  helpText?: string;
};

export type WorkListItem = {
  id: string;
  kind: WorkObjectKind;
  title: string;
  summary: string;
  statusLabel: string;
  orderStage?: OrderStageBadge;
  severity: Severity;
  nextOwner: string;
  lastEventAt: string;
  problemCount: number;
  roleFields: Fact[];
  filterTags: string[];
  queueBucket: WorkQueueBucket;
  dateKey?: string;
  archiveReason?: string;
  completedAt?: string;
  lastActionAt?: string;
  newness?: NewnessState;
  operatorCard?: {
    orderCode: string;
    customerAlias: string;
    templateName: string;
    filmType: string;
    micron: string;
    size: string;
    kgPerRoll: string;
    recipe: string;
    currentRollLabel: string;
    currentRollMicron: string;
    currentRollSize: string;
    currentRollPlanKg: string;
    currentRollTolerance: string;
    currentRollRecipe: string;
    groupCount: number;
    actionLabel: string;
    progressLabel: string;
    progressValue: number;
    stepLabel: string;
    isMuted: boolean;
    blocker?: string;
  };
};

export type OrderStageBadge = {
  label: string;
  bucket: string;
  detail: string;
  severity: Severity;
};

export type WorkObject = {
  id: string;
  kind: WorkObjectKind;
  title: string;
  statusLabel: string;
  nextOwner: string;
  severity: Severity;
  filterTags?: string[];
  facts: Fact[];
  sections: Section[];
  actions: ActionDescriptor[];
  problems: ProblemCase[];
  audit: AuditEntry[];
  paymentSchedule?: PaymentSchedule;
  financeAmountValue?: number;
  financeCreatedAt?: string;
  commercialFinanceNote?: string | null;
  oneCInvoiceSyncState?: OneCInvoiceSyncState;
  oneCInvoice?: FinanceInvoiceView;
  financePaymentSummary?: FinancePaymentSummary;
  financePaymentTimeline?: FinancePaymentTimelineEntry[];
  financeBusinessPayment?: FinanceBusinessPayment;
  financePaymentCorrections?: FinancePaymentCorrectionFact[];
  financePaymentStatus?: FinancePaymentCorrectionCommand['expectedPaymentStatus'];
  correctablePayments?: FinanceCorrectablePayment[];
  paymentSchedules?: PaymentScheduleEntry[];
  paymentPolicy?: PaymentPolicyView;
  paymentTermsType?: PaymentTermType;
  paymentOperations?: PaymentOperationEntry[];
  newness?: NewnessState;
  workbench?: Workbench;
  rollGroups?: OrderRollGroup[];
  commercialOrder?: CommercialOrderRequest;
  warehouseCoverProposals?: WarehouseCoverProposal[];
  warehouseCoverTask?: WarehouseCoverTask;
  positionTemplateApplications?: PositionTemplateApplication[];
  materialShortageBlockers?: MaterialShortageBlocker[];
  materialReceivingGate?: MaterialReceivingGate;
  rawMaterialStocks?: RawMaterialStock[];
  warehouseInventoryOverrides?: WarehouseInventoryOverride[];
  inventoryMutations?: InventoryMutation[];
  productionProblems?: ProductionProblem[];
  commercialProductionProgress?: CommercialProductionProgress;
  orderResolutionCases?: OrderResolutionCase[];
  paymentIndicator?: CommercialPaymentIndicator;
  qrActionPanelContext?: QRActionPanelContext;
  productionRollDispatchItems?: ProductionRollDispatchItem[];
  warehouseCoverageWorkflowVersion?: 1 | 2;
  coverage?: WarehouseCoverageView;
  productionQty?: number;
  sourceGeneration?: number | null;
  productionOrderId?: string | null;
  operatorWorkloads?: OperatorWorkload[];
  bigBagUnits?: BigBagUnit[];
  materialCostReferences?: MaterialCostReference[];
  palletListDocument?: PalletListDocument;
};

export type Counterparty = {
  id: string;
  legalName: string;
  alias: string;
  inn?: string;
  kpp?: string;
  ogrn?: string;
  legalAddress?: string;
  source: 'manual' | 'mock_1C' | '1C';
  syncStatus?: 'not_synced' | 'mock_snapshot' | 'synced' | 'needs_discovery';
  visibilityPolicy: string;
  templateIds: string[];
  installmentTermsSource: string;
  contacts?: Array<{
    id: string;
    name: string;
    role: string;
    phone?: string;
    email?: string;
    preferred?: boolean;
    source?: 'manual' | 'mock_1C' | '1C';
  }>;
};

export type TemplateFieldKind = 'safe' | 'production' | 'money';

export type CounterpartyOrderTemplateField = Fact & {
  required?: boolean;
  kind: TemplateFieldKind;
};

export type CounterpartyOrderTemplate = {
  id: string;
  counterpartyId: string;
  name: string;
  activeVersionId: string;
  status: 'active' | 'draft' | 'archived';
  ownerRole: string;
  usageCount: number;
  lastUsedAt: string;
  updatedAt: string;
};

export type CounterpartyOrderTemplateVersion = {
  id: string;
  templateId: string;
  version: string;
  fields: CounterpartyOrderTemplateField[];
  reason: string;
  createdBy: string;
  createdAt: string;
  affectsProduction: boolean;
  affectsMoney: boolean;
};

export type TemplateApplication = {
  templateVersionId: string;
  targetObjectId: string;
  appliedFields: Fact[];
  overrides: Fact[];
  reason?: string;
};

export type TemplateDiff = {
  label: string;
  templateValue: string;
  currentValue: string;
  reason: string;
  severity: Severity;
};

export type Workbench = OperatorWorkbench | WarehouseWorkbench | AdminWorkbench;

export type LabelState =
  | 'not_printed'
  | 'delivery_unknown'
  | 'print_requested'
  | 'submitted'
  | 'printed'
  | 'applied'
  | 'verified'
  | 'reprint_requested'
  | 'voided'
  | 'damaged_lookup_required';

export type LabelLifecycle = {
  current: LabelState;
  steps: Array<{ state: LabelState; label: string; value: string; severity: Severity }>;
  lastPrintJob: string;
  lastScan: string;
  reprintReason?: string;
  voidedLabel?: string;
  damagedRecovery?: string;
};

export type RollToleranceState = 'pending' | 'within' | 'warning' | 'blocked';

export type RollWarehouseState =
  | 'not_ready'
  | 'ready_for_handover'
  | 'sent'
  | 'received'
  | 'missing'
  | 'delivered'
  | 'defect';

export type OrderRollGroup = {
  id: string;
  title: string;
  filmType: string;
  rollType?: string;
  actualThickness?: string;
  accountingThickness?: string;
  widthMm?: number;
  plannedLengthM?: number;
  micron: string;
  color: string;
  sizeMeters: string;
  sleeve: string;
  recipe: string;
  recipeVersion: string;
  recipeName?: string;
  recipeVersionNumber?: number;
  recipeIngredients?: Array<{ name: string; shareBasisPoints: number }>;
  rawMaterialLabel?: string;
  comment?: string;
  commercialComment?: string;
  plannedRolls: number;
  plannedNetKg?: number;
  tolerancePercent: number;
  machine: string;
  owner: string;
  status: string;
  blocker?: string;
  appliesFromRollSequence?: number;
  rollIds: string[];
};

export type OperatorShift = {
  id: string;
  status: 'scheduled' | 'start_missing' | 'active' | 'bag_missing' | 'close_pending' | 'closed';
  operatorName: string;
  workplace: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
  defaultMachineId?: string;
  defaultMachineLabel?: string;
  shiftCapacityMinutes?: number;
  remainingShiftMinutes?: number;
  bigBagId: string;
  bigBagQrCode?: string;
  startKg?: number;
  endKg?: number;
  expectedEndKg: number;
  plannedShortageKg?: number;
  plannedUsageKg: number;
  actualUsageKg?: number;
  deviationPercent?: number;
  lastActorLabel?: string;
  weightSource?: BigBagUnit['weightSource'];
  enteredBy?: string;
  enteredAt?: string;
  /** Live-режим: мешки смены с весами (design 2026-07-13). */
  bags?: Array<{
    bagId: string;
    code: string;
    material: string;
    materialId: string | null;
    warehouseKg: number | null;
    startKg: number;
    endKg: number | null;
    addedReason: string | null;
    releasedReason: string | null;
    active: boolean;
    releasedAt: string | null;
    sequence: number;
  }>;
  defectBags?: OperatorShiftDefectBag[];
  defectBag?: OperatorShiftDefectBag;
  balanceStatus?: 'pending' | 'ok' | 'mismatch';
  plannedConsumptionKg?: number;
  estimatedMinutes?: number;
};

export type OperatorShiftDefectBag = {
    id: string;
    code: string;
    status: 'weighed' | 'ready_for_warehouse' | 'received' | 'shipped';
    defectType: DefectBagType | null;
    weightKg: number;
    recordedDefectKg: number;
    differenceKg: number;
    labelState: 'not_printed' | 'submitted' | 'failed' | 'delivery_unknown';
    weighedAt: string;
};

export type OperatorRollProgress = {
  current: number;
  completed: number;
  total: number;
};

export type OperatorRollWeightSnapshot = {
  grossKg: number;
  netKg: number;
  toleranceOk: boolean | null;
};

export type OperatorRollReweighResult = {
  rollCode: string;
  step: 'qr_print' | 'handover';
  previousWeight: OperatorRollWeightSnapshot;
  currentWeight: OperatorRollWeightSnapshot;
};

export type OperatorRollStepBackResult = {
  rollCode: string;
  previousStep: 'qr_print' | 'roll_weight';
  step: 'roll_weight' | 'spool_weight';
};

export type OperatorOrderProgress = {
  orderId: string;
  state: 'new' | 'in_progress' | 'deferred' | 'qr_check' | 'handover' | 'warehouse';
  rollProgress: OperatorRollProgress;
  plannedRolls: number;
  completedRolls: number;
  deferredRolls: number;
  currentRoll: number;
  plannedNetKg: number;
  materialRecipe: string;
  realMicron: string;
  sizeMeters: string;
};

export type OperatorRollLine = {
  id: string;
  dispatchItemId?: string;
  replacesDispatchItemId?: string | null;
  updatedAt?: string;
  sequenceNumber: number;
  /** Physical attempt within one logical roll (replacement keeps sequenceNumber). */
  attemptNumber?: number;
  queueRank?: number;
  orderNumber?: string;
  machineId?: string;
  machineLabel?: string;
  priority?: ProductionPriority;
  estimatedMinutes?: number;
  groupId: string;
  status: string;
  plannedNetKg: number;
  meterageMeters?: number;
  actualNetKg?: number;
  spoolScaleActivated?: boolean;
  rollScaleActivated?: boolean;
  spoolWeightPolicy?: 'standard_700g' | 'physical_measurement';
  spoolKg?: number;
  grossKg?: number;
  deviationPercent?: number;
  toleranceState: RollToleranceState;
  recipeVersion: string;
  qrCode?: string;
  netKg?: number;
  labelState: LabelState;
  warehouseState: RollWarehouseState;
  sentToWarehouseAt?: string;
};

export type InvoiceLifecycleStatus =
  | 'waiting_invoice'
  | 'issued'
  | 'not_confirmed_by_source'
  | 'waiting_delivery'
  | 'installment_running'
  | 'payment_due_today'
  | 'overdue'
  | 'paid'
  | 'sync_error';

export type PaymentLifecycleStatus =
  | 'not_expected'
  | 'waiting_delivery'
  | 'unpaid'
  | 'partial'
  | 'installment_running'
  | 'payment_due_today'
  | 'overdue'
  | 'paid'
  | 'sync_error';

export type PaymentKind = 'cash' | 'bank' | 'mixed' | 'unknown';

export type SyncJournalStatus = 'ready' | 'waiting' | 'not_required' | 'error' | 'manual_review';

export type FinanceOrder = {
  id: string;
  orderId: string;
  counterparty: string;
  counterpartyId?: string;
  counterpartyLabel?: string;
  invoiceStatus: InvoiceLifecycleStatus;
  paymentStatus: PaymentLifecycleStatus;
  shipmentDateLabel?: string;
  installmentTerms?: InstallmentTerms;
  paymentSchedule?: PaymentSchedule;
  amountLabel: string;
  amountTotalLabel?: string;
  amountPaidLabel?: string;
  amountRemainingLabel?: string;
  nextPaymentAmountLabel?: string;
  paymentKind?: PaymentKind;
  sourceStatus: SyncJournalStatus;
  sourceLabel: string;
  invoiceSourceStatus?: SyncJournalStatus;
  paymentSourceStatus?: SyncJournalStatus;
  kickback?: Kickback;
  problems?: ProblemCase[];
  audit?: AuditEntry[];
  directorVisible: boolean;
};

export type InstallmentTerms = {
  counterpartyId?: string;
  days: number;
  startRule: 'after_delivery_close' | 'manual_review';
  calendarMode?: 'calendar_days';
  daysLeft?: number;
  source: 'counterparty_template' | 'finance_source' | 'default_30_days' | 'manual_review';
};

/** Одна строка графика платежей (рассрочки) финансового дела. */
export type PaymentScheduleEntry = {
  id: string;
  kind?: 'invoice_prepayment' | 'post_delivery';
  sequence?: number;
  trigger?: PaymentPolicyStageDraft['trigger'];
  percentageBasisPoints?: number;
  offsetDays?: number;
  amountValue?: number;
  startsAtIso?: string;
  dueDateIso?: string;
  dateKind?: 'actual' | 'condition' | 'unavailable';
  dueDateLabel: string;
  amountLabel: string;
  paidAmountLabel?: string;
  remainingAmountLabel?: string;
  isOverdue?: boolean;
  status: 'scheduled' | 'due_today' | 'paid' | 'overdue';
  source?: string;
};

export type PaymentTermType = 'prepay_50_postpay_50_30d' | 'postpay_100_30d';

export type OneCInvoiceSyncState =
  | 'not_synced'
  | 'not_found'
  | 'draft_found'
  | 'posted'
  | 'ambiguous'
  | 'stale'
  | 'error';

export type FinanceInvoiceLineView = {
  lineNumber: number;
  nomenclatureExternalId?: string | null;
  name?: string | null;
  quantity: number;
  price: string;
  amount: string;
  unitExternalId?: string | null;
  taxRate?: string | null;
  taxAmount?: string | null;
};

export type FinanceInvoiceView = {
  externalId: string;
  sourceVersion: string | null;
  sourceKind: string;
  staleness: 'fresh' | 'stale' | 'unknown' | string;
  capturedAt?: string | null;
  importedAt?: string | null;
  checkedAt?: string | null;
  invoiceNumber?: string | null;
  date?: string | null;
  amount?: string | null;
  subtotal?: string | null;
  taxTotal?: string | null;
  currency?: string | null;
  posted: boolean;
  counterpartyExternalId?: string | null;
  organizationExternalId?: string | null;
  lines: FinanceInvoiceLineView[];
};

export type FinancePaymentSummary = {
  invoiceAmount: string | null;
  paidAmount: string;
  remainingAmount: string | null;
  overpaidAmount: string;
};

export type FinanceBusinessPayment = {
  businessDate: string;
  status: 'unpaid' | 'partial' | 'paid' | 'overdue';
  isOverdue: boolean;
  paidAmount: string;
  remainingAmount: string | null;
  overdueAmount: string;
};

export type FinancePaymentCorrectionFact = {
  id: string;
  targetKind: FinancePaymentCorrectionTarget['kind'];
  reason: string;
  actorRole: string;
  resultingStatus: string | null;
  createdAt: string;
};

export type FinancePaymentCorrectionTarget = {
  kind: 'payment_update' | 'schedule_confirmation' | 'payment_operation';
  id: string;
};

export type FinancePaymentCorrectionCommand = {
  operationKey: string;
  target: FinancePaymentCorrectionTarget;
  expectedPaymentStatus: 'unpaid' | 'partial' | 'paid' | 'overdue' | 'sync_error';
  reason: string;
};

export type FinancePaymentCorrectionResult = {
  commandId: string;
  targetKind: FinancePaymentCorrectionTarget['kind'];
  targetId: string;
  reversalOperationId: string | null;
  paymentStatus: FinancePaymentCorrectionCommand['expectedPaymentStatus'];
  productionClearedAt: string | null;
};

export type FinanceCorrectablePayment = {
  target: FinancePaymentCorrectionTarget;
  label: string;
  amount: string | null;
  source: 'manual_platform' | '1C';
  canCorrect: boolean;
  blockedReason: string | null;
};

export type FinancePaymentTimelineEntry = {
  id: string;
  receiptId: string;
  receiptExternalId?: string | null;
  receiptNumber?: string | null;
  receivedAt?: string | null;
  receiptAmount?: string | null;
  currency?: string | null;
  sourceStatus?: string | null;
  scheduleId?: string | null;
  amount: string;
  status: string;
  matchKind?: string | null;
  reversesId?: string | null;
  createdAt: string;
};

export type PaymentPolicyStageDraft = {
  sequence: number;
  trigger: 'invoice_issued' | 'full_shipment';
  percentageBasisPoints: number;
  offsetDays: number;
  label?: string;
};

export type PaymentPolicyDraft = {
  installmentDays: number;
  stages: PaymentPolicyStageDraft[];
};

export type PaymentPolicyView = PaymentPolicyDraft & {
  id: string;
  revision: number;
  capturedProductionLeadDays: number;
  invoiceExternalId?: string | null;
  invoiceSourceVersion?: string | null;
  capturedInvoiceAmount?: string | null;
  capturedInvoiceCurrency?: string | null;
};

export type PaymentPolicyPreviewRow = PaymentPolicyStageDraft & {
  amount: number;
  date: string | null;
  dateKind: 'actual' | 'condition';
};

export type PaymentPolicyPreview = {
  rows: PaymentPolicyPreviewRow[];
};

/** Одна выплата в истории выплат финансового дела. */
export type PaymentOperationEntry = {
  id: string;
  allocationId?: string;
  label: string;
  amountLabel: string;
  dateLabel?: string;
  source?: string;
};

export type PaymentSchedule = {
  id: string;
  orderId: string;
  triggerId: string;
  startsAt?: string;
  termsDays: number;
  dueDateLabel: string;
  dueAmountLabel: string;
  status: 'scheduled' | 'due_today' | 'paid' | 'overdue';
  invoiceReminderStatus: 'not_required' | 'pending' | 'sent' | 'closed';
  notifiedAt?: string;
  source: 'payment_schedule_mock' | 'finance_source' | 'warehouse_delivery_mock' | 'manual_review';
};

export type ShipmentPaymentTrigger = {
  id: string;
  orderId: string;
  deliveryId: string;
  triggeredAt?: string;
  shipmentDateLabel?: string;
  installmentStartDateLabel?: string;
  source?: 'warehouse_delivery_mock';
  syncStatus?: SyncJournalStatus;
  status: 'waiting_delivery_close' | 'started' | 'blocked';
  auditEvent: 'op:installment_countdown_started' | 'audit:payment_trigger_blocked';
};

export type SyncJournal = {
  id: string;
  entityId: string;
  status: SyncJournalStatus;
  ownerRole: 'Бухгалтерия' | 'Админ' | 'Директор';
  recovery: string;
};

export type Kickback = {
  id: string;
  orderId: string;
  amountLabel: string;
  status: 'draft' | 'confirmed' | 'blocked';
  createdBy?: string;
  updatedAt?: string;
  completedAt?: string;
  visibility: 'director_only';
  auditEvent: 'audit:kickback_changed';
};

export type Penalty = {
  id: string;
  employeeId: string;
  employeeName?: string;
  employeeRole: string;
  reason: string;
  amountLabel: string;
  sourceObjectId?: string;
  status: 'draft' | 'created' | 'notified' | 'cancelled';
  createdBy?: string;
  createdAt?: string;
  payrollLinkStatus: 'discovery_boundary' | 'manual_review';
  auditEvent: 'audit:penalty_created';
};

export type DirectorDecision = {
  id: string;
  sourceObjectId: string;
  kind: 'recipe' | 'finance' | 'warehouse' | 'penalty' | 'risk';
  status: 'open' | 'blocked' | 'done';
  moneyImpactLabel?: string;
  ownerRole: 'Директор';
  auditEvents: Array<
    | 'audit:recipe_approved'
    | 'audit:problem_confirmed'
    | 'audit:problem_returned_to_warehouse'
    | 'audit:payment_status_imported'
    | 'audit:raw_material_reference_imported'
    | 'audit:inventory_fact_overrode_accounting_snapshot'
    | 'audit:shipment_completed'
    | 'audit:payment_status_updated'
    | 'audit:invoice_status_updated'
    | 'audit:payment_schedule_created'
    | 'notification:payment_due_invoice_needed'
    | 'integration_sync_failed'
    | 'audit:sync_retry_requested'
    | 'audit:kickback_changed'
    | 'audit:penalty_created'
    | 'notification:penalty_sent'
    | 'problem:inventory_source_conflict'
    | 'problem:finance_overdue_created'
    | 'problem:finance_source_error_created'
  >;
};

export type OperatorStageSignal = {
  kind: 'scale' | 'qr' | 'handover' | 'shift' | 'order';
  title: string;
  value: string;
  severity: Severity;
  facts: Array<{ label: string; value: string; severity?: Severity }>;
};

export type OperatorWorkbench = {
  type: 'operator';
  orderCode?: string;
  customerAlias?: string;
  instruction: string;
  step: string;
  machine: string;
  rollProgress: OperatorRollProgress;
  stageSignal?: OperatorStageSignal;
  deviceStatus: Array<{ label: string; value: string; severity: Severity }>;
  metrics: Array<{ label: string; value: string; unit: string; severity?: Severity }>;
  steps?: Array<{ label: string; value: string; severity: Severity }>;
  currentRoll?: OperatorRollLine;
  currentRollGroup?: OrderRollGroup;
  rollLines?: OperatorRollLine[];
  rollGroups?: OrderRollGroup[];
  labelLifecycle?: LabelLifecycle;
  blockingReason?: string;
  recovery?: string;
  nextEffect?: string;
};

export type WarehouseActivePallet = {
  id: string;
  palletCode: string;
  orderId: string;
  orderNumber: string;
  sequenceNo: number;
  status: 'open' | 'sealed';
  rollCount: number;
  openedAt: string;
  rows: Array<{
    rollCode: string;
    position: number;
    acceptedAt: string;
    scannedByName: string | null;
  }>;
};

export type WarehouseWorkbench = {
  type: 'warehouse';
  mode: 'receiving' | 'delivery';
  taskId?: string;
  taskClosed?: boolean;
  coverageDecisionTaskId?: string;
  prompt: string;
  expected: number;
  scanned: number;
  /** Full order plan for queue progress; scan logic continues to use expected/expectedRolls. */
  plannedRollCount?: number;
  missing: string[];
  excess: string[];
  accepted: string[];
  lastScan: string;
  lastScanResult?: {
    rollCode: string | null;
    scanStatus: string;
    scannedAt: string;
  } | null;
  scanSeverity: Severity;
  expectedRolls?: Array<{
    id: string;
    status: string;
    source?: 'warehouse_reserve' | 'production_handover' | 'production_pending';
    ownership?: WarehouseRollOwnership;
    sequenceNumber?: number;
    orderId?: string;
    orderEntityId?: string;
    orderLineId?: string;
    customerAlias?: string;
    palletId?: string;
    scanRowId?: string;
    palletSelection?: {
      selected: boolean;
      locked: boolean;
      palletId: string | null;
      palletCode: string | null;
    };
    operatorLabel?: string;
    machineLabel?: string;
    productionStatus?: string;
    expectedAt?: string;
    filmType: string;
    micron: string;
    sizeMeters: string;
    lengthMeters?: string;
    materialMark?: string;
    spoolType?: string;
    article?: string;
    packagingMaterial?: string;
    packagingCount?: number;
    deliveryDate?: string;
    plannedNetKg: number;
    planNetKg?: number;
    actualNetKg?: number;
    grossKg?: number;
    producedAt?: string;
    tolerancePercent: number;
    qrCode?: string;
  }>;
  scanResult?: string;
  blockingReason?: string;
  recovery?: string;
  nextEffect?: string;
  deviceStatus?: Array<{ label: string; value: string; severity: Severity }>;
  evidence?: Fact[];
  qualityStats?: Fact[];
  activePallet?: WarehouseActivePallet | null;
  palletListDocuments?: PalletListDocument[];
  palletHistoryHasMore?: boolean;
  palletListDocument?: PalletListDocument;
};

export type AdminWorkbench = {
  type: 'admin';
  entityType: 'device' | 'access' | 'roleTemplate' | 'source';
  prompt: string;
  status: string;
  owner: string;
  now?: string;
  why?: string;
  after?: string;
  evidence?: Fact[];
  deviceStatus?: string;
  lastSeen: string;
  testResult: string;
  checks: Array<{ label: string; value: string; severity: Severity }>;
  parsedRows: Fact[];
  rawCollapsedLabel: string;
  rawRows: Fact[];
  blockingReason?: string;
  recovery?: string;
  nextEffect?: string;
};

export type RoleConfig = {
  id: Role;
  label: string;
  nav: string[];
  listTitle: string;
  emptyText: string;
};

export type RoleNavItem = {
  label: string;
  count: number;
  active: boolean;
};

export type NewnessState = {
  recipientRole: Role;
  createdAt: string;
  highlightUntil: string;
  firstSeenAt?: string;
  acknowledgedAt?: string;
  soundPlayed?: boolean;
};

export type NotificationNavigation =
  | {
      kind?: 'object';
      section: string;
      objectId: string;
    }
  | {
      kind: 'production_problem';
      section: string;
      problemId: string;
      rollId: string;
      orderId?: string;
    }
  | {
      kind: 'operator_queue';
      section: string;
    }
  | {
      kind: 'admin_incident';
      section: string;
      incidentId: string;
    };

export type NotificationItem = {
  id: string;
  eventType?: string;
  recipientRole: Role;
  recipientUserId?: string;
  severity: Severity;
  title: string;
  body: string;
  orderNumber?: string;
  orderInfo?: {
    orderNumber: string;
    rollCount: number;
    rollCodes: string[];
    omittedRollCount: number;
  };
  objectId?: string;
  navigation?: NotificationNavigation;
  createdAt: string;
  readAt?: string;
  requiresAck: boolean;
  acknowledgedAt?: string;
  sound: boolean;
};

export type RoleTemplate = {
  id: string;
  role: Role;
  name: string;
  setupStatus?: 'ready' | 'needs_setup';
  visibleSections: string[];
  hiddenScopes: FactScope[];
  capabilities: PermissionCapability[];
  seniorAccessScope: SeniorAccessScope;
  allowedActions: string[];
  summary: string;
};

export type UserAccessEntry = {
  id: string;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'blocked';
  roleTemplateId: string;
  extraCapabilities?: PermissionCapability[];
  assignedAt: string;
  assignedBy: string;
};

export type RoleAssignmentDraft = {
  email: string;
  roleTemplateId: string;
  status: UserAccessEntry['status'];
};

export type PermissionPolicy = RoleAccessPolicy;

export type UserSession = {
  id: string;
  name: string;
  role: Role;
  workplace: string | null;
  shift: string | null;
  status: 'active' | 'blocked';
  sessionExpiresAt?: string | null;
  sessionState?: 'active' | 'expired' | 'revoked' | null;
  notificationSound: boolean;
  reducedMotion: boolean;
};

export type AppState = {
  selectedByRole: Record<Role, string | null>;
  activeRole: Role;
  filter: string;
};
