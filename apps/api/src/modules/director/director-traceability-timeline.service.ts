import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type RawTraceabilityTimelineItem } from './director-traceability.projection';

const MAX_CONTEXT_LINKS = 100;
const MAX_TIMELINE_ITEMS = 50;

@Injectable()
export class DirectorTraceabilityTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async get(objectIds: Array<string | null>): Promise<RawTraceabilityTimelineItem[]> {
    const boundedIds = objectIds
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, MAX_CONTEXT_LINKS);
    if (boundedIds.length === 0) return [];

    const events = await this.prisma.domainEvent.findMany({
      where: { objectId: { in: boundedIds } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_TIMELINE_ITEMS,
      select: {
        id: true,
        type: true,
        label: true,
        reason: true,
        actorRole: true,
        actor: { select: { displayName: true, role: true } },
        createdAt: true,
      },
    });
    return events.slice(0, MAX_TIMELINE_ITEMS).map((event) => ({
      eventId: event.id,
      eventType: event.type,
      label: event.label,
      reason: event.reason,
      actorRole: event.actorRole,
      actor: event.actor,
      occurredAt: event.createdAt.toISOString(),
    }));
  }
}
