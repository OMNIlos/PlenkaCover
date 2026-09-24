import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchDirectorPayrollPreview, parseDirectorPayrollPreview } from './directorPayroll';
import type { ServerPayrollTariffMatrix } from './payrollTariffOrders';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

function matrix(rate = 400): ServerPayrollTariffMatrix {
  return {
    schemaVersion: 1,
    ladders: {
      urp12h: [
        { maxInclusiveGrams: null, primaryRateKopecksPerKg: rate, secondaryRateKopecksPerKg: 500 },
      ],
      urp24h: [
        { maxInclusiveGrams: null, primaryRateKopecksPerKg: rate, secondaryRateKopecksPerKg: 500 },
      ],
      abc12h: [
        { maxInclusiveGrams: null, standardRateKopecksPerKg: 450, blackWhiteRateKopecksPerKg: 500 },
      ],
      abc24h: [
        { maxInclusiveGrams: null, standardRateKopecksPerKg: 450, blackWhiteRateKopecksPerKg: 500 },
      ],
    },
    specialRules: {
      thinRoll: { enabled: true, maxExclusiveGrams: 7_000, rateKopecksPerKg: 650 },
      alabuga: {
        enabled: true,
        machineFamily: 'abc_new',
        normalizedLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
        rateKopecksPerKg: 400,
      },
    },
  };
}

function preview() {
  return {
    status: 'complete',
    appliedTariffOrders: [
      {
        id: FIRST_ID,
        name: 'Приказ № 8-09/25',
        effectiveFrom: '2025-09-29',
        currency: 'RUB',
        matrix: matrix(),
      },
      {
        id: SECOND_ID,
        name: 'Приказ № 9-08/26',
        effectiveFrom: '2026-08-15',
        currency: 'RUB',
        matrix: matrix(800),
      },
    ],
    range: {
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
      timezone: 'Europe/Moscow',
      generatedAt: '2026-08-31T18:00:00.000Z',
    },
    summary: {
      payableAmountKopecks: 120_000,
      payableKg: 200,
      machineShiftCount: 2,
      operatorCount: 1,
      unresolvedKg: 0,
      unresolvedFactCount: 0,
      excludedDefectKg: 0,
      excludedDefectRollCount: 0,
    },
    operators: [
      {
        operatorId: 'operator-1',
        operatorName: 'Оператор 1',
        payableKg: 200,
        amountKopecks: 120_000,
        machineShiftCount: 2,
        unresolvedFactCount: 0,
      },
    ],
    breakdown: [
      {
        id: 'row-1',
        tariffOrderId: FIRST_ID,
        operatorId: 'operator-1',
        operatorName: 'Оператор 1',
        shiftId: 'shift-1',
        shiftLabel: 'Смена 1',
        shiftDate: '2026-08-14',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'УРП',
        machineFamily: 'urp',
        shiftDuration: '12h',
        shiftOutputKg: 100,
        payableKg: 100,
        rateKopecksPerKg: 400,
        amountKopecks: 40_000,
        tariffRule: 'primary',
        basisLabel: 'Первичное сырьё',
        materialClass: 'primary',
        filmClass: null,
        specialCustomer: false,
      },
      {
        id: 'row-2',
        tariffOrderId: SECOND_ID,
        operatorId: 'operator-1',
        operatorName: 'Оператор 1',
        shiftId: 'shift-2',
        shiftLabel: 'Смена 2',
        shiftDate: '2026-08-15',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'УРП',
        machineFamily: 'urp',
        shiftDuration: '12h',
        shiftOutputKg: 100,
        payableKg: 100,
        rateKopecksPerKg: 800,
        amountKopecks: 80_000,
        tariffRule: 'primary',
        basisLabel: 'Первичное сырьё',
        materialClass: 'primary',
        filmClass: null,
        specialCustomer: false,
      },
    ],
    unresolved: [],
  } as const;
}

describe('director payroll API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a period calculated with two versioned orders and keeps row attribution', () => {
    const value = preview();

    expect(parseDirectorPayrollPreview(value)).toEqual(value);
    expect(parseDirectorPayrollPreview(value).breakdown.map((row) => row.tariffOrderId)).toEqual([
      FIRST_ID,
      SECOND_ID,
    ]);
  });

  it('accepts a closed machine shift with zero output without hiding the whole payroll', () => {
    const value = structuredClone(preview()) as unknown as Record<string, unknown> & {
      summary: { machineShiftCount: number };
      operators: Array<{ machineShiftCount: number }>;
      breakdown: Array<Record<string, unknown>>;
    };
    value.breakdown.push({
      ...value.breakdown[0],
      id: 'row-zero-output',
      shiftId: 'shift-zero-output',
      shiftLabel: 'Смена без выработки',
      shiftOutputKg: 0,
      payableKg: 0,
      amountKopecks: 0,
    });
    value.summary.machineShiftCount = 3;
    value.operators[0]!.machineShiftCount = 3;

    expect(parseDirectorPayrollPreview(value)).toEqual(value);
  });

  it('rejects a row that references an order absent from appliedTariffOrders', () => {
    const value = structuredClone(preview()) as unknown as {
      breakdown: Array<{ tariffOrderId: string }>;
    };
    value.breakdown[1]!.tariffOrderId = '33333333-3333-4333-8333-333333333333';

    expect(() => parseDirectorPayrollPreview(value)).toThrow('Некорректный ответ расчёта зарплаты');
  });

  it('forwards abort and returns the strict response without selecting a tariff locally', async () => {
    const value = preview();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => value }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchDirectorPayrollPreview(
        { from: '2026-08-01', to: '2026-08-31' },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(value);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/director/payroll-preview?from=2026-08-01&to=2026-08-31',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
