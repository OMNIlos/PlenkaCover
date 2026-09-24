import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { AuditService } from '../src/common/audit/audit.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { OperatorPhysicalService } from '../src/modules/operator/operator-physical.service';

describe('canonical order receiving task (e2e, PostgreSQL)', () => {
  jest.setTimeout(60_000);

  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('claims one legacy A-11 task and keeps both order positions in it under concurrent handover', async () => {
    const suffix = randomUUID();
    const operator = await prisma.user.findFirstOrThrow({
      where: { role: 'operator', isActive: true },
      select: { id: true },
    });
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-11-${suffix}`,
        creatorRole: 'commercial',
        positions: {
          create: [
            {
              rollCount: 1,
              filmType: 'Полотно',
              actualThickness: '80 мкм',
              accountingThickness: '80 мкм',
            },
            {
              rollCount: 1,
              filmType: 'Рукав',
              actualThickness: '100 мкм',
              accountingThickness: '100 мкм',
            },
          ],
        },
      },
      include: { positions: { orderBy: { id: 'asc' } } },
    });
    const production = await prisma.productionOrder.create({
      data: { commercialOrderId: order.id, approvalState: 'approved' },
    });
    const rollCodes = [`A-11-POS-1-${suffix}`, `A-11-POS-2-${suffix}`];
    await Promise.all(
      order.positions.map((position, index) =>
        prisma.rollDispatchItem.create({
          data: {
            rollCode: rollCodes[index]!,
            productionOrderId: production.id,
            orderLineId: position.id,
            positionSequence: index + 1,
            status: 'assigned',
            operatorLine: {
              create: {
                sequence: index + 1,
                step: 'handover',
                labelState: 'verified',
                warehouseState: 'not_ready',
              },
            },
          },
        }),
      ),
    );

    const legacyCreatedAt = new Date('2026-07-13T08:00:00.000Z');
    const legacyTask = await prisma.warehouseAcceptanceTask.create({
      data: {
        mode: 'receiving',
        status: 'open',
        operationCode: `A-11-LEGACY-${suffix}`,
        orderId: order.id,
        positionId: order.positions[0]!.id,
        createdAt: legacyCreatedAt,
      },
    });

    const ownership = {
      lockOwned: jest.fn(async (tx: PrismaClient, _actor: unknown, rollCode: string) => ({
        session: { id: `session-${suffix}`, postId: `post-${suffix}`, shiftId: `shift-${suffix}` },
        line: await tx.operatorRollLine.findFirstOrThrow({
          where: { rollDispatchItem: { rollCode } },
          include: {
            rollDispatchItem: {
              include: {
                productionOrder: {
                  include: { commercialOrder: { include: { counterparty: true } } },
                },
              },
            },
          },
        }),
      })),
    };
    const operations = {
      claim: jest.fn(async (_tx: unknown, input: { operationKey: string }) => ({
        kind: 'claimed' as const,
        operation: { id: `operation-${input.operationKey}` },
        recoveryFromId: null,
      })),
      complete: jest.fn(),
    };
    const service = new OperatorPhysicalService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
      ownership as never,
      {} as never,
      operations as never,
      {} as never,
      { appendProductionHandoverFact: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const tasks = await Promise.all(
      rollCodes.map((rollCode) =>
        service.handover({ userId: operator.id, role: 'operator' }, rollCode, {
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(tasks.map(({ id }) => id)).toEqual([legacyTask.id, legacyTask.id]);

    const [receivingTasks, persistedTask, dispatchItems] = await Promise.all([
      prisma.warehouseAcceptanceTask.count({
        where: { orderId: order.id, mode: 'receiving' },
      }),
      prisma.warehouseAcceptanceTask.findUniqueOrThrow({
        where: { id: legacyTask.id },
        include: { rows: { orderBy: { rollCode: 'asc' } } },
      }),
      prisma.rollDispatchItem.findMany({
        where: { productionOrderId: production.id },
        orderBy: { positionSequence: 'asc' },
        select: { orderLineId: true, positionSequence: true, rollCode: true },
      }),
    ]);
    expect(receivingTasks).toBe(1);
    expect(persistedTask).toMatchObject({
      id: legacyTask.id,
      operationCode: legacyTask.operationCode,
      createdAt: legacyCreatedAt,
      receivingScopeKey: `commercial-order:${order.id}`,
    });
    expect(persistedTask.rows.map(({ rollCode }) => rollCode)).toEqual([...rollCodes].sort());
    expect(dispatchItems).toEqual(
      order.positions.map((position, index) => ({
        orderLineId: position.id,
        positionSequence: index + 1,
        rollCode: rollCodes[index],
      })),
    );
  });
});
