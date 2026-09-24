import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import {
  capabilitiesForRole,
  type Role as ContractRole,
  type WarehouseCoverageProjection,
} from '@plenka/contracts';
import type { Actor } from '../src/common/auth/actor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { seedWarehouseCoverageV2Fixtures } from '../src/common/seed/production-seed';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';
import { WarehouseCoverageCalculationService } from '../src/modules/warehouse-coverage/warehouse-coverage-calculation.service';
import { WarehouseCoverageDecisionService } from '../src/modules/warehouse-coverage/warehouse-coverage-decision.service';
import { WarehouseCoverageRecheckService } from '../src/modules/warehouse-coverage/warehouse-coverage-recheck.service';
import { WarehouseCoverageReservationRecoveryService } from '../src/modules/warehouse-coverage/warehouse-coverage-reservation-recovery.service';
import { CommercialCoverService } from '../src/modules/commercial/commercial-cover.service';
import { CommercialService } from '../src/modules/commercial/commercial.service';
import { ProductionService } from '../src/modules/production/production.service';
import { WarehouseService } from '../src/modules/warehouse/warehouse.service';
import { assertSchemaDestructionTarget, createE2eSchemaName } from './e2e-database';
import { e2eSeedLogin } from './e2e-credentials';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(API_ROOT, 'prisma/schema.prisma');
const SEED_SCRIPT = resolve(API_ROOT, 'prisma/seed.ts');
const PREPARE_BROWSER_FIXTURES_ARG = '--prepare-browser-fixtures';
const COVERAGE_SYSTEM_ACTOR = 'warehouse_coverage_engine';
const FACT_SPEC_VERSION = 'warehouse-roll-coverage/v1';
const ACCEPTANCE_FIXTURE_NAMES = [
  'accept-full-recovery',
  'accept-unavailable-production',
  'accept-unknown-recheck',
  'accept-v1-unchanged',
] as const;

type AcceptanceFixtureName = (typeof ACCEPTANCE_FIXTURE_NAMES)[number];

type AcceptanceFixture = {
  name: AcceptanceFixtureName;
  orderId: string;
  orderNumber: string;
  positionId: string;
  financeOrderId: string;
  counterpartyId: string;
  rollIds: string[];
};

const jestDescribe = (globalThis as { describe?: typeof describe }).describe;

jestDescribe?.('Warehouse coverage V2 cross-contour acceptance (e2e, PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let calculations: WarehouseCoverageCalculationService;
  let decisions: WarehouseCoverageDecisionService;
  let rechecks: WarehouseCoverageRecheckService;
  let recovery: WarehouseCoverageReservationRecoveryService;
  let production: ProductionService;
  let commercial: CommercialService;
  let commercialCover: CommercialCoverService;
  let warehouse: WarehouseService;
  let financeActor: Actor;
  let warehouseActor: Actor;
  let commercialActor: Actor;
  let productionActor: Actor;
  let baseDatabaseUrl: string;
  let isolatedDatabaseUrl: string;
  let isolatedSchema: string;
  const previousCoverageFlag = process.env.WAREHOUSE_COVERAGE_V2_ENABLED;

  beforeAll(async () => {
    baseDatabaseUrl = requireDatabaseUrl();
    isolatedSchema = createE2eSchemaName();
    isolatedDatabaseUrl = databaseUrlForSchema(baseDatabaseUrl, isolatedSchema);
    assertSchemaDestructionTarget(isolatedSchema, isolatedDatabaseUrl);
    process.env.DATABASE_URL = isolatedDatabaseUrl;
    process.env.WAREHOUSE_COVERAGE_V2_ENABLED = 'true';
    runPrismaMigrateDeploy();
    runCliSeed({
      ...process.env,
      APP_ENV: 'development',
      SEED_PROFILE: 'demo',
    });

    const { AppModule } = await import('../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    calculations = moduleRef.get(WarehouseCoverageCalculationService);
    decisions = moduleRef.get(WarehouseCoverageDecisionService);
    rechecks = moduleRef.get(WarehouseCoverageRecheckService);
    recovery = moduleRef.get(WarehouseCoverageReservationRecoveryService);
    production = moduleRef.get(ProductionService);
    commercial = moduleRef.get(CommercialService);
    commercialCover = moduleRef.get(CommercialCoverService);
    warehouse = moduleRef.get(WarehouseService);
    [financeActor, warehouseActor, commercialActor, productionActor] = await Promise.all([
      seededActor(prisma, e2eSeedLogin('finance'), 'finance'),
      seededActor(prisma, e2eSeedLogin('warehouse'), 'warehouse'),
      seededActor(prisma, e2eSeedLogin('commercial'), 'commercial'),
      seededActor(prisma, e2eSeedLogin('production'), 'production_lead'),
    ]);
  });

  afterAll(async () => {
    await moduleRef?.close();
    process.env.DATABASE_URL = baseDatabaseUrl;
    const admin = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
    try {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${isolatedSchema}" CASCADE`);
    } finally {
      await admin.$disconnect();
    }
    if (previousCoverageFlag === undefined) {
      delete process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
    } else {
      process.env.WAREHOUSE_COVERAGE_V2_ENABLED = previousCoverageFlag;
    }
  });

  it('prepares four independent browser fixtures only after a V2-free local seed', async () => {
    runCliSeed({
      ...process.env,
      APP_ENV: 'development',
      SEED_PROFILE: 'demo',
    });
    expect(await v2FixtureCount(prisma)).toBe(0);

    for (const name of ACCEPTANCE_FIXTURE_NAMES) {
      await seedAcceptanceFixture(name, true);
    }

    expect(await acceptanceFixtureNames(prisma)).toEqual([
      'accept-full-recovery',
      'accept-unavailable-production',
      'accept-unknown-recheck',
      'accept-v1-unchanged',
    ]);
  });

  it('full cover -> finance warehouse -> physical exception -> full recovery', async () => {
    const fixture = await seedAcceptanceFixture('accept-full-recovery');
    const result = await executeFullRecovery(fixture);

    expect(result.refreshed).toMatchObject({
      availability: 'verified_full',
      matchedRollCount: 2,
      requiredRollCount: 2,
    });
    expect(await reservedRolls(prisma, fixture.orderId)).toEqual([]);
    expect(await openCaseOrigins(prisma, fixture.orderId)).toEqual([
      'decision_linked_physical_exception',
    ]);
  });

  it('unavailable -> system auto route -> atomic production handoff', async () => {
    const fixture = await seedAcceptanceFixture('accept-unavailable-production');
    const result = await executeUnavailableProduction(fixture);

    expect(result.refreshed.availability).toBe('unavailable');
    expect(result.production).toMatchObject({
      sourceCoverageCalculationId: expect.any(String),
      sourceCoverageDecisionId: expect.any(String),
      sourceCoverageInputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      sourceCoverageGeneration: expect.any(Number),
    });
  });

  it('unknown -> finance recheck -> warehouse correction -> fresh generation', async () => {
    const fixture = await seedAcceptanceFixture('accept-unknown-recheck');
    const result = await executeUnknownRecheck(fixture);

    expect(result.refreshed.availability).toBe('unknown');
    expect(result.resolved.generation).toBeGreaterThan(requiredGeneration(result.requested));
    expect(result.resolved).toMatchObject({
      availability: 'verified_full',
      matchedRollCount: 1,
      uncertainRollCount: 0,
    });
  });

  it('keeps the V1 manual proposal flow unchanged', async () => {
    const fixture = await seedAcceptanceFixture('accept-v1-unchanged');
    await proposeAndApproveLegacyCover(fixture);

    expect(await legacyProposalStatus(prisma, fixture.orderId)).toBe('full_confirmed');
    expect(await v2StateForOrder(prisma, fixture.orderId)).toBeNull();
  });

  it('uses exactly the seven V2 material events across the final writer flows', async () => {
    const orderIds = await executeThreeIndependentV2AcceptanceFlows();

    expect(new Set(await uniqueCoverageAuditTypes(prisma, orderIds))).toEqual(
      new Set([
        'audit:warehouse_coverage_calculated',
        'audit:warehouse_coverage_decided',
        'audit:warehouse_coverage_recheck_requested',
        'audit:warehouse_roll_coverage_fact_corrected',
        'audit:warehouse_coverage_recheck_resolved',
        'audit:warehouse_coverage_reserved',
        'audit:warehouse_coverage_reservation_cancelled',
      ]),
    );
    expect(await auditCount(prisma, orderIds, 'audit:warehouse_rolls_reserved_for_order')).toBe(0);
  });

  async function seedAcceptanceFixture(
    name: AcceptanceFixtureName,
    browserStableName = false,
  ): Promise<AcceptanceFixture> {
    return prisma.$transaction(async (tx) => {
      await seedWarehouseCoverageV2Fixtures(tx, {
        appEnv: 'test',
        includeWarehouseCoverageV2Fixtures: true,
      });
      return createIndependentAcceptanceFixture(tx, name, browserStableName);
    });
  }

  async function executeFullRecovery(fixture: AcceptanceFixture) {
    const refreshed = await refresh(fixture);
    const decided = await decisions.decide(financeActor, fixture.financeOrderId, {
      clientRequestId: randomUUID(),
      expectedGeneration: requiredGeneration(refreshed),
      expectedStateVersion: refreshed.stateVersion,
      decision: 'use_warehouse',
    });
    const taskRecord = await prisma.warehouseAcceptanceTask.findFirstOrThrow({
      where: { orderId: fixture.orderId, coverageDecisionId: { not: null } },
      select: { id: true },
    });
    const task = await recovery.readDecisionTask(warehouseActor, taskRecord.id);
    if (!task || task.rows.length === 0) {
      throw new Error('Decision-linked acceptance task is missing rows');
    }
    const recovered = await recovery.reportPhysicalException(warehouseActor, task.taskId, {
      clientRequestId: randomUUID(),
      expectedGeneration: task.generation,
      expectedStateVersion: task.stateVersion,
      expectedTaskUpdatedAt: task.updatedAt,
      scanRowId: task.rows[0]!.scanRowId,
      kind: 'damaged',
      reason: 'Физически повреждён при складской приёмке',
    });
    expect(decided.state).toBe('warehouse_reserved');
    expect(recovered.state).toBe('recheck_requested');
    return { refreshed, recovered };
  }

  async function executeUnavailableProduction(fixture: AcceptanceFixture) {
    const refreshed = await refresh(fixture);
    await production.createFromCommercial(
      {
        userId: commercialActor.userId,
        role: commercialActor.role,
        capabilities: commercialActor.capabilities,
      },
      fixture.orderId,
    );
    const productionRow = await prisma.productionOrder.findUniqueOrThrow({
      where: { commercialOrderId: fixture.orderId },
      select: {
        sourceCoverageCalculationId: true,
        sourceCoverageDecisionId: true,
        sourceCoverageInputFingerprint: true,
        sourceCoverageGeneration: true,
      },
    });
    return { refreshed, production: productionRow };
  }

  async function executeUnknownRecheck(fixture: AcceptanceFixture) {
    const refreshed = await refresh(fixture);
    const requested = await rechecks.requestFromFinance(financeActor, fixture.financeOrderId, {
      clientRequestId: randomUUID(),
      expectedGeneration: requiredGeneration(refreshed),
      expectedStateVersion: refreshed.stateVersion,
      reason: 'Нужно подтвердить владельца складского рулона',
    });
    const queue = await rechecks.listForWarehouse(warehouseActor);
    const item = queue.find(({ caseId }) => caseId === requested.caseId);
    if (!item || item.members.length !== 1) {
      throw new Error('Unknown coverage recheck must expose one exact member');
    }
    const member = item.members[0]!;
    const resolved = await rechecks.resolveFromWarehouse(warehouseActor, item.caseId, {
      clientRequestId: randomUUID(),
      expectedCaseVersion: item.caseVersion,
      expectedGeneration: item.generation,
      expectedStateVersion: item.stateVersion,
      reason: 'Владелец рулона подтверждён складом',
      corrections: [
        {
          membershipId: member.membershipId,
          expectedFactVersion: member.currentFactVersion,
          ownerCounterpartyId: fixture.counterpartyId,
        },
      ],
    });
    return { refreshed, requested, resolved };
  }

  async function proposeAndApproveLegacyCover(fixture: AcceptanceFixture): Promise<void> {
    await commercial.requestCoverCheck(
      { userId: commercialActor.userId, role: commercialActor.role },
      fixture.orderId,
    );
    const proposed = await warehouse.proposeCover(
      { userId: warehouseActor.userId, role: warehouseActor.role },
      fixture.orderId,
      {
        positionId: fixture.positionId,
        rollIds: fixture.rollIds,
        comment: 'V1 acceptance full cover',
      },
    );
    const commercialApproved = await commercialCover.approveCommercial(
      { userId: commercialActor.userId, role: commercialActor.role },
      fixture.orderId,
      fixture.positionId,
      proposed.id,
      {
        expectedVersion: proposed.version,
        route: 'full_cover',
      },
    );
    await commercialCover.finalizeTechnicalApproval(
      { userId: productionActor.userId, role: productionActor.role },
      fixture.orderId,
      fixture.positionId,
      proposed.id,
      { expectedVersion: commercialApproved.version },
    );
  }

  async function refresh(fixture: AcceptanceFixture) {
    const state = await prisma.warehouseCoverageState.findUniqueOrThrow({
      where: { orderId: fixture.orderId },
      select: { generation: true, stateVersion: true },
    });
    return calculations.refreshForFinance(financeActor, fixture.financeOrderId, {
      clientRequestId: randomUUID(),
      expectedGeneration: state.generation === 0 ? null : state.generation,
      expectedStateVersion: state.stateVersion,
    });
  }

  async function executeThreeIndependentV2AcceptanceFlows(): Promise<string[]> {
    const full = await seedAcceptanceFixture('accept-full-recovery');
    await executeFullRecovery(full);
    const unavailable = await seedAcceptanceFixture('accept-unavailable-production');
    await executeUnavailableProduction(unavailable);
    const unknown = await seedAcceptanceFixture('accept-unknown-recheck');
    await executeUnknownRecheck(unknown);
    return [full.orderId, unavailable.orderId, unknown.orderId];
  }
});

if (!jestDescribe) {
  if (process.argv.length !== 3 || process.argv[2] !== PREPARE_BROWSER_FIXTURES_ARG) {
    throw new Error(`Direct execution requires the exact ${PREPARE_BROWSER_FIXTURES_ARG} argument`);
  }
  void prepareBrowserFixtures().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Browser fixture preparation failed'}\n`,
    );
    process.exitCode = 1;
  });
}

async function prepareBrowserFixtures(): Promise<void> {
  const databaseUrl = assertBrowserFixtureDatabase(requireDatabaseUrl());
  if (process.env.WAREHOUSE_COVERAGE_V2_ENABLED !== 'true') {
    throw new Error('Browser fixture preparation requires WAREHOUSE_COVERAGE_V2_ENABLED=true');
  }
  runCliSeed({
    ...process.env,
    APP_ENV: 'development',
    SEED_PROFILE: 'demo',
  });

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    if ((await v2FixtureCount(prisma)) !== 0) {
      throw new Error('Browser fixture database must be V2-free before preparation');
    }
    for (const name of ACCEPTANCE_FIXTURE_NAMES) {
      await prisma.$transaction(async (tx) => {
        await seedWarehouseCoverageV2Fixtures(tx, {
          appEnv: 'test',
          includeWarehouseCoverageV2Fixtures: true,
        });
        await createIndependentAcceptanceFixture(tx, name, true);
      });
    }
    const prepared = await acceptanceFixtureNames(prisma);
    if (prepared.join('\n') !== ACCEPTANCE_FIXTURE_NAMES.join('\n')) {
      throw new Error('Browser fixture preparation did not create the exact named set');
    }
    process.stdout.write(`Prepared ${prepared.length} warehouse coverage browser fixtures\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function assertBrowserFixtureDatabase(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? '';
  const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !localHost ||
    url.port !== '5433' ||
    url.pathname !== '/plenka' ||
    !/^coverage_v2_acceptance_[a-z0-9_]+$/u.test(schema)
  ) {
    throw new Error(
      'Browser fixture preparation refuses a non-local or non-disposable DATABASE_URL',
    );
  }
  return url.toString();
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('E2E DATABASE_URL is not configured');
  return databaseUrl;
}

function databaseUrlForSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function runPrismaMigrateDeploy(): void {
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', PRISMA_SCHEMA],
    {
      cwd: API_ROOT,
      env: process.env,
      stdio: 'ignore',
    },
  );
}

async function createIndependentAcceptanceFixture(
  tx: Prisma.TransactionClient,
  name: AcceptanceFixtureName,
  browserStableName: boolean,
): Promise<AcceptanceFixture> {
  const runKey = browserStableName ? '' : `-${randomUUID().slice(0, 8)}`;
  const scope = `${name}${runKey}`;
  const orderId = `${scope}:order`;
  const orderNumber = scope;
  const positionId = `${scope}:position`;
  const financeOrderId = `${scope}:finance`;
  const counterpartyId = `${scope}:counterparty`;
  const recipeId = `${scope}:recipe`;
  const workflowVersion = name === 'accept-v1-unchanged' ? 1 : 2;
  const material = materialFor(name);
  const materialDefinitionId = material.id;
  const rollCount = name === 'accept-full-recovery' ? 2 : 1;
  const birka = `Acceptance ${name}`;
  const now = new Date();

  await tx.counterparty.create({
    data: {
      id: counterpartyId,
      displayName: `Acceptance fixture · ${name}`,
    },
  });
  await tx.commercialOrder.create({
    data: {
      id: orderId,
      orderNumber,
      title: `Acceptance fixture · ${name}`,
      creatorRole: Role.commercial,
      counterpartyId,
      warehouseCoverageWorkflowVersion: workflowVersion,
      commercialStage: 'sent_to_finance',
      sentToFinanceAt: now,
      positions: {
        create: {
          id: positionId,
          rollCount,
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1_000,
          plannedLengthM: 100,
          rawMaterialId: `${scope}:raw-material`,
          baseRawMaterialDefinitionId: materialDefinitionId,
          spoolType: '76 мм',
          birka,
          plannedWeightKg: 40,
          recipe: {
            create: {
              id: recipeId,
              parameters: [],
              source: 'test_fixture',
              createdBy: COVERAGE_SYSTEM_ACTOR,
              version: 'v1',
              recipeName: material.name,
              ingredients: [
                {
                  rawMaterialDefinitionId: materialDefinitionId,
                  name: material.name,
                  shareBasisPoints: 10_000,
                },
              ],
            },
          },
        },
      },
    },
  });
  await tx.financeOrder.create({
    data: {
      id: financeOrderId,
      commercialOrderId: orderId,
      invoiceStatus: 'invoiced',
      paymentStatus: 'unpaid',
      paymentTermsType: 'postpay_100_30d',
      sourceStatus: 'ready',
      invoiceIssuedAt: now,
    },
  });

  if (workflowVersion === 2) {
    await tx.warehouseCoverageState.create({
      data: {
        orderId,
        state: 'calculating',
        stateVersion: 1,
        generation: 0,
      },
    });
  }

  const rollIds: string[] = [];
  if (name === 'accept-full-recovery') {
    for (const sequence of [1, 2]) {
      rollIds.push(
        await createCoverageRoll(tx, {
          scope,
          sequence,
          orderId,
          positionId,
          counterpartyId,
          materialDefinitionId,
          birka,
          recipeId,
          verifiedOwner: true,
        }),
      );
    }
  } else if (name === 'accept-unknown-recheck') {
    rollIds.push(
      await createCoverageRoll(tx, {
        scope,
        sequence: 1,
        orderId,
        positionId,
        counterpartyId,
        materialDefinitionId,
        birka,
        recipeId,
        verifiedOwner: false,
      }),
    );
  } else if (name === 'accept-v1-unchanged') {
    const rollId = `${scope}:roll:1`;
    await tx.warehouseRoll.create({
      data: {
        id: rollId,
        rollCode: `${scope}-ROLL-1`,
        warehouseStatus: 'received',
        positionSnapshot: {
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1_000,
          plannedLengthM: 100,
          spoolType: '76 мм',
          birka,
          plannedWeightKg: 40,
        },
      },
    });
    rollIds.push(rollId);
  }

  return {
    name,
    orderId,
    orderNumber,
    positionId,
    financeOrderId,
    counterpartyId,
    rollIds,
  };
}

async function createCoverageRoll(
  tx: Prisma.TransactionClient,
  input: {
    scope: string;
    sequence: number;
    orderId: string;
    positionId: string;
    counterpartyId: string;
    materialDefinitionId: string;
    birka: string;
    recipeId: string;
    verifiedOwner: boolean;
  },
): Promise<string> {
  const rollId = `${input.scope}:roll:${input.sequence}`;
  const factId = `${input.scope}:fact:${input.sequence}`;
  const rollCode = `${input.scope}-ROLL-${input.sequence}`;
  const ownerCounterpartyId = input.verifiedOwner ? input.counterpartyId : null;
  const spec = canonicalizeRollCoverageSpec({
    rollCode,
    sourceOrderId: input.orderId,
    sourcePositionId: input.positionId,
    ownerCounterpartyId,
    filmType: 'Полотно',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 80_000,
    widthMilliMm: 1_000_000,
    plannedLengthMilliM: 100_000,
    birka: input.birka,
    spoolType: '76 мм',
    actualWeightMilliKg: 40_000,
    plannedWeightMilliKg: 40_000,
    ingredients: [
      {
        rawMaterialDefinitionId: input.materialDefinitionId,
        shareBasisPoints: 10_000,
      },
    ],
    recipeId: input.recipeId,
    recipeVersion: 'v1',
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
  });
  await tx.warehouseRoll.create({
    data: {
      id: rollId,
      rollCode,
      ownerCounterpartyId,
      warehouseStatus: 'received',
    },
  });
  await tx.warehouseRollCoverageFact.create({
    data: {
      id: factId,
      rollId,
      version: 1,
      source: 'migration_backfill',
      specVersion: FACT_SPEC_VERSION,
      specFingerprint: fingerprintRollFact(spec),
      spec: spec as unknown as Prisma.InputJsonValue,
      sourceOrderId: input.orderId,
      sourcePositionId: input.positionId,
      actorKind: 'system',
      actorRole: null,
      actorId: null,
      systemActorKey: COVERAGE_SYSTEM_ACTOR,
      reason: null,
    },
  });
  await tx.warehouseRoll.update({
    where: { id: rollId },
    data: { currentCoverageFactId: factId },
  });
  return rollId;
}

function materialFor(name: AcceptanceFixtureName): { id: string; name: string } {
  if (name === 'accept-unavailable-production') {
    return {
      id: 'v2-cover-material-unavailable',
      name: 'Coverage fixture material unavailable',
    };
  }
  if (name === 'accept-unknown-recheck') {
    return {
      id: 'v2-cover-material-unknown',
      name: 'Coverage fixture material unknown',
    };
  }
  return {
    id: 'v2-cover-material-verified-full',
    name: 'Coverage fixture material verified_full',
  };
}

async function seededActor(
  prisma: PrismaClient | PrismaService,
  login: string,
  role: ContractRole,
): Promise<Actor> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { login },
    select: { id: true, role: true },
  });
  if (user.role !== role) throw new Error(`Seed actor ${login} has unexpected role`);
  return {
    userId: user.id,
    role,
    capabilities: capabilitiesForRole(role),
  };
}

function requiredGeneration(projection: WarehouseCoverageProjection): number {
  if (projection.generation === null) throw new Error('Coverage generation is missing');
  return projection.generation;
}

function runCliSeed(env: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), SEED_SCRIPT], {
    cwd: API_ROOT,
    env,
    stdio: 'ignore',
  });
}

function v2FixtureCount(prisma: PrismaClient | PrismaService): Promise<number> {
  return prisma.commercialOrder.count({
    where: {
      OR: [{ warehouseCoverageWorkflowVersion: 2 }, { orderNumber: { startsWith: 'V2-COVER-' } }],
    },
  });
}

async function acceptanceFixtureNames(prisma: PrismaClient | PrismaService): Promise<string[]> {
  const rows = await prisma.commercialOrder.findMany({
    where: { orderNumber: { in: [...ACCEPTANCE_FIXTURE_NAMES] } },
    select: { orderNumber: true },
    orderBy: { orderNumber: 'asc' },
  });
  return rows.map(({ orderNumber }) => orderNumber);
}

async function reservedRolls(
  prisma: PrismaClient | PrismaService,
  orderId: string,
): Promise<string[]> {
  const rows = await prisma.warehouseRoll.findMany({
    where: { reservedForOrderId: orderId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map(({ id }) => id);
}

async function openCaseOrigins(
  prisma: PrismaClient | PrismaService,
  orderId: string,
): Promise<Array<string | null>> {
  const rows = await prisma.orderResolutionCase.findMany({
    where: { orderId, status: 'open' },
    select: { coverageOrigin: true },
    orderBy: { id: 'asc' },
  });
  return rows.map(({ coverageOrigin }) => coverageOrigin);
}

async function legacyProposalStatus(
  prisma: PrismaClient | PrismaService,
  orderId: string,
): Promise<string | null> {
  const row = await prisma.warehouseCoverProposal.findFirst({
    where: { orderId },
    select: { status: true },
    orderBy: { createdAt: 'desc' },
  });
  return row?.status ?? null;
}

function v2StateForOrder(prisma: PrismaClient | PrismaService, orderId: string) {
  return prisma.warehouseCoverageState.findUnique({ where: { orderId } });
}

async function uniqueCoverageAuditTypes(
  prisma: PrismaClient | PrismaService,
  orderIds: string[],
): Promise<string[]> {
  const memberships = await prisma.warehouseCoverageRecheckMembership.findMany({
    where: { orderId: { in: orderIds } },
    select: { rollId: true },
  });
  const rollIds = [...new Set(memberships.map(({ rollId }) => rollId))];
  const rows = await prisma.domainEvent.findMany({
    where: {
      OR: [
        {
          objectId: { in: orderIds },
          type: { startsWith: 'audit:warehouse_coverage_' },
        },
        {
          objectId: { in: rollIds },
          type: 'audit:warehouse_roll_coverage_fact_corrected',
        },
      ],
    },
    select: { type: true },
  });
  return [...new Set(rows.map(({ type }) => type))].sort();
}

function auditCount(
  prisma: PrismaClient | PrismaService,
  orderIds: string[],
  type: string,
): Promise<number> {
  return prisma.domainEvent.count({
    where: {
      objectId: { in: orderIds },
      type,
    },
  });
}
