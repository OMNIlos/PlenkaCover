import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { addCalendarDays } from '../src/modules/finance/deferred-payment.calculator';
import { moscowBusinessDate } from '../src/modules/finance/finance-business-projection';
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
 * Production-like local demo proof:
 * commercial -> finance payment -> explicit commercial handoff -> production
 * -> operator (Bearer + post session + mock devices) -> warehouse
 * -> finance with the disabled 1C runtime kept fail-closed -> director visibility.
 *
 * CI seeds users/posts/devices first; this test then creates its own order data and
 * proves that new rows, not only seed rows, move through the pipeline.
 */
describe('Full ERP demo flow (e2e, real DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const asCommercial = { 'x-role': 'commercial' };
  const asProduction = { 'x-role': 'production_lead' };
  let asWarehouse: Record<string, string> = { 'x-role': 'warehouse' };
  const asFinance = { 'x-role': 'finance' };
  const asDirector = { 'x-role': 'director' };
  const uniq = Date.now();
  let restoreSimulatedDevices: (() => Promise<void>) | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const FLAGS = {
    AUTH_DEV_XROLE: 'on',
    DEVICE_GATEWAY_SCALE: 'on',
    DEVICE_GATEWAY_PRINTER: 'on',
    GATEWAY_SIMULATOR: 'on',
    ONEC_LIVE: 'false',
    ONEC_WRITE: 'false',
  } as const;

  beforeAll(async () => {
    for (const [name, value] of Object.entries(FLAGS)) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }
    // Device adapter selection happens at module import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await restoreSimulatedDevices?.();
    await app.close();
    for (const name of Object.keys(FLAGS)) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('runs a new order through production, operator, warehouse, finance and diagnostics', async () => {
    const warehouseLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('warehouse'), password: e2eSeedPassword() })
      .expect(201);
    asWarehouse = { Authorization: `Bearer ${warehouseLogin.body.token as string}` };
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `Демо Контур ${uniq}`, inn: `77${uniq}`.slice(0, 12) })
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
      .send({ amount: 150000, note: 'Демо-счёт' })
      .expect(201);

    const financeBeforeProduction = await request(app.getHttpServer())
      .get('/api/finance/orders')
      .set(asFinance)
      .expect(200);
    const financeHandoff = financeBeforeProduction.body.find(
      (order: { commercialOrder?: { id: string } }) =>
        order.commercialOrder?.id === commercial.body.id,
    );
    expect(financeHandoff).toBeTruthy();

    const invoiced = await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeHandoff.id}/invoices`)
      .set(asFinance)
      .send({
        amount: 150000,
        label: 'Демо-счёт',
        paymentTermsType: 'prepay_50_postpay_50_30d',
      })
      .expect(201);
    expect(invoiced.body.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'invoice_prepayment', amount: 75000 }),
        expect.objectContaining({ kind: 'post_delivery', amount: 75000, dueDate: null }),
      ]),
    );
    const prepayment = invoiced.body.schedules.find(
      (schedule: { kind: string }) => schedule.kind === 'invoice_prepayment',
    );
    const invoiceDate = prepayment.dueDate.slice(0, 10) as string;

    const confirmed = await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeHandoff.id}/payment-schedules/${prepayment.id}/confirm`)
      .set(asFinance)
      .send({})
      .expect(201);
    expect(confirmed.body.paymentStatus).toBe('partial');

    const overview = await request(app.getHttpServer())
      .get(`/api/finance/overview?date=${invoiceDate}`)
      .set(asFinance)
      .expect(200);
    expect(overview.body.summary.installment).toBeGreaterThanOrEqual(1);
    // The calendar is global and may contain actions from other orders on the same date.
    // The order-scoped assertion is that this confirmed prepayment left the selected-day agenda.
    expect(overview.body.agenda).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: financeHandoff.id })]),
    );

    const commercialProjection = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${commercial.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(JSON.stringify(commercialProjection.body)).not.toContain('invoice_prepayment');
    await request(app.getHttpServer()).get('/api/finance/orders').set(asProduction).expect(403);
    await request(app.getHttpServer()).get('/api/finance/orders').set(asWarehouse).expect(403);

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
    const operatorToken = operatorLogin.body.token as string;
    const operatorId = operatorLogin.body.user.id as string;
    const asOperator = { Authorization: `Bearer ${operatorToken}` };

    const operatorShift = await createAssignedOperatorShiftFixture(prisma, {
      operatorId,
      postCode: 'POST-1',
      label: `Full demo operator shift ${uniq}`,
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
      code: `FULL-DEMO-BAG-${uniq}`,
    });
    await attachAvailableBagToOperatorShift(app, prisma, asOperator, 'POST-1', bigBagId);
    restoreSimulatedDevices = await enableSimulatedDevices(prisma, [
      'dev-scale-1',
      'dev-printer-1',
    ]);

    const runtime = await request(app.getHttpServer())
      .get('/api/operator/runtime')
      .set(asOperator)
      .expect(200);
    expect(JSON.stringify(runtime.body)).toContain(rollCode);
    expect(JSON.stringify(runtime.body)).not.toContain('legalName');
    expect(JSON.stringify(runtime.body)).not.toContain('post_delivery');
    await request(app.getHttpServer()).get('/api/finance/orders').set(asOperator).expect(403);

    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/accept`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/roll-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/qr-print`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const printEvidence = await prisma.rollScanToken.findUniqueOrThrow({
      where: { rollCode },
      select: { token: true },
    });
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/qr-verify`)
      .set(asOperator)
      .send({ operationKey: randomUUID(), payload: printEvidence.token })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/handover`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);

    const tasks = await request(app.getHttpServer())
      .get('/api/warehouse/tasks')
      .set(asWarehouse)
      .expect(200);
    const task = tasks.body.find((t: { rows: Array<{ rollCode: string }> }) =>
      t.rows.some((r) => r.rollCode === rollCode),
    );
    expect(task).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/api/warehouse/tasks/${task.id}/scans`)
      .set(asWarehouse)
      .send({ operationKey: randomUUID(), payload: printEvidence.token })
      .expect(201);
    await sealAndPrintCurrentPalletFixture(app, asWarehouse, task.id, {
      expectedRollCount: 1,
    });
    await request(app.getHttpServer())
      .post(`/api/warehouse/tasks/${task.id}/close`)
      .set(asWarehouse)
      .send({ mode: 'full' })
      .expect(201);

    const rolls = await request(app.getHttpServer())
      .get('/api/warehouse/rolls')
      .set(asWarehouse)
      .expect(200);
    expect(
      rolls.body.some(
        (r: { rollCode: string; warehouseStatus: string }) =>
          r.rollCode === rollCode && r.warehouseStatus === 'received',
      ),
    ).toBe(true);

    const deliveryTask = await prisma.warehouseAcceptanceTask.create({
      data: {
        mode: 'delivery',
        orderId: commercial.body.id,
        rows: {
          create: {
            rollCode,
            fromOrderId: commercial.body.orderNumber,
            scanStatus: 'expected',
          },
        },
      },
      include: { rows: true },
    });
    await request(app.getHttpServer())
      .post(`/api/warehouse/tasks/${deliveryTask.id}/scans`)
      .set(asWarehouse)
      .send({ operationKey: randomUUID(), payload: printEvidence.token })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/warehouse/tasks/${deliveryTask.id}/close`)
      .set(asWarehouse)
      .send({ mode: 'full' })
      .expect(201);

    const shippedCommercial = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: commercial.body.id },
    });
    expect(shippedCommercial.shipmentCompletedAt).toBeInstanceOf(Date);
    const expectedDueDate = addCalendarDays(
      moscowBusinessDate(shippedCommercial.shipmentCompletedAt!),
      30,
    );

    const scheduledAfterDelivery = await request(app.getHttpServer())
      .get(`/api/finance/orders/${financeHandoff.id}`)
      .set(asFinance)
      .expect(200);
    expect(scheduledAfterDelivery.body.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'post_delivery', dueDate: expect.any(String) }),
      ]),
    );
    const postDelivery = scheduledAfterDelivery.body.schedules.find(
      (schedule: { kind: string }) => schedule.kind === 'post_delivery',
    );
    expect(postDelivery.dueDate.slice(0, 10)).toBe(expectedDueDate);

    const overviewAfterDelivery = await request(app.getHttpServer())
      .get(`/api/finance/overview?date=${expectedDueDate}`)
      .set(asFinance)
      .expect(200);
    expect(overviewAfterDelivery.body.calendar).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: expectedDueDate, actionCount: expect.any(Number) }),
      ]),
    );
    expect(overviewAfterDelivery.body.agenda).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: financeHandoff.id })]),
    );

    const financeOrders = await request(app.getHttpServer())
      .get('/api/finance/orders')
      .set(asFinance)
      .expect(200);
    const financeOrder = financeOrders.body.find(
      (o: { commercialOrder?: { id: string } }) => o.commercialOrder?.id === commercial.body.id,
    );
    expect(financeOrder).toBeTruthy();

    const invoiceSnapshotsBefore = await prisma.sourceSnapshot.count({
      where: { financeOrderId: financeOrder.id, subjectType: 'invoice' },
    });
    await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrder.id}/source-retry`)
      .set(asFinance)
      .send({ operationKey: randomUUID() })
      .expect(404);
    await expect(
      prisma.sourceSnapshot.count({
        where: { financeOrderId: financeOrder.id, subjectType: 'invoice' },
      }),
    ).resolves.toBe(invoiceSnapshotsBefore);

    await request(app.getHttpServer()).get('/api/director/control').set(asDirector).expect(200);
    const directorFinance = await request(app.getHttpServer())
      .get(`/api/director/finance/${financeOrder.id}`)
      .set(asDirector)
      .expect(200);
    expect(directorFinance.body.schedules).toHaveLength(2);
  });
});
