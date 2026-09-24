import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient, Role } from '@prisma/client';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
  type E2eCleanupAction,
  runE2eWithCleanup,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET_MIGRATION = '20260724140000_warehouse_coverage_v2_foundation';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);
const SYSTEM_ACTOR_KEY = 'warehouse_coverage_engine';

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
  const project = mkdtempSync(join(tmpdir(), 'plenka-coverage-v2-foundation-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  for (const name of migrationDirectories().filter((migration) => migration < TARGET_MIGRATION)) {
    cpSync(resolve(SOURCE_MIGRATIONS, name), join(migrations, name), { recursive: true });
  }
  return project;
}

function addTargetMigration(project: string): void {
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

function isolatedMigrationCleanup(
  prisma: PrismaClient,
  schema: string,
  databaseUrl: string,
  project: string,
): E2eCleanupAction[] {
  return [
    {
      label: 'warehouse coverage foundation Prisma client',
      run: () => prisma.$disconnect(),
    },
    {
      label: 'warehouse coverage foundation schema',
      run: () => dropSchema(schema, databaseUrl),
    },
    {
      label: 'warehouse coverage foundation project',
      run: () => rmSync(project, { recursive: true, force: true }),
    },
  ];
}

async function insertActorEvent(
  prisma: PrismaClient,
  eventId: string,
  actorKind: string,
  actorRole: Role | null,
  actorId: string | null,
  systemActorKey: string | null,
): Promise<unknown> {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "domain_events" (
       "id", "family", "type", "actorKind", "actorRole", "actorId", "systemActorKey"
     ) VALUES ($1, 'audit', 'audit:warehouse_coverage_calculated',
       $2, $3::"Role", $4, $5
     )`,
    eventId,
    actorKind,
    actorRole,
    actorId,
    systemActorKey,
  );
}

async function appendOnlyTriggers(
  prisma: PrismaClient,
): Promise<Array<{ definition: string; level: 'ROW' | 'STATEMENT'; name: string }>> {
  return prisma.$queryRaw<
    Array<{ definition: string; level: 'ROW' | 'STATEMENT'; name: string }>
  >`
    SELECT
      trigger_row.tgname AS name,
      CASE
        WHEN (trigger_row.tgtype::integer & 1) = 1 THEN 'ROW'
        ELSE 'STATEMENT'
      END AS level,
      pg_get_triggerdef(trigger_row.oid) AS definition
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'domain_events'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname IN (
        'domain_events_append_only',
        'domain_events_append_only_truncate'
      )
    ORDER BY trigger_row.tgname
  `;
}

describe('warehouse coverage V2 foundation migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('installs the discriminated actor columns, restricted FK, check and immutable trigger', async () => {
    const prisma = new PrismaClient();
    await runE2eWithCleanup(async () => {
      const columns = await prisma.$queryRaw<
        Array<{ columnDefault: string | null; columnName: string; isNullable: 'NO' | 'YES' }>
      >`
        SELECT
          column_name AS "columnName",
          is_nullable AS "isNullable",
          column_default AS "columnDefault"
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'domain_events'
          AND column_name IN ('actorKind', 'actorRole', 'systemActorKey')
        ORDER BY column_name
      `;
      expect(columns).toEqual([
        {
          columnName: 'actorKind',
          isNullable: 'NO',
          columnDefault: "'user'::text",
        },
        {
          columnName: 'actorRole',
          isNullable: 'YES',
          columnDefault: null,
        },
        {
          columnName: 'systemActorKey',
          isNullable: 'YES',
          columnDefault: null,
        },
      ]);

      const constraints = await prisma.$queryRaw<
        Array<{ deleteAction: string | null; definition: string; name: string }>
      >`
        SELECT
          constraint_row.conname AS name,
          pg_get_constraintdef(constraint_row.oid) AS definition,
          CASE constraint_row.confdeltype
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'a' THEN 'NO ACTION'
            ELSE constraint_row.confdeltype::text
          END AS "deleteAction"
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.connamespace = current_schema()::regnamespace
          AND constraint_row.conname IN (
            'domain_events_actor_xor',
            'domain_events_actorId_fkey'
          )
        ORDER BY constraint_row.conname
      `;
      expect(constraints).toEqual([
        expect.objectContaining({
          name: 'domain_events_actorId_fkey',
          deleteAction: 'RESTRICT',
        }),
        expect.objectContaining({
          name: 'domain_events_actor_xor',
          definition: expect.stringContaining('warehouse_coverage_engine'),
        }),
      ]);

      const triggers = await appendOnlyTriggers(prisma);
      expect(triggers).toEqual([
        {
          name: 'domain_events_append_only',
          level: 'ROW',
          definition: expect.stringMatching(
            /BEFORE (?:DELETE OR UPDATE|UPDATE OR DELETE).*FOR EACH ROW/u,
          ),
        },
        {
          name: 'domain_events_append_only_truncate',
          level: 'STATEMENT',
          definition: expect.stringMatching(/BEFORE TRUNCATE.*FOR EACH STATEMENT/u),
        },
      ]);

      const functions = await prisma.$queryRaw<Array<{ configuration: string[] | null }>>`
        SELECT function_row.proconfig AS configuration
        FROM pg_proc AS function_row
        JOIN pg_namespace AS namespace_row ON namespace_row.oid = function_row.pronamespace
        WHERE namespace_row.nspname = current_schema()
          AND function_row.proname = 'reject_domain_event_mutation'
      `;
      expect(functions).toEqual([
        { configuration: expect.arrayContaining(['search_path=pg_catalog']) },
      ]);
    }, [
      {
        label: 'warehouse coverage foundation metadata client',
        run: () => prisma.$disconnect(),
      },
    ]);
  });

  it('rejects mixed actors and every event mutation while accepting exact actors', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    const userId = `coverage-foundation-user-${suffix}`;
    const userEventId = `coverage-foundation-user-event-${suffix}`;
    const systemEventId = `coverage-foundation-system-event-${suffix}`;
    await runE2eWithCleanup(async () => {
      await prisma.user.create({
        data: {
          id: userId,
          login: `${userId}@test.local`,
          displayName: userId,
          role: Role.finance,
        },
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "domain_events" (
           "id", "family", "type", "actorRole", "actorId", "label"
         ) VALUES (
           $1, 'audit', 'audit:payment_status_updated', 'finance'::"Role", $2, 'original'
         )`,
        userEventId,
        userId,
      );
      await insertActorEvent(prisma, systemEventId, 'system', null, null, SYSTEM_ACTOR_KEY);

      const invalidActors: ReadonlyArray<
        readonly [string, string, Role | null, string | null, string | null]
      > = [
        ['mixed-role', 'system', Role.admin, null, SYSTEM_ACTOR_KEY],
        ['mixed-user', 'system', null, userId, SYSTEM_ACTOR_KEY],
        ['wrong-system', 'system', null, null, 'unknown_engine'],
        ['system-without-key', 'system', null, null, null],
        ['user-without-role', 'user', null, null, null],
        ['user-with-system-key', 'user', Role.finance, null, SYSTEM_ACTOR_KEY],
        ['unknown-kind', 'robot', null, null, SYSTEM_ACTOR_KEY],
      ];
      for (const [label, kind, role, actorId, key] of invalidActors) {
        await expect(
          insertActorEvent(
            prisma,
            `coverage-foundation-invalid-${label}-${suffix}`,
            kind,
            role,
            actorId,
            key,
          ),
        ).rejects.toThrow(/domain_events_actor_xor/u);
      }

      await expect(
        prisma.domainEvent.update({
          where: { id: userEventId },
          data: { label: 'mutated' },
        }),
      ).rejects.toThrow(/append.only/u);
      await expect(prisma.domainEvent.delete({ where: { id: systemEventId } })).rejects.toThrow(
        /append.only/u,
      );
      await expect(prisma.user.delete({ where: { id: userId } })).rejects.toMatchObject({
        code: 'P2003',
      });

      await expect(
        prisma.domainEvent.findUniqueOrThrow({
          where: { id: userEventId },
          select: { label: true },
        }),
      ).resolves.toEqual({ label: 'original' });
      await expect(
        prisma.domainEvent.count({ where: { id: { in: [userEventId, systemEventId] } } }),
      ).resolves.toBe(2);
    }, [
      {
        // Domain events and their actor are durable facts. The global E2E harness drops
        // this run's exact isolated schema after every suite has completed.
        label: 'warehouse coverage foundation actor client',
        run: () => prisma.$disconnect(),
      },
    ]);
  });

  it('rejects TRUNCATE without removing durable events', async () => {
    const prisma = new PrismaClient();
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    const sentinelEventId = `coverage-foundation-truncate-sentinel-${suffix}`;
    await runE2eWithCleanup(async () => {
      await insertActorEvent(
        prisma,
        sentinelEventId,
        'system',
        null,
        null,
        SYSTEM_ACTOR_KEY,
      );

      await expect(
        prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe('TRUNCATE TABLE "domain_events" CASCADE');
          throw new Error('TRUNCATE unexpectedly succeeded');
        }),
      ).rejects.toThrow(/domain_events is append-only/u);

      await expect(
        prisma.domainEvent.count({ where: { id: sentinelEventId } }),
      ).resolves.toBe(1);
    }, [
      {
        label: 'warehouse coverage foundation truncate client',
        run: () => prisma.$disconnect(),
      },
    ]);
  });

  it('preserves and backfills legacy rows and treats a second deploy as a no-op', async () => {
    expect(existsSync(TARGET_MIGRATION_PATH)).toBe(true);
    const schema = createE2eSchemaName();
    const suffix = schema.split('_').at(-1) as string;
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyPredecessorProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const userId = `coverage-upgrade-user-${suffix}`;
    const eventId = `coverage-upgrade-event-${suffix}`;
    await runE2eWithCleanup(
      async () => {
        deploy(project, databaseUrl, 'Warehouse coverage foundation predecessor deploy');
        await prisma.$executeRawUnsafe(
          `INSERT INTO "users" ("id", "login", "displayName", "role")
         VALUES ($1, $2, $3, 'warehouse'::"Role")`,
          userId,
          `${userId}@test.local`,
          `Legacy actor ${suffix}`,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "domain_events" (
           "id", "family", "type", "objectId", "actorRole", "actorId",
           "label", "detail", "reason", "sourceSnapshotId"
         ) VALUES (
           $1, 'audit', 'audit:warehouse_roll_received', $2,
           'warehouse'::"Role", $3, 'legacy label',
           '{"preserved":true}'::jsonb, 'legacy reason', 'snapshot-legacy'
         )`,
          eventId,
          `roll-${suffix}`,
          userId,
        );

        addTargetMigration(project);
        deploy(project, databaseUrl, 'Warehouse coverage foundation upgrade');

        const upgraded = await prisma.$queryRawUnsafe<
          Array<{
            actorId: string | null;
            actorKind: string;
            actorRole: Role | null;
            detail: { preserved: boolean };
            label: string | null;
            objectId: string | null;
            reason: string | null;
            sourceSnapshotId: string | null;
            systemActorKey: string | null;
            type: string;
          }>
        >(
          `SELECT
           "type", "objectId", "actorKind", "actorRole", "actorId", "systemActorKey",
           "label", "detail", "reason", "sourceSnapshotId"
         FROM "domain_events"
         WHERE "id" = $1`,
          eventId,
        );
        expect(upgraded).toEqual([
          {
            type: 'audit:warehouse_roll_received',
            objectId: `roll-${suffix}`,
            actorKind: 'user',
            actorRole: Role.warehouse,
            actorId: userId,
            systemActorKey: null,
            label: 'legacy label',
            detail: { preserved: true },
            reason: 'legacy reason',
            sourceSnapshotId: 'snapshot-legacy',
          },
        ]);

        deploy(project, databaseUrl, 'Warehouse coverage foundation second deploy');

        const applied = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM "_prisma_migrations"
        WHERE migration_name = ${TARGET_MIGRATION}
          AND finished_at IS NOT NULL
      `;
        expect(applied).toEqual([{ count: 1 }]);
        expect(await appendOnlyTriggers(prisma)).toEqual([
          {
            name: 'domain_events_append_only',
            level: 'ROW',
            definition: expect.stringMatching(
              /BEFORE (?:DELETE OR UPDATE|UPDATE OR DELETE).*FOR EACH ROW/u,
            ),
          },
          {
            name: 'domain_events_append_only_truncate',
            level: 'STATEMENT',
            definition: expect.stringMatching(/BEFORE TRUNCATE.*FOR EACH STATEMENT/u),
          },
        ]);
        await expect(prisma.domainEvent.count({ where: { id: eventId } })).resolves.toBe(1);
      },
      isolatedMigrationCleanup(prisma, schema, databaseUrl, project),
    );
  });
});
