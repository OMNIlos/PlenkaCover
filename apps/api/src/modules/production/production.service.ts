import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type OperatorPostSession,
  type ProductionProblem,
  type RollDispatchItem,
} from '@prisma/client';
import {
  capabilitiesForRole,
  type Role,
  type WarehouseCoverageProjection,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { PostDeviceReadinessService } from '../../common/device-readiness/post-device-readiness.service';
import {
  isValidRollNetKg,
  resolveCanonicalRollCaptures,
} from '../../common/weight-capture/canonical-roll-capture';
import { isDeviceBackedWeightEvidence } from '../../common/weight-capture/device-backed-evidence';
import { assertProductionDispatchItemCount } from '../../common/production-order-limits';
import { projectCounterparty } from '../commercial/projection';
import {
  captureProductionClearance,
  financeAllowsProduction,
} from '../finance/payment-production-gate';
import {
  COMMERCIAL_HANDOFF_POSITION_INCLUDE,
  type CommercialHandoffPosition,
  productionRecipeSnapshot,
  recipeNumber,
  WarehouseCoverageProductionHandoffService,
} from '../warehouse-coverage/warehouse-coverage-production-handoff.service';
import { WarehouseCoverageProjectionService } from '../warehouse-coverage/warehouse-coverage-projection.service';
import { WarehouseSpoolStockService } from '../warehouse/warehouse-spool-stock.service';
import { recycleDefectToSecondaryStock } from '../warehouse/recycling';
import type { AssignRollDto } from './dto/assign.dto';
import type { BulkAssignDto } from './dto/bulk-assign.dto';
import type { SetPriorityDto } from './dto/priority.dto';
import type { AssignMachineDto } from './dto/machine.dto';
import type { ReportProblemDto } from './dto/problem.dto';
import type { CreateShiftDto } from './dto/shift.dto';
import type { AssignOperatorMachineDto, BreakdownReassignDto } from './dto/operator-machine.dto';
import type { BatchUpdateDispatchDto } from './dto/batch-update.dto';
import type { ReorderDispatchDto } from './dto/reorder.dto';
import type { CreateOperatorPenaltyDto } from './dto/operator-penalty.dto';
import { isProductionOrderBucket } from './dto/production-order-query.dto';
import {
  isProductionProblemStatus,
  isProductionProblemType,
  type ProductionProblemQueryDto,
} from './dto/production-problem-query.dto';

export interface ProductionActor {
  userId: string | null;
  role: Role;
  capabilities?: Actor['capabilities'];
}

type ProductionProjectionActor = Role | Actor;

function projectionActor(actor: ProductionProjectionActor): Actor {
  return typeof actor === 'string'
    ? {
        userId: null,
        role: actor,
        capabilities: [...capabilitiesForRole(actor)],
      }
    : actor;
}

type ReplacementClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'productionOrder' | 'rollDispatchItem' | 'operatorRollLine' | 'domainEvent'
>;

const APPROVAL_DISPATCH_ORDER = [
  { queueRank: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.RollDispatchItemOrderByWithRelationInput[];

const MAX_DISPATCH_ARCHIVE_DAYS = 366;
const MAX_DISPATCH_ROWS = 2_000;
const MAX_PRODUCTION_ORDER_ROWS = 2_000;
const MAX_PRODUCTION_RESPONSE_FACTS = 20_000;
const MAX_PRODUCTION_PROBLEM_ROWS = 100;

const PO_SELECT = {
  id: true,
  commercialOrderId: true,
  indicator: true,
  approvalState: true,
  assignedOwnerId: true,
  blockers: true,
  sourceCoverageCalculationId: true,
  sourceCoverageDecisionId: true,
  sourceCoverageInputFingerprint: true,
  sourceCoverageGeneration: true,
  createdAt: true,
  updatedAt: true,
  commercialOrder: {
    select: {
      id: true,
      orderNumber: true,
      creatorRole: true,
      counterpartyId: true,
      requestType: true,
      productionIndicator: true,
      warehouseCoverStatus: true,
      paymentStatus: true,
      shipmentStatus: true,
      warehouseCoverageWorkflowVersion: true,
      commercialConfirmationPolicy: true,
      createdAt: true,
      updatedAt: true,
      externalId: true,
      sourceVersion: true,
      stockBatchCode: true,
      counterparty: {
        select: {
          id: true,
          displayName: true,
          legalName: true,
          inn: true,
          billingSource: true,
          syncStatus: true,
        },
      },
    },
  },
  dispatchItems: {
    where: { status: { not: 'cancelled' } },
    select: {
      id: true,
      rollCode: true,
      productionOrderId: true,
      orderLineId: true,
      positionSequence: true,
      rawMaterialId: true,
      recipeVersion: true,
      filmType: true,
      plannedWeightKg: true,
      widthMm: true,
      plannedLengthM: true,
      characteristicsSnapshot: true,
      assignedOperatorId: true,
      assignedOperator: { select: { id: true, displayName: true } },
      machineId: true,
      workplaceId: true,
      postId: true,
      post: { select: { id: true, code: true, name: true, status: true } },
      plannedShiftId: true,
      queueRank: true,
      priority: true,
      status: true,
      bulkGroupId: true,
      replacesDispatchItemId: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
      operatorLine: {
        select: {
          netKg: true,
          step: true,
          warehouseState: true,
        },
      },
    },
    orderBy: [{ queueRank: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.ProductionOrderSelect;

type ProductionOrderProjectionSource = Prisma.ProductionOrderGetPayload<{
  select: typeof PO_SELECT;
}>;

type ProductionDefectAggregate = {
  defectRollCount: number;
  verifiedDefectKg: number;
  returnedSpoolCount: number;
};

type ProductionDefectAggregateRow = ProductionDefectAggregate & {
  productionOrderId: string;
};

type LoadedProductionOrder = {
  order: ProductionOrderProjectionSource;
  defectAggregate: ProductionDefectAggregate;
};

const EMPTY_DEFECT_AGGREGATE: ProductionDefectAggregate = {
  defectRollCount: 0,
  verifiedDefectKg: 0,
  returnedSpoolCount: 0,
};

const CURRENT_OPERATOR_ASSIGNMENT_INCLUDE = {
  shift: { select: { id: true, status: true } },
  post: { select: { id: true, code: true, name: true, status: true } },
} as const satisfies Prisma.OperatorShiftMachineAssignmentInclude;

const ACTIVE_OPERATOR_MACHINE_ASSIGNMENT_STATUSES = ['planned', 'locked', 'breakdown_reassigned'];

type CurrentOperatorAssignment = Prisma.OperatorShiftMachineAssignmentGetPayload<{
  include: typeof CURRENT_OPERATOR_ASSIGNMENT_INCLUDE;
}>;

type OperatorTopology = {
  plannedShiftId: string | null;
  postId: string | null;
  machineId: string | null;
  workplaceId: string | null;
};

const FINAL_COVER_STATUSES = new Set(['partial_confirmed', 'full_confirmed']);
const PRODUCTION_ONLY_COVER_STATUSES = new Set(['needs_production', 'rejected']);
const ASSIGNMENT_LOCKED_ROLL_STATUSES = new Set(['in_progress', 'ready_for_warehouse', 'done']);
const MANUALLY_CLOSABLE_PROBLEM_TYPES = ['general', 'defect', 'shift_balance_mismatch'] as const;
type ManuallyClosableProblemType = (typeof MANUALLY_CLOSABLE_PROBLEM_TYPES)[number];

function assignmentTargetStatus(item: {
  status: string;
  productionOrder: { approvalState: string };
  operatorLine?: { step: string } | null;
}): string {
  if (item.status === 'deferred' || item.operatorLine?.step === 'deferred') return 'deferred';
  return item.productionOrder.approvalState === 'approved' || item.status !== 'new'
    ? 'assigned'
    : 'new';
}

function isManuallyClosableProblemType(type: string): type is ManuallyClosableProblemType {
  return (MANUALLY_CLOSABLE_PROBLEM_TYPES as readonly string[]).includes(type);
}

function isSerializableWriteConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010' || !error.meta || typeof error.meta !== 'object') return false;
  return (error.meta as Record<string, unknown>).code === '40001';
}

function isRawMaterialRecyclingConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target =
    error.meta && typeof error.meta === 'object'
      ? (error.meta as Record<string, unknown>).target
      : null;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some(
    (field) =>
      typeof field === 'string' &&
      (field.includes('normalizedName') || field.includes('rawMaterialDefinitionId')),
  );
}

function productionSequenceStart(
  commercialOrderId: string,
  position: CommercialHandoffPosition,
): number {
  if (PRODUCTION_ONLY_COVER_STATUSES.has(position.warehouseCoverStatus)) return 1;
  if (!FINAL_COVER_STATUSES.has(position.warehouseCoverStatus)) {
    throw new ConflictException(
      `Warehouse cover route is not finalized for position ${position.id}`,
    );
  }

  const finalized = position.coverProposals.filter(
    (proposal) =>
      proposal.status === position.warehouseCoverStatus &&
      Boolean(proposal.commercialApprovedAt) &&
      Boolean(proposal.technicalApprovedAt),
  );
  if (finalized.length !== 1) {
    throw new ConflictException(
      `Finalized warehouse cover facts are inconsistent for position ${position.id}`,
    );
  }

  const proposal = finalized[0]!;
  const reservedRollIds = new Set(
    proposal.reservedRolls
      .filter(
        (roll) =>
          roll.reservedForOrderId === commercialOrderId &&
          roll.reservedForPositionId === position.id &&
          roll.reservedByProposalId === proposal.id,
      )
      .map((roll) => roll.id),
  );
  const coveredQty = reservedRollIds.size;
  const productionQty = Math.max(0, position.rollCount - coveredQty);
  if (
    coveredQty > position.rollCount ||
    proposal.coverQty !== coveredQty ||
    proposal.reserveQty !== coveredQty ||
    proposal.productionQty !== productionQty
  ) {
    throw new ConflictException(
      `Finalized warehouse reservations do not match position ${position.id}`,
    );
  }
  return coveredQty + 1;
}

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly v2CoverageHandoff: WarehouseCoverageProductionHandoffService,
    private readonly coverageProjection: WarehouseCoverageProjectionService,
    private readonly deviceReadiness: PostDeviceReadinessService,
    private readonly spoolStock: WarehouseSpoolStockService,
  ) {}

  async listOrders(actorInput: ProductionProjectionActor, bucket?: string) {
    const actor = projectionActor(actorInput);
    if (bucket !== undefined && !isProductionOrderBucket(bucket)) {
      throw new BadRequestException({
        code: 'INVALID_PRODUCTION_ORDER_BUCKET',
        message: 'Unsupported production order bucket.',
      });
    }
    const where =
      bucket === 'needs_approval'
        ? { approvalState: 'pending' }
        : bucket === 'approved'
          ? { approvalState: 'approved' }
          : {};
    const orders = await this.loadSafeOrderList(where);
    return this.projectOrders(orders, actor);
  }

  async getOrder(actorInput: ProductionProjectionActor, orderId: string) {
    const actor = projectionActor(actorInput);
    const loaded = await this.prisma.$transaction(
      async (tx) => {
        await this.assertSafeProjectionSize(tx, [orderId]);
        const order = await tx.productionOrder.findUnique({
          where: { id: orderId },
          select: PO_SELECT,
        });
        if (!order) return null;
        const aggregates = await this.loadDefectAggregates(tx, [orderId]);
        return {
          order,
          defectAggregate: aggregates.get(orderId) ?? EMPTY_DEFECT_AGGREGATE,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (!loaded) throw new NotFoundException(`Production order ${orderId} not found`);
    return (await this.projectOrders([loaded], actor))[0]!;
  }

  private loadSafeOrderList(where: Prisma.ProductionOrderWhereInput) {
    return this.prisma.$transaction(
      async (tx) => {
        const roots = await tx.productionOrder.findMany({
          where,
          select: { id: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_PRODUCTION_ORDER_ROWS + 1,
        });
        if (roots.length > MAX_PRODUCTION_ORDER_ROWS) {
          throw new UnprocessableEntityException({
            code: 'PRODUCTION_ORDER_CATALOG_TOO_LARGE',
            message: 'Слишком много заказов для безопасной выдачи. Уточните рабочую выборку.',
          });
        }
        const ids = roots.map(({ id }) => id);
        await this.assertSafeProjectionSize(tx, ids);
        if (ids.length === 0) return [];
        const orders = await tx.productionOrder.findMany({
          where: { id: { in: ids } },
          select: PO_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const aggregates = await this.loadDefectAggregates(tx, ids);
        return orders.map((order) => ({
          order,
          defectAggregate: aggregates.get(order.id) ?? EMPTY_DEFECT_AGGREGATE,
        }));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async assertSafeProjectionSize(
    tx: Prisma.TransactionClient,
    productionOrderIds: string[],
  ): Promise<void> {
    if (productionOrderIds.length === 0) return;
    const dispatchItems = await tx.rollDispatchItem.count({
      where: { productionOrderId: { in: productionOrderIds }, status: { not: 'cancelled' } },
    });
    if (dispatchItems <= MAX_PRODUCTION_RESPONSE_FACTS) return;
    throw new UnprocessableEntityException({
      code: 'PRODUCTION_ORDER_RESPONSE_TOO_LARGE',
      message: 'Слишком много фактов заказа для безопасной выдачи. Уточните рабочую выборку.',
    });
  }

  private async loadDefectAggregates(
    tx: Prisma.TransactionClient,
    productionOrderIds: string[],
  ): Promise<ReadonlyMap<string, ProductionDefectAggregate>> {
    if (productionOrderIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<ProductionDefectAggregateRow[]>(Prisma.sql`
      SELECT
        dispatch."productionOrderId" AS "productionOrderId",
        COUNT(DISTINCT CASE WHEN defect."id" IS NOT NULL THEN dispatch."id" END)::integer
          AS "defectRollCount",
        COALESCE(SUM(defect."weightKg"), 0)::double precision AS "verifiedDefectKg",
        COALESCE(SUM(movement."quantity"), 0)::double precision AS "returnedSpoolCount"
      FROM "roll_dispatch_items" AS dispatch
      LEFT JOIN "operator_roll_lines" AS line
        ON line."rollDispatchItemId" = dispatch."id"
      LEFT JOIN "defect_records" AS defect
        ON defect."operatorRollLineId" = line."id"
      LEFT JOIN "spool_stock_movements" AS movement
        ON movement."defectRecordId" = defect."id"
      WHERE dispatch."productionOrderId" IN (${Prisma.join(productionOrderIds)})
      GROUP BY dispatch."productionOrderId"
    `);
    return new Map(
      rows.map((row) => [
        row.productionOrderId,
        {
          defectRollCount: row.defectRollCount,
          verifiedDefectKg: Number(row.verifiedDefectKg.toFixed(3)),
          returnedSpoolCount: row.returnedSpoolCount,
        },
      ]),
    );
  }

  private async projectOrders(orders: LoadedProductionOrder[], actor: Actor) {
    const v2OrderIds = orders.flatMap(({ order }) =>
      order.commercialOrder.warehouseCoverageWorkflowVersion === 2 ? [order.commercialOrderId] : [],
    );
    const coverageByOrderId =
      v2OrderIds.length > 0 ? await this.coverageProjection.readMany(v2OrderIds, actor) : new Map();
    return orders.map(({ order, defectAggregate }) =>
      this.project(order, actor, defectAggregate, coverageByOrderId.get(order.commercialOrderId)),
    );
  }

  listShifts() {
    return this.prisma.shift.findMany({
      include: {
        machineAssignments: {
          include: {
            operator: { select: { id: true, displayName: true, isActive: true } },
            post: { select: { id: true, code: true, name: true, status: true } },
            machineChanges: {
              where: { status: { not: 'cancelled' } },
              include: {
                fromPost: { select: { id: true, code: true, name: true } },
                toPost: { select: { id: true, code: true, name: true } },
              },
              orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
              take: 1,
            },
          },
        },
      },
      orderBy: { plannedStartAt: 'asc' },
    });
  }

  async createShift(_actor: ProductionActor, dto: CreateShiftDto) {
    const plannedStartAt = new Date(dto.plannedStartAt);
    const plannedEndAt = new Date(dto.plannedEndAt);
    if (plannedEndAt <= plannedStartAt) {
      throw new ConflictException('Shift end must be after its start');
    }
    return this.prisma.shift.create({
      data: {
        label: dto.label.trim(),
        plannedStartAt,
        plannedEndAt,
        status: 'planned',
        startedAt: null,
      },
    });
  }

  listPosts() {
    return this.prisma.post.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        agentStatus: true,
        lastSeenAt: true,
      },
      orderBy: { code: 'asc' },
    });
  }

  listOperatorPenalties(actor: ProductionActor) {
    if (!actor.userId) throw new UnauthorizedException('Authentication required');
    return this.prisma.penalty.findMany({
      where: {
        OR: [
          { targetRole: 'operator' },
          { targetRole: 'production_lead', employeeId: actor.userId },
        ],
      },
      include: { employee: { select: { id: true, displayName: true, isActive: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createOperatorPenalty(actor: ProductionActor, dto: CreateOperatorPenaltyDto) {
    const [operator, order] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: dto.operatorId },
        select: { id: true, displayName: true, role: true, isActive: true },
      }),
      this.prisma.productionOrder.findUnique({
        where: { id: dto.productionOrderId },
        select: {
          id: true,
          approvalState: true,
          commercialOrder: { select: { orderNumber: true } },
          dispatchItems: { select: { rollCode: true, assignedOperatorId: true } },
        },
      }),
    ]);
    if (!operator || operator.role !== 'operator' || !operator.isActive) {
      throw new NotFoundException(`Active operator ${dto.operatorId} not found`);
    }
    if (!order) {
      throw new NotFoundException(`Production order ${dto.productionOrderId} not found`);
    }
    if (order.approvalState !== 'approved') {
      throw new ConflictException('A penalty may be linked only to a published order');
    }
    const assignedRolls = order.dispatchItems.filter(
      (item) => item.assignedOperatorId === operator.id,
    );
    if (assignedRolls.length === 0) {
      throw new ConflictException('The selected order was not assigned to this operator');
    }
    const rollCode = dto.rollCode?.trim() || null;
    if (rollCode && !assignedRolls.some((item) => item.rollCode === rollCode)) {
      throw new ConflictException(
        'The selected roll does not belong to this operator and production order',
      );
    }
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('Penalty reason is required');
    return this.prisma.$transaction(async (tx) => {
      const penalty = await tx.penalty.create({
        data: {
          employeeId: operator.id,
          targetRole: 'operator',
          amount: dto.amount,
          reason,
          sourceObjectId: rollCode ?? order.id,
          sourceProductionOrderId: order.id,
          sourceOrderNumber: order.commercialOrder.orderNumber,
          sourceRollCode: rollCode,
          authorRole: actor.role,
        },
        include: { employee: { select: { id: true, displayName: true, isActive: true } } },
      });
      await this.audit.record(
        {
          type: 'audit:penalty_created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: penalty.id,
          reason,
          detail: {
            targetRole: 'operator',
            employeeId: operator.id,
            employeeName: operator.displayName,
            amount: dto.amount,
            sourceObjectId: rollCode ?? order.id,
            productionOrderId: order.id,
            orderNumber: order.commercialOrder.orderNumber,
            rollCode,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'notification:penalty_created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: penalty.id,
          label: `Штраф назначен оператору ${operator.displayName}`,
          detail: {
            targetRole: 'operator',
            employeeId: operator.id,
            employeeName: operator.displayName,
            amount: dto.amount,
            reason,
            sourceObjectId: rollCode ?? order.id,
            productionOrderId: order.id,
            orderNumber: order.commercialOrder.orderNumber,
            rollCode,
          },
        },
        tx,
      );
      return penalty;
    });
  }

  async listOperatorMachines(shiftId: string) {
    const shift = await this.prisma.shift.findUnique({
      where: { id: shiftId },
      include: {
        machineAssignments: {
          include: {
            operator: { select: { id: true, displayName: true, isActive: true } },
            post: { select: { id: true, code: true, name: true, status: true } },
          },
        },
      },
    });
    if (!shift) throw new NotFoundException(`Shift ${shiftId} not found`);
    const operators = await this.prisma.user.findMany({
      where: { role: 'operator', isActive: true },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });
    return { shift, operators };
  }

  async assignOperatorMachine(
    actor: ProductionActor,
    shiftId: string,
    operatorId: string,
    dto: AssignOperatorMachineDto,
  ) {
    const [postSnapshot, assignmentSnapshot] = await Promise.all([
      this.prisma.post.findUnique({
        where: { id: dto.postId },
        select: { id: true, code: true, status: true },
      }),
      this.prisma.operatorShiftMachineAssignment.findFirst({
        where: {
          shiftId,
          operatorId,
          status: { in: ACTIVE_OPERATOR_MACHINE_ASSIGNMENT_STATUSES },
        },
        select: { id: true, postId: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    if (!postSnapshot) throw new NotFoundException(`Post ${dto.postId} not found`);
    if (postSnapshot.status !== 'active') {
      throw new ConflictException(`Post ${postSnapshot.code} is not active`);
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockProductionOperators(tx, [operatorId]);
      await this.lockAssignmentPlanningTopology(tx, {
        shiftId,
        targetPostId: dto.postId,
        assignmentId: assignmentSnapshot?.id ?? null,
        currentPostId: assignmentSnapshot?.postId ?? null,
      });

      const [shift, operator, post, assignment] = await Promise.all([
        tx.shift.findUnique({ where: { id: shiftId } }),
        tx.user.findUnique({ where: { id: operatorId } }),
        tx.post.findUnique({ where: { id: dto.postId } }),
        tx.operatorShiftMachineAssignment.findFirst({
          where: {
            shiftId,
            operatorId,
            status: { in: ACTIVE_OPERATOR_MACHINE_ASSIGNMENT_STATUSES },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      ]);
      if (!shift) throw new NotFoundException(`Shift ${shiftId} not found`);
      if (!operator || operator.role !== 'operator' || !operator.isActive) {
        throw new NotFoundException(`Active operator ${operatorId} not found`);
      }
      if (!post) throw new NotFoundException(`Post ${dto.postId} not found`);
      if (post.status !== 'active') {
        throw new ConflictException(`Post ${post.code} is not active`);
      }
      if (
        (assignmentSnapshot === null) !== (assignment === null) ||
        (assignmentSnapshot &&
          assignment &&
          (assignmentSnapshot.id !== assignment.id ||
            assignmentSnapshot.postId !== assignment.postId))
      ) {
        throw new ConflictException('Machine assignment changed concurrently; retry');
      }
      if (
        assignment &&
        (assignment.shiftId !== shiftId ||
          assignment.operatorId !== operatorId ||
          assignment.lockedAt ||
          assignment.status !== 'planned')
      ) {
        throw new ConflictException('Machine assignment is locked after the operator started');
      }
      if (
        shift.status !== 'planned' ||
        (shift.plannedStartAt !== null && shift.plannedStartAt <= new Date())
      ) {
        throw new ConflictException('Machine assignment must be completed before the shift starts');
      }
      const conflictingAssignment = await tx.operatorShiftMachineAssignment.findFirst({
        where: {
          ...(assignment ? { id: { not: assignment.id } } : {}),
          status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
          shift: { status: { in: ['planned', 'open'] } },
          OR: [{ operatorId }, { shiftId, postId: post.id }],
        },
        select: { id: true, shiftId: true, operatorId: true, postId: true },
      });
      if (conflictingAssignment?.operatorId === operatorId) {
        throw new ConflictException(`Operator ${operatorId} is already assigned in a usable shift`);
      }
      if (conflictingAssignment) {
        throw new ConflictException(`Post ${post.code} is already assigned in a usable shift`);
      }

      const updated = assignment
        ? await tx.operatorShiftMachineAssignment.update({
            where: { id: assignment.id },
            data: { postId: post.id, createdById: actor.userId },
          })
        : await tx.operatorShiftMachineAssignment.create({
            data: {
              shiftId,
              operatorId,
              postId: post.id,
              status: 'planned',
              createdById: actor.userId,
            },
          });
      await this.audit.record(
        {
          type: 'audit:operator_shift_machine_assigned',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: updated.id,
          ...(assignment ? { oldValue: { postId: assignment.postId } } : {}),
          newValue: { shiftId, operatorId, postId: post.id, machineId: post.code },
        },
        tx,
      );
      return updated;
    });
  }

  private async lockAssignmentPlanningTopology(
    client: Prisma.TransactionClient,
    ids: {
      shiftId: string;
      targetPostId: string;
      assignmentId: string | null;
      currentPostId: string | null;
    },
  ): Promise<void> {
    const postIds = [...new Set([ids.targetPostId, ids.currentPostId].filter(Boolean))].sort();
    for (const postId of postIds) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`,
      );
    }
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${ids.shiftId} FOR UPDATE`,
    );
    if (ids.assignmentId) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments" WHERE "id" = ${ids.assignmentId} FOR UPDATE`,
      );
    }
  }

  async breakdownReassign(actor: ProductionActor, assignmentId: string, dto: BreakdownReassignDto) {
    const reason = dto.reason.trim();
    if (!reason) throw new ConflictException('Breakdown reason is required');
    const assignment = await this.prisma.operatorShiftMachineAssignment.findUnique({
      where: { id: assignmentId },
      include: { post: { select: { id: true, code: true, status: true } } },
    });
    if (!assignment) throw new NotFoundException(`Machine assignment ${assignmentId} not found`);
    if (!['locked', 'breakdown_reassigned'].includes(assignment.status)) {
      throw new ConflictException('Breakdown reassignment is available only after shift start');
    }
    const nextPost = await this.prisma.post.findUnique({ where: { id: dto.postId } });
    if (!nextPost) throw new NotFoundException(`Post ${dto.postId} not found`);
    if (nextPost.status !== 'active') {
      throw new ConflictException(`Post ${nextPost.code} is not active`);
    }
    if (nextPost.id === assignment.postId) {
      throw new ConflictException('Select a different post for breakdown reassignment');
    }
    await this.deviceReadiness.require(nextPost.id, 'production.assignment');
    const occupied = await this.prisma.operatorShiftMachineAssignment.findFirst({
      where: {
        shiftId: assignment.shiftId,
        postId: nextPost.id,
        operatorId: { not: assignment.operatorId },
      },
    });
    if (occupied) throw new ConflictException(`Post ${nextPost.code} is already assigned`);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockBreakdownTopology(tx, {
        assignmentId: assignment.id,
        shiftId: assignment.shiftId,
        currentPostId: assignment.postId,
        nextPostId: nextPost.id,
      });
      const [lockedAssignment, lockedNextPost] = await Promise.all([
        tx.operatorShiftMachineAssignment.findUnique({
          where: { id: assignment.id },
          include: { post: { select: { id: true, code: true, status: true } } },
        }),
        tx.post.findUnique({ where: { id: nextPost.id } }),
      ]);
      if (
        !lockedAssignment ||
        lockedAssignment.shiftId !== assignment.shiftId ||
        lockedAssignment.operatorId !== assignment.operatorId ||
        lockedAssignment.postId !== assignment.postId ||
        !['locked', 'breakdown_reassigned'].includes(lockedAssignment.status)
      ) {
        throw new ConflictException('Machine assignment changed before breakdown reassignment');
      }
      if (!lockedNextPost || lockedNextPost.status !== 'active') {
        throw new ConflictException(`Post ${nextPost.code} changed before breakdown reassignment`);
      }
      if (lockedNextPost.id === lockedAssignment.postId) {
        throw new ConflictException('Select a different post for breakdown reassignment');
      }
      await this.deviceReadiness.require(lockedNextPost.id, 'production.assignment', tx);
      const lockedOccupied = await tx.operatorShiftMachineAssignment.findFirst({
        where: {
          shiftId: lockedAssignment.shiftId,
          postId: lockedNextPost.id,
          operatorId: { not: lockedAssignment.operatorId },
        },
      });
      if (lockedOccupied) {
        throw new ConflictException(`Post ${lockedNextPost.code} is already assigned`);
      }

      const activeSession = await this.lockBreakdownActiveSession(tx, {
        operatorId: lockedAssignment.operatorId,
        postId: lockedAssignment.postId,
        shiftId: lockedAssignment.shiftId,
      });
      const openBagUsage = await tx.shiftBagUsage.findFirst({
        where: {
          closedAt: null,
          ...(activeSession
            ? { sessionId: activeSession.id }
            : {
                session: {
                  operatorId: lockedAssignment.operatorId,
                  postId: lockedAssignment.postId,
                  shiftId: lockedAssignment.shiftId,
                },
              }),
        },
        select: { id: true },
      });
      if (openBagUsage) {
        throw new ConflictException({
          code: 'PRODUCTION_BREAKDOWN_OPEN_BAG_USAGE',
          message: 'Close the operator shift with final bag weights before reassignment',
        });
      }

      // Сломанный станок: broken до явного ремонта (дизайн 2026-07-14); заявка
      // фиксируется проблемой machine_breakdown, если по посту еще нет открытой.
      if (lockedAssignment.post.status === 'active') {
        await tx.post.update({
          where: { id: lockedAssignment.postId },
          data: { status: 'broken' },
        });
      } else if (!['broken', 'maintenance'].includes(lockedAssignment.post.status)) {
        throw new ConflictException(
          `Post ${lockedAssignment.post.code} cannot be breakdown-reassigned (${lockedAssignment.post.status})`,
        );
      }
      const openBreakdown = await tx.productionProblem.findFirst({
        where: { postId: lockedAssignment.postId, type: 'machine_breakdown', status: 'open' },
      });
      if (!openBreakdown) {
        await tx.productionProblem.create({
          data: {
            type: 'machine_breakdown',
            postId: lockedAssignment.postId,
            actorRole: actor.role,
            reason,
            recovery: 'поломка подтверждена завпроизводства (аварийное переназначение)',
          },
        });
      }
      if (activeSession) {
        const closed = await tx.operatorPostSession.updateMany({
          where: { id: activeSession.id, status: 'active' },
          data: { status: 'closed', endedAt: new Date() },
        });
        if (closed.count !== 1) {
          throw new ConflictException('Operator post session changed before reassignment');
        }
        await this.audit.record(
          {
            type: 'audit:operator_post_session_closed',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: activeSession.postId,
            reason,
            detail: {
              sessionId: activeSession.id,
              shiftId: activeSession.shiftId,
              source: 'production_breakdown_reassign',
            },
          },
          tx,
        );
      }
      const updated = await tx.operatorShiftMachineAssignment.update({
        where: { id: lockedAssignment.id },
        data: {
          previousPostId: lockedAssignment.postId,
          postId: lockedNextPost.id,
          status: 'breakdown_reassigned',
          breakdownReason: reason,
          reassignedAt: new Date(),
        },
      });
      const rolls = await tx.rollDispatchItem.updateMany({
        where: {
          plannedShiftId: lockedAssignment.shiftId,
          assignedOperatorId: lockedAssignment.operatorId,
          status: { notIn: ['ready_for_warehouse', 'done'] },
        },
        data: {
          postId: lockedNextPost.id,
          workplaceId: lockedNextPost.id,
          machineId: lockedNextPost.code,
        },
      });
      await this.audit.record(
        {
          type: 'problem:machine_breakdown_reported',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: updated.id,
          reason,
          detail: { postId: lockedAssignment.post.id, machineId: lockedAssignment.post.code },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'audit:operator_machine_breakdown_reassigned',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: updated.id,
          oldValue: {
            postId: lockedAssignment.post.id,
            workplaceId: lockedAssignment.post.id,
            machineId: lockedAssignment.post.code,
          },
          newValue: {
            postId: lockedNextPost.id,
            workplaceId: lockedNextPost.id,
            machineId: lockedNextPost.code,
          },
          reason,
          detail: { affectedRolls: rolls.count, shiftId: lockedAssignment.shiftId },
        },
        tx,
      );
      return { updated, affectedRolls: rolls.count };
    });

    return { ...result.updated, affectedRolls: result.affectedRolls };
  }

  private async lockBreakdownTopology(
    client: Prisma.TransactionClient,
    ids: {
      assignmentId: string;
      shiftId: string;
      currentPostId: string;
      nextPostId: string;
    },
  ): Promise<void> {
    const postIds = [...new Set([ids.currentPostId, ids.nextPostId])].sort();
    for (const postId of postIds) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`,
      );
    }
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${ids.shiftId} FOR UPDATE`,
    );
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments" WHERE "id" = ${ids.assignmentId} FOR UPDATE`,
    );
  }

  private async lockBreakdownActiveSession(
    client: Prisma.TransactionClient,
    scope: { operatorId: string; postId: string; shiftId: string },
  ): Promise<OperatorPostSession | null> {
    await client.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "operator_post_sessions"
        WHERE "operatorId" = ${scope.operatorId}
          AND "postId" = ${scope.postId}
          AND "shiftId" = ${scope.shiftId}
          AND "status" = 'active'
        ORDER BY "id"
        FOR UPDATE
      `,
    );
    return client.operatorPostSession.findFirst({
      where: {
        operatorId: scope.operatorId,
        postId: scope.postId,
        shiftId: scope.shiftId,
        status: 'active',
      },
    });
  }

  /**
   * Поломка станка, зафиксированная завпроизводства напрямую (дизайн 2026-07-14):
   * пост → broken (все точки назначения его отвергают), открывается проблема
   * machine_breakdown; прямое обращение — сразу подтверждено.
   */
  async reportMachineBreakdown(actor: ProductionActor, postId: string, dto: { reason: string }) {
    const reason = dto.reason?.trim();
    if (!reason) throw new ConflictException('Причина поломки обязательна');
    return this.prisma.$transaction(async (tx) => {
      // Match breakdownReassign's lock order: Post rows are always locked first.
      // This makes the post itself the serialization key for every breakdown source.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`);
      const post = await tx.post.findUnique({ where: { id: postId } });
      if (!post) throw new NotFoundException(`Post ${postId} not found`);
      if (post.status === 'broken') {
        throw new ConflictException(`Станок ${post.code} уже помечен сломанным`);
      }
      if (post.status === 'inactive') {
        throw new ConflictException(`Станок ${post.code} выведен из эксплуатации`);
      }
      if (post.status !== 'active') {
        throw new ConflictException(`Станок ${post.code} уже находится в ремонте (${post.status})`);
      }
      const existing = await tx.productionProblem.findFirst({
        where: { postId, type: 'machine_breakdown', status: 'open' },
      });
      if (existing) {
        throw new ConflictException(`По станку ${post.code} уже открыта заявка о поломке`);
      }
      await tx.post.update({ where: { id: postId }, data: { status: 'broken' } });
      const problem = await tx.productionProblem.create({
        data: { type: 'machine_breakdown', postId, actorRole: actor.role, reason },
      });
      await this.audit.record(
        {
          type: 'problem:machine_breakdown_reported',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: postId,
          reason,
          detail: { problemId: problem.id, machineId: post.code, previousStatus: post.status },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'audit:machine_breakdown_confirmed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: problem.id,
          reason,
          detail: { postId, machineId: post.code, source: 'production_lead_direct' },
        },
        tx,
      );
      return problem;
    });
  }

  /** Сломанный станок отправлен в ремонт: broken → maintenance. */
  async startMachineRepair(actor: ProductionActor, postId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`);
      const post = await tx.post.findUnique({ where: { id: postId } });
      if (!post) throw new NotFoundException(`Post ${postId} not found`);
      if (post.status !== 'broken') {
        throw new ConflictException(`Станок ${post.code} не помечен сломанным (${post.status})`);
      }
      const updated = await tx.post.update({
        where: { id: postId },
        data: { status: 'maintenance' },
      });
      await this.audit.record(
        {
          type: 'audit:machine_repair_started',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: postId,
          oldValue: { status: 'broken' },
          newValue: { status: 'maintenance' },
          detail: { machineId: post.code },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Станок отремонтирован: broken|maintenance → active; открытые проблемы
   * machine_breakdown этого поста закрываются одним фактом ремонта.
   */
  async completeMachineRepair(actor: ProductionActor, postId: string, dto: { note?: string }) {
    const note = dto.note?.trim();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`);
      const post = await tx.post.findUnique({ where: { id: postId } });
      if (!post) throw new NotFoundException(`Post ${postId} not found`);
      if (!['broken', 'maintenance'].includes(post.status)) {
        throw new ConflictException(`Станок ${post.code} не в ремонте (${post.status})`);
      }
      const updated = await tx.post.update({ where: { id: postId }, data: { status: 'active' } });
      await tx.productionProblem.updateMany({
        where: { postId, type: 'machine_breakdown', status: 'open' },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedById: actor.userId,
          recovery: note || 'станок отремонтирован',
        },
      });
      await this.audit.record(
        {
          type: 'audit:machine_repaired',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: postId,
          oldValue: { status: post.status },
          newValue: { status: 'active' },
          reason: note || undefined,
          detail: { machineId: post.code },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Брак, зафиксированный завпроизводства при визуальном контроле (дизайн 2026-07-14).
   * Тот же конвейер, что у оператора/склада: DefectRecord + рулон в «Отложены» +
   * проблема defect (решается rework/writeoff).
   */
  async markRollDefect(actor: ProductionActor, rollCode: string, dto: { reason: string }) {
    if ((dto as { weightKg?: unknown }).weightKg !== undefined) {
      throw new BadRequestException({
        code: 'PRODUCTION_DEFECT_WEIGHT_IS_DEVICE_OWNED',
        message: 'Вес брака определяется только по сохранённому взвешиванию рулона.',
      });
    }
    const reason = dto.reason?.trim();
    if (!reason || reason.length > 1000) {
      throw new BadRequestException({
        code: 'PRODUCTION_DEFECT_REASON_INVALID',
        message: 'Укажите причину брака длиной от 1 до 1000 символов.',
      });
    }
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const item = await tx.rollDispatchItem.findUnique({
            where: { rollCode },
            include: {
              productionOrder: { select: { approvalState: true, commercialOrderId: true } },
            },
          });
          if (!item) throw new NotFoundException(`Roll ${rollCode} not found`);

          const line = await tx.operatorRollLine.findFirst({
            where: { rollDispatchItem: { rollCode } },
          });
          if (!line) {
            throw new ConflictException(
              `Рулон ${rollCode} еще не изготовлен — брак фиксируется по готовому рулону`,
            );
          }
          if (item.status === 'done' || !['not_ready', 'ready'].includes(line.warehouseState)) {
            throw new ConflictException({
              code: 'PRODUCTION_DEFECT_ROLL_STATE_INVALID',
              message: `Рулон ${rollCode} уже находится в терминальном складском состоянии.`,
            });
          }

          const existing = await tx.productionProblem.findFirst({
            where: { rollId: rollCode, type: 'defect', status: 'open' },
          });
          if (existing) {
            throw new ConflictException(`По рулону ${rollCode} уже открыта проблема брака`);
          }

          const captures = await tx.weightCapture.findMany({
            where: {
              operatorRollLineId: line.id,
              kind: 'roll',
              deviceId: { not: null },
              deviceStatus: 'ready',
              stable: true,
              grossKg: { gt: 0 },
              spoolKg: { gte: 0 },
              netKg: { not: null },
            },
            select: {
              id: true,
              operatorRollLineId: true,
              kind: true,
              deviceId: true,
              deviceStatus: true,
              stable: true,
              grossKg: true,
              spoolKg: true,
              netKg: true,
              postId: true,
              postSessionId: true,
              operationId: true,
              warehouseOperationId: true,
              operation: {
                select: {
                  id: true,
                  action: true,
                  status: true,
                  deviceId: true,
                  postId: true,
                  postSessionId: true,
                  resultRef: true,
                },
              },
              warehouseOperation: {
                select: {
                  id: true,
                  kind: true,
                  status: true,
                  taskId: true,
                  rollCode: true,
                  deviceId: true,
                  postId: true,
                  safeResult: true,
                },
              },
              supersedesCaptureId: true,
              createdAt: true,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          const evidence = resolveCanonicalRollCaptures(captures).find(
            (capture) => capture.operatorRollLineId === line.id,
          );
          if (
            !isDeviceBackedWeightEvidence(evidence, {
              source: 'operator',
              allowedActions: ['roll_weight', 'roll_reweigh'],
            })
          ) {
            throw new ConflictException({
              code: 'PRODUCTION_DEFECT_WEIGHT_EVIDENCE_REQUIRED',
              message: 'Нет однозначного стабильного взвешивания готового рулона.',
            });
          }

          const orderId = item.productionOrder?.commercialOrderId ?? null;
          const defect = await tx.defectRecord.create({
            data: {
              operatorRollLineId: line.id,
              weightCaptureId: evidence.id,
              sourceRole: actor.role,
              weightKg: evidence.netKg,
              comment: reason,
              blocking: true,
            },
          });
          await tx.operatorRollLine.update({
            where: { id: line.id },
            data: {
              warehouseState: 'not_ready',
              step: 'deferred',
              deferredFromStep: line.step === 'deferred' ? line.deferredFromStep : line.step,
            },
          });
          await tx.rollDispatchItem.update({
            where: { id: item.id },
            data: { status: 'deferred' },
          });
          const problem = await tx.productionProblem.create({
            data: {
              type: 'defect',
              orderId,
              rollId: rollCode,
              actorRole: actor.role,
              reason,
              defectRecordId: defect.id,
            },
          });

          await this.audit.record(
            {
              type: 'audit:defect_recorded',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: rollCode,
              reason,
              detail: {
                problemId: problem.id,
                defectId: defect.id,
                evidenceId: evidence.id,
                rollId: rollCode,
                weightKg: evidence.netKg,
                source: 'production_existing_scale',
              },
            },
            tx,
          );
          await this.audit.record(
            {
              type: 'problem:production_defect_reported',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId ?? rollCode,
              reason,
              oldValue: {
                dispatchStatus: item.status,
                operatorStep: line.step,
                warehouseState: line.warehouseState,
              },
              newValue: {
                dispatchStatus: 'deferred',
                operatorStep: 'deferred',
                warehouseState: 'not_ready',
                blocking: true,
              },
              detail: {
                problemId: problem.id,
                defectId: defect.id,
                evidenceId: evidence.id,
                rollId: rollCode,
                weightKg: evidence.netKg,
                source: 'production_visual_control',
              },
            },
            tx,
          );
          return problem;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        throw new ConflictException('Рулон изменился параллельно; повторите операцию');
      }
      throw error;
    }
  }

  /**
   * Hand a commercial order off to production (ТЗ §6): create the production order
   * and expand its positions into one RollDispatchItem per roll. Idempotent by the
   * commercial order (a заказ-наряд is created at most once). Triggered explicitly by
   * commercial "передать" or production_lead "создать и назначить".
   */
  async createFromCommercial(actor: ProductionActor, commercialOrderId: string) {
    const workflow = await this.prisma.commercialOrder.findUnique({
      where: { id: commercialOrderId },
      select: { warehouseCoverageWorkflowVersion: true, requestType: true },
    });
    if (!workflow) {
      throw new NotFoundException(`Commercial order ${commercialOrderId} not found`);
    }
    if (
      workflow.requestType !== 'stock_reserve' &&
      workflow.warehouseCoverageWorkflowVersion === 2
    ) {
      const result = await this.v2CoverageHandoff.createV2ProductionOrder(
        {
          userId: actor.userId,
          role: actor.role,
          capabilities: actor.capabilities ?? [],
        },
        commercialOrderId,
      );
      return this.getOrder(actor.role, result.productionOrderId);
    }
    if (workflow.warehouseCoverageWorkflowVersion !== 1) {
      throw new ConflictException('Unknown warehouse coverage workflow version');
    }

    let result:
      | {
          id: string;
          created: boolean;
          productionRequired: true;
          productionOrderId: string;
          orderNumber: string;
          rollCount: number;
        }
      | {
          commercialOrderId: string;
          created: false;
          productionRequired: false;
          productionOrderId: null;
          orderNumber: string;
          rollCount: 0;
        };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const commercial = await tx.commercialOrder.findUnique({
          where: { id: commercialOrderId },
          include: {
            positions: {
              include: COMMERCIAL_HANDOFF_POSITION_INCLUDE,
            },
            financeOrder: {
              select: {
                id: true,
                productionClearedAt: true,
                invoiceStatus: true,
                paymentTermsType: true,
                policy: {
                  select: {
                    id: true,
                    stages: { select: { id: true, trigger: true } },
                  },
                },
                schedules: {
                  where: { kind: { in: ['invoice_prepayment', 'post_delivery'] } },
                  select: { paymentPolicyStageId: true, kind: true, status: true },
                },
              },
            },
          },
        });
        if (!commercial) {
          throw new NotFoundException(`Commercial order ${commercialOrderId} not found`);
        }

        const existing = await tx.productionOrder.findUnique({ where: { commercialOrderId } });
        if (existing) {
          return {
            id: existing.id,
            created: false,
            productionRequired: true as const,
            productionOrderId: existing.id,
            orderNumber: commercial.orderNumber,
            rollCount: 0,
          };
        }
        const isStockProduction = commercial.requestType === 'stock_reserve';
        const isHandoffStage = ['sent_to_finance', 'in_work'].includes(commercial.commercialStage);
        if (!isHandoffStage) {
          throw new ConflictException('Order payment terms do not allow production handoff yet');
        }
        if (commercial.positions.length === 0) {
          throw new ConflictException('Order has no positions to hand off');
        }
        const positionStarts = new Map(
          commercial.positions.map((position) => [
            position.id,
            isStockProduction ? 1 : productionSequenceStart(commercialOrderId, position),
          ]),
        );
        const productionRollCount = commercial.positions.reduce((total, position) => {
          const sequenceStart = positionStarts.get(position.id)!;
          return total + Math.max(0, position.rollCount - sequenceStart + 1);
        }, 0);
        if (productionRollCount === 0) {
          return {
            commercialOrderId,
            productionRequired: false as const,
            productionOrderId: null,
            orderNumber: commercial.orderNumber,
            rollCount: 0,
            created: false,
          };
        }
        assertProductionDispatchItemCount(productionRollCount);
        if (!isStockProduction) {
          const capturedAt = commercial.financeOrder?.id
            ? await captureProductionClearance(
                tx,
                this.audit,
                actor,
                commercial.financeOrder.id,
                'Commercial order handoff to production.',
              )
            : null;
          if (!capturedAt && !financeAllowsProduction(commercial.financeOrder)) {
            throw new ConflictException('Order payment terms do not allow production handoff yet');
          }
        }

        const positionRecipes = new Map(
          commercial.positions.flatMap((position) => {
            const sequenceStart = positionStarts.get(position.id)!;
            const productionQty = Math.max(0, position.rollCount - sequenceStart + 1);
            return productionQty > 0
              ? [[position.id, productionRecipeSnapshot(position)] as const]
              : [];
          }),
        );
        const maxQueue = await tx.rollDispatchItem.aggregate({ _max: { queueRank: true } });
        const created = await tx.productionOrder.create({
          data: {
            commercialOrderId,
            indicator: 'needs_production',
            approvalState: 'pending',
          },
        });

        let number = 0;
        const baseRank = maxQueue._max.queueRank ?? 0;
        const rolls = commercial.positions.flatMap((position) => {
          const sequenceStart = positionStarts.get(position.id)!;
          const productionQty = Math.max(0, position.rollCount - sequenceStart + 1);
          const plannedWeightKg =
            recipeNumber(position.recipe, ['План. вес, кг']) ?? position.plannedWeightKg;
          const plannedLengthM =
            position.plannedLengthM ?? recipeNumber(position.recipe, ['Метраж, м', 'Длина, м']);
          const widthMm =
            position.widthMm ??
            recipeNumber(position.recipe, ['Ширина', 'Ширина, мм', 'Ширина (мм)', 'Размер, мм']);
          const materialRecipe = positionRecipes.get(position.id);
          if (!materialRecipe) return [];
          const snapshot = {
            filmType: position.filmType,
            actualThickness: position.actualThickness,
            accountingThickness: position.accountingThickness,
            rawMaterialId: materialRecipe.rawMaterialId,
            spoolType: position.spoolType,
            birka: position.birka,
            manualBirka: position.manualBirka,
            comment: position.comment,
            widthMm,
            plannedLengthM,
            requestType: commercial.requestType,
            stockBatchCode: commercial.stockBatchCode,
            recipeParameters: position.recipe?.parameters ?? [],
            ...(materialRecipe.recipe ? { recipe: materialRecipe.recipe } : {}),
          };
          return Array.from({ length: productionQty }, (_, productionIndex) => {
            number += 1;
            return {
              rollCode: `${commercial.orderNumber}-roll-${number}`,
              productionOrderId: created.id,
              orderLineId: position.id,
              positionSequence: sequenceStart + productionIndex,
              rawMaterialId: materialRecipe.rawMaterialId,
              recipeVersion: position.recipe?.version ?? null,
              filmType: position.filmType,
              plannedWeightKg,
              widthMm,
              plannedLengthM,
              characteristicsSnapshot: {
                ...snapshot,
                recipeVersion: position.recipe?.version ?? null,
              } as unknown as Prisma.InputJsonValue,
              status: 'new',
              queueRank: baseRank + number,
              priority: 0,
            };
          });
        });
        if (rolls.length > 0) await tx.rollDispatchItem.createMany({ data: rolls });
        await tx.commercialOrder.update({
          where: { id: commercialOrderId },
          data: { productionIndicator: 'needs_production' },
        });
        await this.audit.record(
          {
            type: 'audit:production_order_created',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: created.id,
            label: `Production order created from ${commercial.orderNumber} (${rolls.length} rolls)`,
            detail: {
              commercialOrderId,
              productionOrderId: created.id,
              orderNumber: commercial.orderNumber,
            },
          },
          tx,
        );
        return {
          id: created.id,
          created: true,
          productionRequired: true as const,
          productionOrderId: created.id,
          orderNumber: commercial.orderNumber,
          rollCount: rolls.length,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.productionOrder.findUnique({
          where: { commercialOrderId },
        });
        if (existing) return this.getOrder(actor.role, existing.id);
      }
      throw error;
    }

    if (!result.productionRequired) return result;
    return this.getOrder(actor.role, result.id);
  }

  async approve(actor: ProductionActor, orderId: string, transaction?: Prisma.TransactionClient) {
    const client = transaction ?? this.prisma;
    const order = await client.productionOrder.findUnique({
      where: { id: orderId },
      include: { dispatchItems: { orderBy: APPROVAL_DISPATCH_ORDER } },
    });
    if (!order) throw new NotFoundException(`Production order ${orderId} not found`);
    if (order.approvalState === 'approved') {
      return transaction ? undefined : this.getOrder(actor.role, orderId);
    }
    const approvalProblems: Array<{ rollId: string; reasons: string[] }> = [];
    const plannedAssignments = new Map<string, CurrentOperatorAssignment | null>();
    for (const roll of order.dispatchItems) {
      const reasons: string[] = [];
      if (!roll.assignedOperatorId) reasons.push('operator is not assigned');
      if (!roll.plannedShiftId) reasons.push('shift is not assigned');
      if (!roll.postId || !roll.machineId) reasons.push('machine is not assigned');
      if (roll.queueRank <= 0) reasons.push('queue rank is not assigned');
      if (roll.plannedWeightKg == null || roll.plannedWeightKg <= 0) {
        reasons.push('planned weight is not assigned');
      }
      if (roll.assignedOperatorId && roll.plannedShiftId) {
        const key = JSON.stringify([roll.plannedShiftId, roll.assignedOperatorId]);
        if (!plannedAssignments.has(key))
          plannedAssignments.set(
            key,
            await client.operatorShiftMachineAssignment.findFirst({
              where: {
                shiftId: roll.plannedShiftId,
                operatorId: roll.assignedOperatorId,
                status: { in: ACTIVE_OPERATOR_MACHINE_ASSIGNMENT_STATUSES },
              },
              include: CURRENT_OPERATOR_ASSIGNMENT_INCLUDE,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            }),
          );
        const assignment = plannedAssignments.get(key);
        if (!assignment) reasons.push('operator has no machine in the planned shift');
        else if (
          !this.isUsableOperatorMachineLifecycle(assignment.shift.status, assignment.status)
        ) {
          reasons.push('operator shift assignment lifecycle is not usable');
        } else if (
          assignment.postId !== roll.postId ||
          assignment.post.code !== roll.machineId ||
          assignment.post.status !== 'active'
        ) {
          reasons.push('roll machine does not match the operator shift assignment');
        }
      }
      if (reasons.length > 0) approvalProblems.push({ rollId: roll.rollCode, reasons });
    }
    if (order.dispatchItems.length === 0) {
      approvalProblems.push({ rollId: orderId, reasons: ['order has no rolls'] });
    }
    if (approvalProblems.length > 0) {
      throw new ConflictException({
        message: 'Production order plan is incomplete',
        approvalProblems,
      });
    }

    const publish = async (tx: Prisma.TransactionClient) => {
      const orderSnapshot = await tx.productionOrder.findUnique({
        where: { id: orderId },
        include: { dispatchItems: { orderBy: APPROVAL_DISPATCH_ORDER } },
      });
      if (!orderSnapshot) throw new NotFoundException(`Production order ${orderId} not found`);
      if (orderSnapshot.approvalState === 'approved') return;
      const assignmentSnapshots = [] as Array<{
        rollId: string;
        assignment: { id: string; shiftId: string; operatorId: string; postId: string };
      }>;
      const snapshotAssignments = new Map<string, CurrentOperatorAssignment | null>();
      for (const roll of orderSnapshot.dispatchItems) {
        if (
          !roll.assignedOperatorId ||
          !roll.plannedShiftId ||
          !roll.postId ||
          !roll.machineId ||
          roll.plannedWeightKg == null ||
          roll.plannedWeightKg <= 0
        ) {
          throw this.productionAssignmentLifecycleConflict(
            `Roll ${roll.rollCode} no longer has an operator shift assignment`,
          );
        }
        const key = JSON.stringify([roll.plannedShiftId, roll.assignedOperatorId]);
        if (!snapshotAssignments.has(key))
          snapshotAssignments.set(
            key,
            await tx.operatorShiftMachineAssignment.findFirst({
              where: {
                shiftId: roll.plannedShiftId,
                operatorId: roll.assignedOperatorId,
                status: { in: ACTIVE_OPERATOR_MACHINE_ASSIGNMENT_STATUSES },
              },
              include: CURRENT_OPERATOR_ASSIGNMENT_INCLUDE,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            }),
          );
        const assignmentSnapshot = snapshotAssignments.get(key);
        if (!assignmentSnapshot) {
          throw this.productionAssignmentLifecycleConflict(
            `Roll ${roll.rollCode} operator shift assignment is no longer usable`,
          );
        }
        assignmentSnapshots.push({ rollId: roll.id, assignment: assignmentSnapshot });
      }
      await this.lockProductionRollTopology(tx, {
        postIds: assignmentSnapshots.map(({ assignment }) => assignment.postId),
        shiftIds: assignmentSnapshots.map(({ assignment }) => assignment.shiftId),
        assignmentIds: assignmentSnapshots.map(({ assignment }) => assignment.id),
        productionOrderId: orderId,
        rollIds: orderSnapshot.dispatchItems.map((roll) => roll.id),
      });

      const currentOrder = await tx.productionOrder.findUnique({
        where: { id: orderId },
        include: { dispatchItems: { orderBy: APPROVAL_DISPATCH_ORDER } },
      });
      if (!currentOrder) throw new NotFoundException(`Production order ${orderId} not found`);
      if (currentOrder.approvalState === 'approved') return;
      const rollSnapshots = new Map(orderSnapshot.dispatchItems.map((roll) => [roll.id, roll]));
      if (currentOrder.dispatchItems.length !== orderSnapshot.dispatchItems.length) {
        throw this.productionAssignmentLifecycleConflict(
          'Production order roll plan changed before approval',
        );
      }
      for (const roll of currentOrder.dispatchItems) {
        const snapshot = rollSnapshots.get(roll.id);
        if (
          !snapshot ||
          roll.assignedOperatorId !== snapshot.assignedOperatorId ||
          roll.plannedShiftId !== snapshot.plannedShiftId ||
          roll.postId !== snapshot.postId ||
          roll.machineId !== snapshot.machineId ||
          roll.queueRank !== snapshot.queueRank ||
          roll.plannedWeightKg !== snapshot.plannedWeightKg ||
          roll.status !== snapshot.status
        ) {
          throw this.productionAssignmentLifecycleConflict(
            `Roll ${roll.rollCode} plan changed before approval`,
          );
        }
      }
      const assignmentSnapshotsByRoll = new Map(
        assignmentSnapshots.map(({ rollId, assignment }) => [rollId, assignment]),
      );
      // Re-read after locks; never reuse the pre-lock lifecycle snapshot.
      const lockedAssignments = new Map<string, CurrentOperatorAssignment | null>();
      for (const roll of currentOrder.dispatchItems) {
        const assignmentSnapshot = assignmentSnapshotsByRoll.get(roll.id);
        if (!assignmentSnapshot) {
          throw this.productionAssignmentLifecycleConflict(
            `Roll ${roll.rollCode} operator shift assignment is no longer usable`,
          );
        }
        if (!lockedAssignments.has(assignmentSnapshot.id))
          lockedAssignments.set(
            assignmentSnapshot.id,
            await tx.operatorShiftMachineAssignment.findUnique({
              where: { id: assignmentSnapshot.id },
              include: CURRENT_OPERATOR_ASSIGNMENT_INCLUDE,
            }),
          );
        const assignment = lockedAssignments.get(assignmentSnapshot.id);
        if (
          !assignment ||
          assignment.shiftId !== assignmentSnapshot.shiftId ||
          assignment.operatorId !== assignmentSnapshot.operatorId ||
          assignment.postId !== assignmentSnapshot.postId ||
          !this.isUsableOperatorMachineLifecycle(assignment.shift.status, assignment.status) ||
          assignment.postId !== roll.postId ||
          assignment.post.code !== roll.machineId ||
          assignment.post.status !== 'active'
        ) {
          throw this.productionAssignmentLifecycleConflict(
            `Roll ${roll.rollCode} operator shift assignment is no longer usable`,
          );
        }
      }
      const claimed = await tx.productionOrder.updateMany({
        where: { id: orderId, approvalState: 'pending' },
        data: {
          approvalState: 'approved',
          indicator: 'in_production',
          assignedOwnerId: actor.userId,
        },
      });
      if (claimed.count !== 1) return;
      await tx.commercialOrder.update({
        where: { id: currentOrder.commercialOrderId },
        data: { productionIndicator: 'in_production' },
      });
      const previouslyPublished = new Set(
        (
          await tx.operatorRollLine.findMany({
            where: {
              rollDispatchItemId: {
                in: currentOrder.dispatchItems.map((roll) => roll.id),
              },
            },
            select: { rollDispatchItemId: true },
          })
        ).map(({ rollDispatchItemId }) => rollDispatchItemId),
      );
      await tx.rollDispatchItem.updateMany({
        where: { productionOrderId: orderId, status: 'new' },
        data: { status: 'assigned' },
      });
      await tx.operatorRollLine.createMany({
        data: currentOrder.dispatchItems.map((roll, index) => ({
          rollDispatchItemId: roll.id,
          sequence: index + 1,
          ...(roll.plannedWeightKg == null ? {} : { planKg: roll.plannedWeightKg }),
          step: 'assigned',
        })),
        skipDuplicates: true,
      });
      await this.audit.record(
        {
          type: 'audit:production_order_approved',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          oldValue: {
            approvalState: currentOrder.approvalState,
            indicator: currentOrder.indicator,
          },
          newValue: { approvalState: 'approved', indicator: 'in_production' },
          detail: {
            commercialOrderId: currentOrder.commercialOrderId,
            productionOrderId: orderId,
          },
        },
        tx,
      );
      for (const roll of currentOrder.dispatchItems) {
        if (previouslyPublished.has(roll.id)) continue;
        await this.audit.record(
          {
            type: 'audit:task_assigned',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: roll.rollCode,
            detail: {
              commercialOrderId: currentOrder.commercialOrderId,
              operatorId: roll.assignedOperatorId!,
              rollId: roll.rollCode,
              productionOrderId: orderId,
            },
          },
          tx,
        );
      }
    };
    if (transaction) {
      await publish(transaction);
      return;
    }
    await this.prisma.$transaction(publish);

    return this.getOrder(actor.role, orderId);
  }

  /** Проблемы производственного контура (брак, поломки, баланс смены, сырьё) для завпроизводства. */
  async listProblems(query: ProductionProblemQueryDto = {}) {
    if (query.status !== undefined && !isProductionProblemStatus(query.status)) {
      throw new BadRequestException({
        code: 'PRODUCTION_PROBLEM_STATUS_INVALID',
        message: 'Неизвестный статус производственной проблемы.',
      });
    }
    if (query.type !== undefined && !isProductionProblemType(query.type)) {
      throw new BadRequestException({
        code: 'PRODUCTION_PROBLEM_TYPE_INVALID',
        message: 'Неизвестный тип производственной проблемы.',
      });
    }
    const problems = await this.prisma.productionProblem.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_PRODUCTION_PROBLEM_ROWS + 1,
      select: {
        id: true,
        type: true,
        status: true,
        orderId: true,
        positionId: true,
        rollId: true,
        actorRole: true,
        reason: true,
        recovery: true,
        createdAt: true,
        resolvedAt: true,
        postId: true,
        post: { select: { id: true, code: true, name: true, status: true } },
        order: { select: { id: true, orderNumber: true } },
        defectRecord: {
          select: {
            id: true,
            operatorRollLineId: true,
            sourceRole: true,
            line: {
              select: {
                rollDispatchItem: { select: { rollCode: true } },
              },
            },
            weightCapture: {
              select: {
                id: true,
                operatorRollLineId: true,
                kind: true,
                deviceId: true,
                deviceStatus: true,
                stable: true,
                grossKg: true,
                spoolKg: true,
                netKg: true,
                postId: true,
                postSessionId: true,
                operationId: true,
                warehouseOperationId: true,
                operation: {
                  select: {
                    id: true,
                    action: true,
                    status: true,
                    deviceId: true,
                    postId: true,
                    postSessionId: true,
                    resultRef: true,
                  },
                },
                warehouseOperation: {
                  select: {
                    id: true,
                    kind: true,
                    status: true,
                    taskId: true,
                    rollCode: true,
                    deviceId: true,
                    postId: true,
                    safeResult: true,
                  },
                },
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (problems.length > MAX_PRODUCTION_PROBLEM_ROWS) {
      throw new UnprocessableEntityException({
        code: 'PRODUCTION_PROBLEM_CATALOG_TOO_LARGE',
        message: 'Очередь производственных проблем превышает безопасный размер ответа.',
      });
    }
    return problems.map(({ defectRecord, ...problem }) => {
      const capture = defectRecord?.weightCapture ?? null;
      const expectedKind = defectRecord?.sourceRole === 'warehouse' ? 'control' : 'roll';
      const hasDurableProvenance =
        defectRecord?.sourceRole === 'warehouse'
          ? isDeviceBackedWeightEvidence(capture, {
              source: 'warehouse',
              expectedRollCode: problem.rollId ?? '',
            })
          : defectRecord?.sourceRole === 'operator'
            ? isDeviceBackedWeightEvidence(capture, {
                source: 'operator',
                allowedActions: ['defect'],
                defectRecordId: defectRecord.id,
              })
            : defectRecord?.sourceRole === 'production_lead'
              ? isDeviceBackedWeightEvidence(capture, {
                  source: 'operator',
                  allowedActions: ['roll_weight', 'roll_reweigh'],
                })
              : false;
      const hasExactRollIdentity =
        Boolean(problem.rollId) &&
        defectRecord?.line.rollDispatchItem.rollCode === problem.rollId &&
        capture?.operatorRollLineId === defectRecord?.operatorRollLineId;
      const hasVerifiedEvidence =
        defectRecord?.sourceRole === problem.actorRole &&
        capture?.kind === expectedKind &&
        hasExactRollIdentity &&
        hasDurableProvenance;
      const defectWeightSource =
        problem.type !== 'defect'
          ? null
          : !hasVerifiedEvidence
            ? 'legacy_unverified'
            : capture.kind === 'control'
              ? 'warehouse_control_scale'
              : defectRecord?.sourceRole === 'production_lead'
                ? 'production_existing_scale'
                : 'operator_scale';
      return {
        ...problem,
        defectWeightKg:
          problem.type === 'defect' ? (hasVerifiedEvidence ? capture!.netKg : null) : null,
        defectWeightCapturedAt:
          problem.type === 'defect' && hasVerifiedEvidence ? capture!.createdAt : null,
        defectWeightSource,
      };
    });
  }

  async reportProblem(actor: ProductionActor, productionOrderId: string, dto: ReportProblemDto) {
    const po = await this.prisma.productionOrder.findUnique({ where: { id: productionOrderId } });
    if (!po) throw new NotFoundException(`Production order ${productionOrderId} not found`);
    const commercialOrderId = po.commercialOrderId;
    const problem = await this.prisma.productionProblem.create({
      data: {
        orderId: commercialOrderId,
        positionId: dto.positionId,
        rollId: dto.rollId,
        actorRole: actor.role,
        reason: dto.reason,
        recovery: dto.recovery,
      },
    });
    await this.audit.record({
      type: 'problem:production_reported_to_commercial',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: commercialOrderId,
      reason: dto.reason,
      detail: {
        problemId: problem.id,
        positionId: dto.positionId ?? null,
        rollId: dto.rollId ?? null,
      },
    });
    await this.audit.record({
      type: 'notification:commercial_problem_received',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: commercialOrderId,
      label: 'Production reported a problem to commercial',
    });
    return problem;
  }

  /**
   * Замещающий рулон (design 2026-07-13 §8–9): клон параметров исходного dispatch-рулона
   * с новым кодом `<roll>-R<n>`, статус `new`, без оператора — завпроизводства назначает
   * его штатной диспетчеризацией. Если заказ уже утверждён, сразу создаётся и
   * операторская строка (как это делает approve для остальных рулонов).
   */
  async createReplacementRoll(
    actor: ProductionActor,
    sourceRollCode: string,
    reason: string,
    client?: ReplacementClient,
  ): Promise<RollDispatchItem> {
    if (!client) {
      return this.prisma.$transaction(
        (tx) => this.createReplacementRoll(actor, sourceRollCode, reason, tx),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    }
    const locatedSource = await client.rollDispatchItem.findUnique({
      where: { rollCode: sourceRollCode },
      select: { productionOrderId: true },
    });
    if (!locatedSource) throw new NotFoundException(`Roll ${sourceRollCode} not found`);
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "production_orders" WHERE "id" = ${locatedSource.productionOrderId} FOR UPDATE`,
    );
    const source = await client.rollDispatchItem.findUnique({
      where: { rollCode: sourceRollCode },
      include: { productionOrder: true, replacementAttempt: true },
    });
    if (!source) throw new NotFoundException(`Roll ${sourceRollCode} not found`);
    if (source.productionOrderId !== locatedSource.productionOrderId) {
      throw new ConflictException(
        'Roll production order changed concurrently; retry the operation',
      );
    }
    if (source.replacementAttempt) return source.replacementAttempt;
    await client.productionOrder.update({
      where: { id: source.productionOrderId },
      data: { updatedAt: new Date() },
    });
    let rollCode = '';
    for (let n = 1; n < 50; n += 1) {
      const candidate = `${sourceRollCode}-R${n}`;
      const exists = await client.rollDispatchItem.findUnique({
        where: { rollCode: candidate },
      });
      if (!exists) {
        rollCode = candidate;
        break;
      }
    }
    if (!rollCode) rollCode = `${sourceRollCode}-R${Date.now()}`;
    const maxQueue = await client.rollDispatchItem.aggregate({ _max: { queueRank: true } });
    const queueRank = (maxQueue._max.queueRank ?? 0) + 1;
    const replacement = await client.rollDispatchItem.create({
      data: {
        rollCode,
        productionOrderId: source.productionOrderId,
        replacesDispatchItemId: source.id,
        orderLineId: source.orderLineId,
        positionSequence: source.positionSequence,
        rawMaterialId: source.rawMaterialId,
        recipeVersion: source.recipeVersion,
        filmType: source.filmType,
        plannedWeightKg: source.plannedWeightKg,
        plannedLengthM: source.plannedLengthM,
        characteristicsSnapshot: source.characteristicsSnapshot ?? Prisma.JsonNull,
        queueRank,
        status: 'new',
      },
    });
    if (source.productionOrder?.approvalState === 'approved') {
      const sequence =
        (await client.operatorRollLine.count({
          where: { rollDispatchItem: { productionOrderId: source.productionOrderId } },
        })) + 1;
      await client.operatorRollLine.create({
        data: {
          rollDispatchItemId: replacement.id,
          sequence,
          ...(source.plannedWeightKg == null ? {} : { planKg: source.plannedWeightKg }),
          step: 'assigned',
        },
      });
    }
    await this.audit.record(
      {
        type: 'audit:replacement_roll_created',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: rollCode,
        reason,
        detail: {
          rollId: rollCode,
          sourceRollCode,
          productionOrderId: source.productionOrderId,
        },
      },
      client,
    );
    return replacement;
  }

  /**
   * Решение завпроизводства по проблеме брака (design 2026-07-13 §8):
   * rework — замещающий рулон + списание, writeoff — только списание. Для любого
   * источника брака вторсырьё приходуется ровно один раз здесь, после решения.
   */
  async resolveProblem(
    actor: ProductionActor,
    problemId: string,
    dto: {
      resolution: 'rework' | 'writeoff' | 'confirm' | 'reject' | 'close';
      note?: string;
    },
  ) {
    if ((dto as { weightKg?: unknown }).weightKg !== undefined) {
      throw new BadRequestException({
        code: 'PRODUCTION_DEFECT_WEIGHT_IS_DEVICE_OWNED',
        message: 'Вес брака определяется только по связанному взвешиванию.',
      });
    }
    const problem = await this.prisma.productionProblem.findUnique({ where: { id: problemId } });
    if (!problem) throw new NotFoundException(`Problem ${problemId} not found`);
    if (dto.resolution === 'close') {
      const problemType = problem.type;
      if (!isManuallyClosableProblemType(problemType)) {
        throw new ConflictException(`Решение close неприменимо к типу проблемы ${problem.type}.`);
      }
      if (problemType === 'general' && problem.positionId && problem.rollId) {
        throw new ConflictException(
          'Проблема связана с позицией и рулоном: требуется атомарная корректировка коммерции.',
        );
      }
      const note = dto.note?.trim();
      if (!note || note.length > 1000) {
        throw new BadRequestException({
          code: 'PRODUCTION_PROBLEM_RESOLUTION_NOTE_REQUIRED',
          message: 'Для закрытия проблемы укажите итог длиной от 1 до 1000 символов.',
        });
      }
      return this.closeProductionProblem(actor, problem, problemType, note);
    }
    if (problem.status === 'resolved') {
      throw new ConflictException('Проблема уже решена.');
    }
    if (dto.resolution === 'confirm' || dto.resolution === 'reject') {
      if (problem.type !== 'machine_breakdown') {
        throw new ConflictException(
          `Решение confirm/reject применимо только к поломке станка (тип: ${problem.type}).`,
        );
      }
      return this.resolveMachineBreakdownProblem(actor, problem, dto.resolution, dto.note);
    }
    if (problem.type !== 'defect') {
      throw new ConflictException(
        `Решение rework/writeoff применимо только к браку (тип проблемы: ${problem.type}).`,
      );
    }
    const note = dto.note?.trim();
    if (!note || note.length > 1000) {
      throw new BadRequestException({
        code: 'PRODUCTION_DEFECT_RESOLUTION_NOTE_REQUIRED',
        message: 'Для решения по браку укажите комментарий длиной от 1 до 1000 символов.',
      });
    }
    const resolution = dto.resolution;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "production_problems" WHERE "id" = ${problemId} FOR UPDATE`,
          );
          const locked = await tx.productionProblem.findUnique({
            where: { id: problemId },
            include: {
              defectRecord: {
                include: {
                  weightCapture: {
                    include: {
                      operation: {
                        select: {
                          id: true,
                          action: true,
                          status: true,
                          deviceId: true,
                          postId: true,
                          postSessionId: true,
                          resultRef: true,
                        },
                      },
                      warehouseOperation: {
                        select: {
                          id: true,
                          kind: true,
                          status: true,
                          taskId: true,
                          rollCode: true,
                          deviceId: true,
                          postId: true,
                          safeResult: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          });
          if (!locked) throw new NotFoundException(`Problem ${problemId} not found`);
          if (locked.status !== 'open') throw new ConflictException('Проблема уже решена.');
          if (locked.type !== 'defect' || !locked.rollId) {
            throw new ConflictException({
              code: 'PRODUCTION_DEFECT_EVIDENCE_UNVERIFIED',
              message: 'Проблема брака не связана с конкретным рулоном.',
            });
          }
          const evidence = locked.defectRecord?.weightCapture ?? null;
          const expectedKind = locked.actorRole === 'warehouse' ? 'control' : 'roll';
          const hasDurableProvenance =
            locked.actorRole === 'warehouse'
              ? isDeviceBackedWeightEvidence(evidence, {
                  source: 'warehouse',
                  expectedRollCode: locked.rollId,
                })
              : locked.actorRole === 'operator'
                ? isDeviceBackedWeightEvidence(evidence, {
                    source: 'operator',
                    allowedActions: ['defect'],
                    defectRecordId: locked.defectRecord?.id,
                  })
                : locked.actorRole === 'production_lead'
                  ? isDeviceBackedWeightEvidence(evidence, {
                      source: 'operator',
                      allowedActions: ['roll_weight', 'roll_reweigh'],
                    })
                  : false;
          if (
            !locked.defectRecord ||
            locked.defectRecord.sourceRole !== locked.actorRole ||
            evidence?.kind !== expectedKind ||
            !hasDurableProvenance
          ) {
            throw new ConflictException({
              code: 'PRODUCTION_DEFECT_EVIDENCE_UNVERIFIED',
              message: 'Связанное стабильное взвешивание брака отсутствует.',
            });
          }
          const line = await tx.operatorRollLine.findFirst({
            where: { rollDispatchItem: { rollCode: locked.rollId } },
            include: { rollDispatchItem: true },
          });
          if (
            !line ||
            evidence.operatorRollLineId !== line.id ||
            locked.defectRecord.operatorRollLineId !== line.id
          ) {
            throw new ConflictException({
              code: 'PRODUCTION_DEFECT_EVIDENCE_UNVERIFIED',
              message: 'Весовое доказательство не относится к проблемному рулону.',
            });
          }

          let replacementRollCode: string | null = null;
          if (resolution === 'rework') {
            const replacement = await this.createReplacementRoll(actor, locked.rollId, note, tx);
            replacementRollCode = replacement.rollCode;
          }
          await tx.rollDispatchItem.update({
            where: { id: line.rollDispatchItem.id },
            data: { status: 'defect', completedAt: new Date() },
          });
          await this.spoolStock.returnDefectSpool(actor, locked.defectRecord.id, tx);

          const material = line.rollDispatchItem.rawMaterialId
            ? await tx.rawMaterialStock.findUnique({
                where: { materialId: line.rollDispatchItem.rawMaterialId },
              })
            : null;
          await recycleDefectToSecondaryStock(tx, this.audit, actor, {
            rawMaterialId: line.rollDispatchItem.rawMaterialId,
            materialLabel: material?.label ?? null,
            kg: evidence.netKg!,
            rollCode: locked.rollId,
            problemId,
            resolution,
            note,
          });
          await this.audit.record(
            {
              type:
                resolution === 'rework'
                  ? 'audit:defect_resolved_rework'
                  : 'audit:defect_resolved_writeoff',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: locked.orderId,
              reason: note,
              detail: {
                problemId,
                defectId: locked.defectRecord.id,
                evidenceId: evidence.id,
                rollId: locked.rollId,
                replacementRollCode,
                recycledKg: evidence.netKg,
                sourceReason: locked.reason,
                note,
              },
            },
            tx,
          );
          const resolvedAt = new Date();
          const claimed = await tx.productionProblem.updateMany({
            where: { id: problemId, status: 'open' },
            data: { status: 'resolved', resolvedAt, resolvedById: actor.userId },
          });
          if (claimed.count !== 1) throw new ConflictException('Проблема уже решена.');
          return {
            id: locked.id,
            type: locked.type,
            status: 'resolved',
            orderId: locked.orderId,
            positionId: locked.positionId,
            rollId: locked.rollId,
            actorRole: locked.actorRole,
            reason: locked.reason,
            recovery: locked.recovery,
            createdAt: locked.createdAt,
            resolvedAt,
            postId: locked.postId,
            defectWeightKg: evidence.netKg,
            defectWeightCapturedAt: evidence.createdAt,
            defectWeightSource:
              evidence.kind === 'control'
                ? ('warehouse_control_scale' as const)
                : locked.actorRole === 'production_lead'
                  ? ('production_existing_scale' as const)
                  : ('operator_scale' as const),
            replacementRollCode,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializableWriteConflict(error) || isRawMaterialRecyclingConflict(error)) {
        throw new ConflictException('Проблема изменилась параллельно; повторите операцию.');
      }
      throw error;
    }
  }

  private async closeProductionProblem(
    actor: ProductionActor,
    problem: ProductionProblem,
    problemType: ManuallyClosableProblemType,
    note: string,
  ): Promise<ProductionProblem> {
    return this.prisma.$transaction(async (tx) => {
      const resolvedAt = new Date();
      const claimed = await tx.productionProblem.updateMany({
        where: { id: problem.id, type: problemType, status: 'open' },
        data: {
          status: 'resolved',
          recovery: note,
          resolvedAt,
          resolvedById: actor.userId,
        },
      });
      const current = await tx.productionProblem.findUnique({ where: { id: problem.id } });
      if (!current) throw new NotFoundException(`Problem ${problem.id} not found`);
      if (claimed.count === 0) {
        if (
          current.type === problemType &&
          current.status === 'resolved' &&
          current.recovery === note
        ) {
          return current;
        }
        throw new ConflictException('Проблема изменилась до закрытия.');
      }
      await this.audit.record(
        {
          type: 'audit:production_problem_resolved',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: problem.id,
          reason: note,
          oldValue: { status: 'open', recovery: problem.recovery },
          newValue: { status: 'resolved', recovery: note },
          detail: {
            problemId: problem.id,
            problemType,
            orderId: problem.orderId,
            positionId: problem.positionId,
            rollId: problem.rollId,
            sourceReason: problem.reason,
          },
        },
        tx,
      );
      return current;
    });
  }

  // --- Roll dispatch (the post-26.06 core, ТЗ §5.2) -------------------------

  listDispatch(filter: {
    date?: string;
    operatorId?: string;
    scope?: 'active' | 'archive';
    dateFrom?: string;
    dateTo?: string;
  }) {
    const usesExactDate = filter.date !== undefined;
    const usesRange = filter.dateFrom !== undefined || filter.dateTo !== undefined;
    if (usesExactDate && usesRange) {
      throw new BadRequestException('Use either date or dateFrom/dateTo, not both.');
    }
    const parsedFrom =
      filter.dateFrom !== undefined
        ? this.parseDispatchDate(filter.dateFrom, false)
        : filter.date !== undefined
          ? this.parseDispatchDate(filter.date, false)
          : undefined;
    const parsedTo =
      filter.dateTo !== undefined
        ? this.parseDispatchDate(filter.dateTo, true)
        : filter.date !== undefined
          ? this.parseDispatchDate(filter.date, true)
          : undefined;
    if (usesRange && (!filter.dateFrom || !filter.dateTo)) {
      throw new BadRequestException('Both dateFrom and dateTo are required for a date range.');
    }
    if (filter.scope === 'archive' && !usesExactDate && !usesRange) {
      throw new BadRequestException('Archive scope requires a bounded date window.');
    }

    const where: Prisma.RollDispatchItemWhereInput = {};
    if (filter.operatorId) where.assignedOperatorId = filter.operatorId;
    if (filter.scope === 'archive') where.status = 'done';
    if (filter.scope === 'active') where.status = { not: 'done' };
    const from = filter.dateFrom ?? filter.date;
    const to = filter.dateTo ?? filter.date;
    if (from || to) {
      const lowerBound = parsedFrom!;
      const upperBound = parsedTo!;
      if (lowerBound >= upperBound) {
        throw new BadRequestException('dateFrom must not be later than dateTo.');
      }
      if (
        filter.scope === 'archive' &&
        (upperBound.getTime() - lowerBound.getTime()) / 86_400_000 > MAX_DISPATCH_ARCHIVE_DAYS
      ) {
        throw new BadRequestException(
          `Archive date window must not exceed ${MAX_DISPATCH_ARCHIVE_DAYS} days.`,
        );
      }
      const completedAt: Prisma.DateTimeNullableFilter = {};
      completedAt.gte = lowerBound;
      completedAt.lt = upperBound;
      where.completedAt = completedAt;
    }
    return this.prisma.rollDispatchItem
      .findMany({
        where,
        include: {
          assignedOperator: { select: { id: true, displayName: true } },
          post: { select: { id: true, code: true, name: true, status: true } },
          productionOrder: {
            select: {
              id: true,
              approvalState: true,
              commercialOrder: {
                select: {
                  id: true,
                  orderNumber: true,
                  counterparty: { select: { id: true, displayName: true } },
                },
              },
            },
          },
        },
        orderBy: [{ queueRank: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_DISPATCH_ROWS + 1,
      })
      .then((items) => {
        if (items.length > MAX_DISPATCH_ROWS) {
          throw new UnprocessableEntityException({
            code: 'PRODUCTION_DISPATCH_RESULT_TOO_LARGE',
            message: 'Слишком много рулонов. Уточните период или оператора.',
          });
        }
        return items;
      });
  }

  async getSummary() {
    const [items, problems] = await Promise.all([
      this.prisma.rollDispatchItem.findMany({
        select: {
          productionOrderId: true,
          assignedOperatorId: true,
          postId: true,
          plannedShiftId: true,
          plannedWeightKg: true,
          plannedLengthM: true,
          status: true,
        },
      }),
      this.prisma.productionProblem.count({ where: { status: 'open' } }),
    ]);
    let plannedWeightKg = 0;
    let plannedLengthM = 0;
    let missingWeightRolls = 0;
    let missingLengthRolls = 0;
    let unassignedRolls = 0;
    const orders = new Set<string>();
    const operators = new Set<string>();
    for (const item of items) {
      orders.add(item.productionOrderId);
      if (item.assignedOperatorId) operators.add(item.assignedOperatorId);
      if (!item.assignedOperatorId || !item.postId || !item.plannedShiftId) unassignedRolls += 1;
      if (item.plannedWeightKg == null) missingWeightRolls += 1;
      else plannedWeightKg += item.plannedWeightKg;
      if (item.plannedLengthM == null) missingLengthRolls += 1;
      else plannedLengthM += item.plannedLengthM;
    }
    return {
      orders: orders.size,
      rolls: items.length,
      problems,
      operators: operators.size,
      unassignedRolls,
      plannedWeightKg: Number(plannedWeightKg.toFixed(3)),
      plannedLengthM: Number(plannedLengthM.toFixed(3)),
      missingWeightRolls,
      missingLengthRolls,
    };
  }

  async assignRoll(actor: ProductionActor, rollCode: string, dto: AssignRollDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockProductionOperators(tx, [dto.operatorId]);
      const itemSnapshot = await this.requireRoll(rollCode, tx);
      if (
        itemSnapshot.assignedOperatorId !== dto.operatorId &&
        ASSIGNMENT_LOCKED_ROLL_STATUSES.has(itemSnapshot.status)
      ) {
        throw new ConflictException(`Roll ${rollCode} can no longer be reassigned`);
      }
      const topologySnapshot = await this.resolveCurrentOperatorMachine(dto.operatorId, tx);
      await this.lockProductionRollTopology(tx, {
        postIds: topologySnapshot.assignment ? [topologySnapshot.assignment.post.id] : [],
        shiftIds: topologySnapshot.assignment ? [topologySnapshot.assignment.shift.id] : [],
        assignmentIds: topologySnapshot.assignment ? [topologySnapshot.assignment.id] : [],
        productionOrderId: itemSnapshot.productionOrderId,
        rollIds: [itemSnapshot.id],
      });
      const currentTopology = await this.resolveCurrentOperatorMachine(dto.operatorId, tx);
      if (
        !this.sameCurrentOperatorAssignment(topologySnapshot.assignment, currentTopology.assignment)
      ) {
        throw this.productionAssignmentTopologyChanged(dto.operatorId);
      }
      const item = await this.requireRoll(rollCode, tx);
      if (
        item.id !== itemSnapshot.id ||
        item.productionOrderId !== itemSnapshot.productionOrderId
      ) {
        throw new ConflictException({
          code: 'PRODUCTION_ASSIGNMENT_STALE',
          message: 'Назначение рулона уже изменено другим запросом. Обновите очередь.',
        });
      }
      if (
        item.assignedOperatorId !== dto.operatorId &&
        ASSIGNMENT_LOCKED_ROLL_STATUSES.has(item.status)
      ) {
        throw new ConflictException(`Roll ${rollCode} can no longer be reassigned`);
      }
      const topology = this.operatorTopology(currentTopology.assignment);
      const reassigned = !!item.assignedOperatorId && item.assignedOperatorId !== dto.operatorId;
      const published = item.productionOrder?.approvalState === 'approved' || item.status !== 'new';
      const status = assignmentTargetStatus(item);
      const assignmentMatches = (current: typeof item) =>
        current.assignedOperatorId === dto.operatorId &&
        current.plannedShiftId === topology.plannedShiftId &&
        current.machineId === topology.machineId &&
        current.postId === topology.postId &&
        current.workplaceId === topology.workplaceId;
      const publishAndRead = async () => {
        await this.publishProductionOrderWhenReady(actor, item.productionOrderId, {
          transaction: tx,
        });
        const updated = await this.requireRoll(rollCode, tx);
        const { productionOrder, ...publishedResult } = updated;
        void productionOrder;
        return publishedResult;
      };
      if (ASSIGNMENT_LOCKED_ROLL_STATUSES.has(item.status)) {
        if (!assignmentMatches(item)) {
          throw new ConflictException(`Roll ${rollCode} can no longer be reassigned`);
        }
        return publishAndRead();
      }
      const targetMatches = (current: typeof item) =>
        assignmentMatches(current) && current.status === status;

      if (targetMatches(item)) {
        return publishAndRead();
      }
      const claimed = await tx.rollDispatchItem.updateMany({
        where: {
          id: item.id,
          assignedOperatorId: item.assignedOperatorId,
          plannedShiftId: item.plannedShiftId,
          machineId: item.machineId,
          postId: item.postId,
          workplaceId: item.workplaceId,
          status: item.status,
        },
        data: {
          assignedOperatorId: dto.operatorId,
          ...topology,
          status,
        },
      });
      if (claimed.count !== 1) {
        const winner = await this.requireRoll(rollCode, tx);
        if (targetMatches(winner)) {
          return publishAndRead();
        }
        throw new ConflictException({
          code: 'PRODUCTION_ASSIGNMENT_STALE',
          message: 'Назначение рулона уже изменено другим запросом. Обновите очередь.',
        });
      }

      await this.audit.record(
        {
          type: 'audit:roll_dispatch_assigned',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: rollCode,
          oldValue: { assignedOperatorId: item.assignedOperatorId },
          newValue: { assignedOperatorId: dto.operatorId },
          detail: {
            ...(item.productionOrder?.commercialOrderId
              ? { commercialOrderId: item.productionOrder.commercialOrderId }
              : {}),
            operatorId: dto.operatorId,
            ...(topology.plannedShiftId ? { shiftId: topology.plannedShiftId } : {}),
            rollId: rollCode,
            productionOrderId: item.productionOrderId,
          },
        },
        tx,
      );
      if (published) {
        await this.audit.record(
          {
            type: reassigned ? 'audit:task_reassigned' : 'audit:task_assigned',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: rollCode,
            detail: {
              ...(item.productionOrder?.commercialOrderId
                ? { commercialOrderId: item.productionOrder.commercialOrderId }
                : {}),
              operatorId: dto.operatorId,
              ...(reassigned ? { previousOperatorId: item.assignedOperatorId! } : {}),
              ...(topology.plannedShiftId ? { shiftId: topology.plannedShiftId } : {}),
              rollId: rollCode,
              productionOrderId: item.productionOrderId,
            },
          },
          tx,
        );
      }
      return publishAndRead();
    });
    return result;
  }

  async bulkAssign(actor: ProductionActor, dto: BulkAssignDto) {
    const result = await this.batchUpdate(actor, {
      changes: dto.rollIds.map((rollId) => ({
        rollId,
        operatorId: dto.operatorId,
      })),
    });
    return { assigned: result.updated, operatorId: dto.operatorId };
  }

  async batchUpdate(actor: ProductionActor, dto: BatchUpdateDispatchDto) {
    const rollIds = dto.changes.map((change) => change.rollId);
    if (new Set(rollIds).size !== rollIds.length) {
      throw new ConflictException('Each roll may appear only once in a batch update');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const operatorIds = [...new Set(dto.changes.map(({ operatorId }) => operatorId))].sort();
      await this.lockProductionOperators(tx, operatorIds);
      const loadItems = () =>
        tx.rollDispatchItem.findMany({
          where: { rollCode: { in: rollIds } },
          include: {
            productionOrder: { select: { approvalState: true, commercialOrderId: true } },
            operatorLine: { select: { step: true } },
          },
        });
      const itemSnapshots = await loadItems();
      const snapshotsByCode = new Map(itemSnapshots.map((item) => [item.rollCode, item]));
      if (itemSnapshots.length !== rollIds.length) {
        const missing = rollIds.filter((rollId) => !snapshotsByCode.has(rollId));
        throw new NotFoundException(`Rolls not found: ${missing.join(', ')}`);
      }
      for (const change of dto.changes) {
        const item = snapshotsByCode.get(change.rollId)!;
        if (
          item.assignedOperatorId !== change.operatorId &&
          ASSIGNMENT_LOCKED_ROLL_STATUSES.has(item.status)
        ) {
          throw new ConflictException(`Roll ${change.rollId} can no longer be reassigned`);
        }
      }
      const topologySnapshots = new Map<
        string,
        Awaited<ReturnType<ProductionService['resolveCurrentOperatorMachine']>>
      >();
      for (const operatorId of operatorIds) {
        topologySnapshots.set(operatorId, await this.resolveCurrentOperatorMachine(operatorId, tx));
      }
      await this.lockProductionRollTopology(tx, {
        postIds: [...topologySnapshots.values()].flatMap(({ assignment }) =>
          assignment ? [assignment.post.id] : [],
        ),
        shiftIds: [...topologySnapshots.values()].flatMap(({ assignment }) =>
          assignment ? [assignment.shift.id] : [],
        ),
        assignmentIds: [...topologySnapshots.values()].flatMap(({ assignment }) =>
          assignment ? [assignment.id] : [],
        ),
        productionOrderIds: itemSnapshots.map(({ productionOrderId }) => productionOrderId),
        rollIds: itemSnapshots.map(({ id }) => id),
      });
      const currentByOperator = new Map<
        string,
        Awaited<ReturnType<ProductionService['resolveCurrentOperatorMachine']>>
      >();
      for (const operatorId of operatorIds) {
        const current = await this.resolveCurrentOperatorMachine(operatorId, tx);
        if (
          !this.sameCurrentOperatorAssignment(
            topologySnapshots.get(operatorId)!.assignment,
            current.assignment,
          )
        ) {
          throw this.productionAssignmentTopologyChanged(operatorId);
        }
        currentByOperator.set(operatorId, current);
      }
      const items = await loadItems();
      const byCode = new Map(items.map((item) => [item.rollCode, item]));
      if (
        items.length !== rollIds.length ||
        itemSnapshots.some((snapshot) => {
          const current = byCode.get(snapshot.rollCode);
          return (
            !current ||
            current.id !== snapshot.id ||
            current.productionOrderId !== snapshot.productionOrderId
          );
        })
      ) {
        throw new ConflictException({
          code: 'PRODUCTION_BATCH_ASSIGNMENT_STALE',
          message: 'Назначения рулонов уже изменены. Обновите очередь.',
        });
      }
      const productionOrderIds = [...new Set(items.map((item) => item.productionOrderId))].sort();
      const isPublished = (item: (typeof items)[number]) =>
        item.productionOrder.approvalState === 'approved' || item.status !== 'new';
      const targetStatus = assignmentTargetStatus;

      const validated = [] as Array<{
        change: BatchUpdateDispatchDto['changes'][number];
        item: (typeof items)[number];
        topology: OperatorTopology;
        assignmentLocked: boolean;
      }>;
      for (const change of dto.changes) {
        const item = byCode.get(change.rollId)!;
        const assignmentLocked = ASSIGNMENT_LOCKED_ROLL_STATUSES.has(item.status);
        if (item.assignedOperatorId !== change.operatorId && assignmentLocked) {
          throw new ConflictException(`Roll ${change.rollId} can no longer be reassigned`);
        }
        const topology = this.operatorTopology(
          currentByOperator.get(change.operatorId)!.assignment,
        );
        const assignmentMatches =
          item.assignedOperatorId === change.operatorId &&
          item.plannedShiftId === topology.plannedShiftId &&
          item.postId === topology.postId &&
          item.machineId === topology.machineId &&
          item.workplaceId === topology.workplaceId &&
          (change.priority === undefined || item.priority === change.priority);
        if (assignmentLocked && !assignmentMatches) {
          throw new ConflictException(`Roll ${change.rollId} can no longer be reassigned`);
        }
        validated.push({ change, item, topology, assignmentLocked });
      }

      const changed = validated.filter(({ change, item, topology, assignmentLocked }) => {
        if (assignmentLocked) return false;
        return (
          item.assignedOperatorId !== change.operatorId ||
          item.plannedShiftId !== topology.plannedShiftId ||
          item.postId !== topology.postId ||
          item.machineId !== topology.machineId ||
          item.workplaceId !== topology.workplaceId ||
          item.status !== targetStatus(item) ||
          (change.priority !== undefined && item.priority !== change.priority)
        );
      });
      const claimedChanges = [] as typeof changed;
      for (const entry of changed) {
        const { change, item, topology } = entry;
        const nextStatus = targetStatus(item);
        const targetPriority = change.priority ?? item.priority;
        const claimed = await tx.rollDispatchItem.updateMany({
          where: {
            id: item.id,
            assignedOperatorId: item.assignedOperatorId,
            plannedShiftId: item.plannedShiftId,
            postId: item.postId,
            machineId: item.machineId,
            workplaceId: item.workplaceId,
            status: item.status,
            priority: item.priority,
          },
          data: {
            assignedOperatorId: change.operatorId,
            ...topology,
            ...(change.priority == null ? {} : { priority: change.priority }),
            status: nextStatus,
          },
        });
        if (claimed.count === 1) {
          claimedChanges.push(entry);
          continue;
        }

        const winner = await this.requireRoll(change.rollId, tx);
        const targetMatches =
          winner.assignedOperatorId === change.operatorId &&
          winner.plannedShiftId === topology.plannedShiftId &&
          winner.postId === topology.postId &&
          winner.machineId === topology.machineId &&
          winner.workplaceId === topology.workplaceId &&
          winner.status === nextStatus &&
          winner.priority === targetPriority;
        if (targetMatches) continue;
        throw new ConflictException({
          code: 'PRODUCTION_BATCH_ASSIGNMENT_STALE',
          message: `Назначение рулона ${change.rollId} уже изменено. Обновите очередь.`,
        });
      }

      if (claimedChanges.length > 0) {
        await this.audit.record(
          {
            type: 'audit:roll_dispatch_bulk_assigned',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: claimedChanges[0].change.rollId,
            detail: {
              rollIds: claimedChanges.map(({ change }) => change.rollId),
              count: claimedChanges.length,
              assignments: claimedChanges.map(({ change, item, topology }) => ({
                ...(item.productionOrder.commercialOrderId
                  ? { commercialOrderId: item.productionOrder.commercialOrderId }
                  : {}),
                ...(item.productionOrderId ? { productionOrderId: item.productionOrderId } : {}),
                rollId: change.rollId,
                operatorId: change.operatorId,
                ...(topology.plannedShiftId ? { shiftId: topology.plannedShiftId } : {}),
              })),
            },
          },
          tx,
        );
        for (const { change, item, topology } of claimedChanges) {
          if (!isPublished(item)) continue;
          const reassigned =
            !!item.assignedOperatorId && item.assignedOperatorId !== change.operatorId;
          await this.audit.record(
            {
              type: reassigned ? 'audit:task_reassigned' : 'audit:task_assigned',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: change.rollId,
              detail: {
                ...(item.productionOrder.commercialOrderId
                  ? { commercialOrderId: item.productionOrder.commercialOrderId }
                  : {}),
                operatorId: change.operatorId,
                ...(reassigned ? { previousOperatorId: item.assignedOperatorId! } : {}),
                ...(topology.plannedShiftId ? { shiftId: topology.plannedShiftId } : {}),
                rollId: change.rollId,
                productionOrderId: item.productionOrderId,
              },
            },
            tx,
          );
        }
      }
      for (const productionOrderId of productionOrderIds) {
        await this.publishProductionOrderWhenReady(actor, productionOrderId, {
          transaction: tx,
        });
      }
      return { updated: rollIds.length };
    });
    return result;
  }

  async publishProductionOrderWhenReady(
    actor: ProductionActor,
    productionOrderId: string,
    options: {
      transaction?: Prisma.TransactionClient;
      requireComplete?: boolean;
    } = {},
  ): Promise<void> {
    try {
      if (options.transaction) {
        await this.approve(actor, productionOrderId, options.transaction);
      } else {
        await this.approve(actor, productionOrderId);
      }
    } catch (error) {
      if (error instanceof ConflictException) {
        const response = error.getResponse();
        if (
          !options.requireComplete &&
          typeof response === 'object' &&
          response !== null &&
          'message' in response &&
          response.message === 'Production order plan is incomplete'
        ) {
          await this.publishReadyOperatorRolls(actor, productionOrderId, options.transaction);
          return;
        }
      }
      throw error;
    }
  }

  /**
   * Operator work is roll-first: one complete operator/shift/post assignment must not be
   * hidden merely because another roll from the same production order is still a draft.
   * The order-wide approval remains pending until the whole plan is complete.
   */
  private async publishReadyOperatorRolls(
    actor: ProductionActor,
    productionOrderId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const publish = async (tx: Prisma.TransactionClient) => {
      const order = await tx.productionOrder.findUnique({
        where: { id: productionOrderId },
        select: { commercialOrderId: true },
      });
      if (!order) throw new NotFoundException(`Production order ${productionOrderId} not found`);
      const loadAll = () =>
        tx.rollDispatchItem.findMany({
          where: { productionOrderId },
          orderBy: APPROVAL_DISPATCH_ORDER,
        });
      const snapshots = (await loadAll()).filter(
        (roll) =>
          ['new', 'assigned'].includes(roll.status) &&
          roll.plannedWeightKg !== null &&
          Number.isFinite(roll.plannedWeightKg) &&
          roll.plannedWeightKg > 0 &&
          roll.assignedOperatorId !== null &&
          roll.plannedShiftId !== null &&
          roll.postId !== null &&
          roll.machineId !== null &&
          roll.workplaceId !== null,
      );
      if (snapshots.length === 0) return;

      const assignmentSnapshots = [] as Array<{
        rollId: string;
        plannedWeightKg: number;
        assignment: CurrentOperatorAssignment;
      }>;
      const snapshotAssignments = new Map<string, CurrentOperatorAssignment | null>();
      for (const roll of snapshots) {
        const key = JSON.stringify([roll.plannedShiftId, roll.assignedOperatorId]);
        if (!snapshotAssignments.has(key))
          snapshotAssignments.set(
            key,
            await tx.operatorShiftMachineAssignment.findFirst({
              where: {
                shiftId: roll.plannedShiftId!,
                operatorId: roll.assignedOperatorId!,
                status: { in: ACTIVE_OPERATOR_MACHINE_ASSIGNMENT_STATUSES },
              },
              include: CURRENT_OPERATOR_ASSIGNMENT_INCLUDE,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            }),
          );
        const assignment = snapshotAssignments.get(key);
        if (
          assignment &&
          this.isUsableOperatorMachinePlanningLifecycle(
            assignment.shift.status,
            assignment.status,
          ) &&
          assignment.post.status === 'active' &&
          assignment.postId === roll.postId &&
          assignment.post.code === roll.machineId &&
          roll.workplaceId === roll.postId
        ) {
          assignmentSnapshots.push({
            rollId: roll.id,
            plannedWeightKg: roll.plannedWeightKg!,
            assignment,
          });
        }
      }
      if (assignmentSnapshots.length === 0) return;

      await this.lockProductionRollTopology(tx, {
        postIds: assignmentSnapshots.map(({ assignment }) => assignment.postId),
        shiftIds: assignmentSnapshots.map(({ assignment }) => assignment.shiftId),
        assignmentIds: assignmentSnapshots.map(({ assignment }) => assignment.id),
        productionOrderId,
        rollIds: assignmentSnapshots.map(({ rollId }) => rollId),
      });

      const currentAll = await loadAll();
      const currentById = new Map(currentAll.map((roll) => [roll.id, roll]));
      const ready: typeof snapshots = [];
      const newlyPublished: typeof snapshots = [];
      const lockedAssignments = new Map<string, CurrentOperatorAssignment | null>();
      for (const snapshot of assignmentSnapshots) {
        const roll = currentById.get(snapshot.rollId);
        if (!roll) continue;
        if (!lockedAssignments.has(snapshot.assignment.id))
          lockedAssignments.set(
            snapshot.assignment.id,
            await tx.operatorShiftMachineAssignment.findUnique({
              where: { id: snapshot.assignment.id },
              include: CURRENT_OPERATOR_ASSIGNMENT_INCLUDE,
            }),
          );
        const assignment = lockedAssignments.get(snapshot.assignment.id);
        if (
          !assignment ||
          assignment.operatorId !== roll.assignedOperatorId ||
          assignment.shiftId !== roll.plannedShiftId ||
          assignment.postId !== roll.postId ||
          assignment.post.code !== roll.machineId ||
          assignment.post.status !== 'active' ||
          roll.workplaceId !== roll.postId ||
          roll.plannedWeightKg !== snapshot.plannedWeightKg ||
          !Number.isFinite(roll.plannedWeightKg) ||
          roll.plannedWeightKg <= 0 ||
          !this.isUsableOperatorMachinePlanningLifecycle(assignment.shift.status, assignment.status)
        ) {
          continue;
        }
        if (roll.status === 'new') {
          const claimed = await tx.rollDispatchItem.updateMany({
            where: {
              id: roll.id,
              status: 'new',
              assignedOperatorId: roll.assignedOperatorId,
              plannedShiftId: roll.plannedShiftId,
              postId: roll.postId,
              machineId: roll.machineId,
              workplaceId: roll.workplaceId,
              plannedWeightKg: roll.plannedWeightKg,
            },
            data: { status: 'assigned' },
          });
          if (claimed.count !== 1) continue;
          newlyPublished.push(roll);
        }
        ready.push(roll);
      }
      if (ready.length === 0) return;

      const sequenceById = new Map(currentAll.map((roll, index) => [roll.id, index + 1]));
      await tx.operatorRollLine.createMany({
        data: ready.map((roll) => ({
          rollDispatchItemId: roll.id,
          sequence: sequenceById.get(roll.id)!,
          planKg: roll.plannedWeightKg!,
          step: 'assigned',
        })),
        skipDuplicates: true,
      });
      for (const roll of newlyPublished) {
        await this.audit.record(
          {
            type: 'audit:task_assigned',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: roll.rollCode,
            detail: {
              commercialOrderId: order.commercialOrderId,
              operatorId: roll.assignedOperatorId!,
              shiftId: roll.plannedShiftId!,
              rollId: roll.rollCode,
              productionOrderId,
            },
          },
          tx,
        );
      }
    };

    if (transaction) {
      await publish(transaction);
      return;
    }
    await this.prisma.$transaction(publish);
  }

  async reorder(actor: ProductionActor, dto: ReorderDispatchDto) {
    const items = await this.prisma.rollDispatchItem.findMany({
      where: { rollCode: { in: dto.orderedRollIds } },
      select: { rollCode: true, queueRank: true },
    });
    if (items.length !== dto.orderedRollIds.length) {
      throw new NotFoundException('One or more rolls in the requested order were not found');
    }
    const oldRanks = Object.fromEntries(items.map((item) => [item.rollCode, item.queueRank]));
    const ranks = items.map((item) => item.queueRank).sort((a, b) => a - b);
    const newRanks = Object.fromEntries(
      dto.orderedRollIds.map((rollId, index) => [rollId, ranks[index]]),
    );
    await this.prisma.$transaction(async (tx) => {
      for (const rollId of dto.orderedRollIds) {
        await tx.rollDispatchItem.update({
          where: { rollCode: rollId },
          data: { queueRank: newRanks[rollId] },
        });
      }
    });
    await this.audit.record({
      type: 'audit:production_queue_reordered',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: dto.orderedRollIds[0],
      oldValue: oldRanks,
      newValue: newRanks,
      reason: dto.reason,
    });
    return { orderedRollIds: dto.orderedRollIds };
  }

  async setPriority(actor: ProductionActor, rollCode: string, dto: SetPriorityDto) {
    const item = await this.requireRoll(rollCode);
    const updated = await this.prisma.rollDispatchItem.update({
      where: { rollCode },
      data: { priority: dto.priority },
    });
    await this.audit.record({
      type: 'audit:production_priority_changed',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: rollCode,
      oldValue: { priority: item.priority },
      newValue: { priority: dto.priority },
    });
    return updated;
  }

  async assignMachine(actor: ProductionActor, rollCode: string, dto: AssignMachineDto) {
    return this.prisma.$transaction(async (tx) => {
      const itemSnapshot = await this.requireRoll(rollCode, tx);
      if (!itemSnapshot.assignedOperatorId || !itemSnapshot.plannedShiftId) {
        throw this.productionAssignmentLifecycleConflict(
          'Assign the roll operator and shift before its machine',
        );
      }
      const activeAssignmentSnapshot = await tx.operatorShiftMachineAssignment.findFirst({
        where: {
          shiftId: itemSnapshot.plannedShiftId,
          operatorId: itemSnapshot.assignedOperatorId,
          status: { in: ACTIVE_OPERATOR_MACHINE_ASSIGNMENT_STATUSES },
        },
        select: { id: true, shiftId: true, operatorId: true, postId: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const assignmentSnapshot =
        activeAssignmentSnapshot ??
        (await tx.operatorShiftMachineAssignment.findFirst({
          where: {
            shiftId: itemSnapshot.plannedShiftId,
            operatorId: itemSnapshot.assignedOperatorId,
          },
          select: { id: true, shiftId: true, operatorId: true, postId: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }));
      if (!assignmentSnapshot) {
        throw new ConflictException(
          `Operator ${itemSnapshot.assignedOperatorId} has no machine in shift ${itemSnapshot.plannedShiftId}`,
        );
      }
      await this.lockProductionRollTopology(tx, {
        postIds: [assignmentSnapshot.postId],
        shiftIds: [assignmentSnapshot.shiftId],
        assignmentIds: [assignmentSnapshot.id],
        rollIds: [itemSnapshot.id],
      });
      const item = await this.requireRoll(rollCode, tx);
      if (
        item.id !== itemSnapshot.id ||
        item.assignedOperatorId !== itemSnapshot.assignedOperatorId ||
        item.plannedShiftId !== itemSnapshot.plannedShiftId
      ) {
        throw new ConflictException({
          code: 'PRODUCTION_ASSIGNMENT_STALE',
          message: 'Назначение рулона изменилось. Обновите очередь.',
        });
      }
      const assignment = await tx.operatorShiftMachineAssignment.findUnique({
        where: { id: assignmentSnapshot.id },
        include: {
          shift: { select: { id: true, status: true } },
          post: { select: { id: true, code: true, name: true, status: true } },
        },
      });
      if (
        !assignment ||
        assignment.id !== assignmentSnapshot.id ||
        assignment.shiftId !== assignmentSnapshot.shiftId ||
        assignment.operatorId !== assignmentSnapshot.operatorId ||
        assignment.postId !== assignmentSnapshot.postId
      ) {
        throw this.productionAssignmentLifecycleConflict(
          `Shift ${item.plannedShiftId} machine assignment changed before roll mutation`,
        );
      }
      const post = assignment.post;
      if (post.code !== dto.machineId) {
        throw new ConflictException(
          'Selected machine does not match the operator shift assignment',
        );
      }
      const operator = await tx.user.findUnique({ where: { id: item.assignedOperatorId } });
      if (!operator || operator.role !== 'operator' || !operator.isActive) {
        throw new NotFoundException(`Active operator ${item.assignedOperatorId} not found`);
      }
      if (!this.isUsableOperatorMachineLifecycle(assignment.shift.status, assignment.status)) {
        throw this.productionAssignmentLifecycleConflict(
          `Shift ${item.plannedShiftId} and operator ${item.assignedOperatorId} machine assignment are not usable`,
        );
      }
      if (post.status !== 'active') {
        throw new ConflictException(`Assigned post ${post.code} is not active`);
      }
      const latestAssignment = await tx.machineAssignment.findFirst({
        where: { rollDispatchItemId: item.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (
        item.machineId === post.code &&
        item.postId === post.id &&
        latestAssignment?.machineId === post.code &&
        latestAssignment.postId === post.id &&
        latestAssignment.scope === dto.scope &&
        (latestAssignment.reason ?? null) === (dto.reason ?? null)
      ) {
        const { productionOrder, ...current } = item;
        void productionOrder;
        return current;
      }
      // Persist the roll-lock serialization point using one database clock across all API nodes.
      // The 1 ms floor matches MachineAssignment.createdAt's timestamp(3)/JS Date precision.
      const historyClockQuery = latestAssignment
        ? Prisma.sql`
            SELECT GREATEST(
              clock_timestamp(),
              ${latestAssignment.createdAt}::timestamptz + INTERVAL '1 millisecond'
            ) AS "createdAt"
          `
        : Prisma.sql`SELECT clock_timestamp() AS "createdAt"`;
      const [historyClock] = await tx.$queryRaw<Array<{ createdAt: Date }>>(historyClockQuery);
      if (!historyClock) {
        throw new Error('Database wall clock query returned no row');
      }
      await tx.machineAssignment.create({
        data: {
          rollDispatchItemId: item.id,
          productionOrderId: item.productionOrderId,
          machineId: post.code,
          postId: post.id,
          scope: dto.scope,
          reason: dto.reason,
          createdAt: historyClock.createdAt,
        },
      });
      const updated = await tx.rollDispatchItem.update({
        where: { rollCode },
        data: { machineId: post.code, postId: post.id },
      });
      await this.audit.record(
        {
          type: 'audit:machine_assigned',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: rollCode,
          oldValue: { machineId: item.machineId, postId: item.postId },
          newValue: { machineId: post.code, postId: post.id, scope: dto.scope },
          reason: dto.reason,
        },
        tx,
      );
      return updated;
    });
  }

  async operatorWorkload() {
    const operators = await this.prisma.user.findMany({
      where: { role: 'operator', isActive: true },
    });
    const items = await this.prisma.rollDispatchItem.findMany({
      where: { assignedOperatorId: { not: null } },
    });
    return operators.map((op) => {
      const mine = items.filter((i) => i.assignedOperatorId === op.id);
      return {
        operatorId: op.id,
        displayName: op.displayName,
        active: mine.filter((i) => i.status === 'in_progress').length,
        planned: mine.filter((i) => i.status === 'assigned').length,
        total: mine.length,
      };
    });
  }

  /**
   * Решение по заявке о поломке (дизайн 2026-07-14): confirm — факт подтверждения
   * в аудит, проблема остается открытой до ремонта; reject — проблема закрывается,
   * станок возвращается в active (если нет других открытых заявок по нему).
   */
  private async resolveMachineBreakdownProblem(
    actor: ProductionActor,
    problem: { id: string; postId: string | null; reason: string },
    resolution: 'confirm' | 'reject',
    note?: string,
  ) {
    const normalizedNote = note?.trim();
    return this.prisma.$transaction(async (tx) => {
      if (problem.postId) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${problem.postId} FOR UPDATE`,
        );
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "production_problems" WHERE "id" = ${problem.id} FOR UPDATE`,
      );
      const lockedProblem = await tx.productionProblem.findUnique({ where: { id: problem.id } });
      if (!lockedProblem) throw new NotFoundException(`Problem ${problem.id} not found`);
      if (lockedProblem.type !== 'machine_breakdown' || lockedProblem.postId !== problem.postId) {
        throw new ConflictException('Проблема поломки изменилась до принятия решения.');
      }
      if (lockedProblem.status !== 'open') {
        throw new ConflictException('Проблема уже решена.');
      }
      const post = lockedProblem.postId
        ? await tx.post.findUnique({ where: { id: lockedProblem.postId } })
        : null;
      if (lockedProblem.postId && !post) {
        throw new NotFoundException(`Post ${lockedProblem.postId} not found`);
      }

      if (resolution === 'confirm') {
        if (post && !['broken', 'maintenance'].includes(post.status)) {
          throw new ConflictException(`Станок ${post.code} не находится в состоянии поломки`);
        }
        const recovery = normalizedNote || 'поломка подтверждена завпроизводства';
        const confirmed = await tx.productionProblem.update({
          where: { id: lockedProblem.id },
          data: { recovery },
        });
        await this.audit.record(
          {
            type: 'audit:machine_breakdown_confirmed',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: lockedProblem.id,
            reason: normalizedNote || undefined,
            detail: { postId: lockedProblem.postId },
          },
          tx,
        );
        return confirmed;
      }

      const claimed = await tx.productionProblem.updateMany({
        where: { id: lockedProblem.id, status: 'open' },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedById: actor.userId,
          recovery: normalizedNote || 'заявка о поломке отклонена',
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException('Проблема уже решена.');
      }
      if (post?.status === 'broken' && lockedProblem.postId) {
        const otherOpen = await tx.productionProblem.count({
          where: {
            postId: lockedProblem.postId,
            type: 'machine_breakdown',
            status: 'open',
          },
        });
        if (otherOpen === 0) {
          await tx.post.update({
            where: { id: lockedProblem.postId },
            data: { status: 'active' },
          });
        }
      }
      await this.audit.record(
        {
          type: 'audit:machine_breakdown_rejected',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: lockedProblem.id,
          reason: normalizedNote || undefined,
          detail: { postId: lockedProblem.postId },
        },
        tx,
      );
      return { ...lockedProblem, status: 'resolved' };
    });
  }

  private async requireRoll(
    rollCode: string,
    client: Pick<Prisma.TransactionClient, 'rollDispatchItem'> = this.prisma,
  ) {
    const item = await client.rollDispatchItem.findUnique({
      where: { rollCode },
      include: {
        productionOrder: { select: { approvalState: true, commercialOrderId: true } },
        operatorLine: { select: { step: true } },
      },
    });
    if (!item) throw new NotFoundException(`Roll ${rollCode} not found`);
    return item;
  }

  private async lockProductionOperators(
    client: Prisma.TransactionClient,
    operatorIds: readonly string[],
  ): Promise<void> {
    for (const operatorId of [...new Set(operatorIds)].sort()) {
      // Serializes operator commands without blocking FK checks during post handover.
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${operatorId} FOR NO KEY UPDATE`,
      );
    }
  }

  private async resolveCurrentOperatorMachine(
    operatorId: string,
    client: Pick<Prisma.TransactionClient, 'user' | 'operatorShiftMachineAssignment'> = this.prisma,
  ) {
    const [operator, assignments] = await Promise.all([
      client.user.findUnique({ where: { id: operatorId } }),
      client.operatorShiftMachineAssignment.findMany({
        where: {
          operatorId,
          status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
          shift: { status: { in: ['planned', 'open'] } },
        },
        include: CURRENT_OPERATOR_ASSIGNMENT_INCLUDE,
        orderBy: [{ shift: { status: 'asc' } }, { createdAt: 'desc' }],
        take: 2,
      }),
    ]);
    if (!operator || operator.role !== 'operator' || !operator.isActive) {
      throw new NotFoundException(`Active operator ${operatorId} not found`);
    }
    if (assignments.length > 1) {
      throw new ConflictException({
        code: 'PRODUCTION_OPERATOR_SHIFT_AMBIGUOUS',
        message: `Operator ${operatorId} has multiple current shift assignments`,
      });
    }
    const assignment = assignments[0] ?? null;
    if (
      assignment &&
      !this.isUsableOperatorMachinePlanningLifecycle(assignment.shift.status, assignment.status)
    ) {
      throw this.productionAssignmentLifecycleConflict(
        `Shift ${assignment.shift.id} and operator ${operatorId} machine assignment are not usable`,
      );
    }
    if (assignment && assignment.post.status !== 'active') {
      throw new ConflictException(`Assigned post ${assignment.post.code} is not active`);
    }
    return { operator, assignment };
  }

  private sameCurrentOperatorAssignment(
    snapshot: CurrentOperatorAssignment | null,
    current: CurrentOperatorAssignment | null,
  ): boolean {
    if (!snapshot || !current) return snapshot === current;
    return (
      snapshot.id === current.id &&
      snapshot.operatorId === current.operatorId &&
      snapshot.status === current.status &&
      snapshot.shift.id === current.shift.id &&
      snapshot.shift.status === current.shift.status &&
      snapshot.post.id === current.post.id &&
      snapshot.post.code === current.post.code &&
      snapshot.post.status === current.post.status
    );
  }

  private operatorTopology(assignment: CurrentOperatorAssignment | null): OperatorTopology {
    return assignment
      ? {
          plannedShiftId: assignment.shift.id,
          postId: assignment.post.id,
          machineId: assignment.post.code,
          workplaceId: assignment.post.id,
        }
      : {
          plannedShiftId: null,
          postId: null,
          machineId: null,
          workplaceId: null,
        };
  }

  private productionAssignmentTopologyChanged(operatorId: string) {
    return new ConflictException({
      code: 'PRODUCTION_ASSIGNMENT_TOPOLOGY_CHANGED',
      message: `Operator ${operatorId} current shift assignment changed. Retry the command.`,
    });
  }

  private async requireOperatorMachine(
    operatorId: string,
    shiftId: string,
    client: Pick<Prisma.TransactionClient, 'user' | 'operatorShiftMachineAssignment'> = this.prisma,
  ) {
    const [operator, assignment] = await Promise.all([
      client.user.findUnique({ where: { id: operatorId } }),
      client.operatorShiftMachineAssignment.findFirst({
        where: {
          shiftId,
          operatorId,
          status: { in: ACTIVE_OPERATOR_MACHINE_ASSIGNMENT_STATUSES },
        },
        include: {
          shift: { select: { id: true, status: true } },
          post: { select: { id: true, code: true, name: true, status: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    if (!operator || operator.role !== 'operator' || !operator.isActive) {
      throw new NotFoundException(`Active operator ${operatorId} not found`);
    }
    if (!assignment) {
      throw new ConflictException(`Operator ${operatorId} has no machine in shift ${shiftId}`);
    }
    if (
      !this.isUsableOperatorMachinePlanningLifecycle(assignment.shift.status, assignment.status)
    ) {
      throw this.productionAssignmentLifecycleConflict(
        `Shift ${shiftId} and operator ${operatorId} machine assignment are not usable`,
      );
    }
    if (assignment.post.status !== 'active') {
      throw new ConflictException(`Assigned post ${assignment.post.code} is not active`);
    }
    return assignment;
  }

  private async lockProductionRollTopology(
    client: Prisma.TransactionClient,
    scope: {
      postIds: readonly string[];
      shiftIds: readonly string[];
      assignmentIds: readonly string[];
      rollIds: readonly string[];
      productionOrderId?: string;
      productionOrderIds?: readonly string[];
    },
  ): Promise<void> {
    // Keep the global shop-floor lock order aligned with open/close/breakdown flows:
    // sorted posts -> sorted shifts -> sorted assignments -> order -> sorted rolls.
    const sortedUnique = (ids: readonly string[]) => [...new Set(ids)].sort();
    for (const postId of sortedUnique(scope.postIds)) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`,
      );
    }
    for (const shiftId of sortedUnique(scope.shiftIds)) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${shiftId} FOR UPDATE`,
      );
    }
    for (const assignmentId of sortedUnique(scope.assignmentIds)) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments" WHERE "id" = ${assignmentId} FOR UPDATE`,
      );
    }
    const productionOrderIds = [
      ...(scope.productionOrderIds ?? []),
      ...(scope.productionOrderId ? [scope.productionOrderId] : []),
    ];
    for (const productionOrderId of sortedUnique(productionOrderIds)) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "production_orders" WHERE "id" = ${productionOrderId} FOR UPDATE`,
      );
    }
    if (scope.rollIds.length > 0) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
          WHERE "id" IN (${Prisma.join(sortedUnique(scope.rollIds))})
          ORDER BY "id" COLLATE "C" FOR UPDATE`,
      );
    }
  }

  private isUsableOperatorMachineLifecycle(shiftStatus: string, assignmentStatus: string) {
    return (
      (shiftStatus === 'planned' && assignmentStatus === 'planned') ||
      (shiftStatus === 'open' && ['locked', 'breakdown_reassigned'].includes(assignmentStatus))
    );
  }

  private isUsableOperatorMachinePlanningLifecycle(shiftStatus: string, assignmentStatus: string) {
    return (
      this.isUsableOperatorMachineLifecycle(shiftStatus, assignmentStatus) ||
      (shiftStatus === 'open' && assignmentStatus === 'planned')
    );
  }

  private productionAssignmentLifecycleConflict(message: string) {
    return new ConflictException({
      code: 'PRODUCTION_ASSIGNMENT_LIFECYCLE_CONFLICT',
      message,
    });
  }

  private parseDispatchDate(value: string, nextDay: boolean) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new ConflictException(`Invalid dispatch date: ${value}`);
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    const calendarDate = new Date(Date.UTC(year, monthIndex, day));
    if (
      calendarDate.getUTCFullYear() !== year ||
      calendarDate.getUTCMonth() !== monthIndex ||
      calendarDate.getUTCDate() !== day
    ) {
      throw new ConflictException(`Invalid dispatch date: ${value}`);
    }
    // Europe/Moscow is UTC+03:00 year-round. The upper boundary is exclusive so that
    // consecutive business days cannot overlap at midnight.
    return new Date(Date.UTC(year, monthIndex, day + Number(nextDay), -3));
  }

  private async ensureOperatorLine(item: {
    id: string;
    productionOrderId: string;
    plannedWeightKg?: number | null;
  }) {
    const existing = await this.prisma.operatorRollLine.findUnique({
      where: { rollDispatchItemId: item.id },
    });
    if (existing) return existing;

    const sequence =
      (await this.prisma.operatorRollLine.count({
        where: { rollDispatchItem: { productionOrderId: item.productionOrderId } },
      })) + 1;

    return this.prisma.operatorRollLine.create({
      data: {
        rollDispatchItemId: item.id,
        sequence,
        planKg: item.plannedWeightKg ?? undefined,
        step: 'assigned',
      },
    });
  }

  private project(
    order: ProductionOrderProjectionSource,
    actor: Actor,
    defectAggregate: ProductionDefectAggregate,
    coverageProjection?: WarehouseCoverageProjection,
  ) {
    const rawDispatchItems = order.dispatchItems;
    const dispatchItems = rawDispatchItems.map((item) => ({
      id: item.id,
      rollCode: item.rollCode,
      productionOrderId: item.productionOrderId,
      orderLineId: item.orderLineId,
      positionSequence: item.positionSequence,
      rawMaterialId: item.rawMaterialId,
      recipeVersion: item.recipeVersion,
      filmType: item.filmType,
      plannedWeightKg: item.plannedWeightKg,
      widthMm: item.widthMm,
      plannedLengthM: item.plannedLengthM,
      characteristicsSnapshot: item.characteristicsSnapshot,
      assignedOperatorId: item.assignedOperatorId,
      assignedOperator: item.assignedOperator,
      machineId: item.machineId,
      workplaceId: item.workplaceId,
      postId: item.postId,
      post: item.post,
      plannedShiftId: item.plannedShiftId,
      queueRank: item.queueRank,
      priority: item.priority,
      status: item.status,
      bulkGroupId: item.bulkGroupId,
      replacesDispatchItemId: item.replacesDispatchItemId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt,
      operatorLine:
        item.operatorLine == null
          ? null
          : {
              netKg: safeProductionNetKg(item.operatorLine.netKg),
              step: item.operatorLine.step,
              warehouseState: item.operatorLine.warehouseState,
            },
    }));
    const workflowVersion = order.commercialOrder.warehouseCoverageWorkflowVersion === 2 ? 2 : 1;
    const rawCoverage = workflowVersion === 2 ? coverageProjection : null;
    const coverage = rawCoverage ? safeBaseCoverage(rawCoverage) : null;
    const approvalProblems = order.dispatchItems.flatMap((roll) => {
      const reasons: string[] = [];
      if (!roll.assignedOperatorId) reasons.push('operator is not assigned');
      if (!roll.plannedShiftId) reasons.push('shift is not assigned');
      if (!roll.postId || !roll.machineId) reasons.push('machine is not assigned');
      if (!roll.queueRank || roll.queueRank <= 0) reasons.push('queue rank is not assigned');
      if (roll.plannedWeightKg == null || roll.plannedWeightKg <= 0) {
        reasons.push('planned weight is not assigned');
      }
      if (isInvalidProductionNetKg(roll.operatorLine?.netKg ?? null)) {
        reasons.push('roll weight is invalid');
      }
      return reasons.length > 0 ? [{ rollId: roll.rollCode, reasons }] : [];
    });
    if (order.dispatchItems.length === 0) {
      approvalProblems.push({ rollId: order.id, reasons: ['order has no rolls'] });
    }
    return {
      id: order.id,
      commercialOrderId: order.commercialOrderId,
      indicator: order.indicator,
      approvalState: order.approvalState,
      assignedOwnerId: order.assignedOwnerId,
      blockers: order.blockers,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      commercialOrder: {
        id: order.commercialOrder.id,
        orderNumber: order.commercialOrder.orderNumber,
        creatorRole: order.commercialOrder.creatorRole,
        counterpartyId: order.commercialOrder.counterpartyId,
        requestType: order.commercialOrder.requestType,
        productionIndicator: order.commercialOrder.productionIndicator,
        warehouseCoverStatus: order.commercialOrder.warehouseCoverStatus,
        paymentStatus: order.commercialOrder.paymentStatus,
        shipmentStatus: order.commercialOrder.shipmentStatus,
        warehouseCoverageWorkflowVersion: order.commercialOrder.warehouseCoverageWorkflowVersion,
        commercialConfirmationPolicy: order.commercialOrder.commercialConfirmationPolicy,
        createdAt: order.commercialOrder.createdAt,
        updatedAt: order.commercialOrder.updatedAt,
        externalId: order.commercialOrder.externalId,
        sourceVersion: order.commercialOrder.sourceVersion,
        stockBatchCode: order.commercialOrder.stockBatchCode,
        counterparty: projectCounterparty(order.commercialOrder.counterparty, actor.role),
      },
      dispatchItems,
      canApprove:
        order.approvalState === 'pending' &&
        order.dispatchItems.length > 0 &&
        approvalProblems.length === 0,
      approvalProblems,
      defectRollCount: defectAggregate.defectRollCount,
      verifiedDefectKg: defectAggregate.verifiedDefectKg,
      returnedSpoolCount: defectAggregate.returnedSpoolCount,
      ...(coverage
        ? {
            coverage,
            productionQty: order.dispatchItems.length,
            sourceGeneration: order.sourceCoverageGeneration ?? null,
          }
        : {}),
    };
  }
}

function isInvalidProductionNetKg(netKg: number | null): boolean {
  return netKg !== null && !isValidRollNetKg(netKg);
}

function safeProductionNetKg(netKg: number | null): number | null {
  return isInvalidProductionNetKg(netKg) ? null : netKg;
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
