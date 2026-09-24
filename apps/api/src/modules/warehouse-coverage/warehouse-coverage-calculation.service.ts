import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type WarehouseCoverageCalculation,
  type WarehouseCoverageState as PersistedCoverageState,
} from '@prisma/client';
import {
  type FinanceCoverageRollProjection,
  type FinanceWarehouseCoverageProjection,
  type UuidString,
  type WarehouseCoverageProjection,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY } from '../../common/audit/audit-actor';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  compareOpaqueIdsBinary,
  fingerprintRollFact,
  normalizeCoverageText,
  normalizeIngredients,
  normalizeSpool,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
  type CanonicalIngredient,
} from './warehouse-coverage-canonical';
import {
  coverageCommandUserActor,
  WarehouseCoverageCommandService,
} from './warehouse-coverage-command.service';
import {
  buildVerifiedCandidate,
  matchWarehouseCoverage,
  type CandidateKnownCoverageFields,
  type UncertainCoverageCandidate,
  type VerifiedCoverageCandidate,
  type WarehouseCoverageMatchPlan,
} from './warehouse-coverage-matcher';
import {
  permittedWarehouseCoverageActions,
  projectWarehouseCoverage,
} from './warehouse-coverage-projection';
import {
  COVERAGE_LOCKS_HELD,
  lockCoverageResources,
  type CoverageLocksHeld,
  WarehouseCoverageTransaction,
} from './warehouse-coverage-transaction';
import {
  assertCoverageWorkflow,
  validateV2CoverageCompleteness,
} from './warehouse-coverage-workflow';

const ALGORITHM_VERSION = 'warehouse-coverage-matching/v1';
const FACT_SPEC_VERSION = 'warehouse-roll-coverage/v1';
const MAX_READ_ATTEMPTS = 3;

export interface RefreshWarehouseCoverageDto {
  clientRequestId: UuidString;
  expectedGeneration: number | null;
  expectedStateVersion: number;
}

export interface LockedCoverageInput {
  commercialOrderId: string;
  expectedStateVersion: number;
  expectedGeneration: number | null;
}

const CALCULATION_ORDER_SELECT = {
  id: true,
  version: true,
  warehouseCoverageWorkflowVersion: true,
  cancellationStatus: true,
  counterpartyId: true,
  positions: {
    include: { recipe: true },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.CommercialOrderSelect;

type CalculationOrder = Prisma.CommercialOrderGetPayload<{
  select: typeof CALCULATION_ORDER_SELECT;
}>;

const CANDIDATE_SELECT = {
  id: true,
  rollCode: true,
  ownerCounterpartyId: true,
  producedForStockOrderId: true,
  producedForOrderId: true,
  releasedFromOrderId: true,
  releasedFromOrder: { select: { cancellationStatus: true, positions: { select: { id: true } } } },
  producedForStockOrder: {
    select: {
      requestType: true,
      positions: {
        select: { id: true },
        orderBy: { id: 'asc' as const },
      },
    },
  },
  warehouseStatus: true,
  reservedForOrderId: true,
  reservedForPositionId: true,
  reservedByProposalId: true,
  reservedByCoverageDecisionId: true,
  currentCoverageFactId: true,
  currentCoverageFact: {
    select: {
      id: true,
      specVersion: true,
      specFingerprint: true,
      spec: true,
      sourceOrderId: true,
      sourcePositionId: true,
    },
  },
  coverageMemberships: {
    select: {
      orderId: true,
      case: { select: { status: true } },
    },
  },
} satisfies Prisma.WarehouseRollSelect;

type CandidateRoll = Prisma.WarehouseRollGetPayload<{
  select: typeof CANDIDATE_SELECT;
}>;

const FINANCE_COVERAGE_SELECT = {
  id: true,
  commercialOrderId: true,
  commercialOrder: {
    select: {
      id: true,
      warehouseCoverageWorkflowVersion: true,
      cancellationStatus: true,
      coverageState: {
        include: {
          currentCalculation: {
            include: {
              matches: {
                select: {
                  positionId: true,
                  position: {
                    select: {
                      filmType: true,
                      actualThickness: true,
                      accountingThickness: true,
                      widthMm: true,
                      plannedLengthM: true,
                      plannedWeightKg: true,
                      spoolType: true,
                      birka: true,
                      manualBirka: true,
                      baseRawMaterialDefinition: { select: { name: true } },
                      recipe: { select: { recipeName: true } },
                      recipeDefinitionVersion: {
                        select: { recipeDefinition: { select: { name: true } } },
                      },
                    },
                  },
                  coverageFact: {
                    select: {
                      source: true,
                      spec: true,
                      sourceWeightCapture: {
                        select: { grossKg: true, spoolKg: true, netKg: true },
                      },
                      sourcePosition: {
                        select: {
                          baseRawMaterialDefinition: { select: { name: true } },
                          recipe: { select: { recipeName: true } },
                          recipeDefinitionVersion: {
                            select: {
                              recipeDefinition: { select: { name: true } },
                            },
                          },
                        },
                      },
                    },
                  },
                  roll: {
                    select: {
                      rollCode: true,
                      warehouseStatus: true,
                      positionSnapshot: true,
                      receivedAt: true,
                      reservedForOrderId: true,
                      reservedForPositionId: true,
                      reservedByProposalId: true,
                      reservedByCoverageDecisionId: true,
                      producedForStockOrder: { select: { stockBatchCode: true } },
                    },
                  },
                },
              },
            },
          },
          currentDecision: {
            select: {
              kind: true,
              acceptanceTask: { select: { status: true } },
            },
          },
        },
      },
      productionOrder: { select: { id: true } },
    },
  },
} satisfies Prisma.FinanceOrderSelect;

type FinanceCoverageOrder = Prisma.FinanceOrderGetPayload<{
  select: typeof FINANCE_COVERAGE_SELECT;
}>;

type FinanceCoverageMatch = NonNullable<
  NonNullable<FinanceCoverageOrder['commercialOrder']['coverageState']>['currentCalculation']
>['matches'][number];

@Injectable()
export class WarehouseCoverageCalculationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coverageTransaction: WarehouseCoverageTransaction,
    private readonly commands: WarehouseCoverageCommandService,
  ) {}

  async calculateLocked(
    tx: Prisma.TransactionClient,
    input: LockedCoverageInput,
    locks: CoverageLocksHeld,
  ): Promise<{ calculationId: string; projection: WarehouseCoverageProjection }> {
    assertLockEnvelope(input.commercialOrderId, locks);

    const sourceEpoch = await readInventoryEpoch(tx);
    const [state, order] = await Promise.all([
      tx.warehouseCoverageState.findUnique({
        where: { orderId: input.commercialOrderId },
      }),
      tx.commercialOrder.findUnique({
        where: { id: input.commercialOrderId },
        select: CALCULATION_ORDER_SELECT,
      }),
    ]);
    if (!state || !order) throw coverageConflict('warehouse_coverage_state_conflict');
    if (!order.counterpartyId) {
      throw coverageConflict('warehouse_coverage_state_conflict');
    }
    assertCoverageWorkflowVersion(order.warehouseCoverageWorkflowVersion, 2);
    if (order.cancellationStatus !== 'active') {
      throw coverageConflict('warehouse_coverage_refresh_not_allowed');
    }
    assertExpectedState(state, input);
    assertCoreLockProof(state, locks);

    const expectedCandidateIds = await resolveCoverageCandidateRollIdsAfterCoreLocks(tx, order);
    assertExactLockedCandidates(expectedCandidateIds, locks);
    const candidateRows = await tx.warehouseRoll.findMany({
      where: { id: { in: [...locks.rollIds] } },
      select: CANDIDATE_SELECT,
    });
    const orderedCandidateRows = [...candidateRows].sort((left, right) =>
      compareOpaqueIdsBinary(left.id, right.id),
    );
    if (
      orderedCandidateRows.length !== locks.rollIds.length ||
      orderedCandidateRows.some((row, index) => row.id !== locks.rollIds[index])
    ) {
      throw coverageConflict('warehouse_coverage_candidate_set_changed');
    }

    const completeness = validateV2CoverageCompleteness(order);
    const candidates = classifyCandidates(
      orderedCandidateRows,
      order.id,
      order.counterpartyId,
      new Set(order.positions.map(({ id }) => id)),
    );
    const plan: WarehouseCoverageMatchPlan = completeness.ok
      ? matchWarehouseCoverage({
          orderId: order.id,
          counterpartyId: order.counterpartyId,
          positions: completeness.positions,
          verifiedRolls: candidates.verified,
          uncertainRolls: candidates.uncertain,
        })
      : {
          availability: 'unknown',
          reasonCodes: ['order_spec_incomplete'],
          requiredRollCount: requiredRollCount(order.positions),
          matchedRollCount: 0,
          uncertainRollCount: 0,
          matches: [],
        };

    const committedEpoch = await readInventoryEpoch(tx);
    if (committedEpoch !== sourceEpoch) {
      throw coverageConflict('inventory_changed');
    }

    const generation = state.generation + 1;
    const positionVersions = [...order.positions]
      .sort((left, right) => compareOpaqueIdsBinary(left.id, right.id))
      .map(({ id, version }) => ({ positionId: id, version }));
    const verifiedCandidateRollIds = candidates.verified
      .map(({ rollId }) => rollId)
      .sort(compareOpaqueIdsBinary);
    const uncertainCandidateRollIds = candidates.uncertain
      .map(({ rollId }) => rollId)
      .sort(compareOpaqueIdsBinary);
    const orderFingerprint = requestFingerprint({
      orderId: order.id,
      orderVersion: order.version,
      counterpartyId: order.counterpartyId,
      positionVersions,
      positions: completeness.ok ? completeness.positions : null,
    });
    const inventoryFingerprint = requestFingerprint({
      epoch: sourceEpoch.toString(),
      verified: candidates.verified.map(({ rollId, coverageFactId, spec }) => ({
        rollId,
        coverageFactId,
        specFingerprint: fingerprintRollFact(spec),
      })),
      uncertain: candidates.uncertain.map(({ rollId, coverageFactId, reasonCodes }) => ({
        rollId,
        coverageFactId,
        reasonCodes,
      })),
    });
    const inputFingerprint = requestFingerprint({
      orderFingerprint,
      inventoryFingerprint,
      algorithmVersion: ALGORITHM_VERSION,
      policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
    });
    const calculation = await tx.warehouseCoverageCalculation.create({
      data: {
        orderId: order.id,
        generation,
        orderVersion: order.version,
        positionVersions: positionVersions as unknown as Prisma.InputJsonValue,
        orderFingerprint,
        inventoryEpoch: sourceEpoch,
        inventoryFingerprint,
        inputFingerprint,
        algorithmVersion: ALGORITHM_VERSION,
        policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
        availability: plan.availability,
        reasonCodes: plan.reasonCodes as Prisma.InputJsonValue,
        requiredRollCount: plan.requiredRollCount,
        matchedRollCount: plan.matchedRollCount,
        uncertainRollCount: plan.uncertainRollCount,
        verifiedCandidateRollIds: verifiedCandidateRollIds as Prisma.InputJsonValue,
        uncertainCandidateRollIds: uncertainCandidateRollIds as Prisma.InputJsonValue,
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      },
    });

    if (plan.availability === 'verified_full') {
      await tx.warehouseCoverageMatch.createMany({
        data: plan.matches.map((match) => ({
          calculationId: calculation.id,
          orderId: order.id,
          generation,
          positionId: match.positionId,
          rollId: match.rollId,
          coverageFactId: match.coverageFactId,
          slotIndex: match.slotIndex,
        })),
      });
    }

    const autoDecision =
      plan.availability === 'unavailable'
        ? await tx.warehouseCoverageDecision.create({
            data: {
              id: randomUUID(),
              orderId: order.id,
              calculationId: calculation.id,
              generation,
              kind: 'auto_produce_all',
              inputFingerprint,
              sourceInventoryEpoch: sourceEpoch,
              committedInventoryEpoch: null,
              expectedRollCount: 0,
              actorKind: 'system',
              actorRole: null,
              actorId: null,
              systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
            },
          })
        : null;
    const nextState =
      plan.availability === 'verified_full'
        ? 'awaiting_finance'
        : plan.availability === 'unavailable'
          ? 'production_required'
          : 'unknown';
    const cas = await tx.warehouseCoverageState.updateMany({
      where: {
        orderId: order.id,
        stateVersion: input.expectedStateVersion,
        generation: input.expectedGeneration ?? 0,
        currentCalculationId: state.currentCalculationId,
        currentDecisionId: state.currentDecisionId,
      },
      data: {
        state: nextState,
        stateVersion: { increment: 1 },
        generation,
        currentCalculationId: calculation.id,
        currentDecisionId: autoDecision?.id ?? null,
      },
    });
    if (cas.count !== 1) throw coverageConflict('warehouse_coverage_state_conflict');

    await this.audit.record(
      {
        type: 'audit:warehouse_coverage_calculated',
        actor: {
          kind: 'system',
          systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
        },
        objectId: order.id,
        detail: {
          workflowVersion: 2,
          generation,
          availability: plan.availability,
          requiredRollCount: plan.requiredRollCount,
          matchedRollCount: plan.matchedRollCount,
          uncertainRollCount: plan.uncertainRollCount,
        },
      },
      tx,
    );
    if (autoDecision) {
      await this.audit.record(
        {
          type: 'audit:warehouse_coverage_decided',
          actor: {
            kind: 'system',
            systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
          },
          objectId: order.id,
          detail: {
            workflowVersion: 2,
            generation,
            decision: 'auto_produce_all',
            requiredRollCount: plan.requiredRollCount,
          },
        },
        tx,
      );
    }

    const projection = projectWarehouseCoverage({
      workflowVersion: 2,
      state: {
        ...state,
        state: nextState,
        stateVersion: state.stateVersion + 1,
        generation,
        currentCalculationId: calculation.id,
        currentDecisionId: autoDecision?.id ?? null,
        updatedAt: calculation.calculatedAt,
      },
      calculation,
      currentInventoryEpoch: committedEpoch,
      orderCancellationStatus: 'active',
      productionOrderExists: false,
      currentDecisionKind: autoDecision ? 'auto_produce_all' : null,
      reserveTaskStatus: null,
      permittedActions: [],
    });
    return { calculationId: calculation.id, projection };
  }

  async refreshForFinance(
    actor: Actor,
    financeOrderId: string,
    dto: RefreshWarehouseCoverageDto,
  ): Promise<FinanceWarehouseCoverageProjection> {
    requireCapability(actor, 'warehouse_coverage:refresh');
    const route = await this.resolveFinanceRoute(financeOrderId);
    assertCoverageWorkflowVersion(route.workflowVersion, 2);
    const commandActor = coverageCommandUserActor(actor);

    return this.coverageTransaction.run(async (tx) => {
      const commandInput = {
        clientRequestId: dto.clientRequestId,
        kind: 'refresh' as const,
        commercialOrderId: route.commercialOrderId,
        actor: commandActor,
        payload: {
          expectedGeneration: dto.expectedGeneration,
          expectedStateVersion: dto.expectedStateVersion,
        },
      };
      const acquisition = await this.commands.acquireOrReplay(tx, commandInput);
      if (acquisition.kind === 'replay') return acquisition.safeResult;

      const state = await tx.warehouseCoverageState.findUnique({
        where: { orderId: route.commercialOrderId },
      });
      if (!state) throw coverageConflict('warehouse_coverage_state_conflict');
      const locks = await lockCoverageResources(tx, {
        clientRequestId: dto.clientRequestId,
        orderId: route.commercialOrderId,
        ...(state.currentCalculationId ? { calculationId: state.currentCalculationId } : {}),
        ...(state.currentDecisionId ? { decisionId: state.currentDecisionId } : {}),
        resolveRollIdsAfterCoreLocks: async (lockedTx) => {
          await assertFinanceRouteUnderLock(lockedTx, financeOrderId, route.commercialOrderId);
          const order = await readCalculationOrder(lockedTx, route.commercialOrderId);
          assertCoverageWorkflowVersion(order.warehouseCoverageWorkflowVersion, 2);
          return resolveCoverageCandidateRollIdsAfterCoreLocks(lockedTx, order);
        },
      });
      const lockedInput = await prepareFinanceRefresh(tx, route.commercialOrderId, dto);
      const result = await this.calculateLocked(tx, lockedInput, locks);
      const safeResult = await this.readForFinanceLocked(tx, actor, financeOrderId);
      await this.commands.appendFinal(tx, {
        ...commandInput,
        commandId: acquisition.commandId,
        resultReference: {
          kind: 'calculation',
          calculationId: result.calculationId,
        },
        safeResult,
      });
      return safeResult;
    });
  }

  async readForFinance(
    actor: Actor,
    financeOrderId: string,
  ): Promise<FinanceWarehouseCoverageProjection> {
    requireCapability(actor, 'finance_order:read');
    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
      const epochBefore = await readInventoryEpoch(this.prisma);
      const financeOrder = await this.prisma.financeOrder.findUnique({
        where: { id: financeOrderId },
        select: FINANCE_COVERAGE_SELECT,
      });
      if (!financeOrder) {
        throw new NotFoundException(`Finance order ${financeOrderId} not found`);
      }
      const epochAfter = await readInventoryEpoch(this.prisma);
      if (epochBefore === epochAfter) {
        return financeProjection(financeOrder, actor, epochAfter);
      }
    }
    throw coverageConflict('warehouse_coverage_read_conflict');
  }

  async initializeAtInvoiceHandoff(
    tx: Prisma.TransactionClient,
    commercialOrderId: string,
  ): Promise<WarehouseCoverageProjection> {
    const stateReference = await tx.warehouseCoverageState.findUnique({
      where: { orderId: commercialOrderId },
    });
    if (!stateReference) throw coverageConflict('warehouse_coverage_state_conflict');
    const locks = await lockCoverageResources(tx, {
      orderId: commercialOrderId,
      ...(stateReference.currentCalculationId
        ? { calculationId: stateReference.currentCalculationId }
        : {}),
      ...(stateReference.currentDecisionId ? { decisionId: stateReference.currentDecisionId } : {}),
      resolveRollIdsAfterCoreLocks: async (lockedTx) => {
        const order = await readCalculationOrder(lockedTx, commercialOrderId);
        assertCoverageWorkflowVersion(order.warehouseCoverageWorkflowVersion, 2);
        assertCompleteCoverageOrder(order);
        return resolveCoverageCandidateRollIdsAfterCoreLocks(lockedTx, order);
      },
    });
    const lockedState = await tx.warehouseCoverageState.findUnique({
      where: { orderId: commercialOrderId },
    });
    if (!lockedState) throw coverageConflict('warehouse_coverage_state_conflict');
    if (lockedState.currentCalculationId !== null) {
      return this.readProjectionUnderLock(tx, commercialOrderId, []);
    }
    return (
      await this.calculateLocked(
        tx,
        {
          commercialOrderId,
          expectedStateVersion: lockedState.stateVersion,
          expectedGeneration: null,
        },
        locks,
      )
    ).projection;
  }

  private async resolveFinanceRoute(
    financeOrderId: string,
  ): Promise<{ commercialOrderId: string; workflowVersion: number }> {
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

  async readForFinanceLocked(
    tx: Prisma.TransactionClient,
    actor: Actor,
    financeOrderId: string,
  ): Promise<FinanceWarehouseCoverageProjection> {
    requireCapability(actor, 'finance_order:read');
    const financeOrder = await tx.financeOrder.findUnique({
      where: { id: financeOrderId },
      select: FINANCE_COVERAGE_SELECT,
    });
    if (!financeOrder) throw new NotFoundException(`Finance order ${financeOrderId} not found`);
    return financeProjection(financeOrder, actor, await readInventoryEpoch(tx));
  }

  private async readProjectionUnderLock(
    tx: Prisma.TransactionClient,
    commercialOrderId: string,
    permittedActions: ReturnType<typeof permittedWarehouseCoverageActions>,
  ): Promise<WarehouseCoverageProjection> {
    const order = await tx.commercialOrder.findUnique({
      where: { id: commercialOrderId },
      select: {
        warehouseCoverageWorkflowVersion: true,
        cancellationStatus: true,
        coverageState: {
          include: {
            currentCalculation: true,
            currentDecision: {
              select: {
                kind: true,
                acceptanceTask: { select: { status: true } },
              },
            },
          },
        },
        productionOrder: { select: { id: true } },
      },
    });
    if (!order) throw new NotFoundException(`Commercial order ${commercialOrderId} not found`);
    assertCoverageWorkflowVersion(order.warehouseCoverageWorkflowVersion, 2);
    const coverageState = order.coverageState;
    return projectWarehouseCoverage({
      workflowVersion: 2,
      state: coverageState ? stripStateRelations(coverageState) : null,
      calculation: coverageState?.currentCalculation ?? null,
      currentInventoryEpoch: await readInventoryEpoch(tx),
      orderCancellationStatus: coverageCancellationStatus(order.cancellationStatus),
      productionOrderExists: order.productionOrder !== null,
      currentDecisionKind: coverageDecisionKind(coverageState?.currentDecision?.kind ?? null),
      reserveTaskStatus: taskStatus(coverageState?.currentDecision?.acceptanceTask?.status ?? null),
      permittedActions,
    });
  }
}

export async function resolveCoverageCandidateRollIdsAfterCoreLocks(
  tx: Prisma.TransactionClient,
  order: {
    id: string;
    counterpartyId: string | null;
    positions: readonly { id: string }[];
  },
): Promise<string[]> {
  const positionIds = order.positions.map(({ id }) => id).sort(compareOpaqueIdsBinary);
  const exactSourcePosition =
    positionIds.length === 0
      ? Prisma.sql`FALSE`
      : Prisma.sql`(
          fact."sourceOrderId" = ${order.id}
          AND fact."sourcePositionId" IN (${Prisma.join(positionIds)})
        )`;
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT roll."id"
      FROM "warehouse_rolls" AS roll
      LEFT JOIN "warehouse_roll_coverage_facts" AS fact
        ON fact."id" = roll."currentCoverageFactId"
      WHERE roll."warehouseStatus" = 'received'
        AND roll."reservedForOrderId" IS NULL
        AND roll."reservedForPositionId" IS NULL
        AND roll."reservedByProposalId" IS NULL
        AND roll."reservedByCoverageDecisionId" IS NULL
        AND (roll."producedForOrderId" IS NULL OR roll."releasedFromOrderId" IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM "production_problems" AS problem
          WHERE (
              problem."rollId" = roll."id"
              OR problem."rollId" = roll."rollCode"
            )
            AND problem."status" = 'open'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "defect_records" AS defect
          JOIN "operator_roll_lines" AS line
            ON line."id" = defect."operatorRollLineId"
          JOIN "roll_dispatch_items" AS dispatch
            ON dispatch."id" = line."rollDispatchItemId"
          WHERE defect."blocking" = TRUE
            AND dispatch."rollCode" = roll."rollCode"
        )
        AND (
          roll."ownerCounterpartyId" = ${order.counterpartyId}
          OR (
            roll."ownerCounterpartyId" IS NULL
            AND (
              EXISTS (
                SELECT 1
                FROM "commercial_orders" AS stock_order
                WHERE stock_order."id" = roll."producedForStockOrderId"
                  AND stock_order."requestType" = 'stock_reserve'
              )
              OR EXISTS (
                SELECT 1 FROM "commercial_orders" cancelled_order
                WHERE cancelled_order."id" = roll."releasedFromOrderId"
                  AND cancelled_order."cancellationStatus" = 'cancelled'
              )
              OR ${exactSourcePosition}
              OR EXISTS (
                SELECT 1
                FROM "warehouse_coverage_recheck_memberships" AS membership
                JOIN "order_resolution_cases" AS coverage_case
                  ON coverage_case."id" = membership."caseId"
                WHERE membership."rollId" = roll."id"
                  AND membership."orderId" = ${order.id}
                  AND coverage_case."status" = 'open'
              )
            )
          )
        )
      ORDER BY roll."id" COLLATE "C"
    `,
  );
  return [...new Set(rows.map(({ id }) => id))].sort(compareOpaqueIdsBinary);
}

function classifyCandidates(
  rows: readonly CandidateRoll[],
  orderId: string,
  counterpartyId: string,
  positionIds: ReadonlySet<string>,
): {
  verified: VerifiedCoverageCandidate[];
  uncertain: UncertainCoverageCandidate[];
} {
  const verified: VerifiedCoverageCandidate[] = [];
  const uncertain: UncertainCoverageCandidate[] = [];
  for (const row of rows) {
    if (
      row.warehouseStatus !== 'received' ||
      row.reservedForOrderId !== null ||
      row.reservedForPositionId !== null ||
      row.reservedByProposalId !== null ||
      row.reservedByCoverageDecisionId !== null ||
      (row.producedForOrderId !== null && !row.releasedFromOrderId)
    ) {
      continue;
    }
    const fact = row.currentCoverageFact;
    const rawSpec = asRecord(fact?.spec);
    const sourceOrderId = nullableOpaque(fact?.sourceOrderId ?? rawSpec?.sourceOrderId);
    const sourcePositionId = nullableOpaque(fact?.sourcePositionId ?? rawSpec?.sourcePositionId);
    const inActiveCase = row.coverageMemberships.some(
      (membership) => membership.orderId === orderId && membership.case.status === 'open',
    );
    const sourceRelevant =
      sourceOrderId === orderId && sourcePositionId !== null && positionIds.has(sourcePositionId);
    const companyStock =
      row.ownerCounterpartyId === null &&
      ((row.producedForStockOrderId !== null &&
        row.producedForStockOrder?.requestType === 'stock_reserve') ||
        (Boolean(row.releasedFromOrderId) &&
          row.releasedFromOrder?.cancellationStatus === 'cancelled'));
    if (
      row.ownerCounterpartyId !== counterpartyId &&
      !(row.ownerCounterpartyId === null && (companyStock || inActiveCase || sourceRelevant))
    ) {
      continue;
    }

    const canonical = canonicalFactOrNull(fact);
    const companyStockProvenanceVerified =
      companyStock &&
      canonical !== null &&
      fact?.sourceOrderId === canonical.spec.sourceOrderId &&
      fact?.sourcePositionId === canonical.spec.sourcePositionId &&
      canonical.spec.sourceOrderId === (row.releasedFromOrderId ?? row.producedForStockOrderId) &&
      canonical.spec.sourcePositionId !== null &&
      (row.releasedFromOrder ?? row.producedForStockOrder)?.positions.some(
        ({ id }) => id === canonical.spec.sourcePositionId,
      ) === true;
    const ownershipVerified =
      (row.ownerCounterpartyId === counterpartyId &&
        canonical?.spec.ownerCounterpartyId === counterpartyId) ||
      (companyStockProvenanceVerified && canonical?.spec.ownerCounterpartyId === null);
    if (canonical && ownershipVerified && canonical.spec.rollCode === row.rollCode) {
      verified.push(
        buildVerifiedCandidate({
          rollId: row.id,
          coverageFactId: canonical.factId,
          ownerScope: companyStock ? 'company_stock' : 'counterparty',
          spec: canonical.spec,
        }),
      );
      continue;
    }

    const reasonCodes = new Set<
      'roll_facts_incomplete' | 'roll_ownership_unverified' | 'unsupported_policy_version'
    >();
    if (
      !fact ||
      fact.specVersion !== FACT_SPEC_VERSION ||
      !rawSpec ||
      !canonical ||
      canonical.spec.rollCode !== row.rollCode
    ) {
      reasonCodes.add('roll_facts_incomplete');
    }
    if (
      rawSpec &&
      rawSpec.policyVersion != null &&
      rawSpec.policyVersion !== WAREHOUSE_COVERAGE_POLICY_VERSION
    ) {
      reasonCodes.add('unsupported_policy_version');
    }
    if (
      (!companyStock && row.ownerCounterpartyId === null) ||
      (rawSpec !== null &&
        'ownerCounterpartyId' in rawSpec &&
        nullableOpaque(rawSpec.ownerCounterpartyId) !== row.ownerCounterpartyId)
    ) {
      reasonCodes.add('roll_ownership_unverified');
    }
    if (reasonCodes.size === 0) reasonCodes.add('roll_facts_incomplete');

    uncertain.push({
      rollId: row.id,
      rollCode: row.rollCode,
      ownerCounterpartyId: row.ownerCounterpartyId,
      sourceOrderId,
      sourcePositionId,
      recheckCaseId: inActiveCase ? `active:${orderId}:${row.id}` : null,
      recheckOrderId: inActiveCase ? orderId : null,
      coverageFactId: fact?.id ?? null,
      companyStock,
      known: knownCoverageFields(rawSpec),
      reasonCodes: [
        'roll_facts_incomplete',
        'roll_ownership_unverified',
        'unsupported_policy_version',
      ].filter((reason) =>
        reasonCodes.has(reason as never),
      ) as UncertainCoverageCandidate['reasonCodes'],
    });
  }
  verified.sort(candidateOrder);
  uncertain.sort(candidateOrder);
  return { verified, uncertain };
}

function canonicalFactOrNull(fact: CandidateRoll['currentCoverageFact']) {
  if (!fact || fact.specVersion !== FACT_SPEC_VERSION) return null;
  try {
    const spec = canonicalizeRollCoverageSpec(fact.spec);
    if (fingerprintRollFact(spec) !== fact.specFingerprint) return null;
    return { factId: fact.id, spec };
  } catch {
    return null;
  }
}

function knownCoverageFields(source: Record<string, unknown> | null): CandidateKnownCoverageFields {
  return {
    filmType: safeText(source?.filmType),
    actualThicknessMilliMicron: positiveIntegerOrNull(source?.actualThicknessMilliMicron),
    accountingThicknessMilliMicron: positiveIntegerOrNull(source?.accountingThicknessMilliMicron),
    widthMilliMm: positiveIntegerOrNull(source?.widthMilliMm),
    plannedLengthMilliM: positiveIntegerOrNull(source?.plannedLengthMilliM),
    birka: safeText(source?.birka),
    spoolType: safeSpool(source?.spoolType),
    actualWeightMilliKg: positiveIntegerOrNull(source?.actualWeightMilliKg),
    plannedWeightMilliKg: positiveIntegerOrNull(source?.plannedWeightMilliKg),
    ingredients: safeIngredients(source?.ingredients),
    policyVersion: typeof source?.policyVersion === 'string' ? source.policyVersion : null,
  };
}

function projectFinanceCoverageRoll(match: FinanceCoverageMatch): FinanceCoverageRollProjection {
  const spec = asRecord(match.coverageFact.spec);
  const snapshot = asRecord(match.roll.positionSnapshot);
  const capture = match.coverageFact.sourceWeightCapture;
  const reserved = Boolean(
    match.roll.reservedForOrderId ||
    match.roll.reservedForPositionId ||
    match.roll.reservedByProposalId ||
    match.roll.reservedByCoverageDecisionId,
  );
  const source = coverageRollSource(match.coverageFact.source, snapshot);
  return {
    rollCode: match.roll.rollCode,
    positionId: match.positionId,
    source,
    locationLabel: reserved
      ? 'Резерв заказа'
      : match.roll.warehouseStatus === 'received'
        ? 'Свободный резерв'
        : 'Складской резерв',
    availability: reserved ? 'reserved' : 'available',
    batchCode: displayText(match.roll.producedForStockOrder?.stockBatchCode),
    receivedAt: match.roll.receivedAt?.toISOString() ?? null,
    grossKg:
      positiveDecimalOrNull(capture?.grossKg) ??
      milliProjection(snapshot?.grossMilliKg) ??
      positiveDecimalOrNull(snapshot?.grossKg),
    spoolKg:
      positiveDecimalOrNull(capture?.spoolKg) ??
      milliProjection(snapshot?.spoolMilliKg) ??
      positiveDecimalOrNull(snapshot?.spoolKg),
    requested: {
      filmType: displayText(match.position.filmType),
      actualThicknessMicron: measurementProjection(match.position.actualThickness),
      accountingThicknessMicron: measurementProjection(match.position.accountingThickness),
      widthMm: positiveDecimalOrNull(match.position.widthMm),
      plannedLengthM: positiveDecimalOrNull(match.position.plannedLengthM),
      netKg: positiveDecimalOrNull(match.position.plannedWeightKg),
      spoolType: displayText(match.position.spoolType),
      birka: displayText(match.position.birka) ?? displayText(match.position.manualBirka),
      materialLabel:
        displayText(match.position.recipeDefinitionVersion?.recipeDefinition.name) ??
        displayText(match.position.recipe?.recipeName) ??
        displayText(match.position.baseRawMaterialDefinition?.name),
    },
    matched: {
      filmType: safeText(spec?.filmType),
      actualThicknessMicron: milliProjection(spec?.actualThicknessMilliMicron),
      accountingThicknessMicron: milliProjection(spec?.accountingThicknessMilliMicron),
      widthMm: milliProjection(spec?.widthMilliMm),
      plannedLengthM: milliProjection(spec?.plannedLengthMilliM),
      netKg:
        milliProjection(spec?.actualWeightMilliKg) ??
        positiveDecimalOrNull(capture?.netKg) ??
        milliProjection(snapshot?.netMilliKg),
      spoolType: safeText(spec?.spoolType),
      birka: safeText(spec?.birka),
      materialLabel:
        displayText(
          match.coverageFact.sourcePosition?.recipeDefinitionVersion?.recipeDefinition.name,
        ) ??
        displayText(match.coverageFact.sourcePosition?.recipe?.recipeName) ??
        displayText(match.coverageFact.sourcePosition?.baseRawMaterialDefinition?.name) ??
        displayText(snapshot?.materialLabel) ??
        displayText(spec?.recipeVersion),
    },
  };
}

function coverageRollSource(
  factSource: string,
  snapshot: Record<string, unknown> | null,
): FinanceCoverageRollProjection['source'] {
  if (snapshot?.source === 'platform' || factSource === 'manual_platform') {
    return 'platform';
  }
  return factSource === 'production_handover' ? 'production' : 'legacy';
}

function displayText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized || null;
}

function positiveDecimalOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Number(value.toFixed(3))
    : null;
}

function milliProjection(value: unknown): number | null {
  const integer = positiveIntegerOrNull(value);
  return integer === null ? null : Number((integer / 1_000).toFixed(3));
}

function measurementProjection(value: unknown): number | null {
  if (typeof value === 'number') return positiveDecimalOrNull(value);
  if (typeof value !== 'string') return null;
  const numeric = value
    .trim()
    .replace(',', '.')
    .match(/\d+(?:\.\d+)?/u)?.[0];
  return numeric ? positiveDecimalOrNull(Number(numeric)) : null;
}

function financeProjection(
  financeOrder: FinanceCoverageOrder,
  actor: Actor,
  currentEpoch: bigint,
): FinanceWarehouseCoverageProjection {
  assertCoverageWorkflowVersion(financeOrder.commercialOrder.warehouseCoverageWorkflowVersion, 2);
  const state = financeOrder.commercialOrder.coverageState;
  const calculation = state?.currentCalculation ?? null;
  const projection = projectWarehouseCoverage({
    workflowVersion: 2,
    state: state ? stripStateRelations(state) : null,
    calculation,
    currentInventoryEpoch: currentEpoch,
    orderCancellationStatus: coverageCancellationStatus(
      financeOrder.commercialOrder.cancellationStatus,
    ),
    productionOrderExists: financeOrder.commercialOrder.productionOrder !== null,
    currentDecisionKind: coverageDecisionKind(state?.currentDecision?.kind ?? null),
    reserveTaskStatus: taskStatus(state?.currentDecision?.acceptanceTask?.status ?? null),
    permittedActions: permittedWarehouseCoverageActions(actor.capabilities),
  });
  const financeRolls =
    !projection.stale && calculation?.availability === 'verified_full'
      ? calculation.matches
          .map(projectFinanceCoverageRoll)
          .sort(
            (left, right) =>
              compareOpaqueIdsBinary(left.rollCode, right.rollCode) ||
              compareOpaqueIdsBinary(left.positionId, right.positionId),
          )
      : [];
  return { ...projection, financeRolls };
}

function stripStateRelations(
  state:
    | NonNullable<FinanceCoverageOrder['commercialOrder']['coverageState']>
    | ({
        currentCalculation: WarehouseCoverageCalculation | null;
        currentDecision: { acceptanceTask: { status: string } | null } | null;
      } & PersistedCoverageState),
): PersistedCoverageState {
  const { currentCalculation: _calculation, currentDecision: _decision, ...persisted } = state;
  return persisted;
}

async function readCalculationOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<CalculationOrder> {
  const order = await tx.commercialOrder.findUnique({
    where: { id: orderId },
    select: CALCULATION_ORDER_SELECT,
  });
  if (!order) throw new NotFoundException(`Commercial order ${orderId} not found`);
  return order;
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

async function prepareFinanceRefresh(
  tx: Prisma.TransactionClient,
  commercialOrderId: string,
  dto: RefreshWarehouseCoverageDto,
): Promise<LockedCoverageInput> {
  const state = await tx.warehouseCoverageState.findUnique({
    where: { orderId: commercialOrderId },
    select: {
      state: true,
      stateVersion: true,
      generation: true,
      currentCalculationId: true,
      currentDecisionId: true,
      currentCalculation: { select: { inventoryEpoch: true } },
      currentDecision: { select: { kind: true } },
      order: {
        select: {
          cancellationStatus: true,
          productionOrder: { select: { id: true } },
        },
      },
    },
  });
  if (
    !state ||
    state.stateVersion !== dto.expectedStateVersion ||
    state.generation !== (dto.expectedGeneration ?? 0) ||
    (dto.expectedGeneration === null
      ? state.currentCalculationId !== null
      : state.currentCalculationId === null)
  ) {
    throw coverageConflict('warehouse_coverage_state_conflict');
  }
  if (state.order.cancellationStatus !== 'active') {
    throw coverageConflict('warehouse_coverage_refresh_not_allowed');
  }
  if (dto.expectedGeneration === null) {
    if (
      state.state !== 'calculating' ||
      state.generation !== 0 ||
      state.currentCalculationId !== null ||
      state.currentCalculation !== null ||
      state.currentDecisionId !== null ||
      state.currentDecision !== null ||
      state.order.productionOrder !== null
    ) {
      throw coverageConflict('warehouse_coverage_refresh_not_allowed');
    }
    return {
      commercialOrderId,
      expectedStateVersion: dto.expectedStateVersion,
      expectedGeneration: null,
    };
  }
  if (
    !state.currentCalculation ||
    state.order.productionOrder !== null ||
    state.state === 'warehouse_reserved' ||
    state.state === 'recheck_requested' ||
    state.currentDecision?.kind === 'use_warehouse' ||
    state.currentDecision?.kind === 'produce_all' ||
    (state.state === 'stale' && state.currentDecision?.kind !== 'auto_produce_all') ||
    (state.state === 'order_spec_changed' && state.currentDecisionId !== null)
  ) {
    throw coverageConflict('warehouse_coverage_refresh_not_allowed');
  }

  const currentEpoch = await readInventoryEpoch(tx);
  const epochChanged = state.currentCalculation.inventoryEpoch !== currentEpoch;
  const refreshable =
    state.state === 'stale' ||
    state.state === 'order_spec_changed' ||
    (epochChanged &&
      (state.state === 'awaiting_finance' ||
        state.state === 'unknown' ||
        state.state === 'production_required'));
  if (!refreshable) {
    throw coverageConflict('warehouse_coverage_refresh_not_allowed');
  }

  let expectedStateVersion = dto.expectedStateVersion;
  if (state.state === 'production_required') {
    if (state.currentDecision?.kind !== 'auto_produce_all' || state.currentDecisionId === null) {
      throw coverageConflict('warehouse_coverage_refresh_not_allowed');
    }
    const staleCas = await tx.warehouseCoverageState.updateMany({
      where: {
        orderId: commercialOrderId,
        state: 'production_required',
        stateVersion: dto.expectedStateVersion,
        generation: state.generation,
        currentCalculationId: state.currentCalculationId,
        currentDecisionId: state.currentDecisionId,
      },
      data: {
        state: 'stale',
        stateVersion: { increment: 1 },
      },
    });
    if (staleCas.count !== 1) {
      throw coverageConflict('warehouse_coverage_state_conflict');
    }
    expectedStateVersion += 1;
  }

  return {
    commercialOrderId,
    expectedStateVersion,
    expectedGeneration: dto.expectedGeneration,
  };
}

function assertCompleteCoverageOrder(order: CalculationOrder): void {
  const completeness = validateV2CoverageCompleteness(order);
  if (!completeness.ok) {
    throw new ConflictException({
      statusCode: 409,
      code: completeness.reasonCode,
      message: 'Спецификация заказа неполная для расчёта складского покрытия.',
      missing: completeness.missing,
    });
  }
}

async function readInventoryEpoch(
  client: Pick<Prisma.TransactionClient, 'warehouseCoverageInventoryEpoch'>,
): Promise<bigint> {
  const row = await client.warehouseCoverageInventoryEpoch.findUnique({
    where: { id: 1 },
    select: { epoch: true },
  });
  if (!row) throw coverageConflict('warehouse_coverage_epoch_missing');
  return row.epoch;
}

function assertLockEnvelope(orderId: string, locks: CoverageLocksHeld): void {
  if (
    !locks ||
    locks[COVERAGE_LOCKS_HELD] !== true ||
    locks.orderId !== orderId ||
    !Array.isArray(locks.acquiredLevels) ||
    !Array.isArray(locks.rollIds)
  ) {
    throw coverageConflict('warehouse_coverage_lock_proof_invalid');
  }
  const binaryRollIds = [...new Set(locks.rollIds)].sort(compareOpaqueIdsBinary);
  if (
    binaryRollIds.length !== locks.rollIds.length ||
    binaryRollIds.some((id, index) => id !== locks.rollIds[index])
  ) {
    throw coverageConflict('warehouse_coverage_lock_proof_invalid');
  }
}

function assertCoreLockProof(state: PersistedCoverageState, locks: CoverageLocksHeld): void {
  const held = new Set(locks.acquiredLevels);
  const required = ['inventory_epoch', 'coverage_state', 'commercial_order'] as const;
  if (required.some((level) => !held.has(level))) {
    throw coverageConflict('warehouse_coverage_lock_proof_invalid');
  }
  if (state.currentCalculationId && !held.has('current_calculation')) {
    throw coverageConflict('warehouse_coverage_lock_proof_invalid');
  }
  if (state.currentDecisionId && !held.has('current_decision')) {
    throw coverageConflict('warehouse_coverage_lock_proof_invalid');
  }
}

function assertExactLockedCandidates(
  expectedCandidateIds: readonly string[],
  locks: CoverageLocksHeld,
): void {
  if (
    expectedCandidateIds.length !== locks.rollIds.length ||
    expectedCandidateIds.some((id, index) => id !== locks.rollIds[index]) ||
    (expectedCandidateIds.length > 0 && !locks.acquiredLevels.includes('warehouse_rolls_binary'))
  ) {
    throw coverageConflict('warehouse_coverage_candidate_set_changed');
  }
}

function assertExpectedState(state: PersistedCoverageState, input: LockedCoverageInput): void {
  if (
    state.stateVersion !== input.expectedStateVersion ||
    (input.expectedGeneration === null
      ? state.generation !== 0 || state.currentCalculationId !== null
      : state.generation !== input.expectedGeneration || state.currentCalculationId === null)
  ) {
    throw coverageConflict('warehouse_coverage_state_conflict');
  }
}

function assertCoverageWorkflowVersion(actual: number, expected: 2): void {
  assertCoverageWorkflow(actual as 1 | 2, expected);
}

function requireCapability(
  actor: Actor,
  capability: 'finance_order:read' | 'warehouse_coverage:refresh',
): void {
  if (!actor.capabilities.includes(capability)) {
    throw new ForbiddenException(`Missing capability: ${capability}`);
  }
}

function coverageConflict(code: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code,
    message: 'Warehouse coverage changed concurrently. Reload and retry.',
  });
}

function requiredRollCount(positions: readonly { rollCount: number }[]): number {
  return positions.reduce(
    (total, position) =>
      Number.isSafeInteger(position.rollCount) && position.rollCount > 0
        ? total + position.rollCount
        : total,
    0,
  );
}

function candidateOrder(
  left: VerifiedCoverageCandidate | UncertainCoverageCandidate,
  right: VerifiedCoverageCandidate | UncertainCoverageCandidate,
): number {
  const leftCode = 'spec' in left ? left.spec.rollCode : left.rollCode;
  const rightCode = 'spec' in right ? right.spec.rollCode : right.rollCode;
  return (
    compareOpaqueIdsBinary(leftCode, rightCode) || compareOpaqueIdsBinary(left.rollId, right.rollId)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableOpaque(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function safeText(value: unknown): string | null {
  try {
    return normalizeCoverageText(value);
  } catch {
    return null;
  }
}

function safeSpool(value: unknown): string | null {
  try {
    return normalizeSpool(value);
  } catch {
    return null;
  }
}

function safeIngredients(value: unknown): readonly CanonicalIngredient[] | null {
  try {
    return normalizeIngredients(value);
  } catch {
    return null;
  }
}

function taskStatus(value: string | null): 'open' | 'partial' | 'closed' | null {
  return value === 'open' || value === 'partial' || value === 'closed' ? value : null;
}

function coverageCancellationStatus(value: string): 'active' | 'cancelled' {
  if (value === 'active' || value === 'cancelled') return value;
  throw coverageConflict('warehouse_coverage_state_conflict');
}

function coverageDecisionKind(
  value: string | null,
): 'use_warehouse' | 'produce_all' | 'auto_produce_all' | null {
  if (value === 'use_warehouse' || value === 'produce_all' || value === 'auto_produce_all') {
    return value;
  }
  return null;
}
