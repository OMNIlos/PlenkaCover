import { Role } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import {
  projectDomainEvent,
  type AuditAudience,
  type DomainEventRecord,
} from '../../common/audit/audit-projection';

const createdAt = new Date('2026-07-25T08:00:00.000Z');
const audiences: AuditAudience[] = [
  'generic',
  'commercial',
  'production',
  'director',
  'finance',
  'warehouse',
  'admin',
];

function event(
  type: DomainEventRecord['type'],
  detail: Record<string, unknown>,
): DomainEventRecord {
  return {
    id: `event-${type}`,
    family: 'audit',
    type,
    objectId: 'order-1',
    actorKind: 'system',
    actorRole: null,
    actorId: null,
    systemActorKey: 'warehouse_coverage_engine',
    label: null,
    detail,
    oldValue: null,
    newValue: null,
    reason: null,
    sourceSnapshotId: null,
    createdAt,
  };
}

describe('warehouse coverage audit redaction', () => {
  it.each([
    [
      'audit:warehouse_delivery_task_created',
      {
        workflowVersion: 2,
        generation: 11,
        rollCount: 2,
        rollCodes: ['DELIVERY-SECRET-1', 'DELIVERY-SECRET-2'],
        rollIds: ['delivery-roll-1', 'delivery-roll-2'],
      },
    ],
    [
      'audit:warehouse_coverage_reserved',
      {
        workflowVersion: 2,
        generation: 11,
        requiredRollCount: 2,
        reservedRollCount: 2,
        rollCodes: ['RESERVE-SECRET-1', 'RESERVE-SECRET-2'],
        rollIds: ['reserve-roll-1', 'reserve-roll-2'],
      },
    ],
    [
      'audit:warehouse_coverage_reservation_cancelled',
      {
        workflowVersion: 2,
        generation: 11,
        releasedRollCount: 2,
        rollCodes: ['CANCEL-SECRET-1', 'CANCEL-SECRET-2'],
        rollIds: ['cancel-roll-1', 'cancel-roll-2'],
      },
    ],
  ] as const)('keeps only aggregate detail for %s', (type, detail) => {
    for (const audience of audiences) {
      const projected = projectDomainEvent(event(type, detail), audience);
      expect(projected.detail).toEqual({
        workflowVersion: 2,
        generation: 11,
        rollCount: 2,
      });
      expect(JSON.stringify(projected)).not.toMatch(
        /SECRET|delivery-roll|reserve-roll|cancel-roll/,
      );
    }
  });

  it.each(audiences)(
    'removes raw spec, fingerprint, counterparty, and device leakage for %s',
    (audience) => {
      const projected = projectDomainEvent(
        event('audit:warehouse_coverage_calculated', {
          workflowVersion: 2,
          generation: 11,
          requiredRollCount: 2,
          rawSpec: { secret: 'raw-spec-secret' },
          sourceFingerprint: 'fingerprint-secret',
          counterparty: { name: 'counterparty-secret' },
          devicePayload: { raw: 'device-secret' },
          rollCodes: ['roll-code-secret'],
          rollIds: ['roll-id-secret'],
        }),
        audience,
      );
      const serialized = JSON.stringify(projected);

      expect(serialized).not.toMatch(
        /raw-spec-secret|fingerprint-secret|counterparty-secret|device-secret|roll-code-secret|roll-id-secret/,
      );
      expect(projected.detail).toMatchObject({
        workflowVersion: 2,
        generation: 11,
        requiredRollCount: 2,
      });
    },
  );

  it.each(['commercial', 'director'] as const)(
    'removes correction source identifiers and owner data for %s',
    (audience) => {
      const projected = projectDomainEvent(
        {
          ...event('audit:warehouse_roll_coverage_fact_corrected', {
            workflowVersion: 2,
            specFingerprint: 'f'.repeat(64),
            sourceOrderId: 'source-order-secret',
            sourcePositionId: 'source-position-secret',
          }),
          oldValue: {
            factId: 'old-fact',
            ownerCounterpartyId: 'old-owner-secret',
          },
          newValue: {
            factId: 'new-fact',
            ownerCounterpartyId: 'new-owner-secret',
          },
        },
        audience,
      );

      expect(JSON.stringify(projected)).not.toMatch(
        /source-order-secret|source-position-secret|old-owner-secret|new-owner-secret|f{64}/u,
      );
    },
  );

  it('projects a system event safely for every forObject audience', async () => {
    const persisted = event('audit:warehouse_coverage_reserved', {
      workflowVersion: 2,
      generation: 11,
      reservedRollCount: 2,
      rollIds: ['roll-secret'],
    });
    const prisma = {
      domainEvent: {
        findMany: jest.fn().mockResolvedValue([persisted]),
      },
    };
    const audit = new AuditService(prisma as never);

    for (const audience of audiences) {
      await expect(audit.forObject('order-1', audience)).resolves.toEqual([
        expect.objectContaining({
          actor: {
            kind: 'system',
            key: 'warehouse_coverage_engine',
            label: 'Система',
          },
          detail: {
            workflowVersion: 2,
            generation: 11,
            rollCount: 2,
          },
        }),
      ]);
    }
    expect(prisma.domainEvent.findMany).toHaveBeenCalledTimes(audiences.length);
    expect(prisma.domainEvent.findMany).toHaveBeenLastCalledWith({
      where: { objectId: 'order-1' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('preserves a user actor without exposing persistence-only actor fields', () => {
    const projected = projectDomainEvent(
      {
        ...event('audit:warehouse_coverage_reserved', {
          workflowVersion: 2,
          generation: 1,
          reservedRollCount: 1,
        }),
        actorKind: 'user',
        actorRole: Role.finance,
        actorId: 'finance-1',
        systemActorKey: null,
      },
      'finance',
    );

    expect(projected.actor).toEqual({
      kind: 'user',
      role: 'finance',
      userId: 'finance-1',
    });
    expect(projected).not.toHaveProperty('actorKind');
    expect(projected).not.toHaveProperty('systemActorKey');
  });
});
