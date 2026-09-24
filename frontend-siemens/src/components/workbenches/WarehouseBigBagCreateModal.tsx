import { useRef, useState } from 'react';

import type { RawMaterialCatalogItem } from '../../api/materialRecipeCatalog';
import type { WarehouseBigBagCreateInput } from '../../api/warehouseBigBags';
import type { MaterialRecipeCatalogStatus } from '../../features/recipes/useMaterialRecipeCatalog';
import { PlenkiModal } from '../plenki-ui/PlenkiPrimitives';

export type WarehouseBigBagCreateCommand = WarehouseBigBagCreateInput;

export function WarehouseBigBagCreateModal({
  onCreate,
  onClose,
  materials,
  catalogStatus,
  catalogError,
  onReloadCatalog,
}: {
  onCreate: (input: WarehouseBigBagCreateCommand) => Promise<boolean>;
  onClose: () => void;
  materials: readonly RawMaterialCatalogItem[];
  catalogStatus: MaterialRecipeCatalogStatus;
  catalogError: string | null;
  onReloadCatalog: () => void;
}) {
  const [materialId, setMaterialId] = useState('');
  const [materialSearch, setMaterialSearch] = useState('');
  const [weightDraft, setWeightDraft] = useState('');
  const [priceDraft, setPriceDraft] = useState('');
  const [batchDraft, setBatchDraft] = useState('');
  const [supplierDraft, setSupplierDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const weightKg = Number(weightDraft.replace(',', '.'));
  const hasWeight = weightDraft.trim().length > 0 && Number.isFinite(weightKg);
  const priceKopecksPerKg = parseRublesToKopecks(priceDraft);
  const selectedMaterial = materials.find((material) => material.id === materialId) ?? null;
  const normalizedMaterialSearch = materialSearch
    .trim()
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU');
  const visibleMaterials = materials.filter(
    (material) =>
      material.id === materialId ||
      normalizedMaterialSearch.length === 0 ||
      material.name.normalize('NFKC').toLocaleLowerCase('ru-RU').includes(normalizedMaterialSearch),
  );
  const catalogReady = catalogStatus === 'ready' || catalogStatus === 'refreshing';
  const invalid =
    selectedMaterial === null || !hasWeight || weightKg <= 0 || priceKopecksPerKg === null;
  const totalKopecks =
    hasWeight && weightKg > 0 && priceKopecksPerKg !== null
      ? calculateTotalKopecks(weightKg, priceKopecksPerKg)
      : null;

  async function submit() {
    if (invalid || selectedMaterial === null || priceKopecksPerKg === null || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await onCreate({
        baseRawMaterialDefinitionId: selectedMaterial.id,
        weightKg,
        priceKopecksPerKg,
        ...(batchDraft.trim() ? { batchCode: batchDraft.trim() } : {}),
        ...(supplierDraft.trim() ? { supplierName: supplierDraft.trim() } : {}),
      });
      if (created) {
        onClose();
        return;
      }
      setError('Big-Bag не создан. Повторите попытку.');
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : 'Big-Bag не создан. Повторите попытку.',
      );
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <PlenkiModal
      eyebrow="СЫРЬЁ · BIG-BAG"
      title="Создать Big-Bag"
      className="warehouse-bigbag-create-modal"
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
            disabled={invalid || busy}
            aria-busy={busy}
            onClick={() => void submit()}
          >
            {busy ? 'Создаём…' : 'Создать Big-Bag'}
          </button>
        </>
      }
    >
      <div className="warehouse-bigbag-create-grid">
        <label className="is-wide">
          <span>Поиск вида сырья</span>
          <input
            aria-label="Поиск вида сырья"
            type="search"
            autoFocus
            value={materialSearch}
            disabled={busy || !catalogReady || materials.length === 0}
            placeholder="Начните вводить название"
            onChange={(event) => {
              setMaterialSearch(event.currentTarget.value);
              setError(null);
            }}
          />
        </label>
        <label className="is-wide">
          <span>Вид сырья</span>
          <select
            aria-label="Вид сырья"
            value={materialId}
            disabled={busy || !catalogReady || materials.length === 0}
            onChange={(event) => {
              setMaterialId(event.currentTarget.value);
              setError(null);
            }}
          >
            <option value="">
              {catalogStatus === 'loading'
                ? 'Загружаем виды сырья…'
                : materials.length === 0
                  ? 'Нет доступных видов сырья'
                  : 'Выберите вид сырья'}
            </option>
            {visibleMaterials.map((material) => (
              <option key={material.id} value={material.id}>
                {material.name}
              </option>
            ))}
          </select>
        </label>
        {catalogStatus === 'error' ? (
          <div role="alert" className="warehouse-inventory-adjustment-error is-wide">
            <span>{catalogError ?? 'Не удалось загрузить виды сырья.'}</span>
            <button type="button" disabled={busy} onClick={onReloadCatalog}>
              Повторить
            </button>
          </div>
        ) : null}
        <label>
          <span>Масса Big-Bag, кг</span>
          <input
            aria-label="Масса Big-Bag, кг"
            type="number"
            inputMode="decimal"
            min="0.001"
            step="0.001"
            value={weightDraft}
            disabled={busy || selectedMaterial === null}
            onChange={(event) => {
              setWeightDraft(event.currentTarget.value);
              setError(null);
            }}
            placeholder={selectedMaterial === null ? 'Сначала выберите сырьё' : 'Например, 500'}
          />
        </label>
        <label>
          <span>Цена за 1 кг, ₽</span>
          <input
            aria-label="Цена за 1 кг, ₽"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={priceDraft}
            disabled={busy || selectedMaterial === null}
            onChange={(event) => {
              setPriceDraft(event.currentTarget.value);
              setError(null);
            }}
            placeholder={selectedMaterial === null ? 'Сначала выберите сырьё' : 'Например, 100'}
          />
        </label>
        <label>
          <span>Партия</span>
          <input
            aria-label="Партия сырья"
            value={batchDraft}
            disabled={busy || selectedMaterial === null}
            maxLength={120}
            onChange={(event) => {
              setBatchDraft(event.currentTarget.value);
              setError(null);
            }}
            placeholder="Если известна"
          />
        </label>
        <label>
          <span>Поставщик</span>
          <input
            aria-label="Поставщик"
            value={supplierDraft}
            disabled={busy || selectedMaterial === null}
            maxLength={200}
            onChange={(event) => {
              setSupplierDraft(event.currentTarget.value);
              setError(null);
            }}
            placeholder="Если известен"
          />
        </label>
        <div className="warehouse-bigbag-create-fact">
          <span>Сырьё</span>
          <strong>{selectedMaterial?.name ?? 'Не выбрано'}</strong>
        </div>
        <div className="warehouse-bigbag-create-fact">
          <span>Начальный вес</span>
          <strong>{hasWeight && weightKg > 0 ? formatKg(weightKg) : '—'}</strong>
        </div>
        <div className="warehouse-bigbag-create-fact is-wide">
          <span>Стоимость Big-Bag</span>
          <strong>{totalKopecks === null ? '—' : formatMoney(totalKopecks)}</strong>
        </div>
        {error ? (
          <div role="alert" className="warehouse-inventory-adjustment-error is-wide">
            {error}
          </div>
        ) : null}
      </div>
    </PlenkiModal>
  );
}

function formatKg(value: number) {
  return `${new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 3,
  }).format(value)} кг`;
}

function parseRublesToKopecks(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const [rubles, fraction = ''] = normalized.split('.');
  const kopecks = Number(rubles) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(kopecks) ? kopecks : null;
}

function calculateTotalKopecks(weightKg: number, priceKopecksPerKg: number): number | null {
  const numerator = Math.round(weightKg * 1_000) * priceKopecksPerKg;
  return Number.isSafeInteger(numerator) ? Math.floor((numerator + 500) / 1_000) : null;
}

function formatMoney(kopecks: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: kopecks % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(kopecks / 100);
}
