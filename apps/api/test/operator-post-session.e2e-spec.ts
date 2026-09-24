import { randomBytes, randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { hashPassword } from '../src/common/auth/password';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OperatorOperationService } from '../src/modules/operator/operator-operation.service';
import { OperatorRollOwnershipService } from '../src/modules/operator/operator-roll-ownership.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';
import { cleanupOwnedOperatorFixtureGraph } from './operator-e2e-cleanup';
import { prepareReadyDefectBagFixture } from './operator-shift-e2e-fixture';
import { enableSimulatedDevices } from './simulated-device-fixture';

describe('operator post session concurrency (e2e)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let operations: OperatorOperationService;
  let prisma: PrismaService;
  let ownership: OperatorRollOwnershipService;
  const suffix = randomUUID();
  const operatorId = `session-op-a-${suffix}`;
  const otherOperatorId = `session-op-b-${suffix}`;
  const postId = `session-post-a-${suffix}`;
  const otherPostId = `session-post-b-${suffix}`;
  const shiftId = `session-shift-${suffix}`;
  const login = `session-op-a-${suffix}@test.local`;
  const password = randomBytes(18).toString('base64url');
  const otherPassword = randomBytes(18).toString('base64url');
  const postCode = `SESSION-A-${suffix}`;
  const otherPostCode = `SESSION-B-${suffix}`;
  const closingPostId = `session-post-closing-${suffix}`;
  const closingPostCode = `SESSION-C-${suffix}`;
  const contentionBagId = `session-bag-a-${suffix}`;
  const contentionBagCode = `SESSION-BAG-A-${suffix}`;
  const otherBagId = `session-bag-b-${suffix}`;
  const otherBagCode = `SESSION-BAG-B-${suffix}`;
  const contentionCounterpartyId = `session-counterparty-${suffix}`;
  const contentionCommercialOrderId = `session-commercial-${suffix}`;
  const contentionProductionOrderId = `session-production-${suffix}`;
  const contentionDispatchId = `session-dispatch-${suffix}`;
  const contentionLineId = `session-line-${suffix}`;
  const contentionRollCode = `SESSION-ROLL-${suffix}`;
  const dispatchLeadId = `session-production-lead-${suffix}`;
  const dispatchLeadLogin = `session-production-lead-${suffix}@test.local`;
  const dispatchLeadPassword = randomBytes(18).toString('base64url');
  const plannedCounterpartyId = `session-planned-counterparty-${suffix}`;
  const plannedCommercialOrderId = `session-planned-commercial-${suffix}`;
  const plannedProductionOrderId = `session-planned-production-${suffix}`;
  const plannedDispatchId = `session-planned-dispatch-${suffix}`;
  const plannedLineId = `session-planned-line-${suffix}`;
  const plannedRollCode = `SESSION-PLANNED-ROLL-${suffix}`;
  const simulatedPostIds = [postId, otherPostId, closingPostId] as const;
  const simulatedDevices = simulatedPostIds.flatMap((boundPostId, postIndex) =>
    (['scale', 'printer', 'scanner'] as const).map((kind) => ({
      id: `session-device-${postIndex}-${kind}-${suffix}`,
      code: `SESSION-DEVICE-${postIndex}-${kind}-${suffix}`,
      kind,
      postId: boundPostId,
    })),
  );
  let restoreSimulatedDevices: (() => Promise<void>) | undefined;

  async function waitForBlockedRowLock(
    tableName: string,
    alternateTableName = tableName,
  ): Promise<void> {
    const deadline = Date.now() + 3_000;
    const queryPattern = `%FROM "${tableName}"%FOR UPDATE%`;
    const alternateQueryPattern = `%FROM "${alternateTableName}"%FOR UPDATE%`;
    while (Date.now() < deadline) {
      const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND (query LIKE ${queryPattern} OR query LIKE ${alternateQueryPattern})
        ) AS waiting
      `;
      if (state?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${tableName} row lock`);
  }

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    operations = moduleRef.get(OperatorOperationService);
    prisma = moduleRef.get(PrismaService);
    ownership = moduleRef.get(OperatorRollOwnershipService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    await prisma.user.createMany({
      data: [
        {
          id: operatorId,
          externalId: operatorId,
          login,
          passwordHash: hashPassword(password),
          displayName: 'Session concurrency operator',
          role: Role.operator,
        },
        {
          id: otherOperatorId,
          externalId: otherOperatorId,
          login: `session-op-b-${suffix}@test.local`,
          passwordHash: hashPassword(otherPassword),
          displayName: 'Session constraint operator',
          role: Role.operator,
        },
        {
          id: dispatchLeadId,
          externalId: dispatchLeadId,
          login: dispatchLeadLogin,
          passwordHash: hashPassword(dispatchLeadPassword),
          displayName: 'Session dispatch production lead',
          role: Role.production_lead,
        },
      ],
    });
    await prisma.post.createMany({
      data: [
        { id: postId, code: postCode, name: 'Session concurrency post' },
        { id: otherPostId, code: otherPostCode, name: 'Session constraint post' },
        { id: closingPostId, code: closingPostCode, name: 'Session closing post' },
      ],
    });
    await prisma.deviceRuntime.createMany({ data: simulatedDevices });
    restoreSimulatedDevices = await enableSimulatedDevices(
      prisma,
      simulatedDevices.map((device) => device.id),
    );
    await prisma.shift.create({
      data: {
        id: shiftId,
        label: 'Session concurrency shift',
        plannedStartAt: new Date(Date.now() - 60_000),
        plannedEndAt: new Date(Date.now() + 60 * 60_000),
        status: 'planned',
      },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: { shiftId, operatorId, postId, status: 'planned' },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: { shiftId, operatorId: otherOperatorId, postId: closingPostId, status: 'planned' },
    });
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'operator post session simulated devices',
          run: async () => restoreSimulatedDevices?.(),
        },
        {
          label: 'operator post session fixture graph',
          run: async () => {
            if (!prisma) return;
            await cleanupOwnedOperatorFixtureGraph(prisma, {
              actorIds: [operatorId, otherOperatorId, dispatchLeadId],
              bigBagIds: [contentionBagId, otherBagId],
              commercialOrderIds: [contentionCommercialOrderId, plannedCommercialOrderId],
              counterpartyIds: [contentionCounterpartyId, plannedCounterpartyId],
              deviceIds: simulatedDevices.map(({ id }) => id),
              dispatchItemIds: [contentionDispatchId, plannedDispatchId],
              postIds: [postId, otherPostId, closingPostId],
              productionOrderIds: [contentionProductionOrderId, plannedProductionOrderId],
              shiftIds: [shiftId],
            });
          },
        },
        { label: 'operator post session application', run: async () => app?.close() },
      ],
    );
  });

  it('keeps login identity-only and opens explicitly once under concurrency and retry', async () => {
    const http = () => request(app.getHttpServer());
    async function expectPlannedTopology() {
      await expect(prisma.shift.findUnique({ where: { id: shiftId } })).resolves.toMatchObject({
        status: 'planned',
        startedAt: null,
      });
      await expect(
        prisma.operatorShiftMachineAssignment.findUnique({
          where: { shiftId_operatorId: { shiftId, operatorId } },
        }),
      ).resolves.toMatchObject({ status: 'planned', lockedAt: null });
      await expect(
        prisma.operatorPostSession.count({ where: { operatorId, endedAt: null } }),
      ).resolves.toBe(0);
      await expect(
        prisma.domainEvent.count({
          where: { actorId: operatorId, type: 'audit:operator_post_session_opened' },
        }),
      ).resolves.toBe(0);
    }

    await expectPlannedTopology();
    const loginResponse = await http()
      .post('/api/auth/login')
      .send({ login, password })
      .expect(201);
    const bearer = { Authorization: `Bearer ${loginResponse.body.token as string}` };
    await expectPlannedTopology();

    const [firstOpen, secondOpen] = await Promise.all([
      http().post('/api/operator/post-sessions').set(bearer).send({ postCode }),
      http().post('/api/operator/post-sessions').set(bearer).send({ postCode }),
    ]);

    expect([firstOpen.status, secondOpen.status]).toEqual([201, 201]);
    expect(firstOpen.body.id).toBe(secondOpen.body.id);
    await expect(prisma.shift.findUnique({ where: { id: shiftId } })).resolves.toMatchObject({
      status: 'open',
      startedAt: expect.any(Date),
    });
    await expect(
      prisma.operatorShiftMachineAssignment.findUnique({
        where: { shiftId_operatorId: { shiftId, operatorId } },
      }),
    ).resolves.toMatchObject({ status: 'locked', lockedAt: expect.any(Date) });
    await expect(
      prisma.operatorPostSession.count({ where: { operatorId, status: 'active' } }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { actorId: operatorId, type: 'audit:operator_post_session_opened' },
      }),
    ).resolves.toBe(1);
    const retryOpen = await http()
      .post('/api/operator/post-sessions')
      .set(bearer)
      .send({ postCode })
      .expect(201);
    expect(retryOpen.body.id).toBe(firstOpen.body.id);
    await expect(
      prisma.operatorPostSession.count({ where: { operatorId, status: 'active' } }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { actorId: operatorId, type: 'audit:operator_post_session_opened' },
      }),
    ).resolves.toBe(1);
    const topologyConflict = await http()
      .post('/api/operator/post-sessions')
      .set(bearer)
      .send({ postCode: otherPostCode });
    expect(topologyConflict.status).toBe(409);
    expect(topologyConflict.body).toMatchObject({
      code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
    });

    const [firstClose, secondClose] = await Promise.all([
      http().post('/api/operator/post-sessions/close').set(bearer).send({}),
      http().post('/api/operator/post-sessions/close').set(bearer).send({}),
    ]);

    expect([firstClose.status, secondClose.status]).toEqual([201, 201]);
    await expect(
      prisma.operatorPostSession.count({ where: { operatorId, status: 'active' } }),
    ).resolves.toBe(0);
    await expect(
      prisma.domainEvent.count({
        where: { actorId: operatorId, type: 'audit:operator_post_session_closed' },
      }),
    ).resolves.toBe(1);
  });

  it('assigns a new roll to another planned operator after the shared shift opens', async () => {
    const http = () => request(app.getHttpServer());
    const [leadLogin, otherLogin, openerLogin] = await Promise.all([
      http()
        .post('/api/auth/login')
        .send({ login: dispatchLeadLogin, password: dispatchLeadPassword })
        .expect(201),
      http()
        .post('/api/auth/login')
        .send({ login: `session-op-b-${suffix}@test.local`, password: otherPassword })
        .expect(201),
      http().post('/api/auth/login').send({ login, password }).expect(201),
    ]);
    const leadBearer = { Authorization: `Bearer ${leadLogin.body.token as string}` };
    const otherBearer = { Authorization: `Bearer ${otherLogin.body.token as string}` };
    const openerBearer = { Authorization: `Bearer ${openerLogin.body.token as string}` };

    const [shiftBefore, openerAssignmentBefore] = await Promise.all([
      prisma.shift.findUniqueOrThrow({ where: { id: shiftId } }),
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { shiftId_operatorId: { shiftId, operatorId } },
      }),
    ]);
    if (shiftBefore.status === 'planned' || openerAssignmentBefore.status === 'planned') {
      await http()
        .post('/api/operator/post-sessions')
        .set(openerBearer)
        .send({ postCode })
        .expect(201);
      await http().post('/api/operator/post-sessions/close').set(openerBearer).send({}).expect(201);
    }

    await expect(prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).resolves.toMatchObject(
      {
        status: 'open',
      },
    );
    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { shiftId_operatorId: { shiftId, operatorId } },
      }),
    ).resolves.toMatchObject({ status: 'locked' });
    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { shiftId_operatorId: { shiftId, operatorId: otherOperatorId } },
      }),
    ).resolves.toMatchObject({ status: 'planned', postId: closingPostId });

    await prisma.counterparty.create({
      data: { id: plannedCounterpartyId, displayName: 'Shared-shift planned counterparty' },
    });
    await prisma.commercialOrder.create({
      data: {
        id: plannedCommercialOrderId,
        orderNumber: `SESSION-PLANNED-ORDER-${suffix}`,
        creatorRole: Role.commercial,
        counterpartyId: plannedCounterpartyId,
      },
    });
    await prisma.productionOrder.create({
      data: {
        id: plannedProductionOrderId,
        commercialOrderId: plannedCommercialOrderId,
        approvalState: 'approved',
      },
    });
    await prisma.rollDispatchItem.create({
      data: {
        id: plannedDispatchId,
        rollCode: plannedRollCode,
        productionOrderId: plannedProductionOrderId,
        status: 'new',
      },
    });
    await prisma.operatorRollLine.create({
      data: {
        id: plannedLineId,
        rollDispatchItemId: plannedDispatchId,
        step: 'assigned',
      },
    });

    await http()
      .post(`/api/production/roll-dispatch/${plannedRollCode}/assign`)
      .set(leadBearer)
      .send({ operatorId: otherOperatorId })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          assignedOperatorId: otherOperatorId,
          plannedShiftId: shiftId,
          postId: closingPostId,
          machineId: closingPostCode,
          status: 'assigned',
        });
      });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: plannedDispatchId } }),
    ).resolves.toMatchObject({
      assignedOperatorId: otherOperatorId,
      plannedShiftId: shiftId,
      postId: closingPostId,
      machineId: closingPostCode,
      status: 'assigned',
    });

    await http()
      .post('/api/operator/post-sessions')
      .set(otherBearer)
      .send({ postCode: closingPostCode })
      .expect(201);
    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { shiftId_operatorId: { shiftId, operatorId: otherOperatorId } },
      }),
    ).resolves.toMatchObject({ status: 'locked' });
    const runtime = await http().get('/api/operator/runtime').set(otherBearer).expect(200);
    expect(
      runtime.body.orders.some((order: { rolls?: Array<{ id: string }> }) =>
        order.rolls?.some((roll) => roll.id === plannedRollCode),
      ),
    ).toBe(true);

    await http().post('/api/operator/post-sessions/close').set(otherBearer).send({}).expect(201);
  });

  it('waits for an owned roll mutation before closing its operator session', async () => {
    const http = () => request(app.getHttpServer());
    const loginResponse = await http()
      .post('/api/auth/login')
      .send({ login, password })
      .expect(201);
    const bearer = { Authorization: `Bearer ${loginResponse.body.token as string}` };
    await http().post('/api/operator/post-sessions').set(bearer).send({ postCode }).expect(201);

    await prisma.counterparty.create({
      data: {
        id: contentionCounterpartyId,
        displayName: 'Session contention counterparty',
      },
    });
    await prisma.commercialOrder.create({
      data: {
        id: contentionCommercialOrderId,
        orderNumber: `SESSION-ORDER-${suffix}`,
        creatorRole: Role.commercial,
        counterpartyId: contentionCounterpartyId,
      },
    });
    await prisma.productionOrder.create({
      data: {
        id: contentionProductionOrderId,
        commercialOrderId: contentionCommercialOrderId,
        approvalState: 'approved',
      },
    });
    await prisma.rollDispatchItem.create({
      data: {
        id: contentionDispatchId,
        rollCode: contentionRollCode,
        productionOrderId: contentionProductionOrderId,
        assignedOperatorId: operatorId,
        postId,
        plannedShiftId: shiftId,
        status: 'assigned',
      },
    });
    await prisma.operatorRollLine.create({
      data: {
        id: contentionLineId,
        rollDispatchItemId: contentionDispatchId,
        step: 'assigned',
      },
    });

    const baglessKey = randomUUID();
    await http()
      .post(`/api/operator/rolls/${contentionRollCode}/accept`)
      .set(bearer)
      .send({ operationKey: baglessKey })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'OPERATOR_SHIFT_BAG_USAGE_REQUIRED' });
      });
    await expect(
      prisma.operatorRollOperation.count({ where: { operationKey: baglessKey } }),
    ).resolves.toBe(0);

    const activeSession = await prisma.operatorPostSession.findFirstOrThrow({
      where: { operatorId, status: 'active' },
    });
    await prisma.bigBagUnit.create({
      data: {
        id: contentionBagId,
        code: contentionBagCode,
        material: 'Session test material',
        status: 'in_use',
        registrationStatus: 'registered',
        location: 'production',
        initialKg: 100,
        currentKg: 100,
      },
    });
    const usage = await prisma.shiftBagUsage.create({
      data: {
        sessionId: activeSession.id,
        bigBagId: contentionBagId,
        startKg: 100,
      },
    });

    let releaseMutation: () => void = () => undefined;
    let markMutationLocked: () => void = () => undefined;
    const mutationLocked = new Promise<void>((resolve) => {
      markMutationLocked = resolve;
    });
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = prisma.$transaction(async (tx) => {
      await ownership.lockOwned(tx, { userId: operatorId, role: 'operator' }, contentionRollCode);
      markMutationLocked();
      await mutationRelease;
      const updated = await tx.operatorRollLine.update({
        where: { id: contentionLineId },
        data: { step: 'accepted' },
      });
      await tx.shiftBagUsage.update({
        where: { id: usage.id },
        data: { endKg: 100, closedAt: new Date() },
      });
      await tx.bigBagUnit.update({
        where: { id: contentionBagId },
        data: { status: 'available', currentKg: 100 },
      });
      return updated;
    });
    await mutationLocked;
    const close = Promise.resolve(
      http().post('/api/operator/post-sessions/close').set(bearer).send({}),
    );

    let waitFailure: unknown;
    try {
      await waitForBlockedRowLock('operator_post_sessions');
    } catch (error) {
      waitFailure = error;
    } finally {
      releaseMutation();
    }
    const [updatedLine, closeResponse] = await Promise.all([mutation, close]);

    if (waitFailure) throw waitFailure;
    expect(updatedLine.step).toBe('accepted');
    expect(closeResponse.status).toBe(201);
    await expect(
      prisma.operatorPostSession.count({ where: { operatorId, status: 'active' } }),
    ).resolves.toBe(0);
  });

  it('does not open from a stale active-post read during concurrent breakdown', async () => {
    const http = () => request(app.getHttpServer());
    const loginResponse = await http()
      .post('/api/auth/login')
      .send({ login, password })
      .expect(201);
    const bearer = { Authorization: `Bearer ${loginResponse.body.token as string}` };
    let releaseBlocker: () => void = () => undefined;
    let markBlockerReady: () => void = () => undefined;
    const blockerReady = new Promise<void>((resolve) => {
      markBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.post.update({ where: { id: postId }, data: { status: 'broken' } });
      markBlockerReady();
      await blockerRelease;
    });
    await blockerReady;
    const open = Promise.resolve(
      http().post('/api/operator/post-sessions').set(bearer).send({ postCode }),
    );

    let waitFailure: unknown;
    try {
      await waitForBlockedRowLock('posts');
    } catch (error) {
      waitFailure = error;
    } finally {
      releaseBlocker();
      await blocker;
    }
    const response = await open;
    await prisma.operatorPostSession.updateMany({
      where: { operatorId, status: 'active' },
      data: { status: 'closed', endedAt: new Date() },
    });
    await prisma.post.update({ where: { id: postId }, data: { status: 'active' } });

    if (waitFailure) throw waitFailure;
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' });
    await expect(
      prisma.operatorPostSession.count({ where: { operatorId, status: 'active' } }),
    ).resolves.toBe(0);
  });

  it('does not open from a stale assignment read during concurrent reassignment', async () => {
    const http = () => request(app.getHttpServer());
    const loginResponse = await http()
      .post('/api/auth/login')
      .send({ login, password })
      .expect(201);
    const bearer = { Authorization: `Bearer ${loginResponse.body.token as string}` };
    let releaseBlocker: () => void = () => undefined;
    let markBlockerReady: () => void = () => undefined;
    const blockerReady = new Promise<void>((resolve) => {
      markBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const assignment = await prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
      where: { shiftId_operatorId: { shiftId, operatorId } },
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.operatorShiftMachineAssignment.update({
        where: { id: assignment.id },
        data: { postId: otherPostId },
      });
      markBlockerReady();
      await blockerRelease;
    });
    await blockerReady;
    const open = Promise.resolve(
      http().post('/api/operator/post-sessions').set(bearer).send({ postCode }),
    );

    let waitFailure: unknown;
    try {
      await waitForBlockedRowLock('operator_shift_machine_assignments');
    } catch (error) {
      waitFailure = error;
    } finally {
      releaseBlocker();
      await blocker;
    }
    const response = await open;
    await prisma.operatorPostSession.updateMany({
      where: { operatorId, status: 'active' },
      data: { status: 'closed', endedAt: new Date() },
    });
    await prisma.operatorShiftMachineAssignment.update({
      where: { id: assignment.id },
      data: { postId, status: 'locked' },
    });

    if (waitFailure) throw waitFailure;
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' });
    await expect(
      prisma.operatorPostSession.count({ where: { operatorId, status: 'active' } }),
    ).resolves.toBe(0);
  });

  it('serializes physical work and concurrent operator closes, completes exact assignments, and closes the shared shift once', async () => {
    const http = () => request(app.getHttpServer());
    const [operatorLogin, otherLogin] = await Promise.all([
      http().post('/api/auth/login').send({ login, password }).expect(201),
      http()
        .post('/api/auth/login')
        .send({ login: `session-op-b-${suffix}@test.local`, password: otherPassword })
        .expect(201),
    ]);
    const operatorBearer = {
      Authorization: `Bearer ${operatorLogin.body.token as string}`,
    };
    const otherBearer = { Authorization: `Bearer ${otherLogin.body.token as string}` };
    await prisma.operatorRollLine.update({
      where: { id: contentionLineId },
      data: { step: 'assigned', deferredFromStep: null },
    });
    await prisma.rollDispatchItem.update({
      where: { id: contentionDispatchId },
      data: { status: 'assigned' },
    });
    await prisma.bigBagUnit.create({
      data: {
        id: otherBagId,
        code: otherBagCode,
        material: 'Session test material',
        status: 'available',
        registrationStatus: 'registered',
        location: 'production',
        initialKg: 100,
        currentKg: 100,
      },
    });

    await http()
      .post('/api/operator/shift/open')
      .set(operatorBearer)
      .send({ postCode, bigBagId: contentionBagId, startKg: 100 })
      .expect(201);
    await http()
      .post('/api/operator/shift/open')
      .set(otherBearer)
      .send({ postCode: closingPostCode, bigBagId: otherBagId, startKg: 100 })
      .expect(201);
    await Promise.all([
      prepareReadyDefectBagFixture(prisma, operatorId),
      prepareReadyDefectBagFixture(prisma, otherOperatorId),
    ]);

    let releasePhysical: () => void = () => undefined;
    let markPhysicalLocked: () => void = () => undefined;
    const physicalLocked = new Promise<void>((resolve) => {
      markPhysicalLocked = resolve;
    });
    const physicalRelease = new Promise<void>((resolve) => {
      releasePhysical = resolve;
    });
    const physicalOperationKey = randomUUID();
    const physical = prisma.$transaction(async (tx) => {
      const { session, line } = await ownership.lockOwned(
        tx,
        { userId: operatorId, role: 'operator' },
        contentionRollCode,
      );
      markPhysicalLocked();
      await physicalRelease;
      const claim = await operations.claim(tx, {
        operationKey: physicalOperationKey,
        action: 'spool_weight',
        actorId: operatorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        expectedStep: line.step,
        fingerprintInput: {},
      });
      if (claim.kind !== 'claimed') throw new Error('Physical operation was not claimed');
      await operations.complete(
        tx,
        claim.operation.id,
        { resultStep: line.step, httpStatus: 200 },
        claim.operation.leaseToken,
      );
    });
    await physicalLocked;

    const closeOperator = Promise.resolve(
      http()
        .post('/api/operator/shift/close')
        .set(operatorBearer)
        .send({ operationKey: randomUUID(), bags: [{ bigBagId: contentionBagId, endKg: 99 }] }),
    );
    try {
      await waitForBlockedRowLock('posts', 'operator_post_sessions');
      const closeOther = Promise.resolve(
        http()
          .post('/api/operator/shift/close')
          .set(otherBearer)
          .send({ operationKey: randomUUID(), bags: [{ bigBagId: otherBagId, endKg: 99 }] }),
      );
      releasePhysical();
      const [operatorClose, otherClose] = await Promise.all([closeOperator, closeOther]);
      expect(operatorClose.status).toBe(200);
      expect(otherClose.status).toBe(200);
    } finally {
      releasePhysical();
      await physical;
      await closeOperator;
    }

    const [operatorAssignment, otherAssignment, shift] = await Promise.all([
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { shiftId_operatorId: { shiftId, operatorId } },
      }),
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { shiftId_operatorId: { shiftId, operatorId: otherOperatorId } },
      }),
      prisma.shift.findUniqueOrThrow({ where: { id: shiftId } }),
    ]);
    expect(operatorAssignment.status).toBe('completed');
    expect(otherAssignment.status).toBe('completed');
    expect(shift).toMatchObject({ status: 'closed', endedAt: expect.any(Date) });
    await expect(
      prisma.domainEvent.count({
        where: {
          actorId: { in: [operatorId, otherOperatorId] },
          type: 'audit:operator_shift_closed',
        },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.operatorRollOperation.findUniqueOrThrow({
        where: { operationKey: physicalOperationKey },
      }),
    ).resolves.toMatchObject({ status: 'succeeded', postId });

    await http()
      .post('/api/operator/post-sessions')
      .set(operatorBearer)
      .send({ postCode })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' });
      });
    await http()
      .post('/api/operator/post-sessions')
      .set(otherBearer)
      .send({ postCode: closingPostCode })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' });
      });
  });

  it('rejects a duplicate active operator but allows a shared post and closed history', async () => {
    await prisma.operatorPostSession.create({
      data: { id: `constraint-active-${suffix}`, operatorId, postId, shiftId, status: 'active' },
    });

    await expect(
      prisma.operatorPostSession.create({
        data: {
          id: `constraint-operator-${suffix}`,
          operatorId,
          postId: otherPostId,
          shiftId,
          status: 'active',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.operatorPostSession.create({
        data: {
          id: `constraint-post-${suffix}`,
          operatorId: otherOperatorId,
          postId,
          shiftId,
          status: 'active',
        },
      }),
    ).resolves.toMatchObject({ operatorId: otherOperatorId, postId, status: 'active' });
    await expect(
      prisma.operatorPostSession.create({
        data: {
          id: `constraint-history-${suffix}`,
          operatorId,
          postId,
          shiftId,
          status: 'closed',
          endedAt: new Date(),
        },
      }),
    ).resolves.toMatchObject({ status: 'closed' });
  });
});
