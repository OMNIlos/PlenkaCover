import {
  buildDirectorAccountingProduction,
  isKilogramUnit,
  type DirectorAccountingProductionPrisma,
} from './director-accounting-production';
import { parseDirectorAnalyticsRange } from './director-analytics.time';

type Report = {
  date: Date | null;
  outputLines: Array<{ quantity: { toString(): string }; unitName: string | null }>;
  materialLines: Array<{ quantity: { toString(): string }; unitName: string | null }>;
};

function decimal(value: number) {
  return { toString: () => String(value) };
}

function report(
  date: string,
  outputLines: Report['outputLines'] = [],
  materialLines: Report['materialLines'] = [],
): Report {
  return { date: new Date(date), outputLines, materialLines };
}

function createPrisma() {
  return {
    oneCProductionReport: {
      findMany: jest.fn<Promise<Report[]>, [unknown]>(),
      findFirst: jest.fn<Promise<{ date: Date | null } | null>, [unknown]>(),
    },
    oneCSyncRun: {
      findMany: jest.fn<
        Promise<Array<{ completedAt: Date | null; counters: unknown }>>,
        [unknown]
      >(),
    },
  };
}

function accountingPrisma(prisma: ReturnType<typeof createPrisma>) {
  return prisma as unknown as DirectorAccountingProductionPrisma;
}

describe('director accounting production aggregate', () => {
  const query = { from: '2026-06-30', to: '2026-07-02', bucket: 'day' as const };

  it('aggregates only posted non-deleted kilogram lines in Moscow buckets', async () => {
    const prisma = createPrisma();
    prisma.oneCProductionReport.findMany.mockResolvedValue([
      report(
        '2026-06-30T10:00:00.000Z',
        [
          { quantity: decimal(125.5), unitName: 'кг' },
          { quantity: decimal(10), unitName: 'шт.' },
        ],
        [{ quantity: decimal(84.6), unitName: ' Килограмм. ' }],
      ),
    ]);
    prisma.oneCProductionReport.findFirst.mockResolvedValue({
      date: new Date('2026-07-15T12:00:00.000Z'),
    });
    prisma.oneCSyncRun.findMany.mockResolvedValue([
      {
        completedAt: new Date('2026-07-29T12:00:00.000Z'),
        counters: { production_report: { fetched: 1 } },
      },
    ]);

    const result = await buildDirectorAccountingProduction(
      accountingPrisma(prisma),
      parseDirectorAnalyticsRange(query),
      new Date('2026-07-29T12:00:00.000Z'),
    );

    expect(prisma.oneCProductionReport.findMany).toHaveBeenCalledWith({
      where: {
        date: {
          gte: new Date('2026-06-29T21:00:00.000Z'),
          lt: new Date('2026-07-02T21:00:00.000Z'),
        },
        posted: true,
        deleted: false,
      },
      select: {
        date: true,
        outputLines: { select: { quantity: true, unitName: true } },
        materialLines: { select: { quantity: true, unitName: true } },
      },
    });
    expect(result.productionSeries).toEqual([
      { bucketStartDate: '2026-06-30', documentCount: 1, producedKg: 125.5 },
      { bucketStartDate: '2026-07-01', documentCount: 0, producedKg: 0 },
      { bucketStartDate: '2026-07-02', documentCount: 0, producedKg: 0 },
    ]);
    expect(result.materialSeries).toEqual([
      { bucketStartDate: '2026-06-30', consumedKg: 84.6 },
      { bucketStartDate: '2026-07-01', consumedKg: 0 },
      { bucketStartDate: '2026-07-02', consumedKg: 0 },
    ]);
    expect(result.coverage).toEqual({
      documentCount: 1,
      excludedOutputLineCount: 1,
      excludedMaterialLineCount: 0,
    });
  });

  it.each([
    [
      'day',
      [
        '2026-07-22',
        '2026-07-23',
        '2026-07-24',
        '2026-07-25',
        '2026-07-26',
        '2026-07-27',
        '2026-07-28',
        '2026-07-29',
        '2026-07-30',
        '2026-07-31',
        '2026-08-01',
        '2026-08-02',
        '2026-08-03',
        '2026-08-04',
      ],
    ],
    ['week', ['2026-07-20', '2026-07-27', '2026-08-03']],
    ['month', ['2026-07-01', '2026-08-01']],
  ] as const)(
    'keeps every requested %s bucket when there are no accounting documents',
    async (bucket, bucketStartDates) => {
      const prisma = createPrisma();
      prisma.oneCProductionReport.findMany.mockResolvedValue([]);
      prisma.oneCProductionReport.findFirst.mockResolvedValue(null);
      prisma.oneCSyncRun.findMany.mockResolvedValue([]);

      const result = await buildDirectorAccountingProduction(
        accountingPrisma(prisma),
        parseDirectorAnalyticsRange({ from: '2026-07-22', to: '2026-08-04', bucket }),
      );

      expect(result.productionSeries).toEqual(
        bucketStartDates.map((bucketStartDate) => ({
          bucketStartDate,
          documentCount: 0,
          producedKg: 0,
        })),
      );
      expect(result.materialSeries).toEqual(
        bucketStartDates.map((bucketStartDate) => ({ bucketStartDate, consumedKg: 0 })),
      );
    },
  );

  it('rounds kilogram totals to three decimals and excludes every non-kilogram line', async () => {
    const prisma = createPrisma();
    prisma.oneCProductionReport.findMany.mockResolvedValue([
      report(
        '2026-07-01T10:00:00.000Z',
        [
          { quantity: decimal(1.1114), unitName: 'кг.' },
          { quantity: decimal(2.2224), unitName: 'килограмм' },
          { quantity: decimal(5), unitName: 'тонна' },
        ],
        [
          { quantity: decimal(3.3334), unitName: 'КГ' },
          { quantity: decimal(6), unitName: null },
        ],
      ),
    ]);
    prisma.oneCProductionReport.findFirst.mockResolvedValue(null);
    prisma.oneCSyncRun.findMany.mockResolvedValue([]);

    const result = await buildDirectorAccountingProduction(
      accountingPrisma(prisma),
      parseDirectorAnalyticsRange({ from: '2026-07-01', to: '2026-07-01', bucket: 'day' }),
    );

    expect(result.productionSeries[0]).toEqual({
      bucketStartDate: '2026-07-01',
      documentCount: 1,
      producedKg: 3.334,
    });
    expect(result.materialSeries[0]).toEqual({ bucketStartDate: '2026-07-01', consumedKg: 3.333 });
    expect(result.coverage).toEqual({
      documentCount: 1,
      excludedOutputLineCount: 1,
      excludedMaterialLineCount: 1,
    });
  });

  it('uses the global latest posted non-deleted document date', async () => {
    const prisma = createPrisma();
    prisma.oneCProductionReport.findMany.mockResolvedValue([]);
    prisma.oneCProductionReport.findFirst.mockResolvedValue({
      date: new Date('2026-08-01T09:30:00.000Z'),
    });
    prisma.oneCSyncRun.findMany.mockResolvedValue([]);

    const result = await buildDirectorAccountingProduction(
      accountingPrisma(prisma),
      parseDirectorAnalyticsRange(query),
    );

    expect(prisma.oneCProductionReport.findFirst).toHaveBeenCalledWith({
      where: { posted: true, deleted: false, date: { not: null } },
      select: { date: true },
      orderBy: { date: 'desc' },
    });
    expect(result.source.latestDocumentDate).toBe('2026-08-01T09:30:00.000Z');
  });

  it('keeps successful unchanged sync fresh for exactly 24 hours', async () => {
    const prisma = createPrisma();
    prisma.oneCProductionReport.findMany.mockResolvedValue([]);
    prisma.oneCProductionReport.findFirst.mockResolvedValue(null);
    prisma.oneCSyncRun.findMany.mockResolvedValue([
      {
        completedAt: new Date('2026-07-29T12:00:00.000Z'),
        counters: { production_report: { fetched: 0, unchanged: 1 } },
      },
    ]);

    const result = await buildDirectorAccountingProduction(
      accountingPrisma(prisma),
      parseDirectorAnalyticsRange(query),
      new Date('2026-07-30T11:59:59.999Z'),
    );

    expect(result.source).toMatchObject({
      latestImportedAt: '2026-07-29T12:00:00.000Z',
      stale: false,
    });
  });

  it('marks the source stale when the 24-hour TTL expires', async () => {
    const prisma = createPrisma();
    prisma.oneCProductionReport.findMany.mockResolvedValue([]);
    prisma.oneCProductionReport.findFirst.mockResolvedValue(null);
    prisma.oneCSyncRun.findMany.mockResolvedValue([
      { completedAt: new Date('2026-07-29T12:00:00.000Z'), counters: { production_report: {} } },
    ]);

    const result = await buildDirectorAccountingProduction(
      accountingPrisma(prisma),
      parseDirectorAnalyticsRange(query),
      new Date('2026-07-30T12:00:00.000Z'),
    );

    expect(result.source.stale).toBe(true);
  });

  it('bounds freshness to the 100 newest successful applicable runs and keeps output safe', async () => {
    const prisma = createPrisma();
    prisma.oneCProductionReport.findMany.mockResolvedValue([]);
    prisma.oneCProductionReport.findFirst.mockResolvedValue(null);
    prisma.oneCSyncRun.findMany.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        completedAt: new Date(
          `2026-07-${String(29 - Math.floor(index / 24)).padStart(2, '0')}T${String(
            23 - (index % 24),
          ).padStart(2, '0')}:00:00.000Z`,
        ),
        counters: index === 37 ? { production_report: { unchanged: 1 } } : { invoice: {} },
      })),
    );

    const result = await buildDirectorAccountingProduction(
      accountingPrisma(prisma),
      parseDirectorAnalyticsRange(query),
    );

    expect(prisma.oneCSyncRun.findMany).toHaveBeenCalledWith({
      where: {
        status: 'completed',
        mode: { in: ['apply', 'scheduled'] },
        completedAt: { not: null },
      },
      select: { completedAt: true, counters: true },
      orderBy: { completedAt: 'desc' },
      take: 100,
    });
    expect(result.source.latestImportedAt).toBe('2026-07-28T10:00:00.000Z');
    expect(JSON.stringify(result)).not.toMatch(
      /rawPayload|externalId|organizationExternalId|warehouseExternalId|departmentExternalId|price|cost|amount|Ответственный/,
    );
    expect(result).toMatchObject({
      source: { sourceKind: '1C', label: '1С · Отчет производства за смену' },
    });
  });
});

describe('isKilogramUnit', () => {
  it.each([
    ['кг', true],
    [' КГ. ', true],
    ['килограмм', true],
    ['килограммы', false],
    ['тонна', false],
    [null, false],
  ])('classifies %p', (unitName, expected) => {
    expect(isKilogramUnit(unitName)).toBe(expected);
  });
});
