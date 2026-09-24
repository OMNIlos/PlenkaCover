import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_OPERATION_KEYS_STORAGE_KEY,
  AUTH_SESSION_STORAGE_KEY,
  clearSession,
  loadSession,
  saveSession,
  type AuthSession,
} from './authStorage';

function createStorage() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(value);
      values.set(key, value);
    },
    removeItem: (key: string) => void values.delete(key),
  };
}

const session: AuthSession = {
  version: 1,
  token: 'tok-1',
  role: 'production',
  serverRole: 'production_lead',
  userId: 'u-1',
  displayName: 'Зав. производства',
  expiresAt: '2026-08-01T00:00:00.000Z',
  passwordChangeRequired: false,
};

let storage: ReturnType<typeof createStorage>;

describe('authStorage', () => {
  beforeEach(() => {
    storage = createStorage();
    vi.stubGlobal('localStorage', storage);
    clearSession();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns null when the storage is empty', () => {
    expect(loadSession()).toBeNull();
  });

  it('round-trips the exact versioned session schema', () => {
    saveSession(session);
    expect(loadSession()).toEqual(session);
  });

  it('clears the session', () => {
    saveSession(session);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('clears account-scoped operation keys with the session', () => {
    saveSession(session);
    localStorage.setItem(
      AUTH_OPERATION_KEYS_STORAGE_KEY,
      JSON.stringify({ version: 1, userId: session.userId, keys: {} }),
    );

    clearSession();

    expect(localStorage.getItem(AUTH_OPERATION_KEYS_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['an old unversioned record', JSON.stringify({ ...session, version: undefined })],
    ['an unknown schema version', JSON.stringify({ ...session, version: 2 })],
    ['a missing token', JSON.stringify({ ...session, token: undefined })],
    ['an empty token', JSON.stringify({ ...session, token: '  ' })],
    ['an unknown UI role', JSON.stringify({ ...session, role: 'root' })],
    ['an unknown server role', JSON.stringify({ ...session, serverRole: 'root' })],
    [
      'a server/UI role mismatch',
      JSON.stringify({ ...session, role: 'admin', serverRole: 'production_lead' }),
    ],
    [
      'a missing password-setup flag',
      JSON.stringify({ ...session, passwordChangeRequired: undefined }),
    ],
    ['an unexpected field', JSON.stringify({ ...session, password: 'must-not-survive' })],
  ])('rejects %s and deletes it', (_case, raw) => {
    localStorage.setItem(AUTH_SESSION_STORAGE_KEY, raw);

    expect(loadSession()).toBeNull();
    expect(localStorage.getItem(AUTH_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('never persists password or confirmation fields supplied at runtime', () => {
    saveSession({
      ...session,
      password: 'new-password-secret',
      confirmationPassword: 'confirmation-secret',
    } as AuthSession);

    expect(storage.writes.join('\n')).not.toContain('new-password-secret');
    expect(storage.writes.join('\n')).not.toContain('confirmation-secret');
    expect(loadSession()).toEqual(session);
  });

  it('does not log a rejected stored value', () => {
    const raw = JSON.stringify({ ...session, token: 'do-not-log-this', extra: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    localStorage.setItem(AUTH_SESSION_STORAGE_KEY, raw);

    expect(loadSession()).toBeNull();
    expect([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join(' ')).not.toContain(
      'do-not-log-this',
    );
  });
});
