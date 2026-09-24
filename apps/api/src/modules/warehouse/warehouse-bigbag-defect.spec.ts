import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { WarehouseBigBagService } from './warehouse-bigbag.service';

const actor = { userId: 'wh-1', role: 'warehouse' as const };

const recipeSelection = {
  baseRawMaterialDefinitionId: null,
  recipeDefinitionId: 'recipe-film',
  recipeDefinitionVersionId: 'recipe-film-v3',
  version: 3,
  name: 'Плёнка с Айкой',
  ingredients: [
    {
      rawMaterialDefinitionId: 'material-primary',
      name: 'Первичное',
      shareBasisPoints: 6000,
    },
    {
      rawMaterialDefinitionId: 'material-aika',
      name: 'Айка',
      shareBasisPoints: 4000,
    },
  ],
};

const recipeStocks = [
  {
    id: 'stock-primary',
    materialId: 'rm-primary',
    label: 'Первичное',
    actualQty: 200,
    rawMaterialDefinitionId: 'material-primary',
  },
  {
    id: 'stock-aika',
    materialId: 'rm-aika',
    label: 'Айка',
    actualQty: 80,
    rawMaterialDefinitionId: 'material-aika',
  },
];

function setup(over: Record<string, any> = {}) {
  const prisma: any = {
    rawMaterialStock: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'stock-pvd-15803',
        materialId: 'rm-pvd-15803',
        label: 'ПВД 15803-020',
        actualQty: 320,
        rawMaterialDefinitionId: 'material-pvd-15803',
      }),
      update: jest.fn().mockResolvedValue({ actualQty: 200 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateManyAndReturn: jest.fn().mockImplementation(({ where, data }: any) => {
        const actualQtyById: Record<string, number> = {
          'stock-pvd-15803': 320,
          'stock-primary': 200,
          'stock-aika': 80,
        };
        return Promise.resolve([
          {
            actualQty: (actualQtyById[where.id] ?? 0) - data.actualQty.decrement,
          },
        ]);
      }),
      upsert: jest
        .fn()
        .mockResolvedValue({ materialId: 'rm-secondary-pvd-15803', actualQty: 38.5 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rawMaterialDefinition: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'material-pvd-15803',
        name: 'ПВД 15803-020',
        status: 'active',
      }),
    },
    bigBagUnit: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'bag-9', ...data })),
      count: jest.fn().mockResolvedValue(2),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    warehouseAcceptanceTask: {
      findUnique: jest.fn().mockResolvedValue({
        id: 't1',
        mode: 'receiving',
        status: 'open',
        rows: [],
      }),
      update: jest.fn(),
    },
    scanRow: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'sr1',
        taskId: 't1',
        rollCode: 'A-1024-roll-1',
        scanStatus: 'expected',
      }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      create: jest.fn(),
    },
    operatorRollLine: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'l1',
        planKg: 40,
        netKg: 41.2,
        warehouseState: 'sent',
        rollDispatchItem: {
          id: 'r1',
          rollCode: 'A-1024-roll-1',
          rawMaterialId: 'rm-pvd-15803',
          productionOrder: { id: 'po1', commercialOrderId: 'co1', approvalState: 'approved' },
        },
      }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    weightCapture: { create: jest.fn() },
    warehouseRoll: {
      findUnique: jest.fn().mockResolvedValue({ rollCode: 'A-1024-roll-1' }),
      update: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    rollDispatchItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    productionProblem: { create: jest.fn().mockResolvedValue({ id: 'problem-9' }) },
    palletListDocument: { create: jest.fn(), findUnique: jest.fn() },
    warehouseOperation: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...over,
  };
  prisma.$transaction = jest.fn(async (cb: (tx: any) => unknown) => cb(prisma));
  const audit = { record: jest.fn() };
  const deferredPayment = { activatePostDeliveryPayments: jest.fn() };
  const fulfillmentHandoff = {
    reconcile: jest.fn().mockResolvedValue({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'incomplete',
    }),
  };
  const recipes = {
    resolveSelections: jest.fn(),
  };
  const bigBags = new WarehouseBigBagService(prisma, audit as any, recipes as never);
  const service = new WarehouseService(
    prisma,
    audit as any,
    deferredPayment as any,
    fulfillmentHandoff as never,
    { expireStaleControlWeights: jest.fn().mockResolvedValue([]) } as never,
    { assertNoOpenItems: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, bigBags, prisma, audit, recipes };
}

describe('createBigBag', () => {
  it.each([
    ['secondary', 'Вторичка'],
    ['aika', 'Айка'],
    ['primary_tape', 'Первичка ленты'],
    ['pvd_tsp', 'ПВД ТСП'],
    ['danaflex', 'Данафлекс'],
    ['stretch', 'Стрейч'],
  ] as const)(
    'registers the fixed %s material as a manual warehouse fact',
    async (preset, label) => {
      const { bigBags, prisma, audit } = setup();

      const bag = await bigBags.create(actor, { materialPreset: preset, weightKg: 500 });

      expect(prisma.rawMaterialStock.findUnique).not.toHaveBeenCalled();
      expect(prisma.rawMaterialStock.updateManyAndReturn).not.toHaveBeenCalled();
      expect(bag).toEqual(
        expect.objectContaining({
          material: label,
          materialId: null,
          materialSelectionKind: 'preset',
          materialPreset: preset,
          initialKg: 500,
          composition: [
            expect.objectContaining({
              materialId: `bigbag-preset:${preset}`,
              name: label,
              shareBasisPoints: 10_000,
              initialKg: 500,
            }),
          ],
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({
            materialSelectionKind: 'preset',
            materialPreset: preset,
            manualWarehouseFact: true,
          }),
        }),
        prisma,
      );
    },
  );

  it('deducts the raw material stock and records the creation event', async () => {
    const { bigBags, prisma, audit } = setup();
    const bag = await bigBags.create(actor, { materialId: 'rm-pvd-15803', weightKg: 120 });
    expect(prisma.rawMaterialStock.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'stock-pvd-15803', actualQty: { gte: 120 } },
        data: { actualQty: { decrement: 120 } },
        select: { actualQty: true },
      }),
    );
    expect(bag).toEqual(
      expect.objectContaining({
        materialId: 'rm-pvd-15803',
        initialKg: 120,
        currentKg: 120,
        status: 'available',
      }),
    );
    const event = audit.record.mock.calls.find((c: any[]) => c[0].type === 'audit:bigbag_created');
    expect(event[0].oldValue).toEqual({ actualQty: 320 });
    expect(event[0].newValue).toEqual(expect.objectContaining({ actualQty: 200 }));
  });

  it('409s when the stock cannot cover the bag and leaves the stock intact', async () => {
    const { bigBags, prisma } = setup();
    await expect(
      bigBags.create(actor, { materialId: 'rm-pvd-15803', weightKg: 500 }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.rawMaterialStock.updateManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.bigBagUnit.create).not.toHaveBeenCalled();
  });

  it('404s on an unknown material', async () => {
    const { bigBags } = setup({
      rawMaterialStock: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn(),
        updateManyAndReturn: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
      },
    });
    await expect(bigBags.create(actor, { materialId: 'rm-nope', weightKg: 10 })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('generates a sequential code when none is given', async () => {
    const { bigBags, prisma } = setup();
    await bigBags.create(actor, { materialId: 'rm-pvd-15803', weightKg: 100 });
    expect(prisma.bigBagUnit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: 'BB-PVD-15803-03' }) }),
    );
  });

  it('creates one Big-Bag from a saved recipe and deducts every granule component atomically', async () => {
    const { bigBags, prisma, audit, recipes } = setup();
    recipes.resolveSelections.mockResolvedValue([recipeSelection]);
    prisma.rawMaterialStock.findMany.mockResolvedValue(recipeStocks);

    const bag = await bigBags.create(actor, {
      recipeDefinitionVersionId: 'recipe-film-v3',
      weightKg: 100,
    });

    expect(recipes.resolveSelections).toHaveBeenCalledWith(prisma, [
      { recipeDefinitionVersionId: 'recipe-film-v3' },
    ]);
    expect(prisma.rawMaterialStock.updateManyAndReturn).toHaveBeenCalledTimes(2);
    expect(prisma.rawMaterialStock.updateManyAndReturn).toHaveBeenNthCalledWith(1, {
      where: { id: 'stock-aika', actualQty: { gte: 40 } },
      data: { actualQty: { decrement: 40 } },
      select: { actualQty: true },
    });
    expect(prisma.rawMaterialStock.updateManyAndReturn).toHaveBeenNthCalledWith(2, {
      where: { id: 'stock-primary', actualQty: { gte: 60 } },
      data: { actualQty: { decrement: 60 } },
      select: { actualQty: true },
    });
    expect(bag).toEqual(
      expect.objectContaining({
        code: 'BB-ПЛЁНКА-С-АЙКОЙ-03',
        material: 'Плёнка с Айкой',
        materialId: null,
        materialSelectionKind: 'recipe',
        recipeDefinitionVersionId: 'recipe-film-v3',
        recipeName: 'Плёнка с Айкой',
        recipeVersionNumber: 3,
        composition: [
          expect.objectContaining({
            materialId: 'rm-primary',
            name: 'Первичное',
            shareBasisPoints: 6000,
            initialKg: 60,
          }),
          expect.objectContaining({
            materialId: 'rm-aika',
            name: 'Айка',
            shareBasisPoints: 4000,
            initialKg: 40,
          }),
        ],
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:bigbag_created',
        detail: expect.objectContaining({
          materialSelectionKind: 'recipe',
          recipeDefinitionVersionId: 'recipe-film-v3',
        }),
      }),
      prisma,
    );
  });

  it('does not deduct any recipe component when one granule stock is insufficient', async () => {
    const { bigBags, prisma, recipes } = setup();
    recipes.resolveSelections.mockResolvedValue([recipeSelection]);
    prisma.rawMaterialStock.findMany.mockResolvedValue([
      recipeStocks[0],
      {
        ...recipeStocks[1],
        actualQty: 39.999,
      },
    ]);

    await expect(
      bigBags.create(actor, {
        recipeDefinitionVersionId: 'recipe-film-v3',
        weightKg: 100,
      }),
    ).rejects.toThrow(/Недостаточно сырья «Айка»/u);
    expect(prisma.rawMaterialStock.updateManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.bigBagUnit.create).not.toHaveBeenCalled();
  });

  it('rejects a recipe weight that rounds one ingredient to zero', async () => {
    const { bigBags, prisma, recipes } = setup();
    recipes.resolveSelections.mockResolvedValue([recipeSelection]);

    await expect(
      bigBags.create(actor, {
        recipeDefinitionVersionId: 'recipe-film-v3',
        weightKg: 0.001,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BIGBAG_WEIGHT_BELOW_RECIPE_PRECISION',
      }),
    });
    expect(prisma.rawMaterialStock.findMany).not.toHaveBeenCalled();
    expect(prisma.rawMaterialStock.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it('creates a one-component Big-Bag by raw-material catalog identity', async () => {
    const { bigBags, prisma } = setup();
    prisma.rawMaterialDefinition.findUnique.mockResolvedValue({
      id: 'material-aika',
      name: 'Айка',
      status: 'active',
      isProductionSelectable: true,
    });

    const bag = await bigBags.create(actor, {
      baseRawMaterialDefinitionId: 'material-aika',
      weightKg: 25,
    });

    expect(bag).toEqual(
      expect.objectContaining({
        material: 'Айка',
        materialId: null,
        materialSelectionKind: 'material',
        baseRawMaterialDefinitionId: 'material-aika',
        composition: [
          expect.objectContaining({
            rawMaterialDefinitionId: 'material-aika',
            materialId: 'bigbag-material:material-aika',
            initialKg: 25,
          }),
        ],
      }),
    );
    expect(prisma.rawMaterialStock.findMany).not.toHaveBeenCalled();
    expect(prisma.rawMaterialStock.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous Big-Bag material selection before touching stock', async () => {
    const { bigBags, prisma } = setup();

    await expect(
      bigBags.create(actor, {
        materialId: 'rm-pvd-15803',
        recipeDefinitionVersionId: 'recipe-film-v3',
        weightKg: 100,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.rawMaterialStock.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it('rejects a missing Big-Bag material selection before touching stock', async () => {
    const { bigBags, prisma } = setup();

    await expect(bigBags.create(actor, { weightKg: 100 })).rejects.toThrow(BadRequestException);
    expect(prisma.rawMaterialStock.findMany).not.toHaveBeenCalled();
    expect(prisma.rawMaterialStock.updateManyAndReturn).not.toHaveBeenCalled();
  });
});

describe('closeTask full-close guard', () => {
  it('409s a full close while expected rolls remain', async () => {
    const { service, prisma } = setup();
    prisma.scanRow.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.scanStatus === 'accepted'
          ? []
          : [{ id: 'sr1', rollCode: 'A-1024-roll-2', scanStatus: 'expected' }],
      ),
    );
    prisma.scanRow.count = jest.fn().mockResolvedValue(1);
    await expect(service.closeTask(actor, 't1', { mode: 'full' })).rejects.toThrow(
      ConflictException,
    );
  });
});
