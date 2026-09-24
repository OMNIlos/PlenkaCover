import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { WarehouseCoverageCalculationService } from '../warehouse-coverage/warehouse-coverage-calculation.service';
import { WarehouseCoverageDecisionService } from '../warehouse-coverage/warehouse-coverage-decision.service';
import { WarehouseCoverageRecheckService } from '../warehouse-coverage/warehouse-coverage-recheck.service';
import { FinanceWarehouseCoverageController } from './finance-warehouse-coverage.controller';

function guardContext(handler: (...args: never[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => FinanceWarehouseCoverageController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: {
          userId: `${role}-1`,
          role,
          capabilities: capabilitiesForRole(role),
        },
      }),
    }),
  } as never;
}

describe('FinanceWarehouseCoverageController access and DTO boundary', () => {
  const guard = new CapabilityGuard(new Reflector());
  const prototype = FinanceWarehouseCoverageController.prototype;

  it.each([
    ['read', prototype.read, 'finance_order:read'],
    ['refresh', prototype.refresh, 'warehouse_coverage:refresh'],
    ['decide', prototype.decide, 'warehouse_coverage:decide'],
    ['requestRecheck', prototype.requestRecheck, 'warehouse_coverage:request_recheck'],
  ] as const)('gates %s with only %s', (_label, handler, capability) => {
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([capability]);
    expect(guard.canActivate(guardContext(handler, 'finance'))).toBe(true);
    for (const role of [
      'commercial',
      'production_lead',
      'operator',
      'warehouse',
      'director',
    ] as const) {
      expect(() => guard.canActivate(guardContext(handler, role))).toThrow();
    }
  });

  describe('HTTP validation', () => {
    let app: INestApplication;
    const service = {
      readForFinance: jest.fn().mockResolvedValue({ state: 'calculating', financeRolls: [] }),
      refreshForFinance: jest.fn().mockResolvedValue({
        state: 'awaiting_finance',
        financeRolls: [],
      }),
    };
    const decisions = {
      decide: jest.fn().mockResolvedValue({
        state: 'warehouse_reserved',
        financeRolls: [],
      }),
    };
    const rechecks = {
      requestFromFinance: jest.fn().mockResolvedValue({
        state: 'recheck_requested',
        financeRolls: [],
        caseId: 'case-1',
      }),
    };

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [FinanceWarehouseCoverageController],
        providers: [
          { provide: WarehouseCoverageCalculationService, useValue: service },
          { provide: WarehouseCoverageDecisionService, useValue: decisions },
          { provide: WarehouseCoverageRecheckService, useValue: rechecks },
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      app.use((req: Request, _res: Response, next: NextFunction) => {
        const role = (req.header('x-test-role') ?? 'finance') as Role;
        Object.assign(req, {
          actor: {
            userId: `${role}-1`,
            role,
            capabilities: capabilitiesForRole(role),
          },
        });
        next();
      });
      app.useGlobalPipes(
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      );
      app.useGlobalGuards(new CapabilityGuard(moduleRef.get(Reflector)));
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      service.readForFinance.mockClear();
      service.refreshForFinance.mockClear();
      decisions.decide.mockClear();
      rechecks.requestFromFinance.mockClear();
    });

    it('uses FinanceOrder.id and a strict canonical refresh DTO', async () => {
      const body = {
        clientRequestId: '00000000-0000-4000-8000-0000000000AA',
        expectedGeneration: null,
        expectedStateVersion: 1,
      };
      await request(app.getHttpServer())
        .post('/finance/orders/finance-real-id/warehouse-coverage/refresh')
        .send(body)
        .expect(200);

      expect(service.refreshForFinance).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'finance' }),
        'finance-real-id',
        {
          ...body,
          clientRequestId: body.clientRequestId.toLowerCase(),
        },
      );
    });

    it.each([
      {},
      {
        clientRequestId: 'not-a-uuid',
        expectedGeneration: null,
        expectedStateVersion: 1,
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000010',
        expectedGeneration: 0,
        expectedStateVersion: 1,
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000010',
        expectedGeneration: null,
        expectedStateVersion: 0,
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000010',
        expectedGeneration: null,
        expectedStateVersion: 1,
        rawFact: { secret: true },
      },
    ])('rejects malformed or extra refresh body %#', async (body) => {
      await request(app.getHttpServer())
        .post('/finance/orders/finance-real-id/warehouse-coverage/refresh')
        .send(body)
        .expect(400);
      expect(service.refreshForFinance).not.toHaveBeenCalled();
    });

    it('uses FinanceOrder.id and a strict canonical decision DTO', async () => {
      const body = {
        clientRequestId: '00000000-0000-4000-8000-0000000000AA',
        expectedGeneration: 3,
        expectedStateVersion: 5,
        decision: 'use_warehouse',
      };
      await request(app.getHttpServer())
        .post('/finance/orders/finance-real-id/warehouse-coverage/decide')
        .send(body)
        .expect(200);

      expect(decisions.decide).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'finance' }),
        'finance-real-id',
        {
          ...body,
          clientRequestId: body.clientRequestId.toLowerCase(),
        },
      );
    });

    it.each([
      {},
      {
        clientRequestId: 'not-a-uuid',
        expectedGeneration: 3,
        expectedStateVersion: 5,
        decision: 'use_warehouse',
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000011',
        expectedGeneration: 0,
        expectedStateVersion: 5,
        decision: 'use_warehouse',
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000011',
        expectedGeneration: 3,
        expectedStateVersion: 0,
        decision: 'use_warehouse',
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000011',
        expectedGeneration: 3,
        expectedStateVersion: 5,
        decision: 'partial_warehouse',
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000011',
        expectedGeneration: 3,
        expectedStateVersion: 5,
        decision: 'produce_all',
        rollIds: ['private-roll'],
      },
    ])('rejects malformed or extra decision body %#', async (body) => {
      await request(app.getHttpServer())
        .post('/finance/orders/finance-real-id/warehouse-coverage/decide')
        .send(body)
        .expect(400);
      expect(decisions.decide).not.toHaveBeenCalled();
    });

    it('uses FinanceOrder.id and a strict normalized recheck DTO', async () => {
      const body = {
        clientRequestId: '00000000-0000-4000-8000-0000000000AA',
        expectedGeneration: 3,
        expectedStateVersion: 5,
        reason: '  Проверить   факты склада  ',
      };
      await request(app.getHttpServer())
        .post('/finance/orders/finance-real-id/warehouse-coverage/recheck')
        .send(body)
        .expect(200);

      expect(rechecks.requestFromFinance).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'finance' }),
        'finance-real-id',
        {
          ...body,
          clientRequestId: body.clientRequestId.toLowerCase(),
          reason: 'Проверить факты склада',
        },
      );
    });

    it.each([
      {},
      {
        clientRequestId: 'not-a-uuid',
        expectedGeneration: 3,
        expectedStateVersion: 5,
        reason: 'Проверить склад',
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000013',
        expectedGeneration: 0,
        expectedStateVersion: 5,
        reason: 'Проверить склад',
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000013',
        expectedGeneration: 3,
        expectedStateVersion: 0,
        reason: 'Проверить склад',
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000013',
        expectedGeneration: 3,
        expectedStateVersion: 5,
        reason: '  ',
      },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000013',
        expectedGeneration: 3,
        expectedStateVersion: 5,
        reason: 'Проверить склад',
        rollIds: ['secret-roll'],
      },
    ])('rejects malformed or extra recheck body %#', async (body) => {
      await request(app.getHttpServer())
        .post('/finance/orders/finance-real-id/warehouse-coverage/recheck')
        .send(body)
        .expect(400);
      expect(rechecks.requestFromFinance).not.toHaveBeenCalled();
    });

    it('keeps read capability-gated and does not accept warehouse role', async () => {
      await request(app.getHttpServer())
        .get('/finance/orders/finance-real-id/warehouse-coverage')
        .expect(200);
      expect(service.readForFinance).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'finance' }),
        'finance-real-id',
      );

      await request(app.getHttpServer())
        .get('/finance/orders/finance-real-id/warehouse-coverage')
        .set('x-test-role', 'warehouse')
        .expect(403);
    });
  });
});
