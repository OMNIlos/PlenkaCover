import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as authApi from '../../api/auth';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '../../api/auth';
import { clearSession, loadSession, saveSession, type AuthSession } from '../../api/authStorage';
import {
  AuthGate,
  AuthGateView,
  replaceAuthenticatedRole,
  verifyPersistedSession,
} from './AuthGate';
import { PASSWORD_CHANGED_NOTICE, createInitialAuthState } from './authFlow';

const session: AuthSession = {
  version: 1,
  token: 'opaque-token-must-not-render',
  role: 'warehouse',
  serverRole: 'warehouse',
  userId: 'warehouse-1',
  displayName: 'Кладовщик',
  expiresAt: '2030-01-01T00:00:00.000Z',
  passwordChangeRequired: false,
};

const app = <div data-testid="erp-application-marker">ERP application</div>;

const me: MeResponse = {
  userId: 'warehouse-1',
  role: 'warehouse',
  capabilities: ['warehouse.read'],
  displayName: 'Кладовщик',
  isActive: true,
  sessionPurpose: 'full',
  session: {
    id: 'session-1',
    purpose: 'full',
    state: 'active',
    createdAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    lastSeenAt: null,
  },
  workContext: { kind: 'office', assignment: null },
  passwordChangeRequired: false,
};

beforeEach(() => {
  clearSession();
  saveSession(session);
});

afterEach(() => clearSession());

describe('persisted session bootstrap', () => {
  it('calls /me and returns only the verified server session', async () => {
    const fetchCurrentUser = vi.fn(async () => me);

    const verified = await verifyPersistedSession(session, {
      fetchCurrentUser,
      now: () => Date.parse('2026-07-17'),
    });

    expect(fetchCurrentUser).toHaveBeenCalledOnce();
    expect(verified).toMatchObject({ role: 'warehouse', serverRole: 'warehouse' });
  });

  it.each([
    ['mismatched response', async () => ({ ...me, role: 'admin' }) as MeResponse],
    ['failed request', async () => Promise.reject(new Error('401'))],
  ])('rejects a persisted session after a %s', async (_case, fetchCurrentUser) => {
    await expect(
      verifyPersistedSession(session, {
        fetchCurrentUser,
        now: () => Date.parse('2026-07-17'),
      }),
    ).resolves.toBeNull();
  });

  it('rejects bootstrap when shared storage replaces the captured session in flight', async () => {
    const replacement = { ...session, token: 'replacement-token' };
    let requestedToken: string | undefined;

    const verified = await verifyPersistedSession(session, {
      fetchCurrentUser: async (token?: string) => {
        requestedToken = token;
        saveSession(replacement);
        return me;
      },
      now: () => Date.parse('2026-07-17'),
    });

    expect(requestedToken).toBe(session.token);
    expect(verified).toBeNull();
    expect(loadSession()).toEqual(replacement);
  });
});

describe('AuthGateView', () => {
  it('renders a non-sensitive loading state and no ERP content while checking', () => {
    const html = renderToStaticMarkup(
      <AuthGateView
        state={createInitialAuthState(true, session)}
        onLoginSuccess={() => undefined}
        onPasswordChanged={() => undefined}
      >
        {app}
      </AuthGateView>,
    );

    expect(html).toContain('Проверяем доступ');
    expect(html).not.toContain('erp-application-marker');
    expect(html).not.toContain(session.token);
  });

  it('renders password setup without application or role-switcher content', () => {
    const html = renderToStaticMarkup(
      <AuthGateView
        state={{
          route: 'password_setup',
          session: { ...session, passwordChangeRequired: true },
          notice: null,
        }}
        onLoginSuccess={() => undefined}
        onPasswordChanged={() => undefined}
      >
        {app}
      </AuthGateView>,
    );

    expect(html).toContain('Новый пароль');
    expect(html).not.toContain('erp-application-marker');
    expect(html).not.toContain('demo-role-switcher');
  });

  it('renders application content only in the application state', () => {
    const html = renderToStaticMarkup(
      <AuthGateView
        state={{ route: 'application', session, notice: null }}
        onLoginSuccess={() => undefined}
        onPasswordChanged={() => undefined}
      >
        {app}
      </AuthGateView>,
    );

    expect(html).toContain('erp-application-marker');
  });

  it('shows the neutral password-change notice on the next login', () => {
    const html = renderToStaticMarkup(
      <AuthGateView
        state={{ route: 'login', session: null, notice: PASSWORD_CHANGED_NOTICE }}
        onLoginSuccess={() => undefined}
        onPasswordChanged={() => undefined}
      >
        {app}
      </AuthGateView>,
    );

    expect(html).toContain(PASSWORD_CHANGED_NOTICE);
    expect(html).not.toContain('erp-application-marker');
  });
});

describe('authenticated role URL reconciliation', () => {
  it('uses history replacement to overwrite an untrusted role query without navigation', () => {
    const replaceState = vi.fn();

    replaceAuthenticatedRole('warehouse', {
      href: 'https://pilot.example.test/?role=admin&section=Приемка#scan',
      state: { preserved: true },
      replaceState,
    });

    expect(replaceState).toHaveBeenCalledOnce();
    const [state, title, href] = replaceState.mock.calls[0];
    expect(state).toEqual({ preserved: true });
    expect(title).toBe('');
    const replaced = new URL(String(href));
    expect(replaced.searchParams.get('role')).toBe('warehouse');
    expect(replaced.searchParams.get('section')).toBe('Приемка');
    expect(replaced.hash).toBe('#scan');
  });
});

it('ignores a late password-change callback after a new login', async () => {
  const target = new EventTarget();
  vi.stubGlobal(
    'window',
    Object.assign(target, {
      location: { href: 'https://pilot.example.test/' },
      history: { state: null, replaceState: vi.fn() },
    }),
  );
  saveSession({ ...session, passwordChangeRequired: true });
  const fetchMeMock = vi
    .spyOn(authApi, 'fetchMe')
    .mockResolvedValue({ ...me, passwordChangeRequired: true });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<AuthGate authRequired>{app}</AuthGate>);
    });
    const staleCallback = renderer.root.findByType(AuthGateView).props.onPasswordChanged;
    saveSession({ ...session, token: 'new-login' });
    await act(async () => {
      renderer.root.findByType(AuthGateView).props.onLoginSuccess(loadSession());
    });
    expect(renderer.root.findByType(AuthGateView).props.state.route).toBe('application');
    await act(async () => staleCallback());
    expect(loadSession()?.token).toBe('new-login');
    expect(renderer.root.findByType(AuthGateView).props.state.route).toBe('application');
  } finally {
    await act(async () => renderer?.unmount());
    fetchMeMock.mockRestore();
    vi.unstubAllGlobals();
  }
});
