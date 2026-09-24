import { WarehouseOperationService } from './warehouse-operation.service';

const input = {
  operationKey: '123e4567-e89b-42d3-a456-426614174000',
  kind: 'receiving_scan' as const,
  taskId: 'task-1',
  scanRowId: 'row-1',
  rollCode: 'ROLL-1',
  actorId: 'user-1',
  sessionId: 'session-1',
  postId: 'post-1',
  deviceId: 'scanner-1',
  captureChannel: 'machine_post_gateway' as const,
  fingerprintInput: {},
};

describe('WarehouseOperationService', () => {
  it('expires a stale control-weight lease before a crash recovery attempt', async () => {
    const expiredAt = new Date('2026-07-17T10:00:00.000Z');
    const stale = {
      id: 'stale-operation',
      operationKey: '123e4567-e89b-42d3-a456-426614174001',
      kind: 'control_weight',
      taskId: 'task-1',
      scanRowId: 'row-1',
      rollCode: 'ROLL-1',
      actorId: 'user-1',
      sessionId: 'session-1',
      postId: 'post-1',
      deviceId: 'scale-1',
      captureChannel: 'machine_post_gateway',
      status: 'in_progress',
      leaseToken: '123e4567-e89b-42d3-a456-426614174002',
      leaseExpiresAt: expiredAt,
    };
    const client = {
      warehouseOperation: {
        findMany: jest.fn().mockResolvedValue([stale]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new WarehouseOperationService();

    await expect(
      service.expireStaleControlWeights(client as never, {
        taskId: 'task-1',
        scanRowId: 'row-1',
        now: new Date('2026-07-17T10:00:00.001Z'),
      }),
    ).resolves.toEqual([stale]);
    expect(client.warehouseOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'stale-operation',
        status: 'in_progress',
        leaseToken: stale.leaseToken,
        leaseExpiresAt: { lte: new Date('2026-07-17T10:00:00.001Z') },
      },
      data: {
        status: 'expired',
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: 'WAREHOUSE_CONTROL_WEIGHT_LEASE_EXPIRED',
        httpStatus: 503,
        completedAt: new Date('2026-07-17T10:00:00.001Z'),
      },
    });
  });

  it('claims through a duplicate-safe insert and never stores scanner payload', async () => {
    let record: Record<string, unknown> | null = null;
    const client = {
      warehouseOperation: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(record)),
        findFirst: jest.fn(),
        createMany: jest.fn().mockImplementation(({ data }) => {
          record = { id: 'op-1', safeResult: null, httpStatus: null, errorCode: null, ...data };
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const service = new WarehouseOperationService();

    await expect(service.claim(client as never, input)).resolves.toMatchObject({ kind: 'claimed' });
    const stored = client.warehouseOperation.createMany.mock.calls[0][0].data;
    expect(JSON.stringify(stored)).not.toContain('payload');
    expect(stored.captureChannel).toBe('machine_post_gateway');
    expect(stored.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('persists and exactly replays a browser-HID operation without a production post', async () => {
    const browserInput = {
      ...input,
      postId: null,
      deviceId: null,
      captureChannel: 'warehouse_browser_hid' as const,
    };
    const stored = {
      id: 'op-browser-1',
      ...browserInput,
      status: 'succeeded',
      requestFingerprint: WarehouseOperationService.fingerprint({}),
      safeResult: {},
      httpStatus: 200,
      errorCode: null,
    };
    const client = { warehouseOperation: { findUnique: jest.fn().mockResolvedValue(stored) } };
    const service = new WarehouseOperationService();

    await expect(service.claim(client as never, browserInput)).resolves.toMatchObject({
      kind: 'replay',
      operation: stored,
    });
    await expect(
      service.claim(client as never, {
        ...browserInput,
        captureChannel: 'warehouse_role_action',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_OPERATION_KEY_REUSED' }),
    });
  });

  it('rejects the same key when actor/object binding differs', async () => {
    const stored = {
      id: 'op-1',
      ...input,
      status: 'succeeded',
      deviceId: 'scanner-1',
      requestFingerprint: WarehouseOperationService.fingerprint({}),
      safeResult: {},
      httpStatus: 200,
      errorCode: null,
    };
    const client = { warehouseOperation: { findUnique: jest.fn().mockResolvedValue(stored) } };
    const service = new WarehouseOperationService();

    await expect(
      service.claim(client as never, { ...input, taskId: 'task-foreign' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_OPERATION_KEY_REUSED' }),
    });
  });

  it('binds a server-derived device once and permits an exact repeat', async () => {
    const stored = { id: 'op-1', status: 'in_progress', deviceId: 'scanner-1' };
    const client = {
      warehouseOperation: {
        updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue(stored),
      },
    };
    const service = new WarehouseOperationService();

    await expect(service.bindDevice(client as never, 'op-1', 'scanner-1')).resolves.toBeUndefined();
    await expect(service.bindDevice(client as never, 'op-1', 'scanner-1')).resolves.toBeUndefined();
    expect(client.warehouseOperation.updateMany).toHaveBeenCalledWith({
      where: { id: 'op-1', status: 'in_progress', deviceId: null },
      data: { deviceId: 'scanner-1' },
    });
  });

  it('links a fresh retry to the latest failed physical operation', async () => {
    let record: Record<string, unknown> | null = null;
    const client = {
      warehouseOperation: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(record)),
        findFirst: jest.fn().mockResolvedValue({ id: 'failed-op', attempt: 1 }),
        createMany: jest.fn().mockImplementation(({ data }) => {
          record = { id: 'op-2', safeResult: null, httpStatus: null, errorCode: null, ...data };
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const service = new WarehouseOperationService();

    await expect(service.claim(client as never, input)).resolves.toMatchObject({
      kind: 'claimed',
      recoveryFromId: 'failed-op',
    });
    expect(client.warehouseOperation.findFirst).toHaveBeenCalledWith({
      where: {
        kind: 'receiving_scan',
        scanRowId: 'row-1',
        status: { in: ['failed', 'expired'] },
      },
      orderBy: { completedAt: 'desc' },
      select: { id: true, attempt: true },
    });
    expect(client.warehouseOperation.createMany.mock.calls[0][0].data.attempt).toBe(2);
  });
});
