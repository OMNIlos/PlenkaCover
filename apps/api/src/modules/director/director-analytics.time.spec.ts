import {
  DIRECTOR_ANALYTICS_FIXED_PERIODS,
  DIRECTOR_APPLICATION_PERIODS,
  DIRECTOR_ROLL_PROVENANCE,
} from '@plenka/contracts';
import {
  DIRECTOR_ANALYTICS_MIN_AS_OF_DATE,
  directorAnalyticsBucketKey,
  directorAnalyticsFixedWindows,
  enumerateDirectorAnalyticsBuckets,
  isSupportedDirectorAnalyticsAsOfDate,
  isStrictDirectorAnalyticsDate,
  parseDirectorAnalyticsRange,
} from './director-analytics.time';

describe('director analytics Moscow time helpers', () => {
  it('publishes the fixed period and roll provenance vocabularies', () => {
    expect(DIRECTOR_ANALYTICS_FIXED_PERIODS).toEqual(['week', 'month']);
    expect(DIRECTOR_APPLICATION_PERIODS).toEqual(['week', 'month', '3_months', '6_months']);
    expect(DIRECTOR_ROLL_PROVENANCE).toEqual([
      'post_session',
      'operation_actor',
      'actor_missing',
      'plan_missing',
    ]);
  });

  it('builds the approved fixed windows ending on the Moscow as-of date', () => {
    expect(directorAnalyticsFixedWindows('2026-07-24')).toEqual([
      { period: 'week', fromDate: '2026-07-18', toDate: '2026-07-24' },
      { period: 'month', fromDate: '2026-06-25', toDate: '2026-07-24' },
      { period: '3_months', fromDate: '2026-04-24', toDate: '2026-07-24' },
      { period: '6_months', fromDate: '2026-01-24', toDate: '2026-07-24' },
    ]);
  });

  it('clamps fixed calendar-month windows at month ends', () => {
    expect(directorAnalyticsFixedWindows('2024-02-29')[2].fromDate).toBe('2023-11-29');
    expect(directorAnalyticsFixedWindows('2026-05-31')[2].fromDate).toBe('2026-02-28');
  });

  it('rejects fixed windows that cross below the supported calendar year', () => {
    expect(() => directorAnalyticsFixedWindows('0001-01-01')).toThrow(RangeError);
  });

  it('publishes the earliest representable six-month analytics as-of date', () => {
    expect(DIRECTOR_ANALYTICS_MIN_AS_OF_DATE).toBe('0001-07-01');
    expect(directorAnalyticsFixedWindows(DIRECTOR_ANALYTICS_MIN_AS_OF_DATE)[3]).toEqual({
      period: '6_months',
      fromDate: '0001-01-01',
      toDate: '0001-07-01',
    });
  });

  it.each([
    ['0001-01-01', false],
    ['0001-06-30', false],
    ['0001-07-01', true],
    ['2026-07-24', true],
    ['9999-12-31', false],
  ])('classifies %s as a supported analytics as-of date', (value, expected) => {
    expect(isSupportedDirectorAnalyticsAsOfDate(value)).toBe(expected);
  });

  it.each([
    ['2024-02-29', true],
    ['2023-02-29', false],
    ['2026-04-31', false],
    ['2026-13-01', false],
    ['2026-00-01', false],
    ['2026-7-01', false],
    ['2026-07-1', false],
    ['2026-07-01T00:00:00Z', false],
    ['9999-12-31', false],
  ])('validates %s as a strict real calendar date', (value, expected) => {
    expect(isStrictDirectorAnalyticsDate(value)).toBe(expected);
  });

  it('maps inclusive Moscow dates to one half-open UTC interval', () => {
    const range = parseDirectorAnalyticsRange({
      from: '2026-07-21',
      to: '2026-07-22',
      bucket: 'day',
    });

    expect(range).toMatchObject({
      from: '2026-07-21',
      to: '2026-07-22',
      bucket: 'day',
      timezone: 'Europe/Moscow',
    });
    expect(range.fromUtc.toISOString()).toBe('2026-07-20T21:00:00.000Z');
    expect(range.toExclusiveUtc.toISOString()).toBe('2026-07-22T21:00:00.000Z');
  });

  it('keeps year 9999 private to the upper boundary of the last public date', () => {
    const range = parseDirectorAnalyticsRange({
      from: '9998-12-31',
      to: '9998-12-31',
      bucket: 'day',
    });

    expect(range.fromUtc.toISOString()).toBe('9998-12-30T21:00:00.000Z');
    expect(range.toExclusiveUtc.toISOString()).toBe('9998-12-31T21:00:00.000Z');
    expect(enumerateDirectorAnalyticsBuckets(range)).toEqual([
      {
        key: '9998-12-31',
        startUtc: new Date('9998-12-30T21:00:00.000Z'),
        endUtc: new Date('9998-12-31T21:00:00.000Z'),
      },
    ]);
    expect(isStrictDirectorAnalyticsDate('9999-01-01')).toBe(false);
  });

  it.each(['day', 'week', 'month'] as const)(
    'enumerates the last public date with a natural %s bucket boundary',
    (bucket) => {
      const range = parseDirectorAnalyticsRange({
        from: '9998-12-31',
        to: '9998-12-31',
        bucket,
      });

      expect(() => enumerateDirectorAnalyticsBuckets(range)).not.toThrow();
      const intervals = enumerateDirectorAnalyticsBuckets(range);
      expect(intervals).toEqual([
        expect.objectContaining({
          startUtc: expect.any(Date),
          endUtc: expect.any(Date),
        }),
      ]);
      expect(intervals[0].endUtc.getTime()).toBeGreaterThan(intervals[0].startUtc.getTime());
    },
  );

  it.each([
    ['2026-07-19T20:59:59.999Z', 'day', '2026-07-19'],
    ['2026-07-19T21:00:00.000Z', 'day', '2026-07-20'],
    ['2026-07-22T10:00:00.000Z', 'week', '2026-07-20'],
    ['2026-01-01T00:00:00.000Z', 'week', '2025-12-29'],
    ['2026-07-31T21:00:00.000Z', 'month', '2026-08-01'],
  ] as const)('maps %s to the natural Moscow %s bucket', (iso, bucket, expected) => {
    expect(directorAnalyticsBucketKey(new Date(iso), bucket)).toBe(expected);
  });

  it.each([
    {
      query: { from: '2026-07-21', to: '2026-07-23', bucket: 'day' as const },
      expected: ['2026-07-21', '2026-07-22', '2026-07-23'],
    },
    {
      query: { from: '2026-07-22', to: '2026-08-04', bucket: 'week' as const },
      expected: ['2026-07-20', '2026-07-27', '2026-08-03'],
    },
    {
      query: { from: '2026-01-31', to: '2026-03-01', bucket: 'month' as const },
      expected: ['2026-01-01', '2026-02-01', '2026-03-01'],
    },
  ])('enumerates natural zero-fill bucket starts', ({ query, expected }) => {
    const buckets = enumerateDirectorAnalyticsBuckets(parseDirectorAnalyticsRange(query));

    expect(buckets.map(({ key }) => key)).toEqual(expected);
    expect(buckets.every(({ startUtc, endUtc }) => startUtc < endUtc)).toBe(true);
  });
});
