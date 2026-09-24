import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { SCANNER_ADAPTER } from '../../integrations/scanner/scanner.adapter';
import { OneCImportService } from '../../integrations/onec/onec-import.service';
import { DeferredPaymentService } from '../finance/deferred-payment.service';
import { ProductionService } from '../production/production.service';
import { WarehouseOperationService } from './warehouse-operation.service';
import { WarehousePalletService } from './warehouse-pallet.service';

function setup(
  opts: { taskMode?: string; parse?: { rollCode: string | null; valid: boolean } } = {},
) {
  const task = {
    id: 't1',
    mode: opts.taskMode ?? 'receiving',
    status: 'open',
    orderId: 'co1',
    rows: [],
  };
  const prisma: any = {
    warehouseAcceptanceTask: {
      findUnique: jest.fn().mockResolvedValue(task),
      findMany: jest.fn().mockResolvedValue([task]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    scanRow: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
    },
    warehouseOperation: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(where.status === 'in_progress' ? null : { id: 'evidence-1' }),
        ),
    },
    warehouseRoll: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ rollCode: 'A-1024-roll-1' }),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn(),
    },
    operatorRollLine: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rollDispatchItem: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    commercialOrder: {
      findMany: jest.fn().mockResolvedValue([{ id: 'co1', orderNumber: 'A-1024' }]),
    },
    palletListDocument: {
      create: jest.fn().mockResolvedValue({ id: 'pl1' }),
      findUnique: jest.fn(),
    },
    rawMaterialStock: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    domainEvent: { findFirst: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (work: (client: typeof prisma) => unknown) => work(prisma));
  prisma.$executeRaw = jest.fn().mockResolvedValue(0);
  prisma.$queryRaw = jest.fn().mockResolvedValue([]);
  const audit = { record: jest.fn() };
  const scanner = {
    parse: jest.fn().mockReturnValue(opts.parse ?? { rollCode: 'A-1024-roll-1', valid: true }),
  };
  const onecImport = {
    pushStock: jest.fn().mockResolvedValue({ accepted: true, count: 2, ref: 'КП00-000003' }),
  };
  const persistedPaymentState: {
    shipmentCompletedAt: Date | null;
    dueDate: Date | null;
  } = {
    shipmentCompletedAt: null,
    dueDate: null,
  };
  const deferredPayment = {
    activatePostDeliveryPayments: jest.fn(
      async ({ shipmentCompletedAt }: { shipmentCompletedAt: Date }) => {
        persistedPaymentState.shipmentCompletedAt = shipmentCompletedAt;
        persistedPaymentState.dueDate = shipmentCompletedAt;
      },
    ),
  };
  const fulfillmentHandoff = {
    reconcile: jest.fn().mockResolvedValue({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'incomplete',
    }),
  };
  const operations = { expireStaleControlWeights: jest.fn().mockResolvedValue([]) };
  return {
    prisma,
    audit,
    scanner,
    onecImport,
    deferredPayment,
    persistedPaymentState,
    fulfillmentHandoff,
    operations,
  };
}

async function build(
  prisma: any,
  audit: any,
  scanner: any,
  onecImport: any = { pushStock: jest.fn() },
  deferredPayment: any = { activatePostDeliveryPayments: jest.fn() },
  fulfillmentHandoff = { reconcile: jest.fn() },
  operations = { expireStaleControlWeights: jest.fn().mockResolvedValue([]) },
  pallets = { assertNoOpenItems: jest.fn().mockResolvedValue(undefined) },
): Promise<WarehouseService> {
  const mod = await Test.createTestingModule({
    providers: [
      WarehouseService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: SCANNER_ADAPTER, useValue: scanner },
      { provide: OneCImportService, useValue: onecImport },
      { provide: DeferredPaymentService, useValue: deferredPayment },
      { provide: OrderFulfillmentHandoffService, useValue: fulfillmentHandoff },
      { provide: WarehouseOperationService, useValue: operations },
      { provide: WarehousePalletService, useValue: pallets },
      {
        provide: ProductionService,
        useValue: {
          createReplacementRoll: jest.fn().mockResolvedValue({ rollCode: 'REPL-1' }),
        },
      },
    ],
  }).compile();
  return mod.get(WarehouseService);
}

const actor = { userId: 'u1', role: 'warehouse' as const };
const RAW_SCAN_SENTINEL = 'RAW-SCANNER-SENTINEL::task-scan';

function mockRawCommandEvent(
  prisma: ReturnType<typeof setup>['prisma'],
  event: Record<string, unknown>,
): void {
  prisma.$queryRaw.mockImplementation((query: Prisma.Sql) =>
    Promise.resolve(query.sql.includes('FROM "domain_events"') ? [event] : []),
  );
}

function expectNoRawScannerInput(value: unknown, rawSentinel = RAW_SCAN_SENTINEL) {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate && typeof candidate === 'object') {
      for (const [key, nested] of Object.entries(candidate)) {
        expect([
          'lastScan',
          'payload',
          'raw',
          'rawPayload',
          'parsedPayload',
          'qrCode',
          'token',
          'scanToken',
        ]).not.toContain(key);
        visit(nested);
      }
      return;
    }
    if (typeof candidate === 'string') expect(candidate).not.toBe(rawSentinel);
  };

  visit(value);
}

describe('WarehouseService close / reserve / pallet / raw', () => {
  it('projects the safe counterparty name onto every delivery row', async () => {
    const { prisma, audit, scanner } = setup({ taskMode: 'delivery' });
    prisma.warehouseAcceptanceTask.findMany.mockResolvedValue([
      {
        id: 'delivery-1',
        mode: 'delivery',
        status: 'open',
        operationCode: 'ВЫД-2108-01',
        orderId: 'order-1',
        positionId: null,
        proposalId: null,
        createdAt: new Date('2026-08-21T12:00:00.000Z'),
        updatedAt: new Date('2026-08-21T12:00:00.000Z'),
        rows: [
          {
            id: 'row-1',
            taskId: 'delivery-1',
            rollCode: 'A-10-roll-1',
            fromOrderId: 'A-10',
            scanStatus: 'expected',
            lastScanAt: null,
            scannedByName: null,
          },
        ],
      },
    ]);
    prisma.commercialOrder.findMany.mockResolvedValue([
      {
        id: 'order-1',
        orderNumber: 'A-10',
        counterparty: { displayName: 'САФАТ ООО' },
      },
    ]);
    const service = await build(prisma, audit, scanner);

    const tasks = await service.listTasks('delivery');

    expect(tasks).toEqual([
      expect.objectContaining({
        rows: [expect.objectContaining({ customerAlias: 'САФАТ ООО' })],
      }),
    ]);
  });

  it('rejects generic close for a decision-linked reserve task before transaction locks', async () => {
    const { prisma, audit, scanner } = setup({ taskMode: 'reserve' });
    prisma.warehouseAcceptanceTask.findUnique.mockResolvedValue({
      id: 't1',
      mode: 'reserve',
      status: 'open',
      orderId: 'co1',
      coverageDecisionId: 'coverage-decision-1',
      rows: [],
    });
    const service = await build(prisma, audit, scanner);

    await expect(service.closeTask(actor, 't1', { mode: 'full' })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'warehouse_coverage_decision_managed_task',
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lists free received rolls through an explicit safe projection', async () => {
    const { prisma, audit, scanner } = setup();
    const rawSentinel = 'RAW-WAREHOUSE-ROLL-SENTINEL';
    prisma.warehouseRoll.findMany.mockResolvedValue([
      {
        id: 'roll-id-1',
        rollCode: 'STK-1',
        warehouseStatus: 'received',
        positionSnapshot: {
          filmType: '  Рукав  ',
          actualThickness: '80 мкм',
          birka: '   ',
          spoolType: '76 мм',
          plannedWeightKg: 41.2,
          rawPayload: rawSentinel,
        },
      },
    ]);
    const service = await build(prisma, audit, scanner);

    const result = await service.listRolls('free');

    expect(prisma.warehouseRoll.findMany).toHaveBeenCalledWith({
      where: {
        reservedForOrderId: null,
        OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
        warehouseStatus: 'received',
      },
      select: {
        id: true,
        rollCode: true,
        warehouseStatus: true,
        positionSnapshot: true,
      },
      orderBy: { rollCode: 'asc' },
    });
    expect(result).toEqual([
      {
        id: 'roll-id-1',
        rollCode: 'STK-1',
        warehouseStatus: 'received',
        facts: {
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          birka: null,
          spoolType: '76 мм',
          plannedWeightKg: 41.2,
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(rawSentinel);
    expect(JSON.stringify(result)).not.toContain('positionSnapshot');
  });

  it('preserves reserved and all roll ownership filters', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.warehouseRoll.findMany.mockResolvedValue([]);
    const service = await build(prisma, audit, scanner);

    await service.listRolls('reserved');
    await service.listRolls();

    expect(prisma.warehouseRoll.findMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ where: { reservedForOrderId: { not: null } } }),
    );
    expect(prisma.warehouseRoll.findMany.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ where: {} }),
    );
  });

  it('does not fully close while a physical control-weight lease is active', async () => {
    const { prisma, audit, scanner, onecImport, deferredPayment, fulfillmentHandoff, operations } =
      setup();
    prisma.scanRow.findMany.mockResolvedValue([
      {
        id: 'row-1',
        rollCode: 'A-1024-roll-1',
        fromOrderId: 'A-1024',
        scanStatus: 'accepted',
      },
    ]);
    prisma.warehouseOperation.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.status === 'in_progress'
          ? { id: 'control-in-flight', kind: 'control_weight' }
          : { id: 'scan-evidence' },
      ),
    );
    const service = await build(
      prisma,
      audit,
      scanner,
      onecImport,
      deferredPayment,
      fulfillmentHandoff,
      operations,
    );

    await expect(service.closeTask(actor, 't1', { mode: 'full' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_PHYSICAL_OPERATION_IN_PROGRESS' }),
    });
    expect(prisma.warehouseAcceptanceTask.updateMany).not.toHaveBeenCalled();
    expect(fulfillmentHandoff.reconcile).not.toHaveBeenCalled();
  });

  it('does not fully close while a non-empty physical pallet is still open', async () => {
    const { prisma, audit, scanner } = setup();
    const pallets = {
      assertNoOpenItems: jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'WAREHOUSE_OPEN_PALLET_NOT_SEALED',
          message: 'Сначала закройте и распечатайте текущий палет.',
          palletCode: 'PAL-A-1024-01',
          rollCount: 2,
        }),
      ),
    };
    const service = await build(
      prisma,
      audit,
      scanner,
      undefined,
      undefined,
      undefined,
      undefined,
      pallets,
    );

    await expect(service.closeTask(actor, 't1', { mode: 'full' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_OPEN_PALLET_NOT_SEALED' }),
    });

    expect(pallets.assertNoOpenItems).toHaveBeenCalledWith(prisma, 't1');
    expect(prisma.warehouseAcceptanceTask.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not close a receiving task when a completed row has no active sealed pallet document', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.scanRow.findMany.mockResolvedValue([
      {
        id: 'row-voided',
        rollCode: 'A-1024-roll-1',
        fromOrderId: 'A-1024',
        scanStatus: 'accepted',
      },
    ]);
    prisma.scanRow.findFirst.mockResolvedValue({
      id: 'row-voided',
      rollCode: 'A-1024-roll-1',
    });
    const service = await build(prisma, audit, scanner);

    await expect(service.closeTask(actor, 't1', { mode: 'full' })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAREHOUSE_TASK_PALLET_EVIDENCE_INCOMPLETE',
        scanRowId: 'row-voided',
        rollCode: 'A-1024-roll-1',
      }),
    });

    expect(prisma.scanRow.findFirst).toHaveBeenCalledWith({
      where: {
        taskId: 't1',
        scanStatus: { in: ['accepted', 'reserved', 'damaged'] },
        palletItems: {
          none: {
            releasedAt: null,
            pallet: {
              taskId: 't1',
              status: 'sealed',
              voidedAt: null,
              document: {
                is: {
                  acceptanceTaskId: 't1',
                  origin: 'physical_pallet',
                  voidedAt: null,
                },
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      select: { id: true, rollCode: true },
    });
    expect(prisma.warehouseAcceptanceTask.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects early close until every active roll of a canonical multi-position order is present', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.warehouseAcceptanceTask.findUnique.mockResolvedValue({
      id: 't1',
      mode: 'receiving',
      status: 'open',
      orderId: 'co1',
      receivingScopeKey: 'commercial-order:co1',
      rows: [],
    });
    prisma.scanRow.findMany.mockResolvedValue([
      {
        id: 'row-1',
        rollCode: 'A-1024-roll-1',
        fromOrderId: 'A-1024',
        scanStatus: 'accepted',
      },
    ]);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      { rollCode: 'A-1024-roll-1' },
      { rollCode: 'A-1024-roll-2' },
    ]);
    const service = await build(prisma, audit, scanner);

    await expect(service.closeTask(actor, 't1', { mode: 'full' })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAREHOUSE_ORDER_INTAKE_INCOMPLETE',
        missingRollCodes: ['A-1024-roll-2'],
      }),
    });

    expect(prisma.warehouseAcceptanceTask.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('closes the batch without fabricating inventory already captured by scans', async () => {
    const { prisma, audit, scanner, onecImport, deferredPayment, fulfillmentHandoff } = setup({
      taskMode: 'receiving',
    });
    prisma.scanRow.findMany.mockResolvedValue([
      {
        id: 'row-1',
        rollCode: 'A-1024-roll-1',
        fromOrderId: 'A-1024',
        scanStatus: 'accepted',
      },
    ]);
    const service = await build(
      prisma,
      audit,
      scanner,
      onecImport,
      deferredPayment,
      fulfillmentHandoff,
    );
    await service.closeTask(actor, 't1', { mode: 'full' });
    expect(prisma.warehouseRoll.upsert).not.toHaveBeenCalled();
    expect(prisma.operatorRollLine.updateMany).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_acceptance_task_closed',
        detail: expect.objectContaining({ orderIds: ['co1'] }),
      }),
      prisma,
    );
    expect(fulfillmentHandoff.reconcile).toHaveBeenCalledWith(actor, 'co1', prisma);
  });

  it('reconciles a fully closed reserve task in the close transaction', async () => {
    const { prisma, audit, scanner, onecImport, deferredPayment, fulfillmentHandoff } = setup({
      taskMode: 'reserve',
    });
    const service = await build(
      prisma,
      audit,
      scanner,
      onecImport,
      deferredPayment,
      fulfillmentHandoff,
    );

    await service.closeTask(actor, 't1', { mode: 'full' });

    expect(fulfillmentHandoff.reconcile).toHaveBeenCalledWith(actor, 'co1', prisma);
  });

  it('reconciles every mixed-task order in stable id order', async () => {
    const { prisma, audit, scanner, onecImport, deferredPayment, fulfillmentHandoff } = setup({
      taskMode: 'receiving',
    });
    prisma.warehouseAcceptanceTask.findUnique.mockResolvedValue({
      id: 't1',
      mode: 'receiving',
      status: 'open',
      orderId: null,
      rows: [],
    });
    prisma.scanRow.findMany.mockResolvedValue([
      { rollCode: 'ROLL-Z', fromOrderId: 'Z-ORDER', scanStatus: 'accepted' },
      { rollCode: 'ROLL-A', fromOrderId: 'A-ORDER', scanStatus: 'accepted' },
    ]);
    prisma.commercialOrder.findMany.mockResolvedValue([
      { id: 'order-z', orderNumber: 'Z-ORDER' },
      { id: 'order-a', orderNumber: 'A-ORDER' },
    ]);
    const service = await build(
      prisma,
      audit,
      scanner,
      onecImport,
      deferredPayment,
      fulfillmentHandoff,
    );

    await service.closeTask(actor, 't1', { mode: 'full' });

    expect(fulfillmentHandoff.reconcile.mock.calls).toEqual([
      [actor, 'order-a', prisma],
      [actor, 'order-z', prisma],
    ]);
  });

  it('does not reconcile a partially closed receiving task', async () => {
    const { prisma, audit, scanner, onecImport, deferredPayment, fulfillmentHandoff } = setup({
      taskMode: 'receiving',
    });
    const service = await build(
      prisma,
      audit,
      scanner,
      onecImport,
      deferredPayment,
      fulfillmentHandoff,
    );

    await service.closeTask(actor, 't1', { mode: 'partial' });

    expect(fulfillmentHandoff.reconcile).not.toHaveBeenCalled();
  });

  it('closing a delivery task audits only the batch close and activates payment once', async () => {
    const { prisma, audit, scanner, onecImport, deferredPayment, fulfillmentHandoff } = setup({
      taskMode: 'delivery',
    });
    prisma.scanRow.findMany.mockResolvedValue([
      {
        id: 'row-1',
        rollCode: 'A-1024-roll-1',
        fromOrderId: 'A-1024',
        scanStatus: 'accepted',
      },
    ]);
    const service = await build(
      prisma,
      audit,
      scanner,
      onecImport,
      deferredPayment,
      fulfillmentHandoff,
    );
    await service.closeTask(actor, 't1', { mode: 'full' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_acceptance_task_closed',
        detail: expect.objectContaining({ orderIds: ['co1'], orderNumbers: ['A-1024'] }),
      }),
      prisma,
    );
    expect(fulfillmentHandoff.reconcile).not.toHaveBeenCalled();
    expect(deferredPayment.activatePostDeliveryPayments).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        orderNumbers: ['A-1024'],
        warehouseTaskId: 't1',
        shipmentCompletedAt: expect.any(Date),
      }),
      prisma,
    );
  });

  it('closes a delivery task inside the caller transaction without opening a nested transaction', async () => {
    const { prisma, audit, scanner, deferredPayment, fulfillmentHandoff } = setup({
      taskMode: 'delivery',
    });
    prisma.scanRow.findMany.mockResolvedValue([
      {
        id: 'row-1',
        rollCode: 'A-1024-roll-1',
        fromOrderId: 'A-1024',
        scanStatus: 'accepted',
      },
    ]);
    const service = await build(
      prisma,
      audit,
      scanner,
      undefined,
      deferredPayment,
      fulfillmentHandoff,
    );

    await service.closeTaskInTransaction(actor, 't1', { mode: 'full' }, prisma);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', status: 'open' },
      data: { status: 'closed' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_acceptance_task_closed' }),
      prisma,
    );
    expect(deferredPayment.activatePostDeliveryPayments).toHaveBeenCalledTimes(1);
  });

  it('returns an already closed task without changing rolls, payments, or events', async () => {
    const { prisma, audit, scanner, onecImport, deferredPayment } = setup({
      taskMode: 'delivery',
    });
    const closedTask = {
      id: 't1',
      mode: 'delivery',
      status: 'closed',
      orderId: 'co1',
      rows: [{ id: 'row-1', rollCode: 'A-1024-roll-1' }],
    };
    prisma.warehouseAcceptanceTask.findUnique.mockResolvedValue(closedTask);
    const service = await build(prisma, audit, scanner, onecImport, deferredPayment);

    const result = await service.closeTask(actor, 't1', { mode: 'full' });

    expect(result).toEqual(
      expect.objectContaining({
        id: closedTask.id,
        mode: closedTask.mode,
        status: closedTask.status,
        rows: [expect.objectContaining({ rollCode: 'A-1024-roll-1' })],
      }),
    );
    expectNoRawScannerInput(result);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.scanRow.count).not.toHaveBeenCalled();
    expect(prisma.scanRow.findMany).not.toHaveBeenCalled();
    expect(prisma.warehouseRoll.upsert).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.update).not.toHaveBeenCalled();
    expect(deferredPayment.activatePostDeliveryPayments).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rolls back every received roll and task fact when the close event fails', async () => {
    type State = {
      taskStatus: string;
      rollStatuses: Record<string, string>;
      operatorState: string;
      dispatchState: string;
    };
    let committed: State = {
      taskStatus: 'open',
      rollStatuses: {
        'A-1024-roll-1': 'sent',
        'A-1024-roll-2': 'sent',
      },
      operatorState: 'sent',
      dispatchState: 'ready_for_warehouse',
    };
    let active: State | null = null;
    const state = () => active ?? committed;
    const rows = ['A-1024-roll-1', 'A-1024-roll-2'].map((rollCode, index) => ({
      id: `row-${index + 1}`,
      rollCode,
      fromOrderId: 'A-1024',
      scanStatus: 'accepted',
    }));
    const client: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      warehouseAcceptanceTask: {
        findUnique: jest.fn(async () => ({
          id: 't1',
          mode: 'receiving',
          status: state().taskStatus,
          orderId: 'co1',
          rows,
        })),
        update: jest.fn(async ({ data }: any) => {
          state().taskStatus = data.status;
        }),
        updateMany: jest.fn(async ({ data }: any) => {
          state().taskStatus = data.status;
          return { count: 1 };
        }),
      },
      scanRow: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue(rows),
      },
      warehouseOperation: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(where.status === 'in_progress' ? null : { id: 'scan-evidence' }),
          ),
      },
      warehouseRoll: {
        upsert: jest.fn(async ({ where, update }: any) => {
          state().rollStatuses[where.rollCode] = update.warehouseStatus;
          return { rollCode: where.rollCode };
        }),
      },
      operatorRollLine: {
        updateMany: jest.fn(async ({ data }: any) => {
          state().operatorState = data.warehouseState;
          return { count: 2 };
        }),
      },
      rollDispatchItem: {
        updateMany: jest.fn(async ({ data }: any) => {
          state().dispatchState = data.status;
          return { count: 2 };
        }),
      },
      commercialOrder: {
        findMany: jest.fn().mockResolvedValue([{ id: 'co1', orderNumber: 'A-1024' }]),
      },
      domainEvent: {
        create: jest.fn().mockRejectedValue(new Error('warehouse event write failed')),
      },
    };
    const prisma: any = { ...client };
    prisma.$transaction = jest.fn(async (operation: (tx: any) => unknown) => {
      active = { ...committed, rollStatuses: { ...committed.rollStatuses } };
      try {
        const result = await operation(client);
        committed = { ...active, rollStatuses: { ...active.rollStatuses } };
        return result;
      } finally {
        active = null;
      }
    });
    const audit = new AuditService(prisma);
    const service = await build(prisma, audit, { parse: jest.fn() });

    await expect(service.closeTask(actor, 't1', { mode: 'full' })).rejects.toThrow(
      'warehouse event write failed',
    );

    expect(committed).toEqual({
      taskStatus: 'open',
      rollStatuses: {
        'A-1024-roll-1': 'sent',
        'A-1024-roll-2': 'sent',
      },
      operatorState: 'sent',
      dispatchState: 'ready_for_warehouse',
    });
  });

  it('partial delivery leaves shipment and deferred due dates unpersisted', async () => {
    const {
      prisma,
      audit,
      scanner,
      onecImport,
      deferredPayment,
      fulfillmentHandoff,
      persistedPaymentState,
    } = setup({ taskMode: 'delivery' });
    prisma.scanRow.findMany.mockResolvedValue([
      { rollCode: 'A-1024-roll-1', fromOrderId: 'A-1024' },
    ]);
    const service = await build(
      prisma,
      audit,
      scanner,
      onecImport,
      deferredPayment,
      fulfillmentHandoff,
    );

    await service.closeTask(actor, 't1', { mode: 'partial' });

    expect(deferredPayment.activatePostDeliveryPayments).not.toHaveBeenCalled();
    expect(fulfillmentHandoff.reconcile).not.toHaveBeenCalled();
    expect(persistedPaymentState).toEqual({
      shipmentCompletedAt: null,
      dueDate: null,
    });
  });

  it('reserve and release emit the matching audit events', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.warehouseRoll.findUnique.mockResolvedValue({
      rollCode: 'A-1024-roll-1',
      reservedForOrderId: null,
      reservedByCoverageDecisionId: null,
    });
    prisma.warehouseRoll.update.mockResolvedValue({ rollCode: 'A-1024-roll-1' });
    const service = await build(prisma, audit, scanner);
    await service.reserveRoll(actor, 'A-1024-roll-1', { orderId: 'co1' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:roll_reserved_for_order' }),
      prisma,
    );
    await service.releaseReserve(actor, 'A-1024-roll-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:roll_reservation_released' }),
    );
  });

  it.each(['reserve', 'release'] as const)(
    'rejects generic %s for a decision-managed roll before idempotent or write paths',
    async (command) => {
      const { prisma, audit, scanner } = setup();
      prisma.warehouseRoll.findUnique.mockResolvedValue({
        rollCode: 'A-1024-roll-1',
        reservedForOrderId: 'co1',
        reservedByCoverageDecisionId: 'coverage-decision-1',
      });
      const service = await build(prisma, audit, scanner);

      const promise =
        command === 'reserve'
          ? service.reserveRoll(actor, 'A-1024-roll-1', { orderId: 'co1' })
          : service.releaseReserve(actor, 'A-1024-roll-1');
      await expect(promise).rejects.toMatchObject({
        response: {
          statusCode: 409,
          code: 'warehouse_coverage_decision_managed_reservation',
          decisionId: 'coverage-decision-1',
        },
      });
      expect(prisma.warehouseRoll.updateMany).not.toHaveBeenCalled();
      expect(prisma.warehouseRoll.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each(['reserve', 'release'] as const)(
    'rejects generic %s for a client-produced roll',
    async (command) => {
      const { prisma, audit, scanner } = setup();
      prisma.warehouseRoll.findUnique.mockResolvedValue({
        rollCode: 'A-1024-roll-1',
        reservedForOrderId: null,
        reservedByCoverageDecisionId: null,
        producedByCoverageDecisionId: 'production-decision-1',
      });
      const service = await build(prisma, audit, scanner);

      const promise =
        command === 'reserve'
          ? service.reserveRoll(actor, 'A-1024-roll-1', { orderId: 'co1' })
          : service.releaseReserve(actor, 'A-1024-roll-1');
      await expect(promise).rejects.toMatchObject({
        response: {
          statusCode: 409,
          code: 'warehouse_production_managed_roll',
          decisionId: 'production-decision-1',
        },
      });
      expect(prisma.warehouseRoll.updateMany).not.toHaveBeenCalled();
      expect(prisma.warehouseRoll.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('createPalletList audits pallet_list_print_requested', async () => {
    const { prisma, audit, scanner } = setup();
    const service = await build(prisma, audit, scanner);
    await service.createPalletList(actor, { palletId: 'P-1', rollIds: ['A-1024-roll-1'] });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:pallet_list_created' }),
    );
  });

  it('rejects a new pallet list that explicitly mixes commercial orders', async () => {
    const { prisma, audit, scanner } = setup();
    const service = await build(prisma, audit, scanner);

    await expect(
      service.createPalletList(actor, {
        palletId: 'P-1',
        rollIds: ['A-1024-roll-1', 'B-2048-roll-1'],
        orderIds: ['co-1', 'co-2', 'co-1'],
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'WAREHOUSE_MIXED_PALLET_FORBIDDEN',
      },
    });
    expect(prisma.palletListDocument.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('adjusting stock to zero audits a correction AND a shortage problem', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.rawMaterialStock.findUnique.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 100,
    });
    prisma.rawMaterialStock.update.mockResolvedValue({ materialId: 'rm-pvd-15803', actualQty: 0 });
    const service = await build(prisma, audit, scanner);
    await service.adjustRawMaterial(actor, 'rm-pvd-15803', {
      operationKey: '11111111-1111-4111-8111-111111111111',
      actualQty: 0,
      reason: 'spent',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:inventory_manual_correction' }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'problem:raw_material_shortage' }),
      prisma,
    );
  });

  it('claims the global command key before lookup, then locks and rereads raw stock', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.rawMaterialStock.findUnique.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 100,
    });
    prisma.rawMaterialStock.update.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 75,
    });
    const service = await build(prisma, audit, scanner);

    await service.adjustRawMaterial(actor, 'rm-pvd-15803', {
      operationKey: '22222222-2222-4222-8222-222222222222',
      actualQty: 75,
      reason: 'inventory count',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const commandLockQuery = prisma.$executeRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(commandLockQuery.sql).toContain('pg_advisory_xact_lock');
    expect(commandLockQuery.sql).toContain('hashtextextended');
    expect(commandLockQuery.values).toContain(
      'warehouse-raw-command:22222222-2222-4222-8222-222222222222',
    );
    const commandLookupQuery = prisma.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(commandLookupQuery.sql).toContain('FROM "domain_events"');
    expect(commandLookupQuery.sql).toContain(`lower("detail"->>'operationKey')`);
    expect(commandLookupQuery.sql).not.toMatch(/WHERE[\s\S]*"objectId"\s*=/u);
    expect(commandLookupQuery.values).toEqual(
      expect.arrayContaining([
        'audit:inventory_manual_correction',
        'audit:raw_material_received',
        '22222222-2222-4222-8222-222222222222',
      ]),
    );
    const lockQuery = prisma.$queryRaw.mock.calls[1]?.[0] as Prisma.Sql;
    expect(lockQuery.sql).toContain('FROM "raw_material_stocks"');
    expect(lockQuery.sql).toContain('FOR UPDATE');
    expect(lockQuery.values).toContain('rm-pvd-15803');
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$queryRaw.mock.invocationCallOrder[0],
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$queryRaw.mock.invocationCallOrder[1],
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.rawMaterialStock.findUnique.mock.invocationCallOrder[0],
    );
    expect(prisma.rawMaterialStock.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.rawMaterialStock.update.mock.invocationCallOrder[0],
    );
    expect(audit.record).toHaveBeenCalledWith(expect.any(Object), prisma);
  });

  it('replays an exact raw-material adjustment key without a second stock or audit fact', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.rawMaterialStock.findUnique.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 75,
      factStatus: 'manual',
    });
    mockRawCommandEvent(prisma, {
      type: 'audit:inventory_manual_correction',
      objectId: 'rm-pvd-15803',
      actorId: 'u1',
      actorRole: 'warehouse',
      reason: 'inventory count',
      detail: {
        operationKey: 'abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase(),
        actualQty: 75,
      },
    });
    const service = await build(prisma, audit, scanner);

    const result = await service.adjustRawMaterial(actor, 'rm-pvd-15803', {
      operationKey: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
      actualQty: 75,
      reason: 'inventory count',
    });

    expect(result).toEqual(expect.objectContaining({ actualQty: 75 }));
    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects reuse of a raw-material adjustment key with a changed payload', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.rawMaterialStock.findUnique.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 75,
      factStatus: 'manual',
    });
    mockRawCommandEvent(prisma, {
      type: 'audit:inventory_manual_correction',
      objectId: 'rm-pvd-15803',
      actorId: 'u1',
      actorRole: 'warehouse',
      reason: 'inventory count',
      detail: {
        operationKey: '22222222-2222-4222-8222-222222222222',
        actualQty: 75,
      },
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.adjustRawMaterial(actor, 'rm-pvd-15803', {
        operationKey: '22222222-2222-4222-8222-222222222222',
        actualQty: 74,
        reason: 'inventory count',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'RAW_MATERIAL_OPERATION_KEY_REUSED' },
    });
    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an adjustment key already claimed for another raw material before stock access', async () => {
    const { prisma, audit, scanner } = setup();
    mockRawCommandEvent(prisma, {
      type: 'audit:inventory_manual_correction',
      objectId: 'rm-first-material',
      actorId: 'u1',
      actorRole: 'warehouse',
      reason: 'inventory count',
      detail: {
        operationKey: '22222222-2222-4222-8222-222222222222',
        actualQty: 75,
      },
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.adjustRawMaterial(actor, 'rm-second-material', {
        operationKey: '22222222-2222-4222-8222-222222222222',
        actualQty: 75,
        reason: 'inventory count',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'RAW_MATERIAL_OPERATION_KEY_REUSED' },
    });

    expect(prisma.rawMaterialStock.findUnique).not.toHaveBeenCalled();
    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('adds a raw-material receipt to the locked warehouse fact and audits the quantity delta', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.rawMaterialStock.findUnique.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 100,
    });
    prisma.domainEvent.findFirst.mockResolvedValue(null);
    prisma.rawMaterialStock.update.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 125.5,
    });
    const service = await build(prisma, audit, scanner);

    await service.receiveRawMaterial(actor, 'rm-pvd-15803', {
      operationKey: '11111111-1111-4111-8111-111111111111',
      receivedQty: 25.5,
      reason: 'Накладная № 42',
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.rawMaterialStock.update).toHaveBeenCalledWith({
      where: { materialId: 'rm-pvd-15803' },
      data: { actualQty: 125.5, factStatus: 'warehouse_fact' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        type: 'audit:raw_material_received',
        actorRole: 'warehouse',
        actorId: 'u1',
        objectId: 'rm-pvd-15803',
        reason: 'Накладная № 42',
        oldValue: { actualQty: 100 },
        newValue: { actualQty: 125.5 },
        detail: {
          operationKey: '11111111-1111-4111-8111-111111111111',
          receivedQty: 25.5,
        },
      },
      prisma,
    );
  });

  it('replays the same raw-material receipt key without incrementing or auditing twice', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.rawMaterialStock.findUnique.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 125.5,
    });
    mockRawCommandEvent(prisma, {
      type: 'audit:raw_material_received',
      objectId: 'rm-pvd-15803',
      actorId: 'u1',
      actorRole: 'warehouse',
      reason: 'Накладная № 42',
      detail: {
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
        receivedQty: 25.5,
      },
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.receiveRawMaterial(actor, 'rm-pvd-15803', {
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        receivedQty: 25.5,
        reason: 'Накладная № 42',
      }),
    ).resolves.toEqual(expect.objectContaining({ actualQty: 125.5 }));

    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects reusing a raw-material receipt key with another payload', async () => {
    const { prisma, audit, scanner } = setup();
    prisma.rawMaterialStock.findUnique.mockResolvedValue({
      materialId: 'rm-pvd-15803',
      actualQty: 125.5,
    });
    mockRawCommandEvent(prisma, {
      type: 'audit:raw_material_received',
      objectId: 'rm-pvd-15803',
      actorId: 'u1',
      actorRole: 'warehouse',
      reason: 'Накладная № 42',
      detail: {
        operationKey: '11111111-1111-4111-8111-111111111111',
        receivedQty: 25.5,
      },
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.receiveRawMaterial(actor, 'rm-pvd-15803', {
        operationKey: '11111111-1111-4111-8111-111111111111',
        receivedQty: 30,
        reason: 'Другая накладная',
      }),
    ).rejects.toThrow(ConflictException);

    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a receipt key claimed by another raw command kind before stock access', async () => {
    const { prisma, audit, scanner } = setup();
    mockRawCommandEvent(prisma, {
      type: 'audit:inventory_manual_correction',
      objectId: 'rm-pvd-15803',
      actorId: 'u1',
      actorRole: 'warehouse',
      reason: 'Накладная № 42',
      detail: {
        operationKey: '11111111-1111-4111-8111-111111111111',
        actualQty: 25.5,
      },
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.receiveRawMaterial(actor, 'rm-pvd-15803', {
        operationKey: '11111111-1111-4111-8111-111111111111',
        receivedQty: 25.5,
        reason: 'Накладная № 42',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'RAW_MATERIAL_OPERATION_KEY_REUSED' },
    });

    expect(prisma.rawMaterialStock.findUnique).not.toHaveBeenCalled();
    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an otherwise exact receipt replay by another actor before stock access', async () => {
    const { prisma, audit, scanner } = setup();
    mockRawCommandEvent(prisma, {
      type: 'audit:raw_material_received',
      objectId: 'rm-pvd-15803',
      actorId: 'another-user',
      actorRole: 'warehouse',
      reason: 'Накладная № 42',
      detail: {
        operationKey: '11111111-1111-4111-8111-111111111111',
        receivedQty: 25.5,
      },
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.receiveRawMaterial(actor, 'rm-pvd-15803', {
        operationKey: '11111111-1111-4111-8111-111111111111',
        receivedQty: 25.5,
        reason: 'Накладная № 42',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'RAW_MATERIAL_OPERATION_KEY_REUSED' },
    });

    expect(prisma.rawMaterialStock.findUnique).not.toHaveBeenCalled();
    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('WarehouseService cover checks', () => {
  const requestedAt = new Date('2026-07-15T08:00:00.000Z');
  const updatedAt = new Date('2026-07-15T09:00:00.000Z');
  type CoverCheckQuery = { cursor?: string; limit?: number; state?: 'open' };
  type CoverCheckPage = {
    items: Array<{ caseId: string; positions: Array<{ id: string }> }>;
    nextCursor: string | null;
  };

  function listCoverChecks(
    service: WarehouseService,
    role: 'warehouse',
    query: CoverCheckQuery,
  ): Promise<CoverCheckPage> {
    return (
      service as unknown as {
        listCoverChecks(role: 'warehouse', query: CoverCheckQuery): Promise<CoverCheckPage>;
      }
    ).listCoverChecks(role, query);
  }

  function coverCase(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      orderId: `order-${id}`,
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: `warehouse_cover:order-${id}`,
      affectedPositionIds: [`position-${id}`],
      createdAt: requestedAt,
      updatedAt,
      order: {
        id: `order-${id}`,
        orderNumber: `A-${id}`,
        commercialStage: 'incoming',
        shipmentStatus: 'not_shipped',
        counterparty: {
          displayName: `Alias ${id}`,
          legalName: `Sensitive legal ${id}`,
          inn: '7700000000',
          billingSource: 'raw-1c',
        },
        positions: [
          {
            id: `position-${id}`,
            rollCount: 2,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            rawMaterialId: 'rm-pvd',
            spoolType: 'Шпуля 76 мм',
            birka: 'ГОСТ',
            plannedWeightKg: 41.2,
            warehouseCoverStatus: 'recheck_requested',
          },
        ],
        financeOrder: { amountValue: 999_000 },
        rawPayload: { source: 'must-not-leak' },
      },
      ...overrides,
    };
  }

  function coverSetup() {
    const { prisma, audit, scanner } = setup();
    prisma.commercialOrder = {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(),
    };
    prisma.orderResolutionCase = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'case-1',
        orderId: 'o1',
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        openScopeKey: 'warehouse_cover:o1',
        affectedPositionIds: ['p1'],
        version: 1,
        createdAt: requestedAt,
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    prisma.commercialOrderPosition = {
      findFirst: jest.fn(),
      update: jest.fn(),
    };
    prisma.warehouseCoverProposal = {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'wp1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
    };
    return { prisma, audit, scanner };
  }

  it('listCoverChecks returns an explicit safe page of open warehouse cover cases', async () => {
    const { prisma, audit, scanner } = coverSetup();
    prisma.orderResolutionCase.findMany.mockResolvedValue([coverCase('case-1')]);
    const service = await build(prisma, audit, scanner);
    const page = await listCoverChecks(service, 'warehouse', { state: 'open', limit: 20 });

    expect(prisma.orderResolutionCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: 'warehouse_cover_check',
          status: 'open',
          ownerRole: 'warehouse',
          openScopeKey: { not: null },
          order: expect.objectContaining({
            commercialStage: { in: ['incoming', 'sent_to_finance', 'in_work'] },
            shipmentStatus: { not: 'shipped' },
            readyForShipmentAt: null,
            shipmentCompletedAt: null,
          }),
        }),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    expect(prisma.commercialOrder.findMany).not.toHaveBeenCalled();
    expect(page).toEqual({
      items: [
        expect.objectContaining({
          caseId: 'case-1',
          orderId: 'order-case-1',
          orderNumber: 'A-case-1',
          customerAlias: 'Alias case-1',
          state: 'open',
          positions: [
            expect.objectContaining({
              id: 'position-case-1',
              filmType: 'Рукав',
              actualThickness: '80 мкм',
              accountingThickness: '78 мкм',
              rawMaterialId: 'rm-pvd',
              spoolType: 'Шпуля 76 мм',
              birka: 'ГОСТ',
              plannedWeightKg: 41.2,
            }),
          ],
        }),
      ],
      nextCursor: null,
    });
    const serialized = JSON.stringify(page);
    for (const forbidden of [
      'legalName',
      'Sensitive legal',
      'inn',
      '7700000000',
      'financeOrder',
      'amountValue',
      'rawPayload',
      'must-not-leak',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('listCoverChecks projects only positions affected by the open cover case', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const row = coverCase('case-scoped') as {
      affectedPositionIds: string[];
      order: { positions: Array<Record<string, unknown>> };
    };
    row.affectedPositionIds = ['p2'];
    row.order.positions = [
      { ...row.order.positions[0], id: 'p1', warehouseCoverStatus: 'full_proposed' },
      { ...row.order.positions[0], id: 'p2', warehouseCoverStatus: 'recheck_requested' },
    ];
    prisma.orderResolutionCase.findMany.mockResolvedValue([row]);
    const service = await build(prisma, audit, scanner);

    const page = await listCoverChecks(service, 'warehouse', { state: 'open', limit: 20 });

    expect(page.items[0]?.positions.map((position) => position.id)).toEqual(['p2']);
  });

  it('listCoverChecks never scans legacy not_checked orders without an explicit case', async () => {
    const { prisma, audit, scanner } = coverSetup();
    prisma.commercialOrder.findMany.mockResolvedValue([
      {
        id: 'legacy-not-checked',
        commercialStage: 'incoming',
        warehouseCoverStatus: 'not_checked',
        counterparty: {
          id: 'cp-legacy',
          displayName: 'Legacy alias',
          legalName: null,
          inn: null,
          billingSource: 'manual_platform',
          syncStatus: 'ready',
        },
        positions: [],
      },
      {
        id: 'draft',
        commercialStage: 'draft',
        warehouseCoverStatus: 'recheck_requested',
        counterparty: {
          id: 'cp-draft',
          displayName: 'Draft alias',
          legalName: null,
          inn: null,
          billingSource: 'manual_platform',
          syncStatus: 'ready',
        },
        positions: [],
      },
    ]);
    const service = await build(prisma, audit, scanner);

    await expect(
      listCoverChecks(service, 'warehouse', { state: 'open', limit: 20 }),
    ).resolves.toEqual({ items: [], nextCursor: null });

    expect(prisma.commercialOrder.findMany).not.toHaveBeenCalled();
  });

  it('listCoverChecks paginates with a stable updatedAt/id cursor and bounded limit', async () => {
    const { prisma, audit, scanner } = coverSetup();
    prisma.orderResolutionCase.findMany.mockResolvedValueOnce([
      coverCase('case-3', { updatedAt: new Date('2026-07-15T10:00:00.000Z') }),
      coverCase('case-2', { updatedAt }),
      coverCase('case-1', { updatedAt }),
    ]);
    const service = await build(prisma, audit, scanner);

    const first = await listCoverChecks(service, 'warehouse', { state: 'open', limit: 2 });

    expect(first).toEqual({
      items: [
        expect.objectContaining({ caseId: 'case-3' }),
        expect.objectContaining({ caseId: 'case-2' }),
      ],
      nextCursor: expect.any(String),
    });
    if (!first.nextCursor) throw new Error('Expected a next cursor for the first page');
    prisma.orderResolutionCase.findMany.mockResolvedValueOnce([coverCase('case-1')]);

    const second = await listCoverChecks(service, 'warehouse', {
      state: 'open',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    expect(second.items.map((item) => item.caseId)).toEqual(['case-1']);
    expect(second.nextCursor).toBeNull();
    expect(prisma.orderResolutionCase.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: 'case-2' } }],
        }),
        take: 3,
      }),
    );
  });

  it('proposes exact compatible rolls for one position and stores five criteria', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const target = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'Гост',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'not_checked',
    };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...target,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        positions: [target],
      },
    });
    prisma.warehouseCoverProposal.findMany.mockResolvedValue([
      {
        id: 'proposal-p1-current',
        positionId: 'p1',
        status: 'full_proposed',
        createdAt: updatedAt,
        expiresAt: null,
      },
    ]);
    prisma.warehouseRoll.findMany.mockResolvedValue([
      {
        id: 'roll-1',
        rollCode: 'STK-1',
        reservedForOrderId: null,
        warehouseStatus: 'received',
        positionSnapshot: {
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          birka: 'Гост',
          spoolType: '76 мм',
          plannedWeightKg: 41.2,
        },
      },
    ]);
    const service = await build(prisma, audit, scanner);
    await service.proposeCover(actor, 'o1', { positionId: 'p1', rollIds: ['roll-1'] });
    expect(prisma.warehouseCoverProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          positionId: 'p1',
          coverType: 'full',
          coverQty: 1,
          reserveQty: 0,
          status: 'full_proposed',
          matchedRollIds: ['roll-1'],
          matches: {
            create: [
              expect.objectContaining({
                rollId: 'roll-1',
                compatible: true,
                criteria: expect.objectContaining({
                  filmType: expect.objectContaining({ matches: true }),
                  actualThickness: expect.objectContaining({ matches: true }),
                  birka: expect.objectContaining({ matches: true }),
                  spoolType: expect.objectContaining({ matches: true }),
                  weight: expect.objectContaining({ matches: true }),
                }),
              }),
            ],
          },
        }),
      }),
    );
    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ warehouseCoverStatus: 'full_proposed' }),
      }),
    );
    expect(prisma.warehouseCoverProposal.findMany).toHaveBeenCalledWith({
      where: {
        orderId: 'o1',
        positionId: { in: ['p1'] },
        createdAt: { gte: requestedAt },
      },
      select: {
        id: true,
        positionId: true,
        status: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: [{ positionId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_cover_proposed',
        objectId: 'o1',
        detail: expect.objectContaining({ caseId: 'case-1', proposalId: 'wp1' }),
      }),
      prisma,
    );
    expect(prisma.orderResolutionCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'case-1',
        status: 'open',
        version: 1,
        openScopeKey: 'warehouse_cover:o1',
      },
      data: {
        status: 'resolved',
        openScopeKey: null,
        outcome: 'cover_proposed_for_all_positions',
        nextOwnerRole: 'commercial',
        resolvedAt: expect.any(Date),
        version: { increment: 1 },
      },
    });
  });

  it('rejects the legacy warehouse proposal route for V2 before proposal mutation', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const target = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'Гост',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'not_checked',
    };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...target,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 2,
        positions: [target],
      },
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.proposeCover(actor, 'o1', { positionId: 'p1', rollIds: [] }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'warehouse_coverage_workflow_mismatch',
        expected: 1,
        actual: 2,
      },
    });
    expect(prisma.orderResolutionCase.findUnique).not.toHaveBeenCalled();
    expect(prisma.warehouseCoverProposal.create).not.toHaveBeenCalled();
    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps the cover case open until every order position has a current proposal', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const first = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'ГОСТ',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'not_checked',
    };
    const second = { ...first, id: 'p2' };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...first,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        positions: [first, second],
      },
    });
    prisma.orderResolutionCase.findUnique.mockResolvedValue({
      id: 'case-1',
      orderId: 'o1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:o1',
      affectedPositionIds: ['p1', 'p2'],
      version: 1,
      createdAt: requestedAt,
    });
    prisma.warehouseRoll.findMany.mockResolvedValue([]);
    prisma.warehouseCoverProposal.findMany.mockResolvedValue([
      {
        id: 'proposal-p1-current',
        positionId: 'p1',
        status: 'partial_proposed',
        createdAt: updatedAt,
        expiresAt: null,
      },
    ]);
    const service = await build(prisma, audit, scanner);

    await service.proposeCover(actor, 'o1', { positionId: 'p1', rollIds: [] });

    expect(prisma.orderResolutionCase.updateMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_cover_proposed' }),
      prisma,
    );
  });

  it('keeps the order in recheck while another scoped position still awaits reproposal', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const awaitingRecheck = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'ГОСТ',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'recheck_requested',
    };
    const proposed = {
      ...awaitingRecheck,
      id: 'p2',
      warehouseCoverStatus: 'not_checked',
    };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...proposed,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        positions: [awaitingRecheck, proposed],
      },
    });
    prisma.orderResolutionCase.findUnique.mockResolvedValue({
      id: 'case-1',
      orderId: 'o1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:o1',
      affectedPositionIds: ['p1', 'p2'],
      version: 1,
      createdAt: requestedAt,
    });
    prisma.warehouseCoverProposal.findMany.mockResolvedValue([
      {
        id: 'proposal-p2-current',
        positionId: 'p2',
        status: 'partial_proposed',
        createdAt: updatedAt,
        expiresAt: null,
      },
    ]);
    const service = await build(prisma, audit, scanner);

    await service.proposeCover(actor, 'o1', { positionId: 'p2', rollIds: [] });

    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ warehouseCoverStatus: 'recheck_requested' }),
      }),
    );
    expect(prisma.orderResolutionCase.updateMany).not.toHaveBeenCalled();
  });

  it('closes a position-scoped recheck after that position receives a fresh proposal', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const first = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'ГОСТ',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'full_proposed',
    };
    const second = { ...first, id: 'p2', warehouseCoverStatus: 'recheck_requested' };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...second,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        positions: [first, second],
      },
    });
    prisma.orderResolutionCase.findUnique.mockResolvedValue({
      id: 'case-1',
      orderId: 'o1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:o1',
      affectedPositionIds: ['p2'],
      version: 1,
      createdAt: requestedAt,
    });
    prisma.warehouseRoll.findMany.mockResolvedValue([]);
    prisma.warehouseCoverProposal.findMany.mockResolvedValue([
      {
        id: 'proposal-p2-current',
        positionId: 'p2',
        status: 'partial_proposed',
        createdAt: new Date('2026-07-15T09:00:00.000Z'),
        expiresAt: null,
      },
    ]);
    const service = await build(prisma, audit, scanner);

    await service.proposeCover(actor, 'o1', { positionId: 'p2', rollIds: [] });

    expect(prisma.warehouseCoverProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ positionId: { in: ['p2'] } }),
      }),
    );
    expect(prisma.orderResolutionCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'case-1' }),
        data: expect.objectContaining({ status: 'resolved', openScopeKey: null }),
      }),
    );
  });

  it('rejects a cover case whose scoped position no longer belongs to the order', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const target = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'ГОСТ',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'recheck_requested',
    };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...target,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        positions: [target],
      },
    });
    prisma.orderResolutionCase.findUnique.mockResolvedValue({
      id: 'case-1',
      orderId: 'o1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:o1',
      affectedPositionIds: ['deleted-position'],
      version: 1,
      createdAt: requestedAt,
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.proposeCover(actor, 'o1', { positionId: 'p1', rollIds: [] }),
    ).rejects.toThrow('Warehouse cover task contains positions outside the current order');

    expect(prisma.warehouseCoverProposal.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects proposing cover for a position outside the active case before mutations', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const target = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'ГОСТ',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'full_proposed',
    };
    const scoped = { ...target, id: 'p2', warehouseCoverStatus: 'recheck_requested' };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...target,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        positions: [target, scoped],
      },
    });
    prisma.orderResolutionCase.findUnique.mockResolvedValue({
      id: 'case-1',
      orderId: 'o1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:o1',
      affectedPositionIds: ['p2'],
      version: 1,
      createdAt: requestedAt,
    });
    const service = await build(prisma, audit, scanner);

    await expect(
      service.proposeCover(actor, 'o1', { positionId: 'p1', rollIds: [] }),
    ).rejects.toThrow('Position p1 is outside the active warehouse cover task');

    expect(prisma.warehouseCoverProposal.create).not.toHaveBeenCalled();
    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
    expect(prisma.orderResolutionCase.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps the case open when another position has only an expired proposal', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
    try {
      const { prisma, audit, scanner } = coverSetup();
      const first = {
        id: 'p1',
        orderId: 'o1',
        rollCount: 1,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        birka: 'ГОСТ',
        spoolType: 'Шпуля 76 мм',
        plannedWeightKg: 41.2,
        warehouseCoverStatus: 'full_proposed',
      };
      const second = { ...first, id: 'p2', warehouseCoverStatus: 'not_checked' };
      prisma.commercialOrderPosition.findFirst.mockResolvedValue({
        ...second,
        order: {
          id: 'o1',
          orderNumber: 'A-1',
          warehouseCoverageWorkflowVersion: 1,
          positions: [first, second],
        },
      });
      prisma.orderResolutionCase.findUnique.mockResolvedValue({
        id: 'case-1',
        orderId: 'o1',
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        openScopeKey: 'warehouse_cover:o1',
        affectedPositionIds: ['p1', 'p2'],
        version: 1,
        createdAt: requestedAt,
      });
      prisma.warehouseRoll.findMany.mockResolvedValue([]);
      prisma.warehouseCoverProposal.findMany.mockResolvedValue([
        {
          id: 'proposal-p2-current',
          positionId: 'p2',
          status: 'partial_proposed',
          createdAt: new Date('2026-07-15T10:00:00.000Z'),
          expiresAt: null,
        },
        {
          id: 'proposal-p1-expired',
          positionId: 'p1',
          status: 'full_proposed',
          createdAt: new Date('2026-07-15T09:00:00.000Z'),
          expiresAt: new Date('2026-07-15T09:30:00.000Z'),
        },
      ]);
      const service = await build(prisma, audit, scanner);

      await service.proposeCover(actor, 'o1', { positionId: 'p2', rollIds: [] });

      expect(prisma.warehouseCoverProposal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            orderId: 'o1',
            positionId: { in: ['p1', 'p2'] },
            createdAt: { gte: requestedAt },
          },
          select: expect.objectContaining({ status: true }),
          orderBy: [{ positionId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(prisma.orderResolutionCase.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses the newest proposal before applying completion eligibility', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
    try {
      const { prisma, audit, scanner } = coverSetup();
      const first = {
        id: 'p1',
        orderId: 'o1',
        rollCount: 1,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        birka: 'ГОСТ',
        spoolType: 'Шпуля 76 мм',
        plannedWeightKg: 41.2,
        warehouseCoverStatus: 'recheck_requested',
      };
      const second = { ...first, id: 'p2', warehouseCoverStatus: 'not_checked' };
      prisma.commercialOrderPosition.findFirst.mockResolvedValue({
        ...second,
        order: {
          id: 'o1',
          orderNumber: 'A-1',
          warehouseCoverageWorkflowVersion: 1,
          positions: [first, second],
        },
      });
      prisma.orderResolutionCase.findUnique.mockResolvedValue({
        id: 'case-1',
        orderId: 'o1',
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        openScopeKey: 'warehouse_cover:o1',
        affectedPositionIds: ['p1', 'p2'],
        version: 1,
        createdAt: requestedAt,
      });
      prisma.warehouseRoll.findMany.mockResolvedValue([]);
      prisma.warehouseCoverProposal.findMany.mockResolvedValue([
        {
          id: 'proposal-p1-newer-recheck',
          positionId: 'p1',
          status: 'recheck_requested',
          createdAt: new Date('2026-07-15T09:30:00.000Z'),
          expiresAt: null,
        },
        {
          id: 'proposal-p1-older-valid',
          positionId: 'p1',
          status: 'full_proposed',
          createdAt: new Date('2026-07-15T09:00:00.000Z'),
          expiresAt: null,
        },
        {
          id: 'proposal-p2-current',
          positionId: 'p2',
          status: 'partial_proposed',
          createdAt: new Date('2026-07-15T10:00:00.000Z'),
          expiresAt: null,
        },
      ]);
      const service = await build(prisma, audit, scanner);

      await service.proposeCover(actor, 'o1', { positionId: 'p2', rollIds: [] });

      expect(prisma.warehouseCoverProposal.findMany).toHaveBeenCalledWith({
        where: {
          orderId: 'o1',
          positionId: { in: ['p1', 'p2'] },
          createdAt: { gte: requestedAt },
        },
        select: {
          id: true,
          positionId: true,
          status: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: [{ positionId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(prisma.orderResolutionCase.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('maps a serializable proposal race to a stable conflict response', async () => {
    const { prisma, audit, scanner } = coverSetup();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('serialization failure', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    const service = await build(prisma, audit, scanner);

    await expect(
      service.proposeCover(actor, 'o1', { positionId: 'p1', rollIds: [] }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.orderResolutionCase.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('creates a zero-match proposal without fabricating a production decision', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const target = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 2,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'Гост',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'not_checked',
    };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...target,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        positions: [target],
      },
    });
    prisma.warehouseCoverProposal.findMany.mockResolvedValue([
      {
        id: 'proposal-p1-current',
        positionId: 'p1',
        status: 'partial_proposed',
        createdAt: updatedAt,
        expiresAt: null,
      },
    ]);
    const service = await build(prisma, audit, scanner);
    await service.proposeCover(actor, 'o1', { positionId: 'p1', rollIds: [] });
    expect(prisma.warehouseCoverProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          coverQty: 0,
          reserveQty: 0,
          productionQty: 2,
          route: 'production_only',
          status: 'partial_proposed',
          matchedRollIds: [],
        }),
      }),
    );
    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ productionIndicator: 'needs_production' }),
      }),
    );
  });

  it('rejects an incompatible selected roll before proposal or audit is written', async () => {
    const { prisma, audit, scanner } = coverSetup();
    const target = {
      id: 'p1',
      orderId: 'o1',
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      birka: 'Гост',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'not_checked',
    };
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      ...target,
      order: {
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        positions: [target],
      },
    });
    prisma.warehouseRoll.findMany.mockResolvedValue([
      {
        id: 'roll-wrong',
        rollCode: 'STK-WRONG',
        reservedForOrderId: null,
        warehouseStatus: 'received',
        positionSnapshot: {
          filmType: 'Полотно',
          actualThickness: '80 мкм',
          birka: 'Гост',
          spoolType: 'Шпуля 76 мм',
          plannedWeightKg: 41.2,
        },
      },
    ]);
    const service = await build(prisma, audit, scanner);

    await expect(
      service.proposeCover(actor, 'o1', { positionId: 'p1', rollIds: ['roll-wrong'] }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.warehouseCoverProposal.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
