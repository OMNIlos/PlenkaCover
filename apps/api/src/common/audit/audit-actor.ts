import { ROLES, type Role } from '@plenka/contracts';

export const WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY = 'warehouse_coverage_engine' as const;
export const WAREHOUSE_PALLET_CUTOVER_SYSTEM_ACTOR_KEY = 'warehouse-pallet-cutover' as const;
export const ONEC_FINANCE_SYNC_SYSTEM_ACTOR_KEY = 'onec_finance_sync' as const;
export const PRODUCTION_COST_RECONCILER_SYSTEM_ACTOR_KEY = 'production_cost_reconciler' as const;
export const PAYROLL_TARIFF_BOOTSTRAP_SYSTEM_ACTOR_KEY = 'payroll_tariff_bootstrap' as const;
export const POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY = 'post_catalog_migration' as const;

export const AUDIT_SYSTEM_ACTOR_KEYS = [
  WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
  WAREHOUSE_PALLET_CUTOVER_SYSTEM_ACTOR_KEY,
  ONEC_FINANCE_SYNC_SYSTEM_ACTOR_KEY,
  PRODUCTION_COST_RECONCILER_SYSTEM_ACTOR_KEY,
  PAYROLL_TARIFF_BOOTSTRAP_SYSTEM_ACTOR_KEY,
  POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY,
] as const;

export type WarehouseCoverageSystemActorKey = typeof WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY;
export type AuditSystemActorKey = (typeof AUDIT_SYSTEM_ACTOR_KEYS)[number];

export type AuditWriteActor =
  | { kind: 'user'; actorRole: Role; actorId?: string | null }
  | { kind: 'system'; systemActorKey: AuditSystemActorKey };

export type AuditActorWriteInput =
  | { actor: AuditWriteActor; actorRole?: never; actorId?: never }
  | { actor?: never; actorRole: Role; actorId?: string | null };

export type NormalizedAuditWriteActor =
  | {
      kind: 'user';
      actorRole: Role;
      actorId: string | null;
      systemActorKey: null;
    }
  | {
      kind: 'system';
      actorRole: null;
      actorId: null;
      systemActorKey: AuditSystemActorKey;
    };

const ROLE_SET = new Set<string>(ROLES);
const AUDIT_SYSTEM_ACTOR_KEY_SET = new Set<string>(AUDIT_SYSTEM_ACTOR_KEYS);
const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLE_SET.has(value);
}

export function isAuditSystemActorKey(value: unknown): value is AuditSystemActorKey {
  return typeof value === 'string' && AUDIT_SYSTEM_ACTOR_KEY_SET.has(value);
}

function isOptionalActorId(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function invalidActor(): never {
  throw new Error('Invalid audit actor');
}

export function normalizeAuditWriteActor(input: AuditActorWriteInput): NormalizedAuditWriteActor {
  if (!isRecord(input)) invalidActor();

  if (hasOwn(input, 'actor')) {
    if (hasOwn(input, 'actorRole') || hasOwn(input, 'actorId')) invalidActor();
    const actor = input.actor;
    if (!isRecord(actor) || typeof actor.kind !== 'string') invalidActor();

    if (actor.kind === 'user') {
      if (
        !isRole(actor.actorRole) ||
        !isOptionalActorId(actor.actorId) ||
        hasOwn(actor, 'systemActorKey') ||
        Object.keys(actor).some((key) => !['kind', 'actorRole', 'actorId'].includes(key))
      ) {
        invalidActor();
      }
      return {
        kind: 'user',
        actorRole: actor.actorRole,
        actorId: actor.actorId ?? null,
        systemActorKey: null,
      };
    }

    if (actor.kind === 'system') {
      if (!isAuditSystemActorKey(actor.systemActorKey)) {
        invalidActor();
      }
      if (
        hasOwn(actor, 'actorRole') ||
        hasOwn(actor, 'actorId') ||
        Object.keys(actor).some((key) => !['kind', 'systemActorKey'].includes(key))
      ) {
        invalidActor();
      }
      return {
        kind: 'system',
        actorRole: null,
        actorId: null,
        systemActorKey: actor.systemActorKey,
      };
    }

    invalidActor();
  }

  if (
    !hasOwn(input, 'actorRole') ||
    !isRole(input.actorRole) ||
    !isOptionalActorId(input.actorId)
  ) {
    invalidActor();
  }
  return {
    kind: 'user',
    actorRole: input.actorRole,
    actorId: input.actorId ?? null,
    systemActorKey: null,
  };
}
