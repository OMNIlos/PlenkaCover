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
import { normalizeCatalogName } from '../src/modules/material-catalog/recipe-catalog.rules';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET_MIGRATION = '20260723130000_add_material_recipe_catalog';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function predecessorMigrationProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-recipe-catalog-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const migration of readdirSync(SOURCE_MIGRATIONS).sort()) {
    if (migration === 'migration_lock.toml' || migration >= TARGET_MIGRATION) continue;
    cpSync(resolve(SOURCE_MIGRATIONS, migration), join(migrations, migration), {
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

async function bytes(
  prisma: PrismaClient,
  query: string,
  ...values: unknown[]
): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ bytes: string }>>(query, ...values);
  const value = rows[0]?.bytes;
  if (!value) throw new Error('Fixture byte projection is missing');
  return value;
}

async function createLegacyFixture(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "raw_material_stocks"
      ("id", "materialId", "label", "actualQty", "unit", "factStatus", "updatedAt",
       "revision", "externalId", "sourceVersion")
     VALUES
      ('legacy-stock', 'legacy-material', 'Legacy PVD', 123.456789, 'кг',
       'warehouse_fact', '2026-07-23 09:30:00+00', 7, 'legacy-external', 'source-v7')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "counterparties" ("id", "displayName")
     VALUES ('legacy-recipe-counterparty', 'Legacy recipe counterparty')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "commercial_orders"
      ("id", "orderNumber", "creatorRole", "counterpartyId", "createdAt", "updatedAt")
     VALUES
      ('legacy-recipe-order', 'LEGACY-RECIPE-ORDER', 'commercial',
       'legacy-recipe-counterparty', '2026-07-23 09:31:00+00', '2026-07-23 09:32:00+00')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "commercial_order_positions"
      ("id", "orderId", "rollCount", "filmType", "actualThickness",
       "accountingThickness", "rawMaterialId", "updatedAt")
     VALUES
      ('legacy-recipe-position', 'legacy-recipe-order', 2, 'Рукав', '80 мкм',
       '80 мкм', 'legacy-material', '2026-07-23 09:33:00+00')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "recipe_snapshots"
      ("id", "positionId", "parameters", "source", "createdBy", "version", "createdAt")
     VALUES
      ('legacy-recipe-snapshot', 'legacy-recipe-position',
       '[{"label":"Сырьё","value":"Legacy PVD"},{"label":"Температура","value":"legacy"}]',
       'commercial_form', 'legacy-user', 'v7', '2026-07-23 09:34:00+00')`,
  );
}

async function createRecipeDefinition(
  prisma: PrismaClient,
  id: string,
  normalizedName: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "recipe_definitions"
      ("id", "name", "normalizedName", "clientRequestId", "requestFingerprint",
       "createdByRole", "updatedAt")
     VALUES ($1, $2, $3, $4::uuid, $5, 'commercial', CURRENT_TIMESTAMP)`,
    id,
    normalizedName,
    normalizedName,
    randomUUID(),
    'a'.repeat(64),
  );
}

describe('material recipe catalog migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('preserves legacy stock facts, orders, and recipe parameters byte-for-byte', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = predecessorMigrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Recipe catalog predecessor deploy');
      await createLegacyFixture(prisma);
      const stockBefore = await bytes(
        prisma,
        `SELECT encode(
           convert_to(
             jsonb_build_array("materialId", "externalId", "actualQty", "revision")::text,
             'UTF8'
           ),
           'hex'
         ) AS bytes
         FROM "raw_material_stocks"
         WHERE "id" = $1`,
        'legacy-stock',
      );
      const orderBefore = await bytes(
        prisma,
        `SELECT encode(convert_to(to_jsonb(row_value)::text, 'UTF8'), 'hex') AS bytes
         FROM (
           SELECT *
           FROM "commercial_orders"
           WHERE "id" = $1
         ) AS row_value`,
        'legacy-recipe-order',
      );
      const parametersBefore = await bytes(
        prisma,
        `SELECT encode(convert_to("parameters"::text, 'UTF8'), 'hex') AS bytes
         FROM "recipe_snapshots"
         WHERE "id" = $1`,
        'legacy-recipe-snapshot',
      );

      installTargetMigration(project);
      deploy(project, databaseUrl, 'Recipe catalog target deploy');

      expect(
        await bytes(
          prisma,
          `SELECT encode(
             convert_to(
               jsonb_build_array("materialId", "externalId", "actualQty", "revision")::text,
               'UTF8'
             ),
             'hex'
           ) AS bytes
           FROM "raw_material_stocks"
           WHERE "id" = $1`,
          'legacy-stock',
        ),
      ).toBe(stockBefore);
      expect(
        await bytes(
          prisma,
          `SELECT encode(convert_to(to_jsonb(row_value)::text, 'UTF8'), 'hex') AS bytes
           FROM (
             SELECT *
             FROM "commercial_orders"
             WHERE "id" = $1
           ) AS row_value`,
          'legacy-recipe-order',
        ),
      ).toBe(orderBefore);
      expect(
        await bytes(
          prisma,
          `SELECT encode(convert_to("parameters"::text, 'UTF8'), 'hex') AS bytes
           FROM "recipe_snapshots"
           WHERE "id" = $1`,
          'legacy-recipe-snapshot',
        ),
      ).toBe(parametersBefore);

      const baseDefinitions = await prisma.$queryRawUnsafe<
        Array<{ id: string; name: string; normalizedName: string }>
      >(
        `SELECT "id", "name", "normalizedName"
         FROM "raw_material_definitions"
         WHERE "kind" = 'base'
         ORDER BY "id"`,
      );
      expect(baseDefinitions).toEqual([
        { id: 'rmd-base-aika', name: 'Айка', normalizedName: 'айка' },
        { id: 'rmd-base-primary', name: 'Первичное', normalizedName: 'первичное' },
        {
          id: 'rmd-base-secondary',
          name: 'Вторичное',
          normalizedName: 'вторичное',
        },
      ]);
      const linkedStock = await prisma.$queryRawUnsafe<
        Array<{ definitionId: string | null; definitionName: string; definitionKind: string }>
      >(
        `SELECT
           stock."rawMaterialDefinitionId" AS "definitionId",
           definition."name" AS "definitionName",
           definition."kind" AS "definitionKind"
         FROM "raw_material_stocks" AS stock
         JOIN "raw_material_definitions" AS definition
           ON definition."id" = stock."rawMaterialDefinitionId"
         WHERE stock."id" = 'legacy-stock'`,
      );
      expect(linkedStock).toEqual([
        {
          definitionId: 'rmd-stock-legacy-stock',
          definitionName: 'Legacy PVD',
          definitionKind: 'custom',
        },
      ]);
      const legacySelection = await prisma.$queryRawUnsafe<
        Array<{
          baseRawMaterialDefinitionId: string | null;
          recipeDefinitionVersionId: string | null;
        }>
      >(
        `SELECT "baseRawMaterialDefinitionId", "recipeDefinitionVersionId"
         FROM "commercial_order_positions"
         WHERE "id" = 'legacy-recipe-position'`,
      );
      expect(legacySelection).toEqual([
        { baseRawMaterialDefinitionId: null, recipeDefinitionVersionId: null },
      ]);
      const legacySnapshotCatalog = await prisma.$queryRawUnsafe<
        Array<{
          ingredients: unknown;
          recipeDefinitionId: string | null;
          recipeDefinitionVersionId: string | null;
          recipeName: string | null;
          recipeVersionNumber: number | null;
        }>
      >(
        `SELECT "recipeDefinitionId", "recipeDefinitionVersionId", "recipeVersionNumber",
                "recipeName", "ingredients"
         FROM "recipe_snapshots"
         WHERE "id" = 'legacy-recipe-snapshot'`,
      );
      expect(legacySnapshotCatalog).toEqual([
        {
          ingredients: null,
          recipeDefinitionId: null,
          recipeDefinitionVersionId: null,
          recipeName: null,
          recipeVersionNumber: null,
        },
      ]);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it.each([
    ['blank stock label', ['   ']],
    ['JavaScript-trim blank stock label', ['\t']],
    ['JavaScript-trim vertical-tab stock label', ['\v']],
    ['case-insensitive duplicate stock labels', ['Case Label', ' case label ']],
    [
      'JavaScript-trim equivalent stock labels',
      ['Whitespace Label', 'Whitespace Label\t'],
    ],
  ])('aborts atomically for %s', async (_label, labels) => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = predecessorMigrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Recipe catalog preflight predecessor deploy');
      for (const [index, label] of labels.entries()) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "raw_material_stocks"
            ("id", "materialId", "label", "actualQty", "updatedAt")
           VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)`,
          `preflight-stock-${index}`,
          `preflight-material-${index}`,
          label,
        );
      }
      installTargetMigration(project);

      expect(() =>
        deploy(project, databaseUrl, 'Recipe catalog invalid-label target deploy'),
      ).toThrow('Recipe catalog invalid-label target deploy failed');

      const ddlEvidence = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_name = 'raw_material_definitions'`,
        schema,
      );
      expect(ddlEvidence[0]?.count).toBe(0);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('matches JavaScript trim without stripping a literal v from catalog names', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = predecessorMigrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Recipe catalog trim predecessor deploy');
      for (const [index, label] of ['Material', 'Materialv', ' Display Name\t'].entries()) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "raw_material_stocks"
            ("id", "materialId", "label", "actualQty", "updatedAt")
           VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)`,
          `trim-stock-${index}`,
          `trim-material-${index}`,
          label,
        );
      }
      installTargetMigration(project);
      deploy(project, databaseUrl, 'Recipe catalog trim target deploy');

      const definitions = await prisma.$queryRawUnsafe<
        Array<{ name: string; normalizedName: string }>
      >(
        `SELECT definition."name", definition."normalizedName"
         FROM "raw_material_stocks" AS stock
         JOIN "raw_material_definitions" AS definition
           ON definition."id" = stock."rawMaterialDefinitionId"
         WHERE stock."id" LIKE 'trim-stock-%'
         ORDER BY stock."id"`,
      );
      expect(definitions).toEqual([
        { name: 'Material', normalizedName: 'material' },
        { name: 'Materialv', normalizedName: 'materialv' },
        { name: 'Display Name', normalizedName: 'display name' },
      ]);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('normalizes catalog names exactly like the application', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = predecessorMigrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const names = ['İ', 'ПЕРВИЧНОЕ', 'Ａйка', '\tMixed İ Name\u00a0'];
    try {
      deploy(project, databaseUrl, 'Recipe catalog normalization predecessor deploy');
      installTargetMigration(project);
      deploy(project, databaseUrl, 'Recipe catalog normalization target deploy');

      for (const name of names) {
        const rows = await prisma.$queryRawUnsafe<Array<{ normalizedName: string }>>(
          `SELECT "normalize_material_catalog_name"($1) AS "normalizedName"`,
          name,
        );
        expect(rows[0]?.normalizedName).toBe(normalizeCatalogName(name));
      }
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('enforces deferred composition, immutable versions, and exclusive position selection', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = predecessorMigrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Recipe catalog invariant predecessor deploy');
      installTargetMigration(project);
      deploy(project, databaseUrl, 'Recipe catalog invariant target deploy');
      await createRecipeDefinition(prisma, 'recipe-valid', 'recipe-valid');

      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "recipe_definition_versions" ("id", "recipeDefinitionId", "version")
             VALUES ('recipe-empty-v1', 'recipe-valid', 1)`,
          );
        }),
      ).rejects.toThrow();

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "recipe_definition_versions" ("id", "recipeDefinitionId", "version")
           VALUES ('recipe-valid-v1', 'recipe-valid', 1)`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "recipe_ingredients"
            ("id", "recipeDefinitionVersionId", "rawMaterialDefinitionId",
             "sequence", "shareBasisPoints")
           VALUES
            ('recipe-valid-i1', 'recipe-valid-v1', 'rmd-base-primary', 1, 6000),
            ('recipe-valid-i2', 'recipe-valid-v1', 'rmd-base-secondary', 2, 4000)`,
        );
      });

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "recipe_definition_versions"
           SET "version" = 2
           WHERE "id" = 'recipe-valid-v1'`,
        ),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM "recipe_definition_versions" WHERE "id" = 'recipe-valid-v1'`,
        ),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "recipe_ingredients"
           SET "shareBasisPoints" = 5000
           WHERE "id" = 'recipe-valid-i1'`,
        ),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM "recipe_ingredients" WHERE "id" = 'recipe-valid-i1'`,
        ),
      ).rejects.toThrow();

      await createRecipeDefinition(prisma, 'recipe-invalid-sum', 'recipe-invalid-sum');
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "recipe_definition_versions" ("id", "recipeDefinitionId", "version")
             VALUES ('recipe-invalid-sum-v1', 'recipe-invalid-sum', 1)`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "recipe_ingredients"
              ("id", "recipeDefinitionVersionId", "rawMaterialDefinitionId",
               "sequence", "shareBasisPoints")
             VALUES
              ('recipe-invalid-sum-i1', 'recipe-invalid-sum-v1', 'rmd-base-primary', 1, 9000)`,
          );
        }),
      ).rejects.toThrow();

      await prisma.$executeRawUnsafe(
        `INSERT INTO "counterparties" ("id", "displayName")
         VALUES ('recipe-selection-counterparty', 'Recipe selection counterparty')`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "commercial_orders"
          ("id", "orderNumber", "creatorRole", "counterpartyId", "updatedAt")
         VALUES
          ('recipe-selection-order', 'RECIPE-SELECTION', 'commercial',
           'recipe-selection-counterparty', CURRENT_TIMESTAMP)`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "commercial_order_positions"
          ("id", "orderId", "rollCount", "filmType", "actualThickness",
           "accountingThickness", "updatedAt")
         VALUES
          ('recipe-selection-legacy', 'recipe-selection-order', 1, 'Рукав',
           '80 мкм', '80 мкм', CURRENT_TIMESTAMP)`,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "commercial_order_positions"
            ("id", "orderId", "rollCount", "filmType", "actualThickness",
             "accountingThickness", "updatedAt", "baseRawMaterialDefinitionId",
             "recipeDefinitionVersionId")
           VALUES
            ('recipe-selection-invalid', 'recipe-selection-order', 1, 'Рукав',
             '80 мкм', '80 мкм', CURRENT_TIMESTAMP, 'rmd-base-primary', 'recipe-valid-v1')`,
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
