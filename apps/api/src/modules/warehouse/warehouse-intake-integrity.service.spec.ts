import type { Actor } from '../../common/auth/actor';
import { WarehouseIntakeIntegrityService } from './warehouse-intake-integrity.service';
import { WarehousePalletService } from './warehouse-pallet.service';

const TOKEN = `prt_${'a'.repeat(64)}`;
const OPERATION_KEY = '123e4567-e89b-42d3-a456-426614174000';
const ACTIVE_PALLET = {
  id: 'pallet-1',
  palletCode: 'PAL-A-100-01',
  orderId: 'order-1',
  orderNumber: 'A-100',
  sequenceNo: 1,
  status: 'open' as const,
  totalCount: 1,
  hasMore: false,
  openedAt: '2026-08-07T05:59:00.000Z',
  rows: [
    {
      rollCode: 'ROLL-1',
      position: 1,
      acceptedAt: '2026-08-07T06:00:00.000Z',
      scannedByName: 'Warehouse User',
    },
  ],
};
const ACTOR: Actor = {
  userId: 'warehouse-user',
  role: 'warehouse',
  sessionId: 'session-1',
  sessionPurpose: 'full',
  capabilities: ['warehouse:scan'],
};

function queryText(value: unknown): string {
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ');
  }
  if (!value || typeof value !== 'object') return '';
  const strings = (value as { strings?: unknown }).strings;
  return Array.isArray(strings) && strings.every((part) => typeof part === 'string')
    ? strings.join(' ')
    : '';
}

function setup() {
  const row = {
    id: 'row-1',
    taskId: 'task-1',
    rollCode: 'ROLL-1',
    scanStatus: 'expected',
  };
  const task = {
    id: 'task-1',
    mode: 'receiving',
    status: 'open',
    orderId: 'order-1',
    positionId: 'position-1',
    proposalId: null,
  };
  const dispatch = {
    id: 'dispatch-1',
    rollCode: 'ROLL-1',
    status: 'ready_for_warehouse',
    rawMaterialId: 'raw-1',
    productionOrder: {
      commercialOrderId: 'order-1',
      commercialOrder: { id: 'order-1', orderNumber: 'A-100' },
    },
  };
  const line = {
    id: 'line-1',
    rollDispatchItemId: dispatch.id,
    step: 'warehouse',
    warehouseState: 'sent',
    spoolKg: 2,
    planKg: 40,
    netKg: 40,
    rollDispatchItem: dispatch,
  };
  const operation = {
    id: 'operation-1',
    taskId: task.id,
    scanRowId: row.id,
    rollCode: row.rollCode,
    sessionId: 'session-1',
    postId: 'post-1',
    deviceId: 'scale-1',
    captureChannel: 'machine_post_gateway',
    status: 'in_progress',
    leaseToken: '123e4567-e89b-42d3-a456-426614174010',
    leaseExpiresAt: new Date(Date.now() + 30_000),
  };
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
    warehouseAcceptanceTask: { findUnique: jest.fn().mockResolvedValue(task) },
    scanRow: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue({ ...row, scanStatus: 'accepted' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    warehouseRoll: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({ id: 'roll-1', rollCode: 'ROLL-1', warehouseStatus: 'sent' })
        .mockResolvedValue({ id: 'roll-1', rollCode: 'ROLL-1', warehouseStatus: 'received' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorRollLine: {
      findFirst: jest.fn().mockResolvedValue(line),
      findUnique: jest.fn().mockResolvedValue({
        ...line,
        warehouseState: 'received',
        rollDispatchItem: dispatch,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rollDispatchItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    user: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Warehouse User' }) },
    warehouseOperation: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(where.kind ? { id: 'scan-operation-1' } : operation),
        ),
    },
    weightCapture: {
      create: jest.fn().mockResolvedValue({ id: 'capture-1' }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'control-capture-1',
        operatorRollLineId: line.id,
        kind: 'control',
        deviceId: 'scale-1',
        deviceStatus: 'ready',
        stable: true,
        grossKg: 42,
        spoolKg: 2,
        netKg: 40,
        postId: 'post-1',
        postSessionId: null,
        operationId: null,
        operation: null,
        warehouseOperationId: 'control-operation-1',
        warehouseOperation: {
          id: 'control-operation-1',
          kind: 'control_weight',
          status: 'succeeded',
          taskId: 'task-1',
          rollCode: 'ROLL-1',
          deviceId: 'scale-1',
          postId: 'post-1',
          safeResult: {
            operationId: 'control-operation-1',
            taskId: 'task-1',
            rollCode: 'ROLL-1',
            grossKg: 42,
            spoolKg: 2,
            netKg: 40,
          },
        },
        createdAt: new Date('2026-07-22T10:00:00.000Z'),
      }),
    },
    defectRecord: {
      create: jest.fn().mockResolvedValue({ id: 'warehouse-defect-1' }),
    },
    productionProblem: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'warehouse-problem-1' }),
    },
    rawMaterialStock: {
      findUnique: jest.fn().mockResolvedValue({ materialId: 'raw-1', label: 'ПВД' }),
      upsert: jest.fn(),
    },
    warehousePallet: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    warehousePalletItem: {
      findFirst: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn((callback: (client: any) => unknown) => callback(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const tokens = {
    findExact: jest.fn().mockResolvedValue({ rollCode: 'ROLL-1', token: TOKEN }),
  };
  const identity = {
    session: { id: 'session-1' },
    post: { id: 'post-1' },
    device: { id: 'scanner-1' },
  };
  const browserSession = {
    resolve: jest.fn().mockResolvedValue({ session: identity.session }),
  };
  const operations = {
    claim: jest.fn().mockResolvedValue({ kind: 'claimed', operation }),
    complete: jest.fn().mockResolvedValue(operation),
    fail: jest.fn().mockResolvedValue(operation),
    bindDevice: jest.fn().mockResolvedValue(undefined),
    expireStaleControlWeights: jest.fn().mockResolvedValue([]),
  };
  const intake = {
    projectTaskById: jest.fn().mockResolvedValue({ id: task.id, rows: [] }),
  };
  const production = { createReplacementRoll: jest.fn() };
  const scanner = { parse: jest.fn().mockReturnValue({ token: TOKEN, valid: true }) };
  const scale = {
    read: jest.fn().mockResolvedValue({
      deviceId: 'scale-1',
      status: 'ready',
      stable: true,
      grossKg: 42,
    }),
  };
  const incidents = {
    signal: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(undefined),
  };
  const pallets = new WarehousePalletService(
    prisma,
    audit as never,
    { print: jest.fn() } as never,
    {
      palletLabelProfile: 'pallet-100x150-v1',
    },
    {} as never,
  );
  const palletSelection = {
    setSelection: jest.fn().mockResolvedValue({
      selectionChanged: true,
      activePallet: ACTIVE_PALLET,
    }),
  };
  const IntegrityServiceWithPalletLifecycle = WarehouseIntakeIntegrityService as unknown as new (
    ...args: unknown[]
  ) => WarehouseIntakeIntegrityService;
  const service = new IntegrityServiceWithPalletLifecycle(
    prisma,
    audit as never,
    tokens as never,
    browserSession as never,
    operations as never,
    intake as never,
    production as never,
    scanner,
    scale,
    incidents as never,
    pallets,
    palletSelection as never,
  );
  return {
    service,
    prisma,
    tx,
    audit,
    tokens,
    browserSession,
    operations,
    intake,
    production,
    scanner,
    scale,
    incidents,
    pallets,
    palletSelection,
    task,
    row,
    line,
    operation,
  };
}

function selectedMembership(status: 'open' | 'sealed' = 'open') {
  return {
    id: 'pallet-item-1',
    palletId: 'pallet-1',
    scanRowId: 'row-1',
    orderId: 'order-1',
    rollCode: 'ROLL-1',
    position: 1,
    acceptedAt: new Date('2026-08-07T06:00:00.000Z'),
    pallet: {
      id: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      taskId: 'task-1',
      orderId: 'order-1',
      sequenceNo: 1,
      status,
    },
  };
}

describe('WarehouseIntakeIntegrityService', () => {
  it('adds an accepted roll to the active pallet from its exact opaque token', async () => {
    const { service, prisma, palletSelection, audit, row } = setup();
    prisma.scanRow.findFirst.mockResolvedValue({ ...row, scanStatus: 'accepted' });

    const result = await service.scanPalletSelection(ACTOR, 'task-1', {
      operationKey: OPERATION_KEY,
      payload: TOKEN,
    });

    expect(result).toEqual({
      operationKey: OPERATION_KEY,
      taskId: 'task-1',
      scanRowId: 'row-1',
      rollCode: 'ROLL-1',
      outcome: 'added',
      activePallet: ACTIVE_PALLET,
    });
    expect(prisma.scanRow.findFirst).toHaveBeenCalledWith({
      where: { taskId: 'task-1', rollCode: 'ROLL-1', scanStatus: 'accepted' },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    expect(palletSelection.setSelection).toHaveBeenCalledWith(ACTOR, 'task-1', 'row-1', {
      operationKey: OPERATION_KEY,
      selected: true,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(TOKEN);
  });

  it('reports a repeated pallet QR scan as an unchanged success', async () => {
    const { service, prisma, palletSelection, audit, row } = setup();
    prisma.scanRow.findFirst.mockResolvedValue({ ...row, scanStatus: 'accepted' });
    palletSelection.setSelection.mockResolvedValue({
      selectionChanged: false,
      activePallet: ACTIVE_PALLET,
    });

    await expect(
      service.scanPalletSelection(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        payload: TOKEN,
      }),
    ).resolves.toMatchObject({ outcome: 'already_selected', activePallet: ACTIVE_PALLET });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a malformed pallet-mode token without exposing it or changing selection', async () => {
    const { service, scanner, palletSelection, audit } = setup();
    scanner.parse.mockReturnValue({ token: null, valid: false });

    await expect(
      service.scanPalletSelection(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        payload: TOKEN,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_SCAN_TOKEN_INVALID' }),
    });

    expect(palletSelection.setSelection).not.toHaveBeenCalled();
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(TOKEN);
  });

  it('rejects a roll without an accepted row in the selected receiving task', async () => {
    const { service, prisma, palletSelection, audit } = setup();
    prisma.scanRow.findFirst.mockResolvedValue(null);

    await expect(
      service.scanPalletSelection(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        payload: TOKEN,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_PALLET_ROLL_NOT_ACCEPTED' }),
    });

    expect(palletSelection.setSelection).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'device.scan.mismatch',
        objectId: 'ROLL-1',
        detail: { taskId: 'task-1', reasonCode: 'WAREHOUSE_PALLET_ROLL_NOT_ACCEPTED' },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(TOKEN);
  });

  it('fails closed if pallet selection returns no active pallet', async () => {
    const { service, prisma, palletSelection, row } = setup();
    prisma.scanRow.findFirst.mockResolvedValue({ ...row, scanStatus: 'accepted' });
    palletSelection.setSelection.mockResolvedValue({
      selectionChanged: true,
      activePallet: null,
    });

    await expect(
      service.scanPalletSelection(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        payload: TOKEN,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_INVENTORY_CONFLICT' }),
    });
  });

  it('rejects a decision-linked task before token parsing or any legacy lock', async () => {
    const { service, tx, prisma, scanner, tokens } = setup();
    tx.warehouseAcceptanceTask.findUnique.mockResolvedValue({
      id: 'task-1',
      coverageDecisionId: 'decision-1',
    });

    await expect(
      service.scan(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        payload: TOKEN,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'warehouse_coverage_decision_managed_task',
      }),
    });

    expect(scanner.parse).not.toHaveBeenCalled();
    expect(tokens.findExact).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('atomically accepts an exact opaque token without disclosing it', async () => {
    const { service, tx, audit, browserSession, operations, incidents } = setup();

    const result = await service.scan(ACTOR, 'task-1', {
      operationKey: OPERATION_KEY,
      payload: TOKEN,
    });

    expect(result).toMatchObject({
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      scanStatus: 'accepted',
      replayed: false,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(tx.warehouseRoll.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ warehouseStatus: 'sent' }),
        data: { warehouseStatus: 'received', receivedAt: expect.any(Date) },
      }),
    );
    expect(tx.scanRow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ scanStatus: 'expected' }) }),
    );
    expect(tx.warehousePallet.findFirst).not.toHaveBeenCalled();
    expect(tx.warehousePallet.create).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.findFirst).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.aggregate).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.create).not.toHaveBeenCalled();
    expect(tx.scanRow.findFirst).toHaveBeenCalledWith({
      where: {
        taskId: 'task-1',
        rollCode: 'ROLL-1',
        scanStatus: { in: ['expected', 'accepted'] },
      },
      orderBy: { id: 'asc' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        type: 'audit:warehouse_roll_received',
        actorRole: 'warehouse',
        actorId: 'warehouse-user',
        objectId: 'ROLL-1',
        detail: {
          warehouseOperationId: 'operation-1',
          taskId: 'task-1',
          scanRowId: 'row-1',
          rollCode: 'ROLL-1',
          mode: 'receiving',
          captureChannel: 'warehouse_browser_hid',
        },
      },
      tx,
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(TOKEN);
    expect(operations.complete).toHaveBeenCalledTimes(1);
    expect(operations.claim).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        postId: null,
        deviceId: null,
        captureChannel: 'warehouse_browser_hid',
      }),
    );
    expect(browserSession.resolve).toHaveBeenCalledWith(ACTOR, tx);
    expect(operations.bindDevice).not.toHaveBeenCalled();
    expect(incidents.signal).not.toHaveBeenCalled();
    expect(incidents.resolve).not.toHaveBeenCalled();
    const lockedSql = (tx.$queryRaw.mock.calls as unknown[][]).map(([query]) => queryText(query));
    expect(lockedSql[0]).toContain('warehouse_coverage_inventory_epochs');
    expect(lockedSql[1]).toContain('warehouse_acceptance_tasks');
    expect(lockedSql[2]).toContain('scan_rows');
    expect(lockedSql[3]).toContain('warehouse_rolls');
  });

  it('delivers a received V2 production roll through its exact production provenance', async () => {
    const { service, tx, task } = setup();
    task.mode = 'delivery';
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
      reservedForOrderId: null,
      reservedForPositionId: null,
      producedForOrderId: 'order-1',
      producedForPositionId: 'position-1',
      producedByCoverageDecisionId: 'production-decision-1',
    });

    await expect(
      service.scan(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        payload: TOKEN,
      }),
    ).resolves.toMatchObject({
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      mode: 'delivery',
      scanStatus: 'accepted',
    });

    expect(tx.warehouseRoll.updateMany).toHaveBeenCalledWith({
      where: { id: 'roll-1', warehouseStatus: 'received' },
      data: { warehouseStatus: 'delivered' },
    });
    expect(tx.operatorRollLine.updateMany).toHaveBeenCalledWith({
      where: {
        rollDispatchItem: { rollCode: 'ROLL-1' },
        warehouseState: 'received',
      },
      data: { warehouseState: 'delivered' },
    });
  });

  it('rejects delivery when the received roll belongs to another order', async () => {
    const { service, tx, task, audit } = setup();
    task.mode = 'delivery';
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
      reservedForOrderId: 'other-order',
      reservedForPositionId: null,
      producedForOrderId: null,
      producedForPositionId: null,
      producedByCoverageDecisionId: null,
    });

    await expect(
      service.scan(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        payload: TOKEN,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_ROLL_NOT_READY' }),
    });

    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(tx.operatorRollLine.updateMany).not.toHaveBeenCalled();
    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('audits a verified stock roll when warehouse acceptance makes it available', async () => {
    const { service, tx, audit } = setup();
    tx.warehouseRoll.findUnique
      .mockReset()
      .mockResolvedValueOnce({
        id: 'roll-1',
        rollCode: 'ROLL-1',
        warehouseStatus: 'sent',
        producedForStockOrderId: 'stock-order-1',
      })
      .mockResolvedValueOnce({
        id: 'roll-1',
        rollCode: 'ROLL-1',
        warehouseStatus: 'received',
        producedForStockOrderId: 'stock-order-1',
      });

    await service.scan(ACTOR, 'task-1', {
      operationKey: OPERATION_KEY,
      payload: TOKEN,
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:finished_stock_created',
        objectId: 'roll-1',
        detail: expect.objectContaining({
          sourceStockOrderId: 'stock-order-1',
          rollCode: 'ROLL-1',
        }),
      }),
      tx,
    );
  });

  it('rejects malformed scanner input before any inventory write', async () => {
    const { service, scanner, tokens, tx, audit, incidents } = setup();
    scanner.parse.mockReturnValue({ token: '', valid: false });

    await expect(
      service.scan(ACTOR, 'task-1', { operationKey: OPERATION_KEY, payload: 'QR-ROLL-1' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_SCAN_TOKEN_INVALID' }),
    });

    expect(tokens.findExact).not.toHaveBeenCalled();
    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'device.scan.mismatch',
        detail: expect.objectContaining({ reasonCode: 'WAREHOUSE_SCAN_TOKEN_INVALID' }),
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('QR-ROLL-1');
    expect(incidents.signal).not.toHaveBeenCalled();
    expect(incidents.resolve).not.toHaveBeenCalled();
  });

  it('keeps a valid foreign roll as mismatch audit only, never an operational incident', async () => {
    const { service, tokens, tx, audit, incidents } = setup();
    tokens.findExact.mockResolvedValue({ rollCode: 'ROLL-FOREIGN', token: TOKEN });
    tx.scanRow.findFirst.mockResolvedValue(null);

    await expect(
      service.scan(ACTOR, 'task-1', { operationKey: OPERATION_KEY, payload: TOKEN }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_TASK_ROLL_MISMATCH' }),
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'device.scan.mismatch',
        objectId: 'ROLL-FOREIGN',
        detail: expect.objectContaining({ reasonCode: 'WAREHOUSE_TASK_ROLL_MISMATCH' }),
      }),
    );
    expect(incidents.signal).not.toHaveBeenCalled();
    expect(incidents.resolve).not.toHaveBeenCalled();
  });

  it('replays a completed scan without repeating inventory or audit effects', async () => {
    const { service, browserSession, operations, tx, audit } = setup();
    operations.claim.mockResolvedValue({
      kind: 'replay',
      operation: {
        safeResult: {
          operationId: 'operation-1',
          taskId: 'task-1',
          rollCode: 'ROLL-1',
          mode: 'receiving',
          scanStatus: 'accepted',
        },
      },
    });

    const result = await service.scan(ACTOR, 'task-1', {
      operationKey: OPERATION_KEY,
      payload: TOKEN,
    });

    expect(result.replayed).toBe(true);
    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(operations.complete).not.toHaveBeenCalled();
    expect(browserSession.resolve).toHaveBeenCalledWith(ACTOR, tx);
    expect(tx.warehousePallet.findFirst).not.toHaveBeenCalled();
    expect(tx.warehousePallet.create).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.findFirst).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.aggregate).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.create).not.toHaveBeenCalled();
  });

  it('uses browser HID with only a browser session and no POST/device resolver', async () => {
    const { service, browserSession, operations, incidents } = setup();

    await expect(
      service.scan(ACTOR, 'task-1', { operationKey: OPERATION_KEY, payload: TOKEN }),
    ).resolves.toMatchObject({ rollCode: 'ROLL-1', scanStatus: 'accepted' });

    expect(browserSession.resolve).toHaveBeenCalledWith(ACTOR, expect.anything());
    expect(operations.bindDevice).not.toHaveBeenCalled();
    expect(incidents.signal).not.toHaveBeenCalled();
    expect(incidents.resolve).not.toHaveBeenCalled();
  });

  it('audits recovery after a failed scanner attempt without exposing label bytes', async () => {
    const { service, operations, audit, tx } = setup();
    operations.claim.mockResolvedValue({
      kind: 'claimed',
      operation: { id: 'operation-2' },
      recoveryFromId: 'failed-operation-1',
    });

    await service.scan(ACTOR, 'task-1', { operationKey: OPERATION_KEY, payload: TOKEN });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_physical_operation_recovered',
        detail: expect.objectContaining({
          warehouseOperationId: 'operation-2',
          recoveredOperationId: 'failed-operation-1',
        }),
      }),
      tx,
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(TOKEN);
  });

  it('fails closed when a reserve task does not exactly own the roll', async () => {
    const { service, tx, audit } = setup();
    tx.warehouseAcceptanceTask.findUnique.mockResolvedValue({
      id: 'task-1',
      mode: 'reserve',
      status: 'open',
      orderId: 'order-1',
      positionId: 'position-1',
      proposalId: 'proposal-1',
    });
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
      reservedForOrderId: null,
      reservedForPositionId: null,
      reservedByProposalId: null,
    });

    await expect(
      service.scan(ACTOR, 'task-1', { operationKey: OPERATION_KEY, payload: TOKEN }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_ROLL_NOT_READY' }),
    });

    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails control weight closed before POST-1, gateway or inventory access', async () => {
    const { service, prisma, tx, browserSession, operations, scale, incidents } = setup();

    await expect(
      service.controlWeight(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        rollCode: 'ROLL-1',
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'WAREHOUSE_SCALE_NOT_CONFIGURED' }),
    });

    expect(browserSession.resolve).toHaveBeenCalledWith(ACTOR);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(operations.claim).not.toHaveBeenCalled();
    expect(operations.bindDevice).not.toHaveBeenCalled();
    expect(scale.read).not.toHaveBeenCalled();
    expect(tx.weightCapture.create).not.toHaveBeenCalled();
    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(incidents.signal).not.toHaveBeenCalled();
  });

  it('rejects damage before a completed exact scan operation', async () => {
    const { service, tx, operations } = setup();
    tx.warehouseOperation.findFirst.mockResolvedValue(null);

    await expect(
      service.markDamaged(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        rollCode: 'ROLL-1',
        reason: 'Повреждение полотна',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_ROLL_NOT_READY' }),
    });

    expect(operations.claim).not.toHaveBeenCalled();
    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
  });

  it.each(['reserve', 'delivery'])(
    'rejects damage on a %s task before claiming or mutating anything',
    async (mode) => {
      const { service, tx, operations } = setup();
      tx.warehouseAcceptanceTask.findUnique.mockResolvedValue({
        id: 'task-1',
        mode,
        status: 'open',
      });

      await expect(
        service.markDamaged(ACTOR, 'task-1', {
          operationKey: OPERATION_KEY,
          rollCode: 'ROLL-1',
          reason: 'Повреждение полотна',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'WAREHOUSE_DAMAGE_TASK_MODE_INVALID' }),
      });

      expect(operations.claim).not.toHaveBeenCalled();
      expect(tx.scanRow.findFirst).not.toHaveBeenCalled();
      expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
      expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
      expect(tx.operatorRollLine.updateMany).not.toHaveBeenCalled();
      expect(tx.defectRecord.create).not.toHaveBeenCalled();
      expect(tx.productionProblem.create).not.toHaveBeenCalled();
    },
  );

  it('links warehouse damage to the stable control capture without recycling early', async () => {
    const { service, tx, audit, browserSession, operations } = setup();
    tx.scanRow.findFirst.mockResolvedValue({
      id: 'row-1',
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      scanStatus: 'accepted',
    });
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
    });

    const result = await service.markDamaged(ACTOR, 'task-1', {
      operationKey: OPERATION_KEY,
      rollCode: 'ROLL-1',
      reason: '  Повреждение полотна  ',
    });

    expect(browserSession.resolve).toHaveBeenCalledWith(ACTOR, tx);
    expect(operations.claim).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        postId: null,
        deviceId: null,
        captureChannel: 'warehouse_role_action',
      }),
    );
    expect(tx.weightCapture.findFirst).toHaveBeenCalledWith({
      where: {
        operatorRollLineId: 'line-1',
        kind: 'control',
        deviceId: { not: null },
        deviceStatus: 'ready',
        stable: true,
        grossKg: { gt: 0 },
        spoolKg: { gte: 0 },
        netKg: { gt: 0 },
        warehouseOperation: {
          taskId: 'task-1',
          rollCode: 'ROLL-1',
          kind: 'control_weight',
          status: 'succeeded',
        },
      },
      select: expect.objectContaining({
        warehouseOperation: {
          select: expect.objectContaining({
            id: true,
            status: true,
            kind: true,
          }),
        },
      }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(tx.defectRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operatorRollLineId: 'line-1',
        weightCaptureId: 'control-capture-1',
        sourceRole: 'warehouse',
        weightKg: 40,
        comment: 'Повреждение полотна',
        blocking: true,
      }),
    });
    expect(tx.productionProblem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'defect',
        rollId: 'ROLL-1',
        reason: 'Повреждение полотна',
        defectRecordId: 'warehouse-defect-1',
      }),
    });
    expect(tx.scanRow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { scanStatus: 'damaged' } }),
    );
    expect(tx.warehouseRoll.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { warehouseStatus: 'defect' } }),
    );
    expect(tx.operatorRollLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { warehouseState: 'defect' } }),
    );
    expect(tx.rawMaterialStock.upsert).not.toHaveBeenCalled();
    expect(audit.record.mock.calls.map(([event]) => event.type)).toEqual([
      'audit:defect_recorded',
      'problem:warehouse_defect_reported',
    ]);
    expect(audit.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'problem:warehouse_defect_reported',
        detail: expect.objectContaining({
          problemId: 'warehouse-problem-1',
          rollId: 'ROLL-1',
        }),
      }),
      tx,
    );
    expect(result).toMatchObject({
      rollCode: 'ROLL-1',
      scanStatus: 'damaged',
      problemId: 'warehouse-problem-1',
    });
  });

  it('atomically releases a selected open-pallet roll when recording a defect', async () => {
    const { service, tx, audit } = setup();
    tx.scanRow.findFirst.mockResolvedValue({
      id: 'row-1',
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      scanStatus: 'accepted',
    });
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
    });
    tx.warehousePalletItem.findFirst.mockResolvedValue(selectedMembership());

    await service.markDamaged(ACTOR, 'task-1', {
      operationKey: OPERATION_KEY,
      rollCode: 'ROLL-1',
      reason: 'Повреждение полотна',
    });

    expect(tx.warehousePalletItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'pallet-item-1',
        releasedAt: null,
        pallet: { status: 'open' },
      },
      data: {
        releasedAt: expect.any(Date),
        releasedById: ACTOR.userId,
        releaseReason: 'defect_reported',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_pallet_roll_deselected',
        objectId: 'ROLL-1',
        detail: expect.objectContaining({
          taskId: 'task-1',
          scanRowId: 'row-1',
          releaseReason: 'defect_reported',
        }),
      }),
      tx,
    );
    expect(tx.scanRow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { scanStatus: 'damaged' } }),
    );
  });

  it('rejects defect mutation for a roll locked in a sealed pallet', async () => {
    const { service, tx } = setup();
    tx.scanRow.findFirst.mockResolvedValue({
      id: 'row-1',
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      scanStatus: 'accepted',
    });
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
    });
    tx.warehousePalletItem.findFirst.mockResolvedValue(selectedMembership('sealed'));

    await expect(
      service.markDamaged(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        rollCode: 'ROLL-1',
        reason: 'Повреждение полотна',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'WAREHOUSE_PALLET_SELECTION_LOCKED',
        palletId: 'pallet-1',
        palletStatus: 'sealed',
      }),
    });

    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(tx.operatorRollLine.updateMany).not.toHaveBeenCalled();
    expect(tx.defectRecord.create).not.toHaveBeenCalled();
    expect(tx.productionProblem.create).not.toHaveBeenCalled();
  });

  it('rejects warehouse damage without a stable linked control capture', async () => {
    const { service, tx, operations } = setup();
    tx.scanRow.findFirst.mockResolvedValue({
      id: 'row-1',
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      scanStatus: 'accepted',
    });
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
    });
    tx.weightCapture.findFirst.mockResolvedValue(null);

    await expect(
      service.markDamaged(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        rollCode: 'ROLL-1',
        reason: 'Повреждение полотна',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_DEFECT_CONTROL_WEIGHT_REQUIRED' }),
    });

    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(tx.defectRecord.create).not.toHaveBeenCalled();
    expect(tx.productionProblem.create).not.toHaveBeenCalled();
    expect(operations.complete).not.toHaveBeenCalled();
  });

  it('rejects a synthetic control capture whose durable warehouse operation is missing', async () => {
    const { service, tx } = setup();
    tx.scanRow.findFirst.mockResolvedValue({
      id: 'row-1',
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      scanStatus: 'accepted',
    });
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
    });
    const synthetic = await tx.weightCapture.findFirst();
    tx.weightCapture.findFirst.mockResolvedValue({
      ...synthetic,
      warehouseOperationId: null,
      warehouseOperation: null,
    });

    await expect(
      service.markDamaged(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        rollCode: 'ROLL-1',
        reason: 'Повреждение полотна',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_DEFECT_CONTROL_WEIGHT_REQUIRED' }),
    });

    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(tx.defectRecord.create).not.toHaveBeenCalled();
  });

  it('rejects warehouse damage when the roll has no commercial order owner', async () => {
    const { service, tx } = setup();
    tx.scanRow.findFirst.mockResolvedValue({
      id: 'row-1',
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      scanStatus: 'accepted',
    });
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
    });
    tx.operatorRollLine.findFirst.mockResolvedValue({
      id: 'line-1',
      warehouseState: 'received',
      rollDispatchItem: {
        id: 'dispatch-1',
        rawMaterialId: 'raw-1',
        productionOrder: { commercialOrderId: null },
      },
    });

    await expect(
      service.markDamaged(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        rollCode: 'ROLL-1',
        reason: 'Повреждение полотна',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_DEFECT_ORDER_INTEGRITY_ERROR' }),
    });

    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(tx.defectRecord.create).not.toHaveBeenCalled();
  });

  it('rejects a second open warehouse defect before changing inventory state', async () => {
    const { service, tx } = setup();
    tx.scanRow.findFirst.mockResolvedValue({
      id: 'row-1',
      taskId: 'task-1',
      rollCode: 'ROLL-1',
      scanStatus: 'accepted',
    });
    tx.warehouseRoll.findUnique.mockReset().mockResolvedValue({
      id: 'roll-1',
      rollCode: 'ROLL-1',
      warehouseStatus: 'received',
    });
    tx.productionProblem.findFirst.mockResolvedValue({ id: 'existing-defect' });

    await expect(
      service.markDamaged(ACTOR, 'task-1', {
        operationKey: OPERATION_KEY,
        rollCode: 'ROLL-1',
        reason: 'Повторный дефект',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_DEFECT_ALREADY_REPORTED' }),
    });

    expect(tx.scanRow.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(tx.defectRecord.create).not.toHaveBeenCalled();
  });
});
