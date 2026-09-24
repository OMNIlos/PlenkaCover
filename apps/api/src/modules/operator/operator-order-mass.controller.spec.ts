import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { OperatorOrderMassController } from './operator-order-mass.controller';

function contextFor(role: Role) {
  return {
    getHandler: () => OperatorOrderMassController.prototype.get,
    getClass: () => OperatorOrderMassController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-1`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('OperatorOrderMassController contract', () => {
  it('exposes one exact GET route guarded by operator_task:read', () => {
    const reflector = new Reflector();

    expect(reflector.get(PATH_METADATA, OperatorOrderMassController)).toBe('operator/orders');
    expect(reflector.get(PATH_METADATA, OperatorOrderMassController.prototype.get)).toBe(
      ':orderNumber/mass-summary',
    );
    expect(reflector.get(METHOD_METADATA, OperatorOrderMassController.prototype.get)).toBe(
      RequestMethod.GET,
    );
    expect(
      reflector.get<Capability[]>(REQUIRE_CAPABILITIES, OperatorOrderMassController.prototype.get),
    ).toEqual(['operator_task:read']);
  });

  it('allows the operator role and rejects every other role', () => {
    const guard = new CapabilityGuard(new Reflector());

    expect(guard.canActivate(contextFor('operator'))).toBe(true);
    for (const role of [
      'commercial',
      'production_lead',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(contextFor(role))).toThrow();
    }
  });
});
