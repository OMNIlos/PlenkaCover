import type {
  DirectorAccountingMaterialPoint,
  DirectorAccountingProduction,
  DirectorAccountingProductionPoint,
} from '@plenka/contracts';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  directorAnalyticsBucketKey,
  enumerateDirectorAnalyticsBuckets,
  type ParsedDirectorAnalyticsRange,
} from './director-analytics.time';

const SOURCE_TTL_MS = 24 * 60 * 60 * 1_000;
const PRODUCTION_REPORT_COUNTER = 'production_report';

type Quantity = { toString(): string };

export type DirectorAccountingProductionPrisma = Pick<
  PrismaService,
  'oneCProductionReport' | 'oneCSyncRun'
>;

type BucketTotals = {
  documentCount: number;
  producedKg: number;
  consumedKg: number;
};

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function quantityAsNumber(quantity: Quantity): number {
  const value = Number(quantity.toString());
  return Number.isFinite(value) ? value : 0;
}

function hasProductionReportCounter(counters: unknown): boolean {
  return (
    typeof counters === 'object' &&
    counters !== null &&
    Object.prototype.hasOwnProperty.call(counters, PRODUCTION_REPORT_COUNTER)
  );
}

export function isKilogramUnit(unitName: string | null): boolean {
  const normalized = unitName?.trim().toLocaleLowerCase('ru-RU').replaceAll('.', '') ?? '';
  return normalized === 'кг' || normalized === 'килограмм';
}

export async function buildDirectorAccountingProduction(
  prisma: DirectorAccountingProductionPrisma,
  range: ParsedDirectorAnalyticsRange,
  now = new Date(),
): Promise<DirectorAccountingProduction> {
  const [reports, latestDocument, syncRuns] = await Promise.all([
    prisma.oneCProductionReport.findMany({
      where: {
        date: { gte: range.fromUtc, lt: range.toExclusiveUtc },
        posted: true,
        deleted: false,
      },
      select: {
        date: true,
        outputLines: { select: { quantity: true, unitName: true } },
        materialLines: { select: { quantity: true, unitName: true } },
      },
    }),
    prisma.oneCProductionReport.findFirst({
      where: { posted: true, deleted: false, date: { not: null } },
      select: { date: true },
      orderBy: { date: 'desc' },
    }),
    prisma.oneCSyncRun.findMany({
      where: {
        status: 'completed',
        mode: { in: ['apply', 'scheduled'] },
        completedAt: { not: null },
      },
      select: { completedAt: true, counters: true },
      orderBy: { completedAt: 'desc' },
      take: 100,
    }),
  ]);

  const buckets = enumerateDirectorAnalyticsBuckets(range);
  const totals = new Map<string, BucketTotals>(
    buckets.map(({ key }) => [key, { documentCount: 0, producedKg: 0, consumedKg: 0 }]),
  );
  let documentCount = 0;
  let excludedOutputLineCount = 0;
  let excludedMaterialLineCount = 0;

  for (const report of reports) {
    if (!report.date || report.date < range.fromUtc || report.date >= range.toExclusiveUtc)
      continue;

    const bucket = totals.get(directorAnalyticsBucketKey(report.date, range.bucket));
    if (!bucket) continue;

    documentCount += 1;
    bucket.documentCount += 1;

    for (const line of report.outputLines) {
      if (!isKilogramUnit(line.unitName)) {
        excludedOutputLineCount += 1;
        continue;
      }
      bucket.producedKg += quantityAsNumber(line.quantity);
    }

    for (const line of report.materialLines) {
      if (!isKilogramUnit(line.unitName)) {
        excludedMaterialLineCount += 1;
        continue;
      }
      bucket.consumedKg += quantityAsNumber(line.quantity);
    }
  }

  const productionSeries: DirectorAccountingProductionPoint[] = buckets.map(({ key }) => {
    const bucket = totals.get(key)!;
    return {
      bucketStartDate: key,
      documentCount: bucket.documentCount,
      producedKg: round3(bucket.producedKg),
    };
  });
  const materialSeries: DirectorAccountingMaterialPoint[] = buckets.map(({ key }) => ({
    bucketStartDate: key,
    consumedKg: round3(totals.get(key)!.consumedKg),
  }));
  const latestImportedAt = syncRuns.find(
    ({ completedAt, counters }) => completedAt !== null && hasProductionReportCounter(counters),
  )?.completedAt;

  return {
    source: {
      sourceKind: '1C',
      label: '1С · Отчет производства за смену',
      latestImportedAt: latestImportedAt?.toISOString() ?? null,
      latestDocumentDate: latestDocument?.date?.toISOString() ?? null,
      stale: !latestImportedAt || now.getTime() >= latestImportedAt.getTime() + SOURCE_TTL_MS,
    },
    coverage: { documentCount, excludedOutputLineCount, excludedMaterialLineCount },
    productionSeries,
    materialSeries,
  };
}
