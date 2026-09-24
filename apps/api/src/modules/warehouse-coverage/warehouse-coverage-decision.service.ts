import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { FinanceWarehouseCoverageProjection, UuidString } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import {
  OrderFulfillmentHandoffService,
  type FulfillmentDeliveryLockProof,
} from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { compareOpaqueIdsBinary } from './warehouse-coverage-canonical';
import { WarehouseCoverageCalculationService } from './warehouse-coverage-calculation.service';
import {
  coverageCommandUserActor,
  WarehouseCoverageCommandService,
} from './warehouse-coverage-command.service';
import {
  lockCoverageResources,
  type CoverageLocksHeld,
  WarehouseCoverageTransaction,
} from './warehouse-coverage-transaction';
import { assertCoverageWorkflow } from './warehouse-coverage-workflow';

export interface DecideWarehouseCoverageDto {
  clientRequestId: UuidString;
  expectedGeneration: number;
  expectedStateVersion: number;
  decision: 'use_warehouse' | 'produce_all';
}

type FinanceRoute = {
  commercialOrderId: string;
  workflowVersion: number;
};

type LockedCalculation = {
  id: string;
  orderId: string;
  generation: number;
  inventoryEpoch: bigint;
  inputFingerprint: string;
  availability: string;
  reasonCodes: unknown;
  requiredRollCount: number;
  matchedRollCount: number;
  uncertainRollCount: number;
};

type LockedState = {
  orderId: string;
  state: string;
  stateVersion: number;
  generation: number;
  currentCalculationId: string | null;
  currentDecisionId: string | null;
  currentCalculation: LockedCalculation | null;
};

type LockedMatch = {
  positionId: string;
  rollId: string;
  coverageFactId: string;
  slotIndex: number;
  roll: {
    id: string;
    rollCode: string;
    warehouseStatus: string;
    currentCoverageFactId: string | null;
    reservedForOrderId: string | null;
    reservedForPositionId: string | null;
    reservedByProposalId: string | null;
    reservedByCoverageDecisionId: string | null;
    producedForStockOrderId: string | null;
    producedForOrderId: string | null;
    releasedFromOrderId?: string | null;
  };
};

const DECISION_STATE_SELECT = {
  orderId: true,
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
      inventoryEpoch: true,
      inputFingerprint: true,
      availability: true,
      reasonCodes: true,
      requiredRollCount: true,
      matchedRollCount: true,
      uncertainRollCount: true,
    },
  },
} as const satisfies Prisma.WarehouseCoverageStateSelect;

const DECISION_MATCH_SELECT = {
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
      producedForStockOrderId: true,
      producedForOrderId: true,
      releasedFromOrderId: true,
    },
  },
} as const satisfies Prisma.WarehouseCoverageMatchSelect;

@Injectable()
export class WarehouseCoverageDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coverageTransaction: WarehouseCoverageTransaction,
    private readonly commands: WarehouseCoverageCommandService,
    private readonly projections: WarehouseCoverageCalculationService,
    private readonly fulfillment: OrderFulfillmentHandoffService,
  ) {}

  async decide(
    actor: Actor,
    financeOrderId: string,
    dto: DecideWarehouseCoverageDto,
  ): Promise<FinanceWarehouseCoverageProjection> {
    requireDecisionCapability(actor);
    const route = await this.resolveFinanceRoute(financeOrderId);
    assertV2Workflow(route.workflowVersion);
    const commandActor = coverageCommandUserActor(actor);

    return this.coverageTransaction.run(async (tx) => {
      const commandInput = {
        clientRequestId: dto.clientRequestId,
        kind: 'decide' as const,
        commercialOrderId: route.commercialOrderId,
        actor: commandActor,
        payload: {
          expectedGeneration: dto.expectedGeneration,
          expectedStateVersion: dto.expectedStateVersion,
          decision: dto.decision,
        },
      };
      const acquisition = await this.commands.acquireOrReplay(tx, commandInput);
      if (acquisition.kind === 'replay') return acquisition.safeResult;

      const deliveryLockProof = await this.fulfillment.acquireDeliveryScopeLock(
        tx,
        route.commercialOrderId,
      );
      const stateReference = await tx.warehouseCoverageState.findUnique({
        where: { orderId: route.commercialOrderId },
        select: {
          currentCalculationId: true,
          currentDecisionId: true,
        },
      });
      if (!stateReference?.currentCalculationId) {
        throw coverageConflict('warehouse_coverage_state_conflict');
      }

      const locks = await lockCoverageResources(tx, {
        clientRequestId: dto.clientRequestId,
        orderId: route.commercialOrderId,
        calculationId: stateReference.currentCalculationId,
        ...(stateReference.currentDecisionId
          ? { decisionId: stateReference.currentDecisionId }
          : {}),
        resolveRollIdsAfterCoreLocks: async (lockedTx) => {
          await assertFinanceRouteUnderLock(lockedTx, financeOrderId, route.commercialOrderId);
          if (dto.decision === 'produce_all') return [];
          return readMatchRollIds(lockedTx, stateReference.currentCalculationId!);
        },
      });

      const state = await readLockedState(tx, route.commercialOrderId);
      const calculation = assertDecidableState(state, dto);
      const currentEpoch = await readInventoryEpoch(tx);
      if (currentEpoch !== calculation.inventoryEpoch) {
        throw coverageConflict('warehouse_coverage_inventory_changed');
      }

      const decisionId = randomUUID();
      let committedInventoryEpoch: bigint | null = null;
      let reservedMatches: LockedMatch[] = [];
      if (dto.decision === 'use_warehouse') {
        const matches = await readLockedMatches(tx, calculation.id);
        assertExactDecisionSet(matches, calculation, locks);
        await reserveExactSet(tx, route.commercialOrderId, decisionId, matches);
        reservedMatches = matches;
        committedInventoryEpoch = await readInventoryEpoch(tx);
        if (committedInventoryEpoch !== calculation.inventoryEpoch + 1n) {
          throw coverageConflict('warehouse_coverage_inventory_changed');
        }
        await createReserveTask(tx, route.commercialOrderId, decisionId, matches);
      }

      await tx.warehouseCoverageDecision.create({
        data: {
          id: decisionId,
          orderId: route.commercialOrderId,
          calculationId: calculation.id,
          generation: calculation.generation,
          kind: dto.decision,
          inputFingerprint: calculation.inputFingerprint,
          sourceInventoryEpoch: calculation.inventoryEpoch,
          committedInventoryEpoch,
          expectedRollCount: dto.decision === 'use_warehouse' ? calculation.requiredRollCount : 0,
          actorKind: 'user',
          actorRole: commandActor.actorRole,
          actorId: commandActor.actorId,
          systemActorKey: null,
        },
      });

      const nextState =
        dto.decision === 'use_warehouse' ? 'warehouse_reserved' : 'production_required';
      const cas = await tx.warehouseCoverageState.updateMany({
        where: {
          orderId: route.commercialOrderId,
          state: 'awaiting_finance',
          stateVersion: dto.expectedStateVersion,
          generation: dto.expectedGeneration,
          currentCalculationId: calculation.id,
          currentDecisionId: null,
        },
        data: {
          state: nextState,
          stateVersion: { increment: 1 },
          currentDecisionId: decisionId,
        },
      });
      if (cas.count !== 1) {
        throw coverageConflict('warehouse_coverage_state_conflict');
      }

      await updateLegacyIndicators(tx, route.commercialOrderId, dto.decision);
      await this.recordDecisionAudits(
        tx,
        actor,
        route.commercialOrderId,
        calculation,
        dto.decision,
        reservedMatches,
      );
      await this.reconcileFulfillment(tx, actor, route.commercialOrderId, deliveryLockProof);

      const safeResult = await this.projections.readForFinanceLocked(tx, actor, financeOrderId);
      await this.commands.appendFinal(tx, {
        ...commandInput,
        commandId: acquisition.commandId,
        resultReference: {
          kind: 'decision',
          decisionId,
        },
        safeResult,
      });
      return safeResult;
    });
  }

  private async resolveFinanceRoute(financeOrderId: string): Promise<FinanceRoute> {
    const financeOrder = await this.prisma.financeOrder.findUnique({
      where: { id: financeOrderId },
      select: {
        commercialOrderId: true,
        commercialOrder: {
          select: { warehouseCoverageWorkflowVersion: true },
        },
      },
    });
    if (!financeOrder) {
      throw new NotFoundException(`Finance order ${financeOrderId} not found`);
    }
    return {
      commercialOrderId: financeOrder.commercialOrderId,
      workflowVersion: financeOrder.commercialOrder.warehouseCoverageWorkflowVersion,
    };
  }

  private async recordDecisionAudits(
    tx: Prisma.TransactionClient,
    actor: Actor,
    orderId: string,
    calculation: LockedCalculation,
    decision: DecideWarehouseCoverageDto['decision'],
    reservedMatches: readonly LockedMatch[],
  ): Promise<void> {
    const auditActor = {
      kind: 'user' as const,
      actorRole: actor.role,
      actorId: actor.userId,
    };
    await this.audit.record(
      {
        type: 'audit:warehouse_coverage_decided',
        actor: auditActor,
        objectId: orderId,
        detail: {
          workflowVersion: 2,
          orderId,
          generation: calculation.generation,
          decision,
          requiredRollCount: calculation.requiredRollCount,
          matchedRollCount: calculation.matchedRollCount,
        },
      },
      tx,
    );
    if (decision === 'use_warehouse') {
      await this.audit.record(
        {
          type: 'audit:warehouse_coverage_reserved',
          actor: auditActor,
          objectId: orderId,
          detail: {
            workflowVersion: 2,
            orderId,
            generation: calculation.generation,
            requiredRollCount: calculation.requiredRollCount,
            reservedRollCount: calculation.requiredRollCount,
          },
        },
        tx,
      );
      for (const match of reservedMatches.filter(
        ({ roll }) => roll.producedForStockOrderId !== null || Boolean(roll.releasedFromOrderId),
      )) {
        await this.audit.record(
          {
            type: 'audit:finished_stock_reserved',
            actor: auditActor,
            objectId: match.roll.id,
            detail: {
              orderId,
              positionId: match.positionId,
              sourceStockOrderId:
                match.roll.releasedFromOrderId ?? match.roll.producedForStockOrderId,
              generation: calculation.generation,
            },
          },
          tx,
        );
      }
    }
  }

  private async reconcileFulfillment(
    tx: Prisma.TransactionClient,
    actor: Actor,
    orderId: string,
    lockProof: FulfillmentDeliveryLockProof,
  ): Promise<void> {
    await this.fulfillment.reconcile(
      { userId: actor.userId, role: actor.role },
      orderId,
      tx,
      lockProof,
    );
  }
}

async function readLockedState(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<LockedState> {
  const state = await tx.warehouseCoverageState.findUnique({
    where: { orderId },
    select: DECISION_STATE_SELECT,
  });
  if (!state) throw coverageConflict('warehouse_coverage_state_conflict');
  return state;
}

function assertDecidableState(
  state: LockedState,
  dto: DecideWarehouseCoverageDto,
): LockedCalculation {
  const calculation = state.currentCalculation;
  const reasons = Array.isArray(calculation?.reasonCodes) ? calculation.reasonCodes : [];
  if (
    state.state !== 'awaiting_finance' ||
    state.stateVersion !== dto.expectedStateVersion ||
    state.generation !== dto.expectedGeneration ||
    state.currentCalculationId === null ||
    state.currentDecisionId !== null ||
    !calculation ||
    calculation.id !== state.currentCalculationId ||
    calculation.orderId !== state.orderId ||
    calculation.generation !== state.generation ||
    calculation.availability !== 'verified_full' ||
    !reasons.includes('full_cover_available') ||
    calculation.requiredRollCount <= 0 ||
    calculation.matchedRollCount !== calculation.requiredRollCount
  ) {
    throw coverageConflict('warehouse_coverage_decision_not_allowed');
  }
  return calculation;
}

async function readMatchRollIds(
  tx: Prisma.TransactionClient,
  calculationId: string,
): Promise<string[]> {
  const rows = await tx.warehouseCoverageMatch.findMany({
    where: { calculationId },
    select: { rollId: true },
  });
  return [...new Set(rows.map(({ rollId }) => rollId))].sort(compareOpaqueIdsBinary);
}

async function readLockedMatches(
  tx: Prisma.TransactionClient,
  calculationId: string,
): Promise<LockedMatch[]> {
  const rows = await tx.warehouseCoverageMatch.findMany({
    where: { calculationId },
    select: DECISION_MATCH_SELECT,
  });
  return [...rows].sort(
    (left, right) =>
      compareOpaqueIdsBinary(left.roll.rollCode, right.roll.rollCode) ||
      compareOpaqueIdsBinary(left.rollId, right.rollId),
  );
}

function assertExactDecisionSet(
  matches: readonly LockedMatch[],
  calculation: LockedCalculation,
  locks: CoverageLocksHeld,
): void {
  const matchRollIds = matches.map(({ rollId }) => rollId).sort(compareOpaqueIdsBinary);
  const exactRollIds = [...new Set(matchRollIds)];
  if (
    matches.length !== calculation.requiredRollCount ||
    exactRollIds.length !== matches.length ||
    exactRollIds.length !== locks.rollIds.length ||
    exactRollIds.some((id, index) => id !== locks.rollIds[index]) ||
    matches.some(
      (match) =>
        match.roll.id !== match.rollId ||
        match.roll.currentCoverageFactId !== match.coverageFactId ||
        match.roll.warehouseStatus !== 'received' ||
        match.roll.reservedForOrderId !== null ||
        match.roll.reservedForPositionId !== null ||
        match.roll.reservedByProposalId !== null ||
        match.roll.reservedByCoverageDecisionId !== null ||
        (match.roll.producedForOrderId !== null && !match.roll.releasedFromOrderId),
    )
  ) {
    throw coverageConflict('warehouse_coverage_reservation_conflict');
  }
}

async function reserveExactSet(
  tx: Prisma.TransactionClient,
  orderId: string,
  decisionId: string,
  matches: readonly LockedMatch[],
): Promise<void> {
  const now = new Date();
  const matchedRollIds = matches.map(({ rollId }) => rollId).sort(compareOpaqueIdsBinary);
  const updated = await tx.warehouseRoll.updateMany({
    where: {
      id: { in: matchedRollIds },
      reservedForOrderId: null,
      reservedForPositionId: null,
      reservedByProposalId: null,
      reservedByCoverageDecisionId: null,
      OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
      warehouseStatus: 'received',
    },
    data: {
      reservedForOrderId: orderId,
      reservedForPositionId: null,
      reservedByCoverageDecisionId: decisionId,
      reservedAt: now,
    },
  });
  if (updated.count !== matchedRollIds.length) {
    throw coverageConflict('warehouse_coverage_reservation_conflict');
  }
}

async function createReserveTask(
  tx: Prisma.TransactionClient,
  orderId: string,
  decisionId: string,
  matches: readonly LockedMatch[],
): Promise<void> {
  const taskId = randomUUID();
  await tx.warehouseAcceptanceTask.create({
    data: {
      id: taskId,
      mode: 'reserve',
      status: 'open',
      orderId,
      positionId: null,
      proposalId: null,
      coverageDecisionId: decisionId,
    },
  });
  const rows = matches.map(({ roll }) => ({
    taskId,
    rollCode: roll.rollCode,
    fromOrderId: orderId,
    scanStatus: 'expected',
  }));
  const created = await tx.scanRow.createMany({ data: rows });
  if (created.count !== rows.length) {
    throw coverageConflict('warehouse_coverage_reservation_conflict');
  }
}

async function updateLegacyIndicators(
  tx: Prisma.TransactionClient,
  orderId: string,
  decision: DecideWarehouseCoverageDto['decision'],
): Promise<void> {
  const warehouseCoverStatus = decision === 'use_warehouse' ? 'full_confirmed' : 'needs_production';
  const productionIndicator = decision === 'use_warehouse' ? 'not_started' : 'needs_production';
  await tx.commercialOrderPosition.updateMany({
    where: { orderId },
    data: { warehouseCoverStatus },
  });
  const updated = await tx.commercialOrder.updateMany({
    where: { id: orderId, warehouseCoverageWorkflowVersion: 2 },
    data: {
      warehouseCoverStatus,
      productionIndicator,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    throw coverageConflict('warehouse_coverage_state_conflict');
  }
}

async function assertFinanceRouteUnderLock(
  tx: Prisma.TransactionClient,
  financeOrderId: string,
  commercialOrderId: string,
): Promise<void> {
  const route = await tx.financeOrder.findUnique({
    where: { id: financeOrderId },
    select: { commercialOrderId: true },
  });
  if (!route || route.commercialOrderId !== commercialOrderId) {
    throw coverageConflict('warehouse_coverage_finance_route_changed');
  }
}

async function readInventoryEpoch(tx: Prisma.TransactionClient): Promise<bigint> {
  const epoch = await tx.warehouseCoverageInventoryEpoch.findUnique({
    where: { id: 1 },
    select: { epoch: true },
  });
  if (!epoch) throw coverageConflict('warehouse_coverage_epoch_missing');
  return epoch.epoch;
}

function assertV2Workflow(actual: number): void {
  assertCoverageWorkflow(actual as 1 | 2, 2);
}

function requireDecisionCapability(actor: Actor): void {
  if (!actor.capabilities.includes('warehouse_coverage:decide')) {
    throw new ForbiddenException('Missing capability: warehouse_coverage:decide');
  }
}

function coverageConflict(code: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code,
    message: 'Warehouse coverage changed concurrently. Reload and retry.',
  });
}
