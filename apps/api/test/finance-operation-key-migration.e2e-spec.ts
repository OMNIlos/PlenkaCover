import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
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
const TARGET_MIGRATION = '20260717120000_finance_operation_key_canonicalization';
const LOWER_PAYMENT_KEY = '5d974d96-c03d-4d3e-a690-60a65c031886';
const LOWER_RETRY_KEY = '7fc1ff55-6c96-482d-a56e-3036ae0801ef';

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function migrationDirectories(): string[] {
  return readdirSync(SOURCE_MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function copyPredecessorProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-finance-key-migration-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const name of migrationDirectories().filter((entry) => entry < TARGET_MIGRATION)) {
    cpSync(resolve(SOURCE_MIGRATIONS, name), join(migrations, name), { recursive: true });
  }
  return project;
}

function addTargetMigration(project: string): void {
  cpSync(
    resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION),
    join(project, 'migrations', TARGET_MIGRATION),
    { recursive: true },
  );
}

function deploy(project: string, databaseUrl: string): SpawnSyncReturns<Buffer> {
  return spawnSync(
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
    },
  );
}

async function createFinanceOrder(prisma: PrismaClient, suffix: string): Promise<string> {
  const counterpartyId = `finance-key-counterparty-${suffix}`;
  const commercialOrderId = `finance-key-order-${suffix}`;
  const financeOrderId = `finance-key-finance-order-${suffix}`;
  await prisma.$executeRaw`
    INSERT INTO "counterparties" ("id", "displayName")
    VALUES (${counterpartyId}, ${`Finance key ${suffix}`})
  `;
  await prisma.$executeRaw`
    INSERT INTO "commercial_orders" (
      "id", "orderNumber", "creatorRole", "counterpartyId", "updatedAt"
    ) VALUES (
      ${commercialOrderId}, ${`FINANCE-KEY-${suffix}`}, ${Role.finance}::"Role",
      ${counterpartyId}, CURRENT_TIMESTAMP
    )
  `;
  await prisma.$executeRaw`
    INSERT INTO "finance_orders" ("id", "commercialOrderId", "updatedAt")
    VALUES (${financeOrderId}, ${commercialOrderId}, CURRENT_TIMESTAMP)
  `;
  return financeOrderId;
}

async function createPaymentOperations(
  prisma: PrismaClient,
  financeOrderId: string,
  suffix: string,
  operationKeys: readonly string[],
): Promise<void> {
  for (const [index, operationKey] of operationKeys.entries()) {
    await prisma.$executeRaw`
      INSERT INTO "payment_operations" (
        "id", "financeOrderId", "operationKey", "operationType", "amount", "createdByRole"
      ) VALUES (
        ${`finance-key-payment-${suffix}-${index}`}, ${financeOrderId}, ${operationKey}, 'cash',
        1, ${Role.finance}::"Role"
      )
    `;
  }
}

async function createSyncJournals(
  prisma: PrismaClient,
  financeOrderId: string,
  suffix: string,
  operationKeys: readonly string[],
): Promise<void> {
  for (const [index, operationKey] of operationKeys.entries()) {
    await prisma.$executeRaw`
      INSERT INTO "sync_journals" (
        "id", "financeOrderId", "operationKey", "entity", "status", "ownerRole", "updatedAt"
      ) VALUES (
        ${`finance-key-retry-${suffix}-${index}`}, ${financeOrderId}, ${operationKey},
        'finance_order', 'ready', ${Role.finance}::"Role", CURRENT_TIMESTAMP
      )
    `;
  }
}

async function paymentOperationKeys(
  prisma: PrismaClient,
  financeOrderId: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ operationKey: string }>>`
    SELECT "operationKey"
    FROM "payment_operations"
    WHERE "financeOrderId" = ${financeOrderId}
  `;
  return rows.map(({ operationKey }) => operationKey).sort();
}

async function syncJournalKeys(prisma: PrismaClient, financeOrderId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ operationKey: string }>>`
    SELECT "operationKey"
    FROM "sync_journals"
    WHERE "financeOrderId" = ${financeOrderId}
  `;
  return rows.map(({ operationKey }) => operationKey).sort();
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

describe('finance operation-key canonicalization migration', () => {
  it('normalizes an upgrade and installs both lowercase checks atomically', async () => {
    const schema = createE2eSchemaName();
    const suffix = schema.slice(-12);
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyPredecessorProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      assertCommandSucceeded('Finance key predecessor deploy', deploy(project, databaseUrl));
      const financeOrderId = await createFinanceOrder(prisma, suffix);
      await createPaymentOperations(prisma, financeOrderId, suffix, [
        LOWER_PAYMENT_KEY.toUpperCase(),
      ]);
      await createSyncJournals(prisma, financeOrderId, suffix, [LOWER_RETRY_KEY.toUpperCase()]);

      addTargetMigration(project);
      assertCommandSucceeded('Finance key canonicalization deploy', deploy(project, databaseUrl));

      await expect(paymentOperationKeys(prisma, financeOrderId)).resolves.toEqual([
        LOWER_PAYMENT_KEY,
      ]);
      await expect(syncJournalKeys(prisma, financeOrderId)).resolves.toEqual([LOWER_RETRY_KEY]);
      const checks = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
        SELECT conname AS constraint_name
        FROM pg_constraint
        WHERE connamespace = ${schema}::regnamespace
          AND conname IN (
            'payment_operations_operationKey_lowercase_check',
            'sync_journals_operationKey_lowercase_check'
          )
      `;
      expect(checks.map((check) => check.constraint_name).sort()).toEqual([
        'payment_operations_operationKey_lowercase_check',
        'sync_journals_operationKey_lowercase_check',
      ]);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it.each(['payment', 'source retry'] as const)(
    'fails closed without changing rows when an upgrade has a %s case collision',
    async (kind) => {
      const schema = createE2eSchemaName();
      const suffix = schema.slice(-12);
      const databaseUrl = databaseUrlForSchema(schema);
      const project = copyPredecessorProject();
      const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
      try {
        assertCommandSucceeded('Finance key predecessor deploy', deploy(project, databaseUrl));
        const financeOrderId = await createFinanceOrder(prisma, suffix);
        if (kind === 'payment') {
          await createPaymentOperations(prisma, financeOrderId, suffix, [
            LOWER_PAYMENT_KEY,
            LOWER_PAYMENT_KEY.toUpperCase(),
          ]);
        } else {
          await createSyncJournals(prisma, financeOrderId, suffix, [
            LOWER_RETRY_KEY,
            LOWER_RETRY_KEY.toUpperCase(),
          ]);
        }

        addTargetMigration(project);
        expect(deploy(project, databaseUrl).status).not.toBe(0);
        const keys = await (kind === 'payment'
          ? paymentOperationKeys(prisma, financeOrderId)
          : syncJournalKeys(prisma, financeOrderId));
        expect(keys).toEqual(
          (kind === 'payment'
            ? [LOWER_PAYMENT_KEY, LOWER_PAYMENT_KEY.toUpperCase()]
            : [LOWER_RETRY_KEY, LOWER_RETRY_KEY.toUpperCase()]
          ).sort(),
        );
        const checks = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
          FROM pg_constraint
          WHERE connamespace = ${schema}::regnamespace
            AND conname IN (
              'payment_operations_operationKey_lowercase_check',
              'sync_journals_operationKey_lowercase_check'
            )
        `;
        expect(Number(checks[0]?.count)).toBe(0);
      } finally {
        await prisma.$disconnect();
        await dropSchema(schema, databaseUrl);
        rmSync(project, { recursive: true, force: true });
      }
    },
  );
});
