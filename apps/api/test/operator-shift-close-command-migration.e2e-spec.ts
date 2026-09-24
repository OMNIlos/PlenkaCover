import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET_MIGRATION = '20260808070000_add_operator_shift_close_commands';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function copyPredecessorProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-shift-close-'));
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

const RESULT_SNAPSHOT = {
  balance: {
    producedKg: 0,
    defectKg: 0,
    expectedUsageKg: 0,
    actualUsageKg: 0,
    deviationPercent: 0,
    status: 'ok',
  },
  problemId: null,
  releasedRollIds: [],
  closingPayroll: {
    sessionId: 'session-placeholder',
    shiftId: 'shift-placeholder',
    status: 'empty',
    summary: {
      payableAmountKopecks: 0,
      payableKg: 0,
      machineShiftCount: 0,
      unresolvedKg: 0,
      unresolvedFactCount: 0,
      excludedDefectKg: 0,
      excludedDefectRollCount: 0,
    },
    breakdown: [],
    unresolved: [],
  },
} satisfies Prisma.InputJsonObject;

type CloseOwner = {
  operatorId: string;
  sessionId: string;
  shiftId: string;
  postId: string;
  assignmentId: string;
};

async function createOwner(prisma: PrismaClient, suffix: string): Promise<CloseOwner> {
  const operator = await prisma.user.create({
    data: {
      login: `shift-close-${suffix}-${randomUUID()}`,
      displayName: `Оператор ${suffix}`,
      role: 'operator',
    },
  });
  const post = await prisma.post.create({
    data: { code: `SHIFT-CLOSE-${suffix}-${randomUUID()}`, name: `Пост ${suffix}` },
  });
  const shift = await prisma.shift.create({
    data: {
      label: `Смена ${suffix}`,
      status: 'closed',
      startedAt: new Date('2026-08-08T06:00:00.000Z'),
      endedAt: new Date('2026-08-08T18:00:00.000Z'),
    },
  });
  const assignment = await prisma.operatorShiftMachineAssignment.create({
    data: {
      shiftId: shift.id,
      operatorId: operator.id,
      postId: post.id,
      status: 'completed',
    },
  });
  const session = await prisma.operatorPostSession.create({
    data: {
      operatorId: operator.id,
      postId: post.id,
      shiftId: shift.id,
      status: 'closed',
      startedAt: new Date('2026-08-08T06:00:00.000Z'),
      endedAt: new Date('2026-08-08T18:00:00.000Z'),
    },
  });
  return {
    operatorId: operator.id,
    sessionId: session.id,
    shiftId: shift.id,
    postId: post.id,
    assignmentId: assignment.id,
  };
}

function commandData(owner: CloseOwner, operationKey: string, suffix: string) {
  return {
    operationKey,
    requestFingerprint: suffix.repeat(64),
    ...owner,
    actorRole: 'operator' as const,
    resultSnapshot: {
      ...RESULT_SNAPSHOT,
      closingPayroll: {
        ...RESULT_SNAPSHOT.closingPayroll,
        sessionId: owner.sessionId,
        shiftId: owner.shiftId,
      },
    } satisfies Prisma.InputJsonObject,
  };
}

describe('operator shift close command migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('migrates additively and enforces replay ownership, concurrency, rollback, and immutability', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyPredecessorProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const racer = new PrismaClient({ datasourceUrl: databaseUrl });

    try {
      deploy(project, databaseUrl, 'Operator shift close predecessor deploy');
      const firstOwner = await createOwner(prisma, 'a');
      const secondOwner = await createOwner(prisma, 'b');
      const invalidOwner = await createOwner(prisma, 'invalid');
      const relationOwner = await createOwner(prisma, 'relation');
      const foreignOwner = await createOwner(prisma, 'foreign');
      const roleOwner = await createOwner(prisma, 'role');
      const resultOwner = await createOwner(prisma, 'result');
      const countsBefore = await prisma.$queryRawUnsafe<
        Array<{
          users: number;
          posts: number;
          shifts: number;
          assignments: number;
          sessions: number;
          events: number;
        }>
      >(`SELECT
          (SELECT COUNT(*)::int FROM "users") AS "users",
          (SELECT COUNT(*)::int FROM "posts") AS "posts",
          (SELECT COUNT(*)::int FROM "shifts") AS "shifts",
          (SELECT COUNT(*)::int FROM "operator_shift_machine_assignments") AS "assignments",
          (SELECT COUNT(*)::int FROM "operator_post_sessions") AS "sessions",
          (SELECT COUNT(*)::int FROM "domain_events") AS "events"`);

      cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
        recursive: true,
      });
      deploy(project, databaseUrl, 'Operator shift close target deploy');

      const countsAfter = await prisma.$queryRawUnsafe<typeof countsBefore>(`SELECT
          (SELECT COUNT(*)::int FROM "users") AS "users",
          (SELECT COUNT(*)::int FROM "posts") AS "posts",
          (SELECT COUNT(*)::int FROM "shifts") AS "shifts",
          (SELECT COUNT(*)::int FROM "operator_shift_machine_assignments") AS "assignments",
          (SELECT COUNT(*)::int FROM "operator_post_sessions") AS "sessions",
          (SELECT COUNT(*)::int FROM "domain_events") AS "events"`);
      expect(countsAfter).toEqual(countsBefore);

      const rollbackKey = randomUUID();
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.operatorShiftCloseCommand.create({
            data: commandData(firstOwner, rollbackKey, 'a'),
          });
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');
      await expect(
        prisma.operatorShiftCloseCommand.count({ where: { operationKey: rollbackKey } }),
      ).resolves.toBe(0);

      const mutationRollbackKey = randomUUID();
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.operatorShiftCloseCommand.create({
            data: commandData(invalidOwner, mutationRollbackKey, 'd'),
          });
          await tx.operatorShiftCloseCommand.update({
            where: { operationKey: mutationRollbackKey },
            data: { requestFingerprint: 'e'.repeat(64) },
          });
        }),
      ).rejects.toThrow(/append-only/u);
      await expect(
        prisma.operatorShiftCloseCommand.count({
          where: { operationKey: mutationRollbackKey },
        }),
      ).resolves.toBe(0);

      const concurrentKey = randomUUID();
      const attempts = await Promise.allSettled([
        prisma.operatorShiftCloseCommand.create({
          data: commandData(firstOwner, concurrentKey, 'b'),
        }),
        racer.operatorShiftCloseCommand.create({
          data: commandData(secondOwner, concurrentKey, 'c'),
        }),
      ]);
      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const stored = await prisma.operatorShiftCloseCommand.findUniqueOrThrow({
        where: { operationKey: concurrentKey },
      });
      expect(stored.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(stored.resultSnapshot).toEqual(
        expect.objectContaining({ closingPayroll: expect.any(Object) }),
      );

      await expect(
        prisma.operatorShiftCloseCommand.update({
          where: { operationKey: concurrentKey },
          data: { requestFingerprint: 'd'.repeat(64) },
        }),
      ).rejects.toThrow(/append-only/u);
      await expect(
        prisma.operatorShiftCloseCommand.delete({ where: { operationKey: concurrentKey } }),
      ).rejects.toThrow(/append-only/u);
      await expect(
        prisma.$executeRawUnsafe('TRUNCATE TABLE "operator_shift_close_commands"'),
      ).rejects.toThrow(/append-only/u);

      await expect(
        prisma.operatorShiftCloseCommand.create({
          data: commandData(invalidOwner, randomUUID(), 'X'),
        }),
      ).rejects.toThrow(/fingerprint|check constraint/u);

      await expect(
        prisma.operatorShiftCloseCommand.create({
          data: {
            ...commandData(relationOwner, randomUUID(), 'f'),
            assignmentId: foreignOwner.assignmentId,
          },
        }),
      ).rejects.toThrow(/assignment_owner|foreign key constraint/u);

      await expect(
        prisma.operatorShiftCloseCommand.create({
          data: {
            ...commandData(roleOwner, randomUUID(), 'a'),
            actorRole: 'director',
          },
        }),
      ).rejects.toThrow(/actor_role|check constraint/u);

      const mismatchedResult = commandData(resultOwner, randomUUID(), 'b');
      mismatchedResult.resultSnapshot.closingPayroll.sessionId = relationOwner.sessionId;
      await expect(
        prisma.operatorShiftCloseCommand.create({ data: mismatchedResult }),
      ).rejects.toThrow(/result_ownership|check constraint/u);

      await expect(
        prisma.operatorPostSession.delete({ where: { id: stored.sessionId } }),
      ).rejects.toThrow(/foreign key constraint|session_owner/u);
      await expect(
        prisma.operatorShiftCloseCommand.count({ where: { operationKey: concurrentKey } }),
      ).resolves.toBe(1);
      await expect(prisma.domainEvent.count()).resolves.toBe(countsBefore[0]!.events);
    } finally {
      await Promise.all([prisma.$disconnect(), racer.$disconnect()]);
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
