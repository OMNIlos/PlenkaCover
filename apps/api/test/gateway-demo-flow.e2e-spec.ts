import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { postLivenessFingerprint } from '../src/common/operational-incidents/device-incident-signals';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import {
  approveProductionOnlyCover,
  PRIMARY_BASE_MATERIAL_SELECTION,
  STANDARD_ROLL_DIMENSIONS,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import {
  attachAvailableBagToOperatorShift,
  createAvailableBigBagFixture,
  createAssignedOperatorShiftFixture,
} from './operator-shift-e2e-fixture';
import { enableSimulatedDevices } from './simulated-device-fixture';
import { sealAndPrintCurrentPalletFixture } from './warehouse-pallet-e2e-fixture';

/**
 * Production-demo smoke: the SAME operator cycle as full-demo-flow, but with the scale and
 * printer routed through the post gateway (DEVICE_GATEWAY_*=on) and answered by the
 * SimulatedGatewayAgent — exactly what a real Windows on-post agent replaces, over the
 * same contract, with zero business-logic changes.
 *
 * Env flags are read when the module files are first imported (Nest decorator args), so
 * AppModule is require()d INSIDE beforeAll, after the flags are set.
 */
describe('Gateway production-demo flow (e2e, real DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sim: any;
  const savedEnv: Record<string, string | undefined> = {};
  const FLAGS = {
    DEVICE_GATEWAY_SCALE: 'on',
    DEVICE_GATEWAY_PRINTER: 'on',
    GATEWAY_SIMULATOR: 'on',
    GATEWAY_STALE_AFTER_SEC: '1',
  } as const;
  const uniq = Date.now();
  let restoreSimulatedDevices: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(FLAGS)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../src/app.module');
    const { PrismaService: PrismaServiceClass } = require('../src/common/prisma/prisma.service');
    const { SimulatedGatewayAgent } = require('../src/modules/gateway/simulated-gateway-agent');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaServiceClass);
    sim = moduleRef.get(SimulatedGatewayAgent);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await restoreSimulatedDevices?.();
    await app?.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('keeps every simulated post fresh beyond the configured liveness threshold', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    const posts = await prisma.post.findMany({
      select: { id: true, lastSeenAt: true },
    });
    expect(posts).not.toHaveLength(0);
    expect(
      posts.every((post) => post.lastSeenAt && Date.now() - post.lastSeenAt.getTime() < 1_000),
    ).toBe(true);
    await expect(
      prisma.operationalIncident.count({
        where: {
          fingerprint: { in: posts.map((post) => postLivenessFingerprint(post.id)) },
          status: 'open',
        },
      }),
    ).resolves.toBe(0);
  });

  it('runs the operator cycle through the gateway, including device-failure paths', async () => {
    restoreSimulatedDevices = await enableSimulatedDevices(prisma, [
      'dev-scale-1',
      'dev-printer-1',
    ]);
    const password = e2eSeedPassword();
    const [commercialLogin, productionLogin, financeLogin, warehouseLogin, adminLogin] =
      await Promise.all(
        (['commercial', 'production', 'finance', 'warehouse', 'admin'] as const).map((account) =>
          request(app.getHttpServer())
            .post('/api/auth/login')
            .send({ login: e2eSeedLogin(account), password })
            .expect(201),
        ),
      );
    const asCommercial = {
      Authorization: `Bearer ${commercialLogin.body.token as string}`,
    };
    const asProduction = {
      Authorization: `Bearer ${productionLogin.body.token as string}`,
    };
    const asFinance = { Authorization: `Bearer ${financeLogin.body.token as string}` };
    const asWarehouse = { Authorization: `Bearer ${warehouseLogin.body.token as string}` };
    const asAdmin = { Authorization: `Bearer ${adminLogin.body.token as string}` };
    // --- Order pipeline up to an assigned roll on POST-1 ----------------------
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `Гейтвей Демо ${uniq}`, inn: `78${uniq}`.slice(0, 12) })
      .expect(201);

    const commercial = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: cp.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            ...STANDARD_ROLL_DIMENSIONS,
            spoolType: 'втулка 76',
            plannedWeightKg: 41.2,
            recipeParameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
          },
        ],
      })
      .expect(201);

    await approveProductionOnlyCover(app, prisma, asCommercial, commercial.body);

    await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercial.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({ amount: 150000, note: 'Гейтвей демо-счёт' })
      .expect(201);
    const financeOrders = await request(app.getHttpServer())
      .get('/api/finance/orders')
      .set(asFinance)
      .expect(200);
    const financeOrder = financeOrders.body.find(
      (order: { commercialOrder?: { id: string } }) =>
        order.commercialOrder?.id === commercial.body.id,
    );
    expect(financeOrder).toBeTruthy();
    await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(asFinance)
      .send({ amount: 150000, paymentTermsType: 'postpay_100_30d' })
      .expect(201);

    const production = await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercial.body.id}/send-to-production`)
      .set(asCommercial)
      .send({})
      .expect(201);
    const rollCode = production.body.dispatchItems[0].rollCode as string;

    const operatorLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('operator'), password: e2eSeedPassword() })
      .expect(201);
    const asOperator = { Authorization: `Bearer ${operatorLogin.body.token as string}` };
    const operatorId = operatorLogin.body.user.id as string;

    const operatorShift = await createAssignedOperatorShiftFixture(prisma, {
      operatorId,
      postCode: 'POST-1',
      label: `Gateway demo operator shift ${uniq}`,
    });
    const assignedRoll = await request(app.getHttpServer())
      .post(`/api/production/roll-dispatch/${rollCode}/assign`)
      .set(asProduction)
      .send({ operatorId })
      .expect(201);
    expect(assignedRoll.body).toMatchObject({
      assignedOperatorId: operatorId,
      plannedShiftId: operatorShift.shiftId,
      postId: operatorShift.post.id,
      machineId: operatorShift.post.code,
      workplaceId: operatorShift.post.id,
    });
    await request(app.getHttpServer())
      .post(`/api/production/orders/${production.body.id}/approve`)
      .set(asProduction)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/operator/post-sessions')
      .set(asOperator)
      .send({ postCode: 'POST-1' })
      .expect(201);
    const bigBagId = await createAvailableBigBagFixture(prisma, {
      code: `GATEWAY-DEMO-BAG-${uniq}`,
    });
    await attachAvailableBagToOperatorShift(app, prisma, asOperator, 'POST-1', bigBagId);

    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/accept`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);

    // --- Failure first: offline scale → 503 + device.scale.offline audit ------
    await sim.setOffline('dev-scale-1');
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(503);
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(503);
    const offlineEvent = await prisma.domainEvent.findFirst({
      where: { type: 'device.scale.offline', objectId: rollCode },
    });
    expect(offlineEvent).toBeTruthy();
    const scaleFingerprint = 'device:dev-scale-1:connection';
    const scaleIncident = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint: scaleFingerprint },
    });
    expect(scaleIncident).toMatchObject({ status: 'open', targetId: 'dev-scale-1' });
    await expect(
      prisma.domainEvent.count({
        where: { type: 'admin.incident.opened', objectId: scaleIncident.id },
      }),
    ).resolves.toBe(1);
    expect(JSON.stringify(scaleIncident)).not.toMatch(/rawPayload|frame|token|secret/i);
    await sim.setOffline('dev-scale-1', false);

    // --- Weights via the gateway (sim: spool 2.0, roll gross 43.4 → net 41.4) -
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await expect(
      prisma.operationalIncident.findUniqueOrThrow({ where: { fingerprint: scaleFingerprint } }),
    ).resolves.toMatchObject({ status: 'resolved' });
    await expect(
      prisma.domainEvent.count({
        where: { type: 'admin.incident.resolved', objectId: scaleIncident.id },
      }),
    ).resolves.toBe(1);
    const afterRoll = await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/roll-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    expect(afterRoll.body.spoolKg).toBe(2.0);
    expect(afterRoll.body.netKg).toBeCloseTo(41.4, 3);

    // --- QR print via the gateway printer, verify by scanned payload ----------
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/qr-print`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const printEvidence = await prisma.rollScanToken.findUniqueOrThrow({
      where: { rollCode },
      select: { token: true },
    });
    expect(printEvidence.token).toMatch(/^prt_[0-9a-f]{64}$/u);

    const incidentsBeforeMismatch = await prisma.operationalIncident.count();
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/qr-verify`)
      .set(asOperator)
      .send({ operationKey: randomUUID(), payload: 'QR-some-other-roll' })
      .expect(400);
    const mismatchEvent = await prisma.domainEvent.findFirst({
      where: { type: 'device.scan.mismatch', objectId: rollCode },
    });
    expect(mismatchEvent).toBeTruthy();
    await expect(prisma.operationalIncident.count()).resolves.toBe(incidentsBeforeMismatch);

    const reusedOperationKey = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/qr-verify-and-handover`)
      .set(asOperator)
      .send({
        operationKey: reusedOperationKey,
        handoverOperationKey: reusedOperationKey,
        payload: printEvidence.token,
      })
      .expect(400);

    // --- Exact QR automatically hands over; warehouse scans the same label ----
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/qr-verify-and-handover`)
      .set(asOperator)
      .send({
        operationKey: randomUUID(),
        handoverOperationKey: randomUUID(),
        payload: printEvidence.token,
      })
      .expect(201);

    const tasks = await request(app.getHttpServer())
      .get('/api/warehouse/tasks')
      .set(asWarehouse)
      .expect(200);
    const task = tasks.body.find((t: { rows: Array<{ rollCode: string }> }) =>
      t.rows.some((r) => r.rollCode === rollCode),
    );
    expect(task).toBeTruthy();
    const scanned = await request(app.getHttpServer())
      .post(`/api/warehouse/tasks/${task.id}/scans`)
      .set(asWarehouse)
      .send({ operationKey: randomUUID(), payload: printEvidence.token })
      .expect(201);
    expect(scanned.body).toEqual(
      expect.objectContaining({ rollCode, scanStatus: 'accepted', replayed: false }),
    );
    await sealAndPrintCurrentPalletFixture(app, asWarehouse, task.id, {
      expectedRollCount: 1,
    });
    await request(app.getHttpServer())
      .post(`/api/warehouse/tasks/${task.id}/close`)
      .set(asWarehouse)
      .send({ mode: 'full' })
      .expect(201);

    // --- Command lifecycle landed in the journal ------------------------------
    const post1 = await prisma.post.findUnique({ where: { code: 'POST-1' } });
    const doneCommands = await prisma.gatewayCommand.count({
      where: { postId: post1!.id, status: 'done' },
    });
    expect(doneCommands).toBeGreaterThanOrEqual(3); // offline read + 2 weights + print

    // --- Observability + §8 raw boundary --------------------------------------
    const posts = await request(app.getHttpServer())
      .get('/api/admin/posts')
      .set(asAdmin)
      .expect(200);
    const adminPost1 = posts.body.find((p: { code: string }) => p.code === 'POST-1');
    expect(adminPost1.online).toBe(true);
    expect(adminPost1.devices.length).toBeGreaterThan(0);
    expect(JSON.stringify(posts.body)).not.toContain('rawPayload');

    const runtime = await request(app.getHttpServer())
      .get('/api/operator/runtime')
      .set(asOperator)
      .expect(200);
    for (const body of [runtime.body, tasks.body]) {
      const json = JSON.stringify(body);
      expect(json).not.toContain('rawPayload');
      expect(json).not.toContain('legalName');
    }
  });
});
