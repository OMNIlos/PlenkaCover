import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSession, saveSession } from './authStorage';
import {
  createPayrollTariffOrder,
  fetchPayrollTariffOrder,
  fetchPayrollTariffOrders,
  parsePayrollTariffOrderList,
  parsePayrollTariffOrderReview,
  parsePayrollTariffOrderView,
  publishPayrollTariffOrder,
  reviewPayrollTariffOrder,
  updatePayrollTariffOrder,
  type ServerPayrollTariffMatrix,
} from './payrollTariffOrders';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_KEY = '22222222-2222-4222-8222-222222222222';

function matrix(): ServerPayrollTariffMatrix {
  return {
    schemaVersion: 1,
    ladders: {
      urp12h: [
        {
          maxInclusiveGrams: 750_000,
          primaryRateKopecksPerKg: 400,
          secondaryRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: 550,
          secondaryRateKopecksPerKg: 650,
        },
      ],
      urp24h: [
        {
          maxInclusiveGrams: 1_500_000,
          primaryRateKopecksPerKg: 400,
          secondaryRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: 550,
          secondaryRateKopecksPerKg: 650,
        },
      ],
      abc12h: [
        {
          maxInclusiveGrams: 1_300_000,
          standardRateKopecksPerKg: 450,
          blackWhiteRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: null,
          standardRateKopecksPerKg: 500,
          blackWhiteRateKopecksPerKg: 550,
        },
      ],
      abc24h: [
        {
          maxInclusiveGrams: 2_600_000,
          standardRateKopecksPerKg: 450,
          blackWhiteRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: null,
          standardRateKopecksPerKg: 500,
          blackWhiteRateKopecksPerKg: 550,
        },
      ],
    },
    specialRules: {
      thinRoll: {
        enabled: true,
        maxExclusiveGrams: 7_000,
        rateKopecksPerKg: 650,
      },
      alabuga: {
        enabled: true,
        machineFamily: 'abc_new',
        normalizedLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
        rateKopecksPerKg: 400,
      },
    },
  };
}

function order(status: 'draft' | 'published' = 'draft') {
  return {
    id: ORDER_ID,
    name: status === 'published' ? 'Приказ № 8-09/25' : 'Приказ № 9-08/26',
    effectiveFrom: status === 'published' ? '2025-09-29' : '2026-08-15',
    currency: 'RUB',
    status,
    revision: 3,
    createdAt: '2026-08-13T08:00:00.000Z',
    updatedAt: '2026-08-13T08:30:00.000Z',
    publishedAt: status === 'published' ? '2026-08-13T09:00:00.000Z' : null,
    matrix: matrix(),
    createdById: '33333333-3333-4333-8333-333333333333',
    updatedById: '33333333-3333-4333-8333-333333333333',
    publishedById:
      status === 'published' ? '33333333-3333-4333-8333-333333333333' : null,
  } as const;
}

function list() {
  const { matrix: _matrix, createdById: _created, updatedById: _updated, publishedById: _published, ...item } =
    order();
  return {
    items: [item],
    activeOrderId: ORDER_ID,
    latestPublishedOrderId: ORDER_ID,
    minimumPublishEffectiveFrom: '2026-08-14',
    timezone: 'Europe/Moscow',
    generatedAt: '2026-08-13T09:30:00.000Z',
  } as const;
}

function response(json: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  };
}

describe('payroll tariff order API', () => {
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('strictly parses version lists, details and a publishable review', () => {
    expect(parsePayrollTariffOrderList(list())).toEqual(list());
    expect(parsePayrollTariffOrderView(order())).toEqual(order());

    const review = {
      orderId: ORDER_ID,
      revision: 3,
      matrixHash: 'a'.repeat(64),
      minimumPublishEffectiveFrom: '2026-08-14',
      publishable: true,
      fieldErrors: [],
    };
    expect(parsePayrollTariffOrderReview(review)).toEqual(review);
  });

  it.each([
    ['unknown root key', { ...order(), rawPayload: { secret: true } }, parsePayrollTariffOrderView],
    [
      'malformed date',
      { ...order(), effectiveFrom: '2026-02-31' },
      parsePayrollTariffOrderView,
    ],
    [
      'negative rate',
      {
        ...order(),
        matrix: {
          ...matrix(),
          ladders: {
            ...matrix().ladders,
            urp12h: [
              {
                ...matrix().ladders.urp12h[0],
                primaryRateKopecksPerKg: -1,
              },
              matrix().ladders.urp12h[1],
            ],
          },
        },
      },
      parsePayrollTariffOrderView,
    ],
    [
      'malformed review hash',
      {
        orderId: ORDER_ID,
        revision: 3,
        matrixHash: 'not-a-hash',
        minimumPublishEffectiveFrom: '2026-08-14',
        publishable: true,
        fieldErrors: [],
      },
      parsePayrollTariffOrderReview,
    ],
  ])('rejects %s', (_label, value, parser) => {
    expect(() => parser(value)).toThrow('Некорректный ответ приказа по тарифам');
  });

  it('uses exact routes, methods and UUID-bearing mutation payloads', async () => {
    saveSession({
      version: 1,
      token: 'director-token',
      role: 'director',
      serverRole: 'director',
      userId: 'director-1',
      displayName: 'Директор',
      expiresAt: '2099-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const review = {
      orderId: ORDER_ID,
      revision: 3,
      matrixHash: 'b'.repeat(64),
      minimumPublishEffectiveFrom: '2026-08-14',
      publishable: true,
      fieldErrors: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/review')) return response(review);
      if (path === '/api/director/payroll-tariff-orders') {
        return init?.method === 'GET' ? response(list()) : response({ order: order(), replayed: false }, 201);
      }
      if (path.endsWith('/publish')) {
        return response({ order: order('published'), replayed: false }, 201);
      }
      if (init?.method === 'PATCH') return response({ order: order(), replayed: false });
      return response(order());
    });
    vi.stubGlobal('fetch', fetchMock);

    const draftInput = {
      operationKey: OPERATION_KEY,
      name: 'Приказ № 9-08/26',
      effectiveFrom: '2026-08-15',
      matrix: matrix(),
    };

    await fetchPayrollTariffOrders();
    await fetchPayrollTariffOrder(ORDER_ID);
    await createPayrollTariffOrder(draftInput);
    await updatePayrollTariffOrder(ORDER_ID, { ...draftInput, expectedRevision: 3 });
    await reviewPayrollTariffOrder(ORDER_ID, { expectedRevision: 3 });
    await publishPayrollTariffOrder(ORDER_ID, {
      operationKey: OPERATION_KEY,
      expectedRevision: 3,
      reviewedMatrixHash: 'b'.repeat(64),
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls.map(([path, init]) => [String(path), init?.method])).toEqual([
      ['/api/director/payroll-tariff-orders', 'GET'],
      [`/api/director/payroll-tariff-orders/${ORDER_ID}`, 'GET'],
      ['/api/director/payroll-tariff-orders', 'POST'],
      [`/api/director/payroll-tariff-orders/${ORDER_ID}`, 'PATCH'],
      [`/api/director/payroll-tariff-orders/${ORDER_ID}/review`, 'POST'],
      [`/api/director/payroll-tariff-orders/${ORDER_ID}/publish`, 'POST'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual(draftInput);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      ...draftInput,
      expectedRevision: 3,
    });
    expect(fetchMock.mock.calls.every(([, init]) =>
      (init?.headers as Record<string, string>).Authorization === 'Bearer director-token',
    )).toBe(true);
  });

  it('preserves structured server field errors and never retries a failed mutation', async () => {
    const fieldErrors = [
      {
        path: 'matrix.ladders.urp12h[0].primaryRateKopecksPerKg',
        code: 'integer',
        message: 'Укажите целые неотрицательные копейки',
      },
    ];
    const fetchMock = vi.fn(async () =>
      response(
        {
          code: 'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
          message: 'Проверьте тарифную матрицу',
          fieldErrors,
        },
        422,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createPayrollTariffOrder({
        operationKey: OPERATION_KEY,
        name: 'Приказ № 9-08/26',
        effectiveFrom: '2026-08-15',
        matrix: matrix(),
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
      details: { fieldErrors },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('marks malformed successful mutation responses as delivery-uncertain', async () => {
    const fetchMock = vi.fn(async () => response({ unexpected: true }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const draftInput = {
      operationKey: OPERATION_KEY,
      name: 'Приказ № 9-08/26',
      effectiveFrom: '2026-08-15',
      matrix: matrix(),
    };
    const operations = [
      () => createPayrollTariffOrder(draftInput),
      () => updatePayrollTariffOrder(ORDER_ID, { ...draftInput, expectedRevision: 3 }),
      () =>
        publishPayrollTariffOrder(ORDER_ID, {
          operationKey: OPERATION_KEY,
          expectedRevision: 3,
          reviewedMatrixHash: 'b'.repeat(64),
        }),
    ];

    for (const execute of operations) {
      await expect(execute()).rejects.toMatchObject({
        name: 'ApiResponseParseError',
        deliveryUncertain: true,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
