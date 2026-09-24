import type { Role } from '../domain/types';
import { isServerRole, serverToUiRole, type ServerRole } from './roleMap';

export type AuthSession = {
  version: 1;
  token: string;
  role: Role;
  serverRole: ServerRole;
  userId: string;
  displayName: string | null;
  expiresAt: string;
  passwordChangeRequired: boolean;
};

export const AUTH_SESSION_STORAGE_KEY = 'plenki.auth.v1';
export const AUTH_OPERATION_KEYS_STORAGE_KEY = 'plenki.idempotent-operations.v1';

const SESSION_FIELDS = [
  'version',
  'token',
  'role',
  'serverRole',
  'userId',
  'displayName',
  'expiresAt',
  'passwordChangeRequired',
] as const;

const memory = new Map<string, string>();

type Backing = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function backing(): Backing {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // приватный режим/недоступный storage — падаем в память
  }
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  };
}

export function saveSession(session: AuthSession): boolean {
  const stored: AuthSession = {
    version: session.version,
    token: session.token,
    role: session.role,
    serverRole: session.serverRole,
    userId: session.userId,
    displayName: session.displayName,
    expiresAt: session.expiresAt,
    passwordChangeRequired: session.passwordChangeRequired,
  };
  if (!isAuthSession(stored)) {
    clearSession();
    return false;
  }
  backing().setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(stored));
  return true;
}

export function loadSession(): AuthSession | null {
  const storage = backing();
  const raw = storage.getItem(AUTH_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isAuthSession(parsed)) return parsed;
  } catch {
    // Rejected records are intentionally not logged: they may contain secret material.
  }
  storage.removeItem(AUTH_SESSION_STORAGE_KEY);
  return null;
}

export function clearSession(): void {
  const storage = backing();
  storage.removeItem(AUTH_SESSION_STORAGE_KEY);
  storage.removeItem(AUTH_OPERATION_KEYS_STORAGE_KEY);
}

export function isCurrentSession(expected: AuthSession): boolean {
  const current = loadSession();
  return (
    current !== null && SESSION_FIELDS.every((field) => current[field] === expected[field])
  );
}

export function clearSessionForToken(token: string): boolean {
  if (loadSession()?.token !== token) return false;
  clearSession();
  return true;
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record);
  if (
    fields.length !== SESSION_FIELDS.length ||
    !fields.every((field) => SESSION_FIELDS.includes(field as (typeof SESSION_FIELDS)[number]))
  ) {
    return false;
  }
  if (record.version !== 1 || typeof record.passwordChangeRequired !== 'boolean') return false;
  if (typeof record.token !== 'string' || !record.token.trim()) return false;
  if (typeof record.userId !== 'string' || !record.userId.trim()) return false;
  if (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))) {
    return false;
  }
  if (record.displayName !== null && typeof record.displayName !== 'string') return false;
  if (!isServerRole(record.serverRole)) return false;
  return record.role === serverToUiRole(record.serverRole);
}
