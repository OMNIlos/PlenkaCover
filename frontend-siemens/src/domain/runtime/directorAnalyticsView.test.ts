import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ServerDirectorAnalyticsResponse } from '../../api/director';
import {
  DirectorAnalyticsRequestGate,
  type ProjectedDirectorAnalyticsView,
  defaultDirectorAnalyticsBucket,
  directorAnalyticsLoadReducer,
  directorRangeForPreset,
  initialDirectorAnalyticsLoadState,
  normalizeDirectorDateRange,
  parseDirectorAnalyticsLocation,
  projectDirectorAnalytics,
  serializeDirectorAnalyticsLocation,
  updateDirectorDateRangeBoundary,
} from './directorAnalyticsView';

function analyticsResponse(
  overrides: Partial<ServerDirectorAnalyticsResponse> = {},
): ServerDirectorAnalyticsResponse {
  return {
    range: {
      timezone: 'Europe/Moscow',
      requested: { from: '2026-07-20', to: '2026-07-21' },
      effective: {
        fromUtc: '2026-07-19T21:00:00.000Z',
        toExclusiveUtc: '2026-07-21T21:00:00.000Z',
      },
      bucket: 'day',
      generatedAt: '2026-07-21T19:00:00.000Z',
    },
    productionSeries: [
      { bucketStartDate: '2026-07-20', rollCount: 0, producedKg: 0 },
      { bucketStartDate: '2026-07-21', rollCount: 3, producedKg: 82.8 },
    ],
    materialSeries: [
      { bucketStartDate: '2026-07-20', expectedUsageKg: 0, actualUsageKg: -4.5 },
      { bucketStartDate: '2026-07-21', expectedUsageKg: 82.8, actualUsageKg: 80.25 },
    ],
    shiftBalances: [
      {
        sessionId: 'session-1',
        shiftId: null,
        shiftLabel: null,
        operatorId: 'operator-1',
        operatorName: 'Оператор',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'Экструдер 1',
        startedAt: '2026-07-21T06:00:00.000Z',
        endedAt: '2026-07-21T14:00:00.000Z',
        rollCount: 3,
        producedKg: 82.8,
        expectedUsageKg: 82.8,
        actualUsageKg: null,
        deviationPercent: null,
        status: 'pending',
        payroll: {
          status: 'unresolved',
          reasons: ['material_class_unresolved'],
        },
      },
    ],
    bigBags: [
      {
        id: 'bag-1',
        code: 'BB-1',
        materialId: null,
        material: 'ПНД',
        status: 'in_use',
        initialKg: 1_000,
        priceKopecksPerKg: null,
        totalKopecks: null,
        priceEffectiveAt: null,
        currentSnapshot: { measuredKg: null, measuredAt: null },
        usageHistory: [
          {
            id: 'usage-1',
            sessionId: 'session-1',
            shiftId: null,
            shiftLabel: null,
            operatorId: 'operator-1',
            operatorName: 'Оператор',
            postId: 'post-1',
            postCode: 'POST-1',
            postName: 'Экструдер 1',
            startKg: 100,
            endKg: null,
            deltaKg: null,
            openedAt: '2026-07-21T06:00:00.000Z',
            closedAt: null,
          },
        ],
      },
    ],
    operatorOverPlan: {
      series: [
        {
          bucketStartDate: '2026-07-21',
          affectedRollCount: 1,
          affectedOperatorCount: 1,
          overPlanKg: 5,
        },
      ],
      totals: [
        {
          period: 'week',
          fromDate: '2026-07-15',
          toDate: '2026-07-21',
          affectedRollCount: 1,
          affectedOperatorCount: 1,
          overPlanKg: 5,
        },
      ],
      topOperators: [
        {
          operatorId: 'operator-1',
          operatorName: 'Оператор',
          affectedRollCount: 1,
          overPlanKg: 5,
        },
      ],
      missingPlanCount: 1,
      missingActorCount: 2,
    },
    productionQualitySeries: [
      {
        id: 'day:2026-07-21',
        bucketStartDate: '2026-07-21',
        producedRollCount: 3,
        producedKg: 82.8,
        defectRecordCount: 2,
        defectiveRollCount: 1,
        verifiedDefectKg: 27.6,
        unverifiedDefectCount: 1,
      },
    ],
    materialSpendSeries: [
      {
        bucketStartDate: '2026-07-21',
        consumedGranulesKg: 80.25,
        recordedSpoolCount: 2,
        recordedSpoolTareKg: 3.4,
        missingSpoolEvidenceCount: 1,
      },
    ],
    spoolEvidence: {
      availability: 'measured_evidence_only',
      explanation: 'Measured production evidence only.',
    },
    commercialApplications: {
      definition: 'submitted',
      asOfDate: '2026-07-21',
      periods: [
        {
          period: 'week',
          fromDate: '2026-07-15',
          toDate: '2026-07-21',
          totalCount: 4,
          clientOrderCount: 3,
          stockReserveCount: 1,
        },
      ],
    },
    accountingProduction: {
      source: {
        sourceKind: '1C',
        label: '1С · Отчет производства за смену',
        latestImportedAt: '2026-07-21T18:00:00.000Z',
        latestDocumentDate: '2026-07-21T09:00:00.000Z',
        stale: false,
      },
      coverage: {
        documentCount: 2,
        excludedOutputLineCount: 1,
        excludedMaterialLineCount: 3,
      },
      productionSeries: [
        {
          bucketStartDate: '2026-07-21',
          documentCount: 2,
          producedKg: 82.8,
        },
      ],
      materialSeries: [{ bucketStartDate: '2026-07-21', consumedKg: 80.25 }],
    },
    ...overrides,
  };
}

describe('director analytics Moscow ranges', () => {
  const afterMoscowMidnight = new Date('2026-07-21T21:30:00.000Z');

  it('derives today and yesterday from the Moscow calendar date', () => {
    expect(directorRangeForPreset('today', afterMoscowMidnight)).toEqual({
      preset: 'today',
      from: '2026-07-22',
      to: '2026-07-22',
    });
    expect(directorRangeForPreset('yesterday', afterMoscowMidnight)).toEqual({
      preset: 'yesterday',
      from: '2026-07-21',
      to: '2026-07-21',
    });
  });

  it('uses the current Moscow Monday and month start for week and month presets', () => {
    expect(directorRangeForPreset('week', afterMoscowMidnight)).toEqual({
      preset: 'week',
      from: '2026-07-20',
      to: '2026-07-22',
    });
    expect(directorRangeForPreset('month', afterMoscowMidnight)).toEqual({
      preset: 'month',
      from: '2026-07-01',
      to: '2026-07-22',
    });
  });

  it('normalizes custom order and caps the inclusive range at 366 real dates', () => {
    expect(
      directorRangeForPreset('custom', afterMoscowMidnight, {
        from: '2026-07-20',
        to: '2026-07-02',
      }),
    ).toEqual({ preset: 'custom', from: '2026-07-02', to: '2026-07-20' });

    expect(
      normalizeDirectorDateRange({
        preset: 'custom',
        from: '2024-01-01',
        to: '2024-12-31',
      }),
    ).toEqual({ preset: 'custom', from: '2024-01-01', to: '2024-12-31' });

    expect(
      normalizeDirectorDateRange({
        preset: 'custom',
        from: '2024-01-01',
        to: '2025-01-01',
      }),
    ).toEqual({ preset: 'custom', from: '2024-01-02', to: '2025-01-01' });
  });

  it('rejects impossible date-only values instead of silently shifting them', () => {
    expect(() =>
      normalizeDirectorDateRange({
        preset: 'custom',
        from: '2026-02-30',
        to: '2026-03-01',
      }),
    ).toThrow('YYYY-MM-DD');
  });

  it('lets either date field relocate a custom interval into historical data', () => {
    const relocated = updateDirectorDateRangeBoundary(
      { preset: 'custom', from: '2026-07-01', to: '2026-07-22' },
      'from',
      '2024-01-01',
    );
    expect(relocated).toEqual({ preset: 'custom', from: '2024-01-01', to: '2024-01-01' });

    expect(updateDirectorDateRangeBoundary(relocated, 'to', '2024-01-31')).toEqual({
      preset: 'custom',
      from: '2024-01-01',
      to: '2024-01-31',
    });
  });
});

describe('director analytics recoverable URL state', () => {
  it('restores period and grouping as distinct concepts', () => {
    expect(parseDirectorAnalyticsLocation('?period=week&bucket=day')).toEqual({
      period: 'week',
      bucket: 'day',
    });
  });

  it('round-trips only period state and never writes legacy shared evidence filters', () => {
    const search = serializeDirectorAnalyticsLocation(
      {
        period: 'custom',
        from: '2026-07-01',
        to: '2026-07-24',
        bucket: 'week',
        operatorId: 'operator-1',
        postId: 'post-1',
        shiftId: 'shift-1',
        bigBagId: 'bag-1',
        status: 'mismatch',
        q: 'Ночная смена',
      },
      '?role=director&section=%D0%9A%D0%BE%D0%BD%D1%82%D1%80%D0%BE%D0%BB%D1%8C',
    );

    expect(search).toContain('role=director');
    expect(search).toContain('section=');
    expect(search).not.toMatch(/[?&](operatorId|postId|shiftId|bigBagId|status|q)=/u);
    expect(parseDirectorAnalyticsLocation(search)).toEqual({
      period: 'custom',
      from: '2026-07-01',
      to: '2026-07-24',
      bucket: 'week',
    });
  });

  it('chooses a readable default bucket for short and long ranges', () => {
    expect(
      defaultDirectorAnalyticsBucket({
        preset: 'week',
        from: '2026-07-20',
        to: '2026-07-24',
      }),
    ).toBe('day');
    expect(
      defaultDirectorAnalyticsBucket({
        preset: 'custom',
        from: '2026-01-01',
        to: '2026-07-24',
      }),
    ).toBe('month');
  });
});

describe('director analytics truthful view', () => {
  it('keeps exact server numbers, including zero, negative and nullable facts', () => {
    const response = analyticsResponse();

    const view = projectDirectorAnalytics(response);

    expect(view.productionSeries).toEqual(response.productionSeries);
    expect(view.materialSeries).toEqual(response.materialSeries);
    expect(view.materialSeries[0]).toMatchObject({
      expectedUsageKg: 0,
      actualUsageKg: -4.5,
    });
    expect(view.shiftBalances[0]).toMatchObject({
      actualUsageKg: null,
      deviationPercent: null,
      payroll: {
        status: 'unresolved',
        reasons: ['material_class_unresolved'],
      },
    });
    expect(view.bigBags[0]).toMatchObject({
      currentSnapshot: { measuredKg: null, measuredAt: null },
      usageHistory: [{ endKg: null, deltaKg: null, closedAt: null }],
    });
    expect(view.operatorOverPlan).toEqual(response.operatorOverPlan);
    expect(view.productionQualitySeries).toEqual(response.productionQualitySeries);
    expect(view.materialSpendSeries).toEqual(response.materialSpendSeries);
    expect(view.spoolEvidence).toEqual(response.spoolEvidence);
    expect(view.commercialApplications).toEqual(response.commercialApplications);
  });

  it('deep-copies every server array and nested V2 structure', () => {
    const response = analyticsResponse();
    const view = projectDirectorAnalytics(response);

    expect(view.productionSeries).not.toBe(response.productionSeries);
    expect(view.materialSeries).not.toBe(response.materialSeries);
    expect(view.shiftBalances).not.toBe(response.shiftBalances);
    expect(view.shiftBalances[0]?.payroll).not.toBe(response.shiftBalances[0]?.payroll);
    if (
      view.shiftBalances[0]?.payroll.status === 'unresolved' &&
      response.shiftBalances[0]?.payroll.status === 'unresolved'
    ) {
      expect(view.shiftBalances[0].payroll.reasons).not.toBe(
        response.shiftBalances[0].payroll.reasons,
      );
    }
    expect(view.bigBags).not.toBe(response.bigBags);
    expect(view.bigBags[0]?.currentSnapshot).not.toBe(response.bigBags[0]?.currentSnapshot);
    expect(view.bigBags[0]?.usageHistory).not.toBe(response.bigBags[0]?.usageHistory);
    expect(view.operatorOverPlan).not.toBe(response.operatorOverPlan);
    expect(view.operatorOverPlan.series).not.toBe(response.operatorOverPlan.series);
    expect(view.operatorOverPlan.series[0]).not.toBe(response.operatorOverPlan.series[0]);
    expect(view.operatorOverPlan.totals).not.toBe(response.operatorOverPlan.totals);
    expect(view.operatorOverPlan.topOperators).not.toBe(response.operatorOverPlan.topOperators);
    expect(view.productionQualitySeries).not.toBe(response.productionQualitySeries);
    expect(view.productionQualitySeries[0]).not.toBe(response.productionQualitySeries[0]);
    expect(view.materialSpendSeries).not.toBe(response.materialSpendSeries);
    expect(view.materialSpendSeries[0]).not.toBe(response.materialSpendSeries[0]);
    expect(view.spoolEvidence).not.toBe(response.spoolEvidence);
    expect(view.commercialApplications).not.toBe(response.commercialApplications);
    expect(view.commercialApplications.periods).not.toBe(response.commercialApplications.periods);
    expect(view.commercialApplications.periods[0]).not.toBe(
      response.commercialApplications.periods[0],
    );
    expect(view.accountingProduction).not.toBe(response.accountingProduction);
    expect(view.accountingProduction.source).not.toBe(response.accountingProduction.source);
    expect(view.accountingProduction.coverage).not.toBe(response.accountingProduction.coverage);
    expect(view.accountingProduction.productionSeries).not.toBe(
      response.accountingProduction.productionSeries,
    );
    expect(view.accountingProduction.productionSeries[0]).not.toBe(
      response.accountingProduction.productionSeries[0],
    );
    expect(view.accountingProduction.materialSeries).not.toBe(
      response.accountingProduction.materialSeries,
    );
    expect(view.accountingProduction.materialSeries[0]).not.toBe(
      response.accountingProduction.materialSeries[0],
    );

    response.operatorOverPlan.series[0]!.overPlanKg = 999;
    response.productionQualitySeries[0]!.verifiedDefectKg = 999;
    response.materialSpendSeries[0]!.consumedGranulesKg = 999;
    response.commercialApplications.periods[0]!.totalCount = 999;
    response.accountingProduction.source.stale = true;
    response.accountingProduction.coverage.documentCount = 999;
    response.accountingProduction.productionSeries[0]!.producedKg = 999;
    response.accountingProduction.materialSeries[0]!.consumedKg = 999;

    expect(view.operatorOverPlan.series[0]?.overPlanKg).toBe(5);
    expect(view.productionQualitySeries[0]?.verifiedDefectKg).toBe(27.6);
    expect(view.materialSpendSeries[0]?.consumedGranulesKg).toBe(80.25);
    expect(view.commercialApplications.periods[0]?.totalCount).toBe(4);
    expect(view.accountingProduction.source.stale).toBe(false);
    expect(view.accountingProduction.coverage.documentCount).toBe(2);
    expect(view.accountingProduction.productionSeries[0]?.producedKg).toBe(82.8);
    expect(view.accountingProduction.materialSeries[0]?.consumedKg).toBe(80.25);
  });

  it('normalizes only separate presentation bars and preserves negative direction', () => {
    const view = projectDirectorAnalytics(analyticsResponse());

    expect(view.presentation.productionBars).toEqual([
      {
        bucketStartDate: '2026-07-20',
        magnitudePercent: 0,
        negative: false,
        rollMagnitudePercent: 0,
        rollNegative: false,
      },
      {
        bucketStartDate: '2026-07-21',
        magnitudePercent: 100,
        negative: false,
        rollMagnitudePercent: 100,
        rollNegative: false,
      },
    ]);
    expect(view.presentation.materialBars).toEqual([
      {
        bucketStartDate: '2026-07-20',
        expectedMagnitudePercent: 0,
        expectedNegative: false,
        actualMagnitudePercent: 5.435,
        actualNegative: true,
      },
      {
        bucketStartDate: '2026-07-21',
        expectedMagnitudePercent: 100,
        expectedNegative: false,
        actualMagnitudePercent: 96.92,
        actualNegative: false,
      },
    ]);
  });

  it('contains none of the legacy live-data coefficient constants', () => {
    const source = readFileSync(new URL('./directorAnalyticsView.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b0\.(?:17|2|82|84)\b/u);
  });
});

describe('director analytics load state', () => {
  it('ignores stale completion and accepts only the current request generation', () => {
    let state = directorAnalyticsLoadReducer(initialDirectorAnalyticsLoadState, {
      type: 'load_started',
      generation: 1,
    });
    state = directorAnalyticsLoadReducer(state, { type: 'load_started', generation: 2 });

    const afterStale = directorAnalyticsLoadReducer(state, {
      type: 'load_succeeded',
      generation: 1,
      response: analyticsResponse(),
    });
    expect(afterStale).toBe(state);

    const ready = directorAnalyticsLoadReducer(state, {
      type: 'load_succeeded',
      generation: 2,
      response: analyticsResponse(),
    });
    expect(ready).toMatchObject({ status: 'ready', generation: 2, error: null });
    if (ready.status !== 'ready') throw new Error('Expected a ready analytics state.');
    expectTypeOf(ready.view).toEqualTypeOf<ProjectedDirectorAnalyticsView>();
  });

  it('keeps the charts on screen while the next period loads', () => {
    // Dropping the view collapsed the whole analytics section to a loading row
    // on every reload, which is one of the three rows that read as flicker.
    const ready = directorAnalyticsLoadReducer(
      directorAnalyticsLoadReducer(initialDirectorAnalyticsLoadState, {
        type: 'load_started',
        generation: 1,
      }),
      { type: 'load_succeeded', generation: 1, response: analyticsResponse() },
    );
    if (ready.status !== 'ready') throw new Error('Expected a ready analytics state.');

    const reloading = directorAnalyticsLoadReducer(ready, {
      type: 'load_started',
      generation: 2,
    });

    expect(reloading.status).toBe('loading');
    expect(reloading.view).toBe(ready.view);
  });

  it('distinguishes a zero-filled empty response and clears old data on retryable error', () => {
    const emptyResponse = analyticsResponse({
      productionSeries: [{ bucketStartDate: '2026-07-21', rollCount: 0, producedKg: 0 }],
      materialSeries: [{ bucketStartDate: '2026-07-21', expectedUsageKg: 0, actualUsageKg: 0 }],
      shiftBalances: [],
      bigBags: [],
      operatorOverPlan: {
        series: [],
        totals: [],
        topOperators: [],
        missingPlanCount: 0,
        missingActorCount: 0,
      },
      productionQualitySeries: [],
      materialSpendSeries: [],
      commercialApplications: {
        definition: 'submitted',
        asOfDate: '2026-07-21',
        periods: [],
      },
      accountingProduction: {
        source: {
          sourceKind: '1C',
          label: '1С · Отчет производства за смену',
          latestImportedAt: null,
          latestDocumentDate: null,
          stale: true,
        },
        coverage: {
          documentCount: 0,
          excludedOutputLineCount: 0,
          excludedMaterialLineCount: 0,
        },
        productionSeries: [],
        materialSeries: [],
      },
    });
    let state = directorAnalyticsLoadReducer(initialDirectorAnalyticsLoadState, {
      type: 'load_started',
      generation: 1,
    });
    state = directorAnalyticsLoadReducer(state, {
      type: 'load_succeeded',
      generation: 1,
      response: emptyResponse,
    });
    expect(state).toMatchObject({ status: 'empty', view: expect.any(Object) });

    state = directorAnalyticsLoadReducer(state, { type: 'load_started', generation: 2 });
    // The reload keeps the previous view; only an outright failure clears it.
    expect(state).toMatchObject({ status: 'loading', view: expect.any(Object), error: null });
    state = directorAnalyticsLoadReducer(state, {
      type: 'load_failed',
      generation: 2,
      message: 'Сервис временно недоступен',
    });
    expect(state).toEqual({
      status: 'error',
      generation: 2,
      view: null,
      error: 'Сервис временно недоступен',
    });
  });

  it.each([
    {
      label: 'submitted application',
      overrides: {
        commercialApplications: {
          definition: 'submitted' as const,
          asOfDate: '2026-07-21',
          periods: [
            {
              period: 'week' as const,
              fromDate: '2026-07-15',
              toDate: '2026-07-21',
              totalCount: 1,
              clientOrderCount: 1,
              stockReserveCount: 0,
            },
          ],
        },
      },
    },
    {
      label: 'missing-plan partial counter',
      overrides: {
        operatorOverPlan: {
          series: [],
          totals: [],
          topOperators: [],
          missingPlanCount: 1,
          missingActorCount: 0,
        },
      },
    },
    {
      label: 'verified defect fact',
      overrides: {
        productionQualitySeries: [
          {
            id: 'day:2026-07-21',
            bucketStartDate: '2026-07-21',
            producedRollCount: 0,
            producedKg: 0,
            defectRecordCount: 1,
            defectiveRollCount: 1,
            verifiedDefectKg: 7,
            unverifiedDefectCount: 0,
          },
        ],
      },
    },
    {
      label: 'over-plan fact',
      overrides: {
        operatorOverPlan: {
          series: [
            {
              bucketStartDate: '2026-07-21',
              affectedRollCount: 1,
              affectedOperatorCount: 1,
              overPlanKg: 5,
            },
          ],
          totals: [],
          topOperators: [],
          missingPlanCount: 0,
          missingActorCount: 0,
        },
      },
    },
  ])('keeps the report ready when it contains a $label', ({ overrides }) => {
    const otherwiseEmpty = analyticsResponse({
      productionSeries: [],
      materialSeries: [],
      shiftBalances: [],
      bigBags: [],
      operatorOverPlan: {
        series: [],
        totals: [],
        topOperators: [],
        missingPlanCount: 0,
        missingActorCount: 0,
      },
      productionQualitySeries: [],
      materialSpendSeries: [],
      commercialApplications: {
        definition: 'submitted',
        asOfDate: '2026-07-21',
        periods: [],
      },
      accountingProduction: {
        source: {
          sourceKind: '1C',
          label: '1С · Отчет производства за смену',
          latestImportedAt: null,
          latestDocumentDate: null,
          stale: true,
        },
        coverage: {
          documentCount: 0,
          excludedOutputLineCount: 0,
          excludedMaterialLineCount: 0,
        },
        productionSeries: [],
        materialSeries: [],
      },
      ...overrides,
    });
    let state = directorAnalyticsLoadReducer(initialDirectorAnalyticsLoadState, {
      type: 'load_started',
      generation: 1,
    });
    state = directorAnalyticsLoadReducer(state, {
      type: 'load_succeeded',
      generation: 1,
      response: otherwiseEmpty,
    });

    expect(state.status).toBe('ready');
  });

  it.each([
    {
      label: 'document count',
      accountingProduction: {
        coverage: {
          documentCount: 2,
          excludedOutputLineCount: 0,
          excludedMaterialLineCount: 0,
        },
        productionSeries: [],
        materialSeries: [],
      },
    },
    {
      label: 'produced kilograms',
      accountingProduction: {
        coverage: {
          documentCount: 0,
          excludedOutputLineCount: 0,
          excludedMaterialLineCount: 0,
        },
        productionSeries: [
          {
            bucketStartDate: '2026-07-21',
            documentCount: 0,
            producedKg: 5,
          },
        ],
        materialSeries: [],
      },
    },
    {
      label: 'consumed kilograms',
      accountingProduction: {
        coverage: {
          documentCount: 0,
          excludedOutputLineCount: 0,
          excludedMaterialLineCount: 0,
        },
        productionSeries: [],
        materialSeries: [{ bucketStartDate: '2026-07-21', consumedKg: -4.5 }],
      },
    },
  ])('keeps an accounting-only response ready for $label', ({ accountingProduction }) => {
    const response = analyticsResponse({
      productionSeries: [],
      materialSeries: [],
      shiftBalances: [],
      bigBags: [],
      operatorOverPlan: {
        series: [],
        totals: [],
        topOperators: [],
        missingPlanCount: 0,
        missingActorCount: 0,
      },
      productionQualitySeries: [],
      materialSpendSeries: [],
      commercialApplications: {
        definition: 'submitted',
        asOfDate: '2026-07-21',
        periods: [],
      },
      accountingProduction: {
        source: {
          sourceKind: '1C',
          label: '1С · Отчет производства за смену',
          latestImportedAt: '2026-07-21T18:00:00.000Z',
          latestDocumentDate: '2026-07-21T09:00:00.000Z',
          stale: false,
        },
        ...accountingProduction,
      },
    });
    let state = directorAnalyticsLoadReducer(initialDirectorAnalyticsLoadState, {
      type: 'load_started',
      generation: 1,
    });
    state = directorAnalyticsLoadReducer(state, {
      type: 'load_succeeded',
      generation: 1,
      response,
    });

    expect(state.status).toBe('ready');
  });

  it('provides a monotonic gate for asynchronous request handlers', () => {
    const gate = new DirectorAnalyticsRequestGate();
    const slow = gate.begin();
    const current = gate.begin();

    expect(gate.isCurrent(slow)).toBe(false);
    expect(gate.isCurrent(current)).toBe(true);
    gate.invalidate(current);
    expect(gate.isCurrent(current)).toBe(false);
  });
});
