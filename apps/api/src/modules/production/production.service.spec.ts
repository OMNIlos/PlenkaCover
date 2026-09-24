import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProductionService } from './production.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { PostDeviceReadinessService } from '../../common/device-readiness/post-device-readiness.service';
import { WarehouseCoverageProductionHandoffService } from '../warehouse-coverage/warehouse-coverage-production-handoff.service';
import { WarehouseCoverageProjectionService } from '../warehouse-coverage/warehouse-coverage-projection.service';
import { WarehouseSpoolStockService } from '../warehouse/warehouse-spool-stock.service';

const fullOrder = {
  id: 'po1',
  commercialOrderId: 'co1',
  approvalState: 'pending',
  indicator: 'needs_production',
  commercialOrder: {
    id: 'co1',
    orderNumber: 'A-1024',
    counterparty: { id: 'cp1', displayName: 'УралПак', legalName: 'ООО УралПак' },
  },
  dispatchItems: [],
};

const DATABASE_WALL_CLOCK = new Date('2026-07-21T12:34:56.789Z');

function setup() {
  const operatorShiftMachineAssignment: any = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  operatorShiftMachineAssignment.findFirst.mockImplementation(async (args: any) => {
    if (args?.where?.OR) return null;
    return operatorShiftMachineAssignment.findUnique(args);
  });
  const prisma: any = {
    productionOrder: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(fullOrder),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    commercialOrder: { update: jest.fn() },
    rollDispatchItem: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ rollCode: 'roll-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorRollLine: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'line-1' }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    machineAssignment: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
    post: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    productionProblem: {
      create: jest.fn().mockResolvedValue({ id: 'pr1' }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    penalty: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    shift: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    operatorShiftMachineAssignment,
    operatorPostSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    shiftBagUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
    defectRecord: {
      create: jest.fn().mockResolvedValue({ id: 'defect-1' }),
      count: jest.fn().mockResolvedValue(0),
    },
    rawMaterialStock: {
      findUnique: jest.fn().mockResolvedValue({ materialId: 'raw-1', label: 'ПВД', actualQty: 0 }),
      upsert: jest.fn().mockResolvedValue({ actualQty: 40 }),
    },
    rawMaterialDefinition: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'definition-secondary', name: 'Вторсырьё ПВД' }),
    },
    financeOrder: { upsert: jest.fn().mockResolvedValue({ id: 'fo1', commercialOrderId: 'co1' }) },
  };
  prisma.$queryRaw = jest.fn().mockImplementation(async (query: unknown) => {
    if (query && typeof query === 'object' && 'strings' in query) {
      const sql = Array.from((query as { strings: readonly string[] }).strings).join(' ');
      if (sql.includes('clock_timestamp()')) return [{ createdAt: DATABASE_WALL_CLOCK }];
    }
    return [];
  });
  prisma.$transaction = jest.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  const audit = { record: jest.fn() };
  return { prisma, audit };
}

function currentAssignment(shiftId = 'shift-1', postId = 'post-1', postCode = 'POST-1') {
  return {
    id: `assignment-${shiftId}`,
    shiftId,
    operatorId: 'opA',
    postId,
    status: 'planned',
    createdAt: new Date('2026-07-27T09:00:00.000Z'),
    shift: { id: shiftId, status: 'planned' },
    post: { id: postId, code: postCode, name: postCode, status: 'active' },
  };
}

async function build(
  prisma: any,
  audit: any,
  v2CoverageHandoff: {
    createV2ProductionOrder: jest.Mock;
  } = {
    createV2ProductionOrder: jest.fn(),
  },
  coverageProjection = {
    read: jest.fn().mockResolvedValue({
      workflowVersion: 2,
      state: 'production_required',
      stateVersion: 3,
      generation: 2,
      availability: 'unavailable',
      reasonCodes: ['no_compatible_rolls'],
      nextOwner: 'commercial',
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T08:00:00.000Z',
      stale: false,
    }),
    readMany: jest.fn().mockResolvedValue(
      new Map([
        [
          'co1',
          {
            workflowVersion: 2,
            state: 'production_required',
            stateVersion: 3,
            generation: 2,
            availability: 'unavailable',
            reasonCodes: ['no_compatible_rolls'],
            nextOwner: 'commercial',
            availableActions: [],
            requiredRollCount: 2,
            matchedRollCount: 0,
            uncertainRollCount: 0,
            calculatedAt: '2026-07-24T08:00:00.000Z',
            stale: false,
          },
        ],
      ]),
    ),
  },
  spoolStock = {
    returnDefectSpool: jest.fn().mockResolvedValue({ id: 'spool-return-1' }),
  },
): Promise<ProductionService> {
  const mod = await Test.createTestingModule({
    providers: [
      ProductionService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      {
        provide: WarehouseCoverageProductionHandoffService,
        useValue: v2CoverageHandoff,
      },
      {
        provide: WarehouseCoverageProjectionService,
        useValue: coverageProjection,
      },
      {
        provide: PostDeviceReadinessService,
        useValue: { require: jest.fn().mockResolvedValue({ ready: true, code: 'READY' }) },
      },
      {
        provide: WarehouseSpoolStockService,
        useValue: spoolStock,
      },
    ],
  }).compile();
  return mod.get(ProductionService);
}

describe('ProductionService operator workload', () => {
  it('returns only active operator accounts', async () => {
    const { prisma, audit } = setup();
    const users = [
      {
        id: 'operator-active',
        displayName: 'Ахметов Булат',
        role: 'operator',
        isActive: true,
      },
      {
        id: 'operator-inactive',
        displayName: 'Анна Соколова',
        role: 'operator',
        isActive: false,
      },
    ];
    prisma.user.findMany.mockImplementation(
      ({ where }: { where: { role?: string; isActive?: boolean } }) =>
        Promise.resolve(
          users.filter(
            (user) =>
              (where.role === undefined || user.role === where.role) &&
              (where.isActive === undefined || user.isActive === where.isActive),
          ),
        ),
    );
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        assignedOperatorId: 'operator-active',
        status: 'assigned',
      },
      {
        assignedOperatorId: 'operator-inactive',
        status: 'in_progress',
      },
    ]);
    const service = await build(prisma, audit);

    await expect(service.operatorWorkload()).resolves.toEqual([
      {
        operatorId: 'operator-active',
        displayName: 'Ахметов Булат',
        active: 0,
        planned: 1,
        total: 1,
      },
    ]);
  });
});

describe('ProductionService weight integrity projection', () => {
  it.each([
    ['negative', -0.55],
    ['zero', 0],
    ['non-finite', Number.NaN],
  ])('quarantines a legacy %s roll weight without dropping the production order', async (_case, netKg) => {
    const { prisma, audit } = setup();
    const affectedOrder = {
      ...fullOrder,
      approvalState: 'approved',
      indicator: 'in_production',
      commercialOrder: {
        ...fullOrder.commercialOrder,
        orderNumber: 'A-16',
        warehouseCoverageWorkflowVersion: 1,
      },
      dispatchItems: [
        {
          id: 'dispatch-a-16-roll-2',
          rollCode: 'A-16-roll-2',
          productionOrderId: fullOrder.id,
          orderLineId: 'position-a-16',
          assignedOperatorId: 'operator-a',
          assignedOperator: { id: 'operator-a', displayName: 'Оператор' },
          plannedShiftId: 'shift-a',
          postId: 'post-a',
          post: { id: 'post-a', code: 'POST-1', name: 'Станок 1', status: 'active' },
          machineId: 'machine-a',
          queueRank: 1,
          plannedWeightKg: 40,
          operatorLine: {
            netKg,
            step: 'deferred',
            warehouseState: 'not_ready',
          },
        },
      ],
    };
    prisma.productionOrder.findMany
      .mockResolvedValueOnce([{ id: affectedOrder.id }])
      .mockResolvedValueOnce([affectedOrder]);
    const service = await build(prisma, audit);

    const projected = await service.listOrders('production_lead');

    expect(projected).toHaveLength(1);
    expect(projected[0].dispatchItems[0]).toMatchObject({
      rollCode: 'A-16-roll-2',
      operatorLine: {
        netKg: null,
        step: 'deferred',
        warehouseState: 'not_ready',
      },
    });
    expect(projected[0].approvalProblems).toContainEqual({
      rollId: 'A-16-roll-2',
      reasons: ['roll weight is invalid'],
    });
  });
});

describe('ProductionService active order projection', () => {
  it('excludes cancelled rolls from the active production response', async () => {
    const { prisma, audit } = setup();
    const doneRoll = {
      id: 'dispatch-a-30-done',
      rollCode: 'A-30-roll-done',
      productionOrderId: fullOrder.id,
      status: 'done',
    };
    const cancelledRoll = {
      ...doneRoll,
      id: 'dispatch-a-30-cancelled',
      rollCode: 'A-30-roll-cancelled',
      status: 'cancelled',
    };
    prisma.productionOrder.findMany
      .mockResolvedValueOnce([{ id: fullOrder.id }])
      .mockImplementationOnce(({ select }: any) =>
        Promise.resolve([
          {
            ...fullOrder,
            dispatchItems:
              select.dispatchItems.where?.status?.not === 'cancelled'
                ? [doneRoll]
                : [doneRoll, cancelledRoll],
          },
        ]),
      );
    const service = await build(prisma, audit);

    const [projected] = await service.listOrders('production_lead');

    expect(projected.dispatchItems.map(({ rollCode }) => rollCode)).toEqual(['A-30-roll-done']);
  });
});

describe('ProductionService warehouse coverage projection', () => {
  it('projects V2 production quantity and generation without warehouse roll candidates', async () => {
    const { prisma, audit } = setup();
    const secretRollCode = 'SECRET-WAREHOUSE-ROLL';
    prisma.productionOrder.findMany.mockResolvedValue([
      {
        ...fullOrder,
        sourceCoverageCalculationId: 'calculation-2',
        sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000002',
        sourceCoverageInputFingerprint: 'a'.repeat(64),
        sourceCoverageGeneration: 2,
        commercialOrder: {
          ...fullOrder.commercialOrder,
          warehouseCoverageWorkflowVersion: 2,
          clientRequestId: 'internal-client-request-id',
          requestFingerprint: 'f'.repeat(64),
          positions: [{ id: 'internal-position', recipe: { id: 'internal-recipe' } }],
        },
        dispatchItems: [
          {
            rollCode: 'A-1024-roll-1',
            orderLineId: 'position-1',
            assignedOperatorId: null,
            plannedShiftId: null,
            postId: null,
            machineId: null,
            queueRank: 1,
            operatorLine: {
              netKg: 39,
              step: 'defect',
              warehouseState: 'not_ready',
              defects: [
                {
                  weightKg: 1.25,
                  spoolStockMovement: { quantity: 1 },
                },
              ],
            },
          },
          {
            rollCode: 'A-1024-roll-2',
            orderLineId: 'position-1',
            assignedOperatorId: null,
            plannedShiftId: null,
            postId: null,
            machineId: null,
            queueRank: 2,
            operatorLine: null,
          },
        ],
      },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        productionOrderId: 'po1',
        defectRollCount: 1,
        verifiedDefectKg: 1.25,
        returnedSpoolCount: 1,
      },
    ]);
    const coverageProjection = {
      read: jest.fn(),
      readMany: jest.fn().mockResolvedValue(
        new Map([
          [
            'co1',
            {
              workflowVersion: 2,
              state: 'production_required',
              stateVersion: 3,
              generation: 2,
              availability: 'unavailable',
              reasonCodes: ['no_compatible_rolls'],
              nextOwner: 'commercial',
              availableActions: [],
              requiredRollCount: 2,
              matchedRollCount: 0,
              uncertainRollCount: 0,
              calculatedAt: '2026-07-24T08:00:00.000Z',
              stale: false,
              financeRolls: [{ rollCode: secretRollCode, positionId: 'position-1' }],
            },
          ],
        ]),
      ),
    };
    const service = await build(
      prisma,
      audit,
      { createV2ProductionOrder: jest.fn() },
      coverageProjection,
    );

    const restrictedActor = {
      userId: 'production-restricted',
      role: 'production_lead' as const,
      capabilities: ['production_order:read' as const],
    };
    const [projected] = (await service.listOrders(restrictedActor)) as any[];

    expect(coverageProjection.readMany).toHaveBeenCalledTimes(1);
    expect(coverageProjection.readMany).toHaveBeenCalledWith(['co1'], restrictedActor);
    expect(projected.coverage).toEqual(
      expect.objectContaining({ workflowVersion: 2, state: 'production_required' }),
    );
    expect(projected.productionQty).toBe(2);
    expect(projected.sourceGeneration).toBe(2);
    expect(projected.defectRollCount).toBe(1);
    expect(projected.verifiedDefectKg).toBe(1.25);
    expect(projected.returnedSpoolCount).toBe(1);
    expect(projected.dispatchItems[0].operatorLine).toEqual({
      netKg: 39,
      step: 'defect',
      warehouseState: 'not_ready',
    });
    expect(projected.dispatchItems[0].operatorLine).not.toHaveProperty('defects');
    expect(JSON.stringify(projected)).not.toContain(secretRollCode);
    expect(projected).not.toHaveProperty('sourceCoverageCalculationId');
    expect(projected).not.toHaveProperty('sourceCoverageDecisionId');
    expect(projected).not.toHaveProperty('sourceCoverageInputFingerprint');
    expect(JSON.stringify(projected)).not.toContain('internal-client-request-id');
    expect(JSON.stringify(projected)).not.toContain('internal-recipe');
  });

  it('loads all V2 coverage projections through one fenced batch', async () => {
    const { prisma, audit } = setup();
    const orders = ['co1', 'co2'].map((commercialOrderId, index) => ({
      ...fullOrder,
      id: `po${index + 1}`,
      commercialOrderId,
      sourceCoverageGeneration: 2,
      commercialOrder: {
        ...fullOrder.commercialOrder,
        id: commercialOrderId,
        warehouseCoverageWorkflowVersion: 2,
      },
    }));
    prisma.productionOrder.findMany
      .mockResolvedValueOnce(orders.map(({ id }) => ({ id })))
      .mockResolvedValueOnce(orders);
    const coverageProjection = {
      read: jest.fn(),
      readMany: jest.fn().mockResolvedValue(
        new Map(
          orders.map(({ commercialOrderId }) => [
            commercialOrderId,
            {
              workflowVersion: 2,
              state: 'production_required',
              stateVersion: 3,
              generation: 2,
              availability: 'unavailable',
              reasonCodes: ['no_compatible_rolls'],
              nextOwner: 'commercial',
              availableActions: [],
              requiredRollCount: 1,
              matchedRollCount: 0,
              uncertainRollCount: 0,
              calculatedAt: '2026-07-24T08:00:00.000Z',
              stale: false,
            },
          ]),
        ),
      ),
    };
    const service = await build(
      prisma,
      audit,
      { createV2ProductionOrder: jest.fn() },
      coverageProjection,
    );

    await expect(service.listOrders('production_lead')).resolves.toHaveLength(2);
    expect(coverageProjection.readMany).toHaveBeenCalledTimes(1);
    expect(coverageProjection.readMany).toHaveBeenCalledWith(
      ['co1', 'co2'],
      expect.objectContaining({ role: 'production_lead' }),
    );
    expect(coverageProjection.read).not.toHaveBeenCalled();
  });

  it('fails before the eager projection when nested production facts exceed the response cap', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findMany.mockResolvedValueOnce([{ id: 'po-oversized' }]);
    prisma.rollDispatchItem.count.mockResolvedValueOnce(20_001);
    const service = await build(prisma, audit);

    await expect(service.listOrders('production_lead')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_ORDER_RESPONSE_TOO_LARGE' }),
    });

    expect(prisma.rollDispatchItem.count).toHaveBeenCalledWith({
      where: {
        productionOrderId: { in: ['po-oversized'] },
        status: { not: 'cancelled' },
      },
    });
    expect(prisma.productionOrder.findMany).toHaveBeenCalledTimes(1);
  });

  it('allows a production response above the legacy 2,000-fact cap', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findMany
      .mockResolvedValueOnce([{ id: 'po-large' }])
      .mockResolvedValueOnce([]);
    prisma.rollDispatchItem.count.mockResolvedValueOnce(2_001);
    const service = await build(prisma, audit);

    await expect(service.listOrders('production_lead')).resolves.toEqual([]);
  });
});

function lockedTableNames(queryRaw: jest.Mock): string[] {
  return queryRaw.mock.calls.flatMap(([query]: [unknown]) => {
    if (!query || typeof query !== 'object' || !('strings' in query)) return [];
    const sql = Array.from((query as { strings: readonly string[] }).strings).join(' ');
    const table = /FROM\s+"([^"]+)"/u.exec(sql)?.[1];
    return table ? [table] : [];
  });
}

async function replacementConcurrencyHarness(orderIds: readonly [string, string]) {
  const sourceCodes = ['source-a', 'source-b'] as const;
  const sources = new Map<string, Record<string, unknown>>(
    sourceCodes.map((rollCode, index) => [
      rollCode,
      {
        id: `dispatch-${rollCode}`,
        rollCode,
        productionOrderId: orderIds[index],
        orderLineId: `position-${index + 1}`,
        positionSequence: 1,
        rawMaterialId: 'raw-1',
        recipeVersion: 'v1',
        filmType: 'PE',
        plannedWeightKg: 40,
        plannedLengthM: 500,
        characteristicsSnapshot: { widthMm: 1200 },
        productionOrder: { approvalState: 'approved' },
      },
    ]),
  );
  const createdByCode = new Map<string, Record<string, unknown>>();
  const orderByDispatchId = new Map<string, string>();
  const sequencesByOrder = new Map<string, number[]>();
  for (const orderId of orderIds) {
    if (!sequencesByOrder.has(orderId)) sequencesByOrder.set(orderId, [1]);
  }

  let createdCount = 0;
  let globalQueueRank = 99;
  let activeLocks = 0;
  let maxActiveLocks = 0;
  const lockedOrderIds: string[] = [];
  const lockTails = new Map<string, Promise<void>>();
  const acquire = async (orderId: string) => {
    const previous = lockTails.get(orderId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    lockTails.set(
      orderId,
      previous.then(() => held),
    );
    await previous;
    activeLocks += 1;
    maxActiveLocks = Math.max(maxActiveLocks, activeLocks);
    lockedOrderIds.push(orderId);
    return () => {
      activeLocks -= 1;
      release();
    };
  };

  let unlockedCountCalls = 0;
  let releaseUnlockedCounts!: () => void;
  const unlockedCountBarrier = new Promise<void>((resolve) => {
    releaseUnlockedCounts = resolve;
  });
  const makeClient = (heldOrders: Set<string>, releases: Array<() => void>) => ({
    $queryRaw: jest.fn(async (query: unknown) => {
      const values = (query as { values?: readonly unknown[] }).values ?? [];
      const orderId = String(values[0]);
      const release = await acquire(orderId);
      heldOrders.add(orderId);
      releases.push(() => {
        heldOrders.delete(orderId);
        release();
      });
      return [{ id: orderId }];
    }),
    productionOrder: { update: jest.fn().mockResolvedValue({}) },
    rollDispatchItem: {
      findUnique: jest.fn(async ({ where: { rollCode } }: { where: { rollCode: string } }) =>
        Promise.resolve(sources.get(rollCode) ?? createdByCode.get(rollCode) ?? null),
      ),
      aggregate: jest.fn(async () => ({ _max: { queueRank: globalQueueRank } })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdCount += 1;
        globalQueueRank = Math.max(globalQueueRank, Number(data.queueRank));
        const row = { id: `replacement-${createdCount}`, ...data };
        createdByCode.set(String(data.rollCode), row);
        orderByDispatchId.set(row.id, String(data.productionOrderId));
        return row;
      }),
    },
    operatorRollLine: {
      count: jest.fn(
        async ({ where }: { where: { rollDispatchItem: { productionOrderId: string } } }) => {
          const orderId = where.rollDispatchItem.productionOrderId;
          const count = sequencesByOrder.get(orderId)?.length ?? 0;
          if (!heldOrders.has(orderId)) {
            unlockedCountCalls += 1;
            if (unlockedCountCalls === 2) releaseUnlockedCounts();
            await unlockedCountBarrier;
          }
          return count;
        },
      ),
      create: jest.fn(
        async ({ data }: { data: { rollDispatchItemId: string; sequence: number } }) => {
          const orderId = orderByDispatchId.get(data.rollDispatchItemId)!;
          sequencesByOrder.get(orderId)!.push(data.sequence);
          return { id: `line-${data.rollDispatchItemId}`, ...data };
        },
      ),
    },
    domainEvent: { create: jest.fn() },
  });

  const rootClient = makeClient(new Set(), []);
  const prisma: any = {
    ...rootClient,
    $transaction: jest.fn(
      async (callback: (client: ReturnType<typeof makeClient>) => unknown, _options: unknown) => {
        const releases: Array<() => void> = [];
        const tx = makeClient(new Set(), releases);
        try {
          return await callback(tx);
        } finally {
          releases.reverse().forEach((release) => release());
        }
      },
    ),
  };
  const audit = { record: jest.fn() };
  const service = await build(prisma, audit);

  return {
    service,
    prisma,
    lockedOrderIds,
    maxActiveLocks: () => maxActiveLocks,
    sequences: (orderId: string) => [...(sequencesByOrder.get(orderId) ?? [])],
  };
}

describe('ProductionService', () => {
  it.each([
    [{ status: 'pendng' }, 'status'],
    [{ type: 'unknown' }, 'type'],
  ])('rejects an unsupported production problem %s before querying', async (query, _field) => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(service.listProblems(query as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.productionProblem.findMany).not.toHaveBeenCalled();
  });

  it('fails closed instead of truncating an oversized production problem queue', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({ id: `problem-${index}` })),
    );
    const service = await build(prisma, audit);

    await expect(service.listProblems({ status: 'open' })).rejects.toMatchObject({
      response: { code: 'PRODUCTION_PROBLEM_CATALOG_TOO_LARGE' },
    });
    expect(prisma.productionProblem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'open' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 101,
      }),
    );
  });

  it('rejects an unsupported order bucket before querying production orders', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.listOrders(
        {
          userId: 'lead-1',
          role: 'production_lead',
          capabilities: ['production_order:read'],
        },
        'everything',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.productionOrder.findMany).not.toHaveBeenCalled();
  });

  it('fails closed instead of truncating an oversized production order catalog', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findMany.mockResolvedValue(
      Array.from({ length: 2001 }, (_, index) => ({ id: `po-${index}` })),
    );
    const service = await build(prisma, audit);

    await expect(
      service.listOrders({
        userId: 'lead-1',
        role: 'production_lead',
        capabilities: ['production_order:read'],
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'PRODUCTION_ORDER_CATALOG_TOO_LARGE',
      },
    });
    expect(prisma.productionOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2001,
      }),
    );
  });

  it('lists operator penalties and penalties addressed to the production lead', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await service.listOperatorPenalties({ userId: 'lead-current', role: 'production_lead' });

    expect(prisma.penalty.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { targetRole: 'operator' },
          { targetRole: 'production_lead', employeeId: 'lead-current' },
        ],
      },
      include: { employee: { select: { id: true, displayName: true, isActive: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('fails closed when the production penalty projection has no authenticated user', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    expect(() => service.listOperatorPenalties({ userId: null, role: 'production_lead' })).toThrow(
      UnauthorizedException,
    );
    expect(prisma.penalty.findMany).not.toHaveBeenCalled();
  });

  it('creates an audited whole-order penalty from a published order assigned to the operator', async () => {
    const { prisma, audit } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'operator-2',
      displayName: 'Илья Ковалёв',
      role: 'operator',
      isActive: true,
    });
    prisma.penalty.create.mockResolvedValue({
      id: 'pen-2',
      employeeId: 'operator-2',
      targetRole: 'operator',
      amount: 1500,
      reason: 'Нарушение регламента',
      employee: { id: 'operator-2', displayName: 'Илья Ковалёв' },
    });
    prisma.productionOrder.findUnique.mockResolvedValue({
      id: 'po-501',
      approvalState: 'approved',
      commercialOrder: { orderNumber: 'A-501' },
      dispatchItems: [{ rollCode: 'A-501-roll-2', assignedOperatorId: 'operator-2' }],
    });
    const service = await build(prisma, audit);
    const dto = {
      operatorId: 'operator-2',
      productionOrderId: 'po-501',
      amount: 1500,
      reason: 'Нарушение регламента',
    };
    const penalty = await service.createOperatorPenalty(
      { userId: 'lead-1', role: 'production_lead' },
      dto,
    );
    expect(penalty.id).toBe('pen-2');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.penalty.create).toHaveBeenCalledTimes(1);
    expect(prisma.penalty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          employeeId: 'operator-2',
          targetRole: 'operator',
          authorRole: 'production_lead',
          sourceObjectId: 'po-501',
          sourceProductionOrderId: 'po-501',
          sourceOrderNumber: 'A-501',
          sourceRollCode: null,
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:penalty_created',
        objectId: 'pen-2',
        detail: expect.objectContaining({
          productionOrderId: 'po-501',
          orderNumber: 'A-501',
          rollCode: null,
        }),
      }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record.mock.calls.map(([event]: [{ type: string }]) => event.type)).toEqual([
      'audit:penalty_created',
      'notification:penalty_created',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:penalty_created',
        objectId: 'pen-2',
        detail: expect.objectContaining({
          employeeId: 'operator-2',
          employeeName: 'Илья Ковалёв',
          amount: 1500,
          reason: 'Нарушение регламента',
          sourceObjectId: 'po-501',
          productionOrderId: 'po-501',
          orderNumber: 'A-501',
          rollCode: null,
        }),
      }),
      prisma,
    );
  });

  it.each([1, 2])(
    'rolls back the production penalty when required event %i fails',
    async (eventNumber) => {
      const { prisma, audit } = setup();
      prisma.user.findUnique.mockResolvedValue({
        id: 'operator-2',
        displayName: 'Илья Ковалёв',
        role: 'operator',
        isActive: true,
      });
      prisma.productionOrder.findUnique.mockResolvedValue({
        id: 'po-501',
        approvalState: 'approved',
        commercialOrder: { orderNumber: 'A-501' },
        dispatchItems: [{ rollCode: 'A-501-roll-2', assignedOperatorId: 'operator-2' }],
      });
      let committed = { penalties: [] as Array<{ id: string }>, events: [] as string[] };
      prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
        const staged = {
          penalties: [...committed.penalties],
          events: [...committed.events],
        };
        let currentEvent = 0;
        const tx = {
          penalty: {
            create: jest.fn(async () => {
              const penalty = { id: 'penalty-atomic-1' };
              staged.penalties.push(penalty);
              return penalty;
            }),
          },
        };
        audit.record.mockImplementation(async (input: { type: string }, client: unknown) => {
          expect(client).toBe(tx);
          currentEvent += 1;
          if (currentEvent === eventNumber) throw new Error(`event ${currentEvent} failed`);
          staged.events.push(input.type);
        });
        const result = await callback(tx);
        committed = staged;
        return result;
      });
      const service = await build(prisma, audit);

      await expect(
        service.createOperatorPenalty(
          { userId: 'lead-1', role: 'production_lead' },
          {
            operatorId: 'operator-2',
            productionOrderId: 'po-501',
            amount: 1500,
            reason: 'atomic penalty',
          },
        ),
      ).rejects.toThrow(`event ${eventNumber} failed`);

      expect(committed).toEqual({ penalties: [], events: [] });
      expect(audit.record).toHaveBeenCalledTimes(eventNumber);
    },
  );

  it('stores a concrete roll only when it belongs to the selected order and operator', async () => {
    const { prisma, audit } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'operator-2',
      displayName: 'Илья Ковалёв',
      role: 'operator',
      isActive: true,
    });
    prisma.productionOrder.findUnique.mockResolvedValue({
      id: 'po-501',
      approvalState: 'approved',
      commercialOrder: { orderNumber: 'A-501' },
      dispatchItems: [{ rollCode: 'A-501-roll-2', assignedOperatorId: 'operator-2' }],
    });
    prisma.penalty.create.mockResolvedValue({ id: 'pen-roll-2' });
    const service = await build(prisma, audit);
    const dto = {
      operatorId: 'operator-2',
      productionOrderId: 'po-501',
      rollCode: 'A-501-roll-2',
      amount: 900,
      reason: 'Недовес рулона',
    };

    await service.createOperatorPenalty({ userId: 'lead-1', role: 'production_lead' }, dto);

    expect(prisma.penalty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceObjectId: 'A-501-roll-2',
          sourceProductionOrderId: 'po-501',
          sourceOrderNumber: 'A-501',
          sourceRollCode: 'A-501-roll-2',
        }),
      }),
    );
  });

  it('rejects a penalty linked to an order that is not published', async () => {
    const { prisma, audit } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'operator-2',
      displayName: 'Илья Ковалёв',
      role: 'operator',
      isActive: true,
    });
    prisma.productionOrder.findUnique.mockResolvedValue({
      id: 'po-501',
      approvalState: 'pending',
      commercialOrder: { orderNumber: 'A-501' },
      dispatchItems: [{ rollCode: 'A-501-roll-2', assignedOperatorId: 'operator-2' }],
    });
    const service = await build(prisma, audit);
    const dto = {
      operatorId: 'operator-2',
      productionOrderId: 'po-501',
      amount: 500,
      reason: 'Не должен сохраниться',
    };

    await expect(
      service.createOperatorPenalty({ userId: 'lead-1', role: 'production_lead' }, dto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.penalty.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only production penalty reason before the transaction', async () => {
    const { prisma, audit } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'operator-2',
      displayName: 'Илья Ковалёв',
      role: 'operator',
      isActive: true,
    });
    prisma.productionOrder.findUnique.mockResolvedValue({
      id: 'po-501',
      approvalState: 'approved',
      commercialOrder: { orderNumber: 'A-501' },
      dispatchItems: [{ rollCode: 'A-501-roll-2', assignedOperatorId: 'operator-2' }],
    });
    const service = await build(prisma, audit);

    await expect(
      service.createOperatorPenalty(
        { userId: 'lead-1', role: 'production_lead' },
        {
          operatorId: 'operator-2',
          productionOrderId: 'po-501',
          amount: 500,
          reason: '   ',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an order or roll that was not assigned to the selected operator', async () => {
    const { prisma, audit } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'operator-2',
      displayName: 'Илья Ковалёв',
      role: 'operator',
      isActive: true,
    });
    prisma.productionOrder.findUnique.mockResolvedValue({
      id: 'po-501',
      approvalState: 'approved',
      commercialOrder: { orderNumber: 'A-501' },
      dispatchItems: [
        { rollCode: 'A-501-roll-2', assignedOperatorId: 'operator-2' },
        { rollCode: 'A-501-roll-1', assignedOperatorId: 'operator-1' },
      ],
    });
    const service = await build(prisma, audit);
    const dto = {
      operatorId: 'operator-2',
      productionOrderId: 'po-501',
      rollCode: 'A-501-roll-1',
      amount: 500,
      reason: 'Чужая работа',
    };

    await expect(
      service.createOperatorPenalty({ userId: 'lead-1', role: 'production_lead' }, dto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.penalty.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a penalty addressed to a non-operator account', async () => {
    const { prisma, audit } = setup();
    prisma.user.findUnique.mockResolvedValue({
      id: 'warehouse-1',
      role: 'warehouse',
      isActive: true,
    });
    const service = await build(prisma, audit);
    const dto = {
      operatorId: 'warehouse-1',
      productionOrderId: 'po-501',
      amount: 500,
      reason: 'wrong target',
    };
    await expect(
      service.createOperatorPenalty({ userId: 'lead-1', role: 'production_lead' }, dto),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.penalty.create).not.toHaveBeenCalled();
  });

  it('publishes 700 rolls without reading or locking the shared assignment per roll', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findUnique.mockResolvedValue({
      ...fullOrder,
      dispatchItems: Array.from({ length: 700 }, (_, index) => ({
        id: `r${index}`,
        rollCode: `roll-${index}`,
        assignedOperatorId: 'opA',
        plannedShiftId: 'shift-1',
        postId: 'post-1',
        machineId: 'POST-1',
        queueRank: index + 1,
        plannedWeightKg: 40,
        status: 'new',
      })),
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue(currentAssignment());
    const service = await build(prisma, audit);
    await service.approve({ userId: 'u1', role: 'production_lead' }, 'po1');
    expect(prisma.operatorShiftMachineAssignment.findUnique.mock.calls.length).toBeLessThan(10);
    expect(prisma.$queryRaw.mock.calls.length).toBeLessThan(10);
    expect(prisma.operatorRollLine.createMany.mock.calls[0][0].data).toHaveLength(700);
    expect(audit.record.mock.calls).toHaveLength(701);
  });

  it('approve publishes a complete roll plan and creates operator lines', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findUnique.mockResolvedValue({
      ...fullOrder,
      dispatchItems: [
        {
          id: 'r1',
          rollCode: 'roll-1',
          assignedOperatorId: 'opA',
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          machineId: 'POST-1',
          queueRank: 8,
          plannedWeightKg: 41.2,
          status: 'new',
        },
        {
          id: 'r2',
          rollCode: 'roll-2',
          assignedOperatorId: 'opA',
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          machineId: 'POST-1',
          queueRank: 9,
          plannedWeightKg: 40,
          status: 'new',
        },
      ],
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    const service = await build(prisma, audit);
    await service.approve({ userId: 'u1', role: 'production_lead' }, 'po1');
    expect(prisma.productionOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'po1', approvalState: 'pending' },
        data: expect.objectContaining({ approvalState: 'approved', indicator: 'in_production' }),
      }),
    );
    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'co1' },
        data: { productionIndicator: 'in_production' },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:production_order_approved',
        detail: { commercialOrderId: 'co1', productionOrderId: 'po1' },
      }),
      prisma,
    );
    expect(
      audit.record.mock.calls
        .map(([event]: [{ type: string }]) => event)
        .filter((event: { type: string }) => event.type === 'audit:task_assigned'),
    ).toEqual([
      expect.objectContaining({
        objectId: 'roll-1',
        detail: {
          commercialOrderId: 'co1',
          operatorId: 'opA',
          rollId: 'roll-1',
          productionOrderId: 'po1',
        },
      }),
      expect.objectContaining({
        objectId: 'roll-2',
        detail: {
          commercialOrderId: 'co1',
          operatorId: 'opA',
          rollId: 'roll-2',
          productionOrderId: 'po1',
        },
      }),
    ]);
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productionOrderId: 'po1', status: 'new' },
        data: { status: 'assigned' },
      }),
    );
    expect(prisma.operatorRollLine.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ rollDispatchItemId: 'r1', sequence: 1 }),
          expect.objectContaining({ rollDispatchItemId: 'r2', sequence: 2 }),
        ],
      }),
    );
  });

  it('approve deterministically sequences equal queue ranks by createdAt and id', async () => {
    const { prisma, audit } = setup();
    const stableOrderBy = [{ queueRank: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];
    const roll = (id: string, createdAt: string) => ({
      id,
      rollCode: id,
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
      postId: 'post-1',
      machineId: 'POST-1',
      queueRank: 8,
      createdAt: new Date(createdAt),
      plannedWeightKg: 40,
      status: 'new',
    });
    const sortedRolls = [
      roll('roll-a', '2026-07-22T08:00:00.000Z'),
      roll('roll-b', '2026-07-22T08:00:00.000Z'),
      roll('roll-z', '2026-07-22T09:00:00.000Z'),
    ];
    const unstableRolls = [sortedRolls[2], sortedRolls[1], sortedRolls[0]];
    prisma.productionOrder.findUnique.mockImplementation(
      (args: { include?: { dispatchItems: { orderBy: unknown } } }) => {
        if (!args.include) {
          return Promise.resolve({ ...fullOrder, dispatchItems: sortedRolls });
        }
        const isStable =
          JSON.stringify(args.include.dispatchItems.orderBy) === JSON.stringify(stableOrderBy);
        return Promise.resolve({
          ...fullOrder,
          dispatchItems: isStable ? sortedRolls : unstableRolls,
        });
      },
    );
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    const service = await build(prisma, audit);

    await service.approve({ userId: 'u1', role: 'production_lead' }, 'po1');

    for (const callNumber of [1, 2, 3]) {
      expect(prisma.productionOrder.findUnique).toHaveBeenNthCalledWith(callNumber, {
        where: { id: 'po1' },
        include: { dispatchItems: { orderBy: stableOrderBy } },
      });
    }
    expect(prisma.operatorRollLine.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ rollDispatchItemId: 'roll-a', sequence: 1 }),
        expect.objectContaining({ rollDispatchItemId: 'roll-b', sequence: 2 }),
        expect.objectContaining({ rollDispatchItemId: 'roll-z', sequence: 3 }),
      ],
      skipDuplicates: true,
    });
  });

  it('approve returns an already approved order without creating lines or another event', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findUnique.mockResolvedValue({
      ...fullOrder,
      approvalState: 'approved',
      indicator: 'in_production',
    });
    const service = await build(prisma, audit);

    await expect(
      service.approve({ userId: 'u1', role: 'production_lead' }, 'po1'),
    ).resolves.toBeDefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.operatorRollLine.createMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('approve does not create finance order; commercial invoice-handoff is the finance gate', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findUnique.mockResolvedValue({
      ...fullOrder,
      dispatchItems: [
        {
          id: 'r1',
          rollCode: 'roll-1',
          assignedOperatorId: 'opA',
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          machineId: 'POST-1',
          queueRank: 1,
          plannedWeightKg: 40,
          status: 'new',
        },
      ],
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    const service = await build(prisma, audit);
    await service.approve({ userId: 'u1', role: 'production_lead' }, 'po1');
    expect(prisma.financeOrder.upsert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:finance_order_created' }),
    );
  });

  it('approve rejects an incomplete roll plan with structured problems', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findUnique.mockResolvedValue({
      ...fullOrder,
      dispatchItems: [
        {
          id: 'r1',
          rollCode: 'roll-1',
          assignedOperatorId: null,
          plannedShiftId: null,
          postId: null,
          machineId: null,
          queueRank: 1,
          plannedWeightKg: null,
          status: 'new',
        },
      ],
    });
    const service = await build(prisma, audit);

    await expect(
      service.approve({ userId: 'u1', role: 'production_lead' }, 'po1'),
    ).rejects.toMatchObject({
      response: {
        approvalProblems: [
          expect.objectContaining({
            reasons: expect.arrayContaining(['planned weight is not assigned']),
          }),
        ],
      },
    });
    expect(prisma.productionOrder.update).not.toHaveBeenCalled();
    expect(prisma.operatorRollLine.createMany).not.toHaveBeenCalled();
  });

  it('does not partially publish an assigned roll without a positive planned weight', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findUnique.mockResolvedValue({ commercialOrderId: 'co1' });
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'roll-without-plan',
        rollCode: 'A-1024-roll-without-plan',
        productionOrderId: 'po1',
        plannedWeightKg: null,
        assignedOperatorId: 'operator-1',
        plannedShiftId: 'shift-1',
        postId: 'post-1',
        machineId: 'POST-1',
        workplaceId: 'post-1',
        queueRank: 1,
        status: 'new',
      },
    ]);
    const service = await build(prisma, audit);
    jest.spyOn(service, 'approve').mockRejectedValue(
      new ConflictException({
        message: 'Production order plan is incomplete',
        problems: [
          { rollId: 'A-1024-roll-without-plan', reasons: ['planned weight is not assigned'] },
        ],
      }),
    );

    await expect(
      service.publishProductionOrderWhenReady(
        { userId: 'production-lead', role: 'production_lead' },
        'po1',
      ),
    ).resolves.toBeUndefined();

    expect(prisma.operatorShiftMachineAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorRollLine.createMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('approve revalidates assignment lifecycle in the transaction before any write or audit', async () => {
    const { prisma, audit } = setup();
    const order = {
      ...fullOrder,
      dispatchItems: [
        {
          id: 'r1',
          rollCode: 'roll-1',
          assignedOperatorId: 'opA',
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          machineId: 'POST-1',
          queueRank: 1,
          plannedWeightKg: 41.2,
          status: 'new',
        },
      ],
    };
    prisma.productionOrder.findUnique.mockResolvedValue(order);
    prisma.operatorShiftMachineAssignment.findUnique
      .mockResolvedValueOnce({
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'planned',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'planned' },
      })
      .mockResolvedValueOnce({
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'planned',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'planned' },
      })
      .mockResolvedValueOnce({
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'completed',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'closed' },
      });
    const service = await build(prisma, audit);

    await expect(
      service.approve({ userId: 'u1', role: 'production_lead' }, 'po1'),
    ).rejects.toMatchObject({
      response: { code: 'PRODUCTION_ASSIGNMENT_LIFECYCLE_CONFLICT' },
    });

    expect(prisma.productionOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorRollLine.createMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(lockedTableNames(prisma.$queryRaw)).toEqual([
      'posts',
      'shifts',
      'operator_shift_machine_assignments',
      'production_orders',
      'roll_dispatch_items',
    ]);
  });

  it('reportProblem creates a problem and audits problem + notification', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.reportProblem({ userId: 'u1', role: 'production_lead' }, 'po1', {
      reason: 'film tore',
    });
    expect(prisma.productionProblem.create).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'problem:production_reported_to_commercial',
        reason: 'film tore',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notification:commercial_problem_received' }),
    );
  });

  it('projects safe production details and backend approval problems', async () => {
    const { prisma, audit } = setup();
    prisma.productionOrder.findUnique.mockResolvedValue({
      ...fullOrder,
      dispatchItems: [],
    });
    const service = await build(prisma, audit);

    const result = await service.getOrder('production_lead', 'po1');

    expect(result.commercialOrder.counterparty?.legalName).toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        canApprove: false,
        approvalProblems: [{ rollId: 'po1', reasons: ['order has no rolls'] }],
      }),
    );
  });

  it('uses completedAt for archive date filtering and canonical queue order', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await service.listDispatch({
      scope: 'archive',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-10',
    });

    expect(prisma.rollDispatchItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'done',
          completedAt: {
            gte: new Date('2026-06-30T21:00:00.000Z'),
            lt: new Date('2026-07-10T21:00:00.000Z'),
          },
        }),
        orderBy: [{ queueRank: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 2_001,
      }),
    );
  });

  it('rejects an impossible Moscow archive date before querying dispatch', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    expect(() => service.listDispatch({ scope: 'archive', dateFrom: '2026-02-30' })).toThrow(
      'Invalid dispatch date',
    );
    expect(prisma.rollDispatchItem.findMany).not.toHaveBeenCalled();
  });

  it('fails closed instead of returning a truncated dispatch page', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue(
      Array.from({ length: 2_001 }, (_, index) => ({ id: `dispatch-${index}` })),
    );
    const service = await build(prisma, audit);

    await expect(
      service.listDispatch({ scope: 'archive', date: '2026-07-10' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_DISPATCH_RESULT_TOO_LARGE' }),
    });
  });

  it('summarizes known plan values separately from missing source values', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        productionOrderId: 'po1',
        assignedOperatorId: 'op1',
        postId: 'post1',
        plannedShiftId: 'shift1',
        plannedWeightKg: 40,
        plannedLengthM: 500,
        status: 'assigned',
      },
      {
        productionOrderId: 'po2',
        assignedOperatorId: null,
        postId: null,
        plannedShiftId: null,
        plannedWeightKg: null,
        plannedLengthM: null,
        status: 'new',
      },
    ]);
    prisma.productionProblem.count.mockResolvedValue(1);
    const service = await build(prisma, audit);

    await expect(service.getSummary()).resolves.toEqual({
      orders: 2,
      rolls: 2,
      problems: 1,
      operators: 1,
      unassignedRolls: 1,
      plannedWeightKg: 40,
      plannedLengthM: 500,
      missingWeightRolls: 1,
      missingLengthRolls: 1,
    });
  });

  it('records unassigned replacement creation without claiming an operator assignment', async () => {
    const { prisma, audit } = setup();
    const source = {
      id: 'source-dispatch',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      orderLineId: 'position-1',
      positionSequence: 1,
      rawMaterialId: 'raw-1',
      recipeVersion: 2,
      filmType: 'PE',
      plannedWeightKg: 40,
      plannedLengthM: 500,
      characteristicsSnapshot: { widthMm: 1200 },
      productionOrder: { approvalState: 'pending' },
    };
    prisma.rollDispatchItem.findUnique
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(null);
    prisma.rollDispatchItem.aggregate = jest.fn().mockResolvedValue({ _max: { queueRank: 7 } });
    prisma.rollDispatchItem.create = jest.fn().mockResolvedValue({
      id: 'replacement-dispatch',
      rollCode: 'roll-1-R1',
    });
    const service = await build(prisma, audit);

    await service.createReplacementRoll(
      { userId: 'lead-1', role: 'production_lead' },
      'roll-1',
      'Rework after defect',
    );

    const replacementData = prisma.rollDispatchItem.create.mock.calls[0][0].data;
    expect(replacementData).toEqual(
      expect.objectContaining({
        rollCode: 'roll-1-R1',
        productionOrderId: 'po1',
        status: 'new',
      }),
    );
    expect(replacementData).not.toHaveProperty('assignedOperatorId');
    expect(audit.record).toHaveBeenCalledWith(
      {
        type: 'audit:replacement_roll_created',
        actorRole: 'production_lead',
        actorId: 'lead-1',
        objectId: 'roll-1-R1',
        reason: 'Rework after defect',
        detail: {
          rollId: 'roll-1-R1',
          sourceRollCode: 'roll-1',
          productionOrderId: 'po1',
        },
      },
      prisma,
    );
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:roll_dispatch_assigned' }),
    );
  });

  it('reuses the immutable automatic replacement instead of creating a second attempt', async () => {
    const { prisma, audit } = setup();
    const replacement = {
      id: 'replacement-dispatch',
      rollCode: 'roll-1-R1',
      productionOrderId: 'po1',
      replacesDispatchItemId: 'source-dispatch',
      status: 'assigned',
    };
    prisma.rollDispatchItem.findUnique
      .mockResolvedValueOnce({ productionOrderId: 'po1' })
      .mockResolvedValueOnce({
        id: 'source-dispatch',
        rollCode: 'roll-1',
        productionOrderId: 'po1',
        productionOrder: { approvalState: 'approved' },
        replacementAttempt: replacement,
      });
    prisma.rollDispatchItem.create = jest.fn();
    prisma.operatorRollLine.create = jest.fn();
    const service = await build(prisma, audit);

    await expect(
      service.createReplacementRoll(
        { userId: 'lead-1', role: 'production_lead' },
        'roll-1',
        'Rework after operator defect',
      ),
    ).resolves.toEqual(replacement);

    expect(prisma.rollDispatchItem.create).not.toHaveBeenCalled();
    expect(prisma.operatorRollLine.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('numbers an approved replacement after existing local order lines, not global rank', async () => {
    const { prisma, audit } = setup();
    const source = {
      id: 'source-dispatch',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      orderLineId: 'position-1',
      positionSequence: 1,
      rawMaterialId: 'raw-1',
      recipeVersion: 2,
      filmType: 'PE',
      plannedWeightKg: 40,
      plannedLengthM: 500,
      characteristicsSnapshot: { widthMm: 1200 },
      productionOrder: { approvalState: 'approved' },
    };
    prisma.rollDispatchItem.findUnique
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(null);
    prisma.rollDispatchItem.aggregate = jest.fn().mockResolvedValue({ _max: { queueRank: 99 } });
    prisma.rollDispatchItem.create = jest.fn().mockResolvedValue({
      id: 'replacement-dispatch',
      rollCode: 'roll-1-R1',
      queueRank: 100,
    });
    prisma.operatorRollLine.count.mockResolvedValue(1);
    const service = await build(prisma, audit);

    await service.createReplacementRoll(
      { userId: 'lead-1', role: 'production_lead' },
      'roll-1',
      'Rework after defect',
    );

    expect(prisma.operatorRollLine.count).toHaveBeenCalledWith({
      where: { rollDispatchItem: { productionOrderId: 'po1' } },
    });
    expect(prisma.operatorRollLine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rollDispatchItemId: 'replacement-dispatch',
        sequence: 2,
      }),
    });
  });

  it('serializes concurrent same-order replacements into distinct local sequences', async () => {
    const { service, prisma, lockedOrderIds, sequences } = await replacementConcurrencyHarness([
      'po-a',
      'po-a',
    ]);

    await Promise.all([
      service.createReplacementRoll(
        { userId: 'lead-1', role: 'production_lead' },
        'source-a',
        'Concurrent rework A',
      ),
      service.createReplacementRoll(
        { userId: 'lead-1', role: 'production_lead' },
        'source-b',
        'Concurrent rework B',
      ),
    ]);

    expect(sequences('po-a')).toEqual([1, 2, 3]);
    expect(lockedOrderIds).toEqual(['po-a', 'po-a']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ]);
  });

  it('allows concurrent replacements for different production orders to use independent locks', async () => {
    const { service, lockedOrderIds, maxActiveLocks, sequences } =
      await replacementConcurrencyHarness(['po-a', 'po-b']);

    await Promise.all([
      service.createReplacementRoll(
        { userId: 'lead-1', role: 'production_lead' },
        'source-a',
        'Concurrent rework A',
      ),
      service.createReplacementRoll(
        { userId: 'lead-1', role: 'production_lead' },
        'source-b',
        'Concurrent rework B',
      ),
    ]);

    expect(sequences('po-a')).toEqual([1, 2]);
    expect(sequences('po-b')).toEqual([1, 2]);
    expect(new Set(lockedOrderIds)).toEqual(new Set(['po-a', 'po-b']));
    expect(maxActiveLocks()).toBe(2);
  });

  it('stores the operator before a shift exists without inventing topology', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      assignedOperatorId: null,
      plannedShiftId: null,
      postId: null,
      machineId: null,
      workplaceId: null,
      status: 'new',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([]);
    const service = await build(prisma, audit);

    await service.assignRoll({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      operatorId: 'opA',
    });

    const operatorLock = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(operatorLock.strings.join('?')).toContain('FOR NO KEY UPDATE');
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedOperatorId: 'opA',
          plannedShiftId: null,
          postId: null,
          machineId: null,
          workplaceId: null,
        }),
      }),
    );
  });

  it('uses the operator current shift and post without accepting browser topology', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      assignedOperatorId: null,
      plannedShiftId: null,
      postId: null,
      machineId: null,
      workplaceId: null,
      status: 'new',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      currentAssignment('shift-1', 'post-1', 'POST-1'),
    ]);
    const service = await build(prisma, audit);

    await service.assignRoll({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      operatorId: 'opA',
    });

    expect(prisma.operatorShiftMachineAssignment.findMany).toHaveBeenCalledWith({
      where: {
        operatorId: 'opA',
        status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
        shift: { status: { in: ['planned', 'open'] } },
      },
      include: {
        shift: { select: { id: true, status: true } },
        post: { select: { id: true, code: true, name: true, status: true } },
      },
      orderBy: [{ shift: { status: 'asc' } }, { createdAt: 'desc' }],
      take: 2,
    });
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedOperatorId: 'opA',
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          machineId: 'POST-1',
          workplaceId: 'post-1',
        }),
      }),
    );
    expect(lockedTableNames(prisma.$queryRaw)).toEqual([
      'users',
      'posts',
      'shifts',
      'operator_shift_machine_assignments',
      'production_orders',
      'roll_dispatch_items',
    ]);
  });

  it('rejects ambiguous current operator assignments', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      assignedOperatorId: null,
      status: 'new',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      currentAssignment('shift-1', 'post-1', 'POST-1'),
      currentAssignment('shift-2', 'post-2', 'POST-2'),
    ]);
    const service = await build(prisma, audit);

    await expect(
      service.assignRoll({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
        operatorId: 'opA',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PRODUCTION_OPERATOR_SHIFT_AMBIGUOUS' },
    });

    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a current topology change after taking assignment locks', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      assignedOperatorId: null,
      plannedShiftId: null,
      postId: null,
      machineId: null,
      workplaceId: null,
      status: 'new',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany
      .mockResolvedValueOnce([currentAssignment('shift-1', 'post-1', 'POST-1')])
      .mockResolvedValueOnce([currentAssignment('shift-1', 'post-2', 'POST-2')]);
    const service = await build(prisma, audit);

    await expect(
      service.assignRoll({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
        operatorId: 'opA',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PRODUCTION_ASSIGNMENT_TOPOLOGY_CHANGED' },
    });

    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('batchUpdate derives null topology before a shift exists', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'r1',
        rollCode: 'roll-1',
        productionOrderId: 'po1',
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
        priority: 10,
        status: 'new',
        productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([]);
    const service = await build(prisma, audit);

    await service.batchUpdate(
      { userId: 'u1', role: 'production_lead' },
      { changes: [{ rollId: 'roll-1', operatorId: 'opA' }] },
    );

    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedOperatorId: 'opA',
          plannedShiftId: null,
          postId: null,
          machineId: null,
          workplaceId: null,
        }),
      }),
    );
  });

  it('batchUpdate derives the unique current assignment for every row', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'r1',
        rollCode: 'roll-1',
        productionOrderId: 'po1',
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
        priority: 10,
        status: 'new',
        productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      currentAssignment('shift-1', 'post-1', 'POST-1'),
    ]);
    const service = await build(prisma, audit);

    await service.batchUpdate(
      { userId: 'u1', role: 'production_lead' },
      { changes: [{ rollId: 'roll-1', operatorId: 'opA', priority: 50 }] },
    );

    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedOperatorId: 'opA',
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          machineId: 'POST-1',
          workplaceId: 'post-1',
          priority: 50,
        }),
      }),
    );
  });

  it('assignRoll stores a draft plan without publishing an operator line', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      plannedWeightKg: 41.2,
      assignedOperatorId: null,
      machineId: null,
      status: 'new',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'planned',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'planned' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    const service = await build(prisma, audit);
    await service.assignRoll({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      operatorId: 'opA',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:roll_dispatch_assigned',
        detail: {
          commercialOrderId: 'co1',
          operatorId: 'opA',
          shiftId: 'shift-1',
          rollId: 'roll-1',
          productionOrderId: 'po1',
        },
      }),
      prisma,
    );
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedOperatorId: 'opA',
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          machineId: 'POST-1',
          status: 'new',
        }),
      }),
    );
    expect(prisma.operatorRollLine.create).not.toHaveBeenCalled();
    expect(audit.record.mock.calls.map(([event]: [{ type: string }]) => event.type)).toEqual([
      'audit:roll_dispatch_assigned',
    ]);
  });

  it('assignRoll publishes the order automatically when the completed plan is ready', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      plannedWeightKg: 41.2,
      assignedOperatorId: null,
      machineId: null,
      status: 'new',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'planned',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'planned' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    const service = await build(prisma, audit);
    const approve = jest
      .spyOn(service, 'approve')
      .mockResolvedValue({ approvalState: 'approved' } as never);
    const actor = { userId: 'u1', role: 'production_lead' as const };

    await service.assignRoll(actor, 'roll-1', {
      operatorId: 'opA',
    });

    expect(approve).toHaveBeenCalledWith(actor, 'po1', prisma);
  });

  it('batchUpdate publishes a completed plan automatically without a frontend flag', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'r1',
        rollCode: 'roll-1',
        productionOrderId: 'po1',
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
        priority: 10,
        status: 'new',
        productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'planned',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'planned' },
      },
    ]);
    const service = await build(prisma, audit);
    const approve = jest
      .spyOn(service, 'approve')
      .mockResolvedValue({ approvalState: 'approved' } as never);
    const actor = { userId: 'u1', role: 'production_lead' as const };

    await service.batchUpdate(actor, {
      changes: [{ rollId: 'roll-1', operatorId: 'opA' }],
    });

    expect(approve).toHaveBeenCalledWith(actor, 'po1', prisma);
  });

  it('assignRoll keeps a draft reassignment as planning-only audit', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-a',
      postId: 'post-a',
      machineId: 'POST-A',
      workplaceId: null,
      status: 'new',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-b',
        shiftId: 'shift-b',
        operatorId: 'opB',
        postId: 'post-b',
        status: 'planned',
        post: { id: 'post-b', code: 'POST-B', status: 'active' },
        shift: { id: 'shift-b', status: 'planned' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opB', role: 'operator', isActive: true });
    const service = await build(prisma, audit);

    await service.assignRoll({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      operatorId: 'opB',
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:roll_dispatch_assigned',
        oldValue: { assignedOperatorId: 'opA' },
        newValue: { assignedOperatorId: 'opB' },
      }),
      prisma,
    );
    expect(audit.record.mock.calls.map(([event]: [{ type: string }]) => event.type)).toEqual([
      'audit:roll_dispatch_assigned',
    ]);
  });

  it('assignRoll accepts a planned operator assignment in an already-open shared shift', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r-new',
      rollCode: 'A9-roll-new',
      productionOrderId: 'po-a9',
      plannedWeightKg: 41.2,
      assignedOperatorId: null,
      plannedShiftId: null,
      machineId: null,
      postId: null,
      workplaceId: null,
      status: 'new',
      productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
    });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-b',
        shiftId: 'shared-shift',
        operatorId: 'operator-b',
        postId: 'post-b',
        status: 'planned',
        post: { id: 'post-b', code: 'POST-B', status: 'active' },
        shift: { id: 'shared-shift', status: 'open' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'operator-b',
      role: 'operator',
      isActive: true,
    });
    const service = await build(prisma, audit);

    await service.assignRoll(
      { userId: 'production-lead', role: 'production_lead' },
      'A9-roll-new',
      { operatorId: 'operator-b' },
    );

    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedOperatorId: 'operator-b',
          plannedShiftId: 'shared-shift',
          postId: 'post-b',
          machineId: 'POST-B',
          status: 'assigned',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:task_assigned',
        objectId: 'A9-roll-new',
      }),
      prisma,
    );
  });

  it.each(['in_progress', 'ready_for_warehouse', 'done'])(
    'assignRoll preserves %s on an exact persisted assignment retry',
    async (status) => {
      const { prisma, audit } = setup();
      const item = {
        id: 'r-active',
        rollCode: 'A9-roll-active',
        productionOrderId: 'po-a9',
        assignedOperatorId: 'operator-b',
        plannedShiftId: 'shared-shift',
        machineId: 'POST-B',
        postId: 'post-b',
        workplaceId: 'post-b',
        status,
        productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
      };
      prisma.rollDispatchItem.findUnique.mockResolvedValue(item);
      prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-b',
          shiftId: 'shared-shift',
          operatorId: 'operator-b',
          postId: 'post-b',
          status: 'locked',
          post: { id: 'post-b', code: 'POST-B', status: 'active' },
          shift: { id: 'shared-shift', status: 'open' },
        },
      ]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'operator-b',
        role: 'operator',
        isActive: true,
      });
      const service = await build(prisma, audit);

      await expect(
        service.assignRoll(
          { userId: 'production-lead', role: 'production_lead' },
          'A9-roll-active',
          {
            operatorId: 'operator-b',
          },
        ),
      ).resolves.toEqual(expect.objectContaining({ status }));

      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each(['in_progress', 'ready_for_warehouse', 'done'])(
    'assignRoll rejects changing the persisted topology of a %s roll',
    async (status) => {
      const { prisma, audit } = setup();
      prisma.rollDispatchItem.findUnique.mockResolvedValue({
        id: 'r-active',
        rollCode: 'A9-roll-active',
        productionOrderId: 'po-a9',
        assignedOperatorId: 'operator-b',
        plannedShiftId: 'shared-shift',
        machineId: 'POST-B',
        postId: 'post-b',
        workplaceId: 'post-b',
        status,
        productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
      });
      prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-b-next',
          shiftId: 'next-shift',
          operatorId: 'operator-b',
          postId: 'post-next',
          status: 'planned',
          post: { id: 'post-next', code: 'POST-NEXT', status: 'active' },
          shift: { id: 'next-shift', status: 'planned' },
        },
      ]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'operator-b',
        role: 'operator',
        isActive: true,
      });
      const service = await build(prisma, audit);

      await expect(
        service.assignRoll(
          { userId: 'production-lead', role: 'production_lead' },
          'A9-roll-active',
          { operatorId: 'operator-b' },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each(['in_progress', 'ready_for_warehouse', 'done'])(
    'assignRoll does not reassign a %s roll to another operator',
    async (status) => {
      const { prisma, audit } = setup();
      prisma.rollDispatchItem.findUnique.mockResolvedValue({
        id: 'r-running',
        rollCode: 'A9-roll-running',
        productionOrderId: 'po-a9',
        assignedOperatorId: 'operator-a',
        status,
        productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
      });
      const service = await build(prisma, audit);

      await expect(
        service.assignRoll(
          { userId: 'production-lead', role: 'production_lead' },
          'A9-roll-running',
          { operatorId: 'operator-b' },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.operatorShiftMachineAssignment.findMany).not.toHaveBeenCalled();
      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['inactive operator', false, 'active', NotFoundException],
    ['inactive post', true, 'inactive', ConflictException],
    ['broken post', true, 'broken', ConflictException],
  ])(
    'assignRoll rejects a planned assignment for %s',
    async (_case, operatorIsActive, postStatus, expectedError) => {
      const { prisma, audit } = setup();
      prisma.rollDispatchItem.findUnique.mockResolvedValue({
        id: 'r-new',
        rollCode: 'A9-roll-new',
        productionOrderId: 'po-a9',
        assignedOperatorId: null,
        status: 'new',
        productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'operator-b',
        role: 'operator',
        isActive: operatorIsActive,
      });
      prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-b',
          shiftId: 'shared-shift',
          operatorId: 'operator-b',
          postId: 'post-b',
          status: 'planned',
          post: { id: 'post-b', code: 'POST-B', status: postStatus },
          shift: { id: 'shared-shift', status: 'open' },
        },
      ]);
      const service = await build(prisma, audit);

      await expect(
        service.assignRoll({ userId: 'production-lead', role: 'production_lead' }, 'A9-roll-new', {
          operatorId: 'operator-b',
        }),
      ).rejects.toBeInstanceOf(expectedError);

      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('assignRoll to a different operator audits task_reassigned', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      assignedOperatorId: 'opA',
      machineId: null,
      status: 'assigned',
      productionOrder: { approvalState: 'approved', commercialOrderId: 'co1' },
    });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opB',
        postId: 'post-2',
        status: 'locked',
        post: { id: 'post-2', code: 'POST-2', status: 'active' },
        shift: { id: 'shift-1', status: 'open' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opB', role: 'operator', isActive: true });
    const service = await build(prisma, audit);
    await service.assignRoll({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      operatorId: 'opB',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:roll_dispatch_assigned',
        detail: {
          commercialOrderId: 'co1',
          operatorId: 'opB',
          shiftId: 'shift-1',
          rollId: 'roll-1',
          productionOrderId: 'po1',
        },
      }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:task_reassigned',
        detail: {
          commercialOrderId: 'co1',
          operatorId: 'opB',
          previousOperatorId: 'opA',
          shiftId: 'shift-1',
          rollId: 'roll-1',
          productionOrderId: 'po1',
        },
      }),
      prisma,
    );
  });

  it('assignRoll restores deferred dispatch status from the paused operator line', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r-deferred',
      rollCode: 'A5-roll-deferred',
      productionOrderId: 'po-a5',
      assignedOperatorId: 'opA',
      plannedShiftId: 'next-shift',
      postId: 'next-post',
      machineId: 'POST-NEXT',
      workplaceId: 'next-post',
      status: 'assigned',
      operatorLine: { step: 'deferred' },
      productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a5' },
    });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      currentAssignment('next-shift', 'next-post', 'POST-NEXT'),
    ]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'opA',
      role: 'operator',
      isActive: true,
    });
    const service = await build(prisma, audit);
    jest.spyOn(service, 'approve').mockResolvedValue({ approvalState: 'approved' } as never);

    await service.assignRoll(
      { userId: 'production-lead', role: 'production_lead' },
      'A5-roll-deferred',
      { operatorId: 'opA' },
    );

    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedOperatorId: 'opA',
          status: 'deferred',
        }),
      }),
    );
  });

  it('assignRoll keeps an individually published roll idempotent while its order is pending', async () => {
    const { prisma, audit } = setup();
    const item = {
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
      machineId: 'POST-1',
      postId: 'post-1',
      workplaceId: 'post-1',
      status: 'assigned',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    };
    prisma.rollDispatchItem.findUnique.mockResolvedValue(item);
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'locked',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'open' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    const service = await build(prisma, audit);

    await expect(
      service.assignRoll({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
        operatorId: 'opA',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'r1',
        rollCode: 'roll-1',
        assignedOperatorId: 'opA',
        plannedShiftId: 'shift-1',
        postId: 'post-1',
        machineId: 'POST-1',
      }),
    );

    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('assignMachine records a divergent command even when the roll already targets the post', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      machineId: 'POST-1',
      postId: 'post-1',
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    prisma.machineAssignment.findFirst.mockResolvedValue({
      id: 'machine-assignment-1',
      rollDispatchItemId: 'r1',
      machineId: 'POST-1',
      postId: 'post-1',
      scope: 'roll',
      reason: 'Старая причина',
      createdAt: new Date('2026-07-21T12:34:56.700Z'),
    });
    const service = await build(prisma, audit);

    await service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      machineId: 'POST-1',
      scope: 'roll',
      reason: 'Новая причина',
    });

    expect(prisma.machineAssignment.create).toHaveBeenCalledTimes(1);
    expect(prisma.rollDispatchItem.update).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:machine_assigned',
        reason: 'Новая причина',
      }),
      prisma,
    );
    expect(
      audit.record.mock.calls.some(
        ([event]: [{ type: string }]) =>
          event.type === 'audit:task_assigned' || event.type === 'audit:task_reassigned',
      ),
    ).toBe(false);
  });

  it('batchUpdate publishes one immutable task event per claimed approved roll', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'r1',
        rollCode: 'roll-1',
        productionOrderId: 'po1',
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
        priority: 10,
        status: 'new',
        productionOrder: { approvalState: 'approved', commercialOrderId: 'co1' },
      },
      {
        id: 'r2',
        rollCode: 'roll-2',
        productionOrderId: 'po1',
        assignedOperatorId: 'opA',
        plannedShiftId: 'shift-a',
        postId: 'post-a',
        machineId: 'POST-A',
        workplaceId: null,
        priority: 20,
        status: 'assigned',
        productionOrder: { approvalState: 'approved', commercialOrderId: 'co1' },
      },
    ]);
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      role: 'operator',
      isActive: true,
    }));
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-b',
        shiftId: 'shift-b',
        operatorId: 'opB',
        postId: 'post-b',
        status: 'planned',
        post: { id: 'post-b', code: 'POST-B', status: 'active' },
        shift: { id: 'shift-b', status: 'planned' },
      },
    ]);
    const service = await build(prisma, audit);

    await expect(
      service.batchUpdate(
        { userId: 'u1', role: 'production_lead' },
        {
          changes: [
            { rollId: 'roll-1', operatorId: 'opB' },
            { rollId: 'roll-2', operatorId: 'opB' },
          ],
        },
      ),
    ).resolves.toEqual({ updated: 2 });

    expect(
      audit.record.mock.calls
        .map(([event]: [{ type: string }]) => event)
        .filter((event: { type: string }) => event.type.startsWith('audit:task_')),
    ).toEqual([
      expect.objectContaining({
        type: 'audit:task_assigned',
        objectId: 'roll-1',
        detail: expect.objectContaining({
          commercialOrderId: 'co1',
          operatorId: 'opB',
          rollId: 'roll-1',
          productionOrderId: 'po1',
        }),
      }),
      expect.objectContaining({
        type: 'audit:task_reassigned',
        objectId: 'roll-2',
        detail: expect.objectContaining({
          commercialOrderId: 'co1',
          operatorId: 'opB',
          previousOperatorId: 'opA',
          rollId: 'roll-2',
          productionOrderId: 'po1',
        }),
      }),
    ]);
  });

  it('assignMachine stamps history with the database wall clock after locking the roll', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      machineId: null,
      postId: null,
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    const service = await build(prisma, audit);

    await service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      machineId: 'POST-1',
      scope: 'roll',
      reason: 'Serialized command',
    });

    expect(prisma.machineAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdAt: DATABASE_WALL_CLOCK }),
    });
    const rawSql = prisma.$queryRaw.mock.calls.map(([query]: [unknown]) =>
      query && typeof query === 'object' && 'strings' in query
        ? Array.from((query as { strings: readonly string[] }).strings).join(' ')
        : '',
    );
    expect(rawSql.findIndex((sql: string) => sql.includes('clock_timestamp()'))).toBeGreaterThan(
      rawSql.findIndex((sql: string) => sql.includes('FROM "roll_dispatch_items"')),
    );
  });

  it('assignMachine advances history by one millisecond when the database clock is not later', async () => {
    const { prisma, audit } = setup();
    const latestCreatedAt = new Date('2026-07-21T12:34:56.900Z');
    const nextCreatedAt = new Date(latestCreatedAt.getTime() + 1);
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      machineId: null,
      postId: null,
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    prisma.machineAssignment.findFirst.mockResolvedValue({
      id: 'machine-assignment-1',
      rollDispatchItemId: 'r1',
      machineId: 'POST-1',
      postId: 'post-1',
      scope: 'roll',
      reason: 'Previous command',
      createdAt: latestCreatedAt,
    });
    prisma.$queryRaw.mockImplementation(async (query: unknown) => {
      if (query && typeof query === 'object' && 'strings' in query) {
        const sql = Array.from((query as { strings: readonly string[] }).strings).join(' ');
        if (sql.includes('GREATEST')) return [{ createdAt: nextCreatedAt }];
        if (sql.includes('clock_timestamp()')) return [{ createdAt: DATABASE_WALL_CLOCK }];
      }
      return [];
    });
    const service = await build(prisma, audit);

    await service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      machineId: 'POST-1',
      scope: 'roll',
      reason: 'Next command',
    });

    expect(prisma.machineAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdAt: nextCreatedAt }),
    });
    const wallClockSql = prisma.$queryRaw.mock.calls
      .map(([query]: [unknown]) =>
        query && typeof query === 'object' && 'strings' in query
          ? Array.from((query as { strings: readonly string[] }).strings).join(' ')
          : '',
      )
      .find((sql: string) => sql.includes('clock_timestamp()'));
    expect(wallClockSql).toContain('GREATEST');
    expect(wallClockSql).toContain("INTERVAL '1 millisecond'");
  });

  it('setPriority audits production_priority_changed with old/new', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      priority: 0,
    });
    const service = await build(prisma, audit);
    await service.setPriority({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      priority: 10,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:production_priority_changed',
        newValue: { priority: 10 },
      }),
    );
  });

  it.each([
    ['planned', 'planned'],
    ['open', 'locked'],
    ['open', 'breakdown_reassigned'],
  ])('assignMachine accepts shift %s with assignment %s', async (shiftStatus, assignmentStatus) => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      machineId: null,
      postId: null,
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: assignmentStatus,
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: shiftStatus },
    });
    const service = await build(prisma, audit);
    await service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
      machineId: 'POST-1',
      scope: 'roll',
    });
    expect(prisma.operatorShiftMachineAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          shiftId: 'shift-1',
          operatorId: 'opA',
          status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
        },
      }),
    );
    expect(prisma.machineAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ postId: 'post-1', machineId: 'POST-1' }),
      }),
    );
    expect(prisma.rollDispatchItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ postId: 'post-1' }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:machine_assigned',
        newValue: expect.objectContaining({ postId: 'post-1' }),
      }),
      prisma,
    );
  });

  it.each([
    ['closed', 'locked'],
    ['open', 'completed'],
    ['planned', 'locked'],
    ['open', 'planned'],
  ])(
    'assignMachine rejects shift %s with assignment %s before any mutation or audit',
    async (shiftStatus, assignmentStatus) => {
      const { prisma, audit } = setup();
      prisma.rollDispatchItem.findUnique.mockResolvedValue({
        id: 'r1',
        rollCode: 'roll-1',
        productionOrderId: 'po1',
        assignedOperatorId: 'opA',
        plannedShiftId: 'shift-1',
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
      prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: assignmentStatus,
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: shiftStatus },
      });
      const service = await build(prisma, audit);

      await expect(
        service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
          machineId: 'POST-1',
          scope: 'roll',
        }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCTION_ASSIGNMENT_LIFECYCLE_CONFLICT' },
      });

      expect(prisma.machineAssignment.create).not.toHaveBeenCalled();
      expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('assignMachine returns an exact persisted retry without duplicate history or audit', async () => {
    const { prisma, audit } = setup();
    const item = {
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      machineId: 'POST-1',
      postId: 'post-1',
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    };
    prisma.rollDispatchItem.findUnique.mockResolvedValue(item);
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    prisma.machineAssignment.findFirst.mockResolvedValue({
      id: 'machine-assignment-1',
      rollDispatchItemId: 'r1',
      machineId: 'POST-1',
      postId: 'post-1',
      scope: 'roll',
      reason: 'Плановый выбор',
    });
    const service = await build(prisma, audit);

    await expect(
      service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
        machineId: 'POST-1',
        scope: 'roll',
        reason: 'Плановый выбор',
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'r1', machineId: 'POST-1' }));

    expect(prisma.machineAssignment.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('assignMachine rejects an exact persisted retry after the shift closes without writes', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      machineId: 'POST-1',
      postId: 'post-1',
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'completed',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'closed' },
    });
    prisma.machineAssignment.findFirst.mockResolvedValue({
      id: 'machine-assignment-1',
      rollDispatchItemId: 'r1',
      machineId: 'POST-1',
      postId: 'post-1',
      scope: 'roll',
      reason: 'Плановый выбор',
    });
    const service = await build(prisma, audit);

    await expect(
      service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
        machineId: 'POST-1',
        scope: 'roll',
        reason: 'Плановый выбор',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PRODUCTION_ASSIGNMENT_LIFECYCLE_CONFLICT' },
    });

    expect(prisma.machineAssignment.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('assignMachine locks topology then roll and rejects a lifecycle change before mutation', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      machineId: null,
      postId: null,
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
      productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findUnique
      .mockResolvedValueOnce({
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'planned',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'planned' },
      })
      .mockResolvedValueOnce({
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'completed',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'closed' },
      });
    const service = await build(prisma, audit);

    await expect(
      service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
        machineId: 'POST-1',
        scope: 'roll',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PRODUCTION_ASSIGNMENT_LIFECYCLE_CONFLICT' },
    });

    expect(lockedTableNames(prisma.$queryRaw)).toEqual([
      'posts',
      'shifts',
      'operator_shift_machine_assignments',
      'roll_dispatch_items',
    ]);
    expect(prisma.machineAssignment.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('assignMachine rejects a machine outside the operator shift assignment', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'r1',
      rollCode: 'roll-1',
      productionOrderId: 'po1',
      assignedOperatorId: 'opA',
      plannedShiftId: 'shift-1',
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    const service = await build(prisma, audit);
    await expect(
      service.assignMachine({ userId: 'u1', role: 'production_lead' }, 'roll-1', {
        machineId: 'GHOST',
        scope: 'roll',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('bulkAssign audits roll_dispatch_bulk_assigned with count', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'r1',
        rollCode: 'roll-1',
        productionOrderId: 'po1',
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
        priority: 10,
        status: 'new',
        productionOrder: { approvalState: 'pending' },
      },
      {
        id: 'r2',
        rollCode: 'roll-2',
        productionOrderId: 'po1',
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
        priority: 20,
        status: 'new',
        productionOrder: { approvalState: 'pending' },
      },
      {
        id: 'r3',
        rollCode: 'roll-3',
        productionOrderId: 'po1',
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
        priority: 30,
        status: 'new',
        productionOrder: { approvalState: 'pending' },
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'planned',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'planned' },
      },
    ]);
    const service = await build(prisma, audit);
    const res = await service.bulkAssign(
      { userId: 'u1', role: 'production_lead' },
      {
        rollIds: ['roll-1', 'roll-2', 'roll-3'],
        operatorId: 'opA',
      },
    );
    expect(res.assigned).toBe(3);
    expect(prisma.operatorRollLine.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:roll_dispatch_bulk_assigned',
        detail: {
          rollIds: ['roll-1', 'roll-2', 'roll-3'],
          count: 3,
          assignments: [
            {
              productionOrderId: 'po1',
              rollId: 'roll-1',
              operatorId: 'opA',
              shiftId: 'shift-1',
            },
            {
              productionOrderId: 'po1',
              rollId: 'roll-2',
              operatorId: 'opA',
              shiftId: 'shift-1',
            },
            {
              productionOrderId: 'po1',
              rollId: 'roll-3',
              operatorId: 'opA',
              shiftId: 'shift-1',
            },
          ],
        },
      }),
      prisma,
    );
    expect(audit.record.mock.calls.map(([event]: [{ type: string }]) => event.type)).toEqual([
      'audit:roll_dispatch_bulk_assigned',
    ]);
  });

  it('bulkAssign reconciles publication after an identical assignment batch', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue(
      ['roll-1', 'roll-2'].map((rollCode, index) => ({
        id: `r${index + 1}`,
        rollCode,
        productionOrderId: 'po1',
        assignedOperatorId: 'opA',
        plannedShiftId: 'shift-1',
        postId: 'post-1',
        machineId: 'POST-1',
        workplaceId: 'post-1',
        plannedWeightKg: 41.2,
        priority: 50,
        status: 'new',
        productionOrder: { approvalState: 'pending', commercialOrderId: 'co1' },
      })),
    );
    prisma.user.findUnique.mockResolvedValue({ id: 'opA', role: 'operator', isActive: true });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'opA',
        postId: 'post-1',
        status: 'planned',
        post: { id: 'post-1', code: 'POST-1', status: 'active' },
        shift: { id: 'shift-1', status: 'planned' },
      },
    ]);
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'opA',
      postId: 'post-1',
      status: 'planned',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
      shift: { id: 'shift-1', status: 'planned' },
    });
    const service = await build(prisma, audit);

    await expect(
      service.batchUpdate(
        { userId: 'u1', role: 'production_lead' },
        {
          changes: [
            { rollId: 'roll-1', operatorId: 'opA', priority: 50 },
            { rollId: 'roll-2', operatorId: 'opA', priority: 50 },
          ],
        },
      ),
    ).resolves.toEqual({ updated: 2 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.operatorRollLine.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ rollDispatchItemId: 'r1', sequence: 1 }),
        expect.objectContaining({ rollDispatchItemId: 'r2', sequence: 2 }),
      ],
      skipDuplicates: true,
    });
    expect(audit.record.mock.calls.map(([event]: [{ type: string }]) => event.type)).toEqual([
      'audit:task_assigned',
      'audit:task_assigned',
    ]);
  });

  it('batchUpdate restores deferred dispatch status from the paused operator line', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'r-deferred',
        rollCode: 'A4-roll-deferred',
        productionOrderId: 'po-a4',
        assignedOperatorId: 'opA',
        plannedShiftId: 'next-shift',
        postId: 'next-post',
        machineId: 'POST-NEXT',
        workplaceId: 'next-post',
        priority: 10,
        status: 'assigned',
        operatorLine: { step: 'deferred' },
        productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a4' },
      },
    ]);
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      currentAssignment('next-shift', 'next-post', 'POST-NEXT'),
    ]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'opA',
      role: 'operator',
      isActive: true,
    });
    const service = await build(prisma, audit);
    jest.spyOn(service, 'approve').mockResolvedValue({ approvalState: 'approved' } as never);

    await service.batchUpdate(
      { userId: 'production-lead', role: 'production_lead' },
      { changes: [{ rollId: 'A4-roll-deferred', operatorId: 'opA' }] },
    );

    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedOperatorId: 'opA',
          status: 'deferred',
        }),
      }),
    );
  });

  it.each(['in_progress', 'ready_for_warehouse', 'done'])(
    'batchUpdate preserves %s on an exact persisted assignment and priority retry',
    async (status) => {
      const { prisma, audit } = setup();
      prisma.rollDispatchItem.findMany.mockResolvedValue([
        {
          id: 'r-active',
          rollCode: 'A9-roll-active',
          productionOrderId: 'po-a9',
          assignedOperatorId: 'operator-b',
          plannedShiftId: 'shared-shift',
          postId: 'post-b',
          machineId: 'POST-B',
          workplaceId: 'post-b',
          priority: 70,
          status,
          productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
        },
      ]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'operator-b',
        role: 'operator',
        isActive: true,
      });
      prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-b',
          shiftId: 'shared-shift',
          operatorId: 'operator-b',
          postId: 'post-b',
          status: 'locked',
          post: { id: 'post-b', code: 'POST-B', status: 'active' },
          shift: { id: 'shared-shift', status: 'open' },
        },
      ]);
      const service = await build(prisma, audit);

      await expect(
        service.batchUpdate(
          { userId: 'production-lead', role: 'production_lead' },
          {
            changes: [
              {
                rollId: 'A9-roll-active',
                operatorId: 'operator-b',
                priority: 70,
              },
            ],
          },
        ),
      ).resolves.toEqual({ updated: 1 });

      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each(['in_progress', 'ready_for_warehouse', 'done'])(
    'batchUpdate rejects changing the assignment topology of a %s roll',
    async (status) => {
      const { prisma, audit } = setup();
      prisma.rollDispatchItem.findMany.mockResolvedValue([
        {
          id: 'r-active',
          rollCode: 'A9-roll-active',
          productionOrderId: 'po-a9',
          assignedOperatorId: 'operator-b',
          plannedShiftId: 'shared-shift',
          postId: 'post-b',
          machineId: 'POST-B',
          workplaceId: 'post-b',
          priority: 70,
          status,
          productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
        },
      ]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'operator-b',
        role: 'operator',
        isActive: true,
      });
      prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-b-next',
          shiftId: 'next-shift',
          operatorId: 'operator-b',
          postId: 'post-next',
          status: 'planned',
          post: { id: 'post-next', code: 'POST-NEXT', status: 'active' },
          shift: { id: 'next-shift', status: 'planned' },
        },
      ]);
      const service = await build(prisma, audit);

      await expect(
        service.batchUpdate(
          { userId: 'production-lead', role: 'production_lead' },
          {
            changes: [
              {
                rollId: 'A9-roll-active',
                operatorId: 'operator-b',
                priority: 70,
              },
            ],
          },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each(['in_progress', 'ready_for_warehouse', 'done'])(
    'batchUpdate rejects changing the priority of a %s roll',
    async (status) => {
      const { prisma, audit } = setup();
      prisma.rollDispatchItem.findMany.mockResolvedValue([
        {
          id: 'r-active',
          rollCode: 'A9-roll-active',
          productionOrderId: 'po-a9',
          assignedOperatorId: 'operator-b',
          plannedShiftId: 'shared-shift',
          postId: 'post-b',
          machineId: 'POST-B',
          workplaceId: 'post-b',
          priority: 70,
          status,
          productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
        },
      ]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'operator-b',
        role: 'operator',
        isActive: true,
      });
      prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-b',
          shiftId: 'shared-shift',
          operatorId: 'operator-b',
          postId: 'post-b',
          status: 'locked',
          post: { id: 'post-b', code: 'POST-B', status: 'active' },
          shift: { id: 'shared-shift', status: 'open' },
        },
      ]);
      const service = await build(prisma, audit);

      await expect(
        service.batchUpdate(
          { userId: 'production-lead', role: 'production_lead' },
          {
            changes: [
              {
                rollId: 'A9-roll-active',
                operatorId: 'operator-b',
                priority: 80,
              },
            ],
          },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each(['in_progress', 'ready_for_warehouse', 'done'])(
    'batchUpdate does not reassign a %s roll to another operator',
    async (status) => {
      const { prisma, audit } = setup();
      prisma.rollDispatchItem.findMany.mockResolvedValue([
        {
          id: 'r-active',
          rollCode: 'A9-roll-active',
          productionOrderId: 'po-a9',
          assignedOperatorId: 'operator-a',
          plannedShiftId: 'shared-shift',
          postId: 'post-a',
          machineId: 'POST-A',
          priority: 70,
          status,
          productionOrder: { approvalState: 'approved', commercialOrderId: 'co-a9' },
        },
      ]);
      const service = await build(prisma, audit);

      await expect(
        service.batchUpdate(
          { userId: 'production-lead', role: 'production_lead' },
          {
            changes: [
              {
                rollId: 'A9-roll-active',
                operatorId: 'operator-b',
                priority: 70,
              },
            ],
          },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.operatorShiftMachineAssignment.findMany).not.toHaveBeenCalled();
      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('batchUpdate validates every row before writing any draft changes', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'r1',
        rollCode: 'roll-1',
        status: 'new',
        productionOrder: { approvalState: 'pending' },
      },
      {
        id: 'r2',
        rollCode: 'roll-2',
        status: 'new',
        productionOrder: { approvalState: 'pending' },
      },
    ]);
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      role: 'operator',
      isActive: true,
    }));
    prisma.operatorShiftMachineAssignment.findMany.mockImplementation(
      async ({ where }: { where: { operatorId: string } }) =>
        where.operatorId === 'opA'
          ? [currentAssignment('shift-1', 'post-1', 'POST-1')]
          : [
              { ...currentAssignment('shift-2', 'post-2', 'POST-2'), operatorId: 'opB' },
              { ...currentAssignment('shift-3', 'post-3', 'POST-3'), operatorId: 'opB' },
            ],
    );
    const service = await build(prisma, audit);

    await expect(
      service.batchUpdate(
        { userId: 'u1', role: 'production_lead' },
        {
          changes: [
            { rollId: 'roll-1', operatorId: 'opA', priority: 50 },
            { rollId: 'roll-2', operatorId: 'opB', priority: 100 },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
  });

  it('reorder swaps the canonical ranks of the supplied rolls and audits old/new', async () => {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      { id: 'r1', rollCode: 'roll-1', queueRank: 3 },
      { id: 'r2', rollCode: 'roll-2', queueRank: 7 },
    ]);
    const service = await build(prisma, audit);

    await service.reorder(
      { userId: 'u1', role: 'production_lead' },
      { orderedRollIds: ['roll-2', 'roll-1'], reason: 'Ручной порядок' },
    );

    expect(prisma.rollDispatchItem.update).toHaveBeenCalledWith({
      where: { rollCode: 'roll-2' },
      data: { queueRank: 3 },
    });
    expect(prisma.rollDispatchItem.update).toHaveBeenCalledWith({
      where: { rollCode: 'roll-1' },
      data: { queueRank: 7 },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:production_queue_reordered',
        reason: 'Ручной порядок',
      }),
    );
  });

  it('rejects assigning a post already reserved by another operator in the shift', async () => {
    const { prisma, audit } = setup();
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'planned',
      plannedStartAt: new Date(Date.now() + 60_000),
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'op-1', role: 'operator', isActive: true });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'active' });
    prisma.operatorShiftMachineAssignment.findFirst.mockImplementation(async (args: any) =>
      args?.where?.OR ? { id: 'other-assignment', operatorId: 'op-2' } : null,
    );
    const service = await build(prisma, audit);

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-1' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a corrected assignment without treating cancelled history as current', async () => {
    const { prisma, audit } = setup();
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'planned',
      plannedStartAt: new Date(Date.now() + 60_000),
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'op-1', role: 'operator', isActive: true });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'active' });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'cancelled-assignment',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'cancelled',
      lockedAt: null,
    });
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue(null);
    prisma.operatorShiftMachineAssignment.create.mockResolvedValue({
      id: 'corrected-assignment',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-2',
      status: 'planned',
    });
    const service = await build(prisma, audit);

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-2' },
      ),
    ).resolves.toMatchObject({ id: 'corrected-assignment', status: 'planned' });
    expect(prisma.operatorShiftMachineAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        shiftId: 'shift-1',
        operatorId: 'op-1',
        status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
      },
      select: { id: true, postId: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(prisma.operatorShiftMachineAssignment.create).toHaveBeenCalled();
  });

  it('rejects a broken post as a business conflict before probing device readiness', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-broken',
      code: 'POST-BROKEN',
      status: 'broken',
    });
    const service = await build(prisma, audit);
    const readiness = Reflect.get(service, 'deviceReadiness') as {
      require: jest.Mock;
    };
    readiness.require.mockRejectedValue(new Error('must not be called'));

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-broken' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(readiness.require).not.toHaveBeenCalled();
  });

  it('rejects assigning an operator who already has a usable assignment in another shift', async () => {
    const { prisma, audit } = setup();
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'planned',
      plannedStartAt: new Date(Date.now() + 60_000),
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'op-1', role: 'operator', isActive: true });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'active' });
    prisma.operatorShiftMachineAssignment.findFirst.mockImplementation(async (args: any) =>
      args?.where?.OR
        ? {
            id: 'assignment-in-other-shift',
            shiftId: 'shift-2',
            operatorId: 'op-1',
            postId: 'post-2',
          }
        : null,
    );
    const service = await build(prisma, audit);

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-1' },
      ),
    ).rejects.toThrow(/operator.*usable shift/i);

    expect(prisma.operatorShiftMachineAssignment.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('allows assigning a post that has a planned assignment for another operator in another shift', async () => {
    const { prisma, audit } = setup();
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'planned',
      plannedStartAt: new Date(Date.now() + 60_000),
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'op-1', role: 'operator', isActive: true });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'active' });
    const existing = {
      id: 'assignment-in-other-shift',
      shiftId: 'shift-2',
      operatorId: 'op-2',
      postId: 'post-1',
    };
    prisma.operatorShiftMachineAssignment.findFirst.mockImplementation(async (args: any) => {
      const alternatives = args?.where?.OR as
        | Array<{ operatorId?: string; postId?: string; shiftId?: string }>
        | undefined;
      if (!alternatives) return null;
      const matches = alternatives.some(
        (candidate) =>
          candidate.operatorId === existing.operatorId ||
          (candidate.postId === existing.postId &&
            (candidate.shiftId === undefined || candidate.shiftId === existing.shiftId)),
      );
      return matches ? existing : null;
    });
    prisma.operatorShiftMachineAssignment.create.mockResolvedValue({
      id: 'new-assignment',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'planned',
    });
    const service = await build(prisma, audit);

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-1' },
      ),
    ).resolves.toMatchObject({ id: 'new-assignment', postId: 'post-1', status: 'planned' });

    expect(prisma.operatorShiftMachineAssignment.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_shift_machine_assigned',
        newValue: expect.objectContaining({ postId: 'post-1' }),
      }),
      prisma,
    );
  });

  it('plans a machine assignment while the post equipment is temporarily unavailable', async () => {
    const { prisma, audit } = setup();
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'planned',
      plannedStartAt: new Date(Date.now() + 60_000),
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'op-1', role: 'operator', isActive: true });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'active' });
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue(null);
    prisma.operatorShiftMachineAssignment.create.mockResolvedValue({
      id: 'new-assignment',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'planned',
    });
    const service = await build(prisma, audit);
    const readiness = Reflect.get(service, 'deviceReadiness') as {
      require: jest.Mock;
    };
    readiness.require.mockRejectedValue(
      new ServiceUnavailableException({
        code: 'POST_DEVICE_NOT_READY',
        message: 'Требуемое оборудование поста сейчас недоступно.',
      }),
    );

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-1' },
      ),
    ).resolves.toMatchObject({ id: 'new-assignment', postId: 'post-1', status: 'planned' });

    expect(prisma.operatorShiftMachineAssignment.create).toHaveBeenCalledTimes(1);
    expect(readiness.require).not.toHaveBeenCalled();
  });

  it('rejects normal machine reassignment after the operator started the shift', async () => {
    const { prisma, audit } = setup();
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'open',
      plannedStartAt: new Date(Date.now() - 60_000),
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'op-1', role: 'operator', isActive: true });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'active' });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      lockedAt: new Date(),
    });
    const service = await build(prisma, audit);

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-2' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not overwrite an assignment locked while the operator opens the shift', async () => {
    const { prisma, audit } = setup();
    let operatorOpenCommitted = false;
    const plannedStartAt = new Date(Date.now() + 60_000);
    prisma.shift.findUnique.mockImplementation(async () => ({
      id: 'shift-1',
      status: operatorOpenCommitted ? 'open' : 'planned',
      plannedStartAt,
    }));
    prisma.user.findUnique.mockResolvedValue({
      id: 'op-1',
      role: 'operator',
      isActive: true,
    });
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-2',
      code: 'POST-2',
      status: 'active',
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockImplementation(async () => ({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: operatorOpenCommitted ? 'locked' : 'planned',
      lockedAt: operatorOpenCommitted ? new Date() : null,
    }));
    prisma.operatorShiftMachineAssignment.findFirst.mockImplementation(async (args: any) =>
      args?.where?.OR ? null : prisma.operatorShiftMachineAssignment.findUnique(args),
    );
    prisma.operatorShiftMachineAssignment.upsert.mockResolvedValue({
      id: 'assignment-1',
      postId: 'post-2',
      status: 'planned',
    });
    prisma.$queryRaw.mockImplementation(async () => {
      if (prisma.$queryRaw.mock.calls.length === 4) operatorOpenCommitted = true;
      return [];
    });
    const service = await build(prisma, audit);

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-2' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
    const lockedTables = prisma.$queryRaw.mock.calls.map(([query]: [unknown]) =>
      query && typeof query === 'object' && 'strings' in query
        ? Array.from((query as { strings: readonly string[] }).strings).join(' ')
        : '',
    );
    expect(lockedTables[0]).toContain('"users"');
    expect(lockedTables.slice(1, 3).every((sql: string) => sql.includes('"posts"'))).toBe(true);
    expect(lockedTables[3]).toContain('"shifts"');
    expect(lockedTables[4]).toContain('"operator_shift_machine_assignments"');
    expect(prisma.operatorShiftMachineAssignment.upsert).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.create).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rolls back a planned machine reassignment when its audit event fails', async () => {
    const { prisma, audit } = setup();
    const assignment = {
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'planned',
      lockedAt: null,
    };
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'planned',
      plannedStartAt: new Date(Date.now() + 60_000),
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'op-1',
      role: 'operator',
      isActive: true,
    });
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-2',
      code: 'POST-2',
      status: 'active',
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue(assignment);
    prisma.operatorShiftMachineAssignment.findFirst.mockImplementation(async (args: any) =>
      args?.where?.OR ? null : prisma.operatorShiftMachineAssignment.findUnique(args),
    );

    let committedPostId = assignment.postId;
    prisma.operatorShiftMachineAssignment.upsert.mockImplementation(async () => {
      committedPostId = 'post-2';
      return { ...assignment, postId: committedPostId };
    });
    let transactionClient: typeof prisma;
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      let stagedPostId = committedPostId;
      transactionClient = {
        ...prisma,
        operatorShiftMachineAssignment: {
          ...prisma.operatorShiftMachineAssignment,
          update: jest.fn(async () => {
            stagedPostId = 'post-2';
            return { ...assignment, postId: stagedPostId };
          }),
        },
      };
      const result = await callback(transactionClient);
      committedPostId = stagedPostId;
      return result;
    });
    audit.record.mockRejectedValue(new Error('Audit unavailable'));
    const service = await build(prisma, audit);

    await expect(
      service.assignOperatorMachine(
        { userId: 'lead-1', role: 'production_lead' },
        'shift-1',
        'op-1',
        { postId: 'post-2' },
      ),
    ).rejects.toThrow('Audit unavailable');

    expect(committedPostId).toBe('post-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_shift_machine_assigned' }),
      transactionClient,
    );
  });

  it('breakdown reassignment closes the old session, moves unfinished rolls and audits old/new', async () => {
    const { prisma, audit } = setup();
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
    });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'active' });
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue(null);
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'session-1',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    });
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 2 });
    prisma.operatorShiftMachineAssignment.update.mockResolvedValue({
      id: 'assignment-1',
      postId: 'post-2',
      previousPostId: 'post-1',
      status: 'breakdown_reassigned',
    });
    const service = await build(prisma, audit);

    await service.breakdownReassign({ userId: 'lead-1', role: 'production_lead' }, 'assignment-1', {
      postId: 'post-2',
      reason: 'Редуктор остановлен',
    });

    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: { status: 'broken' },
    });
    expect(prisma.productionProblem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'machine_breakdown', postId: 'post-1' }),
      }),
    );
    expect(prisma.operatorPostSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', status: 'active' },
      data: { status: 'closed', endedAt: expect.any(Date) },
    });
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: {
        plannedShiftId: 'shift-1',
        assignedOperatorId: 'op-1',
        status: { notIn: ['ready_for_warehouse', 'done'] },
      },
      data: {
        postId: 'post-2',
        workplaceId: 'post-2',
        machineId: 'POST-2',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_machine_breakdown_reassigned',
        oldValue: { postId: 'post-1', workplaceId: 'post-1', machineId: 'POST-1' },
        newValue: { postId: 'post-2', workplaceId: 'post-2', machineId: 'POST-2' },
        reason: 'Редуктор остановлен',
      }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_post_session_closed',
        actorRole: 'production_lead',
        actorId: 'lead-1',
        objectId: 'post-1',
        reason: 'Редуктор остановлен',
        detail: expect.objectContaining({
          sessionId: 'session-1',
          shiftId: 'shift-1',
          source: 'production_breakdown_reassign',
        }),
      }),
      prisma,
    );
  });

  it('rejects breakdown reassignment before mutations when the active session has an open bag usage', async () => {
    const { prisma, audit } = setup();
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
    });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'active' });
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue(null);
    prisma.shiftBagUsage.findFirst.mockResolvedValue({ id: 'usage-1' });
    const service = await build(prisma, audit);

    await expect(
      service.breakdownReassign({ userId: 'lead-1', role: 'production_lead' }, 'assignment-1', {
        postId: 'post-2',
        reason: 'Редуктор остановлен',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_BREAKDOWN_OPEN_BAG_USAGE' }),
    });

    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
    expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.update).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    'rolls back breakdown reassignment when required audit event %i fails',
    async (failedEvent) => {
      const { prisma, audit } = setup();
      const assignment = {
        id: 'assignment-atomic-1',
        shiftId: 'shift-atomic-1',
        operatorId: 'op-atomic-1',
        postId: 'post-atomic-1',
        status: 'locked',
        post: { id: 'post-atomic-1', code: 'POST-ATOMIC-1', status: 'active' },
      };
      prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue(assignment);
      prisma.post.findUnique.mockResolvedValue({
        id: 'post-atomic-2',
        code: 'POST-ATOMIC-2',
        status: 'active',
      });
      prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue(null);
      prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 2 });

      let committed = { postStatus: 'active', assignmentPostId: 'post-atomic-1' };
      let transactionClient: any;
      prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) => {
        const staged = { ...committed };
        transactionClient = {
          ...prisma,
          post: {
            ...prisma.post,
            update: jest.fn(async () => {
              staged.postStatus = 'broken';
            }),
          },
          operatorShiftMachineAssignment: {
            ...prisma.operatorShiftMachineAssignment,
            update: jest.fn(async () => {
              staged.assignmentPostId = 'post-atomic-2';
              return {
                ...assignment,
                previousPostId: assignment.postId,
                postId: 'post-atomic-2',
                status: 'breakdown_reassigned',
              };
            }),
          },
        };
        const result = await callback(transactionClient);
        committed = staged;
        return result;
      });
      let auditEvent = 0;
      audit.record.mockImplementation(async (_input: unknown, client: unknown) => {
        auditEvent += 1;
        if (client !== transactionClient) throw new Error('Audit escaped the transaction');
        if (auditEvent === failedEvent) throw new Error(`Audit event ${failedEvent} unavailable`);
      });
      const service = await build(prisma, audit);

      await expect(
        service.breakdownReassign({ userId: 'lead-1', role: 'production_lead' }, assignment.id, {
          postId: 'post-atomic-2',
          reason: 'Редуктор остановлен',
        }),
      ).rejects.toThrow();

      expect(committed).toEqual({
        postStatus: 'active',
        assignmentPostId: 'post-atomic-1',
      });
    },
  );

  it('rechecks open bag usage only after serializing breakdown against operator shift opening', async () => {
    const { prisma, audit } = setup();
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      post: { id: 'post-1', code: 'POST-1', status: 'active' },
    });
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-2',
      code: 'POST-2',
      status: 'active',
    });
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue(null);
    prisma.operatorShiftMachineAssignment.update.mockResolvedValue({
      id: 'assignment-1',
      postId: 'post-2',
      previousPostId: 'post-1',
      status: 'breakdown_reassigned',
    });
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 0 });
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'session-1',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    });

    let activeSessionLocked = false;
    prisma.$queryRaw.mockImplementation(async () => {
      if (prisma.$queryRaw.mock.calls.length === 5) activeSessionLocked = true;
      return [];
    });
    prisma.shiftBagUsage.findFirst.mockImplementation(async () =>
      activeSessionLocked ? { id: 'usage-opened-concurrently' } : null,
    );
    const service = await build(prisma, audit);

    await expect(
      service.breakdownReassign({ userId: 'lead-1', role: 'production_lead' }, 'assignment-1', {
        postId: 'post-2',
        reason: 'Редуктор остановлен',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_BREAKDOWN_OPEN_BAG_USAGE' }),
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
    expect(prisma.shiftBagUsage.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.$queryRaw.mock.invocationCallOrder[4],
    );
    expect(prisma.shiftBagUsage.findFirst).toHaveBeenCalledWith({
      where: { sessionId: 'session-1', closedAt: null },
      select: { id: true },
    });
    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.update).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reassigns away from a post under maintenance without regressing it to broken', async () => {
    const { prisma, audit } = setup();
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-maintenance',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      post: { id: 'post-1', code: 'POST-1', status: 'maintenance' },
    });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'active' });
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue(null);
    prisma.productionProblem.findFirst.mockResolvedValue({
      id: 'problem-maintenance',
      type: 'machine_breakdown',
      postId: 'post-1',
      status: 'open',
    });
    prisma.operatorShiftMachineAssignment.update.mockResolvedValue({
      id: 'assignment-maintenance',
      postId: 'post-2',
      previousPostId: 'post-1',
      status: 'breakdown_reassigned',
    });
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 0 });
    const service = await build(prisma, audit);

    await service.breakdownReassign(
      { userId: 'lead-1', role: 'production_lead' },
      'assignment-maintenance',
      { postId: 'post-2', reason: 'Станок уже передан в ремонт' },
    );

    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
  });
});

describe('ProductionService.createFromCommercial (handoff)', () => {
  function handoffPrisma() {
    const prisma: any = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co1',
          orderNumber: 'A-1024',
          requestType: 'client_order',
          warehouseCoverageWorkflowVersion: 1,
          commercialStage: 'in_work',
          paymentStatus: 'partial',
          financeOrder: {
            id: 'fo1',
            commercialOrderId: 'co1',
            productionClearedAt: null,
            invoiceStatus: 'invoiced',
            policy: null,
            paymentTermsType: 'prepay_50_postpay_50_30d',
            schedules: [{ kind: 'invoice_prepayment', status: 'paid' }],
          },
          positions: [
            {
              id: 'pos1',
              rollCount: 2,
              warehouseCoverStatus: 'needs_production',
              filmType: 'Рукав',
              actualThickness: '80 мкм',
              accountingThickness: '78 мкм',
              rawMaterialId: 'rm1',
              spoolType: '76 мм',
              birka: 'Белая',
              manualBirka: 'Маркировка А-17',
              plannedWeightKg: 99,
              widthMm: 1700,
              plannedLengthM: 500,
              comment: 'Комментарий для производства',
              coverProposals: [],
              recipe: {
                version: 'v1',
                parameters: [
                  { label: 'План. вес, кг', value: '41,2' },
                  { label: 'Метраж, м', value: '500' },
                  { label: 'Ширина', value: '1700 мм' },
                ],
              },
            },
            {
              id: 'pos2',
              rollCount: 1,
              warehouseCoverStatus: 'needs_production',
              filmType: 'Полурукав',
              actualThickness: '60 мкм',
              accountingThickness: '58 мкм',
              rawMaterialId: null,
              spoolType: null,
              birka: null,
              plannedWeightKg: 38.5,
              widthMm: 1400,
              plannedLengthM: 350,
              coverProposals: [],
              recipe: null,
            },
          ],
        }),
        update: jest.fn(),
      },
      productionOrder: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'po-new', commercialOrderId: 'co1' }),
      },
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'fo1',
          commercialOrderId: 'co1',
          productionClearedAt: null,
          invoiceStatus: 'invoiced',
          policy: null,
          paymentTermsType: 'prepay_50_postpay_50_30d',
          schedules: [
            {
              paymentPolicyStageId: null,
              kind: 'invoice_prepayment',
              status: 'paid',
            },
          ],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      rollDispatchItem: {
        aggregate: jest.fn().mockResolvedValue({ _max: { queueRank: 7 } }),
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      defectRecord: { count: jest.fn().mockResolvedValue(0) },
      domainEvent: { create: jest.fn() },
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => unknown) => callback(prisma));
    return prisma;
  }

  it('delegates V2 handoff to the atomic coverage service without opening a legacy transaction', async () => {
    const prisma = handoffPrisma();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      warehouseCoverageWorkflowVersion: 2,
    });
    prisma.productionOrder.findUnique.mockResolvedValue({
      ...fullOrder,
      id: 'po-v2',
      commercialOrder: {
        ...fullOrder.commercialOrder,
        warehouseCoverageWorkflowVersion: 2,
      },
      sourceCoverageCalculationId: 'calculation-2',
      sourceCoverageDecisionId: 'decision-2',
      sourceCoverageInputFingerprint: 'a'.repeat(64),
      sourceCoverageGeneration: 2,
    });
    const v2CoverageHandoff = {
      createV2ProductionOrder: jest.fn().mockResolvedValue({
        productionOrderId: 'po-v2',
        sourceCalculationId: 'calculation-2',
        sourceDecisionId: 'decision-2',
        inputFingerprint: 'a'.repeat(64),
        generation: 2,
      }),
    };
    const service = await build(prisma, { record: jest.fn() }, v2CoverageHandoff);

    const projected = await service.createFromCommercial(
      {
        userId: 'u1',
        role: 'commercial',
        capabilities: ['production_order:handoff'],
      },
      'co1',
    );

    expect(v2CoverageHandoff.createV2ProductionOrder).toHaveBeenCalledWith(
      {
        userId: 'u1',
        role: 'commercial',
        capabilities: ['production_order:handoff'],
      },
      'co1',
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(projected).not.toHaveProperty('sourceCoverageCalculationId');
    expect(projected).not.toHaveProperty('sourceCoverageDecisionId');
    expect(projected).not.toHaveProperty('sourceCoverageInputFingerprint');
    expect(projected).toHaveProperty('sourceGeneration', 2);
  });

  it('creates a production order, expands positions into rolls, syncs indicator, audits', async () => {
    const prisma: any = handoffPrisma();
    prisma.productionOrder.findUnique
      .mockResolvedValueOnce(null) // idempotency probe: none exists
      .mockResolvedValueOnce(fullOrder); // getOrder reload
    const audit = { record: jest.fn() };
    const service = await build(prisma, audit);

    await service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1');

    expect(prisma.productionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          commercialOrderId: 'co1',
          indicator: 'needs_production',
          approvalState: 'pending',
        }),
      }),
    );
    const rolls = prisma.rollDispatchItem.createMany.mock.calls[0][0].data;
    expect(rolls).toHaveLength(3); // 2 + 1
    expect(rolls.map((r: any) => r.rollCode)).toEqual([
      'A-1024-roll-1',
      'A-1024-roll-2',
      'A-1024-roll-3',
    ]);
    expect(rolls[0]).toMatchObject({
      productionOrderId: 'po-new',
      orderLineId: 'pos1',
      positionSequence: 1,
      rawMaterialId: 'rm1',
      recipeVersion: 'v1',
      filmType: 'Рукав',
      plannedWeightKg: 41.2,
      widthMm: 1700,
      plannedLengthM: 500,
      characteristicsSnapshot: expect.objectContaining({
        widthMm: 1700,
        plannedLengthM: 500,
        manualBirka: 'Маркировка А-17',
        comment: 'Комментарий для производства',
      }),
      queueRank: 8,
      status: 'new',
    });
    expect(rolls[1]).toMatchObject({
      orderLineId: 'pos1',
      positionSequence: 2,
      rawMaterialId: 'rm1',
      recipeVersion: 'v1',
    });
    expect(rolls[2]).toMatchObject({
      orderLineId: 'pos2',
      positionSequence: 1,
      rawMaterialId: null,
      recipeVersion: null,
      filmType: 'Полурукав',
      plannedWeightKg: 38.5,
      widthMm: 1400,
      plannedLengthM: 350,
      queueRank: 10,
    });
    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'co1' },
        data: { productionIndicator: 'needs_production' },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:production_order_created',
        actorRole: 'commercial',
        detail: {
          commercialOrderId: 'co1',
          productionOrderId: 'po-new',
          orderNumber: 'A-1024',
        },
      }),
      prisma,
    );
    expect(prisma.financeOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'fo1', productionClearedAt: null },
      data: { productionClearedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:finance_production_cleared',
        objectId: 'fo1',
      }),
      prisma,
    );
  });

  it('rejects an oversized residual roll expansion before creating durable production facts', async () => {
    const prisma: any = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    commercial.positions = [{ ...commercial.positions[0], rollCount: 2_001 }];
    prisma.commercialOrder.findUnique.mockResolvedValue(commercial);
    prisma.productionOrder.findUnique.mockResolvedValue(null);
    const audit = { record: jest.fn() };
    const service = await build(prisma, audit);

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_ORDER_TOO_LARGE', maxRolls: 2_000 }),
    });
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.createMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('hands stock production to the normal roll pipeline without a finance order', async () => {
    const prisma: any = handoffPrisma();
    const stockOrder = {
      ...(await prisma.commercialOrder.findUnique()),
      orderNumber: 'S-1',
      requestType: 'stock_reserve',
      stockBatchCode: 'STOCK-S-1',
      paymentStatus: 'not_applicable',
      shipmentStatus: 'not_applicable',
      financeOrder: null,
    };
    prisma.commercialOrder.findUnique.mockResolvedValue(stockOrder);
    prisma.productionOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(fullOrder);
    const audit = { record: jest.fn() };
    const service = await build(prisma, audit);

    await service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1');

    expect(prisma.productionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          commercialOrderId: 'co1',
          indicator: 'needs_production',
        }),
      }),
    );
    expect(prisma.rollDispatchItem.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([expect.objectContaining({ rollCode: 'S-1-roll-1' })]),
    });
  });

  it('copies the immutable mixed recipe snapshot and clears the singular stock material id', async () => {
    const prisma = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          rollCount: 1,
          rawMaterialId: 'legacy-must-not-leak',
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: 'recipe-version-3',
          recipeDefinitionVersion: {
            id: 'recipe-version-3',
            version: 3,
            recipeDefinition: { id: 'recipe-3', name: 'Синяя смесь' },
            ingredients: [
              {
                sequence: 1,
                shareBasisPoints: 8000,
                rawMaterialDefinition: { id: 'm-primary', name: 'Первичное' },
              },
              {
                sequence: 2,
                shareBasisPoints: 2000,
                rawMaterialDefinition: { id: 'm-blue', name: 'Синий краситель' },
              },
            ],
          },
          recipe: {
            version: 'v1',
            parameters: [{ label: 'План. вес, кг', value: '40' }],
            recipeDefinitionId: 'recipe-3',
            recipeDefinitionVersionId: 'recipe-version-3',
            recipeVersionNumber: 3,
            recipeName: 'Синяя смесь',
            ingredients: [
              {
                rawMaterialDefinitionId: 'm-primary',
                name: 'Первичное',
                shareBasisPoints: 8000,
              },
              {
                rawMaterialDefinitionId: 'm-blue',
                name: 'Синий краситель',
                shareBasisPoints: 2000,
              },
            ],
          },
        },
      ],
    });
    prisma.productionOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(fullOrder);
    const service = await build(prisma, { record: jest.fn() });

    await service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1');

    const [roll] = prisma.rollDispatchItem.createMany.mock.calls[0][0].data;
    expect(roll).toMatchObject({
      rawMaterialId: null,
      characteristicsSnapshot: {
        rawMaterialId: null,
        recipe: {
          recipeDefinitionVersionId: 'recipe-version-3',
          name: 'Синяя смесь',
          version: 3,
          ingredients: [
            {
              rawMaterialDefinitionId: 'm-primary',
              name: 'Первичное',
              shareBasisPoints: 8000,
            },
            {
              rawMaterialDefinitionId: 'm-blue',
              name: 'Синий краситель',
              shareBasisPoints: 2000,
            },
          ],
        },
      },
    });
  });

  it('rejects a named snapshot composition that differs from its selected version', async () => {
    const prisma = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: 'recipe-version-1',
          recipeDefinitionVersion: {
            id: 'recipe-version-1',
            version: 1,
            recipeDefinition: { id: 'recipe-1', name: 'Первичное специальное' },
            ingredients: [
              {
                sequence: 1,
                shareBasisPoints: 10_000,
                rawMaterialDefinition: { id: 'm-primary', name: 'Первичное' },
              },
            ],
          },
          recipe: {
            version: 'v1',
            parameters: [],
            recipeDefinitionId: 'recipe-1',
            recipeDefinitionVersionId: 'recipe-version-1',
            recipeVersionNumber: 1,
            recipeName: 'Первичное специальное',
            ingredients: [
              {
                rawMaterialDefinitionId: 'm-ghost',
                name: 'Несуществующий компонент',
                shareBasisPoints: 10_000,
              },
            ],
          },
        },
      ],
    });
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_SNAPSHOT_INVALID' }),
    });
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.createMany).not.toHaveBeenCalled();
  });

  it('uses linked stock materialId only for a structured one-component base selection', async () => {
    const prisma = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          rollCount: 1,
          rawMaterialId: null,
          baseRawMaterialDefinitionId: 'm-primary',
          recipeDefinitionVersionId: null,
          baseRawMaterialDefinition: {
            id: 'm-primary',
            name: 'Первичное',
            stock: { materialId: 'rm-linked-primary' },
          },
          recipe: {
            version: 'v1',
            parameters: [],
            recipeDefinitionId: null,
            recipeDefinitionVersionId: null,
            recipeVersionNumber: null,
            recipeName: 'Первичное',
            ingredients: [
              {
                rawMaterialDefinitionId: 'm-primary',
                name: 'Первичное',
                shareBasisPoints: 10_000,
              },
            ],
          },
        },
      ],
    });
    prisma.productionOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(fullOrder);
    const service = await build(prisma, { record: jest.fn() });

    await service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1');

    const [roll] = prisma.rollDispatchItem.createMany.mock.calls[0][0].data;
    expect(roll).toMatchObject({
      rawMaterialId: 'rm-linked-primary',
      characteristicsSnapshot: {
        rawMaterialId: 'rm-linked-primary',
        recipe: {
          recipeDefinitionVersionId: null,
          name: 'Первичное',
          version: null,
          ingredients: [
            {
              rawMaterialDefinitionId: 'm-primary',
              name: 'Первичное',
              shareBasisPoints: 10_000,
            },
          ],
        },
      },
    });
    expect(prisma.commercialOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          positions: {
            include: expect.objectContaining({
              baseRawMaterialDefinition: {
                select: {
                  id: true,
                  name: true,
                  stock: { select: { materialId: true } },
                },
              },
            }),
          },
        }),
      }),
    );
  });

  it('rejects named-recipe identity metadata on a base-material snapshot', async () => {
    const prisma = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          baseRawMaterialDefinitionId: 'm-primary',
          recipeDefinitionVersionId: null,
          baseRawMaterialDefinition: {
            id: 'm-primary',
            name: 'Первичное',
            stock: { materialId: 'rm-linked-primary' },
          },
          recipe: {
            version: 'v1',
            parameters: [],
            recipeDefinitionId: 'recipe-must-not-exist',
            recipeDefinitionVersionId: null,
            recipeVersionNumber: null,
            recipeName: 'Первичное',
            ingredients: [
              {
                rawMaterialDefinitionId: 'm-primary',
                name: 'Первичное',
                shareBasisPoints: 10_000,
              },
            ],
          },
        },
      ],
    });
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_SNAPSHOT_INVALID' }),
    });
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.createMany).not.toHaveBeenCalled();
  });

  it('keeps a one-component named recipe free of a singular stock material id', async () => {
    const prisma = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          rollCount: 1,
          rawMaterialId: 'legacy-must-not-leak',
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: 'recipe-version-single',
          recipeDefinitionVersion: {
            id: 'recipe-version-single',
            version: 1,
            recipeDefinition: { id: 'recipe-single', name: 'Особая первичка' },
            ingredients: [
              {
                sequence: 1,
                shareBasisPoints: 10_000,
                rawMaterialDefinition: { id: 'm-primary', name: 'Первичное' },
              },
            ],
          },
          baseRawMaterialDefinition: null,
          recipe: {
            version: 'v1',
            parameters: [],
            recipeDefinitionId: 'recipe-single',
            recipeDefinitionVersionId: 'recipe-version-single',
            recipeVersionNumber: 1,
            recipeName: 'Особая первичка',
            ingredients: [
              {
                rawMaterialDefinitionId: 'm-primary',
                name: 'Первичное',
                shareBasisPoints: 10_000,
              },
            ],
          },
        },
      ],
    });
    prisma.productionOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(fullOrder);
    const service = await build(prisma, { record: jest.fn() });

    await service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1');

    const [roll] = prisma.rollDispatchItem.createMany.mock.calls[0][0].data;
    expect(roll.rawMaterialId).toBeNull();
    expect(roll.characteristicsSnapshot.rawMaterialId).toBeNull();
  });

  it('rejects a malformed structured recipe snapshot before production writes', async () => {
    const prisma = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: 'recipe-version-invalid',
          recipe: {
            version: 'v1',
            parameters: [],
            recipeDefinitionId: 'recipe-invalid',
            recipeDefinitionVersionId: 'recipe-version-invalid',
            recipeVersionNumber: 1,
            recipeName: 'Поврежденный snapshot',
            ingredients: [
              {
                rawMaterialDefinitionId: 'm-primary',
                name: 'Первичное',
                shareBasisPoints: 9000,
              },
            ],
          },
        },
      ],
    });
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_SNAPSHOT_INVALID' }),
    });
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.createMany).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
  });

  it('rejects orphaned structured metadata instead of treating it as legacy material', async () => {
    const prisma = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          rawMaterialId: 'legacy-must-not-leak',
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: null,
          recipe: {
            version: 'v1',
            parameters: [],
            recipeDefinitionId: 'recipe-orphaned',
            recipeDefinitionVersionId: null,
            recipeVersionNumber: null,
            recipeName: null,
            ingredients: null,
          },
        },
      ],
    });
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_SNAPSHOT_INVALID' }),
    });
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.createMany).not.toHaveBeenCalled();
  });

  it('rejects a named recipe snapshot with an oversized catalog name', async () => {
    const prisma = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: 'recipe-version-long-name',
          recipe: {
            version: 'v1',
            parameters: [],
            recipeDefinitionId: 'recipe-long-name',
            recipeDefinitionVersionId: 'recipe-version-long-name',
            recipeVersionNumber: 1,
            recipeName: 'x'.repeat(121),
            ingredients: [
              {
                rawMaterialDefinitionId: 'm-primary',
                name: 'Первичное',
                shareBasisPoints: 10_000,
              },
            ],
          },
        },
      ],
    });
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'RECIPE_SNAPSHOT_INVALID' }),
    });
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.createMany).not.toHaveBeenCalled();
  });

  it('creates the order, dispatch rows, and created event through one transaction client', async () => {
    const prisma: any = handoffPrisma();
    const tx = {
      commercialOrder: prisma.commercialOrder,
      productionOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'po-new', commercialOrderId: 'co1' }),
      },
      financeOrder: prisma.financeOrder,
      rollDispatchItem: prisma.rollDispatchItem,
    };
    prisma.productionOrder.findUnique.mockResolvedValue(fullOrder);
    prisma.$transaction.mockImplementation(
      async (callback: (client: any) => unknown, options?: unknown) =>
        callback(options ? prisma : tx),
    );
    const audit = { record: jest.fn() };
    const service = await build(prisma, audit);

    await service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1');

    expect(tx.productionOrder.create).toHaveBeenCalledTimes(1);
    expect(tx.rollDispatchItem.createMany).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:production_order_created', objectId: 'po-new' }),
      tx,
    );
  });

  it('creates dispatch items only for the uncovered quantity of every position', async () => {
    const prisma: any = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: commercial.positions.map((position: any, index: number) => {
        const proposalId = `cover-${index + 1}`;
        const rollId = `warehouse-roll-${index + 1}`;
        return {
          ...position,
          rollCount: 2,
          warehouseCoverStatus: 'partial_confirmed',
          coverProposals: [
            {
              id: proposalId,
              status: 'partial_confirmed',
              coverQty: 1,
              reserveQty: 1,
              productionQty: 1,
              commercialApprovedAt: new Date('2026-07-14T08:00:00.000Z'),
              technicalApprovedAt: new Date('2026-07-14T08:05:00.000Z'),
              reservedRolls: [
                {
                  id: rollId,
                  reservedForOrderId: 'co1',
                  reservedForPositionId: position.id,
                  reservedByProposalId: proposalId,
                },
              ],
            },
          ],
        };
      }),
    });
    prisma.productionOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(fullOrder);
    const service = await build(prisma, { record: jest.fn() });

    await service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1');

    const rolls = prisma.rollDispatchItem.createMany.mock.calls[0][0].data;
    expect(rolls).toHaveLength(2);
    expect(rolls.every((roll: any) => roll.positionSequence === 2)).toBe(true);
    expect(rolls.map((roll: any) => roll.orderLineId)).toEqual(['pos1', 'pos2']);
  });

  it('does not create a production order for a fully covered order', async () => {
    const prisma: any = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          rollCount: 2,
          warehouseCoverStatus: 'full_confirmed',
          coverProposals: [
            {
              id: 'cover-full',
              status: 'full_confirmed',
              coverQty: 2,
              reserveQty: 2,
              productionQty: 0,
              commercialApprovedAt: new Date('2026-07-14T08:00:00.000Z'),
              technicalApprovedAt: new Date('2026-07-14T08:05:00.000Z'),
              reservedRolls: ['warehouse-roll-1', 'warehouse-roll-2'].map((id) => ({
                id,
                reservedForOrderId: 'co1',
                reservedForPositionId: 'pos1',
                reservedByProposalId: 'cover-full',
              })),
            },
          ],
        },
      ],
    });
    prisma.productionOrder.findUnique.mockResolvedValue(null);
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).resolves.toEqual(
      expect.objectContaining({
        commercialOrderId: 'co1',
        productionRequired: false,
        productionOrderId: null,
        rollCount: 0,
      }),
    );
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.createMany).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
  });

  it('rejects handoff while any position cover route is unresolved', async () => {
    const prisma: any = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...commercial,
      positions: [
        {
          ...commercial.positions[0],
          warehouseCoverStatus: 'partial_proposed',
          coverProposals: [],
        },
      ],
    });
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
  });

  it('is idempotent — returns the existing production order without creating a duplicate', async () => {
    const prisma: any = handoffPrisma();
    prisma.productionOrder.findUnique
      .mockResolvedValueOnce({ id: 'po-exists', commercialOrderId: 'co1' }) // already handed off
      .mockResolvedValueOnce(fullOrder); // getOrder reload
    const audit = { record: jest.fn() };
    const service = await build(prisma, audit);

    await service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1');

    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.createMany).not.toHaveBeenCalled();
  });

  it('returns the P2002 winner without attempting a second created event', async () => {
    const prisma: any = handoffPrisma();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['commercialOrderId'] },
      }),
    );
    prisma.productionOrder.findUnique
      .mockResolvedValueOnce({ id: 'po-winner', commercialOrderId: 'co1' })
      .mockResolvedValueOnce({ ...fullOrder, id: 'po-winner' });
    const audit = { record: jest.fn() };
    const service = await build(prisma, audit);

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).resolves.toBeDefined();

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('throws NotFound when the commercial order does not exist', async () => {
    const prisma: any = handoffPrisma();
    prisma.commercialOrder.findUnique.mockResolvedValue(null);
    const audit = { record: jest.fn() };
    const service = await build(prisma, audit);

    await expect(
      service.createFromCommercial({ userId: null, role: 'commercial' }, 'nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows handoff for a canonical policy without prepayment', async () => {
    const prisma: any = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'co1',
      orderNumber: 'A-1024',
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'sent_to_finance',
      paymentStatus: 'unpaid',
      financeOrder: {
        invoiceStatus: 'invoiced',
        policy: {
          id: 'policy-1',
          stages: [{ id: 'shipment-stage', trigger: 'full_shipment' }],
        },
        paymentTermsType: null,
        schedules: [
          {
            paymentPolicyStageId: 'shipment-stage',
            kind: 'post_delivery',
            status: 'unpaid',
          },
        ],
      },
      positions: commercial.positions,
    });
    prisma.productionOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(fullOrder);
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).resolves.toBeDefined();
    expect(prisma.productionOrder.create).toHaveBeenCalled();
    expect(prisma.commercialOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          financeOrder: {
            select: expect.objectContaining({
              policy: {
                select: {
                  id: true,
                  stages: { select: { id: true, trigger: true } },
                },
              },
              schedules: {
                where: { kind: { in: ['invoice_prepayment', 'post_delivery'] } },
                select: { paymentPolicyStageId: true, kind: true, status: true },
              },
            }),
          },
        }),
      }),
    );
  });

  it('rejects canonical handoff while invoice prepayment is unpaid', async () => {
    const prisma: any = handoffPrisma();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'co1',
      orderNumber: 'A-1024',
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'sent_to_finance',
      paymentStatus: 'unpaid',
      financeOrder: {
        invoiceStatus: 'invoiced',
        policy: {
          id: 'policy-1',
          stages: [{ id: 'invoice-stage', trigger: 'invoice_issued' }],
        },
        paymentTermsType: null,
        schedules: [
          {
            paymentPolicyStageId: 'invoice-stage',
            kind: 'invoice_prepayment',
            status: 'unpaid',
          },
        ],
      },
      positions: [],
    });
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.productionOrder.create).not.toHaveBeenCalled();
  });

  it('allows canonical handoff after every invoice prepayment is paid', async () => {
    const prisma: any = handoffPrisma();
    const commercial = await prisma.commercialOrder.findUnique();
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'co1',
      orderNumber: 'A-1024',
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'in_work',
      paymentStatus: 'partial',
      financeOrder: {
        invoiceStatus: 'invoiced',
        policy: {
          id: 'policy-1',
          stages: [{ id: 'invoice-stage', trigger: 'invoice_issued' }],
        },
        paymentTermsType: null,
        schedules: [
          {
            paymentPolicyStageId: 'invoice-stage',
            kind: 'invoice_prepayment',
            status: 'paid',
          },
        ],
      },
      positions: commercial.positions,
    });
    prisma.productionOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(fullOrder);
    const service = await build(prisma, { record: jest.fn() });

    await expect(
      service.createFromCommercial({ userId: 'u1', role: 'commercial' }, 'co1'),
    ).resolves.toBeDefined();
    expect(prisma.productionOrder.create).toHaveBeenCalled();
  });
});

describe('ProductionService machine breakdown lifecycle (дизайн 2026-07-14)', () => {
  const actor = { userId: 'lead-1', role: 'production_lead' as const };

  it('marks the post broken, opens a machine_breakdown problem and audits it', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-3',
      code: 'POST-3',
      name: 'Станок 3',
      status: 'active',
    });
    prisma.productionProblem.create.mockResolvedValue({
      id: 'pr-b1',
      type: 'machine_breakdown',
      postId: 'post-3',
    });
    const service = await build(prisma, audit);

    const problem = await service.reportMachineBreakdown(actor, 'post-3', { reason: 'клин шнека' });

    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'post-3' },
      data: { status: 'broken' },
    });
    expect(prisma.productionProblem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'machine_breakdown',
          postId: 'post-3',
          reason: 'клин шнека',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'problem:machine_breakdown_reported', objectId: 'post-3' }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:machine_breakdown_confirmed' }),
      prisma,
    );
    expect(problem).toEqual(expect.objectContaining({ id: 'pr-b1' }));
  });

  it('rejects breakdown report on an already broken or missing post', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'broken' });
    const service = await build(prisma, audit);

    await expect(
      service.reportMachineBreakdown(actor, 'post-3', { reason: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);

    prisma.post.findUnique.mockResolvedValue(null);
    await expect(
      service.reportMachineBreakdown(actor, 'missing', { reason: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it('does not regress a post under maintenance back to broken', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-3',
      code: 'POST-3',
      status: 'maintenance',
    });
    const service = await build(prisma, audit);

    await expect(
      service.reportMachineBreakdown(actor, 'post-3', { reason: 'повтор во время ремонта' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('serializes and revalidates a direct breakdown report on the locked post', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockImplementation(async () => ({
      id: 'post-3',
      code: 'POST-3',
      status: prisma.$queryRaw.mock.calls.length > 0 ? 'broken' : 'active',
    }));
    prisma.productionProblem.findFirst.mockResolvedValue({
      id: 'pr-existing',
      type: 'machine_breakdown',
      postId: 'post-3',
      status: 'open',
    });
    const service = await build(prisma, audit);

    await expect(
      service.reportMachineBreakdown(actor, 'post-3', { reason: 'повтор' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.post.findUnique.mock.invocationCallOrder.at(-1),
    );
    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rolls a direct breakdown report back when a required audit fact fails', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'active' });
    let committed = { postStatus: 'active', problemCount: 0 };
    let transactionClient: typeof prisma;
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      const staged = { ...committed };
      transactionClient = {
        ...prisma,
        post: {
          ...prisma.post,
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'active' }),
          update: jest.fn(async () => {
            staged.postStatus = 'broken';
            return { id: 'post-3', code: 'POST-3', status: 'broken' };
          }),
        },
        productionProblem: {
          ...prisma.productionProblem,
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(async () => {
            staged.problemCount += 1;
            return { id: 'pr-atomic', type: 'machine_breakdown', postId: 'post-3' };
          }),
        },
      };
      const result = await callback(transactionClient);
      committed = staged;
      return result;
    });
    const auditClients: unknown[] = [];
    audit.record.mockImplementation(async (input: { type: string }, client: unknown) => {
      auditClients.push(client);
      if (input.type === 'audit:machine_breakdown_confirmed') {
        throw new Error('Confirmation audit unavailable');
      }
    });
    const service = await build(prisma, audit);

    await expect(
      service.reportMachineBreakdown(actor, 'post-3', { reason: 'клин шнека' }),
    ).rejects.toThrow('Confirmation audit unavailable');

    expect(committed).toEqual({ postStatus: 'active', problemCount: 0 });
    expect(auditClients).toEqual([transactionClient, transactionClient]);
  });

  it('starts repair only from broken and completes repair back to active closing problems', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'broken' });
    prisma.post.update.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'maintenance' });
    prisma.productionProblem.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = await build(prisma, audit);

    await service.startMachineRepair(actor, 'post-3');
    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'post-3' },
      data: { status: 'maintenance' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:machine_repair_started' }),
      prisma,
    );

    prisma.post.findUnique.mockResolvedValue({
      id: 'post-3',
      code: 'POST-3',
      status: 'maintenance',
    });
    prisma.post.update.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'active' });
    await service.completeMachineRepair(actor, 'post-3', { note: 'заменен шнек' });
    expect(prisma.post.update).toHaveBeenLastCalledWith({
      where: { id: 'post-3' },
      data: { status: 'active' },
    });
    expect(prisma.productionProblem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          postId: 'post-3',
          type: 'machine_breakdown',
          status: 'open',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:machine_repaired' }),
      prisma,
    );
  });

  it('refuses to start repair on an active post', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'active' });
    const service = await build(prisma, audit);

    await expect(service.startMachineRepair(actor, 'post-3')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.completeMachineRepair(actor, 'post-3', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('startMachineRepair locks and revalidates the post before changing its state', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockImplementation(async () => ({
      id: 'post-3',
      code: 'POST-3',
      status: prisma.$queryRaw.mock.calls.length > 0 ? 'active' : 'broken',
    }));
    prisma.post.update.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'maintenance' });
    const service = await build(prisma, audit);

    await expect(service.startMachineRepair(actor, 'post-3')).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.post.findUnique.mock.invocationCallOrder.at(-1),
    );
    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('completeMachineRepair locks and revalidates before resolving breakdowns', async () => {
    const { prisma, audit } = setup();
    prisma.post.findUnique.mockImplementation(async () => ({
      id: 'post-3',
      code: 'POST-3',
      status: prisma.$queryRaw.mock.calls.length > 0 ? 'active' : 'maintenance',
    }));
    prisma.post.update.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'active' });
    const service = await build(prisma, audit);

    await expect(service.completeMachineRepair(actor, 'post-3', {})).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.post.findUnique.mock.invocationCallOrder.at(-1),
    );
    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('startMachineRepair rolls the post back when its required audit fact fails', async () => {
    const { prisma, audit } = setup();
    let committedStatus = 'broken';
    let transactionClient: typeof prisma;
    prisma.post.findUnique.mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'broken' });
    prisma.post.update.mockImplementation(async () => {
      committedStatus = 'maintenance';
      return { id: 'post-3', code: 'POST-3', status: 'maintenance' };
    });
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      let stagedStatus = committedStatus;
      transactionClient = {
        ...prisma,
        post: {
          ...prisma.post,
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'broken' }),
          update: jest.fn(async () => {
            stagedStatus = 'maintenance';
            return { id: 'post-3', code: 'POST-3', status: 'maintenance' };
          }),
        },
      };
      const result = await callback(transactionClient);
      committedStatus = stagedStatus;
      return result;
    });
    const auditClients: unknown[] = [];
    audit.record.mockImplementation(async (input: { type: string }, client: unknown) => {
      auditClients.push(client);
      if (input.type === 'audit:machine_repair_started') {
        throw new Error('Repair-start audit unavailable');
      }
    });
    const service = await build(prisma, audit);

    await expect(service.startMachineRepair(actor, 'post-3')).rejects.toThrow(
      'Repair-start audit unavailable',
    );

    expect(committedStatus).toBe('broken');
    expect(auditClients).toEqual([transactionClient]);
  });

  it('completeMachineRepair rolls post and problem resolution back when audit fails', async () => {
    const { prisma, audit } = setup();
    let committed = { postStatus: 'maintenance', openProblems: 1 };
    let transactionClient: typeof prisma;
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-3',
      code: 'POST-3',
      status: 'maintenance',
    });
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      const staged = { ...committed };
      transactionClient = {
        ...prisma,
        post: {
          ...prisma.post,
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'post-3', code: 'POST-3', status: 'maintenance' }),
          update: jest.fn(async () => {
            staged.postStatus = 'active';
            return { id: 'post-3', code: 'POST-3', status: 'active' };
          }),
        },
        productionProblem: {
          ...prisma.productionProblem,
          updateMany: jest.fn(async () => {
            staged.openProblems = 0;
            return { count: 1 };
          }),
        },
      };
      const result = await callback(transactionClient);
      committed = staged;
      return result;
    });
    const auditClients: unknown[] = [];
    audit.record.mockImplementation(async (input: { type: string }, client: unknown) => {
      auditClients.push(client);
      if (input.type === 'audit:machine_repaired') {
        throw new Error('Repair audit unavailable');
      }
    });
    const service = await build(prisma, audit);

    await expect(
      service.completeMachineRepair(actor, 'post-3', { note: 'заменен шнек' }),
    ).rejects.toThrow('Repair audit unavailable');

    expect(committed).toEqual({ postStatus: 'maintenance', openProblems: 1 });
    expect(auditClients).toEqual([transactionClient]);
  });

  it('rejects an operator breakdown claim: problem resolved, post back to active', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findUnique = jest.fn().mockResolvedValue({
      id: 'pr-b2',
      type: 'machine_breakdown',
      status: 'open',
      postId: 'post-2',
      rollId: null,
    });
    prisma.productionProblem.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.productionProblem.count.mockResolvedValue(0);
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'broken' });
    const service = await build(prisma, audit);

    await service.resolveProblem(actor, 'pr-b2', { resolution: 'reject' });

    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'post-2' },
      data: { status: 'active' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:machine_breakdown_rejected' }),
      prisma,
    );
  });

  it('confirm keeps the breakdown problem open and audits the confirmation', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findUnique = jest.fn().mockResolvedValue({
      id: 'pr-b3',
      type: 'machine_breakdown',
      status: 'open',
      postId: 'post-2',
    });
    prisma.productionProblem.updateMany = jest.fn();
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'broken' });
    const service = await build(prisma, audit);

    await service.resolveProblem(actor, 'pr-b3', { resolution: 'confirm' });

    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'resolved' }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:machine_breakdown_confirmed', objectId: 'pr-b3' }),
      prisma,
    );
  });

  it('revalidates a breakdown problem only after locking its post', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findUnique = jest.fn().mockImplementation(async () => ({
      id: 'pr-b-race',
      type: 'machine_breakdown',
      status: prisma.$queryRaw.mock.calls.length > 0 ? 'resolved' : 'open',
      postId: 'post-2',
      reason: 'клин шнека',
    }));
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'broken' });
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem(actor, 'pr-b-race', { resolution: 'confirm' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.productionProblem.update).not.toHaveBeenCalled();
    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rolls a breakdown confirmation back when its audit fact fails', async () => {
    const { prisma, audit } = setup();
    const problem = {
      id: 'pr-b-confirm-atomic',
      type: 'machine_breakdown',
      status: 'open',
      postId: 'post-2',
      reason: 'клин шнека',
      recovery: null,
    };
    let committedRecovery: string | null = null;
    let transactionClient: typeof prisma;
    prisma.productionProblem.findUnique = jest.fn().mockResolvedValue(problem);
    prisma.productionProblem.update.mockImplementation(
      async ({ data }: { data: { recovery: string } }) => {
        committedRecovery = data.recovery;
        return { ...problem, recovery: data.recovery };
      },
    );
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'broken' });
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      let stagedRecovery = committedRecovery;
      transactionClient = {
        ...prisma,
        productionProblem: {
          ...prisma.productionProblem,
          findUnique: jest.fn().mockResolvedValue(problem),
          update: jest.fn(async ({ data }: { data: { recovery: string } }) => {
            stagedRecovery = data.recovery;
            return { ...problem, recovery: data.recovery };
          }),
        },
      };
      const result = await callback(transactionClient);
      committedRecovery = stagedRecovery;
      return result;
    });
    const auditClients: unknown[] = [];
    audit.record.mockImplementation(async (input: { type: string }, client: unknown) => {
      auditClients.push(client);
      if (input.type === 'audit:machine_breakdown_confirmed') {
        throw new Error('Confirmation audit unavailable');
      }
    });
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem(actor, problem.id, { resolution: 'confirm', note: 'подтверждено' }),
    ).rejects.toThrow('Confirmation audit unavailable');

    expect(committedRecovery).toBeNull();
    expect(auditClients).toEqual([transactionClient]);
  });

  it('rolls a breakdown rejection, post activation and audit back as one fact', async () => {
    const { prisma, audit } = setup();
    const problem = {
      id: 'pr-b-reject-atomic',
      type: 'machine_breakdown',
      status: 'open',
      postId: 'post-2',
      reason: 'ложная тревога',
    };
    let committed = { problemStatus: 'open', postStatus: 'broken' };
    let transactionClient: typeof prisma;
    prisma.productionProblem.findUnique = jest.fn().mockResolvedValue(problem);
    prisma.productionProblem.updateMany.mockImplementation(async () => {
      committed.problemStatus = 'resolved';
      return { count: 1 };
    });
    prisma.productionProblem.count.mockResolvedValue(0);
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'broken' });
    prisma.post.update.mockImplementation(async () => {
      committed.postStatus = 'active';
      return { id: 'post-2', code: 'POST-2', status: 'active' };
    });
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      const staged = { ...committed };
      transactionClient = {
        ...prisma,
        productionProblem: {
          ...prisma.productionProblem,
          findUnique: jest.fn().mockResolvedValue(problem),
          updateMany: jest.fn(async () => {
            staged.problemStatus = 'resolved';
            return { count: 1 };
          }),
          count: jest.fn().mockResolvedValue(0),
        },
        post: {
          ...prisma.post,
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'broken' }),
          update: jest.fn(async () => {
            staged.postStatus = 'active';
            return { id: 'post-2', code: 'POST-2', status: 'active' };
          }),
        },
      };
      const result = await callback(transactionClient);
      committed = staged;
      return result;
    });
    const auditClients: unknown[] = [];
    audit.record.mockImplementation(async (input: { type: string }, client: unknown) => {
      auditClients.push(client);
      if (input.type === 'audit:machine_breakdown_rejected') {
        throw new Error('Rejection audit unavailable');
      }
    });
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem(actor, problem.id, { resolution: 'reject', note: 'не подтвердилось' }),
    ).rejects.toThrow('Rejection audit unavailable');

    expect(committed).toEqual({ problemStatus: 'open', postStatus: 'broken' });
    expect(auditClients).toEqual([transactionClient]);
  });

  it('does not apply rework/writeoff to a breakdown problem', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findUnique = jest.fn().mockResolvedValue({
      id: 'pr-b4',
      type: 'machine_breakdown',
      status: 'open',
      postId: 'post-2',
    });
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem(actor, 'pr-b4', { resolution: 'rework' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ProductionService general problem resolution', () => {
  const actor = { userId: 'lead-1', role: 'production_lead' as const };

  function closeHarness(
    type: 'general' | 'defect' | 'raw_material_shortage' | 'shift_balance_mismatch' = 'general',
  ) {
    const { prisma, audit } = setup();
    let stored = {
      id: `problem-${type}`,
      type,
      status: 'open',
      orderId: 'order-1',
      positionId: null,
      rollId: null,
      postId: null,
      actorRole: 'operator',
      reason: 'Остановка требует ручного разбора',
      recovery: null as string | null,
      resolvedAt: null as Date | null,
      resolvedById: null as string | null,
      createdAt: new Date('2026-07-27T08:00:00.000Z'),
    };
    prisma.productionProblem.findUnique.mockImplementation(async () => ({ ...stored }));
    prisma.productionProblem.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { id: string; status: string; type: string };
        data: { status: string; recovery: string; resolvedAt: Date; resolvedById: string };
      }) => {
        if (
          stored.id !== where.id ||
          stored.status !== where.status ||
          stored.type !== where.type
        ) {
          return { count: 0 };
        }
        stored = { ...stored, ...data };
        return { count: 1 };
      },
    );
    return { prisma, audit, stored: () => ({ ...stored }) };
  }

  it.each(['general', 'defect', 'shift_balance_mismatch'] as const)(
    'closes %s with an open-state CAS and one append-only audit fact',
    async (type) => {
      const { prisma, audit, stored } = closeHarness(type);
      const spoolStock = {
        returnDefectSpool: jest.fn().mockResolvedValue({ id: 'spool-return-1' }),
      };
      const service = await build(prisma, audit, undefined, undefined, spoolStock);

      const result = await service.resolveProblem(actor, `problem-${type}`, {
        resolution: 'close',
        note: '  Причина устранена, производство продолжено  ',
      });

      expect(prisma.productionProblem.updateMany).toHaveBeenCalledWith({
        where: { id: `problem-${type}`, type, status: 'open' },
        data: {
          status: 'resolved',
          recovery: 'Причина устранена, производство продолжено',
          resolvedAt: expect.any(Date),
          resolvedById: actor.userId,
        },
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        {
          type: 'audit:production_problem_resolved',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: `problem-${type}`,
          reason: 'Причина устранена, производство продолжено',
          oldValue: { status: 'open', recovery: null },
          newValue: {
            status: 'resolved',
            recovery: 'Причина устранена, производство продолжено',
          },
          detail: {
            problemId: `problem-${type}`,
            problemType: type,
            orderId: 'order-1',
            positionId: null,
            rollId: null,
            sourceReason: 'Остановка требует ручного разбора',
          },
        },
        prisma,
      );
      expect(result).toEqual(stored());
      expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
      expect(prisma.rawMaterialStock.upsert).not.toHaveBeenCalled();
      expect(spoolStock.returnDefectSpool).not.toHaveBeenCalled();
    },
  );

  it('returns a concurrent compatible close idempotently without a duplicate audit fact', async () => {
    const { prisma, audit } = setup();
    const opened = {
      id: 'problem-general',
      type: 'general',
      status: 'open',
      orderId: 'order-1',
      positionId: null,
      rollId: null,
      postId: null,
      actorRole: 'operator',
      reason: 'Ручной разбор',
      recovery: null,
      resolvedAt: null,
      resolvedById: null,
      createdAt: new Date('2026-07-27T08:00:00.000Z'),
    };
    const resolved = {
      ...opened,
      status: 'resolved',
      recovery: 'Работа продолжена',
      resolvedAt: new Date('2026-07-27T08:15:00.000Z'),
      resolvedById: 'lead-other',
    };
    prisma.productionProblem.findUnique
      .mockResolvedValueOnce(opened)
      .mockResolvedValueOnce(resolved);
    prisma.productionProblem.updateMany.mockResolvedValue({ count: 0 });
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem(actor, opened.id, {
        resolution: 'close',
        note: 'Работа продолжена',
      }),
    ).resolves.toEqual(resolved);

    expect(prisma.productionProblem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: opened.id, type: 'general', status: 'open' } }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   ', 'x'.repeat(1001)])(
    'rejects an unusable close note %j before any write',
    async (note) => {
      const { prisma, audit } = closeHarness();
      const service = await build(prisma, audit);

      await expect(
        service.resolveProblem(actor, 'problem-general', {
          resolution: 'close',
          note,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each(['machine_breakdown', 'raw_material_shortage'] as const)(
    'does not apply close to %s and preserves its dedicated resolution flow',
    async (type) => {
      const { prisma, audit } = setup();
      prisma.productionProblem.findUnique.mockResolvedValue({
        id: `problem-${type}`,
        type,
        status: 'open',
      });
      const service = await build(prisma, audit);

      await expect(
        service.resolveProblem(actor, `problem-${type}`, {
          resolution: 'close',
          note: 'Закрыть вручную',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('keeps an order-linked general problem open for the atomic commercial correction flow', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findUnique.mockResolvedValue({
      id: 'problem-linked-general',
      type: 'general',
      status: 'open',
      orderId: 'order-1',
      positionId: 'position-1',
      rollId: 'DEMO-001-roll-1',
    });
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem(actor, 'problem-linked-general', {
        resolution: 'close',
        note: 'Закрыть вручную',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('ProductionService.markRollDefect (визуальный контроль, дизайн 2026-07-14)', () => {
  const actor = { userId: 'lead-1', role: 'production_lead' as const };

  function defectPrisma() {
    const { prisma, audit } = setup();
    prisma.rollDispatchItem.findUnique.mockResolvedValue({
      id: 'rdi-1',
      rollCode: 'A-100-roll-1',
      status: 'ready_for_warehouse',
      productionOrder: { approvalState: 'approved', commercialOrderId: 'co-100' },
    });
    prisma.operatorRollLine.findFirst = jest.fn().mockResolvedValue({
      id: 'line-9',
      step: 'handover',
      netKg: 999,
      warehouseState: 'ready',
      rollDispatchItemId: 'rdi-1',
    });
    prisma.weightCapture.findMany.mockResolvedValue([
      {
        id: 'capture-base',
        operatorRollLineId: 'line-9',
        kind: 'roll',
        deviceId: 'scale-1',
        deviceStatus: 'ready',
        stable: true,
        grossKg: 42.5,
        spoolKg: 2,
        netKg: 40.5,
        postId: 'post-1',
        postSessionId: 'post-session-1',
        operationId: 'operation-base',
        warehouseOperationId: null,
        operation: {
          id: 'operation-base',
          action: 'roll_weight',
          status: 'succeeded',
          deviceId: 'scale-1',
          postId: 'post-1',
          postSessionId: 'post-session-1',
          resultRef: 'capture-base',
        },
        warehouseOperation: null,
        supersedesCaptureId: null,
        createdAt: new Date('2026-07-22T08:00:00.000Z'),
      },
      {
        id: 'capture-reweigh',
        operatorRollLineId: 'line-9',
        kind: 'roll',
        deviceId: 'scale-1',
        deviceStatus: 'ready',
        stable: true,
        grossKg: 43,
        spoolKg: 2,
        netKg: 41,
        postId: 'post-1',
        postSessionId: 'post-session-1',
        operationId: 'operation-reweigh',
        warehouseOperationId: null,
        operation: {
          id: 'operation-reweigh',
          action: 'roll_reweigh',
          status: 'succeeded',
          deviceId: 'scale-1',
          postId: 'post-1',
          postSessionId: 'post-session-1',
          resultRef: 'capture-reweigh',
        },
        warehouseOperation: null,
        supersedesCaptureId: 'capture-base',
        createdAt: new Date('2026-07-22T08:05:00.000Z'),
      },
    ]);
    prisma.operatorRollLine.update = jest.fn();
    prisma.defectRecord = { create: jest.fn().mockResolvedValue({ id: 'def-1' }) };
    prisma.productionProblem.findFirst = jest.fn().mockResolvedValue(null);
    prisma.productionProblem.create.mockResolvedValue({ id: 'pr-d1', type: 'defect' });
    return { prisma, audit };
  }

  it('records a blocking defect, defers the roll and opens a defect problem', async () => {
    const { prisma, audit } = defectPrisma();
    const service = await build(prisma, audit);

    const problem = await service.markRollDefect(actor, 'A-100-roll-1', {
      reason: 'полосы на пленке',
    });

    expect(prisma.defectRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operatorRollLineId: 'line-9',
          sourceRole: 'production_lead',
          blocking: true,
          comment: 'полосы на пленке',
          weightCaptureId: 'capture-reweigh',
          weightKg: 41,
        }),
      }),
    );
    expect(prisma.operatorRollLine.update).toHaveBeenCalled();
    expect(prisma.rollDispatchItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'deferred' }) }),
    );
    expect(prisma.productionProblem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'defect',
          rollId: 'A-100-roll-1',
          orderId: 'co-100',
          defectRecordId: 'def-1',
        }),
      }),
    );
    expect(audit.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'audit:defect_recorded',
        reason: 'полосы на пленке',
        detail: expect.objectContaining({
          defectId: 'def-1',
          evidenceId: 'capture-reweigh',
          weightKg: 41,
        }),
      }),
      prisma,
    );
    expect(audit.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'problem:production_defect_reported',
        actorId: 'lead-1',
        objectId: 'co-100',
        reason: 'полосы на пленке',
        oldValue: {
          dispatchStatus: 'ready_for_warehouse',
          operatorStep: 'handover',
          warehouseState: 'ready',
        },
        newValue: {
          dispatchStatus: 'deferred',
          operatorStep: 'deferred',
          warehouseState: 'not_ready',
          blocking: true,
        },
        detail: expect.objectContaining({
          problemId: 'pr-d1',
          rollId: 'A-100-roll-1',
        }),
      }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(problem).toEqual(expect.objectContaining({ id: 'pr-d1' }));
  });

  it('uses the transaction client for every read, write and required event', async () => {
    const { prisma, audit } = defectPrisma();
    const item = await prisma.rollDispatchItem.findUnique();
    const line = await prisma.operatorRollLine.findFirst();
    const captures = await prisma.weightCapture.findMany();
    prisma.rollDispatchItem.findUnique.mockClear();
    prisma.operatorRollLine.findFirst.mockClear();
    prisma.weightCapture.findMany.mockClear();
    prisma.productionProblem.findFirst.mockClear();
    const tx = {
      rollDispatchItem: {
        findUnique: jest.fn().mockResolvedValue(item),
        update: jest.fn().mockResolvedValue({}),
      },
      operatorRollLine: {
        findFirst: jest.fn().mockResolvedValue(line),
        update: jest.fn().mockResolvedValue({}),
      },
      weightCapture: {
        findMany: jest.fn().mockResolvedValue(captures),
      },
      productionProblem: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'pr-d1', type: 'defect' }),
      },
      defectRecord: { create: jest.fn().mockResolvedValue({ id: 'def-1' }) },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    const service = await build(prisma, audit);

    await service.markRollDefect(actor, 'A-100-roll-1', { reason: 'atomic defect' });

    expect(tx.rollDispatchItem.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.operatorRollLine.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.productionProblem.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.weightCapture.findMany).toHaveBeenCalledTimes(1);
    expect(tx.defectRecord.create).toHaveBeenCalledTimes(1);
    expect(tx.operatorRollLine.update).toHaveBeenCalledTimes(1);
    expect(tx.rollDispatchItem.update).toHaveBeenCalledTimes(1);
    expect(tx.productionProblem.create).toHaveBeenCalledTimes(1);
    expect(prisma.rollDispatchItem.findUnique).not.toHaveBeenCalled();
    expect(prisma.operatorRollLine.findFirst).not.toHaveBeenCalled();
    expect(prisma.weightCapture.findMany).not.toHaveBeenCalled();
    expect(prisma.productionProblem.findFirst).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.any(Object), tx);
  });

  it('rolls back every defect write when the required event fails', async () => {
    const { prisma, audit } = defectPrisma();
    const item = await prisma.rollDispatchItem.findUnique();
    const line = await prisma.operatorRollLine.findFirst();
    const captures = await prisma.weightCapture.findMany();
    const committed = { defects: 0, lineUpdates: 0, dispatchUpdates: 0, problems: 0 };
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) => {
      const staged = { ...committed };
      const tx = {
        rollDispatchItem: {
          findUnique: jest.fn().mockResolvedValue(item),
          update: jest.fn(async () => void (staged.dispatchUpdates += 1)),
        },
        operatorRollLine: {
          findFirst: jest.fn().mockResolvedValue(line),
          update: jest.fn(async () => void (staged.lineUpdates += 1)),
        },
        weightCapture: {
          findMany: jest.fn().mockResolvedValue(captures),
        },
        productionProblem: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(async () => {
            staged.problems += 1;
            return { id: 'pr-d1', type: 'defect' };
          }),
        },
        defectRecord: {
          create: jest.fn(async () => {
            staged.defects += 1;
            return { id: 'def-1' };
          }),
        },
      };
      const result = await callback(tx);
      Object.assign(committed, staged);
      return result;
    });
    audit.record.mockRejectedValue(new Error('event insert failed'));
    const service = await build(prisma, audit);

    await expect(
      service.markRollDefect(actor, 'A-100-roll-1', { reason: 'atomic defect' }),
    ).rejects.toThrow('event insert failed');

    expect(committed).toEqual({ defects: 0, lineUpdates: 0, dispatchUpdates: 0, problems: 0 });
  });

  it('maps a serializable transaction race to a stable conflict', async () => {
    const { prisma, audit } = defectPrisma();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Transaction write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    const service = await build(prisma, audit);

    await expect(
      service.markRollDefect(actor, 'A-100-roll-1', { reason: 'race' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is idempotent: second defect mark on the same roll conflicts', async () => {
    const { prisma, audit } = defectPrisma();
    prisma.productionProblem.findFirst = jest
      .fn()
      .mockResolvedValue({ id: 'pr-d1', status: 'open' });
    const service = await build(prisma, audit);

    await expect(
      service.markRollDefect(actor, 'A-100-roll-1', { reason: 'повтор' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.defectRecord.create).not.toHaveBeenCalled();
  });

  it('conflicts when the roll has not been produced yet (no operator line)', async () => {
    const { prisma, audit } = defectPrisma();
    prisma.operatorRollLine.findFirst = jest.fn().mockResolvedValue(null);
    const service = await build(prisma, audit);

    await expect(
      service.markRollDefect(actor, 'A-100-roll-1', { reason: 'нет линии' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a scalar or synthetic stable capture without a successful operation', async () => {
    const { prisma, audit } = defectPrisma();
    prisma.weightCapture.findMany.mockResolvedValue([
      {
        id: 'legacy-scalar',
        operatorRollLineId: 'line-9',
        kind: 'roll',
        deviceId: 'fake-scale',
        deviceStatus: 'ready',
        stable: true,
        grossKg: 43,
        spoolKg: 2,
        netKg: 41,
        postId: 'post-1',
        postSessionId: 'post-session-1',
        operationId: null,
        warehouseOperationId: null,
        operation: null,
        warehouseOperation: null,
        supersedesCaptureId: null,
        createdAt: new Date('2026-07-22T08:00:00.000Z'),
      },
    ]);
    const service = await build(prisma, audit);

    await expect(
      service.markRollDefect(actor, 'A-100-roll-1', { reason: 'legacy scalar' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_DEFECT_WEIGHT_EVIDENCE_REQUIRED' }),
    });

    expect(prisma.defectRecord.create).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
  });

  it('rejects a visual defect after the roll entered a terminal warehouse state', async () => {
    const { prisma, audit } = defectPrisma();
    prisma.operatorRollLine.findFirst.mockResolvedValue({
      id: 'line-9',
      step: 'warehouse',
      netKg: 41,
      warehouseState: 'received',
      rollDispatchItemId: 'rdi-1',
    });
    const service = await build(prisma, audit);

    await expect(
      service.markRollDefect(actor, 'A-100-roll-1', { reason: 'слишком поздно' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_DEFECT_ROLL_STATE_INVALID' }),
    });

    expect(prisma.defectRecord.create).not.toHaveBeenCalled();
  });
});

describe('ProductionService defect evidence projection and resolution', () => {
  const lead = { userId: 'lead-1', role: 'production_lead' as const };
  const capturedAt = new Date('2026-07-22T12:00:00.000Z');
  const physicalCapture = {
    id: 'capture-physical',
    operatorRollLineId: 'line-1',
    kind: 'roll',
    deviceId: 'scale-1',
    deviceStatus: 'ready',
    stable: true,
    grossKg: 42,
    spoolKg: 2,
    netKg: 40,
    postId: 'post-1',
    postSessionId: 'post-session-1',
    operationId: 'operation-physical',
    warehouseOperationId: null,
    operation: {
      id: 'operation-physical',
      action: 'defect',
      status: 'succeeded',
      deviceId: 'scale-1',
      postId: 'post-1',
      postSessionId: 'post-session-1',
      resultRef: 'defect-1',
    },
    warehouseOperation: null,
    createdAt: capturedAt,
  };

  it('projects exact physical provenance and keeps synthetic legacy defects visible', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findMany.mockResolvedValue([
      {
        id: 'operator-defect',
        type: 'defect',
        actorRole: 'operator',
        rollId: 'ROLL-1',
        defectRecord: {
          id: 'defect-1',
          operatorRollLineId: 'line-1',
          weightKg: 40,
          sourceRole: 'operator',
          weightCapture: physicalCapture,
          line: { rollDispatchItem: { rollCode: 'ROLL-1' } },
        },
      },
      {
        id: 'warehouse-defect',
        type: 'defect',
        actorRole: 'warehouse',
        rollId: 'WAREHOUSE-ROLL-1',
        defectRecord: {
          id: 'warehouse-defect-1',
          operatorRollLineId: 'line-1',
          weightKg: 40,
          sourceRole: 'warehouse',
          line: { rollDispatchItem: { rollCode: 'WAREHOUSE-ROLL-1' } },
          weightCapture: {
            ...physicalCapture,
            id: 'capture-control',
            kind: 'control',
            postSessionId: null,
            operationId: null,
            operation: null,
            warehouseOperationId: 'warehouse-operation-1',
            warehouseOperation: {
              id: 'warehouse-operation-1',
              kind: 'control_weight',
              status: 'succeeded',
              taskId: 'task-1',
              rollCode: 'WAREHOUSE-ROLL-1',
              deviceId: 'scale-1',
              postId: 'post-1',
              safeResult: {
                operationId: 'warehouse-operation-1',
                taskId: 'task-1',
                rollCode: 'WAREHOUSE-ROLL-1',
                grossKg: 42,
                spoolKg: 2,
                netKg: 40,
              },
            },
          },
        },
      },
      {
        id: 'production-defect',
        type: 'defect',
        actorRole: 'production_lead',
        rollId: 'ROLL-1',
        defectRecord: {
          id: 'production-defect-record-1',
          operatorRollLineId: 'line-1',
          weightKg: 40,
          sourceRole: 'production_lead',
          line: { rollDispatchItem: { rollCode: 'ROLL-1' } },
          weightCapture: {
            ...physicalCapture,
            id: 'capture-production',
            operation: {
              ...physicalCapture.operation,
              action: 'roll_weight',
              resultRef: 'capture-production',
            },
          },
        },
      },
      {
        id: 'legacy-defect',
        type: 'defect',
        actorRole: 'operator',
        rollId: 'ROLL-1',
        defectRecord: {
          id: 'legacy-defect-record',
          operatorRollLineId: 'line-1',
          weightKg: 39,
          sourceRole: 'operator',
          line: { rollDispatchItem: { rollCode: 'ROLL-1' } },
          weightCapture: { ...physicalCapture, id: 'synthetic', deviceId: null, netKg: 39 },
        },
      },
      {
        id: 'general-problem',
        type: 'general',
        actorRole: 'production_lead',
        defectRecord: null,
      },
    ]);
    const service = await build(prisma, audit);

    const result = await service.listProblems();

    expect(result).toEqual([
      expect.objectContaining({
        id: 'operator-defect',
        defectWeightKg: 40,
        defectWeightCapturedAt: capturedAt,
        defectWeightSource: 'operator_scale',
      }),
      expect.objectContaining({
        id: 'warehouse-defect',
        defectWeightKg: 40,
        defectWeightCapturedAt: capturedAt,
        defectWeightSource: 'warehouse_control_scale',
      }),
      expect.objectContaining({
        id: 'production-defect',
        defectWeightKg: 40,
        defectWeightCapturedAt: capturedAt,
        defectWeightSource: 'production_existing_scale',
      }),
      expect.objectContaining({
        id: 'legacy-defect',
        defectWeightKg: null,
        defectWeightCapturedAt: null,
        defectWeightSource: 'legacy_unverified',
      }),
      expect.objectContaining({
        id: 'general-problem',
        defectWeightKg: null,
        defectWeightCapturedAt: null,
        defectWeightSource: null,
      }),
    ]);
    expect(result.every((problem) => !('defectRecord' in problem))).toBe(true);
  });

  it('does not project genuine physical evidence linked to another roll', async () => {
    const { prisma, audit } = setup();
    prisma.productionProblem.findMany.mockResolvedValue([
      {
        id: 'mislinked-defect',
        type: 'defect',
        actorRole: 'operator',
        rollId: 'OTHER-ROLL',
        defectRecord: {
          id: 'mislinked-defect-record',
          operatorRollLineId: 'line-1',
          weightKg: 40,
          sourceRole: 'operator',
          line: { rollDispatchItem: { rollCode: 'ROLL-1' } },
          weightCapture: {
            ...physicalCapture,
            operation: {
              ...physicalCapture.operation,
              resultRef: 'mislinked-defect-record',
            },
          },
        },
      },
    ]);
    const service = await build(prisma, audit);

    await expect(service.listProblems()).resolves.toEqual([
      expect.objectContaining({
        id: 'mislinked-defect',
        defectWeightKg: null,
        defectWeightCapturedAt: null,
        defectWeightSource: 'legacy_unverified',
      }),
    ]);
  });

  function resolutionPrisma(sourceRole: 'operator' | 'warehouse' | 'production_lead' = 'operator') {
    const { prisma, audit } = setup();
    const capture = {
      ...physicalCapture,
      kind: sourceRole === 'warehouse' ? 'control' : 'roll',
    };
    const problem = {
      id: 'problem-1',
      type: 'defect',
      status: 'open',
      orderId: 'order-1',
      rollId: 'ROLL-1',
      actorRole: sourceRole,
      reason: 'Исходный дефект',
      defectRecord: {
        id: 'defect-1',
        operatorRollLineId: 'line-1',
        sourceRole,
        weightCapture:
          sourceRole === 'warehouse'
            ? {
                ...capture,
                postSessionId: null,
                operationId: null,
                operation: null,
                warehouseOperationId: 'warehouse-operation-1',
                warehouseOperation: {
                  id: 'warehouse-operation-1',
                  kind: 'control_weight',
                  status: 'succeeded',
                  taskId: 'task-1',
                  rollCode: 'ROLL-1',
                  deviceId: 'scale-1',
                  postId: 'post-1',
                  safeResult: {
                    operationId: 'warehouse-operation-1',
                    taskId: 'task-1',
                    rollCode: 'ROLL-1',
                    grossKg: 42,
                    spoolKg: 2,
                    netKg: 40,
                  },
                },
              }
            : sourceRole === 'production_lead'
              ? {
                  ...capture,
                  operation: {
                    ...capture.operation,
                    action: 'roll_weight',
                    resultRef: capture.id,
                  },
                }
              : capture,
      },
    };
    prisma.productionProblem.findUnique.mockResolvedValue(problem);
    prisma.operatorRollLine.findFirst.mockResolvedValue({
      id: 'line-1',
      rollDispatchItem: {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        rawMaterialId: 'raw-1',
      },
    });
    prisma.rollDispatchItem.update.mockResolvedValue({ id: 'dispatch-1', status: 'done' });
    prisma.productionProblem.updateMany.mockResolvedValue({ count: 1 });
    return { prisma, audit, problem };
  }

  it('recycles the exact linked whole-roll mass for every source role and resolves last', async () => {
    const { prisma, audit } = resolutionPrisma('warehouse');
    const spoolStock = {
      returnDefectSpool: jest.fn().mockResolvedValue({ id: 'spool-return-1' }),
    };
    const service = await build(prisma, audit, undefined, undefined, spoolStock);

    const result = await service.resolveProblem(
      { userId: 'lead-1', role: 'production_lead' },
      'problem-1',
      { resolution: 'writeoff', note: 'Списание подтверждено комиссией' },
    );

    expect(prisma.rawMaterialStock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { materialId: 'rm-secondary-raw-1' },
        update: {
          actualQty: { increment: 40 },
          rawMaterialDefinitionId: 'definition-secondary',
        },
        create: expect.objectContaining({
          materialId: 'rm-secondary-raw-1',
          rawMaterialDefinitionId: 'definition-secondary',
        }),
      }),
    );
    expect(prisma.rawMaterialDefinition.createMany).toHaveBeenCalledWith({
      data: [
        {
          name: 'Вторсырьё ПВД',
          normalizedName: 'вторсырьё пвд',
          kind: 'custom',
          status: 'active',
          createdById: 'lead-1',
          createdByRole: 'production_lead',
        },
      ],
      skipDuplicates: true,
    });
    expect(prisma.rollDispatchItem.update).toHaveBeenCalledWith({
      where: { id: 'dispatch-1' },
      data: { status: 'defect', completedAt: expect.any(Date) },
    });
    expect(spoolStock.returnDefectSpool).toHaveBeenCalledWith(
      { userId: 'lead-1', role: 'production_lead' },
      'defect-1',
      prisma,
    );
    expect(audit.record.mock.calls.map(([event]) => event.type)).toEqual([
      'audit:raw_material_definition_created',
      'audit:warehouse_roll_defect_recycled',
      'audit:defect_resolved_writeoff',
    ]);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'audit:defect_resolved_writeoff',
        reason: 'Списание подтверждено комиссией',
        detail: expect.objectContaining({
          defectId: 'defect-1',
          evidenceId: 'capture-physical',
          recycledKg: 40,
          note: 'Списание подтверждено комиссией',
        }),
      }),
      prisma,
    );
    expect(audit.record.mock.invocationCallOrder.at(-1)).toBeLessThan(
      prisma.productionProblem.updateMany.mock.invocationCallOrder[0],
    );
    expect(result).toEqual(
      expect.objectContaining({ status: 'resolved', replacementRollCode: null }),
    );
    expect(result).not.toHaveProperty('defectRecord');
    expect(JSON.stringify(result)).not.toContain('scale-1');
  });

  it('maps a recycling definition/link P2002 to the stable concurrency conflict', async () => {
    const { prisma, audit } = resolutionPrisma('warehouse');
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['rawMaterialDefinitionId'] },
      }),
    );
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem({ userId: 'lead-1', role: 'production_lead' }, 'problem-1', {
        resolution: 'writeoff',
        note: 'Списание подтверждено комиссией',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates at most one replacement inside the same transaction for rework', async () => {
    const { prisma, audit } = resolutionPrisma();
    const service = await build(prisma, audit);
    const replacement = jest
      .spyOn(service, 'createReplacementRoll')
      .mockResolvedValue({ rollCode: 'ROLL-1-R1' } as never);

    const result = await service.resolveProblem(lead, 'problem-1', {
      resolution: 'rework',
      note: 'Переделать рулон полностью',
    });

    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledWith(lead, 'ROLL-1', 'Переделать рулон полностью', prisma);
    expect(result).toEqual(
      expect.objectContaining({ status: 'resolved', replacementRollCode: 'ROLL-1-R1' }),
    );
  });

  it('keeps an unverified legacy defect open and performs no side effects', async () => {
    const { prisma, audit, problem } = resolutionPrisma();
    prisma.productionProblem.findUnique.mockResolvedValue({
      ...problem,
      defectRecord: { ...problem.defectRecord, weightCapture: null },
    });
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem(lead, 'problem-1', {
        resolution: 'writeoff',
        note: 'Попытка списания legacy',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_DEFECT_EVIDENCE_UNVERIFIED' }),
    });

    expect(prisma.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(prisma.rawMaterialStock.upsert).not.toHaveBeenCalled();
    expect(prisma.productionProblem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects browser-owned resolution weight even when service is called directly', async () => {
    const { prisma, audit } = resolutionPrisma();
    const service = await build(prisma, audit);

    await expect(
      service.resolveProblem(lead, 'problem-1', {
        resolution: 'writeoff',
        note: 'Списать',
        weightKg: 1,
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_DEFECT_WEIGHT_IS_DEVICE_OWNED' }),
    });

    expect(prisma.productionProblem.findUnique).not.toHaveBeenCalled();
  });
});
