import { Role } from '@prisma/client';
import { AUDIT_SYSTEM_ACTOR_KEYS } from './audit-actor';
import {
  projectAuditActor,
  projectDomainEvent,
  type AuditAudience,
  type DomainEventRecord,
} from './audit-projection';

const createdAt = new Date('2026-07-25T08:00:00.000Z');

function deliveryEvent(
  detail: Record<string, unknown>,
  overrides: Partial<DomainEventRecord> = {},
): DomainEventRecord {
  return {
    id: 'event-1',
    family: 'audit',
    type: 'audit:warehouse_delivery_task_created',
    objectId: 'order-1',
    actorKind: 'user',
    actorRole: Role.commercial,
    actorId: 'commercial-1',
    systemActorKey: null,
    label: 'Delivery task created',
    detail,
    oldValue: null,
    newValue: null,
    reason: null,
    sourceSnapshotId: null,
    createdAt,
    ...overrides,
  };
}

describe('projectAuditActor', () => {
  it.each(AUDIT_SYSTEM_ACTOR_KEYS)(
    'projects the registered %s system actor without a fake role',
    (systemActorKey) => {
      expect(
        projectAuditActor({
          actorKind: 'system',
          actorRole: null,
          actorId: null,
          systemActorKey,
        }),
      ).toEqual({
        kind: 'system',
        key: systemActorKey,
        label: 'Система',
      });
    },
  );

  it.each([
    [Role.commercial, null],
    [Role.production_lead, 'production-1'],
    [Role.operator, null],
    [Role.warehouse, 'warehouse-1'],
    [Role.finance, null],
    [Role.director, 'director-1'],
    [Role.admin, null],
  ] as const)('preserves user role %s and its nullable user id', (actorRole, actorId) => {
    expect(
      projectAuditActor({
        actorKind: 'user',
        actorRole,
        actorId,
        systemActorKey: null,
      }),
    ).toEqual({
      kind: 'user',
      role: actorRole,
      userId: actorId,
    });
  });

  it.each([
    {
      actorKind: 'robot',
      actorRole: null,
      actorId: null,
      systemActorKey: null,
    },
    {
      actorKind: null,
      actorRole: null,
      actorId: null,
      systemActorKey: null,
    },
    {
      actorKind: 'system',
      actorRole: Role.admin,
      actorId: null,
      systemActorKey: 'warehouse_coverage_engine',
    },
    {
      actorKind: 'system',
      actorRole: null,
      actorId: 'fake-user',
      systemActorKey: 'warehouse_coverage_engine',
    },
    {
      actorKind: 'system',
      actorRole: null,
      actorId: null,
      systemActorKey: 'unknown_engine',
    },
    {
      actorKind: 'system',
      actorRole: null,
      actorId: null,
      systemActorKey: null,
    },
    {
      actorKind: 'user',
      actorRole: null,
      actorId: null,
      systemActorKey: null,
    },
    {
      actorKind: 'user',
      actorRole: 'unknown_role',
      actorId: null,
      systemActorKey: null,
    },
    {
      actorKind: 'user',
      actorRole: Role.admin,
      actorId: 42,
      systemActorKey: null,
    },
    {
      actorKind: 'user',
      actorRole: Role.admin,
      actorId: null,
      systemActorKey: 'warehouse_coverage_engine',
    },
  ])('fails closed for an invalid persisted actor %#', (actor) => {
    expect(() => projectAuditActor(actor as never)).toThrow('Invalid audit actor');
  });
});

describe('projectDomainEvent', () => {
  it('preserves legacy delivery event details for V1', () => {
    const detail = {
      orderId: 'order-1',
      warehouseTaskId: 'task-1',
      rollCodes: ['V1-1'],
      rollCount: 1,
    };

    expect(projectDomainEvent(deliveryEvent(detail), 'commercial')).toMatchObject({
      detail,
    });
  });

  it.each([
    'generic',
    'commercial',
    'production',
    'director',
    'finance',
    'warehouse',
    'admin',
  ] as const)('redacts exact V2 material data for %s', (audience: AuditAudience) => {
    const projected = projectDomainEvent(
      deliveryEvent({
        workflowVersion: 2,
        generation: 7,
        rollCount: 1,
        rollCodes: ['SECRET-1'],
        rollIds: ['roll-secret'],
        rawSpec: { widthMm: 1700 },
        calculationFingerprint: 'fingerprint-secret',
        counterparty: { id: 'counterparty-secret' },
        devicePayload: { serial: 'device-secret' },
      }),
      audience,
    );

    expect(projected.detail).toEqual({
      workflowVersion: 2,
      generation: 7,
      rollCount: 1,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /SECRET-1|roll-secret|widthMm|fingerprint-secret|counterparty-secret|device-secret/,
    );
  });
});
