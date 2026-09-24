import { AccessPolicyService } from './access-policy.service';
import { SessionAuthMiddleware } from './session-auth.middleware';
import type { SessionService } from './session.service';

function mw(
  validateResult: {
    sessionId: string;
    userId: string;
    role: 'operator';
    purpose: 'full' | 'password_setup';
    overrides: Array<{ capability: string; effect: string }>;
  } | null,
) {
  const sessions = { validate: jest.fn().mockResolvedValue(validateResult) };
  return {
    sessions,
    middleware: new SessionAuthMiddleware(
      sessions as unknown as SessionService,
      new AccessPolicyService(),
    ),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reqWith = (authorization?: string): any => ({
  headers: authorization ? { authorization } : {},
});

describe('SessionAuthMiddleware', () => {
  it('sets actor (role + capabilities) for a valid bearer session', async () => {
    const { middleware, sessions } = mw({
      sessionId: 'sess-1',
      userId: 'u-1',
      role: 'operator',
      purpose: 'full',
      overrides: [{ capability: 'finance_order:read', effect: 'allow' }],
    });
    const req = reqWith('Bearer good');
    const next = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await middleware.use(req, {} as any, next);
    expect(sessions.validate).toHaveBeenCalledWith('good');
    expect(req.actor).toEqual({
      userId: 'u-1',
      role: 'operator',
      capabilities: expect.arrayContaining(['roll:weigh', 'finance_order:read']),
      sessionId: 'sess-1',
      sessionPurpose: 'full',
    });
    expect(next).toHaveBeenCalled();
  });

  it('gives a password setup session no ERP capabilities', async () => {
    const { middleware } = mw({
      sessionId: 'sess-setup',
      userId: 'u-1',
      role: 'operator',
      purpose: 'password_setup',
      overrides: [{ capability: 'finance_order:read', effect: 'allow' }],
    });
    const req = reqWith('Bearer setup');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await middleware.use(req, {} as any, jest.fn());
    expect(req.actor).toEqual({
      userId: 'u-1',
      role: 'operator',
      capabilities: [],
      sessionId: 'sess-setup',
      sessionPurpose: 'password_setup',
    });
  });

  it('sets no actor for an invalid/expired token', async () => {
    const { middleware } = mw(null);
    const req = reqWith('Bearer stale');
    const next = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await middleware.use(req, {} as any, next);
    expect(req.actor).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('does not touch the session store without a bearer header', async () => {
    const { middleware, sessions } = mw({
      sessionId: 'sess-1',
      userId: 'u',
      role: 'operator',
      purpose: 'full',
      overrides: [],
    });
    const req = reqWith();
    const next = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await middleware.use(req, {} as any, next);
    expect(sessions.validate).not.toHaveBeenCalled();
    expect(req.actor).toBeUndefined();
  });
});
