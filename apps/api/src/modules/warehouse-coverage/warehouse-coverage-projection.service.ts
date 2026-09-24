import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  CommercialWarehouseCoverageProjection,
  WarehouseCoverageProjection,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  canonicalDimension,
  canonicalizeRollCoverageSpec,
  normalizeCoverageText,
  normalizeSpool,
  parseKgToMilliKg,
  parseThicknessMilliMicron,
} from './warehouse-coverage-canonical';
import {
  permittedWarehouseCoverageActions,
  projectWarehouseCoverage,
  type CoverageProjectionContext,
} from './warehouse-coverage-projection';
import {
  projectTypeCoverage,
  type PublishedCoverageMatch,
  type SelectedCoveragePosition,
} from './warehouse-coverage-type-projection';

const COVERAGE_PROJECTION_ORDER_SELECT = {
  id: true,
  warehouseCoverageWorkflowVersion: true,
  cancellationStatus: true,
  coverageState: {
    include: {
      currentCalculation: true,
      currentDecision: {
        select: {
          kind: true,
          acceptanceTask: {
            select: { status: true },
          },
        },
      },
    },
  },
  productionOrder: {
    select: { id: true },
  },
} as const satisfies Prisma.CommercialOrderSelect;

type CoverageProjectionOrder = Prisma.CommercialOrderGetPayload<{
  select: typeof COVERAGE_PROJECTION_ORDER_SELECT;
}>;

const COMMERCIAL_COVERAGE_PROJECTION_ORDER_SELECT = {
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
                  id: true,
                  rollCount: true,
                  filmType: true,
                  actualThickness: true,
                  accountingThickness: true,
                  widthMm: true,
                  plannedLengthM: true,
                  plannedWeightKg: true,
                  spoolType: true,
                  birka: true,
                  manualBirka: true,
                  baseRawMaterialDefinition: {
                    select: { id: true, name: true },
                  },
                  recipe: {
                    select: { recipeName: true },
                  },
                  recipeDefinitionVersion: {
                    select: {
                      recipeDefinition: { select: { name: true } },
                      ingredients: {
                        select: {
                          rawMaterialDefinitionId: true,
                          shareBasisPoints: true,
                          rawMaterialDefinition: { select: { name: true } },
                        },
                        orderBy: { sequence: 'asc' as const },
                      },
                    },
                  },
                },
              },
              coverageFact: {
                select: {
                  spec: true,
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
            },
          },
        },
      },
      currentDecision: {
        select: {
          kind: true,
          acceptanceTask: {
            select: { status: true },
          },
        },
      },
    },
  },
  productionOrder: {
    select: { id: true },
  },
} as const satisfies Prisma.CommercialOrderSelect;

type CommercialCoverageProjectionOrder = Prisma.CommercialOrderGetPayload<{
  select: typeof COMMERCIAL_COVERAGE_PROJECTION_ORDER_SELECT;
}>;

type CommercialCoverageMatch = NonNullable<
  NonNullable<CommercialCoverageProjectionOrder['coverageState']>['currentCalculation']
>['matches'][number];

const MAX_SNAPSHOT_READ_ATTEMPTS = 3;

@Injectable()
export class WarehouseCoverageProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async read(commercialOrderId: string, actor: Actor): Promise<WarehouseCoverageProjection> {
    const { order, inventoryEpoch } = await this.readEpochFencedSnapshot(() =>
      this.prisma.commercialOrder.findUnique({
        where: { id: commercialOrderId },
        select: COVERAGE_PROJECTION_ORDER_SELECT,
      }),
    );

    if (!order) {
      throw new NotFoundException(`Commercial order ${commercialOrderId} not found`);
    }

    return baseCoverageProjection(order, actor, inventoryEpoch);
  }

  async readMany(
    commercialOrderIds: readonly string[],
    actor: Actor,
  ): Promise<ReadonlyMap<string, WarehouseCoverageProjection>> {
    const uniqueIds = [...new Set(commercialOrderIds)];
    if (uniqueIds.length === 0) return new Map();
    const { order: orders, inventoryEpoch } = await this.readEpochFencedSnapshot(() =>
      this.prisma.commercialOrder.findMany({
        where: { id: { in: uniqueIds } },
        select: COVERAGE_PROJECTION_ORDER_SELECT,
      }),
    );
    if (orders.length !== uniqueIds.length) {
      const foundIds = new Set(orders.map(({ id }) => id));
      const missingId = uniqueIds.find((id) => !foundIds.has(id));
      throw new NotFoundException(`Commercial order ${missingId ?? 'unknown'} not found`);
    }
    return new Map(
      orders.map((order) => [order.id, baseCoverageProjection(order, actor, inventoryEpoch)]),
    );
  }

  async readForCommercial(
    commercialOrderId: string,
    actor: Actor,
  ): Promise<CommercialWarehouseCoverageProjection> {
    const { order, inventoryEpoch } = await this.readEpochFencedSnapshot(() =>
      this.prisma.commercialOrder.findUnique({
        where: { id: commercialOrderId },
        select: COMMERCIAL_COVERAGE_PROJECTION_ORDER_SELECT,
      }),
    );

    if (!order) {
      throw new NotFoundException(`Commercial order ${commercialOrderId} not found`);
    }

    const base = baseCoverageProjection(order, actor, inventoryEpoch);
    const matches = order.coverageState?.currentCalculation?.matches ?? [];
    const typeCoverage =
      base.stale ||
      base.state === 'calculating' ||
      base.state === 'stale' ||
      base.availability !== 'verified_full'
        ? []
        : projectTypeCoverage({
            base,
            positions: selectedPositions(matches),
            matches: matches.map(publishedMatch),
          });
    return { ...base, typeCoverage };
  }

  private async readEpochFencedSnapshot<Order>(
    readOrder: () => Promise<Order>,
  ): Promise<{ order: Order; inventoryEpoch: bigint }> {
    for (let attempt = 1; attempt <= MAX_SNAPSHOT_READ_ATTEMPTS; attempt += 1) {
      const epochBefore = await this.readInventoryEpoch();
      const order = await readOrder();
      const epochAfter = await this.readInventoryEpoch();
      if (epochBefore === epochAfter) {
        return { order, inventoryEpoch: epochAfter };
      }
    }
    return invariant('inventory epoch changed repeatedly during projection read');
  }

  private async readInventoryEpoch(): Promise<bigint> {
    const inventoryEpoch = await this.prisma.warehouseCoverageInventoryEpoch.findUnique({
      where: { id: 1 },
      select: { epoch: true },
    });
    if (!inventoryEpoch) {
      return invariant('current inventory epoch is unavailable');
    }
    return inventoryEpoch.epoch;
  }
}

function baseCoverageProjection(
  order: CoverageProjectionOrder,
  actor: Actor,
  inventoryEpoch: bigint,
): WarehouseCoverageProjection {
  const workflowVersion = warehouseCoverageWorkflowVersion(order.warehouseCoverageWorkflowVersion);
  const coverageState = order.coverageState;
  const calculation = coverageState?.currentCalculation ?? null;
  const reserveTaskStatus = acceptanceTaskStatus(
    coverageState?.currentDecision?.acceptanceTask?.status ?? null,
  );
  const persistedState = coverageState ? withoutProjectionRelations(coverageState) : null;

  return projectWarehouseCoverage({
    workflowVersion,
    state: persistedState,
    calculation,
    currentInventoryEpoch: inventoryEpoch,
    orderCancellationStatus: cancellationStatus(order.cancellationStatus),
    productionOrderExists: order.productionOrder !== null,
    currentDecisionKind: coverageDecisionKind(coverageState?.currentDecision?.kind ?? null),
    reserveTaskStatus,
    permittedActions: permittedWarehouseCoverageActions(actor.capabilities),
  });
}

function cancellationStatus(value: string): CoverageProjectionContext['orderCancellationStatus'] {
  if (value === 'active' || value === 'cancelled') return value;
  return invariant('unknown commercial order cancellation status');
}

function selectedPositions(
  matches: readonly CommercialCoverageMatch[],
): SelectedCoveragePosition[] {
  const positions = new Map<string, SelectedCoveragePosition>();
  for (const match of matches) {
    if (!positions.has(match.positionId)) {
      positions.set(match.positionId, selectedPosition(match));
    }
  }
  return [...positions.values()];
}

function selectedPosition(match: CommercialCoverageMatch): SelectedCoveragePosition {
  const position = match.position;
  const ingredients = selectedIngredients(match);
  return {
    positionId: position.id,
    label: displayText(position.filmType),
    requiredRollCount: position.rollCount,
    filmType: normalizeCoverageText(position.filmType),
    actualThicknessMilliMicron: parseThicknessMilliMicron(position.actualThickness),
    accountingThicknessMilliMicron: parseThicknessMilliMicron(position.accountingThickness),
    widthMilliMm: requiredDimension(position.widthMm, 'widthMm'),
    plannedLengthMilliM: requiredDimension(position.plannedLengthM, 'plannedLengthM'),
    plannedWeightMilliKg: parsePersistedKg(position.plannedWeightKg),
    spoolType: normalizeSpool(position.spoolType),
    birka: normalizeCoverageText(position.birka) ?? normalizeCoverageText(position.manualBirka),
    recipeName:
      displayNullableText(position.recipeDefinitionVersion?.recipeDefinition.name) ??
      displayNullableText(position.recipe?.recipeName) ??
      displayNullableText(position.baseRawMaterialDefinition?.name),
    ingredients: ingredients.map(({ name, shareBasisPoints }) => ({
      name,
      shareBasisPoints,
    })),
  };
}

function publishedMatch(match: CommercialCoverageMatch): PublishedCoverageMatch {
  const spec = canonicalizeRollCoverageSpec(match.coverageFact.spec);
  const ingredientNames = new Map(
    selectedIngredients(match).map(({ rawMaterialDefinitionId, name }) => [
      rawMaterialDefinitionId,
      name,
    ]),
  );
  return {
    positionId: match.positionId,
    filmType: spec.filmType,
    actualThicknessMilliMicron: spec.actualThicknessMilliMicron,
    accountingThicknessMilliMicron: spec.accountingThicknessMilliMicron,
    widthMilliMm: spec.widthMilliMm,
    plannedLengthMilliM: spec.plannedLengthMilliM,
    actualWeightMilliKg: spec.actualWeightMilliKg,
    spoolType: spec.spoolType,
    birka: spec.birka,
    recipeName:
      displayNullableText(
        match.coverageFact.sourcePosition?.recipeDefinitionVersion?.recipeDefinition.name,
      ) ??
      displayNullableText(match.coverageFact.sourcePosition?.recipe?.recipeName) ??
      displayNullableText(match.coverageFact.sourcePosition?.baseRawMaterialDefinition?.name),
    ingredients: spec.ingredients.map(({ rawMaterialDefinitionId, shareBasisPoints }) => {
      const name = ingredientNames.get(rawMaterialDefinitionId);
      if (!name) return invariant('published match ingredient name is unavailable');
      return { name, shareBasisPoints };
    }),
  };
}

function selectedIngredients(match: CommercialCoverageMatch): Array<{
  rawMaterialDefinitionId: string;
  name: string;
  shareBasisPoints: number;
}> {
  const recipeIngredients = match.position.recipeDefinitionVersion?.ingredients;
  if (recipeIngredients && recipeIngredients.length > 0) {
    return recipeIngredients.map((ingredient) => ({
      rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
      name: displayText(ingredient.rawMaterialDefinition.name),
      shareBasisPoints: ingredient.shareBasisPoints,
    }));
  }
  const base = match.position.baseRawMaterialDefinition;
  if (!base) return invariant('selected position ingredient names are unavailable');
  return [
    {
      rawMaterialDefinitionId: base.id,
      name: displayText(base.name),
      shareBasisPoints: 10_000,
    },
  ];
}

function requiredDimension(value: unknown, field: string): number {
  const dimension = canonicalDimension(value);
  if (dimension === null) return invariant(`${field} is unavailable`);
  return dimension;
}

function parsePersistedKg(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return invariant('plannedWeightKg is unavailable');
  }
  return parseKgToMilliKg(String(value));
}

function displayText(value: unknown): string {
  const projected = displayNullableText(value);
  if (projected === null) return invariant('display text is unavailable');
  return projected;
}

function displayNullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized || null;
}

function withoutProjectionRelations(
  state: NonNullable<
    Prisma.CommercialOrderGetPayload<{
      select: typeof COVERAGE_PROJECTION_ORDER_SELECT;
    }>['coverageState']
  >,
) {
  const { currentCalculation: _calculation, currentDecision: _decision, ...persisted } = state;
  return persisted;
}

function warehouseCoverageWorkflowVersion(value: number): 1 | 2 {
  if (value !== 1 && value !== 2) {
    invariant('unknown workflow version');
  }
  return value;
}

function acceptanceTaskStatus(value: string | null): 'open' | 'partial' | 'closed' | null {
  if (value === 'open' || value === 'partial' || value === 'closed') {
    return value;
  }
  return null;
}

function coverageDecisionKind(
  value: string | null,
): 'use_warehouse' | 'produce_all' | 'auto_produce_all' | null {
  if (value === 'use_warehouse' || value === 'produce_all' || value === 'auto_produce_all') {
    return value;
  }
  return null;
}

function invariant(detail: string): never {
  throw new Error(`Warehouse coverage projection invariant: ${detail}`);
}
