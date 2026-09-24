import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSession, saveSession } from './authStorage';
import { fetchOperatorPayroll } from './operatorPayroll';

function validEmptyPayrollResponse() {
  return {
    status: 'empty',
    appliedTariffOrders: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Приказ № 8-09/25',
      effectiveFrom: '2025-09-29',
      currency: 'RUB',
    }],
    range: {
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
      timezone: 'Europe/Moscow',
      generatedAt: '2026-08-06T00:00:00.000Z',
    },
    summary: {
      payableAmountKopecks: 0,
      payableKg: 0,
      machineShiftCount: 0,
      unresolvedKg: 0,
      unresolvedFactCount: 0,
      excludedDefectKg: 0,
      excludedDefectRollCount: 0,
    },
    breakdown: [],
    unresolved: [],
  };
}

describe('operator payroll API', () => {
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('calls the self endpoint without an operator-id parameter', async () => {
    saveSession({
      version: 1,
      token: 'operator-token',
      role: 'operator',
      serverRole: 'operator',
      userId: 'operator-a',
      displayName: 'Анна',
      expiresAt: '2099-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const response = {
      status: 'empty',
      appliedTariffOrders: [{
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Приказ № 8-09/25',
        effectiveFrom: '2025-09-29',
        currency: 'RUB',
      }],
      range: {
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
        timezone: 'Europe/Moscow',
        generatedAt: '2026-08-06T00:00:00.000Z',
      },
      summary: {
        payableAmountKopecks: 0,
        payableKg: 0,
        machineShiftCount: 0,
        unresolvedKg: 0,
        unresolvedFactCount: 0,
        excludedDefectKg: 0,
        excludedDefectRollCount: 0,
      },
      breakdown: [],
      unresolved: [],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => response,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOperatorPayroll({ from: '2026-08-01', to: '2026-08-31' })).resolves.toEqual(
      response,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/operator/payroll?from=2026-08-01&to=2026-08-31',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer operator-token' }),
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('operator-a');
  });

  it('rejects a response that contains an operator identity field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'empty',
          appliedTariffOrders: [],
          range: {},
          summary: {},
          breakdown: [{ operatorId: 'operator-b' }],
          unresolved: [],
        }),
      })),
    );

    await expect(fetchOperatorPayroll({ from: '2026-08-01', to: '2026-08-31' })).rejects.toThrow(
      'Некорректный ответ расчёта зарплаты',
    );
  });

  it.each([
    [
      'top level',
      (response: ReturnType<typeof validEmptyPayrollResponse>) => ({
        ...response,
        operatorId: 'operator-b',
      }),
    ],
    [
      'applied tariff order',
      (response: ReturnType<typeof validEmptyPayrollResponse>) => ({
        ...response,
        appliedTariffOrders: [
          { ...response.appliedTariffOrders[0], rawPayload: { source: 'private' } },
        ],
      }),
    ],
    [
      'range',
      (response: ReturnType<typeof validEmptyPayrollResponse>) => ({
        ...response,
        range: { ...response.range, operatorName: 'Анна' },
      }),
    ],
  ])('rejects unknown identity/raw fields at %s', async (_label, mutate) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => mutate(validEmptyPayrollResponse()),
      })),
    );

    await expect(fetchOperatorPayroll({ from: '2026-08-01', to: '2026-08-31' })).rejects.toThrow(
      'Некорректный ответ расчёта зарплаты',
    );
  });

  it('forwards an abort signal to the payroll HTTP request', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const fetchWithOptions = fetchOperatorPayroll as (
      query: { from: string; to: string },
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;

    void fetchWithOptions({ from: '2026-08-01', to: '2026-08-31' }, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/operator/payroll?from=2026-08-01&to=2026-08-31',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
