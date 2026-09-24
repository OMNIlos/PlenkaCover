import { Prisma } from '@prisma/client';
import { validate } from 'class-validator';
import type { WarehousePalletSelectionResult, WarehousePalletView } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { SetPalletSelectionDto } from './dto/set-pallet-selection.dto';
import { VoidPalletDto } from './dto/void-pallet.dto';
import { WarehousePalletSelectionService } from './warehouse-pallet-selection.service';
import { WarehousePalletService } from './warehouse-pallet.service';

const ACTOR: Actor = {
  userId: 'warehouse-user',
  role: 'warehouse',
  capabilities: ['pallet_list:create'],
};

const TASK = {
  id: 'task-1',
  mode: 'receiving',
  status: 'open',
  orderId: 'order-a',
  updatedAt: new Date('2026-08-07T06:01:00.000Z'),
};

const ORDER = { id: 'order-a', orderNumber: 'A-100' };

const ROW = {
  id: 'scan-1',
  taskId: 'task-1',
  rollCode: 'ROLL-1',
  fromOrderId: 'A-100',
  scanStatus: 'accepted',
  lastScanAt: new Date('2026-08-07T06:00:00.000Z'),
  scannedByName: 'Склад 1',
};

const PALLET = {
  id: 'pallet-1',
  palletCode: 'PAL-A-100-01',
  taskId: TASK.id,
  orderId: 'order-a',
  sequenceNo: 1,
};

const VOID_DOCUMENT = {
  id: 'document-1',
  palletId: PALLET.palletCode,
  warehousePalletId: PALLET.id,
  acceptanceTaskId: TASK.id,
  origin: 'physical_pallet',
  rollIds: [ROW.rollCode],
  orderIds: [PALLET.orderId],
  payload: {
    templateVersion: 'pallet-100x150-v1',
    printReady: true,
    label: {
      templateVersion: 'pallet-100x150-v1',
      palletId: PALLET.palletCode,
    },
  },
  voidedAt: null,
  createdAt: new Date('2026-08-07T06:02:00.000Z'),
  printJobs: [{ status: 'submitted' }],
  warehousePallet: { orderId: PALLET.orderId },
};

const VOID_ITEMS = [{ id: 'item-1', rollCode: ROW.rollCode, position: 1 }];

const VOID_RESULT = {
  id: VOID_DOCUMENT.id,
  palletId: VOID_DOCUMENT.palletId,
  warehousePalletId: VOID_DOCUMENT.warehousePalletId,
  origin: 'physical_pallet' as const,
  createdAt: VOID_DOCUMENT.createdAt.toISOString(),
  templateVersion: 'pallet-100x150-v1' as const,
  documentStatus: 'voided' as const,
  printReady: true,
  printStatus: 'submitted' as const,
  rollCount: 1,
  rollCodes: [ROW.rollCode],
  rollCodesHasMore: false,
  orderId: PALLET.orderId,
};

const PALLET_VIEW: WarehousePalletView = {
  id: PALLET.id,
  palletCode: PALLET.palletCode,
  orderId: PALLET.orderId,
  orderNumber: 'A-100',
  sequenceNo: PALLET.sequenceNo,
  status: 'open',
  rollCount: 1,
  openedAt: '2026-08-07T05:59:00.000Z',
  rows: [
    {
      rollCode: ROW.rollCode,
      position: 1,
      acceptedAt: ROW.lastScanAt.toISOString(),
      scannedByName: ROW.scannedByName,
    },
  ],
};

const SELECTION_RESULT: WarehousePalletSelectionResult = {
  selectionChanged: true,
  activePallet: {
    id: PALLET_VIEW.id,
    palletCode: PALLET_VIEW.palletCode,
    orderId: PALLET_VIEW.orderId,
    orderNumber: PALLET_VIEW.orderNumber,
    sequenceNo: PALLET_VIEW.sequenceNo,
    status: PALLET_VIEW.status,
    totalCount: PALLET_VIEW.rollCount,
    hasMore: false,
    openedAt: PALLET_VIEW.openedAt,
    rows: PALLET_VIEW.rows,
  },
};

const OPERATION_KEY = '123e4567-e89b-42d3-a456-426614174000';
const VOID_OPERATION_KEY = '123e4567-e89b-42d3-a456-426614174001';

function fingerprint(selected: boolean): string {
  return requestFingerprint({
    command: 'warehouse_pallet_set_selection',
    taskId: TASK.id,
    scanRowId: ROW.id,
    selected,
  });
}

function voidFingerprint(
  reasonCode = 'wrong_composition',
  note = 'Повторно собрать состав.',
): string {
  return requestFingerprint({
    command: 'warehouse_pallet_void',
    taskId: TASK.id,
    palletId: PALLET.id,
    reasonCode,
    note,
  });
}

function storedCommand(
  selected: boolean,
  resultSnapshot: Prisma.JsonValue = SELECTION_RESULT as unknown as Prisma.JsonValue,
) {
  return {
    kind: 'set_selection',
    taskId: TASK.id,
    scanRowId: ROW.id,
    actorId: ACTOR.userId,
    requestFingerprint: fingerprint(selected),
    resultSnapshot,
  };
}

function storedVoidCommand(
  resultSnapshot: Prisma.JsonValue = VOID_RESULT as unknown as Prisma.JsonValue,
  reasonCode = 'wrong_composition',
  note = 'Повторно собрать состав.',
) {
  return {
    kind: 'void_pallet',
    taskId: TASK.id,
    scanRowId: null,
    palletId: PALLET.id,
    actorId: ACTOR.userId,
    requestFingerprint: voidFingerprint(reasonCode, note),
    resultSnapshot,
  };
}

function activeMembership(status: 'open' | 'sealed' | 'voided' = 'open') {
  return {
    id: 'item-1',
    palletId: PALLET.id,
    orderId: PALLET.orderId,
    rollCode: ROW.rollCode,
    position: 1,
    acceptedAt: ROW.lastScanAt,
    pallet: {
      id: PALLET.id,
      palletCode: PALLET.palletCode,
      taskId: TASK.id,
      orderId: PALLET.orderId,
      sequenceNo: PALLET.sequenceNo,
      status,
    },
  };
}

function palletProjection(rows = PALLET_VIEW.rows) {
  return {
    id: PALLET.id,
    palletCode: PALLET.palletCode,
    orderId: PALLET.orderId,
    sequenceNo: PALLET.sequenceNo,
    status: 'open',
    openedAt: new Date(PALLET_VIEW.openedAt),
    order: { orderNumber: PALLET_VIEW.orderNumber },
    _count: { items: rows.length },
    items: rows.map((row, index) => ({
      id: `item-${index + 1}`,
      rollCode: row.rollCode,
      position: row.position,
      acceptedAt: new Date(row.acceptedAt),
      scanRow: { scannedByName: row.scannedByName },
    })),
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function setup() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ id: TASK.id }]),
    warehouseAcceptanceTask: {
      findUnique: jest.fn().mockResolvedValue(TASK),
    },
    scanRow: {
      findUnique: jest.fn().mockResolvedValue(ROW),
    },
    commercialOrder: {
      findFirst: jest.fn().mockResolvedValue(ORDER),
    },
    warehousePalletItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(VOID_ITEMS),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _max: { position: null } }),
      create: jest.fn().mockResolvedValue({ position: 1 }),
    },
    warehousePallet: {
      findFirst: jest.fn().mockResolvedValue(PALLET),
      findUnique: jest.fn().mockResolvedValue(palletProjection()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
      create: jest.fn().mockResolvedValue(PALLET),
    },
    palletListDocument: {
      findUnique: jest.fn().mockResolvedValue(VOID_DOCUMENT),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    palletScanToken: { update: jest.fn(), delete: jest.fn() },
    palletPrintJob: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      delete: jest.fn(),
    },
    warehousePalletCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'command-1', ...data }),
        ),
    },
  };
  const prisma = {
    warehousePalletCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    warehousePallet: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    warehousePalletItem: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    palletListDocument: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(
      (
        operation: (client: typeof tx) => Promise<WarehousePalletSelectionResult>,
        _options: { isolationLevel: Prisma.TransactionIsolationLevel },
      ) => operation(tx),
    ),
  };
  const audit = {
    record: jest.fn().mockResolvedValue({ id: 'event-1' }),
  };
  const pallets = {
    prepareOpenPallet: jest.fn().mockResolvedValue(PALLET),
    attachAcceptedRoll: jest.fn().mockResolvedValue({ position: 1 }),
  };
  const service = new WarehousePalletSelectionService(
    prisma as never,
    audit as never,
    pallets as never,
  );

  return { audit, pallets, prisma, service, tx };
}

describe('SetPalletSelectionDto', () => {
  it('accepts only a UUID v4 operation key and a boolean selection', async () => {
    const valid = Object.assign(new SetPalletSelectionDto(), {
      operationKey: OPERATION_KEY,
      selected: true,
    });
    await expect(validate(valid)).resolves.toHaveLength(0);

    const invalid = Object.assign(new SetPalletSelectionDto(), {
      operationKey: 'same-request',
      selected: 'true',
    });
    const errors = await validate(invalid);
    expect(errors.map((error) => error.property).sort()).toEqual(['operationKey', 'selected']);
  });
});

describe('VoidPalletDto', () => {
  it('accepts a 500-character note and rejects 501 characters before persistence', async () => {
    const accepted = Object.assign(new VoidPalletDto(), {
      operationKey: VOID_OPERATION_KEY,
      reasonCode: 'wrong_composition',
      note: 'x'.repeat(500),
    });
    await expect(validate(accepted)).resolves.toHaveLength(0);

    const rejected = Object.assign(new VoidPalletDto(), {
      operationKey: VOID_OPERATION_KEY,
      reasonCode: 'wrong_composition',
      note: 'x'.repeat(501),
    });
    const errors = await validate(rejected);
    expect(errors.map((error) => error.property)).toEqual(['note']);

    expect(
      Reflect.getMetadata('swagger/apiModelProperties', VoidPalletDto.prototype, 'note'),
    ).toEqual(expect.objectContaining({ maxLength: 500, required: false }));
  });

  it('accepts only a UUID v4 operation key and an exact reason code', async () => {
    const invalid = Object.assign(new VoidPalletDto(), {
      operationKey: 'same-request',
      reasonCode: 'wrong',
    });
    const errors = await validate(invalid);
    expect(errors.map((error) => error.property).sort()).toEqual(['operationKey', 'reasonCode']);
  });
});

describe('WarehousePalletSelectionService', () => {
  it('voids one sealed pallet, releases active memberships, and preserves immutable document facts', async () => {
    const { audit, service, tx } = setup();
    tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'sealed' });

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).resolves.toEqual(VOID_RESULT);

    const lockedTables = tx.$queryRaw.mock.calls.map(([query]) =>
      Array.isArray(query) ? query.join('') : String(query),
    );
    expect(lockedTables.join('\n')).toContain('warehouse_acceptance_tasks');
    expect(lockedTables.join('\n')).toContain('warehouse_pallets');
    expect(lockedTables.join('\n')).toContain('pallet_list_documents');
    expect(lockedTables.join('\n')).toContain('warehouse_pallet_items');
    const itemLock = lockedTables.find((query) => query.includes('warehouse_pallet_items'));
    expect(itemLock).toMatch(/ORDER BY "position", "id"\s+FOR UPDATE/u);
    expect(tx.warehousePalletItem.findMany).toHaveBeenCalledWith({
      where: { palletId: PALLET.id, releasedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, rollCode: true, position: true },
    });
    expect(tx.warehousePalletItem.updateMany).toHaveBeenCalledWith({
      where: { palletId: PALLET.id, releasedAt: null },
      data: {
        releasedAt: expect.any(Date),
        releasedById: ACTOR.userId,
        releaseReason: 'pallet_voided',
      },
    });
    expect(tx.warehousePallet.updateMany).toHaveBeenCalledWith({
      where: { id: PALLET.id, taskId: TASK.id, status: 'sealed' },
      data: expect.objectContaining({
        status: 'voided',
        voidedAt: expect.any(Date),
        voidedById: ACTOR.userId,
        voidReason: 'wrong_composition',
      }),
    });
    expect(tx.palletListDocument.updateMany).toHaveBeenCalledWith({
      where: { id: VOID_DOCUMENT.id, warehousePalletId: PALLET.id, voidedAt: null },
      data: {
        voidedAt: expect.any(Date),
        voidedById: ACTOR.userId,
        voidReasonCode: 'wrong_composition',
        voidNote: 'Повторно собрать состав.',
      },
    });
    expect(tx.palletListDocument.update).not.toHaveBeenCalled();
    expect(tx.palletListDocument.delete).not.toHaveBeenCalled();
    expect(tx.warehousePallet.delete).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.delete).not.toHaveBeenCalled();
    expect(tx.palletScanToken.update).not.toHaveBeenCalled();
    expect(tx.palletScanToken.delete).not.toHaveBeenCalled();
    expect(tx.palletPrintJob.update).not.toHaveBeenCalled();
    expect(tx.palletPrintJob.delete).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'audit:warehouse_pallet_voided', objectId: PALLET.id }),
      tx,
    );
    expect(audit.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'audit:pallet_list_voided', objectId: VOID_DOCUMENT.id }),
      tx,
    );
  });

  it('rejects annulment while the document has an active queued print claim', async () => {
    const { audit, service, tx } = setup();
    tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'sealed' });
    tx.palletPrintJob.findFirst.mockResolvedValue({ id: 'print-job-active' });

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WAREHOUSE_PALLET_VOID_PRINT_IN_PROGRESS',
        printJobId: 'print-job-active',
      },
    });

    expect(tx.palletPrintJob.findFirst).toHaveBeenCalledWith({
      where: {
        palletListDocumentId: VOID_DOCUMENT.id,
        status: 'queued',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    expect(tx.warehousePalletItem.updateMany).not.toHaveBeenCalled();
    expect(tx.warehousePallet.updateMany).not.toHaveBeenCalled();
    expect(tx.palletListDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.warehousePalletCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects voiding a closed intake under the task row lock without mutations or audit', async () => {
    const { audit, service, tx } = setup();
    tx.warehouseAcceptanceTask.findUnique.mockResolvedValue({ ...TASK, status: 'closed' });
    tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'sealed' });

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Закрытая приёмка неизменяема.',
      }),
    ).rejects.toMatchObject({
      response: { code: 'WAREHOUSE_TASK_CLOSED' },
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.warehouseAcceptanceTask.findUnique).toHaveBeenCalledWith({
      where: { id: TASK.id },
      select: { id: true, status: true },
    });
    expect(tx.warehousePallet.findFirst).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.updateMany).not.toHaveBeenCalled();
    expect(tx.palletListDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.warehousePalletCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('preserves the compact immutable profile when voiding and replaying a pallet document', async () => {
    const compactResult = {
      ...VOID_RESULT,
      templateVersion: 'pallet-100x150-compact-v2' as const,
    };
    const { prisma, service, tx } = setup();
    tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'sealed' });
    tx.palletListDocument.findUnique.mockResolvedValue({
      ...VOID_DOCUMENT,
      payload: {
        ...VOID_DOCUMENT.payload,
        templateVersion: compactResult.templateVersion,
        label: {
          ...VOID_DOCUMENT.payload.label,
          templateVersion: compactResult.templateVersion,
        },
      },
    });

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).resolves.toEqual(compactResult);

    prisma.warehousePalletCommand.findUnique.mockResolvedValue(
      storedVoidCommand(compactResult as unknown as Prisma.JsonValue),
    );
    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).resolves.toEqual(compactResult);
  });

  it('rejects a mismatched immutable label profile before any void mutation', async () => {
    const { audit, service, tx } = setup();
    tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'sealed' });
    tx.palletListDocument.findUnique.mockResolvedValue({
      ...VOID_DOCUMENT,
      payload: {
        ...VOID_DOCUMENT.payload,
        label: {
          ...VOID_DOCUMENT.payload.label,
          templateVersion: 'pallet-100x150-compact-v2',
        },
      },
    });

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).rejects.toMatchObject({
      response: { code: 'WAREHOUSE_PALLET_VOID_STATE_CONFLICT' },
    });

    expect(tx.warehousePalletItem.updateMany).not.toHaveBeenCalled();
    expect(tx.warehousePallet.updateMany).not.toHaveBeenCalled();
    expect(tx.palletListDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.warehousePalletCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('voids a multi-item pallet only when the locked ordered composition equals the seal snapshot', async () => {
    const { audit, service, tx } = setup();
    const lockedItems = [
      { id: 'item-1', rollCode: 'ROLL-1', position: 1 },
      { id: 'item-2', rollCode: 'ROLL-2', position: 2 },
    ];
    tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'sealed' });
    tx.warehousePalletItem.findMany.mockResolvedValue(lockedItems);
    tx.warehousePalletItem.updateMany.mockResolvedValue({ count: lockedItems.length });
    tx.palletListDocument.findUnique.mockResolvedValue({
      ...VOID_DOCUMENT,
      rollIds: ['ROLL-1', 'ROLL-2'],
    });

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).resolves.toEqual({
      ...VOID_RESULT,
      rollCount: 2,
      rollCodes: ['ROLL-1', 'ROLL-2'],
    });

    expect(audit.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'audit:warehouse_pallet_voided',
        detail: expect.objectContaining({ releasedRollCount: 2 }),
      }),
      tx,
    );
    expect(audit.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'audit:pallet_list_voided',
        detail: expect.objectContaining({ releasedRollCount: 2 }),
      }),
      tx,
    );
  });

  it.each([
    ['another acceptance task', { acceptanceTaskId: 'task-2' }, VOID_ITEMS],
    ['a legacy origin', { origin: 'legacy' }, VOID_ITEMS],
    ['another physical pallet', { warehousePalletId: 'pallet-2' }, VOID_ITEMS],
    ['another pallet code', { palletId: 'PAL-OTHER-01' }, VOID_ITEMS],
    ['another order', { orderIds: ['order-b'] }, VOID_ITEMS],
    ['duplicate order ids', { orderIds: [PALLET.orderId, PALLET.orderId] }, VOID_ITEMS],
    ['non-string order ids', { orderIds: [PALLET.orderId, 7] }, VOID_ITEMS],
    ['no active composition', { rollIds: [] }, []],
    [
      'a missing roll',
      { rollIds: ['ROLL-1'] },
      [
        { id: 'item-1', rollCode: 'ROLL-1', position: 1 },
        { id: 'item-2', rollCode: 'ROLL-2', position: 2 },
      ],
    ],
    ['an extra roll', { rollIds: ['ROLL-1', 'ROLL-2'] }, VOID_ITEMS],
    [
      'a different roll order',
      { rollIds: ['ROLL-2', 'ROLL-1'] },
      [
        { id: 'item-1', rollCode: 'ROLL-1', position: 1 },
        { id: 'item-2', rollCode: 'ROLL-2', position: 2 },
      ],
    ],
    [
      'duplicate roll ids',
      { rollIds: ['ROLL-1', 'ROLL-1'] },
      [
        { id: 'item-1', rollCode: 'ROLL-1', position: 1 },
        { id: 'item-2', rollCode: 'ROLL-1', position: 2 },
      ],
    ],
    [
      'non-string roll ids',
      { rollIds: ['ROLL-1', 7] },
      [
        { id: 'item-1', rollCode: 'ROLL-1', position: 1 },
        { id: 'item-2', rollCode: 'ROLL-2', position: 2 },
      ],
    ],
  ])(
    'rejects a sealed document bound to %s before any void mutation',
    async (_label, documentPatch, lockedItems) => {
      const { audit, service, tx } = setup();
      tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'sealed' });
      tx.palletListDocument.findUnique.mockResolvedValue({
        ...VOID_DOCUMENT,
        ...documentPatch,
      });
      tx.warehousePalletItem.findMany.mockResolvedValue(lockedItems);

      await expect(
        service.voidPallet(ACTOR, TASK.id, PALLET.id, {
          operationKey: VOID_OPERATION_KEY,
          reasonCode: 'wrong_composition',
          note: 'Повторно собрать состав.',
        }),
      ).rejects.toMatchObject({
        response: { code: 'WAREHOUSE_PALLET_VOID_STATE_CONFLICT' },
      });

      expect(tx.warehousePalletItem.updateMany).not.toHaveBeenCalled();
      expect(tx.warehousePallet.updateMany).not.toHaveBeenCalled();
      expect(tx.palletListDocument.updateMany).not.toHaveBeenCalled();
      expect(tx.warehousePalletCommand.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('rejects when the release count differs from the exact locked composition', async () => {
    const { audit, service, tx } = setup();
    const lockedItems = [
      { id: 'item-1', rollCode: 'ROLL-1', position: 1 },
      { id: 'item-2', rollCode: 'ROLL-2', position: 2 },
    ];
    tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'sealed' });
    tx.warehousePalletItem.findMany.mockResolvedValue(lockedItems);
    tx.warehousePalletItem.updateMany.mockResolvedValue({ count: 1 });
    tx.palletListDocument.findUnique.mockResolvedValue({
      ...VOID_DOCUMENT,
      rollIds: ['ROLL-1', 'ROLL-2'],
    });

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).rejects.toMatchObject({
      response: { code: 'WAREHOUSE_PALLET_VOID_STATE_CONFLICT' },
    });

    expect(tx.warehousePallet.updateMany).not.toHaveBeenCalled();
    expect(tx.palletListDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.warehousePalletCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('replays the exact pallet void snapshot without a transaction or a duplicate audit', async () => {
    const { audit, prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(storedVoidCommand());

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).resolves.toEqual(VOID_RESULT);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a corrupted void replay snapshot that claims the document is still sealed', async () => {
    const { prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(
      storedVoidCommand({ ...VOID_RESULT, documentStatus: 'sealed' }),
    );

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).rejects.toMatchObject({
      response: { code: 'WAREHOUSE_PALLET_VOID_OPERATION_CONFLICT' },
    });
  });

  it('rejects a void replay snapshot with an unsupported immutable profile', async () => {
    const { prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(
      storedVoidCommand({
        ...VOID_RESULT,
        templateVersion: 'pallet-100x150-future',
      } as unknown as Prisma.JsonValue),
    );

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).rejects.toMatchObject({
      response: { code: 'WAREHOUSE_PALLET_VOID_OPERATION_CONFLICT' },
    });
  });

  it('rejects a reused pallet void operation key with a conflicting fingerprint', async () => {
    const { prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(storedVoidCommand());

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'print_problem',
        note: 'Повторно собрать состав.',
      }),
    ).rejects.toMatchObject({ response: { code: 'WAREHOUSE_PALLET_VOID_OPERATION_CONFLICT' } });
  });

  it('makes a concurrent void/open or void/void transition resolve to one valid state', async () => {
    const { prisma, service, tx } = setup();
    tx.warehousePallet.findFirst.mockResolvedValue({ ...PALLET, status: 'open' });
    const concurrent = new Prisma.PrismaClientKnownRequestError('serialization failure', {
      code: 'P2034',
      clientVersion: 'test',
    });
    prisma.$transaction
      .mockRejectedValueOnce(concurrent)
      .mockImplementationOnce(
        (operation: (client: typeof tx) => Promise<WarehousePalletSelectionResult>) =>
          operation(tx),
      );

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).rejects.toMatchObject({ response: { code: 'WAREHOUSE_PALLET_VOID_STATE_CONFLICT' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('returns the winning void snapshot when concurrent void commands collide on the operation key', async () => {
    const { audit, prisma, service } = setup();
    const concurrent = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.$transaction.mockRejectedValueOnce(concurrent);
    prisma.warehousePalletCommand.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storedVoidCommand());

    await expect(
      service.voidPallet(ACTOR, TASK.id, PALLET.id, {
        operationKey: VOID_OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note: 'Повторно собрать состав.',
      }),
    ).resolves.toEqual(VOID_RESULT);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });
  it('returns a bounded active-pallet envelope after selecting a roll', async () => {
    const { service } = setup();

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).resolves.toEqual(SELECTION_RESULT);
  });

  it('bounds the active-pallet composition and advertises omitted rows', async () => {
    const { service, tx } = setup();
    tx.warehousePallet.findUnique.mockResolvedValue(
      palletProjection(
        Array.from({ length: 101 }, (_, index) => ({
          ...PALLET_VIEW.rows[0],
          rollCode: `ROLL-${index + 1}`,
          position: index + 1,
        })),
      ),
    );

    const result = await service.setSelection(ACTOR, TASK.id, ROW.id, {
      operationKey: OPERATION_KEY,
      selected: true,
    });

    expect(result).toMatchObject({
      activePallet: {
        totalCount: 101,
        hasMore: true,
        rows: expect.arrayContaining([expect.objectContaining({ rollCode: 'ROLL-1' })]),
      },
    });
    expect(result.activePallet?.rows).toHaveLength(100);
    expect(tx.warehousePallet.findUnique).toHaveBeenCalledWith({
      where: { id: PALLET.id },
      select: expect.objectContaining({
        items: expect.objectContaining({ take: 100 }),
      }),
    });
  });

  it('records an idempotent deselection no-op with no active pallet and no audit', async () => {
    const { audit, pallets, service, tx } = setup();
    tx.warehousePallet.findFirst.mockResolvedValue(null);

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: false,
      }),
    ).resolves.toEqual({ selectionChanged: false, activePallet: null });

    expect(tx.warehousePalletCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        palletId: null,
        resultSnapshot: { selectionChanged: false, activePallet: null },
      }),
    });
    expect(pallets.prepareOpenPallet).not.toHaveBeenCalled();
    expect(pallets.attachAcceptedRoll).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an idempotency snapshot whose active-pallet rows exceed the response limit', async () => {
    const { prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(
      storedCommand(true, {
        activePallet: {
          ...SELECTION_RESULT.activePallet!,
          rows: Array.from({ length: 101 }, (_, index) => ({
            ...PALLET_VIEW.rows[0],
            rollCode: `ROLL-${index + 1}`,
            position: index + 1,
          })),
          totalCount: 101,
          hasMore: false,
        },
      }),
    );

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).rejects.toMatchObject({
      response: { code: 'WAREHOUSE_PALLET_SELECTION_OPERATION_CONFLICT' },
    });
  });

  it.each([
    ['an invalid timestamp', { openedAt: '2026-08-07' }],
    ['a non-positive pallet sequence', { sequenceNo: 0 }],
    ['a non-positive row position', { rows: [{ ...PALLET_VIEW.rows[0], position: 0 }] }],
    ['an overlong pallet code', { palletCode: 'P'.repeat(129) }],
    ['an inconsistent pagination count', { totalCount: 2, hasMore: false }],
    ['a missing row below the limit', { totalCount: 2, hasMore: true }],
    ['an empty row page at the limit', { totalCount: 100, rows: [], hasMore: true }],
  ])('rejects an idempotency snapshot with %s', async (_label, patch) => {
    const { prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(
      storedCommand(true, {
        activePallet: { ...SELECTION_RESULT.activePallet!, ...patch },
      }),
    );

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).rejects.toMatchObject({
      response: { code: 'WAREHOUSE_PALLET_SELECTION_OPERATION_CONFLICT' },
    });
  });

  it('locks the receiving task and accepted row before selecting it into the same-order pallet', async () => {
    const { audit, pallets, prisma, service, tx } = setup();

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).resolves.toEqual(SELECTION_RESULT);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('FROM "warehouse_acceptance_tasks"');
    expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(TASK.id);
    expect(tx.$queryRaw.mock.calls[1][0].join('')).toContain('FROM "scan_rows"');
    expect(tx.$queryRaw.mock.calls[1][0].join('')).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.calls[1][1]).toBe(ROW.id);
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      pallets.prepareOpenPallet.mock.invocationCallOrder[0],
    );
    expect(pallets.prepareOpenPallet).toHaveBeenCalledWith(tx, {
      taskId: TASK.id,
      orderId: TASK.orderId,
      orderNumber: ORDER.orderNumber,
      actor: ACTOR,
    });
    expect(pallets.attachAcceptedRoll).toHaveBeenCalledWith(tx, {
      pallet: PALLET,
      scanRowId: ROW.id,
      rollCode: ROW.rollCode,
      acceptedAt: ROW.lastScanAt,
      actorId: ACTOR.userId,
    });
    expect(tx.warehousePalletCommand.create).toHaveBeenCalledWith({
      data: {
        operationKey: OPERATION_KEY,
        requestFingerprint: fingerprint(true),
        kind: 'set_selection',
        taskId: TASK.id,
        scanRowId: ROW.id,
        palletId: PALLET.id,
        actorId: ACTOR.userId,
        resultSnapshot: SELECTION_RESULT,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        type: 'audit:warehouse_pallet_roll_selected',
        actorRole: 'warehouse',
        actorId: ACTOR.userId,
        objectId: ROW.rollCode,
        oldValue: { selected: false },
        newValue: { selected: true },
        detail: {
          taskId: TASK.id,
          palletId: PALLET.id,
          palletCode: PALLET.palletCode,
          orderId: TASK.orderId,
          scanRowId: ROW.id,
          rollCode: ROW.rollCode,
          position: 1,
        },
      },
      tx,
    );
  });

  it('soft-releases an open membership and records one deselection fact', async () => {
    const { audit, prisma, tx } = setup();
    tx.warehousePalletItem.findFirst.mockResolvedValue(activeMembership());
    tx.warehousePalletItem.count.mockResolvedValue(1);
    tx.warehousePallet.findUnique.mockResolvedValue(palletProjection([]));
    const palletLifecycle = new WarehousePalletService(
      prisma as never,
      audit as never,
      { print: jest.fn() } as never,
      { palletLabelProfile: 'pallet-100x150-v1' },
      {} as never,
    );
    const service = new WarehousePalletSelectionService(
      prisma as never,
      audit as never,
      palletLifecycle,
    );

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: false,
      }),
    ).resolves.toEqual({
      selectionChanged: true,
      activePallet: {
        ...SELECTION_RESULT.activePallet!,
        totalCount: 0,
        rows: [],
      },
    });

    expect(tx.warehousePalletItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'item-1',
        releasedAt: null,
        pallet: { status: 'open' },
      },
      data: {
        releasedAt: expect.any(Date),
        releasedById: ACTOR.userId,
        releaseReason: 'manual_deselection',
      },
    });
    expect(tx.warehousePallet.create).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_pallet_roll_deselected',
        objectId: ROW.rollCode,
        oldValue: { selected: true },
        newValue: { selected: false },
        detail: expect.objectContaining({
          taskId: TASK.id,
          palletId: PALLET.id,
          orderId: TASK.orderId,
          scanRowId: ROW.id,
          rollCode: ROW.rollCode,
          position: 1,
        }),
      }),
      tx,
    );
  });

  it('voids the last-roll pallet, permits task close/projection, and selects into a new pallet', async () => {
    let oldPalletStatus = 'open';
    let oldMembershipActive = true;
    let newMembershipActive = false;
    const newPallet = {
      id: 'pallet-2',
      palletCode: 'PAL-A-100-02',
      orderId: PALLET.orderId,
      sequenceNo: 2,
    };
    const { audit, prisma, tx } = setup();
    tx.warehousePalletItem.findFirst.mockImplementation(
      ({ where }: { where: { scanRowId?: string } }) => {
        if (where.scanRowId !== ROW.id) return Promise.resolve(null);
        if (oldMembershipActive) return Promise.resolve(activeMembership());
        return Promise.resolve(null);
      },
    );
    tx.warehousePalletItem.updateMany.mockImplementation(() => {
      oldMembershipActive = false;
      return Promise.resolve({ count: 1 });
    });
    tx.warehousePalletItem.count = jest
      .fn()
      .mockImplementation(() => Promise.resolve(newMembershipActive ? 1 : 0));
    tx.warehousePalletItem.aggregate = jest.fn().mockResolvedValue({ _max: { position: 1 } });
    tx.warehousePalletItem.create = jest.fn().mockImplementation(() => {
      newMembershipActive = true;
      return Promise.resolve({ position: 2 });
    });
    tx.warehousePallet.findFirst.mockImplementation(
      ({ where }: { where: { taskId?: string; status?: string; orderId?: string } }) => {
        if (where.taskId === TASK.id && where.status === 'open') {
          return Promise.resolve(oldPalletStatus === 'open' ? PALLET : null);
        }
        if (where.orderId === ORDER.id) return Promise.resolve({ sequenceNo: 1 });
        return Promise.resolve(null);
      },
    );
    tx.warehousePallet.updateMany = jest.fn().mockImplementation(() => {
      oldPalletStatus = 'voided';
      return Promise.resolve({ count: 1 });
    });
    tx.warehousePallet.create = jest.fn().mockResolvedValue(newPallet);
    tx.warehousePallet.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        ...palletProjection(
          newMembershipActive
            ? [
                {
                  ...PALLET_VIEW.rows[0],
                  position: 2,
                },
              ]
            : [],
        ),
        id: where.id,
        palletCode: newPallet.palletCode,
        sequenceNo: newPallet.sequenceNo,
      }),
    );
    prisma.warehousePallet.findMany.mockImplementation(() =>
      Promise.resolve(oldPalletStatus === 'open' ? [{ ...PALLET, items: [] }] : []),
    );
    prisma.warehousePalletItem.findMany.mockResolvedValue([]);
    prisma.palletListDocument.findMany.mockResolvedValue([]);
    const pallets = new WarehousePalletService(
      prisma as never,
      audit as never,
      { print: jest.fn() } as never,
      { palletLabelProfile: 'pallet-100x150-v1' },
      {} as never,
    );
    const service = new WarehousePalletSelectionService(prisma as never, audit as never, pallets);

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: false,
      }),
    ).resolves.toEqual({ selectionChanged: true, activePallet: null });
    await expect(pallets.assertNoOpenItems(tx as never, TASK.id)).resolves.toBeUndefined();
    await expect(pallets.projectForTasks([TASK.id])).resolves.toEqual(
      new Map([
        [
          TASK.id,
          {
            activePallet: null,
            history: [],
            hasMore: false,
            selectionsByScanRowId: new Map(),
          },
        ],
      ]),
    );

    expect(tx.warehousePallet.updateMany).toHaveBeenCalledWith({
      where: {
        id: PALLET.id,
        status: 'open',
        items: { none: { releasedAt: null } },
      },
      data: {
        status: 'voided',
        voidedAt: expect.any(Date),
        voidedById: ACTOR.userId,
        voidReason: 'empty_after_last_release',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_pallet_voided',
        objectId: PALLET.id,
        reason: 'empty_after_last_release',
        oldValue: { status: 'open' },
        newValue: { status: 'voided' },
      }),
      tx,
    );

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: '223e4567-e89b-42d3-a456-426614174000',
        selected: true,
      }),
    ).resolves.toMatchObject({
      activePallet: {
        id: newPallet.id,
        palletCode: newPallet.palletCode,
        sequenceNo: 2,
        totalCount: 1,
      },
    });
    expect(tx.warehousePallet.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: TASK.id,
        orderId: ORDER.id,
        sequenceNo: 2,
      }),
      select: expect.any(Object),
    });
  });

  it('uses the durable task timestamp for a legacy accepted row without lastScanAt', async () => {
    const { pallets, service, tx } = setup();
    tx.scanRow.findUnique.mockResolvedValue({ ...ROW, lastScanAt: null });

    await service.setSelection(ACTOR, TASK.id, ROW.id, {
      operationKey: OPERATION_KEY,
      selected: true,
    });

    expect(pallets.attachAcceptedRoll).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ acceptedAt: TASK.updatedAt }),
    );
  });

  it('returns the stored include result on replay without a transaction or duplicate audit', async () => {
    const { audit, prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(storedCommand(true));

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).resolves.toEqual(SELECTION_RESULT);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('replays a legacy selection snapshot as an unchanged outcome', async () => {
    const { prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(
      storedCommand(true, { activePallet: SELECTION_RESULT.activePallet }),
    );

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).resolves.toEqual({ selectionChanged: false, activePallet: SELECTION_RESULT.activePallet });
  });

  it('rejects reuse of an operation key with a different selection fingerprint', async () => {
    const { prisma, service } = setup();
    prisma.warehousePalletCommand.findUnique.mockResolvedValue(storedCommand(true));

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: false,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WAREHOUSE_PALLET_SELECTION_OPERATION_CONFLICT',
      },
    });
  });

  it('rejects a row that has not been accepted', async () => {
    const { audit, pallets, service, tx } = setup();
    tx.scanRow.findUnique.mockResolvedValue({ ...ROW, scanStatus: 'expected' });

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WAREHOUSE_PALLET_ROLL_NOT_ACCEPTED',
      },
    });
    expect(pallets.prepareOpenPallet).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects selection outside a receiving task', async () => {
    const { pallets, service, tx } = setup();
    tx.warehouseAcceptanceTask.findUnique.mockResolvedValue({ ...TASK, mode: 'delivery' });

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WAREHOUSE_PALLET_ROLL_NOT_ACCEPTED',
      },
    });
    expect(pallets.prepareOpenPallet).not.toHaveBeenCalled();
  });

  it('rejects a scan row whose order reference differs from the receiving task', async () => {
    const { audit, pallets, service, tx } = setup();
    tx.scanRow.findUnique.mockResolvedValue({ ...ROW, fromOrderId: 'B-200' });

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WAREHOUSE_PALLET_ORDER_MISMATCH',
        taskOrderId: TASK.orderId,
        rowOrderReference: 'B-200',
      },
    });
    expect(pallets.prepareOpenPallet).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['sealed', 'voided'] as const)(
    'rejects an active membership in a %s pallet as locked',
    async (status) => {
      const { audit, pallets, service, tx } = setup();
      tx.warehousePalletItem.findFirst.mockResolvedValue(activeMembership(status));

      await expect(
        service.setSelection(ACTOR, TASK.id, ROW.id, {
          operationKey: OPERATION_KEY,
          selected: true,
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'WAREHOUSE_PALLET_SELECTION_LOCKED',
          palletId: PALLET.id,
          palletStatus: status,
        },
      });
      expect(pallets.attachAcceptedRoll).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('persists an idempotent no-op include without emitting a selection audit twice', async () => {
    const { audit, pallets, service, tx } = setup();
    tx.warehousePalletItem.findFirst.mockResolvedValue(activeMembership());

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).resolves.toEqual({ ...SELECTION_RESULT, selectionChanged: false });

    expect(pallets.attachAcceptedRoll).not.toHaveBeenCalled();
    expect(tx.warehousePalletCommand.create).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('retries a unique-constraint conflict and returns the persisted active membership', async () => {
    const { audit, pallets, prisma, service, tx } = setup();
    tx.warehousePalletItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activeMembership());
    pallets.attachAcceptedRoll.mockRejectedValueOnce(uniqueViolation());

    await expect(
      service.setSelection(ACTOR, TASK.id, ROW.id, {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).resolves.toEqual({ ...SELECTION_RESULT, selectionChanged: false });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(pallets.attachAcceptedRoll).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
