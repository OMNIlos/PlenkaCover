import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchFinanceRawMaterials } from './financeRawMaterials';

afterEach(() => vi.unstubAllGlobals());

describe('finance raw-material API', () => {
  it('keeps server-valued BigBag identities separate and preserves missing facts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'bag-1',
            code: 'BB-001',
            material: 'ПВД',
            supplier: 'ООО Гранула',
            batchCode: 'LOT-01',
            receivedAt: '2026-08-01T08:00:00.000Z',
            initialWeightKg: '12.345',
            purchasePricePerKg: '25.00',
            initialValue: '308.63',
            currentWeightKg: '8.100',
            measuredAt: '2026-08-10T10:00:00.000Z',
            currentValue: '202.50',
            consumedWeightKg: '4.245',
            consumedValue: '106.13',
          },
          {
            id: 'bag-2',
            code: 'BB-002',
            material: 'ПВД',
            supplier: null,
            batchCode: 'LOT-02',
            receivedAt: null,
            initialWeightKg: null,
            purchasePricePerKg: null,
            initialValue: null,
            currentWeightKg: null,
            measuredAt: null,
            currentValue: null,
            consumedWeightKg: null,
            consumedValue: null,
          },
        ],
      }),
    );

    const result = await fetchFinanceRawMaterials();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'bag-1',
      supplier: 'ООО Гранула',
      receivedAt: '2026-08-01T08:00:00.000Z',
      initialValue: '308.63',
    });
    expect(result[1]).toMatchObject({
      id: 'bag-2',
      supplier: null,
      receivedAt: null,
      initialValue: null,
    });
    expect(fetch).toHaveBeenCalledWith('/api/finance/raw-materials', expect.any(Object));
  });

  it('fails closed on a binary-float or incomplete financial projection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'bag-1',
            code: 'BB-001',
            material: 'ПВД',
            initialValue: 308.625,
          },
        ],
      }),
    );

    await expect(fetchFinanceRawMaterials()).rejects.toThrow(
      'Некорректный ответ финансового учёта сырья.',
    );
  });
});
