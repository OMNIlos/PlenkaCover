import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchWarehouseDefectBags,
  receiveWarehouseDefectBag,
  shipWarehouseDefectBag,
} from './warehouse';

const OPERATION_KEY = '11111111-1111-4111-8111-111111111111';
const QR_PAYLOAD = `bbt_${'a'.repeat(64)}`;

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe('warehouse defect-bag API', () => {
  it.each([
    ['receiving', '/api/warehouse/defect-bags?mode=receiving'],
    ['shipping', '/api/warehouse/defect-bags?mode=shipping'],
  ] as const)('loads the %s queue', async (mode, path) => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWarehouseDefectBags(mode);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(path);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'GET' }));
  });

  it.each([
    [receiveWarehouseDefectBag, '/api/warehouse/defect-bags/receipts'],
    [shipWarehouseDefectBag, '/api/warehouse/defect-bags/shipments'],
  ] as const)('posts a scanned QR and operation key to %s', async (mutation, path) => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: 'defect-bag-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await mutation(QR_PAYLOAD, OPERATION_KEY);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(path);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      operationKey: OPERATION_KEY,
      payload: QR_PAYLOAD,
    });
  });
});
