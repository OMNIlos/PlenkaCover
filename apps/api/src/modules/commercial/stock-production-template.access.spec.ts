import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { StockProductionTemplateController } from './stock-production-template.controller';

function contextFor(handler: (...args: never[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => StockProductionTemplateController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-1`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('stock production template access', () => {
  const reflector = new Reflector();
  const guard = new CapabilityGuard(reflector);
  const proto = StockProductionTemplateController.prototype;

  it('declares the exact read and write capabilities on every route', () => {
    const readCapabilities = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.list);
    const createCapabilities = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.create);
    const updateCapabilities = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.update);

    expect(readCapabilities).toEqual(['stock_production_template:read']);
    expect(createCapabilities).toEqual(['stock_production_template:write']);
    expect(updateCapabilities).toEqual(['stock_production_template:write']);
  });

  it('allows commercial to read but denies catalog writes', () => {
    expect(guard.canActivate(contextFor(proto.list, 'commercial'))).toBe(true);
    expect(() => guard.canActivate(contextFor(proto.create, 'commercial'))).toThrow();
    expect(() => guard.canActivate(contextFor(proto.update, 'commercial'))).toThrow();
  });

  it('allows production lead to read, create and update the catalog', () => {
    expect(guard.canActivate(contextFor(proto.list, 'production_lead'))).toBe(true);
    expect(guard.canActivate(contextFor(proto.create, 'production_lead'))).toBe(true);
    expect(guard.canActivate(contextFor(proto.update, 'production_lead'))).toBe(true);
  });

  it.each<Role>(['warehouse', 'operator', 'finance', 'director', 'admin'])(
    'denies %s without an explicit capability grant',
    (role) => {
      expect(() => guard.canActivate(contextFor(proto.list, role))).toThrow();
      expect(() => guard.canActivate(contextFor(proto.create, role))).toThrow();
      expect(() => guard.canActivate(contextFor(proto.update, role))).toThrow();
    },
  );
});
