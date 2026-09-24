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
const TARGET_MIGRATION = '20260716180000_active_operator_post_session_uniqueness';
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
  const project = mkdtempSync(join(tmpdir(), 'plenka-session-migration-'));
  const migrations = join(project, 'migrations');
  mkdirSync(migrations);
  cpSync(resolve(PRISMA_ROOT, 'schema.prisma'), join(project, 'schema.prisma'));
  cpSync(
    resolve(SOURCE_MIGRATIONS, 'migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  const selectedMigrations = migrationDirectories().filter((name) =>
    includeTarget ? name <= TARGET_MIGRATION : name < TARGET_MIGRATION,
  );
  for (const name of selectedMigrations) {
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

function isolatedMigrationCleanup(
  prisma: PrismaClient,
  schema: string,
  databaseUrl: string,
  project: string,
): E2eCleanupAction[] {
  return [
    {
      label: 'operator session migration Prisma client',
      run: () => prisma.$disconnect(),
    },
    {
      label: 'operator session migration schema',
      run: () => dropSchema(schema, databaseUrl),
    },
    {
      label: 'operator session migration project',
      run: () => rmSync(project, { recursive: true, force: true }),
    },
  ];
}

function insertPreIdempotencyShift(
  prisma: PrismaClient,
  id: string,
  label: string,
  plannedStartAt: Date,
  plannedEndAt: Date,
): Promise<number> {
  // The predecessor intentionally has no operationKey columns. A current Prisma create()
  // includes those columns in RETURNING, so use the predecessor's exact stable surface.
  return prisma.$executeRaw`
    INSERT INTO "shifts" ("id", "label", "plannedStartAt", "plannedEndAt")
    VALUES (${id}, ${label}, ${plannedStartAt}, ${plannedEndAt})
  `;
}

function insertPreCommissioningPost(
  prisma: PrismaClient,
  input: {
    id: string;
    code: string;
    name: string;
    status?: string;
    agentStatus?: string;
  },
): Promise<number> {
  // The predecessor intentionally has no commissioning/agent-compatibility columns. A current
  // Prisma create() includes them in RETURNING, so insert through that migration's exact surface.
  return prisma.$executeRaw`
    INSERT INTO "posts" (
      "id", "code", "name", "status", "agentStatus", "updatedAt"
    ) VALUES (
      ${input.id},
      ${input.code},
      ${input.name},
      ${input.status ?? 'active'},
      ${input.agentStatus ?? 'unknown'},
      CURRENT_TIMESTAMP
    )
  `;
}

function insertPreDriverDevice(
  prisma: PrismaClient,
  input: {
    id: string;
    code: string;
    kind: string;
    postId: string;
    status: string;
    isEnabled: boolean;
    parsedPayload: Record<string, unknown>;
    rawPayload: Record<string, unknown>;
    recovery: string;
  },
): Promise<number> {
  // Keep this fixture on the immediate predecessor's device surface as well.
  return prisma.$executeRaw`
    INSERT INTO "device_runtimes" (
      "id", "code", "kind", "status", "isEnabled", "postId",
      "parsedPayload", "rawPayload", "recovery", "updatedAt"
    ) VALUES (
      ${input.id},
      ${input.code},
      ${input.kind},
      ${input.status},
      ${input.isEnabled},
      ${input.postId},
      ${JSON.stringify(input.parsedPayload)}::jsonb,
      ${JSON.stringify(input.rawPayload)}::jsonb,
      ${input.recovery},
      CURRENT_TIMESTAMP
    )
  `;
}

function insertPreMaterialSelectionBigBag(
  prisma: PrismaClient,
  input: { id: string; code: string; material: string },
): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO "big_bag_units" ("id", "code", "material")
    VALUES (${input.id}, ${input.code}, ${input.material})
  `;
}

function insertPreReleasedReasonBagUsage(
  prisma: PrismaClient,
  input: {
    id: string;
    sessionId: string;
    bigBagId: string;
    startKg: number;
  },
): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO "shift_bag_usages" ("id", "sessionId", "bigBagId", "startKg")
    VALUES (${input.id}, ${input.sessionId}, ${input.bigBagId}, ${input.startKg})
  `;
}

describe('operator post session uniqueness migration', () => {
  it('is migration 32 after the immediate predecessor', () => {
    expect(existsSync(TARGET_MIGRATION_PATH)).toBe(true);
    expect(migrationDirectories().indexOf(TARGET_MIGRATION)).toBe(31);
  });

  it('rejects duplicate active operators while allowing a shared post and closed history', async () => {
    const suffix = createE2eSchemaName().split('_').at(-1) as string;
    const prisma = new PrismaClient();
    const userIds = [`migration-op-a-${suffix}`, `migration-op-b-${suffix}`];
    const postIds = [`migration-post-a-${suffix}`, `migration-post-b-${suffix}`];
    const shiftId = `migration-shift-${suffix}`;
    await runE2eWithCleanup(async () => {
      await prisma.user.createMany({
        data: userIds.map((id) => ({
          id,
          login: `${id}-login`,
          displayName: id,
          role: Role.operator,
          externalId: `${id}-external`,
        })),
      });
      await prisma.post.createMany({
        data: postIds.map((id, index) => ({
          id,
          code: `MIGRATION-${suffix}-${index}`,
          name: id,
        })),
      });
      await prisma.shift.create({
        data: {
          id: shiftId,
          label: shiftId,
          plannedStartAt: new Date(Date.now() - 60_000),
          plannedEndAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.operatorPostSession.create({
        data: {
          id: `migration-active-${suffix}`,
          operatorId: userIds[0],
          postId: postIds[0],
          shiftId,
          status: 'active',
        },
      });

      await expect(
        prisma.operatorPostSession.create({
          data: {
            id: `migration-same-operator-${suffix}`,
            operatorId: userIds[0],
            postId: postIds[1],
            shiftId,
            status: 'active',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        prisma.operatorPostSession.create({
          data: {
            id: `migration-same-post-${suffix}`,
            operatorId: userIds[1],
            postId: postIds[0],
            shiftId,
            status: 'active',
          },
        }),
      ).resolves.toMatchObject({
        operatorId: userIds[1],
        postId: postIds[0],
        status: 'active',
      });
      await expect(
        prisma.operatorPostSession.create({
          data: {
            id: `migration-closed-history-${suffix}`,
            operatorId: userIds[0],
            postId: postIds[0],
            shiftId,
            status: 'closed',
            endedAt: new Date(),
          },
        }),
      ).resolves.toMatchObject({ status: 'closed' });
    }, [
      {
        label: 'operator session direct fixture sessions',
        run: async () => {
          await prisma.operatorPostSession.deleteMany({ where: { shiftId } });
        },
      },
      {
        label: 'operator session direct fixture shift',
        run: async () => {
          await prisma.shift.deleteMany({ where: { id: shiftId } });
        },
      },
      {
        label: 'operator session direct fixture posts',
        run: async () => {
          await prisma.post.deleteMany({ where: { id: { in: postIds } } });
        },
      },
      {
        label: 'operator session direct fixture actors',
        run: async () => {
          await prisma.user.updateMany({
            where: { id: { in: userIds } },
            data: { isActive: false },
          });
        },
      },
      {
        label: 'operator session direct fixture Prisma client',
        run: () => prisma.$disconnect(),
      },
    ]);
  });

  it('deploys all 32 migrations cleanly with both partial indexes', async () => {
    expect(existsSync(TARGET_MIGRATION_PATH)).toBe(true);
    if (!existsSync(TARGET_MIGRATION_PATH)) return;
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject(true);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await runE2eWithCleanup(
      async () => {
        deploy(project, databaseUrl, 'Clean operator session migration deploy');
        const applied = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL
      `;
        const indexes = await prisma.$queryRaw<Array<{ indexdef: string; indexname: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = ${schema}
          AND indexname IN (
            'operator_post_sessions_active_operator_key',
            'operator_post_sessions_active_post_key'
          )
      `;
        expect(Number(applied[0]?.count)).toBe(32);
        expect(indexes).toHaveLength(2);
        expect(indexes.every((index) => /UNIQUE INDEX/i.test(index.indexdef))).toBe(true);
        expect(indexes.every((index) => /WHERE.*status.*active/i.test(index.indexdef))).toBe(true);
      },
      isolatedMigrationCleanup(prisma, schema, databaseUrl, project),
    );
  });

  it('upgrades the immediate predecessor by closing deterministic losers and auditing once', async () => {
    expect(existsSync(TARGET_MIGRATION_PATH)).toBe(true);
    if (!existsSync(TARGET_MIGRATION_PATH)) return;
    const predecessors = migrationDirectories().filter((name) => name < TARGET_MIGRATION);
    expect(predecessors).toHaveLength(31);
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject(false);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const tiedAt = new Date('2026-07-17T09:00:00.000Z');
    const closedAt = new Date('2026-07-17T08:00:00.000Z');
    await runE2eWithCleanup(
      async () => {
        deploy(project, databaseUrl, 'Immediate predecessor deploy');
        await prisma.user.createMany({
          data: ['op-a', 'op-b', 'op-c', 'op-d'].map((id) => ({
            id,
            login: `migration-${id}`,
            externalId: `migration-${id}`,
            displayName: id,
            role: Role.operator,
          })),
        });
        await Promise.all(
          ['post-a', 'post-b', 'post-c', 'post-d'].map((id) =>
            insertPreCommissioningPost(prisma, {
              id,
              code: `MIGRATION-${id}`,
              name: id,
              status: id === 'post-d' ? 'broken' : 'active',
              agentStatus: id === 'post-d' ? 'offline' : 'unknown',
            }),
          ),
        );
        await insertPreDriverDevice(prisma, {
          id: 'migration-device',
          code: 'MIGRATION-DEVICE',
          kind: 'scale',
          status: 'error',
          isEnabled: false,
          postId: 'post-d',
          parsedPayload: { retained: true },
          rawPayload: { retained: true },
          recovery: 'retained',
        });
        await insertPreIdempotencyShift(
          prisma,
          'migration-shift',
          'Migration shift',
          new Date('2026-07-17T06:00:00.000Z'),
          new Date('2026-07-17T14:00:00.000Z'),
        );
        await prisma.operatorPostSession.createMany({
          data: [
            {
              id: 'sess-closed-history',
              operatorId: 'op-a',
              postId: 'post-a',
              shiftId: 'migration-shift',
              status: 'closed',
              startedAt: new Date('2026-07-17T07:00:00.000Z'),
              endedAt: closedAt,
            },
            {
              id: 'sess-op-a',
              operatorId: 'op-a',
              postId: 'post-a',
              shiftId: 'migration-shift',
              status: 'active',
              startedAt: tiedAt,
            },
            {
              id: 'sess-op-z',
              operatorId: 'op-a',
              postId: 'post-b',
              shiftId: 'migration-shift',
              status: 'active',
              startedAt: tiedAt,
            },
            {
              id: 'sess-post-a',
              operatorId: 'op-b',
              postId: 'post-c',
              shiftId: 'migration-shift',
              status: 'active',
              startedAt: tiedAt,
            },
            {
              id: 'sess-post-z',
              operatorId: 'op-c',
              postId: 'post-c',
              shiftId: 'migration-shift',
              status: 'active',
              startedAt: tiedAt,
            },
          ],
        });
        await insertPreMaterialSelectionBigBag(prisma, {
          id: 'migration-bag',
          code: 'MIGRATION-BAG',
          material: 'test',
        });
        await insertPreReleasedReasonBagUsage(prisma, {
          id: 'migration-bag-usage',
          sessionId: 'sess-op-a',
          bigBagId: 'migration-bag',
          startKg: 10,
        });

        cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
          recursive: true,
        });
        deploy(project, databaseUrl, 'Operator session uniqueness upgrade');

        const sessions = await prisma.operatorPostSession.findMany({ orderBy: { id: 'asc' } });
        expect(
          sessions.filter((session) => session.status === 'active').map((session) => session.id),
        ).toEqual(['sess-op-z', 'sess-post-z']);
        for (const loserId of ['sess-op-a', 'sess-post-a']) {
          const loser = sessions.find((session) => session.id === loserId);
          expect(loser).toMatchObject({ status: 'closed' });
          expect(loser?.endedAt).toBeInstanceOf(Date);
        }
        expect(sessions.find((session) => session.id === 'sess-closed-history')?.endedAt).toEqual(
          closedAt,
        );
        const [usage] = await prisma.$queryRaw<Array<{ sessionId: string }>>`
          SELECT "sessionId"
          FROM "shift_bag_usages"
          WHERE "id" = 'migration-bag-usage'
        `;
        expect(usage).toMatchObject({ sessionId: 'sess-op-a' });

        const events = await prisma.$queryRaw<
          Array<{
            actorId: string | null;
            actorRole: Role;
            detail: { sessionId: string };
            id: string;
          }>
        >`
        SELECT "id", "actorRole", "actorId", "detail"
        FROM "domain_events"
        WHERE "type" = 'audit:operator_post_session_closed'
        ORDER BY "id" ASC
      `;
        expect(events).toHaveLength(2);
        expect(
          events.every((event) => event.actorRole === Role.admin && event.actorId === null),
        ).toBe(true);
        expect(events.map((event) => event.detail.sessionId).sort()).toEqual([
          'sess-op-a',
          'sess-post-a',
        ]);
        expect(new Set(events.map((event) => event.id)).size).toBe(2);

        const [device] = await prisma.$queryRaw<
          Array<{
            status: string;
            isEnabled: boolean;
            postId: string | null;
            parsedPayload: unknown;
            rawPayload: unknown;
            recovery: string | null;
          }>
        >`
          SELECT "status", "isEnabled", "postId", "parsedPayload", "rawPayload", "recovery"
          FROM "device_runtimes"
          WHERE "id" = 'migration-device'
        `;
        expect(device).toMatchObject({
          status: 'error',
          isEnabled: false,
          postId: 'post-d',
          parsedPayload: { retained: true },
          rawPayload: { retained: true },
          recovery: 'retained',
        });
        const [post] = await prisma.$queryRaw<Array<{ status: string; agentStatus: string }>>`
          SELECT "status", "agentStatus"
          FROM "posts"
          WHERE "id" = 'post-d'
        `;
        expect(post).toMatchObject({
          status: 'broken',
          agentStatus: 'offline',
        });

        const indexes = await prisma.$queryRaw<Array<{ indexdef: string; indexname: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = ${schema}
          AND indexname IN (
            'operator_post_sessions_active_operator_key',
            'operator_post_sessions_active_post_key'
          )
      `;
        expect(indexes).toHaveLength(2);
        expect(indexes.every((index) => /WHERE.*status.*active/i.test(index.indexdef))).toBe(true);
        await expect(
          prisma.operatorPostSession.create({
            data: {
              id: 'duplicate-operator',
              operatorId: 'op-a',
              postId: 'post-d',
              shiftId: 'migration-shift',
              status: 'active',
            },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
        await expect(
          prisma.operatorPostSession.create({
            data: {
              id: 'duplicate-post',
              operatorId: 'op-d',
              postId: 'post-b',
              shiftId: 'migration-shift',
              status: 'active',
            },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
      },
      isolatedMigrationCleanup(prisma, schema, databaseUrl, project),
    );
  });

  it('rolls back every reconciled close when a deterministic audit id already exists', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyMigrationProject(false);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const loserId = 'sess-collision-a';
    const collisionId = `migration-32-operator-post-session-close-${loserId}`;
    await runE2eWithCleanup(
      async () => {
        deploy(project, databaseUrl, 'Audit collision predecessor deploy');
        await prisma.user.create({
          data: {
            id: 'collision-op',
            login: 'migration-collision-op',
            externalId: 'migration-collision-op',
            displayName: 'collision operator',
            role: Role.operator,
          },
        });
        await Promise.all([
          insertPreCommissioningPost(prisma, {
            id: 'collision-post-a',
            code: 'MIGRATION-COLLISION-A',
            name: 'collision A',
          }),
          insertPreCommissioningPost(prisma, {
            id: 'collision-post-z',
            code: 'MIGRATION-COLLISION-Z',
            name: 'collision Z',
          }),
        ]);
        await insertPreIdempotencyShift(
          prisma,
          'collision-shift',
          'Collision shift',
          new Date('2026-07-17T06:00:00.000Z'),
          new Date('2026-07-17T14:00:00.000Z'),
        );
        await prisma.operatorPostSession.createMany({
          data: [
            {
              id: loserId,
              operatorId: 'collision-op',
              postId: 'collision-post-a',
              shiftId: 'collision-shift',
              status: 'active',
              startedAt: new Date('2026-07-17T09:00:00.000Z'),
            },
            {
              id: 'sess-collision-z',
              operatorId: 'collision-op',
              postId: 'collision-post-z',
              shiftId: 'collision-shift',
              status: 'active',
              startedAt: new Date('2026-07-17T09:00:00.000Z'),
            },
          ],
        });
        await prisma.$executeRaw`
        INSERT INTO "domain_events" (
          "id", "family", "type", "actorRole", "objectId", "detail"
        ) VALUES (
          ${collisionId},
          'audit',
          'audit:operator_post_session_opened',
          ${Role.admin}::"Role",
          'unrelated-existing-fact',
          ${JSON.stringify({ collisionFixture: true })}::jsonb
        )
      `;

        cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
          recursive: true,
        });
        expect(() => deploy(project, databaseUrl, 'Audit collision migration')).toThrow(
          'Audit collision migration failed with exit code',
        );

        const sessions = await prisma.operatorPostSession.findMany({
          where: { operatorId: 'collision-op' },
          orderBy: { id: 'asc' },
        });
        expect(sessions).toHaveLength(2);
        expect(sessions.every((session) => session.status === 'active')).toBe(true);
        expect(sessions.every((session) => session.endedAt === null)).toBe(true);
        await expect(prisma.domainEvent.count({ where: { id: collisionId } })).resolves.toBe(1);
      },
      isolatedMigrationCleanup(prisma, schema, databaseUrl, project),
    );
  });
});
