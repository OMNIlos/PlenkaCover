import { HttpException } from '@nestjs/common';
import type { WarehousePalletDeliveryScanResult } from '@plenka/contracts';
import { validate } from 'class-validator';
import type { Actor } from '../../common/auth/actor';
import type { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import type { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { PalletDeliveryScanDto } from './dto/pallet-delivery-scan.dto';
import type { WarehouseBrowserSessionService } from './warehouse-browser-session.service';
import type { WarehouseOperationService } from './warehouse-operation.service';
import { WarehousePalletDeliveryService } from './warehouse-pallet-delivery.service';
import type { WarehouseService } from './warehouse.service';

const ACTOR: Actor = {
  userId: 'warehouse-user',
  role: 'warehouse',
  capabilities: ['warehouse:scan', 'warehouse:close'],
  sessionId: 'session-1',
  sessionPurpose: 'full',
};

const OPERATION_KEY = '123e4567-e89b-42d3-a456-426614174000';
const PALLET_PAYLOAD = `plt_${'a'.repeat(64)}`;
const ROLL_CODES = ['ROLL-1', 'ROLL-2'] as const;

function payloadSnapshot(rollCodes: readonly string[] = ROLL_CODES) {
  return {
    templateVersion: 'pallet-100x100-square-v4',
    label: {
      templateVersion: 'pallet-100x100-square-v4',
      rollCount: rollCodes.length,
      rollCodes: [...rollCodes],
    },
    rows: rollCodes.map((rollCode, index) => ({ seq: index + 1, rollCode })),
  };
}

function validDocument() {
  return {
    id: 'document-1',
    palletId: 'PAL-A-100-01',
    warehousePalletId: 'pallet-1',
    acceptanceTaskId: 'receiving-1',
    origin: 'physical_pallet',
    rollIds: [...ROLL_CODES],
    orderIds: ['order-1'],
    payload: payloadSnapshot(),
    voidedAt: null as Date | null,
    acceptanceTask: {
      id: 'receiving-1',
      mode: 'receiving',
      status: 'closed',
      orderId: 'order-1',
    },
    warehousePallet: {
      id: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      taskId: 'receiving-1',
      orderId: 'order-1',
      status: 'sealed',
      sealedAt: new Date('2026-08-17T08:03:00.000Z'),
      voidedAt: null,
      items: ROLL_CODES.map((rollCode, index) => ({
        id: `item-${index + 1}`,
        scanRowId: `receiving-row-${index + 1}`,
        orderId: 'order-1',
        rollCode,
        position: index + 1,
        acceptedAt: new Date(`2026-08-17T08:0${index + 1}:00.000Z`),
        releasedAt: null,
        scanRow: {
          id: `receiving-row-${index + 1}`,
          taskId: 'receiving-1',
          rollCode,
          scanStatus: 'accepted',
          lastScanAt: new Date(`2026-08-17T08:0${index + 1}:00.000Z`),
          operations: [
            {
              taskId: 'receiving-1',
              scanRowId: `receiving-row-${index + 1}`,
              rollCode,
              kind: 'receiving_scan',
              status: 'succeeded',
            },
          ],
        },
      })),
    },
  };
}

function expectedResult(
  overrides: Partial<WarehousePalletDeliveryScanResult> = {},
): WarehousePalletDeliveryScanResult {
  return {
    operationKey: OPERATION_KEY,
    documentId: 'document-1',
    palletId: 'pallet-1',
    palletCode: 'PAL-A-100-01',
    orderId: 'order-1',
    deliveryTaskId: 'delivery-1',
    rollCount: 2,
    newlyDeliveredRollCount: 2,
    alreadyDeliveredRollCount: 0,
    remainingRollCount: 0,
    taskStatus: 'closed',
    deliveryClosed: true,
    replayed: false,
    ...overrides,
  };
}

function commandFingerprint(payload = PALLET_PAYLOAD): string {
  return requestFingerprint({ command: 'warehouse_pallet_delivery_scan', payload });
}

function storedCommand(resultSnapshot: Record<string, unknown> = expectedResult()) {
  return {
    kind: 'pallet_delivery_scan',
    taskId: 'delivery-1',
    scanRowId: null,
    palletId: 'pallet-1',
    actorId: ACTOR.userId,
    requestFingerprint: commandFingerprint(),
    resultSnapshot,
  };
}

type SetupOptions = {
  acceptedPalletIndexes?: number[];
  extraExpectedRollCodes?: string[];
  receivingTaskStatus?: 'open' | 'partial' | 'closed';
  taskStatus?: 'open' | 'partial' | 'closed';
  existingCommand?: ReturnType<typeof storedCommand> | null;
  tokenFound?: boolean;
  createTaskDuringReconciliation?: boolean;
  handoffState?: 'incomplete' | 'ready_for_shipment';
};

function setup(options: SetupOptions = {}) {
  const document = validDocument();
  document.acceptanceTask.status = options.receivingTaskStatus ?? 'closed';
  const allRollCodes = [...ROLL_CODES, ...(options.extraExpectedRollCodes ?? [])];
  const acceptedIndexes = new Set(options.acceptedPalletIndexes ?? []);
  const rows = allRollCodes.map((rollCode, index) => ({
    id: `delivery-row-${index + 1}`,
    taskId: 'delivery-1',
    rollCode,
    fromOrderId: 'A-100',
    scanStatus: acceptedIndexes.has(index) ? 'accepted' : 'expected',
    lastScanAt: acceptedIndexes.has(index)
      ? new Date(`2026-08-17T09:0${index + 1}:00.000Z`)
      : (null as Date | null),
    operations: acceptedIndexes.has(index)
      ? [
          {
            taskId: 'delivery-1',
            scanRowId: `delivery-row-${index + 1}`,
            rollCode,
            kind: 'delivery_scan',
            status: 'succeeded',
          },
        ]
      : ([] as Array<Record<string, unknown>>),
  }));
  const rolls = allRollCodes.map((rollCode, index) => ({
    id: `warehouse-roll-${index + 1}`,
    rollCode,
    warehouseStatus: acceptedIndexes.has(index) ? 'delivered' : 'received',
    receivedAt: new Date(`2026-08-17T08:0${index + 1}:00.000Z`),
    reservedForOrderId: null,
    reservedForPositionId: null,
    producedForOrderId: 'order-1',
    producedForPositionId: `position-${index + 1}`,
    producedByCoverageDecisionId: 'coverage-decision-1',
  }));
  const task = {
    id: 'delivery-1',
    mode: 'delivery',
    status: options.taskStatus ?? 'open',
    orderId: 'order-1',
    positionId: null,
    proposalId: null,
    coverageDecisionId: null,
    receivingScopeKey: null,
    deliveryScopeKey: 'warehouse_delivery:order-1',
    rows,
  };
  const commands = new Map<string, ReturnType<typeof storedCommand>>();
  if (options.existingCommand) commands.set(OPERATION_KEY, options.existingCommand);
  let reconciled = false;
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    palletScanToken: {
      findUnique: jest.fn().mockImplementation(() =>
        Promise.resolve(
          options.tokenFound === false
            ? null
            : {
                documentId: document.id,
                document: {
                  warehousePalletId: document.warehousePalletId,
                  acceptanceTaskId: document.acceptanceTaskId,
                  warehousePallet: { orderId: 'order-1' },
                },
              },
        ),
      ),
    },
    palletListDocument: { findUnique: jest.fn().mockResolvedValue(document) },
    warehouseAcceptanceTask: {
      findUnique: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(options.createTaskDuringReconciliation && !reconciled ? null : task),
        ),
    },
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue({ id: 'order-1', orderNumber: 'A-100' }),
    },
    warehouseRoll: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(rolls)),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(rolls.find((roll) => roll.rollCode === where.rollCode) ?? null),
        ),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        const roll = rolls.find((candidate) => candidate.id === where.id);
        if (!roll || roll.warehouseStatus !== where.warehouseStatus) {
          return Promise.resolve({ count: 0 });
        }
        roll.warehouseStatus = data.warehouseStatus;
        return Promise.resolve({ count: 1 });
      }),
    },
    operatorRollLine: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    scanRow: {
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row || row.scanStatus !== where.scanStatus) return Promise.resolve({ count: 0 });
        row.scanStatus = data.scanStatus;
        row.lastScanAt = data.lastScanAt;
        return Promise.resolve({ count: 1 });
      }),
      count: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(rows.filter((row) => row.scanStatus === 'expected').length),
        ),
    },
    warehousePalletCommand: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) => Promise.resolve(commands.get(where.operationKey))),
      create: jest.fn().mockImplementation(({ data }: any) => {
        commands.set(data.operationKey, data);
        return Promise.resolve({ id: 'command-1' });
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Склад 1' }) },
    productionProblem: { count: jest.fn().mockResolvedValue(1) },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
  const fulfillment = {
    acquireDeliveryScopeLock: jest.fn().mockResolvedValue({}),
    reconcilePalletScan: jest.fn().mockImplementation(() => {
      reconciled = true;
      return Promise.resolve({
        state: options.handoffState ?? 'ready_for_shipment',
        deliveryTaskId: 'delivery-1',
        created: options.createTaskDuringReconciliation ?? false,
        reason: null,
      });
    }),
  };
  const browser = {
    resolve: jest.fn().mockResolvedValue({ session: { id: 'session-1' } }),
  };
  let operationSequence = 0;
  const claimedById = new Map<string, Record<string, unknown>>();
  const operations = {
    claim: jest.fn().mockImplementation((_client, input) => {
      operationSequence += 1;
      const id = `delivery-operation-${operationSequence}`;
      claimedById.set(id, input);
      return Promise.resolve({
        kind: 'claimed',
        operation: { id, ...input },
        recoveryFromId: null,
      });
    }),
    complete: jest.fn().mockImplementation((_client, id) => {
      const input = claimedById.get(id);
      const row = rows.find((candidate) => candidate.id === input?.scanRowId);
      if (row && input) {
        row.operations = [
          {
            taskId: input.taskId,
            scanRowId: input.scanRowId,
            rollCode: input.rollCode,
            kind: 'delivery_scan',
            status: 'succeeded',
          },
        ];
      }
      return Promise.resolve(undefined);
    }),
  };
  const warehouse = {
    closeTaskInTransaction: jest.fn().mockImplementation((_actor, _taskId, close) => {
      task.status = close.mode === 'full' ? 'closed' : 'partial';
      return Promise.resolve();
    }),
  };
  const service = new WarehousePalletDeliveryService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    fulfillment as unknown as OrderFulfillmentHandoffService,
    browser as unknown as WarehouseBrowserSessionService,
    operations as unknown as WarehouseOperationService,
    warehouse as unknown as WarehouseService,
  );
  return {
    audit,
    browser,
    document,
    fulfillment,
    operations,
    prisma,
    rolls,
    rows,
    service,
    task,
    tx,
    warehouse,
  };
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(HttpException);
  if (!(failure instanceof HttpException)) return;
  expect(failure.getResponse()).toEqual(expect.objectContaining({ code }));
}

function expectNoMutation(context: ReturnType<typeof setup>): void {
  expect(context.operations.claim).not.toHaveBeenCalled();
  expect(context.tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
  expect(context.tx.scanRow.updateMany).not.toHaveBeenCalled();
  expect(context.tx.warehousePalletCommand.create).not.toHaveBeenCalled();
  expect(context.audit.record).not.toHaveBeenCalled();
}

describe('PalletDeliveryScanDto', () => {
  it('accepts only UUIDv4 plus the exact lowercase opaque pallet token', async () => {
    const valid = Object.assign(new PalletDeliveryScanDto(), {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });
    const rollToken = Object.assign(new PalletDeliveryScanDto(), {
      operationKey: OPERATION_KEY,
      payload: `prt_${'a'.repeat(64)}`,
    });
    const uppercase = Object.assign(new PalletDeliveryScanDto(), {
      operationKey: OPERATION_KEY,
      payload: `plt_${'A'.repeat(64)}`,
    });

    expect(await validate(valid)).toHaveLength(0);
    expect(await validate(rollToken)).not.toHaveLength(0);
    expect(await validate(uppercase)).not.toHaveLength(0);
  });
});

describe('WarehousePalletDeliveryService', () => {
  it('delivers every expected pallet member and closes the task after the last pallet', async () => {
    const context = setup();

    const result = await context.service.scan(ACTOR, {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });

    expect(result).toEqual({
      operationKey: OPERATION_KEY,
      documentId: 'document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      rollCount: 2,
      newlyDeliveredRollCount: 2,
      alreadyDeliveredRollCount: 0,
      remainingRollCount: 0,
      taskStatus: 'closed',
      deliveryClosed: true,
      replayed: false,
    });
    expect(context.operations.claim).toHaveBeenCalledTimes(2);
    expect(context.operations.complete).toHaveBeenCalledTimes(2);
    expect(context.rolls.map((roll) => roll.warehouseStatus)).toEqual(['delivered', 'delivered']);
    expect(context.rows.map((row) => row.scanStatus)).toEqual(['accepted', 'accepted']);
    expect(context.warehouse.closeTaskInTransaction).toHaveBeenCalledWith(
      ACTOR,
      'delivery-1',
      { mode: 'full' },
      context.tx,
    );
    expect(context.tx.warehousePalletCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'pallet_delivery_scan',
        taskId: 'delivery-1',
        scanRowId: null,
        palletId: 'pallet-1',
        actorId: ACTOR.userId,
        resultSnapshot: expect.objectContaining({ deliveryClosed: true, replayed: false }),
      }),
    });
    expect(context.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_pallet_delivery_scanned' }),
      context.tx,
    );
    expect(JSON.stringify(context.tx.warehousePalletCommand.create.mock.calls)).not.toContain(
      PALLET_PAYLOAD,
    );
    expect(JSON.stringify(context.audit.record.mock.calls)).not.toContain(PALLET_PAYLOAD);
    expect(context.tx.productionProblem.count).toHaveBeenCalledWith({
      where: { orderId: 'order-1', status: 'open' },
    });
  });

  it('leaves the delivery open when another pallet still has an expected roll', async () => {
    const context = setup({ extraExpectedRollCodes: ['ROLL-3'] });

    const result = await context.service.scan(ACTOR, {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });

    expect(result).toEqual(
      expectedResult({
        remainingRollCount: 1,
        taskStatus: 'open',
        deliveryClosed: false,
      }),
    );
    expect(context.rows[2]).toEqual(expect.objectContaining({ scanStatus: 'expected' }));
    expect(context.rolls[2]).toEqual(expect.objectContaining({ warehouseStatus: 'received' }));
    expect(context.warehouse.closeTaskInTransaction).not.toHaveBeenCalled();
  });

  it('creates and issues a partial-order pallet directly from Выдача without closing payment', async () => {
    const context = setup({
      createTaskDuringReconciliation: true,
      handoffState: 'incomplete',
      receivingTaskStatus: 'open',
    });

    await expect(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
    ).resolves.toEqual(
      expectedResult({
        taskStatus: 'partial',
        deliveryClosed: false,
      }),
    );
    expect(context.fulfillment.reconcilePalletScan).toHaveBeenCalledWith(
      { userId: ACTOR.userId, role: ACTOR.role },
      'order-1',
      ROLL_CODES,
      context.tx,
      expect.any(Object),
    );
    expect(context.warehouse.closeTaskInTransaction).toHaveBeenCalledWith(
      ACTOR,
      'delivery-1',
      { mode: 'partial' },
      context.tx,
    );
  });

  it('processes only the remaining member when another roll was delivered individually', async () => {
    const context = setup({ acceptedPalletIndexes: [0] });

    const result = await context.service.scan(ACTOR, {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });

    expect(result).toEqual(
      expectedResult({ newlyDeliveredRollCount: 1, alreadyDeliveredRollCount: 1 }),
    );
    expect(context.operations.claim).toHaveBeenCalledTimes(1);
    expect(context.operations.claim).toHaveBeenCalledWith(
      context.tx,
      expect.objectContaining({ rollCode: 'ROLL-2', scanRowId: 'delivery-row-2' }),
    );
    expect(
      context.audit.record.mock.calls.filter(([event]) => event.objectId === 'ROLL-1'),
    ).toHaveLength(0);
  });

  it('replays the same actor/key/fingerprint without opening a second transaction', async () => {
    const context = setup();
    await context.service.scan(ACTOR, {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });

    const replay = await context.service.scan(ACTOR, {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });

    expect(replay).toEqual(expectedResult({ replayed: true }));
    expect(context.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(context.operations.claim).toHaveBeenCalledTimes(2);
    expect(context.warehouse.closeTaskInTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns a safe already-delivered result for a new key after task close', async () => {
    const context = setup({ taskStatus: 'closed', acceptedPalletIndexes: [0, 1] });

    const result = await context.service.scan(ACTOR, {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });

    expect(result).toEqual(
      expectedResult({ newlyDeliveredRollCount: 0, alreadyDeliveredRollCount: 2 }),
    );
    expect(context.fulfillment.reconcilePalletScan).not.toHaveBeenCalled();
    expect(context.operations.claim).not.toHaveBeenCalled();
    expect(context.warehouse.closeTaskInTransaction).not.toHaveBeenCalled();
    expect(context.audit.record).toHaveBeenCalledTimes(1);
  });

  it('reconstructs replay snapshots without returning extra persisted fields', async () => {
    const sensitive = 'CUSTOMER-AND-RAW-SECRET';
    const context = setup({
      existingCommand: storedCommand({
        ...expectedResult(),
        payload: sensitive,
        customer: sensitive,
      }),
    });

    const result = await context.service.scan(ACTOR, {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });

    expect(result).toEqual(expectedResult({ replayed: true }));
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(result).not.toHaveProperty('payload');
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a contradictory persisted result instead of replaying it', async () => {
    const context = setup({
      existingCommand: storedCommand(
        expectedResult({ remainingRollCount: 1, taskStatus: 'closed', deliveryClosed: true }),
      ),
    });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_DELIVERY_RESULT_CORRUPTED',
    );
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects operation-key reuse by another actor or payload', async () => {
    const context = setup({ existingCommand: storedCommand() });

    await expectErrorCode(
      context.service.scan(
        { ...ACTOR, userId: 'other-user' },
        {
          operationKey: OPERATION_KEY,
          payload: PALLET_PAYLOAD,
        },
      ),
      'WAREHOUSE_PALLET_DELIVERY_OPERATION_CONFLICT',
    );
    await expectErrorCode(
      context.service.scan(ACTOR, {
        operationKey: OPERATION_KEY,
        payload: `plt_${'b'.repeat(64)}`,
      }),
      'WAREHOUSE_PALLET_DELIVERY_OPERATION_CONFLICT',
    );
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown or voided physical pallet', async () => {
    const unknown = setup({ tokenFound: false });
    await expectErrorCode(
      unknown.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_QR_NOT_FOUND',
    );
    expectNoMutation(unknown);

    const voided = setup();
    voided.document.voidedAt = new Date('2026-08-17T10:00:00.000Z');
    await expectErrorCode(
      voided.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_DELIVERY_STATE_CONFLICT',
    );
    expectNoMutation(voided);
  });

  it('fails closed for a foreign scope or missing pallet membership', async () => {
    const foreign = setup();
    foreign.task.deliveryScopeKey = 'warehouse_delivery:other-order';
    await expectErrorCode(
      foreign.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_DELIVERY_TASK_MISMATCH',
    );
    expectNoMutation(foreign);

    const missing = setup();
    missing.task.rows.pop();
    await expectErrorCode(
      missing.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_DELIVERY_TASK_MISMATCH',
    );
    expectNoMutation(missing);
  });

  it('fails closed when reconciliation resolves another or newly-created delivery task', async () => {
    const context = setup();
    context.fulfillment.reconcilePalletScan.mockResolvedValue({
      state: 'ready_for_shipment',
      deliveryTaskId: 'other-delivery',
      created: true,
      reason: null,
    });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_DELIVERY_TASK_MISMATCH',
    );
    expectNoMutation(context);
  });

  it('fails closed for invalid row/roll pairs, missing evidence, or foreign provenance', async () => {
    const invalidPair = setup();
    invalidPair.rows[0].scanStatus = 'accepted';
    invalidPair.rows[0].lastScanAt = new Date('2026-08-17T10:00:00.000Z');
    await expectErrorCode(
      invalidPair.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_DELIVERY_ROLLS_INVALID',
    );
    expectNoMutation(invalidPair);

    const missingEvidence = setup({ acceptedPalletIndexes: [0] });
    missingEvidence.rows[0].operations = [];
    await expectErrorCode(
      missingEvidence.service.scan(ACTOR, {
        operationKey: OPERATION_KEY,
        payload: PALLET_PAYLOAD,
      }),
      'WAREHOUSE_PALLET_DELIVERY_ROLLS_INVALID',
    );
    expectNoMutation(missingEvidence);

    const foreignProvenance = setup();
    foreignProvenance.rolls[0].producedForOrderId = 'other-order';
    await expectErrorCode(
      foreignProvenance.service.scan(ACTOR, {
        operationKey: OPERATION_KEY,
        payload: PALLET_PAYLOAD,
      }),
      'WAREHOUSE_PALLET_DELIVERY_ROLLS_INVALID',
    );
    expectNoMutation(foreignProvenance);
  });
});
