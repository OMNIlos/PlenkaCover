import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { RoleNavigation } from '../../components/shell/appShell';
import type { RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import { isEventFromNestedDialog, trapFocusWithin } from '../../components/shell/focusTrap';
import { applyCreatedRecipeToIntakeDraft } from '../../domain/materialRecipeCatalog';
import type { IntakeDraftForm } from '../../domain/prototypeRuntime';
import {
  applyCommercialMaterialShortageCorrection,
  applyCommercialProblemCorrection,
  amendCommercialOrder,
  approveCommercialWarehouseCover,
  cancelCommercialOrder,
  deleteCommercialOrder,
  fetchCommercialOrderDetail,
  handoffCommercialOrderToFinance,
  handoffCommercialOrderToProduction,
  promoteCommercialDraft,
  requestCommercialWarehouseCover,
  requestCommercialWarehouseCoverRecheck,
  updateCommercialOrderComment,
  updateCommercialPosition,
  updateCommercialFinanceNote,
  type CommercialOrderCommentCommand,
  type CommercialMaterialShortageCorrectionCommand,
  type CommercialProblemCorrectionCommand,
} from './api';
import { ApiError } from '../../api/client';
import { IdempotentOperationGate } from '../../api/idempotentOperation';
import { CommercialCorrectionPanel } from './CommercialCorrectionPanel';
import { CommercialMaterialShortageCorrectionPanel } from './CommercialMaterialShortageCorrectionPanel';
import { CommercialCoverPanel, type CommercialCoverMutationStatus } from './CommercialCoverPanel';
import { CommercialIntakeForm, createEmptyCommercialIntakeDraft } from './CommercialIntakeForm';
import { CommercialOrderDetail } from './CommercialOrderDetail';
import type {
  CommercialPositionCreateCommand,
  CommercialPositionUpdateCommand,
} from './CommercialOrderPositions';
import { CommercialQueue, focusCommercialQueueItem } from './CommercialQueue';
import { BusinessPerformanceWorkspace } from '../business-performance/BusinessPerformanceWorkspace';
import { BusinessProblemsWorkspace } from '../business-performance/BusinessProblemsWorkspace';
import { RecipeEditorModal } from '../recipes/RecipeEditorModal';
import { hasEffectiveCapability } from '../../domain/accessPolicy';
import {
  useMaterialRecipeCatalog,
  type MaterialRecipeCatalog,
} from '../recipes/useMaterialRecipeCatalog';
import type {
  CommercialNextActionCode,
  CommercialOrderSection,
  CommercialQueueModeLabel,
  CommercialRequestType,
  WarehouseCoverRouteContract,
} from './contracts';
import { useCommercialWorkspace } from './useCommercialWorkspace';
import { COMMERCIAL_PERFORMANCE_SECTIONS } from './CommercialPerformanceWorkspace';
import { SharedBigBagRegister } from '../raw-materials/SharedBigBagRegister';

export const COMMERCIAL_LIVE_SECTIONS = [
  'Входящие заявки',
  'Черновики',
  'В работе',
  'Выполненные',
  'Сырьё',
  'Проблемы',
  ...COMMERCIAL_PERFORMANCE_SECTIONS,
] as const;

export type CommercialLiveSection = (typeof COMMERCIAL_LIVE_SECTIONS)[number];
type CommercialOrderLiveSection = Exclude<
  CommercialLiveSection,
  'Сырьё' | 'Проблемы' | (typeof COMMERCIAL_PERFORMANCE_SECTIONS)[number]
>;

export type CommercialMobileSurface = { mode: 'queue' } | { mode: 'detail'; orderId: string };
export type CommercialMobileSurfaceEvent =
  | { type: 'open'; orderId: string }
  | { type: 'back' }
  | { type: 'section_changed' };

export function nextCommercialMobileSurface(
  _current: CommercialMobileSurface,
  event: CommercialMobileSurfaceEvent,
): CommercialMobileSurface {
  return event.type === 'open' ? { mode: 'detail', orderId: event.orderId } : { mode: 'queue' };
}

export function isCommercialLiveSection(value: string): value is CommercialLiveSection {
  return (COMMERCIAL_LIVE_SECTIONS as readonly string[]).includes(value);
}

function isCommercialPerformanceSection(
  value: CommercialLiveSection,
): value is (typeof COMMERCIAL_PERFORMANCE_SECTIONS)[number] {
  return (COMMERCIAL_PERFORMANCE_SECTIONS as readonly string[]).includes(value);
}

export function isCommercialOrderLiveSection(
  value: CommercialLiveSection,
): value is CommercialOrderLiveSection {
  return !isCommercialPerformanceSection(value) && value !== 'Сырьё' && value !== 'Проблемы';
}

export function commercialSectionForBucket(
  bucket: 'incoming' | 'drafts' | 'in_work' | 'completed',
): CommercialOrderSection {
  const sections: Record<typeof bucket, CommercialOrderSection> = {
    incoming: 'Входящие заявки',
    drafts: 'Черновики',
    in_work: 'В работе',
    completed: 'Выполненные',
  };
  return sections[bucket];
}

export function acquireCommercialMutationLock(lock: { current: boolean }) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function shouldSyncCommercialExternalSelection(
  externalId: string | null,
  internalId: string | null,
  items: ReadonlyArray<{ id: string }>,
  externalSelectionChanged: boolean,
) {
  if (internalId === externalId) return false;
  return (
    externalSelectionChanged ||
    externalId === null ||
    items.some((item) => item.id === externalId)
  );
}

export function shouldReconcileCommercialExternalSelection(
  externalId: string | null,
  internalId: string | null,
  items: ReadonlyArray<{ id: string }>,
  externalSelectionChanged: boolean,
) {
  return (
    !externalSelectionChanged &&
    externalId !== null &&
    internalId !== externalId &&
    !items.some((item) => item.id === externalId)
  );
}

type QueueFilters = {
  mode: CommercialQueueModeLabel;
  from: string;
  to: string;
};

type MutationState = {
  kind: string | null;
  targetId: string | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  error: string | null;
};

const INITIAL_MUTATION: MutationState = {
  kind: null,
  targetId: null,
  status: 'idle',
  error: null,
};

const INITIAL_FILTERS: QueueFilters = { mode: 'Текущие', from: '', to: '' };
const COMMERCIAL_PARAMETERS_LOCKED_AFTER_INVOICE =
  'COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие.';
}

export function isCommercialInvoiceBoundaryConflict(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === COMMERCIAL_PARAMETERS_LOCKED_AFTER_INVOICE
  );
}

function focusActionPanel(id: string) {
  window.requestAnimationFrame(() => document.getElementById(id)?.focus());
}

function CommercialIntakeDialog({
  value,
  requestType,
  dialogRef,
  onChange,
  onClose,
  onCreated,
  materialCatalog,
  recipeEditorPositionId,
  onOpenRecipeEditor,
  onCloseRecipeEditor,
  onRecipeCreated,
  effectiveCapabilities,
}: {
  value: IntakeDraftForm;
  requestType: CommercialRequestType;
  dialogRef: React.RefObject<HTMLDivElement>;
  onChange: (value: IntakeDraftForm) => void;
  onClose: () => void;
  onCreated: (order: { id: string }, mode: 'draft' | 'submit') => void;
  materialCatalog: MaterialRecipeCatalog;
  recipeEditorPositionId: string | null;
  onOpenRecipeEditor: (positionId: string) => void;
  onCloseRecipeEditor: () => void;
  onRecipeCreated: (recipe: RecipeCatalogItem) => void;
  effectiveCapabilities?: readonly string[];
}) {
  const canCreateRecipe = hasEffectiveCapability(effectiveCapabilities, 'recipe_catalog:create');
  const submittingRef = useRef(false);
  const requestClose = () => {
    if (!submittingRef.current) onClose();
  };
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="intake-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="intake-modal-dialog commercial-live-intake-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="intake-modal-title"
        tabIndex={-1}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (
            event.defaultPrevented ||
            isEventFromNestedDialog(event.currentTarget, event.target)
          ) {
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            requestClose();
            return;
          }
          trapFocusWithin(event);
        }}
      >
        <CommercialIntakeForm
          value={value}
          requestType={requestType}
          onChange={onChange}
          onClose={requestClose}
          onSubmittingChange={(submitting) => {
            submittingRef.current = submitting;
          }}
          onCreated={onCreated}
          materials={materialCatalog.materials}
          recipes={materialCatalog.recipes}
          materialCatalogStatus={materialCatalog.status}
          materialCatalogError={materialCatalog.error}
          onReloadMaterialCatalog={materialCatalog.reload}
          onCreateRecipe={onOpenRecipeEditor}
          effectiveCapabilities={effectiveCapabilities}
        />
        {recipeEditorPositionId && canCreateRecipe && (
          <RecipeEditorModal
            materials={materialCatalog.materials}
            catalogStatus={materialCatalog.status}
            catalogError={materialCatalog.error}
            onRetryCatalog={() => void materialCatalog.reload()}
            onSave={materialCatalog.createRecipe}
            onCreated={onRecipeCreated}
            onClose={onCloseRecipeEditor}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

export function CommercialWorkspace({
  activeSection,
  selectedOrderId,
  selectedProblemId,
  refreshGeneration,
  onChangeSection,
  onSelectOrder,
  onReconcileSelection,
  onMutationSuccess,
  effectiveCapabilities,
}: {
  activeSection: CommercialLiveSection;
  selectedOrderId: string | null;
  selectedProblemId?: string | null;
  refreshGeneration?: number;
  onChangeSection: (section: CommercialLiveSection) => void;
  onSelectOrder: (orderId: string, section?: CommercialOrderSection) => void;
  onReconcileSelection?: (orderId: string | null) => void;
  onMutationSuccess?: () => void;
  effectiveCapabilities?: readonly string[];
}) {
  const orderSection: CommercialOrderSection = isCommercialOrderLiveSection(activeSection)
    ? activeSection
    : 'В работе';
  const [filtersBySection, setFiltersBySection] = useState<
    Record<CommercialOrderSection, QueueFilters>
  >({
    'Входящие заявки': { ...INITIAL_FILTERS },
    Черновики: { ...INITIAL_FILTERS },
    'В работе': { ...INITIAL_FILTERS },
    Выполненные: { ...INITIAL_FILTERS },
  });
  const filters = filtersBySection[orderSection];
  const liveRefreshReady = refreshGeneration === undefined || refreshGeneration > 0;
  const workspace = useCommercialWorkspace({
    section: orderSection,
    mode: filters.mode,
    from: filters.from || undefined,
    to: filters.to || undefined,
    limit: 20,
    enabled: isCommercialOrderLiveSection(activeSection) && liveRefreshReady,
    refreshGeneration: refreshGeneration ?? 0,
  });
  const [mutation, setMutation] = useState<MutationState>(INITIAL_MUTATION);
  const mutationLock = useRef(false);
  const actionOperationGateRef = useRef(new IdempotentOperationGate());
  const lastExternalSelection = useRef<string | null | undefined>(undefined);
  const pendingQueueSelection = useRef<string | undefined>(undefined);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeRequestType, setIntakeRequestType] = useState<CommercialRequestType>('client_order');
  const [intakeDraft, setIntakeDraft] = useState<IntakeDraftForm>(createEmptyCommercialIntakeDraft);
  const [recipeEditorPositionId, setRecipeEditorPositionId] = useState<string | null>(null);
  const materialCatalog = useMaterialRecipeCatalog(
    intakeOpen ||
      Boolean(workspace.detail && workspace.detail.cancellation?.status !== 'cancelled'),
  );
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const intakeDialogRef = useRef<HTMLDivElement>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigationGeneration = useRef(0);
  const [materialShortageCorrectionTarget, setMaterialShortageCorrectionTarget] = useState<{
    orderId: string;
    problemId: string;
  } | null>(null);
  const [mobileSurface, dispatchMobileSurface] = useReducer(nextCommercialMobileSurface, {
    mode: 'queue',
  });
  const externalSelectionChanged = lastExternalSelection.current !== selectedOrderId;

  useEffect(() => {
    setNavigationError(null);
  }, [activeSection]);

  useEffect(() => {
    if (
      materialShortageCorrectionTarget &&
      selectedOrderId !== materialShortageCorrectionTarget.orderId
    ) {
      setMaterialShortageCorrectionTarget(null);
    }
  }, [materialShortageCorrectionTarget, selectedOrderId]);

  useEffect(() => {
    if (!isCommercialOrderLiveSection(activeSection)) return;
    lastExternalSelection.current = selectedOrderId;
    if (pendingQueueSelection.current === selectedOrderId) {
      pendingQueueSelection.current = undefined;
      return;
    }
    if (
      shouldSyncCommercialExternalSelection(
        selectedOrderId,
        workspace.selectedId,
        workspace.items,
        externalSelectionChanged,
      )
    ) {
      workspace.selectExternal(selectedOrderId);
    }
  }, [
    activeSection,
    externalSelectionChanged,
    selectedOrderId,
    workspace.items,
    workspace.selectedId,
  ]);

  useEffect(() => {
    if (
      !isCommercialOrderLiveSection(activeSection) ||
      workspace.status !== 'ready' ||
      !shouldReconcileCommercialExternalSelection(
        selectedOrderId,
        workspace.selectedId,
        workspace.items,
        externalSelectionChanged,
      )
    )
      return;
    onReconcileSelection?.(workspace.selectedId);
  }, [
    activeSection,
    externalSelectionChanged,
    onReconcileSelection,
    selectedOrderId,
    workspace.items,
    workspace.selectedId,
    workspace.status,
  ]);

  useEffect(() => {
    if (!intakeOpen) return;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    shell?.setAttribute('inert', '');
    shell?.setAttribute('aria-hidden', 'true');
    const frame = window.requestAnimationFrame(() => intakeDialogRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      shell?.removeAttribute('inert');
      shell?.removeAttribute('aria-hidden');
    };
  }, [intakeOpen]);

  useEffect(() => {
    if (mobileSurface.mode !== 'detail' || !workspace.detail) return;
    const frame = window.requestAnimationFrame(() =>
      document.getElementById('commercial-order-detail-heading')?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [mobileSurface.mode, workspace.detail?.id]);

  useEffect(() => {
    const target = materialShortageCorrectionTarget;
    const detail = workspace.detail;
    if (!target || detail?.id !== target.orderId) return;
    const problem = detail.productionProblems.find(
      (item) => item.id === target.problemId && item.type === 'raw_material_shortage',
    );
    if (!problem || problem.status !== 'open') return;
    const frame = window.requestAnimationFrame(() => {
      const panel = document.getElementById('commercial-correction-actions');
      panel?.scrollIntoView({ block: 'start' });
      panel?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [materialShortageCorrectionTarget, workspace.detail]);

  const closeIntake = () => {
    setRecipeEditorPositionId(null);
    setIntakeOpen(false);
    window.requestAnimationFrame(() => createTriggerRef.current?.focus());
  };
  const openIntake = (requestType: CommercialRequestType) => {
    setIntakeRequestType(requestType);
    setIntakeDraft(createEmptyCommercialIntakeDraft());
    setIntakeOpen(true);
  };

  const runMutation = async (
    kind: string,
    targetId: string,
    operation: () => Promise<unknown>,
    reconcile = workspace.retry,
  ) => {
    if (!acquireCommercialMutationLock(mutationLock)) return false;
    setMutation({ kind, targetId, status: 'loading', error: null });
    try {
      await operation();
      setMutation({ kind, targetId, status: 'success', error: null });
      reconcile();
      onMutationSuccess?.();
      return true;
    } catch (mutationError) {
      if (isCommercialInvoiceBoundaryConflict(mutationError)) {
        setMutation(INITIAL_MUTATION);
        workspace.retry();
        return false;
      }
      setMutation({
        kind,
        targetId,
        status: 'error',
        error: errorMessage(mutationError),
      });
      return false;
    } finally {
      mutationLock.current = false;
    }
  };

  const runIdempotentMutation = async (
    kind: string,
    targetId: string,
    intent: string,
    operation: (operationKey: string) => Promise<unknown>,
  ) => {
    if (!acquireCommercialMutationLock(mutationLock)) return false;
    setMutation({ kind, targetId, status: 'loading', error: null });
    const request = actionOperationGateRef.current.start(intent, operation);
    if (!request) {
      mutationLock.current = false;
      return false;
    }
    try {
      await request;
      setMutation({ kind, targetId, status: 'success', error: null });
      workspace.retry();
      onMutationSuccess?.();
      return true;
    } catch (mutationError) {
      if (isCommercialInvoiceBoundaryConflict(mutationError)) {
        setMutation(INITIAL_MUTATION);
        workspace.retry();
        return false;
      }
      setMutation({
        kind,
        targetId,
        status: 'error',
        error: errorMessage(mutationError),
      });
      return false;
    } finally {
      mutationLock.current = false;
    }
  };

  const handlePrimaryAction = (code: CommercialNextActionCode) => {
    const detail = workspace.detail;
    if (!detail || mutation.status === 'loading') return;
    if (code === 'delete_order') {
      if (
        globalThis.confirm(
          `Заказ ${detail.orderNumber} будет удалён у всех без возможности восстановления. Продолжить?`,
        )
      ) {
        void handleOrderDeletion();
      }
      return;
    }
    if (code === 'correct_order_spec') {
      focusActionPanel('commercial-order-positions');
      return;
    }
    if (code === 'review_cover') {
      focusActionPanel('commercial-cover-actions');
      return;
    }
    if (code === 'resolve_problem') {
      focusActionPanel('commercial-correction-actions');
      return;
    }
    const operations: Partial<Record<CommercialNextActionCode, () => Promise<unknown>>> = {
      promote_draft: () => promoteCommercialDraft(detail.id),
      request_cover: () => requestCommercialWarehouseCover(detail.id),
      submit_to_finance: () => handoffCommercialOrderToFinance(detail.id),
      send_to_production: () => handoffCommercialOrderToProduction(detail.id),
    };
    const operation = operations[code];
    if (operation) void runMutation(code, detail.id, operation);
  };

  const handlePositionUpdate = (positionId: string, command: CommercialPositionUpdateCommand) => {
    const detail = workspace.detail;
    if (!detail) return Promise.resolve(false);
    return runMutation('position_update', positionId, () =>
      updateCommercialPosition(detail.id, positionId, command),
    );
  };

  const handlePositionAmend = (
    positionId: string,
    command: CommercialPositionUpdateCommand,
    reason: string,
  ) => {
    const detail = workspace.detail;
    if (!detail) return Promise.resolve(false);
    const { expectedVersion, ...changes } = command;
    return runIdempotentMutation(
      'position_amendment',
      positionId,
      `commercial:position-amendment:${detail.id}:${positionId}`,
      (operationKey) =>
        amendCommercialOrder(detail.id, {
          kind: 'update_position',
          operationKey,
          expectedOrderVersion: detail.version,
          reason,
          positionId,
          expectedPositionVersion: expectedVersion,
          changes,
        }),
    );
  };

  const handlePositionAdd = (position: CommercialPositionCreateCommand, reason: string) => {
    const detail = workspace.detail;
    if (!detail) return Promise.resolve(false);
    return runIdempotentMutation(
      'position_addition',
      detail.id,
      `commercial:position-addition:${detail.id}:${detail.version}`,
      (operationKey) =>
        amendCommercialOrder(detail.id, {
          kind: 'add_position',
          operationKey,
          expectedOrderVersion: detail.version,
          reason,
          position,
        }),
    );
  };

  const handleOrderDeletion = async () => {
    const detail = workspace.detail;
    if (!detail) return Promise.resolve(false);
    const deleted = await runMutation(
      'order_deletion',
      detail.id,
      () => deleteCommercialOrder(detail.id),
      () => workspace.remove(detail.id),
    );
    if (deleted) {
      setMutation(INITIAL_MUTATION);
    }
    return deleted;
  };

  const handleOrderCancellation = (reason: string) => {
    const detail = workspace.detail;
    if (!detail) return Promise.resolve(false);
    return runIdempotentMutation(
      'order_cancellation',
      detail.id,
      `commercial:order-cancellation:${detail.id}:${detail.version}`,
      (operationKey) =>
        cancelCommercialOrder(detail.id, {
          operationKey,
          expectedVersion: detail.version,
          reason,
        }),
    );
  };

  const handleFinanceNoteUpdate = (commercialFinanceNote: string | null) => {
    const detail = workspace.detail;
    if (!detail) return Promise.resolve(false);
    return runMutation('finance_note', detail.id, () =>
      updateCommercialFinanceNote(detail.id, {
        commercialFinanceNote,
        expectedVersion: detail.version,
        operationKey: crypto.randomUUID(),
      }),
    );
  };

  const handleCommentUpdate = (command: CommercialOrderCommentCommand) => {
    const detail = workspace.detail;
    if (!detail) return Promise.resolve(false);
    return runMutation('order_comment', detail.id, async () => {
      const comment = await updateCommercialOrderComment(detail.id, command);
      workspace.reconcileComment(detail.id, comment);
    });
  };

  const openMaterialShortageCorrection = async (target: { orderId: string; problemId: string }) => {
    const requestGeneration = ++navigationGeneration.current;
    setNavigationError(null);
    try {
      const detail = await fetchCommercialOrderDetail(target.orderId);
      if (navigationGeneration.current !== requestGeneration) return;
      const problem = detail.productionProblems.find(
        (item) =>
          item.id === target.problemId &&
          item.type === 'raw_material_shortage' &&
          item.status === 'open' &&
          item.ownerRole === 'commercial',
      );
      if (detail.id !== target.orderId || !problem) {
        throw new Error('Выбранная нехватка сырья больше недоступна.');
      }
      const section = commercialSectionForBucket(detail.bucket);
      setMaterialShortageCorrectionTarget(target);
      onChangeSection(section);
      onSelectOrder(target.orderId, section);
    } catch (loadError) {
      if (navigationGeneration.current !== requestGeneration) return;
      setNavigationError(errorMessage(loadError));
    }
  };

  const canCreate = activeSection === 'Входящие заявки' || activeSection === 'Черновики';
  const coverMutationStatus = (proposalId: string): CommercialCoverMutationStatus => {
    if (mutation.targetId !== proposalId || !mutation.kind?.startsWith('cover')) return 'idle';
    return mutation.status === 'loading' ? 'submitting' : mutation.status;
  };
  const primaryMutationFeedback =
    mutation.kind &&
    !mutation.kind.startsWith('cover') &&
    mutation.kind !== 'correction' &&
    mutation.status !== 'idle'
      ? {
          status: mutation.status,
          message:
            mutation.status === 'loading'
              ? mutation.kind === 'order_deletion'
                ? 'Удаляем…'
                : 'Действие выполняется…'
              : mutation.status === 'success'
                ? 'Действие выполнено.'
                : mutation.error || 'Не удалось выполнить действие.',
        }
      : undefined;

  return (
    <>
      <RoleNavigation
        role="commercial"
        activeSection={activeSection}
        sections={COMMERCIAL_LIVE_SECTIONS}
        hideCounts
        onChangeSection={(section) => {
          if (!isCommercialLiveSection(section)) return;
          setNavigationError(null);
          dispatchMobileSurface({ type: 'section_changed' });
          onChangeSection(section);
        }}
      />

      {isCommercialPerformanceSection(activeSection) ? (
        <BusinessPerformanceWorkspace
          section={activeSection}
          refreshGeneration={refreshGeneration}
        />
      ) : activeSection === 'Проблемы' ? (
        <>
          {navigationError ? <p role="alert">{navigationError}</p> : null}
          <BusinessProblemsWorkspace
            refreshGeneration={refreshGeneration}
            selectedProblemId={selectedProblemId}
            onOpenMaterialShortageCorrection={(target) =>
              void openMaterialShortageCorrection(target)
            }
          />
        </>
      ) : activeSection === 'Сырьё' ? (
        <section className="commercial-live-raw-shell" aria-live="polite">
          {navigationError && <p role="alert">{navigationError}</p>}
          <SharedBigBagRegister />
        </section>
      ) : (
        <>
          <section
            className="list-panel commercial-live-list-panel"
            aria-label="Коммерческие заявки"
            data-mobile-active={mobileSurface.mode === 'queue'}
          >
            <header className="panel-header">
              <div>
                <span className="eyebrow">Коммерция · live</span>
                <h1>{activeSection}</h1>
              </div>
              {canCreate && (
                <div className="commercial-live-create-actions">
                  <button
                    ref={createTriggerRef}
                    className="create-intake-button commercial-live-primary-action"
                    type="button"
                    onClick={() => openIntake('client_order')}
                  >
                    Создать заявку
                  </button>
                  <button
                    className="create-intake-button commercial-live-stock-action"
                    type="button"
                    onClick={() => openIntake('stock_reserve')}
                  >
                    Произвести на запас
                  </button>
                </div>
              )}
            </header>
            <CommercialQueue
              items={workspace.items}
              selectedId={workspace.selectedId}
              status={workspace.status}
              stale={workspace.stale}
              error={workspace.error}
              hasMore={Boolean(workspace.nextCursor)}
              onSelect={(id) => {
                pendingQueueSelection.current = id;
                workspace.select(id);
                dispatchMobileSurface({ type: 'open', orderId: id });
                onSelectOrder(id, orderSection);
              }}
              onRetry={workspace.retry}
              onLoadMore={workspace.loadMore}
              filters={filters}
              onFiltersChange={(next) =>
                setFiltersBySection((current) => ({
                  ...current,
                  [orderSection]: next,
                }))
              }
              onResetFilters={() =>
                setFiltersBySection((current) => ({
                  ...current,
                  [orderSection]: { ...INITIAL_FILTERS },
                }))
              }
            />
          </section>

          <section
            className="detail-panel commercial-live-detail-panel"
            aria-live="polite"
            data-mobile-active={mobileSurface.mode === 'detail'}
          >
            <button
              type="button"
              className="commercial-mobile-back"
              onClick={() => {
                dispatchMobileSurface({ type: 'back' });
                if (workspace.selectedId) focusCommercialQueueItem(workspace.selectedId);
              }}
            >
              К очереди
            </button>
            <CommercialOrderDetail
              detail={workspace.detail}
              status={workspace.detailStatus}
              error={workspace.detailError}
              onRetry={workspace.retry}
              onAction={(action) => handlePrimaryAction(action.code)}
              onCommentUpdate={handleCommentUpdate}
              onPositionUpdate={handlePositionUpdate}
              onPositionAmend={handlePositionAmend}
              onPositionAdd={handlePositionAdd}
              onFinanceNoteUpdate={handleFinanceNoteUpdate}
              onCancel={handleOrderCancellation}
              onDelete={handleOrderDeletion}
              materials={materialCatalog.materials}
              recipes={materialCatalog.recipes}
              mutationFeedback={primaryMutationFeedback}
            />

            {workspace.detail && (
              <div className="commercial-live-decision-stack">
                <section id="commercial-cover-actions" tabIndex={-1}>
                  {workspace.detail.positions.flatMap((position) =>
                    position.coverProposals.map((proposal) => (
                      <CommercialCoverPanel
                        key={proposal.id}
                        position={position}
                        proposal={proposal}
                        status={coverMutationStatus(proposal.id)}
                        error={mutation.targetId === proposal.id ? mutation.error : null}
                        onApprove={(route: WarehouseCoverRouteContract) =>
                          void runMutation('cover-approval', proposal.id, () =>
                            approveCommercialWarehouseCover(
                              workspace.detail!.id,
                              position.id,
                              proposal.id,
                              { expectedVersion: proposal.version, route },
                            ),
                          )
                        }
                        onRecheck={(reason) =>
                          void runMutation('cover-recheck', proposal.id, () =>
                            requestCommercialWarehouseCoverRecheck(
                              workspace.detail!.id,
                              position.id,
                              proposal.id,
                              { expectedVersion: proposal.version, reason },
                            ),
                          )
                        }
                        onRetry={() => {
                          setMutation(INITIAL_MUTATION);
                          workspace.retry();
                        }}
                      />
                    )),
                  )}
                </section>

                <section id="commercial-correction-actions" tabIndex={-1}>
                  <CommercialCorrectionPanel
                    problems={workspace.detail.productionProblems}
                    selectedProblemId={materialShortageCorrectionTarget?.problemId}
                    status={mutation.kind === 'correction' ? mutation.status : 'idle'}
                    error={mutation.kind === 'correction' ? mutation.error : null}
                    onSubmit={(problemId: string, command: CommercialProblemCorrectionCommand) => {
                      void runMutation('correction', problemId, () =>
                        applyCommercialProblemCorrection(workspace.detail!.id, problemId, command),
                      );
                    }}
                    onRetry={() => {
                      setMutation(INITIAL_MUTATION);
                      workspace.retry();
                    }}
                  />
                  <CommercialMaterialShortageCorrectionPanel
                    problems={workspace.detail.productionProblems}
                    selectedProblemId={materialShortageCorrectionTarget?.problemId}
                    materials={materialCatalog.materials}
                    status={
                      mutation.kind === 'material_shortage_correction' ? mutation.status : 'idle'
                    }
                    error={mutation.kind === 'material_shortage_correction' ? mutation.error : null}
                    onSubmit={(command: CommercialMaterialShortageCorrectionCommand) => {
                      void runMutation('material_shortage_correction', command.problemId, () =>
                        applyCommercialMaterialShortageCorrection(workspace.detail!.id, command),
                      );
                    }}
                    onRetry={() => {
                      setMutation(INITIAL_MUTATION);
                      workspace.retry();
                    }}
                  />
                </section>
              </div>
            )}
          </section>
        </>
      )}

      {intakeOpen && (
        <CommercialIntakeDialog
          value={intakeDraft}
          requestType={intakeRequestType}
          dialogRef={intakeDialogRef}
          onChange={setIntakeDraft}
          onClose={closeIntake}
          onCreated={(order, mode) => {
            const section: CommercialOrderSection =
              mode === 'draft'
                ? 'Черновики'
                : intakeRequestType === 'stock_reserve'
                  ? 'В работе'
                  : 'Входящие заявки';
            closeIntake();
            setIntakeDraft(createEmptyCommercialIntakeDraft());
            onChangeSection(section);
            onSelectOrder(order.id, section);
            dispatchMobileSurface({ type: 'open', orderId: order.id });
            workspace.retry();
          }}
          materialCatalog={materialCatalog}
          recipeEditorPositionId={recipeEditorPositionId}
          onOpenRecipeEditor={setRecipeEditorPositionId}
          onCloseRecipeEditor={() => setRecipeEditorPositionId(null)}
          onRecipeCreated={(recipe) => {
            if (!recipeEditorPositionId) return;
            setIntakeDraft((current) =>
              applyCreatedRecipeToIntakeDraft(
                current,
                recipeEditorPositionId,
                recipe,
                materialCatalog.materials,
                materialCatalog.recipes,
              ),
            );
          }}
          effectiveCapabilities={effectiveCapabilities}
        />
      )}
    </>
  );
}
