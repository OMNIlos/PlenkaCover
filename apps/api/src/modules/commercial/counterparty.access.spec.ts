import { Reflector } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { CounterpartyController } from './counterparty.controller';
import { capabilitiesForRole, type Capability } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';

function ctxFor(
  handler: (...args: any[]) => unknown,
  role: 'operator' | 'warehouse' | 'commercial',
) {
  return {
    getHandler: () => handler,
    getClass: () => CounterpartyController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: null, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('counterparty role-leakage', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = CounterpartyController.prototype;

  it('operator cannot create a counterparty', () => {
    expect(() => guard.canActivate(ctxFor(proto.create, 'operator'))).toThrow();
  });

  it('commercial CAN create a counterparty', () => {
    expect(guard.canActivate(ctxFor(proto.create, 'commercial'))).toBe(true);
  });

  it('all counterparty routes declare a capability', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.list)).toEqual(['order:read']);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.search)).toEqual(['order:read']);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.create)).toEqual([
      'order:create',
    ]);
  });

  it('publishes bounded search as a static GET route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto.search)).toBe('search');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.search)).toBe(RequestMethod.GET);
  });
});
