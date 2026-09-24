import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OperatorOperationService } from './operator-operation.service';
import { OperatorPhysicalService } from './operator-physical.service';

const actor = { userId: 'operator-a', role: 'operator' as const };
const session = { id: 'session-a', postId: 'post-a', shiftId: 'shift-a' };
const LEASE_TOKEN = '88c962a9-e75a-4cc6-96f4-1b5d02f88c1b';
const primaryRollCapture = {
  id: 'capture-primary',
  operatorRollLineId: 'line-a',
  kind: 'roll',
  deviceId: 'scale-a',
  deviceStatus: 'ready',
  stable: true,
  grossKg: 11,
  spoolKg: 1,
  netKg: 10,
  toleranceOk: true,
  supersedesCaptureId: null,
  createdAt: new Date('2026-07-22T08:00:00.000Z'),
};
const invalidHandoverCapture = {
  ...primaryRollCapture,
  id: 'capture-a16-invalid',
  grossKg: 3.1,
  spoolKg: 3.65,
  netKg: -0.55,
  toleranceOk: false,
};
const recoveredHandoverCapture = {
  ...invalidHandoverCapture,
  id: 'capture-a16-recovered',
  grossKg: 6.65,
  netKg: 3,
  toleranceOk: false,
  supersedesCaptureId: 'capture-a16-invalid',
  createdAt: new Date('2026-08-13T12:00:00.000Z'),
};
const line = {
  id: 'line-a',
  rollDispatchItemId: 'dispatch-a',
  sequence: 1,
  groupId: 'group-a',
  step: 'assigned',
  labelState: 'not_printed',
  warehouseState: 'not_ready',
  spoolKg: null,
  planKg: 10,
  rollDispatchItem: {
    id: 'dispatch-a',
    rollCode: 'ROLL-A',
    status: 'assigned',
    productionOrderId: 'production-a',
    orderLineId: 'position-a',
    positionSequence: 1,
    rawMaterialId: 'material-a',
    recipeVersion: 'recipe-v1',
    filmType: 'PE',
    plannedWeightKg: 10,
    plannedLengthM: 500,
    characteristicsSnapshot: { widthMm: 1_700 },
    assignedOperatorId: 'operator-a',
    machineId: 'machine-a',
    workplaceId: 'workplace-a',
    postId: 'post-a',
    plannedShiftId: 'shift-a',
    queueRank: 7,
    priority: 2,
    bulkGroupId: 'bulk-a',
    productionOrder: {
      id: 'production-a',
      approvalState: 'approved',
      commercialOrderId: 'order-a',
      commercialOrder: {
        id: 'order-a',
        orderNumber: 'ORDER-A',
        counterpartyId: 'counterparty-a',
        warehouseCoverageWorkflowVersion: 1,
        counterparty: {
          id: 'counterparty-a',
          displayName: 'Клиент А',
          legalName: 'ООО Скрытое имя',
          inn: '0000000000',
          billingSource: 'manual_platform',
          syncStatus: 'ready',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          externalId: null,
          sourceVersion: null,
        },
      },
    },
  },
};

function setup(
  overrides: { current?: Record<string, unknown>; claim?: Record<string, unknown> } = {},
) {
  const current = { ...line, ...overrides.current };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ lock: '' }]),
    operatorRollLine: {
      update: jest.fn().mockResolvedValue(current),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(current),
      create: jest.fn().mockResolvedValue({
        id: 'replacement-line-a',
        rollDispatchItemId: 'replacement-dispatch-a',
      }),
    },
    rollDispatchItem: {
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'dispatch-a',
          rollCode: 'ROLL-A',
          status: 'ready_for_warehouse',
          replacesDispatchItemId: null,
        },
      ]),
      aggregate: jest.fn().mockResolvedValue({ _max: { queueRank: 7 } }),
      create: jest.fn().mockResolvedValue({
        id: 'replacement-dispatch-a',
        rollCode: 'ROLL-A-R1',
      }),
    },
    weightCapture: {
      create: jest.fn().mockResolvedValue({ id: 'capture-a' }),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn().mockResolvedValue([primaryRollCapture]),
      findFirst: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.kind === 'spool'
            ? {
                id: 'spool-capture-a',
                operatorRollLineId: 'line-a',
                kind: 'spool',
                deviceId: 'scale-a',
                deviceStatus: 'ready',
                stable: true,
                grossKg: 1,
                postId: 'post-a',
                postSessionId: 'session-a',
              }
            : null,
        ),
      ),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    labelPrintJob: {
      create: jest.fn().mockResolvedValue({ id: 'label-job-a' }),
      update: jest.fn(),
      findFirst: jest.fn(),
    },
    defectRecord: { count: jest.fn().mockResolvedValue(0), create: jest.fn() },
    productionProblem: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'problem-a' }),
    },
    warehouseAcceptanceTask: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(where.id ? { id: 'warehouse-task-a' } : null),
        ),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'warehouse-task-a' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    scanRow: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'scan-row-a' }),
    },
    warehouseRoll: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'warehouse-roll-a', rollCode: 'ROLL-A' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorRollOperation: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue({ id: 'operation-a' }),
      update: jest.fn(),
    },
    domainEvent: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (callback: (client: any) => unknown) => callback(tx)),
  } as any;
  const ownership = { lockOwned: jest.fn().mockResolvedValue({ session, line: current }) } as any;
  const binding = {
    resolve: jest.fn().mockImplementation((_postId: string, kind: string) =>
      Promise.resolve({
        id: `${kind}-a`,
        postId: 'post-a',
        status: 'ready',
        isEnabled: true,
        kind,
      }),
    ),
  } as any;
  const operations = {
    claim: jest.fn().mockResolvedValue({
      kind: 'claimed',
      operation: {
        id: 'operation-a',
        leaseToken: LEASE_TOKEN,
      },
      recoveryFromId: null,
      ...overrides.claim,
    }),
    complete: jest.fn(),
    fail: jest.fn(),
    bindDevice: jest.fn(),
    assertCurrentLease: jest.fn(),
    settleExpired: jest.fn().mockResolvedValue(true),
  } as any;
  const audit = { record: jest.fn() } as any;
  const token = `prt_${'a'.repeat(64)}`;
  const tokens = {
    getOrCreate: jest.fn().mockResolvedValue({ rollCode: 'ROLL-A', token }),
    findExact: jest
      .fn()
      .mockImplementation((payload: string) =>
        Promise.resolve(payload === token ? { rollCode: 'ROLL-A' } : null),
      ),
  } as any;
  const scale = {
    read: jest.fn().mockResolvedValue({ status: 'ready', stable: true, grossKg: 2 }),
  } as any;
  const printer = {
    print: jest
      .fn()
      .mockResolvedValue({ jobId: 'printer-job-a', printerId: 'printer-a', status: 'printed' }),
  } as any;
  const incidents = {
    signal: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(undefined),
  } as any;
  const coverageFacts = {
    appendProductionHandoverFact: jest.fn().mockResolvedValue(null),
  } as any;
  const spoolStock = {
    returnDefectSpool: jest.fn().mockResolvedValue({ id: 'spool-return-a' }),
  } as any;
  const service = new OperatorPhysicalService(
    prisma,
    audit,
    ownership,
    binding,
    operations,
    tokens,
    coverageFacts,
    spoolStock,
    scale,
    printer,
    incidents,
  );
  return {
    service,
    prisma,
    tx,
    ownership,
    binding,
    operations,
    audit,
    tokens,
    coverageFacts,
    spoolStock,
    scale,
    printer,
    incidents,
  };
}

describe('OperatorPhysicalService', () => {
  it('retries a raw PostgreSQL serialization failure instead of leaking a 500', async () => {
    const serialized = setup();
    serialized.prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('could not serialize access', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '40001' },
      }),
    );

    await expect(
      serialized.service.accept(actor, 'ROLL-A', { operationKey: 'serialized-accept' }),
    ).resolves.toMatchObject({ rollCode: 'ROLL-A', step: 'assigned' });
    expect(serialized.prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('accepts only the requested owned line and commits audit with the journal', async () => {
    const { service, tx, operations, audit } = setup();
    const result = await service.accept(actor, 'ROLL-A', { operationKey: 'key-a' });

    expect(tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { step: 'spool_weight' },
    });
    expect(tx.operatorRollLine.updateMany).not.toHaveBeenCalled();
    expect(operations.complete).toHaveBeenCalledWith(
      tx,
      'operation-a',
      expect.objectContaining({ resultStep: 'spool_weight' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_roll_accepted' }),
      tx,
    );
    expect(result).toEqual(
      expect.objectContaining({ orderNumber: 'ORDER-A', customerAlias: 'Клиент А' }),
    );
    expect(JSON.stringify(result)).not.toContain('ООО Скрытое имя');
  });

  it('captures spool weight from the server-bound scale and advances only after success', async () => {
    const { service, tx, binding, scale, operations, incidents, prisma } = setup({
      current: { step: 'spool_weight' },
    });
    await service.captureSpoolWeight(actor, 'ROLL-A', { operationKey: 'key-a' });

    expect(binding.resolve).toHaveBeenCalledWith('post-a', 'scale', tx);
    expect(scale.read).toHaveBeenCalledWith(
      { deviceId: 'scale-a', expectedPostId: 'post-a', expectedKind: 'scale' },
      'spool',
    );
    expect(tx.weightCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationId: 'operation-a',
        actorId: actor.userId,
        postSessionId: 'session-a',
        deviceId: 'scale-a',
      }),
    });
    expect(operations.complete).toHaveBeenCalledWith(
      tx,
      'operation-a',
      expect.objectContaining({ resultStep: 'roll_weight', resultRef: 'capture-a' }),
      LEASE_TOKEN,
    );
    expect(incidents.resolve).toHaveBeenCalledWith('post:post-a:binding:scale', expect.any(String));
    expect(incidents.resolve).toHaveBeenCalledWith('device:scale-a:connection', expect.any(String));
    const deviceRecoveryCall = incidents.resolve.mock.calls.findIndex(
      ([fingerprint]: [string]) => fingerprint === 'device:scale-a:connection',
    );
    expect(prisma.$transaction.mock.invocationCallOrder.at(-1)).toBeLessThan(
      incidents.resolve.mock.invocationCallOrder[deviceRecoveryCall],
    );
  });

  it('records the thin-spool 0.7 kg standard without reading a physical scale', async () => {
    const standard = setup({
      current: {
        step: 'spool_weight',
        rollDispatchItem: {
          ...line.rollDispatchItem,
          characteristicsSnapshot: {
            ...line.rollDispatchItem.characteristicsSnapshot,
            spoolType: 'Тонкая',
          },
        },
      },
    });

    await standard.service.captureSpoolWeight(actor, 'ROLL-A', {
      operationKey: '0d0b550c-d5c2-44ea-925b-92f66b74fa25',
    });

    expect(standard.binding.resolve).not.toHaveBeenCalled();
    expect(standard.scale.read).not.toHaveBeenCalled();
    expect(standard.tx.weightCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'spool',
        deviceId: null,
        deviceStatus: 'standard',
        stable: true,
        grossKg: 0.7,
        spoolKg: 0.7,
        netKg: null,
      }),
    });
    expect(standard.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { spoolKg: 0.7, step: 'roll_weight' },
    });
    expect(standard.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_weight_captured',
        detail: expect.objectContaining({
          kind: 'spool',
          weightSource: 'standard_700g',
        }),
      }),
      standard.tx,
    );
  });

  it('appends a new spool capture after reopening without rewriting prior evidence', async () => {
    const reopened = setup({
      current: {
        step: 'spool_weight',
        spoolKg: null,
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      },
    });
    reopened.scale.read.mockResolvedValue({
      status: 'ready',
      stable: true,
      grossKg: 1.35,
    });

    await reopened.service.captureSpoolWeight(actor, 'ROLL-A', {
      operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
    });

    expect(reopened.tx.weightCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'spool',
        grossKg: 1.35,
        spoolKg: 1.35,
      }),
    });
    expect(reopened.tx.weightCapture.update).not.toHaveBeenCalled();
    expect(reopened.tx.weightCapture.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['below', 3.1],
    ['equal after normalization', 3.6504],
  ])('rejects a roll gross %s the 3.65 kg spool before persistence', async (_case, grossKg) => {
    const rejected = setup({
      current: {
        step: 'roll_weight',
        spoolKg: 3.65,
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      },
    });
    rejected.scale.read.mockResolvedValue({ status: 'ready', stable: true, grossKg });

    await expect(
      rejected.service.captureRollWeight(actor, 'ROLL-A', {
        operationKey: `invalid-roll-weight-${_case}`,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'OPERATOR_ROLL_WEIGHT_NOT_ABOVE_SPOOL',
        message:
          'Вес рулона должен быть больше веса шпули. Проверьте весы и повторите взвешивание с новым ключом операции.',
      },
    });

    expect(rejected.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(rejected.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(rejected.operations.complete).not.toHaveBeenCalled();
    expect(rejected.operations.fail).toHaveBeenCalledWith(
      rejected.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_ROLL_WEIGHT_NOT_ABOVE_SPOOL',
      },
      LEASE_TOKEN,
    );
    expect(rejected.audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: expect.stringMatching(/operator_(?:weight_captured|roll_reweighed)/u),
      }),
      rejected.tx,
    );
  });

  it('accepts a roll gross one normalized gram above a thick spool', async () => {
    const accepted = setup({
      current: {
        step: 'roll_weight',
        spoolKg: 3.65,
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      },
    });
    accepted.scale.read.mockResolvedValue({ status: 'ready', stable: true, grossKg: 3.651 });

    await accepted.service.captureRollWeight(actor, 'ROLL-A', {
      operationKey: 'valid-roll-weight-above-spool',
    });

    expect(accepted.tx.weightCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ grossKg: 3.651, spoolKg: 3.65, netKg: 0.001 }),
    });
    expect(accepted.operations.complete).toHaveBeenCalledWith(
      accepted.tx,
      'operation-a',
      expect.objectContaining({ resultStep: 'qr_print' }),
      LEASE_TOKEN,
    );
  });

  it('supersedes the canonical roll capture after the operator reopened roll weight', async () => {
    const corrected = setup({
      current: {
        step: 'roll_weight',
        labelState: 'not_printed',
        spoolKg: 1,
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      },
    });
    corrected.scale.read.mockResolvedValue({
      status: 'ready',
      stable: true,
      grossKg: 11.3,
    });

    await corrected.service.captureRollWeight(actor, 'ROLL-A', {
      operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
    });

    expect(corrected.tx.weightCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'roll',
        grossKg: 11.3,
        spoolKg: 1,
        netKg: 10.3,
        supersedesCaptureId: 'capture-primary',
      }),
    });
    expect(corrected.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_roll_reweighed',
        reason: 'operator_reopened_previous_step',
        oldValue: { grossKg: 11, netKg: 10, toleranceOk: true },
        newValue: { grossKg: 11.3, netKg: 10.3, toleranceOk: true },
        detail: expect.objectContaining({
          previousEvidenceId: 'capture-primary',
          evidenceId: 'capture-a',
        }),
      }),
      corrected.tx,
    );
  });

  it.each([
    ['below the spool weight', 3.1],
    ['equal to the spool weight after kilogram precision rounding', 3.6504],
    ['non-finite', Number.NaN],
  ])('rejects a primary roll weight %s', async (_case, grossKg) => {
    const invalid = setup({
      current: {
        step: 'roll_weight',
        labelState: 'not_printed',
        spoolKg: 3.65,
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      },
    });
    invalid.scale.read.mockResolvedValue({ status: 'ready', stable: true, grossKg });

    await expect(
      invalid.service.captureRollWeight(actor, 'ROLL-A', {
        operationKey: '87f85af4-d947-4aa2-9123-46628b610d6f',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ROLL_WEIGHT_NOT_ABOVE_SPOOL' }),
    });

    expect(invalid.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(invalid.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(invalid.operations.fail).toHaveBeenCalledWith(
      invalid.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_ROLL_WEIGHT_NOT_ABOVE_SPOOL',
      },
      LEASE_TOKEN,
    );
    expect(invalid.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_weight_capture_failed',
        detail: expect.objectContaining({
          kind: 'roll',
          reasonCode: 'OPERATOR_ROLL_WEIGHT_NOT_ABOVE_SPOOL',
        }),
      }),
      invalid.tx,
    );
  });

  it('rejects reopened roll weight when correction evidence has multiple roots', async () => {
    const ambiguous = setup({
      current: {
        step: 'roll_weight',
        labelState: 'not_printed',
        spoolKg: 1,
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      },
    });
    ambiguous.tx.weightCapture.findMany.mockResolvedValue([
      primaryRollCapture,
      {
        ...primaryRollCapture,
        id: 'capture-second-root',
        createdAt: new Date('2026-07-22T08:01:00.000Z'),
      },
    ]);

    await expect(
      ambiguous.service.captureRollWeight(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_CORRECTION_EVIDENCE_AMBIGUOUS',
      }),
    });
    expect(ambiguous.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(ambiguous.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('reweighs the current unprinted roll from its bound scale and returns only safe weights', async () => {
    const reweigh = setup({
      current: {
        step: 'qr_print',
        labelState: 'not_printed',
        spoolKg: 1,
        grossKg: 11,
        netKg: 10,
        toleranceOk: true,
      },
    });
    reweigh.scale.read.mockResolvedValue({ status: 'ready', stable: true, grossKg: 11.2 });

    const result = await reweigh.service.reweighRoll(actor, 'ROLL-A', {
      operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
    });

    expect(reweigh.binding.resolve).toHaveBeenCalledWith('post-a', 'scale', reweigh.tx);
    expect(reweigh.scale.read).toHaveBeenCalledWith(
      { deviceId: 'scale-a', expectedPostId: 'post-a', expectedKind: 'scale' },
      'roll',
    );
    expect(reweigh.tx.weightCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operatorRollLineId: 'line-a',
        operationId: 'operation-a',
        kind: 'roll',
        supersedesCaptureId: 'capture-primary',
        grossKg: 11.2,
        spoolKg: 1,
        netKg: 10.2,
        toleranceOk: true,
        actorId: actor.userId,
        postId: 'post-a',
        postSessionId: 'session-a',
        deviceId: 'scale-a',
      }),
    });
    expect(reweigh.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { grossKg: 11.2, netKg: 10.2, toleranceOk: true },
    });
    expect(reweigh.operations.complete).toHaveBeenCalledWith(
      reweigh.tx,
      'operation-a',
      {
        resultStep: 'qr_print',
        resultRef: 'capture-a',
        httpStatus: 200,
      },
      LEASE_TOKEN,
    );
    expect(reweigh.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_roll_reweighed',
        reason: 'operator_requested_before_qr_print',
        oldValue: { grossKg: 11, netKg: 10, toleranceOk: true },
        newValue: { grossKg: 11.2, netKg: 10.2, toleranceOk: true },
        detail: expect.objectContaining({
          previousEvidenceId: 'capture-primary',
          evidenceId: 'capture-a',
          deviceId: 'scale-a',
          postId: 'post-a',
          sessionId: 'session-a',
        }),
      }),
      reweigh.tx,
    );
    expect(result).toEqual({
      rollCode: 'ROLL-A',
      step: 'qr_print',
      previousWeight: { grossKg: 11, netKg: 10, toleranceOk: true },
      currentWeight: { grossKg: 11.2, netKg: 10.2, toleranceOk: true },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /captureId|deviceId|sessionId|postSessionId|rawPayload|qrCode/iu,
    );
  });

  it('rejects an impossible reweigh before superseding the canonical capture', async () => {
    const rejected = setup({
      current: {
        step: 'qr_print',
        labelState: 'not_printed',
        spoolKg: 3.65,
        grossKg: 11,
        netKg: 7.35,
        toleranceOk: true,
      },
    });
    rejected.scale.read.mockResolvedValue({ status: 'ready', stable: true, grossKg: 3.65 });

    await expect(
      rejected.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: 'invalid-roll-reweigh-equal-spool',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ROLL_WEIGHT_NOT_ABOVE_SPOOL' }),
    });

    expect(rejected.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(rejected.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(rejected.operations.complete).not.toHaveBeenCalled();
    expect(rejected.operations.fail).toHaveBeenCalledWith(
      rejected.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_ROLL_WEIGHT_NOT_ABOVE_SPOOL',
      },
      LEASE_TOKEN,
    );
  });

  it('appends a valid successor for the invalid canonical handover weight', async () => {
    const recovery = setup({
      current: {
        step: 'handover',
        labelState: 'verified',
        warehouseState: 'not_ready',
        spoolKg: 3.65,
        grossKg: 3.1,
        netKg: -0.55,
        toleranceOk: false,
      },
    });
    recovery.tx.weightCapture.findMany.mockResolvedValue([invalidHandoverCapture]);
    recovery.scale.read.mockResolvedValue({ status: 'ready', stable: true, grossKg: 6.65 });

    await expect(
      recovery.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: 'recover-a16-invalid-weight',
      }),
    ).resolves.toEqual({
      rollCode: 'ROLL-A',
      step: 'handover',
      previousWeight: { grossKg: 3.1, netKg: -0.55, toleranceOk: false },
      currentWeight: { grossKg: 6.65, netKg: 3, toleranceOk: false },
    });

    expect(recovery.binding.resolve).toHaveBeenCalledWith('post-a', 'scale', recovery.tx);
    expect(recovery.scale.read).toHaveBeenCalledWith(
      { deviceId: 'scale-a', expectedPostId: 'post-a', expectedKind: 'scale' },
      'roll',
    );
    expect(recovery.tx.weightCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operatorRollLineId: 'line-a',
        kind: 'roll',
        grossKg: 6.65,
        spoolKg: 3.65,
        netKg: 3,
        supersedesCaptureId: 'capture-a16-invalid',
        actorId: 'operator-a',
        postId: 'post-a',
        postSessionId: 'session-a',
      }),
    });
    expect(recovery.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { grossKg: 6.65, netKg: 3, toleranceOk: false },
    });
    expect(recovery.operations.complete).toHaveBeenCalledWith(
      recovery.tx,
      'operation-a',
      { resultStep: 'handover', resultRef: 'capture-a', httpStatus: 200 },
      LEASE_TOKEN,
    );
    expect(recovery.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_roll_reweighed',
        reason: 'operator_recovered_invalid_weight_before_handover',
        oldValue: { grossKg: 3.1, netKg: -0.55, toleranceOk: false },
        newValue: { grossKg: 6.65, netKg: 3, toleranceOk: false },
        detail: expect.objectContaining({
          previousEvidenceId: 'capture-a16-invalid',
          evidenceId: 'capture-a',
        }),
      }),
      recovery.tx,
    );
    expect(recovery.tx.labelPrintJob.findFirst).not.toHaveBeenCalled();
    expect(recovery.printer.print).not.toHaveBeenCalled();
    expect(recovery.tokens.getOrCreate).not.toHaveBeenCalled();
    expect(recovery.tx.weightCapture.update).not.toHaveBeenCalled();
    expect(recovery.tx.weightCapture.delete).not.toHaveBeenCalled();
  });

  it('rejects handover recovery when the canonical weight is already positive', async () => {
    const valid = setup({
      current: {
        step: 'handover',
        labelState: 'verified',
        warehouseState: 'not_ready',
        spoolKg: 1,
        grossKg: 11,
        netKg: 10,
        toleranceOk: true,
      },
    });

    await expect(
      valid.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: 'reject-valid-handover-weight',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_REWEIGH_HANDOVER_WEIGHT_VALID' }),
    });

    expect(valid.binding.resolve).not.toHaveBeenCalled();
    expect(valid.scale.read).not.toHaveBeenCalled();
    expect(valid.tx.weightCapture.create).not.toHaveBeenCalled();
  });

  it('rejects handover recovery after the roll entered warehouse state', async () => {
    const sent = setup({
      current: {
        step: 'handover',
        labelState: 'verified',
        warehouseState: 'sent',
        spoolKg: 3.65,
        grossKg: 3.1,
        netKg: -0.55,
        toleranceOk: false,
      },
    });
    sent.tx.weightCapture.findMany.mockResolvedValue([invalidHandoverCapture]);

    await expect(
      sent.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: 'reject-sent-handover-weight',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DISPATCH_TERMINAL' }),
    });

    expect(sent.binding.resolve).not.toHaveBeenCalled();
    expect(sent.scale.read).not.toHaveBeenCalled();
    expect(sent.tx.weightCapture.create).not.toHaveBeenCalled();
  });

  it('replays a recovered handover weight without another capture or scale read', async () => {
    const replay = setup({
      current: {
        step: 'handover',
        labelState: 'verified',
        warehouseState: 'not_ready',
        spoolKg: 3.65,
        grossKg: 6.65,
        netKg: 3,
        toleranceOk: false,
      },
      claim: {
        kind: 'replay',
        operation: {
          id: 'operation-a',
          resultRef: 'capture-a16-recovered',
          resultStep: 'handover',
        },
      },
    });
    replay.tx.weightCapture.findUnique.mockResolvedValue({
      ...invalidHandoverCapture,
      id: 'capture-a16-recovered',
      grossKg: 6.65,
      netKg: 3,
      supersedesCaptureId: 'capture-a16-invalid',
      supersedesCapture: invalidHandoverCapture,
    });

    await expect(
      replay.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: 'replay-a16-recovered-weight',
      }),
    ).resolves.toEqual({
      rollCode: 'ROLL-A',
      step: 'handover',
      previousWeight: { grossKg: 3.1, netKg: -0.55, toleranceOk: false },
      currentWeight: { grossKg: 6.65, netKg: 3, toleranceOk: false },
    });
    expect(replay.scale.read).not.toHaveBeenCalled();
    expect(replay.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(replay.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(replay.audit.record).not.toHaveBeenCalled();
  });

  it('replays a completed reweigh from the capture link without reading the scale again', async () => {
    const replay = setup({
      current: {
        step: 'qr_print',
        labelState: 'not_printed',
        spoolKg: 1,
        grossKg: 11.2,
        netKg: 10.2,
        toleranceOk: true,
      },
      claim: {
        kind: 'replay',
        operation: {
          id: 'operation-a',
          resultRef: 'capture-reweigh',
          resultStep: 'qr_print',
        },
      },
    });
    replay.tx.weightCapture.findUnique.mockResolvedValue({
      ...primaryRollCapture,
      id: 'capture-reweigh',
      grossKg: 11.2,
      netKg: 10.2,
      supersedesCaptureId: 'capture-primary',
      supersedesCapture: primaryRollCapture,
    });

    await expect(
      replay.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).resolves.toEqual({
      rollCode: 'ROLL-A',
      step: 'qr_print',
      previousWeight: { grossKg: 11, netKg: 10, toleranceOk: true },
      currentWeight: { grossKg: 11.2, netKg: 10.2, toleranceOk: true },
    });
    expect(replay.scale.read).not.toHaveBeenCalled();
    expect(replay.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(replay.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(replay.audit.record).not.toHaveBeenCalled();
  });

  it('rejects reweigh outside qr_print before resolving or reading a scale', async () => {
    const wrongStage = setup({
      current: {
        step: 'roll_weight',
        labelState: 'not_printed',
        spoolKg: 1,
        grossKg: 11,
        netKg: 10,
      },
    });

    await expect(
      wrongStage.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_STEP_CONFLICT' }),
    });
    expect(wrongStage.binding.resolve).not.toHaveBeenCalled();
    expect(wrongStage.scale.read).not.toHaveBeenCalled();
    expect(wrongStage.tx.weightCapture.create).not.toHaveBeenCalled();
  });

  it('requires a canonical primary roll capture before reweighing', async () => {
    const missingWeight = setup({
      current: { step: 'qr_print', labelState: 'not_printed', spoolKg: 1 },
    });
    missingWeight.tx.weightCapture.findMany.mockResolvedValue([]);

    await expect(
      missingWeight.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_REWEIGH_WEIGHT_REQUIRED' }),
    });
    expect(missingWeight.binding.resolve).not.toHaveBeenCalled();
    expect(missingWeight.scale.read).not.toHaveBeenCalled();
    expect(missingWeight.tx.weightCapture.create).not.toHaveBeenCalled();
  });

  it.each([
    ['submitted label state', { labelState: 'submitted' }, null],
    ['existing print job', { labelState: 'not_printed' }, { id: 'label-job-a' }],
  ] as const)('rejects reweigh when printing already started by %s', async (_case, state, job) => {
    const printed = setup({
      current: { step: 'qr_print', spoolKg: 1, grossKg: 11, netKg: 10, ...state },
    });
    printed.tx.labelPrintJob.findFirst.mockResolvedValue(job);

    await expect(
      printed.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_REWEIGH_PRINT_ALREADY_STARTED' }),
    });
    expect(printed.binding.resolve).not.toHaveBeenCalled();
    expect(printed.scale.read).not.toHaveBeenCalled();
    expect(printed.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(printed.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      'foreign roll',
      new NotFoundException({ code: 'OPERATOR_ROLL_NOT_FOUND', message: 'not owned' }),
    ],
    [
      'inactive post session',
      new ConflictException({ code: 'OPERATOR_ACTIVE_SESSION_REQUIRED', message: 'inactive' }),
    ],
  ])('rejects %s before any physical read', async (_case, ownershipError) => {
    const forbidden = setup({
      current: { step: 'qr_print', labelState: 'not_printed', spoolKg: 1 },
    });
    forbidden.ownership.lockOwned.mockRejectedValue(ownershipError);

    await expect(
      forbidden.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toBe(ownershipError);
    expect(forbidden.binding.resolve).not.toHaveBeenCalled();
    expect(forbidden.scale.read).not.toHaveBeenCalled();
    expect(forbidden.tx.weightCapture.create).not.toHaveBeenCalled();
  });

  it('journals a safe binding failure without reading or changing roll weight', async () => {
    const offline = setup({
      current: { step: 'qr_print', labelState: 'not_printed', spoolKg: 1, netKg: 10 },
    });
    offline.binding.resolve.mockRejectedValue(
      new ServiceUnavailableException({
        code: 'OPERATOR_DEVICE_NOT_READY',
        message: 'safe binding failure',
        deviceId: 'scale-a',
      }),
    );

    await expect(
      offline.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(offline.operations.fail).toHaveBeenCalledWith(
      offline.tx,
      'operation-a',
      {
        httpStatus: 503,
        errorCode: 'OPERATOR_DEVICE_NOT_READY',
      },
      LEASE_TOKEN,
    );
    expect(offline.scale.read).not.toHaveBeenCalled();
    expect(offline.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(offline.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(offline.incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'device:scale-a:connection',
        targetId: 'scale-a',
      }),
    );
    expect(offline.incidents.resolve).toHaveBeenCalledWith(
      'post:post-a:binding:scale',
      expect.any(String),
    );
    expect(offline.operations.fail.mock.invocationCallOrder[0]).toBeLessThan(
      offline.incidents.signal.mock.invocationCallOrder[0],
    );
  });

  it('fails and audits an unstable scale read without changing the confirmed weight', async () => {
    const unstable = setup({
      current: { step: 'qr_print', labelState: 'not_printed', spoolKg: 1, netKg: 10 },
    });
    unstable.scale.read.mockResolvedValue({ status: 'ready', stable: false, grossKg: 11.2 });

    await expect(
      unstable.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(unstable.operations.fail).toHaveBeenCalledWith(
      unstable.tx,
      'operation-a',
      {
        httpStatus: 503,
        errorCode: 'OPERATOR_SCALE_UNAVAILABLE',
      },
      LEASE_TOKEN,
    );
    expect(unstable.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'device.scale.offline',
        detail: expect.objectContaining({ status: 'unavailable' }),
      }),
      unstable.tx,
    );
    expect(unstable.incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'device:scale-a:connection',
        targetId: 'scale-a',
      }),
    );
    expect(JSON.stringify(unstable.incidents.signal.mock.calls)).not.toMatch(
      /raw|adapter|stack|credential|bitmap|qr/i,
    );
    expect(unstable.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(unstable.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(unstable.audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_roll_reweighed' }),
      unstable.tx,
    );
  });

  it('terminalizes the reweigh journal when the scale adapter rejects', async () => {
    const rejected = setup({
      current: { step: 'qr_print', labelState: 'not_printed', spoolKg: 1, netKg: 10 },
    });
    rejected.scale.read.mockRejectedValue(new Error('raw transport failure'));

    await expect(
      rejected.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(rejected.operations.fail).toHaveBeenCalledWith(
      rejected.tx,
      'operation-a',
      {
        httpStatus: 503,
        errorCode: 'OPERATOR_SCALE_UNAVAILABLE',
      },
      LEASE_TOKEN,
    );
    expect(rejected.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(rejected.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(JSON.stringify(rejected.audit.record.mock.calls)).not.toContain('raw transport failure');
  });

  it('rejects an offline status even if a faulty adapter marks the reading stable', async () => {
    const offline = setup({
      current: { step: 'qr_print', labelState: 'not_printed', spoolKg: 1, netKg: 10 },
    });
    offline.scale.read.mockResolvedValue({ status: 'offline', stable: true, grossKg: 11.2 });

    await expect(
      offline.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(offline.operations.fail).toHaveBeenCalledWith(
      offline.tx,
      'operation-a',
      {
        httpStatus: 503,
        errorCode: 'OPERATOR_SCALE_UNAVAILABLE',
      },
      LEASE_TOKEN,
    );
    expect(offline.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(offline.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('fails closed when a print job appears between reweigh claim and finalization', async () => {
    const raced = setup({
      current: {
        step: 'qr_print',
        labelState: 'not_printed',
        spoolKg: 1,
        grossKg: 11,
        netKg: 10,
      },
    });
    raced.tx.labelPrintJob.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'label-job-race' });
    raced.scale.read.mockResolvedValue({ status: 'ready', stable: true, grossKg: 11.2 });

    await expect(
      raced.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_REWEIGH_PRINT_ALREADY_STARTED' }),
    });
    expect(raced.scale.read).toHaveBeenCalledTimes(1);
    expect(raced.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(raced.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(raced.operations.fail).toHaveBeenCalledWith(
      raced.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_REWEIGH_PRINT_ALREADY_STARTED',
      },
      LEASE_TOKEN,
    );
    expect(raced.audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_roll_reweighed' }),
      raced.tx,
    );
  });

  it('fails closed when the post scale binding changes before finalization', async () => {
    const rebound = setup({
      current: {
        step: 'qr_print',
        labelState: 'not_printed',
        spoolKg: 1,
        grossKg: 11,
        netKg: 10,
      },
    });
    rebound.binding.resolve
      .mockResolvedValueOnce({
        id: 'scale-a',
        postId: 'post-a',
        status: 'ready',
        isEnabled: true,
        kind: 'scale',
      })
      .mockResolvedValueOnce({
        id: 'scale-b',
        postId: 'post-a',
        status: 'ready',
        isEnabled: true,
        kind: 'scale',
      });

    await expect(
      rebound.service.reweighRoll(actor, 'ROLL-A', {
        operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DEVICE_BINDING_CHANGED' }),
    });
    expect(rebound.binding.resolve).toHaveBeenCalledTimes(2);
    expect(rebound.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(rebound.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(rebound.operations.fail).toHaveBeenCalledWith(
      rebound.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_DEVICE_BINDING_CHANGED',
      },
      LEASE_TOKEN,
    );
  });

  it('does not finalize a weight after the dispatch becomes terminal during the device read', async () => {
    const raced = setup({ current: { step: 'spool_weight' } });
    const mutableLine = {
      ...line,
      step: 'spool_weight',
      rollDispatchItem: { ...line.rollDispatchItem, status: 'assigned' },
    };
    const terminalLine = {
      ...mutableLine,
      rollDispatchItem: { ...line.rollDispatchItem, status: 'done' },
    };
    raced.ownership.lockOwned
      .mockResolvedValueOnce({ session, line: mutableLine })
      .mockResolvedValueOnce({ session, line: terminalLine });

    await expect(
      raced.service.captureSpoolWeight(actor, 'ROLL-A', { operationKey: 'weight-terminal-race' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DISPATCH_TERMINAL' }),
    });
    expect(raced.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(raced.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(raced.operations.fail).toHaveBeenCalledWith(
      raced.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_DISPATCH_TERMINAL',
      },
      LEASE_TOKEN,
    );
    expect(raced.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_weight_capture_failed',
        detail: expect.objectContaining({ reasonCode: 'OPERATOR_DISPATCH_TERMINAL' }),
      }),
      raced.tx,
    );
  });

  it('fails the claimed weight operation when another key advances the step first', async () => {
    const raced = setup({ current: { step: 'spool_weight' } });
    const mutableLine = {
      ...line,
      step: 'spool_weight',
      rollDispatchItem: { ...line.rollDispatchItem, status: 'assigned' },
    };
    const advancedLine = { ...mutableLine, step: 'roll_weight' };
    raced.ownership.lockOwned
      .mockResolvedValueOnce({ session, line: mutableLine })
      .mockResolvedValueOnce({ session, line: advancedLine });

    await expect(
      raced.service.captureSpoolWeight(actor, 'ROLL-A', { operationKey: 'weight-step-race' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_STEP_CONFLICT' }),
    });
    expect(raced.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(raced.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(raced.operations.fail).toHaveBeenCalledWith(
      raced.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_STEP_CONFLICT',
      },
      LEASE_TOKEN,
    );
    expect(raced.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_weight_capture_failed',
        detail: expect.objectContaining({ reasonCode: 'OPERATOR_STEP_CONFLICT' }),
      }),
      raced.tx,
    );
  });

  it('terminalizes and audits a claimed weight when the post session closes during scale I/O', async () => {
    const raced = setup({ current: { step: 'spool_weight' } });
    raced.ownership.lockOwned
      .mockResolvedValueOnce({ session, line: { ...line, step: 'spool_weight' } })
      .mockRejectedValueOnce(
        new ConflictException({
          code: 'OPERATOR_ACTIVE_SESSION_REQUIRED',
          message: 'Откройте активную сессию производственного поста.',
        }),
      );

    await expect(
      raced.service.captureSpoolWeight(actor, 'ROLL-A', { operationKey: 'session-close-race' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ACTIVE_SESSION_REQUIRED' }),
    });

    expect(raced.scale.read).toHaveBeenCalledTimes(1);
    expect(raced.operations.fail).toHaveBeenCalledWith(
      raced.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_ACTIVE_SESSION_REQUIRED',
      },
      LEASE_TOKEN,
    );
    expect(raced.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_weight_capture_failed',
        detail: expect.objectContaining({
          operationId: 'operation-a',
          reasonCode: 'OPERATOR_ACTIVE_SESSION_REQUIRED',
        }),
      }),
      raced.tx,
    );
    expect(raced.prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('terminalizes and audits a claimed weight when its assignment moves during scale I/O', async () => {
    const raced = setup({ current: { step: 'spool_weight' } });
    raced.ownership.lockOwned
      .mockResolvedValueOnce({ session, line: { ...line, step: 'spool_weight' } })
      .mockRejectedValueOnce(
        new NotFoundException({
          code: 'OPERATOR_ROLL_NOT_FOUND',
          message: 'Рулон не найден в очереди этого оператора и поста.',
        }),
      );

    await expect(
      raced.service.captureSpoolWeight(actor, 'ROLL-A', { operationKey: 'assignment-race' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ROLL_NOT_FOUND' }),
    });

    expect(raced.scale.read).toHaveBeenCalledTimes(1);
    expect(raced.operations.fail).toHaveBeenCalledWith(
      raced.tx,
      'operation-a',
      {
        httpStatus: 404,
        errorCode: 'OPERATOR_ROLL_NOT_FOUND',
      },
      LEASE_TOKEN,
    );
    expect(raced.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_weight_capture_failed',
        detail: expect.objectContaining({
          operationId: 'operation-a',
          reasonCode: 'OPERATOR_ROLL_NOT_FOUND',
        }),
      }),
      raced.tx,
    );
    expect(raced.prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('records a safe failed operation and does not advance on non-exact QR bytes', async () => {
    const { service, tx, operations, audit, binding } = setup({
      current: { step: 'qr_check', labelState: 'printed' },
    });
    await expect(
      service.verifyQr(actor, 'ROLL-A', {
        operationKey: 'key-a',
        payload: `prt_${'a'.repeat(64)}\n`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(binding.resolve).toHaveBeenCalledWith('post-a', 'scanner', tx);
    expect(operations.bindDevice).toHaveBeenCalledWith(tx, 'operation-a', 'scanner-a', LEASE_TOKEN);
    expect(operations.fail).toHaveBeenCalledWith(
      tx,
      'operation-a',
      {
        httpStatus: 400,
        errorCode: 'OPERATOR_QR_MISMATCH',
      },
      LEASE_TOKEN,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'device.scan.mismatch',
        detail: expect.objectContaining({ deviceId: 'scanner-a' }),
      }),
      tx,
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('prt_');
  });

  it('fails QR verification before state transition when scanner readiness is unavailable', async () => {
    const failed = setup({
      current: { step: 'qr_check', labelState: 'printed' },
    });
    failed.binding.resolve.mockRejectedValue(
      new ServiceUnavailableException({
        code: 'POST_DEVICE_NOT_READY',
        message: 'scanner is not ready',
      }),
    );

    await expect(
      failed.service.verifyQr(actor, 'ROLL-A', {
        operationKey: 'scanner-offline-key',
        payload: `prt_${'a'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'POST_DEVICE_NOT_READY' }),
    });

    expect(failed.operations.fail).toHaveBeenCalledWith(
      failed.tx,
      'operation-a',
      {
        httpStatus: 503,
        errorCode: 'POST_DEVICE_NOT_READY',
      },
      LEASE_TOKEN,
    );
    expect(failed.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'device.scan.offline',
        detail: expect.objectContaining({
          operationId: 'operation-a',
          postId: 'post-a',
          sessionId: 'session-a',
          reasonCode: 'POST_DEVICE_NOT_READY',
        }),
      }),
      failed.tx,
    );
    expect(failed.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(failed.incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'post:post-a:binding:scanner' }),
    );
    expect(JSON.stringify(failed.audit.record.mock.calls)).not.toContain('prt_');
  });

  it('automatically hands an exactly scanned roll to warehouse without a second action', async () => {
    const { service, tx, ownership, operations, audit, binding } = setup({
      current: { step: 'qr_check', labelState: 'printed' },
    });
    ownership.lockOwned
      .mockResolvedValueOnce({
        session,
        line: { ...line, step: 'qr_check', labelState: 'printed' },
      })
      .mockResolvedValueOnce({
        session,
        line: { ...line, step: 'handover', labelState: 'verified' },
      });

    await service.verifyQrAndHandover(actor, 'ROLL-A', {
      operationKey: 'verify-and-handover-key',
      handoverOperationKey: 'handover-key',
      payload: `prt_${'a'.repeat(64)}`,
    });

    expect(tx.operatorRollLine.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'line-a' },
      data: { labelState: 'verified', step: 'handover' },
    });
    expect(tx.operatorRollLine.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'line-a' },
      data: { warehouseState: 'sent', step: 'warehouse' },
    });
    expect(tx.rollDispatchItem.update).toHaveBeenCalledWith({
      where: { id: 'dispatch-a' },
      data: { status: 'ready_for_warehouse' },
    });
    expect(binding.resolve).toHaveBeenCalledWith('post-a', 'scanner', tx);
    expect(operations.bindDevice).toHaveBeenCalledWith(tx, 'operation-a', 'scanner-a', LEASE_TOKEN);
    expect(operations.complete).toHaveBeenNthCalledWith(
      1,
      tx,
      'operation-a',
      {
        resultStep: 'handover',
        httpStatus: 200,
      },
      LEASE_TOKEN,
    );
    expect(operations.complete).toHaveBeenLastCalledWith(tx, 'operation-a', {
      resultStep: 'warehouse',
      resultRef: 'warehouse-task-a',
      httpStatus: 200,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_qr_verified',
        detail: expect.objectContaining({ deviceId: 'scanner-a' }),
      }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_roll_handed_over' }),
      tx,
    );
  });

  it('rejects reused QR and handover operation keys before changing the roll', async () => {
    const { service, ownership, tx } = setup({
      current: { step: 'qr_check', labelState: 'printed' },
    });

    await expect(
      service.verifyQrAndHandover(actor, 'ROLL-A', {
        operationKey: 'same-key',
        handoverOperationKey: 'same-key',
        payload: `prt_${'a'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPERATION_KEYS_MUST_DIFFER' }),
    });
    expect(ownership.lockOwned).not.toHaveBeenCalled();
    expect(tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('audits recovery when an exact scan follows a failed physical attempt', async () => {
    const { service, audit, tx } = setup({
      current: { step: 'qr_check', labelState: 'printed' },
      claim: { recoveryFromId: 'failed-operation' },
    });
    await service.verifyQr(actor, 'ROLL-A', {
      operationKey: 'retry-key',
      payload: `prt_${'a'.repeat(64)}`,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_physical_operation_recovered',
        detail: expect.objectContaining({
          recoveredOperationId: 'failed-operation',
          deviceId: 'scanner-a',
        }),
      }),
      tx,
    );
  });

  it('does not hand over when scanner readiness fails', async () => {
    const failed = setup({
      current: { step: 'qr_check', labelState: 'printed' },
    });
    failed.binding.resolve.mockRejectedValue(
      new ServiceUnavailableException({
        code: 'POST_AGENT_HEARTBEAT_STALE',
        message: 'scanner heartbeat is stale',
      }),
    );

    await expect(
      failed.service.verifyQrAndHandover(actor, 'ROLL-A', {
        operationKey: 'verify-failed-scanner',
        handoverOperationKey: 'handover-must-not-run',
        payload: `prt_${'a'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'POST_AGENT_HEARTBEAT_STALE' }),
    });

    expect(failed.tx.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(failed.tx.warehouseAcceptanceTask.create).not.toHaveBeenCalled();
  });

  it('replays a completed QR verification without requiring a new scanner heartbeat', async () => {
    const replay = setup({
      current: { step: 'handover', labelState: 'verified' },
      claim: { kind: 'replay' },
    });

    await expect(
      replay.service.verifyQr(actor, 'ROLL-A', {
        operationKey: 'completed-verify',
        payload: `prt_${'a'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({ rollCode: 'ROLL-A' });

    expect(replay.binding.resolve).not.toHaveBeenCalled();
    expect(replay.operations.bindDevice).not.toHaveBeenCalled();
  });

  it('defers and resumes the exact predecessor without enabling a skip', async () => {
    const deferred = setup({ current: { step: 'roll_weight' } });
    await deferred.service.defer(actor, 'ROLL-A', {
      operationKey: 'defer-key',
      reason: 'Ожидание материала',
    });
    expect(deferred.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { step: 'deferred', deferredFromStep: 'roll_weight' },
    });

    const resumed = setup({
      current: {
        step: 'deferred',
        deferredFromStep: 'roll_weight',
        rollDispatchItem: { ...line.rollDispatchItem, status: 'deferred' },
      },
    });
    await resumed.service.resume(actor, 'ROLL-A', { operationKey: 'resume-key' });
    expect(resumed.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { step: 'roll_weight', deferredFromStep: null },
    });
  });

  it('cannot resume a roll after production has terminally resolved its defect', async () => {
    const terminal = setup({
      current: {
        step: 'deferred',
        deferredFromStep: 'roll_weight',
        rollDispatchItem: { ...line.rollDispatchItem, status: 'done' },
      },
    });

    await expect(
      terminal.service.resume(actor, 'ROLL-A', { operationKey: 'resume-after-writeoff' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(terminal.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(terminal.tx.rollDispatchItem.update).not.toHaveBeenCalled();
  });

  it('submits the exact stored QR payload and never returns it in the business projection', async () => {
    const { service, printer, tx, tokens, incidents, audit } = setup({
      current: { step: 'qr_print' },
    });
    const result = await service.printQr(actor, 'ROLL-A', { operationKey: 'print-key' });

    expect(tx.warehouseRoll.upsert).toHaveBeenCalledWith({
      where: { rollCode: 'ROLL-A' },
      update: {},
      create: { rollCode: 'ROLL-A', warehouseStatus: 'not_ready' },
    });
    expect(tx.warehouseRoll.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      tokens.getOrCreate.mock.invocationCallOrder[0],
    );
    expect(printer.print).toHaveBeenCalledWith(
      { deviceId: 'printer-a', expectedPostId: 'post-a', expectedKind: 'printer' },
      expect.objectContaining({
        kind: 'roll_label',
        rollCode: 'ROLL-A',
        qrCode: expect.any(String),
      }),
    );
    const printedPayload = printer.print.mock.calls[0][1].qrCode as string;
    expect(printedPayload).toMatch(/^prt_[0-9a-f]{64}$/u);
    expect(tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { labelState: 'printed', step: 'qr_check' },
    });
    expect(incidents.resolve).toHaveBeenCalledWith(
      'post:post-a:binding:printer',
      expect.any(String),
    );
    expect(incidents.resolve).toHaveBeenCalledWith(
      'device:printer-a:connection',
      expect.any(String),
    );
    expect(incidents.resolve).not.toHaveBeenCalledWith(
      'gateway:post:post-a:command:print_delivery_unknown',
      expect.any(String),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_label_print_submitted',
        detail: expect.objectContaining({
          operationId: 'operation-a',
          jobId: 'label-job-a',
          gatewayCommandId: 'printer-job-a',
          labelKind: 'roll_label',
        }),
      }),
      tx,
    );
    expect(result).not.toHaveProperty('qrCode');
  });

  it('advances a clean physical spool submission to exact HID verification without claiming print', async () => {
    const submitted = setup({ current: { step: 'qr_print' } });
    submitted.printer.print.mockResolvedValue({
      jobId: 'tcp-job-a',
      printerId: 'printer-a',
      status: 'submitted',
      gatewayCommandId: 'gateway-command-submitted',
    });

    const result = await submitted.service.printQr(actor, 'ROLL-A', {
      operationKey: 'physical-submission',
    });

    expect(submitted.tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'label-job-a' },
      data: {
        status: 'submitted',
        gatewayCommandId: 'gateway-command-submitted',
        completedAt: expect.any(Date),
        failureReason: null,
      },
    });
    expect(submitted.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { labelState: 'submitted', step: 'qr_check' },
    });
    expect(result).not.toHaveProperty('qrCode');
  });

  it('requires a reason and actually calls the printer for a reprint', async () => {
    const noReason = setup({
      current: { step: 'qr_check', labelState: 'printed' },
    });
    await expect(
      noReason.service.printQr(actor, 'ROLL-A', { operationKey: 'reprint-key' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(noReason.printer.print).not.toHaveBeenCalled();

    const withReason = setup({
      current: { step: 'qr_check', labelState: 'printed' },
    });
    await withReason.service.printQr(actor, 'ROLL-A', {
      operationKey: 'reprint-key',
      reason: 'Этикетка замялась',
    });
    expect(withReason.printer.print).toHaveBeenCalledTimes(1);
    expect(withReason.printer.print).toHaveBeenCalledWith(
      { deviceId: 'printer-a', expectedPostId: 'post-a', expectedKind: 'printer' },
      {
        kind: 'roll_label',
        rollCode: 'ROLL-A',
        qrCode: `prt_${'a'.repeat(64)}`,
      },
    );
    const reprintPayload = withReason.printer.print.mock.calls[0][1];
    expect(reprintPayload).not.toHaveProperty('bitmapBase64');
    expect(reprintPayload).not.toHaveProperty('documentId');
    expect(withReason.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { labelState: 'printed', step: 'qr_check' },
    });
  });

  it('retries a confirmed first non-print without demanding a reprint reason', async () => {
    const retry = setup({
      current: { step: 'qr_print', labelState: 'reprint_requested' },
    });
    retry.tx.labelPrintJob.findFirst.mockResolvedValue(null);

    await retry.service.printQr(actor, 'ROLL-A', {
      operationKey: 'confirmed-initial-non-print',
    });

    expect(retry.printer.print).toHaveBeenCalledTimes(1);
    expect(retry.tx.labelPrintJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'queued',
        reason: null,
        replacesJobId: null,
      }),
    });
    expect(retry.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_label_print_requested' }),
      retry.tx,
    );
  });

  it('requires a reason in qr_print recovery when an earlier label was submitted', async () => {
    const findPriorPrint = ({ where }: { where: { status?: { in?: string[] } } }) =>
      Promise.resolve(
        where.status?.in?.includes('submitted') ? { id: 'previous-label-job' } : null,
      );
    const noReason = setup({
      current: { step: 'qr_print', labelState: 'reprint_requested' },
    });
    noReason.tx.labelPrintJob.findFirst.mockImplementation(findPriorPrint);
    await expect(
      noReason.service.printQr(actor, 'ROLL-A', { operationKey: 'admin-cleared-reprint' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(noReason.printer.print).not.toHaveBeenCalled();

    const withReason = setup({
      current: { step: 'qr_print', labelState: 'reprint_requested' },
    });
    withReason.tx.labelPrintJob.findFirst.mockImplementation(findPriorPrint);
    await withReason.service.printQr(actor, 'ROLL-A', {
      operationKey: 'admin-cleared-reprint',
      reason: 'Администратор подтвердил отсутствие этикетки',
    });
    expect(withReason.printer.print).toHaveBeenCalledTimes(1);
    expect(withReason.tx.labelPrintJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'reprint_requested',
        replacesJobId: 'previous-label-job',
      }),
    });
  });

  it('replays a reprint started at qr_print using its saved intent after a lost response', async () => {
    const replay = setup({ current: { step: 'qr_check' }, claim: { kind: 'replay' } });
    const reason = 'Предыдущая этикетка повреждена';
    replay.tx.operatorRollOperation.findUnique.mockResolvedValue({
      deviceId: 'printer-a', expectedStep: 'qr_print',
      requestFingerprint: OperatorOperationService.fingerprint({ reprint: true, reason }),
    });
    await replay.service.printQr(actor, 'ROLL-A', { operationKey: 'reprint-retry', reason });
    expect(replay.operations.claim).toHaveBeenCalledWith(replay.tx,
      expect.objectContaining({ fingerprintInput: { reprint: true, reason } }));
    expect(replay.printer.print).not.toHaveBeenCalled();
  });

  it('journals an acknowledged but uncertain print without advancing or allowing retry', async () => {
    const uncertain = setup({ current: { step: 'qr_print' } });
    uncertain.printer.print.mockResolvedValue({
      jobId: 'printer-job-a',
      printerId: 'printer-a',
      status: 'delivery_unknown',
      failureReason: 'gateway_transport_outcome_unknown',
      gatewayCommandId: 'gateway-command-a',
    });

    await expect(
      uncertain.service.printQr(actor, 'ROLL-A', { operationKey: 'uncertain-print' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(uncertain.tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'label-job-a' },
      data: {
        status: 'delivery_unknown',
        gatewayCommandId: 'gateway-command-a',
        completedAt: expect.any(Date),
        failureReason: 'gateway_transport_outcome_unknown',
      },
    });
    expect(uncertain.tx.operatorRollLine.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'line-a',
        step: 'qr_print',
        warehouseState: 'not_ready',
        rollDispatchItem: { status: { notIn: ['ready_for_warehouse', 'done'] } },
      },
      data: {
        labelState: 'delivery_unknown',
        step: 'qr_print',
      },
    });
    expect(uncertain.operations.fail).toHaveBeenCalledWith(
      uncertain.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
        resultRef: 'label-job-a',
      },
      LEASE_TOKEN,
    );
    expect(uncertain.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_label_print_delivery_unknown',
        detail: expect.objectContaining({
          status: 'delivery_unknown',
          reasonCode: 'gateway_transport_outcome_unknown',
        }),
      }),
      uncertain.tx,
    );
    expect(uncertain.incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'gateway:post:post-a:command:print_delivery_unknown',
        targetId: 'post-a',
      }),
    );
    expect(uncertain.incidents.signal).not.toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'device:printer-a:connection' }),
    );

    const blocked = setup({
      current: { step: 'qr_print', labelState: 'delivery_unknown', qrCode: 'stored-uncertain-qr' },
    });
    blocked.tx.labelPrintJob.findFirst.mockResolvedValue({
      id: 'uncertain-job',
      status: 'delivery_unknown',
    });
    await expect(
      blocked.service.printQr(actor, 'ROLL-A', { operationKey: 'new-key-must-not-print' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(blocked.operations.claim).not.toHaveBeenCalled();
    expect(blocked.printer.print).not.toHaveBeenCalled();
  });

  it('does not close an earlier uncertain print after an unrelated successful print', async () => {
    const successful = setup({ current: { step: 'qr_print' } });

    await successful.service.printQr(actor, 'ROLL-A', {
      operationKey: 'unrelated-success-after-unknown',
    });

    expect(successful.incidents.resolve).not.toHaveBeenCalledWith(
      'gateway:post:post-a:command:print_delivery_unknown',
      expect.any(String),
    );
  });

  it('routes an explicit printer rejection to the device connection episode', async () => {
    const failed = setup({ current: { step: 'qr_print' } });
    failed.printer.print.mockResolvedValue({
      jobId: 'printer-job-a',
      printerId: 'printer-a',
      status: 'failed',
      failureReason: 'credential=secret bitmapBase64=payload',
    });

    await expect(
      failed.service.printQr(actor, 'ROLL-A', { operationKey: 'failed-print' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PRINTER_UNAVAILABLE' }),
    });

    expect(failed.incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'device:printer-a:connection',
        targetId: 'printer-a',
      }),
    );
    expect(failed.incidents.signal).not.toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'gateway:post:post-a:command:print_delivery_unknown',
      }),
    );
    expect(JSON.stringify(failed.incidents.signal.mock.calls)).not.toMatch(
      /credential|secret|bitmap|payload|stack/i,
    );
  });

  it('treats a rejected printer adapter call as delivery_unknown', async () => {
    const uncertain = setup({ current: { step: 'qr_print' } });
    uncertain.printer.print.mockRejectedValue(new Error('adapter lost its response'));

    await expect(
      uncertain.service.printQr(actor, 'ROLL-A', { operationKey: 'rejected-print' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(uncertain.tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'label-job-a' },
      data: {
        status: 'delivery_unknown',
        gatewayCommandId: null,
        completedAt: expect.any(Date),
        failureReason: 'printer_adapter_rejection_outcome_unknown',
      },
    });
    expect(uncertain.operations.fail).toHaveBeenCalledWith(
      uncertain.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
        resultRef: 'label-job-a',
      },
      LEASE_TOKEN,
    );
  });

  it('treats an out-of-contract printer result as delivery_unknown', async () => {
    const uncertain = setup({ current: { step: 'qr_print' } });
    uncertain.printer.print.mockResolvedValue({
      jobId: 'driver-job-a',
      printerId: 'printer-a',
      status: 'unexpected-runtime-status',
    } as never);

    await expect(
      uncertain.service.printQr(actor, 'ROLL-A', { operationKey: 'malformed-print-result' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(uncertain.tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'label-job-a' },
      data: {
        status: 'delivery_unknown',
        gatewayCommandId: 'driver-job-a',
        completedAt: expect.any(Date),
        failureReason: 'printer_result_status_unknown',
      },
    });
    expect(uncertain.printer.print).toHaveBeenCalledTimes(1);
  });

  it('blocks a new print key while another physical print is in progress', async () => {
    const active = setup({ current: { step: 'qr_print' } });
    active.tx.labelPrintJob.findFirst.mockImplementation(
      ({ where }: { where: { status: string | { in?: string[] } } }) => {
        const statuses = typeof where.status === 'string' ? [where.status] : where.status.in;
        return Promise.resolve(
          statuses?.includes('queued') ? { id: 'active-print-job', status: 'queued' } : null,
        );
      },
    );

    await expect(
      active.service.printQr(actor, 'ROLL-A', { operationKey: 'new-print-key' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PRINT_IN_PROGRESS' }),
    });
    expect(active.tx.labelPrintJob.create).not.toHaveBeenCalled();
    expect(active.printer.print).not.toHaveBeenCalled();
  });

  it('reconciles an expired print blocker after reload without printing again', async () => {
    const stale = setup({ current: { step: 'qr_print', labelState: 'not_printed' } });
    stale.tx.labelPrintJob.findFirst.mockImplementation(
      ({ where }: { where: { status?: string | { in?: string[] } } }) => {
        const statuses =
          typeof where.status === 'string' ? [where.status] : (where.status?.in ?? []);
        return Promise.resolve(statuses.includes('queued') ? { id: 'active-print-job' } : null);
      },
    );
    stale.tx.operatorRollOperation.findUnique.mockResolvedValue(null);
    stale.tx.operatorRollOperation.findFirst.mockResolvedValue({
      id: 'expired-print-operation',
      action: 'qr_print',
      actorId: actor.userId,
      requestFingerprint: OperatorOperationService.fingerprint({
        reprint: false,
        reason: null,
      }),
      status: 'in_progress',
      leaseToken: LEASE_TOKEN,
      leaseExpiresAt: new Date(Date.now() - 1_000),
      expectedStep: 'qr_print',
      deviceId: 'printer-a',
      postId: 'post-a',
      postSessionId: 'session-a',
      operatorRollLineId: 'line-a',
      line: { rollDispatchItem: { rollCode: 'ROLL-A' } },
      labelPrintJob: { id: 'active-print-job' },
    });

    await expect(
      stale.service.printQr(actor, 'ROLL-A', { operationKey: 'new-print-key-after-reload' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PRINT_IN_PROGRESS' }),
    });

    expect(stale.operations.settleExpired).toHaveBeenCalledWith(
      stale.tx,
      'expired-print-operation',
      LEASE_TOKEN,
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
        resultRef: 'active-print-job',
      },
      expect.any(Date),
    );
    expect(stale.tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'active-print-job' },
      data: {
        status: 'delivery_unknown',
        completedAt: expect.any(Date),
        failureReason: 'operator_lease_expired_context_changed',
      },
    });
    expect(stale.printer.print).not.toHaveBeenCalled();
  });

  it('moves an expired ambiguous print to reconciliation without printing a second label', async () => {
    const stale = setup({
      current: { step: 'qr_print', labelState: 'not_printed' },
      claim: {
        recoveryFromId: 'operation-a',
        operation: {
          id: 'operation-a',
          deviceId: 'printer-a',
          leaseToken: LEASE_TOKEN,
        },
      },
    });
    stale.tx.operatorRollOperation.findUnique.mockResolvedValue({
      deviceId: 'printer-a',
      expectedStep: 'qr_print',
    });
    stale.tx.labelPrintJob.findFirst.mockResolvedValue({ id: 'stale-label-job' });

    await expect(
      stale.service.printQr(actor, 'ROLL-A', { operationKey: 'stale-print-key' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
        printJobId: 'stale-label-job',
      }),
    });

    expect(stale.printer.print).not.toHaveBeenCalled();
    expect(stale.tx.labelPrintJob.create).not.toHaveBeenCalled();
    expect(stale.tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'stale-label-job' },
      data: expect.objectContaining({
        status: 'delivery_unknown',
        failureReason: 'operator_lease_expired_outcome_unknown',
      }),
    });
    expect(stale.operations.fail).toHaveBeenCalledWith(
      stale.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
        resultRef: 'stale-label-job',
      },
      LEASE_TOKEN,
    );
  });

  it('does not overwrite terminal line state when print finalization becomes uncertain', async () => {
    const raced = setup({ current: { step: 'qr_print' } });
    const mutableLine = {
      ...line,
      step: 'qr_print',
      rollDispatchItem: { ...line.rollDispatchItem, status: 'assigned' },
    };
    const terminalLine = {
      ...mutableLine,
      rollDispatchItem: { ...line.rollDispatchItem, status: 'done' },
    };
    raced.ownership.lockOwned
      .mockResolvedValueOnce({ session, line: mutableLine })
      .mockResolvedValueOnce({ session, line: terminalLine });
    raced.tx.operatorRollLine.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      raced.service.printQr(actor, 'ROLL-A', { operationKey: 'print-terminal-race' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(raced.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(raced.tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'label-job-a' },
      data: {
        status: 'delivery_unknown',
        gatewayCommandId: 'printer-job-a',
        completedAt: expect.any(Date),
        failureReason: 'operator_finalization_conflict_after_acknowledged_print',
      },
    });
    expect(raced.tx.operatorRollLine.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'line-a',
        step: 'qr_print',
        warehouseState: 'not_ready',
        rollDispatchItem: { status: { notIn: ['ready_for_warehouse', 'done'] } },
      },
      data: {
        labelState: 'delivery_unknown',
        step: 'qr_print',
      },
    });
    expect(raced.operations.fail).toHaveBeenCalledWith(
      raced.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
        resultRef: 'label-job-a',
      },
      LEASE_TOKEN,
    );
  });

  it('captures and links a stable whole-roll defect atomically from the exact roll-weight stage', async () => {
    const { service, tx, audit, operations, binding, scale, spoolStock } = setup({
      current: { step: 'roll_weight', spoolKg: 999, netKg: null },
    });
    tx.defectRecord.create.mockResolvedValue({ id: 'defect-a' });
    scale.read.mockResolvedValue({
      deviceId: 'scale-a',
      status: 'ready',
      stable: true,
      grossKg: 10.8,
    });

    await service.recordDefect(actor, 'ROLL-A', {
      operationKey: 'defect-key',
    });

    expect(binding.resolve).toHaveBeenCalledWith('post-a', 'scale', tx);
    expect(scale.read).toHaveBeenCalledWith(
      { deviceId: 'scale-a', expectedPostId: 'post-a', expectedKind: 'scale' },
      'roll',
    );
    expect(tx.weightCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operatorRollLineId: 'line-a',
        operationId: 'operation-a',
        kind: 'roll',
        deviceId: 'scale-a',
        deviceStatus: 'ready',
        stable: true,
        grossKg: 10.8,
        spoolKg: 1,
        netKg: 9.8,
        actorId: actor.userId,
        postId: 'post-a',
        postSessionId: 'session-a',
      }),
    });
    expect(tx.defectRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        weightCaptureId: 'capture-a',
        weightKg: 9.8,
        comment: 'Брак зафиксирован взвешиванием',
        blocking: true,
      }),
    });
    expect(tx.productionProblem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'defect',
        rollId: 'ROLL-A',
        defectRecordId: 'defect-a',
        reason: 'Брак зафиксирован взвешиванием',
      }),
    });
    expect(spoolStock.returnDefectSpool).toHaveBeenCalledWith(actor, 'defect-a', tx);
    expect(tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: {
        spoolKg: 1,
        grossKg: 10.8,
        netKg: 9.8,
        toleranceOk: true,
        warehouseState: 'not_ready',
        step: 'defect',
        deferredFromStep: null,
      },
    });
    expect(tx.rollDispatchItem.update).toHaveBeenCalledWith({
      where: { id: 'dispatch-a' },
      data: { status: 'defect' },
    });
    expect(tx.rollDispatchItem.aggregate).toHaveBeenCalledWith({
      where: {
        assignedOperatorId: 'operator-a',
        plannedShiftId: 'shift-a',
        postId: 'post-a',
      },
      _max: { queueRank: true },
    });
    expect(tx.rollDispatchItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rollCode: 'ROLL-A-R1',
        productionOrderId: 'production-a',
        replacesDispatchItemId: 'dispatch-a',
        orderLineId: 'position-a',
        positionSequence: 1,
        rawMaterialId: 'material-a',
        recipeVersion: 'recipe-v1',
        assignedOperatorId: 'operator-a',
        machineId: 'machine-a',
        workplaceId: 'workplace-a',
        postId: 'post-a',
        plannedShiftId: 'shift-a',
        queueRank: 8,
        priority: 2,
        status: 'assigned',
      }),
    });
    expect(tx.operatorRollLine.create).toHaveBeenCalledWith({
      data: {
        rollDispatchItemId: 'replacement-dispatch-a',
        sequence: 2,
        groupId: 'group-a',
        planKg: 10,
        step: 'assigned',
      },
    });
    expect(operations.complete).toHaveBeenCalledWith(
      tx,
      'operation-a',
      expect.objectContaining({ resultRef: 'defect-a', resultStep: 'defect' }),
      LEASE_TOKEN,
    );
    expect(audit.record.mock.calls.every((call: unknown[]) => call[1] === tx)).toBe(true);
    expect(audit.record.mock.calls.map((call: any[]) => call[0].type)).toEqual([
      'audit:operator_weight_captured',
      'audit:defect_recorded',
      'problem:operator_defect_reported',
      'audit:replacement_roll_created',
    ]);
    expect(audit.record).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        type: 'problem:operator_defect_reported',
        detail: expect.objectContaining({
          notificationKey: 'operator-defect:operation-a:reported',
          recipientRoles: ['operator', 'production_lead', 'director'],
          recipientUserIds: ['operator-a'],
          problemId: 'problem-a',
          orderId: 'order-a',
          productionOrderId: 'production-a',
          positionId: 'position-a',
          rollId: 'ROLL-A',
          replacementRollId: 'replacement-dispatch-a',
          replacementRollCode: 'ROLL-A-R1',
        }),
      }),
      tx,
    );
    expect(audit.record).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        type: 'audit:replacement_roll_created',
        objectId: 'ROLL-A-R1',
        detail: expect.objectContaining({
          notificationKey: 'operator-defect:operation-a:replacement-created',
          recipientRoles: ['operator', 'production_lead', 'warehouse', 'director'],
          recipientUserIds: ['operator-a'],
          problemId: 'problem-a',
          orderId: 'order-a',
          positionId: 'position-a',
          rollId: 'ROLL-A-R1',
          rollIds: ['ROLL-A', 'ROLL-A-R1'],
          sourceRollCode: 'ROLL-A',
          sourceDispatchItemId: 'dispatch-a',
          replacementDispatchItemId: 'replacement-dispatch-a',
          operationId: 'operation-a',
        }),
      }),
      tx,
    );
  });

  it.each([
    ['offline', { status: 'offline', stable: false, grossKg: 10.8 }],
    ['unstable', { status: 'ready', stable: false, grossKg: 10.8 }],
  ])('does not persist a defect when the scale is %s', async (_case, reading) => {
    const failed = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    failed.scale.read.mockResolvedValue(reading);

    await expect(
      failed.service.recordDefect(actor, 'ROLL-A', {
        operationKey: `defect-${_case}`,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_SCALE_UNAVAILABLE' }),
    });

    expect(failed.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(failed.tx.defectRecord.create).not.toHaveBeenCalled();
    expect(failed.tx.productionProblem.create).not.toHaveBeenCalled();
    expect(failed.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(failed.operations.fail).toHaveBeenCalledWith(
      failed.tx,
      'operation-a',
      {
        httpStatus: 503,
        errorCode: 'OPERATOR_SCALE_UNAVAILABLE',
      },
      LEASE_TOKEN,
    );
  });

  it('reports zero net defect instead of blaming a stable scale reading', async () => {
    const rejected = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    rejected.scale.read.mockResolvedValue({
      deviceId: 'scale-a',
      status: 'ready',
      stable: true,
      grossKg: 1,
    });

    await expect(
      rejected.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'defect-zero-net',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_DEFECT_WEIGHT_NOT_ABOVE_SPOOL',
      }),
    });

    expect(rejected.operations.fail).toHaveBeenCalledWith(
      rejected.tx,
      'operation-a',
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_DEFECT_WEIGHT_NOT_ABOVE_SPOOL',
      },
      LEASE_TOKEN,
    );
    expect(rejected.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(rejected.tx.defectRecord.create).not.toHaveBeenCalled();
    expect(rejected.incidents.signal).not.toHaveBeenCalled();
    expect(rejected.incidents.resolve).toHaveBeenCalledWith(
      'device:scale-a:connection',
      expect.any(String),
    );
  });

  it('rejects a defect gross that normalizes to the spool weight', async () => {
    const rejected = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    rejected.tx.defectRecord.create.mockResolvedValue({ id: 'defect-a' });
    rejected.scale.read.mockResolvedValue({
      deviceId: 'scale-a',
      status: 'ready',
      stable: true,
      grossKg: 1.0004,
    });

    await expect(
      rejected.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'defect-normalized-zero-net',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DEFECT_WEIGHT_NOT_ABOVE_SPOOL' }),
    });

    expect(rejected.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(rejected.tx.defectRecord.create).not.toHaveBeenCalled();
    expect(rejected.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('replays the same defect operation without another scale read or mutation', async () => {
    const replay = setup({
      current: { step: 'deferred', deferredFromStep: 'roll_weight', spoolKg: 1 },
      claim: { kind: 'replay', operation: { id: 'operation-a', resultRef: 'defect-a' } },
    });
    replay.tx.operatorRollOperation.findUnique.mockResolvedValue({ deviceId: 'scale-a' });

    await replay.service.recordDefect(actor, 'ROLL-A', {
      operationKey: 'defect-replay',
    });

    expect(replay.scale.read).not.toHaveBeenCalled();
    expect(replay.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(replay.tx.defectRecord.create).not.toHaveBeenCalled();
    expect(replay.tx.productionProblem.create).not.toHaveBeenCalled();
    expect(replay.audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['later step', { step: 'qr_print' }, null, 'OPERATOR_DEFECT_CAPTURE_STAGE_CONFLICT'],
    [
      'existing roll capture',
      { step: 'roll_weight' },
      primaryRollCapture,
      'OPERATOR_DEFECT_EXISTING_ROLL_CAPTURE',
    ],
  ])('rejects %s before reading the scale', async (_case, current, priorCapture, code) => {
    const rejected = setup({ current: { ...current, spoolKg: 1 } });
    rejected.tx.weightCapture.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.kind === 'roll'
          ? priorCapture
          : {
              id: 'spool-capture-a',
              kind: 'spool',
              stable: true,
              grossKg: 1,
              deviceId: 'scale-a',
              postId: 'post-a',
              postSessionId: 'session-a',
            },
      ),
    );

    await expect(
      rejected.service.recordDefect(actor, 'ROLL-A', {
        operationKey: `defect-reject-${_case}`,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
    expect(rejected.binding.resolve).not.toHaveBeenCalled();
    expect(rejected.scale.read).not.toHaveBeenCalled();
    expect(rejected.tx.defectRecord.create).not.toHaveBeenCalled();
  });

  it('durably settles an expired defect claim when its stage changed before retry', async () => {
    const stale = setup({ current: { step: 'qr_print', spoolKg: 1 } });
    stale.tx.operatorRollOperation.findUnique.mockResolvedValue({
      id: 'operation-a',
      action: 'defect',
      actorId: actor.userId,
      requestFingerprint: OperatorOperationService.fingerprint({}),
      status: 'in_progress',
      leaseToken: LEASE_TOKEN,
      leaseExpiresAt: new Date(Date.now() - 1_000),
      expectedStep: 'roll_weight',
      deviceId: 'scale-a',
      postId: 'post-a',
      postSessionId: 'session-a',
      line: { rollDispatchItem: { rollCode: 'ROLL-A' } },
      labelPrintJob: null,
    });

    await expect(
      stale.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'stale-defect-stage',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DEFECT_CAPTURE_STAGE_CONFLICT' }),
    });

    expect(stale.scale.read).not.toHaveBeenCalled();
    expect(stale.operations.settleExpired).toHaveBeenCalledWith(
      stale.tx,
      'operation-a',
      LEASE_TOKEN,
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_DEFECT_CAPTURE_STAGE_CONFLICT',
      },
      expect.any(Date),
    );
    expect(stale.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_weight_capture_failed',
        detail: expect.objectContaining({
          operationId: 'operation-a',
          leaseExpired: true,
          reasonCode: 'OPERATOR_DEFECT_CAPTURE_STAGE_CONFLICT',
        }),
      }),
      stale.tx,
    );
  });

  it('releases the exact expired physical blocker after a page reload changes the key', async () => {
    const stale = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    stale.operations.claim.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate in-progress operation', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    stale.tx.operatorRollOperation.findUnique.mockResolvedValue(null);
    stale.tx.operatorRollOperation.findFirst.mockResolvedValue({
      id: 'expired-operation',
      action: 'defect',
      actorId: actor.userId,
      requestFingerprint: OperatorOperationService.fingerprint({}),
      status: 'in_progress',
      leaseToken: LEASE_TOKEN,
      leaseExpiresAt: new Date(Date.now() - 1_000),
      expectedStep: 'roll_weight',
      deviceId: 'scale-a',
      postId: 'post-a',
      postSessionId: 'session-a',
      operatorRollLineId: 'line-a',
      line: { rollDispatchItem: { rollCode: 'ROLL-A' } },
      labelPrintJob: null,
    });
    const request = {
      operationKey: 'new-key-after-reload',
    };

    await expect(stale.service.recordDefect(actor, 'ROLL-A', request)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_CONCURRENT_STATE_CONFLICT' }),
    });

    expect(stale.tx.operatorRollOperation.findFirst).toHaveBeenCalledWith({
      where: {
        action: 'defect',
        actorId: actor.userId,
        status: 'in_progress',
        leaseExpiresAt: { lte: expect.any(Date) },
        line: { rollDispatchItem: { rollCode: 'ROLL-A' } },
      },
      select: expect.any(Object),
      orderBy: { createdAt: 'asc' },
    });
    expect(stale.operations.settleExpired).toHaveBeenCalledWith(
      stale.tx,
      'expired-operation',
      LEASE_TOKEN,
      {
        httpStatus: 409,
        errorCode: 'OPERATOR_CONCURRENT_STATE_CONFLICT',
      },
      expect.any(Date),
    );

    stale.scale.read.mockResolvedValue({
      deviceId: 'scale-a',
      status: 'ready',
      stable: true,
      grossKg: 2,
    });
    stale.tx.defectRecord.create.mockResolvedValue({ id: 'defect-after-reload' });
    await expect(stale.service.recordDefect(actor, 'ROLL-A', request)).resolves.toMatchObject({
      rollCode: 'ROLL-A',
    });
    expect(stale.operations.claim).toHaveBeenLastCalledWith(
      stale.tx,
      expect.objectContaining({ operationKey: 'new-key-after-reload', action: 'defect' }),
    );
  });

  it('rejects a second open defect problem before reading the scale', async () => {
    const duplicate = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    duplicate.tx.productionProblem.findFirst.mockResolvedValue({ id: 'problem-existing' });

    await expect(
      duplicate.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'defect-duplicate',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPEN_DEFECT_EXISTS' }),
    });
    expect(duplicate.scale.read).not.toHaveBeenCalled();
    expect(duplicate.tx.defectRecord.create).not.toHaveBeenCalled();
  });

  it('rejects missing stable spool evidence from the current post session', async () => {
    const missingSpool = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    missingSpool.tx.weightCapture.findFirst.mockResolvedValue(null);

    await expect(
      missingSpool.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'defect-without-spool-evidence',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DEFECT_SPOOL_EVIDENCE_REQUIRED' }),
    });
    expect(missingSpool.binding.resolve).not.toHaveBeenCalled();
    expect(missingSpool.scale.read).not.toHaveBeenCalled();
  });

  it('rejects a scale replacement after the spool capture', async () => {
    const replacedScale = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    replacedScale.tx.weightCapture.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.kind === 'spool'
          ? {
              id: 'spool-capture-a',
              kind: 'spool',
              stable: true,
              grossKg: 1,
              deviceId: 'scale-old',
              postId: 'post-a',
              postSessionId: 'session-a',
            }
          : null,
      ),
    );

    await expect(
      replacedScale.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'defect-after-scale-change',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DEFECT_SPOOL_DEVICE_CHANGED' }),
    });
    expect(replacedScale.scale.read).not.toHaveBeenCalled();
  });

  it('rejects finalization when the roll state changes after the physical read', async () => {
    const raced = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    raced.scale.read.mockResolvedValue({
      deviceId: 'scale-a',
      status: 'ready',
      stable: true,
      grossKg: 10.8,
    });
    raced.ownership.lockOwned
      .mockResolvedValueOnce({
        session,
        line: { ...line, step: 'roll_weight', spoolKg: 1 },
      })
      .mockResolvedValueOnce({
        session,
        line: { ...line, step: 'qr_print', spoolKg: 1 },
      });

    await expect(
      raced.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'defect-state-race',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DEFECT_CAPTURE_STAGE_CONFLICT' }),
    });
    expect(raced.scale.read).toHaveBeenCalledTimes(1);
    expect(raced.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(raced.tx.defectRecord.create).not.toHaveBeenCalled();
    expect(raced.tx.productionProblem.create).not.toHaveBeenCalled();
  });

  it('checks the defect lease before writing any physical evidence', async () => {
    const fenced = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    fenced.operations.assertCurrentLease.mockRejectedValue(
      new ConflictException({
        code: 'OPERATOR_OPERATION_LEASE_LOST',
        message: 'lease lost',
      }),
    );
    fenced.tx.operatorRollOperation.findFirst.mockResolvedValue(null);
    fenced.scale.read.mockResolvedValue({
      deviceId: 'scale-a',
      status: 'ready',
      stable: true,
      grossKg: 10.8,
    });

    await expect(
      fenced.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'fenced-defect',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPERATION_LEASE_LOST' }),
    });

    expect(fenced.tx.weightCapture.create).not.toHaveBeenCalled();
    expect(fenced.tx.defectRecord.create).not.toHaveBeenCalled();
    expect(fenced.tx.productionProblem.create).not.toHaveBeenCalled();
    expect(fenced.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('rolls back capture, defect, problem and line state when a required event fails', async () => {
    const atomic = setup({ current: { step: 'roll_weight', spoolKg: 1 } });
    atomic.scale.read.mockResolvedValue({
      deviceId: 'scale-a',
      status: 'ready',
      stable: true,
      grossKg: 10.8,
    });
    type State = {
      captures: string[];
      defects: string[];
      problems: string[];
      events: string[];
      lineStep: string;
    };
    const clone = (value: State): State => JSON.parse(JSON.stringify(value)) as State;
    let committed: State = {
      captures: [],
      defects: [],
      problems: [],
      events: [],
      lineStep: 'roll_weight',
    };
    let active = clone(committed);
    let eventCall = 0;
    atomic.prisma.$transaction.mockImplementation(async (callback: (client: any) => unknown) => {
      active = clone(committed);
      try {
        const result = await callback(atomic.tx);
        committed = clone(active);
        return result;
      } finally {
        active = clone(committed);
      }
    });
    atomic.tx.weightCapture.create.mockImplementation(async () => {
      active.captures.push('capture-a');
      return { id: 'capture-a' };
    });
    atomic.tx.defectRecord.create.mockImplementation(async () => {
      active.defects.push('defect-a');
      return { id: 'defect-a' };
    });
    atomic.tx.productionProblem.create.mockImplementation(async () => {
      active.problems.push('problem-a');
      return { id: 'problem-a' };
    });
    atomic.tx.operatorRollLine.update.mockImplementation(async ({ data }: any) => {
      active.lineStep = data.step;
      return { ...line, ...data };
    });
    atomic.audit.record.mockImplementation(async ({ type }: any) => {
      eventCall += 1;
      if (eventCall === 2) throw new Error('required defect event failed');
      active.events.push(type);
    });

    await expect(
      atomic.service.recordDefect(actor, 'ROLL-A', {
        operationKey: 'defect-event-rollback',
      }),
    ).rejects.toThrow('required defect event failed');

    expect(committed).toEqual({
      captures: [],
      defects: [],
      problems: [],
      events: ['audit:operator_weight_capture_failed'],
      lineStep: 'roll_weight',
    });
    expect(atomic.operations.complete).not.toHaveBeenCalled();
  });

  it.each(['done', 'ready_for_warehouse'])(
    'rejects a new defect when the dispatch is terminal (%s)',
    async (status) => {
      const terminal = setup({
        current: {
          step: 'deferred',
          deferredFromStep: 'roll_weight',
          rollDispatchItem: { ...line.rollDispatchItem, status },
        },
      });
      terminal.tx.defectRecord.create.mockResolvedValue({ id: 'forbidden-defect' });

      await expect(
        terminal.service.recordDefect(actor, 'ROLL-A', {
          operationKey: `defect-after-${status}`,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'OPERATOR_DISPATCH_TERMINAL' }),
      });
      expect(terminal.tx.defectRecord.create).not.toHaveBeenCalled();
      expect(terminal.tx.operatorRollLine.update).not.toHaveBeenCalled();
      expect(terminal.tx.rollDispatchItem.update).not.toHaveBeenCalled();
      expect(terminal.audit.record).not.toHaveBeenCalled();
      expect(terminal.operations.complete).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'accept',
      'assigned',
      (service: OperatorPhysicalService) =>
        service.accept(actor, 'ROLL-A', { operationKey: 'terminal-accept' }),
    ],
    [
      'spool weight',
      'spool_weight',
      (service: OperatorPhysicalService) =>
        service.captureSpoolWeight(actor, 'ROLL-A', { operationKey: 'terminal-spool' }),
    ],
    [
      'roll weight',
      'roll_weight',
      (service: OperatorPhysicalService) =>
        service.captureRollWeight(actor, 'ROLL-A', { operationKey: 'terminal-roll' }),
    ],
    [
      'QR verify',
      'qr_check',
      (service: OperatorPhysicalService) =>
        service.verifyQr(actor, 'ROLL-A', {
          operationKey: 'terminal-verify',
          payload: 'stored-qr',
        }),
    ],
    [
      'defer',
      'roll_weight',
      (service: OperatorPhysicalService) =>
        service.defer(actor, 'ROLL-A', {
          operationKey: 'terminal-defer',
          reason: 'Нельзя вернуть завершённый рулон',
        }),
    ],
    [
      'QR print',
      'qr_print',
      (service: OperatorPhysicalService) =>
        service.printQr(actor, 'ROLL-A', { operationKey: 'terminal-print' }),
    ],
    [
      'handover',
      'handover',
      (service: OperatorPhysicalService) =>
        service.handover(actor, 'ROLL-A', { operationKey: 'terminal-handover' }),
    ],
  ])('fails closed for new %s mutation on a done dispatch', async (_name, step, mutate) => {
    const terminal = setup({
      current: {
        step,
        qrCode: step === 'qr_check' ? 'stored-qr' : null,
        labelState: step === 'qr_check' ? 'printed' : 'not_printed',
        rollDispatchItem: { ...line.rollDispatchItem, status: 'done' },
      },
    });

    await expect(mutate(terminal.service)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DISPATCH_TERMINAL' }),
    });
    expect(terminal.scale.read).not.toHaveBeenCalled();
    expect(terminal.printer.print).not.toHaveBeenCalled();
    expect(terminal.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(terminal.tx.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(terminal.audit.record).not.toHaveBeenCalled();
    expect(terminal.operations.complete).not.toHaveBeenCalled();
  });

  it('hands over only a verified predecessor and commits the warehouse bridge with audit', async () => {
    const { service, tx, audit, coverageFacts } = setup({
      current: { step: 'handover', labelState: 'verified' },
    });
    const task = await service.handover(actor, 'ROLL-A', { operationKey: 'handover-key' });

    expect(tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: { warehouseState: 'sent', step: 'warehouse' },
    });
    expect(tx.rollDispatchItem.update).toHaveBeenCalledWith({
      where: { id: 'dispatch-a' },
      data: { status: 'ready_for_warehouse' },
    });
    expect(task).toEqual({ id: 'warehouse-task-a' });
    expect(tx.scanRow.findFirst).toHaveBeenCalledWith({
      where: {
        rollCode: 'ROLL-A',
        scanStatus: { in: ['expected', 'accepted', 'reserved', 'damaged'] },
        task: {
          mode: 'receiving',
          status: { in: ['open', 'partial'] },
        },
      },
      include: { task: true },
      orderBy: [{ task: { createdAt: 'asc' } }, { id: 'asc' }],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_roll_handed_over' }),
      tx,
    );
    expect(coverageFacts.appendProductionHandoverFact).toHaveBeenCalledWith(tx, {
      rollId: 'warehouse-roll-a',
      sourceDispatchItemId: 'dispatch-a',
      sourceWeightCaptureId: 'capture-primary',
    });
  });

  it('rejects an invalid canonical handover weight with an explicit reweigh action', async () => {
    const v2Line = {
      ...line,
      step: 'handover',
      labelState: 'verified',
      spoolKg: 3.65,
      grossKg: 3.1,
      netKg: -0.55,
      toleranceOk: false,
      rollDispatchItem: {
        ...line.rollDispatchItem,
        productionOrder: {
          ...line.rollDispatchItem.productionOrder,
          sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000062',
          commercialOrder: {
            ...line.rollDispatchItem.productionOrder.commercialOrder,
            warehouseCoverageWorkflowVersion: 2,
          },
        },
      },
    };
    const invalid = setup({ current: v2Line });
    invalid.tx.weightCapture.findMany.mockResolvedValue([invalidHandoverCapture]);

    await expect(
      invalid.service.handover(actor, 'ROLL-A', {
        operationKey: 'handover-a16-invalid-weight',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'OPERATOR_HANDOVER_WEIGHT_INVALID',
        message: 'Вес рулона некорректен. Перевзвесьте рулон перед передачей на склад.',
        recoveryAction: 'reweigh',
        recoveryLabel: 'Перевзвесить',
      },
    });

    expect(invalid.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(invalid.tx.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(invalid.tx.warehouseAcceptanceTask.create).not.toHaveBeenCalled();
    expect(invalid.coverageFacts.appendProductionHandoverFact).not.toHaveBeenCalled();
    expect(invalid.operations.complete).not.toHaveBeenCalled();
    expect(invalid.audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_roll_handed_over' }),
      invalid.tx,
    );
  });

  it('creates one handover coverage fact from the recovered canonical capture', async () => {
    const recovered = setup({
      current: {
        step: 'handover',
        labelState: 'verified',
        spoolKg: 3.65,
        grossKg: 6.65,
        netKg: 3,
        toleranceOk: false,
      },
    });
    recovered.tx.weightCapture.findMany.mockResolvedValue([
      invalidHandoverCapture,
      recoveredHandoverCapture,
    ]);

    await expect(
      recovered.service.handover(actor, 'ROLL-A', {
        operationKey: 'handover-a16-recovered-weight',
      }),
    ).resolves.toEqual({ id: 'warehouse-task-a' });

    expect(recovered.coverageFacts.appendProductionHandoverFact).toHaveBeenCalledTimes(1);
    expect(recovered.coverageFacts.appendProductionHandoverFact).toHaveBeenCalledWith(
      recovered.tx,
      {
        rollId: 'warehouse-roll-a',
        sourceDispatchItemId: 'dispatch-a',
        sourceWeightCaptureId: 'capture-a16-recovered',
      },
    );
  });

  it('notifies the production lead only when every canonical order leaf reached the warehouse', async () => {
    const incomplete = setup({ current: { step: 'handover', labelState: 'verified' } });
    incomplete.tx.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-a',
        rollCode: 'ROLL-A',
        status: 'ready_for_warehouse',
        replacesDispatchItemId: null,
      },
      {
        id: 'dispatch-b',
        rollCode: 'ROLL-B',
        status: 'assigned',
        replacesDispatchItemId: null,
      },
    ]);

    await incomplete.service.handover(actor, 'ROLL-A', { operationKey: 'handover-first-leaf' });

    expect(
      incomplete.audit.record.mock.calls.some(
        ([event]: [{ type: string }]) =>
          event.type === 'notification:production_order_fully_handed_over',
      ),
    ).toBe(false);

    const complete = setup({ current: { step: 'handover', labelState: 'verified' } });
    complete.tx.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-a',
        rollCode: 'ROLL-A',
        status: 'ready_for_warehouse',
        replacesDispatchItemId: null,
      },
      {
        id: 'dispatch-b',
        rollCode: 'ROLL-B',
        status: 'done',
        replacesDispatchItemId: null,
      },
    ]);

    await complete.service.handover(actor, 'ROLL-A', { operationKey: 'handover-last-leaf' });

    expect(complete.audit.record).toHaveBeenCalledWith(
      {
        type: 'notification:production_order_fully_handed_over',
        actorRole: 'operator',
        actorId: 'operator-a',
        objectId: 'order-a',
        detail: {
          notificationKey: 'production-order-fully-handed-over:production-a:dispatch-a,dispatch-b',
          recipientRoles: ['production_lead'],
          recipientUserIds: [],
          orderId: 'order-a',
          orderNumber: 'ORDER-A',
          productionOrderId: 'production-a',
          rollCount: 2,
          rollIds: ['ROLL-A', 'ROLL-B'],
        },
      },
      complete.tx,
    );
  });

  it('deduplicates the completed-order notification and fails safe on an invalid replacement graph', async () => {
    const duplicate = setup({ current: { step: 'handover', labelState: 'verified' } });
    duplicate.tx.domainEvent.findFirst.mockResolvedValue({ id: 'completion-event' });

    await duplicate.service.handover(actor, 'ROLL-A', {
      operationKey: 'handover-completion-retry',
    });

    expect(
      duplicate.audit.record.mock.calls.filter(
        ([event]: [{ type: string }]) =>
          event.type === 'notification:production_order_fully_handed_over',
      ),
    ).toHaveLength(0);

    const malformed = setup({ current: { step: 'handover', labelState: 'verified' } });
    malformed.tx.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-a',
        rollCode: 'ROLL-A',
        status: 'ready_for_warehouse',
        replacesDispatchItemId: 'missing-parent',
      },
    ]);

    await malformed.service.handover(actor, 'ROLL-A', {
      operationKey: 'handover-invalid-replacement-chain',
    });

    expect(
      malformed.audit.record.mock.calls.filter(
        ([event]: [{ type: string }]) =>
          event.type === 'notification:production_order_fully_handed_over',
      ),
    ).toHaveLength(0);
    expect(malformed.operations.complete).toHaveBeenCalled();
  });

  it('reuses one order-scoped receiving task across positions and keeps row identity', async () => {
    const first = setup({ current: { step: 'handover', labelState: 'verified' } });

    await first.service.handover(actor, 'ROLL-A', { operationKey: 'handover-position-1' });

    expect(first.tx.warehouseAcceptanceTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mode: 'receiving',
        status: 'open',
        orderId: 'order-a',
        receivingScopeKey: 'commercial-order:order-a',
      }),
    });
    expect(first.tx.warehouseAcceptanceTask.create.mock.calls[0][0].data).not.toHaveProperty(
      'positionId',
    );
    expect(first.tx.scanRow.create).toHaveBeenCalledWith({
      data: {
        taskId: 'warehouse-task-a',
        rollCode: 'ROLL-A',
        fromOrderId: 'ORDER-A',
        scanStatus: 'expected',
      },
    });

    const secondLine = {
      ...line,
      step: 'handover',
      labelState: 'verified',
      rollDispatchItem: {
        ...line.rollDispatchItem,
        id: 'dispatch-b',
        rollCode: 'ROLL-B',
        orderLineId: 'position-b',
        positionSequence: 2,
      },
    };
    const second = setup({ current: secondLine });
    second.tx.warehouseAcceptanceTask.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.receivingScopeKey === 'commercial-order:order-a'
          ? { id: 'warehouse-task-a', status: 'open' }
          : null,
      ),
    );

    await second.service.handover(actor, 'ROLL-B', { operationKey: 'handover-position-2' });

    expect(second.tx.warehouseAcceptanceTask.create).not.toHaveBeenCalled();
    expect(second.tx.scanRow.create).toHaveBeenCalledWith({
      data: {
        taskId: 'warehouse-task-a',
        rollCode: 'ROLL-B',
        fromOrderId: 'ORDER-A',
        scanStatus: 'expected',
      },
    });
  });

  it('claims one legacy receiving task without rewriting its position or historical rows', async () => {
    const fixture = setup({ current: { step: 'handover', labelState: 'verified' } });
    fixture.tx.warehouseAcceptanceTask.findFirst.mockResolvedValue({
      id: 'legacy-a11-position-1',
      status: 'open',
      positionId: 'position-a',
    });

    await fixture.service.handover(actor, 'ROLL-A', { operationKey: 'handover-legacy-a11' });

    expect(fixture.tx.warehouseAcceptanceTask.updateMany).toHaveBeenCalledWith({
      where: { id: 'legacy-a11-position-1', receivingScopeKey: null },
      data: { receivingScopeKey: 'commercial-order:order-a' },
    });
    expect(fixture.tx.warehouseAcceptanceTask.create).not.toHaveBeenCalled();
    expect(fixture.tx.scanRow.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 'legacy-a11-position-1' }),
      }),
    );
    expect(fixture.tx.scanRow).not.toHaveProperty('updateMany');
  });

  it('atomically links a produced V2 roll to its source order, position, and decision', async () => {
    const v2Line = {
      ...line,
      step: 'handover',
      labelState: 'verified',
      rollDispatchItem: {
        ...line.rollDispatchItem,
        productionOrder: {
          ...line.rollDispatchItem.productionOrder,
          sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000062',
          commercialOrder: {
            ...line.rollDispatchItem.productionOrder.commercialOrder,
            warehouseCoverageWorkflowVersion: 2,
          },
        },
      },
    };
    const fixture = setup({ current: v2Line });
    fixture.coverageFacts.appendProductionHandoverFact.mockResolvedValue({
      factId: 'coverage-fact-a',
      version: 1,
    });

    await expect(
      fixture.service.handover(actor, 'ROLL-A', { operationKey: 'handover-v2-produced' }),
    ).resolves.toEqual({ id: 'warehouse-task-a' });

    expect(fixture.tx.warehouseRoll.upsert).toHaveBeenCalledWith({
      where: { rollCode: 'ROLL-A' },
      update: {
        warehouseStatus: 'sent',
        ownerCounterpartyId: 'counterparty-a',
      },
      create: {
        rollCode: 'ROLL-A',
        warehouseStatus: 'sent',
        ownerCounterpartyId: 'counterparty-a',
      },
    });
    expect(fixture.tx.warehouseRoll.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'warehouse-roll-a',
        currentCoverageFactId: 'coverage-fact-a',
        producedForOrderId: null,
        producedForPositionId: null,
        producedByCoverageDecisionId: null,
      },
      data: {
        producedForOrderId: 'order-a',
        producedForPositionId: 'position-a',
        producedByCoverageDecisionId: '00000000-0000-4000-8000-000000000062',
      },
    });
    expect(fixture.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_roll_handed_over',
        detail: expect.objectContaining({
          sourcePositionId: 'position-a',
          sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000062',
        }),
      }),
      fixture.tx,
    );
  });

  it('fails a V2 handover closed when no canonical production fact can be persisted', async () => {
    const v2Line = {
      ...line,
      step: 'handover',
      labelState: 'verified',
      rollDispatchItem: {
        ...line.rollDispatchItem,
        productionOrder: {
          ...line.rollDispatchItem.productionOrder,
          sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000062',
          commercialOrder: {
            ...line.rollDispatchItem.productionOrder.commercialOrder,
            warehouseCoverageWorkflowVersion: 2,
          },
        },
      },
    };
    const fixture = setup({ current: v2Line });

    await expect(
      fixture.service.handover(actor, 'ROLL-A', {
        operationKey: 'handover-v2-without-canonical-fact',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_V2_HANDOVER_PROVENANCE_REQUIRED',
        message:
          'QR считан, но передача на склад остановлена: не удалось подтвердить вес и связь рулона с позицией заказа.',
      }),
    });
    expect(fixture.tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(fixture.operations.complete).not.toHaveBeenCalled();
  });

  it('fails a V2 handover closed when production provenance changes concurrently', async () => {
    const v2Line = {
      ...line,
      step: 'handover',
      labelState: 'verified',
      rollDispatchItem: {
        ...line.rollDispatchItem,
        productionOrder: {
          ...line.rollDispatchItem.productionOrder,
          sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000062',
          commercialOrder: {
            ...line.rollDispatchItem.productionOrder.commercialOrder,
            warehouseCoverageWorkflowVersion: 2,
          },
        },
      },
    };
    const fixture = setup({ current: v2Line });
    fixture.coverageFacts.appendProductionHandoverFact.mockResolvedValue({
      factId: 'coverage-fact-a',
      version: 1,
    });
    fixture.tx.warehouseRoll.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      fixture.service.handover(actor, 'ROLL-A', {
        operationKey: 'handover-v2-concurrent-provenance',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_V2_HANDOVER_PROVENANCE_CONFLICT',
      }),
    });
    expect(fixture.operations.complete).not.toHaveBeenCalled();
    expect(fixture.audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_roll_handed_over' }),
      fixture.tx,
    );
  });

  it('links a produced stock roll to company inventory without a client reservation', async () => {
    const stockLine = {
      ...line,
      step: 'handover',
      labelState: 'verified',
      rollDispatchItem: {
        ...line.rollDispatchItem,
        productionOrder: {
          ...line.rollDispatchItem.productionOrder,
          commercialOrder: {
            ...line.rollDispatchItem.productionOrder.commercialOrder,
            id: 'stock-order-1',
            counterpartyId: null,
            requestType: 'stock_reserve',
            stockBatchCode: 'STOCK-S-1',
            warehouseCoverageWorkflowVersion: 1,
          },
        },
      },
    };
    const fixture = setup({ current: stockLine });

    await expect(
      fixture.service.handover(actor, 'ROLL-A', { operationKey: 'handover-stock-produced' }),
    ).resolves.toEqual({ id: 'warehouse-task-a' });

    expect(fixture.tx.warehouseRoll.upsert).toHaveBeenCalledWith({
      where: { rollCode: 'ROLL-A' },
      update: {
        warehouseStatus: 'sent',
        ownerCounterpartyId: null,
        producedForStockOrderId: 'stock-order-1',
      },
      create: {
        rollCode: 'ROLL-A',
        warehouseStatus: 'sent',
        ownerCounterpartyId: null,
        producedForStockOrderId: 'stock-order-1',
      },
    });
  });

  it('hands over unknown coverage and asks the fact service to clear stale evidence', async () => {
    const fixture = setup({
      current: { step: 'handover', labelState: 'verified' },
    });
    fixture.tx.weightCapture.findMany.mockResolvedValue([]);

    await expect(
      fixture.service.handover(actor, 'ROLL-A', { operationKey: 'handover-no-weight' }),
    ).resolves.toEqual({ id: 'warehouse-task-a' });

    expect(fixture.coverageFacts.appendProductionHandoverFact).toHaveBeenCalledWith(fixture.tx, {
      rollId: 'warehouse-roll-a',
      sourceDispatchItemId: 'dispatch-a',
      sourceWeightCaptureId: null,
    });
  });

  it('cannot hand over an uncertain or otherwise unverified label', async () => {
    const uncertain = setup({
      current: { step: 'handover', labelState: 'delivery_unknown' },
    });

    await expect(
      uncertain.service.handover(actor, 'ROLL-A', { operationKey: 'handover-unknown-label' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_LABEL_NOT_VERIFIED' }),
    });
    expect(uncertain.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(uncertain.tx.rollDispatchItem.update).not.toHaveBeenCalled();
    expect(uncertain.tx.warehouseAcceptanceTask.create).not.toHaveBeenCalled();
    expect(uncertain.operations.complete).not.toHaveBeenCalled();
  });

  it('replays a completed handover without rewriting downstream warehouse state', async () => {
    const replay = setup({
      current: {
        step: 'warehouse',
        warehouseState: 'received',
        rollDispatchItem: { ...line.rollDispatchItem, status: 'done' },
      },
      claim: {
        kind: 'replay',
        operation: { id: 'operation-a', resultRef: 'warehouse-task-a' },
      },
    });

    await expect(
      replay.service.handover(actor, 'ROLL-A', { operationKey: 'handover-key' }),
    ).resolves.toEqual({ id: 'warehouse-task-a' });
    expect(replay.tx.warehouseAcceptanceTask.findUnique).toHaveBeenCalledWith({
      where: { id: 'warehouse-task-a' },
    });
    expect(replay.tx.warehouseRoll.upsert).not.toHaveBeenCalled();
    expect(replay.tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(replay.tx.scanRow.create).not.toHaveBeenCalled();
    expect(replay.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it.each([
    ['scale', 'captureSpoolWeight', 'OPERATOR_DEVICE_BINDING_UNAVAILABLE'],
    ['printer', 'printQr', 'OPERATOR_DEVICE_NOT_READY'],
  ] as const)(
    'journals a safe failed %s binding before returning 503',
    async (kind, method, errorCode) => {
      const failed = setup({ current: { step: kind === 'scale' ? 'spool_weight' : 'qr_print' } });
      failed.binding.resolve.mockRejectedValue(
        new ServiceUnavailableException({
          code: errorCode,
          message: 'safe binding failure',
          ...(errorCode === 'OPERATOR_DEVICE_NOT_READY' ? { deviceId: 'printer-a' } : {}),
        }),
      );

      await expect(
        method === 'captureSpoolWeight'
          ? failed.service.captureSpoolWeight(actor, 'ROLL-A', { operationKey: `${kind}-failed` })
          : failed.service.printQr(actor, 'ROLL-A', { operationKey: `${kind}-failed` }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(failed.operations.claim).toHaveBeenCalledWith(
        failed.tx,
        expect.objectContaining({ deviceId: null }),
      );
      expect(failed.operations.fail).toHaveBeenCalledWith(
        failed.tx,
        'operation-a',
        {
          httpStatus: 503,
          errorCode,
        },
        LEASE_TOKEN,
      );
      expect(failed.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({ operationId: 'operation-a', reasonCode: errorCode }),
        }),
        failed.tx,
      );
      expect(failed.scale.read).not.toHaveBeenCalled();
      expect(failed.printer.print).not.toHaveBeenCalled();
      if (errorCode === 'OPERATOR_DEVICE_NOT_READY') {
        expect(failed.incidents.resolve).toHaveBeenCalledWith(
          `post:post-a:binding:${kind}`,
          expect.any(String),
        );
        expect(failed.incidents.signal).toHaveBeenCalledWith(
          expect.objectContaining({
            fingerprint: 'device:printer-a:connection',
            targetId: 'printer-a',
          }),
        );
      } else {
        expect(failed.incidents.signal).toHaveBeenCalledWith(
          expect.objectContaining({
            fingerprint: `post:post-a:binding:${kind}`,
            targetId: 'post-a',
          }),
        );
      }
    },
  );
});
