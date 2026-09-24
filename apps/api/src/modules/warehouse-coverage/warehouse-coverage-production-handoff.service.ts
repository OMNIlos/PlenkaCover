import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type WarehouseCoverageState } from '@prisma/client';
import type { WarehouseCoverageProjection } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import {
  assertProductionDispatchItemCount,
  MAX_PRODUCTION_DISPATCH_ITEMS,
} from '../../common/production-order-limits';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  captureProductionClearance,
  financeAllowsProduction,
} from '../finance/payment-production-gate';
import {
  parseRecipeSnapshotIngredients,
  recipeSnapshotMatchesVersion,
} from '../material-catalog/recipe-snapshot';
import {
  resolveCoverageCandidateRollIdsAfterCoreLocks,
  WarehouseCoverageCalculationService,
} from './warehouse-coverage-calculation.service';
import { projectWarehouseCoverage } from './warehouse-coverage-projection';
import {
  lockCoverageResources,
  WarehouseCoverageTransaction,
} from './warehouse-coverage-transaction';

export interface V2ProductionHandoffResult {
  productionOrderId: string;
  sourceCalculationId: string;
  sourceDecisionId: string;
  inputFingerprint: string;
  generation: number;
}

export type V2ProductionHandoffTransactionOutcome =
  | { kind: 'created'; result: V2ProductionHandoffResult }
  | {
      kind: 'route_changed';
      projection: WarehouseCoverageProjection;
      calculationId: string;
    }
  | {
      kind: 'blocked';
      projection: WarehouseCoverageProjection;
      calculationId: string;
    }
  | { kind: 'too_large'; rollCount: number };

export const COMMERCIAL_HANDOFF_POSITION_INCLUDE = {
  recipe: true,
  baseRawMaterialDefinition: {
    select: {
      id: true,
      name: true,
      stock: { select: { materialId: true } },
    },
  },
  recipeDefinitionVersion: {
    select: {
      id: true,
      version: true,
      recipeDefinition: { select: { id: true, name: true } },
      ingredients: {
        select: {
          sequence: true,
          shareBasisPoints: true,
          rawMaterialDefinition: { select: { id: true, name: true } },
        },
        orderBy: { sequence: 'asc' },
      },
    },
  },
  coverProposals: {
    include: {
      reservedRolls: {
        select: {
          id: true,
          reservedForOrderId: true,
          reservedForPositionId: true,
          reservedByProposalId: true,
        },
      },
    },
  },
} satisfies Prisma.CommercialOrderPositionInclude;

export type CommercialHandoffPosition = Prisma.CommercialOrderPositionGetPayload<{
  include: typeof COMMERCIAL_HANDOFF_POSITION_INCLUDE;
}>;

type ProductionRecipeSnapshot = {
  recipeDefinitionVersionId: string | null;
  name: string;
  version: number | null;
  ingredients: Array<{
    rawMaterialDefinitionId: string;
    name: string;
    shareBasisPoints: number;
  }>;
};

const PRODUCTION_HANDOFF_ORDER_INCLUDE = {
  positions: {
    include: COMMERCIAL_HANDOFF_POSITION_INCLUDE,
    orderBy: { id: 'asc' as const },
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
} satisfies Prisma.CommercialOrderInclude;

const CALCULATION_ORDER_SELECT = {
  id: true,
  version: true,
  warehouseCoverageWorkflowVersion: true,
  counterpartyId: true,
  positions: {
    include: { recipe: true },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.CommercialOrderSelect;

const HANDOFF_STATE_SELECT = {
  orderId: true,
  state: true,
  stateVersion: true,
  generation: true,
  currentCalculationId: true,
  currentDecisionId: true,
  createdAt: true,
  updatedAt: true,
  currentCalculation: true,
  currentDecision: {
    select: {
      id: true,
      orderId: true,
      calculationId: true,
      generation: true,
      kind: true,
      inputFingerprint: true,
      sourceInventoryEpoch: true,
      committedInventoryEpoch: true,
      expectedRollCount: true,
      actorKind: true,
      actorRole: true,
      actorId: true,
      systemActorKey: true,
      createdAt: true,
      acceptanceTask: { select: { status: true } },
    },
  },
} satisfies Prisma.WarehouseCoverageStateSelect;

type HandoffState = Prisma.WarehouseCoverageStateGetPayload<{
  select: typeof HANDOFF_STATE_SELECT;
}>;

type HandoffOrder = Prisma.CommercialOrderGetPayload<{
  include: typeof PRODUCTION_HANDOFF_ORDER_INCLUDE;
}>;

type LockedRoute = {
  order: HandoffOrder;
  state: HandoffState;
  inventoryEpoch: bigint;
};

export function recipeNumber(
  recipe: { parameters: Prisma.JsonValue } | null,
  labels: readonly string[],
): number | null {
  if (!recipe || !Array.isArray(recipe.parameters)) return null;
  for (const value of recipe.parameters) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.label !== 'string' || !labels.includes(record.label)) continue;
    const parsed = Number(
      String(record.value ?? '')
        .trim()
        .replace(',', '.'),
    );
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function invalidRecipeSnapshot(positionId: string): never {
  throw new ConflictException({
    code: 'RECIPE_SNAPSHOT_INVALID',
    message: `Recipe snapshot is invalid for position ${positionId}.`,
  });
}

export function productionRecipeSnapshot(position: CommercialHandoffPosition): {
  rawMaterialId: string | null;
  recipe: ProductionRecipeSnapshot | null;
} {
  const structuredSelectionPresent =
    position.baseRawMaterialDefinitionId != null ||
    position.recipeDefinitionVersionId != null ||
    position.recipe?.recipeDefinitionId != null ||
    position.recipe?.recipeDefinitionVersionId != null ||
    position.recipe?.recipeVersionNumber != null ||
    position.recipe?.recipeName != null;
  const parsed = parseRecipeSnapshotIngredients(
    position.recipe?.ingredients,
    structuredSelectionPresent,
  );
  if (parsed.kind === 'invalid') invalidRecipeSnapshot(position.id);
  if (parsed.kind === 'legacy') {
    return { rawMaterialId: position.rawMaterialId, recipe: null };
  }
  if (!position.recipe) invalidRecipeSnapshot(position.id);

  const name = position.recipe.recipeName;
  if (typeof name !== 'string' || name.length === 0 || name.length > 120 || name.trim() !== name) {
    invalidRecipeSnapshot(position.id);
  }
  const snapshotDefinitionId = position.recipe.recipeDefinitionId;
  const snapshotVersionId = position.recipe.recipeDefinitionVersionId;
  const positionVersionId = position.recipeDefinitionVersionId;
  const selectedVersion = position.recipeDefinitionVersion;
  const namedRecipe = snapshotVersionId != null || positionVersionId != null;
  if (namedRecipe) {
    if (
      position.baseRawMaterialDefinitionId != null ||
      typeof snapshotDefinitionId !== 'string' ||
      snapshotDefinitionId.length === 0 ||
      snapshotDefinitionId.trim() !== snapshotDefinitionId ||
      typeof snapshotVersionId !== 'string' ||
      snapshotVersionId.length === 0 ||
      snapshotVersionId.trim() !== snapshotVersionId ||
      typeof positionVersionId !== 'string' ||
      positionVersionId !== snapshotVersionId ||
      selectedVersion?.id !== positionVersionId ||
      snapshotDefinitionId !== selectedVersion.recipeDefinition.id ||
      !Number.isInteger(position.recipe.recipeVersionNumber) ||
      (position.recipe.recipeVersionNumber ?? 0) <= 0 ||
      position.recipe.recipeVersionNumber !== selectedVersion.version ||
      name !== selectedVersion.recipeDefinition.name ||
      !recipeSnapshotMatchesVersion(parsed.ingredients, selectedVersion.ingredients)
    ) {
      invalidRecipeSnapshot(position.id);
    }
    return {
      rawMaterialId: null,
      recipe: {
        recipeDefinitionVersionId: snapshotVersionId,
        name,
        version: position.recipe.recipeVersionNumber,
        ingredients: parsed.ingredients,
      },
    };
  }

  const baseDefinitionId = position.baseRawMaterialDefinitionId;
  const baseDefinition = position.baseRawMaterialDefinition;
  if (
    typeof baseDefinitionId !== 'string' ||
    baseDefinitionId.length === 0 ||
    baseDefinitionId.trim() !== baseDefinitionId ||
    snapshotDefinitionId != null ||
    position.recipe.recipeVersionNumber != null ||
    baseDefinition?.id !== baseDefinitionId ||
    name !== baseDefinition.name ||
    parsed.ingredients.length !== 1 ||
    parsed.ingredients[0]?.rawMaterialDefinitionId !== baseDefinition.id ||
    parsed.ingredients[0]?.name !== baseDefinition.name ||
    parsed.ingredients[0]?.shareBasisPoints !== 10_000
  ) {
    invalidRecipeSnapshot(position.id);
  }
  return {
    rawMaterialId: position.baseRawMaterialDefinition?.stock?.materialId ?? null,
    recipe: {
      recipeDefinitionVersionId: null,
      name,
      version: null,
      ingredients: parsed.ingredients,
    },
  };
}

@Injectable()
export class WarehouseCoverageProductionHandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly coverageTransaction: WarehouseCoverageTransaction,
    private readonly calculations: WarehouseCoverageCalculationService,
    private readonly fulfillment: OrderFulfillmentHandoffService,
  ) {}

  async createV2ProductionOrder(
    actor: Actor,
    commercialOrderId: string,
  ): Promise<V2ProductionHandoffResult> {
    let outcome: V2ProductionHandoffTransactionOutcome;
    try {
      outcome = await this.coverageTransaction.run(async (tx) => {
        await this.fulfillment.acquireDeliveryScopeLock(tx, commercialOrderId);
        const reference = await tx.warehouseCoverageState.findUnique({
          where: { orderId: commercialOrderId },
          select: {
            currentCalculationId: true,
            currentDecisionId: true,
            order: {
              select: {
                warehouseCoverageWorkflowVersion: true,
                productionOrder: { select: { id: true } },
              },
            },
          },
        });
        if (!reference) {
          const exists = await tx.commercialOrder.findUnique({
            where: { id: commercialOrderId },
            select: { id: true },
          });
          if (!exists) {
            throw new NotFoundException(`Commercial order ${commercialOrderId} not found`);
          }
          throw coverageConflict('warehouse_coverage_state_conflict');
        }
        assertV2Workflow(reference.order.warehouseCoverageWorkflowVersion);

        const locks = await lockCoverageResources(tx, {
          orderId: commercialOrderId,
          ...(reference.currentCalculationId
            ? { calculationId: reference.currentCalculationId }
            : {}),
          ...(reference.currentDecisionId ? { decisionId: reference.currentDecisionId } : {}),
          ...(reference.order.productionOrder?.id
            ? { productionOrderId: reference.order.productionOrder.id }
            : {}),
          resolveRollIdsAfterCoreLocks: async (lockedTx) => {
            if (reference.order.productionOrder) return [];
            const route = await this.readLockedRoute(lockedTx, commercialOrderId);
            if (!shouldRefreshAutoRoute(route)) return [];
            const order = await lockedTx.commercialOrder.findUnique({
              where: { id: commercialOrderId },
              select: CALCULATION_ORDER_SELECT,
            });
            if (!order) {
              throw new NotFoundException(`Commercial order ${commercialOrderId} not found`);
            }
            assertV2Workflow(order.warehouseCoverageWorkflowVersion);
            return resolveCoverageCandidateRollIdsAfterCoreLocks(lockedTx, order);
          },
        });

        let route = await this.readLockedRoute(tx, commercialOrderId);
        const existing = await tx.productionOrder.findUnique({
          where: { commercialOrderId },
        });
        if (existing) {
          return {
            kind: 'created',
            result: existingV2Result(existing),
          };
        }
        const initialProductionRollCount = route.order.positions.reduce(
          (total, position) => total + position.rollCount,
          0,
        );
        const initialRollCountIsSafe =
          Number.isSafeInteger(initialProductionRollCount) &&
          initialProductionRollCount > 0 &&
          initialProductionRollCount <= MAX_PRODUCTION_DISPATCH_ITEMS;
        const refreshRequired = shouldRefreshAutoRoute(route);
        if (!initialRollCountIsSafe && !refreshRequired && hasCompatibleProductionDecision(route)) {
          return { kind: 'too_large', rollCount: initialProductionRollCount };
        }
        await assertFinanceGate(tx, this.audit, actor, route.order);
        if (refreshRequired) {
          const originalGeneration = route.state.generation;
          let expectedStateVersion = route.state.stateVersion;
          if (route.state.state === 'production_required') {
            const stale = await tx.warehouseCoverageState.updateMany({
              where: {
                orderId: commercialOrderId,
                state: 'production_required',
                stateVersion: route.state.stateVersion,
                generation: route.state.generation,
                currentCalculationId: route.state.currentCalculationId,
                currentDecisionId: route.state.currentDecisionId,
              },
              data: {
                state: 'stale',
                stateVersion: { increment: 1 },
              },
            });
            if (stale.count !== 1) {
              throw coverageConflict('warehouse_coverage_state_conflict');
            }
            expectedStateVersion += 1;
          }
          const refreshed = await this.calculations.calculateLocked(
            tx,
            {
              commercialOrderId,
              expectedStateVersion,
              expectedGeneration: originalGeneration,
            },
            locks,
          );
          if (refreshed.projection.availability === 'verified_full') {
            return {
              kind: 'route_changed',
              projection: refreshed.projection,
              calculationId: refreshed.calculationId,
            };
          }
          if (refreshed.projection.availability === 'unknown') {
            return {
              kind: 'blocked',
              projection: refreshed.projection,
              calculationId: refreshed.calculationId,
            };
          }
          route = await this.readLockedRoute(tx, commercialOrderId);
        }
        const nonProduction = nonProductionOutcome(route);
        if (nonProduction) return nonProduction;
        assertProductionRoute(route);
        return {
          kind: 'created',
          result: await this.createProductionOrder(tx, actor, route),
        };
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const winner = await this.prisma.productionOrder.findUnique({
          where: { commercialOrderId },
        });
        if (winner) return existingV2Result(winner);
      }
      throw error;
    }

    if (outcome.kind === 'route_changed') {
      throw handoffConflict(
        'warehouse_coverage_route_changed',
        'Warehouse coverage route changed; reload the order.',
        outcome,
      );
    }
    if (outcome.kind === 'blocked') {
      throw handoffConflict(
        'warehouse_coverage_blocked',
        'Warehouse coverage is unresolved; production handoff is blocked.',
        outcome,
      );
    }
    if (outcome.kind === 'too_large') {
      assertProductionDispatchItemCount(outcome.rollCount);
      throw new Error('production roll-count guard did not reject an invalid count');
    }
    return outcome.result;
  }

  private async readLockedRoute(
    tx: Prisma.TransactionClient,
    commercialOrderId: string,
  ): Promise<LockedRoute> {
    const [order, state, epoch] = await Promise.all([
      tx.commercialOrder.findUnique({
        where: { id: commercialOrderId },
        include: PRODUCTION_HANDOFF_ORDER_INCLUDE,
      }),
      tx.warehouseCoverageState.findUnique({
        where: { orderId: commercialOrderId },
        select: HANDOFF_STATE_SELECT,
      }),
      tx.warehouseCoverageInventoryEpoch.findUnique({
        where: { id: 1 },
        select: { epoch: true },
      }),
    ]);
    if (!order) {
      throw new NotFoundException(`Commercial order ${commercialOrderId} not found`);
    }
    assertV2Workflow(order.warehouseCoverageWorkflowVersion);
    if (!state || !epoch) throw coverageConflict('warehouse_coverage_state_conflict');
    return { order, state, inventoryEpoch: epoch.epoch };
  }

  private async createProductionOrder(
    tx: Prisma.TransactionClient,
    actor: Actor,
    route: LockedRoute,
  ): Promise<V2ProductionHandoffResult> {
    const calculation = route.state.currentCalculation!;
    const decision = route.state.currentDecision!;
    if (route.order.positions.length === 0) {
      throw new ConflictException('Order has no positions to hand off');
    }
    const productionRollCount = route.order.positions.reduce(
      (total, position) => total + position.rollCount,
      0,
    );
    assertProductionDispatchItemCount(productionRollCount);
    const recipes = new Map(
      route.order.positions.map((position) => [position.id, productionRecipeSnapshot(position)]),
    );
    const maxQueue = await tx.rollDispatchItem.aggregate({ _max: { queueRank: true } });
    const created = await tx.productionOrder.create({
      data: {
        commercialOrderId: route.order.id,
        indicator: 'needs_production',
        approvalState: 'pending',
        sourceCoverageCalculationId: calculation.id,
        sourceCoverageDecisionId: decision.id,
        sourceCoverageInputFingerprint: calculation.inputFingerprint,
        sourceCoverageGeneration: calculation.generation,
      },
    });

    let number = 0;
    const baseRank = maxQueue._max.queueRank ?? 0;
    const rolls = route.order.positions.flatMap((position) => {
      const materialRecipe = recipes.get(position.id)!;
      const plannedWeightKg =
        recipeNumber(position.recipe, ['План. вес, кг']) ?? position.plannedWeightKg;
      const plannedLengthM =
        position.plannedLengthM ?? recipeNumber(position.recipe, ['Метраж, м', 'Длина, м']);
      const widthMm =
        position.widthMm ??
        recipeNumber(position.recipe, ['Ширина', 'Ширина, мм', 'Ширина (мм)', 'Размер, мм']);
      const snapshot = {
        filmType: position.filmType,
        actualThickness: position.actualThickness,
        accountingThickness: position.accountingThickness,
        rawMaterialId: materialRecipe.rawMaterialId,
        spoolType: position.spoolType,
        birka: position.birka,
        widthMm,
        plannedLengthM,
        plannedWeightKg,
        recipeParameters: position.recipe?.parameters ?? [],
        ...(materialRecipe.recipe ? { recipe: materialRecipe.recipe } : {}),
      };
      return Array.from({ length: position.rollCount }, (_, productionIndex) => {
        number += 1;
        return {
          rollCode: `${route.order.orderNumber}-roll-${number}`,
          productionOrderId: created.id,
          orderLineId: position.id,
          positionSequence: productionIndex + 1,
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
    if (rolls.length === 0) {
      throw new ConflictException('Order has no rolls to hand off');
    }
    await tx.rollDispatchItem.createMany({ data: rolls });
    await tx.commercialOrder.update({
      where: { id: route.order.id },
      data: { productionIndicator: 'needs_production' },
    });
    await this.audit.record(
      {
        type: 'audit:production_order_created',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: created.id,
        label: `Production order created from ${route.order.orderNumber} (${rolls.length} rolls)`,
        detail: {
          commercialOrderId: route.order.id,
          productionOrderId: created.id,
          orderNumber: route.order.orderNumber,
          sourceCoverageCalculationId: calculation.id,
          sourceCoverageDecisionId: decision.id,
          sourceCoverageGeneration: calculation.generation,
        },
      },
      tx,
    );
    return {
      productionOrderId: created.id,
      sourceCalculationId: calculation.id,
      sourceDecisionId: decision.id,
      inputFingerprint: calculation.inputFingerprint,
      generation: calculation.generation,
    };
  }
}

function shouldRefreshAutoRoute(route: LockedRoute): boolean {
  const calculation = route.state.currentCalculation;
  const decision = route.state.currentDecision;
  return Boolean(
    calculation &&
    decision?.kind === 'auto_produce_all' &&
    (route.state.state === 'stale' || calculation.inventoryEpoch !== route.inventoryEpoch),
  );
}

function nonProductionOutcome(
  route: LockedRoute,
): Exclude<V2ProductionHandoffTransactionOutcome, { kind: 'created' }> | null {
  const calculation = route.state.currentCalculation;
  if (!calculation) {
    throw coverageConflict('warehouse_coverage_state_conflict');
  }
  const projection = routeProjection(route);
  if (hasCompatibleProductionDecision(route)) {
    return null;
  }
  if (calculation.availability === 'verified_full') {
    return { kind: 'route_changed', projection, calculationId: calculation.id };
  }
  if (calculation.availability === 'unknown') {
    return { kind: 'blocked', projection, calculationId: calculation.id };
  }
  return { kind: 'blocked', projection, calculationId: calculation.id };
}

function assertProductionRoute(route: LockedRoute): void {
  const calculation = route.state.currentCalculation;
  const decision = route.state.currentDecision;
  if (
    !calculation ||
    !decision ||
    route.state.currentCalculationId !== calculation.id ||
    route.state.currentDecisionId !== decision.id ||
    calculation.orderId !== route.order.id ||
    decision.orderId !== route.order.id ||
    decision.calculationId !== calculation.id ||
    decision.generation !== calculation.generation ||
    decision.inputFingerprint !== calculation.inputFingerprint ||
    route.state.generation !== calculation.generation ||
    !hasCompatibleProductionDecision(route)
  ) {
    throw coverageConflict('warehouse_coverage_state_conflict');
  }
}

function hasCompatibleProductionDecision(route: LockedRoute): boolean {
  const calculation = route.state.currentCalculation;
  const decision = route.state.currentDecision;
  if (!calculation || !decision || route.state.state !== 'production_required') {
    return false;
  }
  return (
    (decision.kind === 'produce_all' && calculation.availability === 'verified_full') ||
    (decision.kind === 'auto_produce_all' && calculation.availability === 'unavailable')
  );
}

async function assertFinanceGate(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  actor: Actor,
  order: HandoffOrder,
): Promise<void> {
  const handoffStage =
    order.commercialStage === 'sent_to_finance' || order.commercialStage === 'in_work';
  if (!handoffStage) {
    throw new ConflictException('Order payment terms do not allow production handoff yet');
  }
  const capturedAt = order.financeOrder
    ? await captureProductionClearance(
        tx,
        audit,
        actor,
        order.financeOrder.id,
        'Warehouse coverage handoff to production.',
      )
    : null;
  if (!capturedAt && !financeAllowsProduction(order.financeOrder)) {
    throw new ConflictException('Order payment terms do not allow production handoff yet');
  }
}

function routeProjection(route: LockedRoute): WarehouseCoverageProjection {
  const state = stripStateRelations(route.state);
  return projectWarehouseCoverage({
    workflowVersion: 2,
    state,
    calculation: route.state.currentCalculation,
    currentInventoryEpoch: route.inventoryEpoch,
    orderCancellationStatus: coverageCancellationStatus(route.order.cancellationStatus),
    productionOrderExists: false,
    currentDecisionKind: coverageDecisionKind(route.state.currentDecision?.kind ?? null),
    reserveTaskStatus: acceptanceTaskStatus(
      route.state.currentDecision?.acceptanceTask?.status ?? null,
    ),
    permittedActions: [],
  });
}

function stripStateRelations(state: HandoffState): WarehouseCoverageState {
  const { currentCalculation: _calculation, currentDecision: _decision, ...persisted } = state;
  return persisted;
}

function coverageDecisionKind(
  value: string | null,
): 'use_warehouse' | 'produce_all' | 'auto_produce_all' | null {
  return value === 'use_warehouse' || value === 'produce_all' || value === 'auto_produce_all'
    ? value
    : null;
}

function acceptanceTaskStatus(value: string | null): 'open' | 'partial' | 'closed' | null {
  return value === 'open' || value === 'partial' || value === 'closed' ? value : null;
}

function coverageCancellationStatus(value: string): 'active' | 'cancelled' {
  if (value === 'active' || value === 'cancelled') return value;
  throw coverageConflict('warehouse_coverage_state_conflict');
}

function existingV2Result(order: {
  id: string;
  sourceCoverageCalculationId: string | null;
  sourceCoverageDecisionId: string | null;
  sourceCoverageInputFingerprint: string | null;
  sourceCoverageGeneration: number | null;
}): V2ProductionHandoffResult {
  if (
    !order.sourceCoverageCalculationId ||
    !order.sourceCoverageDecisionId ||
    !order.sourceCoverageInputFingerprint ||
    !/^[0-9a-f]{64}$/u.test(order.sourceCoverageInputFingerprint) ||
    order.sourceCoverageGeneration === null ||
    !Number.isSafeInteger(order.sourceCoverageGeneration) ||
    order.sourceCoverageGeneration <= 0
  ) {
    throw coverageConflict('warehouse_coverage_provenance_invalid');
  }
  return {
    productionOrderId: order.id,
    sourceCalculationId: order.sourceCoverageCalculationId,
    sourceDecisionId: order.sourceCoverageDecisionId,
    inputFingerprint: order.sourceCoverageInputFingerprint,
    generation: order.sourceCoverageGeneration,
  };
}

function assertV2Workflow(value: number): void {
  if (value !== 2) {
    throw coverageConflict('warehouse_coverage_workflow_mismatch');
  }
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function coverageConflict(code: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code,
    message: 'Warehouse coverage changed concurrently. Reload and retry.',
  });
}

function handoffConflict(
  code: 'warehouse_coverage_route_changed' | 'warehouse_coverage_blocked',
  message: string,
  outcome: Extract<V2ProductionHandoffTransactionOutcome, { kind: 'route_changed' | 'blocked' }>,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code,
    message,
    calculationId: outcome.calculationId,
    coverage: outcome.projection,
  });
}
