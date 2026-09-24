import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Role } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { LEGAL_NAME_ROLES, projectCounterparty, type ProjectedCounterparty } from './projection';
import type { CreateCounterpartyDto } from './dto/create-counterparty.dto';

export interface CounterpartyActor {
  userId: string | null;
  role: Role;
}

const MAX_COUNTERPARTIES = 500;
const MAX_COUNTERPARTY_SEARCH_PAGE_SIZE = 50;

interface CounterpartySearchQuery {
  q?: string;
  cursor?: string;
  limit?: number;
}

interface CounterpartySearchCursor {
  displayName: string;
  id: string;
}

export interface CounterpartySearchPage {
  items: ProjectedCounterparty[];
  nextCursor: string | null;
}

function normalizeCounterpartyInn(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.replace(/\s+/gu, '').toUpperCase() || null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function encodeSearchCursor(cursor: CounterpartySearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeSearchCursor(value?: string): CounterpartySearchCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<CounterpartySearchCursor>;
    if (
      typeof cursor.displayName !== 'string' ||
      cursor.displayName.length === 0 ||
      cursor.displayName.length > 200 ||
      typeof cursor.id !== 'string' ||
      cursor.id.length === 0 ||
      cursor.id.length > 200
    ) {
      throw new Error('invalid');
    }
    return { displayName: cursor.displayName, id: cursor.id };
  } catch {
    throw new BadRequestException({
      code: 'COUNTERPARTY_SEARCH_CURSOR_INVALID',
      message: 'Курсор поиска контрагентов недействителен.',
    });
  }
}

function counterpartySearchLimit(value = 20): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_COUNTERPARTY_SEARCH_PAGE_SIZE) {
    throw new BadRequestException({
      code: 'COUNTERPARTY_SEARCH_LIMIT_INVALID',
      message: 'Размер страницы поиска контрагентов должен быть от 1 до 50.',
    });
  }
  return value;
}

/**
 * Counterparty read + quick-create for the commercial contour (V2 C1).
 * Read is role-projected (legal name/inn gated by `projectCounterparty`);
 * create is idempotent by INN and appends a durable audit event.
 */
@Injectable()
export class CounterpartyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actorRole: Role): Promise<ProjectedCounterparty[]> {
    const rows = await this.prisma.counterparty.findMany({
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: MAX_COUNTERPARTIES + 1,
    });
    if (rows.length > MAX_COUNTERPARTIES) {
      throw new UnprocessableEntityException({
        code: 'COUNTERPARTY_CATALOG_TOO_LARGE',
        message: 'Слишком много контрагентов для безопасной выдачи. Уточните критерий поиска.',
      });
    }
    return rows.map((c) => projectCounterparty(c, actorRole));
  }

  async search(actorRole: Role, query: CounterpartySearchQuery): Promise<CounterpartySearchPage> {
    const limit = counterpartySearchLimit(query.limit);
    const cursor = decodeSearchCursor(query.cursor);
    const q = query.q?.trim().replace(/\s+/gu, ' ') ?? '';
    const normalizedInn = q.replace(/\s+/gu, '');
    const searchScope: Prisma.CounterpartyWhereInput | null = q
      ? LEGAL_NAME_ROLES.has(actorRole)
        ? {
            OR: [
              { displayName: { contains: q, mode: 'insensitive' } },
              { legalName: { contains: q, mode: 'insensitive' } },
              { inn: { contains: normalizedInn, mode: 'insensitive' } },
            ],
          }
        : { displayName: { contains: q, mode: 'insensitive' } }
      : null;
    const cursorScope: Prisma.CounterpartyWhereInput | null = cursor
      ? {
          OR: [
            { displayName: { gt: cursor.displayName } },
            { displayName: cursor.displayName, id: { gt: cursor.id } },
          ],
        }
      : null;
    const scopes = [searchScope, cursorScope].filter(
      (scope): scope is Prisma.CounterpartyWhereInput => scope !== null,
    );
    const where =
      scopes.length === 0 ? undefined : scopes.length === 1 ? scopes[0] : { AND: scopes };
    const rows = await this.prisma.counterparty.findMany({
      ...(where ? { where } : {}),
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((counterparty) => projectCounterparty(counterparty, actorRole)),
      nextCursor:
        rows.length > limit && last
          ? encodeSearchCursor({ displayName: last.displayName, id: last.id })
          : null,
    };
  }

  async create(
    actor: CounterpartyActor,
    dto: CreateCounterpartyDto,
  ): Promise<ProjectedCounterparty> {
    const inn = normalizeCounterpartyInn(dto.inn);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        if (inn !== null) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`counterparty-manual-inn:${inn}`}))`;
          const manual = await tx.counterparty.findFirst({
            where: { inn, billingSource: 'manual_platform' },
            orderBy: { id: 'asc' },
          });
          if (manual) return manual;
          const matches = await tx.counterparty.findMany({
            where: { inn, NOT: { billingSource: 'manual_platform' } },
            orderBy: [{ kpp: 'asc' }, { id: 'asc' }],
            take: 2,
          });
          if (matches.length === 1) return matches[0]!;
          if (matches.length > 1) {
            throw new ConflictException({
              code: 'COUNTERPARTY_INN_AMBIGUOUS',
              message: 'Для этого ИНН найдено несколько организаций. Выберите существующую.',
            });
          }
        }
        const row = await tx.counterparty.create({
          data: {
            displayName: dto.displayName,
            legalName: dto.legalName ?? null,
            inn,
            billingSource: 'manual_platform',
          },
        });
        await this.audit.record(
          {
            type: 'audit:commercial_counterparty_created',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: row.id,
            label: `Counterparty ${row.displayName} created`,
          },
          tx,
        );
        return row;
      });
      return projectCounterparty(created, actor.role);
    } catch (error) {
      if (inn === null || !isUniqueConstraintError(error)) throw error;
      const exactWinner = await this.prisma.counterparty.findFirst({
        where: { inn, billingSource: 'manual_platform' },
      });
      const winner =
        exactWinner ??
        (
          await this.prisma.$queryRaw<
            Array<{
              id: string;
              displayName: string;
              legalName: string | null;
              inn: string | null;
              kpp: string | null;
              sourceCode: string | null;
              billingSource: string;
              syncStatus: string;
              createdAt: Date;
              externalId: string | null;
              sourceVersion: string | null;
            }>
          >`SELECT *
            FROM "counterparties"
            WHERE "billingSource" = 'manual_platform'
              AND upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g')) = ${inn}
            ORDER BY "id" ASC
            LIMIT 1`
        )[0];
      if (!winner) throw error;
      return projectCounterparty(winner, actor.role);
    }
  }
}
