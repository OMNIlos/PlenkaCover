import { UnauthorizedException } from '@nestjs/common';
import { capabilitiesForRole } from '@plenka/contracts';
import { AuthController } from './auth.controller';

function setup() {
  const service = {
    login: jest.fn().mockResolvedValue({ token: 't' }),
    logout: jest.fn().mockResolvedValue({ ok: true }),
    me: jest.fn().mockResolvedValue({ userId: 'u-1' }),
    changePassword: jest.fn().mockResolvedValue({ ok: true, reauthenticationRequired: true }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service, controller: new AuthController(service as any) };
}

describe('AuthController', () => {
  it('login delegates credentials + request meta to the service', () => {
    const { controller, service } = setup();
    void controller.login({ login: 'operator', password: 'pw' }, '127.0.0.1', 'jest');
    expect(service.login).toHaveBeenCalledWith('operator', 'pw', {
      ip: '127.0.0.1',
      userAgent: 'jest',
    });
  });

  it('logout forwards the extracted bearer token', () => {
    const { controller, service } = setup();
    void controller.logout('Bearer tok-9');
    expect(service.logout).toHaveBeenCalledWith('tok-9');
  });

  it('me throws 401 when there is no actor', () => {
    const { controller } = setup();
    expect(() => controller.me(undefined)).toThrow(UnauthorizedException);
  });

  it('me delegates to the service when an actor is present', () => {
    const { controller, service } = setup();
    const actor = {
      userId: 'u-1',
      role: 'operator' as const,
      capabilities: capabilitiesForRole('operator'),
    };
    void controller.me(actor);
    expect(service.me).toHaveBeenCalledWith(actor);
  });

  it('changePassword rejects an actor-less request and delegates authenticated actors', () => {
    const { controller, service } = setup();
    expect(() =>
      controller.changePassword({ newPassword: 'a-secure-new-password' }, undefined),
    ).toThrow(UnauthorizedException);
    const actor = {
      userId: 'u-1',
      role: 'operator' as const,
      capabilities: [],
      sessionId: 'sess-setup',
      sessionPurpose: 'password_setup' as const,
    };
    void controller.changePassword({ newPassword: 'a-secure-new-password' }, actor);
    expect(service.changePassword).toHaveBeenCalledWith(actor, {
      newPassword: 'a-secure-new-password',
    });
  });
});
