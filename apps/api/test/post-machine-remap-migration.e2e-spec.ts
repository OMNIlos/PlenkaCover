import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY } from '../src/common/audit/audit-actor';
import {
  LEGACY_PAYROLL_TARIFF_MATRIX_V1,
  resolvePayrollRollRate,
} from '../src/common/payroll-tariffs/payroll-tariff-engine';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET_MIGRATION = '20260827070000_post1_post4_machine_remap';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);
const REASON = 'Исправление соответствия POST-1/POST-4 станкам';

const EMPTY_CLOSE_RESULT = {
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
    sessionId: '',
    shiftId: '',
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

type PostSnapshot = {
  code: string;
  invariant: Prisma.JsonValue;
  name: string;
};

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function copyPredecessorProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-post-machine-remap-'));
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

function runDeploy(project: string, databaseUrl: string): SpawnSyncReturns<Buffer> {
  return spawnSync(
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
  );
}

function deployPredecessor(project: string, databaseUrl: string): void {
  assertCommandSucceeded('Post remap predecessor deploy', runDeploy(project, databaseUrl));
}

function deployTarget(project: string, databaseUrl: string): SpawnSyncReturns<Buffer> {
  cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
    recursive: true,
  });
  return runDeploy(project, databaseUrl);
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

async function postSnapshots(prisma: PrismaClient): Promise<PostSnapshot[]> {
  return prisma.$queryRaw<PostSnapshot[]>`
    SELECT "code", "name", to_jsonb(posts) - 'name' AS "invariant"
    FROM "posts"
    WHERE "code" IN ('POST-1', 'POST-4')
    ORDER BY "code"
  `;
}

async function withPredecessor(
  work: (context: { databaseUrl: string; prisma: PrismaClient; project: string }) => Promise<void>,
): Promise<void> {
  const schema = createE2eSchemaName();
  const databaseUrl = databaseUrlForSchema(schema);
  const project = copyPredecessorProject();
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    deployPredecessor(project, databaseUrl);
    await work({ databaseUrl, prisma, project });
  } finally {
    await prisma.$disconnect();
    await dropSchema(schema, databaseUrl);
    rmSync(project, { recursive: true, force: true });
  }
}

async function createRuntimeFixture(prisma: PrismaClient) {
  const [post1, post4] = await Promise.all([
    prisma.post.update({
      where: { code: 'POST-1' },
      data: {
        status: 'active',
        agentStatus: 'online',
        lastSeenAt: new Date('2026-08-27T04:00:00.000Z'),
        agentProtocolVersion: 2,
        agentPackageVersion: 'fixture-post-1',
        agentReleaseCommit: '1'.repeat(40),
        agentBootId: randomUUID(),
        agentStartedAt: new Date('2026-08-27T03:00:00.000Z'),
        agentCapabilities: ['weight.read.v1', 'label.print.v1', 'scan.ingest.v1'],
        agentCompatibility: 'compatible',
        agentTokenHash: '1'.repeat(64),
      },
    }),
    prisma.post.update({
      where: { code: 'POST-4' },
      data: {
        status: 'active',
        agentStatus: 'offline',
        lastSeenAt: new Date('2026-08-27T02:00:00.000Z'),
        agentProtocolVersion: 2,
        agentPackageVersion: 'fixture-post-4',
        agentReleaseCommit: '4'.repeat(40),
        agentBootId: randomUUID(),
        agentStartedAt: new Date('2026-08-27T01:00:00.000Z'),
        agentCapabilities: ['weight.read.v1', 'label.print.v1', 'scan.ingest.v1'],
        agentCompatibility: 'compatible',
        agentTokenHash: '4'.repeat(64),
      },
    }),
  ]);

  await prisma.deviceRuntime.createMany({
    data: [post1, post4].flatMap((post) =>
      ['scale', 'printer', 'scanner'].map((kind) => ({
        id: `remap-${post.code.toLowerCase()}-${kind}`,
        code: `REMAP-${post.code}-${kind}`,
        label: `${post.code} ${kind}`,
        kind,
        connectionKind: 'fixture',
        isEnabled: true,
        status: 'ready',
        ownerRole: 'admin' as const,
        lastSeenAt: new Date('2026-08-27T04:00:00.000Z'),
        lastProbeAt: new Date('2026-08-27T04:00:01.000Z'),
        postId: post.id,
      })),
    ),
  });

  const operator = await prisma.user.create({
    data: {
      login: `post-remap-${randomUUID()}`,
      displayName: 'Post remap fixture',
      role: 'operator',
    },
  });
  const openShift = await prisma.shift.create({
    data: {
      label: 'Post remap open shift',
      status: 'open',
      plannedStartAt: new Date('2026-08-27T00:00:00.000Z'),
      plannedEndAt: new Date('2026-08-27T12:00:00.000Z'),
      startedAt: new Date('2026-08-27T00:00:00.000Z'),
    },
  });
  const openAssignment = await prisma.operatorShiftMachineAssignment.create({
    data: {
      shiftId: openShift.id,
      operatorId: operator.id,
      postId: post1.id,
      status: 'locked',
      lockedAt: new Date('2026-08-27T00:00:00.000Z'),
    },
  });
  const activeSession = await prisma.operatorPostSession.create({
    data: {
      operatorId: operator.id,
      postId: post1.id,
      shiftId: openShift.id,
      status: 'active',
      startedAt: new Date('2026-08-27T00:00:00.000Z'),
    },
  });

  const historicalShift = await prisma.shift.create({
    data: {
      label: 'Post remap historical shift',
      status: 'closed',
      startedAt: new Date('2026-08-26T00:00:00.000Z'),
      endedAt: new Date('2026-08-26T12:00:00.000Z'),
    },
  });
  const historicalAssignment = await prisma.operatorShiftMachineAssignment.create({
    data: {
      shiftId: historicalShift.id,
      operatorId: operator.id,
      postId: post1.id,
      status: 'completed',
      lockedAt: new Date('2026-08-26T00:00:00.000Z'),
    },
  });
  const historicalSession = await prisma.operatorPostSession.create({
    data: {
      operatorId: operator.id,
      postId: post1.id,
      shiftId: historicalShift.id,
      status: 'closed',
      startedAt: new Date('2026-08-26T00:00:00.000Z'),
      endedAt: new Date('2026-08-26T12:00:00.000Z'),
    },
  });
  const closeResult = {
    ...EMPTY_CLOSE_RESULT,
    closingPayroll: {
      ...EMPTY_CLOSE_RESULT.closingPayroll,
      sessionId: historicalSession.id,
      shiftId: historicalShift.id,
    },
  } satisfies Prisma.InputJsonObject;
  const closeCommand = await prisma.operatorShiftCloseCommand.create({
    data: {
      operationKey: randomUUID(),
      requestFingerprint: 'c'.repeat(64),
      operatorId: operator.id,
      sessionId: historicalSession.id,
      shiftId: historicalShift.id,
      postId: post1.id,
      assignmentId: historicalAssignment.id,
      actorRole: 'operator',
      resultSnapshot: closeResult,
    },
  });

  const commercialOrder = await prisma.commercialOrder.create({
    data: { orderNumber: `POST-REMAP-${randomUUID()}`, creatorRole: 'commercial' },
  });
  const productionOrder = await prisma.productionOrder.create({
    data: { commercialOrderId: commercialOrder.id },
  });
  const roll = await prisma.rollDispatchItem.create({
    data: {
      rollCode: `POST-REMAP-ROLL-${randomUUID()}`,
      productionOrderId: productionOrder.id,
      postId: post1.id,
      machineId: post1.code,
      status: 'done',
    },
  });
  const costSnapshot = await prisma.rollProductionCostSnapshot.create({
    data: {
      rollDispatchItemId: roll.id,
      version: 1,
      operationKey: randomUUID(),
      requestFingerprint: 'd'.repeat(64),
      calculationFingerprint: 'e'.repeat(64),
      calculationVersion: 'production-cost-v1',
      basis: 'actual',
      basisWeightGrams: 1_000,
      producedAt: new Date('2026-08-26T10:00:00.000Z'),
      closedAt: new Date('2026-08-26T12:00:00.000Z'),
      status: 'complete',
      materialAmountKopecks: 100n,
      spoolAmountKopecks: 100n,
      payrollAmountKopecks: 100n,
      additionalAmountKopecks: 100n,
      totalAmountKopecks: 400n,
      totalKopecksPerKg: 400n,
      unresolvedReasons: [],
      sourceSnapshot: { kind: 'post_remap_fixture' },
      systemActorKey: 'production_cost_reconciler',
    },
  });
  const historicalEvent = await prisma.domainEvent.create({
    data: {
      family: 'audit',
      type: 'audit:post_remap_historical_fixture',
      objectId: post1.id,
      actorKind: 'user',
      actorRole: 'operator',
      actorId: operator.id,
      detail: { immutable: true },
    },
  });

  return {
    activeSession,
    closeCommand,
    costSnapshot,
    historicalEvent,
    openAssignment,
    openShift,
    post1,
    post4,
  };
}

describe('POST-1 / POST-4 machine remap migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(180_000);

  it('changes only names, appends two audits, and preserves active and immutable facts', async () => {
    await withPredecessor(async ({ databaseUrl, prisma, project }) => {
      const fixture = await createRuntimeFixture(prisma);
      const postsBefore = await postSnapshots(prisma);
      const devicesBefore = await prisma.deviceRuntime.findMany({
        where: { postId: { in: [fixture.post1.id, fixture.post4.id] } },
        orderBy: { id: 'asc' },
      });
      const assignmentBefore = await prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { id: fixture.openAssignment.id },
      });
      const sessionBefore = await prisma.operatorPostSession.findUniqueOrThrow({
        where: { id: fixture.activeSession.id },
      });
      const shiftBefore = await prisma.shift.findUniqueOrThrow({
        where: { id: fixture.openShift.id },
      });

      assertCommandSucceeded('Post remap target deploy', deployTarget(project, databaseUrl));

      const postsAfter = await postSnapshots(prisma);
      expect(postsAfter.map(({ code, name }) => ({ code, name }))).toEqual([
        { code: 'POST-1', name: 'Китайка старая' },
        { code: 'POST-4', name: 'Бегемот' },
      ]);
      expect(postsAfter.map(({ invariant }) => invariant)).toEqual(
        postsBefore.map(({ invariant }) => invariant),
      );
      await expect(
        prisma.deviceRuntime.findMany({
          where: { postId: { in: [fixture.post1.id, fixture.post4.id] } },
          orderBy: { id: 'asc' },
        }),
      ).resolves.toEqual(devicesBefore);
      await expect(
        prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
          where: { id: fixture.openAssignment.id },
        }),
      ).resolves.toEqual(assignmentBefore);
      await expect(
        prisma.operatorPostSession.findUniqueOrThrow({ where: { id: fixture.activeSession.id } }),
      ).resolves.toEqual(sessionBefore);
      await expect(
        prisma.shift.findUniqueOrThrow({ where: { id: fixture.openShift.id } }),
      ).resolves.toEqual(shiftBefore);
      await expect(
        prisma.operatorShiftCloseCommand.findUniqueOrThrow({
          where: { id: fixture.closeCommand.id },
        }),
      ).resolves.toEqual(fixture.closeCommand);
      await expect(
        prisma.rollProductionCostSnapshot.findUniqueOrThrow({
          where: { id: fixture.costSnapshot.id },
        }),
      ).resolves.toEqual(fixture.costSnapshot);
      await expect(
        prisma.domainEvent.findUniqueOrThrow({ where: { id: fixture.historicalEvent.id } }),
      ).resolves.toEqual(fixture.historicalEvent);

      const auditEvents = await prisma.domainEvent.findMany({
        where: {
          type: 'admin.post.updated',
          systemActorKey: POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY,
        },
        orderBy: { objectId: 'asc' },
      });
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents.map((event) => event.objectId).sort()).toEqual(
        [fixture.post1.id, fixture.post4.id].sort(),
      );
      const operationKeys = auditEvents.map(
        (event) => (event.detail as { operationKey: string }).operationKey,
      );
      expect(new Set(operationKeys).size).toBe(1);
      expect(operationKeys[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(auditEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            family: 'admin',
            type: 'admin.post.updated',
            objectId: fixture.post1.id,
            actorKind: 'system',
            actorRole: null,
            actorId: null,
            systemActorKey: POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY,
            oldValue: { name: 'Бегемот' },
            newValue: { name: 'Китайка старая' },
            reason: REASON,
          }),
          expect.objectContaining({
            family: 'admin',
            type: 'admin.post.updated',
            objectId: fixture.post4.id,
            actorKind: 'system',
            actorRole: null,
            actorId: null,
            systemActorKey: POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY,
            oldValue: { name: 'Китайка старая' },
            newValue: { name: 'Бегемот' },
            reason: REASON,
          }),
        ]),
      );

      const post1Rate = resolvePayrollRollRate(LEGACY_PAYROLL_TARIFF_MATRIX_V1, {
        producedAt: new Date('2026-08-27T05:00:00.000Z'),
        postName: postsAfter[0]!.name,
        shiftStartedAt: new Date('2026-08-27T00:00:00.000Z'),
        shiftEndedAt: new Date('2026-08-27T12:00:00.000Z'),
        shiftOutputGrams: 800_000,
        rollGrams: 6_999,
        materialNames: ['ПВД Айка'],
        filmType: 'Прозрачная',
        counterpartyLegalName: 'ООО ПОКУПАТЕЛЬ',
      });
      expect(post1Rate).toMatchObject({
        kind: 'resolved',
        machineFamily: 'kitayka',
        tariffRule: 'thin_roll',
        rateKopecksPerKg: 650,
      });
      const post4Rate = resolvePayrollRollRate(LEGACY_PAYROLL_TARIFF_MATRIX_V1, {
        producedAt: new Date('2026-08-27T05:00:00.000Z'),
        postName: postsAfter[1]!.name,
        shiftStartedAt: new Date('2026-08-27T00:00:00.000Z'),
        shiftEndedAt: new Date('2026-08-27T12:00:00.000Z'),
        shiftOutputGrams: 800_000,
        rollGrams: 10_000,
        materialNames: ['ПВД Айка'],
        filmType: 'Прозрачная',
        counterpartyLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
      });
      expect(post4Rate).toMatchObject({
        kind: 'resolved',
        machineFamily: 'abc_old',
        tariffRule: 'abc_standard',
        rateKopecksPerKg: 450,
        specialCustomer: false,
      });
    });
  });

  it('accepts the already-correct mapping without another event', async () => {
    await withPredecessor(async ({ databaseUrl, prisma, project }) => {
      await prisma.$executeRaw`
        UPDATE "posts"
        SET "name" = CASE "code"
          WHEN 'POST-1' THEN 'Китайка старая'
          WHEN 'POST-4' THEN 'Бегемот'
        END
        WHERE "code" IN ('POST-1', 'POST-4')
      `;

      assertCommandSucceeded('Post remap target no-op deploy', deployTarget(project, databaseUrl));

      await expect(postSnapshots(prisma)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'POST-1', name: 'Китайка старая' }),
          expect.objectContaining({ code: 'POST-4', name: 'Бегемот' }),
        ]),
      );
      await expect(
        prisma.domainEvent.count({
          where: { systemActorKey: POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY },
        }),
      ).resolves.toBe(0);
    });
  });

  it.each([
    {
      label: 'partial mapping',
      prepare: (prisma: PrismaClient) =>
        prisma.post.update({ where: { code: 'POST-1' }, data: { name: 'Китайка старая' } }),
    },
    {
      label: 'unexpected mapping',
      prepare: (prisma: PrismaClient) =>
        prisma.post.update({ where: { code: 'POST-1' }, data: { name: 'Неизвестный станок' } }),
    },
    {
      label: 'missing post',
      prepare: (prisma: PrismaClient) => prisma.post.delete({ where: { code: 'POST-4' } }),
    },
  ])('rejects $label without changing catalog or audit facts', async ({ prepare }) => {
    await withPredecessor(async ({ databaseUrl, prisma, project }) => {
      await prepare(prisma);
      const postsBefore = await postSnapshots(prisma);
      const eventsBefore = await prisma.domainEvent.count();

      const result = deployTarget(project, databaseUrl);

      expect(result.status).not.toBe(0);
      await expect(postSnapshots(prisma)).resolves.toEqual(postsBefore);
      await expect(prisma.domainEvent.count()).resolves.toBe(eventsBefore);
    });
  });

  it('rolls back the name exchange when either audit insert fails', async () => {
    await withPredecessor(async ({ databaseUrl, prisma, project }) => {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION reject_post_remap_audit() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
          IF NEW."systemActorKey" = 'post_catalog_migration' THEN
            RAISE EXCEPTION 'fixture audit failure';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER reject_post_remap_audit
        BEFORE INSERT ON "domain_events"
        FOR EACH ROW EXECUTE FUNCTION reject_post_remap_audit()
      `);
      const postsBefore = await postSnapshots(prisma);

      const result = deployTarget(project, databaseUrl);

      expect(result.status).not.toBe(0);
      await expect(postSnapshots(prisma)).resolves.toEqual(postsBefore);
      await expect(
        prisma.domainEvent.count({
          where: { systemActorKey: POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY },
        }),
      ).resolves.toBe(0);
    });
  });
});
