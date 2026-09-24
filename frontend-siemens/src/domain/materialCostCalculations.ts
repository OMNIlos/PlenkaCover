import type { MaterialCostReference, OrderRawMaterial, RawMaterialUsageSummary } from './types';

export type MaterialCostCalculationLine = {
  materialId: string;
  label: string;
  qtyKg: number;
  sharePct?: number;
  valueRub?: number;
  unitPriceRub?: number;
  sourceLabel?: string;
  effectiveAt?: string;
  status: 'ready' | 'missing_cost' | 'unsupported_unit';
};

export type MaterialCostCalculation = {
  status: 'ready' | 'missing_cost' | 'hidden';
  totalRub?: number;
  summaryLabel: string;
  formulaLabel: string;
  sourceLabel: string;
  lines: MaterialCostCalculationLine[];
};

function normalizeMaterialId(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, '');
}

export function sameMaterialCostId(left: string, right: string) {
  const normalizedLeft = normalizeMaterialId(left);
  const normalizedRight = normalizeMaterialId(right);
  return normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

export function findMaterialCostReference(materialId: string, costReferences: MaterialCostReference[]) {
  return costReferences.find((reference) => sameMaterialCostId(reference.materialId, materialId) || sameMaterialCostId(reference.label, materialId));
}

export function unitPriceRub(reference?: MaterialCostReference) {
  if (!reference || reference.status === 'source_missing') return undefined;
  if (typeof reference.unitPriceRub === 'number' && Number.isFinite(reference.unitPriceRub)) return reference.unitPriceRub;
  const parsed = reference.valueLabel
    .replace(/\s/g, '')
    .replace(',', '.')
    .match(/-?\d+(?:\.\d+)?/);
  return parsed ? Number(parsed[0]) : undefined;
}

export function formatRub(value: number) {
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
}

function formatQty(value: number) {
  return `${Number(value.toFixed(1)).toLocaleString('ru-RU')} кг`;
}

function sourceLabel(lines: MaterialCostCalculationLine[]) {
  const sources = Array.from(new Set(lines.map((line) => line.sourceLabel).filter(Boolean)));
  const effectiveDates = Array.from(new Set(lines.map((line) => line.effectiveAt).filter(Boolean)));
  if (sources.length === 0) return 'Нет источника цены';
  return `${sources.join('; ')}${effectiveDates.length > 0 ? ` · действует с ${effectiveDates.join(', ')}` : ''}`;
}

export function calculateMaterialStockCost(summary: RawMaterialUsageSummary, reference?: MaterialCostReference): MaterialCostCalculation {
  const priceRub = unitPriceRub(reference);
  const isKg = summary.unit === 'кг';
  const line: MaterialCostCalculationLine = {
    materialId: summary.rawMaterialId,
    label: summary.label,
    qtyKg: summary.actualQty,
    unitPriceRub: priceRub,
    sourceLabel: reference?.sourceLabel,
    effectiveAt: reference?.effectiveAt,
    status: !isKg ? 'unsupported_unit' : typeof priceRub === 'number' ? 'ready' : 'missing_cost',
    valueRub: isKg && typeof priceRub === 'number' ? summary.actualQty * priceRub : undefined,
  };

  if (!isKg) {
    return {
      status: 'missing_cost',
      summaryLabel: 'Не считаем: нужна цена за единицу',
      formulaLabel: `${summary.unit} не переводится в ₽/кг без правила`,
      sourceLabel: 'Нужна настройка единицы',
      lines: [line],
    };
  }

  if (typeof priceRub !== 'number') {
    return {
      status: 'missing_cost',
      summaryLabel: 'Нет рублевого остатка',
      formulaLabel: `${formatQty(summary.actualQty)} × цена сырья`,
      sourceLabel: 'Нужна цена сырья/добавки',
      lines: [line],
    };
  }

  const totalRub = summary.actualQty * priceRub;
  return {
    status: 'ready',
    totalRub,
    summaryLabel: formatRub(totalRub),
    formulaLabel: `${formatQty(summary.actualQty)} × ${reference?.valueLabel ?? `${priceRub} ₽/кг`}`,
    sourceLabel: sourceLabel([line]),
    lines: [line],
  };
}

export function calculateRecipeMaterialCost(rawMaterials: OrderRawMaterial[], costReferences: MaterialCostReference[], affectedWeightKg?: number): MaterialCostCalculation {
  const relevantMaterials = rawMaterials.filter((material) => material.unit === 'кг' && material.nominalQty > 0);
  const baseQty = affectedWeightKg && affectedWeightKg > 0
    ? affectedWeightKg
    : relevantMaterials.reduce((sum, material) => sum + material.nominalQty, 0);
  const totalRecipeQty = relevantMaterials.reduce((sum, material) => sum + material.nominalQty, 0);

  const lines = relevantMaterials.map((material) => {
    const reference = material.costReferenceId
      ? costReferences.find((item) => item.id === material.costReferenceId) ?? findMaterialCostReference(material.rawMaterialId, costReferences)
      : findMaterialCostReference(material.rawMaterialId, costReferences);
    const priceRub = unitPriceRub(reference);
    const share = material.recipeSharePct ?? (totalRecipeQty > 0 ? material.nominalQty / totalRecipeQty * 100 : undefined);
    const qtyKg = affectedWeightKg && typeof share === 'number'
      ? affectedWeightKg * share / 100
      : material.nominalQty;

    return {
      materialId: material.rawMaterialId,
      label: material.label,
      qtyKg,
      sharePct: share,
      unitPriceRub: priceRub,
      sourceLabel: reference?.sourceLabel,
      effectiveAt: reference?.effectiveAt,
      status: typeof priceRub === 'number' ? 'ready' as const : 'missing_cost' as const,
      valueRub: typeof priceRub === 'number' ? qtyKg * priceRub : undefined,
    };
  });

  const missing = lines.filter((line) => line.status !== 'ready');
  const totalRub = lines.reduce((sum, line) => sum + (line.valueRub ?? 0), 0);
  const formulaParts = lines.map((line) => {
    const share = typeof line.sharePct === 'number' ? `${Number(line.sharePct.toFixed(1)).toLocaleString('ru-RU')}%` : 'доля';
    const price = typeof line.unitPriceRub === 'number' ? `${line.unitPriceRub.toLocaleString('ru-RU')} ₽/кг` : 'нет цены';
    return `${share} ${line.label} × ${price}`;
  });

  if (lines.length === 0) {
    return {
      status: 'missing_cost',
      summaryLabel: 'Нет состава рецептуры',
      formulaLabel: 'Нужны строки сырья/добавок в рецептуре',
      sourceLabel: 'Рецептура не структурирована',
      lines,
    };
  }

  return {
    status: missing.length > 0 ? 'missing_cost' : 'ready',
    totalRub: missing.length > 0 ? undefined : totalRub,
    summaryLabel: missing.length > 0 ? `Не хватает цен: ${missing.map((line) => line.label).join(', ')}` : formatRub(totalRub),
    formulaLabel: `${formatQty(baseQty)} × (${formulaParts.join(' + ')})`,
    sourceLabel: sourceLabel(lines),
    lines,
  };
}
