import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type {
  WarehouseInventoryRollDetail,
  WarehouseInventoryRollItem,
  WarehouseInventoryRollPage,
} from '@plenka/contracts';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';

const DAY_MS = 86_400_000;
const ACCOUNTS = [
  'commercial',
  'production',
  'operator',
  'warehouse',
  'finance',
  'director',
  'admin',
] as const;
const FORBIDDEN_ACCOUNTS = [
  'commercial',
  'production',
  'operator',
  'finance',
  'admin',
] as const;
const FORBIDDEN_PROJECTION_KEYS = new Set([
  'actorId',
  'currentCoverageFact',
  'currentCoverageFactId',
  'externalId',
  'inn',
  'kpp',
  'legalName',
  'ownerCounterpartyId',
  'positionSnapshot',
  'producedByCoverageDecisionId',
  'producedForOrderId',
  'producedForPositionId',
  'producedForStockOrderId',
  'rawPayload',
  'reason',
  'recipeVersion',
  'requestFingerprint',
  'reservedAt',
  'reservedByCoverageDecisionId',
  'reservedByProposalId',
  'reservedForOrderId',
  'reservedForPositionId',
  'sourceOrderId',
  'sourcePositionId',
  'sourceVersion',
  'specFingerprint',
  'systemActorKey',
]);
const LIST_ITEM_KEYS = [
  'batchCode',
  'counterpartyName',
  'id',
  'lifecycleStatus',
  'lifecycleStatusLabel',
  'nextRoute',
  'nextRouteLabel',
  'orderNumber',
  'origin',
  'positionId',
  'positionSequence',
  'processedAt',
  'receivedAt',
  'rollCode',
  'specification',
  'warehouseStatus',
  'warehouseStatusLabel',
  'weightKg',
] as const;
const DETAIL_KEYS = [...LIST_ITEM_KEYS, 'provenance', 'specificationDetails'].sort();
const SPECIFICATION_DETAIL_KEYS = [
  'accountingThicknessMicron',
  'actualThicknessMicron',
  'birka',
  'filmType',
  'ingredients',
  'netKg',
  'plannedLengthM',
  'recipeName',
  'spoolType',
  'widthMm',
] as const;
const PROVENANCE_KEYS = ['batchCode', 'kind', 'orderNumber'] as const;

type Account = (typeof ACCOUNTS)[number];
type Headers = { Authorization: string };
type SourceOrder = {
  id: string;
  orderNumber: string;
  positionId: string;
};
type RollFixture = {
  id: string;
  receivedAt: string;
  rollCode: string;
};
type PaginationFixture = {
  ascIds: string[];
  descIds: string[];
  prefix: string;
};
type Fixture = {
  batchCode: string;
  canaries: string[];
  clientV1: RollFixture;
  clientV1Name: string;
  clientV2: RollFixture;
  clientV2Name: string;
  clientV2OrderNumber: string;
  inTransit: RollFixture;
  manual: RollFixture;
  oldProcessed: RollFixture;
  pagination: PaginationFixture;
  prefix: string;
  processed: RollFixture & { processedAt: string };
  reserved: RollFixture;
  stock: RollFixture;
  stockOrderNumber: string;
};
type FixtureIds = {
  calculationIds: string[];
  counterpartyIds: string[];
  decisionIds: string[];
  dispatchIds: string[];
  factIds: string[];
  materialIds: string[];
  operatorLineIds: string[];
  orderIds: string[];
  positionIds: string[];
  productionOrderIds: string[];
  reserveCommandIds: string[];
  rollIds: string[];
  stateOrderIds: string[];
  weightCaptureIds: string[];
};

function collectKeys(value: unknown, target: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, target);
    return target;
  }
  if (value === null || typeof value !== 'object') return target;
  for (const [key, nested] of Object.entries(value)) {
    target.push(key);
    collectKeys(nested, target);
  }
  return target;
}

function expectSafeProjection(value: unknown, canaries: readonly string[]): void {
  for (const key of collectKeys(value)) {
    expect(FORBIDDEN_PROJECTION_KEYS.has(key)).toBe(false);
  }
  const serialized = JSON.stringify(value);
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
  }
}

describe('Unified warehouse inventory (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let auth: Record<Account, Headers>;
  let fixture: Fixture;
  let previousDevRole: string | undefined;
  const fixtureIds: FixtureIds = {
    calculationIds: [],
    counterpartyIds: [],
    decisionIds: [],
    dispatchIds: [],
    factIds: [],
    materialIds: [],
    operatorLineIds: [],
    orderIds: [],
    positionIds: [],
    productionOrderIds: [],
    reserveCommandIds: [],
    rollIds: [],
    stateOrderIds: [],
    weightCaptureIds: [],
  };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    previousDevRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';

    // Runtime auth configuration is captured during AppModule evaluation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const sessions = await Promise.all(
      ACCOUNTS.map(async (account) => {
        const response = await http()
          .post('/api/auth/login')
          .send({ login: e2eSeedLogin(account), password: e2eSeedPassword() })
          .expect(201);
        return [account, { Authorization: `Bearer ${response.body.token as string}` }] as const;
      }),
    );
    auth = Object.fromEntries(sessions) as Record<Account, Headers>;
    fixture = await createFixture();
  });

  afterAll(async () => {
    await runE2eWithCleanup(async () => {
      if (!prisma) return;
      await prisma.$transaction(async (tx) => {
        await tx.warehouseRoll.updateMany({
          where: { id: { in: fixtureIds.rollIds } },
          data: { currentCoverageFactId: null },
        });
        await tx.warehouseReserveRollCommand.deleteMany({
          where: { id: { in: fixtureIds.reserveCommandIds } },
        });
        // Coverage facts are append-only in application code. This exact e2e-only trigger
        // suspension happens under one table lock and is rolled back automatically on failure,
        // allowing the shared isolated test schema to remain uncontaminated.
        await tx.$executeRawUnsafe(
          'ALTER TABLE "warehouse_roll_coverage_facts" ' +
            'DISABLE TRIGGER "warehouse_roll_coverage_facts_append_only"',
        );
        await tx.warehouseRollCoverageFact.deleteMany({
          where: { id: { in: fixtureIds.factIds } },
        });
        await tx.$executeRawUnsafe(
          'ALTER TABLE "warehouse_roll_coverage_facts" ' +
            'ENABLE TRIGGER "warehouse_roll_coverage_facts_append_only"',
        );
        await tx.warehouseRoll.deleteMany({ where: { id: { in: fixtureIds.rollIds } } });
        await tx.weightCapture.deleteMany({
          where: { id: { in: fixtureIds.weightCaptureIds } },
        });
        await tx.operatorRollLine.deleteMany({
          where: { id: { in: fixtureIds.operatorLineIds } },
        });
        await tx.rollDispatchItem.deleteMany({
          where: { id: { in: fixtureIds.dispatchIds } },
        });
        await tx.productionOrder.deleteMany({
          where: { id: { in: fixtureIds.productionOrderIds } },
        });
        await tx.warehouseCoverageState.deleteMany({
          where: { orderId: { in: fixtureIds.stateOrderIds } },
        });
        await tx.$executeRawUnsafe(
          'ALTER TABLE "warehouse_coverage_decisions" ' +
            'DISABLE TRIGGER "warehouse_coverage_decisions_append_only"',
        );
        await tx.warehouseCoverageDecision.deleteMany({
          where: { id: { in: fixtureIds.decisionIds } },
        });
        await tx.$executeRawUnsafe(
          'ALTER TABLE "warehouse_coverage_decisions" ' +
            'ENABLE TRIGGER "warehouse_coverage_decisions_append_only"',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "warehouse_coverage_calculations" ' +
            'DISABLE TRIGGER "warehouse_coverage_calculations_append_only"',
        );
        await tx.warehouseCoverageCalculation.deleteMany({
          where: { id: { in: fixtureIds.calculationIds } },
        });
        await tx.$executeRawUnsafe(
          'ALTER TABLE "warehouse_coverage_calculations" ' +
            'ENABLE TRIGGER "warehouse_coverage_calculations_append_only"',
        );
        await tx.recipeSnapshot.deleteMany({
          where: { positionId: { in: fixtureIds.positionIds } },
        });
        await tx.commercialOrderPosition.deleteMany({
          where: { id: { in: fixtureIds.positionIds } },
        });
        await tx.commercialOrder.deleteMany({ where: { id: { in: fixtureIds.orderIds } } });
        await tx.counterparty.deleteMany({
          where: { id: { in: fixtureIds.counterpartyIds } },
        });
        await tx.rawMaterialDefinition.deleteMany({
          where: { id: { in: fixtureIds.materialIds } },
        });
      });
    }, [
      { label: 'unified warehouse inventory application', run: () => app?.close() },
      {
        label: 'unified warehouse inventory auth environment',
        run: () => {
          if (previousDevRole === undefined) delete process.env.AUTH_DEV_XROLE;
          else process.env.AUTH_DEV_XROLE = previousDevRole;
        },
      },
    ]);
  });

  async function createSourceOrder(input: {
    counterpartyId?: string;
    label: string;
    requestType?: 'client_order' | 'stock_reserve';
    stockBatchCode?: string;
    workflowVersion?: number;
  }): Promise<SourceOrder> {
    const order = await prisma.commercialOrder.create({
      data: {
        id: `${input.label}-order`,
        orderNumber: `${input.label.toUpperCase()}-ORDER`,
        creatorRole: input.requestType === 'stock_reserve' ? 'production_lead' : 'commercial',
        counterpartyId: input.counterpartyId,
        requestType: input.requestType ?? 'client_order',
        stockBatchCode: input.stockBatchCode,
        warehouseCoverageWorkflowVersion: input.workflowVersion ?? 1,
        comment: fixtureCanary('order-comment'),
        positions: {
          create: {
            id: `${input.label}-position`,
            rollCount: 6,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            plannedWeightKg: 42.5,
            widthMm: 1_500,
            plannedLengthM: 300,
            spoolType: '76 мм',
            birka: 'ГОСТ',
            baseRawMaterialDefinitionId: fixtureIds.materialIds[0],
            comment: fixtureCanary('position-comment'),
            recipe: {
              create: {
                parameters: { internal: fixtureCanary('recipe-parameters') },
                source: 'commercial_form',
                createdBy: 'unified-inventory-e2e',
                recipeName: 'Рецептура тестового рулона',
                ingredients: [{ internal: fixtureCanary('recipe-ingredients') }],
              },
            },
          },
        },
      },
      include: { positions: { select: { id: true } } },
    });
    fixtureIds.orderIds.push(order.id);
    const positionId = order.positions[0]!.id;
    fixtureIds.positionIds.push(positionId);
    return { id: order.id, orderNumber: order.orderNumber, positionId };
  }

  function fixtureCanary(kind: string): string {
    return `UI_INTERNAL_${kind.toUpperCase()}_${fixtureIds.materialIds[0] ?? 'setup'}`;
  }

  async function createRoll(input: {
    id: string;
    ownerCounterpartyId?: string;
    positionSnapshotCanary?: string;
    producedForOrderId?: string;
    producedForPositionId?: string;
    producedForStockOrderId?: string;
    receivedAt: Date;
    reservedAt?: Date;
    reservedForOrderId?: string;
    reservedForPositionId?: string;
    rollCode: string;
    warehouseStatus: string;
  }): Promise<RollFixture> {
    const row = await prisma.warehouseRoll.create({
      data: {
        id: input.id,
        rollCode: input.rollCode,
        ownerCounterpartyId: input.ownerCounterpartyId,
        producedForOrderId: input.producedForOrderId,
        producedForPositionId: input.producedForPositionId,
        producedForStockOrderId: input.producedForStockOrderId,
        reservedForOrderId: input.reservedForOrderId,
        reservedForPositionId: input.reservedForPositionId,
        reservedAt: input.reservedAt,
        warehouseStatus: input.warehouseStatus,
        receivedAt: input.receivedAt,
        createdAt: input.receivedAt,
        externalId: `${input.rollCode}-EXTERNAL`,
        sourceVersion: fixtureCanary('roll-source-version'),
        positionSnapshot: input.positionSnapshotCanary
          ? {
              filmType: 'НЕ ИСПОЛЬЗОВАТЬ',
              rawPayload: input.positionSnapshotCanary,
            }
          : undefined,
      },
      select: { id: true, receivedAt: true, rollCode: true },
    });
    fixtureIds.rollIds.push(row.id);
    return {
      id: row.id,
      receivedAt: row.receivedAt!.toISOString(),
      rollCode: row.rollCode,
    };
  }

  async function attachCanonicalFact(input: {
    ownerCounterpartyId: string | null;
    roll: RollFixture;
    sourceOrderId: string | null;
    sourcePositionId: string | null;
  }): Promise<void> {
    const factId = `${input.roll.id}-fact`;
    const spec = canonicalizeRollCoverageSpec({
      rollCode: input.roll.rollCode,
      sourceOrderId: input.sourceOrderId,
      sourcePositionId: input.sourcePositionId,
      ownerCounterpartyId: input.ownerCounterpartyId,
      filmType: 'Рукав',
      actualThicknessMilliMicron: 80_000,
      accountingThicknessMilliMicron: 78_000,
      widthMilliMm: 1_500_000,
      plannedLengthMilliM: 300_000,
      birka: 'ГОСТ',
      spoolType: '76 мм',
      actualWeightMilliKg: 42_500,
      plannedWeightMilliKg: 42_500,
      ingredients: [
        {
          rawMaterialDefinitionId: fixtureIds.materialIds[0]!,
          shareBasisPoints: 10_000,
        },
      ],
      recipeId: null,
      recipeVersion: null,
      recipeDefinitionId: null,
      recipeDefinitionVersionId: null,
      recipeVersionNumber: null,
      policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
    });
    await prisma.warehouseRollCoverageFact.create({
      data: {
        id: factId,
        rollId: input.roll.id,
        version: 1,
        source: 'migration_backfill',
        specVersion: 'warehouse-roll-coverage/v1',
        specFingerprint: fingerprintRollFact(spec),
        spec: spec as unknown as Prisma.InputJsonValue,
        sourceOrderId: input.sourceOrderId,
        sourcePositionId: input.sourcePositionId,
        actorKind: 'system',
        systemActorKey: 'warehouse_coverage_engine',
      },
    });
    fixtureIds.factIds.push(factId);
    await prisma.warehouseRoll.update({
      where: { id: input.roll.id },
      data: { currentCoverageFactId: factId },
    });
  }

  async function attachV2ProductionHandover(input: {
    counterpartyId: string;
    order: SourceOrder;
    roll: RollFixture;
  }): Promise<void> {
    const [operator, epochRow] = await Promise.all([
      prisma.user.findFirstOrThrow({
        where: { role: 'operator', isActive: true },
        select: { id: true },
      }),
      prisma.warehouseCoverageInventoryEpoch.findUniqueOrThrow({
        where: { id: 1 },
        select: { epoch: true },
      }),
    ]);
    const inputFingerprint = 'b'.repeat(64);
    const calculationId = `${input.roll.id}-calculation`;
    await prisma.warehouseCoverageCalculation.create({
      data: {
        id: calculationId,
        orderId: input.order.id,
        generation: 1,
        orderVersion: 1,
        positionVersions: [{ positionId: input.order.positionId, version: 1 }],
        orderFingerprint: inputFingerprint,
        inventoryEpoch: epochRow.epoch,
        inventoryFingerprint: inputFingerprint,
        inputFingerprint,
        algorithmVersion: 'warehouse-coverage-matching/v1',
        policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
        availability: 'unavailable',
        reasonCodes: ['no_compatible_rolls'],
        requiredRollCount: 6,
        matchedRollCount: 0,
        uncertainRollCount: 0,
        verifiedCandidateRollIds: [],
        uncertainCandidateRollIds: [],
        systemActorKey: 'warehouse_coverage_engine',
      },
    });
    fixtureIds.calculationIds.push(calculationId);

    const decisionId = randomUUID();
    await prisma.warehouseCoverageDecision.create({
      data: {
        id: decisionId,
        orderId: input.order.id,
        calculationId,
        generation: 1,
        kind: 'auto_produce_all',
        inputFingerprint,
        sourceInventoryEpoch: epochRow.epoch,
        expectedRollCount: 0,
        actorKind: 'system',
        systemActorKey: 'warehouse_coverage_engine',
      },
    });
    fixtureIds.decisionIds.push(decisionId);
    await prisma.warehouseCoverageState.create({
      data: {
        orderId: input.order.id,
        state: 'production_required',
        stateVersion: 1,
        generation: 1,
        currentCalculationId: calculationId,
        currentDecisionId: decisionId,
      },
    });
    fixtureIds.stateOrderIds.push(input.order.id);

    const production = await prisma.productionOrder.create({
      data: {
        id: `${input.roll.id}-production`,
        commercialOrderId: input.order.id,
        approvalState: 'approved',
        sourceCoverageCalculationId: calculationId,
        sourceCoverageDecisionId: decisionId,
        sourceCoverageInputFingerprint: inputFingerprint,
        sourceCoverageGeneration: 1,
      },
    });
    fixtureIds.productionOrderIds.push(production.id);
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        id: `${input.roll.id}-dispatch`,
        rollCode: input.roll.rollCode,
        productionOrderId: production.id,
        orderLineId: input.order.positionId,
        recipeVersion: 'v1',
        plannedWeightKg: 42.5,
        status: 'assigned',
        characteristicsSnapshot: {
          internal: fixtureCanary('dispatch-snapshot'),
        },
        operatorLine: {
          create: {
            id: `${input.roll.id}-operator-line`,
            step: 'handover',
            labelState: 'verified',
            warehouseState: 'not_ready',
            planKg: 42.5,
          },
        },
      },
      include: { operatorLine: { select: { id: true } } },
    });
    fixtureIds.dispatchIds.push(dispatch.id);
    const operatorLineId = dispatch.operatorLine!.id;
    fixtureIds.operatorLineIds.push(operatorLineId);
    const capture = await prisma.weightCapture.create({
      data: {
        id: `${input.roll.id}-weight`,
        operatorRollLineId: operatorLineId,
        kind: 'roll',
        stable: true,
        grossKg: 43.5,
        spoolKg: 1,
        netKg: 42.5,
        actorRole: 'operator',
        actorId: operator.id,
      },
    });
    fixtureIds.weightCaptureIds.push(capture.id);

    const factId = `${input.roll.id}-fact`;
    const spec = canonicalizeRollCoverageSpec({
      rollCode: input.roll.rollCode,
      sourceOrderId: input.order.id,
      sourcePositionId: input.order.positionId,
      ownerCounterpartyId: input.counterpartyId,
      filmType: 'Рукав',
      actualThicknessMilliMicron: 80_000,
      accountingThicknessMilliMicron: 78_000,
      widthMilliMm: 1_500_000,
      plannedLengthMilliM: 300_000,
      birka: 'ГОСТ',
      spoolType: '76 мм',
      actualWeightMilliKg: 42_500,
      plannedWeightMilliKg: 42_500,
      ingredients: [
        {
          rawMaterialDefinitionId: fixtureIds.materialIds[0]!,
          shareBasisPoints: 10_000,
        },
      ],
      recipeId: null,
      recipeVersion: null,
      recipeDefinitionId: null,
      recipeDefinitionVersionId: null,
      recipeVersionNumber: null,
      policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
    });
    await prisma.warehouseRollCoverageFact.create({
      data: {
        id: factId,
        rollId: input.roll.id,
        version: 1,
        source: 'production_handover',
        specVersion: 'warehouse-roll-coverage/v1',
        specFingerprint: fingerprintRollFact(spec),
        spec: spec as unknown as Prisma.InputJsonValue,
        sourceOrderId: input.order.id,
        sourcePositionId: input.order.positionId,
        sourceDispatchItemId: dispatch.id,
        sourceWeightCaptureId: capture.id,
        actorKind: 'user',
        actorRole: 'operator',
        actorId: operator.id,
      },
    });
    fixtureIds.factIds.push(factId);
    await prisma.warehouseRoll.update({
      where: { id: input.roll.id },
      data: {
        currentCoverageFactId: factId,
        producedForOrderId: input.order.id,
        producedForPositionId: input.order.positionId,
        producedByCoverageDecisionId: decisionId,
      },
    });
  }

  async function createFixture(): Promise<Fixture> {
    const token = randomUUID().replaceAll('-', '').slice(0, 10);
    const prefix = `UI-${token.toUpperCase()}`;
    const now = new Date();
    const materialName = `Материал ${prefix}`;
    const material = await prisma.rawMaterialDefinition.create({
      data: {
        id: `ui-${token}-material`,
        name: materialName,
        normalizedName: materialName.toLocaleLowerCase('ru-RU'),
        createdByRole: 'warehouse',
      },
    });
    fixtureIds.materialIds.push(material.id);

    const clientV1Name = `V1 контрагент ${prefix}`;
    const clientV2Name = `V2 контрагент ${prefix}`;
    const v1Counterparty = await prisma.counterparty.create({
      data: {
        id: `ui-${token}-counterparty-v1`,
        displayName: clientV1Name,
        legalName: fixtureCanary('v1-legal-name'),
        inn: fixtureCanary('v1-inn'),
        externalId: `ui-${token}-counterparty-v1-external`,
        sourceVersion: fixtureCanary('v1-counterparty-source'),
      },
    });
    const v2Counterparty = await prisma.counterparty.create({
      data: {
        id: `ui-${token}-counterparty-v2`,
        displayName: clientV2Name,
        legalName: fixtureCanary('v2-legal-name'),
        kpp: fixtureCanary('v2-kpp'),
        externalId: `ui-${token}-counterparty-v2-external`,
        sourceVersion: fixtureCanary('v2-counterparty-source'),
      },
    });
    fixtureIds.counterpartyIds.push(v1Counterparty.id, v2Counterparty.id);

    const reservationOrder = await createSourceOrder({
      counterpartyId: v1Counterparty.id,
      label: `ui-${token}-reservation`,
      workflowVersion: 1,
    });
    const clientV2Order = await createSourceOrder({
      counterpartyId: v2Counterparty.id,
      label: `ui-${token}-client-v2`,
      workflowVersion: 2,
    });
    const batchCode = `${prefix}-BATCH`;
    const stockOrder = await createSourceOrder({
      label: `ui-${token}-stock`,
      requestType: 'stock_reserve',
      stockBatchCode: batchCode,
    });
    const manualOrder = await createSourceOrder({
      label: `ui-${token}-manual-source`,
      requestType: 'stock_reserve',
      stockBatchCode: `${prefix}-MANUAL-BATCH`,
    });

    const clientV1 = await createRoll({
      id: `ui-${token}-non-uuid-client-v1`,
      rollCode: `${prefix}-01-CLIENT-V1`,
      ownerCounterpartyId: v1Counterparty.id,
      warehouseStatus: 'received',
      receivedAt: new Date(now.getTime() - 1 * DAY_MS),
      positionSnapshotCanary: fixtureCanary('v1-position-snapshot'),
    });
    await attachCanonicalFact({
      roll: clientV1,
      ownerCounterpartyId: v1Counterparty.id,
      sourceOrderId: null,
      sourcePositionId: null,
    });

    const clientV2 = await createRoll({
      id: `ui-${token}-non-uuid-client-v2`,
      rollCode: `${prefix}-02-CLIENT-V2`,
      ownerCounterpartyId: v2Counterparty.id,
      warehouseStatus: 'received',
      receivedAt: new Date(now.getTime() - 2 * DAY_MS),
    });
    await attachV2ProductionHandover({
      roll: clientV2,
      counterpartyId: v2Counterparty.id,
      order: clientV2Order,
    });

    const stock = await createRoll({
      id: `ui-${token}-non-uuid-stock`,
      rollCode: `${prefix}-03-STOCK`,
      producedForStockOrderId: stockOrder.id,
      warehouseStatus: 'received',
      receivedAt: new Date(now.getTime() - 3 * DAY_MS),
    });
    await attachCanonicalFact({
      roll: stock,
      ownerCounterpartyId: null,
      sourceOrderId: stockOrder.id,
      sourcePositionId: stockOrder.positionId,
    });

    const manual = await createRoll({
      id: `ui-${token}-non-uuid-manual`,
      rollCode: `${prefix}-04-MANUAL`,
      warehouseStatus: 'received',
      receivedAt: new Date(now.getTime() - 4 * DAY_MS),
      positionSnapshotCanary: fixtureCanary('manual-position-snapshot'),
    });
    const manualCommand = await prisma.warehouseReserveRollCommand.create({
      data: {
        operationKey: randomUUID(),
        requestFingerprint: 'a'.repeat(64),
        rollId: manual.id,
        sourceOrderId: manualOrder.id,
        sourcePositionId: manualOrder.positionId,
        actorRole: 'warehouse',
        resultSnapshot: {
          id: manual.id,
          rollCode: manual.rollCode,
          internal: fixtureCanary('manual-command-result'),
        },
      },
    });
    fixtureIds.reserveCommandIds.push(manualCommand.id);

    const reservedAt = new Date(now.getTime() - 5 * DAY_MS);
    const reserved = await createRoll({
      id: `ui-${token}-non-uuid-reserved`,
      rollCode: `${prefix}-05-RESERVED`,
      producedForStockOrderId: stockOrder.id,
      reservedForOrderId: reservationOrder.id,
      reservedForPositionId: reservationOrder.positionId,
      reservedAt,
      warehouseStatus: 'received',
      receivedAt: new Date(now.getTime() - 6 * DAY_MS),
    });
    await attachCanonicalFact({
      roll: reserved,
      ownerCounterpartyId: null,
      sourceOrderId: stockOrder.id,
      sourcePositionId: stockOrder.positionId,
    });

    const inTransit = await createRoll({
      id: `ui-${token}-non-uuid-in-transit`,
      rollCode: `${prefix}-06-IN-TRANSIT`,
      producedForStockOrderId: stockOrder.id,
      warehouseStatus: 'sent',
      receivedAt: new Date(now.getTime() - 7 * DAY_MS),
    });
    await attachCanonicalFact({
      roll: inTransit,
      ownerCounterpartyId: null,
      sourceOrderId: stockOrder.id,
      sourcePositionId: stockOrder.positionId,
    });

    const processedAt = new Date(now.getTime() - 10 * DAY_MS);
    const processed = await createRoll({
      id: `ui-${token}-non-uuid-processed`,
      rollCode: `${prefix}-07-PROCESSED`,
      producedForStockOrderId: stockOrder.id,
      reservedForOrderId: reservationOrder.id,
      reservedForPositionId: reservationOrder.positionId,
      reservedAt: processedAt,
      warehouseStatus: 'delivered',
      receivedAt: new Date(now.getTime() - 20 * DAY_MS),
    });
    await attachCanonicalFact({
      roll: processed,
      ownerCounterpartyId: null,
      sourceOrderId: stockOrder.id,
      sourcePositionId: stockOrder.positionId,
    });

    const oldProcessedAt = new Date(now.getTime() - 91 * DAY_MS);
    const oldProcessed = await createRoll({
      id: `ui-${token}-non-uuid-old-processed`,
      rollCode: `${prefix}-08-OLD-PROCESSED`,
      producedForStockOrderId: stockOrder.id,
      reservedForOrderId: reservationOrder.id,
      reservedForPositionId: reservationOrder.positionId,
      reservedAt: oldProcessedAt,
      warehouseStatus: 'delivered',
      receivedAt: new Date(now.getTime() - 100 * DAY_MS),
    });
    await attachCanonicalFact({
      roll: oldProcessed,
      ownerCounterpartyId: null,
      sourceOrderId: stockOrder.id,
      sourcePositionId: stockOrder.positionId,
    });

    const paginationPrefix = `UI-PAGE-${token.toUpperCase()}`;
    const paginationIds = {
      older: `ui-${token}-page-older`,
      tieA: `ui-${token}-page-tie-a`,
      tieB: `ui-${token}-page-tie-b`,
      tieC: `ui-${token}-page-tie-c`,
      nullA: `ui-${token}-page-null-a`,
      nullB: `ui-${token}-page-null-b`,
      nullC: `ui-${token}-page-null-c`,
    };
    const tiedReceivedAt = new Date(now.getTime() - 8 * DAY_MS);
    const paginationCreatedAt = new Date(now.getTime() - 10 * DAY_MS);
    await prisma.warehouseRoll.createMany({
      data: [
        {
          id: paginationIds.older,
          rollCode: `${paginationPrefix}-OLDER`,
          warehouseStatus: 'received',
          receivedAt: new Date(now.getTime() - 9 * DAY_MS),
          createdAt: paginationCreatedAt,
        },
        {
          id: paginationIds.tieA,
          rollCode: `${paginationPrefix}-TIE-A`,
          warehouseStatus: 'received',
          receivedAt: tiedReceivedAt,
          createdAt: paginationCreatedAt,
        },
        {
          id: paginationIds.tieB,
          rollCode: `${paginationPrefix}-TIE-B`,
          warehouseStatus: 'received',
          receivedAt: tiedReceivedAt,
          createdAt: paginationCreatedAt,
        },
        {
          id: paginationIds.tieC,
          rollCode: `${paginationPrefix}-TIE-C`,
          warehouseStatus: 'received',
          receivedAt: tiedReceivedAt,
          createdAt: paginationCreatedAt,
        },
        {
          id: paginationIds.nullA,
          rollCode: `${paginationPrefix}-NULL-A`,
          warehouseStatus: 'received',
          receivedAt: null,
          createdAt: paginationCreatedAt,
        },
        {
          id: paginationIds.nullB,
          rollCode: `${paginationPrefix}-NULL-B`,
          warehouseStatus: 'received',
          receivedAt: null,
          createdAt: paginationCreatedAt,
        },
        {
          id: paginationIds.nullC,
          rollCode: `${paginationPrefix}-NULL-C`,
          warehouseStatus: 'received',
          receivedAt: null,
          createdAt: paginationCreatedAt,
        },
      ],
    });
    fixtureIds.rollIds.push(...Object.values(paginationIds));

    const canaries = [
      fixtureCanary('order-comment'),
      fixtureCanary('position-comment'),
      fixtureCanary('recipe-parameters'),
      fixtureCanary('recipe-ingredients'),
      fixtureCanary('dispatch-snapshot'),
      fixtureCanary('roll-source-version'),
      fixtureCanary('v1-legal-name'),
      fixtureCanary('v1-inn'),
      fixtureCanary('v1-counterparty-source'),
      fixtureCanary('v2-legal-name'),
      fixtureCanary('v2-kpp'),
      fixtureCanary('v2-counterparty-source'),
      fixtureCanary('v1-position-snapshot'),
      fixtureCanary('manual-position-snapshot'),
      fixtureCanary('manual-command-result'),
    ];
    return {
      batchCode,
      canaries,
      clientV1,
      clientV1Name,
      clientV2,
      clientV2Name,
      clientV2OrderNumber: clientV2Order.orderNumber,
      inTransit,
      manual,
      oldProcessed,
      pagination: {
        ascIds: [
          paginationIds.older,
          paginationIds.tieA,
          paginationIds.tieB,
          paginationIds.tieC,
          paginationIds.nullA,
          paginationIds.nullB,
          paginationIds.nullC,
        ],
        descIds: [
          paginationIds.tieC,
          paginationIds.tieB,
          paginationIds.tieA,
          paginationIds.older,
          paginationIds.nullC,
          paginationIds.nullB,
          paginationIds.nullA,
        ],
        prefix: paginationPrefix,
      },
      prefix,
      processed: { ...processed, processedAt: processedAt.toISOString() },
      reserved,
      stock,
      stockOrderNumber: stockOrder.orderNumber,
    };
  }

  it('enforces real-session 200/403/401 access on list and non-UUID detail routes', async () => {
    const listPath = `/api/warehouse/inventory/rolls?q=${encodeURIComponent(fixture.prefix)}`;
    const detailPath = `/api/warehouse/inventory/rolls/${fixture.clientV2.id}`;

    await http().get(listPath).set(auth.warehouse).expect(200);
    await http().get(detailPath).set(auth.warehouse).expect(200);
    await http().get(listPath).set(auth.director).expect(200);
    await http().get(detailPath).set(auth.director).expect(200);
    for (const account of FORBIDDEN_ACCOUNTS) {
      await http().get(listPath).set(auth[account]).expect(403);
      await http().get(detailPath).set(auth[account]).expect(403);
    }
    await http().get(listPath).expect(401);
    await http().get(detailPath).expect(401);
    await http().get(listPath).set('x-role', 'warehouse').expect(401);
    await http().get(detailPath).set('x-role', 'warehouse').expect(401);
  });

  it('returns one exact safe projection for every visible lifecycle and keeps incomplete rows', async () => {
    const response = await http()
      .get('/api/warehouse/inventory/rolls')
      .query({
        q: fixture.prefix,
        sort: 'rollCode',
        direction: 'asc',
        limit: 100,
      })
      .set(auth.warehouse)
      .expect(200);
    const page = response.body as WarehouseInventoryRollPage;

    expect(Object.keys(page).sort()).toEqual(['items', 'nextCursor']);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map(({ rollCode }) => rollCode)).toEqual([
      fixture.clientV1.rollCode,
      fixture.clientV2.rollCode,
      fixture.stock.rollCode,
      fixture.manual.rollCode,
      fixture.reserved.rollCode,
      fixture.inTransit.rollCode,
      fixture.processed.rollCode,
    ]);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual([...LIST_ITEM_KEYS].sort());
    }

    const byCode = new Map(page.items.map((item) => [item.rollCode, item]));
    expect(byCode.get(fixture.clientV1.rollCode)).toEqual({
      id: fixture.clientV1.id,
      rollCode: fixture.clientV1.rollCode,
      origin: 'client',
      lifecycleStatus: 'awaiting_shipment',
      lifecycleStatusLabel: 'Ожидает отгрузки',
      orderNumber: null,
      positionId: null,
      positionSequence: null,
      warehouseStatus: 'received',
      warehouseStatusLabel: 'Принят складом',
      nextRoute: 'delivery',
      nextRouteLabel: 'Выдача',
      counterpartyName: fixture.clientV1Name,
      batchCode: null,
      weightKg: 42.5,
      specification:
        'рукав · факт 80 мкм · учёт 78 мкм · ширина 1500 мм · метраж 300 м · ' +
        'вес 42.5 кг · шпуля 76 мм · бирка гост',
      receivedAt: fixture.clientV1.receivedAt,
      processedAt: null,
    } satisfies WarehouseInventoryRollItem);
    expect(byCode.get(fixture.clientV2.rollCode)).toEqual(
      expect.objectContaining({
        origin: 'client',
        lifecycleStatus: 'awaiting_shipment',
        lifecycleStatusLabel: 'Ожидает отгрузки',
        positionSequence: null,
        counterpartyName: fixture.clientV2Name,
      }),
    );
    expect(byCode.get(fixture.stock.rollCode)).toEqual(
      expect.objectContaining({
        origin: 'reserve',
        lifecycleStatus: 'available',
        lifecycleStatusLabel: 'Доступен',
        counterpartyName: 'Резерв',
        batchCode: fixture.batchCode,
      }),
    );
    expect(byCode.get(fixture.manual.rollCode)).toEqual({
      id: fixture.manual.id,
      rollCode: fixture.manual.rollCode,
      origin: 'reserve',
      lifecycleStatus: 'available',
      lifecycleStatusLabel: 'Доступен',
      orderNumber: null,
      positionId: null,
      positionSequence: null,
      warehouseStatus: 'received',
      warehouseStatusLabel: 'Принят складом',
      nextRoute: 'reserve',
      nextRouteLabel: 'Складской резерв',
      counterpartyName: 'Резерв',
      batchCode: null,
      weightKg: null,
      specification: 'Нет данных',
      receivedAt: fixture.manual.receivedAt,
      processedAt: null,
    } satisfies WarehouseInventoryRollItem);
    expect(byCode.get(fixture.reserved.rollCode)).toEqual(
      expect.objectContaining({
        lifecycleStatus: 'reserved',
        lifecycleStatusLabel: 'Зарезервирован',
      }),
    );
    expect(byCode.get(fixture.inTransit.rollCode)).toEqual(
      expect.objectContaining({
        lifecycleStatus: 'in_transit',
        lifecycleStatusLabel: 'В пути',
      }),
    );
    expect(byCode.get(fixture.processed.rollCode)).toEqual(
      expect.objectContaining({
        lifecycleStatus: 'processed',
        lifecycleStatusLabel: 'Обработан',
        processedAt: fixture.processed.processedAt,
      }),
    );
    expect(byCode.has(fixture.oldProcessed.rollCode)).toBe(false);
    expectSafeProjection(page, fixture.canaries);
  });

  it('returns exact detail and provenance for client, stock-reserve, and manual rolls', async () => {
    const client = (
      await http()
        .get(`/api/warehouse/inventory/rolls/${fixture.clientV2.id}`)
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollDetail;
    const stock = (
      await http()
        .get(`/api/warehouse/inventory/rolls/${fixture.stock.id}`)
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollDetail;
    const manual = (
      await http()
        .get(`/api/warehouse/inventory/rolls/${fixture.manual.id}`)
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollDetail;

    for (const detail of [client, stock, manual]) {
      expect(Object.keys(detail).sort()).toEqual(DETAIL_KEYS);
      expect(Object.keys(detail.specificationDetails).sort()).toEqual(
        [...SPECIFICATION_DETAIL_KEYS].sort(),
      );
      expect(Object.keys(detail.provenance).sort()).toEqual([...PROVENANCE_KEYS]);
      expectSafeProjection(detail, fixture.canaries);
    }
    expect(client.specificationDetails).toEqual({
      filmType: 'рукав',
      actualThicknessMicron: 80,
      accountingThicknessMicron: 78,
      widthMm: 1_500,
      plannedLengthM: 300,
      netKg: 42.5,
      spoolType: '76 мм',
      birka: 'гост',
      recipeName: 'Рецептура тестового рулона',
      ingredients: [`Материал ${fixture.prefix}`],
    });
    expect(client.provenance).toEqual({
      kind: 'client_order',
      orderNumber: fixture.clientV2OrderNumber,
      batchCode: null,
    });
    expect(stock.provenance).toEqual({
      kind: 'stock_reserve',
      orderNumber: fixture.stockOrderNumber,
      batchCode: fixture.batchCode,
    });
    expect(manual.specificationDetails).toEqual({
      filmType: null,
      actualThicknessMicron: null,
      accountingThicknessMicron: null,
      widthMm: null,
      plannedLengthM: null,
      netKg: null,
      spoolType: null,
      birka: null,
      recipeName: null,
      ingredients: [],
    });
    expect(manual.provenance).toEqual({
      kind: 'manual',
      orderNumber: null,
      batchCode: null,
    });
  });

  it('applies safe search, batch, status, and 90-day direct-detail boundaries', async () => {
    const byCounterparty = (
      await http()
        .get('/api/warehouse/inventory/rolls')
        .query({ q: fixture.clientV2Name, sort: 'rollCode', direction: 'asc' })
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollPage;
    expect(byCounterparty.items.map(({ rollCode }) => rollCode)).toEqual([
      fixture.clientV2.rollCode,
    ]);

    const byBatch = (
      await http()
        .get('/api/warehouse/inventory/rolls')
        .query({ batch: fixture.batchCode, status: 'available' })
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollPage;
    expect(byBatch.items.map(({ rollCode }) => rollCode)).toEqual([fixture.stock.rollCode]);

    const processed = (
      await http()
        .get('/api/warehouse/inventory/rolls')
        .query({ q: fixture.prefix, status: 'processed' })
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollPage;
    expect(processed.items.map(({ rollCode }) => rollCode)).toEqual([fixture.processed.rollCode]);

    const currentView = (
      await http()
        .get('/api/warehouse/inventory/rolls')
        .query({
          q: fixture.prefix,
          view: 'current',
          sort: 'rollCode',
          direction: 'asc',
          limit: 100,
        })
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollPage;
    expect(currentView.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rollCode: fixture.processed.rollCode,
          lifecycleStatus: 'processed',
          warehouseStatus: 'delivered',
          nextRoute: 'completed',
          processedAt: fixture.processed.processedAt,
        }),
      ]),
    );
    expect(currentView.items.map(({ rollCode }) => rollCode)).not.toContain(
      fixture.inTransit.rollCode,
    );
    expect(currentView.items).toHaveLength(6);

    const processedView = (
      await http()
        .get('/api/warehouse/inventory/rolls')
        .query({ q: fixture.prefix, view: 'processed', limit: 100 })
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollPage;
    expect(processedView.items.map(({ rollCode }) => rollCode)).toEqual([
      fixture.processed.rollCode,
    ]);

    await http()
      .get(`/api/warehouse/inventory/rolls/${fixture.oldProcessed.id}`)
      .set(auth.warehouse)
      .expect(404);
    await http()
      .get('/api/warehouse/inventory/rolls')
      .query({ status: 'raw_internal' })
      .set(auth.warehouse)
      .expect(400);
    await http()
      .get('/api/warehouse/inventory/rolls')
      .query({ view: 'all' })
      .set(auth.warehouse)
      .expect(400);
  });

  it.each(['asc', 'desc'] as const)(
    'returns each receivedAt tie and null row exactly once across %s cursor pages',
    async (direction) => {
      const actualIds: string[] = [];
      let cursor: string | undefined;
      let reachedLastPage = false;

      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const page = (
          await http()
            .get('/api/warehouse/inventory/rolls')
            .query({
              q: fixture.pagination.prefix,
              view: 'current',
              sort: 'receivedAt',
              direction,
              limit: 2,
              ...(cursor ? { cursor } : {}),
            })
            .set(auth.warehouse)
            .expect(200)
        ).body as WarehouseInventoryRollPage;

        expect(page.items).toHaveLength(page.nextCursor ? 2 : 1);
        actualIds.push(...page.items.map(({ id }) => id));
        if (!page.nextCursor) {
          reachedLastPage = true;
          break;
        }
        cursor = page.nextCursor;
      }

      const expectedIds =
        direction === 'asc' ? fixture.pagination.ascIds : fixture.pagination.descIds;
      expect(reachedLastPage).toBe(true);
      expect(actualIds).toEqual(expectedIds);
      expect(new Set(actualIds).size).toBe(actualIds.length);
    },
  );

  it('rejects a receivedAt cursor when its view or normalized filter fingerprint changes', async () => {
    const baseQuery = {
      q: fixture.pagination.prefix,
      view: 'current',
      sort: 'receivedAt',
      direction: 'asc',
      limit: 2,
    } as const;
    const firstPage = (
      await http()
        .get('/api/warehouse/inventory/rolls')
        .query(baseQuery)
        .set(auth.warehouse)
        .expect(200)
    ).body as WarehouseInventoryRollPage;
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    await http()
      .get('/api/warehouse/inventory/rolls')
      .query({ ...baseQuery, view: 'processed', cursor: firstPage.nextCursor })
      .set(auth.warehouse)
      .expect(400);
    await http()
      .get('/api/warehouse/inventory/rolls')
      .query({
        ...baseQuery,
        q: `${fixture.pagination.prefix}-changed`,
        cursor: firstPage.nextCursor,
      })
      .set(auth.warehouse)
      .expect(400);
  });

  it('keeps both legacy warehouse read endpoints compatible', async () => {
    const rolls = await http().get('/api/warehouse/rolls').set(auth.warehouse).expect(200);
    expect(
      (rolls.body as Array<{ rollCode: string }>).some(
        ({ rollCode }) => rollCode === fixture.clientV2.rollCode,
      ),
    ).toBe(true);
    const freeRolls = await http()
      .get('/api/warehouse/rolls')
      .query({ ownership: 'free' })
      .set(auth.warehouse)
      .expect(200);
    expect(Array.isArray(freeRolls.body)).toBe(true);

    const finishedStock = await http()
      .get('/api/warehouse/finished-stock')
      .query({ q: fixture.prefix, limit: 100 })
      .set(auth.warehouse)
      .expect(200);
    expect(
      (finishedStock.body.items as Array<{ rollCode: string }>).map(({ rollCode }) => rollCode),
    ).toContain(fixture.stock.rollCode);
  });
});
