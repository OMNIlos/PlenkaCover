import { ROLES, type Role } from '@plenka/contracts';
import { isAuditSystemActorKey, type AuditSystemActorKey } from './audit-actor';

export type AuditAudience =
  | 'generic'
  | 'commercial'
  | 'production'
  | 'director'
  | 'finance'
  | 'warehouse'
  | 'admin';

export type SafeAuditActor =
  | { kind: 'user'; role: Role; userId: string | null }
  | {
      kind: 'system';
      key: AuditSystemActorKey;
      label: 'Система';
    };

export interface AuditActorProjectionInput {
  actorKind: string;
  actorRole: Role | null;
  actorId: string | null;
  systemActorKey: string | null;
}

export interface DomainEventRecord extends AuditActorProjectionInput {
  id: string;
  family?: string;
  type: string;
  objectId: string | null;
  label: string | null;
  detail?: unknown;
  oldValue?: unknown;
  newValue?: unknown;
  reason: string | null;
  sourceSnapshotId?: string | null;
  createdAt: Date;
}

export type SafeDomainEventProjection = Omit<DomainEventRecord, 'actorKind' | 'systemActorKey'> & {
  actor: SafeAuditActor;
};

const ROLE_SET = new Set<string>(ROLES);
const V2_WAREHOUSE_MATERIAL_EVENTS = new Set([
  'audit:warehouse_delivery_task_created',
  'audit:warehouse_coverage_reserved',
  'audit:warehouse_coverage_reservation_cancelled',
]);
const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLE_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidActor(): never {
  throw new Error('Invalid audit actor');
}

function detailIntegerOrNull(detail: unknown, key: string): number | null {
  if (!isRecord(detail)) return null;
  const value = detail[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function requireInteger(detail: unknown, key: string): number {
  const value = detailIntegerOrNull(detail, key);
  if (value === null) {
    throw new Error(`Invalid V2 audit detail: ${key} must be a non-negative integer`);
  }
  return value;
}

function materialRollCount(detail: unknown, type: string): number {
  const rollCount = detailIntegerOrNull(detail, 'rollCount');
  if (rollCount !== null) return rollCount;
  if (type === 'audit:warehouse_coverage_reserved') {
    return requireInteger(detail, 'reservedRollCount');
  }
  if (type === 'audit:warehouse_coverage_reservation_cancelled') {
    return requireInteger(detail, 'releasedRollCount');
  }
  return requireInteger(detail, 'rollCount');
}

function isSensitiveV2Key(key: string): boolean {
  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  return (
    normalized.includes('fingerprint') ||
    normalized.includes('counterparty') ||
    normalized.includes('device') ||
    normalized.includes('rawpayload') ||
    normalized.includes('spec') ||
    (normalized.startsWith('source') &&
      (normalized.endsWith('id') || normalized.endsWith('ids'))) ||
    normalized === 'roll' ||
    normalized === 'rolls' ||
    normalized.endsWith('rollid') ||
    normalized.endsWith('rollids') ||
    normalized.endsWith('rollcode') ||
    normalized.endsWith('rollcodes')
  );
}

function redactV2Payload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactV2Payload);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveV2Key(key))
      .map(([key, nested]) => [key, redactV2Payload(nested)]),
  );
}

export function projectAuditActor(event: {
  actorKind: 'user' | 'system';
  actorRole: Role | null;
  actorId: string | null;
  systemActorKey: string | null;
}): SafeAuditActor;
export function projectAuditActor(event: AuditActorProjectionInput): SafeAuditActor;
export function projectAuditActor(event: AuditActorProjectionInput): SafeAuditActor {
  if (event.actorKind === 'user') {
    if (
      !isRole(event.actorRole) ||
      (event.actorId !== null && typeof event.actorId !== 'string') ||
      event.systemActorKey !== null
    ) {
      invalidActor();
    }
    return {
      kind: 'user',
      role: event.actorRole,
      userId: event.actorId,
    };
  }

  if (event.actorKind === 'system') {
    if (
      event.actorRole !== null ||
      event.actorId !== null ||
      !isAuditSystemActorKey(event.systemActorKey)
    ) {
      invalidActor();
    }
    return {
      kind: 'system',
      key: event.systemActorKey,
      label: 'Система',
    };
  }

  return invalidActor();
}

export function projectDomainEvent(
  event: DomainEventRecord,
  audience: AuditAudience,
): SafeDomainEventProjection {
  void audience;
  const { actorKind, systemActorKey, ...common } = event;
  const actor = projectAuditActor({
    actorKind,
    actorRole: event.actorRole,
    actorId: event.actorId,
    systemActorKey,
  });
  const workflowVersion = detailIntegerOrNull(event.detail, 'workflowVersion');

  if (workflowVersion !== 2) {
    return { ...common, actor };
  }

  const safeCommon = {
    ...common,
    ...(hasOwn(common, 'oldValue') ? { oldValue: redactV2Payload(common.oldValue) } : {}),
    ...(hasOwn(common, 'newValue') ? { newValue: redactV2Payload(common.newValue) } : {}),
  };
  if (V2_WAREHOUSE_MATERIAL_EVENTS.has(event.type)) {
    return {
      ...safeCommon,
      detail: {
        workflowVersion: 2,
        generation: requireInteger(event.detail, 'generation'),
        rollCount: materialRollCount(event.detail, event.type),
      },
      actor,
    };
  }
  return {
    ...safeCommon,
    ...(hasOwn(common, 'detail') ? { detail: redactV2Payload(common.detail) } : {}),
    actor,
  };
}
