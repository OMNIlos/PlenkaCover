import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { IxApplication, IxEmptyState, IxMessageBar } from '@siemens/ix-react';

import {
  notifications as initialNotifications,
  permissionPolicies,
  roleConfigs,
  roleOrder,
  roleTemplates as initialRoleTemplates,
  userAccessEntries,
  userSessions,
  workObjects,
} from './domain/demoData';
import {
  actionGroups,
  queueFiltersForRole,
  getDefaultSelection,
  getCommercialOrderStage,
  getListItems,
  getObjectsForRole,
  getRoleConfig,
  getSelectedObject,
} from './domain/selectors';
import { buildCommercialPositionMutationPlan } from './domain/commercialPositionEditing';
import {
  currentRollResolutionLabels,
  parseCorrectionTarget,
  parseWarehouseResolutionTarget,
  upsertResolutionCase,
  warehouseResolutionOutcomeLabels,
} from './domain/orderResolution';
import {
  activeVersionForTemplate,
  counterparties,
  counterpartyForObject,
  counterpartyTemplateVersions,
  counterpartyTemplates,
  positionPatchFromTemplate,
  positionTemplateDiffsForPosition,
  sortedTemplates,
  templateNameFromFields,
  templateFieldsFromPositions,
  templateNameFromPositions,
  templateDiffsForObject,
  templatesForCounterparty,
} from './domain/templates';
import type { WorkObjectsByRole } from './domain/selectors';
import { severityLabel, severityTone } from './domain/copy';
import { visibleAuditActionLabel } from './domain/displayContracts';
import { getWorkObjectAction } from './domain/actions';
import {
  createReservePreparationWorkObject,
  createWarehouseCoverRecheckWorkObject,
} from './domain/inventoryContracts';
import {
  currentAssignmentByOperator,
  operatorById,
  productionShiftCapacity,
  type ProductionOperator,
} from './domain/operators';
import { penaltiesVisibleToProduction } from './domain/penaltyNotifications';
import { normalizeFinanceSection } from './domain/financeSections';
import { buildPenaltyWorkCatalog } from './domain/penaltyWorkObjects';
import {
  aggregateProductionRollDispatchItems,
  assignedProductionOperatorCount,
  productionRollQueueRank,
} from './domain/rollWork';
import { loadSession } from './api/authStorage';
import { logout, type MeResponse } from './api/auth';
import { ApiResponseParseError } from './api/client';
import { AUTH_REQUIRED } from './components/auth/AuthGate';
import { DemoRoleSwitcherGate, resolveInitialRole } from './components/auth/roleLock';
import { isLiveContour } from './api/liveContours';
import {
  adminIncidentSelectionFromSearch,
  appendInboxPage,
  beginInboxRead,
  businessProblemSelectionFromSearch,
  createInboxState,
  InboxRequestFrontier,
  LiveRefreshController,
  liveNotificationDestination,
  liveNotificationUrl,
  liveRoleLoadStateAfterError,
  mergeInboxFirstPage,
  productionProblemSelectionFromSearch,
  reconcileEquivalentSnapshot,
  reconcileLiveSelection,
  rollbackInboxRead,
  type InboxState,
  type PendingInboxRead,
} from './api/liveRefresh';
import { LiveMutationGate } from './api/liveMutationGate';
import {
  createOperationKey,
  IdempotentOperationGate,
  isDeliveryUncertain,
} from './api/idempotentOperation';
import {
  FinancePaymentCorrectionReplayGuard,
  financePaymentCorrectionIntent,
} from './api/financePaymentCorrectionReplay';
import { buildFinancePaymentOperationIntent } from './domain/financePaymentAction';
import {
  WarehouseRawAdjustmentReplayGuard,
  warehouseRawAdjustmentIntent,
} from './api/warehouseRawAdjustmentReplay';
import { operatorDefectIntent } from './api/operatorDefectReplay';
import { commitThenRefresh } from './api/commitThenRefresh';
import {
  LIVE_ROLE_LOAD_ERROR_TITLE,
  isLiveRoleSnapshotRole,
  liveSessionFromMe,
  loadLiveRoleSnapshot,
  type LiveRoleSnapshot,
  type LiveRoleSnapshotRole,
} from './api/liveRoleSnapshot';
import {
  fetchRoleInbox,
  isRoleInboxRole,
  markRoleInboxRead,
  type RoleInboxPage,
  type RoleInboxRole,
} from './api/roleInbox';
import {
  acceptOperatorRoll,
  addOperatorShiftBag,
  captureOperatorRollWeight,
  captureOperatorSpoolWeight,
  closeOperatorShift,
  finalizeOperatorMachineChange,
  reportOperatorMachineBreakdown,
  deferOperatorRoll,
  fetchCurrentOperatorMachineChange,
  fetchOperatorBigBags,
  fetchOperatorRuntime,
  handoverOperatorRoll,
  openOperatorShift,
  OPERATOR_MACHINE_BREAKDOWN_ACTION_PREFIX,
  parseOperatorMachineBreakdownAction,
  printOperatorDefectBag,
  printOperatorQr,
  releaseOperatorShiftBag,
  reweighOperatorRoll,
  reportOperatorDefect,
  reportOperatorProblem,
  resumeOperatorRoll,
  stepBackOperatorRoll,
  verifyAndHandoverOperatorQr,
  type OperatorShiftCloseResult,
  type OperatorShiftClosingPayrollView,
  weighOperatorDefectBag,
} from './api/operator';
import {
  createDirectorPenalty as createDirectorPenaltyApi,
  createProductionOperatorPenalty,
  fetchPenaltySnapshot,
  type PenaltySnapshotFilters,
  type PenaltySnapshotRuntime,
} from './api/penalties';
import { usePenaltySnapshotState } from './features/penalties/usePenaltySnapshotState';
import {
  confirmCover,
  createCommercialOrderFromDraft,
  createCounterpartyTemplateFromFields,
  fetchCounterpartyTemplates,
  forceProduction,
  promoteCommercialDraft,
  requestCoverRecheck,
  saveCommercialOrderPosition,
  sendCommercialOrderToProduction,
  submitCommercialOrderToFinance,
  updateCounterpartyTemplateFromFields,
  updateCounterpartyTemplateStatus,
} from './api/commercial';
import {
  fetchCommercialOrderDetail,
  searchCommercialCounterparties,
  type CommercialCounterpartyContract,
} from './features/commercial/api';
import { CommercialControlPanel } from './features/commercial/CommercialControlPanel';
import { CommercialProfilePanel } from './features/commercial/CommercialProfilePanel';
import {
  CommercialWorkspace,
  isCommercialLiveSection,
} from './features/commercial/CommercialWorkspace';
import {
  approveProductionTechnicalCover,
  approveProductionOrder,
  assignProductionOperatorMachine,
  assignProductionRoll,
  batchUpdateProductionRolls,
  breakdownReassignProductionMachine,
  cancelProductionAssignment,
  cancelProductionMachineChange,
  completeProductionMachineRepair,
  createIndividualOperatorShift,
  fetchProductionArchive,
  fetchProductionOperatorMachines,
  fetchProductionOperatorOptions,
  fetchProductionLiveOrdersWithStatus,
  fetchProductionPosts,
  fetchProductionProblems,
  fetchProductionShifts,
  ProductionApprovalReconciliationError,
  ProductionTechnicalCoverReconciliationError,
  reorderProductionRolls,
  reportProductionMachineBreakdown,
  requestIntentionalMachineChange,
  resolveProductionProblem,
  selectProductionPlanningShift,
  startProductionMachineRepair,
  updateProductionRollPriority,
  type ServerProductionProblem,
  type ProductionOperatorMachineView,
  type OperatorMachineChangeView,
  type ProductionOperatorOption,
  type ProductionPost,
  type ProductionShift,
  type ProductionRollChange,
} from './api/production';
import { createDemoProductionProblems } from './api/productionProblemsDemo';
import {
  confirmFinancePaymentSchedule,
  correctFinancePayment,
  createFinanceProblem,
  fetchFinanceOrders,
  recordFinancePayment,
  retryFinanceSource,
} from './api/finance';
import {
  approveDirectorDecision,
  fetchDirectorFinanceObjects,
  fetchDirectorProductionObjects,
  fetchDirectorWarehouseObjects,
  returnDirectorDecision,
  buildLiveDirectorControl,
  overrideDirectorFinance,
  overrideDirectorProduction,
  overrideDirectorWarehouse,
  type ServerDirectorControl,
  type ServerDirectorDecision,
} from './api/director';
import {
  adjustWarehouseRawMaterial,
  applyWarehousePalletSelectionScan,
  closeWarehouseIntakeTask,
  createWarehouseBigBag,
  deliveryTaskToWorkObject,
  downloadWarehousePalletList,
  fetchWarehouseRawMaterialsOneCPreview,
  intakeTaskToWorkObject,
  liveRawMaterialsToWorkObject,
  proposeWarehouseCover,
  pushWarehouseRawMaterialsToOneC,
  receiveWarehouseDefectBag,
  receiveWarehouseRawMaterial,
  isWarehousePalletPayload,
  scanWarehousePallet,
  scanWarehousePalletDelivery,
  scanWarehousePalletSelection,
  scanWarehousePayload,
  scanWarehouseTask,
  warehouseScanErrorMessage,
  shipWarehouseDefectBag,
  type ServerIntakeTask,
  type ServerWarehouseScanResult,
  type ServerWarehouseTask,
  type WarehouseBigBagCreateInput,
} from './api/warehouse';
import {
  isExactWarehouseOneCConfirmation,
  isValidWarehouseOneCPreview,
  isVerifiedWarehouseOneCResult,
  WAREHOUSE_ONEC_CONFIRMATION,
  warehouseOneCReadinessError,
  warehouseOneCSuccessTitle,
} from './api/warehouseOneCFlow';
import {
  addProblemReportToObject,
  createProblemReportContext,
  isProblemReportAction,
} from './domain/problemReports';
import {
  applyTemplateToIntakeDraft,
  refreshIntakeDraftFromSelectedTemplate,
} from './domain/intakeTemplates';
import {
  applyCreatedRecipeToIntakeDraft,
  COMMERCIAL_ORDER_CATALOG_STALE_MESSAGE,
  isCommercialMaterialSelectionAvailable,
  isCommercialOrderCatalogStaleError,
} from './domain/materialRecipeCatalog';
import {
  auditEntry,
  auditEntryWithValues,
  canReorderStatus,
  cloneWorkObjects,
  commercialActions,
  createAdminAccessObject,
  createCommercialObject,
  createIntakeDraftPosition,
  defaultIntakeDraft,
  defaultRoleAssignmentDraft,
  factValue,
  financeFromProduction,
  intakeCounterpartyLabel,
  intakeDraftIsComplete,
  intakeHasRequiredPositionFields,
  intakePositionMissingFields,
  intakePositionSummary,
  productionFromIntake,
  reduceFinanceObject,
  stampNow,
  updateFactList,
} from './domain/prototypeRuntime';
import {
  delegateAdminDiagnosticObject,
  recoverProductionObject,
  recordAdminDiagnosticIssueObject,
  resolveAdminDiagnosticObject,
  resolveWarehouseScanObject,
} from './domain/recoveryActions';
import type {
  IntakeDraftForm,
  IntakeDraftPosition,
  IntakeSubmitMode,
} from './domain/prototypeRuntime';
import { ActionPanel, HelpTooltip } from './components/shell/ActionPanel';
import {
  ActionConfirmationDialog,
  type ActionConfirmationDialogState,
} from './components/shell/ActionConfirmationDialog';
import {
  operatorActionToast,
  setupActionToastPosition,
  showActionToast,
  type ActionToastTone,
} from './components/shell/actionToasts';
import { applyDateScope, DateScopeDropdown } from './components/shell/DateScopeDropdown';
import { isEventFromNestedDialog, trapFocusWithin } from './components/shell/focusTrap';
import type { OfficeActionOutcome } from './components/shell/OfficeCommandBar';
import { ProblemReportDialog } from './components/shell/ProblemReportDialog';
import {
  AccountCabinet,
  canAcknowledgeNotification,
  DemoRoleSwitcher,
  NotificationCenter,
  ProductHeader,
  RoleNavigation,
  RoleTopNavigation,
} from './components/shell/appShell';
import { IntakeCreateSurface } from './components/shell/intakeCreateSurface';
import {
  createClientRequestId,
  createEmptyCommercialIntakeDraft,
} from './features/commercial/CommercialIntakeForm';
import { RecipeEditorModal } from './features/recipes/RecipeEditorModal';
import { useMaterialRecipeCatalog } from './features/recipes/useMaterialRecipeCatalog';
import {
  CounterpartyTemplateList,
  DetailView,
  ObjectList,
  TemplateDirectorySurface,
} from './components/shell/workObjectSurfaces';
import { AdminDevicesSurface } from './components/workbenches/adminDevicesSurface';
import {
  StockProductionTemplateDirectory,
  TemplateDirectoryModeTabs,
  type TemplateDirectoryMode,
} from './components/workbenches/StockProductionTemplateDirectory';
import { AdminLiveControlPlane } from './components/admin-live/AdminLiveControlPlane';
import { PalletLabelLayoutSection } from './features/admin/pallet-label-layout/PalletLabelLayoutSection';
import {
  AdminRoleTemplatesSurface,
  AdminUsersSurface,
  type AdminHistoryItem,
} from './components/workbenches/adminSurfaces';
import type {
  TemplateEditorMode,
  TemplateEditorState,
} from './components/shell/workObjectSurfaces';
import {
  AuditPanel,
  ContextPanel,
  FactList,
  InlineContextPanel,
  RoleEvidenceStrip,
  SeverityPill,
  evidenceItems,
  factHelpText,
  largeActionVariant,
} from './components/shell/viewPrimitives';
import {
  OperatorMachineChangePanel,
  OperatorShiftSurface,
  Workbench,
} from './components/workbenches/floorWorkbenches';
import { OperatorPenaltiesSurface } from './components/workbenches/operatorPenalties';
import { OperatorPayrollSurface } from './components/workbenches/OperatorPayrollSurface';
import { ShiftClosingPayrollSummary } from './features/operator/ShiftClosingPayrollSummary';
import {
  PenaltyManagementSurface,
  type EmployeeOption,
} from './components/workbenches/directorPenalties';
import {
  FinanceWorkbench,
  ProductionOrderWorkbench,
} from './components/workbenches/officeWorkbenches';
import {
  ProductionDispatchPanel,
  ProductionOperatorLoadSurface,
  type ProductionRollDraftChange,
} from './components/workbenches/productionDispatchPanel';
import { ProductionMachinePlanningSurface } from './components/workbenches/ProductionMachinePlanningSurface';
import { DefectDialog, submissionErrorMessage } from './components/workbenches/DefectDialog';
import { ProductionProblemsSurface } from './components/workbenches/ProductionProblemsSurface';
import { ProductionOrdersHubSurface } from './components/workbenches/ProductionOrdersHubSurface';
import {
  isOperatorWorkstationWidth,
  OperatorRollsHubPageLayout,
  OperatorRollsHubSurface,
  resetOperatorSectionScrollTargets,
  resetOperatorScrollTargets,
} from './components/workbenches/OperatorRollsHubSurface';
import { DirectorWorkbench } from './components/workbenches/directorWorkbench';
import {
  isWarehouseInventorySection,
  warehouseInventorySectionCount,
} from './components/workbenches/WarehouseInventorySectionList';
import { WarehouseScanStationSurface } from './components/workbenches/WarehouseScanStationSurface';
import {
  WarehouseDefectBagSurface,
  useWarehouseDefectBagQueues,
  warehouseDefectBagModeForSection,
} from './components/workbenches/WarehouseDefectBagSurface';
import {
  requestedRoleSelectionId,
  warehouseScanSelectionId,
} from './components/workbenches/warehouseScanSelection';
import type {
  DirectorQuickFilter,
  DirectorViewMode,
} from './components/workbenches/directorWorkbench';
import type { PenaltyFormPayload } from './components/workbenches/directorPenalties';
import { useDirectorSupplementalObjects } from './features/director/useDirectorSupplementalObjects';
import { DirectorRefreshButton } from './features/director/DirectorRefreshButton';
import type {
  ActionDescriptor,
  AdminWorkbench,
  AuditEntry,
  Counterparty,
  CounterpartyOrderTemplate,
  CounterpartyOrderTemplateField,
  CounterpartyOrderTemplateVersion,
  Fact,
  FinanceOrder,
  FinancePaymentCorrectionTarget,
  NotificationItem,
  OperatorRollReweighResult,
  OperatorRollStepBackResult,
  OperatorWorkbench,
  PermissionPolicy,
  QueueDateScope,
  CommercialOrderPosition,
  CommercialProductionProgress,
  CurrentRollResolution,
  ProductionPriority,
  ProductionRollDispatchItem,
  ProductionProblem,
  ProblemReportContext,
  ProblemReportPayload,
  Role,
  RoleAssignmentDraft,
  RoleTemplate,
  UserSession,
  UserAccessEntry,
  WarehouseCoverProposal,
  WarehouseCoverFreeRoll,
  WarehouseCoverTask,
  WarehouseStockMutationDraft,
  WarehouseWorkbench,
  WorkListItem,
  WorkObject,
  TemplateDiff,
} from './domain/types';
import {
  actionWeightValue,
  applyOperatorReweighResult,
  applyOperatorStepBackResult,
  canOperatorRecoverInvalidHandoverWeight,
  canOperatorReweigh,
  getOperatorSelectedObject,
  initialOperatorRuntime,
  normalizeOperatorSection,
  OPERATOR_ROLLS_SECTION,
  operatorCurrentRoll,
  operatorListItems,
  operatorNextWorkOrderId,
  operatorPersonalQueueBlockedReason,
  operatorRollGroupLabel,
  operatorRollQrWarehouseLabel,
  operatorRollStatusSeverity,
  operatorShiftBlockerText,
  operatorStageCooldownBlocksAction,
  operatorShiftRecoveryText,
  operatorShiftSeverity,
  operatorShiftStatusLabel,
  operatorStatusLabel,
  operatorToleranceLabel,
  isOperatorStageTransitionAction,
  isOperatorCurrentRoll,
  isOperatorStepBackAction,
  OPERATOR_STAGE_COOLDOWN_MS,
  operatorStepBackFailureDetail,
  operatorStepBackPrompt,
  parseManualKg,
  reconcileOperatorRuntimeRefresh,
  reduceOperatorRuntime,
  shouldPlayOperatorSuccessSound,
} from './domain/operatorRuntime';
import {
  defectBagTypeLabel,
  parseOperatorDefectBagPrintAction,
  parseOperatorDefectBagWeighAction,
  withOperatorDefectBag,
} from './domain/defectBagLabels';
import type {
  BigBagWeightDraft,
  OperatorBigBagPickerOption,
  OperatorRuntimeState,
} from './domain/operatorRuntime';
import type { TemplateSortMode } from './domain/templates';
import {
  initialProductionRuntimeState,
  buildDirectorDashboardProjection,
  penaltyListItems,
  penaltyWorkListId,
  penaltyRecipientRole,
  projectRuntimeToWorkObjects,
  reduceProductionRuntime,
} from './domain/runtime';
import type {
  DeviceMockContract,
  DirectorDashboardDrilldown,
  PenaltyRuntime,
  ProductionRuntimeState,
  RuntimeAction,
} from './domain/runtime';
import {
  applyWarehouseInventoryMutation,
  applyWarehouseStockMutation,
  applyCommercialWarehouseRecheckResult,
  completeWarehouseRecheckTask,
  recordWarehouseReserveOpened,
  recordWarehouseReserveReleased,
  warehouseRecheckTaskIdFromAction,
} from './domain/warehouseCloseout';
import { buildWarehouseInventoryDashboard } from './domain/warehouseInventoryDashboard';
import {
  consumeScannerTerminator,
  scannerAsciiFromPhysicalKey,
  shouldIgnoreHidCapture,
} from './domain/hidScannerKeyboard';
import {
  decodeWarehouseScanAction,
  isWarehouseScanSection,
  replaceObjectSelectionInUrl,
  warehousePalletScanIntent,
} from './domain/warehouseScan';
import {
  isWarehouseStockSection,
  normalizeWarehouseNotificationUrl,
  normalizeWarehouseSectionUrl,
  resolveWarehouseSection,
  warehouseInventoryCategoryForSection,
  warehouseSectionForCategory,
} from './domain/warehouseSections';
import {
  approveMaterialCostReference,
  upsertManualMaterialCostReference,
} from './domain/materialCostRuntime';

const HID_SCANNER_INTERKEY_TIMEOUT_MS = 100;
const PRODUCTION_TEMPLATE_SEARCH_DEBOUNCE_MS = 250;

type CommercialPositionSaveDraft = Pick<
  CommercialOrderPosition,
  | 'filmType'
  | 'actualThickness'
  | 'accountingThickness'
  | 'birka'
  | 'spoolType'
  | 'rawMaterialLabel'
  | 'warehouseCoverStatus'
> & {
  rollCount: string;
  manualBirka: string;
  warehousePartialCoverQty: string;
};

type CommercialPositionSavePayload = {
  positionId: string;
  draft: CommercialPositionSaveDraft;
};

type WorkObjectActionPayload = {
  operationAmount?: number;
  operationAmountLabel?: string;
};

function parseCommercialPositionSavePayload(
  targetId: string | undefined,
): CommercialPositionSavePayload | null {
  if (!targetId) return null;
  try {
    const parsed = JSON.parse(
      decodeURIComponent(targetId),
    ) as Partial<CommercialPositionSavePayload>;
    if (!parsed.positionId || !parsed.draft) return null;
    return parsed as CommercialPositionSavePayload;
  } catch {
    return null;
  }
}

function commercialPositionSummary(position: CommercialOrderPosition) {
  return `${position.rollCount} рул. · ${position.filmType} · факт ${position.actualThickness} · бух. ${position.accountingThickness} · ${position.rawMaterialLabel} · ${position.spoolType}`;
}

function commercialWarehouseRouteLabel(status: CommercialOrderPosition['warehouseCoverStatus']) {
  if (status === 'full_proposed' || status === 'full_confirmed') return 'Склад закрывает';
  if (status === 'partial_proposed' || status === 'partial_confirmed') return 'Часть со склада';
  if (status === 'needs_production') return 'В производство';
  if (status === 'recheck_requested') return 'Перепроверка склада';
  if (status === 'rejected') return 'Отклонено';
  return 'Не проверено';
}

function isFinanceInvoiceAction(actionId: string) {
  return actionId === 'issue' || actionId.startsWith('finance-create-invoice:');
}

function isFinanceCheckPaymentAction(actionId: string) {
  return (
    ['check-payment', 'check-installment', 'check-after-invoice'].includes(actionId) ||
    actionId.startsWith('finance-check-payment:')
  );
}

function financeScheduleIdFromAction(actionId: string) {
  const prefix = 'finance-confirm-schedule:';
  return actionId.startsWith(prefix) ? actionId.slice(prefix.length) : undefined;
}

function isFinanceManualPaymentAction(actionId: string) {
  return (
    ['update-payment', 'update-installment', 'update-after-invoice'].includes(actionId) ||
    actionId.startsWith('finance-update-payment:') ||
    actionId.startsWith('finance-confirm-cash:')
  );
}

function isFinanceDistributePaymentAction(actionId: string) {
  return actionId.startsWith('finance-distribute-payment:');
}

function isFinanceSourceRetryAction(actionId: string) {
  return (
    ['retry-sync', 'retry-issued'].includes(actionId) || actionId.startsWith('finance-retry-sync:')
  );
}

function isFinanceProblemAction(actionId: string) {
  return (
    ['problem', 'problem-sync', 'problem-delivery'].includes(actionId) ||
    actionId.startsWith('finance-create-problem:')
  );
}

function updateCommercialPositionFromPayload(
  object: WorkObject,
  payload: CommercialPositionSavePayload,
): WorkObject {
  const currentPosition = object.commercialOrder?.positions.find(
    (position) => position.id === payload.positionId,
  );
  if (!object.commercialOrder || !currentPosition) return object;

  const rollCount = Math.max(
    1,
    Math.min(999, Math.trunc(Number(payload.draft.rollCount) || currentPosition.rollCount)),
  );
  const nextPosition: CommercialOrderPosition = {
    ...currentPosition,
    rollCount,
    filmType: payload.draft.filmType.trim() || currentPosition.filmType,
    actualThickness: payload.draft.actualThickness.trim() || currentPosition.actualThickness,
    accountingThickness:
      payload.draft.accountingThickness.trim() || currentPosition.accountingThickness,
    birka:
      payload.draft.birka.trim() ||
      (payload.draft.manualBirka.trim() ? 'Бирка клиента' : currentPosition.birka),
    manualBirka: payload.draft.manualBirka.trim() || undefined,
    spoolType: payload.draft.spoolType.trim() || currentPosition.spoolType,
    rawMaterialLabel: payload.draft.rawMaterialLabel.trim() || currentPosition.rawMaterialLabel,
    warehouseCoverStatus:
      payload.draft.warehouseCoverStatus || currentPosition.warehouseCoverStatus,
    rawMaterials: currentPosition.rawMaterials?.map((material, index) =>
      index === 0
        ? {
            ...material,
            rawMaterialId: payload.draft.rawMaterialLabel.trim() || material.rawMaterialId,
            label: payload.draft.rawMaterialLabel.trim() || material.label,
          }
        : material,
    ),
  };
  const nextPositions = object.commercialOrder.positions.map((position) =>
    position.id === payload.positionId ? nextPosition : position,
  );
  const totalRolls = nextPositions.reduce((sum, position) => sum + position.rollCount, 0);
  const oldValue = commercialPositionSummary(currentPosition);
  const newValue = commercialPositionSummary(nextPosition);
  const positionIndex =
    object.commercialOrder.positions.findIndex((position) => position.id === payload.positionId) +
    1;
  const hasConfirmedCover = object.warehouseCoverProposals?.some(
    (proposal) => proposal.positionId === payload.positionId && proposal.confirmedAt,
  );
  const nextProposals = object.warehouseCoverProposals?.map((proposal) => {
    if (proposal.positionId !== payload.positionId || proposal.confirmedAt) return proposal;
    const requestedStatus = payload.draft.warehouseCoverStatus;
    const partialCoverQty = Math.trunc(Number(payload.draft.warehousePartialCoverQty));
    const maxPartialCoverQty = Math.max(1, Math.min(proposal.coverQty, Math.max(1, rollCount - 1)));
    const coverQty =
      requestedStatus === 'needs_production'
        ? 0
        : requestedStatus === 'full_proposed' || requestedStatus === 'full_confirmed'
          ? rollCount
          : Math.min(
              Math.max(1, Number.isFinite(partialCoverQty) ? partialCoverQty : proposal.coverQty),
              maxPartialCoverQty,
            );
    const missingQty = Math.max(0, rollCount - coverQty);
    return {
      ...proposal,
      coverQty,
      reserveQty: Math.min(proposal.reserveQty ?? coverQty, coverQty),
      missingQty,
      productionQty: missingQty,
      coverType: missingQty > 0 ? ('partial' as const) : ('full' as const),
      warehouseCoverStatus:
        requestedStatus === 'needs_production'
          ? requestedStatus
          : missingQty > 0
            ? ('partial_proposed' as const)
            : ('full_proposed' as const),
    };
  });
  const proposalForPosition = nextProposals?.find(
    (proposal) => proposal.positionId === payload.positionId,
  );
  const nextWarehouseCoverStatus =
    proposalForPosition?.warehouseCoverStatus ?? nextPosition.warehouseCoverStatus;
  const nextOrderWarehouseCoverStatus =
    nextProposals && nextProposals.length > 0
      ? nextProposals.every((proposal) => proposal.warehouseCoverStatus === 'needs_production')
        ? 'needs_production'
        : nextProposals.some((proposal) => proposal.missingQty > 0)
          ? 'partial_proposed'
          : 'full_proposed'
      : nextWarehouseCoverStatus;
  const manualSource = [
    nextPosition.manualBirka ? 'ручная бирка' : '',
    hasConfirmedCover ? 'после покрытия склада' : '',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    ...object,
    commercialOrder: {
      ...object.commercialOrder,
      positions: nextPositions.map((position) =>
        position.id === payload.positionId
          ? { ...position, warehouseCoverStatus: nextWarehouseCoverStatus }
          : position,
      ),
      warehouseCoverStatus: nextOrderWarehouseCoverStatus,
    },
    warehouseCoverProposals: nextProposals,
    facts: updateFactList(
      object.facts,
      {
        Позиции: `${nextPositions.length} поз., ${totalRolls} рул.`,
        Характеристики: nextPositions
          .map((position) => `${position.filmType} ${position.actualThickness}`)
          .join('; '),
        Сырье: nextPositions.map((position) => position.rawMaterialLabel).join('; '),
        Склад: commercialWarehouseRouteLabel(nextOrderWarehouseCoverStatus),
      },
      'commercial',
    ),
    audit: [
      auditEntryWithValues(
        object.id,
        'Коммерция',
        hasConfirmedCover
          ? 'audit:commercial_position_edited_after_warehouse_cover'
          : 'audit:commercial_order_position_updated',
        `Позиция ${positionIndex || payload.positionId} сохранена из inline-таблицы${manualSource ? ` (${manualSource})` : ''}.`,
        {
          oldValue,
          newValue,
          sourceSnapshot: 'commercial-position-matrix',
        },
      ),
      ...object.audit,
    ],
  };
}

const productionMachineLabels: Record<string, string> = {
  'E-01': 'Экструдер E-01',
  'E-02': 'Экструдер E-02',
  'E-03': 'Экструдер E-03',
  'E-04': 'Экструдер E-04',
  'E-06': 'Экструдер E-06',
};

function productionMachineLabel(machineId: string) {
  if (!machineId) return 'Не выбран';
  return productionMachineLabels[machineId] ?? machineId;
}

function filterHelp(filter: string) {
  const map: Record<string, string> = {
    Все: 'Показывает актуальные строки: активные, плановые и заблокированные.',
    'Требуют действия': 'Оставляет строки, где есть доступное следующее действие.',
    Заблокированы: 'Оставляет строки с критичным состоянием или недоступным действием.',
    'С проблемами': 'Показывает строки, у которых есть открытая проблема.',
    Архив: 'Показывает завершенные строки. Здесь только просмотр и история, без рабочих действий.',
  };
  return map[filter] ?? `Фильтр очереди: ${filter}.`;
}

function filterChipLabel(filter: string) {
  const map: Record<string, string> = {
    Все: 'Актуальные',
    'Требуют действия': 'Действия',
    Заблокированы: 'Блокеры',
    'С проблемами': 'Проблемы',
    Архив: 'Завершенные',
  };
  return map[filter] ?? filter;
}

function initialRole(): Role {
  return resolveInitialRole({
    authRequired: AUTH_REQUIRED,
    verifiedRole: AUTH_REQUIRED ? (loadSession()?.role ?? null) : null,
    search: window.location.search,
  });
}

function defaultSectionForRole(role: Role) {
  if (role === 'admin') return 'Устройства';
  if (role === 'director') return 'Контроль';
  if (role === 'finance') return 'Счета';
  return getRoleConfig(role).nav[0];
}

function initialSections() {
  return roleOrder.reduce(
    (acc, role) => ({ ...acc, [role]: defaultSectionForRole(role) }),
    {} as Record<Role, string>,
  );
}

function normalizeSectionForRole(
  role: Role,
  section: string,
  searchParams?: URLSearchParams,
): string {
  if (role === 'operator') return normalizeOperatorSection(section);
  if (role === 'warehouse') return resolveWarehouseSection(section, searchParams).section;
  if (role === 'finance') return normalizeFinanceSection(section);
  return section;
}

function initialSectionsFromUrl(role: Role) {
  const sections = initialSections();
  const searchParams = new URLSearchParams(window.location.search);
  const requestedSection = searchParams.get('section');
  const normalizedSection = requestedSection
    ? normalizeSectionForRole(role, requestedSection, searchParams)
    : requestedSection;
  if (normalizedSection && getRoleConfig(role).nav.includes(normalizedSection)) {
    sections[role] = normalizedSection;
  }
  return sections;
}

function initialSelectionFromUrl(role: Role) {
  const requestedObject = new URLSearchParams(window.location.search).get('object');
  return roleOrder.reduce(
    (acc, item) => ({
      ...acc,
      [item]:
        AUTH_REQUIRED && isLiveContour(item)
          ? item === role
            ? requestedObject
            : null
          : item === role &&
              requestedObject &&
              item === 'operator' &&
              (isLiveContour('operator') ||
                Boolean(getOperatorSelectedObject(initialOperatorRuntime, requestedObject)))
            ? requestedObject
            : item === role &&
                requestedObject &&
                item === 'commercial' &&
                isLiveContour('commercial')
              ? requestedObject
              : requestedRoleSelectionId(item, role, requestedObject, workObjects[item]),
    }),
    {} as Record<Role, string | null>,
  );
}

const ADMIN_ROLE_TEMPLATES_STORAGE_KEY = 'plenki.admin.roleTemplates.v1';
const ADMIN_DEVICE_CATALOG_STORAGE_KEY = 'plenki.admin.deviceCatalog.v1';

function cloneRoleTemplate(template: RoleTemplate): RoleTemplate {
  return {
    ...template,
    visibleSections: [...template.visibleSections],
    hiddenScopes: [...template.hiddenScopes],
    capabilities: [...template.capabilities],
    allowedActions: [...template.allowedActions],
  };
}

function initialAdminRoleTemplates() {
  if (typeof window === 'undefined') {
    return initialRoleTemplates.map(cloneRoleTemplate);
  }

  try {
    const storedTemplates = window.localStorage.getItem(ADMIN_ROLE_TEMPLATES_STORAGE_KEY);
    if (storedTemplates) {
      const parsedTemplates = JSON.parse(storedTemplates) as RoleTemplate[];
      if (Array.isArray(parsedTemplates) && parsedTemplates.length > 0) {
        return parsedTemplates.map(cloneRoleTemplate);
      }
    }
  } catch {
    // Prototype persistence is best-effort; the admin editor still works in memory.
  }

  return initialRoleTemplates.map(cloneRoleTemplate);
}

function cloneProductionRuntime(state: ProductionRuntimeState): ProductionRuntimeState {
  return {
    ...state,
    events: state.events.map((event) => ({ ...event })),
    warehouseAcceptances: state.warehouseAcceptances.map((acceptance) => ({ ...acceptance })),
    deliveries: state.deliveries.map((delivery) => ({ ...delivery })),
    paymentTriggers: state.paymentTriggers.map((trigger) => ({ ...trigger })),
    problems: state.problems.map((problem) => ({ ...problem })),
    labelPrintJobs: state.labelPrintJobs.map((job) => ({ ...job })),
    defects: state.defects.map((defect) => ({ ...defect })),
    penalties: state.penalties.map((penalty) => ({
      ...penalty,
      history: penalty.history.map((item) => ({ ...item })),
    })),
    devices: state.devices.map((device) => ({ ...device })),
    commercialDrafts: state.commercialDrafts.map((draft) => ({ ...draft })),
    orders: state.orders.map((order) => ({
      ...order,
      blockingReasons: [...order.blockingReasons],
    })),
    financeOrders: state.financeOrders.map((order) => ({ ...order })),
    directorDecisions: state.directorDecisions.map((decision) => ({ ...decision })),
    kickbacks: state.kickbacks.map((kickback) => ({ ...kickback })),
  };
}

function isDeviceMockContract(value: unknown): value is DeviceMockContract {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DeviceMockContract>;
  return (
    typeof item.id === 'string' &&
    ['scale', 'scanner', 'printer', 'financeSource'].includes(item.kind ?? '') &&
    ['ready', 'offline', 'unstable', 'error', 'not_required'].includes(item.status ?? '') &&
    ['Админ', 'Склад', 'Бухгалтерия'].includes(item.ownerRole ?? '') &&
    typeof item.lastSeenAt === 'string' &&
    typeof item.rawPayload === 'string' &&
    typeof item.parsedPayload === 'string' &&
    typeof item.recovery === 'string'
  );
}

function initialProductionRuntime() {
  const nextState = cloneProductionRuntime(initialProductionRuntimeState);
  if (typeof window === 'undefined') return nextState;

  try {
    const storedDevices = window.localStorage.getItem(ADMIN_DEVICE_CATALOG_STORAGE_KEY);
    if (!storedDevices) return nextState;
    const parsedDevices = JSON.parse(storedDevices) as unknown;
    if (Array.isArray(parsedDevices) && parsedDevices.every(isDeviceMockContract)) {
      const devicesById = new Map(nextState.devices.map((device) => [device.id, { ...device }]));
      for (const storedDevice of parsedDevices) {
        devicesById.set(storedDevice.id, { ...devicesById.get(storedDevice.id), ...storedDevice });
      }
      return { ...nextState, devices: Array.from(devicesById.values()) };
    }
  } catch {
    // Prototype persistence is best-effort; the admin catalog still works in memory.
  }

  return nextState;
}

function emptyOperatorRuntime(): OperatorRuntimeState {
  return {
    shift: {
      id: '',
      status: 'closed',
      operatorName: '',
      workplace: '',
      bigBagId: '',
      expectedEndKg: 0,
      plannedUsageKg: 0,
    },
    orders: [],
    audit: {},
  };
}

function emptyProductionRuntime(): ProductionRuntimeState {
  return {
    events: [],
    warehouseAcceptances: [],
    deliveries: [],
    paymentTriggers: [],
    problems: [],
    labelPrintJobs: [],
    defects: [],
    penalties: [],
    devices: [],
    commercialDrafts: [],
    orders: [],
    financeOrders: [],
    directorDecisions: [],
    kickbacks: [],
  };
}

function initialLiveWorkObjects(): WorkObjectsByRole {
  const initial = cloneWorkObjects(workObjects);
  if (!AUTH_REQUIRED) return initial;
  for (const role of roleOrder) {
    if (isLiveContour(role)) initial[role] = [];
  }
  return initial;
}

type LiveRoleLoadState = 'loading' | 'ready' | 'stale' | 'failed';

function LiveRoleUnavailable({
  role,
  state,
}: {
  role: LiveRoleSnapshotRole;
  state: Exclude<LiveRoleLoadState, 'ready'>;
}) {
  return (
    <section className="live-role-unavailable" role={state === 'loading' ? 'status' : 'alert'}>
      <IxEmptyState
        header={
          state === 'loading'
            ? 'Загружаем рабочие данные'
            : state === 'stale'
              ? 'Данные устарели'
              : LIVE_ROLE_LOAD_ERROR_TITLE[role]
        }
        subHeader={
          state === 'loading'
            ? 'Дождитесь завершения загрузки.'
            : state === 'stale'
              ? 'Предыдущие данные скрыты, рабочие действия отключены до свежего снимка.'
              : 'Рабочие действия отключены. Повторяем загрузку автоматически.'
        }
        icon="cloud-success"
      />
    </section>
  );
}

function isFocusedRole(role: Role) {
  return role === 'operator' || role === 'warehouse';
}

function notificationMatchesSession(notification: NotificationItem, session: UserSession) {
  return notification.recipientRole === session.role || notification.recipientUserId === session.id;
}

function unreadCount(notifications: NotificationItem[]) {
  return notifications.filter((notification) => !notification.readAt).length;
}

function legacyPenaltySnapshot(items: PenaltyRuntime[]): PenaltySnapshotRuntime {
  const reasonCounts = new Map<string, number>();
  let totalAmountKopecks = 0;
  for (const penalty of items) {
    totalAmountKopecks += Math.round(
      Number(penalty.amountLabel.replace(/[^\d,.-]/g, '').replace(',', '.')) * 100,
    );
    const reason = penalty.reason.normalize('NFKC').trim().toLocaleLowerCase('ru-RU');
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const topReason =
    [...reasonCounts.entries()].sort(
      ([leftReason, leftCount], [rightReason, rightCount]) =>
        rightCount - leftCount || leftReason.localeCompare(rightReason, 'ru-RU'),
    )[0]?.[0] ?? null;
  return {
    items,
    summary: { totalCount: items.length, totalAmountKopecks, topReason },
  };
}

function ackCount(notifications: NotificationItem[]) {
  return notifications.filter(canAcknowledgeNotification).length;
}

function hasDirectorPaymentDueNotification(notifications: NotificationItem[], objectId: string) {
  return notifications.some(
    (notification) =>
      notification.objectId === objectId &&
      notification.recipientRole === 'director' &&
      notification.title === 'Оплата сегодня',
  );
}

function commercialIdFromProductionId(objectId: string) {
  return objectId.startsWith('ЗН-') ? `З-${objectId.replace(/^ЗН-/, '')}` : objectId;
}

function productionIdFromCommercialId(objectId: string) {
  return objectId.startsWith('ЗН-') ? objectId : `ЗН-${objectId.replace(/^З-/, '')}`;
}

function financeIdFromOrderId(objectId: string) {
  return `FIN-${objectId.replace(/^ЗН-/, '').replace(/^З-/, '')}`;
}

function parseWarehouseCoverSelection(actionId: string) {
  const [, payload = ''] = actionId.split(':');
  return payload.split(';').reduce<Record<string, number>>((acc, pair) => {
    const [rawId, rawValue] = pair.split('=');
    const value = Number(rawValue);
    if (!rawId || Number.isNaN(value)) return acc;
    acc[decodeURIComponent(rawId)] = Math.max(0, Math.trunc(value));
    return acc;
  }, {});
}

function resizeMatchedRolls(
  matchedRolls: WarehouseCoverProposal['matchedRolls'],
  coverQty: number,
): WarehouseCoverProposal['matchedRolls'] {
  let remainingQty = coverQty;
  return matchedRolls
    .map((roll) => {
      const qty = Math.min(roll.qty, Math.max(0, remainingQty));
      remainingQty -= qty;
      return { ...roll, qty };
    })
    .filter((roll) => roll.qty > 0);
}

function applyWarehouseCoverSelection(
  object: WorkObject,
  selectedCoverQtyByProposalId: Record<string, number>,
): WorkObject {
  if (!object.warehouseCoverProposals || Object.keys(selectedCoverQtyByProposalId).length === 0)
    return object;
  return {
    ...object,
    warehouseCoverProposals: object.warehouseCoverProposals.map((proposal) => {
      if (proposal.confirmedAt || selectedCoverQtyByProposalId[proposal.id] === undefined)
        return proposal;
      const requestedQty = proposal.coverQty + proposal.missingQty;
      const maxCoverQty = proposal.coverQty;
      const coverQty = Math.max(
        0,
        Math.min(maxCoverQty, Math.trunc(selectedCoverQtyByProposalId[proposal.id])),
      );
      const missingQty = Math.max(0, requestedQty - coverQty);
      return {
        ...proposal,
        coverType: missingQty > 0 ? 'partial' : 'full',
        coverQty,
        reserveQty: coverQty,
        missingQty,
        productionQty: missingQty,
        matchedRolls: resizeMatchedRolls(proposal.matchedRolls, coverQty),
      };
    }),
  };
}

function createProductionProblem(object: WorkObject, reason: string): ProductionProblem {
  const commercialOrderId = object.commercialOrder?.id ?? commercialIdFromProductionId(object.id);
  const firstPosition = object.commercialOrder?.positions[0];
  const totalRolls =
    object.commercialOrder?.positions?.reduce((sum, position) => sum + position.rollCount, 0) ?? 1;

  return {
    id: `PP-${object.id}-${Date.now()}`,
    orderId: productionIdFromCommercialId(commercialOrderId),
    commercialOrderId,
    positionId: firstPosition?.id,
    reportedByRole: 'production_lead',
    reportedByUserId: 'production-lead-current',
    targetRole: 'commercial',
    ownerRole: 'Коммерция',
    comment: reason,
    reason,
    recovery:
      'Коммерция задает изменение и рулон применения; зав. производства решает текущий рулон.',
    severity: object.severity === 'critical' ? 'critical' : 'warning',
    status: 'open',
    completedRolls: 0,
    currentRollNumber: 1,
    totalRolls,
    createdAt: stampNow(),
  };
}

function progressFromProductionProblem(problem: ProductionProblem): CommercialProductionProgress {
  return {
    orderId: problem.orderId,
    completedRolls: problem.completedRolls ?? 0,
    currentRollNumber: problem.currentRollNumber ?? 1,
    totalRolls: problem.totalRolls ?? 1,
    activeProblemIds: [problem.id],
    updatedAt: stampNow(),
    source: 'production_runtime',
  };
}

function resolvePaymentDueNotifications(
  notifications: NotificationItem[],
  objectId: string,
  directorUpdate: Pick<NotificationItem, 'title' | 'body' | 'severity'>,
) {
  return notifications.map((notification) => {
    if (notification.objectId !== objectId) return notification;
    if (notification.recipientRole === 'finance' && notification.title === 'Оплата сегодня') {
      return {
        ...notification,
        readAt: notification.readAt ?? 'сейчас',
        acknowledgedAt: notification.requiresAck
          ? (notification.acknowledgedAt ?? 'сейчас')
          : notification.acknowledgedAt,
      };
    }
    if (notification.recipientRole === 'director' && notification.title === 'Оплата сегодня') {
      return {
        ...notification,
        ...directorUpdate,
        requiresAck: false,
        sound: false,
      };
    }
    return notification;
  });
}

function playPrototypeBeep() {
  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = 740;
  gain.gain.value = 0.04;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.addEventListener(
    'ended',
    () => {
      void context.close();
    },
    { once: true },
  );
  oscillator.start();
  oscillator.stop(context.currentTime + 0.12);
}

function numericPrefix(value: string) {
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function updateReceivingFactValue(value: string, acceptedQty: number, unit: string) {
  const nextQty = numericPrefix(value) + acceptedQty;
  const suffix = value.includes('·') ? value.slice(value.indexOf('·')) : ` ${unit}`;
  return `${nextQty} ${unit} ${suffix}`.replace(/\s+·/, ' ·');
}

function actionToastTitle(title: string) {
  return title.replace(/\.$/, '');
}

function actionTargetId(actionId: string, fallbackId: string) {
  if (!actionId.includes(':')) return fallbackId.replace(/^DIR-/, '');
  return actionId.slice(actionId.indexOf(':') + 1).split(':')[0] || fallbackId.replace(/^DIR-/, '');
}

function actionInlineReason(actionId: string) {
  const parts = actionId.split(':');
  if (parts.length < 3) return null;
  const payload = parts.slice(2).join(':');
  if (!payload.startsWith('reason=')) return null;
  try {
    return decodeURIComponent(payload.slice('reason='.length));
  } catch {
    return payload.slice('reason='.length);
  }
}

function directorFinanceOverrideOutcome(actionId: string) {
  const normalized = actionId.toLowerCase();
  const kind = normalized.includes('emergency')
    ? 'Срочная сверка запрошена'
    : normalized.includes('return')
      ? 'Возврат бухгалтерии'
      : normalized.includes('plan')
        ? 'План оплаты подтвержден'
        : 'Ручная проверка запрошена';
  return {
    kind,
    auditAction: normalized.includes('request')
      ? 'audit:director_finance_override_requested'
      : 'audit:director_finance_override_applied',
    returnsToFinance: normalized.includes('return'),
    warning: normalized.includes('return'),
    emergency: normalized.includes('emergency'),
  };
}

function directorProductionOverrideOutcome(actionId: string) {
  const normalized = actionId.toLowerCase();
  return {
    kind: normalized.includes('owner')
      ? 'Ответственный назначен директором'
      : normalized.includes('priority')
        ? 'Приоритет изменен директором'
        : normalized.includes('return')
          ? 'Заказ-наряд возвращен'
          : 'Производственное исключение подтверждено',
    assignOwner: normalized.includes('owner'),
    setPriority: normalized.includes('priority'),
    returned: normalized.includes('return'),
    confirmed: normalized.includes('confirm'),
  };
}

function directorWarehouseOverrideOutcome(actionId: string) {
  const returned = actionId.toLowerCase().includes('return');
  return {
    kind: returned ? 'Складское исключение возвращено' : 'Складское исключение подтверждено',
    returned,
  };
}

function directorDecisionActionRequiresReason(actionId: string) {
  const normalized = actionId.toLowerCase();
  return (
    normalized.includes('approve') ||
    normalized.includes('confirm') ||
    normalized.includes('return') ||
    normalized.includes('assign') ||
    normalized.includes('queue-reorder') ||
    normalized.includes('kickback')
  );
}

function directorToastTitleForAction(normalizedActionId: string, object: WorkObject) {
  if (normalizedActionId.includes('approve') || normalizedActionId.includes('confirm')) {
    return object.statusLabel === 'Склад'
      ? 'Подтвердить складское исключение'
      : 'Подтвердить директорское решение';
  }
  if (normalizedActionId.includes('return')) return 'Вернуть владельцу';
  if (normalizedActionId.includes('assign')) return 'Назначить владельца';
  if (normalizedActionId.includes('queue-reorder')) return 'Изменить порядок очереди';
  if (normalizedActionId.includes('kickback')) return 'Подтвердить sensitive finance решение';
  return 'Записать директорское решение';
}

const directorAssignmentCandidates = [
  {
    value: 'production-lead',
    label: 'Зав. производства',
    description: 'Внести причину замены сырья и решить маршрут производства.',
    owner: 'Зав. производства',
    responsible: 'Артур, зав. производства',
  },
  {
    value: 'warehouse-lead',
    label: 'Склад',
    description: 'Подтвердить остаток, резерв и складской факт по сырью.',
    owner: 'Склад',
    responsible: 'Склад / старший смены',
  },
  {
    value: 'commercial-manager',
    label: 'Коммерция',
    description: 'Согласовать изменение с заказчиком или вернуть заявку.',
    owner: 'Коммерция',
    responsible: 'Коммерция / менеджер заказа',
  },
] as const;

function directorAssignmentCandidate(value?: string) {
  return (
    directorAssignmentCandidates.find((candidate) => candidate.value === value) ??
    directorAssignmentCandidates[0]
  );
}

function updateProductionRollDispatchObject(
  object: WorkObject,
  rollDispatchItemId: string,
  updateItem: (item: ProductionRollDispatchItem) => ProductionRollDispatchItem,
  audit: AuditEntry,
) {
  if (!object.productionRollDispatchItems?.some((item) => item.id === rollDispatchItemId))
    return object;
  return {
    ...object,
    productionRollDispatchItems: object.productionRollDispatchItems.map((item) =>
      item.id === rollDispatchItemId ? updateItem(item) : item,
    ),
    audit: [audit, ...object.audit],
  };
}

function updateProductionRollDispatchObjects(
  object: WorkObject,
  rollDispatchItemIds: string[],
  updateItem: (item: ProductionRollDispatchItem) => ProductionRollDispatchItem,
  audit: AuditEntry,
) {
  const idSet = new Set(rollDispatchItemIds);
  if (!object.productionRollDispatchItems?.some((item) => idSet.has(item.id))) return object;
  return {
    ...object,
    productionRollDispatchItems: object.productionRollDispatchItems.map((item) =>
      idSet.has(item.id) ? updateItem(item) : item,
    ),
    audit: [audit, ...object.audit],
  };
}

function moveProductionRollQueueAcrossObjects(
  objects: WorkObject[],
  rollDispatchItemId: string,
  direction: 'up' | 'down',
) {
  const activeItems = aggregateProductionRollDispatchItems(objects);
  const index = activeItems.findIndex((item) => item.id === rollDispatchItemId);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= activeItems.length)
    return { objects, moved: false };

  const currentItem = activeItems[index];
  const targetItem = activeItems[targetIndex];
  const currentRank = productionRollQueueRank(currentItem);
  const targetRank = productionRollQueueRank(targetItem);
  const changedIds = new Set([currentItem.id, targetItem.id]);
  const audit = auditEntryWithValues(
    rollDispatchItemId,
    'Зав. производства',
    'audit:production_queue_reordered',
    `${currentItem.rollId} перемещен ${direction === 'up' ? 'выше' : 'ниже'} в ручной очереди.`,
    {
      oldValue: String(currentRank),
      newValue: String(targetRank),
      reason: 'ручная сортировка очереди рулонов',
    },
  );

  return {
    moved: true,
    objects: objects.map((object) => {
      if (!object.productionRollDispatchItems?.some((item) => changedIds.has(item.id)))
        return object;
      return {
        ...object,
        productionRollDispatchItems: object.productionRollDispatchItems.map((item) => {
          if (item.id === currentItem.id) {
            return {
              ...item,
              queueRank: targetRank,
              updatedAt: stampNow(),
              auditEvent: 'audit:production_queue_reordered' as const,
            };
          }
          if (item.id === targetItem.id) {
            return {
              ...item,
              queueRank: currentRank,
              updatedAt: stampNow(),
              auditEvent: 'audit:production_queue_reordered' as const,
            };
          }
          return item;
        }),
        audit: [audit, ...object.audit],
      };
    }),
  };
}

function isProductionPriority(value: string): value is ProductionPriority {
  return value === 'обычный' || value === 'срочно' || value === 'критично';
}

function directorAssignmentDialogDetails(object: WorkObject) {
  const objectNumber = factValue(object, 'Номер') ?? factValue(object, 'Объект') ?? object.id;
  const problem =
    factValue(object, 'Риск') ??
    object.problems.find((item) => item.status === 'open')?.reason ??
    object.statusLabel;
  const needed =
    factValue(object, 'Что решить') ??
    object.problems.find((item) => item.status === 'open')?.recovery ??
    'Выбрать владельца разбора';

  return [
    { label: 'Проблема', value: problem },
    { label: 'Объект', value: objectNumber },
    { label: 'Нужно получить', value: needed },
  ];
}

function mergeCounterpartyTemplates(
  current: CounterpartyOrderTemplate[],
  incoming: CounterpartyOrderTemplate[],
) {
  if (incoming.length === 0) return current;
  const incomingIds = new Set(incoming.map((template) => template.id));
  return [
    ...incoming.map((template) => ({ ...template })),
    ...current.filter((template) => !incomingIds.has(template.id)),
  ];
}

function mergeCounterpartyTemplateVersions(
  current: CounterpartyOrderTemplateVersion[],
  incoming: CounterpartyOrderTemplateVersion[],
) {
  if (incoming.length === 0) return current;
  const incomingIds = new Set(incoming.map((version) => version.id));
  return [
    ...incoming.map((version) => ({
      ...version,
      fields: version.fields.map((field) => ({ ...field })),
    })),
    ...current.filter((version) => !incomingIds.has(version.id)),
  ];
}

function productionCounterpartiesFromServer(
  items: CommercialCounterpartyContract[],
): Counterparty[] {
  return items.map((item) => ({
    id: item.id,
    legalName: item.displayName,
    alias: item.displayName,
    source: item.billingSource === '1C' || item.billingSource === 'one_c' ? '1C' : 'manual',
    syncStatus:
      item.syncStatus === 'ready' || item.syncStatus === 'synced' ? 'synced' : 'not_synced',
    visibilityPolicy: 'Показано безопасное имя клиента.',
    templateIds: [],
    installmentTermsSource: 'Платёжные условия недоступны производственной роли.',
  }));
}

function mergeProductionCounterpartyPage(
  current: Counterparty[],
  incoming: Counterparty[],
  selectedCounterpartyId: string,
  append: boolean,
): Counterparty[] {
  const base = append
    ? current
    : current.filter((counterparty) => counterparty.id === selectedCounterpartyId);
  const incomingIds = new Set(incoming.map((counterparty) => counterparty.id));
  return [
    ...base.filter((counterparty) => !incomingIds.has(counterparty.id)),
    ...incoming,
  ];
}

function initialInboxStateByRole(): Record<RoleInboxRole, InboxState> {
  return roleOrder.reduce(
    (state, role) => ({ ...state, [role]: createInboxState() }),
    {} as Record<RoleInboxRole, InboxState>,
  );
}

function initialInboxRequestFrontiers(): Record<RoleInboxRole, InboxRequestFrontier> {
  return roleOrder.reduce(
    (frontiers, role) => ({ ...frontiers, [role]: new InboxRequestFrontier() }),
    {} as Record<RoleInboxRole, InboxRequestFrontier>,
  );
}

type OperatorShiftCloseAttempt = {
  shiftId: string;
  intent: string;
  operationKey: string | null;
  bags: Array<{ bigBagId: string; endKg: number }>;
};

function App() {
  const appShellRef = useRef<HTMLElement | null>(null);
  const intakeDialogRef = useRef<HTMLDivElement | null>(null);
  const intakeOpenTriggerRef = useRef<HTMLElement | null>(null);
  const productionIntakeCatalogRequestRef = useRef({
    generation: 0,
    opening: false,
    openController: null as AbortController | null,
    retrying: false,
    retryController: null as AbortController | null,
  });
  const intakeSubmissionPendingRef = useRef(false);
  const problemOpenTriggerRef = useRef<HTMLElement | null>(null);
  const liveRefreshControllerRef = useRef<LiveRefreshController<LiveRoleSnapshot> | null>(null);
  const operatorShiftCloseAttemptRef = useRef<OperatorShiftCloseAttempt | null>(null);
  const penaltyPeriodicRequestVersionRef = useRef(new WeakMap<object, number>());
  const adminInboxRefreshControllerRef = useRef<LiveRefreshController<RoleInboxPage> | null>(null);
  const selectedProductionShiftIdRef = useRef<string | null>(null);
  const liveSelectionInitializedRef = useRef<Partial<Record<LiveRoleSnapshotRole, boolean>>>({});
  const liveSnapshotLoadedRef = useRef<Partial<Record<LiveRoleSnapshotRole, boolean>>>({});
  const liveRefreshErrorRef = useRef<Partial<Record<LiveRoleSnapshotRole, string>>>({});
  const adminInboxRefreshErrorRef = useRef<string | null>(null);
  const inboxRequestedCursorsRef = useRef<Partial<Record<RoleInboxRole, Set<string>>>>({});
  const inboxRequestFrontiersRef = useRef(initialInboxRequestFrontiers());
  const pendingInboxReadsRef = useRef<Map<string, PendingInboxRead>>(new Map());
  if (!liveRefreshControllerRef.current) {
    liveRefreshControllerRef.current = new LiveRefreshController<LiveRoleSnapshot>();
  }
  if (!adminInboxRefreshControllerRef.current) {
    adminInboxRefreshControllerRef.current = new LiveRefreshController<RoleInboxPage>();
  }
  const [activeRole, setActiveRole] = useState<Role>(initialRole);
  const [filter, setFilter] = useState('Все');
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.innerWidth <= 900);
  const [isOperatorWorkstationViewport, setIsOperatorWorkstationViewport] = useState(() =>
    isOperatorWorkstationWidth(window.innerWidth, window.outerWidth, window.devicePixelRatio),
  );
  const [operatorRuntime, setOperatorRuntime] = useState<OperatorRuntimeState>(() =>
    AUTH_REQUIRED && isLiveContour('operator') ? emptyOperatorRuntime() : initialOperatorRuntime,
  );
  const [operatorPendingActionId, setOperatorPendingActionId] = useState<string | null>(null);
  const [operatorBreakdownPending, setOperatorBreakdownPending] = useState(false);
  const [operatorBreakdownError, setOperatorBreakdownError] = useState<string | null>(null);
  const [operatorBreakdownSuccessVersion, setOperatorBreakdownSuccessVersion] = useState(0);
  const [operatorClosingPayroll, setOperatorClosingPayroll] = useState<{
    userId: string;
    payroll: OperatorShiftClosingPayrollView;
  } | null>(null);
  const operatorStageCooldownTimerRef = useRef<number | null>(null);
  const [liveOperatorPenalties, setLiveOperatorPenalties] = useState<PenaltyRuntime[]>([]);
  const {
    byRole: livePenaltySnapshots,
    changeFilters: changeLivePenaltyFilters,
    refresh: refreshLivePenaltySnapshot,
    applyPeriodicSnapshot: applyPeriodicPenaltySnapshot,
    getAppliedFilters: getAppliedPenaltyFilters,
    getRequestVersion: getPenaltyRequestVersion,
    reset: resetLivePenaltySnapshot,
  } = usePenaltySnapshotState({
    fetchSnapshot: fetchPenaltySnapshot,
    onError: (role, error) => {
      showMutationToast(
        role,
        undefined,
        'penalty:read',
        'warning',
        'Штрафы не обновлены',
        `${error instanceof Error ? error.message : 'Не удалось обновить штрафы.'} Показаны последние успешно загруженные данные.`,
      );
    },
  });
  const [liveDirectorPenaltyEmployees, setLiveDirectorPenaltyEmployees] = useState<
    EmployeeOption[]
  >([]);
  const [productionRuntime, setProductionRuntime] = useState<ProductionRuntimeState>(() =>
    AUTH_REQUIRED ? emptyProductionRuntime() : initialProductionRuntime(),
  );
  const [operatorBigBags, setOperatorBigBags] = useState<OperatorBigBagPickerOption[]>([]);
  const [operatorMachineChange, setOperatorMachineChange] =
    useState<OperatorMachineChangeView | null>(null);
  const [operatorMachineChangeBusy, setOperatorMachineChangeBusy] = useState(false);
  const [operatorLiveTick, setOperatorLiveTick] = useState(0);
  const [warehouseLiveTick, setWarehouseLiveTick] = useState(0);
  const [warehouseIntakeTasks, setWarehouseIntakeTasks] = useState<ServerIntakeTask[]>([]);
  const [warehouseDeliveryTasks, setWarehouseDeliveryTasks] = useState<ServerWarehouseTask[]>([]);
  const [warehouseCoverFreeRolls, setWarehouseCoverFreeRolls] = useState<WarehouseCoverFreeRoll[]>(
    [],
  );
  const [bigBagWeightDraft, setBigBagWeightDraft] = useState<BigBagWeightDraft>({
    startKg: '',
    endKg: '',
  });
  const [workObjectsByRole, setWorkObjectsByRole] =
    useState<WorkObjectsByRole>(initialLiveWorkObjects);
  const [productionShifts, setProductionShifts] = useState<ProductionShift[]>([]);
  const [productionPosts, setProductionPosts] = useState<ProductionPost[]>([]);
  const [productionOperatorOptions, setProductionOperatorOptions] = useState<
    ProductionOperatorOption[]
  >([]);
  const [productionProblems, setProductionProblems] = useState<ServerProductionProblem[]>(() =>
    AUTH_REQUIRED ? [] : createDemoProductionProblems(),
  );
  const [productionCommercialActionsState, setProductionCommercialActionsState] = useState<
    'ready' | 'loading' | 'error'
  >('ready');
  const [directorProblems, setDirectorProblems] = useState<ServerProductionProblem[]>(() =>
    AUTH_REQUIRED ? [] : createDemoProductionProblems(),
  );
  const [selectedProductionProblemId, setSelectedProductionProblemIdState] = useState<
    string | null
  >(() =>
    activeRole === 'production'
      ? (productionProblemSelectionFromSearch(window.location.search)?.problemId ?? null)
      : null,
  );
  const selectedProductionProblemIdRef = useRef(selectedProductionProblemId);
  const [selectedBusinessProblemIdByRole, setSelectedBusinessProblemIdByRole] = useState<
    Record<'commercial' | 'director', string | null>
  >(() => ({
    commercial:
      activeRole === 'commercial'
        ? businessProblemSelectionFromSearch(window.location.search, 'commercial')
        : null,
    director:
      activeRole === 'director'
        ? businessProblemSelectionFromSearch(window.location.search, 'director')
        : null,
  }));
  const [selectedAdminIncidentId, setSelectedAdminIncidentId] = useState<string | null>(() =>
    activeRole === 'admin' ? adminIncidentSelectionFromSearch(window.location.search) : null,
  );
  const [directorControl, setDirectorControl] = useState<ServerDirectorControl | null>(null);
  const [directorDecisions, setDirectorDecisions] = useState<ServerDirectorDecision[]>([]);
  const [directorLiveTick, setDirectorLiveTick] = useState(0);
  const [productionOperatorMachineView, setProductionOperatorMachineView] =
    useState<ProductionOperatorMachineView | null>(null);
  const [productionPlanningBusy, setProductionPlanningBusy] = useState(false);
  const [liveRoleLoadStateByRole, setLiveRoleLoadStateByRole] = useState<
    Partial<Record<LiveRoleSnapshotRole, LiveRoleLoadState>>
  >({});
  const [selectedByRole, setSelectedByRole] = useState<Record<Role, string | null>>(() =>
    initialSelectionFromUrl(activeRole),
  );
  const [activeSectionByRole, setActiveSectionByRole] = useState<Record<Role, string>>(() =>
    initialSectionsFromUrl(activeRole),
  );
  const [queueDateScopeByRole, setQueueDateScopeByRole] = useState<Record<Role, QueueDateScope>>(
    () =>
      roleOrder.reduce(
        (acc, role) => ({ ...acc, [role]: 'all' }),
        {} as Record<Role, QueueDateScope>,
      ),
  );
  const [notifications, setNotifications] = useState<NotificationItem[]>(() =>
    initialNotifications
      .filter((notification) => !isLiveContour(notification.recipientRole))
      .map((notification) => ({ ...notification })),
  );
  const [inboxStateByRole, setInboxStateByRole] =
    useState<Record<RoleInboxRole, InboxState>>(initialInboxStateByRole);
  const [liveMeByRole, setLiveMeByRole] = useState<
    Partial<Record<LiveRoleSnapshotRole, MeResponse>>
  >({});
  const [businessRefreshGeneration, setBusinessRefreshGeneration] = useState(0);
  const [directorRefreshPending, setDirectorRefreshPending] = useState(false);
  const [openPanel, setOpenPanel] = useState<'none' | 'notifications' | 'account'>('none');
  const [seenNewObjectIds, setSeenNewObjectIds] = useState<Set<string>>(() => new Set());
  const [soundByRole, setSoundByRole] = useState<Record<Role, boolean>>(() =>
    roleOrder.reduce(
      (acc, role) => ({ ...acc, [role]: userSessions[role].notificationSound }),
      {} as Record<Role, boolean>,
    ),
  );
  const [reducedMotionByRole, setReducedMotionByRole] = useState<Record<Role, boolean>>(() =>
    roleOrder.reduce(
      (acc, role) => ({ ...acc, [role]: userSessions[role].reducedMotion }),
      {} as Record<Role, boolean>,
    ),
  );
  const [isIntakeDrawerOpen, setIntakeDrawerOpen] = useState(false);
  const [intakeCreatorRole, setIntakeCreatorRole] = useState<'commercial' | 'production_lead'>(
    'commercial',
  );
  const [intakeDraftOnly, setIntakeDraftOnly] = useState(false);
  const [intakeDraft, setIntakeDraft] = useState<IntakeDraftForm>(defaultIntakeDraft);
  const [intakeClientRequestId, setIntakeClientRequestId] = useState(createClientRequestId);
  const [intakeSubmitting, setIntakeSubmitting] = useState(false);
  const [intakeRecipeEditorPositionId, setIntakeRecipeEditorPositionId] = useState<string | null>(
    null,
  );
  const [intakeMaterialSelectionInvalidPositionIds, setIntakeMaterialSelectionInvalidPositionIds] =
    useState<Set<string>>(() => new Set());
  const [templateCatalog, setTemplateCatalog] = useState<CounterpartyOrderTemplate[]>(() =>
    AUTH_REQUIRED ? [] : counterpartyTemplates.map((template) => ({ ...template })),
  );
  const [templateVersions, setTemplateVersions] = useState<CounterpartyOrderTemplateVersion[]>(
    () =>
      AUTH_REQUIRED
        ? []
        : counterpartyTemplateVersions.map((version) => ({
            ...version,
            fields: version.fields.map((field) => ({ ...field })),
          })),
  );
  const [templateDraftPositions, setTemplateDraftPositions] = useState<
    Record<string, IntakeDraftPosition[]>
  >({});
  const [selectedCounterpartyId, setSelectedCounterpartyId] = useState(
    AUTH_REQUIRED ? '' : (counterparties[0]?.id ?? ''),
  );
  const [productionTemplateCounterparties, setProductionTemplateCounterparties] = useState<
    Counterparty[]
  >([]);
  const [productionTemplateCounterpartyQuery, setProductionTemplateCounterpartyQuery] =
    useState('');
  const [productionTemplateNextCursor, setProductionTemplateNextCursor] = useState<string | null>(
    null,
  );
  const [productionTemplatePageLoading, setProductionTemplatePageLoading] = useState(false);
  const productionTemplateCounterpartiesRef = useRef<Counterparty[]>([]);
  const productionTemplatePaginationControllerRef = useRef<AbortController | null>(null);
  const selectedCounterpartyIdRef = useRef(selectedCounterpartyId);
  productionTemplateCounterpartiesRef.current = productionTemplateCounterparties;
  selectedCounterpartyIdRef.current = selectedCounterpartyId;
  const [productionIntakeCounterparties, setProductionIntakeCounterparties] = useState<
    Counterparty[]
  >([]);
  const [productionIntakeTemplates, setProductionIntakeTemplates] = useState<
    CounterpartyOrderTemplate[]
  >([]);
  const [productionIntakeTemplateVersions, setProductionIntakeTemplateVersions] = useState<
    CounterpartyOrderTemplateVersion[]
  >([]);
  const [productionIntakeDraftPositions, setProductionIntakeDraftPositions] = useState<
    Record<string, IntakeDraftPosition[]>
  >({});
  const [productionIntakeTemplateWarning, setProductionIntakeTemplateWarning] = useState<
    string | null
  >(null);
  const [productionIntakeTemplateRetrying, setProductionIntakeTemplateRetrying] = useState(false);
  const [productionTemplateLoadState, setProductionTemplateLoadState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [productionTemplateLoadError, setProductionTemplateLoadError] = useState<string | null>(
    null,
  );
  const [productionTemplateReloadGeneration, setProductionTemplateReloadGeneration] = useState(0);
  const [templateQuery, setTemplateQuery] = useState('');
  const [templateSort, setTemplateSort] = useState<TemplateSortMode>('recent');
  const [templateEditor, setTemplateEditor] = useState<TemplateEditorState | null>(null);
  const [templateDirectoryMode, setTemplateDirectoryMode] =
    useState<TemplateDirectoryMode>('counterparty');
  const [selectedTemplateByObject, setSelectedTemplateByObject] = useState<Record<string, string>>(
    {},
  );
  const [adminUsers, setAdminUsers] = useState(() =>
    userAccessEntries.map((entry) => ({ ...entry })),
  );
  const [adminRoleTemplates, setAdminRoleTemplates] = useState<RoleTemplate[]>(() =>
    initialAdminRoleTemplates(),
  );
  const [adminHistory, setAdminHistory] = useState<AdminHistoryItem[]>(() => [
    {
      id: 'admin-history-initial-access',
      time: '08:40',
      actor: 'Администратор',
      action: 'Базовые доступы загружены',
      target: 'Доступы',
      detail: 'Назначения видны в рабочей истории.',
    },
    {
      id: 'admin-history-initial-templates',
      time: '08:40',
      actor: 'Администратор',
      action: 'Шаблоны ролей загружены',
      target: 'Шаблоны ролей',
      detail: 'Шаблоны ролей применены к текущим доступам.',
    },
  ]);
  const [roleAssignmentDraft, setRoleAssignmentDraft] = useState<RoleAssignmentDraft>(
    defaultRoleAssignmentDraft,
  );
  const [directorView, setDirectorView] = useState<DirectorViewMode>('decisions');
  const [directorQuickFilter, setDirectorQuickFilter] = useState<DirectorQuickFilter>('all');
  const [penaltyScopeObjectId, setPenaltyScopeObjectId] = useState('');
  const [problemReportContext, setProblemReportContext] = useState<ProblemReportContext | null>(
    null,
  );
  const [operatorDefectDialog, setOperatorDefectDialog] = useState<{
    orderId: string;
    rollCode: string;
    spoolKg: number;
    plannedNetKg: number;
  } | null>(null);
  const [actionConfirmation, setActionConfirmation] =
    useState<ActionConfirmationDialogState | null>(null);
  const [warehouseOneCStockPushBusy, setWarehouseOneCStockPushBusy] = useState(false);
  const actionConfirmationBypassRef = useRef<Set<string>>(new Set());
  const actionConfirmationInputRef = useRef<Record<string, string>>({});
  const liveMutationGateRef = useRef(new LiveMutationGate());
  const operatorProblemGateRef = useRef(new IdempotentOperationGate());
  const operatorRollOperationGateRef = useRef(
    new IdempotentOperationGate(createOperationKey, true),
  );
  const physicalOperationGateRef = useRef(new IdempotentOperationGate(createOperationKey, true));
  const operatorBagReleaseGateRef = useRef(new IdempotentOperationGate());
  const warehouseRawAdjustmentReplayRef = useRef(new WarehouseRawAdjustmentReplayGuard());
  const operatorShiftCloseGateRef = useRef(
    new IdempotentOperationGate(createOperationKey, true),
  );
  const productionPlanningGateRef = useRef(new IdempotentOperationGate());
  const financeOperationGateRef = useRef(new IdempotentOperationGate());
  const financePaymentCorrectionReplayRef = useRef(new FinancePaymentCorrectionReplayGuard());

  function consumeActionConfirmation(
    key: string,
    dialog: Omit<ActionConfirmationDialogState, 'onConfirm'>,
    resume: () => void,
  ) {
    const value = actionConfirmationInputRef.current[key];
    if (value === undefined) {
      setActionConfirmation({
        ...dialog,
        onConfirm: (inputValue) => {
          actionConfirmationInputRef.current[key] = inputValue ?? '';
          setActionConfirmation(null);
          window.requestAnimationFrame(resume);
        },
      });
      return null;
    }
    delete actionConfirmationInputRef.current[key];
    const trimmedValue = value.trim();
    return trimmedValue || null;
  }

  useEffect(() => {
    const appShell = appShellRef.current;
    if (!isIntakeDrawerOpen) {
      appShell?.removeAttribute('inert');
      appShell?.removeAttribute('aria-hidden');
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      intakeDialogRef.current?.focus();
      appShell?.setAttribute('inert', '');
      appShell?.setAttribute('aria-hidden', 'true');
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      appShell?.removeAttribute('inert');
      appShell?.removeAttribute('aria-hidden');
    };
  }, [isIntakeDrawerOpen]);

  useEffect(() => {
    if (isIntakeDrawerOpen) return;
    window.requestAnimationFrame(() => {
      intakeOpenTriggerRef.current?.focus();
    });
  }, [isIntakeDrawerOpen]);

  useEffect(() => {
    const appShell = appShellRef.current;
    if (!problemReportContext) {
      appShell?.removeAttribute('inert');
      appShell?.removeAttribute('aria-hidden');
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.problem-report-dialog')?.focus();
      appShell?.setAttribute('inert', '');
      appShell?.setAttribute('aria-hidden', 'true');
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      appShell?.removeAttribute('inert');
      appShell?.removeAttribute('aria-hidden');
    };
  }, [problemReportContext]);

  useEffect(() => {
    if (problemReportContext) return;
    window.requestAnimationFrame(() => {
      problemOpenTriggerRef.current?.focus();
    });
  }, [problemReportContext]);

  useEffect(
    () => () => {
      if (operatorStageCooldownTimerRef.current !== null) {
        window.clearTimeout(operatorStageCooldownTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const appShell = appShellRef.current;
    if (!actionConfirmation) {
      appShell?.removeAttribute('inert');
      appShell?.removeAttribute('aria-hidden');
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      if (!actionConfirmation.initialFocus || actionConfirmation.initialFocus === 'dialog') {
        document.querySelector<HTMLElement>('.action-confirm-dialog')?.focus();
      }
      appShell?.setAttribute('inert', '');
      appShell?.setAttribute('aria-hidden', 'true');
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      appShell?.removeAttribute('inert');
      appShell?.removeAttribute('aria-hidden');
    };
  }, [actionConfirmation]);
  const [officeActionOutcomes, setOfficeActionOutcomes] = useState<
    Record<string, OfficeActionOutcome>
  >({});
  const [navigationActionOutcome, setNavigationActionOutcome] = useState<
    (OfficeActionOutcome & { role: Role; objectId?: string }) | null
  >(null);
  const config = getRoleConfig(activeRole);
  const activeSection = activeSectionByRole[activeRole] ?? config.nav[0];
  useEffect(
    () => () => {
      invalidateProductionIntakeCatalogRequests();
    },
    [activeRole, activeSection],
  );
  const isCommercialLive = isLiveContour('commercial');
  const isProductionLive = isLiveContour('production');
  const isOperatorLive = isLiveContour('operator');
  const isWarehouseLive = isLiveContour('warehouse');
  const isFinanceLive = isLiveContour('finance');
  const isAdminLive = isLiveContour('admin');
  const isDirectorLive = isLiveContour('director');
  const directorSupplemental = useDirectorSupplementalObjects({
    enabled: isDirectorLive && activeRole === 'director',
    refreshGeneration: businessRefreshGeneration,
    loaders: {
      finance: fetchDirectorFinanceObjects,
      production: fetchDirectorProductionObjects,
      warehouse: fetchDirectorWarehouseObjects,
    },
  });
  const warehouseDefectBagMode =
    activeRole === 'warehouse' ? warehouseDefectBagModeForSection(activeSection) : null;
  const warehouseDefectBagQueues = useWarehouseDefectBagQueues(
    activeRole === 'warehouse' && isWarehouseLive,
    warehouseDefectBagMode,
    warehouseLiveTick,
  );

  const activeLiveRefreshSignal =
    activeRole === 'operator'
      ? operatorLiveTick
      : activeRole === 'warehouse'
        ? warehouseLiveTick
        : activeRole === 'director'
          ? directorLiveTick
          : 0;
  const activeRoleHasLiveSnapshot = isLiveRoleSnapshotRole(activeRole) && isLiveContour(activeRole);
  const activeLiveRoleLoadState = activeRoleHasLiveSnapshot
    ? (liveRoleLoadStateByRole[activeRole] ?? 'loading')
    : 'ready';
  const activeLiveRoleUnavailable =
    AUTH_REQUIRED &&
    activeRoleHasLiveSnapshot &&
    (activeLiveRoleLoadState === 'loading' || activeLiveRoleLoadState === 'failed');

  function pendingInboxReads(role: RoleInboxRole) {
    const prefix = `${role}:`;
    return [...pendingInboxReadsRef.current.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, pending]) => pending);
  }

  function applyInboxFirstPage(role: RoleInboxRole, page: RoleInboxPage) {
    inboxRequestFrontiersRef.current[role].advanceFirstPage();
    const preserveCursor = (inboxRequestedCursorsRef.current[role]?.size ?? 0) > 0;
    setInboxStateByRole((current) => {
      const nextRoleState = mergeInboxFirstPage(current[role], page, {
        preserveCursor,
        pendingReads: pendingInboxReads(role),
      });
      const reconciled = reconcileEquivalentSnapshot(current[role], nextRoleState);
      return reconciled === current[role] ? current : { ...current, [role]: reconciled };
    });
  }

  function clearLiveInbox(role: RoleInboxRole) {
    inboxRequestFrontiersRef.current[role].invalidate();
    delete inboxRequestedCursorsRef.current[role];
    setInboxStateByRole((current) => ({ ...current, [role]: createInboxState() }));
  }

  function setSelectedProductionProblemId(problemId: string | null) {
    selectedProductionProblemIdRef.current = problemId;
    setSelectedProductionProblemIdState(problemId);
  }

  function reconcileSelectedProductionProblem(problems: readonly ServerProductionProblem[]) {
    const selectedProblemId = selectedProductionProblemIdRef.current;
    if (!selectedProblemId || problems.some((problem) => problem.id === selectedProblemId)) return;

    setSelectedProductionProblemId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('problem');
    url.searchParams.delete('roll');
    window.history.replaceState(window.history.state, '', url);
  }

  function clearFailedLiveRole(role: LiveRoleSnapshotRole) {
    clearLiveInbox(role);
    setLiveMeByRole((current) => {
      const next = { ...current };
      delete next[role];
      return next;
    });
    setSelectedByRole((current) => ({ ...current, [role]: null }));
    setWorkObjectsByRole((current) => ({ ...current, [role]: [] }));

    switch (role) {
      case 'commercial':
      case 'finance':
        break;
      case 'production':
        selectedProductionShiftIdRef.current = null;
        setProductionRuntime(emptyProductionRuntime());
        setProductionShifts([]);
        setProductionPosts([]);
        setProductionOperatorOptions([]);
        setProductionOperatorMachineView(null);
        resetLivePenaltySnapshot('production');
        setProductionProblems([]);
        setProductionCommercialActionsState('ready');
        setSelectedProductionProblemId(null);
        break;
      case 'operator':
        setOperatorRuntime(emptyOperatorRuntime());
        setLiveOperatorPenalties([]);
        setOperatorBigBags([]);
        setOperatorMachineChange(null);
        break;
      case 'warehouse':
        setWarehouseIntakeTasks([]);
        setWarehouseDeliveryTasks([]);
        setWarehouseCoverFreeRolls([]);
        break;
      case 'director':
        setDirectorControl(null);
        setDirectorDecisions([]);
        setDirectorProblems([]);
        resetLivePenaltySnapshot('director');
        setLiveDirectorPenaltyEmployees([]);
        break;
    }
  }

  useEffect(() => {
    const controller = liveRefreshControllerRef.current;
    if (!controller || !activeRoleHasLiveSnapshot || !isLiveRoleSnapshotRole(activeRole)) {
      controller?.stop();
      return;
    }
    const role = activeRole;

    controller.start({
      automatic: role !== 'director',
      load: async (signal) => {
        const penaltyRequestVersion =
          role === 'production' || role === 'director' ? getPenaltyRequestVersion(role) : undefined;
        const snapshot = await loadLiveRoleSnapshot(role, {
          productionShiftId:
            role === 'production' ? selectedProductionShiftIdRef.current : undefined,
          penaltyFilters:
            role === 'production' || role === 'director'
              ? getAppliedPenaltyFilters(role)
              : undefined,
          signal,
        });
        if (penaltyRequestVersion !== undefined) {
          penaltyPeriodicRequestVersionRef.current.set(snapshot, penaltyRequestVersion);
        }
        return snapshot;
      },
      apply: (snapshot) => {
        liveSnapshotLoadedRef.current[role] = true;
        delete liveRefreshErrorRef.current[role];
        setLiveRoleLoadStateByRole((current) =>
          current[role] === 'ready' ? current : { ...current, [role]: 'ready' },
        );
        setLiveMeByRole((current) => {
          const currentRole = current[role];
          const nextRole = currentRole
            ? reconcileEquivalentSnapshot(currentRole, snapshot.me)
            : snapshot.me;
          return nextRole === currentRole ? current : { ...current, [role]: nextRole };
        });
        applyInboxFirstPage(role, snapshot.inbox);

        switch (snapshot.role) {
          case 'commercial':
            setBusinessRefreshGeneration((generation) => generation + 1);
            break;
          case 'finance': {
            setBusinessRefreshGeneration((generation) => generation + 1);
            const initialized = liveSelectionInitializedRef.current.finance === true;
            liveSelectionInitializedRef.current.finance = true;
            setWorkObjectsByRole((current) => ({ ...current, finance: snapshot.orders }));
            setSelectedByRole((current) => ({
              ...current,
              finance: reconcileLiveSelection(
                current.finance,
                snapshot.orders.map((order) => order.id),
                initialized,
                false,
              ),
            }));
            break;
          }
          case 'production': {
            const initialized = liveSelectionInitializedRef.current.production === true;
            const ids = snapshot.orders.map((order) => order.id);
            setProductionShifts(snapshot.shifts);
            setProductionPosts(snapshot.posts);
            setProductionOperatorOptions(snapshot.operators);
            selectedProductionShiftIdRef.current = snapshot.operatorMachineView?.shift.id ?? null;
            setProductionOperatorMachineView(snapshot.operatorMachineView);
            applyPeriodicPenaltySnapshot(
              'production',
              snapshot.penaltyFilters,
              snapshot.penaltySnapshot,
              penaltyPeriodicRequestVersionRef.current.get(snapshot) ?? -1,
            );
            setProductionProblems(snapshot.problems);
            setProductionCommercialActionsState(snapshot.commercialActionsState ?? 'ready');
            reconcileSelectedProductionProblem(snapshot.problems);
            setWorkObjectsByRole((current) => ({ ...current, production: snapshot.orders }));
            setSelectedByRole((current) => ({
              ...current,
              production: reconcileLiveSelection(current.production, ids, initialized),
            }));
            liveSelectionInitializedRef.current.production = true;
            break;
          }
          case 'operator': {
            reconcileOperatorShiftCloseSnapshot(snapshot.runtime.shift);
            const initialized = liveSelectionInitializedRef.current.operator === true;
            liveSelectionInitializedRef.current.operator = true;
            const ids = snapshot.runtime.orders.flatMap((order) => [
              order.id,
              ...order.rolls.map((roll) => roll.id),
            ]);
            ids.push(...snapshot.penalties.map((penalty) => penaltyWorkListId(penalty.penaltyId)));
            setOperatorRuntime((current) =>
              reconcileOperatorRuntimeRefresh(current, snapshot.runtime),
            );
            setLiveOperatorPenalties(snapshot.penalties);
            setOperatorBigBags(snapshot.bags);
            setOperatorMachineChange(snapshot.machineChange);
            setSelectedByRole((current) => ({
              ...current,
              operator: reconcileLiveSelection(current.operator, ids, initialized, false),
            }));
            break;
          }
          case 'warehouse': {
            setBusinessRefreshGeneration((generation) => generation + 1);
            const initialized = liveSelectionInitializedRef.current.warehouse === true;
            const intakeObjects = snapshot.intake.tasks.map(intakeTaskToWorkObject);
            const deliveryObjects = snapshot.deliveryTasks.map(deliveryTaskToWorkObject);
            const coverObjects = snapshot.coverChecks;
            const inventoryObject = liveRawMaterialsToWorkObject(snapshot.stocks);
            const nextWarehouseObjects = [
              ...intakeObjects,
              ...deliveryObjects,
              ...coverObjects,
              inventoryObject,
            ];
            const liveIds = [...nextWarehouseObjects].map((object) => object.id);
            setWarehouseIntakeTasks((current) =>
              reconcileEquivalentSnapshot(current, snapshot.intake.tasks),
            );
            setWarehouseDeliveryTasks((current) =>
              reconcileEquivalentSnapshot(current, snapshot.deliveryTasks),
            );
            setWarehouseCoverFreeRolls((current) =>
              reconcileEquivalentSnapshot(current, snapshot.freeRolls),
            );
            setWorkObjectsByRole((current) => {
              const currentPresentation = current.warehouse.map((object) => ({
                ...object,
                audit: [],
              }));
              const nextPresentation = nextWarehouseObjects.map((object) => ({
                ...object,
                audit: [],
              }));
              const unchanged =
                reconcileEquivalentSnapshot(currentPresentation, nextPresentation) ===
                currentPresentation;
              return unchanged
                ? current
                : {
                    ...current,
                    warehouse: nextWarehouseObjects,
                  };
            });
            setSelectedByRole((current) => {
              const selectedId = current.warehouse;
              const availableIds =
                selectedId &&
                !selectedId.startsWith('WH-COVER-') &&
                !selectedId.startsWith('intake-') &&
                !selectedId.startsWith('delivery-')
                  ? [selectedId, ...liveIds]
                  : liveIds;
              const nextSelection = reconcileLiveSelection(selectedId, availableIds, initialized);
              return nextSelection === current.warehouse
                ? current
                : { ...current, warehouse: nextSelection };
            });
            liveSelectionInitializedRef.current.warehouse = true;
            break;
          }
          case 'director':
            setDirectorRefreshPending(false);
            setBusinessRefreshGeneration((generation) => generation + 1);
            setDirectorControl(snapshot.control);
            setDirectorDecisions(snapshot.decisions);
            setDirectorProblems(snapshot.problems);
            setWorkObjectsByRole((current) => ({
              ...current,
              director: snapshot.decisionObjects,
            }));
            applyPeriodicPenaltySnapshot(
              'director',
              snapshot.penaltyFilters,
              snapshot.penaltySnapshot,
              penaltyPeriodicRequestVersionRef.current.get(snapshot) ?? -1,
            );
            setLiveDirectorPenaltyEmployees([
              ...snapshot.penaltyTargets.map((target) => ({
                id: target.id,
                name: target.displayName,
                role: target.role === 'operator' ? 'Оператор' : 'Зав. производства',
              })),
            ]);
            break;
        }
      },
      onError: (error) => {
        if (role === 'director') setDirectorRefreshPending(false);
        const message = error instanceof Error ? error.message : 'Данные временно недоступны.';
        if (role === 'production') {
          setProductionCommercialActionsState((current) =>
            current === 'loading' ? 'error' : current,
          );
        }
        setLiveRoleLoadStateByRole((current) => ({
          ...current,
          [role]: liveRoleLoadStateAfterError(liveSnapshotLoadedRef.current[role] === true),
        }));
        if (liveSnapshotLoadedRef.current[role] !== true) clearFailedLiveRole(role);
        if (liveRefreshErrorRef.current[role] === message) return;
        liveRefreshErrorRef.current[role] = message;
        showMutationToast(
          role,
          undefined,
          `${role}-live-refresh`,
          'warning',
          LIVE_ROLE_LOAD_ERROR_TITLE[role],
          message,
        );
      },
    });

    return () => controller.stop();
  }, [
    activeLiveRefreshSignal,
    activeRole,
    activeRoleHasLiveSnapshot,
    applyPeriodicPenaltySnapshot,
    getAppliedPenaltyFilters,
    getPenaltyRequestVersion,
  ]);

  useEffect(() => {
    if (activeRole !== 'director') setDirectorRefreshPending(false);
  }, [activeRole]);

  function refreshDirectorTab() {
    if (!isDirectorLive || activeRole !== 'director' || directorRefreshPending) return;
    setDirectorRefreshPending(true);
    liveRefreshControllerRef.current?.invalidateAndRefresh();
  }

  useEffect(() => {
    const controller = adminInboxRefreshControllerRef.current;
    if (!controller || !isAdminLive || activeRole !== 'admin') {
      controller?.stop();
      return;
    }

    controller.start({
      load: (signal) => fetchRoleInbox('admin', { signal }),
      apply: (page) => {
        adminInboxRefreshErrorRef.current = null;
        applyInboxFirstPage('admin', page);
      },
      onError: (error) => {
        const message =
          error instanceof Error ? error.message : 'Повторите после восстановления связи.';
        if (adminInboxRefreshErrorRef.current === message) return;
        adminInboxRefreshErrorRef.current = message;
        showMutationToast(
          'admin',
          undefined,
          'admin-inbox-refresh',
          'warning',
          'Уведомления временно недоступны',
          message,
        );
      },
    });

    return () => controller.stop();
  }, [activeRole, isAdminLive]);

  useEffect(
    () => () => {
      inboxRequestFrontiersRef.current[activeRole].invalidate();
    },
    [activeRole],
  );

  // HID-сканер = клавиатурный ввод: копим быстрые символы, Enter = payload (scan-first).
  useEffect(() => {
    if (!isWarehouseLive || activeRole !== 'warehouse') return;
    let buffer = '';
    let lastAt = 0;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreHidCapture(event.target)) return;
      const now = Date.now();
      if (now - lastAt > HID_SCANNER_INTERKEY_TIMEOUT_MS) buffer = '';
      lastAt = now;
      if (event.key === 'Enter') {
        if (!consumeScannerTerminator(event, buffer.length)) return;
        const payload = buffer;
        buffer = '';
        void handleWarehouseScan(payload);
        return;
      }
      const character = scannerAsciiFromPhysicalKey(event);
      if (character !== null) buffer += character;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeRole,
    activeSection,
    isWarehouseLive,
    selectedByRole.warehouse,
    soundByRole.warehouse,
    warehouseDeliveryTasks,
  ]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ADMIN_ROLE_TEMPLATES_STORAGE_KEY,
        JSON.stringify(adminRoleTemplates),
      );
    } catch {
      // Prototype persistence is best-effort; the saved draft remains available until reload.
    }
  }, [adminRoleTemplates]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ADMIN_DEVICE_CATALOG_STORAGE_KEY,
        JSON.stringify(productionRuntime.devices),
      );
    } catch {
      // Prototype persistence is best-effort; runtime devices still work in memory.
    }
  }, [productionRuntime.devices]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const syncViewport = () => setIsMobileViewport(media.matches);
    syncViewport();
    media.addEventListener('change', syncViewport);
    return () => media.removeEventListener('change', syncViewport);
  }, []);
  useEffect(() => {
    const syncViewport = () =>
      setIsOperatorWorkstationViewport(
        isOperatorWorkstationWidth(window.innerWidth, window.outerWidth, window.devicePixelRatio),
      );
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);
  const isOperatorPenaltySection = activeRole === 'operator' && activeSection === 'Штрафы';
  const isOperatorHandoverHubSection =
    activeRole === 'operator' && activeSection === 'Переданы на склад';
  const isOperatorRollsHubSection =
    activeRole === 'operator' &&
    (normalizeOperatorSection(activeSection) === OPERATOR_ROLLS_SECTION ||
      isOperatorHandoverHubSection);
  const isProductionPenaltySection = activeRole === 'production' && activeSection === 'Штрафы';
  const isTemplateDirectory =
    activeRole === 'production' && activeSection === 'Контрагенты и шаблоны';
  const isLiveProductionTemplateDirectory =
    isProductionLive && isTemplateDirectory && templateDirectoryMode === 'counterparty';
  const isAdminPalletLayoutSection =
    activeRole === 'admin' && activeSection === 'Макет палетного листа';
  const isAdminAccessMode =
    activeRole === 'admin' &&
    (isAdminLive ||
      activeSection === 'Доступы' ||
      activeSection === 'Шаблоны ролей' ||
      isAdminPalletLayoutSection);
  const isOperatorShiftSection = activeRole === 'operator' && activeSection === 'Смена';
  const isOperatorPayrollSection = activeRole === 'operator' && activeSection === 'Зарплата';
  useLayoutEffect(() => {
    if (activeRole !== 'operator') return;
    const applicationScrollRoot = document
      .querySelector('ix-application')
      ?.shadowRoot?.querySelector<HTMLElement>('main.content');
    resetOperatorSectionScrollTargets([
      appShellRef.current,
      applicationScrollRoot,
      document.querySelector<HTMLElement>('.detail-panel'),
      window,
    ]);
  }, [activeRole, activeSection]);
  const isProductionOrdersHubSection =
    activeRole === 'production' && activeSection === 'Заказ-наряды';
  const isProductionRollQueueSection =
    activeRole === 'production' && activeSection === 'Все рулоны';
  const isProductionOperatorLoadSection =
    activeRole === 'production' && activeSection === 'Операторы / загрузка';
  const isProductionProblemsSection = activeRole === 'production' && activeSection === 'Проблемы';
  const isDirectorProblemsSection = activeRole === 'director' && activeSection === 'Проблемы';
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let debounce: ReturnType<typeof globalThis.setTimeout> | null = null;
    productionTemplatePaginationControllerRef.current?.abort();
    productionTemplatePaginationControllerRef.current = null;
    if (!isLiveProductionTemplateDirectory) {
      setProductionTemplateLoadState('idle');
      setProductionTemplateLoadError(null);
      setProductionTemplateNextCursor(null);
      setProductionTemplatePageLoading(false);
      if (isProductionLive) {
        setProductionTemplateCounterparties([]);
        setTemplateCatalog([]);
        setTemplateVersions([]);
        setTemplateDraftPositions({});
        setSelectedCounterpartyId('');
        setTemplateEditor(null);
      }
      return () => controller.abort();
    }

    const hasCatalog = productionTemplateCounterpartiesRef.current.length > 0;
    if (hasCatalog) {
      setProductionTemplatePageLoading(true);
    } else {
      setProductionTemplateLoadState('loading');
      setProductionTemplatePageLoading(true);
      setProductionTemplateCounterparties([]);
      setTemplateCatalog([]);
      setTemplateVersions([]);
      setTemplateDraftPositions({});
      setSelectedCounterpartyId('');
      setTemplateEditor(null);
    }
    setProductionTemplateLoadError(null);

    const load = async () => {
      try {
        const page = await searchCommercialCounterparties(
          { q: productionTemplateCounterpartyQuery, limit: 20 },
          { signal: controller.signal },
        );
        if (!active || controller.signal.aborted) return;
        const safeCounterparties = productionCounterpartiesFromServer(page.items);
        let payload: Awaited<ReturnType<typeof fetchCounterpartyTemplates>> = {
          templates: [],
          versions: [],
          draftPositions: {},
        };
        let templateWarning: string | null = null;
        try {
          payload = await fetchCounterpartyTemplates(
            safeCounterparties.map((counterparty) => counterparty.id),
            { signal: controller.signal },
          );
        } catch (error) {
          if (
            controller.signal.aborted ||
            (error instanceof Error && error.name === 'AbortError')
          ) {
            return;
          }
          templateWarning = 'Шаблоны клиентов временно недоступны. Повторите загрузку позже.';
        }
        if (!active || controller.signal.aborted) return;
        const templateIdsByCounterparty = new Map<string, string[]>();
        for (const template of payload.templates) {
          const ids = templateIdsByCounterparty.get(template.counterpartyId) ?? [];
          ids.push(template.id);
          templateIdsByCounterparty.set(template.counterpartyId, ids);
        }
        const catalog = safeCounterparties.map((counterparty) => ({
          ...counterparty,
          templateIds: templateIdsByCounterparty.get(counterparty.id) ?? [],
        }));
        setProductionTemplateCounterparties((current) =>
          mergeProductionCounterpartyPage(
            current,
            catalog,
            selectedCounterpartyIdRef.current,
            false,
          ),
        );
        setTemplateCatalog((current) => mergeCounterpartyTemplates(current, payload.templates));
        setTemplateVersions((current) =>
          mergeCounterpartyTemplateVersions(current, payload.versions),
        );
        setTemplateDraftPositions((current) => ({ ...current, ...payload.draftPositions }));
        setSelectedCounterpartyId((current) => current || catalog[0]?.id || '');
        setProductionTemplateNextCursor(page.nextCursor);
        setProductionTemplateLoadError(templateWarning);
        setProductionTemplateLoadState('ready');
        setProductionTemplatePageLoading(false);
      } catch (error) {
        if (
          !active ||
          controller.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          return;
        }
        setProductionTemplatePageLoading(false);
        if (productionTemplateCounterpartiesRef.current.length > 0) {
          setProductionTemplateLoadState('ready');
          setProductionTemplateLoadError('Поиск контрагентов временно недоступен.');
        } else {
          setProductionTemplateCounterparties([]);
          setTemplateCatalog([]);
          setTemplateVersions([]);
          setTemplateDraftPositions({});
          setSelectedCounterpartyId('');
          setProductionTemplateLoadState('error');
          setProductionTemplateLoadError('Не удалось загрузить контрагентов.');
        }
      }
    };

    if (productionTemplateCounterpartyQuery) {
      debounce = globalThis.setTimeout(load, PRODUCTION_TEMPLATE_SEARCH_DEBOUNCE_MS);
    } else {
      void load();
    }

    return () => {
      active = false;
      if (debounce !== null) globalThis.clearTimeout(debounce);
      controller.abort();
    };
  }, [
    isLiveProductionTemplateDirectory,
    isProductionLive,
    productionTemplateCounterpartyQuery,
    productionTemplateReloadGeneration,
  ]);

  async function loadMoreProductionTemplateCounterparties() {
    if (
      !productionTemplateNextCursor ||
      productionTemplatePageLoading ||
      productionTemplatePaginationControllerRef.current
    ) {
      return;
    }
    const controller = new AbortController();
    productionTemplatePaginationControllerRef.current = controller;
    setProductionTemplatePageLoading(true);
    setProductionTemplateLoadError(null);
    try {
      const page = await searchCommercialCounterparties(
        {
          q: productionTemplateCounterpartyQuery,
          cursor: productionTemplateNextCursor,
          limit: 20,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const safeCounterparties = productionCounterpartiesFromServer(page.items);
      let payload: Awaited<ReturnType<typeof fetchCounterpartyTemplates>> = {
        templates: [],
        versions: [],
        draftPositions: {},
      };
      let templateWarning: string | null = null;
      try {
        payload = await fetchCounterpartyTemplates(
          safeCounterparties.map((counterparty) => counterparty.id),
          { signal: controller.signal },
        );
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        templateWarning = 'Шаблоны клиентов временно недоступны. Повторите загрузку позже.';
      }
      if (controller.signal.aborted) return;
      const templateIdsByCounterparty = new Map<string, string[]>();
      for (const template of payload.templates) {
        const ids = templateIdsByCounterparty.get(template.counterpartyId) ?? [];
        ids.push(template.id);
        templateIdsByCounterparty.set(template.counterpartyId, ids);
      }
      const catalog = safeCounterparties.map((counterparty) => ({
        ...counterparty,
        templateIds: templateIdsByCounterparty.get(counterparty.id) ?? [],
      }));
      setProductionTemplateCounterparties((current) =>
        mergeProductionCounterpartyPage(
          current,
          catalog,
          selectedCounterpartyIdRef.current,
          true,
        ),
      );
      setTemplateCatalog((current) => mergeCounterpartyTemplates(current, payload.templates));
      setTemplateVersions((current) =>
        mergeCounterpartyTemplateVersions(current, payload.versions),
      );
      setTemplateDraftPositions((current) => ({ ...current, ...payload.draftPositions }));
      setProductionTemplateNextCursor(page.nextCursor);
      setProductionTemplateLoadError(templateWarning);
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) {
        setProductionTemplateLoadError('Следующая страница контрагентов временно недоступна.');
      }
    } finally {
      if (productionTemplatePaginationControllerRef.current === controller) {
        productionTemplatePaginationControllerRef.current = null;
        setProductionTemplatePageLoading(false);
      }
    }
  }
  const isProductionStandaloneSection =
    isProductionOrdersHubSection ||
    isProductionRollQueueSection ||
    isProductionOperatorLoadSection ||
    isProductionProblemsSection;
  const isRawMaterialModuleSection =
    (activeSection === 'Сырье' || activeSection === 'Сырьё') && activeRole !== 'operator';
  const isRawMaterialStandaloneSection = isRawMaterialModuleSection && activeRole !== 'warehouse';
  const isWarehouseInventoryPage = isWarehouseInventorySection(activeRole, activeSection);
  const commercialActiveSection = isCommercialLiveSection(activeSection)
    ? activeSection
    : 'Входящие заявки';
  const isWarehouseScanStationSection =
    activeRole === 'warehouse' && isWarehouseScanSection(activeSection);
  const isWarehouseDefectBagSection = warehouseDefectBagMode !== null;
  const sessionPreferences = {
    notificationSound: soundByRole[activeRole],
    reducedMotion: reducedMotionByRole[activeRole],
  };
  const storedAuthSession = loadSession();
  const liveSessionFallback: UserSession = {
    id: storedAuthSession?.userId ?? `${activeRole}-session`,
    name: storedAuthSession?.displayName ?? userSessions[activeRole].name,
    role: activeRole,
    workplace: null,
    shift: null,
    status: 'active',
    ...sessionPreferences,
  };
  const session: UserSession =
    activeRoleHasLiveSnapshot && isLiveRoleSnapshotRole(activeRole)
      ? liveMeByRole[activeRole]
        ? liveSessionFromMe(
            liveMeByRole[activeRole],
            activeRole,
            userSessions[activeRole].name,
            sessionPreferences,
          )
        : liveSessionFallback
      : { ...userSessions[activeRole], ...sessionPreferences };
  useEffect(() => {
    setOperatorClosingPayroll((current) =>
      current &&
      (current.userId !== session.id || current.payroll.shiftId !== operatorRuntime.shift.id)
        ? null
        : current,
    );
  }, [operatorRuntime.shift.id, session.id]);
  const canAdjustWarehouseRawMaterial =
    liveMeByRole.warehouse?.capabilities.includes('raw_material:adjust') ?? false;
  const effectiveCapabilities = isLiveRoleSnapshotRole(activeRole)
    ? liveMeByRole[activeRole]?.capabilities
    : undefined;
  const canCreatePenalty = activeRoleHasLiveSnapshot
    ? (effectiveCapabilities?.includes('penalty:create') ?? false)
    : true;
  // 1C is not part of the product runtime: keep the legacy read model unreachable and
  // never expose the warehouse export action, even to an account with stock permissions.
  const canPushWarehouseOneC = false;
  const roleNotifications = useMemo(
    () =>
      isLiveContour(activeRole)
        ? inboxStateByRole[activeRole].items.filter((notification) =>
            notificationMatchesSession(notification, session),
          )
        : notifications.filter((notification) => notificationMatchesSession(notification, session)),
    [activeRole, inboxStateByRole, notifications, session],
  );
  const roleUnreadCount = isLiveContour(activeRole)
    ? inboxStateByRole[activeRole].unreadCount
    : unreadCount(roleNotifications);
  const projectedWorkObjectsByRole = useMemo(() => {
    const projection = projectRuntimeToWorkObjects(productionRuntime, workObjectsByRole, {
      liveFinance: isFinanceLive,
    });
    if (!isDirectorLive || activeRole !== 'director') return projection;

    return {
      ...projection,
      finance: directorSupplemental.byScope.finance.objects,
      production: directorSupplemental.byScope.production.objects,
      warehouse: directorSupplemental.byScope.warehouse.objects,
    };
  }, [
    activeRole,
    directorSupplemental.byScope,
    isDirectorLive,
    isFinanceLive,
    productionRuntime,
    workObjectsByRole,
  ]);
  const warehouseCoverTasks = useMemo<WarehouseCoverTask[]>(
    () =>
      projectedWorkObjectsByRole.warehouse.flatMap((object) =>
        object.warehouseCoverTask ? [object.warehouseCoverTask] : [],
      ),
    [projectedWorkObjectsByRole.warehouse],
  );
  const productionOrderObjects = useMemo(
    () =>
      projectedWorkObjectsByRole.production.filter((object) => object.kind === 'productionOrder'),
    [projectedWorkObjectsByRole],
  );
  const productionAggregateRolls = useMemo(
    () => aggregateProductionRollDispatchItems(productionOrderObjects),
    [productionOrderObjects],
  );
  const productionPenaltyWorkCatalog = useMemo(
    () =>
      buildPenaltyWorkCatalog(
        productionOrderObjects
          .filter((object) => object.statusLabel === 'В производстве')
          .flatMap((object) => object.productionRollDispatchItems ?? []),
      ),
    [productionOrderObjects],
  );
  const liveProductionOperators = useMemo<ProductionOperator[]>(() => {
    if (!isProductionLive) return [];
    const assignments = currentAssignmentByOperator(productionShifts);

    return productionOperatorOptions.map((operator) => {
      const current = assignments.get(operator.operatorId);
      const shiftConflict = current?.state === 'conflict';
      const shift = current?.state === 'assigned' ? current.shift : undefined;
      const assignment = current?.state === 'assigned' ? current.assignment : undefined;
      const shiftCapacity = productionShiftCapacity(
        shift?.plannedStartAt ?? null,
        shift?.plannedEndAt ?? null,
      );
      const machineLabel = shiftConflict
        ? 'Пост не определён'
        : (assignment?.post?.name ?? 'Станок не назначен');
      return {
        id: operator.operatorId,
        name: operator.displayName,
        shortName: operator.displayName.split(/\s+/).at(-1) ?? operator.displayName,
        workplace: machineLabel,
        defaultMachineId: assignment?.post?.code ?? '',
        defaultMachineLabel: machineLabel,
        defaultMachineAssignedAt: assignment
          ? assignment.lockedAt
            ? 'смена начата'
            : 'до смены'
          : shiftConflict
            ? 'конфликт смен'
            : 'смена не создана',
        shiftId: shift?.id,
        ...shiftCapacity,
        shift: shiftConflict
          ? 'Конфликт смен — исправьте назначение'
          : (shift?.label ?? 'Смена ещё не создана'),
        activeTasks: operator.active,
        plannedTasks: operator.planned,
        capacity: Math.max(4, operator.total),
        skill: shiftConflict
          ? 'Конфликт смен — исправьте назначение'
          : assignment
            ? 'Станок назначен на смену'
            : 'Смена ещё не создана',
        status: shiftConflict ? 'blocked' : operator.active > 0 ? 'busy' : 'available',
      };
    });
  }, [isProductionLive, productionOperatorOptions, productionShifts]);
  const liveProductionMachineOptions = useMemo(
    () => [
      { value: '', label: 'Назначьте станок оператору' },
      ...productionPosts.map((post) => ({ value: post.code, label: post.name })),
    ],
    [productionPosts],
  );
  const rawMaterialSourceObject = useMemo(() => {
    const liveProjection = projectedWorkObjectsByRole.warehouse.find(
      (object) => object.id === 'warehouse-live-inventory',
    );
    if (isWarehouseLive) return liveProjection ?? null;
    return (
      projectedWorkObjectsByRole.warehouse.find(
        (object) => object.rawMaterialStocks !== undefined,
      ) ??
      projectedWorkObjectsByRole.warehouse.find((object) => object.id === 'WH-INV-RAW') ??
      null
    );
  }, [isWarehouseLive, projectedWorkObjectsByRole]);
  const warehouseInventoryDashboard = useMemo(
    () =>
      rawMaterialSourceObject
        ? buildWarehouseInventoryDashboard(rawMaterialSourceObject, warehouseCoverFreeRolls)
        : null,
    [rawMaterialSourceObject, warehouseCoverFreeRolls],
  );
  const warehouseSectionCounts = useMemo(
    () => ({
      ...(warehouseInventoryDashboard
        ? Object.fromEntries(
            warehouseInventoryDashboard.categories
              .filter((category) => category.id !== 'rolls' && category.id !== 'reserve')
              .map((category) => [
                warehouseSectionForCategory(category.id),
                category.rows.length,
              ]),
          )
        : {}),
      ...warehouseDefectBagQueues.counts,
    }),
    [warehouseDefectBagQueues.counts, warehouseInventoryDashboard],
  );
  const warehouseInventoryDisplayObject = useMemo(() => {
    if (!isWarehouseInventoryPage || !rawMaterialSourceObject || !warehouseInventoryDashboard) {
      return rawMaterialSourceObject;
    }
    const activeCategoryId = warehouseInventoryCategoryForSection(
      activeSection,
      new URLSearchParams(window.location.search),
    );
    const rows =
      warehouseInventoryDashboard.categories.find((category) => category.id === activeCategoryId)
        ?.rows ?? [];
    const sectionSeverity: WorkObject['severity'] = rows.some((row) => row.severity === 'critical')
      ? 'critical'
      : rows.some((row) => row.severity === 'warning')
        ? 'warning'
        : 'info';

    return {
      ...rawMaterialSourceObject,
      severity: sectionSeverity,
    };
  }, [
    activeSection,
    isWarehouseInventoryPage,
    rawMaterialSourceObject,
    warehouseInventoryDashboard,
  ]);
  const directorDashboard = useMemo(() => {
    if (isDirectorLive && directorControl) {
      return buildLiveDirectorControl(
        directorControl,
        projectedWorkObjectsByRole.finance.filter((object) => object.kind === 'financeOrder'),
      );
    }
    return buildDirectorDashboardProjection(productionRuntime);
  }, [productionRuntime, isDirectorLive, directorControl, projectedWorkObjectsByRole.finance]);
  const directorPenaltySnapshot = useMemo(
    () =>
      isDirectorLive
        ? livePenaltySnapshots.director.snapshot
        : legacyPenaltySnapshot(productionRuntime.penalties),
    [isDirectorLive, livePenaltySnapshots.director.snapshot, productionRuntime.penalties],
  );
  const operatorPenalties = useMemo(() => {
    if (isOperatorLive) return liveOperatorPenalties;
    return productionRuntime.penalties.filter(
      (penalty) =>
        penalty.targetRole === 'operator' &&
        (penalty.employeeId === 'operator-line-a' ||
          penalty.employeeName === userSessions.operator.name),
    );
  }, [isOperatorLive, liveOperatorPenalties, productionRuntime.penalties]);
  const productionLeadPenaltyItems = useMemo(
    () =>
      isProductionLive
        ? livePenaltySnapshots.production.snapshot.items
        : penaltiesVisibleToProduction(productionRuntime.penalties, {
            userId: userSessions.production.id,
            displayName: userSessions.production.name,
          }),
    [isProductionLive, livePenaltySnapshots.production.snapshot.items, productionRuntime.penalties],
  );
  const productionPenaltySnapshot = useMemo(
    () =>
      isProductionLive
        ? livePenaltySnapshots.production.snapshot
        : legacyPenaltySnapshot(productionLeadPenaltyItems),
    [isProductionLive, livePenaltySnapshots.production.snapshot, productionLeadPenaltyItems],
  );
  const penaltySectionCounts = useMemo(
    () => ({
      Штрафы:
        activeRole === 'director'
          ? directorPenaltySnapshot.summary.totalCount
          : productionPenaltySnapshot.summary.totalCount,
    }),
    [
      activeRole,
      directorPenaltySnapshot.summary.totalCount,
      productionPenaltySnapshot.summary.totalCount,
    ],
  );
  const roleNavigationSectionCounts = useMemo(
    () =>
      activeRole === 'director' && isDirectorLive
        ? {
            ...penaltySectionCounts,
            Финансы: 0,
            Деньги: 0,
            Производство: 0,
            Склад: 0,
            'Аудит / QR': 0,
          }
        : penaltySectionCounts,
    [activeRole, isDirectorLive, penaltySectionCounts],
  );
  const listItems = useMemo(
    () =>
      isOperatorPenaltySection
        ? penaltyListItems(operatorPenalties, filter)
        : isProductionPenaltySection
          ? penaltyListItems(productionPenaltySnapshot.items, filter)
          : activeRole === 'operator'
            ? operatorListItems(operatorRuntime, filter, activeSection)
            : getListItems(activeRole, filter, activeSection, projectedWorkObjectsByRole),
    [
      activeRole,
      filter,
      activeSection,
      isOperatorPenaltySection,
      isProductionPenaltySection,
      operatorRuntime,
      operatorPenalties,
      productionPenaltySnapshot.items,
      projectedWorkObjectsByRole,
    ],
  );
  const queueDateScope = queueDateScopeByRole[activeRole] ?? 'all';
  const dateScopedListItems = useMemo(
    () => applyDateScope(listItems, queueDateScope),
    [listItems, queueDateScope],
  );
  const queueFilterOptions = useMemo(() => {
    const filters = queueFiltersForRole(activeRole);
    const itemsForFilter = (item: string) =>
      isOperatorPenaltySection
        ? penaltyListItems(operatorPenalties, item)
        : isProductionPenaltySection
          ? penaltyListItems(productionPenaltySnapshot.items, item)
          : activeRole === 'operator'
            ? operatorListItems(operatorRuntime, item, activeSection)
            : getListItems(activeRole, item, activeSection, projectedWorkObjectsByRole);

    return filters
      .map((item) => {
        const rawItems = itemsForFilter(item);
        return {
          id: item,
          label: filterChipLabel(item),
          help: filterHelp(item),
          count: applyDateScope(rawItems, queueDateScope).length,
          rawCount: rawItems.length,
        };
      })
      .filter((item) => item.id === 'Все' || item.id === filter || item.rawCount > 0);
  }, [
    activeRole,
    activeSection,
    filter,
    queueDateScope,
    isOperatorPenaltySection,
    isProductionPenaltySection,
    operatorRuntime,
    operatorPenalties,
    productionPenaltySnapshot.items,
    projectedWorkObjectsByRole,
  ]);
  const visibleListItems = useMemo(
    () =>
      dateScopedListItems.map((item) =>
        seenNewObjectIds.has(item.id) ? { ...item, newness: undefined } : item,
      ),
    [dateScopedListItems, seenNewObjectIds],
  );
  const defaultSelectionId = useMemo(() => {
    if (
      isOperatorPenaltySection ||
      isProductionPenaltySection ||
      isTemplateDirectory ||
      isOperatorShiftSection ||
      isOperatorPayrollSection ||
      isWarehouseDefectBagSection ||
      isAdminAccessMode
    )
      return null;
    if (activeRole === 'commercial' || activeRole === 'operator') return null;
    const contractSelection = getDefaultSelection(
      activeRole,
      projectedWorkObjectsByRole,
      activeSection,
      filter,
    );
    if (contractSelection && visibleListItems.some((item) => item.id === contractSelection))
      return contractSelection;
    return visibleListItems[0]?.id ?? null;
  }, [
    activeRole,
    activeSection,
    filter,
    isAdminAccessMode,
    isMobileViewport,
    isOperatorPenaltySection,
    isOperatorPayrollSection,
    isOperatorShiftSection,
    isWarehouseDefectBagSection,
    isProductionPenaltySection,
    isProductionStandaloneSection,
    isTemplateDirectory,
    projectedWorkObjectsByRole,
    visibleListItems,
  ]);
  const singleObjectDirectDetailId: string | null = null;
  const isSingleObjectDirectDetail = Boolean(singleObjectDirectDetailId);
  const financeSectionLandingObjectId =
    activeRole === 'finance' ? (visibleListItems[0]?.id ?? null) : null;
  const suppressFinanceRegistrySelection =
    activeRole === 'finance' && !selectedByRole.finance;
  const isArchiveQueueMode = filter === 'Архив' || filter === 'Завершены';
  const selectedRoleId = selectedByRole[activeRole];
  const hasExplicitNullSelection =
    (activeRoleHasLiveSnapshot || activeRole === 'operator') &&
    isLiveRoleSnapshotRole(activeRole) &&
    selectedRoleId === null &&
    liveSelectionInitializedRef.current[activeRole] === true;
  useEffect(() => {
    if (!hasExplicitNullSelection || (activeRole !== 'finance' && activeRole !== 'operator')) return;
    const url = replaceObjectSelectionInUrl(window.location.href, null);
    if (url.toString() !== window.location.href) {
      window.history.replaceState(window.history.state, '', url);
    }
  }, [activeRole, hasExplicitNullSelection]);
  const selectedRoleIdInVisibleList =
    selectedRoleId && visibleListItems.some((item) => item.id === selectedRoleId)
      ? selectedRoleId
      : undefined;
  const selectedFinanceObjectId =
    activeRole === 'finance' &&
    selectedRoleId &&
    projectedWorkObjectsByRole.finance.some((object) => object.id === selectedRoleId)
      ? selectedRoleId
      : undefined;
  const selectedOperatorRuntimeId =
    activeRole === 'operator' &&
    !isOperatorPenaltySection &&
    selectedRoleId &&
    operatorRuntime.orders.some(
      (order) =>
        order.id === selectedRoleId || order.rolls.some((roll) => roll.id === selectedRoleId),
    )
      ? selectedRoleId
      : undefined;
  const selectedWarehouseScanStationId = isWarehouseScanStationSection
    ? warehouseScanSelectionId(projectedWorkObjectsByRole.warehouse, selectedRoleId, activeSection)
    : null;
  const selectedId = hasExplicitNullSelection
    ? null
    : suppressFinanceRegistrySelection
      ? selectedRoleId
      : selectedFinanceObjectId
        ? selectedFinanceObjectId
        : activeRole === 'director'
          ? (selectedRoleId ?? defaultSelectionId)
          : activeRole === 'operator' && selectedOperatorRuntimeId
            ? selectedOperatorRuntimeId
            : isWarehouseScanStationSection
              ? selectedWarehouseScanStationId
              : (selectedRoleIdInVisibleList ?? defaultSelectionId);
  const selectedObjectBase =
    isOperatorPenaltySection || isProductionPenaltySection
      ? null
      : activeRole === 'operator'
        ? getOperatorSelectedObject(operatorRuntime, selectedId)
        : getSelectedObject(activeRole, selectedId, projectedWorkObjectsByRole);
  const selectedObject = useMemo(() => {
    if (
      !selectedObjectBase ||
      !seenNewObjectIds.has(selectedObjectBase.id) ||
      !selectedObjectBase.newness
    )
      return selectedObjectBase;
    const seenAudit: AuditEntry = {
      id: `a-seen-${selectedObjectBase.id}`,
      objectId: selectedObjectBase.id,
      time: selectedObjectBase.newness.firstSeenAt ?? 'сейчас',
      actorLabel: config.label,
      actionLabel: 'Заявка просмотрена',
      detail: 'Маркер Новая снят для текущей роли.',
    };
    return {
      ...selectedObjectBase,
      newness: { ...selectedObjectBase.newness, firstSeenAt: seenAudit.time },
      audit: [seenAudit, ...selectedObjectBase.audit.filter((entry) => entry.id !== seenAudit.id)],
    };
  }, [config.label, seenNewObjectIds, selectedObjectBase]);
  const financeFallbackSelectedObject =
    activeRole === 'finance' && !selectedObject && financeSectionLandingObjectId
      ? getSelectedObject('finance', financeSectionLandingObjectId, projectedWorkObjectsByRole)
      : null;
  const detailObject =
    isRawMaterialModuleSection || isWarehouseInventoryPage
      ? warehouseInventoryDisplayObject
      : (selectedObject ?? financeFallbackSelectedObject);
  const warehouseMaterialRecipeCatalogEnabled =
    activeRole === 'warehouse' &&
    isWarehouseLive &&
    isWarehouseInventoryPage &&
    detailObject?.id === 'warehouse-live-inventory' &&
    (warehouseInventoryCategoryForSection(
      activeSection,
      new URLSearchParams(window.location.search),
    ) === 'raw' ||
      isWarehouseStockSection(activeSection, new URLSearchParams(window.location.search)));
  const materialRecipeCatalog = useMaterialRecipeCatalog(
    isIntakeDrawerOpen ||
      warehouseMaterialRecipeCatalogEnabled ||
      (isProductionLive && isTemplateDirectory),
  );
  useEffect(() => {
    if (
      !selectedId ||
      activeLiveRoleUnavailable ||
      activeRole === 'director' ||
      selectedObjectBase ||
      isOperatorPenaltySection ||
      isProductionPenaltySection
    )
      return;
    setSelectedByRole((current) =>
      current[activeRole] === selectedId ? { ...current, [activeRole]: null } : current,
    );
  }, [
    activeLiveRoleUnavailable,
    activeRole,
    isOperatorPenaltySection,
    isProductionPenaltySection,
    selectedId,
    selectedObjectBase,
  ]);
  useEffect(() => {
    if (
      !selectedId ||
      activeLiveRoleUnavailable ||
      activeRole === 'director' ||
      isOperatorPenaltySection ||
      isProductionPenaltySection
    )
      return;
    if (activeRole === 'finance' && selectedObjectBase) return;
    if (activeRole === 'operator' && selectedObjectBase) return;
    if (selectedWarehouseScanStationId) return;
    if (visibleListItems.some((item) => item.id === selectedId)) return;
    setSelectedByRole((current) =>
      current[activeRole] === selectedId ? { ...current, [activeRole]: null } : current,
    );
  }, [
    activeLiveRoleUnavailable,
    activeRole,
    isOperatorPenaltySection,
    isProductionPenaltySection,
    selectedId,
    selectedObjectBase,
    selectedWarehouseScanStationId,
    visibleListItems,
  ]);
  useEffect(() => {
    if (activeRole !== 'commercial' || !selectedId || window.innerWidth <= 900) return;
    window.requestAnimationFrame(() => {
      const selectedRow = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.app-shell[data-active-role="commercial"] .queue-row[data-object-id]',
        ),
      ).find((row) => row.dataset.objectId === selectedId);
      selectedRow?.scrollIntoView({ block: 'nearest' });
    });
  }, [activeRole, selectedId, activeSection]);
  useEffect(() => {
    if (
      selectedId ||
      visibleListItems.length === 0 ||
      isTemplateDirectory ||
      isOperatorShiftSection ||
      isOperatorPayrollSection ||
      isAdminAccessMode ||
      isOperatorPenaltySection ||
      isProductionPenaltySection ||
      hasExplicitNullSelection ||
      activeRole === 'commercial' ||
      activeRole === 'operator' ||
      isWarehouseDefectBagSection ||
      isWarehouseScanStationSection ||
      suppressFinanceRegistrySelection
    )
      return;
    const nextId = visibleListItems[0]?.id;
    if (!nextId) return;
    setSelectedByRole((current) =>
      current[activeRole] ? current : { ...current, [activeRole]: nextId },
    );
  }, [
    activeRole,
    hasExplicitNullSelection,
    isAdminAccessMode,
    isMobileViewport,
    isOperatorPenaltySection,
    isOperatorPayrollSection,
    isOperatorShiftSection,
    isProductionPenaltySection,
    isTemplateDirectory,
    isWarehouseDefectBagSection,
    isWarehouseScanStationSection,
    selectedId,
    suppressFinanceRegistrySelection,
    visibleListItems,
  ]);
  const selectedOfficeOutcome =
    detailObject && (activeRole === 'production' || activeRole === 'finance')
      ? (officeActionOutcomes[`${activeRole}:${detailObject.id}`] ?? null)
      : null;
  const isFinanceRegistryPage =
    activeRole === 'finance' && !selectedId && Boolean(detailObject);
  const selectedNavigationOutcome =
    activeRole !== 'commercial' &&
    navigationActionOutcome &&
    navigationActionOutcome.role === activeRole &&
    (!navigationActionOutcome.objectId || navigationActionOutcome.objectId === selectedId)
      ? navigationActionOutcome
      : null;
  const isRoleLockedBySession = AUTH_REQUIRED;
  const requestedHref = window.location.href;
  const requestedSearchParams = new URLSearchParams(window.location.search);
  const requestedSection = requestedSearchParams.get('section');
  const normalizedRequestedSection = requestedSection
    ? normalizeSectionForRole(activeRole, requestedSection, requestedSearchParams)
    : requestedSection;
  useEffect(() => {
    if (!requestedSection) return;
    if (
      activeRole === 'warehouse' &&
      normalizedRequestedSection &&
      config.nav.includes(normalizedRequestedSection)
    ) {
      const url = normalizeWarehouseSectionUrl(requestedHref, requestedSection);
      url.searchParams.set('role', activeRole);
      if (url.toString() !== window.location.href) {
        window.history.replaceState(null, '', url);
        return;
      }
    } else if (normalizedRequestedSection && normalizedRequestedSection !== requestedSection) {
      const url = new URL(window.location.href);
      url.searchParams.set('role', activeRole);
      url.searchParams.set('section', normalizedRequestedSection);
      window.history.replaceState(null, '', url);
      return;
    }
    if (normalizedRequestedSection && config.nav.includes(normalizedRequestedSection)) return;
    const url = new URL(window.location.href);
    url.searchParams.set('role', activeRole);
    url.searchParams.set('section', activeSection);
    url.searchParams.delete('object');
    url.searchParams.delete('problem');
    url.searchParams.delete('roll');
    url.searchParams.delete('incident');
    window.history.replaceState(null, '', url);
  }, [
    activeRole,
    activeSection,
    config.nav,
    normalizedRequestedSection,
    requestedHref,
    requestedSection,
  ]);
  const canCreateRequestFromRole = activeRole === 'commercial';
  const displaySection = activeSection;
  const visibleCount = isTemplateDirectory
    ? isProductionLive
      ? productionTemplateCounterparties.length
      : counterparties.length
    : warehouseDefectBagMode
      ? warehouseDefectBagQueues.bags.length
      : isWarehouseScanStationSection
        ? visibleListItems.length
        : isProductionOrdersHubSection
          ? productionOrderObjects.length
          : isProductionRollQueueSection
            ? productionAggregateRolls.length
            : isProductionOperatorLoadSection
            ? assignedProductionOperatorCount(productionAggregateRolls)
            : isOperatorShiftSection
              ? 1
              : isOperatorPayrollSection
                ? 1
                : isRawMaterialModuleSection
                  ? 3
                  : isWarehouseInventoryPage
                    ? warehouseInventorySectionCount(
                        activeSection,
                        rawMaterialSourceObject ?? undefined,
                      )
                    : visibleListItems.length;
  useEffect(() => {
    setupActionToastPosition();
  }, []);

  function showMutationToast(
    role: Role,
    objectId: string | undefined,
    actionId: string,
    tone: ActionToastTone,
    title: string,
    detail?: string,
  ) {
    showActionToast({ role, objectId, actionId, tone, title: actionToastTitle(title), detail });
  }

  function setMutatingOfficeActionOutcome(
    role: Extract<Role, 'production' | 'finance'>,
    objectId: string,
    actionId: string,
    outcome: OfficeActionOutcome,
  ) {
    setOfficeActionOutcome(role, objectId, outcome);
    showMutationToast(role, objectId, actionId, outcome.tone, outcome.title, outcome.detail);
    if (outcome.tone === 'success') requestLiveRoleRefresh(role);
  }

  function setMutatingNavigationActionOutcome(
    outcome: OfficeActionOutcome & { role: Role; objectId?: string },
    actionId: string,
  ) {
    setNavigationActionOutcome(outcome);
    showMutationToast(
      outcome.role,
      outcome.objectId,
      actionId,
      outcome.tone,
      outcome.title,
      outcome.detail,
    );
    if (outcome.tone === 'success') requestLiveRoleRefresh(outcome.role);
  }

  function requestLiveRoleRefresh(role: Role) {
    if (role === activeRole && isLiveRoleSnapshotRole(role) && isLiveContour(role)) {
      liveRefreshControllerRef.current?.invalidateAndRefresh();
    }
  }

  function markLiveSelectionInitialized(role: Role) {
    if (isLiveRoleSnapshotRole(role)) {
      liveSelectionInitializedRef.current[role] = true;
    }
  }

  function changeRole(role: Role) {
    if (isRoleLockedBySession) return;
    const nextSection = defaultSectionForRole(role);
    setActiveRole(role);
    setFilter('Все');
    setQueueDateScopeByRole((current) => ({ ...current, [role]: 'all' }));
    setOpenPanel('none');
    setSelectedProductionProblemId(null);
    if (role === 'commercial' || role === 'director') {
      setSelectedBusinessProblemIdByRole((current) => ({ ...current, [role]: null }));
    }
    setSelectedAdminIncidentId(null);
    setActiveSectionByRole((current) => ({ ...current, [role]: nextSection }));
    const existingSelection = selectedByRole[role];
    const nextSelection =
      role === 'commercial' || role === 'warehouse' || role === 'operator' || role === 'finance'
        ? null
        : (existingSelection ?? getDefaultSelection(role, projectedWorkObjectsByRole, nextSection));
    setSelectedByRole((current) => ({ ...current, [role]: nextSelection }));
    if (role === 'director') {
      setDirectorView('decisions');
      setDirectorQuickFilter('all');
    }
    const url = new URL(window.location.href);
    url.searchParams.set('role', role);
    url.searchParams.delete('object');
    url.searchParams.delete('problem');
    url.searchParams.delete('roll');
    url.searchParams.delete('incident');
    url.searchParams.set('section', nextSection);
    window.history.replaceState(null, '', url);
  }

  function changeSection(section: string) {
    markLiveSelectionInitialized(activeRole);
    const nextSection = normalizeSectionForRole(
      activeRole,
      section,
      new URLSearchParams(window.location.search),
    );
    setActiveSectionByRole((current) => ({ ...current, [activeRole]: nextSection }));
    setFilter('Все');
    setQueueDateScopeByRole((current) => ({ ...current, [activeRole]: 'all' }));
    if (activeRole === 'production') setSelectedProductionProblemId(null);
    if (activeRole === 'commercial' || activeRole === 'director') {
      setSelectedBusinessProblemIdByRole((current) => ({
        ...current,
        [activeRole]: nextSection === 'Проблемы' ? current[activeRole] : null,
      }));
    }
    if (activeRole === 'admin') setSelectedAdminIncidentId(null);
    const shouldSelectWarehouseInventory = isWarehouseInventorySection(activeRole, nextSection);
    const shouldClearWarehouseSelection =
      activeRole === 'warehouse' &&
      (isWarehouseScanSection(nextSection) ||
        nextSection === 'Прием брака' ||
        nextSection === 'Отгрузка брака');
    if (activeRole === 'finance') {
      setSelectedByRole((current) => ({ ...current, finance: null }));
    }
    if (activeRole === 'director') {
      setDirectorView(
        nextSection === 'Контроль' || nextSection === 'Дашборд' || nextSection === 'Требуют решения'
          ? 'decisions'
          : 'orders',
      );
      setDirectorQuickFilter('all');
      setSelectedByRole((current) => ({ ...current, director: null }));
    }
    if (activeRole === 'admin' || activeRole === 'commercial' || activeRole === 'production') {
      setSelectedByRole((current) => ({ ...current, [activeRole]: null }));
    }
    if (activeRole === 'operator') {
      setSelectedByRole((current) => ({ ...current, operator: null }));
    }
    if (shouldSelectWarehouseInventory) {
      setSelectedByRole((current) => ({
        ...current,
        warehouse: rawMaterialSourceObject?.id ?? null,
      }));
    } else if (shouldClearWarehouseSelection) {
      setSelectedByRole((current) => ({ ...current, warehouse: null }));
    }
    let url = new URL(window.location.href);
    url.searchParams.set('role', activeRole);
    url.searchParams.set('section', nextSection);
    if (shouldSelectWarehouseInventory) {
      if (rawMaterialSourceObject) url.searchParams.set('object', rawMaterialSourceObject.id);
      else url.searchParams.delete('object');
    } else {
      url.searchParams.delete('object');
    }
    url.searchParams.delete('problem');
    url.searchParams.delete('roll');
    url.searchParams.delete('incident');
    if (activeRole === 'warehouse') {
      url = normalizeWarehouseSectionUrl(url, section);
    }
    window.history.replaceState(null, '', url);
  }

  function keepCommercialObjectVisible(objectId: string, section: string) {
    markLiveSelectionInitialized('commercial');
    setActiveSectionByRole((current) => ({ ...current, commercial: section }));
    setSelectedByRole((current) => ({ ...current, commercial: objectId }));
    setFilter('Все');
    setQueueDateScopeByRole((current) => ({ ...current, commercial: 'all' }));
    const url = new URL(window.location.href);
    url.searchParams.set('role', 'commercial');
    url.searchParams.set('section', section);
    url.searchParams.set('object', objectId);
    window.history.replaceState(null, '', url);
  }

  function reconcileCommercialSelection(objectId: string | null) {
    markLiveSelectionInitialized('commercial');
    setSelectedByRole((current) => ({ ...current, commercial: objectId }));
    const url = replaceObjectSelectionInUrl(window.location.href, objectId);
    window.history.replaceState(null, '', url);
  }

  function changeQueueFilter(nextFilter: string) {
    setFilter(nextFilter);
    setQueueDateScopeByRole((current) => ({ ...current, [activeRole]: 'all' }));
  }

  function applyDirectorDashboardDrilldown(drilldown: DirectorDashboardDrilldown) {
    const section = drilldown.section === 'Дашборд' ? 'Контроль' : drilldown.section;
    setActiveSectionByRole((current) => ({ ...current, director: section }));
    setDirectorView(drilldown.view);
    setDirectorQuickFilter(drilldown.filter);
    if (drilldown.targetObjectId) {
      setSelectedByRole((current) => ({
        ...current,
        director: drilldown.targetObjectId ?? current.director,
      }));
    }
  }

  function selectObject(id: string, scrollToDetail = true) {
    markLiveSelectionInitialized(activeRole);
    const item = listItems.find((row) => row.id === id);
    if (item?.newness?.recipientRole === activeRole) {
      setSeenNewObjectIds((current) => new Set([...current, id]));
    }
    setNotifications((current) =>
      current.map((notification) =>
        notificationMatchesSession(notification, session) &&
        notification.objectId === id &&
        !notification.requiresAck &&
        !notification.readAt
          ? { ...notification, readAt: 'сейчас' }
          : notification,
      ),
    );
    setSelectedByRole((current) => ({ ...current, [activeRole]: id }));
    setNavigationActionOutcome(null);
    const url = new URL(window.location.href);
    url.searchParams.set('role', activeRole);
    url.searchParams.set('section', activeSection);
    url.searchParams.set('object', id);
    window.history.replaceState(null, '', url);
    if (
      scrollToDetail &&
      activeRole === 'operator' &&
      isOperatorWorkstationWidth(window.innerWidth, window.outerWidth, window.devicePixelRatio)
    ) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const applicationScrollRoot = document
            .querySelector('ix-application')
            ?.shadowRoot?.querySelector<HTMLElement>('main.content');
          resetOperatorScrollTargets(window.innerWidth, [
            appShellRef.current,
            document.querySelector<HTMLElement>('.detail-panel'),
            applicationScrollRoot,
            window,
          ]);
          document
            .querySelector<HTMLElement>('.operator-rolls-hub-page > .detail-view')
            ?.scrollIntoView({ block: 'start' });
        });
      });
    }
    if (activeRole !== 'operator' && window.innerWidth <= 900) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const mobileTarget =
            activeRole === 'finance'
              ? (document.querySelector('.finance-primary-action-panel') ??
                document.querySelector('.detail-panel'))
              : activeRole === 'commercial'
                ? (document.querySelector('.commercial-primary-action') ??
                  document.querySelector('.detail-panel'))
                : document.querySelector('.detail-panel');
          const scrollFinanceWorkbench = () => {
            const applicationScrollRoot = document
              .querySelector('ix-application')
              ?.shadowRoot?.querySelector<HTMLElement>('main.content');
            resetOperatorScrollTargets(window.innerWidth, [
              appShellRef.current,
              document.querySelector<HTMLElement>('.detail-panel'),
              applicationScrollRoot,
              window,
            ]);
            (
              document.querySelector<HTMLElement>('.finance-primary-action-panel') ??
              document.querySelector<HTMLElement>('.detail-panel')
            )?.scrollIntoView({ block: 'start' });
          };
          if (activeRole === 'finance') {
            scrollFinanceWorkbench();
          } else {
            mobileTarget?.scrollIntoView({ block: 'start' });
          }
        });
      });
    }
  }

  function clearActiveSelection() {
    markLiveSelectionInitialized(activeRole);
    setSelectedByRole((current) => ({ ...current, [activeRole]: null }));
    setNavigationActionOutcome(null);
    const url = replaceObjectSelectionInUrl(window.location.href, null);
    window.history.replaceState(null, '', url);
  }

  function handleLogout() {
    void logout().finally(() => {
      const url = new URL(window.location.href);
      url.search = '';
      window.location.assign(url.toString());
    });
  }

  async function loadMoreRoleInbox(role: RoleInboxRole) {
    const current = inboxStateByRole[role];
    const requestedCursor = current.nextCursor;
    if (!isLiveContour(role) || !requestedCursor || current.loadingMore) return;

    const requestedCursors = inboxRequestedCursorsRef.current[role] ?? new Set<string>();
    if (requestedCursors.has(requestedCursor)) {
      setInboxStateByRole((state) => ({
        ...state,
        [role]: { ...state[role], nextCursor: null, loadingMore: false },
      }));
      return;
    }

    const frontier = inboxRequestFrontiersRef.current[role];
    const request = frontier.beginLoadMore();
    setInboxStateByRole((state) => ({
      ...state,
      [role]: { ...state[role], loadingMore: true },
    }));

    try {
      const page = await fetchRoleInbox(role, {
        cursor: requestedCursor,
        signal: request.signal,
      });
      if (!frontier.isCurrent(request)) return;
      const nextRequestedCursors = new Set(requestedCursors);
      nextRequestedCursors.add(requestedCursor);
      inboxRequestedCursorsRef.current[role] = nextRequestedCursors;
      setInboxStateByRole((state) =>
        frontier.isCurrent(request)
          ? {
              ...state,
              [role]: appendInboxPage(state[role], page, {
                requestedCursor,
                requestedCursors: nextRequestedCursors,
                pendingReads: pendingInboxReads(role),
              }),
            }
          : state,
      );
    } catch (error) {
      if (frontier.isCurrent(request)) {
        showMutationToast(
          role,
          undefined,
          `${role}-notification-load-more`,
          'warning',
          'История уведомлений не загружена',
          error instanceof Error ? error.message : 'Повторите после восстановления связи.',
        );
      }
    } finally {
      if (frontier.finishLoadMore(request)) {
        setInboxStateByRole((state) => ({
          ...state,
          [role]: { ...state[role], loadingMore: false },
        }));
      }
    }
  }

  function markNotificationRead(id: string) {
    const target = roleNotifications.find((notification) => notification.id === id);
    if (!target) return;
    const previousReadAt = target?.readAt;
    const targetRole = target?.recipientRole;
    if (targetRole && isRoleInboxRole(targetRole) && isLiveContour(targetRole)) {
      if (previousReadAt) return;
      const pendingKey = `${targetRole}:${id}`;
      if (pendingInboxReadsRef.current.has(pendingKey)) return;
      const optimisticReadAt = `optimistic:${targetRole}:${id}:${Date.now()}`;
      const pending: PendingInboxRead = {
        eventId: id,
        optimisticReadAt,
        previousReadAt,
        countedUnread: true,
      };
      pendingInboxReadsRef.current.set(pendingKey, pending);
      setInboxStateByRole((current) => ({
        ...current,
        [targetRole]: beginInboxRead(current[targetRole], id, optimisticReadAt).state,
      }));
      void markRoleInboxRead(targetRole, id)
        .then(() => {
          if (pendingInboxReadsRef.current.get(pendingKey) !== pending) return;
          pendingInboxReadsRef.current.delete(pendingKey);
          if (targetRole === 'admin') {
            adminInboxRefreshControllerRef.current?.invalidateAndRefresh();
          } else if (isLiveRoleSnapshotRole(targetRole)) {
            liveRefreshControllerRef.current?.invalidateAndRefresh();
          }
        })
        .catch((error: unknown) => {
          if (pendingInboxReadsRef.current.get(pendingKey) !== pending) return;
          pendingInboxReadsRef.current.delete(pendingKey);
          setInboxStateByRole((current) => ({
            ...current,
            [targetRole]: rollbackInboxRead(current[targetRole], pending),
          }));
          showMutationToast(
            targetRole,
            target.objectId,
            `${targetRole}-notification-read-${id}`,
            'warning',
            'Уведомление не отмечено прочитанным',
            error instanceof Error
              ? error.message
              : 'Повторите действие после восстановления связи.',
          );
        });
      return;
    }

    setNotifications((current) =>
      current.map((notification) =>
        notification.id === id
          ? { ...notification, readAt: notification.readAt ?? 'сейчас' }
          : notification,
      ),
    );
  }

  function openLiveNotification(notification: NotificationItem) {
    if (!notification.navigation) return;
    const role = notification.recipientRole;
    const destination = liveNotificationDestination(role, notification.navigation);
    const warehouseStockDestination =
      role === 'warehouse' && isWarehouseStockSection(destination.section);
    const destinationSection =
      role === 'warehouse'
        ? resolveWarehouseSection(destination.section).section
        : destination.section;
    markNotificationRead(notification.id);
    setOpenPanel('none');
    markLiveSelectionInitialized(role);
    setFilter(destination.filter);
    setQueueDateScopeByRole((current) => ({
      ...current,
      [role]: destination.queueDateScope,
    }));
    setActiveSectionByRole((current) => ({
      ...current,
      [role]: destinationSection,
    }));
    if (warehouseStockDestination) {
      setSelectedByRole((current) => ({
        ...current,
        warehouse: rawMaterialSourceObject?.id ?? null,
      }));
    } else if ('problemId' in destination) {
      if (role === 'production') {
        setSelectedProductionProblemId(destination.problemId);
      } else if (role === 'commercial' || role === 'director') {
        setSelectedBusinessProblemIdByRole((current) => ({
          ...current,
          [role]: destination.problemId,
        }));
      }
    } else if ('incidentId' in destination && destination.incidentId) {
      setSelectedAdminIncidentId(destination.incidentId);
      setSelectedByRole((current) => ({ ...current, [role]: null }));
    } else if ('clearSelection' in destination) {
      setSelectedByRole((current) => ({
        ...current,
        [role]: null,
      }));
    } else {
      if (role === 'production') setSelectedProductionProblemId(null);
      if (role === 'commercial' || role === 'director') {
        setSelectedBusinessProblemIdByRole((current) => ({ ...current, [role]: null }));
      }
      if (role === 'admin') setSelectedAdminIncidentId(null);
      setSelectedByRole((current) => ({
        ...current,
        [role]: destination.objectId,
      }));
    }
    if (role === 'director') setDirectorView('decisions');
    let url = liveNotificationUrl(window.location.href, role, notification.navigation);
    if (role === 'warehouse') {
      url = normalizeWarehouseNotificationUrl(url);
      if (warehouseStockDestination) {
        if (rawMaterialSourceObject) {
          url.searchParams.set('object', rawMaterialSourceObject.id);
        } else {
          url.searchParams.delete('object');
        }
      }
    }
    window.history.replaceState(null, '', url);
  }

  function acknowledgeNotification(id: string) {
    setNotifications((current) =>
      current.map((notification) =>
        notification.id === id
          ? {
              ...notification,
              readAt: notification.readAt ?? 'сейчас',
              acknowledgedAt: notification.acknowledgedAt ?? 'сейчас',
            }
          : notification,
      ),
    );
  }

  function toggleSound() {
    const nextValue = !soundByRole[activeRole];
    setSoundByRole((current) => ({ ...current, [activeRole]: nextValue }));
    if (nextValue) playPrototypeBeep();
  }

  function toggleReducedMotion() {
    setReducedMotionByRole((current) => ({ ...current, [activeRole]: !current[activeRole] }));
  }

  /**
   * Live-режим оператора: серверные действия уходят в backend, после успеха —
   * рефетч runtime (сервер = источник истины). Возвращает true, когда действие
   * обработано сервером и локальный редьюсер запускать не нужно.
   */
  function beginOperatorStageCooldown() {
    if (operatorStageCooldownTimerRef.current !== null) {
      window.clearTimeout(operatorStageCooldownTimerRef.current);
    }
    setOperatorPendingActionId('operator-stage-cooldown');
    operatorStageCooldownTimerRef.current = window.setTimeout(() => {
      operatorStageCooldownTimerRef.current = null;
      setOperatorPendingActionId((current) =>
        current === 'operator-stage-cooldown' ? null : current,
      );
    }, OPERATOR_STAGE_COOLDOWN_MS);
  }

  async function releaseLiveOperatorBigBag(bigBagId: string, input: { endKg: number }) {
    const request = operatorBagReleaseGateRef.current.start(
      `operator:shift:release-bag:${bigBagId}`,
      (operationKey) => releaseOperatorShiftBag(bigBagId, { operationKey, ...input }),
    );
    if (!request) {
      throw new Error('Возврат этого Big-Bag уже выполняется.');
    }
    try {
      const result = await request;
      setOperatorBigBags((current) =>
        current.map((bag) =>
          bag.id === result.bagId
            ? { ...bag, currentKg: result.endKg, status: result.status }
            : bag,
        ),
      );
      requestLiveRoleRefresh('operator');
      showMutationToast(
        'operator',
        undefined,
        `operator-release-bigbag:${bigBagId}`,
        'info',
        'Big-Bag взвешен и освобождён',
        `${result.endKg} кг · мешок можно вернуть на склад, смена остаётся открытой.`,
      );
      setOperatorLiveTick((tick) => tick + 1);
    } catch (error) {
      showMutationToast(
        'operator',
        undefined,
        `operator-release-bigbag:${bigBagId}`,
        'critical',
        'Big-Bag не освобождён',
        error instanceof Error ? error.message : 'Не удалось выполнить действие.',
      );
      throw error;
    }
  }

  function settleOperatorShiftCloseAttempt(attempt: OperatorShiftCloseAttempt) {
    if (operatorShiftCloseAttemptRef.current !== attempt) return false;
    operatorShiftCloseAttemptRef.current = null;
    setOperatorPendingActionId((current) =>
      current === 'operator-close-shift' || current === 'operator-close-shift-uncertain'
        ? null
        : current,
    );
    return true;
  }

  function applyOperatorShiftCloseSuccess(
    attempt: OperatorShiftCloseAttempt,
    result: OperatorShiftCloseResult,
  ) {
    if (!settleOperatorShiftCloseAttempt(attempt)) return;
    setOperatorRuntime((current) =>
      current.shift.id === attempt.shiftId
        ? { ...current, shift: { ...current.shift, status: 'closed' } }
        : current,
    );
    setBigBagWeightDraft({ startKg: '', endKg: '' });
    setOperatorClosingPayroll({ userId: session.id, payroll: result.closingPayroll });
    const deviation = result.balance.deviationPercent ?? 0;
    showMutationToast(
      'operator',
      undefined,
      'operator-close-shift',
      result.balance.status === 'mismatch' ? 'warning' : 'info',
      result.balance.status === 'mismatch' ? 'Смена сдана: расхождение баланса' : 'Смена сдана',
      result.balance.status === 'mismatch'
        ? `Отклонение ${deviation}% — проблема передана зав. производства.`
        : `Баланс сырья в норме (отклонение ${deviation}%).`,
    );
    liveRefreshControllerRef.current?.invalidateAndRefresh();
  }

  function startOperatorShiftCloseAttempt(
    attempt: OperatorShiftCloseAttempt,
    { verificationRetry = false }: { verificationRetry?: boolean } = {},
  ) {
    const currentAttempt = operatorShiftCloseAttemptRef.current;
    if (currentAttempt && currentAttempt !== attempt) return false;
    const request = operatorShiftCloseGateRef.current.start(
      attempt.intent,
      (operationKey) => {
        if (attempt.operationKey && attempt.operationKey !== operationKey) {
          throw new Error('Повтор закрытия смены получил другой operationKey.');
        }
        attempt.operationKey = operationKey;
        return closeOperatorShift({ operationKey, bags: attempt.bags });
      },
      'operator:shift:close',
    );
    if (!request) return false;

    operatorShiftCloseAttemptRef.current = attempt;
    setOperatorPendingActionId('operator-close-shift');
    void request
      .then((result) => applyOperatorShiftCloseSuccess(attempt, result))
      .catch((error: unknown) => {
        if (operatorShiftCloseAttemptRef.current !== attempt) return;
        if (!isDeliveryUncertain(error)) {
          settleOperatorShiftCloseAttempt(attempt);
          showMutationToast(
            'operator',
            undefined,
            'operator-live:operator-close-shift',
            'critical',
            'Смена не сдана',
            error instanceof Error ? error.message : 'Не удалось выполнить действие.',
          );
          return;
        }
        setOperatorPendingActionId('operator-close-shift-uncertain');
        if (verificationRetry) return;
        showMutationToast(
          'operator',
          undefined,
          'operator-live:operator-close-shift',
          'warning',
          'Статус сдачи проверяется',
          'Повторяем тот же безопасный запрос. Отмена станет доступна после подтверждения статуса сдачи.',
        );
        liveRefreshControllerRef.current?.invalidateAndRefresh();
      });
    return true;
  }

  function reconcileOperatorShiftCloseSnapshot(shift: OperatorRuntimeState['shift']) {
    const attempt = operatorShiftCloseAttemptRef.current;
    if (!attempt) return;
    if (shift.id !== attempt.shiftId || shift.status === 'closed') {
      settleOperatorShiftCloseAttempt(attempt);
      return;
    }
    startOperatorShiftCloseAttempt(attempt, { verificationRetry: true });
  }

  function runOperatorLiveAction(actionId: string): boolean {
    const refresh = () => {
      setOperatorLiveTick((tick) => tick + 1);
      requestLiveRoleRefresh('operator');
    };
    const failToast =
      (title: string, toastActionId = actionId) =>
      (error: unknown) =>
        showMutationToast(
          'operator',
          undefined,
          `operator-live:${toastActionId}`,
          'critical',
          title,
          error instanceof Error ? error.message : 'Не удалось выполнить действие.',
        );

    if (actionId === 'operator-close-shift-request') {
      setOperatorRuntime((current) => reduceOperatorRuntime(current, current.shift.id, actionId));
      return true;
    }

    const isDefectBagWeigh = actionId.startsWith('operator-weigh-defect-bag:');
    const defectBagWeight = parseOperatorDefectBagWeighAction(actionId);
    const defectBagPrint = parseOperatorDefectBagPrintAction(actionId);
    if (
      isDefectBagWeigh ||
      defectBagPrint
    ) {
      if (isDefectBagWeigh && !defectBagWeight) {
        showMutationToast(
          'operator',
          undefined,
          actionId,
          'warning',
          'Тип или вес брака не указан',
          'Выберите тип брака и введите вес от 0 до 10000 кг.',
        );
        return true;
      }
      const isWeigh = defectBagWeight !== null;
      const request = physicalOperationGateRef.current.start(
        `operator:shift:${operatorRuntime.shift.id}:defect-bag:${
          defectBagWeight
            ? `weigh:${defectBagWeight.draftId ?? 'legacy'}:${defectBagWeight.defectType}:${defectBagWeight.weightKg}`
            : `print:${defectBagPrint?.defectBagId ?? 'legacy'}:${Boolean(defectBagPrint?.reprint)}`
        }`,
        (operationKey) =>
          defectBagWeight
            ? weighOperatorDefectBag(
                defectBagWeight.draftId ?? operationKey,
                defectBagWeight.weightKg,
                defectBagWeight.defectType,
              )
            : printOperatorDefectBag(
                operationKey,
                defectBagPrint?.reprint
                  ? 'Повтор после ошибки принтера'
                  : undefined,
                defectBagPrint?.defectBagId,
              ),
        'operator:shift:defect-bag',
      );
      if (!request) return true;
      setOperatorPendingActionId(actionId);
      void request
        .then((defectBag) => {
          if (isWeigh) {
            setBigBagWeightDraft((current) => ({
              ...current,
              defectBagKg: '',
              defectBagType: undefined,
              defectBagDraftId: undefined,
            }));
          }
          setOperatorRuntime((current) => ({
            ...current,
            shift: withOperatorDefectBag(current.shift, defectBag),
          }));
          showMutationToast(
            'operator',
            undefined,
            actionId,
            'success',
            isWeigh ? 'Мешок брака взвешен' : 'QR мешка брака напечатан',
            isWeigh
              ? defectBag.weightKg === 0
                ? 'Брак 0 кг. QR не требуется, смену можно сдать.'
                : `${defectBagTypeLabel(defectBag.defectType)} · ${defectBag.weightKg} кг. Теперь напечатайте QR.`
              : `${defectBag.code} готов к передаче на склад.`,
          );
          refresh();
        })
        .catch((error: unknown) => {
          failToast(
            isWeigh ? 'Мешок брака не взвешен' : 'QR мешка брака не напечатан',
          )(error);
          refresh();
        })
        .finally(() => {
          setOperatorPendingActionId((current) => (current === actionId ? null : current));
        });
      return true;
    }

    const startMatch = actionId.match(/^operator-start-bigbag:(.+)$/);
    if (startMatch) {
      if (operatorRuntime.shift.status !== 'start_missing') {
        showMutationToast(
          'operator',
          undefined,
          actionId,
          'warning',
          'Смена ещё не началась',
          'Назначение станка сохранено. Открытие станет доступно в начале плановой смены.',
        );
        return true;
      }
      const startKg = Number(startMatch[1]);
      const bagId = bigBagWeightDraft.selectedBagId;
      if (!bagId) {
        showMutationToast(
          'operator',
          undefined,
          actionId,
          'warning',
          'Выберите Big-bag',
          'Смена открывается только с выбранным и взвешенным мешком со склада.',
        );
        return true;
      }
      const request = liveMutationGateRef.current.start(`operator:shift:open:${bagId}`, () =>
        openOperatorShift({
          bigBagId: bagId,
          startKg,
          ...(/^POST-\d+$/.test(operatorRuntime.shift.workplace)
            ? { postCode: operatorRuntime.shift.workplace }
            : {}),
        }),
      );
      if (!request) return true;
      void request
        .then(() => {
          setBigBagWeightDraft({ startKg: '', endKg: '' });
          showMutationToast(
            'operator',
            undefined,
            actionId,
            'info',
            'Смена открыта',
            `Стартовый вес ${startKg} кг зафиксирован, можно обрабатывать рулоны.`,
          );
          refresh();
        })
        .catch(failToast('Смена не открыта'));
      return true;
    }
    const addMatch = actionId.match(/^operator-add-bigbag:(.+)$/);
    if (addMatch) {
      const startKg = Number(addMatch[1]);
      const bagId = bigBagWeightDraft.addBagId;
      if (!bagId) {
        showMutationToast(
          'operator',
          undefined,
          actionId,
          'warning',
          'Мешок не добавлен',
          'Выберите Big-Bag.',
        );
        return true;
      }
      const request = liveMutationGateRef.current.start(`operator:shift:add-bag:${bagId}`, () =>
        addOperatorShiftBag({ bigBagId: bagId, startKg }),
      );
      if (!request) return true;
      void request
        .then(() => {
          setBigBagWeightDraft((current) => ({
            ...current,
            addBagId: undefined,
            addKg: '',
          }));
          showMutationToast(
            'operator',
            undefined,
            actionId,
            'info',
            'Big-bag добавлен в смену',
            `Стартовый вес ${startKg} кг зафиксирован.`,
          );
          refresh();
        })
        .catch(failToast('Мешок не добавлен'));
      return true;
    }
    const breakdown = parseOperatorMachineBreakdownAction(actionId);
    if (breakdown || actionId.startsWith(OPERATOR_MACHINE_BREAKDOWN_ACTION_PREFIX)) {
      if (!breakdown) {
        setOperatorBreakdownError('Некорректные данные поломки. Выберите тип повторно.');
        showMutationToast(
          'operator',
          undefined,
          actionId,
          'warning',
          'Заявка о поломке не отправлена',
          'Выберите один из доступных типов поломки и повторите отправку.',
        );
        return true;
      }
      const request = liveMutationGateRef.current.start('operator:machine-breakdown', () =>
        reportOperatorMachineBreakdown(breakdown),
      );
      if (!request) return true;
      setOperatorBreakdownPending(true);
      setOperatorBreakdownError(null);
      void request
        .then(() => {
          setOperatorBreakdownSuccessVersion((version) => version + 1);
          showMutationToast(
            'operator',
            undefined,
            actionId,
            'warning',
            'Заявка о поломке передана',
            'Станок помечен сломанным. Зав. производства подтвердит поломку и переназначит смену.',
          );
          refresh();
        })
        .catch((error: unknown) => {
          setOperatorBreakdownError(
            error instanceof Error ? error.message : 'Не удалось выполнить действие.',
          );
          failToast('Заявка о поломке не отправлена')(error);
        })
        .finally(() => setOperatorBreakdownPending(false));
      return true;
    }

    if (actionId === 'operator-close-shift') {
      if (operatorPendingActionId === 'operator-close-shift-uncertain') return true;
      const bags = (operatorRuntime.shift.bags ?? []).filter((bag) => bag.active);
      const entries = bags.map((bag) => ({
        bigBagId: bag.bagId,
        endKg: Number((bigBagWeightDraft.bagEndKg?.[bag.bagId] ?? '').replace(',', '.')),
      }));
      if (entries.some((entry) => !Number.isFinite(entry.endKg) || entry.endKg < 0)) {
        showMutationToast(
          'operator',
          undefined,
          actionId,
          'warning',
          'Смена не сдана',
          'Введите финальный вес каждого использованного мешка.',
        );
        return true;
      }
      const intent = `operator:shift:close:${operatorRuntime.shift.id}:${entries
        .map(({ bigBagId, endKg }) => `${bigBagId}:${endKg}`)
        .sort()
        .join('|')}`;
      startOperatorShiftCloseAttempt({
        shiftId: operatorRuntime.shift.id,
        intent,
        operationKey: null,
        bags: entries,
      });
      return true;
    }

    const selectionId =
      selectedByRole.operator ??
      operatorCurrentRoll(operatorRuntime.orders[0])?.id ??
      operatorRuntime.orders[0]?.id;
    const order = selectionId
      ? (operatorRuntime.orders.find((candidate) => candidate.id === selectionId) ??
        operatorRuntime.orders.find((candidate) =>
          candidate.rolls.some((roll) => roll.id === selectionId),
        ))
      : undefined;
    const roll = order
      ? (order.rolls.find((candidate) => candidate.id === selectionId) ??
        operatorCurrentRoll(order))
      : undefined;
    if (!order || !roll) return false;
    const rollCode = roll.id;
    const qrScanMatch = actionId.match(/^operator-verify-qr:(.+)$/);
    const physicalActionId = qrScanMatch ? 'operator-verify-qr' : actionId;
    let qrPayload: string | null = null;
    if (qrScanMatch) {
      try {
        qrPayload = decodeURIComponent(qrScanMatch[1]).trim();
      } catch {
        qrPayload = null;
      }
    }
    if (physicalActionId === 'operator-verify-qr' && !qrPayload) {
      showMutationToast(
        'operator',
        undefined,
        actionId,
        'warning',
        'QR не считан',
        'Установите курсор в поле сканирования и считайте наклеенную этикетку сканером.',
      );
      return true;
    }
    const stepBackPrompt = operatorStepBackPrompt(physicalActionId);
    const isStepBack = stepBackPrompt !== null;
    if (stepBackPrompt) {
      const expectedStatus =
        physicalActionId === 'operator-step-back-spool-weight' ? 'roll_weight' : 'qr_print';
      const hasSafeLabelBoundary = expectedStatus !== 'qr_print' || canOperatorReweigh(order);
      if (
        order.status !== expectedStatus ||
        !isOperatorCurrentRoll(order, roll) ||
        !hasSafeLabelBoundary
      ) {
        showMutationToast(
          'operator',
          order.id,
          physicalActionId,
          'warning',
          'Возврат этапа недоступен',
          'Состояние рулона уже изменилось. Обновите очередь и проверьте текущий этап.',
        );
        refresh();
        return true;
      }

      const confirmationKey = `operator-step-back:${rollCode}:${physicalActionId}`;
      if (!actionConfirmationBypassRef.current.delete(confirmationKey)) {
        setActionConfirmation({
          eyebrow: 'Оператор · возврат этапа',
          title: stepBackPrompt.title,
          objectTitle: `Рулон ${rollCode}`,
          message: stepBackPrompt.message,
          tone: 'warning',
          confirmLabel: stepBackPrompt.confirmLabel,
          cancelLabel: stepBackPrompt.cancelLabel,
          initialFocus: 'cancel',
          submitOnEnter: false,
          details: [
            {
              label: 'После возврата',
              value:
                physicalActionId === 'operator-step-back-spool-weight' ? 'Вес шпули' : 'Вес рулона',
            },
            { label: 'История', value: 'Предыдущее измерение сохранится' },
          ],
          onConfirm: () => {
            actionConfirmationBypassRef.current.add(confirmationKey);
            setActionConfirmation((current) => (current ? { ...current, pending: true } : current));
            window.requestAnimationFrame(() => applyOperatorAction(physicalActionId));
          },
        });
        return true;
      }
    }
    const isReweigh = physicalActionId === 'operator-reweigh-roll';
    if (isReweigh) {
      const canReweigh =
        order &&
        (canOperatorReweigh(order) || canOperatorRecoverInvalidHandoverWeight(order));
      if (!order || !isOperatorCurrentRoll(order, roll) || !canReweigh) {
        showMutationToast(
          'operator',
          order?.id,
          physicalActionId,
          'warning',
          'Перевзвешивание недоступно',
          'Повторный вес доступен до печати либо для некорректного веса перед передачей.',
        );
        return true;
      }
    }
    if (operatorPendingActionId === physicalActionId) return true;
    if (
      operatorPendingActionId === 'operator-stage-cooldown' &&
      operatorStageCooldownBlocksAction(physicalActionId) &&
      !isOperatorStepBackAction(physicalActionId)
    ) {
      return true;
    }
    const serverActions: Record<string, (operationKey: string) => Promise<void>> = {
      'operator-accept-order': (operationKey) => acceptOperatorRoll(rollCode, operationKey),
      'operator-spool-weight': (operationKey) => captureOperatorSpoolWeight(rollCode, operationKey),
      'operator-roll-weight': (operationKey) => captureOperatorRollWeight(rollCode, operationKey),
      'operator-print-qr': (operationKey) => printOperatorQr(rollCode, operationKey),
      'operator-reprint-label': (operationKey) =>
        printOperatorQr(rollCode, operationKey, 'Повторная печать этикетки'),
      'operator-verify-qr': (operationKey) =>
        roll.status === 'handover'
          ? handoverOperatorRoll(rollCode, operationKey)
          : verifyAndHandoverOperatorQr(
              rollCode,
              operationKey,
              createOperationKey(),
              qrPayload as string,
            ),
      'operator-handover': (operationKey) => handoverOperatorRoll(rollCode, operationKey),
      'operator-defer-order': (operationKey) =>
        deferOperatorRoll(rollCode, operationKey, 'Отложено оператором со смены'),
      'operator-resume-order': (operationKey) => resumeOperatorRoll(rollCode, operationKey),
    };
    type OperatorPhysicalOutcome =
      | { kind: 'standard' }
      | { kind: 'reweigh'; result: OperatorRollReweighResult }
      | { kind: 'step-back'; result: OperatorRollStepBackResult };
    let run: (operationKey: string) => Promise<OperatorPhysicalOutcome>;
    if (isReweigh) {
      run = async (operationKey) => ({
        kind: 'reweigh',
        result: await reweighOperatorRoll(rollCode, operationKey),
      });
    } else if (isStepBack) {
      run = async (operationKey) => ({
        kind: 'step-back',
        result: await stepBackOperatorRoll(rollCode, operationKey),
      });
    } else {
      const serverAction = serverActions[physicalActionId];
      if (!serverAction) return false;
      run = async (operationKey) => {
        await serverAction(operationKey);
        return { kind: 'standard' };
      };
    }
    const request = operatorRollOperationGateRef.current.start(
      `operator:${rollCode}:${physicalActionId}`,
      run,
      `operator:${rollCode}:physical`,
    );
    if (!request) {
      if (isStepBack) setActionConfirmation(null);
      return true;
    }
    setOperatorPendingActionId(physicalActionId);
    void request
      .then((outcome) => {
        if (outcome.kind === 'step-back') {
          setOperatorRuntime((current) => applyOperatorStepBackResult(current, outcome.result));
          refresh();
          const prompt = operatorStepBackPrompt(physicalActionId);
          showMutationToast(
            'operator',
            order.id,
            physicalActionId,
            'success',
            prompt?.successTitle ?? 'Этап возвращён',
            prompt?.successDetail ??
              'Предыдущее измерение сохранено в истории. Выполните взвешивание заново.',
          );
          beginOperatorStageCooldown();
          return;
        }
        if (outcome.kind === 'reweigh') {
          setOperatorRuntime((current) => applyOperatorReweighResult(current, outcome.result));
          showMutationToast(
            'operator',
            order?.id,
            physicalActionId,
            'success',
            'Рулон перевзвешен',
            `${outcome.result.previousWeight.netKg} кг → ${outcome.result.currentWeight.netKg} кг`,
          );
          return;
        }
        refresh();
        if (isOperatorStageTransitionAction(physicalActionId)) {
          beginOperatorStageCooldown();
        }
      })
      .catch((error: unknown) => {
        if (isStepBack) {
          refresh();
          showMutationToast(
            'operator',
            order.id,
            physicalActionId,
            'critical',
            'Этап не возвращён',
            operatorStepBackFailureDetail(error),
          );
          return;
        }
        if (!isReweigh) {
          refresh();
          failToast('Действие не выполнено', physicalActionId)(error);
          return;
        }
        showMutationToast(
          'operator',
          order?.id,
          physicalActionId,
          'critical',
          'Рулон не перевзвешен',
          `${error instanceof Error ? error.message : 'Не удалось выполнить действие.'} Повторите действие.`,
        );
      })
      .finally(() => {
        if (isStepBack) setActionConfirmation(null);
        setOperatorPendingActionId((current) => (current === physicalActionId ? null : current));
      });
    return true;
  }

  function submitOperatorDefect(): Promise<void> {
    if (!operatorDefectDialog) {
      return Promise.reject(new Error('Текущий рулон не выбран.'));
    }
    const { orderId, rollCode } = operatorDefectDialog;
    const actionId = 'operator-defect';
    const intent = operatorDefectIntent(rollCode);
    const request = operatorRollOperationGateRef.current.start(
      intent,
      (operationKey) =>
        reportOperatorDefect({
          rollCode,
          operationKey,
        }),
      `operator:${rollCode}:physical`,
    );
    if (!request) {
      return Promise.reject(
        new Error('Дождитесь завершения текущей физической операции и повторите.'),
      );
    }

    setOperatorPendingActionId(actionId);
    return request
      .then(() => {
        setOperatorLiveTick((tick) => tick + 1);
        requestLiveRoleRefresh('operator');
        showMutationToast(
          'operator',
          orderId,
          actionId,
          'warning',
          'Брак и вес зафиксированы',
          `${rollCode}: вес и брак сохранены; новая попытка добавлена в очередь оператора.`,
        );
        setOperatorDefectDialog(null);
      })
      .catch((error: unknown) => {
        const detail = submissionErrorMessage(error);
        showMutationToast(
          'operator',
          orderId,
          actionId,
          'critical',
          'Брак не зафиксирован',
          detail,
        );
        throw error;
      })
      .finally(() => {
        setOperatorPendingActionId((current) => (current === actionId ? null : current));
      });
  }

  function applyOperatorAction(actionId: string) {
    if (actionId === 'operator-close-shift-request' || actionId === 'operator-close-shift-cancel') {
      if (
        actionId === 'operator-close-shift-cancel' &&
        (operatorRuntime.shift.status !== 'close_pending' ||
          operatorPendingActionId === 'operator-close-shift' ||
          operatorPendingActionId === 'operator-close-shift-uncertain')
      ) {
        return;
      }
      setOperatorRuntime((current) => reduceOperatorRuntime(current, current.shift.id, actionId));
      if (actionId === 'operator-close-shift-cancel') {
        setBigBagWeightDraft((current) => ({
          ...current,
          endKg: '',
          bagEndKg: {},
        }));
      }
      return;
    }
    if (actionId === 'operator-defect' && isOperatorLive) {
      const selectionId =
        selectedByRole.operator ??
        operatorCurrentRoll(operatorRuntime.orders[0])?.id ??
        operatorRuntime.orders[0]?.id;
      const order = selectionId
        ? (operatorRuntime.orders.find((candidate) => candidate.id === selectionId) ??
          operatorRuntime.orders.find((candidate) =>
            candidate.rolls.some((roll) => roll.id === selectionId),
          ))
        : undefined;
      const roll = order
        ? (order.rolls.find((candidate) => candidate.id === selectionId) ??
          operatorCurrentRoll(order))
        : undefined;
      if (!order || !roll) {
        showMutationToast(
          'operator',
          undefined,
          actionId,
          'critical',
          'Рулон не выбран',
          'Откройте текущий рулон и повторите фиксацию брака.',
        );
        return;
      }
      setOperatorDefectDialog({
        orderId: order.id,
        rollCode: roll.id,
        spoolKg: roll.spoolKg ?? 0,
        plannedNetKg: roll.plannedNetKg,
      });
      return;
    }
    if (isOperatorLive && runOperatorLiveAction(actionId)) return;
    const runtimeActionId = /^operator-verify-qr:.+$/.test(actionId)
      ? 'operator-verify-qr'
      : actionId;
    const selectedOperatorSelectionId =
      selectedByRole.operator ??
      operatorCurrentRoll(operatorRuntime.orders[0])?.id ??
      operatorRuntime.orders[0]?.id;
    const selectedOperatorOrder = selectedOperatorSelectionId
      ? (operatorRuntime.orders.find((order) => order.id === selectedOperatorSelectionId) ??
        operatorRuntime.orders.find((order) =>
          order.rolls.some((roll) => roll.id === selectedOperatorSelectionId),
        ))
      : undefined;
    const selectedOperatorId = selectedOperatorOrder?.id;
    if (!selectedOperatorSelectionId || !selectedOperatorId) return;
    if (isProblemReportAction(actionId)) {
      const sourceObject = getOperatorSelectedObject(operatorRuntime, selectedOperatorSelectionId);
      if (sourceObject) openProblemReport('operator', sourceObject, actionId);
      return;
    }
    const nextOrderAction = actionId.match(/^operator-next-order(?::(.+))?$/);
    if (nextOrderAction) {
      const nextOrderId =
        nextOrderAction[1] ?? operatorNextWorkOrderId(operatorRuntime, selectedOperatorId);
      if (!nextOrderId) return;
      const nextOrder = operatorRuntime.orders.find((order) => order.id === nextOrderId);
      setSelectedByRole((current) => ({
        ...current,
        operator: nextOrder ? (operatorCurrentRoll(nextOrder)?.id ?? nextOrder.id) : nextOrderId,
      }));
      setActiveSectionByRole((current) => ({ ...current, operator: OPERATOR_ROLLS_SECTION }));
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: 'auto' });
        document
          .querySelector<HTMLElement>('.detail-panel')
          ?.scrollTo({ top: 0, behavior: 'auto' });
      });
      return;
    }
    const selectedOrder = operatorRuntime.orders.find((order) => order.id === selectedOperatorId);
    const selectedRoll = selectedOrder
      ? (selectedOrder.rolls.find((roll) => roll.id === selectedOperatorSelectionId) ??
        operatorCurrentRoll(selectedOrder))
      : undefined;
    const nextRuntime = reduceOperatorRuntime(
      operatorRuntime,
      selectedOperatorSelectionId,
      runtimeActionId,
    );
    setOperatorRuntime(nextRuntime);
    if (nextRuntime !== operatorRuntime && parseOperatorDefectBagWeighAction(runtimeActionId)) {
      setBigBagWeightDraft((current) => ({ ...current, defectBagDraftId: undefined, defectBagKg: '', defectBagType: undefined }));
    }
    const nextSelectedOrder = nextRuntime.orders.find((order) => order.id === selectedOperatorId);
    if (nextSelectedOrder) {
      setSelectedByRole((current) => ({
        ...current,
        operator: operatorCurrentRoll(nextSelectedOrder)?.id ?? nextSelectedOrder.id,
      }));
    }
    if (
      selectedOrder &&
      selectedRoll &&
      (actionId === 'operator-handover' || runtimeActionId === 'operator-verify-qr')
    ) {
      dispatchRuntimeAction({
        type: 'operator.handover',
        order: selectedOrder,
        roll: selectedRoll,
        shift: operatorRuntime.shift,
      });
      setSelectedByRole((current) => ({ ...current, warehouse: `WH-${selectedOrder.id}` }));
      notifyRole(
        'warehouse',
        `WH-${selectedOrder.id}`,
        'Приемка открыта',
        `${selectedRoll.id} передан оператором и появился в складской приемке.`,
        'info',
      );
    }
    if (selectedOrder && selectedRoll && actionId === 'operator-reprint-label') {
      dispatchRuntimeAction({
        type: 'operator.label.reprinted',
        order: selectedOrder,
        roll: selectedRoll,
        reason: 'Повторная печать из operator flow',
      });
    }
    if (selectedOrder && selectedRoll && actionId === 'operator-defect') {
      dispatchRuntimeAction({
        type: 'operator.defect.recorded',
        order: selectedOrder,
        roll: selectedRoll,
        comment: 'Свободный комментарий оператора к браку',
        weightKg: selectedRoll.actualNetKg ?? selectedRoll.netKg,
      });
      notifyRole(
        'production',
        selectedOrder.id,
        'Брак требует разбора',
        `${selectedRoll.id}: брак записан с проверкой веса и комментария.`,
        'warning',
      );
    }
    if (actionWeightValue(actionId, 'operator-start-bigbag:') !== null) {
      setBigBagWeightDraft((current) => ({ ...current, startKg: '' }));
      setActiveSectionByRole((current) => ({ ...current, operator: OPERATOR_ROLLS_SECTION }));
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: 'auto' });
        document
          .querySelector<HTMLElement>('.detail-panel')
          ?.scrollTo({ top: 0, behavior: 'auto' });
      });
    }
    if (actionWeightValue(actionId, 'operator-end-bigbag:') !== null) {
      setBigBagWeightDraft((current) => ({ ...current, endKg: '' }));
    }
    if (shouldPlayOperatorSuccessSound(runtimeActionId)) playPrototypeBeep();
    const operatorToast = operatorActionToast(runtimeActionId, {
      orderId: selectedOrder?.orderId,
      rollId: selectedRoll?.id,
    });
    if (operatorToast) {
      showMutationToast(
        'operator',
        selectedOperatorId,
        runtimeActionId,
        operatorToast.tone,
        operatorToast.title,
        operatorToast.detail,
      );
    }
  }

  function notifyRole(
    recipientRole: Role,
    objectId: string,
    title: string,
    body: string,
    severity: WorkObject['severity'] = 'info',
    eventType?: string,
  ) {
    setNotifications((current) => [
      {
        id: `n-${objectId}-${Date.now()}`,
        eventType,
        recipientRole,
        severity,
        title,
        body,
        objectId,
        createdAt: stampNow(),
        requiresAck: eventType === 'notification:penalty_created' ? false : severity !== 'info',
        sound: true,
      },
      ...current,
    ]);
  }

  function dispatchRuntimeAction(action: RuntimeAction) {
    setProductionRuntime((current) => reduceProductionRuntime(current, action));
  }

  function openProblemReport(role: Role, object: WorkObject, actionId: string) {
    const activeElement = document.activeElement;
    problemOpenTriggerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    setProblemReportContext(createProblemReportContext(role, object, actionId));
  }

  function closeProblemReport() {
    setProblemReportContext(null);
  }

  function productionObjectForProblem(payload: ProblemReportPayload) {
    if (selectedObject?.id === payload.objectId && selectedObject.kind === 'productionOrder')
      return selectedObject;
    return (
      getObjectsForRole('production', projectedWorkObjectsByRole).find(
        (object) => object.id === payload.objectId,
      ) ?? null
    );
  }

  function submitProductionProblemReport(payload: ProblemReportPayload) {
    const sourceObject = productionObjectForProblem(payload);
    if (!sourceObject) return;
    const productionProblem = createProductionProblem(sourceObject, payload.reason);
    const commercialId = productionProblem.commercialOrderId;

    updateRoleObject(
      'production',
      sourceObject.id,
      (object) => addProblemReportToObject(object, payload).object,
    );
    updateRoleObject('commercial', commercialId, (object) => ({
      ...object,
      severity: object.severity === 'critical' ? object.severity : payload.severity,
      filterTags: Array.from(
        new Set([...(object.filterTags ?? []), 'С проблемами', 'Требуют действия']),
      ),
      productionProblems: [productionProblem, ...(object.productionProblems ?? [])],
      commercialProductionProgress: progressFromProductionProblem(productionProblem),
      problems: [
        {
          id: `${productionProblem.id}-commercial-case`,
          objectId: object.id,
          type: payload.type,
          entityKind: payload.entityKind,
          entityId: payload.entityId,
          createdByRole: payload.createdByRole,
          targetRole: 'commercial',
          sourceActionId: payload.sourceActionId,
          stage: 'Производство',
          title: 'Проблема из производства',
          severity: productionProblem.severity,
          ownerRole: 'Коммерция',
          due: payload.due,
          reason: payload.reason,
          recovery: payload.recovery,
          status: 'open' as const,
        },
        ...object.problems,
      ],
      actions: object.actions.some((item) => item.id === 'commercial-open-production-problem')
        ? object.actions
        : [
            {
              id: 'commercial-open-production-problem',
              label: 'Разобрать проблему производства',
              level: 'recommended' as const,
              enabled: true,
            },
            {
              id: 'commercial-request-correction',
              label: 'Изменить позицию по проблеме...',
              level: 'peer' as const,
              enabled: true,
              confirmation: 'Нужна причина и рулон, с которого действует изменение',
            },
            ...object.actions,
          ],
      audit: [
        auditEntry(object.id, payload.actorLabel, payload.auditEvent, payload.reason),
        ...object.audit,
      ],
    }));
    notifyRole(
      'commercial',
      commercialId,
      payload.notificationTitle,
      payload.reason,
      payload.severity,
    );
    setOfficeActionOutcome('production', sourceObject.id, {
      tone: 'warning',
      title: 'Проблема отправлена коммерции.',
      detail: 'Коммерция увидит прогресс и задаст рулон применения.',
    });
  }

  function submitOperatorProblemReport(payload: ProblemReportPayload) {
    const sourceObject = getOperatorSelectedObject(operatorRuntime, payload.objectId);
    if (!sourceObject) return;
    const result = addProblemReportToObject(sourceObject, payload);
    setOperatorRuntime((current) => ({
      ...current,
      reportedProblems: {
        ...(current.reportedProblems ?? {}),
        [payload.objectId]: [
          result.problem,
          ...(current.reportedProblems?.[payload.objectId] ?? []),
        ],
      },
      audit: {
        ...current.audit,
        [payload.objectId]: [result.audit, ...(current.audit[payload.objectId] ?? [])],
      },
    }));
  }

  function submitProblemReport(payload: ProblemReportPayload) {
    const outcomeTitle =
      payload.auditEvent === 'problem:production_reported_to_commercial'
        ? 'Проблема отправлена коммерции.'
        : 'Проблема создана.';
    if (isOperatorLive && payload.createdByRole === 'operator') {
      const problemType = payload.operatorProblemType ?? 'general';
      const reason = payload.reason.trim();
      const recovery = payload.recovery.trim();
      const intent = `operator:problem:${JSON.stringify({
        type: problemType,
        rollId: payload.entityId,
        reason,
        recovery,
      })}`;
      const request = operatorProblemGateRef.current.start(
        intent,
        (operationKey) =>
          reportOperatorProblem({
            operationKey,
            type: problemType,
            rollId: payload.entityId,
            reason,
            ...(recovery ? { recovery } : {}),
          }),
        'operator:problem',
      );
      if (!request) return Promise.resolve();
      return request
        .then(() => {
          const detail = 'Проблема сохранена и передана ответственному.';
          setNavigationActionOutcome({
            role: 'operator',
            objectId: payload.objectId,
            tone: 'warning',
            title: 'Проблема отправлена.',
            detail,
          });
          showMutationToast(
            'operator',
            payload.objectId,
            payload.sourceActionId,
            'warning',
            'Проблема отправлена.',
            detail,
          );
          requestLiveRoleRefresh('operator');
          setProblemReportContext(null);
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : 'Обращение не записано.';
          setNavigationActionOutcome({
            role: 'operator',
            objectId: payload.objectId,
            tone: 'critical',
            title: 'Проблема не отправлена.',
            detail,
          });
          showMutationToast(
            'operator',
            payload.objectId,
            payload.sourceActionId,
            'critical',
            'Проблема не отправлена.',
            detail,
          );
        });
    }
    if (isFinanceLive && payload.sourceActionId.startsWith('finance-create-problem:')) {
      return createFinanceProblem(payload.objectId, {
        kind: payload.auditEvent === 'problem:payment_overdue' ? 'overdue' : 'other',
        reason: payload.reason,
        evidence: payload.notificationBody || payload.title,
      })
        .then(() => {
          const detail = `${payload.ownerRole}: ${payload.recovery}`;
          setOfficeActionOutcome('finance', payload.objectId, {
            tone: 'warning',
            title: outcomeTitle,
            detail,
          });
          setNavigationActionOutcome({
            role: 'finance',
            objectId: payload.objectId,
            tone: 'warning',
            title: outcomeTitle,
            detail,
          });
          showMutationToast(
            'finance',
            payload.objectId,
            payload.sourceActionId,
            'warning',
            outcomeTitle,
            detail,
          );
          requestLiveRoleRefresh('finance');
          setProblemReportContext(null);
          window.requestAnimationFrame(() => openDetailTarget('.inline-context-details'));
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : 'Обращение не записано.';
          setOfficeActionOutcome('finance', payload.objectId, {
            tone: 'critical',
            title: 'Проблема не сохранена.',
            detail,
          });
          setNavigationActionOutcome({
            role: 'finance',
            objectId: payload.objectId,
            tone: 'critical',
            title: 'Проблема не создана.',
            detail,
          });
          showMutationToast(
            'finance',
            payload.objectId,
            payload.sourceActionId,
            'critical',
            'Проблема не создана.',
            detail,
          );
        });
    }
    if (payload.auditEvent === 'problem:production_reported_to_commercial') {
      submitProductionProblemReport(payload);
    } else if (payload.createdByRole === 'operator') {
      submitOperatorProblemReport(payload);
    } else {
      updateRoleObject(
        payload.createdByRole,
        payload.objectId,
        (object) => addProblemReportToObject(object, payload).object,
      );
    }

    if (payload.createdByRole === 'finance') {
      notifyRole(
        'commercial',
        payload.objectId,
        'Финансовая проблема по заказу',
        payload.reason || payload.notificationBody,
        'warning',
      );
      setOfficeActionOutcome('finance', payload.objectId, {
        tone: 'warning',
        title: outcomeTitle,
        detail: `${payload.ownerRole}: ${payload.recovery}`,
      });
    } else if (payload.createdByRole === 'production') {
      setOfficeActionOutcome('production', payload.objectId, {
        tone: 'warning',
        title: outcomeTitle,
        detail: `${payload.ownerRole}: ${payload.recovery}`,
      });
    }
    setNavigationActionOutcome({
      role: payload.createdByRole,
      objectId: payload.objectId,
      tone: 'warning',
      title: outcomeTitle,
      detail: `${payload.ownerRole}: ${payload.recovery}`,
    });
    showMutationToast(
      payload.createdByRole,
      payload.objectId,
      payload.sourceActionId,
      'warning',
      outcomeTitle,
      `${payload.ownerRole}: ${payload.recovery}`,
    );

    if (
      payload.auditEvent !== 'problem:production_reported_to_commercial' &&
      payload.notificationRole &&
      payload.notificationRole !== payload.createdByRole
    ) {
      notifyRole(
        payload.notificationRole,
        payload.objectId,
        payload.notificationTitle,
        payload.reason || payload.notificationBody,
        payload.severity,
      );
    }
    setProblemReportContext(null);
    window.requestAnimationFrame(() => openDetailTarget('.inline-context-details'));
  }

  function createPenalty(payload: PenaltyFormPayload, authorRole: 'director' | 'production') {
    const recipientRole = penaltyRecipientRole(payload.employeeRole);
    dispatchRuntimeAction({ type: 'director.penalty.created', ...payload, authorRole });
    notifyRole(
      recipientRole,
      payload.scopeObjectId,
      'Штраф назначен',
      recipientRole === 'operator'
        ? `Причина: ${payload.reason}. Статус: уведомлен.`
        : `Причина: ${payload.reason}. Сумма: ${payload.amountLabel}. Статус: уведомлен.`,
      'info',
      'notification:penalty_created',
    );
    if (recipientRole === 'operator') {
      setSelectedByRole((current) => ({ ...current, operator: null }));
    }
    showMutationToast(
      authorRole,
      payload.scopeObjectId,
      'penalty:create',
      'info',
      'Штраф назначен',
      'Уведомление и история обновлены.',
    );
  }

  async function changePenaltyFilters(
    role: 'production' | 'director',
    filters: PenaltySnapshotFilters,
  ) {
    return changeLivePenaltyFilters(role, filters);
  }

  async function createDirectorPenalty(payload: PenaltyFormPayload) {
    if (!isDirectorLive) {
      createPenalty(payload, 'director');
      return true;
    }
    const amount = Number(payload.amountLabel.replace(/[^\d,.]/g, '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      showMutationToast(
        'director',
        payload.scopeObjectId,
        'penalty:create',
        'critical',
        'Штраф не назначен',
        'Укажите положительную сумму.',
      );
      return false;
    }
    const targetRole =
      penaltyRecipientRole(payload.employeeRole) === 'operator' ? 'operator' : 'production_lead';
    const request = liveMutationGateRef.current.start(
      `director:penalty:${targetRole}:${payload.employeeId}:${payload.scopeObjectId}`,
      () =>
        createDirectorPenaltyApi({
          targetRole,
          amount,
          reason: payload.reason,
          ...(payload.employeeId ? { employeeId: payload.employeeId } : {}),
          ...(payload.scopeObjectId ? { sourceObjectId: payload.scopeObjectId } : {}),
        }),
    );
    if (!request) return false;
    try {
      const created = await request;
      const hydrated: PenaltyRuntime = {
        ...created,
        employeeId: payload.employeeId || created.employeeId,
        employeeName: payload.employeeName,
        employeeRole: payload.employeeRole,
        scopeObjectId: payload.scopeObjectId,
      };
      await refreshLivePenaltySnapshot('director');
      showMutationToast(
        'director',
        hydrated.penaltyId,
        'penalty:create',
        'info',
        'Штраф назначен',
        'Штраф и уведомление сохранены.',
      );
      return true;
    } catch (error) {
      showMutationToast(
        'director',
        payload.scopeObjectId,
        'penalty:create',
        'critical',
        'Штраф не назначен',
        error instanceof Error ? error.message : 'Штраф не назначен.',
      );
      return false;
    }
  }

  async function createProductionPenalty(payload: PenaltyFormPayload) {
    if (!isProductionLive) {
      createPenalty({ ...payload, author: payload.author || 'Зав. производства' }, 'production');
      return true;
    }
    if (!payload.productionOrderId) {
      showMutationToast(
        'production',
        undefined,
        'penalty:create',
        'critical',
        'Штраф не назначен',
        'Выберите реальный заказ оператора.',
      );
      return false;
    }
    const productionOrderId = payload.productionOrderId;
    const amount = Number(payload.amountLabel.replace(/[^\d,.]/g, '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      showMutationToast(
        'production',
        payload.scopeObjectId,
        'penalty:create',
        'critical',
        'Штраф не назначен',
        'Укажите положительную сумму.',
      );
      return false;
    }
    let created: Awaited<ReturnType<typeof createProductionOperatorPenalty>> | null = null;
    const outcome = await commitThenRefresh(
      async () => {
        created = await createProductionOperatorPenalty({
          operatorId: payload.employeeId,
          productionOrderId,
          ...(payload.rollCode ? { rollCode: payload.rollCode } : {}),
          amount,
          reason: payload.reason,
        });
      },
      async () => {
        if (!(await refreshLivePenaltySnapshot('production'))) {
          throw new Error('Penalty snapshot refresh failed');
        }
      },
    );
    const committedPenalty = created as Awaited<
      ReturnType<typeof createProductionOperatorPenalty>
    > | null;
    if (!outcome.committed || !committedPenalty) {
      const error = outcome.committed ? null : outcome.error;
      showMutationToast(
        'production',
        payload.scopeObjectId,
        'penalty:create',
        'critical',
        'Штраф не назначен',
        error instanceof Error ? error.message : 'Штраф не назначен.',
      );
      return false;
    }
    showMutationToast(
      'production',
      committedPenalty.penaltyId,
      'penalty:create',
      outcome.refreshed ? 'info' : 'warning',
      'Штраф назначен',
      outcome.refreshed
        ? `Оператор ${committedPenalty.employeeName} увидит его в личном разделе «Штрафы».`
        : 'Штраф сохранён, но список не обновился. Повторите обновление данных.',
    );
    return true;
  }

  function updatePenalty(
    penaltyId: string,
    payload: PenaltyFormPayload,
    authorRole: 'director' | 'production',
  ) {
    const recipientRole = penaltyRecipientRole(payload.employeeRole);
    dispatchRuntimeAction({ type: 'director.penalty.updated', penaltyId, ...payload, authorRole });
    notifyRole(
      recipientRole,
      penaltyId,
      'Штраф изменен',
      recipientRole === 'operator'
        ? `Обновлены данные разбора. Причина: ${payload.reason}.`
        : `Обновлены данные штрафа. Причина: ${payload.reason}. Сумма: ${payload.amountLabel}.`,
      'info',
    );
    showMutationToast(
      authorRole,
      penaltyId,
      'penalty:update',
      'info',
      'Штраф изменен',
      'Уведомление и история обновлены.',
    );
  }

  function updateDirectorPenalty(penaltyId: string, payload: PenaltyFormPayload) {
    updatePenalty(penaltyId, payload, 'director');
  }

  function updateProductionPenalty(penaltyId: string, payload: PenaltyFormPayload) {
    updatePenalty(
      penaltyId,
      { ...payload, author: payload.author || 'Зав. производства' },
      'production',
    );
  }

  function updateRoleObject(
    role: Role,
    objectId: string,
    updater: (object: WorkObject) => WorkObject,
  ) {
    setWorkObjectsByRole((current) => ({
      ...current,
      [role]: current[role].map((object) => (object.id === objectId ? updater(object) : object)),
    }));
  }

  function replaceFinanceObject(updated: WorkObject) {
    updateRoleObject('finance', updated.id, () => updated);
  }

  async function correctLiveFinancePayment(
    target: FinancePaymentCorrectionTarget,
    reason: string,
  ): Promise<boolean> {
    if (
      !isFinanceLive ||
      !detailObject ||
      detailObject.kind !== 'financeOrder' ||
      !detailObject.financePaymentStatus
    ) {
      showMutationToast(
        'finance',
        detailObject?.id ?? 'finance-payment-correction',
        'finance-payment-correction',
        'critical',
        'Корректировка не выполнена',
        'Обновите финансовое дело и повторите действие.',
      );
      return false;
    }

    const financeOrderId = detailObject.id;
    const expectedPaymentStatus = detailObject.financePaymentStatus;
    let payload;
    try {
      payload = financePaymentCorrectionReplayRef.current.prepare(financeOrderId, {
        target,
        expectedPaymentStatus,
        reason,
      });
    } catch (error) {
      showMutationToast(
        'finance',
        financeOrderId,
        'finance-payment-correction',
        'warning',
        'Сначала завершите сохранённую корректировку',
        error instanceof Error ? error.message : 'Повторите исходную корректировку без изменений.',
      );
      return false;
    }
    const serializationKey = `finance:payment-correction:${financeOrderId}`;
    const intent = financePaymentCorrectionIntent(financeOrderId, payload);
    let attemptedCommand: ReturnType<FinancePaymentCorrectionReplayGuard['command']> | null = null;
    const request = financeOperationGateRef.current.start(
      intent,
      async (operationKey) => {
        attemptedCommand = financePaymentCorrectionReplayRef.current.command(
          financeOrderId,
          payload,
          operationKey,
        );
        await correctFinancePayment(financeOrderId, attemptedCommand);
        try {
          const financeOrders = await fetchFinanceOrders();
          const reconciledOrder = financeOrders.find((object) => object.id === financeOrderId);
          const unresolvedTarget = reconciledOrder?.correctablePayments?.find(
            (item) =>
              item.target.kind === payload.target.kind && item.target.id === payload.target.id,
          );
          if (
            !reconciledOrder ||
            !Array.isArray(reconciledOrder.correctablePayments) ||
            unresolvedTarget?.canCorrect
          ) {
            throw new Error('Каноническая карточка ещё не подтвердила корректировку.');
          }
          return financeOrders;
        } catch (error) {
          throw new ApiResponseParseError(200, error);
        }
      },
      serializationKey,
    );
    if (!request) return false;

    try {
      const financeOrders = await request;
      financePaymentCorrectionReplayRef.current.resolve(financeOrderId);
      setWorkObjectsByRole((current) => ({ ...current, finance: financeOrders }));
      setSelectedByRole((current) => ({ ...current, finance: financeOrderId }));
      liveRefreshControllerRef.current?.invalidateAndRefresh();
      showMutationToast(
        'finance',
        financeOrderId,
        'finance-payment-correction',
        'success',
        'Подтверждение отменено',
        'Создана корректирующая запись. Счёт и ранее выданный допуск сохранены.',
      );
      return true;
    } catch (error) {
      if (attemptedCommand) {
        financePaymentCorrectionReplayRef.current.reject(financeOrderId, attemptedCommand, error);
      }
      const deliveryUncertain = isDeliveryUncertain(error);
      showMutationToast(
        'finance',
        financeOrderId,
        'finance-payment-correction',
        deliveryUncertain ? 'warning' : 'critical',
        deliveryUncertain ? 'Результат корректировки нужно сверить' : 'Корректировка не выполнена',
        deliveryUncertain
          ? 'Запрос мог быть записан. Повторите ту же корректировку без изменения причины или платёжного факта.'
          : error instanceof Error
            ? error.message
            : 'Не удалось выполнить действие.',
      );
      return false;
    }
  }

  async function adjustLiveWarehouseRawMaterial(input: {
    materialId: string;
    actualQty: number;
    reason: string;
  }) {
    const serializationKey = `warehouse:raw-adjust:${input.materialId}`;
    let payload: { actualQty: number; reason: string };
    try {
      payload = warehouseRawAdjustmentReplayRef.current.prepare(input.materialId, {
        actualQty: input.actualQty,
        reason: input.reason,
      });
    } catch (error) {
      showMutationToast(
        'warehouse',
        'warehouse-live-inventory',
        'warehouse-raw-adjust',
        'warning',
        'Сначала завершите сохранённую корректировку',
        error instanceof Error ? error.message : 'Повторите исходную корректировку без изменений.',
      );
      throw error;
    }
    const intent = warehouseRawAdjustmentIntent(input.materialId, payload);
    const request = physicalOperationGateRef.current.start(
      intent,
      (operationKey) =>
        adjustWarehouseRawMaterial(input.materialId, {
          operationKey,
          ...payload,
        }),
      serializationKey,
    );
    if (!request) return false;

    try {
      await request;
      warehouseRawAdjustmentReplayRef.current.resolve(input.materialId);
      liveRefreshControllerRef.current?.invalidateAndRefresh();
      return true;
    } catch (error) {
      warehouseRawAdjustmentReplayRef.current.reject(input.materialId, payload, error);
      const deliveryUncertain = isDeliveryUncertain(error);
      showMutationToast(
        'warehouse',
        'warehouse-live-inventory',
        'warehouse-raw-adjust',
        deliveryUncertain ? 'warning' : 'critical',
        deliveryUncertain ? 'Результат корректировки нужно сверить' : 'Остаток не изменён',
        deliveryUncertain
          ? 'Повторите тот же запрос: платформа сохранит идентификатор и не создаст второй факт.'
          : error instanceof Error
            ? error.message
            : 'Повторите попытку.',
      );
      throw error;
    }
  }

  async function receiveLiveWarehouseRawMaterial(input: {
    materialId: string;
    operationKey: string;
    receivedQty: number;
    reason: string;
  }) {
    const request = liveMutationGateRef.current.start(
      `warehouse:raw-receipt:${input.materialId}`,
      () =>
        receiveWarehouseRawMaterial(input.materialId, {
          operationKey: input.operationKey,
          receivedQty: input.receivedQty,
          reason: input.reason,
        }),
    );
    if (!request) return false;

    try {
      await request;
      liveRefreshControllerRef.current?.invalidateAndRefresh();
      return true;
    } catch (error) {
      showMutationToast(
        'warehouse',
        'warehouse-live-inventory',
        'warehouse-raw-receipt',
        'critical',
        'Приход не записан',
        error instanceof Error ? error.message : 'Повторите попытку.',
      );
      return false;
    }
  }

  async function createLiveWarehouseBigBag(input: WarehouseBigBagCreateInput) {
    const selectionKey = `material:${input.baseRawMaterialDefinitionId}`;
    const request = liveMutationGateRef.current.start(
      `warehouse:bigbag-create:${selectionKey}`,
      () => createWarehouseBigBag(input),
    );
    if (!request) return false;

    try {
      const bigBag = await request;
      showMutationToast(
        'warehouse',
        'warehouse-live-inventory',
        'warehouse-bigbag-create',
        'success',
        `Big-Bag ${bigBag.code} создан`,
        `${bigBag.material} · ${bigBag.initialKg ?? input.weightKg} кг. Распечатайте QR-этикетку и подтвердите мешок первым сканированием.`,
      );
      liveRefreshControllerRef.current?.invalidateAndRefresh();
      return true;
    } catch (error) {
      showMutationToast(
        'warehouse',
        'warehouse-live-inventory',
        'warehouse-bigbag-create',
        'critical',
        'Big-Bag не создан',
        error instanceof Error ? error.message : 'Повторите попытку.',
      );
      throw error;
    }
  }

  function applyWarehouseStockMutationDraft(draft: WarehouseStockMutationDraft) {
    const inventoryObject = workObjectsByRole.warehouse.find(
      (object) => object.rawMaterialStocks !== undefined,
    );
    if (!inventoryObject) {
      setNavigationActionOutcome({
        role: 'warehouse',
        tone: 'warning',
        title: 'Сырье не найдено.',
        detail: 'Складская карточка остатков недоступна.',
      });
      return;
    }
    const result = applyWarehouseInventoryMutation(inventoryObject, draft);
    updateRoleObject('warehouse', inventoryObject.id, () => result.object);
    setMutatingNavigationActionOutcome(
      {
        role: 'warehouse',
        objectId: inventoryObject.id,
        tone: result.tone,
        title: result.title,
        detail: result.detail,
      },
      `warehouse-stock-mutation:${draft.materialId}`,
    );
    showMutationToast(
      'warehouse',
      inventoryObject.id,
      `warehouse-stock-mutation:${draft.materialId}`,
      result.tone,
      result.title,
      result.detail,
    );
  }

  function upsertRoleObject(role: Role, object: WorkObject) {
    setWorkObjectsByRole((current) => {
      const exists = current[role].some((item) => item.id === object.id);
      return {
        ...current,
        [role]: exists
          ? current[role].map((item) => (item.id === object.id ? object : item))
          : [object, ...current[role]],
      };
    });
  }

  function upsertRoleObjectWithUpdate(
    role: Role,
    objectId: string,
    createObject: () => WorkObject,
    updater: (object: WorkObject) => WorkObject,
  ) {
    setWorkObjectsByRole((current) => {
      const exists = current[role].some((item) => item.id === objectId);
      return {
        ...current,
        [role]: exists
          ? current[role].map((item) => (item.id === objectId ? updater(item) : item))
          : [updater(createObject()), ...current[role]],
      };
    });
  }

  function setOfficeActionOutcome(
    role: Extract<Role, 'production' | 'finance'>,
    objectId: string,
    outcome: OfficeActionOutcome,
  ) {
    setOfficeActionOutcomes((current) => ({
      ...current,
      [`${role}:${objectId}`]: outcome,
    }));
  }

  function setLiveProductionOrders(orders: WorkObject[]) {
    setWorkObjectsByRole((current) => ({ ...current, production: orders }));
    setSelectedByRole((current) => ({
      ...current,
      production: orders.some((order) => order.id === current.production)
        ? current.production
        : (orders[0]?.id ?? null),
    }));
  }

  async function reloadLiveProductionOrders() {
    const result = await fetchProductionLiveOrdersWithStatus();
    setLiveProductionOrders(result.orders);
    setProductionCommercialActionsState(result.commercialActionsState);
    return result.orders;
  }

  async function reloadLiveProductionProblems() {
    const problems = await fetchProductionProblems();
    setProductionProblems(problems);
    reconcileSelectedProductionProblem(problems);
    return problems;
  }

  async function resolveLiveProductionDefect(problemId: string) {
    const note = 'Фактическая проблема устранена зав. производства.';
    setProductionPlanningBusy(true);
    try {
      const outcome = await commitThenRefresh(
        () => resolveProductionProblem(problemId, { resolution: 'close', note }),
        () => Promise.all([reloadLiveProductionProblems(), reloadLiveProductionOrders()]),
        () => requestLiveRoleRefresh('production'),
      );
      if (!outcome.committed) throw outcome.error;
      showMutationToast(
        'production',
        problemId,
        'production-resolve-defect',
        outcome.refreshed ? 'success' : 'warning',
        'Проблема решена',
        outcome.refreshed
          ? 'Решение записано в историю без изменения учёта рулона и сырья.'
          : 'Решение записано, но экран не обновился. Обновите данные повторно.',
      );
    } catch (error) {
      showMutationToast(
        'production',
        problemId,
        'production-resolve-defect',
        'critical',
        'Решение не записано',
        error instanceof Error ? error.message : 'Решение по браку не записано.',
      );
      throw error;
    } finally {
      setProductionPlanningBusy(false);
    }
  }

  async function resolveLiveProductionGeneral(problemId: string, note: string) {
    setProductionPlanningBusy(true);
    try {
      const outcome = await commitThenRefresh(
        () => resolveProductionProblem(problemId, { resolution: 'close', note }),
        () => Promise.all([reloadLiveProductionProblems(), reloadLiveProductionOrders()]),
        () => requestLiveRoleRefresh('production'),
      );
      if (!outcome.committed) throw outcome.error;
      showMutationToast(
        'production',
        problemId,
        'production-resolve-general',
        outcome.refreshed ? 'success' : 'warning',
        'Проблема закрыта',
        outcome.refreshed
          ? 'Итог решения записан в историю.'
          : 'Решение записано, но экран не обновился. Обновите данные повторно.',
      );
    } catch (error) {
      showMutationToast(
        'production',
        problemId,
        'production-resolve-general',
        'critical',
        'Проблема не закрыта',
        error instanceof Error ? error.message : 'Проблема не закрыта.',
      );
      throw error;
    } finally {
      setProductionPlanningBusy(false);
    }
  }

  function resolveLiveProductionBreakdown(problemId: string, resolution: 'confirm' | 'reject') {
    setProductionPlanningBusy(true);
    void commitThenRefresh(
      () =>
        resolveProductionProblem(problemId, {
          resolution,
          note:
            resolution === 'confirm'
              ? 'Поломка подтверждена зав. производства.'
              : 'Заявка о поломке отклонена зав. производства.',
        }),
      () =>
        Promise.all([
          reloadLiveProductionProblems(),
          refreshLiveProductionPlanning(productionOperatorMachineView?.shift.id),
        ]),
      () => requestLiveRoleRefresh('production'),
    )
      .then((outcome) => {
        if (!outcome.committed) throw outcome.error;
        showMutationToast(
          'production',
          problemId,
          'production-resolve-breakdown',
          outcome.refreshed ? (resolution === 'confirm' ? 'info' : 'success') : 'warning',
          resolution === 'confirm' ? 'Поломка подтверждена' : 'Заявка о поломке отклонена',
          outcome.refreshed
            ? resolution === 'confirm'
              ? 'Заявка остаётся открытой до ремонта станка.'
              : 'Станок возвращён в работу, проблема закрыта.'
            : 'Решение записано, но экран не обновился. Обновите данные повторно.',
        );
      })
      .catch((error: unknown) =>
        showMutationToast(
          'production',
          problemId,
          'production-resolve-breakdown',
          'critical',
          'Решение не записано',
          error instanceof Error ? error.message : 'Решение по поломке не записано.',
        ),
      )
      .finally(() => setProductionPlanningBusy(false));
  }

  async function refreshLiveProductionPlanning(shiftId?: string) {
    const [shifts, posts, operators] = await Promise.all([
      fetchProductionShifts(),
      fetchProductionPosts(),
      fetchProductionOperatorOptions(),
    ]);
    const selectedShift = selectProductionPlanningShift(shifts, shiftId);
    const view = selectedShift ? await fetchProductionOperatorMachines(selectedShift.id) : null;
    selectedProductionShiftIdRef.current = selectedShift?.id ?? null;
    setProductionShifts(shifts);
    setProductionPosts(posts);
    setProductionOperatorOptions(operators);
    setProductionOperatorMachineView(view);
  }

  async function createLiveProductionShift(draft: {
    operatorId: string;
    postId: string;
    label?: string;
  }): Promise<boolean> {
    const intent = `production-individual-shift:${draft.operatorId}:${draft.postId}`;
    let createdShiftId: string | undefined;
    const request = productionPlanningGateRef.current.start(
      intent,
      (operationKey) =>
        commitThenRefresh(
          async () => {
            const result = await createIndividualOperatorShift({ ...draft, operationKey });
            createdShiftId = result.shift.id;
          },
          () => refreshLiveProductionPlanning(createdShiftId),
          () => requestLiveRoleRefresh('production'),
        ),
      'production-individual-shift',
    );
    if (!request) return false;
    setProductionPlanningBusy(true);
    try {
      const outcome = await request;
      if (!outcome.committed) throw outcome.error;
      showMutationToast(
        'production',
        createdShiftId,
        'production-create-shift',
        outcome.refreshed ? 'success' : 'warning',
        'Индивидуальная смена создана',
        outcome.refreshed
          ? 'Оператор и пост назначены одной операцией.'
          : 'Смена создана, но экран не обновился. Обновите данные повторно.',
      );
      return true;
    } catch (error: unknown) {
      showMutationToast(
        'production',
        undefined,
        'production-create-shift',
        'critical',
        'Смена не создана',
        error instanceof Error ? error.message : 'Смена не создана.',
      );
      return false;
    } finally {
      setProductionPlanningBusy(false);
    }
  }

  async function requestLiveIntentionalMachineChange(
    assignmentId: string,
    postId: string,
    reason: string,
  ): Promise<boolean> {
    const shiftId = productionOperatorMachineView?.shift.id;
    const intent = `production-machine-change:${assignmentId}:${postId}:${reason}`;
    const request = productionPlanningGateRef.current.start(
      intent,
      (operationKey) =>
        commitThenRefresh(
          () =>
            requestIntentionalMachineChange(assignmentId, {
              postId,
              reason,
              operationKey,
            }),
          () => refreshLiveProductionPlanning(shiftId),
          () => requestLiveRoleRefresh('operator'),
        ),
      `production-machine-change:${assignmentId}`,
    );
    if (!request) return false;
    setProductionPlanningBusy(true);
    try {
      const outcome = await request;
      if (!outcome.committed) throw outcome.error;
      showMutationToast(
        'production',
        assignmentId,
        'production-machine-change',
        outcome.refreshed ? 'success' : 'warning',
        'Смена станка запущена',
        outcome.refreshed
          ? 'Оператору показан устойчивый сценарий завершения Big-Bag и перехода.'
          : 'Команда записана, но экран не обновился. Обновите данные повторно.',
      );
      return true;
    } catch (error: unknown) {
      showMutationToast(
        'production',
        assignmentId,
        'production-machine-change',
        'critical',
        'Смена станка не запущена',
        error instanceof Error ? error.message : 'Смена станка не запущена.',
      );
      return false;
    } finally {
      setProductionPlanningBusy(false);
    }
  }

  async function cancelLiveProductionAssignment(
    shiftId: string,
    assignmentId: string,
    reason: string,
  ): Promise<boolean> {
    const intent = `production-assignment-cancellation:${shiftId}:${assignmentId}`;
    const request = productionPlanningGateRef.current.start(
      intent,
      (operationKey) =>
        commitThenRefresh(
          () =>
            cancelProductionAssignment(shiftId, assignmentId, {
              operationKey,
              reason,
            }),
          () => Promise.all([refreshLiveProductionPlanning(shiftId), reloadLiveProductionOrders()]),
          () => requestLiveRoleRefresh('production'),
        ),
      `production-assignment-cancellation:${assignmentId}`,
    );
    if (!request) return false;
    setProductionPlanningBusy(true);
    try {
      const outcome = await request;
      if (!outcome.committed) throw outcome.error;
      showMutationToast(
        'production',
        assignmentId,
        'production-assignment-cancellation',
        outcome.refreshed ? 'success' : 'warning',
        'Назначение отменено',
        outcome.refreshed
          ? 'Незапущенные задания освобождены и доступны для нового назначения.'
          : 'Отмена записана, но экран не обновился. Обновите данные повторно.',
      );
      return true;
    } catch (error) {
      showMutationToast(
        'production',
        assignmentId,
        'production-assignment-cancellation',
        'critical',
        'Назначение не отменено',
        error instanceof Error ? error.message : 'Назначение не отменено.',
      );
      return false;
    } finally {
      setProductionPlanningBusy(false);
    }
  }

  async function cancelLiveProductionMachineChange(
    changeId: string,
    reason: string,
  ): Promise<boolean> {
    const shiftId = productionOperatorMachineView?.shift.id;
    const intent = `production-machine-change-cancellation:${changeId}`;
    const request = productionPlanningGateRef.current.start(
      intent,
      (operationKey) =>
        commitThenRefresh(
          () => cancelProductionMachineChange(changeId, { operationKey, reason }),
          () => refreshLiveProductionPlanning(shiftId),
          () => requestLiveRoleRefresh('operator'),
        ),
      `production-machine-change-cancellation:${changeId}`,
    );
    if (!request) return false;
    setProductionPlanningBusy(true);
    try {
      const outcome = await request;
      if (!outcome.committed) throw outcome.error;
      showMutationToast(
        'production',
        changeId,
        'production-machine-change-cancellation',
        outcome.refreshed ? 'success' : 'warning',
        'Смена станка отменена',
        outcome.refreshed
          ? 'Оператор продолжает текущее назначение; очередь и физические факты сохранены.'
          : 'Отмена записана, но экран не обновился. Обновите данные повторно.',
      );
      return true;
    } catch (error) {
      showMutationToast(
        'production',
        changeId,
        'production-machine-change-cancellation',
        'critical',
        'Смена станка не отменена',
        error instanceof Error ? error.message : 'Смена станка не отменена.',
      );
      return false;
    } finally {
      setProductionPlanningBusy(false);
    }
  }

  function finalizeLiveOperatorMachineChange(bigBagId?: string) {
    const change = operatorMachineChange;
    if (!change) return;
    const intent = `operator-machine-change:${change.id}:${bigBagId ?? 'complete'}`;
    const request = physicalOperationGateRef.current.start(
      intent,
      () =>
        commitThenRefresh(
          () =>
            finalizeOperatorMachineChange(change.id, {
              ...(bigBagId ? { bigBagId } : {}),
            }),
          async () => {
            const [runtime, machineChange, bags] = await Promise.all([
              fetchOperatorRuntime(),
              fetchCurrentOperatorMachineChange(),
              fetchOperatorBigBags(),
            ]);
            setOperatorRuntime((current) => reconcileOperatorRuntimeRefresh(current, runtime));
            setOperatorMachineChange(machineChange);
            setOperatorBigBags(bags);
          },
          () => requestLiveRoleRefresh('operator'),
        ),
      `operator-machine-change:${change.id}`,
    );
    if (!request) return;
    setOperatorMachineChangeBusy(true);
    void request
      .then((outcome) => {
        if (!outcome.committed) throw outcome.error;
        showMutationToast(
          'operator',
          change.id,
          'operator-machine-change',
          outcome.refreshed ? 'success' : 'warning',
          bigBagId ? 'Конечный вес Big-Bag записан' : 'Переход на новый станок завершён',
          outcome.refreshed
            ? 'Стабильный вес сохранён, состояние перехода обновлено.'
            : 'Операция записана, но экран не обновился. Обновите данные повторно.',
        );
      })
      .catch((error: unknown) =>
        showMutationToast(
          'operator',
          change.id,
          'operator-machine-change',
          'critical',
          bigBagId ? 'Вес Big-Bag не записан' : 'Переход не завершён',
          error instanceof Error ? error.message : 'Стабильный физический вес не подтверждён.',
        ),
      )
      .finally(() => setOperatorMachineChangeBusy(false));
  }

  async function assignLiveProductionMachine(
    shiftId: string,
    operatorId: string,
    postId: string,
  ): Promise<boolean> {
    setProductionPlanningBusy(true);
    try {
      const outcome = await commitThenRefresh(
        () => assignProductionOperatorMachine(shiftId, operatorId, postId),
        () => refreshLiveProductionPlanning(shiftId),
        () => requestLiveRoleRefresh('production'),
      );
      if (!outcome.committed) throw outcome.error;
      showMutationToast(
        'production',
        operatorId,
        'production-assign-shift-machine',
        outcome.refreshed ? 'success' : 'warning',
        'Станок назначен',
        outcome.refreshed
          ? 'Назначение действует всю смену и блокируется после старта оператора.'
          : 'Назначение сохранено, но экран не обновился. Повторите обновление данных.',
      );
      return true;
    } catch (error: unknown) {
      showMutationToast(
        'production',
        operatorId,
        'production-assign-shift-machine',
        'critical',
        'Станок не назначен',
        error instanceof Error ? error.message : 'Станок не назначен.',
      );
      return false;
    } finally {
      setProductionPlanningBusy(false);
    }
  }

  function breakdownReassignLiveProductionMachine(
    assignmentId: string,
    postId: string,
    reason: string,
  ) {
    const shiftId = productionOperatorMachineView?.shift.id;
    setProductionPlanningBusy(true);
    void commitThenRefresh(
      () => breakdownReassignProductionMachine(assignmentId, postId, reason),
      () => Promise.all([refreshLiveProductionPlanning(shiftId), reloadLiveProductionOrders()]),
      () => requestLiveRoleRefresh('production'),
    )
      .then((outcome) => {
        if (!outcome.committed) {
          showMutationToast(
            'production',
            assignmentId,
            'production-breakdown-reassign',
            'critical',
            'Замена станка не записана',
            outcome.error instanceof Error ? outcome.error.message : 'Не удалось записать замену.',
          );
          return;
        }
        showMutationToast(
          'production',
          assignmentId,
          'production-breakdown-reassign',
          'warning',
          'Станок заменён по поломке',
          outcome.refreshed
            ? 'Причина и перенос незавершённых рулонов записаны в историю.'
            : 'Замена сохранена, но экран не обновился. Повторите обновление данных.',
        );
      })
      .finally(() => setProductionPlanningBusy(false));
  }

  function reportLiveProductionMachineBreakdown(postId: string, reason: string) {
    const shiftId = productionOperatorMachineView?.shift.id;
    setProductionPlanningBusy(true);
    void commitThenRefresh(
      () => reportProductionMachineBreakdown(postId, reason),
      () => Promise.all([refreshLiveProductionPlanning(shiftId), reloadLiveProductionProblems()]),
      () => requestLiveRoleRefresh('production'),
    )
      .then((outcome) => {
        if (!outcome.committed) throw outcome.error;
        showMutationToast(
          'production',
          postId,
          'production-machine-breakdown',
          'warning',
          'Станок помечен сломанным',
          outcome.refreshed
            ? 'Назначения на него запрещены до ремонта. Заявка появилась в проблемах.'
            : 'Поломка записана, но экран не обновился. Повторите обновление данных.',
        );
      })
      .catch((error: unknown) =>
        showMutationToast(
          'production',
          postId,
          'production-machine-breakdown',
          'critical',
          'Поломка не записана',
          error instanceof Error ? error.message : 'Не удалось записать поломку.',
        ),
      )
      .finally(() => setProductionPlanningBusy(false));
  }

  function startLiveProductionMachineRepair(postId: string) {
    const shiftId = productionOperatorMachineView?.shift.id;
    setProductionPlanningBusy(true);
    void commitThenRefresh(
      () => startProductionMachineRepair(postId),
      () => Promise.all([refreshLiveProductionPlanning(shiftId), reloadLiveProductionProblems()]),
      () => requestLiveRoleRefresh('production'),
    )
      .then((outcome) => {
        if (!outcome.committed) throw outcome.error;
        showMutationToast(
          'production',
          postId,
          'production-machine-repair-start',
          outcome.refreshed ? 'info' : 'warning',
          'Станок отправлен в ремонт',
          outcome.refreshed
            ? 'Статус «в ремонте»; вернётся в работу после отметки «Отремонтирован».'
            : 'Ремонт начат, но экран не обновился. Повторите обновление данных.',
        );
      })
      .catch((error: unknown) =>
        showMutationToast(
          'production',
          postId,
          'production-machine-repair-start',
          'critical',
          'Не удалось отправить в ремонт',
          error instanceof Error ? error.message : 'Не удалось начать ремонт.',
        ),
      )
      .finally(() => setProductionPlanningBusy(false));
  }

  function completeLiveProductionMachineRepair(postId: string) {
    const shiftId = productionOperatorMachineView?.shift.id;
    setProductionPlanningBusy(true);
    void commitThenRefresh(
      () => completeProductionMachineRepair(postId),
      () => Promise.all([refreshLiveProductionPlanning(shiftId), reloadLiveProductionProblems()]),
      () => requestLiveRoleRefresh('production'),
    )
      .then((outcome) => {
        if (!outcome.committed) throw outcome.error;
        showMutationToast(
          'production',
          postId,
          'production-machine-repair-done',
          outcome.refreshed ? 'success' : 'warning',
          'Станок отремонтирован',
          outcome.refreshed
            ? 'Станок снова исправен и доступен для назначения. Проблемы поломки закрыты.'
            : 'Ремонт завершён, но экран не обновился. Повторите обновление данных.',
        );
      })
      .catch((error: unknown) =>
        showMutationToast(
          'production',
          postId,
          'production-machine-repair-done',
          'critical',
          'Не удалось завершить ремонт',
          error instanceof Error ? error.message : 'Не удалось завершить ремонт.',
        ),
      )
      .finally(() => setProductionPlanningBusy(false));
  }

  function productionPriorityValue(priority: string) {
    if (priority === 'критично') return 100;
    if (priority === 'срочно') return 50;
    return 0;
  }

  /**
   * Live-назначение по строке рулона из «Заказ-нарядов»: пишет сразу в API
   * (иначе выбор жил только в локальном стейте и стирался рефетчем).
   */
  async function assignLiveProductionRollOperator(rollDispatchItemId: string, operatorId: string) {
    const roll = productionAggregateRolls.find((item) => item.id === rollDispatchItemId);
    const operator = liveProductionOperators.find((item) => item.id === operatorId);
    if (!roll) return false;
    if (!operator) {
      showMutationToast(
        'production',
        roll.productionOrderId,
        'production-assign-roll',
        'warning',
        'Оператор недоступен',
        'Обновите список операторов и повторите назначение.',
      );
      return false;
    }
    const result = await commitThenRefresh(
      () => assignProductionRoll(roll.rollId, { operatorId }),
      reloadLiveProductionOrders,
      () => liveRefreshControllerRef.current?.invalidateAndRefresh(),
    );
    if (!result.committed) {
      showMutationToast(
        'production',
        roll.productionOrderId,
        'production-assign-roll',
        'critical',
        'Назначение не записано',
        result.error instanceof Error ? result.error.message : 'Назначение рулона не записано.',
      );
      return false;
    }
    showMutationToast(
      'production',
      roll.productionOrderId,
      'production-assign-roll',
      result.refreshed ? 'info' : 'warning',
      'Оператор назначен',
      result.refreshed
        ? `${operator.name} · ${roll.rollId}. Полностью назначенный заказ-наряд передаётся оператору автоматически.`
        : 'Назначение сохранено. Список обновится автоматически.',
    );
    return true;
  }

  async function setLiveProductionRollPriority(rollDispatchItemId: string, priority: string) {
    const roll = productionAggregateRolls.find((item) => item.id === rollDispatchItemId);
    if (!roll) return false;
    const result = await commitThenRefresh(
      () => updateProductionRollPriority(roll.rollId, productionPriorityValue(priority)),
      reloadLiveProductionOrders,
      () => liveRefreshControllerRef.current?.invalidateAndRefresh(),
    );
    if (!result.committed) {
      showMutationToast(
        'production',
        roll.productionOrderId,
        'production-roll-priority',
        'critical',
        'Приоритет не записан',
        result.error instanceof Error ? result.error.message : 'Приоритет не записан.',
      );
      return false;
    }
    showMutationToast(
      'production',
      roll.productionOrderId,
      'production-roll-priority',
      result.refreshed ? 'info' : 'warning',
      'Приоритет записан',
      result.refreshed
        ? `${roll.rollId} · ${priority}.`
        : 'Приоритет сохранён. Список обновится автоматически.',
    );
    return true;
  }

  function saveLiveProductionRolls(changes: ProductionRollDraftChange[]) {
    const apiChanges: ProductionRollChange[] = [];
    for (const change of changes) {
      const roll = productionAggregateRolls.find((item) => item.id === change.rollDispatchItemId);
      const operator = liveProductionOperators.find((item) => item.id === change.operatorId);
      if (!roll || !operator) {
        showMutationToast(
          'production',
          roll?.productionOrderId,
          'production-save-rolls',
          'warning',
          'Назначение не записано',
          'Для каждого выбранного рулона нужен доступный оператор.',
        );
        return;
      }
      apiChanges.push({
        rollId: roll.rollId,
        operatorId: operator.id,
        priority: productionPriorityValue(change.priority),
      });
    }

    void commitThenRefresh(
      () => batchUpdateProductionRolls(apiChanges),
      reloadLiveProductionOrders,
      () => requestLiveRoleRefresh('production'),
    ).then((outcome) => {
      if (!outcome.committed) {
        showMutationToast(
          'production',
          apiChanges[0]?.rollId,
          'production-save-rolls',
          'critical',
          'Рулоны не записаны',
          outcome.error instanceof Error ? outcome.error.message : 'Не удалось записать рулоны.',
        );
        return;
      }
      showMutationToast(
        'production',
        apiChanges[0]?.rollId,
        'production-save-rolls',
        outcome.refreshed ? 'success' : 'warning',
        'Рулоны записаны',
        outcome.refreshed
          ? `${apiChanges.length} назначений сохранено. Полностью назначенные заказ-наряды передаются операторам автоматически.`
          : 'Назначения сохранены, но список не обновился. Повторите обновление данных.',
      );
    });
  }

  function moveLiveProductionRoll(rollDispatchItemId: string, direction: 'up' | 'down') {
    const preview = moveProductionRollQueueAcrossObjects(
      workObjectsByRole.production,
      rollDispatchItemId,
      direction,
    );
    if (!preview.moved) return;
    const orderedRollIds = aggregateProductionRollDispatchItems(preview.objects)
      .sort((left, right) => productionRollQueueRank(left) - productionRollQueueRank(right))
      .map((roll) => roll.rollId);
    void commitThenRefresh(
      () => reorderProductionRolls(orderedRollIds, 'ручное изменение общей очереди'),
      reloadLiveProductionOrders,
      () => requestLiveRoleRefresh('production'),
    ).then((outcome) => {
      if (!outcome.committed) {
        showMutationToast(
          'production',
          rollDispatchItemId,
          'production-reorder-rolls',
          'critical',
          'Очередь не изменена',
          outcome.error instanceof Error ? outcome.error.message : 'Не удалось изменить очередь.',
        );
        return;
      }
      showMutationToast(
        'production',
        rollDispatchItemId,
        'production-reorder-rolls',
        outcome.refreshed ? 'info' : 'warning',
        'Очередь изменена',
        outcome.refreshed
          ? 'Новый порядок рулонов сохранён.'
          : 'Порядок сохранён, но список не обновился. Повторите обновление данных.',
      );
    });
  }

  function approveLiveProductionOrder(orderId: string, actionId: string) {
    const request = liveMutationGateRef.current.start(`production:${orderId}:${actionId}`, () =>
      approveProductionOrder(orderId),
    );
    if (!request) return;
    void request
      .then((approvedObject) => {
        setWorkObjectsByRole((current) => ({
          ...current,
          production: current.production.some((object) => object.id === approvedObject.id)
            ? current.production.map((object) =>
                object.id === approvedObject.id ? approvedObject : object,
              )
            : [approvedObject, ...current.production],
        }));
        setSelectedByRole((current) => ({ ...current, production: approvedObject.id }));

        setMutatingOfficeActionOutcome('production', approvedObject.id, actionId, {
          tone: 'success',
          title: 'Согласовано.',
          detail: 'Рулоны опубликованы операторам. Финансовый этап уже был завершён ранее.',
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ProductionApprovalReconciliationError) {
          requestLiveRoleRefresh('production');
          setOfficeActionOutcome('production', orderId, {
            tone: 'warning',
            title: error.committed
              ? 'Согласование записано, но список не обновился.'
              : 'Результат согласования нужно сверить.',
            detail: error.committed
              ? 'Не отправляйте согласование повторно. Обновите список производственных заказов.'
              : 'Запрос мог быть записан. Обновите список перед повтором.',
          });
          return;
        }
        setOfficeActionOutcome('production', orderId, {
          tone: 'warning',
          title: 'Согласование не записано.',
          detail: error instanceof Error ? error.message : 'Согласование не записано.',
        });
      });
  }

  function approveLiveProductionTechnicalCover(commercialOrderId: string, actionId: string) {
    const request = liveMutationGateRef.current.start(
      `production:${commercialOrderId}:${actionId}`,
      () => approveProductionTechnicalCover(commercialOrderId),
    );
    if (!request) return;
    void request
      .then(({ approvedProposalIds }) => {
        setMutatingOfficeActionOutcome('production', commercialOrderId, actionId, {
          tone: 'success',
          title: 'Возможность выпуска подтверждена.',
          detail:
            approvedProposalIds.length > 0
              ? `${approvedProposalIds.length} предложений подтверждено. Очередь обновляется.`
              : 'Актуальных предложений уже нет. Очередь обновляется.',
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ProductionTechnicalCoverReconciliationError) {
          requestLiveRoleRefresh('production');
          const confirmed = error.approvedProposalIds.length;
          const notSent = error.unattemptedProposalIds.length;
          setOfficeActionOutcome('production', commercialOrderId, {
            tone: 'warning',
            title: 'Результат подтверждения нужно сверить.',
            detail: `${confirmed > 0 ? `${confirmed} предложений подтверждено. ` : ''}Следующее предложение могло быть записано; ${notSent > 0 ? `${notSent} ещё не отправлялись. ` : ''}Обновите список перед повтором.`,
          });
          return;
        }
        setOfficeActionOutcome('production', commercialOrderId, {
          tone: 'critical',
          title: 'Возможность выпуска не подтверждена.',
          detail: error instanceof Error ? error.message : 'Действие не записано.',
        });
      });
  }

  function approveLiveProductionHubOrder(orderId: string, actionId: string) {
    const action = getWorkObjectAction('production', actionId);
    if (action.kind === 'productionApproveTechnicalCover') {
      approveLiveProductionTechnicalCover(action.targetId ?? orderId, actionId);
      return;
    }
    approveLiveProductionOrder(orderId, actionId);
  }

  function openDetailTarget(selector: string) {
    window.requestAnimationFrame(() => {
      const inlineDetails = document.querySelector<HTMLDetailsElement>('.inline-context-details');
      const auditDetails = document.querySelector<HTMLDetailsElement>('.audit-details');
      if (selector === '.audit-details') {
        if (inlineDetails) inlineDetails.open = true;
        if (auditDetails) auditDetails.open = true;
      }
      const target = document.querySelector<HTMLElement>(selector);
      const scrollParent = target?.closest<HTMLElement>('.detail-panel, .list-panel');
      if (target && scrollParent) {
        const top =
          target.getBoundingClientRect().top -
          scrollParent.getBoundingClientRect().top +
          scrollParent.scrollTop -
          12;
        scrollParent.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
      } else {
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
  }

  function openTemplateEditor(mode: TemplateEditorMode, templateId?: string) {
    const templateItem = templateId ? templateCatalog.find((item) => item.id === templateId) : null;
    const blankPosition = createIntakeDraftPosition(1);
    const positions = templateItem
      ? applyTemplateToIntakeDraft(
          { ...defaultIntakeDraft, templateId: undefined, positions: [blankPosition] },
          templateItem,
          templateVersions,
          templateDraftPositions[templateItem.id],
          materialRecipeCatalog.status === 'ready'
            ? {
                materials: materialRecipeCatalog.materials,
                recipes: materialRecipeCatalog.recipes,
              }
            : undefined,
        ).positions
      : [blankPosition];
    setTemplateEditor({
      mode,
      counterpartyId: templateItem?.counterpartyId ?? selectedCounterpartyId,
      templateId: templateItem?.id,
      sourceTemplateName: templateItem?.name,
      name:
        mode === 'duplicate' && templateItem
          ? `${templateItem.name} · копия`
          : (templateItem?.name ?? ''),
      ownerRole: 'Зав. производства',
      reason: '',
      positions: positions.map((position, index) => ({
        ...position,
        id:
          mode === 'duplicate'
            ? `template-copy-${Date.now()}-${index + 1}`
            : position.id,
      })),
    });
  }

  function autosaveTemplateSafeField(key: 'name' | 'ownerRole', value: string) {
    setTemplateEditor((current) => (current ? { ...current, [key]: value } : current));
    if (isLiveProductionTemplateDirectory) return;
    if (templateEditor?.templateId && templateEditor.mode === 'edit') {
      setTemplateCatalog((current) =>
        current.map((templateItem) =>
          templateItem.id === templateEditor.templateId
            ? {
                ...templateItem,
                [key]: value,
                updatedAt: '2026-06-08',
              }
            : templateItem,
        ),
      );
    }
  }

  async function saveTemplateEditor() {
    const editor = templateEditor;
    if (!editor) return;
    const invalidPositionIndex = editor.positions.findIndex(
      (position) => intakePositionMissingFields(position).length > 0,
    );
    const unavailableMaterialIndex = editor.positions.findIndex(
      (position) =>
        !isCommercialMaterialSelectionAvailable(
          position,
          materialRecipeCatalog.materials,
          materialRecipeCatalog.recipes,
        ),
    );
    if (
      editor.positions.length === 0 ||
      editor.positions.length > 100 ||
      invalidPositionIndex >= 0 ||
      materialRecipeCatalog.status !== 'ready' ||
      unavailableMaterialIndex >= 0 ||
      (editor.mode === 'edit' &&
        !isLiveProductionTemplateDirectory &&
        !editor.reason.trim())
    ) {
      return;
    }

    const templateId =
      editor.mode === 'edit' && editor.templateId ? editor.templateId : `tpl-custom-${Date.now()}`;
    const versionId = `tplv-custom-${Date.now()}`;
    const versionLabel =
      editor.mode === 'edit'
        ? `v${templateVersions.filter((version) => version.templateId === templateId).length + 1}.0`
        : 'v1.0';
    const generatedName = templateNameFromPositions(editor.positions);
    const fields = templateFieldsFromPositions(editor.positions);
    const nextTemplate: CounterpartyOrderTemplate = {
      id: templateId,
      counterpartyId: editor.counterpartyId,
      name: editor.name.trim() || generatedName,
      activeVersionId: versionId,
      status: 'active',
      ownerRole: editor.ownerRole,
      usageCount:
        editor.mode === 'duplicate'
          ? 0
          : (templateCatalog.find((item) => item.id === templateId)?.usageCount ?? 0),
      lastUsedAt:
        editor.mode === 'duplicate'
          ? 'еще не применялся'
          : (templateCatalog.find((item) => item.id === templateId)?.lastUsedAt ??
            'еще не применялся'),
      updatedAt: '2026-06-08',
    };
    const nextVersion: CounterpartyOrderTemplateVersion = {
      id: versionId,
      templateId,
      version: versionLabel,
      fields,
      reason:
        editor.reason ||
        (editor.mode === 'duplicate'
          ? `Копия шаблона ${editor.sourceTemplateName}`
          : 'Создан новый шаблон'),
      createdBy: 'Зав. производства',
      createdAt: '2026-06-08',
      affectsProduction: true,
      affectsMoney: false,
    };
    let templatesToMerge = [nextTemplate];
    let versionsToMerge = [nextVersion];
    let savedTemplateId = templateId;
    let savedVersionLabel = versionLabel;
    let draftPositionsToMerge = { [templateId]: editor.positions };

    if (isLiveProductionTemplateDirectory && editor.mode === 'edit' && editor.templateId) {
      try {
        const saved = await updateCounterpartyTemplateFromFields(
          editor.counterpartyId,
          editor.templateId,
          nextTemplate.name,
          editor.positions,
        );
        templatesToMerge = saved.templates.length > 0 ? saved.templates : templatesToMerge;
        versionsToMerge = saved.versions.length > 0 ? saved.versions : versionsToMerge;
        savedTemplateId = templatesToMerge[0]?.id ?? savedTemplateId;
        savedVersionLabel = versionsToMerge[0]?.version ?? savedVersionLabel;
        draftPositionsToMerge = saved.draftPositions;
      } catch (error) {
        showMutationToast(
          'production',
          editor.templateId,
          'template:save',
          'critical',
          'Шаблон не сохранен',
          error instanceof Error ? error.message : 'Не удалось обновить шаблон.',
        );
        return;
      }
    } else if (isLiveProductionTemplateDirectory && editor.mode !== 'edit') {
      try {
        const saved = await createCounterpartyTemplateFromFields(
          editor.counterpartyId,
          nextTemplate.name,
          editor.positions,
        );
        templatesToMerge = saved.templates.length > 0 ? saved.templates : templatesToMerge;
        versionsToMerge = saved.versions.length > 0 ? saved.versions : versionsToMerge;
        savedTemplateId = templatesToMerge[0]?.id ?? savedTemplateId;
        savedVersionLabel = versionsToMerge[0]?.version ?? savedVersionLabel;
        draftPositionsToMerge = saved.draftPositions;
      } catch (error) {
        showMutationToast(
          'production',
          undefined,
          'template:save',
          'critical',
          'Шаблон не создан',
          error instanceof Error ? error.message : 'Не удалось сохранить шаблон.',
        );
        return;
      }
    }

    setTemplateCatalog((current) => mergeCounterpartyTemplates(current, templatesToMerge));
    setTemplateVersions((current) => mergeCounterpartyTemplateVersions(current, versionsToMerge));
    setTemplateDraftPositions((current) => ({ ...current, ...draftPositionsToMerge }));
    setSelectedCounterpartyId(editor.counterpartyId);
    setTemplateEditor(null);
    if (isLiveProductionTemplateDirectory) {
      setProductionTemplateReloadGeneration((current) => current + 1);
    }
    showMutationToast(
      'production',
      savedTemplateId,
      'template:save',
      'success',
      editor.mode === 'edit' ? 'Шаблон сохранен' : 'Шаблон создан',
      `Версия ${savedVersionLabel} записана.`,
    );
  }

  async function updateTemplateLifecycle(templateId: string, status: 'active' | 'archived') {
    const templateItem = templateCatalog.find((item) => item.id === templateId);
    if (!templateItem) return;
    if (isLiveProductionTemplateDirectory) {
      try {
        const saved = await updateCounterpartyTemplateStatus(
          templateItem.counterpartyId,
          templateId,
          status,
        );
        setTemplateCatalog((current) => mergeCounterpartyTemplates(current, saved.templates));
        setTemplateVersions((current) =>
          mergeCounterpartyTemplateVersions(current, saved.versions),
        );
        setTemplateDraftPositions((current) => ({ ...current, ...saved.draftPositions }));
      } catch (error) {
        showMutationToast(
          'production',
          templateId,
          'template:lifecycle',
          'critical',
          status === 'archived' ? 'Шаблон не архивирован' : 'Шаблон не активирован',
          error instanceof Error ? error.message : 'Не удалось изменить статус шаблона.',
        );
        return;
      }
    } else {
      setTemplateCatalog((current) =>
        current.map((item) => (item.id === templateId ? { ...item, status } : item)),
      );
    }
    if (status === 'archived' && templateEditor?.templateId === templateId) {
      setTemplateEditor(null);
    }
    showMutationToast(
      'production',
      templateId,
      'template:lifecycle',
      'success',
      status === 'archived' ? 'Шаблон архивирован' : 'Шаблон активирован',
      'Статус шаблона записан.',
    );
  }

  function archiveTemplate(templateId: string) {
    void updateTemplateLifecycle(templateId, 'archived');
  }

  function activateTemplate(templateId: string) {
    void updateTemplateLifecycle(templateId, 'active');
  }

  function openIntakeModal(creatorRole: typeof intakeCreatorRole, trigger: HTMLElement) {
    intakeOpenTriggerRef.current = trigger;
    setIntakeCreatorRole(creatorRole);
    setIntakeDraft((current) =>
      refreshIntakeDraftFromSelectedTemplate(
        current,
        templateCatalog,
        templateVersions,
        templateDraftPositions,
        materialRecipeCatalog.status === 'ready'
          ? {
              materials: materialRecipeCatalog.materials,
              recipes: materialRecipeCatalog.recipes,
            }
          : undefined,
      ),
    );
    setIntakeDraftOnly(
      creatorRole === 'commercial' && activeSectionByRole.commercial === 'Черновики',
    );
    setIntakeDrawerOpen(true);
  }

  function invalidateProductionIntakeCatalogRequests() {
    const request = productionIntakeCatalogRequestRef.current;
    request.generation += 1;
    request.opening = false;
    request.retrying = false;
    request.openController?.abort();
    request.retryController?.abort();
    request.openController = null;
    request.retryController = null;
  }

  function applyProductionIntakeCatalog(
    safeCounterparties: Counterparty[],
    payload: Awaited<ReturnType<typeof fetchCounterpartyTemplates>>,
  ) {
    const templateIdsByCounterparty = new Map<string, string[]>();
    for (const template of payload.templates) {
      const ids = templateIdsByCounterparty.get(template.counterpartyId) ?? [];
      ids.push(template.id);
      templateIdsByCounterparty.set(template.counterpartyId, ids);
    }
    setProductionIntakeCounterparties(
      safeCounterparties.map((counterparty) => ({
        ...counterparty,
        templateIds: templateIdsByCounterparty.get(counterparty.id) ?? [],
      })),
    );
    setProductionIntakeTemplates(payload.templates);
    setProductionIntakeTemplateVersions(payload.versions);
    setProductionIntakeDraftPositions(payload.draftPositions);
  }

  async function openLiveProductionIntakeModal(trigger: HTMLElement) {
    const request = productionIntakeCatalogRequestRef.current;
    if (request.opening) return;
    request.opening = true;
    request.retryController?.abort();
    request.retryController = null;
    request.retrying = false;
    const generation = request.generation + 1;
    request.generation = generation;
    const controller = new AbortController();
    request.openController = controller;
    setProductionTemplateLoadState('loading');
    setProductionTemplateLoadError(null);
    setProductionIntakeTemplateWarning(null);
    try {
      const page = await searchCommercialCounterparties(
        { limit: 20 },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || request.generation !== generation) return;
      const safeCounterparties = productionCounterpartiesFromServer(page.items);
      let payload: Awaited<ReturnType<typeof fetchCounterpartyTemplates>> = {
        templates: [],
        versions: [],
        draftPositions: {},
      };
      let templateWarning: string | null = null;
      try {
        payload = await fetchCounterpartyTemplates(
          safeCounterparties.map((counterparty) => counterparty.id),
          { signal: controller.signal },
        );
      } catch (error) {
        if (
          controller.signal.aborted ||
          request.generation !== generation ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          return;
        }
        templateWarning = 'Шаблоны временно недоступны. Заявку можно создать вручную без шаблона.';
      }
      if (controller.signal.aborted || request.generation !== generation) return;
      applyProductionIntakeCatalog(safeCounterparties, payload);
      setProductionIntakeTemplateWarning(templateWarning);
      setProductionTemplateLoadState('ready');
      intakeOpenTriggerRef.current = trigger;
      setIntakeCreatorRole('production_lead');
      setIntakeDraft(createEmptyCommercialIntakeDraft());
      setIntakeDraftOnly(false);
      setIntakeDrawerOpen(true);
    } catch (error) {
      if (
        controller.signal.aborted ||
        request.generation !== generation ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return;
      }
      setProductionIntakeCounterparties([]);
      setProductionIntakeTemplates([]);
      setProductionIntakeTemplateVersions([]);
      setProductionIntakeDraftPositions({});
      setProductionIntakeTemplateWarning(null);
      setProductionTemplateLoadState('error');
      setProductionTemplateLoadError('Не удалось загрузить справочник контрагентов.');
      showMutationToast(
        'production',
        undefined,
        'production:intake-catalog',
        'critical',
        'Форма заявки недоступна',
        error instanceof Error ? error.message : 'Повторите загрузку каталога.',
      );
    } finally {
      if (request.generation === generation) {
        request.opening = false;
        request.openController = null;
      }
    }
  }

  async function retryLiveProductionIntakeTemplates() {
    const request = productionIntakeCatalogRequestRef.current;
    if (request.retrying || !isIntakeDrawerOpen || intakeCreatorRole !== 'production_lead') return;
    request.retrying = true;
    const generation = request.generation;
    const controller = new AbortController();
    request.retryController = controller;
    setProductionIntakeTemplateRetrying(true);
    try {
      const payload = await fetchCounterpartyTemplates(
        productionIntakeCounterparties.map((counterparty) => counterparty.id),
        { signal: controller.signal },
      );
      if (controller.signal.aborted || request.generation !== generation) return;
      applyProductionIntakeCatalog(productionIntakeCounterparties, payload);
      setProductionIntakeTemplateWarning(null);
    } catch (error) {
      if (
        controller.signal.aborted ||
        request.generation !== generation ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return;
      }
      setProductionIntakeTemplateWarning(
        'Шаблоны временно недоступны. Заявку можно создать вручную без шаблона.',
      );
    } finally {
      if (request.generation === generation) {
        request.retrying = false;
        request.retryController = null;
        setProductionIntakeTemplateRetrying(false);
      }
    }
  }

  function closeIntakeModal() {
    invalidateProductionIntakeCatalogRequests();
    setIntakeRecipeEditorPositionId(null);
    setIntakeDrawerOpen(false);
    setIntakeDraftOnly(false);
    setProductionIntakeCounterparties([]);
    setProductionIntakeTemplates([]);
    setProductionIntakeTemplateVersions([]);
    setProductionIntakeDraftPositions({});
    setProductionIntakeTemplateWarning(null);
    setProductionIntakeTemplateRetrying(false);
  }

  function updateIntakeDraft(next: IntakeDraftForm) {
    setIntakeMaterialSelectionInvalidPositionIds((current) => {
      if (current.size === 0) return current;
      const remaining = new Set(current);
      for (const position of next.positions) {
        const previous = intakeDraft.positions.find((item) => item.id === position.id);
        if (
          previous &&
          (previous.baseRawMaterialDefinitionId !== position.baseRawMaterialDefinitionId ||
            previous.recipeDefinitionVersionId !== position.recipeDefinitionVersionId)
        ) {
          remaining.delete(position.id);
        }
      }
      return remaining;
    });
    setIntakeDraft(next);
  }

  function selectCreatedRecipeForIntake(
    recipe: Awaited<ReturnType<typeof materialRecipeCatalog.createRecipe>>,
  ) {
    if (!intakeRecipeEditorPositionId) return;
    const positionId = intakeRecipeEditorPositionId;
    setIntakeDraft((current) =>
      applyCreatedRecipeToIntakeDraft(
        current,
        positionId,
        recipe,
        materialRecipeCatalog.materials,
        materialRecipeCatalog.recipes,
      ),
    );
    setIntakeMaterialSelectionInvalidPositionIds((current) => {
      const next = new Set(current);
      next.delete(positionId);
      return next;
    });
  }

  function handleIntakeDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || isEventFromNestedDialog(event.currentTarget, event.target)) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeIntakeModal();
      return;
    }

    trapFocusWithin(event);
  }

  async function submitIntake(mode: IntakeSubmitMode) {
    const effectiveMode: IntakeSubmitMode =
      intakeCreatorRole === 'production_lead'
        ? 'order'
        : intakeDraftOnly && mode === 'order'
          ? 'draft'
          : mode;
    if (isCommercialLive) {
      if (intakeSubmissionPendingRef.current) return;
      intakeSubmissionPendingRef.current = true;
      setIntakeSubmitting(true);
      try {
        const commercialObject = await createCommercialOrderFromDraft(
          intakeDraft,
          intakeCreatorRole,
          effectiveMode === 'draft' ? 'draft' : 'submit',
          intakeClientRequestId,
          'client_order',
        );
        let detailReconciliationFailed = false;
        if (intakeCreatorRole === 'production_lead') {
          try {
            await fetchCommercialOrderDetail(commercialObject.id);
          } catch {
            detailReconciliationFailed = true;
          }
        }
        setWorkObjectsByRole((current) => ({
          ...current,
          commercial: [
            commercialObject,
            ...current.commercial.filter((object) => object.id !== commercialObject.id),
          ],
        }));
        setSelectedByRole((current) => ({
          ...current,
          commercial: commercialObject.id,
        }));
        setActiveSectionByRole((current) => ({
          ...current,
          commercial: effectiveMode === 'draft' ? 'Черновики' : 'Входящие заявки',
        }));
        requestLiveRoleRefresh(
          intakeCreatorRole === 'production_lead' ? 'production' : 'commercial',
        );
        showMutationToast(
          intakeCreatorRole === 'production_lead' ? 'production' : 'commercial',
          commercialObject.id,
          `intake:${effectiveMode}`,
          detailReconciliationFailed ? 'warning' : 'success',
          effectiveMode === 'draft' ? 'Черновик сохранен' : 'Заявка создана',
          detailReconciliationFailed
            ? `Заявка ${commercialObject.id} создана, но карточка не обновилась. Повторите обновление данных.`
            : effectiveMode === 'draft'
              ? 'Черновик сохранён во вкладке «Черновики».'
              : 'Заявка принята и сохранена во входящих.',
        );
        setIntakeDrawerOpen(false);
        setIntakeDraftOnly(false);
        setProductionIntakeCounterparties([]);
        setProductionIntakeTemplates([]);
        setProductionIntakeTemplateVersions([]);
        setProductionIntakeDraftPositions({});
        setIntakeCreatorRole('commercial');
        setIntakeDraft(defaultIntakeDraft);
        setIntakeClientRequestId(createClientRequestId());
        setIntakeMaterialSelectionInvalidPositionIds(new Set());
      } catch (error) {
        const catalogStale = isCommercialOrderCatalogStaleError(error);
        if (catalogStale) {
          await materialRecipeCatalog.reload();
          setIntakeMaterialSelectionInvalidPositionIds(
            new Set(intakeDraft.positions.map((position) => position.id)),
          );
        }
        showMutationToast(
          intakeCreatorRole === 'production_lead' ? 'production' : 'commercial',
          undefined,
          `intake:${effectiveMode}`,
          'critical',
          'Заявка не создана',
          catalogStale
            ? COMMERCIAL_ORDER_CATALOG_STALE_MESSAGE
            : error instanceof Error
              ? error.message
              : 'Заявка не создана.',
        );
      } finally {
        intakeSubmissionPendingRef.current = false;
        setIntakeSubmitting(false);
      }
      return;
    }

    const commercialObject = createCommercialObject(intakeDraft, effectiveMode, intakeCreatorRole);
    const productionObject =
      effectiveMode === 'draft'
        ? null
        : productionFromIntake(
            commercialObject,
            intakeCreatorRole === 'production_lead' ? 'incomplete' : 'waiting',
          );
    setWorkObjectsByRole((current) => ({
      ...current,
      commercial: [commercialObject, ...current.commercial],
      production: productionObject ? [productionObject, ...current.production] : current.production,
    }));
    setSelectedByRole((current) => ({
      ...current,
      commercial: commercialObject.id,
      production: productionObject?.id ?? current.production,
    }));
    setActiveSectionByRole((current) => ({
      ...current,
      commercial: effectiveMode === 'draft' ? 'Черновики' : 'Входящие заявки',
    }));
    if (productionObject) {
      dispatchRuntimeAction({
        type: 'commercial.intake.delegated',
        objectId: commercialObject.id,
        counterpartyLabel:
          factValue(commercialObject, 'Контрагент') ?? intakeCounterpartyLabel(intakeDraft),
        positionsLabel:
          factValue(commercialObject, 'Позиции') ?? intakePositionSummary(intakeDraft),
        status: 'transferred',
      });
      notifyRole(
        'production',
        productionObject.id,
        productionObject.statusLabel,
        intakeCreatorRole === 'production_lead'
          ? 'Заявка создана зав. производства: оператор и приоритет уже заданы, оплату здесь не меняем.'
          : 'Коммерция создала заявку: нужно оформить недостающую часть до счета.',
        'warning',
      );
    }
    showMutationToast(
      intakeCreatorRole === 'production_lead' ? 'production' : 'commercial',
      commercialObject.id,
      `intake:${effectiveMode}`,
      effectiveMode === 'draft' ? 'info' : 'success',
      effectiveMode === 'draft' ? 'Черновик сохранен' : 'Заявка создана',
      productionObject ? 'Зав. производства получил строку.' : 'Заявка осталась в черновиках.',
    );
    setIntakeDrawerOpen(false);
    setIntakeDraftOnly(false);
    setIntakeCreatorRole('commercial');
    setIntakeDraft(defaultIntakeDraft);
  }

  function assignAdminRole() {
    const email = roleAssignmentDraft.email.trim().toLowerCase();
    const template = adminRoleTemplates.find(
      (item) => item.id === roleAssignmentDraft.roleTemplateId,
    );
    if (!email || !template) return;

    const nextEntry: UserAccessEntry = {
      id: `access-${email.replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
      email,
      name: email.split('@')[0] || 'Новый пользователь',
      status: 'active',
      roleTemplateId: template.id,
      assignedAt: stampNow(),
      assignedBy: 'Администратор',
    };
    const nextObject = createAdminAccessObject(nextEntry, adminRoleTemplates);

    setAdminUsers((current) => {
      const exists = current.some((entry) => entry.email.toLowerCase() === email);
      return exists
        ? current.map((entry) => (entry.email.toLowerCase() === email ? nextEntry : entry))
        : [nextEntry, ...current];
    });
    setWorkObjectsByRole((current) => {
      const withoutSameEmail = current.admin.filter(
        (object) => factValue(object, 'Email')?.toLowerCase() !== email,
      );
      return { ...current, admin: [nextObject, ...withoutSameEmail] };
    });
    setAdminHistory((current) => [
      {
        id: `admin-history-access-${Date.now()}`,
        time: stampNow(),
        actor: 'Администратор',
        action: 'Шаблон роли назначен',
        target: email,
        detail: `${template.name}; доступ выдан на email.`,
      },
      ...current,
    ]);
    setSelectedByRole((current) => ({ ...current, admin: nextObject.id }));
    setRoleAssignmentDraft({ ...defaultRoleAssignmentDraft, roleTemplateId: template.id });
    showMutationToast(
      'admin',
      nextObject.id,
      'admin:assign-role',
      'success',
      'Доступ выдан',
      `${email}: назначен шаблон роли.`,
    );
  }

  function saveAdminUserAccess(entry: UserAccessEntry) {
    const template = adminRoleTemplates.find((item) => item.id === entry.roleTemplateId);
    if (!template) return;
    const nextEntry: UserAccessEntry = {
      ...entry,
      status: 'active',
      extraCapabilities: [...(entry.extraCapabilities ?? [])],
      assignedAt: stampNow(),
      assignedBy: 'Администратор',
    };
    const nextObject = createAdminAccessObject(nextEntry, adminRoleTemplates);

    setAdminUsers((current) => current.map((item) => (item.id === entry.id ? nextEntry : item)));
    setWorkObjectsByRole((current) => {
      const withoutEntry = current.admin.filter(
        (object) => factValue(object, 'Email')?.toLowerCase() !== entry.email.toLowerCase(),
      );
      return { ...current, admin: [nextObject, ...withoutEntry] };
    });
    setAdminHistory((current) => [
      {
        id: `admin-history-access-edit-${entry.id}-${Date.now()}`,
        time: stampNow(),
        actor: 'Администратор',
        action: 'Доступ изменен',
        target: entry.email,
        detail: `${template.name}; индивидуальных прав: ${nextEntry.extraCapabilities?.length ?? 0}.`,
      },
      ...current,
    ]);
    showMutationToast(
      'admin',
      nextObject.id,
      'admin:edit-access',
      'success',
      'Доступ изменен',
      `${entry.email}: обновлены шаблон и индивидуальные права.`,
    );
  }

  function revokeAdminUserAccess(entry: UserAccessEntry) {
    const nextEntry: UserAccessEntry = {
      ...entry,
      status: 'blocked',
      extraCapabilities: [...(entry.extraCapabilities ?? [])],
      assignedAt: stampNow(),
      assignedBy: 'Администратор',
    };
    const nextObject = createAdminAccessObject(nextEntry, adminRoleTemplates);

    setAdminUsers((current) => current.map((item) => (item.id === entry.id ? nextEntry : item)));
    setWorkObjectsByRole((current) => {
      const withoutEntry = current.admin.filter(
        (object) => factValue(object, 'Email')?.toLowerCase() !== entry.email.toLowerCase(),
      );
      return { ...current, admin: [nextObject, ...withoutEntry] };
    });
    setAdminHistory((current) => [
      {
        id: `admin-history-access-revoke-${entry.id}-${Date.now()}`,
        time: stampNow(),
        actor: 'Администратор',
        action: 'Доступ отозван',
        target: entry.email,
        detail: 'Сотрудник больше не может входить по шаблону роли.',
      },
      ...current,
    ]);
    showMutationToast(
      'admin',
      nextObject.id,
      'admin:revoke-access',
      'warning',
      'Доступ отозван',
      entry.email,
    );
  }

  function saveAdminRoleTemplate(template: RoleTemplate) {
    const isNewTemplate = !adminRoleTemplates.some((item) => item.id === template.id);
    setAdminRoleTemplates((current) => {
      const exists = current.some((item) => item.id === template.id);
      const nextTemplate = {
        ...template,
        visibleSections: [...template.visibleSections],
        hiddenScopes: [...template.hiddenScopes],
        capabilities: [...template.capabilities],
        allowedActions: [...template.allowedActions],
      };
      return exists
        ? current.map((item) => (item.id === template.id ? nextTemplate : item))
        : [nextTemplate, ...current];
    });
    setAdminHistory((current) => [
      {
        id: `admin-history-template-${template.id}-${Date.now()}`,
        time: stampNow(),
        actor: 'Администратор',
        action: isNewTemplate ? 'Черновик шаблона создан' : 'Шаблон роли сохранен',
        target: template.name,
        detail: `Разделы: ${template.visibleSections.join(', ')}. Скрыто: ${template.hiddenScopes.length > 0 ? template.hiddenScopes.join(', ') : 'нет'}.`,
      },
      ...current,
    ]);
    showMutationToast(
      'admin',
      template.id,
      `admin-template-save-${template.id}`,
      'success',
      isNewTemplate ? 'Черновик создан' : 'Шаблон сохранен',
      isNewTemplate
        ? 'Новый шаблон добавлен в матрицу доступа.'
        : 'Изменение записано в истории админа.',
    );
  }

  function saveAdminDevice(mode: 'create' | 'edit', device: DeviceMockContract) {
    dispatchRuntimeAction({
      type: mode === 'create' ? 'admin.device.created' : 'admin.device.updated',
      device,
    });
    const isSource = device.kind === 'financeSource';
    setAdminHistory((current) => [
      {
        id: `admin-history-device-${mode}-${device.id}-${Date.now()}`,
        time: stampNow(),
        actor: 'Администратор',
        action:
          mode === 'create'
            ? isSource
              ? 'Источник добавлен'
              : 'Устройство добавлено'
            : isSource
              ? 'Источник изменен'
              : 'Устройство изменено',
        target: device.label || device.id,
        detail: `${device.ownerRole}; ${device.status}; ${device.workplaceId || 'контур не задан'}.`,
      },
      ...current,
    ]);
    setSelectedByRole((current) => ({ ...current, admin: `ADM-DEVICE-${device.id}` }));
    showMutationToast(
      'admin',
      `ADM-DEVICE-${device.id}`,
      `admin-device-${mode}-${device.id}`,
      'success',
      mode === 'create' ? 'Запись добавлена' : 'Запись сохранена',
      isSource
        ? 'Учётный источник сохранен как диагностическая запись.'
        : 'Устройство сохранено как диагностическая запись.',
    );
  }

  function testAdminDevice(deviceId: string) {
    dispatchRuntimeAction({ type: 'admin.device.tested', deviceId });
    setSelectedByRole((current) => ({ ...current, admin: `ADM-DEVICE-${deviceId}` }));
    showMutationToast(
      'admin',
      `ADM-DEVICE-${deviceId}`,
      `admin-device-test-${deviceId}`,
      'success',
      'Диагностика записана',
      'Проверка не выполняет производственное действие.',
    );
  }

  function directorOverrideReason(
    actionId: string,
    object: WorkObject,
    title: string,
    details: Array<{ label: string; value: string }>,
  ) {
    const inlineReason = actionInlineReason(actionId);
    if (inlineReason !== null) {
      const normalizedInlineReason = inlineReason.trim();
      if (!normalizedInlineReason) {
        setNavigationActionOutcome({
          role: 'director',
          objectId: object.id,
          tone: 'warning',
          title: 'Причина обязательна.',
          detail: 'Директорское решение не записано без причины.',
        });
        return null;
      }
      return normalizedInlineReason;
    }

    const reasonKey = `input:director:${object.id}:${actionId}`;
    const reason = actionConfirmationInputRef.current[reasonKey];
    if (reason === undefined) {
      setActionConfirmation({
        eyebrow: 'Директор',
        title,
        objectTitle: object.title,
        message:
          'Директорское решение требует причину и подтверждение. Рабочий контур остается у ответственной роли.',
        tone: 'warning',
        confirmLabel: 'Записать решение',
        details: [
          ...details,
          { label: 'Граница', value: 'Не выполняет рабочее действие другой роли' },
        ],
        input: {
          label: 'Причина и подтверждение',
          placeholder:
            'Например: подтверждаю исключение по выбранной карточке, срок и сумма проверены',
          requiredMessage: 'Причина и подтверждение обязательны.',
        },
        onConfirm: (value) => {
          actionConfirmationInputRef.current[reasonKey] = value ?? '';
          setActionConfirmation(null);
          window.requestAnimationFrame(() => applyDirectorAction(actionId, object));
        },
      });
      return null;
    }
    delete actionConfirmationInputRef.current[reasonKey];
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: 'warning',
        title: 'Причина обязательна.',
        detail: 'Директорское решение не записано без причины и подтверждения.',
      });
      return null;
    }
    return normalizedReason;
  }

  function applyDirectorAssignment(
    actionId: string,
    object: WorkObject,
    candidateValue: string | undefined,
    reason: string,
  ) {
    const candidate = directorAssignmentCandidate(candidateValue);
    const normalized = actionId.toLowerCase();
    const targetId = actionTargetId(actionId, object.id);
    const auditDetail = `Ответственный выбран: ${candidate.responsible}. Причина: ${reason}`;

    if (normalized.startsWith('director-production-override-owner:')) {
      updateRoleObject('production', targetId, (currentObject) => ({
        ...currentObject,
        nextOwner: candidate.owner,
        facts: updateFactList(
          currentObject.facts,
          {
            Ответственный: candidate.responsible,
            'Причина director override': reason,
          },
          'production',
        ),
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            'audit:director_production_owner_assigned',
            auditDetail,
            {
              reason,
              oldValue: currentObject.nextOwner,
              newValue: candidate.responsible,
              sourceSnapshot: `${object.title}: назначение владельца директором`,
            },
          ),
          ...currentObject.audit,
        ],
      }));
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: 'success',
        title: 'Ответственный назначен',
        detail: `${candidate.responsible}: задача остается в производственном контуре.`,
      });
      showMutationToast(
        'director',
        object.id,
        actionId,
        'success',
        'Ответственный назначен',
        candidate.responsible,
      );
      return;
    }

    updateRoleObject('director', object.id, (currentObject) => ({
      ...currentObject,
      nextOwner: candidate.owner,
      facts: updateFactList(
        currentObject.facts,
        {
          Ответственный: candidate.responsible,
          Владелец: candidate.owner,
          'Причина назначения': reason,
        },
        'director',
      ),
      actions: currentObject.actions.filter((action) => action.id !== actionId),
      audit: [
        auditEntryWithValues(
          currentObject.id,
          'Директор',
          'audit:director_owner_assigned',
          `${auditDetail}. Задача остается в решении до выбора исхода.`,
          {
            reason,
            oldValue: currentObject.nextOwner,
            newValue: candidate.responsible,
            sourceSnapshot: currentObject.title,
          },
        ),
        ...currentObject.audit,
      ],
    }));
    setNavigationActionOutcome({
      role: 'director',
      objectId: object.id,
      tone: 'success',
      title: 'Ответственный назначен',
      detail: `${candidate.responsible}: теперь видно, кто продолжает разбор.`,
    });
    showMutationToast(
      'director',
      object.id,
      actionId,
      'success',
      'Ответственный назначен',
      candidate.responsible,
    );
  }

  function openDirectorAssignmentDialog(actionId: string, object: WorkObject) {
    setActionConfirmation({
      eyebrow: 'Директор',
      title: 'Назначить ответственного',
      objectTitle: object.title,
      tone: 'warning',
      message:
        'Выбери владельца, который должен закрыть конкретный разрыв. Назначение запишется в историю вместе с причиной.',
      details: directorAssignmentDialogDetails(object),
      choices: {
        label: 'Кого назначить',
        options: directorAssignmentCandidates.map((candidate) => ({
          label: candidate.label,
          value: candidate.value,
          description: candidate.description,
        })),
        requiredMessage: 'Выбери ответственного.',
      },
      input: {
        label: 'Причина назначения',
        placeholder: 'Например: нет причины замены сырья; нужен владелец разбора рецептуры',
        requiredMessage: 'Причина обязательна для директорского назначения.',
      },
      confirmLabel: 'Назначить',
      cancelLabel: 'Отмена',
      onConfirm: (inputValue, choiceValue) => {
        const reason = inputValue?.trim();
        if (!reason) return;
        setActionConfirmation(null);
        applyDirectorAssignment(actionId, object, choiceValue, reason);
      },
    });
  }

  function runLiveDirectorOverride(
    contour: 'finance' | 'production' | 'warehouse',
    objectId: string,
    reason: string,
    kind: string,
  ) {
    const call =
      contour === 'finance'
        ? overrideDirectorFinance
        : contour === 'production'
          ? overrideDirectorProduction
          : overrideDirectorWarehouse;
    void call(objectId, { reason, evidence: reason })
      .then(() => {
        setDirectorLiveTick((tick) => tick + 1);
        showMutationToast(
          'director',
          objectId,
          `director-override-${contour}`,
          'success',
          kind,
          'Решение сохранено.',
        );
      })
      .catch((error: unknown) =>
        showMutationToast(
          'director',
          objectId,
          `director-override-${contour}`,
          'critical',
          'Override не записан',
          error instanceof Error ? error.message : 'Решение не сохранено.',
        ),
      );
  }

  function applyDirectorAction(actionId: string, object: WorkObject) {
    const normalized = actionId.toLowerCase();
    const targetId = actionTargetId(actionId, object.id);

    // Live-решения директора (approve/return) → backend + аудит.
    if (isDirectorLive && normalized.startsWith('director-decision-approve:')) {
      void approveDirectorDecision(targetId)
        .then(() => {
          setDirectorLiveTick((tick) => tick + 1);
          showMutationToast(
            'director',
            targetId,
            actionId,
            'success',
            'Решение согласовано',
            'Решение сохранено.',
          );
        })
        .catch((error: unknown) =>
          showMutationToast(
            'director',
            targetId,
            actionId,
            'critical',
            'Решение не записано',
            error instanceof Error ? error.message : 'Решение не сохранено.',
          ),
        );
      return;
    }
    if (isDirectorLive && normalized.startsWith('director-decision-return:')) {
      const reason = directorOverrideReason(actionId, object, 'Возврат решения', [
        { label: 'Действие', value: 'Вернуть на доработку' },
      ]);
      if (!reason) return;
      void returnDirectorDecision(targetId, reason)
        .then(() => {
          setDirectorLiveTick((tick) => tick + 1);
          showMutationToast(
            'director',
            targetId,
            actionId,
            'warning',
            'Решение возвращено',
            'Возврат с причиной сохранён.',
          );
        })
        .catch((error: unknown) =>
          showMutationToast(
            'director',
            targetId,
            actionId,
            'critical',
            'Возврат не записан',
            error instanceof Error ? error.message : 'Возврат не сохранён.',
          ),
        );
      return;
    }

    if (isProblemReportAction(actionId)) {
      if (activeRole === 'director') {
        upsertRoleObject('director', object);
      }
      openProblemReport('director', object, actionId);
      return;
    }

    if (
      normalized === 'assign-production' ||
      normalized.startsWith('director-production-override-owner:')
    ) {
      openDirectorAssignmentDialog(actionId, object);
      return;
    }

    if (normalized.startsWith('director-open-order-from-qr:')) {
      const warehouseObject = projectedWorkObjectsByRole.warehouse.find((item) => {
        const orderFact = factValue(item, 'Заказ') ?? '';
        const numberFact = factValue(item, 'Номер') ?? '';
        return (
          item.id === targetId ||
          orderFact === targetId ||
          numberFact === targetId ||
          item.title.includes(targetId)
        );
      });
      if (!warehouseObject) {
        setNavigationActionOutcome({
          role: 'director',
          tone: 'warning',
          title: 'Связанный заказ не найден.',
          detail: `${targetId}: нет складской или производственной карточки в текущем prototype dataset.`,
        });
        showMutationToast(
          'director',
          object.id,
          actionId,
          'warning',
          'Связанный заказ не найден',
          targetId,
        );
        return;
      }
      const directorWarehouseObject = {
        ...warehouseObject,
        id: `DIR-${warehouseObject.id}`,
        kind: 'directorDecision' as const,
        title: `Складской QR-контекст ${warehouseObject.id}`,
        statusLabel: 'Склад',
        nextOwner: 'Директор',
        actions: [
          {
            id: `director-open-scans:${warehouseObject.id}`,
            label: 'Открыть складской контекст',
            level: 'secondary' as const,
            enabled: true,
          },
          {
            id: `director-warehouse-override-confirm:${warehouseObject.id}`,
            label: 'Подтвердить исключение',
            level: 'peer' as const,
            enabled: true,
          },
          {
            id: `director-warehouse-override-return:${warehouseObject.id}`,
            label: 'Вернуть складу',
            level: 'secondary' as const,
            enabled: true,
          },
        ],
        audit: [
          auditEntry(
            warehouseObject.id,
            'Директор',
            'QR-контекст открыт',
            `${targetId}: переход из QR action panel к связанному складскому объекту.`,
          ),
          ...warehouseObject.audit,
        ],
      };
      upsertRoleObject('director', directorWarehouseObject);
      setActiveSectionByRole((current) => ({ ...current, director: 'Склад' }));
      setSelectedByRole((current) => ({ ...current, director: directorWarehouseObject.id }));
      setDirectorView('orders');
      setDirectorQuickFilter('warehouse');
      setNavigationActionOutcome({
        role: 'director',
        objectId: directorWarehouseObject.id,
        tone: 'info',
        title: 'Связанный заказ открыт.',
        detail: `${targetId}: показан складской контекст, счетчик QR и история приемки.`,
      });
      showMutationToast(
        'director',
        directorWarehouseObject.id,
        actionId,
        'info',
        'Связанный заказ открыт',
        'Директор видит заказ через складской QR-контекст.',
      );
      return;
    }

    if (
      normalized.startsWith('director-comment-qr:') ||
      normalized.startsWith('director-assign-qr:')
    ) {
      const isAssign = normalized.startsWith('director-assign-qr:');
      const title = isAssign ? 'Владелец разбора назначен.' : 'Комментарий к QR добавлен.';
      const detail = isAssign
        ? `${targetId}: Артур, зав. производства получил задачу закрыть разбор.`
        : `${targetId}: комментарий директора сохранен в QR-истории.`;
      upsertRoleObject('director', {
        ...object,
        facts: updateFactList(
          object.facts,
          isAssign
            ? { Ответственный: 'Артур, зав. производства' }
            : { 'Комментарий директора': 'Проверить связь рулона, заказа и складского счетчика' },
          'director',
        ),
        audit: [
          auditEntry(
            object.id,
            'Директор',
            isAssign ? 'Ответственный назначен' : 'Комментарий к QR добавлен',
            detail,
          ),
          ...object.audit,
        ],
      });
      setSelectedByRole((current) => ({ ...current, director: object.id }));
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: 'success',
        title,
        detail,
      });
      showMutationToast('director', object.id, actionId, 'success', title, detail);
      return;
    }

    if (
      normalized.startsWith('director-material-confirm:') ||
      normalized.startsWith('director-material-return:')
    ) {
      const returned = normalized.startsWith('director-material-return:');
      const decisionLabel = returned
        ? 'Дефицит сырья возвращен'
        : 'Исключение по сырью подтверждено';
      const reason = directorOverrideReason(actionId, object, decisionLabel, [
        { label: 'Контур', value: 'Сырье' },
        {
          label: 'Запись',
          value: returned
            ? 'audit:director_warehouse_override_applied'
            : 'audit:director_production_override_applied',
        },
        { label: 'Источник', value: 'складской факт / учетный снимок' },
      ]);
      if (!reason) return;
      updateRoleObject('director', object.id, (currentObject) => ({
        ...currentObject,
        statusLabel: returned ? 'Возвращено' : 'Исключение подтверждено',
        nextOwner: returned ? 'Зав. производства + Склад' : 'Зав. производства',
        severity: returned ? 'warning' : 'info',
        actions: [
          {
            id: `director-history:${currentObject.id}`,
            label: 'Открыть историю',
            level: 'secondary',
            enabled: true,
          },
        ],
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            decisionLabel,
            `${returned ? 'Склад и зав. производства должны уточнить остаток или маршрут выпуска.' : 'Директор подтвердил исключение; зав. производства продолжает по выбранному варианту.'} Причина: ${reason}`,
            {
              reason,
              oldValue: currentObject.statusLabel,
              newValue: returned ? 'Возвращено' : 'Исключение подтверждено',
              sourceSnapshot: `${currentObject.title}: складской факт, резерв, price reference`,
            },
          ),
          ...currentObject.audit,
        ],
      }));
      const title = returned ? 'Вернули на разбор' : 'Исключение подтверждено';
      const detail = returned
        ? 'Склад и зав. производства уточняют дефицит.'
        : 'Решение записано; зав. производства видит основание.';
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: returned ? 'warning' : 'success',
        title,
        detail,
      });
      showMutationToast(
        'director',
        object.id,
        actionId,
        returned ? 'warning' : 'success',
        title,
        detail,
      );
      return;
    }

    if (normalized.startsWith('director-finance-recheck:')) {
      const reason = directorOverrideReason(actionId, object, 'Перепроверка запрошена', [
        { label: 'Контур', value: 'Финансы' },
        {
          label: 'Запись',
          value: visibleAuditActionLabel('audit:director_finance_recheck_requested'),
        },
      ]);
      if (!reason) return;
      updateRoleObject('finance', targetId, (currentObject) => ({
        ...currentObject,
        statusLabel: 'На сверке',
        nextOwner: 'Бухгалтерия',
        severity: 'warning',
        facts: updateFactList(
          currentObject.facts,
          {
            'Состояние директорского решения': 'На сверке',
            'Результат директорского решения': 'Перепроверить',
            'Причина director override': reason,
          },
          'director',
        ),
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            'audit:director_finance_recheck_requested',
            `Директор не принял решение и отправил строку на сверку бухгалтерии. Причина: ${reason}`,
            {
              reason,
              oldValue: currentObject.statusLabel,
              newValue: 'На сверке у бухгалтерии',
              sourceSnapshot: `${object.title}: финансовый файл + запрос перепроверки`,
            },
          ),
          ...currentObject.audit,
        ],
      }));
      setSelectedByRole((current) => ({ ...current, director: `DIR-${targetId}` }));
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: 'warning',
        title: 'Передано на сверку',
        detail: 'Карточка ушла из активного реестра директора в список "Записанные / на сверке".',
      });
      showMutationToast(
        'director',
        object.id,
        actionId,
        'warning',
        'Передано на сверку',
        'Бухгалтерия стала владельцем следующего шага.',
      );
      return;
    }

    if (normalized.startsWith('director-finance-record-')) {
      const returned = normalized.startsWith('director-finance-record-return:');
      const decisionLabel = returned ? 'Вернуть бухгалтерии' : 'Подтвердить план оплаты';
      const reason = directorOverrideReason(actionId, object, decisionLabel, [
        { label: 'Контур', value: 'Финансы' },
        {
          label: 'Запись',
          value: visibleAuditActionLabel('audit:director_finance_decision_recorded'),
        },
        { label: 'Результат', value: decisionLabel },
      ]);
      if (!reason) return;
      updateRoleObject('finance', targetId, (currentObject) => ({
        ...currentObject,
        statusLabel: 'Решение записано',
        nextOwner: 'Бухгалтерия',
        severity: returned ? 'warning' : 'info',
        facts: updateFactList(
          currentObject.facts,
          {
            'Состояние директорского решения': 'Решение записано',
            'Результат директорского решения': decisionLabel,
            'Причина director override': reason,
          },
          'director',
        ),
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            'audit:director_finance_decision_recorded',
            `${decisionLabel}: директорское решение записано; бухгалтерия остается владельцем учета. Причина: ${reason}`,
            {
              reason,
              oldValue: currentObject.statusLabel,
              newValue: decisionLabel,
              sourceSnapshot: `${object.title}: финансовый файл + записанное решение`,
            },
          ),
          ...currentObject.audit,
        ],
      }));
      setSelectedByRole((current) => ({ ...current, director: `DIR-${targetId}` }));
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: returned ? 'warning' : 'success',
        title: 'Решение записано',
        detail:
          'Карточка ушла из активного реестра директора и доступна в скрытом списке с историей.',
      });
      showMutationToast(
        'director',
        object.id,
        actionId,
        returned ? 'warning' : 'success',
        'Решение записано',
        'Активная очередь директора обновлена.',
      );
      return;
    }

    if (normalized.startsWith('director-finance-override-')) {
      const override = directorFinanceOverrideOutcome(actionId);
      const reason = directorOverrideReason(actionId, object, override.kind, [
        { label: 'Контур', value: 'Финансы' },
        { label: 'Запись', value: visibleAuditActionLabel(override.auditAction) },
      ]);
      if (!reason) return;
      if (isDirectorLive) {
        runLiveDirectorOverride('finance', targetId, reason, override.kind);
        return;
      }
      updateRoleObject('finance', targetId, (currentObject) => ({
        ...currentObject,
        nextOwner: override.returnsToFinance ? 'Бухгалтерия' : currentObject.nextOwner,
        severity: override.emergency ? 'warning' : currentObject.severity,
        facts: updateFactList(
          currentObject.facts,
          { 'Причина director override': reason },
          'director',
        ),
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            override.auditAction,
            `${override.kind}: директорское действие записано; финансовый источник остается на сверке. Причина: ${reason}`,
            {
              reason,
              oldValue: currentObject.statusLabel,
              newValue: override.returnsToFinance ? 'Вернуть бухгалтерии' : override.kind,
              sourceSnapshot: `${object.title}: финансовый файл + выбранное подтверждение`,
            },
          ),
          ...currentObject.audit,
        ],
      }));
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: override.warning ? 'warning' : 'success',
        title: override.kind,
        detail: `Решение записано в финансовую историю. Причина: ${reason}`,
      });
      showMutationToast(
        'director',
        object.id,
        actionId,
        override.warning ? 'warning' : 'success',
        override.kind,
        'Причина и подтверждение сохранены в истории.',
      );
      return;
    }

    if (normalized.startsWith('director-production-override-')) {
      const override = directorProductionOverrideOutcome(actionId);
      const reason = directorOverrideReason(actionId, object, override.kind, [
        { label: 'Контур', value: 'Производство' },
        {
          label: 'Запись',
          value: visibleAuditActionLabel('audit:director_production_override_applied'),
        },
      ]);
      if (!reason) return;
      if (isDirectorLive) {
        runLiveDirectorOverride('production', targetId, reason, override.kind);
        return;
      }
      updateRoleObject('production', targetId, (currentObject) => ({
        ...currentObject,
        nextOwner: override.returned ? 'Зав. производства' : currentObject.nextOwner,
        severity: override.confirmed ? 'info' : currentObject.severity,
        facts: override.assignOwner
          ? updateFactList(
              currentObject.facts,
              { Ответственный: 'Артур, зав. производства', 'Причина director override': reason },
              'production',
            )
          : override.setPriority
            ? updateFactList(
                currentObject.facts,
                { Приоритет: 'критично', 'Причина director override': reason },
                'production',
              )
            : updateFactList(
                currentObject.facts,
                { 'Причина director override': reason },
                'production',
              ),
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            'audit:director_production_override_applied',
            `${override.kind}: директорское решение записано в историю заказ-наряда. Причина: ${reason}`,
            {
              reason,
              oldValue: currentObject.statusLabel,
              newValue: override.kind,
              sourceSnapshot: `${object.title}: производственная карточка + выбранное подтверждение`,
            },
          ),
          ...currentObject.audit,
        ],
      }));
      showMutationToast(
        'director',
        object.id,
        actionId,
        override.returned ? 'warning' : 'success',
        override.kind,
        'Изменение видно в производственной истории.',
      );
      return;
    }

    if (normalized.startsWith('director-warehouse-override-')) {
      const override = directorWarehouseOverrideOutcome(actionId);
      const reason = directorOverrideReason(actionId, object, override.kind, [
        { label: 'Контур', value: 'Склад' },
        {
          label: 'Запись',
          value: visibleAuditActionLabel('audit:director_warehouse_override_applied'),
        },
      ]);
      if (!reason) return;
      if (isDirectorLive) {
        runLiveDirectorOverride('warehouse', targetId, reason, override.kind);
        return;
      }
      updateRoleObject('warehouse', targetId, (currentObject) => ({
        ...currentObject,
        severity: override.returned ? currentObject.severity : 'info',
        nextOwner: 'Склад',
        facts: updateFactList(
          currentObject.facts,
          { 'Причина director override': reason },
          'director',
        ),
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            'audit:director_warehouse_override_applied',
            `${override.kind}: директорское решение записано без выполнения складского сканирования. Причина: ${reason}`,
            {
              reason,
              oldValue: currentObject.statusLabel,
              newValue: override.kind,
              sourceSnapshot: `${object.title}: складское исключение + выбранное подтверждение`,
            },
          ),
          ...currentObject.audit,
        ],
      }));
      showMutationToast(
        'director',
        object.id,
        actionId,
        override.returned ? 'warning' : 'success',
        override.kind,
        'Сканирование остается действием склада; решение записано в историю.',
      );
      return;
    }

    if (normalized.includes('open-scans')) {
      const warehouseId = factValue(object, 'Номер');
      if (!warehouseId?.startsWith('WH-')) {
        setNavigationActionOutcome({
          role: 'director',
          objectId: object.id,
          tone: 'warning',
          title: 'Складской контекст не найден.',
          detail: 'В решении нет номера приемки WH для перехода к сканам.',
        });
        return;
      }
      setActiveSectionByRole((current) => ({ ...current, director: 'Склад' }));
      setSelectedByRole((current) => ({ ...current, director: warehouseId }));
      setDirectorView('orders');
      setDirectorQuickFilter('warehouse');
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: 'info',
        title: 'Складской статус открыт.',
        detail: 'Директор видит складской контекст без действий склада.',
      });
      return;
    }

    if (normalized.startsWith('director-penalty-finance:')) {
      const payload = actionId.slice('director-penalty-finance:'.length);
      const [financeObjectId, decisionId = 'director-decision'] = payload.split(':');
      setPenaltyScopeObjectId(`${financeObjectId} / ${decisionId}`);
      updateRoleObject('finance', financeObjectId, (currentObject) => ({
        ...currentObject,
        facts: updateFactList(currentObject.facts, { 'Связанный штраф': decisionId }, 'director'),
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            'audit:director_finance_penalty_linked',
            `Штраф назначен из финансового решения ${decisionId}.`,
            {
              oldValue: factValue(currentObject, 'Связанный штраф') ?? 'нет',
              newValue: decisionId,
              sourceSnapshot: `${object.title}: штраф привязан к записанному решению`,
            },
          ),
          ...currentObject.audit,
        ],
      }));
      setNavigationActionOutcome({
        role: 'director',
        objectId: object.id,
        tone: 'info',
        title: 'Штраф привязан к решению',
        detail: `${financeObjectId}: связь записана в финансовую историю.`,
      });
      showMutationToast(
        'director',
        object.id,
        actionId,
        'info',
        'Штраф привязан',
        'Связь сохранена в истории финансовой карточки.',
      );
      return;
    }

    if (normalized.includes('penalty-create') && !normalized.includes('disabled')) {
      setPenaltyScopeObjectId(object.id);
      setActiveSectionByRole((current) => ({ ...current, director: 'Штрафы' }));
      setDirectorView('decisions');
      setDirectorQuickFilter('all');
      return;
    }

    const requiresDecisionReason = directorDecisionActionRequiresReason(actionId);
    const decisionReason = requiresDecisionReason
      ? directorOverrideReason(actionId, object, directorToastTitleForAction(normalized, object), [
          { label: 'Контур', value: object.statusLabel },
          { label: 'Источник', value: object.title },
        ])
      : null;
    if (requiresDecisionReason && !decisionReason) return;

    if (normalized.includes('kickback')) {
      const financeOrderId = targetId;
      dispatchRuntimeAction({
        type: 'director.kickback.updated',
        financeOrderId,
        status: 'confirmed',
      });
    }

    const directorToast =
      normalized.includes('approve') || normalized.includes('confirm')
        ? {
            tone: 'success' as const,
            title:
              object.statusLabel === 'Склад'
                ? 'Складское решение подтверждено'
                : 'Решение подтверждено',
            detail: 'Маршрут и история обновлены.',
          }
        : normalized.includes('return')
          ? {
              tone: 'warning' as const,
              title: 'Решение возвращено',
              detail: 'Строка вернулась владельцу на доработку.',
            }
          : normalized.includes('assign')
            ? {
                tone: 'success' as const,
                title: 'Ответственный назначен',
                detail: 'Задача остается в решении до выбора исхода.',
              }
            : normalized.includes('queue-reorder')
              ? {
                  tone: 'success' as const,
                  title: 'Порядок очереди изменен',
                  detail: 'Изменение записано в историю.',
                }
              : normalized.includes('kickback')
                ? {
                    tone: 'success' as const,
                    title: 'Финансовое решение записано',
                    detail: 'Статус обновлен в директорском контуре.',
                  }
                : {
                    tone: 'info' as const,
                    title: 'Действие директора записано',
                    detail: 'История выбранного решения обновлена.',
                  };

    updateRoleObject('director', object.id, (currentObject) => {
      if (normalized.includes('approve') || normalized.includes('confirm')) {
        return {
          ...currentObject,
          statusLabel:
            currentObject.statusLabel === 'Склад' ? 'Проблема подтверждена' : 'Подтверждено',
          nextOwner: currentObject.statusLabel === 'Склад' ? 'Склад' : 'Зав. производства',
          severity: 'info',
          problems: currentObject.problems.map((problem) => ({
            ...problem,
            status: 'resolved' as const,
          })),
          actions: [
            {
              id: `director-history:${currentObject.id}`,
              label: 'Открыть историю',
              level: 'secondary',
              enabled: true,
            },
          ],
          audit: [
            auditEntryWithValues(
              currentObject.id,
              'Директор',
              'audit:director_decision_approved',
              `Директор выбрал вариант; следующий владелец получил понятный результат. Причина: ${decisionReason}`,
              {
                reason: decisionReason ?? undefined,
                oldValue: currentObject.statusLabel,
                newValue: 'Подтверждено',
                sourceSnapshot: currentObject.title,
              },
            ),
            ...currentObject.audit,
          ],
        };
      }

      if (normalized.includes('return')) {
        const nextOwner = currentObject.statusLabel === 'Склад' ? 'Склад' : 'Зав. производства';
        return {
          ...currentObject,
          statusLabel: 'Возвращено',
          nextOwner,
          severity: 'warning',
          actions: [
            {
              id: `director-history:${currentObject.id}`,
              label: 'Открыть историю',
              level: 'secondary',
              enabled: true,
            },
          ],
          audit: [
            auditEntryWithValues(
              currentObject.id,
              'Директор',
              'audit:director_decision_returned',
              `Строка возвращена роли ${nextOwner} на доработку с сохранением истории. Причина: ${decisionReason}`,
              {
                reason: decisionReason ?? undefined,
                oldValue: currentObject.statusLabel,
                newValue: 'Возвращено',
                sourceSnapshot: currentObject.title,
              },
            ),
            ...currentObject.audit,
          ],
        };
      }

      if (normalized.includes('assign')) {
        return {
          ...currentObject,
          nextOwner: 'Зав. производства',
          facts: updateFactList(
            currentObject.facts,
            { Ответственный: 'Артур, зав. производства' },
            'director',
          ),
          actions: currentObject.actions.filter((action) => action.id !== actionId),
          audit: [
            auditEntryWithValues(
              currentObject.id,
              'Директор',
              'audit:director_decision_approved',
              `Ответственным выбран Артур, зав. производства; задача остается в решении до выбора исхода. Причина: ${decisionReason}`,
              {
                reason: decisionReason ?? undefined,
                oldValue: currentObject.nextOwner,
                newValue: 'Артур, зав. производства',
                sourceSnapshot: currentObject.title,
              },
            ),
            ...currentObject.audit,
          ],
        };
      }

      if (normalized.includes('queue-reorder')) {
        return {
          ...currentObject,
          audit: [
            auditEntryWithValues(
              currentObject.id,
              'Директор',
              'audit:director_production_override_applied',
              `Директор изменил общий порядок до начала или закрытия работ по строке. Причина: ${decisionReason}`,
              {
                reason: decisionReason ?? undefined,
                oldValue: 'текущий порядок',
                newValue: 'приоритет изменен',
                sourceSnapshot: currentObject.title,
              },
            ),
            ...currentObject.audit,
          ],
        };
      }

      return {
        ...currentObject,
        audit: [
          auditEntryWithValues(
            currentObject.id,
            'Директор',
            'audit:director_decision_approved',
            `Действие директора записано в историю выбранного решения.${decisionReason ? ` Причина: ${decisionReason}` : ''}`,
            {
              reason: decisionReason ?? undefined,
              oldValue: currentObject.statusLabel,
              newValue: 'Действие записано',
              sourceSnapshot: currentObject.title,
            },
          ),
          ...currentObject.audit,
        ],
      };
    });
    showMutationToast(
      'director',
      object.id,
      actionId,
      directorToast.tone,
      directorToast.title,
      directorToast.detail,
    );
  }

  function applyWarehouseCloseoutAction(currentObject: WorkObject, actionId: string) {
    const selectedWarehouseId = currentObject.id;

    if (actionId.startsWith('warehouse-cover-recheck-complete:')) {
      const taskId = warehouseRecheckTaskIdFromAction(actionId);
      const commercialId = factValue(currentObject, 'Заказ') ?? taskId.replace(/^WH-RECHECK-/, '');
      updateRoleObject('warehouse', selectedWarehouseId, (object) =>
        completeWarehouseRecheckTask(object, actionId),
      );
      updateRoleObject('commercial', commercialId, (object) =>
        applyCommercialWarehouseRecheckResult(object, taskId),
      );
      notifyRole(
        'commercial',
        commercialId,
        'Перепроверка склада завершена',
        'Склад вернул итог покрытия. Производство не изменялось до финального решения коммерции.',
        'warning',
      );
      setMutatingNavigationActionOutcome(
        {
          role: 'warehouse',
          objectId: selectedWarehouseId,
          tone: 'success',
          title: 'Перепроверка завершена.',
          detail: 'Коммерция получила результат; производство не изменено.',
        },
        actionId,
      );
      return true;
    }

    if (actionId.startsWith('warehouse-open-reserve')) {
      updateRoleObject('warehouse', selectedWarehouseId, (object) =>
        recordWarehouseReserveOpened(object, actionId.split(':')[1] ?? object.id),
      );
      setNavigationActionOutcome({
        role: 'warehouse',
        objectId: selectedWarehouseId,
        tone: 'info',
        title: 'Резерв показан.',
        detail: 'Открыты рулоны, задача и история.',
      });
      openDetailTarget('.warehouse-inventory-detail');
      return true;
    }

    if (actionId.startsWith('warehouse-release-reserve:')) {
      const targetId = actionId.slice('warehouse-release-reserve:'.length);
      updateRoleObject('warehouse', selectedWarehouseId, (object) =>
        recordWarehouseReserveReleased(object, targetId),
      );
      notifyRole(
        'commercial',
        selectedWarehouseId,
        'Резерв освобожден',
        `Склад освободил рулоны ${targetId}; изменение видно в истории.`,
        'warning',
      );
      setMutatingNavigationActionOutcome(
        {
          role: 'warehouse',
          objectId: selectedWarehouseId,
          tone: 'warning',
          title: 'Рулоны освобождены.',
          detail: 'Записано в историю и отправлено коммерции.',
        },
        actionId,
      );
      return true;
    }

    if (actionId.startsWith('warehouse-open-stock-mutation:')) {
      const materialId = actionId.slice('warehouse-open-stock-mutation:'.length);
      setNavigationActionOutcome({
        role: 'warehouse',
        objectId: selectedWarehouseId,
        tone: 'info',
        title: 'Форма изменения остатка открыта.',
        detail: `Выберите строку ${materialId} в категории "Сырье" и запишите количество с причиной.`,
      });
      openDetailTarget('.warehouse-inventory-detail');
      return true;
    }

    if (actionId.startsWith('warehouse-correct-stock:')) {
      const materialId = actionId.slice('warehouse-correct-stock:'.length);
      const reasonKey = `input:${selectedWarehouseId}:${actionId}`;
      const reason = actionConfirmationInputRef.current[reasonKey];
      if (reason === undefined) {
        setActionConfirmation({
          eyebrow: 'Склад',
          title: 'Корректировка остатка',
          objectTitle: currentObject.title,
          message:
            'Запишите причину ручной корректировки. Факт склада остается в прототипе до сверки источников.',
          tone: 'warning',
          confirmLabel: 'Записать корректировку',
          details: [
            { label: 'Материал', value: materialId },
            { label: 'Владелец', value: 'Склад' },
            { label: 'Граница', value: 'Не меняет бухгалтерский и производственный учет' },
          ],
          input: {
            label: 'Причина корректировки',
            placeholder: 'Например: пересчет после приемки сырья',
            requiredMessage: 'Причина обязательна.',
          },
          onConfirm: (value) => {
            actionConfirmationInputRef.current[reasonKey] = value ?? '';
            setActionConfirmation(null);
            window.requestAnimationFrame(() => applyWorkObjectAction(actionId));
          },
        });
        return true;
      }
      delete actionConfirmationInputRef.current[reasonKey];
      const normalizedReason = reason.trim();
      if (!normalizedReason) {
        setNavigationActionOutcome({
          role: 'warehouse',
          objectId: selectedWarehouseId,
          tone: 'warning',
          title: 'Причина обязательна.',
          detail: 'Корректировка остатка не записана без причины.',
        });
        return true;
      }
      setMutatingNavigationActionOutcome(
        {
          role: 'warehouse',
          objectId: selectedWarehouseId,
          tone: 'warning',
          title: 'Нужно указать количество.',
          detail: `Причина получена: ${normalizedReason}. Остаток ${materialId} не изменен: корректировка теперь выполняется через форму с количеством, старым/новым значением и fallback-проверками.`,
        },
        actionId,
      );
      return true;
    }

    return false;
  }

  /** HID-сканер склада принадлежит браузерной сессии; intent палеты задаёт активный раздел. */
  async function handleWarehouseScan(payload: string): Promise<boolean> {
    try {
      if (warehouseDefectBagMode) {
        const request = physicalOperationGateRef.current.start(
          `warehouse:defect-bag:${warehouseDefectBagMode}:${payload}`,
          (operationKey) =>
            warehouseDefectBagMode === 'receiving'
              ? receiveWarehouseDefectBag(payload, operationKey)
              : shipWarehouseDefectBag(payload, operationKey),
          'warehouse:defect-bag:scan',
        );
        if (!request) return true;
        const bag = await request;
        showMutationToast(
          'warehouse',
          undefined,
          `warehouse-defect-bag:${bag.id}`,
          'success',
          warehouseDefectBagMode === 'receiving'
            ? `Мешок ${bag.code} принят`
            : `Мешок ${bag.code} отгружен`,
          `${bag.weightKg} кг`,
        );
        if (soundByRole.warehouse) playPrototypeBeep();
        setWarehouseLiveTick((tick) => tick + 1);
        return true;
      }
      if (isWarehousePalletPayload(payload)) {
        const palletIntent = warehousePalletScanIntent(activeSection);
        if (palletIntent === 'delivery') {
          const request = physicalOperationGateRef.current.start(
            `warehouse:pallet:delivery:${payload}`,
            (operationKey) => scanWarehousePalletDelivery(payload, operationKey),
          );
          if (!request) return true;
          const palletDelivery = await request;
          const objectId = `delivery-${palletDelivery.deliveryTaskId}`;
          setSelectedByRole((current) => ({ ...current, warehouse: objectId }));
          setActiveSectionByRole((current) => ({ ...current, warehouse: 'Выдача' }));
          const url = replaceObjectSelectionInUrl(window.location.href, objectId);
          url.searchParams.set('role', 'warehouse');
          url.searchParams.set('section', 'Выдача');
          window.history.replaceState(null, '', url);
          const alreadyConfirmed = palletDelivery.newlyDeliveredRollCount === 0;
          showMutationToast(
            'warehouse',
            objectId,
            `warehouse-pallet-delivery:${palletDelivery.documentId}`,
            palletDelivery.deliveryClosed ? 'success' : 'info',
            alreadyConfirmed
              ? `Палета ${palletDelivery.palletCode} уже выдана`
              : palletDelivery.deliveryClosed
                ? 'Выдача закрыта'
                : `Палета ${palletDelivery.palletCode} подтверждена`,
            alreadyConfirmed
              ? 'Повторный скан не изменил рулоны и оплату.'
              : palletDelivery.deliveryClosed
                ? `${palletDelivery.newlyDeliveredRollCount} рул. выданы; задача закрыта.`
                : `${palletDelivery.newlyDeliveredRollCount} рул. выданы; осталось ${palletDelivery.remainingRollCount}.`,
          );
          if (soundByRole.warehouse) playPrototypeBeep();
          setWarehouseLiveTick((tick) => tick + 1);
          return true;
        }
        const request = physicalOperationGateRef.current.start(
          `warehouse:pallet:handoff:${payload}`,
          (operationKey) => scanWarehousePallet(payload, operationKey),
        );
        if (!request) return true;
        const palletHandoff = await request;
        const objectId = `delivery-${palletHandoff.deliveryTaskId}`;
        setSelectedByRole((current) => ({ ...current, warehouse: objectId }));
        setActiveSectionByRole((current) => ({ ...current, warehouse: 'Выдача' }));
        const url = replaceObjectSelectionInUrl(window.location.href, objectId);
        url.searchParams.set('role', 'warehouse');
        url.searchParams.set('section', 'Выдача');
        window.history.replaceState(null, '', url);
        showMutationToast(
          'warehouse',
          objectId,
          `warehouse-pallet-handoff:${palletHandoff.documentId}`,
          'info',
          `Палета ${palletHandoff.palletCode} подтверждена в выдаче`,
          `${palletHandoff.rollCount} рул. подтверждены в задаче выдачи.`,
        );
        if (soundByRole.warehouse) playPrototypeBeep();
        setWarehouseLiveTick((tick) => tick + 1);
        return true;
      }
      const selectedDeliveryTask = warehouseDeliveryTasks.find(
        (task) => `delivery-${task.id}` === selectedWarehouseScanStationId,
      );
      if (activeSection === 'Выдача' && !selectedDeliveryTask) {
        showMutationToast(
          'warehouse',
          undefined,
          'warehouse-delivery-scan-target',
          'warning',
          'Выберите задачу выдачи',
          'Скан выдачи должен быть привязан к конкретной операции.',
        );
        return false;
      }
      let result: ServerWarehouseScanResult;
      if (selectedDeliveryTask) {
        const request = physicalOperationGateRef.current.start(
          `warehouse:delivery:${selectedDeliveryTask.id}:scan:${payload}`,
          (operationKey) => scanWarehouseTask(selectedDeliveryTask.id, payload, operationKey),
        );
        if (!request) return true;
        result = await request;
      } else {
        const request = physicalOperationGateRef.current.start(
          `warehouse:intake:scan:${payload}`,
          (operationKey) => scanWarehousePayload(payload, operationKey),
        );
        if (!request) return true;
        result = await request;
      }
      const scannedTask = result.task;
      if (scannedTask.taskId) {
        const section = selectedDeliveryTask ? 'Выдача' : 'Приемка';
        const objectId = `${selectedDeliveryTask ? 'delivery' : 'intake'}-${scannedTask.taskId}`;
        setSelectedByRole((current) => ({ ...current, warehouse: objectId }));
        setActiveSectionByRole((current) => ({ ...current, warehouse: section }));
        const url = replaceObjectSelectionInUrl(window.location.href, objectId);
        url.searchParams.set('role', 'warehouse');
        url.searchParams.set('section', section);
        window.history.replaceState(null, '', url);
      }
      const accepted = result.scanStatus === 'accepted';
      showMutationToast(
        'warehouse',
        undefined,
        `warehouse-scan:${payload.slice(0, 24)}`,
        accepted ? 'info' : 'warning',
        accepted
          ? `Принят ${result.rollCode}`
          : result.scanStatus === 'duplicate'
            ? `Дубликат ${result.rollCode}`
            : result.scanStatus === 'excess'
              ? `Чужой QR${result.rollCode ? ` ${result.rollCode}` : ''}`
              : 'QR не распознан',
        accepted
          ? `Рулон отмечен в задаче ${selectedDeliveryTask ? 'выдачи' : 'приемки'}.`
          : `Ошибка скана записана в задачу ${selectedDeliveryTask ? 'выдачи' : 'приемки'}.`,
      );
      if (soundByRole.warehouse) playPrototypeBeep();
      setWarehouseLiveTick((tick) => tick + 1);
      return true;
    } catch (error: unknown) {
      showMutationToast(
        'warehouse',
        undefined,
        'warehouse-scan',
        'critical',
        'Скан не обработан',
        warehouseScanErrorMessage(error),
      );
      return false;
    }
  }

  async function handleWarehousePalletSelectionScan(
    taskId: string,
    payload: string,
  ): Promise<boolean> {
    try {
      const request = physicalOperationGateRef.current.start(
        `warehouse:pallet-selection:${taskId}:${payload}`,
        (operationKey) => scanWarehousePalletSelection(taskId, payload, operationKey),
      );
      if (!request) return true;
      const result = await request;
      const objectId = `intake-${result.taskId}`;
      updateRoleObject('warehouse', objectId, (object) =>
        applyWarehousePalletSelectionScan(object, result),
      );
      setSelectedByRole((current) => ({ ...current, warehouse: objectId }));
      showMutationToast(
        'warehouse',
        objectId,
        `warehouse-pallet-selection:${result.scanRowId}`,
        result.outcome === 'added' ? 'success' : 'info',
        result.outcome === 'added'
          ? `Рулон ${result.rollCode} добавлен`
          : 'Рулон уже в палетном листе',
        `${result.activePallet.palletCode} · ${result.activePallet.totalCount} рул.`,
      );
      if (soundByRole.warehouse) playPrototypeBeep();
      return true;
    } catch (error: unknown) {
      showMutationToast(
        'warehouse',
        `intake-${taskId}`,
        'warehouse-pallet-selection-scan',
        'critical',
        'Скан палеты не обработан',
        warehouseScanErrorMessage(error),
      );
      return false;
    }
  }

  /**
   * Live-режим Приёмки: серверные действия уходят в backend, после успеха — рефетч.
   * Действия по fixture-карточкам (выдача, cover-check) сюда не попадают.
   */
  function executeWarehouseOneCStockPush(operationKey: string, snapshotHash: string) {
    const request = liveMutationGateRef.current.start('warehouse:demo-onec-stock-push', () =>
      pushWarehouseRawMaterialsToOneC({ operationKey, snapshotHash }),
    );
    if (!request) return;

    setWarehouseOneCStockPushBusy(true);
    void request
      .then((result) => {
        if (!isVerifiedWarehouseOneCResult(result, operationKey, snapshotHash)) {
          throw new Error('Учётная система не подтвердила полный состав тестового документа.');
        }
        showMutationToast(
          'warehouse',
          rawMaterialSourceObject?.id,
          'warehouse-live:demo-onec-stock-push',
          'success',
          warehouseOneCSuccessTitle(result),
          `${result.pushed} поз. · документ ${result.ack.ref}. Проверьте его в учётной системе перед новым вызовом.`,
        );
        requestLiveRoleRefresh('warehouse');
      })
      .catch((error: unknown) => {
        showMutationToast(
          'warehouse',
          rawMaterialSourceObject?.id,
          'warehouse-live:demo-onec-stock-push',
          'critical',
          'Результат проведения не подтверждён',
          `${error instanceof Error ? error.message : 'Связь с учётной системой прервана.'} Не повторяйте отправку до ручной сверки.`,
        );
      })
      .finally(() => setWarehouseOneCStockPushBusy(false));
  }

  async function requestWarehouseOneCStockPush() {
    if (warehouseOneCStockPushBusy) return;
    if (!canPushWarehouseOneC) return;

    setWarehouseOneCStockPushBusy(true);
    try {
      const preview = await fetchWarehouseRawMaterialsOneCPreview();
      if (!isValidWarehouseOneCPreview(preview)) {
        throw new Error('Backend не вернул непустой подтверждаемый снимок.');
      }
      const readinessError = warehouseOneCReadinessError(preview);
      if (readinessError) throw new Error(readinessError);
      const operationKey = window.crypto.randomUUID();
      setActionConfirmation({
        eyebrow: 'Склад · учёт',
        title: 'Провести тестовые остатки один раз?',
        objectTitle: 'Это реальная запись во внешнюю демо-базу',
        message:
          'Backend заново прочитал складской факт. Вызов создаст и проведёт документ; автоматического повтора не будет.',
        tone: 'critical',
        confirmLabel: 'Провести один раз',
        details: [
          { label: 'Серверных позиций', value: String(preview.count) },
          { label: 'Суммарное количество', value: `${preview.totalQty} кг` },
          { label: 'Контрольный hash', value: preview.snapshotHash.slice(0, 12) },
          { label: 'Повтор', value: 'Только после ручной сверки' },
        ],
        input: {
          label: `Введите ${WAREHOUSE_ONEC_CONFIRMATION}`,
          placeholder: WAREHOUSE_ONEC_CONFIRMATION,
          requiredMessage: 'Нужно явно подтвердить реальную запись.',
        },
        onConfirm: (value) => {
          setActionConfirmation(null);
          if (!isExactWarehouseOneCConfirmation(value)) {
            showMutationToast(
              'warehouse',
              rawMaterialSourceObject?.id,
              'warehouse-live:demo-onec-stock-push-confirmation',
              'warning',
              'Проведение отменено',
              'Подтверждение должно точно совпадать со словом ПРОВЕСТИ.',
            );
            return;
          }
          executeWarehouseOneCStockPush(operationKey, preview.snapshotHash);
        },
      });
    } catch (error) {
      showMutationToast(
        'warehouse',
        rawMaterialSourceObject?.id,
        'warehouse-live:demo-onec-stock-preflight',
        'critical',
        'Складской факт не загружен',
        error instanceof Error ? error.message : 'Backend не вернул актуальные остатки.',
      );
    } finally {
      setWarehouseOneCStockPushBusy(false);
    }
  }

  function runWarehouseLiveAction(actionId: string): boolean {
    const refresh = () => {
      setWarehouseLiveTick((tick) => tick + 1);
      requestLiveRoleRefresh('warehouse');
    };
    const failToast = (title: string) => (error: unknown) =>
      showMutationToast(
        'warehouse',
        undefined,
        `warehouse-live:${actionId}`,
        'critical',
        title,
        error instanceof Error ? error.message : 'Не удалось выполнить действие.',
      );
    const okToast = (title: string, detail: string) =>
      showMutationToast(
        'warehouse',
        undefined,
        `warehouse-live:${actionId}`,
        'info',
        title,
        detail,
      );
    if (actionId.startsWith('warehouse.scan:')) {
      const payload = decodeWarehouseScanAction(actionId);
      if (payload) void handleWarehouseScan(payload);
      else {
        showMutationToast(
          'warehouse',
          undefined,
          actionId,
          'warning',
          'QR не введён',
          'Используйте постоянное поле «Сканирование QR».',
        );
      }
      return true;
    }
    const closeMatch = actionId.match(/^warehouse\.close:(.+)$/);
    if (closeMatch) {
      const request = liveMutationGateRef.current.start(`warehouse:${closeMatch[1]}:close`, () =>
        closeWarehouseIntakeTask(closeMatch[1], 'full'),
      );
      if (!request) return true;
      void request
        .then(() => {
          okToast('Приемка закрыта', 'Рулоны приняты складом, заказ закрыт.');
          refresh();
        })
        .catch(failToast('Приемка не закрыта'));
      return true;
    }
    const deliveryCloseMatch = actionId.match(/^warehouse\.delivery\.close:(.+)$/);
    if (deliveryCloseMatch) {
      const request = liveMutationGateRef.current.start(
        `warehouse:${deliveryCloseMatch[1]}:delivery-close`,
        () => closeWarehouseIntakeTask(deliveryCloseMatch[1], 'full'),
      );
      if (!request) return true;
      void request
        .then(() => {
          okToast('Выдача закрыта', 'Рулоны выданы; статусы заказа и оплаты обновлены.');
          refresh();
        })
        .catch(failToast('Выдача не закрыта'));
      return true;
    }
    const exportMatch = actionId.match(/^warehouse-export-pallet-list:(.+):(word|excel|pdf)$/);
    if (exportMatch) {
      const [, palletId, format] = exportMatch;
      const task = warehouseIntakeTasks.find(
        (candidate) => (candidate.operationCode ?? candidate.taskId) === palletId,
      );
      if (!task?.palletList) return false;
      void downloadWarehousePalletList(task.palletList.id, format as 'word' | 'excel' | 'pdf')
        .then(() => {
          okToast('Файл скачан', `Палетный лист (${format}) сохранен на устройство.`);
          refresh();
        })
        .catch(failToast('Экспорт не удался'));
      return true;
    }
    return false;
  }

  function applyWorkObjectAction(actionId: string, payload?: WorkObjectActionPayload) {
    if (activeRole === 'warehouse' && isWarehouseLive && runWarehouseLiveAction(actionId)) return;
    if (!selectedObject && isRawMaterialModuleSection && rawMaterialSourceObject) {
      if (activeRole === 'finance' && actionId.startsWith('finance-edit-material-cost:')) {
        const materialId = actionId.slice('finance-edit-material-cost:'.length);
        updateRoleObject('warehouse', rawMaterialSourceObject.id, (object) =>
          upsertManualMaterialCostReference(object, materialId),
        );
        setMutatingNavigationActionOutcome(
          {
            role: 'finance',
            tone: 'success',
            title: 'Учетная цена обновлена.',
            detail: 'Старая и новая цена, источник и причина изменения записаны в историю сырья.',
          },
          actionId,
        );
        return;
      }

      if (activeRole === 'director' && actionId.startsWith('director-override-material-cost:')) {
        const materialId = actionId.slice('director-override-material-cost:'.length);
        updateRoleObject('warehouse', rawMaterialSourceObject.id, (object) =>
          approveMaterialCostReference(object, materialId),
        );
        setMutatingNavigationActionOutcome(
          {
            role: 'director',
            tone: 'success',
            title: 'Учетная цена утверждена.',
            detail: 'Директорское утверждение цены записано с причиной и источником.',
          },
          actionId,
        );
        return;
      }

      if (activeRole === 'director' && actionId.startsWith('director-warehouse-override-return:')) {
        const materialId = actionId.slice('director-warehouse-override-return:'.length);
        const reasonKey = `input:director:${rawMaterialSourceObject.id}:${actionId}`;
        const reason = actionConfirmationInputRef.current[reasonKey];
        if (reason === undefined) {
          setActionConfirmation({
            eyebrow: 'Директор',
            title: 'Вернуть дефицит складу',
            objectTitle: rawMaterialSourceObject.title,
            message:
              'Решение отправит складу задачу на разбор дефицита. Складской факт вручную не меняется.',
            tone: 'warning',
            confirmLabel: 'Вернуть складу',
            details: [
              { label: 'Материал', value: materialId },
              { label: 'Контур', value: 'Сырье' },
              { label: 'Граница', value: 'Не меняет складской остаток вручную' },
            ],
            input: {
              label: 'Причина возврата',
              placeholder: 'Например: дефицит нужно сверить со складским фактом и резервом',
              requiredMessage: 'Причина обязательна.',
            },
            onConfirm: (value) => {
              actionConfirmationInputRef.current[reasonKey] = value ?? '';
              setActionConfirmation(null);
              window.requestAnimationFrame(() => applyWorkObjectAction(actionId));
            },
          });
          return;
        }
        delete actionConfirmationInputRef.current[reasonKey];
        const normalizedReason = reason.trim();
        if (!normalizedReason) {
          setNavigationActionOutcome({
            role: 'director',
            objectId: rawMaterialSourceObject.id,
            tone: 'warning',
            title: 'Причина обязательна.',
            detail: 'Дефицит не возвращен складу без причины и подтверждения.',
          });
          return;
        }
        updateRoleObject('warehouse', rawMaterialSourceObject.id, (object) => ({
          ...object,
          severity: 'warning',
          nextOwner: 'Склад',
          facts: updateFactList(
            object.facts,
            { 'Возврат директора': materialId, 'Причина director override': normalizedReason },
            'director',
          ),
          audit: [
            auditEntryWithValues(
              object.id,
              'Директор',
              'audit:director_warehouse_override_applied',
              `${materialId}: директор вернул дефицит складу на разбор без изменения складского факта. Причина: ${normalizedReason}`,
              {
                reason: normalizedReason,
                oldValue: 'Директорский просмотр',
                newValue: 'Вернуть складу',
                sourceSnapshot: `${materialId}: складской факт, план и учетный снимок`,
              },
            ),
            ...object.audit,
          ],
        }));
        notifyRole(
          'warehouse',
          rawMaterialSourceObject.id,
          'Разобрать дефицит сырья',
          `${materialId}: директор вернул дефицит складу. Причина: ${normalizedReason}`,
          'warning',
        );
        setMutatingNavigationActionOutcome(
          {
            role: 'director',
            objectId: rawMaterialSourceObject.id,
            tone: 'warning',
            title: 'Дефицит возвращен складу.',
            detail: `${materialId}: причина записана, склад получил уведомление, складской остаток не изменен.`,
          },
          actionId,
        );
        return;
      }

      if (activeRole === 'admin' && actionId.startsWith('admin-material-cost-source:')) {
        setMutatingNavigationActionOutcome(
          {
            role: 'admin',
            tone: 'info',
            title: 'Настройки источника открыты',
            detail: 'Админ меняет источник/маппинг; бизнес-цену задают финансы или директор.',
          },
          actionId,
        );
        return;
      }
    }

    if (!selectedObject || activeRole === 'operator') return;

    if (activeRole === 'finance' && actionId.toLowerCase().includes('history')) {
      setOfficeActionOutcome('finance', selectedObject.id, {
        tone: 'info',
        title: 'История открыта.',
      });
      openDetailTarget('.audit-details');
      return;
    }

    if (activeRole === 'warehouse' && actionId.toLowerCase().includes('history')) {
      openDetailTarget('.audit-details');
      return;
    }

    if (
      activeRole === 'finance' &&
      actionId.toLowerCase().includes('schedule') &&
      !financeScheduleIdFromAction(actionId)
    ) {
      setOfficeActionOutcome('finance', selectedObject.id, {
        tone: 'info',
        title: 'График открыт.',
      });
      openDetailTarget('.finance-schedule-panel');
      return;
    }

    if (activeRole === 'finance' && actionId.startsWith('finance-open-warehouse-delivery:')) {
      setOfficeActionOutcome('finance', selectedObject.id, {
        tone: 'info',
        title: 'Статус выдачи открыт.',
      });
      openDetailTarget('.finance-delivery-status-panel');
      return;
    }

    if (isProblemReportAction(actionId)) {
      openProblemReport(activeRole, selectedObject, actionId);
      return;
    }

    if (activeRole === 'warehouse' && applyWarehouseCloseoutAction(selectedObject, actionId)) {
      return;
    }

    if (activeRole === 'warehouse') {
      const selectedWarehouseId = selectedObject.id;
      if (actionId.startsWith('warehouse-export-pallet-list:')) {
        const [, palletId = '', format = 'pdf'] = actionId.split(':');
        if (!['word', 'excel', 'pdf'].includes(format)) {
          setNavigationActionOutcome({
            role: 'warehouse',
            objectId: selectedWarehouseId,
            tone: 'warning',
            title: 'Формат не поддержан.',
            detail: 'Доступны Word, Excel и PDF.',
          });
          return;
        }
        const exportFormat = format as 'word' | 'excel' | 'pdf';
        const formatLabel =
          exportFormat === 'word' ? 'Word' : exportFormat === 'excel' ? 'Excel' : 'PDF';
        updateRoleObject('warehouse', selectedWarehouseId, (object) => {
          const document =
            object.palletListDocument ??
            (object.workbench?.type === 'warehouse'
              ? object.workbench.palletListDocument
              : undefined);
          if (!document || document.palletId !== palletId) return object;
          const nextDocument = {
            ...document,
            auditEvent: 'audit:pallet_list_export_requested' as const,
            exportRequests: (
              document.exportRequests ??
              document.availableFormats?.map((item) => ({
                id: `export-${document.palletId}-${item}`,
                format: item,
                status: 'ready_to_request' as const,
              })) ??
              []
            ).map((request) =>
              request.format === exportFormat
                ? {
                    ...request,
                    status: 'requested' as const,
                    requestedBy: 'Склад',
                    requestedAt: stampNow(),
                  }
                : request,
            ),
          };
          return {
            ...object,
            palletListDocument: nextDocument,
            workbench:
              object.workbench?.type === 'warehouse'
                ? { ...object.workbench, palletListDocument: nextDocument }
                : object.workbench,
            audit: [
              auditEntry(
                object.id,
                'Склад',
                'audit:pallet_list_export_requested',
                `${formatLabel} палетного листа ${palletId} запрошен.`,
              ),
              ...object.audit,
            ],
          };
        });
        setMutatingNavigationActionOutcome(
          {
            role: 'warehouse',
            objectId: selectedWarehouseId,
            tone: 'success',
            title: `${formatLabel} запрошен.`,
            detail: 'Запрос зафиксирован; файл сформирует сервис.',
          },
          actionId,
        );
        return;
      }

      if (actionId.startsWith('warehouse-receive-material:')) {
        updateRoleObject('warehouse', selectedWarehouseId, (object) => {
          const gate = object.materialReceivingGate;
          if (!gate || gate.id !== actionId.slice('warehouse-receive-material:'.length))
            return object;
          const mutationResult = applyWarehouseStockMutation(object, {
            materialId: gate.materialId,
            kind: 'receive',
            qty: gate.acceptedQty,
            reason: `Приемка сырья ${gate.id}: склад ${gate.warehouse}, расхождение ${gate.discrepancyQty > 0 ? '+' : ''}${gate.discrepancyQty} ${gate.unit}.`,
            linkedOrderId: gate.id,
          });
          const currentMaterialFact = mutationResult.object.sections
            .flatMap((section) => section.facts)
            .find(
              (fact) =>
                fact.label.includes(gate.materialLabel) && fact.label.includes('факт склада'),
            );
          const nextMaterialQty =
            numericPrefix(currentMaterialFact?.value ?? '') + gate.acceptedQty;

          return {
            ...mutationResult.object,
            statusLabel: 'Сырье принято',
            facts: updateFactList(
              mutationResult.object.facts,
              {
                'Фактическое сырье': `${gate.materialLabel}: ${nextMaterialQty} ${gate.unit} · складской факт`,
                'Последняя приемка': `${gate.materialLabel}: +${gate.acceptedQty} ${gate.unit}`,
              },
              'warehouse',
            ),
            sections: mutationResult.object.sections.map((section) =>
              section.id === 'raw-material-primary'
                ? {
                    ...section,
                    facts: section.facts.map((fact) =>
                      fact.label.includes(gate.materialLabel) && fact.label.includes('факт склада')
                        ? {
                            ...fact,
                            value: updateReceivingFactValue(
                              fact.value,
                              gate.acceptedQty,
                              gate.unit,
                            ),
                          }
                        : fact,
                    ),
                  }
                : section,
            ),
            actions: mutationResult.object.actions.map((item) =>
              item.id === actionId
                ? {
                    id: `warehouse-material-received:${gate.id}`,
                    label: 'Сырье принято',
                    level: 'disabled' as const,
                    enabled: false,
                    disabledReason: 'Приемка уже записала фактический склад',
                    recoveryOwner: 'Склад',
                    recoveryAction: 'Открыть историю приемки сырья',
                  }
                : item,
            ),
            materialReceivingGate: {
              ...gate,
              receivedAt: stampNow(),
              evidence: [
                ...gate.evidence,
                {
                  label: 'Запись приемки',
                  value: `Принято ${gate.acceptedQty} ${gate.unit}; расхождение ${gate.discrepancyQty > 0 ? '+' : ''}${gate.discrepancyQty} ${gate.unit}`,
                  scope: 'warehouse' as const,
                },
              ],
            },
          };
        });
        setMutatingNavigationActionOutcome(
          {
            role: 'warehouse',
            objectId: selectedWarehouseId,
            tone: 'success',
            title: 'Сырье принято.',
            detail:
              'Фактический склад изменен через приемку сырья; история и подтверждения записаны.',
          },
          actionId,
        );
        return;
      }

      if (actionId.startsWith('warehouse-sign-secondary-transfer:')) {
        updateRoleObject('warehouse', selectedWarehouseId, (object) => ({
          ...object,
          severity: 'info',
          facts: updateFactList(
            object.facts,
            { Перемещение: 'Подписано двумя зав. производства' },
            'warehouse',
          ),
          sections: object.sections.map((section) =>
            section.id === 'secondary-transfer'
              ? {
                  ...section,
                  facts: section.facts.map((fact) =>
                    fact.label === 'Статус'
                      ? { ...fact, value: 'Подписано' }
                      : fact.label === 'Доступный остаток'
                        ? { ...fact, value: '+120 кг' }
                        : fact.label === 'Подписи'
                          ? { ...fact, value: `${fact.value}; Зав. производства Цех 2: подписано` }
                          : fact,
                  ),
                }
              : section,
          ),
          actions: [
            {
              id: 'warehouse-secondary-transfer-signed',
              label: 'Перемещение подписано',
              level: 'disabled' as const,
              enabled: false,
              disabledReason: 'Обе подписи уже записаны',
              recoveryOwner: 'Склад',
              recoveryAction: 'Открыть историю движения',
            },
            ...object.actions.filter(
              (item) => !item.id.startsWith('warehouse-sign-secondary-transfer:'),
            ),
          ],
          audit: [
            auditEntry(
              object.id,
              'Зав. производства Цех 2',
              'audit:secondary_raw_material_transfer_signed',
              'Вторая подпись по перемещению вторичного сырья записана.',
            ),
            ...object.audit,
          ],
        }));
        notifyRole(
          'warehouse',
          selectedWarehouseId,
          'Перемещение подписано',
          'Вторичное сырье доступно после двух подписей зав. производства.',
          'info',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'success',
          'Перемещение подписано',
          'Остаток доступен после двух подписей.',
        );
        return;
      }

      if (actionId.startsWith('warehouse-complete-reserve-task:')) {
        updateRoleObject('warehouse', selectedWarehouseId, (object) => ({
          ...object,
          statusLabel: 'Резерв подготовлен',
          severity: 'info',
          filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Закрытые', 'Завершены'])),
          actions: [
            {
              id: `warehouse-reserve-task-done:${object.id}`,
              label: 'Резерв подготовлен',
              level: 'disabled' as const,
              enabled: false,
              disabledReason: 'Задача склада закрыта',
              recoveryOwner: 'Склад',
              recoveryAction: 'Открыть историю',
            },
          ],
          audit: [
            auditEntry(
              object.id,
              'Склад',
              'audit:warehouse_reserved_rolls_prepared',
              'Резервные рулоны подготовлены под клиентский заказ.',
            ),
            ...object.audit,
          ],
        }));
        notifyRole(
          'commercial',
          selectedWarehouseId,
          'Резерв подготовлен',
          'Склад подготовил рулоны из свободного резерва под заказ.',
          'info',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'success',
          'Резерв подготовлен',
          'Коммерция получила статус по заказу.',
        );
        return;
      }

      if (actionId.startsWith('warehouse-correct-tape:')) {
        const reasonKey = `input:${selectedWarehouseId}:${actionId}`;
        const reason = actionConfirmationInputRef.current[reasonKey];
        if (reason === undefined) {
          setActionConfirmation({
            eyebrow: 'Склад',
            title: 'Корректировка скотча',
            objectTitle: selectedObject.title,
            message:
              'Запишите причину ручной корректировки. Черновая норма остается в прототипе до клиентских замеров.',
            tone: 'warning',
            confirmLabel: 'Записать корректировку',
            details: [
              { label: 'Объект', value: selectedWarehouseId },
              { label: 'Владелец', value: 'Склад' },
              { label: 'Аудит', value: 'Причина обязательна' },
            ],
            input: {
              label: 'Причина корректировки',
              placeholder: 'Например: упаковка клиента требует дополнительный слой',
              requiredMessage: 'Причина обязательна.',
            },
            onConfirm: (value) => {
              actionConfirmationInputRef.current[reasonKey] = value ?? '';
              setActionConfirmation(null);
              window.requestAnimationFrame(() => applyWorkObjectAction(actionId));
            },
          });
          return;
        }
        delete actionConfirmationInputRef.current[reasonKey];
        const normalizedReason = reason.trim();
        if (!normalizedReason) {
          setNavigationActionOutcome({
            role: 'warehouse',
            objectId: selectedWarehouseId,
            tone: 'warning',
            title: 'Причина обязательна.',
            detail: 'Корректировка скотча не записана без причины.',
          });
          return;
        }
        updateRoleObject('warehouse', selectedWarehouseId, (object) => ({
          ...object,
          sections: object.sections.map((section) =>
            section.id === 'tape-draft-norm'
              ? {
                  ...section,
                  facts: [
                    ...section.facts,
                    {
                      label: 'Последняя корректировка',
                      value: `Олег: ${normalizedReason}`,
                      scope: 'warehouse' as const,
                    },
                  ],
                }
              : section,
          ),
          audit: [
            {
              ...auditEntry(
                object.id,
                'Олег',
                'audit:tape_consumption_corrected',
                `Корректировка черновой нормы скотча записана. Причина: ${normalizedReason}.`,
              ),
              reason: normalizedReason,
              oldValue: 'черновой шаблон',
              newValue: 'ручная корректировка',
            },
            ...object.audit,
          ],
        }));
        setMutatingNavigationActionOutcome(
          {
            role: 'warehouse',
            objectId: selectedWarehouseId,
            tone: 'success',
            title: 'Корректировка скотча записана.',
            detail: 'Норма остается черновой до клиентских замеров.',
          },
          actionId,
        );
        notifyRole(
          'director',
          selectedWarehouseId,
          'Корректировка скотча',
          'Олег записал причину корректировки черновой нормы.',
          'info',
        );
        return;
      }

      if (actionId.startsWith('warehouse.scan:')) {
        dispatchRuntimeAction({
          type: 'warehouse.scan',
          acceptanceId: actionId.slice('warehouse.scan:'.length),
        });
        playPrototypeBeep();
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'success',
          'QR принят складом',
          'Счетчик приемки обновлен.',
        );
        return;
      }
      if (actionId.startsWith('warehouse.scan_duplicate:')) {
        dispatchRuntimeAction({
          type: 'warehouse.scan_duplicate',
          acceptanceId: actionId.slice('warehouse.scan_duplicate:'.length),
        });
        notifyRole(
          'director',
          selectedWarehouseId,
          'Дубликат QR на складе',
          'Склад зафиксировал duplicate scan; счетчик приемки не изменился.',
          'warning',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'warning',
          'Дубликат QR записан',
          'Счетчик приемки не изменился.',
        );
        return;
      }
      if (actionId.startsWith('warehouse.scan_wrong:')) {
        dispatchRuntimeAction({
          type: 'warehouse.scan_wrong',
          acceptanceId: actionId.slice('warehouse.scan_wrong:'.length),
        });
        notifyRole(
          'director',
          selectedWarehouseId,
          'Чужой QR на складе',
          'Склад зафиксировал foreign QR; счетчик приемки не изменился.',
          'warning',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'warning',
          'Чужой QR записан',
          'Счетчик приемки не изменился.',
        );
        return;
      }
      if (actionId.startsWith('warehouse.delivery.close:')) {
        dispatchRuntimeAction({
          type: 'warehouse.delivery.close',
          acceptanceId: actionId.slice('warehouse.delivery.close:'.length),
        });
        notifyRole(
          'finance',
          financeIdFromOrderId(
            selectedObject.facts.find((fact) => fact.label === 'Заказ')?.value ??
              selectedWarehouseId,
          ),
          'Выдача закрыта',
          'Склад закрыл выдачу; финансы получили payment trigger.',
          'warning',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'success',
          'Выдача закрыта',
          'Финансы получили платежный триггер.',
        );
        return;
      }
      if (actionId.startsWith('warehouse.partial:')) {
        dispatchRuntimeAction({
          type: 'warehouse.partial_accept',
          acceptanceId: actionId.slice('warehouse.partial:'.length),
        });
        notifyRole(
          'director',
          selectedWarehouseId,
          'Частичная приемка',
          'Склад зафиксировал недостачу; accepted count не увеличен.',
          'warning',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'warning',
          'Частичная приемка записана',
          'Недостача осталась видимой в карточке.',
        );
        return;
      }
      if (actionId.startsWith('warehouse.problem:') || actionId.startsWith('warehouse.return:')) {
        notifyRole(
          'director',
          selectedWarehouseId,
          'Складское исключение',
          'Склад зафиксировал исключение; директор видит подтверждение без складских кнопок сканирования.',
          'warning',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'warning',
          'Складское исключение записано',
          'Директор получил подтверждение.',
        );
        return;
      }
      if (
        [
          'scan',
          'scan-ready',
          'scan-wrong',
          'scan-partial',
          'scan-delivery',
          'manual',
          'manual-ready',
          'manual-wrong',
          'refresh-wait',
        ].includes(actionId)
      ) {
        updateRoleObject('warehouse', selectedWarehouseId, (object) =>
          resolveWarehouseScanObject(
            object,
            'Склад',
            actionId.startsWith('manual') || actionId === 'refresh-wait' ? 'manual' : 'scan',
          ),
        );
        if (!actionId.startsWith('manual') && actionId !== 'refresh-wait') playPrototypeBeep();
        if (actionId === 'scan-delivery') {
          notifyRole(
            'finance',
            financeIdFromOrderId(factValue(selectedObject, 'Заказ') ?? selectedWarehouseId),
            'Выдача закрыта',
            'Склад закрыл выдачу; финансовый срок запущен в рабочем контуре.',
            'info',
          );
        }
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          actionId.includes('wrong') || actionId.includes('partial') ? 'warning' : 'success',
          actionId === 'scan-delivery' ? 'Выдача закрыта' : 'Скан обработан',
          actionId === 'scan-delivery'
            ? 'Финансы получили платежный триггер.'
            : 'Статус складской карточки обновлен.',
        );
        return;
      }
      if (actionId === 'partial' || actionId === 'partial-receiving') {
        updateRoleObject('warehouse', selectedWarehouseId, (object) =>
          resolveWarehouseScanObject(object, 'Склад', 'partial'),
        );
        notifyRole(
          'director',
          selectedWarehouseId,
          selectedObject.workbench?.type === 'warehouse' &&
            selectedObject.workbench.mode === 'delivery'
            ? 'Частичная выдача'
            : 'Частичная приемка',
          'Склад оформил частичное исключение с подтверждением и владельцем восстановления.',
          'warning',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'warning',
          selectedObject.workbench?.type === 'warehouse' &&
            selectedObject.workbench.mode === 'delivery'
            ? 'Частичная выдача записана'
            : 'Частичная приемка записана',
          'Исключение осталось видимым в карточке.',
        );
        return;
      }
      if (actionId.startsWith('reject')) {
        updateRoleObject('warehouse', selectedWarehouseId, (object) =>
          resolveWarehouseScanObject(object, 'Склад', 'reject'),
        );
        notifyRole(
          'director',
          selectedWarehouseId,
          'Складское исключение',
          'Склад оформил исключение с причиной, владельцем восстановления и историей действий.',
          'warning',
        );
        showMutationToast(
          'warehouse',
          selectedWarehouseId,
          actionId,
          'warning',
          'Складское исключение записано',
          'Директор получил карточку исключения.',
        );
        return;
      }
    }

    if (activeRole === 'admin' && actionId.startsWith('admin.device.tested:')) {
      if (selectedObject.severity === 'info') {
        setNavigationActionOutcome({
          role: 'admin',
          objectId: selectedObject.id,
          tone: 'info',
          title: 'Уже в норме.',
          detail: 'Новая запись не нужна; служебные детали остаются в карточке.',
        });
        return;
      }
      dispatchRuntimeAction({
        type: 'admin.device.tested',
        deviceId: actionId.slice('admin.device.tested:'.length),
      });
      const isSourceDiagnostic =
        selectedObject.workbench?.type === 'admin' &&
        selectedObject.workbench.entityType === 'source';
      notifyRole(
        'admin',
        selectedObject.id,
        isSourceDiagnostic ? 'Учётный источник проверен' : 'Диагностика записана',
        isSourceDiagnostic
          ? 'Проверка источника записала снимок и распознанный результат без изменения оплат.'
          : 'Проверка устройства записала сырой сигнал и распознанный результат без производственного действия.',
        'info',
      );
      showMutationToast(
        'admin',
        selectedObject.id,
        actionId,
        'success',
        isSourceDiagnostic ? 'Учётный источник проверен' : 'Диагностика записана',
        isSourceDiagnostic ? 'Снимок источника сохранен.' : 'Результат проверки сохранен.',
      );
      return;
    }

    if (activeRole === 'admin' && actionId.startsWith('admin-history:')) {
      const historyObjectId = 'ADM-HISTORY-01';
      setActiveSectionByRole((current) => ({ ...current, admin: 'Проблемы / история' }));
      setFilter('Все');
      setQueueDateScopeByRole((current) => ({ ...current, admin: 'all' }));
      setSelectedByRole((current) => ({ ...current, admin: historyObjectId }));
      const url = new URL(window.location.href);
      url.searchParams.set('role', 'admin');
      url.searchParams.set('section', 'Проблемы / история');
      url.searchParams.set('object', historyObjectId);
      window.history.replaceState(null, '', url);
      setMutatingNavigationActionOutcome(
        {
          role: 'admin',
          objectId: historyObjectId,
          tone: 'info',
          title: 'Журнал открыт.',
          detail: 'Показан раздел проблем и истории без изменения статуса объекта.',
        },
        actionId,
      );
      return;
    }

    if (
      activeRole === 'admin' &&
      (actionId.startsWith('admin-template-save-') ||
        [
          'admin-retry-finance-source',
          'admin-retry-source-health',
          'admin-check-scale',
          'admin-bind-scanner',
          'admin-forward-finance-source',
          'admin-forward-owner',
          'admin-assign-template',
          'admin-save-user-role',
        ].includes(actionId))
    ) {
      const actionLabel = actionId.startsWith('admin-template-save-')
        ? 'Шаблон сохранен'
        : actionId === 'admin-retry-finance-source' || actionId === 'admin-retry-source-health'
          ? 'Повторная проверка учётного источника'
          : actionId === 'admin-check-scale'
            ? 'Связь не восстановлена'
            : actionId === 'admin-bind-scanner'
              ? 'Рабочее место не назначено'
              : actionId === 'admin-forward-owner' || actionId === 'admin-forward-finance-source'
                ? 'Передано владельцу'
                : actionId === 'admin-assign-template'
                  ? 'Шаблон назначен'
                  : 'Доступ сохранен';

      if (actionId === 'admin-retry-source-health' && selectedObject.severity === 'info') {
        setNavigationActionOutcome({
          role: 'admin',
          objectId: selectedObject.id,
          tone: 'info',
          title: 'Учётный источник отвечает.',
          detail: 'Источник оплат отвечает; повторная проверка не меняет карточку.',
        });
        return;
      }

      if (actionId === 'admin-forward-owner' || actionId === 'admin-forward-finance-source') {
        updateRoleObject('admin', selectedObject.id, (object) =>
          delegateAdminDiagnosticObject(object, 'Админ', actionLabel),
        );
      } else if (actionId === 'admin-check-scale') {
        updateRoleObject('admin', selectedObject.id, (object) =>
          recordAdminDiagnosticIssueObject(object, 'Админ', {
            status: 'Связь не восстановлена',
            result: 'Весы не отвечают после проверки связи.',
            recovery:
              'Проверить питание, кабель/USB или Ethernet, затем передать админу смены до повторного взвешивания.',
            ownerActionLabel: 'Передать админу смены',
            repeatActionId: 'admin-check-scale',
            repeatActionLabel: 'Повторить проверку связи',
          }),
        );
      } else if (actionId === 'admin-bind-scanner') {
        updateRoleObject('admin', selectedObject.id, (object) =>
          recordAdminDiagnosticIssueObject(object, 'Админ', {
            status: 'Нужна привязка рабочего места',
            result: 'Сканер отвечает, но не назначен складу.',
            recovery:
              'Назначить рабочее место склада или передать владельцу склада до следующей приемки.',
            ownerActionLabel: 'Передать складу',
            repeatActionId: 'admin-bind-scanner',
            repeatActionLabel: 'Повторить проверку привязки',
          }),
        );
      } else {
        updateRoleObject('admin', selectedObject.id, (object) =>
          resolveAdminDiagnosticObject(object, 'Админ', actionLabel),
        );
      }

      if (actionId === 'admin-retry-finance-source') {
        notifyRole(
          'finance',
          selectedObject.id,
          'Учётный источник проверен',
          'Админ закрыл диагностическую проблему; бухгалтерия может повторить проверку счета в своем контуре.',
          'info',
        );
      }
      if (actionId === 'admin-forward-finance-source') {
        notifyRole(
          'finance',
          selectedObject.id,
          'Проверка передана бухгалтерии',
          'Админ передал диагностическую проблему без изменения оплаты.',
          'warning',
        );
      }
      showMutationToast(
        'admin',
        selectedObject.id,
        actionId,
        actionId === 'admin-forward-owner' ||
          actionId === 'admin-forward-finance-source' ||
          actionId === 'admin-check-scale' ||
          actionId === 'admin-bind-scanner'
          ? 'warning'
          : 'success',
        actionLabel,
        actionId === 'admin-forward-owner' || actionId === 'admin-forward-finance-source'
          ? 'Проблема осталась открытой у владельца.'
          : actionId === 'admin-check-scale'
            ? 'Весы не отвечают; проверьте физическое подключение и передайте админу смены.'
            : actionId === 'admin-bind-scanner'
              ? 'Сканер отвечает, но рабочее место не назначено.'
              : actionId.includes('source')
                ? 'Бухгалтерия может повторить проверку счета.'
                : 'Изменение записано в истории.',
      );
      return;
    }

    if (activeRole === 'finance' && actionId.startsWith('finance-edit-material-cost:')) {
      const materialId = actionId.slice('finance-edit-material-cost:'.length);
      updateRoleObject('warehouse', 'WH-INV-RAW', (object) =>
        upsertManualMaterialCostReference(object, materialId),
      );
      setMutatingOfficeActionOutcome('finance', selectedObject.id, actionId, {
        tone: 'success',
        title: 'Учетная цена обновлена.',
        detail: 'Старая и новая цена, источник и причина изменения записаны в историю сырья.',
      });
      return;
    }

    if (activeRole === 'director' && actionId.startsWith('director-override-material-cost:')) {
      const materialId = actionId.slice('director-override-material-cost:'.length);
      updateRoleObject('warehouse', 'WH-INV-RAW', (object) =>
        approveMaterialCostReference(object, materialId),
      );
      showMutationToast(
        'director',
        selectedObject.id,
        actionId,
        'success',
        'Учетная цена утверждена.',
        'Директорское утверждение цены записано с причиной и источником.',
      );
      return;
    }

    if (activeRole === 'admin' && actionId.startsWith('admin-material-cost-source:')) {
      showMutationToast(
        'admin',
        selectedObject.id,
        actionId,
        'info',
        'Настройки источника открыты',
        'Админ меняет источник/маппинг; бизнес-цену задают финансы или директор.',
      );
      return;
    }

    const action = getWorkObjectAction(activeRole, actionId);

    if (activeRole === 'commercial') {
      if (actionId.startsWith('commercial-material-')) {
        const blockerId = actionId.split(':')[1] ?? '';
        const blocker = selectedObject.materialShortageBlockers?.find(
          (item) => item.id === blockerId || item.positionId === blockerId,
        );
        const label = blocker
          ? `${blocker.label}: не хватает ${blocker.shortageQty} ${blocker.unit}`
          : 'Дефицит сырья';
        if (actionId.startsWith('commercial-material-recheck:')) {
          updateRoleObject('commercial', selectedObject.id, (object) => ({
            ...object,
            audit: [
              auditEntry(
                object.id,
                'Коммерция',
                'audit:commercial_material_recheck_requested',
                `${label}; склад получил короткую задачу перепроверить факт.`,
              ),
              ...object.audit,
            ],
          }));
          notifyRole('warehouse', selectedObject.id, 'Проверить сырье', label, 'warning');
          setMutatingNavigationActionOutcome(
            {
              role: 'commercial',
              objectId: selectedObject.id,
              tone: 'warning',
              title: 'Склад получил проверку.',
              detail: label,
            },
            actionId,
          );
          return;
        }
        if (actionId.startsWith('commercial-material-edit:')) {
          updateRoleObject('commercial', selectedObject.id, (object) => ({
            ...object,
            audit: [
              auditEntry(
                object.id,
                'Коммерция',
                'audit:commercial_material_position_edit_opened',
                `Открыта inline-правка строки ${blockerId} из блока нехватки сырья.`,
              ),
              ...object.audit,
            ],
          }));
          setMutatingNavigationActionOutcome(
            {
              role: 'commercial',
              objectId: selectedObject.id,
              tone: 'info',
              title: 'Позиция открыта на правке.',
              detail: 'Измени строку прямо в таблице.',
            },
            actionId,
          );
          openDetailTarget('.commercial-position-matrix');
          return;
        }
        if (actionId.startsWith('commercial-material-production:')) {
          updateRoleObject('commercial', selectedObject.id, (object) => ({
            ...object,
            audit: [
              auditEntry(
                object.id,
                'Коммерция',
                'audit:commercial_material_sent_to_production',
                `${label}; зав. производства получил блокер по сырью.`,
              ),
              ...object.audit,
            ],
          }));
          notifyRole('production', selectedObject.id, 'Дефицит сырья', label, 'warning');
          setMutatingNavigationActionOutcome(
            {
              role: 'commercial',
              objectId: selectedObject.id,
              tone: 'warning',
              title: 'Передано в производство.',
              detail: label,
            },
            actionId,
          );
          return;
        }
      }

      if (action.kind === 'commercialEditParams' && action.targetId) {
        const payload = parseCommercialPositionSavePayload(action.targetId);
        if (!payload) {
          setNavigationActionOutcome({
            role: 'commercial',
            objectId: selectedObject.id,
            tone: 'warning',
            title: 'Позиция не сохранена.',
            detail: 'Не удалось прочитать данные строки.',
          });
          return;
        }
        const targetPosition = selectedObject.commercialOrder?.positions.find(
          (position) => position.id === payload.positionId,
        );
        if (!targetPosition) {
          setNavigationActionOutcome({
            role: 'commercial',
            objectId: selectedObject.id,
            tone: 'warning',
            title: 'Позиция не сохранена.',
            detail: 'Позиция отсутствует в актуальной версии заявки.',
          });
          return;
        }

        if (!isCommercialLive) {
          const updatedObject = updateCommercialPositionFromPayload(selectedObject, payload);
          updateRoleObject('commercial', selectedObject.id, () => updatedObject);
          const nextSection = getCommercialOrderStage(updatedObject)?.bucket;
          if (nextSection) keepCommercialObjectVisible(updatedObject.id, nextSection);
          setMutatingNavigationActionOutcome(
            {
              role: 'commercial',
              objectId: selectedObject.id,
              tone: 'success',
              title: 'Позиция сохранена',
              detail: `${targetPosition.id}: параметры и локальные значения обновлены.`,
            },
            'commercial-edit-params',
          );
          return;
        }

        const currentCoverQty = selectedObject.warehouseCoverProposals?.find(
          (proposal) => proposal.positionId === payload.positionId,
        )?.coverQty;
        const mutationPlan = buildCommercialPositionMutationPlan({
          draft: payload.draft,
          position: targetPosition,
          rawMaterialStocks: selectedObject.rawMaterialStocks ?? [],
          sourcePositions: selectedObject.commercialOrder?.positions ?? [],
          currentCoverQty,
        });
        void saveCommercialOrderPosition(
          selectedObject.id,
          payload.positionId,
          mutationPlan.positionUpdate,
          mutationPlan.route,
        )
          .then((savedObject) => {
            const updatedObject = {
              ...savedObject,
              rawMaterialStocks: selectedObject.rawMaterialStocks,
            };
            updateRoleObject('commercial', selectedObject.id, () => updatedObject);
            const nextSection = getCommercialOrderStage(updatedObject)?.bucket;
            if (nextSection) keepCommercialObjectVisible(updatedObject.id, nextSection);
            setMutatingNavigationActionOutcome(
              {
                role: 'commercial',
                objectId: selectedObject.id,
                tone: 'success',
                title: 'Позиция сохранена',
                detail: `${targetPosition.id}: параметры записаны в заявку.`,
              },
              'commercial-edit-params',
            );
          })
          .catch((error: unknown) => {
            showMutationToast(
              'commercial',
              selectedObject.id,
              'commercial-edit-params',
              'critical',
              'Позиция не сохранена',
              error instanceof Error ? error.message : 'Изменение не записано.',
            );
          });
        return;
      }

      if (
        action.kind === 'commercialEditParams' ||
        action.kind === 'commercialAddPosition' ||
        action.kind === 'commercialDuplicatePosition'
      ) {
        const label =
          action.kind === 'commercialAddPosition'
            ? 'Добавление позиции открыто'
            : action.kind === 'commercialDuplicatePosition'
              ? 'Дублирование позиции открыто'
              : 'Редактор параметров открыт';
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'audit:commercial_params_editor_opened',
              `${label}; изменения остаются в черновом контуре до сохранения.`,
            ),
            ...object.audit,
          ],
        }));
        setNavigationActionOutcome({
          role: 'commercial',
          objectId: selectedObject.id,
          tone: 'info',
          title: label,
          detail:
            'До старта производства доступна прямая правка параметров с фиксацией прежнего и нового значения.',
        });
        openDetailTarget('.commercial-position-matrix');
        return;
      }

      if (action.kind === 'commercialCreatePositionTemplate') {
        const positionId = action.targetId;
        const position = selectedObject.commercialOrder?.positions.find(
          (item) => item.id === positionId,
        );
        const counterparty = counterpartyForObject(selectedObject);
        if (!position || !counterparty) return;

        const templateId = `tpl-position-${position.id}-${Date.now()}`;
        const versionId = `tplv-position-${position.id}-${Date.now()}`;
        const fields: CounterpartyOrderTemplateField[] = [
          {
            label: 'Позиции',
            value: `${position.rollCount} шт., ${position.filmType} ${position.actualThickness}`,
            kind: 'production',
            required: true,
          },
          { label: 'Тип пленки', value: position.filmType, kind: 'production', required: true },
          { label: 'Толщина', value: position.actualThickness, kind: 'production', required: true },
          {
            label: 'Ширина, мм',
            value: position.widthMm == null ? '' : String(position.widthMm),
            kind: 'production',
            required: true,
          },
          {
            label: 'Метраж, м',
            value: position.plannedLengthM == null ? '' : String(position.plannedLengthM),
            kind: 'production',
            required: true,
          },
          { label: 'Цвет', value: 'Из строки позиции', kind: 'production', required: true },
          {
            label: 'Рулоны',
            value: `${position.rollCount} шт.`,
            kind: 'production',
            required: true,
          },
          { label: 'Сырье', value: position.rawMaterialLabel, kind: 'production', required: true },
          {
            label: 'Втулка',
            value: position.spoolType.replace(/^Шпуля\s*/i, ''),
            kind: 'production',
            required: true,
          },
          {
            label: 'Расходники',
            value: 'Скотч, этикетка, упаковка',
            kind: 'production',
            required: true,
          },
        ];
        const templateName = `${counterparty.legalName} · ${templateNameFromFields(fields)}`;
        const nextTemplate: CounterpartyOrderTemplate = {
          id: templateId,
          counterpartyId: counterparty.id,
          name: templateName,
          activeVersionId: versionId,
          status: 'active',
          ownerRole: 'Коммерция',
          usageCount: 0,
          lastUsedAt: 'еще не применялся',
          updatedAt: stampNow(),
        };
        const nextVersion: CounterpartyOrderTemplateVersion = {
          id: versionId,
          templateId,
          version: 'v1.0',
          fields,
          reason: `Создан из строки ${position.id}.`,
          createdBy: 'Коммерция',
          createdAt: stampNow(),
          affectsProduction: true,
          affectsMoney: false,
        };

        setTemplateCatalog((current) => [nextTemplate, ...current]);
        setTemplateVersions((current) => [nextVersion, ...current]);
        setSelectedTemplateByObject((current) => ({ ...current, [selectedObject.id]: templateId }));
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          positionTemplateApplications: [
            {
              id: `PTA-${position.id}-${Date.now()}`,
              orderId: object.id,
              positionId: position.id,
              templateId,
              templateVersionId: versionId,
              diffAcceptedAt: stampNow(),
              createdFromPosition: true,
            },
            ...(object.positionTemplateApplications ?? []),
          ],
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'audit:position_template_versioned',
              `Версия ${nextVersion.version} создана из строки ${position.id}.`,
            ),
            auditEntry(
              object.id,
              'Коммерция',
              'audit:position_template_created',
              `Шаблон позиции клиента создан: ${templateName}.`,
            ),
            ...object.audit,
          ],
        }));
        setMutatingNavigationActionOutcome(
          {
            role: 'commercial',
            objectId: selectedObject.id,
            tone: 'success',
            title: 'Шаблон позиции создан.',
            detail: 'Создана версия из строки позиции; это не справочник товара.',
          },
          actionId,
        );
        openDetailTarget('.commercial-template-panel');
        return;
      }

      if (action.kind === 'commercialApplyPositionTemplate') {
        const [positionId, templateId] = (action.targetId ?? '').split('|');
        const templateItem = templateCatalog.find((item) => item.id === templateId);
        const versionItem = templateItem
          ? activeVersionForTemplate(templateItem, templateVersions)
          : null;
        const productionStarted =
          selectedObject.commercialOrder?.productionStatus === 'in_production' ||
          selectedObject.commercialOrder?.productionStatus === 'ready' ||
          Boolean(selectedObject.commercialProductionProgress) ||
          Boolean(
            selectedObject.productionProblems?.some((problem) => problem.status !== 'resolved'),
          );
        if (!templateItem || !versionItem || !positionId || productionStarted) {
          setNavigationActionOutcome({
            role: 'commercial',
            objectId: selectedObject.id,
            tone: 'warning',
            title: 'Прямое применение закрыто.',
            detail:
              'После старта производства шаблон можно проводить только через запрос изменения.',
          });
          openDetailTarget('.commercial-production-problem-panel');
          return;
        }

        updateRoleObject('commercial', selectedObject.id, (object) => {
          const position = object.commercialOrder?.positions.find((item) => item.id === positionId);
          const diffs = position
            ? positionTemplateDiffsForPosition(position, templateItem, templateVersions)
            : [];
          if (!position || diffs.length === 0) return object;
          const patchedPosition = positionPatchFromTemplate(
            position,
            templateItem,
            templateVersions,
          );
          return {
            ...object,
            facts: updateFactList(
              object.facts,
              {
                Шаблон: templateItem.name,
                Позиции: `${object.commercialOrder?.positions.length ?? 1} поз., ${object.commercialOrder?.positions.reduce((sum, item) => sum + (item.id === positionId ? patchedPosition.rollCount : item.rollCount), 0) ?? patchedPosition.rollCount} рул.`,
              },
              'commercial',
            ),
            commercialOrder: object.commercialOrder
              ? {
                  ...object.commercialOrder,
                  positions: object.commercialOrder.positions.map((item) =>
                    item.id === positionId ? patchedPosition : item,
                  ),
                }
              : object.commercialOrder,
            positionTemplateApplications: [
              {
                id: `PTA-${positionId}-${Date.now()}`,
                orderId: object.id,
                positionId,
                templateId: templateItem.id,
                templateVersionId: versionItem.id,
                diffAcceptedAt: stampNow(),
                appliedAt: stampNow(),
              },
              ...(object.positionTemplateApplications ?? []),
            ],
            audit: [
              auditEntry(
                object.id,
                'Коммерция',
                'audit:position_template_applied',
                `Шаблон ${templateItem.name} применен к строке ${positionId}.`,
              ),
              auditEntry(
                object.id,
                'Коммерция',
                'audit:position_template_diff_accepted',
                `Сверка принята: ${diffs.map((diff) => diff.label).join(', ')}.`,
              ),
              ...object.audit,
            ],
          };
        });
        setTemplateCatalog((current) =>
          current.map((item) =>
            item.id === templateItem.id
              ? {
                  ...item,
                  usageCount: item.usageCount + 1,
                  lastUsedAt: stampNow(),
                  updatedAt: stampNow(),
                }
              : item,
          ),
        );
        setSelectedTemplateByObject((current) => ({
          ...current,
          [selectedObject.id]: templateItem.id,
        }));
        setMutatingNavigationActionOutcome(
          {
            role: 'commercial',
            objectId: selectedObject.id,
            tone: 'success',
            title: 'Шаблон применен после сверки.',
            detail: `Принята версия ${versionItem.version}; изменения записаны в историю.`,
          },
          actionId,
        );
        openDetailTarget('.commercial-template-panel');
        return;
      }

      if (action.kind === 'commercialRequestCorrection') {
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'audit:commercial_position_correction_requested',
              'Открыта форма запроса изменения параметров после старта производства.',
            ),
            ...object.audit,
          ],
        }));
        setNavigationActionOutcome({
          role: 'commercial',
          objectId: selectedObject.id,
          tone: 'warning',
          title: 'Запрос изменения параметров.',
          detail: 'Прямая правка закрыта после старта производства; нужен запрос с причиной.',
        });
        openDetailTarget('.commercial-position-matrix');
        return;
      }

      if (action.kind === 'commercialApplyProblemCorrection') {
        const productionId = productionIdFromCommercialId(selectedObject.id);
        const activeProductionProblem = selectedObject.productionProblems?.find(
          (problem) => problem.status !== 'resolved',
        );
        const fallbackRoll =
          activeProductionProblem?.currentRollNumber ??
          selectedObject.commercialProductionProgress?.currentRollNumber ??
          1;
        const correction = parseCorrectionTarget(action.targetId, fallbackRoll);
        const correctionCaseId = `ORC-${selectedObject.id}-RECIPE-${Date.now()}`;
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          severity: object.severity === 'critical' ? object.severity : 'warning',
          productionProblems: object.productionProblems?.map((problem) =>
            problem.status !== 'resolved'
              ? { ...problem, status: 'correction_requested' as const }
              : problem,
          ),
          orderResolutionCases: upsertResolutionCase(object.orderResolutionCases, {
            id: correctionCaseId,
            orderId: productionId,
            type: 'production_current_roll_resolution',
            status: 'awaiting_production',
            ownerRole: 'production_lead',
            nextOwnerRole: 'production_lead',
            createdByRole: 'commercial',
            affectedPositionIds: activeProductionProblem?.positionId
              ? [activeProductionProblem.positionId]
              : (object.commercialOrder?.positions.map((position) => position.id) ?? []),
            affectedRollIds: activeProductionProblem?.rollId
              ? [activeProductionProblem.rollId]
              : [],
            reason: `${correction.reason} Изменение применяется с рулона ${correction.appliesFromRollNumber}. Текущий рулон: ${currentRollResolutionLabels[correction.currentRollResolution]}.`,
            outcome: correction.currentRollResolution,
            createdAt: stampNow(),
            recipeCorrectionRequest: {
              caseId: correctionCaseId,
              problemId: activeProductionProblem?.id,
              positionId: activeProductionProblem?.positionId,
              oldRecipeSnapshotId: object.commercialOrder?.positions[0]?.recipeSnapshot.id,
              newRecipeSnapshotId: `${object.commercialOrder?.positions[0]?.recipeSnapshot.id ?? 'recipe'}-change-${correction.appliesFromRollNumber}`,
              reason: correction.reason,
              appliesFromRollNumber: correction.appliesFromRollNumber,
              currentRollResolution: correction.currentRollResolution,
              notifiedRoles: ['production_lead'],
            },
          }),
          actions: object.actions.map((item) =>
            item.id === 'commercial-open-production-problem'
              ? {
                  ...item,
                  label: 'Изменение передано производству',
                  level: 'disabled' as const,
                  enabled: false,
                  disabledReason: 'Ждем решение зав. производства по текущему рулону',
                  recoveryAction: 'Статус производства',
                  recoveryOwner: 'Коммерция',
                }
              : item,
          ),
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'audit:correction_applies_from_roll_set',
              `Новая версия применяется с рулона ${correction.appliesFromRollNumber}; причина: ${correction.reason}. Активный рулон не меняется без решения зав. производства.`,
            ),
            auditEntry(
              object.id,
              'Коммерция',
              'audit:recipe_correction_applied',
              'Изменение позиции после проблемы производства передано зав. производства.',
            ),
            ...object.audit,
          ],
        }));
        updateRoleObject('production', productionId, (object) => ({
          ...object,
          severity: 'warning',
          facts: updateFactList(
            object.facts,
            {
              'Причина изменения': correction.reason,
              'Изменение с рулона': `с рулона ${correction.appliesFromRollNumber}`,
              'Текущий рулон': currentRollResolutionLabels[correction.currentRollResolution],
            },
            'production',
          ),
          actions: [
            {
              id: 'production-resolve-current-roll:finish_old_version',
              label: 'Закончить текущий рулон старой версией',
              level: 'recommended' as const,
              enabled: true,
            },
            {
              id: 'production-resolve-current-roll:stop_and_apply_new',
              label: 'Остановить и применить новую версию',
              level: 'peer' as const,
              enabled: true,
            },
            {
              id: 'production-resolve-current-roll:mark_defect',
              label: 'Отметить текущий рулон как брак',
              level: 'secondary' as const,
              enabled: true,
            },
            ...object.actions.filter(
              (item) => !item.id.startsWith('production-resolve-current-roll:'),
            ),
          ],
          orderResolutionCases: upsertResolutionCase(object.orderResolutionCases, {
            id: correctionCaseId,
            orderId: productionId,
            type: 'production_current_roll_resolution',
            status: 'awaiting_production',
            ownerRole: 'production_lead',
            nextOwnerRole: 'production_lead',
            createdByRole: 'commercial',
            affectedPositionIds: activeProductionProblem?.positionId
              ? [activeProductionProblem.positionId]
              : [],
            affectedRollIds: activeProductionProblem?.rollId
              ? [activeProductionProblem.rollId]
              : [],
            reason: `${correction.reason} Изменение действует с рулона ${correction.appliesFromRollNumber}; реши активный рулон отдельно.`,
            outcome: correction.currentRollResolution,
            createdAt: stampNow(),
          }),
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'audit:correction_applies_from_roll_set',
              `Изменение действует с рулона ${correction.appliesFromRollNumber}; причина: ${correction.reason}. Требуется решение по текущему рулону.`,
            ),
            auditEntry(
              object.id,
              'Коммерция',
              'audit:recipe_correction_applied',
              'Коммерция передала финализированную производственную часть без сырого отказа.',
            ),
            ...object.audit,
          ],
        }));
        notifyRole(
          'production',
          productionId,
          'Нужно решить текущий рулон',
          `Коммерция изменила позицию с рулона ${correction.appliesFromRollNumber}. Выбери действие для активного рулона.`,
          'warning',
        );
        setSelectedByRole((current) => ({ ...current, production: productionId }));
        setMutatingNavigationActionOutcome(
          {
            role: 'commercial',
            objectId: selectedObject.id,
            tone: 'success',
            title: 'Изменение передано производству.',
            detail: `Новая версия действует с рулона ${correction.appliesFromRollNumber}; активный рулон решает зав. производства.`,
          },
          actionId,
        );
        return;
      }

      if (action.kind === 'commercialOpenProductionProblem') {
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          productionProblems: object.productionProblems?.map((problem) =>
            problem.status === 'open'
              ? { ...problem, status: 'seen_by_commercial' as const }
              : problem,
          ),
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'audit:production_problem_seen_by_commercial',
              'Коммерция открыла проблему из производства и видит текущий прогресс по рулонам.',
            ),
            ...object.audit,
          ],
        }));
        setNavigationActionOutcome({
          role: 'commercial',
          objectId: selectedObject.id,
          tone: 'warning',
          title: 'Проблема производства открыта.',
          detail: 'Проверь прогресс, позицию и отправь correction с причиной.',
        });
        openDetailTarget('.commercial-production-problem-panel');
        return;
      }

      if (action.kind === 'commercialOpenPaymentShipment') {
        openDetailTarget('.commercial-payment-shipment-strip');
        return;
      }

      if (action.kind === 'commercialOpenWarehouseResolution') {
        updateRoleObject('commercial', selectedObject.id, (object) => {
          const requestedQty =
            object.commercialOrder?.positions.reduce(
              (sum, position) => sum + position.rollCount,
              0,
            ) ?? 0;
          const coveredQty = (object.warehouseCoverProposals ?? []).reduce(
            (sum, proposal) => sum + proposal.coverQty,
            0,
          );
          const missingQty = (object.warehouseCoverProposals ?? []).reduce(
            (sum, proposal) => sum + proposal.missingQty,
            0,
          );
          const caseId = `ORC-${object.id}-WAREHOUSE`;
          return {
            ...object,
            orderResolutionCases: upsertResolutionCase(object.orderResolutionCases, {
              id: caseId,
              orderId: productionIdFromCommercialId(object.id),
              type: 'warehouse_cover_resolution',
              status: 'awaiting_commercial',
              ownerRole: 'commercial',
              nextOwnerRole: 'commercial',
              createdByRole: 'commercial',
              affectedPositionIds:
                object.commercialOrder?.positions.map((position) => position.id) ?? [],
              reason: 'Коммерция разбирает, принять ли складское покрытие или изменить маршрут.',
              createdAt: stampNow(),
              warehouseCoverResolution: {
                caseId,
                proposalIds: (object.warehouseCoverProposals ?? []).map((proposal) => proposal.id),
                requestedQty,
                coveredQty,
                missingQty,
              },
            }),
          };
        });
        setNavigationActionOutcome({
          role: 'commercial',
          objectId: selectedObject.id,
          tone: 'info',
          title: 'Решение по резерву открыто.',
          detail:
            'Выбери: принять резерв, запросить перепроверку, изменить позицию или отправить остаток в производство.',
        });
        openDetailTarget('.commercial-resolution-panel');
        return;
      }

      if (action.kind === 'commercialWarehouseResolutionOutcome') {
        const { outcome, reason } = parseWarehouseResolutionTarget(action.targetId);
        const productionId = productionIdFromCommercialId(selectedObject.id);
        const outcomeLabel =
          warehouseResolutionOutcomeLabels[outcome] ?? 'Разбор складского покрытия';
        const requestedQty =
          selectedObject.commercialOrder?.positions.reduce(
            (sum, position) => sum + position.rollCount,
            0,
          ) ?? 0;
        const selectedMissingQty = (selectedObject.warehouseCoverProposals ?? []).reduce(
          (sum, proposal) => sum + proposal.missingQty,
          0,
        );
        const productionQty =
          outcome === 'rejected_send_all_to_production' ? requestedQty : selectedMissingQty;
        const productionDeltaLabel =
          outcome === 'rejected_send_all_to_production'
            ? `${productionQty} рул. к выпуску после снятия складского покрытия`
            : `${productionQty} рул. к выпуску после принятого складского резерва`;
        updateRoleObject('commercial', selectedObject.id, (object) => {
          const caseId = `ORC-${object.id}-WAREHOUSE`;
          const requestedQty =
            object.commercialOrder?.positions.reduce(
              (sum, position) => sum + position.rollCount,
              0,
            ) ?? 0;
          const nextProposals = (object.warehouseCoverProposals ?? []).map((proposal) => {
            if (outcome === 'warehouse_recheck_requested' || outcome === 'edited_position')
              return proposal;
            if (outcome === 'accepted_with_missing_to_production') {
              return {
                ...proposal,
                decision: 'confirmed' as const,
                confirmedBy: 'Коммерция',
                confirmedAt: stampNow(),
                warehouseCoverStatus:
                  proposal.missingQty > 0
                    ? ('partial_confirmed' as const)
                    : ('full_confirmed' as const),
              };
            }
            return {
              ...proposal,
              decision: 'rejected' as const,
              rejectedBy: 'Коммерция',
              rejectionReason: reason,
              warehouseCoverStatus: 'needs_production' as const,
            };
          });
          const coveredQty = nextProposals.reduce((sum, proposal) => sum + proposal.coverQty, 0);
          const missingQty = nextProposals.reduce((sum, proposal) => sum + proposal.missingQty, 0);
          const productionQty =
            outcome === 'rejected_send_all_to_production' ? requestedQty : missingQty;
          const nextCaseStatus =
            outcome === 'warehouse_recheck_requested'
              ? 'awaiting_warehouse'
              : outcome === 'edited_position'
                ? 'awaiting_commercial'
                : 'applied';
          const nextOwnerRole =
            outcome === 'warehouse_recheck_requested'
              ? 'warehouse'
              : outcome === 'edited_position'
                ? 'commercial'
                : 'production_lead';
          const nextWarehouseCoverStatus =
            outcome === 'accepted_with_missing_to_production'
              ? missingQty > 0
                ? ('partial_confirmed' as const)
                : ('full_confirmed' as const)
              : outcome === 'warehouse_recheck_requested'
                ? (object.commercialOrder?.warehouseCoverStatus ?? 'partial_proposed')
                : ('needs_production' as const);
          return {
            ...object,
            severity: 'warning',
            filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Требуют действия'])),
            commercialOrder: object.commercialOrder
              ? {
                  ...object.commercialOrder,
                  warehouseCoverStatus: nextWarehouseCoverStatus,
                  productionStatus:
                    outcome === 'warehouse_recheck_requested' || outcome === 'edited_position'
                      ? object.commercialOrder.productionStatus
                      : productionQty > 0
                        ? ('needs_production' as const)
                        : ('not_started' as const),
                  positions: object.commercialOrder.positions.map((position) => ({
                    ...position,
                    warehouseCoverStatus: nextWarehouseCoverStatus,
                  })),
                }
              : object.commercialOrder,
            warehouseCoverProposals: nextProposals,
            orderResolutionCases: upsertResolutionCase(object.orderResolutionCases, {
              id: caseId,
              orderId: productionId,
              type:
                outcome === 'warehouse_recheck_requested'
                  ? 'warehouse_cover_dispute'
                  : 'warehouse_cover_resolution',
              status: nextCaseStatus,
              ownerRole: nextOwnerRole,
              nextOwnerRole,
              createdByRole: 'commercial',
              affectedPositionIds:
                object.commercialOrder?.positions.map((position) => position.id) ?? [],
              reason,
              outcome,
              createdAt: stampNow(),
              resolvedAt: nextCaseStatus === 'applied' ? stampNow() : undefined,
              warehouseCoverResolution: {
                caseId,
                proposalIds: nextProposals.map((proposal) => proposal.id),
                requestedQty,
                coveredQty,
                missingQty,
                outcome,
                warehouseRecheckTaskId:
                  outcome === 'warehouse_recheck_requested' ? `WH-RECHECK-${object.id}` : undefined,
                productionDeltaOrderId:
                  productionQty > 0 && outcome !== 'warehouse_recheck_requested'
                    ? productionId
                    : undefined,
              },
            }),
            facts: updateFactList(
              object.facts,
              {
                Склад:
                  outcome === 'warehouse_recheck_requested'
                    ? 'Перепроверяет остатки'
                    : outcome === 'accepted_with_missing_to_production'
                      ? 'Подтвержденный резерв'
                      : outcome === 'edited_position'
                        ? 'Ждет правку позиции'
                        : 'Покрытие не используется',
                Производство:
                  outcome === 'warehouse_recheck_requested' || outcome === 'edited_position'
                    ? 'Ждет итог коммерции/склада'
                    : productionQty > 0
                      ? `${productionQty} рул. в заказ-наряд`
                      : 'Не требуется после склада',
              },
              'commercial',
            ),
            actions:
              outcome === 'edited_position'
                ? [
                    {
                      id: 'commercial-edit-params',
                      label: 'Изменить позицию',
                      level: 'peer' as const,
                      enabled: true,
                      helpText:
                        'Коммерция остается владельцем правки; после изменения покрытие пересчитывается и пишется аудит.',
                    },
                    ...object.actions.filter(
                      (item) =>
                        item.id !== 'commercial-reject-warehouse-cover' &&
                        item.id !== 'commercial-open-warehouse-resolution',
                    ),
                  ]
                : object.actions.map((item) =>
                    item.id === 'commercial-reject-warehouse-cover' ||
                    item.id === 'commercial-open-warehouse-resolution'
                      ? {
                          ...item,
                          label: outcomeLabel,
                          level: 'disabled' as const,
                          enabled: false,
                          disabledReason: 'Решение по покрытию уже записано',
                          recoveryAction:
                            outcome === 'warehouse_recheck_requested'
                              ? 'Дождаться перепроверки склада'
                              : 'Открыть историю заявки',
                          recoveryOwner:
                            outcome === 'warehouse_recheck_requested' ? 'Склад' : 'Коммерция',
                        }
                      : item,
                  ),
            audit: [
              auditEntry(
                object.id,
                'Коммерция',
                'audit:warehouse_cover_disputed',
                `Разбор складского покрытия: ${outcomeLabel}. Причина: ${reason}.`,
              ),
              ...(outcome === 'warehouse_recheck_requested'
                ? [
                    auditEntry(
                      object.id,
                      'Коммерция',
                      'audit:warehouse_recheck_requested',
                      'Складу создана задача перепроверить остатки; заказ-наряд пока не изменен.',
                    ),
                  ]
                : []),
              ...(outcome === 'accepted_with_missing_to_production'
                ? [
                    auditEntry(
                      object.id,
                      'Коммерция',
                      'audit:missing_quantity_sent_to_production',
                      `Подтвержденный резерв принят; ${productionQty} рул. уходит в производство.`,
                    ),
                  ]
                : []),
              ...(outcome === 'rejected_send_all_to_production'
                ? [
                    auditEntry(
                      object.id,
                      'Коммерция',
                      'audit:warehouse_reserve_released',
                      'Складское покрытие не используется; вся позиция уходит в производство.',
                    ),
                  ]
                : []),
              ...object.audit,
            ],
          };
        });
        if (outcome === 'warehouse_recheck_requested') {
          const recheckTask = createWarehouseCoverRecheckWorkObject(
            selectedObject,
            reason,
            stampNow(),
          );
          if (recheckTask) upsertRoleObject('warehouse', recheckTask);
          notifyRole(
            'warehouse',
            recheckTask?.id ?? selectedObject.id,
            'Нужна перепроверка остатков',
            `Коммерция спорит с покрытием: ${reason}.`,
            'warning',
          );
        }
        if (
          outcome === 'accepted_with_missing_to_production' ||
          outcome === 'rejected_send_all_to_production'
        ) {
          upsertRoleObjectWithUpdate(
            'production',
            productionId,
            () => productionFromIntake(selectedObject, 'waiting'),
            (object) => ({
              ...object,
              id: productionId,
              title: `Заказ-наряд ${productionId}`,
              severity: productionQty > 0 ? 'warning' : 'info',
              statusLabel: productionQty > 0 ? 'Нужна производственная часть' : object.statusLabel,
              filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Требуют действия'])),
              facts: updateFactList(
                object.facts,
                {
                  Рулоны: productionDeltaLabel,
                  'Складское покрытие':
                    outcome === 'accepted_with_missing_to_production'
                      ? 'Резерв принят коммерцией'
                      : 'Складское покрытие снято коммерцией',
                },
                'production',
              ),
              sections: object.sections.map((section) =>
                section.id.includes('handoff')
                  ? {
                      ...section,
                      facts: section.facts.map((fact) =>
                        fact.label === 'Производство'
                          ? { ...fact, value: productionDeltaLabel }
                          : fact,
                      ),
                    }
                  : section,
              ),
              audit: [
                auditEntry(
                  productionId,
                  'Коммерция',
                  'audit:production_delta_finalized',
                  productionDeltaLabel,
                ),
                ...object.audit,
              ],
            }),
          );
          notifyRole(
            'production',
            productionId,
            'Производственная часть обновлена',
            outcome === 'accepted_with_missing_to_production'
              ? 'Коммерция приняла складской резерв; в заказ-наряд уходит только недостающая часть.'
              : 'Коммерция сняла складское покрытие; заказ-наряд получает всю производственную часть.',
            'warning',
          );
        }
        if (isCommercialLive && outcome === 'warehouse_recheck_requested') {
          void requestCoverRecheck(selectedObject.id)
            .then((orders) =>
              setWorkObjectsByRole((current) => ({
                ...current,
                commercial: orders,
              })),
            )
            .catch((error: unknown) =>
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'critical',
                'Перепроверка склада не сохранена',
                error instanceof Error ? error.message : 'Операция не выполнена.',
              ),
            );
        }
        if (isCommercialLive && outcome === 'rejected_send_all_to_production') {
          // full-only: «весь заказ в производство» = forceProduction (needs_production + аудит).
          // Отдельный rejectCover здесь не нужен и создавал гонку двух параллельных записей.
          void forceProduction(selectedObject.id)
            .then((orders) =>
              setWorkObjectsByRole((current) => ({
                ...current,
                commercial: orders,
              })),
            )
            .catch((error: unknown) =>
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'critical',
                'Передача в производство не выполнена',
                error instanceof Error ? error.message : 'Операция не выполнена.',
              ),
            );
        }
        setMutatingNavigationActionOutcome(
          {
            role: 'commercial',
            objectId: selectedObject.id,
            tone: outcome === 'warehouse_recheck_requested' ? 'warning' : 'success',
            title: outcomeLabel,
            detail:
              outcome === 'warehouse_recheck_requested'
                ? 'Склад получил задачу перепроверки. Производство не меняется до результата.'
                : 'Решение записано, следующий владелец видит только финализированную часть.',
          },
          actionId,
        );
        return;
      }

      if (
        actionId === 'commercial-confirm-warehouse-cover' ||
        actionId.startsWith('commercial-confirm-warehouse-cover:')
      ) {
        const confirmationKey = `confirm:${selectedObject.id}:${actionId}`;
        if (!actionConfirmationBypassRef.current.delete(confirmationKey)) {
          const selectedCoverQtyByProposalId = parseWarehouseCoverSelection(actionId);
          const selectedObjectWithManualCover = applyWarehouseCoverSelection(
            selectedObject,
            selectedCoverQtyByProposalId,
          );
          const reserveQty = (selectedObjectWithManualCover.warehouseCoverProposals ?? []).reduce(
            (sum, proposal) => sum + (proposal.reserveQty ?? proposal.coverQty),
            0,
          );
          const missingQty = (selectedObjectWithManualCover.warehouseCoverProposals ?? []).reduce(
            (sum, proposal) => sum + proposal.missingQty,
            0,
          );
          setActionConfirmation({
            eyebrow: 'Коммерция',
            title: 'Принять покрытие склада',
            objectTitle: selectedObject.title,
            message:
              'Склад закрепит резерв под заказ, а в производство уйдет только недостающая часть. Решение попадет в историю заказа.',
            tone: missingQty > 0 ? 'warning' : 'info',
            confirmLabel: 'Принять покрытие',
            details: [
              { label: 'Со склада', value: reserveQty > 0 ? `${reserveQty} рул.` : 'Нет резерва' },
              {
                label: 'В производство',
                value: missingQty > 0 ? `${missingQty} рул.` : 'Не требуется',
              },
              { label: 'Решение', value: 'Коммерция принимает' },
            ],
            onConfirm: () => {
              actionConfirmationBypassRef.current.add(confirmationKey);
              setActionConfirmation(null);
              window.requestAnimationFrame(() => applyWorkObjectAction(actionId));
            },
          });
          return;
        }
        const confirmedAt = stampNow();
        const selectedCoverQtyByProposalId = parseWarehouseCoverSelection(actionId);
        const selectedObjectWithManualCover = applyWarehouseCoverSelection(
          selectedObject,
          selectedCoverQtyByProposalId,
        );
        const reserveTask = createReservePreparationWorkObject(
          selectedObjectWithManualCover,
          confirmedAt,
        );
        updateRoleObject('commercial', selectedObject.id, (object) => {
          const objectWithManualCover = applyWarehouseCoverSelection(
            object,
            selectedCoverQtyByProposalId,
          );
          const nextProposals = (objectWithManualCover.warehouseCoverProposals ?? []).map(
            (proposal) => {
              const requestedQty = proposal.coverQty + proposal.missingQty;
              return {
                ...proposal,
                coverType: proposal.missingQty > 0 ? ('partial' as const) : ('full' as const),
                warehouseCoverStatus:
                  proposal.missingQty > 0
                    ? ('partial_confirmed' as const)
                    : ('full_confirmed' as const),
                decision: 'confirmed' as const,
                confirmedBy: 'Коммерция',
                confirmedAt,
                manualCoverQty: proposal.coverQty,
                manualCoverRequestedQty: requestedQty,
              };
            },
          );
          const missingQty = nextProposals.reduce((sum, proposal) => sum + proposal.missingQty, 0);
          const reserveQty = nextProposals.reduce(
            (sum, proposal) => sum + (proposal.reserveQty ?? proposal.coverQty),
            0,
          );
          const nextWarehouseCoverStatus =
            missingQty > 0 ? ('partial_confirmed' as const) : ('full_confirmed' as const);
          const nextCommercialOrder = object.commercialOrder
            ? {
                ...object.commercialOrder,
                warehouseCoverStatus: nextWarehouseCoverStatus,
                productionStatus:
                  missingQty > 0 ? ('needs_production' as const) : ('not_started' as const),
                positions: object.commercialOrder.positions.map((position) => ({
                  ...position,
                  warehouseCoverStatus: nextWarehouseCoverStatus,
                })),
              }
            : object.commercialOrder;

          return {
            ...object,
            commercialOrder: nextCommercialOrder,
            warehouseCoverProposals: nextProposals,
            facts: updateFactList(
              object.facts,
              {
                Склад:
                  nextWarehouseCoverStatus === 'full_confirmed'
                    ? 'Закрыто складом'
                    : 'Частично есть на складе',
                Производство:
                  missingQty > 0
                    ? `${missingQty} рул. в производство`
                    : 'Не требуется после склада',
                Резерв: reserveQty > 0 ? `${reserveQty} рул. подготовит склад` : 'Нет',
              },
              'commercial',
            ),
            sections: object.sections.map((section) =>
              section.id.endsWith('-reserve-hardening')
                ? {
                    ...section,
                    facts: section.facts.map((fact) => {
                      if (fact.label === 'Резерв') return { ...fact, value: `${reserveQty} рул.` };
                      if (fact.label === 'Производство')
                        return { ...fact, value: `${missingQty} рул.` };
                      if (fact.label === 'Владелец подтверждения')
                        return { ...fact, value: 'Коммерция' };
                      if (fact.label === 'Время подтверждения')
                        return { ...fact, value: confirmedAt };
                      if (fact.label === 'Статус задачи склада')
                        return { ...fact, value: 'В работе' };
                      return fact;
                    }),
                  }
                : section,
            ),
            actions: [
              {
                id: 'commercial-cover-confirmed',
                label: 'Покрытие склада принято',
                level: 'disabled' as const,
                enabled: false,
                disabledReason: 'Покрытие уже подтверждено пользователем',
                recoveryOwner: 'Коммерция',
                recoveryAction: 'Статус производства',
              },
              ...object.actions.filter((item) => item.id !== 'commercial-confirm-warehouse-cover'),
            ],
            audit: [
              auditEntry(
                object.id,
                'Коммерция',
                'audit:warehouse_cover_confirmed',
                missingQty > 0
                  ? `Принято покрытие склада; ${reserveQty} рул. со склада, ${missingQty} рул. остается зав. производства.`
                  : `Принято покрытие склада; ${reserveQty} рул. со склада.`,
              ),
              ...(reserveQty > 0
                ? [
                    auditEntry(
                      object.id,
                      'Склад',
                      'audit:roll_reserved_for_order',
                      `${reserveQty} рул. свободного резерва закреплены под заказ.`,
                    ),
                  ]
                : []),
              ...object.audit,
            ],
          };
        });
        if (!isCommercialLive) {
          if (reserveTask) {
            upsertRoleObject('warehouse', reserveTask);
            notifyRole(
              'warehouse',
              reserveTask.id,
              'Подготовить резерв',
              'Часть заказа закрыта свободным резервом; склад готовит рулоны под заявку.',
              'warning',
            );
          }
          notifyRole(
            'production',
            selectedObject.id,
            'Складское покрытие подтверждено',
            'В производство уходит только недостающая часть по подтвержденному покрытию.',
            'info',
          );
        }
        const proposalId = selectedObject.warehouseCoverProposals?.[0]?.id;
        if (isCommercialLive && proposalId) {
          void confirmCover(selectedObject.id, proposalId)
            .then((orders) => {
              setWorkObjectsByRole((current) => ({
                ...current,
                commercial: orders,
              }));
              requestLiveRoleRefresh('commercial');
            })
            .catch((error: unknown) =>
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'critical',
                'Покрытие склада не сохранено',
                error instanceof Error ? error.message : 'Операция не выполнена.',
              ),
            );
        }
        showMutationToast(
          'commercial',
          selectedObject.id,
          actionId,
          'success',
          'Покрытие склада принято',
          'Склад и зав. производства получили свои статусы.',
        );
        return;
      }

      if (actionId === 'commercial-confirm-production-lead-recipe') {
        const productionId = `ЗН-${selectedObject.id.replace(/^З-/, '')}`;
        setWorkObjectsByRole((current) => ({
          ...current,
          commercial: current.commercial.map((object) =>
            object.id === selectedObject.id
              ? {
                  ...object,
                  commercialOrder: object.commercialOrder
                    ? { ...object.commercialOrder, requiresCommercialRecipeConfirmation: false }
                    : object.commercialOrder,
                  actions: object.actions.filter(
                    (item) => item.id !== 'commercial-confirm-production-lead-recipe',
                  ),
                  audit: [
                    auditEntry(
                      object.id,
                      'Коммерция',
                      'audit:commercial_recipe_confirmed',
                      'Коммерция подтвердила рецептуру заявки, созданной зав. производства.',
                    ),
                    ...object.audit,
                  ],
                }
              : object,
          ),
          production: current.production.map((object) =>
            object.id === productionId
              ? {
                  ...object,
                  commercialOrder: object.commercialOrder
                    ? { ...object.commercialOrder, requiresCommercialRecipeConfirmation: false }
                    : object.commercialOrder,
                  actions: object.actions.map((item) =>
                    item.id.startsWith('production-approve-order:')
                      ? {
                          id: item.id,
                          label: 'Согласовать заказ-наряд',
                          level: 'recommended' as const,
                          enabled: true,
                        }
                      : item,
                  ),
                  audit: [
                    auditEntry(
                      object.id,
                      'Коммерция',
                      'audit:commercial_recipe_confirmed',
                      'Коммерция подтвердила, что ведет рецептуру перед согласованием заказ-наряда.',
                    ),
                    ...object.audit,
                  ],
                }
              : object,
          ),
        }));
        setMutatingNavigationActionOutcome(
          {
            role: 'commercial',
            objectId: selectedObject.id,
            tone: 'success',
            title: 'Рецептура подтверждена.',
            detail: 'Зав. производства может согласовать заказ-наряд.',
          },
          actionId,
        );
        notifyRole(
          'production',
          productionId,
          'Рецептура подтверждена',
          'Коммерция подтвердила параметры; согласование заказ-наряда доступно.',
          'info',
        );
        return;
      }

      if (action.kind === 'commercialOpenProduction') {
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'audit:commercial_production_status_opened',
              'Коммерция открыла статус производства без перехода в рабочий экран зав. производства.',
            ),
            ...object.audit,
          ],
        }));
        setNavigationActionOutcome({
          role: 'commercial',
          objectId: selectedObject.id,
          tone: 'info',
          title: 'Производственный контекст открыт.',
          detail:
            'Коммерция видит только полезный контекст: проблему производства или источник остатка.',
        });
        openDetailTarget(
          '.commercial-production-problem-panel, .commercial-cover-panel, .commercial-payment-shipment-strip',
        );
        return;
      }

      if (action.kind === 'commercialSendToProduction') {
        if (isCommercialLive) {
          void sendCommercialOrderToProduction(selectedObject.id)
            .then((commercialOrders) => {
              setWorkObjectsByRole((current) => ({
                ...current,
                commercial: commercialOrders,
              }));
              setSelectedByRole((current) => ({
                ...current,
                commercial: commercialOrders.some((object) => object.id === current.commercial)
                  ? current.commercial
                  : (commercialOrders[0]?.id ?? null),
              }));
              requestLiveRoleRefresh('commercial');
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'success',
                'Передано зав. производства',
                'Заказ появился в производственном контуре только после вашего подтверждения.',
              );
            })
            .catch((error: unknown) =>
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'critical',
                'Заказ не передан в производство',
                error instanceof Error ? error.message : 'Передача не записана.',
              ),
            );
          return;
        }
      }

      if (action.kind === 'commercialDelegateSelected') {
        const productionObject = productionFromIntake(selectedObject, 'waiting');
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          statusLabel: 'Передано',
          nextOwner: 'Зав. производства',
          severity: 'info',
          filterTags: Array.from(
            new Set([
              ...(object.filterTags ?? []).filter(
                (tag) => !['Входящие заявки', 'Черновики', 'Черновик', 'Оформляется'].includes(tag),
              ),
              'В работе',
              'Передано',
              'Передано в заказ-наряд',
            ]),
          ),
          commercialOrder: object.commercialOrder
            ? { ...object.commercialOrder, productionStatus: 'needs_production' }
            : object.commercialOrder,
          actions: commercialActions('Передано'),
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'Заявка создана',
              'У зав. производства появилась строка для оформления заказ-наряда.',
            ),
            ...object.audit,
          ],
        }));
        upsertRoleObject('production', productionObject);
        dispatchRuntimeAction({
          type: 'commercial.intake.delegated',
          objectId: selectedObject.id,
          counterpartyLabel: factValue(selectedObject, 'Контрагент') ?? selectedObject.title,
          positionsLabel: factValue(selectedObject, 'Позиции') ?? 'Позиции из заявки',
          status: 'delegated',
        });
        setSelectedByRole((current) => ({ ...current, production: productionObject.id }));
        notifyRole(
          'production',
          productionObject.id,
          'Ждет заказ-наряд',
          'Коммерция создала заявку: нужно сформировать заказ-наряд до счета.',
          'warning',
        );
        showMutationToast(
          'commercial',
          selectedObject.id,
          actionId,
          'success',
          'Заявка передана',
          'Зав. производства получил строку для заказ-наряда.',
        );
        return;
      }

      if (action.kind === 'commercialPromoteDraft') {
        if (isCommercialLive) {
          void promoteCommercialDraft(selectedObject.id)
            .then((updatedObject) => {
              updateRoleObject('commercial', selectedObject.id, () => updatedObject);
              setSelectedByRole((current) => ({ ...current, commercial: updatedObject.id }));
              setActiveSectionByRole((current) => ({
                ...current,
                commercial: 'Входящие заявки',
              }));
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'success',
                'Заявка оформлена',
                'Черновик вышел во входящие заявки коммерции. Бухгалтерия его еще не видит.',
              );
            })
            .catch((error: unknown) => {
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'critical',
                'Черновик не оформлен',
                error instanceof Error ? error.message : 'Операция не записана.',
              );
            });
          return;
        }
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          statusLabel: 'Оформление',
          filterTags: Array.from(
            new Set([
              ...(object.filterTags ?? []).filter(
                (tag) => !['Черновики', 'Черновик'].includes(tag),
              ),
              'Входящие заявки',
            ]),
          ),
          commercialOrder: object.commercialOrder
            ? { ...object.commercialOrder, status: 'in_work' }
            : object.commercialOrder,
          actions: commercialActions('Оформление'),
        }));
        setActiveSectionByRole((current) => ({ ...current, commercial: 'Входящие заявки' }));
        showMutationToast(
          'commercial',
          selectedObject.id,
          actionId,
          'success',
          'Заявка оформлена',
          'Черновик вышел во входящие заявки коммерции.',
        );
        return;
      }

      if (action.kind === 'commercialTransferSelected') {
        if (isCommercialLive) {
          void submitCommercialOrderToFinance(selectedObject.id)
            .then((updatedObject) => {
              updateRoleObject('commercial', selectedObject.id, () => updatedObject);
              setSelectedByRole((current) => ({ ...current, commercial: updatedObject.id }));
              setActiveSectionByRole((current) => ({
                ...current,
                commercial: 'Входящие заявки',
              }));
              if (isFinanceLive) {
                void fetchFinanceOrders()
                  .then((orders) =>
                    setWorkObjectsByRole((current) => ({
                      ...current,
                      finance: orders,
                    })),
                  )
                  .catch(() => undefined);
              }
              requestLiveRoleRefresh('commercial');
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'success',
                'Направлено в бухгалтерию',
                'Заявка передана на этап бухгалтерии.',
              );
            })
            .catch((error: unknown) => {
              showMutationToast(
                'commercial',
                selectedObject.id,
                actionId,
                'critical',
                'Заявка не направлена в бухгалтерию',
                error instanceof Error ? error.message : 'Операция не записана.',
              );
            });
          return;
        }
        const productionObject = productionFromIntake(selectedObject, 'incomplete');
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          statusLabel: 'Передано',
          nextOwner: 'Зав. производства',
          severity: 'info',
          filterTags: Array.from(
            new Set([
              ...(object.filterTags ?? []).filter(
                (tag) => !['Входящие заявки', 'Черновики', 'Черновик', 'Оформляется'].includes(tag),
              ),
              'В работе',
              'Передано',
              'Передано в заказ-наряд',
            ]),
          ),
          commercialOrder: object.commercialOrder
            ? { ...object.commercialOrder, productionStatus: 'needs_production' }
            : object.commercialOrder,
          actions: commercialActions('Передано'),
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'Заявка создана',
              'У зав. производства появилась строка Неполный заказ-наряд; бухгалтерия пока не получает работу.',
            ),
            ...object.audit,
          ],
        }));
        upsertRoleObject('production', productionObject);
        dispatchRuntimeAction({
          type: 'commercial.intake.delegated',
          objectId: selectedObject.id,
          counterpartyLabel: factValue(selectedObject, 'Контрагент') ?? selectedObject.title,
          positionsLabel: factValue(selectedObject, 'Позиции') ?? 'Позиции из заявки',
          status: 'transferred',
        });
        setSelectedByRole((current) => ({ ...current, production: productionObject.id }));
        notifyRole(
          'production',
          productionObject.id,
          'Неполный заказ-наряд',
          'Коммерция создала заявку: нужно согласовать производственную часть до счета.',
          'warning',
        );
        showMutationToast(
          'commercial',
          selectedObject.id,
          actionId,
          'success',
          'Заявка передана',
          'Зав. производства получил неполный заказ-наряд.',
        );
        return;
      }

      if (action.kind === 'commercialSaveDraft') {
        updateRoleObject('commercial', selectedObject.id, (object) => ({
          ...object,
          audit: [
            auditEntry(
              object.id,
              'Коммерция',
              'Черновик сохранен',
              'Изменения заявки сохранены в текущей рабочей сессии.',
            ),
            ...object.audit,
          ],
        }));
        showMutationToast(
          'commercial',
          selectedObject.id,
          actionId,
          'success',
          'Черновик сохранен',
          'Изменения заявки записаны.',
        );
      }
    }

    if (activeRole === 'production') {
      if (actionId.startsWith('production-bulk-assign:')) {
        const [
          ,
          rawIds = '',
          operatorId = '',
          priority = selectedObject.facts.find((fact) => fact.label === 'Приоритет')?.value ??
            'обычный',
        ] = actionId.split(':');
        const rollDispatchItemIds = rawIds
          .split(',')
          .map((id) => decodeURIComponent(id))
          .filter(Boolean);
        const operator = operatorById(operatorId);
        if (rollDispatchItemIds.length === 0 || !operator) {
          setOfficeActionOutcome('production', selectedObject.id, {
            tone: 'warning',
            title: 'Назначение не записано.',
            detail: 'Выбери рулоны и оператора.',
          });
          return;
        }
        const normalizedPriority = isProductionPriority(priority) ? priority : 'обычный';
        const audit = auditEntryWithValues(
          selectedObject.id,
          'Зав. производства',
          'audit:roll_dispatch_assigned',
          `${operator.name} назначен на ${rollDispatchItemIds.length} рул.`,
          {
            newValue: `${operator.name} · ${normalizedPriority}`,
            reason: 'пакетное назначение выбранных рулонов',
          },
        );
        setWorkObjectsByRole((current) => ({
          ...current,
          production: current.production.map((object) =>
            updateProductionRollDispatchObjects(
              object,
              rollDispatchItemIds,
              (item) => {
                const applyDefaultMachine = !item.manualMachineOverride;
                const nextMachineId = applyDefaultMachine
                  ? operator.defaultMachineId
                  : item.machineId;
                const nextMachineLabel = applyDefaultMachine
                  ? operator.defaultMachineLabel
                  : item.machineLabel;
                return {
                  ...item,
                  operatorId,
                  operatorLabel: operator.name,
                  priority: normalizedPriority,
                  machineId: nextMachineId,
                  machineLabel: nextMachineLabel,
                  defaultMachineIdSnapshot: operator.defaultMachineId,
                  defaultMachineLabelSnapshot: operator.defaultMachineLabel,
                  defaultMachineAssignedAt: operator.defaultMachineAssignedAt,
                  machineAssignedBy: applyDefaultMachine ? 'default смены' : item.machineAssignedBy,
                  machineAssignedAt: applyDefaultMachine ? stampNow() : item.machineAssignedAt,
                  machineAssignmentSource: applyDefaultMachine
                    ? 'shift_default'
                    : item.machineAssignmentSource,
                  machineAssignmentRequired: true,
                  status: item.status === 'blocked' && nextMachineId ? 'queued' : item.status,
                  blocker:
                    item.status === 'blocked' && !nextMachineId
                      ? 'Нужен станок и плановый вес'
                      : undefined,
                  updatedAt: stampNow(),
                  auditEvent: 'audit:roll_dispatch_assigned',
                };
              },
              audit,
            ),
          ),
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Рулоны назначены.',
          detail: `${operator.name} · ${rollDispatchItemIds.length} рул. · ${normalizedPriority}`,
        });
        return;
      }

      if (actionId.startsWith('production-move-roll:')) {
        const [, rollDispatchItemId, rawDirection] = actionId.split(':');
        const direction = rawDirection === 'down' ? 'down' : 'up';
        const preview = moveProductionRollQueueAcrossObjects(
          workObjectsByRole.production,
          rollDispatchItemId,
          direction,
        );
        setWorkObjectsByRole((current) => {
          const result =
            current.production === workObjectsByRole.production
              ? preview
              : moveProductionRollQueueAcrossObjects(
                  current.production,
                  rollDispatchItemId,
                  direction,
                );
          return { ...current, production: result.objects };
        });
        setMutatingOfficeActionOutcome(
          'production',
          selectedObject.id,
          actionId,
          preview.moved
            ? {
                tone: 'success',
                title: 'Очередь обновлена.',
                detail: `${rollDispatchItemId} перемещен ${direction === 'up' ? 'выше' : 'ниже'}.`,
              }
            : {
                tone: 'warning',
                title: 'Порядок не изменился.',
                detail: 'Рулон уже на границе очереди.',
              },
        );
        return;
      }

      if (actionId.startsWith('production-set-roll-operator:')) {
        const [, rollDispatchItemId, operatorId] = actionId.split(':');
        if (isProductionLive) {
          assignLiveProductionRollOperator(rollDispatchItemId, operatorId);
          return;
        }
        const operator = operatorById(operatorId);
        if (!operator) {
          setOfficeActionOutcome('production', selectedObject.id, {
            tone: 'warning',
            title: 'Оператор не выбран.',
            detail: 'Выбери исполнителя в строке рулона.',
          });
          return;
        }
        const audit = auditEntryWithValues(
          rollDispatchItemId,
          'Зав. производства',
          'audit:roll_dispatch_assigned',
          `${operator.name} назначен на рулон ${rollDispatchItemId}.`,
          { newValue: operator.name, reason: 'ручное назначение исполнителя по рулону' },
        );
        setWorkObjectsByRole((current) => ({
          ...current,
          production: current.production.map((object) =>
            updateProductionRollDispatchObject(
              object,
              rollDispatchItemId,
              (item) => {
                const applyDefaultMachine = !item.manualMachineOverride;
                const nextMachineId = applyDefaultMachine
                  ? operator.defaultMachineId
                  : item.machineId;
                const nextMachineLabel = applyDefaultMachine
                  ? operator.defaultMachineLabel
                  : item.machineLabel;
                return {
                  ...item,
                  operatorId,
                  operatorLabel: operator.name,
                  machineId: nextMachineId,
                  machineLabel: nextMachineLabel,
                  defaultMachineIdSnapshot: operator.defaultMachineId,
                  defaultMachineLabelSnapshot: operator.defaultMachineLabel,
                  defaultMachineAssignedAt: operator.defaultMachineAssignedAt,
                  machineAssignedBy: applyDefaultMachine ? 'default смены' : item.machineAssignedBy,
                  machineAssignedAt: applyDefaultMachine ? stampNow() : item.machineAssignedAt,
                  machineAssignmentSource: applyDefaultMachine
                    ? 'shift_default'
                    : item.machineAssignmentSource,
                  machineAssignmentRequired: true,
                  status: item.status === 'blocked' && nextMachineId ? 'queued' : item.status,
                  blocker:
                    item.status === 'blocked' && !nextMachineId
                      ? 'Нужен станок и плановый вес'
                      : undefined,
                  updatedAt: stampNow(),
                  auditEvent: 'audit:roll_dispatch_assigned',
                };
              },
              audit,
            ),
          ),
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Оператор назначен на рулон.',
          detail: `${operator.name} · ${rollDispatchItemId}`,
        });
        return;
      }

      if (actionId.startsWith('production-set-roll-machine:')) {
        const [, rollDispatchItemId, machineId] = actionId.split(':');
        if (isProductionLive) {
          // Станок жестко привязан к оператору смены; ручная смена — только через
          // аварийное переназначение в «Операторы / загрузка» (ТЗ production.txt).
          showMutationToast(
            'production',
            rollDispatchItemId,
            'production-roll-machine',
            'warning',
            'Станок не переназначен',
            `Станок определяется сменой оператора. Для поломки используйте аварийное переназначение в «Операторы / загрузка». (${machineId})`,
          );
          return;
        }
        const machineLabel = productionMachineLabel(machineId);
        const audit = auditEntryWithValues(
          rollDispatchItemId,
          'Зав. производства',
          'audit:production_roll_machine_overridden',
          `${machineLabel} назначен вручную на рулон ${rollDispatchItemId}.`,
          { newValue: machineLabel, reason: 'переопределение default станка в строке рулона' },
        );
        setWorkObjectsByRole((current) => ({
          ...current,
          production: current.production.map((object) =>
            updateProductionRollDispatchObject(
              object,
              rollDispatchItemId,
              (item) => {
                const stillBlockedByOperator = item.status === 'blocked' && !item.operatorId;
                return {
                  ...item,
                  machineId,
                  machineLabel,
                  machineAssignedBy: 'Зав. производства',
                  machineAssignedAt: stampNow(),
                  machineAssignmentSource: 'manual_override',
                  manualMachineOverride: true,
                  machineOverrideReason: 'ручное переопределение в строке рулона',
                  machineAssignmentRequired: true,
                  status: item.status === 'blocked' && item.operatorId ? 'queued' : item.status,
                  blocker: stillBlockedByOperator ? 'Нужен оператор и плановый вес' : undefined,
                  updatedAt: stampNow(),
                  auditEvent: 'audit:production_roll_machine_overridden',
                };
              },
              audit,
            ),
          ),
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Станок назначен.',
          detail: `${machineLabel} записан в строку рулона.`,
        });
        return;
      }

      if (actionId.startsWith('production-set-roll-priority:')) {
        const [, rollDispatchItemId, priority] = actionId.split(':');
        if (isProductionLive && isProductionPriority(priority)) {
          setLiveProductionRollPriority(rollDispatchItemId, priority);
          return;
        }
        if (!isProductionPriority(priority)) {
          setOfficeActionOutcome('production', selectedObject.id, {
            tone: 'warning',
            title: 'Приоритет не записан.',
            detail: 'Неизвестное значение приоритета рулона.',
          });
          return;
        }
        const audit = auditEntryWithValues(
          rollDispatchItemId,
          'Зав. производства',
          'audit:production_priority_changed',
          `Приоритет рулона ${rollDispatchItemId} изменен на ${priority}.`,
          { newValue: priority, reason: 'ручное изменение очереди конкретного рулона' },
        );
        setWorkObjectsByRole((current) => ({
          ...current,
          production: current.production.map((object) =>
            updateProductionRollDispatchObject(
              object,
              rollDispatchItemId,
              (item) => ({
                ...item,
                priority,
                updatedAt: stampNow(),
                auditEvent: 'audit:production_priority_changed',
              }),
              audit,
            ),
          ),
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: priority === 'критично' ? 'warning' : 'success',
          title: 'Приоритет рулона изменен.',
          detail: `${rollDispatchItemId}: ${priority}.`,
        });
        return;
      }

      if (action.kind === 'productionResolveCurrentRoll') {
        const resolution =
          (action.targetId as CurrentRollResolution | undefined) ?? 'requires_production_decision';
        const resolutionLabel =
          currentRollResolutionLabels[resolution] ?? 'Решение по текущему рулону записано';
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          severity: object.problems.some((problem) => problem.status === 'open')
            ? object.severity
            : 'info',
          facts: updateFactList(object.facts, { 'Текущий рулон': resolutionLabel }, 'production'),
          actions: object.actions.filter(
            (item) => !item.id.startsWith('production-resolve-current-roll:'),
          ),
          orderResolutionCases: object.orderResolutionCases?.map((item) =>
            item.type === 'production_current_roll_resolution' &&
            item.status === 'awaiting_production'
              ? {
                  ...item,
                  status: 'resolved' as const,
                  ownerRole: 'operator' as const,
                  nextOwnerRole: 'operator' as const,
                  outcome: resolution,
                  resolvedAt: stampNow(),
                }
              : item,
          ),
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'audit:current_roll_resolution_set',
              resolutionLabel,
            ),
            auditEntry(
              object.id,
              'Зав. производства',
              'notification:operator_task_updated',
              'Оператор получает обновленную инструкцию по текущему рулону и следующей версии рецепта.',
            ),
            ...object.audit,
          ],
        }));
        const commercialId = commercialIdFromProductionId(selectedObject.id);
        updateRoleObject('commercial', commercialId, (object) => ({
          ...object,
          severity: object.productionProblems?.some((problem) => problem.status !== 'resolved')
            ? 'info'
            : object.severity,
          problems: object.problems.map((problem) =>
            problem.stage === 'Производство'
              ? { ...problem, status: 'resolved' as const }
              : problem,
          ),
          productionProblems: object.productionProblems?.map((problem) =>
            problem.status !== 'resolved'
              ? { ...problem, status: 'resolved' as const, resolvedAt: stampNow() }
              : problem,
          ),
          commercialProductionProgress: object.commercialProductionProgress
            ? {
                ...object.commercialProductionProgress,
                activeProblemIds: [],
                updatedAt: stampNow(),
              }
            : object.commercialProductionProgress,
          orderResolutionCases: object.orderResolutionCases?.map((item) =>
            item.type === 'production_current_roll_resolution' &&
            item.status === 'awaiting_production'
              ? {
                  ...item,
                  status: 'resolved' as const,
                  ownerRole: 'operator' as const,
                  nextOwnerRole: 'operator' as const,
                  outcome: resolution,
                  resolvedAt: stampNow(),
                }
              : item,
          ),
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'audit:current_roll_resolution_set',
              resolutionLabel,
            ),
            ...object.audit,
          ],
        }));
        notifyRole(
          'operator',
          selectedObject.id,
          'Инструкция по рулону обновлена',
          `${resolutionLabel}. Следующий рулон выполнять по новой версии позиции.`,
          'warning',
        );
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Решение по текущему рулону записано.',
          detail: resolutionLabel,
        });
        return;
      }

      if (action.kind === 'productionAssignOperator') {
        const operator = operatorById(action.targetId);
        if (!operator) {
          setOfficeActionOutcome('production', selectedObject.id, {
            tone: 'warning',
            title: 'Оператор не выбран.',
            detail: 'Выбери исполнителя перед записью назначения.',
          });
          return;
        }
        const operatorLabel = operator.name;
        const workplace = operator.workplace;
        const alreadyAssigned = Boolean(
          factValue(selectedObject, 'Ответственный') &&
          !['Не назначен', 'Назначить при оформлении', 'Зав. производства'].includes(
            factValue(selectedObject, 'Ответственный') ?? '',
          ),
        );
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          facts: updateFactList(
            object.facts,
            { Ответственный: operatorLabel, 'Рабочее место': workplace },
            'production',
          ),
          sections: object.sections.map((section) => ({
            ...section,
            facts: section.facts.map((fact) => {
              if (fact.label === 'Ответственный' || fact.label === 'Оператор')
                return { ...fact, value: operatorLabel };
              if (fact.label === 'Станок' || fact.label === 'Рабочее место')
                return { ...fact, label: 'Рабочее место', value: workplace };
              return fact;
            }),
          })),
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              alreadyAssigned ? 'audit:task_reassigned' : 'audit:task_assigned',
              `${alreadyAssigned ? 'Переназначен' : 'Назначен'} оператор ${operatorLabel}; рабочее место ${workplace}.${alreadyAssigned ? ' Причина: ручная диспетчеризация очереди.' : ''}`,
            ),
            ...object.audit,
          ],
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Оператор назначен.',
          detail: `${operatorLabel} · ${workplace}`,
        });
        return;
      }

      if (action.kind === 'productionSetPriority') {
        const nextPriority = action.targetId ?? 'обычный';
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          facts: updateFactList(object.facts, { Приоритет: nextPriority }, 'production'),
          sections: object.sections.map((section) => ({
            ...section,
            facts: section.facts.map((fact) =>
              fact.label === 'Приоритет' ? { ...fact, value: nextPriority } : fact,
            ),
          })),
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'audit:production_priority_changed',
              `Приоритет исполнения изменен на ${nextPriority}.`,
            ),
            ...object.audit,
          ],
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: nextPriority === 'критично' ? 'warning' : 'success',
          title: 'Приоритет изменен.',
          detail: `Новый приоритет: ${nextPriority}.`,
        });
        return;
      }

      if (action.kind === 'productionFormOrder') {
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          statusLabel: 'Неполный заказ-наряд',
          severity: 'warning',
          filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Неполный заказ-наряд'])),
          actions: [
            {
              id: `production-approve-order:${object.id}`,
              label: 'Согласовать заказ-наряд',
              level: 'recommended',
              enabled: true,
            },
            {
              id: `production-save-draft:${object.id}`,
              label: 'Сохранить черновик',
              level: 'secondary',
              enabled: true,
            },
          ],
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'Заказ-наряд сформирован',
              'Теперь заказ-наряд можно согласовать и передать бухгалтерии.',
            ),
            ...object.audit,
          ],
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Заказ-наряд сформирован.',
        });
        return;
      }

      if (action.kind === 'productionApplyTemplate' || action.kind === 'productionFillRequired') {
        updateRoleObject('production', selectedObject.id, (object) =>
          recoverProductionObject(
            object,
            'Зав. производства',
            action.kind === 'productionApplyTemplate' ? 'Шаблон применен' : 'Поля заполнены',
          ),
        );
        setMutatingOfficeActionOutcome(
          'production',
          selectedObject.id,
          actionId,
          action.kind === 'productionApplyTemplate'
            ? { tone: 'success', title: 'Шаблон применен.', detail: 'Проверь и согласуй.' }
            : { tone: 'success', title: 'Поля заполнены.', detail: 'Можно согласовать.' },
        );
        return;
      }

      if (action.kind === 'productionCheckCompleteness') {
        const hasOpenProblems = selectedObject.problems.some(
          (problem) => problem.status === 'open',
        );
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'Проверка полноты открыта',
              object.problems.some((problem) => problem.status === 'open')
                ? 'Проверка показала открытые поля; рядом доступны Применить шаблон или Заполнить поля.'
                : 'Проверка подтвердила, что блокеров нет.',
            ),
            ...object.audit,
          ],
        }));
        setMutatingOfficeActionOutcome(
          'production',
          selectedObject.id,
          actionId,
          hasOpenProblems
            ? {
                tone: 'warning',
                title: 'Найдены блокеры.',
                detail: 'Исправь поля перед согласованием.',
              }
            : { tone: 'success', title: 'Проверка пройдена.' },
        );
        return;
      }

      if (action.kind === 'productionSaveDraft') {
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'Изменения сохранены',
              'Изменения заказ-наряда сохранены в рабочем контуре.',
            ),
            ...object.audit,
          ],
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Сохранено сейчас.',
        });
        return;
      }

      if (action.kind === 'productionReorderQueue') {
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'Порядок очереди изменен',
              'Порядок обновлен через карточку заказ-наряда; причина хранится в истории.',
            ),
            ...object.audit,
          ],
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Порядок обновлен.',
        });
        return;
      }

      if (action.kind === 'productionCommentDirector') {
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'Комментарий директору добавлен',
              'Комментарий связан с заказ-нарядом и будет виден в директорском контуре.',
            ),
            ...object.audit,
          ],
        }));
        notifyRole(
          'director',
          selectedObject.id,
          'Комментарий к заказ-наряду',
          'Зав. производства добавил комментарий к директорскому решению.',
          'info',
        );
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Комментарий добавлен директору.',
        });
        return;
      }

      if (action.kind === 'productionReturnIntake') {
        updateRoleObject('production', selectedObject.id, (object) => ({
          ...object,
          statusLabel: 'Возвращено в заявку',
          nextOwner: 'Коммерция',
          severity: 'warning',
          filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Возвращено'])),
          actions: [
            {
              id: `production-returned:${object.id}`,
              label: 'Возвращено',
              level: 'disabled' as const,
              enabled: false,
              disabledReason: 'Заказ-наряд возвращен в заявку',
              recoveryAction: 'Коммерция должна уточнить входные данные',
              recoveryOwner: 'Коммерция',
            },
          ],
          audit: [
            auditEntry(
              object.id,
              'Зав. производства',
              'Возвращено в заявку',
              'Заказ-наряд возвращен коммерции на уточнение входных данных.',
            ),
            ...object.audit,
          ],
        }));
        notifyRole(
          'commercial',
          selectedObject.id,
          'Заказ-наряд возвращен',
          'Зав. производства вернул заявку на уточнение данных.',
          'warning',
        );
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'warning',
          title: 'Возвращено в заявку.',
        });
        return;
      }

      if (action.kind === 'productionApproveTechnicalCover') {
        const commercialOrderId = action.targetId ?? selectedObject.id;
        approveLiveProductionTechnicalCover(commercialOrderId, actionId);
        return;
      }

      if (action.kind === 'productionApproveOrder') {
        if (isProductionLive) {
          approveLiveProductionOrder(selectedObject.id, actionId);
          return;
        }

        if (
          selectedObject.commercialOrder?.commercialConfirmationPolicy === 'required' &&
          selectedObject.commercialOrder?.requiresCommercialRecipeConfirmation
        ) {
          setOfficeActionOutcome('production', selectedObject.id, {
            tone: 'warning',
            title: 'Рецептура не подтверждена.',
            detail: 'Коммерция должна подтвердить параметры перед передачей в финансы.',
          });
          notifyRole(
            'commercial',
            selectedObject.commercialOrder.id,
            'Нужно подтвердить рецептуру',
            'Заявка создана зав. производства; без подтверждения коммерции заказ-наряд не уходит в финансы.',
            'warning',
          );
          return;
        }
        const approvedObject = {
          ...selectedObject,
          statusLabel: 'Готов к счету',
          nextOwner: 'Бухгалтерия',
          severity: 'info' as const,
          filterTags: Array.from(
            new Set([
              ...(selectedObject.filterTags ?? []).filter(
                (tag) => !['Требуют действия', 'Неполные', 'Готовы к согласованию'].includes(tag),
              ),
              'Готов к счету',
            ]),
          ),
          facts: selectedObject.facts,
          actions: [
            {
              id: `production-finance-ready:${selectedObject.id}`,
              label: 'Передано бухгалтерии',
              level: 'disabled' as const,
              enabled: false,
              disabledReason: 'Заказ-наряд уже согласован',
              recoveryAction: 'Бухгалтерия получила строку Ждет счет',
              recoveryOwner: 'Бухгалтерия',
            },
          ],
          audit: [
            auditEntry(
              selectedObject.id,
              'Зав. производства',
              'Заказ-наряд согласован',
              'Бухгалтерия получила строку Ждет счет.',
            ),
            ...selectedObject.audit,
          ],
        };
        const financeObject = financeFromProduction(approvedObject);
        dispatchRuntimeAction({
          type: 'production.order.approved',
          objectId: selectedObject.id,
          counterpartyLabel: factValue(selectedObject, 'Контрагент') ?? selectedObject.title,
        });
        setWorkObjectsByRole((current) => ({
          ...current,
          production: current.production.map((object) =>
            object.id === selectedObject.id ? approvedObject : object,
          ),
          finance: current.finance.some((object) => object.id === financeObject.id)
            ? current.finance.map((object) =>
                object.id === financeObject.id ? financeObject : object,
              )
            : [financeObject, ...current.finance],
        }));
        setMutatingOfficeActionOutcome('production', selectedObject.id, actionId, {
          tone: 'success',
          title: 'Согласовано.',
          detail: 'Бухгалтерия получила строку.',
        });
        setSelectedByRole((current) => ({ ...current, finance: financeObject.id }));
        notifyRole(
          'finance',
          financeObject.id,
          'Ждет счет',
          'Заказ-наряд согласован зав. производства; можно выставлять счет.',
          'info',
        );
        return;
      }
    }

    if (action.kind === 'financeReduce') {
      if (isFinanceLive) {
        const isPaymentOperationAction =
          isFinanceDistributePaymentAction(actionId) || isFinanceManualPaymentAction(actionId);
        const paymentOperation = isPaymentOperationAction
          ? buildFinancePaymentOperationIntent(
              selectedObject,
              isFinanceDistributePaymentAction(actionId) ? payload?.operationAmount : undefined,
            )
          : null;
        if (isPaymentOperationAction && !paymentOperation) {
          setOfficeActionOutcome('finance', selectedObject.id, {
            tone: 'warning',
            title: isFinanceDistributePaymentAction(actionId)
              ? 'Введите сумму выплаты.'
              : 'Нет остатка для оплаты.',
            detail: isFinanceDistributePaymentAction(actionId)
              ? 'Сумма нужна, чтобы разнести выплату по графику рассрочки.'
              : 'Обновите финансовые данные заказа.',
          });
          return;
        }
        const scheduleId = financeScheduleIdFromAction(actionId);
        const idempotentFinanceIntent = scheduleId
          ? `finance:schedule-confirmation:${selectedObject.id}:${scheduleId}`
          : paymentOperation?.intent ?? null;
        const mutation = isFinanceInvoiceAction(actionId)
          ? (_operationKey?: string) => retryFinanceSource(selectedObject.id)
          : paymentOperation
            ? (operationKey?: string) =>
                recordFinancePayment(selectedObject.id, {
                  operationKey: operationKey ?? createOperationKey(),
                  operationType: paymentOperation.operationType,
                  amount: paymentOperation.amount,
                })
            : scheduleId
              ? (operationKey?: string) =>
                  confirmFinancePaymentSchedule(
                    selectedObject.id,
                    scheduleId,
                    operationKey ?? createOperationKey(),
                  )
              : isFinanceCheckPaymentAction(actionId)
                ? (_operationKey?: string) => retryFinanceSource(selectedObject.id)
                : isFinanceSourceRetryAction(actionId)
                    ? (_operationKey?: string) => retryFinanceSource(selectedObject.id)
                    : isFinanceProblemAction(actionId)
                      ? (_operationKey?: string) =>
                          createFinanceProblem(selectedObject.id, {
                            kind:
                              selectedObject.statusLabel === 'Просрочка' ||
                              factValue(selectedObject, 'Статус оплаты')?.includes('Просрочка')
                                ? 'overdue'
                                : 'sync',
                            reason:
                              selectedObject.problems[0]?.reason ??
                              'Бухгалтерия создала проблему из финансового действия.',
                            evidence:
                              factValue(selectedObject, 'Источник данных') ??
                              factValue(selectedObject, 'Номер') ??
                              selectedObject.title,
                          }).then(() => reduceFinanceObject(selectedObject, actionId))
                      : null;

        if (mutation) {
          const request = idempotentFinanceIntent
            ? financeOperationGateRef.current.start(idempotentFinanceIntent, mutation)
            : liveMutationGateRef.current.start(`finance:${selectedObject.id}:${actionId}`, () =>
                mutation(),
              );
          if (!request) return;
          void request
            .then(async (updatedFinanceObject) => {
              setWorkObjectsByRole((current) => ({
                ...current,
                finance: current.finance.map((object) =>
                  object.id === updatedFinanceObject.id ? updatedFinanceObject : object,
                ),
              }));
              setSelectedByRole((current) => ({
                ...current,
                finance: updatedFinanceObject.id,
                director: `DIR-${updatedFinanceObject.id}`,
              }));

              if (isFinanceInvoiceAction(actionId)) {
                setMutatingOfficeActionOutcome('finance', updatedFinanceObject.id, actionId, {
                  tone: 'success',
                  title: 'Счёт оформлен вручную.',
                });
              } else if (isFinanceSourceRetryAction(actionId)) {
                setMutatingOfficeActionOutcome('finance', updatedFinanceObject.id, actionId, {
                  tone: 'success',
                  title: 'Проверка источника записана.',
                });
              } else if (isFinanceProblemAction(actionId)) {
                setMutatingOfficeActionOutcome('finance', updatedFinanceObject.id, actionId, {
                  tone: 'warning',
                  title: 'Проблема отправлена директору.',
                });
              } else if (isFinanceDistributePaymentAction(actionId)) {
                setMutatingOfficeActionOutcome('finance', updatedFinanceObject.id, actionId, {
                  tone: 'success',
                  title: 'Выплата разнесена по рассрочке.',
                  detail: payload?.operationAmountLabel,
                });
              } else {
                setMutatingOfficeActionOutcome('finance', updatedFinanceObject.id, actionId, {
                  tone: 'success',
                  title:
                    scheduleId || isFinanceCheckPaymentAction(actionId)
                      ? 'Поступление проверено.'
                      : 'Оплата обновлена вручную.',
                });
              }
            })
            .catch((error: unknown) => {
              setOfficeActionOutcome('finance', selectedObject.id, {
                tone: 'critical',
                title: isFinanceInvoiceAction(actionId)
                  ? 'Учётный счёт не обновлён.'
                  : isFinanceSourceRetryAction(actionId)
                    ? 'Проверка источника не запрошена.'
                    : isFinanceProblemAction(actionId)
                      ? 'Проблема не отправлена.'
                      : 'Оплата не обновлена.',
                detail: error instanceof Error ? error.message : 'Не удалось выполнить действие.',
              });
            });
          return;
        }
      }

      const beforeStatus = selectedObject.statusLabel;
      const nextObject = reduceFinanceObject(selectedObject, actionId);
      if (nextObject === selectedObject) return;
      const isPaymentDueAction =
        (beforeStatus === 'Оплата сегодня' || beforeStatus === 'К оплате') &&
        nextObject.statusLabel === 'Счет к оплате отправлен';
      const isProblemCreated =
        nextObject.problems.some((problem) => problem.status === 'open') &&
        nextObject.problems.length > selectedObject.problems.length;

      updateRoleObject('finance', selectedObject.id, () => nextObject);
      setSelectedByRole((current) => ({
        ...current,
        finance: nextObject.id,
        director: `DIR-${nextObject.id}`,
      }));
      if (actionId === 'issue' || actionId.startsWith('finance-create-invoice:')) {
        setMutatingOfficeActionOutcome('finance', nextObject.id, actionId, {
          tone: 'success',
          title: isPaymentDueAction ? 'Счет к оплате отправлен.' : 'Счет выставлен.',
        });
      } else if (isPaymentDueAction) {
        setMutatingOfficeActionOutcome('finance', nextObject.id, actionId, {
          tone: 'success',
          title: 'Счет к оплате отправлен.',
        });
      } else if (
        actionId === 'update-payment' ||
        actionId === 'update-installment' ||
        actionId === 'update-after-invoice' ||
        actionId.startsWith('finance-update-payment:') ||
        actionId.startsWith('finance-confirm-cash:')
      ) {
        setMutatingOfficeActionOutcome('finance', nextObject.id, actionId, {
          tone: 'success',
          title: 'Оплата обновлена вручную.',
        });
      } else if (
        [
          'check-payment',
          'check-installment',
          'check-after-invoice',
          'retry-sync',
          'retry-issued',
        ].includes(actionId) ||
        actionId.startsWith('finance-check-payment:') ||
        actionId.startsWith('finance-retry-sync:')
      ) {
        setMutatingOfficeActionOutcome('finance', nextObject.id, actionId, {
          tone: 'success',
          title: actionId.includes('check')
            ? 'Поступление проверено.'
            : 'Проверка источника записана.',
        });
      } else if (isProblemCreated) {
        setMutatingOfficeActionOutcome('finance', nextObject.id, actionId, {
          tone: 'warning',
          title: 'Проблема создана.',
        });
      }

      if (
        (nextObject.statusLabel === 'Счет выставлен' && beforeStatus !== 'Счет выставлен') ||
        isPaymentDueAction
      ) {
        const hasDirectorDueNotification = hasDirectorPaymentDueNotification(
          notifications,
          selectedObject.id,
        );
        setNotifications((current) =>
          resolvePaymentDueNotifications(current, selectedObject.id, {
            severity: 'info',
            title: 'Счет к оплате отправлен',
            body: 'Бухгалтерия закрыла плановое уведомление и отправила счет к оплате. Просрочки пока нет.',
          }),
        );
        if (isPaymentDueAction) {
          if (!hasDirectorDueNotification) {
            notifyRole(
              'director',
              nextObject.id,
              'Счет к оплате отправлен',
              'Бухгалтерия закрыла плановое уведомление и отправила счет к оплате. Просрочки пока нет.',
              'info',
            );
          }
        } else {
          notifyRole(
            'director',
            nextObject.id,
            'Счет выставлен',
            'Бухгалтерия обновила статус счета; директор видит финансовый факт из того же источника.',
            'info',
          );
        }
      }
      if (nextObject.statusLabel === 'Оплачено') {
        const hasDirectorDueNotification = hasDirectorPaymentDueNotification(
          notifications,
          selectedObject.id,
        );
        setNotifications((current) =>
          resolvePaymentDueNotifications(current, selectedObject.id, {
            severity: 'info',
            title: 'Оплата отмечена вручную',
            body: 'Бухгалтерия вручную подтвердила оплату по плановой дате. Финансовый риск закрыт.',
          }),
        );
        if (!hasDirectorDueNotification) {
          notifyRole(
            'director',
            nextObject.id,
            'Оплата отмечена вручную',
            'Финансовый риск закрыт действием бухгалтерии с записью в истории.',
            'info',
          );
        }
      }
      if (isProblemCreated) {
        notifyRole(
          'director',
          nextObject.id,
          'Финансовая проблема',
          'Бухгалтерия создала проблему с владельцем.',
          'warning',
        );
      }
      return;
    }
  }

  function reorderRoleQueue(role: Role, sourceId: string, targetId: string) {
    if (role !== 'commercial' && role !== 'production') return;
    setWorkObjectsByRole((current) => {
      const queue = current[role];
      const sourceIndex = queue.findIndex((object) => object.id === sourceId);
      const targetIndex = queue.findIndex((object) => object.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current;
      if (
        !canReorderStatus(queue[sourceIndex].statusLabel) ||
        !canReorderStatus(queue[targetIndex].statusLabel)
      )
        return current;
      const nextQueue = [...queue];
      const [moved] = nextQueue.splice(sourceIndex, 1);
      nextQueue.splice(targetIndex, 0, {
        ...moved,
        audit: [
          auditEntry(
            moved.id,
            getRoleConfig(role).label,
            'Порядок очереди изменен',
            'Строку перетащили в новое место очереди.',
          ),
          ...moved.audit,
        ],
      });
      return { ...current, [role]: nextQueue };
    });
  }

  function moveRoleQueueItem(role: Role, id: string, direction: 'up' | 'down') {
    if (role !== 'commercial' && role !== 'production') return;
    setWorkObjectsByRole((current) => {
      const queue = current[role];
      const index = queue.findIndex((object) => object.id === id);
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= queue.length) return current;
      if (
        !canReorderStatus(queue[index].statusLabel) ||
        !canReorderStatus(queue[targetIndex].statusLabel)
      )
        return current;
      const nextQueue = [...queue];
      const [moved] = nextQueue.splice(index, 1);
      nextQueue.splice(targetIndex, 0, {
        ...moved,
        audit: [
          auditEntry(
            moved.id,
            getRoleConfig(role).label,
            'Порядок очереди изменен',
            direction === 'up'
              ? 'Строку подняли выше в очереди.'
              : 'Строку опустили ниже в очереди.',
          ),
          ...moved.audit,
        ],
      });
      return { ...current, [role]: nextQueue };
    });
  }

  return (
    <IxApplication
      theme="classic"
      colorSchema="dark"
      data-auth-required={AUTH_REQUIRED ? 'true' : 'false'}
    >
      <DemoRoleSwitcherGate authRequired={AUTH_REQUIRED}>
        <DemoRoleSwitcher
          activeRole={activeRole}
          operatorCount={operatorRuntime.orders.length}
          workObjectsByRole={projectedWorkObjectsByRole}
          onChangeRole={changeRole}
        />
      </DemoRoleSwitcherGate>
      <ProductHeader
        activeSection={displaySection}
        configLabel={config.label}
        session={session}
        unread={roleUnreadCount}
        pendingAck={ackCount(roleNotifications)}
        openPanel={openPanel}
        onOpenPanel={setOpenPanel}
      />
      <main
        ref={appShellRef}
        className="app-shell"
        data-active-role={activeRole}
        data-role-layout={isFocusedRole(activeRole) ? 'focus' : 'office'}
        data-template-directory={isTemplateDirectory ? 'true' : 'false'}
        data-template-directory-mode={isTemplateDirectory ? templateDirectoryMode : undefined}
        data-admin-access-mode={isAdminAccessMode ? 'true' : 'false'}
        data-warehouse-inventory-page={isWarehouseInventoryPage ? 'true' : 'false'}
        data-direct-detail={
          isSingleObjectDirectDetail ||
          activeRole === 'finance' ||
          isFinanceRegistryPage ||
          isRawMaterialStandaloneSection ||
          isProductionStandaloneSection ||
          isProductionPenaltySection ||
          isDirectorProblemsSection ||
          isOperatorRollsHubSection ||
          isOperatorShiftSection ||
          isOperatorPayrollSection ||
          isWarehouseDefectBagSection ||
          isWarehouseScanStationSection ||
          isWarehouseInventoryPage
            ? 'true'
            : 'false'
        }
      >
        {!isFocusedRole(activeRole) && !(activeRole === 'commercial' && isCommercialLive) && (
          <RoleNavigation
            role={activeRole}
            activeSection={activeSection}
            workObjectsByRole={projectedWorkObjectsByRole}
            sectionCounts={
              activeRole === 'director' || activeRole === 'production'
                ? roleNavigationSectionCounts
                : undefined
            }
            onChangeSection={changeSection}
            hideCounts={activeRole === 'admin' && isAdminLive}
          />
        )}

        {activeLiveRoleUnavailable ? (
          <LiveRoleUnavailable
            role={activeRole as LiveRoleSnapshotRole}
            state={activeLiveRoleLoadState as Exclude<LiveRoleLoadState, 'ready'>}
          />
        ) : activeRole === 'commercial' && isCommercialLive ? (
          <CommercialWorkspace
            activeSection={commercialActiveSection}
            selectedOrderId={selectedByRole.commercial}
            selectedProblemId={selectedBusinessProblemIdByRole.commercial}
            refreshGeneration={businessRefreshGeneration}
            onChangeSection={changeSection}
            onReconcileSelection={reconcileCommercialSelection}
            onMutationSuccess={() => liveRefreshControllerRef.current?.invalidateAndRefresh()}
            effectiveCapabilities={effectiveCapabilities}
            onSelectOrder={(orderId, section) =>
              keepCommercialObjectVisible(
                orderId,
                section ??
                  (commercialActiveSection === 'Сырьё' ? 'В работе' : commercialActiveSection),
              )
            }
          />
        ) : isDirectorProblemsSection ? (
          <ProductionProblemsSurface mode="director" problems={directorProblems} />
        ) : activeRole === 'director' &&
          !isRawMaterialStandaloneSection &&
          !isWarehouseInventoryPage ? (
          <DirectorWorkbench
            activeSection={activeSection}
            selectedId={selectedByRole.director}
            selectedProblemId={selectedBusinessProblemIdByRole.director}
            isMobileViewport={isMobileViewport}
            workObjectsByRole={projectedWorkObjectsByRole}
            dashboard={directorDashboard}
            supplementalState={isDirectorLive ? directorSupplemental.byScope : undefined}
            onRetrySupplemental={isDirectorLive ? directorSupplemental.retry : undefined}
            viewMode={directorView}
            quickFilter={directorQuickFilter}
            onSelect={selectObject}
            onOpenRole={changeRole}
            onAction={applyDirectorAction}
            onClose={clearActiveSelection}
            onDashboardDrilldown={applyDirectorDashboardDrilldown}
            penaltySnapshot={directorPenaltySnapshot}
            penaltyFilters={livePenaltySnapshots.director.filters}
            penaltyScopeObjectId={penaltyScopeObjectId}
            penaltyEmployees={isDirectorLive ? liveDirectorPenaltyEmployees : undefined}
            canCreatePenalty={canCreatePenalty}
            allowPenaltyUpdate={!isDirectorLive}
            onPenaltyCreate={createDirectorPenalty}
            onPenaltyUpdate={updateDirectorPenalty}
            onPenaltyFiltersChange={(filters) => changePenaltyFilters('director', filters)}
            onViewModeChange={(mode) => {
              setDirectorView(mode);
              setDirectorQuickFilter('all');
            }}
            onQuickFilterChange={(nextView, nextFilter) => {
              setDirectorView(nextView);
              setDirectorQuickFilter(nextFilter);
            }}
            onRefresh={isDirectorLive ? refreshDirectorTab : undefined}
            refreshing={directorRefreshPending}
            refreshGeneration={businessRefreshGeneration}
            useLiveData={isDirectorLive}
          />
        ) : (
          <>
            {!isAdminAccessMode &&
              !isSingleObjectDirectDetail &&
              activeRole !== 'finance' &&
              !isFinanceRegistryPage &&
              !isRawMaterialStandaloneSection &&
              !isProductionStandaloneSection &&
              !isProductionPenaltySection &&
              !isOperatorRollsHubSection &&
              !isOperatorShiftSection &&
              !isOperatorPayrollSection &&
              !isWarehouseDefectBagSection &&
              !isWarehouseScanStationSection &&
              (!isWarehouseInventoryPage || isFocusedRole(activeRole)) &&
              !(
                isProductionLive &&
                isTemplateDirectory &&
                productionTemplateLoadState !== 'ready'
              ) &&
              !(isTemplateDirectory && templateDirectoryMode === 'stock') && (
                <section
                  className={`list-panel ${isWarehouseInventoryPage ? 'warehouse-nav-only-panel warehouse-inventory-hub-page' : ''}`}
                  aria-label={config.listTitle}
                >
                  {isFocusedRole(activeRole) && (
                    <RoleTopNavigation
                      role={activeRole}
                      activeSection={activeSection}
                      operatorRuntime={operatorRuntime}
                      workObjectsByRole={projectedWorkObjectsByRole}
                      sectionCounts={
                        activeRole === 'warehouse' ? warehouseSectionCounts : undefined
                      }
                      onChangeSection={changeSection}
                    />
                  )}
                  {!isWarehouseInventoryPage && (
                    <>
                      <header className="panel-header">
                        <div>
                          <div className="eyebrow">{config.label}</div>
                          <h1>{displaySection}</h1>
                        </div>
                        <div className="panel-header-actions">
                          {canCreateRequestFromRole && (
                            <button
                              className="create-intake-button action-keyboard-anchor"
                              type="button"
                              onClick={(event) =>
                                openIntakeModal('commercial', event.currentTarget)
                              }
                            >
                              Создать заявку
                            </button>
                          )}
                          {isTemplateDirectory &&
                            templateDirectoryMode === 'counterparty' &&
                            !isProductionLive && (
                              <button
                                className="create-intake-button action-keyboard-anchor"
                                type="button"
                                onClick={() => openTemplateEditor('add')}
                              >
                                Добавить шаблон
                              </button>
                            )}
                          <span
                            className="panel-count-label"
                            aria-label={`В списке ${visibleCount}`}
                          >
                            {visibleCount}
                          </span>
                        </div>
                      </header>
                      {activeRole === 'admin' && !isAdminAccessMode && detailObject && (
                        <div
                          className="admin-primary-safe-action"
                          role="status"
                          aria-label="Текущая проверка администратора"
                        >
                          <span>
                            <span>Проверка сейчас</span>
                            <strong>{detailObject.title}</strong>
                          </span>
                          <button
                            className="compact-action-button primary"
                            type="button"
                            onClick={() => selectObject(detailObject.id)}
                          >
                            <ix-icon name="tasks-open" size="16" />
                            <span>Открыть проверку</span>
                          </button>
                        </div>
                      )}
                      {isTemplateDirectory ? (
                        <CounterpartyTemplateList
                          counterpartyCatalog={
                            isProductionLive ? productionTemplateCounterparties : undefined
                          }
                          templates={templateCatalog}
                          selectedCounterpartyId={selectedCounterpartyId}
                          onSelect={setSelectedCounterpartyId}
                          query={
                            isProductionLive && templateDirectoryMode === 'counterparty'
                              ? productionTemplateCounterpartyQuery
                              : undefined
                          }
                          onQueryChange={
                            isProductionLive && templateDirectoryMode === 'counterparty'
                              ? setProductionTemplateCounterpartyQuery
                              : undefined
                          }
                          loading={productionTemplatePageLoading}
                          hasMore={Boolean(productionTemplateNextCursor)}
                          onLoadMore={loadMoreProductionTemplateCounterparties}
                        />
                      ) : (
                        <>
                          {(queueFilterOptions.length > 1 || listItems.length > 0) && (
                            <div
                              className={`queue-toolbar ${isArchiveQueueMode ? 'is-archive-mode' : ''}`}
                              aria-label="Настройки списка"
                            >
                              {queueFilterOptions.length > 1 && (
                                <div
                                  className="queue-filter-group"
                                  aria-label={
                                    activeRole === 'warehouse'
                                      ? 'Показать в списке'
                                      : 'Строки в списке'
                                  }
                                >
                                  {activeRole === 'warehouse' && (
                                    <span className="queue-control-label">Показать</span>
                                  )}
                                  <div
                                    className="filter-row"
                                    role="radiogroup"
                                    aria-label="Какие строки показать"
                                  >
                                    {queueFilterOptions.map((item) => (
                                      <HelpTooltip
                                        key={item.id}
                                        text={item.help}
                                        focusable={false}
                                        className="filter-help-frame"
                                      >
                                        <button
                                          className={`filter-chip ${filter === item.id ? 'is-active' : ''}`}
                                          onClick={() => changeQueueFilter(item.id)}
                                          type="button"
                                          role="radio"
                                          aria-checked={filter === item.id}
                                          title={item.help}
                                          aria-label={`${item.label}: ${item.count} строк. ${item.help}`}
                                        >
                                          <span>{item.label}</span>
                                          <small>{item.count}</small>
                                        </button>
                                      </HelpTooltip>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {listItems.length > 0 && (
                                <DateScopeDropdown
                                  items={listItems}
                                  rangeSelection={activeRole === 'operator'}
                                  scope={queueDateScope}
                                  onChange={(scope) =>
                                    setQueueDateScopeByRole((current) => ({
                                      ...current,
                                      [activeRole]: scope,
                                    }))
                                  }
                                />
                              )}
                              {isArchiveQueueMode && (
                                <div className="queue-archive-note" role="status">
                                  <ix-icon name="history" size="16" />
                                  <span>
                                    <strong>Завершенные заказы</strong>
                                    <small>
                                      Только просмотр: причина закрытия, дата и история.
                                    </small>
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                          <ObjectList
                            role={activeRole}
                            items={visibleListItems}
                            selectedId={selectedId}
                            emptyText={config.emptyText}
                            reducedMotion={session.reducedMotion}
                            reorderable={activeRole === 'commercial' || activeRole === 'production'}
                            onReorder={(sourceId, targetId) =>
                              reorderRoleQueue(activeRole, sourceId, targetId)
                            }
                            onMove={(id, direction) => moveRoleQueueItem(activeRole, id, direction)}
                            onSelect={selectObject}
                            activeSection={activeSection}
                          />
                        </>
                      )}
                    </>
                  )}
                </section>
              )}

            <section className="detail-panel" aria-live="polite">
              {selectedNavigationOutcome && (
                <div
                  className={`office-action-outcome global-action-outcome tone-${selectedNavigationOutcome.tone}`}
                  role="status"
                  aria-live="polite"
                >
                  <ix-icon
                    name={
                      selectedNavigationOutcome.tone === 'success'
                        ? 'check'
                        : selectedNavigationOutcome.tone === 'critical'
                          ? 'warning'
                          : 'info'
                    }
                    size="16"
                  />
                  <span>
                    <strong>{selectedNavigationOutcome.title}</strong>
                    {selectedNavigationOutcome.detail && (
                      <small>{selectedNavigationOutcome.detail}</small>
                    )}
                  </span>
                </div>
              )}
              {activeRole === 'commercial' &&
                !isMobileViewport &&
                !isTemplateDirectory &&
                !isRawMaterialModuleSection &&
                !selectedObject && (
                  <div
                    className="commercial-empty-workspace"
                    role="status"
                    aria-label="Заявка не выбрана"
                  >
                    <span className="eyebrow">Коммерция</span>
                    <h2>Выберите заявку</h2>
                  </div>
                )}
              {isWarehouseDefectBagSection && warehouseDefectBagMode ? (
                <div className="warehouse-scan-hub-page">
                  <RoleTopNavigation
                    role={activeRole}
                    activeSection={activeSection}
                    workObjectsByRole={projectedWorkObjectsByRole}
                    sectionCounts={warehouseSectionCounts}
                    onChangeSection={changeSection}
                  />
                  <WarehouseDefectBagSurface
                    key={warehouseDefectBagMode}
                    mode={warehouseDefectBagMode}
                    bags={warehouseDefectBagQueues.bags}
                    loading={warehouseDefectBagQueues.loading}
                    loadError={warehouseDefectBagQueues.error}
                    onScan={isWarehouseLive ? handleWarehouseScan : undefined}
                    onRetry={() => setWarehouseLiveTick((tick) => tick + 1)}
                  />
                </div>
              ) : isWarehouseScanStationSection ? (
                <div className="warehouse-scan-hub-page">
                  <RoleTopNavigation
                    role={activeRole}
                    activeSection={activeSection}
                    workObjectsByRole={projectedWorkObjectsByRole}
                    sectionCounts={warehouseSectionCounts}
                    onChangeSection={changeSection}
                  />
                  <WarehouseScanStationSurface
                    objects={projectedWorkObjectsByRole.warehouse}
                    activeSection={activeSection}
                    selectedObjectId={selectedId}
                    onSelectObject={selectObject}
                    onAction={(actionId) => applyWorkObjectAction(actionId)}
                    onScanPayload={isWarehouseLive ? handleWarehouseScan : undefined}
                    onPalletScanPayload={
                      isWarehouseLive ? handleWarehousePalletSelectionScan : undefined
                    }
                    onClearSelection={clearActiveSelection}
                    onWarehouseRefresh={() => setWarehouseLiveTick((tick) => tick + 1)}
                  />
                </div>
              ) : isOperatorRollsHubSection ? (
                <OperatorRollsHubPageLayout
                  detailFirst={isOperatorWorkstationViewport}
                  hasDetail={Boolean(detailObject)}
                  navigation={
                    <>
                      <RoleTopNavigation
                        role={activeRole}
                        activeSection={activeSection}
                        operatorRuntime={operatorRuntime}
                        workObjectsByRole={projectedWorkObjectsByRole}
                        onChangeSection={changeSection}
                      />
                      <OperatorMachineChangePanel
                        change={operatorMachineChange}
                        busy={operatorMachineChangeBusy}
                        onFinalize={finalizeLiveOperatorMachineChange}
                      />
                    </>
                  }
                  hub={
                    <OperatorRollsHubSurface
                      runtime={operatorRuntime}
                      selectedRollId={selectedId}
                      onSelectRoll={selectObject}
                      scope={isOperatorHandoverHubSection ? 'handover' : 'all'}
                    />
                  }
                  detail={
                    <DetailView
                      role={activeRole}
                      object={detailObject}
                      operatorRuntime={operatorRuntime}
                      bigBagWeightDraft={bigBagWeightDraft}
                      onBigBagWeightDraftChange={setBigBagWeightDraft}
                      selectedTemplateId={
                        detailObject ? selectedTemplateByObject[detailObject.id] : undefined
                      }
                      templateCatalog={templateCatalog}
                      templateVersions={templateVersions}
                      onAction={applyOperatorAction}
                      pendingActionId={operatorPendingActionId}
                      onStockMutation={applyWarehouseStockMutationDraft}
                      actionOutcome={selectedOfficeOutcome}
                      onClose={clearActiveSelection}
                      onOpenShift={() => changeSection('Смена')}
                      siblingObjects={projectedWorkObjectsByRole[activeRole] ?? []}
                      onSelectObject={selectObject}
                      activeSection={OPERATOR_ROLLS_SECTION}
                      onTemplateSelect={(objectId, templateId) =>
                        setSelectedTemplateByObject((current) => ({
                          ...current,
                          [objectId]: templateId,
                        }))
                      }
                    />
                  }
                />
              ) : isProductionProblemsSection ? (
                <ProductionProblemsSurface
                  problems={productionProblems}
                  selectedProblemId={selectedProductionProblemId}
                  busy={productionPlanningBusy}
                  onResolveDefect={isProductionLive ? resolveLiveProductionDefect : undefined}
                  onResolveBreakdown={isProductionLive ? resolveLiveProductionBreakdown : undefined}
                  onResolveGeneral={isProductionLive ? resolveLiveProductionGeneral : undefined}
                  onStartRepair={isProductionLive ? startLiveProductionMachineRepair : undefined}
                  onCompleteRepair={
                    isProductionLive ? completeLiveProductionMachineRepair : undefined
                  }
                />
              ) : isProductionOperatorLoadSection ? (
                <div className="production-operator-planning-page">
                  {isProductionLive && (
                    <ProductionMachinePlanningSurface
                      shifts={productionShifts}
                      posts={productionPosts}
                      operators={productionOperatorOptions.map((operator) => ({
                        id: operator.operatorId,
                        displayName: operator.displayName,
                      }))}
                      busy={productionPlanningBusy}
                      onCreateShift={createLiveProductionShift}
                      onAssignMachine={assignLiveProductionMachine}
                      onBreakdownReassign={breakdownReassignLiveProductionMachine}
                      onIntentionalMachineChange={requestLiveIntentionalMachineChange}
                      onCancelAssignment={cancelLiveProductionAssignment}
                      onCancelMachineChange={cancelLiveProductionMachineChange}
                      onReportBreakdown={reportLiveProductionMachineBreakdown}
                      onStartRepair={startLiveProductionMachineRepair}
                      onCompleteRepair={completeLiveProductionMachineRepair}
                    />
                  )}
                  <ProductionOperatorLoadSurface
                    rollDispatchItems={productionAggregateRolls}
                    operators={isProductionLive ? liveProductionOperators : undefined}
                  />
                </div>
              ) : isProductionOrdersHubSection || isProductionRollQueueSection ? (
                <ProductionOrdersHubSurface
                  orders={productionOrderObjects}
                  rollDispatchItems={productionAggregateRolls}
                  initialView={isProductionRollQueueSection ? 'rolls' : 'orders'}
                  onUpdateRollOperator={(rollDispatchItemId, operatorId) =>
                    isProductionLive
                      ? assignLiveProductionRollOperator(rollDispatchItemId, operatorId)
                      : applyWorkObjectAction(
                          `production-set-roll-operator:${rollDispatchItemId}:${operatorId}`,
                        )
                  }
                  onUpdateRollMachine={(rollDispatchItemId, machineId) =>
                    applyWorkObjectAction(
                      `production-set-roll-machine:${rollDispatchItemId}:${machineId}`,
                    )
                  }
                  onUpdateRollPriority={(rollDispatchItemId, priority) =>
                    isProductionLive
                      ? setLiveProductionRollPriority(rollDispatchItemId, priority)
                      : applyWorkObjectAction(
                          `production-set-roll-priority:${rollDispatchItemId}:${priority}`,
                        )
                  }
                  onBulkAssign={(rollIds, operatorId, priority) =>
                    applyWorkObjectAction(
                      `production-bulk-assign:${rollIds.map(encodeURIComponent).join(',')}:${operatorId}:${priority}`,
                    )
                  }
                  onSaveSelected={isProductionLive ? saveLiveProductionRolls : undefined}
                  onMoveRollQueue={(rollDispatchItemId, direction) =>
                    isProductionLive
                      ? moveLiveProductionRoll(rollDispatchItemId, direction)
                      : applyWorkObjectAction(
                          `production-move-roll:${rollDispatchItemId}:${direction}`,
                        )
                  }
                  onApproveOrder={approveLiveProductionHubOrder}
                  operators={isProductionLive ? liveProductionOperators : undefined}
                  machineOptions={isProductionLive ? liveProductionMachineOptions : undefined}
                  lockMachineToOperator={isProductionLive}
                  useLiveData={isProductionLive}
                  commercialActionsState={productionCommercialActionsState}
                  onRetryCommercialActions={
                    isProductionLive
                      ? () => {
                          setProductionCommercialActionsState('loading');
                          requestLiveRoleRefresh('production');
                        }
                      : undefined
                  }
                  onFetchArchive={isProductionLive ? fetchProductionArchive : undefined}
                  onOpenProblems={isProductionLive ? () => changeSection('Проблемы') : undefined}
                  mode={isProductionRollQueueSection ? 'all-rolls' : 'order-selection'}
                />
              ) : isTemplateDirectory ? (
                templateDirectoryMode === 'stock' ? (
                  <StockProductionTemplateDirectory
                    materials={materialRecipeCatalog.materials}
                    recipes={materialRecipeCatalog.recipes}
                    materialCatalogStatus={materialRecipeCatalog.status}
                    materialCatalogError={materialRecipeCatalog.error}
                    onRetryMaterialCatalog={() => materialRecipeCatalog.reload()}
                    mode={templateDirectoryMode}
                    onModeChange={setTemplateDirectoryMode}
                    readOnly={false}
                  />
                ) : isProductionLive && productionTemplateLoadState !== 'ready' ? (
                  <section
                    className="surface template-directory-view"
                    role={productionTemplateLoadState === 'error' ? 'alert' : 'status'}
                    aria-label="Загрузка клиентских шаблонов"
                  >
                    <TemplateDirectoryModeTabs
                      mode={templateDirectoryMode}
                      onChange={setTemplateDirectoryMode}
                    />
                    <div className="production-route-blocked">
                      <strong>
                        {productionTemplateLoadState === 'error'
                          ? 'Клиентские шаблоны недоступны'
                          : 'Загружаем клиентов и шаблоны'}
                      </strong>
                      {productionTemplateLoadError ? <p>{productionTemplateLoadError}</p> : null}
                      {productionTemplateLoadState === 'error' ? (
                        <button
                          type="button"
                          className="action-peer"
                          onClick={() =>
                            setProductionTemplateReloadGeneration((current) => current + 1)
                          }
                        >
                          Повторить
                        </button>
                      ) : null}
                    </div>
                  </section>
                ) : (
                  <>
                    {isProductionLive && productionTemplateLoadError ? (
                      <div className="production-route-blocked" role="status">
                        <strong>{productionTemplateLoadError}</strong>
                        <button
                          type="button"
                          className="action-peer"
                          onClick={() =>
                            setProductionTemplateReloadGeneration((current) => current + 1)
                          }
                        >
                          Повторить
                        </button>
                      </div>
                    ) : null}
                    <TemplateDirectorySurface
                      counterpartyCatalog={
                        isProductionLive ? productionTemplateCounterparties : undefined
                      }
                      selectedCounterpartyId={selectedCounterpartyId}
                      templates={templateCatalog}
                      versions={templateVersions}
                      query={templateQuery}
                      sortMode={templateSort}
                      editor={templateEditor}
                      onQueryChange={setTemplateQuery}
                      onSortChange={setTemplateSort}
                      onOpenEditor={openTemplateEditor}
                      onArchive={archiveTemplate}
                      onActivate={activateTemplate}
                      onEditorChange={setTemplateEditor}
                      onSafeFieldChange={autosaveTemplateSafeField}
                      onSave={saveTemplateEditor}
                      onCancelEdit={() => setTemplateEditor(null)}
                      mode={templateDirectoryMode}
                      onModeChange={setTemplateDirectoryMode}
                      allowLifecycleActions
                      allowEditingActions
                      allowOwnerRoleEdit={false}
                      requireVersionReason={!isProductionLive}
                      materials={materialRecipeCatalog.materials}
                      recipes={materialRecipeCatalog.recipes}
                      materialCatalogStatus={materialRecipeCatalog.status}
                      materialCatalogError={materialRecipeCatalog.error}
                      onRetryMaterialCatalog={() => void materialRecipeCatalog.reload()}
                    />
                  </>
                )
              ) : isOperatorShiftSection ? (
                <div className="operator-shift-page">
                  <RoleTopNavigation
                    role={activeRole}
                    activeSection={activeSection}
                    operatorRuntime={operatorRuntime}
                    workObjectsByRole={projectedWorkObjectsByRole}
                    onChangeSection={changeSection}
                  />
                  <OperatorMachineChangePanel
                    change={operatorMachineChange}
                    busy={operatorMachineChangeBusy}
                    onFinalize={finalizeLiveOperatorMachineChange}
                  />
                  {operatorClosingPayroll?.userId === session.id &&
                  operatorClosingPayroll.payroll.shiftId === operatorRuntime.shift.id ? (
                    <ShiftClosingPayrollSummary
                      payroll={operatorClosingPayroll.payroll}
                      onDismiss={() => setOperatorClosingPayroll(null)}
                    />
                  ) : null}
                  <OperatorShiftSurface
                    runtime={operatorRuntime}
                    draft={bigBagWeightDraft}
                    onDraftChange={setBigBagWeightDraft}
                    onAction={applyOperatorAction}
                    breakdownPending={operatorBreakdownPending}
                    breakdownError={operatorBreakdownError}
                    breakdownSuccessVersion={operatorBreakdownSuccessVersion}
                    onBackToOrders={() => changeSection(OPERATOR_ROLLS_SECTION)}
                    bigBags={isOperatorLive ? operatorBigBags : undefined}
                    onReleaseBag={isOperatorLive ? releaseLiveOperatorBigBag : undefined}
                    pendingActionId={operatorPendingActionId}
                  />
                </div>
              ) : isOperatorPayrollSection ? (
                <div className="operator-payroll-page">
                  <RoleTopNavigation
                    role={activeRole}
                    activeSection={activeSection}
                    operatorRuntime={operatorRuntime}
                    workObjectsByRole={projectedWorkObjectsByRole}
                    onChangeSection={changeSection}
                  />
                  <OperatorPayrollSurface />
                </div>
              ) : isOperatorPenaltySection ? (
                <OperatorPenaltiesSurface
                  penalties={operatorPenalties}
                  selectedPenaltyId={selectedId}
                />
              ) : isProductionPenaltySection ? (
                <PenaltyManagementSurface
                  snapshot={productionPenaltySnapshot}
                  filters={livePenaltySnapshots.production.filters}
                  selectedPenaltyId={selectedId}
                  scopedObjectId={penaltyScopeObjectId}
                  defaultAuthor="Зав. производства"
                  authorRole="production"
                  assignmentEmployees={
                    isProductionLive
                      ? liveProductionOperators.map((operator) => ({
                          id: operator.id,
                          name: operator.name,
                          role: 'Оператор',
                        }))
                      : undefined
                  }
                  workCatalog={isProductionLive ? productionPenaltyWorkCatalog : undefined}
                  canCreatePenalty={canCreatePenalty}
                  allowUpdate={!isProductionLive}
                  onCreate={createProductionPenalty}
                  onUpdate={updateProductionPenalty}
                  onFiltersChange={(filters) => changePenaltyFilters('production', filters)}
                />
              ) : isAdminPalletLayoutSection ? (
                <PalletLabelLayoutSection />
              ) : activeRole === 'admin' && isAdminLive ? (
                <AdminLiveControlPlane
                  section={activeSection}
                  selectedIncidentId={selectedAdminIncidentId}
                />
              ) : activeRole === 'admin' && activeSection === 'Доступы' ? (
                <AdminUsersSurface
                  users={adminUsers}
                  templates={adminRoleTemplates}
                  draft={roleAssignmentDraft}
                  onDraftChange={setRoleAssignmentDraft}
                  onAssign={assignAdminRole}
                  onUserSave={saveAdminUserAccess}
                  onRevokeAccess={revokeAdminUserAccess}
                />
              ) : activeRole === 'admin' && activeSection === 'Шаблоны ролей' ? (
                <AdminRoleTemplatesSurface
                  templates={adminRoleTemplates}
                  history={adminHistory.filter((event) => !event.target.includes('@')).slice(0, 6)}
                  onTemplateSave={saveAdminRoleTemplate}
                />
              ) : activeRole === 'admin' &&
                (activeSection === 'Устройства' || activeSection === 'Источники') ? (
                <>
                  <DetailView
                    role={activeRole}
                    object={detailObject}
                    operatorRuntime={operatorRuntime}
                    bigBagWeightDraft={bigBagWeightDraft}
                    onBigBagWeightDraftChange={setBigBagWeightDraft}
                    selectedTemplateId={
                      detailObject ? selectedTemplateByObject[detailObject.id] : undefined
                    }
                    templateCatalog={templateCatalog}
                    templateVersions={templateVersions}
                    onAction={applyWorkObjectAction}
                    onStockMutation={applyWarehouseStockMutationDraft}
                    actionOutcome={selectedOfficeOutcome}
                    onClose={clearActiveSelection}
                    siblingObjects={projectedWorkObjectsByRole[activeRole] ?? []}
                    onSelectObject={selectObject}
                    activeSection={activeSection}
                    onTemplateSelect={(objectId, templateId) =>
                      setSelectedTemplateByObject((current) => ({
                        ...current,
                        [objectId]: templateId,
                      }))
                    }
                  />
                  <AdminDevicesSurface
                    devices={productionRuntime.devices}
                    section={activeSection}
                    onDeviceSave={saveAdminDevice}
                    onDeviceTest={testAdminDevice}
                  />
                </>
              ) : activeRole === 'commercial' &&
                !isRawMaterialModuleSection &&
                !detailObject ? null : (
                <DetailView
                  role={activeRole}
                  object={detailObject}
                  operatorRuntime={operatorRuntime}
                  bigBagWeightDraft={bigBagWeightDraft}
                  onBigBagWeightDraftChange={setBigBagWeightDraft}
                  selectedTemplateId={
                    detailObject ? selectedTemplateByObject[detailObject.id] : undefined
                  }
                  templateCatalog={templateCatalog}
                  templateVersions={templateVersions}
                  onAction={activeRole === 'operator' ? applyOperatorAction : applyWorkObjectAction}
                  pendingActionId={activeRole === 'operator' ? operatorPendingActionId : null}
                  onStockMutation={
                    activeRole === 'warehouse' && detailObject?.id === 'warehouse-live-inventory'
                      ? undefined
                      : applyWarehouseStockMutationDraft
                  }
                  onAdjustRawMaterial={
                    activeRole === 'warehouse' &&
                    isWarehouseLive &&
                    canAdjustWarehouseRawMaterial &&
                    detailObject?.id === 'warehouse-live-inventory'
                      ? adjustLiveWarehouseRawMaterial
                      : undefined
                  }
                  onReceiveRawMaterial={
                    activeRole === 'warehouse' &&
                    isWarehouseLive &&
                    canAdjustWarehouseRawMaterial &&
                    detailObject?.id === 'warehouse-live-inventory'
                      ? receiveLiveWarehouseRawMaterial
                      : undefined
                  }
                  onCreateBigBag={
                    activeRole === 'warehouse' &&
                    isWarehouseLive &&
                    effectiveCapabilities?.includes('bigbag:create') &&
                    detailObject?.id === 'warehouse-live-inventory'
                      ? createLiveWarehouseBigBag
                      : undefined
                  }
                  actionOutcome={selectedOfficeOutcome}
                  onClose={
                    isSingleObjectDirectDetail || isWarehouseInventoryPage
                      ? undefined
                      : clearActiveSelection
                  }
                  onOpenShift={() => changeSection('Смена')}
                  siblingObjects={projectedWorkObjectsByRole[activeRole] ?? []}
                  onSelectObject={selectObject}
                  activeSection={activeSection}
                  displayTitle={isWarehouseInventoryPage ? activeSection : undefined}
                  warehouseCoverTasks={warehouseCoverTasks}
                  coverageRefreshGeneration={businessRefreshGeneration}
                  warehouseCoverFreeRolls={warehouseCoverFreeRolls}
                  selectedWarehouseObjectId={selectedByRole.warehouse}
                  onWarehouseCoverPropose={proposeWarehouseCover}
                  onWarehouseCoverRefresh={() =>
                    liveRefreshControllerRef.current?.invalidateAndRefresh()
                  }
                  onWarehouseOneCStockPush={
                    activeRole === 'warehouse' && isWarehouseLive && canPushWarehouseOneC
                      ? requestWarehouseOneCStockPush
                      : undefined
                  }
                  warehouseOneCStockPushBusy={warehouseOneCStockPushBusy}
                  warehouseMaterialRecipeCatalog={
                    warehouseMaterialRecipeCatalogEnabled ? materialRecipeCatalog : undefined
                  }
                  effectiveCapabilities={effectiveCapabilities}
                  rawMaterialRefreshGeneration={
                    activeRole === 'director' ? businessRefreshGeneration : 0
                  }
                  rawMaterialHeaderAction={
                    activeRole === 'director' && isDirectorLive ? (
                      <DirectorRefreshButton
                        busy={directorRefreshPending}
                        onRefresh={refreshDirectorTab}
                      />
                    ) : undefined
                  }
                  isFinanceRegistryPage={isFinanceRegistryPage}
                  onFinanceObjectUpdated={replaceFinanceObject}
                  onCorrectFinancePayment={correctLiveFinancePayment}
                  onTemplateSelect={(objectId, templateId) =>
                    setSelectedTemplateByObject((current) => ({
                      ...current,
                      [objectId]: templateId,
                    }))
                  }
                />
              )}
            </section>
          </>
        )}
      </main>
      {isIntakeDrawerOpen && (
        <div
          className="intake-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeIntakeModal();
          }}
        >
          <div
            ref={intakeDialogRef}
            className="intake-modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="intake-modal-title"
            tabIndex={-1}
            onKeyDown={handleIntakeDialogKeyDown}
          >
            <div className="intake-modal-body">
              <IntakeCreateSurface
                value={intakeDraft}
                onChange={updateIntakeDraft}
                onClose={closeIntakeModal}
                onSubmit={submitIntake}
                creatorRole={intakeCreatorRole}
                draftOnly={intakeDraftOnly}
                counterpartyCatalog={
                  intakeCreatorRole === 'production_lead' && isProductionLive
                    ? productionIntakeCounterparties
                    : undefined
                }
                templateCatalog={
                  intakeCreatorRole === 'production_lead' && isProductionLive
                    ? productionIntakeTemplates
                    : templateCatalog
                }
                templateVersions={
                  intakeCreatorRole === 'production_lead' && isProductionLive
                    ? productionIntakeTemplateVersions
                    : templateVersions
                }
                templateDraftPositions={
                  intakeCreatorRole === 'production_lead' && isProductionLive
                    ? productionIntakeDraftPositions
                    : templateDraftPositions
                }
                templateCatalogWarning={
                  intakeCreatorRole === 'production_lead' && isProductionLive
                    ? productionIntakeTemplateWarning
                    : null
                }
                templateCatalogRetrying={productionIntakeTemplateRetrying}
                onRetryTemplateCatalog={() => void retryLiveProductionIntakeTemplates()}
                allowCounterpartyCreate={
                  !(intakeCreatorRole === 'production_lead' && isProductionLive)
                }
                materials={materialRecipeCatalog.materials}
                recipes={materialRecipeCatalog.recipes}
                materialCatalogStatus={materialRecipeCatalog.status}
                materialCatalogError={materialRecipeCatalog.error}
                onRetryMaterialCatalog={() => void materialRecipeCatalog.reload()}
                onCreateRecipe={setIntakeRecipeEditorPositionId}
                effectiveCapabilities={effectiveCapabilities}
                onMaterialSelectionConfirmed={(positionId) =>
                  setIntakeMaterialSelectionInvalidPositionIds((current) => {
                    const next = new Set(current);
                    next.delete(positionId);
                    return next;
                  })
                }
                materialSelectionInvalidPositionIds={intakeMaterialSelectionInvalidPositionIds}
                submitting={intakeSubmitting}
              />
              {intakeRecipeEditorPositionId &&
                effectiveCapabilities?.includes('recipe_catalog:create') && (
                  <RecipeEditorModal
                    materials={materialRecipeCatalog.materials}
                    catalogStatus={materialRecipeCatalog.status}
                    catalogError={materialRecipeCatalog.error}
                    onRetryCatalog={() => void materialRecipeCatalog.reload()}
                    onSave={materialRecipeCatalog.createRecipe}
                    onCreated={selectCreatedRecipeForIntake}
                    onClose={() => setIntakeRecipeEditorPositionId(null)}
                  />
                )}
            </div>
          </div>
        </div>
      )}
      {problemReportContext && (
        <ProblemReportDialog
          context={problemReportContext}
          onCancel={closeProblemReport}
          onSubmit={submitProblemReport}
        />
      )}
      {operatorDefectDialog && (
        <DefectDialog
          rollCode={operatorDefectDialog.rollCode}
          spoolKg={operatorDefectDialog.spoolKg}
          plannedNetKg={operatorDefectDialog.plannedNetKg}
          onCancel={() => setOperatorDefectDialog(null)}
          onSubmit={submitOperatorDefect}
        />
      )}
      {actionConfirmation && (
        <ActionConfirmationDialog
          dialog={actionConfirmation}
          onCancel={() => setActionConfirmation(null)}
        />
      )}
      {openPanel === 'notifications' &&
        (activeRole === 'commercial' && isCommercialLive ? (
          <CommercialControlPanel
            notifications={roleNotifications}
            unreadCount={roleUnreadCount}
            soundEnabled={session.notificationSound}
            hasMore={Boolean(inboxStateByRole.commercial.nextCursor)}
            loadingMore={inboxStateByRole.commercial.loadingMore}
            onLoadMore={() => void loadMoreRoleInbox('commercial')}
            onRead={markNotificationRead}
            onOpen={openLiveNotification}
            onClose={() => setOpenPanel('none')}
          />
        ) : (
          <NotificationCenter
            notifications={roleNotifications}
            unreadCount={roleUnreadCount}
            soundEnabled={session.notificationSound}
            hasMore={isLiveContour(activeRole) && Boolean(inboxStateByRole[activeRole].nextCursor)}
            loadingMore={
              isLiveContour(activeRole) ? inboxStateByRole[activeRole].loadingMore : false
            }
            onLoadMore={
              isLiveContour(activeRole) ? () => void loadMoreRoleInbox(activeRole) : undefined
            }
            onRead={markNotificationRead}
            onOpen={openLiveNotification}
            onAck={acknowledgeNotification}
            onClose={() => setOpenPanel('none')}
          />
        ))}
      {openPanel === 'account' &&
        (activeRole === 'commercial' && isCommercialLive ? (
          <CommercialProfilePanel
            session={session}
            policy={permissionPolicies.commercial}
            onToggleSound={toggleSound}
            onToggleReducedMotion={toggleReducedMotion}
            onLogout={handleLogout}
            onClose={() => setOpenPanel('none')}
          />
        ) : (
          <AccountCabinet
            session={session}
            policy={permissionPolicies[activeRole]}
            onToggleSound={toggleSound}
            onToggleReducedMotion={toggleReducedMotion}
            onLogout={handleLogout}
            onClose={() => setOpenPanel('none')}
          />
        ))}
    </IxApplication>
  );
}

export default App;
