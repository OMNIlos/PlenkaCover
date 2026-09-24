import { apiGet, type ApiRequestOptions } from './client';

export type BigBagRegisterLocation = {
  kind: 'warehouse' | 'production' | 'post' | 'consumed' | 'unknown';
  postCode: string | null;
  postName: string | null;
};

export type BigBagRegisterRow = {
  id: string;
  code: string;
  material: string;
  batch: string | null;
  createdAt: string;
  status: 'available' | 'in_use' | 'consumed';
  location: BigBagRegisterLocation;
  operatorName: string | null;
  currentWeightKg: number | null;
  totalKopecks: number | null;
};

export type BigBagRegisterPage = {
  items: BigBagRegisterRow[];
  page: number;
  pageSize: number;
  total: number;
};

export type BigBagRegisterQuery = {
  q?: string;
  view?: 'all' | 'current';
  page?: number;
  pageSize?: number;
};

type JsonRecord = Record<string, unknown>;

function exactRecord(value: unknown, fields: readonly string[]): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  const record = value as JsonRecord;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || !keys.every((key) => fields.includes(key))) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return record;
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return value;
}

function nullableIdentity(value: unknown): string | null {
  return value === null ? null : identity(value);
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return value;
}

function nullableMoney(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return value as number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return value as T;
}

function parseLocation(value: unknown): BigBagRegisterLocation {
  const location = exactRecord(value, ['kind', 'postCode', 'postName']);
  const kind = oneOf(location.kind, ['warehouse', 'production', 'post', 'consumed', 'unknown']);
  const postCode = nullableIdentity(location.postCode);
  const postName = nullableIdentity(location.postName);
  const hasCompletePost = postCode !== null && postName !== null;
  const hasAnyPost = postCode !== null || postName !== null;
  if ((kind === 'post' && !hasCompletePost) || (kind !== 'post' && hasAnyPost)) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return { kind, postCode, postName };
}

function parseRow(value: unknown): BigBagRegisterRow {
  const row = exactRecord(value, [
    'id',
    'code',
    'material',
    'batch',
    'createdAt',
    'status',
    'location',
    'operatorName',
    'currentWeightKg',
    'totalKopecks',
  ]);
  const createdAt = identity(row.createdAt);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  const location = parseLocation(row.location);
  const operatorName = nullableIdentity(row.operatorName);
  if (
    (location.kind === 'post' && operatorName === null) ||
    (location.kind !== 'post' && operatorName !== null)
  ) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return {
    id: identity(row.id),
    code: identity(row.code),
    material: identity(row.material),
    batch: nullableIdentity(row.batch),
    createdAt,
    status: oneOf(row.status, ['available', 'in_use', 'consumed']),
    location,
    operatorName,
    currentWeightKg: nullableNumber(row.currentWeightKg),
    totalKopecks: nullableMoney(row.totalKopecks),
  };
}

export function parseBigBagRegisterPage(value: unknown): BigBagRegisterPage {
  const page = exactRecord(value, ['items', 'page', 'pageSize', 'total']);
  if (!Array.isArray(page.items)) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  const parsed = {
    items: page.items.map(parseRow),
    page: integer(page.page),
    pageSize: integer(page.pageSize),
    total: integer(page.total),
  };
  if (parsed.page < 1 || parsed.pageSize < 1) {
    throw new Error('Сервер вернул некорректный реестр Big-Bag.');
  }
  return parsed;
}

export async function fetchBigBagRegisterPage(
  query: BigBagRegisterQuery = {},
  options?: ApiRequestOptions,
): Promise<BigBagRegisterPage> {
  const search = new URLSearchParams();
  const q = query.q?.trim();
  if (q) search.set('q', q);
  if (query.view) search.set('view', query.view);
  search.set('page', String(query.page ?? 1));
  search.set('pageSize', String(query.pageSize ?? 25));
  const value = await apiGet<unknown>(`/api/raw-materials/big-bags?${search.toString()}`, options);
  return parseBigBagRegisterPage(value);
}
