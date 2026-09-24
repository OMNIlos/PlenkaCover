import { FinanceRawMaterialService } from './finance-raw-material.service';

describe('FinanceRawMaterialService', () => {
  it('projects each BigBag independently with backend kopeck valuations', async () => {
    const prisma = {
      bigBagUnit: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bag-1',
            code: 'BB-001',
            material: 'ПВД 10803-020',
            supplierName: 'ООО Гранула',
            receivedAt: new Date('2026-08-01T07:30:00.000Z'),
            batchCode: 'LOT-01',
            initialKg: 12.345,
            currentKg: 7.5,
            lastMeasuredKg: 7.5,
            lastMeasuredAt: new Date('2026-08-11T09:00:00.000Z'),
            lastWarehouseMeasuredKg: 8.1,
            lastWarehouseMeasuredAt: new Date('2026-08-10T10:00:00.000Z'),
            priceKopecksPerKg: 2_500,
            createdAt: new Date('2026-08-01T08:00:00.000Z'),
          },
          {
            id: 'bag-2',
            code: 'BB-002',
            material: 'ПВД 10803-020',
            supplierName: null,
            receivedAt: null,
            batchCode: 'LOT-02',
            initialKg: null,
            currentKg: null,
            lastMeasuredKg: null,
            lastMeasuredAt: null,
            lastWarehouseMeasuredKg: null,
            lastWarehouseMeasuredAt: null,
            priceKopecksPerKg: null,
            createdAt: new Date('2026-08-02T08:00:00.000Z'),
          },
        ]),
      },
    };
    const service = new FinanceRawMaterialService(prisma as never);

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'bag-1',
        code: 'BB-001',
        supplier: 'ООО Гранула',
        receivedAt: '2026-08-01T07:30:00.000Z',
        batchCode: 'LOT-01',
        initialWeightKg: '12.345',
        purchasePricePerKg: '25.00',
        initialValue: '308.63',
        currentWeightKg: '7.500',
        currentValue: '187.50',
        consumedWeightKg: '4.845',
        consumedValue: '121.13',
        measuredAt: '2026-08-11T09:00:00.000Z',
      }),
      expect.objectContaining({
        id: 'bag-2',
        code: 'BB-002',
        batchCode: 'LOT-02',
        supplier: null,
        receivedAt: null,
        initialWeightKg: null,
        purchasePricePerKg: null,
        initialValue: null,
        currentWeightKg: null,
        currentValue: null,
        consumedWeightKg: null,
        consumedValue: null,
      }),
    ]);
    expect(prisma.bigBagUnit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ supplierName: true, receivedAt: true }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });
});
