import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  REQUIRED_WAREHOUSE_COVERAGE_PROJECTION_FIELDS,
  capabilitiesForRole,
  type Role,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { WarehouseCoverageCommandService } from './warehouse-coverage-command.service';
import {
  WarehouseCoverageDecisionService,
  type DecideWarehouseCoverageDto,
} from './warehouse-coverage-decision.service';
import { compareOpaqueIdsBinary } from './warehouse-coverage-canonical';

const ORDER_ID = 'order-1';
const FINANCE_ORDER_ID = 'finance-order-1';
const CALCULATION_ID = 'calculation-3';
const CLIENT_REQUEST_ID = '00000000-0000-4000-8000-000000000012';
const NOW = new Date('2026-07-25T10:00:00.000Z');

function actor(role: Role): Actor {
  return {
    userId: `${role}-1`,
    role,
    capabilities: capabilitiesForRole(role),
  };
}

function dto(
  decision: DecideWarehouseCoverageDto['decision'] = 'use_warehouse',
): DecideWarehouseCoverageDto {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    expectedGeneration: 3,
    expectedStateVersion: 5,
    decision,
  };
}

function financeRollProjection(rollCode: string, positionId: string) {
  const emptySpec = {
    filmType: null,
    actualThicknessMicron: null,
    accountingThicknessMicron: null,
    widthMm: null,
    plannedLengthM: null,
    netKg: null,
    spoolType: null,
    birka: null,
    materialLabel: null,
  };
  return {
    rollCode,
    positionId,
    source: 'legacy' as const,
    locationLabel: 'Свободный резерв',
    availability: 'available' as const,
    batchCode: null,
    receivedAt: null,
    grossKg: null,
    spoolKg: null,
    requested: { ...emptySpec },
    matched: { ...emptySpec },
  };
}

function sqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join('?') : String(query);
}

type StoredRoll = {
  id: string;
  rollCode: string;
  warehouseStatus: string;
  currentCoverageFactId: string;
  reservedForOrderId: string | null;
  reservedForPositionId: string | null;
  reservedByProposalId: string | null;
  reservedByCoverageDecisionId: string | null;
  producedForStockOrderId: string | null;
  producedForOrderId: string | null;
  reservedAt: Date | null;
};

function harness(options?: {
  workflowVersion?: number;
  currentEpoch?: bigint;
  raceOneRoll?: boolean;
  routeChangesUnderLock?: boolean;
  companyStockRollIds?: string[];
}) {
  const rollRows: StoredRoll[] = [
    {
      id: 'roll-b',
      rollCode: 'READY-002',
      warehouseStatus: 'received',
      currentCoverageFactId: 'fact-b',
      reservedForOrderId: null,
      reservedForPositionId: null,
      reservedByProposalId: null,
      reservedByCoverageDecisionId: null,
      producedForStockOrderId: options?.companyStockRollIds?.includes('roll-b')
        ? 'stock-order-1'
        : null,
      producedForOrderId: null,
      reservedAt: null,
    },
    {
      id: 'roll-a',
      rollCode: 'READY-001',
      warehouseStatus: 'received',
      currentCoverageFactId: 'fact-a',
      reservedForOrderId: null,
      reservedForPositionId: null,
      reservedByProposalId: null,
      reservedByCoverageDecisionId: null,
      producedForStockOrderId: options?.companyStockRollIds?.includes('roll-a')
        ? 'stock-order-1'
        : null,
      producedForOrderId: null,
      reservedAt: null,
    },
  ];
  const matches = [
    {
      positionId: 'position-1',
      rollId: 'roll-b',
      coverageFactId: 'fact-b',
      slotIndex: 1,
      roll: rollRows[0]!,
    },
    {
      positionId: 'position-1',
      rollId: 'roll-a',
      coverageFactId: 'fact-a',
      slotIndex: 0,
      roll: rollRows[1]!,
    },
  ];
  const store = {
    epoch: options?.currentEpoch ?? 21n,
    financeRoute: ORDER_ID,
    state: {
      orderId: ORDER_ID,
      state: 'awaiting_finance',
      stateVersion: 5,
      generation: 3,
      currentCalculationId: CALCULATION_ID,
      currentDecisionId: null as string | null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    calculation: {
      id: CALCULATION_ID,
      orderId: ORDER_ID,
      generation: 3,
      orderVersion: 7,
      positionVersions: [{ positionId: 'position-1', version: 2 }],
      orderFingerprint: 'a'.repeat(64),
      inventoryEpoch: 21n,
      inventoryFingerprint: 'b'.repeat(64),
      inputFingerprint: 'c'.repeat(64),
      algorithmVersion: 'warehouse-coverage-matching/v1',
      policyVersion: 'warehouse-coverage-policy/v2',
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      requiredRollCount: 2,
      matchedRollCount: 2,
      uncertainRollCount: 0,
      verifiedCandidateRollIds: ['roll-a', 'roll-b'],
      uncertainCandidateRollIds: [],
      systemActorKey: 'warehouse_coverage_engine',
      calculatedAt: NOW,
    },
    rolls: rollRows,
    decisions: [] as Array<Record<string, unknown>>,
    tasks: [] as Array<Record<string, unknown>>,
    scanRows: [] as Array<Record<string, unknown>>,
    commands: new Map<string, Record<string, unknown>>(),
    audits: [] as Array<Record<string, unknown>>,
    positionStatus: 'not_checked',
    orderStatus: 'not_checked',
    productionIndicator: 'not_started',
    orderVersion: 7,
  };
  const observedLocks: string[] = [];
  let racePending = options?.raceOneRoll ?? false;

  const tx = {
    $executeRaw: jest.fn().mockImplementation(async () => {
      observedLocks.push('command_advisory_key');
      return 1;
    }),
    $queryRaw: jest.fn().mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes('warehouse_coverage_inventory_epochs')) {
        observedLocks.push('inventory_epoch');
        return [{ id: 1 }];
      }
      if (text.includes('SELECT "orderId" FROM "warehouse_coverage_states"')) {
        observedLocks.push('coverage_state');
        return [{ orderId: ORDER_ID }];
      }
      if (text.includes('SELECT "id" FROM "commercial_orders"')) {
        observedLocks.push('commercial_order');
        return [{ id: ORDER_ID }];
      }
      if (text.includes('SELECT calculation."id"')) {
        observedLocks.push('current_calculation');
        return [{ id: CALCULATION_ID }];
      }
      if (text.includes('SELECT "id" FROM "warehouse_rolls"')) {
        observedLocks.push('warehouse_rolls_binary');
        return matches
          .map(({ rollId }) => ({ id: rollId }))
          .sort((left, right) => compareOpaqueIdsBinary(left.id, right.id));
      }
      throw new Error(`Unexpected coverage lock query: ${text}`);
    }),
    warehouseCoverageCommand: {
      findUnique: jest.fn(async ({ where }: { where: { clientRequestId: string } }) => {
        return store.commands.get(where.clientRequestId) ?? null;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.commands.set(String(data.clientRequestId), structuredClone(data));
        return data;
      }),
    },
    warehouseCoverageState: {
      findUnique: jest.fn(async () => ({
        ...store.state,
        currentCalculation: store.calculation,
      })),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: {
            state: string;
            stateVersion: { increment: number };
            currentDecisionId: string;
          };
        }) => {
          const matchesState =
            where.orderId === store.state.orderId &&
            where.state === store.state.state &&
            where.stateVersion === store.state.stateVersion &&
            where.generation === store.state.generation &&
            where.currentCalculationId === store.state.currentCalculationId &&
            where.currentDecisionId === store.state.currentDecisionId;
          if (!matchesState) return { count: 0 };
          store.state.state = data.state;
          store.state.stateVersion += data.stateVersion.increment;
          store.state.currentDecisionId = data.currentDecisionId;
          return { count: 1 };
        },
      ),
    },
    warehouseCoverageInventoryEpoch: {
      findUnique: jest.fn(async () => ({ epoch: store.epoch })),
    },
    financeOrder: {
      findUnique: jest.fn(async () => ({
        commercialOrderId: options?.routeChangesUnderLock ? 'order-changed' : store.financeRoute,
      })),
    },
    warehouseCoverageMatch: {
      findMany: jest.fn(async () => matches),
    },
    warehouseRoll: {
      updateMany: jest.fn(
        async ({
          data,
        }: {
          data: {
            reservedForOrderId: string;
            reservedByCoverageDecisionId: string;
            reservedAt: Date;
          };
        }) => {
          if (racePending) {
            store.rolls[1]!.reservedForOrderId = 'racing-order';
            racePending = false;
          }
          const eligible = store.rolls.filter(
            (roll) =>
              roll.warehouseStatus === 'received' &&
              roll.reservedForOrderId === null &&
              roll.reservedForPositionId === null &&
              roll.reservedByProposalId === null &&
              roll.reservedByCoverageDecisionId === null,
          );
          for (const roll of eligible) {
            Object.assign(roll, data);
          }
          store.epoch += 1n;
          return { count: eligible.length };
        },
      ),
    },
    warehouseAcceptanceTask: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.tasks.push(structuredClone(data));
        return data;
      }),
    },
    scanRow: {
      createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        store.scanRows.push(...structuredClone(data));
        return { count: data.length };
      }),
    },
    warehouseCoverageDecision: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.decisions.push(structuredClone(data));
        return data;
      }),
    },
    commercialOrderPosition: {
      updateMany: jest.fn(async ({ data }: { data: { warehouseCoverStatus: string } }) => {
        store.positionStatus = data.warehouseCoverStatus;
        return { count: 1 };
      }),
    },
    commercialOrder: {
      updateMany: jest.fn(
        async ({
          data,
        }: {
          data: {
            warehouseCoverStatus: string;
            productionIndicator: string;
            version: { increment: number };
          };
        }) => {
          store.orderStatus = data.warehouseCoverStatus;
          store.productionIndicator = data.productionIndicator;
          store.orderVersion += data.version.increment;
          return { count: 1 };
        },
      ),
    },
  };
  const transaction = {
    run: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      const snapshot = structuredClone(store);
      try {
        return await work(tx);
      } catch (error) {
        Object.assign(store, snapshot);
        throw error;
      }
    }),
  };
  const audit = {
    record: jest.fn(async (event: Record<string, unknown>) => {
      store.audits.push(structuredClone(event));
      return event;
    }),
  };
  const deliveryLockProof = Object.freeze({ proof: true });
  const fulfillment = {
    acquireDeliveryScopeLock: jest.fn(async () => {
      observedLocks.push('business_scope_advisories');
      return deliveryLockProof;
    }),
    reconcile: jest.fn().mockResolvedValue({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'incomplete',
    }),
  };
  const projections = {
    readForFinanceLocked: jest.fn(async () => ({
      workflowVersion: 2 as const,
      state: store.state.state as 'warehouse_reserved' | 'production_required',
      stateVersion: store.state.stateVersion,
      generation: 3,
      availability: 'verified_full' as const,
      reasonCodes: ['full_cover_available' as const],
      nextOwner:
        store.state.state === 'warehouse_reserved' ? ('warehouse' as const) : ('system' as const),
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 2,
      uncertainRollCount: 0,
      calculatedAt: NOW.toISOString(),
      stale: false,
      financeRolls: [
        financeRollProjection('READY-001', 'position-1'),
        financeRollProjection('READY-002', 'position-1'),
      ],
    })),
  };
  const prisma = {
    financeOrder: {
      findUnique: jest.fn(async () => ({
        commercialOrderId: ORDER_ID,
        commercialOrder: {
          warehouseCoverageWorkflowVersion: options?.workflowVersion ?? 2,
        },
      })),
    },
  };
  const service = new WarehouseCoverageDecisionService(
    prisma as never,
    audit as never,
    transaction as never,
    new WarehouseCoverageCommandService(),
    projections as never,
    fulfillment as never,
  );
  return {
    service,
    store,
    tx,
    audit,
    transaction,
    fulfillment,
    deliveryLockProof,
    projections,
    observedLocks,
  };
}

describe('WarehouseCoverageDecisionService', () => {
  it('reserves the full verified set and creates one exact scan-first task', async () => {
    const test = harness();

    const result = await test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto());

    expect(result.state).toBe('warehouse_reserved');
    expect(test.store.decisions).toHaveLength(1);
    const decision = test.store.decisions[0]!;
    expect(decision).toMatchObject({
      kind: 'use_warehouse',
      sourceInventoryEpoch: 21n,
      committedInventoryEpoch: 22n,
      expectedRollCount: 2,
      actorKind: 'user',
      actorRole: 'finance',
      actorId: 'finance-1',
    });
    expect(
      test.store.rolls
        .filter((roll) => roll.reservedByCoverageDecisionId === decision.id)
        .map(({ id }) => id)
        .sort(compareOpaqueIdsBinary),
    ).toEqual(['roll-a', 'roll-b']);
    expect(test.store.tasks).toEqual([
      expect.objectContaining({
        mode: 'reserve',
        status: 'open',
        orderId: ORDER_ID,
        positionId: null,
        proposalId: null,
        coverageDecisionId: decision.id,
      }),
    ]);
    expect(test.store.scanRows.map(({ rollCode }) => rollCode)).toEqual(['READY-001', 'READY-002']);
    expect(test.observedLocks).toEqual([
      'command_advisory_key',
      'business_scope_advisories',
      'inventory_epoch',
      'coverage_state',
      'commercial_order',
      'current_calculation',
      'warehouse_rolls_binary',
    ]);
    expect(test.store.positionStatus).toBe('full_confirmed');
    expect(test.store.orderStatus).toBe('full_confirmed');
    expect(test.store.productionIndicator).toBe('not_started');
    expect(test.fulfillment.reconcile).toHaveBeenCalledWith(
      { userId: 'finance-1', role: 'finance' },
      ORDER_ID,
      test.tx,
      test.deliveryLockProof,
    );
    expect(test.store.audits.map(({ type }) => type)).toEqual([
      'audit:warehouse_coverage_decided',
      'audit:warehouse_coverage_reserved',
    ]);
    const reservedEvent = test.store.audits[1]!;
    expect(reservedEvent.detail).toEqual({
      workflowVersion: 2,
      orderId: ORDER_ID,
      generation: 3,
      requiredRollCount: 2,
      reservedRollCount: 2,
    });
    expect(JSON.stringify(reservedEvent)).not.toMatch(/READY-|roll-[ab]|position-1/u);
  });

  it('rolls back every reservation when one roll races', async () => {
    const test = harness({ raceOneRoll: true });

    await expect(
      test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto()),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'warehouse_coverage_reservation_conflict' }),
    });

    expect(test.store.rolls.every((roll) => roll.reservedForOrderId === null)).toBe(true);
    expect(test.store.decisions).toEqual([]);
    expect(test.store.tasks).toEqual([]);
    expect(test.store.scanRows).toEqual([]);
    expect(test.store.commands.size).toBe(0);
    expect(test.store.audits).toEqual([]);
    expect(test.store.epoch).toBe(21n);
  });

  it('audits each company-stock roll consumed by the canonical finance decision', async () => {
    const test = harness({ companyStockRollIds: ['roll-a'] });

    await test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto());

    expect(test.store.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'audit:finished_stock_reserved',
          objectId: 'roll-a',
          detail: expect.objectContaining({
            orderId: ORDER_ID,
            positionId: 'position-1',
            sourceStockOrderId: 'stock-order-1',
          }),
        }),
      ]),
    );
  });

  it('produce_all writes no roll or task and removes finance actions', async () => {
    const test = harness();

    const projection = await test.service.decide(
      actor('finance'),
      FINANCE_ORDER_ID,
      dto('produce_all'),
    );

    expect(test.store.rolls.every((roll) => roll.reservedForOrderId === null)).toBe(true);
    expect(test.store.tasks).toEqual([]);
    expect(test.store.scanRows).toEqual([]);
    expect(test.store.decisions).toEqual([
      expect.objectContaining({
        kind: 'produce_all',
        committedInventoryEpoch: null,
        expectedRollCount: 0,
      }),
    ]);
    expect(projection).toMatchObject({
      state: 'production_required',
      availableActions: [],
    });
    expect(test.store.positionStatus).toBe('needs_production');
    expect(test.store.orderStatus).toBe('needs_production');
    expect(test.store.productionIndicator).toBe('needs_production');
    expect(test.store.audits.map(({ type }) => type)).toEqual(['audit:warehouse_coverage_decided']);
  });

  it.each(['warehouse', 'director', 'commercial'] as const)(
    'rejects %s without entering the transaction',
    async (role) => {
      const test = harness();

      await expect(
        test.service.decide(actor(role), FINANCE_ORDER_ID, dto()),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(test.transaction.run).not.toHaveBeenCalled();
      expect(test.store.audits).toEqual([]);
    },
  );

  it('rejects a stale generation before any material mutation', async () => {
    const test = harness();

    await expect(
      test.service.decide(actor('finance'), FINANCE_ORDER_ID, {
        ...dto(),
        expectedGeneration: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(test.store.rolls.every((roll) => roll.reservedForOrderId === null)).toBe(true);
    expect(test.store.decisions).toEqual([]);
    expect(test.store.tasks).toEqual([]);
    expect(test.store.audits).toEqual([]);
  });

  it('rejects an inventory epoch mismatch before any material mutation', async () => {
    const test = harness({ currentEpoch: 22n });

    await expect(
      test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto()),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'warehouse_coverage_inventory_changed' }),
    });

    expect(test.tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(test.store.audits).toEqual([]);
  });

  it('rejects a finance route change under the core locks', async () => {
    const test = harness({ routeChangesUnderLock: true });

    await expect(
      test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto()),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'warehouse_coverage_finance_route_changed' }),
    });

    expect(test.tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(test.store.audits).toEqual([]);
  });

  it('rejects V1 before transaction, command, reservation, or audit mutation', async () => {
    const test = harness({ workflowVersion: 1 });

    await expect(
      test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto()),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_workflow_mismatch',
        expected: 2,
        actual: 1,
      }),
    });

    expect(test.transaction.run).not.toHaveBeenCalled();
    expect(test.store.commands.size).toBe(0);
    expect(test.store.audits).toEqual([]);
  });

  it('returns an exact replay without new locks, events, or material writes', async () => {
    const test = harness();
    const first = await test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto());
    const auditCount = test.store.audits.length;
    const decisionCount = test.store.decisions.length;
    const taskCount = test.store.tasks.length;
    const lockCount = test.observedLocks.length;

    const replay = await test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto());

    expect(replay).toEqual(first);
    expect(test.store.audits).toHaveLength(auditCount);
    expect(test.store.decisions).toHaveLength(decisionCount);
    expect(test.store.tasks).toHaveLength(taskCount);
    expect(test.observedLocks).toHaveLength(lockCount);
    expect(test.fulfillment.acquireDeliveryScopeLock).toHaveBeenCalledTimes(1);
  });

  it('rejects a divergent replay before a second event or mutation', async () => {
    const test = harness();
    await test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto());
    const auditCount = test.store.audits.length;

    await expect(
      test.service.decide(actor('finance'), FINANCE_ORDER_ID, dto('produce_all')),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_command_key_conflict',
      }),
    });

    expect(test.store.audits).toHaveLength(auditCount);
    expect(test.store.decisions).toHaveLength(1);
    expect(test.store.tasks).toHaveLength(1);
  });

  it('returns only the safe finance envelope and validated finance roll rows', async () => {
    const test = harness();

    const projection = await test.service.decide(
      actor('finance'),
      FINANCE_ORDER_ID,
      dto('produce_all'),
    );

    expect(Object.keys(projection).sort()).toEqual(
      [...REQUIRED_WAREHOUSE_COVERAGE_PROJECTION_FIELDS, 'financeRolls'].sort(),
    );
    expect(Object.keys(projection.financeRolls[0]!).sort()).toEqual(
      [
        'availability',
        'batchCode',
        'grossKg',
        'locationLabel',
        'matched',
        'positionId',
        'receivedAt',
        'requested',
        'rollCode',
        'source',
        'spoolKg',
      ].sort(),
    );
    expect(JSON.stringify(projection)).not.toMatch(
      /rollId|coverageFactId|inputFingerprint|requestFingerprint|decisionId|taskId/u,
    );
  });
});
