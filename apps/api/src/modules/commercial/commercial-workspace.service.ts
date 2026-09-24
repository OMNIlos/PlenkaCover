import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  COMMERCIAL_STAGES,
  PAYMENT_STATUSES,
  PRODUCTION_INDICATORS,
  REQUEST_TYPES,
  SHIPMENT_STATUSES,
  WAREHOUSE_COVER_STATUSES,
  type Capability,
  type CommercialBucket,
  type CommercialCompletion,
  type CommercialNextAction,
  type CommercialOrderIndicators,
  type CommercialOrderPage,
  type CommercialOrderQuery,
  type CommercialProductionProblem,
  type CommercialWaitableActionCode,
  type CommercialWarehouseCoverageProjection,
  type CommercialWorkspaceOrderDetail,
  type CommercialWorkspaceOrderSummary,
  type CommercialWorkspacePosition,
  type PaymentStatus,
  type ProductionIndicator,
  type ShipmentStatus,
  type WarehouseCoverStatus,
  type WarehouseCoverCriteria,
  type WarehouseCoverRoute,
  type WarehouseCoverageProjection,
  type WarehouseCoverageAvailability,
  type WarehouseCoverageDecisionKind,
  type WarehouseCoverageState,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { calculateOrderFulfillment } from '../../common/order-fulfillment/order-fulfillment.calculator';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import type {
  FulfillmentOrder,
  FulfillmentPositionResult,
} from '../../common/order-fulfillment/order-fulfillment.types';
import { invoiceLocksCommercialParameters } from '../../common/invoice-boundary/commercial-invoice-boundary';
import { PrismaService } from '../../common/prisma/prisma.service';
import { financeAllowsProduction, financeProductionGate } from '../finance/payment-production-gate';
import { WarehouseCoverageProjectionService } from '../warehouse-coverage/warehouse-coverage-projection.service';
import { hasConsumedMaterialFacts } from './commercial-correction-policy';
import { projectCounterparty, projectStockProductionTemplate } from './projection';

const WORKSPACE_ORDER_INCLUDE = {
  counterparty: true,
  stockProductionTemplateVersion: { select: { version: true } },
  positions: {
    orderBy: { id: 'asc' },
    select: {
      id: true,
      orderId: true,
      rollCount: true,
      filmType: true,
      actualThickness: true,
      accountingThickness: true,
      rawMaterialId: true,
      baseRawMaterialDefinitionId: true,
      recipeDefinitionVersionId: true,
      spoolType: true,
      birka: true,
      manualBirka: true,
      comment: true,
      plannedWeightKg: true,
      widthMm: true,
      plannedLengthM: true,
      version: true,
      warehouseCoverStatus: true,
      updatedAt: true,
      recipe: {
        select: {
          id: true,
          version: true,
          parameters: true,
          recipeDefinitionId: true,
          recipeDefinitionVersionId: true,
          recipeVersionNumber: true,
          recipeName: true,
          ingredients: true,
        },
      },
      coverProposals: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          createdAt: true,
          route: true,
          coverQty: true,
          reserveQty: true,
          productionQty: true,
          status: true,
          version: true,
          sourceCapturedAt: true,
          expiresAt: true,
          commercialApprovedAt: true,
          technicalApprovedAt: true,
          matches: {
            orderBy: { rollId: 'asc' },
            select: {
              compatible: true,
              criteria: true,
              roll: { select: { id: true, rollCode: true } },
            },
          },
          reservedRolls: {
            select: {
              id: true,
              rollCode: true,
              reservedForOrderId: true,
              reservedForPositionId: true,
              reservedByProposalId: true,
            },
          },
        },
      },
    },
  },
  problems: {
    select: {
      id: true,
      positionId: true,
      rollId: true,
      actorRole: true,
      reason: true,
      recovery: true,
      status: true,
      type: true,
      createdAt: true,
    },
  },
  resolutionCases: {
    select: { id: true, status: true, ownerRole: true, affectedPositionIds: true },
  },
  coverageState: {
    select: {
      state: true,
      stateVersion: true,
      generation: true,
      currentCalculationId: true,
      currentDecisionId: true,
      currentCalculation: {
        select: {
          id: true,
          orderId: true,
          generation: true,
          inputFingerprint: true,
          availability: true,
          requiredRollCount: true,
          matchedRollCount: true,
          matches: {
            select: {
              orderId: true,
              generation: true,
              positionId: true,
              rollId: true,
              coverageFactId: true,
              slotIndex: true,
              roll: {
                select: {
                  id: true,
                  rollCode: true,
                  warehouseStatus: true,
                  currentCoverageFactId: true,
                  reservedForOrderId: true,
                  reservedForPositionId: true,
                  reservedByProposalId: true,
                  reservedByCoverageDecisionId: true,
                  reservedAt: true,
                },
              },
            },
          },
        },
      },
      currentDecision: {
        select: {
          id: true,
          orderId: true,
          calculationId: true,
          generation: true,
          kind: true,
          inputFingerprint: true,
          expectedRollCount: true,
        },
      },
    },
  },
  productionOrder: {
    select: {
      id: true,
      commercialOrderId: true,
      sourceCoverageCalculationId: true,
      sourceCoverageDecisionId: true,
      sourceCoverageInputFingerprint: true,
      sourceCoverageGeneration: true,
      dispatchItems: {
        select: {
          id: true,
          rollCode: true,
          orderLineId: true,
          positionSequence: true,
          status: true,
          completedAt: true,
          characteristicsSnapshot: true,
          operatorLine: {
            select: {
              warehouseState: true,
              spoolKg: true,
              grossKg: true,
              netKg: true,
              weightCaptures: {
                select: { kind: true, grossKg: true, netKg: true },
              },
            },
          },
        },
      },
    },
  },
  financeOrder: {
    select: {
      id: true,
      productionClearedAt: true,
      invoiceStatus: true,
      invoiceIssuedAt: true,
      invoiceSyncState: true,
      paymentStatus: true,
      paymentTermsType: true,
      policy: {
        select: {
          id: true,
          stages: { select: { id: true, trigger: true } },
        },
      },
      schedules: {
        select: { paymentPolicyStageId: true, kind: true, status: true },
      },
    },
  },
} satisfies Prisma.CommercialOrderInclude;

const WORKSPACE_TASK_SELECT = {
  id: true,
  orderId: true,
  positionId: true,
  proposalId: true,
  coverageDecisionId: true,
  mode: true,
  status: true,
  rows: { select: { rollCode: true, fromOrderId: true, scanStatus: true } },
} satisfies Prisma.WarehouseAcceptanceTaskSelect;

type WorkspaceOrder = Prisma.CommercialOrderGetPayload<{
  include: typeof WORKSPACE_ORDER_INCLUDE;
}>;
type WorkspaceTask = Prisma.WarehouseAcceptanceTaskGetPayload<{
  select: typeof WORKSPACE_TASK_SELECT;
}>;

function fulfillmentOrderFromWorkspace(order: WorkspaceOrder): FulfillmentOrder {
  if (order.warehouseCoverageWorkflowVersion === 1) {
    return {
      warehouseCoverageWorkflowVersion: 1,
      id: order.id,
      orderNumber: order.orderNumber,
      positions: order.positions.map((position) => ({
        id: position.id,
        rollCount: position.rollCount,
        warehouseCoverStatus: position.warehouseCoverStatus,
        coverProposals: position.coverProposals.map((proposal) => ({
          id: proposal.id,
          status: proposal.status,
          coverQty: proposal.coverQty,
          reserveQty: proposal.reserveQty,
          commercialApprovedAt: proposal.commercialApprovedAt,
          technicalApprovedAt: proposal.technicalApprovedAt,
          reservedRolls: proposal.reservedRolls,
        })),
      })),
      problems: order.problems.map((problem) => ({
        positionId: problem.positionId,
        status: problem.status,
      })),
      resolutionCases: order.resolutionCases.map((resolution) => ({
        status: resolution.status,
      })),
      productionOrder: order.productionOrder
        ? {
            dispatchItems: order.productionOrder.dispatchItems.map((item) => ({
              rollCode: item.rollCode,
              orderLineId: item.orderLineId,
              status: item.status,
              operatorLine: item.operatorLine
                ? { warehouseState: item.operatorLine.warehouseState }
                : null,
            })),
          }
        : null,
    };
  }

  return {
    warehouseCoverageWorkflowVersion: 2,
    id: order.id,
    orderNumber: order.orderNumber,
    positions: order.positions.map((position) => ({
      id: position.id,
      rollCount: position.rollCount,
    })),
    coverageState: order.coverageState
      ? {
          state: order.coverageState.state as WarehouseCoverageState,
          stateVersion: order.coverageState.stateVersion,
          generation: order.coverageState.generation,
          currentCalculationId: order.coverageState.currentCalculationId,
          currentDecisionId: order.coverageState.currentDecisionId,
          currentCalculation: order.coverageState.currentCalculation
            ? {
                ...order.coverageState.currentCalculation,
                availability: order.coverageState.currentCalculation
                  .availability as WarehouseCoverageAvailability,
              }
            : null,
          currentDecision: order.coverageState.currentDecision
            ? {
                ...order.coverageState.currentDecision,
                kind: order.coverageState.currentDecision.kind as WarehouseCoverageDecisionKind,
              }
            : null,
        }
      : null,
    productionOrder: order.productionOrder
      ? {
          commercialOrderId: order.productionOrder.commercialOrderId,
          sourceCoverageCalculationId: order.productionOrder.sourceCoverageCalculationId,
          sourceCoverageDecisionId: order.productionOrder.sourceCoverageDecisionId,
          sourceCoverageInputFingerprint: order.productionOrder.sourceCoverageInputFingerprint,
          sourceCoverageGeneration: order.productionOrder.sourceCoverageGeneration,
          dispatchItems: order.productionOrder.dispatchItems.map((item) => ({
            rollCode: item.rollCode,
            orderLineId: item.orderLineId,
            status: item.status,
            operatorLine: item.operatorLine
              ? { warehouseState: item.operatorLine.warehouseState }
              : null,
          })),
        }
      : null,
    problems: order.problems.map((problem) => ({
      positionId: problem.positionId,
      status: problem.status,
    })),
    resolutionCases: order.resolutionCases.map((resolution) => ({
      status: resolution.status,
    })),
  };
}

type WorkspaceCursor = {
  actionPriority: number;
  updatedAt: string;
  id: string;
};

function currentCoverProposal<T extends { id: string; createdAt: Date }>(
  proposals: readonly T[],
): T | undefined {
  return proposals.reduce<T | undefined>((latest, proposal) => {
    if (!latest) return proposal;
    const createdAtDelta = proposal.createdAt.getTime() - latest.createdAt.getTime();
    return createdAtDelta > 0 || (createdAtDelta === 0 && proposal.id > latest.id)
      ? proposal
      : latest;
  }, undefined);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PRODUCTION_ROUTE_STATUSES = new Set(['needs_production', 'rejected']);
const SCAN_BATCH_SIZE = 200;

function parseDateBoundary(value: string, endOfDay: boolean): Date {
  if (!DATE_ONLY.test(value)) throw new BadRequestException('Dates must use YYYY-MM-DD');
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const date = new Date(`${value}${suffix}`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`Invalid calendar date: ${value}`);
  }
  return date;
}

function encodeCursor(item: CommercialWorkspaceOrderSummary): string {
  return Buffer.from(
    JSON.stringify({
      actionPriority: item.actionPriority,
      updatedAt: item.updatedAt,
      id: item.id,
    } satisfies WorkspaceCursor),
  ).toString('base64url');
}

function decodeCursor(value?: string): WorkspaceCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as WorkspaceCursor;
    if (
      !Number.isInteger(cursor.actionPriority) ||
      !cursor.id ||
      Number.isNaN(Date.parse(cursor.updatedAt))
    ) {
      throw new Error('invalid cursor');
    }
    return cursor;
  } catch {
    throw new BadRequestException('Invalid commercial workspace cursor');
  }
}

function enumValue<const T extends readonly string[]>(
  value: string,
  allowed: T,
  field: string,
): T[number] {
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new InternalServerErrorException(`Invalid persisted ${field}`);
}

function compareSummary(
  left: Pick<CommercialWorkspaceOrderSummary, 'actionPriority' | 'updatedAt' | 'id'>,
  right: Pick<CommercialWorkspaceOrderSummary, 'actionPriority' | 'updatedAt' | 'id'>,
  prioritizeActions = true,
) {
  if (prioritizeActions && left.actionPriority !== right.actionPriority) {
    return left.actionPriority - right.actionPriority;
  }
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function safeBaseCoverage(coverage: WarehouseCoverageProjection): WarehouseCoverageProjection {
  return {
    workflowVersion: coverage.workflowVersion,
    state: coverage.state,
    stateVersion: coverage.stateVersion,
    generation: coverage.generation,
    availability: coverage.availability,
    reasonCodes: [...coverage.reasonCodes],
    nextOwner: coverage.nextOwner,
    availableActions: [...coverage.availableActions],
    requiredRollCount: coverage.requiredRollCount,
    matchedRollCount: coverage.matchedRollCount,
    uncertainRollCount: coverage.uncertainRollCount,
    calculatedAt: coverage.calculatedAt,
    stale: coverage.stale,
  };
}

function safeCommercialCoverage(
  coverage: CommercialWarehouseCoverageProjection,
): CommercialWarehouseCoverageProjection {
  return {
    ...safeBaseCoverage(coverage),
    typeCoverage: coverage.typeCoverage.map((item) => ({
      positionId: item.positionId,
      label: item.label,
      requiredRollCount: item.requiredRollCount,
      matchedRollCount: item.matchedRollCount,
      uncertainRollCount: item.uncertainRollCount,
      requested: {
        filmType: item.requested.filmType,
        actualThicknessMicron: item.requested.actualThicknessMicron,
        accountingThicknessMicron: item.requested.accountingThicknessMicron,
        widthMm: item.requested.widthMm,
        plannedLengthM: item.requested.plannedLengthM,
        weightKg: item.requested.weightKg,
        spoolType: item.requested.spoolType,
        birka: item.requested.birka,
        recipeName: item.requested.recipeName,
        ingredients: item.requested.ingredients.map((ingredient) => ({
          name: ingredient.name,
          shareBasisPoints: ingredient.shareBasisPoints,
        })),
      },
      matched: {
        filmType: item.matched.filmType,
        actualThicknessMicron: item.matched.actualThicknessMicron,
        accountingThicknessMicron: item.matched.accountingThicknessMicron,
        widthMm: item.matched.widthMm,
        plannedLengthM: item.matched.plannedLengthM,
        weightKg: item.matched.weightKg
          ? {
              min: item.matched.weightKg.min,
              max: item.matched.weightKg.max,
              total: item.matched.weightKg.total,
            }
          : null,
        spoolType: item.matched.spoolType,
        birka: item.matched.birka,
        recipeName: item.matched.recipeName,
        ingredients: item.matched.ingredients.map((ingredient) => ({
          name: ingredient.name,
          shareBasisPoints: ingredient.shareBasisPoints,
        })),
      },
      comparison: {
        filmType: item.comparison.filmType,
        actualThickness: item.comparison.actualThickness,
        accountingThickness: item.comparison.accountingThickness,
        width: item.comparison.width,
        plannedLength: item.comparison.plannedLength,
        weightTolerance: item.comparison.weightTolerance,
        spoolType: item.comparison.spoolType,
        birka: item.comparison.birka,
        ingredients: item.comparison.ingredients,
      },
    })),
  };
}

@Injectable()
export class CommercialWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillmentHandoff: OrderFulfillmentHandoffService,
    private readonly coverageProjection: WarehouseCoverageProjectionService,
  ) {}

  async list(
    actor: Actor,
    query: CommercialOrderQuery,
  ): Promise<CommercialOrderPage<CommercialWorkspaceOrderSummary>> {
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const from = query.from ? parseDateBoundary(query.from, false) : null;
    const to = query.to ? parseDateBoundary(query.to, true) : null;
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('Date range must satisfy from <= to');
    }
    const clientCursor = decodeCursor(query.cursor);
    const prioritizeActions = !(
      actor.role === 'commercial' &&
      query.bucket === 'in_work' &&
      query.mode === 'current'
    );
    const compare = (left: WorkspaceCursor, right: WorkspaceCursor) =>
      compareSummary(left, right, prioritizeActions);
    const where = this.listWhere(actor, query.bucket, from, to);
    const projected: CommercialWorkspaceOrderSummary[] = [];
    let scanAfter: { updatedAt: Date; id: string } | null = null;

    for (;;) {
      const batch = await this.orderBatch(where, scanAfter);
      const visibleOrders = batch.filter(
        (order) => actor.role === 'commercial' || order.commercialStage !== 'draft',
      );
      const tasks = await this.tasksForOrders(visibleOrders);
      const tasksByOrder = this.groupTasks(tasks, visibleOrders);
      const coverageByOrderId = await this.coverageForOrders(visibleOrders, actor);
      for (const order of visibleOrders) {
        const item = this.projectSummary(
          order,
          tasksByOrder.get(order.id) ?? [],
          actor,
          coverageByOrderId.get(order.id) ?? null,
        );
        if (item.bucket !== query.bucket) continue;
        if (query.mode === 'action_required' && !item.nextAction.allowed) continue;
        if (clientCursor && compare(item, clientCursor) <= 0) continue;
        projected.push(item);
      }
      projected.sort(compare);
      if (projected.length > limit + 1) projected.length = limit + 1;
      if (batch.length < SCAN_BATCH_SIZE) break;
      if (
        projected.length >= limit + 1 &&
        (!prioritizeActions || projected.every((item) => item.actionPriority === 0))
      ) {
        break;
      }
      const last = batch[batch.length - 1]!;
      scanAfter = { updatedAt: last.updatedAt, id: last.id };
    }

    const page = projected.slice(0, limit + 1);
    const hasNext = page.length > limit;
    const items = page.slice(0, limit);

    await Promise.all(
      items
        .filter((item) => item.commercialCompletion.state !== 'incomplete')
        .map((item) => this.fulfillmentHandoff.reconcile(actor, item.id)),
    );

    return {
      items,
      nextCursor: hasNext && items.length ? encodeCursor(items[items.length - 1]!) : null,
    };
  }

  async detail(actor: Actor, orderId: string): Promise<CommercialWorkspaceOrderDetail> {
    const order = await this.prisma.commercialOrder.findFirst({
      where: { id: orderId },
      include: WORKSPACE_ORDER_INCLUDE,
    });
    if (!order || (order.commercialStage === 'draft' && actor.role !== 'commercial')) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    const tasks = await this.tasksForOrders([order]);
    const coverage =
      order.warehouseCoverageWorkflowVersion === 2
        ? safeCommercialCoverage(await this.coverageProjection.readForCommercial(order.id, actor))
        : null;
    const detail = this.projectDetail(order, tasks, actor, coverage);
    if (detail.commercialCompletion.state !== 'incomplete') {
      await this.fulfillmentHandoff.reconcile(actor, order.id);
    }
    return detail;
  }

  private listWhere(
    actor: Actor,
    bucket: CommercialBucket,
    from: Date | null,
    to: Date | null,
  ): Prisma.CommercialOrderWhereInput {
    const bucketWhere: Prisma.CommercialOrderWhereInput =
      bucket === 'drafts'
        ? { commercialStage: 'draft' }
        : bucket === 'incoming'
          ? {
              commercialStage: { in: ['incoming', 'sent_to_finance', 'in_work'] },
              productionOrder: { is: null },
              requestType: { not: 'stock_reserve' },
            }
          : bucket === 'in_work'
            ? {
                OR: [
                  { productionOrder: { isNot: null } },
                  { commercialStage: 'in_work', requestType: 'stock_reserve' },
                ],
              }
            : {
                OR: [
                  { shipmentStatus: 'shipped' },
                  { warehouseCoverStatus: { in: ['partial_confirmed', 'full_confirmed'] } },
                  { productionIndicator: 'ready' },
                ],
              };
    const accessWhere: Prisma.CommercialOrderWhereInput =
      actor.role === 'commercial' ? {} : { commercialStage: { not: 'draft' } };
    return {
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
      AND: [bucketWhere, accessWhere],
    };
  }

  private async coverageForOrders(orders: WorkspaceOrder[], actor: Actor) {
    const v2Orders = orders.filter((order) => order.warehouseCoverageWorkflowVersion === 2);
    const projections = await Promise.all(
      v2Orders.map(async (order) => ({
        orderId: order.id,
        coverage: safeBaseCoverage(await this.coverageProjection.read(order.id, actor)),
      })),
    );
    return new Map(projections.map(({ orderId, coverage }) => [orderId, coverage]));
  }

  private orderBatch(
    where: Prisma.CommercialOrderWhereInput,
    scanAfter: { updatedAt: Date; id: string } | null,
  ): Promise<WorkspaceOrder[]> {
    const scanWhere: Prisma.CommercialOrderWhereInput = scanAfter
      ? {
          AND: [
            where,
            {
              OR: [
                { updatedAt: { lt: scanAfter.updatedAt } },
                { updatedAt: scanAfter.updatedAt, id: { lt: scanAfter.id } },
              ],
            },
          ],
        }
      : where;
    return this.prisma.commercialOrder.findMany({
      where: scanWhere,
      include: WORKSPACE_ORDER_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: SCAN_BATCH_SIZE,
    });
  }

  private tasksForOrders(
    orders: Array<Pick<WorkspaceOrder, 'id' | 'orderNumber'>>,
  ): Promise<WorkspaceTask[]> {
    if (!orders.length) return Promise.resolve([]);
    const orderIds = orders.map((order) => order.id);
    const orderNumbers = orders.map((order) => order.orderNumber);
    return this.prisma.warehouseAcceptanceTask.findMany({
      where: {
        mode: { in: ['receiving', 'reserve'] },
        OR: [
          { orderId: { in: orderIds } },
          {
            orderId: null,
            rows: { some: { fromOrderId: { in: orderNumbers } } },
          },
        ],
      },
      select: WORKSPACE_TASK_SELECT,
    });
  }

  private groupTasks(
    tasks: WorkspaceTask[],
    orders: Array<Pick<WorkspaceOrder, 'id' | 'orderNumber'>>,
  ) {
    const grouped = new Map<string, WorkspaceTask[]>();
    const orderIdByNumber = new Map(orders.map((order) => [order.orderNumber, order.id]));
    for (const task of tasks) {
      const linkedOrderIds = task.orderId
        ? [task.orderId]
        : [
            ...new Set(
              task.rows.flatMap((row) => {
                const linkedOrderId = row.fromOrderId
                  ? orderIdByNumber.get(row.fromOrderId)
                  : undefined;
                return linkedOrderId ? [linkedOrderId] : [];
              }),
            ),
          ];
      for (const linkedOrderId of linkedOrderIds) {
        grouped.set(linkedOrderId, [...(grouped.get(linkedOrderId) ?? []), task]);
      }
    }
    return grouped;
  }

  private projectSummary(
    order: WorkspaceOrder,
    tasks: WorkspaceTask[],
    actor: Actor,
    coverage: WarehouseCoverageProjection | null = null,
  ): CommercialWorkspaceOrderSummary {
    const indicators = this.indicators(order);
    const { completion } = calculateOrderFulfillment(
      fulfillmentOrderFromWorkspace(order),
      tasks,
      indicators.shipment,
    );
    const nextAction = this.nextAction(order, completion, actor, coverage);
    const projectedCounterparty = projectCounterparty(order.counterparty, actor.role);
    const bucket = this.bucket(order, completion);
    const dispatchItems = order.productionOrder?.dispatchItems ?? [];

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      title: order.title,
      version: order.version,
      comment: order.comment,
      commentVersion: order.commentVersion,
      bucket,
      requestType: enumValue(order.requestType, REQUEST_TYPES, 'requestType'),
      counterparty: projectedCounterparty
        ? {
            id: projectedCounterparty.id,
            displayName: projectedCounterparty.displayName,
            legalName: projectedCounterparty.legalName,
            inn: projectedCounterparty.inn,
          }
        : null,
      stockProductionTemplate: projectStockProductionTemplate(order),
      stockBatchCode: order.stockBatchCode,
      positionCount: order.positions.length,
      requestedQty: completion.requestedQty,
      indicators,
      cancellation: {
        status: order.cancellationStatus === 'cancelled' ? 'cancelled' : 'active',
        version: order.cancellationVersion,
        cancelledAt: order.cancelledAt?.toISOString() ?? null,
        reason: order.cancellationReason,
        completedRollCount: dispatchItems.filter(
          (item) =>
            item.completedAt !== null || ['ready_for_warehouse', 'done'].includes(item.status),
        ).length,
        remainingCancelledRollCount: dispatchItems.filter((item) => item.status === 'cancelled')
          .length,
      },
      commercialCompletion: completion,
      nextAction,
      actionPriority: this.actionPriority(nextAction),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      ...(coverage
        ? {
            warehouseCoverageWorkflowVersion: 2 as const,
            warehouseCoverage: coverage,
          }
        : {}),
    };
  }

  private projectDetail(
    order: WorkspaceOrder,
    tasks: WorkspaceTask[],
    actor: Actor,
    coverage: CommercialWarehouseCoverageProjection | null,
  ): CommercialWorkspaceOrderDetail {
    const indicators = this.indicators(order);
    const fulfillment = calculateOrderFulfillment(
      fulfillmentOrderFromWorkspace(order),
      tasks,
      indicators.shipment,
    );
    const { completion } = fulfillment;
    const factsByPosition = new Map(
      fulfillment.positions.map((position) => [position.positionId, position]),
    );
    const positions = order.positions.map((position) => {
      const facts = factsByPosition.get(position.id);
      if (!facts) {
        throw new InternalServerErrorException(
          `Fulfillment facts unavailable for position ${position.id}`,
        );
      }
      return this.projectPosition(order, position, facts);
    });
    const nextAction = this.nextAction(order, completion, actor, coverage);
    const summary: Omit<CommercialWorkspaceOrderSummary, 'warehouseCoverage'> = this.projectSummary(
      order,
      tasks,
      actor,
      coverage,
    );
    const paymentConfirmed = indicators.payment === 'partial' || indicators.payment === 'paid';
    const parametersAllowed =
      actor.capabilities.includes('order:update_position') &&
      ['draft', 'incoming'].includes(order.commercialStage) &&
      order.cancellationStatus === 'active' &&
      !paymentConfirmed &&
      !order.commercialLockedAt;
    const invoiceLocked = invoiceLocksCommercialParameters(
      order.financeOrder
        ? {
            financeOrderId: order.financeOrder.id,
            commercialOrderId: order.id,
            invoiceStatus: order.financeOrder.invoiceStatus,
            invoiceIssuedAt: order.financeOrder.invoiceIssuedAt,
            invoiceSyncState: order.financeOrder.invoiceSyncState,
          }
        : null,
    );
    const parametersAmendable =
      actor.capabilities.includes('order:amend') &&
      order.cancellationStatus === 'active' &&
      Boolean(order.financeOrder) &&
      !invoiceLocked;

    return {
      ...summary,
      ...(coverage
        ? {
            warehouseCoverageWorkflowVersion: 2 as const,
            warehouseCoverage: coverage,
          }
        : {}),
      ...(actor.role === 'commercial'
        ? { commercialFinanceNote: order.commercialFinanceNote }
        : {}),
      nextAction,
      creatorRole: order.creatorRole,
      commercialStage: enumValue(order.commercialStage, COMMERCIAL_STAGES, 'commercialStage'),
      ownerRole: nextAction.ownerRole,
      productionOrderId: order.productionOrder?.id ?? null,
      financeSummary: order.financeOrder
        ? {
            invoiceStatus: order.financeOrder.invoiceStatus,
            paymentStatus: enumValue(
              order.financeOrder.paymentStatus,
              PAYMENT_STATUSES,
              'financeOrder.paymentStatus',
            ),
          }
        : null,
      edit: {
        parametersAllowed,
        parametersAmendable,
        parametersLockReason: invoiceLocked ? 'invoice_issued' : null,
        promoteDraftAllowed: nextAction.code === 'promote_draft' && nextAction.allowed,
        lockedAt: order.commercialLockedAt?.toISOString() ?? null,
      },
      positions,
      productionProblems: this.productionProblems(order),
    };
  }

  private productionProblems(order: WorkspaceOrder): CommercialProductionProblem[] {
    const dispatchItems = order.productionOrder?.dispatchItems ?? [];
    return order.problems.flatMap((problem) => {
      if (problem.status !== 'open' || !problem.positionId || !problem.rollId) return [];
      const position = order.positions.find((item) => item.id === problem.positionId);
      if (!position?.recipe) return [];
      const positionRolls = dispatchItems.filter((item) => item.orderLineId === position.id);
      const reportedRoll = positionRolls.find(
        (item) => item.id === problem.rollId || item.rollCode === problem.rollId,
      );
      if (!reportedRoll) return [];
      const candidateRolls = positionRolls
        .filter((item) => item.positionSequence >= reportedRoll.positionSequence)
        .sort(
          (left, right) =>
            left.positionSequence - right.positionSequence || left.id.localeCompare(right.id),
        )
        .map((item) => ({
          rollId: item.id,
          rollCode: item.rollCode,
          positionSequence: item.positionSequence,
          status: item.status,
          eligible: !hasConsumedMaterialFacts(item),
        }));
      return [
        {
          id: problem.id,
          type: problem.type,
          status: problem.status,
          reason: problem.reason,
          recovery: problem.recovery,
          positionId: position.id,
          reportedRollId: reportedRoll.rollCode,
          currentRollSequence: reportedRoll.positionSequence,
          completedRolls: positionRolls.filter(
            (item) =>
              Boolean(item.completedAt) || ['ready_for_warehouse', 'done'].includes(item.status),
          ).length,
          totalRolls: position.rollCount,
          ownerRole: 'commercial' as const,
          currentRecipe: {
            snapshotId: position.recipe.id,
            version: position.recipe.version,
            parameters: safeRecipeParameters(position.recipe.parameters),
          },
          candidateRolls,
          createdAt: problem.createdAt.toISOString(),
        },
      ];
    });
  }

  private indicators(order: WorkspaceOrder): CommercialOrderIndicators {
    return {
      production: enumValue(
        order.productionIndicator,
        PRODUCTION_INDICATORS,
        'productionIndicator',
      ) as ProductionIndicator,
      warehouseCover: enumValue(
        order.warehouseCoverStatus,
        WAREHOUSE_COVER_STATUSES,
        'warehouseCoverStatus',
      ) as WarehouseCoverStatus,
      payment: enumValue(order.paymentStatus, PAYMENT_STATUSES, 'paymentStatus') as PaymentStatus,
      shipment: enumValue(
        order.shipmentStatus,
        SHIPMENT_STATUSES,
        'shipmentStatus',
      ) as ShipmentStatus,
    };
  }

  private projectPosition(
    order: WorkspaceOrder,
    position: WorkspaceOrder['positions'][number],
    facts: FulfillmentPositionResult,
  ): CommercialWorkspacePosition {
    const proposal = currentCoverProposal(position.coverProposals);

    return {
      id: position.id,
      version: position.version,
      rollCount: position.rollCount,
      filmType: position.filmType,
      actualThickness: position.actualThickness,
      accountingThickness: position.accountingThickness,
      rawMaterialId: position.rawMaterialId,
      baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId,
      recipeDefinitionVersionId: position.recipeDefinitionVersionId,
      recipe: position.recipe
        ? {
            recipeDefinitionId: position.recipe.recipeDefinitionId,
            recipeDefinitionVersionId: position.recipe.recipeDefinitionVersionId,
            recipeVersionNumber: position.recipe.recipeVersionNumber,
            recipeName: position.recipe.recipeName,
            ingredients: safeRecipeIngredients(position.recipe.ingredients),
          }
        : null,
      spoolType: position.spoolType,
      birka: position.birka,
      manualBirka: position.manualBirka,
      comment: position.comment,
      plannedWeightKg: position.plannedWeightKg,
      widthMm: position.widthMm,
      plannedLengthM: position.plannedLengthM,
      warehouseCoverStatus: enumValue(
        position.warehouseCoverStatus,
        WAREHOUSE_COVER_STATUSES,
        'position.warehouseCoverStatus',
      ),
      coveredQty: facts.coveredQty,
      productionQty: facts.productionQty,
      fulfilledQty: facts.fulfilledQty,
      blockingReasons: facts.blockingReasons,
      coverProposals:
        order.warehouseCoverageWorkflowVersion === 2
          ? []
          : (proposal ? [proposal] : []).map((proposal) => ({
              id: proposal.id,
              orderId: order.id,
              positionId: position.id,
              version: proposal.version,
              route: proposal.route as WarehouseCoverRoute,
              status: enumValue(proposal.status, WAREHOUSE_COVER_STATUSES, 'proposal.status'),
              coverQty: proposal.coverQty,
              reserveQty: proposal.reserveQty,
              productionQty: proposal.productionQty,
              sourceCapturedAt: proposal.sourceCapturedAt.toISOString(),
              expiresAt: proposal.expiresAt?.toISOString() ?? null,
              stale: Boolean(proposal.expiresAt && proposal.expiresAt.getTime() <= Date.now()),
              commercialApproved: Boolean(proposal.commercialApprovedAt),
              technicalApproved: Boolean(proposal.technicalApprovedAt),
              matches: proposal.matches.map((match) => {
                const criteria = safeCoverCriteria(match.criteria);
                return {
                  rollId: match.roll.id,
                  rollCode: match.roll.rollCode,
                  compatible:
                    match.compatible &&
                    Object.values(criteria).every((criterion) => criterion.matches),
                  criteria,
                };
              }),
            })),
    };
  }

  private bucket(order: WorkspaceOrder, completion: CommercialCompletion): CommercialBucket {
    if (completion.state !== 'incomplete') return 'completed';
    if (order.commercialStage === 'draft') return 'drafts';
    if (order.productionOrder || order.requestType === 'stock_reserve') {
      return 'in_work';
    }
    return 'incoming';
  }

  private nextAction(
    order: WorkspaceOrder,
    completion: CommercialCompletion,
    actor: Actor,
    coverage: WarehouseCoverageProjection | null = null,
  ): CommercialNextAction {
    if (order.cancellationStatus === 'cancelled') {
      return this.actionForActor(
        actor,
        'delete_order',
        'commercial',
        'Удалить заказ без возможности восстановления',
        'order:cancel',
      );
    }
    if (order.warehouseCoverageWorkflowVersion === 2) {
      return this.nextV2Action(order, completion, actor, coverage);
    }
    if (order.commercialStage === 'draft') {
      return this.action(
        actor,
        'promote_draft',
        'commercial',
        'Передать черновик в работу',
        'order:create',
      );
    }
    const openResolution = order.resolutionCases.find(
      (resolution) => resolution.status !== 'resolved',
    );
    const openProblem = order.problems.find((problem) => problem.status !== 'resolved');
    if (openResolution?.ownerRole === 'commercial' || openProblem) {
      return this.action(
        actor,
        'resolve_problem',
        'commercial',
        'Принять решение по проблеме',
        'correction:create',
      );
    }
    if (order.requestType === 'stock_reserve') {
      if (!order.productionOrder) {
        return this.actionForActor(
          actor,
          'send_to_production',
          'commercial',
          'Передать производство на запас в производство',
          'production_order:handoff',
        );
      }
      if (completion.state === 'incomplete') {
        return this.action(
          actor,
          'wait_fulfillment',
          'production_lead',
          'Ожидать производство запаса',
        );
      }
      return this.action(actor, 'stock_available', 'warehouse', 'Запас принят складом');
    }
    const proposals = order.positions.flatMap((position) => {
      const proposal = currentCoverProposal(position.coverProposals);
      return proposal ? [proposal] : [];
    });
    const commercialReview = proposals.find(
      (proposal) =>
        ['partial_proposed', 'full_proposed'].includes(proposal.status) &&
        !proposal.commercialApprovedAt,
    );
    if (commercialReview) {
      return this.action(
        actor,
        'review_cover',
        'commercial',
        'Проверить покрытие склада',
        'warehouse_cover:confirm',
      );
    }
    const technicalReview = proposals.find(
      (proposal) =>
        proposal.route !== 'production_only' &&
        proposal.commercialApprovedAt &&
        !proposal.technicalApprovedAt,
    );
    if (technicalReview) {
      return this.action(
        actor,
        'technical_approve_cover',
        'production_lead',
        'Подтвердить техническую пригодность',
        'warehouse_cover:technical_approve',
      );
    }
    if (['not_checked', 'recheck_requested'].includes(order.warehouseCoverStatus)) {
      return this.action(
        actor,
        'request_cover',
        'commercial',
        'Запросить проверку склада',
        'warehouse_cover:request',
      );
    }
    if (order.commercialStage === 'incoming') {
      return this.action(
        actor,
        'submit_to_finance',
        'commercial',
        'Передать в бухгалтерию',
        'invoice:handoff',
      );
    }
    const paymentConfirmed = ['partial', 'paid'].includes(order.paymentStatus);
    const needsProduction =
      order.positions.some((position) =>
        PRODUCTION_ROUTE_STATUSES.has(position.warehouseCoverStatus),
      ) || proposals.some((proposal) => proposal.productionQty > 0);
    const financeAllowsHandoff = financeAllowsProduction(order.financeOrder);
    if (needsProduction && !order.productionOrder && financeAllowsHandoff) {
      return this.action(
        actor,
        'send_to_production',
        'commercial',
        'Передать остаток в производство',
        'production_order:handoff',
      );
    }
    if (
      needsProduction &&
      !order.productionOrder &&
      !financeAllowsHandoff &&
      ['sent_to_finance', 'in_work'].includes(order.commercialStage)
    ) {
      return this.financeGateAction(order, actor);
    }
    if (completion.state !== 'incomplete') {
      return this.action(
        actor,
        'prepare_shipment',
        'warehouse',
        'Подготовить отгрузку',
        'warehouse:close',
      );
    }
    if (!paymentConfirmed && order.commercialStage === 'sent_to_finance') {
      return this.financeGateAction(order, actor);
    }
    return this.action(actor, 'wait_fulfillment', 'production_lead', 'Ожидать исполнение');
  }

  private nextV2Action(
    order: WorkspaceOrder,
    completion: CommercialCompletion,
    actor: Actor,
    coverage: WarehouseCoverageProjection | null,
  ): CommercialNextAction {
    if (order.commercialStage === 'draft') {
      return this.actionForActor(
        actor,
        'promote_draft',
        'commercial',
        'Передать черновик в работу',
        'order:create',
      );
    }
    const openResolution = order.resolutionCases.find(
      (resolution) => resolution.status !== 'resolved',
    );
    const openProblem = order.problems.find((problem) => problem.status !== 'resolved');
    if (openResolution?.ownerRole === 'commercial' || openProblem) {
      return this.actionForActor(
        actor,
        'resolve_problem',
        'commercial',
        'Принять решение по проблеме',
        'correction:create',
      );
    }
    if (order.commercialStage === 'incoming') {
      return this.actionForActor(
        actor,
        'submit_to_finance',
        'commercial',
        'Передать в бухгалтерию',
        'invoice:handoff',
      );
    }
    if (!coverage) {
      return this.action(actor, 'wait_coverage', 'finance', 'Ожидать расчёт покрытия');
    }
    if (
      coverage.nextOwner === 'commercial' &&
      coverage.availableActions.includes('correct_order_spec')
    ) {
      return this.actionForActor(
        actor,
        'correct_order_spec',
        'commercial',
        'Исправить спецификацию заказа',
        'order:update_position',
      );
    }
    const productionRoutePending =
      coverage.state === 'production_required' ||
      (coverage.state === 'stale' &&
        order.coverageState?.currentDecision?.kind === 'auto_produce_all');
    if (productionRoutePending && !order.productionOrder) {
      if (financeAllowsProduction(order.financeOrder)) {
        return this.actionForActor(
          actor,
          'send_to_production',
          'commercial',
          'Передать заказ в производство',
          'production_order:handoff',
        );
      }
      return this.financeGateAction(order, actor);
    }
    if (completion.state !== 'incomplete') {
      return this.actionForActor(
        actor,
        'prepare_shipment',
        'warehouse',
        'Подготовить отгрузку',
        'warehouse:close',
      );
    }
    if (coverage.state === 'awaiting_finance') {
      return this.action(actor, 'wait_coverage_decision', 'finance', 'Ожидать выбор маршрута');
    }
    const owner = coverage.nextOwner === 'system' ? 'finance' : coverage.nextOwner;
    const labels: Record<typeof owner, string> = {
      commercial: 'Исправить данные заказа',
      finance: 'Ожидать финансовый этап',
      warehouse: 'Ожидать склад',
    };
    return this.action(actor, `wait_coverage_${coverage.state}`, owner, labels[owner]);
  }

  private financeGateAction(order: WorkspaceOrder, actor: Actor): CommercialNextAction {
    const gate = financeProductionGate(order.financeOrder);
    if (gate === 'open') {
      return this.action(actor, 'wait_fulfillment', 'production_lead', 'Ожидать исполнение');
    }
    const copy = {
      awaiting_invoice: {
        code: 'wait_invoice',
        label: 'Ожидать счёт',
      },
      awaiting_payment_terms: {
        code: 'wait_payment_terms',
        label: 'Ожидать условия оплаты',
      },
      awaiting_prepayment: {
        code: 'wait_prepayment',
        label: 'Ожидать предоплату',
      },
    } as const;
    const action = copy[gate];
    return this.action(actor, action.code, 'finance', action.label);
  }

  private actionForActor(
    actor: Actor,
    code: CommercialWaitableActionCode,
    ownerRole: CommercialNextAction['ownerRole'],
    label: string,
    capability: Capability,
  ): CommercialNextAction {
    if (actor.capabilities.includes(capability)) {
      return this.action(actor, code, ownerRole, label, capability);
    }
    return this.action(
      actor,
      `wait_${code}` as const,
      ownerRole,
      `Ожидать: ${label.toLocaleLowerCase('ru-RU')}`,
    );
  }

  private action(
    actor: Actor,
    code: CommercialNextAction['code'],
    ownerRole: CommercialNextAction['ownerRole'],
    label: string,
    capability?: Capability,
  ): CommercialNextAction {
    return {
      code,
      ownerRole,
      label,
      allowed: Boolean(capability && actor.capabilities.includes(capability)),
    };
  }

  private actionPriority(action: CommercialNextAction) {
    if (!action.allowed) return 100;
    if (action.code === 'resolve_problem') return 0;
    if (['review_cover', 'technical_approve_cover'].includes(action.code)) return 10;
    if (action.code === 'promote_draft') return 20;
    if (['request_cover', 'submit_to_finance'].includes(action.code)) return 30;
    if (action.code === 'send_to_production') return 40;
    return 50;
  }
}

function safeRecipeParameters(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    if (typeof item.label !== 'string' || typeof item.value !== 'string') return [];
    return [{ label: item.label, value: item.value }];
  });
}

function safeRecipeIngredients(value: Prisma.JsonValue | null) {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    if (
      typeof item.rawMaterialDefinitionId !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.shareBasisPoints !== 'number' ||
      !Number.isInteger(item.shareBasisPoints) ||
      item.shareBasisPoints <= 0
    ) {
      return [];
    }
    return [
      {
        rawMaterialDefinitionId: item.rawMaterialDefinitionId,
        name: item.name,
        shareBasisPoints: item.shareBasisPoints,
      },
    ];
  });
}

function safeCoverCriteria(value: Prisma.JsonValue): WarehouseCoverCriteria {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    filmType: safeCriterion(source.filmType),
    actualThickness: safeCriterion(source.actualThickness),
    birka: safeCriterion(source.birka),
    spoolType: safeCriterion(source.spoolType),
    weight: safeCriterion(source.weight),
  };
}

function safeCriterion(value: Prisma.JsonValue | undefined) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { expected: null, actual: null, matches: false };
  }
  const expected = safeCriterionValue(value.expected);
  const actual = safeCriterionValue(value.actual);
  return {
    expected,
    actual,
    matches: value.matches === true && expected !== null && actual !== null,
  };
}

function safeCriterionValue(value: Prisma.JsonValue | undefined) {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}
