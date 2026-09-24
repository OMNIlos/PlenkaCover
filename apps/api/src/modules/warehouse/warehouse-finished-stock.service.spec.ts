import { BadRequestException } from '@nestjs/common';

import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
} from '../warehouse-coverage/warehouse-coverage-canonical';
import { WarehouseFinishedStockService } from './warehouse-finished-stock.service';

const NOW = new Date('2026-08-06T09:00:00.000Z');
const PROCESSED_CUTOFF = new Date('2026-05-08T09:00:00.000Z');

type ReservationLink =
  | 'reservedForOrderId'
  | 'reservedForPositionId'
  | 'reservedByProposalId'
  | 'reservedByCoverageDecisionId';

interface StockRollOverrides {
  actualWeightMilliKg?: number;
  baseMaterialName?: string | null;
  catalogIngredientNames?: string[];
  createdAt?: Date;
  factSourceOrderId?: string;
  factSourcePositionId?: string;
  fingerprint?: string;
  id?: string;
  recipeDefinitionName?: string;
  recipeName?: string;
  reservationLinks?: Partial<Record<ReservationLink, string | null>>;
  reservedAt?: Date | null;
  rollCode?: string;
  specSourceOrderId?: string;
  specSourcePositionId?: string;
  stockPositionIds?: string[];
}

function stockRoll(overrides: StockRollOverrides = {}) {
  const rollCode = overrides.rollCode ?? 'S-1-roll-1';
  const spec = canonicalizeRollCoverageSpec({
    rollCode,
    sourceOrderId: overrides.specSourceOrderId ?? 'stock-order-1',
    sourcePositionId: overrides.specSourcePositionId ?? 'stock-position-1',
    ownerCounterpartyId: null,
    filmType: 'полотно',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 78_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: 'гост',
    spoolType: '76 мм',
    actualWeightMilliKg: overrides.actualWeightMilliKg ?? 40_500,
    plannedWeightMilliKg: 40_000,
    recipeId: null,
    recipeVersion: 'v3',
    recipeDefinitionId: null,
    recipeDefinitionVersionId: 'recipe-v3',
    recipeVersionNumber: 3,
    ingredients: [{ rawMaterialDefinitionId: 'material-pvd', shareBasisPoints: 10_000 }],
    policyVersion: 'warehouse-coverage-policy/v2',
  });
  return {
    id: overrides.id ?? 'warehouse-roll-1',
    rollCode,
    warehouseStatus: 'received',
    ownerCounterpartyId: null,
    reservedForOrderId: overrides.reservationLinks?.reservedForOrderId ?? null,
    reservedForPositionId: overrides.reservationLinks?.reservedForPositionId ?? null,
    reservedByProposalId: overrides.reservationLinks?.reservedByProposalId ?? null,
    reservedByCoverageDecisionId: overrides.reservationLinks?.reservedByCoverageDecisionId ?? null,
    reservedAt: overrides.reservedAt ?? null,
    producedForStockOrderId: 'stock-order-1',
    currentCoverageFactId: 'fact-1',
    createdAt: overrides.createdAt ?? new Date('2026-07-20T08:00:00.000Z'),
    updatedAt: new Date('2026-07-21T08:00:00.000Z'),
    receivedAt: new Date('2026-07-21T07:30:00.000Z'),
    producedForStockOrder: {
      id: 'stock-order-1',
      orderNumber: 'S-1',
      stockBatchCode: 'STOCK-S-1',
      requestType: 'stock_reserve',
      positions: (overrides.stockPositionIds ?? ['stock-position-1']).map((id) => ({ id })),
    },
    currentCoverageFact: {
      id: 'fact-1',
      version: 1,
      source: 'production_handover',
      specVersion: 'warehouse-roll-coverage/v1',
      specFingerprint: overrides.fingerprint ?? fingerprintRollFact(spec),
      sourceOrderId: overrides.factSourceOrderId ?? 'stock-order-1',
      sourcePositionId: overrides.factSourcePositionId ?? 'stock-position-1',
      createdAt: new Date('2026-07-20T09:00:00.000Z'),
      sourcePosition: {
        baseRawMaterialDefinition:
          overrides.baseMaterialName === null
            ? null
            : { name: overrides.baseMaterialName ?? 'ПВД' },
        recipe: { recipeName: overrides.recipeName ?? 'Рецептура ПВД', ingredients: null },
        recipeDefinitionVersion: {
          recipeDefinition: {
            name: overrides.recipeDefinitionName ?? 'Рецептура ПВД',
          },
          ingredients: (overrides.catalogIngredientNames ?? ['ПВД']).map((name) => ({
            rawMaterialDefinition: { name },
          })),
        },
      },
      spec,
    },
  };
}

function setup(
  pageRows: ReturnType<typeof stockRoll>[] = [stockRoll()],
  provenanceRows: ReturnType<typeof stockRoll>[] = pageRows,
) {
  let pageOffset = 0;
  const prisma: any = {
    warehouseRoll: {
      findMany: jest.fn().mockImplementation(({ select, take, where }) => {
        const isPageRead = Object.prototype.hasOwnProperty.call(select, 'warehouseStatus');
        const rows = isPageRead ? pageRows : provenanceRows;
        const afterId = where?.AND?.find(
          (clause: Record<string, unknown>) =>
            typeof clause.id === 'object' && clause.id !== null && 'gt' in clause.id,
        )?.id.gt;
        const matchingRows = isPageRead
          ? rows.slice(pageOffset)
          : afterId
            ? rows.filter((row) => row.id > afterId)
            : rows;
        if (isPageRead && typeof take === 'number') {
          pageOffset += Math.min(take, matchingRows.length);
        }
        return Promise.resolve(
          typeof take === 'number' ? matchingRows.slice(0, take) : matchingRows,
        );
      }),
    },
  };
  return {
    prisma,
    service: new WarehouseFinishedStockService(prisma),
  };
}

function pageRead(prisma: any) {
  return prisma.warehouseRoll.findMany.mock.calls
    .map(([args]: [Record<string, any>]) => args)
    .find(({ select }: Record<string, any>) =>
      Object.prototype.hasOwnProperty.call(select, 'warehouseStatus'),
    );
}

describe('WarehouseFinishedStockService', () => {
  it('defaults an omitted bucket to strictly available and ignores deprecated availability', async () => {
    const { service, prisma } = setup();

    await service.list({ availability: 'all', limit: 25 }, NOW);

    expect(pageRead(prisma)).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          warehouseStatus: 'received',
          reservedAt: null,
          reservedForOrderId: null,
          reservedForPositionId: null,
          reservedByProposalId: null,
          reservedByCoverageDecisionId: null,
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 26,
      }),
    );
  });

  it('queries processed inventory through all reservation links and requires recent reservedAt', async () => {
    const { service, prisma } = setup([
      stockRoll({
        reservedAt: PROCESSED_CUTOFF,
        reservationLinks: { reservedForOrderId: 'client-order-1' },
      }),
    ]);

    await service.list({ bucket: 'processed', availability: 'all' }, NOW);

    expect(pageRead(prisma)).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          reservedAt: { gte: PROCESSED_CUTOFF },
          OR: [
            { reservedForOrderId: { not: null } },
            { reservedForPositionId: { not: null } },
            { reservedByProposalId: { not: null } },
            { reservedByCoverageDecisionId: { not: null } },
          ],
        }),
        orderBy: [{ reservedAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('uses an inclusive 90-day processed cutoff that excludes one millisecond older rows', async () => {
    const { service, prisma } = setup();

    await service.list({ bucket: 'processed' }, NOW);

    const cutoff = pageRead(prisma).where.reservedAt;
    expect(cutoff).toEqual({ gte: new Date('2026-05-08T09:00:00.000Z') });
    expect(cutoff.gte.getTime()).toBe(new Date('2026-05-08T08:59:59.999Z').getTime() + 1);
  });

  it('returns exact processed totals across bounded provenance chunks', async () => {
    const validRows = [
      stockRoll({
        id: 'summary-roll-000',
        rollCode: 'summary-roll-000',
        actualWeightMilliKg: 38_250,
        reservedAt: new Date('2026-08-05T09:00:00.000Z'),
        reservationLinks: { reservedForOrderId: 'client-order-1' },
      }),
      stockRoll({
        id: 'summary-roll-001',
        rollCode: 'summary-roll-001',
        actualWeightMilliKg: 38_250,
        reservedAt: new Date('2026-08-04T09:00:00.000Z'),
        reservationLinks: { reservedForOrderId: 'client-order-2' },
      }),
      stockRoll({
        id: 'summary-roll-250',
        rollCode: 'summary-roll-250',
        actualWeightMilliKg: 38_250,
        reservedAt: new Date('2026-08-03T09:00:00.000Z'),
        reservationLinks: { reservedForOrderId: 'client-order-3' },
      }),
    ];
    const corruptedRows = Array.from({ length: 248 }, (_, index) => {
      const suffix = (index + 2).toString().padStart(3, '0');
      return stockRoll({
        id: `summary-roll-${suffix}`,
        rollCode: `summary-roll-${suffix}`,
        actualWeightMilliKg: 999_999,
        fingerprint: 'f'.repeat(64),
        reservedAt: new Date('2026-08-02T09:00:00.000Z'),
        reservationLinks: { reservedForOrderId: `client-order-${suffix}` },
      });
    });
    const provenanceRows = [validRows[0], validRows[1], ...corruptedRows, validRows[2]];
    const { service, prisma } = setup([validRows[0]], provenanceRows);

    const result = await service.list({ bucket: 'processed', limit: 100 }, NOW);

    expect(result.summary).toEqual({
      totalCount: 3,
      totalWeightKg: 114.75,
      pageCount: 1,
      pageWeightKg: 38.25,
    });
    expect(pageRead(prisma).take).toBe(101);
    const findManyCalls = prisma.warehouseRoll.findMany.mock.calls as [Record<string, any>][];
    expect(findManyCalls.every(([args]) => args.take)).toBe(true);
    expect(Math.max(...findManyCalls.map(([args]) => args.take))).toBeLessThanOrEqual(251);
    const summaryReads = findManyCalls
      .map(([args]) => args)
      .filter(
        ({ select }: Record<string, any>) =>
          !Object.prototype.hasOwnProperty.call(select, 'warehouseStatus'),
      );
    expect(summaryReads).toHaveLength(2);
    expect(summaryReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: expect.objectContaining({
            reservedAt: { gte: PROCESSED_CUTOFF },
          }),
        }),
      ]),
    );
  });

  it('fills a page from valid rows after corrupt leading provenance without skipping the cursor', async () => {
    const rows = [
      stockRoll({
        id: 'roll-005',
        rollCode: 'ROLL-005',
        createdAt: new Date('2026-08-05T09:00:00.000Z'),
        fingerprint: 'f'.repeat(64),
      }),
      stockRoll({
        id: 'roll-004',
        rollCode: 'ROLL-004',
        createdAt: new Date('2026-08-04T09:00:00.000Z'),
        fingerprint: 'f'.repeat(64),
      }),
      stockRoll({
        id: 'roll-003',
        rollCode: 'ROLL-003',
        createdAt: new Date('2026-08-03T09:00:00.000Z'),
      }),
      stockRoll({
        id: 'roll-002',
        rollCode: 'ROLL-002',
        createdAt: new Date('2026-08-02T09:00:00.000Z'),
      }),
      stockRoll({
        id: 'roll-001',
        rollCode: 'ROLL-001',
        createdAt: new Date('2026-08-01T09:00:00.000Z'),
      }),
    ];
    const { service, prisma } = setup(rows, rows);

    const page = await service.list({ bucket: 'available', limit: 2 }, NOW);

    expect(page.items.map(({ id }) => id)).toEqual(['roll-003', 'roll-002']);
    expect(page.summary).toMatchObject({ totalCount: 3, pageCount: 2 });
    expect(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      bucket: 'available',
      sortAt: '2026-08-02T09:00:00.000Z',
      id: 'roll-002',
    });
    const pageReads = (
      prisma.warehouseRoll.findMany.mock.calls as Array<
        [{ select: Record<string, unknown>; take?: number }]
      >
    )
      .map(([args]) => args)
      .filter(({ select }) => Object.prototype.hasOwnProperty.call(select, 'warehouseStatus'));
    expect(pageReads).toHaveLength(2);
    expect(pageReads.every(({ take }) => take === 3)).toBe(true);
  });

  it('rejects a cursor generated for another lifecycle bucket', async () => {
    const rows = Array.from({ length: 26 }, (_, index) =>
      stockRoll({
        id: `warehouse-roll-${index.toString().padStart(2, '0')}`,
        rollCode: `S-1-roll-${index.toString().padStart(2, '0')}`,
      }),
    );
    const { service } = setup(rows);
    const availablePage = await service.list({ bucket: 'available', limit: 25 }, NOW);

    await expect(
      service.list({ bucket: 'processed', cursor: availablePage.nextCursor! }, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a cancelled reservation with cleared links and reservedAt to available', async () => {
    const cancelled = stockRoll({
      reservedAt: null,
      reservationLinks: {
        reservedForOrderId: null,
        reservedForPositionId: null,
        reservedByProposalId: null,
        reservedByCoverageDecisionId: null,
      },
    });
    const { service } = setup([cancelled]);

    const page = await service.list({ bucket: 'available' }, NOW);

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'warehouse-roll-1',
        processedAt: null,
      }),
    ]);
  });

  it.each([
    {
      label: 'canonical fact fingerprint differs',
      overrides: { fingerprint: 'f'.repeat(64) },
    },
    {
      label: 'fact source order differs from the stock order',
      overrides: { factSourceOrderId: 'other-stock-order' },
    },
    {
      label: 'canonical spec source order differs from the stock order',
      overrides: { specSourceOrderId: 'other-stock-order' },
    },
    {
      label: 'fact source position differs from the canonical spec',
      overrides: { factSourcePositionId: 'other-stock-position' },
    },
    {
      label: 'source position does not belong to the stock order',
      overrides: { stockPositionIds: ['other-stock-position'] },
    },
  ])('fails closed when $label', async ({ overrides }) => {
    const malformed = stockRoll(overrides);
    const { service } = setup([malformed], [malformed]);

    const page = await service.list({ bucket: 'available', limit: 25 }, NOW);

    expect(page.items).toEqual([]);
    expect(page.summary).toMatchObject({
      totalCount: 0,
      totalWeightKg: 0,
      pageCount: 0,
      pageWeightKg: 0,
    });
  });

  it('returns only the bounded lifecycle projection and a processed timestamp', async () => {
    const processedAt = new Date('2026-08-05T09:00:00.000Z');
    const processed = stockRoll({
      reservedAt: processedAt,
      reservationLinks: { reservedForOrderId: 'client-order-1' },
    });
    const { service } = setup([processed]);

    const page = await service.list({ bucket: 'processed' }, NOW);

    expect(page.items).toEqual([
      {
        id: 'warehouse-roll-1',
        rollCode: 'S-1-roll-1',
        batchCode: 'STOCK-S-1',
        weightKg: 40.5,
        recipe: 'Рецептура ПВД · ПВД',
        specification:
          'полотно · факт 80 мкм · учёт 78 мкм · ширина 1700 мм · длина 275 м · вес 40.5 кг · шпуля 76 мм · бирка гост',
        ageDays: 16,
        processedAt: '2026-08-05T09:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(page.items)).not.toMatch(
      /sourceOrder|clientOrder|availability|reservedFor|coverageDecision|fingerprint|receivedAt/i,
    );
  });

  it('stable-deduplicates normalized recipe labels', async () => {
    const duplicateLabels = stockRoll({
      baseMaterialName: '  пвд ',
      catalogIngredientNames: ['ПВД', ' пвд  ', 'Полиэтилен'],
      recipeName: ' ПВД ',
      recipeDefinitionName: 'пвд',
    });
    const { service } = setup([duplicateLabels]);

    const page = await service.list({ bucket: 'available' }, NOW);

    expect(page.items[0].recipe).toBe('ПВД · Полиэтилен');
  });

  it('searches roll, stock batch, recipe, base material, film type, and catalog ingredients', async () => {
    const { service, prisma } = setup();

    await service.list({ bucket: 'available', q: 'пвд' }, NOW);

    const search = pageRead(prisma).where.AND[1];
    expect(search.OR).toEqual(
      expect.arrayContaining([
        { rollCode: { contains: 'пвд', mode: 'insensitive' } },
        {
          producedForStockOrder: {
            is: { stockBatchCode: { contains: 'пвд', mode: 'insensitive' } },
          },
        },
        {
          currentCoverageFact: {
            is: { spec: { path: ['filmType'], string_contains: 'пвд' } },
          },
        },
        {
          currentCoverageFact: {
            is: {
              sourcePosition: {
                is: {
                  baseRawMaterialDefinition: {
                    is: { name: { contains: 'пвд', mode: 'insensitive' } },
                  },
                },
              },
            },
          },
        },
        {
          currentCoverageFact: {
            is: {
              sourcePosition: {
                is: {
                  recipe: {
                    is: { recipeName: { contains: 'пвд', mode: 'insensitive' } },
                  },
                },
              },
            },
          },
        },
        {
          currentCoverageFact: {
            is: {
              sourcePosition: {
                is: {
                  recipeDefinitionVersion: {
                    is: {
                      ingredients: {
                        some: {
                          rawMaterialDefinition: {
                            is: { name: { contains: 'пвд', mode: 'insensitive' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ]),
    );
  });

  it('does not search hidden source-order or internal recipe-version fields', async () => {
    const { service, prisma } = setup();

    await service.list({ bucket: 'available', q: 'internal' }, NOW);

    const search = pageRead(prisma).where.AND[1];
    expect(JSON.stringify(search)).not.toMatch(
      /orderNumber|recipeVersion|recipeDefinitionVersionId/u,
    );
  });
});
