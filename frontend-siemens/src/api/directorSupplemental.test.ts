import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  approveDirectorDecision,
  buildLiveDirectorControl,
  fetchDirectorControl,
  fetchDirectorDecisions,
  fetchDirectorFinanceObjects,
  fetchDirectorProductionObjects,
  fetchDirectorWarehouseObjects,
  overlayLiveDirectorControl,
  overrideDirectorFinance,
  overrideDirectorProduction,
  overrideDirectorWarehouse,
  returnDirectorDecision,
} from './director';
import { buildDirectorDashboardProjection, initialProductionRuntimeState } from '../domain/runtime';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function financeSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'finance-1',
    invoiceStatus: 'not_invoiced',
    paymentStatus: 'unpaid',
    amountValue: null,
    amountLabel: null,
    commercialOrder: { orderNumber: 'A-101', counterparty: null },
    ...overrides,
  };
}

function productionSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'production-1',
    indicator: 'needs_production',
    approvalState: 'pending',
    commercialOrder: { orderNumber: 'A-101', counterparty: null },
    rollCount: 0,
    ...overrides,
  };
}

function warehouseSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'warehouse-1',
    type: 'defect',
    status: 'open',
    orderId: null,
    rollId: null,
    postId: null,
    actorRole: 'warehouse',
    reason: 'Повреждение',
    recovery: null,
    createdAt: '2026-08-10T10:00:00.000Z',
    resolvedAt: null,
    order: null,
    post: null,
    ...overrides,
  };
}

function directorControl(overrides: Record<string, unknown> = {}) {
  return {
    pendingDecisions: 0,
    penalties: 0,
    overdueOrders: 0,
    penaltiesAmount: 0,
    plannedInvoicedAmount: 0,
    paidAmount: 0,
    unbilledAmount: 0,
    overdueAmount: 0,
    producedKg: 0,
    defectKg: 0,
    warehouseAcceptedRolls: 0,
    defectBags: {
      totalCount: 2,
      totalWeightKg: 20.5,
      byStatus: [
        { status: 'weighed' as const, count: 0, weightKg: 0 },
        { status: 'ready_for_warehouse' as const, count: 1, weightKg: 12.5 },
        { status: 'received' as const, count: 0, weightKg: 0 },
        { status: 'shipped' as const, count: 1, weightKg: 8 },
      ],
      byType: [
        { defectType: 'secondary' as const, count: 1, weightKg: 12.5 },
        { defectType: 'aika' as const, count: 1, weightKg: 8 },
        { defectType: 'primary' as const, count: 0, weightKg: 0 },
      ],
      unclassified: { count: 0, weightKg: 0 },
      recent: [
        {
          id: 'defect-bag-2',
          code: 'DB-20260907-0002',
          status: 'shipped' as const,
          defectType: 'aika' as const,
          weightKg: 8,
          recordedDefectKg: 7.5,
          differenceKg: 0.5,
          operatorName: 'Оператор 2',
          postCode: 'POST-2',
          postName: 'Станок 2',
          shiftLabel: 'День',
          weighedAt: '2026-09-07T08:00:00.000Z',
          receivedAt: '2026-09-07T09:00:00.000Z',
          receivedBy: 'Кладовщик',
          shippedAt: '2026-09-07T10:00:00.000Z',
          shippedBy: 'Кладовщик',
        },
      ],
      hasMore: false,
    },
    ...overrides,
  };
}

describe('director supplemental adapters', () => {
  it('forwards the request signal to every safe director drilldown projection', async () => {
    const fetchMock = stubFetch([]);
    const controller = new AbortController();

    await expect(
      Promise.all([
        fetchDirectorFinanceObjects({ signal: controller.signal }),
        fetchDirectorProductionObjects({ signal: controller.signal }),
        fetchDirectorWarehouseObjects({ signal: controller.signal }),
      ]),
    ).resolves.toEqual([[], [], []]);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/director/finance',
      '/api/director/production',
      '/api/director/warehouse',
    ]);
    for (const [, request] of fetchMock.mock.calls) {
      expect(request).toEqual(expect.objectContaining({ signal: controller.signal }));
    }
  });

  it('rejects malformed successful projection responses per source', async () => {
    stubFetch([financeSource({ paymentStatus: 42 })]);
    await expect(fetchDirectorFinanceObjects()).rejects.toThrow(
      'Некорректные данные: финансовые решения',
    );

    stubFetch([productionSource({ rollCount: -1 })]);
    await expect(fetchDirectorProductionObjects()).rejects.toThrow(
      'Некорректные данные: производственные решения',
    );

    stubFetch([warehouseSource({ createdAt: 'not-a-date' })]);
    await expect(fetchDirectorWarehouseObjects()).rejects.toThrow(
      'Некорректные данные: складские исключения',
    );
  });

  it('rejects unknown business enums instead of rendering plausible rows', async () => {
    stubFetch([financeSource({ paymentStatus: 'probably_paid' })]);
    await expect(fetchDirectorFinanceObjects()).rejects.toThrow(
      'Некорректные данные: финансовые решения',
    );

    stubFetch([productionSource({ indicator: 'almost_ready', approvalState: 'approved' })]);
    await expect(fetchDirectorProductionObjects()).rejects.toThrow(
      'Некорректные данные: производственные решения',
    );

    stubFetch([warehouseSource({ status: 'maybe_open' })]);
    await expect(fetchDirectorWarehouseObjects()).rejects.toThrow(
      'Некорректные данные: складские исключения',
    );
  });

  it.each([
    ['finance', 'invoiceStatus'],
    ['finance', 'paymentStatus'],
    ['finance', 'amountValue'],
    ['finance', 'amountLabel'],
    ['finance', 'commercialOrder'],
    ['production', 'indicator'],
    ['production', 'approvalState'],
    ['production', 'commercialOrder'],
    ['production', 'rollCount'],
  ] as const)('rejects a %s projection missing required %s', async (scope, key) => {
    const source: Record<string, unknown> =
      scope === 'finance' ? financeSource() : productionSource();
    delete source[key];
    stubFetch([source]);

    await expect(
      scope === 'finance' ? fetchDirectorFinanceObjects() : fetchDirectorProductionObjects(),
    ).rejects.toThrow('Некорректные данные');
  });

  it('requires the nested order number and a strict nullable counterparty projection', async () => {
    stubFetch([financeSource({ commercialOrder: { counterparty: null } })]);
    await expect(fetchDirectorFinanceObjects()).rejects.toThrow('Некорректные данные');

    stubFetch([
      productionSource({
        commercialOrder: { orderNumber: 'A-101', counterparty: { legalName: null } },
      }),
    ]);
    await expect(fetchDirectorProductionObjects()).rejects.toThrow('Некорректные данные');

    stubFetch([financeSource({ commercialOrder: { orderNumber: 'S-101', counterparty: null } })]);
    await expect(fetchDirectorFinanceObjects()).resolves.toEqual([
      expect.objectContaining({ title: expect.stringContaining('S-101 · На запас') }),
    ]);
  });

  it.each(['rollId', 'order', 'post'] as const)(
    'rejects a warehouse projection missing required %s',
    async (key) => {
      const source = warehouseSource();
      delete source[key];
      stubFetch([source]);

      await expect(fetchDirectorWarehouseObjects()).rejects.toThrow(
        'Некорректные данные: складские исключения',
      );
    },
  );

  it('requires canonical nested warehouse order and post fields', async () => {
    stubFetch([
      warehouseSource({
        orderId: 'order-1',
        order: { id: 'order-1' },
      }),
    ]);
    await expect(fetchDirectorWarehouseObjects()).rejects.toThrow('Некорректные данные');

    stubFetch([
      warehouseSource({
        postId: 'post-1',
        post: { id: 'post-1', code: 'POST-1', name: 'Пост 1' },
      }),
    ]);
    await expect(fetchDirectorWarehouseObjects()).rejects.toThrow('Некорректные данные');

    stubFetch([
      warehouseSource({
        orderId: 'order-1',
        order: { id: 'order-1', orderNumber: 'A-101' },
        postId: 'post-1',
        post: { id: 'post-1', code: 'POST-1', name: 'Пост 1', status: 'active' },
      }),
    ]);
    await expect(fetchDirectorWarehouseObjects()).resolves.toHaveLength(1);
  });

  it('strictly validates every live control metric before exposing the panel', async () => {
    stubFetch(directorControl());
    await expect(fetchDirectorControl()).resolves.toEqual(directorControl());

    stubFetch(directorControl({ paidAmount: '0' }));
    await expect(fetchDirectorControl()).rejects.toThrow(
      'Некорректные данные панели контроля директора',
    );

    const missing: Record<string, unknown> = directorControl();
    delete missing.warehouseAcceptedRolls;
    stubFetch(missing);
    await expect(fetchDirectorControl()).rejects.toThrow(
      'Некорректные данные панели контроля директора',
    );
  });

  it('validates and exposes the safe defect-bag register in live control', async () => {
    const valid = directorControl();
    stubFetch(valid);

    const control = await fetchDirectorControl();

    expect(control.defectBags?.recent[0]).toEqual(
      expect.objectContaining({
        code: 'DB-20260907-0002',
        status: 'shipped',
        defectType: 'aika',
        receivedBy: 'Кладовщик',
        shippedBy: 'Кладовщик',
      }),
    );

    const malformed = directorControl();
    (malformed.defectBags as { recent: Array<Record<string, unknown>> }).recent[0]!.status =
      'lost';
    stubFetch(malformed);
    await expect(fetchDirectorControl()).rejects.toThrow(
      'Некорректные данные панели контроля директора',
    );

    const malformedType = directorControl();
    (malformedType.defectBags as { recent: Array<Record<string, unknown>> }).recent[0]!.defectType =
      'mixed';
    stubFetch(malformedType);
    await expect(fetchDirectorControl()).rejects.toThrow(
      'Некорректные данные панели контроля директора',
    );
  });

  it('validates the complete decision queue before exposing any decision', async () => {
    const validDecision = {
      id: 'decision-1',
      scope: 'finance',
      objectId: 'finance-1',
      evidence: null,
      ownerRole: 'director',
      status: 'pending',
      severity: 'warning',
      createdAt: '2026-08-10T10:00:00.000Z',
      updatedAt: '2026-08-10T10:01:00.000Z',
    } as const;

    stubFetch([validDecision, { ...validDecision, severity: 'urgent' }]);
    await expect(fetchDirectorDecisions()).rejects.toThrow(
      'Некорректные данные очереди решений директора',
    );

    stubFetch([{ ...validDecision, createdAt: 'not-a-timestamp' }]);
    await expect(fetchDirectorDecisions()).rejects.toThrow(
      'Некорректные данные очереди решений директора',
    );

    stubFetch([validDecision]);
    await expect(fetchDirectorDecisions()).resolves.toEqual([validDecision]);
  });

  it('accepts only the requested decision id and terminal mutation status', async () => {
    const decision = {
      id: 'dec-1',
      scope: 'finance',
      objectId: 'fo-A-1024',
      evidence: null,
      ownerRole: 'director',
      status: 'approved',
      severity: 'warning',
      createdAt: '2026-08-10T10:00:00.000Z',
      updatedAt: '2026-08-10T10:01:00.000Z',
    } as const;

    stubFetch(decision);
    await expect(approveDirectorDecision('dec-1')).resolves.toEqual(decision);

    stubFetch({ ...decision, id: 'dec-other' });
    await expect(approveDirectorDecision('dec-1')).rejects.toThrow(
      'Некорректный результат решения директора',
    );

    stubFetch({ ...decision, status: 'returned' });
    await expect(returnDirectorDecision('dec-1', 'Нужна сверка')).resolves.toMatchObject({
      id: 'dec-1',
      status: 'returned',
    });

    stubFetch({ ...decision, status: 'pending' });
    await expect(returnDirectorDecision('dec-1', 'Нужна сверка')).rejects.toThrow(
      'Некорректный результат решения директора',
    );
  });

  it.each([
    ['finance', overrideDirectorFinance],
    ['production', overrideDirectorProduction],
    ['warehouse', overrideDirectorWarehouse],
  ] as const)('requires applied=true and the exact object id from %s override', async (_, call) => {
    stubFetch({ applied: true, objectId: 'fo-A-1024' });
    await expect(
      call('fo-A-1024', { reason: 'Подтверждено', evidence: 'Сверка' }),
    ).resolves.toEqual({ applied: true, objectId: 'fo-A-1024' });

    stubFetch({ applied: false, objectId: 'fo-A-1024' });
    await expect(call('fo-A-1024', { reason: 'Подтверждено', evidence: 'Сверка' })).rejects.toThrow(
      'Некорректный результат директорского override',
    );

    stubFetch({ applied: true, objectId: 'other-object' });
    await expect(call('fo-A-1024', { reason: 'Подтверждено', evidence: 'Сверка' })).rejects.toThrow(
      'Некорректный результат директорского override',
    );
  });

  it('maps valid safe projections without fabricating API or backend history', async () => {
    stubFetch([financeSource({ paymentStatus: 'paid' })]);
    const finance = await fetchDirectorFinanceObjects();
    stubFetch([productionSource()]);
    const production = await fetchDirectorProductionObjects();
    stubFetch([warehouseSource()]);
    const warehouse = await fetchDirectorWarehouseObjects();

    expect(
      [...finance, ...production, ...warehouse].every((object) => object.audit.length === 0),
    ).toBe(true);
    expect(JSON.stringify([...finance, ...production, ...warehouse])).not.toMatch(/backend|API/u);
  });

  it('maps a large compact production roll count without nested roll rows', async () => {
    stubFetch([productionSource({ rollCount: 2_394 })]);

    const [production] = await fetchDirectorProductionObjects();

    expect(production.facts).toContainEqual(
      expect.objectContaining({ label: 'Рулоны', value: '2394 рул.' }),
    );
  });

  it('accepts and normalizes the decimal string emitted by the finance projection', async () => {
    stubFetch([
      financeSource({
        id: 'finance-decimal',
        paymentStatus: 'partial',
        amountValue: '1234.50',
      }),
    ]);

    const [finance] = await fetchDirectorFinanceObjects();

    expect(finance.financeAmountValue).toBe(1234.5);
    expect(finance.facts).toContainEqual(
      expect.objectContaining({ label: 'Сумма', value: '1234.50 ₽' }),
    );
  });

  it('preserves a large Decimal string exactly and omits an unsafe numeric comparator', async () => {
    stubFetch([
      financeSource({
        id: 'finance-large-decimal',
        amountValue: '9999999999999999.99',
      }),
    ]);

    const [finance] = await fetchDirectorFinanceObjects();

    expect(finance.financeAmountValue).toBeUndefined();
    expect(finance.facts).toContainEqual(
      expect.objectContaining({ label: 'Сумма', value: '9999999999999999.99 ₽' }),
    );
  });

  it('rejects a non-decimal finance amount string', async () => {
    stubFetch([
      financeSource({ id: 'finance-invalid', paymentStatus: 'paid', amountValue: '1 234,50' }),
    ]);

    await expect(fetchDirectorFinanceObjects()).rejects.toThrow(
      'Некорректные данные: финансовые решения',
    );
  });

  it('keeps an absent finance amount distinct from a real zero', async () => {
    stubFetch([
      financeSource({
        id: 'finance-without-amount',
        paymentStatus: 'unpaid',
        amountValue: null,
      }),
    ]);

    const [finance] = await fetchDirectorFinanceObjects();

    expect(finance.financeAmountValue).toBeUndefined();
    expect(finance.facts).toContainEqual(
      expect.objectContaining({ label: 'Сумма', value: 'Нет данных' }),
    );
    expect(JSON.stringify(finance.facts)).not.toContain('0 ₽');
  });

  it.each([
    ['not_started', 'Не начато'],
    ['needs_production', 'Требует производства'],
    ['in_production', 'В производстве'],
    ['ready', 'Готово'],
    ['needs_approval', 'Готов к согласованию'],
    ['defect', 'Брак'],
  ] as const)('maps the canonical production indicator %s to %s', async (indicator, label) => {
    stubFetch([
      productionSource({
        id: `production-${indicator}`,
        indicator,
        approvalState: 'approved',
      }),
    ]);

    const [production] = await fetchDirectorProductionObjects();

    expect(production.statusLabel).toBe(label);
    expect(production.facts).toContainEqual(
      expect.objectContaining({ label: 'Статус', value: label }),
    );
  });

  it('keeps live finance rows empty instead of falling back to demo dashboard rows', () => {
    const dashboard = buildDirectorDashboardProjection(initialProductionRuntimeState);
    expect(dashboard.controlReport.financeRows.length).toBeGreaterThan(0);

    const live = overlayLiveDirectorControl(dashboard, directorControl(), []);

    expect(live.controlReport.financeRows).toEqual([]);
  });

  it('builds the live control projection without demo sentinels or invented period facts', () => {
    const demo = buildDirectorDashboardProjection(initialProductionRuntimeState);
    demo.controlReport.kpis = demo.controlReport.kpis.map((kpi, index) =>
      index === 0 ? { ...kpi, value: 'DEMO-LIVE-SENTINEL' } : kpi,
    );

    const live = overlayLiveDirectorControl(demo, directorControl({ producedKg: 82.4 }));

    expect(JSON.stringify(live)).not.toContain('DEMO-LIVE-SENTINEL');
    expect(live.situations).toEqual([]);
    expect(live.healthSignals).toEqual([]);
    expect(live.secondaryMetrics).toEqual([]);
    expect(live.controlReport).toMatchObject({
      periodLabel: 'Период не предоставлен',
      availablePeriods: [],
      kpis: [],
      periodMetrics: [],
      periodRows: [],
    });
    expect(live.controlReport.productionRows).toContainEqual(
      expect.objectContaining({
        id: 'output-kg',
        factLabel: '82.4 кг',
        planLabel: 'Нет данных',
        varianceLabel: 'Сравнение недоступно',
      }),
    );
    expect(live.controlReport.defectBags?.recent[0]?.code).toBe('DB-20260907-0002');
  });

  it('marks unsupported paid, remaining and due finance values unavailable in live control', async () => {
    stubFetch([
      financeSource({
        paymentStatus: 'overdue',
        amountValue: '9999999999999999.99',
      }),
    ]);
    const financeObjects = await fetchDirectorFinanceObjects();

    const live = buildLiveDirectorControl(directorControl(), financeObjects);

    expect(live.controlReport.financeRows).toEqual([
      expect.objectContaining({
        amountLabel: '9999999999999999.99 ₽',
        paidLabel: 'Нет данных',
        remainingLabel: 'Нет данных',
        dueLabel: 'Нет данных',
        amountValue: null,
        remainingValue: null,
        dueRank: null,
      }),
    ]);
  });
});
