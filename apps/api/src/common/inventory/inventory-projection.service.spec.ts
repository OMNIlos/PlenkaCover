import {
  classifyInventorySourceStatus,
  InventoryProjectionService,
} from './inventory-projection.service';

type DefinitionQuery = {
  where: {
    AND?: Array<{
      OR?: Array<{ normalizedName?: { gt?: string } }>;
    }>;
  };
  take: number;
};

type SnapshotQuery = {
  where: { externalId: { in: string[] } };
};

type ParameterizedSql = {
  strings: readonly string[];
  values: unknown[];
};

function pagedInventoryFixture(definitionCount: number, erpOnlyIndexes = new Set<number>()) {
  const definitions = Array.from({ length: definitionCount }, (_, offset) => {
    const index = offset + 1;
    const suffix = String(index).padStart(4, '0');
    return {
      id: `definition-${suffix}`,
      name: `Материал ${suffix}`,
      kind: 'primary',
      normalizedName: `material-${suffix}`,
      stock: {
        materialId: `rm-${suffix}`,
        actualQty: index,
        unit: 'кг',
        updatedAt: new Date('2026-07-27T08:00:00.000Z'),
        externalId: erpOnlyIndexes.has(index) ? null : `onec-rm-${suffix}`,
      },
    };
  });
  const rawMaterialFindMany = jest.fn((args: DefinitionQuery) => {
    const afterName = args.where.AND?.flatMap(({ OR }) => OR ?? [])
      .map(({ normalizedName }) => normalizedName?.gt)
      .find((value): value is string => typeof value === 'string');
    return Promise.resolve(
      definitions
        .filter(({ normalizedName }) => !afterName || normalizedName > afterName)
        .slice(0, args.take),
    );
  });
  const snapshotsFor = (externalIds: string[]) =>
    externalIds.map((externalId) => ({
      id: `snapshot-${externalId}`,
      externalId,
      sourceKind: '1C',
      capturedAt: new Date('2026-07-27T08:00:00.000Z'),
      importedAt: new Date('2026-07-27T08:00:00.000Z'),
      checkedAt: new Date('2026-07-27T08:00:00.000Z'),
      staleness: 'fresh',
      parsed: {
        qty: Number(externalId.match(/\d+$/)?.[0] ?? 0),
        rawPayload: 'must-not-leak',
      },
      rawPayload: { token: 'must-not-leak' },
    }));
  const prisma = {
    $queryRaw: jest.fn((query: ParameterizedSql) =>
      Promise.resolve(
        snapshotsFor(
          query.values.filter(
            (value): value is string => typeof value === 'string' && value.startsWith('onec-rm-'),
          ),
        ),
      ),
    ),
    rawMaterialDefinition: { findMany: rawMaterialFindMany },
    sourceSnapshot: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'global-stock-snapshot',
        capturedAt: new Date('2026-07-27T08:00:00.000Z'),
        importedAt: new Date('2026-07-27T08:00:00.000Z'),
        checkedAt: new Date('2026-07-27T08:00:00.000Z'),
        staleness: 'fresh',
      }),
      findMany: jest.fn((args: SnapshotQuery) =>
        Promise.resolve(snapshotsFor(args.where.externalId.in)),
      ),
    },
    bigBagUnit: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    domainEvent: {
      findFirst: jest.fn().mockResolvedValue({
        type: 'integration.onec_imported',
        createdAt: new Date('2026-07-27T08:00:00.000Z'),
      }),
    },
  };
  return { prisma, rawMaterialFindMany };
}

describe('classifyInventorySourceStatus', () => {
  it.each([
    [
      'unavailable',
      {
        sourceUnavailable: true,
        hasMatchedSnapshot: false,
        parsedQuantityAvailable: true,
        stale: true,
        mismatch: true,
        deductionsComplete: false,
      },
    ],
    [
      'erp_only',
      {
        sourceUnavailable: false,
        hasMatchedSnapshot: false,
        parsedQuantityAvailable: true,
        stale: true,
        mismatch: true,
        deductionsComplete: true,
      },
    ],
    [
      'partial',
      {
        sourceUnavailable: false,
        hasMatchedSnapshot: true,
        parsedQuantityAvailable: false,
        stale: false,
        mismatch: false,
        deductionsComplete: true,
      },
    ],
    [
      'partial',
      {
        sourceUnavailable: false,
        hasMatchedSnapshot: true,
        parsedQuantityAvailable: true,
        stale: false,
        mismatch: false,
        deductionsComplete: false,
      },
    ],
    [
      'conflict',
      {
        sourceUnavailable: false,
        hasMatchedSnapshot: true,
        parsedQuantityAvailable: true,
        stale: true,
        mismatch: true,
        deductionsComplete: false,
      },
    ],
    [
      'stale',
      {
        sourceUnavailable: false,
        hasMatchedSnapshot: true,
        parsedQuantityAvailable: true,
        stale: true,
        mismatch: false,
        deductionsComplete: false,
      },
    ],
    [
      'fresh',
      {
        sourceUnavailable: false,
        hasMatchedSnapshot: true,
        parsedQuantityAvailable: true,
        stale: false,
        mismatch: false,
        deductionsComplete: true,
      },
    ],
  ] as const)('returns %s for the deterministic source precedence', (expected, input) => {
    expect(classifyInventorySourceStatus(input)).toBe(expected);
  });
});

describe('InventoryProjectionService', () => {
  it('keeps ERP and BigBag facts while incomplete deductions stay nullable and safe', async () => {
    const matchedSnapshot = {
      id: 'snapshot-1',
      externalId: 'onec-rm-1',
      sourceKind: '1C',
      capturedAt: new Date('2026-07-27T07:55:00.000Z'),
      importedAt: new Date('2026-07-27T08:00:00.000Z'),
      checkedAt: new Date('2026-07-27T08:00:00.000Z'),
      staleness: 'fresh',
      parsed: { qty: 800, rawPayload: 'nested-secret' },
      rawPayload: { token: 'must-not-leak' },
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([matchedSnapshot]),
      rawMaterialDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'definition-1',
            name: 'ПВД 15803-020',
            kind: 'primary',
            normalizedName: 'пвд 15803-020',
            stock: {
              materialId: 'rm-1',
              actualQty: 840,
              unit: 'кг',
              factStatus: 'warehouse_fact',
              updatedAt: new Date('2026-07-27T08:00:00.000Z'),
              externalId: 'onec-rm-1',
            },
          },
        ]),
      },
      sourceSnapshot: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'snapshot-1',
          capturedAt: new Date('2026-07-27T07:55:00.000Z'),
          importedAt: new Date('2026-07-27T08:00:00.000Z'),
          checkedAt: new Date('2026-07-27T08:00:00.000Z'),
          staleness: 'fresh',
        }),
        findMany: jest.fn().mockResolvedValue([matchedSnapshot]),
      },
      bigBagUnit: {
        findMany: jest.fn().mockResolvedValue([
          { materialId: 'rm-1', currentKg: 120 },
          { materialId: 'rm-1', currentKg: 50 },
        ]),
        groupBy: jest.fn().mockResolvedValue([
          {
            materialId: 'rm-1',
            _sum: { currentKg: 170 },
          },
        ]),
      },
      domainEvent: {
        findFirst: jest.fn().mockResolvedValue({
          type: 'integration.onec_imported',
          createdAt: new Date('2026-07-27T08:00:00.000Z'),
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new InventoryProjectionService(prisma as never);

    const page = await service.list({ limit: 20 }, new Date('2026-07-27T09:00:00.000Z'));

    expect(page.items).toEqual([
      expect.objectContaining({
        materialId: 'rm-1',
        erpActualQty: 840,
        oneCQty: 800,
        openBigBagQty: 170,
        reservedQty: null,
        expectedUsageQty: null,
        availableQty: null,
        sourceStatus: 'conflict',
        conflicts: expect.arrayContaining([
          expect.objectContaining({ code: 'ERP_ONEC_QTY_MISMATCH' }),
          expect.objectContaining({ code: 'INCOMPLETE_DEDUCTIONS' }),
        ]),
      }),
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const latestSnapshotSql = prisma.$queryRaw.mock.calls[0]?.[0] as ParameterizedSql;
    const latestSnapshotSqlText = latestSnapshotSql.strings.join('?').replace(/\s+/g, ' ');
    expect(latestSnapshotSqlText).toContain('CROSS JOIN LATERAL');
    expect(latestSnapshotSqlText).toContain('LIMIT 1');
    expect(latestSnapshotSqlText).toContain('"parsed"');
    expect(latestSnapshotSqlText).not.toContain('rawPayload');
    expect(latestSnapshotSql.values).toEqual(['onec-rm-1']);
    expect(prisma.sourceSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.bigBagUnit.groupBy).toHaveBeenCalledWith({
      by: ['materialId'],
      where: {
        materialId: { in: ['rm-1'] },
        status: { in: ['available', 'in_use'] },
      },
      _sum: { currentKg: true },
    });
    expect(prisma.bigBagUnit.findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(page)).not.toMatch(
      /rawPayload|externalId|nested-secret|must-not-leak|token/i,
    );
  });

  it('rejects a malformed cursor before reading inventory', async () => {
    const prisma = {
      rawMaterialDefinition: { findMany: jest.fn() },
    };
    const service = new InventoryProjectionService(prisma as never);

    await expect(service.list({ cursor: 'not-a-cursor', limit: 20 })).rejects.toThrow(
      'Invalid inventory cursor',
    );
    expect(prisma.rawMaterialDefinition.findMany).not.toHaveBeenCalled();
  });

  it('queries 10.01 accounting balances even when a material has no physical stock', async () => {
    const prisma = {
      rawMaterialDefinition: { findMany: jest.fn().mockResolvedValue([]) },
      sourceSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
      domainEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new InventoryProjectionService(prisma as never);

    await service.list({ limit: 20 });

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { stock: { isNot: null } },
                {
                  oneCNomenclatureItem: {
                    is: {
                      stockBalances: {
                        some: { accountCode: '10.01' },
                      },
                    },
                  },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it('projects a 10.01 accounting balance without fabricating a physical ERP fact', async () => {
    const prisma = {
      rawMaterialDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'definition-onec-1',
            name: 'ПВД 15803-020',
            kind: 'custom',
            normalizedName: 'пвд 15803-020',
            externalId: 'onec-nomenclature-1',
            sourceUnit: 'кг',
            stock: null,
          },
        ]),
      },
      oneCStockBalance: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'balance-row-1',
            nomenclatureExternalId: 'onec-nomenclature-1',
            quantity: '125.5',
            capturedAt: new Date('2026-07-29T08:00:00.000Z'),
            syncedAt: new Date('2026-07-29T08:05:00.000Z'),
          },
        ]),
      },
      sourceSnapshot: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'global-stock-snapshot',
          capturedAt: new Date('2026-07-29T08:00:00.000Z'),
          importedAt: new Date('2026-07-29T08:05:00.000Z'),
          checkedAt: new Date('2026-07-29T08:05:00.000Z'),
          staleness: 'fresh',
        }),
      },
      bigBagUnit: { groupBy: jest.fn().mockResolvedValue([]) },
      domainEvent: {
        findFirst: jest.fn().mockResolvedValue({
          type: 'integration.onec_imported',
          createdAt: new Date('2026-07-29T08:05:00.000Z'),
        }),
      },
    };
    const service = new InventoryProjectionService(prisma as never);

    const page = await service.list({ limit: 20 }, new Date('2026-07-29T09:00:00.000Z'));

    expect(page.items).toEqual([
      expect.objectContaining({
        materialId: 'definition-onec-1',
        materialName: 'ПВД 15803-020',
        unit: 'кг',
        erpActualQty: null,
        oneCQty: 125.5,
        availableQty: null,
        sourceStatus: 'partial',
        source: {
          snapshotId: 'balance-row-1',
          sourceKind: '1C',
          capturedAt: '2026-07-29T08:00:00.000Z',
          importedAt: '2026-07-29T08:05:00.000Z',
        },
        updatedAt: null,
      }),
    ]);
    expect(JSON.stringify(page)).not.toMatch(/externalId|rawPayload|amount|token/i);
  });

  it('applies search, category and stable cursor predicates to the material query', async () => {
    const prisma = {
      rawMaterialDefinition: { findMany: jest.fn().mockResolvedValue([]) },
      sourceSnapshot: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      bigBagUnit: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      domainEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new InventoryProjectionService(prisma as never);
    const cursor = Buffer.from(
      JSON.stringify({ normalizedName: 'пвд', definitionId: 'definition-0' }),
    ).toString('base64url');

    await service.list({ q: '  ПВД  ', category: 'primary', cursor, limit: 10 });

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'active',
          kind: 'primary',
          AND: expect.arrayContaining([
            {
              OR: [
                { stock: { isNot: null } },
                {
                  oneCNomenclatureItem: {
                    is: {
                      stockBalances: {
                        some: { accountCode: '10.01' },
                      },
                    },
                  },
                },
              ],
            },
            {
              OR: [
                { name: { contains: 'ПВД', mode: 'insensitive' } },
                {
                  stock: {
                    is: { materialId: { contains: 'ПВД', mode: 'insensitive' } },
                  },
                },
              ],
            },
            {
              OR: [
                { normalizedName: { gt: 'пвд' } },
                { normalizedName: 'пвд', id: { gt: 'definition-0' } },
              ],
            },
          ]),
        }),
        take: 11,
      }),
    );
  });

  it('keeps a globally available 1C source honest when a material row is unmappable', async () => {
    const prisma = {
      rawMaterialDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'definition-1',
            name: 'ПВД без связи',
            kind: 'primary',
            normalizedName: 'пвд без связи',
            stock: {
              materialId: 'rm-unmapped',
              actualQty: 20,
              unit: 'кг',
              factStatus: 'warehouse_fact',
              updatedAt: new Date('2026-07-27T08:00:00.000Z'),
              externalId: null,
            },
          },
        ]),
      },
      sourceSnapshot: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'global-stock-snapshot',
          capturedAt: new Date('2026-07-27T08:00:00.000Z'),
          importedAt: new Date('2026-07-27T08:00:00.000Z'),
          checkedAt: new Date('2026-07-27T08:00:00.000Z'),
          staleness: 'fresh',
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      bigBagUnit: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      domainEvent: {
        findFirst: jest.fn().mockResolvedValue({
          type: 'integration.onec_imported',
          createdAt: new Date('2026-07-27T08:00:00.000Z'),
        }),
      },
    };
    const service = new InventoryProjectionService(prisma as never);

    const page = await service.list({ limit: 20 }, new Date('2026-07-27T09:00:00.000Z'));

    expect(page.sourceUnavailable).toBe(false);
    expect(page.items[0]).toMatchObject({
      materialId: 'rm-unmapped',
      erpActualQty: 20,
      oneCQty: null,
      sourceStatus: 'erp_only',
    });
  });

  it('marks a newer failed stock import unavailable without discarding ERP facts', async () => {
    const matchedSnapshot = {
      id: 'snapshot-1',
      externalId: 'onec-rm-1',
      sourceKind: '1C',
      capturedAt: new Date('2026-07-27T08:00:00.000Z'),
      importedAt: new Date('2026-07-27T08:00:00.000Z'),
      checkedAt: new Date('2026-07-27T08:00:00.000Z'),
      staleness: 'fresh',
      parsed: { qty: 800 },
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([matchedSnapshot]),
      rawMaterialDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'definition-1',
            name: 'ПВД',
            kind: 'primary',
            normalizedName: 'пвд',
            stock: {
              materialId: 'rm-1',
              actualQty: 840,
              unit: 'кг',
              factStatus: 'warehouse_fact',
              updatedAt: new Date('2026-07-27T08:00:00.000Z'),
              externalId: 'onec-rm-1',
            },
          },
        ]),
      },
      sourceSnapshot: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'snapshot-1',
          capturedAt: new Date('2026-07-27T08:00:00.000Z'),
          importedAt: new Date('2026-07-27T08:00:00.000Z'),
          checkedAt: new Date('2026-07-27T08:00:00.000Z'),
          staleness: 'fresh',
        }),
        findMany: jest.fn().mockResolvedValue([matchedSnapshot]),
      },
      bigBagUnit: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      domainEvent: {
        findFirst: jest.fn().mockResolvedValue({
          type: 'integration.onec_import_failed',
          createdAt: new Date('2026-07-27T08:30:00.000Z'),
        }),
      },
    };
    const service = new InventoryProjectionService(prisma as never);

    const page = await service.list({ limit: 20 }, new Date('2026-07-27T09:00:00.000Z'));

    expect(page.sourceUnavailable).toBe(true);
    expect(page.items[0]).toMatchObject({
      erpActualQty: 840,
      oneCQty: 800,
      sourceStatus: 'unavailable',
    });
  });

  it('filters computed source and availability states without fabricating availability', async () => {
    const matchedSnapshot = {
      id: 'snapshot-1',
      externalId: 'onec-rm-1',
      sourceKind: '1C',
      capturedAt: new Date('2026-07-27T08:00:00.000Z'),
      importedAt: new Date('2026-07-27T08:00:00.000Z'),
      checkedAt: new Date('2026-07-27T08:00:00.000Z'),
      staleness: 'fresh',
      parsed: { qty: 10 },
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([matchedSnapshot]),
      rawMaterialDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'definition-1',
            name: 'ПВД',
            kind: 'primary',
            normalizedName: 'пвд',
            stock: {
              materialId: 'rm-1',
              actualQty: 10,
              unit: 'кг',
              factStatus: 'warehouse_fact',
              updatedAt: new Date('2026-07-27T08:00:00.000Z'),
              externalId: 'onec-rm-1',
            },
          },
        ]),
      },
      sourceSnapshot: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'snapshot-1',
          capturedAt: new Date('2026-07-27T08:00:00.000Z'),
          importedAt: new Date('2026-07-27T08:00:00.000Z'),
          checkedAt: new Date('2026-07-27T08:00:00.000Z'),
          staleness: 'fresh',
        }),
        findMany: jest.fn().mockResolvedValue([matchedSnapshot]),
      },
      bigBagUnit: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      domainEvent: {
        findFirst: jest.fn().mockResolvedValue({
          type: 'integration.onec_imported',
          createdAt: new Date('2026-07-27T08:00:00.000Z'),
        }),
      },
    };
    const service = new InventoryProjectionService(prisma as never);
    const now = new Date('2026-07-27T09:00:00.000Z');

    await expect(
      service.list({ sourceStatus: 'fresh', availability: 'unavailable', limit: 20 }, now),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      service.list({ sourceStatus: 'partial', availability: 'unavailable', limit: 20 }, now),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ availableQty: null })] });
  });

  it('scans stable definition batches so derived filters do not skip later matches', async () => {
    const { prisma, rawMaterialFindMany } = pagedInventoryFixture(230, new Set([101, 102, 205]));
    const service = new InventoryProjectionService(prisma as never);

    const firstPage = await service.list(
      { sourceStatus: 'erp_only', availability: 'unavailable', limit: 2 },
      new Date('2026-07-27T09:00:00.000Z'),
    );
    const secondPage = await service.list(
      {
        sourceStatus: 'erp_only',
        availability: 'unavailable',
        limit: 2,
        cursor: firstPage.nextCursor ?? undefined,
      },
      new Date('2026-07-27T09:00:00.000Z'),
    );

    expect(firstPage.items.map(({ materialId }) => materialId)).toEqual(['rm-0101', 'rm-0102']);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.items.map(({ materialId }) => materialId)).toEqual(['rm-0205']);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      new Set([...firstPage.items, ...secondPage.items].map(({ materialId }) => materialId)).size,
    ).toBe(3);
    expect(rawMaterialFindMany.mock.calls.length).toBeGreaterThan(2);
    expect(rawMaterialFindMany.mock.calls.length).toBeLessThanOrEqual(6);
    expect(JSON.stringify({ firstPage, secondPage })).not.toMatch(
      /rawPayload|externalId|must-not-leak|token/i,
    );
  });

  it('does not emit a phantom cursor when the only match is at an exact scan boundary', async () => {
    const { prisma, rawMaterialFindMany } = pagedInventoryFixture(101, new Set([101]));
    const service = new InventoryProjectionService(prisma as never);

    const page = await service.list(
      { sourceStatus: 'erp_only', limit: 1 },
      new Date('2026-07-27T09:00:00.000Z'),
    );

    expect(page.items.map(({ materialId }) => materialId)).toEqual(['rm-0101']);
    expect(page.nextCursor).toBeNull();
    expect(rawMaterialFindMany).toHaveBeenCalledTimes(1);
    expect(rawMaterialFindMany.mock.calls[0]?.[0].take).toBe(102);
  });

  it('does not emit a phantom cursor when the bounded scan exhausts exactly 1010 rows', async () => {
    const { prisma, rawMaterialFindMany } = pagedInventoryFixture(1_010);
    const service = new InventoryProjectionService(prisma as never);

    const page = await service.list(
      { availability: 'available', limit: 100 },
      new Date('2026-07-27T09:00:00.000Z'),
    );

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(rawMaterialFindMany).toHaveBeenCalledTimes(10);
    expect(rawMaterialFindMany.mock.calls.every(([query]) => query.take === 102)).toBe(true);
  });

  it('bounds derived-filter scans and returns a deterministic continuation cursor', async () => {
    const { prisma, rawMaterialFindMany } = pagedInventoryFixture(2_000);
    const service = new InventoryProjectionService(prisma as never);
    const repeatedFixture = pagedInventoryFixture(2_000);
    const repeatedService = new InventoryProjectionService(repeatedFixture.prisma as never);

    const page = await service.list(
      { availability: 'available', limit: 100 },
      new Date('2026-07-27T09:00:00.000Z'),
    );
    const repeatedPage = await repeatedService.list(
      { availability: 'available', limit: 100 },
      new Date('2026-07-27T09:00:00.000Z'),
    );

    expect(page.items).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
    expect(repeatedPage.nextCursor).toBe(page.nextCursor);
    expect(rawMaterialFindMany.mock.calls.length).toBeGreaterThan(1);
    expect(rawMaterialFindMany.mock.calls.length).toBeLessThanOrEqual(10);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(rawMaterialFindMany.mock.calls.length);
    expect(prisma.bigBagUnit.groupBy).toHaveBeenCalledTimes(rawMaterialFindMany.mock.calls.length);
    expect(prisma.sourceSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.bigBagUnit.findMany).not.toHaveBeenCalled();
    expect(prisma.sourceSnapshot.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.domainEvent.findFirst).toHaveBeenCalledTimes(1);
    expect(repeatedFixture.rawMaterialFindMany.mock.calls.length).toBeLessThanOrEqual(10);
  });
});
