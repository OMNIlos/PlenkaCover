import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient, Role } from '@prisma/client';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET_MIGRATION = '20260723120000_operator_operation_leases';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function copyMigrationProject(includeTarget: boolean): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-operator-lease-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const entry of readdirSync(SOURCE_MIGRATIONS, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (includeTarget ? entry.name <= TARGET_MIGRATION : entry.name < TARGET_MIGRATION)
    ) {
      cpSync(resolve(SOURCE_MIGRATIONS, entry.name), join(migrations, entry.name), {
        recursive: true,
      });
    }
  }
  return project;
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
        stdio: 'ignore',
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

async function createFixture(prisma: PrismaClient, suffix: string) {
  const actor = await prisma.user.create({
    data: {
      id: `lease-user-${suffix}`,
      login: `lease-user-${suffix}`,
      passwordHash: 'migration-only',
      displayName: `Lease ${suffix}`,
      role: Role.operator,
    },
  });
  const post = {
    id: `lease-post-${suffix}`,
    code: `LEASE-${suffix}`,
  };
  await prisma.$executeRaw`
    INSERT INTO "posts" ("id", "code", "name", "status", "updatedAt")
    VALUES (
      ${post.id}, ${post.code}, ${`Lease ${suffix}`}, 'active', CURRENT_TIMESTAMP
    )
  `;
  const session = await prisma.operatorPostSession.create({
    data: {
      id: `lease-session-${suffix}`,
      operatorId: actor.id,
      postId: post.id,
      status: 'active',
    },
  });
  const counterpartyId = `lease-counterparty-${suffix}`;
  await prisma.$executeRaw`
    INSERT INTO "counterparties" ("id", "displayName")
    VALUES (${counterpartyId}, ${`Lease ${suffix}`})
  `;
  const orderId = `lease-order-${suffix}`;
  await prisma.$executeRaw`
    INSERT INTO "commercial_orders" (
      "id", "orderNumber", "creatorRole", "counterpartyId", "updatedAt"
    ) VALUES (
      ${orderId}, ${`LEASE-${suffix}`}, ${Role.commercial}::"Role",
      ${counterpartyId}, CURRENT_TIMESTAMP
    )
  `;
  const productionId = `lease-production-${suffix}`;
  await prisma.$executeRaw`
    INSERT INTO "production_orders" (
      "id", "commercialOrderId", "approvalState", "updatedAt"
    ) VALUES (${productionId}, ${orderId}, 'approved', CURRENT_TIMESTAMP)
  `;
  const dispatchId = `lease-dispatch-${suffix}`;
  await prisma.$executeRaw`
    INSERT INTO "roll_dispatch_items" (
      "id", "rollCode", "productionOrderId", "status", "updatedAt"
    ) VALUES (
      ${dispatchId}, ${`LEASE-ROLL-${suffix}`}, ${productionId}, 'assigned', CURRENT_TIMESTAMP
    )
  `;
  const line = { id: `lease-line-${suffix}` };
  await prisma.$executeRaw`
    INSERT INTO "operator_roll_lines" (
      "id", "rollDispatchItemId", "step", "updatedAt"
    ) VALUES (${line.id}, ${dispatchId}, 'roll_weight', CURRENT_TIMESTAMP)
  `;
  return { actor, post, session, line };
}

function insertLegacyOperation(
  prisma: PrismaClient,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: { id: string; operationKey: string; status: 'in_progress' | 'succeeded' },
) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "operator_roll_operations" (
       "id", "operationKey", "operatorRollLineId", "action", "actorId",
       "postSessionId", "postId", "requestFingerprint", "expectedStep",
       "resultStep", "status", "httpStatus", "completedAt"
     ) VALUES ($1, $2, $3, 'defect', $4, $5, $6, $7, 'roll_weight',
       $8, $9, $10, $11)`,
    input.id,
    input.operationKey,
    fixture.line.id,
    fixture.actor.id,
    fixture.session.id,
    fixture.post.id,
    '0'.repeat(64),
    input.status === 'succeeded' ? 'deferred' : null,
    input.status,
    input.status === 'succeeded' ? 200 : null,
    input.status === 'succeeded' ? new Date() : null,
  );
}

describe('operator physical-operation lease migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('aborts atomically when an unfenced physical operation is still in progress', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject(false);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Operator lease predecessor deploy');
      const fixture = await createFixture(prisma, schema.split('_').at(-1) as string);
      await insertLegacyOperation(prisma, fixture, {
        id: `legacy-in-progress-${schema}`,
        operationKey: `legacy-in-progress-${schema}`,
        status: 'in_progress',
      });
      cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
        recursive: true,
      });

      expect(() => deploy(project, databaseUrl, 'Unsafe operator lease upgrade')).toThrow(
        'Unsafe operator lease upgrade failed',
      );

      const columns = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'operator_roll_operations'
           AND column_name IN ('attempt', 'leaseToken', 'leaseExpiresAt')`,
        schema,
      );
      const indexes = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM pg_indexes
         WHERE schemaname = $1
           AND indexname = 'operator_roll_operations_status_leaseExpiresAt_idx'`,
        schema,
      );
      expect(columns[0]?.count).toBe(0);
      expect(indexes[0]?.count).toBe(0);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('backfills terminal history and enforces physical lease constraints', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject(false);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Operator lease clean predecessor deploy');
      const fixture = await createFixture(prisma, schema.split('_').at(-1) as string);
      const historicKey = `historic-success-${schema}`;
      await insertLegacyOperation(prisma, fixture, {
        id: historicKey,
        operationKey: historicKey,
        status: 'succeeded',
      });
      cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
        recursive: true,
      });
      deploy(project, databaseUrl, 'Operator lease clean upgrade');

      const historic = await prisma.$queryRawUnsafe<
        Array<{ attempt: number; leaseToken: string | null; leaseExpiresAt: Date | null }>
      >(
        `SELECT "attempt", "leaseToken", "leaseExpiresAt"
         FROM "operator_roll_operations"
         WHERE "operationKey" = $1`,
        historicKey,
      );
      expect(historic[0]).toEqual({ attempt: 1, leaseToken: null, leaseExpiresAt: null });

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "operator_roll_operations" (
             "id", "operationKey", "operatorRollLineId", "action", "actorId",
             "postSessionId", "postId", "requestFingerprint", "expectedStep", "status", "attempt"
           ) VALUES ($1, $2, $3, 'defect', $4, $5, $6, $7, 'roll_weight', 'in_progress', 1)`,
          `unfenced-${schema}`,
          `unfenced-${schema}`,
          fixture.line.id,
          fixture.actor.id,
          fixture.session.id,
          fixture.post.id,
          '1'.repeat(64),
        ),
      ).rejects.toThrow();

      const leasedKey = `leased-${schema}`;
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "operator_roll_operations" (
             "id", "operationKey", "operatorRollLineId", "action", "actorId",
             "postSessionId", "postId", "requestFingerprint", "expectedStep", "status",
             "attempt", "leaseToken", "leaseExpiresAt"
           ) VALUES ($1, $2, $3, 'defect', $4, $5, $6, $7, 'roll_weight', 'in_progress',
             1, $8::uuid, CURRENT_TIMESTAMP + INTERVAL '1 minute')`,
          leasedKey,
          leasedKey,
          fixture.line.id,
          fixture.actor.id,
          fixture.session.id,
          fixture.post.id,
          '2'.repeat(64),
          '88c962a9-e75a-4cc6-96f4-1b5d02f88c1b',
        ),
      ).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
