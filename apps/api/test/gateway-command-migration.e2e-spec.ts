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
const MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET = '20260717140000_gateway_command_delivery_integrity';

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function migrationProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-gateway-migration-'));
  const target = join(project, 'migrations');
  mkdirSync(target);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(resolve(MIGRATIONS, 'migration_lock.toml'), join(target, 'migration_lock.toml'));
  for (const entry of readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name < TARGET) {
      cpSync(resolve(MIGRATIONS, entry.name), join(target, entry.name), { recursive: true });
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
      { cwd: API_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'ignore' },
    ),
  );
}

describe('gateway command delivery migration', () => {
  it('upgrades legacy in-flight commands and keeps the previous writer rollback-safe', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = migrationProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      deploy(project, databaseUrl, 'Gateway predecessor migration deploy');
      await prisma.$executeRawUnsafe(`
        INSERT INTO "posts" ("id", "code", "name", "updatedAt")
        VALUES ('migration-post', 'MIGRATION-GATEWAY', 'Gateway migration', CURRENT_TIMESTAMP)
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "gateway_commands" ("id", "postId", "kind", "status") VALUES
          ('legacy-print', 'migration-post', 'print', 'in_flight'),
          ('legacy-recover', 'migration-post', 'device_recover', 'in_flight'),
          ('legacy-read', 'migration-post', 'read_scale', 'in_flight')
      `);

      cpSync(resolve(MIGRATIONS, TARGET), join(project, 'migrations', TARGET), {
        recursive: true,
      });
      deploy(project, databaseUrl, 'Gateway legacy command upgrade');

      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: string;
          status: string;
          result: Record<string, unknown> | null;
          resultFingerprint: string | null;
          deadlineAt: Date;
        }>
      >(`
        SELECT "id", "status", "result", "resultFingerprint", "deadlineAt"
        FROM "gateway_commands"
        ORDER BY "id"
      `);
      expect(rows).toEqual([
        expect.objectContaining({ id: 'legacy-print', status: 'delivery_unknown' }),
        expect.objectContaining({ id: 'legacy-read', status: 'queued' }),
        expect.objectContaining({ id: 'legacy-recover', status: 'delivery_unknown' }),
      ]);
      expect(rows.every((row) => row.deadlineAt instanceof Date)).toBe(true);
      expect(rows[0].result).toMatchObject({
        ok: false,
        status: 'delivery_unknown',
        reasonCode: 'gateway_legacy_in_flight_outcome_unknown',
      });
      expect(
        rows
          .filter((row) => row.status === 'delivery_unknown')
          .every((row) => /^[0-9a-f]{64}$/u.test(row.resultFingerprint ?? '')),
      ).toBe(true);

      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "gateway_commands" ("id", "postId", "kind", "status")
          VALUES ('rollback-writer-command', 'migration-post', 'read_scale', 'queued')
        `),
      ).resolves.toBe(1);
      await expect(
        prisma.$executeRawUnsafe(`
          UPDATE "gateway_commands"
          SET "status" = 'in_flight'
          WHERE "id" = 'rollback-writer-command' AND "status" = 'queued'
        `),
      ).resolves.toBe(1);
      const rollbackRow = await prisma.$queryRawUnsafe<
        Array<{
          status: string;
          leaseToken: string | null;
          leaseExpiresAt: Date | null;
          attempt: number;
        }>
      >(`
        SELECT "status", "leaseToken", "leaseExpiresAt", "attempt"
        FROM "gateway_commands"
        WHERE "id" = 'rollback-writer-command'
      `);
      expect(rollbackRow[0]).toMatchObject({
        status: 'in_flight',
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
        attempt: 1,
      });
    } finally {
      await prisma.$disconnect();
      assertSchemaDestructionTarget(schema, databaseUrl);
      const admin = new PrismaClient();
      try {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.$disconnect();
      }
      rmSync(project, { recursive: true, force: true });
    }
  });
});
