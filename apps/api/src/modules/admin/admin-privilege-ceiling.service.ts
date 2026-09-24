import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@plenka/contracts';
import type { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import {
  AccessPolicyService,
  type CapabilityOverrideLike,
} from '../../common/auth/access-policy.service';

type PrivilegeClient = Pick<Prisma.TransactionClient, 'user'>;

export interface AdminAuthority {
  actorId: string;
  actorRole: Role;
  effective: readonly Capability[];
  isFullControlAdmin: boolean;
}

export interface AdminAccessState {
  role: Role;
  overrides: readonly CapabilityOverrideLike[];
}

const AUTHORITY_SELECT = {
  id: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  capabilityOverrides: { select: { capability: true, effect: true } },
} as const;

@Injectable()
export class AdminPrivilegeCeilingService {
  constructor(private readonly accessPolicy: AccessPolicyService) {}

  async loadAuthority(client: PrivilegeClient, actor: Actor): Promise<AdminAuthority> {
    if (!actor.userId) {
      throw new UnauthorizedException('Authenticated administrator required.');
    }

    const current = await client.user.findUnique({
      where: { id: actor.userId },
      select: AUTHORITY_SELECT,
    });
    if (!current || !current.isActive || current.mustChangePassword) {
      throw this.denied();
    }

    const effective = this.accessPolicy.resolve(current.role, current.capabilityOverrides);
    if (!effective.includes('admin:users') || !effective.includes('admin:role_templates')) {
      throw this.denied();
    }

    return {
      actorId: current.id,
      actorRole: current.role,
      effective,
      isFullControlAdmin: ROLE_CAPABILITIES.admin.every((capability) =>
        effective.includes(capability),
      ),
    };
  }

  assertCanAdministerTarget(
    authority: AdminAuthority,
    targetId: string,
    current: AdminAccessState,
    prospective?: AdminAccessState,
  ): void {
    if (targetId === authority.actorId) {
      if (prospective && !this.isSubsetOfAuthority(authority, prospective)) {
        throw this.denied();
      }
      return;
    }

    if (!this.isWithinCeiling(authority, current)) throw this.denied();
    if (prospective && !this.isWithinCeiling(authority, prospective)) throw this.denied();
  }

  assertCanAdministerPolicy(
    authority: AdminAuthority,
    current: AdminAccessState | undefined,
    prospective: AdminAccessState,
  ): void {
    if (current && !this.isWithinCeiling(authority, current)) throw this.denied();
    if (!this.isWithinCeiling(authority, prospective)) throw this.denied();
  }

  canGrantCapability(authority: AdminAuthority, capability: Capability): boolean {
    if (!this.accessPolicy.isExplicitGrantAllowed(capability)) return false;
    return authority.isFullControlAdmin || authority.effective.includes(capability);
  }

  private isWithinCeiling(authority: AdminAuthority, state: AdminAccessState): boolean {
    return authority.isFullControlAdmin || this.isSubsetOfAuthority(authority, state);
  }

  private isSubsetOfAuthority(authority: AdminAuthority, state: AdminAccessState): boolean {
    const held = new Set(authority.effective);
    return this.accessPolicy
      .resolve(state.role, state.overrides)
      .every((capability) => held.has(capability));
  }

  private denied(): ForbiddenException {
    return new ForbiddenException({
      code: 'ADMIN_PRIVILEGE_CEILING',
      message: 'The requested account or access change exceeds current administrative authority.',
    });
  }
}
