import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommercialPerformanceWorkspace } from './CommercialPerformanceWorkspace';

function text(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll((node) => typeof node.children[0] === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))
    .join(' ');
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function controlResponse(invoicedAmount = 10_000) {
  return response({
    range: {
      timezone: 'Europe/Moscow',
      requested: { from: '2026-07-01', to: '2026-07-31' },
      effective: {
        fromUtc: '2026-06-30T21:00:00.000Z',
        toExclusiveUtc: '2026-07-31T21:00:00.000Z',
      },
      bucket: 'week',
      generatedAt: '2026-07-31T12:00:00.000Z',
    },
    source: {
      kind: 'platform_runtime',
      status: 'ready',
      freshness: 'fresh',
      generatedAt: '2026-07-31T12:00:00.000Z',
    },
    summary: {
      invoicedAmount,
      paidAmount: 8_000,
      receivableAmount: 2_000,
      overdueAmount: 0,
      producedKg: 282.125,
      producedRolls: 7,
      defectKg: 5.25,
      defectRollCount: 2,
      returnedSpoolCount: 2,
      warehouseAcceptedRolls: 6,
    },
    productionSeries: [
      {
        bucketStartDate: '2026-07-01',
        rollCount: 7,
        producedKg: 282.125,
      },
    ],
    productionQualitySeries: [
      {
        id: 'day:2026-07-01',
        bucketStartDate: '2026-07-01',
        producedRollCount: 7,
        producedKg: 282.125,
        defectRecordCount: 3,
        defectiveRollCount: 2,
        verifiedDefectKg: 5.25,
        unverifiedDefectCount: 1,
        returnedSpoolCount: 2,
      },
    ],
    accountingProduction: {
      source: {
        sourceKind: '1C',
        label: '1С · Отчет производства за смену',
        latestImportedAt: '2026-07-31T11:00:00.000Z',
        latestDocumentDate: '2026-07-31T10:00:00.000Z',
        stale: false,
      },
      coverage: {
        documentCount: 1,
        excludedOutputLineCount: 0,
        excludedMaterialLineCount: 0,
      },
      productionSeries: [
        {
          bucketStartDate: '2026-07-01',
          documentCount: 1,
          producedKg: 280,
        },
      ],
      materialSeries: [
        {
          bucketStartDate: '2026-07-01',
          consumedKg: 263.5,
        },
      ],
    },
    commercialApplications: {
      definition: 'submitted',
      asOfDate: '2026-07-31',
      periods: [
        {
          period: 'week',
          fromDate: '2026-07-25',
          toDate: '2026-07-31',
          totalCount: 12,
          clientOrderCount: 9,
          stockReserveCount: 3,
        },
      ],
    },
  });
}

function pageResponse(items: unknown[] = [], nextCursor: string | null = null) {
  return response({
    items,
    nextCursor,
    source: {
      kind: 'platform_runtime',
      status: 'ready',
      freshness: 'fresh',
      generatedAt: '2026-07-31T12:00:00.000Z',
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function field(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findByProps({ 'aria-label': label });
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('button')
    .find((candidate) => candidate.children.join('') === label);
}

function changeRange(
  renderer: ReactTestRenderer,
  from: string,
  to: string,
  bucket?: 'day' | 'week' | 'month',
) {
  act(() => {
    field(renderer, 'Дата с').props.onChange({ target: { value: from } });
    field(renderer, 'Дата по').props.onChange({ target: { value: to } });
    if (bucket) {
      field(renderer, 'Группировка').props.onChange({ target: { value: bucket } });
    }
  });
}

async function applyRange(renderer: ReactTestRenderer) {
  await act(async () => {
    button(renderer, 'Применить')?.props.onClick();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CommercialPerformanceWorkspace', () => {
  it('derives the default 30-day range from the Moscow calendar across midnight and year end', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(controlResponse()));
    installControlFetch(fetchMock);

    vi.setSystemTime(new Date('2026-12-31T20:59:59.000Z'));
    let beforeMidnight!: ReactTestRenderer;
    await act(async () => {
      beforeMidnight = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/commercial/performance/control?from=2026-12-02&to=2026-12-31&bucket=day',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    act(() => beforeMidnight.unmount());

    vi.setSystemTime(new Date('2026-12-31T21:00:00.000Z'));
    let afterMidnight!: ReactTestRenderer;
    await act(async () => {
      afterMidnight = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/commercial/performance/control?from=2026-12-03&to=2027-01-01&bucket=day',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('loads Control with the selected range and director production chart', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(controlResponse()));
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });

    act(() => {
      field(renderer, 'Дата с').props.onChange({ target: { value: '2026-07-01' } });
      field(renderer, 'Дата по').props.onChange({ target: { value: '2026-07-31' } });
      field(renderer, 'Группировка').props.onChange({ target: { value: 'week' } });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await applyRange(renderer);

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/commercial/performance/control?from=2026-07-01&to=2026-07-31&bucket=week',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(text(renderer)).toContain('Изготовлено и брак, кг');
    expect(text(renderer)).toContain('Бракованные рулоны 2');
    expect(text(renderer)).not.toMatch(/Шпули возвращены|Подтверждённый|Записей брака/u);
  });

  it('omits obsolete 1C and application-summary tables from Control', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(controlResponse()));
    const allFetchMock = installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });

    const renderedText = text(renderer);
    expect(renderedText).not.toMatch(
      /Сверка производства|Факт ERP|Учёт 1С|Материалы 1С|Заявки по периодам/u,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/commercial\/performance\/control\?/u),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(allFetchMock.mock.calls.map(([url]) => String(url))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/api\/director\//u)]),
    );
  });

  it('does not request an inverted range and shows a validation message', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(controlResponse()));
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });
    act(() => {
      field(renderer, 'Дата с').props.onChange({ target: { value: '2026-08-02' } });
      field(renderer, 'Дата по').props.onChange({ target: { value: '2026-08-01' } });
    });
    act(() => {
      button(renderer, 'Применить')?.props.onClick();
    });

    expect(text(renderer)).toContain('Дата начала не может быть позже даты окончания');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects 367 inclusive calendar days and accepts the corrected 366-day range', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(controlResponse()));
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });
    changeRange(renderer, '2024-01-01', '2025-01-01');
    await applyRange(renderer);

    expect(text(renderer)).toContain('Период не может превышать 366 календарных дней');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    changeRange(renderer, '2024-01-01', '2024-12-31');
    await applyRange(renderer);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/commercial/performance/control?from=2024-01-01&to=2024-12-31&bucket=day',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(text(renderer)).not.toContain('Период не может превышать 366 календарных дней');
  });

  it('keeps the range editor available after a 400 and loads a corrected range', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Период отклонён сервером' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(controlResponse());
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });

    expect(text(renderer)).toContain('Период отклонён сервером');
    expect(field(renderer, 'Дата с')).toBeDefined();
    expect(field(renderer, 'Дата по')).toBeDefined();
    expect(button(renderer, 'Применить')).toBeDefined();

    changeRange(renderer, '2026-07-01', '2026-07-31', 'week');
    await applyRange(renderer);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/commercial/performance/control?from=2026-07-01&to=2026-07-31&bucket=week',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(text(renderer)).toContain('Выставлено');
    expect(text(renderer)).not.toContain('Период отклонён сервером');
  });

  it.each(['Дата с', 'Дата по'])(
    'does not request a range with an empty %s boundary',
    async (emptyBoundary) => {
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(controlResponse()));
      installControlFetch(fetchMock);
      let renderer!: ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
      });
      act(() => {
        field(renderer, emptyBoundary).props.onChange({ target: { value: '' } });
      });
      await applyRange(renderer);

      expect(text(renderer)).toContain('Укажите корректные даты начала и окончания');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['Финансы', 'finance'],
    ['Производство', 'production'],
  ] as const)('applies the selected range to %s', async (section, endpoint) => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(pageResponse()));
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section={section} />);
    });
    changeRange(renderer, '2026-06-01', '2026-06-30', 'month');
    await applyRange(renderer);

    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/commercial/performance/${endpoint}?from=2026-06-01&to=2026-06-30&limit=50`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('loads current warehouse groups without an arbitrary date range', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ items: [], page: 1, pageSize: 50, total: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      TestRenderer.create(<CommercialPerformanceWorkspace section="Склад" />);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/performance/warehouse?page=1&pageSize=50',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('resets accumulated pagination when a new range is applied', async () => {
    const firstItem = {
      id: 'production-1',
      orderNumber: 'A-1',
      counterpartyName: null,
      productionStatus: 'active',
      lifecycleStatus: 'in_production',
      createdAt: '2026-07-27T10:00:00.000Z',
      completedAt: null,
      plannedRollCount: 2,
      completedRollCount: 1,
      plannedKg: 80,
      actualKg: 40,
      defectKg: 0,
      defectRollCount: 0,
      returnedSpoolCount: 0,
      updatedAt: '2026-07-28T10:00:00.000Z',
    };
    const nextItem = {
      ...firstItem,
      id: 'production-2',
      orderNumber: 'A-2',
    };
    const newRangeItem = {
      ...firstItem,
      id: 'production-3',
      orderNumber: 'A-3',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([firstItem], 'opaque-next'))
      .mockResolvedValueOnce(pageResponse([nextItem]))
      .mockResolvedValueOnce(pageResponse([newRangeItem]));
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Производство" />);
    });
    await act(async () => {
      await button(renderer, 'Загрузить ещё')?.props.onClick();
    });
    expect(text(renderer)).toMatch(/A-1.*A-2/u);

    changeRange(renderer, '2026-06-01', '2026-06-30');
    await applyRange(renderer);

    expect(text(renderer)).toContain('A-3');
    expect(text(renderer)).not.toMatch(/A-1|A-2/u);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/commercial/performance/production?from=2026-06-01&to=2026-06-30&limit=50',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reloads when the same range is applied repeatedly', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(controlResponse()));
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });
    await applyRange(renderer);
    await applyRange(renderer);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(fetchMock.mock.calls[2]?.[0]);
  });

  it('aborts a section request and ignores its late response', async () => {
    const stale = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(
        pageResponse([
          {
            id: 'finance-current',
            orderNumber: 'CURRENT',
            counterpartyName: 'Контур',
            invoiceStatus: 'invoiced',
            paymentStatus: 'paid',
            paymentPlanKind: 'full',
            paymentPlanLabel: '100%',
            invoicedAmount: 1_000,
            paidAmount: 1_000,
            remainingAmount: 0,
            nextConfirmedDueAt: null,
            updatedAt: '2026-07-31T12:00:00.000Z',
          },
        ]),
      );
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });
    const staleSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    await act(async () => {
      renderer.update(<CommercialPerformanceWorkspace section="Финансы" />);
    });
    expect(staleSignal.aborted).toBe(true);
    expect(text(renderer)).toContain('CURRENT');

    await act(async () => {
      stale.resolve(controlResponse(99_000));
      await stale.promise;
    });

    expect(text(renderer)).toContain('CURRENT');
    expect(text(renderer)).not.toContain('Загрузка показателей');
  });

  it('aborts an old-range refresh and ignores its late response', async () => {
    const stale = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(controlResponse(10_000))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(controlResponse(30_000));
    installControlFetch(fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });
    act(() => {
      button(renderer, 'Обновить')?.props.onClick();
    });
    const staleSignal = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal;

    changeRange(renderer, '2026-06-01', '2026-06-30');
    await applyRange(renderer);
    expect(staleSignal.aborted).toBe(true);
    expect(text(renderer)).toMatch(/30[\s ]?000/u);

    await act(async () => {
      stale.resolve(controlResponse(20_000));
      await stale.promise;
    });

    expect(text(renderer)).toMatch(/30[\s ]?000/u);
    expect(text(renderer)).not.toMatch(/20[\s ]?000/u);
  });

  it('switches the shared production presentation between units and exact data', async () => {
    installControlFetch(vi.fn().mockResolvedValue(controlResponse()));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Контроль" />);
    });
    expect(text(renderer)).toContain('Изготовлено и брак, кг');

    act(() => {
      button(renderer, 'шт.')?.props.onClick();
    });
    expect(text(renderer)).toContain('Изготовлено и рулоны с браком, шт.');

    act(() => {
      button(renderer, 'Таблица')?.props.onClick();
    });
    expect(text(renderer)).toContain('Точные данные производства и брака');
  });

  it('renders finance as a safe read-only order projection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: [
            {
              id: 'finance-1',
              orderNumber: 'A-2',
              counterpartyName: 'Контур',
              invoiceStatus: 'invoiced',
              paymentStatus: 'partial',
              paymentPlanKind: 'half_split',
              paymentPlanLabel: '50/50',
              invoicedAmount: 1_000,
              paidAmount: 400,
              remainingAmount: 600,
              nextConfirmedDueAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-07-28T10:00:00.000Z',
            },
          ],
          nextCursor: null,
          source: {
            kind: 'platform_runtime',
            status: 'ready',
            freshness: 'fresh',
            generatedAt: '2026-07-28T12:00:00.000Z',
          },
        }),
      ),
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Финансы" />);
    });

    const content = text(renderer);
    expect(content).toMatch(/Финансы.*A-2.*Контур.*1[\s ]?000.*400.*600/u);
    expect(content).toContain('50/50');
    expect(content).not.toMatch(/прибыл|штраф|решени|override|оператор|rawPayload/iu);
    expect(renderer.root.findAllByType('button').map((button) => button.children.join(''))).toEqual(
      ['Обновить', 'Применить'],
    );
  });

  it('shows a retry action and recovers without exposing director controls', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Сеть недоступна'))
      .mockResolvedValueOnce(
        response({
          items: [],
          page: 1,
          pageSize: 50,
          total: 0,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Склад" />);
    });
    expect(text(renderer)).toContain('Сеть недоступна');

    const retry = renderer.root
      .findAllByType('button')
      .find((button) => button.children.join('') === 'Повторить');
    await act(async () => {
      retry?.props.onClick();
    });

    expect(text(renderer)).toContain('На складе нет текущих позиций');
    expect(text(renderer)).not.toMatch(/решение|override|корректиров/iu);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads the next safe page with the opaque commercial cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 'production-1',
              orderNumber: 'A-1',
              counterpartyName: null,
              productionStatus: 'active',
              lifecycleStatus: 'in_production',
              createdAt: '2026-07-27T10:00:00.000Z',
              completedAt: null,
              plannedRollCount: 2,
              completedRollCount: 1,
              plannedKg: 80,
              actualKg: 40,
              defectKg: 0,
              defectRollCount: 1,
              returnedSpoolCount: 1,
              updatedAt: '2026-07-28T10:00:00.000Z',
            },
          ],
          nextCursor: 'opaque-next',
          source: {
            kind: 'platform_runtime',
            status: 'ready',
            freshness: 'fresh',
            generatedAt: '2026-07-28T12:00:00.000Z',
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 'production-2',
              orderNumber: 'A-2',
              counterpartyName: null,
              productionStatus: 'queued',
              lifecycleStatus: 'in_production',
              createdAt: '2026-07-27T09:00:00.000Z',
              completedAt: null,
              plannedRollCount: 3,
              completedRollCount: 0,
              plannedKg: 120,
              actualKg: 0,
              defectKg: 0,
              defectRollCount: 0,
              returnedSpoolCount: 0,
              updatedAt: '2026-07-28T09:00:00.000Z',
            },
          ],
          nextCursor: null,
          source: {
            kind: 'platform_runtime',
            status: 'ready',
            freshness: 'fresh',
            generatedAt: '2026-07-28T12:01:00.000Z',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<CommercialPerformanceWorkspace section="Производство" />);
    });

    const loadMore = renderer.root
      .findAllByType('button')
      .find((button) => button.children.join('') === 'Загрузить ещё');
    await act(async () => {
      await loadMore?.props.onClick();
    });

    expect(text(renderer)).toMatch(/A-1.*A-2/u);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('cursor=opaque-next'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      renderer.root
        .findAllByType('button')
        .some((button) => button.children.join('') === 'Загрузить ещё'),
    ).toBe(false);
  });
});
