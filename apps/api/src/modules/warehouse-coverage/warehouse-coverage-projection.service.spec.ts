import type {
  WarehouseCoverageCalculation as PersistedCoverageCalculation,
  WarehouseCoverageState as PersistedCoverageState,
} from '@prisma/client';
import {
  REQUIRED_WAREHOUSE_COVERAGE_PROJECTION_FIELDS,
  capabilitiesForRole,
  type Capability,
  type Role,
  type WarehouseCoverageAvailability,
  type WarehouseCoverageReasonCode,
  type WarehouseCoverageState,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { WarehouseCoverageProjectionService } from './warehouse-coverage-projection.service';

const ORDER_ID = 'order-1';
const NOW = new Date('2026-07-25T08:30:00.000Z');

function actor(role: Role, capabilities: readonly Capability[] = capabilitiesForRole(role)): Actor {
  return { userId: `${role}-1`, role, capabilities };
}

function calculation(
  availability: WarehouseCoverageAvailability,
  reasonCodes: readonly WarehouseCoverageReasonCode[],
  overrides: Partial<PersistedCoverageCalculation> = {},
): PersistedCoverageCalculation {
  return {
    id: 'calculation-2',
    orderId: ORDER_ID,
    generation: 2,
    orderVersion: 7,
    positionVersions: [],
    orderFingerprint: 'a'.repeat(64),
    inventoryEpoch: 17n,
    inventoryFingerprint: 'b'.repeat(64),
    inputFingerprint: 'c'.repeat(64),
    algorithmVersion: 'warehouse-coverage-matching/v1',
    policyVersion: 'warehouse-coverage-policy/v2',
    availability,
    reasonCodes: [...reasonCodes],
    requiredRollCount: 4,
    matchedRollCount: availability === 'verified_full' ? 4 : 0,
    uncertainRollCount: availability === 'unknown' ? 2 : 0,
    verifiedCandidateRollIds: [],
    uncertainCandidateRollIds: [],
    systemActorKey: 'warehouse_coverage_engine',
    calculatedAt: NOW,
    ...overrides,
  };
}

function state(
  value: WarehouseCoverageState,
  overrides: Partial<PersistedCoverageState> = {},
): PersistedCoverageState {
  return {
    orderId: ORDER_ID,
    state: value,
    stateVersion: 5,
    generation: 2,
    currentCalculationId: 'calculation-2',
    currentDecisionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function loadedOrder(input?: {
  workflowVersion?: number;
  state?: WarehouseCoverageState;
  availability?: WarehouseCoverageAvailability;
  reasonCodes?: readonly WarehouseCoverageReasonCode[];
  inventoryEpoch?: bigint;
  productionOrderExists?: boolean;
  cancellationStatus?: 'active' | 'cancelled';
  taskStatus?: string | null;
  decisionKind?: 'use_warehouse' | 'produce_all' | 'auto_produce_all' | null;
}) {
  const workflowVersion = input?.workflowVersion ?? 2;
  const stateValue = input?.state ?? 'awaiting_finance';
  const availability = input?.availability ?? 'verified_full';
  const reasonCodes = input?.reasonCodes ?? ['full_cover_available'];
  const persistedCalculation =
    workflowVersion === 2
      ? calculation(availability, reasonCodes, {
          inventoryEpoch: input?.inventoryEpoch ?? 17n,
        })
      : null;
  const persistedState =
    workflowVersion === 2
      ? {
          ...state(stateValue),
          currentCalculation: persistedCalculation,
          currentDecision:
            input?.taskStatus === undefined && input?.decisionKind === undefined
              ? null
              : {
                  kind: input?.decisionKind ?? 'use_warehouse',
                  acceptanceTask: input?.taskStatus == null ? null : { status: input.taskStatus },
                },
        }
      : null;
  return {
    id: ORDER_ID,
    warehouseCoverageWorkflowVersion: workflowVersion,
    cancellationStatus: input?.cancellationStatus ?? 'active',
    coverageState: persistedState,
    productionOrder: input?.productionOrderExists ? { id: 'production-order-1' } : null,
  };
}

function loadedCommercialOrder(input?: {
  calculatedAt?: Date;
  inventoryEpoch?: bigint;
  matchedWeightMilliKg?: number;
  requestedRecipeName?: string;
  matchedRecipeName?: string;
}) {
  const calculatedAt = input?.calculatedAt ?? NOW;
  const currentCalculation = {
    ...calculation('verified_full', ['full_cover_available'], {
      inventoryEpoch: input?.inventoryEpoch ?? 17n,
      requiredRollCount: 1,
      matchedRollCount: 1,
      calculatedAt,
    }),
    matches: [
      {
        positionId: 'position-1',
        position: {
          id: 'position-1',
          rollCount: 1,
          filmType: 'ПНД',
          actualThickness: '60 мкм',
          accountingThickness: '62 мкм',
          widthMm: 1_000,
          plannedLengthM: 500,
          plannedWeightKg: 40,
          spoolType: 'Шпуля 76 мм',
          birka: 'Стандарт',
          baseRawMaterialDefinition: {
            id: 'material-1',
            name: 'ПНД',
          },
          recipe: {
            recipeName: input?.requestedRecipeName ?? 'ПНД базовый',
          },
          recipeDefinitionVersion: null,
        },
        coverageFact: {
          sourcePosition: {
            baseRawMaterialDefinition: {
              name: 'ПНД',
            },
            recipe: {
              recipeName: input?.matchedRecipeName ?? 'ПНД базовый',
            },
            recipeDefinitionVersion: null,
          },
          spec: {
            rollCode: 'roll-secret',
            sourceOrderId: 'source-order-secret',
            sourcePositionId: 'source-position-secret',
            ownerCounterpartyId: 'counterparty-1',
            filmType: 'пнд',
            actualThicknessMilliMicron: 60_000,
            accountingThicknessMilliMicron: 62_000,
            widthMilliMm: 1_000_000,
            plannedLengthMilliM: 500_000,
            birka: 'стандарт',
            spoolType: '76 мм',
            actualWeightMilliKg: input?.matchedWeightMilliKg ?? 39_500,
            plannedWeightMilliKg: 40_000,
            ingredients: [
              {
                rawMaterialDefinitionId: 'material-1',
                shareBasisPoints: 10_000,
              },
            ],
            recipeId: 'recipe-snapshot-1',
            recipeVersion: 'recipe-snapshot-version-1',
            recipeDefinitionId: null,
            recipeDefinitionVersionId: null,
            recipeVersionNumber: null,
            policyVersion: 'warehouse-coverage-policy/v2',
          },
        },
      },
    ],
  };
  return {
    id: ORDER_ID,
    warehouseCoverageWorkflowVersion: 2,
    cancellationStatus: 'active' as const,
    coverageState: {
      ...state('awaiting_finance', {
        currentCalculationId: currentCalculation.id,
        updatedAt: calculatedAt,
      }),
      currentCalculation,
      currentDecision: null,
    },
    productionOrder: null,
  };
}

function setup(order: ReturnType<typeof loadedOrder>, currentEpoch = 17n) {
  const forbiddenWrite = jest.fn(() => {
    throw new Error('projection read attempted a database write');
  });
  const prisma = {
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
      findMany: jest.fn().mockResolvedValue([order]),
      update: forbiddenWrite,
    },
    warehouseCoverageInventoryEpoch: {
      findUnique: jest.fn().mockResolvedValue({ epoch: currentEpoch }),
      update: forbiddenWrite,
    },
    warehouseCoverageState: { create: forbiddenWrite, update: forbiddenWrite },
    warehouseCoverageCalculation: { create: forbiddenWrite, update: forbiddenWrite },
    warehouseCoverageDecision: { create: forbiddenWrite, update: forbiddenWrite },
    warehouseCoverageCommand: { create: forbiddenWrite, update: forbiddenWrite },
    domainEvent: { create: forbiddenWrite, update: forbiddenWrite },
  } as unknown as PrismaService;
  return {
    service: new WarehouseCoverageProjectionService(prisma),
    forbiddenWrite,
    prisma,
  };
}

describe('WarehouseCoverageProjectionService', () => {
  it('projects many orders under one shared epoch fence', async () => {
    const first = loadedOrder();
    const second = { ...loadedOrder(), id: 'order-2' };
    const { service, prisma, forbiddenWrite } = setup(first);
    (prisma.commercialOrder.findMany as unknown as jest.Mock).mockResolvedValue([first, second]);

    const result = await service.readMany([ORDER_ID, 'order-2'], actor('production_lead'));

    expect([...result.keys()]).toEqual([ORDER_ID, 'order-2']);
    expect(prisma.commercialOrder.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.warehouseCoverageInventoryEpoch.findUnique).toHaveBeenCalledTimes(2);
    expect(forbiddenWrite).not.toHaveBeenCalled();
  });

  it('reads commercial type coverage from one epoch-fenced current calculation snapshot', async () => {
    const staleSnapshot = loadedCommercialOrder({
      calculatedAt: new Date('2026-08-06T08:00:00.000Z'),
      matchedWeightMilliKg: 38_000,
    });
    const currentSnapshot = loadedCommercialOrder({
      calculatedAt: new Date('2026-08-06T09:00:00.000Z'),
      inventoryEpoch: 18n,
      matchedWeightMilliKg: 41_000,
    });
    const { service, prisma } = setup(staleSnapshot);
    (prisma.commercialOrder.findUnique as unknown as jest.Mock)
      .mockResolvedValueOnce(staleSnapshot)
      .mockResolvedValueOnce(currentSnapshot);
    (prisma.warehouseCoverageInventoryEpoch.findUnique as unknown as jest.Mock)
      .mockResolvedValueOnce({ epoch: 17n })
      .mockResolvedValueOnce({ epoch: 18n })
      .mockResolvedValueOnce({ epoch: 18n })
      .mockResolvedValueOnce({ epoch: 18n });

    await expect(service.readForCommercial(ORDER_ID, actor('commercial'))).resolves.toMatchObject({
      calculatedAt: '2026-08-06T09:00:00.000Z',
      typeCoverage: [
        {
          positionId: 'position-1',
          requiredRollCount: 1,
          matchedRollCount: 1,
          requested: {
            ingredients: [{ name: 'ПНД', shareBasisPoints: 10_000 }],
          },
          matched: {
            weightKg: { min: 41, max: 41, total: 41 },
            ingredients: [{ name: 'ПНД', shareBasisPoints: 10_000 }],
          },
          comparison: {
            filmType: true,
            actualThickness: true,
            accountingThickness: true,
            width: true,
            plannedLength: true,
            weightTolerance: true,
            spoolType: true,
            birka: true,
            ingredients: true,
          },
        },
      ],
    });
    expect(prisma.commercialOrder.findUnique).toHaveBeenCalledTimes(2);
  });

  it('returns only role-safe grouped fields and leaves the ordinary read envelope unchanged', async () => {
    const order = loadedCommercialOrder();
    const { service } = setup(order);

    const commercial = await service.readForCommercial(ORDER_ID, actor('commercial'));
    const ordinary = await service.read(ORDER_ID, actor('commercial'));

    expect(Object.keys(ordinary).sort()).toEqual(
      [...REQUIRED_WAREHOUSE_COVERAGE_PROJECTION_FIELDS].sort(),
    );
    expect('typeCoverage' in ordinary).toBe(false);
    expect(JSON.stringify(commercial)).not.toMatch(
      /roll(Id|Code)|factId|calculationId|fingerprint|raw/iu,
    );
  });

  it('projects the matched recipe name from the warehouse fact source position', async () => {
    const order = loadedCommercialOrder({
      requestedRecipeName: 'Рецептура заказа',
      matchedRecipeName: 'Совместимая рецептура резерва',
    });
    const { service } = setup(order);

    await expect(service.readForCommercial(ORDER_ID, actor('commercial'))).resolves.toMatchObject({
      typeCoverage: [
        {
          requested: { recipeName: 'Рецептура заказа' },
          matched: { recipeName: 'Совместимая рецептура резерва' },
        },
      ],
    });
  });

  it('does not project fresh actions when the inventory epoch changes during the order read', async () => {
    const order = loadedOrder();
    const { service, forbiddenWrite, prisma } = setup(order);
    let currentEpoch = 17n;
    let epochReads = 0;
    let inventoryChanged = false;

    (prisma.commercialOrder.findUnique as unknown as jest.Mock).mockImplementation(async () => {
      await Promise.resolve();
      if (epochReads > 0 && !inventoryChanged) {
        currentEpoch = 18n;
        inventoryChanged = true;
      }
      return order;
    });
    (prisma.warehouseCoverageInventoryEpoch.findUnique as unknown as jest.Mock).mockImplementation(
      async () => {
        epochReads += 1;
        return { epoch: currentEpoch };
      },
    );

    await expect(service.read(ORDER_ID, actor('finance'))).resolves.toMatchObject({
      state: 'stale',
      stale: true,
      reasonCodes: ['inventory_changed'],
      availableActions: ['refresh'],
    });
    expect(forbiddenWrite).not.toHaveBeenCalled();
  });

  it('fails closed when the inventory epoch cannot stabilize for a bounded read', async () => {
    const { service, forbiddenWrite, prisma } = setup(loadedOrder());
    let currentEpoch = 17n;
    (prisma.warehouseCoverageInventoryEpoch.findUnique as unknown as jest.Mock).mockImplementation(
      async () => {
        currentEpoch += 1n;
        return { epoch: currentEpoch };
      },
    );

    await expect(service.read(ORDER_ID, actor('finance'))).rejects.toThrow(
      'Warehouse coverage projection invariant',
    );
    expect(forbiddenWrite).not.toHaveBeenCalled();
  });

  it('marks an epoch mismatch stale without refreshing or writing', async () => {
    const order = loadedOrder();
    const stateBefore = { ...order.coverageState };
    const calculationBefore = { ...order.coverageState?.currentCalculation };
    const { service, forbiddenWrite } = setup(order, 18n);

    await expect(service.read(ORDER_ID, actor('finance'))).resolves.toMatchObject({
      state: 'stale',
      stale: true,
      reasonCodes: ['inventory_changed'],
      nextOwner: 'system',
      availableActions: ['refresh'],
    });
    expect(forbiddenWrite).not.toHaveBeenCalled();
    expect(order.coverageState).toEqual(stateBefore);
    expect(order.coverageState?.currentCalculation).toEqual(calculationBefore);
  });

  it('returns only the exact safe projection envelope', async () => {
    const { service } = setup(loadedOrder());

    const projection = await service.read(ORDER_ID, actor('finance'));

    expect(Object.keys(projection).sort()).toEqual(
      [...REQUIRED_WAREHOUSE_COVERAGE_PROJECTION_FIELDS].sort(),
    );
    expect(JSON.stringify(projection)).not.toMatch(
      /fingerprint|candidateRoll|systemActorKey|currentCalculationId|currentDecisionId/u,
    );
  });

  it.each([
    {
      label: 'finance decision and recheck capabilities',
      role: 'finance',
      state: 'awaiting_finance',
      availability: 'verified_full',
      reasons: ['full_cover_available'],
      actions: ['use_warehouse', 'produce_all', 'request_recheck'],
    },
    {
      label: 'commercial order correction capability',
      role: 'commercial',
      state: 'unknown',
      availability: 'unknown',
      reasons: ['order_spec_incomplete'],
      actions: ['correct_order_spec'],
    },
    {
      label: 'warehouse recheck resolution capability',
      role: 'warehouse',
      state: 'recheck_requested',
      availability: 'unknown',
      reasons: ['roll_facts_incomplete'],
      actions: ['resolve_recheck'],
    },
    {
      label: 'director has no routine coverage capability',
      role: 'director',
      state: 'awaiting_finance',
      availability: 'verified_full',
      reasons: ['full_cover_available'],
      actions: [],
    },
    {
      label: 'operator has no routine coverage capability',
      role: 'operator',
      state: 'unknown',
      availability: 'unknown',
      reasons: ['roll_facts_incomplete'],
      actions: [],
    },
  ] as const)(
    'filters actions by actor capability for $label',
    async ({ role, state: stateValue, availability, reasons, actions }) => {
      const { service } = setup(
        loadedOrder({
          state: stateValue,
          availability,
          reasonCodes: reasons,
        }),
      );

      await expect(service.read(ORDER_ID, actor(role))).resolves.toMatchObject({
        availableActions: actions,
      });
    },
  );

  it('honours a capability denial even when the actor role is finance', async () => {
    const financeCapabilities = capabilitiesForRole('finance').filter(
      (capability) => capability !== 'warehouse_coverage:request_recheck',
    );
    const { service } = setup(loadedOrder());

    await expect(
      service.read(ORDER_ID, actor('finance', financeCapabilities)),
    ).resolves.toMatchObject({
      availableActions: ['use_warehouse', 'produce_all'],
    });
  });

  it('does not expose refresh for a cancelled order-spec invalidation', async () => {
    const order = loadedOrder({
      state: 'order_spec_changed',
      availability: 'unavailable',
      reasonCodes: ['no_compatible_rolls'],
      decisionKind: null,
      cancellationStatus: 'cancelled',
    });
    const { service } = setup(order);

    await expect(service.read(ORDER_ID, actor('finance'))).resolves.toMatchObject({
      state: 'order_spec_changed',
      stale: true,
      availableActions: [],
    });
  });

  it('offers request_recheck before production materialization and no action afterwards', async () => {
    const before = setup(
      loadedOrder({
        state: 'production_required',
        availability: 'unavailable',
        reasonCodes: ['no_compatible_rolls'],
        decisionKind: 'auto_produce_all',
      }),
    );
    const after = setup(
      loadedOrder({
        state: 'production_required',
        availability: 'unavailable',
        reasonCodes: ['no_compatible_rolls'],
        decisionKind: 'auto_produce_all',
        productionOrderExists: true,
      }),
    );

    await expect(before.service.read(ORDER_ID, actor('finance'))).resolves.toMatchObject({
      state: 'production_required',
      availableActions: ['request_recheck'],
    });
    await expect(after.service.read(ORDER_ID, actor('finance'))).resolves.toMatchObject({
      state: 'production_required',
      availableActions: [],
    });
  });

  it('does not expose refresh for an explicit produce-all decision after epoch churn', async () => {
    const { service } = setup(
      loadedOrder({
        state: 'production_required',
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        inventoryEpoch: 17n,
        decisionKind: 'produce_all',
      }),
      18n,
    );

    await expect(service.read(ORDER_ID, actor('finance'))).resolves.toMatchObject({
      state: 'production_required',
      stale: false,
      availableActions: [],
    });
  });

  it('returns the nullable zero-count V1 envelope without creating V2 state', async () => {
    const { service, forbiddenWrite } = setup(loadedOrder({ workflowVersion: 1 }));

    await expect(service.read(ORDER_ID, actor('commercial'))).resolves.toMatchObject({
      workflowVersion: 1,
      state: 'calculating',
      stateVersion: 0,
      generation: null,
      availability: null,
      requiredRollCount: 0,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      calculatedAt: null,
      availableActions: [],
    });
    expect(forbiddenWrite).not.toHaveBeenCalled();
  });

  it('fails closed when the current epoch singleton is unavailable', async () => {
    const { service, prisma } = setup(loadedOrder());
    (
      prisma.warehouseCoverageInventoryEpoch.findUnique as jest.MockedFunction<
        typeof prisma.warehouseCoverageInventoryEpoch.findUnique
      >
    ).mockResolvedValueOnce(null);

    await expect(service.read(ORDER_ID, actor('finance'))).rejects.toThrow(
      'Warehouse coverage projection invariant',
    );
  });
});
