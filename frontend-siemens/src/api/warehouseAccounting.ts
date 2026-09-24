import { apiGet, type ApiRequestOptions } from './client';

export type WarehouseAccountingStockScope = 'goods' | 'consumables';
export type WarehouseAccountingBalanceStatus = 'positive' | 'zero' | 'negative';

export type WarehouseAccountingStockItem = {
  nomenclatureExternalId: string;
  name: string;
  kind: string | null;
  unit: string | null;
  quantity: number;
  balanceStatus: WarehouseAccountingBalanceStatus;
  capturedAt: string;
  importedAt: string;
  stale: boolean;
  physicalTraceability: 'unavailable';
};

export type WarehouseAccountingStockPage = {
  items: WarehouseAccountingStockItem[];
  nextCursor: string | null;
  accountCode: '41.01';
  scope: WarehouseAccountingStockScope;
  generatedAt: string;
};

export type WarehouseAccountingMovementLine = {
  lineNumber: number;
  name: string;
  quantity: number;
  unit: string | null;
};

export type WarehouseAccountingMovement = {
  externalId: string;
  documentNumber: string;
  documentDate: string;
  direction: 'outbound';
  sourceLabel: 'Отгрузка по 1С';
  capturedAt: string;
  importedAt: string;
  physicalTraceability: 'unavailable';
  lines: WarehouseAccountingMovementLine[];
};

export type WarehouseAccountingMovementPage = {
  items: WarehouseAccountingMovement[];
  nextCursor: string | null;
  generatedAt: string;
};

export type WarehouseAccountingStockQuery = {
  scope: WarehouseAccountingStockScope;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type WarehouseAccountingMovementQuery = {
  q?: string;
  cursor?: string;
  limit?: number;
};

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string) {
  if (typeof value !== 'string') throw new Error(`Некорректное поле 1С: ${field}.`);
  return value;
}

function nullableString(value: unknown, field: string) {
  return value === null || value === undefined ? null : stringValue(value, field);
}

function numberValue(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Некорректное поле 1С: ${field}.`);
  }
  return value;
}

function booleanValue(value: unknown, field: string) {
  if (typeof value !== 'boolean') throw new Error(`Некорректное поле 1С: ${field}.`);
  return value;
}

function parseStockItem(value: unknown): WarehouseAccountingStockItem {
  const item = record(value, 'Сервер вернул некорректный остаток 1С.');
  const balanceStatus = stringValue(item.balanceStatus, 'balanceStatus');
  if (!['positive', 'zero', 'negative'].includes(balanceStatus)) {
    throw new Error('Неизвестное состояние остатка 1С.');
  }
  if (item.physicalTraceability !== 'unavailable') {
    throw new Error('Некорректная граница физической прослеживаемости.');
  }
  return {
    nomenclatureExternalId: stringValue(item.nomenclatureExternalId, 'nomenclatureExternalId'),
    name: stringValue(item.name, 'name'),
    kind: nullableString(item.kind, 'kind'),
    unit: nullableString(item.unit, 'unit'),
    quantity: numberValue(item.quantity, 'quantity'),
    balanceStatus: balanceStatus as WarehouseAccountingBalanceStatus,
    capturedAt: stringValue(item.capturedAt, 'capturedAt'),
    importedAt: stringValue(item.importedAt, 'importedAt'),
    stale: booleanValue(item.stale, 'stale'),
    physicalTraceability: 'unavailable',
  };
}

function parseMovementLine(value: unknown): WarehouseAccountingMovementLine {
  const line = record(value, 'Сервер вернул некорректную строку движения 1С.');
  return {
    lineNumber: numberValue(line.lineNumber, 'lines.lineNumber'),
    name: stringValue(line.name, 'lines.name'),
    quantity: numberValue(line.quantity, 'lines.quantity'),
    unit: nullableString(line.unit, 'lines.unit'),
  };
}

function parseMovement(value: unknown): WarehouseAccountingMovement {
  const item = record(value, 'Сервер вернул некорректное движение 1С.');
  if (
    item.direction !== 'outbound' ||
    item.sourceLabel !== 'Отгрузка по 1С' ||
    item.physicalTraceability !== 'unavailable' ||
    !Array.isArray(item.lines)
  ) {
    throw new Error('Сервер вернул неподдерживаемое движение 1С.');
  }
  return {
    externalId: stringValue(item.externalId, 'externalId'),
    documentNumber: stringValue(item.documentNumber, 'documentNumber'),
    documentDate: stringValue(item.documentDate, 'documentDate'),
    direction: 'outbound',
    sourceLabel: 'Отгрузка по 1С',
    capturedAt: stringValue(item.capturedAt, 'capturedAt'),
    importedAt: stringValue(item.importedAt, 'importedAt'),
    physicalTraceability: 'unavailable',
    lines: item.lines.map(parseMovementLine),
  };
}

export function parseWarehouseAccountingStockPage(value: unknown): WarehouseAccountingStockPage {
  const page = record(value, 'Сервер вернул некорректные остатки 1С.');
  if (
    !Array.isArray(page.items) ||
    page.accountCode !== '41.01' ||
    !['goods', 'consumables'].includes(String(page.scope))
  ) {
    throw new Error('Сервер вернул некорректные остатки 1С.');
  }
  return {
    items: page.items.map(parseStockItem),
    nextCursor: nullableString(page.nextCursor, 'nextCursor'),
    accountCode: '41.01',
    scope: page.scope as WarehouseAccountingStockScope,
    generatedAt: stringValue(page.generatedAt, 'generatedAt'),
  };
}

export function parseWarehouseAccountingMovementPage(
  value: unknown,
): WarehouseAccountingMovementPage {
  const page = record(value, 'Сервер вернул некорректные движения 1С.');
  if (!Array.isArray(page.items)) throw new Error('Сервер вернул некорректные движения 1С.');
  return {
    items: page.items.map(parseMovement),
    nextCursor: nullableString(page.nextCursor, 'nextCursor'),
    generatedAt: stringValue(page.generatedAt, 'generatedAt'),
  };
}

export async function fetchWarehouseAccountingStock(
  query: WarehouseAccountingStockQuery,
  options?: ApiRequestOptions,
): Promise<WarehouseAccountingStockPage> {
  const params = new URLSearchParams({ scope: query.scope });
  const search = query.q?.trim();
  if (search) params.set('q', search);
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', String(query.limit ?? 50));
  const response = await apiGet<unknown>(
    `/api/warehouse/accounting-stock?${params.toString()}`,
    options,
  );
  return parseWarehouseAccountingStockPage(response);
}

export async function fetchWarehouseAccountingMovements(
  query: WarehouseAccountingMovementQuery = {},
  options?: ApiRequestOptions,
): Promise<WarehouseAccountingMovementPage> {
  const params = new URLSearchParams();
  const search = query.q?.trim();
  if (search) params.set('q', search);
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', String(query.limit ?? 20));
  const response = await apiGet<unknown>(
    `/api/warehouse/accounting-movements?${params.toString()}`,
    options,
  );
  return parseWarehouseAccountingMovementPage(response);
}
