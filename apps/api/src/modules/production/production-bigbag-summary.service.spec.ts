import type { PrismaService } from '../../common/prisma/prisma.service';
import { ProductionBigBagSummaryService } from './production-bigbag-summary.service';

function bigBag(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bag-required',
    code: 'BB-REQUIRED',
    material: 'ПВД Первичное',
    baseRawMaterialDefinitionId: 'material-a',
    status: 'available',
    currentKg: 400,
    shiftUsages: [],
    ...overrides,
  };
}

function setup() {
  const prisma = {
    rollDispatchItem: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ orderLineId: 'position-base' }, { orderLineId: 'position-recipe' }]),
    },
    commercialOrderPosition: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'position-base',
          baseRawMaterialDefinitionId: 'material-a',
          recipeDefinitionVersion: null,
        },
        {
          id: 'position-recipe',
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersion: {
            ingredients: [
              { rawMaterialDefinitionId: 'material-c' },
              { rawMaterialDefinitionId: 'material-d' },
            ],
          },
        },
      ]),
    },
    bigBagUnit: {
      findMany: jest.fn().mockResolvedValue([
        bigBag({
          id: 'bag-in-use',
          code: 'BB-IN-USE',
          shiftUsages: [{ id: 'usage-open' }],
        }),
        bigBag(),
        bigBag({
          id: 'bag-return',
          code: 'BB-RETURN',
          material: 'ПВД Вторичное',
          baseRawMaterialDefinitionId: 'material-b',
        }),
      ]),
    },
  };
  return {
    service: new ProductionBigBagSummaryService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe('ProductionBigBagSummaryService', () => {
  it('classifies production bags into in-use, idle and not-required counts', async () => {
    const { service, prisma } = setup();

    const summary = await service.getSummary();

    expect(prisma.rollDispatchItem.findMany).toHaveBeenCalledWith({
      where: {
        orderLineId: { not: null },
        status: { notIn: ['ready_for_warehouse', 'done', 'defect'] },
      },
      select: { orderLineId: true },
      distinct: ['orderLineId'],
    });
    expect(prisma.bigBagUnit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ['available', 'in_use'] },
          registrationStatus: 'registered',
          location: 'production',
        },
      }),
    );
    expect(summary.counts).toEqual({
      total: 3,
      inUse: 1,
      idle: 2,
      notRequired: 1,
    });
    expect(summary.returnCandidates).toEqual([
      expect.objectContaining({
        id: 'bag-return',
        code: 'BB-RETURN',
        classification: 'idle_not_required',
      }),
    ]);
    expect(JSON.stringify(summary)).not.toContain('shiftUsages');
  });

  it('treats every component of an active recipe as required', async () => {
    const { service, prisma } = setup();
    prisma.bigBagUnit.findMany.mockResolvedValue([
      bigBag({
        id: 'bag-recipe-component',
        code: 'BB-RECIPE-COMPONENT',
        material: 'Добавка C',
        baseRawMaterialDefinitionId: 'material-c',
      }),
    ]);

    const summary = await service.getSummary();

    expect(summary.counts.notRequired).toBe(0);
    expect(summary.bags[0].classification).toBe('idle_required');
    expect(summary.returnCandidates).toEqual([]);
  });

  it('never marks a legacy bag without an unambiguous product id as not required', async () => {
    const { service, prisma } = setup();
    prisma.bigBagUnit.findMany.mockResolvedValue([
      bigBag({
        id: 'bag-legacy',
        code: 'BB-LEGACY',
        material: 'Старое сырьё',
        baseRawMaterialDefinitionId: null,
      }),
    ]);

    const summary = await service.getSummary();

    expect(summary.counts).toEqual({
      total: 1,
      inUse: 0,
      idle: 1,
      notRequired: 0,
    });
    expect(summary.bags[0].classification).toBe('idle_unclassified');
    expect(summary.returnCandidates).toEqual([]);
  });

  it('fails safe when a legacy in-use status has no open usage row', async () => {
    const { service, prisma } = setup();
    prisma.bigBagUnit.findMany.mockResolvedValue([
      bigBag({
        id: 'bag-legacy-in-use',
        code: 'BB-LEGACY-IN-USE',
        status: 'in_use',
        shiftUsages: [],
      }),
    ]);

    const summary = await service.getSummary();

    expect(summary.counts.inUse).toBe(1);
    expect(summary.bags[0].classification).toBe('in_use');
    expect(summary.returnCandidates).toEqual([]);
  });
});
