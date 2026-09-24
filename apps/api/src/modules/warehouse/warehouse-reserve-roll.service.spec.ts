import { BadRequestException, ConflictException } from '@nestjs/common';
import { WarehouseReserveRollService } from './warehouse-reserve-roll.service';

const actor = {
  userId: 'warehouse-user',
  role: 'warehouse' as const,
  capabilities: ['reserve_roll:create' as const],
};

const command = {
  operationKey: '018f0b6a-7094-4b54-8c88-cb44c92807eb',
  rollCode: 'RES-2026-001',
  batchCode: 'ПАРТИЯ-08-06',
  filmType: 'Рукав',
  actualThicknessMicron: 80,
  accountingThicknessMicron: 78,
  widthMm: 1_200,
  plannedLengthM: 800,
  grossKg: 41.9,
  spoolKg: 0.7,
  plannedNetKg: 41,
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
  baseRawMaterialDefinitionId: 'material-primary',
};

function harness() {
  const trace: string[] = [];
  const commands = new Map<string, Record<string, unknown>>();
  const orders = new Map<string, Record<string, unknown>>();
  const positions = new Map<string, Record<string, unknown>>();
  const rolls = new Map<string, Record<string, unknown>>();
  const facts = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const tx = {
    warehouseReserveRollCommand: {
      findUnique: jest.fn(({ where }: { where: { operationKey: string } }) =>
        Promise.resolve(commands.get(where.operationKey) ?? null),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `command-${++sequence}`, ...data, createdAt: new Date() };
        commands.set(String(data.operationKey), row);
        return Promise.resolve(row);
      }),
    },
    commercialOrder: {
      findUnique: jest.fn(({ where }: { where: { stockBatchCode: string } }) =>
        Promise.resolve(orders.get(where.stockBatchCode) ?? null),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `order-${++sequence}`,
          orderNumber: data.orderNumber,
          title: data.title,
          requestType: data.requestType,
          counterpartyId: null,
          creatorRole: data.creatorRole,
        };
        orders.set(String(data.stockBatchCode), row);
        return Promise.resolve(row);
      }),
    },
    commercialOrderPosition: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `position-${++sequence}`, ...data };
        positions.set(String(row.id), row);
        return Promise.resolve({ id: row.id });
      }),
    },
    warehouseRoll: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        trace.push('warehouse-roll');
        const row = { id: `roll-${++sequence}`, ...data };
        rolls.set(String(row.id), row);
        return Promise.resolve({ id: row.id, rollCode: String(data.rollCode) });
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rolls.get(where.id);
          if (row) Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
    warehouseRollCoverageFact: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `fact-${++sequence}`, ...data };
        facts.set(String(row.id), row);
        return Promise.resolve({ id: row.id });
      }),
    },
    $queryRaw: jest.fn().mockImplementation(() => {
      trace.push('inventory-epoch');
      return Promise.resolve([{ id: 1 }]);
    }),
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const tokens = {
    getOrCreate: jest.fn().mockResolvedValue({
      rollCode: command.rollCode,
      token: `prt_${'a'.repeat(64)}`,
    }),
  };
  const recipes = {
    resolveSelections: jest.fn().mockResolvedValue([
      {
        baseRawMaterialDefinitionId: 'material-primary',
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        version: null,
        name: 'ПВД первичный',
        ingredients: [
          {
            rawMaterialDefinitionId: 'material-primary',
            name: 'ПВД первичный',
            shareBasisPoints: 10_000,
          },
        ],
      },
    ]),
  };
  return {
    audit,
    commands,
    orders,
    positions,
    prisma,
    recipes,
    rolls,
    facts,
    tokens,
    trace,
    service: new WarehouseReserveRollService(
      prisma as never,
      audit as never,
      tokens as never,
      recipes as never,
    ),
  };
}

describe('WarehouseReserveRollService', () => {
  it('creates one canonical platform reserve roll and replays the same operation', async () => {
    const fixture = harness();

    const first = await fixture.service.create(actor, command);
    const replay = await fixture.service.create(actor, command);

    expect(first).toEqual({
      id: expect.any(String),
      rollCode: 'RES-2026-001',
      batchCode: 'ПАРТИЯ-08-06',
      sourceOrderId: expect.any(String),
      sourceOrderNumber: expect.stringMatching(/^WR-/u),
      filmType: 'Рукав',
      actualThicknessMicron: 80,
      accountingThicknessMicron: 78,
      widthMm: 1_200,
      plannedLengthM: 800,
      grossKg: 41.9,
      spoolKg: 0.7,
      netKg: 41.2,
      plannedNetKg: 41,
      spoolType: 'Тонкая',
      birka: 'ГОСТ',
      materialLabel: 'ПВД первичный',
      source: 'platform',
      availability: 'available',
      receivedAt: expect.any(String),
      qrReady: true,
    });
    expect(replay).toEqual(first);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.warehouseRoll.create).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.commercialOrderPosition.create).toHaveBeenCalledTimes(1);
    expect(fixture.tokens.getOrCreate).toHaveBeenCalledWith('RES-2026-001', expect.any(Object));
    expect(fixture.audit.record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('prt_');
  });

  it('locks the shared coverage inventory epoch before publishing a reserve candidate', async () => {
    const fixture = harness();

    await fixture.service.create(actor, command);

    expect(fixture.trace).toEqual(['inventory-epoch', 'warehouse-roll']);
  });

  it('persists net weight as the canonical matching fact and keeps gross/tare in the safe snapshot', async () => {
    const fixture = harness();

    await fixture.service.create(actor, command);

    expect(fixture.prisma.warehouseRoll.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        positionSnapshot: {
          source: 'platform',
          grossMilliKg: 41_900,
          spoolMilliKg: 700,
          netMilliKg: 41_200,
          materialLabel: 'ПВД первичный',
        },
        warehouseStatus: 'received',
        ownerCounterpartyId: null,
      }),
      select: { id: true, rollCode: true },
    });
    expect(fixture.prisma.warehouseRollCoverageFact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'manual_platform',
        spec: expect.objectContaining({
          actualWeightMilliKg: 41_200,
          plannedWeightMilliKg: 41_000,
          ownerCounterpartyId: null,
          ingredients: [
            {
              rawMaterialDefinitionId: 'material-primary',
              shareBasisPoints: 10_000,
            },
          ],
        }),
      }),
      select: { id: true },
    });
  });

  it('rejects a reused operation key with changed facts', async () => {
    const fixture = harness();
    await fixture.service.create(actor, command);

    await expect(
      fixture.service.create(actor, { ...command, grossKg: 42.1 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.prisma.warehouseRoll.create).toHaveBeenCalledTimes(1);
  });

  it('rejects non-positive net weight without persisting a roll', async () => {
    const fixture = harness();

    await expect(
      fixture.service.create(actor, { ...command, grossKg: 0.7, spoolKg: 0.7 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.prisma.warehouseRoll.create).not.toHaveBeenCalled();
    expect(fixture.audit.record).not.toHaveBeenCalled();
  });

  it('does not attach a manual roll to an unrelated existing stock batch', async () => {
    const fixture = harness();
    fixture.orders.set(command.batchCode, {
      id: 'foreign-order',
      orderNumber: 'STOCK-42',
      title: 'Производство на запас',
      requestType: 'stock_reserve',
      counterpartyId: null,
      creatorRole: 'commercial',
    });

    await expect(fixture.service.create(actor, command)).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.prisma.warehouseRoll.create).not.toHaveBeenCalled();
  });

  it('reuses the exact platform batch independently of the delegated actor role', async () => {
    const fixture = harness();
    const first = await fixture.service.create({ ...actor, role: 'admin' }, command);

    const second = await fixture.service.create(actor, {
      ...command,
      operationKey: '018f0b6a-7094-4b54-8c88-cb44c92807ec',
      rollCode: 'RES-2026-002',
    });

    expect(second.sourceOrderId).toBe(first.sourceOrderId);
    expect(fixture.prisma.commercialOrder.create).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.warehouseRoll.create).toHaveBeenCalledTimes(2);
  });
});
