import { CommercialBigBagValueService } from './commercial-bigbag-value.service';

describe('CommercialBigBagValueService', () => {
  it('projects current platform weight and recalculated value without sensitive bag internals', async () => {
    const prisma = {
      bigBagUnit: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bag-1',
            code: 'BB-001',
            material: 'ПВД',
            status: 'available',
            location: 'warehouse',
            initialKg: 500,
            currentKg: 480,
            lastMeasuredKg: 480,
            lastMeasuredAt: new Date('2026-08-06T00:10:00.000Z'),
            priceKopecksPerKg: 2_500,
            priceEffectiveAt: new Date('2026-08-05T12:00:00.000Z'),
            rawPayload: { forbidden: true },
          },
        ]),
      },
    };
    const service = new CommercialBigBagValueService(prisma as never);

    await expect(service.list()).resolves.toEqual([
      {
        id: 'bag-1',
        code: 'BB-001',
        material: 'ПВД',
        status: 'available',
        location: 'warehouse',
        currentKg: 480,
        currentMeasuredAt: '2026-08-06T00:10:00.000Z',
        priceKopecksPerKg: 2_500,
        totalKopecks: 1_200_000,
        priceEffectiveAt: '2026-08-05T12:00:00.000Z',
      },
    ]);
    expect(prisma.bigBagUnit.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['available', 'in_use'] } },
      select: {
        id: true,
        code: true,
        material: true,
        status: true,
        location: true,
        initialKg: true,
        currentKg: true,
        lastMeasuredKg: true,
        lastMeasuredAt: true,
        priceKopecksPerKg: true,
        priceEffectiveAt: true,
      },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });
  });
});
