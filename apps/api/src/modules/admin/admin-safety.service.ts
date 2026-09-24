import { ConflictException, Injectable } from '@nestjs/common';
import type { Role } from '@plenka/contracts';
import type { Prisma } from '@prisma/client';
import {
  AccessPolicyService,
  type CapabilityOverrideLike,
} from '../../common/auth/access-policy.service';

type SafetyClient = Pick<Prisma.TransactionClient, 'user'>;

export interface ControlAdminState {
  role: Role;
  isActive: boolean;
  overrides: readonly CapabilityOverrideLike[];
}

const USER_CONTROL_SELECT = {
  id: true,
  role: true,
  isActive: true,
  capabilityOverrides: { select: { capability: true, effect: true } },
} as const;

@Injectable()
export class AdminSafetyService {
  constructor(private readonly accessPolicy: AccessPolicyService) {}

  async assertControlAdminRemains(
    client: SafetyClient,
    targetId: string,
    prospective: ControlAdminState,
  ): Promise<void> {
    const current = await client.user.findUnique({
      where: { id: targetId },
      select: USER_CONTROL_SELECT,
    });
    if (!current || !this.isControlAdmin({ ...current, overrides: current.capabilityOverrides })) {
      return;
    }
    if (this.isControlAdmin(prospective)) return;

    const candidates = await client.user.findMany({
      where: { id: { not: targetId }, role: 'admin', isActive: true },
      select: USER_CONTROL_SELECT,
    });
    const anotherRemains = candidates.some((candidate) =>
      this.isControlAdmin({ ...candidate, overrides: candidate.capabilityOverrides }),
    );
    if (!anotherRemains) {
      throw new ConflictException({
        code: 'ADMIN_LAST_ACTIVE_ADMIN',
        message: 'At least one active administrator with access-management rights must remain.',
      });
    }
  }

  private isControlAdmin(state: ControlAdminState): boolean {
    if (!state.isActive || state.role !== 'admin') return false;
    const capabilities = this.accessPolicy.resolve(state.role, state.overrides);
    return capabilities.includes('admin:users') && capabilities.includes('admin:role_templates');
  }
}
