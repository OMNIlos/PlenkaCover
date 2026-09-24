import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { capabilitiesForRole, type Role, type UuidString } from '@plenka/contracts';
import type { Actor } from '../src/common/auth/actor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';
import { WarehouseCoverageCalculationService } from '../src/modules/warehouse-coverage/warehouse-coverage-calculation.service';
import { WarehouseCoverageDecisionService } from '../src/modules/warehouse-coverage/warehouse-coverage-decision.service';
import { WarehouseCoverageProductionHandoffService } from '../src/modules/warehouse-coverage/warehouse-coverage-production-handoff.service';
import { WarehouseCoverageRecheckService } from '../src/modules/warehouse-coverage/warehouse-coverage-recheck.service';
import { WarehouseCoverageReservationRecoveryService } from '../src/modules/warehouse-coverage/warehouse-coverage-reservation-recovery.service';
import {
  coverageCommandAdvisoryKey,
  lockCoverageResources,
  runCoverageSerializable,
} from '../src/modules/warehouse-coverage/warehouse-coverage-transaction';
import { WarehouseIntakeIntegrityService } from '../src/modules/warehouse/warehouse-intake-integrity.service';

const RACE_DEADLINE_MS = 5_000;
const SYSTEM_ACTOR_KEY = 'warehouse_coverage_engine';
const FACT_SPEC_VERSION = 'warehouse-roll-coverage/v1';

type SettledPair<L, R> = [PromiseSettledResult<Awaited<L>>, PromiseSettledResult<Awaited<R>>];

interface CoverageFixture {
  birka: string;
  counterpartyId: string;
  financeOrderId: string;
  materialDefinitionId: string;
  orderId: string;
  positionId: string;
  rollIds: string[];
}

function actor(role: Role, userId = `task21-${role}`): Actor {
  return {
    userId,
    role,
    capabilities: capabilitiesForRole(role),
  };
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
  if (error && typeof error === 'object') {
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
  return String(error);
}

function serializedErrors(settled: readonly PromiseSettledResult<unknown>[]): string {
  return settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => errorEvidence(result.reason))
    .join('\n');
}

async function withStrictRaceDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs = RACE_DEADLINE_MS,
): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`PostgreSQL race exceeded ${deadlineMs} ms`)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

/**
 * Opens two independent PostgreSQL advisory-lock gates, observes both waiters in
 * pg_stat_activity, then releases both keys in one commit. The lock observation is
 * the start barrier; timers are used only as a hard failure deadline.
 */
async function raceFromPostgresBarrier<L, R>(
  observer: PrismaService,
  left: () => Promise<L>,
  right: () => Promise<R>,
): Promise<SettledPair<L, R>> {
  const marker = `task21_${randomUUID().replaceAll('-', '')}`;
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
    await waitForAdvisoryWaiters(observer, marker, 2);
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

async function waitForAdvisoryWaiters(
  prisma: PrismaService,
  marker: string,
  expected: number,
): Promise<void> {
  await withStrictRaceDeadline(async () => {
    for (;;) {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE application_name LIKE ${`${marker}_%`}
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `);
      if (rows[0]?.count === expected) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}

describe('warehouse coverage V2 races (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let calculations: WarehouseCoverageCalculationService;
  let decisions: WarehouseCoverageDecisionService;
  let rechecks: WarehouseCoverageRecheckService;
  let recovery: WarehouseCoverageReservationRecoveryService;
  let production: WarehouseCoverageProductionHandoffService;
  let legacyIntake: WarehouseIntakeIntegrityService;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    calculations = moduleRef.get(WarehouseCoverageCalculationService);
    decisions = moduleRef.get(WarehouseCoverageDecisionService);
    rechecks = moduleRef.get(WarehouseCoverageRecheckService);
    recovery = moduleRef.get(WarehouseCoverageReservationRecoveryService);
    production = moduleRef.get(WarehouseCoverageProductionHandoffService);
    legacyIntake = moduleRef.get(WarehouseIntakeIntegrityService);
    await seedRaceActors(prisma);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('allows only one of two finance orders to reserve the same roll', async () => {
    const shared = await createCoverageFixture(prisma, {
      label: 'shared-reservation-left',
      rollCount: 1,
    });
    const contender = await createCoverageFixture(prisma, {
      label: 'shared-reservation-right',
      rollCount: 1,
      sharedCoverage: shared,
    });
    await initializeCoverage(prisma, calculations, shared.orderId);
    await initializeCoverage(prisma, calculations, contender.orderId);
    const leftState = await currentState(prisma, shared.orderId);
    const rightState = await currentState(prisma, contender.orderId);

    const settled = await raceFromPostgresBarrier(
      prisma,
      () =>
        decisions.decide(actor('finance'), shared.financeOrderId, {
          clientRequestId: canonicalUuid(),
          expectedGeneration: leftState.generation,
          expectedStateVersion: leftState.stateVersion,
          decision: 'use_warehouse',
        }),
      () =>
        decisions.decide(actor('finance'), contender.financeOrderId, {
          clientRequestId: canonicalUuid(),
          expectedGeneration: rightState.generation,
          expectedStateVersion: rightState.stateVersion,
          decision: 'use_warehouse',
        }),
    );

    expect(settled.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(serializedErrors(settled)).not.toContain('40P01');
    expect(
      await decisionsUsingRoll(prisma, shared.rollIds[0]!, [shared.orderId, contender.orderId]),
    ).toHaveLength(1);
    expect(await partialDecisionSets(prisma, [shared.orderId, contender.orderId])).toEqual([]);
  });

  it('leaves no orphan generation when epoch changes during refresh', async () => {
    const fixture = await createCoverageFixture(prisma, {
      label: 'refresh-inventory',
      rollCount: 1,
    });
    await initializeCoverage(prisma, calculations, fixture.orderId);
    const state = await currentState(prisma, fixture.orderId);

    const settled = await raceFromPostgresBarrier(
      prisma,
      () =>
        calculations.refreshForFinance(actor('finance'), fixture.financeOrderId, {
          clientRequestId: canonicalUuid(),
          expectedGeneration: state.generation,
          expectedStateVersion: state.stateVersion,
        }),
      () =>
        prisma.warehouseRoll.update({
          where: { id: fixture.rollIds[0]! },
          data: { warehouseStatus: 'received' },
        }),
    );

    expect(serializedErrors(settled)).not.toContain('40P01');
    expect(await orphanCalculationCount(prisma, fixture.orderId)).toBe(0);
    expect(await currentStateReferencesValid(prisma, fixture.orderId)).toBe(true);
  });

  it('cancels every reserved roll after a raced physical exception', async () => {
    const fixture = await reservedFixture(prisma, calculations, decisions, 'physical-race');
    const context = await recoveryContext(prisma, fixture.orderId);
    const clientRequestId = canonicalUuid();
    const command = physicalExceptionCommand(context, clientRequestId);

    const responses = await raceFromPostgresBarrier(
      prisma,
      () => recovery.reportPhysicalException(actor('warehouse'), context.taskId, command),
      () => recovery.reportPhysicalException(actor('warehouse'), context.taskId, command),
    );

    expect(serializedErrors(responses)).toBe('');
    expect(responses.every(({ status }) => status === 'fulfilled')).toBe(true);
    const left = fulfilledValue(responses[0]);
    const right = fulfilledValue(responses[1]);
    expect(stableJson(left)).toBe(stableJson(right));
    expect(left).toMatchObject({ caseId: expect.any(String) });
    expect(await reservedDecisionRollIds(prisma, context.decisionId)).toEqual([]);
    expect(await openPhysicalExceptionCases(prisma, fixture.orderId)).toHaveLength(1);
    expect(await cancellationCommandCount(prisma, context.decisionId)).toBe(1);
  });

  it('replays one UUID byte-equivalently and rejects divergent payload or actor', async () => {
    const fixture = await createCoverageFixture(prisma, {
      label: 'recheck-replay',
      rollCount: 1,
    });
    await initializeCoverage(prisma, calculations, fixture.orderId);
    const initial = await currentState(prisma, fixture.orderId);
    const clientRequestId = canonicalUuid();
    const command = {
      clientRequestId,
      expectedGeneration: initial.generation,
      expectedStateVersion: initial.stateVersion,
      reason: 'Требуется контрольная перепроверка склада',
    };
    const financeActor = actor('finance');

    const raced = await raceFromPostgresBarrier(
      prisma,
      () => rechecks.requestFromFinance(financeActor, fixture.financeOrderId, command),
      () => rechecks.requestFromFinance(financeActor, fixture.financeOrderId, command),
    );

    expect(serializedErrors(raced)).toBe('');
    expect(raced.every(({ status }) => status === 'fulfilled')).toBe(true);
    const left = fulfilledValue(raced[0]);
    const right = fulfilledValue(raced[1]);
    expect(stableJson(left)).toBe(stableJson(right));
    expect(left.caseId).toBe(right.caseId);
    expect(await finalCommandCount(prisma, clientRequestId)).toBe(1);
    expect(await requestRecheckEventCount(prisma, fixture.orderId)).toBe(1);
    const stateBeforeDivergence = await currentState(prisma, fixture.orderId);

    await expect(
      rechecks.requestFromFinance(financeActor, fixture.financeOrderId, {
        ...command,
        reason: 'Совершенно другая причина перепроверки',
      }),
    ).rejects.toMatchObject({
      response: { code: 'warehouse_coverage_command_key_conflict' },
    });
    await expect(
      rechecks.requestFromFinance(
        actor('finance', 'task21-finance-alt'),
        fixture.financeOrderId,
        command,
      ),
    ).rejects.toMatchObject({
      response: { code: 'warehouse_coverage_command_key_conflict' },
    });
    expect((await currentState(prisma, fixture.orderId)).stateVersion).toBe(
      stateBeforeDivergence.stateVersion,
    );
  });

  it('settles refresh versus decide without a deadlock or partial generation', async () => {
    const fixture = await createCoverageFixture(prisma, {
      label: 'refresh-decide',
      rollCount: 1,
    });
    await initializeCoverage(prisma, calculations, fixture.orderId);
    const state = await currentState(prisma, fixture.orderId);

    const settled = await raceFromPostgresBarrier(
      prisma,
      () =>
        calculations.refreshForFinance(actor('finance'), fixture.financeOrderId, {
          clientRequestId: canonicalUuid(),
          expectedGeneration: state.generation,
          expectedStateVersion: state.stateVersion,
        }),
      () =>
        decisions.decide(actor('finance'), fixture.financeOrderId, {
          clientRequestId: canonicalUuid(),
          expectedGeneration: state.generation,
          expectedStateVersion: state.stateVersion,
          decision: 'use_warehouse',
        }),
    );

    expect(serializedErrors(settled)).not.toContain('40P01');
    expect(await orphanCalculationCount(prisma, fixture.orderId)).toBe(0);
    expect(await partialDecisionSets(prisma, [fixture.orderId])).toEqual([]);
    expect(await currentStateReferencesValid(prisma, fixture.orderId)).toBe(true);
  });

  it('settles resolve-recheck versus production without a deadlock', async () => {
    const fixture = await createCoverageFixture(prisma, {
      label: 'resolve-production',
      rollCount: 1,
      availableRolls: 0,
    });
    await initializeCoverage(prisma, calculations, fixture.orderId);
    const beforeRequest = await currentState(prisma, fixture.orderId);
    const requested = await rechecks.requestFromFinance(actor('finance'), fixture.financeOrderId, {
      clientRequestId: canonicalUuid(),
      expectedGeneration: beforeRequest.generation,
      expectedStateVersion: beforeRequest.stateVersion,
      reason: 'Склад должен подтвердить отсутствие подходящих рулонов',
    });
    const resolutionCase = await prisma.orderResolutionCase.findUniqueOrThrow({
      where: { id: requested.caseId },
      select: { id: true, version: true },
    });
    const state = await currentState(prisma, fixture.orderId);

    const settled = await raceFromPostgresBarrier(
      prisma,
      () =>
        rechecks.resolveFromWarehouse(actor('warehouse'), resolutionCase.id, {
          clientRequestId: canonicalUuid(),
          expectedCaseVersion: resolutionCase.version,
          expectedGeneration: state.generation,
          expectedStateVersion: state.stateVersion,
          reason: 'Подходящих рулонов на складе действительно нет',
          corrections: [],
        }),
      () => production.createV2ProductionOrder(actor('commercial'), fixture.orderId),
    );

    expect(serializedErrors(settled)).not.toContain('40P01');
    expect(await validCurrentPointerCount(prisma, fixture.orderId)).toBe(1);
    expect(await invalidProductionProvenanceCount(prisma, fixture.orderId)).toBe(0);
  });

  it('settles physical recovery against a legacy intake attempt without lock inversion', async () => {
    const fixture = await reservedFixture(prisma, calculations, decisions, 'recovery-legacy');
    const context = await recoveryContext(prisma, fixture.orderId);
    const command = physicalExceptionCommand(context, canonicalUuid());

    const settled = await raceFromPostgresBarrier(
      prisma,
      () => recovery.reportPhysicalException(actor('warehouse'), context.taskId, command),
      () =>
        legacyIntake.scan(actor('warehouse'), context.taskId, {
          operationKey: randomUUID(),
          payload: `prt_${'a'.repeat(64)}`,
        }),
    );

    expect(serializedErrors(settled)).not.toContain('40P01');
    expect(await cancellationCommandCount(prisma, context.decisionId)).toBe(1);
    expect(await legacyMutationCount(prisma, context.taskId)).toBe(0);
  });

  it('uses the global hierarchy and short-circuits replays at the command lock', async () => {
    const calculationFixture = await createCoverageFixture(prisma, {
      label: 'lock-calculation',
      rollCount: 1,
    });
    await initializeCoverage(prisma, calculations, calculationFixture.orderId);
    const calculationState = await currentState(prisma, calculationFixture.orderId);
    if (!calculationState.currentCalculationId) {
      throw new Error('Calculation lock fixture has no calculation');
    }
    const financeCase = await createFinanceLockCase(
      prisma,
      calculationFixture.orderId,
      calculationState.currentCalculationId,
      calculationState.stateVersion,
    );
    const productionFixture = await createCoverageFixture(prisma, {
      label: 'lock-production',
      rollCount: 1,
      availableRolls: 0,
    });
    await initializeCoverage(prisma, calculations, productionFixture.orderId);
    const productionState = await currentState(prisma, productionFixture.orderId);
    if (!productionState.currentCalculationId || !productionState.currentDecisionId) {
      throw new Error('Production lock fixture has no auto decision');
    }
    const fixture = await reservedFixture(prisma, calculations, decisions, 'lock-hierarchy');
    const context = await recoveryContext(prisma, fixture.orderId);
    const physicalCase = await createPhysicalLockCase(
      prisma,
      fixture.orderId,
      context.calculationId,
      context.decisionId,
      context.stateVersion,
    );
    const paths = [
      {
        name: 'Task 10 refresh',
        targets: {
          clientRequestId: canonicalUuid(),
          orderId: calculationFixture.orderId,
          calculationId: calculationState.currentCalculationId,
          rollIds: calculationFixture.rollIds,
        },
        expected: [
          'command_advisory_key',
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
          'current_calculation',
          'warehouse_rolls_binary',
        ],
      },
      {
        name: 'Task 12 finance decision',
        targets: {
          clientRequestId: canonicalUuid(),
          orderId: calculationFixture.orderId,
          calculationId: calculationState.currentCalculationId,
          rollIds: calculationFixture.rollIds,
        },
        expected: [
          'command_advisory_key',
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
          'current_calculation',
          'warehouse_rolls_binary',
        ],
      },
      {
        name: 'Task 13 finance recheck and warehouse resolution',
        targets: {
          clientRequestId: canonicalUuid(),
          orderId: calculationFixture.orderId,
          calculationId: calculationState.currentCalculationId,
          caseId: financeCase.id,
          rollIds: calculationFixture.rollIds,
        },
        expected: [
          'command_advisory_key',
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
          'current_calculation',
          'recheck_case',
          'warehouse_rolls_binary',
        ],
      },
      {
        name: 'Task 14 production handoff',
        targets: {
          orderId: productionFixture.orderId,
          calculationId: productionState.currentCalculationId,
          decisionId: productionState.currentDecisionId,
          rollIds: [],
        },
        expected: [
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
          'current_calculation',
          'current_decision',
        ],
      },
      {
        name: 'Task 15 physical recovery',
        targets: {
          clientRequestId: canonicalUuid(),
          orderId: fixture.orderId,
          calculationId: context.calculationId,
          decisionId: context.decisionId,
          caseId: physicalCase.id,
          taskId: context.taskId,
          scanRowId: context.scanRowId,
          rollIds: fixture.rollIds,
        },
        expected: [
          'command_advisory_key',
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
          'current_calculation',
          'current_decision',
          'recheck_case',
          'warehouse_task',
          'scan_row',
          'warehouse_rolls_binary',
        ],
      },
    ] as const;
    for (const path of paths) {
      const observed = await prisma.$transaction((tx) => lockCoverageResources(tx, path.targets));
      expect({ name: path.name, levels: observed.acquiredLevels }).toEqual({
        name: path.name,
        levels: path.expected,
      });
    }

    const decisionCommand = await prisma.warehouseCoverageCommand.findFirstOrThrow({
      where: { orderId: fixture.orderId, kind: 'decide' },
      select: { clientRequestId: true, safeResult: true },
    });
    const decisionStateVersion = context.stateVersion - 1;
    const commandLock = await holdCommandAdvisory(decisionCommand.clientRequestId as UuidString);
    const releaseEpoch = await holdEpochRow(prisma);
    const replayLocks: string[] = [];
    try {
      const replayPromise = decisions.decide(actor('finance'), fixture.financeOrderId, {
        clientRequestId: decisionCommand.clientRequestId as UuidString,
        expectedGeneration: context.generation,
        expectedStateVersion: decisionStateVersion,
        decision: 'use_warehouse',
      });
      await waitForBackendBlockedBy(prisma, commandLock.backendPid);
      replayLocks.push('command_advisory_key');
      await commandLock.release();
      const replay = await withStrictRaceDeadline(() => replayPromise);
      expect(stableJson(replay)).toBe(stableJson(decisionCommand.safeResult));
      expect(replayLocks).toEqual(['command_advisory_key']);
    } finally {
      await commandLock.release();
      await releaseEpoch();
    }
  });

  it('maps exhausted retry after three attempts and two injected sleeps', async () => {
    let attempts = 0;
    let sleepCount = 0;

    const result = await runCoverageSerializable(
      prisma,
      async (tx) => {
        attempts += 1;
        await tx.$executeRawUnsafe(
          `DO $$
           BEGIN
             RAISE EXCEPTION 'task21 injected serialization failure'
               USING ERRCODE = '40001';
           END
           $$`,
        );
      },
      {
        random: () => 0,
        sleep: async () => {
          sleepCount += 1;
        },
      },
    ).then(
      () => ({ attempts, sleepCount, code: 'unexpected_success' }),
      (error: unknown) => {
        const response =
          error && typeof error === 'object' && 'getResponse' in error
            ? (error as { getResponse(): { code?: string } }).getResponse()
            : {};
        return { attempts, sleepCount, code: response.code };
      },
    );

    expect(result).toEqual({
      attempts: 3,
      sleepCount: 2,
      code: 'warehouse_coverage_concurrent_state_conflict',
    });
  });
});

async function seedRaceActors(prisma: PrismaService): Promise<void> {
  const actors = [
    { id: 'task21-finance', role: 'finance' as const },
    { id: 'task21-finance-alt', role: 'finance' as const },
    { id: 'task21-warehouse', role: 'warehouse' as const },
    { id: 'task21-commercial', role: 'commercial' as const },
  ];
  for (const entry of actors) {
    await prisma.user.upsert({
      where: { id: entry.id },
      update: { role: entry.role },
      create: {
        id: entry.id,
        externalId: entry.id,
        login: entry.id,
        displayName: entry.id,
        role: entry.role,
        isActive: true,
        mustChangePassword: false,
      },
    });
  }
}

async function createCoverageFixture(
  prisma: PrismaService,
  options: {
    availableRolls?: number;
    label: string;
    rollCount: number;
    sharedCoverage?: CoverageFixture;
  },
): Promise<CoverageFixture> {
  const suffix = randomUUID().replaceAll('-', '');
  const shared = options.sharedCoverage;
  const counterpartyId = shared?.counterpartyId ?? `task21-counterparty-${suffix}`;
  const materialDefinitionId = shared?.materialDefinitionId ?? `task21-material-${suffix}`;
  const orderId = `task21-order-${suffix}`;
  const positionId = `task21-position-${suffix}`;
  const financeOrderId = `task21-finance-${suffix}`;
  const birka = shared?.birka ?? `Task21 ${options.label} ${suffix}`;

  if (!shared) {
    await prisma.counterparty.create({
      data: {
        id: counterpartyId,
        displayName: `Task21 ${options.label}`,
      },
    });
    await prisma.rawMaterialDefinition.create({
      data: {
        id: materialDefinitionId,
        name: `Task21 material ${options.label} ${suffix}`,
        normalizedName: `task21 material ${options.label} ${suffix}`,
        kind: 'base',
        status: 'active',
        createdByRole: 'admin',
      },
    });
  }

  await prisma.commercialOrder.create({
    data: {
      id: orderId,
      orderNumber: `TASK21-${options.label}-${suffix}`,
      title: `Task21 ${options.label}`,
      creatorRole: 'commercial',
      counterpartyId,
      warehouseCoverageWorkflowVersion: 2,
      commercialStage: 'sent_to_finance',
      sentToFinanceAt: new Date(),
      positions: {
        create: {
          id: positionId,
          rollCount: options.rollCount,
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1_000,
          plannedLengthM: 100,
          rawMaterialId: `task21-stock-${materialDefinitionId}`,
          baseRawMaterialDefinitionId: materialDefinitionId,
          spoolType: '76 мм',
          birka,
          plannedWeightKg: 40,
          recipe: {
            create: {
              id: `task21-recipe-${suffix}`,
              parameters: [],
              source: 'task21_e2e',
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
          id: financeOrderId,
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
  });

  const rollIds = shared?.rollIds ?? [];
  if (!shared) {
    const availableRolls = options.availableRolls ?? options.rollCount;
    for (let index = 0; index < availableRolls; index += 1) {
      const rollId = `task21-roll-${suffix}-${index}`;
      const rollCode = `TASK21-ROLL-${suffix}-${index}`;
      const factId = `task21-fact-${suffix}-${index}`;
      await prisma.warehouseRoll.create({
        data: {
          id: rollId,
          rollCode,
          ownerCounterpartyId: counterpartyId,
          warehouseStatus: 'received',
        },
      });
      const spec = canonicalizeRollCoverageSpec({
        rollCode,
        sourceOrderId: orderId,
        sourcePositionId: positionId,
        ownerCounterpartyId: counterpartyId,
        filmType: 'Полотно',
        actualThicknessMilliMicron: 80_000,
        accountingThicknessMilliMicron: 80_000,
        widthMilliMm: 1_000_000,
        plannedLengthMilliM: 100_000,
        birka,
        spoolType: '76 мм',
        actualWeightMilliKg: 40_000,
        plannedWeightMilliKg: 40_000,
        recipeId: `task21-recipe-${suffix}`,
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
      await prisma.warehouseRollCoverageFact.create({
        data: {
          id: factId,
          rollId,
          version: 1,
          source: 'migration_backfill',
          specVersion: FACT_SPEC_VERSION,
          specFingerprint: fingerprintRollFact(spec),
          spec: spec as unknown as Prisma.InputJsonValue,
          sourceOrderId: orderId,
          sourcePositionId: positionId,
          actorKind: 'system',
          systemActorKey: SYSTEM_ACTOR_KEY,
        },
      });
      await prisma.warehouseRoll.update({
        where: { id: rollId },
        data: { currentCoverageFactId: factId },
      });
      rollIds.push(rollId);
    }
  }

  return {
    birka,
    counterpartyId,
    financeOrderId,
    materialDefinitionId,
    orderId,
    positionId,
    rollIds: [...rollIds],
  };
}

async function initializeCoverage(
  prisma: PrismaService,
  calculations: WarehouseCoverageCalculationService,
  orderId: string,
): Promise<void> {
  await prisma.$transaction((tx) => calculations.initializeAtInvoiceHandoff(tx, orderId));
}

async function reservedFixture(
  prisma: PrismaService,
  calculations: WarehouseCoverageCalculationService,
  decisions: WarehouseCoverageDecisionService,
  label: string,
): Promise<CoverageFixture> {
  const fixture = await createCoverageFixture(prisma, { label, rollCount: 1 });
  await initializeCoverage(prisma, calculations, fixture.orderId);
  const state = await currentState(prisma, fixture.orderId);
  await decisions.decide(actor('finance'), fixture.financeOrderId, {
    clientRequestId: canonicalUuid(),
    expectedGeneration: state.generation,
    expectedStateVersion: state.stateVersion,
    decision: 'use_warehouse',
  });
  return fixture;
}

async function currentState(prisma: PrismaService, orderId: string) {
  return prisma.warehouseCoverageState.findUniqueOrThrow({
    where: { orderId },
    select: {
      currentCalculationId: true,
      currentDecisionId: true,
      generation: true,
      state: true,
      stateVersion: true,
    },
  });
}

async function recoveryContext(prisma: PrismaService, orderId: string) {
  const state = await currentState(prisma, orderId);
  if (!state.currentCalculationId || !state.currentDecisionId) {
    throw new Error('Reserved coverage fixture has no current provenance');
  }
  const task = await prisma.warehouseAcceptanceTask.findFirstOrThrow({
    where: {
      orderId,
      coverageDecisionId: state.currentDecisionId,
    },
    include: {
      rows: { orderBy: { id: 'asc' } },
    },
  });
  const scanRow = task.rows[0];
  if (!scanRow) throw new Error('Reserved coverage fixture has no scan row');
  return {
    calculationId: state.currentCalculationId,
    decisionId: state.currentDecisionId,
    expectedTaskUpdatedAt: task.updatedAt.toISOString(),
    generation: state.generation,
    scanRowId: scanRow.id,
    stateVersion: state.stateVersion,
    taskId: task.id,
  };
}

async function createFinanceLockCase(
  prisma: PrismaService,
  orderId: string,
  calculationId: string,
  stateVersion: number,
) {
  return prisma.orderResolutionCase.create({
    data: {
      openScopeKey: `warehouse_coverage_v2:${orderId}:finance_request`,
      orderId,
      type: 'warehouse_coverage_recheck',
      status: 'open',
      ownerRole: 'warehouse',
      affectedPositionIds: [],
      affectedRollIds: [],
      reason: 'Task21 finance lock hierarchy',
      createdByRole: 'finance',
      createdById: 'task21-finance',
      coverageScope: `warehouse_coverage_v2:${orderId}`,
      coverageOrigin: 'finance_request',
      sourceCoverageCalculationId: calculationId,
      sourceCoverageDecisionId: null,
      sourceCoverageStateVersion: stateVersion,
    },
    select: { id: true },
  });
}

async function createPhysicalLockCase(
  prisma: PrismaService,
  orderId: string,
  calculationId: string,
  decisionId: string,
  stateVersion: number,
) {
  return prisma.orderResolutionCase.create({
    data: {
      openScopeKey: `warehouse_coverage_v2:${orderId}:decision_linked_physical_exception`,
      orderId,
      type: 'warehouse_coverage_physical_exception',
      status: 'open',
      ownerRole: 'warehouse',
      affectedPositionIds: [],
      affectedRollIds: [],
      reason: 'Task21 physical lock hierarchy',
      createdByRole: 'warehouse',
      createdById: 'task21-warehouse',
      coverageScope: `warehouse_coverage_v2:${orderId}`,
      coverageOrigin: 'decision_linked_physical_exception',
      sourceCoverageCalculationId: calculationId,
      sourceCoverageDecisionId: decisionId,
      sourceCoverageStateVersion: stateVersion,
    },
    select: { id: true },
  });
}

function physicalExceptionCommand(
  context: Awaited<ReturnType<typeof recoveryContext>>,
  clientRequestId: UuidString,
) {
  return {
    clientRequestId,
    expectedGeneration: context.generation,
    expectedStateVersion: context.stateVersion,
    expectedTaskUpdatedAt: context.expectedTaskUpdatedAt,
    scanRowId: context.scanRowId,
    kind: 'damaged' as const,
    reason: 'Рулон поврежден во время контрольной приемки',
  };
}

function fulfilledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status !== 'fulfilled') throw result.reason;
  return result.value;
}

async function decisionsUsingRoll(prisma: PrismaService, rollId: string, orderIds: string[]) {
  return prisma.warehouseCoverageDecision.findMany({
    where: {
      orderId: { in: orderIds },
      calculation: { matches: { some: { rollId } } },
      kind: 'use_warehouse',
    },
    select: { id: true },
  });
}

async function partialDecisionSets(prisma: PrismaService, orderIds: string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT decision.id
    FROM "warehouse_coverage_decisions" AS decision
    LEFT JOIN "warehouse_rolls" AS roll
      ON roll."reservedByCoverageDecisionId" = decision.id
    WHERE decision."orderId" IN (${Prisma.join(orderIds)})
      AND decision.kind = 'use_warehouse'
    GROUP BY decision.id, decision."expectedRollCount"
    HAVING COUNT(roll.id)::int <> decision."expectedRollCount"
    ORDER BY decision.id
  `);
  return rows.map(({ id }) => id);
}

async function orphanCalculationCount(prisma: PrismaService, orderId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    WITH latest AS (
      SELECT id, generation
      FROM "warehouse_coverage_calculations"
      WHERE "orderId" = ${orderId}
      ORDER BY generation DESC
      LIMIT 1
    )
    SELECT COUNT(*)::int AS count
    FROM latest
    JOIN "warehouse_coverage_states" AS state
      ON state."orderId" = ${orderId}
    WHERE latest.id <> state."currentCalculationId"
       OR latest.generation <> state.generation
  `);
  return rows[0]?.count ?? 0;
}

async function currentStateReferencesValid(
  prisma: PrismaService,
  orderId: string,
): Promise<boolean> {
  return (await validCurrentPointerCount(prisma, orderId)) === 1;
}

async function validCurrentPointerCount(prisma: PrismaService, orderId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM "warehouse_coverage_states" AS state
    JOIN "warehouse_coverage_calculations" AS calculation
      ON calculation.id = state."currentCalculationId"
     AND calculation."orderId" = state."orderId"
     AND calculation.generation = state.generation
    LEFT JOIN "warehouse_coverage_decisions" AS decision
      ON decision.id = state."currentDecisionId"
     AND decision."orderId" = state."orderId"
     AND decision."calculationId" = calculation.id
     AND decision.generation = calculation.generation
    WHERE state."orderId" = ${orderId}
      AND (
        state."currentDecisionId" IS NULL
        OR decision.id IS NOT NULL
      )
  `);
  return rows[0]?.count ?? 0;
}

async function reservedDecisionRollIds(
  prisma: PrismaService,
  decisionId: string,
): Promise<string[]> {
  const rows = await prisma.warehouseRoll.findMany({
    where: { reservedByCoverageDecisionId: decisionId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map(({ id }) => id);
}

async function openPhysicalExceptionCases(prisma: PrismaService, orderId: string) {
  return prisma.orderResolutionCase.findMany({
    where: {
      orderId,
      status: 'open',
      coverageOrigin: 'decision_linked_physical_exception',
    },
    select: { id: true },
  });
}

async function cancellationCommandCount(
  prisma: PrismaService,
  decisionId: string,
): Promise<number> {
  return prisma.warehouseCoverageCommand.count({
    where: {
      kind: 'cancel_reservation',
      resultKind: 'recheck_case',
      scopeTask: { coverageDecisionId: decisionId },
    },
  });
}

async function finalCommandCount(
  prisma: PrismaService,
  clientRequestId: UuidString,
): Promise<number> {
  return prisma.warehouseCoverageCommand.count({
    where: { clientRequestId },
  });
}

async function requestRecheckEventCount(prisma: PrismaService, orderId: string): Promise<number> {
  return prisma.domainEvent.count({
    where: {
      objectId: orderId,
      type: 'audit:warehouse_coverage_recheck_requested',
    },
  });
}

async function invalidProductionProvenanceCount(
  prisma: PrismaService,
  orderId: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM "production_orders" AS production
    LEFT JOIN "warehouse_coverage_calculations" AS calculation
      ON calculation.id = production."sourceCoverageCalculationId"
    LEFT JOIN "warehouse_coverage_decisions" AS decision
      ON decision.id = production."sourceCoverageDecisionId"
    WHERE production."commercialOrderId" = ${orderId}
      AND (
        calculation.id IS NULL
        OR decision.id IS NULL
        OR calculation."orderId" <> production."commercialOrderId"
        OR decision."orderId" <> production."commercialOrderId"
        OR decision."calculationId" <> calculation.id
        OR production."sourceCoverageInputFingerprint" <> calculation."inputFingerprint"
        OR production."sourceCoverageGeneration" <> calculation.generation
      )
  `);
  return rows[0]?.count ?? 0;
}

async function legacyMutationCount(prisma: PrismaService, taskId: string): Promise<number> {
  return prisma.scanRow.count({
    where: {
      taskId,
      scanStatus: { not: 'expected' },
    },
  });
}

async function holdEpochRow(prisma: PrismaService): Promise<() => Promise<void>> {
  let reportLocked!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    reportLocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id
      FROM "warehouse_coverage_inventory_epochs"
      WHERE id = 1
      FOR UPDATE
    `;
    reportLocked();
    await released;
  });
  await withStrictRaceDeadline(() => locked);
  return async () => {
    release();
    await holder;
  };
}

async function holdCommandAdvisory(
  clientRequestId: UuidString,
): Promise<{ backendPid: number; release(): Promise<void> }> {
  const client = new PrismaClient();
  let reportLocked!: (backendPid: number) => void;
  let release!: () => void;
  const locked = new Promise<number>((resolve) => {
    reportLocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = client.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ backendPid: number }>>`
      SELECT pg_backend_pid() AS "backendPid"
    `;
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock($1)',
      coverageCommandAdvisoryKey(clientRequestId),
    );
    reportLocked(row!.backendPid);
    await released;
  });
  const backendPid = await withStrictRaceDeadline(() => locked);
  let releasePromise: Promise<void> | undefined;
  return {
    backendPid,
    release: async () => {
      if (!releasePromise) {
        release();
        releasePromise = holder.finally(() => client.$disconnect());
      }
      await releasePromise;
    },
  };
}

async function waitForBackendBlockedBy(prisma: PrismaService, blockerPid: number): Promise<void> {
  await withStrictRaceDeadline(async () => {
    for (;;) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity AS activity
        WHERE ${blockerPid} = ANY(pg_blocking_pids(activity.pid))
          AND activity.wait_event_type = 'Lock'
          AND activity.wait_event = 'advisory'
      `);
      if ((row?.count ?? 0) > 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}
