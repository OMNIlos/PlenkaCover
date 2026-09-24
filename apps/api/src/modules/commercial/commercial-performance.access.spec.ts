import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { BusinessOperationalProblemService } from './business-operational-problem.service';
import { CommercialPerformanceController } from './commercial-performance.controller';
import { CommercialPerformanceService } from './commercial-performance.service';
import { WarehouseBusinessProjectionService } from '../../common/business-projections/warehouse-business-projection.service';

function contextFor(handler: (...args: never[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => CommercialPerformanceController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: null, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('commercial performance role boundary', () => {
  let app: INestApplication;
  const service = {
    getControl: jest.fn(),
    getControlShiftBalanceEvidence: jest
      .fn()
      .mockResolvedValue({ items: [{ sessionId: 'shift-session-1' }], nextCursor: null }),
    getControlBigBagEvidence: jest
      .fn()
      .mockResolvedValue({ items: [{ id: 'big-bag-usage-1' }], nextCursor: null }),
    listFinance: jest.fn(),
    listProduction: jest.fn(),
    listProductionRolls: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listWarehouse: jest.fn(),
  };
  const operationalProblems = {
    listProblems: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getProblem: jest.fn().mockResolvedValue({
      id: 'problem-1',
      kind: 'general',
      status: 'open',
      label: 'Общая проблема',
      createdAt: '2026-08-08T08:00:00.000Z',
      orderId: 'order-1',
      orderNumber: 'A-10',
      rollCode: 'A-10-roll-1',
      machineName: 'Экструдер 1',
      reason: 'Остановка линии',
    }),
  };
  const warehouseBusiness = {
    list: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 }),
  };
  const guard = new CapabilityGuard(new Reflector());
  const reflector = new Reflector();
  const proto = CommercialPerformanceController.prototype;
  const handlers = [
    proto.control,
    proto.controlShiftBalances,
    proto.controlBigBags,
    proto.finance,
    proto.production,
    proto.productionRolls,
    proto.warehouse,
    proto.problems,
    proto.problem,
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CommercialPerformanceController],
      providers: [
        { provide: CommercialPerformanceService, useValue: service },
        { provide: BusinessOperationalProblemService, useValue: operationalProblems },
        { provide: WarehouseBusinessProjectionService, useValue: warehouseBusiness },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const role = req.header('x-test-role') as Role;
      Object.assign(req, {
        actor: { userId: `${role}-1`, role, capabilities: capabilitiesForRole(role) },
      });
      next();
    });
    app.useGlobalGuards(new CapabilityGuard(moduleRef.get(Reflector)));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    service.getControlShiftBalanceEvidence.mockClear();
    service.getControlBigBagEvidence.mockClear();
    service.listProductionRolls.mockClear();
    operationalProblems.listProblems.mockClear();
    operationalProblems.getProblem.mockClear();
    warehouseBusiness.list.mockClear();
  });

  it('gates every read with the dedicated safe capability', () => {
    for (const handler of handlers) {
      expect(handler).toEqual(expect.any(Function));
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual(
        handler === proto.productionRolls
          ? ['business_performance:read', 'production_cost:read']
          : ['business_performance:read'],
      );
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    }
  });

  it('allows commercial and director but rejects operational roles', () => {
    for (const handler of handlers) {
      expect(guard.canActivate(contextFor(handler, 'commercial'))).toBe(true);
      expect(guard.canActivate(contextFor(handler, 'director'))).toBe(true);
      for (const role of ['production_lead', 'operator', 'warehouse', 'finance'] as const) {
        expect(() => guard.canActivate(contextFor(handler, role))).toThrow();
      }
    }
  });

  it('publishes every endpoint under the commercial performance boundary', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CommercialPerformanceController)).toBe(
      'commercial/performance',
    );
    expect(handlers.map((handler) => Reflect.getMetadata(PATH_METADATA, handler))).toEqual([
      'control',
      'control/shift-balances',
      'control/big-bags',
      'finance',
      'production',
      'production/:productionOrderId/rolls',
      'warehouse',
      'problems',
      'problems/:problemId',
    ]);
  });

  it('publishes the exact safe problem DTO in runtime OpenAPI metadata', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth({ type: 'http', scheme: 'bearer' }, 'session').build(),
    );
    const operation = document.paths['/api/commercial/performance/problems/{problemId}']?.get;
    const schema = document.components?.schemas?.BusinessOperationalProblemResponseDto as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(operation?.security).toContainEqual({ session: [] });
    expect(operation?.responses).toEqual(
      expect.objectContaining({
        '200': expect.objectContaining({
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BusinessOperationalProblemResponseDto' },
            },
          },
        }),
        '401': expect.any(Object),
        '403': expect.any(Object),
        '404': expect.any(Object),
      }),
    );
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      [
        'createdAt',
        'id',
        'kind',
        'label',
        'machineName',
        'orderId',
        'orderNumber',
        'reason',
        'rollCode',
        'status',
      ].sort(),
    );
  });

  it('publishes the delivered lifecycle in production and roll OpenAPI schemas', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth({ type: 'http', scheme: 'bearer' }, 'session').build(),
    );
    const expected = [
      'in_production',
      'ready_for_warehouse',
      'warehouse_handed_off',
      'warehouse_accepted',
      'warehouse_delivered',
      'defect',
      'unknown',
    ];

    for (const schemaName of [
      'CommercialPerformanceProductionItemResponseDto',
      'BusinessPerformanceRollItemResponseDto',
    ]) {
      const schema = document.components?.schemas?.[schemaName] as
        | { properties?: { lifecycleStatus?: { enum?: string[] } } }
        | undefined;
      expect(schema?.properties?.lifecycleStatus?.enum).toEqual(expected);
    }
  });

  it.each([
    [
      '/api/commercial/performance/control/shift-balances',
      { items: [{ sessionId: 'shift-session-1' }], nextCursor: null },
    ],
    [
      '/api/commercial/performance/control/big-bags',
      { items: [{ id: 'big-bag-usage-1' }], nextCursor: null },
    ],
  ] as const)('allows shared business readers to read %s', async (path, expectedBody) => {
    const query = '?from=2026-07-01&to=2026-07-31&bucket=day&limit=20';
    for (const role of ['commercial', 'director'] as const) {
      await request(app.getHttpServer())
        .get(`${path}${query}`)
        .set({ 'x-test-role': role })
        .expect(200)
        .expect(expectedBody);
    }
  });

  it.each([
    '/api/commercial/performance/control/shift-balances',
    '/api/commercial/performance/control/big-bags',
  ] as const)('denies operational and admin roles access to %s', async (path) => {
    const query = '?from=2026-07-01&to=2026-07-31&bucket=day&limit=20';
    for (const role of ['production_lead', 'operator', 'warehouse', 'finance', 'admin'] as const) {
      await request(app.getHttpServer())
        .get(`${path}${query}`)
        .set({ 'x-test-role': role })
        .expect(403);
    }
  });

  it('validates and normalizes safe shift-balance evidence filters', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/commercial/performance/control/shift-balances' +
          '?from=2026-07-01&to=2026-07-31&bucket=day' +
          '&operatorQuery=%20%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2%20&rollCountMin=2&limit=10',
      )
      .set({ 'x-test-role': 'commercial' })
      .expect(200);

    expect(service.getControlShiftBalanceEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-07-01',
        to: '2026-07-31',
        bucket: 'day',
        operatorQuery: 'Иванов',
        rollCountMin: 2,
        limit: 10,
      }),
    );
  });

  it('rejects invalid BigBag evidence filters before calling the service', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/commercial/performance/control/big-bags' +
          '?from=2026-07-01&to=2026-07-31&bucket=day&limit=101',
      )
      .set({ 'x-test-role': 'commercial' })
      .expect(400);

    expect(service.getControlBigBagEvidence).not.toHaveBeenCalled();
  });

  it.each(['commercial', 'director'] as const)(
    'allows %s to read the production roll drilldown',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/commercial/performance/production/production-1/rolls')
        .set({ 'x-test-role': role })
        .expect(200)
        .expect({ items: [], nextCursor: null });
    },
  );

  it.each(['commercial', 'director'] as const)(
    'allows %s to fetch one exact safe operational problem',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/commercial/performance/problems/problem-1')
        .set({ 'x-test-role': role })
        .expect(200)
        .expect({
          id: 'problem-1',
          kind: 'general',
          status: 'open',
          label: 'Общая проблема',
          createdAt: '2026-08-08T08:00:00.000Z',
          orderId: 'order-1',
          orderNumber: 'A-10',
          rollCode: 'A-10-roll-1',
          machineName: 'Экструдер 1',
          reason: 'Остановка линии',
        });
    },
  );

  it.each(['production_lead', 'operator', 'warehouse', 'finance', 'admin'] as const)(
    'denies %s access to one exact operational problem',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/commercial/performance/problems/problem-1')
        .set({ 'x-test-role': role })
        .expect(403);
    },
  );

  it.each(['commercial', 'director'] as const)(
    'allows %s to read the current warehouse business page without a date range',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/commercial/performance/warehouse?page=2&pageSize=10')
        .set({ 'x-test-role': role })
        .expect(200)
        .expect({ items: [], page: 1, pageSize: 50, total: 0 });

      expect(warehouseBusiness.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, pageSize: 10 }),
      );
    },
  );

  it('rejects an invalid warehouse business page before projection', async () => {
    await request(app.getHttpServer())
      .get('/api/commercial/performance/warehouse?page=0&pageSize=101')
      .set({ 'x-test-role': 'commercial' })
      .expect(400);

    expect(warehouseBusiness.list).not.toHaveBeenCalled();
  });

  it.each(['production_lead', 'operator', 'warehouse', 'finance', 'admin'] as const)(
    'denies %s access to the production roll drilldown',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/commercial/performance/production/production-1/rolls')
        .set({ 'x-test-role': role })
        .expect(403);
    },
  );

  it.each(['commercial', 'director'] as const)(
    'allows %s to read the shared operational problems',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/commercial/performance/problems')
        .set({ 'x-test-role': role })
        .expect(200)
        .expect({ items: [], nextCursor: null });
    },
  );

  it.each(['production_lead', 'operator', 'warehouse', 'finance', 'admin'] as const)(
    'denies %s access to the shared operational problems',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/commercial/performance/problems')
        .set({ 'x-test-role': role })
        .expect(403);
    },
  );

  it('validates operational-problem filters and page limits at the HTTP boundary', async () => {
    await request(app.getHttpServer())
      .get('/api/commercial/performance/problems?filter=unexpected')
      .set({ 'x-test-role': 'commercial' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/commercial/performance/problems?limit=101')
      .set({ 'x-test-role': 'commercial' })
      .expect(400);
    expect(operationalProblems.listProblems).not.toHaveBeenCalled();
  });

  it('validates the production roll page limit at the HTTP boundary', async () => {
    await request(app.getHttpServer())
      .get('/api/commercial/performance/production/production-1/rolls?limit=101')
      .set({ 'x-test-role': 'commercial' })
      .expect(400);
    expect(service.listProductionRolls).not.toHaveBeenCalled();
  });
});
