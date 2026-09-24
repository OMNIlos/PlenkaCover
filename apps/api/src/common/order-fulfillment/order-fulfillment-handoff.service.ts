import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WAREHOUSE_COVERAGE_AVAILABILITIES,
  WAREHOUSE_COVERAGE_DECISIONS,
  WAREHOUSE_COVERAGE_STATES,
  type CommercialCompletion,
  type CommercialCompletionBlocker,
  type Role,
  type ShipmentStatus,
} from '@plenka/contracts';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { warehouseCoverScopeKey } from '../warehouse-cover-task';
import { calculateOrderFulfillment } from './order-fulfillment.calculator';
import type { FulfillmentOrder } from './order-fulfillment.types';

const FULFILLMENT_ORDER_SELECT = {
  cancellationStatus: true,
  id: true,
  orderNumber: true,
  warehouseCoverageWorkflowVersion: true,
  shipmentStatus: true,
  positions: {
    select: {
      id: true,
      rollCount: true,
      warehouseCoverStatus: true,
      coverProposals: {
        select: {
          id: true,
          status: true,
          coverQty: true,
          reserveQty: true,
          commercialApprovedAt: true,
          technicalApprovedAt: true,
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
  problems: { select: { id: true, positionId: true, status: true } },
  resolutionCases: { select: { problemId: true, status: true } },
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
      commercialOrderId: true,
      sourceCoverageCalculationId: true,
      sourceCoverageDecisionId: true,
      sourceCoverageInputFingerprint: true,
      sourceCoverageGeneration: true,
      dispatchItems: {
        select: {
          rollCode: true,
          orderLineId: true,
          status: true,
          operatorLine: { select: { warehouseState: true } },
        },
      },
    },
  },
} satisfies Prisma.CommercialOrderSelect;

const FULFILLMENT_TASK_SELECT = {
  id: true,
  orderId: true,
  positionId: true,
  proposalId: true,
  coverageDecisionId: true,
  mode: true,
  status: true,
  rows: { select: { rollCode: true, fromOrderId: true, scanStatus: true } },
} satisfies Prisma.WarehouseAcceptanceTaskSelect;

const FULFILLMENT_ROLL_SELECT = {
  id: true,
  rollCode: true,
  warehouseStatus: true,
  currentCoverageFactId: true,
  reservedForOrderId: true,
  reservedForPositionId: true,
  reservedByProposalId: true,
  reservedByCoverageDecisionId: true,
  reservedAt: true,
  producedForOrderId: true,
  producedForPositionId: true,
  producedByCoverageDecisionId: true,
} satisfies Prisma.WarehouseRollSelect;

type FulfillmentLoadedOrder = Prisma.CommercialOrderGetPayload<{
  select: typeof FULFILLMENT_ORDER_SELECT;
}>;
type FulfillmentLoadedRoll = Prisma.WarehouseRollGetPayload<{
  select: typeof FULFILLMENT_ROLL_SELECT;
}>;

function oneOfValue<const Values extends readonly string[]>(
  value: string,
  values: Values,
): Values[number] | null {
  for (const candidate of values) {
    if (candidate === value) return candidate;
  }
  return null;
}

type FulfillmentBlockingPolicy = 'strict' | 'ignore_open_production_problems';

const PARTIAL_PALLET_BLOCKERS = new Set<CommercialCompletionBlocker>([
  'production_incomplete',
  'warehouse_acceptance_incomplete',
  'warehouse_batch_open',
]);

function fulfillmentOrderFromLoaded(
  order: FulfillmentLoadedOrder,
  policy: FulfillmentBlockingPolicy,
): FulfillmentOrder {
  const ignoredProblemIds = new Set(
    policy === 'ignore_open_production_problems'
      ? order.problems.filter((problem) => problem.status === 'open').map((problem) => problem.id)
      : [],
  );
  const problems = order.problems
    .filter((problem) => !ignoredProblemIds.has(problem.id))
    .map((problem) => ({
      positionId: problem.positionId,
      status: problem.status,
    }));
  const resolutionCases = order.resolutionCases
    .filter(
      (resolution) => resolution.problemId === null || !ignoredProblemIds.has(resolution.problemId),
    )
    .map((resolution) => ({
      status: resolution.status,
    }));
  if (order.warehouseCoverageWorkflowVersion === 1) {
    return {
      warehouseCoverageWorkflowVersion: 1,
      id: order.id,
      orderNumber: order.orderNumber,
      positions: order.positions.map((position) => ({
        id: position.id,
        rollCount: position.rollCount,
        warehouseCoverStatus: position.warehouseCoverStatus,
        coverProposals: position.coverProposals,
      })),
      problems,
      resolutionCases,
      productionOrder: order.productionOrder
        ? { dispatchItems: order.productionOrder.dispatchItems }
        : null,
    };
  }

  const failClosed = (): FulfillmentOrder => ({
    warehouseCoverageWorkflowVersion: 2,
    id: order.id,
    orderNumber: order.orderNumber,
    positions: order.positions.map((position) => ({
      id: position.id,
      rollCount: position.rollCount,
    })),
    coverageState: null,
    productionOrder: null,
    problems,
    resolutionCases,
  });
  if (order.warehouseCoverageWorkflowVersion !== 2) return failClosed();
  const state = order.coverageState;
  if (!state) {
    return failClosed();
  }
  const stateValue = oneOfValue(state.state, WAREHOUSE_COVERAGE_STATES);
  if (!stateValue) return failClosed();
  const calculation = state.currentCalculation;
  const availability = calculation
    ? oneOfValue(calculation.availability, WAREHOUSE_COVERAGE_AVAILABILITIES)
    : null;
  if (calculation && !availability) {
    return failClosed();
  }
  const decision = state.currentDecision;
  const decisionKind = decision ? oneOfValue(decision.kind, WAREHOUSE_COVERAGE_DECISIONS) : null;
  if (decision && !decisionKind) {
    return failClosed();
  }
  return {
    warehouseCoverageWorkflowVersion: 2,
    id: order.id,
    orderNumber: order.orderNumber,
    positions: order.positions.map((position) => ({
      id: position.id,
      rollCount: position.rollCount,
    })),
    coverageState: {
      state: stateValue,
      stateVersion: state.stateVersion,
      generation: state.generation,
      currentCalculationId: state.currentCalculationId,
      currentDecisionId: state.currentDecisionId,
      currentCalculation: calculation
        ? {
            ...calculation,
            availability: availability!,
          }
        : null,
      currentDecision: decision
        ? {
            ...decision,
            kind: decisionKind!,
          }
        : null,
    },
    productionOrder: order.productionOrder,
    problems,
    resolutionCases,
  };
}

export type FulfillmentActor = { userId: string | null; role: Role };

const FULFILLMENT_DELIVERY_LOCK_PROOF = Symbol('fulfillment-delivery-lock-proof');

export type FulfillmentDeliveryLockProof = Readonly<{
  [FULFILLMENT_DELIVERY_LOCK_PROOF]: true;
}>;

const deliveryLockClaims = new WeakMap<
  FulfillmentDeliveryLockProof,
  { tx: Prisma.TransactionClient; scopeKey: string; transactionId: string }
>();

export type OrderFulfillmentHandoffResult = {
  state: CommercialCompletion['state'];
  deliveryTaskId: string | null;
  created: boolean;
  reason: 'incomplete' | 'already_shipped' | 'roll_facts_mismatch' | null;
};

export function deliveryScopeKey(orderId: string): string {
  return `warehouse_delivery:${orderId}`;
}

function exactV2WarehouseRollFacts(
  order: FulfillmentLoadedOrder,
  rolls: FulfillmentLoadedRoll[],
  requireCompleteComposition = true,
): boolean {
  if (order.warehouseCoverageWorkflowVersion !== 2) return true;
  const decision = order.coverageState?.currentDecision;
  if (!decision) return false;
  if (decision.kind === 'produce_all' || decision.kind === 'auto_produce_all') {
    const production = order.productionOrder;
    if (
      !production ||
      production.commercialOrderId !== order.id ||
      production.sourceCoverageDecisionId !== decision.id
    ) {
      return false;
    }
    const dispatchByCode = new Map(
      production.dispatchItems.map((dispatch) => [dispatch.rollCode, dispatch]),
    );
    return rolls.every((roll) => {
      const dispatch = dispatchByCode.get(roll.rollCode);
      return Boolean(
        dispatch?.orderLineId &&
        roll.currentCoverageFactId !== null &&
        roll.producedForOrderId === order.id &&
        roll.producedForPositionId === dispatch.orderLineId &&
        roll.producedByCoverageDecisionId === decision.id &&
        roll.reservedForOrderId === null &&
        roll.reservedForPositionId === null &&
        roll.reservedByProposalId === null &&
        roll.reservedByCoverageDecisionId === null &&
        roll.reservedAt === null,
      );
    });
  }
  if (decision.kind !== 'use_warehouse') return false;
  const matches = order.coverageState?.currentCalculation?.matches;
  if (!matches || (requireCompleteComposition && matches.length !== rolls.length)) return false;
  const matchByCode = new Map(matches.map((match) => [match.roll.rollCode, match]));
  return (
    matchByCode.size === matches.length &&
    rolls.every((roll) => {
      const match = matchByCode.get(roll.rollCode);
      return Boolean(
        match &&
        roll.id === match.rollId &&
        roll.currentCoverageFactId === match.coverageFactId &&
        roll.reservedForOrderId === order.id &&
        (roll.reservedForPositionId === null || roll.reservedForPositionId === match.positionId) &&
        roll.reservedByProposalId === null &&
        roll.reservedByCoverageDecisionId === decision.id &&
        roll.reservedAt !== null,
      );
    })
  );
}

function exactWarehouseRollFacts(
  order: FulfillmentLoadedOrder,
  rolls: FulfillmentLoadedRoll[],
  allowedWarehouseStatuses: readonly string[],
  requireCompleteComposition = true,
): boolean {
  if (!rolls.every((roll) => allowedWarehouseStatuses.includes(roll.warehouseStatus))) {
    return false;
  }
  if (order.warehouseCoverageWorkflowVersion === 1) {
    return rolls.every((roll) => roll.reservedForOrderId === order.id);
  }
  return exactV2WarehouseRollFacts(order, rolls, requireCompleteComposition);
}

@Injectable()
export class OrderFulfillmentHandoffService {
  private readonly logger = new Logger(OrderFulfillmentHandoffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async acquireDeliveryScopeLock(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<FulfillmentDeliveryLockProof> {
    const scopeKey = deliveryScopeKey(orderId);
    const transactionId = await this.lockDeliveryScope(tx, scopeKey);
    const proof = Object.freeze({
      [FULFILLMENT_DELIVERY_LOCK_PROOF]: true as const,
    });
    deliveryLockClaims.set(proof, { tx, scopeKey, transactionId });
    return proof;
  }

  async reconcile(
    actor: FulfillmentActor,
    orderId: string,
    client?: Prisma.TransactionClient,
    lockProof?: FulfillmentDeliveryLockProof,
  ): Promise<OrderFulfillmentHandoffResult> {
    return this.reconcileWithPolicy(actor, orderId, 'strict', [], client, lockProof);
  }

  async reconcilePalletScan(
    actor: FulfillmentActor,
    orderId: string,
    palletRollCodes: readonly string[] = [],
    client?: Prisma.TransactionClient,
    lockProof?: FulfillmentDeliveryLockProof,
  ): Promise<OrderFulfillmentHandoffResult> {
    return this.reconcileWithPolicy(
      actor,
      orderId,
      'ignore_open_production_problems',
      palletRollCodes,
      client,
      lockProof,
    );
  }

  private async reconcileWithPolicy(
    actor: FulfillmentActor,
    orderId: string,
    policy: FulfillmentBlockingPolicy,
    palletRollCodes: readonly string[] = [],
    client?: Prisma.TransactionClient,
    lockProof?: FulfillmentDeliveryLockProof,
  ): Promise<OrderFulfillmentHandoffResult> {
    if (lockProof && !client) {
      throw new ConflictException({
        code: 'WAREHOUSE_DELIVERY_PRELOCK_REQUIRES_TRANSACTION',
        message: 'A prelocked delivery scope requires its owning transaction client',
      });
    }
    if (client) {
      return this.reconcileInTransaction(
        client,
        actor,
        orderId,
        policy,
        palletRollCodes,
        lockProof,
      );
    }
    return this.prisma.$transaction((tx) =>
      this.reconcileInTransaction(tx, actor, orderId, policy, palletRollCodes, lockProof),
    );
  }

  private async reconcileInTransaction(
    tx: Prisma.TransactionClient,
    actor: FulfillmentActor,
    orderId: string,
    policy: FulfillmentBlockingPolicy,
    palletRollCodes: readonly string[],
    lockProof?: FulfillmentDeliveryLockProof,
  ): Promise<OrderFulfillmentHandoffResult> {
    const scopeKey = deliveryScopeKey(orderId);
    if (lockProof) await this.assertDeliveryScopeLockProof(lockProof, tx, scopeKey);
    else await this.lockDeliveryScope(tx, scopeKey);
    const order = await tx.commercialOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: FULFILLMENT_ORDER_SELECT,
    });
    if (order.cancellationStatus === 'cancelled') {
      return { state: 'incomplete', deliveryTaskId: null, created: false, reason: 'incomplete' };
    }
    const tasks = await tx.warehouseAcceptanceTask.findMany({
      where: {
        mode: { in: ['receiving', 'reserve'] },
        OR: [
          { orderId: order.id },
          {
            orderId: null,
            rows: { some: { fromOrderId: order.orderNumber } },
          },
        ],
      },
      select: FULFILLMENT_TASK_SELECT,
    });
    const { completion, fulfilledRollCodes } = calculateOrderFulfillment(
      fulfillmentOrderFromLoaded(order, policy),
      tasks,
      order.shipmentStatus as ShipmentStatus,
    );

    if (completion.state === 'shipped') {
      return {
        state: 'shipped',
        deliveryTaskId: null,
        created: false,
        reason: 'already_shipped',
      };
    }
    if (
      completion.state === 'incomplete' &&
      (palletRollCodes.length === 0 ||
        completion.blockingReasons.some((blocker) => !PARTIAL_PALLET_BLOCKERS.has(blocker)))
    ) {
      return {
        state: 'incomplete',
        deliveryTaskId: null,
        created: false,
        reason: 'incomplete',
      };
    }

    const uniqueFulfilledRollCodes = [...new Set(fulfilledRollCodes)].sort((left, right) =>
      left.localeCompare(right),
    );
    const uniquePalletRollCodes = [...new Set(palletRollCodes)].sort((left, right) =>
      left.localeCompare(right),
    );
    const fulfilledCodeSet = new Set(uniqueFulfilledRollCodes);
    if (
      (completion.state === 'ready_for_shipment' &&
        uniqueFulfilledRollCodes.length !== completion.requestedQty) ||
      uniquePalletRollCodes.length !== palletRollCodes.length ||
      uniquePalletRollCodes.some(
        (rollCode) =>
          typeof rollCode !== 'string' ||
          rollCode.length === 0 ||
          rollCode.trim() !== rollCode ||
          !fulfilledCodeSet.has(rollCode),
      )
    ) {
      return this.rollFactsMismatch(order.id);
    }

    let scopedTask = await this.taskForScope(tx, scopeKey);
    let existingDeliveryTaskId = scopedTask?.id ?? null;

    const legacy = existingDeliveryTaskId
      ? null
      : await tx.warehouseAcceptanceTask.findFirst({
          where: { mode: 'delivery', orderId: order.id },
          select: { id: true, deliveryScopeKey: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
    if (!existingDeliveryTaskId && legacy) {
      if (legacy.deliveryScopeKey === null) {
        const legacyClaim = await tx.warehouseAcceptanceTask.updateMany({
          where: { id: legacy.id, deliveryScopeKey: null },
          data: { deliveryScopeKey: scopeKey },
        });
        if (legacyClaim.count === 1) existingDeliveryTaskId = legacy.id;
      }
      scopedTask = await this.taskForScope(tx, scopeKey);
      if (!existingDeliveryTaskId && scopedTask) existingDeliveryTaskId = scopedTask.id;
      if (!existingDeliveryTaskId) throw this.deliveryScopeConflict(legacy.id);
    }

    if (existingDeliveryTaskId && !scopedTask) scopedTask = await this.taskForScope(tx, scopeKey);
    const existingRollCodes = scopedTask?.rows.map((row) => row.rollCode) ?? [];
    if (existingRollCodes.some((rollCode) => !fulfilledCodeSet.has(rollCode))) {
      return this.rollFactsMismatch(order.id);
    }
    const targetRollCodes =
      completion.state === 'ready_for_shipment'
        ? uniqueFulfilledRollCodes
        : [...new Set([...existingRollCodes, ...uniquePalletRollCodes])].sort((left, right) =>
            left.localeCompare(right),
          );
    if (targetRollCodes.length === 0) return this.rollFactsMismatch(order.id);

    await this.lockFulfillmentRolls(tx, targetRollCodes);
    const rolls = await tx.warehouseRoll.findMany({
      where: { rollCode: { in: targetRollCodes } },
      select: FULFILLMENT_ROLL_SELECT,
      orderBy: { rollCode: 'asc' },
    });
    const requireCompleteComposition = completion.state === 'ready_for_shipment';
    if (
      rolls.length !== targetRollCodes.length ||
      !exactWarehouseRollFacts(
        order,
        rolls,
        existingDeliveryTaskId ? ['received', 'delivered'] : ['received'],
        requireCompleteComposition,
      )
    ) {
      return this.rollFactsMismatch(order.id);
    }
    if (existingDeliveryTaskId) {
      if (
        !(await this.syncDeliveryRows(
          tx,
          actor,
          existingDeliveryTaskId,
          order,
          scopeKey,
          targetRollCodes,
          rolls,
        ))
      ) {
        return this.rollFactsMismatch(order.id);
      }
      if (completion.state === 'ready_for_shipment') {
        await this.transitionOrderReady(tx, actor, order.id, completion);
      }
      return this.existingResult(existingDeliveryTaskId, completion.state);
    }

    const taskId = randomUUID();
    const created = await tx.warehouseAcceptanceTask.createMany({
      data: [
        {
          id: taskId,
          mode: 'delivery',
          status: 'open',
          operationCode: `ВЫ-${order.orderNumber}`,
          orderId: order.id,
          deliveryScopeKey: scopeKey,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count !== 1) {
      const winner = await this.taskForScope(tx, scopeKey);
      if (!winner) {
        throw new Error(`Delivery task scope ${scopeKey} was not persisted`);
      }
      if (
        !(await this.syncDeliveryRows(
          tx,
          actor,
          winner.id,
          order,
          scopeKey,
          targetRollCodes,
          rolls,
        ))
      ) {
        return this.rollFactsMismatch(order.id);
      }
      if (completion.state === 'ready_for_shipment') {
        await this.transitionOrderReady(tx, actor, order.id, completion);
      }
      return this.existingResult(winner.id, completion.state);
    }

    if (completion.state === 'ready_for_shipment') {
      await this.transitionOrderReady(tx, actor, order.id, completion);
    }
    await tx.scanRow.createMany({
      data: targetRollCodes.map((rollCode) => ({
        taskId,
        rollCode,
        fromOrderId: order.orderNumber,
        scanStatus: 'expected',
      })),
    });
    await this.audit.record(
      {
        type: 'audit:warehouse_delivery_task_created',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: taskId,
        newValue: { mode: 'delivery', status: 'open' },
        detail: {
          ...(order.warehouseCoverageWorkflowVersion === 2
            ? {
                workflowVersion: 2,
                generation: order.coverageState!.generation,
              }
            : {}),
          orderId: order.id,
          orderNumber: order.orderNumber,
          warehouseTaskId: taskId,
          rollCodes: targetRollCodes,
          rollCount: targetRollCodes.length,
        },
      },
      tx,
    );
    return {
      state: completion.state,
      deliveryTaskId: taskId,
      created: true,
      reason: null,
    };
  }

  private async transitionOrderReady(
    tx: Prisma.TransactionClient,
    actor: FulfillmentActor,
    orderId: string,
    completion: CommercialCompletion,
  ): Promise<void> {
    const transitionedAt = new Date();
    const readyClaim = await tx.commercialOrder.updateMany({
      where: { id: orderId, readyForShipmentAt: null, shipmentStatus: { not: 'shipped' } },
      data: { readyForShipmentAt: transitionedAt },
    });
    if (readyClaim.count === 1) {
      await this.recordReadyTransition(tx, actor, orderId, transitionedAt, completion);
    }
  }

  private async recordReadyTransition(
    tx: Prisma.TransactionClient,
    actor: FulfillmentActor,
    orderId: string,
    transitionedAt: Date,
    completion: CommercialCompletion,
  ): Promise<void> {
    await tx.orderResolutionCase.updateMany({
      where: {
        openScopeKey: warehouseCoverScopeKey(orderId),
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
      },
      data: {
        status: 'resolved',
        openScopeKey: null,
        outcome: 'order_ready_for_shipment',
        nextOwnerRole: null,
        resolvedAt: transitionedAt,
        version: { increment: 1 },
      },
    });
    await this.audit.record(
      {
        type: 'audit:commercial_order_ready_for_shipment',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: orderId,
        label: 'Commercial order fulfillment completed',
        newValue: {
          state: 'ready_for_shipment',
          readyForShipmentAt: transitionedAt.toISOString(),
        },
        detail: {
          requestedQty: completion.requestedQty,
          fulfilledQty: completion.fulfilledQty,
          observedShipmentState: completion.state,
          source: 'fulfillment_reconciler',
        },
      },
      tx,
    );
  }

  private taskForScope(tx: Prisma.TransactionClient, scopeKey: string) {
    return tx.warehouseAcceptanceTask.findUnique({
      where: { deliveryScopeKey: scopeKey },
      select: { id: true, rows: { select: { rollCode: true } } },
    });
  }

  private async syncDeliveryRows(
    tx: Prisma.TransactionClient,
    actor: FulfillmentActor,
    taskId: string,
    order: Pick<FulfillmentLoadedOrder, 'id' | 'orderNumber'>,
    scopeKey: string,
    expectedRollCodes: string[],
    rolls: FulfillmentLoadedRoll[],
  ): Promise<boolean> {
    const task = await tx.warehouseAcceptanceTask.findUnique({
      where: { id: taskId },
      select: {
        mode: true,
        status: true,
        orderId: true,
        positionId: true,
        proposalId: true,
        coverageDecisionId: true,
        receivingScopeKey: true,
        deliveryScopeKey: true,
        rows: {
          select: { rollCode: true, fromOrderId: true, scanStatus: true },
          orderBy: [{ rollCode: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (
      !task ||
      task.mode !== 'delivery' ||
      !['open', 'partial'].includes(task.status) ||
      task.orderId !== order.id ||
      task.positionId !== null ||
      task.proposalId !== null ||
      task.coverageDecisionId !== null ||
      task.receivingScopeKey !== null ||
      task.deliveryScopeKey !== scopeKey ||
      task.rows.length > expectedRollCodes.length ||
      task.rows.some(
        (row) =>
          row.fromOrderId !== order.orderNumber ||
          !['expected', 'accepted'].includes(row.scanStatus),
      )
    ) {
      return false;
    }
    const rollStatusByCode = new Map(rolls.map((roll) => [roll.rollCode, roll.warehouseStatus]));
    const expectedCodeSet = new Set(expectedRollCodes);
    const actualRollCodes = task.rows.map((row) => row.rollCode);
    if (
      rollStatusByCode.size !== expectedRollCodes.length ||
      new Set(actualRollCodes).size !== actualRollCodes.length ||
      actualRollCodes.some((rollCode) => !expectedCodeSet.has(rollCode)) ||
      task.rows.some((row) => {
        const warehouseStatus = rollStatusByCode.get(row.rollCode);
        return !(
          (row.scanStatus === 'expected' && warehouseStatus === 'received') ||
          (row.scanStatus === 'accepted' && warehouseStatus === 'delivered')
        );
      })
    ) {
      return false;
    }
    const actualCodeSet = new Set(actualRollCodes);
    const missingRollCodes = expectedRollCodes.filter((rollCode) => !actualCodeSet.has(rollCode));
    if (missingRollCodes.some((rollCode) => rollStatusByCode.get(rollCode) !== 'received')) {
      return false;
    }
    if (missingRollCodes.length === 0) return true;

    const reopened = await tx.warehouseAcceptanceTask.updateMany({
      where: { id: taskId, status: { in: ['open', 'partial'] } },
      data: { status: 'open' },
    });
    if (reopened.count !== 1) return false;
    await tx.scanRow.createMany({
      data: missingRollCodes.map((rollCode) => ({
        taskId,
        rollCode,
        fromOrderId: order.orderNumber,
        scanStatus: 'expected',
      })),
    });
    await this.audit.record(
      {
        type: 'audit:warehouse_delivery_task_extended',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: taskId,
        newValue: { status: 'open', addedRollCount: missingRollCodes.length },
        detail: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          warehouseTaskId: taskId,
          rollCodes: missingRollCodes,
          rollCount: missingRollCodes.length,
        },
      },
      tx,
    );
    return true;
  }

  private async lockFulfillmentRolls(
    tx: Prisma.TransactionClient,
    rollCodes: string[],
  ): Promise<void> {
    await tx.$queryRaw<Array<{ rollCode: string }>>`
      SELECT "rollCode"
      FROM "warehouse_rolls"
      WHERE "rollCode" = ANY(${rollCodes}::text[])
      ORDER BY "rollCode" COLLATE "C"
      FOR UPDATE
    `;
  }

  private rollFactsMismatch(orderId: string): OrderFulfillmentHandoffResult {
    this.logger.warn(
      `Order ${orderId} has inconsistent fulfillment roll facts; delivery handoff skipped`,
    );
    return {
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    };
  }

  private async lockDeliveryScope(tx: Prisma.TransactionClient, scopeKey: string): Promise<string> {
    const [lock] = await tx.$queryRaw<Array<{ transactionId: string }>>`
      WITH scope_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtext(${scopeKey})::bigint)
      )
      SELECT txid_current()::text AS "transactionId"
      FROM scope_lock
    `;
    if (!lock?.transactionId) {
      throw new Error(`Delivery scope ${scopeKey} lock transaction was not identified`);
    }
    return lock.transactionId;
  }

  private async assertDeliveryScopeLockProof(
    proof: FulfillmentDeliveryLockProof,
    tx: Prisma.TransactionClient,
    scopeKey: string,
  ): Promise<void> {
    const claim =
      typeof proof === 'object' && proof !== null ? deliveryLockClaims.get(proof) : undefined;
    if (!claim) {
      throw new ConflictException({
        code: 'WAREHOUSE_DELIVERY_LOCK_PROOF_INVALID',
        message: 'Delivery scope lock proof was not issued by the fulfillment lock service',
      });
    }
    if (claim.tx !== tx) {
      throw new ConflictException({
        code: 'WAREHOUSE_DELIVERY_LOCK_TRANSACTION_MISMATCH',
        message: 'Delivery scope lock proof belongs to a different transaction',
      });
    }
    if (claim.scopeKey !== scopeKey) {
      throw new ConflictException({
        code: 'WAREHOUSE_DELIVERY_LOCK_SCOPE_MISMATCH',
        message: `Expected prelocked delivery scope ${scopeKey}, received ${claim.scopeKey}`,
      });
    }
    const [current] = await tx.$queryRaw<Array<{ transactionId: string }>>`
      SELECT txid_current()::text AS "transactionId"
    `;
    if (current?.transactionId !== claim.transactionId) {
      throw new ConflictException({
        code: 'WAREHOUSE_DELIVERY_LOCK_TRANSACTION_MISMATCH',
        message: 'Delivery scope lock proof belongs to a different or completed transaction',
      });
    }
  }

  private deliveryScopeConflict(taskId: string): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_DELIVERY_SCOPE_CONFLICT',
      message: `Delivery task ${taskId} has an incompatible delivery scope`,
    });
  }

  private existingResult(
    deliveryTaskId: string,
    state: OrderFulfillmentHandoffResult['state'] = 'ready_for_shipment',
  ): OrderFulfillmentHandoffResult {
    return {
      state,
      deliveryTaskId,
      created: false,
      reason: null,
    };
  }
}
