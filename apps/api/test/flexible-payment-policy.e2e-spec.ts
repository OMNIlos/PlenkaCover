import { randomBytes, randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { hashPassword } from '../src/common/auth/password';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { DeferredPaymentService } from '../src/modules/finance/deferred-payment.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';

const paymentPolicy = {
  installmentDays: 30,
  stages: [
    {
      sequence: 1,
      trigger: 'invoice_issued',
      percentageBasisPoints: 2000,
      offsetDays: 0,
    },
    {
      sequence: 2,
      trigger: 'full_shipment',
      percentageBasisPoints: 3000,
      offsetDays: 0,
    },
    {
      sequence: 3,
      trigger: 'full_shipment',
      percentageBasisPoints: 2500,
      offsetDays: 15,
    },
    {
      sequence: 4,
      trigger: 'full_shipment',
      percentageBasisPoints: 2500,
      offsetDays: 30,
    },
  ],
} as const;

type Fixture = {
  counterpartyId: string;
  commercialOrderId: string;
  financeOrderId: string;
  productionOrderId: string;
  orderNumber: string;
};

type AuthSession = {
  token: string;
  userId: string;
};

type ScheduleView = {
  id: string;
  sequence: number;
  amount: number;
  kind: string;
  dueDate: string | null;
  dateKind: string;
  status: string;
};

describe('Flexible payment policy (e2e)', () => {
  jest.setTimeout(60_000);

  let app!: INestApplication;
  let prisma!: PrismaService;
  let deferredPayment: DeferredPaymentService;
  const suffix = randomUUID();
  const password = randomBytes(18).toString('base64url');
  const frozenNow = new Date('2026-07-20T10:00:00.000Z');
  const fixture: Fixture = {
    counterpartyId: `e2e-flex-payment-counterparty-${suffix}`,
    commercialOrderId: `e2e-flex-payment-commercial-${suffix}`,
    financeOrderId: `e2e-flex-payment-finance-${suffix}`,
    productionOrderId: `e2e-flex-payment-production-${suffix}`,
    orderNumber: `E2E-FLEX-${suffix}`,
  };
  const actors = {
    finance: {
      id: `e2e-flex-payment-finance-user-${suffix}`,
      login: `e2e-flex-payment-finance-${suffix}@test.local`,
      role: Role.finance,
    },
    commercial: {
      id: `e2e-flex-payment-commercial-user-${suffix}`,
      login: `e2e-flex-payment-commercial-${suffix}@test.local`,
      role: Role.commercial,
    },
    production: {
      id: `e2e-flex-payment-production-user-${suffix}`,
      login: `e2e-flex-payment-production-${suffix}@test.local`,
      role: Role.production_lead,
    },
  } as const;
  const actorIds = Object.values(actors).map((actor) => actor.id);
  const userAgent = `flexible-payment-policy-e2e/${randomUUID()}`;
  const previous = {
    APP_ENV: process.env.APP_ENV,
    AUTH_DEV_XROLE: process.env.AUTH_DEV_XROLE,
    GATEWAY_SIMULATOR: process.env.GATEWAY_SIMULATOR,
    ONEC_LIVE: process.env.ONEC_LIVE,
    ONEC_WRITE: process.env.ONEC_WRITE,
  };

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(frozenNow);
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_XROLE = 'on';
    process.env.GATEWAY_SIMULATOR = 'off';
    process.env.ONEC_LIVE = 'false';
    process.env.ONEC_WRITE = 'false';
    // Load runtime configuration only after the test profile has been selected.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
    prisma = app.get(PrismaService);
    deferredPayment = app.get(DeferredPaymentService);

    await prisma.user.createMany({
      data: Object.values(actors).map((actor) => ({
        id: actor.id,
        externalId: actor.id,
        login: actor.login,
        passwordHash: hashPassword(password),
        displayName: `Flexible payment ${actor.role}`,
        role: actor.role,
      })),
    });
    await prisma.counterparty.create({
      data: {
        id: fixture.counterpartyId,
        displayName: `Flexible payment buyer ${suffix}`,
        externalId: fixture.counterpartyId,
      },
    });
    await prisma.commercialOrder.create({
      data: {
        id: fixture.commercialOrderId,
        orderNumber: fixture.orderNumber,
        title: 'Flexible payment policy e2e fixture',
        creatorRole: 'commercial',
        counterpartyId: fixture.counterpartyId,
        commercialStage: 'sent_to_finance',
        sentToFinanceAt: new Date('2026-07-20T09:00:00.000Z'),
        createdAt: new Date('2026-07-20T08:00:00.000Z'),
      },
    });
    await prisma.financeOrder.create({
      data: { id: fixture.financeOrderId, commercialOrderId: fixture.commercialOrderId },
    });
    await prisma.productionOrder.create({
      data: { id: fixture.productionOrderId, commercialOrderId: fixture.commercialOrderId },
    });
  });

  afterAll(async () => {
    await runE2eWithCleanup(async () => {
      if (prisma) {
        // Immutable events and their actor users remain for isolated-schema teardown.
        await prisma.$transaction([
          prisma.paymentOperation.deleteMany({
            where: { financeOrderId: fixture.financeOrderId },
          }),
          prisma.paymentSchedule.deleteMany({
            where: { financeOrderId: fixture.financeOrderId },
          }),
          prisma.paymentPolicyStage.deleteMany({
            where: { paymentPolicy: { financeOrderId: fixture.financeOrderId } },
          }),
          prisma.paymentPolicy.deleteMany({
            where: { financeOrderId: fixture.financeOrderId },
          }),
          prisma.financeOrder.deleteMany({ where: { id: fixture.financeOrderId } }),
          prisma.productionOrder.deleteMany({ where: { id: fixture.productionOrderId } }),
          prisma.commercialOrder.deleteMany({ where: { id: fixture.commercialOrderId } }),
          prisma.counterparty.deleteMany({ where: { id: fixture.counterpartyId } }),
          prisma.session.deleteMany({ where: { userId: { in: actorIds } } }),
        ]);
      }
    }, [
      { label: 'flexible payment application', run: async () => app?.close() },
      {
        label: 'flexible payment timers',
        run: () => {
          jest.useRealTimers();
        },
      },
      {
        label: 'flexible payment environment',
        run: () => {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        },
      },
    ]);
  });

  async function login(login: 'finance' | 'commercial' | 'production'): Promise<AuthSession> {
    if (!app) throw new Error('E2E application is not initialized');
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('user-agent', userAgent)
      .send({ login: actors[login].login, password })
      .expect(201);
    const session = {
      token: response.body.token as string,
      userId: response.body.user.id as string,
    };
    expect(session.userId).toBe(actors[login].id);
    return session;
  }

  function bearer(session: AuthSession) {
    return { authorization: `Bearer ${session.token}` };
  }

  function orderedSchedules(body: { schedules: ScheduleView[] }) {
    return [...body.schedules].sort((left, right) => left.sequence - right.sequence);
  }

  function expectNoPaymentPolicyLeak(value: unknown) {
    const keys = new Set<string>();
    const amountValues: number[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node)) {
        keys.add(key);
        if (/amount/i.test(key) && (typeof child === 'number' || typeof child === 'string')) {
          const amount = Number(child);
          if (Number.isFinite(amount)) amountValues.push(amount);
        }
        visit(child);
      }
    };
    visit(value);

    expect(keys).not.toContain('paymentPolicy');
    expect(keys).not.toContain('percentageBasisPoints');
    for (const forbiddenAmount of [200, 300.01, 250]) {
      expect(amountValues).not.toContain(forbiddenAmount);
    }
  }

  it('previews, invoices, activates, confirms, and keeps policy data finance-only', async () => {
    if (!app) throw new Error('E2E application is not initialized');
    const currentFixture = fixture;
    const [finance, commercial, production] = await Promise.all([
      login('finance'),
      login('commercial'),
      login('production'),
    ]);
    const invoiceInput = { amount: 1000.01, paymentPolicy };

    const preview = await request(app.getHttpServer())
      .post(`/api/finance/orders/${currentFixture.financeOrderId}/payment-policy/preview`)
      .set(bearer(finance))
      .send(invoiceInput)
      .expect(200);
    expect(preview.body.rows.map((row: { amount: number }) => row.amount)).toEqual([
      200, 300.01, 250, 250,
    ]);
    expect(preview.body.rows.map((row: { dateKind: string }) => row.dateKind)).toEqual([
      'condition',
      'condition',
      'condition',
      'condition',
    ]);

    const invoiced = await request(app.getHttpServer())
      .post(`/api/finance/orders/${currentFixture.financeOrderId}/invoices`)
      .set(bearer(finance))
      .send(invoiceInput)
      .expect(201);
    const createdSchedules = orderedSchedules(invoiced.body);
    expect(createdSchedules.map((schedule) => schedule.amount)).toEqual([200, 300.01, 250, 250]);
    expect(createdSchedules.map((schedule) => schedule.dateKind)).toEqual([
      'actual',
      'condition',
      'condition',
      'condition',
    ]);
    expect(createdSchedules[0]).toEqual(
      expect.objectContaining({
        kind: 'invoice_prepayment',
        dueDate: '2026-07-20',
      }),
    );
    for (const schedule of createdSchedules.slice(1)) {
      expect(schedule).toEqual(
        expect.objectContaining({
          kind: 'post_delivery',
          dueDate: null,
          dateKind: 'condition',
        }),
      );
    }

    const financeOrder = await request(app.getHttpServer())
      .get(`/api/finance/orders/${currentFixture.financeOrderId}`)
      .set(bearer(finance))
      .expect(200);
    expect(financeOrder.body.paymentPolicy).toEqual(
      expect.objectContaining({
        installmentDays: 30,
        revision: 1,
        stages: paymentPolicy.stages.map((stage) => expect.objectContaining(stage)),
      }),
    );
    expect(orderedSchedules(financeOrder.body).map((schedule) => schedule.amount)).toEqual([
      200, 300.01, 250, 250,
    ]);
    expect(orderedSchedules(financeOrder.body).map((schedule) => schedule.dateKind)).toEqual([
      'actual',
      'condition',
      'condition',
      'condition',
    ]);

    const shipmentCompletedAt = new Date('2026-07-31T12:00:00.000Z');
    const activation = {
      actor: { userId: finance.userId, role: 'finance' as const },
      orderIds: [currentFixture.commercialOrderId],
      orderNumbers: [currentFixture.orderNumber],
      shipmentCompletedAt,
      warehouseTaskId: `e2e-warehouse-task-${randomUUID()}`,
    };
    await deferredPayment.activatePostDeliveryPayments(activation);

    const activated = await request(app.getHttpServer())
      .get(`/api/finance/orders/${currentFixture.financeOrderId}`)
      .set(bearer(finance))
      .expect(200);
    const activatedSchedules = orderedSchedules(activated.body);
    expect(activatedSchedules.slice(1).map((schedule) => schedule.dueDate)).toEqual([
      '2026-07-31',
      '2026-08-15',
      '2026-08-30',
    ]);
    expect(activatedSchedules.slice(1).map((schedule) => schedule.dateKind)).toEqual([
      'actual',
      'actual',
      'actual',
    ]);

    const prepayment = activatedSchedules[0];
    const confirmed = await request(app.getHttpServer())
      .post(
        `/api/finance/orders/${currentFixture.financeOrderId}/payment-schedules/${prepayment.id}/confirm`,
      )
      .set(bearer(finance))
      .send({})
      .expect(201);
    expect(confirmed.body.paymentStatus).toBe('partial');
    expect(
      confirmed.body.schedules.find((schedule: { id: string }) => schedule.id === prepayment.id),
    ).toEqual(expect.objectContaining({ status: 'paid', amount: 200 }));

    const datesBeforeRetry = await prisma.paymentSchedule.findMany({
      where: { financeOrderId: currentFixture.financeOrderId, kind: 'post_delivery' },
      orderBy: { offsetDays: 'asc' },
      select: { id: true, dueDate: true },
    });
    const auditCountBeforeRetry = await prisma.domainEvent.count({
      where: {
        objectId: currentFixture.financeOrderId,
        type: 'audit:deferred_payment_due_scheduled',
      },
    });
    expect(auditCountBeforeRetry).toBe(1);
    await deferredPayment.activatePostDeliveryPayments(activation);
    await expect(
      prisma.paymentSchedule.findMany({
        where: { financeOrderId: currentFixture.financeOrderId, kind: 'post_delivery' },
        orderBy: { offsetDays: 'asc' },
        select: { id: true, dueDate: true },
      }),
    ).resolves.toEqual(datesBeforeRetry);
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: currentFixture.financeOrderId,
          type: 'audit:deferred_payment_due_scheduled',
        },
      }),
    ).resolves.toBe(auditCountBeforeRetry);

    const commercialOrder = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${currentFixture.commercialOrderId}`)
      .set(bearer(commercial))
      .expect(200);
    expect(commercialOrder.body.indicators.payment).toBe('partial');
    expectNoPaymentPolicyLeak(commercialOrder.body);

    const productionOrders = await request(app.getHttpServer())
      .get('/api/production/orders')
      .set(bearer(production))
      .expect(200);
    const productionOrder = productionOrders.body.find(
      (order: { id: string }) => order.id === currentFixture.productionOrderId,
    );
    expect(productionOrder).toBeDefined();
    expectNoPaymentPolicyLeak(productionOrder);
  });
});
