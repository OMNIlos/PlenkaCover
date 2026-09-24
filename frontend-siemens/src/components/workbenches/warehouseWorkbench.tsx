import { useEffect, useRef, useState } from 'react';

import { IdempotentOperationGate } from '../../api/idempotentOperation';
import { isLiveContour } from '../../api/liveContours';
import { warehouseCoverageApi } from '../../api/warehouse';
import type {
  WarehouseCoverageDecisionTaskRowView,
  WarehouseCoverageDecisionTaskView,
} from '../../domain/warehouseCoverage';
import type { ActionDescriptor, WarehouseWorkbench, WorkObject } from '../../domain/types';
import { qrDisplayLabel } from '../../domain/qrDisplay';
import { actionGroups } from '../../domain/selectors';
import { actionDisplayLabel, actionIcon } from '../shell/actionPresentation';
import { visibleAuditActionLabel } from '../../domain/displayContracts';
import { StepIllustration, factHelpText } from '../shell/viewPrimitives';
import type { IllustrationKind } from '../shell/viewPrimitives';
import {
  PlenkiModal,
  TablePager,
  useResponsiveTablePageSize,
  useTablePagination,
} from '../plenki-ui/PlenkiPrimitives';
import { PalletLabelPanel } from './PalletLabelPanel';
import { WarehouseActivePalletPanel } from './WarehouseActivePalletPanel';
import { WarehousePalletSelectionButton } from './WarehousePalletSelectionButton';
import {
  warehouseRollCharacteristicsLabel,
  warehouseRollDimensionsLabel,
  warehouseRollPackagingLabel,
  warehouseRollProductionLabel,
  warehouseRollWeightLabel,
} from './warehouseRollPresentation';

function warehouseIllustrationKind(workbench: WarehouseWorkbench): IllustrationKind {
  if (workbench.scanSeverity === 'critical') return 'stop';
  if (workbench.mode === 'delivery') return 'handover';
  return 'qr';
}

function warehouseRollSeverity(
  workbench: WarehouseWorkbench,
  roll: NonNullable<WarehouseWorkbench['expectedRolls']>[number],
): WorkObject['severity'] {
  const status = roll.status.toLowerCase();
  if (workbench.excess.includes(roll.id) || status.includes('чуж') || status.includes('дублик'))
    return 'critical';
  if (
    workbench.missing.includes(roll.id) ||
    status.includes('не найден') ||
    status.includes('ждет')
  )
    return 'warning';
  return 'info';
}

function warehouseRollQrLabel(roll: NonNullable<WarehouseWorkbench['expectedRolls']>[number]) {
  return qrDisplayLabel(roll.qrCode) ?? `QR-${roll.id}`;
}

function warehouseRollNeedsReturn(
  workbench: WarehouseWorkbench,
  roll: NonNullable<WarehouseWorkbench['expectedRolls']>[number],
) {
  const status = roll.status.toLowerCase();
  return (
    workbench.excess.includes(roll.id) ||
    status.includes('чуж') ||
    status.includes('дублик') ||
    status.includes('не найден')
  );
}

function warehouseRollIsProductionPending(
  roll: NonNullable<WarehouseWorkbench['expectedRolls']>[number],
) {
  return roll.source === 'production_pending';
}

function warehouseRollIsScannableNow(
  roll: NonNullable<WarehouseWorkbench['expectedRolls']>[number],
) {
  return !warehouseRollIsProductionPending(roll);
}

function warehouseRollSourceLabel(roll: NonNullable<WarehouseWorkbench['expectedRolls']>[number]) {
  if (roll.ownership === 'free_reserve' && roll.source === 'warehouse_reserve')
    return 'Свободный резерв';
  if (roll.source === 'warehouse_reserve') return 'Со склада';
  if (roll.source === 'production_handover') return 'Из производства';
  if (roll.source === 'production_pending') return 'Ждем производство';
  return 'К приемке';
}

function warehouseRollSourceDetail(roll: NonNullable<WarehouseWorkbench['expectedRolls']>[number]) {
  if (warehouseRollIsProductionPending(roll)) {
    const assignment = [roll.operatorLabel, roll.machineLabel].filter(Boolean).join(' · ');
    return (
      [assignment, roll.productionStatus, roll.expectedAt ? `до ${roll.expectedAt}` : undefined]
        .filter(Boolean)
        .join(' · ') || 'назначение не указано'
    );
  }
  if (roll.ownership === 'free_reserve' && roll.source === 'warehouse_reserve')
    return 'без заказчика';
  if (roll.source === 'warehouse_reserve') return 'резерв под заказ';
  if (roll.source === 'production_handover') return 'передан оператором';
  return roll.palletId ?? 'ожидаемый QR';
}

function warehouseRollIds(rolls: Array<NonNullable<WarehouseWorkbench['expectedRolls']>[number]>) {
  return (
    rolls
      .slice(0, 4)
      .map((roll) => roll.id)
      .join(', ') || 'нет'
  );
}

function isWarehouseScanAction(action: ActionDescriptor) {
  const label = action.label.toLowerCase();
  const id = action.id.toLowerCase();
  return id.includes('scan') || label.includes('сканировать') || label.includes('qr');
}

function isDuplicateScanAction(action: ActionDescriptor) {
  const normalized = `${action.id} ${action.label}`.toLowerCase();
  return normalized.includes('scan_duplicate') || normalized.includes('повторный qr');
}

function isManualLookupAction(action: ActionDescriptor) {
  const normalized = `${action.id} ${action.label}`.toLowerCase();
  return action.id.startsWith('manual') || normalized.includes('найти вручную');
}

function isWarehouseHistoryAction(action: ActionDescriptor) {
  const normalized = `${action.id} ${action.label}`.toLowerCase();
  return normalized.includes('history') || normalized.includes('истори');
}

function isLegacyPalletPrintAction(action: ActionDescriptor) {
  return action.id.toLowerCase().startsWith('warehouse-print-pallet-list');
}

function isCurrentPalletAction(action: ActionDescriptor) {
  return action.id.toLowerCase().startsWith('warehouse-close-and-print-pallet:');
}

function isWarehouseCloseAction(action: ActionDescriptor) {
  const id = action.id.toLowerCase();
  const label = action.label.toLowerCase();
  return (
    id.includes('warehouse.delivery.close') ||
    label.includes('закрыть приемку') ||
    label.includes('закрыть выдачу')
  );
}

function scannedRollFromWorkbench(workbench: WarehouseWorkbench) {
  return workbench.expectedRolls?.find(
    (roll) =>
      workbench.lastScan.includes(roll.id) ||
      workbench.lastScan.includes(warehouseRollQrLabel(roll)) ||
      Boolean(workbench.scanResult?.includes(roll.id)),
  );
}

type WarehouseSelectedOperation = {
  id: string;
  title: string;
  status: string;
  mode: string;
  counter: string;
};

type CoveragePhysicalDraft = {
  scanRowId: string;
  kind: 'missing' | 'damaged';
  reason: string;
};

const WAREHOUSE_TASK_ACTION_PREFIXES = [
  'warehouse.scan:',
  'warehouse.close:',
  'warehouse-close-and-print-pallet:',
  'warehouse-create-pallet-list:',
  'warehouse-intake-closed:',
] as const;

export function warehouseCoverageDecisionTaskId(actions: ActionDescriptor[]): string | null {
  for (const prefix of WAREHOUSE_TASK_ACTION_PREFIXES) {
    const action = actions.find((candidate) => candidate.id.startsWith(prefix));
    const taskId = action?.id.slice(prefix.length).trim();
    if (taskId) return taskId;
  }
  return null;
}

export function WarehouseWorkbenchView({
  workbench,
  actions,
  selectedOperation,
  showScanAction = true,
  showReturnAction = true,
  history = [],
  onClose,
  onAction,
  onManualLookup,
  onWarehouseRefresh,
  coverageDecisionTask,
  coverageDecisionTaskId,
  liveCoverageEnabled = isLiveContour('warehouse'),
}: {
  workbench: WarehouseWorkbench;
  actions: ActionDescriptor[];
  selectedOperation?: WarehouseSelectedOperation;
  showScanAction?: boolean;
  showReturnAction?: boolean;
  history?: WorkObject['audit'];
  onClose?: () => void;
  onAction?: (actionId: string) => void;
  onManualLookup?: (objectId: string, payload: string) => void;
  onWarehouseRefresh?: () => void;
  coverageDecisionTask?: WarehouseCoverageDecisionTaskView | null;
  coverageDecisionTaskId?: string | null;
  liveCoverageEnabled?: boolean;
}) {
  const [rollPage, setRollPage] = useState(1);
  const [manualLookupOpen, setManualLookupOpen] = useState(false);
  const [manualLookupPayload, setManualLookupPayload] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openPalletDocumentId, setOpenPalletDocumentId] = useState<string | null>(null);
  const [loadedCoverageTask, setLoadedCoverageTask] = useState<{
    targetTaskId: string;
    task: WarehouseCoverageDecisionTaskView;
  } | null>(() =>
    coverageDecisionTask
      ? { targetTaskId: coverageDecisionTask.taskId, task: coverageDecisionTask }
      : null,
  );
  const [physicalDraft, setPhysicalDraft] = useState<CoveragePhysicalDraft | null>(null);
  const [physicalFeedback, setPhysicalFeedback] = useState<{
    status: 'idle' | 'submitting' | 'success' | 'error';
    message: string;
  }>({ status: 'idle', message: '' });
  const [reportedCoverageTaskId, setReportedCoverageTaskId] = useState<string | null>(null);
  const physicalOperationGateRef = useRef(new IdempotentOperationGate());
  const targetObjectId = selectedOperation?.id ?? '';
  const actionCoverageTaskId = warehouseCoverageDecisionTaskId(actions);
  const coverageTaskTargetId =
    coverageDecisionTask?.taskId ?? coverageDecisionTaskId ?? actionCoverageTaskId;
  const activeCoverageTask =
    reportedCoverageTaskId === coverageTaskTargetId
      ? null
      : coverageDecisionTask !== undefined
        ? coverageDecisionTask
        : loadedCoverageTask?.targetTaskId === coverageTaskTargetId
          ? loadedCoverageTask.task
          : null;
  const hasBlockingContext = Boolean(workbench.blockingReason || workbench.recovery);
  const groups = actionGroups(actions);
  const currentUsesDisabled = groups.primary.length === 0 && groups.peer.length === 0;
  const currentActions =
    groups.primary.length > 0 || groups.peer.length > 0
      ? [...groups.primary, ...groups.peer]
      : groups.disabled.slice(0, 1);
  const secondaryActions = [
    ...groups.secondary,
    ...groups.destructive,
    ...(currentUsesDisabled ? groups.disabled.slice(1) : groups.disabled),
  ];
  const meaningfulScanResult = Boolean(
    workbench.scanResult &&
    !workbench.scanResult.startsWith('Готово') &&
    !workbench.scanResult.startsWith('Все ожидаемые'),
  );
  const compactEvidence = (workbench.evidence ?? []).filter((fact) =>
    ['Big-bag', 'Отклонение', 'Ожидаемый остаток'].includes(fact.label),
  );
  const extraEvidence = (workbench.evidence ?? []).filter(
    (fact) => !compactEvidence.includes(fact),
  );
  const scannerStatus =
    workbench.deviceStatus?.find((device) => device.label === 'Сканер')?.value ?? 'Готов';
  const scanAction = currentActions.find(isWarehouseScanAction);
  const palletPrintAction =
    currentActions.find(isLegacyPalletPrintAction) ??
    secondaryActions.find(isLegacyPalletPrintAction);
  const currentPalletAction = actions.find(isCurrentPalletAction);
  const closeAction = actions.find(isWarehouseCloseAction);
  const currentNonScanActions = currentActions.filter(
    (action) =>
      action !== scanAction &&
      action !== palletPrintAction &&
      action !== currentPalletAction &&
      action !== closeAction &&
      !isDuplicateScanAction(action),
  );
  const secondaryNonPalletActions = secondaryActions.filter(
    (action) =>
      action !== palletPrintAction &&
      action !== currentPalletAction &&
      action !== closeAction &&
      !isDuplicateScanAction(action) &&
      !isWarehouseScanAction(action),
  );
  const inlineActions = [
    workbench.expectedRolls?.length ? undefined : closeAction,
    ...currentNonScanActions,
    ...secondaryNonPalletActions,
  ].filter(Boolean) as ActionDescriptor[];
  const scannedRoll = scannedRollFromWorkbench(workbench);
  const expectedRolls = workbench.expectedRolls ?? [];
  const compactDelivery = Boolean(selectedOperation && workbench.mode === 'delivery');
  const deliveryCustomerLabel =
    Array.from(
      new Set(
        expectedRolls
          .map((roll) => roll.customerAlias?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ).join(', ') || '—';
  const hasRollSourceProjection = expectedRolls.some((roll) => roll.source);
  const warehouseReserveRolls = expectedRolls.filter((roll) => roll.source === 'warehouse_reserve');
  const productionReadyRolls = expectedRolls.filter(
    (roll) => roll.source === 'production_handover',
  );
  const productionPendingRolls = expectedRolls.filter(warehouseRollIsProductionPending);
  const showRollRouteSummary =
    !compactDelivery &&
    (warehouseReserveRolls.length > 0 ||
      productionReadyRolls.length > 0 ||
      productionPendingRolls.length > 0);
  const scannableRolls = hasRollSourceProjection
    ? expectedRolls.filter(warehouseRollIsScannableNow)
    : expectedRolls;
  const scanTargetCount = hasRollSourceProjection ? scannableRolls.length : workbench.expected;
  const scanAcceptedCount = hasRollSourceProjection
    ? scannableRolls.filter((roll) => workbench.accepted.includes(roll.id)).length
    : workbench.scanned;
  const counterHelp =
    factHelpText({ label: 'Счетчик', value: `${scanAcceptedCount} / ${scanTargetCount}` }) ??
    'Счетчик меняется только после валидного QR.';
  const scanTargetTitle = hasRollSourceProjection
    ? `К сканированию сейчас: ${scanTargetCount}. Еще в производстве: ${productionPendingRolls.length}.`
    : `Ожидаемый объем по текущему складскому заданию: ${workbench.expected}.`;
  const responsiveRollPageSize = useResponsiveTablePageSize();
  const rollPageSize = Math.min(responsiveRollPageSize, 5);
  const {
    pageCount: rollPageCount,
    safePage: safeRollPage,
    startIndex: rollStartIndex,
    endIndex: rollEndIndex,
    pageRows: paginatedExpectedRolls,
  } = useTablePagination(expectedRolls, rollPage, rollPageSize);
  const visibleExpectedRolls =
    workbench.mode === 'receiving' ? expectedRolls : paginatedExpectedRolls;
  const scanErrorCount =
    (meaningfulScanResult && workbench.scanSeverity !== 'info' ? 1 : 0) + workbench.excess.length;
  const missingQrCount = Math.max(0, scanTargetCount - scanAcceptedCount);
  const hasScanException = scanErrorCount > 0;
  const palletDocument = workbench.palletListDocument;
  const palletDocuments = workbench.palletListDocuments ?? (palletDocument ? [palletDocument] : []);
  const openPalletDocument =
    palletDocuments.find((document) => document.id === openPalletDocumentId) ?? null;
  const warehouseTaskId = workbench.taskId ?? actionCoverageTaskId;
  const taskClosed = actions.some((action) => action.id.startsWith('warehouse-intake-closed:'));
  const hasRealScanAlert = selectedOperation ? workbench.excess.length > 0 : true;
  const showScanProblemNotice = Boolean(
    hasRealScanAlert && meaningfulScanResult && workbench.scanSeverity !== 'info',
  );
  const showBlockingNotice = Boolean(
    hasRealScanAlert && hasBlockingContext && !palletDocument && workbench.scanSeverity !== 'info',
  );
  const scanSessionLabel =
    workbench.scanned === 0 && !meaningfulScanResult
      ? 'Начать сканирование'
      : workbench.mode === 'delivery'
        ? 'Сканировать выдачу'
        : 'Сканировать QR';
  const lastScanLabel = workbench.lastScan || 'нет сканов';
  const scannerLine =
    scannerStatus === 'Готов' ? `Готов · ${lastScanLabel}` : `${scannerStatus} · ${lastScanLabel}`;
  const showScanSessionStrip = !selectedOperation || showScanAction;
  const selectedOperationTitle = selectedOperation
    ? selectedOperation.title.replace(new RegExp(`^${selectedOperation.mode}\\s+`, 'iu'), '') ||
      selectedOperation.title
    : workbench.prompt;

  useEffect(() => {
    setRollPage((current) => Math.min(current, rollPageCount));
  }, [rollPageCount]);

  useEffect(() => {
    setOpenPalletDocumentId((current) =>
      current && palletDocuments.some((document) => document.id === current) ? current : null,
    );
  }, [palletDocuments]);

  useEffect(() => {
    setPhysicalDraft(null);
    setPhysicalFeedback({ status: 'idle', message: '' });
    setReportedCoverageTaskId(null);
    if (coverageDecisionTask !== undefined) {
      setLoadedCoverageTask(
        coverageDecisionTask
          ? { targetTaskId: coverageDecisionTask.taskId, task: coverageDecisionTask }
          : null,
      );
      return;
    }
    if (!liveCoverageEnabled) {
      setLoadedCoverageTask(null);
      return;
    }
    if (!coverageTaskTargetId) {
      setLoadedCoverageTask(null);
      return;
    }
    let active = true;
    setLoadedCoverageTask(null);
    warehouseCoverageApi
      .readDecisionTask(coverageTaskTargetId)
      .then((task) => {
        if (active) {
          setLoadedCoverageTask({ targetTaskId: coverageTaskTargetId, task });
        }
      })
      .catch(() => {
        if (active) setLoadedCoverageTask(null);
      });
    return () => {
      active = false;
    };
  }, [coverageDecisionTask, coverageTaskTargetId, liveCoverageEnabled, selectedOperation?.id]);

  async function reportPhysicalException() {
    if (!activeCoverageTask || !physicalDraft || physicalFeedback.status === 'submitting') {
      return;
    }
    const reason = physicalDraft.reason.trim();
    if (!reason) return;
    const row = activeCoverageTask.rows.find(
      (candidate) => candidate.scanRowId === physicalDraft.scanRowId,
    );
    if (!row) return;
    setPhysicalFeedback({
      status: 'submitting',
      message: 'Фиксируем расхождение и снимаем резерв…',
    });
    const task = activeCoverageTask;
    const draft = physicalDraft;
    const request = physicalOperationGateRef.current.start(
      `warehouse:coverage-physical:${task.taskId}:${row.scanRowId}:${draft.kind}:${task.updatedAt}`,
      (clientRequestId) =>
        warehouseCoverageApi.reportPhysicalException(task.taskId, {
          clientRequestId,
          expectedGeneration: task.generation,
          expectedStateVersion: task.stateVersion,
          expectedTaskUpdatedAt: task.updatedAt,
          scanRowId: row.scanRowId,
          kind: draft.kind,
          reason,
        }),
    );
    if (!request) return;
    try {
      await request;
      setPhysicalFeedback({
        status: 'success',
        message: 'Расхождение зафиксировано. Резерв отправлен на перепроверку.',
      });
      setReportedCoverageTaskId(task.taskId);
      setPhysicalDraft(null);
      onWarehouseRefresh?.();
    } catch (error) {
      setPhysicalFeedback({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Не удалось зафиксировать расхождение. Обновите операцию и повторите.',
      });
    }
  }

  function runAction(action: ActionDescriptor) {
    if (isManualLookupAction(action)) {
      setManualLookupPayload('');
      setManualLookupOpen(true);
      return;
    }
    if (isWarehouseHistoryAction(action)) {
      setHistoryOpen((current) => !current);
      return;
    }
    onAction?.(action.id);
  }

  function submitManualLookup() {
    const payload = manualLookupPayload.trim();
    if (!payload) return;
    onManualLookup?.(targetObjectId, payload);
    if (!onManualLookup)
      onAction?.(`warehouse.scan:${targetObjectId}:${encodeURIComponent(payload)}`);
    setManualLookupOpen(false);
  }

  return (
    <section className="surface warehouse-scan">
      <header className="warehouse-operation-header" aria-label="Выбранная складская операция">
        <StepIllustration
          kind={warehouseIllustrationKind(workbench)}
          label={`${selectedOperation?.mode ?? (workbench.mode === 'receiving' ? 'Приемка' : 'Выдача')} ${selectedOperationTitle}`}
          tone={workbench.scanSeverity}
        />
        <div className="warehouse-operation-title">
          <span>
            {selectedOperation?.mode ?? (workbench.mode === 'receiving' ? 'Приемка' : 'Выдача')}
          </span>
          <strong>{selectedOperationTitle}</strong>
          {compactDelivery ? (
            <small aria-label="Контрагент заказа">Контрагент: {deliveryCustomerLabel}</small>
          ) : (
            <small>{selectedOperation?.title ?? workbench.prompt}</small>
          )}
        </div>
        <div className="warehouse-operation-state">
          <span>Статус</span>
          <strong>{selectedOperation?.status ?? scannerStatus}</strong>
          <small>
            {selectedOperation?.counter ? `${selectedOperation.counter} QR` : scannerLine}
          </small>
        </div>
        {onClose && (
          <button
            type="button"
            className="warehouse-detail-close"
            aria-label="Закрыть складскую операцию"
            onClick={onClose}
          >
            <ix-icon name="close" size="16" />
          </button>
        )}
      </header>
      {showScanSessionStrip && (
        <div className="warehouse-scan-session-strip" aria-label="Сессия сканирования">
          <div className="warehouse-scan-mode" aria-label="Режим сканирования">
            <ix-icon name="qr-code" size="24" />
            <strong>Сканирование</strong>
            <span>{scannerLine}</span>
          </div>
          <div className="scan-focus-strip">
            <div title={scanTargetTitle}>
              <span>Нужно</span>
              <strong>{scanTargetCount} QR</strong>
            </div>
            <div title={counterHelp}>
              <span>Принято</span>
              <strong>{scanAcceptedCount}</strong>
            </div>
            <div
              className={
                hasScanException ? 'severity-warning' : missingQrCount > 0 ? 'severity-info' : ''
              }
              title="Ожидаемые, но еще не считанные QR показываются отдельно от дублей и чужих кодов."
            >
              <span>{hasScanException ? 'Ошибки' : 'Осталось'}</span>
              <strong>
                {hasScanException
                  ? `${scanErrorCount} к разбору`
                  : missingQrCount > 0
                    ? `${missingQrCount} QR`
                    : 'Нет'}
              </strong>
            </div>
          </div>
          {showScanAction && scanAction && (
            <button
              className={`compact-action-button scanner-session-button action-${scanAction.level}`}
              type="button"
              disabled={!scanAction.enabled}
              title={
                scanAction.enabled
                  ? 'Сессия сканирования открыта на весь заказ'
                  : (scanAction.disabledReason ?? scanAction.recoveryAction)
              }
              aria-label={
                scanAction.enabled
                  ? `${scanSessionLabel}. Сессия на весь заказ`
                  : actionDisplayLabel(scanAction)
              }
              onClick={() => onAction?.(scanAction.id)}
            >
              <ix-icon name={actionIcon(scanAction)} size="16" />
              <span>{scanSessionLabel}</span>
            </button>
          )}
        </div>
      )}
      {expectedRolls.length === 0 && (
        <div className="warehouse-empty-scan-state severity-warning" role="status">
          <strong>Сканировать нечего</strong>
          <span>{workbench.recovery ?? 'Нет складского задания'}</span>
        </div>
      )}
      {(showScanProblemNotice || showBlockingNotice) && (
        <div className="scan-alert-row" aria-live="polite">
          {showScanProblemNotice && (
            <div className={`warehouse-scan-result severity-${workbench.scanSeverity}`}>
              <span>Ошибка QR</span>
              <strong>{workbench.scanResult}</strong>
            </div>
          )}
          {showBlockingNotice && (
            <div className="warehouse-blocker severity-warning">
              <strong>{workbench.blockingReason ?? 'Требуется действие склада'}</strong>
              <span>{workbench.recovery}</span>
            </div>
          )}
        </div>
      )}
      {activeCoverageTask && (
        <WarehouseCoveragePhysicalExceptionPanel
          task={activeCoverageTask}
          draft={physicalDraft}
          feedback={physicalFeedback}
          onOpen={(row, kind) => {
            setPhysicalDraft({ scanRowId: row.scanRowId, kind, reason: '' });
            setPhysicalFeedback({ status: 'idle', message: '' });
          }}
          onReasonChange={(reason) => {
            setPhysicalDraft((current) => (current ? { ...current, reason } : current));
            setPhysicalFeedback({ status: 'idle', message: '' });
          }}
          onCancel={() => {
            setPhysicalDraft(null);
            setPhysicalFeedback({ status: 'idle', message: '' });
          }}
          onSubmit={() => void reportPhysicalException()}
        />
      )}
      {!activeCoverageTask && physicalFeedback.status === 'success' && (
        <p className="warehouse-coverage-physical-feedback is-success" role="status">
          {physicalFeedback.message}
        </p>
      )}
      {hasRollSourceProjection && showRollRouteSummary && (
        <section className="warehouse-roll-route-summary" aria-label="Покрытие и ожидание рулонов">
          {warehouseReserveRolls.length > 0 && (
            <div
              className="warehouse-route-card is-reserve"
              title={warehouseRollIds(warehouseReserveRolls)}
            >
              <span>Со склада</span>
              <strong>{warehouseReserveRolls.length} рул.</strong>
              <small>{warehouseRollIds(warehouseReserveRolls)}</small>
            </div>
          )}
          {productionReadyRolls.length > 0 && (
            <div
              className="warehouse-route-card is-ready"
              title={warehouseRollIds(productionReadyRolls)}
            >
              <span>К приемке</span>
              <strong>{productionReadyRolls.length} рул.</strong>
              <small>{warehouseRollIds(productionReadyRolls)}</small>
            </div>
          )}
          {productionPendingRolls.length > 0 && (
            <div
              className="warehouse-route-card is-production"
              title={warehouseRollIds(productionPendingRolls)}
            >
              <span>Ждем</span>
              <strong>{productionPendingRolls.length} рул.</strong>
              <small>
                {productionPendingRolls
                  .slice(0, 2)
                  .map(
                    (roll) =>
                      `${roll.id} · ${roll.operatorLabel ?? 'оператор'} · ${roll.machineLabel ?? 'станок'}`,
                  )
                  .join('; ') || 'нет'}
              </small>
            </div>
          )}
        </section>
      )}
      {(expectedRolls.length > 0 ||
        palletDocuments.length > 0 ||
        (workbench.mode === 'receiving' && warehouseTaskId) ||
        inlineActions.length > 0) && (
        <div
          className={`warehouse-receiving-workarea${compactDelivery ? ' is-delivery-operation' : ''} ${
            palletDocuments.length > 0 || workbench.activePallet ? 'has-pallet-list' : ''
          }`}
        >
          {workbench.mode === 'receiving' && warehouseTaskId && (
            <WarehouseActivePalletPanel
              taskId={warehouseTaskId}
              pallet={workbench.activePallet}
              rolls={expectedRolls}
              onWarehouseRefresh={onWarehouseRefresh}
            />
          )}
          {expectedRolls.length > 0 && (
            <div
              className={`warehouse-roll-table${compactDelivery ? ' is-delivery-operation' : ''}`}
              role="table"
              aria-label={compactDelivery ? 'Рулоны к выдаче' : 'Ожидаемые рулоны'}
            >
              <div className="operator-panel-title">
                <span>{compactDelivery ? 'Рулоны к выдаче' : 'Ожидаемые рулоны'}</span>
                {closeAction && (
                  <button
                    type="button"
                    className={`warehouse-close-inline-action action-${closeAction.level}`}
                    disabled={!closeAction.enabled}
                    title={
                      closeAction.enabled
                        ? `Закрыть складскую ${workbench.mode === 'delivery' ? 'выдачу' : 'приемку'} после полного скана`
                        : (closeAction.disabledReason ?? closeAction.recoveryAction)
                    }
                    aria-label={
                      closeAction.enabled
                        ? actionDisplayLabel(closeAction)
                        : `${actionDisplayLabel(closeAction)} недоступно. ${closeAction.disabledReason ?? closeAction.recoveryAction ?? ''}`
                    }
                    onClick={() => onAction?.(closeAction.id)}
                  >
                    <ix-icon name={actionIcon(closeAction)} size="16" />
                    <span className="warehouse-close-inline-copy">
                      <strong>{actionDisplayLabel(closeAction)}</strong>
                      {!closeAction.enabled && (
                        <small>{closeAction.disabledReason ?? closeAction.recoveryAction}</small>
                      )}
                    </span>
                  </button>
                )}
              </div>
              <div
                className={`warehouse-roll-row is-head${compactDelivery ? ' is-delivery-operation' : ''}`}
                role="row"
              >
                <span role="columnheader">Рулон</span>
                {!compactDelivery && <span role="columnheader">Заказ</span>}
                <span role="columnheader">QR</span>
                {!compactDelivery && <span role="columnheader">Характеристики</span>}
                <span role="columnheader">Статус</span>
                <span role="columnheader">Действие</span>
              </div>
              {visibleExpectedRolls.map((roll) => {
                const severity = warehouseRollSeverity(workbench, roll);
                const canReturn = warehouseRollNeedsReturn(workbench, roll);
                const waitingProduction = warehouseRollIsProductionPending(roll);
                const palletSelection = roll.palletSelection;
                const palletLocked = Boolean(palletSelection?.locked);
                const rowMutationLocked = waitingProduction || palletLocked;
                const characteristicsLabel = warehouseRollCharacteristicsLabel(roll);
                const dimensionsLabel = warehouseRollDimensionsLabel(roll);
                const weightLabel = warehouseRollWeightLabel(roll);
                const productionLabel = warehouseRollProductionLabel(roll);
                const packagingLabel = warehouseRollPackagingLabel(roll);
                const canSelectPallet = Boolean(
                  workbench.mode === 'receiving' &&
                  warehouseTaskId &&
                  roll.scanRowId &&
                  palletSelection &&
                  workbench.accepted.includes(roll.id) &&
                  onWarehouseRefresh,
                );

                return (
                  <div
                    key={roll.id}
                    data-roll-code={roll.id}
                    className={`warehouse-roll-row${compactDelivery ? ' is-delivery-operation' : ''} severity-${palletLocked ? 'success' : severity} ${scannedRoll?.id === roll.id ? 'is-last-scan' : ''} ${palletLocked ? 'is-pallet-locked' : ''}`}
                    role="row"
                  >
                    <span role="cell" data-label="Рулон">
                      <strong>{roll.sequenceNumber ? `#${roll.sequenceNumber}` : roll.id}</strong>
                      <small>{roll.id}</small>
                    </span>
                    {!compactDelivery && (
                      <span role="cell" data-label="Заказ">
                        <strong>{roll.orderId ?? 'по приемке'}</strong>
                        <small>{roll.customerAlias ?? roll.palletId ?? 'клиент скрыт'}</small>
                      </span>
                    )}
                    <span role="cell" data-label="QR">
                      <strong>{warehouseRollQrLabel(roll)}</strong>
                      <small>
                        {waitingProduction
                          ? 'QR после передачи'
                          : workbench.lastScan.includes(roll.id)
                            ? 'последний скан'
                            : 'ожидаемый QR'}
                      </small>
                    </span>
                    {!compactDelivery && (
                      <span role="cell" data-label="Характеристики">
                        {characteristicsLabel && <strong>{characteristicsLabel}</strong>}
                        {dimensionsLabel && <small>{dimensionsLabel}</small>}
                        {packagingLabel && <small>{packagingLabel}</small>}
                      </span>
                    )}
                    <span role="cell" data-label="Статус">
                      <strong>{roll.status}</strong>
                      {!compactDelivery && (
                        <>
                          <small>
                            {palletLocked
                              ? `Закрытый палет · ${palletSelection?.palletCode ?? 'палетный лист'}`
                              : warehouseRollSourceLabel(roll)}
                          </small>
                          {weightLabel && <small>{weightLabel}</small>}
                          {productionLabel && <small>{productionLabel}</small>}
                        </>
                      )}
                    </span>
                    <span role="cell" data-label="Действие" className="warehouse-row-actions">
                      {waitingProduction ? (
                        <button
                          type="button"
                          className="warehouse-row-action"
                          disabled
                          title={`Сначала дождитесь передачи ${roll.id} из производства. ${warehouseRollSourceDetail(roll)}`}
                          aria-label={`Ждем ${roll.id}: сначала дождитесь передачи из производства`}
                        >
                          Ждем
                        </button>
                      ) : (
                        <>
                          {canSelectPallet && palletSelection && (
                            <WarehousePalletSelectionButton
                              key={`${warehouseTaskId}:${roll.scanRowId}`}
                              taskId={warehouseTaskId!}
                              scanRowId={roll.scanRowId!}
                              rollCode={roll.id}
                              selection={palletSelection}
                              locked={palletLocked}
                              onWarehouseRefresh={onWarehouseRefresh!}
                            />
                          )}
                          {showReturnAction && canReturn && (
                            <button
                              type="button"
                              className="warehouse-row-action is-return"
                              disabled={rowMutationLocked}
                              title={
                                palletLocked
                                  ? 'Рулон входит в закрытый палетный лист. Изменения недоступны.'
                                  : `Вернуть ${roll.id} с причиной и записью в историю`
                              }
                              onClick={() => onAction?.(`warehouse.return:${roll.id}`)}
                            >
                              Вернуть
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
              {workbench.mode === 'delivery' && rollPageCount > 1 && (
                <TablePager
                  page={safeRollPage}
                  pageCount={rollPageCount}
                  total={expectedRolls.length}
                  startIndex={rollStartIndex}
                  endIndex={rollEndIndex}
                  onPageChange={setRollPage}
                />
              )}
            </div>
          )}
          {inlineActions.length > 0 && (
            <div
              className="warehouse-inline-action-row"
              aria-label="Действия по выбранной операции"
            >
              {inlineActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`warehouse-inline-action action-${action.level}`}
                  disabled={!action.enabled}
                  title={
                    action.enabled
                      ? (action.helpText ?? action.confirmation ?? actionDisplayLabel(action))
                      : (action.disabledReason ?? action.recoveryAction)
                  }
                  aria-label={
                    action.enabled
                      ? actionDisplayLabel(action)
                      : `${actionDisplayLabel(action)} недоступно. ${action.disabledReason ?? action.recoveryAction ?? ''}`
                  }
                  onClick={() => runAction(action)}
                >
                  <ix-icon name={actionIcon(action)} size="16" />
                  <span>
                    {actionDisplayLabel(action)}
                    {!action.enabled && (
                      <small>{action.disabledReason ?? action.recoveryAction}</small>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          {historyOpen && (
            <section
              className="warehouse-secondary-details warehouse-operation-history"
              aria-label="История складской операции"
            >
              <div className="operator-panel-title">
                <div>
                  <span>История</span>
                  <small>{history.length} событий</small>
                </div>
                <button
                  type="button"
                  className="warehouse-row-action"
                  onClick={() => setHistoryOpen(false)}
                >
                  Закрыть
                </button>
              </div>
              {history.length > 0 ? (
                <div className="warehouse-evidence-grid">
                  {history.map((item) => (
                    <div key={item.id}>
                      <span>
                        {item.time} · {item.actorLabel}
                      </span>
                      <strong>{visibleAuditActionLabel(item.actionLabel)}</strong>
                      <small>{item.detail}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <p>Событий по выбранной операции пока нет.</p>
              )}
            </section>
          )}
          {palletDocuments.length > 0 && (
            <section className="warehouse-pallet-history" aria-label="История палетов">
              <div className="operator-panel-title warehouse-pallet-history-title">
                <div>
                  <span>Закрытые палеты</span>
                  <small>{palletDocuments.length} документов в истории</small>
                </div>
              </div>
              <div className="warehouse-pallet-history-list">
                {palletDocuments.map((document) => {
                  const opened = document.id === openPalletDocumentId;
                  return (
                    <article key={document.id} className={opened ? 'is-open' : ''}>
                      <div>
                        <strong>{document.palletId}</strong>
                        <span>
                          {document.rollCount ?? document.rollIds.length} рул. ·{' '}
                          {document.generatedAt?.slice(0, 10) ?? 'дата не указана'}
                        </span>
                        <small>
                          {document.documentStatus === 'voided'
                            ? 'Аннулирован · QR сохранён для трассировки'
                            : document.origin === 'legacy'
                              ? 'Архивный документ'
                              : document.printStatus === 'submitted'
                                ? 'Отправлен на печать'
                                : 'Готов к печати'}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="warehouse-row-action"
                        aria-label={`${
                          opened ? 'Закрыть' : 'Открыть'
                        } палетный лист ${document.palletId}`}
                        onClick={() =>
                          setOpenPalletDocumentId((current) =>
                            current === document.id ? null : document.id,
                          )
                        }
                      >
                        {opened ? 'Свернуть' : 'Открыть'}
                      </button>
                    </article>
                  );
                })}
              </div>
              {workbench.palletHistoryHasMore && (
                <p className="warehouse-pallet-history-more">
                  Показаны последние документы. Для полной истории уточните период.
                </p>
              )}
              {openPalletDocument && onWarehouseRefresh && (
                <PalletLabelPanel
                  document={openPalletDocument}
                  taskId={warehouseTaskId ?? undefined}
                  voidAllowed={!taskClosed}
                  enabled={palletPrintAction?.enabled ?? true}
                  disabledReason={palletPrintAction?.disabledReason}
                  onWarehouseRefresh={onWarehouseRefresh}
                />
              )}
            </section>
          )}
        </div>
      )}
      {compactEvidence.length > 0 && (
        <details
          className="warehouse-secondary-details warehouse-bigbag-evidence"
          aria-label="Big-bag смены"
        >
          <summary>Big-bag смены</summary>
          <div className="warehouse-evidence-grid">
            {compactEvidence.map((fact) => (
              <div key={`${fact.label}-${fact.value}`} title={`${fact.label}: ${fact.value}`}>
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
          {extraEvidence.length > 0 && (
            <details className="warehouse-evidence-details">
              <summary>Данные Big-bag</summary>
              <div className="warehouse-evidence-grid">
                {extraEvidence.map((fact) => (
                  <div key={`${fact.label}-${fact.value}`} title={`${fact.label}: ${fact.value}`}>
                    <span>{fact.label}</span>
                    <strong>{fact.value}</strong>
                  </div>
                ))}
              </div>
            </details>
          )}
        </details>
      )}
      {manualLookupOpen && (
        <PlenkiModal
          eyebrow="Склад"
          title="Найти рулон вручную"
          onClose={() => setManualLookupOpen(false)}
          className="warehouse-manual-lookup-dialog"
          footer={
            <>
              <button
                type="button"
                className="action-secondary"
                onClick={() => setManualLookupOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="action-recommended"
                disabled={!manualLookupPayload.trim()}
                onClick={submitManualLookup}
              >
                Проверить QR
              </button>
            </>
          }
        >
          <label className="warehouse-inline-field state-manual">
            <span>QR или номер рулона</span>
            <input
              autoFocus
              value={manualLookupPayload}
              onChange={(event) => setManualLookupPayload(event.target.value)}
              placeholder="Например: QR-R-A17-03"
            />
            <small>Счетчик изменится только после проверки ожидаемого QR.</small>
          </label>
        </PlenkiModal>
      )}
    </section>
  );
}

function WarehouseCoveragePhysicalExceptionPanel({
  task,
  draft,
  feedback,
  onOpen,
  onReasonChange,
  onCancel,
  onSubmit,
}: {
  task: WarehouseCoverageDecisionTaskView;
  draft: CoveragePhysicalDraft | null;
  feedback: {
    status: 'idle' | 'submitting' | 'success' | 'error';
    message: string;
  };
  onOpen: (row: WarehouseCoverageDecisionTaskRowView, kind: CoveragePhysicalDraft['kind']) => void;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const busy = feedback.status === 'submitting';
  const selectedRow = draft ? task.rows.find((row) => row.scanRowId === draft.scanRowId) : null;

  return (
    <section
      className="warehouse-coverage-physical"
      aria-label="Физическое расхождение покрытия"
      data-coverage-task-id={task.taskId}
    >
      <header>
        <div>
          <span className="eyebrow">Резерв покрытия</span>
          <strong>Физическая проверка рулонов</strong>
        </div>
        <small>{task.rows.length} рул.</small>
      </header>
      <div className="warehouse-coverage-physical-rows">
        {task.rows.map((row) => (
          <article key={row.scanRowId} data-scan-row-id={row.scanRowId}>
            <span>
              <strong>{row.rollCode}</strong>
              <small>{coverageScanStatusLabel(row.scanStatus)}</small>
            </span>
            <div>
              <button
                type="button"
                disabled={busy || task.status === 'exception'}
                onClick={() => onOpen(row, 'missing')}
              >
                Рулон отсутствует
              </button>
              <button
                type="button"
                disabled={busy || task.status === 'exception'}
                onClick={() => onOpen(row, 'damaged')}
              >
                Рулон повреждён
              </button>
            </div>
          </article>
        ))}
      </div>
      {draft && selectedRow && (
        <div className="warehouse-coverage-physical-form">
          <p>
            <strong>{selectedRow.rollCode}</strong>
            <span>
              {draft.kind === 'missing' ? 'Фиксируем отсутствие' : 'Фиксируем повреждение'}
            </span>
          </p>
          <label>
            <span>Причина</span>
            <textarea
              aria-label="Причина физического расхождения"
              value={draft.reason}
              maxLength={1000}
              disabled={busy}
              autoFocus
              placeholder="Что обнаружено при физической проверке"
              onChange={(event) => onReasonChange(event.currentTarget.value)}
            />
          </label>
          <div>
            <button type="button" disabled={busy} onClick={onCancel}>
              Отмена
            </button>
            <button
              type="button"
              className="action-recommended"
              disabled={busy || !draft.reason.trim()}
              title={
                draft.reason.trim()
                  ? 'Зафиксировать расхождение и открыть перепроверку'
                  : 'Укажите причину расхождения'
              }
              onClick={onSubmit}
            >
              {busy ? 'Фиксируем…' : 'Сообщить о расхождении'}
            </button>
          </div>
        </div>
      )}
      {feedback.status === 'error' && (
        <p className="warehouse-coverage-physical-feedback is-error" role="alert">
          {feedback.message}
        </p>
      )}
    </section>
  );
}

function coverageScanStatusLabel(
  status: WarehouseCoverageDecisionTaskRowView['scanStatus'],
): string {
  const labels: Record<WarehouseCoverageDecisionTaskRowView['scanStatus'], string> = {
    expected: 'Ожидается',
    scanned: 'Отсканирован',
    accepted: 'Принят',
    missing: 'Отсутствует',
    excess: 'Лишний',
    duplicate: 'Дубликат',
    wrong: 'Не тот рулон',
    damaged: 'Повреждён',
    reserved: 'В резерве',
  };
  return labels[status];
}
