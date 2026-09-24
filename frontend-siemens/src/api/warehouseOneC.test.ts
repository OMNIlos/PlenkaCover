import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, saveSession } from './authStorage';
import {
  fetchWarehouseRawMaterialsOneCPreview,
  pushWarehouseRawMaterialsToOneC,
} from './warehouse';

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  clearSession();
  saveSession({
    version: 1,
    token: 'warehouse-session-token',
    role: 'warehouse',
    serverRole: 'warehouse',
    userId: 'warehouse-1',
    displayName: 'Склад',
    expiresAt: '2026-07-18T00:00:00.000Z',
    passwordChangeRequired: false,
  });
});

afterEach(() => {
  clearSession();
  vi.unstubAllGlobals();
});

describe('pushWarehouseRawMaterialsToOneC', () => {
  it('loads the server-authoritative snapshot that the user must confirm', async () => {
    const preview = {
      snapshotHash: 'a'.repeat(64),
      count: 2,
      totalQty: 42,
      writeReady: true,
      readinessCode: 'ready',
      readinessMessage: 'Демо-1С готова к тестовой записи.',
      items: [
        { materialId: 'rm-1', qty: 40, unit: 'кг' },
        { materialId: 'rm-2', qty: 2, unit: 'кг' },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(response(preview));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWarehouseRawMaterialsOneCPreview()).resolves.toEqual(preview);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/raw-materials/onec-push-preview',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer warehouse-session-token' }),
      }),
    );
  });

  it('sends one authenticated POST and returns only the safe acknowledgement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        operationKey: '2c0190d9-4db0-49ff-8358-f6f0a393b44c',
        pushed: 2,
        count: 2,
        totalQty: 42,
        items: [
          { materialId: 'rm-1', qty: 40, unit: 'кг' },
          { materialId: 'rm-2', qty: 2, unit: 'кг' },
        ],
        snapshotHash: 'a'.repeat(64),
        replayed: false,
        ack: {
          accepted: true,
          count: 2,
          ref: '0000-000001',
          mode: 'http',
          documentCreated: true,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pushWarehouseRawMaterialsToOneC({
        operationKey: '2c0190d9-4db0-49ff-8358-f6f0a393b44c',
        snapshotHash: 'a'.repeat(64),
      }),
    ).resolves.toEqual({
      operationKey: '2c0190d9-4db0-49ff-8358-f6f0a393b44c',
      pushed: 2,
      count: 2,
      totalQty: 42,
      items: [
        { materialId: 'rm-1', qty: 40, unit: 'кг' },
        { materialId: 'rm-2', qty: 2, unit: 'кг' },
      ],
      snapshotHash: 'a'.repeat(64),
      replayed: false,
      ack: {
        accepted: true,
        count: 2,
        ref: '0000-000001',
        mode: 'http',
        documentCreated: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/raw-materials/push-to-1c',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer warehouse-session-token' }),
        body: JSON.stringify({
          operationKey: '2c0190d9-4db0-49ff-8358-f6f0a393b44c',
          snapshotHash: 'a'.repeat(64),
        }),
      }),
    );
  });

  it('does not retry an ambiguous write failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pushWarehouseRawMaterialsToOneC({
        operationKey: '2c0190d9-4db0-49ff-8358-f6f0a393b44c',
        snapshotHash: 'a'.repeat(64),
      }),
    ).rejects.toThrow('network failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
