import type { Role } from '../domain/types';

const ALL_ROLES: readonly Role[] = [
  'commercial',
  'production',
  'finance',
  'director',
  'operator',
  'warehouse',
  'admin',
];

export function parseLiveContours(raw: string | undefined): Set<Role> {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is Role => (ALL_ROLES as readonly string[]).includes(item));
  return new Set(items);
}

export function resolveLiveContours(raw: string | undefined): Set<Role> {
  const liveContours = parseLiveContours(raw);
  if (liveContours.has('commercial')) liveContours.add('production');
  return liveContours;
}

export function resolveConfiguredLiveContours(
  raw: string | undefined,
  production: boolean,
): Set<Role> {
  const defaultContours = production ? ALL_ROLES.join(',') : 'commercial,production';
  return resolveLiveContours(raw === undefined ? defaultContours : raw);
}

// Production image is fully server-backed. Development may opt into a smaller explicit set;
// production remains an implicit dependency of commercial for a consistent handoff.
const configuredLiveContours = import.meta.env.VITE_LIVE_CONTOURS as string | undefined;
const live = resolveConfiguredLiveContours(configuredLiveContours, import.meta.env.PROD);

export function isLiveContour(role: Role): boolean {
  return live.has(role);
}
