import { type TestingModule, Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../src/common/auth/actor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RoleInboxProjectionService } from '../src/common/role-inbox/role-inbox.service';
import { SCALE_ADAPTER, type ScaleAdapter } from '../src/integrations/scale/scale.adapter';
import { OperatorPhysicalService } from '../src/modules/operator/operator-physical.service';
import { runE2eWithCleanup } from './e2e-database';
import { enableSimulatedDevices } from './simulated-device-fixture';

function actor(userId: string, role: Actor['role']): Actor {
  return { userId, role, capabilities: [] };
}

function jsonObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Expected a JSON notification detail object.');
  }
  return value as Prisma.JsonObject;
}

describe('Operator defect notification flow (e2e, real PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let physical: OperatorPhysicalService;
  let inbox: RoleInboxProjectionService;
  let scaleDeviceId = '';
  const scaleRead = jest.fn<ReturnType<ScaleAdapter['read']>, Parameters<ScaleAdapter['read']>>();

  beforeAll(async () => {
    scaleRead.mockImplementation(async () => ({
      deviceId: scaleDeviceId,
      status: 'ready',
      stable: true,
      grossKg: 11,
    }));
    const scale: ScaleAdapter = { read: scaleRead };
    // AppModule is loaded lazily so this suite can override the physical adapter before compile.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SCALE_ADAPTER)
      .useValue(scale)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    physical = moduleRef.get(OperatorPhysicalService);
    inbox = moduleRef.get(RoleInboxProjectionService);
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [{ label: 'defect notification testing module', run: () => moduleRef?.close() }],
    );
  });

  it('atomically persists one defect/replacement and notifies only the assigned operator on replay', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const operationKey = randomUUID();
    const rollCode = `DEFECT-NOTIFY-${suffix}`;
    const replacementRollCode = `${rollCode}-R1`;
    const post = await prisma.post.create({
      data: {
        code: `DEFECT-POST-${suffix}`,
        name: `Defect notification post ${suffix}`,
        status: 'active',
      },
    });
    const users = await Promise.all(
      (
        [
          ['assigned', 'operator'],
          ['unrelated', 'operator'],
          ['production', 'production_lead'],
          ['warehouse', 'warehouse'],
          ['director', 'director'],
        ] as const
      ).map(([label, role]) =>
        prisma.user.create({
          data: {
            login: `defect-notify-${label}-${suffix}`,
            displayName: `Defect notification ${label} ${suffix}`,
            role,
          },
        }),
      ),
    );
    const [assignedUser, unrelatedUser, productionUser, warehouseUser, directorUser] = users;
    const assigned = actor(assignedUser.id, 'operator');
    const unrelated = actor(unrelatedUser.id, 'operator');
    const recipients = [
      assigned,
      unrelated,
      actor(productionUser.id, 'production_lead'),
      actor(warehouseUser.id, 'warehouse'),
      actor(directorUser.id, 'director'),
    ] as const;
    const baselineUnread = new Map<string, number>(
      await Promise.all(
        recipients.map(
          async (recipient): Promise<readonly [string, number]> => [
            recipient.userId!,
            (
              await inbox.list(recipient, recipient.role, {
                limit: 1,
              })
            ).unreadCount,
          ],
        ),
      ),
    );
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `DEFECT-ORDER-${suffix}`,
        creatorRole: 'commercial',
        productionIndicator: 'in_progress',
        warehouseCoverStatus: 'production_only',
        paymentStatus: 'paid',
        shipmentStatus: 'not_shipped',
        commercialStage: 'in_work',
      },
    });
    const position = await prisma.commercialOrderPosition.create({
      data: {
        orderId: order.id,
        rollCount: 1,
        filmType: 'Полотно',
        actualThickness: '80 мкм',
        accountingThickness: '80 мкм',
        plannedWeightKg: 10,
      },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: {
        commercialOrderId: order.id,
        approvalState: 'approved',
        indicator: 'in_progress',
      },
    });
    const now = new Date();
    const shift = await prisma.shift.create({
      data: {
        label: `Defect notification shift ${suffix}`,
        plannedStartAt: new Date(now.getTime() - 60_000),
        plannedEndAt: new Date(now.getTime() + 60 * 60_000),
        startedAt: now,
        status: 'open',
      },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: shift.id,
        operatorId: assignedUser.id,
        postId: post.id,
        status: 'locked',
        lockedAt: now,
      },
    });
    const session = await prisma.operatorPostSession.create({
      data: {
        operatorId: assignedUser.id,
        postId: post.id,
        shiftId: shift.id,
        status: 'active',
      },
    });
    const bag = await prisma.bigBagUnit.create({
      data: {
        code: `DEFECT-BAG-${suffix}`,
        material: 'ПВД 15803-020',
        status: 'in_use',
        initialKg: 100,
        currentKg: 100,
      },
    });
    await prisma.shiftBagUsage.create({
      data: {
        sessionId: session.id,
        bigBagId: bag.id,
        startKg: 100,
      },
    });
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode,
        productionOrderId: productionOrder.id,
        orderLineId: position.id,
        positionSequence: 1,
        plannedWeightKg: 10,
        assignedOperatorId: assignedUser.id,
        machineId: post.code,
        workplaceId: post.id,
        postId: post.id,
        plannedShiftId: shift.id,
        queueRank: 1,
        status: 'assigned',
      },
    });
    const line = await prisma.operatorRollLine.create({
      data: {
        rollDispatchItemId: dispatch.id,
        sequence: 1,
        planKg: 10,
        step: 'roll_weight',
      },
    });
    const scaleDevice = await prisma.deviceRuntime.create({
      data: {
        code: `DEFECT-SCALE-${suffix}`,
        label: `Defect scale ${suffix}`,
        kind: 'scale',
        status: 'ready',
        postId: post.id,
      },
    });
    scaleDeviceId = scaleDevice.id;
    const supportDevices = await Promise.all(
      (['printer', 'scanner'] as const).map((kind) =>
        prisma.deviceRuntime.create({
          data: {
            code: `DEFECT-${kind.toUpperCase()}-${suffix}`,
            label: `Defect ${kind} ${suffix}`,
            kind,
            status: 'ready',
            isEnabled: true,
            postId: post.id,
          },
        }),
      ),
    );
    await enableSimulatedDevices(prisma, [scaleDevice.id, ...supportDevices.map(({ id }) => id)]);
    await prisma.weightCapture.create({
      data: {
        operatorRollLineId: line.id,
        kind: 'spool',
        deviceId: scaleDevice.id,
        deviceStatus: 'ready',
        stable: true,
        grossKg: 1,
        actorRole: 'operator',
        actorId: assignedUser.id,
        postId: post.id,
        postSessionId: session.id,
      },
    });

    await physical.recordDefect(assigned, rollCode, {
      operationKey,
    });

    const operation = await prisma.operatorRollOperation.findUniqueOrThrow({
      where: { operationKey },
    });
    const [original, replacement, defect, problem, mappedEvents] = await Promise.all([
      prisma.rollDispatchItem.findUniqueOrThrow({
        where: { id: dispatch.id },
        include: { operatorLine: true },
      }),
      prisma.rollDispatchItem.findUniqueOrThrow({
        where: { rollCode: replacementRollCode },
        include: { operatorLine: true },
      }),
      prisma.defectRecord.findFirstOrThrow({
        where: { operatorRollLineId: line.id },
        include: { weightCapture: true },
      }),
      prisma.productionProblem.findFirstOrThrow({
        where: { rollId: rollCode, type: 'defect', status: 'open' },
      }),
      prisma.domainEvent.findMany({
        where: {
          type: {
            in: ['problem:operator_defect_reported', 'audit:replacement_roll_created'],
          },
          detail: { path: ['operationId'], equals: operation.id },
        },
        orderBy: { type: 'asc' },
      }),
    ]);
    expect(original).toMatchObject({
      status: 'defect',
      operatorLine: { step: 'defect', netKg: 10 },
    });
    expect(replacement).toMatchObject({
      replacesDispatchItemId: dispatch.id,
      assignedOperatorId: assignedUser.id,
      orderLineId: position.id,
      status: 'assigned',
      operatorLine: { step: 'assigned' },
    });
    expect(defect).toMatchObject({
      weightKg: 10,
      weightCapture: {
        stable: true,
        deviceStatus: 'ready',
        netKg: 10,
        operationId: operation.id,
      },
    });
    expect(problem.defectRecordId).toBe(defect.id);
    expect(mappedEvents).toHaveLength(2);

    const eventByType = new Map(
      mappedEvents.map((event) => [event.type, { event, detail: jsonObject(event.detail) }]),
    );
    expect(eventByType.get('problem:operator_defect_reported')?.detail).toEqual(
      expect.objectContaining({
        notificationKey: `operator-defect:${operation.id}:reported`,
        recipientRoles: ['operator', 'production_lead', 'director'],
        recipientUserIds: [assignedUser.id],
        orderId: order.id,
        productionOrderId: productionOrder.id,
        positionId: position.id,
        rollId: rollCode,
        problemId: problem.id,
      }),
    );
    expect(eventByType.get('audit:replacement_roll_created')?.detail).toEqual(
      expect.objectContaining({
        notificationKey: `operator-defect:${operation.id}:replacement-created`,
        recipientRoles: ['operator', 'production_lead', 'warehouse', 'director'],
        recipientUserIds: [assignedUser.id],
        orderId: order.id,
        productionOrderId: productionOrder.id,
        positionId: position.id,
        rollId: replacementRollCode,
        rollIds: [rollCode, replacementRollCode],
        problemId: problem.id,
      }),
    );

    const projected = await Promise.all(
      recipients.map(async (recipient) => ({
        recipient,
        page: await inbox.list(recipient, recipient.role, { limit: 100 }),
      })),
    );
    const mappedEventIds = new Set(mappedEvents.map((event) => event.id));
    const projectedEventIds = (recipient: Actor) =>
      projected
        .find(({ recipient: candidate }) => candidate.userId === recipient.userId)!
        .page.items.filter((item) => mappedEventIds.has(item.id))
        .map((item) => item.id);
    expect(projectedEventIds(assigned)).toEqual(expect.arrayContaining([...mappedEventIds]));
    expect(projectedEventIds(unrelated)).toEqual([]);
    expect(projectedEventIds(recipients[2])).toHaveLength(2);
    expect(projectedEventIds(recipients[3])).toHaveLength(1);
    expect(projectedEventIds(recipients[4])).toHaveLength(2);
    expect(
      projected.find(({ recipient }) => recipient.userId === assigned.userId)!.page.unreadCount,
    ).toBe(baselineUnread.get(assigned.userId!)! + 2);
    expect(
      projected.find(({ recipient }) => recipient.userId === unrelated.userId)!.page.unreadCount,
    ).toBe(baselineUnread.get(unrelated.userId!)!);
    expect(JSON.stringify(projected)).not.toMatch(
      /rawPayload|deviceId|evidenceId|recipientUserIds|comment/,
    );

    const beforeReplay = {
      events: await prisma.domainEvent.count({
        where: { detail: { path: ['operationId'], equals: operation.id } },
      }),
      defects: await prisma.defectRecord.count({ where: { operatorRollLineId: line.id } }),
      replacements: await prisma.rollDispatchItem.count({
        where: { replacesDispatchItemId: dispatch.id },
      }),
    };
    await physical.recordDefect(assigned, rollCode, {
      operationKey,
    });
    await expect(
      Promise.all([
        prisma.domainEvent.count({
          where: { detail: { path: ['operationId'], equals: operation.id } },
        }),
        prisma.defectRecord.count({ where: { operatorRollLineId: line.id } }),
        prisma.rollDispatchItem.count({ where: { replacesDispatchItemId: dispatch.id } }),
      ]),
    ).resolves.toEqual([beforeReplay.events, beforeReplay.defects, beforeReplay.replacements]);
    expect(scaleRead).toHaveBeenCalledTimes(1);
  });
});
