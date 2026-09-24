import { SessionService } from './session.service';
import { loadRuntimeConfig, type RuntimeConfig } from '../runtime-config';

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    userId: 'u-1',
    tokenHash: 'unused',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastSeenAt: new Date(),
    userAgent: null,
    ip: null,
    purpose: 'full',
    user: {
      id: 'u-1',
      role: 'operator',
      isActive: true,
      mustChangePassword: false,
      capabilityOverrides: [{ capability: 'finance_order:read', effect: 'allow' }],
    },
    ...overrides,
  };
}

function setup(
  row: ReturnType<typeof sessionRow> | null = sessionRow(),
  config: RuntimeConfig = loadRuntimeConfig({ APP_ENV: 'test' }),
) {
  const prisma = {
    session: {
      create: jest.fn().mockResolvedValue({ id: 'sess-new' }),
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({ id: 'sess-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'sess-1',
          purpose: 'full',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
          lastSeenAt: new Date(),
          userAgent: 'jest',
          ip: '127.0.0.1',
        },
      ]),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma, service: new SessionService(prisma as any, config) };
}

describe('SessionService', () => {
  it('hashToken: deterministic sha256 hex, not the raw token', () => {
    const { service } = setup();
    const h = service.hashToken('abc');
    expect(h).toBe(service.hashToken('abc'));
    expect(h).not.toBe('abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issue: returns a token + future expiry and stores only the hash', async () => {
    const { prisma, service } = setup();
    const { token, expiresAt } = await service.issue('u-1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const stored = prisma.session.create.mock.calls[0][0].data.tokenHash;
    expect(stored).toBe(service.hashToken(token));
    expect(stored).not.toBe(token);
  });

  it('issue: uses the validated TTL for each session purpose', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const config = loadRuntimeConfig({
        APP_ENV: 'test',
        PASSWORD_SETUP_TTL: '900',
        SESSION_TTL: '3600',
      });
      await expect(
        setup(sessionRow(), config).service.issue('u-1', {}, 'full'),
      ).resolves.toMatchObject({ expiresAt: new Date(1_000_000 + 3_600_000) });
      await expect(
        setup(sessionRow(), config).service.issue('u-1', {}, 'password_setup'),
      ).resolves.toMatchObject({ expiresAt: new Date(1_000_000 + 900_000) });
    } finally {
      now.mockRestore();
    }
  });

  it('validate: returns the purpose and overrides for an active session', async () => {
    const { service } = setup();
    await expect(service.validate('t')).resolves.toEqual({
      sessionId: 'sess-1',
      userId: 'u-1',
      role: 'operator',
      purpose: 'full',
      overrides: [{ capability: 'finance_order:read', effect: 'allow' }],
    });
  });

  it('validate: rejects a session whose purpose does not match password state', async () => {
    await expect(
      setup(
        sessionRow({
          user: {
            id: 'u-1',
            role: 'operator',
            isActive: true,
            mustChangePassword: true,
            capabilityOverrides: [],
          },
        }),
      ).service.validate('t'),
    ).resolves.toBeNull();
    await expect(
      setup(sessionRow({ purpose: 'password_setup' })).service.validate('t'),
    ).resolves.toBeNull();
  });

  it('validate: refreshes lastSeenAt only when older than five minutes', async () => {
    const fresh = setup(sessionRow({ lastSeenAt: new Date() }));
    await fresh.service.validate('t');
    expect(fresh.prisma.session.update).not.toHaveBeenCalled();

    const stale = setup(sessionRow({ lastSeenAt: new Date(Date.now() - 301_000) }));
    await stale.service.validate('t');
    expect(stale.prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { lastSeenAt: expect.any(Date) },
    });
  });

  it('validate: null for revoked / expired / inactive / unknown', async () => {
    await expect(
      setup(sessionRow({ revokedAt: new Date() })).service.validate('t'),
    ).resolves.toBeNull();
    await expect(
      setup(sessionRow({ expiresAt: new Date(Date.now() - 1000) })).service.validate('t'),
    ).resolves.toBeNull();
    await expect(
      setup(
        sessionRow({
          user: {
            id: 'u-1',
            role: 'operator',
            isActive: false,
            mustChangePassword: false,
            capabilityOverrides: [],
          },
        }),
      ).service.validate('t'),
    ).resolves.toBeNull();
    await expect(setup(null).service.validate('t')).resolves.toBeNull();
  });

  it('revoke: marks an active session revoked and returns its actor', async () => {
    const { prisma, service } = setup();
    await expect(service.revoke('t')).resolves.toEqual({ userId: 'u-1', role: 'operator' });
    expect(prisma.session.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
  });

  it('revoke: null when the token is unknown', async () => {
    await expect(setup(null).service.revoke('t')).resolves.toBeNull();
  });

  it('lists only safe session metadata', async () => {
    const { service, prisma } = setup();
    const sessions = await service.listForUser('u-1');
    expect(prisma.session.findMany.mock.calls[0][0].select.tokenHash).toBeUndefined();
    expect(JSON.stringify(sessions)).not.toContain('tokenHash');
  });

  it('revokes one owned session or all active sessions', async () => {
    const { service, prisma } = setup();
    await expect(service.revokeById('u-1', 'sess-1')).resolves.toBe(true);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', userId: 'u-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    await expect(service.revokeAllForUser('u-1')).resolves.toEqual({ count: 1 });
  });
});
