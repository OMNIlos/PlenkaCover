import type { CommercialOrderPosition, RawMaterialStock, WarehouseCoverStatus } from './types';

export type WarehouseCoverPlanActionId = 'partial' | 'full' | 'production';

export type WarehouseCoverPlanAction = {
  id: WarehouseCoverPlanActionId;
  label: string;
  status: WarehouseCoverStatus;
};

export type WarehouseCoverPartialInput = {
  min: number;
  max: number;
  defaultValue: number;
  suffix: string;
};

export type WarehouseCoverPlan = {
  rollCount: number;
  plannedWeightKg?: number;
  requiredQtyKg?: number;
  availableQtyKg: number;
  coverableRollCount: number;
  stock?: RawMaterialStock;
  actions: WarehouseCoverPlanAction[];
  partialInput?: WarehouseCoverPartialInput;
};

const ACTION_LABELS: Record<WarehouseCoverPlanActionId, string> = {
  partial: 'Частично покрыть',
  full: 'Покрыть полностью',
  production: 'На производство',
};

const ACTION_STATUSES: Record<WarehouseCoverPlanActionId, WarehouseCoverStatus> = {
  partial: 'partial_proposed',
  full: 'full_proposed',
  production: 'needs_production',
};

export function buildWarehouseCoverPlan(
  position: CommercialOrderPosition,
  rawMaterialStocks: RawMaterialStock[],
): WarehouseCoverPlan {
  const rollCount = Math.max(0, Math.trunc(position.rollCount));
  const plannedWeightKg = plannedWeightKgForPosition(position);
  const stock = findRawMaterialStock(position, rawMaterialStocks);
  const availableQtyKg = stock?.actualQty && stock.actualQty > 0 ? stock.actualQty : 0;
  const coverableRollCount =
    rollCount > 0 && plannedWeightKg && plannedWeightKg > 0
      ? Math.min(rollCount, Math.floor(availableQtyKg / plannedWeightKg))
      : 0;
  const actionIds: WarehouseCoverPlanActionId[] =
    coverableRollCount <= 0
      ? ['production']
      : coverableRollCount >= rollCount
        ? ['partial', 'full', 'production']
        : ['partial', 'production'];
  const partialMax = Math.max(0, Math.min(coverableRollCount, rollCount - 1));

  return {
    rollCount,
    plannedWeightKg,
    requiredQtyKg: plannedWeightKg ? rollCount * plannedWeightKg : undefined,
    availableQtyKg,
    coverableRollCount,
    stock,
    actions: actionIds.map((id) => ({
      id,
      label: ACTION_LABELS[id],
      status: ACTION_STATUSES[id],
    })),
    partialInput:
      coverableRollCount >= rollCount && partialMax > 0
        ? {
            min: 1,
            max: partialMax,
            defaultValue: partialMax,
            suffix: `из ${coverableRollCount} рул.`,
          }
        : undefined,
  };
}

function plannedWeightKgForPosition(position: CommercialOrderPosition) {
  if (position.plannedWeightKg && position.plannedWeightKg > 0) return position.plannedWeightKg;
  const recipeValue = position.recipeSnapshot.parameters.find(
    (parameter) => parameter.label.trim().toLowerCase() === 'план. вес, кг',
  )?.value;
  if (!recipeValue) return undefined;
  const parsed = Number(recipeValue.replace(',', '.').replace(/[^0-9.]+/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function findRawMaterialStock(
  position: CommercialOrderPosition,
  rawMaterialStocks: RawMaterialStock[],
) {
  const ids = new Set(
    [
      position.rawMaterialId,
      ...(position.rawMaterials ?? []).map((material) => material.rawMaterialId),
    ]
      .filter(Boolean)
      .map((value) => normalizeMaterialKey(value ?? '')),
  );
  const labels = new Set(
    [
      position.rawMaterialLabel,
      ...(position.rawMaterials ?? []).flatMap((material) => [
        material.label,
        material.rawMaterialId,
      ]),
    ]
      .filter(Boolean)
      .map((value) => normalizeMaterialKey(value ?? '')),
  );
  return rawMaterialStocks.find((stock) => {
    const stockId = normalizeMaterialKey(stock.rawMaterialId);
    const stockLabel = normalizeMaterialKey(stock.label);
    return ids.has(stockId) || ids.has(stockLabel) || labels.has(stockId) || labels.has(stockLabel);
  });
}

function normalizeMaterialKey(value: string) {
  return value
    .replace(/[ё]/gi, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}
