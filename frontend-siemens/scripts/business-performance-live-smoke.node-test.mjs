import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createBusinessPerformanceLiveSmoke } from './business-performance-live-smoke.mjs';

const source = {
  kind: 'platform_runtime',
  status: 'ready',
  freshness: 'fresh',
  generatedAt: '2026-08-07T04:00:00.000Z',
};
const page = (items) => ({ items, nextCursor: null, source });
const orderNumber = 'A-5';
const productionOrderId = 'production-1';
const responses = {
  control: {
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
      paidAmount: 0,
      receivableAmount: 100_000,
      overdueAmount: 0,
      producedKg: 0,
      producedRolls: 0,
      defectKg: 0,
      defectRollCount: 0,
      returnedSpoolCount: 0,
      warehouseAcceptedRolls: 0,
    },
    productionSeries: [{ bucketStartDate: '2026-08-07', rollCount: 0, producedKg: 0 }],
    productionQualitySeries: [
      {
        id: 'production-quality-2026-08-07',
        bucketStartDate: '2026-08-07',
        producedRollCount: 0,
        producedKg: 0,
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
  },
  finance: page([
    {
      id: 'finance-1',
      orderNumber,
      counterpartyName: 'Контур',
      invoiceStatus: 'issued',
      paymentStatus: 'awaiting',
      paymentPlanKind: 'full',
      paymentPlanLabel: '100%',
      invoicedAmount: 100_000,
      paidAmount: 0,
      remainingAmount: 100_000,
      nextConfirmedDueAt: '2026-09-06T00:00:00.000Z',
      updatedAt: source.generatedAt,
    },
  ]),
  production: page([
    {
      id: productionOrderId,
      orderNumber,
      productionStatus: 'active',
      lifecycleStatus: 'in_production',
      plannedRollCount: 1,
      completedRollCount: 0,
      plannedKg: 41.2,
      actualKg: null,
      defectKg: 0,
      defectRollCount: 0,
      returnedSpoolCount: 0,
      createdAt: '2026-08-07T02:00:00.000Z',
      completedAt: null,
      updatedAt: source.generatedAt,
    },
  ]),
  warehouse: { items: [], page: 1, pageSize: 100, total: 0 },
  problems: { items: [], nextCursor: null },
  rolls: {
    items: [
      {
        id: 'dispatch-1',
        rollName: 'Рукав 80 мкм',
        rollCode: 'ROLL-1',
        orderNumber,
        parameters: {
          filmType: 'Рукав',
          actualThicknessUm: 80,
          accountingThicknessUm: 78,
          widthMm: 1_700,
          plannedLengthM: 275,
          weightKg: 41.2,
        },
        operatorName: null,
        machineName: null,
        priority: 1,
        status: 'in_production',
        lifecycleStatus: 'in_production',
        createdAt: '2026-08-07T02:00:00.000Z',
        completedAt: null,
        weights: {
          plannedNetKg: 41.2,
          actualNetKg: null,
          actualGrossKg: null,
          deviationKg: null,
        },
        productionCost: {
          kind: 'planned_preview',
          status: 'complete',
          calculationVersion: 'production-cost-v1',
          basis: { kind: 'planned', weightGrams: 41_200 },
          materialAmountKopecks: 21_000,
          spoolAmountKopecks: 9_000,
          payrollAmountKopecks: 3_000,
          payrollSource: {
            tariffOrderId: 'payroll-order-1',
            tariffOrderName: 'Приказ № 1',
            effectiveFrom: '2026-08-01',
            rateKopecksPerKg: 3_000,
            basisLabel: 'Основная ставка',
          },
          additionalAmountKopecks: 0,
          totalAmountKopecks: 33_000,
          totalKopecksPerKg: 801,
          unresolvedReasons: [],
        },
      },
    ],
    nextCursor: null,
  },
};

test('keeps the exact current 12-column production roll drilldown contract', async () => {
  const helper = await readFile(
    new URL('./business-performance-live-smoke.mjs', import.meta.url),
    'utf8',
  );
  const drilldown = helper.slice(
    helper.indexOf('async function assertProductionDrilldown'),
    helper.indexOf('\n  async function assertDirectorOnlyBoundary'),
  );
  const expected = [
    'Рулон',
    'Заказ',
    'Параметры',
    'Оператор',
    'Станок',
    'Приоритет',
    'План нетто',
    'Факт нетто',
    'Факт брутто',
    'Отклонение',
    'Статус',
    'Себестоимость',
  ];
  assert.deepEqual(
    [...drilldown.matchAll(/^\s{12}'([^']+)',$/gmu)].map((match) => match[1]),
    expected,
  );
});

function responseFor(pathname) {
  if (pathname.includes('/control?')) return responses.control;
  if (pathname.includes('/finance?')) return responses.finance;
  if (pathname.includes('/production?')) return responses.production;
  if (pathname.includes('/warehouse?')) return responses.warehouse;
  if (pathname.includes('/problems?')) return responses.problems;
  if (pathname.includes('/rolls?')) return responses.rolls;
  throw new Error(`Unexpected path: ${pathname}`);
}

test('queries both roles for all five shared sections and the safe roll drilldown', async () => {
  const calls = [];
  const smoke = createBusinessPerformanceLiveSmoke({
    async apiRequest(pathname, options) {
      calls.push([pathname, options.token]);
      return structuredClone(responseFor(pathname));
    },
    assert,
    focusRefresh() {
      throw new Error('Browser path is outside this contract test');
    },
    openTopNavigationSection() {
      throw new Error('Browser path is outside this contract test');
    },
    waitUntil() {
      throw new Error('Browser path is outside this contract test');
    },
  });

  await smoke.assertApiContract(
    {
      commercial: { token: 'commercial-token' },
      director: { token: 'director-token' },
    },
    orderNumber,
    productionOrderId,
  );

  assert.equal(calls.length, 12);
  assert.deepEqual(
    calls.map(([, token]) => token),
    Array.from({ length: 6 }, () => ['commercial-token', 'director-token']).flat(),
  );
  assert.deepEqual(
    calls.map(([pathname]) => new URL(pathname, 'https://plenka.test').pathname),
    [
      '/api/commercial/performance/control',
      '/api/commercial/performance/control',
      '/api/commercial/performance/finance',
      '/api/commercial/performance/finance',
      '/api/commercial/performance/production',
      '/api/commercial/performance/production',
      '/api/commercial/performance/warehouse',
      '/api/director/performance/warehouse',
      '/api/commercial/performance/problems',
      '/api/commercial/performance/problems',
      `/api/commercial/performance/production/${productionOrderId}/rolls`,
      `/api/commercial/performance/production/${productionOrderId}/rolls`,
    ],
  );
  assert.deepEqual(
    calls
      .map(([pathname]) => pathname)
      .filter((pathname) => pathname.includes('/performance/warehouse')),
    [
      '/api/commercial/performance/warehouse?page=1&pageSize=100',
      '/api/director/performance/warehouse?page=1&pageSize=100',
    ],
  );
});
