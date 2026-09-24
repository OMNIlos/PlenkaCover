import type { MeResponse } from '../../api/auth';
import type { AuthSession } from '../../api/authStorage';
import { isServerRole, serverToUiRole } from '../../api/roleMap';

export const PASSWORD_CHANGED_NOTICE = 'Пароль изменён. Войдите снова.';

export type AuthRoute = 'application' | 'login' | 'checking' | 'password_setup';

export type AuthState = {
  route: AuthRoute;
  session: AuthSession | null;
  notice: string | null;
};

export type AuthAction =
  | { type: 'login_succeeded'; session: AuthSession }
  | { type: 'verification_succeeded'; session: AuthSession }
  | { type: 'verification_rejected' }
  | { type: 'auth_expired' }
  | { type: 'external_session_changed' }
  | { type: 'password_changed' };

const SESSION_PURPOSES = new Set(['full', 'password_setup']);

export function createInitialAuthState(
  authRequired: boolean,
  persistedSession: AuthSession | null,
): AuthState {
  if (!authRequired) {
    return { route: 'application', session: persistedSession, notice: null };
  }
  if (!persistedSession) return { route: 'login', session: null, notice: null };
  return { route: 'checking', session: persistedSession, notice: null };
}

export function reduceAuthState(_state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'login_succeeded':
    case 'verification_succeeded':
      return {
        route: action.session.passwordChangeRequired ? 'password_setup' : 'application',
        session: action.session,
        notice: null,
      };
    case 'password_changed':
      return { route: 'login', session: null, notice: PASSWORD_CHANGED_NOTICE };
    case 'verification_rejected':
    case 'auth_expired':
    case 'external_session_changed':
      return { route: 'login', session: null, notice: null };
  }
}

export function reconcileVerifiedSession(
  persistedSession: AuthSession,
  me: MeResponse,
  nowMs = Date.now(),
): AuthSession | null {
  if (!isServerRole(me.role) || me.role !== persistedSession.serverRole) return null;
  if (me.isActive !== true || me.userId !== persistedSession.userId || !me.session) return null;
  if (me.displayName !== null && typeof me.displayName !== 'string') return null;
  if (typeof me.passwordChangeRequired !== 'boolean') return null;
  if (me.session.state !== 'active') return null;
  if (
    !SESSION_PURPOSES.has(me.sessionPurpose ?? '') ||
    me.sessionPurpose !== me.session.purpose
  ) {
    return null;
  }
  const expiresAtMs = Date.parse(me.session.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;

  return {
    version: 1,
    token: persistedSession.token,
    role: serverToUiRole(me.role),
    serverRole: me.role,
    userId: me.userId,
    displayName: me.displayName,
    expiresAt: me.session.expiresAt,
    passwordChangeRequired:
      me.passwordChangeRequired || me.sessionPurpose === 'password_setup',
  };
}
