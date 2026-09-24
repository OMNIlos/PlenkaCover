import { apiGet, type ApiRequestOptions } from './client';

export type FinanceRawMaterial = {
  id: string;
  code: string;
  material: string;
  supplier: string | null;
  batchCode: string | null;
  receivedAt: string | null;
  initialWeightKg: string | null;
  purchasePricePerKg: string | null;
  initialValue: string | null;
  currentWeightKg: string | null;
  measuredAt: string | null;
  currentValue: string | null;
  consumedWeightKg: string | null;
  consumedValue: string | null;
};

const DECIMAL = /^\d+(?:\.\d+)?$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const nullableText = (value: unknown) =>
  value === null || (typeof value === 'string' && value.trim().length > 0);
const nullableDecimal = (value: unknown) =>
  value === null || (typeof value === 'string' && DECIMAL.test(value));
const timestamp = (value: unknown) =>
  typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const nullableTimestamp = (value: unknown) => value === null || timestamp(value);

function isFinanceRawMaterial(value: unknown): value is FinanceRawMaterial {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = [
    'id',
    'code',
    'material',
    'supplier',
    'batchCode',
    'receivedAt',
    'initialWeightKg',
    'purchasePricePerKg',
    'initialValue',
    'currentWeightKg',
    'measuredAt',
    'currentValue',
    'consumedWeightKg',
    'consumedValue',
  ] as const;
  return (
    keys.every((key) => Object.hasOwn(row, key)) &&
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.code === 'string' &&
    row.code.length > 0 &&
    typeof row.material === 'string' &&
    row.material.length > 0 &&
    nullableText(row.supplier) &&
    nullableText(row.batchCode) &&
    nullableTimestamp(row.receivedAt) &&
    nullableDecimal(row.initialWeightKg) &&
    nullableDecimal(row.purchasePricePerKg) &&
    nullableDecimal(row.initialValue) &&
    nullableDecimal(row.currentWeightKg) &&
    nullableTimestamp(row.measuredAt) &&
    nullableDecimal(row.currentValue) &&
    nullableDecimal(row.consumedWeightKg) &&
    nullableDecimal(row.consumedValue)
  );
}

function parseFinanceRawMaterials(value: unknown): FinanceRawMaterial[] {
  if (!Array.isArray(value) || !value.every(isFinanceRawMaterial)) {
    throw new Error('Некорректный ответ финансового учёта сырья.');
  }
  if (new Set(value.map(({ id }) => id)).size !== value.length) {
    throw new Error('Некорректный ответ финансового учёта сырья.');
  }
  return value;
}

export function fetchFinanceRawMaterials(
  options?: ApiRequestOptions,
): Promise<FinanceRawMaterial[]> {
  return apiGet<unknown>('/api/finance/raw-materials', options).then(parseFinanceRawMaterials);
}
