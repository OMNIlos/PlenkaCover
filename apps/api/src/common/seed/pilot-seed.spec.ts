import { Role } from '@prisma/client';
import { hashPassword, verifyPassword } from '../auth/password';
import { seedPilot } from './pilot-seed';
import {
  PILOT_ACCOUNT_MANIFEST,
  PILOT_AGENT_TOKEN_KEYS,
  RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS,
  type PilotSeedProfile,
} from './seed-profile';

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

interface SeedPost {
  agentTokenHash: string | null;
  code: string;
  id: string;
}

interface SeedDevice {
  code: string | null;
  id: string;
  kind: string;
  postId: string | null;
}

function pilotConfig(): PilotSeedProfile {
  return {
    profile: 'pilot',
    shortPasswordsEnabled: true,
    passwords: Object.fromEntries(
      PILOT_ACCOUNT_MANIFEST.map((account, index) => [account.passwordKey, String(4_100 + index)]),
    ) as PilotSeedProfile['passwords'],
    agentTokens: Object.fromEntries(
      PILOT_AGENT_TOKEN_KEYS.map((key, index) => [key, `test-agent-token-${index}`]),
    ) as PilotSeedProfile['agentTokens'],
  };
}

function existingUsers(config: PilotSeedProfile): SeedUser[] {
  return PILOT_ACCOUNT_MANIFEST.map((account, index) => ({
    id: `user-${index + 1}`,
    externalId: account.externalId,
    login: account.login,
    passwordHash: hashPassword(config.passwords[account.passwordKey]),
    identityProvider: 'local',
    displayName: account.displayName,
    role: account.role,
    isActive: true,
    mustChangePassword: false,
    passwordChangedAt: null,
  }));
}

function createHarness(initialUsers: SeedUser[] = [], initialSessions: SeedSession[] = []) {
  const users = initialUsers.map((user) => ({ ...user }));
  const sessions = initialSessions.map((session) => ({ ...session }));
  const postsByCode = new Map<string, SeedPost>();
  const devicesById = new Map<string, SeedDevice>();
  const devicesByCode = new Map<string, SeedDevice>();
  let nextUserId = users.length + 1;

  const userCreate = jest.fn(
    async ({ data }: { data: Omit<SeedUser, 'id' | 'passwordChangedAt'> }) => {
      const created: SeedUser = {
        ...data,
        id: `user-${nextUserId++}`,
        passwordChangedAt: null,
      };
      users.push(created);
      return created;
    },
  );
  const userUpdate = jest.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<SeedUser> }) => {
      const user = users.find((candidate) => candidate.id === where.id);
      if (!user) throw new Error('Test user not found');
      Object.assign(user, data);
      return user;
    },
  );
  const sessionUpdateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { revokedAt: null; userId: string };
      data: { revokedAt: Date };
    }) => {
      let count = 0;
      for (const session of sessions) {
        if (session.userId === where.userId && session.revokedAt === null) {
          session.revokedAt = data.revokedAt;
          count += 1;
        }
      }
      return { count };
    },
  );

  const transactionClient = {
    user: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { externalId?: string; login?: string };
        }): Promise<SeedUser | null> =>
          users.find(
            (user) =>
              (where.login !== undefined && user.login === where.login) ||
              (where.externalId !== undefined && user.externalId === where.externalId),
          ) ?? null,
      ),
      create: userCreate,
      update: userUpdate,
    },
    session: {
      updateMany: sessionUpdateMany,
    },
    post: {
      findUnique: jest.fn(
        async ({ where }: { where: { code: string } }): Promise<SeedPost | null> =>
          postsByCode.get(where.code) ?? null,
      ),
      create: jest.fn(
        async ({ data }: { data: { agentTokenHash: string; code: string } }): Promise<SeedPost> => {
          const post = {
            id: `post-${data.code}`,
            code: data.code,
            agentTokenHash: data.agentTokenHash,
          };
          postsByCode.set(post.code, post);
          return post;
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { agentTokenHash: string };
        }): Promise<SeedPost> => {
          const post = [...postsByCode.values()].find((candidate) => candidate.id === where.id);
          if (!post) throw new Error('Test post not found');
          post.agentTokenHash = data.agentTokenHash;
          return post;
        },
      ),
    },
    deviceRuntime: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { code?: string; id?: string };
        }): Promise<SeedDevice | null> => {
          if (where.id !== undefined) return devicesById.get(where.id) ?? null;
          if (where.code !== undefined) return devicesByCode.get(where.code) ?? null;
          return null;
        },
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: { code: string; id: string; kind: string; postId: string };
        }): Promise<SeedDevice> => {
          const device = {
            id: data.id,
            code: data.code,
            kind: data.kind,
            postId: data.postId,
          };
          devicesById.set(device.id, device);
          devicesByCode.set(device.code, device);
          return device;
        },
      ),
      update: jest.fn(),
    },
    accessTemplate: {
      upsert: jest.fn(),
    },
  };

  return {
    devicesById,
    postsByCode,
    sessions,
    transactionClient,
    userCreate,
    userUpdate,
    users,
    sessionUpdateMany,
  };
}

describe('pilot seed account reconciliation', () => {
  it('creates pilot accounts with mustChangePassword=false and is idempotent on rerun', async () => {
    const config = pilotConfig();
    const harness = createHarness();

    await seedPilot(harness.transactionClient as never, config);

    const ids = harness.users.map((user) => user.id);
    const hashes = harness.users.map((user) => user.passwordHash);
    expect(harness.users).toHaveLength(PILOT_ACCOUNT_MANIFEST.length);
    expect(harness.users.every((user) => user.mustChangePassword === false)).toBe(true);
    for (const [index, account] of PILOT_ACCOUNT_MANIFEST.entries()) {
      expect(
        verifyPassword(
          config.passwords[account.passwordKey],
          harness.users[index].passwordHash as string,
        ),
      ).toBe(true);
    }

    await seedPilot(harness.transactionClient as never, config);

    expect(harness.users.map((user) => user.id)).toEqual(ids);
    expect(harness.users.every((user, index) => user.passwordHash === hashes[index])).toBe(true);
    expect(harness.userCreate).toHaveBeenCalledTimes(PILOT_ACCOUNT_MANIFEST.length);
    expect(harness.userUpdate).not.toHaveBeenCalled();
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
    expect(harness.postsByCode.size).toBe(PILOT_AGENT_TOKEN_KEYS.length);
    expect(harness.devicesById.size).toBe(PILOT_AGENT_TOKEN_KEYS.length * 3);
  });

  it('rotates only a mismatched hash and revokes only that account active sessions', async () => {
    const config = pilotConfig();
    const users = existingUsers(config);
    const rotatedAccount = PILOT_ACCOUNT_MANIFEST[0];
    const stableAccount = PILOT_ACCOUNT_MANIFEST[1];
    const oldRotatedHash = hashPassword('different-test-password');
    users[0].passwordHash = oldRotatedHash;
    users[0].mustChangePassword = true;
    const stableHash = users[1].passwordHash;
    const alreadyRevokedAt = new Date('2026-01-01T00:00:00.000Z');
    const harness = createHarness(users, [
      { id: 'active-rotated', userId: users[0].id, revokedAt: null },
      { id: 'revoked-rotated', userId: users[0].id, revokedAt: alreadyRevokedAt },
      { id: 'active-stable', userId: users[1].id, revokedAt: null },
    ]);
    const ids = harness.users.map((user) => user.id);

    await seedPilot(harness.transactionClient as never, config);

    expect(harness.users.map((user) => user.id)).toEqual(ids);
    expect(harness.users[0].passwordHash === oldRotatedHash).toBe(false);
    expect(
      verifyPassword(
        config.passwords[rotatedAccount.passwordKey],
        harness.users[0].passwordHash as string,
      ),
    ).toBe(true);
    expect(harness.users[0].mustChangePassword).toBe(false);
    expect(harness.users[1].passwordHash === stableHash).toBe(true);
    expect(
      verifyPassword(
        config.passwords[stableAccount.passwordKey],
        harness.users[1].passwordHash as string,
      ),
    ).toBe(true);
    expect(
      harness.sessions.find((session) => session.id === 'active-rotated')?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(harness.sessions.find((session) => session.id === 'revoked-rotated')?.revokedAt).toBe(
      alreadyRevokedAt,
    );
    expect(
      harness.sessions.find((session) => session.id === 'active-stable')?.revokedAt,
    ).toBeNull();
    expect(harness.sessionUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes a legacy login only for the exact pilot external identity', async () => {
    const config = pilotConfig();
    const users = existingUsers(config);
    const account = PILOT_ACCOUNT_MANIFEST[0];
    users[0].login = 'commercial';
    const harness = createHarness(users, [
      { id: 'active-legacy-login', userId: users[0].id, revokedAt: null },
    ]);

    await seedPilot(harness.transactionClient as never, config);

    expect(harness.users[0]).toMatchObject({
      externalId: account.externalId,
      login: account.login,
      role: account.role,
    });
    expect(
      harness.sessions.find((session) => session.id === 'active-legacy-login')?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(harness.sessionUpdateMany).toHaveBeenCalledTimes(1);

    await seedPilot(harness.transactionClient as never, config);

    expect(harness.userUpdate).toHaveBeenCalledTimes(1);
    expect(harness.sessionUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('clears a stale must-change marker without rehashing or revoking a matching password', async () => {
    const config = pilotConfig();
    const users = existingUsers(config);
    users[0].mustChangePassword = true;
    const stableHash = users[0].passwordHash;
    const harness = createHarness(users, [
      { id: 'active-matching', userId: users[0].id, revokedAt: null },
    ]);

    await seedPilot(harness.transactionClient as never, config);

    expect(harness.users[0].mustChangePassword).toBe(false);
    expect(harness.users[0].passwordHash === stableHash).toBe(true);
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('reconciles canonical operator names without revoking their active sessions', async () => {
    const config = pilotConfig();
    const users = existingUsers(config);
    const desiredNames = new Map([
      ['seed-operator', 'Ахметов Булат'],
      ['seed-operator-2', 'Хабибулин Руслан'],
      ['seed-operator-3', 'Гайнулин Ильназ'],
    ]);
    const activeSessions: SeedSession[] = [];

    for (const user of users) {
      if (!user.externalId || !desiredNames.has(user.externalId)) continue;
      user.displayName = `Старое имя ${user.externalId}`;
      activeSessions.push({
        id: `active-${user.externalId}`,
        userId: user.id,
        revokedAt: null,
      });
    }
    const harness = createHarness(users, activeSessions);

    await seedPilot(harness.transactionClient as never, config);

    for (const [externalId, displayName] of desiredNames) {
      expect(harness.users.find((user) => user.externalId === externalId)?.displayName).toBe(
        displayName,
      );
      expect(
        harness.sessions.find((session) => session.id === `active-${externalId}`)?.revokedAt,
      ).toBeNull();
    }
    expect(harness.userUpdate).toHaveBeenCalledTimes(desiredNames.size);
    expect(harness.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('deactivates the retired pilot identity without deleting its historical row', async () => {
    const config = pilotConfig();
    const retired = existingUsers(config)[0];
    retired.id = 'retired-user';
    retired.externalId = RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS[0];
    retired.login = 'оператор 4';
    const harness = createHarness(
      [retired],
      [{ id: 'retired-session', userId: retired.id, revokedAt: null }],
    );

    await seedPilot(harness.transactionClient as never, config);

    const retained = harness.users.find((user) => user.id === retired.id);
    expect(retained?.isActive).toBe(false);
    expect(harness.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(harness.users).toContain(retained);
  });
});
