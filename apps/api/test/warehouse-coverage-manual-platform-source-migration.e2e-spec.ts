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
const FINGERPRINT = 'a'.repeat(64);

const canonicalSpec = (input: { positionId: string; rollCode: string; sourceOrderId: string }) => ({
  sourceOrderId: input.sourceOrderId,
  sourcePositionId: input.positionId,
  rollCode: input.rollCode,
  ownerCounterpartyId: null,
  filmType: 'Рукав',
  actualThicknessMilliMicron: 80_000,
  accountingThicknessMilliMicron: 80_000,
  widthMilliMm: 1_700_000,
  plannedLengthMilliM: 30_000,
  birka: 'Прозрачная',
  spoolType: '76 мм',
  actualWeightMilliKg: 41_200,
  plannedWeightMilliKg: 41_200,
  recipeId: null,
  recipeVersion: null,
  recipeDefinitionId: null,
  recipeDefinitionVersionId: null,
  recipeVersionNumber: null,
  ingredients: [{ rawMaterialDefinitionId: 'coverage-material', shareBasisPoints: 10_000 }],
  policyVersion: 'warehouse-coverage-policy/v2',
});

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function copyMigrationProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-coverage-manual-platform-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const entry of readdirSync(SOURCE_MIGRATIONS, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      cpSync(resolve(SOURCE_MIGRATIONS, entry.name), join(migrations, entry.name), {
        recursive: true,
      });
    }
  }
  return project;
}

function deploy(project: string, databaseUrl: string): void {
  assertCommandSucceeded(
    'Manual platform coverage source migration deploy',
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

describe('warehouse coverage manual platform source migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('accepts canonical manual facts and rejects unknown sources after every migration', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = schema.split('_').at(-1) as string;
    const counterpartyId = `manual-platform-counterparty-${suffix}`;
    const orderId = `manual-platform-order-${suffix}`;
    const positionId = `manual-platform-position-${suffix}`;
    const userId = `manual-platform-user-${suffix}`;
    const rollId = `manual-platform-roll-${suffix}`;
    const rollCode = `MANUAL-PLATFORM-${suffix}`;
    const spec = canonicalSpec({ positionId, rollCode, sourceOrderId: orderId });

    try {
      deploy(project, databaseUrl);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "counterparties" ("id", "displayName") VALUES ($1, $2)`,
        counterpartyId,
        counterpartyId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "users" ("id", "login", "displayName", "role")
         VALUES ($1, $2, $3, 'warehouse'::"Role")`,
        userId,
        `${userId}@test.local`,
        userId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "commercial_orders" (
           "id", "orderNumber", "creatorRole", "counterpartyId",
           "warehouseCoverageWorkflowVersion", "updatedAt"
         ) VALUES ($1, $2, 'commercial'::"Role", $3, 2, CURRENT_TIMESTAMP)`,
        orderId,
        `MANUAL-PLATFORM-${suffix}`,
        counterpartyId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "commercial_order_positions" (
           "id", "orderId", "rollCount", "filmType", "actualThickness",
           "accountingThickness", "version", "updatedAt"
         ) VALUES ($1, $2, 1, 'Рукав', '80 мкм', '80 мкм', 1, CURRENT_TIMESTAMP)`,
        positionId,
        orderId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_rolls" ("id", "rollCode", "warehouseStatus", "updatedAt")
         VALUES ($1, $2, 'received', CURRENT_TIMESTAMP)`,
        rollId,
        rollCode,
      );

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_roll_coverage_facts" (
             "id", "rollId", "version", "source", "specVersion", "specFingerprint",
             "spec", "sourceOrderId", "sourcePositionId", "actorKind", "actorRole",
             "actorId", "systemActorKey", "reason"
           ) VALUES (
             $1, $2, 1, 'manual_platform', 'warehouse-roll-coverage/v1', $3,
             $4::jsonb, $5, $6, 'user', 'warehouse'::"Role", $7, NULL, $8
           )`,
          `manual-platform-fact-${suffix}`,
          rollId,
          FINGERPRINT,
          JSON.stringify(spec),
          orderId,
          positionId,
          userId,
          'Ручная регистрация готового рулона в резерве склада',
        ),
      ).resolves.toBeDefined();

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_roll_coverage_facts" (
             "id", "rollId", "version", "source", "specVersion", "specFingerprint",
             "spec", "sourceOrderId", "sourcePositionId", "actorKind", "actorRole",
             "actorId", "systemActorKey", "reason"
           ) VALUES (
             $1, $2, 2, 'manual_guess', 'warehouse-roll-coverage/v1', $3,
             $4::jsonb, $5, $6, 'user', 'warehouse'::"Role", $7, NULL, $8
           )`,
          `unknown-source-fact-${suffix}`,
          rollId,
          FINGERPRINT,
          JSON.stringify(spec),
          orderId,
          positionId,
          userId,
          'Ручная регистрация готового рулона в резерве склада',
        ),
      ).rejects.toThrow(/source|check/u);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
