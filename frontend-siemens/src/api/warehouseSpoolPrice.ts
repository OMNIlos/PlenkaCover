import { apiGet, apiPost, type ApiRequestOptions } from './client';
import { isServerRole, type ServerRole } from './roleMap';

export type WarehouseSpoolPriceType = {
  key: string;
  label: string;
};

export type RecordSpoolPriceReferenceInput = {
  operationKey: string;
  spoolTypeLabel: string;
  priceKopecksPerMeter: number;
  source: string;
  effectiveFrom: string;
  reason: string;
};

export type SpoolPriceReferenceView = {
  id: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  priceKopecksPerMeter: number;
  source: string;
  effectiveFrom: string;
  reason: string;
  createdById: string;
  createdByRole: ServerRole;
  createdAt: string;
};

export type RecordSpoolStockReceiptInput = RecordSpoolPriceReferenceInput & {
  quantityMillimeters: number;
};

export type SpoolStockReceiptView = {
  id: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  quantityMillimeters: number;
  priceReferenceId: string;
  priceKopecksPerMeter: number;
  effectiveFrom: string;
  receivedAt: string;
  receivedById: string;
  receivedByRole: ServerRole;
  createdAt: string;
};

export type SpoolStockSummaryItem = {
  spoolTypeKey: string;
  spoolTypeLabel: string;
  totalReceivedMillimeters: number;
  lastReceivedAt: string | null;
};

const MAX_SPOOL_PRICE_TYPES = 200;
type JsonRecord = Record<string, unknown>;

function invalidCatalog(): never {
  throw new Error('Некорректный справочник шпуль.');
}

function invalidPrice(): never {
  throw new Error('Некорректная цена шпули.');
}

function invalidReceipt(): never {
  throw new Error('Некорректный приход шпуль.');
}

function exactRecord(value: unknown, fields: readonly string[], invalid: () => never): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as JsonRecord;
  const keys = Object.keys(item);
  if (keys.length !== fields.length || !keys.every((key) => fields.includes(key))) invalid();
  return item;
}

function identity(value: unknown, invalid: () => never): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) invalid();
  return value;
}

function normalizedSpoolKey(label: string): string {
  return label
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е');
}

function canonicalIso(value: unknown, invalid: () => never = invalidPrice): string {
  const parsed = identity(value, invalid);
  const timestamp = Date.parse(parsed);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== parsed) {
    invalid();
  }
  return parsed;
}

function positiveSafeInteger(value: unknown, invalid: () => never = invalidPrice): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid();
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidReceipt();
  return value;
}

export function parseMetersToMillimeters(value: string): number | null {
  const match = value
    .trim()
    .replace(',', '.')
    .match(/^(\d+)(?:\.(\d{1,3}))?$/u);
  if (!match) return null;
  const millimeters = Number(match[1]) * 1_000 + Number((match[2] ?? '').padEnd(3, '0'));
  return Number.isSafeInteger(millimeters) && millimeters > 0 ? millimeters : null;
}

function parseSpoolPriceType(value: unknown): WarehouseSpoolPriceType {
  const item = exactRecord(value, ['key', 'label'], invalidCatalog);
  const key = identity(item.key, invalidCatalog);
  const label = identity(item.label, invalidCatalog);
  if (key !== normalizedSpoolKey(label)) invalidCatalog();
  return {
    key,
    label,
  };
}

export function parseWarehouseSpoolPriceTypes(value: unknown): WarehouseSpoolPriceType[] {
  if (!Array.isArray(value) || value.length > MAX_SPOOL_PRICE_TYPES) invalidCatalog();
  const types = value.map(parseSpoolPriceType);
  if (
    new Set(types.map((item) => item.key)).size !== types.length ||
    new Set(types.map((item) => item.label)).size !== types.length
  ) {
    invalidCatalog();
  }
  return types;
}

export function parseSpoolPriceReference(value: unknown): SpoolPriceReferenceView {
  const item = exactRecord(
    value,
    [
      'id',
      'spoolTypeKey',
      'spoolTypeLabel',
      'priceKopecksPerMeter',
      'source',
      'effectiveFrom',
      'reason',
      'createdById',
      'createdByRole',
      'createdAt',
    ],
    invalidPrice,
  );
  const createdByRole = item.createdByRole;
  if (!isServerRole(createdByRole)) invalidPrice();
  const spoolTypeKey = identity(item.spoolTypeKey, invalidPrice);
  const spoolTypeLabel = identity(item.spoolTypeLabel, invalidPrice);
  if (spoolTypeKey !== normalizedSpoolKey(spoolTypeLabel)) invalidPrice();
  return {
    id: identity(item.id, invalidPrice),
    spoolTypeKey,
    spoolTypeLabel,
    priceKopecksPerMeter: positiveSafeInteger(item.priceKopecksPerMeter),
    source: identity(item.source, invalidPrice),
    effectiveFrom: canonicalIso(item.effectiveFrom),
    reason: identity(item.reason, invalidPrice),
    createdById: identity(item.createdById, invalidPrice),
    createdByRole,
    createdAt: canonicalIso(item.createdAt),
  };
}

export function parseSpoolStockReceipt(value: unknown): SpoolStockReceiptView {
  const item = exactRecord(
    value,
    [
      'id',
      'spoolTypeKey',
      'spoolTypeLabel',
      'quantityMillimeters',
      'priceReferenceId',
      'priceKopecksPerMeter',
      'effectiveFrom',
      'receivedAt',
      'receivedById',
      'receivedByRole',
      'createdAt',
    ],
    invalidReceipt,
  );
  const receivedByRole = item.receivedByRole;
  if (!isServerRole(receivedByRole)) invalidReceipt();
  const spoolTypeKey = identity(item.spoolTypeKey, invalidReceipt);
  const spoolTypeLabel = identity(item.spoolTypeLabel, invalidReceipt);
  if (spoolTypeKey !== normalizedSpoolKey(spoolTypeLabel)) invalidReceipt();
  const effectiveFrom = canonicalIso(item.effectiveFrom, invalidReceipt);
  const receivedAt = canonicalIso(item.receivedAt, invalidReceipt);
  if (effectiveFrom !== receivedAt) invalidReceipt();
  return {
    id: identity(item.id, invalidReceipt),
    spoolTypeKey,
    spoolTypeLabel,
    quantityMillimeters: positiveSafeInteger(item.quantityMillimeters, invalidReceipt),
    priceReferenceId: identity(item.priceReferenceId, invalidReceipt),
    priceKopecksPerMeter: positiveSafeInteger(item.priceKopecksPerMeter, invalidReceipt),
    effectiveFrom,
    receivedAt,
    receivedById: identity(item.receivedById, invalidReceipt),
    receivedByRole,
    createdAt: canonicalIso(item.createdAt, invalidReceipt),
  };
}

export function parseWarehouseSpoolStock(value: unknown): SpoolStockSummaryItem[] {
  if (!Array.isArray(value) || value.length > MAX_SPOOL_PRICE_TYPES) invalidReceipt();
  const items = value.map((value) => {
    const item = exactRecord(
      value,
      ['spoolTypeKey', 'spoolTypeLabel', 'totalReceivedMillimeters', 'lastReceivedAt'],
      invalidReceipt,
    );
    const spoolTypeKey = identity(item.spoolTypeKey, invalidReceipt);
    const spoolTypeLabel = identity(item.spoolTypeLabel, invalidReceipt);
    if (spoolTypeKey !== normalizedSpoolKey(spoolTypeLabel)) invalidReceipt();
    return {
      spoolTypeKey,
      spoolTypeLabel,
      totalReceivedMillimeters: nonNegativeSafeInteger(item.totalReceivedMillimeters),
      lastReceivedAt:
        item.lastReceivedAt === null ? null : canonicalIso(item.lastReceivedAt, invalidReceipt),
    };
  });
  if (new Set(items.map(({ spoolTypeKey }) => spoolTypeKey)).size !== items.length) {
    invalidReceipt();
  }
  return items;
}

export async function fetchWarehouseSpoolPriceTypes(
  options?: ApiRequestOptions,
): Promise<WarehouseSpoolPriceType[]> {
  return parseWarehouseSpoolPriceTypes(
    await apiGet<unknown>('/api/warehouse/spool-price-types', options),
  );
}

export async function recordWarehouseSpoolPrice(
  input: RecordSpoolPriceReferenceInput,
): Promise<SpoolPriceReferenceView> {
  return parseSpoolPriceReference(
    await apiPost<unknown>('/api/warehouse/spool-price-references', {
      operationKey: input.operationKey,
      spoolTypeLabel: input.spoolTypeLabel,
      priceKopecksPerMeter: input.priceKopecksPerMeter,
      source: input.source,
      effectiveFrom: input.effectiveFrom,
      reason: input.reason,
    }),
  );
}

export async function fetchWarehouseSpoolStock(
  options?: ApiRequestOptions,
): Promise<SpoolStockSummaryItem[]> {
  return parseWarehouseSpoolStock(await apiGet<unknown>('/api/warehouse/spool-stock', options));
}

export async function recordWarehouseSpoolReceipt(
  input: RecordSpoolStockReceiptInput,
): Promise<SpoolStockReceiptView> {
  return parseSpoolStockReceipt(
    await apiPost<unknown>('/api/warehouse/spool-stock-receipts', {
      operationKey: input.operationKey,
      spoolTypeLabel: input.spoolTypeLabel,
      priceKopecksPerMeter: input.priceKopecksPerMeter,
      quantityMillimeters: input.quantityMillimeters,
      source: input.source,
      effectiveFrom: input.effectiveFrom,
      reason: input.reason,
    }),
  );
}
