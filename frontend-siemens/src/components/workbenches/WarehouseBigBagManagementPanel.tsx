import { useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchWarehouseBigBagLabelPreview,
  fetchWarehouseBigBags,
  moveWarehouseBigBag,
  recordWarehouseBigBagSystemPrintIntent,
  type WarehouseBigBag,
  type WarehouseBigBagMoveInput,
  type WarehouseBigBagMovementResult,
  type WarehouseBigBagPrintResult,
  type WarehouseBigBagSystemPrintInput,
} from '../../api/warehouseBigBags';
import { IdempotentOperationGate } from '../../api/idempotentOperation';
import { warehouseRequestErrorMessage } from './warehousePalletResources';
import {
  openWarehouseBigBagSystemPrint,
  WarehouseSystemPrintContinuationError,
  WarehouseSystemPrintIntentGate,
} from './warehouseBrowserPrint';

type MovementMode = 'registration' | 'to_production' | 'to_warehouse';

export type WarehouseBigBagDependencies = {
  loadBags(): Promise<WarehouseBigBag[]>;
  moveBag(input: WarehouseBigBagMoveInput): Promise<WarehouseBigBagMovementResult>;
  loadLabelPreview(bigBagId: string): Promise<Blob>;
  recordSystemPrintIntent(
    bigBagId: string,
    input: WarehouseBigBagSystemPrintInput,
  ): Promise<WarehouseBigBagPrintResult>;
  openSystemPrint(preview: Blob): Promise<void>;
};

const defaultDependencies: WarehouseBigBagDependencies = {
  loadBags: fetchWarehouseBigBags,
  moveBag: moveWarehouseBigBag,
  loadLabelPreview: fetchWarehouseBigBagLabelPreview,
  recordSystemPrintIntent: recordWarehouseBigBagSystemPrintIntent,
  openSystemPrint: openWarehouseBigBagSystemPrint,
};

function formatKg(value: number | null): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 3,
  }).format(value)} кг`;
}

function formatMoney(kopecks: number | null): string {
  if (kopecks === null) return 'Цена не указана';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: kopecks % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(kopecks / 100);
}

function formatUnitPrice(kopecks: number | null): string {
  return kopecks === null ? 'Цена не указана' : `${formatMoney(kopecks)}/кг`;
}

function locationLabel(bag: WarehouseBigBag): string {
  if (bag.registrationStatus === 'pending_scan') return 'Ожидает первого сканирования';
  return bag.location === 'warehouse' ? 'На складе' : 'В производстве';
}

function movementLabel(result: WarehouseBigBagMovementResult): string {
  if (result.movement.kind === 'registration') return 'Big-Bag зарегистрирован на складе';
  if (result.movement.kind === 'to_production') return 'Передан в производство';
  return 'Возвращён на склад';
}

function printStatusLabel(result: WarehouseBigBagPrintResult): string {
  if (result.status === 'intent_recorded') return 'Открыта системная печать';
  if (result.status === 'submitted') return 'Передано принтеру';
  if (result.status === 'queued') return 'Печать поставлена в очередь';
  if (result.status === 'uncertain') {
    return 'Результат печати не подтверждён — проверьте этикетку';
  }
  return 'Печать не выполнена';
}

function isCurrentBag(bag: WarehouseBigBag): boolean {
  return (
    bag.status === 'in_use' ||
    (bag.status === 'available' && (bag.currentKg === null || bag.currentKg > 0))
  );
}

function upsertBag(current: readonly WarehouseBigBag[], next: WarehouseBigBag): WarehouseBigBag[] {
  if (!isCurrentBag(next)) {
    return current.filter((bag) => bag.id !== next.id);
  }
  const existing = current.findIndex((bag) => bag.id === next.id);
  if (existing < 0)
    return [...current, next].sort((left, right) => left.code.localeCompare(right.code, 'ru-RU'));
  return current.map((bag) => (bag.id === next.id ? next : bag));
}

export function WarehouseBigBagManagementPanel({
  refreshRevision = 0,
  dependencies = defaultDependencies,
}: {
  refreshRevision?: number;
  dependencies?: WarehouseBigBagDependencies;
}) {
  const [bags, setBags] = useState<WarehouseBigBag[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [selectedBagId, setSelectedBagId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState('');
  const [movementMode, setMovementMode] = useState<MovementMode>('registration');
  const [warehouseWeightDraft, setWarehouseWeightDraft] = useState('');
  const [movementBusy, setMovementBusy] = useState(false);
  const [movementError, setMovementError] = useState<string | null>(null);
  const [movementResult, setMovementResult] = useState<WarehouseBigBagMovementResult | null>(null);
  const [printReason, setPrintReason] = useState('');
  const [printRetryReason, setPrintRetryReason] = useState<string | null>(null);
  const [printBusy, setPrintBusy] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [printResults, setPrintResults] = useState<Record<string, WarehouseBigBagPrintResult>>({});
  const movementGate = useRef(new IdempotentOperationGate());
  const printGate = useRef(new WarehouseSystemPrintIntentGate());
  const printPendingRef = useRef(false);
  const printGenerationRef = useRef(0);
  const qrInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void dependencies
      .loadBags()
      .then((nextBags) => {
        if (cancelled) return;
        setBags(nextBags);
        setSelectedBagId((current) =>
          current && nextBags.some((bag) => bag.id === current)
            ? current
            : (nextBags[0]?.id ?? null),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(warehouseRequestErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dependencies, refreshRevision, reloadRevision]);

  useEffect(() => {
    printGenerationRef.current += 1;
    printGate.current.reset();
    printPendingRef.current = false;
    setPrintRetryReason(null);
    setPrintBusy(false);
  }, [selectedBagId]);

  const selectedBag = bags.find((candidate) => candidate.id === selectedBagId) ?? null;
  const selectedPrintResult = selectedBag
    ? (printResults[selectedBag.id] ?? selectedBag.latestLabelPrint)
    : null;
  const isReprint =
    selectedPrintResult?.status === 'submitted' ||
    selectedPrintResult?.status === 'intent_recorded';
  const printUncertain = selectedPrintResult?.status === 'uncertain';
  const printRetryPending = printRetryReason !== null;
  const normalizedQuery = query.trim().normalize('NFKC').toLocaleLowerCase('ru-RU');
  const visibleBags = useMemo(
    () =>
      normalizedQuery.length === 0
        ? bags
        : bags.filter((bag) =>
            `${bag.code} ${bag.material}`
              .normalize('NFKC')
              .toLocaleLowerCase('ru-RU')
              .includes(normalizedQuery),
          ),
    [bags, normalizedQuery],
  );
  const warehouseWeightKg = Number(warehouseWeightDraft.trim().replace(',', '.'));
  const warehouseWeightValid =
    warehouseWeightDraft.trim().length > 0 &&
    Number.isFinite(warehouseWeightKg) &&
    warehouseWeightKg >= 0;
  const qrValid = /^bbt_[0-9a-f]{64}$/u.test(qrCode.trim());
  const movementValid = qrValid && (movementMode !== 'to_warehouse' || warehouseWeightValid);
  const printValid =
    selectedBag !== null &&
    !movementBusy &&
    !printUncertain &&
    (printRetryPending || !isReprint || printReason.trim().length >= 3);
  const total = bags.length;
  const warehouseCount = bags.filter(
    (bag) => bag.registrationStatus === 'registered' && bag.location === 'warehouse',
  ).length;
  const productionCount = bags.filter(
    (bag) => bag.registrationStatus === 'registered' && bag.location === 'production',
  ).length;
  const pendingCount = bags.filter((bag) => bag.registrationStatus === 'pending_scan').length;

  function submitMovement() {
    if (!movementValid || movementBusy || printBusy || printRetryPending) return;
    const normalizedQr = qrCode.trim();
    const destination = movementMode === 'to_production' ? 'production' : 'warehouse';
    const intent = [
      movementMode,
      normalizedQr,
      movementMode === 'to_warehouse' ? warehouseWeightKg : '',
    ].join(':');
    const request = movementGate.current.start(
      intent,
      (operationKey) =>
        dependencies.moveBag({
          operationKey,
          qrCode: normalizedQr,
          destination,
          ...(movementMode === 'to_warehouse' ? { warehouseWeightKg } : {}),
        }),
      'warehouse-big-bag-movement',
    );
    if (!request) return;
    setMovementBusy(true);
    setMovementError(null);
    setMovementResult(null);
    void request
      .then((result) => {
        setBags((current) => upsertBag(current, result.bag));
        setSelectedBagId(isCurrentBag(result.bag) ? result.bag.id : null);
        setMovementResult(result);
        setQrCode('');
        setWarehouseWeightDraft('');
        qrInputRef.current?.focus();
      })
      .catch((error: unknown) => {
        setMovementError(warehouseRequestErrorMessage(error));
      })
      .finally(() => setMovementBusy(false));
  }

  function submitPrint() {
    if (!selectedBag || !printValid || printBusy || printPendingRef.current) return;
    const bigBagId = selectedBag.id;
    const reason = printRetryReason ?? printReason.replace(/\s+/gu, ' ').trim();
    const generation = printGenerationRef.current;
    printPendingRef.current = true;
    setPrintBusy(true);
    setPrintError(null);
    const request = printGate.current.run(async (requestId) => {
      const preview = await dependencies.loadLabelPreview(bigBagId);
      const result = await dependencies.recordSystemPrintIntent(bigBagId, {
        requestId,
        ...(reason.length > 0 ? { reason } : {}),
      });
      try {
        await dependencies.openSystemPrint(preview);
      } catch (error) {
        throw new WarehouseSystemPrintContinuationError(error);
      }
      return result;
    }, `${bigBagId}:${reason}`);
    void request
      .then((result) => {
        if (printGenerationRef.current !== generation) return;
        setPrintResults((current) => ({
          ...current,
          [result.bigBagId]: result,
        }));
        setPrintReason('');
        setPrintRetryReason(null);
      })
      .catch((error: unknown) => {
        if (printGenerationRef.current !== generation) return;
        if (printGate.current.hasPendingRetry()) {
          setPrintReason(reason);
          setPrintRetryReason(reason);
        } else {
          setPrintRetryReason(null);
        }
        setPrintError(warehouseRequestErrorMessage(error));
      })
      .finally(() => {
        if (printGenerationRef.current !== generation) return;
        printPendingRef.current = false;
        setPrintBusy(false);
      });
  }

  return (
    <section className="warehouse-bigbag-management" aria-label="Учет и перемещение Big-Bag">
      <header className="warehouse-bigbag-management-header">
        <div>
          <span className="eyebrow">СЫРЬЁ · QR-КОНТРОЛЬ</span>
          <h2>Учет Big-Bag</h2>
          <p>Первый скан регистрирует мешок. Передача и возврат всегда выбираются явно.</p>
        </div>
        <button
          type="button"
          className="action-secondary"
          disabled={loading}
          onClick={() => setReloadRevision((current) => current + 1)}
        >
          Обновить
        </button>
      </header>

      <div className="warehouse-bigbag-metrics" aria-label="Сводка Big-Bag">
        <span>
          <strong>Всего {total}</strong>
        </span>
        <span>На складе {warehouseCount}</span>
        <span>В производстве {productionCount}</span>
        <span>Ждут регистрации {pendingCount}</span>
      </div>

      {loadError ? (
        <div className="warehouse-bigbag-message is-error" role="alert">
          {loadError}
        </div>
      ) : null}

      <div className="warehouse-bigbag-workspace">
        <div className="warehouse-bigbag-list-pane">
          <label>
            <span>Найти Big-Bag</span>
            <input
              type="search"
              value={query}
              placeholder="Код или вид сырья"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          {loading ? <p role="status">Загружаем Big-Bag…</p> : null}
          {!loading && visibleBags.length === 0 ? (
            <p className="warehouse-bigbag-empty">Big-Bag не найдены.</p>
          ) : null}
          <div className="warehouse-bigbag-list" role="list">
            {visibleBags.map((bag) => (
              <button
                key={bag.id}
                type="button"
                role="listitem"
                className={bag.id === selectedBagId ? 'is-selected' : ''}
                aria-pressed={bag.id === selectedBagId}
                disabled={printBusy || printRetryPending}
                onClick={() => {
                  setSelectedBagId(bag.id);
                  setPrintReason('');
                  setPrintError(null);
                }}
              >
                <span>
                  <strong>{bag.code}</strong>
                  <small>{bag.material}</small>
                  <small>{formatUnitPrice(bag.priceKopecksPerKg)}</small>
                </span>
                <span>
                  <small>{locationLabel(bag)}</small>
                  <strong>{formatKg(bag.currentKg)}</strong>
                  <small>{formatMoney(bag.totalKopecks)}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="warehouse-bigbag-actions-pane">
          <section className="warehouse-bigbag-action-card">
            <header>
              <h3>Сканирование QR</h3>
              <span>Сканер работает как ввод с клавиатуры</span>
            </header>
            <label>
              <span>Операция</span>
              <select
                aria-label="Операция с Big-Bag"
                value={movementMode}
                disabled={movementBusy}
                onChange={(event) => {
                  setMovementMode(event.currentTarget.value as MovementMode);
                  setMovementError(null);
                  setMovementResult(null);
                }}
              >
                <option value="registration">Первичная регистрация на складе</option>
                <option value="to_production">Передать в производство</option>
                <option value="to_warehouse">Вернуть на склад</option>
              </select>
            </label>
            <label>
              <span>QR-код</span>
              <input
                ref={qrInputRef}
                aria-label="QR-код Big-Bag"
                autoComplete="off"
                value={qrCode}
                disabled={movementBusy}
                placeholder="Отсканируйте этикетку"
                onChange={(event) => {
                  setQrCode(event.currentTarget.value);
                  setMovementError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  submitMovement();
                }}
              />
            </label>
            {movementMode === 'to_warehouse' ? (
              <label>
                <span>Контрольный вес склада, кг</span>
                <input
                  aria-label="Контрольный вес склада, кг"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.001"
                  value={warehouseWeightDraft}
                  disabled={movementBusy}
                  onChange={(event) => {
                    setWarehouseWeightDraft(event.currentTarget.value);
                    setMovementError(null);
                  }}
                />
              </label>
            ) : null}
            <button
              type="button"
              className="action-recommended"
              disabled={!movementValid || movementBusy}
              aria-busy={movementBusy}
              onClick={submitMovement}
            >
              {movementBusy ? 'Проверяем…' : 'Подтвердить сканирование'}
            </button>
            {movementError ? (
              <div className="warehouse-bigbag-message is-error" role="alert">
                {movementError}
              </div>
            ) : null}
            {movementResult ? (
              <div className="warehouse-bigbag-message is-success" role="status">
                <strong>{movementLabel(movementResult)}</strong>
                {movementResult.weightComparison ? (
                  <span>
                    Оператор: {formatKg(movementResult.weightComparison.operatorReportedKg)}
                    {' · '}Склад: {formatKg(movementResult.weightComparison.warehouseMeasuredKg)}
                    {' · '}Разница: {formatKg(movementResult.weightComparison.differenceKg)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="warehouse-bigbag-action-card">
            <header>
              <h3>QR-этикетка</h3>
              <span>
                {selectedBag
                  ? `${selectedBag.code} · ${selectedBag.material}`
                  : 'Выберите Big-Bag слева'}
              </span>
            </header>
            <p>Этикетка откроется в системном окне печати этого складского компьютера.</p>
            <label>
              <span>Причина повторной печати</span>
              <input
                value={printReason}
                maxLength={500}
                disabled={printBusy || printUncertain || printRetryPending}
                placeholder="Заполните только для повторной печати"
                onChange={(event) => {
                  setPrintReason(event.currentTarget.value);
                  setPrintError(null);
                }}
              />
              {printRetryPending ? <small>Причина зафиксирована до открытия печати.</small> : null}
            </label>
            <button
              type="button"
              className="action-recommended"
              disabled={!printValid || printBusy}
              aria-busy={printBusy}
              onClick={submitPrint}
            >
              {printBusy
                ? 'Открываем…'
                : printRetryPending
                  ? 'Повторить запрос'
                  : isReprint
                    ? 'Повторить печать'
                    : 'Печать QR-этикетки'}
            </button>
            {printError ? (
              <div className="warehouse-bigbag-message is-error" role="alert">
                {printError}
              </div>
            ) : null}
            {selectedPrintResult ? (
              <div
                className={`warehouse-bigbag-message ${
                  selectedPrintResult.status === 'submitted' ||
                  selectedPrintResult.status === 'intent_recorded'
                    ? 'is-success'
                    : 'is-warning'
                }`}
                role="status"
              >
                {printStatusLabel(selectedPrintResult)}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </section>
  );
}
