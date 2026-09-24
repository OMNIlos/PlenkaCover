import { apiGet, type ApiRequestOptions } from '../../api/client';

export type CommercialCounterpartyContract = {
  id: string;
  displayName: string;
  legalName?: string | null;
  inn?: string | null;
  billingSource?: string | null;
  syncStatus?: string | null;
};

export type CommercialCounterpartySearchPage = {
  items: CommercialCounterpartyContract[];
  nextCursor: string | null;
};

const COUNTERPARTY_PROJECTION_KEYS = [
  'id',
  'displayName',
  'legalName',
  'inn',
  'billingSource',
  'syncStatus',
] as const;

export function fetchCommercialCounterparties(
  options?: ApiRequestOptions,
): Promise<CommercialCounterpartyContract[]> {
  return apiGet<unknown>('/api/commercial/counterparties', options).then(
    parseCommercialCounterparties,
  );
}

export function searchCommercialCounterparties(
  { q, cursor, limit = 20 }: { q?: string; cursor?: string; limit?: number } = {},
  options?: ApiRequestOptions,
): Promise<CommercialCounterpartySearchPage> {
  const params = new URLSearchParams();
  const normalizedQuery = q?.trim().replace(/\s+/gu, ' ');
  if (normalizedQuery) params.set('q', normalizedQuery);
  const boundedLimit = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.trunc(limit))) : 20;
  params.set('limit', String(boundedLimit));
  if (cursor) params.set('cursor', cursor);
  return apiGet<unknown>(
    `/api/commercial/counterparties/search?${params.toString()}`,
    options,
  ).then(parseCommercialCounterpartySearchPage);
}

function parseCommercialCounterparties(value: unknown): CommercialCounterpartyContract[] {
  if (!Array.isArray(value)) throw invalidCommercialCounterparties();
  const items = value.map(parseCommercialCounterparty);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw invalidCommercialCounterparties();
  }
  return items;
}

function parseCommercialCounterparty(value: unknown): CommercialCounterpartyContract {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== COUNTERPARTY_PROJECTION_KEYS.length ||
    !COUNTERPARTY_PROJECTION_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    throw invalidCommercialCounterparties();
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    record.id.trim().length === 0 ||
    typeof record.displayName !== 'string' ||
    record.displayName.trim().length === 0 ||
    (record.legalName !== null && typeof record.legalName !== 'string') ||
    (record.inn !== null && typeof record.inn !== 'string') ||
    typeof record.billingSource !== 'string' ||
    record.billingSource.trim().length === 0 ||
    typeof record.syncStatus !== 'string' ||
    record.syncStatus.trim().length === 0
  ) {
    throw invalidCommercialCounterparties();
  }
  return {
    id: record.id,
    displayName: record.displayName,
    legalName: record.legalName as string | null,
    inn: record.inn as string | null,
    billingSource: record.billingSource,
    syncStatus: record.syncStatus,
  };
}

function parseCommercialCounterpartySearchPage(value: unknown): CommercialCounterpartySearchPage {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'items') ||
      !Object.hasOwn(value, 'nextCursor')
    ) {
      throw new Error('invalid');
    }
    const page = value as Record<string, unknown>;
    if (
      page.nextCursor !== null &&
      (typeof page.nextCursor !== 'string' || page.nextCursor.trim().length === 0)
    ) {
      throw new Error('invalid');
    }
    return {
      items: parseCommercialCounterparties(page.items),
      nextCursor: page.nextCursor,
    };
  } catch {
    throw new Error('Некорректный ответ поиска контрагентов.');
  }
}

function invalidCommercialCounterparties(): Error {
  return new Error('Некорректный ответ справочника контрагентов.');
}
