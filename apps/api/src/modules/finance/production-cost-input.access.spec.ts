import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, ROLES, type Capability, type Role } from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { ProductionCostInputController } from './production-cost-input.controller';

function contextFor(handler: (...args: never[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => ProductionCostInputController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-user`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('production cost input access', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = ProductionCostInputController.prototype;

  it.each([
    ['material-prices', proto.setMaterialPrice],
    ['additional', proto.recordAdditionalCost],
  ])('registers POST /finance/production-costs/%s for finance only', (path, handler) => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(new Reflector().get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
      'material_cost:manage',
    ]);
    expect(guard.canActivate(contextFor(handler as never, 'finance'))).toBe(true);
    for (const role of ROLES.filter((candidate) => candidate !== 'finance')) {
      expect(() => guard.canActivate(contextFor(handler as never, role))).toThrow();
    }
  });
});
