import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { capabilitiesForRole, type UtcIsoString, type UuidString } from '@plenka/contracts';
import type { Actor } from '../src/common/auth/actor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';
import { WarehouseCoverageCalculationService } from '../src/modules/warehouse-coverage/warehouse-coverage-calculation.service';
import { WarehouseCoverageDecisionService } from '../src/modules/warehouse-coverage/warehouse-coverage-decision.service';
import { WarehouseCoverageReservationRecoveryService } from '../src/modules/warehouse-coverage/warehouse-coverage-reservation-recovery.service';

const RACE_DEADLINE_MS = 10_000;
const FACT_SPEC_VERSION = 'warehouse-roll-coverage/v1';
const SYSTEM_ACTOR_KEY = 'warehouse_coverage_engine';

type CoverageOrderFixture = {
  financeOrderId: string;
  orderId: string;
  positionId: string;
};

type CompanyStockFixture = {
  materialDefinitionId: string;
  rollId: string;
  sourceOrderId: string;
  sourcePositionId: string;
};

type SettledPair<L, R> = [PromiseSettledResult<Awaited<L>>, PromiseSettledResult<Awaited<R>>];

describe('company stock reservation race (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let calculations: WarehouseCoverageCalculationService;
  let decisions: WarehouseCoverageDecisionService;
  let recovery: WarehouseCoverageReservationRecoveryService;
  let financeActor: Actor;
  let warehouseActor: Actor;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    calculations = moduleRef.get(WarehouseCoverageCalculationService);
    decisions = moduleRef.get(WarehouseCoverageDecisionService);
    recovery = moduleRef.get(WarehouseCoverageReservationRecoveryService);
    const [user, warehouseUser] = await Promise.all([
      prisma.user.findFirstOrThrow({
        where: { role: 'finance', isActive: true },
        orderBy: { id: 'asc' },
        select: { id: true },
      }),
      prisma.user.findFirstOrThrow({
        where: { role: 'warehouse', isActive: true },
        orderBy: { id: 'asc' },
        select: { id: true },
      }),
    ]);
    financeActor = {
      userId: user.id,
      role: 'finance',
      capabilities: capabilitiesForRole('finance'),
    };
    warehouseActor = {
      userId: warehouseUser.id,
      role: 'warehouse',
      capabilities: capabilitiesForRole('warehouse'),
    };
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('serializes competing stock reservations, replays the winner and audits physical release', async () => {
    const stock = await createCompanyStock(prisma);
    const [left, right] = await Promise.all([
      createClientCoverageOrder(prisma, stock.materialDefinitionId, 'left'),
      createClientCoverageOrder(prisma, stock.materialDefinitionId, 'right'),
    ]);
    await initializeCoverage(prisma, calculations, left.orderId);
    await initializeCoverage(prisma, calculations, right.orderId);
    const [leftState, rightState] = await Promise.all([
      coverageState(prisma, left.orderId),
      coverageState(prisma, right.orderId),
    ]);

    expect(leftState).toMatchObject({
      state: 'awaiting_finance',
      currentCalculation: {
        availability: 'verified_full',
        requiredRollCount: 1,
        matchedRollCount: 1,
        matches: [{ rollId: stock.rollId }],
      },
    });
    expect(rightState).toMatchObject({
      state: 'awaiting_finance',
      currentCalculation: {
        availability: 'verified_full',
        requiredRollCount: 1,
        matchedRollCount: 1,
        matches: [{ rollId: stock.rollId }],
      },
    });

    const leftCommand = {
      clientRequestId: canonicalUuid(),
      expectedGeneration: leftState.generation,
      expectedStateVersion: leftState.stateVersion,
      decision: 'use_warehouse' as const,
    };
    const rightCommand = {
      clientRequestId: canonicalUuid(),
      expectedGeneration: rightState.generation,
      expectedStateVersion: rightState.stateVersion,
      decision: 'use_warehouse' as const,
    };
    const raced = await raceFromPostgresBarrier(
      prisma,
      () => decisions.decide(financeActor, left.financeOrderId, leftCommand),
      () => decisions.decide(financeActor, right.financeOrderId, rightCommand),
    );

    expect(raced.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(serializedErrors(raced)).not.toContain('40P01');
    const winnerIndex = raced.findIndex(({ status }) => status === 'fulfilled');
    const winner = winnerIndex === 0 ? left : right;
    const loser = winnerIndex === 0 ? right : left;
    const winningCommand = winnerIndex === 0 ? leftCommand : rightCommand;
    const winningResult = fulfilledValue(raced[winnerIndex]!);

    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { id: stock.rollId },
        select: {
          producedForStockOrderId: true,
          reservedForOrderId: true,
          reservedByCoverageDecisionId: true,
          warehouseStatus: true,
        },
      }),
    ).resolves.toEqual({
      producedForStockOrderId: stock.sourceOrderId,
      reservedForOrderId: winner.orderId,
      reservedByCoverageDecisionId: expect.any(String),
      warehouseStatus: 'received',
    });
    await expect(
      prisma.warehouseCoverageDecision.count({
        where: {
          orderId: { in: [left.orderId, right.orderId] },
          kind: 'use_warehouse',
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.warehouseRoll.count({
        where: {
          id: stock.rollId,
          OR: [{ reservedForOrderId: left.orderId }, { reservedForOrderId: right.orderId }],
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:finished_stock_reserved',
          objectId: stock.rollId,
          detail: { path: ['orderId'], equals: winner.orderId },
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:finished_stock_reserved',
          objectId: stock.rollId,
          detail: { path: ['orderId'], equals: loser.orderId },
        },
      }),
    ).resolves.toBe(0);

    const replay = await decisions.decide(financeActor, winner.financeOrderId, winningCommand);
    expect(stableJson(replay)).toBe(stableJson(winningResult));
    await expect(
      decisions.decide(financeActor, winner.financeOrderId, {
        ...winningCommand,
        decision: 'produce_all',
      }),
    ).rejects.toMatchObject({
      response: { code: 'warehouse_coverage_command_key_conflict' },
    });
    await expect(
      prisma.warehouseCoverageCommand.count({
        where: { clientRequestId: winningCommand.clientRequestId },
      }),
    ).resolves.toBe(1);

    const reservedState = await prisma.warehouseCoverageState.findUniqueOrThrow({
      where: { orderId: winner.orderId },
      select: {
        stateVersion: true,
        generation: true,
        currentDecisionId: true,
      },
    });
    const task = await prisma.warehouseAcceptanceTask.findFirstOrThrow({
      where: { coverageDecisionId: reservedState.currentDecisionId },
      select: {
        id: true,
        updatedAt: true,
        rows: {
          orderBy: { id: 'asc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    await recovery.reportPhysicalException(warehouseActor, task.id, {
      clientRequestId: canonicalUuid(),
      expectedGeneration: reservedState.generation,
      expectedStateVersion: reservedState.stateVersion,
      expectedTaskUpdatedAt: task.updatedAt.toISOString() as UtcIsoString,
      scanRowId: task.rows[0]!.id,
      kind: 'damaged',
      reason: 'Stock release regression',
    });

    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { id: stock.rollId },
        select: {
          reservedForOrderId: true,
          reservedByCoverageDecisionId: true,
        },
      }),
    ).resolves.toEqual({
      reservedForOrderId: null,
      reservedByCoverageDecisionId: null,
    });
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:finished_stock_reservation_released',
          objectId: stock.rollId,
          detail: {
            path: ['sourceStockOrderId'],
            equals: stock.sourceOrderId,
          },
        },
      }),
    ).resolves.toBe(1);
  });
});

async function createCompanyStock(prisma: PrismaService): Promise<CompanyStockFixture> {
  const suffix = randomUUID().replaceAll('-', '');
  const materialDefinitionId = `stock-race-material-${suffix}`;
  await prisma.rawMaterialDefinition.create({
    data: {
      id: materialDefinitionId,
      name: `Stock race material ${suffix}`,
      normalizedName: `stock race material ${suffix}`,
      kind: 'base',
      status: 'active',
      createdByRole: 'admin',
    },
  });
  const sourceOrder = await prisma.commercialOrder.create({
    data: {
      orderNumber: `S-RACE-${suffix}`,
      stockBatchCode: `STOCK-S-RACE-${suffix}`,
      requestType: 'stock_reserve',
      title: `Company stock ${suffix}`,
      creatorRole: 'commercial',
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'in_work',
      productionIndicator: 'ready',
      paymentStatus: 'not_applicable',
      shipmentStatus: 'not_applicable',
      positions: {
        create: {
          rollCount: 1,
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1_000,
          plannedLengthM: 100,
          baseRawMaterialDefinitionId: materialDefinitionId,
          spoolType: '76 мм',
          birka: 'Company stock race',
          plannedWeightKg: 40,
          recipe: {
            create: {
              parameters: [],
              source: 'stock_race_e2e',
              createdBy: SYSTEM_ACTOR_KEY,
              version: 'v1',
              ingredients: [
                {
                  rawMaterialDefinitionId: materialDefinitionId,
                  shareBasisPoints: 10_000,
                },
              ],
            },
          },
        },
      },
    },
    include: { positions: { include: { recipe: true } } },
  });
  const sourcePosition = sourceOrder.positions[0]!;
  const rollCode = `STOCK-RACE-ROLL-${suffix}`;
  const roll = await prisma.warehouseRoll.create({
    data: {
      rollCode,
      ownerCounterpartyId: null,
      producedForStockOrderId: sourceOrder.id,
      warehouseStatus: 'received',
      receivedAt: new Date(),
    },
  });
  const spec = canonicalizeRollCoverageSpec({
    rollCode,
    sourceOrderId: sourceOrder.id,
    sourcePositionId: sourcePosition.id,
    ownerCounterpartyId: null,
    filmType: 'Полотно',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 80_000,
    widthMilliMm: 1_000_000,
    plannedLengthMilliM: 100_000,
    birka: 'Company stock race',
    spoolType: '76 мм',
    actualWeightMilliKg: 40_000,
    plannedWeightMilliKg: 40_000,
    recipeId: sourcePosition.recipe?.id ?? null,
    recipeVersion: 'v1',
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    ingredients: [
      {
        rawMaterialDefinitionId: materialDefinitionId,
        shareBasisPoints: 10_000,
      },
    ],
    policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
  });
  const fact = await prisma.warehouseRollCoverageFact.create({
    data: {
      rollId: roll.id,
      version: 1,
      source: 'migration_backfill',
      specVersion: FACT_SPEC_VERSION,
      specFingerprint: fingerprintRollFact(spec),
      spec: spec as unknown as Prisma.InputJsonValue,
      sourceOrderId: sourceOrder.id,
      sourcePositionId: sourcePosition.id,
      actorKind: 'system',
      systemActorKey: SYSTEM_ACTOR_KEY,
    },
  });
  await prisma.warehouseRoll.update({
    where: { id: roll.id },
    data: { currentCoverageFactId: fact.id },
  });
  return {
    materialDefinitionId,
    rollId: roll.id,
    sourceOrderId: sourceOrder.id,
    sourcePositionId: sourcePosition.id,
  };
}

async function createClientCoverageOrder(
  prisma: PrismaService,
  materialDefinitionId: string,
  label: string,
): Promise<CoverageOrderFixture> {
  const suffix = randomUUID().replaceAll('-', '');
  const counterparty = await prisma.counterparty.create({
    data: { displayName: `Stock race ${label} ${suffix}` },
  });
  const order = await prisma.commercialOrder.create({
    data: {
      orderNumber: `A-RACE-${label}-${suffix}`,
      title: `Stock race ${label}`,
      creatorRole: 'commercial',
      counterpartyId: counterparty.id,
      warehouseCoverageWorkflowVersion: 2,
      commercialStage: 'sent_to_finance',
      sentToFinanceAt: new Date(),
      positions: {
        create: {
          rollCount: 1,
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1_000,
          plannedLengthM: 100,
          baseRawMaterialDefinitionId: materialDefinitionId,
          spoolType: '76 мм',
          birka: 'Company stock race',
          plannedWeightKg: 40,
          recipe: {
            create: {
              parameters: [],
              source: 'stock_race_e2e',
              createdBy: SYSTEM_ACTOR_KEY,
              version: 'v1',
              ingredients: [
                {
                  rawMaterialDefinitionId: materialDefinitionId,
                  shareBasisPoints: 10_000,
                },
              ],
            },
          },
        },
      },
      financeOrder: {
        create: {
          invoiceStatus: 'invoiced',
          paymentStatus: 'unpaid',
          paymentTermsType: 'postpay_100_30d',
          sourceStatus: 'ready',
          invoiceIssuedAt: new Date(),
        },
      },
      coverageState: {
        create: {
          state: 'calculating',
          stateVersion: 1,
          generation: 0,
        },
      },
    },
    include: {
      positions: { select: { id: true } },
      financeOrder: { select: { id: true } },
    },
  });
  return {
    financeOrderId: order.financeOrder!.id,
    orderId: order.id,
    positionId: order.positions[0]!.id,
  };
}

async function initializeCoverage(
  prisma: PrismaService,
  calculations: WarehouseCoverageCalculationService,
  orderId: string,
): Promise<void> {
  await prisma.$transaction((tx) => calculations.initializeAtInvoiceHandoff(tx, orderId));
}

function coverageState(prisma: PrismaService, orderId: string) {
  return prisma.warehouseCoverageState.findUniqueOrThrow({
    where: { orderId },
    select: {
      state: true,
      stateVersion: true,
      generation: true,
      currentCalculation: {
        select: {
          availability: true,
          requiredRollCount: true,
          matchedRollCount: true,
          matches: { select: { rollId: true } },
        },
      },
    },
  });
}

function canonicalUuid(): UuidString {
  return randomUUID() as UuidString;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

function errorEvidence(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const candidate = error as {
    code?: unknown;
    getResponse?: () => unknown;
    message?: unknown;
    response?: unknown;
  };
  return stableJson({
    code: candidate.code,
    message: candidate.message,
    response:
      typeof candidate.getResponse === 'function' ? candidate.getResponse() : candidate.response,
  });
}

function serializedErrors(settled: readonly PromiseSettledResult<unknown>[]): string {
  return settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => errorEvidence(result.reason))
    .join('\n');
}

function fulfilledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status !== 'fulfilled') throw result.reason;
  return result.value;
}

async function withStrictRaceDeadline<T>(operation: () => Promise<T>): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`PostgreSQL race exceeded ${RACE_DEADLINE_MS} ms`)),
          RACE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

async function raceFromPostgresBarrier<L, R>(
  observer: PrismaService,
  left: () => Promise<L>,
  right: () => Promise<R>,
): Promise<SettledPair<L, R>> {
  const marker = `stock_race_${randomUUID().replaceAll('-', '')}`;
  const keySeed = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  const keys = [keySeed, keySeed + 1n] as const;
  const coordinator = new PrismaClient();
  const participants = [new PrismaClient(), new PrismaClient()] as const;
  let releaseCoordinator!: () => void;
  let reportCoordinatorReady!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseCoordinator = resolve;
  });
  const coordinatorReady = new Promise<void>((resolve) => {
    reportCoordinatorReady = resolve;
  });
  const held = coordinator.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1)', keys[0]);
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1)', keys[1]);
    reportCoordinatorReady();
    await release;
  });
  const enter = async (client: PrismaClient, key: bigint, side: string): Promise<void> => {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT set_config($1, $2, true)',
        'application_name',
        `${marker}_${side}`,
      );
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1)', key);
    });
  };

  try {
    await withStrictRaceDeadline(() => coordinatorReady);
    const leftResult = enter(participants[0], keys[0], 'left').then(left);
    const rightResult = enter(participants[1], keys[1], 'right').then(right);
    await waitForAdvisoryWaiters(observer, marker);
    releaseCoordinator();
    const settled = await withStrictRaceDeadline(() =>
      Promise.allSettled([leftResult, rightResult]),
    );
    await held;
    return settled as SettledPair<L, R>;
  } finally {
    releaseCoordinator();
    await Promise.allSettled([
      held,
      coordinator.$disconnect(),
      participants[0].$disconnect(),
      participants[1].$disconnect(),
    ]);
  }
}

async function waitForAdvisoryWaiters(prisma: PrismaService, marker: string): Promise<void> {
  await withStrictRaceDeadline(async () => {
    for (;;) {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE application_name LIKE ${`${marker}_%`}
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `);
      if (rows[0]?.count === 2) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}
