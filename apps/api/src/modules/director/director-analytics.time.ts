import {
  DIRECTOR_ANALYTICS_BUCKETS,
  type DirectorAnalyticsBucket,
  type DirectorAnalyticsQuery,
} from '@plenka/contracts';

export const DIRECTOR_ANALYTICS_TIMEZONE = 'Europe/Moscow' as const;
export const DIRECTOR_ANALYTICS_MAX_INCLUSIVE_DAYS = 366;
export const DIRECTOR_ANALYTICS_MAX_YEAR = 9998;
export const DIRECTOR_ANALYTICS_MIN_AS_OF_DATE = '0001-07-01';

const DIRECTOR_ANALYTICS_INTERNAL_BOUNDARY_MAX_YEAR = DIRECTOR_ANALYTICS_MAX_YEAR + 1;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

export type ParsedDirectorAnalyticsRange = DirectorAnalyticsQuery & {
  timezone: typeof DIRECTOR_ANALYTICS_TIMEZONE;
  fromUtc: Date;
  toExclusiveUtc: Date;
};

export type DirectorAnalyticsBucketInterval = {
  key: string;
  startUtc: Date;
  endUtc: Date;
};

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseCalendarDateThrough(value: string, maxYear: number): CalendarDate | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    year > maxYear ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }
  return { year, month, day };
}

function parseCalendarDate(value: string): CalendarDate | null {
  return parseCalendarDateThrough(value, DIRECTOR_ANALYTICS_MAX_YEAR);
}

function parseInternalBoundaryDate(value: string): CalendarDate | null {
  return parseCalendarDateThrough(value, DIRECTOR_ANALYTICS_INTERNAL_BOUNDARY_MAX_YEAR);
}

function calendarUtcMillis({ year, month, day }: CalendarDate) {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value.getTime();
}

function formatCalendarDate({ year, month, day }: CalendarDate) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function calendarDateFromUtcMillis(value: number): CalendarDate {
  const date = new Date(value);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function addCalendarDays(value: string, days: number) {
  const parsed = parseCalendarDate(value);
  if (!parsed) throw new RangeError(`Invalid calendar date: ${value}`);
  return formatCalendarDate(calendarDateFromUtcMillis(calendarUtcMillis(parsed) + days * DAY_MS));
}

function addCalendarMonths(value: string, months: number) {
  const parsed = parseCalendarDate(value);
  if (!parsed) throw new RangeError(`Invalid calendar date: ${value}`);
  const monthIndex = parsed.year * 12 + parsed.month - 1 + months;
  return formatCalendarDate({
    year: Math.floor(monthIndex / 12),
    month: (monthIndex % 12) + 1,
    day: 1,
  });
}

function subtractClampedCalendarMonths(value: string, months: number): string {
  const parsed = parseCalendarDate(value);
  if (!parsed) throw new RangeError(`Invalid calendar date: ${value}`);
  const sourceMonth = parsed.year * 12 + parsed.month - 1;
  const targetMonth = sourceMonth - months;
  const year = Math.floor(targetMonth / 12);
  if (year < 1) throw new RangeError(`Calendar month subtraction out of range: ${value}`);
  const month = (targetMonth % 12) + 1;
  return formatCalendarDate({
    year,
    month,
    day: Math.min(parsed.day, daysInMonth(year, month)),
  });
}

function nextBucketStart(key: string, bucket: DirectorAnalyticsBucket) {
  if (bucket === 'day') return addCalendarDays(key, 1);
  if (bucket === 'week') return addCalendarDays(key, 7);
  return addCalendarMonths(key, 1);
}

export function isStrictDirectorAnalyticsDate(value: unknown): value is string {
  return typeof value === 'string' && parseCalendarDate(value) !== null;
}

export function isSupportedDirectorAnalyticsAsOfDate(value: unknown): value is string {
  return isStrictDirectorAnalyticsDate(value) && value >= DIRECTOR_ANALYTICS_MIN_AS_OF_DATE;
}

export function directorAnalyticsInclusiveDays(from: string, to: string) {
  const fromDate = parseCalendarDate(from);
  const toDate = parseCalendarDate(to);
  if (!fromDate || !toDate) return null;
  return Math.round((calendarUtcMillis(toDate) - calendarUtcMillis(fromDate)) / DAY_MS) + 1;
}

export function directorAnalyticsFixedWindows(asOfDate: string) {
  if (!isSupportedDirectorAnalyticsAsOfDate(asOfDate)) {
    throw new RangeError(`Unsupported analytics as-of date: ${asOfDate}`);
  }
  return [
    { period: 'week' as const, fromDate: addCalendarDays(asOfDate, -6), toDate: asOfDate },
    { period: 'month' as const, fromDate: addCalendarDays(asOfDate, -29), toDate: asOfDate },
    {
      period: '3_months' as const,
      fromDate: subtractClampedCalendarMonths(asOfDate, 3),
      toDate: asOfDate,
    },
    {
      period: '6_months' as const,
      fromDate: subtractClampedCalendarMonths(asOfDate, 6),
      toDate: asOfDate,
    },
  ];
}

export function moscowDateToUtcStart(value: string) {
  const parsed = parseCalendarDate(value);
  if (!parsed) throw new RangeError(`Invalid Moscow date: ${value}`);
  return new Date(calendarUtcMillis(parsed) - MOSCOW_OFFSET_MS);
}

function moscowBoundaryDateToUtcStart(value: string) {
  const parsed = parseInternalBoundaryDate(value);
  if (!parsed) throw new RangeError(`Invalid internal Moscow boundary: ${value}`);
  return new Date(calendarUtcMillis(parsed) - MOSCOW_OFFSET_MS);
}

export function parseDirectorAnalyticsRange(
  query: DirectorAnalyticsQuery,
): ParsedDirectorAnalyticsRange {
  const inclusiveDays = directorAnalyticsInclusiveDays(query.from, query.to);
  if (
    inclusiveDays === null ||
    inclusiveDays < 1 ||
    inclusiveDays > DIRECTOR_ANALYTICS_MAX_INCLUSIVE_DAYS ||
    !DIRECTOR_ANALYTICS_BUCKETS.includes(query.bucket)
  ) {
    throw new RangeError('Invalid director analytics range.');
  }

  return {
    ...query,
    timezone: DIRECTOR_ANALYTICS_TIMEZONE,
    fromUtc: moscowDateToUtcStart(query.from),
    toExclusiveUtc: moscowBoundaryDateToUtcStart(addCalendarDays(query.to, 1)),
  };
}

export function directorAnalyticsBucketKey(date: Date, bucket: DirectorAnalyticsBucket) {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid analytics timestamp.');
  const local = calendarDateFromUtcMillis(date.getTime() + MOSCOW_OFFSET_MS);
  if (bucket === 'day') return formatCalendarDate(local);
  if (bucket === 'month') return formatCalendarDate({ ...local, day: 1 });

  const weekday = new Date(calendarUtcMillis(local)).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return addCalendarDays(formatCalendarDate(local), -daysSinceMonday);
}

export function enumerateDirectorAnalyticsBuckets(
  range: ParsedDirectorAnalyticsRange,
): DirectorAnalyticsBucketInterval[] {
  const firstKey = directorAnalyticsBucketKey(range.fromUtc, range.bucket);
  const lastKey = directorAnalyticsBucketKey(
    new Date(range.toExclusiveUtc.getTime() - 1),
    range.bucket,
  );
  const result: DirectorAnalyticsBucketInterval[] = [];

  for (let key = firstKey; key <= lastKey; key = nextBucketStart(key, range.bucket)) {
    const nextKey = nextBucketStart(key, range.bucket);
    result.push({
      key,
      startUtc: moscowDateToUtcStart(key),
      endUtc: moscowBoundaryDateToUtcStart(nextKey),
    });
  }
  return result;
}
