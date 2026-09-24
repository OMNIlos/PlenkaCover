import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CommercialProblemListItem, CommercialProblemPage } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommercialProblemQueryDto } from './dto/commercial-problem-query.dto';

type ProblemCursor = {
  createdAt: string;
  id: string;
};

const COMMERCIAL_PROBLEM_SELECT = {
  id: true,
  orderId: true,
  positionId: true,
  type: true,
  status: true,
  reason: true,
  recovery: true,
  actorRole: true,
  createdAt: true,
  resolvedAt: true,
  resolutionCase: { select: { ownerRole: true } },
  order: {
    select: {
      orderNumber: true,
      title: true,
      positions: { select: { id: true, filmType: true } },
    },
  },
} satisfies Prisma.ProductionProblemSelect;

type CommercialProblemRow = Prisma.ProductionProblemGetPayload<{
  select: typeof COMMERCIAL_PROBLEM_SELECT;
}>;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function decodeProblemCursor(value?: string): ProblemCursor | null {
  if (value === undefined) return null;
  try {
    if (!BASE64URL_PATTERN.test(value)) throw new Error('invalid cursor encoding');
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('noncanonical cursor encoding');

    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('invalid cursor payload');
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string' ||
      candidate.id.trim().length === 0 ||
      typeof candidate.createdAt !== 'string' ||
      !ISO_DATE_TIME_PATTERN.test(candidate.createdAt)
    ) {
      throw new Error('invalid cursor fields');
    }
    const createdAt = new Date(candidate.createdAt);
    if (
      !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== candidate.createdAt
    ) {
      throw new Error('invalid cursor date');
    }
    return { createdAt: candidate.createdAt, id: candidate.id };
  } catch {
    throw new BadRequestException('Invalid commercial problem cursor.');
  }
}

function encodeProblemCursor(row: Pick<CommercialProblemRow, 'createdAt' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id } satisfies ProblemCursor),
    'utf8',
  ).toString('base64url');
}

function cursorWhere(cursor: ProblemCursor | null): Prisma.ProductionProblemWhereInput {
  if (!cursor) return {};
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
  };
}

function projectProblem(row: CommercialProblemRow): CommercialProblemListItem {
  const order = row.order!;
  const position = row.positionId
    ? order.positions.find(({ id }) => id === row.positionId)
    : undefined;

  return {
    id: row.id,
    orderId: row.orderId!,
    orderNumber: order.orderNumber,
    orderTitle: order.title,
    positionId: row.positionId,
    positionFilmType: position?.filmType ?? null,
    type: row.type,
    status: row.status,
    reason: row.reason,
    recovery: row.recovery,
    reportedByRole: row.actorRole,
    ownerRole: row.resolutionCase?.ownerRole ?? null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class CommercialProblemService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CommercialProblemQueryDto): Promise<CommercialProblemPage> {
    const cursor = decodeProblemCursor(query.cursor);
    const rows = await this.prisma.productionProblem.findMany({
      where: {
        orderId: { not: null },
        ...(query.filter === 'open'
          ? { status: { not: 'resolved' } }
          : query.filter === 'resolved'
            ? { status: 'resolved' }
            : {}),
        ...cursorWhere(cursor),
      },
      select: COMMERCIAL_PROBLEM_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const hasNextPage = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);

    return {
      items: pageRows.map(projectProblem),
      nextCursor: hasNextPage && last ? encodeProblemCursor(last) : null,
    };
  }
}
