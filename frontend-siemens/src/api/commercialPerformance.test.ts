import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCommercialPerformanceControl,
  fetchCommercialPerformanceFinance,
  fetchCommercialPerformanceProduction,
  fetchCommercialPerformanceWarehouse,
} from './commercialPerformance';

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const source = {
  kind: 'platform_runtime',
  status: 'ready',
  freshness: 'fresh',
  generatedAt: '2026-07-28T12:00:00.000Z',
};

function emptyPage() {
  return { items: [], nextCursor: null, source };
}

function emptyControl() {
  return {
    range: {
      timezone: 'Europe/Moscow',
      requested: { from: '2026-07-01', to: '2026-07-31' },
      effective: {
        fromUtc: '2026-06-30T21:00:00.000Z',
        toExclusiveUtc: '2026-07-31T21:00:00.000Z',
      },
      bucket: 'day',
      generatedAt: '2026-07-28T12:00:00.000Z',
    },
    source,
    summary: {
      invoicedAmount: 0,
      paidAmount: 0,
      receivableAmount: 0,
      overdueAmount: 0,
      producedKg: 0,
      producedRolls: 0,
      defectKg: 0,
      defectRollCount: 0,
      returnedSpoolCount: 0,
      warehouseAcceptedRolls: 0,
    },
    productionSeries: [],
    productionQualitySeries: [],
    accountingProduction: {
      source: {
        sourceKind: '1C',
        label: '1С · Отчет производства за смену',
        latestImportedAt: null,
        latestDocumentDate: null,
        stale: false,
      },
      coverage: {
        documentCount: 0,
        excludedOutputLineCount: 0,
        excludedMaterialLineCount: 0,
      },
      productionSeries: [],
      materialSeries: [],
    },
    commercialApplications: {
      definition: 'submitted',
      asOfDate: '2026-07-31',
      periods: [],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('commercial performance API boundary', () => {
  it('uses only the dedicated commercial endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(response(String(input).includes('/control?') ? emptyControl() : emptyPage())),
    );
    vi.stubGlobal('fetch', fetchMock);
    const range = { from: '2026-07-01', to: '2026-07-31' };

    await fetchCommercialPerformanceControl({ ...range, bucket: 'day' });
    await fetchCommercialPerformanceFinance(range);
    await fetchCommercialPerformanceProduction(range);
    await fetchCommercialPerformanceWarehouse(range);

    const paths = fetchMock.mock.calls.map(([path]) => String(path));
    expect(paths).toEqual([
      '/api/commercial/performance/control?from=2026-07-01&to=2026-07-31&bucket=day',
      '/api/commercial/performance/finance?from=2026-07-01&to=2026-07-31&limit=20',
      '/api/commercial/performance/production?from=2026-07-01&to=2026-07-31&limit=20',
      '/api/commercial/performance/warehouse?from=2026-07-01&to=2026-07-31&limit=20',
    ]);
    expect(paths.join(' ')).not.toContain('/api/director');
  });

  it('passes pagination as an opaque cursor without adding mutation options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(emptyPage()));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCommercialPerformanceFinance({
      from: '2026-07-01',
      to: '2026-07-31',
      cursor: 'opaque+/=',
      limit: 40,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/performance/finance' +
        '?from=2026-07-01&to=2026-07-31&limit=40&cursor=opaque%2B%2F%3D',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
