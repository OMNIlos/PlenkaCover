import { useRef, useState } from 'react';
import type {
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../../api/materialRecipeCatalog';
import {
  createWarehouseReserveRoll,
  type WarehouseReserveRoll,
  type WarehouseReserveRollCreateInput,
} from '../../api/warehouse';
import { createOperationKey } from '../../api/idempotentOperation';
import type { MaterialRecipeCatalogStatus } from '../../features/recipes/useMaterialRecipeCatalog';
import { PlenkiModal } from '../plenki-ui/PlenkiPrimitives';

type Draft = {
  rollCode: string;
  batchCode: string;
  filmType: string;
  actualThicknessMicron: string;
  accountingThicknessMicron: string;
  widthMm: string;
  plannedLengthM: string;
  grossKg: string;
  spoolKg: string;
  plannedNetKg: string;
  spoolType: string;
  birka: string;
  materialSelection: string;
};

const EMPTY_DRAFT: Draft = {
  rollCode: '',
  batchCode: '',
  filmType: '',
  actualThicknessMicron: '',
  accountingThicknessMicron: '',
  widthMm: '',
  plannedLengthM: '',
  grossKg: '',
  spoolKg: '',
  plannedNetKg: '',
  spoolType: '',
  birka: '',
  materialSelection: '',
};

type NumericField = {
  value: number;
  milli: number;
};

function positiveDecimal(value: string, maximum: number): NumericField | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,3})?$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  const milli = Math.round(parsed * 1_000);
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > maximum ||
    !Number.isSafeInteger(milli)
  ) {
    return null;
  }
  return { value: parsed, milli };
}

export function warehouseReserveRollNetKg(gross: string, spool: string): number | null {
  const grossValue = positiveDecimal(gross, 100_000);
  const spoolValue = positiveDecimal(spool, 10_000);
  if (!grossValue || !spoolValue || grossValue.milli <= spoolValue.milli) return null;
  return Number(((grossValue.milli - spoolValue.milli) / 1_000).toFixed(3));
}

function displayKg(value: number | null): string {
  return value === null
    ? '—'
    : `${value.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кг`;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function buildCommand(draft: Draft): Omit<WarehouseReserveRollCreateInput, 'operationKey'> | null {
  const actualThickness = positiveDecimal(draft.actualThicknessMicron, 10_000);
  const accountingThickness = positiveDecimal(draft.accountingThicknessMicron, 10_000);
  const width = positiveDecimal(draft.widthMm, 100_000);
  const length = positiveDecimal(draft.plannedLengthM, 10_000_000);
  const gross = positiveDecimal(draft.grossKg, 100_000);
  const spool = positiveDecimal(draft.spoolKg, 10_000);
  const plannedNet = draft.plannedNetKg.trim()
    ? positiveDecimal(draft.plannedNetKg, 100_000)
    : null;
  const netKg = warehouseReserveRollNetKg(draft.grossKg, draft.spoolKg);
  const rollCode = normalizeText(draft.rollCode);
  const batchCode = normalizeText(draft.batchCode);
  const filmType = normalizeText(draft.filmType);
  const spoolType = normalizeText(draft.spoolType);
  const birka = normalizeText(draft.birka);
  if (
    !rollCode ||
    !batchCode ||
    !filmType ||
    !spoolType ||
    !birka ||
    !actualThickness ||
    !accountingThickness ||
    !width ||
    !length ||
    !gross ||
    !spool ||
    netKg === null ||
    (draft.plannedNetKg.trim() && !plannedNet)
  ) {
    return null;
  }
  const [selectionKind, selectionId] = draft.materialSelection.split(':', 2);
  if (!selectionId || (selectionKind !== 'material' && selectionKind !== 'recipe')) return null;
  return {
    rollCode,
    batchCode,
    filmType,
    actualThicknessMicron: actualThickness.value,
    accountingThicknessMicron: accountingThickness.value,
    widthMm: width.value,
    plannedLengthM: length.value,
    grossKg: gross.value,
    spoolKg: spool.value,
    ...(plannedNet ? { plannedNetKg: plannedNet.value } : {}),
    spoolType,
    birka,
    ...(selectionKind === 'material'
      ? { baseRawMaterialDefinitionId: selectionId }
      : { recipeDefinitionVersionId: selectionId }),
  };
}

export function WarehouseReserveRollCreateModal({
  materials,
  recipes,
  catalogStatus,
  catalogError,
  onReloadCatalog,
  onCreate = createWarehouseReserveRoll,
  onCreated,
  onClose,
}: {
  materials: readonly RawMaterialCatalogItem[];
  recipes: readonly RecipeCatalogItem[];
  catalogStatus: MaterialRecipeCatalogStatus;
  catalogError: string | null;
  onReloadCatalog(): void;
  onCreate?(input: WarehouseReserveRollCreateInput): Promise<WarehouseReserveRoll>;
  onCreated(roll: WarehouseReserveRoll): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<{ fingerprint: string; operationKey: string } | null>(null);
  const command = buildCommand(draft);
  const netKg = warehouseReserveRollNetKg(draft.grossKg, draft.spoolKg);
  const catalogReady = catalogStatus === 'ready' || catalogStatus === 'refreshing';

  function update(field: keyof Draft, value: string) {
    if (inFlightRef.current) return;
    setError(null);
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function submit() {
    if (!command || inFlightRef.current) return;
    const fingerprint = JSON.stringify(command);
    let pending = pendingRef.current;
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = { fingerprint, operationKey: createOperationKey() };
      pendingRef.current = pending;
    }
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await onCreate({ operationKey: pending.operationKey, ...command });
      pendingRef.current = null;
      onCreated(created);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : 'Не удалось зарегистрировать рулон.',
      );
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <PlenkiModal
      eyebrow="СКЛАД · РЕЗЕРВ"
      title="Добавить рулон"
      className="warehouse-reserve-roll-modal"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" className="action-secondary" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="action-recommended"
            disabled={!command || busy}
            aria-busy={busy}
            onClick={() => void submit()}
          >
            {busy ? 'Сохраняем…' : 'Добавить в резерв'}
          </button>
        </>
      }
    >
      <div className="warehouse-reserve-roll-grid">
        <label>
          <span>Код рулона</span>
          <input
            aria-label="Код рулона"
            autoFocus
            maxLength={80}
            value={draft.rollCode}
            disabled={busy}
            onChange={(event) => update('rollCode', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Партия</span>
          <input
            aria-label="Партия рулона"
            maxLength={80}
            value={draft.batchCode}
            disabled={busy}
            onChange={(event) => update('batchCode', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Тип плёнки</span>
          <input
            aria-label="Тип плёнки"
            maxLength={120}
            placeholder="Рукав, полотно…"
            value={draft.filmType}
            disabled={busy}
            onChange={(event) => update('filmType', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Шпуля</span>
          <input
            aria-label="Тип шпули"
            maxLength={120}
            placeholder="Тонкая, толстая…"
            value={draft.spoolType}
            disabled={busy}
            onChange={(event) => update('spoolType', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Фактическая толщина, мкм</span>
          <input
            aria-label="Фактическая толщина, мкм"
            type="number"
            min="0.001"
            step="0.001"
            value={draft.actualThicknessMicron}
            disabled={busy}
            onChange={(event) => update('actualThicknessMicron', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Бухгалтерская толщина, мкм</span>
          <input
            aria-label="Бухгалтерская толщина, мкм"
            type="number"
            min="0.001"
            step="0.001"
            value={draft.accountingThicknessMicron}
            disabled={busy}
            onChange={(event) => update('accountingThicknessMicron', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Ширина, мм</span>
          <input
            aria-label="Ширина, мм"
            type="number"
            min="0.001"
            step="0.001"
            value={draft.widthMm}
            disabled={busy}
            onChange={(event) => update('widthMm', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Метраж, м</span>
          <input
            aria-label="Метраж, м"
            type="number"
            min="0.001"
            step="0.001"
            value={draft.plannedLengthM}
            disabled={busy}
            onChange={(event) => update('plannedLengthM', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Брутто, кг</span>
          <input
            aria-label="Брутто, кг"
            type="number"
            min="0.001"
            step="0.001"
            value={draft.grossKg}
            disabled={busy}
            onChange={(event) => update('grossKg', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Вес шпули, кг</span>
          <input
            aria-label="Вес шпули, кг"
            type="number"
            min="0.001"
            step="0.001"
            value={draft.spoolKg}
            disabled={busy}
            onChange={(event) => update('spoolKg', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>План нетто, кг</span>
          <input
            aria-label="План нетто, кг"
            type="number"
            min="0.001"
            step="0.001"
            placeholder="Если отличается от факта"
            value={draft.plannedNetKg}
            disabled={busy}
            onChange={(event) => update('plannedNetKg', event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Бирка</span>
          <input
            aria-label="Бирка рулона"
            maxLength={120}
            value={draft.birka}
            disabled={busy}
            onChange={(event) => update('birka', event.currentTarget.value)}
          />
        </label>
        <label className="is-wide">
          <span>Сырьё / рецептура</span>
          <select
            aria-label="Сырьё или рецептура рулона"
            value={draft.materialSelection}
            disabled={busy || !catalogReady}
            onChange={(event) => update('materialSelection', event.currentTarget.value)}
          >
            <option value="">
              {catalogStatus === 'loading' ? 'Загружаем каталог…' : 'Выберите состав'}
            </option>
            <optgroup label="Сырьё">
              {materials.map((material) => (
                <option key={material.id} value={`material:${material.id}`}>
                  {material.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Рецептуры">
              {recipes.map((recipe) => (
                <option key={recipe.version.id} value={`recipe:${recipe.version.id}`}>
                  {recipe.name} · v{recipe.version.version}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <div className="warehouse-reserve-roll-weight-preview is-wide">
          <span>Физический вес</span>
          <strong>
            Нетто {displayKg(netKg)} · Брутто{' '}
            {displayKg(positiveDecimal(draft.grossKg, 100_000)?.value ?? null)}
          </strong>
        </div>
        {catalogStatus === 'error' ? (
          <div role="alert" className="warehouse-inventory-adjustment-error is-wide">
            <span>{catalogError ?? 'Каталог сырья недоступен.'}</span>
            <button type="button" disabled={busy} onClick={onReloadCatalog}>
              Повторить
            </button>
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="warehouse-inventory-adjustment-error is-wide">
            {error}
          </div>
        ) : null}
      </div>
    </PlenkiModal>
  );
}
