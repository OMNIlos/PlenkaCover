import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  assertCommandSucceeded,
  assertDisposableDatabaseTarget,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
  runE2eWithCleanup,
} from './e2e-database';
import {
  createDisposableRestoreDatabaseIdentity,
  dropDisposableRestoreDatabase,
  markDisposableRestoreDatabase,
  postgresCommandOutcome,
  requireBackupClientCompatibility,
  requireDisposableRestoreDatabase,
  requirePostgresCommandSuccess,
  runPostgresClient,
  shouldDropDisposableRestoreDatabase,
  type DisposableRestoreCreationState,
} from './postgres-backup-client';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(API_ROOT, 'prisma/schema.prisma');
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const POSTGRES_CLIENT_BINARIES = {
  dump: process.env.PLENKA_E2E_PG_DUMP_BIN ?? 'pg_dump',
  restore: process.env.PLENKA_E2E_PG_RESTORE_BIN ?? 'pg_restore',
  sql: process.env.PLENKA_E2E_PSQL_BIN ?? 'psql',
} as const;

interface DatabaseIdentity {
  database: string;
  user: string;
}

function requireDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  return process.env.DATABASE_URL;
}

function databaseUrlForSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function databaseUrlForDatabase(databaseUrl: string, database: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  url.searchParams.set('schema', schema);
  return url.toString();
}

function databaseIdentity(databaseUrl: string): DatabaseIdentity {
  const url = new URL(databaseUrl);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.split('.', 1)[0] === '127');
  const overridesTarget = [...url.searchParams.keys()].some((key) =>
    ['host', 'hostaddr'].includes(key.toLowerCase()),
  );
  if (!isLoopback || overridesTarget) {
    throw new Error('Backup/restore e2e requires a loopback PostgreSQL target');
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  if (!database || !user) throw new Error('E2E DATABASE_URL must include a database and user');
  return { database, user };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function postgresClient(command: string, databaseUrl: string, args: string[], input?: Buffer) {
  return runPostgresClient(command, databaseUrl, args, MAX_ARCHIVE_BYTES, input);
}

function deploy(databaseUrl: string): void {
  assertCommandSucceeded(
    'Recipe catalog restore source deploy',
    spawnSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', PRISMA_SCHEMA],
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

describe('material recipe catalog backup restore (e2e, real PostgreSQL custom dump)', () => {
  jest.setTimeout(120_000);

  it('restores catalog rows into a disposable database with exit-on-error', async () => {
    const baseDatabaseUrl = requireDatabaseUrl();
    await assertDisposableDatabaseTarget(baseDatabaseUrl);
    requireBackupClientCompatibility(baseDatabaseUrl, POSTGRES_CLIENT_BINARIES);
    const { database, user } = databaseIdentity(baseDatabaseUrl);
    const sourceSchema = createE2eSchemaName();
    const sourceDatabaseUrl = databaseUrlForSchema(baseDatabaseUrl, sourceSchema);
    const targetIdentity = createDisposableRestoreDatabaseIdentity();
    const targetDatabase = targetIdentity.database;
    const targetDatabaseUrl = databaseUrlForDatabase(baseDatabaseUrl, targetDatabase, sourceSchema);
    const maintenanceDatabaseUrl = databaseUrlForDatabase(
      baseDatabaseUrl,
      'postgres',
      sourceSchema,
    );
    const source = new PrismaClient({ datasourceUrl: sourceDatabaseUrl });
    const target = new PrismaClient({ datasourceUrl: targetDatabaseUrl });
    let targetCreationState: DisposableRestoreCreationState = 'not_attempted';

    await runE2eWithCleanup(async () => {
      deploy(sourceDatabaseUrl);
      await source.$executeRawUnsafe(
        `INSERT INTO "raw_material_definitions"
          ("id", "name", "normalizedName", "kind", "status", "createdByRole", "updatedAt")
         VALUES
          ('rmd-backup-restore-regression', 'Restore Regression Material',
           'restore regression material', 'custom', 'active', 'admin', CURRENT_TIMESTAMP)`,
      );

      const createTarget = postgresClient(POSTGRES_CLIENT_BINARIES.sql, maintenanceDatabaseUrl, [
        '--set=ON_ERROR_STOP=1',
        '--command',
        `CREATE DATABASE ${quoteIdentifier(targetDatabase)} OWNER ${quoteIdentifier(user)};`,
      ]);
      targetCreationState = postgresCommandOutcome(createTarget);
      requirePostgresCommandSuccess('Disposable catalog restore database creation', createTarget);
      markDisposableRestoreDatabase(
        maintenanceDatabaseUrl,
        targetIdentity,
        POSTGRES_CLIENT_BINARIES.sql,
      );
      requireDisposableRestoreDatabase(
        baseDatabaseUrl,
        targetIdentity,
        POSTGRES_CLIENT_BINARIES.sql,
      );

      const dump = postgresClient(POSTGRES_CLIENT_BINARIES.dump, baseDatabaseUrl, [
        `--dbname=${database}`,
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--schema=${sourceSchema}`,
      ]);
      requirePostgresCommandSuccess('Recipe catalog custom dump', dump);
      expect(dump.stdout.subarray(0, 5).toString('ascii')).toBe('PGDMP');

      requireDisposableRestoreDatabase(
        baseDatabaseUrl,
        targetIdentity,
        POSTGRES_CLIENT_BINARIES.sql,
      );
      const restore = postgresClient(
        POSTGRES_CLIENT_BINARIES.restore,
        targetDatabaseUrl,
        [`--dbname=${targetDatabase}`, '--exit-on-error', '--no-owner', '--no-privileges'],
        dump.stdout,
      );
      requirePostgresCommandSuccess('Recipe catalog custom dump restore', restore);

      const restored = await target.$queryRawUnsafe<
        Array<{ id: string; name: string; normalizedName: string }>
      >(
        `SELECT "id", "name", "normalizedName"
         FROM "raw_material_definitions"
         WHERE "id" = 'rmd-backup-restore-regression'`,
      );
      expect(restored).toEqual([
        {
          id: 'rmd-backup-restore-regression',
          name: 'Restore Regression Material',
          normalizedName: 'restore regression material',
        },
      ]);
    }, [
      {
        label: 'source Prisma client',
        run: () => source.$disconnect(),
      },
      {
        label: 'target Prisma client',
        run: () => target.$disconnect(),
      },
      {
        label: 'source schema',
        run: () => dropSchema(sourceSchema, sourceDatabaseUrl),
      },
      {
        label: 'target database',
        run: () => {
          if (!shouldDropDisposableRestoreDatabase(targetCreationState)) return;
          dropDisposableRestoreDatabase(
            baseDatabaseUrl,
            maintenanceDatabaseUrl,
            targetIdentity,
            POSTGRES_CLIENT_BINARIES.sql,
          );
        },
      },
    ]);
  });
});
