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
const TARGET_MIGRATION = '20260723110000_defect_weight_integrity';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);

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

function copyMigrationProject(includeTarget: boolean): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-defect-integrity-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const name of migrationDirectories().filter((migration) =>
    includeTarget ? migration <= TARGET_MIGRATION : migration < TARGET_MIGRATION,
  )) {
    cpSync(resolve(SOURCE_MIGRATIONS, name), join(migrations, name), { recursive: true });
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

async function createRollFixture(prisma: PrismaClient, suffix: string) {
  const counterpartyId = `defect-counterparty-${suffix}`;
  await prisma.$executeRaw`
    INSERT INTO "counterparties" ("id", "displayName")
    VALUES (${counterpartyId}, ${`Defect ${suffix}`})
  `;
  const orderId = `defect-order-${suffix}`;
  await prisma.$executeRaw`
    INSERT INTO "commercial_orders" (
      "id", "orderNumber", "creatorRole", "counterpartyId", "updatedAt"
    ) VALUES (
      ${orderId}, ${`DEFECT-${suffix}`}, ${Role.commercial}::"Role",
      ${counterpartyId}, CURRENT_TIMESTAMP
    )
  `;
  const productionId = `defect-production-${suffix}`;
  await prisma.$executeRaw`
    INSERT INTO "production_orders" (
      "id", "commercialOrderId", "approvalState", "updatedAt"
    ) VALUES (${productionId}, ${orderId}, 'approved', CURRENT_TIMESTAMP)
  `;
  const dispatch = {
    id: `defect-dispatch-${suffix}`,
    rollCode: `DEFECT-ROLL-${suffix}`,
  };
  await prisma.$executeRaw`
    INSERT INTO "roll_dispatch_items" (
      "id", "rollCode", "productionOrderId", "status", "updatedAt"
    ) VALUES (
      ${dispatch.id}, ${dispatch.rollCode}, ${productionId}, 'deferred', CURRENT_TIMESTAMP
    )
  `;
  const line = { id: `defect-line-${suffix}` };
  await prisma.$executeRaw`
    INSERT INTO "operator_roll_lines" (
      "id", "rollDispatchItemId", "step", "updatedAt"
    ) VALUES (${line.id}, ${dispatch.id}, 'deferred', CURRENT_TIMESTAMP)
  `;
  return { order: { id: orderId }, dispatch, line };
}

describe('defect provenance migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('aborts every DDL change when any open legacy defect exists', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject(false);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Defect provenance predecessor deploy');
      await prisma.$executeRawUnsafe(
        `INSERT INTO "production_problems"
          ("id", "orderId", "rollId", "actorRole", "reason", "status", "type", "createdAt")
         VALUES ($1, NULL, NULL, 'production_lead', 'legacy open defect', 'open', 'defect',
                 CURRENT_TIMESTAMP)`,
        `legacy-open-defect-${schema}`,
      );
      cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
        recursive: true,
      });

      expect(() => deploy(project, databaseUrl, 'Legacy defect provenance upgrade')).toThrow(
        'Legacy defect provenance upgrade failed',
      );

      const columns = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM information_schema.columns
         WHERE table_schema = $1
           AND (
             (table_name = 'defect_records' AND column_name = 'weightCaptureId')
             OR (table_name = 'production_problems' AND column_name = 'defectRecordId')
           )`,
        schema,
      );
      const triggers = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM information_schema.triggers
         WHERE trigger_schema = $1
           AND trigger_name IN (
             'defect_records_weight_capture_update_guard',
             'defect_records_weight_capture_delete_guard',
             'production_problems_open_defect_link_guard',
             'production_problems_defect_record_update_guard',
             'production_problems_defect_record_delete_guard'
           )`,
        schema,
      );
      expect(columns[0]?.count).toBe(0);
      expect(triggers[0]?.count).toBe(0);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('applies cleanly and enforces unique, restricted and one-way evidence links', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject(true);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Clean defect provenance deploy');
      const suffix = schema.split('_').at(-1) as string;
      const { order, dispatch, line } = await createRollFixture(prisma, suffix);
      const captures = await Promise.all(
        [1, 2, 3].map((sequence) =>
          prisma.weightCapture.create({
            data: {
              id: `defect-capture-${sequence}-${suffix}`,
              operatorRollLineId: line.id,
              kind: 'roll',
              stable: true,
              grossKg: 11 + sequence,
              spoolKg: 1,
              netKg: 10 + sequence,
              actorRole: Role.operator,
            },
          }),
        ),
      );
      const defect = await prisma.defectRecord.create({
        data: {
          id: `defect-record-1-${suffix}`,
          operatorRollLineId: line.id,
          weightCaptureId: captures[0].id,
          sourceRole: Role.operator,
          weightKg: captures[0].netKg,
          comment: 'linked defect',
          blocking: true,
        },
      });
      await expect(
        prisma.defectRecord.create({
          data: {
            id: `defect-record-duplicate-${suffix}`,
            operatorRollLineId: line.id,
            weightCaptureId: captures[0].id,
            sourceRole: Role.operator,
            comment: 'duplicate evidence',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      const secondDefect = await prisma.defectRecord.create({
        data: {
          id: `defect-record-2-${suffix}`,
          operatorRollLineId: line.id,
          weightCaptureId: captures[1].id,
          sourceRole: Role.warehouse,
          weightKg: captures[1].netKg,
          comment: 'second linked defect',
          blocking: true,
        },
      });
      const problem = { id: `defect-problem-1-${suffix}` };
      await prisma.$executeRaw`
        INSERT INTO "production_problems" (
          "id", "type", "orderId", "rollId", "actorRole", "reason", "defectRecordId"
        ) VALUES (
          ${problem.id}, 'defect', ${order.id}, ${dispatch.rollCode},
          ${Role.operator}::"Role", 'linked defect', ${defect.id}
        )
      `;
      await expect(
        prisma.$executeRaw`
          INSERT INTO "production_problems" (
            "id", "type", "orderId", "actorRole", "reason"
          ) VALUES (
            ${`defect-problem-unlinked-${suffix}`}, 'defect', ${order.id},
            ${Role.production_lead}::"Role", 'unlinked open defect must be rejected'
          )
        `,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`
          INSERT INTO "production_problems" (
            "id", "type", "orderId", "rollId", "actorRole", "reason", "defectRecordId"
          ) VALUES (
            ${`defect-problem-duplicate-${suffix}`}, 'defect', ${order.id},
            ${dispatch.rollCode}, ${Role.warehouse}::"Role", 'duplicate open roll defect',
            ${secondDefect.id}
          )
        `,
      ).rejects.toMatchObject({
        code: 'P2010',
        meta: expect.objectContaining({ code: '23505' }),
      });

      const legacyDefect = await prisma.defectRecord.create({
        data: {
          id: `defect-record-legacy-${suffix}`,
          operatorRollLineId: line.id,
          sourceRole: Role.production_lead,
          comment: 'resolved legacy evidence',
        },
      });
      await expect(
        prisma.defectRecord.update({
          where: { id: legacyDefect.id },
          data: { weightCaptureId: captures[2].id },
        }),
      ).resolves.toMatchObject({ weightCaptureId: captures[2].id });
      await expect(
        prisma.defectRecord.update({
          where: { id: legacyDefect.id },
          data: { weightCaptureId: null },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.defectRecord.update({
          where: { id: defect.id },
          data: { weightCaptureId: captures[1].id },
        }),
      ).rejects.toThrow();

      const legacyProblem = { id: `defect-problem-legacy-${suffix}` };
      await prisma.$executeRaw`
        INSERT INTO "production_problems" (
          "id", "type", "orderId", "actorRole", "reason", "status"
        ) VALUES (
          ${legacyProblem.id}, 'defect', ${order.id}, ${Role.production_lead}::"Role",
          'legacy resolved problem', 'resolved'
        )
      `;
      await expect(
        prisma.$executeRaw`
          UPDATE "production_problems" SET "status" = 'open' WHERE "id" = ${legacyProblem.id}
        `,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`
          UPDATE "production_problems"
          SET "defectRecordId" = ${secondDefect.id}, "status" = 'open'
          WHERE "id" = ${legacyProblem.id}
        `,
      ).resolves.toBe(1);
      await expect(
        prisma.$executeRaw`
          UPDATE "production_problems"
          SET "defectRecordId" = NULL
          WHERE "id" = ${legacyProblem.id}
        `,
      ).rejects.toThrow();

      await expect(
        prisma.weightCapture.delete({ where: { id: captures[0].id } }),
      ).rejects.toThrow();
      await expect(prisma.defectRecord.delete({ where: { id: defect.id } })).rejects.toThrow();
      await expect(
        prisma.$executeRaw`
          DELETE FROM "production_problems" WHERE "id" = ${problem.id}
        `,
      ).rejects.toThrow();

      const constraints = await prisma.$queryRawUnsafe<
        Array<{ confdeltype: string; confupdtype: string; conname: string }>
      >(
        `SELECT conname, confdeltype::text, confupdtype::text
         FROM pg_constraint
         WHERE connamespace = $1::regnamespace
           AND conname IN (
             'defect_records_weightCaptureId_fkey',
             'production_problems_defectRecordId_fkey'
           )
         ORDER BY conname`,
        schema,
      );
      expect(constraints).toEqual([
        {
          conname: 'defect_records_weightCaptureId_fkey',
          confdeltype: 'r',
          confupdtype: 'r',
        },
        {
          conname: 'production_problems_defectRecordId_fkey',
          confdeltype: 'r',
          confupdtype: 'r',
        },
      ]);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
