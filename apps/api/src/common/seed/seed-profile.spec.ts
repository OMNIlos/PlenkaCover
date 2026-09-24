import { randomBytes } from 'node:crypto';
import {
  PILOT_ACCOUNT_MANIFEST,
  PILOT_AGENT_TOKEN_KEYS,
  PILOT_LOGINS,
  PILOT_PASSWORD_KEYS,
  RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS,
  loadSeedProfile,
} from './seed-profile';
import { runSeedProfile } from './seed-runner';

type Environment = Record<string, string | undefined>;

function pilotAgentToken(byteLength = 32): string {
  return `ptk_${randomBytes(byteLength).toString('base64url')}`;
}

function nonCanonicalPilotToken(): string {
  const payload = randomBytes(32).toString('base64url');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const finalIndex = alphabet.indexOf(payload.at(-1) as string);
  return `ptk_${payload.slice(0, -1)}${alphabet[finalIndex + 1]}`;
}

function pilotEnvironment(): Environment {
  const env: Environment = { APP_ENV: 'pilot', SEED_PROFILE: 'pilot' };
  for (const [index, account] of PILOT_ACCOUNT_MANIFEST.entries()) {
    env[account.passwordKey] = `${randomBytes(18).toString('base64url')}-${index}`;
  }
  for (const key of PILOT_AGENT_TOKEN_KEYS) {
    env[key] = pilotAgentToken();
  }
  return env;
}

function pilotPinEnvironment(): Environment {
  const env = pilotEnvironment();
  env.PILOT_SHORT_PASSWORDS_ENABLED = 'true';
  for (const [index, account] of PILOT_ACCOUNT_MANIFEST.entries()) {
    env[account.passwordKey] = String(1_000 + index);
  }
  return env;
}

describe('seed profile preflight', () => {
  it('contains exactly three active operators with requested identities', () => {
    expect(
      PILOT_ACCOUNT_MANIFEST.filter((account) => account.role === 'operator').map(
        ({ externalId, login, displayName }) => ({ externalId, login, displayName }),
      ),
    ).toEqual([
      {
        externalId: 'seed-operator',
        login: 'ахметов булат',
        displayName: 'Ахметов Булат',
      },
      {
        externalId: 'seed-operator-2',
        login: 'хабибулин руслан',
        displayName: 'Хабибулин Руслан',
      },
      {
        externalId: 'seed-operator-3',
        login: 'гайнулин ильназ',
        displayName: 'Гайнулин Ильназ',
      },
    ]);
    expect(RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS).toEqual(['seed-operator-4']);
    expect(PILOT_PASSWORD_KEYS).not.toContain('SEED_PILOT_PASSWORD_OPERATOR_4');
    expect(PILOT_LOGINS).not.toHaveProperty('operator4');
  });

  it('keeps nine active accounts and the nonoperator identities and roles unchanged', () => {
    expect(PILOT_ACCOUNT_MANIFEST).toHaveLength(9);
    expect(
      PILOT_ACCOUNT_MANIFEST.filter((account) => account.role !== 'operator').map(
        ({ externalId, login, displayName, role }) => ({ externalId, login, displayName, role }),
      ),
    ).toEqual([
      {
        externalId: 'seed-commercial',
        login: 'коммерция',
        displayName: 'Коммерция',
        role: 'commercial',
      },
      {
        externalId: 'seed-production',
        login: 'производство',
        displayName: 'Завпроизводства',
        role: 'production_lead',
      },
      {
        externalId: 'seed-warehouse',
        login: 'склад',
        displayName: 'Склад',
        role: 'warehouse',
      },
      {
        externalId: 'seed-finance',
        login: 'бухгалтерия',
        displayName: 'Бухгалтерия',
        role: 'finance',
      },
      {
        externalId: 'seed-director',
        login: 'директор',
        displayName: 'Директор',
        role: 'director',
      },
      {
        externalId: 'seed-admin',
        login: 'админ',
        displayName: 'Админ',
        role: 'admin',
      },
    ]);
  });

  it('does not expose the seed suffix in any active display name', () => {
    expect(PILOT_ACCOUNT_MANIFEST.map((account) => account.displayName).join('|')).not.toContain(
      '(seed)',
    );
  });

  it.each([undefined, '', 'Demo', 'pilot ', 'staging'])(
    'rejects a missing or non-exact SEED_PROFILE before bootstrap (%s)',
    (profile) => {
      expect(() => loadSeedProfile({ APP_ENV: 'test', SEED_PROFILE: profile })).toThrow(
        'SEED_PROFILE must be exactly one of: demo, pilot',
      );
    },
  );

  it.each(['development', 'test'])('allows demo only in the %s runtime', (appEnv) => {
    expect(loadSeedProfile({ APP_ENV: appEnv, SEED_PROFILE: 'demo' })).toMatchObject({
      profile: 'demo',
      scope: 'full',
    });
  });

  it.each([
    [undefined, 'full'],
    ['full', 'full'],
    ['accounts', 'accounts'],
  ] as const)('loads the exact demo seed scope %s as %s', (value, expected) => {
    expect(
      loadSeedProfile({
        APP_ENV: 'test',
        SEED_PROFILE: 'demo',
        DEMO_SEED_SCOPE: value,
      }),
    ).toMatchObject({ profile: 'demo', scope: expected });
  });

  it.each(['', 'account', 'Accounts', 'full ', 'pilot'])(
    'rejects invalid DEMO_SEED_SCOPE before bootstrap (%s)',
    async (scope) => {
      const createPrisma = jest.fn();

      await expect(
        runSeedProfile(
          {
            APP_ENV: 'test',
            SEED_PROFILE: 'demo',
            DEMO_SEED_SCOPE: scope,
          },
          {
            createPrisma,
            seedDemo: jest.fn(),
            seedPilot: jest.fn(),
          },
        ),
      ).rejects.toThrow('DEMO_SEED_SCOPE must be exactly one of: full, accounts');
      expect(createPrisma).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'development', 'test', 'production'])(
    'allows pilot only under exact APP_ENV=pilot (%s)',
    (appEnv) => {
      const env = pilotEnvironment();
      env.APP_ENV = appEnv;
      expect(() => loadSeedProfile(env)).toThrow('SEED_PROFILE=pilot requires APP_ENV=pilot');
    },
  );

  it('reports every missing pilot key by name without including any supplied value', () => {
    const suppliedSecret = randomBytes(32).toString('base64url');
    const env: Environment = {
      APP_ENV: 'pilot',
      SEED_PROFILE: 'pilot',
      [PILOT_PASSWORD_KEYS[0]]: suppliedSecret,
    };

    let failure: Error | undefined;
    try {
      loadSeedProfile(env);
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toBeInstanceOf(Error);
    for (const key of [...PILOT_PASSWORD_KEYS.slice(1), ...PILOT_AGENT_TOKEN_KEYS]) {
      expect(failure?.message).toContain(key);
    }
    expect(failure?.message.includes(suppliedSecret)).toBe(false);
  });

  it('rejects invalid passwords, weak/demo tokens and shared secrets with key-only errors', () => {
    const cases: Array<(env: Environment) => string[]> = [
      (env) => {
        env[PILOT_PASSWORD_KEYS[0]] = randomBytes(2).toString('base64url');
        return [PILOT_PASSWORD_KEYS[0]];
      },
      (env) => {
        env[PILOT_AGENT_TOKEN_KEYS[0]] = `agent-post-${randomBytes(1).toString('hex')}`;
        return [PILOT_AGENT_TOKEN_KEYS[0]];
      },
      (env) => {
        env[PILOT_PASSWORD_KEYS[1]] = env[PILOT_PASSWORD_KEYS[0]];
        return [PILOT_PASSWORD_KEYS[0], PILOT_PASSWORD_KEYS[1]];
      },
      (env) => {
        env[PILOT_AGENT_TOKEN_KEYS[1]] = env[PILOT_AGENT_TOKEN_KEYS[0]];
        return [PILOT_AGENT_TOKEN_KEYS[0], PILOT_AGENT_TOKEN_KEYS[1]];
      },
    ];

    for (const mutate of cases) {
      const env = pilotEnvironment();
      const invalidKeys = mutate(env);
      const secretValues = invalidKeys.map((key) => env[key] as string);
      let failure: Error | undefined;
      try {
        loadSeedProfile(env);
      } catch (error) {
        failure = error as Error;
      }
      expect(failure).toBeInstanceOf(Error);
      for (const key of invalidKeys) expect(failure?.message).toContain(key);
      for (const value of secretValues) {
        expect(failure?.message.includes(value)).toBe(false);
      }
    }
  });

  it.each([
    ['missing ptk prefix', () => randomBytes(32).toString('base64url')],
    ['invalid base64url alphabet', () => `ptk_${randomBytes(32).toString('base64url')}+`],
    ['base64url padding', () => `${pilotAgentToken()}=`],
    ['non-canonical base64url encoding', () => nonCanonicalPilotToken()],
    ['payload shorter than 32 decoded bytes', () => pilotAgentToken(31)],
    ['the 32-character repeated pattern', () => `ptk_${'abcdefgh'.repeat(4)}`],
    ['a longer low-entropy repeated pattern', () => `ptk_${'abcdefgh'.repeat(6)}`],
    ['low Shannon entropy without an exact period', () => `ptk_${'A'.repeat(37)}BCDEFGH`],
    ['exact repeated block', () => `ptk_${'Ab3_xY9-kLmN0pQr'.repeat(3)}`],
    ['one-character payload', () => `ptk_${'A'.repeat(44)}`],
  ])('rejects %s with a key-only error', (_label, tokenFactory) => {
    const env = pilotEnvironment();
    const key = PILOT_AGENT_TOKEN_KEYS[0];
    const token = tokenFactory();
    env[key] = token;

    let failure: Error | undefined;
    try {
      loadSeedProfile(env);
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(key);
    expect(failure?.message.includes(token)).toBe(false);
  });

  it('accepts canonical tokens at and above 32 decoded random bytes reliably', () => {
    const env = pilotEnvironment();
    for (let sample = 0; sample < 128; sample += 1) {
      env[PILOT_AGENT_TOKEN_KEYS[0]] = pilotAgentToken();
      expect(() => loadSeedProfile(env)).not.toThrow();
    }
    for (const byteLength of [33, 64]) {
      env[PILOT_AGENT_TOKEN_KEYS[0]] = pilotAgentToken(byteLength);
      expect(() => loadSeedProfile(env)).not.toThrow();
    }
  });

  it('rejects password and token reuse across the full credential set with key-only errors', () => {
    const env = pilotEnvironment();
    const passwordKey = PILOT_PASSWORD_KEYS[0];
    const tokenKey = PILOT_AGENT_TOKEN_KEYS[0];
    const reusedValue = env[tokenKey] as string;
    env[passwordKey] = reusedValue;

    let failure: Error | undefined;
    try {
      loadSeedProfile(env);
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(passwordKey);
    expect(failure?.message).toContain(tokenKey);
    expect(failure?.message.includes(reusedValue)).toBe(false);
  });

  it('returns a complete pilot manifest only after all credentials pass', () => {
    const config = loadSeedProfile(pilotEnvironment());
    expect(config.profile).toBe('pilot');
    if (config.profile !== 'pilot') throw new Error('Expected pilot configuration');
    expect(Object.keys(config.passwords)).toHaveLength(PILOT_PASSWORD_KEYS.length);
    expect(Object.keys(config.agentTokens)).toHaveLength(PILOT_AGENT_TOKEN_KEYS.length);
    expect(config.shortPasswordsEnabled).toBe(false);
  });

  it('accepts distinct four-digit per-account PINs only under the exact pilot opt-in', () => {
    const config = loadSeedProfile(pilotPinEnvironment());
    expect(config).toMatchObject({
      profile: 'pilot',
      shortPasswordsEnabled: true,
    });
    if (config.profile !== 'pilot') throw new Error('Expected pilot configuration');
    expect(Object.keys(config.passwords)).toHaveLength(PILOT_PASSWORD_KEYS.length);
  });

  it.each([undefined, 'false', 'TRUE', 'on', '1'])(
    'rejects four-digit pilot PINs without the exact true opt-in (%s)',
    (flag) => {
      const env = pilotPinEnvironment();
      env.PILOT_SHORT_PASSWORDS_ENABLED = flag;
      const suppliedPin = env[PILOT_PASSWORD_KEYS[0]] as string;

      let failure: Error | undefined;
      try {
        loadSeedProfile(env);
      } catch (error) {
        failure = error as Error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toContain('PILOT_SHORT_PASSWORDS_ENABLED');
      expect(failure?.message.includes(suppliedPin)).toBe(false);
    },
  );

  it.each(['123', '12345', '12a4', ' 1234 '])(
    'rejects a malformed pilot PIN with a key-only error (%s)',
    (pin) => {
      const env = pilotPinEnvironment();
      const key = PILOT_PASSWORD_KEYS[0];
      env[key] = pin;

      let failure: Error | undefined;
      try {
        loadSeedProfile(env);
      } catch (error) {
        failure = error as Error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toContain(key);
      expect(failure?.message.includes(pin)).toBe(false);
    },
  );

  it('rejects a shared pilot PIN without exposing it', () => {
    const env = pilotPinEnvironment();
    const firstKey = PILOT_PASSWORD_KEYS[0];
    const secondKey = PILOT_PASSWORD_KEYS[1];
    const sharedPin = env[firstKey] as string;
    env[secondKey] = sharedPin;

    let failure: Error | undefined;
    try {
      loadSeedProfile(env);
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(firstKey);
    expect(failure?.message).toContain(secondKey);
    expect(failure?.message.includes(sharedPin)).toBe(false);
  });

  it('does not construct a Prisma client or invoke a seed callback after failed preflight', async () => {
    const createPrisma = jest.fn();
    const seedDemo = jest.fn();
    const seedPilot = jest.fn();

    await expect(
      runSeedProfile(
        { APP_ENV: 'pilot', SEED_PROFILE: 'pilot' },
        { createPrisma, seedDemo, seedPilot },
      ),
    ).rejects.toThrow(PILOT_PASSWORD_KEYS[0]);
    expect(createPrisma).not.toHaveBeenCalled();
    expect(seedDemo).not.toHaveBeenCalled();
    expect(seedPilot).not.toHaveBeenCalled();
  });

  it('disconnects the client after dispatching the validated profile', async () => {
    const prisma = { $disconnect: jest.fn().mockResolvedValue(undefined) };
    const seedDemo = jest.fn();
    const seedPilot = jest.fn().mockResolvedValue(undefined);

    await runSeedProfile(pilotEnvironment(), {
      createPrisma: jest.fn().mockReturnValue(prisma),
      seedDemo,
      seedPilot,
    });

    expect(seedDemo).not.toHaveBeenCalled();
    expect(seedPilot).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });
});
