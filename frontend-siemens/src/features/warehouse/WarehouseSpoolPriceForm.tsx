import { useEffect, useId, useRef, useState } from 'react';

import { ApiError, type ApiRequestOptions } from '../../api/client';
import { createOperationKey } from '../../api/idempotentOperation';
import {
  fetchWarehouseSpoolPriceTypes,
  parseMetersToMillimeters,
  recordWarehouseSpoolReceipt,
  type RecordSpoolStockReceiptInput,
  type SpoolStockReceiptView,
  type SpoolStockSummaryItem,
  type WarehouseSpoolPriceType,
} from '../../api/warehouseSpoolPrice';
import { SpoolStockSummary } from './SpoolStockSummary';

type PriceDraft = {
  spoolTypeLabel: string;
  priceRubles: string;
  quantityMeters: string;
  effectiveDate: string;
};

type PendingCommand = {
  fingerprint: string;
  operationKey: string;
};

const INITIAL_DRAFT: PriceDraft = {
  spoolTypeLabel: '',
  priceRubles: '',
  quantityMeters: '',
  effectiveDate: '',
};

const PRICEABLE_SPOOL_TYPE_LABELS = ['Тонкая', 'Толстая'] as const;

const PRICE_FORMAT = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const METER_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

function priceableSpoolTypes(items: WarehouseSpoolPriceType[]): WarehouseSpoolPriceType[] {
  const itemsByLabel = new Map(items.map((item) => [item.label, item]));
  return PRICEABLE_SPOOL_TYPE_LABELS.flatMap((label) => {
    const item = itemsByLabel.get(label);
    return item ? [item] : [];
  });
}

export function parseRublesToKopecks(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/u);
  if (!match) return null;
  const rubles = Number(match[1]);
  const kopecks = Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(rubles) || !Number.isSafeInteger(kopecks)) return null;
  const amount = rubles * 100 + kopecks;
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function effectiveFrom(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return date.toISOString();
}

function commandFromDraft(draft: PriceDraft) {
  const priceKopecksPerMeter = parseRublesToKopecks(draft.priceRubles);
  const quantityMillimeters = parseMetersToMillimeters(draft.quantityMeters);
  const effective = effectiveFrom(draft.effectiveDate);
  if (
    !draft.spoolTypeLabel ||
    priceKopecksPerMeter === null ||
    quantityMillimeters === null ||
    !effective
  ) {
    return null;
  }
  return {
    spoolTypeLabel: draft.spoolTypeLabel,
    priceKopecksPerMeter,
    quantityMillimeters,
    source: 'Прайс склада',
    effectiveFrom: effective,
    reason: 'Цена и приход шпули записаны складом',
  };
}

function saveError(cause: unknown) {
  if (cause instanceof ApiError && cause.status === 409) {
    return /[А-ЯЁа-яё]/u.test(cause.message)
      ? cause.message
      : 'Цена конфликтует с уже зарегистрированной записью.';
  }
  return 'Не удалось сохранить цену и приход. Повторите попытку.';
}

export function WarehouseSpoolPriceForm({
  loadTypes = fetchWarehouseSpoolPriceTypes,
  saveReceipt = recordWarehouseSpoolReceipt,
  loadStock,
  createKey = createOperationKey,
}: {
  loadTypes?: (options?: ApiRequestOptions) => Promise<WarehouseSpoolPriceType[]>;
  saveReceipt?: (input: RecordSpoolStockReceiptInput) => Promise<SpoolStockReceiptView>;
  loadStock?: (options?: ApiRequestOptions) => Promise<SpoolStockSummaryItem[]>;
  createKey?: () => string;
}) {
  const [types, setTypes] = useState<WarehouseSpoolPriceType[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [draft, setDraft] = useState(INITIAL_DRAFT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feedbackId = useId();
  const inFlightRef = useRef(false);
  const pendingRef = useRef<PendingCommand | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [stockRevision, setStockRevision] = useState(0);
  const command = types.some((item) => item.label === draft.spoolTypeLabel)
    ? commandFromDraft(draft)
    : null;

  useEffect(() => {
    const controller = new AbortController();
    setCatalogStatus('loading');
    void loadTypes({ signal: controller.signal }).then(
      (items) => {
        if (controller.signal.aborted) return;
        const availableTypes = priceableSpoolTypes(items);
        setTypes(availableTypes);
        setDraft((current) => ({
          ...current,
          spoolTypeLabel: availableTypes.some((item) => item.label === current.spoolTypeLabel)
            ? current.spoolTypeLabel
            : (availableTypes[0]?.label ?? ''),
        }));
        setCatalogStatus('ready');
      },
      () => {
        if (!controller.signal.aborted) setCatalogStatus('error');
      },
    );
    return () => controller.abort();
  }, [catalogRevision, loadTypes]);

  function update(field: keyof PriceDraft, value: string) {
    if (inFlightRef.current) return;
    setDraft((current) => ({ ...current, [field]: value }));
    setMessage(null);
    setError(null);
  }

  async function submit() {
    if (!command || inFlightRef.current) return;
    const fingerprint = JSON.stringify(command);
    let pending = pendingRef.current;
    if (!pending || pending.fingerprint !== fingerprint) {
      try {
        pending = { fingerprint, operationKey: createKey() };
      } catch {
        setError('Не удалось создать идентификатор операции. Обновите страницу.');
        return;
      }
      pendingRef.current = pending;
    }
    inFlightRef.current = true;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const saved = await saveReceipt({ operationKey: pending.operationKey, ...command });
      pendingRef.current = null;
      setDraft((current) => ({ ...current, quantityMeters: '' }));
      setStockRevision((value) => value + 1);
      setMessage(
        `Цена и приход сохранены: ${saved.spoolTypeLabel} · ${METER_FORMAT.format(
          saved.quantityMillimeters / 1_000,
        )} пог. м · ${PRICE_FORMAT.format(saved.priceKopecksPerMeter / 100)} ₽/м`,
      );
    } catch (cause) {
      setError(saveError(cause));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="warehouse-spool-price-form" aria-label="Цена и приход шпуль">
      <header>
        <h2>Цена и приход шпуль</h2>
      </header>
      {catalogStatus === 'loading' ? (
        <p className="warehouse-spool-price-state">Загрузка видов шпуль…</p>
      ) : catalogStatus === 'error' ? (
        <div className="warehouse-spool-price-state">
          <span>Не удалось загрузить виды шпуль.</span>
          <button type="button" onClick={() => setCatalogRevision((value) => value + 1)}>
            Повторить
          </button>
        </div>
      ) : types.length === 0 ? (
        <p className="warehouse-spool-price-state">Нет видов шпуль для цены.</p>
      ) : (
        <div className="warehouse-spool-price-fields">
          <label>
            <span>Вид шпули</span>
            <select
              aria-label="Вид шпули"
              value={draft.spoolTypeLabel}
              required
              disabled={busy}
              onChange={(event) => update('spoolTypeLabel', event.currentTarget.value)}
            >
              {types.map((item) => (
                <option key={item.key} value={item.label}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Цена, ₽/м</span>
            <input
              aria-label="Цена, ₽/м"
              inputMode="decimal"
              value={draft.priceRubles}
              required
              disabled={busy}
              onChange={(event) => update('priceRubles', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Количество, пог. м</span>
            <input
              aria-label="Количество, пог. м"
              inputMode="decimal"
              value={draft.quantityMeters}
              required
              disabled={busy}
              onChange={(event) => update('quantityMeters', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Дата действия</span>
            <input
              aria-label="Дата действия"
              type="date"
              value={draft.effectiveDate}
              required
              disabled={busy}
              onChange={(event) => update('effectiveDate', event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            className="action-recommended"
            disabled={!command || busy}
            aria-busy={busy}
            aria-describedby={feedbackId}
            onClick={() => void submit()}
          >
            {busy ? 'Сохраняем…' : 'Сохранить цену и приход'}
          </button>
        </div>
      )}
      <p
        id={feedbackId}
        className="warehouse-spool-price-feedback"
        data-tone={error ? 'error' : message ? 'success' : 'idle'}
        aria-live="polite"
      >
        {error ??
          message ??
          (catalogStatus === 'ready' && types.length > 0 && !command
            ? 'Заполните цену, количество и дату действия.'
            : '')}
      </p>
      <SpoolStockSummary refreshRevision={stockRevision} loadStock={loadStock} />
    </section>
  );
}
