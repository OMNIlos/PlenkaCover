import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PayrollTariffMatrixV1, PayrollTariffOrderReference } from '@plenka/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { hashPayrollTariffMatrix } from './payroll-tariff-order.canonical';
import { corruptPayrollTariffOrder } from './payroll-tariff-order.errors';
import { parsePayrollTariffMatrix } from './payroll-tariff-matrix.parser';

export type PublishedPayrollTariffOrder = Readonly<{
  reference: Readonly<PayrollTariffOrderReference>;
  effectiveFromMs: number;
  revision: number;
  matrix: PayrollTariffMatrixV1;
  matrixHash: string;
}>;

export type PayrollTariffSchedule = readonly PublishedPayrollTariffOrder[];

const PUBLISHED_ORDER_SELECT = {
  id: true,
  name: true,
  effectiveFrom: true,
  currency: true,
  matrix: true,
  revision: true,
} as const;

type PublishedOrderRow = Prisma.PayrollTariffOrderGetPayload<{
  select: typeof PUBLISHED_ORDER_SELECT;
}>;

const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function moscowDate(value: Date): string {
  const parts = new Map(
    MOSCOW_DATE_FORMATTER.formatToParts(value).map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

function projectPublishedOrder(row: PublishedOrderRow): PublishedPayrollTariffOrder {
  const effectiveFromMs = row.effectiveFrom.getTime();
  if (row.currency !== 'RUB' || !Number.isFinite(effectiveFromMs)) {
    throw corruptPayrollTariffOrder();
  }

  let matrix: PayrollTariffMatrixV1;
  try {
    matrix = parsePayrollTariffMatrix(row.matrix);
  } catch {
    throw corruptPayrollTariffOrder();
  }

  return Object.freeze({
    reference: Object.freeze({
      id: row.id,
      name: row.name,
      effectiveFrom: moscowDate(row.effectiveFrom),
      currency: 'RUB' as const,
    }),
    effectiveFromMs,
    revision: row.revision,
    matrix,
    matrixHash: hashPayrollTariffMatrix(matrix),
  });
}

@Injectable()
export class PayrollTariffOrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async loadPublishedSchedule(
    maxBasisAt: Date,
    tx?: Prisma.TransactionClient | PrismaService,
  ): Promise<PayrollTariffSchedule> {
    const client = tx ?? this.prisma;
    const rows = await client.payrollTariffOrder.findMany({
      where: { status: 'published', effectiveFrom: { lte: maxBasisAt } },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
      select: PUBLISHED_ORDER_SELECT,
    });

    return Object.freeze(rows.map(projectPublishedOrder));
  }

  async loadPublishedOrdersByIds(
    ids: readonly string[],
    tx?: Prisma.TransactionClient | PrismaService,
  ): Promise<PayrollTariffSchedule> {
    const uniqueIds = [...new Set(ids)].sort();
    if (uniqueIds.length === 0) return Object.freeze([]);

    const client = tx ?? this.prisma;
    const rows = await client.payrollTariffOrder.findMany({
      where: { id: { in: uniqueIds }, status: 'published' },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
      select: PUBLISHED_ORDER_SELECT,
    });
    return Object.freeze(rows.map(projectPublishedOrder));
  }
}
