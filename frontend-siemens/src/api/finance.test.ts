import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from './authStorage';
import {
  financeObjectBelongsToSection,
  getFinanceCommandItems,
  getFinanceCommandItem,
  getFinanceNextStep,
  getListItems,
} from '../domain/selectors';
import { workObjects } from '../domain/fixtures/workObjects';
import {
  confirmFinancePaymentSchedule,
  correctFinancePayment,
  createFinanceInvoice,
  fetchFinanceOrders,
  fetchFinanceOrderHistory,
  financeCoverageApi,
  previewFinancePaymentPolicy,
  recordFinancePayment,
  retryFinanceSource,
  setFinancePaymentPolicy,
  setFinancePaymentTerms,
  updateFinancePayment,
} from './finance';
import {
  fetchFinanceReconciliation,
  resolveFinancePaymentAllocation,
  syncOneCPayments,
} from './financeOneC';
import { IdempotentOperationGate } from './idempotentOperation';
import {
  normalizeFinanceWarehouseCoverage,
  normalizeFinanceWarehouseCoverageWithCase,
} from '../domain/warehouseCoverage';

const paymentPolicy = {
  installmentDays: 30,
  stages: [
    {
      sequence: 1,
      trigger: 'full_shipment' as const,
      percentageBasisPoints: 10000,
      offsetDays: 30,
    },
  ],
};

const paymentCorrectionResult = {
  commandId: 'correction-command-1',
  targetKind: 'schedule_confirmation' as const,
  targetId: 'schedule / 1',
  reversalOperationId: null,
  paymentStatus: 'unpaid' as const,
  productionClearedAt: null,
};

const financePosition = {
  id: 'position-1',
  rollCount: 4,
  filmType: 'ПВД',
  actualThickness: '80 мкм',
  accountingThickness: '75 мкм',
  spoolType: '76 мм',
  birka: 'Белая',
  plannedWeightKg: 25,
  widthMm: 1_200,
  plannedLengthM: 800,
};

const financeOrder = {
  id: 'finance-1',
  commercialOrderId: 'commercial-1',
  invoiceStatus: 'invoiced',
  invoiceSyncState: 'not_synced',
  invoiceNumber: null,
  invoiceCurrency: null,
  invoiceCandidates: null,
  invoiceSourceCheckedAt: null,
  paymentStatus: 'unpaid',
  paymentTermsType: 'prepay_50_postpay_50_30d',
  amountValue: '1200.00',
  amountLabel: '1 200 ₽',
  invoiceIssuedAt: null,
  sourceStatus: 'ready',
  productionClearedAt: null,
  createdAt: '2026-07-08T09:00:00.000Z',
  updatedAt: '2026-07-08T09:05:00.000Z',
  externalId: null,
  sourceVersion: null,
  commercialOrder: {
    id: 'commercial-1',
    orderNumber: 'A-77',
    creatorRole: 'commercial',
    counterpartyId: 'counterparty-1',
    requestType: 'client_order',
    productionIndicator: 'not_started',
    warehouseCoverStatus: 'not_checked',
    paymentStatus: 'unpaid',
    shipmentStatus: 'not_shipped',
    shipmentCompletedAt: null,
    warehouseCoverageWorkflowVersion: 1,
    createdAt: '2026-07-08T09:00:00.000Z',
    updatedAt: '2026-07-08T09:05:00.000Z',
    externalId: null,
    sourceVersion: null,
    commercialFinanceNote: null,
    comment: 'Доставка на склад клиента',
    counterparty: {
      id: 'counterparty-1',
      displayName: 'ООО Тест',
      legalName: 'ООО Тест',
      inn: '7700000000',
      billingSource: 'manual_platform',
      syncStatus: 'ready',
    },
    positions: [],
  },
  paymentPolicy: null,
  schedules: [],
  operations: [],
  invoice: null,
  paymentSummary: {
    invoiceAmount: '1200.00',
    paidAmount: '0.00',
    remainingAmount: '1200.00',
    overpaidAmount: '0.00',
  },
  paymentTimeline: [],
  businessPayment: {
    businessDate: '2026-08-11',
    status: 'unpaid',
    isOverdue: false,
    paidAmount: '0.00',
    remainingAmount: '1200.00',
    overdueAmount: '0.00',
    schedules: [],
  },
  paymentCorrections: [],
  correctablePayments: [],
};

function financeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schedule-1',
    financeOrderId: 'finance-1',
    paymentPolicyStageId: null,
    percentageBasisPoints: null,
    offsetDays: null,
    kind: 'post_delivery',
    startsAt: null,
    terms: null,
    dueDate: null,
    amount: 1200,
    status: 'unpaid',
    source: 'manual_platform',
    createdAt: '2026-07-08T09:00:00.000Z',
    dateKind: 'unavailable',
    paidAmount: '0.00',
    remainingAmount: '1200.00',
    isOverdue: false,
    sequence: null,
    trigger: null,
    ...overrides,
  };
}

function financeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'operation-1',
    financeOrderId: 'finance-1',
    operationKey: '00000000-0000-4000-8000-000000000001',
    operationType: 'manual_adjustment',
    amount: '200.00',
    source: 'manual_platform',
    createdByRole: 'finance',
    reconciled: false,
    createdAt: '2026-07-08T09:00:00.000Z',
    externalId: null,
    sourceVersion: null,
    paymentAllocationId: null,
    paymentScheduleId: null,
    reversesOperationId: null,
    ...overrides,
  };
}

function okResponse(json: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  };
}

function stubFetch(json: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(okResponse(json));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => clearSession());
afterEach(() => vi.unstubAllGlobals());

describe('finance live api actions', () => {
  it.each([
    ['invoiced', null, 'Счёт без номера'],
    ['not_invoiced', null, 'Счёт не выставлен'],
    ['invoiced', 'СЧ-42', 'СЧ-42'],
  ])('preserves invoice status %s with number %s', async (invoiceStatus, invoiceNumber, expected) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify([{ ...financeOrder, invoiceStatus, invoiceNumber }]), {
            status: 200,
          }),
        ),
    );
    const [result] = await fetchFinanceOrders();
    expect(result.facts.find((fact) => fact.label === 'Номер счета')?.value).toBe(expected);
  });

  it('maps backend-derived payment state and append-only corrections into the invoice', async () => {
    stubFetch([
      {
        ...financeOrder,
        paymentStatus: 'overdue',
        businessPayment: {
          ...financeOrder.businessPayment,
          status: 'overdue',
          isOverdue: true,
          paidAmount: '400.00',
          remainingAmount: '800.00',
          overdueAmount: '800.00',
        },
        paymentCorrections: [
          {
            id: 'correction-1',
            targetKind: 'payment_operation',
            reason: 'Дублирующее поступление',
            actorRole: 'Бухгалтерия',
            resultingStatus: 'partial',
            createdAt: '2026-08-10T10:00:00.000Z',
          },
        ],
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.financeBusinessPayment).toMatchObject({
      status: 'overdue',
      remainingAmount: '800.00',
      overdueAmount: '800.00',
    });
    expect(result.financePaymentCorrections).toEqual([
      expect.objectContaining({ reason: 'Дублирующее поступление', resultingStatus: 'partial' }),
    ]);
    expect(result.audit).toEqual([]);
    expect(result.facts.map(({ label }) => label)).not.toEqual(
      expect.arrayContaining(['Источник данных', 'Маркер для 1С']),
    );
    expect(result.sections.map(({ title }) => title)).not.toContain('Источник данных');
    expect(result.filterTags).toEqual(['Просрочка', 'Счета', 'Требуют действия', 'Просрочки']);
    expect(result.filterTags).not.toEqual(
      expect.arrayContaining(['Оплаты', 'Исключения', 'Сверка источников', 'История']),
    );
    expect(result.actions.map(({ id }) => id)).not.toContain(`finance-retry-sync:${result.id}`);
    expect(result.actions).toContainEqual(
      expect.objectContaining({ id: `finance-create-problem:${result.id}` }),
    );
    expect(result.facts).toContainEqual(
      expect.objectContaining({
        label: 'Комментарий заказа',
        value: 'Доставка на склад клиента',
      }),
    );
  });

  it('maps the safe order composition into the finance work object', async () => {
    stubFetch([
      {
        ...financeOrder,
        commercialOrder: { ...financeOrder.commercialOrder, positions: [financePosition] },
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.commercialOrder?.positions).toEqual([
      expect.objectContaining({
        ...financePosition,
        draftId: 'commercial-1',
        rawMaterialLabel: 'Не указано',
        warehouseCoverStatus: 'not_checked',
      }),
    ]);
  });

  it('uses a working read-only payment action after a paid invoice is selected', async () => {
    stubFetch([
      {
        ...financeOrder,
        paymentStatus: 'paid',
        paymentSummary: {
          ...financeOrder.paymentSummary,
          paidAmount: '1200.00',
          remainingAmount: '0.00',
        },
        businessPayment: {
          ...financeOrder.businessPayment,
          status: 'paid',
          paidAmount: '1200.00',
          remainingAmount: '0.00',
          overdueAmount: '0.00',
        },
      },
    ]);

    const [result] = await fetchFinanceOrders();
    const nextStep = getFinanceNextStep(result);

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: `finance-view-payments:${result.id}`,
        label: 'Показать выплаты',
      }),
    ]);
    expect(nextStep.primaryAction.id).toBe(`finance-view-payments:${result.id}`);
    expect(nextStep.now).toBe('Посмотреть выплаты');
    expect(JSON.stringify(nextStep)).not.toMatch(/finance-history|Повторить проверку источника/u);
  });

  it('loads contextual history with Moscow time and no internal audit code', async () => {
    stubFetch([
      {
        id: 'event-1',
        occurredAt: '2026-08-10T12:30:00.000Z',
        actor: 'Олег Петров',
        actorRole: 'Коммерция',
        action: 'Комментарий коммерции изменён',
        field: 'Комментарий',
        previousValue: 'Самовывоз',
        currentValue: 'Доставка',
        reason: 'Клиент уточнил условия',
      },
    ]);

    const result = await fetchFinanceOrderHistory('finance / 1');

    expect(result).toEqual([
      expect.objectContaining({
        objectId: 'finance / 1',
        actorLabel: 'Олег Петров · Коммерция',
        actionLabel: 'Комментарий коммерции изменён',
        detail: 'Комментарий',
        oldValue: 'Самовывоз',
        newValue: 'Доставка',
        reason: 'Клиент уточнил условия',
      }),
    ]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/finance/orders/finance%20%2F%201/audit',
      expect.any(Object),
    );
    expect(JSON.stringify(result)).not.toMatch(/audit:|snake_case|requestFingerprint/);
  });
  it('accepts the canonical payment-policy schedule returned after invoice creation', async () => {
    const createdOrder = {
      ...financeOrder,
      paymentTermsType: 'postpay_100_30d',
      paymentPolicy: {
        id: 'policy-1',
        installmentDays: 30,
        capturedProductionLeadDays: 2,
        revision: 1,
        invoiceExternalId: null,
        invoiceSourceVersion: null,
        capturedInvoiceAmount: '150000.00',
        capturedInvoiceCurrency: null,
        stages: [
          {
            id: 'stage-1',
            sequence: 1,
            trigger: 'full_shipment',
            percentageBasisPoints: 10000,
            offsetDays: 30,
            label: null,
          },
        ],
      },
      schedules: [
        {
          ...financeSchedule(),
          id: 'schedule-from-policy',
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 30,
          dateKind: 'condition',
          amount: 150000,
          source: 'payment_policy',
        },
      ],
    };
    const fetchMock = stubFetch(createdOrder);

    const result = await createFinanceInvoice('finance / 1', {
      amount: 150000,
      paymentPolicy,
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/finance/orders/finance%20%2F%201/invoices');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ amount: 150000, paymentPolicy });
    expect(result.paymentSchedules).toEqual([
      expect.objectContaining({ id: 'schedule-from-policy', amountValue: 150000 }),
    ]);
  });

  it.each([
    [
      'counterparty billing source',
      {
        ...financeOrder,
        commercialOrder: {
          ...financeOrder.commercialOrder,
          counterparty: {
            ...financeOrder.commercialOrder.counterparty,
            billingSource: 'payment_policy',
          },
        },
      },
    ],
    [
      'payment operation source',
      {
        ...financeOrder,
        operations: [financeOperation({ source: 'payment_policy' })],
      },
    ],
  ])('rejects payment_policy as an unrelated %s', async (_label, response) => {
    stubFetch([response]);

    await expect(fetchFinanceOrders()).rejects.toThrow('Некорректный ответ финансовых заказов.');
  });

  it('sends stable operation keys for updates, schedule confirmation and correction', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(financeOrder))
      .mockResolvedValueOnce(okResponse(financeOrder))
      .mockResolvedValueOnce(okResponse(paymentCorrectionResult));
    vi.stubGlobal('fetch', fetchMock);

    await updateFinancePayment('finance / 1', {
      operationKey: '00000000-0000-4000-8000-000000000301',
      paymentStatus: 'paid',
    });
    await confirmFinancePaymentSchedule(
      'finance / 1',
      'schedule / 1',
      '00000000-0000-4000-8000-000000000302',
    );
    const correction = {
      operationKey: '00000000-0000-4000-8000-000000000303',
      target: { kind: 'schedule_confirmation' as const, id: 'schedule / 1' },
      expectedPaymentStatus: 'paid' as const,
      reason: 'Подтверждение внесено ошибочно',
    };
    await expect(correctFinancePayment('finance / 1', correction)).resolves.toEqual(
      paymentCorrectionResult,
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/finance/orders/finance%20%2F%201/payment-updates',
      '/api/finance/orders/finance%20%2F%201/payment-schedules/schedule%20%2F%201/confirm',
      '/api/finance/orders/finance%20%2F%201/payment-corrections',
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)),
    ).toEqual([
      {
        operationKey: '00000000-0000-4000-8000-000000000301',
        paymentStatus: 'paid',
      },
      { operationKey: '00000000-0000-4000-8000-000000000302' },
      correction,
    ]);
  });

  it('keeps the concise approval fact and removes the production-lead caption', async () => {
    stubFetch([financeOrder]);

    const [result] = await fetchFinanceOrders();
    const projection = JSON.stringify(result);

    expect(result.facts).toContainEqual(
      expect.objectContaining({ label: 'Заказ-наряд', value: 'Согласован' }),
    );
    expect(projection).not.toContain('Согласован зав. производства');
  });

  it('accepts the canonical seeded counterparty discovery status', async () => {
    stubFetch([
      {
        ...financeOrder,
        commercialOrder: {
          ...financeOrder.commercialOrder,
          counterparty: {
            ...financeOrder.commercialOrder.counterparty,
            syncStatus: 'needs_discovery',
          },
        },
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.commercialOrder?.billingSnapshot?.syncStatus).toBe('needs_1C_discovery');
  });

  it.each([
    [
      'missing payment summary',
      (() => {
        const { paymentSummary: _summary, ...row } = financeOrder;
        return row;
      })(),
    ],
    ['numeric amount instead of a Decimal string', { ...financeOrder, amountValue: 1200 }],
    ['unknown invoice status', { ...financeOrder, invoiceStatus: 'issued' }],
    [
      'invalid payment summary amount',
      {
        ...financeOrder,
        paymentSummary: { ...financeOrder.paymentSummary, paidAmount: 'not-money' },
      },
    ],
    [
      'missing commercial counterparty',
      {
        ...financeOrder,
        commercialOrder: { ...financeOrder.commercialOrder, counterparty: undefined },
      },
    ],
    [
      'invalid roll quantity',
      {
        ...financeOrder,
        commercialOrder: {
          ...financeOrder.commercialOrder,
          positions: [{ ...financePosition, rollCount: 0 }],
        },
      },
    ],
  ])('rejects a malformed finance-order 2xx row: %s', async (_label, row) => {
    stubFetch([row]);

    await expect(fetchFinanceOrders()).rejects.toThrow('Некорректный ответ финансовых заказов.');
  });

  it('accepts the UI-safe rolling projection without internal relations or unused catalogs', async () => {
    const { invoiceCandidates: _invoiceCandidates, ...withoutInvoiceCandidates } = financeOrder;
    const { positions: _positions, ...commercialOrder } = financeOrder.commercialOrder;
    stubFetch([
      {
        ...withoutInvoiceCandidates,
        commercialOrder,
        schedules: [
          {
            id: 'schedule-safe',
            kind: 'post_delivery',
            sequence: 1,
            trigger: 'full_shipment',
            percentageBasisPoints: 10000,
            offsetDays: 30,
            startsAt: null,
            dueDate: null,
            dateKind: 'condition',
            amount: 1200,
            status: 'unpaid',
            source: 'manual_platform',
            paidAmount: '0.00',
            remainingAmount: '1200.00',
            isOverdue: false,
            futureSafeMetadata: 'ignored while backend allowlist rolls out',
          },
        ],
        operations: [
          {
            id: 'operation-safe',
            operationType: 'manual_adjustment',
            amount: '-200.00',
            source: 'manual_platform',
            createdAt: '2026-07-08T09:00:00.000Z',
            paymentAllocationId: 'allocation-safe',
            futureSafeMetadata: 'ignored while backend allowlist rolls out',
          },
        ],
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(JSON.stringify(result)).not.toMatch(
      /futureSafeMetadata|financeOrderId|operationKey|createdByRole/u,
    );
    expect(result.paymentOperations).toEqual([
      expect.objectContaining({
        id: 'operation-safe',
        allocationId: 'allocation-safe',
        amountLabel: '-200 ₽',
      }),
    ]);
    expect(result.paymentSchedules).toEqual([
      expect.objectContaining({ id: 'schedule-safe', amountValue: 1200 }),
    ]);
  });

  it('projects every payment-operation source into a bounded business label', async () => {
    stubFetch([
      {
        ...financeOrder,
        operations: [
          financeOperation({ id: 'operation-1c', source: '1C' }),
          financeOperation({ id: 'operation-mock-1c', source: 'mock_1C' }),
          financeOperation({ id: 'operation-manual', source: 'manual_platform' }),
          financeOperation({ id: 'operation-warehouse', source: 'warehouse_runtime' }),
          financeOperation({ id: 'operation-future', source: 'partner_bank_api_v2' }),
        ],
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.paymentOperations?.map(({ source }) => source)).toEqual([
      'Учётный источник',
      'Учётный источник',
      'Внесено вручную',
      'Подтверждено складом',
      'Другой источник',
    ]);
    expect(JSON.stringify(result.paymentOperations)).not.toMatch(
      /mock_1C|manual_platform|warehouse_runtime|partner_bank_api_v2/u,
    );
  });

  it.each([
    [
      'numeric operation amount',
      {
        ...financeOrder,
        operations: [
          {
            id: 'operation-safe',
            operationType: 'manual_adjustment',
            amount: -200,
            source: 'manual_platform',
            createdAt: '2026-07-08T09:00:00.000Z',
          },
        ],
      },
    ],
    [
      'missing schedule date kind',
      {
        ...financeOrder,
        schedules: [
          {
            id: 'schedule-safe',
            kind: 'post_delivery',
            sequence: 1,
            trigger: 'full_shipment',
            percentageBasisPoints: 10000,
            offsetDays: 30,
            startsAt: null,
            dueDate: null,
            amount: 1200,
            status: 'unpaid',
            source: 'manual_platform',
          },
        ],
      },
    ],
  ])('rejects malformed UI-safe finance facts: %s', async (_label, row) => {
    stubFetch([row]);

    await expect(fetchFinanceOrders()).rejects.toThrow('Некорректный ответ финансовых заказов.');
  });

  it('maps the immutable warehouse coverage workflow version from the commercial order', async () => {
    stubFetch([
      {
        ...financeOrder,
        commercialOrder: {
          ...financeOrder.commercialOrder,
          warehouseCoverageWorkflowVersion: 2,
        },
        coverage: serverCoverageProjection(),
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.warehouseCoverageWorkflowVersion).toBe(2);
  });

  it('maps only server-authorized payment correction targets and the exact payment status', async () => {
    stubFetch([
      {
        ...financeOrder,
        paymentStatus: 'paid',
        correctablePayments: [
          {
            target: { kind: 'schedule_confirmation', id: 'schedule-1' },
            label: 'Подтверждение этапа оплаты',
            amount: '1200.00',
            source: 'manual_platform',
            canCorrect: true,
            blockedReason: null,
          },
          {
            target: { kind: 'payment_operation', id: 'onec-operation' },
            label: 'Платёжная операция',
            amount: '100.00',
            source: '1C',
            canCorrect: false,
            blockedReason: 'Исправьте платёж в 1С',
          },
        ],
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.financePaymentStatus).toBe('paid');
    expect(result.correctablePayments).toEqual([
      expect.objectContaining({
        target: { kind: 'schedule_confirmation', id: 'schedule-1' },
        source: 'manual_platform',
        canCorrect: true,
      }),
      expect.objectContaining({
        target: { kind: 'payment_operation', id: 'onec-operation' },
        source: '1C',
        canCorrect: false,
      }),
    ]);
  });

  it.each([undefined, 0, 3])(
    'rejects an invalid warehouse coverage workflow version %s instead of guessing',
    async (warehouseCoverageWorkflowVersion) => {
      stubFetch([
        {
          ...financeOrder,
          commercialOrder: {
            ...financeOrder.commercialOrder,
            warehouseCoverageWorkflowVersion,
          },
        },
      ]);

      await expect(fetchFinanceOrders()).rejects.toThrow('Некорректный ответ финансовых заказов.');
    },
  );

  it('maps a newly handed-off order as waiting for manual invoice entry', async () => {
    const fetchMock = stubFetch([
      {
        ...financeOrder,
        invoiceStatus: 'not_invoiced',
        amountValue: null,
        amountLabel: 'Направлено коммерцией',
        paymentSummary: {
          invoiceAmount: null,
          paidAmount: '0.00',
          remainingAmount: null,
          overpaidAmount: '0.00',
        },
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/finance/orders');
    expect(result.statusLabel).toBe('Ждет счет');
    expect(financeObjectBelongsToSection(result, 'Обзор')).toBe(true);
    expect(
      getListItems('finance', 'Все', 'Обзор', { ...workObjects, finance: [result] }).map(
        (item) => item.id,
      ),
    ).toContain(result.id);
    expect(result.facts).toContainEqual(
      expect.objectContaining({
        label: 'Сумма',
        value: 'не указана — оформите счёт вручную',
      }),
    );
    expect(result.facts).toContainEqual(
      expect.objectContaining({
        label: 'Остаток',
        value: 'появится после ручного оформления счёта',
      }),
    );
    expect(result.actions[0]).toMatchObject({
      label: 'Выставить счёт',
      enabled: true,
      helpText: 'Укажите сумму счёта и условия оплаты вручную.',
    });
    expect(result.actions.some((action) => action.id.includes('production'))).toBe(false);
  });

  it('keeps newly handed-off invoices above older invoices when priorities tie', async () => {
    const newer = {
      ...financeOrder,
      id: 'finance-z-newer',
      commercialOrderId: 'commercial-z-newer',
      invoiceStatus: 'not_invoiced',
      amountValue: null,
      amountLabel: null,
      createdAt: '2026-08-15T08:00:00.000Z',
      updatedAt: '2026-08-15T08:00:00.000Z',
      commercialOrder: {
        ...financeOrder.commercialOrder,
        id: 'commercial-z-newer',
        orderNumber: 'NEW-2',
      },
    };
    const older = {
      ...newer,
      id: 'finance-a-older',
      commercialOrderId: 'commercial-a-older',
      createdAt: '2026-08-14T08:00:00.000Z',
      updatedAt: '2026-08-14T08:00:00.000Z',
      commercialOrder: {
        ...newer.commercialOrder,
        id: 'commercial-a-older',
        orderNumber: 'OLD-1',
      },
    };
    stubFetch([older, newer]);

    const invoices = await fetchFinanceOrders();

    expect(
      getFinanceCommandItems(invoices, 'positiveFirst', new Date('2026-08-15T09:00:00.000Z')).map(
        ({ id }) => id,
      ),
    ).toEqual(['finance-z-newer', 'finance-a-older']);
  });

  it('maps exact deferred-payment facts without giving finance a production handoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse([
          {
            ...financeOrder,
            paymentTermsType: 'postpay_100_30d',
            paymentStatus: 'unpaid',
            schedules: [financeSchedule({ id: 'postpay-row' })],
          },
        ]),
      )
      .mockResolvedValueOnce(
        okResponse([
          {
            ...financeOrder,
            paymentTermsType: 'prepay_50_postpay_50_30d',
            paymentStatus: 'partial',
            schedules: [
              financeSchedule({
                id: 'prepayment-row',
                kind: 'invoice_prepayment',
                dueDate: '2026-07-08',
                dateKind: 'actual',
                amount: 600,
                status: 'paid',
              }),
              financeSchedule({ id: 'post-delivery-row', amount: 600 }),
            ],
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const [postpay] = await fetchFinanceOrders();
    const [paidPrepayment] = await fetchFinanceOrders();

    expect(postpay.paymentTermsType).toBe('postpay_100_30d');
    expect(postpay.paymentSchedules).toEqual([
      expect.objectContaining({ kind: 'post_delivery', status: 'scheduled' }),
    ]);
    expect(paidPrepayment.paymentSchedules).toContainEqual(
      expect.objectContaining({ kind: 'invoice_prepayment', status: 'paid' }),
    );
    for (const order of [postpay, paidPrepayment]) {
      expect(order.actions.some((action) => action.id.includes('production'))).toBe(false);
    }
  });

  it('uses the canonical payment summary for partial totals', async () => {
    stubFetch([
      {
        ...financeOrder,
        id: 'finance-staged-partial',
        commercialOrderId: 'commercial-staged-partial',
        commercialOrder: {
          ...financeOrder.commercialOrder,
          id: 'commercial-staged-partial',
        },
        amountValue: '1000.00',
        paymentStatus: 'partial',
        paymentSummary: {
          invoiceAmount: '1000.00',
          paidAmount: '200.00',
          remainingAmount: '800.00',
          overpaidAmount: '0.00',
        },
        schedules: [
          financeSchedule({
            id: 'stage-20',
            financeOrderId: 'finance-staged-partial',
            kind: 'invoice_prepayment',
            amount: 200,
            status: 'paid',
          }),
          financeSchedule({
            id: 'stage-30',
            financeOrderId: 'finance-staged-partial',
            kind: 'post_delivery',
            amount: 300,
            status: 'unpaid',
          }),
          financeSchedule({
            id: 'stage-50',
            financeOrderId: 'finance-staged-partial',
            kind: 'post_delivery',
            amount: 500,
            status: 'unpaid',
          }),
        ],
        operations: [],
      },
      {
        ...financeOrder,
        id: 'finance-operation-partial',
        commercialOrderId: 'commercial-operation-partial',
        commercialOrder: {
          ...financeOrder.commercialOrder,
          id: 'commercial-operation-partial',
        },
        amountValue: '1000.00',
        paymentStatus: 'partial',
        paymentSummary: {
          invoiceAmount: '1000.00',
          paidAmount: '200.00',
          remainingAmount: '800.00',
          overpaidAmount: '0.00',
        },
        schedules: [],
        operations: [
          financeOperation({
            id: 'payment-20',
            financeOrderId: 'finance-operation-partial',
          }),
        ],
      },
    ]);

    const [stagedPartial, operationPartial] = await fetchFinanceOrders();

    for (const order of [stagedPartial, operationPartial]) {
      expect(order.facts).toContainEqual(
        expect.objectContaining({ label: 'Оплачено', value: '200 ₽' }),
      );
      expect(order.facts).toContainEqual(
        expect.objectContaining({ label: 'Остаток', value: '800 ₽' }),
      );
    }
  });

  it('maps a pre-shipment schedule as an undated condition without retaining raw payloads', async () => {
    const responseSecret = 'finance-source-secret';
    stubFetch([
      {
        ...financeOrder,
        paymentTermsType: null,
        paymentPolicy: {
          id: 'policy-1',
          revision: 1,
          capturedProductionLeadDays: 2,
          invoiceExternalId: null,
          invoiceSourceVersion: null,
          capturedInvoiceAmount: null,
          capturedInvoiceCurrency: null,
          ...paymentPolicy,
          stages: [{ id: 'stage-1', ...paymentPolicy.stages[0], label: null }],
          rawPayload: responseSecret,
        },
        schedules: [
          financeSchedule({
            id: 'condition-row',
            kind: 'post_delivery',
            sequence: 1,
            trigger: 'full_shipment',
            percentageBasisPoints: 10000,
            offsetDays: 30,
            dueDate: null,
            dateKind: 'condition',
            amount: 1200,
            status: 'unpaid',
            rawPayload: responseSecret,
          }),
        ],
        rawPayload: responseSecret,
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.paymentPolicy).toMatchObject({ installmentDays: 30, revision: 1 });
    expect(result.paymentPolicy?.stages[0]).not.toHaveProperty('label');
    expect(result.paymentSchedules?.[0]).toMatchObject({
      dueDateIso: undefined,
      dueDateLabel: 'через 30 дней после полной отгрузки',
      dateKind: 'condition',
      percentageBasisPoints: 10000,
    });
    expect(JSON.stringify(result)).not.toContain(responseSecret);
    expect(JSON.stringify(result)).not.toContain('rawPayload');
  });

  it('keeps the optional legacy payment-term label when the current policy is null', async () => {
    stubFetch([{ ...financeOrder, paymentPolicy: null }]);

    const [result] = await fetchFinanceOrders();

    expect(result.paymentTermsType).toBe('prepay_50_postpay_50_30d');
    expect(result.paymentPolicy).toBeUndefined();
  });

  it('keeps the canonical numeric invoice amount separate from its display label', async () => {
    stubFetch([
      {
        ...financeOrder,
        amountValue: '1200.00',
        amountLabel: 'Демо-счёт',
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.financeAmountValue).toBe(1200);
  });

  it('keeps 1C invoice identity but discards its prices and maps imported payment totals', async () => {
    const responseSecret = 'must-not-reach-finance-ui';
    stubFetch([
      {
        ...financeOrder,
        amountValue: '1200.00',
        invoiceSyncState: 'posted',
        invoiceSourceCheckedAt: '2026-08-02T10:00:00.000Z',
        commercialOrder: {
          ...financeOrder.commercialOrder,
          commercialFinanceNote: '1200 за 20 рулонов',
        },
        invoice: {
          externalId: 'd8181c74-445a-4d75-b7f7-297ef6fb9868',
          sourceVersion: 'invoice-v3',
          sourceKind: '1C',
          staleness: 'fresh',
          capturedAt: null,
          importedAt: null,
          checkedAt: '2026-08-02T10:00:00.000Z',
          invoiceNumber: 'СЧ-77',
          date: '2026-08-01',
          amount: '1200.00',
          subtotal: '1000.00',
          taxTotal: '200.00',
          currency: 'RUB',
          posted: true,
          counterpartyExternalId: null,
          organizationExternalId: null,
          lines: [
            {
              lineNumber: 1,
              name: 'Плёнка',
              quantity: 20,
              price: '60.00',
              amount: '1200.00',
              taxRate: '20%',
              taxAmount: '200.00',
            },
          ],
          rawPayload: responseSecret,
        },
        paymentSummary: {
          invoiceAmount: '1200.00',
          paidAmount: '600.00',
          remainingAmount: '600.00',
          overpaidAmount: '0.00',
          rawPayload: responseSecret,
        },
        paymentTimeline: [
          {
            id: 'allocation-1',
            receiptId: 'receipt-1',
            receiptExternalId: 'payment-1c-1',
            receiptNumber: 'ПП-1',
            receivedAt: '2026-08-02T09:00:00.000Z',
            receiptAmount: '600.00',
            amount: '600.00',
            currency: 'RUB',
            sourceStatus: 'fresh',
            scheduleId: null,
            status: 'applied',
            matchKind: 'invoice_ref',
            reversesId: null,
            createdAt: '2026-08-02T10:01:00.000Z',
            rawPayload: responseSecret,
          },
        ],
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.commercialFinanceNote).toBe('1200 за 20 рулонов');
    expect(result.oneCInvoice).toMatchObject({
      invoiceNumber: 'СЧ-77',
      amount: null,
      subtotal: null,
      taxTotal: null,
      lines: [],
    });
    expect(result.financePaymentSummary).toEqual({
      invoiceAmount: '1200.00',
      paidAmount: '600.00',
      remainingAmount: '600.00',
      overpaidAmount: '0.00',
    });
    expect(result.financePaymentTimeline).toEqual([
      expect.objectContaining({ receiptNumber: 'ПП-1', amount: '600.00' }),
    ]);
    expect(JSON.stringify(result)).not.toContain(responseSecret);
    expect(JSON.stringify(result)).not.toContain('rawPayload');
  });

  it('projects the durable warehouse shipment into the selected finance command', async () => {
    stubFetch([
      {
        ...financeOrder,
        commercialOrder: {
          ...financeOrder.commercialOrder,
          shipmentStatus: 'shipped',
          shipmentCompletedAt: '2026-07-15T12:30:00.000Z',
        },
      },
    ]);

    const [result] = await fetchFinanceOrders();

    expect(result.facts).toContainEqual(
      expect.objectContaining({
        label: 'Дата отгрузки',
        value: 'Отгружено · 2026-07-15',
      }),
    );
    expect(getFinanceCommandItem(result).shipmentLabel).toBe('Отгружено · 2026-07-15');
  });

  it('previews a policy through the encoded order URL and returns only safe row fields', async () => {
    const fetchMock = stubFetch({
      rows: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 30,
          amount: 1200,
          date: null,
          dateKind: 'condition',
        },
      ],
    });

    const result = await previewFinancePaymentPolicy('finance / 1', {
      amount: 1200,
      paymentPolicy,
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/finance/orders/finance%20%2F%201/payment-policy/preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ amount: 1200, paymentPolicy });
    expect(result.rows).toEqual([
      {
        sequence: 1,
        trigger: 'full_shipment',
        percentageBasisPoints: 10000,
        offsetDays: 30,
        amount: 1200,
        date: null,
        dateKind: 'condition',
      },
    ]);
  });

  it.each([
    ['an extra raw field', { rows: [], rawPayload: { sourceSecret: true } }],
    ['a missing rows array', {}],
    [
      'a Decimal string where the DTO requires a numeric amount',
      {
        rows: [
          {
            sequence: 1,
            trigger: 'full_shipment',
            percentageBasisPoints: 10000,
            offsetDays: 30,
            amount: '1200.00',
            date: null,
            dateKind: 'condition',
          },
        ],
      },
    ],
    [
      'a row that does not echo the requested policy',
      {
        rows: [
          {
            sequence: 1,
            trigger: 'invoice_issued',
            percentageBasisPoints: 10000,
            offsetDays: 30,
            amount: 1200,
            date: null,
            dateKind: 'condition',
          },
        ],
      },
    ],
    [
      'an actual date fact without a canonical date',
      {
        rows: [
          {
            sequence: 1,
            trigger: 'full_shipment',
            percentageBasisPoints: 10000,
            offsetDays: 30,
            amount: 1200,
            date: null,
            dateKind: 'actual',
          },
        ],
      },
    ],
  ])('rejects a malformed payment-policy preview 2xx with %s', async (_label, body) => {
    stubFetch(body);

    await expect(
      previewFinancePaymentPolicy('finance / 1', {
        amount: 1200,
        paymentPolicy,
      }),
    ).rejects.toThrow('Некорректный ответ предварительного графика оплаты.');
  });

  it.each([
    ['an extra raw field', { ...paymentCorrectionResult, rawPayload: { sourceSecret: true } }],
    ['a missing payment fact', { ...paymentCorrectionResult, paymentStatus: undefined }],
    ['an unknown target enum', { ...paymentCorrectionResult, targetKind: 'legacy_target' }],
    ['a wrong target echo', { ...paymentCorrectionResult, targetId: 'another-schedule' }],
    [
      'a non-canonical timestamp',
      { ...paymentCorrectionResult, productionClearedAt: '10.08.2026 09:00' },
    ],
  ])('rejects a malformed payment-correction 2xx with %s', async (_label, body) => {
    stubFetch(body);

    await expect(
      correctFinancePayment('finance / 1', {
        operationKey: '00000000-0000-4000-8000-000000000303',
        target: { kind: 'schedule_confirmation', id: 'schedule / 1' },
        expectedPaymentStatus: 'paid',
        reason: 'Подтверждение внесено ошибочно',
      }),
    ).rejects.toMatchObject({
      name: 'ApiResponseParseError',
      deliveryUncertain: true,
    });
  });

  it('retains the exact correction UUID and payload after a malformed committed response', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000304';
    const command = {
      target: { kind: 'schedule_confirmation' as const, id: 'schedule / 1' },
      expectedPaymentStatus: 'paid' as const,
      reason: 'Подтверждение внесено ошибочно',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ...paymentCorrectionResult, paymentStatus: undefined }))
      .mockResolvedValueOnce(okResponse(paymentCorrectionResult));
    vi.stubGlobal('fetch', fetchMock);
    const gate = new IdempotentOperationGate(() => operationKey);
    const execute = () =>
      gate.start('finance:payment-correction:finance / 1:schedule / 1', (key) =>
        correctFinancePayment('finance / 1', { operationKey: key, ...command }),
      );

    await expect(execute()).rejects.toMatchObject({ deliveryUncertain: true });
    await expect(execute()).resolves.toEqual(paymentCorrectionResult);

    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)),
    ).toEqual([
      { operationKey, ...command },
      { operationKey, ...command },
    ]);
  });

  it('replaces a policy through the encoded order URL', async () => {
    const fetchMock = stubFetch({
      ...financeOrder,
      paymentTermsType: null,
      paymentPolicy: {
        id: 'policy-1',
        revision: 2,
        capturedProductionLeadDays: 2,
        invoiceExternalId: null,
        invoiceSourceVersion: null,
        capturedInvoiceAmount: null,
        capturedInvoiceCurrency: null,
        ...paymentPolicy,
        stages: [{ id: 'stage-1', ...paymentPolicy.stages[0], label: null }],
      },
    });

    const result = await setFinancePaymentPolicy('finance / 1', {
      expectedRevision: 1,
      reason: 'Согласовано с клиентом',
      paymentPolicy,
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/finance/orders/finance%20%2F%201/payment-policy');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      expectedRevision: 1,
      reason: 'Согласовано с клиентом',
      paymentPolicy,
    });
    expect(result.paymentPolicy?.revision).toBe(2);
  });

  it('records a payment fact and synchronizes its canonical partial status with one UUID', async () => {
    const partialOrder = {
      ...financeOrder,
      paymentStatus: 'partial',
      operations: [financeOperation({ id: 'server-payment-operation-400', amount: '400.00' })],
      paymentSummary: {
        invoiceAmount: '1200.00',
        paidAmount: '400.00',
        remainingAmount: '800.00',
        overpaidAmount: '0.00',
      },
      businessPayment: {
        ...financeOrder.businessPayment,
        status: 'partial',
        paidAmount: '400.00',
        remainingAmount: '800.00',
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(partialOrder))
      .mockResolvedValueOnce(okResponse(partialOrder));
    vi.stubGlobal('fetch', fetchMock);

    const result = await recordFinancePayment('finance-1', {
      operationKey: '00000000-0000-4000-8000-000000000304',
      operationType: 'manual_adjustment',
      amount: 400,
    });

    expect(
      fetchMock.mock.calls.map(([path, init]) => ({
        path,
        method: (init as RequestInit).method,
        body: JSON.parse((init as RequestInit).body as string),
      })),
    ).toEqual([
      {
        path: '/api/finance/orders/finance-1/payment-operations',
        method: 'POST',
        body: {
          operationKey: '00000000-0000-4000-8000-000000000304',
          operationType: 'manual_adjustment',
          amount: 400,
        },
      },
      {
        path: '/api/finance/orders/finance-1/payment-updates',
        method: 'POST',
        body: {
          operationKey: '00000000-0000-4000-8000-000000000304',
          paymentStatus: 'partial',
        },
      },
    ]);
    expect(result.statusLabel).toBe('Частично оплачен');
    expect(result.facts).toContainEqual(
      expect.objectContaining({ label: 'Оплачено', value: '400 ₽' }),
    );
    expect(result.paymentOperations).toEqual([
      expect.objectContaining({ id: 'server-payment-operation-400', amountLabel: '400 ₽' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('client-payment-update-');
  });

  it('retains the exact payment UUID and payload after a malformed committed response', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000307';
    const nextOperationKey = '00000000-0000-4000-8000-000000000308';
    const { paymentSummary: _summary, ...malformedOrder } = financeOrder;
    const paidOrder = {
      ...financeOrder,
      paymentStatus: 'paid',
      operations: [financeOperation({ id: 'server-payment-operation-1200', amount: '1200.00' })],
      paymentSummary: {
        invoiceAmount: '1200.00',
        paidAmount: '1200.00',
        remainingAmount: '0.00',
        overpaidAmount: '0.00',
      },
      businessPayment: {
        ...financeOrder.businessPayment,
        status: 'paid',
        paidAmount: '1200.00',
        remainingAmount: '0.00',
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(malformedOrder))
      .mockResolvedValueOnce(okResponse(paidOrder))
      .mockResolvedValueOnce(okResponse(paidOrder));
    vi.stubGlobal('fetch', fetchMock);
    const keys = [operationKey, nextOperationKey];
    const createKey = vi.fn(() => keys.shift() ?? crypto.randomUUID());
    const gate = new IdempotentOperationGate(createKey);
    const intent = 'finance:payment-operation:finance-1:manual_adjustment:1200.00';
    const execute = () =>
      gate.start(intent, (key) =>
        recordFinancePayment('finance-1', {
          operationKey: key,
          operationType: 'manual_adjustment',
          amount: 1200,
        }),
      );

    await expect(execute()).rejects.toMatchObject({ deliveryUncertain: true });
    await expect(execute()).resolves.toMatchObject({ statusLabel: 'Оплачено' });

    expect(createKey).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)),
    ).toEqual([
      { operationKey, operationType: 'manual_adjustment', amount: 1200 },
      { operationKey, operationType: 'manual_adjustment', amount: 1200 },
      { operationKey, paymentStatus: 'paid' },
    ]);
  });

  it('retains the payment UUID when the committed operation projection returns a conflict', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000312';
    const nextOperationKey = '00000000-0000-4000-8000-000000000313';
    const partialOrder = {
      ...financeOrder,
      paymentStatus: 'partial',
      operations: [financeOperation({ id: 'server-payment-operation-400', amount: '400.00' })],
      paymentSummary: {
        invoiceAmount: '1200.00',
        paidAmount: '400.00',
        remainingAmount: '800.00',
        overpaidAmount: '0.00',
      },
      businessPayment: {
        ...financeOrder.businessPayment,
        status: 'partial',
        paidAmount: '400.00',
        remainingAmount: '800.00',
      },
    };
    const projectionConflict = {
      ok: false,
      status: 409,
      json: async () => ({
        code: 'WAREHOUSE_COVERAGE_SNAPSHOT_STALE',
        message: 'Canonical order projection changed after the money fact committed.',
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(projectionConflict)
      .mockResolvedValueOnce(okResponse(partialOrder))
      .mockResolvedValueOnce(okResponse(partialOrder));
    vi.stubGlobal('fetch', fetchMock);
    const keys = [operationKey, nextOperationKey];
    const createKey = vi.fn(() => keys.shift() ?? crypto.randomUUID());
    const gate = new IdempotentOperationGate(createKey);
    const execute = () =>
      gate.start('finance:payment-operation:finance-1:manual_adjustment:400', (key) =>
        recordFinancePayment('finance-1', {
          operationKey: key,
          operationType: 'manual_adjustment',
          amount: 400,
        }),
      );

    await expect(execute()).rejects.toMatchObject({ deliveryUncertain: true });
    await expect(execute()).resolves.toMatchObject({ statusLabel: 'Частично оплачен' });

    expect(createKey).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)),
    ).toEqual([
      { operationKey, operationType: 'manual_adjustment', amount: 400 },
      { operationKey, operationType: 'manual_adjustment', amount: 400 },
      { operationKey, paymentStatus: 'partial' },
    ]);
  });

  it('retains the committed payment UUID when the status leg returns a terminal conflict', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000310';
    const nextOperationKey = '00000000-0000-4000-8000-000000000311';
    const partialOrder = {
      ...financeOrder,
      paymentStatus: 'partial',
      operations: [financeOperation({ id: 'server-payment-operation-400', amount: '400.00' })],
      paymentSummary: {
        invoiceAmount: '1200.00',
        paidAmount: '400.00',
        remainingAmount: '800.00',
        overpaidAmount: '0.00',
      },
      businessPayment: {
        ...financeOrder.businessPayment,
        status: 'partial',
        paidAmount: '400.00',
        remainingAmount: '800.00',
      },
    };
    const conflictResponse = {
      ok: false,
      status: 409,
      json: async () => ({
        code: 'FINANCE_PAYMENT_STATUS_FACT_CONFLICT',
        message: 'Payment status changed concurrently.',
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(partialOrder))
      .mockResolvedValueOnce(conflictResponse)
      .mockResolvedValueOnce(okResponse(partialOrder))
      .mockResolvedValueOnce(okResponse(partialOrder));
    vi.stubGlobal('fetch', fetchMock);
    const keys = [operationKey, nextOperationKey];
    const createKey = vi.fn(() => keys.shift() ?? crypto.randomUUID());
    const gate = new IdempotentOperationGate(createKey);
    const execute = () =>
      gate.start('finance:payment-operation:finance-1:manual_adjustment:400', (key) =>
        recordFinancePayment('finance-1', {
          operationKey: key,
          operationType: 'manual_adjustment',
          amount: 400,
        }),
      );

    await expect(execute()).rejects.toMatchObject({ deliveryUncertain: true });
    await expect(execute()).resolves.toMatchObject({ statusLabel: 'Частично оплачен' });

    expect(createKey).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)),
    ).toEqual([
      { operationKey, operationType: 'manual_adjustment', amount: 400 },
      { operationKey, paymentStatus: 'partial' },
      { operationKey, operationType: 'manual_adjustment', amount: 400 },
      { operationKey, paymentStatus: 'partial' },
    ]);
  });

  it('fails closed when a committed operation has no canonical invoice remainder', async () => {
    const fetchMock = stubFetch({
      ...financeOrder,
      paymentSummary: {
        ...financeOrder.paymentSummary,
        invoiceAmount: null,
        remainingAmount: null,
      },
      businessPayment: {
        ...financeOrder.businessPayment,
        remainingAmount: null,
      },
    });

    await expect(
      recordFinancePayment('finance-1', {
        operationKey: '00000000-0000-4000-8000-000000000309',
        operationType: 'manual_adjustment',
        amount: 400,
      }),
    ).rejects.toMatchObject({ deliveryUncertain: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('changes fixed payment terms without accepting dates or amounts', async () => {
    const scheduledOrder = {
      ...financeOrder,
      paymentTermsType: 'postpay_100_30d',
      schedules: [financeSchedule()],
    };
    const fetchMock = stubFetch(scheduledOrder);

    const result = await setFinancePaymentTerms('finance-1', {
      paymentTermsType: 'postpay_100_30d',
      reason: 'Согласовано с клиентом',
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/finance/orders/finance-1/payment-terms');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      paymentTermsType: 'postpay_100_30d',
      reason: 'Согласовано с клиентом',
    });
    expect(result.paymentSchedules?.[0]).toMatchObject({
      kind: 'post_delivery',
      dueDateIso: undefined,
    });
  });

  it('confirms one concrete payment row with the accountant check action', async () => {
    const fetchMock = stubFetch({ ...financeOrder, paymentStatus: 'partial' });

    const result = await confirmFinancePaymentSchedule(
      'finance-1',
      'schedule 1',
      '00000000-0000-4000-8000-000000000305',
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/finance/orders/finance-1/payment-schedules/schedule%201/confirm');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      operationKey: '00000000-0000-4000-8000-000000000305',
    });
    expect(result.statusLabel).toBe('Частично оплачен');
  });

  it('rejects a malformed committed payment response without hiding the exact operation key', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000306';
    const { paymentSummary: _summary, ...malformedOrder } = financeOrder;
    const fetchMock = stubFetch(malformedOrder);

    await expect(
      updateFinancePayment('finance-1', {
        operationKey,
        paymentStatus: 'partial',
      }),
    ).rejects.toMatchObject({ deliveryUncertain: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      operationKey,
      paymentStatus: 'partial',
    });
  });

  it('refreshes an exact invoice with an idempotency key and then reads the safe order', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000301';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          financeOrderId: 'finance-1',
          orderReference: 'PLENKA_ORDER=A-77',
          invoiceSyncState: 'posted',
          candidateCount: 1,
          candidates: [],
          invoice: null,
        }),
      )
      .mockResolvedValueOnce(okResponse(financeOrder));
    vi.stubGlobal('fetch', fetchMock);

    await retryFinanceSource('finance / 1', operationKey);

    expect(fetchMock.mock.calls).toEqual([
      [
        '/api/finance/orders/finance%20%2F%201/source-retry',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ operationKey }),
        }),
      ],
      ['/api/finance/orders/finance%20%2F%201', expect.objectContaining({ method: 'GET' })],
    ]);
  });

  it('imports 1C receipts and exposes reconciliation and manual allocation endpoints', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000302';
    const receipt = {
      id: 'receipt-1',
      externalId: 'payment-ref-1',
      sourceVersion: 'payment-v1',
      number: 'ПП-1',
      receivedAt: '2026-08-02T09:00:00.000Z',
      amount: '1200.00',
      allocatedAmount: '0.00',
      remainingAmount: '1200.00',
      currency: 'RUB',
      posted: true,
      deleted: false,
      sourceStatus: 'fresh',
      matchState: 'proposal',
      matchKind: 'invoice_number_proposal',
      candidateFinanceOrderIds: ['finance-1'],
      capturedAt: '2026-08-02T09:00:00.000Z',
      allocations: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          imported: 1,
          matched: 0,
          autoApplied: 0,
          proposals: 1,
          ambiguous: 0,
          unmatched: 0,
          reversed: 0,
          skipped: 0,
          replayed: false,
        }),
      )
      .mockResolvedValueOnce(okResponse([receipt]))
      .mockResolvedValueOnce(okResponse([{ id: 'allocation-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    await syncOneCPayments(operationKey);
    await expect(fetchFinanceReconciliation()).resolves.toEqual([receipt]);
    await resolveFinancePaymentAllocation('receipt / 1', {
      operationKey,
      reason: 'Сверено по банковской выписке',
      allocations: [{ financeOrderId: 'finance-1', amount: 1200 }],
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/finance/payment-source-sync',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operationKey }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/finance/reconciliation');
    expect(fetchMock.mock.calls[2]).toEqual([
      '/api/finance/payment-allocations/receipt%20%2F%201/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          operationKey,
          reason: 'Сверено по банковской выписке',
          allocations: [{ financeOrderId: 'finance-1', amount: 1200 }],
        }),
      }),
    ]);
  });
});

function serverCoverageProjection() {
  const specification = {
    filmType: 'Рукав',
    actualThicknessMicron: 80,
    accountingThicknessMicron: 78,
    widthMm: 1_200,
    plannedLengthM: 800,
    netKg: 41,
    spoolType: 'Тонкая',
    birka: 'ГОСТ',
    materialLabel: 'ПВД первичный',
  };
  return {
    workflowVersion: 2,
    state: 'awaiting_finance',
    stateVersion: 4,
    generation: 3,
    availability: 'verified_full',
    reasonCodes: ['full_cover_available'],
    nextOwner: 'finance',
    availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
    requiredRollCount: 2,
    matchedRollCount: 2,
    uncertainRollCount: 0,
    calculatedAt: '2026-07-24T10:00:00.000Z',
    stale: false,
    financeRolls: [
      {
        rollCode: 'ROLL-001',
        positionId: 'position-real-id',
        source: 'platform',
        locationLabel: 'Свободный резерв',
        availability: 'available',
        batchCode: 'ПАРТИЯ-1',
        receivedAt: '2026-08-06T01:00:00.000Z',
        grossKg: 41.9,
        spoolKg: 0.7,
        requested: { ...specification },
        matched: { ...specification, netKg: 41.2 },
      },
    ],
  };
}

describe('finance warehouse coverage v2 adapter', () => {
  const refreshInput = {
    clientRequestId: '00000000-0000-4000-8000-000000000221',
    expectedGeneration: 3,
    expectedStateVersion: 4,
  };
  const decisionInput = {
    clientRequestId: '00000000-0000-4000-8000-000000000222',
    expectedGeneration: 3,
    expectedStateVersion: 4,
    decision: 'use_warehouse' as const,
  };
  const recheckInput = {
    clientRequestId: '00000000-0000-4000-8000-000000000223',
    expectedGeneration: 3,
    expectedStateVersion: 4,
    reason: 'Нужно подтвердить фактическое состояние рулонов',
  };

  it('reads the exact protected projection by an encoded finance order id', async () => {
    const response = serverCoverageProjection();
    const fetchMock = stubFetch(response);

    await expect(financeCoverageApi.read('finance / real-id')).resolves.toEqual(
      normalizeFinanceWarehouseCoverage(response),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/finance/orders/finance%20%2F%20real-id/warehouse-coverage',
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('GET');
  });

  it('fails closed when the protected read contains an unexpected exact-roll key', async () => {
    stubFetch({
      ...serverCoverageProjection(),
      financeRolls: [
        {
          ...serverCoverageProjection().financeRolls[0],
          rollId: 'secret-roll-id',
        },
      ],
    });

    await expect(financeCoverageApi.read('finance-real-id')).rejects.toThrow(/extra key.*rollId/u);
  });

  it('keeps a failed protected read live-only at a small viewport', async () => {
    vi.stubGlobal('innerWidth', 390);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(financeCoverageApi.read('finance-real-id')).rejects.toThrow('network unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/finance/orders/finance-real-id/warehouse-coverage',
    );
  });

  it('uses exact finance ids, routes, request bodies, and strict response normalizers', async () => {
    const refreshResponse = serverCoverageProjection();
    const decisionResponse = {
      ...serverCoverageProjection(),
      state: 'warehouse_reserved',
      stateVersion: 5,
      availableActions: [],
    };
    const recheckResponse = {
      ...serverCoverageProjection(),
      state: 'recheck_requested',
      stateVersion: 5,
      reasonCodes: ['warehouse_recheck_pending'],
      availableActions: [],
      caseId: 'case-real-id',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(refreshResponse))
      .mockResolvedValueOnce(okResponse(decisionResponse))
      .mockResolvedValueOnce(okResponse(recheckResponse));
    vi.stubGlobal('fetch', fetchMock);

    await expect(financeCoverageApi.refresh('finance / real-id', refreshInput)).resolves.toEqual(
      normalizeFinanceWarehouseCoverage(refreshResponse),
    );
    await expect(financeCoverageApi.decide('finance / real-id', decisionInput)).resolves.toEqual(
      normalizeFinanceWarehouseCoverage(decisionResponse),
    );
    await expect(
      financeCoverageApi.requestRecheck('finance / real-id', recheckInput),
    ).resolves.toEqual(normalizeFinanceWarehouseCoverageWithCase(recheckResponse));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/finance/orders/finance%20%2F%20real-id/warehouse-coverage/refresh',
      '/api/finance/orders/finance%20%2F%20real-id/warehouse-coverage/decide',
      '/api/finance/orders/finance%20%2F%20real-id/warehouse-coverage/recheck',
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)),
    ).toEqual([refreshInput, decisionInput, recheckInput]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/WH-COVER-/u);
  });

  it('fails closed on a malformed finance response instead of returning unchecked json', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          ...serverCoverageProjection(),
          financeRolls: [
            {
              ...serverCoverageProjection().financeRolls[0],
              rollId: 'secret-roll-id',
            },
          ],
        }),
      ),
    );

    await expect(financeCoverageApi.refresh('finance-real-id', refreshInput)).rejects.toThrow(
      /extra key.*rollId/u,
    );
  });

  it('keeps the same client UUID across an uncertain retry through IdempotentOperationGate', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000224';
    const gate = new IdempotentOperationGate(() => operationKey);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse(serverCoverageProjection()));
    vi.stubGlobal('fetch', fetchMock);
    const execute = () =>
      gate.start('finance:coverage:refresh:finance-real-id', (clientRequestId) =>
        financeCoverageApi.refresh('finance-real-id', {
          expectedGeneration: 3,
          expectedStateVersion: 4,
          clientRequestId,
        }),
      );

    await expect(execute()).rejects.toThrow('Failed to fetch');
    await expect(execute()).resolves.toEqual(
      normalizeFinanceWarehouseCoverage(serverCoverageProjection()),
    );
    expect(
      fetchMock.mock.calls.map(
        ([, init]) => JSON.parse((init as RequestInit).body as string).clientRequestId,
      ),
    ).toEqual([operationKey, operationKey]);
  });

  it('never switches to viewport-driven fixture data after a failed request', async () => {
    vi.stubGlobal('innerWidth', 390);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(financeCoverageApi.refresh('finance-real-id', refreshInput)).rejects.toThrow(
      'network unavailable',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
