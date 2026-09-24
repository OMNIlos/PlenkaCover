import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
  runE2eWithCleanup,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const PRE_SELECTION_MIGRATION = '20260807070000_warehouse_inventory_received_at_cursor_index';
const PRE_SELECTION_MIGRATION_COUNT = 95;
const SELECTION_MIGRATION = '20260807071000_warehouse_pallet_selection';
const VOID_MIGRATION = '20260807072000_warehouse_pallet_void_lifecycle';

function migrationDirectories(): string[] {
  return readdirSync(SOURCE_MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function copyMigrationProject(throughExclusive: string): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-pallet-void-upgrade-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const migration of migrationDirectories().filter((name) => name < throughExclusive)) {
    cpSync(resolve(SOURCE_MIGRATIONS, migration), join(migrations, migration), {
      recursive: true,
    });
  }
  return project;
}

function addMigration(project: string, migration: string): void {
  cpSync(resolve(SOURCE_MIGRATIONS, migration), join(project, 'migrations', migration), {
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

describe('warehouse pallet selection → void migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('is present in a clean deploy with the active-membership partial uniqueness boundary', async () => {
    const prisma = new PrismaClient();
    await runE2eWithCleanup(async () => {
      const expectedMigrations = migrationDirectories();
      const selectionIndex = expectedMigrations.indexOf(SELECTION_MIGRATION);
      expect(selectionIndex).toBe(PRE_SELECTION_MIGRATION_COUNT);
      expect(expectedMigrations[selectionIndex - 1]).toBe(PRE_SELECTION_MIGRATION);
      expect(expectedMigrations[selectionIndex + 1]).toBe(VOID_MIGRATION);
      const migrations = await prisma.$queryRaw<
        Array<{ finishedAt: Date | null; migrationName: string; rolledBackAt: Date | null }>
      >`
          SELECT
            migration_name AS "migrationName",
            finished_at AS "finishedAt",
            rolled_back_at AS "rolledBackAt"
          FROM "_prisma_migrations"
          ORDER BY migration_name
        `;
      expect(migrations).toHaveLength(expectedMigrations.length);
      expect(migrations.map((migration) => migration.migrationName)).toEqual(expectedMigrations);
      expect(
        migrations.every(
          (migration) => migration.finishedAt instanceof Date && migration.rolledBackAt === null,
        ),
      ).toBe(true);
      expect(migrations[selectionIndex]?.migrationName).toBe(SELECTION_MIGRATION);
      expect(migrations[selectionIndex + 1]?.migrationName).toBe(VOID_MIGRATION);

      const indexes = await prisma.$queryRaw<Array<{ definition: string; name: string }>>`
          SELECT indexname AS name, indexdef AS definition
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'warehouse_pallet_items_active_scan_row_uq'
        `;
      expect(indexes).toEqual([
        {
          name: 'warehouse_pallet_items_active_scan_row_uq',
          definition: expect.stringMatching(
            /UNIQUE INDEX .* ON .*warehouse_pallet_items.*scanRowId.*WHERE \("releasedAt" IS NULL\)/u,
          ),
        },
      ]);
    }, [{ label: 'pallet migration clean-deploy client', run: () => prisma.$disconnect() }]);
  });

  it('upgrades populated pre-selection pallet evidence through both migrations without deletion', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject(SELECTION_MIGRATION);
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const suffix = randomUUID().replaceAll('-', '');
    const orderId = `pallet-upgrade-order-${suffix}`;
    const taskId = `pallet-upgrade-task-${suffix}`;
    const scanRowId = `pallet-upgrade-row-${suffix}`;
    const sealedPalletId = `pallet-upgrade-sealed-${suffix}`;
    const openPalletId = `pallet-upgrade-open-${suffix}`;
    const voidedPalletId = `pallet-upgrade-voided-${suffix}`;
    const releasedItemId = `pallet-upgrade-released-item-${suffix}`;
    const activeItemId = `pallet-upgrade-active-item-${suffix}`;
    const documentId = `pallet-upgrade-document-${suffix}`;
    const rollCode = `PALLET-UPGRADE-ROLL-${suffix}`;
    const sealedAt = new Date('2026-08-07T09:00:00.000Z');
    const immutablePayload = {
      printReady: true,
      templateVersion: 'pallet-100x150-v1',
      label: {
        templateVersion: 'pallet-100x150-v1',
        palletId: `PAL-UPGRADE-SEALED-${suffix}`,
      },
    };

    await runE2eWithCleanup(async () => {
      deploy(project, databaseUrl, 'Pre-selection pallet migration history');
      const expectedPreSelection = migrationDirectories().filter(
        (migration) => migration < SELECTION_MIGRATION,
      );
      expect(expectedPreSelection).toHaveLength(PRE_SELECTION_MIGRATION_COUNT);
      expect(expectedPreSelection.at(-1)).toBe(PRE_SELECTION_MIGRATION);
      const appliedPreSelection = await prisma.$queryRaw<Array<{ migrationName: string }>>`
        SELECT migration_name AS "migrationName"
        FROM "_prisma_migrations"
        ORDER BY migration_name
      `;
      expect(appliedPreSelection.map((migration) => migration.migrationName)).toEqual(
        expectedPreSelection,
      );

      await prisma.$executeRawUnsafe(
        `INSERT INTO "commercial_orders" (
           "id", "orderNumber", "creatorRole", "createdAt", "updatedAt"
         ) VALUES ($1, $2, 'commercial', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        orderId,
        `PALLET-UPGRADE-${suffix}`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_acceptance_tasks" (
           "id", "mode", "status", "operationCode", "orderId", "createdAt", "updatedAt"
         ) VALUES ($1, 'receiving', 'open', $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        taskId,
        `ПР-UPGRADE-${suffix}`,
        orderId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "scan_rows" (
           "id", "taskId", "rollCode", "fromOrderId", "scanStatus", "lastScanAt"
         ) VALUES ($1, $2, $3, $4, 'accepted', CURRENT_TIMESTAMP)`,
        scanRowId,
        taskId,
        rollCode,
        orderId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_pallets" (
           "id", "palletCode", "taskId", "orderId", "sequenceNo", "status",
           "closeRequestId", "sealedAt", "createdAt", "updatedAt"
         ) VALUES ($1, $2, $3, $4, 1, 'sealed', $5::uuid, $6,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        sealedPalletId,
        `PAL-UPGRADE-SEALED-${suffix}`,
        taskId,
        orderId,
        randomUUID(),
        sealedAt,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_pallet_items" (
           "id", "palletId", "scanRowId", "orderId", "rollCode", "position",
           "acceptedAt", "createdAt"
         ) VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        releasedItemId,
        sealedPalletId,
        scanRowId,
        orderId,
        rollCode,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "pallet_list_documents" (
           "id", "palletId", "warehousePalletId", "acceptanceTaskId", "origin",
           "rollIds", "orderIds", "generatedByRole", "format", "fieldSetStatus",
           "payload", "createdAt"
         ) VALUES (
           $1, $2, $3, $4, 'physical_pallet', $5::jsonb, $6::jsonb, 'warehouse',
           'label_100x150', 'template_v1', $7::jsonb, CURRENT_TIMESTAMP
         )`,
        documentId,
        `PAL-UPGRADE-SEALED-${suffix}`,
        sealedPalletId,
        taskId,
        JSON.stringify([rollCode]),
        JSON.stringify([orderId]),
        JSON.stringify(immutablePayload),
      );

      const beforeSelection = await prisma.$queryRaw<
        Array<{
          documentId: string;
          itemId: string;
          orderIds: unknown;
          palletId: string;
          payload: unknown;
          rollIds: unknown;
          scanTokenCount: number;
        }>
      >`
        SELECT
          document."id" AS "documentId",
          item."id" AS "itemId",
          document."orderIds" AS "orderIds",
          pallet."id" AS "palletId",
          document."payload" AS "payload",
          document."rollIds" AS "rollIds",
          count(token.*)::int AS "scanTokenCount"
        FROM "warehouse_pallets" pallet
        JOIN "warehouse_pallet_items" item ON item."palletId" = pallet."id"
        JOIN "pallet_list_documents" document ON document."warehousePalletId" = pallet."id"
        LEFT JOIN "pallet_scan_tokens" token ON token."documentId" = document."id"
        WHERE pallet."id" = ${sealedPalletId}
        GROUP BY document."id", item."id", pallet."id"
      `;
      expect(beforeSelection).toEqual([
        {
          documentId,
          itemId: releasedItemId,
          orderIds: [orderId],
          palletId: sealedPalletId,
          payload: immutablePayload,
          rollIds: [rollCode],
          scanTokenCount: 1,
        },
      ]);

      addMigration(project, SELECTION_MIGRATION);
      deploy(project, databaseUrl, 'Pallet selection migration over populated legacy rows');
      const appliedSelection = await prisma.$queryRaw<Array<{ migrationName: string }>>`
        SELECT migration_name AS "migrationName"
        FROM "_prisma_migrations"
        ORDER BY migration_name
      `;
      expect(appliedSelection.map((migration) => migration.migrationName)).toEqual([
        ...expectedPreSelection,
        SELECTION_MIGRATION,
      ]);
      await expect(
        prisma.$queryRaw`
          SELECT "id", "palletId", "scanRowId", "orderId", "rollCode", "position"
          FROM "warehouse_pallet_items"
          WHERE "id" = ${releasedItemId}
        `,
      ).resolves.toEqual([
        {
          id: releasedItemId,
          palletId: sealedPalletId,
          scanRowId,
          orderId,
          rollCode,
          position: 1,
        },
      ]);

      await prisma.$executeRawUnsafe(
        `UPDATE "warehouse_pallet_items"
         SET "releasedAt" = CURRENT_TIMESTAMP, "releaseReason" = 'manual_deselection'
         WHERE "id" = $1`,
        releasedItemId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_pallets" (
           "id", "palletCode", "taskId", "orderId", "sequenceNo", "status",
           "closeRequestId", "sealedAt", "createdAt", "updatedAt"
         ) VALUES
           ($1, $2, $3, $4, 2, 'open', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
           ($5, $6, $3, $4, 3, 'voided', $7::uuid, $8,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        openPalletId,
        `PAL-UPGRADE-OPEN-${suffix}`,
        taskId,
        orderId,
        voidedPalletId,
        `PAL-UPGRADE-VOIDED-${suffix}`,
        randomUUID(),
        sealedAt,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "warehouse_pallet_items" (
           "id", "palletId", "scanRowId", "orderId", "rollCode", "position",
           "acceptedAt", "createdAt"
         ) VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        activeItemId,
        openPalletId,
        scanRowId,
        orderId,
        rollCode,
      );

      addMigration(project, VOID_MIGRATION);
      deploy(project, databaseUrl, 'Pallet void lifecycle migration');
      const appliedAfter = await prisma.$queryRaw<Array<{ migrationName: string }>>`
        SELECT migration_name AS "migrationName"
        FROM "_prisma_migrations"
        ORDER BY migration_name
      `;
      expect(appliedAfter.map((migration) => migration.migrationName)).toEqual([
        ...expectedPreSelection,
        SELECTION_MIGRATION,
        VOID_MIGRATION,
      ]);

      const upgraded = await prisma.$queryRaw<
        Array<{
          id: string;
          status: string;
          voidReason: string | null;
          voidedAt: Date | null;
        }>
      >`
        SELECT "id", "status", "voidedAt", "voidReason"
        FROM "warehouse_pallets"
        WHERE "id" = ${voidedPalletId}
      `;
      expect(upgraded).toEqual([
        {
          id: voidedPalletId,
          status: 'voided',
          voidedAt: sealedAt,
          voidReason: 'other',
        },
      ]);

      const memberships = await prisma.$queryRaw<
        Array<{ active: number; released: number; total: number }>
      >`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE "releasedAt" IS NULL)::int AS active,
          count(*) FILTER (WHERE "releasedAt" IS NOT NULL)::int AS released
        FROM "warehouse_pallet_items"
        WHERE "scanRowId" = ${scanRowId}
      `;
      expect(memberships).toEqual([{ active: 1, released: 1, total: 2 }]);

      const afterVoid = await prisma.$queryRaw<
        Array<{
          documentId: string;
          orderIds: unknown;
          palletId: string;
          payload: unknown;
          rollIds: unknown;
          scanTokenCount: number;
        }>
      >`
        SELECT
          document."id" AS "documentId",
          document."orderIds" AS "orderIds",
          pallet."id" AS "palletId",
          document."payload" AS "payload",
          document."rollIds" AS "rollIds",
          count(token.*)::int AS "scanTokenCount"
        FROM "warehouse_pallets" pallet
        JOIN "pallet_list_documents" document ON document."warehousePalletId" = pallet."id"
        LEFT JOIN "pallet_scan_tokens" token ON token."documentId" = document."id"
        WHERE pallet."id" = ${sealedPalletId}
        GROUP BY document."id", pallet."id"
      `;
      expect(afterVoid).toEqual([
        {
          documentId,
          orderIds: [orderId],
          palletId: sealedPalletId,
          payload: immutablePayload,
          rollIds: [rollCode],
          scanTokenCount: 1,
        },
      ]);
      await expect(
        prisma.$queryRaw<Array<{ documents: number; items: number; pallets: number }>>`
          SELECT
            (SELECT count(*)::int FROM "pallet_list_documents"
             WHERE "id" = ${documentId}) AS documents,
            (SELECT count(*)::int FROM "warehouse_pallet_items"
             WHERE "id" IN (${releasedItemId}, ${activeItemId})) AS items,
            (SELECT count(*)::int FROM "warehouse_pallets"
             WHERE "id" IN (${sealedPalletId}, ${openPalletId}, ${voidedPalletId})) AS pallets
        `,
      ).resolves.toEqual([{ documents: 1, items: 2, pallets: 3 }]);

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "warehouse_pallet_items" (
             "id", "palletId", "scanRowId", "orderId", "rollCode", "position",
             "acceptedAt", "createdAt"
           ) VALUES ($1, $2, $3, $4, $5, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          `pallet-upgrade-duplicate-active-${suffix}`,
          openPalletId,
          scanRowId,
          orderId,
          rollCode,
        ),
      ).rejects.toMatchObject({
        code: 'P2010',
        meta: expect.objectContaining({ code: '23505' }),
      });
    }, [
      { label: 'pallet predecessor-upgrade client', run: () => prisma.$disconnect() },
      {
        label: 'pallet predecessor-upgrade schema',
        run: () => dropSchema(schema, databaseUrl),
      },
      {
        label: 'pallet predecessor-upgrade project',
        run: () => rmSync(project, { recursive: true, force: true }),
      },
    ]);
  });
});
