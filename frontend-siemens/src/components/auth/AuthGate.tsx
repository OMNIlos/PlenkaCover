import { useEffect, useReducer, type ReactNode } from 'react';
import { fetchMe, type MeResponse } from '../../api/auth';
import {
  AUTH_SESSION_STORAGE_KEY,
  clearSession,
  isCurrentSession,
  loadSession,
  saveSession,
  type AuthSession,
} from '../../api/authStorage';
import type { Role } from '../../domain/types';
import {
  createInitialAuthState,
  reconcileVerifiedSession,
  reduceAuthState,
  type AuthState,
} from './authFlow';
import { LoginScreen } from './LoginScreen';
import { PasswordChangeScreen } from './PasswordChangeScreen';

export const AUTH_REQUIRED = import.meta.env.PROD || import.meta.env.VITE_REQUIRE_AUTH === 'on';

type RoleHistoryTarget = {
  href: string;
  state: unknown;
  replaceState: (state: unknown, title: string, url?: string | URL | null) => void;
};

export function replaceAuthenticatedRole(role: Role, target?: RoleHistoryTarget): void {
  const browserTarget =
    target ??
    ({
      href: window.location.href,
      state: window.history.state,
      replaceState: window.history.replaceState.bind(window.history),
    } satisfies RoleHistoryTarget);
  const url = new URL(browserTarget.href);
  url.searchParams.set('role', role);
  browserTarget.replaceState(browserTarget.state, '', url.toString());
}

export async function verifyPersistedSession(
  persistedSession: AuthSession,
  dependencies: {
    fetchCurrentUser: (capturedToken: string) => Promise<MeResponse>;
    now: () => number;
  } = {
    fetchCurrentUser: fetchMe,
    now: Date.now,
  },
): Promise<AuthSession | null> {
  try {
    const me = await dependencies.fetchCurrentUser(persistedSession.token);
    if (!isCurrentSession(persistedSession)) return null;
    return reconcileVerifiedSession(persistedSession, me, dependencies.now());
  } catch {
    return null;
  }
}

type AuthGateViewProps = {
  state: AuthState;
  children: ReactNode;
  onLoginSuccess: (session: AuthSession) => void;
  onPasswordChanged: () => void;
};

export function AuthGateView({
  state,
  children,
  onLoginSuccess,
  onPasswordChanged,
}: AuthGateViewProps) {
  if (state.route === 'application') return <>{children}</>;
  if (state.route === 'login') {
    return <LoginScreen notice={state.notice} onSuccess={onLoginSuccess} />;
  }
  if (state.route === 'password_setup') {
    return <PasswordChangeScreen onSuccess={onPasswordChanged} />;
  }
  return (
    <div className="auth-screen">
      <div className="auth-workspace">
        <div className="auth-card auth-status-card" role="status" aria-live="polite">
          <div className="auth-card-header">
            <span className="eyebrow">Доступ</span>
            <h2>Проверяем доступ…</h2>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AuthGate({
  children,
  authRequired = AUTH_REQUIRED,
}: {
  children: ReactNode;
  authRequired?: boolean;
}) {
  const [state, dispatch] = useReducer(
    reduceAuthState,
    undefined,
    () => createInitialAuthState(authRequired, loadSession()),
  );

  useEffect(() => {
    if (!authRequired) return;
    const onExpired = () => {
      clearSession();
      dispatch({ type: 'auth_expired' });
    };
    const onExternalSessionChanged = (event: StorageEvent) => {
      if (event.key === AUTH_SESSION_STORAGE_KEY || event.key === null) {
        dispatch({ type: 'external_session_changed' });
      }
    };
    window.addEventListener('plenki:auth-expired', onExpired);
    window.addEventListener('storage', onExternalSessionChanged);
    return () => {
      window.removeEventListener('plenki:auth-expired', onExpired);
      window.removeEventListener('storage', onExternalSessionChanged);
    };
  }, [authRequired]);

  useEffect(() => {
    if (!authRequired || state.route !== 'checking' || !state.session) return;
    let active = true;
    const persistedSession = state.session;

    void verifyPersistedSession(persistedSession)
      .then((verifiedSession) => {
        if (!active) return;
        if (!verifiedSession) {
          if (isCurrentSession(persistedSession)) clearSession();
          dispatch({ type: 'verification_rejected' });
          return;
        }
        saveSession(verifiedSession);
        if (!verifiedSession.passwordChangeRequired) {
          replaceAuthenticatedRole(verifiedSession.role);
        }
        dispatch({ type: 'verification_succeeded', session: verifiedSession });
      });

    return () => {
      active = false;
    };
  }, [authRequired, state.route, state.session]);

  function handleLoginSuccess(session: AuthSession) {
    if (!session.passwordChangeRequired) replaceAuthenticatedRole(session.role);
    dispatch({ type: 'login_succeeded', session });
  }

  function handlePasswordChanged() {
    if (loadSession()) return;
    dispatch({ type: 'password_changed' });
  }

  return (
    <AuthGateView
      state={state}
      onLoginSuccess={handleLoginSuccess}
      onPasswordChanged={handlePasswordChanged}
    >
      {children}
    </AuthGateView>
  );
}
