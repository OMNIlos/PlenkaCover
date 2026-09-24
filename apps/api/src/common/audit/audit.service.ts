import { Injectable } from '@nestjs/common';
import { type DomainEventName, eventFamily } from '@plenka/contracts';
import type { DomainEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeAuditWriteActor, type AuditActorWriteInput } from './audit-actor';
import {
  projectDomainEvent,
  type AuditAudience,
  type SafeDomainEventProjection,
} from './audit-projection';

export interface RecordEventBase {
  /** Event name from @plenka/contracts DOMAIN_EVENTS, e.g. 'audit:defect_recorded'. */
  type: DomainEventName | string;
  objectId?: string | null;
  label?: string;
  detail?: Prisma.InputJsonValue;
  oldValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
  reason?: string;
  sourceSnapshotId?: string;
}

export type RecordEventInput = RecordEventBase & AuditActorWriteInput;

/**
 * Writes durable domain events / audit entries (ТЗ §5.6, §7, §11).
 *
 * Rules this service encodes:
 * - Events are append-only facts (never update/delete); corrections are NEW
 *   events carrying old/new/reason.
 * - Every disputed action, manual fix, override, source retry, reprint, cash
 *   operation and correction MUST be recorded (ТЗ §3, §8).
 * - `family` is derived from the event name so /api/events?family=... works.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    input: RecordEventInput,
    client: Pick<Prisma.TransactionClient, 'domainEvent'> = this.prisma,
  ): Promise<DomainEvent> {
    const actor = normalizeAuditWriteActor(input);
    return client.domainEvent.create({
      data: {
        family: eventFamily(input.type) ?? 'audit',
        type: input.type,
        objectId: input.objectId ?? null,
        actorKind: actor.kind,
        actorRole: actor.actorRole,
        actorId: actor.actorId,
        systemActorKey: actor.systemActorKey,
        label: input.label,
        detail: input.detail,
        oldValue: input.oldValue,
        newValue: input.newValue,
        reason: input.reason,
        sourceSnapshotId: input.sourceSnapshotId,
      },
    });
  }

  /** Read the audit/event trail for a business object (ТЗ §10 audit endpoints). */
  async forObject(objectId: string, audience: AuditAudience): Promise<SafeDomainEventProjection[]> {
    const events = await this.prisma.domainEvent.findMany({
      where: { objectId },
      orderBy: { createdAt: 'asc' },
    });
    return events.map((event) => projectDomainEvent(event, audience));
  }
}
