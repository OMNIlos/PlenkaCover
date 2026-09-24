import { Reflector } from '@nestjs/core';
import { DECORATORS } from '@nestjs/swagger';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { DirectorInventoryController } from './director-inventory.controller';
import { DirectorController } from './director.controller';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import {
  DirectorAnalyticsBigBagEvidenceQueryDto,
  DirectorAnalyticsShiftEvidenceQueryDto,
} from './dto/analytics-query.dto';
import { DirectorAnalyticsResponseDto } from './dto/analytics-response.dto';

function queryMetadata(handler: (...args: never[]) => unknown): unknown[] {
  const methodName = Object.getOwnPropertyNames(DirectorController.prototype).find(
    (name) =>
      DirectorController.prototype[name as keyof DirectorController] ===
      (handler as DirectorController[keyof DirectorController]),
  );

  return methodName
    ? (Reflect.getMetadata('design:paramtypes', DirectorController.prototype, methodName) ?? [])
    : [];
}

function readCapabilities(methodName: 'shiftBalanceEvidence' | 'bigBagEvidence'): Capability[] {
  return (
    new Reflector().get<Capability[]>(
      REQUIRE_CAPABILITIES,
      DirectorController.prototype[methodName],
    ) ?? []
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctxFor(handler: (...args: any[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => DirectorController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: null, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('director role-leakage', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = DirectorController.prototype;

  it('director notification routes are capability-gated without leaking to routine roles', () => {
    const reflector = new Reflector();
    const inboxProto = proto as unknown as {
      notifications?: typeof proto.control;
      markNotificationRead?: typeof proto.control;
    };

    for (const handler of [inboxProto.notifications, inboxProto.markNotificationRead]) {
      expect(handler).toBeDefined();
      if (!handler) continue;

      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual(['director:read']);
      expect(guard.canActivate(ctxFor(handler, 'director'))).toBe(true);
      for (const role of [
        'commercial',
        'finance',
        'production_lead',
        'operator',
        'warehouse',
      ] as const) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow();
      }
    }
  });

  it('commercial cannot override finance', () => {
    expect(() => guard.canActivate(ctxFor(proto.overrideFinance, 'commercial'))).toThrow();
  });

  it('production_lead cannot override finance', () => {
    expect(() => guard.canActivate(ctxFor(proto.overrideFinance, 'production_lead'))).toThrow();
  });

  it('finance cannot create a penalty', () => {
    expect(() => guard.canActivate(ctxFor(proto.createPenalty, 'finance'))).toThrow();
  });

  it('director CAN override and penalize', () => {
    expect(guard.canActivate(ctxFor(proto.overrideFinance, 'director'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.createPenalty, 'director'))).toBe(true);
  });

  it('every director mutation route declares a capability', () => {
    const reflector = new Reflector();
    for (const handler of [
      proto.approve,
      proto.return,
      proto.overrideFinance,
      proto.overrideProduction,
      proto.overrideWarehouse,
      proto.createPenalty,
    ]) {
      const caps = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler);
      expect(caps && caps.length).toBeTruthy();
    }
  });

  it('director list projections require director:read; other roles are rejected', () => {
    for (const handler of [
      proto.financeList,
      proto.productionList,
      proto.warehouseList,
      proto.penalties,
      proto.penaltyTargets,
    ]) {
      expect(guard.canActivate(ctxFor(handler, 'director'))).toBe(true);
      expect(() => guard.canActivate(ctxFor(handler, 'operator'))).toThrow();
    }
  });

  it('keeps the legacy warehouse problem route and adds a separate business projection route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto.warehouseList)).toBe('warehouse');
    expect(Reflect.getMetadata(PATH_METADATA, proto.performanceWarehouse)).toBe(
      'performance/warehouse',
    );
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.warehouseList)).toEqual([
      'director:read',
    ]);
    expect(
      new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, proto.performanceWarehouse),
    ).toEqual(['director:read']);
    expect(guard.canActivate(ctxFor(proto.performanceWarehouse, 'director'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(proto.performanceWarehouse, 'commercial'))).toThrow();
  });

  it('publishes production problems as a director-only authenticated GET projection', () => {
    const problems = (proto as unknown as { problems?: typeof proto.control }).problems;

    expect(problems).toBeDefined();
    if (!problems) return;

    expect(Reflect.getMetadata(PATH_METADATA, problems)).toBe('problems');
    expect(Reflect.getMetadata(METHOD_METADATA, problems)).toBe(RequestMethod.GET);
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, problems)).toEqual([
      'director:read',
    ]);
    expect(guard.canActivate(ctxFor(problems, 'director'))).toBe(true);
    for (const role of [
      'commercial',
      'production_lead',
      'operator',
      'warehouse',
      'finance',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(problems, role))).toThrow();
    }
    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, problems)).toEqual([{ session: [] }]);
    expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, problems) ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '403', '422']),
    );
  });

  it('analytics requires director:read without leaking to operator or warehouse', () => {
    const analytics = (proto as unknown as { analytics?: typeof proto.control }).analytics;

    expect(analytics).toBeDefined();
    if (!analytics) return;

    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, analytics)).toEqual([
      'director:read',
    ]);
    expect(guard.canActivate(ctxFor(analytics, 'director'))).toBe(true);
    expect(() => guard.canActivate(ctxFor(analytics, 'operator'))).toThrow();
    expect(() => guard.canActivate(ctxFor(analytics, 'warehouse'))).toThrow();
  });

  it('analytics documents bearer success and client/auth failures', () => {
    const analytics = (proto as unknown as { analytics?: typeof proto.control }).analytics;

    expect(analytics).toBeDefined();
    if (!analytics) return;

    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, analytics)).toEqual([{ session: [] }]);
    expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, analytics) ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403']),
    );
    expect(Reflect.getMetadata(DECORATORS.API_RESPONSE, analytics)?.['200']?.type).toBe(
      DirectorAnalyticsResponseDto,
    );
  });

  it('operator-roll analytics requires director:read from every non-director role', () => {
    const operatorRolls = (proto as unknown as { operatorRolls?: typeof proto.control })
      .operatorRolls;

    expect(operatorRolls).toBeDefined();
    if (!operatorRolls) return;

    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, operatorRolls)).toEqual([
      'director:read',
    ]);
    expect(guard.canActivate(ctxFor(operatorRolls, 'director'))).toBe(true);
    for (const role of [
      'commercial',
      'production_lead',
      'operator',
      'warehouse',
      'finance',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(operatorRolls, role))).toThrow();
    }
  });

  it('operator-roll analytics documents bearer success and 400/401/403 responses', () => {
    const operatorRolls = (proto as unknown as { operatorRolls?: typeof proto.control })
      .operatorRolls;

    expect(operatorRolls).toBeDefined();
    if (!operatorRolls) return;

    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, operatorRolls)).toEqual([{ session: [] }]);
    expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, operatorRolls) ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403']),
    );
  });

  it('registers both traceability GET routes with director-only access', () => {
    const traceability = proto as unknown as {
      traceabilitySearch?: typeof proto.control;
      traceabilityContext?: typeof proto.control;
    };

    expect(traceability.traceabilitySearch).toBeDefined();
    expect(traceability.traceabilityContext).toBeDefined();
    if (!traceability.traceabilitySearch || !traceability.traceabilityContext) return;

    expect(Reflect.getMetadata(PATH_METADATA, traceability.traceabilitySearch)).toBe(
      'traceability/search',
    );
    expect(Reflect.getMetadata(PATH_METADATA, traceability.traceabilityContext)).toBe(
      'traceability/:objectType/:objectId',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, traceability.traceabilitySearch)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(METHOD_METADATA, traceability.traceabilityContext)).toBe(
      RequestMethod.GET,
    );

    for (const handler of [traceability.traceabilitySearch, traceability.traceabilityContext]) {
      expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'director:read',
      ]);
      expect(guard.canActivate(ctxFor(handler, 'director'))).toBe(true);
      for (const role of [
        'commercial',
        'production_lead',
        'operator',
        'warehouse',
        'finance',
        'admin',
      ] as const) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow();
      }
    }
  });

  it('documents bearer auth and safe traceability response envelopes', () => {
    const traceability = proto as unknown as {
      traceabilitySearch?: typeof proto.control;
      traceabilityContext?: typeof proto.control;
    };
    expect(traceability.traceabilitySearch).toBeDefined();
    expect(traceability.traceabilityContext).toBeDefined();
    if (!traceability.traceabilitySearch || !traceability.traceabilityContext) return;

    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, traceability.traceabilitySearch)).toEqual([
      { session: [] },
    ]);
    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, traceability.traceabilityContext)).toEqual([
      { session: [] },
    ]);
    expect(
      Object.keys(
        Reflect.getMetadata(DECORATORS.API_RESPONSE, traceability.traceabilitySearch) ?? {},
      ),
    ).toEqual(expect.arrayContaining(['200', '400', '401', '403']));
    expect(
      Object.keys(
        Reflect.getMetadata(DECORATORS.API_RESPONSE, traceability.traceabilityContext) ?? {},
      ),
    ).toEqual(expect.arrayContaining(['200', '400', '401', '403', '404']));
  });

  it('exposes endpoint-specific evidence query DTOs to runtime OpenAPI metadata', () => {
    expect(queryMetadata(proto.shiftBalanceEvidence)).toContain(
      DirectorAnalyticsShiftEvidenceQueryDto,
    );
    expect(queryMetadata(proto.bigBagEvidence)).toContain(DirectorAnalyticsBigBagEvidenceQueryDto);
  });

  it('shift and BigBag evidence pages require director:read and document bounded query failures', () => {
    const evidenceProto = proto as unknown as {
      shiftBalanceEvidence?: typeof proto.control;
      bigBagEvidence?: typeof proto.control;
    };

    for (const [methodName, handler] of [
      ['shiftBalanceEvidence', evidenceProto.shiftBalanceEvidence],
      ['bigBagEvidence', evidenceProto.bigBagEvidence],
    ] as const) {
      expect(handler).toBeDefined();
      if (!handler) continue;

      expect(readCapabilities(methodName)).toContain('director:read');
      for (const role of [
        'commercial',
        'production_lead',
        'operator',
        'warehouse',
        'finance',
      ] as const) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow();
      }
      expect(Reflect.getMetadata(DECORATORS.API_SECURITY, handler)).toEqual([{ session: [] }]);
      expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) ?? {})).toEqual(
        expect.arrayContaining(['200', '400', '401', '403']),
      );
    }
  });
});

describe('director inventory access', () => {
  const guard = new CapabilityGuard(new Reflector());
  const handler = DirectorInventoryController.prototype.rawMaterials;
  const context = (role: Role) =>
    ({
      getHandler: () => handler,
      getClass: () => DirectorInventoryController,
      switchToHttp: () => ({
        getRequest: () => ({
          actor: { userId: 'user-1', role, capabilities: capabilitiesForRole(role) },
        }),
      }),
    }) as never;

  it('requires director:read from every routine role', () => {
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'director:read',
    ]);
    expect(guard.canActivate(context('director'))).toBe(true);
    for (const role of [
      'commercial',
      'production_lead',
      'operator',
      'warehouse',
      'finance',
    ] as const) {
      expect(() => guard.canActivate(context(role))).toThrow();
    }
  });

  it('documents a safe authenticated paginated response', () => {
    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, handler)).toEqual([{ session: [] }]);
    expect(Object.keys(Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403']),
    );
  });
});
