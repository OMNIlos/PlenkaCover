import type { WarehouseActivePallet, WarehouseWorkbench } from '../../domain/types';

export type WarehouseRollView = NonNullable<WarehouseWorkbench['expectedRolls']>[number];

const MOSCOW_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Moscow',
});
const MOSCOW_DATE = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
});

const HIDDEN_VALUES = new Set(['', '-', '—', 'Не указан']);

function visibleText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && !HIDDEN_VALUES.has(normalized) ? normalized : undefined;
}

function formatKg(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
}

function formatDateTime(value: string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : MOSCOW_DATE_TIME.format(date);
}

function formatDate(value: string): string | undefined {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? visibleText(value) : MOSCOW_DATE.format(date);
}

export function warehouseRollCharacteristicsLabel(roll: WarehouseRollView): string | undefined {
  const parts = [roll.filmType, roll.micron, roll.materialMark]
    .map(visibleText)
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function warehouseRollDimensionsLabel(roll: WarehouseRollView): string | undefined {
  const size = visibleText(roll.sizeMeters);
  const spool = visibleText(roll.spoolType);
  const article = visibleText(roll.article);
  const parts = [
    size,
    visibleText(roll.lengthMeters),
    spool && spool !== size ? `шпуля ${spool}` : undefined,
    article ? `арт. ${article}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function warehouseRollWeightLabel(roll: WarehouseRollView): string | undefined {
  const parts: string[] = [];
  if (roll.actualNetKg !== undefined) {
    parts.push(`Нетто ${formatKg(roll.actualNetKg)} кг`);
  } else {
    const plan = roll.planNetKg ?? roll.plannedNetKg;
    if (plan > 0) parts.push(`План ${formatKg(plan)} кг`);
  }
  if (roll.grossKg !== undefined) parts.push(`Брутто ${formatKg(roll.grossKg)} кг`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function warehouseRollProductionLabel(roll: WarehouseRollView): string | undefined {
  const parts = [visibleText(roll.operatorLabel), visibleText(roll.machineLabel)];
  const producedAt = roll.producedAt ? formatDateTime(roll.producedAt) : undefined;
  if (producedAt) parts.push(`Произведен ${producedAt}`);
  const visible = parts.filter((value): value is string => Boolean(value));
  return visible.length > 0 ? visible.join(' · ') : undefined;
}

export function warehouseRollPackagingLabel(roll: WarehouseRollView): string | undefined {
  const packaging = visibleText(roll.packagingMaterial);
  const deliveryDate = roll.deliveryDate ? formatDate(roll.deliveryDate) : undefined;
  const parts = [
    packaging
      ? `Упаковка ${packaging}${roll.packagingCount !== undefined ? ` × ${roll.packagingCount}` : ''}`
      : undefined,
    deliveryDate ? `Выдача ${deliveryDate}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function warehousePalletAcceptanceLabel(
  row: WarehouseActivePallet['rows'][number],
): string {
  const acceptedAt = formatDateTime(row.acceptedAt);
  return [acceptedAt ? `Принят ${acceptedAt}` : 'Принят', visibleText(row.scannedByName) ?? 'Склад']
    .filter(Boolean)
    .join(' · ');
}
