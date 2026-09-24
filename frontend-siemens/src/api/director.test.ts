import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, saveSession } from './authStorage';
import {
  fetchDirectorAnalytics,
  fetchDirectorBigBagEvidence,
  fetchDirectorOperatorRollVariances,
  fetchDirectorPayrollPreview as fetchDirectorPayrollPreviewFromDirector,
  fetchDirectorProblems,
  fetchDirectorShiftBalances,
  fetchDirectorTraceabilityContext,
  fetchDirectorTraceabilitySearch,
  type ServerDirectorAnalyticsBigBagEvidencePage,
  type ServerDirectorAnalyticsResponse,
  type ServerDirectorAnalyticsShiftBalancePage,
  type ServerDirectorOperatorRollVariancePage,
  type TraceabilityContext,
  type TraceabilitySearchPage,
} from './director';
import { fetchDirectorPayrollPreview, type ServerDirectorPayrollPreview } from './directorPayroll';

function stubFetch(json: unknown) {
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => json,
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const analyticsResponse: ServerDirectorAnalyticsResponse = {
  range: {
    timezone: 'Europe/Moscow',
    requested: { from: '2026-07-01', to: '2026-07-21' },
    effective: {
      fromUtc: '2026-06-30T21:00:00.000Z',
      toExclusiveUtc: '2026-07-21T21:00:00.000Z',
    },
    bucket: 'week',
    generatedAt: '2026-07-21T12:00:00.000Z',
  },
  productionSeries: [],
  materialSeries: [],
  shiftBalances: [],
  bigBags: [],
  operatorOverPlan: {
    series: [],
    totals: [],
    topOperators: [],
    missingPlanCount: 0,
    missingActorCount: 0,
  },
  productionQualitySeries: [],
  materialSpendSeries: [],
  spoolEvidence: {
    availability: 'measured_evidence_only',
    explanation: 'Measured production evidence only.',
  },
  commercialApplications: {
    definition: 'submitted',
    asOfDate: '2026-07-21',
    periods: [],
  },
  accountingProduction: {
    source: {
      sourceKind: '1C',
      label: '1С · Отчет производства за смену',
      latestImportedAt: '2026-07-21T11:00:00.000Z',
      latestDocumentDate: '2026-07-20T09:00:00.000Z',
      stale: false,
    },
    coverage: {
      documentCount: 2,
      excludedOutputLineCount: 1,
      excludedMaterialLineCount: 3,
    },
    productionSeries: [
      {
        bucketStartDate: '2026-07-20',
        documentCount: 2,
        producedKg: 82.8,
      },
    ],
    materialSeries: [{ bucketStartDate: '2026-07-20', consumedKg: 80.25 }],
  },
};

const rollVariancePage: ServerDirectorOperatorRollVariancePage = {
  items: [
    {
      operatorId: 'operator-1',
      operatorName: 'Оператор 1',
      orderId: 'order-1',
      orderNumber: 'A-1',
      rollId: 'roll-1',
      rollCode: 'A-1/1',
      producedAt: '2026-07-20T07:00:00.000Z',
      actualCapturedAt: '2026-07-20T07:01:00.000Z',
      plannedKg: 40,
      actualKg: 45,
      varianceKg: 5,
      overPlanKg: 5,
      provenance: 'post_session',
    },
  ],
  nextCursor: 'next+cursor',
};

const evidenceSource = {
  usage: 'shift_bag_usage',
  production: 'canonical_roll_weight_capture',
  defects: 'linked_stable_defect_weight_capture',
  latestEvidenceAt: '2026-07-20T08:00:00.000Z',
  freshness: 'fresh',
} as const;

const shiftBalancePage: ServerDirectorAnalyticsShiftBalancePage = {
  items: [
    {
      sessionId: 'session-1',
      shiftId: 'shift-1',
      shiftLabel: 'Смена 1',
      operatorId: 'operator-1',
      operatorName: 'Оператор 1',
      postId: 'post-1',
      postCode: 'POST-1',
      postName: 'Экструдер 1',
      startedAt: '2026-07-20T06:00:00.000Z',
      endedAt: '2026-07-20T14:00:00.000Z',
      bigBags: [],
      startKg: 500,
      endKg: 450,
      currentKg: 450,
      actualUsageKg: 50,
      expectedUsageKg: 45,
      producedKg: 42,
      rollCount: 1,
      defectKg: 3,
      defectCount: 1,
      unverifiedDefectCount: 0,
      deviationKg: 5,
      deviationPercent: 11.111,
      status: 'mismatch',
      source: evidenceSource,
    },
  ],
  nextCursor: 'shift+next',
};

const bigBagPage: ServerDirectorAnalyticsBigBagEvidencePage = {
  items: [
    {
      id: 'usage-1',
      bigBagId: 'bag-1',
      bigBagCode: 'BB-1',
      materialId: 'material-1',
      material: 'ПНД',
      bigBagStatus: 'in_use',
      sessionId: 'session-1',
      shiftId: 'shift-1',
      shiftLabel: 'Смена 1',
      operatorId: 'operator-1',
      operatorName: 'Оператор 1',
      postId: 'post-1',
      postCode: 'POST-1',
      postName: 'Экструдер 1',
      openedAt: '2026-07-20T06:00:00.000Z',
      closedAt: null,
      startKg: 500,
      endKg: null,
      currentKg: 450,
      currentMeasuredAt: '2026-07-20T08:00:00.000Z',
      priceKopecksPerKg: 2_500,
      totalKopecks: 1_125_000,
      priceEffectiveAt: '2026-07-20T06:00:00.000Z',
      bagUsageKg: 50,
      actualUsageKg: 50,
      expectedUsageKg: 45,
      calculatedRemainderKg: 455,
      producedKg: 42,
      rollCount: 1,
      defectKg: 3,
      defectCount: 1,
      unverifiedDefectCount: 0,
      deviationKg: 5,
      deviationPercent: 11.111,
      balanceScope: 'usage_episodes',
      status: 'mismatch',
      source: evidenceSource,
    },
  ],
  nextCursor: 'bag+next',
};

const traceabilityPage: TraceabilitySearchPage = {
  items: [
    {
      objectType: 'roll',
      objectId: 'roll/1',
      displayName: 'Рулон A-1/1',
      secondaryLabel: 'Заказ A-1',
      matchKind: 'exact',
    },
  ],
  nextCursor: 'opaque+traceability',
};

const traceabilityContext: TraceabilityContext = {
  objectType: 'roll',
  objectId: 'roll/1',
  displayName: 'Рулон A-1/1',
  statuses: [{ title: 'Производство', valueLabel: 'Завершено' }],
  links: [],
  timeline: [],
  problems: [],
  defects: [],
  productionFacts: [],
  warehouseFacts: [],
};

const payrollPreview: ServerDirectorPayrollPreview = {
  status: 'empty',
  appliedTariffOrders: [
    {
      id: 'payroll-tariff-order-8-09-25-2025-09-29',
      name: 'Приказ № 8-09/25',
      effectiveFrom: '2025-09-29',
      currency: 'RUB',
      matrix: {
        schemaVersion: 1,
        ladders: {
          urp12h: [
            { maxInclusiveGrams: null, primaryRateKopecksPerKg: 550, secondaryRateKopecksPerKg: 650 },
          ],
          urp24h: [
            { maxInclusiveGrams: null, primaryRateKopecksPerKg: 550, secondaryRateKopecksPerKg: 650 },
          ],
          abc12h: [
            { maxInclusiveGrams: null, standardRateKopecksPerKg: 500, blackWhiteRateKopecksPerKg: 550 },
          ],
          abc24h: [
            { maxInclusiveGrams: null, standardRateKopecksPerKg: 500, blackWhiteRateKopecksPerKg: 550 },
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
      },
    },
  ],
  range: {
    fromDate: '2026-07-01',
    toDate: '2026-07-31',
    timezone: 'Europe/Moscow',
    generatedAt: '2026-07-31T18:00:00.000Z',
  },
  summary: {
    payableAmountKopecks: 0,
    payableKg: 0,
    machineShiftCount: 0,
    operatorCount: 0,
    unresolvedKg: 0,
    unresolvedFactCount: 0,
    excludedDefectKg: 0,
    excludedDefectRollCount: 0,
  },
  operators: [],
  breakdown: [],
  unresolved: [],
};

describe('director analytics API', () => {
  beforeEach(() => {
    clearSession();
    saveSession({
      version: 1,
      token: 'director-session',
      role: 'director',
      serverRole: 'director',
      userId: 'director-1',
      displayName: 'Директор',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('loads production problems through the authenticated director projection', async () => {
    const problem = {
      id: 'problem-1',
      type: 'defect' as const,
      status: 'open' as const,
      orderId: 'order-1',
      positionId: 'position-1',
      rollId: 'ROLL-1',
      actorRole: 'operator',
      reason: 'Разрыв полотна',
      recovery: null,
      createdAt: '2026-08-16T08:30:00.000Z',
      resolvedAt: null,
      postId: 'post-1',
      post: { id: 'post-1', code: 'POST-1', name: 'Экструдер 1', status: 'online' },
      order: { id: 'order-1', orderNumber: 'З-1' },
      defectWeightKg: 42.6,
      defectWeightCapturedAt: '2026-08-16T08:29:30.000Z',
      defectWeightSource: 'operator_scale' as const,
    };
    const fetchSpy = stubFetch([problem]);

    await expect(fetchDirectorProblems()).resolves.toEqual([problem]);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/director/problems',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends a stable encoded range query through the authenticated client', async () => {
    const fetchSpy = stubFetch(analyticsResponse);
    const controller = new AbortController();

    await expect(
      fetchDirectorAnalytics(
        {
          from: '2026-07-01',
          to: '2026-07-21',
          bucket: 'week',
        },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(analyticsResponse);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/director/analytics?from=2026-07-01&to=2026-07-21&bucket=week',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer director-session' }),
        signal: controller.signal,
      }),
    );
  });

  it('rejects a valid response whose range does not match the requested period', async () => {
    const mismatched = structuredClone(analyticsResponse);
    mismatched.range.requested.from = '2026-07-02';
    stubFetch(mismatched);

    await expect(
      fetchDirectorAnalytics({ from: '2026-07-01', to: '2026-07-21', bucket: 'week' }),
    ).rejects.toThrow('Диапазон производственной аналитики не совпадает с запросом');
  });

  it('rejects malformed nested analytics data instead of rendering a successful empty view', async () => {
    const malformed = structuredClone(analyticsResponse) as unknown as {
      accountingProduction: { coverage: { documentCount: unknown } };
    };
    malformed.accountingProduction.coverage.documentCount = '2';
    stubFetch(malformed);

    await expect(
      fetchDirectorAnalytics({ from: '2026-07-01', to: '2026-07-21', bucket: 'week' }),
    ).rejects.toThrow('Некорректные данные производственной аналитики');
  });

  it('accepts integer backend shift payroll including zero and rejects fractional kopecks', async () => {
    const withPayroll = structuredClone(analyticsResponse);
    withPayroll.shiftBalances = [
      {
        sessionId: 'session-payroll-1',
        shiftId: 'shift-payroll-1',
        shiftLabel: 'Смена с начислением',
        operatorId: 'operator-1',
        operatorName: 'Оператор 1',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'УРП',
        startedAt: '2026-07-20T06:00:00.000Z',
        endedAt: '2026-07-20T14:00:00.000Z',
        rollCount: 1,
        producedKg: 0,
        expectedUsageKg: 0,
        actualUsageKg: 0,
        deviationPercent: 0,
        status: 'ok',
        payroll: {
          status: 'resolved',
          tariffOrder: {
            id: 'payroll-order-zero',
            name: 'Приказ с нулевой ставкой',
            effectiveFrom: '2026-07-20',
            currency: 'RUB',
          },
          rateKopecksPerKg: 0,
          amountKopecks: 0,
          tariffRule: 'primary',
          basisLabel: 'Серверная нулевая ставка',
        },
      },
    ];
    stubFetch(withPayroll);

    await expect(
      fetchDirectorAnalytics({ from: '2026-07-01', to: '2026-07-21', bucket: 'week' }),
    ).resolves.toEqual(withPayroll);

    const malformed = structuredClone(withPayroll) as unknown as {
      shiftBalances: Array<{ payroll: { amountKopecks: number } }>;
    };
    malformed.shiftBalances[0]!.payroll.amountKopecks = 0.5;
    stubFetch(malformed);
    await expect(
      fetchDirectorAnalytics({ from: '2026-07-01', to: '2026-07-21', bucket: 'week' }),
    ).rejects.toThrow('Некорректные данные производственной аналитики');

    const mixed = structuredClone(withPayroll);
    Object.assign(mixed.shiftBalances[0]!.payroll, {
      rateKopecksPerKg: null,
      tariffRule: null,
      amountKopecks: 400_000,
      basisLabel: 'Первичка: 400 кг × 4,5 ₽/кг; Вторичка: 400 кг × 5,5 ₽/кг',
    });
    stubFetch(mixed);
    await expect(fetchDirectorAnalytics({ from: '2026-07-01', to: '2026-07-21', bucket: 'week' })).resolves.toEqual(mixed);
    for (const partial of [{ rateKopecksPerKg: 450 }, { tariffRule: 'primary' }]) {
      const invalid = structuredClone(mixed);
      Object.assign(invalid.shiftBalances[0]!.payroll, partial);
      stubFetch(invalid);
      await expect(fetchDirectorAnalytics({ from: '2026-07-01', to: '2026-07-21', bucket: 'week' })).rejects.toThrow('Некорректные данные производственной аналитики');
    }
  });

  it('accepts signed production and 1C correction quantities while retaining other guards', async () => {
    const corrected = structuredClone(analyticsResponse);
    corrected.productionSeries = [
      { bucketStartDate: '2026-07-20', rollCount: 0, producedKg: -2.5 },
    ];
    corrected.accountingProduction.productionSeries[0]!.producedKg = -1.25;
    corrected.accountingProduction.materialSeries[0]!.consumedKg = -0.75;
    stubFetch(corrected);

    await expect(
      fetchDirectorAnalytics({ from: '2026-07-01', to: '2026-07-21', bucket: 'week' }),
    ).resolves.toEqual(corrected);

    corrected.productionSeries[0]!.rollCount = -1;
    stubFetch(corrected);
    await expect(
      fetchDirectorAnalytics({ from: '2026-07-01', to: '2026-07-21', bucket: 'week' }),
    ).rejects.toThrow('Некорректные данные производственной аналитики');
  });

  it('fetches the payroll preview through the authenticated client', async () => {
    const fetchSpy = stubFetch(payrollPreview);

    expect(fetchDirectorPayrollPreviewFromDirector).toBe(fetchDirectorPayrollPreview);

    await expect(
      fetchDirectorPayrollPreview({
        from: '2026-07-01&scope=unexpected',
        to: '2026-07-31',
      }),
    ).resolves.toEqual(payrollPreview);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/director/payroll-preview?from=2026-07-01%26scope%3Dunexpected&to=2026-07-31',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer director-session' }),
      }),
    );
  });

  it('encodes the operator-roll cursor and includes only supplied page parameters', async () => {
    const fetchSpy = stubFetch(rollVariancePage);

    await expect(
      fetchDirectorOperatorRollVariances({
        from: '2026-07-18',
        to: '2026-07-24',
        limit: 20,
      }),
    ).resolves.toEqual(rollVariancePage);
    await fetchDirectorOperatorRollVariances({
      from: '2026-07-18',
      to: '2026-07-24',
      cursor: 'opaque+cursor',
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      '/api/director/analytics/operator-rolls?from=2026-07-18&to=2026-07-24&limit=20',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain('cursor=');
    expect(fetchSpy.mock.calls[1]?.[0]).toContain('cursor=opaque%2Bcursor');
    expect(fetchSpy.mock.calls[1]?.[0]).not.toContain('limit=');
  });

  it('rejects malformed successful evidence pages before they reach director tables', async () => {
    const query = {
      from: '2026-07-18',
      to: '2026-07-24',
      bucket: 'day' as const,
    };

    stubFetch({
      ...shiftBalancePage,
      items: [{ ...shiftBalancePage.items[0], status: 'looks_ok' }],
    });
    await expect(fetchDirectorShiftBalances(query)).rejects.toThrow(
      'Некорректные данные баланса смен',
    );

    stubFetch({
      ...bigBagPage,
      items: [{ ...bigBagPage.items[0], balanceScope: 'bag' }],
    });
    await expect(fetchDirectorBigBagEvidence(query)).rejects.toThrow(
      'Некорректные данные фактов BigBag',
    );

    stubFetch({
      ...rollVariancePage,
      items: [{ ...rollVariancePage.items[0], provenance: 'estimated' }],
    });
    await expect(
      fetchDirectorOperatorRollVariances({ from: query.from, to: query.to }),
    ).rejects.toThrow('Некорректные данные перерасхода по рулонам');
  });

  it('sends shared evidence filters to both bounded server-side pages', async () => {
    const fetchSpy = stubFetch(shiftBalancePage);
    const query = {
      from: '2026-07-18',
      to: '2026-07-24',
      bucket: 'day' as const,
      operatorId: 'operator 1',
      postId: 'post/1',
      shiftId: 'shift+1',
      bigBagId: 'bag&1',
      status: 'mismatch' as const,
      q: 'Смена №1',
      cursor: 'opaque+cursor',
      limit: 20,
    };

    await expect(fetchDirectorShiftBalances(query)).resolves.toEqual(shiftBalancePage);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => bigBagPage,
    });
    await expect(fetchDirectorBigBagEvidence(query)).resolves.toEqual(bigBagPage);

    const expectedSearch =
      'from=2026-07-18&to=2026-07-24&bucket=day&operatorId=operator+1&postId=post%2F1' +
      '&shiftId=shift%2B1&bigBagId=bag%261&status=mismatch&q=%D0%A1%D0%BC%D0%B5%D0%BD%D0%B0+%E2%84%961' +
      '&cursor=opaque%2Bcursor&limit=20';
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      `/api/director/analytics/shift-balances?${expectedSearch}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      `/api/director/analytics/big-bags?${expectedSearch}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('serializes every shift evidence field, retains zero and drops BigBag-only fields', async () => {
    const fetchSpy = stubFetch(shiftBalancePage);
    const query = {
      from: '2026-07-01',
      to: '2026-07-27',
      bucket: 'day' as const,
      operatorId: 'operator-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      bigBagId: 'bag-1',
      q: 'Анна',
      operatorQuery: 'Соколова',
      postQuery: 'Экструдер',
      shiftQuery: 'Ночная',
      startedFrom: '2026-07-01',
      startedTo: '2026-07-02',
      endedFrom: '2026-07-03',
      endedTo: '2026-07-04',
      startKgMin: 20,
      startKgMax: 500,
      remainingKgMin: 0,
      remainingKgMax: 480,
      actualUsageKgMin: 1,
      actualUsageKgMax: 100,
      expectedUsageKgMin: 2,
      expectedUsageKgMax: 101,
      producedKgMin: 3,
      producedKgMax: 102,
      rollCountMin: 0,
      rollCountMax: 10,
      defectKgMin: 4,
      defectKgMax: 103,
      defectCountMin: 0,
      defectCountMax: 11,
      unverifiedDefectCountMin: 0,
      unverifiedDefectCountMax: 12,
      deviationKgMin: -5,
      deviationKgMax: 5,
      deviationPercentMin: -10.5,
      deviationPercentMax: 10.5,
      status: 'mismatch' as const,
      freshness: 'stale' as const,
      latestEvidenceFrom: '2026-07-05',
      latestEvidenceTo: '2026-07-06',
      cursor: 'shift+cursor',
      limit: 20,
      materialQuery: 'ПВД',
      endKgMin: 0,
    };

    await expect(fetchDirectorShiftBalances(query)).resolves.toEqual(shiftBalancePage);

    const expectedSearch =
      'from=2026-07-01&to=2026-07-27&bucket=day&operatorId=operator-1&postId=post-1' +
      '&shiftId=shift-1&bigBagId=bag-1&status=mismatch&q=%D0%90%D0%BD%D0%BD%D0%B0' +
      '&operatorQuery=%D0%A1%D0%BE%D0%BA%D0%BE%D0%BB%D0%BE%D0%B2%D0%B0' +
      '&postQuery=%D0%AD%D0%BA%D1%81%D1%82%D1%80%D1%83%D0%B4%D0%B5%D1%80' +
      '&shiftQuery=%D0%9D%D0%BE%D1%87%D0%BD%D0%B0%D1%8F' +
      '&startedFrom=2026-07-01&startedTo=2026-07-02&endedFrom=2026-07-03&endedTo=2026-07-04' +
      '&startKgMin=20&startKgMax=500&remainingKgMin=0&remainingKgMax=480' +
      '&actualUsageKgMin=1&actualUsageKgMax=100&expectedUsageKgMin=2&expectedUsageKgMax=101' +
      '&producedKgMin=3&producedKgMax=102&rollCountMin=0&rollCountMax=10' +
      '&defectKgMin=4&defectKgMax=103&defectCountMin=0&defectCountMax=11' +
      '&unverifiedDefectCountMin=0&unverifiedDefectCountMax=12' +
      '&deviationKgMin=-5&deviationKgMax=5&deviationPercentMin=-10.5&deviationPercentMax=10.5' +
      '&freshness=stale&latestEvidenceFrom=2026-07-05' +
      '&latestEvidenceTo=2026-07-06&cursor=shift%2Bcursor&limit=20';
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/director/analytics/shift-balances?${expectedSearch}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain('materialQuery=');
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain('endKgMin=');
  });

  it('serializes every BigBag evidence field, retains zero and drops shift-only fields', async () => {
    const fetchSpy = stubFetch(bigBagPage);
    const query = {
      from: '2026-07-01',
      to: '2026-07-27',
      bucket: 'week' as const,
      operatorId: 'operator-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      bigBagId: 'bag-1',
      q: 'BB-42',
      operatorQuery: 'Анна',
      postQuery: 'POST-1',
      shiftQuery: 'Ночная',
      bigBagQuery: 'BB',
      materialQuery: 'ПВД',
      bigBagStatus: 'in_use' as const,
      openedFrom: '2026-07-01',
      openedTo: '2026-07-02',
      closedFrom: '2026-07-03',
      closedTo: '2026-07-04',
      usageState: 'open' as const,
      startKgMin: 0,
      startKgMax: 500,
      endKgMin: 1,
      endKgMax: 499,
      currentKgMin: 2,
      currentKgMax: 498,
      bagUsageKgMin: 0,
      bagUsageKgMax: 100,
      actualUsageKgMin: 3,
      actualUsageKgMax: 101,
      expectedUsageKgMin: 4,
      expectedUsageKgMax: 102,
      producedKgMin: 5,
      producedKgMax: 103,
      rollCountMin: 0,
      rollCountMax: 10,
      defectKgMin: 6,
      defectKgMax: 104,
      defectCountMin: 0,
      defectCountMax: 11,
      unverifiedDefectCountMin: 0,
      unverifiedDefectCountMax: 12,
      deviationKgMin: -7,
      deviationKgMax: 7,
      deviationPercentMin: -11.5,
      deviationPercentMax: 11.5,
      status: 'pending' as const,
      freshness: 'unknown' as const,
      latestEvidenceFrom: '2026-07-05',
      latestEvidenceTo: '2026-07-06',
      cursor: 'bag+cursor',
      limit: 20,
      remainingKgMin: 0,
      startedFrom: '2026-07-01',
    };

    await expect(fetchDirectorBigBagEvidence(query)).resolves.toEqual(bigBagPage);

    const expectedSearch =
      'from=2026-07-01&to=2026-07-27&bucket=week&operatorId=operator-1&postId=post-1' +
      '&shiftId=shift-1&bigBagId=bag-1&status=pending&q=BB-42' +
      '&operatorQuery=%D0%90%D0%BD%D0%BD%D0%B0&postQuery=POST-1' +
      '&shiftQuery=%D0%9D%D0%BE%D1%87%D0%BD%D0%B0%D1%8F&bigBagQuery=BB' +
      '&materialQuery=%D0%9F%D0%92%D0%94&bigBagStatus=in_use' +
      '&openedFrom=2026-07-01&openedTo=2026-07-02&closedFrom=2026-07-03&closedTo=2026-07-04' +
      '&usageState=open&startKgMin=0&startKgMax=500&endKgMin=1&endKgMax=499' +
      '&currentKgMin=2&currentKgMax=498&bagUsageKgMin=0&bagUsageKgMax=100' +
      '&actualUsageKgMin=3&actualUsageKgMax=101&expectedUsageKgMin=4&expectedUsageKgMax=102' +
      '&producedKgMin=5&producedKgMax=103&rollCountMin=0&rollCountMax=10' +
      '&defectKgMin=6&defectKgMax=104&defectCountMin=0&defectCountMax=11' +
      '&unverifiedDefectCountMin=0&unverifiedDefectCountMax=12' +
      '&deviationKgMin=-7&deviationKgMax=7&deviationPercentMin=-11.5&deviationPercentMax=11.5' +
      '&freshness=unknown&latestEvidenceFrom=2026-07-05' +
      '&latestEvidenceTo=2026-07-06&cursor=bag%2Bcursor&limit=20';
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/director/analytics/big-bags?${expectedSearch}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain('remainingKgMin=');
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain('startedFrom=');
  });

  it('encodes bounded traceability search and opaque cursor parameters', async () => {
    const fetchSpy = stubFetch(traceabilityPage);

    await expect(
      fetchDirectorTraceabilitySearch({
        q: 'QR/roll 1&scope=raw',
        limit: 12,
        cursor: 'opaque+traceability',
      }),
    ).resolves.toEqual(traceabilityPage);

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/director/traceability/search?q=QR%2Froll+1%26scope%3Draw&limit=12&cursor=opaque%2Btraceability',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('encodes the registered object type and identifier for safe context lookup', async () => {
    const safeContext = {
      ...traceabilityContext,
      statuses: [{ title: 'Производство', valueLabel: 'Завершено' }],
      timeline: [
        {
          eventId: 'event-1',
          actionLabel: 'Рулон исключён из палетного листа',
          reason: 'Повреждена упаковка',
          actor: { displayName: 'Анна Складова', roleLabel: 'Склад' },
          occurredAt: '2026-08-10T12:00:00.000Z',
        },
      ],
      productionFacts: [
        {
          title: 'Текущий принятый вес шпули',
          valueLabel: '1,9 кг',
          recordedAt: '2026-08-10T12:00:00.000Z',
          isCurrent: true,
        },
      ],
    };
    const fetchSpy = stubFetch(safeContext);

    await expect(fetchDirectorTraceabilityContext('roll', 'roll/1')).resolves.toEqual(safeContext);

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/director/traceability/roll/roll%2F1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('accepts the shared big_bag search and context contract', async () => {
    const bigBagPage = {
      items: [
        {
          objectType: 'big_bag',
          objectId: 'bag-1',
          displayName: 'Big-Bag BB-ПВД-01',
          secondaryLabel: 'ПВД первичный',
          matchKind: 'exact',
        },
      ],
      nextCursor: null,
    };
    stubFetch(bigBagPage);
    await expect(fetchDirectorTraceabilitySearch({ q: 'BB-ПВД-01' })).resolves.toEqual(bigBagPage);

    const bigBagContext = {
      ...traceabilityContext,
      objectType: 'big_bag',
      objectId: 'bag-1',
      displayName: 'Big-Bag BB-ПВД-01',
      statuses: [{ title: 'Big-Bag', valueLabel: 'Используется' }],
      productionFacts: [
        {
          title: 'Материал',
          valueLabel: 'ПВД первичный',
          recordedAt: '2026-08-14T06:00:00.000Z',
          isCurrent: null,
        },
      ],
    };
    stubFetch(bigBagContext);
    await expect(fetchDirectorTraceabilityContext('big_bag', 'bag-1')).resolves.toEqual(
      bigBagContext,
    );
  });

  it('rejects malformed traceability search and context responses before rendering', async () => {
    stubFetch({ items: [{ ...traceabilityPage.items[0], matchKind: 'fuzzy' }], nextCursor: null });
    await expect(fetchDirectorTraceabilitySearch({ q: 'A-1' })).rejects.toThrow(
      'Некорректные данные поиска прослеживаемости',
    );

    stubFetch({ ...traceabilityPage, nextCursor: 42 });
    await expect(fetchDirectorTraceabilitySearch({ q: 'A-1' })).rejects.toThrow(
      'Некорректные данные поиска прослеживаемости',
    );

    stubFetch({ ...traceabilityContext, objectId: 'other-roll' });
    await expect(fetchDirectorTraceabilityContext('roll', 'roll/1')).rejects.toThrow(
      'Некорректные данные контекста прослеживаемости',
    );

    stubFetch({ ...traceabilityContext, productionFacts: 'not-an-array' });
    await expect(fetchDirectorTraceabilityContext('roll', 'roll/1')).rejects.toThrow(
      'Некорректные данные контекста прослеживаемости',
    );

    stubFetch({
      ...traceabilityContext,
      statuses: [{ kind: 'warehouse_status', value: 'received' }],
    });
    await expect(fetchDirectorTraceabilityContext('roll', 'roll/1')).rejects.toThrow(
      'Некорректные данные контекста прослеживаемости',
    );
  });
});
