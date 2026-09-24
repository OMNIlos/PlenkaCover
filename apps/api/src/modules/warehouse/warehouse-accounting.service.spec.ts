import { WarehouseAccountingService } from './warehouse-accounting.service';

const CAPTURED_AT = new Date('2026-07-29T08:00:00.000Z');
const SYNCED_AT = new Date('2026-07-29T08:05:00.000Z');

function setup() {
  const prisma = {
    oneCNomenclatureItem: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    oneCShipment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return {
    prisma,
    service: new WarehouseAccountingService(prisma as never),
  };
}

describe('WarehouseAccountingService', () => {
  it('aggregates account 41.01 balances without exposing money or source payloads', async () => {
    const { prisma, service } = setup();
    prisma.oneCNomenclatureItem.findMany.mockResolvedValue([
      {
        externalId: 'material-1',
        name: 'Пленка готовая',
        kindName: 'Товары',
        unitName: 'кг',
        stockBalances: [
          { quantity: 10, capturedAt: CAPTURED_AT, syncedAt: SYNCED_AT },
          { quantity: 2.5, capturedAt: CAPTURED_AT, syncedAt: SYNCED_AT },
        ],
      },
    ]);

    const result = await service.listStock({ scope: 'goods', limit: 20 }, CAPTURED_AT);

    expect(result.items).toEqual([
      {
        nomenclatureExternalId: 'material-1',
        name: 'Пленка готовая',
        kind: 'Товары',
        unit: 'кг',
        quantity: 12.5,
        balanceStatus: 'positive',
        capturedAt: CAPTURED_AT.toISOString(),
        importedAt: SYNCED_AT.toISOString(),
        stale: false,
        physicalTraceability: 'unavailable',
      },
    ]);
    expect(result).toMatchObject({
      accountCode: '41.01',
      scope: 'goods',
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/amount|counterparty|rawPayload/i);
    expect(prisma.oneCNomenclatureItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stockBalances: { some: { accountCode: '41.01' } },
        }),
      }),
    );
  });

  it('limits the consumables projection to explicit accounting kinds', async () => {
    const { prisma, service } = setup();

    await service.listStock({ scope: 'consumables', limit: 20 }, CAPTURED_AT);

    expect(prisma.oneCNomenclatureItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kindName: {
            in: [
              'Материалы',
              'Малоценное оборудование и запасы',
              'Инвентарь и хозяйственные принадлежности (применяется до 2022 года)',
            ],
          },
        }),
      }),
    );
  });

  it('keeps consumable accounting kinds out of the goods projection', async () => {
    const { prisma, service } = setup();

    await service.listStock({ scope: 'goods', limit: 20 }, CAPTURED_AT);

    expect(prisma.oneCNomenclatureItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kindName: {
            notIn: [
              'Материалы',
              'Малоценное оборудование и запасы',
              'Инвентарь и хозяйственные принадлежности (применяется до 2022 года)',
            ],
          },
        }),
      }),
    );
  });

  it('returns safe posted 1C shipment movements without financial fields', async () => {
    const { prisma, service } = setup();
    prisma.oneCShipment.findMany.mockResolvedValue([
      {
        externalId: 'shipment-1',
        number: 'РТУ-42',
        date: new Date('2026-07-28T09:30:00.000Z'),
        capturedAt: CAPTURED_AT,
        syncedAt: SYNCED_AT,
        lines: [
          {
            lineNumber: 1,
            name: null,
            quantity: 4,
            nomenclature: { name: 'Рукав 500', unitName: 'кг' },
          },
        ],
      },
    ]);

    const result = await service.listMovements({ limit: 20 });

    expect(result.items).toEqual([
      {
        externalId: 'shipment-1',
        documentNumber: 'РТУ-42',
        documentDate: '2026-07-28T09:30:00.000Z',
        direction: 'outbound',
        sourceLabel: 'Отгрузка по 1С',
        capturedAt: CAPTURED_AT.toISOString(),
        importedAt: SYNCED_AT.toISOString(),
        physicalTraceability: 'unavailable',
        lines: [
          {
            lineNumber: 1,
            name: 'Рукав 500',
            quantity: 4,
            unit: 'кг',
          },
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/total|amount|price|counterparty|rawPayload/i);
    const query = prisma.oneCShipment.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({ posted: true, deleted: false });
    expect(query.select).not.toHaveProperty('total');
    expect(query.select).not.toHaveProperty('counterpartyExternalId');
  });
});
