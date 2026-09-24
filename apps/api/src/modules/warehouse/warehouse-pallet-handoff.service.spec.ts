import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { WarehousePalletHandoffScanResult } from '@plenka/contracts';
import { validate } from 'class-validator';
import type { Actor } from '../../common/auth/actor';
import type { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import type { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { PalletHandoffScanDto } from './dto/pallet-handoff-scan.dto';
import { WarehousePalletHandoffService } from './warehouse-pallet-handoff.service';

const ACTOR: Actor = {
  userId: 'warehouse-user',
  role: 'warehouse',
  capabilities: ['warehouse:scan'],
};

const OPERATION_KEY = '123e4567-e89b-42d3-a456-426614174000';
const PALLET_PAYLOAD = `plt_${'a'.repeat(64)}`;
const OTHER_PALLET_PAYLOAD = `plt_${'b'.repeat(64)}`;
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

function palletItem(rollCode: string, position: number) {
  return {
    id: `item-${position}`,
    scanRowId: `scan-${position}`,
    orderId: 'order-1',
    rollCode,
    position,
    acceptedAt: new Date(`2026-08-17T08:0${position}:00.000Z`),
    releasedAt: null,
    scanRow: {
      id: `scan-${position}`,
      taskId: 'receiving-1',
      rollCode,
      scanStatus: 'accepted',
      lastScanAt: new Date(`2026-08-17T08:0${position}:00.000Z`),
      operations: [
        {
          taskId: 'receiving-1',
          scanRowId: `scan-${position}`,
          rollCode,
          kind: 'receiving_scan',
          status: 'succeeded',
        },
      ],
    },
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
      sealedAt: new Date('2026-08-17T08:03:00.000Z') as Date | null,
      voidedAt: null as Date | null,
      items: ROLL_CODES.map((rollCode, index) => palletItem(rollCode, index + 1)),
    },
  };
}

type WarehouseRollFixture = {
  id: string;
  rollCode: string;
  warehouseStatus: string;
  receivedAt: Date | null;
  producedForOrderId: string | null;
  reservedForOrderId: string | null;
};

function receivedRoll(rollCode: string, index: number): WarehouseRollFixture {
  return {
    id: `warehouse-roll-${index + 1}`,
    rollCode,
    warehouseStatus: 'received',
    receivedAt: new Date(`2026-08-17T08:0${index + 1}:00.000Z`),
    producedForOrderId: 'order-1',
    reservedForOrderId: null,
  };
}

function expectedResult(overrides: Partial<WarehousePalletHandoffScanResult> = {}) {
  return {
    operationKey: OPERATION_KEY,
    documentId: 'document-1',
    palletId: 'pallet-1',
    palletCode: 'PAL-A-100-01',
    orderId: 'order-1',
    deliveryTaskId: 'delivery-1',
    deliveryCreated: true,
    rollCount: 2,
    replayed: false,
    ...overrides,
  } satisfies WarehousePalletHandoffScanResult;
}

function fingerprint(payload = PALLET_PAYLOAD) {
  return requestFingerprint({ command: 'warehouse_pallet_handoff_scan', payload });
}

function storedCommand(
  resultSnapshot: Prisma.JsonValue = expectedResult() as unknown as Prisma.JsonValue,
  payload = PALLET_PAYLOAD,
) {
  return {
    kind: 'pallet_handoff_scan',
    taskId: 'receiving-1',
    scanRowId: null,
    palletId: 'pallet-1',
    actorId: ACTOR.userId,
    requestFingerprint: fingerprint(payload),
    resultSnapshot,
  };
}

type SetupOptions = {
  document?: ReturnType<typeof validDocument>;
  tokenFound?: boolean;
  rolls?: ReturnType<typeof receivedRoll>[];
  deliveryRows?: Array<{ id: string; rollCode: string }>;
  handoffResult?: {
    state: 'incomplete' | 'ready_for_shipment' | 'shipped';
    deliveryTaskId: string | null;
    created: boolean;
    reason: 'incomplete' | 'already_shipped' | 'roll_facts_mismatch' | null;
  };
  existingCommand?: ReturnType<typeof storedCommand> | null;
  openProductionProblemCount?: number;
};

function setup(options: SetupOptions = {}) {
  const document = options.document ?? validDocument();
  const rolls = options.rolls ?? ROLL_CODES.map(receivedRoll);
  const deliveryRows =
    options.deliveryRows ??
    ROLL_CODES.map((rollCode, index) => ({ id: `delivery-row-${index}`, rollCode }));
  const existingCommand = options.existingCommand ?? null;
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    palletScanToken: {
      findUnique: jest.fn().mockResolvedValue(
        options.tokenFound === false
          ? null
          : {
              documentId: document.id,
              document: {
                warehousePalletId: document.warehousePalletId,
                acceptanceTaskId: document.acceptanceTaskId,
                warehousePallet: { orderId: document.warehousePallet.orderId },
              },
            },
      ),
    },
    palletListDocument: {
      findUnique: jest.fn().mockResolvedValue(document),
    },
    warehouseRoll: {
      findMany: jest.fn().mockResolvedValue(rolls),
    },
    warehouseAcceptanceTask: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'delivery-1',
        mode: 'delivery',
        orderId: 'order-1',
        rows: deliveryRows,
      }),
    },
    warehousePalletCommand: {
      findUnique: jest.fn().mockResolvedValue(existingCommand),
      create: jest.fn().mockResolvedValue({ id: 'command-1' }),
    },
    productionProblem: {
      count: jest.fn().mockResolvedValue(options.openProductionProblemCount ?? 1),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(
      async (work: (client: typeof tx) => Promise<WarehousePalletHandoffScanResult>) => work(tx),
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const handoff = {
    acquireDeliveryScopeLock: jest.fn().mockResolvedValue({}),
    reconcilePalletScan: jest.fn().mockResolvedValue(
      options.handoffResult ?? {
        state: 'ready_for_shipment',
        deliveryTaskId: 'delivery-1',
        created: true,
        reason: null,
      },
    ),
  };
  const service = new WarehousePalletHandoffService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    handoff as unknown as OrderFulfillmentHandoffService,
  );
  return { audit, document, handoff, prisma, service, tx };
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

function expectNoJournalOrAudit(context: ReturnType<typeof setup>): void {
  expect(context.tx.warehousePalletCommand.create).not.toHaveBeenCalled();
  expect(context.audit.record).not.toHaveBeenCalled();
}

describe('PalletHandoffScanDto', () => {
  it('accepts only UUIDv4 plus the exact lowercase opaque pallet token', async () => {
    const valid = Object.assign(new PalletHandoffScanDto(), {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });
    const roll = Object.assign(new PalletHandoffScanDto(), {
      operationKey: OPERATION_KEY,
      payload: `prt_${'a'.repeat(64)}`,
    });
    const uppercase = Object.assign(new PalletHandoffScanDto(), {
      operationKey: OPERATION_KEY,
      payload: `plt_${'A'.repeat(64)}`,
    });
    const wrongUuidVersion = Object.assign(new PalletHandoffScanDto(), {
      operationKey: '123e4567-e89b-12d3-a456-426614174000',
      payload: PALLET_PAYLOAD,
    });

    await expect(validate(valid)).resolves.toHaveLength(0);
    await expect(validate(roll)).resolves.not.toHaveLength(0);
    await expect(validate(uppercase)).resolves.not.toHaveLength(0);
    await expect(validate(wrongUuidVersion)).resolves.not.toHaveLength(0);
  });
});

describe('WarehousePalletHandoffService', () => {
  it('creates delivery through the pallet-only policy and persists one safe command/audit fact', async () => {
    const context = setup();

    await expect(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
    ).resolves.toEqual(expectedResult());

    expect(context.handoff.acquireDeliveryScopeLock).toHaveBeenCalledWith(context.tx, 'order-1');
    expect(context.handoff.reconcilePalletScan).toHaveBeenCalledWith(
      { userId: ACTOR.userId, role: ACTOR.role },
      'order-1',
      ROLL_CODES,
      context.tx,
      expect.any(Object),
    );
    expect(context.tx.warehousePalletCommand.create).toHaveBeenCalledWith({
      data: {
        operationKey: OPERATION_KEY,
        requestFingerprint: fingerprint(),
        kind: 'pallet_handoff_scan',
        taskId: 'receiving-1',
        scanRowId: null,
        palletId: 'pallet-1',
        actorId: ACTOR.userId,
        resultSnapshot: expectedResult(),
      },
    });
    expect(context.audit.record).toHaveBeenCalledWith(
      {
        type: 'audit:warehouse_pallet_handoff_scanned',
        actorRole: ACTOR.role,
        actorId: ACTOR.userId,
        objectId: 'pallet-1',
        newValue: { deliveryTaskId: 'delivery-1', deliveryCreated: true },
        detail: {
          acceptanceTaskId: 'receiving-1',
          documentId: 'document-1',
          palletId: 'pallet-1',
          palletCode: 'PAL-A-100-01',
          orderId: 'order-1',
          deliveryTaskId: 'delivery-1',
          deliveryCreated: true,
          rollCount: 2,
          remainingOpenProductionProblemCount: 1,
          captureChannel: 'warehouse_browser_hid',
        },
      },
      context.tx,
    );
    expect(JSON.stringify(context.audit.record.mock.calls)).not.toContain(PALLET_PAYLOAD);
    expect(JSON.stringify(context.tx.warehousePalletCommand.create.mock.calls)).not.toContain(
      PALLET_PAYLOAD,
    );
  });

  it('replays the same actor/key/payload without resolving the token or mutating again', async () => {
    const context = setup({ existingCommand: storedCommand() });

    await expect(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
    ).resolves.toEqual(expectedResult({ replayed: true }));

    expect(context.tx.palletScanToken.findUnique).not.toHaveBeenCalled();
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
    expectNoJournalOrAudit(context);
  });

  it('reconstructs a bounded replay without leaking extra persisted snapshot fields', async () => {
    const snapshot = {
      ...expectedResult(),
      payload: PALLET_PAYLOAD,
      customer: { name: 'sensitive' },
      rawDeviceFrame: 'raw-frame',
    } as unknown as Prisma.JsonValue;
    const context = setup({ existingCommand: storedCommand(snapshot) });

    const result = await context.service.scan(ACTOR, {
      operationKey: OPERATION_KEY,
      payload: PALLET_PAYLOAD,
    });

    expect(result).toEqual(expectedResult({ replayed: true }));
    expect(JSON.stringify(result)).not.toContain(PALLET_PAYLOAD);
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(JSON.stringify(result)).not.toContain('raw-frame');
    expectNoJournalOrAudit(context);
  });

  it('rejects a corrupted replay snapshot instead of guessing a prior outcome', async () => {
    const corrupted = { ...expectedResult(), deliveryTaskId: null } as unknown as Prisma.JsonValue;
    const context = setup({ existingCommand: storedCommand(corrupted) });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_HANDOFF_RESULT_CORRUPTED',
    );
    expect(context.tx.palletScanToken.findUnique).not.toHaveBeenCalled();
    expectNoJournalOrAudit(context);
  });

  it('rejects reuse of an operation key with another pallet payload before lookup', async () => {
    const context = setup({ existingCommand: storedCommand() });

    await expectErrorCode(
      context.service.scan(ACTOR, {
        operationKey: OPERATION_KEY,
        payload: OTHER_PALLET_PAYLOAD,
      }),
      'WAREHOUSE_PALLET_HANDOFF_OPERATION_CONFLICT',
    );

    expect(context.tx.palletScanToken.findUnique).not.toHaveBeenCalled();
    expectNoJournalOrAudit(context);
  });

  it('rejects an unknown pallet token before taking a delivery lock', async () => {
    const context = setup({ tokenFound: false });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_QR_NOT_FOUND',
    );

    expect(context.handoff.acquireDeliveryScopeLock).not.toHaveBeenCalled();
    expectNoJournalOrAudit(context);
  });

  it.each([
    [
      'legacy document',
      (document: ReturnType<typeof validDocument>) => (document.origin = 'legacy'),
    ],
    [
      'voided document',
      (document: ReturnType<typeof validDocument>) => (document.voidedAt = new Date()),
    ],
    [
      'open pallet',
      (document: ReturnType<typeof validDocument>) => (document.warehousePallet.status = 'open'),
    ],
    [
      'voided pallet',
      (document: ReturnType<typeof validDocument>) =>
        (document.warehousePallet.voidedAt = new Date()),
    ],
    [
      'unsealed pallet',
      (document: ReturnType<typeof validDocument>) => (document.warehousePallet.sealedAt = null),
    ],
    [
      'wrong task mode',
      (document: ReturnType<typeof validDocument>) => (document.acceptanceTask.mode = 'delivery'),
    ],
  ])('rejects %s as non-handoffable', async (_label, mutate) => {
    const document = validDocument();
    mutate(document);
    const context = setup({ document });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_HANDOFF_STATE_CONFLICT',
    );
    expectNoJournalOrAudit(context);
  });

  it.each(['open', 'partial'])(
    'hands off a sealed pallet from a %s receiving task',
    async (status) => {
      const document = validDocument();
      document.acceptanceTask.status = status;
      const context = setup({ document });

      await expect(
        context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      ).resolves.toEqual(expectedResult());
      expect(context.handoff.reconcilePalletScan).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'released member',
      (document: ReturnType<typeof validDocument>) => document.warehousePallet.items.pop(),
    ],
    [
      'reordered member',
      (document: ReturnType<typeof validDocument>) => document.warehousePallet.items.reverse(),
    ],
    [
      'duplicate member',
      (document: ReturnType<typeof validDocument>) => {
        document.warehousePallet.items[1]!.rollCode = ROLL_CODES[0];
        document.warehousePallet.items[1]!.scanRow.rollCode = ROLL_CODES[0];
      },
    ],
    [
      'corrupted immutable snapshot',
      (document: ReturnType<typeof validDocument>) => {
        document.payload.label.rollCodes = [...ROLL_CODES].reverse();
      },
    ],
  ])('rejects %s before fulfillment', async (_label, mutate) => {
    const document = validDocument();
    mutate(document);
    const context = setup({ document });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_HANDOFF_STATE_CONFLICT',
    );
    expect(context.handoff.reconcilePalletScan).not.toHaveBeenCalled();
    expectNoJournalOrAudit(context);
  });

  it('rejects a pallet member without individual accepted scan evidence', async () => {
    const document = validDocument();
    document.warehousePallet.items[1]!.scanRow.scanStatus = 'expected';
    const context = setup({ document });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_HANDOFF_STATE_CONFLICT',
    );
    expect(context.handoff.reconcilePalletScan).not.toHaveBeenCalled();
    expectNoJournalOrAudit(context);
  });

  it('rejects a pallet member without a durable succeeded receiving operation', async () => {
    const document = validDocument();
    document.warehousePallet.items[1]!.scanRow.operations = [];
    const context = setup({ document });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_HANDOFF_STATE_CONFLICT',
    );
    expect(context.handoff.reconcilePalletScan).not.toHaveBeenCalled();
    expectNoJournalOrAudit(context);
  });

  it.each([
    [
      'not received',
      () => [
        receivedRoll(ROLL_CODES[0], 0),
        { ...receivedRoll(ROLL_CODES[1], 1), warehouseStatus: 'sent' },
      ],
    ],
    [
      'wrong order provenance',
      () => [
        receivedRoll(ROLL_CODES[0], 0),
        { ...receivedRoll(ROLL_CODES[1], 1), producedForOrderId: 'other-order' },
      ],
    ],
  ])('rejects a pallet warehouse roll that is %s', async (_label, makeRolls) => {
    const context = setup({ rolls: makeRolls() });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_HANDOFF_ROLLS_INVALID',
    );
    expect(context.handoff.reconcilePalletScan).not.toHaveBeenCalled();
    expectNoJournalOrAudit(context);
  });

  it('accepts legacy V1 order provenance through an exact warehouse reservation', async () => {
    const rolls = ROLL_CODES.map((rollCode, index) => ({
      ...receivedRoll(rollCode, index),
      producedForOrderId: null,
      reservedForOrderId: 'order-1',
    }));
    const context = setup({ rolls });

    await expect(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
    ).resolves.toEqual(expectedResult());
    expect(context.handoff.reconcilePalletScan).toHaveBeenCalledTimes(1);
  });

  it('rejects an incomplete fulfillment result and rolls back before command/audit persistence', async () => {
    const context = setup({
      handoffResult: {
        state: 'incomplete',
        deliveryTaskId: null,
        created: false,
        reason: 'incomplete',
      },
    });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_HANDOFF_INCOMPLETE',
    );
    expectNoJournalOrAudit(context);
  });

  it('hands off a sealed pallet while the rest of its order is still incomplete', async () => {
    const context = setup({
      handoffResult: {
        state: 'incomplete',
        deliveryTaskId: 'delivery-1',
        created: true,
        reason: null,
      },
    });

    await expect(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
    ).resolves.toEqual(expectedResult());
    expect(context.handoff.reconcilePalletScan).toHaveBeenCalledWith(
      { userId: ACTOR.userId, role: ACTOR.role },
      'order-1',
      ROLL_CODES,
      context.tx,
      expect.any(Object),
    );
  });

  it('rejects a delivery task that omits any immutable pallet member', async () => {
    const context = setup({ deliveryRows: [{ id: 'delivery-row-1', rollCode: ROLL_CODES[0] }] });

    await expectErrorCode(
      context.service.scan(ACTOR, { operationKey: OPERATION_KEY, payload: PALLET_PAYLOAD }),
      'WAREHOUSE_PALLET_HANDOFF_DELIVERY_MISMATCH',
    );
    expectNoJournalOrAudit(context);
  });
});
