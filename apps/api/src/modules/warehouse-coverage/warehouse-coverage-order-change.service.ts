import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Role } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import {
  lockCommercialOrderAggregate,
  lockCoverageResources,
} from './warehouse-coverage-transaction';
import { compareOpaqueIdsBinary } from './warehouse-coverage-canonical';

const ORDER_CHANGE_STATE_SELECT = {
  orderId: true,
  state: true,
  stateVersion: true,
  generation: true,
  currentCalculationId: true,
  currentDecisionId: true,
  currentCalculation: {
    select: {
      id: true,
      matches: { select: { rollId: true } },
    },
  },
  currentDecision: {
    select: {
      id: true,
      kind: true,
      expectedRollCount: true,
      reservedRolls: { select: { id: true } },
      producedRolls: { select: { id: true } },
      acceptanceTask: {
        select: {
          id: true,
          status: true,
          operations: { select: { id: true } },
          pallets: {
            where: { status: { not: 'voided' } },
            select: { id: true },
          },
          rows: {
            select: {
              id: true,
              scanStatus: true,
              lastScanAt: true,
              scannedByName: true,
              operations: { select: { id: true } },
              palletItems: {
                where: {
                  releasedAt: null,
                  pallet: { status: { not: 'voided' } },
                },
                orderBy: { id: 'asc' },
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      },
    },
  },
  order: {
    select: {
      productionOrder: { select: { id: true } },
      resolutionCases: {
        where: {
          status: 'open',
          coverageOrigin: {
            in: ['finance_request', 'decision_linked_physical_exception'],
          },
        },
        select: {
          id: true,
          version: true,
          coverageOrigin: true,
          sourceCoverageCalculationId: true,
          sourceCoverageDecisionId: true,
        },
        orderBy: { id: 'asc' as const },
      },
    },
  },
} satisfies Prisma.WarehouseCoverageStateSelect;

type LockedCoverageState = Prisma.WarehouseCoverageStateGetPayload<{
  select: typeof ORDER_CHANGE_STATE_SELECT;
}>;

export type WarehouseCoverageOrderChangeContext =
  | { workflowVersion: 1; orderId: string }
  | {
      workflowVersion: 2;
      orderId: string;
      state: LockedCoverageState;
      lockedRollIds: string[];
    };

export type WarehouseCoverageOrderChangeResult = {
  needsProductionReview: boolean;
  releasedRollIds: string[];
};

type OrderChangeActor = { userId: string | null; role: Role };

function binary(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareOpaqueIdsBinary);
}

function decisionRollIds(state: LockedCoverageState): string[] {
  return binary([
    ...(state.currentCalculation?.matches.map(({ rollId }) => rollId) ?? []),
    ...(state.currentDecision?.reservedRolls.map(({ id }) => id) ?? []),
    ...(state.currentDecision?.producedRolls.map(({ id }) => id) ?? []),
  ]);
}

function hasWarehousePhysicalFacts(state: LockedCoverageState): boolean {
  const decision = state.currentDecision;
  if (!decision) return false;
  if (decision.producedRolls.length > 0) return true;
  const task = decision.acceptanceTask;
  if (!task) return false;
  if (task.status !== 'open' && task.status !== 'cancelled') return true;
  if (task.operations.length > 0 || task.pallets.length > 0) return true;
  return task.rows.some(
    (row) =>
      row.scanStatus !== 'expected' ||
      row.lastScanAt !== null ||
      row.scannedByName !== null ||
      row.operations.length > 0 ||
      row.palletItems.length > 0,
  );
}

type OpenCoverageCase = LockedCoverageState['order']['resolutionCases'][number];

function exactOpenCoverageCase(state: LockedCoverageState): OpenCoverageCase | null {
  if (state.order.resolutionCases.length > 1) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
  return state.order.resolutionCases[0] ?? null;
}

function sameCoverageCase(left: OpenCoverageCase | null, right: OpenCoverageCase | null): boolean {
  return (
    left?.id === right?.id &&
    left?.version === right?.version &&
    left?.coverageOrigin === right?.coverageOrigin &&
    left?.sourceCoverageCalculationId === right?.sourceCoverageCalculationId &&
    left?.sourceCoverageDecisionId === right?.sourceCoverageDecisionId
  );
}

function coverageConflict(code: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code,
    message: 'Складское покрытие изменилось параллельно. Обновите заявку и повторите действие.',
  });
}

@Injectable()
export class WarehouseCoverageOrderChangeService {
  constructor(private readonly audit: AuditService) {}

  async lockForOrderChange(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<WarehouseCoverageOrderChangeContext> {
    const order = await tx.commercialOrder.findUnique({
      where: { id: orderId },
      select: { warehouseCoverageWorkflowVersion: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.warehouseCoverageWorkflowVersion === 1) {
      await lockCommercialOrderAggregate(tx, orderId);
      return { workflowVersion: 1, orderId };
    }
    if (order.warehouseCoverageWorkflowVersion !== 2) {
      throw coverageConflict('warehouse_coverage_workflow_mismatch');
    }

    const discovered = await this.readState(tx, orderId);
    const discoveredCase = exactOpenCoverageCase(discovered);
    const taskId = discovered.currentDecision?.acceptanceTask?.id;
    const locks = await lockCoverageResources(tx, {
      orderId,
      ...(discovered.currentCalculationId
        ? { calculationId: discovered.currentCalculationId }
        : {}),
      ...(discovered.currentDecisionId ? { decisionId: discovered.currentDecisionId } : {}),
      ...(discoveredCase?.coverageOrigin === 'finance_request'
        ? { caseId: discoveredCase.id }
        : {}),
      ...(taskId ? { taskId } : {}),
      resolveRollIdsAfterCoreLocks: async (lockedTx) =>
        decisionRollIds(await this.readState(lockedTx, orderId)),
    });
    const state = await this.readState(tx, orderId);
    const lockedCase = exactOpenCoverageCase(state);
    if (
      state.currentCalculationId !== discovered.currentCalculationId ||
      state.currentDecisionId !== discovered.currentDecisionId ||
      state.stateVersion !== discovered.stateVersion ||
      state.generation !== discovered.generation ||
      !sameCoverageCase(lockedCase, discoveredCase)
    ) {
      throw coverageConflict('warehouse_coverage_state_conflict');
    }
    const expectedRollIds = decisionRollIds(state);
    if (
      expectedRollIds.length !== locks.rollIds.length ||
      expectedRollIds.some((id, index) => id !== locks.rollIds[index])
    ) {
      throw coverageConflict('warehouse_coverage_decision_set_conflict');
    }
    return {
      workflowVersion: 2,
      orderId,
      state,
      lockedRollIds: [...locks.rollIds],
    };
  }

  async reconcileAfterOrderChange(
    tx: Prisma.TransactionClient,
    context: WarehouseCoverageOrderChangeContext,
    actor: OrderChangeActor,
    reason: string,
  ): Promise<WarehouseCoverageOrderChangeResult> {
    if (context.workflowVersion === 1) {
      return { needsProductionReview: false, releasedRollIds: [] };
    }
    const { state } = context;
    const decision = state.currentDecision;
    const coverageCase = exactOpenCoverageCase(state);
    if (coverageCase && state.state !== 'recheck_requested') {
      throw coverageConflict('warehouse_coverage_recheck_case_conflict');
    }
    let supersededFinanceCase: OpenCoverageCase | null = null;
    if (state.state === 'recheck_requested') {
      if (!coverageCase) {
        throw coverageConflict('warehouse_coverage_recheck_case_conflict');
      }
      if (coverageCase.coverageOrigin === 'decision_linked_physical_exception') {
        if (
          coverageCase.sourceCoverageCalculationId !== state.currentCalculationId ||
          coverageCase.sourceCoverageDecisionId === null
        ) {
          throw coverageConflict('warehouse_coverage_recheck_case_conflict');
        }
        await this.recordOrderSpecInvalidation(tx, context, actor, reason, {
          decisionPreserved: false,
          physicalFactsPreserved: true,
          historicalDecisionFactsPreserved: true,
          productionOrderPreserved: state.order.productionOrder !== null,
          nextState: 'recheck_requested',
          retainedCaseId: coverageCase.id,
          retainedCaseOrigin: coverageCase.coverageOrigin,
        });
        return { needsProductionReview: true, releasedRollIds: [] };
      }
      await this.supersedeFinanceRecheck(tx, context, coverageCase);
      supersededFinanceCase = coverageCase;
    }
    const physicalFacts = hasWarehousePhysicalFacts(state);
    const productionOrderExists = state.order.productionOrder !== null;
    const preserveDecision = physicalFacts || productionOrderExists;
    if (!decision || preserveDecision) {
      const invalidated = await this.markOrderSpecChanged(tx, context, preserveDecision);
      if (invalidated) {
        await this.recordOrderSpecInvalidation(tx, context, actor, reason, {
          decisionPreserved: preserveDecision,
          physicalFactsPreserved: physicalFacts,
          productionOrderPreserved: productionOrderExists,
          nextState: 'order_spec_changed',
          ...(supersededFinanceCase
            ? {
                supersededCaseId: supersededFinanceCase.id,
                supersededCaseOrigin: supersededFinanceCase.coverageOrigin,
              }
            : {}),
        });
      }
      return { needsProductionReview: preserveDecision, releasedRollIds: [] };
    }

    const releasedRollIds = binary(decision.reservedRolls.map(({ id }) => id));
    const stateUpdate = await tx.warehouseCoverageState.updateMany({
      where: this.stateWhere(context),
      data: {
        state: 'order_spec_changed',
        stateVersion: { increment: 1 },
        currentDecisionId: null,
      },
    });
    if (stateUpdate.count !== 1) {
      throw coverageConflict('warehouse_coverage_state_conflict');
    }
    const task = decision.acceptanceTask;
    if (task) {
      const taskUpdate = await tx.warehouseAcceptanceTask.updateMany({
        where: {
          id: task.id,
          coverageDecisionId: decision.id,
          status: task.status,
        },
        data: { status: 'cancelled' },
      });
      if (taskUpdate.count !== 1) {
        throw coverageConflict('warehouse_coverage_task_conflict');
      }
    }
    if (releasedRollIds.length > 0) {
      const released = await tx.warehouseRoll.updateMany({
        where: {
          id: { in: releasedRollIds },
          reservedForOrderId: context.orderId,
          reservedByCoverageDecisionId: decision.id,
        },
        data: {
          reservedForOrderId: null,
          reservedForPositionId: null,
          reservedByCoverageDecisionId: null,
          reservedAt: null,
        },
      });
      if (released.count !== releasedRollIds.length) {
        throw coverageConflict('warehouse_coverage_reservation_set_conflict');
      }
    }
    await this.recordOrderSpecInvalidation(tx, context, actor, reason, {
      decisionPreserved: false,
      physicalFactsPreserved: false,
      productionOrderPreserved: false,
      nextState: 'order_spec_changed',
      ...(supersededFinanceCase
        ? {
            supersededCaseId: supersededFinanceCase.id,
            supersededCaseOrigin: supersededFinanceCase.coverageOrigin,
          }
        : {}),
    });
    if (task || releasedRollIds.length > 0) {
      await this.audit.record(
        {
          type: 'audit:warehouse_coverage_reservation_cancelled',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: context.orderId,
          reason,
          detail: {
            orderId: context.orderId,
            decisionId: decision.id,
            generation: state.generation,
            releasedRollCount: releasedRollIds.length,
            cause: 'commercial_order_amendment',
          },
        },
        tx,
      );
    }
    return { needsProductionReview: false, releasedRollIds };
  }

  private async readState(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<LockedCoverageState> {
    const state = await tx.warehouseCoverageState.findUnique({
      where: { orderId },
      select: ORDER_CHANGE_STATE_SELECT,
    });
    if (!state) throw coverageConflict('warehouse_coverage_state_missing');
    return state;
  }

  private async markOrderSpecChanged(
    tx: Prisma.TransactionClient,
    context: Extract<WarehouseCoverageOrderChangeContext, { workflowVersion: 2 }>,
    preserveDecision: boolean,
  ): Promise<boolean> {
    if (context.state.currentCalculationId === null) {
      return false;
    }
    const stateUpdate = await tx.warehouseCoverageState.updateMany({
      where: this.stateWhere(context),
      data: {
        state: 'order_spec_changed',
        stateVersion: { increment: 1 },
        ...(!preserveDecision && context.state.currentDecisionId
          ? { currentDecisionId: null }
          : {}),
      },
    });
    if (stateUpdate.count !== 1) {
      throw coverageConflict('warehouse_coverage_state_conflict');
    }
    return true;
  }

  private async supersedeFinanceRecheck(
    tx: Prisma.TransactionClient,
    context: Extract<WarehouseCoverageOrderChangeContext, { workflowVersion: 2 }>,
    coverageCase: OpenCoverageCase,
  ): Promise<void> {
    if (
      coverageCase.coverageOrigin !== 'finance_request' ||
      coverageCase.sourceCoverageDecisionId !== null ||
      coverageCase.sourceCoverageCalculationId !== context.state.currentCalculationId
    ) {
      throw coverageConflict('warehouse_coverage_recheck_case_conflict');
    }
    const closed = await tx.orderResolutionCase.updateMany({
      where: {
        id: coverageCase.id,
        orderId: context.orderId,
        status: 'open',
        version: coverageCase.version,
        coverageOrigin: 'finance_request',
        sourceCoverageCalculationId: coverageCase.sourceCoverageCalculationId,
        sourceCoverageDecisionId: null,
      },
      data: {
        status: 'resolved',
        openScopeKey: null,
        outcome: 'superseded_by_commercial_order_change',
        nextOwnerRole: null,
        resolvedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (closed.count !== 1) {
      throw coverageConflict('warehouse_coverage_recheck_case_conflict');
    }
  }

  private recordOrderSpecInvalidation(
    tx: Prisma.TransactionClient,
    context: Extract<WarehouseCoverageOrderChangeContext, { workflowVersion: 2 }>,
    actor: OrderChangeActor,
    reason: string,
    detail: {
      decisionPreserved: boolean;
      physicalFactsPreserved: boolean;
      historicalDecisionFactsPreserved?: boolean;
      productionOrderPreserved: boolean;
      nextState: 'order_spec_changed' | 'recheck_requested';
      supersededCaseId?: string;
      supersededCaseOrigin?: string | null;
      retainedCaseId?: string;
      retainedCaseOrigin?: string | null;
    },
  ): Promise<unknown> {
    return this.audit.record(
      {
        type: 'audit:warehouse_coverage_order_spec_invalidated',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: context.orderId,
        reason,
        detail: {
          orderId: context.orderId,
          calculationId: context.state.currentCalculationId,
          decisionId: context.state.currentDecisionId,
          generation: context.state.generation,
          previousState: context.state.state,
          ...detail,
          cause: 'commercial_order_amendment',
        },
      },
      tx,
    );
  }

  private stateWhere(
    context: Extract<WarehouseCoverageOrderChangeContext, { workflowVersion: 2 }>,
  ) {
    return {
      orderId: context.orderId,
      stateVersion: context.state.stateVersion,
      generation: context.state.generation,
      currentCalculationId: context.state.currentCalculationId,
      currentDecisionId: context.state.currentDecisionId,
    };
  }
}
