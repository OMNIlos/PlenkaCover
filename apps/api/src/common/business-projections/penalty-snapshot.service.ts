import { Injectable } from '@nestjs/common';
import type { PenaltySnapshot, PenaltySnapshotItem, PenaltySnapshotQuery } from '@plenka/contracts';
import { PrismaService } from '../prisma/prisma.service';

function normalizedReason(reason: string): string {
  return reason.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function topReason(items: PenaltySnapshotItem[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const reason = normalizedReason(item.reason);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      ([leftReason, leftCount], [rightReason, rightCount]) =>
        rightCount - leftCount || leftReason.localeCompare(rightReason, 'ru-RU'),
    )[0]?.[0] ?? null
  );
}

@Injectable()
export class PenaltySnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async read(query: PenaltySnapshotQuery): Promise<PenaltySnapshot> {
    const employeeId = query.employeeId?.trim();
    const rows = await this.prisma.penalty.findMany({
      where: {
        ...(query.targetRole ? { targetRole: query.targetRole } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(employeeId ? { employeeId } : {}),
      },
      select: {
        id: true,
        employeeId: true,
        employee: { select: { displayName: true } },
        targetRole: true,
        amount: true,
        reason: true,
        sourceObjectId: true,
        sourceProductionOrderId: true,
        sourceOrderNumber: true,
        sourceRollCode: true,
        authorRole: true,
        status: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    const items = rows.map<PenaltySnapshotItem>((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      displayName: row.employee?.displayName ?? null,
      targetRole: row.targetRole as PenaltySnapshotItem['targetRole'],
      amountKopecks: Math.round(row.amount * 100),
      reason: row.reason,
      sourceObjectId: row.sourceObjectId,
      sourceProductionOrderId: row.sourceProductionOrderId,
      sourceOrderNumber: row.sourceOrderNumber,
      sourceRollCode: row.sourceRollCode,
      authorRole: row.authorRole,
      status: row.status as PenaltySnapshotItem['status'],
      createdAt: row.createdAt.toISOString(),
    }));
    return {
      items,
      summary: {
        totalCount: items.length,
        totalAmountKopecks: items.reduce((total, item) => total + item.amountKopecks, 0),
        topReason: topReason(items),
      },
    };
  }
}
