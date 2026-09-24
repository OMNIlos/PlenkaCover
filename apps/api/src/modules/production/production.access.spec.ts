import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DECORATORS } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { RoleInboxProjectionService } from '../../common/role-inbox/role-inbox.service';
import { ProductionInventoryController } from './production-inventory.controller';
import { ProductionController } from './production.controller';
import { ProductionAssignmentCancellationService } from './production-assignment-cancellation.service';
import { ProductionBigBagSummaryService } from './production-bigbag-summary.service';
import { ProductionService } from './production.service';
import { ProductionShiftCommandService } from './production-shift-command.service';
import {
  ROLE_CAPABILITIES,
  capabilitiesForRole,
  type Capability,
  type Role,
} from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';

type ControllerHandler = (...args: never[]) => unknown;

function ctxFor(handler: ControllerHandler, role: Role) {
  return ctxForCapabilities(handler, role, capabilitiesForRole(role));
}

function ctxForCapabilities(
  handler: ControllerHandler,
  role: Role,
  capabilities: readonly string[],
) {
  return {
    getHandler: () => handler,
    getClass: () => ProductionController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: 'user-1', role, capabilities },
      }),
    }),
  } as never;
}

describe('production role-leakage', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = ProductionController.prototype;

  it('limits recipe catalog creation to commercial and production lead', () => {
    expect(ROLE_CAPABILITIES.commercial).toContain('recipe_catalog:create');
    expect(ROLE_CAPABILITIES.production_lead).toContain('recipe_catalog:create');
    expect(ROLE_CAPABILITIES.warehouse).not.toContain('recipe_catalog:create');
  });

  it('production notification routes are capability-gated without leaking to other roles', () => {
    const reflector = new Reflector();
    const inboxProto = proto as unknown as {
      notifications?: typeof proto.listOrders;
      markNotificationRead?: typeof proto.listOrders;
    };

    for (const handler of [inboxProto.notifications, inboxProto.markNotificationRead]) {
      expect(handler).toBeDefined();
      if (!handler) continue;

      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'production_order:read',
      ]);
      expect(guard.canActivate(ctxFor(handler, 'production_lead'))).toBe(true);
      for (const role of ['commercial', 'finance', 'operator', 'warehouse', 'director'] as const) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow();
      }
    }
  });

  it('operator cannot assign a roll', () => {
    expect(() => guard.canActivate(ctxFor(proto.assignRoll, 'operator'))).toThrow();
  });

  it('commercial cannot approve a production order', () => {
    expect(() => guard.canActivate(ctxFor(proto.approve, 'commercial'))).toThrow();
  });

  it('commercial cannot read the production projection after handoff', () => {
    expect(capabilitiesForRole('commercial')).not.toContain('production_order:read');
    expect(() => guard.canActivate(ctxFor(proto.listOrders, 'commercial'))).toThrow();
  });

  it('documents invalid production order query values as bad requests', () => {
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto.listOrders);

    expect(responses?.['400']).toBeDefined();
  });

  it('production_lead CAN approve and assign', () => {
    expect(guard.canActivate(ctxFor(proto.approve, 'production_lead'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.assignRoll, 'production_lead'))).toBe(true);
  });

  it('production lead can issue operator penalties but operator cannot', () => {
    expect(guard.canActivate(ctxFor(proto.createOperatorPenalty, 'production_lead'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(proto.createOperatorPenalty, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.listPenalties, 'operator'))).toThrow();
  });

  it('only commercial can use the legacy production handoff alias', () => {
    expect(guard.canActivate(ctxFor(proto.createOrder, 'commercial'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(proto.createOrder, 'production_lead'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.createOrder, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.createOrder, 'warehouse'))).toThrow();
  });

  it('commercial alone can explicitly hand a paid order to production', () => {
    expect(capabilitiesForRole('commercial')).toContain('production_order:handoff');
    for (const role of ['production_lead', 'finance', 'operator', 'warehouse'] as const) {
      expect(capabilitiesForRole(role)).not.toContain('production_order:handoff');
    }
  });

  it('operator cannot plan or reassign machine posts', () => {
    expect(capabilitiesForRole('operator')).not.toContain('machine:assign');
    expect(() => guard.canActivate(ctxFor(proto.createShift, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.createIndividualShift, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.assignOperatorMachine, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.breakdownReassign, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.requestMachineChange, 'operator'))).toThrow();
  });

  it('grants machine cancellations only to production lead', () => {
    expect(capabilitiesForRole('production_lead')).toEqual(
      expect.arrayContaining(['machine_assignment:cancel', 'machine_change:cancel']),
    );
    for (const role of [
      'commercial',
      'operator',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      expect(capabilitiesForRole(role)).not.toContain('machine_assignment:cancel');
      expect(capabilitiesForRole(role)).not.toContain('machine_change:cancel');
    }
  });

  it('separates generic problem reporting from production defect mutation', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.markRollDefect)).toEqual([
      'production_defect:create',
    ]);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.reportProblem)).toEqual([
      'problem:create',
    ]);

    expect(
      guard.canActivate(ctxForCapabilities(proto.reportProblem, 'commercial', ['problem:create'])),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctxForCapabilities(proto.markRollDefect, 'commercial', ['problem:create'])),
    ).toThrow();
    expect(
      guard.canActivate(
        ctxForCapabilities(proto.markRollDefect, 'commercial', ['production_defect:create']),
      ),
    ).toBe(true);
  });

  it('grants production defect mutation only to the canonical production lead role', () => {
    expect(capabilitiesForRole('production_lead')).toContain('production_defect:create');
    expect(guard.canActivate(ctxFor(proto.markRollDefect, 'production_lead'))).toBe(true);
    for (const role of [
      'commercial',
      'operator',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      expect(capabilitiesForRole(role)).not.toContain('production_defect:create');
      expect(() => guard.canActivate(ctxFor(proto.markRollDefect, role))).toThrow();
    }
  });

  it.each([
    ['notifications', proto.notifications, 'production_order:read'],
    ['markNotificationRead', proto.markNotificationRead, 'production_order:read'],
    ['listOrders', proto.listOrders, 'production_order:read'],
    ['bigBagsSummary', proto.bigBagsSummary, 'production_order:read'],
    ['createOrder', proto.createOrder, 'production_order:handoff'],
    ['shifts', proto.shifts, 'production_order:read'],
    ['createShift', proto.createShift, 'machine:assign'],
    ['createIndividualShift', proto.createIndividualShift, 'machine:assign'],
    ['operatorMachines', proto.operatorMachines, 'production_order:read'],
    ['assignOperatorMachine', proto.assignOperatorMachine, 'machine:assign'],
    ['cancelAssignment', proto.cancelAssignment, 'machine_assignment:cancel'],
    ['breakdownReassign', proto.breakdownReassign, 'machine:assign'],
    ['requestMachineChange', proto.requestMachineChange, 'machine:assign'],
    ['cancelMachineChange', proto.cancelMachineChange, 'machine_change:cancel'],
    ['posts', proto.posts, 'production_order:read'],
    ['reportMachineBreakdown', proto.reportMachineBreakdown, 'machine:assign'],
    ['startMachineRepair', proto.startMachineRepair, 'machine:assign'],
    ['completeMachineRepair', proto.completeMachineRepair, 'machine:assign'],
    ['markRollDefect', proto.markRollDefect, 'production_defect:create'],
    ['getOrder', proto.getOrder, 'production_order:read'],
    ['approve', proto.approve, 'production_order:approve'],
    ['reportProblem', proto.reportProblem, 'problem:create'],
    ['listProblems', proto.listProblems, 'production_order:read'],
    ['resolveProblem', proto.resolveProblem, 'problem:resolve'],
    ['listDispatch', proto.listDispatch, 'production_order:read'],
    ['summary', proto.summary, 'production_order:read'],
    ['bulkAssign', proto.bulkAssign, 'roll_dispatch:assign'],
    ['batchUpdate', proto.batchUpdate, 'roll_dispatch:assign'],
    ['reorder', proto.reorder, 'roll_dispatch:priority'],
    ['assignRoll', proto.assignRoll, 'roll_dispatch:assign'],
    ['setPriority', proto.setPriority, 'roll_dispatch:priority'],
    ['assignMachine', proto.assignMachine, 'machine:assign'],
    ['workload', proto.workload, 'production_order:read'],
    ['listPenalties', proto.listPenalties, 'production_order:read'],
    ['createOperatorPenalty', proto.createOperatorPenalty, 'penalty:create'],
  ])('declares the exact capability for %s', (_name, handler, capability) => {
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([capability]);
  });
});

describe('production inventory access', () => {
  const guard = new CapabilityGuard(new Reflector());
  const handler = ProductionInventoryController.prototype.rawMaterials;
  const context = (role: Role) =>
    ({
      getHandler: () => handler,
      getClass: () => ProductionInventoryController,
      switchToHttp: () => ({
        getRequest: () => ({
          actor: { userId: 'user-1', role, capabilities: capabilitiesForRole(role) },
        }),
      }),
    }) as never;

  it('requires the material catalog capability and rejects an operator', () => {
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'material_catalog:read',
    ]);
    expect(guard.canActivate(context('production_lead'))).toBe(true);
    expect(() => guard.canActivate(context('operator'))).toThrow();
  });

  it('documents a safe authenticated paginated response', () => {
    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, handler)).toEqual([{ session: [] }]);
    expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403']),
    );
  });
});

describe('production order query HTTP boundary', () => {
  let app: INestApplication;
  const service = {
    listOrders: jest.fn().mockResolvedValue([]),
    listProblems: jest.fn().mockResolvedValue([]),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductionController],
      providers: [
        { provide: ProductionService, useValue: service },
        { provide: ProductionShiftCommandService, useValue: {} },
        { provide: RoleInboxProjectionService, useValue: {} },
        { provide: ProductionBigBagSummaryService, useValue: {} },
        { provide: ProductionAssignmentCancellationService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.assign(req, {
        actor: {
          userId: 'production-lead-1',
          role: 'production_lead',
          capabilities: capabilitiesForRole('production_lead'),
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
    service.listOrders.mockClear();
    service.listProblems.mockClear();
  });

  it.each([
    ['/production/orders', undefined],
    ['/production/orders?bucket=needs_approval', 'needs_approval'],
    ['/production/orders?bucket=approved', 'approved'],
  ])('accepts the absent or supported production bucket for %s', async (path, bucket) => {
    await request(app.getHttpServer()).get(path).expect(200);

    expect(service.listOrders).toHaveBeenLastCalledWith(
      {
        userId: 'production-lead-1',
        role: 'production_lead',
        capabilities: capabilitiesForRole('production_lead'),
      },
      bucket,
    );
  });

  it('rejects an unknown production bucket before calling the service', async () => {
    await request(app.getHttpServer()).get('/production/orders?bucket=everything').expect(400);

    expect(service.listOrders).not.toHaveBeenCalled();
  });

  it.each([
    ['/production/problems', {}],
    ['/production/problems?status=open&type=defect', { status: 'open', type: 'defect' }],
  ])('accepts the absent or supported production problem filters for %s', async (path, query) => {
    await request(app.getHttpServer()).get(path).expect(200);

    expect(service.listProblems).toHaveBeenLastCalledWith(query);
  });

  it.each([
    '/production/problems?status=pendng',
    '/production/problems?type=unknown',
    '/production/problems?limit=100',
  ])('rejects an unsupported production problem query before service call: %s', async (path) => {
    await request(app.getHttpServer()).get(path).expect(400);

    expect(service.listProblems).not.toHaveBeenCalled();
  });
});
