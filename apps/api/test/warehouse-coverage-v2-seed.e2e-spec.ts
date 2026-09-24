import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { seedPilotTestData } from '../src/common/seed/pilot-test-data';
import {
  seedWarehouseCoverageV2Fixtures,
  type WarehouseCoverageV2FixtureSeedOptions,
} from '../src/common/seed/production-seed';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { WarehouseCoverageCalculationService } from '../src/modules/warehouse-coverage/warehouse-coverage-calculation.service';
import { assertSchemaDestructionTarget, createE2eSchemaName } from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(API_ROOT, 'prisma/schema.prisma');
const SEED_SCRIPT = resolve(API_ROOT, 'prisma/seed.ts');
const EXPLICIT_OPTIONS: WarehouseCoverageV2FixtureSeedOptions = {
  appEnv: 'test',
  includeWarehouseCoverageV2Fixtures: true,
};
const FIXTURES = [
  ['V2-COVER-VERIFIED-FULL', 'verified_full'],
  ['V2-COVER-UNAVAILABLE', 'unavailable'],
  ['V2-COVER-UNKNOWN', 'unknown'],
] as const;

describe('Warehouse coverage V2 deterministic seed (e2e, PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let calculations: WarehouseCoverageCalculationService;
  let baseDatabaseUrl: string;
  let isolatedDatabaseUrl: string;
  let isolatedSchema: string;

  beforeAll(async () => {
    baseDatabaseUrl = requireDatabaseUrl();
    isolatedSchema = createE2eSchemaName();
    isolatedDatabaseUrl = databaseUrlForSchema(baseDatabaseUrl, isolatedSchema);
    assertSchemaDestructionTarget(isolatedSchema, isolatedDatabaseUrl);
    process.env.DATABASE_URL = isolatedDatabaseUrl;
    runPrismaMigrateDeploy();

    const { AppModule } = await import('../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    calculations = moduleRef.get(WarehouseCoverageCalculationService);
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
  });

  it('keeps demo CLI and pilot direct seed paths free of V2 fixtures', async () => {
    runCliSeed({
      ...process.env,
      APP_ENV: 'test',
      SEED_PROFILE: 'demo',
      SEED_WAREHOUSE_COVERAGE_V2_FIXTURES: 'true',
    });
    runCliSeed({
      ...process.env,
      APP_ENV: 'test',
      SEED_PROFILE: 'demo',
      SEED_WAREHOUSE_COVERAGE_V2_FIXTURES: 'true',
    });
    expect(await v2FixtureCount(prisma)).toBe(0);

    // Demo and pilot are alternative bootstrap profiles. Finish the synthetic demo shift before
    // exercising the pilot helper in the same isolated schema so their active assignments cannot
    // manufacture an impossible mixed-profile operator conflict.
    await prisma.shift.update({
      where: { id: 'shift-demo' },
      data: { status: 'completed', endedAt: new Date() },
    });
    await prisma.$transaction((tx) => seedPilotTestData(tx));
    await prisma.$transaction((tx) => seedPilotTestData(tx));

    expect(await v2FixtureCount(prisma)).toBe(0);
  });

  it('rejects fixture helper calls outside development/test and without literal opt-in', async () => {
    await expect(
      prisma.$transaction((tx) =>
        seedWarehouseCoverageV2Fixtures(tx, {
          appEnv: 'pilot',
          includeWarehouseCoverageV2Fixtures: true,
        } as never),
      ),
    ).rejects.toThrow('development/test only');
    await expect(
      prisma.$transaction((tx) =>
        seedWarehouseCoverageV2Fixtures(tx, {
          appEnv: 'test',
          includeWarehouseCoverageV2Fixtures: false,
        } as never),
      ),
    ).rejects.toThrow('explicit opt-in is required');
  });

  it('is idempotent in explicit opt-in mode without rewriting immutable fixture facts', async () => {
    await seedExplicitV2Fixtures(prisma);
    const first = await immutableFixtureEvidence(prisma);

    await seedExplicitV2Fixtures(prisma);

    expect(await immutableFixtureEvidence(prisma)).toEqual(first);
  });

  it.each(FIXTURES)(
    'seeds %s as %s with a real finance identity',
    async (orderNumber, availability) => {
      const order = await commercialOrderByNumber(prisma, orderNumber);

      expect(order.financeOrder?.id).toEqual(expect.any(String));
      expect((await calculateSeededOrder(prisma, calculations, order.id)).availability).toBe(
        availability,
      );
    },
  );

  it('backs verified coverage with immutable production handover facts and stable captures', async () => {
    const sourceProduction = await prisma.productionOrder.findUniqueOrThrow({
      where: { id: 'v2-cover-physical-source-production' },
      include: { dispatchItems: true },
    });
    expect(sourceProduction.indicator).toBe('ready');
    expect(sourceProduction.dispatchItems.map((item) => item.status)).toEqual(['done', 'done']);
    const full = await commercialOrderByNumber(prisma, 'V2-COVER-VERIFIED-FULL');
    const calculation = await calculateSeededOrder(prisma, calculations, full.id);
    const facts = await prisma.warehouseRollCoverageFact.findMany({
      where: { roll: { ownerCounterpartyId: full.counterpartyId } },
      include: {
        sourceDispatchItem: { select: { id: true, rollCode: true } },
        sourceWeightCapture: { select: { id: true, kind: true, stable: true, netKg: true } },
      },
      orderBy: { id: 'asc' },
    });

    expect(calculation.matchedRollCount).toBe(2);
    expect(facts).toHaveLength(2);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'production_handover',
          sourceDispatchItemId: expect.any(String),
          sourceWeightCaptureId: expect.any(String),
          sourceDispatchItem: expect.objectContaining({ rollCode: expect.any(String) }),
          sourceWeightCapture: expect.objectContaining({
            kind: 'roll',
            stable: true,
            netKg: 40,
          }),
        }),
      ]),
    );
  });

  it('does not convert compatible raw-material stock into ready-roll coverage', async () => {
    const unavailable = await commercialOrderByNumber(prisma, 'V2-COVER-UNAVAILABLE');
    const rawMaterialDefinitionId = unavailable.positions[0]?.baseRawMaterialDefinitionId;
    if (!rawMaterialDefinitionId) throw new Error('unavailable fixture material is missing');

    expect(
      await prisma.rawMaterialStock.count({
        where: { rawMaterialDefinitionId, actualQty: { gt: 0 } },
      }),
    ).toBeGreaterThan(0);
    expect(await calculateSeededOrder(prisma, calculations, unavailable.id)).toMatchObject({
      availability: 'unavailable',
      matchedRollCount: 0,
    });
  });

  it('keeps the unknown roll order-relevant and capable of closing the exact shortage', async () => {
    const unknown = await commercialOrderByNumber(prisma, 'V2-COVER-UNKNOWN');
    const calculation = await calculateSeededOrder(prisma, calculations, unknown.id);
    const uncertainRoll = await prisma.warehouseRoll.findFirstOrThrow({
      where: {
        ownerCounterpartyId: null,
        currentCoverageFact: {
          sourceOrderId: unknown.id,
          sourcePositionId: unknown.positions[0]!.id,
        },
      },
      include: { currentCoverageFact: true },
    });

    expect(uncertainRoll.currentCoverageFact).not.toBeNull();
    expect(calculation).toMatchObject({
      availability: 'unknown',
      requiredRollCount: 1,
      matchedRollCount: 0,
      uncertainRollCount: 1,
    });
  });

  it('uses the named candidate index for the verified finance-order candidate lookup', async () => {
    const full = await commercialOrderByNumber(prisma, 'V2-COVER-VERIFIED-FULL');
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return explainCandidateQuery(tx, full.financeOrder!.id);
    });

    expect(plan).toContain('warehouse_rolls_coverage_candidates_idx');
  });
});

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

function runCliSeed(env: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), SEED_SCRIPT], {
    cwd: API_ROOT,
    env,
    stdio: 'ignore',
  });
}

function seedExplicitV2Fixtures(prisma: PrismaClient | PrismaService): Promise<void> {
  return prisma.$transaction((tx) => seedWarehouseCoverageV2Fixtures(tx, EXPLICIT_OPTIONS));
}

async function v2FixtureCount(prisma: PrismaClient | PrismaService): Promise<number> {
  return prisma.commercialOrder.count({
    where: {
      OR: [{ warehouseCoverageWorkflowVersion: 2 }, { orderNumber: { startsWith: 'V2-COVER-' } }],
    },
  });
}

async function immutableFixtureEvidence(prisma: PrismaClient | PrismaService) {
  const [
    orders,
    positions,
    financeOrders,
    rolls,
    facts,
    captures,
    rawStocks,
    calculations,
    decisions,
  ] = await Promise.all([
    prisma.commercialOrder.findMany({
      where: { orderNumber: { startsWith: 'V2-COVER-' } },
      select: { id: true, orderNumber: true, createdAt: true },
      orderBy: { id: 'asc' },
    }),
    prisma.commercialOrderPosition.findMany({
      where: { order: { orderNumber: { startsWith: 'V2-COVER-' } } },
      select: { id: true, version: true },
      orderBy: { id: 'asc' },
    }),
    prisma.financeOrder.findMany({
      where: { commercialOrder: { orderNumber: { startsWith: 'V2-COVER-' } } },
      select: { id: true, commercialOrderId: true, createdAt: true },
      orderBy: { id: 'asc' },
    }),
    prisma.warehouseRoll.findMany({
      where: { rollCode: { startsWith: 'V2-COVER-' } },
      select: { id: true, currentCoverageFactId: true, createdAt: true },
      orderBy: { id: 'asc' },
    }),
    prisma.warehouseRollCoverageFact.findMany({
      where: { roll: { rollCode: { startsWith: 'V2-COVER-' } } },
      select: { id: true, specFingerprint: true, createdAt: true },
      orderBy: { id: 'asc' },
    }),
    prisma.weightCapture.findMany({
      where: { line: { rollDispatchItem: { rollCode: { startsWith: 'V2-COVER-' } } } },
      select: { id: true, netKg: true, createdAt: true },
      orderBy: { id: 'asc' },
    }),
    prisma.rawMaterialStock.findMany({
      where: { materialId: { startsWith: 'v2-cover-' } },
      select: { id: true, materialId: true, actualQty: true, revision: true },
      orderBy: { id: 'asc' },
    }),
    prisma.warehouseCoverageCalculation.count({
      where: { order: { orderNumber: { startsWith: 'V2-COVER-' } } },
    }),
    prisma.warehouseCoverageDecision.count({
      where: { order: { orderNumber: { startsWith: 'V2-COVER-' } } },
    }),
  ]);
  return {
    orders,
    positions,
    financeOrders,
    rolls,
    facts,
    captures,
    rawStocks,
    calculations,
    decisions,
  };
}

function commercialOrderByNumber(prisma: PrismaClient | PrismaService, orderNumber: string) {
  return prisma.commercialOrder.findUniqueOrThrow({
    where: { orderNumber },
    include: { financeOrder: true, positions: { orderBy: { id: 'asc' } } },
  });
}

async function calculateSeededOrder(
  prisma: PrismaService,
  calculations: WarehouseCoverageCalculationService,
  orderId: string,
) {
  const current = await prisma.warehouseCoverageState.findUniqueOrThrow({
    where: { orderId },
    include: { currentCalculation: true },
  });
  if (current.currentCalculation) return current.currentCalculation;

  await prisma.$transaction((tx) => calculations.initializeAtInvoiceHandoff(tx, orderId));
  return prisma.warehouseCoverageCalculation.findFirstOrThrow({
    where: { orderId },
    orderBy: { generation: 'desc' },
  });
}

async function explainCandidateQuery(
  tx: Prisma.TransactionClient,
  financeOrderId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(Prisma.sql`
    EXPLAIN (COSTS OFF)
    SELECT roll."id"
    FROM "warehouse_rolls" AS roll
    WHERE roll."warehouseStatus" = 'received'
      AND roll."ownerCounterpartyId" = (
        SELECT commercial."counterpartyId"
        FROM "finance_orders" AS finance
        JOIN "commercial_orders" AS commercial
          ON commercial."id" = finance."commercialOrderId"
        WHERE finance."id" = ${financeOrderId}
      )
      AND roll."reservedForOrderId" IS NULL
    ORDER BY roll."currentCoverageFactId", roll."rollCode", roll."id"
  `);
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}
