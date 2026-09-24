const source = {
  kind: 'platform_runtime',
  status: 'ready',
  freshness: 'fresh',
  generatedAt: '2026-08-07T00:15:00.000Z',
};

export const businessPerformanceControlFixture = {
  range: {
    timezone: 'Europe/Moscow',
    requested: { from: '2026-07-09', to: '2026-08-07' },
    effective: {
      fromUtc: '2026-07-08T21:00:00.000Z',
      toExclusiveUtc: '2026-08-07T21:00:00.000Z',
    },
    bucket: 'day',
    generatedAt: source.generatedAt,
  },
  source,
  summary: {
    invoicedAmount: 840000,
    paidAmount: 620000,
    receivableAmount: 220000,
    overdueAmount: 0,
    producedKg: 486.3,
    producedRolls: 12,
    defectKg: 4.2,
    defectRollCount: 1,
    returnedSpoolCount: 0,
    warehouseAcceptedRolls: 11,
  },
  productionSeries: [
    { bucketStartDate: '2026-08-06', rollCount: 7, producedKg: 282.1 },
    { bucketStartDate: '2026-08-07', rollCount: 5, producedKg: 204.2 },
  ],
  productionQualitySeries: [
    {
      id: 'production-quality-2026-08-06',
      bucketStartDate: '2026-08-06',
      producedRollCount: 7,
      producedKg: 282.1,
      defectRecordCount: 1,
      defectiveRollCount: 1,
      verifiedDefectKg: 4.2,
      unverifiedDefectCount: 0,
      returnedSpoolCount: 0,
    },
    {
      id: 'production-quality-2026-08-07',
      bucketStartDate: '2026-08-07',
      producedRollCount: 5,
      producedKg: 204.2,
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
};

const page = {
  items: [],
  nextCursor: null,
  source,
};

const evidencePage = {
  items: [],
  nextCursor: null,
};

const performancePath = '/api/commercial/performance';
const productionRollsPath = /^\/api\/commercial\/performance\/production\/[^/]+\/rolls$/;

function directorAnalyticsFixture(url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const bucket = url.searchParams.get('bucket');
  if (!from || !to || !['day', 'week', 'month'].includes(bucket)) return null;

  return {
    range: {
      timezone: 'Europe/Moscow',
      requested: { from, to },
      effective: {
        fromUtc: `${from}T00:00:00.000Z`,
        toExclusiveUtc: `${to}T23:59:59.999Z`,
      },
      bucket,
      generatedAt: source.generatedAt,
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
      explanation: 'В smoke-fixture используются только измеренные производственные факты.',
    },
    commercialApplications: {
      definition: 'submitted',
      asOfDate: to,
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
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

export async function installBusinessPerformanceSmokeFixture(
  browserPage,
  {
    financeItems = [],
    controlResponse = businessPerformanceControlFixture,
    shiftEvidenceResponse = evidencePage,
    bigBagEvidenceResponse = evidencePage,
  } = {},
) {
  await browserPage.route('**/api/director/analytics**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/director/analytics') {
      return json(route, { error: 'Unhandled director analytics smoke fixture route' }, 500);
    }
    const response = directorAnalyticsFixture(url);
    return response
      ? json(route, response)
      : json(route, { error: 'Invalid director analytics smoke fixture query' }, 400);
  });

  await browserPage.route('**/api/commercial/performance/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === `${performancePath}/control`) return json(route, controlResponse);
    if (pathname === `${performancePath}/control/shift-balances`) {
      return json(route, shiftEvidenceResponse);
    }
    if (pathname === `${performancePath}/control/big-bags`) {
      return json(route, bigBagEvidenceResponse);
    }
    if (pathname === `${performancePath}/finance`) {
      return json(route, { ...page, items: financeItems });
    }
    if (pathname === `${performancePath}/production`) return json(route, page);
    if (pathname === `${performancePath}/warehouse`) return json(route, page);
    if (pathname === `${performancePath}/problems`) {
      return json(route, {
        items: [
          {
            id: 'smoke-problem',
            kind: 'defect',
            status: 'open',
            label: 'Брак рулона',
            createdAt: source.generatedAt,
            orderNumber: 'A-17',
            rollCode: 'ROLL-17',
            machineName: 'Экструдер 2',
            reason: 'Неровная кромка',
          },
        ],
        nextCursor: null,
      });
    }
    if (productionRollsPath.test(pathname)) {
      return json(route, { items: [], nextCursor: null });
    }
    return json(route, { error: 'Unhandled business-performance smoke fixture route' }, 500);
  });
}
