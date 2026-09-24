import { CommercialOrderReconciliationService } from './commercial-order-reconciliation.service';

const actor = { userId: 'commercial-1', role: 'commercial' as const };

const position = {
  id: 'position-1',
  orderId: 'order-1',
  version: 3,
  rollCount: 3,
  filmType: 'Рукав',
  actualThickness: '80',
  accountingThickness: '78',
  rawMaterialId: null,
  baseRawMaterialDefinitionId: 'material-1',
  recipeDefinitionVersionId: null,
  spoolType: '76 мм',
  birka: 'ГОСТ',
  manualBirka: 'Синяя',
  comment: 'Не перегревать',
  plannedWeightKg: 42,
  widthMm: 1600,
  plannedLengthM: 300,
  warehouseCoverStatus: 'needs_production',
  recipe: {
    version: 'v2',
    parameters: [],
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    recipeName: 'ПВД',
    ingredients: [
      {
        rawMaterialDefinitionId: 'material-1',
        name: 'ПВД',
        shareBasisPoints: 10_000,
      },
    ],
  },
  baseRawMaterialDefinition: {
    id: 'material-1',
    name: 'ПВД',
    stock: { materialId: 'raw-pvd' },
  },
  recipeDefinitionVersion: null,
  coverProposals: [],
};

function line(
  patch: Partial<{
    spoolKg: number | null;
    grossKg: number | null;
    netKg: number | null;
    warehouseState: string;
    weightCaptures: unknown[];
    labelJobs: unknown[];
    operations: unknown[];
  }> = {},
) {
  return {
    spoolKg: null,
    grossKg: null,
    netKg: null,
    warehouseState: 'not_ready',
    weightCaptures: [],
    labelJobs: [],
    operations: [],
    ...patch,
  };
}

function roll(
  sequence: number,
  patch: Partial<{
    status: string;
    completedAt: Date | null;
    coverageFact: { id: string } | null;
    operatorLine: ReturnType<typeof line> | null;
  }> = {},
) {
  return {
    id: `dispatch-${sequence}`,
    rollCode: `A-17-roll-${sequence}`,
    productionOrderId: 'production-1',
    orderLineId: 'position-1',
    positionSequence: sequence,
    status: 'new',
    completedAt: null,
    coverageFact: null,
    operatorLine: null,
    queueRank: sequence,
    ...patch,
  };
}

function setup(rows = [roll(1), roll(2)]) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(rows.map(({ id }) => ({ id }))),
    productionOrder: {
      findFirst: jest.fn().mockResolvedValue({ id: 'production-1' }),
    },
    commercialOrderPosition: {
      findMany: jest.fn().mockResolvedValue([position]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rollDispatchItem: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(rows.map(({ id }) => ({ id })))
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce(
          rows.map(({ rollCode, queueRank, positionSequence }) => ({
            rollCode,
            queueRank,
            positionSequence,
          })),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockImplementation(async ({ data }: { data: unknown[] }) => ({
        count: data.length,
      })),
    },
  };
  const coverage = {
    lockForOrderChange: jest.fn().mockResolvedValue({ workflowVersion: 2 }),
    reconcileAfterOrderChange: jest.fn().mockResolvedValue({
      needsProductionReview: false,
      releasedRollIds: [],
    }),
  };
  const service = new CommercialOrderReconciliationService(coverage as never);
  return { coverage, service, tx };
}

function input() {
  return {
    actor,
    orderId: 'order-1',
    orderNumber: 'A-17',
    productionOrderId: 'production-1',
    positionIds: ['position-1'],
    kind: 'update_position' as const,
    reason: 'Уточнены размеры',
    coverageContext: {
      workflowVersion: 2 as const,
      orderId: 'order-1',
      state: {} as never,
      lockedRollIds: [],
    },
  };
}

describe('CommercialOrderReconciliationService', () => {
  it('preserves a started snapshot and updates or creates only future rolls', async () => {
    const started = roll(1, {
      status: 'in_progress',
      operatorLine: line({ grossKg: 42 }),
    });
    const { service, tx } = setup([started, roll(2)]);

    await expect(service.reconcile(tx as never, input())).resolves.toEqual({
      reconciliation: 'needs_production_review',
      changedFutureRollIds: ['A-17-roll-2', 'A-17-roll-3'],
      preservedPhysicalRollIds: ['A-17-roll-1'],
      preservedRollCountByPosition: { 'position-1': 1 },
      completedRollCount: 0,
      remainingCancelledRollCount: 0,
    });

    expect(tx.rollDispatchItem.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dispatch-1' } }),
    );
    expect(tx.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'dispatch-2' },
      data: expect.objectContaining({
        widthMm: 1600,
        plannedLengthM: 300,
        characteristicsSnapshot: expect.objectContaining({
          widthMm: 1600,
          plannedLengthM: 300,
          manualBirka: 'Синяя',
          recipeVersion: 'v2',
        }),
      }),
    });
    expect(tx.rollDispatchItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          rollCode: 'A-17-roll-3',
          orderLineId: 'position-1',
          positionSequence: 3,
          widthMm: 1600,
          plannedLengthM: 300,
        }),
      ],
    });
  });

  it('marks only untouched surplus rolls cancelled during reduction', async () => {
    const started = roll(1, {
      status: 'ready_for_warehouse',
      operatorLine: line({ warehouseState: 'ready_for_handover' }),
    });
    const { service, tx } = setup([started, roll(2), roll(3)]);
    tx.commercialOrderPosition.findMany.mockResolvedValue([{ ...position, rollCount: 1 }]);

    const result = await service.reconcile(tx as never, input());

    expect(result.preservedPhysicalRollIds).toEqual(['A-17-roll-1']);
    expect(tx.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'dispatch-2' },
      data: expect.objectContaining({
        status: 'cancelled',
        cancellationReason: 'Уточнены размеры',
        assignedOperatorId: null,
        plannedShiftId: null,
      }),
    });
    expect(tx.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'dispatch-3' },
      data: expect.objectContaining({ status: 'cancelled' }),
    });
    expect(tx.rollDispatchItem.createMany).not.toHaveBeenCalled();
  });

  it('keeps the effective desired count at the irreversible physical minimum', async () => {
    const { service, tx } = setup([
      roll(1, { status: 'done', completedAt: new Date('2026-08-04T10:00:00.000Z') }),
      roll(2),
    ]);
    tx.commercialOrderPosition.findMany.mockResolvedValue([{ ...position, rollCount: 0 }]);

    await service.reconcile(tx as never, {
      ...input(),
      kind: 'cancel_remaining_position',
    });

    expect(tx.commercialOrderPosition.updateMany).toHaveBeenCalledWith({
      where: { id: 'position-1', orderId: 'order-1', rollCount: 0 },
      data: { rollCount: 1 },
    });
    expect(tx.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'dispatch-2' },
      data: expect.objectContaining({ status: 'cancelled' }),
    });
    expect(tx).not.toHaveProperty('rollDispatchItem.delete');
  });

  it('cancels unfinished physical rows only for the explicit production override', async () => {
    const { coverage, service, tx } = setup([
      roll(1, { status: 'done', completedAt: new Date('2026-08-04T10:00:00.000Z') }),
      roll(2, {
        status: 'ready_for_warehouse',
        operatorLine: line({ warehouseState: 'ready_for_handover' }),
      }),
      roll(3, {
        status: 'deferred',
        operatorLine: line({ operations: [{ id: 'operation-1' }] }),
      }),
      roll(4, { status: 'assigned' }),
    ]);
    tx.commercialOrderPosition.findMany.mockResolvedValue([{ ...position, rollCount: 0 }]);

    await expect(
      service.reconcile(tx as never, {
        ...input(),
        kind: 'cancel_unfinished_order',
      }),
    ).resolves.toMatchObject({
      changedFutureRollIds: ['A-17-roll-3', 'A-17-roll-4'],
      preservedPhysicalRollIds: ['A-17-roll-1', 'A-17-roll-2'],
      preservedRollCountByPosition: { 'position-1': 2 },
      completedRollCount: 2,
      remainingCancelledRollCount: 2,
    });
    expect(tx.commercialOrderPosition.updateMany).toHaveBeenCalledWith({
      where: { id: 'position-1', orderId: 'order-1', rollCount: 0, version: 3 },
      data: { rollCount: 2, version: { increment: 1 } },
    });
    expect(tx.commercialOrderPosition.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      coverage.reconcileAfterOrderChange.mock.invocationCallOrder[0],
    );
    expect(tx.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'dispatch-3' },
      data: expect.objectContaining({
        status: 'cancelled',
        cancellationReason: 'Уточнены размеры',
      }),
    });
  });

  it('cancels every untouched future roll while preserving completed work', async () => {
    const { service, tx } = setup([
      roll(1, { status: 'done', completedAt: new Date('2026-08-04T10:00:00.000Z') }),
      roll(2),
      roll(3),
    ]);

    await expect(
      service.reconcile(tx as never, { ...input(), kind: 'cancel_order' }),
    ).resolves.toMatchObject({
      changedFutureRollIds: ['A-17-roll-2', 'A-17-roll-3'],
      preservedPhysicalRollIds: ['A-17-roll-1'],
      completedRollCount: 1,
      remainingCancelledRollCount: 2,
    });
    expect(tx.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
    expect(tx.rollDispatchItem.createMany).not.toHaveBeenCalled();
  });

  it('reactivates by creating a new future remainder instead of deleting cancellations', async () => {
    const { service, tx } = setup([
      roll(1, { status: 'done', completedAt: new Date('2026-08-04T10:00:00.000Z') }),
      roll(2, { status: 'cancelled' }),
      roll(3, { status: 'cancelled' }),
    ]);

    await expect(
      service.reconcile(tx as never, { ...input(), kind: 'reactivate_order' }),
    ).resolves.toMatchObject({
      changedFutureRollIds: ['A-17-roll-4', 'A-17-roll-5'],
      preservedPhysicalRollIds: ['A-17-roll-1'],
      completedRollCount: 1,
      remainingCancelledRollCount: 0,
    });
    expect(tx.rollDispatchItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ rollCode: 'A-17-roll-4', status: 'new' }),
        expect.objectContaining({ rollCode: 'A-17-roll-5', status: 'new' }),
      ],
    });
    expect(tx).not.toHaveProperty('rollDispatchItem.delete');
  });
});
