import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadBusinessOperationalProblem,
  loadBusinessOperationalProblems,
  loadBusinessPerformanceSection,
  loadBusinessProductionRolls,
  parseRollProductionCost,
  resolveBusinessOperationalProblem,
} from './businessPerformance';

const SOURCE = {
  kind: 'platform_runtime',
  status: 'ready',
  freshness: 'fresh',
  generatedAt: '2026-08-07T01:00:00.000Z',
} as const;

const CONTROL = {
  range: {
    timezone: 'Europe/Moscow',
    requested: { from: '2026-08-01', to: '2026-08-07' },
    effective: {
      fromUtc: '2026-07-31T21:00:00.000Z',
      toExclusiveUtc: '2026-08-07T21:00:00.000Z',
    },
    bucket: 'week',
    generatedAt: '2026-08-07T01:00:00.000Z',
  },
  source: SOURCE,
  summary: {
    invoicedAmount: 10_000,
    paidAmount: 5_000,
    receivableAmount: 5_000,
    overdueAmount: 0,
    producedKg: 40,
    producedRolls: 1,
    defectKg: 0,
    defectRollCount: 0,
    returnedSpoolCount: 0,
    warehouseAcceptedRolls: 1,
  },
  productionSeries: [
    {
      bucketStartDate: '2026-08-04',
      rollCount: 1,
      producedKg: 40,
    },
  ],
  productionQualitySeries: [
    {
      id: 'day:2026-08-04',
      bucketStartDate: '2026-08-04',
      producedRollCount: 1,
      producedKg: 40,
      defectRecordCount: 0,
      defectiveRollCount: 0,
      verifiedDefectKg: 0,
      unverifiedDefectCount: 0,
      returnedSpoolCount: 0,
    },
  ],
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
} as const;

const FINANCE_ITEM = {
  id: 'finance-1',
  orderNumber: 'A-5',
  counterpartyName: 'Контур',
  invoiceStatus: 'issued',
  paymentStatus: 'partial',
  paymentPlanKind: 'half_split',
  paymentPlanLabel: '50/50',
  invoicedAmount: 10_000,
  paidAmount: 5_000,
  remainingAmount: 5_000,
  nextConfirmedDueAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-07T01:00:00.000Z',
} as const;

const PRODUCTION_ITEM = {
  id: 'production-1',
  orderNumber: 'A-5',
  counterpartyName: 'Контур Пак',
  productionStatus: 'active',
  lifecycleStatus: 'in_production',
  createdAt: '2026-08-01T08:00:00.000Z',
  completedAt: null,
  plannedRollCount: 2,
  completedRollCount: 1,
  plannedKg: 80,
  actualKg: 40,
  defectKg: 0,
  defectRollCount: 0,
  returnedSpoolCount: 0,
  updatedAt: '2026-08-07T01:00:00.000Z',
} as const;

const WAREHOUSE_ITEM = {
  id: 'warehouse-1',
  orderNumber: 'A-5',
  warehouseCoverageStatus: 'partially_covered',
  shipmentStatus: 'not_shipped',
  readyRollCount: 1,
  reservedRollCount: 0,
  acceptedRollCount: 1,
  shippedRollCount: 0,
  updatedAt: '2026-08-07T01:00:00.000Z',
} as const;

const COMPLETE_ACTUAL_COST = {
  kind: 'actual_snapshot',
  status: 'complete',
  calculationVersion: 'production-cost-v1',
  snapshotId: 'cost-snapshot-1',
  version: 2,
  producedAt: '2026-08-07T00:30:00.000Z',
  closedAt: '2026-08-07T01:00:00.000Z',
  createdAt: '2026-08-07T01:00:01.000Z',
  basis: { kind: 'actual', weightGrams: 42_300 },
  materialAmountKopecks: 30_000,
  spoolAmountKopecks: 9_000,
  payrollAmountKopecks: 4_000,
  additionalAmountKopecks: 500,
  totalAmountKopecks: 43_500,
  totalKopecksPerKg: 1_028,
  unresolvedReasons: [],
} as const;

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function page(items: readonly unknown[]) {
  return {
    items,
    nextCursor: 'opaque+/=',
    source: SOURCE,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('business performance API boundary', () => {
  it.each([
    [
      'planned preview',
      {
        kind: 'planned_preview',
        status: 'partial',
        calculationVersion: 'production-cost-v1',
        basis: { kind: 'planned', weightGrams: 41_200 },
        materialAmountKopecks: 21_000,
        spoolAmountKopecks: null,
        payrollAmountKopecks: 3_000,
        additionalAmountKopecks: 0,
        totalAmountKopecks: null,
        totalKopecksPerKg: null,
        unresolvedReasons: ['spool_price_unresolved'],
      },
    ],
    ['actual snapshot', COMPLETE_ACTUAL_COST],
    [
      'actual pending',
      {
        kind: 'actual_pending',
        status: 'pending',
        calculationVersion: 'production-cost-v1',
        basis: { kind: 'actual', weightGrams: null },
        materialAmountKopecks: null,
        spoolAmountKopecks: null,
        payrollAmountKopecks: null,
        additionalAmountKopecks: 0,
        totalAmountKopecks: null,
        totalKopecksPerKg: null,
        unresolvedReasons: ['weight_unresolved'],
      },
    ],
  ] as const)('accepts and safely projects the %s branch', (_label, cost) => {
    const projected = parseRollProductionCost({
      ...cost,
      rawSources: [{ deviceId: 'must-not-leak' }],
    });

    expect(projected).toEqual(cost);
    expect(projected).not.toHaveProperty('rawSources');
  });

  it('rejects a missing required roll-production cost', () => {
    expect(() => parseRollProductionCost(undefined)).toThrow(
      'Некорректные данные бизнес-показателей',
    );
  });

  it('retains range, bucket, limit and opaque cursor semantics for all four sections', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/control?')) return response(CONTROL);
      if (path.includes('/finance?')) return response(page([FINANCE_ITEM]));
      if (path.includes('/production?')) return response(page([PRODUCTION_ITEM]));
      return response(page([WAREHOUSE_ITEM]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const range = { from: '2026-08-01', to: '2026-08-07' };
    await loadBusinessPerformanceSection('Контроль', { ...range, bucket: 'week' });
    await loadBusinessPerformanceSection('Финансы', {
      ...range,
      cursor: 'finance+/=',
      limit: 41,
    });
    await loadBusinessPerformanceSection('Производство', {
      ...range,
      cursor: 'production+/=',
      limit: 42,
    });
    await loadBusinessPerformanceSection('Склад', {
      ...range,
      cursor: 'warehouse+/=',
      limit: 43,
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/commercial/performance/control?from=2026-08-01&to=2026-08-07&bucket=week',
      '/api/commercial/performance/finance' +
        '?from=2026-08-01&to=2026-08-07&limit=41&cursor=finance%2B%2F%3D',
      '/api/commercial/performance/production' +
        '?from=2026-08-01&to=2026-08-07&limit=42&cursor=production%2B%2F%3D',
      '/api/commercial/performance/warehouse' +
        '?from=2026-08-01&to=2026-08-07&limit=43&cursor=warehouse%2B%2F%3D',
    ]);
  });

  it('validates the payment policy classification without inferring a fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          page([
            {
              ...FINANCE_ITEM,
              actorId: 'must-not-leak',
              rawPayload: { stages: [5_000, 5_000] },
            },
          ]),
        ),
      ),
    );

    const snapshot = await loadBusinessPerformanceSection('Финансы', {
      from: '2026-08-01',
      to: '2026-08-07',
    });

    expect(snapshot).toEqual({
      section: 'Финансы',
      data: page([FINANCE_ITEM]),
    });
    expect(snapshot.data.items[0]).not.toHaveProperty('actorId');
    expect(snapshot.data.items[0]).not.toHaveProperty('rawPayload');
  });

  it('propagates abort signals and projects only safe roll and problem fields', async () => {
    const rollSignal = new AbortController().signal;
    const problemSignal = new AbortController().signal;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 'dispatch-1',
              rollName: 'Рукав 60 мкм',
              rollCode: 'ROLL-1',
              orderNumber: 'A-5',
              parameters: {
                filmType: 'Рукав',
                actualThicknessUm: 60,
                accountingThicknessUm: 58,
                widthMm: 1_700,
                plannedLengthM: 275,
                weightKg: 42.3,
              },
              operatorName: 'Оператор 1',
              machineName: 'Экструдер 1',
              priority: 2,
              status: 'completed',
              lifecycleStatus: 'warehouse_delivered',
              createdAt: '2026-08-06T08:00:00.000Z',
              completedAt: '2026-08-07T01:00:00.000Z',
              weights: {
                plannedNetKg: 42,
                actualNetKg: 42.3,
                actualGrossKg: 44.1,
                deviationKg: 0.3,
              },
              productionCost: {
                ...COMPLETE_ACTUAL_COST,
                rawSources: [{ deviceId: 'must-not-leak' }],
              },
              postId: 'must-not-leak',
              rawPayload: { weight: 42.3 },
            },
          ],
          nextCursor: 'roll-next',
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 'problem-1',
              kind: 'weight_deviation',
              status: 'resolved',
              label: 'Перевес рулона',
              createdAt: '2026-08-07T01:00:00.000Z',
              orderId: 'order-5',
              orderNumber: 'A-5',
              rollCode: 'ROLL-1',
              machineName: null,
              reason: 'Фактический вес выше плана',
              sessionId: 'must-not-leak',
              detail: { warehouseOperationId: 'must-not-leak' },
            },
          ],
          nextCursor: null,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const rolls = await loadBusinessProductionRolls(
      'production/id',
      { cursor: 'roll+/=', limit: 25 },
      { signal: rollSignal },
    );
    const problems = await loadBusinessOperationalProblems(
      { filter: 'all', cursor: 'problem+/=', limit: 30 },
      { signal: problemSignal },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/commercial/performance/production/production%2Fid/rolls?limit=25&cursor=roll%2B%2F%3D',
      expect.objectContaining({ method: 'GET', signal: rollSignal }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/commercial/performance/problems?filter=all&limit=30&cursor=problem%2B%2F%3D',
      expect.objectContaining({ method: 'GET', signal: problemSignal }),
    );
    expect(rolls.items[0]).not.toHaveProperty('postId');
    expect(rolls.items[0]).not.toHaveProperty('rawPayload');
    expect(rolls.items[0].lifecycleStatus).toBe('warehouse_delivered');
    expect(rolls.items[0]).toHaveProperty('productionCost', COMPLETE_ACTUAL_COST);
    expect(rolls.items[0].productionCost).not.toHaveProperty('rawSources');
    expect(problems.items[0]).toEqual({
      id: 'problem-1',
      kind: 'weight_deviation',
      status: 'resolved',
      label: 'Перевес рулона',
      createdAt: '2026-08-07T01:00:00.000Z',
      orderId: 'order-5',
      orderNumber: 'A-5',
      rollCode: 'ROLL-1',
      machineName: null,
      reason: 'Фактический вес выше плана',
    });
    expect(problems.items[0]).not.toHaveProperty('sessionId');
    expect(problems.items[0]).not.toHaveProperty('detail');
  });

  it.each([
    ['unknown cost discriminator', { ...COMPLETE_ACTUAL_COST, kind: 'estimated_snapshot' }],
    ['unsafe money', { ...COMPLETE_ACTUAL_COST, totalAmountKopecks: Number.MAX_SAFE_INTEGER + 1 }],
    [
      'partial cost carrying a credible total',
      {
        ...COMPLETE_ACTUAL_COST,
        status: 'partial',
        totalAmountKopecks: 43_500,
        totalKopecksPerKg: null,
        unresolvedReasons: ['spool_price_unresolved'],
      },
    ],
    [
      'complete cost carrying unresolved reasons',
      {
        ...COMPLETE_ACTUAL_COST,
        unresolvedReasons: ['spool_price_unresolved'],
      },
    ],
    [
      'partial cost without unresolved reasons',
      {
        ...COMPLETE_ACTUAL_COST,
        status: 'partial',
        spoolAmountKopecks: null,
        totalAmountKopecks: null,
        totalKopecksPerKg: null,
        unresolvedReasons: [],
      },
    ],
    [
      'unknown unresolved reason',
      {
        ...COMPLETE_ACTUAL_COST,
        status: 'partial',
        spoolAmountKopecks: null,
        totalAmountKopecks: null,
        totalKopecksPerKg: null,
        unresolvedReasons: ['spool_cost_missing'],
      },
    ],
    [
      'duplicate unresolved reason',
      {
        ...COMPLETE_ACTUAL_COST,
        status: 'partial',
        spoolAmountKopecks: null,
        totalAmountKopecks: null,
        totalKopecksPerKg: null,
        unresolvedReasons: ['spool_price_unresolved', 'spool_price_unresolved'],
      },
    ],
    [
      'noncanonical unresolved reason order',
      {
        ...COMPLETE_ACTUAL_COST,
        status: 'partial',
        spoolAmountKopecks: null,
        totalAmountKopecks: null,
        totalKopecksPerKg: null,
        unresolvedReasons: ['spool_geometry_unresolved', 'spool_price_unresolved'],
      },
    ],
    ['unsafe snapshot version', { ...COMPLETE_ACTUAL_COST, version: Number.MAX_SAFE_INTEGER + 1 }],
    ['noncanonical snapshot timestamp', { ...COMPLETE_ACTUAL_COST, producedAt: '2026-08-07' }],
    ['non-finite snapshot timestamp', { ...COMPLETE_ACTUAL_COST, closedAt: 'not-a-date' }],
    [
      'noncanonical snapshot creation timestamp',
      { ...COMPLETE_ACTUAL_COST, createdAt: '2026-08-07' },
    ],
    [
      'actual snapshot with planned basis',
      { ...COMPLETE_ACTUAL_COST, basis: { kind: 'planned', weightGrams: 42_300 } },
    ],
    ['actual snapshot with pending status', { ...COMPLETE_ACTUAL_COST, status: 'pending' }],
    [
      'pending cost carrying a total',
      {
        kind: 'actual_pending',
        status: 'pending',
        calculationVersion: 'production-cost-v1',
        basis: { kind: 'actual', weightGrams: null },
        materialAmountKopecks: null,
        spoolAmountKopecks: null,
        payrollAmountKopecks: null,
        additionalAmountKopecks: 0,
        totalAmountKopecks: 1,
        totalKopecksPerKg: null,
        unresolvedReasons: ['weight_unresolved'],
      },
    ],
    [
      'planned preview with historical calculation version',
      {
        kind: 'planned_preview',
        status: 'complete',
        calculationVersion: 'production-cost-v0',
        basis: { kind: 'planned', weightGrams: 42_300 },
        materialAmountKopecks: 30_000,
        spoolAmountKopecks: 9_000,
        payrollAmountKopecks: 4_000,
        additionalAmountKopecks: 500,
        totalAmountKopecks: 43_500,
        totalKopecksPerKg: 1_028,
        unresolvedReasons: [],
      },
    ],
  ])('fails closed for %s', async (_label, productionCost) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: [
            {
              id: 'dispatch-1',
              rollName: 'Рукав 60 мкм',
              rollCode: 'ROLL-1',
              orderNumber: 'A-5',
              parameters: {
                filmType: 'Рукав',
                actualThicknessUm: 60,
                accountingThicknessUm: 58,
                widthMm: 1_700,
                plannedLengthM: 275,
                weightKg: 42.3,
              },
              operatorName: 'Оператор 1',
              machineName: 'Экструдер 1',
              priority: 2,
              status: 'completed',
              productionCost,
            },
          ],
          nextCursor: null,
        }),
      ),
    );

    await expect(loadBusinessProductionRolls('production-1')).rejects.toThrow(
      'Некорректные данные бизнес-показателей',
    );
  });

  it('submits only the audited director defect resolution fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 'resolved' }));
    vi.stubGlobal('fetch', fetchMock);

    await resolveBusinessOperationalProblem('problem / 1', {
      resolution: 'writeoff',
      note: 'Списание согласовано после проверки веса',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/commercial/performance/problems/problem%20%2F%201/resolve',
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      resolution: 'writeoff',
      note: 'Списание согласовано после проверки веса',
    });
  });

  it('loads one routed problem by exact encoded id and exact safe DTO shape', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        id: 'problem / 1',
        kind: 'raw_material_shortage',
        status: 'open',
        label: 'Нехватка сырья',
        createdAt: '2026-08-08T01:00:00.000Z',
        orderId: 'order-5',
        orderNumber: 'A-5',
        rollCode: 'ROLL-1',
        machineName: 'Экструдер 1',
        reason: 'Заканчивается гранула',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const problem = await loadBusinessOperationalProblem('problem / 1', { signal });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/performance/problems/problem%20%2F%201',
      expect.objectContaining({ method: 'GET', signal }),
    );
    expect(problem).toEqual({
      id: 'problem / 1',
      kind: 'raw_material_shortage',
      status: 'open',
      label: 'Нехватка сырья',
      createdAt: '2026-08-08T01:00:00.000Z',
      orderId: 'order-5',
      orderNumber: 'A-5',
      rollCode: 'ROLL-1',
      machineName: 'Экструдер 1',
      reason: 'Заканчивается гранула',
    });
  });

  it('fails closed when an exact problem response contains a non-DTO field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          id: 'problem-a',
          orderId: 'order-a',
          kind: 'general',
          status: 'open',
          label: 'Общая проблема',
          createdAt: '2026-08-08T01:00:00.000Z',
          orderNumber: null,
          rollCode: null,
          machineName: null,
          reason: 'Проверка границы',
          operatorId: 'must-not-leak',
        }),
      ),
    );

    await expect(loadBusinessOperationalProblem('problem-a')).rejects.toThrow(
      'Некорректные данные бизнес-показателей',
    );
  });

  it('fails closed when an exact problem response has another id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          id: 'problem-b',
          kind: 'general',
          status: 'open',
          label: 'Общая проблема',
          createdAt: '2026-08-08T01:00:00.000Z',
          orderId: 'order-b',
          orderNumber: null,
          rollCode: null,
          machineName: null,
          reason: 'Чужая проблема',
        }),
      ),
    );

    await expect(loadBusinessOperationalProblem('problem-a')).rejects.toThrow(
      'Некорректные данные бизнес-показателей',
    );
  });

  it('submits a machine-breakdown decision through the same protected boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 'resolved' }));
    vi.stubGlobal('fetch', fetchMock);

    await resolveBusinessOperationalProblem('breakdown-1', {
      resolution: 'confirm',
      note: 'Поломка подтверждена после осмотра станка',
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      resolution: 'confirm',
      note: 'Поломка подтверждена после осмотра станка',
    });
  });

  it.each([
    [
      'missing payment label',
      () =>
        loadBusinessPerformanceSection('Финансы', {
          from: '2026-08-01',
          to: '2026-08-07',
        }),
      page([{ ...FINANCE_ITEM, paymentPlanLabel: undefined }]),
    ],
    [
      'mismatched payment label',
      () =>
        loadBusinessPerformanceSection('Финансы', {
          from: '2026-08-01',
          to: '2026-08-07',
        }),
      page([{ ...FINANCE_ITEM, paymentPlanLabel: '100%' }]),
    ],
    [
      'unknown problem discriminator',
      () => loadBusinessOperationalProblems({ filter: 'all' }),
      {
        items: [
          {
            id: 'problem-1',
            kind: 'overweight',
            status: 'resolved',
            label: 'Перевес',
            createdAt: '2026-08-07T01:00:00.000Z',
            orderNumber: null,
            rollCode: null,
            machineName: null,
            reason: null,
          },
        ],
        nextCursor: null,
      },
    ],
    [
      'missing nullable roll value',
      () => loadBusinessProductionRolls('production-1'),
      {
        items: [
          {
            id: 'dispatch-1',
            rollName: 'Рукав 60 мкм',
            rollCode: 'ROLL-1',
            orderNumber: 'A-5',
            parameters: {
              filmType: 'Рукав',
              actualThicknessUm: 60,
              accountingThicknessUm: 58,
              widthMm: 1_700,
              plannedLengthM: 275,
              weightKg: 42.3,
            },
            operatorName: undefined,
            machineName: null,
            priority: 2,
            status: 'completed',
          },
        ],
        nextCursor: null,
      },
    ],
    [
      'missing page source',
      () =>
        loadBusinessPerformanceSection('Склад', {
          from: '2026-08-01',
          to: '2026-08-07',
        }),
      { items: [], nextCursor: null },
    ],
  ])('fails closed for a malformed payload: %s', async (_label, load, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

    await expect(load()).rejects.toThrow('Некорректные данные бизнес-показателей');
  });
});
