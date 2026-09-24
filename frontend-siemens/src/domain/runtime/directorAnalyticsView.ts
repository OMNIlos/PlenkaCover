import type {
  DirectorAnalyticsBucket,
  DirectorAnalyticsEvidenceStatus,
  ServerDirectorAnalyticsBigBag,
  ServerDirectorAnalyticsMaterialPoint,
  ServerDirectorAnalyticsProductionPoint,
  ServerDirectorAnalyticsResponse,
  ServerDirectorAnalyticsShiftBalance,
} from '../../api/director';
import {
  projectDirectorAnalyticsPresentation,
  type DirectorAnalyticsPresentation,
} from './directorAnalyticsPresentation';
import { businessClockAt } from './businessClock';

export type { DirectorAnalyticsPresentation } from './directorAnalyticsPresentation';

const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

export type DirectorRangePreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

export type DirectorDateRange = {
  preset: DirectorRangePreset;
  from: string;
  to: string;
};

export type DirectorAnalyticsLocationState = {
  period?: DirectorRangePreset;
  from?: string;
  to?: string;
  bucket?: DirectorAnalyticsBucket;
  operatorId?: string;
  postId?: string;
  shiftId?: string;
  bigBagId?: string;
  status?: DirectorAnalyticsEvidenceStatus;
  q?: string;
};

export type DirectorAnalyticsEvidenceFilters = {
  operatorId: string;
  postId: string;
  shiftId: string;
  bigBagId: string;
  status: '' | DirectorAnalyticsEvidenceStatus;
  q: string;
};

export const emptyDirectorAnalyticsEvidenceFilters: DirectorAnalyticsEvidenceFilters = {
  operatorId: '',
  postId: '',
  shiftId: '',
  bigBagId: '',
  status: '',
  q: '',
};

type DirectorAnalyticsLegacyView = {
  range: ServerDirectorAnalyticsResponse['range'];
  productionSeries: ServerDirectorAnalyticsProductionPoint[];
  materialSeries: ServerDirectorAnalyticsMaterialPoint[];
  shiftBalances: ServerDirectorAnalyticsShiftBalance[];
  bigBags: ServerDirectorAnalyticsBigBag[];
  presentation: DirectorAnalyticsPresentation;
};

type DirectorAnalyticsV2View = Pick<
  ServerDirectorAnalyticsResponse,
  | 'operatorOverPlan'
  | 'productionQualitySeries'
  | 'materialSpendSeries'
  | 'spoolEvidence'
  | 'commercialApplications'
  | 'accountingProduction'
>;

/**
 * Compatibility shape for components that only consume the original evidence panels.
 * Projected load-state views always use the required V2 shape below.
 */
export type DirectorAnalyticsView = DirectorAnalyticsLegacyView & Partial<DirectorAnalyticsV2View>;

export type ProjectedDirectorAnalyticsView = DirectorAnalyticsLegacyView & DirectorAnalyticsV2View;

export type DirectorAnalyticsState =
  | {
      status: 'loading';
      generation: number;
      /** The previous period's charts, kept on screen while the next one loads. */
      view: ProjectedDirectorAnalyticsView | null;
      error: null;
    }
  | {
      status: 'ready' | 'empty';
      generation: number;
      view: ProjectedDirectorAnalyticsView;
      error: null;
    }
  | {
      status: 'error';
      generation: number;
      view: null;
      error: string;
    };

export type DirectorAnalyticsAction =
  | { type: 'load_started'; generation: number }
  | {
      type: 'load_succeeded';
      generation: number;
      response: ServerDirectorAnalyticsResponse;
    }
  | { type: 'load_failed'; generation: number; message: string };

export const initialDirectorAnalyticsState: DirectorAnalyticsState = {
  status: 'loading',
  generation: 0,
  view: null,
  error: null,
};

function parseDateKey(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new RangeError('Date must be a real YYYY-MM-DD value.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError('Date must be a real YYYY-MM-DD value.');
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function dateKeyFromDay(day: number): string {
  const date = new Date(day * DAY_MS);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dateOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${dateOfMonth}`;
}

function validDateKey(value: string | null): value is string {
  if (value === null) return false;
  try {
    parseDateKey(value);
    return true;
  } catch {
    return false;
  }
}

function nonEmptyParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

export function parseDirectorAnalyticsLocation(search: string): DirectorAnalyticsLocationState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const state: DirectorAnalyticsLocationState = {};
  const period = params.get('period');
  if (
    period === 'today' ||
    period === 'yesterday' ||
    period === 'week' ||
    period === 'month' ||
    period === 'custom'
  ) {
    state.period = period;
  }
  const bucket = params.get('bucket');
  if (bucket === 'day' || bucket === 'week' || bucket === 'month') state.bucket = bucket;
  const from = params.get('from');
  const to = params.get('to');
  if (validDateKey(from) && validDateKey(to)) {
    state.from = from;
    state.to = to;
  }
  const status = params.get('status');
  if (status === 'pending' || status === 'ok' || status === 'mismatch') state.status = status;
  for (const key of ['operatorId', 'postId', 'shiftId', 'bigBagId', 'q'] as const) {
    const value = nonEmptyParam(params, key);
    if (value) state[key] = value;
  }
  return state;
}

const DIRECTOR_ANALYTICS_LOCATION_KEYS = [
  'period',
  'from',
  'to',
  'bucket',
  'operatorId',
  'postId',
  'shiftId',
  'bigBagId',
  'status',
  'q',
] as const;

export function serializeDirectorAnalyticsLocation(
  state: Required<Pick<DirectorAnalyticsLocationState, 'period' | 'bucket'>> &
    DirectorAnalyticsLocationState,
  currentSearch = '',
): string {
  const params = new URLSearchParams(
    currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch,
  );
  for (const key of DIRECTOR_ANALYTICS_LOCATION_KEYS) params.delete(key);
  params.set('period', state.period);
  params.set('bucket', state.bucket);
  if (state.from && state.to) {
    params.set('from', state.from);
    params.set('to', state.to);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function defaultDirectorAnalyticsBucket(range: DirectorDateRange): DirectorAnalyticsBucket {
  const inclusiveDays = parseDateKey(range.to) - parseDateKey(range.from) + 1;
  if (inclusiveDays <= 31) return 'day';
  if (inclusiveDays <= 120) return 'week';
  return 'month';
}

export function normalizeDirectorDateRange(range: DirectorDateRange): DirectorDateRange {
  let fromDay = parseDateKey(range.from);
  let toDay = parseDateKey(range.to);
  if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
  if (toDay - fromDay + 1 > MAX_RANGE_DAYS) fromDay = toDay - MAX_RANGE_DAYS + 1;
  return {
    preset: range.preset,
    from: dateKeyFromDay(fromDay),
    to: dateKeyFromDay(toDay),
  };
}

export function updateDirectorDateRangeBoundary(
  range: DirectorDateRange,
  boundary: 'from' | 'to',
  value: string,
): DirectorDateRange {
  const normalized = normalizeDirectorDateRange({
    ...range,
    preset: 'custom',
    [boundary]: value,
  });
  if (normalized[boundary] === value) return normalized;
  return normalizeDirectorDateRange({ preset: 'custom', from: value, to: value });
}

export function createDirectorAnalyticsRange(
  preset: DirectorRangePreset,
  now = new Date(),
  custom?: Pick<DirectorDateRange, 'from' | 'to'>,
): DirectorDateRange {
  const todayKey = businessClockAt(now).dateIso;
  const today = parseDateKey(todayKey);
  if (preset === 'today') return { preset, from: todayKey, to: todayKey };
  if (preset === 'yesterday') {
    const yesterday = dateKeyFromDay(today - 1);
    return { preset, from: yesterday, to: yesterday };
  }
  if (preset === 'week') {
    const utcDay = new Date(today * DAY_MS).getUTCDay();
    const mondayOffset = (utcDay + 6) % 7;
    return { preset, from: dateKeyFromDay(today - mondayOffset), to: todayKey };
  }
  if (preset === 'month') {
    return { preset, from: `${todayKey.slice(0, 8)}01`, to: todayKey };
  }
  if (custom) return normalizeDirectorDateRange({ preset, ...custom });
  return { preset, from: `${todayKey.slice(0, 8)}01`, to: todayKey };
}

export const directorRangeForPreset = createDirectorAnalyticsRange;

export function projectDirectorAnalytics(
  response: ServerDirectorAnalyticsResponse,
): ProjectedDirectorAnalyticsView {
  const productionSeries = response.productionSeries.map((point) => ({ ...point }));
  const materialSeries = response.materialSeries.map((point) => ({ ...point }));
  return {
    range: {
      ...response.range,
      requested: { ...response.range.requested },
      effective: { ...response.range.effective },
    },
    productionSeries,
    materialSeries,
    shiftBalances: response.shiftBalances.map((balance) => ({
      ...balance,
      payroll:
        balance.payroll.status === 'resolved'
          ? {
              ...balance.payroll,
              tariffOrder: { ...balance.payroll.tariffOrder },
            }
          : {
              ...balance.payroll,
              reasons: [...balance.payroll.reasons],
            },
    })),
    bigBags: response.bigBags.map((bag) => ({
      ...bag,
      currentSnapshot: { ...bag.currentSnapshot },
      usageHistory: bag.usageHistory.map((usage) => ({ ...usage })),
    })),
    operatorOverPlan: {
      ...response.operatorOverPlan,
      series: response.operatorOverPlan.series.map((point) => ({ ...point })),
      totals: response.operatorOverPlan.totals.map((total) => ({ ...total })),
      topOperators: response.operatorOverPlan.topOperators.map((operator) => ({ ...operator })),
    },
    productionQualitySeries: response.productionQualitySeries.map((point) => ({ ...point })),
    materialSpendSeries: response.materialSpendSeries.map((point) => ({ ...point })),
    spoolEvidence: { ...response.spoolEvidence },
    commercialApplications: {
      ...response.commercialApplications,
      periods: response.commercialApplications.periods.map((period) => ({ ...period })),
    },
    accountingProduction: {
      source: { ...response.accountingProduction.source },
      coverage: { ...response.accountingProduction.coverage },
      productionSeries: response.accountingProduction.productionSeries.map((point) => ({
        ...point,
      })),
      materialSeries: response.accountingProduction.materialSeries.map((point) => ({
        ...point,
      })),
    },
    presentation: projectDirectorAnalyticsPresentation({ productionSeries, materialSeries }),
  };
}

function hasNonZeroValue(values: number[]): boolean {
  return values.some((value) => value !== 0);
}

function isEmptyAnalytics(view: ProjectedDirectorAnalyticsView): boolean {
  return (
    view.productionSeries.every((point) => point.rollCount === 0 && point.producedKg === 0) &&
    view.materialSeries.every(
      (point) => point.expectedUsageKg === 0 && point.actualUsageKg === 0,
    ) &&
    view.shiftBalances.length === 0 &&
    view.bigBags.length === 0 &&
    view.operatorOverPlan.missingPlanCount === 0 &&
    view.operatorOverPlan.missingActorCount === 0 &&
    view.operatorOverPlan.topOperators.length === 0 &&
    view.operatorOverPlan.series.every(
      (point) =>
        !hasNonZeroValue([
          point.affectedRollCount,
          point.affectedOperatorCount,
          point.overPlanKg,
        ]),
    ) &&
    view.operatorOverPlan.totals.every(
      (total) =>
        !hasNonZeroValue([
          total.affectedRollCount,
          total.affectedOperatorCount,
          total.overPlanKg,
        ]),
    ) &&
    view.productionQualitySeries.every(
      (point) =>
        !hasNonZeroValue([
          point.producedRollCount,
          point.producedKg,
          point.defectRecordCount,
          point.defectiveRollCount,
          point.verifiedDefectKg,
          point.unverifiedDefectCount,
        ]),
    ) &&
    view.materialSpendSeries.every(
      (point) =>
        !hasNonZeroValue([
          point.consumedGranulesKg,
          point.recordedSpoolCount,
          point.recordedSpoolTareKg,
          point.missingSpoolEvidenceCount,
        ]),
    ) &&
    view.commercialApplications.periods.every(
      (period) =>
        !hasNonZeroValue([
          period.totalCount,
          period.clientOrderCount,
          period.stockReserveCount,
        ]),
    ) &&
    view.accountingProduction.coverage.documentCount === 0 &&
    view.accountingProduction.productionSeries.every((point) => point.producedKg === 0) &&
    view.accountingProduction.materialSeries.every((point) => point.consumedKg === 0)
  );
}

export function directorAnalyticsReducer(
  state: DirectorAnalyticsState,
  action: DirectorAnalyticsAction,
): DirectorAnalyticsState {
  if (action.type === 'load_started') {
    if (action.generation <= state.generation) return state;
    return {
      status: 'loading',
      generation: action.generation,
      // Keep the last good charts up while the next period loads.
      view: state.view,
      error: null,
    };
  }
  if (action.generation !== state.generation) return state;
  if (action.type === 'load_failed') {
    return {
      status: 'error',
      generation: action.generation,
      view: null,
      error: action.message,
    };
  }
  const view = projectDirectorAnalytics(action.response);
  return {
    status: isEmptyAnalytics(view) ? 'empty' : 'ready',
    generation: action.generation,
    view,
    error: null,
  };
}

export class DirectorAnalyticsRequestGate {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  invalidate(generation?: number): void {
    if (generation === undefined || generation === this.generation) this.generation += 1;
  }
}

export const initialDirectorAnalyticsLoadState = initialDirectorAnalyticsState;
export const directorAnalyticsLoadReducer = directorAnalyticsReducer;
