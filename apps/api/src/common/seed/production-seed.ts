import { Role, type Prisma } from '@prisma/client';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
  type CanonicalRollCoverageSpec,
} from '../../modules/warehouse-coverage/warehouse-coverage-canonical';
import { normalizeCatalogName } from '../../modules/material-catalog/recipe-catalog.rules';

const COVERAGE_FIXTURE_SYSTEM_ACTOR = 'warehouse_coverage_engine';
const COVERAGE_FACT_SPEC_VERSION = 'warehouse-roll-coverage/v1';
const FIXTURE_CREATED_AT = new Date('2026-07-24T12:00:00.000Z');
const FIXTURE_WIDTH_MM = 1_000;
const FIXTURE_PLANNED_LENGTH_M = 100;

export interface WarehouseCoverageV2FixtureSeedOptions {
  appEnv: 'development' | 'test';
  includeWarehouseCoverageV2Fixtures: true;
}

type SeedPosition = {
  id: string;
  rawMaterialId: string | null;
  recipe: {
    version: string;
    parameters: Prisma.JsonValue;
  } | null;
};

type SeedRoll = {
  rollCode: string;
  assignedOperatorId: string | null;
  status: string;
};

export function buildRollDispatchItemSeedUpsert(input: {
  productionOrderId: string;
  position: SeedPosition | undefined;
  sequence: number;
  roll: SeedRoll;
}): Prisma.RollDispatchItemUpsertArgs {
  const { position, productionOrderId, roll, sequence } = input;
  const rawMaterialId = position?.rawMaterialId ?? null;
  const recipeVersion = position?.recipe?.version ?? null;
  const characteristicsSnapshot: Prisma.InputJsonObject = {
    rawMaterialId,
    recipeVersion,
    recipeParameters: (position?.recipe?.parameters ?? []) as Prisma.InputJsonValue,
  };

  return {
    where: { rollCode: roll.rollCode },
    update: {},
    create: {
      rollCode: roll.rollCode,
      productionOrderId,
      orderLineId: position?.id,
      positionSequence: sequence,
      rawMaterialId,
      recipeVersion,
      characteristicsSnapshot,
      filmType: 'Рукав',
      plannedWeightKg: 41.2,
      assignedOperatorId: roll.assignedOperatorId,
      status: roll.status,
      priority: sequence === 1 ? 10 : 0,
    },
  };
}

export async function seedWarehouseCoverageV2Fixtures(
  tx: Prisma.TransactionClient,
  options: WarehouseCoverageV2FixtureSeedOptions,
): Promise<void> {
  if (options?.appEnv !== 'development' && options?.appEnv !== 'test') {
    throw new Error('Warehouse coverage V2 fixtures are development/test only');
  }
  if (options.includeWarehouseCoverageV2Fixtures !== true) {
    throw new Error('Warehouse coverage V2 fixture explicit opt-in is required');
  }

  const fixtures = [
    {
      orderId: 'v2-cover-order-verified-full',
      orderNumber: 'V2-COVER-VERIFIED-FULL',
      expectedAvailability: 'verified_full',
      counterpartyId: 'v2-cover-counterparty-verified-full',
      positionId: 'v2-cover-position-verified-full',
      financeOrderId: 'v2-cover-finance-verified-full',
      materialDefinitionId: 'v2-cover-material-verified-full',
      materialId: 'v2-cover-stock-key-verified-full',
      birka: 'V2 verified full',
      rollCount: 2,
    },
    {
      orderId: 'v2-cover-order-unavailable',
      orderNumber: 'V2-COVER-UNAVAILABLE',
      expectedAvailability: 'unavailable',
      counterpartyId: 'v2-cover-counterparty-unavailable',
      positionId: 'v2-cover-position-unavailable',
      financeOrderId: 'v2-cover-finance-unavailable',
      materialDefinitionId: 'v2-cover-material-unavailable',
      materialId: 'v2-cover-stock-key-unavailable',
      birka: 'V2 unavailable',
      rollCount: 1,
    },
    {
      orderId: 'v2-cover-order-unknown',
      orderNumber: 'V2-COVER-UNKNOWN',
      expectedAvailability: 'unknown',
      counterpartyId: 'v2-cover-counterparty-unknown',
      positionId: 'v2-cover-position-unknown',
      financeOrderId: 'v2-cover-finance-unknown',
      materialDefinitionId: 'v2-cover-material-unknown',
      materialId: 'v2-cover-stock-key-unknown',
      birka: 'V2 unknown',
      rollCount: 1,
    },
  ] as const;

  const operator = await tx.user.upsert({
    where: { login: 'v2-cover-fixture-operator' },
    update: {},
    create: {
      id: 'v2-cover-fixture-operator',
      externalId: 'v2-cover-fixture-operator',
      login: 'v2-cover-fixture-operator',
      displayName: 'V2 Coverage Fixture Operator',
      role: Role.operator,
      isActive: true,
      mustChangePassword: false,
      createdAt: FIXTURE_CREATED_AT,
      updatedAt: FIXTURE_CREATED_AT,
    },
  });

  for (const fixture of fixtures) {
    const materialName = `Coverage fixture material ${fixture.expectedAvailability}`;
    await tx.counterparty.upsert({
      where: { id: fixture.counterpartyId },
      update: {},
      create: {
        id: fixture.counterpartyId,
        displayName: `Warehouse coverage fixture · ${fixture.expectedAvailability}`,
      },
    });
    await tx.rawMaterialDefinition.upsert({
      where: { id: fixture.materialDefinitionId },
      update: {},
      create: {
        id: fixture.materialDefinitionId,
        name: materialName,
        normalizedName: normalizeCatalogName(materialName),
        kind: 'base',
        status: 'active',
        createdByRole: Role.admin,
        createdAt: FIXTURE_CREATED_AT,
        updatedAt: FIXTURE_CREATED_AT,
      },
    });
    await tx.commercialOrder.upsert({
      where: { orderNumber: fixture.orderNumber },
      update: {},
      create: {
        id: fixture.orderId,
        orderNumber: fixture.orderNumber,
        title: `Warehouse coverage V2 fixture · ${fixture.expectedAvailability}`,
        creatorRole: Role.commercial,
        counterpartyId: fixture.counterpartyId,
        warehouseCoverageWorkflowVersion: 2,
        commercialStage: 'sent_to_finance',
        sentToFinanceAt: FIXTURE_CREATED_AT,
        createdAt: FIXTURE_CREATED_AT,
        updatedAt: FIXTURE_CREATED_AT,
        positions: {
          create: {
            id: fixture.positionId,
            rollCount: fixture.rollCount,
            filmType: 'Полотно',
            actualThickness: '80 мкм',
            accountingThickness: '80 мкм',
            widthMm: FIXTURE_WIDTH_MM,
            plannedLengthM: FIXTURE_PLANNED_LENGTH_M,
            rawMaterialId: fixture.materialId,
            baseRawMaterialDefinitionId: fixture.materialDefinitionId,
            spoolType: '76 мм',
            birka: fixture.birka,
            plannedWeightKg: 40,
            updatedAt: FIXTURE_CREATED_AT,
            recipe: {
              create: {
                id: `${fixture.positionId}-recipe`,
                parameters: [],
                source: 'test_fixture',
                createdBy: COVERAGE_FIXTURE_SYSTEM_ACTOR,
                version: 'v1',
                ingredients: [
                  {
                    rawMaterialDefinitionId: fixture.materialDefinitionId,
                    shareBasisPoints: 10_000,
                  },
                ],
                createdAt: FIXTURE_CREATED_AT,
              },
            },
          },
        },
      },
    });
    await tx.financeOrder.upsert({
      where: { commercialOrderId: fixture.orderId },
      update: {},
      create: {
        id: fixture.financeOrderId,
        commercialOrderId: fixture.orderId,
        invoiceStatus: 'invoiced',
        paymentStatus: 'unpaid',
        sourceStatus: 'ready',
        invoiceIssuedAt: FIXTURE_CREATED_AT,
        createdAt: FIXTURE_CREATED_AT,
        updatedAt: FIXTURE_CREATED_AT,
      },
    });
    await tx.warehouseCoverageState.upsert({
      where: { orderId: fixture.orderId },
      update: {},
      create: {
        orderId: fixture.orderId,
        state: 'calculating',
        stateVersion: 1,
        generation: 0,
        createdAt: FIXTURE_CREATED_AT,
        updatedAt: FIXTURE_CREATED_AT,
      },
    });
  }

  const unavailable = fixtures[1];
  await tx.rawMaterialStock.upsert({
    where: { materialId: unavailable.materialId },
    update: {},
    create: {
      id: 'v2-cover-raw-stock-unavailable',
      materialId: unavailable.materialId,
      label: 'Compatible raw material only · no ready roll',
      actualQty: 1_000,
      unit: 'кг',
      factStatus: 'warehouse_fact',
      rawMaterialDefinitionId: unavailable.materialDefinitionId,
      updatedAt: FIXTURE_CREATED_AT,
    },
  });

  await seedVerifiedPhysicalCoverage(tx, operator.id, fixtures[0]);
  await seedUnknownCoverageCandidate(tx, fixtures[2]);
}

async function seedVerifiedPhysicalCoverage(
  tx: Prisma.TransactionClient,
  operatorId: string,
  fixture: {
    birka: string;
    counterpartyId: string;
    materialDefinitionId: string;
  },
): Promise<void> {
  const sourceOrderId = 'v2-cover-physical-source-order';
  const sourcePositionId = 'v2-cover-physical-source-position';
  await tx.commercialOrder.upsert({
    where: { orderNumber: 'FIXTURE-PHYSICAL-SOURCE' },
    update: {},
    create: {
      id: sourceOrderId,
      orderNumber: 'FIXTURE-PHYSICAL-SOURCE',
      title: 'Physical source for warehouse coverage test fixtures',
      creatorRole: Role.commercial,
      counterpartyId: fixture.counterpartyId,
      warehouseCoverageWorkflowVersion: 1,
      createdAt: FIXTURE_CREATED_AT,
      updatedAt: FIXTURE_CREATED_AT,
      positions: {
        create: {
          id: sourcePositionId,
          rollCount: 2,
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: FIXTURE_WIDTH_MM,
          plannedLengthM: FIXTURE_PLANNED_LENGTH_M,
          rawMaterialId: 'v2-cover-stock-key-verified-full',
          baseRawMaterialDefinitionId: fixture.materialDefinitionId,
          spoolType: '76 мм',
          birka: fixture.birka,
          plannedWeightKg: 40,
          updatedAt: FIXTURE_CREATED_AT,
          recipe: {
            create: {
              id: 'v2-cover-physical-source-recipe',
              parameters: [],
              source: 'test_fixture',
              createdBy: COVERAGE_FIXTURE_SYSTEM_ACTOR,
              version: 'v1',
              ingredients: [
                {
                  rawMaterialDefinitionId: fixture.materialDefinitionId,
                  shareBasisPoints: 10_000,
                },
              ],
              createdAt: FIXTURE_CREATED_AT,
            },
          },
        },
      },
    },
  });
  const productionOrder = await tx.productionOrder.upsert({
    where: { commercialOrderId: sourceOrderId },
    update: {},
    create: {
      id: 'v2-cover-physical-source-production',
      commercialOrderId: sourceOrderId,
      indicator: 'ready',
      approvalState: 'approved',
      createdAt: FIXTURE_CREATED_AT,
      updatedAt: FIXTURE_CREATED_AT,
    },
  });

  for (const sequence of [1, 2] as const) {
    const rollCode = `V2-COVER-FULL-ROLL-${sequence}`;
    const dispatchId = `v2-cover-full-dispatch-${sequence}`;
    const lineId = `v2-cover-full-line-${sequence}`;
    const captureId = `v2-cover-full-capture-${sequence}`;
    const rollId = `v2-cover-full-roll-${sequence}`;
    const factId = `v2-cover-full-fact-${sequence}`;
    await tx.rollDispatchItem.upsert({
      where: { rollCode },
      update: {},
      create: {
        id: dispatchId,
        rollCode,
        productionOrderId: productionOrder.id,
        orderLineId: sourcePositionId,
        positionSequence: sequence,
        rawMaterialId: 'v2-cover-stock-key-verified-full',
        recipeVersion: 'v1',
        filmType: 'Полотно',
        plannedWeightKg: 40,
        characteristicsSnapshot: physicalCharacteristics(fixture),
        status: 'done',
        completedAt: FIXTURE_CREATED_AT,
        createdAt: FIXTURE_CREATED_AT,
        updatedAt: FIXTURE_CREATED_AT,
        operatorLine: {
          create: {
            id: lineId,
            sequence,
            planKg: 40,
            grossKg: 41,
            spoolKg: 1,
            netKg: 40,
            step: 'handed_over',
            labelState: 'verified',
            warehouseState: 'received',
            createdAt: FIXTURE_CREATED_AT,
            updatedAt: FIXTURE_CREATED_AT,
          },
        },
      },
    });
    await tx.weightCapture.upsert({
      where: { id: captureId },
      update: {},
      create: {
        id: captureId,
        operatorRollLineId: lineId,
        kind: 'roll',
        stable: true,
        grossKg: 41,
        spoolKg: 1,
        netKg: 40,
        toleranceOk: true,
        actorRole: Role.operator,
        actorId: operatorId,
        createdAt: FIXTURE_CREATED_AT,
      },
    });
    await tx.warehouseRoll.upsert({
      where: { rollCode },
      update: {},
      create: {
        id: rollId,
        rollCode,
        positionSnapshot: physicalCharacteristics(fixture),
        ownerCounterpartyId: fixture.counterpartyId,
        warehouseStatus: 'received',
        createdAt: FIXTURE_CREATED_AT,
        updatedAt: FIXTURE_CREATED_AT,
      },
    });
    const spec = canonicalizeRollCoverageSpec({
      rollCode,
      sourceOrderId,
      sourcePositionId,
      ownerCounterpartyId: fixture.counterpartyId,
      filmType: 'Полотно',
      actualThicknessMilliMicron: 80_000,
      accountingThicknessMilliMicron: 80_000,
      widthMilliMm: FIXTURE_WIDTH_MM * 1_000,
      plannedLengthMilliM: FIXTURE_PLANNED_LENGTH_M * 1_000,
      birka: fixture.birka,
      spoolType: '76 мм',
      actualWeightMilliKg: 40_000,
      plannedWeightMilliKg: 40_000,
      ingredients: [
        {
          rawMaterialDefinitionId: fixture.materialDefinitionId,
          shareBasisPoints: 10_000,
        },
      ],
      recipeId: 'v2-cover-physical-source-recipe',
      recipeVersion: 'v1',
      recipeDefinitionId: null,
      recipeDefinitionVersionId: null,
      recipeVersionNumber: null,
      policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
    });
    await createCoverageFact(tx, {
      factId,
      rollId,
      spec,
      source: 'production_handover',
      sourceOrderId,
      sourcePositionId,
      sourceDispatchItemId: dispatchId,
      sourceWeightCaptureId: captureId,
      actorKind: 'user',
      actorRole: Role.operator,
      actorId: operatorId,
      systemActorKey: null,
      reason: null,
    });
    await pointRollAtFixtureFact(tx, rollId, factId);
  }
}

async function seedUnknownCoverageCandidate(
  tx: Prisma.TransactionClient,
  fixture: {
    birka: string;
    materialDefinitionId: string;
    orderId: string;
    positionId: string;
  },
): Promise<void> {
  const rollId = 'v2-cover-unknown-roll';
  const rollCode = 'V2-COVER-UNKNOWN-ROLL-1';
  const factId = 'v2-cover-unknown-fact';
  await tx.warehouseRoll.upsert({
    where: { rollCode },
    update: {},
    create: {
      id: rollId,
      rollCode,
      ownerCounterpartyId: null,
      warehouseStatus: 'received',
      createdAt: FIXTURE_CREATED_AT,
      updatedAt: FIXTURE_CREATED_AT,
    },
  });
  const spec = canonicalizeRollCoverageSpec({
    rollCode,
    sourceOrderId: fixture.orderId,
    sourcePositionId: fixture.positionId,
    ownerCounterpartyId: null,
    filmType: 'Полотно',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 80_000,
    widthMilliMm: FIXTURE_WIDTH_MM * 1_000,
    plannedLengthMilliM: FIXTURE_PLANNED_LENGTH_M * 1_000,
    birka: fixture.birka,
    spoolType: '76 мм',
    actualWeightMilliKg: 40_000,
    plannedWeightMilliKg: 40_000,
    ingredients: [
      {
        rawMaterialDefinitionId: fixture.materialDefinitionId,
        shareBasisPoints: 10_000,
      },
    ],
    recipeId: `${fixture.positionId}-recipe`,
    recipeVersion: 'v1',
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
  });
  await createCoverageFact(tx, {
    factId,
    rollId,
    spec,
    source: 'migration_backfill',
    sourceOrderId: fixture.orderId,
    sourcePositionId: fixture.positionId,
    sourceDispatchItemId: null,
    sourceWeightCaptureId: null,
    actorKind: 'system',
    actorRole: null,
    actorId: null,
    systemActorKey: COVERAGE_FIXTURE_SYSTEM_ACTOR,
    reason: null,
  });
  await pointRollAtFixtureFact(tx, rollId, factId);
}

function physicalCharacteristics(fixture: {
  birka: string;
  materialDefinitionId: string;
}): Prisma.InputJsonObject {
  return {
    filmType: 'Полотно',
    actualThickness: '80 мкм',
    accountingThickness: '80 мкм',
    widthMm: FIXTURE_WIDTH_MM,
    plannedLengthM: FIXTURE_PLANNED_LENGTH_M,
    birka: fixture.birka,
    spoolType: '76 мм',
    ingredients: [
      {
        rawMaterialDefinitionId: fixture.materialDefinitionId,
        shareBasisPoints: 10_000,
      },
    ],
    recipeId: 'v2-cover-physical-source-recipe',
    recipeVersion: 'v1',
  };
}

async function createCoverageFact(
  tx: Prisma.TransactionClient,
  input: {
    factId: string;
    rollId: string;
    spec: CanonicalRollCoverageSpec;
    source: 'migration_backfill' | 'production_handover';
    sourceOrderId: string;
    sourcePositionId: string;
    sourceDispatchItemId: string | null;
    sourceWeightCaptureId: string | null;
    actorKind: 'system' | 'user';
    actorRole: Role | null;
    actorId: string | null;
    systemActorKey: string | null;
    reason: null;
  },
): Promise<void> {
  await tx.warehouseRollCoverageFact.createMany({
    data: [
      {
        id: input.factId,
        rollId: input.rollId,
        version: 1,
        source: input.source,
        specVersion: COVERAGE_FACT_SPEC_VERSION,
        specFingerprint: fingerprintRollFact(input.spec),
        spec: input.spec as unknown as Prisma.InputJsonValue,
        sourceOrderId: input.sourceOrderId,
        sourcePositionId: input.sourcePositionId,
        sourceDispatchItemId: input.sourceDispatchItemId,
        sourceWeightCaptureId: input.sourceWeightCaptureId,
        actorKind: input.actorKind,
        actorRole: input.actorRole,
        actorId: input.actorId,
        systemActorKey: input.systemActorKey,
        reason: input.reason,
        createdAt: FIXTURE_CREATED_AT,
      },
    ],
    skipDuplicates: true,
  });
  const persisted = await tx.warehouseRollCoverageFact.findUniqueOrThrow({
    where: { id: input.factId },
    select: {
      rollId: true,
      version: true,
      source: true,
      specFingerprint: true,
      sourceOrderId: true,
      sourcePositionId: true,
      sourceDispatchItemId: true,
      sourceWeightCaptureId: true,
      actorKind: true,
      actorRole: true,
      actorId: true,
      systemActorKey: true,
    },
  });
  const expected = {
    rollId: input.rollId,
    version: 1,
    source: input.source,
    specFingerprint: fingerprintRollFact(input.spec),
    sourceOrderId: input.sourceOrderId,
    sourcePositionId: input.sourcePositionId,
    sourceDispatchItemId: input.sourceDispatchItemId,
    sourceWeightCaptureId: input.sourceWeightCaptureId,
    actorKind: input.actorKind,
    actorRole: input.actorRole,
    actorId: input.actorId,
    systemActorKey: input.systemActorKey,
  };
  if (JSON.stringify(persisted) !== JSON.stringify(expected)) {
    throw new Error(`Warehouse coverage V2 fixture fact conflict: ${input.factId}`);
  }
}

async function pointRollAtFixtureFact(
  tx: Prisma.TransactionClient,
  rollId: string,
  factId: string,
): Promise<void> {
  const roll = await tx.warehouseRoll.findUniqueOrThrow({
    where: { id: rollId },
    select: { currentCoverageFactId: true },
  });
  if (roll.currentCoverageFactId === factId) return;
  if (roll.currentCoverageFactId !== null) {
    throw new Error(`Warehouse coverage V2 fixture roll conflict: ${rollId}`);
  }
  await tx.warehouseRoll.update({
    where: { id: rollId },
    data: { currentCoverageFactId: factId },
  });
}
