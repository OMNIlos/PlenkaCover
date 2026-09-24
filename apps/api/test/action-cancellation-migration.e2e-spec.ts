import { spawnSync } from 'node:child_process';
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
const TARGET_MIGRATION = '20260804210000_safe_action_corrections';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function copyPredecessorProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-action-correction-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const entry of readdirSync(SOURCE_MIGRATIONS, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name < TARGET_MIGRATION) {
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

async function insertOrder(
  prisma: PrismaClient,
  input: {
    id: string;
    invoiceStatus: 'invoiced' | 'not_invoiced';
    paymentTermsType?: string;
    withProduction?: boolean;
  },
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "commercial_orders" (
       "id", "orderNumber", "creatorRole", "updatedAt"
     ) VALUES ($1, $2, 'commercial'::"Role", CURRENT_TIMESTAMP)`,
    input.id,
    `CORRECTION-${input.id}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "finance_orders" (
       "id", "commercialOrderId", "invoiceStatus", "paymentTermsType", "updatedAt"
     ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
    `finance-${input.id}`,
    input.id,
    input.invoiceStatus,
    input.paymentTermsType ?? null,
  );
  if (input.withProduction) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "production_orders" (
         "id", "commercialOrderId", "updatedAt"
       ) VALUES ($1, $2, CURRENT_TIMESTAMP)`,
      `production-${input.id}`,
      input.id,
    );
  }
}

async function insertPrepaymentPolicy(
  prisma: PrismaClient,
  orderId: string,
  status: 'paid' | 'unpaid',
): Promise<void> {
  const financeOrderId = `finance-${orderId}`;
  const policyId = `policy-${orderId}`;
  const stageId = `stage-${orderId}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "payment_policies" (
       "id", "financeOrderId", "installmentDays", "updatedAt"
     ) VALUES ($1, $2, 30, CURRENT_TIMESTAMP)`,
    policyId,
    financeOrderId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "payment_policy_stages" (
       "id", "paymentPolicyId", "sequence", "trigger",
       "percentageBasisPoints", "offsetDays", "updatedAt"
     ) VALUES ($1, $2, 1, 'invoice_issued', 5000, 0, CURRENT_TIMESTAMP)`,
    stageId,
    policyId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "payment_schedules" (
       "id", "financeOrderId", "paymentPolicyStageId", "kind", "amount", "status"
     ) VALUES ($1, $2, $3, 'invoice_prepayment', 500, $4)`,
    `schedule-${orderId}`,
    financeOrderId,
    stageId,
    status,
  );
}

describe('safe action correction migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('backfills only a demonstrably crossed production gate without fabricating facts', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyPredecessorProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

    try {
      deploy(project, databaseUrl, 'Action correction predecessor deploy');
      await insertOrder(prisma, {
        id: 'existing-production',
        invoiceStatus: 'not_invoiced',
        withProduction: true,
      });
      await insertOrder(prisma, {
        id: 'invoiced-postpay',
        invoiceStatus: 'invoiced',
        paymentTermsType: 'postpay_100_30d',
      });
      await insertOrder(prisma, {
        id: 'satisfied-prepayment',
        invoiceStatus: 'invoiced',
      });
      await insertPrepaymentPolicy(prisma, 'satisfied-prepayment', 'paid');
      await insertOrder(prisma, {
        id: 'unsatisfied-prepayment',
        invoiceStatus: 'invoiced',
      });
      await insertPrepaymentPolicy(prisma, 'unsatisfied-prepayment', 'unpaid');

      const factsBefore = await prisma.$queryRawUnsafe<
        Array<{ paymentOperations: number; domainEvents: number }>
      >(
        `SELECT
           (SELECT COUNT(*)::int FROM "payment_operations") AS "paymentOperations",
           (SELECT COUNT(*)::int FROM "domain_events") AS "domainEvents"`,
      );

      cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
        recursive: true,
      });
      deploy(project, databaseUrl, 'Action correction target deploy');

      const rows = await prisma.$queryRawUnsafe<
        Array<{ commercialOrderId: string; productionClearedAt: Date | null }>
      >(
        `SELECT "commercialOrderId", "productionClearedAt"
         FROM "finance_orders"
         WHERE "commercialOrderId" LIKE '%production'
            OR "commercialOrderId" LIKE '%postpay'
            OR "commercialOrderId" LIKE '%prepayment'
         ORDER BY "commercialOrderId"`,
      );
      expect(rows).toEqual([
        {
          commercialOrderId: 'existing-production',
          productionClearedAt: expect.any(Date),
        },
        {
          commercialOrderId: 'invoiced-postpay',
          productionClearedAt: expect.any(Date),
        },
        {
          commercialOrderId: 'satisfied-prepayment',
          productionClearedAt: expect.any(Date),
        },
        {
          commercialOrderId: 'unsatisfied-prepayment',
          productionClearedAt: null,
        },
      ]);

      const factsAfter = await prisma.$queryRawUnsafe<
        Array<{ paymentOperations: number; domainEvents: number }>
      >(
        `SELECT
           (SELECT COUNT(*)::int FROM "payment_operations") AS "paymentOperations",
           (SELECT COUNT(*)::int FROM "domain_events") AS "domainEvents"`,
      );
      expect(factsAfter).toEqual(factsBefore);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
