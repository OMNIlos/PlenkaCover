import { apiGet, apiGetWithBearer, apiPost, type ApiRequestOptions } from './client';
import { serverToUiRole, type ServerRole } from './roleMap';
import { clearSessionForToken, loadSession, saveSession, type AuthSession } from './authStorage';

type LoginResponse = {
  token: string;
  expiresAt: string;
  passwordChangeRequired: boolean;
  user: { id: string; role: ServerRole; displayName: string | null };
};

export type MeResponse = {
  userId: string;
  role: ServerRole;
  capabilities: string[];
  displayName: string | null;
  isActive: boolean;
  sessionPurpose: string | null;
  session: {
    id: string;
    purpose: string;
    state: 'active' | 'expired' | 'revoked';
    createdAt: string;
    expiresAt: string;
    lastSeenAt: string | null;
  } | null;
  workContext: {
    kind: 'office' | 'operator_post';
    assignment: { workplace?: string; shift?: string } | null;
  };
  passwordChangeRequired: boolean;
};

export async function login(loginName: string, password: string): Promise<AuthSession> {
  const data = await apiPost<LoginResponse>('/api/auth/login', { login: loginName, password });
  const session: AuthSession = {
    version: 1,
    token: data.token,
    role: serverToUiRole(data.user.role),
    serverRole: data.user.role,
    userId: data.user.id,
    displayName: data.user.displayName,
    expiresAt: data.expiresAt,
    passwordChangeRequired: data.passwordChangeRequired,
  };
  if (!saveSession(session)) throw new Error('Не удалось подтвердить вход');
  return session;
}

export function fetchMe(capturedToken?: string, options?: ApiRequestOptions): Promise<MeResponse> {
  return capturedToken
    ? apiGetWithBearer<MeResponse>('/api/auth/me', capturedToken, options)
    : apiGet<MeResponse>('/api/auth/me', options);
}

export async function changePassword(newPassword: string): Promise<void> {
  const token = loadSession()?.token;
  await apiPost<{ ok: true; reauthenticationRequired: true }>('/api/auth/change-password', {
    newPassword,
  });
  if (token) clearSessionForToken(token);
}

export async function logout(): Promise<void> {
  const token = loadSession()?.token;
  try {
    await apiPost<{ ok: true }>('/api/auth/logout');
  } catch {
    // сеть могла упасть — локальную сессию всё равно чистим
  } finally {
    if (token) clearSessionForToken(token);
  }
}
