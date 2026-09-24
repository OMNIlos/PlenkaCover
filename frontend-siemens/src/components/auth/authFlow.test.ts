import { describe, expect, it } from 'vitest';
import type { MeResponse } from '../../api/auth';
import type { AuthSession } from '../../api/authStorage';
import {
  PASSWORD_CHANGED_NOTICE,
  createInitialAuthState,
  reconcileVerifiedSession,
  reduceAuthState,
} from './authFlow';

const persistedSession: AuthSession = {
  version: 1,
  token: 'opaque-token',
  role: 'production',
  serverRole: 'production_lead',
  userId: 'user-1',
  displayName: 'Старое имя',
  expiresAt: '2030-01-01T00:00:00.000Z',
  passwordChangeRequired: false,
};

const me: MeResponse = {
  userId: 'user-1',
  role: 'production_lead',
  capabilities: ['production.read'],
  displayName: 'Зав. производства',
  isActive: true,
  sessionPurpose: 'full',
  session: {
    id: 'session-1',
    purpose: 'full',
    state: 'active',
    createdAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    lastSeenAt: '2026-07-17T00:01:00.000Z',
  },
  workContext: { kind: 'office', assignment: null },
  passwordChangeRequired: false,
};

describe('initial auth route', () => {
  it('enters the application immediately only when authentication is not required', () => {
    expect(createInitialAuthState(false, null)).toMatchObject({ route: 'application' });
  });

  it('shows login when authentication is required without a session', () => {
    expect(createInitialAuthState(true, null)).toEqual({
      route: 'login',
      session: null,
      notice: null,
    });
  });

  it('checks a persisted session before exposing application content', () => {
    expect(createInitialAuthState(true, persistedSession)).toEqual({
      route: 'checking',
      session: persistedSession,
      notice: null,
    });
  });
});

describe('server session reconciliation', () => {
  it('maps a verified server role and enters the full application', () => {
    const verified = reconcileVerifiedSession(persistedSession, me, Date.parse('2026-07-17'));

    expect(verified).toMatchObject({
      role: 'production',
      serverRole: 'production_lead',
      displayName: 'Зав. производства',
      passwordChangeRequired: false,
    });
    expect(
      reduceAuthState(createInitialAuthState(true, persistedSession), {
        type: 'verification_succeeded',
        session: verified!,
      }).route,
    ).toBe('application');
  });

  it.each([
    ['password_setup purpose', { sessionPurpose: 'password_setup' }],
    ['required flag', { passwordChangeRequired: true }],
  ])('routes a verified %s session to password setup', (_case, override) => {
    const setupMe = {
      ...me,
      ...override,
      session: {
        ...me.session!,
        purpose:
          'sessionPurpose' in override && override.sessionPurpose === 'password_setup'
            ? 'password_setup'
            : me.session!.purpose,
      },
    };
    const verified = reconcileVerifiedSession(
      persistedSession,
      setupMe,
      Date.parse('2026-07-17'),
    );

    expect(verified?.passwordChangeRequired).toBe(true);
    expect(
      reduceAuthState(createInitialAuthState(true, persistedSession), {
        type: 'verification_succeeded',
        session: verified!,
      }).route,
    ).toBe('password_setup');
  });

  it.each([
    ['server role mismatch', { role: 'admin' }],
    ['inactive user', { isActive: false }],
    ['expired session state', { session: { ...me.session!, state: 'expired' } }],
    [
      'expired timestamp',
      { session: { ...me.session!, expiresAt: '2020-01-01T00:00:00.000Z' } },
    ],
    ['missing session metadata', { session: null }],
    ['malformed display name', { displayName: { secret: 'unexpected' } }],
    ['missing password-setup flag', { passwordChangeRequired: undefined }],
  ])('rejects %s', (_case, override) => {
    const invalidMe = { ...me, ...override } as MeResponse;

    expect(
      reconcileVerifiedSession(persistedSession, invalidMe, Date.parse('2026-07-17')),
    ).toBeNull();
  });
});

describe('auth transitions', () => {
  it('routes a setup login result without mounting the application', () => {
    const state = reduceAuthState(createInitialAuthState(true, null), {
      type: 'login_succeeded',
      session: { ...persistedSession, passwordChangeRequired: true },
    });

    expect(state.route).toBe('password_setup');
  });

  it('routes a full login result to the application', () => {
    const state = reduceAuthState(createInitialAuthState(true, null), {
      type: 'login_succeeded',
      session: persistedSession,
    });

    expect(state.route).toBe('application');
  });

  it.each(['verification_rejected', 'auth_expired'] as const)(
    '%s clears the session and returns to login',
    (type) => {
      const state = reduceAuthState(createInitialAuthState(true, persistedSession), { type });

      expect(state).toEqual({ route: 'login', session: null, notice: null });
    },
  );

  it('unmounts an open application when another tab changes the session', () => {
    const state = reduceAuthState(
      { route: 'application', session: persistedSession, notice: null },
      { type: 'external_session_changed' },
    );

    expect(state).toEqual({ route: 'login', session: null, notice: null });
  });

  it('successful password setup clears auth and shows a neutral login notice', () => {
    const state = reduceAuthState(
      { route: 'password_setup', session: persistedSession, notice: null },
      { type: 'password_changed' },
    );

    expect(state).toEqual({
      route: 'login',
      session: null,
      notice: PASSWORD_CHANGED_NOTICE,
    });
    expect(PASSWORD_CHANGED_NOTICE).not.toMatch(/парол.{0,4}[:=]/i);
  });
});
