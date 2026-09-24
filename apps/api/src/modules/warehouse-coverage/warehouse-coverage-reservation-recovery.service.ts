import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UtcIsoString, WarehouseCoverageProjection } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY } from '../../common/audit/audit-actor';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CoveragePhysicalExceptionDto } from '../warehouse/dto/coverage-physical-exception.dto';
import { compareOpaqueIdsBinary } from './warehouse-coverage-canonical';
import {
  type CoverageCommandInputByKind,
  WarehouseCoverageCommandService,
} from './warehouse-coverage-command.service';
import {
  lockCoverageResources,
  WarehouseCoverageTransaction,
} from './warehouse-coverage-transaction';
import { assertCoverageWorkflow } from './warehouse-coverage-workflow';

export interface WarehouseCoverageDecisionTaskProjection {
  taskId: string;
  status: 'open' | 'partial' | 'closed' | 'exception';
  updatedAt: UtcIsoString;
  generation: number;
  stateVersion: number;
  rows: Array<{
    scanRowId: string;
    rollCode: string;
    scanStatus: string;
  }>;
}

type RecoveryResult = WarehouseCoverageProjection & { caseId: string };

const DISCOVERY_SELECT = {
  id: true,
  orderId: true,
  coverageDecisionId: true,
  coverageDecision: {
    select: {
      id: true,
      orderId: true,
      calculationId: true,
    },
  },
} as const satisfies Prisma.WarehouseAcceptanceTaskSelect;

const LOCKED_STATE_SELECT = {
  orderId: true,
  state: true,
  stateVersion: true,
  generation: true,
  currentCalculationId: true,
  currentDecisionId: true,
  order: {
    select: {
      warehouseCoverageWorkflowVersion: true,
      productionOrder: { select: { id: true } },
    },
  },
  currentCalculation: true,
  currentDecision: true,
} as const satisfies Prisma.WarehouseCoverageStateSelect;

const CASE_SELECT = {
  id: true,
  openScopeKey: true,
  orderId: true,
  type: true,
  status: true,
  ownerRole: true,
  coverageScope: true,
  coverageOrigin: true,
  sourceCoverageCalculationId: true,
  sourceCoverageDecisionId: true,
  sourceCoverageStateVersion: true,
} as const satisfies Prisma.OrderResolutionCaseSelect;

const DECISION_TASK_SELECT = {
  id: true,
  status: true,
  updatedAt: true,
  coverageDecisionId: true,
  rows: {
    select: {
      id: true,
      rollCode: true,
      scanStatus: true,
    },
    orderBy: { id: 'asc' as const },
  },
  coverageDecision: {
    select: {
      id: true,
      orderId: true,
      calculationId: true,
      generation: true,
      kind: true,
      order: {
        select: {
          warehouseCoverageWorkflowVersion: true,
          coverageState: {
            select: {
              generation: true,
              stateVersion: true,
              currentCalculationId: true,
              currentDecisionId: true,
            },
          },
        },
      },
    },
  },
} as const satisfies Prisma.WarehouseAcceptanceTaskSelect;

type LockedState = Prisma.WarehouseCoverageStateGetPayload<{
  select: typeof LOCKED_STATE_SELECT;
}>;
type RecoveryCase = Prisma.OrderResolutionCaseGetPayload<{
  select: typeof CASE_SELECT;
}>;
type DecisionMatch = {
  rollId: string;
  coverageFactId: string;
  positionId: string;
};

@Injectable()
export class WarehouseCoverageReservationRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coverageTransaction: WarehouseCoverageTransaction,
    private readonly commands: WarehouseCoverageCommandService,
  ) {}

  async readDecisionTask(
    actor: Actor,
    taskId: string,
  ): Promise<WarehouseCoverageDecisionTaskProjection | null> {
    requireWarehouseReadCapability(actor);
    const normalizedTaskId = requireOpaqueId(taskId, 'taskId');
    const task = await this.prisma.warehouseAcceptanceTask.findUnique({
      where: { id: normalizedTaskId },
      select: DECISION_TASK_SELECT,
    });
    if (!task) throw new NotFoundException(`Acceptance task ${normalizedTaskId} not found`);
    if (!task.coverageDecisionId) return null;

    const decision = task.coverageDecision;
    const state = decision?.order.coverageState;
    if (
      !decision ||
      !state ||
      decision.id !== task.coverageDecisionId ||
      decision.kind !== 'use_warehouse' ||
      decision.generation !== state.generation ||
      decision.calculationId !== state.currentCalculationId ||
      (state.currentDecisionId !== null && state.currentDecisionId !== decision.id)
    ) {
      throw coverageConflict('warehouse_coverage_task_provenance_conflict');
    }
    assertCoverageWorkflow(decision.order.warehouseCoverageWorkflowVersion as 1 | 2, 2);
    const status = decisionTaskStatus(task.status);
    return {
      taskId: task.id,
      status,
      updatedAt: task.updatedAt.toISOString(),
      generation: state.generation,
      stateVersion: state.stateVersion,
      rows: task.rows.map((row) => ({
        scanRowId: row.id,
        rollCode: row.rollCode,
        scanStatus: row.scanStatus,
      })),
    };
  }

  async reportPhysicalException(
    actor: Actor,
    taskId: string,
    dto: CoveragePhysicalExceptionDto,
  ): Promise<RecoveryResult> {
    requireReportCapability(actor);
    const normalizedTaskId = requireOpaqueId(taskId, 'taskId');
    const reason = canonicalReason(dto.reason);
    const expectedTaskUpdatedAt = canonicalUtcIso(
      dto.expectedTaskUpdatedAt,
      'expectedTaskUpdatedAt',
    );
    const evidenceRef =
      dto.evidenceRef === undefined ? undefined : requireOpaqueId(dto.evidenceRef, 'evidenceRef');
    const discovered = await this.discoverTaskScope(normalizedTaskId);

    return this.coverageTransaction.run(async (tx) => {
      const commandInput = {
        clientRequestId: dto.clientRequestId,
        kind: 'cancel_reservation',
        commercialOrderId: discovered.orderId,
        scopeTaskId: normalizedTaskId,
        actor: {
          kind: 'system',
          systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
        },
        payload: {
          expectedGeneration: dto.expectedGeneration,
          expectedStateVersion: dto.expectedStateVersion,
          expectedTaskUpdatedAt,
          scanRowId: requireOpaqueId(dto.scanRowId, 'scanRowId'),
          exceptionKind: dto.kind,
          reason,
          ...(evidenceRef === undefined ? {} : { evidenceRef }),
        },
      } satisfies CoverageCommandInputByKind<'cancel_reservation'>;
      const acquisition = await this.commands.acquireRecoveryOrReplay(tx, commandInput);
      if (acquisition.kind === 'replay') return acquisition.safeResult;

      let prepared:
        | {
            state: LockedState;
            resolutionCase: RecoveryCase;
            createdCase: boolean;
            matches: readonly DecisionMatch[];
            taskUpdatedAt: Date;
            taskStatus: string;
            scanRowRollCode: string;
          }
        | undefined;

      const locks = await lockCoverageResources(tx, {
        clientRequestId: dto.clientRequestId,
        orderId: discovered.orderId,
        calculationId: discovered.calculationId,
        decisionId: discovered.decisionId,
        resolveRollIdsAfterCoreLocks: async (lockedTx) => {
          const state = await this.requireRecoveryState(
            lockedTx,
            discovered,
            dto.expectedGeneration,
            dto.expectedStateVersion,
          );
          const caseResult = await createOrReusePhysicalExceptionCase(lockedTx, {
            actor,
            orderId: discovered.orderId,
            calculationId: discovered.calculationId,
            decisionId: discovered.decisionId,
            sourceStateVersion: state.stateVersion,
            reason,
          });
          await lockPhysicalExceptionCase(lockedTx, caseResult.resolutionCase);
          await lockDecisionTask(lockedTx, {
            taskId: normalizedTaskId,
            orderId: discovered.orderId,
            decisionId: discovered.decisionId,
          });
          await lockScanRow(lockedTx, normalizedTaskId, dto.scanRowId);

          const [task, scanRow, matches, reservedDecisionRolls] = await Promise.all([
            lockedTx.warehouseAcceptanceTask.findUnique({
              where: { id: normalizedTaskId },
              select: {
                id: true,
                mode: true,
                status: true,
                orderId: true,
                positionId: true,
                proposalId: true,
                coverageDecisionId: true,
                updatedAt: true,
              },
            }),
            lockedTx.scanRow.findUnique({
              where: { id: dto.scanRowId },
              select: { id: true, taskId: true, rollCode: true },
            }),
            readDecisionMatches(lockedTx, discovered.calculationId),
            lockedTx.warehouseRoll.findMany({
              where: { reservedByCoverageDecisionId: discovered.decisionId },
              select: { id: true },
            }),
          ]);
          if (
            !task ||
            task.id !== normalizedTaskId ||
            task.mode !== 'reserve' ||
            (task.status !== 'open' && task.status !== 'partial') ||
            task.orderId !== discovered.orderId ||
            task.positionId !== null ||
            task.proposalId !== null ||
            task.coverageDecisionId !== discovered.decisionId ||
            task.updatedAt.toISOString() !== expectedTaskUpdatedAt
          ) {
            throw coverageConflict('warehouse_coverage_task_conflict');
          }
          if (!scanRow || scanRow.taskId !== task.id) {
            throw coverageConflict('warehouse_coverage_scan_row_conflict');
          }
          const calculation = state.currentCalculation;
          const decision = state.currentDecision;
          if (
            !calculation ||
            !decision ||
            matches.length !== decision.expectedRollCount ||
            matches.length !== calculation.requiredRollCount ||
            matches.length !== calculation.matchedRollCount
          ) {
            throw coverageConflict('warehouse_coverage_decision_set_conflict');
          }
          prepared = {
            state,
            resolutionCase: caseResult.resolutionCase,
            createdCase: caseResult.created,
            matches,
            taskUpdatedAt: task.updatedAt,
            taskStatus: task.status,
            scanRowRollCode: scanRow.rollCode,
          };
          return [
            ...matches.map(({ rollId }) => rollId),
            ...reservedDecisionRolls.map(({ id }) => id),
          ];
        },
      });
      if (!prepared) throw invariant('physical recovery context was not prepared');
      const context = prepared;
      assertExactRollLocks(context.matches, locks.rollIds);

      const rolls = await readDecisionRolls(tx, locks.rollIds);
      assertExactReservedDecisionSet(
        rolls,
        context.matches,
        discovered.orderId,
        discovered.decisionId,
        context.scanRowRollCode,
      );
      const membershipRows = context.matches.map((match) => ({
        caseId: context.resolutionCase.id,
        orderId: discovered.orderId,
        rollId: match.rollId,
        sourceCalculationId: discovered.calculationId,
        sourceDecisionId: discovered.decisionId,
        sourceCoverageFactId: match.coverageFactId,
        sourceKind: 'decision_match',
        reasonCodes: [] as Prisma.InputJsonValue,
      }));
      if (context.createdCase) {
        const created = await tx.warehouseCoverageRecheckMembership.createMany({
          data: membershipRows,
        });
        if (created.count !== membershipRows.length) {
          throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
        }
      } else {
        await assertExistingDecisionMembership(tx, context.resolutionCase.id, membershipRows);
      }

      const released = await tx.warehouseRoll.updateMany({
        where: {
          reservedByCoverageDecisionId: discovered.decisionId,
          reservedForOrderId: discovered.orderId,
        },
        data: {
          reservedForOrderId: null,
          reservedForPositionId: null,
          reservedByCoverageDecisionId: null,
          reservedAt: null,
        },
      });
      if (released.count !== context.state.currentDecision?.expectedRollCount) {
        throw coverageConflict('warehouse_coverage_reservation_set_conflict');
      }

      const taskUpdate = await tx.warehouseAcceptanceTask.updateMany({
        where: {
          id: normalizedTaskId,
          status: context.taskStatus,
          updatedAt: context.taskUpdatedAt,
          coverageDecisionId: discovered.decisionId,
        },
        data: { status: 'exception' },
      });
      if (taskUpdate.count !== 1) {
        throw coverageConflict('warehouse_coverage_task_conflict');
      }

      const stateUpdate = await tx.warehouseCoverageState.updateMany({
        where: {
          orderId: discovered.orderId,
          state: 'warehouse_reserved',
          stateVersion: dto.expectedStateVersion,
          generation: dto.expectedGeneration,
          currentCalculationId: discovered.calculationId,
          currentDecisionId: discovered.decisionId,
        },
        data: {
          state: 'recheck_requested',
          stateVersion: { increment: 1 },
          currentDecisionId: null,
        },
      });
      if (stateUpdate.count !== 1) {
        throw coverageConflict('warehouse_coverage_state_conflict');
      }

      const safeResult = physicalRecoveryProjection(context.state, context.resolutionCase.id);
      for (const roll of rolls.filter(
        ({ producedForStockOrderId, producedForStockOrder }) =>
          producedForStockOrderId !== null &&
          producedForStockOrder?.requestType === 'stock_reserve',
      )) {
        await this.audit.record(
          {
            type: 'audit:finished_stock_reservation_released',
            actor: {
              kind: 'user',
              actorRole: actor.role,
              actorId: actor.userId,
            },
            objectId: roll.id,
            reason,
            detail: {
              orderId: discovered.orderId,
              sourceStockOrderId: roll.producedForStockOrderId,
              decisionId: discovered.decisionId,
              caseId: context.resolutionCase.id,
              taskId: normalizedTaskId,
              generation: context.state.generation,
            },
          },
          tx,
        );
      }
      await this.audit.record(
        {
          type: 'audit:warehouse_coverage_reservation_cancelled',
          actor: {
            kind: 'user',
            actorRole: actor.role,
            actorId: actor.userId,
          },
          objectId: discovered.orderId,
          reason,
          detail: {
            workflowVersion: 2,
            generation: context.state.generation,
            taskId: normalizedTaskId,
            decisionId: discovered.decisionId,
            caseId: context.resolutionCase.id,
            exceptionKind: dto.kind,
            releasedRollCount: released.count,
          },
        },
        tx,
      );
      if (context.createdCase) {
        await this.audit.record(
          {
            type: 'audit:warehouse_coverage_recheck_requested',
            actor: {
              kind: 'user',
              actorRole: actor.role,
              actorId: actor.userId,
            },
            objectId: discovered.orderId,
            reason,
            detail: {
              workflowVersion: 2,
              caseId: context.resolutionCase.id,
              sourceCoverageDecisionId: discovered.decisionId,
              membershipCount: membershipRows.length,
            },
          },
          tx,
        );
      }
      await this.commands.appendFinal(tx, {
        ...commandInput,
        commandId: acquisition.commandId,
        resultReference: {
          kind: 'recheck_case',
          caseId: context.resolutionCase.id,
        },
        safeResult,
      });
      return safeResult;
    });
  }

  private async discoverTaskScope(taskId: string): Promise<{
    orderId: string;
    decisionId: string;
    calculationId: string;
  }> {
    const task = await this.prisma.warehouseAcceptanceTask.findUnique({
      where: { id: taskId },
      select: DISCOVERY_SELECT,
    });
    if (!task) throw new NotFoundException(`Acceptance task ${taskId} not found`);
    if (
      !task.orderId ||
      !task.coverageDecisionId ||
      !task.coverageDecision ||
      task.coverageDecision.id !== task.coverageDecisionId ||
      task.coverageDecision.orderId !== task.orderId
    ) {
      throw coverageConflict('warehouse_coverage_dedicated_recovery_required');
    }
    return {
      orderId: task.orderId,
      decisionId: task.coverageDecisionId,
      calculationId: task.coverageDecision.calculationId,
    };
  }

  private async requireRecoveryState(
    tx: Prisma.TransactionClient,
    discovered: { orderId: string; decisionId: string; calculationId: string },
    expectedGeneration: number,
    expectedStateVersion: number,
  ): Promise<LockedState> {
    const state = await tx.warehouseCoverageState.findUnique({
      where: { orderId: discovered.orderId },
      select: LOCKED_STATE_SELECT,
    });
    if (!state) throw coverageConflict('warehouse_coverage_state_conflict');
    assertCoverageWorkflow(state.order.warehouseCoverageWorkflowVersion as 1 | 2, 2);
    const calculation = state.currentCalculation;
    const decision = state.currentDecision;
    if (
      state.state !== 'warehouse_reserved' ||
      state.stateVersion !== expectedStateVersion ||
      state.generation !== expectedGeneration ||
      state.currentCalculationId !== discovered.calculationId ||
      state.currentDecisionId !== discovered.decisionId ||
      !calculation ||
      calculation.id !== discovered.calculationId ||
      calculation.orderId !== discovered.orderId ||
      calculation.generation !== expectedGeneration ||
      calculation.availability !== 'verified_full' ||
      !decision ||
      decision.id !== discovered.decisionId ||
      decision.orderId !== discovered.orderId ||
      decision.calculationId !== discovered.calculationId ||
      decision.generation !== expectedGeneration ||
      decision.kind !== 'use_warehouse' ||
      state.order.productionOrder !== null
    ) {
      throw coverageConflict('warehouse_coverage_state_conflict');
    }
    return state;
  }
}

async function createOrReusePhysicalExceptionCase(
  tx: Prisma.TransactionClient,
  input: {
    actor: Actor;
    orderId: string;
    calculationId: string;
    decisionId: string;
    sourceStateVersion: number;
    reason: string;
  },
): Promise<{ resolutionCase: RecoveryCase; created: boolean }> {
  const coverageScope = `warehouse_coverage_v2:${input.orderId}`;
  const openScopeKey = `${coverageScope}:decision_linked_physical_exception`;
  const existing = await tx.orderResolutionCase.findUnique({
    where: { openScopeKey },
    select: CASE_SELECT,
  });
  if (existing) {
    assertPhysicalExceptionCase(existing, {
      openScopeKey,
      coverageScope,
      orderId: input.orderId,
      calculationId: input.calculationId,
      decisionId: input.decisionId,
      sourceStateVersion: input.sourceStateVersion,
    });
    return { resolutionCase: existing, created: false };
  }
  const resolutionCase = await tx.orderResolutionCase.create({
    data: {
      openScopeKey,
      orderId: input.orderId,
      type: 'warehouse_coverage_physical_exception',
      status: 'open',
      ownerRole: 'warehouse',
      affectedPositionIds: [],
      affectedRollIds: [],
      reason: input.reason,
      createdByRole: 'warehouse',
      createdById: input.actor.userId,
      coverageScope,
      coverageOrigin: 'decision_linked_physical_exception',
      sourceCoverageCalculationId: input.calculationId,
      sourceCoverageDecisionId: input.decisionId,
      sourceCoverageStateVersion: input.sourceStateVersion,
    },
    select: CASE_SELECT,
  });
  return { resolutionCase, created: true };
}

function assertPhysicalExceptionCase(
  resolutionCase: RecoveryCase,
  expected: {
    openScopeKey: string;
    coverageScope: string;
    orderId: string;
    calculationId: string;
    decisionId: string;
    sourceStateVersion: number;
  },
): void {
  if (
    resolutionCase.openScopeKey !== expected.openScopeKey ||
    resolutionCase.coverageScope !== expected.coverageScope ||
    resolutionCase.coverageOrigin !== 'decision_linked_physical_exception' ||
    resolutionCase.type !== 'warehouse_coverage_physical_exception' ||
    resolutionCase.status !== 'open' ||
    resolutionCase.ownerRole !== 'warehouse' ||
    resolutionCase.orderId !== expected.orderId ||
    resolutionCase.sourceCoverageCalculationId !== expected.calculationId ||
    resolutionCase.sourceCoverageDecisionId !== expected.decisionId ||
    resolutionCase.sourceCoverageStateVersion !== expected.sourceStateVersion
  ) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
}

async function lockPhysicalExceptionCase(
  tx: Prisma.TransactionClient,
  resolutionCase: RecoveryCase,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "order_resolution_cases"
               WHERE "id" = ${resolutionCase.id}
                 AND "openScopeKey" = ${resolutionCase.openScopeKey}
                 AND "orderId" = ${resolutionCase.orderId}
                 AND "status" = 'open'
                 AND "coverageOrigin" = 'decision_linked_physical_exception'
                 AND "sourceCoverageCalculationId" =
                   ${resolutionCase.sourceCoverageCalculationId}
                 AND "sourceCoverageDecisionId" =
                   CAST(${resolutionCase.sourceCoverageDecisionId} AS UUID)
               FOR UPDATE`,
  );
  if (rows.length !== 1 || rows[0]?.id !== resolutionCase.id) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
}

async function lockDecisionTask(
  tx: Prisma.TransactionClient,
  input: { taskId: string; orderId: string; decisionId: string },
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "warehouse_acceptance_tasks"
               WHERE "id" = ${input.taskId}
                 AND "orderId" = ${input.orderId}
                 AND "coverageDecisionId" = CAST(${input.decisionId} AS UUID)
               FOR UPDATE`,
  );
  if (rows.length !== 1 || rows[0]?.id !== input.taskId) {
    throw coverageConflict('warehouse_coverage_task_conflict');
  }
}

async function lockScanRow(
  tx: Prisma.TransactionClient,
  taskId: string,
  scanRowId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "scan_rows"
               WHERE "id" = ${scanRowId}
                 AND "taskId" = ${taskId}
               FOR UPDATE`,
  );
  if (rows.length !== 1 || rows[0]?.id !== scanRowId) {
    throw coverageConflict('warehouse_coverage_scan_row_conflict');
  }
}

async function readDecisionMatches(
  tx: Prisma.TransactionClient,
  calculationId: string,
): Promise<DecisionMatch[]> {
  return tx.$queryRaw<DecisionMatch[]>(
    Prisma.sql`SELECT "rollId", "coverageFactId", "positionId"
               FROM "warehouse_coverage_matches"
               WHERE "calculationId" = ${calculationId}
               ORDER BY "rollId" COLLATE "C"`,
  );
}

type DecisionRoll = {
  id: string;
  rollCode: string;
  producedForStockOrderId: string | null;
  producedForStockOrder: { requestType: string } | null;
  currentCoverageFactId: string | null;
  reservedForOrderId: string | null;
  reservedForPositionId: string | null;
  reservedByProposalId: string | null;
  reservedByCoverageDecisionId: string | null;
  reservedAt: Date | null;
};

async function readDecisionRolls(
  tx: Prisma.TransactionClient,
  rollIds: readonly string[],
): Promise<DecisionRoll[]> {
  const rows = await tx.warehouseRoll.findMany({
    where: { id: { in: [...rollIds] } },
    select: {
      id: true,
      rollCode: true,
      producedForStockOrderId: true,
      producedForStockOrder: { select: { requestType: true } },
      currentCoverageFactId: true,
      reservedForOrderId: true,
      reservedForPositionId: true,
      reservedByProposalId: true,
      reservedByCoverageDecisionId: true,
      reservedAt: true,
    },
  });
  return rows.sort((left, right) => compareOpaqueIdsBinary(left.id, right.id));
}

function assertExactReservedDecisionSet(
  rolls: readonly DecisionRoll[],
  matches: readonly DecisionMatch[],
  orderId: string,
  decisionId: string,
  exceptionRollCode: string,
): void {
  if (
    rolls.length !== matches.length ||
    rolls.some((roll, index) => {
      const match = matches[index];
      return (
        !match ||
        roll.id !== match.rollId ||
        roll.currentCoverageFactId !== match.coverageFactId ||
        roll.reservedForOrderId !== orderId ||
        roll.reservedForPositionId !== null ||
        roll.reservedByProposalId !== null ||
        roll.reservedByCoverageDecisionId !== decisionId ||
        roll.reservedAt === null
      );
    })
  ) {
    throw coverageConflict('warehouse_coverage_reservation_set_conflict');
  }
  if (rolls.filter((roll) => roll.rollCode === exceptionRollCode).length !== 1) {
    throw coverageConflict('warehouse_coverage_scan_row_conflict');
  }
}

function assertExactRollLocks(
  matches: readonly DecisionMatch[],
  lockedRollIds: readonly string[],
): void {
  if (
    matches.length !== lockedRollIds.length ||
    matches.some((match, index) => match.rollId !== lockedRollIds[index])
  ) {
    throw coverageConflict('warehouse_coverage_decision_set_conflict');
  }
}

async function assertExistingDecisionMembership(
  tx: Prisma.TransactionClient,
  caseId: string,
  expected: readonly {
    caseId: string;
    orderId: string;
    rollId: string;
    sourceCalculationId: string;
    sourceDecisionId: string;
    sourceCoverageFactId: string;
    sourceKind: string;
    reasonCodes: Prisma.InputJsonValue;
  }[],
): Promise<void> {
  const actual = await tx.warehouseCoverageRecheckMembership.findMany({
    where: { caseId },
    select: {
      caseId: true,
      orderId: true,
      rollId: true,
      sourceCalculationId: true,
      sourceDecisionId: true,
      sourceCoverageFactId: true,
      sourceKind: true,
      reasonCodes: true,
    },
  });
  actual.sort((left, right) => compareOpaqueIdsBinary(left.rollId, right.rollId));
  if (
    actual.length !== expected.length ||
    actual.some((row, index) => {
      const candidate = expected[index];
      return (
        !candidate ||
        row.caseId !== candidate.caseId ||
        row.orderId !== candidate.orderId ||
        row.rollId !== candidate.rollId ||
        row.sourceCalculationId !== candidate.sourceCalculationId ||
        row.sourceDecisionId !== candidate.sourceDecisionId ||
        row.sourceCoverageFactId !== candidate.sourceCoverageFactId ||
        row.sourceKind !== 'decision_match' ||
        !Array.isArray(row.reasonCodes) ||
        row.reasonCodes.length !== 0
      );
    })
  ) {
    throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
  }
}

function physicalRecoveryProjection(state: LockedState, caseId: string): RecoveryResult {
  const calculation = state.currentCalculation;
  if (!calculation) throw invariant('current calculation is required');
  return {
    workflowVersion: 2,
    state: 'recheck_requested',
    stateVersion: state.stateVersion + 1,
    generation: state.generation,
    availability: 'unknown',
    reasonCodes: ['warehouse_recheck_pending'],
    nextOwner: 'warehouse',
    availableActions: [],
    requiredRollCount: calculation.requiredRollCount,
    matchedRollCount: calculation.matchedRollCount,
    uncertainRollCount: calculation.uncertainRollCount,
    calculatedAt: calculation.calculatedAt.toISOString(),
    stale: false,
    caseId,
  };
}

function canonicalReason(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('reason is required');
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (result.length < 3 || result.length > 500) {
    throw new BadRequestException('reason must contain 3 to 500 characters');
  }
  return result;
}

function canonicalUtcIso(value: unknown, field: string): UtcIsoString {
  if (
    typeof value !== 'string' ||
    !value.endsWith('Z') ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new BadRequestException(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function requireOpaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function requireWarehouseReadCapability(actor: Actor): void {
  if (!actor.capabilities.includes('warehouse_task:read')) {
    throw new ForbiddenException('Missing capability: warehouse_task:read');
  }
}

function requireReportCapability(actor: Actor): void {
  if (!actor.capabilities.includes('warehouse_coverage:report_physical_exception')) {
    throw new ForbiddenException(
      'Missing capability: warehouse_coverage:report_physical_exception',
    );
  }
}

function decisionTaskStatus(value: string): WarehouseCoverageDecisionTaskProjection['status'] {
  if (!['open', 'partial', 'closed', 'exception'].includes(value)) {
    throw coverageConflict('warehouse_coverage_task_status_conflict');
  }
  return value as WarehouseCoverageDecisionTaskProjection['status'];
}

function coverageConflict(code: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code,
    message: 'Warehouse coverage changed concurrently. Reload and retry.',
  });
}

function invariant(detail: string): Error {
  return new Error(`Warehouse coverage recovery invariant: ${detail}`);
}
