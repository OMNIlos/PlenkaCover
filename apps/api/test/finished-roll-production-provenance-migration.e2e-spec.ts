import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET_MIGRATION = '20260727180000_finished_roll_production_provenance';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);
const FINGERPRINT = 'a'.repeat(64);

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function predecessorMigrationProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-finished-roll-provenance-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const entry of readdirSync(SOURCE_MIGRATIONS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name >= TARGET_MIGRATION) continue;
    cpSync(resolve(SOURCE_MIGRATIONS, entry.name), join(migrations, entry.name), {
      recursive: true,
    });
  }
  return project;
}

function installTargetMigration(project: string): void {
  cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
    recursive: true,
  });
}

function deploy(project: string, databaseUrl: string, label: string): void {
  assertCommandSucceeded(
    label,
    spawnSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        join(project, 'schema.prisma'),
      ],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
        encoding: 'utf8',
      },
    ),
  );
}

async function dropSchema(schema: string, databaseUrl: string): Promise<void> {
  assertSchemaDestructionTarget(schema, databaseUrl);
  const admin = new PrismaClient();
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
}

async function createHistoricalProductionRoll(
  prisma: PrismaClient,
  suffix: string,
  reservation: 'exact' | 'conflicting',
): Promise<{
  decisionId: string;
  orderId: string;
  positionId: string;
  rollId: string;
}> {
  const counterpartyId = `provenance-counterparty-${suffix}`;
  const orderId = `provenance-order-${suffix}`;
  const positionId = `provenance-position-${suffix}`;
  const calculationId = `provenance-calculation-${suffix}`;
  const decisionId = randomUUID();
  const productionId = `provenance-production-${suffix}`;
  const dispatchId = `provenance-dispatch-${suffix}`;
  const rollId = `provenance-roll-${suffix}`;
  const rollCode = `PROVENANCE-ROLL-${suffix}`;
  const factId = `provenance-fact-${suffix}`;
  const [{ epoch }] = await prisma.$queryRawUnsafe<Array<{ epoch: bigint }>>(
    `SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO "counterparties" ("id", "displayName") VALUES ($1, $2)`,
    counterpartyId,
    counterpartyId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "commercial_orders" (
       "id", "orderNumber", "creatorRole", "counterpartyId",
       "warehouseCoverageWorkflowVersion", "requestType", "updatedAt"
     ) VALUES ($1, $2, 'commercial'::"Role", $3, 2, 'client_order', CURRENT_TIMESTAMP)`,
    orderId,
    `PROVENANCE-${suffix}`,
    counterpartyId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "commercial_order_positions" (
       "id", "orderId", "rollCount", "filmType", "actualThickness",
       "accountingThickness", "version", "updatedAt"
     ) VALUES ($1, $2, 1, 'Полотно', '80 мкм', '80 мкм', 1, CURRENT_TIMESTAMP)`,
    positionId,
    orderId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "warehouse_coverage_calculations" (
       "id", "orderId", "generation", "orderVersion", "positionVersions",
       "orderFingerprint", "inventoryEpoch", "inventoryFingerprint", "inputFingerprint",
       "algorithmVersion", "policyVersion", "availability", "reasonCodes",
       "requiredRollCount", "matchedRollCount", "uncertainRollCount",
       "verifiedCandidateRollIds", "uncertainCandidateRollIds", "systemActorKey"
     ) VALUES (
       $1, $2, 1, 1, $3::jsonb, $4, $5, $4, $4,
       'warehouse-coverage-matching/v1', 'warehouse-coverage-policy/v1',
       'unavailable', '["no_compatible_rolls"]'::jsonb,
       1, 0, 0, '[]'::jsonb, '[]'::jsonb, 'warehouse_coverage_engine'
     )`,
    calculationId,
    orderId,
    JSON.stringify([{ positionId, version: 1 }]),
    FINGERPRINT,
    epoch,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "warehouse_coverage_decisions" (
       "id", "orderId", "calculationId", "generation", "kind",
       "inputFingerprint", "sourceInventoryEpoch", "expectedRollCount",
       "actorKind", "systemActorKey"
     ) VALUES (
       $1::uuid, $2, $3, 1, 'auto_produce_all', $4, $5, 0,
       'system', 'warehouse_coverage_engine'
     )`,
    decisionId,
    orderId,
    calculationId,
    FINGERPRINT,
    epoch,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "production_orders" (
       "id", "commercialOrderId", "approvalState",
       "sourceCoverageCalculationId", "sourceCoverageDecisionId",
       "sourceCoverageInputFingerprint", "sourceCoverageGeneration", "updatedAt"
     ) VALUES ($1, $2, 'approved', $3, $4::uuid, $5, 1, CURRENT_TIMESTAMP)`,
    productionId,
    orderId,
    calculationId,
    decisionId,
    FINGERPRINT,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "roll_dispatch_items" (
       "id", "rollCode", "productionOrderId", "orderLineId", "status", "updatedAt"
     ) VALUES ($1, $2, $3, $4, 'done', CURRENT_TIMESTAMP)`,
    dispatchId,
    rollCode,
    productionId,
    positionId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "warehouse_rolls" (
       "id", "rollCode", "warehouseStatus", "receivedAt", "updatedAt"
     ) VALUES ($1, $2, 'received', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    rollId,
    rollCode,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "warehouse_roll_coverage_facts"
       DISABLE TRIGGER "warehouse_roll_coverage_facts_validate_insert"`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "warehouse_roll_coverage_facts" (
         "id", "rollId", "version", "source", "specVersion", "specFingerprint",
         "spec", "sourceOrderId", "sourcePositionId", "sourceDispatchItemId",
         "actorKind", "systemActorKey"
       ) VALUES (
         $1, $2, 1, 'production_handover', 'warehouse-roll-coverage/v1', $3,
         $4::jsonb, $5, $6, $7, 'system', 'warehouse_coverage_engine'
       )`,
      factId,
      rollId,
      FINGERPRINT,
      JSON.stringify({ rollCode }),
      orderId,
      positionId,
      dispatchId,
    );
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "warehouse_roll_coverage_facts"
         ENABLE TRIGGER "warehouse_roll_coverage_facts_validate_insert"`,
    );
  }
  await prisma.$executeRawUnsafe(
    `UPDATE "warehouse_rolls" SET "currentCoverageFactId" = $1 WHERE "id" = $2`,
    factId,
    rollId,
  );

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "warehouse_rolls"
       DISABLE TRIGGER "warehouse_rolls_coverage_validate_write"`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "warehouse_rolls"
       DISABLE TRIGGER "warehouse_rolls_coverage_validate_reservations_update"`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "warehouse_rolls"
       SET
         "reservedForOrderId" = $1,
         "reservedForPositionId" = $2,
         "reservedByCoverageDecisionId" = $3::uuid,
         "reservedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $4`,
      orderId,
      reservation === 'exact' ? positionId : null,
      decisionId,
      rollId,
    );
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "warehouse_rolls"
         ENABLE TRIGGER "warehouse_rolls_coverage_validate_write"`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "warehouse_rolls"
         ENABLE TRIGGER "warehouse_rolls_coverage_validate_reservations_update"`,
    );
  }
  return { decisionId, orderId, positionId, rollId };
}

describe('finished roll production provenance migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('converts an exact historical production reservation and bumps inventory epoch', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = predecessorMigrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Finished-roll provenance predecessor deploy');
      const fixture = await createHistoricalProductionRoll(prisma, schema, 'exact');
      const before = await prisma.$queryRawUnsafe<Array<{ epoch: bigint }>>(
        `SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`,
      );
      installTargetMigration(project);
      deploy(project, databaseUrl, 'Finished-roll provenance exact upgrade');

      const rows = await prisma.$queryRawUnsafe<
        Array<{
          producedForOrderId: string | null;
          producedForPositionId: string | null;
          producedByCoverageDecisionId: string | null;
          reservedForOrderId: string | null;
          reservedForPositionId: string | null;
          reservedByCoverageDecisionId: string | null;
          reservedAt: Date | null;
        }>
      >(
        `SELECT
           "producedForOrderId", "producedForPositionId", "producedByCoverageDecisionId",
           "reservedForOrderId", "reservedForPositionId",
           "reservedByCoverageDecisionId", "reservedAt"
         FROM "warehouse_rolls"
         WHERE "id" = $1`,
        fixture.rollId,
      );
      expect(rows[0]).toEqual({
        producedForOrderId: fixture.orderId,
        producedForPositionId: fixture.positionId,
        producedByCoverageDecisionId: fixture.decisionId,
        reservedForOrderId: null,
        reservedForPositionId: null,
        reservedByCoverageDecisionId: null,
        reservedAt: null,
      });
      const after = await prisma.$queryRawUnsafe<Array<{ epoch: bigint }>>(
        `SELECT epoch FROM "warehouse_coverage_inventory_epochs" WHERE id = 1`,
      );
      expect(after[0]!.epoch).toBeGreaterThan(before[0]!.epoch);
      const trigger = await prisma.$queryRawUnsafe<Array<{ definition: string }>>(
        `SELECT pg_get_triggerdef(oid) AS definition
         FROM pg_trigger
         WHERE tgrelid = '"warehouse_rolls"'::regclass
           AND tgname = 'warehouse_rolls_coverage_epoch_update'
           AND NOT tgisinternal`,
      );
      expect(trigger[0]!.definition).toContain('producedForOrderId');
      expect(trigger[0]!.definition).toContain('producedForPositionId');
      expect(trigger[0]!.definition).toContain('producedByCoverageDecisionId');
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('aborts atomically instead of leaving a conflicting production roll unowned', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = predecessorMigrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Finished-roll conflict predecessor deploy');
      const fixture = await createHistoricalProductionRoll(prisma, schema, 'conflicting');
      installTargetMigration(project);

      expect(() => deploy(project, databaseUrl, 'Finished-roll conflicting upgrade')).toThrow(
        'Finished-roll conflicting upgrade failed',
      );
      const columns = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'warehouse_rolls'
           AND column_name IN (
             'producedForOrderId',
             'producedForPositionId',
             'producedByCoverageDecisionId'
           )`,
        schema,
      );
      expect(columns[0]?.count).toBe(0);
      const reservation = await prisma.$queryRawUnsafe<
        Array<{
          reservedForOrderId: string | null;
          reservedForPositionId: string | null;
          reservedByCoverageDecisionId: string | null;
        }>
      >(
        `SELECT
           "reservedForOrderId", "reservedForPositionId", "reservedByCoverageDecisionId"
         FROM "warehouse_rolls"
         WHERE "id" = $1`,
        fixture.rollId,
      );
      expect(reservation[0]).toEqual({
        reservedForOrderId: fixture.orderId,
        reservedForPositionId: null,
        reservedByCoverageDecisionId: fixture.decisionId,
      });
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
