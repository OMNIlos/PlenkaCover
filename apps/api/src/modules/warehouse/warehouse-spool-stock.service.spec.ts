import { ConflictException, NotFoundException } from '@nestjs/common';
import { WarehouseSpoolStockService } from './warehouse-spool-stock.service';

const actor = { userId: 'operator-1', role: 'operator' as const };

function harness() {
  const movements = new Map<string, Record<string, unknown>>();
  const prisma = {
    defectRecord: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'defect-1',
        weightCapture: { spoolKg: 0.7 },
        line: {
          spoolKg: 0.7,
          rollDispatchItem: {
            rollCode: 'ROLL-0001',
            orderLineId: 'position-1',
            characteristicsSnapshot: { spoolType: 'Тонкая' },
          },
        },
      }),
    },
    commercialOrderPosition: {
      findUnique: jest.fn().mockResolvedValue({ spoolType: 'Тонкая' }),
    },
    spoolStockMovement: {
      createMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (movements.has(String(data.defectRecordId))) return Promise.resolve({ count: 0 });
        movements.set(String(data.defectRecordId), {
          id: 'spool-return-1',
          createdAt: new Date('2026-08-06T06:00:00.000Z'),
          ...data,
        });
        return Promise.resolve({ count: 1 });
      }),
      findUnique: jest.fn(({ where }: { where: { defectRecordId: string } }) =>
        Promise.resolve(movements.get(where.defectRecordId) ?? null),
      ),
      aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: 1 } }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  return {
    audit,
    prisma,
    service: new WarehouseSpoolStockService(prisma as never, audit as never),
  };
}

describe('WarehouseSpoolStockService', () => {
  it('returns exactly one spool for a finalized physical defect and is idempotent by defect', async () => {
    const { audit, prisma, service } = harness();

    const first = await service.returnDefectSpool(actor, 'defect-1', prisma as never);
    const retry = await service.returnDefectSpool(actor, 'defect-1', prisma as never);

    expect(first).toEqual({
      id: 'spool-return-1',
      defectRecordId: 'defect-1',
      rollCode: 'ROLL-0001',
      spoolType: 'Тонкая',
      tareKg: 0.7,
      quantity: 1,
      location: 'warehouse',
      returnedByRole: 'operator',
      returnedById: 'operator-1',
      createdAt: new Date('2026-08-06T06:00:00.000Z'),
    });
    expect(retry).toEqual(first);
    expect(prisma.spoolStockMovement.createMany).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:defect_spool_returned',
        objectId: 'ROLL-0001',
        newValue: {
          defectRecordId: 'defect-1',
          spoolType: 'Тонкая',
          tareKg: 0.7,
          quantity: 1,
          location: 'warehouse',
        },
      }),
      prisma,
    );
  });

  it('falls back to the canonical order position when the dispatch snapshot has no spool type', async () => {
    const { prisma, service } = harness();
    prisma.defectRecord.findUnique.mockResolvedValue({
      id: 'defect-2',
      weightCapture: { spoolKg: 2.4 },
      line: {
        spoolKg: 2.4,
        rollDispatchItem: {
          rollCode: 'ROLL-0002',
          orderLineId: 'position-2',
          characteristicsSnapshot: {},
        },
      },
    });
    prisma.commercialOrderPosition.findUnique.mockResolvedValue({ spoolType: 'Толстая' });

    await service.returnDefectSpool(actor, 'defect-2', prisma as never);

    expect(prisma.spoolStockMovement.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        defectRecordId: 'defect-2',
        spoolType: 'Толстая',
        tareKg: 2.4,
      }),
      skipDuplicates: true,
    });
  });

  it('does not fabricate a stock return without durable positive spool evidence', async () => {
    const { prisma, service } = harness();
    prisma.defectRecord.findUnique.mockResolvedValue({
      id: 'defect-3',
      weightCapture: { spoolKg: null },
      line: {
        spoolKg: null,
        rollDispatchItem: {
          rollCode: 'ROLL-0003',
          orderLineId: null,
          characteristicsSnapshot: { spoolType: 'Тонкая' },
        },
      },
    });

    await expect(
      service.returnDefectSpool(actor, 'defect-3', prisma as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.spoolStockMovement.createMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown defect instead of creating an orphan movement', async () => {
    const { prisma, service } = harness();
    prisma.defectRecord.findUnique.mockResolvedValue(null);

    await expect(
      service.returnDefectSpool(actor, 'missing', prisma as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
