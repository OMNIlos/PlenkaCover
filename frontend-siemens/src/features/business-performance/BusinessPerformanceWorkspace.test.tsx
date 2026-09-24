import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DirectorProductionPanel } from '../../components/workbenches/director-analytics/DirectorProductionPanel';
import { BusinessPerformanceWorkspace } from './BusinessPerformanceWorkspace';

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function text(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll((node) => typeof node.children[0] === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))
    .join(' ');
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function controlResponse() {
  return response({
    range: {
      timezone: 'Europe/Moscow',
      requested: { from: '2026-07-01', to: '2026-07-31' },
      effective: {
        fromUtc: '2026-06-30T21:00:00.000Z',
        toExclusiveUtc: '2026-07-31T21:00:00.000Z',
      },
      bucket: 'day',
      generatedAt: '2026-07-31T12:00:00.000Z',
    },
    source: {
      kind: 'platform_runtime',
      status: 'ready',
      freshness: 'fresh',
      generatedAt: '2026-07-31T12:00:00.000Z',
    },
    summary: {
      invoicedAmount: 10_000,
      paidAmount: 8_000,
      receivableAmount: 2_000,
      overdueAmount: 0,
      producedKg: 280,
      producedRolls: 9,
      defectKg: 0,
      defectRollCount: 0,
      returnedSpoolCount: 0,
      warehouseAcceptedRolls: 9,
    },
    productionSeries: [],
    productionQualitySeries: [
      {
        id: 'day:2026-07-23',
        bucketStartDate: '2026-07-23',
        producedRollCount: 7,
        producedKg: 200,
        defectRecordCount: 0,
        defectiveRollCount: 0,
        verifiedDefectKg: 0,
        unverifiedDefectCount: 0,
        returnedSpoolCount: 0,
      },
      {
        id: 'day:2026-07-24',
        bucketStartDate: '2026-07-24',
        producedRollCount: 2,
        producedKg: 80,
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
      asOfDate: '2026-07-31',
      periods: [],
    },
  });
}

function shiftBalanceResponse() {
  return response({
    items: [
      {
        sessionId: 'session-payroll-1',
        shiftId: 'shift-payroll-1',
        shiftLabel: 'Смена с начислением',
        operatorId: 'operator-1',
        operatorName: 'Ахметов Булат',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'Бегемот',
        startedAt: '2026-08-05T11:47:09.110Z',
        endedAt: '2026-08-05T12:41:24.300Z',
        bigBags: [],
        startKg: 999,
        endKg: 980,
        currentKg: 980,
        actualUsageKg: 19,
        expectedUsageKg: 15.7,
        producedKg: 7.95,
        rollCount: 2,
        defectKg: 7.75,
        defectCount: 1,
        unverifiedDefectCount: 0,
        deviationKg: 3.3,
        deviationPercent: 21.019,
        status: 'mismatch',
        source: {
          usage: 'shift_bag_usage',
          production: 'canonical_roll_weight_capture',
          defects: 'linked_stable_defect_weight_capture',
          latestEvidenceAt: '2026-08-05T12:41:24.300Z',
          freshness: 'fresh',
        },
      },
    ],
    nextCursor: null,
  });
}

function directorAnalyticsResponse() {
  return response({
    range: {
      timezone: 'Europe/Moscow',
      requested: { from: '2026-07-16', to: '2026-08-14' },
      effective: {
        fromUtc: '2026-07-15T21:00:00.000Z',
        toExclusiveUtc: '2026-08-14T21:00:00.000Z',
      },
      bucket: 'day',
      generatedAt: '2026-08-14T05:30:00.000Z',
    },
    productionSeries: [],
    materialSeries: [],
    shiftBalances: [
      {
        sessionId: 'session-payroll-1',
        shiftId: 'shift-payroll-1',
        shiftLabel: 'Смена с начислением',
        operatorId: 'operator-1',
        operatorName: 'Ахметов Булат',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'Бегемот',
        startedAt: '2026-08-05T11:47:09.110Z',
        endedAt: '2026-08-05T12:41:24.300Z',
        rollCount: 2,
        producedKg: 15.7,
        expectedUsageKg: 15.7,
        actualUsageKg: 19,
        deviationPercent: 21.019,
        status: 'mismatch',
        payroll: {
          status: 'resolved',
          tariffOrder: {
            id: 'payroll-tariff-order-8-09-25-2025-09-29',
            name: 'Приказ № 8-09/25',
            effectiveFrom: '2025-09-29',
            currency: 'RUB',
          },
          rateKopecksPerKg: 450,
          amountKopecks: 8_550,
          tariffRule: 'abc_standard',
          basisLabel: 'Бегемот · 12 ч · ставка ABC · переработано 19.000 кг',
        },
      },
    ],
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
      asOfDate: '2026-08-14',
      periods: [],
    },
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
  });
}

function installControlFetch(
  mainRequest: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (
      path === '/api/commercial/performance/control/shift-balances' ||
      path === '/api/commercial/performance/control/big-bags'
    ) {
      return Promise.resolve(response({ items: [], nextCursor: null }));
    }
    return mainRequest(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('button')
    .find((candidate) => textContent(candidate) === label);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BusinessPerformanceWorkspace', () => {
  it('shows defect-bag logistics in the director control workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname;
        if (path === '/api/commercial/performance/control') {
          return Promise.resolve(controlResponse());
        }
        if (
          path === '/api/commercial/performance/control/shift-balances' ||
          path === '/api/commercial/performance/control/big-bags'
        ) {
          return Promise.resolve(response({ items: [], nextCursor: null }));
        }
        if (path === '/api/director/analytics') {
          return Promise.resolve(directorAnalyticsResponse());
        }
        return Promise.reject(new Error(`Unexpected request: ${path}`));
      }),
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessPerformanceWorkspace
          section="Контроль"
          role="director"
          defectBags={{
            totalCount: 1,
            totalWeightKg: 12.5,
            byStatus: [
              { status: 'weighed', count: 0, weightKg: 0 },
              { status: 'ready_for_warehouse', count: 1, weightKg: 12.5 },
              { status: 'received', count: 0, weightKg: 0 },
              { status: 'shipped', count: 0, weightKg: 0 },
            ],
            byType: [
              { defectType: 'secondary', count: 1, weightKg: 12.5 },
              { defectType: 'aika', count: 0, weightKg: 0 },
              { defectType: 'primary', count: 0, weightKg: 0 },
            ],
            unclassified: { count: 0, weightKg: 0 },
            recent: [
              {
                id: 'defect-bag-1',
                code: 'DEF-cmtqqlje4004pqw07tgb9ptot',
                status: 'ready_for_warehouse',
                defectType: 'secondary',
                weightKg: 12.5,
                recordedDefectKg: 12,
                differenceKg: 0.5,
                operatorName: 'Оператор 1',
                postCode: 'POST-1',
                postName: 'Станок 1',
                shiftLabel: 'Смена оператора cmrq8e51n0003pe0jwb5id7jl',
                weighedAt: '2026-09-07T08:00:00.000Z',
                receivedAt: null,
                receivedBy: null,
                shippedAt: null,
                shippedBy: null,
              },
            ],
            hasMore: false,
          }}
        />,
      );
    });

    const content = text(renderer);
    expect(content).toMatch(/Мешки брака.*Мешок брака 07\.09\.2026 · POST-1.*Ожидает приёмки/u);
    expect(content).toContain('Смена 07.09.2026 · Оператор 1 · POST-1');
    expect(content).not.toMatch(/cmtqqlje4004pqw07tgb9ptot|cmrq8e51n0003pe0jwb5id7jl/u);
  });

  it('joins the authoritative director payroll to the shared shift evidence by session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T05:30:00.000Z'));
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname;
        requestedPaths.push(path);
        if (path === '/api/commercial/performance/control') {
          return Promise.resolve(controlResponse());
        }
        if (path === '/api/commercial/performance/control/shift-balances') {
          return Promise.resolve(shiftBalanceResponse());
        }
        if (path === '/api/commercial/performance/control/big-bags') {
          return Promise.resolve(response({ items: [], nextCursor: null }));
        }
        if (path === '/api/director/analytics') {
          return Promise.resolve(directorAnalyticsResponse());
        }
        return Promise.reject(new Error(`Unexpected request: ${path}`));
      }),
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessPerformanceWorkspace section="Контроль" role="director" />,
      );
    });

    const content = text(renderer);
    expect(requestedPaths).toContain('/api/director/analytics');
    expect(content).toContain('85,50 ₽');
    expect(content).toContain('Приказ № 8-09/25');
    expect(content).not.toContain('Расчёт зарплаты недоступен');
  });

  it('uses concise payment wording and omits obsolete 1C control tables', async () => {
    installControlFetch(vi.fn().mockResolvedValue(controlResponse()));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessPerformanceWorkspace section="Контроль" />);
    });

    const content = text(renderer);
    expect(content).toContain('Осталось оплатить');
    expect(content).not.toContain('Дебиторский остаток');
    expect(content).not.toMatch(/Сверка производства|Материалы 1С|Заявки по периодам/u);
  });

  it('reloads the first page when the App live-refresh generation advances', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(controlResponse())
      .mockResolvedValueOnce(controlResponse());
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessPerformanceWorkspace section="Контроль" refreshGeneration={1} />,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<BusinessPerformanceWorkspace section="Контроль" refreshGeneration={2} />);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(fetchMock.mock.calls[0]?.[0]);
  });

  it('preserves the selected control sort after applying and loading a new date range', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(controlResponse())
      .mockResolvedValueOnce(controlResponse());
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessPerformanceWorkspace section="Контроль" />);
    });
    act(() => button(renderer, 'Таблица')?.props.onClick());

    const producedHeader = () =>
      renderer.root
        .findAll((node) => node.type === 'th' && node.props.scope === 'col')
        .find((header) => textContent(header) === 'Изготовлено, рул.');
    const periods = () =>
      renderer.root
        .findByType(DirectorProductionPanel)
        .findByType('tbody')
        .findAllByType('tr')
        .map((row) => textContent(row.findByType('th')));

    act(() => producedHeader()?.findByType('button').props.onClick());
    expect(producedHeader()?.props['aria-sort']).toBe('descending');
    expect(periods()).toEqual(['23.07.2026', '24.07.2026']);

    act(() => producedHeader()?.findByType('button').props.onClick());
    expect(producedHeader()?.props['aria-sort']).toBe('ascending');
    expect(periods()).toEqual(['24.07.2026', '23.07.2026']);

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Дата с' }).props.onChange({
        target: { value: '2026-07-01' },
      });
      renderer.root.findByProps({ 'aria-label': 'Дата по' }).props.onChange({
        target: { value: '2026-07-31' },
      });
    });
    await act(async () => {
      button(renderer, 'Применить')?.props.onClick();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(producedHeader()?.props['aria-sort']).toBe('ascending');
    expect(periods()).toEqual(['24.07.2026', '23.07.2026']);
  });

  it('renders the persisted payment-plan label without deriving it from schedule status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: [
            {
              id: 'finance-1',
              orderNumber: 'A-12',
              counterpartyName: 'Контур',
              invoiceStatus: 'invoiced',
              paymentStatus: 'paid',
              paymentPlanKind: 'custom',
              paymentPlanLabel: 'Индивидуально',
              invoicedAmount: 12_000,
              paidAmount: 12_000,
              remainingAmount: 0,
              nextConfirmedDueAt: null,
              updatedAt: '2026-08-07T00:10:00.000Z',
            },
          ],
          nextCursor: null,
          source: {
            kind: 'platform_runtime',
            status: 'ready',
            freshness: 'fresh',
            generatedAt: '2026-08-07T00:15:00.000Z',
          },
        }),
      ),
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessPerformanceWorkspace section="Финансы" />);
    });

    expect(text(renderer)).toContain('Индивидуально');
    expect(text(renderer)).not.toContain('100%');
  });

  it('renders every finance status in Russian and hides unknown backend tokens', async () => {
    const statuses = [
      ['unpaid', 'Не оплачено'],
      ['partial', 'Частично оплачено'],
      ['paid', 'Оплачено'],
      ['overdue', 'Просрочено'],
      ['sync_error', 'Требует проверки'],
      ['not_applicable', 'Не применяется'],
      ['future_payment_state', 'Не определено'],
    ] as const;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: statuses.map(([paymentStatus], index) => ({
            id: `finance-${index}`,
            orderNumber: `A-${index + 1}`,
            counterpartyName: 'Контур',
            invoiceStatus: 'invoiced',
            paymentStatus,
            paymentPlanKind: 'full',
            paymentPlanLabel: '100%',
            invoicedAmount: 1_000,
            paidAmount: 0,
            remainingAmount: 1_000,
            nextConfirmedDueAt: null,
            updatedAt: '2026-08-07T00:10:00.000Z',
          })),
          nextCursor: null,
          source: {
            kind: 'platform_runtime',
            status: 'ready',
            freshness: 'fresh',
            generatedAt: '2026-08-07T00:15:00.000Z',
          },
        }),
      ),
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessPerformanceWorkspace section="Финансы" />);
    });

    const content = text(renderer);
    for (const [, expectedLabel] of statuses) {
      expect(content).toContain(expectedLabel);
    }
    for (const [rawStatus] of statuses) {
      expect(content).not.toContain(rawStatus);
    }
  });

  it('renders the current warehouse business projection instead of dated roll counters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: [
            {
              kind: 'client_order',
              id: 'order-1',
              templates: [
                {
                  fingerprint: 'a'.repeat(64),
                  filmType: 'пнд',
                  actualThicknessMicron: 35,
                  accountingThicknessMicron: 40,
                  widthMm: 500,
                  plannedLengthM: 1200,
                  birka: 'белая',
                  spoolType: '76 мм',
                  plannedWeightKg: 19,
                  recipeVersion: null,
                },
              ],
              status: 'awaiting_shipment',
              orderNumber: 'A-1',
              counterpartyName: 'Контур',
            },
          ],
          page: 1,
          pageSize: 50,
          total: 1,
        }),
      ),
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessPerformanceWorkspace section="Склад" />);
    });

    expect(renderer.root.findAllByType('th').map(textContent)).toEqual([
      'Параметры рулонов',
      'Статус',
      'Заказ',
      'Контрагент',
    ]);
    expect(text(renderer)).toContain('Ожидает отгрузки');
    expect(text(renderer)).not.toMatch(/Готово|Зарезервировано|Принято|Отгружено/u);
  });
});
