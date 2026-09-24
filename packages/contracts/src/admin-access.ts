import type { Capability } from './roles';

export const ACCOUNT_STATUSES = ['active', 'password_setup', 'blocked'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const SESSION_PURPOSES = ['full', 'password_setup'] as const;
export type SessionPurpose = (typeof SESSION_PURPOSES)[number];

export const CAPABILITY_OVERRIDE_EFFECTS = ['allow', 'deny'] as const;
export type CapabilityOverrideEffect = (typeof CAPABILITY_OVERRIDE_EFFECTS)[number];

export interface CapabilityOverrideContract {
  capability: Capability;
  effect: CapabilityOverrideEffect;
  reason: string;
}
