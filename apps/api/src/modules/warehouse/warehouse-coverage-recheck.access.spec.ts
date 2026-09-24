import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { WarehouseCoverageRecheckService } from '../warehouse-coverage/warehouse-coverage-recheck.service';
import { WarehouseCoverageRecheckController } from './warehouse-coverage-recheck.controller';

function guardContext(handler: (...args: never[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => WarehouseCoverageRecheckController,
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

describe('WarehouseCoverageRecheckController access', () => {
  const reflector = new Reflector();
  const guard = new CapabilityGuard(reflector);
  const prototype = WarehouseCoverageRecheckController.prototype;

  it.each([
    ['list', prototype.list, 'warehouse_task:read'],
    ['resolve', prototype.resolve, 'warehouse_coverage:resolve_recheck'],
  ] as const)('gates %s with only %s', (_label, handler, capability) => {
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([capability]);
    expect(guard.canActivate(guardContext(handler, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
    ] as const) {
      expect(() => guard.canActivate(guardContext(handler, role))).toThrow();
    }
  });

  describe('HTTP boundary', () => {
    let app: INestApplication;
    const rechecks = {
      listForWarehouse: jest.fn().mockResolvedValue([]),
      resolveFromWarehouse: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'awaiting_finance',
        stateVersion: 9,
        generation: 4,
      }),
    };

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [WarehouseCoverageRecheckController],
        providers: [{ provide: WarehouseCoverageRecheckService, useValue: rechecks }],
      }).compile();
      app = moduleRef.createNestApplication();
      app.use((req: Request, _res: Response, next: NextFunction) => {
        const role = (req.header('x-test-role') ?? 'warehouse') as Role;
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
      rechecks.listForWarehouse.mockClear();
      rechecks.resolveFromWarehouse.mockClear();
    });

    const validBody = () => ({
      clientRequestId: '00000000-0000-4000-8000-0000000000AA',
      expectedCaseVersion: 1,
      expectedGeneration: 3,
      expectedStateVersion: 8,
      reason: '  Проверено   по этикетке  ',
      corrections: [
        {
          membershipId: 'membership-1',
          expectedFactVersion: 1,
          ownerCounterpartyId: 'counterparty-2',
        },
      ],
    });

    it('normalizes the public command and never accepts provenance fields', async () => {
      const body = validBody();
      await request(app.getHttpServer())
        .post('/warehouse/warehouse-coverage/rechecks/case-1/resolve')
        .send(body)
        .expect(200);

      expect(rechecks.resolveFromWarehouse).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'warehouse' }),
        'case-1',
        {
          ...body,
          clientRequestId: body.clientRequestId.toLowerCase(),
          reason: 'Проверено по этикетке',
        },
      );

      await request(app.getHttpServer())
        .post('/warehouse/warehouse-coverage/rechecks/case-1/resolve')
        .send({
          ...validBody(),
          corrections: [
            {
              ...validBody().corrections[0],
              sourceOrderId: 'spoofed-order',
              policyVersion: 'spoofed-policy',
            },
          ],
        })
        .expect(400);
      expect(rechecks.resolveFromWarehouse).toHaveBeenCalledTimes(1);
    });

    it.each([
      {},
      { ...validBody(), clientRequestId: 'not-a-uuid' },
      { ...validBody(), expectedCaseVersion: 0 },
      { ...validBody(), expectedGeneration: 0 },
      { ...validBody(), expectedStateVersion: 0 },
      { ...validBody(), reason: 'x' },
      {
        ...validBody(),
        corrections: [{ membershipId: 'membership-1', expectedFactVersion: 1 }],
      },
      {
        ...validBody(),
        corrections: [
          {
            membershipId: 'membership-1',
            expectedFactVersion: null,
            spec: {
              filmType: 'пленка',
              actualThickness: '80',
              accountingThickness: '80',
              birka: 'полотно',
              spoolType: '76 мм',
              actualWeightKg: '275',
              plannedWeightKg: '275',
              recipeId: null,
              recipeVersion: null,
              recipeDefinitionId: null,
              recipeDefinitionVersionId: null,
              recipeVersionNumber: null,
              ingredients: [],
            },
          },
        ],
      },
    ])('rejects malformed resolution body %#', async (body) => {
      await request(app.getHttpServer())
        .post('/warehouse/warehouse-coverage/rechecks/case-1/resolve')
        .send(body)
        .expect(400);
      expect(rechecks.resolveFromWarehouse).not.toHaveBeenCalled();
    });
  });
});
