import { describe, expect, it } from 'vitest';

import type {
  ServerDirectorAnalyticsMaterialPoint,
  ServerDirectorAnalyticsProductionPoint,
} from '../../api/director';
import {
  buildDirectorChartScale,
  directorChartMagnitudePercent,
  projectDirectorAnalyticsPresentation,
} from './directorAnalyticsPresentation';

const productionSeries: ServerDirectorAnalyticsProductionPoint[] = [
  { bucketStartDate: '2026-07-20', rollCount: 0, producedKg: 0 },
  { bucketStartDate: '2026-07-21', rollCount: 3, producedKg: 82.8 },
];

const materialSeries: ServerDirectorAnalyticsMaterialPoint[] = [
  { bucketStartDate: '2026-07-20', expectedUsageKg: 0, actualUsageKg: -4.5 },
  { bucketStartDate: '2026-07-21', expectedUsageKg: 82.8, actualUsageKg: 80.25 },
];

describe('director analytics presentation', () => {
  it('builds five rounded ticks with the visible unit scale', () => {
    expect(buildDirectorChartScale([0, 137], 'kg')).toEqual({
      maximum: 160,
      ticks: [160, 120, 80, 40, 0],
    });
    expect(buildDirectorChartScale([0, 3], 'count')).toEqual({
      maximum: 4,
      ticks: [4, 3, 2, 1, 0],
    });
    expect(buildDirectorChartScale([], 'kg')).toEqual({ maximum: 0, ticks: [0] });
  });

  it('projects magnitude against the rounded scale without losing negative direction', () => {
    const scale = buildDirectorChartScale([0, 137], 'kg');

    expect(directorChartMagnitudePercent(137, scale)).toBe(85.625);
    expect(directorChartMagnitudePercent(-40, scale)).toBe(25);
    expect(directorChartMagnitudePercent(1, { maximum: 0, ticks: [0] })).toBe(0);
  });

  it('keeps chart-only normalization separate from exact server series', () => {
    const presentation = projectDirectorAnalyticsPresentation({
      productionSeries,
      materialSeries,
    });

    expect(presentation.productionBars).toEqual([
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
    expect(presentation.materialBars).toEqual([
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
    expect(productionSeries[1]).toEqual({
      bucketStartDate: '2026-07-21',
      rollCount: 3,
      producedKg: 82.8,
    });
    expect(materialSeries[0]?.actualUsageKg).toBe(-4.5);
  });
});
