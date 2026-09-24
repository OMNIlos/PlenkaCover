import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchDirectorWarehouseBusiness } from './director';
import { fetchDirectorPayrollPreview } from './directorPayroll';
import { demoDirectorPayrollPreview } from '../domain/fixtures/directorPayroll';

const warehousePage = {
  items: [
    {
      kind: 'client_order',
      id: 'order-1',
      templates: [
        {
          fingerprint: 'a'.repeat(64),
          filmType: 'термоусадочная плёнка',
          actualThicknessMicron: 35,
          accountingThicknessMicron: 40,
          widthMm: 500,
          plannedLengthM: 1_200,
          birka: 'белая',
          spoolType: '76 мм',
          plannedWeightKg: 19,
          recipeVersion: 'v3',
        },
      ],
      status: 'awaiting_shipment',
      orderNumber: 'ЗК-101',
      counterpartyName: 'Контур Пак',
    },
  ],
  page: 1,
  pageSize: 50,
  total: 1,
};

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('director live adapters', () => {
  it('validates the safe warehouse projection and forwards AbortSignal', async () => {
    const fetchMock = stubFetch(warehousePage);
    const controller = new AbortController();

    await expect(
      fetchDirectorWarehouseBusiness({}, { signal: controller.signal }),
    ).resolves.toEqual(warehousePage);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/director/performance/warehouse?page=1&pageSize=50',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('rejects a malformed warehouse projection instead of rendering it as an empty page', async () => {
    stubFetch({ ...warehousePage, items: [{ ...warehousePage.items[0], templates: 'missing' }] });

    await expect(fetchDirectorWarehouseBusiness()).rejects.toThrow('Некорректные данные склада');
  });

  it('validates the director payroll projection and forwards AbortSignal', async () => {
    const fetchMock = stubFetch(demoDirectorPayrollPreview);
    const controller = new AbortController();

    await expect(
      fetchDirectorPayrollPreview(
        { from: '2026-07-01', to: '2026-07-31' },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(demoDirectorPayrollPreview);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/director/payroll-preview?from=2026-07-01&to=2026-07-31',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('rejects malformed and internally inconsistent payroll totals', async () => {
    const malformed = structuredClone(demoDirectorPayrollPreview) as unknown as {
      summary: { operatorCount: unknown };
    };
    malformed.summary.operatorCount = '2';
    stubFetch(malformed);

    await expect(
      fetchDirectorPayrollPreview({ from: '2026-07-01', to: '2026-07-31' }),
    ).rejects.toThrow('Некорректный ответ расчёта зарплаты');

    const inconsistent = structuredClone(demoDirectorPayrollPreview);
    inconsistent.summary.payableAmountKopecks += 1;
    stubFetch(inconsistent);

    await expect(
      fetchDirectorPayrollPreview({ from: '2026-07-01', to: '2026-07-31' }),
    ).rejects.toThrow('Некорректный ответ расчёта зарплаты');
  });

  it('accepts a contract-valid unresolved row with only a partial operator identity', async () => {
    const response = structuredClone(demoDirectorPayrollPreview);
    response.unresolved[0]!.operatorName = null;
    response.operators[1]!.unresolvedFactCount = 0;
    stubFetch(response);

    await expect(
      fetchDirectorPayrollPreview({ from: '2026-07-01', to: '2026-07-31' }),
    ).resolves.toEqual(response);
  });
});
