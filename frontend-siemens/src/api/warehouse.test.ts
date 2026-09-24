import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './client';
import { fetchWarehouseFinishedStock, warehouseScanErrorMessage } from './warehouse';

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function lastRequestUrl() {
  const call = vi.mocked(fetch).mock.calls.at(-1);
  if (!call) throw new Error('Запрос готовой продукции не был выполнен.');
  return String(call[0]);
}

afterEach(() => vi.unstubAllGlobals());

describe('warehouse finished-stock API', () => {
  it('requests a lifecycle bucket and normalizes its safe stock projection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: [
            {
              id: 'roll-processed-1',
              rollCode: 'RES-001',
              batchCode: 'BATCH-2026-08',
              weightKg: 38.25,
              recipe: 'ПВД 70/30',
              specification: '80 × 1 200',
              ageDays: 2,
              processedAt: '2026-08-06T09:00:00.000Z',
            },
          ],
          summary: {
            totalCount: 3,
            totalWeightKg: 114.75,
            pageCount: 1,
            pageWeightKg: 38.25,
          },
          nextCursor: null,
        }),
      ),
    );

    const page = await fetchWarehouseFinishedStock({ bucket: 'processed' });

    expect(lastRequestUrl()).toContain('bucket=processed');
    expect(lastRequestUrl()).not.toContain('availability=');
    expect(page.summary.totalWeightKg).toBe(114.75);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].processedAt).toBe('2026-08-06T09:00:00.000Z');
  });

  it('fails closed for malformed lifecycle summary and processing timestamps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: [
            {
              id: 'roll-processed-1',
              rollCode: 'RES-001',
              batchCode: 'BATCH-2026-08',
              weightKg: 38.25,
              recipe: 'ПВД 70/30',
              specification: '80 × 1 200',
              ageDays: 2,
              processedAt: 42,
            },
          ],
          summary: {
            totalCount: 3,
            totalWeightKg: '114.75',
            pageCount: 1,
            pageWeightKg: 38.25,
          },
          nextCursor: null,
        }),
      ),
    );

    const page = await fetchWarehouseFinishedStock();

    expect(page.summary.totalWeightKg).toBe(0);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].processedAt).toBeNull();
  });
});


it('explains invalid QR without hiding a business refusal or losing the network error', () => {
  expect(
    warehouseScanErrorMessage(
      new ApiError(400, 'qrPayload must match /^[a-z0-9]+$/ regular expression'),
    ),
  ).toBe('Неверный формат QR. Считайте код с этикетки платформы.');
  expect(
    warehouseScanErrorMessage(new ApiError(409, 'Рулон уже принят', 'ROLL_ALREADY_RECEIVED')),
  ).toBe('Рулон уже принят');
  expect(warehouseScanErrorMessage(new TypeError('Failed to fetch'))).toBe(
    'Не удалось связаться с сервером. Проверьте связь и повторите скан.',
  );
});
