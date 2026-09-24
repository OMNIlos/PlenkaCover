import { Prisma } from '@prisma/client';
import type { WarehouseCoverageProjection } from '@plenka/contracts';
import { COVERAGE_LOCKS_HELD } from './warehouse-coverage-transaction';
import * as coverageTransactionModule from './warehouse-coverage-transaction';
import { WarehouseCoverageProductionHandoffService } from './warehouse-coverage-production-handoff.service';

describe('WarehouseCoverageProductionHandoffService', () => {
  const actor = {
    userId: 'commercial-1',
    role: 'commercial' as const,
    capabilities: ['production_order:handoff' as const],
  };

  type TestState = {
    orderId: string;
    state: string;
    stateVersion: number;
    generation: number;
    currentCalculationId: string;
    currentDecisionId: string;
    currentCalculation: {
      id: string;
      orderId: string;
      generation: number;
      inventoryEpoch: bigint;
      inputFingerprint: string;
      availability: string;
      reasonCodes: string[];
      requiredRollCount: number;
      matchedRollCount: number;
      uncertainRollCount: number;
      calculatedAt: Date;
    };
    currentDecision: {
      id: string;
      orderId: string;
      calculationId: string;
      generation: number;
      kind: 'auto_produce_all' | 'produce_all';
      inputFingerprint: string;
    };
  };

  type TestProductionOrder = {
    id: string;
    commercialOrderId: string;
    sourceCoverageCalculationId: string | null;
    sourceCoverageDecisionId: string | null;
    sourceCoverageInputFingerprint: string | null;
    sourceCoverageGeneration: number | null;
  };

  function projection(
    availability: 'verified_full' | 'unavailable' | 'unknown',
    generation: number,
  ): WarehouseCoverageProjection {
    return {
      workflowVersion: 2,
      state:
        availability === 'verified_full'
          ? 'awaiting_finance'
          : availability === 'unavailable'
            ? 'production_required'
            : 'unknown',
      stateVersion: generation + 1,
      generation,
      availability,
      reasonCodes:
        availability === 'verified_full'
          ? ['full_cover_available']
          : availability === 'unavailable'
            ? ['no_compatible_rolls']
            : ['roll_facts_incomplete'],
      nextOwner: availability === 'verified_full' ? 'finance' : 'system',
      availableActions: [],
      requiredRollCount: 1,
      matchedRollCount: availability === 'verified_full' ? 1 : 0,
      uncertainRollCount: availability === 'unknown' ? 1 : 0,
      calculatedAt: '2026-07-25T00:00:00.000Z',
      stale: false,
    };
  }

  function harness(options?: {
    inventoryEpoch?: bigint;
    calculationEpoch?: bigint;
    decisionKind?: 'auto_produce_all' | 'produce_all';
    existingProductionOrder?: boolean;
    financeAllowed?: boolean;
  }) {
    const decisionKind = options?.decisionKind ?? 'auto_produce_all';
    const availability = decisionKind === 'produce_all' ? 'verified_full' : 'unavailable';
    let state: TestState = {
      orderId: 'order-1',
      state: 'production_required',
      stateVersion: 7,
      generation: 3,
      currentCalculationId: 'calculation-3',
      currentDecisionId: 'decision-3',
      currentCalculation: {
        id: 'calculation-3',
        orderId: 'order-1',
        generation: 3,
        inventoryEpoch: options?.calculationEpoch ?? 4n,
        inputFingerprint: 'a'.repeat(64),
        availability,
        reasonCodes:
          availability === 'verified_full' ? ['full_cover_available'] : ['no_compatible_rolls'],
        requiredRollCount: 1,
        matchedRollCount: availability === 'verified_full' ? 1 : 0,
        uncertainRollCount: 0,
        calculatedAt: new Date('2026-07-25T00:00:00.000Z'),
      },
      currentDecision: {
        id: 'decision-3',
        orderId: 'order-1',
        calculationId: 'calculation-3',
        generation: 3,
        kind: decisionKind,
        inputFingerprint: 'a'.repeat(64),
      },
    };
    let productionOrder: TestProductionOrder | null = options?.existingProductionOrder
      ? {
          id: 'production-existing',
          commercialOrderId: 'order-1',
          sourceCoverageCalculationId: 'calculation-3',
          sourceCoverageDecisionId: 'decision-3',
          sourceCoverageInputFingerprint: 'a'.repeat(64),
          sourceCoverageGeneration: 3,
        }
      : null;
    const commercialOrder = {
      id: 'order-1',
      orderNumber: 'A-11',
      warehouseCoverageWorkflowVersion: 2,
      cancellationStatus: 'active',
      commercialStage: 'in_work',
      financeOrder: {
        id: 'finance-order-1',
        commercialOrderId: 'order-1',
        productionClearedAt: null,
        invoiceStatus: 'invoiced',
        policy: null,
        paymentTermsType: 'prepay_50_postpay_50_30d',
        schedules: [
          {
            paymentPolicyStageId: null,
            kind: 'invoice_prepayment',
            status: options?.financeAllowed === false ? 'unpaid' : 'paid',
          },
        ],
      },
      positions: [
        {
          id: 'position-1',
          rollCount: 1,
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          rawMaterialId: 'legacy-material',
          baseRawMaterialDefinitionId: 'material-primary',
          recipeDefinitionVersionId: null,
          baseRawMaterialDefinition: {
            id: 'material-primary',
            name: 'Первичное',
            stock: { materialId: 'stock-primary' },
          },
          recipeDefinitionVersion: null,
          spoolType: '76 мм',
          birka: 'Белая',
          plannedWeightKg: 40,
          widthMm: 1700,
          plannedLengthM: 275,
          recipe: {
            version: 'v1',
            parameters: [{ label: 'План. вес, кг', value: '41,5' }],
            recipeDefinitionId: null,
            recipeDefinitionVersionId: null,
            recipeVersionNumber: null,
            recipeName: 'Первичное',
            ingredients: [
              {
                rawMaterialDefinitionId: 'material-primary',
                name: 'Первичное',
                shareBasisPoints: 10_000,
              },
            ],
          },
        },
      ],
    };
    const tx = {
      warehouseCoverageState: {
        findUnique: jest.fn(async (args?: { select?: { order?: unknown } }) =>
          args?.select?.order
            ? {
                currentCalculationId: state.currentCalculationId,
                currentDecisionId: state.currentDecisionId,
                order: {
                  warehouseCoverageWorkflowVersion: 2,
                  productionOrder,
                },
              }
            : state,
        ),
        updateMany: jest.fn(async () => {
          state = { ...state, state: 'stale', stateVersion: state.stateVersion + 1 };
          return { count: 1 };
        }),
      },
      warehouseCoverageInventoryEpoch: {
        findUnique: jest.fn().mockResolvedValue({ epoch: options?.inventoryEpoch ?? 4n }),
      },
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue(commercialOrder),
        update: jest.fn().mockResolvedValue(commercialOrder),
      },
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue(commercialOrder.financeOrder),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productionOrder: {
        findUnique: jest.fn(async () => productionOrder),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          productionOrder = {
            id: 'production-new',
            commercialOrderId: String(data.commercialOrderId),
            sourceCoverageCalculationId: String(data.sourceCoverageCalculationId),
            sourceCoverageDecisionId: String(data.sourceCoverageDecisionId),
            sourceCoverageInputFingerprint: String(data.sourceCoverageInputFingerprint),
            sourceCoverageGeneration: Number(data.sourceCoverageGeneration),
          };
          return productionOrder;
        }),
      },
      rollDispatchItem: {
        aggregate: jest.fn().mockResolvedValue({ _max: { queueRank: 5 } }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const transactionTrace: string[] = [];
    const coverageTransaction = {
      run: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
        transactionTrace.push('serializable_started');
        const result = await callback(tx);
        transactionTrace.push('serializable_callback_returned', 'transaction_committed');
        return result;
      }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const calculation = {
      calculateLocked: jest.fn(),
    };
    const fulfillment = {
      acquireDeliveryScopeLock: jest.fn().mockResolvedValue({}),
    };
    const locks = Object.freeze({
      [COVERAGE_LOCKS_HELD]: true as const,
      orderId: 'order-1',
      acquiredLevels: [
        'inventory_epoch',
        'coverage_state',
        'commercial_order',
        'current_calculation',
        'current_decision',
      ] as const,
      rollIds: [] as const,
    });
    jest.spyOn(coverageTransactionModule, 'lockCoverageResources').mockResolvedValue(locks);
    const prisma = {
      productionOrder: {
        findUnique: jest.fn(async () => productionOrder),
      },
    };
    const service = new WarehouseCoverageProductionHandoffService(
      prisma as never,
      audit as never,
      coverageTransaction as never,
      calculation as never,
      fulfillment as never,
    );
    return {
      service,
      tx,
      locks,
      audit,
      calculation,
      fulfillment,
      coverageTransaction,
      transactionTrace,
      replaceState(next: TestState) {
        state = next;
      },
      readState: () => state,
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('atomically refreshes a stale auto route and creates production for a proven shortage', async () => {
    const test = harness({ inventoryEpoch: 5n, calculationEpoch: 4n });
    test.calculation.calculateLocked.mockImplementation(async (_tx, _input) => {
      test.replaceState({
        ...test.readState(),
        state: 'production_required',
        stateVersion: 9,
        generation: 4,
        currentCalculationId: 'calculation-4',
        currentDecisionId: 'decision-4',
        currentCalculation: {
          ...test.readState().currentCalculation,
          id: 'calculation-4',
          generation: 4,
          inventoryEpoch: 5n,
          inputFingerprint: 'b'.repeat(64),
        },
        currentDecision: {
          ...test.readState().currentDecision,
          id: 'decision-4',
          calculationId: 'calculation-4',
          generation: 4,
          inputFingerprint: 'b'.repeat(64),
        },
      });
      return { calculationId: 'calculation-4', projection: projection('unavailable', 4) };
    });

    const result = await test.service.createV2ProductionOrder(actor, 'order-1');

    expect(result).toEqual({
      productionOrderId: 'production-new',
      sourceCalculationId: 'calculation-4',
      sourceDecisionId: 'decision-4',
      inputFingerprint: 'b'.repeat(64),
      generation: 4,
    });
    expect(test.coverageTransaction.run).toHaveBeenCalledTimes(1);
    expect(test.fulfillment.acquireDeliveryScopeLock).toHaveBeenCalledWith(test.tx, 'order-1');
    expect(test.calculation.calculateLocked).toHaveBeenCalledWith(
      test.tx,
      {
        commercialOrderId: 'order-1',
        expectedStateVersion: 8,
        expectedGeneration: 3,
      },
      test.locks,
    );
    expect(test.tx.productionOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commercialOrderId: 'order-1',
        sourceCoverageCalculationId: 'calculation-4',
        sourceCoverageDecisionId: 'decision-4',
        sourceCoverageInputFingerprint: 'b'.repeat(64),
        sourceCoverageGeneration: 4,
      }),
    });
    expect(test.tx.rollDispatchItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          productionOrderId: 'production-new',
          orderLineId: 'position-1',
          positionSequence: 1,
          plannedWeightKg: 41.5,
          widthMm: 1700,
          plannedLengthM: 275,
          characteristicsSnapshot: expect.objectContaining({
            widthMm: 1700,
            plannedLengthM: 275,
            plannedWeightKg: 41.5,
          }),
        }),
      ],
    });
    expect(test.tx.financeOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'finance-order-1', productionClearedAt: null },
      data: { productionClearedAt: expect.any(Date) },
    });
    expect(test.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:finance_production_cleared',
        objectId: 'finance-order-1',
      }),
      test.tx,
    );
    expect(test.transactionTrace).toEqual([
      'serializable_started',
      'serializable_callback_returned',
      'transaction_committed',
    ]);
  });

  it('rejects an oversized V2 roll expansion before creating production facts', async () => {
    const test = harness();
    const order = await test.tx.commercialOrder.findUnique();
    order.positions[0].rollCount = 2_001;
    test.tx.commercialOrder.findUnique.mockResolvedValue(order);

    await expect(test.service.createV2ProductionOrder(actor, 'order-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_ORDER_TOO_LARGE', maxRolls: 2_000 }),
    });
    expect(test.tx.productionOrder.create).not.toHaveBeenCalled();
    expect(test.tx.rollDispatchItem.createMany).not.toHaveBeenCalled();
    expect(test.audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['verified_full', 'awaiting_finance', 'warehouse_coverage_route_changed'],
    ['unknown', 'unknown', 'warehouse_coverage_blocked'],
  ] as const)(
    'returns the current non-production %s route before applying the roll cap',
    async (availability, state, code) => {
      const test = harness();
      const order = await test.tx.commercialOrder.findUnique();
      order.positions[0].rollCount = 2_001;
      test.tx.commercialOrder.findUnique.mockResolvedValue(order);
      test.replaceState({
        ...test.readState(),
        state,
        currentCalculation: {
          ...test.readState().currentCalculation,
          availability,
          reasonCodes:
            availability === 'verified_full' ? ['full_cover_available'] : ['roll_facts_incomplete'],
        },
      });

      await expect(test.service.createV2ProductionOrder(actor, 'order-1')).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code }),
      });
      expect(test.tx.productionOrder.create).not.toHaveBeenCalled();
    },
  );

  it('refreshes an oversized stale route to verified coverage before returning route-changed', async () => {
    const test = harness({ inventoryEpoch: 5n, calculationEpoch: 4n });
    const order = await test.tx.commercialOrder.findUnique();
    order.positions[0].rollCount = 2_001;
    test.tx.commercialOrder.findUnique.mockResolvedValue(order);
    test.calculation.calculateLocked.mockResolvedValue({
      calculationId: 'calculation-4',
      projection: projection('verified_full', 4),
    });

    await expect(test.service.createV2ProductionOrder(actor, 'order-1')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'warehouse_coverage_route_changed' }),
    });
    expect(test.calculation.calculateLocked).toHaveBeenCalledTimes(1);
    expect(test.tx.productionOrder.create).not.toHaveBeenCalled();
    expect(test.transactionTrace).toEqual([
      'serializable_started',
      'serializable_callback_returned',
      'transaction_committed',
    ]);
  });

  it('rolls back an oversized stale shortage refresh with the production write', async () => {
    const test = harness({ inventoryEpoch: 5n, calculationEpoch: 4n });
    const order = await test.tx.commercialOrder.findUnique();
    order.positions[0].rollCount = 2_001;
    test.tx.commercialOrder.findUnique.mockResolvedValue(order);
    test.calculation.calculateLocked.mockImplementation(async () => {
      test.replaceState({
        ...test.readState(),
        state: 'production_required',
        stateVersion: 9,
        generation: 4,
        currentCalculationId: 'calculation-4',
        currentDecisionId: 'decision-4',
        currentCalculation: {
          ...test.readState().currentCalculation,
          id: 'calculation-4',
          generation: 4,
          inventoryEpoch: 5n,
          inputFingerprint: 'b'.repeat(64),
        },
        currentDecision: {
          ...test.readState().currentDecision,
          id: 'decision-4',
          calculationId: 'calculation-4',
          generation: 4,
          inputFingerprint: 'b'.repeat(64),
        },
      });
      return { calculationId: 'calculation-4', projection: projection('unavailable', 4) };
    });

    await expect(test.service.createV2ProductionOrder(actor, 'order-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRODUCTION_ORDER_TOO_LARGE' }),
    });
    expect(test.calculation.calculateLocked).toHaveBeenCalledTimes(1);
    expect(test.tx.productionOrder.create).not.toHaveBeenCalled();
    expect(test.transactionTrace).toEqual(['serializable_started']);
  });

  it.each([
    ['verified_full', 'warehouse_coverage_route_changed'],
    ['unknown', 'warehouse_coverage_blocked'],
  ] as const)(
    'commits refreshed %s before returning stable 409 and creates no production order',
    async (availability, code) => {
      const test = harness({ inventoryEpoch: 5n, calculationEpoch: 4n });
      test.calculation.calculateLocked.mockResolvedValue({
        calculationId: 'calculation-4',
        projection: projection(availability, 4),
      });

      await expect(test.service.createV2ProductionOrder(actor, 'order-1')).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code, calculationId: 'calculation-4' }),
      });

      expect(test.tx.productionOrder.create).not.toHaveBeenCalled();
      expect(test.tx.rollDispatchItem.createMany).not.toHaveBeenCalled();
      expect(test.transactionTrace).toEqual([
        'serializable_started',
        'serializable_callback_returned',
        'transaction_committed',
      ]);
    },
  );

  it('accepts terminal explicit produce_all even when its source epoch changed', async () => {
    const test = harness({
      inventoryEpoch: 9n,
      calculationEpoch: 4n,
      decisionKind: 'produce_all',
    });

    const result = await test.service.createV2ProductionOrder(actor, 'order-1');

    expect(result.productionOrderId).toBe('production-new');
    expect(result.sourceDecisionId).toBe('decision-3');
    expect(test.calculation.calculateLocked).not.toHaveBeenCalled();
    expect(test.tx.warehouseCoverageState.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks the finance gate after locking and before refreshing or writing', async () => {
    const test = harness({
      inventoryEpoch: 5n,
      calculationEpoch: 4n,
      financeAllowed: false,
    });

    await expect(test.service.createV2ProductionOrder(actor, 'order-1')).rejects.toMatchObject({
      status: 409,
    });

    expect(test.calculation.calculateLocked).not.toHaveBeenCalled();
    expect(test.tx.warehouseCoverageState.updateMany).not.toHaveBeenCalled();
    expect(test.tx.productionOrder.create).not.toHaveBeenCalled();
    expect(test.audit.record).not.toHaveBeenCalled();
  });

  it('keeps the finance gate ahead of an oversized stale-route refresh', async () => {
    const test = harness({
      inventoryEpoch: 5n,
      calculationEpoch: 4n,
      financeAllowed: false,
    });
    const order = await test.tx.commercialOrder.findUnique();
    order.positions[0].rollCount = 2_001;
    test.tx.commercialOrder.findUnique.mockResolvedValue(order);

    await expect(test.service.createV2ProductionOrder(actor, 'order-1')).rejects.toMatchObject({
      status: 409,
    });
    expect(test.calculation.calculateLocked).not.toHaveBeenCalled();
    expect(test.tx.warehouseCoverageState.updateMany).not.toHaveBeenCalled();
  });

  it('returns an existing proven V2 production order without duplicate writes', async () => {
    const test = harness({ existingProductionOrder: true });

    await expect(test.service.createV2ProductionOrder(actor, 'order-1')).resolves.toEqual({
      productionOrderId: 'production-existing',
      sourceCalculationId: 'calculation-3',
      sourceDecisionId: 'decision-3',
      inputFingerprint: 'a'.repeat(64),
      generation: 3,
    });
    expect(test.tx.productionOrder.create).not.toHaveBeenCalled();
    expect(test.tx.rollDispatchItem.createMany).not.toHaveBeenCalled();
    expect(test.audit.record).not.toHaveBeenCalled();
  });

  it('returns the proven unique winner after a concurrent P2002 race', async () => {
    const test = harness({ existingProductionOrder: true });
    test.coverageTransaction.run.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['commercialOrderId'] },
      }),
    );

    await expect(test.service.createV2ProductionOrder(actor, 'order-1')).resolves.toEqual({
      productionOrderId: 'production-existing',
      sourceCalculationId: 'calculation-3',
      sourceDecisionId: 'decision-3',
      inputFingerprint: 'a'.repeat(64),
      generation: 3,
    });
  });
});
