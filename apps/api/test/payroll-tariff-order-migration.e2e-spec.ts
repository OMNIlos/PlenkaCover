import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PAYROLL_TARIFF_BOOTSTRAP_SYSTEM_ACTOR_KEY } from '../src/common/audit/audit-actor';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from '../src/common/payroll-tariffs/payroll-tariff-engine';
import { parsePayrollTariffMatrix } from '../src/common/payroll-tariffs/payroll-tariff-matrix.parser';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_ROOT = resolve(API_ROOT, 'prisma');
const SOURCE_MIGRATIONS = resolve(PRISMA_ROOT, 'migrations');
const TARGET_MIGRATION = '20260813140000_payroll_tariff_orders';
const TARGET_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, TARGET_MIGRATION);
const CLOSE_RESULT_MIGRATION = '20260813150000_operator_shift_close_payroll_order_refs';
const CLOSE_RESULT_MIGRATION_PATH = resolve(SOURCE_MIGRATIONS, CLOSE_RESULT_MIGRATION);
const LEGACY_ORDER_ID = 'payroll-tariff-order-8-09-25-2025-09-29';

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function copyPredecessorProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'plenka-payroll-tariffs-'));
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

async function createProtectedSnapshots(prisma: PrismaClient) {
  const operator = await prisma.user.create({
    data: {
      login: `payroll-migration-${randomUUID()}`,
      displayName: 'Payroll migration operator',
      role: 'operator',
    },
  });
  const post = await prisma.post.create({
    data: { code: `PAYROLL-${randomUUID()}`, name: 'Payroll migration post' },
  });
  const startedAt = new Date('2026-08-12T06:00:00.000Z');
  const endedAt = new Date('2026-08-12T18:00:00.000Z');
  const shift = await prisma.shift.create({
    data: {
      label: 'Payroll migration shift',
      status: 'closed',
      startedAt,
      endedAt,
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
      startedAt,
      endedAt,
    },
  });
  const resultSnapshot = {
    ...EMPTY_CLOSE_RESULT,
    closingPayroll: {
      ...EMPTY_CLOSE_RESULT.closingPayroll,
      sessionId: session.id,
      shiftId: shift.id,
    },
  } satisfies Prisma.InputJsonObject;
  const closeCommand = await prisma.operatorShiftCloseCommand.create({
    data: {
      operationKey: randomUUID(),
      requestFingerprint: 'a'.repeat(64),
      operatorId: operator.id,
      sessionId: session.id,
      shiftId: shift.id,
      postId: post.id,
      assignmentId: assignment.id,
      actorRole: 'operator',
      resultSnapshot,
    },
  });

  const commercialOrder = await prisma.commercialOrder.create({
    data: { orderNumber: `PAYROLL-${randomUUID()}`, creatorRole: 'commercial' },
  });
  const productionOrder = await prisma.productionOrder.create({
    data: { commercialOrderId: commercialOrder.id },
  });
  const roll = await prisma.rollDispatchItem.create({
    data: {
      rollCode: `PAYROLL-ROLL-${randomUUID()}`,
      productionOrderId: productionOrder.id,
    },
  });
  const costSnapshot = await prisma.rollProductionCostSnapshot.create({
    data: {
      rollDispatchItemId: roll.id,
      version: 1,
      operationKey: randomUUID(),
      requestFingerprint: 'b'.repeat(64),
      calculationFingerprint: 'c'.repeat(64),
      calculationVersion: 'production-cost-v1',
      basis: 'actual',
      basisWeightGrams: 1_000,
      producedAt: new Date('2026-08-12T12:00:00.000Z'),
      closedAt: new Date('2026-08-12T18:00:00.000Z'),
      status: 'partial',
      materialAmountKopecks: null,
      spoolAmountKopecks: 100n,
      payrollAmountKopecks: 100n,
      additionalAmountKopecks: 100n,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: ['material_price_unresolved'],
      sourceSnapshot: { kind: 'payroll_migration_fixture' },
      systemActorKey: 'production_cost_reconciler',
    },
  });
  return { closeCommandId: closeCommand.id, costSnapshotId: costSnapshot.id };
}

describe('payroll tariff order migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('bootstraps the exact legacy schedule without rewriting durable payroll facts', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const project = copyPredecessorProject();
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

    try {
      deploy(project, databaseUrl, 'Payroll tariff predecessor deploy');
      const fixture = await createProtectedSnapshots(prisma);
      const closeBefore = await prisma.operatorShiftCloseCommand.findUniqueOrThrow({
        where: { id: fixture.closeCommandId },
      });
      const costBefore = await prisma.rollProductionCostSnapshot.findUniqueOrThrow({
        where: { id: fixture.costSnapshotId },
      });
      const eventCountBefore = await prisma.domainEvent.count();

      cpSync(TARGET_MIGRATION_PATH, join(project, 'migrations', TARGET_MIGRATION), {
        recursive: true,
      });
      cpSync(CLOSE_RESULT_MIGRATION_PATH, join(project, 'migrations', CLOSE_RESULT_MIGRATION), {
        recursive: true,
      });
      deploy(project, databaseUrl, 'Payroll tariff target deploy');

      const orders = await prisma.$queryRaw<
        Array<{
          id: string;
          name: string;
          status: string;
          effectiveFrom: Date;
          currency: string;
          matrix: unknown;
          revision: number;
          createdById: string | null;
          updatedById: string | null;
          publishedById: string | null;
          publishedAt: Date | null;
        }>
      >`SELECT "id", "name", "status", "effectiveFrom", "currency", "matrix", "revision",
               "createdById", "updatedById", "publishedById", "publishedAt"
        FROM "payroll_tariff_orders"`;
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        id: LEGACY_ORDER_ID,
        name: 'Приказ № 8-09/25',
        status: 'published',
        effectiveFrom: new Date('2025-09-28T21:00:00.000Z'),
        currency: 'RUB',
        revision: 1,
        createdById: null,
        updatedById: null,
        publishedById: null,
        publishedAt: new Date('2025-09-28T21:00:00.000Z'),
      });
      expect(parsePayrollTariffMatrix(orders[0]!.matrix)).toEqual(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
      await expect(
        prisma.$queryRaw`SELECT COUNT(*)::int AS "count" FROM "payroll_tariff_order_commands"`,
      ).resolves.toEqual([{ count: 0 }]);

      await expect(
        prisma.domainEvent.findMany({
          where: {
            objectId: LEGACY_ORDER_ID,
            type: 'audit:payroll_tariff_order_created',
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          family: 'audit',
          actorKind: 'system',
          actorRole: null,
          actorId: null,
          systemActorKey: PAYROLL_TARIFF_BOOTSTRAP_SYSTEM_ACTOR_KEY,
        }),
      ]);
      await expect(prisma.domainEvent.count()).resolves.toBe(eventCountBefore + 1);
      await expect(
        prisma.operatorShiftCloseCommand.findUniqueOrThrow({
          where: { id: fixture.closeCommandId },
        }),
      ).resolves.toEqual(closeBefore);
      await expect(
        prisma.rollProductionCostSnapshot.findUniqueOrThrow({
          where: { id: fixture.costSnapshotId },
        }),
      ).resolves.toEqual(costBefore);
    } finally {
      await prisma.$disconnect();
      await dropSchema(schema, databaseUrl);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
