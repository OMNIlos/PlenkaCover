import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth/password';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';
import { enableSimulatedDevices } from './simulated-device-fixture';

describe('individual shift production publication (e2e, real DB)', () => {
  jest.setTimeout(60_000);

  const suffix = randomUUID();
  const password = `Shift-${suffix}`;
  const leadId = `shift-publish-lead-${suffix}`;
  const leadLogin = `shift-publish-lead-${suffix}@test.local`;
  let app: INestApplication;
  let prisma: PrismaService;
  let asLead: { authorization: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    await prisma.user.create({
      data: {
        id: leadId,
        externalId: leadId,
        login: leadLogin,
        passwordHash: hashPassword(password),
        passwordChangedAt: new Date(),
        displayName: 'Shift publication lead',
        role: Role.production_lead,
      },
    });
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: leadLogin, password })
      .expect(201);
    asLead = { authorization: `Bearer ${login.body.token as string}` };
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [{ label: 'individual shift publication application', run: async () => app?.close() }],
    );
  });

  async function createPendingPlan(label: string, rollCount: number) {
    const token = `${label}-${randomUUID()}`;
    const operatorId = `shift-publish-operator-${token}`;
    const operatorLogin = `shift-publish-operator-${token}@test.local`;
    const postId = `shift-publish-post-${token}`;
    const postCode = `SHIFT-PUBLISH-${token}`;
    const commercialOrderId = `shift-publish-commercial-${token}`;
    const productionOrderId = `shift-publish-production-${token}`;
    const orderNumber = `SHIFT-PUBLISH-${token}`;

    await prisma.user.create({
      data: {
        id: operatorId,
        externalId: operatorId,
        login: operatorLogin,
        passwordHash: hashPassword(password),
        passwordChangedAt: new Date(),
        displayName: `Shift publication operator ${label}`,
        role: Role.operator,
      },
    });
    await prisma.post.create({
      data: {
        id: postId,
        code: postCode,
        name: `Shift publication post ${label}`,
      },
    });
    const deviceIds = ['scale', 'printer', 'scanner'].map(
      (kind) => `shift-publish-${kind}-${token}`,
    );
    await prisma.deviceRuntime.createMany({
      data: (['scale', 'printer', 'scanner'] as const).map((kind, index) => ({
        id: deviceIds[index]!,
        code: `SHIFT-PUBLISH-${kind.toUpperCase()}-${token}`,
        label: `Shift publication ${kind} ${label}`,
        kind,
        status: 'ready',
        isEnabled: true,
        postId,
      })),
    });
    await enableSimulatedDevices(prisma, deviceIds);
    await prisma.commercialOrder.create({
      data: {
        id: commercialOrderId,
        orderNumber,
        creatorRole: Role.commercial,
      },
    });
    await prisma.productionOrder.create({
      data: {
        id: productionOrderId,
        commercialOrderId,
        approvalState: 'pending',
        dispatchItems: {
          create: Array.from({ length: rollCount }, (_, index) => ({
            id: `shift-publish-dispatch-${token}-${index + 1}`,
            rollCode: `SHIFT-PUBLISH-ROLL-${token}-${index + 1}`,
            queueRank: index + 1,
            plannedWeightKg: 40 + index,
            status: 'new',
          })),
        },
      },
    });
    const operatorLoginResponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: operatorLogin, password })
      .expect(201);
    const dispatchItems = await prisma.rollDispatchItem.findMany({
      where: { productionOrderId },
      orderBy: { queueRank: 'asc' },
    });
    return {
      operatorId,
      postId,
      commercialOrderId,
      productionOrderId,
      orderNumber,
      dispatchItems,
      asOperator: {
        authorization: `Bearer ${operatorLoginResponse.body.token as string}`,
      },
    };
  }

  it('attaches earlier operator assignments when the shift is created and publishes the order', async () => {
    const plan = await createPendingPlan('assignment-first', 2);

    for (const item of plan.dispatchItems) {
      await request(app.getHttpServer())
        .post(`/api/production/roll-dispatch/${item.rollCode}/assign`)
        .set(asLead)
        .send({ operatorId: plan.operatorId })
        .expect(201);
    }

    await expect(
      prisma.productionOrder.findUniqueOrThrow({
        where: { id: plan.productionOrderId },
        select: { approvalState: true },
      }),
    ).resolves.toEqual({ approvalState: 'pending' });
    await expect(
      prisma.rollDispatchItem.findMany({
        where: { productionOrderId: plan.productionOrderId },
        select: {
          assignedOperatorId: true,
          plannedShiftId: true,
          postId: true,
          machineId: true,
          workplaceId: true,
        },
        orderBy: { queueRank: 'asc' },
      }),
    ).resolves.toEqual([
      {
        assignedOperatorId: plan.operatorId,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
      },
      {
        assignedOperatorId: plan.operatorId,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
      },
    ]);

    const operationKey = randomUUID();
    const command = {
      operatorId: plan.operatorId,
      postId: plan.postId,
      label: 'Индивидуальная смена публикации',
      operationKey,
    };

    const created = await request(app.getHttpServer())
      .post('/api/production/operator-shifts')
      .set(asLead)
      .send(command)
      .expect(201);
    expect(created.body.dispatchItemIds).toEqual(plan.dispatchItems.map(({ id }) => id).sort());

    await expect(
      prisma.productionOrder.findUniqueOrThrow({
        where: { id: plan.productionOrderId },
        select: { approvalState: true, indicator: true, assignedOwnerId: true },
      }),
    ).resolves.toEqual({
      approvalState: 'approved',
      indicator: 'in_production',
      assignedOwnerId: leadId,
    });
    await expect(
      prisma.rollDispatchItem.findMany({
        where: { productionOrderId: plan.productionOrderId },
        select: {
          assignedOperatorId: true,
          plannedShiftId: true,
          postId: true,
          machineId: true,
          workplaceId: true,
          status: true,
        },
        orderBy: { queueRank: 'asc' },
      }),
    ).resolves.toEqual(
      plan.dispatchItems.map(() => ({
        assignedOperatorId: plan.operatorId,
        plannedShiftId: created.body.shift.id,
        postId: plan.postId,
        machineId: expect.stringMatching(/^SHIFT-PUBLISH-/u),
        workplaceId: plan.postId,
        status: 'assigned',
      })),
    );
    const runtime = await request(app.getHttpServer())
      .get('/api/operator/runtime')
      .set(plan.asOperator)
      .expect(200);
    expect(runtime.body.orders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: plan.orderNumber,
          rolls: expect.arrayContaining([
            expect.objectContaining({
              id: plan.dispatchItems[0].rollCode,
              status: 'assigned',
            }),
            expect.objectContaining({
              id: plan.dispatchItems[1].rollCode,
              status: 'assigned',
            }),
          ]),
        }),
      ]),
    );
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:production_order_approved',
          objectId: plan.productionOrderId,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:task_assigned',
          objectId: { in: plan.dispatchItems.map(({ rollCode }) => rollCode) },
        },
      }),
    ).resolves.toBe(2);

    const replay = await request(app.getHttpServer())
      .post('/api/production/operator-shifts')
      .set(asLead)
      .send(command)
      .expect(201);
    expect(replay.body).toEqual(created.body);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:production_order_approved',
          objectId: plan.productionOrderId,
        },
      }),
    ).resolves.toBe(1);
    await expect(prisma.shift.count({ where: { operationKey } })).resolves.toBe(1);
  });

  it('assigns a later roll to the unique prepared shift and publishes the order', async () => {
    const plan = await createPendingPlan('shift-first', 1);
    const operationKey = randomUUID();

    const created = await request(app.getHttpServer())
      .post('/api/production/operator-shifts')
      .set(asLead)
      .send({
        operatorId: plan.operatorId,
        postId: plan.postId,
        label: 'Пустая подготовленная смена',
        operationKey,
      })
      .expect(201);
    expect(created.body.dispatchItemIds).toEqual([]);

    await expect(
      prisma.productionOrder.findUniqueOrThrow({
        where: { id: plan.productionOrderId },
        select: { approvalState: true },
      }),
    ).resolves.toEqual({ approvalState: 'pending' });

    const assignment = await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${plan.dispatchItems[0].rollCode}/assign`)
      .set(asLead)
      .send({ operatorId: plan.operatorId })
      .expect(201);
    expect(assignment.body).toEqual(
      expect.objectContaining({
        rollCode: plan.dispatchItems[0].rollCode,
        status: 'assigned',
      }),
    );

    await expect(
      prisma.productionOrder.findUniqueOrThrow({
        where: { id: plan.productionOrderId },
        select: { approvalState: true, indicator: true, assignedOwnerId: true },
      }),
    ).resolves.toEqual({
      approvalState: 'approved',
      indicator: 'in_production',
      assignedOwnerId: leadId,
    });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({
        where: { id: plan.dispatchItems[0].id },
        select: {
          assignedOperatorId: true,
          plannedShiftId: true,
          postId: true,
          machineId: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      assignedOperatorId: plan.operatorId,
      plannedShiftId: created.body.shift.id,
      postId: plan.postId,
      machineId: expect.stringMatching(/^SHIFT-PUBLISH-/u),
      status: 'assigned',
    });
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:production_order_approved',
          objectId: plan.productionOrderId,
        },
      }),
    ).resolves.toBe(1);
  });

  it('assigns and reassigns a 700-roll order atomically within the transaction budget', async () => {
    const plan = await createPendingPlan('large-order', 700);
    const replacement = await createPendingPlan('large-order-replacement', 1);
    for (const operator of [plan, replacement]) {
      await request(app.getHttpServer())
        .post('/api/production/operator-shifts')
        .set(asLead)
        .send({
          operatorId: operator.operatorId,
          postId: operator.postId,
          label: 'Большой заказ',
          operationKey: randomUUID(),
        })
        .expect(201);
    }

    for (const operator of [plan, replacement]) {
      const response = await request(app.getHttpServer())
        .post('/api/production/roll-dispatch/bulk-assign')
        .set(asLead)
        .send({
          rollIds: plan.dispatchItems.map(({ rollCode }) => rollCode),
          operatorId: operator.operatorId,
        })
        .expect(201);
      expect(response.body).toEqual({ assigned: 700, operatorId: operator.operatorId });
      expect(
        await prisma.rollDispatchItem.count({
          where: {
            productionOrderId: plan.productionOrderId,
            assignedOperatorId: operator.operatorId,
            postId: operator.postId,
            status: 'assigned',
          },
        }),
      ).toBe(700);
    }
    expect(
      await prisma.operatorRollLine.count({
        where: { rollDispatchItemId: { in: plan.dispatchItems.map(({ id }) => id) } },
      }),
    ).toBe(700);
    expect(
      await prisma.domainEvent.count({
        where: {
          type: 'audit:task_reassigned',
          objectId: { in: plan.dispatchItems.map(({ rollCode }) => rollCode) },
        },
      }),
    ).toBe(700);
  });

  it('exposes a fully assigned roll while its sibling remains unassigned', async () => {
    const plan = await createPendingPlan('partial-order', 2);
    const created = await request(app.getHttpServer())
      .post('/api/production/operator-shifts')
      .set(asLead)
      .send({
        operatorId: plan.operatorId,
        postId: plan.postId,
        label: 'Частично назначенный заказ',
        operationKey: randomUUID(),
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${plan.dispatchItems[0].rollCode}/assign`)
      .set(asLead)
      .send({ operatorId: plan.operatorId })
      .expect(201);

    await expect(
      prisma.productionOrder.findUniqueOrThrow({
        where: { id: plan.productionOrderId },
        select: { approvalState: true },
      }),
    ).resolves.toEqual({ approvalState: 'pending' });
    await expect(
      prisma.rollDispatchItem.findMany({
        where: { productionOrderId: plan.productionOrderId },
        select: {
          assignedOperatorId: true,
          plannedShiftId: true,
          postId: true,
          status: true,
        },
        orderBy: { queueRank: 'asc' },
      }),
    ).resolves.toEqual([
      {
        assignedOperatorId: plan.operatorId,
        plannedShiftId: created.body.shift.id,
        postId: plan.postId,
        status: 'assigned',
      },
      {
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        status: 'new',
      },
    ]);
    await expect(
      prisma.operatorRollLine.count({
        where: { rollDispatchItem: { productionOrderId: plan.productionOrderId } },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:task_assigned',
          objectId: plan.dispatchItems[0].rollCode,
        },
      }),
    ).resolves.toBe(1);

    await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${plan.dispatchItems[0].rollCode}/assign`)
      .set(asLead)
      .send({ operatorId: plan.operatorId })
      .expect(201);
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({
        where: { id: plan.dispatchItems[0].id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'assigned' });
    await expect(
      prisma.operatorRollLine.count({
        where: { rollDispatchItemId: plan.dispatchItems[0].id },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:task_assigned',
          objectId: plan.dispatchItems[0].rollCode,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:roll_dispatch_assigned',
          objectId: plan.dispatchItems[0].rollCode,
        },
      }),
    ).resolves.toBe(1);

    const runtime = await request(app.getHttpServer())
      .get('/api/operator/runtime')
      .set(plan.asOperator)
      .expect(200);
    expect(runtime.body.orders).toEqual([
      expect.objectContaining({
        id: plan.orderNumber,
        rolls: [
          expect.objectContaining({
            id: plan.dispatchItems[0].rollCode,
            status: 'assigned',
          }),
        ],
      }),
    ]);

    const bag = await prisma.bigBagUnit.create({
      data: {
        code: `SHIFT-PUBLISH-BAG-${randomUUID()}`,
        material: 'ПВД 15803-020',
        initialKg: 100,
        currentKg: 100,
        status: 'available',
        registrationStatus: 'registered',
        location: 'production',
        createdByRole: 'warehouse',
      },
    });
    await request(app.getHttpServer())
      .post('/api/operator/shift/open')
      .set(plan.asOperator)
      .send({ bigBagId: bag.id, startKg: 100 })
      .expect(201);
    const accepted = await request(app.getHttpServer())
      .post(`/api/operator/rolls/${plan.dispatchItems[0].rollCode}/accept`)
      .set(plan.asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    expect(accepted.body).toEqual(
      expect.objectContaining({
        rollCode: plan.dispatchItems[0].rollCode,
        step: 'spool_weight',
      }),
    );

    await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${plan.dispatchItems[1].rollCode}/assign`)
      .set(asLead)
      .send({ operatorId: plan.operatorId })
      .expect(201);
    await expect(
      prisma.productionOrder.findUniqueOrThrow({
        where: { id: plan.productionOrderId },
        select: { approvalState: true },
      }),
    ).resolves.toEqual({ approvalState: 'approved' });
    await expect(
      prisma.domainEvent.groupBy({
        by: ['objectId'],
        where: {
          type: 'audit:task_assigned',
          objectId: { in: plan.dispatchItems.map(({ rollCode }) => rollCode) },
        },
        _count: { _all: true },
        orderBy: { objectId: 'asc' },
      }),
    ).resolves.toEqual(
      plan.dispatchItems
        .map(({ rollCode }) => ({
          objectId: rollCode,
          _count: { _all: 1 },
        }))
        .sort((left, right) => left.objectId.localeCompare(right.objectId)),
    );
  });

  it('rejects browser-selected dispatch ids at the individual-shift boundary', async () => {
    const plan = await createPendingPlan('forbidden-dispatch-input', 1);
    const operationKey = randomUUID();

    await request(app.getHttpServer())
      .post('/api/production/operator-shifts')
      .set(asLead)
      .send({
        operatorId: plan.operatorId,
        postId: plan.postId,
        dispatchItemIds: [plan.dispatchItems[0].id],
        operationKey,
      })
      .expect(400);

    await expect(prisma.shift.count({ where: { operationKey } })).resolves.toBe(0);
  });
});
