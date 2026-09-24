import type {
  ServerDirectorAnalyticsMaterialPoint,
  ServerDirectorAnalyticsProductionPoint,
} from '../../api/director';

const AXIS_INTERVALS = 4;
const NICE_STEP_FACTORS = [1, 2, 2.5, 4, 5, 8, 10] as const;

export type DirectorChartUnit = 'kg' | 'count';

export type DirectorChartScale = {
  maximum: number;
  ticks: number[];
};

export type DirectorAnalyticsPresentation = {
  productionBars: Array<{
    bucketStartDate: string;
    magnitudePercent: number;
    negative: boolean;
    rollMagnitudePercent: number;
    rollNegative: boolean;
  }>;
  materialBars: Array<{
    bucketStartDate: string;
    expectedMagnitudePercent: number;
    expectedNegative: boolean;
    actualMagnitudePercent: number;
    actualNegative: boolean;
  }>;
};

function maximumMagnitude(values: number[]): number {
  return Math.max(0, ...values.map((value) => Math.abs(value)));
}

function roundChartValue(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentOfMagnitude(value: number, maximum: number): number {
  if (maximum === 0 || value === 0) return 0;
  return roundChartValue((Math.abs(value) / maximum) * 100);
}

export function buildDirectorChartScale(
  values: number[],
  unit: DirectorChartUnit,
): DirectorChartScale {
  const maximumValue = maximumMagnitude(values);
  if (maximumValue === 0) return { maximum: 0, ticks: [0] };

  let step: number;
  if (unit === 'count') {
    step = Math.max(1, Math.ceil(maximumValue / AXIS_INTERVALS));
  } else {
    const rawStep = maximumValue / AXIS_INTERVALS;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalizedStep = rawStep / magnitude;
    const factor =
      NICE_STEP_FACTORS.find((candidate) => candidate >= normalizedStep) ??
      NICE_STEP_FACTORS[NICE_STEP_FACTORS.length - 1];
    step = factor * magnitude;
  }

  const maximum = roundChartValue(step * AXIS_INTERVALS);
  return {
    maximum,
    ticks: Array.from({ length: AXIS_INTERVALS + 1 }, (_, index) =>
      roundChartValue(maximum - index * step),
    ),
  };
}

export function directorChartMagnitudePercent(
  value: number,
  scale: DirectorChartScale,
): number {
  return percentOfMagnitude(value, scale.maximum);
}

function productionBars(
  series: ServerDirectorAnalyticsProductionPoint[],
): DirectorAnalyticsPresentation['productionBars'] {
  const maximumKg = maximumMagnitude(series.map((point) => point.producedKg));
  const maximumRolls = maximumMagnitude(series.map((point) => point.rollCount));
  return series.map((point) => ({
    bucketStartDate: point.bucketStartDate,
    magnitudePercent: percentOfMagnitude(point.producedKg, maximumKg),
    negative: point.producedKg < 0,
    rollMagnitudePercent: percentOfMagnitude(point.rollCount, maximumRolls),
    rollNegative: point.rollCount < 0,
  }));
}

function materialBars(
  series: ServerDirectorAnalyticsMaterialPoint[],
): DirectorAnalyticsPresentation['materialBars'] {
  const maximum = maximumMagnitude(
    series.flatMap((point) => [point.expectedUsageKg, point.actualUsageKg]),
  );
  return series.map((point) => ({
    bucketStartDate: point.bucketStartDate,
    expectedMagnitudePercent: percentOfMagnitude(point.expectedUsageKg, maximum),
    expectedNegative: point.expectedUsageKg < 0,
    actualMagnitudePercent: percentOfMagnitude(point.actualUsageKg, maximum),
    actualNegative: point.actualUsageKg < 0,
  }));
}

export function projectDirectorAnalyticsPresentation(input: {
  productionSeries: ServerDirectorAnalyticsProductionPoint[];
  materialSeries: ServerDirectorAnalyticsMaterialPoint[];
}): DirectorAnalyticsPresentation {
  return {
    productionBars: productionBars(input.productionSeries),
    materialBars: materialBars(input.materialSeries),
  };
}
