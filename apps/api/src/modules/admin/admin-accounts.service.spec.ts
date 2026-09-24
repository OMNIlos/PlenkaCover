import { ForbiddenException } from '@nestjs/common';
import { ROLE_CAPABILITIES, type Capability } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { AccessPolicyService } from '../../common/auth/access-policy.service';
import { verifyPassword } from '../../common/auth/password';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminPrivilegeCeilingService } from './admin-privilege-ceiling.service';

const actor = {
  userId: 'admin-1',
  role: 'admin' as const,
  capabilities: ROLE_CAPABILITIES.admin,
};

function denials(...capabilities: Capability[]) {
  return capabilities.map((capability) => ({
    capability,
    effect: 'deny',
    reason: 'Restricted authority',
  }));
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    externalId: null,
    login: 'operator',
    identityProvider: 'local',
    displayName: 'Operator',
    role: 'operator' as const,
    isActive: true,
    mustChangePassword: false,
    passwordChangedAt: null,
    lastLoginAt: null,
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    capabilityOverrides: [],
    sessions: [],
    ...overrides,
  };
}

function adminRow(id = 'admin-1', capabilityOverrides: ReturnType<typeof denials> = []) {
  return userRow({
    id,
    login: id,
    displayName: id,
    role: 'admin',
    capabilityOverrides,
  });
}

interface SetupOptions {
  authority?: ReturnType<typeof userRow> | null;
  target?: ReturnType<typeof userRow>;
  auditFailure?: Error;
}

function setup(options: SetupOptions = {}) {
  const authority = options.authority === undefined ? adminRow() : options.authority;
  const target = options.target ?? userRow();
  const rows = new Map<string, ReturnType<typeof userRow>>();
  if (authority) rows.set(authority.id, authority);
  rows.set(target.id, target);

  const tx = {
    user: {
      create: jest.fn().mockImplementation(({ data }) => {
        const created = userRow({ id: 'created-user', ...data });
        rows.set(created.id, created);
        return created;
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => rows.get(where.id) ?? null),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const current = rows.get(where.id);
        if (!current) return null;
        const updated = { ...current, ...data, updatedAt: new Date() };
        rows.set(where.id, updated);
        return updated;
      }),
      findMany: jest.fn().mockResolvedValue([adminRow('admin-2')]),
    },
  };
  const prisma = {
    user: {
      findMany: jest.fn().mockResolvedValue([target]),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockImplementation(({ where }) => rows.get(where.id) ?? null),
    },
    $transaction: jest.fn((work: (client: typeof tx) => unknown, _options?: unknown) => work(tx)),
  };
  const audit = {
    record: options.auditFailure
      ? jest.fn().mockRejectedValue(options.auditFailure)
      : jest.fn().mockResolvedValue({ id: 'event-1' }),
  };
  const sessions = {
    revokeAllForUser: jest.fn().mockResolvedValue({ count: 2 }),
    revokeById: jest.fn().mockResolvedValue(true),
    listForUser: jest.fn().mockResolvedValue([{ id: 'sess-1', purpose: 'full' }]),
  };
  const safety = { assertControlAdminRemains: jest.fn().mockResolvedValue(undefined) };
  const accessPolicy = new AccessPolicyService();
  const ceiling = new AdminPrivilegeCeilingService(accessPolicy);
  const service = new AdminAccountsService(
    prisma as never,
    audit as never,
    accessPolicy,
    sessions as never,
    safety as never,
    ceiling,
  );
  return { service, prisma, tx, audit, sessions, safety, rows };
}

describe('AdminAccountsService', () => {
  it('lists only the explicit safe user projection', async () => {
    const { service, prisma } = setup();
    const result = await service.list({});
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    const select = prisma.user.findMany.mock.calls[0][0].select;
    expect(select.passwordHash).toBeUndefined();
    expect(select.sessions.select.tokenHash).toBeUndefined();
  });

  it('creates a password-setup account with fresh authority and secret-free transactional audit', async () => {
    const { service, prisma, tx, audit } = setup();
    const result = await service.create(actor, {
      login: ' New.Operator ',
      displayName: 'Новый оператор',
      role: 'operator',
    });
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      login: 'new.operator',
      mustChangePassword: true,
      identityProvider: 'local',
    });
    expect(result.temporaryPassword).toHaveLength(24);
    expect(verifyPassword(result.temporaryPassword, data.passwordHash)).toBe(true);
    expect(tx.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'admin-1' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin.user.created',
        actorId: 'admin-1',
        actorRole: 'admin',
        newValue: expect.objectContaining({
          identityProvider: 'local',
          isActive: true,
          mustChangePassword: true,
        }),
      }),
      tx,
    );
    const serializedAudit = JSON.stringify(audit.record.mock.calls[0][0]);
    expect(serializedAudit.includes(result.temporaryPassword)).toBe(false);
    expect(serializedAudit.includes(data.passwordHash)).toBe(false);
    expect(serializedAudit).not.toMatch(/passwordHash|temporaryPassword|tokenHash|token/i);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it.each([
    [
      'create',
      (service: AdminAccountsService) =>
        service.create(actor, { login: 'new.user', displayName: 'New User', role: 'operator' }),
    ],
    [
      'profile update',
      (service: AdminAccountsService) =>
        service.updateProfile(actor, 'u1', {
          displayName: 'Updated',
          reason: 'Profile correction',
        }),
    ],
    ['block', (service: AdminAccountsService) => service.block(actor, 'u1', 'Employment ended')],
    [
      'reactivate',
      (service: AdminAccountsService) => service.reactivate(actor, 'u1', 'Returned to work'),
    ],
    [
      'password reset',
      (service: AdminAccountsService) => service.resetPassword(actor, 'u1', 'Credential recovery'),
    ],
    [
      'session revoke',
      (service: AdminAccountsService) =>
        service.revokeSessions(actor, 'u1', { reason: 'Access review' }),
    ],
  ])('rejects %s when fresh DB authority has only admin:users', async (_label, operation) => {
    const onlyUsers = denials(
      ...ROLE_CAPABILITIES.admin.filter((capability) => capability !== 'admin:users'),
    );
    const { service, tx, audit } = setup({ authority: adminRow('admin-1', onlyUsers) });

    await expect(operation(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    [
      'profile update',
      (service: AdminAccountsService) =>
        service.updateProfile(actor, 'peer-admin', {
          displayName: 'Updated',
          reason: 'Profile correction',
        }),
      true,
    ],
    [
      'block',
      (service: AdminAccountsService) => service.block(actor, 'peer-admin', 'Employment ended'),
      true,
    ],
    [
      'reactivate',
      (service: AdminAccountsService) =>
        service.reactivate(actor, 'peer-admin', 'Returned to work'),
      false,
    ],
    [
      'password reset',
      (service: AdminAccountsService) =>
        service.resetPassword(actor, 'peer-admin', 'Credential recovery'),
      true,
    ],
    [
      'session revoke',
      (service: AdminAccountsService) =>
        service.revokeSessions(actor, 'peer-admin', { reason: 'Access review' }),
      true,
    ],
  ])('rejects restricted-admin %s against a superior peer', async (_label, operation, isActive) => {
    const { service, tx, audit } = setup({
      authority: adminRow('admin-1', denials('admin:diagnostics')),
      target: { ...adminRow('peer-admin'), isActive },
    });

    await expect(operation(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lets a restricted actor reset an equal peer and itself', async () => {
    const actorPolicy = denials('admin:diagnostics');
    const equalPeer = setup({
      authority: adminRow('admin-1', actorPolicy),
      target: adminRow('peer-admin', actorPolicy),
    });
    await expect(
      equalPeer.service.resetPassword(actor, 'peer-admin', 'Equal peer recovery'),
    ).resolves.toMatchObject({ user: { id: 'peer-admin' } });

    const self = setup({
      authority: adminRow('admin-1', actorPolicy),
      target: adminRow('admin-1', actorPolicy),
    });
    await expect(
      self.service.resetPassword(actor, 'admin-1', 'Self credential recovery'),
    ).resolves.toMatchObject({ user: { id: 'admin-1' } });
  });

  it('lets a full admin reset and reactivate a full-admin peer with append-only audit', async () => {
    const reset = setup({ target: adminRow('peer-admin') });
    await reset.service.resetPassword(actor, 'peer-admin', 'Credential recovery');
    expect(reset.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.user.password_reset' }),
      reset.tx,
    );

    const reactivate = setup({
      target: { ...adminRow('peer-admin'), isActive: false },
    });
    await reactivate.service.reactivate(actor, 'peer-admin', 'Returned to work');
    expect(reactivate.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.user.reactivated' }),
      reactivate.tx,
    );
  });

  it('binds every profile, block and session mutation audit to the serializable transaction', async () => {
    const cases: Array<{
      event: string;
      run: (service: AdminAccountsService) => Promise<unknown>;
    }> = [
      {
        event: 'admin.user.profile_updated',
        run: (service) =>
          service.updateProfile(actor, 'u1', {
            displayName: 'Updated',
            reason: 'Profile correction',
          }),
      },
      {
        event: 'admin.user.blocked',
        run: (service) => service.block(actor, 'u1', 'Employment ended'),
      },
      {
        event: 'audit:session_revoked',
        run: (service) => service.revokeSessions(actor, 'u1', { reason: 'Access review' }),
      },
    ];

    for (const item of cases) {
      const current = setup();
      await item.run(current.service);
      expect(current.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ type: item.event }),
        current.tx,
      );
      expect(current.prisma.$transaction.mock.calls[0][1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    }
  });

  it('keeps password-reset audit free of the returned password and stored hash', async () => {
    const { service, tx, audit } = setup({
      target: userRow({
        identityProvider: 'oidc:example',
        mustChangePassword: false,
        passwordChangedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
    });
    const result = await service.resetPassword(actor, 'u1', 'Credential recovery');
    const update = tx.user.update.mock.calls.at(-1)?.[0];
    expect(verifyPassword(result.temporaryPassword, update.data.passwordHash)).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin.user.password_reset',
        oldValue: {
          identityProvider: 'oidc:example',
          mustChangePassword: false,
          passwordChangedAt: '2026-07-01T00:00:00.000Z',
        },
        newValue: {
          identityProvider: 'local',
          mustChangePassword: true,
          passwordChangedAt: null,
        },
      }),
      tx,
    );
    const serializedAudit = JSON.stringify(audit.record.mock.calls[0][0]);
    expect(serializedAudit.includes(result.temporaryPassword)).toBe(false);
    expect(serializedAudit.includes(update.data.passwordHash)).toBe(false);
  });

  it('propagates audit failure from inside the mutation transaction', async () => {
    const { service, tx } = setup({ auditFailure: new Error('forced audit failure') });
    await expect(
      service.updateProfile(actor, 'u1', {
        displayName: 'Must Roll Back',
        reason: 'Audit rollback proof',
      }),
    ).rejects.toThrow('forced audit failure');
    expect(tx.user.update).toHaveBeenCalled();
  });

  it('lists and revokes safe session metadata with one audit fact', async () => {
    const { service, sessions, audit, tx } = setup();
    await expect(service.listSessions('u1')).resolves.toEqual([{ id: 'sess-1', purpose: 'full' }]);
    await expect(
      service.revokeSessions(actor, 'u1', { sessionId: 'sess-1', reason: 'Lost device' }),
    ).resolves.toEqual({ ok: true, revokedCount: 1 });
    expect(sessions.revokeById).toHaveBeenCalledWith('u1', 'sess-1', tx);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:session_revoked', reason: 'Lost device' }),
      tx,
    );
  });
});
