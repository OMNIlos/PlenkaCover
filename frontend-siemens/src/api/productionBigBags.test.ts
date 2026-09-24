import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchProductionBigBagSummary,
  parseProductionBigBagSummary,
  type ProductionBigBagSummary,
} from './productionBigBags';

const summary: ProductionBigBagSummary = {
  counts: {
    total: 4,
    inUse: 1,
    idle: 3,
    notRequired: 1,
  },
  bags: [
    {
      id: 'bag-1',
      code: 'BB-01',
      material: 'ПВД Первичное',
      materialDefinitionId: 'material-primary',
      status: 'in_use',
      currentKg: 420,
      classification: 'in_use',
    },
    {
      id: 'bag-2',
      code: 'BB-02',
      material: 'ПВД Вторичное',
      materialDefinitionId: 'material-secondary',
      status: 'available',
      currentKg: 180,
      classification: 'idle_required',
    },
    {
      id: 'bag-3',
      code: 'BB-03',
      material: 'ПВД Айка',
      materialDefinitionId: 'material-aika',
      status: 'available',
      currentKg: 210,
      classification: 'idle_not_required',
    },
    {
      id: 'bag-legacy',
      code: 'BB-LEGACY',
      material: 'Старое сырьё',
      materialDefinitionId: null,
      status: 'available',
      currentKg: 100,
      classification: 'idle_unclassified',
    },
  ],
  returnCandidates: [
    {
      id: 'bag-3',
      code: 'BB-03',
      material: 'ПВД Айка',
      materialDefinitionId: 'material-aika',
      status: 'available',
      currentKg: 210,
      classification: 'idle_not_required',
    },
  ],
  generatedAt: '2026-08-03T12:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('production Big-Bag summary API', () => {
  it('parses the exact safe role-level projection', () => {
    expect(parseProductionBigBagSummary(structuredClone(summary))).toEqual(
      summary,
    );
  });

  it.each([
    { ...summary, rawPayload: 'unsafe' },
    {
      ...summary,
      bags: [{ ...summary.bags[0], scanToken: `bbt_${'a'.repeat(64)}` }],
    },
    { ...summary, counts: { ...summary.counts, idle: 99 } },
    {
      ...summary,
      returnCandidates: [summary.bags[3]],
    },
  ])('rejects malformed or unsafe summaries', (value) => {
    expect(() => parseProductionBigBagSummary(value)).toThrow(
      /сводка Big-Bag/iu,
    );
  });

  it('loads the role-level summary from the canonical endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(summary), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProductionBigBagSummary()).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/production/big-bags/summary',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
