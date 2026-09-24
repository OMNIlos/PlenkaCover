import * as coverageTransactionModule from './warehouse-coverage-transaction';
import { WarehouseCoverageOrderChangeService } from './warehouse-coverage-order-change.service';

const DECISION_ID = '3d81eb5c-1a2f-4cad-9c50-6304486c60a5';

function coverageState(
  rowPatch: Partial<{
    scanStatus: string;
    lastScanAt: Date | null;
    scannedByName: string | null;
    operations: Array<{ id: string }>;
    palletItems: Array<{ id: string }>;
  }> = {},
  statePatch: Partial<{
    state: string;
    currentDecisionId: string | null;
    currentDecision: ReturnType<typeof coverageDecision> | null;
    order: {
      productionOrder: { id: string } | null;
      resolutionCases: Array<{
        id: string;
        version: number;
        coverageOrigin: string | null;
        sourceCoverageCalculationId: string | null;
        sourceCoverageDecisionId: string | null;
      }>;
    };
  }> = {},
) {
  return {
    orderId: 'order-1',
    state: 'warehouse_reserved',
    stateVersion: 4,
    generation: 2,
    currentCalculationId: 'calculation-1',
    currentDecisionId: DECISION_ID,
    currentCalculation: {
      id: 'calculation-1',
      matches: [{ rollId: 'warehouse-roll-1' }, { rollId: 'warehouse-roll-2' }],
    },
    currentDecision: {
      ...coverageDecision(),
      acceptanceTask: coverageDecision().acceptanceTask
        ? {
            ...coverageDecision().acceptanceTask,
            rows: [
              {
                id: 'scan-1',
                scanStatus: 'expected',
                lastScanAt: null,
                scannedByName: null,
                operations: [],
                palletItems: [],
                ...rowPatch,
              },
            ],
          }
        : null,
    },
    order: { productionOrder: null, resolutionCases: [] },
    ...statePatch,
  };
}

function coverageDecision(
  patch: Partial<{
    kind: string;
    reservedRolls: Array<{ id: string }>;
    acceptanceTask: {
      id: string;
      status: string;
      operations: Array<{ id: string }>;
      pallets: Array<{ id: string }>;
      rows: Array<{
        id: string;
        scanStatus: string;
        lastScanAt: Date | null;
        scannedByName: string | null;
        operations: Array<{ id: string }>;
        palletItems: Array<{ id: string }>;
      }>;
    } | null;
  }> = {},
) {
  return {
    id: DECISION_ID,
    expectedRollCount: 2,
    kind: 'use_warehouse',
    reservedRolls: [{ id: 'warehouse-roll-1' }, { id: 'warehouse-roll-2' }],
    producedRolls: [],
    acceptanceTask: {
      id: 'task-1',
      status: 'open',
      operations: [],
      pallets: [],
      rows: [],
    },
    ...patch,
  };
}

function setup(state = coverageState()) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue({ warehouseCoverageWorkflowVersion: 2 }),
    },
    warehouseCoverageState: {
      findUnique: jest.fn().mockResolvedValue(state),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    warehouseRoll: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    warehouseAcceptanceTask: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderResolutionCase: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const service = new WarehouseCoverageOrderChangeService(audit as never);
  jest.spyOn(coverageTransactionModule, 'lockCoverageResources').mockResolvedValue({
    [coverageTransactionModule.COVERAGE_LOCKS_HELD]: true,
    orderId: 'order-1',
    acquiredLevels: [],
    rollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
  });
  return { audit, service, tx };
}

describe('WarehouseCoverageOrderChangeService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retires the decision before releasing the complete untouched reservation set', async () => {
    const { audit, service, tx } = setup();
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменён состав',
      ),
    ).resolves.toEqual({
      needsProductionReview: false,
      releasedRollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
    });

    expect(coverageTransactionModule.lockCoverageResources).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orderId: 'order-1',
        calculationId: 'calculation-1',
        decisionId: DECISION_ID,
        taskId: 'task-1',
      }),
    );
    expect(tx.warehouseRoll.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['warehouse-roll-1', 'warehouse-roll-2'] },
        reservedForOrderId: 'order-1',
        reservedByCoverageDecisionId: DECISION_ID,
      },
      data: {
        reservedForOrderId: null,
        reservedForPositionId: null,
        reservedByCoverageDecisionId: null,
        reservedAt: null,
      },
    });
    expect(tx.warehouseAcceptanceTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'task-1',
        coverageDecisionId: DECISION_ID,
        status: 'open',
      },
      data: { status: 'cancelled' },
    });
    expect(tx.warehouseCoverageState.updateMany).toHaveBeenCalledWith({
      where: {
        orderId: 'order-1',
        stateVersion: 4,
        generation: 2,
        currentCalculationId: 'calculation-1',
        currentDecisionId: DECISION_ID,
      },
      data: {
        state: 'order_spec_changed',
        stateVersion: { increment: 1 },
        currentDecisionId: null,
      },
    });
    expect(tx.warehouseCoverageState.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.warehouseRoll.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_reservation_cancelled',
        objectId: 'order-1',
        detail: expect.objectContaining({
          decisionId: DECISION_ID,
          releasedRollCount: 2,
          cause: 'commercial_order_amendment',
        }),
      }),
      tx,
    );
  });

  it('preserves the full decision set when a warehouse scan already exists', async () => {
    const { audit, service, tx } = setup(
      coverageState({
        scanStatus: 'scanned',
        lastScanAt: new Date('2026-08-04T10:00:00.000Z'),
        scannedByName: 'Склад',
      }),
    );
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменён состав',
      ),
    ).resolves.toEqual({
      needsProductionReview: true,
      releasedRollIds: [],
    });

    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseAcceptanceTask.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseCoverageState.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        orderId: 'order-1',
        currentDecisionId: DECISION_ID,
      }),
      data: {
        state: 'order_spec_changed',
        stateVersion: { increment: 1 },
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_order_spec_invalidated',
        detail: expect.objectContaining({
          decisionPreserved: true,
          physicalFactsPreserved: true,
          productionOrderPreserved: false,
        }),
      }),
      tx,
    );
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_coverage_recheck_requested' }),
      tx,
    );
  });

  it('treats only an active pallet membership as a warehouse physical fact', async () => {
    const { service, tx } = setup(
      coverageState({
        palletItems: [{ id: 'active-pallet-item-1' }],
      }),
    );
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменён состав',
      ),
    ).resolves.toEqual({
      needsProductionReview: true,
      releasedRollIds: [],
    });

    expect(tx.warehouseCoverageState.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          currentDecision: expect.objectContaining({
            select: expect.objectContaining({
              acceptanceTask: expect.objectContaining({
                select: expect.objectContaining({
                  pallets: {
                    where: { status: { not: 'voided' } },
                    select: { id: true },
                  },
                  rows: expect.objectContaining({
                    select: expect.objectContaining({
                      palletItems: {
                        where: {
                          releasedAt: null,
                          pallet: { status: { not: 'voided' } },
                        },
                        orderBy: { id: 'asc' },
                        take: 1,
                        select: { id: true },
                      },
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it.each([
    [
      'voided-only pallet',
      {
        id: 'task-1',
        status: 'open',
        operations: [],
        pallets: [],
        rows: [],
      },
    ],
    [
      'released-only membership',
      {
        id: 'task-1',
        status: 'open',
        operations: [],
        pallets: [],
        rows: [
          {
            id: 'scan-1',
            scanStatus: 'expected',
            lastScanAt: null,
            scannedByName: null,
            operations: [],
            palletItems: [],
          },
        ],
      },
    ],
  ])('ignores the filtered %s projection as a current physical fact', async (_label, task) => {
    const { service, tx } = setup(
      coverageState(
        {},
        {
          currentDecision: coverageDecision({
            acceptanceTask: task as ReturnType<typeof coverageDecision>['acceptanceTask'],
          }),
        },
      ),
    );
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменена спецификация',
      ),
    ).resolves.toEqual({
      needsProductionReview: false,
      releasedRollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
    });
  });

  it('preserves the decision when a sealed non-voided pallet remains', async () => {
    const { service, tx } = setup(
      coverageState(
        {},
        {
          currentDecision: coverageDecision({
            acceptanceTask: {
              id: 'task-1',
              status: 'open',
              operations: [],
              pallets: [{ id: 'sealed-pallet-1' }],
              rows: [],
            },
          }),
        },
      ),
    );
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменена спецификация',
      ),
    ).resolves.toEqual({
      needsProductionReview: true,
      releasedRollIds: [],
    });
  });

  it('retires an untouched already-cancelled reserve task as non-physical', async () => {
    const state = coverageState(
      {},
      {
        currentDecision: coverageDecision({
          acceptanceTask: {
            id: 'task-1',
            status: 'cancelled',
            operations: [],
            pallets: [],
            rows: [],
          },
        }),
      },
    );
    const { service, tx } = setup(state);
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменена спецификация',
      ),
    ).resolves.toEqual({
      needsProductionReview: false,
      releasedRollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
    });

    expect(tx.warehouseCoverageState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'order_spec_changed',
          currentDecisionId: null,
        }),
      }),
    );
  });

  it.each(['produce_all', 'auto_produce_all'] as const)(
    'clears an uncommitted %s decision into an order-spec invalidation',
    async (kind) => {
      const decision = coverageDecision({
        kind,
        reservedRolls: [],
        acceptanceTask: null,
      });
      const state = coverageState(
        {},
        {
          state: 'production_required',
          currentDecision: decision,
        },
      );
      const { service, tx } = setup(state);
      jest.spyOn(coverageTransactionModule, 'lockCoverageResources').mockResolvedValue({
        [coverageTransactionModule.COVERAGE_LOCKS_HELD]: true,
        orderId: 'order-1',
        acquiredLevels: [],
        rollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
      });
      const context = await service.lockForOrderChange(tx as never, 'order-1');

      await expect(
        service.reconcileAfterOrderChange(
          tx as never,
          context,
          { userId: 'commercial-1', role: 'commercial' },
          'Изменена спецификация',
        ),
      ).resolves.toEqual({
        needsProductionReview: false,
        releasedRollIds: [],
      });

      expect(tx.warehouseCoverageState.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          orderId: 'order-1',
          currentDecisionId: DECISION_ID,
        }),
        data: {
          state: 'order_spec_changed',
          stateVersion: { increment: 1 },
          currentDecisionId: null,
        },
      });
      expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
      expect(tx.warehouseAcceptanceTask.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['awaiting_finance', 'unknown'] as const)(
    'invalidates a calculated %s state without inventing a decision',
    async (stateName) => {
      const state = coverageState(
        {},
        {
          state: stateName,
          currentDecisionId: null,
          currentDecision: null,
        },
      );
      const { service, tx } = setup(state);
      jest.spyOn(coverageTransactionModule, 'lockCoverageResources').mockResolvedValue({
        [coverageTransactionModule.COVERAGE_LOCKS_HELD]: true,
        orderId: 'order-1',
        acquiredLevels: [],
        rollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
      });
      const context = await service.lockForOrderChange(tx as never, 'order-1');

      await expect(
        service.reconcileAfterOrderChange(
          tx as never,
          context,
          { userId: 'commercial-1', role: 'commercial' },
          'Изменена спецификация',
        ),
      ).resolves.toEqual({
        needsProductionReview: false,
        releasedRollIds: [],
      });

      expect(tx.warehouseCoverageState.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          orderId: 'order-1',
          currentDecisionId: null,
        }),
        data: {
          state: 'order_spec_changed',
          stateVersion: { increment: 1 },
        },
      });
    },
  );

  it('supersedes a finance recheck when the desired specification changes', async () => {
    const state = coverageState(
      {},
      {
        state: 'recheck_requested',
        currentDecisionId: null,
        currentDecision: null,
        order: {
          productionOrder: null,
          resolutionCases: [
            {
              id: 'case-1',
              version: 2,
              coverageOrigin: 'finance_request',
              sourceCoverageCalculationId: 'calculation-1',
              sourceCoverageDecisionId: null,
            },
          ],
        },
      },
    );
    const { audit, service, tx } = setup(state);
    jest.spyOn(coverageTransactionModule, 'lockCoverageResources').mockResolvedValue({
      [coverageTransactionModule.COVERAGE_LOCKS_HELD]: true,
      orderId: 'order-1',
      acquiredLevels: [],
      rollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
    });
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    expect(coverageTransactionModule.lockCoverageResources).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orderId: 'order-1',
        calculationId: 'calculation-1',
        caseId: 'case-1',
      }),
    );
    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменена спецификация',
      ),
    ).resolves.toEqual({
      needsProductionReview: false,
      releasedRollIds: [],
    });

    expect(tx.orderResolutionCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'case-1',
        orderId: 'order-1',
        status: 'open',
        version: 2,
        coverageOrigin: 'finance_request',
        sourceCoverageCalculationId: 'calculation-1',
        sourceCoverageDecisionId: null,
      },
      data: {
        status: 'resolved',
        openScopeKey: null,
        outcome: 'superseded_by_commercial_order_change',
        nextOwnerRole: null,
        resolvedAt: expect.any(Date),
        version: { increment: 1 },
      },
    });
    expect(tx.warehouseCoverageState.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ orderId: 'order-1' }),
      data: {
        state: 'order_spec_changed',
        stateVersion: { increment: 1 },
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_order_spec_invalidated',
        detail: expect.objectContaining({
          supersededCaseId: 'case-1',
          supersededCaseOrigin: 'finance_request',
        }),
      }),
      tx,
    );
  });

  it('keeps a decision-linked physical recheck open after an editable amendment', async () => {
    const state = coverageState(
      {},
      {
        state: 'recheck_requested',
        currentDecisionId: null,
        currentDecision: null,
        order: {
          productionOrder: null,
          resolutionCases: [
            {
              id: 'case-physical-1',
              version: 3,
              coverageOrigin: 'decision_linked_physical_exception',
              sourceCoverageCalculationId: 'calculation-1',
              sourceCoverageDecisionId: DECISION_ID,
            },
          ],
        },
      },
    );
    const { audit, service, tx } = setup(state);
    jest.spyOn(coverageTransactionModule, 'lockCoverageResources').mockResolvedValue({
      [coverageTransactionModule.COVERAGE_LOCKS_HELD]: true,
      orderId: 'order-1',
      acquiredLevels: [],
      rollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
    });
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    expect(coverageTransactionModule.lockCoverageResources).toHaveBeenCalledWith(
      tx,
      expect.not.objectContaining({ caseId: expect.anything() }),
    );
    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменена спецификация при физическом расхождении',
      ),
    ).resolves.toEqual({
      needsProductionReview: true,
      releasedRollIds: [],
    });

    expect(tx.orderResolutionCase.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseCoverageState.updateMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_order_spec_invalidated',
        detail: expect.objectContaining({
          previousState: 'recheck_requested',
          nextState: 'recheck_requested',
          decisionPreserved: false,
          physicalFactsPreserved: true,
          historicalDecisionFactsPreserved: true,
          retainedCaseId: 'case-physical-1',
          retainedCaseOrigin: 'decision_linked_physical_exception',
        }),
      }),
      tx,
    );
  });

  it('preserves a production-linked decision and requests review', async () => {
    const state = coverageState(
      {},
      {
        state: 'production_required',
        currentDecision: coverageDecision({
          kind: 'auto_produce_all',
          reservedRolls: [],
          acceptanceTask: null,
        }),
        order: {
          productionOrder: { id: 'production-order-1' },
          resolutionCases: [],
        },
      },
    );
    const { audit, service, tx } = setup(state);
    jest.spyOn(coverageTransactionModule, 'lockCoverageResources').mockResolvedValue({
      [coverageTransactionModule.COVERAGE_LOCKS_HELD]: true,
      orderId: 'order-1',
      acquiredLevels: [],
      rollIds: ['warehouse-roll-1', 'warehouse-roll-2'],
    });
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменена спецификация после запуска производства',
      ),
    ).resolves.toEqual({
      needsProductionReview: true,
      releasedRollIds: [],
    });

    expect(tx.warehouseCoverageState.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        orderId: 'order-1',
        currentDecisionId: DECISION_ID,
      }),
      data: {
        state: 'order_spec_changed',
        stateVersion: { increment: 1 },
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_order_spec_invalidated',
        detail: expect.objectContaining({
          decisionPreserved: true,
          physicalFactsPreserved: false,
          productionOrderPreserved: true,
        }),
      }),
      tx,
    );
  });

  it('keeps an untouched initial coverage state when no calculation exists yet', async () => {
    const initialState = coverageState();
    Object.assign(initialState, {
      state: 'calculating',
      stateVersion: 1,
      generation: 0,
      currentCalculationId: null,
      currentDecisionId: null,
      currentCalculation: null,
      currentDecision: null,
    });
    const { audit, service, tx } = setup(initialState);
    jest.spyOn(coverageTransactionModule, 'lockCoverageResources').mockResolvedValue({
      [coverageTransactionModule.COVERAGE_LOCKS_HELD]: true,
      orderId: 'order-1',
      acquiredLevels: [],
      rollIds: [],
    });
    const context = await service.lockForOrderChange(tx as never, 'order-1');

    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Заказ отменён до первого расчёта покрытия',
      ),
    ).resolves.toEqual({
      needsProductionReview: false,
      releasedRollIds: [],
    });

    expect(tx.warehouseCoverageState.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('uses only the commercial aggregate lock for legacy V1 coverage', async () => {
    const { audit, service, tx } = setup();
    tx.commercialOrder.findUnique.mockResolvedValue({
      warehouseCoverageWorkflowVersion: 1,
    });

    const context = await service.lockForOrderChange(tx as never, 'order-1');
    await expect(
      service.reconcileAfterOrderChange(
        tx as never,
        context,
        { userId: 'commercial-1', role: 'commercial' },
        'Изменён состав',
      ),
    ).resolves.toEqual({ needsProductionReview: false, releasedRollIds: [] });

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(coverageTransactionModule.lockCoverageResources).not.toHaveBeenCalled();
    expect(tx.warehouseCoverageState.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
