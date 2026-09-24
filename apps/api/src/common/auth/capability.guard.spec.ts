import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { capabilitiesForRole } from '@plenka/contracts';
import type { Actor } from './actor';
import { CapabilityGuard } from './capability.guard';

function contextWith(actor?: Actor): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ actor }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function guardRequiring(...caps: string[]): CapabilityGuard {
  const reflector = {
    getAllAndOverride: (key: string) => (key === 'require_capabilities' ? caps : undefined),
  } as unknown as Reflector;
  return new CapabilityGuard(reflector);
}

function oneCRuntimeGuard(liveEnabled: boolean): CapabilityGuard {
  const reflector = {
    getAllAndOverride: (key: string) => (key === 'require_onec_runtime' ? true : []),
  } as unknown as Reflector;
  const Guard = CapabilityGuard as unknown as new (
    reflector: Reflector,
    config: { onecLiveEnabled: boolean },
  ) => CapabilityGuard;
  return new Guard(reflector, { onecLiveEnabled: liveEnabled });
}

const operator: Actor = {
  userId: null,
  role: 'operator',
  capabilities: capabilitiesForRole('operator'),
};

const commercial: Actor = {
  userId: null,
  role: 'commercial',
  capabilities: capabilitiesForRole('commercial'),
};

describe('CapabilityGuard', () => {
  it('allows routes with no required capabilities', () => {
    const guard = guardRequiring();
    expect(guard.canActivate(contextWith())).toBe(true);
  });

  it('rejects a missing actor without exposing the development auth mechanism', () => {
    const guard = guardRequiring('order:create');
    try {
      guard.canActivate(contextWith(undefined));
      throw new Error('expected CapabilityGuard to reject a missing actor');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        message: 'Требуется аутентификация.',
      });
      expect(JSON.stringify((error as UnauthorizedException).getResponse())).not.toContain(
        'x-role',
      );
    }
  });

  it('allows when the actor holds the capability', () => {
    const guard = guardRequiring('roll:weigh');
    expect(guard.canActivate(contextWith(operator))).toBe(true);
  });

  // Role-leakage regression (ТЗ §11): operator must NOT reach finance actions.
  it('forbids when the actor is missing the capability', () => {
    const guard = guardRequiring('payment:update');
    expect(() => guard.canActivate(contextWith(operator))).toThrow(ForbiddenException);
  });

  it('allows commercial safe performance reads without granting director access', () => {
    const performanceGuard = guardRequiring('business_performance:read');
    const directorGuard = guardRequiring('director:read');

    expect(performanceGuard.canActivate(contextWith(commercial))).toBe(true);
    expect(() => performanceGuard.canActivate(contextWith(operator))).toThrow(ForbiddenException);
    expect(() => directorGuard.canActivate(contextWith(commercial))).toThrow(ForbiddenException);
  });

  it('hides every marked 1C route when the runtime integration is disabled', () => {
    expect(() => oneCRuntimeGuard(false).canActivate(contextWith())).toThrow(NotFoundException);
    expect(oneCRuntimeGuard(true).canActivate(contextWith())).toBe(true);
  });
});
