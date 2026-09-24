import type { ReactNode } from 'react';
import { isUiRole } from '../../api/roleMap';
import type { Role } from '../../domain/types';

export function resolveInitialRole({
  authRequired,
  verifiedRole,
  search,
}: {
  authRequired: boolean;
  verifiedRole: Role | null;
  search: string;
}): Role {
  if (isUiRole(verifiedRole)) return verifiedRole;
  if (authRequired) return 'commercial';
  const queryRole = new URLSearchParams(search).get('role');
  return isUiRole(queryRole) ? queryRole : 'commercial';
}

export function DemoRoleSwitcherGate({
  authRequired,
  children,
}: {
  authRequired: boolean;
  children: ReactNode;
}) {
  return authRequired ? null : <>{children}</>;
}
