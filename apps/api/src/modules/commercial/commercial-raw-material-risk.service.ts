import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CommercialRawMaterialRisk,
  CommercialRawMaterialRiskPage,
  WarehouseCoverageProjection,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  parseRecipeSnapshotIngredients,
  recipeSnapshotMatchesVersion,
} from '../material-catalog/recipe-snapshot';
import { normalizeCatalogName } from '../material-catalog/recipe-catalog.rules';
import { allocateRecipeWeight } from '../material-catalog/recipe-weight-allocation';
import { WarehouseCoverageProjectionService } from '../warehouse-coverage/warehouse-coverage-projection.service';

const POSITION_INCLUDE = {
  recipe: {
    select: {
      parameters: true,
      recipeDefinitionId: true,
      recipeDefinitionVersionId: true,
      recipeVersionNumber: true,
      recipeName: true,
      ingredients: true,
    },
  },
  baseRawMaterialDefinition: {
    select: { id: true, name: true },
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
    select: {
      id: true,
      status: true,
      coverQty: true,
      reserveQty: true,
      productionQty: true,
      commercialApprovedAt: true,
      technicalApprovedAt: true,
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
  order: {
    select: {
      id: true,
      orderNumber: true,
      warehouseCoverageWorkflowVersion: true,
      coverageState: {
        select: {
          state: true,
          generation: true,
          currentCalculationId: true,
          currentDecisionId: true,
          currentCalculation: {
            select: {
              id: true,
              generation: true,
              inputFingerprint: true,
            },
          },
          currentDecision: {
            select: {
              id: true,
              calculationId: true,
              generation: true,
              kind: true,
              inputFingerprint: true,
            },
          },
        },
      },
      productionOrder: {
        select: {
          sourceCoverageCalculationId: true,
          sourceCoverageDecisionId: true,
          sourceCoverageInputFingerprint: true,
          sourceCoverageGeneration: true,
          dispatchItems: {
            select: {
              id: true,
              orderLineId: true,
              status: true,
              completedAt: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CommercialOrderPositionInclude;

const DEFINITION_SELECT = {
  id: true,
  name: true,
  normalizedName: true,
  sourceUnit: true,
  stock: {
    select: {
      materialId: true,
      actualQty: true,
      unit: true,
      package: true,
      factStatus: true,
      updatedAt: true,
    },
  },
  oneCNomenclatureItem: {
    select: {
      unitName: true,
      stockBalances: {
        where: { accountCode: '10.01' },
        select: {
          quantity: true,
          capturedAt: true,
          syncedAt: true,
        },
      },
    },
  },
} satisfies Prisma.RawMaterialDefinitionSelect;

type RiskPosition = Prisma.CommercialOrderPositionGetPayload<{
  include: typeof POSITION_INCLUDE;
}>;
type RiskDefinition = Prisma.RawMaterialDefinitionGetPayload<{
  select: typeof DEFINITION_SELECT;
}>;
type PlanningReason = Exclude<CommercialRawMaterialRisk['planningUnavailableReason'], null>;
type RiskCursor = { normalizedName: string; rawMaterialDefinitionId: string };
type PositionFacts = {
  remainingQty: number;
  rollsInMovement: number;
  movementAvailable: boolean;
  totalPlannedKg: number;
  planningReason: PlanningReason | null;
};
type DefinitionContribution = PositionFacts & {
  position: RiskPosition;
  plannedNeedKg: number;
};

const FINAL_COVER_STATUSES = new Set(['partial_confirmed', 'full_confirmed']);
const PRODUCTION_ONLY_STATUSES = new Set(['needs_production', 'rejected']);
const COMPLETED_DISPATCH_STATUSES = new Set(['ready_for_warehouse', 'done']);
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const PLANNING_REASON_PRIORITY = {
  planned_weight_missing: 1,
  production_route_unresolved: 2,
  production_facts_inconsistent: 3,
  recipe_snapshot_invalid: 4,
} satisfies Record<PlanningReason, number>;

function encodeCursor(cursor: RiskCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value?: string): RiskCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as RiskCursor;
    if (
      typeof cursor.normalizedName !== 'string' ||
      cursor.normalizedName.length === 0 ||
      typeof cursor.rawMaterialDefinitionId !== 'string' ||
      cursor.rawMaterialDefinitionId.length === 0
    ) {
      throw new Error('invalid cursor');
    }
    return cursor;
  } catch {
    throw new BadRequestException('Invalid raw-material risk cursor');
  }
}

function roundQuantity(value: number) {
  return Number(value.toFixed(3));
}

function highestPriorityPlanningReason(
  current: PlanningReason | null,
  candidate: PlanningReason | null,
) {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return PLANNING_REASON_PRIORITY[candidate] > PLANNING_REASON_PRIORITY[current]
    ? candidate
    : current;
}

function explicitPilotAlias(materialId: string) {
  if (materialId.startsWith('pilot-rm-')) return materialId.slice('pilot-'.length);
  if (materialId.startsWith('rm-')) return `pilot-${materialId}`;
  return null;
}

function positionMaterialLookup(definitions: RiskDefinition[], occupiedMaterialIds: Set<string>) {
  const linkedDefinitions = definitions.flatMap((definition) =>
    definition.stock
      ? [{ definitionId: definition.id, materialId: definition.stock.materialId }]
      : [],
  );
  const exactIds = new Set([
    ...occupiedMaterialIds,
    ...linkedDefinitions.map((definition) => definition.materialId),
  ]);
  const lookup = new Map(
    linkedDefinitions.map((definition) => [definition.materialId, definition.definitionId]),
  );

  for (const definition of linkedDefinitions) {
    const alias = explicitPilotAlias(definition.materialId);
    if (alias && !exactIds.has(alias) && !lookup.has(alias)) {
      lookup.set(alias, definition.definitionId);
    }
  }

  return lookup;
}

function recipeWeight(position: RiskPosition) {
  if (position.plannedWeightKg != null && position.plannedWeightKg > 0) {
    return position.plannedWeightKg;
  }
  if (!position.recipe || !Array.isArray(position.recipe.parameters)) return null;
  for (const item of position.recipe.parameters) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.label !== 'План. вес, кг') continue;
    const value = Number(
      String(item.value ?? '')
        .trim()
        .replace(',', '.'),
    );
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function productionQuantity(
  position: RiskPosition,
  coverage: WarehouseCoverageProjection | null,
): number | PlanningReason {
  if (position.order.warehouseCoverageWorkflowVersion === 2) {
    return v2ProductionQuantity(position, coverage);
  }
  if (PRODUCTION_ONLY_STATUSES.has(position.warehouseCoverStatus)) return position.rollCount;
  if (!FINAL_COVER_STATUSES.has(position.warehouseCoverStatus)) {
    return 'production_route_unresolved';
  }
  const finalized = position.coverProposals.filter(
    (proposal) =>
      proposal.status === position.warehouseCoverStatus &&
      Boolean(proposal.commercialApprovedAt) &&
      Boolean(proposal.technicalApprovedAt),
  );
  if (finalized.length !== 1) return 'production_facts_inconsistent';
  const proposal = finalized[0]!;
  const reserved = new Set(
    proposal.reservedRolls
      .filter(
        (roll) =>
          roll.reservedForOrderId === position.order.id &&
          roll.reservedForPositionId === position.id &&
          roll.reservedByProposalId === proposal.id,
      )
      .map((roll) => roll.id),
  );
  const quantity = Math.max(0, position.rollCount - reserved.size);
  if (
    reserved.size > position.rollCount ||
    proposal.coverQty !== reserved.size ||
    proposal.reserveQty !== reserved.size ||
    proposal.productionQty !== quantity
  ) {
    return 'production_facts_inconsistent';
  }
  return quantity;
}

function v2ProductionQuantity(
  position: RiskPosition,
  coverage: WarehouseCoverageProjection | null,
): number | PlanningReason {
  const state = position.order.coverageState;
  const calculation = state?.currentCalculation;
  const decision = state?.currentDecision;
  if (
    !coverage ||
    coverage.workflowVersion !== 2 ||
    !state ||
    !calculation ||
    !decision ||
    !Number.isSafeInteger(state.generation) ||
    state.generation <= 0 ||
    coverage.state !== state.state ||
    coverage.generation !== state.generation ||
    state.currentCalculationId !== calculation.id ||
    state.currentDecisionId !== decision.id ||
    state.currentCalculationId !== decision.calculationId ||
    state.generation !== calculation.generation ||
    state.generation !== decision.generation ||
    calculation.inputFingerprint !== decision.inputFingerprint
  ) {
    return 'production_route_unresolved';
  }

  const productionOrder = position.order.productionOrder;
  if (productionOrder) {
    const validProvenance =
      productionOrder.sourceCoverageCalculationId === calculation.id &&
      productionOrder.sourceCoverageDecisionId === decision.id &&
      typeof productionOrder.sourceCoverageInputFingerprint === 'string' &&
      /^[0-9a-f]{64}$/u.test(productionOrder.sourceCoverageInputFingerprint) &&
      productionOrder.sourceCoverageInputFingerprint === calculation.inputFingerprint &&
      productionOrder.sourceCoverageGeneration === state.generation;
    return validProvenance ? position.rollCount : 'production_facts_inconsistent';
  }

  if (
    state.state === 'production_required' &&
    (decision.kind === 'produce_all' || decision.kind === 'auto_produce_all')
  ) {
    return position.rollCount;
  }
  if (state.state === 'warehouse_reserved' && decision.kind === 'use_warehouse') {
    return 0;
  }
  return 'production_route_unresolved';
}

function positionFacts(
  position: RiskPosition,
  coverage: WarehouseCoverageProjection | null,
): PositionFacts {
  const productionQty = productionQuantity(position, coverage);
  if (typeof productionQty !== 'number') {
    return {
      remainingQty: position.rollCount,
      rollsInMovement: 0,
      movementAvailable: false,
      totalPlannedKg: 0,
      planningReason: productionQty,
    };
  }

  const dispatchItems = position.order.productionOrder?.dispatchItems.filter(
    (item) => item.orderLineId === position.id,
  );
  let remainingQty = productionQty;
  let rollsInMovement = 0;
  if (dispatchItems) {
    if (dispatchItems.length !== productionQty) {
      return {
        remainingQty: productionQty,
        rollsInMovement: 0,
        movementAvailable: false,
        totalPlannedKg: 0,
        planningReason: 'production_facts_inconsistent',
      };
    }
    remainingQty = dispatchItems.filter(
      (item) => !item.completedAt && !COMPLETED_DISPATCH_STATUSES.has(item.status),
    ).length;
    rollsInMovement = dispatchItems.filter(
      (item) => !item.completedAt && item.status !== 'done',
    ).length;
  }
  if (remainingQty === 0) {
    return {
      remainingQty,
      rollsInMovement,
      movementAvailable: true,
      totalPlannedKg: 0,
      planningReason: null,
    };
  }

  const weight = recipeWeight(position);
  return {
    remainingQty,
    rollsInMovement,
    movementAvailable: true,
    totalPlannedKg: weight == null ? 0 : remainingQty * weight,
    planningReason: weight == null ? 'planned_weight_missing' : null,
  };
}

@Injectable()
export class CommercialRawMaterialRiskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverageProjection: WarehouseCoverageProjectionService,
  ) {}

  async list(
    actor: Actor,
    query: { cursor?: string; limit: number; q?: string },
  ): Promise<CommercialRawMaterialRiskPage> {
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const cursor = decodeCursor(query.cursor);
    const normalizedQuery = normalizeCatalogName(query.q ?? '').replace(/\s+/g, ' ');
    const activeOrder = {
      commercialStage: { in: ['incoming', 'sent_to_finance', 'in_work'] },
      shipmentStatus: { not: 'shipped' },
    } satisfies Prisma.CommercialOrderWhereInput;
    const operationalScope = {
      OR: [
        { stock: { isNot: null } },
        { basePositions: { some: { order: activeOrder } } },
        {
          ingredients: {
            some: {
              recipeDefinitionVersion: {
                positions: { some: { order: activeOrder } },
              },
            },
          },
        },
      ],
    } satisfies Prisma.RawMaterialDefinitionWhereInput;
    const definitions = await this.prisma.rawMaterialDefinition.findMany({
      where: {
        status: 'active',
        AND: [
          operationalScope,
          ...(normalizedQuery ? [{ normalizedName: { contains: normalizedQuery } }] : []),
          ...(cursor
            ? [
                {
                  OR: [
                    { normalizedName: { gt: cursor.normalizedName } },
                    {
                      normalizedName: cursor.normalizedName,
                      id: { gt: cursor.rawMaterialDefinitionId },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      select: DEFINITION_SELECT,
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const pageDefinitions = definitions.slice(0, limit);
    const occupiedMaterialIds = new Set(
      definitions.flatMap((definition) => (definition.stock ? [definition.stock.materialId] : [])),
    );
    const unresolvedAliases = pageDefinitions.flatMap((definition) => {
      const alias = definition.stock ? explicitPilotAlias(definition.stock.materialId) : null;
      return alias && !occupiedMaterialIds.has(alias) ? [alias] : [];
    });
    if (unresolvedAliases.length > 0) {
      const occupiedAliases = await this.prisma.rawMaterialStock.findMany({
        where: { materialId: { in: unresolvedAliases } },
        select: { materialId: true },
      });
      for (const material of occupiedAliases) occupiedMaterialIds.add(material.materialId);
    }

    const materialLookup = positionMaterialLookup(pageDefinitions, occupiedMaterialIds);
    const pageDefinitionIds = new Set(pageDefinitions.map((definition) => definition.id));
    const positionFilters: Prisma.CommercialOrderPositionWhereInput[] = [
      { baseRawMaterialDefinitionId: { in: [...pageDefinitionIds] } },
      { recipeDefinitionVersionId: { not: null } },
      { recipe: { is: { recipeDefinitionId: { not: null } } } },
      { recipe: { is: { recipeDefinitionVersionId: { not: null } } } },
      { recipe: { is: { recipeVersionNumber: { not: null } } } },
      { recipe: { is: { recipeName: { not: null } } } },
      { recipe: { is: { ingredients: { not: Prisma.DbNull } } } },
    ];
    if (materialLookup.size > 0) {
      positionFilters.push({ rawMaterialId: { in: [...materialLookup.keys()] } });
    }
    const positions = pageDefinitions.length
      ? await this.prisma.commercialOrderPosition.findMany({
          where: {
            OR: positionFilters,
            order: {
              commercialStage: { in: ['incoming', 'sent_to_finance', 'in_work'] },
              shipmentStatus: { not: 'shipped' },
            },
          },
          include: POSITION_INCLUDE,
          orderBy: [{ orderId: 'asc' }, { id: 'asc' }],
        })
      : [];
    const v2OrderIds = [
      ...new Set(
        positions.flatMap((position) =>
          position.order.warehouseCoverageWorkflowVersion === 2 ? [position.order.id] : [],
        ),
      ),
    ];
    const coverageByOrderId = new Map(
      await Promise.all(
        v2OrderIds.map(
          async (orderId) => [orderId, await this.coverageProjection.read(orderId, actor)] as const,
        ),
      ),
    );
    const contributions = this.contributionsByDefinition(
      positions,
      pageDefinitionIds,
      materialLookup,
      coverageByOrderId,
    );
    const items = pageDefinitions.map((definition) =>
      this.project(definition, contributions.get(definition.id) ?? []),
    );
    const lastDefinition = pageDefinitions.at(-1);
    return {
      items,
      nextCursor:
        definitions.length > limit && lastDefinition
          ? encodeCursor({
              normalizedName: lastDefinition.normalizedName,
              rawMaterialDefinitionId: lastDefinition.id,
            })
          : null,
    };
  }

  private contributionsByDefinition(
    positions: RiskPosition[],
    pageDefinitionIds: Set<string>,
    materialLookup: Map<string, string>,
    coverageByOrderId: ReadonlyMap<string, WarehouseCoverageProjection>,
  ) {
    const contributions = new Map<string, DefinitionContribution[]>();
    const add = (
      definitionId: string,
      position: RiskPosition,
      facts: PositionFacts,
      plannedNeedKg: number,
      planningReason = facts.planningReason,
    ) => {
      if (!pageDefinitionIds.has(definitionId) || facts.remainingQty === 0) return;
      const contribution = { ...facts, position, plannedNeedKg, planningReason };
      const existing = contributions.get(definitionId);
      if (existing) existing.push(contribution);
      else contributions.set(definitionId, [contribution]);
    };
    const addInvalidSnapshot = (
      position: RiskPosition,
      facts: PositionFacts,
      authoritativeDefinitionIds: Iterable<string>,
      identifiableDefinitionIds: Iterable<string>,
    ) => {
      const authoritativeIds = new Set(authoritativeDefinitionIds);
      const identifiableIds = new Set(identifiableDefinitionIds);
      const candidateIds = authoritativeIds.size > 0 ? authoritativeIds : identifiableIds;
      const affectedDefinitionIds =
        candidateIds.size > 0
          ? [...candidateIds].filter((id) => pageDefinitionIds.has(id))
          : pageDefinitionIds;
      for (const definitionId of affectedDefinitionIds) {
        add(definitionId, position, facts, 0, 'recipe_snapshot_invalid');
      }
    };

    for (const position of positions) {
      const facts = positionFacts(position, coverageByOrderId.get(position.order.id) ?? null);
      if (facts.remainingQty === 0) continue;
      const structuredSelectionPresent =
        position.baseRawMaterialDefinitionId != null ||
        position.recipeDefinitionVersionId != null ||
        position.recipe?.recipeDefinitionId != null ||
        position.recipe?.recipeDefinitionVersionId != null ||
        position.recipe?.recipeVersionNumber != null ||
        position.recipe?.recipeName != null;
      const snapshot = parseRecipeSnapshotIngredients(
        position.recipe?.ingredients,
        structuredSelectionPresent,
      );
      if (snapshot.kind === 'invalid') {
        const authoritativeDefinitionIds = [
          ...(position.baseRawMaterialDefinitionId ? [position.baseRawMaterialDefinitionId] : []),
          ...(position.recipeDefinitionVersion?.ingredients.map(
            (ingredient) => ingredient.rawMaterialDefinition.id,
          ) ?? []),
        ];
        addInvalidSnapshot(
          position,
          facts,
          authoritativeDefinitionIds,
          snapshot.identifiableDefinitionIds,
        );
        continue;
      }
      if (snapshot.kind === 'legacy') {
        if (!position.rawMaterialId) continue;
        const definitionId = materialLookup.get(position.rawMaterialId);
        if (definitionId) add(definitionId, position, facts, facts.totalPlannedKg);
        continue;
      }

      const baseDefinitionId = position.baseRawMaterialDefinitionId;
      const positionVersionId = position.recipeDefinitionVersionId;
      const snapshotDefinitionId = position.recipe?.recipeDefinitionId;
      const snapshotVersionId = position.recipe?.recipeDefinitionVersionId;
      const snapshotVersion = position.recipe?.recipeVersionNumber;
      const snapshotName = position.recipe?.recipeName;
      const baseDefinition = position.baseRawMaterialDefinition;
      const selectedVersion = position.recipeDefinitionVersion;
      const snapshotNameValid =
        typeof snapshotName === 'string' &&
        snapshotName.length > 0 &&
        snapshotName.length <= 120 &&
        snapshotName.trim() === snapshotName;
      const baseSelectionValid =
        typeof baseDefinitionId === 'string' &&
        baseDefinitionId.length > 0 &&
        baseDefinitionId.trim() === baseDefinitionId &&
        positionVersionId == null &&
        snapshotDefinitionId == null &&
        snapshotVersionId == null &&
        snapshotVersion == null &&
        baseDefinition?.id === baseDefinitionId &&
        snapshotName === baseDefinition.name &&
        snapshot.ingredients.length === 1 &&
        snapshot.ingredients[0]?.rawMaterialDefinitionId === baseDefinition.id &&
        snapshot.ingredients[0]?.name === baseDefinition.name &&
        snapshot.ingredients[0]?.shareBasisPoints === 10_000;
      const namedSelectionValid =
        baseDefinitionId == null &&
        typeof positionVersionId === 'string' &&
        positionVersionId.length > 0 &&
        positionVersionId.trim() === positionVersionId &&
        typeof snapshotDefinitionId === 'string' &&
        snapshotDefinitionId.length > 0 &&
        snapshotDefinitionId.trim() === snapshotDefinitionId &&
        snapshotVersionId === positionVersionId &&
        selectedVersion?.id === positionVersionId &&
        snapshotDefinitionId === selectedVersion.recipeDefinition.id &&
        Number.isInteger(snapshotVersion) &&
        (snapshotVersion ?? 0) > 0 &&
        snapshotVersion === selectedVersion.version &&
        snapshotName === selectedVersion.recipeDefinition.name &&
        snapshotNameValid &&
        recipeSnapshotMatchesVersion(snapshot.ingredients, selectedVersion.ingredients);
      if (!baseSelectionValid && !namedSelectionValid) {
        const authoritativeDefinitionIds = [
          ...(baseDefinitionId ? [baseDefinitionId] : []),
          ...(selectedVersion?.ingredients.map(
            (ingredient) => ingredient.rawMaterialDefinition.id,
          ) ?? []),
        ];
        addInvalidSnapshot(
          position,
          facts,
          authoritativeDefinitionIds,
          snapshot.ingredients.map((ingredient) => ingredient.rawMaterialDefinitionId),
        );
        continue;
      }

      const allocations =
        facts.planningReason === null
          ? allocateRecipeWeight(facts.totalPlannedKg, snapshot.ingredients)
          : snapshot.ingredients.map((ingredient) => ({
              rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
              plannedNeedKg: 0,
            }));
      for (const allocation of allocations) {
        add(allocation.rawMaterialDefinitionId, position, facts, allocation.plannedNeedKg);
      }
    }

    return contributions;
  }

  private project(
    definition: RiskDefinition,
    contributions: DefinitionContribution[],
  ): CommercialRawMaterialRisk {
    let plannedNeed = 0;
    let planningReason: PlanningReason | null = null;
    let rollsInMovement = 0;
    let movementAvailable = true;
    const affectedOrders = new Map<
      string,
      { id: string; orderNumber: string; rollCount: number }
    >();
    for (const contribution of contributions) {
      planningReason = highestPriorityPlanningReason(planningReason, contribution.planningReason);
      plannedNeed += contribution.plannedNeedKg;
      rollsInMovement += contribution.rollsInMovement;
      movementAvailable &&= contribution.movementAvailable;
      const existing = affectedOrders.get(contribution.position.order.id);
      affectedOrders.set(contribution.position.order.id, {
        id: contribution.position.order.id,
        orderNumber: contribution.position.order.orderNumber,
        rollCount: (existing?.rollCount ?? 0) + contribution.remainingQty,
      });
    }

    const stock = definition.stock;
    const oneCBalances = definition.oneCNomenclatureItem?.stockBalances ?? [];
    const oneCQty =
      oneCBalances.length > 0
        ? roundQuantity(
            oneCBalances.reduce((total, balance) => total + Number(balance.quantity), 0),
          )
        : null;
    const latestOneCCapturedAt =
      oneCBalances.length > 0
        ? new Date(Math.max(...oneCBalances.map((balance) => balance.capturedAt.getTime())))
        : null;
    const latestOneCImportedAt =
      oneCBalances.length > 0
        ? new Date(Math.max(...oneCBalances.map((balance) => balance.syncedAt.getTime())))
        : null;
    const staleAfterMs = Number(process.env.RAW_MATERIAL_STALE_AFTER_MS ?? DEFAULT_STALE_AFTER_MS);
    const resolvedStaleAfterMs =
      Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : DEFAULT_STALE_AFTER_MS;
    const importedSource = stock?.factStatus === 'source';
    const stale = Boolean(
      stock && importedSource && Date.now() - stock.updatedAt.getTime() > resolvedStaleAfterMs,
    );
    const oneCStale = Boolean(
      latestOneCImportedAt && Date.now() - latestOneCImportedAt.getTime() > resolvedStaleAfterMs,
    );
    const planningAvailable = planningReason === null;
    const plannedNeedQty = planningAvailable ? roundQuantity(plannedNeed) : null;
    const deficitQty =
      planningAvailable && stock && !stale
        ? roundQuantity(Math.max(0, plannedNeed - stock.actualQty))
        : null;
    const risk =
      !planningAvailable || !stock
        ? 'unknown'
        : stale
          ? 'attention'
          : deficitQty && deficitQty > 0
            ? 'deficit'
            : plannedNeed > stock.actualQty * 0.8
              ? 'attention'
              : 'ok';

    return {
      rawMaterialDefinitionId: definition.id,
      materialId: stock?.materialId ?? null,
      label: definition.name,
      stockAvailability: stock ? 'available' : 'unavailable',
      reason: stock ? null : 'stock_fact_missing',
      actualQty: stock?.actualQty ?? null,
      unit: stock?.unit ?? null,
      package: stock?.package ?? null,
      oneCQty,
      oneCUnit:
        oneCBalances.length > 0
          ? (definition.oneCNomenclatureItem?.unitName ?? definition.sourceUnit)
          : null,
      oneCSource:
        latestOneCCapturedAt && latestOneCImportedAt
          ? {
              capturedAt: latestOneCCapturedAt.toISOString(),
              importedAt: latestOneCImportedAt.toISOString(),
              stale: oneCStale,
            }
          : null,
      reservedQty: null,
      plannedNeedQty,
      deficitQty,
      affectedOrders: [...affectedOrders.values()],
      rollsInMovement: movementAvailable ? rollsInMovement : null,
      risk,
      source: stock
        ? {
            kind:
              stock.factStatus === 'manual'
                ? 'manual_platform'
                : importedSource
                  ? '1C'
                  : 'warehouse_fact',
            capturedAt: stock.updatedAt.toISOString(),
            stale,
          }
        : null,
      planningAvailability: planningAvailable ? 'available' : 'unavailable',
      planningUnavailableReason: planningReason,
      reservationAvailability: 'unavailable',
      reservationUnavailableReason: 'reservation_fact_unavailable',
      monetaryMetrics: { available: false },
    };
  }
}
