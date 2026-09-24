import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { capabilitiesForRole, type Role } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY } from '../../common/audit/audit-actor';
import { WarehouseCoverageCommandService } from './warehouse-coverage-command.service';
import {
  WarehouseCoverageCalculationService,
  type LockedCoverageInput,
} from './warehouse-coverage-calculation.service';
import { COVERAGE_LOCKS_HELD, type CoverageLocksHeld } from './warehouse-coverage-transaction';
import { canonicalizeRollCoverageSpec, fingerprintRollFact } from './warehouse-coverage-canonical';

const ORDER_ID = 'order-1';
const FINANCE_ORDER_ID = 'finance-order-1';
const POSITION_ID = 'position-1';
const NOW = new Date('2026-07-25T09:00:00.000Z');

function actor(role: Role): Actor {
  return {
    userId: `${role}-1`,
    role,
    capabilities: capabilitiesForRole(role),
  };
}

function completeOrder() {
  return {
    id: ORDER_ID,
    version: 7,
    warehouseCoverageWorkflowVersion: 2,
    cancellationStatus: 'active' as const,
    counterpartyId: 'counterparty-1',
    positions: [
      {
        id: POSITION_ID,
        version: 3,
        rollCount: 1,
        filmType: 'Рукав',
        actualThickness: '80',
        accountingThickness: '80',
        widthMm: 1700,
        plannedLengthM: 275,
        birka: 'ГОСТ',
        spoolType: 'Шпуля 76 мм',
        plannedWeightKg: 100,
        baseRawMaterialDefinitionId: 'material-1',
        recipeDefinitionVersionId: null,
        recipe: {
          id: 'recipe-snapshot-1',
          version: 'v1',
          recipeDefinitionId: null,
          recipeDefinitionVersionId: null,
          recipeVersionNumber: null,
          ingredients: [
            {
              rawMaterialDefinitionId: 'material-1',
              name: 'Первичное',
              shareBasisPoints: 10_000,
            },
          ],
        },
      },
    ],
  };
}

function canonicalSpec(overrides: Record<string, unknown> = {}) {
  return {
    rollCode: 'READY-001',
    sourceOrderId: 'source-order-1',
    sourcePositionId: 'source-position-1',
    ownerCounterpartyId: 'counterparty-1',
    filmType: 'рукав',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 80_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: 'гост',
    spoolType: '76 мм',
    actualWeightMilliKg: 100_000,
    plannedWeightMilliKg: 100_000,
    recipeId: 'recipe-snapshot-source',
    recipeVersion: 'v1',
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    ingredients: [{ rawMaterialDefinitionId: 'material-1', shareBasisPoints: 10_000 }],
    policyVersion: 'warehouse-coverage-policy/v2',
    ...overrides,
  };
}

function financeMatch(rollCode: string, positionId: string) {
  return {
    positionId,
    position: {
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      widthMm: 1_200,
      plannedLengthM: 800,
      plannedWeightKg: 41,
      spoolType: 'Тонкая',
      birka: 'ГОСТ',
      baseRawMaterialDefinition: { name: 'ПВД первичный' },
      recipe: null,
      recipeDefinitionVersion: null,
    },
    coverageFact: {
      source: 'manual_platform',
      spec: canonicalSpec({
        rollCode,
        sourceOrderId: 'stock-order-1',
        sourcePositionId: 'stock-position-1',
        ownerCounterpartyId: null,
        actualThicknessMilliMicron: 80_000,
        accountingThicknessMilliMicron: 78_000,
        widthMilliMm: 1_200_000,
        plannedLengthMilliM: 800_000,
        actualWeightMilliKg: 41_200,
        plannedWeightMilliKg: 41_000,
        recipeVersion: 'ПВД первичный',
      }),
      sourceWeightCapture: null,
    },
    roll: {
      rollCode,
      warehouseStatus: 'received',
      positionSnapshot: {
        source: 'platform',
        grossMilliKg: 41_900,
        spoolMilliKg: 700,
        netMilliKg: 41_200,
        materialLabel: 'ПВД первичный',
        rawPayload: 'must-not-leak',
      },
      receivedAt: new Date('2026-08-06T01:00:00.000Z'),
      reservedForOrderId: null,
      reservedForPositionId: null,
      reservedByProposalId: null,
      reservedByCoverageDecisionId: null,
      producedForStockOrder: { stockBatchCode: 'ПАРТИЯ-08-06' },
    },
  };
}

function candidate(input?: {
  id?: string;
  ownerCounterpartyId?: string | null;
  producedForStockOrderId?: string | null;
  producedForOrderId?: string | null;
  sourceStockPositionIds?: readonly string[];
  factSourceOrderId?: string;
  factSourcePositionId?: string;
  spec?: Record<string, unknown> | null;
}) {
  const id = input?.id ?? 'roll-1';
  const spec = input?.spec === undefined ? canonicalSpec() : input.spec;
  let specFingerprint: string | null = null;
  if (spec !== null) {
    try {
      specFingerprint = fingerprintRollFact(canonicalizeRollCoverageSpec(spec));
    } catch {
      specFingerprint = 'd'.repeat(64);
    }
  }
  return {
    id,
    rollCode: typeof spec?.rollCode === 'string' ? spec.rollCode : 'READY-001',
    ownerCounterpartyId:
      input && 'ownerCounterpartyId' in input
        ? (input.ownerCounterpartyId ?? null)
        : 'counterparty-1',
    producedForStockOrderId: input?.producedForStockOrderId ?? null,
    producedForStockOrder: input?.producedForStockOrderId
      ? {
          requestType: 'stock_reserve',
          positions: (input.sourceStockPositionIds ?? ['stock-position-1']).map((id) => ({ id })),
        }
      : null,
    producedForOrderId: input?.producedForOrderId ?? null,
    warehouseStatus: 'received',
    reservedForOrderId: null,
    reservedForPositionId: null,
    reservedByProposalId: null,
    reservedByCoverageDecisionId: null,
    currentCoverageFactId: spec === null ? null : `fact-${id}`,
    currentCoverageFact:
      spec === null
        ? null
        : {
            id: `fact-${id}`,
            specVersion: 'warehouse-roll-coverage/v1',
            specFingerprint,
            spec,
            sourceOrderId: input?.factSourceOrderId ?? spec.sourceOrderId ?? null,
            sourcePositionId: input?.factSourcePositionId ?? spec.sourcePositionId ?? null,
          },
    coverageMemberships: [],
  };
}

function persistedCalculation(data: Record<string, unknown>, id = 'calculation-3') {
  return {
    id,
    calculatedAt: NOW,
    ...data,
  };
}

function safeFinanceProjection() {
  const emptySpec = {
    filmType: null,
    actualThicknessMicron: null,
    accountingThicknessMicron: null,
    widthMm: null,
    plannedLengthM: null,
    netKg: null,
    spoolType: null,
    birka: null,
    materialLabel: null,
  };
  return {
    workflowVersion: 2 as const,
    state: 'awaiting_finance' as const,
    stateVersion: 5,
    generation: 3,
    availability: 'verified_full' as const,
    reasonCodes: ['full_cover_available' as const],
    nextOwner: 'finance' as const,
    availableActions: [],
    requiredRollCount: 1,
    matchedRollCount: 1,
    uncertainRollCount: 0,
    calculatedAt: NOW.toISOString(),
    stale: false,
    financeRolls: [
      {
        rollCode: 'READY-001',
        positionId: POSITION_ID,
        source: 'legacy' as const,
        locationLabel: 'Свободный резерв',
        availability: 'available' as const,
        batchCode: null,
        receivedAt: null,
        grossKg: null,
        spoolKg: null,
        requested: { ...emptySpec },
        matched: { ...emptySpec },
      },
    ],
  };
}

function sqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join('?') : String(query);
}

function financeRefreshHarness(input: {
  state: string;
  decisionKind?: string | null;
  calculationEpoch?: bigint;
  currentEpoch?: bigint;
  productionOrderId?: string | null;
  cancellationStatus?: 'active' | 'cancelled';
  staleCasCount?: number;
}) {
  const safeResult = safeFinanceProjection();
  const currentDecisionId = input.decisionKind ? '00000000-0000-4000-8000-000000000002' : null;
  const state = {
    orderId: ORDER_ID,
    state: input.state,
    stateVersion: 4,
    generation: 2,
    currentCalculationId: 'calculation-2',
    currentDecisionId,
    currentCalculation: {
      inventoryEpoch: input.calculationEpoch ?? 16n,
    },
    currentDecision: input.decisionKind ? { kind: input.decisionKind } : null,
    order: {
      productionOrder: input.productionOrderId ? { id: input.productionOrderId } : null,
      cancellationStatus: input.cancellationStatus ?? 'active',
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const stateUpdateMany = jest.fn().mockResolvedValue({ count: input.staleCasCount ?? 1 });
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        sqlText(query).includes('FROM "warehouse_rolls" AS roll') ? [] : [{ id: 'locked-row' }],
      ),
    warehouseCoverageState: {
      findUnique: jest.fn().mockResolvedValue(state),
      updateMany: stateUpdateMany,
    },
    warehouseCoverageInventoryEpoch: {
      findUnique: jest.fn().mockResolvedValue({ epoch: input.currentEpoch ?? 17n }),
    },
    financeOrder: {
      findUnique: jest.fn().mockResolvedValue({ commercialOrderId: ORDER_ID }),
    },
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue(completeOrder()),
    },
  } as unknown as Prisma.TransactionClient;
  const commands = {
    acquireOrReplay: jest.fn().mockResolvedValue({ kind: 'new', commandId: 'command-1' }),
    appendFinal: jest.fn().mockResolvedValue(undefined),
  };
  const service = new WarehouseCoverageCalculationService(
    {
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue({
          commercialOrderId: ORDER_ID,
          commercialOrder: { warehouseCoverageWorkflowVersion: 2 },
        }),
      },
    } as never,
    { record: jest.fn() } as never,
    {
      run: jest.fn().mockImplementation((work) => work(tx, 1)),
    } as never,
    commands as never,
  );
  const calculate = jest
    .spyOn(service, 'calculateLocked')
    .mockResolvedValue({ calculationId: 'calculation-3', projection: safeResult });
  Object.assign(service, {
    readForFinanceLocked: jest.fn().mockResolvedValue(safeResult),
  });
  return {
    service,
    tx,
    state,
    stateUpdateMany,
    commands,
    calculate,
    safeResult,
  };
}

function lockProof(
  rollIds: readonly string[],
  overrides: Partial<CoverageLocksHeld> = {},
): CoverageLocksHeld {
  const acquiredLevels: CoverageLocksHeld['acquiredLevels'] = [
    'inventory_epoch',
    'coverage_state',
    'commercial_order',
    'current_calculation',
    'current_decision',
    ...(rollIds.length ? (['warehouse_rolls_binary'] as const) : []),
  ];
  return Object.freeze({
    [COVERAGE_LOCKS_HELD]: true as const,
    orderId: ORDER_ID,
    acquiredLevels: Object.freeze(acquiredLevels),
    rollIds: Object.freeze([...rollIds]),
    ...overrides,
  });
}

type HarnessOptions = {
  candidates?: ReturnType<typeof candidate>[];
  epochs?: bigint[];
  state?: Record<string, unknown>;
  workflowVersion?: number;
};

function calculationHarness(options: HarnessOptions = {}) {
  const rows = options.candidates ?? [candidate()];
  const epochReads = [...(options.epochs ?? [17n, 17n])];
  const state = {
    orderId: ORDER_ID,
    state: 'stale',
    stateVersion: 4,
    generation: 2,
    currentCalculationId: 'calculation-2',
    currentDecisionId: '00000000-0000-4000-8000-000000000002',
    createdAt: NOW,
    updatedAt: NOW,
    ...options.state,
  };
  const order = {
    ...completeOrder(),
    warehouseCoverageWorkflowVersion: options.workflowVersion ?? 2,
  };
  const calculationCreate = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve(persistedCalculation(data)),
  );
  const matchCreateMany = jest.fn().mockResolvedValue({ count: 1 });
  const decisionCreate = jest
    .fn()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...data, createdAt: NOW }),
    );
  const stateUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const tx = {
    warehouseCoverageInventoryEpoch: {
      findUnique: jest.fn().mockImplementation(async () => ({
        epoch: epochReads.shift() ?? 17n,
      })),
    },
    warehouseCoverageState: {
      findUnique: jest.fn().mockResolvedValue(state),
      updateMany: stateUpdateMany,
    },
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
    },
    financeOrder: {
      findUnique: jest.fn(),
    },
    warehouseRoll: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
    warehouseCoverageCalculation: { create: calculationCreate },
    warehouseCoverageMatch: { createMany: matchCreateMany, findMany: jest.fn() },
    warehouseCoverageDecision: { create: decisionCreate },
    productionOrder: { findUnique: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue(rows.map(({ id }) => ({ id }))),
  } as unknown as Prisma.TransactionClient;
  const transaction = { run: jest.fn() };
  const commands = new WarehouseCoverageCommandService();
  const prisma = {
    financeOrder: { findUnique: jest.fn() },
    warehouseCoverageInventoryEpoch: {
      findUnique: jest.fn().mockResolvedValue({ epoch: 17n }),
    },
  };
  const service = new WarehouseCoverageCalculationService(
    prisma as never,
    audit as never,
    transaction as never,
    commands,
  );
  const input: LockedCoverageInput = {
    commercialOrderId: ORDER_ID,
    expectedStateVersion: 4,
    expectedGeneration: 2,
  };
  return {
    service,
    tx,
    input,
    rows,
    state,
    order,
    audit,
    calculationCreate,
    matchCreateMany,
    decisionCreate,
    stateUpdateMany,
    prisma,
    transaction,
  };
}

describe('WarehouseCoverageCalculationService.calculateLocked', () => {
  it('publishes a verified generation only from the complete branded locked candidate set', async () => {
    const harness = calculationHarness();

    const result = await harness.service.calculateLocked(
      harness.tx,
      harness.input,
      lockProof(['roll-1']),
    );

    expect(result.projection).toMatchObject({
      workflowVersion: 2,
      generation: 3,
      availability: 'verified_full',
      state: 'awaiting_finance',
      matchedRollCount: 1,
    });
    expect(harness.matchCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          calculationId: 'calculation-3',
          orderId: ORDER_ID,
          generation: 3,
          positionId: POSITION_ID,
          rollId: 'roll-1',
          coverageFactId: 'fact-roll-1',
          slotIndex: 1,
        }),
      ],
    });
    expect(harness.stateUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        orderId: ORDER_ID,
        stateVersion: 4,
        generation: 2,
        currentCalculationId: 'calculation-2',
        currentDecisionId: '00000000-0000-4000-8000-000000000002',
      }),
      data: {
        state: 'awaiting_finance',
        stateVersion: { increment: 1 },
        generation: 3,
        currentCalculationId: 'calculation-3',
        currentDecisionId: null,
      },
    });
    expect(harness.audit.record).toHaveBeenCalledTimes(1);
    expect(harness.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_calculated',
        actor: {
          kind: 'system',
          systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
        },
        objectId: ORDER_ID,
      }),
      harness.tx,
    );
  });

  it('uses canonical company-owned stock as verified coverage for a client order', async () => {
    const stock = candidate({
      id: 'stock-roll-1',
      ownerCounterpartyId: null,
      producedForStockOrderId: 'stock-order-1',
      spec: canonicalSpec({
        rollCode: 'STOCK-S-1-001',
        sourceOrderId: 'stock-order-1',
        sourcePositionId: 'stock-position-1',
        ownerCounterpartyId: null,
      }),
    });
    const harness = calculationHarness({
      candidates: [stock],
      state: { currentDecisionId: null },
    });

    const result = await harness.service.calculateLocked(
      harness.tx,
      harness.input,
      lockProof(['stock-roll-1']),
    );

    expect(result.projection).toMatchObject({
      availability: 'verified_full',
      matchedRollCount: 1,
    });
    expect(harness.matchCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          rollId: 'stock-roll-1',
          coverageFactId: 'fact-stock-roll-1',
          positionId: POSITION_ID,
        }),
      ],
    });
  });

  it.each([
    {
      label: 'fact source order differs from the stock order',
      spec: canonicalSpec({
        rollCode: 'STOCK-S-1-001',
        sourceOrderId: 'other-stock-order',
        sourcePositionId: 'stock-position-1',
        ownerCounterpartyId: null,
      }),
      sourceStockPositionIds: ['stock-position-1'],
      factSourceOrderId: 'stock-order-1',
    },
    {
      label: 'fact source position does not belong to the stock order',
      spec: canonicalSpec({
        rollCode: 'STOCK-S-1-001',
        sourceOrderId: 'stock-order-1',
        sourcePositionId: 'other-stock-position',
        ownerCounterpartyId: null,
      }),
      sourceStockPositionIds: ['stock-position-1'],
      factSourcePositionId: 'stock-position-1',
    },
  ])(
    'fails closed when company-stock $label',
    async ({ spec, sourceStockPositionIds, factSourceOrderId, factSourcePositionId }) => {
      const inconsistentStock = candidate({
        id: 'stock-roll-1',
        ownerCounterpartyId: null,
        producedForStockOrderId: 'stock-order-1',
        sourceStockPositionIds,
        factSourceOrderId,
        factSourcePositionId,
        spec,
      });
      const harness = calculationHarness({
        candidates: [inconsistentStock],
        state: { currentDecisionId: null },
      });

      const result = await harness.service.calculateLocked(
        harness.tx,
        harness.input,
        lockProof(['stock-roll-1']),
      );

      expect(result.projection).toMatchObject({
        availability: 'unknown',
        matchedRollCount: 0,
        uncertainRollCount: 1,
      });
      expect(harness.matchCreateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'foreign factless roll',
      candidates: [] as ReturnType<typeof candidate>[],
      availability: 'unavailable',
      uncertainRollCount: 0,
    },
    {
      label: 'same-owner uncertain roll can close the order',
      candidates: [candidate({ spec: null })],
      availability: 'unknown',
      uncertainRollCount: 1,
    },
    {
      label: 'same-owner uncertain roll cannot close the order',
      candidates: [
        candidate({
          spec: {
            ...canonicalSpec(),
            actualThicknessMilliMicron: 200_000,
            policyVersion: 'unsupported-policy/v9',
          },
        }),
      ],
      availability: 'unavailable',
      uncertainRollCount: 0,
    },
  ])('limits $label to the order-scoped optimistic bound', async (fixture) => {
    const harness = calculationHarness({
      candidates: fixture.candidates,
      state: { currentDecisionId: null },
    });
    const result = await harness.service.calculateLocked(
      harness.tx,
      harness.input,
      lockProof(fixture.candidates.map(({ id }) => id)),
    );

    expect(result.projection.availability).toBe(fixture.availability);
    expect(harness.calculationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        uncertainRollCount: fixture.uncertainRollCount,
      }),
    });
    if (fixture.availability !== 'verified_full') {
      expect(harness.matchCreateMany).not.toHaveBeenCalled();
    }
  });

  it('fails closed when the mutable roll code diverges from its current immutable fact', async () => {
    const mismatched = {
      ...candidate(),
      rollCode: 'RENAMED-001',
    };
    const harness = calculationHarness({
      candidates: [mismatched],
      state: { currentDecisionId: null },
    });

    const result = await harness.service.calculateLocked(
      harness.tx,
      harness.input,
      lockProof(['roll-1']),
    );

    expect(result.projection).toMatchObject({
      availability: 'unknown',
      reasonCodes: ['roll_facts_incomplete'],
      uncertainRollCount: 1,
    });
    expect(harness.matchCreateMany).not.toHaveBeenCalled();
  });

  it('never treats a client-produced roll as free coverage inventory', async () => {
    const produced = candidate({ producedForOrderId: 'another-client-order' });
    const harness = calculationHarness({
      candidates: [produced],
      state: { currentDecisionId: null },
    });

    const result = await harness.service.calculateLocked(
      harness.tx,
      harness.input,
      lockProof([produced.id]),
    );

    expect(result.projection).toMatchObject({
      availability: 'unavailable',
      matchedRollCount: 0,
      uncertainRollCount: 0,
    });
    expect(harness.matchCreateMany).not.toHaveBeenCalled();
  });

  it('persists an immutable system auto decision for unavailable and no decision for unknown', async () => {
    const unavailable = calculationHarness({
      candidates: [],
      state: { currentDecisionId: null },
    });
    const unavailableResult = await unavailable.service.calculateLocked(
      unavailable.tx,
      unavailable.input,
      lockProof([]),
    );

    expect(unavailableResult.projection.state).toBe('production_required');
    expect(unavailable.decisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: ORDER_ID,
        calculationId: 'calculation-3',
        generation: 3,
        kind: 'auto_produce_all',
        actorKind: 'system',
        actorRole: null,
        actorId: null,
        systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      }),
    });
    expect(unavailable.audit.record).toHaveBeenCalledTimes(2);

    const unknown = calculationHarness({
      candidates: [candidate({ spec: null })],
      state: { currentDecisionId: null },
    });
    const unknownResult = await unknown.service.calculateLocked(
      unknown.tx,
      unknown.input,
      lockProof(['roll-1']),
    );
    expect(unknownResult.projection.state).toBe('unknown');
    expect(unknownResult.projection).toMatchObject({
      reasonCodes: ['roll_facts_incomplete'],
      nextOwner: 'finance',
      availableActions: [],
    });
    expect(unknown.decisionCreate).not.toHaveBeenCalled();
    expect(unknown.audit.record).toHaveBeenCalledTimes(1);
  });

  it('rolls back publication when the locked epoch differs immediately before append', async () => {
    const harness = calculationHarness({ epochs: [9n, 10n] });

    await expect(
      harness.service.calculateLocked(harness.tx, harness.input, lockProof(['roll-1'])),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'inventory_changed' }),
    });
    expect(harness.calculationCreate).not.toHaveBeenCalled();
    expect(harness.matchCreateMany).not.toHaveBeenCalled();
    expect(harness.stateUpdateMany).not.toHaveBeenCalled();
    expect(harness.audit.record).not.toHaveBeenCalled();
  });

  it('rejects wrong-order, incomplete, forged, and non-binary lock proofs before append', async () => {
    const harness = calculationHarness({
      candidates: [candidate({ id: 'roll-b' }), candidate({ id: 'roll-a' })],
    });
    const attempts = [
      {} as CoverageLocksHeld,
      lockProof(['roll-a', 'roll-b'], { orderId: 'another-order' }),
      lockProof(['roll-a']),
      lockProof(['roll-b', 'roll-a']),
    ];

    for (const locks of attempts) {
      await expect(
        harness.service.calculateLocked(harness.tx, harness.input, locks),
      ).rejects.toBeInstanceOf(ConflictException);
    }
    expect(harness.calculationCreate).not.toHaveBeenCalled();
  });

  it('never reads RawMaterialStock as a ready-roll candidate', async () => {
    const harness = calculationHarness({ candidates: [], state: { currentDecisionId: null } });
    Object.assign(harness.tx, {
      rawMaterialStock: {
        findMany: jest.fn(() => {
          throw new Error('raw material stock must not be queried');
        }),
      },
    });

    await expect(
      harness.service.calculateLocked(harness.tx, harness.input, lockProof([])),
    ).resolves.toMatchObject({
      projection: { availability: 'unavailable' },
    });
    expect(
      (harness.tx as never as { rawMaterialStock: { findMany: jest.Mock } }).rawMaterialStock
        .findMany,
    ).not.toHaveBeenCalled();
  });
});

describe('WarehouseCoverageCalculationService finance boundary', () => {
  it('rejects missing capability and resolves only an exact FinanceOrder id', async () => {
    const harness = calculationHarness();
    harness.prisma.financeOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: FINANCE_ORDER_ID,
      commercialOrderId: ORDER_ID,
      commercialOrder: {
        ...completeOrder(),
        coverageState: null,
        productionOrder: null,
      },
    });

    await expect(
      harness.service.readForFinance(actor('warehouse'), FINANCE_ORDER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(harness.service.readForFinance(actor('finance'), ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(harness.prisma.financeOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ORDER_ID } }),
    );
  });

  it('returns only binary-sorted matched roll codes in the protected finance extension', async () => {
    const harness = calculationHarness();
    const calculation = persistedCalculation({
      orderId: ORDER_ID,
      generation: 3,
      orderVersion: 7,
      positionVersions: [],
      orderFingerprint: 'a'.repeat(64),
      inventoryEpoch: 17n,
      inventoryFingerprint: 'b'.repeat(64),
      inputFingerprint: 'c'.repeat(64),
      algorithmVersion: 'warehouse-coverage-matching/v1',
      policyVersion: 'warehouse-coverage-policy/v2',
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      requiredRollCount: 2,
      matchedRollCount: 2,
      uncertainRollCount: 0,
      verifiedCandidateRollIds: ['private-roll-a', 'private-roll-b'],
      uncertainCandidateRollIds: [],
      systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      matches: [financeMatch('READY-002', 'position-b'), financeMatch('READY-001', 'position-a')],
    });
    harness.prisma.financeOrder.findUnique.mockResolvedValue({
      id: FINANCE_ORDER_ID,
      commercialOrderId: ORDER_ID,
      commercialOrder: {
        id: ORDER_ID,
        warehouseCoverageWorkflowVersion: 2,
        cancellationStatus: 'active',
        coverageState: {
          ...harness.state,
          state: 'awaiting_finance',
          stateVersion: 5,
          generation: 3,
          currentCalculationId: 'calculation-3',
          currentDecisionId: null,
          currentCalculation: calculation,
          currentDecision: null,
        },
        productionOrder: null,
      },
    });

    const result = await harness.service.readForFinance(actor('finance'), FINANCE_ORDER_ID);

    expect(result.financeRolls).toEqual([
      {
        rollCode: 'READY-001',
        positionId: 'position-a',
        source: 'platform',
        locationLabel: 'Свободный резерв',
        availability: 'available',
        batchCode: 'ПАРТИЯ-08-06',
        receivedAt: '2026-08-06T01:00:00.000Z',
        grossKg: 41.9,
        spoolKg: 0.7,
        requested: {
          filmType: 'Рукав',
          actualThicknessMicron: 80,
          accountingThicknessMicron: 78,
          widthMm: 1_200,
          plannedLengthM: 800,
          netKg: 41,
          spoolType: 'Тонкая',
          birka: 'ГОСТ',
          materialLabel: 'ПВД первичный',
        },
        matched: {
          filmType: 'рукав',
          actualThicknessMicron: 80,
          accountingThicknessMicron: 78,
          widthMm: 1_200,
          plannedLengthM: 800,
          netKg: 41.2,
          spoolType: '76 мм',
          birka: 'гост',
          materialLabel: 'ПВД первичный',
        },
      },
      expect.objectContaining({
        rollCode: 'READY-002',
        positionId: 'position-b',
        source: 'platform',
      }),
    ]);
    expect(Object.keys(result.financeRolls[0]!).sort()).toEqual(
      [
        'availability',
        'batchCode',
        'grossKg',
        'locationLabel',
        'matched',
        'positionId',
        'receivedAt',
        'requested',
        'rollCode',
        'source',
        'spoolKg',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain('private-roll-');
    expect(JSON.stringify(result)).not.toContain('specFingerprint');
    expect(JSON.stringify(result)).not.toContain('ownerCounterpartyId');
    expect(JSON.stringify(result)).not.toContain('rawPayload');
  });

  it('does not leak mutable roll codes from a stale verified generation', async () => {
    const harness = calculationHarness();
    harness.prisma.warehouseCoverageInventoryEpoch.findUnique.mockResolvedValue({
      epoch: 18n,
    });
    harness.prisma.financeOrder.findUnique.mockResolvedValue({
      id: FINANCE_ORDER_ID,
      commercialOrderId: ORDER_ID,
      commercialOrder: {
        id: ORDER_ID,
        warehouseCoverageWorkflowVersion: 2,
        cancellationStatus: 'active',
        coverageState: {
          ...harness.state,
          state: 'awaiting_finance',
          stateVersion: 5,
          generation: 3,
          currentCalculationId: 'calculation-3',
          currentDecisionId: null,
          currentCalculation: persistedCalculation({
            orderId: ORDER_ID,
            generation: 3,
            orderVersion: 7,
            positionVersions: [],
            orderFingerprint: 'a'.repeat(64),
            inventoryEpoch: 17n,
            inventoryFingerprint: 'b'.repeat(64),
            inputFingerprint: 'c'.repeat(64),
            algorithmVersion: 'warehouse-coverage-matching/v1',
            policyVersion: 'warehouse-coverage-policy/v2',
            availability: 'verified_full',
            reasonCodes: ['full_cover_available'],
            requiredRollCount: 1,
            matchedRollCount: 1,
            uncertainRollCount: 0,
            verifiedCandidateRollIds: ['private-roll-a'],
            uncertainCandidateRollIds: [],
            systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
            matches: [
              {
                positionId: 'position-a',
                roll: { rollCode: 'RENAMED-MUTABLE-CODE' },
              },
            ],
          }),
          currentDecision: null,
        },
        productionOrder: null,
      },
    });

    const result = await harness.service.readForFinance(actor('finance'), FINANCE_ORDER_ID);

    expect(result).toMatchObject({ stale: true, financeRolls: [] });
    expect(JSON.stringify(result)).not.toContain('RENAMED-MUTABLE-CODE');
  });

  it('exposes a capability-gated transaction-bound finance projector for owning commands', async () => {
    const harness = calculationHarness();
    const financeOrder = {
      id: FINANCE_ORDER_ID,
      commercialOrderId: ORDER_ID,
      commercialOrder: {
        id: ORDER_ID,
        warehouseCoverageWorkflowVersion: 2,
        cancellationStatus: 'active',
        coverageState: null,
        productionOrder: null,
      },
    };
    const financeFind = (
      harness.tx as unknown as {
        financeOrder: { findUnique: jest.Mock };
      }
    ).financeOrder.findUnique;
    financeFind.mockResolvedValue(financeOrder);

    await expect(
      harness.service.readForFinanceLocked(harness.tx, actor('warehouse'), FINANCE_ORDER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(financeFind).not.toHaveBeenCalled();

    await expect(
      harness.service.readForFinanceLocked(harness.tx, actor('finance'), FINANCE_ORDER_ID),
    ).resolves.toMatchObject({
      state: 'calculating',
      financeRolls: [],
    });
    expect(financeFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FINANCE_ORDER_ID } }),
    );
  });

  it('routes a factless same-owner unknown to finance recheck without a false policy error', async () => {
    const harness = calculationHarness();
    const calculation = persistedCalculation({
      orderId: ORDER_ID,
      generation: 3,
      orderVersion: 7,
      positionVersions: [],
      orderFingerprint: 'a'.repeat(64),
      inventoryEpoch: 17n,
      inventoryFingerprint: 'b'.repeat(64),
      inputFingerprint: 'c'.repeat(64),
      algorithmVersion: 'warehouse-coverage-matching/v1',
      policyVersion: 'warehouse-coverage-policy/v2',
      availability: 'unknown',
      reasonCodes: ['roll_facts_incomplete'],
      requiredRollCount: 1,
      matchedRollCount: 0,
      uncertainRollCount: 1,
      verifiedCandidateRollIds: [],
      uncertainCandidateRollIds: ['private-roll-a'],
      systemActorKey: WAREHOUSE_COVERAGE_SYSTEM_ACTOR_KEY,
      matches: [],
    });
    harness.prisma.financeOrder.findUnique.mockResolvedValue({
      id: FINANCE_ORDER_ID,
      commercialOrderId: ORDER_ID,
      commercialOrder: {
        id: ORDER_ID,
        warehouseCoverageWorkflowVersion: 2,
        cancellationStatus: 'active',
        coverageState: {
          ...harness.state,
          state: 'unknown',
          stateVersion: 5,
          generation: 3,
          currentCalculationId: 'calculation-3',
          currentDecisionId: null,
          currentCalculation: calculation,
          currentDecision: null,
        },
        productionOrder: null,
      },
    });

    await expect(
      harness.service.readForFinance(actor('finance'), FINANCE_ORDER_ID),
    ).resolves.toMatchObject({
      state: 'unknown',
      reasonCodes: ['roll_facts_incomplete'],
      nextOwner: 'finance',
      availableActions: ['request_recheck'],
    });
  });

  it('rejects V1 refresh before transaction, command journal, state, or audit mutation', async () => {
    const harness = calculationHarness();
    harness.prisma.financeOrder.findUnique.mockResolvedValue({
      id: FINANCE_ORDER_ID,
      commercialOrderId: ORDER_ID,
      commercialOrder: {
        id: ORDER_ID,
        warehouseCoverageWorkflowVersion: 1,
      },
    });

    await expect(
      harness.service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId: '00000000-0000-4000-8000-000000000010',
        expectedGeneration: 2,
        expectedStateVersion: 4,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_workflow_mismatch',
        expected: 2,
        actual: 1,
      }),
    });
    expect(harness.transaction.run).not.toHaveBeenCalled();
    expect(harness.audit.record).not.toHaveBeenCalled();
  });
});

describe('WarehouseCoverageCalculationService refresh orchestration', () => {
  const clientRequestId = '00000000-0000-4000-8000-000000000010';

  it('acquires the command before freshness, discovers candidates after the epoch lock, and journals last', async () => {
    const trace: string[] = [];
    let epochLocked = false;
    const safeResult = safeFinanceProjection();
    const state = {
      orderId: ORDER_ID,
      state: 'awaiting_finance',
      stateVersion: 4,
      generation: 2,
      currentCalculationId: 'calculation-2',
      currentDecisionId: null,
      currentCalculation: { inventoryEpoch: 16n },
      currentDecision: null,
      order: { cancellationStatus: 'active', productionOrder: null },
      createdAt: NOW,
      updatedAt: NOW,
    };
    let stateRead = 0;
    const tx = {
      $executeRaw: jest.fn().mockImplementation(async () => {
        trace.push('command-advisory');
        return 1;
      }),
      $queryRaw: jest.fn().mockImplementation(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes('warehouse_coverage_inventory_epochs')) {
          trace.push('inventory-epoch');
          epochLocked = true;
          return [{ id: 1 }];
        }
        if (text.includes('SELECT "orderId" FROM "warehouse_coverage_states"')) {
          trace.push('coverage-state-lock');
          return [{ orderId: ORDER_ID }];
        }
        if (text.includes('SELECT "id" FROM "commercial_orders"')) {
          trace.push('commercial-order-lock');
          return [{ id: ORDER_ID }];
        }
        if (text.includes('SELECT calculation."id"')) {
          trace.push('current-calculation-lock');
          return [{ id: 'calculation-2' }];
        }
        if (text.includes('FROM "warehouse_rolls" AS roll')) {
          expect(epochLocked).toBe(true);
          expect(text).toContain('roll."producedForOrderId" IS NULL');
          trace.push('candidate-resolve');
          return [{ id: 'roll-added-after-route-read' }];
        }
        if (text.includes('SELECT "id" FROM "warehouse_rolls"')) {
          trace.push('warehouse-roll-lock');
          return [{ id: 'roll-added-after-route-read' }];
        }
        throw new Error(`Unexpected lock query: ${text}`);
      }),
      warehouseCoverageCommand: {
        findUnique: jest.fn().mockImplementation(async () => {
          trace.push('command-read');
          return null;
        }),
        create: jest.fn().mockImplementation(async () => {
          trace.push('journal-append');
          return { id: 'command-1' };
        }),
      },
      warehouseCoverageState: {
        findUnique: jest.fn().mockImplementation(async () => {
          stateRead += 1;
          trace.push(stateRead === 1 ? 'state-reference' : 'state-under-lock');
          return state;
        }),
      },
      warehouseCoverageInventoryEpoch: {
        findUnique: jest.fn().mockImplementation(async () => {
          trace.push('current-epoch-read');
          return { epoch: 17n };
        }),
      },
      financeOrder: {
        findUnique: jest.fn().mockImplementation(async () => {
          trace.push('finance-route-revalidated');
          return { commercialOrderId: ORDER_ID };
        }),
      },
      commercialOrder: {
        findUnique: jest.fn().mockImplementation(async () => {
          trace.push('order-read-under-lock');
          return completeOrder();
        }),
      },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      financeOrder: {
        findUnique: jest.fn().mockImplementation(async () => {
          trace.push('finance-route-discovery');
          return {
            commercialOrderId: ORDER_ID,
            commercialOrder: { warehouseCoverageWorkflowVersion: 2 },
          };
        }),
      },
    };
    const transaction = {
      run: jest.fn().mockImplementation(async (work) => {
        trace.push('transaction');
        return work(tx, 1);
      }),
    };
    const service = new WarehouseCoverageCalculationService(
      prisma as never,
      { record: jest.fn() } as never,
      transaction as never,
      new WarehouseCoverageCommandService(),
    );
    const calculate = jest
      .spyOn(service, 'calculateLocked')
      .mockImplementation(async (_tx, _input, locks) => {
        trace.push('calculate');
        expect(locks.rollIds).toEqual(['roll-added-after-route-read']);
        expect(locks.acquiredLevels).toEqual([
          'command_advisory_key',
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
          'current_calculation',
          'warehouse_rolls_binary',
        ]);
        return { calculationId: 'calculation-3', projection: safeResult };
      });
    Object.assign(service, {
      readForFinanceLocked: jest.fn().mockImplementation(async () => {
        trace.push('protected-read');
        return safeResult;
      }),
    });

    await expect(
      service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId,
        expectedGeneration: 2,
        expectedStateVersion: 4,
      }),
    ).resolves.toEqual(safeResult);

    expect(calculate).toHaveBeenCalledTimes(1);
    expect(trace).toEqual([
      'finance-route-discovery',
      'transaction',
      'command-advisory',
      'command-read',
      'state-reference',
      'inventory-epoch',
      'coverage-state-lock',
      'commercial-order-lock',
      'current-calculation-lock',
      'finance-route-revalidated',
      'order-read-under-lock',
      'candidate-resolve',
      'warehouse-roll-lock',
      'state-under-lock',
      'current-epoch-read',
      'calculate',
      'protected-read',
      'journal-append',
    ]);
  });

  it('returns a matching replay without freshness reads, locks, calculation, or append', async () => {
    const safeResult = safeFinanceProjection();
    const tx = {
      warehouseCoverageState: { findUnique: jest.fn() },
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
    };
    const commands = {
      acquireOrReplay: jest.fn().mockResolvedValue({
        kind: 'replay',
        resultReference: {
          kind: 'calculation',
          calculationId: 'calculation-3',
        },
        safeResult,
      }),
      appendFinal: jest.fn(),
    };
    const transaction = {
      run: jest.fn().mockImplementation((work) => work(tx, 1)),
    };
    const service = new WarehouseCoverageCalculationService(
      {
        financeOrder: {
          findUnique: jest.fn().mockResolvedValue({
            commercialOrderId: ORDER_ID,
            commercialOrder: { warehouseCoverageWorkflowVersion: 2 },
          }),
        },
      } as never,
      { record: jest.fn() } as never,
      transaction as never,
      commands as never,
    );
    const calculate = jest.spyOn(service, 'calculateLocked');

    await expect(
      service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId,
        expectedGeneration: 2,
        expectedStateVersion: 4,
      }),
    ).resolves.toEqual(safeResult);

    expect(commands.acquireOrReplay).toHaveBeenCalledTimes(1);
    expect(tx.warehouseCoverageState.findUnique).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(calculate).not.toHaveBeenCalled();
    expect(commands.appendFinal).not.toHaveBeenCalled();
  });

  it('fails closed on a divergent command key before freshness reads or mutation', async () => {
    const tx = {
      warehouseCoverageState: { findUnique: jest.fn() },
      $queryRaw: jest.fn(),
    };
    const commands = {
      acquireOrReplay: jest.fn().mockRejectedValue(
        new ConflictException({
          statusCode: 409,
          code: 'warehouse_coverage_command_key_conflict',
        }),
      ),
      appendFinal: jest.fn(),
    };
    const service = new WarehouseCoverageCalculationService(
      {
        financeOrder: {
          findUnique: jest.fn().mockResolvedValue({
            commercialOrderId: ORDER_ID,
            commercialOrder: { warehouseCoverageWorkflowVersion: 2 },
          }),
        },
      } as never,
      { record: jest.fn() } as never,
      {
        run: jest.fn().mockImplementation((work) => work(tx, 1)),
      } as never,
      commands as never,
    );
    const calculate = jest.spyOn(service, 'calculateLocked');

    await expect(
      service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId,
        expectedGeneration: 2,
        expectedStateVersion: 4,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_command_key_conflict',
      }),
    });

    expect(tx.warehouseCoverageState.findUnique).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(calculate).not.toHaveBeenCalled();
    expect(commands.appendFinal).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'open recheck',
      state: 'recheck_requested',
      decisionKind: null,
      productionOrderId: null,
    },
    {
      label: 'warehouse reservation',
      state: 'warehouse_reserved',
      decisionKind: 'use_warehouse',
      productionOrderId: null,
    },
    {
      label: 'explicit production decision',
      state: 'production_required',
      decisionKind: 'produce_all',
      productionOrderId: null,
    },
    {
      label: 'already-created production order',
      state: 'production_required',
      decisionKind: 'auto_produce_all',
      productionOrderId: 'production-order-1',
    },
    {
      label: 'order change with committed facts',
      state: 'order_spec_changed',
      decisionKind: 'auto_produce_all',
      productionOrderId: 'production-order-1',
    },
    {
      label: 'cancelled order-spec invalidation',
      state: 'order_spec_changed',
      decisionKind: null,
      productionOrderId: null,
      cancellationStatus: 'cancelled' as const,
    },
    {
      label: 'fresh calculation',
      state: 'awaiting_finance',
      decisionKind: null,
      productionOrderId: null,
      calculationEpoch: 17n,
      currentEpoch: 17n,
    },
  ])('does not overwrite $label through refresh', async (fixture) => {
    const harness = financeRefreshHarness(fixture);

    await expect(
      harness.service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId,
        expectedGeneration: 2,
        expectedStateVersion: 4,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_refresh_not_allowed',
      }),
    });

    expect(harness.calculate).not.toHaveBeenCalled();
    expect(harness.stateUpdateMany).not.toHaveBeenCalled();
    expect(harness.commands.appendFinal).not.toHaveBeenCalled();
  });

  it('refreshes a decisionless order-spec invalidation at the same inventory epoch', async () => {
    const harness = financeRefreshHarness({
      state: 'order_spec_changed',
      decisionKind: null,
      calculationEpoch: 17n,
      currentEpoch: 17n,
    });

    await expect(
      harness.service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId,
        expectedGeneration: 2,
        expectedStateVersion: 4,
      }),
    ).resolves.toEqual(harness.safeResult);

    expect(harness.stateUpdateMany).not.toHaveBeenCalled();
    expect(harness.calculate).toHaveBeenCalledWith(
      harness.tx,
      {
        commercialOrderId: ORDER_ID,
        expectedStateVersion: 4,
        expectedGeneration: 2,
      },
      expect.objectContaining({
        orderId: ORDER_ID,
        acquiredLevels: expect.arrayContaining([
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
          'current_calculation',
        ]),
      }),
    );
    expect(harness.commands.appendFinal).toHaveBeenCalledTimes(1);
  });

  it('legally marks a stale auto decision before replacing its generation', async () => {
    const harness = financeRefreshHarness({
      state: 'production_required',
      decisionKind: 'auto_produce_all',
      calculationEpoch: 16n,
      currentEpoch: 17n,
    });

    await expect(
      harness.service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId,
        expectedGeneration: 2,
        expectedStateVersion: 4,
      }),
    ).resolves.toEqual(harness.safeResult);

    expect(harness.stateUpdateMany).toHaveBeenCalledWith({
      where: {
        orderId: ORDER_ID,
        state: 'production_required',
        stateVersion: 4,
        generation: 2,
        currentCalculationId: 'calculation-2',
        currentDecisionId: '00000000-0000-4000-8000-000000000002',
      },
      data: {
        state: 'stale',
        stateVersion: { increment: 1 },
      },
    });
    expect(harness.calculate).toHaveBeenCalledWith(
      harness.tx,
      {
        commercialOrderId: ORDER_ID,
        expectedStateVersion: 5,
        expectedGeneration: 2,
      },
      expect.objectContaining({
        orderId: ORDER_ID,
        acquiredLevels: expect.arrayContaining([
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
          'current_calculation',
          'current_decision',
        ]),
      }),
    );
    expect(harness.commands.appendFinal).toHaveBeenCalledTimes(1);
  });

  it('publishes the missing initial generation through nullable refresh CAS', async () => {
    const harness = financeRefreshHarness({
      state: 'calculating',
      decisionKind: null,
    });
    Object.assign(harness.state, {
      generation: 0,
      currentCalculationId: null,
      currentDecisionId: null,
      currentCalculation: null,
      currentDecision: null,
    });

    await expect(
      harness.service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId,
        expectedGeneration: null,
        expectedStateVersion: 4,
      }),
    ).resolves.toEqual(harness.safeResult);

    expect(harness.calculate).toHaveBeenCalledWith(
      harness.tx,
      {
        commercialOrderId: ORDER_ID,
        expectedStateVersion: 4,
        expectedGeneration: null,
      },
      expect.objectContaining({
        acquiredLevels: [
          'command_advisory_key',
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
        ],
      }),
    );
    expect(harness.stateUpdateMany).not.toHaveBeenCalled();
    expect(harness.commands.appendFinal).toHaveBeenCalledTimes(1);
  });

  it('does not calculate or journal when the stale-state CAS loses', async () => {
    const harness = financeRefreshHarness({
      state: 'production_required',
      decisionKind: 'auto_produce_all',
      calculationEpoch: 16n,
      currentEpoch: 17n,
      staleCasCount: 0,
    });

    await expect(
      harness.service.refreshForFinance(actor('finance'), FINANCE_ORDER_ID, {
        clientRequestId,
        expectedGeneration: 2,
        expectedStateVersion: 4,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_state_conflict',
      }),
    });
    expect(harness.calculate).not.toHaveBeenCalled();
    expect(harness.commands.appendFinal).not.toHaveBeenCalled();
  });
});

describe('WarehouseCoverageCalculationService fenced reads and initialization', () => {
  it('retries an epoch-churned finance read and fails closed after the bounded attempt limit', async () => {
    const harness = calculationHarness();
    harness.prisma.financeOrder.findUnique.mockResolvedValue({
      id: FINANCE_ORDER_ID,
      commercialOrderId: ORDER_ID,
      commercialOrder: {
        id: ORDER_ID,
        warehouseCoverageWorkflowVersion: 2,
        cancellationStatus: 'active',
        coverageState: null,
        productionOrder: null,
      },
    });
    harness.prisma.warehouseCoverageInventoryEpoch.findUnique
      .mockReset()
      .mockResolvedValueOnce({ epoch: 1n })
      .mockResolvedValueOnce({ epoch: 2n })
      .mockResolvedValueOnce({ epoch: 2n })
      .mockResolvedValueOnce({ epoch: 3n })
      .mockResolvedValueOnce({ epoch: 3n })
      .mockResolvedValueOnce({ epoch: 4n });

    await expect(
      harness.service.readForFinance(actor('finance'), FINANCE_ORDER_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_read_conflict',
      }),
    });
    expect(harness.prisma.financeOrder.findUnique).toHaveBeenCalledTimes(3);
  });

  it('returns the published generation idempotently after locked revalidation', async () => {
    const harness = calculationHarness();
    const lockTrace: string[] = [];
    (harness.tx.$queryRaw as jest.Mock).mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes('warehouse_coverage_inventory_epochs')) {
        lockTrace.push('inventory_epoch');
        return [{ id: 1 }];
      }
      if (text.includes('SELECT "orderId" FROM "warehouse_coverage_states"')) {
        lockTrace.push('coverage_state');
        return [{ orderId: ORDER_ID }];
      }
      if (text.includes('SELECT "id" FROM "commercial_orders"')) {
        lockTrace.push('commercial_order');
        return [{ id: ORDER_ID }];
      }
      if (text.includes('SELECT calculation."id"')) {
        lockTrace.push('current_calculation');
        return [{ id: 'calculation-2' }];
      }
      if (text.includes('SELECT decision."id"')) {
        lockTrace.push('current_decision');
        return [{ id: '00000000-0000-4000-8000-000000000002' }];
      }
      if (text.includes('FROM "warehouse_rolls" AS roll')) {
        lockTrace.push('candidate_resolve');
        return [{ id: 'roll-1' }];
      }
      if (text.includes('SELECT "id" FROM "warehouse_rolls"')) {
        lockTrace.push('warehouse_rolls_binary');
        return [{ id: 'roll-1' }];
      }
      throw new Error(`Unexpected initializer query: ${text}`);
    });
    const published = safeFinanceProjection();
    Object.assign(harness.service, {
      readProjectionUnderLock: jest.fn().mockResolvedValue(published),
    });
    const calculate = jest.spyOn(harness.service, 'calculateLocked');

    await expect(harness.service.initializeAtInvoiceHandoff(harness.tx, ORDER_ID)).resolves.toEqual(
      published,
    );
    await expect(harness.service.initializeAtInvoiceHandoff(harness.tx, ORDER_ID)).resolves.toEqual(
      published,
    );

    expect(calculate).not.toHaveBeenCalled();
    expect(lockTrace.slice(0, 7)).toEqual([
      'inventory_epoch',
      'coverage_state',
      'commercial_order',
      'current_calculation',
      'current_decision',
      'candidate_resolve',
      'warehouse_rolls_binary',
    ]);
  });

  it('revalidates workflow V2 only after the initializer has locked epoch, state, and order', async () => {
    const harness = calculationHarness({
      workflowVersion: 1,
      state: {
        generation: 0,
        currentCalculationId: null,
        currentDecisionId: null,
      },
    });
    const lockTrace: string[] = [];
    (harness.tx.$queryRaw as jest.Mock).mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes('warehouse_coverage_inventory_epochs')) {
        lockTrace.push('inventory_epoch');
        return [{ id: 1 }];
      }
      if (text.includes('SELECT "orderId" FROM "warehouse_coverage_states"')) {
        lockTrace.push('coverage_state');
        return [{ orderId: ORDER_ID }];
      }
      if (text.includes('SELECT "id" FROM "commercial_orders"')) {
        lockTrace.push('commercial_order');
        return [{ id: ORDER_ID }];
      }
      throw new Error(`Unexpected initializer query: ${text}`);
    });
    const calculate = jest.spyOn(harness.service, 'calculateLocked');

    await expect(
      harness.service.initializeAtInvoiceHandoff(harness.tx, ORDER_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_workflow_mismatch',
        expected: 2,
        actual: 1,
      }),
    });
    expect(lockTrace).toEqual(['inventory_epoch', 'coverage_state', 'commercial_order']);
    expect(calculate).not.toHaveBeenCalled();
  });

  it('rejects a specification that becomes incomplete under the invoice-handoff lock', async () => {
    const harness = calculationHarness({
      state: {
        generation: 0,
        currentCalculationId: null,
        currentDecisionId: null,
      },
    });
    const complete = completeOrder();
    (harness.tx.commercialOrder.findUnique as jest.Mock).mockResolvedValue({
      ...complete,
      positions: complete.positions.map((position) => ({
        ...position,
        birka: null,
      })),
    });
    const lockTrace: string[] = [];
    (harness.tx.$queryRaw as jest.Mock).mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes('warehouse_coverage_inventory_epochs')) {
        lockTrace.push('inventory_epoch');
        return [{ id: 1 }];
      }
      if (text.includes('SELECT "orderId" FROM "warehouse_coverage_states"')) {
        lockTrace.push('coverage_state');
        return [{ orderId: ORDER_ID }];
      }
      if (text.includes('SELECT "id" FROM "commercial_orders"')) {
        lockTrace.push('commercial_order');
        return [{ id: ORDER_ID }];
      }
      throw new Error(`Unexpected initializer query: ${text}`);
    });
    const calculate = jest.spyOn(harness.service, 'calculateLocked');

    await expect(
      harness.service.initializeAtInvoiceHandoff(harness.tx, ORDER_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'order_spec_incomplete',
        missing: ['positions[0].birka'],
      }),
    });
    expect(lockTrace).toEqual(['inventory_epoch', 'coverage_state', 'commercial_order']);
    expect(calculate).not.toHaveBeenCalled();
    expect(harness.calculationCreate).not.toHaveBeenCalled();
    expect(harness.stateUpdateMany).not.toHaveBeenCalled();
  });
});
