import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DECORATORS } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { FinanceController } from './finance.controller';
import { ROLES, capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { RoleInboxProjectionService } from '../../common/role-inbox/role-inbox.service';
import { FinanceService } from './finance.service';
import { OneCInvoiceSyncService } from './onec-invoice-sync.service';
import { OneCPaymentSyncService } from './onec-payment-sync.service';
import { PaymentAllocationService } from './payment-allocation.service';
import { PaymentCorrectionService } from './payment-correction.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctxFor(handler: (...args: any[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => FinanceController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: null, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('finance role-leakage', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = FinanceController.prototype;

  it('finance notification routes are capability-gated without leaking to other roles', () => {
    const reflector = new Reflector();
    const inboxProto = proto as unknown as {
      notifications?: typeof proto.list;
      markNotificationRead?: typeof proto.list;
    };

    for (const handler of [inboxProto.notifications, inboxProto.markNotificationRead]) {
      expect(handler).toBeDefined();
      if (!handler) continue;

      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'finance_order:read',
      ]);
      expect(guard.canActivate(ctxFor(handler, 'finance'))).toBe(true);
      for (const role of [
        'commercial',
        'production_lead',
        'operator',
        'warehouse',
        'director',
      ] as const) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow();
      }
    }
  });

  it('operator cannot create an invoice', () => {
    expect(() => guard.canActivate(ctxFor(proto.invoice, 'operator'))).toThrow();
  });

  it('warehouse cannot update payment', () => {
    expect(() => guard.canActivate(ctxFor(proto.paymentUpdate, 'warehouse'))).toThrow();
  });

  it('commercial cannot mutate payment operations', () => {
    expect(() => guard.canActivate(ctxFor(proto.paymentOperation, 'commercial'))).toThrow();
  });

  it('operator cannot read finance overview', () => {
    expect(() => guard.canActivate(ctxFor(proto.overview, 'operator'))).toThrow();
  });

  it('finance can read finance overview', () => {
    expect(guard.canActivate(ctxFor(proto.overview, 'finance'))).toBe(true);
  });

  it('finance order queries declare success and bad-request swagger metadata', () => {
    const overviewResponses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto.overview);
    const listResponses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto.list);

    expect(overviewResponses).toBeDefined();
    expect(Object.keys(overviewResponses)).toEqual(expect.arrayContaining(['200', '400']));
    expect(listResponses?.['400']).toBeDefined();
  });

  it('payment policy preview declares its condition-aware response contract', () => {
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto.previewPaymentPolicy);

    expect(responses?.['200']?.type?.name).toBe('PaymentPolicyPreviewDto');
  });

  it('finance CAN invoice and update payment', () => {
    expect(guard.canActivate(ctxFor(proto.invoice, 'finance'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.paymentUpdate, 'finance'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.resolvePaymentAllocation, 'finance'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.setPaymentTerms, 'finance'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.confirmSchedule, 'finance'))).toBe(true);
  });

  it('keeps disabled 1C finance mutations undiscoverable', () => {
    for (const handler of [proto.invoiceLink, proto.sourceRetry, proto.paymentSourceSync]) {
      expect(() => guard.canActivate(ctxFor(handler, 'finance'))).toThrow(NotFoundException);
    }
  });

  it('restricts technical payment reconciliation diagnostics to admin', () => {
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.reconciliation)).toEqual([
      'admin:diagnostics',
    ]);
    expect(guard.canActivate(ctxFor(proto.reconciliation, 'admin'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'admin')) {
      expect(() => guard.canActivate(ctxFor(proto.reconciliation, role))).toThrow();
    }
  });

  it('keeps payment allocation resolution available to finance separately', () => {
    expect(
      new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.resolvePaymentAllocation),
    ).toEqual(['payment:update']);
    expect(guard.canActivate(ctxFor(proto.resolvePaymentAllocation, 'finance'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(proto.resolvePaymentAllocation, 'admin'))).toThrow();
  });

  it('grants payment correction only to finance', () => {
    expect(capabilitiesForRole('finance')).toContain('payment:correct');
    for (const role of ROLES.filter((candidate) => candidate !== 'finance')) {
      expect(capabilitiesForRole(role)).not.toContain('payment:correct');
    }
  });

  it('gates the target-specific payment correction endpoint to finance', () => {
    expect(guard.canActivate(ctxFor(proto.correctPayment, 'finance'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'finance')) {
      expect(() => guard.canActivate(ctxFor(proto.correctPayment, role))).toThrow();
    }
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.correctPayment)).toEqual([
      'payment:correct',
    ]);
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto.correctPayment);
    expect(responses?.['201']?.type?.name).toBe('PaymentCorrectionResponseDto');
  });

  it('payment policy preview is restricted to installment plan managers', () => {
    const preview = (proto as unknown as { previewPaymentPolicy?: typeof proto.invoice })
      .previewPaymentPolicy;

    expect(preview).toBeDefined();
    if (!preview) return;
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, preview)).toEqual([
      'installment_plan:manage',
    ]);
    expect(guard.canActivate(ctxFor(preview, 'finance'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(preview, 'commercial'))).toThrow();
  });

  it('payment policy replacement is restricted to installment plan managers', () => {
    const replace = (proto as unknown as { setPaymentPolicy?: typeof proto.setPaymentTerms })
      .setPaymentPolicy;

    expect(replace).toBeDefined();
    if (!replace) return;
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, replace)).toEqual([
      'installment_plan:manage',
    ]);
    expect(guard.canActivate(ctxFor(replace, 'finance'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(replace, 'commercial'))).toThrow();
  });

  it('commercial cannot select terms or confirm a payment row', () => {
    expect(() => guard.canActivate(ctxFor(proto.setPaymentTerms, 'commercial'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.confirmSchedule, 'commercial'))).toThrow();
  });

  it('every finance mutation route declares a capability', () => {
    const reflector = new Reflector();
    for (const handler of [
      proto.invoice,
      proto.invoiceLink,
      (proto as unknown as { previewPaymentPolicy?: typeof proto.invoice }).previewPaymentPolicy,
      (proto as unknown as { setPaymentPolicy?: typeof proto.setPaymentTerms }).setPaymentPolicy,
      proto.paymentUpdate,
      proto.correctPayment,
      proto.setPaymentTerms,
      proto.confirmSchedule,
      proto.paymentOperation,
      proto.sourceRetry,
      proto.paymentSourceSync,
      proto.resolvePaymentAllocation,
      proto.problem,
    ]) {
      expect(handler).toBeDefined();
      if (!handler) continue;
      const caps = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler);
      expect(caps && caps.length).toBeTruthy();
    }
  });
});

describe('finance payment policy HTTP boundary', () => {
  let app: INestApplication;
  const service = {
    previewPaymentPolicy: jest.fn().mockResolvedValue({ rows: [] }),
    setPaymentPolicy: jest.fn().mockResolvedValue({ id: 'fo1' }),
    createInvoice: jest.fn().mockResolvedValue({ id: 'fo1' }),
    listOrders: jest.fn().mockResolvedValue([]),
    getOverview: jest.fn().mockResolvedValue({ buckets: {}, agenda: [], calendar: [] }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FinanceController],
      providers: [
        { provide: FinanceService, useValue: service },
        {
          provide: OneCInvoiceSyncService,
          useValue: { refresh: jest.fn(), link: jest.fn() },
        },
        {
          provide: OneCPaymentSyncService,
          useValue: { sync: jest.fn() },
        },
        {
          provide: PaymentAllocationService,
          useValue: { reconciliation: jest.fn(), resolve: jest.fn() },
        },
        {
          provide: PaymentCorrectionService,
          useValue: { correct: jest.fn() },
        },
        { provide: RoleInboxProjectionService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const role = (req.header('x-test-role') ?? 'finance') as Role;
      Object.assign(req, {
        actor: {
          userId: `u-${role}`,
          role,
          capabilities: capabilitiesForRole(role),
        },
      });
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalGuards(new CapabilityGuard(moduleRef.get(Reflector)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    service.previewPaymentPolicy.mockClear();
    service.setPaymentPolicy.mockClear();
    service.createInvoice.mockClear();
    service.listOrders.mockClear();
    service.getOverview.mockClear();
  });

  async function expectCapability(
    method: 'POST',
    path: string,
    capability: Capability,
    body: Record<string, unknown>,
  ) {
    expect(method).toBe('POST');
    const preview = (
      FinanceController.prototype as unknown as {
        previewPaymentPolicy?: typeof FinanceController.prototype.invoice;
      }
    ).previewPaymentPolicy;
    expect(preview).toBeDefined();
    if (!preview) return;
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, preview)).toEqual([capability]);

    await request(app.getHttpServer())
      .post(path)
      .set('x-test-role', 'finance')
      .send(body)
      .expect(200);
    expect(service.previewPaymentPolicy).toHaveBeenLastCalledWith(
      { userId: 'u-finance', role: 'finance' },
      'fo1',
      body,
    );
    await request(app.getHttpServer())
      .post(path)
      .set('x-test-role', 'commercial')
      .send(body)
      .expect(403);
  }

  it('exposes the preview route with installment plan capability', async () => {
    await expectCapability(
      'POST',
      '/finance/orders/fo1/payment-policy/preview',
      'installment_plan:manage',
      {
        amount: 1000,
        paymentPolicy: {
          installmentDays: 30,
          stages: [
            {
              sequence: 1,
              trigger: 'full_shipment',
              percentageBasisPoints: 10000,
              offsetDays: 30,
            },
          ],
        },
      },
    );
  });

  it('exposes policy replacement as a guarded PUT route', async () => {
    const body = {
      expectedRevision: 1,
      reason: 'Новый график',
      paymentPolicy: {
        installmentDays: 30,
        stages: [
          {
            sequence: 1,
            trigger: 'full_shipment',
            percentageBasisPoints: 10000,
            offsetDays: 30,
          },
        ],
      },
    };

    await request(app.getHttpServer())
      .put('/finance/orders/fo1/payment-policy')
      .set('x-test-role', 'finance')
      .send(body)
      .expect(200);
    expect(service.setPaymentPolicy).toHaveBeenCalledWith(
      { userId: 'u-finance', role: 'finance' },
      'fo1',
      body,
    );

    await request(app.getHttpServer())
      .put('/finance/orders/fo1/payment-policy')
      .set('x-test-role', 'commercial')
      .send(body)
      .expect(403);
  });

  const validStage = {
    sequence: 1,
    trigger: 'full_shipment',
    percentageBasisPoints: 10000,
    offsetDays: 30,
  };

  it.each([
    ['missing payment policy', { amount: 1000 }],
    [
      '51 stages',
      {
        amount: 1000,
        paymentPolicy: {
          installmentDays: 30,
          stages: Array.from({ length: 51 }, (_, index) => ({
            ...validStage,
            sequence: index + 1,
          })),
        },
      },
    ],
    [
      'decimal basis points',
      {
        amount: 1000,
        paymentPolicy: {
          installmentDays: 30,
          stages: [{ ...validStage, percentageBasisPoints: 9999.5 }],
        },
      },
    ],
    [
      'unknown nested trigger',
      {
        amount: 1000,
        paymentPolicy: {
          installmentDays: 30,
          stages: [{ ...validStage, trigger: 'order_created' }],
        },
      },
    ],
    [
      'nested extra property',
      {
        amount: 1000,
        paymentPolicy: {
          installmentDays: 30,
          stages: [{ ...validStage, rawPayload: { hidden: true } }],
        },
      },
    ],
    [
      'amount with more than two decimal places',
      {
        amount: 1000.001,
        paymentPolicy: { installmentDays: 30, stages: [validStage] },
      },
    ],
  ])('rejects %s before calling the preview service', async (_case, body) => {
    await request(app.getHttpServer())
      .post('/finance/orders/fo1/payment-policy/preview')
      .set('x-test-role', 'finance')
      .send(body)
      .expect(400);

    expect(service.previewPaymentPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['canonical payment policy', { amount: 1000, paymentPolicy: null }],
    ['legacy payment terms', { amount: 1000, paymentTermsType: null }],
  ])('rejects a null %s before calling the invoice service', async (_case, body) => {
    await request(app.getHttpServer())
      .post('/finance/orders/fo1/invoices')
      .set('x-test-role', 'finance')
      .send(body)
      .expect(400);

    expect(service.createInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ['/finance/orders', undefined],
    ['/finance/orders?bucket=actual', 'actual'],
    ['/finance/orders?bucket=actions', 'actions'],
    ['/finance/orders?bucket=problems', 'problems'],
    ['/finance/orders?bucket=completed', 'completed'],
    ['/finance/orders?bucket=unpaid', 'unpaid'],
    ['/finance/orders?bucket=overdue', 'overdue'],
  ])('accepts the absent or supported finance bucket for %s', async (path, bucket) => {
    await request(app.getHttpServer()).get(path).expect(200);

    expect(service.listOrders).toHaveBeenLastCalledWith(
      {
        userId: 'u-finance',
        role: 'finance',
        capabilities: capabilitiesForRole('finance'),
      },
      bucket,
    );
  });

  it('rejects an unknown finance bucket before calling the service', async () => {
    await request(app.getHttpServer()).get('/finance/orders?bucket=everything').expect(400);

    expect(service.listOrders).not.toHaveBeenCalled();
  });

  it.each([
    ['/finance/overview', undefined],
    ['/finance/overview?date=2024-02-29', '2024-02-29'],
  ])('accepts an absent or exact real overview date for %s', async (path, date) => {
    await request(app.getHttpServer()).get(path).expect(200);

    expect(service.getOverview).toHaveBeenLastCalledWith(
      {
        userId: 'u-finance',
        role: 'finance',
        capabilities: capabilitiesForRole('finance'),
      },
      date,
    );
  });

  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '2026-2-01', 'not-a-date'])(
    'rejects invalid overview date %s before calling the service',
    async (date) => {
      await request(app.getHttpServer())
        .get(`/finance/overview?date=${encodeURIComponent(date)}`)
        .expect(400);

      expect(service.getOverview).not.toHaveBeenCalled();
    },
  );
});
