import { ConflictException } from '@nestjs/common';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { RecipeParamDto } from './dto/create-order.dto';
import {
  commercialOrderAmendmentFingerprintInput,
  CommercialOrderAmendmentService,
  type CommercialOrderAmendmentResult,
} from './commercial-order-amendment.service';

const OPERATION_KEY = '8c5c69ef-6bd3-4e25-9829-d32da8cd75dc';
const actor = { userId: 'commercial-1', role: 'commercial' as const };
const director = { userId: 'director-1', role: 'director' as const };

const selection = {
  baseRawMaterialDefinitionId: 'material-1',
  recipeDefinitionId: null,
  recipeDefinitionVersionId: null,
  version: null,
  name: 'ПВД',
  ingredients: [
    {
      rawMaterialDefinitionId: 'material-1',
      name: 'ПВД',
      shareBasisPoints: 10_000,
    },
  ],
};

const order = {
  id: 'order-1',
  orderNumber: 'A-17',
  version: 3,
  cancellationStatus: 'active',
  cancellationVersion: 1,
  cancelledAt: null,
  cancelledById: null,
  cancellationReason: null,
  warehouseCoverageWorkflowVersion: 2,
  productionIndicator: 'in_production',
  warehouseCoverStatus: 'needs_production',
  paymentStatus: 'unpaid',
  shipmentStatus: 'not_shipped',
  positions: [{ id: 'position-1' }],
  financeOrder: {
    id: 'finance-1',
    invoiceStatus: 'not_invoiced',
    invoiceIssuedAt: null,
    invoiceSyncState: 'not_synced',
    paymentStatus: 'unpaid',
    productionClearedAt: null,
  },
  productionOrder: { id: 'production-1' },
};

const currentPosition = {
  id: 'position-1',
  orderId: 'order-1',
  version: 2,
  rollCount: 3,
  filmType: 'Рукав',
  actualThickness: '80',
  accountingThickness: '78',
  widthMm: 1700,
  plannedLengthM: 275,
  rawMaterialId: null,
  baseRawMaterialDefinitionId: 'material-1',
  recipeDefinitionVersionId: null,
  spoolType: '76 мм',
  birka: 'ГОСТ',
  manualBirka: null,
  comment: null,
  plannedWeightKg: 42,
  recipe: {
    version: 'v1',
    parameters: [],
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    recipeName: 'ПВД',
    ingredients: selection.ingredients,
  },
};

function setup() {
  const tx = {
    operatorRollOperation: { count: jest.fn().mockResolvedValue(0) },
    warehouseRoll: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    warehouseAcceptanceTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
    commercialOrderAmendmentCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'command-1' }),
      update: jest.fn().mockResolvedValue({ id: 'command-1' }),
    },
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    financeOrder: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'finance-1',
        commercialOrderId: 'order-1',
        invoiceStatus: 'not_invoiced',
        invoiceIssuedAt: null,
        invoiceSyncState: 'not_synced',
      }),
    },
    commercialOrderPosition: {
      findFirst: jest.fn().mockResolvedValue(currentPosition),
      create: jest.fn().mockImplementation(async ({ data }: { data: object }) => ({
        id: 'position-new',
        version: 1,
        ...data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({ id: 'position-1' }),
    },
    recipeSnapshot: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const recipeCatalog = {
    resolveSelections: jest.fn().mockResolvedValue([selection]),
  };
  const coverageTransaction = {
    run: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const reconciliation = {
    lockOrder: jest.fn().mockResolvedValue({ workflowVersion: 2, orderId: 'order-1' }),
    reconcile: jest.fn().mockResolvedValue({
      reconciliation: 'applied',
      changedFutureRollIds: [],
      preservedPhysicalRollIds: [],
      preservedRollCountByPosition: {},
    }),
  };
  const service = new CommercialOrderAmendmentService(
    audit as never,
    recipeCatalog as never,
    coverageTransaction as never,
    reconciliation as never,
    { releaseCancelledOrderRolls: jest.fn().mockResolvedValue(undefined) } as never,
    { acquireDeliveryScopeLock: jest.fn().mockResolvedValue({}) } as never,
  );
  return {
    audit,
    coverageTransaction,
    recipeCatalog,
    reconciliation,
    service,
    tx,
  };
}

const addCommand = {
  kind: 'add_position' as const,
  operationKey: OPERATION_KEY,
  expectedOrderVersion: 3,
  reason: 'Клиент добавил рулон',
  position: {
    rollCount: 1,
    filmType: 'Полотно',
    actualThickness: '100',
    accountingThickness: '98',
    widthMm: 1500,
    plannedLengthM: 300,
    baseRawMaterialDefinitionId: 'material-1',
    birka: 'ГОСТ',
  },
};

describe('CommercialOrderAmendmentService', () => {
  it('adds a position before invoice and sends one safe finance notification', async () => {
    const { audit, recipeCatalog, reconciliation, service, tx } = setup();

    await expect(service.apply(actor, 'order-1', addCommand)).resolves.toEqual({
      commandId: 'command-1',
      orderId: 'order-1',
      orderVersion: 4,
      reconciliation: 'applied',
      affectedPositionIds: ['position-new'],
      changedFutureRollIds: [],
      preservedPhysicalRollIds: [],
    });

    expect(recipeCatalog.resolveSelections).toHaveBeenCalledWith(tx, [
      { baseRawMaterialDefinitionId: 'material-1' },
    ]);
    expect(tx.commercialOrderPosition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        rollCount: 1,
        widthMm: 1500,
        plannedLengthM: 300,
        baseRawMaterialDefinitionId: 'material-1',
        recipe: { create: expect.objectContaining({ recipeName: 'ПВД' }) },
      }),
      select: expect.objectContaining({ id: true, version: true }),
    });
    expect(tx.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', version: 3, cancellationStatus: 'active' },
      data: { version: { increment: 1 } },
    });
    expect(reconciliation.reconcile).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orderId: 'order-1',
        positionIds: ['position-new'],
        kind: 'add_position',
        coverageContext: { workflowVersion: 2, orderId: 'order-1' },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:commercial_order_amended',
        detail: expect.objectContaining({
          orderId: 'order-1',
          orderNumber: 'A-17',
          financeOrderId: 'finance-1',
          notificationKey: 'commercial-order-amended:command-1',
          positionId: 'position-new',
          positionIds: ['position-new'],
          recipientRoles: ['finance', 'production_lead', 'warehouse'],
        }),
      }),
      tx,
    );
    expect(tx.commercialOrder.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0]?.[0].strings.join(' ')).toContain(
      'pg_try_advisory_xact_lock',
    );
  });

  it.each([
    {
      invoiceStatus: 'invoiced',
      invoiceIssuedAt: null,
      invoiceSyncState: 'not_synced',
    },
    {
      invoiceStatus: 'not_invoiced',
      invoiceIssuedAt: new Date('2026-08-06T08:00:00.000Z'),
      invoiceSyncState: 'not_synced',
    },
    {
      invoiceStatus: 'not_invoiced',
      invoiceIssuedAt: null,
      invoiceSyncState: 'posted',
    },
  ])('rejects every amendment after invoice fact %#', async (invoiceBoundary) => {
    const { audit, service, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      id: 'finance-1',
      commercialOrderId: 'order-1',
      ...invoiceBoundary,
    });

    await expect(
      service.apply(actor, 'order-1', {
        kind: 'update_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Уточнена ширина',
        positionId: 'position-1',
        changes: { widthMm: 1600 },
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE',
      },
    });

    expect(tx.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
    expect(tx.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('cancels only unfinished rolls after invoice through the production override', async () => {
    const { audit, reconciliation, service, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      id: 'finance-1',
      commercialOrderId: 'order-1',
      invoiceStatus: 'invoiced',
      invoiceIssuedAt: new Date('2026-08-28T10:23:18.312Z'),
      invoiceSyncState: 'not_synced',
    });
    tx.commercialOrder.findUnique.mockResolvedValue({
      ...order,
      positions: [{ id: 'position-1', rollCount: 3, version: 2 }],
    });
    reconciliation.reconcile.mockResolvedValue({
      reconciliation: 'needs_production_review',
      changedFutureRollIds: ['A-17-roll-2', 'A-17-roll-3'],
      preservedPhysicalRollIds: ['A-17-roll-1'],
      preservedRollCountByPosition: { 'position-1': 1 },
      completedRollCount: 1,
      remainingCancelledRollCount: 2,
    });

    await expect(
      service.cancelUnfinished(director, 'order-1', {
        operationKey: OPERATION_KEY,
        expectedVersion: 3,
        reason: 'Оперативная коррекция незавершённого остатка',
      }),
    ).resolves.toEqual({
      commandId: 'command-1',
      orderId: 'order-1',
      orderVersion: 4,
      reconciliation: 'needs_production_review',
      affectedPositionIds: ['position-1'],
      changedFutureRollIds: ['A-17-roll-2', 'A-17-roll-3'],
      preservedPhysicalRollIds: ['A-17-roll-1'],
    });
    expect(tx.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', version: 3, cancellationStatus: 'active' },
      data: { version: { increment: 1 } },
    });
    expect(reconciliation.reconcile).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        kind: 'cancel_unfinished_order',
        positionIds: ['position-1'],
      }),
    );
    expect(tx.commercialOrderAmendmentCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'cancel_unfinished_order',
        actorRole: 'director',
      }),
      select: { id: true },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_order_amended',
        actorRole: 'director',
        detail: expect.objectContaining({ kind: 'cancel_unfinished_order' }),
      }),
      tx,
    );
  });

  it('restarts with a fresh transaction when invoice publication owns the boundary', async () => {
    const { coverageTransaction, service, tx } = setup();
    tx.$queryRaw.mockResolvedValueOnce([{ locked: false }]).mockResolvedValue([{ locked: true }]);

    await expect(service.apply(actor, 'order-1', addCommand)).resolves.toMatchObject({
      commandId: 'command-1',
      orderId: 'order-1',
    });

    expect(coverageTransaction.run).toHaveBeenCalledTimes(2);
    expect(tx.commercialOrderAmendmentCommand.findUnique).toHaveBeenCalledTimes(1);
  });

  it('rejects an effective no-op without changing versions or sending notifications', async () => {
    const { audit, service, tx } = setup();

    await expect(
      service.apply(actor, 'order-1', {
        kind: 'update_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Повторно сохранена ширина',
        positionId: 'position-1',
        changes: { widthMm: 1700 },
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'COMMERCIAL_AMENDMENT_NO_CHANGES',
      },
    });

    expect(tx.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
    expect(tx.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('treats transformed recipe parameter instances as an effective no-op', async () => {
    const { audit, service, tx } = setup();
    const parameter = new RecipeParamDto();
    parameter.label = 'Сырьё';
    parameter.value = 'ПВД первичное';
    tx.commercialOrderPosition.findFirst.mockResolvedValue({
      ...currentPosition,
      recipe: {
        ...currentPosition.recipe,
        parameters: [{ label: 'Сырьё', value: 'ПВД первичное' }],
      },
    });

    await expect(
      service.apply(actor, 'order-1', {
        kind: 'update_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Повторно сохранена рецептура',
        positionId: 'position-1',
        changes: { recipeParameters: [parameter] },
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'COMMERCIAL_AMENDMENT_NO_CHANGES',
      },
    });

    expect(tx.recipeSnapshot.updateMany).not.toHaveBeenCalled();
    expect(tx.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
    expect(tx.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records only actual changed fields from a complete editor snapshot', async () => {
    const { audit, service, tx } = setup();

    await service.apply(actor, 'order-1', {
      kind: 'update_position',
      operationKey: OPERATION_KEY,
      expectedOrderVersion: 3,
      expectedPositionVersion: 2,
      reason: 'Уточнена ширина',
      positionId: 'position-1',
      changes: {
        rollCount: 3,
        filmType: 'Рукав',
        actualThickness: '80',
        accountingThickness: '78',
        widthMm: 1600,
        plannedLengthM: 275,
        plannedWeightKg: 42,
        spoolType: '76 мм',
        birka: 'ГОСТ',
        manualBirka: '',
        comment: '',
      },
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:commercial_order_amended',
        detail: expect.objectContaining({
          changedFields: ['widthMm'],
          positionId: 'position-1',
          positionIds: ['position-1'],
        }),
      }),
      tx,
    );
  });

  it('updates recipe-only parameters and emits one amendment notification', async () => {
    const { audit, service, tx } = setup();

    await service.apply(actor, 'order-1', {
      kind: 'update_position',
      operationKey: OPERATION_KEY,
      expectedOrderVersion: 3,
      expectedPositionVersion: 2,
      reason: 'Уточнена рецептура',
      positionId: 'position-1',
      changes: {
        recipeParameters: [{ label: 'Цвет', value: 'синий' }],
      },
    });

    expect(tx.recipeSnapshot.updateMany).toHaveBeenCalledWith({
      where: { positionId: 'position-1', version: 'v1' },
      data: {
        parameters: [{ label: 'Цвет', value: 'синий' }],
        version: 'v2',
      },
    });
    expect(
      audit.record.mock.calls.filter(
        ([event]) => event.type === 'notification:commercial_order_amended',
      ),
    ).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:commercial_order_amended',
        detail: expect.objectContaining({
          changedFields: ['recipeParameters'],
        }),
      }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_order_amended',
        oldValue: expect.objectContaining({
          recipeVersion: 'v1',
          recipeParameters: [],
        }),
        newValue: expect.objectContaining({
          recipeVersion: 'v2',
          recipeParameters: [{ label: 'Цвет', value: 'синий' }],
        }),
      }),
      tx,
    );
  });

  it('sets cancelled remainder to the preserved physical count without deleting facts', async () => {
    const { reconciliation, service, tx } = setup();
    reconciliation.reconcile.mockResolvedValue({
      reconciliation: 'needs_production_review',
      changedFutureRollIds: ['roll-2', 'roll-3'],
      preservedPhysicalRollIds: ['roll-1'],
      preservedRollCountByPosition: { 'position-1': 1 },
    });

    await expect(
      service.apply(actor, 'order-1', {
        kind: 'cancel_remaining_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Остаток не нужен',
        positionId: 'position-1',
      }),
    ).resolves.toMatchObject({
      reconciliation: 'needs_production_review',
      changedFutureRollIds: ['roll-2', 'roll-3'],
      preservedPhysicalRollIds: ['roll-1'],
    });

    expect(tx.commercialOrderPosition.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'position-1', orderId: 'order-1', version: 2 },
      data: { rollCount: 0, version: { increment: 1 } },
    });
    expect(tx.commercialOrderPosition.updateMany).toHaveBeenCalledTimes(1);
    expect(tx).not.toHaveProperty('commercialOrderPosition.delete');
    expect(tx).not.toHaveProperty('rollDispatchItem.delete');
  });

  it('allows cancelling all untouched remainder to zero', async () => {
    const { reconciliation, service, tx } = setup();
    reconciliation.reconcile.mockResolvedValue({
      reconciliation: 'applied',
      changedFutureRollIds: ['roll-1', 'roll-2', 'roll-3'],
      preservedPhysicalRollIds: [],
      preservedRollCountByPosition: { 'position-1': 0 },
    });

    await service.apply(actor, 'order-1', {
      kind: 'cancel_remaining_position',
      operationKey: OPERATION_KEY,
      expectedOrderVersion: 3,
      expectedPositionVersion: 2,
      reason: 'Позиция отменена полностью',
      positionId: 'position-1',
    });

    expect(tx.commercialOrderPosition.updateMany).toHaveBeenCalledTimes(1);
  });

  it('returns a stored result for the same operation key and payload', async () => {
    const { reconciliation, service, tx } = setup();
    const result: CommercialOrderAmendmentResult = {
      commandId: 'command-existing',
      orderId: 'order-1',
      orderVersion: 4,
      reconciliation: 'applied',
      affectedPositionIds: ['position-new'],
      changedFutureRollIds: [],
      preservedPhysicalRollIds: [],
    };
    tx.commercialOrderAmendmentCommand.findUnique.mockResolvedValue({
      requestFingerprint: requestFingerprint(
        commercialOrderAmendmentFingerprintInput('order-1', addCommand),
      ),
      result,
    });

    await expect(service.apply(actor, 'order-1', addCommand)).resolves.toEqual(result);
    expect(tx.commercialOrderPosition.create).not.toHaveBeenCalled();
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
  });

  it('rejects reuse of an operation key with a different body', async () => {
    const { service, tx } = setup();
    tx.commercialOrderAmendmentCommand.findUnique.mockResolvedValue({
      requestFingerprint: '0'.repeat(64),
      result: {},
    });

    await expect(service.apply(actor, 'order-1', addCommand)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.commercialOrderPosition.create).not.toHaveBeenCalled();
  });

  it('rejects stale aggregate and position versions before mutation', async () => {
    const aggregate = setup();
    aggregate.tx.commercialOrder.findUnique.mockResolvedValue({ ...order, version: 4 });

    await expect(aggregate.service.apply(actor, 'order-1', addCommand)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COMMERCIAL_AMENDMENT_VERSION_CONFLICT' }),
    });
    expect(aggregate.tx.commercialOrderPosition.create).not.toHaveBeenCalled();

    const position = setup();
    position.tx.commercialOrderPosition.findFirst.mockResolvedValue({
      ...currentPosition,
      version: 3,
    });
    await expect(
      position.service.apply(actor, 'order-1', {
        kind: 'update_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Уточнение',
        positionId: 'position-1',
        changes: { widthMm: 1600 },
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'COMMERCIAL_AMENDMENT_POSITION_VERSION_CONFLICT',
      }),
    });
    expect(position.tx.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
  });

  it('cancels only future work and preserves all independent business indicators', async () => {
    const { audit, reconciliation, service, tx } = setup();
    tx.commercialOrder.findUnique.mockResolvedValue({
      ...order,
      paymentStatus: 'paid',
      financeOrder: {
        id: 'finance-1',
        invoiceStatus: 'invoiced',
        invoiceIssuedAt: new Date('2026-08-04T09:00:00.000Z'),
        invoiceSyncState: 'posted',
        paymentStatus: 'paid',
        productionClearedAt: new Date('2026-08-04T10:00:00.000Z'),
      },
    });
    reconciliation.reconcile.mockResolvedValue({
      reconciliation: 'needs_production_review',
      changedFutureRollIds: ['A-17-roll-2', 'A-17-roll-3'],
      preservedPhysicalRollIds: ['A-17-roll-1'],
      preservedRollCountByPosition: { 'position-1': 1 },
      completedRollCount: 1,
      remainingCancelledRollCount: 2,
    });

    await expect(
      service.cancel(actor, 'order-1', {
        operationKey: OPERATION_KEY,
        expectedVersion: 3,
        reason: 'Клиент отменил остаток',
      }),
    ).resolves.toEqual({
      commandId: 'command-1',
      orderId: 'order-1',
      orderVersion: 4,
      cancellationStatus: 'cancelled',
      cancellationVersion: 2,
      reconciliation: 'needs_production_review',
      affectedPositionIds: ['position-1'],
      changedFutureRollIds: ['A-17-roll-2', 'A-17-roll-3'],
      preservedPhysicalRollIds: ['A-17-roll-1'],
      completedRollCount: 1,
      remainingCancelledRollCount: 2,
    });

    expect(tx.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        version: 3,
        cancellationStatus: 'active',
        cancellationVersion: 1,
      },
      data: {
        cancellationStatus: 'cancelled',
        cancellationVersion: { increment: 1 },
        cancelledAt: expect.any(Date),
        cancelledById: 'commercial-1',
        cancellationReason: 'Клиент отменил остаток',
        version: { increment: 1 },
      },
    });
    const updateData = tx.commercialOrder.updateMany.mock.calls[0][0].data;
    for (const field of [
      'productionIndicator',
      'warehouseCoverStatus',
      'paymentStatus',
      'shipmentStatus',
      'financeOrder',
    ]) {
      expect(updateData).not.toHaveProperty(field);
    }
    expect(reconciliation.reconcile).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        kind: 'cancel_order',
        positionIds: ['position-1'],
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_order_cancelled',
        oldValue: expect.objectContaining({
          productionIndicator: 'in_production',
          paymentStatus: 'paid',
          shipmentStatus: 'not_shipped',
        }),
        newValue: expect.objectContaining({
          productionIndicator: 'in_production',
          paymentStatus: 'paid',
          shipmentStatus: 'not_shipped',
          cancellationStatus: 'cancelled',
        }),
      }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:commercial_order_cancelled',
        detail: expect.objectContaining({
          recipientRoles: ['commercial', 'production_lead', 'finance', 'warehouse'],
        }),
      }),
      tx,
    );
  });

  it('reactivates missing future work without reopening invoice or payment clearance', async () => {
    const { audit, reconciliation, service, tx } = setup();
    tx.commercialOrder.findUnique.mockResolvedValue({
      ...order,
      version: 4,
      cancellationStatus: 'cancelled',
      cancellationVersion: 2,
      cancelledAt: new Date('2026-08-04T10:30:00.000Z'),
      cancelledById: 'commercial-1',
      cancellationReason: 'Ошибка клиента',
      paymentStatus: 'unpaid',
      financeOrder: {
        ...order.financeOrder,
        paymentStatus: 'unpaid',
        productionClearedAt: new Date('2026-08-04T10:00:00.000Z'),
      },
    });
    reconciliation.reconcile.mockResolvedValue({
      reconciliation: 'applied',
      changedFutureRollIds: ['A-17-roll-4', 'A-17-roll-5'],
      preservedPhysicalRollIds: ['A-17-roll-1'],
      preservedRollCountByPosition: { 'position-1': 1 },
      completedRollCount: 1,
      remainingCancelledRollCount: 0,
    });

    await expect(
      service.reactivate(actor, 'order-1', {
        operationKey: OPERATION_KEY,
        expectedVersion: 4,
        reason: 'Клиент возобновил заказ',
      }),
    ).resolves.toMatchObject({
      cancellationStatus: 'active',
      cancellationVersion: 3,
      changedFutureRollIds: ['A-17-roll-4', 'A-17-roll-5'],
    });

    expect(tx.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        version: 4,
        cancellationStatus: 'cancelled',
        cancellationVersion: 2,
      },
      data: {
        cancellationStatus: 'active',
        cancellationVersion: { increment: 1 },
        cancelledAt: null,
        cancelledById: null,
        cancellationReason: null,
        version: { increment: 1 },
      },
    });
    const updateData = tx.commercialOrder.updateMany.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('paymentStatus');
    expect(updateData).not.toHaveProperty('financeOrder');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:commercial_order_reactivated' }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notification:commercial_order_reactivated' }),
      tx,
    );
  });
});
