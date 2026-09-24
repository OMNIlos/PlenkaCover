import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient, type Role } from '@prisma/client';
import {
  assertCommandSucceeded,
  assertSchemaDestructionTarget,
  createE2eSchemaName,
} from './e2e-database';
import { RollProductionCostSnapshotService } from '../src/modules/director/roll-production-cost-snapshot.service';
import { AUDIT_SYSTEM_ACTOR_KEYS } from '../src/common/audit/audit-actor';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(API_ROOT, 'prisma/schema.prisma');

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function deploy(databaseUrl: string): void {
  assertCommandSucceeded(
    'Production-cost migration deploy',
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

type SnapshotInput = {
  id: string;
  rollDispatchItemId: string;
  version?: number;
  supersedesSnapshotId?: string | null;
  calculationFingerprint?: string;
  status?: 'complete' | 'partial';
  basisWeightGrams?: number;
  materialAmountKopecks?: bigint | null;
  spoolAmountKopecks?: bigint | null;
  payrollAmountKopecks?: bigint | null;
  additionalAmountKopecks?: bigint;
  totalAmountKopecks?: bigint | null;
  totalKopecksPerKg?: bigint | null;
  unresolvedReasons?: string[];
  actorId?: string | null;
  actorRole?: Role | null;
  systemActorKey?: string | null;
  correctionReason?: string | null;
};

async function insertSnapshot(prisma: PrismaClient, input: SnapshotInput) {
  const complete = (input.status ?? 'partial') === 'complete';
  return prisma.rollProductionCostSnapshot.create({
    data: {
      id: input.id,
      rollDispatchItemId: input.rollDispatchItemId,
      version: input.version ?? 1,
      supersedesSnapshotId: input.supersedesSnapshotId ?? null,
      operationKey: randomUUID(),
      requestFingerprint: 'a'.repeat(64),
      calculationFingerprint: input.calculationFingerprint ?? 'b'.repeat(64),
      calculationVersion: 'production-cost-v1',
      basis: 'actual',
      basisWeightGrams: input.basisWeightGrams ?? 1_000,
      producedAt: new Date('2026-08-02T10:00:00.000Z'),
      closedAt: new Date('2026-08-02T18:00:00.000Z'),
      status: input.status ?? 'partial',
      materialAmountKopecks:
        input.materialAmountKopecks === undefined
          ? complete
            ? 100n
            : null
          : input.materialAmountKopecks,
      spoolAmountKopecks:
        input.spoolAmountKopecks === undefined
          ? complete
            ? 100n
            : 100n
          : input.spoolAmountKopecks,
      payrollAmountKopecks:
        input.payrollAmountKopecks === undefined
          ? complete
            ? 100n
            : 100n
          : input.payrollAmountKopecks,
      additionalAmountKopecks: input.additionalAmountKopecks ?? 100n,
      totalAmountKopecks:
        input.totalAmountKopecks === undefined
          ? complete
            ? 400n
            : null
          : input.totalAmountKopecks,
      totalKopecksPerKg:
        input.totalKopecksPerKg === undefined ? (complete ? 400n : null) : input.totalKopecksPerKg,
      unresolvedReasons: input.unresolvedReasons ?? (complete ? [] : ['material_price_unresolved']),
      sourceSnapshot: { kind: 'safe_fixture' },
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      systemActorKey:
        input.systemActorKey === undefined ? 'production_cost_reconciler' : input.systemActorKey,
      correctionReason: input.correctionReason ?? null,
    },
  });
}

describe('production-cost append-only migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('enforces formulas, safe integers, actor/version policy, and immutable history', async () => {
    const schema = createE2eSchemaName();
    const databaseUrl = databaseUrlForSchema(schema);
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const admin = new PrismaClient();

    try {
      deploy(databaseUrl);
      const user = await prisma.user.create({
        data: {
          login: `cost-${randomUUID()}`,
          displayName: 'Cost capability actor',
          role: 'admin',
        },
      });
      const order = await prisma.commercialOrder.create({
        data: { orderNumber: `COST-${randomUUID()}`, creatorRole: 'commercial' },
      });
      const productionOrder = await prisma.productionOrder.create({
        data: { commercialOrderId: order.id },
      });
      const rolls = await Promise.all(
        ['chain', 'same', 'formula', 'human'].map((suffix) =>
          prisma.rollDispatchItem.create({
            data: {
              rollCode: `COST-${suffix}-${randomUUID()}`,
              productionOrderId: productionOrder.id,
            },
          }),
        ),
      );
      const [chainRoll, sameRoll, formulaRoll, humanRoll] = rolls;

      for (const [suffix, actorId] of [
        ['identified', user.id],
        ['legacy_nullable_id', null],
      ] as const) {
        await expect(
          prisma.domainEvent.create({
            data: {
              family: 'audit',
              type: `audit:production_cost_actor_user_${suffix}_probe`,
              actorKind: 'user',
              actorRole: 'admin',
              actorId,
            },
          }),
        ).resolves.toMatchObject({ actorKind: 'user', actorRole: 'admin', actorId });
      }
      for (const systemActorKey of AUDIT_SYSTEM_ACTOR_KEYS) {
        await expect(
          prisma.domainEvent.create({
            data: {
              family: 'audit',
              type: `audit:production_cost_actor_${systemActorKey}_probe`,
              actorKind: 'system',
              systemActorKey,
            },
          }),
        ).resolves.toMatchObject({
          actorKind: 'system',
          actorRole: null,
          actorId: null,
          systemActorKey,
        });
      }

      for (const invalidActor of [
        {
          actorKind: 'user',
          actorRole: 'admin' as Role,
          actorId: user.id,
          systemActorKey: 'production_cost_reconciler',
        },
        {
          actorKind: 'user',
          actorRole: null,
          actorId: user.id,
          systemActorKey: null,
        },
        {
          actorKind: 'system',
          actorRole: 'admin' as Role,
          actorId: null,
          systemActorKey: 'production_cost_reconciler',
        },
        {
          actorKind: 'system',
          actorRole: null,
          actorId: user.id,
          systemActorKey: 'production_cost_reconciler',
        },
        {
          actorKind: 'system',
          actorRole: null,
          actorId: null,
          systemActorKey: null,
        },
        {
          actorKind: 'system',
          actorRole: null,
          actorId: null,
          systemActorKey: 'unregistered_system_actor',
        },
      ]) {
        await expect(
          prisma.domainEvent.create({
            data: {
              family: 'audit',
              type: 'audit:production_cost_actor_invalid_probe',
              ...invalidActor,
            },
          }),
        ).rejects.toThrow(/domain_events_actor_xor/u);
      }

      const price = await prisma.spoolPriceReference.create({
        data: {
          operationKey: randomUUID(),
          requestFingerprint: 'a'.repeat(64),
          spoolTypeKey: 'шпуля 76 мм',
          spoolTypeLabel: 'Шпуля 76 мм',
          priceKopecksPerMeter: BigInt(Number.MAX_SAFE_INTEGER),
          source: 'Тест миграции',
          effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
          reason: 'Проверка DB-инвариантов',
          createdById: user.id,
          createdByRole: 'admin',
        },
      });
      await prisma.spoolPriceReference.createMany({
        data: [
          {
            operationKey: randomUUID(),
            requestFingerprint: 'c'.repeat(64),
            spoolTypeKey: 'втулка 76',
            spoolTypeLabel: 'втулка 76',
            priceKopecksPerMeter: 1n,
            source: 'Тест миграции',
            effectiveFrom: price.effectiveFrom,
            reason: 'Семантически отдельная шпуля',
            createdById: user.id,
            createdByRole: 'admin',
          },
          {
            operationKey: randomUUID(),
            requestFingerprint: 'd'.repeat(64),
            spoolTypeKey: '76 мм',
            spoolTypeLabel: '76 мм',
            priceKopecksPerMeter: 1n,
            source: 'Тест миграции',
            effectiveFrom: price.effectiveFrom,
            reason: 'Семантически отдельная шпуля',
            createdById: user.id,
            createdByRole: 'admin',
          },
        ],
      });
      await expect(prisma.spoolPriceReference.count()).resolves.toBe(3);
      await expect(
        prisma.spoolPriceReference.create({
          data: {
            operationKey: randomUUID(),
            requestFingerprint: 'b'.repeat(64),
            spoolTypeKey: '76 мм',
            spoolTypeLabel: '76 мм',
            priceKopecksPerMeter: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
            source: 'Тест миграции',
            effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
            reason: 'Цена за пределом safe integer',
            createdById: user.id,
            createdByRole: 'admin',
          },
        }),
      ).rejects.toThrow();

      const partial = await insertSnapshot(prisma, {
        id: 'cost-partial-v1',
        rollDispatchItemId: chainRoll.id,
        calculationFingerprint: 'b'.repeat(64),
      });
      const complete = await insertSnapshot(prisma, {
        id: 'cost-complete-v2',
        rollDispatchItemId: chainRoll.id,
        version: 2,
        supersedesSnapshotId: partial.id,
        calculationFingerprint: 'c'.repeat(64),
        status: 'complete',
      });
      await expect(
        insertSnapshot(prisma, {
          id: 'cost-system-after-complete-v3',
          rollDispatchItemId: chainRoll.id,
          version: 3,
          supersedesSnapshotId: complete.id,
          calculationFingerprint: 'd'.repeat(64),
          status: 'complete',
        }),
      ).rejects.toThrow();

      const correction = await insertSnapshot(prisma, {
        id: 'cost-human-v3',
        rollDispatchItemId: chainRoll.id,
        version: 3,
        supersedesSnapshotId: complete.id,
        calculationFingerprint: complete.calculationFingerprint,
        status: 'complete',
        actorId: user.id,
        actorRole: 'admin',
        systemActorKey: null,
        correctionReason: 'Исправление актором с делегированной capability',
      });
      expect(correction.version).toBe(3);

      const samePartial = await insertSnapshot(prisma, {
        id: 'cost-same-partial-v1',
        rollDispatchItemId: sameRoll.id,
        calculationFingerprint: 'e'.repeat(64),
      });
      await expect(
        insertSnapshot(prisma, {
          id: 'cost-same-partial-v2',
          rollDispatchItemId: sameRoll.id,
          version: 2,
          supersedesSnapshotId: samePartial.id,
          calculationFingerprint: samePartial.calculationFingerprint,
        }),
      ).rejects.toThrow();
      await expect(
        insertSnapshot(prisma, {
          id: 'cost-human-v1',
          rollDispatchItemId: humanRoll.id,
          actorId: user.id,
          actorRole: 'admin',
          systemActorKey: null,
          correctionReason: 'Коррекция не может быть первой версией',
        }),
      ).rejects.toThrow();

      await expect(
        insertSnapshot(prisma, {
          id: 'cost-wrong-total',
          rollDispatchItemId: formulaRoll.id,
          status: 'complete',
          totalAmountKopecks: 999n,
          totalKopecksPerKg: 999n,
        }),
      ).rejects.toThrow();
      await expect(
        insertSnapshot(prisma, {
          id: 'cost-wrong-perkg',
          rollDispatchItemId: formulaRoll.id,
          status: 'complete',
          totalKopecksPerKg: 777n,
        }),
      ).rejects.toThrow();
      const halfUp = await insertSnapshot(prisma, {
        id: 'cost-half-up',
        rollDispatchItemId: formulaRoll.id,
        status: 'complete',
        basisWeightGrams: 6,
        materialAmountKopecks: 1n,
        spoolAmountKopecks: 0n,
        payrollAmountKopecks: 0n,
        additionalAmountKopecks: 0n,
        totalAmountKopecks: 1n,
        totalKopecksPerKg: 167n,
      });
      expect(halfUp.totalKopecksPerKg).toBe(167n);

      const assembler = { prepare: jest.fn() };
      const snapshots = new RollProductionCostSnapshotService(
        prisma as never,
        assembler as never,
        { record: jest.fn() } as never,
      );
      const latest = await snapshots.getViewsForRollIds([chainRoll.id, formulaRoll.id]);
      expect(latest.get(chainRoll.id)).toMatchObject({
        kind: 'actual_snapshot',
        version: 3,
        snapshotId: correction.id,
      });
      expect(latest.get(formulaRoll.id)).toMatchObject({
        kind: 'actual_snapshot',
        totalAmountKopecks: 1,
        totalKopecksPerKg: 167,
      });
      expect(assembler.prepare).not.toHaveBeenCalled();

      await expect(
        prisma.rollProductionCostSnapshot.update({
          where: { id: correction.id },
          data: { correctionReason: 'Перезапись' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.rollProductionCostSnapshot.delete({ where: { id: correction.id } }),
      ).rejects.toThrow();
      await expect(
        prisma.spoolPriceReference.update({
          where: { id: price.id },
          data: { reason: 'Перезапись' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.spoolPriceReference.delete({ where: { id: price.id } }),
      ).rejects.toThrow();
    } finally {
      await prisma.$disconnect();
      assertSchemaDestructionTarget(schema, databaseUrl);
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });
});
