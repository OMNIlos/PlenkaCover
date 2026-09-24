import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const WAREHOUSE_BOUNDARY_MIGRATION = '20260717130000_warehouse_intake_integrity';

function databaseUrlForSchema(databaseUrl: string, schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function deploy(schemaPath: string, databaseUrl: string) {
  const cli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: dirname(schemaPath),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

describe('Warehouse legacy migration (real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('removes raw wrong/excess observations before the opaque-token runtime is used', async () => {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) throw new Error('DATABASE_URL is required for migration e2e');
    const schema = `warehouse_upgrade_${randomUUID().replaceAll('-', '')}`;
    const testUrl = databaseUrlForSchema(baseUrl, schema);
    const tempRoot = mkdtempSync(join(tmpdir(), 'plenka-warehouse-upgrade-'));
    const tempPrisma = join(tempRoot, 'prisma');
    const sourcePrisma = resolve(__dirname, '../prisma');
    const sourceMigrations = join(sourcePrisma, 'migrations');
    const tempMigrations = join(tempPrisma, 'migrations');
    const allMigrations = readdirSync(sourceMigrations)
      .filter((name) => name !== 'migration_lock.toml')
      .sort();
    const legacyMigrations = allMigrations.filter(
      (name) => name < WAREHOUSE_BOUNDARY_MIGRATION,
    );
    const cleanup = new PrismaClient({ datasources: { db: { url: testUrl } } });

    try {
      mkdirSync(tempMigrations, { recursive: true });
      cpSync(join(sourcePrisma, 'schema.prisma'), join(tempPrisma, 'schema.prisma'), {
        recursive: true,
      });
      cpSync(
        join(sourceMigrations, 'migration_lock.toml'),
        join(tempMigrations, 'migration_lock.toml'),
        { recursive: true },
      );
      for (const migration of legacyMigrations) {
        cpSync(join(sourceMigrations, migration), join(tempMigrations, migration), {
          recursive: true,
        });
      }
      const schemaPath = join(tempPrisma, 'schema.prisma');
      deploy(schemaPath, testUrl);

      const rawPayload = `RAW-SCANNER-PAYLOAD-${randomUUID()}`;
      const excessRoll = `LEGACY-EXCESS-${randomUUID()}`;
      await cleanup.$executeRawUnsafe(
        `INSERT INTO "warehouse_acceptance_tasks"
          ("id", "mode", "status", "createdAt", "updatedAt")
         VALUES ($1, 'receiving', 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        'legacy-observation-task',
      );
      await cleanup.$executeRawUnsafe(
        `INSERT INTO "scan_rows" ("id", "taskId", "rollCode", "scanStatus")
         VALUES
          ('legacy-wrong-row', 'legacy-observation-task', $1, 'wrong'),
          ('legacy-excess-row', 'legacy-observation-task', $2, 'excess')`,
        rawPayload,
        excessRoll,
      );

      cpSync(
        join(sourceMigrations, WAREHOUSE_BOUNDARY_MIGRATION),
        join(tempMigrations, WAREHOUSE_BOUNDARY_MIGRATION),
        { recursive: true },
      );
      deploy(schemaPath, testUrl);

      await cleanup.$executeRawUnsafe(
        `INSERT INTO "users" ("id", "login", "displayName", "role", "createdAt", "updatedAt")
         VALUES ('legacy-warehouse-user', 'legacy-warehouse-user', 'Legacy Warehouse',
                 'warehouse', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      await cleanup.$executeRawUnsafe(
        `INSERT INTO "posts" ("id", "code", "name", "createdAt", "updatedAt")
         VALUES ('legacy-warehouse-post', 'LEGACY-WH', 'Legacy Warehouse Post',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      await cleanup.$executeRawUnsafe(
        `INSERT INTO "sessions" ("id", "userId", "tokenHash", "expiresAt")
         VALUES ('legacy-warehouse-session', 'legacy-warehouse-user', $1,
                 CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
        'a'.repeat(64),
      );
      await cleanup.$executeRawUnsafe(
        `INSERT INTO "scan_rows" ("id", "taskId", "rollCode", "scanStatus")
         VALUES ('legacy-control-row', 'legacy-observation-task', 'LEGACY-CONTROL-ROLL', 'accepted')`,
      );
      await cleanup.$executeRawUnsafe(
        `INSERT INTO "warehouse_operations" (
           "id", "operationKey", "kind", "status", "taskId", "scanRowId", "rollCode",
           "actorId", "sessionId", "postId", "requestFingerprint"
         ) VALUES (
           'legacy-unleased-control', $1::uuid, 'control_weight', 'in_progress',
           'legacy-observation-task', 'legacy-control-row', 'LEGACY-CONTROL-ROLL',
           'legacy-warehouse-user', 'legacy-warehouse-session', 'legacy-warehouse-post', $2
         )`,
        randomUUID(),
        'b'.repeat(64),
      );

      for (const migration of allMigrations.filter(
        (name) => name > WAREHOUSE_BOUNDARY_MIGRATION,
      )) {
        cpSync(join(sourceMigrations, migration), join(tempMigrations, migration), {
          recursive: true,
        });
      }
      deploy(schemaPath, testUrl);

      const observations = await cleanup.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM "scan_rows"
         WHERE "rollCode" IN ($1, $2)
            OR "scanStatus" NOT IN ('expected', 'accepted', 'reserved', 'damaged')`,
        rawPayload,
        excessRoll,
      );
      expect(observations[0]?.count).toBe(0);
      const removedColumns = await cleanup.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM information_schema.columns
         WHERE table_schema = $1
           AND (
             (table_name = 'warehouse_acceptance_tasks' AND column_name = 'lastScan')
             OR (table_name = 'operator_roll_lines' AND column_name = 'qrCode')
           )`,
        schema,
      );
      expect(removedColumns[0]?.count).toBe(0);
      const legacyLease = await cleanup.$queryRawUnsafe<
        Array<{
          status: string;
          errorCode: string | null;
          leaseToken: string | null;
          leaseExpiresAt: Date | null;
        }>
      >(
        `SELECT "status", "errorCode", "leaseToken", "leaseExpiresAt"
         FROM "warehouse_operations"
         WHERE "id" = 'legacy-unleased-control'`,
      );
      expect(legacyLease).toEqual([
        {
          status: 'expired',
          errorCode: 'WAREHOUSE_CONTROL_WEIGHT_LEASE_EXPIRED',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    } finally {
      await cleanup.$disconnect();
      const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
      try {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.$disconnect();
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });
});
