import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import { scannerAsciiFromPhysicalKey } from '../../domain/hidScannerKeyboard';
import type { WarehouseWorkbench, WorkObject } from '../../domain/types';
import {
  WarehouseScanSubmissionGate,
  warehouseObjectMatchesScanSection,
  warehouseScanMode,
} from '../../domain/warehouseScan';
import {
  PlenkiDataTable,
  PlenkiToolbar,
  type PlenkiDataTableColumn,
} from '../plenki-ui/PlenkiPrimitives';
import { WarehouseWorkbenchView } from './warehouseWorkbench';

type WarehouseScanMode = WarehouseWorkbench['mode'];

const RETRYABLE_SCAN_ERROR = 'Скан не отправлен. Проверьте связь и повторите Enter.';

type WarehouseScanRow = {
  object: WorkObject;
  id: string;
  title: string;
  status: string;
  mode: WarehouseScanMode;
  expected: number;
  scanned: number;
  missing: number;
  excess: number;
  lastScan: string;
  blocker: string;
  tone: WorkObject['severity'];
};

function scanRows(objects: WorkObject[], section: string): WarehouseScanRow[] {
  const mode = warehouseScanMode(section);
  return objects
    .filter((object) => warehouseObjectMatchesScanSection(object, section))
    .map((object) => {
      const workbench = object.workbench as WarehouseWorkbench;
      const progressTotal =
        workbench.mode === 'receiving'
          ? Math.max(workbench.plannedRollCount ?? workbench.expected, workbench.scanned)
          : workbench.expected;
      const missing = Math.max(0, progressTotal - workbench.scanned);
      const excess = workbench.excess.length;
      return {
        object,
        id: object.id,
        title: object.title,
        status: object.statusLabel,
        mode: workbench.mode,
        expected: progressTotal,
        scanned: workbench.scanned,
        missing,
        excess,
        lastScan: workbench.lastScan || 'нет сканов',
        blocker:
          workbench.blockingReason ??
          object.problems.find((problem) => problem.status === 'open')?.title ??
          'Нет',
        tone: object.severity,
      };
    });
}

function rowTone(row: WarehouseScanRow) {
  if (row.tone === 'critical' || row.excess > 0) return 'critical';
  if (row.tone === 'warning' || row.missing > 0 || row.blocker !== 'Нет') return 'warning';
  return 'info';
}

function modeLabel(mode: WarehouseScanMode) {
  return mode === 'delivery' ? 'Выдача' : 'Приемка';
}

function operationDisplayTitle(row: WarehouseScanRow) {
  const prefix = modeLabel(row.mode);
  return row.title.replace(new RegExp(`^${prefix}\\s+`, 'iu'), '') || row.title;
}

function rowHasIssue(row: WarehouseScanRow) {
  const issueText = `${row.status} ${row.lastScan} ${row.blocker}`.toLowerCase();
  return (
    row.excess > 0 ||
    row.tone === 'critical' ||
    /чуж|дубликат|ошиб|брак|вне допуска|отклон/.test(issueText)
  );
}

export function WarehouseScanStationSurface({
  objects,
  activeSection,
  selectedObjectId,
  onSelectObject,
  onAction,
  onScanPayload,
  onPalletScanPayload,
  onClearSelection,
  onWarehouseRefresh,
  liveCoverageEnabled,
}: {
  objects: WorkObject[];
  activeSection: string;
  selectedObjectId?: string | null;
  onSelectObject: (objectId: string) => void;
  onAction?: (actionId: string, objectId: string) => void;
  onScanPayload?: (payload: string) => Promise<boolean>;
  onPalletScanPayload?: (taskId: string, payload: string) => Promise<boolean>;
  onClearSelection?: () => void;
  onWarehouseRefresh: () => void;
  liveCoverageEnabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [scanPayload, setScanPayload] = useState('');
  const [scanPendingCount, setScanPendingCount] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [palletFormationActive, setPalletFormationActive] = useState(false);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const scanPayloadRef = useRef('');
  const scanGateRef = useRef(new WarehouseScanSubmissionGate());
  const rows = useMemo(() => scanRows(objects, activeSection), [activeSection, objects]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = normalizedQuery
    ? rows.filter((row) =>
        [row.id, row.title, row.status, row.lastScan, row.blocker]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : rows;
  const selectedRow = selectedObjectId
    ? rows.find((row) => row.id === selectedObjectId)
    : undefined;
  const selectedWorkbench =
    selectedRow?.object.workbench?.type === 'warehouse' ? selectedRow.object.workbench : null;
  const palletTaskId =
    selectedWorkbench?.mode === 'receiving' && !selectedWorkbench.taskClosed
      ? (selectedWorkbench.taskId ?? null)
      : null;
  const submitPayload =
    palletFormationActive && palletTaskId && onPalletScanPayload
      ? (payload: string) => onPalletScanPayload(palletTaskId, payload)
      : palletFormationActive
        ? undefined
        : onScanPayload;
  const palletModeDisabledReason = !onPalletScanPayload
    ? 'Формирование палеты недоступно без серверного обработчика.'
    : selectedWorkbench?.accepted.length === 0
      ? 'Сначала примите хотя бы один рулон.'
      : undefined;
  const expectedTotal = rows.reduce((sum, row) => sum + row.expected, 0);
  const scannedTotal = rows.reduce((sum, row) => sum + row.scanned, 0);
  const missingTotal = rows.reduce((sum, row) => sum + row.missing, 0);
  const issueCount = rows.filter(rowHasIssue).length;
  const scanPending = scanPendingCount > 0;
  const scanSubmitDisabledReason = !submitPayload
    ? 'Сканирование недоступно без серверного обработчика.'
    : undefined;

  const focusScanner = useCallback(() => {
    scanInputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    focusScanner();
  }, [activeSection, focusScanner]);

  useEffect(() => {
    setPalletFormationActive(false);
  }, [activeSection, palletTaskId, selectedObjectId]);

  function replaceScanPayload(payload: string) {
    scanPayloadRef.current = payload;
    if (scanInputRef.current) scanInputRef.current.value = payload;
    setScanPayload(payload);
  }

  function togglePalletFormation() {
    setPalletFormationActive((active) => !active);
    replaceScanPayload('');
    setScanError(null);
    if (typeof window !== 'undefined') window.requestAnimationFrame(focusScanner);
  }

  function selectScanRow(row: WarehouseScanRow) {
    onSelectObject(row.id);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => scanInputRef.current?.focus({ preventScroll: true }));
    }
  }

  async function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = scanPayloadRef.current.trim();
    if (!payload || !submitPayload) return;
    replaceScanPayload('');
    setScanPendingCount((count) => count + 1);
    setScanError(null);
    try {
      const processed = await scanGateRef.current.run(payload, submitPayload);
      if (!processed) {
        if (!scanPayloadRef.current) replaceScanPayload(payload);
        setScanError('Скан не обработан. Проверьте код и повторите Enter.');
      }
    } catch {
      if (!scanPayloadRef.current) replaceScanPayload(payload);
      setScanError(RETRYABLE_SCAN_ERROR);
    } finally {
      setScanPendingCount((count) => Math.max(0, count - 1));
      if (typeof window !== 'undefined') window.requestAnimationFrame(focusScanner);
    }
  }

  function captureScannerKey(event: KeyboardEvent<HTMLInputElement>) {
    const character = scannerAsciiFromPhysicalKey(event);
    if (character === null) return;
    event.preventDefault();
    scanPayloadRef.current += character;
    event.currentTarget.value = scanPayloadRef.current;
  }

  const columns: Array<PlenkiDataTableColumn<WarehouseScanRow>> = [
    {
      id: 'operation',
      header: 'Операция',
      dataLabel: 'Операция',
      width: '46%',
      render: (row) => (
        <>
          <strong>{operationDisplayTitle(row)}</strong>
          <small>{modeLabel(row.mode)}</small>
        </>
      ),
    },
    {
      id: 'progress',
      header: 'Прогресс',
      dataLabel: 'Прогресс',
      width: '20%',
      render: (row) => (
        <>
          <strong>
            {row.scanned}/{row.expected}
          </strong>
          <small>{row.missing > 0 ? `${row.missing} осталось` : 'закрыто'}</small>
        </>
      ),
    },
    {
      id: 'status',
      header: 'Статус',
      dataLabel: 'Статус',
      width: '34%',
      render: (row) => (
        <>
          <strong>{row.status}</strong>
          {row.excess > 0 && <small>{row.excess} ошибка</small>}
        </>
      ),
    },
  ];

  return (
    <section
      className="warehouse-scan-station-page"
      aria-label={`${activeSection}: складской скан`}
      data-warehouse-mode={warehouseScanMode(activeSection)}
    >
      <section className="warehouse-command-strip" aria-label="Ключевая информация склада">
        <div className="warehouse-command-title">
          <span className="eyebrow">Склад</span>
          <h2>{activeSection}</h2>
        </div>
        <div className="warehouse-command-facts" aria-label="Счетчики склада">
          <div>
            <span>Операции</span>
            <strong>{rows.length}</strong>
          </div>
          <div>
            <span>Осталось QR</span>
            <strong>{missingTotal}</strong>
          </div>
          <div className={issueCount > 0 ? 'severity-critical' : ''}>
            <span>Ошибки</span>
            <strong>{issueCount}</strong>
          </div>
        </div>
        <div className="warehouse-command-actions" aria-label="Быстрые действия склада">
          {palletTaskId && (
            <div
              className={`warehouse-pallet-scan-mode${palletFormationActive ? ' is-active' : ''}`}
            >
              <button
                className="warehouse-pallet-scan-mode-toggle"
                type="button"
                aria-pressed={palletFormationActive}
                disabled={!palletFormationActive && Boolean(palletModeDisabledReason)}
                title={!palletFormationActive ? palletModeDisabledReason : undefined}
                aria-label={
                  !palletFormationActive && palletModeDisabledReason
                    ? `Начать формирование палеты недоступно. ${palletModeDisabledReason}`
                    : undefined
                }
                onClick={togglePalletFormation}
              >
                {palletFormationActive ? 'Вернуться к приёмке' : 'Начать формирование палеты'}
              </button>
              {!palletFormationActive && palletModeDisabledReason && (
                <small>{palletModeDisabledReason}</small>
              )}
              {palletFormationActive && (
                <p className="warehouse-pallet-scan-mode-status" role="status">
                  <strong>
                    {selectedWorkbench?.activePallet?.palletCode ?? selectedRow?.title} ·{' '}
                    {selectedWorkbench?.activePallet?.rollCount ?? 0} рул.
                  </strong>
                  <span>Повторный скан не удаляет рулон</span>
                </p>
              )}
            </div>
          )}
          <form className="warehouse-scan-input-form" onSubmit={submitScan}>
            <label>
              <span>{palletFormationActive ? 'QR в палетный лист' : 'Сканирование QR'}</span>
              <input
                ref={scanInputRef}
                value={scanPayload}
                disabled={!submitPayload}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="done"
                required
                aria-label={palletFormationActive ? 'QR в палетный лист' : 'Сканирование QR'}
                placeholder="Сканируйте или вставьте QR"
                onChange={(event) => replaceScanPayload(event.target.value)}
                onKeyDown={captureScannerKey}
              />
            </label>
            <button
              type="submit"
              disabled={Boolean(scanSubmitDisabledReason)}
              title={scanSubmitDisabledReason}
              aria-label={
                scanSubmitDisabledReason
                  ? `Принять QR недоступно. ${scanSubmitDisabledReason}`
                  : palletFormationActive
                    ? 'Добавить QR в палетный лист'
                    : 'Принять QR'
              }
            >
              {scanPending ? 'Проверяем…' : palletFormationActive ? 'Добавить QR' : 'Принять QR'}
            </button>
            {scanError && <small role="alert">{scanError}</small>}
          </form>
        </div>
      </section>

      <div className="warehouse-scan-station-layout">
        <section className="warehouse-scan-station-table" aria-label="Очередь складского скана">
          <PlenkiToolbar
            searchValue={query}
            searchPlaceholder="Поиск по операции, QR, статусу"
            onSearchChange={setQuery}
            meta={normalizedQuery ? <span>Найдено: {visibleRows.length}</span> : undefined}
          />
          <div className="warehouse-scan-queue-scroll">
            <PlenkiDataTable
              caption={`${activeSection}: таблица операций`}
              columns={columns}
              rows={visibleRows}
              tableClassName="warehouse-scan-station-data-table"
              getRowKey={(row) => row.id}
              getRowClassName={(row) => `severity-${rowTone(row)}`}
              isRowSelected={(row) => row.id === selectedRow?.id}
              onRowClick={selectScanRow}
            />
          </div>
        </section>

        <section
          className="warehouse-scan-station-detail"
          aria-label="Выбранная складская операция"
        >
          {selectedRow && selectedWorkbench ? (
            <WarehouseWorkbenchView
              workbench={selectedWorkbench}
              actions={selectedRow.object.actions}
              selectedOperation={{
                id: selectedRow.id,
                title: selectedRow.title,
                status: selectedRow.status,
                mode: modeLabel(selectedRow.mode),
                counter: `${selectedRow.scanned}/${selectedRow.expected}`,
              }}
              showScanAction={false}
              showReturnAction={!onScanPayload}
              history={selectedRow.object.audit}
              onClose={onClearSelection}
              onAction={(actionId) => onAction?.(actionId, selectedRow.id)}
              onManualLookup={(_, payload) => void onScanPayload?.(payload)}
              onWarehouseRefresh={onWarehouseRefresh}
              coverageDecisionTaskId={selectedWorkbench.coverageDecisionTaskId}
              liveCoverageEnabled={liveCoverageEnabled}
            />
          ) : (
            <div className="plenki-empty-state">
              <strong>Выберите заказ или отсканируйте QR</strong>
              <span>
                {rows.length === 0
                  ? 'В этом разделе пока нет операций.'
                  : 'Откройте заказ слева или считайте QR сканером.'}
              </span>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
