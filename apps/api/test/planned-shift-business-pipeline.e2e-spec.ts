import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PRIMARY_BASE_MATERIAL_SELECTION } from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import {
  prepareReadyDefectBagFixture,
  registerAndSendBigBagToProduction,
} from './operator-shift-e2e-fixture';
import { enableSimulatedDevices } from './simulated-device-fixture';
import { selectAcceptedRowsIntoCurrentPalletFixture } from './warehouse-pallet-e2e-fixture';

type CreatedOrder = {
  id: string;
  orderNumber: string;
  positions: Array<{ id: string }>;
};

type CreatedProductionOrder = {
  id: string;
  commercialOrderId: string;
  dispatchItems: Array<{ id: string; rollCode: string }>;
};

const FORBIDDEN_BUSINESS_KEYS = new Set([
  'agentTokenHash',
  'parsedPayload',
  'payload',
  'qrCode',
  'rawPayload',
  'scanToken',
  'token',
]);

function expectBusinessProjectionSafe(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectBusinessProjectionSafe);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    expect(FORBIDDEN_BUSINESS_KEYS.has(key)).toBe(false);
    expectBusinessProjectionSafe(nested);
  }
}

describe('Planned-shift business pipeline (e2e, Bearer + PostgreSQL + simulator)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let restoreSimulatedDevices: (() => Promise<void>) | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const FLAGS = {
    AUTH_DEV_XROLE: 'off',
    DEVICE_GATEWAY_SCALE: 'on',
    DEVICE_GATEWAY_PRINTER: 'on',
    GATEWAY_SIMULATOR: 'on',
  } as const;

  const http = () => request(app.getHttpServer());

  async function bearerFor(login: string) {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login, password: e2eSeedPassword() })
      .expect(201);
    return { Authorization: `Bearer ${response.body.token as string}` };
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(FLAGS)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    // App configuration is evaluated during import; keep the development role bypass disabled.
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

    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl).toBeTruthy();
    expect(new URL(databaseUrl!).searchParams.get('schema')).toMatch(
      /^e2e_[1-9]\d*_[0-9a-f]{12}$/u,
    );
    restoreSimulatedDevices = await enableSimulatedDevices(prisma, [
      'dev-scale-5',
      'dev-printer-5',
    ]);
  });

  afterAll(async () => {
    await restoreSimulatedDevices?.();
    await app?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('runs one isolated AUDIT commercial-to-warehouse flow on planned POST-5', async () => {
    const auditRef = `AUDIT-${new Date().toISOString().replace(/\D/gu, '')}`;
    const businessBodies: unknown[] = [];
    const remember = (response: { body: unknown }) => {
      businessBodies.push(response.body);
      return response;
    };

    const [asCommercial, asProduction, asFinance, asWarehouse] = await Promise.all([
      bearerFor(e2eSeedLogin('commercial')),
      bearerFor(e2eSeedLogin('production')),
      bearerFor(e2eSeedLogin('finance')),
      bearerFor(e2eSeedLogin('warehouse')),
    ]);

    const passwordSource = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
      select: { passwordHash: true },
    });
    expect(passwordSource.passwordHash).toBeTruthy();
    const operatorSuffix = randomUUID().slice(0, 8);
    const operator = await prisma.user.create({
      data: {
        externalId: `e2e:${auditRef}:operator`,
        login: `audit-operator-${operatorSuffix}`,
        passwordHash: passwordSource.passwordHash,
        displayName: `${auditRef} operator`,
        role: 'operator',
      },
    });
    const isolationOperator = await prisma.user.create({
      data: {
        externalId: `e2e:${auditRef}:isolation-operator`,
        login: `audit-isolation-${operatorSuffix}`,
        passwordHash: passwordSource.passwordHash,
        displayName: `${auditRef} isolation operator`,
        role: 'operator',
      },
    });

    // Commercial create: one request id produces one order and one immutable recipe fact.
    const counterpartyResponse = remember(
      await http()
        .post('/api/commercial/counterparties')
        .set(asCommercial)
        .send({
          displayName: `${auditRef} counterparty`,
          inn: auditRef.replace(/\D/gu, '').slice(-12),
        })
        .expect(201),
    );
    const counterparty = counterpartyResponse.body as { id: string };
    const orderPayload = {
      clientRequestId: randomUUID(),
      title: `${auditRef} planned simulator order`,
      orderNumber: auditRef,
      mode: 'submit',
      counterpartyId: counterparty.id,
      requestType: 'client_order',
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          ...PRIMARY_BASE_MATERIAL_SELECTION,
          spoolType: 'втулка 76',
          plannedWeightKg: 41.4,
          widthMm: 1700,
          plannedLengthM: 275,
          recipeParameters: [
            { label: 'Сырьё', value: 'ПВД 15803-020' },
            { label: 'План. вес, кг', value: '41.4' },
          ],
        },
      ],
    } as const;
    const createdOrderResponse = remember(
      await http().post('/api/commercial/orders').set(asCommercial).send(orderPayload).expect(201),
    );
    const createdOrder = createdOrderResponse.body as CreatedOrder;
    const replayedOrderResponse = remember(
      await http().post('/api/commercial/orders').set(asCommercial).send(orderPayload).expect(201),
    );
    expect(replayedOrderResponse.body).toEqual(
      expect.objectContaining({ id: createdOrder.id, orderNumber: auditRef }),
    );
    await expect(
      prisma.domainEvent.count({
        where: { objectId: createdOrder.id, type: 'audit:commercial_recipe_snapshot_set' },
      }),
    ).resolves.toBe(1);

    // Explicit cover calculation and commercial confirmation through contour APIs.
    const firstCoverRequest = remember(
      await http()
        .post(`/api/commercial/orders/${createdOrder.id}/warehouse-cover/recheck`)
        .set(asCommercial)
        .send({})
        .expect(201),
    );
    const replayedCoverRequest = remember(
      await http()
        .post(`/api/commercial/orders/${createdOrder.id}/warehouse-cover/recheck`)
        .set(asCommercial)
        .send({})
        .expect(201),
    );
    expect(replayedCoverRequest.body).toEqual(
      expect.objectContaining({
        case: expect.objectContaining({
          id: (firstCoverRequest.body as { case: { id: string } }).case.id,
        }),
      }),
    );
    const proposalResponse = remember(
      await http()
        .post(`/api/warehouse/orders/${createdOrder.id}/cover-proposals`)
        .set(asWarehouse)
        .send({
          positionId: createdOrder.positions[0]!.id,
          rollIds: [],
          comment: `${auditRef} production-only calculation`,
        })
        .expect(201),
    );
    const proposal = proposalResponse.body as { id: string; version: number };
    const coverConfirmation = remember(
      await http()
        .post(
          `/api/commercial/orders/${createdOrder.id}/positions/` +
            `${createdOrder.positions[0]!.id}/warehouse-cover/${proposal.id}/commercial-approval`,
        )
        .set(asCommercial)
        .send({ expectedVersion: proposal.version, route: 'production_only' })
        .expect(201),
    );
    expect(coverConfirmation.body).toEqual(expect.objectContaining({ route: 'production_only' }));
    await expect(
      prisma.domainEvent.count({
        where: { objectId: createdOrder.id, type: 'audit:warehouse_cover_recheck_requested' },
      }),
    ).resolves.toBe(1);

    // Finance 50/50 invoice and repeat-safe prepayment confirmation produce one payment fact.
    const invoiceHandoffPayload = {
      amount: 100_000,
      note: `${auditRef} simulator invoice`,
    };
    const invoiceHandoff = remember(
      await http()
        .post(`/api/commercial/orders/${createdOrder.id}/invoice-handoff`)
        .set(asCommercial)
        .send(invoiceHandoffPayload)
        .expect(201),
    );
    const invoiceHandoffReplay = remember(
      await http()
        .post(`/api/commercial/orders/${createdOrder.id}/invoice-handoff`)
        .set(asCommercial)
        .send(invoiceHandoffPayload)
        .expect(201),
    );
    expect(invoiceHandoffReplay.body).toEqual(
      expect.objectContaining({ id: (invoiceHandoff.body as { id: string }).id }),
    );
    const financeOrdersResponse = remember(
      await http().get('/api/finance/orders').set(asFinance).expect(200),
    );
    const financeOrder = (
      financeOrdersResponse.body as Array<{
        id: string;
        commercialOrder?: { id: string };
      }>
    ).find((candidate) => candidate.commercialOrder?.id === createdOrder.id);
    expect(financeOrder).toBeTruthy();
    const invoice = remember(
      await http()
        .post(`/api/finance/orders/${financeOrder!.id}/invoices`)
        .set(asFinance)
        .send({ amount: 100_000, paymentTermsType: 'prepay_50_postpay_50_30d' })
        .expect(201),
    );
    const invoiceProjection = invoice.body as {
      invoiceStatus: string;
      paymentTermsType: string;
      schedules: Array<{ id: string; kind: string; amount: number; status: string }>;
    };
    expect(invoiceProjection).toEqual(
      expect.objectContaining({
        invoiceStatus: 'invoiced',
        paymentTermsType: 'prepay_50_postpay_50_30d',
      }),
    );
    expect(invoiceProjection.schedules).toHaveLength(2);
    expect(invoiceProjection.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'invoice_prepayment', amount: 50_000, status: 'unpaid' }),
        expect.objectContaining({ kind: 'post_delivery', amount: 50_000, status: 'unpaid' }),
      ]),
    );
    const prepayment = invoiceProjection.schedules.find(
      (schedule) => schedule.kind === 'invoice_prepayment',
    );
    expect(prepayment).toEqual(expect.objectContaining({ amount: 50_000, status: 'unpaid' }));
    const confirmedPrepayment = remember(
      await http()
        .post(`/api/finance/orders/${financeOrder!.id}/payment-schedules/${prepayment!.id}/confirm`)
        .set(asFinance)
        .send({})
        .expect(201),
    );
    const confirmedPrepaymentReplay = remember(
      await http()
        .post(`/api/finance/orders/${financeOrder!.id}/payment-schedules/${prepayment!.id}/confirm`)
        .set(asFinance)
        .send({})
        .expect(201),
    );
    expect(confirmedPrepayment.body).toEqual(expect.objectContaining({ paymentStatus: 'partial' }));
    expect(confirmedPrepaymentReplay.body).toEqual(
      expect.objectContaining({ paymentStatus: 'partial' }),
    );
    await expect(
      prisma.paymentOperation.count({ where: { financeOrderId: financeOrder!.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: financeOrder!.id, type: 'audit:payment_schedule_item_confirmed' },
      }),
    ).resolves.toBe(1);

    // Production handoff is replay-safe and publishes one roll.
    const productionResponse = remember(
      await http()
        .post(`/api/commercial/orders/${createdOrder.id}/send-to-production`)
        .set(asCommercial)
        .send({})
        .expect(201),
    );
    const production = productionResponse.body as CreatedProductionOrder;
    const productionReplay = remember(
      await http()
        .post(`/api/commercial/orders/${createdOrder.id}/send-to-production`)
        .set(asCommercial)
        .send({})
        .expect(201),
    );
    expect(productionReplay.body).toEqual(
      expect.objectContaining({ id: production.id, commercialOrderId: createdOrder.id }),
    );
    expect(production.dispatchItems).toHaveLength(1);
    const rollCode = production.dispatchItems[0]!.rollCode;
    await expect(
      prisma.domainEvent.count({
        where: { objectId: production.id, type: 'audit:production_order_created' },
      }),
    ).resolves.toBe(1);

    // Prepare both BigBags through warehouse APIs before the planned shift starts.
    const mainBagResponse = remember(
      await http()
        .post('/api/warehouse/big-bags')
        .set(asWarehouse)
        .send({
          materialId: 'rm-pvd-15803',
          weightKg: 100,
          code: `BB-${auditRef}-MAIN`,
        })
        .expect(201),
    );
    const mainBag = mainBagResponse.body as { id: string; initialKg: number; status: string };
    expect(mainBag).toEqual(expect.objectContaining({ initialKg: 100, status: 'available' }));
    const isolationBagResponse = remember(
      await http()
        .post('/api/warehouse/big-bags')
        .set(asWarehouse)
        .send({
          materialId: 'rm-pvd-15803',
          weightKg: 10,
          code: `BB-${auditRef}-ISOLATION`,
        })
        .expect(201),
    );
    const isolationBag = isolationBagResponse.body as { id: string };
    await registerAndSendBigBagToProduction(app, prisma, asWarehouse, mainBag.id);
    await registerAndSendBigBagToProduction(app, prisma, asWarehouse, isolationBag.id);

    const postsResponse = remember(
      await http().get('/api/production/posts').set(asProduction).expect(200),
    );
    const posts = postsResponse.body as Array<{ id: string; code: string; status: string }>;
    const post5 = posts.find((post) => post.code === 'POST-5');
    const post4 = posts.find((post) => post.code === 'POST-4');
    expect(post5).toEqual(expect.objectContaining({ status: 'active' }));
    expect(post4).toEqual(expect.objectContaining({ status: 'active' }));

    const plannedStartAt = new Date(Date.now() + 20_000);
    const shiftResponse = remember(
      await http()
        .post('/api/production/shifts')
        .set(asProduction)
        .send({
          label: `${auditRef} planned shift`,
          plannedStartAt: plannedStartAt.toISOString(),
          plannedEndAt: new Date(plannedStartAt.getTime() + 60 * 60_000).toISOString(),
        })
        .expect(201),
    );
    const shift = shiftResponse.body as { id: string; status: string; startedAt: string | null };
    expect(shift).toEqual(expect.objectContaining({ status: 'planned', startedAt: null }));
    const mainMachineAssignment = remember(
      await http()
        .put(`/api/production/shifts/${shift.id}/operators/${operator.id}/machine`)
        .set(asProduction)
        .send({ postId: post5!.id })
        .expect(200),
    );
    expect(mainMachineAssignment.body).toEqual(
      expect.objectContaining({ operatorId: operator.id, postId: post5!.id, status: 'planned' }),
    );
    const isolationMachineAssignment = remember(
      await http()
        .put(`/api/production/shifts/${shift.id}/operators/${isolationOperator.id}/machine`)
        .set(asProduction)
        .send({ postId: post4!.id })
        .expect(200),
    );
    expect(isolationMachineAssignment.body).toEqual(
      expect.objectContaining({
        operatorId: isolationOperator.id,
        postId: post4!.id,
        status: 'planned',
      }),
    );
    const rollAssignmentPayload = {
      operatorId: operator.id,
    };
    const assignedRoll = remember(
      await http()
        .post(`/api/production/roll-dispatch/${rollCode}/assign`)
        .set(asProduction)
        .send(rollAssignmentPayload)
        .expect(201),
    );
    const assignedRollReplay = remember(
      await http()
        .post(`/api/production/roll-dispatch/${rollCode}/assign`)
        .set(asProduction)
        .send(rollAssignmentPayload)
        .expect(201),
    );
    expect(assignedRollReplay.body).toEqual(
      expect.objectContaining({ id: (assignedRoll.body as { id: string }).id }),
    );
    await expect(
      prisma.domainEvent.count({
        where: { objectId: rollCode, type: 'audit:roll_dispatch_assigned' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.productionOrder.findUniqueOrThrow({
        where: { id: production.id },
        select: { approvalState: true },
      }),
    ).resolves.toEqual({ approvalState: 'approved' });
    await expect(
      prisma.operatorRollLine.count({
        where: { rollDispatchItem: { rollCode } },
      }),
    ).resolves.toBe(1);
    const approvedProduction = remember(
      await http()
        .post(`/api/production/orders/${production.id}/approve`)
        .set(asProduction)
        .send({})
        .expect(201),
    );
    expect(approvedProduction.body).toEqual(expect.objectContaining({ approvalState: 'approved' }));

    // Login is identity-only: planned topology and post sessions remain byte-for-byte unchanged.
    const topologyBeforeLogin = await Promise.all([
      prisma.shift.findUniqueOrThrow({
        where: { id: shift.id },
        select: { status: true, startedAt: true, endedAt: true },
      }),
      prisma.operatorShiftMachineAssignment.findMany({
        where: { shiftId: shift.id },
        select: { operatorId: true, status: true, lockedAt: true },
        orderBy: { operatorId: 'asc' },
      }),
      prisma.operatorPostSession.count({
        where: { operatorId: { in: [operator.id, isolationOperator.id] } },
      }),
    ]);
    const [asOperator, asIsolationOperator] = await Promise.all([
      bearerFor(operator.login),
      bearerFor(isolationOperator.login),
    ]);
    const topologyAfterLogin = await Promise.all([
      prisma.shift.findUniqueOrThrow({
        where: { id: shift.id },
        select: { status: true, startedAt: true, endedAt: true },
      }),
      prisma.operatorShiftMachineAssignment.findMany({
        where: { shiftId: shift.id },
        select: { operatorId: true, status: true, lockedAt: true },
        orderBy: { operatorId: 'asc' },
      }),
      prisma.operatorPostSession.count({
        where: { operatorId: { in: [operator.id, isolationOperator.id] } },
      }),
    ]);
    expect(topologyAfterLogin).toEqual(topologyBeforeLogin);
    expect(topologyAfterLogin[0]).toEqual({ status: 'planned', startedAt: null, endedAt: null });
    expect(topologyAfterLogin[1]).toEqual(
      expect.arrayContaining([
        { operatorId: operator.id, status: 'planned', lockedAt: null },
        { operatorId: isolationOperator.id, status: 'planned', lockedAt: null },
      ]),
    );
    expect(topologyAfterLogin[2]).toBe(0);
    const currentBeforeStart = remember(
      await http().get('/api/operator/post-sessions/current').set(asOperator).expect(200),
    );
    expect(currentBeforeStart.body).toEqual({});

    const loginTopologyVerifiedAt = Date.now();
    expect(loginTopologyVerifiedAt).toBeLessThan(plannedStartAt.getTime());
    const waitMs = plannedStartAt.getTime() - loginTopologyVerifiedAt + 50;
    expect(waitMs).toBeGreaterThan(50);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    expect(Date.now()).toBeGreaterThanOrEqual(plannedStartAt.getTime());

    // Explicit post-session open is retry-safe; the bag gate remains separate and explicit.
    const openedSession = remember(
      await http()
        .post('/api/operator/post-sessions')
        .set(asOperator)
        .send({ postCode: 'POST-5' })
        .expect(201),
    );
    const openedSessionReplay = remember(
      await http()
        .post('/api/operator/post-sessions')
        .set(asOperator)
        .send({ postCode: 'POST-5' })
        .expect(201),
    );
    const mainSessionId = (openedSession.body as { id: string }).id;
    expect(openedSessionReplay.body).toEqual(expect.objectContaining({ id: mainSessionId }));
    await expect(
      prisma.operatorPostSession.count({ where: { operatorId: operator.id, status: 'active' } }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { actorId: operator.id, type: 'audit:operator_post_session_opened' },
      }),
    ).resolves.toBe(1);
    const mainShiftOpen = remember(
      await http()
        .post('/api/operator/shift/open')
        .set(asOperator)
        .send({ postCode: 'POST-5', bigBagId: mainBag.id, startKg: 100 })
        .expect(201),
    );
    expect(mainShiftOpen.body).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ id: mainSessionId, status: 'active' }),
        usage: expect.objectContaining({ bigBagId: mainBag.id, startKg: 100 }),
      }),
    );

    // A second real operator gets a valid POST-4 shift but cannot see or mutate the POST-5 roll.
    const isolationShiftOpen = remember(
      await http()
        .post('/api/operator/shift/open')
        .set(asIsolationOperator)
        .send({ postCode: 'POST-4', bigBagId: isolationBag.id, startKg: 10 })
        .expect(201),
    );
    expect(isolationShiftOpen.body).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ operatorId: isolationOperator.id, status: 'active' }),
      }),
    );
    const isolatedQueue = remember(
      await http().get('/api/operator/rolls').set(asIsolationOperator).expect(200),
    );
    expect(
      (isolatedQueue.body as Array<{ rollCode: string }>).some(
        (candidate) => candidate.rollCode === rollCode,
      ),
    ).toBe(false);
    const forbiddenOperationKey = randomUUID();
    const foreignMutation = await http()
      .post(`/api/operator/rolls/${rollCode}/accept`)
      .set(asIsolationOperator)
      .send({ operationKey: forbiddenOperationKey })
      .expect(404);
    expect(foreignMutation.body).toEqual(
      expect.objectContaining({ code: 'OPERATOR_ROLL_NOT_FOUND' }),
    );
    await expect(
      prisma.operatorRollOperation.count({ where: { operationKey: forbiddenOperationKey } }),
    ).resolves.toBe(0);
    await expect(
      prisma.operatorRollLine.findFirstOrThrow({
        where: { rollDispatchItem: { rollCode } },
        select: { step: true },
      }),
    ).resolves.toEqual({ step: 'assigned' });
    await prepareReadyDefectBagFixture(prisma, isolationOperator.id);
    const isolationClosed = remember(
      await http()
        .post('/api/operator/shift/close')
        .set(asIsolationOperator)
        .send({ operationKey: randomUUID(), bags: [{ bigBagId: isolationBag.id, endKg: 10 }] })
        .expect(200),
    );
    expect(isolationClosed.body).toEqual(
      expect.objectContaining({
        balance: expect.objectContaining({
          producedKg: 0,
          expectedUsageKg: 0,
          actualUsageKg: 0,
          status: 'ok',
        }),
        problemId: null,
      }),
    );

    // Every physical operation is performed by the POST-5 simulator and retried exactly.
    const acceptKey = randomUUID();
    const accepted = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/accept`)
        .set(asOperator)
        .send({ operationKey: acceptKey })
        .expect(201),
    );
    const acceptedReplay = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/accept`)
        .set(asOperator)
        .send({ operationKey: acceptKey })
        .expect(201),
    );
    expect(accepted.body).toEqual(expect.objectContaining({ step: 'spool_weight' }));
    expect(acceptedReplay.body).toEqual(expect.objectContaining({ step: 'spool_weight' }));

    const spoolKey = randomUUID();
    const spool = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/spool-weight`)
        .set(asOperator)
        .send({ operationKey: spoolKey })
        .expect(201),
    );
    const spoolReplay = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/spool-weight`)
        .set(asOperator)
        .send({ operationKey: spoolKey })
        .expect(201),
    );
    expect(spool.body).toEqual(expect.objectContaining({ spoolKg: 2, step: 'roll_weight' }));
    expect(spoolReplay.body).toEqual(expect.objectContaining({ spoolKg: 2, step: 'roll_weight' }));

    const rollWeightKey = randomUUID();
    const rollWeight = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/roll-weight`)
        .set(asOperator)
        .send({ operationKey: rollWeightKey })
        .expect(201),
    );
    const rollWeightReplay = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/roll-weight`)
        .set(asOperator)
        .send({ operationKey: rollWeightKey })
        .expect(201),
    );
    expect(rollWeight.body).toEqual(
      expect.objectContaining({ spoolKg: 2, netKg: 41.4, step: 'qr_print' }),
    );
    expect(rollWeightReplay.body).toEqual(
      expect.objectContaining({ spoolKg: 2, netKg: 41.4, step: 'qr_print' }),
    );
    await expect(
      prisma.weightCapture.findMany({
        where: { line: { rollDispatchItem: { rollCode } }, stable: true },
        select: { kind: true, grossKg: true, spoolKg: true, netKg: true },
        orderBy: { createdAt: 'asc' },
      }),
    ).resolves.toEqual([
      { kind: 'spool', grossKg: 2, spoolKg: 2, netKg: null },
      { kind: 'roll', grossKg: 43.4, spoolKg: 2, netKg: 41.4 },
    ]);

    const printKey = randomUUID();
    const printed = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/qr-print`)
        .set(asOperator)
        .send({ operationKey: printKey })
        .expect(201),
    );
    const printedReplay = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/qr-print`)
        .set(asOperator)
        .send({ operationKey: printKey })
        .expect(201),
    );
    expect(printed.body).toEqual(expect.objectContaining({ step: 'qr_check' }));
    expect(printedReplay.body).toEqual(expect.objectContaining({ step: 'qr_check' }));

    // The opaque QR value exists only in this isolated process and is passed straight back.
    const qrPayload = (
      await prisma.rollScanToken.findUniqueOrThrow({
        where: { rollCode },
        select: { token: true },
      })
    ).token;
    const verifyKey = randomUUID();
    const verified = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/qr-verify`)
        .set(asOperator)
        .send({ operationKey: verifyKey, payload: qrPayload })
        .expect(201),
    );
    const verifiedReplay = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/qr-verify`)
        .set(asOperator)
        .send({ operationKey: verifyKey, payload: qrPayload })
        .expect(201),
    );
    expect(verified.body).toEqual(
      expect.objectContaining({ step: 'handover', labelState: 'verified' }),
    );
    expect(verifiedReplay.body).toEqual(
      expect.objectContaining({ step: 'handover', labelState: 'verified' }),
    );

    const handoverKey = randomUUID();
    const handover = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/handover`)
        .set(asOperator)
        .send({ operationKey: handoverKey })
        .expect(201),
    );
    const handoverReplay = remember(
      await http()
        .post(`/api/operator/rolls/${rollCode}/handover`)
        .set(asOperator)
        .send({ operationKey: handoverKey })
        .expect(201),
    );
    const intakeTaskId = (handover.body as { id: string }).id;
    expect(handoverReplay.body).toEqual(expect.objectContaining({ id: intakeTaskId }));

    const operatorOperationKeys = [
      acceptKey,
      spoolKey,
      rollWeightKey,
      printKey,
      verifyKey,
      handoverKey,
    ];
    await expect(
      prisma.operatorRollOperation.count({
        where: { operationKey: { in: operatorOperationKeys } },
      }),
    ).resolves.toBe(operatorOperationKeys.length);
    await expect(
      Promise.all([
        prisma.domainEvent.count({
          where: { objectId: rollCode, type: 'audit:operator_roll_accepted' },
        }),
        prisma.domainEvent.count({
          where: { objectId: rollCode, type: 'audit:operator_weight_captured' },
        }),
        prisma.domainEvent.count({
          where: { objectId: rollCode, type: 'audit:operator_label_print_requested' },
        }),
        prisma.domainEvent.count({
          where: { objectId: rollCode, type: 'audit:operator_label_print_submitted' },
        }),
        prisma.domainEvent.count({
          where: { objectId: rollCode, type: 'audit:operator_qr_verified' },
        }),
        prisma.domainEvent.count({
          where: {
            type: 'audit:operator_roll_handed_over',
            detail: { path: ['rollId'], equals: rollCode },
          },
        }),
      ]),
    ).resolves.toEqual([1, 2, 1, 1, 1, 1]);
    await expect(
      prisma.labelPrintJob.count({
        where: { line: { rollDispatchItem: { rollCode } } },
      }),
    ).resolves.toBe(1);

    // Warehouse uses its own full browser session; machine posts remain operator-only.
    const intakeBeforeScan = remember(
      await http().get('/api/warehouse/intake').set(asWarehouse).expect(200),
    );
    expect(
      (intakeBeforeScan.body as { tasks: Array<{ taskId: string; rolls: unknown[] }> }).tasks.find(
        (candidate) => candidate.taskId === intakeTaskId,
      ),
    ).toEqual(expect.objectContaining({ rolls: [expect.objectContaining({ rollCode })] }));

    const warehouseScanKey = randomUUID();
    const warehouseScan = remember(
      await http()
        .post('/api/warehouse/intake/scans')
        .set(asWarehouse)
        .send({ operationKey: warehouseScanKey, payload: qrPayload })
        .expect(201),
    );
    const warehouseScanReplay = remember(
      await http()
        .post('/api/warehouse/intake/scans')
        .set(asWarehouse)
        .send({ operationKey: warehouseScanKey, payload: qrPayload })
        .expect(201),
    );
    expect(warehouseScan.body).toEqual(
      expect.objectContaining({
        taskId: intakeTaskId,
        rollCode,
        scanStatus: 'accepted',
        replayed: false,
      }),
    );
    expect(warehouseScanReplay.body).toEqual(
      expect.objectContaining({
        operationId: (warehouseScan.body as { operationId: string }).operationId,
        taskId: intakeTaskId,
        rollCode,
        replayed: true,
      }),
    );
    await expect(
      prisma.warehouseOperation.count({ where: { operationKey: warehouseScanKey } }),
    ).resolves.toBe(1);
    await expect(
      prisma.scanRow.count({ where: { taskId: intakeTaskId, rollCode, scanStatus: 'accepted' } }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: rollCode, type: 'audit:warehouse_roll_received' },
      }),
    ).resolves.toBe(1);
    await selectAcceptedRowsIntoCurrentPalletFixture(app, asWarehouse, intakeTaskId);
    const warehousePrinters = remember(
      await http().get('/api/warehouse/printers').set(asWarehouse).expect(200),
    );
    const readyPrinter = (
      warehousePrinters.body as Array<{
        id: string;
        ready: boolean;
        post: { code: string };
      }>
    ).find((printer) => printer.ready && printer.post.code === 'POST-5');
    expect(readyPrinter).toBeDefined();
    const closePalletRequestId = randomUUID();
    const sealedPallet = remember(
      await http()
        .post(`/api/warehouse/intake/${intakeTaskId}/pallets/current/close-and-print`)
        .set(asWarehouse)
        .send({ printerId: readyPrinter!.id, requestId: closePalletRequestId })
        .expect(200),
    );
    const sealedPalletReplay = remember(
      await http()
        .post(`/api/warehouse/intake/${intakeTaskId}/pallets/current/close-and-print`)
        .set(asWarehouse)
        .send({ printerId: readyPrinter!.id, requestId: closePalletRequestId })
        .expect(200),
    );
    expect(sealedPallet.body).toEqual(
      expect.objectContaining({
        pallet: expect.objectContaining({ status: 'sealed', rollCount: 1 }),
        printJob: expect.objectContaining({
          requestId: closePalletRequestId,
          printerId: readyPrinter!.id,
          status: 'submitted',
        }),
      }),
    );
    expect(sealedPalletReplay.body).toEqual(sealedPallet.body);
    const warehouseClosed = remember(
      await http()
        .post(`/api/warehouse/tasks/${intakeTaskId}/close`)
        .set(asWarehouse)
        .send({ mode: 'full' })
        .expect(201),
    );
    const warehouseClosedReplay = remember(
      await http()
        .post(`/api/warehouse/tasks/${intakeTaskId}/close`)
        .set(asWarehouse)
        .send({ mode: 'full' })
        .expect(201),
    );
    expect(warehouseClosed.body).toEqual(
      expect.objectContaining({ id: intakeTaskId, status: 'closed' }),
    );
    expect(warehouseClosedReplay.body).toEqual(warehouseClosed.body);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: intakeTaskId, type: 'audit:warehouse_acceptance_task_closed' },
      }),
    ).resolves.toBe(1);
    const finalCommercialOrder = remember(
      await http().get(`/api/commercial/orders/${createdOrder.id}`).set(asCommercial).expect(200),
    );
    expect(finalCommercialOrder.body).toEqual(
      expect.objectContaining({
        commercialCompletion: expect.objectContaining({ state: 'ready_for_shipment' }),
        indicators: expect.objectContaining({ shipment: 'not_shipped' }),
      }),
    );
    const warehouseRolls = remember(
      await http().get('/api/warehouse/rolls').set(asWarehouse).expect(200),
    );
    expect(
      (warehouseRolls.body as Array<{ rollCode: string; warehouseStatus: string }>).filter(
        (candidate) => candidate.rollCode === rollCode && candidate.warehouseStatus === 'received',
      ),
    ).toHaveLength(1);

    // One-to-one material accounting: 100.0 - 41.4 = 58.6 and no mismatch problem.
    await prepareReadyDefectBagFixture(prisma, operator.id);
    const closedShift = remember(
      await http()
        .post('/api/operator/shift/close')
        .set(asOperator)
        .send({ operationKey: randomUUID(), bags: [{ bigBagId: mainBag.id, endKg: 58.6 }] })
        .expect(200),
    );
    expect(closedShift.body).toEqual(
      expect.objectContaining({
        balance: {
          producedKg: 41.4,
          defectKg: 0,
          expectedUsageKg: 41.4,
          actualUsageKg: 41.4,
          deviationPercent: 0,
          status: 'ok',
        },
        problemId: null,
      }),
    );

    await expect(
      prisma.shift.findUniqueOrThrow({
        where: { id: shift.id },
        select: { status: true, startedAt: true, endedAt: true },
      }),
    ).resolves.toEqual({
      status: 'closed',
      startedAt: expect.any(Date),
      endedAt: expect.any(Date),
    });
    await expect(
      prisma.operatorShiftMachineAssignment.findMany({
        where: { shiftId: shift.id },
        select: { operatorId: true, status: true },
        orderBy: { operatorId: 'asc' },
      }),
    ).resolves.toEqual(
      [operator.id, isolationOperator.id]
        .sort()
        .map((operatorId) => ({ operatorId, status: 'completed' })),
    );
    await expect(
      prisma.operatorPostSession.count({
        where: { operatorId: { in: [operator.id, isolationOperator.id] }, status: 'active' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.operatorPostSession.findUniqueOrThrow({
        where: { id: mainSessionId },
        select: { status: true, endedAt: true, shiftId: true, postId: true },
      }),
    ).resolves.toEqual({
      status: 'closed',
      endedAt: expect.any(Date),
      shiftId: shift.id,
      postId: post5!.id,
    });
    await expect(
      prisma.shiftBagUsage.findFirstOrThrow({
        where: { sessionId: mainSessionId, bigBagId: mainBag.id },
        select: { startKg: true, endKg: true, closedAt: true },
      }),
    ).resolves.toEqual({ startKg: 100, endKg: 58.6, closedAt: expect.any(Date) });
    await expect(
      prisma.bigBagUnit.findUniqueOrThrow({
        where: { id: mainBag.id },
        select: { initialKg: true, currentKg: true, lastMeasuredKg: true, status: true },
      }),
    ).resolves.toEqual({
      initialKg: 100,
      currentKg: 58.6,
      lastMeasuredKg: 58.6,
      status: 'available',
    });
    await expect(
      prisma.warehouseRoll.count({ where: { rollCode, warehouseStatus: 'received' } }),
    ).resolves.toBe(1);
    await expect(
      prisma.productionProblem.count({
        where: { orderId: createdOrder.id, type: 'shift_balance_mismatch' },
      }),
    ).resolves.toBe(0);

    for (const body of businessBodies) {
      expect(JSON.stringify(body).includes(qrPayload)).toBe(false);
      expectBusinessProjectionSafe(body);
    }
  });
});
