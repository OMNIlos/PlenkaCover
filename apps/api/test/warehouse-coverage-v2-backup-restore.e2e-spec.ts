import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { capabilitiesForRole } from '@plenka/contracts';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';
import { WarehouseCoverageCalculationService } from '../src/modules/warehouse-coverage/warehouse-coverage-calculation.service';
import { WarehouseCoverageDecisionService } from '../src/modules/warehouse-coverage/warehouse-coverage-decision.service';
import {
  assertCommandSucceeded,
  assertDisposableDatabaseTarget,
  runE2eWithCleanup,
} from './e2e-database';
import {
  createDisposableRestoreDatabaseIdentity,
  dropDisposableRestoreDatabase,
  markDisposableRestoreDatabase,
  postgresCommandOutcome,
  requireBackupClientCompatibility,
  requireDisposableRestoreDatabase,
  requirePostgresCommandSuccess,
  runPostgresClient,
  shouldDropDisposableRestoreDatabase,
  type DisposableRestoreCreationState,
} from './postgres-backup-client';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(API_ROOT, 'prisma/schema.prisma');
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const V1_ORDER_NUMBER = 'TASK21-RESTORE-V1';

interface DatabaseIdentity {
  database: string;
  schema: string;
  user: string;
}

const POSTGRES_CLIENT_BINARIES = {
  dump: process.env.PLENKA_E2E_PG_DUMP_BIN ?? 'pg_dump',
  restore: process.env.PLENKA_E2E_PG_RESTORE_BIN ?? 'pg_restore',
  sql: process.env.PLENKA_E2E_PSQL_BIN ?? 'psql',
} as const;

function requireDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error('E2E DATABASE_URL is not configured');
  }
  return process.env.DATABASE_URL;
}

function databaseIdentity(databaseUrl: string): DatabaseIdentity {
  const url = new URL(databaseUrl);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.split('.', 1)[0] === '127');
  const overridesTarget = [...url.searchParams.keys()].some((key) =>
    ['host', 'hostaddr'].includes(key.toLowerCase()),
  );
  if (!isLoopback || overridesTarget) {
    throw new Error('Backup/restore e2e requires a loopback PostgreSQL target');
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  const schema = url.searchParams.get('schema');
  const user = decodeURIComponent(url.username);
  if (!database || !schema || !user) {
    throw new Error('E2E DATABASE_URL must include database, user and isolated schema');
  }
  return { database, schema, user };
}

function databaseUrlForDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function postgresClient(command: string, databaseUrl: string, args: string[], input?: Buffer) {
  return runPostgresClient(command, databaseUrl, args, MAX_ARCHIVE_BYTES, input);
}

function runPrismaMigrateDeploy(databaseUrl: string, label: string): void {
  assertCommandSucceeded(
    label,
    spawnSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', PRISMA_SCHEMA],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'ignore',
      },
    ),
  );
}

function runPgDumpCustom(databaseUrl: string, dumpPath: string): void {
  const { schema } = databaseIdentity(databaseUrl);
  const dump = postgresClient(POSTGRES_CLIENT_BINARIES.dump, databaseUrl, [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    `--schema=${schema}`,
  ]);
  requirePostgresCommandSuccess('Warehouse coverage V2 custom dump', dump);
  expect(dump.stdout.subarray(0, 5).toString('ascii')).toBe('PGDMP');
  writeFileSync(dumpPath, dump.stdout, { flag: 'wx' });
}

function runPgRestoreCustom(databaseUrl: string, dumpPath: string): void {
  const { database } = databaseIdentity(databaseUrl);
  const restore = postgresClient(
    POSTGRES_CLIENT_BINARIES.restore,
    databaseUrl,
    [`--dbname=${database}`, '--exit-on-error', '--no-owner', '--no-privileges'],
    readFileSync(dumpPath),
  );
  requirePostgresCommandSuccess('Warehouse coverage V2 custom restore', restore);
}

describe('warehouse coverage V2 backup restore (e2e, PostgreSQL custom format)', () => {
  jest.setTimeout(180_000);

  it('deploys twice and restores a custom-format backup with all invariants', async () => {
    const sourceDatabaseUrl = requireDatabaseUrl();
    await assertDisposableDatabaseTarget(sourceDatabaseUrl);
    requireBackupClientCompatibility(sourceDatabaseUrl, POSTGRES_CLIENT_BINARIES);
    const { user } = databaseIdentity(sourceDatabaseUrl);
    const restoreIdentity = createDisposableRestoreDatabaseIdentity();
    const restoreDatabase = restoreIdentity.database;
    const restoreDatabaseUrl = databaseUrlForDatabase(sourceDatabaseUrl, restoreDatabase);
    const maintenanceDatabaseUrl = databaseUrlForDatabase(sourceDatabaseUrl, 'postgres');
    const tempDirectory = mkdtempSync(join(tmpdir(), 'plenka-coverage-restore-'));
    const dumpPath = join(tempDirectory, 'warehouse-coverage-v2.dump');
    const restoreClient = new PrismaClient({
      datasourceUrl: restoreDatabaseUrl,
    });
    let moduleRef: TestingModule | undefined;
    let restoreCreationState: DisposableRestoreCreationState = 'not_attempted';

    await runE2eWithCleanup(async () => {
      runPrismaMigrateDeploy(sourceDatabaseUrl, 'Warehouse coverage source first deploy');
      runPrismaMigrateDeploy(sourceDatabaseUrl, 'Warehouse coverage source second deploy');

      const { AppModule } = await import('../src/app.module');
      moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const source = moduleRef.get(PrismaService);
      const calculations = moduleRef.get(WarehouseCoverageCalculationService);
      const decisions = moduleRef.get(WarehouseCoverageDecisionService);
      await seedRestoreEvidence(source, calculations, decisions);
      const sourceSnapshot = await invariantSnapshot(source);

      const createRestore = postgresClient(POSTGRES_CLIENT_BINARIES.sql, maintenanceDatabaseUrl, [
        '--set=ON_ERROR_STOP=1',
        '--command',
        `CREATE DATABASE ${quoteIdentifier(restoreDatabase)} OWNER ${quoteIdentifier(user)};`,
      ]);
      restoreCreationState = postgresCommandOutcome(createRestore);
      requirePostgresCommandSuccess('Warehouse coverage restore database creation', createRestore);
      markDisposableRestoreDatabase(
        maintenanceDatabaseUrl,
        restoreIdentity,
        POSTGRES_CLIENT_BINARIES.sql,
      );
      requireDisposableRestoreDatabase(
        sourceDatabaseUrl,
        restoreIdentity,
        POSTGRES_CLIENT_BINARIES.sql,
      );

      runPgDumpCustom(sourceDatabaseUrl, dumpPath);
      requireDisposableRestoreDatabase(
        sourceDatabaseUrl,
        restoreIdentity,
        POSTGRES_CLIENT_BINARIES.sql,
      );
      runPgRestoreCustom(restoreDatabaseUrl, dumpPath);
      requireDisposableRestoreDatabase(
        sourceDatabaseUrl,
        restoreIdentity,
        POSTGRES_CLIENT_BINARIES.sql,
      );
      runPrismaMigrateDeploy(restoreDatabaseUrl, 'Warehouse coverage restored deploy');

      expect(await invariantSnapshot(restoreClient)).toEqual(sourceSnapshot);
    }, [
      {
        label: 'warehouse coverage source module',
        run: async () => {
          await moduleRef?.close();
        },
      },
      {
        label: 'warehouse coverage restore client',
        run: () => restoreClient.$disconnect(),
      },
      {
        label: 'warehouse coverage restore database',
        run: () => {
          if (!shouldDropDisposableRestoreDatabase(restoreCreationState)) return;
          dropDisposableRestoreDatabase(
            sourceDatabaseUrl,
            maintenanceDatabaseUrl,
            restoreIdentity,
            POSTGRES_CLIENT_BINARIES.sql,
          );
        },
      },
      {
        label: 'warehouse coverage dump directory',
        run: () => rmSync(tempDirectory, { recursive: true, force: true }),
      },
    ]);
  });
});

async function seedRestoreEvidence(
  prisma: PrismaService,
  calculations: WarehouseCoverageCalculationService,
  decisions: WarehouseCoverageDecisionService,
): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '');
  const financeUserId = `task21-restore-finance-${suffix}`;
  const counterpartyId = `task21-restore-counterparty-${suffix}`;
  const materialDefinitionId = `task21-restore-material-${suffix}`;
  const orderId = `v2-cover-task21-restore-order-${suffix}`;
  const positionId = `task21-restore-position-${suffix}`;
  const financeOrderId = `task21-restore-finance-order-${suffix}`;
  const recipeId = `task21-restore-recipe-${suffix}`;
  const rollId = `v2-cover-task21-restore-roll-${suffix}`;
  const rollCode = `TASK21-RESTORE-ROLL-${suffix}`;
  const factId = `v2-cover-task21-restore-fact-${suffix}`;
  const birka = 'Task21 custom backup and restore evidence';

  await prisma.user.upsert({
    where: { id: financeUserId },
    update: { role: 'finance', isActive: true },
    create: {
      id: financeUserId,
      externalId: financeUserId,
      login: financeUserId,
      displayName: 'Task21 restore finance actor',
      role: 'finance',
      isActive: true,
      mustChangePassword: false,
    },
  });
  await prisma.counterparty.create({
    data: {
      id: counterpartyId,
      displayName: 'Task21 restore V2 counterparty',
    },
  });
  await prisma.rawMaterialDefinition.create({
    data: {
      id: materialDefinitionId,
      name: `Task21 restore material ${suffix}`,
      normalizedName: `task21 restore material ${suffix}`,
      kind: 'base',
      status: 'active',
      createdByRole: 'admin',
    },
  });
  await prisma.commercialOrder.create({
    data: {
      id: orderId,
      orderNumber: `TASK21-RESTORE-V2-${suffix}`,
      title: 'Task21 custom restore V2 evidence',
      creatorRole: 'commercial',
      counterpartyId,
      warehouseCoverageWorkflowVersion: 2,
      commercialStage: 'sent_to_finance',
      sentToFinanceAt: new Date(),
      positions: {
        create: {
          id: positionId,
          rollCount: 1,
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1_000,
          plannedLengthM: 100,
          rawMaterialId: `task21-restore-stock-${suffix}`,
          baseRawMaterialDefinitionId: materialDefinitionId,
          spoolType: '76 мм',
          birka,
          plannedWeightKg: 40,
          recipe: {
            create: {
              id: recipeId,
              parameters: [],
              source: 'task21_restore_e2e',
              createdBy: 'warehouse_coverage_engine',
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
    recipeId,
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
      specVersion: 'warehouse-roll-coverage/v1',
      specFingerprint: fingerprintRollFact(spec),
      spec: spec as unknown as Prisma.InputJsonValue,
      sourceOrderId: orderId,
      sourcePositionId: positionId,
      actorKind: 'system',
      systemActorKey: 'warehouse_coverage_engine',
    },
  });
  await prisma.warehouseRoll.update({
    where: { id: rollId },
    data: { currentCoverageFactId: factId },
  });

  await prisma.$transaction((tx) => calculations.initializeAtInvoiceHandoff(tx, orderId));
  const verifiedState = await prisma.warehouseCoverageState.findUniqueOrThrow({
    where: { orderId },
    select: { generation: true, stateVersion: true },
  });
  await decisions.decide(
    {
      userId: financeUserId,
      role: 'finance',
      capabilities: capabilitiesForRole('finance'),
    },
    financeOrderId,
    {
      clientRequestId: randomUUID(),
      expectedGeneration: verifiedState.generation,
      expectedStateVersion: verifiedState.stateVersion,
      decision: 'use_warehouse',
    },
  );

  const v1Counterparty = await prisma.counterparty.create({
    data: { displayName: 'Task21 restore V1 counterparty' },
  });
  await prisma.commercialOrder.create({
    data: {
      orderNumber: V1_ORDER_NUMBER,
      title: 'Task21 custom restore V1 evidence',
      creatorRole: 'commercial',
      counterpartyId: v1Counterparty.id,
      warehouseCoverageWorkflowVersion: 1,
    },
  });
}

async function invariantSnapshot(
  prisma: PrismaClient | PrismaService,
): Promise<Record<string, unknown>> {
  const [
    workflowVersions,
    actorXorViolations,
    appendOnlyTriggers,
    facts,
    calculations,
    matches,
    decisions,
    commands,
    states,
    epoch,
    reservations,
    v1Rows,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{ count: number; workflowVersion: number }>>`
      SELECT
        "warehouseCoverageWorkflowVersion" AS "workflowVersion",
        COUNT(*)::int AS count
      FROM "commercial_orders"
      GROUP BY "warehouseCoverageWorkflowVersion"
      ORDER BY "warehouseCoverageWorkflowVersion"
    `,
    prisma.$queryRaw<Array<{ count: number }>>`
      SELECT (
        (
          SELECT COUNT(*)
          FROM "warehouse_roll_coverage_facts"
          WHERE
            (
              "actorKind" = 'user'
              AND (
                "actorRole" IS NULL
                OR "actorId" IS NULL
                OR "systemActorKey" IS NOT NULL
              )
            )
            OR (
              "actorKind" = 'system'
              AND (
                "actorRole" IS NOT NULL
                OR "actorId" IS NOT NULL
                OR "systemActorKey" IS NULL
              )
            )
        )
        + (
          SELECT COUNT(*)
          FROM "warehouse_coverage_decisions"
          WHERE
            (
              "actorKind" = 'user'
              AND (
                "actorRole" IS NULL
                OR "actorId" IS NULL
                OR "systemActorKey" IS NOT NULL
              )
            )
            OR (
              "actorKind" = 'system'
              AND (
                "actorRole" IS NOT NULL
                OR "actorId" IS NOT NULL
                OR "systemActorKey" IS NULL
              )
            )
        )
        + (
          SELECT COUNT(*)
          FROM "warehouse_coverage_commands"
          WHERE
            (
              "actorKind" = 'user'
              AND (
                "actorRole" IS NULL
                OR "actorId" IS NULL
                OR "systemActorKey" IS NOT NULL
              )
            )
            OR (
              "actorKind" = 'system'
              AND (
                "actorRole" IS NOT NULL
                OR "actorId" IS NOT NULL
                OR "systemActorKey" IS NULL
              )
            )
        )
      )::int AS count
    `,
    prisma.$queryRaw<Array<{ name: string; tableName: string }>>`
      SELECT
        trigger_name AS name,
        event_object_table AS "tableName"
      FROM information_schema.triggers
      WHERE trigger_schema = current_schema()
        AND trigger_name LIKE 'warehouse_coverage_%append_only%'
      ORDER BY trigger_name, event_object_table
    `,
    prisma.warehouseRollCoverageFact.findMany({
      where: { id: { startsWith: 'v2-cover-' } },
      select: {
        id: true,
        rollId: true,
        version: true,
        source: true,
        specFingerprint: true,
        actorKind: true,
        actorRole: true,
        actorId: true,
        systemActorKey: true,
      },
      orderBy: { id: 'asc' },
    }),
    prisma.warehouseCoverageCalculation.findMany({
      where: { orderId: { startsWith: 'v2-cover-' } },
      select: {
        id: true,
        orderId: true,
        generation: true,
        inputFingerprint: true,
        inventoryEpoch: true,
        availability: true,
        requiredRollCount: true,
        matchedRollCount: true,
        uncertainRollCount: true,
      },
      orderBy: [{ orderId: 'asc' }, { generation: 'asc' }],
    }),
    prisma.warehouseCoverageMatch.findMany({
      where: { orderId: { startsWith: 'v2-cover-' } },
      select: {
        id: true,
        calculationId: true,
        orderId: true,
        generation: true,
        positionId: true,
        rollId: true,
        coverageFactId: true,
        slotIndex: true,
      },
      orderBy: [{ calculationId: 'asc' }, { slotIndex: 'asc' }],
    }),
    prisma.warehouseCoverageDecision.findMany({
      where: { orderId: { startsWith: 'v2-cover-' } },
      select: {
        id: true,
        orderId: true,
        calculationId: true,
        generation: true,
        kind: true,
        inputFingerprint: true,
        sourceInventoryEpoch: true,
        committedInventoryEpoch: true,
        expectedRollCount: true,
        actorKind: true,
        actorRole: true,
        actorId: true,
        systemActorKey: true,
      },
      orderBy: [{ orderId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.warehouseCoverageCommand.findMany({
      where: { orderId: { startsWith: 'v2-cover-' } },
      select: {
        id: true,
        clientRequestId: true,
        kind: true,
        orderId: true,
        requestFingerprint: true,
        actorKind: true,
        actorRole: true,
        actorId: true,
        systemActorKey: true,
        safeResultKind: true,
        safeResult: true,
        resultKind: true,
        resultCalculationId: true,
        resultDecisionId: true,
        resultCaseId: true,
        resultGeneration: true,
        resultStateVersion: true,
      },
      orderBy: { id: 'asc' },
    }),
    prisma.warehouseCoverageState.findMany({
      where: { orderId: { startsWith: 'v2-cover-' } },
      select: {
        orderId: true,
        state: true,
        stateVersion: true,
        generation: true,
        currentCalculationId: true,
        currentDecisionId: true,
      },
      orderBy: { orderId: 'asc' },
    }),
    prisma.warehouseCoverageInventoryEpoch.findMany({
      select: { id: true, epoch: true },
      orderBy: { id: 'asc' },
    }),
    prisma.warehouseRoll.findMany({
      where: {
        OR: [
          { id: { startsWith: 'v2-cover-' } },
          { reservedForOrderId: { startsWith: 'v2-cover-' } },
        ],
      },
      select: {
        id: true,
        currentCoverageFactId: true,
        reservedForOrderId: true,
        reservedForPositionId: true,
        reservedByProposalId: true,
        reservedByCoverageDecisionId: true,
        reservedAt: true,
      },
      orderBy: { id: 'asc' },
    }),
    prisma.commercialOrder.findMany({
      where: {
        OR: [{ orderNumber: V1_ORDER_NUMBER }, { orderNumber: 'FIXTURE-PHYSICAL-SOURCE' }],
      },
      select: {
        id: true,
        orderNumber: true,
        warehouseCoverageWorkflowVersion: true,
      },
      orderBy: { orderNumber: 'asc' },
    }),
  ]);

  expect(actorXorViolations).toEqual([{ count: 0 }]);
  expect(appendOnlyTriggers.length).toBeGreaterThan(0);
  expect(facts.length).toBeGreaterThan(0);
  expect(calculations.length).toBeGreaterThan(0);
  expect(matches.length).toBeGreaterThan(0);
  expect(decisions.length).toBeGreaterThan(0);
  expect(commands.length).toBeGreaterThan(0);
  expect(states.every(({ currentCalculationId }) => currentCalculationId)).toBe(true);
  expect(epoch).toHaveLength(1);
  expect(
    reservations.some(({ reservedByCoverageDecisionId }) => Boolean(reservedByCoverageDecisionId)),
  ).toBe(true);
  expect(
    v1Rows.every(({ warehouseCoverageWorkflowVersion }) => warehouseCoverageWorkflowVersion === 1),
  ).toBe(true);

  return {
    workflowVersions,
    actorXorViolations,
    appendOnlyTriggers,
    facts,
    calculations,
    matches,
    decisions,
    commands,
    states,
    epoch,
    reservations,
    v1Rows,
  };
}
