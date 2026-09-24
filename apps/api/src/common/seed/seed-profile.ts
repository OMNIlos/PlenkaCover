import { Role } from '@prisma/client';
import { isCanonicalPilotAgentToken } from '@plenka/contracts';
import { assertPasswordPolicy, assertPilotPassword } from '../auth/password-policy';

type Environment = Record<string, string | undefined>;

export const PILOT_LOGINS = {
  commercial: 'коммерция',
  production: 'производство',
  operator: 'ахметов булат',
  operator2: 'хабибулин руслан',
  operator3: 'гайнулин ильназ',
  warehouse: 'склад',
  finance: 'бухгалтерия',
  director: 'директор',
  admin: 'админ',
} as const;

export const RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS = ['seed-operator-4'] as const;

export const PILOT_ACCOUNT_MANIFEST = [
  {
    externalId: 'seed-commercial',
    login: PILOT_LOGINS.commercial,
    displayName: 'Коммерция',
    role: Role.commercial,
    passwordKey: 'SEED_PILOT_PASSWORD_COMMERCIAL',
  },
  {
    externalId: 'seed-production',
    login: PILOT_LOGINS.production,
    displayName: 'Завпроизводства',
    role: Role.production_lead,
    passwordKey: 'SEED_PILOT_PASSWORD_PRODUCTION',
  },
  {
    externalId: 'seed-operator',
    login: PILOT_LOGINS.operator,
    displayName: 'Ахметов Булат',
    role: Role.operator,
    passwordKey: 'SEED_PILOT_PASSWORD_OPERATOR',
  },
  {
    externalId: 'seed-operator-2',
    login: PILOT_LOGINS.operator2,
    displayName: 'Хабибулин Руслан',
    role: Role.operator,
    passwordKey: 'SEED_PILOT_PASSWORD_OPERATOR_2',
  },
  {
    externalId: 'seed-operator-3',
    login: PILOT_LOGINS.operator3,
    displayName: 'Гайнулин Ильназ',
    role: Role.operator,
    passwordKey: 'SEED_PILOT_PASSWORD_OPERATOR_3',
  },
  {
    externalId: 'seed-warehouse',
    login: PILOT_LOGINS.warehouse,
    displayName: 'Склад',
    role: Role.warehouse,
    passwordKey: 'SEED_PILOT_PASSWORD_WAREHOUSE',
  },
  {
    externalId: 'seed-finance',
    login: PILOT_LOGINS.finance,
    displayName: 'Бухгалтерия',
    role: Role.finance,
    passwordKey: 'SEED_PILOT_PASSWORD_FINANCE',
  },
  {
    externalId: 'seed-director',
    login: PILOT_LOGINS.director,
    displayName: 'Директор',
    role: Role.director,
    passwordKey: 'SEED_PILOT_PASSWORD_DIRECTOR',
  },
  {
    externalId: 'seed-admin',
    login: PILOT_LOGINS.admin,
    displayName: 'Админ',
    role: Role.admin,
    passwordKey: 'SEED_PILOT_PASSWORD_ADMIN',
  },
] as const;

export const PILOT_PASSWORD_KEYS = PILOT_ACCOUNT_MANIFEST.map((account) => account.passwordKey);

export const PILOT_AGENT_TOKEN_KEYS = [
  'SEED_PILOT_AGENT_TOKEN_POST_1',
  'SEED_PILOT_AGENT_TOKEN_POST_2',
  'SEED_PILOT_AGENT_TOKEN_POST_3',
  'SEED_PILOT_AGENT_TOKEN_POST_4',
  'SEED_PILOT_AGENT_TOKEN_POST_5',
] as const;

type PilotPasswordKey = (typeof PILOT_ACCOUNT_MANIFEST)[number]['passwordKey'];
type PilotAgentTokenKey = (typeof PILOT_AGENT_TOKEN_KEYS)[number];

export interface DemoSeedProfile {
  password: string;
  profile: 'demo';
  scope: 'accounts' | 'full';
}

export interface PilotSeedProfile {
  agentTokens: Record<PilotAgentTokenKey, string>;
  passwords: Record<PilotPasswordKey, string>;
  profile: 'pilot';
  shortPasswordsEnabled: boolean;
}

export type SeedProfile = DemoSeedProfile | PilotSeedProfile;

export class SeedProfileError extends Error {
  constructor(message: string) {
    super(`Invalid seed configuration: ${message}`);
    this.name = 'SeedProfileError';
  }
}

function isDocumentedDemoSecret(value: string): boolean {
  return /^(?:agent-post-\d+|plenka-(?:dev|demo)(?:$|-))/i.test(value);
}

function duplicateKeys(entries: Array<readonly [string, string]>): string[] {
  const byValue = new Map<string, string[]>();
  for (const [key, value] of entries) {
    byValue.set(value, [...(byValue.get(value) ?? []), key]);
  }
  return [...byValue.values()].filter((keys) => keys.length > 1).flat();
}

function readPilotShortPasswordsEnabled(env: Environment): boolean {
  const value = env.PILOT_SHORT_PASSWORDS_ENABLED;
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new SeedProfileError('PILOT_SHORT_PASSWORDS_ENABLED must be exactly "true" or "false"');
}

function loadPilotProfile(env: Environment): PilotSeedProfile {
  if (env.APP_ENV !== 'pilot') {
    throw new SeedProfileError('SEED_PROFILE=pilot requires APP_ENV=pilot');
  }
  const shortPasswordsEnabled = readPilotShortPasswordsEnabled(env);

  const requiredKeys = [...PILOT_PASSWORD_KEYS, ...PILOT_AGENT_TOKEN_KEYS];
  const missingKeys = requiredKeys.filter((key) => !env[key]);
  if (missingKeys.length > 0) {
    throw new SeedProfileError(`missing required keys: ${missingKeys.join(', ')}`);
  }

  const passwords = Object.fromEntries(
    PILOT_ACCOUNT_MANIFEST.map((account) => [
      account.passwordKey,
      env[account.passwordKey] as string,
    ]),
  ) as Record<PilotPasswordKey, string>;
  const agentTokens = Object.fromEntries(
    PILOT_AGENT_TOKEN_KEYS.map((key) => [key, env[key] as string]),
  ) as Record<PilotAgentTokenKey, string>;
  const invalidKeys = new Set<string>();

  for (const account of PILOT_ACCOUNT_MANIFEST) {
    const password = passwords[account.passwordKey];
    try {
      if (shortPasswordsEnabled) {
        assertPilotPassword(password, true);
      } else {
        assertPasswordPolicy(password, account.login);
      }
    } catch {
      invalidKeys.add(account.passwordKey);
    }
    if (isDocumentedDemoSecret(password)) invalidKeys.add(account.passwordKey);
  }

  if (!shortPasswordsEnabled) {
    const pinKeys = PILOT_ACCOUNT_MANIFEST.filter((account) =>
      /^[0-9]{4}$/.test(passwords[account.passwordKey]),
    ).map((account) => account.passwordKey);
    if (pinKeys.length > 0) {
      throw new SeedProfileError(
        `PILOT_SHORT_PASSWORDS_ENABLED must be exactly "true" for four-digit pilot PIN keys: ${pinKeys.join(', ')}`,
      );
    }
  }

  for (const key of PILOT_AGENT_TOKEN_KEYS) {
    const token = agentTokens[key];
    if (!isCanonicalPilotAgentToken(token)) invalidKeys.add(key);
  }

  for (const key of duplicateKeys([
    ...PILOT_PASSWORD_KEYS.map((passwordKey) => [passwordKey, passwords[passwordKey]] as const),
    ...PILOT_AGENT_TOKEN_KEYS.map((tokenKey) => [tokenKey, agentTokens[tokenKey]] as const),
  ])) {
    invalidKeys.add(key);
  }

  if (invalidKeys.size > 0) {
    const orderedKeys = requiredKeys.filter((key) => invalidKeys.has(key));
    throw new SeedProfileError(`invalid or shared values for keys: ${orderedKeys.join(', ')}`);
  }

  return { agentTokens, passwords, profile: 'pilot', shortPasswordsEnabled };
}

export function loadSeedProfile(env: Environment): SeedProfile {
  const profile = env.SEED_PROFILE;
  if (profile !== 'demo' && profile !== 'pilot') {
    throw new SeedProfileError('SEED_PROFILE must be exactly one of: demo, pilot');
  }
  if (profile === 'pilot') return loadPilotProfile(env);
  if (env.APP_ENV !== 'development' && env.APP_ENV !== 'test') {
    throw new SeedProfileError('SEED_PROFILE=demo requires APP_ENV=development or test');
  }
  const scope = env.DEMO_SEED_SCOPE ?? 'full';
  if (scope !== 'full' && scope !== 'accounts') {
    throw new SeedProfileError('DEMO_SEED_SCOPE must be exactly one of: full, accounts');
  }
  return { password: env.SEED_PASSWORD ?? 'plenka-dev', profile: 'demo', scope };
}
