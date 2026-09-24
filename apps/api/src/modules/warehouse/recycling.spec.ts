import { recycleDefectToSecondaryStock } from './recycling';

describe('recycleDefectToSecondaryStock', () => {
  it('creates and audits one linked definition, then preserves it on repeat', async () => {
    const stocks = new Map<string, { actualQty: number; rawMaterialDefinitionId: string | null }>();
    const definitions = new Map<string, { id: string; name: string }>();
    const rawMaterialDefinition = {
      findUnique: jest.fn(
        async ({ where }: { where: { normalizedName: string } }) =>
          definitions.get(where.normalizedName) ?? null,
      ),
      createMany: jest.fn(
        async ({ data }: { data: Array<{ name: string; normalizedName: string }> }) => {
          const [candidate] = data;
          if (!candidate || definitions.has(candidate.normalizedName)) return { count: 0 };
          definitions.set(candidate.normalizedName, {
            id: 'definition-secondary',
            name: candidate.name,
          });
          return { count: 1 };
        },
      ),
    };
    const rawMaterialStock = {
      findUnique: jest.fn(
        async ({ where }: { where: { materialId: string } }) =>
          stocks.get(where.materialId) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where,
          update,
          create,
        }: {
          where: { materialId: string };
          update: {
            actualQty: { increment: number };
            rawMaterialDefinitionId?: string;
          };
          create: {
            actualQty: number;
            rawMaterialDefinitionId: string;
          };
        }) => {
          const current = stocks.get(where.materialId);
          const next = current
            ? {
                actualQty: current.actualQty + update.actualQty.increment,
                rawMaterialDefinitionId:
                  update.rawMaterialDefinitionId ?? current.rawMaterialDefinitionId,
              }
            : {
                actualQty: create.actualQty,
                rawMaterialDefinitionId: create.rawMaterialDefinitionId,
              };
          stocks.set(where.materialId, next);
          return { actualQty: next.actualQty };
        },
      ),
    };
    const prisma = { rawMaterialDefinition, rawMaterialStock, domainEvent: {} };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const actor = { userId: 'lead-1', role: 'production_lead' as const };
    const input = {
      rawMaterialId: 'rm-pvd',
      materialLabel: 'ПВД',
      kg: 5,
      rollCode: 'ROLL-1',
      resolution: 'writeoff' as const,
    };

    await recycleDefectToSecondaryStock(prisma as never, audit as never, actor, input);
    await recycleDefectToSecondaryStock(prisma as never, audit as never, actor, {
      ...input,
      materialLabel: 'ПВД — изменённый ярлык',
      kg: 3,
      rollCode: 'ROLL-2',
    });

    expect(rawMaterialDefinition.createMany).toHaveBeenCalledTimes(1);
    expect(rawMaterialStock.upsert.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        update: {
          actualQty: { increment: 5 },
          rawMaterialDefinitionId: 'definition-secondary',
        },
        create: expect.objectContaining({
          rawMaterialDefinitionId: 'definition-secondary',
        }),
      }),
    );
    expect(rawMaterialStock.upsert.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        update: { actualQty: { increment: 3 } },
        create: expect.objectContaining({
          rawMaterialDefinitionId: 'definition-secondary',
        }),
      }),
    );
    expect(audit.record.mock.calls.map(([event]) => event.type)).toEqual([
      'audit:raw_material_definition_created',
      'audit:warehouse_roll_defect_recycled',
      'audit:warehouse_roll_defect_recycled',
    ]);
    expect(stocks.get('rm-secondary-pvd')).toEqual({
      actualQty: 8,
      rawMaterialDefinitionId: 'definition-secondary',
    });
  });

  it('derives a deterministic trimmed catalog name bounded to 120 characters', async () => {
    let definition: { id: string; name: string } | null = null;
    const rawMaterialDefinition = {
      findUnique: jest.fn(async () => definition),
      createMany: jest.fn(
        async ({ data }: { data: Array<{ name: string; normalizedName: string }> }) => {
          definition = { id: 'definition-secondary-long', name: data[0]!.name };
          return { count: 1 };
        },
      ),
    };
    const prisma = {
      rawMaterialDefinition,
      rawMaterialStock: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ actualQty: 5 }),
      },
      domainEvent: {},
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };

    await recycleDefectToSecondaryStock(
      prisma as never,
      audit as never,
      { userId: 'lead-1', role: 'production_lead' },
      {
        rawMaterialId: 'rm-material-with-stable-id',
        materialLabel: `  ${'А'.repeat(120)}  `,
        kg: 5,
        rollCode: 'ROLL-LONG',
      },
    );

    const data = rawMaterialDefinition.createMany.mock.calls[0][0].data[0];
    expect(data.name).toBe(data.name.trim());
    expect([...data.name]).toHaveLength(120);
    expect([...data.normalizedName].length).toBeLessThanOrEqual(120);
    expect(data.name).toMatch(/^Вторсырьё /u);
    expect(data.name).toMatch(/ · [0-9a-f]{12}$/u);
  });

  it('bounds the normalized name when Unicode lowercasing expands code points', async () => {
    let definition: { id: string; name: string } | null = null;
    const rawMaterialDefinition = {
      findUnique: jest.fn(async () => definition),
      createMany: jest.fn(
        async ({ data }: { data: Array<{ name: string; normalizedName: string }> }) => {
          definition = { id: 'definition-secondary-unicode', name: data[0]!.name };
          return { count: 1 };
        },
      ),
    };
    const prisma = {
      rawMaterialDefinition,
      rawMaterialStock: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ actualQty: 5 }),
      },
      domainEvent: {},
    };

    await recycleDefectToSecondaryStock(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { userId: 'lead-1', role: 'production_lead' },
      {
        rawMaterialId: 'rm-unicode-expansion',
        materialLabel: 'İ'.repeat(110),
        kg: 5,
        rollCode: 'ROLL-UNICODE',
      },
    );

    const data = rawMaterialDefinition.createMany.mock.calls[0][0].data[0];
    expect([...data.name].length).toBeLessThanOrEqual(120);
    expect([...data.normalizedName].length).toBeLessThanOrEqual(120);
    expect(data.name).toMatch(/ · [0-9a-f]{12}$/u);
  });

  it('canonicalizes sequential fractional audit transitions without rounding persisted stock', async () => {
    let actualQty = 0;
    const rawMaterialStock = {
      findUnique: jest.fn(async () => ({
        actualQty,
        rawMaterialDefinitionId: 'definition-secondary',
      })),
      upsert: jest.fn(async ({ update }: { update: { actualQty: { increment: number } } }) => {
        actualQty += update.actualQty.increment;
        return { actualQty };
      }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = { rawMaterialDefinition: {}, rawMaterialStock, domainEvent: {} };
    const actor = { userId: 'lead-1', role: 'production_lead' as const };
    const results = [];
    for (const [kg, rollCode] of [
      [0.1, 'ROLL-1'],
      [0.2, 'ROLL-2'],
      [0.3, 'ROLL-3'],
    ] as const) {
      results.push(
        await recycleDefectToSecondaryStock(prisma as never, audit as never, actor, {
          rawMaterialId: 'rm-pvd',
          materialLabel: 'ПВД',
          kg,
          rollCode,
        }),
      );
    }

    const transitions = audit.record.mock.calls.map(([event]) => ({
      oldValue: event.oldValue,
      newValue: event.newValue,
    }));
    expect(transitions).toEqual([
      { oldValue: { actualQty: 0 }, newValue: { actualQty: 0.1 } },
      { oldValue: { actualQty: 0.1 }, newValue: { actualQty: 0.3 } },
      { oldValue: { actualQty: 0.3 }, newValue: { actualQty: 0.6 } },
    ]);
    expect(actualQty).toBe(0.6000000000000001);
    expect(results.at(-1)?.actualQty).toBe(actualQty);
  });

  it('keeps canonical fractional audit continuity under concurrent first recycle calls', async () => {
    const definitions = new Map<string, { id: string; name: string }>();
    let actualQty = 0;
    let rawMaterialDefinitionId: string | null = null;
    const rawMaterialDefinition = {
      createMany: jest.fn(
        async ({ data }: { data: Array<{ name: string; normalizedName: string }> }) => {
          const [candidate] = data;
          if (!candidate || definitions.has(candidate.normalizedName)) return { count: 0 };
          definitions.set(candidate.normalizedName, {
            id: 'definition-secondary',
            name: candidate.name,
          });
          return { count: 1 };
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { normalizedName: string } }) =>
          definitions.get(where.normalizedName) ?? null,
      ),
    };
    const rawMaterialStock = {
      findUnique: jest.fn(async () =>
        rawMaterialDefinitionId ? { actualQty, rawMaterialDefinitionId } : null,
      ),
      upsert: jest.fn(
        async ({
          update,
          create,
        }: {
          update: {
            actualQty: { increment: number };
            rawMaterialDefinitionId?: string;
          };
          create: { actualQty: number; rawMaterialDefinitionId: string };
        }) => {
          actualQty =
            rawMaterialDefinitionId === null
              ? create.actualQty
              : actualQty + update.actualQty.increment;
          rawMaterialDefinitionId =
            update.rawMaterialDefinitionId ?? create.rawMaterialDefinitionId;
          return { actualQty };
        },
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = { rawMaterialDefinition, rawMaterialStock, domainEvent: {} };
    const actor = { userId: 'lead-1', role: 'production_lead' as const };

    await Promise.all([
      recycleDefectToSecondaryStock(prisma as never, audit as never, actor, {
        rawMaterialId: 'rm-pvd',
        materialLabel: 'ПВД',
        kg: 0.1,
        rollCode: 'ROLL-1',
      }),
      recycleDefectToSecondaryStock(prisma as never, audit as never, actor, {
        rawMaterialId: 'rm-pvd',
        materialLabel: 'ПВД',
        kg: 0.1,
        rollCode: 'ROLL-2',
      }),
      recycleDefectToSecondaryStock(prisma as never, audit as never, actor, {
        rawMaterialId: 'rm-pvd',
        materialLabel: 'ПВД',
        kg: 0.1,
        rollCode: 'ROLL-3',
      }),
      recycleDefectToSecondaryStock(prisma as never, audit as never, actor, {
        rawMaterialId: 'rm-pvd',
        materialLabel: 'ПВД',
        kg: 0.1,
        rollCode: 'ROLL-4',
      }),
    ]);

    expect(rawMaterialDefinition.createMany).toHaveBeenCalledTimes(4);
    expect(
      audit.record.mock.calls.filter(
        ([event]) => event.type === 'audit:raw_material_definition_created',
      ),
    ).toHaveLength(1);
    const transitions = audit.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'audit:warehouse_roll_defect_recycled')
      .map((event) => ({ oldValue: event.oldValue, newValue: event.newValue }))
      .sort((left, right) => left.newValue.actualQty - right.newValue.actualQty);
    expect(transitions).toEqual([
      { oldValue: { actualQty: 0 }, newValue: { actualQty: 0.1 } },
      { oldValue: { actualQty: 0.1 }, newValue: { actualQty: 0.2 } },
      { oldValue: { actualQty: 0.2 }, newValue: { actualQty: 0.3 } },
      { oldValue: { actualQty: 0.3 }, newValue: { actualQty: 0.4 } },
    ]);
    expect(actualQty).toBe(0.4);
    expect(rawMaterialDefinitionId).toBe('definition-secondary');
  });
});
