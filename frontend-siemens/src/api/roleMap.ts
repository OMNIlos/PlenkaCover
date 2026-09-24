import type { Role } from '../domain/types';

// Дубликат серверного union из @plenka/contracts (бэкенд — другой репозиторий,
// импорт невозможен). Единственное расхождение с UI-ролями: production_lead.
export type ServerRole =
  | 'commercial'
  | 'production_lead'
  | 'operator'
  | 'warehouse'
  | 'finance'
  | 'director'
  | 'admin';

const SERVER_ROLES = new Set<ServerRole>([
  'commercial',
  'production_lead',
  'operator',
  'warehouse',
  'finance',
  'director',
  'admin',
]);

const UI_ROLES = new Set<Role>([
  'commercial',
  'production',
  'operator',
  'warehouse',
  'finance',
  'director',
  'admin',
]);

export function isServerRole(value: unknown): value is ServerRole {
  return typeof value === 'string' && SERVER_ROLES.has(value as ServerRole);
}

export function isUiRole(value: unknown): value is Role {
  return typeof value === 'string' && UI_ROLES.has(value as Role);
}

export function serverToUiRole(role: ServerRole): Role {
  return role === 'production_lead' ? 'production' : role;
}

export function uiToServerRole(role: Role): ServerRole {
  return role === 'production' ? 'production_lead' : role;
}
