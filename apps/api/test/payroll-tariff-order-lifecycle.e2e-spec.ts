import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Actor } from '../src/common/auth/actor';
import { AuditService } from '../src/common/audit/audit.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from '../src/common/payroll-tariffs/payroll-tariff-engine';
import { PayrollTariffOrderService } from '../src/common/payroll-tariffs/payroll-tariff-order.service';

const NOW = new Date('2026-08-13T12:00:00.000Z');

function matrix() {
  return structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
}

function nextDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function serviceFor(prisma: PrismaClient): PayrollTariffOrderService {
  const client = prisma as unknown as PrismaService;
  return new PayrollTariffOrderService(client, new AuditService(client));
}

async function mutationCounts(prisma: PrismaClient, orderIds: string[]) {
  const [commands, events] = await Promise.all([
    prisma.payrollTariffOrderCommand.count({ where: { orderId: { in: orderIds } } }),
    prisma.domainEvent.count({
      where: {
        objectId: { in: orderIds },
        type: {
          in: [
            'audit:payroll_tariff_order_created',
            'audit:payroll_tariff_order_draft_updated',
            'audit:payroll_tariff_order_published',
          ],
        },
      },
    }),
  ]);
  return { commands, events };
}

describe('payroll tariff order lifecycle (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  it('keeps command, lifecycle, audit, failure, replay and concurrent publish atomic', async () => {
    const firstPrisma = new PrismaClient();
    const secondPrisma = new PrismaClient();
    const firstService = serviceFor(firstPrisma);
    const secondService = serviceFor(secondPrisma);

    try {
      const user = await firstPrisma.user.create({
        data: {
          login: `payroll-director-${randomUUID()}`,
          displayName: 'Payroll director',
          role: 'director',
        },
      });
      const actor: Actor = {
        userId: user.id,
        role: 'director',
        capabilities: ['director:read', 'payroll_tariff:manage'],
      };
      const initialEffectiveFrom = (await firstService.list(NOW)).minimumPublishEffectiveFrom;

      const createInput = {
        operationKey: randomUUID(),
        name: 'Приказ lifecycle A',
        effectiveFrom: initialEffectiveFrom,
        matrix: matrix(),
      };
      const created = await firstService.create(actor, createInput);
      await expect(mutationCounts(firstPrisma, [created.order.id])).resolves.toEqual({
        commands: 1,
        events: 1,
      });

      await expect(firstService.create(actor, createInput)).resolves.toEqual({
        ...created,
        replayed: true,
      });
      await expect(mutationCounts(firstPrisma, [created.order.id])).resolves.toEqual({
        commands: 1,
        events: 1,
      });

      const updated = await firstService.update(actor, created.order.id, {
        ...createInput,
        operationKey: randomUUID(),
        expectedRevision: created.order.revision,
        name: 'Приказ lifecycle A — уточнённый',
      });
      expect(updated.order.revision).toBe(created.order.revision + 1);
      await expect(mutationCounts(firstPrisma, [created.order.id])).resolves.toEqual({
        commands: 2,
        events: 2,
      });

      const countsBeforeStale = await mutationCounts(firstPrisma, [created.order.id]);
      await expect(
        firstService.update(actor, created.order.id, {
          ...createInput,
          operationKey: randomUUID(),
          expectedRevision: created.order.revision,
        }),
      ).rejects.toMatchObject({ code: 'PAYROLL_TARIFF_ORDER_DRAFT_STALE' });
      await expect(mutationCounts(firstPrisma, [created.order.id])).resolves.toEqual(
        countsBeforeStale,
      );

      const review = await firstService.review(
        created.order.id,
        { expectedRevision: updated.order.revision },
        NOW,
      );
      expect(review.publishable).toBe(true);
      const publishInput = {
        operationKey: randomUUID(),
        expectedRevision: updated.order.revision,
        reviewedMatrixHash: review.matrixHash,
      };
      const published = await firstService.publish(actor, created.order.id, publishInput, NOW);
      expect(published.order.status).toBe('published');
      await expect(mutationCounts(firstPrisma, [created.order.id])).resolves.toEqual({
        commands: 3,
        events: 3,
      });
      await expect(
        firstService.publish(actor, created.order.id, publishInput, NOW),
      ).resolves.toEqual({ ...published, replayed: true });
      await expect(mutationCounts(firstPrisma, [created.order.id])).resolves.toEqual({
        commands: 3,
        events: 3,
      });
      await expect(
        firstService.publish(
          actor,
          created.order.id,
          { ...publishInput, operationKey: randomUUID() },
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'PAYROLL_TARIFF_ORDER_ALREADY_PUBLISHED' });

      const concurrentDate = nextDate(initialEffectiveFrom);
      const [left, right] = await Promise.all(
        ['left', 'right'].map((suffix) =>
          firstService.create(actor, {
            operationKey: randomUUID(),
            name: `Приказ lifecycle ${suffix}`,
            effectiveFrom: concurrentDate,
            matrix: matrix(),
          }),
        ),
      );
      const leftReview = await firstService.review(
        left.order.id,
        { expectedRevision: left.order.revision },
        NOW,
      );
      const rightReview = await firstService.review(
        right.order.id,
        { expectedRevision: right.order.revision },
        NOW,
      );
      const countsBeforeRace = await mutationCounts(firstPrisma, [left.order.id, right.order.id]);

      const race = await Promise.allSettled([
        firstService.publish(
          actor,
          left.order.id,
          {
            operationKey: randomUUID(),
            expectedRevision: left.order.revision,
            reviewedMatrixHash: leftReview.matrixHash,
          },
          NOW,
        ),
        secondService.publish(
          actor,
          right.order.id,
          {
            operationKey: randomUUID(),
            expectedRevision: right.order.revision,
            reviewedMatrixHash: rightReview.matrixHash,
          },
          NOW,
        ),
      ]);

      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(race.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const loser = race.find((result) => result.status === 'rejected');
      expect(loser).toMatchObject({
        reason: {
          code: expect.stringMatching(
            /^PAYROLL_TARIFF_ORDER_(?:EFFECTIVE_DATE_DUPLICATE|EFFECTIVE_DATE_NOT_AFTER_LATEST)$/u,
          ),
        },
      });
      await expect(
        firstPrisma.payrollTariffOrder.count({
          where: {
            status: 'published',
            effectiveFrom: new Date(`${concurrentDate}T00:00:00.000+03:00`),
          },
        }),
      ).resolves.toBe(1);
      await expect(mutationCounts(firstPrisma, [left.order.id, right.order.id])).resolves.toEqual({
        commands: countsBeforeRace.commands + 1,
        events: countsBeforeRace.events + 1,
      });
    } finally {
      await Promise.all([firstPrisma.$disconnect(), secondPrisma.$disconnect()]);
    }
  });
});
