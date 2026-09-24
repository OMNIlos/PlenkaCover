import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changePassword, fetchMe, login, logout } from './auth';
import {
  AUTH_SESSION_STORAGE_KEY,
  AUTH_OPERATION_KEYS_STORAGE_KEY,
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

const storedSession: AuthSession = {
  version: 1,
  token: 'setup-token',
  role: 'admin',
  serverRole: 'admin',
  userId: 'u-setup',
  displayName: null,
  expiresAt: '2026-08-01T00:00:00.000Z',
  passwordChangeRequired: true,
};

let storage: ReturnType<typeof createStorage>;

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  storage = createStorage();
  vi.stubGlobal('localStorage', storage);
  clearSession();
});

describe('auth api', () => {
  it('login retains the password-setup flag and versioned session metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          token: 'tok-77',
          expiresAt: '2030-07-08T00:00:00.000Z',
          passwordChangeRequired: true,
          user: { id: 'u-7', role: 'production_lead', displayName: 'Зав. производства (seed)' },
        }),
      })),
    );

    const session = await login('production', 'temporary-password');

    expect(session).toMatchObject({
      version: 1,
      role: 'production',
      serverRole: 'production_lead',
      expiresAt: '2030-07-08T00:00:00.000Z',
      passwordChangeRequired: true,
    });
    expect(loadSession()).toEqual(session);
  });

  it.each([
    [
      'unknown role',
      {
        token: 'tok-invalid',
        expiresAt: '2030-01-01T00:00:00.000Z',
        passwordChangeRequired: false,
        user: { id: 'u-7', role: 'root', displayName: null },
      },
    ],
    [
      'missing password-setup flag',
      {
        token: 'tok-invalid',
        expiresAt: '2030-01-01T00:00:00.000Z',
        user: { id: 'u-7', role: 'admin', displayName: null },
      },
    ],
  ])('login fails closed on a response with %s', async (_case, response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => response })),
    );

    await expect(login('admin', 'temporary-password')).rejects.toThrow(
      'Не удалось подтвердить вход',
    );
    expect(loadSession()).toBeNull();
  });

  it('change-password sends only newPassword and clears the revoked local session', async () => {
    saveSession(storedSession);
    const fetchMock = vi.fn(async (_path: string, _request?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, reauthenticationRequired: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await changePassword('a-new-password-123');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/change-password');
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body as string)).toEqual({ newPassword: 'a-new-password-123' });
    expect(loadSession()).toBeNull();
    expect(localStorage.getItem(AUTH_SESSION_STORAGE_KEY)).toBeNull();
    expect(storage.writes.join('\n')).not.toContain('a-new-password-123');
    expect(storage.writes.join('\n')).not.toContain('confirmation-secret');
  });

  it('fetches /me with the captured bearer instead of a replacement stored session', async () => {
    saveSession({ ...storedSession, token: 'replacement-token' });
    const fetchMock = vi.fn(async (_path: string, _request?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ userId: storedSession.userId }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchMe('captured-token');

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toMatchObject({ Authorization: 'Bearer captured-token' });
  });

  it('does not clear a replacement session when the captured bearer is rejected', async () => {
    const replacement = { ...storedSession, token: 'replacement-token' };
    saveSession(replacement);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Unauthorized' }),
      })),
    );

    await expect(fetchMe('captured-token')).rejects.toMatchObject({ status: 401 });

    expect(loadSession()).toEqual(replacement);
  });

  it.each(['logout success', 'logout failure', 'change password'])(
    'preserves a replacement session and its recovery journal after late %s',
    async (operation) => {
      saveSession(storedSession);
      let finish!: () => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((resolve, reject) => {
              finish = () =>
                operation === 'logout failure'
                  ? reject(new TypeError('offline'))
                  : resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
            }),
        ),
      );
      const pending = operation === 'change password' ? changePassword('new-password') : logout();
      const replacement = { ...storedSession, token: 'new-token' };
      saveSession(replacement);
      localStorage.setItem(AUTH_OPERATION_KEYS_STORAGE_KEY, 'new-operation-journal');
      finish();
      await pending;
      expect(loadSession()).toEqual(replacement);
      expect(localStorage.getItem(AUTH_OPERATION_KEYS_STORAGE_KEY)).toBe('new-operation-journal');
    },
  );

  it('logout clears the session even when the network is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    saveSession(storedSession);

    await logout();

    expect(loadSession()).toBeNull();
  });
});
