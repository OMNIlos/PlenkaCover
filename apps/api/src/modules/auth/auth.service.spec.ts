import { UnauthorizedException } from '@nestjs/common';
import { capabilitiesForRole } from '@plenka/contracts';
import * as password from '../../common/auth/password';
import { AuthService } from './auth.service';

function setup(user: Record<string, unknown> | null) {
  const tx = {
    user: {
      update: jest.fn().mockResolvedValue(user),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    session: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue(user),
    },
    session: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'sess-1',
        purpose: 'full',
        createdAt: new Date('2026-07-14T08:00:00.000Z'),
        expiresAt: new Date('2026-07-14T20:00:00.000Z'),
        revokedAt: null,
        lastSeenAt: new Date('2026-07-14T10:00:00.000Z'),
      }),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const sessions = {
    issue: jest
      .fn()
      .mockResolvedValue({ token: 'tok-123', expiresAt: new Date(Date.now() + 1000) }),
    revoke: jest.fn(),
    revokeAllForUser: jest.fn().mockResolvedValue({ count: 1 }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AuthService(prisma as any, audit as any, sessions as any);
  return { prisma, tx, audit, sessions, service };
}

const activeUser = {
  id: 'u-1',
  login: 'operator',
  role: 'operator',
  displayName: 'Оператор',
  isActive: true,
  passwordHash: password.hashPassword('correct-horse'),
  mustChangePassword: false,
  identityProvider: 'local',
};

const anonymousFailureAudit = {
  type: 'audit:auth_login_failed',
  actorRole: 'admin',
  actorId: null,
  objectId: null,
  reason: 'invalid credentials',
  detail: { source: 'system', subject: 'anonymous_authentication_attempt' },
};

describe('AuthService.login', () => {
  it('issues a session and audits on valid credentials', async () => {
    const { service, sessions, audit } = setup(activeUser);
    const res = await service.login('operator', 'correct-horse');
    expect(res.token).toBe('tok-123');
    expect(res.user).toEqual({ id: 'u-1', role: 'operator', displayName: 'Оператор' });
    expect(sessions.issue).toHaveBeenCalledWith('u-1', expect.anything(), 'full');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:auth_login', actorId: 'u-1' }),
    );
  });

  it('issues only a password_setup session for a temporary-password account', async () => {
    const { service, sessions } = setup({ ...activeUser, mustChangePassword: true });
    const result = await service.login(' OPERATOR ', 'correct-horse');
    expect(sessions.issue).toHaveBeenCalledWith('u-1', expect.anything(), 'password_setup');
    expect(result.passwordChangeRequired).toBe(true);
  });

  it('rejects a wrong password and audits the failure', async () => {
    const { service, audit, sessions } = setup(activeUser);
    await expect(service.login('operator', 'nope')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.issue).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:auth_login_failed' }),
    );
  });

  it('runs the fixed dummy KDF before rejecting an unknown login', async () => {
    const verifier = jest.spyOn(password, 'verifyLoginPassword');
    const { service } = setup(null);
    try {
      await expect(service.login('ghost', 'x')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(verifier).toHaveBeenCalledWith('x', undefined);
    } finally {
      verifier.mockRestore();
    }
  });

  it('runs the fixed dummy KDF before rejecting a malformed login', async () => {
    const verifier = jest.spyOn(password, 'verifyLoginPassword');
    const { service, prisma } = setup(null);
    try {
      await expect(service.login('!', 'x')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(verifier).toHaveBeenCalledWith('x', undefined);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    } finally {
      verifier.mockRestore();
    }
  });

  it('rejects an inactive user', async () => {
    const { service } = setup({ ...activeUser, isActive: false });
    await expect(service.login('operator', 'correct-horse')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a non-local account even when a residual local hash still matches', async () => {
    const verifier = jest.spyOn(password, 'verifyLoginPassword');
    const user = { ...activeUser, identityProvider: 'oidc:example' };
    const { service, sessions } = setup(user);
    try {
      await expect(service.login('operator', 'correct-horse')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(sessions.issue).not.toHaveBeenCalled();
      expect(verifier).toHaveBeenCalledWith('correct-horse', undefined);
    } finally {
      verifier.mockRestore();
    }
  });

  it.each([
    ['malformed login', null, '!', 'malformed-password-sentinel'],
    ['unknown login', null, 'ghost-sentinel', 'unknown-password-sentinel'],
    ['inactive account', { ...activeUser, isActive: false }, 'operator', 'correct-horse'],
    [
      'non-local account',
      { ...activeUser, identityProvider: 'oidc:example' },
      'operator',
      'correct-horse',
    ],
    ['malformed stored hash', { ...activeUser, passwordHash: 'legacy$hash' }, 'operator', 'x'],
    ['wrong password', activeUser, 'operator', 'wrong-password-sentinel'],
  ])('uses the same anonymous system audit I/O for %s', async (_name, user, login, candidate) => {
    const { service, audit, sessions } = setup(user);

    await expect(service.login(login, candidate)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sessions.issue).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(anonymousFailureAudit);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(candidate);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(login);
  });

  it.each([
    ['unknown login', null, 'ghost-sentinel'],
    ['known login', activeUser, 'operator'],
  ])('keeps %s unauthorized when failure-audit persistence fails', async (_name, user, login) => {
    const { service, audit } = setup(user);
    audit.record.mockRejectedValue(new Error('database unavailable'));

    await expect(service.login(login, 'wrong-password-sentinel')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(audit.record).toHaveBeenCalledWith(anonymousFailureAudit);
  });

  it('routes a malformed persisted hash through the valid dummy verifier input', async () => {
    const verifier = jest.spyOn(password, 'verifyLoginPassword');
    const { service } = setup({ ...activeUser, passwordHash: '' });
    try {
      await expect(service.login('operator', 'candidate')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(verifier).toHaveBeenCalledWith('candidate', '');
    } finally {
      verifier.mockRestore();
    }
  });

  it('rejects an IdP-only account that has no local password', async () => {
    const { service } = setup({ ...activeUser, identityProvider: 'oidc:example', passwordHash: null });
    await expect(service.login('operator', 'correct-horse')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AuthService.logout', () => {
  it('revokes the session and audits when the token is valid', async () => {
    const { service, sessions, audit } = setup(activeUser);
    sessions.revoke.mockResolvedValue({ userId: 'u-1', role: 'operator' });
    await expect(service.logout('tok-123')).resolves.toEqual({ ok: true });
    expect(sessions.revoke).toHaveBeenCalledWith('tok-123');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:auth_logout', actorId: 'u-1' }),
    );
  });

  it('is idempotent (no audit) when the token is already invalid', async () => {
    const { service, sessions, audit } = setup(activeUser);
    sessions.revoke.mockResolvedValue(null);
    await expect(service.logout('stale')).resolves.toEqual({ ok: true });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('AuthService.me', () => {
  it('returns truthful account, session and unassigned office context', async () => {
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-07-14T12:00:00.000Z').getTime());
    try {
      const { service, prisma } = setup(activeUser);
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser,
        role: 'commercial',
        displayName: 'Ирина Коммерция',
      });
      const actor = {
        userId: 'u-1',
        role: 'commercial' as const,
        capabilities: capabilitiesForRole('commercial'),
        sessionId: 'sess-1',
        sessionPurpose: 'full' as const,
      };
      const me = await service.me(actor);
      expect(me).toEqual({
        userId: 'u-1',
        role: 'commercial',
        capabilities: capabilitiesForRole('commercial'),
        displayName: 'Ирина Коммерция',
        isActive: true,
        sessionPurpose: 'full',
        session: {
          id: 'sess-1',
          purpose: 'full',
          state: 'active',
          createdAt: new Date('2026-07-14T08:00:00.000Z'),
          expiresAt: new Date('2026-07-14T20:00:00.000Z'),
          lastSeenAt: new Date('2026-07-14T10:00:00.000Z'),
        },
        workContext: { kind: 'office', assignment: null },
        passwordChangeRequired: false,
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-1' } });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('AuthService.changePassword', () => {
  const setupActor = {
    userId: 'u-1',
    role: 'operator' as const,
    capabilities: [],
    sessionId: 'sess-setup',
    sessionPurpose: 'password_setup' as const,
  };

  it('changes a temporary password, revokes sessions and audits without secret material', async () => {
    const user = { ...activeUser, mustChangePassword: true };
    const { service, tx, sessions, audit } = setup(user);
    await expect(service.changePassword(setupActor, { newPassword: '4826' })).resolves.toEqual({
      ok: true,
      reauthenticationRequired: true,
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'u-1',
        isActive: true,
        identityProvider: 'local',
        mustChangePassword: true,
        passwordHash: user.passwordHash,
      },
      data: {
        passwordHash: expect.stringMatching(/^scrypt\$/),
        mustChangePassword: false,
        passwordChangedAt: expect.any(Date),
      },
    });
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u-1', tx);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:password_changed',
        actorId: 'u-1',
        objectId: 'u-1',
      }),
      tx,
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('4826');
  });

  it('requires and verifies the current password for a full session', async () => {
    const actor = { ...setupActor, sessionPurpose: 'full' as const };
    const { service } = setup(activeUser);
    await expect(
      service.changePassword(actor, { newPassword: 'a-secure-new-password' }),
    ).rejects.toBeDefined();
    await expect(
      service.changePassword(actor, {
        currentPassword: 'wrong-password',
        newPassword: 'a-secure-new-password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects reuse of the current or temporary password', async () => {
    const { service } = setup({ ...activeUser, mustChangePassword: true });
    await expect(
      service.changePassword(setupActor, { newPassword: 'correct-horse' }),
    ).rejects.toBeDefined();
  });

  it('rejects a stale concurrent password change before overwriting the winner', async () => {
    const user = { ...activeUser, mustChangePassword: true };
    const { service, tx, sessions, audit } = setup(user);
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.changePassword(setupActor, { newPassword: 'a-secure-new-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
