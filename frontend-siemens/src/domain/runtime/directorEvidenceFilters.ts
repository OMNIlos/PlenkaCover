import {
  BIG_BAG_STATUSES,
  DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES,
  DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS,
  DIRECTOR_ANALYTICS_EVIDENCE_STATUSES,
  type BigBagStatus,
  type DirectorAnalyticsBigBagEvidenceQuery,
  type DirectorAnalyticsBigBagUsageState,
  type DirectorAnalyticsBucket,
  type DirectorAnalyticsEvidenceFreshness,
  type DirectorAnalyticsEvidenceStatus,
  type DirectorAnalyticsShiftEvidenceQuery,
} from '../../api/director';

export type DirectorShiftEvidenceFilterDraft = {
  q: string;
  shiftQuery: string;
  operatorQuery: string;
  postQuery: string;
  startedFrom: string;
  startedTo: string;
  endedFrom: string;
  endedTo: string;
  startKgMin: string;
  startKgMax: string;
  remainingKgMin: string;
  remainingKgMax: string;
  actualUsageKgMin: string;
  actualUsageKgMax: string;
  expectedUsageKgMin: string;
  expectedUsageKgMax: string;
  producedKgMin: string;
  producedKgMax: string;
  rollCountMin: string;
  rollCountMax: string;
  defectKgMin: string;
  defectKgMax: string;
  defectCountMin: string;
  defectCountMax: string;
  unverifiedDefectCountMin: string;
  unverifiedDefectCountMax: string;
  deviationKgMin: string;
  deviationKgMax: string;
  deviationPercentMin: string;
  deviationPercentMax: string;
  status: '' | DirectorAnalyticsEvidenceStatus;
  freshness: '' | DirectorAnalyticsEvidenceFreshness;
  latestEvidenceFrom: string;
  latestEvidenceTo: string;
};

export type DirectorBigBagEvidenceFilterDraft = {
  q: string;
  bigBagQuery: string;
  materialQuery: string;
  bigBagStatus: '' | BigBagStatus;
  shiftQuery: string;
  operatorQuery: string;
  postQuery: string;
  openedFrom: string;
  openedTo: string;
  closedFrom: string;
  closedTo: string;
  usageState: '' | DirectorAnalyticsBigBagUsageState;
  startKgMin: string;
  startKgMax: string;
  endKgMin: string;
  endKgMax: string;
  currentKgMin: string;
  currentKgMax: string;
  bagUsageKgMin: string;
  bagUsageKgMax: string;
  actualUsageKgMin: string;
  actualUsageKgMax: string;
  expectedUsageKgMin: string;
  expectedUsageKgMax: string;
  producedKgMin: string;
  producedKgMax: string;
  rollCountMin: string;
  rollCountMax: string;
  defectKgMin: string;
  defectKgMax: string;
  defectCountMin: string;
  defectCountMax: string;
  unverifiedDefectCountMin: string;
  unverifiedDefectCountMax: string;
  deviationKgMin: string;
  deviationKgMax: string;
  deviationPercentMin: string;
  deviationPercentMax: string;
  status: '' | DirectorAnalyticsEvidenceStatus;
  freshness: '' | DirectorAnalyticsEvidenceFreshness;
  latestEvidenceFrom: string;
  latestEvidenceTo: string;
};

export const emptyShiftEvidenceFilterDraft: DirectorShiftEvidenceFilterDraft = {
  q: '',
  shiftQuery: '',
  operatorQuery: '',
  postQuery: '',
  startedFrom: '',
  startedTo: '',
  endedFrom: '',
  endedTo: '',
  startKgMin: '',
  startKgMax: '',
  remainingKgMin: '',
  remainingKgMax: '',
  actualUsageKgMin: '',
  actualUsageKgMax: '',
  expectedUsageKgMin: '',
  expectedUsageKgMax: '',
  producedKgMin: '',
  producedKgMax: '',
  rollCountMin: '',
  rollCountMax: '',
  defectKgMin: '',
  defectKgMax: '',
  defectCountMin: '',
  defectCountMax: '',
  unverifiedDefectCountMin: '',
  unverifiedDefectCountMax: '',
  deviationKgMin: '',
  deviationKgMax: '',
  deviationPercentMin: '',
  deviationPercentMax: '',
  status: '',
  freshness: '',
  latestEvidenceFrom: '',
  latestEvidenceTo: '',
};

export const emptyBigBagEvidenceFilterDraft: DirectorBigBagEvidenceFilterDraft = {
  q: '',
  bigBagQuery: '',
  materialQuery: '',
  bigBagStatus: '',
  shiftQuery: '',
  operatorQuery: '',
  postQuery: '',
  openedFrom: '',
  openedTo: '',
  closedFrom: '',
  closedTo: '',
  usageState: '',
  startKgMin: '',
  startKgMax: '',
  endKgMin: '',
  endKgMax: '',
  currentKgMin: '',
  currentKgMax: '',
  bagUsageKgMin: '',
  bagUsageKgMax: '',
  actualUsageKgMin: '',
  actualUsageKgMax: '',
  expectedUsageKgMin: '',
  expectedUsageKgMax: '',
  producedKgMin: '',
  producedKgMax: '',
  rollCountMin: '',
  rollCountMax: '',
  defectKgMin: '',
  defectKgMax: '',
  defectCountMin: '',
  defectCountMax: '',
  unverifiedDefectCountMin: '',
  unverifiedDefectCountMax: '',
  deviationKgMin: '',
  deviationKgMax: '',
  deviationPercentMin: '',
  deviationPercentMax: '',
  status: '',
  freshness: '',
  latestEvidenceFrom: '',
  latestEvidenceTo: '',
};

const shiftFilterKeys = [
  'q',
  'shiftQuery',
  'operatorQuery',
  'postQuery',
  'startedFrom',
  'startedTo',
  'endedFrom',
  'endedTo',
  'startKgMin',
  'startKgMax',
  'remainingKgMin',
  'remainingKgMax',
  'actualUsageKgMin',
  'actualUsageKgMax',
  'expectedUsageKgMin',
  'expectedUsageKgMax',
  'producedKgMin',
  'producedKgMax',
  'rollCountMin',
  'rollCountMax',
  'defectKgMin',
  'defectKgMax',
  'defectCountMin',
  'defectCountMax',
  'unverifiedDefectCountMin',
  'unverifiedDefectCountMax',
  'deviationKgMin',
  'deviationKgMax',
  'deviationPercentMin',
  'deviationPercentMax',
  'status',
  'freshness',
  'latestEvidenceFrom',
  'latestEvidenceTo',
] as const satisfies readonly (keyof DirectorShiftEvidenceFilterDraft)[];

const bigBagFilterKeys = [
  'q',
  'bigBagQuery',
  'materialQuery',
  'bigBagStatus',
  'shiftQuery',
  'operatorQuery',
  'postQuery',
  'openedFrom',
  'openedTo',
  'closedFrom',
  'closedTo',
  'usageState',
  'startKgMin',
  'startKgMax',
  'endKgMin',
  'endKgMax',
  'currentKgMin',
  'currentKgMax',
  'bagUsageKgMin',
  'bagUsageKgMax',
  'actualUsageKgMin',
  'actualUsageKgMax',
  'expectedUsageKgMin',
  'expectedUsageKgMax',
  'producedKgMin',
  'producedKgMax',
  'rollCountMin',
  'rollCountMax',
  'defectKgMin',
  'defectKgMax',
  'defectCountMin',
  'defectCountMax',
  'unverifiedDefectCountMin',
  'unverifiedDefectCountMax',
  'deviationKgMin',
  'deviationKgMax',
  'deviationPercentMin',
  'deviationPercentMax',
  'status',
  'freshness',
  'latestEvidenceFrom',
  'latestEvidenceTo',
] as const satisfies readonly (keyof DirectorBigBagEvidenceFilterDraft)[];

const shiftTextKeys = ['q', 'shiftQuery', 'operatorQuery', 'postQuery'] as const;
const bigBagTextKeys = [
  'q',
  'bigBagQuery',
  'materialQuery',
  'shiftQuery',
  'operatorQuery',
  'postQuery',
] as const;
const shiftDateKeys = [
  'startedFrom',
  'startedTo',
  'endedFrom',
  'endedTo',
  'latestEvidenceFrom',
  'latestEvidenceTo',
] as const;
const bigBagDateKeys = [
  'openedFrom',
  'openedTo',
  'closedFrom',
  'closedTo',
  'latestEvidenceFrom',
  'latestEvidenceTo',
] as const;
const shiftCountKeys = [
  'rollCountMin',
  'rollCountMax',
  'defectCountMin',
  'defectCountMax',
  'unverifiedDefectCountMin',
  'unverifiedDefectCountMax',
] as const;
const bigBagCountKeys = shiftCountKeys;
const shiftSignedNumberKeys = [
  'deviationKgMin',
  'deviationKgMax',
  'deviationPercentMin',
  'deviationPercentMax',
] as const;
const bigBagSignedNumberKeys = shiftSignedNumberKeys;
const shiftNonNegativeNumberKeys = [
  'startKgMin',
  'startKgMax',
  'remainingKgMin',
  'remainingKgMax',
  'actualUsageKgMin',
  'actualUsageKgMax',
  'expectedUsageKgMin',
  'expectedUsageKgMax',
  'producedKgMin',
  'producedKgMax',
  'defectKgMin',
  'defectKgMax',
] as const;
const bigBagNonNegativeNumberKeys = [
  'startKgMin',
  'startKgMax',
  'endKgMin',
  'endKgMax',
  'currentKgMin',
  'currentKgMax',
  'bagUsageKgMin',
  'bagUsageKgMax',
  'actualUsageKgMin',
  'actualUsageKgMax',
  'expectedUsageKgMin',
  'expectedUsageKgMax',
  'producedKgMin',
  'producedKgMax',
  'defectKgMin',
  'defectKgMax',
] as const;

const sharedNumericPairs = [
  ['actualUsageKgMin', 'actualUsageKgMax'],
  ['expectedUsageKgMin', 'expectedUsageKgMax'],
  ['producedKgMin', 'producedKgMax'],
  ['rollCountMin', 'rollCountMax'],
  ['defectKgMin', 'defectKgMax'],
  ['defectCountMin', 'defectCountMax'],
  ['unverifiedDefectCountMin', 'unverifiedDefectCountMax'],
  ['deviationKgMin', 'deviationKgMax'],
  ['deviationPercentMin', 'deviationPercentMax'],
] as const;
const shiftNumericPairs = [
  ['startKgMin', 'startKgMax'],
  ['remainingKgMin', 'remainingKgMax'],
  ...sharedNumericPairs,
] as const;
const bigBagNumericPairs = [
  ['startKgMin', 'startKgMax'],
  ['endKgMin', 'endKgMax'],
  ['currentKgMin', 'currentKgMax'],
  ['bagUsageKgMin', 'bagUsageKgMax'],
  ...sharedNumericPairs,
] as const;
const shiftDatePairs = [
  ['startedFrom', 'startedTo'],
  ['endedFrom', 'endedTo'],
  ['latestEvidenceFrom', 'latestEvidenceTo'],
] as const;
const bigBagDatePairs = [
  ['openedFrom', 'openedTo'],
  ['closedFrom', 'closedTo'],
  ['latestEvidenceFrom', 'latestEvidenceTo'],
] as const;

type EvidenceFilterDraft =
  | DirectorShiftEvidenceFilterDraft
  | DirectorBigBagEvidenceFilterDraft;
export type EvidenceFilterErrors = Record<string, string>;
export type EvidenceQueryBuild<T> =
  | { ok: true; query: T; errors: Record<string, never> }
  | { ok: false; query: null; errors: EvidenceFilterErrors };

export type DirectorEvidenceQueryContext = {
  from: string;
  to: string;
  bucket: DirectorAnalyticsBucket;
  cursor?: string;
  limit?: number;
};

export type DirectorEvidenceLocationDraft = {
  shiftOpen: boolean;
  bigBagOpen: boolean;
  shift: DirectorShiftEvidenceFilterDraft;
  bigBag: DirectorBigBagEvidenceFilterDraft;
};

export type DirectorEvidenceLocationState = DirectorEvidenceLocationDraft & {
  errors: {
    shift: EvidenceFilterErrors;
    bigBag: EvidenceFilterErrors;
  };
};

const DECIMAL_PATTERN = /^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MAX_DATE_YEAR = 9998;
const TEXT_TOO_LONG = 'Не более 100 символов.';
const INVALID_DATE =
  'Укажите реальную дату в формате ГГГГ-ММ-ДД.';
const INVALID_NUMBER = 'Введите конечное число.';
const NON_NEGATIVE_NUMBER = 'Значение не может быть отрицательным.';
const NON_NEGATIVE_INTEGER = 'Введите целое число не меньше 0.';
const INVALID_RANGE = 'Минимум не может быть больше максимума.';
const INVALID_DATE_RANGE =
  'Начальная дата не может быть позже конечной.';
const INVALID_ENUM = 'Выберите допустимое значение.';

function valuesOf(draft: EvidenceFilterDraft): Record<string, string> {
  return draft as unknown as Record<string, string>;
}

function hasKey(keys: readonly string[], key: string): boolean {
  return keys.includes(key);
}

function isStrictDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > MAX_DATE_YEAR) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseFiniteDecimal(value: string): number | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateTextFields(
  values: Record<string, string>,
  keys: readonly string[],
  errors: EvidenceFilterErrors,
): void {
  for (const key of keys) {
    if (values[key]!.trim().length > 100) errors[key] = TEXT_TOO_LONG;
  }
}

function validateDateFields(
  values: Record<string, string>,
  keys: readonly string[],
  errors: EvidenceFilterErrors,
): void {
  for (const key of keys) {
    const value = values[key]!.trim();
    if (value && !isStrictDate(value)) errors[key] = INVALID_DATE;
  }
}

function validateNumberFields(
  values: Record<string, string>,
  keys: readonly string[],
  errors: EvidenceFilterErrors,
  constraint: 'signed' | 'non-negative' | 'count',
): void {
  for (const key of keys) {
    const value = values[key]!.trim();
    if (!value) continue;
    const parsed = parseFiniteDecimal(value);
    if (parsed === null) {
      errors[key] = constraint === 'count' ? NON_NEGATIVE_INTEGER : INVALID_NUMBER;
    } else if (constraint === 'count' && (!Number.isInteger(parsed) || parsed < 0)) {
      errors[key] = NON_NEGATIVE_INTEGER;
    } else if (constraint === 'non-negative' && parsed < 0) {
      errors[key] = NON_NEGATIVE_NUMBER;
    }
  }
}

function validateEnumField(
  values: Record<string, string>,
  key: string,
  allowed: readonly string[],
  errors: EvidenceFilterErrors,
): void {
  const value = values[key]!.trim();
  if (value && !allowed.includes(value)) errors[key] = INVALID_ENUM;
}

function validatePairs(
  values: Record<string, string>,
  pairs: readonly (readonly [string, string])[],
  errors: EvidenceFilterErrors,
  kind: 'number' | 'date',
): void {
  for (const [minKey, maxKey] of pairs) {
    const min = values[minKey]!.trim();
    const max = values[maxKey]!.trim();
    if (!min || !max || errors[minKey] || errors[maxKey]) continue;
    const invalid =
      kind === 'date'
        ? min > max
        : (parseFiniteDecimal(min) ?? Number.NaN) > (parseFiniteDecimal(max) ?? Number.NaN);
    if (!invalid) continue;
    const message = kind === 'date' ? INVALID_DATE_RANGE : INVALID_RANGE;
    errors[minKey] = message;
    errors[maxKey] = message;
  }
}

export function validateEvidenceFilterDraft(
  draft: DirectorShiftEvidenceFilterDraft,
): EvidenceFilterErrors;
export function validateEvidenceFilterDraft(
  draft: DirectorBigBagEvidenceFilterDraft,
): EvidenceFilterErrors;
export function validateEvidenceFilterDraft(draft: EvidenceFilterDraft): EvidenceFilterErrors;
export function validateEvidenceFilterDraft(draft: EvidenceFilterDraft): EvidenceFilterErrors {
  const values = valuesOf(draft);
  const errors: EvidenceFilterErrors = {};
  const bigBag = 'bigBagQuery' in draft;

  validateTextFields(values, bigBag ? bigBagTextKeys : shiftTextKeys, errors);
  validateDateFields(values, bigBag ? bigBagDateKeys : shiftDateKeys, errors);
  validateNumberFields(
    values,
    bigBag ? bigBagNonNegativeNumberKeys : shiftNonNegativeNumberKeys,
    errors,
    'non-negative',
  );
  validateNumberFields(values, bigBag ? bigBagCountKeys : shiftCountKeys, errors, 'count');
  validateNumberFields(
    values,
    bigBag ? bigBagSignedNumberKeys : shiftSignedNumberKeys,
    errors,
    'signed',
  );
  validateEnumField(values, 'status', DIRECTOR_ANALYTICS_EVIDENCE_STATUSES, errors);
  validateEnumField(values, 'freshness', DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS, errors);
  if (bigBag) {
    validateEnumField(values, 'bigBagStatus', BIG_BAG_STATUSES, errors);
    validateEnumField(values, 'usageState', DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES, errors);
  }
  validatePairs(values, bigBag ? bigBagNumericPairs : shiftNumericPairs, errors, 'number');
  validatePairs(values, bigBag ? bigBagDatePairs : shiftDatePairs, errors, 'date');
  return errors;
}

const allNumericKeys = new Set<string>([
  ...shiftNonNegativeNumberKeys,
  ...shiftCountKeys,
  ...shiftSignedNumberKeys,
  ...bigBagNonNegativeNumberKeys,
  ...bigBagCountKeys,
  ...bigBagSignedNumberKeys,
]);

function assignDraftToQuery(
  query: Record<string, unknown>,
  draft: EvidenceFilterDraft,
  keys: readonly string[],
): void {
  const values = valuesOf(draft);
  for (const key of keys) {
    const value = values[key]!.trim();
    if (!value) continue;
    query[key] = allNumericKeys.has(key) ? Number(value) : value;
  }
}

export function buildShiftEvidenceQuery(
  context: DirectorEvidenceQueryContext,
  draft: DirectorShiftEvidenceFilterDraft,
): EvidenceQueryBuild<DirectorAnalyticsShiftEvidenceQuery> {
  const errors = validateEvidenceFilterDraft(draft);
  if (Object.keys(errors).length > 0) return { ok: false, query: null, errors };
  const query = { ...context } as DirectorAnalyticsShiftEvidenceQuery;
  assignDraftToQuery(query as Record<string, unknown>, draft, shiftFilterKeys);
  return { ok: true, query, errors: {} };
}

export function buildBigBagEvidenceQuery(
  context: DirectorEvidenceQueryContext,
  draft: DirectorBigBagEvidenceFilterDraft,
): EvidenceQueryBuild<DirectorAnalyticsBigBagEvidenceQuery> {
  const errors = validateEvidenceFilterDraft(draft);
  if (Object.keys(errors).length > 0) return { ok: false, query: null, errors };
  const query = { ...context } as DirectorAnalyticsBigBagEvidenceQuery;
  assignDraftToQuery(query as Record<string, unknown>, draft, bigBagFilterKeys);
  return { ok: true, query, errors: {} };
}

function urlKey(namespace: 'sb' | 'bb', key: string): string {
  return `${namespace}_${key}`;
}

function normalizeDraftValue(key: string, value: string): string {
  const trimmed = value.trim();
  return allNumericKeys.has(key) ? String(Number(trimmed)) : trimmed;
}

function parseNamespacedDraft<D extends EvidenceFilterDraft>(
  params: URLSearchParams,
  namespace: 'sb' | 'bb',
  empty: D,
  keys: readonly string[],
): { draft: D; errors: EvidenceFilterErrors } {
  const draft = { ...empty };
  const draftValues = valuesOf(draft);
  const errors: EvidenceFilterErrors = {};
  for (const key of keys) {
    const raw = params.get(urlKey(namespace, key));
    if (raw === null || !raw.trim()) continue;
    const candidate = { ...empty } as D;
    valuesOf(candidate)[key] = raw.trim();
    const fieldErrors = validateEvidenceFilterDraft(candidate);
    if (fieldErrors[key]) {
      errors[key] = fieldErrors[key];
      continue;
    }
    draftValues[key] = normalizeDraftValue(key, raw);
  }
  Object.assign(errors, validateEvidenceFilterDraft(draft));
  return { draft, errors };
}

const LEGACY_EVIDENCE_KEYS = [
  'operatorId',
  'postId',
  'shiftId',
  'bigBagId',
  'status',
  'q',
] as const;

function legacyText(params: URLSearchParams, key: string): string {
  const value = params.get(key)?.trim() ?? '';
  return value.length <= 100 ? value : '';
}

function restoreLegacyFilters(
  params: URLSearchParams,
  shift: DirectorShiftEvidenceFilterDraft,
  bigBag: DirectorBigBagEvidenceFilterDraft,
): void {
  const q = legacyText(params, 'q');
  const operator = legacyText(params, 'operatorId');
  const post = legacyText(params, 'postId');
  const shiftValue = legacyText(params, 'shiftId');
  const bag = legacyText(params, 'bigBagId');
  const status = params.get('status');

  if (!shift.q) shift.q = q || bag;
  if (!bigBag.q) bigBag.q = q;
  if (!shift.operatorQuery) shift.operatorQuery = operator;
  if (!bigBag.operatorQuery) bigBag.operatorQuery = operator;
  if (!shift.postQuery) shift.postQuery = post;
  if (!bigBag.postQuery) bigBag.postQuery = post;
  if (!shift.shiftQuery) shift.shiftQuery = shiftValue;
  if (!bigBag.shiftQuery) bigBag.shiftQuery = shiftValue;
  if (!bigBag.bigBagQuery) bigBag.bigBagQuery = bag;
  if (status && hasKey(DIRECTOR_ANALYTICS_EVIDENCE_STATUSES, status)) {
    if (!shift.status) shift.status = status as DirectorAnalyticsEvidenceStatus;
    if (!bigBag.status) bigBag.status = status as DirectorAnalyticsEvidenceStatus;
  }
}

export function parseDirectorEvidenceLocation(search: string): DirectorEvidenceLocationState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const shiftResult = parseNamespacedDraft(
    params,
    'sb',
    emptyShiftEvidenceFilterDraft,
    shiftFilterKeys,
  );
  const bigBagResult = parseNamespacedDraft(
    params,
    'bb',
    emptyBigBagEvidenceFilterDraft,
    bigBagFilterKeys,
  );
  restoreLegacyFilters(params, shiftResult.draft, bigBagResult.draft);
  Object.assign(shiftResult.errors, validateEvidenceFilterDraft(shiftResult.draft));
  Object.assign(bigBagResult.errors, validateEvidenceFilterDraft(bigBagResult.draft));
  return {
    shiftOpen: params.get('sb_open') === '1',
    bigBagOpen: params.get('bb_open') === '1',
    shift: shiftResult.draft,
    bigBag: bigBagResult.draft,
    errors: {
      shift: shiftResult.errors,
      bigBag: bigBagResult.errors,
    },
  };
}

function deleteOwnedEvidenceParams(params: URLSearchParams): void {
  params.delete('sb_open');
  params.delete('bb_open');
  params.delete('sb_cursor');
  params.delete('bb_cursor');
  for (const key of shiftFilterKeys) params.delete(urlKey('sb', key));
  for (const key of bigBagFilterKeys) params.delete(urlKey('bb', key));
  for (const key of LEGACY_EVIDENCE_KEYS) params.delete(key);
}

function serializeDraft(
  params: URLSearchParams,
  namespace: 'sb' | 'bb',
  draft: EvidenceFilterDraft,
  keys: readonly string[],
): void {
  const errors = validateEvidenceFilterDraft(draft);
  const values = valuesOf(draft);
  for (const key of keys) {
    const value = values[key]!.trim();
    if (!value || errors[key]) continue;
    params.set(urlKey(namespace, key), normalizeDraftValue(key, value));
  }
}

export function serializeDirectorEvidenceLocation(
  currentSearch: string,
  state: DirectorEvidenceLocationDraft,
): string {
  const params = new URLSearchParams(
    currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch,
  );
  deleteOwnedEvidenceParams(params);
  if (state.shiftOpen) params.set('sb_open', '1');
  serializeDraft(params, 'sb', state.shift, shiftFilterKeys);
  if (state.bigBagOpen) params.set('bb_open', '1');
  serializeDraft(params, 'bb', state.bigBag, bigBagFilterKeys);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}
