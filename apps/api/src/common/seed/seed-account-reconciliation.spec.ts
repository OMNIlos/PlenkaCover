import { Role } from '@prisma/client';
import { hashPassword, verifyPassword } from '../auth/password';
import {
  SeedAccountConflictError,
  reconcileSeedAccounts,
  type SeedAccountManifestEntry,
} from './seed-account-reconciliation';

type PasswordKey = 'operator-password' | 'warehouse-password';

interface SeedUser {
  displayName: string;
  externalId: string | null;
  id: string;
  identityProvider: string;
  isActive: boolean;
  login: string;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  passwordHash: string | null;
  role: Role;
}

interface SeedSession {
  id: string;
  revokedAt: Date | null;
  userId: string;
}

const PASSWORDS: Record<PasswordKey, string> = {
  'operator-password': 'operator-password-2026',
  'warehouse-password': 'warehouse-password-2026',
};

const OPERATOR_ACCOUNT: SeedAccountManifestEntry<PasswordKey> = {
  externalId: 'seed-operator',
  login: 'ахметов булат',
  displayName: 'Ахметов Булат',
  role: Role.operator,
  passwordKey: 'operator-password',
};

const WAREHOUSE_ACCOUNT: SeedAccountManifestEntry<PasswordKey> = {
  externalId: 'seed-warehouse',
  login: 'склад',
  displayName: 'Склад',
  role: Role.warehouse,
  passwordKey: 'warehouse-password',
};

function seedUser(overrides: Partial<SeedUser> = {}): SeedUser {
  return {
    id: 'user-1',
    externalId: OPERATOR_ACCOUNT.externalId,
    login: OPERATOR_ACCOUNT.login,
    passwordHash: hashPassword(PASSWORDS[OPERATOR_ACCOUNT.passwordKey]),
    identityProvider: 'local',
    displayName: OPERATOR_ACCOUNT.displayName,
    role: OPERATOR_ACCOUNT.role,
    isActive: true,
    mustChangePassword: false,
    passwordChangedAt: null,
    ...overrides,
  };
}

function activeSession(userId: string, id = `session-${userId}`): SeedSession {
  return { id, userId, revokedAt: null };
}

function createHarness(initialUsers: SeedUser[] = [], initialSessions: SeedSession[] = []) {
  const users = initialUsers.map((user) => ({ ...user }));
  const sessions = initialSessions.map((session) => ({ ...session }));
  const failedExternalIdLookups = new Set<string>();
  let nextUserId = users.length + 1;

  function assertUniqueIdentity(id: string | null, login: string, externalId: string | null): void {
    if (users.some((user) => user.id !== id && user.login === login)) {
      throw new Error(`Unique login constraint failed: ${login}`);
    }
    if (
      externalId !== null &&
      users.some((user) => user.id !== id && user.externalId === externalId)
    ) {
      throw new Error(`Unique externalId constraint failed: ${externalId}`);
    }
  }

  const userCreate = jest.fn(
    async ({ data }: { data: Omit<SeedUser, 'id' | 'passwordChangedAt'> }) => {
      assertUniqueIdentity(null, data.login, data.externalId);
      const created: SeedUser = {
        ...data,
        id: `created-user-${nextUserId++}`,
        passwordChangedAt: null,
      };
      users.push(created);
      return created;
    },
  );
  const userUpdate = jest.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<SeedUser> }) => {
      const user = users.find((candidate) => candidate.id === where.id);
      if (!user) throw new Error(`Test user not found: ${where.id}`);
      assertUniqueIdentity(
        user.id,
        data.login ?? user.login,
        data.externalId === undefined ? user.externalId : data.externalId,
      );
      Object.assign(user, data);
      return user;
    },
  );
  const userDelete = jest.fn();
  const userDeleteMany = jest.fn();
  const sessionUpdateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { revokedAt?: Date | null; userId?: string };
      data: { revokedAt: Date };
    }) => {
      let count = 0;
      for (const session of sessions) {
        if (where.userId !== undefined && session.userId !== where.userId) continue;
        if (
          where.revokedAt !== undefined &&
          (where.revokedAt === null
            ? session.revokedAt !== null
            : session.revokedAt?.getTime() !== where.revokedAt.getTime())
        ) {
          continue;
        }
        session.revokedAt = data.revokedAt;
        count += 1;
      }
      return { count };
    },
  );
  const userFindUnique = jest.fn(
    async ({
      where,
    }: {
      where: { externalId?: string; login?: string };
    }): Promise<SeedUser | null> => {
      if (where.externalId !== undefined && failedExternalIdLookups.has(where.externalId)) {
        throw new Error(`External ID lookup failed: ${where.externalId}`);
      }
      if (where.login !== undefined) {
        return users.find((user) => user.login === where.login) ?? null;
      }
      return users.find((user) => user.externalId === where.externalId) ?? null;
    },
  );

  return {
    failedExternalIdLookups,
    prisma: {
      user: {
        findUnique: userFindUnique,
        create: userCreate,
        update: userUpdate,
        delete: userDelete,
        deleteMany: userDeleteMany,
      },
      session: { updateMany: sessionUpdateMany },
    },
    sessionUpdateMany,
    sessions,
    userCreate,
    userDelete,
    userDeleteMany,
    userFindUnique,
    userUpdate,
    users,
  };
}

function options(
  overrides: Partial<{
    accounts: readonly SeedAccountManifestEntry<PasswordKey>[];
    retiredExternalIds: readonly string[];
    conflict: (message: string) => Error;
  }> = {},
) {
  return {
    accounts: [OPERATOR_ACCOUNT] as readonly SeedAccountManifestEntry<PasswordKey>[],
    retiredExternalIds: [] as readonly string[],
    passwordFor: (passwordKey: PasswordKey) => PASSWORDS[passwordKey],
    conflict: (message: string) => new SeedAccountConflictError(message),
    ...overrides,
  };
}

describe('seed account reconciliation', () => {
  it.each([
    {
      name: 'duplicate active login',
      accounts: [OPERATOR_ACCOUNT, { ...WAREHOUSE_ACCOUNT, login: OPERATOR_ACCOUNT.login }],
      retiredExternalIds: [],
      message: 'duplicate active login: ахметов булат',
    },
    {
      name: 'duplicate active external ID',
      accounts: [
        OPERATOR_ACCOUNT,
        { ...WAREHOUSE_ACCOUNT, externalId: OPERATOR_ACCOUNT.externalId },
      ],
      retiredExternalIds: [],
      message: 'duplicate active external ID: seed-operator',
    },
    {
      name: 'active-retired external ID overlap',
      accounts: [OPERATOR_ACCOUNT],
      retiredExternalIds: [OPERATOR_ACCOUNT.externalId],
      message: 'active and retired external ID overlap: seed-operator',
    },
    {
      name: 'duplicate retired external ID',
      accounts: [],
      retiredExternalIds: ['seed-retired', 'seed-retired'],
      message: 'duplicate retired external ID: seed-retired',
    },
  ])(
    'rejects $name before accessing account state',
    async ({ accounts, retiredExternalIds, message }) => {
      const harness = createHarness();
      const conflict = jest.fn((detail: string) => new Error(`custom conflict: ${detail}`));

      await expect(
        reconcileSeedAccounts(
          harness.prisma as never,
          options({ accounts, retiredExternalIds, conflict }),
        ),
      ).rejects.toThrow(`custom conflict: ${message}`);

      expect(conflict).toHaveBeenCalledWith(message);
      expect(harness.userFindUnique).not.toHaveBeenCalled();
      expect(harness.userCreate).not.toHaveBeenCalled();
      expect(harness.userUpdate).not.toHaveBeenCalled();
      expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
    },
  );

  it('resolves retired rows before applying any active mutation', async () => {
    const harness = createHarness();
    harness.failedExternalIdLookups.add('seed-retired');

    await expect(
      reconcileSeedAccounts(
        harness.prisma as never,
        options({ retiredExternalIds: ['seed-retired'] }),
      ),
    ).rejects.toThrow('External ID lookup failed: seed-retired');

    expect(harness.userCreate).not.toHaveBeenCalled();
    expect(harness.userUpdate).not.toHaveBeenCalled();
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('creates a missing local account and preserves its id and password hash on a second run', async () => {
    const harness = createHarness();

    await reconcileSeedAccounts(harness.prisma as never, options());

    expect(harness.users).toHaveLength(1);
    expect(harness.users[0]).toMatchObject({
      externalId: OPERATOR_ACCOUNT.externalId,
      login: OPERATOR_ACCOUNT.login,
      displayName: OPERATOR_ACCOUNT.displayName,
      identityProvider: 'local',
      role: OPERATOR_ACCOUNT.role,
      isActive: true,
      mustChangePassword: false,
    });
    expect(
      verifyPassword(PASSWORDS[OPERATOR_ACCOUNT.passwordKey], harness.users[0].passwordHash ?? ''),
    ).toBe(true);
    const firstState = structuredClone(harness.users);

    await reconcileSeedAccounts(harness.prisma as never, options());

    expect(harness.users).toEqual(firstState);
    expect(harness.userCreate).toHaveBeenCalledTimes(1);
    expect(harness.userUpdate).not.toHaveBeenCalled();
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('renames the user resolved by stable external id without a duplicate and revokes sessions', async () => {
    const legacy = seedUser({ login: 'оператор', displayName: OPERATOR_ACCOUNT.displayName });
    const harness = createHarness([legacy], [activeSession(legacy.id)]);

    await reconcileSeedAccounts(harness.prisma as never, options());

    expect(harness.users).toHaveLength(1);
    expect(harness.users[0].login).toBe(OPERATOR_ACCOUNT.login);
    expect(harness.userCreate).not.toHaveBeenCalled();
    expect(harness.userUpdate).toHaveBeenCalledWith({
      where: { id: legacy.id },
      data: { login: OPERATOR_ACCOUNT.login },
    });
    expect(harness.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(harness.sessionUpdateMany).toHaveBeenCalledWith({
      where: { userId: legacy.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('repairs only a display name without revoking active sessions', async () => {
    const existing = seedUser({ displayName: 'Старое имя' });
    const harness = createHarness([existing], [activeSession(existing.id)]);

    await reconcileSeedAccounts(harness.prisma as never, options());

    expect(harness.users[0].displayName).toBe(OPERATOR_ACCOUNT.displayName);
    expect(harness.sessions[0].revokedAt).toBeNull();
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('attaches a null external id without revoking active sessions', async () => {
    const existing = seedUser({ externalId: null });
    const harness = createHarness([existing], [activeSession(existing.id)]);

    await reconcileSeedAccounts(harness.prisma as never, options());

    expect(harness.users[0].externalId).toBe(OPERATOR_ACCOUNT.externalId);
    expect(harness.sessions[0].revokedAt).toBeNull();
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('reactivates an inactive account and revokes its active sessions', async () => {
    const existing = seedUser({ isActive: false });
    const harness = createHarness([existing], [activeSession(existing.id)]);

    await reconcileSeedAccounts(harness.prisma as never, options());

    expect(harness.users[0].isActive).toBe(true);
    expect(harness.userUpdate).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { isActive: true },
    });
    expect(harness.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(harness.sessionUpdateMany).toHaveBeenCalledWith({
      where: { userId: existing.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('rotates a mismatched password, records the change, repairs must-change, and revokes sessions', async () => {
    const oldHash = hashPassword('obsolete-password-2025');
    const existing = seedUser({
      passwordHash: oldHash,
      mustChangePassword: true,
      passwordChangedAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    const harness = createHarness([existing], [activeSession(existing.id)]);

    await reconcileSeedAccounts(harness.prisma as never, options());

    expect(harness.users[0].passwordHash).not.toBe(oldHash);
    expect(
      verifyPassword(PASSWORDS[OPERATOR_ACCOUNT.passwordKey], harness.users[0].passwordHash ?? ''),
    ).toBe(true);
    expect(harness.users[0].passwordChangedAt).toBeInstanceOf(Date);
    expect(harness.users[0].passwordChangedAt?.getTime()).toBeGreaterThan(
      new Date('2025-01-01T00:00:00.000Z').getTime(),
    );
    expect(harness.users[0].mustChangePassword).toBe(false);
    expect(harness.userUpdate).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: {
        passwordHash: expect.any(String),
        passwordChangedAt: expect.any(Date),
        mustChangePassword: false,
      },
    });
    expect(harness.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(harness.sessionUpdateMany).toHaveBeenCalledWith({
      where: { userId: existing.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('repairs only mustChangePassword without rehashing or revoking sessions', async () => {
    const existing = seedUser({ mustChangePassword: true });
    const stableHash = existing.passwordHash;
    const harness = createHarness([existing], [activeSession(existing.id)]);

    await reconcileSeedAccounts(harness.prisma as never, options());

    expect(harness.users[0].mustChangePassword).toBe(false);
    expect(harness.users[0].passwordHash).toBe(stableHash);
    expect(harness.sessions[0].revokedAt).toBeNull();
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects login and external-id split brain through the injected conflict factory', async () => {
    const byLogin = seedUser({ id: 'by-login', externalId: 'foreign-id' });
    const byExternalId = seedUser({ id: 'by-external-id', login: 'старый логин' });
    const harness = createHarness([byLogin, byExternalId]);
    const conflict = jest.fn((message: string) => new Error(`custom conflict: ${message}`));

    await expect(
      reconcileSeedAccounts(harness.prisma as never, options({ conflict })),
    ).rejects.toThrow(`custom conflict: account identity mismatch for ${OPERATOR_ACCOUNT.login}`);
    expect(conflict).toHaveBeenCalledWith(
      `account identity mismatch for ${OPERATOR_ACCOUNT.login}`,
    );
    expect(harness.userUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['provider', { identityProvider: 'oidc:example' }],
    ['role', { role: Role.admin }],
    ['foreign external id', { externalId: 'foreign-id' }],
  ] as const)('rejects an existing account with a conflicting %s', async (_label, mutation) => {
    const existing = seedUser(mutation);
    const harness = createHarness([existing]);
    const conflict = jest.fn((message: string) => new Error(`custom conflict: ${message}`));

    await expect(
      reconcileSeedAccounts(harness.prisma as never, options({ conflict })),
    ).rejects.toThrow(`custom conflict: account metadata mismatch for ${OPERATOR_ACCOUNT.login}`);
    expect(conflict).toHaveBeenCalledWith(
      `account metadata mismatch for ${OPERATOR_ACCOUNT.login}`,
    );
    expect(harness.userUpdate).not.toHaveBeenCalled();
  });

  it('validates every active identity before applying any repair', async () => {
    const repairable = seedUser({ displayName: 'Старое имя' });
    const conflicting = seedUser({
      id: 'warehouse-user',
      externalId: WAREHOUSE_ACCOUNT.externalId,
      login: WAREHOUSE_ACCOUNT.login,
      displayName: WAREHOUSE_ACCOUNT.displayName,
      role: Role.admin,
      passwordHash: hashPassword(PASSWORDS[WAREHOUSE_ACCOUNT.passwordKey]),
    });
    const harness = createHarness([repairable, conflicting]);

    await expect(
      reconcileSeedAccounts(
        harness.prisma as never,
        options({ accounts: [OPERATOR_ACCOUNT, WAREHOUSE_ACCOUNT] }),
      ),
    ).rejects.toThrow(`account metadata mismatch for ${WAREHOUSE_ACCOUNT.login}`);
    expect(harness.users[0].displayName).toBe('Старое имя');
    expect(harness.userUpdate).not.toHaveBeenCalled();
  });

  it('retains and deactivates retired rows and revokes active sessions even when already inactive', async () => {
    const activeRetired = seedUser({
      id: 'retired-active',
      externalId: 'seed-operator-4',
      login: 'оператор 4',
    });
    const inactiveRetired = seedUser({
      id: 'retired-inactive',
      externalId: 'seed-operator-5',
      login: 'оператор 5',
      isActive: false,
    });
    const alreadyRevokedAt = new Date('2026-01-01T00:00:00.000Z');
    const harness = createHarness(
      [activeRetired, inactiveRetired],
      [
        activeSession(activeRetired.id, 'active-on-active'),
        activeSession(inactiveRetired.id, 'active-on-inactive'),
        { id: 'already-revoked', userId: activeRetired.id, revokedAt: alreadyRevokedAt },
      ],
    );

    await reconcileSeedAccounts(
      harness.prisma as never,
      options({ accounts: [], retiredExternalIds: ['seed-operator-4', 'seed-operator-5'] }),
    );

    expect(harness.users).toHaveLength(2);
    expect(harness.users.every((user) => user.isActive === false)).toBe(true);
    expect(harness.userUpdate).toHaveBeenCalledWith({
      where: { id: activeRetired.id },
      data: { isActive: false },
    });
    expect(
      harness.sessions.find((session) => session.id === 'active-on-active')?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      harness.sessions.find((session) => session.id === 'active-on-inactive')?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(harness.sessions.find((session) => session.id === 'already-revoked')?.revokedAt).toBe(
      alreadyRevokedAt,
    );
    expect(harness.sessionUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { userId: activeRetired.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(harness.sessionUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { userId: inactiveRetired.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(harness.userDelete).not.toHaveBeenCalled();
    expect(harness.userDeleteMany).not.toHaveBeenCalled();
  });

  it('does nothing when a retired external id has no local row', async () => {
    const harness = createHarness();

    await reconcileSeedAccounts(
      harness.prisma as never,
      options({ accounts: [], retiredExternalIds: ['missing-retired-account'] }),
    );

    expect(harness.users).toHaveLength(0);
    expect(harness.userUpdate).not.toHaveBeenCalled();
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
  });
});
