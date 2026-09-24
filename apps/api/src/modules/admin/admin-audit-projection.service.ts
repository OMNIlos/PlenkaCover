import { Injectable } from '@nestjs/common';
import { projectDomainEvent } from '../../common/audit/audit-projection';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AdminAccessEventsQueryDto } from './dto/admin-query.dto';

export const ADMIN_ACCESS_EVENT_TYPES = [
  'admin.user.created',
  'admin.user.profile_updated',
  'admin.user.blocked',
  'admin.user.reactivated',
  'admin.user.password_reset',
  'admin.user.access_updated',
  'admin.access_template.created',
  'admin.access_template.updated',
  'audit:password_changed',
  'audit:session_revoked',
] as const;

const ADMIN_ACCESS_EVENT_SELECT = {
  id: true,
  type: true,
  objectId: true,
  actorKind: true,
  actorId: true,
  actorRole: true,
  systemActorKey: true,
  label: true,
  oldValue: true,
  newValue: true,
  reason: true,
  createdAt: true,
} as const;

@Injectable()
export class AdminAuditProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminAccessEventsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where = {
      type: { in: [...ADMIN_ACCESS_EVENT_TYPES] },
      ...(query.targetUserId ? { objectId: query.targetUserId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.domainEvent.findMany({
        where,
        select: ADMIN_ACCESS_EVENT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.domainEvent.count({ where }),
    ]);
    const items = rows.map((event) => projectDomainEvent(event, 'admin'));
    return { items, page, pageSize, total };
  }
}
