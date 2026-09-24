import { BadRequestException, Injectable } from '@nestjs/common';
import { CAPABILITIES, ROLE_CAPABILITIES, type Capability, type Role } from '@plenka/contracts';

export interface CapabilityOverrideLike {
  capability: string;
  effect: string;
}

export interface NormalizedAccessPolicy {
  grants: Capability[];
  denials: Capability[];
}

const isCapability = (value: string): value is Capability =>
  (CAPABILITIES as readonly string[]).includes(value);

const isPrivilegedCapability = (value: Capability): boolean =>
  value.startsWith('admin:') ||
  value.startsWith('override:') ||
  value === 'pallet_label_layout:manage';

@Injectable()
export class AccessPolicyService {
  isExplicitGrantAllowed(capability: Capability): boolean {
    return !isPrivilegedCapability(capability);
  }

  resolve(role: Role, overrides: readonly CapabilityOverrideLike[]): readonly Capability[] {
    const effective = new Set<Capability>(ROLE_CAPABILITIES[role]);

    for (const override of overrides) {
      if (!isCapability(override.capability) || override.effect !== 'allow') continue;
      if (isPrivilegedCapability(override.capability) || role === 'admin') continue;
      effective.add(override.capability);
    }

    for (const override of overrides) {
      if (isCapability(override.capability) && override.effect === 'deny') {
        effective.delete(override.capability);
      }
    }

    return CAPABILITIES.filter((capability) => effective.has(capability));
  }

  validate(
    role: Role,
    grants: readonly string[],
    denials: readonly string[],
  ): NormalizedAccessPolicy {
    const normalizedGrants = this.uniqueCapabilities(grants);
    const normalizedDenials = this.uniqueCapabilities(denials);
    const base = new Set<Capability>(ROLE_CAPABILITIES[role]);
    const grantSet = new Set(normalizedGrants);

    if (normalizedGrants.some(isPrivilegedCapability)) {
      throw this.forbidden('Admin and director override capabilities come only from base roles.');
    }
    if (role === 'admin' && normalizedGrants.length > 0) {
      throw this.forbidden('Admin accounts cannot receive routine business capabilities.');
    }
    if (normalizedDenials.some((capability) => grantSet.has(capability))) {
      throw this.invalid('The same capability cannot be both allowed and denied.');
    }
    if (
      normalizedDenials.some((capability) => !base.has(capability) && !grantSet.has(capability))
    ) {
      throw this.invalid('A denied capability must exist in the base role or explicit grants.');
    }

    return { grants: normalizedGrants, denials: normalizedDenials };
  }

  private uniqueCapabilities(values: readonly string[]): Capability[] {
    const unique = [...new Set(values)];
    if (unique.some((value) => !isCapability(value))) {
      throw this.forbidden('Unknown capability.');
    }
    return CAPABILITIES.filter((capability) => unique.includes(capability));
  }

  private forbidden(message: string): BadRequestException {
    return new BadRequestException({ code: 'ADMIN_CAPABILITY_FORBIDDEN', message });
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: 'ADMIN_ACCESS_INVALID', message });
  }
}
