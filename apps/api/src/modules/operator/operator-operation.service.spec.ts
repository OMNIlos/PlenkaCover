import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { GATEWAY_COMMAND_TIMEOUT_MAX_MS } from '../../common/runtime-config';
import {
  OPERATOR_PHYSICAL_OPERATION_LEASE_MS,
  OperatorOperationService,
} from './operator-operation.service';

const base = {
  operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
  action: 'spool_weight',
  actorId: 'operator-a',
  operatorRollLineId: 'line-a',
  postId: 'post-a',
  postSessionId: 'session-a',
  expectedStep: 'spool_weight',
  fingerprintInput: { kind: 'spool' },
} as const;

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: 'operation-a',
    ...base,
    requestFingerprint: OperatorOperationService.fingerprint(base.fingerprintInput),
    deviceId: null,
    status: 'succeeded',
    resultStep: 'roll_weight',
    resultRef: 'capture-a',
    httpStatus: 200,
    errorCode: null,
    reason: null,
    attempt: 1,
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

function setup(existing: unknown = null, previousFailure: unknown = null) {
  let createdRecord: unknown = null;
  const client = {
    operatorRollOperation: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(existing ?? createdRecord)),
      findFirst: jest.fn().mockResolvedValue(previousFailure),
      createMany: jest.fn().mockImplementation(({ data }) => {
        createdRecord = { id: 'new-op', ...data };
        return Promise.resolve({ count: 1 });
      }),
      create: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ id: 'new-op', ...data })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
  return { client, service: new OperatorOperationService() };
}

describe('OperatorOperationService', () => {
  it('claims a new operation with a canonical safe fingerprint', async () => {
    const { client, service } = setup();
    const result = await service.claim(client, base);

    expect(result).toEqual(expect.objectContaining({ kind: 'claimed', recoveryFromId: null }));
    expect(client.operatorRollOperation.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationKey: base.operationKey,
        requestFingerprint: OperatorOperationService.fingerprint({ kind: 'spool' }),
        status: 'in_progress',
        attempt: 1,
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
      }),
      skipDuplicates: true,
    });
  });

  it('keeps the physical lease beyond the maximum gateway timeout and finalization margin', () => {
    expect(OPERATOR_PHYSICAL_OPERATION_LEASE_MS).toBeGreaterThan(GATEWAY_COMMAND_TIMEOUT_MAX_MS);
    expect(
      OPERATOR_PHYSICAL_OPERATION_LEASE_MS - GATEWAY_COMMAND_TIMEOUT_MAX_MS,
    ).toBeGreaterThanOrEqual(30_000);
  });

  it('does not lease a transaction-only operation', async () => {
    const { client, service } = setup();

    await service.claim(client, {
      ...base,
      action: 'accept',
      fingerprintInput: {},
    });

    expect(client.operatorRollOperation.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'accept',
        attempt: 0,
        leaseToken: null,
        leaseExpiresAt: null,
      }),
      skipDuplicates: true,
    });
  });

  it('leases QR verification because scanner readiness and provenance are fenced', async () => {
    const { client, service } = setup();

    await service.claim(client, {
      ...base,
      action: 'qr_verify',
      expectedStep: 'qr_check',
      fingerprintInput: { matches: true },
    });

    expect(client.operatorRollOperation.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'qr_verify',
        attempt: 1,
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
      }),
      skipDuplicates: true,
    });
  });

  it('claims step back as an idempotent transaction-only operation', async () => {
    const { client, service } = setup();
    const input = {
      ...base,
      action: 'step_back' as const,
      expectedStep: 'qr_print',
      fingerprintInput: {},
    };

    await expect(service.claim(client, input)).resolves.toEqual(
      expect.objectContaining({ kind: 'claimed' }),
    );
    expect(client.operatorRollOperation.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'step_back',
        attempt: 0,
        leaseToken: null,
        leaseExpiresAt: null,
      }),
      skipDuplicates: true,
    });
  });

  it('blocks step back while a physical operation has an active lease', async () => {
    const { client, service } = setup();
    client.operatorRollOperation.findFirst.mockResolvedValueOnce({
      id: 'physical-operation-a',
    });

    await expect(
      service.assertNoPhysicalOperationInProgress(
        client,
        'line-a',
        new Date('2026-07-30T10:00:00.000Z'),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_PHYSICAL_OPERATION_IN_PROGRESS',
      }),
    });
  });

  it('allows step back when no active physical operation remains', async () => {
    const { client, service } = setup();
    client.operatorRollOperation.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.assertNoPhysicalOperationInProgress(
        client,
        'line-a',
        new Date('2026-07-30T10:00:00.000Z'),
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts the dedicated pre-print reweigh action in the operation journal', async () => {
    const { client, service } = setup();
    const input = {
      ...base,
      action: 'roll_reweigh' as const,
      expectedStep: 'qr_print',
      fingerprintInput: {},
    };

    await expect(service.claim(client, input)).resolves.toEqual(
      expect.objectContaining({ kind: 'claimed' }),
    );
    expect(client.operatorRollOperation.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'roll_reweigh', expectedStep: 'qr_print' }),
      skipDuplicates: true,
    });
  });

  it('canonicalizes object key order but refuses raw/QR fields', () => {
    expect(OperatorOperationService.fingerprint({ b: 2, a: 1 })).toBe(
      OperatorOperationService.fingerprint({ a: 1, b: 2 }),
    );
    expect(() => OperatorOperationService.fingerprint({ payload: 'forbidden' })).toThrow(
      'Unsafe operation fingerprint field',
    );
    expect(() => OperatorOperationService.fingerprint({ nested: { qrCode: 'forbidden' } })).toThrow(
      'Unsafe operation fingerprint field',
    );
  });

  it('replays the stored success without creating another operation', async () => {
    const existing = stored();
    const { client, service } = setup(existing);

    await expect(service.claim(client, base)).resolves.toEqual({
      kind: 'replay',
      operation: existing,
    });
    expect(client.operatorRollOperation.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['action', { action: 'roll_weight' }],
    ['line', { operatorRollLineId: 'line-b' }],
    ['actor', { actorId: 'operator-b' }],
    ['post', { postId: 'post-b' }],
    ['session', { postSessionId: 'session-b' }],
    ['fingerprint', { requestFingerprint: OperatorOperationService.fingerprint({ kind: 'roll' }) }],
  ])('rejects conflicting operation-key reuse by %s', async (_field, override) => {
    const { service, client } = setup(stored(override));
    await expect(service.claim(client, base)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPERATION_KEY_CONFLICT' }),
    });
  });

  it('returns a stable conflict while an identical operation is in progress', async () => {
    const { service, client } = setup(
      stored({
        status: 'in_progress',
        leaseToken: '88c962a9-e75a-4cc6-96f4-1b5d02f88c1b',
        leaseExpiresAt: new Date(Date.now() + OPERATOR_PHYSICAL_OPERATION_LEASE_MS),
      }),
    );
    await expect(service.claim(client, base)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPERATION_IN_PROGRESS' }),
    });
  });

  it('atomically reacquires an expired compatible physical operation with a new fencing token', async () => {
    const oldToken = '88c962a9-e75a-4cc6-96f4-1b5d02f88c1b';
    const expired = stored({
      status: 'in_progress',
      attempt: 1,
      leaseToken: oldToken,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    const { service, client } = setup(expired);
    let reacquired: unknown = null;
    client.operatorRollOperation.findUnique
      .mockResolvedValueOnce(expired)
      .mockImplementationOnce(() => Promise.resolve(reacquired));
    client.operatorRollOperation.updateMany.mockImplementationOnce(
      ({ data }: { data: { leaseToken: string; leaseExpiresAt: Date } }) => {
        reacquired = {
          ...expired,
          attempt: 2,
          leaseToken: data.leaseToken,
          leaseExpiresAt: data.leaseExpiresAt,
        };
        return Promise.resolve({ count: 1 });
      },
    );

    await expect(service.claim(client, base)).resolves.toEqual(
      expect.objectContaining({
        kind: 'claimed',
        operation: expect.objectContaining({
          id: expired.id,
          attempt: 2,
          leaseToken: expect.not.stringMatching(oldToken),
          leaseExpiresAt: expect.any(Date),
        }),
        recoveryFromId: expired.id,
      }),
    );
    expect(client.operatorRollOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: expired.id,
        status: 'in_progress',
        leaseToken: oldToken,
        leaseExpiresAt: { lte: expect.any(Date) },
      },
      data: {
        attempt: { increment: 1 },
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
      },
    });
  });

  it('never reclaims a legacy physical in-progress row without a fencing token', async () => {
    const { service, client } = setup(
      stored({ status: 'in_progress', leaseToken: null, leaseExpiresAt: null }),
    );

    await expect(service.claim(client, base)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_OPERATION_RECOVERY_UNAVAILABLE',
      }),
    });
    expect(client.operatorRollOperation.updateMany).not.toHaveBeenCalled();
  });

  it('classifies a concurrent operation-key winner by its stored identity', async () => {
    const { service, client } = setup();
    const winner = stored({ operatorRollLineId: 'line-b', status: 'in_progress' });
    client.operatorRollOperation.createMany.mockResolvedValue({ count: 0 });
    client.operatorRollOperation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);

    await expect(service.claim(client, base)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPERATION_KEY_CONFLICT' }),
    });
  });

  it('rethrows the saved device failure with its original safe status', async () => {
    const { service, client } = setup(
      stored({ status: 'failed', httpStatus: 503, errorCode: 'OPERATOR_SCALE_UNAVAILABLE' }),
    );
    await expect(service.claim(client, base)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('links a new retry to the latest failed operation for safe recovery audit', async () => {
    const { service, client } = setup(null, { id: 'failed-op' });
    await expect(service.claim(client, base)).resolves.toEqual(
      expect.objectContaining({ kind: 'claimed', recoveryFromId: 'failed-op' }),
    );
  });

  it('completes and fails only the current unexpired physical lease', async () => {
    const { service, client } = setup();
    const leaseToken = '88c962a9-e75a-4cc6-96f4-1b5d02f88c1b';
    await service.complete(
      client,
      'operation-a',
      {
        resultStep: 'roll_weight',
        resultRef: 'capture-a',
        httpStatus: 200,
      },
      leaseToken,
    );
    await service.fail(
      client,
      'operation-b',
      {
        httpStatus: 503,
        errorCode: 'OPERATOR_SCALE_UNAVAILABLE',
      },
      leaseToken,
    );
    expect(client.operatorRollOperation.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'operation-a',
        status: 'in_progress',
        leaseToken,
        leaseExpiresAt: { gt: expect.any(Date) },
      },
      data: expect.objectContaining({ status: 'succeeded', completedAt: expect.any(Date) }),
    });
    expect(client.operatorRollOperation.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'operation-b',
        status: 'in_progress',
        leaseToken,
        leaseExpiresAt: { gt: expect.any(Date) },
      },
      data: expect.objectContaining({ status: 'failed', completedAt: expect.any(Date) }),
    });
  });

  it('rejects completion, failure and binding by an obsolete fencing token', async () => {
    const { service, client } = setup();
    client.operatorRollOperation.updateMany.mockResolvedValue({ count: 0 });
    const staleToken = '88c962a9-e75a-4cc6-96f4-1b5d02f88c1b';

    await expect(
      service.complete(
        client,
        'operation-a',
        { resultStep: 'roll_weight', httpStatus: 200 },
        staleToken,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPERATION_LEASE_LOST' }),
    });
    await expect(
      service.fail(
        client,
        'operation-a',
        { httpStatus: 503, errorCode: 'OPERATOR_SCALE_UNAVAILABLE' },
        staleToken,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPERATION_LEASE_LOST' }),
    });
    await expect(
      service.bindDevice(client, 'operation-a', 'scale-a', staleToken),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_OPERATION_LEASE_LOST' }),
    });
  });

  it('terminalizes only the exact still-expired fencing token after scene rollback', async () => {
    const { service, client } = setup();
    const leaseToken = '88c962a9-e75a-4cc6-96f4-1b5d02f88c1b';
    const now = new Date('2026-07-23T10:00:00.000Z');

    await expect(
      service.settleExpired(
        client,
        'operation-a',
        leaseToken,
        {
          httpStatus: 409,
          errorCode: 'OPERATOR_STEP_CONFLICT',
        },
        now,
      ),
    ).resolves.toBe(true);
    expect(client.operatorRollOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'operation-a',
        status: 'in_progress',
        leaseToken,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: 'failed',
        resultStep: null,
        resultRef: null,
        httpStatus: 409,
        errorCode: 'OPERATOR_STEP_CONFLICT',
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
  });

  it('does not settle a lease already reacquired by another worker', async () => {
    const { service, client } = setup();
    client.operatorRollOperation.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.settleExpired(client, 'operation-a', '88c962a9-e75a-4cc6-96f4-1b5d02f88c1b', {
        httpStatus: 409,
        errorCode: 'OPERATOR_STEP_CONFLICT',
      }),
    ).resolves.toBe(false);
  });

  it('uses stable coded conflicts rather than adapter details', () => {
    expect(OperatorOperationService.conflict('OPERATOR_OPERATION_IN_PROGRESS')).toBeInstanceOf(
      ConflictException,
    );
  });
});
