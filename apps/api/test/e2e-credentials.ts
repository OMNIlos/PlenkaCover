import { PILOT_LOGINS } from '../src/common/seed/seed-profile';

export function e2eSeedLogin(account: keyof typeof PILOT_LOGINS): string {
  return PILOT_LOGINS[account];
}

export function e2eSeedPassword(): string {
  const password = process.env.SEED_PASSWORD;
  if (!password) {
    throw new Error('SEED_PASSWORD must be provided by the e2e environment setup');
  }
  return password;
}
