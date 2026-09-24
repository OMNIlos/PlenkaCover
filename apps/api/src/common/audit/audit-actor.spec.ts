import { Role } from '@prisma/client';
import {
  AUDIT_SYSTEM_ACTOR_KEYS,
  isAuditSystemActorKey,
  normalizeAuditWriteActor,
  ONEC_FINANCE_SYNC_SYSTEM_ACTOR_KEY,
  PAYROLL_TARIFF_BOOTSTRAP_SYSTEM_ACTOR_KEY,
  POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY,
  PRODUCTION_COST_RECONCILER_SYSTEM_ACTOR_KEY,
  WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
  WAREHOUSE_PALLET_CUTOVER_SYSTEM_ACTOR_KEY,
} from './audit-actor';
import { AuditService, type RecordEventInput } from './audit.service';

describe('audit write actor', () => {
  it('publishes one closed system-actor vocabulary and guard', () => {
    expect(AUDIT_SYSTEM_ACTOR_KEYS).toEqual([
      WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      WAREHOUSE_PALLET_CUTOVER_SYSTEM_ACTOR_KEY,
      ONEC_FINANCE_SYNC_SYSTEM_ACTOR_KEY,
      PRODUCTION_COST_RECONCILER_SYSTEM_ACTOR_KEY,
      PAYROLL_TARIFF_BOOTSTRAP_SYSTEM_ACTOR_KEY,
      POST_CATALOG_MIGRATION_SYSTEM_ACTOR_KEY,
    ]);
    for (const systemActorKey of AUDIT_SYSTEM_ACTOR_KEYS) {
      expect(isAuditSystemActorKey(systemActorKey)).toBe(true);
    }
    expect(isAuditSystemActorKey('unknown_engine')).toBe(false);
    expect(isAuditSystemActorKey(null)).toBe(false);
  });

  it('normalizes the legacy actorRole/actorId shape as a user actor', () => {
    expect(
      normalizeAuditWriteActor({
        actorRole: Role.finance,
        actorId: 'finance-user-1',
      }),
    ).toEqual({
      kind: 'user',
      actorRole: Role.finance,
      actorId: 'finance-user-1',
      systemActorKey: null,
    });
  });

  it.each([
    [Role.commercial, undefined],
    [Role.production_lead, null],
    [Role.operator, 'operator-1'],
    [Role.warehouse, undefined],
    [Role.finance, null],
    [Role.director, 'director-1'],
    [Role.admin, 'admin-1'],
  ] as const)('accepts user role %s with an optional actor id', (actorRole, actorId) => {
    expect(
      normalizeAuditWriteActor({
        actor: { kind: 'user', actorRole, actorId },
      }),
    ).toEqual({
      kind: 'user',
      actorRole,
      actorId: actorId ?? null,
      systemActorKey: null,
    });
  });

  it.each(AUDIT_SYSTEM_ACTOR_KEYS)('accepts the registered %s system actor', (systemActorKey) => {
    expect(
      normalizeAuditWriteActor({
        actor: {
          kind: 'system',
          systemActorKey,
        },
      }),
    ).toEqual({
      kind: 'system',
      actorRole: null,
      actorId: null,
      systemActorKey,
    });
  });

  it.each([
    {},
    { actorId: 'user-without-role' },
    { actorRole: null },
    { actorRole: 'unknown_role' },
    { actorRole: Role.admin, actorId: 42 },
    { actor: null },
    { actor: [] },
    { actor: 'system' },
    { actor: { kind: 'robot' } },
    { actor: { kind: 'user' } },
    { actor: { kind: 'user', actorRole: null } },
    { actor: { kind: 'user', actorRole: 'unknown_role' } },
    { actor: { kind: 'user', actorRole: Role.admin, actorId: 42 } },
    {
      actor: {
        kind: 'user',
        actorRole: Role.admin,
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      },
    },
    { actor: { kind: 'system' } },
    { actor: { kind: 'system', systemActorKey: 'unknown_engine' } },
    {
      actor: {
        kind: 'system',
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
        actorRole: Role.admin,
      },
    },
    {
      actor: {
        kind: 'system',
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
        actorId: null,
      },
    },
    {
      actor: {
        kind: 'system',
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      },
      actorRole: undefined,
    },
    {
      actor: {
        kind: 'system',
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      },
      actorId: null,
    },
  ])('rejects a malformed or mixed actor %#', (input) => {
    expect(() => normalizeAuditWriteActor(input as never)).toThrow('Invalid audit actor');
  });

  it('writes a system event without inventing a role or user', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'event-1' });
    const service = new AuditService({ domainEvent: { create } } as never);

    await service.record({
      type: 'audit:warehouse_coverage_calculated',
      actor: {
        kind: 'system',
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      },
      objectId: 'order-1',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorKind: 'system',
        actorRole: null,
        actorId: null,
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      }),
    });
  });

  it('keeps legacy user call sites compatible and writes a normalized discriminator', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'event-2' });
    const service = new AuditService({ domainEvent: { create } } as never);

    await service.record({
      type: 'audit:payment_status_updated',
      actorRole: Role.finance,
      actorId: null,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorKind: 'user',
        actorRole: Role.finance,
        actorId: null,
        systemActorKey: null,
      }),
    });
  });

  it('exposes mutually exclusive typed user and system inputs', () => {
    const accepts = (_input: RecordEventInput) => undefined;
    accepts({ type: 'audit:user', actorRole: Role.admin });
    accepts({
      type: 'audit:system',
      actor: {
        kind: 'system',
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      },
    });

    accepts({
      type: 'audit:mixed',
      // @ts-expect-error A record cannot mix explicit and legacy actor forms.
      actor: { kind: 'user', actorRole: Role.admin },
      actorRole: Role.admin,
    });
    // @ts-expect-error The system actor vocabulary is closed.
    accepts({ type: 'audit:unknown-system', actor: { kind: 'system', systemActorKey: 'x' } });
  });
});
