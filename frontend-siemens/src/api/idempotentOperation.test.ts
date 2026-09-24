import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './client';
import { AUTH_OPERATION_KEYS_STORAGE_KEY, clearSession, saveSession } from './authStorage';
import { IdempotentOperationGate, isDeliveryUncertain } from './idempotentOperation';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('IdempotentOperationGate', () => {
  it('reuses a durable operation key after a full page reload', async () => {
    vi.stubGlobal('localStorage', createStorage());
    saveSession({
      version: 1,
      token: 'operator-token',
      role: 'operator',
      serverRole: 'operator',
      userId: 'operator-1',
      displayName: 'Оператор',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const failedRequest = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      new IdempotentOperationGate(createKey, true).start('operator:roll-1:print', failedRequest),
    ).rejects.toThrow('Failed to fetch');

    const reloadedRequest = vi.fn().mockResolvedValue(undefined);
    await expect(
      new IdempotentOperationGate(createKey, true).start('operator:roll-1:print', reloadedRequest),
    ).resolves.toBeUndefined();

    expect(failedRequest).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(reloadedRequest).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(createKey).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(AUTH_OPERATION_KEYS_STORAGE_KEY)).toBeNull();
  });

  it('never reuses a durable operation key for another account', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const session = {
      version: 1 as const,
      token: 'operator-token',
      role: 'operator' as const,
      serverRole: 'operator' as const,
      userId: 'operator-1',
      displayName: 'Оператор 1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    };
    saveSession(session);
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const gate = new IdempotentOperationGate(createKey, true);

    await expect(
      gate.start(
        'operator:roll-1:print',
        vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      ),
    ).rejects.toThrow('Failed to fetch');

    saveSession({
      ...session,
      token: 'other-token',
      userId: 'operator-2',
      displayName: 'Оператор 2',
    });
    const request = vi.fn().mockResolvedValue(undefined);
    await expect(gate.start('operator:roll-1:print', request)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'keeps the new account journal when an old request settles (failed=%s)',
    async (failed) => {
      vi.stubGlobal('localStorage', createStorage());
      const session = {
        version: 1 as const,
        token: 'old',
        role: 'operator' as const,
        serverRole: 'operator' as const,
        userId: 'old-user',
        displayName: null,
        expiresAt: '2030-01-01T00:00:00.000Z',
        passwordChangeRequired: false,
      };
      saveSession(session);
      const gate = new IdempotentOperationGate(() => crypto.randomUUID(), true);
      let finish!: () => void;
      const oldRequest = gate
        .start(
          'old-print',
          () =>
            new Promise<void>((resolve, reject) => {
              finish = () => (failed ? reject(new ApiError(400, 'Invalid')) : resolve());
            }),
        )!
        .catch(() => undefined);
      saveSession({ ...session, token: 'new', userId: 'new-user' });
      await expect(
        gate.start('new-print', async () => {
          throw new TypeError('network');
        }),
      ).rejects.toThrow('network');
      const journal = localStorage.getItem(AUTH_OPERATION_KEYS_STORAGE_KEY);
      expect(journal).toContain('new-print');
      finish();
      await oldRequest;
      expect(localStorage.getItem(AUTH_OPERATION_KEYS_STORAGE_KEY)).toBe(journal);
    },
  );

  it.each([false, true])(
    'preserves a newer UUID for the same user and intent (failed=%s)',
    async (failed) => {
      vi.stubGlobal('localStorage', createStorage());
      const session = {
        version: 1 as const,
        token: 'old',
        role: 'operator' as const,
        serverRole: 'operator' as const,
        userId: 'same-user',
        displayName: null,
        expiresAt: '2030-01-01T00:00:00.000Z',
        passwordChangeRequired: false,
      };
      saveSession(session);
      let finish!: () => void;
      const oldRequest = new IdempotentOperationGate(() => crypto.randomUUID(), true)
        .start(
          'print',
          () =>
            new Promise<void>((resolve, reject) => {
              finish = () => (failed ? reject(new ApiError(400, 'Invalid')) : resolve());
            }),
        )!
        .catch(() => undefined);
      clearSession();
      saveSession({ ...session, token: 'new' });
      const execute = vi.fn().mockRejectedValue(new TypeError('network'));
      await expect(
        new IdempotentOperationGate(() => crypto.randomUUID(), true).start('print', execute),
      ).rejects.toThrow('network');
      const journal = localStorage.getItem(AUTH_OPERATION_KEYS_STORAGE_KEY);
      finish();
      await oldRequest;
      expect(localStorage.getItem(AUTH_OPERATION_KEYS_STORAGE_KEY)).toBe(journal);
      const retry = vi.fn().mockResolvedValue(undefined);
      await new IdempotentOperationGate(() => crypto.randomUUID(), true).start('print', retry);
      expect(retry).toHaveBeenCalledWith(execute.mock.calls[0][0]);
    },
  );

  it('expires a durable operation key after one day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T08:00:00.000Z'));
    vi.stubGlobal('localStorage', createStorage());
    saveSession({
      version: 1,
      token: 'operator-token',
      role: 'operator',
      serverRole: 'operator',
      userId: 'operator-1',
      displayName: 'Оператор',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');

    await expect(
      new IdempotentOperationGate(createKey, true).start(
        'operator:roll-1:print',
        vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      ),
    ).rejects.toThrow('Failed to fetch');

    vi.setSystemTime(new Date('2026-09-01T08:00:00.001Z'));
    const request = vi.fn().mockResolvedValue(undefined);
    await expect(
      new IdempotentOperationGate(createKey, true).start('operator:roll-1:print', request),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it('rejects a tampered durable operation key at the browser boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T08:00:00.000Z'));
    vi.stubGlobal('localStorage', createStorage());
    saveSession({
      version: 1,
      token: 'operator-token',
      role: 'operator',
      serverRole: 'operator',
      userId: 'operator-1',
      displayName: 'Оператор',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    localStorage.setItem(
      AUTH_OPERATION_KEYS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        userId: 'operator-1',
        keys: {
          'operator:roll-1:print': {
            operationKey: 'tampered-key',
            createdAt: Date.now(),
          },
        },
      }),
    );
    const request = vi.fn().mockResolvedValue(undefined);

    await expect(
      new IdempotentOperationGate(() => '33333333-3333-4333-8333-333333333333', true).start(
        'operator:roll-1:print',
        request,
      ),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');
  });

  it('reuses the same operation key after an uncertain network failure', async () => {
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const gate = new IdempotentOperationGate(createKey);
    const execute = vi
      .fn<(operationKey: string) => Promise<void>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(undefined);

    await expect(gate.start('print:roll-1', execute)).rejects.toThrow('Failed to fetch');
    await expect(gate.start('print:roll-1', execute)).resolves.toBeUndefined();

    expect(execute.mock.calls.map(([key]) => key)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it('starts a new intent after a definitive API response', async () => {
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const gate = new IdempotentOperationGate(createKey);
    const execute = vi
      .fn<(operationKey: string) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(409, 'conflict'))
      .mockResolvedValueOnce(undefined);

    await expect(gate.start('scan:roll-1', execute)).rejects.toThrow('conflict');
    await expect(gate.start('scan:roll-1', execute)).resolves.toBeUndefined();

    expect(execute.mock.calls.map(([key]) => key)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it.each([408, 500, 502, 503, 504])(
    'reuses the same key after an ambiguous HTTP %s response',
    async (status) => {
      const createKey = vi
        .fn()
        .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
        .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
      const gate = new IdempotentOperationGate(createKey);
      const execute = vi
        .fn<(operationKey: string) => Promise<void>>()
        .mockRejectedValueOnce(new ApiError(status, 'ambiguous'))
        .mockResolvedValueOnce(undefined);

      await expect(gate.start('print:roll-1', execute)).rejects.toThrow('ambiguous');
      await expect(gate.start('print:roll-1', execute)).resolves.toBeUndefined();

      expect(execute.mock.calls.map(([key]) => key)).toEqual([
        '11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111',
      ]);
      expect(createKey).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'OPERATOR_OPERATION_IN_PROGRESS',
    'OPERATOR_DEFECT_DELIVERY_UNKNOWN',
    'POST_DEVICE_DELIVERY_UNKNOWN',
  ])('reuses the same key after an ambiguous API code %s', async (code) => {
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const gate = new IdempotentOperationGate(createKey);
    const execute = vi
      .fn<(operationKey: string) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(409, 'ambiguous', code))
      .mockResolvedValueOnce(undefined);

    await expect(gate.start('defect:roll-1', execute)).rejects.toThrow('ambiguous');
    await expect(gate.start('defect:roll-1', execute)).resolves.toBeUndefined();

    expect(execute.mock.calls.map(([key]) => key)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    'OPERATOR_DEVICE_BINDING_UNAVAILABLE',
    'DEFECT_BAG_PRINT_FAILED',
    'OPERATOR_DEVICE_NOT_READY',
    'OPERATOR_SCALE_UNAVAILABLE',
    'OPERATOR_PRINTER_UNAVAILABLE',
    'OPERATOR_WEIGHT_FINALIZATION_FAILED',
    'POST_NOT_FOUND',
    'POST_NOT_ACTIVE',
    'POST_NOT_COMMISSIONED',
    'POST_AGENT_OFFLINE',
    'POST_AGENT_HEARTBEAT_STALE',
    'GATEWAY_AGENT_UPGRADE_REQUIRED',
    'GATEWAY_AGENT_UNSUPPORTED',
    'POST_CAPABILITY_MISSING',
    'POST_DEVICE_BINDING_UNAVAILABLE',
    'POST_DEVICE_NOT_READY',
    'POST_DEVICE_HEARTBEAT_STALE',
    'POST_DEVICE_PROBE_STALE',
  ])('starts a new key after the backend stored terminal failure %s', async (code) => {
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const gate = new IdempotentOperationGate(createKey);
    const execute = vi
      .fn<(operationKey: string) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(503, 'Операция завершилась отказом.', code))
      .mockResolvedValueOnce(undefined);

    await expect(gate.start('defect:roll-1', execute)).rejects.toThrow(
      'Операция завершилась отказом.',
    );
    await expect(gate.start('defect:roll-1', execute)).resolves.toBeUndefined();

    expect(execute.mock.calls.map(([key]) => key)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('retains the key after a lease-lost response because another attempt may own the outcome', async () => {
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const gate = new IdempotentOperationGate(createKey);
    const execute = vi
      .fn<(operationKey: string) => Promise<void>>()
      .mockRejectedValueOnce(
        new ApiError(409, 'Срок операции истёк.', 'OPERATOR_OPERATION_LEASE_LOST'),
      )
      .mockResolvedValueOnce(undefined);

    await expect(gate.start('defect:roll-1', execute)).rejects.toThrow('Срок операции истёк.');
    await expect(gate.start('defect:roll-1', execute)).resolves.toBeUndefined();

    expect(execute.mock.calls.map(([key]) => key)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it('classifies known terminal and uncertain operator outcomes explicitly', () => {
    expect(
      isDeliveryUncertain(new ApiError(503, 'Весы недоступны.', 'OPERATOR_SCALE_UNAVAILABLE')),
    ).toBe(false);
    expect(
      isDeliveryUncertain(
        new ApiError(503, 'Привязка отсутствует.', 'OPERATOR_DEVICE_BINDING_UNAVAILABLE'),
      ),
    ).toBe(false);
    expect(
      isDeliveryUncertain(
        new ApiError(409, 'Операция перехвачена.', 'OPERATOR_OPERATION_LEASE_LOST'),
      ),
    ).toBe(true);
    expect(isDeliveryUncertain(new ApiError(503, 'Неизвестный сбой.'))).toBe(true);
  });

  it('reports unavailable secure UUID generation as a rejected operation', async () => {
    const gate = new IdempotentOperationGate(() => {
      throw new Error('UUID unavailable');
    });

    await expect(gate.start('scan:roll-1', vi.fn())).rejects.toThrow('UUID unavailable');
  });

  it('does not start the same intent twice while its request is pending', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const gate = new IdempotentOperationGate(() => '11111111-1111-4111-8111-111111111111');
    const execute = vi.fn().mockReturnValue(pending);

    const first = gate.start('weight:roll-1', execute);
    const duplicate = gate.start('weight:roll-1', execute);

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    resolve();
    await first;
  });

  it('serializes different physical intents without sharing their retry UUIDs', async () => {
    let resolveReweigh!: () => void;
    const reweighPending = new Promise<void>((done) => {
      resolveReweigh = done;
    });
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const gate = new IdempotentOperationGate(createKey);
    const reweigh = vi.fn().mockReturnValue(reweighPending);
    const print = vi.fn().mockResolvedValue(undefined);

    const first = gate.start('reweigh:roll-1', reweigh, 'physical:roll-1');
    const conflicting = gate.start('print:roll-1', print, 'physical:roll-1');

    expect(first).not.toBeNull();
    expect(conflicting).toBeNull();
    expect(print).not.toHaveBeenCalled();

    resolveReweigh();
    await first;
    await expect(gate.start('print:roll-1', print, 'physical:roll-1')).resolves.toBeUndefined();

    expect(reweigh).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(print).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
  });
});
