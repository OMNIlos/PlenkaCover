import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  downloadWarehousePalletList,
  printWarehousePalletList,
  recordWarehousePalletSystemPrintIntent,
} from '../../api/warehouse';
import type { PalletListDocument } from '../../domain/types';
import {
  isLivePalletListTemplateVersion,
  usesPalletBrowserSystemPrint,
} from '../../domain/palletListPrint';
import { PlenkiModal } from '../plenki-ui/PlenkiPrimitives';
import {
  PalletPrintRequestGate,
  palletPrintFailurePresentation,
  palletPrintPhaseFromStatus,
  type PalletPrintPhase,
  waitForPalletSubmission,
} from './warehousePalletPrint';
import {
  palletDocumentUsesLiveResources,
  usePalletLabelResources,
  warehousePrinterStatusLabel,
  warehouseRequestErrorMessage,
} from './warehousePalletResources';
import { VoidPalletDialog, canVoidPalletDocument } from './VoidPalletDialog';
import {
  openWarehousePalletSystemPrint,
  warehousePalletPageSizeLabel,
  warehousePalletPrintLayout,
  type WarehousePalletPrintLayout,
  WarehouseSystemPrintIntentGate,
} from './warehouseBrowserPrint';

const MIN_REPRINT_REASON_LENGTH = 3;
const MAX_REPRINT_REASON_LENGTH = 500;

type ExportFormat = 'word' | 'excel' | 'pdf';

function documentPageSizeLabel(document: PalletListDocument) {
  if (!document.templateVersion) return 'Формат не подтвержден';
  try {
    return warehousePalletPageSizeLabel(document.templateVersion);
  } catch {
    return 'Формат не подтвержден';
  }
}

function layoutPercent(valueMm: number, totalMm: number) {
  return `${(valueMm / totalMm) * 100}%`;
}

function palletPreviewImageStyle(layout: WarehousePalletPrintLayout): CSSProperties {
  return {
    position: 'absolute',
    left: layoutPercent(layout.imageOffsetLeftMm, layout.pageWidthMm),
    top: layoutPercent(layout.imageOffsetTopMm, layout.pageHeightMm),
    width: layoutPercent(layout.imageWidthMm, layout.pageWidthMm),
    height: layoutPercent(layout.imageHeightMm, layout.pageHeightMm),
    objectFit: 'fill',
    transform: layout.rotationDegrees === 90 ? 'rotate(90deg)' : undefined,
    transformOrigin: layout.rotationDegrees === 90 ? '50% 50%' : undefined,
  };
}

function PalletLabelPreview({
  liveResources,
  previewUrl,
  previewPending,
  previewError,
  layout,
  onReload,
}: {
  liveResources: boolean;
  previewUrl: string | null;
  previewPending: boolean;
  previewError: string | null;
  layout: WarehousePalletPrintLayout | null;
  onReload: () => void;
}) {
  return (
    <div
      className={`warehouse-pallet-label-preview ${previewUrl ? 'has-preview' : ''}`}
      data-print-layout={layout?.layoutMarker ?? undefined}
      style={{
        aspectRatio: layout ? `${layout.pageWidthMm} / ${layout.pageHeightMm}` : '2 / 3',
      }}
      aria-live="polite"
    >
      {liveResources && previewUrl && layout ? (
        <img
          src={previewUrl}
          alt={`Палетный лист ${layout.pageWidthMm} на ${layout.pageHeightMm} мм`}
          style={palletPreviewImageStyle(layout)}
        />
      ) : (
        <div className="warehouse-pallet-label-placeholder" role="status">
          <ix-icon
            name={liveResources && previewError ? 'warning' : 'app-document-filled'}
            size="32"
          />
          <strong>
            {!liveResources
              ? 'Палетный лист недоступен'
              : previewPending
                ? 'Загружаем палетный лист'
                : 'Нет предпросмотра'}
          </strong>
          <span>
            {!liveResources
              ? 'Печать и скачивание недоступны для этого документа.'
              : previewError || 'Ожидаем готовый документ.'}
          </span>
          {liveResources && previewError && (
            <button type="button" className="action-secondary" onClick={onReload}>
              Повторить загрузку
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const EXPORT_LABELS: Record<ExportFormat, string> = {
  word: 'Word',
  excel: 'Excel',
  pdf: 'PDF',
};

function printPhaseLabel(phase: PalletPrintPhase) {
  const labels: Record<PalletPrintPhase, string> = {
    idle: 'Не печатался',
    pending: 'Задание в очереди',
    uncertain: 'Статус не подтвержден',
    submitted: 'Задание отправлено',
    failed: 'Печать не отправлена',
  };
  return labels[phase];
}

function printReadinessMessage({
  liveResources,
  printReady,
  enabled,
  disabledReason,
  previewPending,
  previewUrl,
  printersPending,
  printerError,
  readyPrinterCount,
  selectedPrinterId,
}: {
  liveResources: boolean;
  printReady: boolean;
  enabled: boolean;
  disabledReason?: string;
  previewPending: boolean;
  previewUrl: string | null;
  printersPending: boolean;
  printerError: string | null;
  readyPrinterCount: number;
  selectedPrinterId: string | null;
}) {
  if (!liveResources) return 'Для этого палетного листа печать недоступна.';
  if (!printReady) return 'Этот документ ещё не готов к печати.';
  if (!enabled) return disabledReason || 'Печать недоступна для текущей операции.';
  if (previewPending) return 'Загружаем палетный лист…';
  if (!previewUrl) return 'Предпросмотр недоступен.';
  if (printersPending) return 'Проверяем принтеры складского поста…';
  if (printerError) return `Не удалось проверить принтеры: ${printerError}`;
  if (readyPrinterCount === 0) {
    return 'Нет доступного принтера. Проверьте подключение принтера.';
  }
  if (!selectedPrinterId) return 'Выберите принтер для этой складской станции.';
  return null;
}

type PalletDocumentLifecycle = 'active' | 'voided' | 'unknown';
type SystemPrintFeedback = {
  tone: 'success' | 'error';
  message: string;
};

function palletDocumentLifecycle(document: PalletListDocument): PalletDocumentLifecycle {
  if (document.documentStatus === 'voided') return 'voided';
  if (document.origin === 'legacy' || document.documentStatus === 'sealed') return 'active';
  return 'unknown';
}

function PalletHistoryOnlyPanel({
  document,
  lifecycle,
}: {
  document: PalletListDocument;
  lifecycle: Exclude<PalletDocumentLifecycle, 'active'>;
}) {
  const voided = lifecycle === 'voided';
  return (
    <section
      className="warehouse-pallet-label-panel warehouse-pallet-history-only"
      aria-label="Палетный лист"
    >
      <div className="operator-panel-title warehouse-pallet-title">
        <div>
          <span>Палетный лист</span>
          <small>
            {documentPageSizeLabel(document)} · {document.palletId}
          </small>
        </div>
        <span className="warehouse-pallet-history-state" role="status">
          {voided ? 'Аннулирован' : 'Статус не подтвержден'}
        </span>
      </div>
      <div className="warehouse-pallet-history-only-copy" role="status">
        <ix-icon name={voided ? 'history' : 'warning'} size="24" />
        <div>
          <strong>
            {voided ? 'Аннулированный палетный лист' : 'Статус палетного листа не подтвержден'}
          </strong>
          <span>
            {voided
              ? 'Прежний QR сохранён только для трассировки. Печать, выгрузка и действия с листом недоступны.'
              : 'Обновите приёмку: печать, выгрузка и действия с листом пока недоступны.'}
          </span>
        </div>
      </div>
    </section>
  );
}

export function PalletLabelPanel({
  document,
  taskId,
  enabled = true,
  voidAllowed = true,
  disabledReason,
  onWarehouseRefresh,
}: {
  document: PalletListDocument;
  taskId?: string;
  enabled?: boolean;
  voidAllowed?: boolean;
  disabledReason?: string;
  onWarehouseRefresh: () => void;
}) {
  const lifecycle = palletDocumentLifecycle(document);
  const liveResources = lifecycle === 'active' && palletDocumentUsesLiveResources(document);
  const usesBrowserSystemPrint = usesPalletBrowserSystemPrint(document.templateVersion);
  const previewLayout = isLivePalletListTemplateVersion(document.templateVersion)
    ? warehousePalletPrintLayout(document.templateVersion)
    : null;
  const {
    printers,
    selectedPrinterId,
    selectPrinter: selectResourcePrinter,
    printersPending,
    printerError,
    previewBlob,
    previewUrl,
    previewPending,
    previewError,
    reload,
  } = usePalletLabelResources(document.id, liveResources, liveResources && !usesBrowserSystemPrint);
  const [printPhase, setPrintPhase] = useState<PalletPrintPhase>(() =>
    palletPrintPhaseFromStatus(document.printStatus),
  );
  const [printError, setPrintError] = useState<string | null>(null);
  const [reprintOpen, setReprintOpen] = useState(false);
  const [reprintReason, setReprintReason] = useState('');
  const [exportPending, setExportPending] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidFeedback, setVoidFeedback] = useState<string | null>(null);
  const [systemPrintPending, setSystemPrintPending] = useState(false);
  const [systemPrintFeedback, setSystemPrintFeedback] = useState<SystemPrintFeedback | null>(null);
  const [systemPrintRetryReason, setSystemPrintRetryReason] = useState<string | null>(null);
  const requestGateRef = useRef(new PalletPrintRequestGate());
  const systemPrintIntentGateRef = useRef(new WarehouseSystemPrintIntentGate());
  const printPendingRef = useRef(false);
  const systemPrintPendingRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const hadUncertainRequestRef = useRef(false);

  useEffect(() => {
    const serverPhase = palletPrintPhaseFromStatus(document.printStatus);
    requestGenerationRef.current += 1;
    requestGateRef.current = new PalletPrintRequestGate();
    systemPrintIntentGateRef.current.reset();
    printPendingRef.current = false;
    systemPrintPendingRef.current = false;
    hadUncertainRequestRef.current = false;
    setPrintPhase(serverPhase);
    setPrintError(null);
    setReprintOpen(false);
    setReprintReason('');
    setVoidOpen(false);
    setVoidFeedback(null);
    setSystemPrintPending(false);
    setSystemPrintFeedback(null);
    setSystemPrintRetryReason(null);
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [document.id]);

  useEffect(() => {
    const serverPhase = palletPrintPhaseFromStatus(document.printStatus);
    if (
      hadUncertainRequestRef.current &&
      (serverPhase === 'submitted' || serverPhase === 'failed')
    ) {
      requestGateRef.current.retireRetryRequest();
      hadUncertainRequestRef.current = false;
    }
    if (serverPhase !== 'idle') setPrintPhase(serverPhase);
  }, [document]);

  const printPending = printPhase === 'pending';
  const uncertainSubmission = printPhase === 'uncertain';
  const submitted = printPhase === 'submitted';
  const selectedPrinter = printers.find((printer) => printer.id === selectedPrinterId);
  const readyPrinters = printers.filter((printer) => printer.ready);
  const printReady = document.printReady === true && lifecycle === 'active';
  const canPrint = Boolean(
    liveResources &&
    enabled &&
    printReady &&
    previewUrl &&
    selectedPrinter?.ready &&
    !previewPending &&
    !printersPending &&
    !printPending,
  );
  const canRunPrimaryAction = lifecycle === 'active' && (uncertainSubmission || canPrint);
  const trimmedReason = reprintReason.trim();
  const validReprintReason =
    trimmedReason.length >= MIN_REPRINT_REASON_LENGTH &&
    trimmedReason.length <= MAX_REPRINT_REASON_LENGTH;

  const readinessMessage = printReadinessMessage({
    liveResources,
    printReady,
    enabled,
    disabledReason,
    previewPending,
    previewUrl,
    printersPending,
    printerError,
    readyPrinterCount: readyPrinters.length,
    selectedPrinterId,
  });

  if (lifecycle !== 'active') {
    return <PalletHistoryOnlyPanel document={document} lifecycle={lifecycle} />;
  }

  function selectPrinter(printerId: string) {
    selectResourcePrinter(printerId);
    setPrintError(null);
  }

  async function submitPrint(reason?: string) {
    if (!selectedPrinterId || !canPrint || printPendingRef.current) return;

    const requestGeneration = requestGenerationRef.current;
    const requestIsCurrent = () => requestGenerationRef.current === requestGeneration;
    printPendingRef.current = true;
    setPrintPhase('pending');
    setPrintError(null);

    try {
      await requestGateRef.current.run((requestId) =>
        waitForPalletSubmission(() =>
          printWarehousePalletList(document.id, {
            printerId: selectedPrinterId,
            requestId,
            ...(reason ? { reason } : {}),
          }),
        ),
      );
      if (!requestIsCurrent()) {
        onWarehouseRefresh();
        return;
      }
      hadUncertainRequestRef.current = false;
      setPrintPhase('submitted');
      setReprintOpen(false);
      setReprintReason('');
      onWarehouseRefresh();
    } catch (error: unknown) {
      if (!requestIsCurrent()) return;
      const presentation = palletPrintFailurePresentation(error);
      hadUncertainRequestRef.current = presentation.phase === 'uncertain';
      setPrintPhase(presentation.phase);
      setPrintError(
        presentation.message ??
          (presentation.phase === 'failed' ? warehouseRequestErrorMessage(error) : null),
      );
      if (presentation.refresh) onWarehouseRefresh();
    } finally {
      if (requestIsCurrent()) printPendingRef.current = false;
    }
  }

  function refreshUncertainStatus() {
    setPrintError(null);
    onWarehouseRefresh();
  }

  function startPrint() {
    if (uncertainSubmission) {
      refreshUncertainStatus();
      return;
    }
    if (submitted) {
      setReprintReason('');
      setReprintOpen(true);
      return;
    }
    void submitPrint();
  }

  async function download(format: ExportFormat) {
    if (!liveResources) return;
    setExportPending(format);
    setExportError(null);
    try {
      await downloadWarehousePalletList(document.id, format);
    } catch (error: unknown) {
      setExportError(warehouseRequestErrorMessage(error));
    } finally {
      setExportPending(null);
    }
  }

  async function openAuditedSystemReprint() {
    const intentReason = systemPrintRetryReason ?? trimmedReason;
    if (
      !usesBrowserSystemPrint ||
      !document.templateVersion ||
      !liveResources ||
      !enabled ||
      !printReady ||
      !previewBlob ||
      !previewUrl ||
      previewPending ||
      previewError !== null ||
      (systemPrintRetryReason === null && !validReprintReason) ||
      systemPrintPendingRef.current
    ) {
      return;
    }

    const requestGeneration = requestGenerationRef.current;
    const requestIsCurrent = () => requestGenerationRef.current === requestGeneration;
    systemPrintPendingRef.current = true;
    setSystemPrintPending(true);
    setSystemPrintRetryReason(intentReason);
    setSystemPrintFeedback(null);
    try {
      await systemPrintIntentGateRef.current.run((requestId) =>
        recordWarehousePalletSystemPrintIntent(document.id, {
          requestId,
          kind: 'reprint',
          reason: intentReason,
        }),
      );
      await openWarehousePalletSystemPrint(previewBlob, document.templateVersion);
      if (!requestIsCurrent()) return;
      setSystemPrintFeedback({ tone: 'success', message: 'Открыта системная печать.' });
      setReprintReason('');
      onWarehouseRefresh();
    } catch (error: unknown) {
      if (!requestIsCurrent()) return;
      setSystemPrintFeedback({ tone: 'error', message: warehouseRequestErrorMessage(error) });
    } finally {
      if (requestIsCurrent()) {
        systemPrintPendingRef.current = false;
        setSystemPrintPending(false);
        if (!systemPrintIntentGateRef.current.hasPendingRetry()) {
          setSystemPrintRetryReason(null);
        }
      }
    }
  }

  if (usesBrowserSystemPrint) {
    const canOpenSystemPrint =
      liveResources &&
      enabled &&
      printReady &&
      previewBlob !== null &&
      previewUrl !== null &&
      !previewPending &&
      previewError === null &&
      (systemPrintRetryReason !== null || validReprintReason) &&
      !systemPrintPending;
    return (
      <section className="warehouse-pallet-label-panel" aria-label="Палетный лист">
        <div className="operator-panel-title warehouse-pallet-title">
          <div>
            <span>Палетный лист</span>
            <small>
              {documentPageSizeLabel(document)} · {document.palletId}
            </small>
          </div>
          <span className="warehouse-pallet-print-state state-idle" role="status">
            Системная печать
          </span>
        </div>

        <div className="warehouse-pallet-label-layout">
          <PalletLabelPreview
            liveResources={liveResources}
            previewUrl={previewUrl}
            previewPending={previewPending}
            previewError={previewError}
            layout={previewLayout}
            onReload={reload}
          />
          <div className="warehouse-pallet-label-controls">
            {!enabled && disabledReason && (
              <p className="warehouse-pallet-readiness">{disabledReason}</p>
            )}
            {systemPrintFeedback && (
              <p
                className={`warehouse-pallet-print-feedback is-${systemPrintFeedback.tone}`}
                role={systemPrintFeedback.tone === 'success' ? 'status' : 'alert'}
              >
                {systemPrintFeedback.message}
              </p>
            )}
            <label className="warehouse-pallet-reprint-field">
              <span>Причина повторной печати</span>
              <textarea
                aria-label="Причина повторной системной печати"
                rows={3}
                maxLength={MAX_REPRINT_REASON_LENGTH}
                value={reprintReason}
                disabled={systemPrintPending || systemPrintRetryReason !== null}
                onChange={(event) => setReprintReason(event.target.value)}
                placeholder="Например: этикетка повреждена при наклеивании"
              />
              <small>
                {systemPrintRetryReason
                  ? 'Причина зафиксирована до подтверждения запроса.'
                  : `От ${MIN_REPRINT_REASON_LENGTH} до ${MAX_REPRINT_REASON_LENGTH} символов · ${trimmedReason.length}`}
              </small>
            </label>
            <button
              type="button"
              className="warehouse-pallet-print-button action-recommended"
              aria-label="Открыть системную печать палетного листа"
              disabled={!canOpenSystemPrint}
              onClick={() => void openAuditedSystemReprint()}
            >
              <ix-icon name="print" size="16" />
              <span>
                {systemPrintPending
                  ? 'Открываем…'
                  : systemPrintRetryReason
                    ? 'Повторить запрос'
                    : 'Открыть системную печать'}
              </span>
            </button>
          </div>
        </div>
        {taskId && voidAllowed && canVoidPalletDocument(document) && (
          <>
            <button
              type="button"
              className="warehouse-pallet-void-button"
              aria-label={`Аннулировать палетный лист ${document.palletId}`}
              onClick={() => {
                setVoidFeedback(null);
                setVoidOpen(true);
              }}
            >
              Аннулировать палетный лист
            </button>
            {voidFeedback && (
              <p className="warehouse-pallet-print-error" role="status">
                {voidFeedback}
              </p>
            )}
            {voidOpen && (
              <VoidPalletDialog
                taskId={taskId}
                document={document}
                onClose={() => setVoidOpen(false)}
                onSuccess={() => {
                  setVoidOpen(false);
                  onWarehouseRefresh();
                }}
                onCanonicalRefresh={() => {
                  setVoidFeedback('Состояние палетного листа изменилось. Обновляем данные…');
                  onWarehouseRefresh();
                }}
              />
            )}
          </>
        )}
      </section>
    );
  }

  return (
    <section className="warehouse-pallet-label-panel" aria-label="Палетный лист">
      <div className="operator-panel-title warehouse-pallet-title">
        <div>
          <span>Палетный лист</span>
          <small>
            {documentPageSizeLabel(document)} · одна копия · {document.palletId}
          </small>
        </div>
        <span
          className={`warehouse-pallet-print-state state-${printPhase}`}
          role="status"
          aria-live="polite"
        >
          {printPhaseLabel(printPhase)}
        </span>
      </div>

      <div className="warehouse-pallet-label-layout">
        <PalletLabelPreview
          liveResources={liveResources}
          previewUrl={previewUrl}
          previewPending={previewPending}
          previewError={previewError}
          layout={previewLayout}
          onReload={reload}
        />

        <div className="warehouse-pallet-label-controls">
          <label className="warehouse-pallet-printer-field">
            <span>Принтер этикеток</span>
            <select
              value={selectedPrinterId ?? ''}
              disabled={!liveResources || printersPending || uncertainSubmission}
              onChange={(event) => selectPrinter(event.target.value)}
            >
              <option value="">Выберите принтер</option>
              {printers.map((printer) => (
                <option key={printer.id} value={printer.id} disabled={!printer.ready}>
                  {printer.label} · {printer.post.name} · {warehousePrinterStatusLabel(printer)}
                </option>
              ))}
            </select>
            <small>
              {selectedPrinter
                ? `${selectedPrinter.post.name} · ${warehousePrinterStatusLabel(selectedPrinter)}`
                : readyPrinters.length > 1
                  ? 'Доступно несколько устройств — выбор обязателен.'
                  : 'Печать выполняется на выбранном складском принтере.'}
            </small>
          </label>

          {printers.some((printer) => !printer.ready) && (
            <details className="warehouse-pallet-offline-printers">
              <summary>
                Недоступные принтеры: {printers.filter((printer) => !printer.ready).length}
              </summary>
              <ul className="warehouse-pallet-printer-statuses" aria-label="Недоступные принтеры">
                {printers
                  .filter((printer) => !printer.ready)
                  .map((printer) => (
                    <li key={printer.id}>
                      <strong>{printer.label}</strong>
                      <span>{warehousePrinterStatusLabel(printer)}</span>
                    </li>
                  ))}
              </ul>
            </details>
          )}

          {readinessMessage && <p className="warehouse-pallet-readiness">{readinessMessage}</p>}
          {printError && (
            <p className="warehouse-pallet-print-error" role="alert">
              {printError}
            </p>
          )}

          <button
            type="button"
            className="warehouse-pallet-print-button action-recommended"
            disabled={!canRunPrimaryAction}
            onClick={startPrint}
          >
            <ix-icon name={uncertainSubmission ? 'refresh' : 'print'} size="16" />
            <span>
              {printPending
                ? 'Задание в очереди'
                : uncertainSubmission
                  ? 'Проверить статус'
                  : submitted
                    ? 'Повторная печать'
                    : 'Печать палетного листа'}
            </span>
          </button>

          <div className="warehouse-pallet-export-toolbar" aria-label="Скачать палетный лист">
            {(document.availableFormats ?? ['word', 'excel', 'pdf']).map((format) => (
              <button
                key={format}
                type="button"
                className={`warehouse-pallet-export-button format-${format}`}
                disabled={!liveResources || !previewUrl || exportPending !== null}
                onClick={() => void download(format)}
              >
                <ix-icon
                  name={
                    format === 'excel'
                      ? 'table-tag'
                      : format === 'pdf'
                        ? 'print'
                        : 'app-document-filled'
                  }
                  size="16"
                />
                <span>{exportPending === format ? 'Готовим…' : EXPORT_LABELS[format]}</span>
              </button>
            ))}
          </div>
          {exportError && (
            <p className="warehouse-pallet-print-error" role="alert">
              {exportError}
            </p>
          )}
        </div>
      </div>

      {reprintOpen && (
        <PlenkiModal
          eyebrow="Склад · контроль перепечатки"
          title="Повторная печать палетного листа"
          onClose={() => {
            if (!printPending) setReprintOpen(false);
          }}
          className="warehouse-pallet-reprint-dialog"
          footer={
            <>
              <button
                type="button"
                className="action-secondary"
                disabled={printPending}
                onClick={() => setReprintOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="action-recommended"
                disabled={!uncertainSubmission && (!canPrint || !validReprintReason)}
                onClick={() => {
                  if (uncertainSubmission) {
                    refreshUncertainStatus();
                    return;
                  }
                  void submitPrint(trimmedReason);
                }}
              >
                {printPending
                  ? 'Задание в очереди'
                  : uncertainSubmission
                    ? 'Проверить статус'
                    : 'Напечатать повторно'}
              </button>
            </>
          }
        >
          <label className="warehouse-pallet-reprint-field">
            <span>Причина повторной печати</span>
            <textarea
              autoFocus
              rows={4}
              maxLength={MAX_REPRINT_REASON_LENGTH}
              value={reprintReason}
              disabled={printPending || uncertainSubmission}
              onChange={(event) => setReprintReason(event.target.value)}
              placeholder="Например: этикетка повреждена при наклеивании"
            />
            <small>
              От {MIN_REPRINT_REASON_LENGTH} до {MAX_REPRINT_REASON_LENGTH} символов ·{' '}
              {trimmedReason.length}
            </small>
          </label>
          {printError && (
            <p className="warehouse-pallet-print-error" role="alert">
              {printError}
            </p>
          )}
        </PlenkiModal>
      )}
      {taskId && voidAllowed && canVoidPalletDocument(document) && (
        <>
          <button
            type="button"
            className="warehouse-pallet-void-button"
            aria-label={`Аннулировать палетный лист ${document.palletId}`}
            onClick={() => {
              setVoidFeedback(null);
              setVoidOpen(true);
            }}
          >
            Аннулировать палетный лист
          </button>
          {voidFeedback && (
            <p className="warehouse-pallet-print-error" role="status">
              {voidFeedback}
            </p>
          )}
          {voidOpen && (
            <VoidPalletDialog
              taskId={taskId}
              document={document}
              onClose={() => setVoidOpen(false)}
              onSuccess={() => {
                setVoidOpen(false);
                onWarehouseRefresh();
              }}
              onCanonicalRefresh={() => {
                setVoidFeedback('Состояние палетного листа изменилось. Обновляем данные…');
                onWarehouseRefresh();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
