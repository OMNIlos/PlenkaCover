import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  BusinessPerformanceRollItem,
  BusinessPerformanceRollPage,
  CommercialPerformanceControl,
  CommercialPerformanceFinanceItem,
  CommercialPerformancePage,
  CommercialPerformanceProductionItem,
  CommercialPerformanceWarehouseItem,
  DirectorAnalyticsBigBagEvidencePage,
  DirectorAnalyticsBigBagEvidenceQuery,
  DirectorAnalyticsQuery,
  DirectorAnalyticsShiftEvidencePage,
  DirectorAnalyticsShiftEvidenceQuery,
  PaymentStatus,
  ProductionIndicator,
  ShipmentStatus,
  RollProductionCostView,
  WarehouseCoverStatus,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DirectorAnalyticsService } from '../director/director-analytics.service';
import { parseDirectorAnalyticsRange } from '../director/director-analytics.time';
import { RollProductionCostSnapshotService } from '../director/roll-production-cost-snapshot.service';

type PerformancePageQuery = {
  from: string;
  to: string;
  cursor?: string;
  limit?: number;
};

type PerformanceCursor = {
  updatedAt: string;
  id: string;
};

type ProductionRollCursor = {
  id: string;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_ROLL_PAGE_LIMIT = 20;
const MAX_ROLL_CURSOR_LENGTH = 500;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SNAPSHOT_NUMBER_PATTERN = /^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))(?:\s*(?:мкм|мм|м|кг))?$/iu;
const FINALIZED_OPERATOR_HANDOFF_STATUSES = new Set(['ready_for_warehouse', 'done']);
const WAREHOUSE_HANDED_OFF_STATES = new Set(['ready_for_handover', 'sent']);
const WAREHOUSE_ACCEPTED_STATES = new Set(['received']);
const WAREHOUSE_DELIVERED_STATES = new Set(['delivered']);

type ProductionLifecycleStatus =
  | 'in_production'
  | 'ready_for_warehouse'
  | 'warehouse_handed_off'
  | 'warehouse_accepted'
  | 'warehouse_delivered'
  | 'defect'
  | 'unknown';

type BusinessPerformanceRollProjection = BusinessPerformanceRollItem & {
  lifecycleStatus: ProductionLifecycleStatus;
  createdAt: string | null;
  completedAt: string | null;
  weights: {
    plannedNetKg: number | null;
    actualNetKg: number | null;
    actualGrossKg: number | null;
    deviationKg: number | null;
  };
};

const PRODUCTION_ROLL_SELECT = {
  id: true,
  rollCode: true,
  createdAt: true,
  completedAt: true,
  priority: true,
  status: true,
  plannedWeightKg: true,
  widthMm: true,
  plannedLengthM: true,
  characteristicsSnapshot: true,
  productionOrder: {
    select: {
      commercialOrder: { select: { orderNumber: true } },
    },
  },
  assignedOperator: { select: { displayName: true } },
  post: { select: { name: true, code: true } },
  operatorLine: {
    select: {
      planKg: true,
      spoolKg: true,
      grossKg: true,
      netKg: true,
      warehouseState: true,
    },
  },
} satisfies Prisma.RollDispatchItemSelect;

type ProductionRollRow = Prisma.RollDispatchItemGetPayload<{
  select: typeof PRODUCTION_ROLL_SELECT;
}>;

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function sum(values: Array<number | null | undefined>) {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function runtimeSource(status: 'ready' | 'partial' | 'unavailable', generatedAt: string) {
  return {
    kind: 'platform_runtime' as const,
    status,
    freshness: 'fresh' as const,
    generatedAt,
  };
}

function sourceStatus(rows: Array<{ sourceStatus?: string }>) {
  if (rows.length === 0 || rows.every((row) => row.sourceStatus === 'ready')) return 'ready';
  if (rows.every((row) => row.sourceStatus === 'error')) return 'unavailable';
  return 'partial';
}

export function classifyPaymentPlan(
  policy: { stages: Array<{ percentageBasisPoints: number }> } | null,
): Pick<CommercialPerformanceFinanceItem, 'paymentPlanKind' | 'paymentPlanLabel'> {
  if (policy === null) {
    return { paymentPlanKind: 'not_set', paymentPlanLabel: 'Не задано' };
  }
  if (policy.stages.length === 1 && policy.stages[0].percentageBasisPoints === 10_000) {
    return { paymentPlanKind: 'full', paymentPlanLabel: '100%' };
  }
  if (
    policy.stages.length === 2 &&
    policy.stages.every((stage) => stage.percentageBasisPoints === 5_000)
  ) {
    return { paymentPlanKind: 'half_split', paymentPlanLabel: '50/50' };
  }
  return { paymentPlanKind: 'custom', paymentPlanLabel: 'Индивидуально' };
}

function decodeCursor(value?: string): PerformanceCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<PerformanceCursor>;
    const timestamp = new Date(parsed.updatedAt ?? '');
    if (!parsed.id || !Number.isFinite(timestamp.getTime())) throw new Error('invalid cursor');
    return { id: parsed.id, updatedAt: timestamp.toISOString() };
  } catch {
    throw new BadRequestException('Invalid commercial performance cursor.');
  }
}

function encodeCursor(cursor: PerformanceCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeProductionRollCursor(value?: string): ProductionRollCursor | null {
  if (value === undefined) return null;
  try {
    if (
      value.length === 0 ||
      value.length > MAX_ROLL_CURSOR_LENGTH ||
      !BASE64URL_PATTERN.test(value)
    ) {
      throw new Error('invalid cursor encoding');
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('noncanonical cursor encoding');

    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('invalid cursor payload');
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 1 ||
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      candidate.id.length > 191 ||
      candidate.id.trim() !== candidate.id
    ) {
      throw new Error('invalid cursor identity');
    }
    return { id: candidate.id };
  } catch {
    throw new BadRequestException('Invalid commercial performance roll cursor.');
  }
}

function encodeProductionRollCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id } satisfies ProductionRollCursor), 'utf8').toString(
    'base64url',
  );
}

function productionRollPageLimit(limit?: number): number {
  const resolved = limit ?? DEFAULT_ROLL_PAGE_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_PAGE_LIMIT) {
    throw new BadRequestException('Invalid commercial performance roll page limit.');
  }
  return resolved;
}

function snapshotRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null;
}

function normalizedPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = SNAPSHOT_NUMBER_PATTERN.exec(value.trim());
  if (!match) return null;
  const normalized = Number(match[1].replace(',', '.'));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const normalized = normalizedPositiveNumber(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function rollName(filmType: string | null, actualThicknessUm: number | null): string {
  if (filmType === null) return 'Рулон';
  return actualThicknessUm === null ? filmType : `${filmType} ${actualThicknessUm} мкм`;
}

function lifecycleStatus(
  dispatchStatus: string,
  warehouseState: string | null | undefined,
): ProductionLifecycleStatus {
  if (warehouseState && WAREHOUSE_DELIVERED_STATES.has(warehouseState)) {
    return 'warehouse_delivered';
  }
  if (warehouseState && WAREHOUSE_ACCEPTED_STATES.has(warehouseState)) {
    return 'warehouse_accepted';
  }
  if (warehouseState && WAREHOUSE_HANDED_OFF_STATES.has(warehouseState)) {
    return 'warehouse_handed_off';
  }
  if (dispatchStatus === 'defect' || warehouseState === 'defect') return 'defect';
  if (FINALIZED_OPERATOR_HANDOFF_STATUSES.has(dispatchStatus)) return 'ready_for_warehouse';
  if (['new', 'assigned', 'in_progress', 'blocked', 'deferred'].includes(dispatchStatus)) {
    return 'in_production';
  }
  return 'unknown';
}

function orderLifecycleStatus(
  dispatchItems: Array<{ status: string; operatorLine: { warehouseState: string } | null }>,
): ProductionLifecycleStatus {
  if (dispatchItems.length === 0) return 'in_production';
  const statuses = dispatchItems.map((item) =>
    lifecycleStatus(item.status, item.operatorLine?.warehouseState),
  );
  if (statuses.every((status) => status === 'warehouse_delivered')) {
    return 'warehouse_delivered';
  }
  if (statuses.every((status) => ['warehouse_accepted', 'warehouse_delivered'].includes(status))) {
    return 'warehouse_accepted';
  }
  if (
    statuses.every((status) =>
      ['warehouse_handed_off', 'warehouse_accepted', 'warehouse_delivered'].includes(status),
    )
  ) {
    return 'warehouse_handed_off';
  }
  if (
    statuses.every((status) =>
      [
        'ready_for_warehouse',
        'warehouse_handed_off',
        'warehouse_accepted',
        'warehouse_delivered',
      ].includes(status),
    )
  ) {
    return 'ready_for_warehouse';
  }
  if (statuses.every((status) => status === 'defect')) return 'defect';
  return statuses.some((status) => status === 'unknown') ? 'unknown' : 'in_production';
}

function isoTimestamp(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function projectProductionRoll(
  row: ProductionRollRow,
  productionCost: RollProductionCostView,
): BusinessPerformanceRollProjection {
  const snapshot = snapshotRecord(row.characteristicsSnapshot);
  const filmType = normalizedText(snapshot.filmType);
  const actualThicknessUm = normalizedPositiveNumber(snapshot.actualThickness);
  const completedNetKg = FINALIZED_OPERATOR_HANDOFF_STATUSES.has(row.status)
    ? normalizedPositiveNumber(row.operatorLine?.netKg)
    : null;
  const plannedNetKg = firstPositiveNumber(
    row.operatorLine?.planKg,
    snapshot.weightKg,
    snapshot.plannedWeightKg,
    row.plannedWeightKg,
  );
  const actualNetKg = normalizedPositiveNumber(row.operatorLine?.netKg);
  const actualGrossKg = normalizedPositiveNumber(row.operatorLine?.grossKg);
  const projectedLifecycle = lifecycleStatus(row.status, row.operatorLine?.warehouseState);

  return {
    id: row.id,
    rollName: rollName(filmType, actualThicknessUm),
    rollCode: row.rollCode ?? null,
    orderNumber: row.productionOrder.commercialOrder.orderNumber,
    parameters: {
      filmType,
      actualThicknessUm,
      accountingThicknessUm: normalizedPositiveNumber(snapshot.accountingThickness),
      widthMm: firstPositiveNumber(snapshot.widthMm, row.widthMm),
      plannedLengthM: firstPositiveNumber(snapshot.plannedLengthM, row.plannedLengthM),
      weightKg:
        completedNetKg ??
        firstPositiveNumber(snapshot.weightKg, snapshot.plannedWeightKg, row.plannedWeightKg),
    },
    operatorName: normalizedText(row.assignedOperator?.displayName),
    machineName: normalizedText(row.post?.name) ?? normalizedText(row.post?.code),
    priority: Number.isInteger(row.priority) && row.priority >= 0 ? row.priority : null,
    status: projectedLifecycle,
    lifecycleStatus: projectedLifecycle,
    createdAt: isoTimestamp(row.createdAt),
    completedAt:
      projectedLifecycle === 'in_production' || projectedLifecycle === 'unknown'
        ? null
        : isoTimestamp(row.completedAt),
    weights: {
      plannedNetKg,
      actualNetKg,
      actualGrossKg,
      deviationKg:
        plannedNetKg === null || actualNetKg === null ? null : round(actualNetKg - plannedNetKg, 3),
    },
    productionCost,
  };
}

function pageWindow(query: PerformancePageQuery) {
  const range = parseDirectorAnalyticsRange({ ...query, bucket: 'day' });
  const cursor = decodeCursor(query.cursor);
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  return { range, cursor, limit };
}

function cursorWhere(cursor: PerformanceCursor | null) {
  if (!cursor) return {};
  const updatedAt = new Date(cursor.updatedAt);
  return {
    OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: cursor.id } }],
  };
}

function pageResult<T extends { id: string; updatedAt: Date }>(rows: T[], limit: number) {
  const hasNextPage = rows.length > limit;
  const selected = hasNextPage ? rows.slice(0, limit) : rows;
  const last = selected.at(-1);
  return {
    rows: selected,
    nextCursor:
      hasNextPage && last
        ? encodeCursor({ id: last.id, updatedAt: last.updatedAt.toISOString() })
        : null,
  };
}

@Injectable()
export class CommercialPerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: DirectorAnalyticsService,
    private readonly snapshots: RollProductionCostSnapshotService,
  ) {}

  async getControl(query: DirectorAnalyticsQuery): Promise<CommercialPerformanceControl> {
    const range = parseDirectorAnalyticsRange(query);
    const [analytics, financeOrders, warehouseAcceptedRolls] = await Promise.all([
      this.analytics.getAnalytics(query),
      this.prisma.financeOrder.findMany({
        where: { updatedAt: { gte: range.fromUtc, lt: range.toExclusiveUtc } },
        select: {
          invoiceStatus: true,
          paymentStatus: true,
          amountValue: true,
          sourceStatus: true,
          schedules: { select: { amount: true, status: true } },
        },
      }),
      this.prisma.warehouseRoll.count({
        where: { receivedAt: { gte: range.fromUtc, lt: range.toExclusiveUtc } },
      }),
    ]);

    const invoicedAmount = sum(
      financeOrders.map((order) =>
        order.invoiceStatus === 'invoiced' && order.amountValue !== null
          ? Number(order.amountValue)
          : 0,
      ),
    );
    const paidAmount = sum(
      financeOrders.flatMap((order) =>
        order.schedules
          .filter((schedule) => schedule.status === 'paid')
          .map((schedule) => Number(schedule.amount)),
      ),
    );
    const overdueAmount = sum(
      financeOrders.flatMap((order) =>
        order.schedules
          .filter((schedule) => schedule.status === 'overdue')
          .map((schedule) => Number(schedule.amount)),
      ),
    );
    const producedKg = sum(analytics.productionSeries.map((point) => point.producedKg));
    const producedRolls = sum(analytics.productionSeries.map((point) => point.rollCount));
    const defectKg = sum(analytics.productionQualitySeries.map((point) => point.verifiedDefectKg));
    const defectRollCount = sum(
      analytics.productionQualitySeries.map((point) => point.defectiveRollCount),
    );
    const returnedSpoolCount = sum(
      analytics.productionQualitySeries.map((point) => point.returnedSpoolCount),
    );
    const generatedAt = analytics.range.generatedAt;

    return {
      range: analytics.range,
      source: runtimeSource(sourceStatus(financeOrders), generatedAt),
      summary: {
        invoicedAmount: round(invoicedAmount),
        paidAmount: round(paidAmount),
        receivableAmount: round(Math.max(0, invoicedAmount - paidAmount)),
        overdueAmount: round(overdueAmount),
        producedKg: round(producedKg, 3),
        producedRolls,
        defectKg: round(defectKg, 3),
        defectRollCount,
        returnedSpoolCount,
        warehouseAcceptedRolls,
      },
      productionSeries: analytics.productionSeries,
      productionQualitySeries: analytics.productionQualitySeries,
      accountingProduction: analytics.accountingProduction,
      commercialApplications: analytics.commercialApplications,
    };
  }

  getControlShiftBalanceEvidence(
    query: DirectorAnalyticsShiftEvidenceQuery,
  ): Promise<DirectorAnalyticsShiftEvidencePage> {
    return this.analytics.getShiftBalanceEvidence(query);
  }

  getControlBigBagEvidence(
    query: DirectorAnalyticsBigBagEvidenceQuery,
  ): Promise<DirectorAnalyticsBigBagEvidencePage> {
    return this.analytics.getBigBagEvidence(query);
  }

  async listFinance(
    query: PerformancePageQuery,
  ): Promise<CommercialPerformancePage<CommercialPerformanceFinanceItem>> {
    const { range, cursor, limit } = pageWindow(query);
    const rows = await this.prisma.financeOrder.findMany({
      where: {
        updatedAt: { gte: range.fromUtc, lt: range.toExclusiveUtc },
        ...cursorWhere(cursor),
      },
      select: {
        id: true,
        invoiceStatus: true,
        paymentStatus: true,
        amountValue: true,
        sourceStatus: true,
        updatedAt: true,
        commercialOrder: {
          select: {
            orderNumber: true,
            counterparty: { select: { displayName: true } },
          },
        },
        schedules: {
          select: { amount: true, status: true, dueDate: true },
          orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        },
        policy: {
          select: {
            stages: {
              select: { percentageBasisPoints: true },
              orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
            },
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = pageResult(rows, limit);
    const generatedAt = new Date().toISOString();

    return {
      items: page.rows.map((order) => {
        const paidAmount = sum(
          order.schedules
            .filter((schedule) => schedule.status === 'paid')
            .map((schedule) => Number(schedule.amount)),
        );
        const nextDueAt =
          order.schedules.find(
            (schedule) => schedule.status !== 'paid' && schedule.dueDate !== null,
          )?.dueDate ?? null;
        return {
          id: order.id,
          orderNumber: order.commercialOrder.orderNumber,
          counterpartyName: order.commercialOrder.counterparty?.displayName ?? null,
          invoiceStatus: order.invoiceStatus,
          paymentStatus: order.paymentStatus as PaymentStatus,
          ...classifyPaymentPlan(order.policy),
          invoicedAmount: order.amountValue === null ? null : Number(order.amountValue),
          paidAmount: round(paidAmount),
          remainingAmount:
            order.amountValue === null
              ? null
              : round(Math.max(0, Number(order.amountValue) - paidAmount)),
          nextConfirmedDueAt: nextDueAt?.toISOString() ?? null,
          updatedAt: order.updatedAt.toISOString(),
        };
      }),
      nextCursor: page.nextCursor,
      source: runtimeSource(sourceStatus(page.rows), generatedAt),
    };
  }

  async listProduction(
    query: PerformancePageQuery,
  ): Promise<CommercialPerformancePage<CommercialPerformanceProductionItem>> {
    const { range, cursor, limit } = pageWindow(query);
    const rows = await this.prisma.productionOrder.findMany({
      where: {
        updatedAt: { gte: range.fromUtc, lt: range.toExclusiveUtc },
        ...cursorWhere(cursor),
      },
      select: {
        id: true,
        indicator: true,
        createdAt: true,
        updatedAt: true,
        commercialOrder: {
          select: {
            orderNumber: true,
            counterparty: { select: { displayName: true } },
          },
        },
        dispatchItems: {
          select: {
            status: true,
            completedAt: true,
            plannedWeightKg: true,
            operatorLine: {
              select: {
                grossKg: true,
                netKg: true,
                warehouseState: true,
                defects: {
                  select: {
                    weightKg: true,
                    spoolStockMovement: { select: { quantity: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = pageResult(rows, limit);
    const generatedAt = new Date().toISOString();

    return {
      items: page.rows.map((order) => {
        const projectedLifecycle = orderLifecycleStatus(order.dispatchItems);
        const plannedWeights = order.dispatchItems
          .map((item) => item.plannedWeightKg)
          .filter((value): value is number => value !== null);
        const actualWeights = order.dispatchItems
          .map((item) => item.operatorLine?.netKg ?? null)
          .filter((value): value is number => value !== null);
        return {
          id: order.id,
          orderNumber: order.commercialOrder.orderNumber,
          counterpartyName: order.commercialOrder.counterparty?.displayName ?? null,
          productionStatus: order.indicator as ProductionIndicator,
          lifecycleStatus: projectedLifecycle,
          createdAt: order.createdAt.toISOString(),
          completedAt:
            ['in_production', 'unknown'].includes(projectedLifecycle) ||
            order.dispatchItems.some((item) => item.completedAt === null)
              ? null
              : isoTimestamp(
                  order.dispatchItems.reduce<Date | null>(
                    (latest, item) =>
                      latest === null || (item.completedAt?.getTime() ?? 0) > latest.getTime()
                        ? item.completedAt
                        : latest,
                    null,
                  ),
                ),
          plannedRollCount: order.dispatchItems.length,
          completedRollCount: order.dispatchItems.filter(
            (item) =>
              !['in_production', 'unknown'].includes(
                lifecycleStatus(item.status, item.operatorLine?.warehouseState),
              ),
          ).length,
          plannedKg: plannedWeights.length === 0 ? null : round(sum(plannedWeights), 3),
          actualKg: actualWeights.length === 0 ? null : round(sum(actualWeights), 3),
          defectKg: round(
            sum(
              order.dispatchItems.flatMap(
                (item) => item.operatorLine?.defects.map((defect) => defect.weightKg) ?? [],
              ),
            ),
            3,
          ),
          defectRollCount: order.dispatchItems.filter(
            (item) => (item.operatorLine?.defects.length ?? 0) > 0,
          ).length,
          returnedSpoolCount: sum(
            order.dispatchItems.flatMap(
              (item) =>
                item.operatorLine?.defects.map(
                  (defect) => defect.spoolStockMovement?.quantity ?? 0,
                ) ?? [],
            ),
          ),
          updatedAt: order.updatedAt.toISOString(),
        };
      }),
      nextCursor: page.nextCursor,
      source: runtimeSource('ready', generatedAt),
    };
  }

  async listProductionRolls(
    productionOrderId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<BusinessPerformanceRollPage> {
    const cursor = decodeProductionRollCursor(query.cursor);
    const limit = productionRollPageLimit(query.limit);
    const rows = await this.prisma.rollDispatchItem.findMany({
      where: {
        productionOrderId,
        ...(cursor ? { id: { gt: cursor.id } } : {}),
      },
      select: PRODUCTION_ROLL_SELECT,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const selected = hasNextPage ? rows.slice(0, limit) : rows;
    const last = selected.at(-1);
    const costs = await this.snapshots.getViewsForRollIds(selected.map((row) => row.id));

    return {
      items: selected.map((row) => {
        const productionCost = costs.get(row.id);
        if (!productionCost) {
          throw new RangeError(`Missing production cost projection for roll ${row.id}.`);
        }
        return projectProductionRoll(row, productionCost);
      }),
      nextCursor: hasNextPage && last ? encodeProductionRollCursor(last.id) : null,
    };
  }

  async listWarehouse(
    query: PerformancePageQuery,
  ): Promise<CommercialPerformancePage<CommercialPerformanceWarehouseItem>> {
    const { range, cursor, limit } = pageWindow(query);
    const rows = await this.prisma.commercialOrder.findMany({
      where: {
        updatedAt: { gte: range.fromUtc, lt: range.toExclusiveUtc },
        ...cursorWhere(cursor),
      },
      select: {
        id: true,
        orderNumber: true,
        warehouseCoverStatus: true,
        shipmentStatus: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = pageResult(rows, limit);
    const orderIds = page.rows.map((order) => order.id);
    const rolls =
      orderIds.length === 0
        ? []
        : await this.prisma.warehouseRoll.findMany({
            where: {
              OR: [
                { producedForOrderId: { in: orderIds } },
                { reservedForOrderId: { in: orderIds } },
              ],
            },
            select: {
              producedForOrderId: true,
              reservedForOrderId: true,
              warehouseStatus: true,
            },
          });
    const generatedAt = new Date().toISOString();

    return {
      items: page.rows.map((order) => {
        const produced = rolls.filter((roll) => roll.producedForOrderId === order.id);
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          warehouseCoverageStatus: order.warehouseCoverStatus as WarehouseCoverStatus,
          shipmentStatus: order.shipmentStatus as ShipmentStatus,
          readyRollCount: produced.filter((roll) => roll.warehouseStatus === 'ready_for_handover')
            .length,
          reservedRollCount: rolls.filter((roll) => roll.reservedForOrderId === order.id).length,
          acceptedRollCount: produced.filter((roll) =>
            ['received', 'delivered'].includes(roll.warehouseStatus),
          ).length,
          shippedRollCount: produced.filter((roll) => roll.warehouseStatus === 'delivered').length,
          updatedAt: order.updatedAt.toISOString(),
        };
      }),
      nextCursor: page.nextCursor,
      source: runtimeSource('ready', generatedAt),
    };
  }
}
