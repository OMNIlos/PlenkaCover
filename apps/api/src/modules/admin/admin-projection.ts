import {
  type AccountStatus,
  type Capability,
  type CapabilityOverrideEffect,
} from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import type { AccessPolicyService } from '../../common/auth/access-policy.service';

export const ADMIN_USER_SELECT = {
  id: true,
  externalId: true,
  login: true,
  identityProvider: true,
  displayName: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  passwordChangedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  capabilityOverrides: {
    select: { capability: true, effect: true, reason: true },
    orderBy: { capability: 'asc' as const },
  },
  sessions: {
    select: {
      id: true,
      purpose: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
    },
  },
} satisfies Prisma.UserSelect;

export type AdminUserRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>;

export interface AdminUserProjection {
  id: string;
  externalId: string | null;
  login: string;
  displayName: string;
  role: AdminUserRow['role'];
  status: AccountStatus;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  capabilities: readonly Capability[];
  grants: Capability[];
  denials: Capability[];
  activeSessionCount: number;
}

export function projectAdminUser(
  row: AdminUserRow,
  accessPolicy: AccessPolicyService,
  now = new Date(),
): AdminUserProjection {
  const status: AccountStatus = !row.isActive
    ? 'blocked'
    : row.mustChangePassword
      ? 'password_setup'
      : 'active';
  const validOverrides = row.capabilityOverrides.filter(
    (item): item is typeof item & { effect: CapabilityOverrideEffect } =>
      item.effect === 'allow' || item.effect === 'deny',
  );

  return {
    id: row.id,
    externalId: row.externalId,
    login: row.login,
    displayName: row.displayName,
    role: row.role,
    status,
    mustChangePassword: row.mustChangePassword,
    passwordChangedAt: row.passwordChangedAt,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    capabilities: accessPolicy.resolve(row.role, validOverrides),
    grants: validOverrides
      .filter((item) => item.effect === 'allow')
      .map((item) => item.capability as Capability),
    denials: validOverrides
      .filter((item) => item.effect === 'deny')
      .map((item) => item.capability as Capability),
    activeSessionCount: row.sessions.filter(
      (session) => !session.revokedAt && session.expiresAt.getTime() > now.getTime(),
    ).length,
  };
}
