import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BusinessPerformanceWorkspace } from './BusinessPerformanceWorkspace';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function controlResponse() {
  return {
    range: {
      timezone: 'Europe/Moscow',
      requested: { from: '2026-07-09', to: '2026-08-07' },
      effective: {
        fromUtc: '2026-07-08T21:00:00.000Z',
        toExclusiveUtc: '2026-08-07T21:00:00.000Z',
      },
      bucket: 'day',
      generatedAt: '2026-08-07T12:00:00.000Z',
    },
    source: {
      kind: 'platform_runtime',
      status: 'ready',
      freshness: 'fresh',
      generatedAt: '2026-08-07T12:00:00.000Z',
    },
    summary: {
      invoicedAmount: 503_000,
      paidAmount: 1_000,
      receivableAmount: 502_000,
      overdueAmount: 0,
      producedKg: 61.95,
      producedRolls: 3,
      defectKg: 7.75,
      defectRollCount: 1,
      returnedSpoolCount: 0,
      warehouseAcceptedRolls: 2,
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
      asOfDate: '2026-08-07',
      periods: [],
    },
  };
}

function renderedText(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll((node) => typeof node.children[0] === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))
    .join(' ');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Business control evidence tables', () => {
  it('loads the shift balance and BigBag dropdowns through the shared business projection', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/commercial/performance/control/shift-balances?')) {
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (url.startsWith('/api/commercial/performance/control/big-bags?')) {
        return jsonResponse({ items: [], nextCursor: null });
      }
      return jsonResponse(controlResponse());
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessPerformanceWorkspace section="Контроль" />);
    });

    const text = renderedText(renderer);
    expect(text).toContain('Баланс смен · Показано: 0');
    expect(text).toContain('Факты BigBag · Показано: 0');
    expect(
      renderer.root.findByProps({ 'aria-label': 'Операционные таблицы контроля' }).props.className,
    ).toContain('director-production-analytics');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/shift-balances?'))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/big-bags?'))).toBe(true);
  });

  it('queries the server on every typed character in both tables', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/control/shift-balances?') || url.includes('/control/big-bags?')) {
        return jsonResponse({ items: [], nextCursor: null });
      }
      return jsonResponse(controlResponse());
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessPerformanceWorkspace section="Контроль" />);
    });

    const searchOf = (tableId: string) => renderer.root.findByProps({ id: `${tableId}-search` });

    for (const [tableId, path] of [
      ['shift', '/control/shift-balances?'],
      ['big-bag', '/control/big-bags?'],
    ] as const) {
      const before = fetchMock.mock.calls.filter(([url]) => String(url).includes(`${path}`)).length;

      // Type "БЕ" one character at a time, with no pause between the keystrokes.
      await act(async () => {
        searchOf(tableId).props.onChange({ currentTarget: { value: 'Б' } });
      });
      await act(async () => {
        searchOf(tableId).props.onChange({ currentTarget: { value: 'БЕ' } });
      });

      const requests = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes(path));
      expect(requests.length).toBeGreaterThan(before + 1);
      expect(requests.some((url) => url.includes(`q=${encodeURIComponent('Б')}`))).toBe(true);
      expect(requests.some((url) => url.includes(`q=${encodeURIComponent('БЕ')}`))).toBe(true);
    }
  });
});
