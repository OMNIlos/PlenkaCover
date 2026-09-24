import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  WarehouseAccountingMovementPage,
  WarehouseAccountingStockPage,
  WarehouseAccountingStockScope,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

const ACCOUNT_CODE = '41.01';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const CONSUMABLE_KINDS = [
  'Материалы',
  'Малоценное оборудование и запасы',
  'Инвентарь и хозяйственные принадлежности (применяется до 2022 года)',
] as const;

export type WarehouseAccountingStockQuery = {
  scope: WarehouseAccountingStockScope;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type WarehouseAccountingMovementQuery = {
  q?: string;
  cursor?: string;
  limit?: number;
};

type StockCursor = {
  name: string;
  externalId: string;
};

type MovementCursor = {
  date: string;
  externalId: string;
};

function encodeCursor(value: StockCursor | MovementCursor) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeStockCursor(value?: string): StockCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as StockCursor;
    if (
      typeof parsed.name !== 'string' ||
      parsed.name.length === 0 ||
      typeof parsed.externalId !== 'string' ||
      parsed.externalId.length === 0
    ) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new BadRequestException('Invalid warehouse accounting stock cursor');
  }
}

function decodeMovementCursor(value?: string): MovementCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as MovementCursor;
    const date = new Date(parsed.date);
    if (
      typeof parsed.date !== 'string' ||
      Number.isNaN(date.getTime()) ||
      typeof parsed.externalId !== 'string' ||
      parsed.externalId.length === 0
    ) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new BadRequestException('Invalid warehouse accounting movement cursor');
  }
}

function roundQuantity(value: number) {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function latestDate(values: Date[]) {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function isStale(importedAt: Date, now: Date) {
  const configured = Number(process.env.RAW_MATERIAL_STALE_AFTER_MS);
  const staleAfterMs =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_AFTER_MS;
  return now.getTime() - importedAt.getTime() > staleAfterMs;
}

@Injectable()
export class WarehouseAccountingService {
  constructor(private readonly prisma: PrismaService) {}

  async listStock(
    query: WarehouseAccountingStockQuery,
    now = new Date(),
  ): Promise<WarehouseAccountingStockPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = decodeStockCursor(query.cursor);
    const search = query.q?.trim();
    const where: Prisma.OneCNomenclatureItemWhereInput = {
      stockBalances: { some: { accountCode: ACCOUNT_CODE } },
      ...(query.scope === 'consumables'
        ? { kindName: { in: [...CONSUMABLE_KINDS] } }
        : { kindName: { notIn: [...CONSUMABLE_KINDS] } }),
      ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      ...(cursor
        ? {
            AND: [
              {
                OR: [
                  { name: { gt: cursor.name } },
                  { name: cursor.name, externalId: { gt: cursor.externalId } },
                ],
              },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.oneCNomenclatureItem.findMany({
      where,
      select: {
        externalId: true,
        name: true,
        kindName: true,
        unitName: true,
        stockBalances: {
          where: { accountCode: ACCOUNT_CODE },
          select: {
            quantity: true,
            capturedAt: true,
            syncedAt: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }, { externalId: 'asc' }],
      take: limit + 1,
    });
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row) => {
      const quantity = roundQuantity(
        row.stockBalances.reduce((total, balance) => total + Number(balance.quantity), 0),
      );
      const capturedAt = latestDate(row.stockBalances.map((balance) => balance.capturedAt));
      const importedAt = latestDate(row.stockBalances.map((balance) => balance.syncedAt));
      return {
        nomenclatureExternalId: row.externalId,
        name: row.name,
        kind: row.kindName,
        unit: row.unitName,
        quantity,
        balanceStatus: quantity > 0 ? 'positive' : quantity < 0 ? 'negative' : 'zero',
        capturedAt: capturedAt.toISOString(),
        importedAt: importedAt.toISOString(),
        stale: isStale(importedAt, now),
        physicalTraceability: 'unavailable',
      } as const;
    });
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ name: last.name, externalId: last.externalId })
          : null,
      accountCode: ACCOUNT_CODE,
      scope: query.scope,
      generatedAt: now.toISOString(),
    };
  }

  async listMovements(
    query: WarehouseAccountingMovementQuery,
    now = new Date(),
  ): Promise<WarehouseAccountingMovementPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = decodeMovementCursor(query.cursor);
    const search = query.q?.trim();
    const predicates: Prisma.OneCShipmentWhereInput[] = [];
    if (search) {
      predicates.push({
        OR: [
          { number: { contains: search, mode: 'insensitive' } },
          {
            lines: {
              some: {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  {
                    nomenclature: {
                      is: { name: { contains: search, mode: 'insensitive' } },
                    },
                  },
                ],
              },
            },
          },
        ],
      });
    }
    if (cursor) {
      const cursorDate = new Date(cursor.date);
      predicates.push({
        OR: [
          { date: { lt: cursorDate } },
          { date: cursorDate, externalId: { lt: cursor.externalId } },
        ],
      });
    }

    const rows = await this.prisma.oneCShipment.findMany({
      where: {
        posted: true,
        deleted: false,
        date: { not: null },
        ...(predicates.length > 0 ? { AND: predicates } : {}),
      },
      select: {
        externalId: true,
        number: true,
        date: true,
        capturedAt: true,
        syncedAt: true,
        lines: {
          select: {
            lineNumber: true,
            name: true,
            quantity: true,
            nomenclature: {
              select: {
                name: true,
                unitName: true,
              },
            },
          },
          orderBy: { lineNumber: 'asc' },
        },
      },
      orderBy: [{ date: 'desc' }, { externalId: 'desc' }],
      take: limit + 1,
    });
    const pageRows = rows.slice(0, limit);
    const items = pageRows.flatMap((row) =>
      row.date
        ? [
            {
              externalId: row.externalId,
              documentNumber: row.number,
              documentDate: row.date.toISOString(),
              direction: 'outbound' as const,
              sourceLabel: 'Отгрузка по 1С' as const,
              capturedAt: row.capturedAt.toISOString(),
              importedAt: row.syncedAt.toISOString(),
              physicalTraceability: 'unavailable' as const,
              lines: row.lines.map((line) => ({
                lineNumber: line.lineNumber,
                name: line.name ?? line.nomenclature?.name ?? `Строка ${line.lineNumber}`,
                quantity: roundQuantity(Number(line.quantity)),
                unit: line.nomenclature?.unitName ?? null,
              })),
            },
          ]
        : [],
    );
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last?.date
          ? encodeCursor({ date: last.date.toISOString(), externalId: last.externalId })
          : null,
      generatedAt: now.toISOString(),
    };
  }
}
