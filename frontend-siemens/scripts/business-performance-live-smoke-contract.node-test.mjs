import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertBusinessPerformanceRoleParity,
  assertSafeBusinessProblemPage,
  assertSafeBusinessRollPage,
} from './business-performance-live-smoke-contract.mjs';

const source = {
  kind: 'platform_runtime',
  status: 'ready',
  freshness: 'fresh',
  generatedAt: '2026-08-07T03:00:00.000Z',
};

const financePage = {
  items: [
    {
      id: 'finance-1',
      orderNumber: 'A-5',
      counterpartyName: 'Контур',
      invoiceStatus: 'issued',
      paymentStatus: 'awaiting',
      paymentPlanKind: 'half_split',
      paymentPlanLabel: '50/50',
      invoicedAmount: 100_000,
      paidAmount: 50_000,
      remainingAmount: 50_000,
      nextConfirmedDueAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-07T02:55:00.000Z',
    },
  ],
  nextCursor: null,
  source,
};

const rollPage = {
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
      status: 'warehouse_accepted',
      lifecycleStatus: 'warehouse_accepted',
      createdAt: '2026-08-07T02:00:00.000Z',
      completedAt: '2026-08-07T02:40:00.000Z',
      weights: {
        plannedNetKg: 41.2,
        actualNetKg: 42.3,
        actualGrossKg: 44.1,
        deviationKg: 1.1,
      },
      productionCost: {
        kind: 'actual_snapshot',
        status: 'complete',
        calculationVersion: 'production-cost-v1',
        snapshotId: 'cost-snapshot-1',
        version: 2,
        producedAt: '2026-08-07T02:30:00.000Z',
        closedAt: '2026-08-07T02:40:00.000Z',
        createdAt: '2026-08-07T02:40:01.000Z',
        basis: { kind: 'actual', weightGrams: 42_300 },
        materialAmountKopecks: 30_000,
        spoolAmountKopecks: 9_000,
        payrollAmountKopecks: 4_000,
        payrollSource: {
          tariffOrderId: 'payroll-order-1',
          tariffOrderName: 'Приказ № 1',
          effectiveFrom: '2026-08-01',
          rateKopecksPerKg: 4_000,
          basisLabel: 'Основная ставка',
        },
        additionalAmountKopecks: 500,
        totalAmountKopecks: 43_500,
        totalKopecksPerKg: 1_028,
        unresolvedReasons: [],
      },
    },
  ],
  nextCursor: null,
};

const problemPage = {
  items: [
    {
      id: 'problem-1',
      orderId: 'order-5',
      kind: 'defect',
      status: 'open',
      label: 'Брак рулона',
      createdAt: '2026-08-07T02:50:00.000Z',
      orderNumber: 'A-5',
      rollCode: 'ROLL-1',
      machineName: 'Экструдер 1',
      reason: 'Неровная кромка',
    },
  ],
  nextCursor: null,
};

const warehousePage = {
  items: [
    {
      kind: 'reserve',
      id: 'reserve-1',
      templates: [
        {
          fingerprint: 'a'.repeat(64),
          filmType: 'Полотно',
          actualThicknessMicron: 70,
          accountingThicknessMicron: 70,
          widthMm: 1700,
          plannedLengthM: 275,
          birka: 'Резерв',
          spoolType: '76 мм',
          plannedWeightKg: 37.5,
          recipeVersion: 'v1',
        },
      ],
      status: 'reserve',
      orderNumber: 'S-1',
      counterpartyName: null,
    },
  ],
  page: 1,
  pageSize: 100,
  total: 1,
};

const control = {
  range: {
    timezone: 'Europe/Moscow',
    requested: { from: '2026-08-01', to: '2026-08-07' },
    effective: {
      fromUtc: '2026-07-31T21:00:00.000Z',
      toExclusiveUtc: '2026-08-07T21:00:00.000Z',
    },
    bucket: 'day',
    generatedAt: source.generatedAt,
  },
  source,
  summary: {
    invoicedAmount: 100_000,
    paidAmount: 50_000,
    receivableAmount: 50_000,
    overdueAmount: 0,
    producedKg: 42.3,
    producedRolls: 1,
    defectKg: 0,
    defectRollCount: 0,
    returnedSpoolCount: 0,
    warehouseAcceptedRolls: 1,
  },
  productionSeries: [{ bucketStartDate: '2026-08-07', rollCount: 1, producedKg: 42.3 }],
  productionQualitySeries: [
    {
      id: 'day:2026-08-07',
      bucketStartDate: '2026-08-07',
      producedRollCount: 1,
      producedKg: 42.3,
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
      documentCount: 1,
      excludedOutputLineCount: 0,
      excludedMaterialLineCount: 0,
    },
    productionSeries: [{ bucketStartDate: '2026-08-07', documentCount: 1, producedKg: 42.3 }],
    materialSeries: [{ bucketStartDate: '2026-08-07', consumedKg: 41.8 }],
  },
  commercialApplications: {
    definition: 'submitted',
    asOfDate: '2026-08-07',
    periods: [
      {
        period: 'week',
        fromDate: '2026-08-01',
        toDate: '2026-08-07',
        totalCount: 2,
        clientOrderCount: 1,
        stockReserveCount: 1,
      },
    ],
  },
};

test('accepts equal role payloads while ignoring only response-generation time', () => {
  const director = structuredClone(financePage);
  director.source.generatedAt = '2026-08-07T03:00:01.000Z';

  assert.doesNotThrow(() => assertBusinessPerformanceRoleParity('Финансы', financePage, director));
});

test('rejects a commercial/director business-data mismatch', () => {
  const director = structuredClone(financePage);
  director.items[0].paidAmount = 49_999;

  assert.throws(
    () => assertBusinessPerformanceRoleParity('Финансы', financePage, director),
    /commercial\/director payload mismatch/u,
  );
});

test('rejects an inconsistent persisted payment label', () => {
  const invalid = structuredClone(financePage);
  invalid.items[0].paymentPlanLabel = '100%';

  assert.throws(
    () => assertBusinessPerformanceRoleParity('Финансы', invalid, invalid),
    /payment plan label/u,
  );
});

test('accepts the complete safe Control contract', () => {
  assert.doesNotThrow(() => assertBusinessPerformanceRoleParity('Контроль', control, control));
});

test('accepts the exact current warehouse page contract and rejects internal fields', () => {
  assert.doesNotThrow(() =>
    assertBusinessPerformanceRoleParity('Склад', warehousePage, warehousePage),
  );
  const unsafe = structuredClone(warehousePage);
  unsafe.items[0].rawPayload = { source: 'must-not-leak' };
  assert.throws(
    () => assertBusinessPerformanceRoleParity('Склад', unsafe, unsafe),
    /fields must match the safe allowlist/u,
  );
});

const CONTROL_NESTED_LEAKS = [
  ['source', (value) => (value.source.tokenHash = 'must-not-leak')],
  ['range', (value) => (value.range.internalRangeId = 'must-not-leak')],
  ['range requested', (value) => (value.range.requested.actorId = 'must-not-leak')],
  ['range effective', (value) => (value.range.effective.sessionId = 'must-not-leak')],
  ['summary', (value) => (value.summary.rawPayload = 'must-not-leak')],
  ['production series item', (value) => (value.productionSeries[0].postId = 'must-not-leak')],
  [
    'production quality item',
    (value) => (value.productionQualitySeries[0].deviceId = 'must-not-leak'),
  ],
  [
    'accounting production',
    (value) => (value.accountingProduction.sourceSnapshotId = 'must-not-leak'),
  ],
  [
    'accounting source',
    (value) => (value.accountingProduction.source.rawPayload = 'must-not-leak'),
  ],
  [
    'accounting coverage',
    (value) => (value.accountingProduction.coverage.operationId = 'must-not-leak'),
  ],
  [
    'accounting production series item',
    (value) => (value.accountingProduction.productionSeries[0].postId = 'must-not-leak'),
  ],
  [
    'accounting material series item',
    (value) => (value.accountingProduction.materialSeries[0].deviceId = 'must-not-leak'),
  ],
  [
    'commercial applications',
    (value) => (value.commercialApplications.requestFingerprint = 'must-not-leak'),
  ],
  [
    'commercial application period',
    (value) => (value.commercialApplications.periods[0].actorId = 'must-not-leak'),
  ],
];

for (const [label, injectLeak] of CONTROL_NESTED_LEAKS) {
  test(`rejects an internal Control field in ${label}`, () => {
    const unsafe = structuredClone(control);
    injectLeak(unsafe);

    assert.throws(
      () => assertBusinessPerformanceRoleParity('Контроль', unsafe, unsafe),
      /fields must match the safe allowlist/u,
    );
  });
}

test('strictly rejects internal roll and problem fields', () => {
  assert.doesNotThrow(() => assertSafeBusinessRollPage(rollPage));
  assert.doesNotThrow(() => assertSafeBusinessProblemPage(problemPage));

  assert.throws(
    () =>
      assertSafeBusinessRollPage({
        ...rollPage,
        items: [{ ...rollPage.items[0], postId: 'must-not-leak' }],
      }),
    /roll item 0 fields/u,
  );
  assert.throws(() => {
    const unsafe = structuredClone(rollPage);
    unsafe.items[0].productionCost.rawSources = [{ deviceId: 'must-not-leak' }];
    assertSafeBusinessRollPage(unsafe);
  }, /production cost fields/u);
  assert.throws(
    () =>
      assertSafeBusinessProblemPage({
        ...problemPage,
        items: [{ ...problemPage.items[0], detail: { actorId: 'must-not-leak' } }],
      }),
    /problem item 0 fields/u,
  );
  assert.throws(
    () =>
      assertSafeBusinessProblemPage({
        ...problemPage,
        items: [{ ...problemPage.items[0], orderId: 42 }],
      }),
    /problem item 0 orderId/u,
  );
});

test('accepts only the complete canonical operational problem-kind union', () => {
  for (const kind of [
    'weight_deviation',
    'general',
    'raw_material_shortage',
    'defect',
    'machine_breakdown',
  ]) {
    assert.doesNotThrow(() =>
      assertSafeBusinessProblemPage({
        ...problemPage,
        items: [{ ...problemPage.items[0], kind }],
      }),
    );
  }
  assert.throws(
    () =>
      assertSafeBusinessProblemPage({
        ...problemPage,
        items: [{ ...problemPage.items[0], kind: 'internal_problem_kind' }],
      }),
    /unknown kind/u,
  );
});

test('strictly rejects duplicate or noncanonical production-cost reasons', () => {
  for (const reasons of [
    ['spool_price_unresolved', 'spool_price_unresolved'],
    ['spool_geometry_unresolved', 'spool_price_unresolved'],
  ]) {
    const unsafe = structuredClone(rollPage);
    Object.assign(unsafe.items[0].productionCost, {
      status: 'partial',
      spoolAmountKopecks: null,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: reasons,
    });

    assert.throws(() => assertSafeBusinessRollPage(unsafe), /canonical and unique/u);
  }
});

test('accepts only the safe canonical payroll source contract', () => {
  const withoutSource = structuredClone(rollPage);
  withoutSource.items[0].productionCost.payrollSource = null;
  assert.doesNotThrow(() => assertSafeBusinessRollPage(withoutSource));

  const unsafeField = structuredClone(rollPage);
  unsafeField.items[0].productionCost.payrollSource.rawPayload = { source: 'must-not-leak' };
  assert.throws(() => assertSafeBusinessRollPage(unsafeField), /payroll source fields/u);

  const invalidDate = structuredClone(rollPage);
  invalidDate.items[0].productionCost.payrollSource.effectiveFrom = '2026-02-30';
  assert.throws(() => assertSafeBusinessRollPage(invalidDate), /canonical calendar date/u);

  const invalidRate = structuredClone(rollPage);
  invalidRate.items[0].productionCost.payrollSource.rateKopecksPerKg = -1;
  assert.throws(() => assertSafeBusinessRollPage(invalidRate), /safe non-negative integer/u);
});
