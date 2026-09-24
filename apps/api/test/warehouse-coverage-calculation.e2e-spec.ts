import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { resolveCoverageCandidateRollIdsAfterCoreLocks } from '../src/modules/warehouse-coverage/warehouse-coverage-calculation.service';
import { compareOpaqueIdsBinary } from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';

describe('Warehouse coverage calculation SQL (e2e, real PostgreSQL)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('executes the binary order and excludes only open roll problems addressed by code', async () => {
    const suffix = randomUUID();
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Coverage candidate SQL ${suffix}` },
    });
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `COVERAGE-CANDIDATE-SQL-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
        positions: {
          create: {
            rollCount: 1,
            filmType: 'Полотно',
            actualThickness: '80 мкм',
            accountingThickness: '80 мкм',
            spoolType: '76 мм',
            birka: 'Бирка',
            plannedWeightKg: 275,
          },
        },
      },
      include: { positions: { select: { id: true } } },
    });
    const input = {
      id: order.id,
      counterpartyId: counterparty.id,
      positions: order.positions,
    } as Parameters<typeof resolveCoverageCandidateRollIdsAfterCoreLocks>[1];
    const resolveCandidates = () =>
      prisma.$transaction((tx) => resolveCoverageCandidateRollIdsAfterCoreLocks(tx, input));
    const baselineCandidateIds = await resolveCandidates();
    const roll = await prisma.warehouseRoll.create({
      data: {
        rollCode: `COVERAGE-CANDIDATE-ROLL-${suffix}`,
        ownerCounterpartyId: counterparty.id,
        warehouseStatus: 'received',
      },
    });

    try {
      const expectedWithFixture = [...baselineCandidateIds, roll.id].sort(compareOpaqueIdsBinary);

      await expect(resolveCandidates()).resolves.toEqual(expectedWithFixture);
      const problem = await prisma.productionProblem.create({
        data: {
          orderId: order.id,
          positionId: order.positions[0]!.id,
          rollId: roll.rollCode,
          actorRole: 'production_lead',
          reason: 'closed historical problem',
          status: 'closed',
          type: 'general',
        },
      });

      await expect(resolveCandidates()).resolves.toEqual(expectedWithFixture);
      await prisma.productionProblem.update({
        where: { id: problem.id },
        data: { status: 'open' },
      });
      await expect(resolveCandidates()).resolves.toEqual(baselineCandidateIds);
    } finally {
      await prisma.productionProblem.deleteMany({ where: { orderId: order.id } });
      await prisma.warehouseRoll.delete({ where: { id: roll.id } });
      await prisma.commercialOrderPosition.deleteMany({ where: { orderId: order.id } });
      await prisma.commercialOrder.delete({ where: { id: order.id } });
      await prisma.counterparty.delete({ where: { id: counterparty.id } });
    }
  });
});
