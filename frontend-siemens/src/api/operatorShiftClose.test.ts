import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiResponseParseError } from './client';
import { closeOperatorShift, parseOperatorShiftCloseResult } from './operator';

const OPERATION_KEY = '11111111-1111-4111-8111-111111111111';

function validResult() {
  return {
    balance: {
      producedKg: 12,
      defectKg: 1,
      expectedUsageKg: 12,
      actualUsageKg: 12,
      deviationPercent: 0,
      status: 'ok',
    },
    problemId: null,
    releasedRollIds: ['ROLL-3'],
    closingPayroll: {
      sessionId: 'session-1',
      shiftId: 'shift-1',
      status: 'partial',
      appliedTariffOrders: [
        {
          id: 'payroll-tariff-order-8-09-25-2025-09-29',
          name: 'Приказ № 8-09/25',
          effectiveFrom: '2025-09-29',
          currency: 'RUB',
        },
      ],
      summary: {
        payableAmountKopecks: 3_100,
        payableKg: 10,
        machineShiftCount: 1,
        unresolvedKg: 2,
        unresolvedFactCount: 1,
        excludedDefectKg: 1,
        excludedDefectRollCount: 1,
      },
      breakdown: [
        {
          id: 'row-primary',
          tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
          shiftId: 'shift-1',
          shiftLabel: 'Смена 1',
          shiftDate: '2026-08-08',
          postId: 'post-1',
          postCode: 'POST-1',
          postName: 'УРП 1',
          machineFamily: 'urp',
          shiftDuration: '12h',
          shiftOutputKg: 12,
          payableKg: 4,
          rateKopecksPerKg: 400,
          amountKopecks: 1_600,
          tariffRule: 'primary',
          basisLabel: 'Основное сырьё',
          materialClass: 'primary',
          filmClass: null,
          specialCustomer: false,
        },
        {
          id: 'row-thin',
          tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
          shiftId: 'shift-1',
          shiftLabel: 'Смена 1',
          shiftDate: '2026-08-08',
          postId: 'post-1',
          postCode: 'POST-1',
          postName: 'УРП 1',
          machineFamily: 'urp',
          shiftDuration: '12h',
          shiftOutputKg: 12,
          payableKg: 6,
          rateKopecksPerKg: 250,
          amountKopecks: 1_500,
          tariffRule: 'thin_roll',
          basisLabel: 'Тонкий рулон',
          materialClass: null,
          filmClass: null,
          specialCustomer: false,
        },
      ],
      unresolved: [
        {
          rollId: 'roll-2',
          rollCode: 'ROLL-2',
          orderId: 'order-1',
          orderNumber: 'ORD-1',
          producedAt: '2026-08-08T10:00:00.000Z',
          netKg: 2,
          shiftId: 'shift-1',
          shiftLabel: 'Смена 1',
          postId: 'post-1',
          postCode: 'POST-1',
          postName: 'УРП 1',
          reasons: ['material_class_unresolved'],
        },
      ],
    },
  };
}

describe('operator shift close payroll API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts one operation key and preserves every authoritative tariff row', async () => {
    const response = validResult();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => response,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      closeOperatorShift({
        operationKey: OPERATION_KEY,
        bags: [{ bigBagId: 'bag-1', endKg: 10 }],
      }),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/operator/shift/close',
      expect.objectContaining({
        body: JSON.stringify({
          operationKey: OPERATION_KEY,
          bags: [{ bigBagId: 'bag-1', endKg: 10 }],
        }),
      }),
    );
    expect(response.closingPayroll.breakdown.map((row) => row.rateKopecksPerKg)).toEqual([
      400, 250,
    ]);
  });

  it('classifies a malformed committed 2xx projection as delivery-uncertain', async () => {
    const response = validResult();
    response.closingPayroll.summary.payableAmountKopecks = 99_999;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => response,
      })),
    );

    await expect(
      closeOperatorShift({
        operationKey: OPERATION_KEY,
        bags: [{ bigBagId: 'bag-1', endKg: 10 }],
      }),
    ).rejects.toMatchObject({
      name: 'ApiResponseParseError',
      status: 200,
      deliveryUncertain: true,
    } satisfies Partial<ApiResponseParseError>);
  });

  it('rejects an unknown unresolved reason', () => {
    const response = validResult();
    response.closingPayroll.unresolved[0]!.reasons = ['invented_reason'];
    expect(() => parseOperatorShiftCloseResult(response)).toThrow(
      'Некорректный итог закрытия смены',
    );
  });

  it('rejects a pending balance in the durable close response', async () => {
    const response = validResult();
    response.balance.status = 'pending';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => response,
      })),
    );

    expect(() => parseOperatorShiftCloseResult(response)).toThrow(
      'Некорректный итог закрытия смены',
    );
    await expect(
      closeOperatorShift({
        operationKey: OPERATION_KEY,
        bags: [{ bigBagId: 'bag-1', endKg: 10 }],
      }),
    ).rejects.toMatchObject({
      name: 'ApiResponseParseError',
      status: 200,
      deliveryUncertain: true,
    } satisfies Partial<ApiResponseParseError>);
  });

  it('rejects totals that do not equal the authoritative rows', () => {
    const response = validResult();
    response.closingPayroll.summary.payableAmountKopecks = 99_999;
    expect(() => parseOperatorShiftCloseResult(response)).toThrow(
      'Некорректный итог закрытия смены',
    );
  });

  it('rejects an identity leak and contradictory complete status', () => {
    const response = validResult() as ReturnType<typeof validResult> & {
      operatorId?: string;
    };
    response.operatorId = 'operator-b';
    response.closingPayroll.status = 'complete';
    expect(() => parseOperatorShiftCloseResult(response)).toThrow(
      'Некорректный итог закрытия смены',
    );
  });

  it('rejects raw payload fields, negative money and noncanonical reason order', () => {
    const raw = validResult();
    Object.assign(raw.closingPayroll.breakdown[0]!, { rawPayload: { source: 'device' } });
    expect(() => parseOperatorShiftCloseResult(raw)).toThrow('Некорректный итог закрытия смены');

    const negative = validResult();
    negative.closingPayroll.breakdown[0]!.amountKopecks = -1;
    expect(() => parseOperatorShiftCloseResult(negative)).toThrow(
      'Некорректный итог закрытия смены',
    );

    const unordered = validResult();
    unordered.closingPayroll.unresolved[0]!.reasons = [
      'material_class_unresolved',
      'shift_not_closed',
    ];
    expect(() => parseOperatorShiftCloseResult(unordered)).toThrow(
      'Некорректный итог закрытия смены',
    );
  });

  it('rejects payroll rows attributed to a different shift', () => {
    const foreignBreakdown = validResult();
    for (const row of foreignBreakdown.closingPayroll.breakdown) row.shiftId = 'shift-other';
    expect(() => parseOperatorShiftCloseResult(foreignBreakdown)).toThrow(
      'Некорректный итог закрытия смены',
    );

    const foreignUnresolved = validResult();
    foreignUnresolved.closingPayroll.unresolved[0]!.shiftId = 'shift-other';
    expect(() => parseOperatorShiftCloseResult(foreignUnresolved)).toThrow(
      'Некорректный итог закрытия смены',
    );
  });
});
