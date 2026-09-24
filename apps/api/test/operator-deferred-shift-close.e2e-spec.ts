import { randomBytes, randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { hashPassword } from '../src/common/auth/password';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OperatorPayrollService } from '../src/modules/operator/operator-payroll.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';
import { cleanupOwnedOperatorFixtureGraph } from './operator-e2e-cleanup';
import { prepareReadyDefectBagFixture } from './operator-shift-e2e-fixture';
import { enableSimulatedDevices } from './simulated-device-fixture';

type DeferredFixture = {
  assignmentId: string;
  bagId: string;
  bearer: { Authorization: string };
  commercialOrderId: string;
  dispatchId: string;
  lineId: string;
  operatorId: string;
  postCode: string;
  postId: string;
  rollCode: string;
  sessionId: string;
  shiftId: string;
  usageId: string;
};

describe('operator deferred roll shift close (e2e, real PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let payroll: OperatorPayrollService;
  let payrollSpy: jest.SpyInstance;
  let prisma: PrismaService;
  const ownedActorIds = new Set<string>();
  const ownedBigBagIds = new Set<string>();
  const ownedCommercialOrderIds = new Set<string>();
  const ownedCounterpartyIds = new Set<string>();
  const ownedDeviceIds = new Set<string>();
  const ownedDispatchItemIds = new Set<string>();
  const ownedPostIds = new Set<string>();
  const ownedProductionOrderIds = new Set<string>();
  const ownedShiftIds = new Set<string>();

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    prisma = moduleRef.get(PrismaService);
    payroll = moduleRef.get(OperatorPayrollService);
    payrollSpy = jest.spyOn(payroll, 'getClosingPayroll');
    await initializeE2eApp(app);
  });

  beforeEach(() => {
    payrollSpy.mockClear();
  });

  async function waitForBlockedPostLocks(expectedWaiters: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [state] = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT COUNT(*)::int AS waiting
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FROM "posts"%FOR UPDATE%'
      `;
      if ((state?.waiting ?? 0) >= expectedWaiters) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${expectedWaiters} blocked post operation(s)`);
  }

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'operator deferred shift close fixture graph',
          run: async () => {
            if (!prisma) return;
            await cleanupOwnedOperatorFixtureGraph(prisma, {
              actorIds: [...ownedActorIds],
              bigBagIds: [...ownedBigBagIds],
              commercialOrderIds: [...ownedCommercialOrderIds],
              counterpartyIds: [...ownedCounterpartyIds],
              deviceIds: [...ownedDeviceIds],
              dispatchItemIds: [...ownedDispatchItemIds],
              postIds: [...ownedPostIds],
              productionOrderIds: [...ownedProductionOrderIds],
              shiftIds: [...ownedShiftIds],
            });
          },
        },
        { label: 'operator deferred shift close application', run: async () => app?.close() },
      ],
    );
  });

  async function createFixture(label: string, deferredFromStep: string): Promise<DeferredFixture> {
    const suffix = randomUUID();
    const operatorId = `${label}-operator-${suffix}`;
    const postId = `${label}-post-${suffix}`;
    const postCode = `${label.toUpperCase()}-POST-${suffix}`;
    const shiftId = `${label}-shift-${suffix}`;
    const assignmentId = `${label}-assignment-${suffix}`;
    const sessionId = `${label}-session-${suffix}`;
    const bagId = `${label}-bag-${suffix}`;
    const counterpartyId = `${label}-counterparty-${suffix}`;
    const commercialOrderId = `${label}-commercial-${suffix}`;
    const productionOrderId = `${label}-production-${suffix}`;
    const dispatchId = `${label}-dispatch-${suffix}`;
    const rollCode = `${label.toUpperCase()}-ROLL-${suffix}`;
    const lineId = `${label}-line-${suffix}`;
    const usageId = `${label}-usage-${suffix}`;
    const login = `${label}-${suffix}@test.local`;
    const password = randomBytes(18).toString('base64url');

    ownedActorIds.add(operatorId);
    ownedBigBagIds.add(bagId);
    ownedCommercialOrderIds.add(commercialOrderId);
    ownedCounterpartyIds.add(counterpartyId);
    ownedDispatchItemIds.add(dispatchId);
    ownedPostIds.add(postId);
    ownedProductionOrderIds.add(productionOrderId);
    ownedShiftIds.add(shiftId);

    await prisma.user.create({
      data: {
        id: operatorId,
        externalId: operatorId,
        login,
        passwordHash: hashPassword(password),
        displayName: `${label} deferred operator`,
        role: Role.operator,
      },
    });
    await prisma.post.create({
      data: { id: postId, code: postCode, name: `${label} deferred post` },
    });
    await prisma.shift.create({
      data: { id: shiftId, label: `${label} deferred shift`, status: 'open' },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: { id: assignmentId, shiftId, operatorId, postId, status: 'locked' },
    });
    await prisma.operatorPostSession.create({
      data: { id: sessionId, operatorId, postId, shiftId, status: 'active' },
    });
    await prisma.bigBagUnit.create({
      data: {
        id: bagId,
        code: `${label.toUpperCase()}-BAG-${suffix}`,
        material: 'ПВД',
        initialKg: 500,
        currentKg: 500,
        status: 'in_use',
        registrationStatus: 'registered',
        location: 'production',
        createdByRole: Role.warehouse,
      },
    });
    await prisma.shiftBagUsage.create({
      data: {
        id: usageId,
        sessionId,
        bigBagId: bagId,
        startKg: 500,
        sequence: 1,
        episodes: { create: { sequence: 1, startKg: 500 } },
      },
    });
    await prisma.counterparty.create({
      data: { id: counterpartyId, displayName: `${label} deferred customer` },
    });
    await prisma.commercialOrder.create({
      data: {
        id: commercialOrderId,
        orderNumber: `${label.toUpperCase()}-ORDER-${suffix}`,
        creatorRole: Role.commercial,
        counterpartyId,
      },
    });
    await prisma.productionOrder.create({
      data: { id: productionOrderId, commercialOrderId, approvalState: 'approved' },
    });
    await prisma.rollDispatchItem.create({
      data: {
        id: dispatchId,
        rollCode,
        productionOrderId,
        assignedOperatorId: operatorId,
        plannedShiftId: shiftId,
        postId,
        workplaceId: postId,
        machineId: postCode,
        queueRank: 10,
        status: 'deferred',
      },
    });
    await prisma.operatorRollLine.create({
      data: {
        id: lineId,
        rollDispatchItemId: dispatchId,
        sequence: 1,
        step: 'deferred',
        deferredFromStep,
      },
    });
    await prepareReadyDefectBagFixture(prisma, operatorId);

    const loginResponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login, password })
      .expect(201);

    return {
      assignmentId,
      bagId,
      bearer: { Authorization: `Bearer ${loginResponse.body.token as string}` },
      commercialOrderId,
      dispatchId,
      lineId,
      operatorId,
      postCode,
      postId,
      rollCode,
      sessionId,
      shiftId,
      usageId,
    };
  }

  it('hands a deferred roll to the next operator at the same post without losing resume state', async () => {
    const fixture = await createFixture('valid', 'qr_check');
    const operationKey = randomUUID();
    const closeRequest = { operationKey, bags: [{ bigBagId: fixture.bagId, endKg: 500 }] };

    const first = await request(app.getHttpServer())
      .post('/api/operator/shift/close')
      .set(fixture.bearer)
      .send(closeRequest)
      .expect(200);

    expect(first.body).toMatchObject({
      releasedRollIds: [],
      balance: { status: 'ok', actualUsageKg: 0, expectedUsageKg: 0 },
      closingPayroll: { sessionId: fixture.sessionId, shiftId: fixture.shiftId },
    });
    expect(payrollSpy).toHaveBeenCalledTimes(1);

    const durableAfterFirst = await Promise.all([
      prisma.operatorShiftCloseCommand.count({ where: { operationKey } }),
      prisma.domainEvent.count({ where: { actorId: fixture.operatorId } }),
      prisma.shiftBagUsageEpisode.count({ where: { usageId: fixture.usageId } }),
    ]);
    const replay = await request(app.getHttpServer())
      .post('/api/operator/shift/close')
      .set(fixture.bearer)
      .send(closeRequest)
      .expect(200);

    expect(replay.body).toEqual(first.body);
    expect(payrollSpy).toHaveBeenCalledTimes(1);
    await expect(
      Promise.all([
        prisma.operatorShiftCloseCommand.count({ where: { operationKey } }),
        prisma.domainEvent.count({ where: { actorId: fixture.operatorId } }),
        prisma.shiftBagUsageEpisode.count({ where: { usageId: fixture.usageId } }),
      ]),
    ).resolves.toEqual(durableAfterFirst);
    expect(durableAfterFirst[0]).toBe(1);
    expect(durableAfterFirst[2]).toBe(1);

    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { id: fixture.assignmentId },
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    await expect(
      prisma.operatorPostSession.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
    ).resolves.toMatchObject({ status: 'closed', endedAt: expect.any(Date) });
    await expect(
      prisma.shift.findUniqueOrThrow({ where: { id: fixture.shiftId } }),
    ).resolves.toMatchObject({ status: 'closed', endedAt: expect.any(Date) });
    await expect(
      prisma.shiftBagUsageEpisode.findFirstOrThrow({ where: { usageId: fixture.usageId } }),
    ).resolves.toMatchObject({ sequence: 1, endKg: 500, closeKind: 'shift_closed' });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: fixture.dispatchId } }),
    ).resolves.toMatchObject({
      assignedOperatorId: null,
      plannedShiftId: null,
      postId: fixture.postId,
      workplaceId: fixture.postId,
      machineId: fixture.postCode,
      status: 'deferred',
    });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({ where: { id: fixture.lineId } }),
    ).resolves.toMatchObject({ step: 'deferred', deferredFromStep: 'qr_check' });

    const nextOperatorId = `valid-next-operator-${randomUUID()}`;
    const nextLogin = `${nextOperatorId}@test.local`;
    const nextPassword = randomBytes(18).toString('base64url');
    ownedActorIds.add(nextOperatorId);
    await prisma.user.create({
      data: {
        id: nextOperatorId,
        externalId: nextOperatorId,
        login: nextLogin,
        passwordHash: hashPassword(nextPassword),
        displayName: 'Incoming deferred operator',
        role: Role.operator,
      },
    });
    const nextLoginResponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: nextLogin, password: nextPassword })
      .expect(201);
    const nextBearer = {
      Authorization: `Bearer ${nextLoginResponse.body.token as string}`,
    };
    const nextShiftId = `valid-next-shift-${randomUUID()}`;
    ownedShiftIds.add(nextShiftId);
    await prisma.shift.create({
      data: { id: nextShiftId, label: 'Incoming post handover shift', status: 'planned' },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: nextShiftId,
        operatorId: nextOperatorId,
        postId: fixture.postId,
        status: 'planned',
      },
    });
    const nextDevices = (['scale', 'printer', 'scanner'] as const).map((kind) => ({
      id: `valid-next-${kind}-${randomUUID()}`,
      code: `VALID-NEXT-${kind.toUpperCase()}-${randomUUID()}`,
      kind,
      label: `Valid next ${kind}`,
      postId: fixture.postId,
      status: 'ready',
      isEnabled: true,
    }));
    nextDevices.forEach(({ id }) => ownedDeviceIds.add(id));
    await prisma.deviceRuntime.createMany({ data: nextDevices });
    await enableSimulatedDevices(
      prisma,
      nextDevices.map(({ id }) => id),
    );

    const opened = await request(app.getHttpServer())
      .post('/api/operator/shift/open')
      .set(nextBearer)
      .send({ postCode: fixture.postCode, bigBagId: fixture.bagId, startKg: 500 })
      .expect(201);
    expect(opened.body.session).toMatchObject({
      shiftId: nextShiftId,
      postId: fixture.postId,
      status: 'active',
    });

    const currentSession = await request(app.getHttpServer())
      .get('/api/operator/post-sessions/current')
      .set(nextBearer)
      .expect(200);
    expect(currentSession.body).toMatchObject({
      shiftId: nextShiftId,
      postId: fixture.postId,
      status: 'active',
    });

    const reloaded = await request(app.getHttpServer())
      .get('/api/operator/runtime')
      .set(nextBearer)
      .expect(200);
    expect(reloaded.body.shift).toMatchObject({ id: nextShiftId, status: 'active' });
    expect(
      reloaded.body.orders.flatMap(
        (order: { rolls: Array<Record<string, unknown>> }) => order.rolls,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.rollCode,
          status: 'deferred',
        }),
      ]),
    );
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: fixture.dispatchId } }),
    ).resolves.toMatchObject({
      assignedOperatorId: nextOperatorId,
      plannedShiftId: nextShiftId,
      postId: fixture.postId,
      status: 'deferred',
    });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({ where: { id: fixture.lineId } }),
    ).resolves.toMatchObject({ step: 'deferred', deferredFromStep: 'qr_check' });
  });

  it('keeps the order anchor when a mismatch shift contains only a deferred roll', async () => {
    const fixture = await createFixture('mismatch-anchor', 'qr_check');

    const closed = await request(app.getHttpServer())
      .post('/api/operator/shift/close')
      .set(fixture.bearer)
      .send({ operationKey: randomUUID(), bags: [{ bigBagId: fixture.bagId, endKg: 490 }] })
      .expect(200);

    expect(closed.body.balance).toMatchObject({
      status: 'mismatch',
      actualUsageKg: 10,
      expectedUsageKg: 0,
    });
    expect(closed.body.problemId).toEqual(expect.any(String));
    await expect(
      prisma.productionProblem.findUniqueOrThrow({ where: { id: closed.body.problemId } }),
    ).resolves.toMatchObject({
      type: 'shift_balance_mismatch',
      orderId: fixture.commercialOrderId,
    });
  });

  it('chooses the first successor without deadlocking a simultaneous manual assignment', async () => {
    const fixture = await createFixture('concurrent-successors', 'qr_check');
    const devices = (['scale', 'printer', 'scanner'] as const).map((kind) => ({
      id: `concurrent-successors-${kind}-${randomUUID()}`,
      code: `CONCURRENT-SUCCESSORS-${kind.toUpperCase()}-${randomUUID()}`,
      kind,
      label: `Concurrent successors ${kind}`,
      postId: fixture.postId,
      status: 'ready',
      isEnabled: true,
    }));
    devices.forEach(({ id }) => ownedDeviceIds.add(id));
    await prisma.deviceRuntime.createMany({ data: devices });
    await enableSimulatedDevices(
      prisma,
      devices.map(({ id }) => id),
    );

    const createSuccessor = async (sequence: number) => {
      const suffix = randomUUID();
      const operatorId = `concurrent-successor-${sequence}-${suffix}`;
      const shiftId = `concurrent-successor-shift-${sequence}-${suffix}`;
      const login = `${operatorId}@test.local`;
      const password = randomBytes(18).toString('base64url');
      ownedActorIds.add(operatorId);
      ownedShiftIds.add(shiftId);
      await prisma.user.create({
        data: {
          id: operatorId,
          externalId: operatorId,
          login,
          passwordHash: hashPassword(password),
          displayName: `Concurrent successor ${sequence}`,
          role: Role.operator,
        },
      });
      await prisma.shift.create({
        data: { id: shiftId, label: `Concurrent successor shift ${sequence}`, status: 'planned' },
      });
      await prisma.operatorShiftMachineAssignment.create({
        data: {
          shiftId,
          operatorId,
          postId: fixture.postId,
          status: 'planned',
        },
      });
      const loginResponse = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login, password })
        .expect(201);
      return {
        operatorId,
        shiftId,
        bearer: { Authorization: `Bearer ${loginResponse.body.token as string}` },
      };
    };
    const successors = await Promise.all([createSuccessor(1), createSuccessor(2)]);

    const openings = await Promise.all(
      successors.map(({ bearer }) =>
        request(app.getHttpServer())
          .post('/api/operator/post-sessions')
          .set(bearer)
          .send({ postCode: fixture.postCode }),
      ),
    );
    expect(openings.map(({ status }) => status)).toEqual([201, 201]);

    const orderedSessions = await prisma.operatorPostSession.findMany({
      where: {
        operatorId: { in: successors.map(({ operatorId }) => operatorId) },
        status: 'active',
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
    expect(orderedSessions).toHaveLength(2);
    const winnerSession = orderedSessions[0]!;
    const winner = successors.find(({ operatorId }) => operatorId === winnerSession.operatorId)!;
    const loser = successors.find(({ operatorId }) => operatorId !== winnerSession.operatorId)!;

    const leadId = `concurrent-successors-lead-${randomUUID()}`;
    const leadLogin = `${leadId}@test.local`;
    const leadPassword = randomBytes(18).toString('base64url');
    ownedActorIds.add(leadId);
    await prisma.user.create({
      data: {
        id: leadId,
        externalId: leadId,
        login: leadLogin,
        passwordHash: hashPassword(leadPassword),
        displayName: 'Concurrent successors production lead',
        role: Role.production_lead,
      },
    });
    const leadLoginResponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: leadLogin, password: leadPassword })
      .expect(201);
    const leadBearer = {
      Authorization: `Bearer ${leadLoginResponse.body.token as string}`,
    };

    let reportPostLocked!: () => void;
    let reportPostLockError!: (error: unknown) => void;
    let releasePost!: () => void;
    const postLocked = new Promise<void>((resolve, reject) => {
      reportPostLocked = resolve;
      reportPostLockError = reject;
    });
    const postReleased = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const postBlocker = prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "posts" WHERE "id" = ${fixture.postId} FOR UPDATE`;
          reportPostLocked();
          await postReleased;
        },
        { maxWait: 5_000, timeout: 15_000 },
      )
      .catch((error: unknown) => {
        reportPostLockError(error);
        throw error;
      });
    await postLocked;

    let closeRequest!: Promise<request.Response>;
    let manualAssignment!: Promise<request.Response>;
    try {
      closeRequest = Promise.resolve(
        request(app.getHttpServer())
          .post('/api/operator/shift/close')
          .set(fixture.bearer)
          .send({
            operationKey: randomUUID(),
            bags: [{ bigBagId: fixture.bagId, endKg: 500 }],
          })
          .expect(200),
      );
      await waitForBlockedPostLocks(1);
      manualAssignment = Promise.resolve(
        request(app.getHttpServer())
          .post(`/api/production/roll-dispatch/${fixture.rollCode}/assign`)
          .set(leadBearer)
          .send({ operatorId: winner.operatorId })
          .expect(201),
      );
      await waitForBlockedPostLocks(2);
    } finally {
      releasePost();
    }

    const settled = await Promise.allSettled([closeRequest, manualAssignment, postBlocker]);
    expect(settled.filter(({ status }) => status === 'rejected')).toEqual([]);

    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: fixture.dispatchId } }),
    ).resolves.toMatchObject({
      assignedOperatorId: winner.operatorId,
      plannedShiftId: winner.shiftId,
      postId: fixture.postId,
      status: 'deferred',
    });
    await expect(
      prisma.rollDispatchItem.count({
        where: { id: fixture.dispatchId, assignedOperatorId: loser.operatorId },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.domainEvent.findFirstOrThrow({
        where: {
          type: 'audit:roll_dispatch_bulk_assigned',
          actorId: fixture.operatorId,
          objectId: winner.shiftId,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ).resolves.toMatchObject({
      oldValue: { operatorId: null, shiftId: null, postId: fixture.postId },
      newValue: {
        operatorId: winner.operatorId,
        shiftId: winner.shiftId,
        postId: fixture.postId,
        machineId: fixture.postCode,
      },
      detail: expect.objectContaining({
        sourceSessionId: fixture.sessionId,
        sessionId: winnerSession.id,
        selectionRule: 'first_active_session_after_predecessor',
      }),
    });
  });

  it('automatically defers a started roll while closing the shift', async () => {
    const fixture = await createFixture('automatic', 'roll_weight');
    await prisma.rollDispatchItem.update({
      where: { id: fixture.dispatchId },
      data: { status: 'assigned' },
    });
    await prisma.operatorRollLine.update({
      where: { id: fixture.lineId },
      data: { step: 'roll_weight', deferredFromStep: null },
    });

    await request(app.getHttpServer())
      .post('/api/operator/shift/close')
      .set(fixture.bearer)
      .send({
        operationKey: randomUUID(),
        bags: [{ bigBagId: fixture.bagId, endKg: 500 }],
      })
      .expect(200);

    await expect(
      prisma.operatorPostSession.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
    ).resolves.toMatchObject({ status: 'closed', endedAt: expect.any(Date) });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: fixture.dispatchId } }),
    ).resolves.toMatchObject({
      assignedOperatorId: null,
      plannedShiftId: null,
      postId: fixture.postId,
      workplaceId: fixture.postId,
      machineId: fixture.postCode,
      status: 'deferred',
    });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({ where: { id: fixture.lineId } }),
    ).resolves.toMatchObject({ step: 'deferred', deferredFromStep: 'roll_weight' });
    await expect(
      prisma.domainEvent.findFirstOrThrow({
        where: {
          actorId: fixture.operatorId,
          objectId: fixture.rollCode,
          type: 'audit:roll_deferred',
        },
      }),
    ).resolves.toMatchObject({
      reason: 'Автоматически отложен при сдаче смены',
      oldValue: { step: 'roll_weight', status: 'assigned' },
      newValue: {
        step: 'deferred',
        deferredFromStep: 'roll_weight',
        status: 'deferred',
      },
      detail: expect.objectContaining({
        sessionId: fixture.sessionId,
        postId: fixture.postId,
        automaticShiftClose: true,
      }),
    });
  });

  it('fails closed for a compatibility-only deferred predecessor before mutations', async () => {
    const fixture = await createFixture('compatibility', 'roll_scale_activation');
    const operationKey = randomUUID();
    const durableBefore = await Promise.all([
      prisma.operatorShiftCloseCommand.count({ where: { operationKey } }),
      prisma.domainEvent.count({ where: { actorId: fixture.operatorId } }),
      prisma.shiftBagUsageEpisode.count({ where: { usageId: fixture.usageId } }),
    ]);

    const response = await request(app.getHttpServer())
      .post('/api/operator/shift/close')
      .set(fixture.bearer)
      .send({ operationKey, bags: [{ bigBagId: fixture.bagId, endKg: 499 }] })
      .expect(409);

    expect(response.body).toMatchObject({
      code: 'OPERATOR_SHIFT_STARTED_ROLLS_INCOMPLETE',
    });
    expect(response.body.rollCodes).toEqual([fixture.rollCode]);
    expect(payrollSpy).not.toHaveBeenCalled();
    await expect(
      Promise.all([
        prisma.operatorShiftCloseCommand.count({ where: { operationKey } }),
        prisma.domainEvent.count({ where: { actorId: fixture.operatorId } }),
        prisma.shiftBagUsageEpisode.count({ where: { usageId: fixture.usageId } }),
      ]),
    ).resolves.toEqual(durableBefore);
    expect(durableBefore).toEqual([0, expect.any(Number), 1]);
    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { id: fixture.assignmentId },
      }),
    ).resolves.toMatchObject({ status: 'locked' });
    await expect(
      prisma.operatorPostSession.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
    ).resolves.toMatchObject({ status: 'active', endedAt: null });
    await expect(
      prisma.shift.findUniqueOrThrow({ where: { id: fixture.shiftId } }),
    ).resolves.toMatchObject({ status: 'open', endedAt: null });
    await expect(
      prisma.bigBagUnit.findUniqueOrThrow({ where: { id: fixture.bagId } }),
    ).resolves.toMatchObject({ status: 'in_use', currentKg: 500 });
    await expect(
      prisma.shiftBagUsage.findUniqueOrThrow({ where: { id: fixture.usageId } }),
    ).resolves.toMatchObject({ startKg: 500, endKg: null, closedAt: null });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: fixture.dispatchId } }),
    ).resolves.toMatchObject({
      assignedOperatorId: fixture.operatorId,
      plannedShiftId: fixture.shiftId,
      postId: fixture.postId,
      status: 'deferred',
    });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({ where: { id: fixture.lineId } }),
    ).resolves.toMatchObject({
      step: 'deferred',
      deferredFromStep: 'roll_scale_activation',
    });
  });
});
