import type {
  ServerDirectorAccountingProduction,
  ServerDirectorAnalyticsMaterialSpendPoint,
  ServerDirectorAnalyticsProductionQualityPoint,
} from '../../../api/director';

type AccountingProductionPoint = ServerDirectorAccountingProduction['productionSeries'][number];
type AccountingMaterialPoint = ServerDirectorAccountingProduction['materialSeries'][number];

export type DirectorProductionComparisonRow = {
  bucketStartDate: string;
  physical: ServerDirectorAnalyticsProductionQualityPoint;
  accounting: AccountingProductionPoint;
};

export type DirectorMaterialComparisonRow = {
  bucketStartDate: string;
  physical: ServerDirectorAnalyticsMaterialSpendPoint;
  accounting: AccountingMaterialPoint;
};

function sortedBucketStartDates(
  physicalDates: Iterable<string>,
  accountingDates: Iterable<string>,
): string[] {
  const bucketDates = new Set<string>();
  for (const bucketStartDate of physicalDates) {
    bucketDates.add(bucketStartDate);
  }
  for (const bucketStartDate of accountingDates) {
    bucketDates.add(bucketStartDate);
  }
  return [...bucketDates].sort((left, right) => left.localeCompare(right));
}

export function buildDirectorProductionComparisonRows(
  series: ServerDirectorAnalyticsProductionQualityPoint[],
  accountingSeries: AccountingProductionPoint[],
): DirectorProductionComparisonRow[] {
  const physicalByBucket = new Map(series.map((point) => [point.bucketStartDate, point]));
  const accountingByBucket = new Map(
    accountingSeries.map((point) => [point.bucketStartDate, point]),
  );

  return sortedBucketStartDates(physicalByBucket.keys(), accountingByBucket.keys()).map(
    (bucketStartDate) => ({
      bucketStartDate,
      physical: physicalByBucket.get(bucketStartDate) ?? {
        id: `empty:${bucketStartDate}`,
        bucketStartDate,
        producedRollCount: 0,
        producedKg: 0,
        defectRecordCount: 0,
        defectiveRollCount: 0,
        verifiedDefectKg: 0,
        unverifiedDefectCount: 0,
      },
      accounting: accountingByBucket.get(bucketStartDate) ?? {
        bucketStartDate,
        documentCount: 0,
        producedKg: 0,
      },
    }),
  );
}

export function buildDirectorMaterialComparisonRows(
  series: ServerDirectorAnalyticsMaterialSpendPoint[],
  accountingSeries: AccountingMaterialPoint[],
): DirectorMaterialComparisonRow[] {
  const physicalByBucket = new Map(series.map((point) => [point.bucketStartDate, point]));
  const accountingByBucket = new Map(
    accountingSeries.map((point) => [point.bucketStartDate, point]),
  );

  return sortedBucketStartDates(physicalByBucket.keys(), accountingByBucket.keys()).map(
    (bucketStartDate) => ({
      bucketStartDate,
      physical: physicalByBucket.get(bucketStartDate) ?? {
        bucketStartDate,
        consumedGranulesKg: 0,
        recordedSpoolCount: 0,
        recordedSpoolTareKg: 0,
        missingSpoolEvidenceCount: 0,
      },
      accounting: accountingByBucket.get(bucketStartDate) ?? {
        bucketStartDate,
        consumedKg: 0,
      },
    }),
  );
}
