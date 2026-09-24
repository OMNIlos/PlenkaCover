import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  FinanceWarehouseCoverageProjection,
  UuidString,
  WarehouseCoverageReasonCode,
  WarehouseCoverageProjection,
} from '@plenka/contracts';
import { WAREHOUSE_COVERAGE_REASON_CODES } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  compareOpaqueIdsBinary,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
  type CanonicalRollCoverageSpec,
} from './warehouse-coverage-canonical';
import {
  resolveCoverageCandidateRollIdsAfterCoreLocks,
  WarehouseCoverageCalculationService,
} from './warehouse-coverage-calculation.service';
import {
  type CanonicalWarehouseCoverageCorrectionCommand,
  type CoverageCommandInputByKind,
  coverageCommandUserActor,
  WarehouseCoverageCommandService,
} from './warehouse-coverage-command.service';
import {
  COVERAGE_LOCKS_HELD,
  lockCoverageResources,
  type CoverageLocksHeld,
  WarehouseCoverageTransaction,
} from './warehouse-coverage-transaction';
import { assertCoverageWorkflow } from './warehouse-coverage-workflow';
import type { ResolveWarehouseCoverageRecheckDto } from '../warehouse/dto/warehouse-coverage-recheck.dto';
import {
  canonicalizeWarehouseCoverageCorrectionCommand,
  mapWarehouseCoverageCorrection,
  type WarehouseCoverageCorrectionContext,
  type WarehouseCoverageRecheckItem,
} from '../warehouse/warehouse-coverage-recheck.mapper';
import { WarehouseRollCoverageFactService } from './warehouse-roll-coverage-fact.service';

export interface RequestWarehouseCoverageRecheckDto {
  clientRequestId: UuidString;
  expectedGeneration: number;
  expectedStateVersion: number;
  reason: string;
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
  availability: string;
  verifiedCandidateRollIds: Prisma.JsonValue;
  uncertainCandidateRollIds: Prisma.JsonValue;
};

type LockedDecision = {
  id: string;
  orderId: string;
  calculationId: string;
  generation: number;
  kind: string;
};

type LockedState = {
  orderId: string;
  state: string;
  stateVersion: number;
  generation: number;
  currentCalculationId: string | null;
  currentDecisionId: string | null;
  currentCalculation: LockedCalculation | null;
  currentDecision: LockedDecision | null;
  order: {
    warehouseCoverageWorkflowVersion: number;
    productionOrder: { id: string } | null;
  };
};

type CoverageCase = {
  id: string;
  openScopeKey: string | null;
  orderId: string;
  status: string;
  coverageScope: string | null;
  coverageOrigin: string | null;
  sourceCoverageCalculationId: string | null;
  sourceCoverageDecisionId: string | null;
  sourceCoverageStateVersion: number | null;
};

type CandidateSet = {
  verified: readonly string[];
  uncertain: readonly string[];
  all: readonly string[];
};

type LockedCandidateRoll = {
  id: string;
  rollCode: string;
  ownerCounterpartyId: string | null;
  currentCoverageFactId: string | null;
  currentCoverageFact: {
    id: string;
    specVersion: string;
    specFingerprint: string;
    spec: Prisma.JsonValue;
  } | null;
};

type MembershipRow = {
  caseId: string;
  orderId: string;
  rollId: string;
  sourceCalculationId: string;
  sourceDecisionId: null;
  sourceCoverageFactId: string | null;
  sourceKind: 'verified_candidate' | 'uncertain_candidate';
  reasonCodes: WarehouseCoverageReasonCode[];
};

const LOCKED_STATE_SELECT = {
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
      availability: true,
      verifiedCandidateRollIds: true,
      uncertainCandidateRollIds: true,
    },
  },
  currentDecision: {
    select: {
      id: true,
      orderId: true,
      calculationId: true,
      generation: true,
      kind: true,
    },
  },
  order: {
    select: {
      warehouseCoverageWorkflowVersion: true,
      productionOrder: { select: { id: true } },
    },
  },
} as const satisfies Prisma.WarehouseCoverageStateSelect;

const LOCKED_CANDIDATE_SELECT = {
  id: true,
  rollCode: true,
  ownerCounterpartyId: true,
  currentCoverageFactId: true,
  currentCoverageFact: {
    select: {
      id: true,
      specVersion: true,
      specFingerprint: true,
      spec: true,
    },
  },
} as const satisfies Prisma.WarehouseRollSelect;

const CASE_SELECT = {
  id: true,
  openScopeKey: true,
  orderId: true,
  status: true,
  coverageScope: true,
  coverageOrigin: true,
  sourceCoverageCalculationId: true,
  sourceCoverageDecisionId: true,
  sourceCoverageStateVersion: true,
} as const satisfies Prisma.OrderResolutionCaseSelect;

const FACT_SPEC_VERSION = 'warehouse-roll-coverage/v1';
const WAREHOUSE_RECHECK_CASE_PAIRS = [
  {
    type: 'warehouse_coverage_recheck',
    coverageOrigin: 'finance_request',
  },
  {
    type: 'warehouse_coverage_physical_exception',
    coverageOrigin: 'decision_linked_physical_exception',
  },
] as const satisfies readonly Prisma.OrderResolutionCaseWhereInput[];

const RECHECK_DISCOVERY_SELECT = {
  id: true,
  openScopeKey: true,
  orderId: true,
  type: true,
  status: true,
  ownerRole: true,
  version: true,
  coverageScope: true,
  coverageOrigin: true,
  sourceCoverageCalculationId: true,
  sourceCoverageDecisionId: true,
  sourceCoverageStateVersion: true,
  order: {
    select: {
      id: true,
      warehouseCoverageWorkflowVersion: true,
    },
  },
} as const satisfies Prisma.OrderResolutionCaseSelect;

const RECHECK_MEMBER_SELECT = {
  id: true,
  caseId: true,
  orderId: true,
  rollId: true,
  sourceCalculationId: true,
  sourceDecisionId: true,
  sourceCoverageFactId: true,
  sourceKind: true,
  reasonCodes: true,
  roll: {
    select: {
      id: true,
      rollCode: true,
      ownerCounterpartyId: true,
      currentCoverageFactId: true,
      currentCoverageFact: {
        select: {
          id: true,
          version: true,
          specVersion: true,
          specFingerprint: true,
          spec: true,
          sourceOrderId: true,
          sourcePositionId: true,
        },
      },
    },
  },
} as const satisfies Prisma.WarehouseCoverageRecheckMembershipSelect;

const RECHECK_LIST_SELECT = {
  ...RECHECK_DISCOVERY_SELECT,
  order: {
    select: {
      id: true,
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
  coverageMemberships: {
    select: RECHECK_MEMBER_SELECT,
    orderBy: { id: 'asc' as const },
  },
} as const satisfies Prisma.OrderResolutionCaseSelect;

const CALCULATION_ORDER_FOR_RECHECK_SELECT = {
  id: true,
  version: true,
  warehouseCoverageWorkflowVersion: true,
  counterpartyId: true,
  positions: {
    include: { recipe: true },
    orderBy: { id: 'asc' as const },
  },
} as const satisfies Prisma.CommercialOrderSelect;

type RecheckDiscovery = Prisma.OrderResolutionCaseGetPayload<{
  select: typeof RECHECK_DISCOVERY_SELECT;
}>;
type RecheckMember = Prisma.WarehouseCoverageRecheckMembershipGetPayload<{
  select: typeof RECHECK_MEMBER_SELECT;
}>;
type RecheckListRow = Prisma.OrderResolutionCaseGetPayload<{
  select: typeof RECHECK_LIST_SELECT;
}>;

@Injectable()
export class WarehouseCoverageRecheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coverageTransaction: WarehouseCoverageTransaction,
    private readonly commands: WarehouseCoverageCommandService,
    private readonly projections: WarehouseCoverageCalculationService,
    private readonly facts: WarehouseRollCoverageFactService,
  ) {}

  async listForWarehouse(actor: Actor): Promise<WarehouseCoverageRecheckItem[]> {
    requireWarehouseReadCapability(actor);
    const rows = await this.prisma.orderResolutionCase.findMany({
      where: {
        status: 'open',
        ownerRole: 'warehouse',
        OR: [...WAREHOUSE_RECHECK_CASE_PAIRS],
        order: { warehouseCoverageWorkflowVersion: 2 },
      },
      select: RECHECK_LIST_SELECT,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(projectRecheckItem);
  }

  async resolveFromWarehouse(
    actor: Actor,
    caseId: string,
    dto: ResolveWarehouseCoverageRecheckDto,
  ): Promise<WarehouseCoverageProjection> {
    requireResolveCapability(actor);
    const normalizedCaseId = requireOpaqueId(caseId, 'caseId');
    const reason = canonicalReason(dto.reason);
    const canonicalCorrections = canonicalizeCorrections(dto.corrections);
    const commandActor = coverageCommandUserActor(actor);

    return this.coverageTransaction.run(async (tx) => {
      const discovered = await discoverCoverageCaseScope(tx, normalizedCaseId);
      const commandInput = {
        kind: 'resolve_recheck',
        clientRequestId: dto.clientRequestId,
        commercialOrderId: discovered.orderId,
        scopeCaseId: normalizedCaseId,
        actor: commandActor,
        payload: {
          expectedCaseVersion: dto.expectedCaseVersion,
          expectedGeneration: dto.expectedGeneration,
          expectedStateVersion: dto.expectedStateVersion,
          reason,
          corrections: canonicalCorrections,
        },
      } satisfies CoverageCommandInputByKind<'resolve_recheck'>;
      const acquisition = await this.commands.acquireOrReplay(tx, commandInput);
      if (acquisition.kind === 'replay') return acquisition.safeResult;

      const decisionId =
        discovered.coverageOrigin === 'decision_linked_physical_exception'
          ? requireSourceDecisionId(discovered)
          : undefined;
      const acquiredLocks = await lockCoverageResources(tx, {
        clientRequestId: dto.clientRequestId,
        orderId: discovered.orderId,
        calculationId: requireSourceCalculationId(discovered),
        ...(decisionId ? {} : { caseId: normalizedCaseId }),
        resolveRollIdsAfterCoreLocks: async (lockedTx) => {
          if (decisionId) {
            await lockHistoricalPhysicalRecheck(lockedTx, discovered, decisionId);
          }
          const [membershipRows, order] = await Promise.all([
            lockedTx.warehouseCoverageRecheckMembership.findMany({
              where: { caseId: normalizedCaseId },
              select: { rollId: true },
            }),
            lockedTx.commercialOrder.findUnique({
              where: { id: discovered.orderId },
              select: CALCULATION_ORDER_FOR_RECHECK_SELECT,
            }),
          ]);
          if (!order) throw coverageConflict('warehouse_coverage_recheck_case_conflict');
          assertCoverageWorkflow(order.warehouseCoverageWorkflowVersion as 1 | 2, 2);
          const candidates = await resolveCoverageCandidateRollIdsAfterCoreLocks(lockedTx, order);
          return binaryUnique([...membershipRows.map(({ rollId }) => rollId), ...candidates]);
        },
      });
      const locks = decisionId ? recordHistoricalPhysicalLockLevels(acquiredLocks) : acquiredLocks;

      const lockedState = await requireResolutionState(tx, discovered, dto);
      const lockedCase = await requireResolutionCase(
        tx,
        discovered,
        lockedState,
        dto.expectedCaseVersion,
      );
      const lockedMembers = await requireResolutionMembers(tx, lockedCase);
      for (const correction of canonicalCorrections) {
        const membership = requireCaseMembership(lockedMembers, correction.membershipId);
        await this.facts.appendWarehouseCorrection(
          tx,
          mapWarehouseCoverageCorrection(correction, lockedCorrectionContext(membership), reason),
          actor,
        );
      }

      await closeLockedCaseByVersion(tx, lockedCase, dto.expectedCaseVersion);
      await this.audit.record(
        {
          type: 'audit:warehouse_coverage_recheck_resolved',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: lockedCase.orderId,
          reason,
          detail: {
            workflowVersion: 2,
            caseId: lockedCase.id,
            coverageOrigin: lockedCase.coverageOrigin,
            correctionCount: canonicalCorrections.length,
            generation: lockedState.generation,
            stateVersion: lockedState.stateVersion,
          },
        },
        tx,
      );

      const result = await this.projections.calculateLocked(
        tx,
        {
          commercialOrderId: lockedCase.orderId,
          expectedGeneration: dto.expectedGeneration,
          expectedStateVersion: dto.expectedStateVersion,
        },
        locks,
      );
      await this.commands.appendFinal(tx, {
        ...commandInput,
        commandId: acquisition.commandId,
        resultReference: {
          kind: 'calculation',
          calculationId: result.calculationId,
        },
        safeResult: result.projection,
      });
      return result.projection;
    });
  }

  async requestFromFinance(
    actor: Actor,
    financeOrderId: string,
    dto: RequestWarehouseCoverageRecheckDto,
  ): Promise<FinanceWarehouseCoverageProjection & { caseId: string }> {
    requireRecheckCapability(actor);
    const route = await this.resolveFinanceRoute(financeOrderId);
    assertCoverageWorkflow(route.workflowVersion as 1 | 2, 2);
    const commandActor = coverageCommandUserActor(actor);
    const reason = canonicalReason(dto.reason);

    return this.coverageTransaction.run(async (tx) => {
      const commandInput = {
        clientRequestId: dto.clientRequestId,
        kind: 'request_recheck' as const,
        commercialOrderId: route.commercialOrderId,
        actor: commandActor,
        payload: {
          expectedGeneration: dto.expectedGeneration,
          expectedStateVersion: dto.expectedStateVersion,
          reason,
        },
      };
      const acquisition = await this.commands.acquireOrReplay(tx, commandInput);
      if (acquisition.kind === 'replay') return acquisition.safeResult;

      const reference = await readLockedState(tx, route.commercialOrderId);
      const calculationId = requireCurrentCalculationId(reference);
      const currentAutoDecisionId = preProductionAutoDecisionId(reference);
      let prepared:
        | {
            state: LockedState;
            calculation: LockedCalculation;
            candidateSet: CandidateSet;
            resolutionCase: CoverageCase;
            createdCase: boolean;
          }
        | undefined;

      const locks = await lockCoverageResources(tx, {
        clientRequestId: dto.clientRequestId,
        orderId: route.commercialOrderId,
        calculationId,
        ...(currentAutoDecisionId ? { decisionId: currentAutoDecisionId } : {}),
        resolveRollIdsAfterCoreLocks: async (lockedTx) => {
          await assertFinanceRouteUnderLock(lockedTx, financeOrderId, route.commercialOrderId);
          const state = await readLockedState(lockedTx, route.commercialOrderId);
          const calculation = await revalidateRequestableState(
            lockedTx,
            state,
            dto,
            calculationId,
            currentAutoDecisionId,
          );
          const candidateSet = immutableCandidateSet(calculation);
          const caseResult = await createOrReuseExactOriginCase(lockedTx, {
            actor,
            orderId: route.commercialOrderId,
            calculation,
            sourceStateVersion: state.stateVersion,
            reason,
          });
          await lockExactOriginCase(lockedTx, caseResult.resolutionCase, calculation.id);
          prepared = {
            state,
            calculation,
            candidateSet,
            resolutionCase: caseResult.resolutionCase,
            createdCase: caseResult.created,
          };
          return candidateSet.all;
        },
      });
      if (!prepared) throw invariant('request context was not prepared under coverage locks');

      const context = prepared;
      assertExactCandidateLocks(context.candidateSet, locks.rollIds);
      const membershipRows = await candidateMembershipRowsFromImmutableCalculation(
        tx,
        context.resolutionCase.id,
        route.commercialOrderId,
        context.calculation.id,
        context.candidateSet,
      );
      if (context.createdCase) {
        await createNormalizedMembership(tx, membershipRows);
      } else {
        await assertExistingMembership(tx, context.resolutionCase.id, membershipRows);
      }

      const cas = await tx.warehouseCoverageState.updateMany({
        where: {
          orderId: route.commercialOrderId,
          state: context.state.state,
          stateVersion: dto.expectedStateVersion,
          generation: dto.expectedGeneration,
          currentCalculationId: context.calculation.id,
          currentDecisionId: currentAutoDecisionId ?? null,
        },
        data: {
          state: 'recheck_requested',
          stateVersion: { increment: 1 },
          currentDecisionId: null,
        },
      });
      if (cas.count !== 1) throw coverageConflict('warehouse_coverage_state_conflict');

      await this.audit.record(
        {
          type: 'audit:warehouse_coverage_recheck_requested',
          actor: {
            kind: 'user',
            actorRole: actor.role,
            actorId: commandActor.actorId,
          },
          objectId: route.commercialOrderId,
          reason,
          detail: {
            workflowVersion: 2,
            orderId: route.commercialOrderId,
            generation: context.calculation.generation,
            caseId: context.resolutionCase.id,
            sourceCoverageCalculationId: context.calculation.id,
            supersededAutoDecisionId: currentAutoDecisionId ?? null,
          },
        },
        tx,
      );

      const projected = await this.projections.readForFinanceLocked(tx, actor, financeOrderId);
      const safeResult = {
        ...projected,
        availability: 'unknown' as const,
        caseId: context.resolutionCase.id,
      };
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
}

function canonicalizeCorrections(
  inputs: ResolveWarehouseCoverageRecheckDto['corrections'],
): CanonicalWarehouseCoverageCorrectionCommand[] {
  if (!Array.isArray(inputs)) throw new BadRequestException('corrections must be an array');
  const corrections = inputs.map(canonicalizeWarehouseCoverageCorrectionCommand);
  const membershipIds = new Set(corrections.map(({ membershipId }) => membershipId));
  if (membershipIds.size !== corrections.length) {
    throw new BadRequestException('corrections contain duplicate membershipId');
  }
  return corrections;
}

async function discoverCoverageCaseScope(
  tx: Prisma.TransactionClient,
  caseId: string,
): Promise<RecheckDiscovery> {
  const resolutionCase = await tx.orderResolutionCase.findUnique({
    where: { id: caseId },
    select: RECHECK_DISCOVERY_SELECT,
  });
  if (!resolutionCase) throw new NotFoundException(`Coverage recheck case ${caseId} not found`);
  assertResolutionCaseShape(resolutionCase);
  return resolutionCase;
}

function assertResolutionCaseShape(resolutionCase: RecheckDiscovery): void {
  if (
    !hasExactWarehouseRecheckPair(resolutionCase) ||
    resolutionCase.status !== 'open' ||
    resolutionCase.ownerRole !== 'warehouse' ||
    resolutionCase.order.warehouseCoverageWorkflowVersion !== 2 ||
    resolutionCase.coverageScope !== `warehouse_coverage_v2:${resolutionCase.orderId}` ||
    !resolutionCase.sourceCoverageCalculationId ||
    (resolutionCase.coverageOrigin === 'finance_request' &&
      resolutionCase.sourceCoverageDecisionId !== null) ||
    (resolutionCase.coverageOrigin === 'decision_linked_physical_exception' &&
      resolutionCase.sourceCoverageDecisionId === null)
  ) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
}

function requireSourceCalculationId(resolutionCase: RecheckDiscovery): string {
  if (!resolutionCase.sourceCoverageCalculationId) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
  return resolutionCase.sourceCoverageCalculationId;
}

function requireSourceDecisionId(resolutionCase: RecheckDiscovery): string {
  if (!resolutionCase.sourceCoverageDecisionId) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
  return resolutionCase.sourceCoverageDecisionId;
}

async function lockHistoricalPhysicalRecheck(
  tx: Prisma.TransactionClient,
  resolutionCase: RecheckDiscovery,
  decisionId: string,
): Promise<void> {
  const decisionRows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT decision."id"
               FROM "warehouse_coverage_decisions" AS decision
               JOIN "warehouse_coverage_calculations" AS calculation
                 ON calculation."id" = decision."calculationId"
               JOIN "warehouse_coverage_states" AS coverage_state
                 ON coverage_state."orderId" = decision."orderId"
               WHERE decision."id" = CAST(${decisionId} AS UUID)
                 AND decision."orderId" = ${resolutionCase.orderId}
                 AND decision."calculationId" =
                     ${resolutionCase.sourceCoverageCalculationId}
                 AND calculation."orderId" = ${resolutionCase.orderId}
                 AND coverage_state."orderId" = ${resolutionCase.orderId}
                 AND coverage_state."currentCalculationId" = calculation."id"
                 AND coverage_state."currentDecisionId" IS NULL
               FOR UPDATE OF decision`,
  );
  if (decisionRows.length !== 1 || decisionRows[0]?.id !== decisionId) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
  const caseRows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT coverage_case."id"
               FROM "order_resolution_cases" AS coverage_case
               JOIN "warehouse_coverage_calculations" AS calculation
                 ON calculation."id" = coverage_case."sourceCoverageCalculationId"
               JOIN "warehouse_coverage_decisions" AS decision
                 ON decision."id" = coverage_case."sourceCoverageDecisionId"
               JOIN "warehouse_coverage_states" AS coverage_state
                 ON coverage_state."orderId" = coverage_case."orderId"
               WHERE coverage_case."id" = ${resolutionCase.id}
                 AND coverage_case."orderId" = ${resolutionCase.orderId}
                 AND coverage_case."status" = 'open'
                 AND coverage_case."coverageScope" =
                     ${resolutionCase.coverageScope}
                 AND coverage_case."coverageOrigin" =
                     'decision_linked_physical_exception'
                 AND coverage_case."type" =
                     'warehouse_coverage_physical_exception'
                 AND coverage_case."sourceCoverageCalculationId" =
                     ${resolutionCase.sourceCoverageCalculationId}
                 AND coverage_case."sourceCoverageDecisionId" =
                     CAST(${decisionId} AS UUID)
                 AND calculation."orderId" = ${resolutionCase.orderId}
                 AND decision."orderId" = ${resolutionCase.orderId}
                 AND decision."calculationId" = calculation."id"
                 AND coverage_state."currentCalculationId" = calculation."id"
                 AND coverage_state."currentDecisionId" IS NULL
               FOR UPDATE OF coverage_case`,
  );
  if (caseRows.length !== 1 || caseRows[0]?.id !== resolutionCase.id) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
}

function recordHistoricalPhysicalLockLevels(locks: CoverageLocksHeld): CoverageLocksHeld {
  const rollIndex = locks.acquiredLevels.indexOf('warehouse_rolls_binary');
  const beforeRolls =
    rollIndex < 0 ? locks.acquiredLevels : locks.acquiredLevels.slice(0, rollIndex);
  const afterHistorical = rollIndex < 0 ? [] : locks.acquiredLevels.slice(rollIndex);
  const acquiredLevels: Array<CoverageLocksHeld['acquiredLevels'][number]> = [
    ...beforeRolls,
    'current_decision',
    'recheck_case',
    ...afterHistorical,
  ];
  return Object.freeze({
    [COVERAGE_LOCKS_HELD]: true as const,
    orderId: locks.orderId,
    acquiredLevels: Object.freeze(acquiredLevels),
    rollIds: locks.rollIds,
  });
}

async function requireResolutionState(
  tx: Prisma.TransactionClient,
  discovered: RecheckDiscovery,
  dto: Pick<ResolveWarehouseCoverageRecheckDto, 'expectedGeneration' | 'expectedStateVersion'>,
): Promise<LockedState> {
  const state = await readLockedState(tx, discovered.orderId);
  assertCoverageWorkflow(state.order.warehouseCoverageWorkflowVersion as 1 | 2, 2);
  const expectedDecisionId =
    discovered.coverageOrigin === 'finance_request' ? null : discovered.sourceCoverageDecisionId;
  const physicalDecisionState =
    discovered.coverageOrigin === 'decision_linked_physical_exception' &&
    (state.currentDecisionId === null || state.currentDecisionId === expectedDecisionId);
  if (
    state.generation !== dto.expectedGeneration ||
    state.stateVersion !== dto.expectedStateVersion ||
    state.currentCalculationId !== discovered.sourceCoverageCalculationId ||
    !state.currentCalculation ||
    state.currentCalculation.id !== discovered.sourceCoverageCalculationId ||
    state.currentCalculation.orderId !== discovered.orderId ||
    state.currentCalculation.generation !== state.generation ||
    (discovered.coverageOrigin === 'finance_request' && state.currentDecisionId !== null) ||
    (discovered.coverageOrigin === 'decision_linked_physical_exception' && !physicalDecisionState)
  ) {
    throw coverageConflict('warehouse_coverage_state_conflict');
  }
  return state;
}

async function requireResolutionCase(
  tx: Prisma.TransactionClient,
  discovered: RecheckDiscovery,
  lockedState: LockedState,
  expectedCaseVersion: number,
): Promise<RecheckDiscovery> {
  const resolutionCase = await tx.orderResolutionCase.findUnique({
    where: { id: discovered.id },
    select: RECHECK_DISCOVERY_SELECT,
  });
  if (!resolutionCase) throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  assertResolutionCaseShape(resolutionCase);
  if (
    resolutionCase.id !== discovered.id ||
    resolutionCase.orderId !== discovered.orderId ||
    resolutionCase.version !== expectedCaseVersion ||
    resolutionCase.coverageOrigin !== discovered.coverageOrigin ||
    resolutionCase.sourceCoverageCalculationId !== lockedState.currentCalculationId ||
    resolutionCase.sourceCoverageDecisionId !== discovered.sourceCoverageDecisionId
  ) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
  return resolutionCase;
}

async function requireResolutionMembers(
  tx: Prisma.TransactionClient,
  resolutionCase: RecheckDiscovery,
): Promise<RecheckMember[]> {
  const rows = await tx.warehouseCoverageRecheckMembership.findMany({
    where: { caseId: resolutionCase.id },
    select: RECHECK_MEMBER_SELECT,
  });
  rows.sort((left, right) => compareOpaqueIdsBinary(left.id, right.id));
  for (const row of rows) {
    const exactDecision =
      resolutionCase.coverageOrigin === 'finance_request'
        ? row.sourceDecisionId === null &&
          (row.sourceKind === 'verified_candidate' || row.sourceKind === 'uncertain_candidate')
        : row.sourceDecisionId === resolutionCase.sourceCoverageDecisionId &&
          row.sourceKind === 'decision_match';
    if (
      row.caseId !== resolutionCase.id ||
      row.orderId !== resolutionCase.orderId ||
      row.rollId !== row.roll.id ||
      row.sourceCalculationId !== resolutionCase.sourceCoverageCalculationId ||
      !exactDecision
    ) {
      throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
    }
  }
  return rows;
}

function requireCaseMembership(
  members: readonly RecheckMember[],
  membershipId: string,
): RecheckMember {
  const membership = members.find(({ id }) => id === membershipId);
  if (!membership) {
    throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
  }
  return membership;
}

function lockedCorrectionContext(member: RecheckMember): WarehouseCoverageCorrectionContext {
  const currentSpec = canonicalCurrentSpec(member);
  return {
    rollId: member.roll.id,
    rollCode: member.roll.rollCode,
    sourceOrderId:
      currentSpec?.sourceOrderId ?? member.roll.currentCoverageFact?.sourceOrderId ?? null,
    sourcePositionId:
      currentSpec?.sourcePositionId ?? member.roll.currentCoverageFact?.sourcePositionId ?? null,
    currentOwnerCounterpartyId: member.roll.ownerCounterpartyId,
    currentSpec,
  };
}

async function closeLockedCaseByVersion(
  tx: Prisma.TransactionClient,
  resolutionCase: RecheckDiscovery,
  expectedCaseVersion: number,
): Promise<void> {
  const closed = await tx.orderResolutionCase.updateMany({
    where: {
      id: resolutionCase.id,
      orderId: resolutionCase.orderId,
      status: 'open',
      version: expectedCaseVersion,
      type: resolutionCase.type,
      ownerRole: 'warehouse',
      coverageScope: resolutionCase.coverageScope,
      coverageOrigin: resolutionCase.coverageOrigin,
      sourceCoverageCalculationId: resolutionCase.sourceCoverageCalculationId,
      sourceCoverageDecisionId: resolutionCase.sourceCoverageDecisionId,
    },
    data: {
      status: 'resolved',
      openScopeKey: null,
      outcome: 'warehouse_coverage_recheck_resolved',
      nextOwnerRole: 'finance',
      resolvedAt: new Date(),
      version: { increment: 1 },
    },
  });
  if (closed.count !== 1) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
}

function hasExactWarehouseRecheckPair(
  resolutionCase: Pick<RecheckDiscovery, 'type' | 'coverageOrigin'>,
): boolean {
  return WAREHOUSE_RECHECK_CASE_PAIRS.some(
    ({ type, coverageOrigin }) =>
      resolutionCase.type === type && resolutionCase.coverageOrigin === coverageOrigin,
  );
}

function projectRecheckItem(row: RecheckListRow): WarehouseCoverageRecheckItem {
  assertResolutionCaseShape(row);
  const state = row.order.coverageState;
  if (
    !state ||
    state.currentCalculationId !== row.sourceCoverageCalculationId ||
    (row.coverageOrigin === 'finance_request' && state.currentDecisionId !== null) ||
    (row.coverageOrigin === 'decision_linked_physical_exception' &&
      state.currentDecisionId !== null &&
      state.currentDecisionId !== row.sourceCoverageDecisionId)
  ) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
  const members = row.coverageMemberships.map((member) => {
    const currentSpec = canonicalCurrentSpec(member);
    return {
      membershipId: member.id,
      rollCode: member.roll.rollCode,
      sourceKind: requireSourceKind(member.sourceKind),
      reasonCodes: canonicalReasonCodes(member.reasonCodes),
      currentFactVersion: member.roll.currentCoverageFact?.version ?? null,
      ownerVerified:
        member.roll.ownerCounterpartyId !== null &&
        currentSpec?.ownerCounterpartyId === member.roll.ownerCounterpartyId,
      currentSpec: currentSpec ? publicCorrectionSpec(currentSpec) : null,
    };
  });
  return {
    caseId: row.id,
    coverageOrigin: row.coverageOrigin as WarehouseCoverageRecheckItem['coverageOrigin'],
    caseVersion: row.version,
    generation: state.generation,
    stateVersion: state.stateVersion,
    reasonCodes: ['warehouse_recheck_pending'],
    members,
  };
}

function canonicalCurrentSpec(
  member: Pick<RecheckMember, 'roll'>,
): CanonicalRollCoverageSpec | null {
  const fact = member.roll.currentCoverageFact;
  if (
    !fact ||
    member.roll.currentCoverageFactId !== fact.id ||
    fact.specVersion !== FACT_SPEC_VERSION
  ) {
    return null;
  }
  try {
    const spec = canonicalizeRollCoverageSpec(fact.spec);
    if (
      spec.rollCode !== member.roll.rollCode ||
      fingerprintRollFact(spec) !== fact.specFingerprint
    ) {
      return null;
    }
    return spec;
  } catch {
    return null;
  }
}

function publicCorrectionSpec(
  spec: CanonicalRollCoverageSpec,
): WarehouseCoverageRecheckItem['members'][number]['currentSpec'] {
  return {
    filmType: spec.filmType,
    actualThickness: formatMilli(spec.actualThicknessMilliMicron),
    accountingThickness: formatMilli(spec.accountingThicknessMilliMicron),
    widthMm: spec.widthMilliMm / 1_000,
    plannedLengthM: spec.plannedLengthMilliM / 1_000,
    birka: spec.birka,
    spoolType: spec.spoolType,
    actualWeightKg: formatMilli(spec.actualWeightMilliKg),
    plannedWeightKg: formatMilli(spec.plannedWeightMilliKg),
    recipeId: spec.recipeId,
    recipeVersion: spec.recipeVersion,
    recipeDefinitionId: spec.recipeDefinitionId,
    recipeDefinitionVersionId: spec.recipeDefinitionVersionId,
    recipeVersionNumber: spec.recipeVersionNumber,
    ingredients: spec.ingredients.map((ingredient) => ({ ...ingredient })),
  };
}

function formatMilli(value: number): string {
  const whole = Math.floor(value / 1_000);
  const fraction = String(value % 1_000)
    .padStart(3, '0')
    .replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function requireSourceKind(
  value: string,
): WarehouseCoverageRecheckItem['members'][number]['sourceKind'] {
  if (
    value !== 'verified_candidate' &&
    value !== 'uncertain_candidate' &&
    value !== 'decision_match'
  ) {
    throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
  }
  return value;
}

function canonicalReasonCodes(value: Prisma.JsonValue): WarehouseCoverageReasonCode[] {
  if (!Array.isArray(value)) {
    throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
  }
  const allowed = new Set<string>(WAREHOUSE_COVERAGE_REASON_CODES);
  const result = value.map((reason) => {
    if (typeof reason !== 'string' || !allowed.has(reason)) {
      throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
    }
    return reason as WarehouseCoverageReasonCode;
  });
  if (new Set(result).size !== result.length) {
    throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
  }
  return result;
}

function binaryUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareOpaqueIdsBinary);
}

function requireOpaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new BadRequestException(`${field} must be a non-empty canonical ID`);
  }
  return value;
}

async function readLockedState(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<LockedState> {
  const state = await tx.warehouseCoverageState.findUnique({
    where: { orderId },
    select: LOCKED_STATE_SELECT,
  });
  if (!state) throw coverageConflict('warehouse_coverage_state_conflict');
  return state;
}

function requireCurrentCalculationId(state: LockedState): string {
  if (!state.currentCalculationId) {
    throw coverageConflict('warehouse_coverage_recheck_not_allowed');
  }
  return state.currentCalculationId;
}

function preProductionAutoDecisionId(state: LockedState): string | undefined {
  if (
    state.state === 'production_required' &&
    state.order.productionOrder === null &&
    state.currentDecision?.kind === 'auto_produce_all'
  ) {
    return state.currentDecision.id;
  }
  return undefined;
}

async function revalidateRequestableState(
  tx: Prisma.TransactionClient,
  state: LockedState,
  dto: RequestWarehouseCoverageRecheckDto,
  expectedCalculationId: string,
  expectedCurrentAutoDecisionId: string | undefined,
): Promise<LockedCalculation> {
  assertCoverageWorkflow(state.order.warehouseCoverageWorkflowVersion as 1 | 2, 2);
  const calculation = state.currentCalculation;
  const ordinaryPreDecision =
    (state.state === 'awaiting_finance' || state.state === 'unknown') &&
    state.currentDecisionId === null &&
    state.currentDecision === null;
  const preProductionAutoDecision =
    state.state === 'production_required' &&
    expectedCurrentAutoDecisionId !== undefined &&
    state.currentDecisionId === expectedCurrentAutoDecisionId &&
    state.currentDecision?.id === expectedCurrentAutoDecisionId &&
    state.currentDecision.kind === 'auto_produce_all';
  if (
    state.stateVersion !== dto.expectedStateVersion ||
    state.generation !== dto.expectedGeneration ||
    state.currentCalculationId !== expectedCalculationId ||
    state.order.productionOrder !== null ||
    !calculation ||
    calculation.id !== expectedCalculationId ||
    calculation.orderId !== state.orderId ||
    calculation.generation !== state.generation ||
    (!ordinaryPreDecision && !preProductionAutoDecision)
  ) {
    throw coverageConflict('warehouse_coverage_recheck_not_allowed');
  }
  if (
    preProductionAutoDecision &&
    (state.currentDecision?.orderId !== state.orderId ||
      state.currentDecision.calculationId !== calculation.id ||
      state.currentDecision.generation !== calculation.generation ||
      calculation.availability !== 'unavailable')
  ) {
    throw coverageConflict('warehouse_coverage_recheck_not_allowed');
  }
  const epoch = await tx.warehouseCoverageInventoryEpoch.findUnique({
    where: { id: 1 },
    select: { epoch: true },
  });
  if (!epoch || epoch.epoch !== calculation.inventoryEpoch) {
    throw coverageConflict('warehouse_coverage_inventory_changed');
  }
  return calculation;
}

function immutableCandidateSet(calculation: LockedCalculation): CandidateSet {
  const verified = strictOpaqueIdArray(
    calculation.verifiedCandidateRollIds,
    'verifiedCandidateRollIds',
  );
  const uncertain = strictOpaqueIdArray(
    calculation.uncertainCandidateRollIds,
    'uncertainCandidateRollIds',
  );
  const verifiedSet = new Set(verified);
  if (uncertain.some((rollId) => verifiedSet.has(rollId))) {
    throw invariant('candidate arrays overlap');
  }
  return {
    verified,
    uncertain,
    all: [...verified, ...uncertain].sort(compareOpaqueIdsBinary),
  };
}

async function createOrReuseExactOriginCase(
  tx: Prisma.TransactionClient,
  input: {
    actor: Actor;
    orderId: string;
    calculation: LockedCalculation;
    sourceStateVersion: number;
    reason: string;
  },
): Promise<{ resolutionCase: CoverageCase; created: boolean }> {
  const coverageScope = `warehouse_coverage_v2:${input.orderId}`;
  const openScopeKey = `${coverageScope}:finance_request`;
  const existing = await tx.orderResolutionCase.findUnique({
    where: { openScopeKey },
    select: CASE_SELECT,
  });
  if (existing) {
    assertExactOriginCase(existing, {
      openScopeKey,
      coverageScope,
      orderId: input.orderId,
      calculationId: input.calculation.id,
      sourceStateVersion: input.sourceStateVersion,
    });
    return { resolutionCase: existing, created: false };
  }
  const resolutionCase = await tx.orderResolutionCase.create({
    data: {
      openScopeKey,
      orderId: input.orderId,
      type: 'warehouse_coverage_recheck',
      status: 'open',
      ownerRole: 'warehouse',
      affectedPositionIds: [],
      affectedRollIds: [],
      reason: input.reason,
      createdByRole: 'finance',
      createdById: input.actor.userId,
      coverageScope,
      coverageOrigin: 'finance_request',
      sourceCoverageCalculationId: input.calculation.id,
      sourceCoverageDecisionId: null,
      sourceCoverageStateVersion: input.sourceStateVersion,
    },
    select: CASE_SELECT,
  });
  return { resolutionCase, created: true };
}

function assertExactOriginCase(
  resolutionCase: CoverageCase,
  expected: {
    openScopeKey: string;
    coverageScope: string;
    orderId: string;
    calculationId: string;
    sourceStateVersion: number;
  },
): void {
  if (
    resolutionCase.openScopeKey !== expected.openScopeKey ||
    resolutionCase.coverageScope !== expected.coverageScope ||
    resolutionCase.coverageOrigin !== 'finance_request' ||
    resolutionCase.orderId !== expected.orderId ||
    resolutionCase.status !== 'open' ||
    resolutionCase.sourceCoverageCalculationId !== expected.calculationId ||
    resolutionCase.sourceCoverageDecisionId !== null ||
    resolutionCase.sourceCoverageStateVersion !== expected.sourceStateVersion
  ) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
}

async function lockExactOriginCase(
  tx: Prisma.TransactionClient,
  resolutionCase: CoverageCase,
  calculationId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT coverage_case."id"
               FROM "order_resolution_cases" AS coverage_case
               WHERE coverage_case."id" = ${resolutionCase.id}
                 AND coverage_case."orderId" = ${resolutionCase.orderId}
                 AND coverage_case."status" = 'open'
                 AND coverage_case."openScopeKey" =
                   ${resolutionCase.openScopeKey}
                 AND coverage_case."coverageScope" =
                   ${resolutionCase.coverageScope}
                 AND coverage_case."coverageOrigin" = 'finance_request'
                 AND coverage_case."sourceCoverageCalculationId" = ${calculationId}
                 AND coverage_case."sourceCoverageDecisionId" IS NULL
               FOR UPDATE OF coverage_case`,
  );
  if (rows.length !== 1 || rows[0]?.id !== resolutionCase.id) {
    throw coverageConflict('warehouse_coverage_recheck_case_conflict');
  }
}

function assertExactCandidateLocks(
  candidateSet: CandidateSet,
  lockedRollIds: readonly string[],
): void {
  if (
    candidateSet.all.length !== lockedRollIds.length ||
    candidateSet.all.some((rollId, index) => rollId !== lockedRollIds[index])
  ) {
    throw coverageConflict('warehouse_coverage_candidate_set_changed');
  }
}

async function candidateMembershipRowsFromImmutableCalculation(
  tx: Prisma.TransactionClient,
  caseId: string,
  orderId: string,
  calculationId: string,
  candidateSet: CandidateSet,
): Promise<MembershipRow[]> {
  if (candidateSet.all.length === 0) return [];
  const rows = await tx.warehouseRoll.findMany({
    where: { id: { in: [...candidateSet.all] } },
    select: LOCKED_CANDIDATE_SELECT,
  });
  const ordered = [...rows].sort((left, right) => compareOpaqueIdsBinary(left.id, right.id));
  if (
    ordered.length !== candidateSet.all.length ||
    ordered.some((row, index) => row.id !== candidateSet.all[index])
  ) {
    throw coverageConflict('warehouse_coverage_candidate_set_changed');
  }
  const verified = new Set(candidateSet.verified);
  return ordered.map((roll) => {
    const sourceKind = verified.has(roll.id)
      ? ('verified_candidate' as const)
      : ('uncertain_candidate' as const);
    if (sourceKind === 'verified_candidate' && roll.currentCoverageFact === null) {
      throw coverageConflict('warehouse_coverage_candidate_set_changed');
    }
    return {
      caseId,
      orderId,
      rollId: roll.id,
      sourceCalculationId: calculationId,
      sourceDecisionId: null,
      sourceCoverageFactId: roll.currentCoverageFact?.id ?? null,
      sourceKind,
      reasonCodes: sourceKind === 'verified_candidate' ? [] : uncertainCandidateReasons(roll),
    };
  });
}

async function createNormalizedMembership(
  tx: Prisma.TransactionClient,
  rows: readonly MembershipRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const created = await tx.warehouseCoverageRecheckMembership.createMany({
    data: rows.map((row) => ({
      ...row,
      reasonCodes: row.reasonCodes as Prisma.InputJsonValue,
    })),
  });
  if (created.count !== rows.length) {
    throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
  }
}

async function assertExistingMembership(
  tx: Prisma.TransactionClient,
  caseId: string,
  expectedRows: readonly MembershipRow[],
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
  const expected = expectedRows.map((row) => ({
    ...row,
    reasonCodes: [...row.reasonCodes],
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw coverageConflict('warehouse_coverage_recheck_membership_conflict');
  }
}

function uncertainCandidateReasons(roll: LockedCandidateRoll): WarehouseCoverageReasonCode[] {
  const fact = roll.currentCoverageFact;
  const spec = asRecord(fact?.spec);
  const reasons = new Set<WarehouseCoverageReasonCode>();
  let canonicalFactValid = false;
  if (fact && fact.specVersion === FACT_SPEC_VERSION) {
    try {
      const canonical = canonicalizeRollCoverageSpec(fact.spec);
      canonicalFactValid =
        canonical.rollCode === roll.rollCode &&
        fingerprintRollFact(canonical) === fact.specFingerprint;
    } catch {
      canonicalFactValid = false;
    }
  }
  if (!canonicalFactValid) {
    reasons.add('roll_facts_incomplete');
  }
  if (
    spec &&
    spec.policyVersion != null &&
    spec.policyVersion !== WAREHOUSE_COVERAGE_POLICY_VERSION
  ) {
    reasons.add('unsupported_policy_version');
  }
  if (
    roll.ownerCounterpartyId === null ||
    (spec !== null &&
      Object.prototype.hasOwnProperty.call(spec, 'ownerCounterpartyId') &&
      nullableOpaqueId(spec.ownerCounterpartyId) !== roll.ownerCounterpartyId)
  ) {
    reasons.add('roll_ownership_unverified');
  }
  if (reasons.size === 0) reasons.add('roll_facts_incomplete');
  return [
    'roll_facts_incomplete',
    'roll_ownership_unverified',
    'unsupported_policy_version',
  ].filter((reason) =>
    reasons.has(reason as WarehouseCoverageReasonCode),
  ) as WarehouseCoverageReasonCode[];
}

function strictOpaqueIdArray(value: Prisma.JsonValue, field: string): string[] {
  if (!Array.isArray(value)) throw invariant(`${field} is not an array`);
  const result = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry !== entry.trim()) {
      throw invariant(`${field} contains an invalid ID`);
    }
    return entry;
  });
  const sorted = [...new Set(result)].sort(compareOpaqueIdsBinary);
  if (sorted.length !== result.length || sorted.some((entry, index) => entry !== result[index])) {
    throw invariant(`${field} is not a sorted unique array`);
  }
  return result;
}

async function assertFinanceRouteUnderLock(
  tx: Prisma.TransactionClient,
  financeOrderId: string,
  commercialOrderId: string,
): Promise<void> {
  const financeOrder = await tx.financeOrder.findUnique({
    where: { id: financeOrderId },
    select: { commercialOrderId: true },
  });
  if (!financeOrder || financeOrder.commercialOrderId !== commercialOrderId) {
    throw coverageConflict('warehouse_coverage_finance_route_changed');
  }
}

function canonicalReason(value: string): string {
  if (typeof value !== 'string') throw new BadRequestException('reason is required');
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (result.length < 3 || result.length > 500) {
    throw new BadRequestException('reason must contain 3 to 500 characters');
  }
  return result;
}

function requireRecheckCapability(actor: Actor): void {
  if (!actor.capabilities.includes('warehouse_coverage:request_recheck')) {
    throw new ForbiddenException('Missing capability: warehouse_coverage:request_recheck');
  }
}

function requireWarehouseReadCapability(actor: Actor): void {
  if (!actor.capabilities.includes('warehouse_task:read')) {
    throw new ForbiddenException('Missing capability: warehouse_task:read');
  }
}

function requireResolveCapability(actor: Actor): void {
  if (!actor.capabilities.includes('warehouse_coverage:resolve_recheck')) {
    throw new ForbiddenException('Missing capability: warehouse_coverage:resolve_recheck');
  }
}

function nullableOpaqueId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    ? value
    : value === null
      ? null
      : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function coverageConflict(code: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code,
    message: 'Warehouse coverage changed concurrently. Reload and retry.',
  });
}

function invariant(detail: string): never {
  throw new Error(`Warehouse coverage recheck invariant: ${detail}`);
}
