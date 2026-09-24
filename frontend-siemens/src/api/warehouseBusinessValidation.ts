import type {
  WarehouseBusinessPage,
  WarehouseBusinessRow,
  WarehouseBusinessTemplate,
} from './commercialPerformance';

const PAGE_KEYS = ['items', 'page', 'pageSize', 'total'] as const;
const ROW_KEYS = ['kind', 'id', 'templates', 'status', 'orderNumber', 'counterpartyName'] as const;
const TEMPLATE_KEYS = [
  'fingerprint',
  'filmType',
  'actualThicknessMicron',
  'accountingThicknessMicron',
  'widthMm',
  'plannedLengthM',
  'birka',
  'spoolType',
  'plannedWeightKg',
  'recipeVersion',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isTemplate(value: unknown): value is WarehouseBusinessTemplate {
  return (
    isRecord(value) &&
    hasExactKeys(value, TEMPLATE_KEYS) &&
    typeof value.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.fingerprint) &&
    isNonEmptyString(value.filmType) &&
    isPositiveNumber(value.actualThicknessMicron) &&
    isPositiveNumber(value.accountingThicknessMicron) &&
    isPositiveNumber(value.widthMm) &&
    isPositiveNumber(value.plannedLengthM) &&
    isNonEmptyString(value.birka) &&
    isNonEmptyString(value.spoolType) &&
    isPositiveNumber(value.plannedWeightKg) &&
    isNullableString(value.recipeVersion)
  );
}

function isRow(value: unknown): value is WarehouseBusinessRow {
  return (
    isRecord(value) &&
    hasExactKeys(value, ROW_KEYS) &&
    (value.kind === 'client_order' || value.kind === 'reserve') &&
    isNonEmptyString(value.id) &&
    Array.isArray(value.templates) &&
    value.templates.every(isTemplate) &&
    (value.status === 'awaiting_shipment' ||
      value.status === 'reserve' ||
      value.status === 'processing') &&
    isNullableString(value.orderNumber) &&
    isNullableString(value.counterpartyName)
  );
}

export function parseWarehouseBusinessPage(value: unknown): WarehouseBusinessPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAGE_KEYS) ||
    !Array.isArray(value.items) ||
    !value.items.every(isRow) ||
    !Number.isSafeInteger(value.page) ||
    (value.page as number) < 1 ||
    !Number.isSafeInteger(value.pageSize) ||
    (value.pageSize as number) < 1 ||
    (value.pageSize as number) > 100 ||
    !Number.isSafeInteger(value.total) ||
    (value.total as number) < 0 ||
    value.items.length > (value.pageSize as number) ||
    value.items.length > (value.total as number)
  ) {
    throw new Error('Некорректные данные склада');
  }
  return value as WarehouseBusinessPage;
}
