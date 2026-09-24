import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth/password';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ProductionService } from '../src/modules/production/production.service';
import {
  approveProductionOnlyCover,
  PRIMARY_BASE_MATERIAL_SELECTION,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';
import { prepareReadyDefectBagFixture } from './operator-shift-e2e-fixture';
import { enableSimulatedDevices } from './simulated-device-fixture';

describe('Paid commercial handoff and production publication (e2e, real DB)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let production: ProductionService;
  let printerOnlyDeviceId: string | null = null;
  let printerOnlyPostId: string | null = null;
  let restoreDedicatedDevices: (() => Promise<void>) | null = null;
  const asCommercial = { 'x-role': 'commercial' };
  const asFinance = { 'x-role': 'finance' };
  const asProduction = { 'x-role': 'production_lead' };
  const asOperator = { 'x-role': 'operator' };
  const asWarehouse = { 'x-role': 'warehouse' };
  const uniq = Date.now();

  async function waitForBlockedRowLock(tableName: string, expectedWaiters = 1): Promise<void> {
    const deadline = Date.now() + 3_000;
    const queryPattern = `%FROM "${tableName}"%FOR UPDATE%`;
    while (Date.now() < deadline) {
      const [state] = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT COUNT(*)::int AS waiting
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE ${queryPattern}
      `;
      if ((state?.waiting ?? 0) >= expectedWaiters) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const observations = await prisma.$queryRaw<
      Array<{ query: string; waitEvent: string | null; waitEventType: string | null }>
    >`
      SELECT LEFT(query, 240) AS query,
             wait_event AS "waitEvent",
             wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND state <> 'idle'
    `;
    throw new Error(
      `Timed out waiting for ${expectedWaiters} ${tableName} row lock(s): ${JSON.stringify(observations)}`,
    );
  }

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'on';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    production = moduleRef.get(ProductionService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'production write simulated topology',
          run: async () => {
            await restoreDedicatedDevices?.();
            restoreDedicatedDevices = null;
          },
        },
        {
          label: 'production write printer-only device',
          run: async () => {
            if (printerOnlyDeviceId) {
              await prisma.deviceRuntime.deleteMany({ where: { id: printerOnlyDeviceId } });
              printerOnlyDeviceId = null;
            }
          },
        },
        {
          label: 'production write printer-only post',
          run: async () => {
            if (printerOnlyPostId) {
              await prisma.post.deleteMany({ where: { id: printerOnlyPostId } });
              printerOnlyPostId = null;
            }
          },
        },
        { label: 'production write application', run: () => app.close() },
      ],
    );
  });

  it('requires payment and explicit commercial handoff before production can publish rolls', async () => {
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `E2E Production ${uniq}` })
      .expect(201);

    const commercialOrder = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        mode: 'submit',
        counterpartyId: cp.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 2,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            widthMm: 1700,
            plannedLengthM: 500,
            recipeParameters: [
              { label: 'План. вес, кг', value: '41.2' },
              { label: 'Метраж, м', value: '500' },
            ],
          },
        ],
      })
      .expect(201);

    await approveProductionOnlyCover(app, prisma, asCommercial, commercialOrder.body);

    await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/send-to-production`)
      .set(asCommercial)
      .expect(409);

    await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({ amount: 100_000, note: 'E2E production handoff' })
      .expect(201);

    const financeOrders = await request(app.getHttpServer())
      .get('/api/finance/orders')
      .set(asFinance)
      .expect(200);
    const financeOrder = financeOrders.body.find(
      (order: { commercialOrder?: { id: string } }) =>
        order.commercialOrder?.id === commercialOrder.body.id,
    );
    expect(financeOrder).toBeTruthy();

    const invoiced = await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(asFinance)
      .send({ amount: 100000, paymentTermsType: 'prepay_50_postpay_50_30d' })
      .expect(201);
    const prepayment = invoiced.body.schedules.find(
      (schedule: { kind: string }) => schedule.kind === 'invoice_prepayment',
    );
    await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrder.id}/payment-schedules/${prepayment.id}/confirm`)
      .set(asFinance)
      .send({})
      .expect(201);

    const paidCommercialOrder = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${commercialOrder.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(paidCommercialOrder.body.nextAction).toEqual(
      expect.objectContaining({ code: 'send_to_production', allowed: true }),
    );

    const beforeHandoff = await request(app.getHttpServer())
      .get('/api/production/orders')
      .set(asProduction)
      .expect(200);
    expect(
      beforeHandoff.body.some(
        (order: { commercialOrderId: string }) =>
          order.commercialOrderId === commercialOrder.body.id,
      ),
    ).toBe(false);

    await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/send-to-production`)
      .set(asFinance)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/production/orders')
      .set(asProduction)
      .send({ commercialOrderId: commercialOrder.body.id })
      .expect(403);

    const productionOrder = await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/send-to-production`)
      .set(asCommercial)
      .expect(201);
    expect(productionOrder.body.dispatchItems).toHaveLength(2);
    expect(productionOrder.body.dispatchItems[0]).toEqual(
      expect.objectContaining({ plannedWeightKg: 41.2, plannedLengthM: 500, status: 'new' }),
    );

    const repeatHandoff = await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/send-to-production`)
      .set(asCommercial)
      .expect(201);
    expect(repeatHandoff.body.id).toBe(productionOrder.body.id);
    expect(repeatHandoff.body.dispatchItems).toHaveLength(2);

    const now = Date.now();
    const shift = await request(app.getHttpServer())
      .post('/api/production/shifts')
      .set(asProduction)
      .send({
        label: `E2E смена ${uniq}`,
        plannedStartAt: new Date(now + 60 * 60 * 1000).toISOString(),
        plannedEndAt: new Date(now + 9 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201);
    const dedicatedPosts = await Promise.all(
      ['A', 'B', 'LIFECYCLE'].map((label) =>
        prisma.post.create({
          data: {
            code: `A-PRODUCTION-${label}-${uniq}`,
            name: `Production write ${label} ${uniq}`,
            status: 'active',
            devices: {
              create: (['scale', 'printer', 'scanner'] as const).map((kind) => ({
                code: `A-PRODUCTION-${kind.toUpperCase()}-${label}-${uniq}`,
                label: `Production write ${kind} ${label} ${uniq}`,
                kind,
                isEnabled: true,
              })),
            },
          },
        }),
      ),
    );
    const dedicatedPostIds = new Set(dedicatedPosts.map((post) => post.id));
    const dedicatedDevices = await prisma.deviceRuntime.findMany({
      where: { postId: { in: dedicatedPosts.map((post) => post.id) } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    restoreDedicatedDevices = await enableSimulatedDevices(
      prisma,
      dedicatedDevices.map((device) => device.id),
    );
    const printerOnlyPost = await prisma.post.create({
      data: {
        code: `A-PRINTER-ONLY-${uniq}`,
        name: `Printer-only decoy ${uniq}`,
        status: 'active',
      },
    });
    printerOnlyPostId = printerOnlyPost.id;
    const printerOnlyDevice = await prisma.deviceRuntime.create({
      data: {
        code: `A-PRINTER-ONLY-${uniq}`,
        label: `Printer-only decoy ${uniq}`,
        kind: 'printer',
        status: 'ready',
        isEnabled: true,
        postId: printerOnlyPost.id,
      },
    });
    printerOnlyDeviceId = printerOnlyDevice.id;
    const posts = await request(app.getHttpServer())
      .get('/api/production/posts')
      .set(asProduction)
      .expect(200);
    const enabledScalePostIds = new Set(
      (
        await prisma.deviceRuntime.findMany({
          where: { kind: 'scale', isEnabled: true, postId: { not: null } },
          select: { postId: true },
        })
      ).flatMap((device) => (device.postId ? [device.postId] : [])),
    );
    const activePosts = posts.body
      .filter(
        (item: { id: string; status: string }) =>
          item.status === 'active' &&
          enabledScalePostIds.has(item.id) &&
          dedicatedPostIds.has(item.id),
      )
      .sort((left: { code: string }, right: { code: string }) =>
        left.code.localeCompare(right.code),
      );
    expect(posts.body.some((item: { id: string }) => item.id === printerOnlyPost.id)).toBe(true);
    expect(activePosts.some((item: { id: string }) => item.id === printerOnlyPost.id)).toBe(false);
    expect(activePosts).toHaveLength(3);

    const operatorPassword = e2eSeedPassword();
    const operatorLogins = [
      `production-write-a-${uniq}`,
      `production-write-b-${uniq}`,
      `production-write-lifecycle-${uniq}`,
    ];
    await prisma.user.createMany({
      data: operatorLogins.map((login, index) => ({
        externalId: `e2e:${login}`,
        login,
        passwordHash: hashPassword(operatorPassword),
        displayName: `Production write operator ${index + 1}`,
        role: Role.operator,
      })),
    });

    // Dedicated accounts keep this test independent from demo/pilot operator sessions and
    // allow consecutive runs against the same database without reusing operational state.
    const [login1, login2, lifecycleLogin] = await Promise.all(
      operatorLogins.map((login) =>
        request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ login, password: operatorPassword })
          .expect(201),
      ),
    );
    const operators = [login1.body.user, login2.body.user];
    const bearers = [
      { Authorization: `Bearer ${login1.body.token}` },
      { Authorization: `Bearer ${login2.body.token}` },
    ];
    const [activePostSessions, usablePostAssignments] = await Promise.all([
      prisma.operatorPostSession.findMany({
        where: { status: 'active' },
        select: { postId: true },
      }),
      prisma.operatorShiftMachineAssignment.findMany({
        where: {
          status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
          shift: { status: { in: ['planned', 'open'] } },
        },
        select: { postId: true },
      }),
    ]);
    const occupiedPostIds = new Set([
      ...activePostSessions.map((session) => session.postId),
      ...usablePostAssignments.map((assignment) => assignment.postId),
    ]);
    const lifecyclePost = activePosts.find((post: { id: string }) => !occupiedPostIds.has(post.id));
    expect(lifecyclePost).toBeTruthy();
    await expect(
      prisma.operatorShiftMachineAssignment.count({
        where: {
          postId: lifecyclePost!.id,
          status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
          shift: { status: { in: ['planned', 'open'] } },
        },
      }),
    ).resolves.toBe(0);

    const lifecycleStartAt = Date.now() + 30 * 60 * 1000;
    const lifecycleShift = await request(app.getHttpServer())
      .post('/api/production/shifts')
      .set(asProduction)
      .send({
        label: `E2E закрытая смена ${uniq}`,
        plannedStartAt: new Date(lifecycleStartAt).toISOString(),
        plannedEndAt: new Date(lifecycleStartAt + 60 * 60 * 1000).toISOString(),
      })
      .expect(201);
    await request(app.getHttpServer())
      .put(
        `/api/production/shifts/${lifecycleShift.body.id}/operators/${lifecycleLogin.body.user.id}/machine`,
      )
      .set(asProduction)
      .send({ postId: lifecyclePost.id })
      .expect(200);
    const lifecycleRoll = productionOrder.body.dispatchItems[0].rollCode as string;
    await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${lifecycleRoll}/assign`)
      .set(asProduction)
      .send({
        operatorId: lifecycleLogin.body.user.id,
      })
      .expect(201);
    const lifecycleMachineCommand = {
      machineId: lifecyclePost.code as string,
      scope: 'roll',
      reason: 'E2E lifecycle retry baseline',
    };
    await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${lifecycleRoll}/machine`)
      .set(asProduction)
      .send(lifecycleMachineCommand)
      .expect(201);
    const lifecycleMachineCounts = await Promise.all([
      prisma.machineAssignment.count({
        where: { rollDispatchItemId: productionOrder.body.dispatchItems[0].id },
      }),
      prisma.domainEvent.count({
        where: { type: 'audit:machine_assigned', objectId: lifecycleRoll },
      }),
    ]);
    // The planning API correctly requires a future shift. Move only the fixture's time window
    // after planning so the supported operator open/close APIs can run without a wall-clock wait.
    await prisma.shift.update({
      where: { id: lifecycleShift.body.id },
      data: {
        plannedStartAt: new Date(Date.now() - 60 * 1000),
        plannedEndAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    const lifecycleBag = await prisma.bigBagUnit.create({
      data: {
        code: `BB-PRODUCTION-LIFECYCLE-${uniq}`,
        material: 'E2E lifecycle fixture',
        status: 'available',
        registrationStatus: 'registered',
        location: 'production',
        initialKg: 5,
        currentKg: 5,
        lastMeasuredKg: 5,
      },
    });
    const lifecycleBearer = {
      Authorization: `Bearer ${lifecycleLogin.body.token as string}`,
    };
    await request(app.getHttpServer())
      .post('/api/operator/shift/open')
      .set(lifecycleBearer)
      .send({ postCode: lifecyclePost.code, bigBagId: lifecycleBag.id, startKg: 5 })
      .expect(201);
    await prepareReadyDefectBagFixture(prisma, lifecycleLogin.body.user.id as string);
    await request(app.getHttpServer())
      .post('/api/operator/shift/close')
      .set(lifecycleBearer)
      .send({ operationKey: randomUUID(), bags: [{ bigBagId: lifecycleBag.id, endKg: 5 }] })
      .expect(200);
    await expect(
      prisma.shift.findUniqueOrThrow({ where: { id: lifecycleShift.body.id } }),
    ).resolves.toMatchObject({ status: 'closed' });
    await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${lifecycleRoll}/machine`)
      .set(asProduction)
      .send(lifecycleMachineCommand)
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'PRODUCTION_ASSIGNMENT_LIFECYCLE_CONFLICT' });
      });
    await expect(
      Promise.all([
        prisma.machineAssignment.count({
          where: { rollDispatchItemId: productionOrder.body.dispatchItems[0].id },
        }),
        prisma.domainEvent.count({
          where: { type: 'audit:machine_assigned', objectId: lifecycleRoll },
        }),
      ]),
    ).resolves.toEqual(lifecycleMachineCounts);

    const replannedWithoutUsableShift = await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${lifecycleRoll}/assign`)
      .set(asProduction)
      .send({
        operatorId: lifecycleLogin.body.user.id,
      })
      .expect(201);
    expect(replannedWithoutUsableShift.body).toEqual(
      expect.objectContaining({
        assignedOperatorId: lifecycleLogin.body.user.id,
        plannedShiftId: null,
        machineId: null,
        postId: null,
        workplaceId: null,
      }),
    );

    for (const [index, operator] of operators.entries()) {
      await request(app.getHttpServer())
        .put(`/api/production/shifts/${shift.body.id}/operators/${operator.id}/machine`)
        .set(asProduction)
        .send({ postId: activePosts[index].id })
        .expect(200);
    }

    for (const [index, roll] of (
      productionOrder.body.dispatchItems as Array<{ rollCode: string }>
    ).entries()) {
      const planned = await request(app.getHttpServer())
        .post(`/api/production/roll-dispatch/${roll.rollCode}/assign`)
        .set(asProduction)
        .send({ operatorId: operators[index].id })
        .expect(201);
      expect(planned.body).toEqual(
        expect.objectContaining({
          status: 'assigned',
          assignedOperatorId: operators[index].id,
          plannedShiftId: shift.body.id,
          postId: activePosts[index].id,
          machineId: activePosts[index].code,
          workplaceId: activePosts[index].id,
        }),
      );
    }

    const machineRoll = productionOrder.body.dispatchItems[0].rollCode as string;
    const machineHistoryBefore = await prisma.machineAssignment.count({
      where: { rollDispatchItemId: productionOrder.body.dispatchItems[0].id },
    });
    const machineAuditBefore = await prisma.domainEvent.count({
      where: { type: 'audit:machine_assigned', objectId: machineRoll },
    });
    const machineCommand = {
      machineId: activePosts[0].code as string,
      scope: 'roll',
      reason: 'E2E exact machine retry',
    };
    const firstMachineAssignment = await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${machineRoll}/machine`)
      .set(asProduction)
      .send(machineCommand)
      .expect(201);
    const countsAfterFirstMachineAssignment = await Promise.all([
      prisma.machineAssignment.count({
        where: { rollDispatchItemId: productionOrder.body.dispatchItems[0].id },
      }),
      prisma.domainEvent.count({
        where: { type: 'audit:machine_assigned', objectId: machineRoll },
      }),
    ]);
    expect(countsAfterFirstMachineAssignment).toEqual([
      machineHistoryBefore + 1,
      machineAuditBefore + 1,
    ]);
    const repeatedMachineAssignment = await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${machineRoll}/machine`)
      .set(asProduction)
      .send(machineCommand)
      .expect(201);
    expect(repeatedMachineAssignment.body).toMatchObject({
      id: firstMachineAssignment.body.id,
      machineId: firstMachineAssignment.body.machineId,
      postId: firstMachineAssignment.body.postId,
    });
    await expect(
      Promise.all([
        prisma.machineAssignment.count({
          where: { rollDispatchItemId: productionOrder.body.dispatchItems[0].id },
        }),
        prisma.domainEvent.count({
          where: { type: 'audit:machine_assigned', objectId: machineRoll },
        }),
      ]),
    ).resolves.toEqual(countsAfterFirstMachineAssignment);

    const serializedMachineCommand = {
      machineId: activePosts[0].code as string,
      scope: 'roll',
      reason: 'E2E serialized command after divergent writer',
    };
    const divergentMachineReason = 'E2E concurrent divergent writer';
    const serializedRollId = productionOrder.body.dispatchItems[0].id as string;
    const serializedPostId = activePosts[0].id as string;
    let releasePostGate: () => void = () => undefined;
    let markPostGateLocked: () => void = () => undefined;
    const postGateLocked = new Promise<void>((resolve) => {
      markPostGateLocked = resolve;
    });
    const postGateRelease = new Promise<void>((resolve) => {
      releasePostGate = resolve;
    });
    const postGate = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "posts" WHERE "id" = ${serializedPostId} FOR UPDATE`;
      markPostGateLocked();
      await postGateRelease;
    });
    await postGateLocked;
    const delayedSerializedCommand = Promise.resolve(
      request(app.getHttpServer())
        .post(`/api/production/roll-dispatch/${machineRoll}/machine`)
        .set(asProduction)
        .send(serializedMachineCommand),
    );
    let postWaitFailure: unknown;
    try {
      await waitForBlockedRowLock('posts');
    } catch (error) {
      postWaitFailure = error;
    }
    if (postWaitFailure) {
      releasePostGate();
      await Promise.allSettled([postGate, delayedSerializedCommand]);
      throw postWaitFailure;
    }

    let releaseDivergentWriter: () => void = () => undefined;
    let markDivergentWriterLocked: () => void = () => undefined;
    const divergentWriterLocked = new Promise<void>((resolve) => {
      markDivergentWriterLocked = resolve;
    });
    const divergentWriterRelease = new Promise<void>((resolve) => {
      releaseDivergentWriter = resolve;
    });
    const divergentWriter = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "roll_dispatch_items" WHERE "id" = ${serializedRollId} FOR UPDATE`;
      const [futureClock] = await tx.$queryRaw<Array<{ createdAt: Date }>>`
        SELECT clock_timestamp() + INTERVAL '1 hour' AS "createdAt"
      `;
      await tx.machineAssignment.create({
        data: {
          id: `machine-assignment-concurrent-${uniq}`,
          rollDispatchItemId: serializedRollId,
          productionOrderId: productionOrder.body.id as string,
          machineId: serializedMachineCommand.machineId,
          postId: serializedPostId,
          scope: serializedMachineCommand.scope,
          reason: divergentMachineReason,
          createdAt: futureClock.createdAt,
        },
      });
      markDivergentWriterLocked();
      await divergentWriterRelease;
    });
    await divergentWriterLocked;
    releasePostGate();
    await postGate;
    let rollWaitFailure: unknown;
    try {
      await waitForBlockedRowLock('roll_dispatch_items');
    } catch (error) {
      rollWaitFailure = error;
    } finally {
      releaseDivergentWriter();
    }
    const [serializedResponse] = await Promise.all([delayedSerializedCommand, divergentWriter]);
    if (rollWaitFailure) throw rollWaitFailure;
    expect(serializedResponse.status).toBe(201);
    const serializedCounts = await Promise.all([
      prisma.machineAssignment.count({ where: { rollDispatchItemId: serializedRollId } }),
      prisma.domainEvent.count({
        where: { type: 'audit:machine_assigned', objectId: machineRoll },
      }),
    ]);

    await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${machineRoll}/machine`)
      .set(asProduction)
      .send(serializedMachineCommand)
      .expect(201);

    await expect(
      Promise.all([
        prisma.machineAssignment.count({ where: { rollDispatchItemId: serializedRollId } }),
        prisma.domainEvent.count({
          where: { type: 'audit:machine_assigned', objectId: machineRoll },
        }),
      ]),
    ).resolves.toEqual(serializedCounts);
    const [serializedHistory, divergentHistory] = await Promise.all([
      prisma.machineAssignment.findFirstOrThrow({
        where: { rollDispatchItemId: serializedRollId, reason: serializedMachineCommand.reason },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.machineAssignment.findFirstOrThrow({
        where: { rollDispatchItemId: serializedRollId, reason: divergentMachineReason },
      }),
    ]);
    expect(serializedHistory.createdAt.getTime()).toBeGreaterThan(
      divergentHistory.createdAt.getTime(),
    );

    await expect(
      prisma.productionOrder.findUniqueOrThrow({
        where: { id: productionOrder.body.id },
        select: { approvalState: true },
      }),
    ).resolves.toEqual({ approvalState: 'approved' });
    await expect(
      prisma.domainEvent.count({
        where: { type: 'audit:production_order_approved', objectId: productionOrder.body.id },
      }),
    ).resolves.toBe(1);
    const taskAuditsBeforeApproval = await prisma.domainEvent.count({
      where: {
        type: { in: ['audit:task_assigned', 'audit:task_reassigned'] },
        objectId: {
          in: productionOrder.body.dispatchItems.map((item: { rollCode: string }) => item.rollCode),
        },
      },
    });
    expect(taskAuditsBeforeApproval).toBe(4);

    await request(app.getHttpServer())
      .post(`/api/production/orders/${productionOrder.body.id}/approve`)
      .set(asProduction)
      .expect(201);

    for (const [index, bearer] of bearers.entries()) {
      const operatorRuntimeAfter = await request(app.getHttpServer())
        .get('/api/operator/runtime')
        .set(bearer)
        .expect(200);
      const publishedOrder = operatorRuntimeAfter.body.orders.find(
        (order: { id?: string }) => order.id === commercialOrder.body.orderNumber,
      );
      expect(publishedOrder).toBeTruthy();
      expect(publishedOrder.rolls).toHaveLength(1);
      expect(publishedOrder.rolls[0].id).toBe(productionOrder.body.dispatchItems[index].rollCode);
      const operatorInboxAfter = await request(app.getHttpServer())
        .get('/api/operator/notifications?limit=100')
        .set(bearer)
        .expect(200);
      expect(
        operatorInboxAfter.body.items.filter(
          (item: {
            eventType: string;
            orderId: string;
            rollId: string | null;
            cta: { kind: string; targetId: string };
          }) =>
            item.eventType === (index === 0 ? 'audit:task_reassigned' : 'audit:task_assigned') &&
            item.orderId === commercialOrder.body.id &&
            item.rollId === null &&
            item.cta.kind === 'operator_queue' &&
            item.cta.targetId === commercialOrder.body.id,
        ),
      ).toHaveLength(1);
      expect(
        operatorInboxAfter.body.items.some(
          (item: { eventType: string; orderId: string }) =>
            item.orderId === commercialOrder.body.id &&
            [
              'audit:roll_dispatch_assigned',
              'audit:roll_dispatch_bulk_assigned',
              'audit:production_order_approved',
            ].includes(item.eventType),
        ),
      ).toBe(false);
    }
    const taskAuditsAfterApproval = await prisma.domainEvent.findMany({
      where: {
        type: { in: ['audit:task_assigned', 'audit:task_reassigned'] },
        objectId: {
          in: productionOrder.body.dispatchItems.map((item: { rollCode: string }) => item.rollCode),
        },
      },
      select: { id: true, type: true, objectId: true, detail: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(taskAuditsAfterApproval).toHaveLength(4);
    expect(taskAuditsAfterApproval).toEqual(
      expect.arrayContaining(
        productionOrder.body.dispatchItems.map((item: { rollCode: string }, index: number) =>
          expect.objectContaining({
            objectId: item.rollCode,
            detail: expect.objectContaining({
              commercialOrderId: commercialOrder.body.id,
              operatorId: operators[index].id,
              productionOrderId: productionOrder.body.id,
              rollId: item.rollCode,
            }),
          }),
        ),
      ),
    );
    const originalAssignmentEvent = taskAuditsAfterApproval.find(
      (event) =>
        event.objectId === productionOrder.body.dispatchItems[0].rollCode &&
        (event.detail as { operatorId?: string }).operatorId === operators[0].id,
    );
    expect(originalAssignmentEvent).toBeTruthy();
    if (!originalAssignmentEvent) throw new Error('Expected the original operator assignment');
    await request(app.getHttpServer())
      .post(`/api/production/orders/${productionOrder.body.id}/approve`)
      .set(asProduction)
      .expect(201);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: { in: ['audit:task_assigned', 'audit:task_reassigned'] },
          objectId: {
            in: productionOrder.body.dispatchItems.map(
              (item: { rollCode: string }) => item.rollCode,
            ),
          },
        },
      }),
    ).resolves.toBe(taskAuditsBeforeApproval);

    const reassignedRoll = productionOrder.body.dispatchItems[0].rollCode as string;
    await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${reassignedRoll}/assign`)
      .set(asProduction)
      .send({ operatorId: operators[1].id })
      .expect(201);
    const reassignmentEvent = await prisma.domainEvent.findFirstOrThrow({
      where: { type: 'audit:task_reassigned', objectId: reassignedRoll },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(reassignmentEvent.detail).toEqual(
      expect.objectContaining({
        commercialOrderId: commercialOrder.body.id,
        operatorId: operators[1].id,
        previousOperatorId: operators[0].id,
        productionOrderId: productionOrder.body.id,
        rollId: reassignedRoll,
      }),
    );
    const [previousInbox, newInbox] = await Promise.all([
      request(app.getHttpServer())
        .get('/api/operator/notifications?limit=100')
        .set(bearers[0])
        .expect(200),
      request(app.getHttpServer())
        .get('/api/operator/notifications?limit=100')
        .set(bearers[1])
        .expect(200),
    ]);
    const previousCard = previousInbox.body.items.find(
      (item: { id: string }) => item.id === reassignmentEvent.id,
    );
    const previousAssignmentCard = previousInbox.body.items.find((item: { eventIds: string[] }) =>
      item.eventIds.includes(originalAssignmentEvent.id),
    );
    const newCard = newInbox.body.items.find(
      (item: { id: string }) => item.id === reassignmentEvent.id,
    );
    expect(previousInbox.body.unreadCount).toBeGreaterThanOrEqual(
      previousInbox.body.items.filter((item: { unread: boolean }) => item.unread).length,
    );
    expect(previousInbox.body.nextCursor).toBeNull();
    expect(previousAssignmentCard).toEqual(
      expect.objectContaining({
        orderId: commercialOrder.body.id,
        orderNumber: commercialOrder.body.orderNumber,
        positionId: null,
        rollId: null,
        unread: true,
        cta: {
          kind: 'operator_queue',
          targetId: commercialOrder.body.id,
          section: 'Рулоны и заказы',
        },
      }),
    );
    expect(previousAssignmentCard.cta.targetId).not.toBe(reassignedRoll);
    expect(previousCard).toEqual(
      expect.objectContaining({
        orderId: commercialOrder.body.id,
        orderNumber: commercialOrder.body.orderNumber,
        positionId: null,
        rollId: null,
        unread: true,
        cta: {
          kind: 'operator_queue',
          targetId: commercialOrder.body.id,
          section: 'Рулоны и заказы',
        },
      }),
    );
    expect(newCard).toEqual(
      expect.objectContaining({
        orderId: commercialOrder.body.id,
        orderNumber: commercialOrder.body.orderNumber,
        positionId: null,
        rollId: null,
        unread: true,
        cta: {
          kind: 'operator_queue',
          targetId: commercialOrder.body.id,
          section: 'Рулоны и заказы',
        },
      }),
    );
    const firstPreviousPage = await request(app.getHttpServer())
      .get('/api/operator/notifications?limit=1')
      .set(bearers[0])
      .expect(200);
    expect(firstPreviousPage.body.items).toHaveLength(1);
    expect(firstPreviousPage.body.nextCursor).toEqual(expect.any(String));
    const secondPreviousPage = await request(app.getHttpServer())
      .get(
        `/api/operator/notifications?limit=1&cursor=${encodeURIComponent(
          firstPreviousPage.body.nextCursor,
        )}`,
      )
      .set(bearers[0])
      .expect(200);
    expect(secondPreviousPage.body.items).toHaveLength(1);
    expect(
      new Set([firstPreviousPage.body.items[0].id, secondPreviousPage.body.items[0].id]),
    ).toEqual(new Set([reassignmentEvent.id, originalAssignmentEvent.id]));
    await request(app.getHttpServer())
      .put(`/api/operator/notifications/${originalAssignmentEvent.id}/read`)
      .set(bearers[0])
      .send({})
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/operator/notifications/${reassignmentEvent.id}/read`)
      .set(bearers[0])
      .send({})
      .expect(200);
    const [previousAfterRead, newBeforeRead] = await Promise.all([
      request(app.getHttpServer())
        .get('/api/operator/notifications?limit=100')
        .set(bearers[0])
        .expect(200),
      request(app.getHttpServer())
        .get('/api/operator/notifications?limit=100')
        .set(bearers[1])
        .expect(200),
    ]);
    expect(
      previousAfterRead.body.items.some((item: { eventIds: string[] }) =>
        item.eventIds.includes(reassignmentEvent.id),
      ),
    ).toBe(false);
    expect(
      previousAfterRead.body.items.some((item: { eventIds: string[] }) =>
        item.eventIds.includes(originalAssignmentEvent.id),
      ),
    ).toBe(false);
    expect(previousAfterRead.body.unreadCount).toBeLessThan(previousInbox.body.unreadCount);
    expect(
      newBeforeRead.body.items.find((item: { eventIds: string[] }) =>
        item.eventIds.includes(reassignmentEvent.id),
      ).unread,
    ).toBe(true);
    await request(app.getHttpServer())
      .put(`/api/operator/notifications/${reassignmentEvent.id}/read`)
      .set(bearers[1])
      .send({})
      .expect(200);
    await expect(
      prisma.notificationReceipt.count({ where: { eventId: reassignmentEvent.id } }),
    ).resolves.toBe(2);
    await expect(
      prisma.notificationReceipt.count({ where: { eventId: originalAssignmentEvent.id } }),
    ).resolves.toBe(1);
    const [previousRuntimeAfterReassignment, newRuntimeAfterReassignment] = await Promise.all([
      request(app.getHttpServer()).get('/api/operator/runtime').set(bearers[0]).expect(200),
      request(app.getHttpServer()).get('/api/operator/runtime').set(bearers[1]).expect(200),
    ]);
    expect(
      previousRuntimeAfterReassignment.body.orders.some(
        (order: { id: string }) => order.id === commercialOrder.body.orderNumber,
      ),
    ).toBe(false);
    expect(
      newRuntimeAfterReassignment.body.orders
        .find((order: { id: string }) => order.id === commercialOrder.body.orderNumber)
        ?.rolls.map((roll: { id: string }) => roll.id),
    ).toEqual(
      expect.arrayContaining(
        productionOrder.body.dispatchItems.map((item: { rollCode: string }) => item.rollCode),
      ),
    );

    const wholeOrderPenalty = await request(app.getHttpServer())
      .post('/api/production/penalties')
      .set(asProduction)
      .send({
        operatorId: operators[1].id,
        productionOrderId: productionOrder.body.id,
        amount: 1500,
        reason: 'E2E нарушение по заказу',
      })
      .expect(201);
    const rollPenalty = await request(app.getHttpServer())
      .post('/api/production/penalties')
      .set(asProduction)
      .send({
        operatorId: operators[1].id,
        productionOrderId: productionOrder.body.id,
        rollCode: productionOrder.body.dispatchItems[1].rollCode,
        amount: 900,
        reason: 'E2E нарушение по рулону',
      })
      .expect(201);

    const [operator1Penalties, operator2Penalties] = await Promise.all([
      request(app.getHttpServer()).get('/api/operator/penalties').set(bearers[0]).expect(200),
      request(app.getHttpServer()).get('/api/operator/penalties').set(bearers[1]).expect(200),
    ]);
    const createdPenaltyIds = [wholeOrderPenalty.body.id, rollPenalty.body.id];
    expect(
      operator1Penalties.body.some((row: { id: string }) => createdPenaltyIds.includes(row.id)),
    ).toBe(false);
    expect(operator2Penalties.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: wholeOrderPenalty.body.id,
          employeeId: operators[1].id,
          sourceProductionOrderId: productionOrder.body.id,
          sourceOrderNumber: commercialOrder.body.orderNumber,
          sourceRollCode: null,
        }),
        expect.objectContaining({
          id: rollPenalty.body.id,
          employeeId: operators[1].id,
          sourceProductionOrderId: productionOrder.body.id,
          sourceOrderNumber: commercialOrder.body.orderNumber,
          sourceRollCode: productionOrder.body.dispatchItems[1].rollCode,
        }),
      ]),
    );

    // --- Поломка станка: broken → maintenance → active (дизайн 2026-07-14) ------
    // Берем пост, не занятый операторами смены (POST-3+), чтобы не пересекаться.
    const parkPost = activePosts[activePosts.length - 1];
    const breakdown = await request(app.getHttpServer())
      .post(`/api/production/posts/${parkPost.id}/breakdown`)
      .set(asProduction)
      .send({ reason: 'E2E клин шнека' })
      .expect(201);
    expect(breakdown.body.type).toBe('machine_breakdown');
    expect(breakdown.body.postId).toBe(parkPost.id);

    const postsBroken = await request(app.getHttpServer())
      .get('/api/production/posts')
      .set(asProduction)
      .expect(200);
    expect(postsBroken.body.find((item: { id: string }) => item.id === parkPost.id).status).toBe(
      'broken',
    );

    // Повторная заявка на уже сломанный станок конфликтует.
    await request(app.getHttpServer())
      .post(`/api/production/posts/${parkPost.id}/breakdown`)
      .set(asProduction)
      .send({ reason: 'повтор' })
      .expect(409);

    // Назначить оператора на сломанный станок нельзя.
    await request(app.getHttpServer())
      .put(`/api/production/shifts/${shift.body.id}/operators/${operators[0].id}/machine`)
      .set(asProduction)
      .send({ postId: parkPost.id })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/api/production/posts/${parkPost.id}/repair-start`)
      .set(asProduction)
      .expect(201);
    const repaired = await request(app.getHttpServer())
      .post(`/api/production/posts/${parkPost.id}/repair`)
      .set(asProduction)
      .send({ note: 'E2E заменен шнек' })
      .expect(201);
    expect(repaired.body.status).toBe('active');

    const breakdownResolved = await request(app.getHttpServer())
      .get('/api/production/problems?type=machine_breakdown&status=resolved')
      .set(asProduction)
      .expect(200);
    expect(breakdownResolved.body.some((row: { id: string }) => row.id === breakdown.body.id)).toBe(
      true,
    );

    // --- Брак от завпроизводства при визуальном контроле (дизайн 2026-07-14) ----
    const defectRoll = productionOrder.body.dispatchItems[0].rollCode as string;
    const indicatorsBeforeDefect = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: commercialOrder.body.id },
      select: {
        productionIndicator: true,
        warehouseCoverStatus: true,
        paymentStatus: true,
        shipmentStatus: true,
      },
    });
    const defectDispatch = await prisma.rollDispatchItem.findUniqueOrThrow({
      where: { rollCode: defectRoll },
      select: {
        assignedOperatorId: true,
        postId: true,
        operatorLine: { select: { id: true } },
      },
    });
    expect(defectDispatch).toEqual(
      expect.objectContaining({
        assignedOperatorId: expect.any(String),
        postId: expect.any(String),
        operatorLine: expect.objectContaining({ id: expect.any(String) }),
      }),
    );
    const defectDevice = await prisma.deviceRuntime.findFirstOrThrow({
      where: { postId: defectDispatch.postId!, kind: 'scale', isEnabled: true },
      orderBy: { id: 'asc' },
    });
    const evidenceSession = await prisma.operatorPostSession.create({
      data: {
        operatorId: defectDispatch.assignedOperatorId!,
        postId: defectDispatch.postId!,
        status: 'closed',
        endedAt: new Date(),
      },
    });
    const evidenceCaptureId = `production-defect-capture-${uniq}`;
    const evidenceOperation = await prisma.operatorRollOperation.create({
      data: {
        operationKey: randomUUID(),
        operatorRollLineId: defectDispatch.operatorLine!.id,
        action: 'roll_weight',
        actorId: defectDispatch.assignedOperatorId!,
        postSessionId: evidenceSession.id,
        postId: defectDispatch.postId!,
        deviceId: defectDevice.id,
        requestFingerprint: 'a'.repeat(64),
        expectedStep: 'roll_weight',
        resultStep: 'qr_print',
        status: 'succeeded',
        httpStatus: 200,
        resultRef: evidenceCaptureId,
        attempt: 1,
        completedAt: new Date(),
      },
    });
    await prisma.weightCapture.create({
      data: {
        id: evidenceCaptureId,
        operatorRollLineId: defectDispatch.operatorLine!.id,
        operationId: evidenceOperation.id,
        kind: 'roll',
        deviceId: defectDevice.id,
        deviceStatus: 'ready',
        stable: true,
        grossKg: 43.2,
        spoolKg: 2,
        netKg: 41.2,
        toleranceOk: true,
        actorRole: Role.operator,
        actorId: defectDispatch.assignedOperatorId!,
        postId: defectDispatch.postId!,
        postSessionId: evidenceSession.id,
      },
    });
    await prisma.operatorRollLine.update({
      where: { id: defectDispatch.operatorLine!.id },
      data: {
        step: 'qr_print',
        spoolKg: 2,
        grossKg: 43.2,
        netKg: 41.2,
        toleranceOk: true,
      },
    });
    const dispatchBeforeDefect = await prisma.rollDispatchItem.findUniqueOrThrow({
      where: { rollCode: defectRoll },
      select: { status: true, operatorLine: { select: { step: true, warehouseState: true } } },
    });
    const [problemsBeforeDenied, defectsBeforeDenied, eventsBeforeDenied] = await Promise.all([
      prisma.productionProblem.count({ where: { rollId: defectRoll, type: 'defect' } }),
      prisma.defectRecord.count({
        where: { line: { rollDispatchItem: { rollCode: defectRoll } } },
      }),
      prisma.domainEvent.count({ where: { type: 'problem:production_defect_reported' } }),
    ]);

    for (const genericReporter of [asCommercial, asOperator, asWarehouse, asFinance]) {
      await request(app.getHttpServer())
        .post(`/api/production/rolls/${defectRoll}/defect`)
        .set(genericReporter)
        .send({ reason: 'generic reporter must not mutate production' })
        .expect(403);
    }

    await expect(
      Promise.all([
        prisma.productionProblem.count({ where: { rollId: defectRoll, type: 'defect' } }),
        prisma.defectRecord.count({
          where: { line: { rollDispatchItem: { rollCode: defectRoll } } },
        }),
        prisma.domainEvent.count({ where: { type: 'problem:production_defect_reported' } }),
      ]),
    ).resolves.toEqual([problemsBeforeDenied, defectsBeforeDenied, eventsBeforeDenied]);

    const defect = await request(app.getHttpServer())
      .post(`/api/production/rolls/${defectRoll}/defect`)
      .set(asProduction)
      .send({ reason: 'E2E полосы на пленке' })
      .expect(201);
    expect(defect.body.type).toBe('defect');
    expect(defect.body.rollId).toBe(defectRoll);

    const defectEvents = await prisma.domainEvent.findMany({
      where: {
        type: 'problem:production_defect_reported',
        objectId: commercialOrder.body.id,
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(defectEvents).toHaveLength(1);
    expect(defectEvents[0]).toEqual(
      expect.objectContaining({
        actorRole: 'production_lead',
        reason: 'E2E полосы на пленке',
        oldValue: {
          dispatchStatus: dispatchBeforeDefect.status,
          operatorStep: dispatchBeforeDefect.operatorLine?.step,
          warehouseState: dispatchBeforeDefect.operatorLine?.warehouseState,
        },
        newValue: {
          dispatchStatus: 'deferred',
          operatorStep: 'deferred',
          warehouseState: 'not_ready',
          blocking: true,
        },
      }),
    );

    await expect(
      prisma.commercialOrder.findUniqueOrThrow({
        where: { id: commercialOrder.body.id },
        select: {
          productionIndicator: true,
          warehouseCoverStatus: true,
          paymentStatus: true,
          shipmentStatus: true,
        },
      }),
    ).resolves.toEqual(indicatorsBeforeDefect);

    // Повторная пометка того же рулона браком конфликтует.
    await request(app.getHttpServer())
      .post(`/api/production/rolls/${defectRoll}/defect`)
      .set(asProduction)
      .send({ reason: 'повтор' })
      .expect(409);

    const openDefects = await request(app.getHttpServer())
      .get('/api/production/problems?type=defect&status=open')
      .set(asProduction)
      .expect(200);
    expect(openDefects.body.some((row: { rollId: string }) => row.rollId === defectRoll)).toBe(
      true,
    );
  });

  it('commits simultaneous same-order replacements with distinct local sequences', async () => {
    const suffix = randomUUID();
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Replacement concurrency ${suffix}` },
    });
    const commercialOrder = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-REPLACEMENT-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
      },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: { commercialOrderId: commercialOrder.id, approvalState: 'approved' },
    });
    const [sourceA, sourceB] = await Promise.all(
      ['A', 'B'].map((source, index) =>
        prisma.rollDispatchItem.create({
          data: {
            rollCode: `REPLACEMENT-${suffix}-${source}`,
            productionOrderId: productionOrder.id,
            queueRank: index + 1,
            plannedWeightKg: 40,
          },
        }),
      ),
    );
    await prisma.operatorRollLine.createMany({
      data: [
        { rollDispatchItemId: sourceA.id, sequence: 1, planKg: 40 },
        { rollDispatchItemId: sourceB.id, sequence: 2, planKg: 40 },
      ],
    });

    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "production_orders" WHERE "id" = ${productionOrder.id} FOR UPDATE`;
      lockAcquired();
      await release;
    });
    await acquired;

    const replacements = [sourceA, sourceB].map((source) =>
      production.createReplacementRoll(
        { userId: null, role: 'production_lead' },
        source.rollCode,
        'Real PostgreSQL replacement concurrency regression',
      ),
    );
    try {
      await waitForBlockedRowLock('production_orders', 2);
    } finally {
      releaseLock();
    }
    await blocker;
    const created = await Promise.all(replacements);

    const committed = await prisma.rollDispatchItem.findMany({
      where: { id: { in: created.map((row) => row.id) } },
      select: {
        rollCode: true,
        operatorLine: { select: { sequence: true } },
      },
      orderBy: { rollCode: 'asc' },
    });
    expect(committed).toHaveLength(2);
    expect(committed.map((row) => row.operatorLine?.sequence).sort()).toEqual([3, 4]);
    await expect(
      prisma.operatorRollLine.findMany({
        where: { rollDispatchItem: { productionOrderId: productionOrder.id } },
        select: { sequence: true },
        orderBy: { sequence: 'asc' },
      }),
    ).resolves.toEqual([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }]);
  });
});
