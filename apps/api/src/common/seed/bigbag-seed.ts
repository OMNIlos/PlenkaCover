import { randomBytes } from 'node:crypto';

/**
 * Pre-staged test bags have already passed the warehouse registration and transfer steps.
 * The create-only payload keeps repeated seeds from moving or rewinding an existing bag.
 */
export function registeredProductionBigBagSeed() {
  return {
    registrationStatus: 'registered',
    location: 'production',
    locationRevision: 1,
    scanToken: {
      create: {
        token: `bbt_${randomBytes(32).toString('hex')}`,
      },
    },
  } as const;
}
