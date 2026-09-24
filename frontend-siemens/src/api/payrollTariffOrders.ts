import {
  ApiResponseParseError,
  apiGet,
  apiPatch,
  apiPost,
  type ApiRequestOptions,
} from './client';

export type ServerPayrollTariffOrderStatus = 'draft' | 'published';
export type ServerPayrollTariffLadderKey = 'urp12h' | 'urp24h' | 'abc12h' | 'abc24h';

export type ServerPayrollTariffUrpBand = {
  maxInclusiveGrams: number | null;
  primaryRateKopecksPerKg: number;
  secondaryRateKopecksPerKg: number;
};

export type ServerPayrollTariffAbcBand = {
  maxInclusiveGrams: number | null;
  standardRateKopecksPerKg: number;
  blackWhiteRateKopecksPerKg: number;
};

export type ServerPayrollTariffMatrix = {
  schemaVersion: 1;
  ladders: {
    urp12h: ServerPayrollTariffUrpBand[];
    urp24h: ServerPayrollTariffUrpBand[];
    abc12h: ServerPayrollTariffAbcBand[];
    abc24h: ServerPayrollTariffAbcBand[];
  };
  specialRules: {
    thinRoll: {
      enabled: boolean;
      maxExclusiveGrams: number;
      rateKopecksPerKg: number;
    };
    alabuga: {
      enabled: boolean;
      machineFamily: 'abc_new';
      normalizedLegalName: string;
      rateKopecksPerKg: number;
    };
  };
};

export type ServerPayrollTariffOrderReference = {
  id: string;
  name: string;
  effectiveFrom: string;
  currency: 'RUB';
};

export type ServerAppliedPayrollTariffOrder = ServerPayrollTariffOrderReference & {
  matrix: ServerPayrollTariffMatrix;
};

export type ServerPayrollTariffOrderListItem = ServerPayrollTariffOrderReference & {
  status: ServerPayrollTariffOrderStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type ServerPayrollTariffOrderView = ServerPayrollTariffOrderListItem & {
  matrix: ServerPayrollTariffMatrix;
  createdById: string | null;
  updatedById: string | null;
  publishedById: string | null;
};

export type ServerPayrollTariffOrderList = {
  items: ServerPayrollTariffOrderListItem[];
  activeOrderId: string | null;
  latestPublishedOrderId: string | null;
  minimumPublishEffectiveFrom: string;
  timezone: 'Europe/Moscow';
  generatedAt: string;
};

export type ServerPayrollTariffOrderFieldError = {
  path: string;
  code: string;
  message: string;
};

export type CreatePayrollTariffOrderInput = {
  operationKey: string;
  name: string;
  effectiveFrom: string;
  matrix: ServerPayrollTariffMatrix;
};

export type UpdatePayrollTariffOrderInput = CreatePayrollTariffOrderInput & {
  expectedRevision: number;
};

export type ReviewPayrollTariffOrderInput = {
  expectedRevision: number;
};

export type PublishPayrollTariffOrderInput = ReviewPayrollTariffOrderInput & {
  operationKey: string;
  reviewedMatrixHash: string;
};

export type ServerPayrollTariffOrderReview = {
  orderId: string;
  revision: number;
  matrixHash: string;
  minimumPublishEffectiveFrom: string;
  publishable: boolean;
  fieldErrors: ServerPayrollTariffOrderFieldError[];
};

export type ServerPayrollTariffOrderResult = {
  order: ServerPayrollTariffOrderView;
  replayed: boolean;
};

const REFERENCE_KEYS = ['id', 'name', 'effectiveFrom', 'currency'] as const;
const LIST_ITEM_KEYS = [
  ...REFERENCE_KEYS,
  'status',
  'revision',
  'createdAt',
  'updatedAt',
  'publishedAt',
] as const;
const VIEW_KEYS = [
  ...LIST_ITEM_KEYS,
  'matrix',
  'createdById',
  'updatedById',
  'publishedById',
] as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

function invalid(): never {
  throw new Error('Некорректный ответ приказа по тарифам');
}

export function isPayrollTariffRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeText(value: unknown, max = 200): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isThreshold(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function validThresholdSequence(bands: readonly { maxInclusiveGrams: number | null }[]): boolean {
  if (bands.length === 0 || bands.at(-1)?.maxInclusiveGrams !== null) return false;
  let previous = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const threshold = bands[index]?.maxInclusiveGrams;
    if (threshold === null) return index === bands.length - 1;
    if (threshold <= previous) return false;
    previous = threshold;
  }
  return true;
}

function isUrpBand(value: unknown): value is ServerPayrollTariffUrpBand {
  return (
    isPayrollTariffRecord(value) &&
    hasExactKeys(value, [
      'maxInclusiveGrams',
      'primaryRateKopecksPerKg',
      'secondaryRateKopecksPerKg',
    ]) &&
    isThreshold(value.maxInclusiveGrams) &&
    isNonNegativeInteger(value.primaryRateKopecksPerKg) &&
    isNonNegativeInteger(value.secondaryRateKopecksPerKg)
  );
}

function isAbcBand(value: unknown): value is ServerPayrollTariffAbcBand {
  return (
    isPayrollTariffRecord(value) &&
    hasExactKeys(value, [
      'maxInclusiveGrams',
      'standardRateKopecksPerKg',
      'blackWhiteRateKopecksPerKg',
    ]) &&
    isThreshold(value.maxInclusiveGrams) &&
    isNonNegativeInteger(value.standardRateKopecksPerKg) &&
    isNonNegativeInteger(value.blackWhiteRateKopecksPerKg)
  );
}

function isLadder<T extends { maxInclusiveGrams: number | null }>(
  value: unknown,
  isBand: (candidate: unknown) => candidate is T,
): value is T[] {
  return Array.isArray(value) && value.every(isBand) && validThresholdSequence(value);
}

export function parsePayrollTariffMatrix(value: unknown): ServerPayrollTariffMatrix {
  if (
    !isPayrollTariffRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'ladders', 'specialRules']) ||
    value.schemaVersion !== 1 ||
    !isPayrollTariffRecord(value.ladders) ||
    !hasExactKeys(value.ladders, ['urp12h', 'urp24h', 'abc12h', 'abc24h']) ||
    !isLadder(value.ladders.urp12h, isUrpBand) ||
    !isLadder(value.ladders.urp24h, isUrpBand) ||
    !isLadder(value.ladders.abc12h, isAbcBand) ||
    !isLadder(value.ladders.abc24h, isAbcBand) ||
    !isPayrollTariffRecord(value.specialRules) ||
    !hasExactKeys(value.specialRules, ['thinRoll', 'alabuga']) ||
    !isPayrollTariffRecord(value.specialRules.thinRoll) ||
    !hasExactKeys(value.specialRules.thinRoll, [
      'enabled',
      'maxExclusiveGrams',
      'rateKopecksPerKg',
    ]) ||
    typeof value.specialRules.thinRoll.enabled !== 'boolean' ||
    !isPositiveInteger(value.specialRules.thinRoll.maxExclusiveGrams) ||
    !isNonNegativeInteger(value.specialRules.thinRoll.rateKopecksPerKg) ||
    !isPayrollTariffRecord(value.specialRules.alabuga) ||
    !hasExactKeys(value.specialRules.alabuga, [
      'enabled',
      'machineFamily',
      'normalizedLegalName',
      'rateKopecksPerKg',
    ]) ||
    typeof value.specialRules.alabuga.enabled !== 'boolean' ||
    value.specialRules.alabuga.machineFamily !== 'abc_new' ||
    !isSafeText(value.specialRules.alabuga.normalizedLegalName) ||
    !isNonNegativeInteger(value.specialRules.alabuga.rateKopecksPerKg)
  ) {
    return invalid();
  }
  return value as ServerPayrollTariffMatrix;
}

export function parsePayrollTariffOrderReference(
  value: unknown,
): ServerPayrollTariffOrderReference {
  if (
    !isPayrollTariffRecord(value) ||
    !hasExactKeys(value, REFERENCE_KEYS) ||
    !isSafeText(value.id) ||
    !isSafeText(value.name) ||
    !isDate(value.effectiveFrom) ||
    value.currency !== 'RUB'
  ) {
    return invalid();
  }
  return value as ServerPayrollTariffOrderReference;
}

export function parseAppliedPayrollTariffOrder(
  value: unknown,
): ServerAppliedPayrollTariffOrder {
  if (!isPayrollTariffRecord(value) || !hasExactKeys(value, [...REFERENCE_KEYS, 'matrix'])) {
    return invalid();
  }
  parsePayrollTariffOrderReference({
    id: value.id,
    name: value.name,
    effectiveFrom: value.effectiveFrom,
    currency: value.currency,
  });
  parsePayrollTariffMatrix(value.matrix);
  return value as ServerAppliedPayrollTariffOrder;
}

function parseListItem(value: unknown): ServerPayrollTariffOrderListItem {
  if (
    !isPayrollTariffRecord(value) ||
    !hasExactKeys(value, LIST_ITEM_KEYS) ||
    (value.status !== 'draft' && value.status !== 'published') ||
    !isPositiveInteger(value.revision) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !(value.publishedAt === null || isTimestamp(value.publishedAt)) ||
    (value.status === 'draft' && value.publishedAt !== null) ||
    (value.status === 'published' && value.publishedAt === null)
  ) {
    return invalid();
  }
  parsePayrollTariffOrderReference({
    id: value.id,
    name: value.name,
    effectiveFrom: value.effectiveFrom,
    currency: value.currency,
  });
  return value as ServerPayrollTariffOrderListItem;
}

export function parsePayrollTariffOrderView(value: unknown): ServerPayrollTariffOrderView {
  if (!isPayrollTariffRecord(value) || !hasExactKeys(value, VIEW_KEYS)) return invalid();
  parseListItem(
    Object.fromEntries(LIST_ITEM_KEYS.map((key) => [key, value[key]])),
  );
  parsePayrollTariffMatrix(value.matrix);
  if (
    !['createdById', 'updatedById', 'publishedById'].every(
      (key) => value[key] === null || isSafeText(value[key]),
    )
  ) {
    return invalid();
  }
  return value as ServerPayrollTariffOrderView;
}

export function parsePayrollTariffOrderList(value: unknown): ServerPayrollTariffOrderList {
  if (
    !isPayrollTariffRecord(value) ||
    !hasExactKeys(value, [
      'items',
      'activeOrderId',
      'latestPublishedOrderId',
      'minimumPublishEffectiveFrom',
      'timezone',
      'generatedAt',
    ]) ||
    !Array.isArray(value.items) ||
    value.timezone !== 'Europe/Moscow' ||
    !isDate(value.minimumPublishEffectiveFrom) ||
    !isTimestamp(value.generatedAt)
  ) {
    return invalid();
  }
  const items = value.items.map(parseListItem);
  const ids = new Set(items.map(({ id }) => id));
  if (
    ids.size !== items.length ||
    !(value.activeOrderId === null || (isSafeText(value.activeOrderId) && ids.has(value.activeOrderId))) ||
    !(
      value.latestPublishedOrderId === null ||
      (isSafeText(value.latestPublishedOrderId) && ids.has(value.latestPublishedOrderId))
    )
  ) {
    return invalid();
  }
  return value as ServerPayrollTariffOrderList;
}

function parseFieldError(value: unknown): ServerPayrollTariffOrderFieldError {
  if (
    !isPayrollTariffRecord(value) ||
    !hasExactKeys(value, ['path', 'code', 'message']) ||
    !isSafeText(value.path, 500) ||
    !isSafeText(value.code, 100) ||
    !isSafeText(value.message, 500)
  ) {
    return invalid();
  }
  return value as ServerPayrollTariffOrderFieldError;
}

export function parsePayrollTariffOrderReview(value: unknown): ServerPayrollTariffOrderReview {
  if (
    !isPayrollTariffRecord(value) ||
    !hasExactKeys(value, [
      'orderId',
      'revision',
      'matrixHash',
      'minimumPublishEffectiveFrom',
      'publishable',
      'fieldErrors',
    ]) ||
    !isSafeText(value.orderId) ||
    !isPositiveInteger(value.revision) ||
    typeof value.matrixHash !== 'string' ||
    !SHA256.test(value.matrixHash) ||
    !isDate(value.minimumPublishEffectiveFrom) ||
    typeof value.publishable !== 'boolean' ||
    !Array.isArray(value.fieldErrors)
  ) {
    return invalid();
  }
  value.fieldErrors.forEach(parseFieldError);
  if (value.publishable !== (value.fieldErrors.length === 0)) return invalid();
  return value as ServerPayrollTariffOrderReview;
}

export function parsePayrollTariffOrderResult(value: unknown): ServerPayrollTariffOrderResult {
  if (
    !isPayrollTariffRecord(value) ||
    !hasExactKeys(value, ['order', 'replayed']) ||
    typeof value.replayed !== 'boolean'
  ) {
    return invalid();
  }
  return { order: parsePayrollTariffOrderView(value.order), replayed: value.replayed };
}

function parsePayrollTariffOrderMutationResult(
  value: unknown,
  status: number,
): ServerPayrollTariffOrderResult {
  try {
    return parsePayrollTariffOrderResult(value);
  } catch (error: unknown) {
    if (error instanceof ApiResponseParseError) throw error;
    throw new ApiResponseParseError(status, error);
  }
}

export async function fetchPayrollTariffOrders(
  options?: ApiRequestOptions,
): Promise<ServerPayrollTariffOrderList> {
  return parsePayrollTariffOrderList(
    await apiGet<unknown>('/api/director/payroll-tariff-orders', options),
  );
}

export async function fetchPayrollTariffOrder(
  id: string,
  options?: ApiRequestOptions,
): Promise<ServerPayrollTariffOrderView> {
  return parsePayrollTariffOrderView(
    await apiGet<unknown>(`/api/director/payroll-tariff-orders/${encodeURIComponent(id)}`, options),
  );
}

export async function createPayrollTariffOrder(
  input: CreatePayrollTariffOrderInput,
  options?: ApiRequestOptions,
): Promise<ServerPayrollTariffOrderResult> {
  if (!isUuidV4(input.operationKey)) throw new Error('Некорректный ключ операции');
  return parsePayrollTariffOrderMutationResult(
    await apiPost<unknown>('/api/director/payroll-tariff-orders', input, options),
    201,
  );
}

export async function updatePayrollTariffOrder(
  id: string,
  input: UpdatePayrollTariffOrderInput,
  options?: ApiRequestOptions,
): Promise<ServerPayrollTariffOrderResult> {
  if (!isUuidV4(input.operationKey)) throw new Error('Некорректный ключ операции');
  return parsePayrollTariffOrderMutationResult(
    await apiPatch<unknown>(
      `/api/director/payroll-tariff-orders/${encodeURIComponent(id)}`,
      input,
      options,
    ),
    200,
  );
}

export async function reviewPayrollTariffOrder(
  id: string,
  input: ReviewPayrollTariffOrderInput,
  options?: ApiRequestOptions,
): Promise<ServerPayrollTariffOrderReview> {
  return parsePayrollTariffOrderReview(
    await apiPost<unknown>(
      `/api/director/payroll-tariff-orders/${encodeURIComponent(id)}/review`,
      input,
      options,
    ),
  );
}

export async function publishPayrollTariffOrder(
  id: string,
  input: PublishPayrollTariffOrderInput,
  options?: ApiRequestOptions,
): Promise<ServerPayrollTariffOrderResult> {
  if (!isUuidV4(input.operationKey)) throw new Error('Некорректный ключ операции');
  return parsePayrollTariffOrderMutationResult(
    await apiPost<unknown>(
      `/api/director/payroll-tariff-orders/${encodeURIComponent(id)}/publish`,
      input,
      options,
    ),
    201,
  );
}
