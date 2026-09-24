import { apiGet, type ApiRequestOptions } from './client';

export const SAFE_INVENTORY_SOURCE_STATUSES = [
  'fresh',
  'stale',
  'partial',
  'unavailable',
  'conflict',
  'erp_only',
] as const;

export type SafeInventorySourceStatus = (typeof SAFE_INVENTORY_SOURCE_STATUSES)[number];
export type SafeInventoryRole = 'production' | 'director' | 'warehouse';

export type SafeInventorySource = {
  snapshotId: string;
  sourceKind: string;
  capturedAt: string | null;
  importedAt: string | null;
};

export type SafeInventoryConflict = {
  code: string;
  message: string;
};

export type SafeInventoryItem = {
  materialId: string;
  materialName: string;
  category: string | null;
  unit: string | null;
  erpActualQty: number | null;
  oneCQty: number | null;
  reservedQty: number | null;
  availableQty: number | null;
  expectedUsageQty: number | null;
  openBigBagQty: number | null;
  recycledQty: number | null;
  sourceStatus: SafeInventorySourceStatus;
  source: SafeInventorySource | null;
  conflicts: SafeInventoryConflict[];
  updatedAt: string | null;
};

export type SafeInventoryPage = {
  items: SafeInventoryItem[];
  nextCursor: string | null;
  sourceUnavailable: boolean;
  generatedAt: string;
};

export type SafeInventoryQuery = {
  q?: string;
  category?: 'primary' | 'secondary' | 'additive' | 'custom';
  sourceStatus?: SafeInventorySourceStatus;
  availability?: 'available' | 'unavailable';
  cursor?: string;
  limit?: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Сервер вернул некорректные данные о сырье.');
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Сервер вернул некорректное поле сырья: ${field}.`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : stringValue(value, field);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Сервер вернул некорректное поле сырья: ${field}.`);
  }
  return value;
}

function parseSource(value: unknown): SafeInventorySource | null {
  if (value === null || value === undefined) return null;
  const source = record(value);
  return {
    snapshotId: stringValue(source.snapshotId, 'source.snapshotId'),
    sourceKind: stringValue(source.sourceKind, 'source.sourceKind'),
    capturedAt: nullableString(source.capturedAt, 'source.capturedAt'),
    importedAt: nullableString(source.importedAt, 'source.importedAt'),
  };
}

function parseItem(value: unknown): SafeInventoryItem {
  const item = record(value);
  const sourceStatus = stringValue(item.sourceStatus, 'sourceStatus');
  if (!SAFE_INVENTORY_SOURCE_STATUSES.includes(sourceStatus as SafeInventorySourceStatus)) {
    throw new Error('Сервер вернул неизвестное состояние источника сырья.');
  }
  if (!Array.isArray(item.conflicts)) {
    throw new Error('Сервер вернул некорректные расхождения сырья.');
  }
  return {
    materialId: stringValue(item.materialId, 'materialId'),
    materialName: stringValue(item.materialName, 'materialName'),
    category: nullableString(item.category, 'category'),
    unit: nullableString(item.unit, 'unit'),
    erpActualQty: nullableNumber(item.erpActualQty, 'erpActualQty'),
    oneCQty: nullableNumber(item.oneCQty, 'oneCQty'),
    reservedQty: nullableNumber(item.reservedQty, 'reservedQty'),
    availableQty: nullableNumber(item.availableQty, 'availableQty'),
    expectedUsageQty: nullableNumber(item.expectedUsageQty, 'expectedUsageQty'),
    openBigBagQty: nullableNumber(item.openBigBagQty, 'openBigBagQty'),
    recycledQty: nullableNumber(item.recycledQty, 'recycledQty'),
    sourceStatus: sourceStatus as SafeInventorySourceStatus,
    source: parseSource(item.source),
    conflicts: item.conflicts.map((value) => {
      const conflict = record(value);
      return {
        code: stringValue(conflict.code, 'conflicts.code'),
        message: stringValue(conflict.message, 'conflicts.message'),
      };
    }),
    updatedAt: nullableString(item.updatedAt, 'updatedAt'),
  };
}

export function parseSafeInventoryPage(value: unknown): SafeInventoryPage {
  const page = record(value);
  if (!Array.isArray(page.items) || typeof page.sourceUnavailable !== 'boolean') {
    throw new Error('Сервер вернул некорректные данные о сырье.');
  }
  return {
    items: page.items.map(parseItem),
    nextCursor: nullableString(page.nextCursor, 'nextCursor'),
    sourceUnavailable: page.sourceUnavailable,
    generatedAt: stringValue(page.generatedAt, 'generatedAt'),
  };
}

export async function fetchSafeRawMaterialInventory(
  role: SafeInventoryRole,
  query: SafeInventoryQuery = {},
  options?: ApiRequestOptions,
): Promise<SafeInventoryPage> {
  const search = new URLSearchParams();
  const normalizedQuery = query.q?.trim();
  if (normalizedQuery) search.set('q', normalizedQuery);
  if (query.category) search.set('category', query.category);
  if (query.sourceStatus) search.set('sourceStatus', query.sourceStatus);
  if (query.availability) search.set('availability', query.availability);
  if (query.cursor) search.set('cursor', query.cursor);
  search.set('limit', String(query.limit ?? 20));
  const route =
    role === 'warehouse' ? '/api/warehouse/raw-material-inventory' : `/api/${role}/raw-materials`;
  const response = await apiGet<unknown>(`${route}?${search.toString()}`, options);
  return parseSafeInventoryPage(response);
}
