import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../src/common/auth/actor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RoleInboxModule } from '../src/common/role-inbox/role-inbox.module';
import { RoleInboxProjectionService } from '../src/common/role-inbox/role-inbox.service';
import { runE2eWithCleanup } from './e2e-database';

describe('Role inbox recipient filtering (e2e, real PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: RoleInboxProjectionService;
  const suffix = randomUUID().replaceAll('-', '');
  const eventPrefix = `inbox-${suffix}`;
  const rollA = `INBOX-A-${suffix}`;
  const rollB = `INBOX-B-${suffix}`;
  const foreignEventId = `${eventPrefix}-z`;
  const sharedReassignmentEventId = `${eventPrefix}-y`;
  const ownEventId = `${eventPrefix}-x`;
  let operatorA: Actor;
  let operatorB: Actor;
  let baselineA = 0;
  let baselineB = 0;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [RoleInboxModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(RoleInboxProjectionService);

    const [userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          login: `inbox-a-${suffix}`,
          displayName: 'Inbox PostgreSQL operator A',
          role: 'operator',
        },
      }),
      prisma.user.create({
        data: {
          login: `inbox-b-${suffix}`,
          displayName: 'Inbox PostgreSQL operator B',
          role: 'operator',
        },
      }),
    ]);
    operatorA = { userId: userA.id, role: 'operator', capabilities: [] };
    operatorB = { userId: userB.id, role: 'operator', capabilities: [] };

    const productionOrder = await prisma.productionOrder.findFirstOrThrow({
      select: { id: true, commercialOrderId: true },
    });
    await Promise.all([
      prisma.rollDispatchItem.create({
        data: {
          rollCode: rollA,
          productionOrderId: productionOrder.id,
          assignedOperatorId: userA.id,
          queueRank: 10_000,
        },
      }),
      prisma.rollDispatchItem.create({
        data: {
          rollCode: rollB,
          productionOrderId: productionOrder.id,
          assignedOperatorId: userB.id,
          queueRank: 10_001,
        },
      }),
    ]);

    [baselineA, baselineB] = await Promise.all([
      service.list(operatorA, 'operator', { limit: 1 }).then((page) => page.unreadCount),
      service.list(operatorB, 'operator', { limit: 1 }).then((page) => page.unreadCount),
    ]);

    const createdAt = new Date('2099-07-24T12:00:00.000Z');
    await prisma.domainEvent.createMany({
      data: [
        {
          id: foreignEventId,
          family: 'audit',
          type: 'audit:task_assigned',
          objectId: rollB,
          actorKind: 'system',
          systemActorKey: 'warehouse_coverage_engine',
          createdAt,
          detail: {
            operatorId: userB.id,
            rollId: rollB,
            productionOrderId: productionOrder.id,
            commercialOrderId: productionOrder.commercialOrderId,
          },
        },
        {
          id: sharedReassignmentEventId,
          family: 'audit',
          type: 'audit:task_reassigned',
          objectId: rollB,
          actorKind: 'system',
          systemActorKey: 'warehouse_coverage_engine',
          createdAt,
          detail: {
            operatorId: userB.id,
            previousOperatorId: userA.id,
            rollId: rollB,
            productionOrderId: productionOrder.id,
            commercialOrderId: productionOrder.commercialOrderId,
          },
        },
        {
          id: ownEventId,
          family: 'audit',
          type: 'audit:task_assigned',
          objectId: rollA,
          actorKind: 'system',
          systemActorKey: 'warehouse_coverage_engine',
          createdAt,
          detail: {
            operatorId: userA.id,
            rollId: rollA,
            productionOrderId: productionOrder.id,
            commercialOrderId: productionOrder.commercialOrderId,
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [{ label: 'role inbox testing module', run: () => moduleRef.close() }],
    );
  });

  it('applies JSON recipient scope before paging and keeps receipts independent', async () => {
    const firstA = await service.list(operatorA, 'operator', { limit: 1 });
    expect(firstA.items.map((item) => item.id)).toEqual([sharedReassignmentEventId]);
    expect(firstA.items[0]?.rollId).toBeNull();
    expect(firstA.nextCursor).not.toBeNull();
    expect(firstA.unreadCount).toBe(baselineA + 2);

    const secondA = await service.list(operatorA, 'operator', {
      limit: 1,
      cursor: firstA.nextCursor ?? undefined,
    });
    expect(secondA.items.map((item) => item.id)).toEqual([ownEventId]);
    expect(secondA.items[0]).toMatchObject({
      rollId: null,
      cta: {
        kind: 'operator_queue',
        targetId: secondA.items[0]?.orderId,
      },
    });

    const initialB = await service.list(operatorB, 'operator', { limit: 10 });
    expect(initialB.items.slice(0, 2).map((item) => item.id)).toEqual([
      foreignEventId,
      sharedReassignmentEventId,
    ]);
    expect(initialB.items.find((item) => item.id === sharedReassignmentEventId)?.rollId).toBeNull();
    expect(initialB.unreadCount).toBe(baselineB + 2);

    await expect(service.markRead(operatorA, 'operator', foreignEventId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await service.markRead(operatorA, 'operator', sharedReassignmentEventId);

    const afterARead = await service.list(operatorA, 'operator', { limit: 10 });
    expect(afterARead.items.some((item) => item.id === sharedReassignmentEventId)).toBe(false);
    expect(afterARead.unreadCount).toBe(baselineA + 1);

    const beforeBRead = await service.list(operatorB, 'operator', { limit: 10 });
    expect(beforeBRead.items.find((item) => item.id === sharedReassignmentEventId)?.unread).toBe(
      true,
    );
    expect(beforeBRead.unreadCount).toBe(baselineB + 2);

    await service.markRead(operatorB, 'operator', sharedReassignmentEventId);
    await service.markRead(operatorB, 'operator', sharedReassignmentEventId);
    const afterBRead = await service.list(operatorB, 'operator', { limit: 10 });
    expect(afterBRead.items.some((item) => item.id === sharedReassignmentEventId)).toBe(false);
    expect(afterBRead.unreadCount).toBe(baselineB + 1);
    await expect(
      prisma.notificationReceipt.count({
        where: {
          eventId: sharedReassignmentEventId,
          userId: { in: [operatorA.userId!, operatorB.userId!] },
        },
      }),
    ).resolves.toBe(2);
  });
});
