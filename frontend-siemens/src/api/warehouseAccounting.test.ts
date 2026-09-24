import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchWarehouseAccountingMovements,
  fetchWarehouseAccountingStock,
} from './warehouseAccounting';

afterEach(() => vi.unstubAllGlobals());

describe('warehouse accounting API', () => {
  it('loads and sanitizes account 41.01 stock for the requested scope', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            nomenclatureExternalId: 'material-1',
            name: 'Скотч',
            kind: 'Материалы',
            unit: 'шт',
            quantity: 12,
            balanceStatus: 'positive',
            capturedAt: '2026-07-29T08:00:00.000Z',
            importedAt: '2026-07-29T08:05:00.000Z',
            stale: false,
            physicalTraceability: 'unavailable',
            amount: 999,
            rawPayload: { secret: true },
          },
        ],
        nextCursor: 'next/cursor',
        accountCode: '41.01',
        scope: 'consumables',
        generatedAt: '2026-07-29T08:06:00.000Z',
        rawPayload: { secret: true },
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchWarehouseAccountingStock({
      scope: 'consumables',
      q: 'скотч',
      cursor: 'next/cursor',
      limit: 25,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/warehouse/accounting-stock?scope=consumables&q=%D1%81%D0%BA%D0%BE%D1%82%D1%87&cursor=next%2Fcursor&limit=25',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.items[0]).toMatchObject({ name: 'Скотч', quantity: 12 });
    expect(JSON.stringify(result)).not.toMatch(/amount|rawPayload|secret/u);
  });

  it('loads safe posted 1C shipment movements without financial fields', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            externalId: 'shipment-1',
            documentNumber: 'РТУ-42',
            documentDate: '2026-07-28T09:30:00.000Z',
            direction: 'outbound',
            sourceLabel: 'Отгрузка по 1С',
            capturedAt: '2026-07-29T08:00:00.000Z',
            importedAt: '2026-07-29T08:05:00.000Z',
            physicalTraceability: 'unavailable',
            lines: [{ lineNumber: 1, name: 'Рукав 500', quantity: 4, unit: 'кг' }],
            total: 5000,
            counterpartyExternalId: 'secret-counterparty',
          },
        ],
        nextCursor: null,
        generatedAt: '2026-07-29T08:06:00.000Z',
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchWarehouseAccountingMovements({ q: 'РТУ-42', limit: 20 });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/warehouse/accounting-movements?q=%D0%A0%D0%A2%D0%A3-42&limit=20',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.items[0]?.lines[0]).toEqual({
      lineNumber: 1,
      name: 'Рукав 500',
      quantity: 4,
      unit: 'кг',
    });
    expect(JSON.stringify(result)).not.toMatch(/total|counterparty|secret/u);
  });
});
