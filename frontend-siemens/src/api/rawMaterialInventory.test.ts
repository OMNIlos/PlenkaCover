import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSafeRawMaterialInventory, type SafeInventoryPage } from './rawMaterialInventory';

const page: SafeInventoryPage = {
  items: [
    {
      materialId: 'rm-1',
      materialName: 'ПВД 15803-020',
      category: 'primary',
      unit: 'кг',
      erpActualQty: 840,
      oneCQty: 800,
      reservedQty: null,
      availableQty: null,
      expectedUsageQty: null,
      openBigBagQty: 170,
      recycledQty: null,
      sourceStatus: 'partial',
      source: {
        snapshotId: 'snapshot-1',
        sourceKind: '1C',
        capturedAt: '2026-07-27T07:55:00.000Z',
        importedAt: '2026-07-27T08:00:00.000Z',
      },
      conflicts: [
        {
          code: 'INCOMPLETE_DEDUCTIONS',
          message: 'Резерв и ожидаемый расход не подтверждены durable-фактами.',
        },
      ],
      updatedAt: '2026-07-27T08:00:00.000Z',
    },
  ],
  nextCursor: 'next+cursor',
  sourceUnavailable: false,
  generatedAt: '2026-07-27T09:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safe raw-material inventory API', () => {
  it('sends every production search/filter through the authenticated server query', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => page,
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      fetchSafeRawMaterialInventory('production', {
        q: 'ПВД 70/30',
        category: 'primary',
        sourceStatus: 'partial',
        availability: 'unavailable',
        cursor: 'next+cursor',
        limit: 25,
      }),
    ).resolves.toEqual(page);

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/production/raw-materials?q=%D0%9F%D0%92%D0%94+70%2F30&category=primary&sourceStatus=partial&availability=unavailable&cursor=next%2Bcursor&limit=25',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses the director projection route and strips undeclared raw fields', async () => {
    const unsafeServerPage = {
      ...page,
      rawPayload: { token: 'page-secret' },
      items: page.items.map((item) => ({
        ...item,
        rawPayload: { token: 'item-secret' },
        source: {
          ...item.source,
          rawPayload: 'source-secret',
        },
      })),
    };
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => unsafeServerPage,
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchSafeRawMaterialInventory('director', { limit: 20 });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/director/raw-materials?limit=20',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual(page);
    expect(JSON.stringify(result)).not.toMatch(/rawPayload|secret/u);
  });

  it('uses the dedicated safe warehouse inventory route instead of the physical adjustment API', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => page,
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(fetchSafeRawMaterialInventory('warehouse', { limit: 25 })).resolves.toEqual(page);

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/warehouse/raw-material-inventory?limit=25',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('normalizes omitted nullable DTO fields without fabricating quantities', async () => {
    const sparseItem = {
      materialId: 'rm-sparse',
      materialName: 'Вторичное сырье',
      sourceStatus: 'erp_only',
      conflicts: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          items: [sparseItem],
          sourceUnavailable: false,
          generatedAt: '2026-07-27T09:00:00.000Z',
        }),
      })),
    );

    await expect(fetchSafeRawMaterialInventory('production')).resolves.toEqual({
      items: [
        {
          ...sparseItem,
          category: null,
          unit: null,
          erpActualQty: null,
          oneCQty: null,
          reservedQty: null,
          availableQty: null,
          expectedUsageQty: null,
          openBigBagQty: null,
          recycledQty: null,
          source: null,
          updatedAt: null,
        },
      ],
      nextCursor: null,
      sourceUnavailable: false,
      generatedAt: '2026-07-27T09:00:00.000Z',
    });
  });
});
