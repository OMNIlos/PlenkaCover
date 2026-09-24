import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
} from '../warehouse-coverage/warehouse-coverage-canonical';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WarehouseInventoryService } from './warehouse-inventory.service';

const NOW = new Date('2026-08-07T09:00:00.000Z');
const CUTOFF = new Date('2026-05-09T09:00:00.000Z');
const DAY_MS_FOR_TEST = 86_400_000;

type InventoryRowOverrides = {
  id?: string;
  rollCode?: string;
  warehouseStatus?: string;
  ownerCounterpartyId?: string | null;
  producedForOrderId?: string | null;
  producedForStockOrderId?: string | null;
  producedForOrder?: {
    orderNumber: string;
    counterparty: { displayName: string } | null;
  } | null;
  producedForPositionId?: string | null;
  reservedForOrderId?: string | null;
  reservedForPositionId?: string | null;
  reservedByProposalId?: string | null;
  reservedByCoverageDecisionId?: string | null;
  reservedAt?: Date | null;
  receivedAt?: Date | null;
  createdAt?: Date;
  stockBatchCode?: string | null;
  reserveCreationCommand?: { id: string } | null;
  fact?: ReturnType<typeof coverageFact> | null;
};

function coverageFact(
  overrides: {
    rollCode?: string;
    ownerCounterpartyId?: string | null;
    sourceOrderId?: string | null;
    sourcePositionId?: string | null;
    fingerprint?: string;
    spec?: unknown;
  } = {},
) {
  const ownerCounterpartyId =
    overrides.ownerCounterpartyId === undefined ? 'counterparty-1' : overrides.ownerCounterpartyId;
  const sourceOrderId = overrides.sourceOrderId === undefined ? 'order-1' : overrides.sourceOrderId;
  const sourcePositionId =
    overrides.sourcePositionId === undefined ? 'position-1' : overrides.sourcePositionId;
  const spec = canonicalizeRollCoverageSpec({
    rollCode: overrides.rollCode ?? 'ROLL-001',
    sourceOrderId,
    sourcePositionId,
    ownerCounterpartyId,
    filmType: 'рукав',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 78_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: 'гост',
    spoolType: '76 мм',
    actualWeightMilliKg: 42_300,
    plannedWeightMilliKg: 42_000,
    ingredients: [{ rawMaterialDefinitionId: 'material-1', shareBasisPoints: 10_000 }],
    recipeId: 'recipe-1',
    recipeVersion: 'Рецептура 80',
    recipeDefinitionId: 'recipe-definition-1',
    recipeDefinitionVersionId: 'recipe-definition-version-1',
    recipeVersionNumber: 1,
    policyVersion: 'warehouse-coverage-policy/v2',
  });
  return {
    id: 'fact-1',
    specVersion: 'warehouse-roll-coverage/v1',
    specFingerprint: overrides.fingerprint ?? fingerprintRollFact(spec),
    spec: overrides.spec ?? spec,
    sourceOrderId,
    sourcePositionId,
    sourcePosition: {
      baseRawMaterialDefinition: { name: 'ПВД' },
      recipe: { recipeName: 'Рецептура 80', ingredients: null },
      recipeDefinitionVersion: {
        recipeDefinition: { name: 'Рецептура 80' },
        ingredients: [{ rawMaterialDefinition: { name: 'ПВД' } }],
      },
    },
    sourceDispatchItem: sourcePositionId
      ? { orderLineId: sourcePositionId, positionSequence: 1 }
      : null,
  };
}

function inventoryRow(overrides: InventoryRowOverrides = {}) {
  const rollCode = overrides.rollCode ?? 'ROLL-001';
  const ownerCounterpartyId =
    overrides.ownerCounterpartyId === undefined
      ? overrides.producedForStockOrderId
        ? null
        : 'counterparty-1'
      : overrides.ownerCounterpartyId;
  const producedForOrderId =
    overrides.producedForOrderId === undefined
      ? overrides.producedForStockOrderId
        ? null
        : 'order-1'
      : overrides.producedForOrderId;
  const producedForStockOrderId = overrides.producedForStockOrderId ?? null;
  const fact =
    overrides.fact === undefined
      ? coverageFact({
          rollCode,
          ownerCounterpartyId,
          sourceOrderId: producedForStockOrderId ?? producedForOrderId,
        })
      : overrides.fact;
  return {
    id: overrides.id ?? 'roll-1',
    rollCode,
    warehouseStatus: overrides.warehouseStatus ?? 'received',
    ownerCounterpartyId,
    producedForOrderId,
    producedForStockOrderId,
    producedForPositionId:
      overrides.producedForPositionId === undefined
        ? producedForOrderId
          ? 'position-1'
          : null
        : overrides.producedForPositionId,
    reservedForOrderId: overrides.reservedForOrderId ?? null,
    reservedForPositionId: overrides.reservedForPositionId ?? null,
    reservedByProposalId: overrides.reservedByProposalId ?? null,
    reservedByCoverageDecisionId: overrides.reservedByCoverageDecisionId ?? null,
    reservedAt: overrides.reservedAt ?? null,
    receivedAt:
      overrides.receivedAt === undefined
        ? new Date('2026-08-01T08:00:00.000Z')
        : overrides.receivedAt,
    createdAt: overrides.createdAt ?? new Date('2026-07-31T08:00:00.000Z'),
    producedForOrder:
      overrides.producedForOrder === undefined
        ? producedForOrderId
          ? {
              orderNumber: 'A-1',
              counterparty: { displayName: 'Клиент V2' },
            }
          : null
        : overrides.producedForOrder,
    producedForStockOrder: producedForStockOrderId
      ? {
          orderNumber: 'S-1',
          stockBatchCode: overrides.stockBatchCode ?? 'STOCK-001',
          requestType: 'stock_reserve',
        }
      : null,
    reserveCreationCommand: overrides.reserveCreationCommand ?? null,
    currentCoverageFact: fact,
  };
}

type InventoryRowFixture = ReturnType<typeof inventoryRow>;
type WarehouseReadArgs = {
  take: number;
  where: Record<string, unknown>;
  orderBy: unknown;
  select: {
    positionSnapshot?: unknown;
    currentCoverageFact: {
      select: {
        sourcePosition?: unknown;
      };
    };
    producedForOrder: {
      select: {
        counterparty: { select: Record<string, boolean> };
      };
    };
  };
};
type WarehouseDetailReadArgs = {
  where: { id: string };
  select: WarehouseReadArgs['select'];
};
type CounterpartyReadArgs = {
  where: {
    id?: { in?: string[] };
    displayName?: unknown;
  };
  select: Record<string, boolean>;
  take: number;
};
type CommercialOrderReadArgs = {
  where: { id: { in: string[] } };
  select: { id: boolean; orderNumber: boolean };
  take: number;
};
type PrismaMock = {
  warehouseRoll: {
    findMany: jest.Mock<Promise<InventoryRowFixture[]>, [WarehouseReadArgs]>;
    findUnique: jest.Mock<Promise<InventoryRowFixture | null>, [WarehouseDetailReadArgs]>;
  };
  counterparty: {
    findMany: jest.Mock<
      Promise<Array<{ id: string; displayName: string }>>,
      [CounterpartyReadArgs]
    >;
  };
  commercialOrder: {
    findMany: jest.Mock<
      Promise<Array<{ id: string; orderNumber: string }>>,
      [CommercialOrderReadArgs]
    >;
  };
};

function setup(input?: {
  pageRows?: InventoryRowFixture[];
  detailRow?: InventoryRowFixture | null;
  counterparties?: Array<{ id: string; displayName: string }>;
  orders?: Array<{ id: string; orderNumber: string }>;
}) {
  const pageRows = input?.pageRows ?? [inventoryRow()];
  const prisma: PrismaMock = {
    warehouseRoll: {
      findMany: jest.fn(({ take }: WarehouseReadArgs) => Promise.resolve(pageRows.slice(0, take))),
      findUnique: jest.fn((_args: WarehouseDetailReadArgs) =>
        Promise.resolve(input?.detailRow ?? pageRows[0] ?? null),
      ),
    },
    counterparty: {
      findMany: jest.fn(({ where }: CounterpartyReadArgs) => {
        const rows = input?.counterparties ?? [];
        const ids = where.id?.in;
        if (ids) {
          return Promise.resolve(rows.filter(({ id }) => ids.includes(id)));
        }
        return Promise.resolve(rows);
      }),
    },
    commercialOrder: {
      findMany: jest.fn(({ where }: CommercialOrderReadArgs) =>
        Promise.resolve((input?.orders ?? []).filter(({ id }) => where.id.in.includes(id))),
      ),
    },
  };
  return {
    prisma,
    service: new WarehouseInventoryService(prisma as unknown as PrismaService),
  };
}

function listRead(prisma: PrismaMock): WarehouseReadArgs {
  return prisma.warehouseRoll.findMany.mock.calls.at(-1)![0];
}

function detailRead(prisma: PrismaMock): WarehouseDetailReadArgs {
  return prisma.warehouseRoll.findUnique.mock.calls.at(-1)![0];
}

function replaceCursor(
  cursor: string,
  patch: Partial<{ asOf: string; value: string | null; id: string }>,
): string {
  const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  return Buffer.from(JSON.stringify({ ...payload, ...patch })).toString('base64url');
}

describe('WarehouseInventoryService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('projects client, reserve, provisional, transit, finalized and delivered lifecycles', async () => {
    const rows = [
      inventoryRow({ id: 'client', rollCode: 'CLIENT' }),
      inventoryRow({
        id: 'available',
        rollCode: 'AVAILABLE',
        producedForStockOrderId: 'stock-order-1',
        fact: coverageFact({
          rollCode: 'AVAILABLE',
          ownerCounterpartyId: null,
          sourceOrderId: 'stock-order-1',
        }),
      }),
      inventoryRow({
        id: 'reserved',
        rollCode: 'RESERVED',
        producedForStockOrderId: 'stock-order-1',
        reservedForOrderId: 'client-order-2',
        reservedAt: new Date('2026-08-02T08:00:00.000Z'),
        fact: coverageFact({
          rollCode: 'RESERVED',
          ownerCounterpartyId: null,
          sourceOrderId: 'stock-order-1',
        }),
      }),
      inventoryRow({
        id: 'transit',
        rollCode: 'TRANSIT',
        warehouseStatus: 'sent',
        receivedAt: null,
      }),
      inventoryRow({
        id: 'finalized',
        rollCode: 'FINALIZED',
        producedForStockOrderId: 'stock-order-1',
        reservedForOrderId: 'client-order-3',
        reservedByCoverageDecisionId: 'decision-1',
        reservedAt: new Date('2026-08-03T08:00:00.000Z'),
        fact: coverageFact({
          rollCode: 'FINALIZED',
          ownerCounterpartyId: null,
          sourceOrderId: 'stock-order-1',
        }),
      }),
      inventoryRow({
        id: 'delivered',
        rollCode: 'DELIVERED',
        producedForStockOrderId: 'stock-order-1',
        warehouseStatus: 'delivered',
        reservedForOrderId: 'client-order-4',
        reservedAt: CUTOFF,
        fact: coverageFact({
          rollCode: 'DELIVERED',
          ownerCounterpartyId: null,
          sourceOrderId: 'stock-order-1',
        }),
      }),
    ];
    const { service } = setup({ pageRows: rows });

    const page = await service.list({ limit: 25, sort: 'receivedAt', direction: 'desc' }, NOW);

    expect(
      page.items.map(({ id, origin, lifecycleStatus, lifecycleStatusLabel, counterpartyName }) => ({
        id,
        origin,
        lifecycleStatus,
        lifecycleStatusLabel,
        counterpartyName,
      })),
    ).toEqual([
      {
        id: 'client',
        origin: 'client',
        lifecycleStatus: 'awaiting_shipment',
        lifecycleStatusLabel: 'Ожидает отгрузки',
        counterpartyName: 'Клиент V2',
      },
      {
        id: 'available',
        origin: 'reserve',
        lifecycleStatus: 'available',
        lifecycleStatusLabel: 'Доступен',
        counterpartyName: 'Резерв',
      },
      {
        id: 'reserved',
        origin: 'reserve',
        lifecycleStatus: 'reserved',
        lifecycleStatusLabel: 'Зарезервирован',
        counterpartyName: 'Резерв',
      },
      {
        id: 'transit',
        origin: 'client',
        lifecycleStatus: 'in_transit',
        lifecycleStatusLabel: 'В пути',
        counterpartyName: 'Клиент V2',
      },
      {
        id: 'finalized',
        origin: 'reserve',
        lifecycleStatus: 'reserved',
        lifecycleStatusLabel: 'Зарезервирован',
        counterpartyName: 'Резерв',
      },
      {
        id: 'delivered',
        origin: 'reserve',
        lifecycleStatus: 'processed',
        lifecycleStatusLabel: 'Обработан',
        counterpartyName: 'Резерв',
      },
    ]);
  });

  it('normalizes a counterparty display name before returning the strict inventory contract', async () => {
    const row = inventoryRow({
      producedForOrder: {
        orderNumber: 'A-1',
        counterparty: { displayName: '  Клиент   V2  ' },
      },
    });
    const { service } = setup({ pageRows: [row] });

    const page = await service.list(
      { view: 'current', limit: 25, sort: 'receivedAt', direction: 'desc' },
      NOW,
    );

    expect(page.items[0]?.counterpartyName).toBe('Клиент V2');
  });

  it('projects exact order, position, physical status and server-owned next route', async () => {
    const client = inventoryRow({ id: 'client' });
    const reserve = inventoryRow({
      id: 'reserve-route',
      rollCode: 'RESERVE-ROUTE',
      producedForStockOrderId: 'stock-order-1',
      fact: coverageFact({
        rollCode: 'RESERVE-ROUTE',
        ownerCounterpartyId: null,
        sourceOrderId: 'stock-order-1',
        sourcePositionId: null,
      }),
    });
    const routedReserve = inventoryRow({
      id: 'reserve-delivery-route',
      rollCode: 'RESERVE-DELIVERY-ROUTE',
      producedForStockOrderId: 'stock-order-1',
      reservedForOrderId: 'order-2',
      reservedByCoverageDecisionId: 'decision-2',
      reservedAt: new Date('2026-08-03T08:00:00.000Z'),
      fact: coverageFact({
        rollCode: 'RESERVE-DELIVERY-ROUTE',
        ownerCounterpartyId: null,
        sourceOrderId: 'stock-order-1',
        sourcePositionId: null,
      }),
    });
    const { service } = setup({
      pageRows: [client, reserve, routedReserve],
      orders: [{ id: 'order-2', orderNumber: 'A-2' }],
    });

    const page = await service.list(
      { view: 'current', limit: 25, sort: 'rollCode', direction: 'asc' },
      NOW,
    );

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'client',
        orderNumber: 'A-1',
        positionId: 'position-1',
        positionSequence: 1,
        warehouseStatus: 'received',
        warehouseStatusLabel: 'Принят складом',
        nextRoute: 'delivery',
        nextRouteLabel: 'Выдача',
      }),
      expect.objectContaining({
        id: 'reserve-route',
        orderNumber: null,
        positionId: null,
        positionSequence: null,
        warehouseStatus: 'received',
        warehouseStatusLabel: 'Принят складом',
        nextRoute: 'reserve',
        nextRouteLabel: 'Складской резерв',
      }),
      expect.objectContaining({
        id: 'reserve-delivery-route',
        orderNumber: 'A-2',
        lifecycleStatus: 'reserved',
        warehouseStatus: 'received',
        nextRoute: 'delivery',
        nextRouteLabel: 'Выдача',
      }),
    ]);
  });

  it('keeps a physically received defect roll visible with a read-only resolution route', async () => {
    const defect = inventoryRow({
      id: 'defect-roll',
      rollCode: 'DEFECT-ROLL',
      warehouseStatus: 'defect',
    });
    const { service, prisma } = setup({ pageRows: [defect] });

    const page = await service.list(
      { view: 'current', limit: 25, sort: 'rollCode', direction: 'asc' },
      NOW,
    );

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'defect-roll',
        lifecycleStatus: 'defect',
        lifecycleStatusLabel: 'Брак',
        warehouseStatus: 'defect',
        warehouseStatusLabel: 'Подтверждён брак',
        nextRoute: 'defect_resolution',
        nextRouteLabel: 'Решение по браку',
      }),
    ]);
    expect(JSON.stringify(listRead(prisma).where)).toContain('defect');
  });

  it('does not expose a legacy zero position sequence as a known business fact', async () => {
    const row = inventoryRow({ id: 'legacy-zero-sequence' });
    row.currentCoverageFact!.sourceDispatchItem!.positionSequence = 0;
    const { service } = setup({ pageRows: [row] });

    const page = await service.list(
      { view: 'current', sort: 'receivedAt', direction: 'desc', limit: 25 },
      NOW,
    );

    expect(page.items[0]).toEqual(
      expect.objectContaining({ positionId: 'position-1', positionSequence: null }),
    );
  });

  it('keeps recent processed reserve rolls in current and excludes them after retention', async () => {
    const rows = [
      inventoryRow({
        id: 'boundary',
        rollCode: 'BOUNDARY',
        producedForStockOrderId: 'stock-order-1',
        warehouseStatus: 'delivered',
        reservedByCoverageDecisionId: 'decision-1',
        reservedAt: CUTOFF,
        fact: coverageFact({
          rollCode: 'BOUNDARY',
          ownerCounterpartyId: null,
          sourceOrderId: 'stock-order-1',
        }),
      }),
      inventoryRow({
        id: 'old',
        rollCode: 'OLD',
        producedForStockOrderId: 'stock-order-1',
        warehouseStatus: 'delivered',
        reservedByCoverageDecisionId: 'decision-2',
        reservedAt: new Date(CUTOFF.getTime() - 1),
        fact: coverageFact({
          rollCode: 'OLD',
          ownerCounterpartyId: null,
          sourceOrderId: 'stock-order-1',
        }),
      }),
    ];
    const { service, prisma } = setup({ pageRows: rows });

    const page = await service.list(
      { view: 'current', limit: 25, sort: 'receivedAt', direction: 'desc' },
      NOW,
    );

    expect(page.items.map(({ id }) => id)).toEqual(['boundary']);
    expect(JSON.stringify(listRead(prisma).where)).toContain(CUTOFF.toISOString());
  });

  it('evaluates processed retention from current server time while cursor asOf stays a snapshot', async () => {
    const first = setup({
      pageRows: [
        inventoryRow({ id: 'cursor-first', rollCode: 'ZZZ' }),
        inventoryRow({ id: 'cursor-lookahead', rollCode: 'YYY' }),
      ],
    });
    const firstPage = await first.service.list(
      { limit: 1, sort: 'rollCode', direction: 'desc' },
      NOW,
    );
    const boundary = inventoryRow({
      id: 'processed-at-old-cutoff',
      rollCode: 'AAA',
      producedForStockOrderId: 'stock-order-1',
      warehouseStatus: 'delivered',
      reservedByCoverageDecisionId: 'decision-1',
      reservedAt: CUTOFF,
      fact: coverageFact({
        rollCode: 'AAA',
        ownerCounterpartyId: null,
        sourceOrderId: 'stock-order-1',
      }),
    });
    const next = setup({ pageRows: [boundary] });
    const tenMinutesLater = new Date(NOW.getTime() + 10 * 60_000);

    const page = await next.service.list(
      {
        limit: 1,
        sort: 'rollCode',
        direction: 'desc',
        cursor: firstPage.nextCursor!,
      },
      tenMinutesLater,
    );

    expect(page.items).toEqual([]);
    expect(JSON.stringify(listRead(next.prisma).where)).toContain(
      new Date(CUTOFF.getTime() + 10 * 60_000).toISOString(),
    );
  });

  it.each([
    {
      name: 'a received reservation decision without reservedAt',
      overrides: { reservedByCoverageDecisionId: 'decision-without-time' },
      lifecycleStatus: 'reserved',
    },
    {
      name: 'an orphan legacy reservedAt without reservation links',
      overrides: { reservedAt: new Date('2026-08-03T08:00:00.000Z') },
      lifecycleStatus: 'available',
    },
  ])(
    'keeps $name visible exactly once as $lifecycleStatus',
    async ({ overrides, lifecycleStatus }) => {
      const row = inventoryRow({
        id: 'incomplete-history',
        rollCode: 'INCOMPLETE-HISTORY',
        producedForStockOrderId: 'stock-order-1',
        ...overrides,
        fact: coverageFact({
          rollCode: 'INCOMPLETE-HISTORY',
          ownerCounterpartyId: null,
          sourceOrderId: 'stock-order-1',
        }),
      });
      const list = setup({ pageRows: [row] });
      const detail = setup({ detailRow: row });

      await expect(
        list.service.list(
          { view: 'current', limit: 25, sort: 'receivedAt', direction: 'desc' },
          NOW,
        ),
      ).resolves.toMatchObject({ items: [expect.objectContaining({ lifecycleStatus })] });
      await expect(detail.service.get(row.id)).resolves.toMatchObject({ lifecycleStatus });
    },
  );

  it('fails closed for a delivered reservation without the timestamp required by retention', async () => {
    const row = inventoryRow({
      id: 'dangling',
      rollCode: 'DANGLING',
      producedForStockOrderId: 'stock-order-1',
      warehouseStatus: 'delivered',
      reservedByCoverageDecisionId: 'decision-without-time',
      fact: coverageFact({
        rollCode: 'DANGLING',
        ownerCounterpartyId: null,
        sourceOrderId: 'stock-order-1',
      }),
    });
    const list = setup({ pageRows: [row] });
    const detail = setup({ detailRow: row });

    await expect(
      list.service.list({ limit: 25, sort: 'receivedAt', direction: 'desc' }, NOW),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(detail.service.get(row.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps delivered client rolls visible while excluding pre-handover, missing and old processed rows', async () => {
    const excludedStatuses = ['not_ready', 'ready_for_handover', 'missing'];
    const rows = excludedStatuses.map((warehouseStatus, index) =>
      inventoryRow({
        id: `excluded-${index}`,
        rollCode: `EXCLUDED-${index}`,
        warehouseStatus,
      }),
    );
    rows.push(
      inventoryRow({
        id: 'defect',
        rollCode: 'DEFECT',
        warehouseStatus: 'defect',
      }),
      inventoryRow({
        id: 'delivered-client',
        rollCode: 'DELIVERED-CLIENT',
        warehouseStatus: 'delivered',
      }),
      inventoryRow({
        id: 'old-processed',
        rollCode: 'OLD-PROCESSED',
        producedForStockOrderId: 'stock-order-1',
        warehouseStatus: 'delivered',
        reservedByCoverageDecisionId: 'decision-old',
        reservedAt: new Date(CUTOFF.getTime() - 1),
        fact: coverageFact({
          rollCode: 'OLD-PROCESSED',
          ownerCounterpartyId: null,
          sourceOrderId: 'stock-order-1',
        }),
      }),
      inventoryRow({
        id: 'sent',
        rollCode: 'SENT',
        warehouseStatus: 'sent',
        receivedAt: null,
      }),
    );
    const { service } = setup({ pageRows: rows });

    const page = await service.list({ limit: 25, sort: 'receivedAt', direction: 'desc' }, NOW);

    expect(page.items).toEqual([
      expect.objectContaining({ id: 'defect' }),
      expect.objectContaining({
        id: 'delivered-client',
        lifecycleStatus: 'delivered',
        lifecycleStatusLabel: 'Выдан',
        warehouseStatus: 'delivered',
        nextRoute: 'completed',
        processedAt: null,
      }),
      expect.objectContaining({ id: 'sent' }),
    ]);

    const current = setup({ pageRows: [rows[4]!] });
    await expect(
      current.service.list(
        { view: 'current', limit: 25, sort: 'receivedAt', direction: 'desc' },
        NOW,
      ),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: 'delivered-client', lifecycleStatus: 'delivered' })],
    });

    const detail = setup({ detailRow: rows[4]! });
    await expect(detail.service.get('delivered-client')).resolves.toMatchObject({
      id: 'delivered-client',
      lifecycleStatus: 'delivered',
      lifecycleStatusLabel: 'Выдан',
      warehouseStatus: 'delivered',
      nextRoute: 'completed',
      processedAt: null,
    });
  });

  it('returns the 90-day boundary from detail and treats older processed facts as absent', async () => {
    const boundary = inventoryRow({
      producedForStockOrderId: 'stock-order-1',
      warehouseStatus: 'delivered',
      reservedByCoverageDecisionId: 'decision-1',
      reservedAt: CUTOFF,
      fact: coverageFact({
        ownerCounterpartyId: null,
        sourceOrderId: 'stock-order-1',
      }),
    });
    const atBoundary = setup({ detailRow: boundary });
    await expect(atBoundary.service.get(boundary.id)).resolves.toMatchObject({
      lifecycleStatus: 'processed',
      processedAt: CUTOFF.toISOString(),
    });

    const old = {
      ...boundary,
      reservedAt: new Date(CUTOFF.getTime() - 1),
    };
    const beforeBoundary = setup({ detailRow: old });
    await expect(beforeBoundary.service.get(old.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hydrates only bounded V1 display names and never exposes sensitive or internal data', async () => {
    const v1 = inventoryRow({
      id: 'v1',
      rollCode: 'V1',
      producedForOrderId: null,
      ownerCounterpartyId: 'legacy-counterparty',
      producedForOrder: null,
      fact: null,
    });
    const corrupt = inventoryRow({
      id: 'corrupt',
      rollCode: 'CORRUPT',
      fact: coverageFact({ rollCode: 'CORRUPT', fingerprint: 'f'.repeat(64) }),
    });
    const { service, prisma } = setup({
      pageRows: [v1, corrupt],
      counterparties: [{ id: 'legacy-counterparty', displayName: 'Клиент V1' }],
    });

    const page = await service.list({ limit: 25, sort: 'receivedAt', direction: 'desc' }, NOW);

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'v1',
        counterpartyName: 'Клиент V1',
        specification: 'Нет данных',
        weightKg: null,
      }),
      expect.objectContaining({
        id: 'corrupt',
        specification: 'Нет данных',
        weightKg: null,
      }),
    ]);
    expect(prisma.counterparty.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['legacy-counterparty'] } },
      select: { id: true, displayName: true },
      take: 1,
    });
    const warehouseSelect = listRead(prisma).select;
    expect(warehouseSelect).not.toHaveProperty('positionSnapshot');
    expect(warehouseSelect.producedForOrder.select.counterparty.select).toEqual({
      displayName: true,
    });
    expect(JSON.stringify(page)).not.toMatch(
      /legalName|inn|finance|positionSnapshot|coverageDecision|specFingerprint|sourceVersion/i,
    );
  });

  it('returns canonical detail and bounded provenance for client, stock and manual rolls', async () => {
    const client = inventoryRow();
    const clientResult = await setup({ detailRow: client }).service.get(client.id);
    expect(clientResult).toEqual(
      expect.objectContaining({
        specificationDetails: {
          filmType: 'рукав',
          actualThicknessMicron: 80,
          accountingThicknessMicron: 78,
          widthMm: 1700,
          plannedLengthM: 275,
          netKg: 42.3,
          spoolType: '76 мм',
          birka: 'гост',
          recipeName: 'Рецептура 80',
          ingredients: ['ПВД'],
        },
        provenance: {
          kind: 'client_order',
          orderNumber: 'A-1',
          batchCode: null,
        },
      }),
    );

    const stock = inventoryRow({
      producedForStockOrderId: 'stock-order-1',
      fact: coverageFact({ ownerCounterpartyId: null, sourceOrderId: 'stock-order-1' }),
    });
    await expect(setup({ detailRow: stock }).service.get(stock.id)).resolves.toMatchObject({
      provenance: { kind: 'stock_reserve', orderNumber: 'S-1', batchCode: 'STOCK-001' },
    });

    const manual = { ...stock, reserveCreationCommand: { id: 'command-1' } };
    await expect(setup({ detailRow: manual }).service.get(manual.id)).resolves.toMatchObject({
      provenance: { kind: 'manual', orderNumber: 'S-1', batchCode: 'STOCK-001' },
    });

    const legacyReserve = inventoryRow({
      producedForOrderId: null,
      ownerCounterpartyId: null,
      fact: coverageFact({ ownerCounterpartyId: null, sourceOrderId: null }),
    });
    await expect(
      setup({ detailRow: legacyReserve }).service.get(legacyReserve.id),
    ).resolves.toMatchObject({
      origin: 'reserve',
      counterpartyName: 'Резерв',
      provenance: { kind: 'manual', orderNumber: null, batchCode: null },
    });
  });

  it('does not display recipeVersion when safe recipe relations are absent', async () => {
    const fact = {
      ...coverageFact(),
      sourcePosition: null,
    } as unknown as ReturnType<typeof coverageFact>;
    const row = inventoryRow({ fact });

    const detail = await setup({ detailRow: row }).service.get(row.id);

    expect(detail.specificationDetails.recipeName).toBeNull();
    expect(detail.specificationDetails.ingredients).toEqual([]);
  });

  it('keeps the list fact select lean and loads recipe relations only for detail', async () => {
    const { service, prisma } = setup();

    await service.list({ limit: 25, sort: 'receivedAt', direction: 'desc' }, NOW);
    await service.get('roll-1');

    expect(listRead(prisma).select.currentCoverageFact.select).not.toHaveProperty('sourcePosition');
    expect(detailRead(prisma).select.currentCoverageFact.select).toHaveProperty('sourcePosition');
  });

  it('bounds V1 hydration to distinct IDs from the selected limit + 1 rows', async () => {
    const rows = ['legacy-a', 'legacy-b', 'legacy-c'].map((ownerCounterpartyId, index) =>
      inventoryRow({
        id: `legacy-roll-${index}`,
        rollCode: `LEGACY-${index}`,
        producedForOrderId: null,
        ownerCounterpartyId,
        producedForOrder: null,
        fact: null,
      }),
    );
    const counterparties = rows.map((row) => ({
      id: row.ownerCounterpartyId!,
      displayName: `Клиент ${row.ownerCounterpartyId}`,
    }));
    const { service, prisma } = setup({ pageRows: rows, counterparties });

    await service.list({ limit: 2, sort: 'rollCode', direction: 'asc' }, NOW);

    expect(prisma.counterparty.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['legacy-a', 'legacy-b', 'legacy-c'] } },
      select: { id: true, displayName: true },
      take: 3,
    });
  });

  it.each([
    ['awaiting_shipment'],
    ['available'],
    ['reserved'],
    ['defect'],
    ['in_transit'],
    ['delivered'],
    ['processed'],
  ] as const)('translates the %s lifecycle filter into the database query', async (status) => {
    const { service, prisma } = setup();

    await service.list({ status, limit: 25, sort: 'receivedAt', direction: 'desc' }, NOW);

    const where = JSON.stringify(listRead(prisma).where);
    expect(where).toContain(
      status === 'in_transit'
        ? 'sent'
        : status === 'processed' || status === 'delivered'
          ? 'delivered'
          : status === 'defect'
            ? 'defect'
            : 'received',
    );
    if (status === 'processed') expect(where).toContain(CUTOFF.toISOString());
  });

  it('keeps delivered clients and bounded processed reserve history in the all-rolls query', async () => {
    const current = setup();
    await current.service.list(
      { view: 'current', limit: 25, sort: 'receivedAt', direction: 'desc' },
      NOW,
    );
    const currentLifecycle = (listRead(current.prisma).where.AND as unknown[])[0] as {
      OR: unknown[];
    };
    expect(currentLifecycle.OR).toHaveLength(6);
    expect(JSON.stringify(currentLifecycle)).toContain('defect');
    expect(JSON.stringify(currentLifecycle)).toContain('delivered');
    expect(JSON.stringify(currentLifecycle)).not.toContain('sent');
    expect(JSON.stringify(currentLifecycle)).toContain(CUTOFF.toISOString());

    const processed = setup();
    await processed.service.list(
      { view: 'processed', limit: 25, sort: 'receivedAt', direction: 'desc' },
      NOW,
    );
    const processedLifecycle = JSON.stringify(
      (listRead(processed.prisma).where.AND as unknown[])[0],
    );
    expect(processedLifecycle).toContain(CUTOFF.toISOString());
    expect(processedLifecycle).toContain('reservedByCoverageDecisionId');
  });

  it('translates search, batch, age and counterparty filters without raw-snapshot lookup', async () => {
    const { service, prisma } = setup({
      counterparties: [{ id: 'legacy-counterparty', displayName: 'Клиент V1' }],
    });

    await service.list(
      {
        q: '  рукав 80 ',
        batch: ' STOCK ',
        minAgeDays: 2,
        maxAgeDays: 30,
        counterparty: ' Клиент ',
        limit: 25,
        sort: 'receivedAt',
        direction: 'desc',
      },
      NOW,
    );

    const args = listRead(prisma);
    const where = JSON.stringify(args.where);
    expect(where).toContain('рукав 80');
    expect(where).toContain('STOCK');
    expect(where).toContain('2026-08-05T09:00:00.000Z');
    expect(where).toContain('2026-07-07T09:00:00.000Z');
    expect(where).toContain('Клиент');
    expect(where).toContain('legacy-counterparty');
    expect(where).not.toContain('positionSnapshot');
    expect(prisma.counterparty.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true },
        take: expect.any(Number),
      }),
    );
  });

  it('folds q before searching canonical JSON filmType', async () => {
    const { service, prisma } = setup();

    await service.list(
      { q: '  РУКАВ С ЁЛКОЙ  ', limit: 25, sort: 'receivedAt', direction: 'desc' },
      NOW,
    );

    expect(JSON.stringify(listRead(prisma).where)).toContain(
      '"path":["filmType"],"string_contains":"рукав с елкой"',
    );
  });

  it.each([
    {
      minAgeDays: 0,
      maxAgeDays: 0,
      expectedLte: NOW,
      expectedGt: new Date(NOW.getTime() - DAY_MS_FOR_TEST),
    },
    {
      minAgeDays: 5,
      maxAgeDays: 5,
      expectedLte: new Date(NOW.getTime() - 5 * DAY_MS_FOR_TEST),
      expectedGt: new Date(NOW.getTime() - 6 * DAY_MS_FOR_TEST),
    },
  ])(
    'uses complete integer age buckets for $minAgeDays..$maxAgeDays days',
    async ({ minAgeDays, maxAgeDays, expectedLte, expectedGt }) => {
      const { service, prisma } = setup();

      await service.list(
        {
          minAgeDays,
          maxAgeDays,
          limit: 25,
          sort: 'receivedAt',
          direction: 'desc',
        },
        NOW,
      );

      const clauses = (listRead(prisma).where.AND ?? []) as Array<Record<string, unknown>>;
      expect(clauses.at(-1)).toEqual({
        receivedAt: {
          not: null,
          lte: expectedLte,
          gt: expectedGt,
        },
      });
    },
  );

  it('rejects an inverted age range before querying inventory', async () => {
    const { service, prisma } = setup();

    await expect(
      service.list(
        {
          minAgeDays: 31,
          maxAgeDays: 30,
          limit: 25,
          sort: 'receivedAt',
          direction: 'desc',
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.warehouseRoll.findMany).not.toHaveBeenCalled();
  });

  it('keeps available, reserved and processed SQL predicates fail-closed', async () => {
    const available = setup();
    await available.service.list(
      { status: 'available', limit: 25, sort: 'receivedAt', direction: 'desc' },
      NOW,
    );
    expect((listRead(available.prisma).where.AND as unknown[])[0]).toEqual({
      AND: [
        {
          OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
          ownerCounterpartyId: null,
        },
        { warehouseStatus: 'received' },
        {
          reservedForOrderId: null,
          reservedForPositionId: null,
          reservedByProposalId: null,
          reservedByCoverageDecisionId: null,
        },
      ],
    });

    const reserved = setup();
    await reserved.service.list(
      { status: 'reserved', limit: 25, sort: 'receivedAt', direction: 'desc' },
      NOW,
    );
    expect((listRead(reserved.prisma).where.AND as unknown[])[0]).toEqual({
      AND: [
        {
          OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
          ownerCounterpartyId: null,
        },
        { warehouseStatus: 'received' },
        {
          OR: [
            { reservedForOrderId: { not: null } },
            { reservedForPositionId: { not: null } },
            { reservedByProposalId: { not: null } },
            { reservedByCoverageDecisionId: { not: null } },
          ],
        },
      ],
    });

    const processed = setup();
    await processed.service.list(
      { status: 'processed', limit: 25, sort: 'receivedAt', direction: 'desc' },
      NOW,
    );
    expect((listRead(processed.prisma).where.AND as unknown[])[0]).toEqual({
      AND: [
        {
          OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
          ownerCounterpartyId: null,
        },
        { warehouseStatus: 'delivered' },
        { reservedAt: { gte: CUTOFF } },
        {
          OR: [
            { reservedForOrderId: { not: null } },
            { reservedForPositionId: { not: null } },
            { reservedByProposalId: { not: null } },
            { reservedByCoverageDecisionId: { not: null } },
          ],
        },
      ],
    });
  });

  it('accepts 500 legacy counterparty matches and rejects 501 before inventory lookup', async () => {
    const counterparties = Array.from({ length: 501 }, (_, index) => ({
      id: `counterparty-${index}`,
      displayName: `Клиент ${index}`,
    }));
    const accepted = setup({ counterparties: counterparties.slice(0, 500) });

    await expect(
      accepted.service.list(
        {
          counterparty: 'Клиент',
          limit: 25,
          sort: 'receivedAt',
          direction: 'desc',
        },
        NOW,
      ),
    ).resolves.toMatchObject({ items: expect.any(Array) });
    expect(accepted.prisma.warehouseRoll.findMany).toHaveBeenCalledTimes(1);

    const rejected = setup({ counterparties });
    await expect(
      rejected.service.list(
        {
          counterparty: 'Клиент',
          limit: 25,
          sort: 'receivedAt',
          direction: 'desc',
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rejected.prisma.warehouseRoll.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['receivedAt', 'asc', [{ receivedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]],
    ['receivedAt', 'desc', [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]],
    ['rollCode', 'asc', [{ rollCode: 'asc' }, { id: 'asc' }]],
    ['rollCode', 'desc', [{ rollCode: 'desc' }, { id: 'desc' }]],
  ] as const)('uses canonical %s %s ordering with an ID tie', async (sort, direction, orderBy) => {
    const { service, prisma } = setup();

    await service.list({ limit: 25, sort, direction }, NOW);

    expect(listRead(prisma).orderBy).toEqual(orderBy);
  });

  it('uses limit + 1 and rejects a cursor after normalized filters, sort or direction change', async () => {
    const rows = [
      inventoryRow({ id: 'roll-3', rollCode: 'ROLL-003' }),
      inventoryRow({ id: 'roll-2', rollCode: 'ROLL-002' }),
      inventoryRow({ id: 'roll-1', rollCode: 'ROLL-001' }),
    ];
    const { service, prisma } = setup({ pageRows: rows });
    const first = await service.list(
      { q: '  Рулон   тест ', limit: 2, sort: 'rollCode', direction: 'desc' },
      NOW,
    );

    expect(listRead(prisma).take).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(
      service.list(
        {
          q: 'Рулон тест',
          limit: 2,
          sort: 'rollCode',
          direction: 'asc',
          cursor: first.nextCursor!,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.list(
        {
          q: 'Другой',
          limit: 2,
          sort: 'rollCode',
          direction: 'desc',
          cursor: first.nextCursor!,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.list(
        {
          q: 'Рулон тест',
          view: 'processed',
          limit: 2,
          sort: 'rollCode',
          direction: 'desc',
          cursor: first.nextCursor!,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-canonical base64url cursor encoding', async () => {
    const first = setup({
      pageRows: [
        inventoryRow({ id: 'roll-2', rollCode: 'ROLL-002' }),
        inventoryRow({ id: 'roll-1', rollCode: 'ROLL-001' }),
      ],
    });
    const page = await first.service.list({ limit: 1, sort: 'rollCode', direction: 'desc' }, NOW);
    const next = setup({ pageRows: [] });

    await expect(
      next.service.list(
        {
          limit: 1,
          sort: 'rollCode',
          direction: 'desc',
          cursor: `${page.nextCursor!}=`,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    {
      name: 'future',
      asOf: new Date(NOW.getTime() + 1).toISOString(),
    },
    {
      name: 'older than fifteen minutes',
      asOf: new Date(NOW.getTime() - 15 * 60_000 - 1).toISOString(),
    },
  ])('rejects a $name cursor snapshot', async ({ asOf }) => {
    const first = setup({
      pageRows: [
        inventoryRow({ id: 'roll-2', rollCode: 'ROLL-002' }),
        inventoryRow({ id: 'roll-1', rollCode: 'ROLL-001' }),
      ],
    });
    const page = await first.service.list({ limit: 1, sort: 'rollCode', direction: 'desc' }, NOW);
    const next = setup({ pageRows: [] });

    await expect(
      next.service.list(
        {
          limit: 1,
          sort: 'rollCode',
          direction: 'desc',
          cursor: replaceCursor(page.nextCursor!, { asOf }),
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('binds cursor filters to exact normalized case while accepting whitespace normalization', async () => {
    const rows = [
      inventoryRow({ id: 'roll-2', rollCode: 'ROLL-002' }),
      inventoryRow({ id: 'roll-1', rollCode: 'ROLL-001' }),
    ];
    const first = setup({ pageRows: rows });
    const page = await first.service.list(
      { q: '  Рулон   тест ', limit: 1, sort: 'rollCode', direction: 'desc' },
      NOW,
    );

    const whitespaceOnly = setup({ pageRows: [] });
    await expect(
      whitespaceOnly.service.list(
        {
          q: 'Рулон тест',
          limit: 1,
          sort: 'rollCode',
          direction: 'desc',
          cursor: page.nextCursor!,
        },
        NOW,
      ),
    ).resolves.toMatchObject({ items: [] });

    const changedCase = setup({ pageRows: [] });
    await expect(
      changedCase.service.list(
        {
          q: 'рулон тест',
          limit: 1,
          sort: 'rollCode',
          direction: 'desc',
          cursor: page.nextCursor!,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('anchors later pages to cursor asOf and excludes newly inserted rows with old receivedAt', async () => {
    const first = setup({
      pageRows: [
        inventoryRow({ id: 'roll-2', rollCode: 'ROLL-002' }),
        inventoryRow({ id: 'roll-1', rollCode: 'ROLL-001' }),
      ],
    });
    const page = await first.service.list({ limit: 1, sort: 'rollCode', direction: 'desc' }, NOW);
    const insertedLater = inventoryRow({
      id: 'inserted-later',
      rollCode: 'ROLL-000',
      createdAt: new Date(NOW.getTime() + 1),
      receivedAt: new Date('2026-07-01T08:00:00.000Z'),
    });
    const next = setup({ pageRows: [insertedLater] });

    const result = await next.service.list(
      {
        limit: 1,
        sort: 'rollCode',
        direction: 'desc',
        cursor: page.nextCursor!,
      },
      new Date(NOW.getTime() + 10 * 60_000),
    );

    expect(result.items).toEqual([]);
    expect(JSON.stringify(listRead(next.prisma).where)).toContain(
      `"createdAt":{"lte":"${NOW.toISOString()}"}`,
    );
  });

  it('builds a strict cursor predicate and rejects a repeated page cycle', async () => {
    const rows = [
      inventoryRow({ id: 'roll-3', rollCode: 'ROLL-003' }),
      inventoryRow({ id: 'roll-2', rollCode: 'ROLL-002' }),
      inventoryRow({ id: 'roll-1', rollCode: 'ROLL-001' }),
    ];
    const firstSetup = setup({ pageRows: rows });
    const first = await firstSetup.service.list(
      { limit: 2, sort: 'rollCode', direction: 'desc' },
      NOW,
    );

    const nextSetup = setup({ pageRows: rows });
    await expect(
      nextSetup.service.list(
        {
          limit: 2,
          sort: 'rollCode',
          direction: 'desc',
          cursor: first.nextCursor!,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(listRead(nextSetup.prisma).where)).toContain('"lt":"ROLL-002"');
  });

  it.each([
    {
      sort: 'rollCode',
      direction: 'asc',
      row: inventoryRow({ id: 'cursor-id', rollCode: 'CURSOR-CODE' }),
      expected: '"gt":"CURSOR-CODE"',
    },
    {
      sort: 'rollCode',
      direction: 'desc',
      row: inventoryRow({ id: 'cursor-id', rollCode: 'CURSOR-CODE' }),
      expected: '"lt":"CURSOR-CODE"',
    },
    {
      sort: 'receivedAt',
      direction: 'asc',
      row: inventoryRow({
        id: 'cursor-id',
        receivedAt: new Date('2026-08-01T08:00:00.000Z'),
      }),
      expected: '"gt":"2026-08-01T08:00:00.000Z"',
    },
    {
      sort: 'receivedAt',
      direction: 'desc',
      row: inventoryRow({
        id: 'cursor-id',
        receivedAt: new Date('2026-08-01T08:00:00.000Z'),
      }),
      expected: '"lt":"2026-08-01T08:00:00.000Z"',
    },
    {
      sort: 'receivedAt',
      direction: 'asc',
      row: inventoryRow({
        id: 'cursor-id',
        warehouseStatus: 'sent',
        receivedAt: null,
      }),
      expected: '"receivedAt":null,"id":{"gt":"cursor-id"}',
    },
    {
      sort: 'receivedAt',
      direction: 'desc',
      row: inventoryRow({
        id: 'cursor-id',
        warehouseStatus: 'sent',
        receivedAt: null,
      }),
      expected: '"receivedAt":null,"id":{"lt":"cursor-id"}',
    },
  ] as const)(
    'uses a strict $sort $direction keyset predicate, including null ordering',
    async ({ sort, direction, row, expected }) => {
      const first = setup({
        pageRows: [row, inventoryRow({ id: 'following-id', rollCode: 'FOLLOWING-CODE' })],
      });
      const page = await first.service.list({ limit: 1, sort, direction }, NOW);
      const next = setup({ pageRows: [] });

      await next.service.list({ limit: 1, sort, direction, cursor: page.nextCursor! }, NOW);

      expect(JSON.stringify(listRead(next.prisma).where)).toContain(expected);
    },
  );
});
