import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as net from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GATEWAY_CAPABILITIES, GATEWAY_PROTOCOL_VERSION } from '@plenka/contracts';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import { handleCommand, type AgentDevices } from '../../gateway-agent/src/commands';
import { Tcp9100Printer } from '../../gateway-agent/src/devices/printer';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { OperatorRollOwnershipService } from '../src/modules/operator/operator-roll-ownership.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { prepareReadyDefectBagFixture } from './operator-shift-e2e-fixture';

describe('physical TCP print submission → exact HID verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownership: OperatorRollOwnershipService;
  const suffix = randomUUID().slice(0, 8);
  const login = `physical-print-${suffix}`;
  const postCode = `PHYSICAL-${suffix}`;
  const rawAgentToken = `ptk_${randomBytes(32).toString('base64url')}`;
  const rollCode = `ROLL-PHYSICAL-${suffix}`;
  const uncertainRollCode = `ROLL-UNCERTAIN-${suffix}`;
  const contentionRollCode = `ROLL-CONTENTION-${suffix}`;
  const savedEnv: Record<string, string | undefined> = {};
  const flags = {
    AUTH_DEV_XROLE: 'off',
    DEVICE_GATEWAY_PRINTER: 'on',
    GATEWAY_SIMULATOR: 'off',
    GATEWAY_COMMAND_TIMEOUT_MS: '10000',
  } as const;
  let userId = '';
  let postId = '';
  let printerId = '';
  let sessionId = '';
  let bigBagId = '';
  let contentionLineId = '';
  let contentionPrintJobId = '';

  async function waitForBlockedRowLock(tableName: string, minimum = 1): Promise<void> {
    const deadline = Date.now() + 5_000;
    const queryPattern = `%FROM "${tableName}"%FOR UPDATE%`;
    while (Date.now() < deadline) {
      const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
        SELECT COUNT(*) >= ${minimum} AS waiting
        FROM (
          SELECT 1
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE ${queryPattern}
        ) AS blocked
      `);
      if (state?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${tableName} row lock`);
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(flags)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../src/app.module');
    const { PrismaService: PrismaServiceClass } = require('../src/common/prisma/prisma.service');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaServiceClass);
    ownership = moduleRef.get(OperatorRollOwnershipService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const seededOperator = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
      select: { passwordHash: true },
    });
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Physical customer ${suffix}` },
    });
    const commercialOrder = await prisma.commercialOrder.create({
      data: {
        orderNumber: `PHYSICAL-ORDER-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
        productionIndicator: 'in_production',
      },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: { commercialOrderId: commercialOrder.id, approvalState: 'approved' },
    });
    const user = await prisma.user.create({
      data: {
        login,
        passwordHash: seededOperator.passwordHash,
        displayName: `Physical print ${suffix}`,
        role: 'operator',
      },
    });
    userId = user.id;
    const now = new Date();
    const post = await prisma.post.create({
      data: {
        code: postCode,
        name: `Physical test post ${suffix}`,
        status: 'active',
        commissioningState: 'commissioned',
        commissionedAt: now,
        agentStatus: 'online',
        lastSeenAt: now,
        agentProtocolVersion: GATEWAY_PROTOCOL_VERSION,
        agentPackageVersion: 'e2e-physical',
        agentReleaseCommit: 'f'.repeat(40),
        agentCapabilities: [...GATEWAY_CAPABILITIES],
        agentCompatibility: 'compatible',
        agentTokenHash: createHash('sha256').update(rawAgentToken).digest('hex'),
      },
    });
    postId = post.id;
    const printer = await prisma.deviceRuntime.create({
      data: {
        code: `PRINTER-${suffix}`,
        label: `TCP printer ${suffix}`,
        kind: 'printer',
        connectionKind: 'tcp9100',
        isEnabled: true,
        status: 'ready',
        ownerRole: 'admin',
        postId,
        lastSeenAt: now,
        lastProbeAt: now,
      },
    });
    printerId = printer.id;
    await prisma.deviceRuntime.create({
      data: {
        code: `SCANNER-${suffix}`,
        label: `HID scanner ${suffix}`,
        kind: 'scanner',
        connectionKind: 'hid',
        isEnabled: true,
        status: 'ready',
        ownerRole: 'admin',
        postId,
        lastSeenAt: now,
        lastProbeAt: now,
      },
    });
    const shift = await prisma.shift.create({
      data: {
        label: `Physical print shift ${suffix}`,
        plannedStartAt: new Date(now.getTime() - 60_000),
        plannedEndAt: new Date(now.getTime() + 60 * 60_000),
        startedAt: now,
        status: 'open',
      },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: shift.id,
        operatorId: userId,
        postId,
        status: 'locked',
        lockedAt: now,
      },
    });
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode,
        productionOrderId: productionOrder.id,
        assignedOperatorId: userId,
        postId,
        machineId: postCode,
        workplaceId: postCode,
        plannedShiftId: shift.id,
        plannedWeightKg: 10,
        status: 'assigned',
      },
    });
    await prisma.operatorRollLine.create({
      data: {
        rollDispatchItemId: dispatch.id,
        planKg: 10,
        step: 'qr_print',
        labelState: 'not_printed',
        warehouseState: 'not_ready',
      },
    });
    const uncertainDispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode: uncertainRollCode,
        productionOrderId: productionOrder.id,
        assignedOperatorId: userId,
        postId,
        machineId: postCode,
        workplaceId: postCode,
        plannedShiftId: shift.id,
        plannedWeightKg: 10,
        status: 'assigned',
      },
    });
    await prisma.operatorRollLine.create({
      data: {
        rollDispatchItemId: uncertainDispatch.id,
        planKg: 10,
        step: 'qr_print',
        labelState: 'not_printed',
        warehouseState: 'not_ready',
      },
    });
    const contentionDispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode: contentionRollCode,
        productionOrderId: productionOrder.id,
        assignedOperatorId: userId,
        postId,
        machineId: postCode,
        workplaceId: postCode,
        plannedShiftId: shift.id,
        plannedWeightKg: 10,
        status: 'assigned',
      },
    });
    const contentionLine = await prisma.operatorRollLine.create({
      data: {
        rollDispatchItemId: contentionDispatch.id,
        planKg: 10,
        step: 'qr_print',
        labelState: 'delivery_unknown',
        warehouseState: 'not_ready',
      },
    });
    contentionLineId = contentionLine.id;
    const session = await prisma.operatorPostSession.create({
      data: { operatorId: userId, postId, shiftId: shift.id, status: 'active' },
    });
    sessionId = session.id;
    const bigBag = await prisma.bigBagUnit.create({
      data: {
        code: `PHYSICAL-BAG-${suffix}`,
        material: 'Physical print test material',
        status: 'in_use',
        initialKg: 100,
        currentKg: 100,
        lastMeasuredKg: 100,
        lastActorRole: 'operator',
        lastMeasuredAt: now,
      },
    });
    bigBagId = bigBag.id;
    await prisma.shiftBagUsage.create({
      data: {
        sessionId: session.id,
        bigBagId: bigBag.id,
        startKg: 100,
      },
    });
    const contentionPrintJob = await prisma.labelPrintJob.create({
      data: {
        operatorRollLineId: contentionLine.id,
        printerId: printer.id,
        status: 'delivery_unknown',
        actorId: userId,
        postSessionId: session.id,
        postId,
        failureReason: 'delivery_unknown_concurrency_fixture',
        completedAt: now,
      },
    });
    contentionPrintJobId = contentionPrintJob.id;
  });

  afterAll(async () => {
    // The e2e harness drops its isolated schema. Immutable scan/reconciliation facts deliberately
    // make row-by-row teardown both incomplete and contrary to the production data model.
    await app?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('does not claim printed until the exact label token is physically scanned', async () => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
      socket.on('end', () => socket.end());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('TCP test server has no port');
      const loginResponse = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login, password: e2eSeedPassword() })
        .expect(201);
      const operatorAuth = { Authorization: `Bearer ${loginResponse.body.token as string}` };
      const pendingPrint = request(app.getHttpServer())
        .post(`/api/operator/rolls/${rollCode}/qr-print`)
        .set(operatorAuth)
        .send({ operationKey: randomUUID() })
        .then((response) => response);

      let command: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100 && !command; attempt += 1) {
        const polled = await request(app.getHttpServer())
          .get('/api/gateway/commands')
          .set('x-agent-token', rawAgentToken)
          .expect(200);
        command = polled.body[0] as Record<string, unknown> | undefined;
        if (!command) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(command).toBeDefined();
      expect(command).toMatchObject({
        kind: 'label.print.v1',
        serverTime: expect.any(String),
        executionBudgetMs: expect.any(Number),
      });
      await request(app.getHttpServer())
        .post(`/api/gateway/commands/${String(command!.id)}/result`)
        .set('x-agent-token', rawAgentToken)
        .send({
          leaseToken: command!.leaseToken,
          result: { status: 'submitted', jobId: 'malformed-without-ok' },
        })
        .expect(422)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'GATEWAY_RESULT_INVALID' });
        });

      const printer = new Tcp9100Printer('127.0.0.1', address.port, {
        dpi: 203,
        maxWidthDots: 864,
      });
      const devices: AgentDevices = {
        scale: {
          probe: async () => ({
            ok: true,
            status: 'ready',
            protocol: 'simulated',
            simulated: true,
          }),
          read: async () => ({ status: 'ready', stable: true, grossKg: 0 }),
          status: () => 'ready',
          close: async () => undefined,
        },
        scaleDeviceId: 'unused-scale',
        printer,
        printerDeviceId: printerId,
        printerMode: 'tcp9100',
        scanner: { status: () => 'ready' },
        scannerDeviceId: null,
      };
      const outcome = await handleCommand(
        command as unknown as Parameters<typeof handleCommand>[0],
        devices,
      );
      expect(outcome.result).toMatchObject({ ok: true, status: 'submitted' });

      await request(app.getHttpServer())
        .post(`/api/gateway/commands/${String(command!.id)}/result`)
        .set('x-agent-token', rawAgentToken)
        .send({ leaseToken: command!.leaseToken, result: outcome.result })
        .expect(201);
      const printResponse = await pendingPrint;
      expect(printResponse.status).toBe(201);
      expect(printResponse.body).toMatchObject({ step: 'qr_check', labelState: 'submitted' });
      expect(JSON.stringify(printResponse.body)).not.toContain('prt_');

      const bytes = Buffer.concat(received).toString('latin1');
      const token = bytes.match(/prt_[0-9a-f]{64}/u)?.[0];
      expect(token).toMatch(/^prt_[0-9a-f]{64}$/u);
      const verified = await request(app.getHttpServer())
        .post(`/api/operator/rolls/${rollCode}/qr-verify`)
        .set(operatorAuth)
        .send({ operationKey: randomUUID(), payload: token })
        .expect(201);
      expect(verified.body).toMatchObject({ step: 'handover', labelState: 'verified' });
      expect(JSON.stringify(verified.body)).not.toContain('prt_');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails closed on an ambiguous TCP delivery until an admin reconciles the physical label', async () => {
    const received: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
      socket.on('close', () => sockets.delete(socket));
      // Intentionally never close the server side: the client must report delivery_unknown.
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('TCP test server has no port');
      const operatorLogin = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login, password: e2eSeedPassword() })
        .expect(201);
      const adminLogin = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('admin'), password: e2eSeedPassword() })
        .expect(201);
      const operatorAuth = { Authorization: `Bearer ${operatorLogin.body.token as string}` };
      const adminAuth = { Authorization: `Bearer ${adminLogin.body.token as string}` };
      const pendingPrint = request(app.getHttpServer())
        .post(`/api/operator/rolls/${uncertainRollCode}/qr-print`)
        .set(operatorAuth)
        .send({ operationKey: randomUUID() })
        .then((response) => response);

      let command: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100 && !command; attempt += 1) {
        const polled = await request(app.getHttpServer())
          .get('/api/gateway/commands')
          .set('x-agent-token', rawAgentToken)
          .expect(200);
        command = polled.body[0] as Record<string, unknown> | undefined;
        if (!command) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(command).toBeDefined();

      const printer = new Tcp9100Printer(
        '127.0.0.1',
        address.port,
        { dpi: 203, maxWidthDots: 864 },
        50,
      );
      const devices: AgentDevices = {
        scale: {
          probe: async () => ({
            ok: true,
            status: 'ready',
            protocol: 'simulated',
            simulated: true,
          }),
          read: async () => ({ status: 'ready', stable: true, grossKg: 0 }),
          status: () => 'ready',
          close: async () => undefined,
        },
        scaleDeviceId: 'unused-scale',
        printer,
        printerDeviceId: printerId,
        printerMode: 'tcp9100',
        scanner: { status: () => 'ready' },
        scannerDeviceId: null,
      };
      const outcome = await handleCommand(
        command as unknown as Parameters<typeof handleCommand>[0],
        devices,
      );
      expect(outcome.result).toMatchObject({ ok: false, status: 'delivery_unknown' });
      await request(app.getHttpServer())
        .post(`/api/gateway/commands/${String(command!.id)}/result`)
        .set('x-agent-token', rawAgentToken)
        .send({ leaseToken: command!.leaseToken, result: outcome.result })
        .expect(201);

      const blocked = await pendingPrint;
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({
        code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
        printJobId: expect.any(String),
      });
      const printJobId = String(blocked.body.printJobId);
      await request(app.getHttpServer())
        .post(`/api/operator/rolls/${uncertainRollCode}/qr-print`)
        .set(operatorAuth)
        .send({ operationKey: randomUUID(), reason: 'Повторная попытка оператором' })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN', printJobId });
        });

      const reconciliation = {
        operationKey: randomUUID(),
        outcome: 'label_observed',
        reason: 'Этикетка визуально подтверждена на выходе принтера',
      };
      await request(app.getHttpServer())
        .post(`/api/admin/label-print-jobs/${printJobId}/reconcile`)
        .set(operatorAuth)
        .send(reconciliation)
        .expect(403);
      const reconciled = await request(app.getHttpServer())
        .post(`/api/admin/label-print-jobs/${printJobId}/reconcile`)
        .set(adminAuth)
        .send(reconciliation)
        .expect(201);
      expect(reconciled.body).toMatchObject({
        printJobId,
        rollCode: uncertainRollCode,
        outcome: 'label_observed',
        step: 'qr_check',
        labelState: 'submitted',
      });
      expect(JSON.stringify(reconciled.body)).not.toContain('prt_');
      await request(app.getHttpServer())
        .post(`/api/admin/label-print-jobs/${printJobId}/reconcile`)
        .set(adminAuth)
        .send(reconciliation)
        .expect(201)
        .expect(({ body }) => expect(body).toEqual(reconciled.body));
      await request(app.getHttpServer())
        .post(`/api/admin/label-print-jobs/${printJobId}/reconcile`)
        .set(adminAuth)
        .send({ ...reconciliation, outcome: 'not_printed' })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'ADMIN_LABEL_RECONCILIATION_KEY_CONFLICT' });
        });
      await expect(
        prisma.labelPrintReconciliation.count({
          where: { operationKey: reconciliation.operationKey },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.labelPrintReconciliation.update({
          where: { operationKey: reconciliation.operationKey },
          data: { reason: 'Попытка изменить уже записанное решение' },
        }),
      ).rejects.toThrow(/append-only/u);

      const bytes = Buffer.concat(received).toString('latin1');
      const token = bytes.match(/prt_[0-9a-f]{64}/u)?.[0];
      expect(token).toMatch(/^prt_[0-9a-f]{64}$/u);
      await request(app.getHttpServer())
        .post(`/api/operator/rolls/${uncertainRollCode}/qr-verify`)
        .set(operatorAuth)
        .send({ operationKey: randomUUID(), payload: token })
        .expect(201)
        .expect(({ body }) => {
          expect(body).toMatchObject({ step: 'handover', labelState: 'verified' });
          expect(JSON.stringify(body)).not.toContain('prt_');
        });

      const audit = await prisma.domainEvent.findFirstOrThrow({
        where: { type: 'audit:operator_label_print_reconciled', objectId: uncertainRollCode },
        select: { detail: true, oldValue: true, newValue: true, reason: true },
      });
      expect(JSON.stringify(audit)).not.toContain('prt_');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serializes reconciliation and finalization while safely deferring QR verification on close', async () => {
    const [operatorLogin, adminLogin] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login, password: e2eSeedPassword() })
        .expect(201),
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('admin'), password: e2eSeedPassword() })
        .expect(201),
    ]);
    const operatorAuth = { Authorization: `Bearer ${operatorLogin.body.token as string}` };
    const adminAuth = { Authorization: `Bearer ${adminLogin.body.token as string}` };
    await prepareReadyDefectBagFixture(prisma, userId);

    let releasePhysical: () => void = () => undefined;
    let markSessionLocked: () => void = () => undefined;
    const sessionLocked = new Promise<void>((resolve) => {
      markSessionLocked = resolve;
    });
    const physicalRelease = new Promise<void>((resolve) => {
      releasePhysical = resolve;
    });
    const physical = prisma.$transaction(async (tx) => {
      const owned = await ownership.lockOwned(tx, { userId, role: 'operator' }, contentionRollCode);
      markSessionLocked();
      await physicalRelease;
      // Exact downstream order used by physical print finalization after lockOwned:
      // Roll is already locked, then Job -> Line are updated.
      await tx.labelPrintJob.update({
        where: { id: contentionPrintJobId },
        data: { status: 'delivery_unknown' },
      });
      await tx.operatorRollLine.update({
        where: { id: contentionLineId },
        data: { step: 'qr_print', labelState: 'delivery_unknown' },
      });
      return owned;
    });
    await sessionLocked;

    const close = Promise.resolve(
      request(app.getHttpServer())
        .post('/api/operator/shift/close')
        .set(operatorAuth)
        .send({ operationKey: randomUUID(), bags: [{ bigBagId, endKg: 100 }] }),
    );
    let reconcile: Promise<Response> | null = null;
    let orchestrationFailure: unknown;
    try {
      await waitForBlockedRowLock('posts');
      reconcile = Promise.resolve(
        request(app.getHttpServer())
          .post(`/api/admin/label-print-jobs/${contentionPrintJobId}/reconcile`)
          .set(adminAuth)
          .send({
            operationKey: randomUUID(),
            outcome: 'label_observed',
            reason: 'Трёхсторонняя проверка порядка блокировок',
          }),
      );
      await waitForBlockedRowLock('posts', 2);
    } catch (error) {
      orchestrationFailure = error;
    } finally {
      releasePhysical();
    }

    const [physicalResult, closeResult, reconcileResult] = await Promise.all([
      physical,
      close,
      reconcile ?? Promise.reject(orchestrationFailure ?? new Error('Reconcile did not start')),
    ]);
    if (orchestrationFailure) throw orchestrationFailure;
    expect(physicalResult).toMatchObject({
      session: { id: sessionId },
      line: { id: contentionLineId },
    });
    expect(closeResult.status).toBe(200);
    expect(reconcileResult.status).toBe(409);
    expect(reconcileResult.body).toMatchObject({
      code: 'ADMIN_LABEL_RECONCILIATION_INVALID_STATE',
    });
    await expect(
      prisma.operatorPostSession.findUniqueOrThrow({ where: { id: sessionId } }),
    ).resolves.toMatchObject({ status: 'closed', endedAt: expect.any(Date) });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({ where: { id: contentionLineId } }),
    ).resolves.toMatchObject({
      step: 'deferred',
      deferredFromStep: 'qr_print',
      labelState: 'delivery_unknown',
    });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({
        where: { rollCode: contentionRollCode },
      }),
    ).resolves.toMatchObject({ status: 'deferred' });
    await expect(
      prisma.labelPrintJob.findUniqueOrThrow({ where: { id: contentionPrintJobId } }),
    ).resolves.toMatchObject({ status: 'delivery_unknown' });
  });
});
