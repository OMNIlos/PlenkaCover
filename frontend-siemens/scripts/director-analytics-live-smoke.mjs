import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import * as onec from './director-accounting-production-smoke-helpers.mjs';

const frontendDir = process.cwd();
const port = Number(process.env.DIRECTOR_ANALYTICS_SMOKE_PORT ?? 5217);
const baseUrl = `http://127.0.0.1:${port}`;
const token = 'qa-director-analytics-token';
const expiresAt = '2099-01-01T00:00:00.000Z';
const aggregateRequests = [];
const drilldownRequests = [];
const evidenceRequests = [];
const fixtureValueByBucket = {
  day: 111.111,
  week: 222.222,
  month: 333.333,
};
const fixtureValueByDayRange = {
  today: 121.121,
  yesterday: 131.131,
  week: 141.141,
  month: fixtureValueByBucket.day,
};

let failNextAnalytics = false;
let holdNextWeekAnalytics = false;
let heldAnalytics = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function addDays(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return [
    result.getUTCFullYear(),
    String(result.getUTCMonth() + 1).padStart(2, '0'),
    String(result.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function startOfMoscowDay(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 3 * 60 * 60 * 1_000).toISOString();
}

function moscowToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function monthRange() {
  const to = moscowToday();
  return { from: `${to.slice(0, 8)}01`, to };
}

function currentMoscowRanges() {
  const today = moscowToday();
  const [year, month, day] = today.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  return {
    today: { from: today, to: today },
    yesterday: { from: addDays(today, -1), to: addDays(today, -1) },
    week: { from: addDays(today, -mondayOffset), to: today },
    month: { from: `${today.slice(0, 8)}01`, to: today },
  };
}

function bucketStartDate(query) {
  if (query.bucket === 'month') return `${query.from.slice(0, 8)}01`;
  if (query.bucket === 'week') {
    const [year, month, day] = query.from.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
    return date.toISOString().slice(0, 10);
  }
  return query.from;
}

function normalFixtureValue(query) {
  if (query.bucket !== 'day') return fixtureValueByBucket[query.bucket];
  const preset = Object.entries(currentMoscowRanges()).find(
    ([, range]) => range.from === query.from && range.to === query.to,
  )?.[0];
  return fixtureValueByDayRange[preset] ?? fixtureValueByBucket.day;
}

function parseQuery(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function numericValue(text) {
  return Number(
    text
      .replace(/\u2212/gu, '-')
      .replace(',', '.')
      .replace(/[^\d.-]/gu, ''),
  );
}

function analyticsFixture(query, producedKg = normalFixtureValue(query)) {
  const pointDate = bucketStartDate(query);
  const body = {
    range: {
      timezone: 'Europe/Moscow',
      requested: { from: query.from, to: query.to },
      effective: {
        fromUtc: startOfMoscowDay(query.from),
        toExclusiveUtc: startOfMoscowDay(addDays(query.to, 1)),
      },
      bucket: query.bucket,
      generatedAt: '2026-07-24T09:00:00.000Z',
    },
    productionSeries: [{ bucketStartDate: pointDate, rollCount: 7, producedKg }],
    materialSeries: [
      { bucketStartDate: pointDate, expectedUsageKg: producedKg, actualUsageKg: -5 },
    ],
    shiftBalances: [
      {
        sessionId: 'session-local-graph',
        shiftId: 'shift-local-graph',
        shiftLabel: 'Смена графиков',
        operatorId: 'operator-safe',
        operatorName: 'Оператор проверки',
        postId: 'post-safe',
        postCode: 'POST-SAFE',
        postName: 'Тестовый пост',
        startedAt: '2026-07-23T05:00:00.000Z',
        endedAt: '2026-07-23T13:00:00.000Z',
        rollCount: 7,
        producedKg,
        expectedUsageKg: producedKg,
        actualUsageKg: producedKg + 5,
        deviationPercent: 4.5,
        status: 'mismatch',
      },
    ],
    bigBags: [
      {
        id: 'bag-safe',
        code: 'BB-SAFE',
        materialId: 'material-safe',
        material: 'Полиэтилен тестовый',
        status: 'in_use',
        initialKg: 500,
        currentSnapshot: {
          measuredKg: 383.889,
          measuredAt: '2026-07-23T13:00:00.000Z',
        },
        usageHistory: [
          {
            id: 'usage-safe',
            sessionId: 'session-local-graph',
            shiftId: 'shift-local-graph',
            shiftLabel: 'Смена графиков',
            operatorId: 'operator-safe',
            operatorName: 'Оператор проверки',
            postId: 'post-safe',
            postCode: 'POST-SAFE',
            postName: 'Тестовый пост',
            startKg: 500,
            endKg: 383.889,
            deltaKg: 116.111,
            openedAt: '2026-07-23T05:00:00.000Z',
            closedAt: '2026-07-23T13:00:00.000Z',
          },
        ],
      },
    ],
    operatorOverPlan: {
      series: [
        {
          bucketStartDate: pointDate,
          affectedRollCount: 2,
          affectedOperatorCount: 1,
          overPlanKg: 7.5,
        },
      ],
      totals: [
        {
          period: 'week',
          fromDate: addDays(query.to, -6),
          toDate: query.to,
          affectedRollCount: 2,
          affectedOperatorCount: 1,
          overPlanKg: 7.5,
        },
        {
          period: 'month',
          fromDate: addDays(query.to, -29),
          toDate: query.to,
          affectedRollCount: 4,
          affectedOperatorCount: 2,
          overPlanKg: 14,
        },
      ],
      topOperators: [
        {
          operatorId: 'operator-safe',
          operatorName: 'Оператор проверки',
          affectedRollCount: 2,
          overPlanKg: 7.5,
        },
      ],
      missingPlanCount: 2,
      missingActorCount: 1,
    },
    productionQualitySeries: [
      {
        bucketStartDate: pointDate,
        producedRollCount: 7,
        producedKg,
        defectRecordCount: 2,
        defectiveRollCount: 1,
        verifiedDefectKg: 3.5,
        unverifiedDefectCount: 1,
      },
    ],
    materialSpendSeries: [
      {
        bucketStartDate: pointDate,
        consumedGranulesKg: -5,
        recordedSpoolCount: 6,
        recordedSpoolTareKg: 12,
        missingSpoolEvidenceCount: 1,
      },
    ],
    accountingProduction: onec.buildDirectorAccountingProductionFixture({
      latestImportedAt: '2026-07-24T08:00:00.000Z',
      latestDocumentDate: '2026-07-23T19:00:00.000Z',
      documentCount: 4,
      excludedOutputLineCount: 1,
      excludedMaterialLineCount: 2,
      productionSeries: [
        { bucketStartDate: pointDate, documentCount: 4, producedKg: producedKg + 12 },
      ],
      materialSeries: [{ bucketStartDate: pointDate, consumedKg: 119.5 }],
    }),
    spoolEvidence: {
      availability: 'measured_evidence_only',
      explanation: 'Только измеренные свидетельства шпуль.',
    },
    commercialApplications: {
      definition: 'submitted',
      asOfDate: query.to,
      periods: [
        {
          period: 'week',
          fromDate: addDays(query.to, -6),
          toDate: query.to,
          totalCount: 4,
          clientOrderCount: 3,
          stockReserveCount: 1,
        },
        {
          period: 'month',
          fromDate: addDays(query.to, -29),
          toDate: query.to,
          totalCount: 6,
          clientOrderCount: 4,
          stockReserveCount: 2,
        },
        {
          period: '3_months',
          fromDate: addDays(query.to, -89),
          toDate: query.to,
          totalCount: 8,
          clientOrderCount: 5,
          stockReserveCount: 3,
        },
        {
          period: '6_months',
          fromDate: addDays(query.to, -179),
          toDate: query.to,
          totalCount: 10,
          clientOrderCount: 6,
          stockReserveCount: 4,
        },
      ],
    },
  };
  const serialized = JSON.stringify(body);
  assert(!/rawPayload|devicePayload|secret|password/u.test(serialized), 'unsafe fixture field');
  return body;
}

function zeroAnalyticsFixture(query) {
  const body = analyticsFixture(query, 0);
  body.productionSeries[0].rollCount = 0;
  body.materialSeries[0] = {
    ...body.materialSeries[0],
    expectedUsageKg: 0,
    actualUsageKg: 0,
  };
  body.shiftBalances = [];
  body.bigBags = [];
  body.operatorOverPlan = {
    series: [
      {
        bucketStartDate: bucketStartDate(query),
        affectedRollCount: 0,
        affectedOperatorCount: 0,
        overPlanKg: 0,
      },
    ],
    totals: body.operatorOverPlan.totals.map((total) => ({
      ...total,
      affectedRollCount: 0,
      affectedOperatorCount: 0,
      overPlanKg: 0,
    })),
    topOperators: [],
    missingPlanCount: 0,
    missingActorCount: 0,
  };
  body.productionQualitySeries = body.productionQualitySeries.map((point) => ({
    ...point,
    producedRollCount: 0,
    producedKg: 0,
    defectRecordCount: 0,
    defectiveRollCount: 0,
    verifiedDefectKg: 0,
    unverifiedDefectCount: 0,
  }));
  body.materialSpendSeries = body.materialSpendSeries.map((point) => ({
    ...point,
    consumedGranulesKg: 0,
    recordedSpoolCount: 0,
    recordedSpoolTareKg: 0,
    missingSpoolEvidenceCount: 0,
  }));
  body.accountingProduction = onec.emptyDirectorAccountingProductionFixture(
    body.accountingProduction,
  );
  body.commercialApplications.periods = body.commercialApplications.periods.map((period) => ({
    ...period,
    totalCount: 0,
    clientOrderCount: 0,
    stockReserveCount: 0,
  }));
  return body;
}

function rollPage(cursor) {
  const suffix = cursor ? '002' : '001';
  return {
    items: [
      {
        operatorId: 'operator-safe',
        operatorName: 'Оператор проверки',
        orderId: `order-${suffix}`,
        orderNumber: `A-${suffix}`,
        rollId: `roll-${suffix}`,
        rollCode: `ROLL-${suffix}`,
        producedAt: '2026-07-23T10:00:00.000Z',
        actualCapturedAt: '2026-07-23T10:05:00.000Z',
        plannedKg: 40,
        actualKg: cursor ? 43 : 45,
        varianceKg: cursor ? 3 : 5,
        overPlanKg: cursor ? 3 : 5,
        provenance: 'post_session',
      },
    ],
    nextCursor: cursor ? null : 'cursor-2',
  };
}

const evidenceSource = {
  usage: 'shift_bag_usage',
  production: 'canonical_roll_weight_capture',
  defects: 'linked_stable_defect_weight_capture',
  latestEvidenceAt: '2026-07-23T13:00:00.000Z',
  freshness: 'fresh',
};

function shiftBalancePage(query, fixtureMode) {
  if (fixtureMode === 'zero') return { items: [], nextCursor: null };
  const producedKg = normalFixtureValue(query);
  const pageSuffix = query.cursor ? '002' : '001';
  return {
    items: [
      {
        sessionId: `session-local-graph-${pageSuffix}`,
        shiftId: 'shift-local-graph',
        shiftLabel: `Смена графиков ${pageSuffix}`,
        operatorId: 'operator-safe',
        operatorName: 'Оператор проверки',
        postId: 'post-safe',
        postCode: 'POST-SAFE',
        postName: 'Тестовый пост',
        startedAt: '2026-07-23T05:00:00.000Z',
        endedAt: '2026-07-23T13:00:00.000Z',
        bigBags: [],
        startKg: 500,
        endKg: 383.889,
        currentKg: 383.889,
        actualUsageKg: 116.111,
        expectedUsageKg: producedKg,
        producedKg,
        rollCount: 7,
        defectKg: 3.5,
        defectCount: 1,
        unverifiedDefectCount: 0,
        deviationKg: 5,
        deviationPercent: 4.5,
        status: 'mismatch',
        source: evidenceSource,
      },
    ],
    nextCursor: query.cursor ? null : 'shift-cursor-2',
  };
}

function bigBagEvidencePage(query, fixtureMode) {
  if (fixtureMode === 'zero') return { items: [], nextCursor: null };
  const producedKg = normalFixtureValue(query);
  const pageSuffix = query.cursor ? '002' : '001';
  return {
    items: [
      {
        id: `usage-safe-${pageSuffix}`,
        bigBagId: 'bag-safe',
        bigBagCode: `BB-SAFE-${pageSuffix}`,
        materialId: 'material-safe',
        material: 'Полиэтилен тестовый',
        bigBagStatus: 'in_use',
        sessionId: 'session-local-graph',
        shiftId: 'shift-local-graph',
        shiftLabel: 'Смена графиков',
        operatorId: 'operator-safe',
        operatorName: 'Оператор проверки',
        postId: 'post-safe',
        postCode: 'POST-SAFE',
        postName: 'Тестовый пост',
        openedAt: '2026-07-23T05:00:00.000Z',
        closedAt: '2026-07-23T13:00:00.000Z',
        startKg: 500,
        endKg: 383.889,
        currentKg: 383.889,
        currentMeasuredAt: '2026-07-23T13:00:00.000Z',
        bagUsageKg: 116.111,
        actualUsageKg: 116.111,
        expectedUsageKg: producedKg,
        producedKg,
        rollCount: 7,
        defectKg: 3.5,
        defectCount: 1,
        unverifiedDefectCount: 0,
        deviationKg: 5,
        deviationPercent: 4.5,
        balanceScope: 'session',
        status: 'mismatch',
        source: evidenceSource,
      },
    ],
    nextCursor: query.cursor ? null : 'big-bag-cursor-2',
  };
}

function actor(role) {
  return {
    userId: `${role}-safe`,
    role,
    capabilities: role === 'director' ? ['director:read'] : ['operator:read'],
    displayName: role === 'director' ? 'Директор проверки' : 'Оператор проверки',
    isActive: true,
    sessionPurpose: 'full',
    session: {
      id: `session-${role}-safe`,
      purpose: 'full',
      state: 'active',
      createdAt: '2026-07-24T00:00:00.000Z',
      expiresAt,
      lastSeenAt: null,
    },
    workContext: { kind: 'office', assignment: null },
    passwordChangeRequired: false,
  };
}

function staticDirectorBody(pathname) {
  if (pathname === '/api/director/notifications') return { items: [], nextCursor: null };
  if (pathname === '/api/director/control') {
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
    };
  }
  if (
    pathname === '/api/director/decisions' ||
    pathname === '/api/director/penalties' ||
    pathname === '/api/director/penalty-targets' ||
    pathname === '/api/director/finance' ||
    pathname === '/api/director/production' ||
    pathname === '/api/director/warehouse'
  ) {
    return [];
  }
  return undefined;
}

function staticOperatorBody(pathname) {
  if (pathname === '/api/operator/notifications') return { items: [], nextCursor: null };
  if (pathname === '/api/operator/machine-changes/current') return null;
  if (pathname === '/api/operator/runtime') {
    return {
      shift: null,
      orders: [],
      generatedAt: '2026-07-24T09:00:00.000Z',
    };
  }
  if (pathname === '/api/operator/penalties' || pathname === '/api/operator/big-bags') {
    return [];
  }
  return undefined;
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function assertPortAvailable() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Director analytics smoke port ${port} is already in use`));
    });
    socket.once('error', () => resolve());
  });
}

async function waitForPreview(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite preview exited\n${child.output}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Bounded retry while the preview starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite preview did not start at ${baseUrl}\n${child.output}`);
}

function session(role) {
  return {
    version: 1,
    token,
    role,
    serverRole: role,
    userId: `${role}-safe`,
    displayName: role === 'director' ? 'Директор проверки' : 'Оператор проверки',
    expiresAt,
    passwordChangeRequired: false,
  };
}

async function createContext(
  browser,
  role,
  viewport,
  diagnostics,
  { scenario = role, fixtureMode = 'normal' } = {},
) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(
    ({ storedSession }) => {
      localStorage.setItem('plenki.auth.v1', JSON.stringify(storedSession));
    },
    { storedSession: session(role) },
  );
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const authorization = request.headers().authorization ?? null;
    if (authorization !== `Bearer ${token}`) {
      diagnostics.authFailures.push(`${request.method()} ${url.pathname}: ${authorization}`);
    }

    if (url.pathname === '/api/auth/me') {
      await fulfillJson(route, actor(role));
      return;
    }
    if (url.pathname === '/api/director/analytics/operator-rolls') {
      const query = parseQuery(url);
      drilldownRequests.push({
        role,
        scenario,
        method: request.method(),
        query,
        search: url.searchParams.toString(),
        authorization,
      });
      await fulfillJson(route, rollPage(query.cursor));
      return;
    }
    if (
      url.pathname === '/api/director/analytics/shift-balances' ||
      url.pathname === '/api/director/analytics/big-bags'
    ) {
      const query = parseQuery(url);
      evidenceRequests.push({
        role,
        scenario,
        method: request.method(),
        pathname: url.pathname,
        query,
        authorization,
      });
      await fulfillJson(
        route,
        url.pathname.endsWith('/shift-balances')
          ? shiftBalancePage(query, fixtureMode)
          : bigBagEvidencePage(query, fixtureMode),
      );
      return;
    }
    if (url.pathname === '/api/director/analytics') {
      const query = parseQuery(url);
      aggregateRequests.push({
        role,
        scenario,
        method: request.method(),
        query,
        search: url.searchParams.toString(),
        authorization,
      });
      if (holdNextWeekAnalytics && query.bucket === 'week') {
        holdNextWeekAnalytics = false;
        heldAnalytics = { route, query, producedKg: 777.777 };
        return;
      }
      if (failNextAnalytics) {
        failNextAnalytics = false;
        await fulfillJson(
          route,
          { code: 'ANALYTICS_UNAVAILABLE', message: 'Analytics temporarily unavailable' },
          503,
        );
        return;
      }
      await fulfillJson(
        route,
        fixtureMode === 'zero' ? zeroAnalyticsFixture(query) : analyticsFixture(query),
      );
      return;
    }

    const body =
      role === 'director' ? staticDirectorBody(url.pathname) : staticOperatorBody(url.pathname);
    if (body !== undefined) {
      await fulfillJson(route, body);
      return;
    }

    diagnostics.unknownRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    await fulfillJson(
      route,
      { code: 'UNEXPECTED_SMOKE_REQUEST', message: 'Unexpected request' },
      404,
    );
  });
  return context;
}

async function waitForRequest(collection, previousCount) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (collection.length > previousCount) return collection.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected request ${previousCount + 1}, received ${collection.length}`);
}

function assertExactQuery(record, expected) {
  assert(record.role === 'director', `analytics used ${record.role}, expected director`);
  assert(record.method === 'GET', `analytics used ${record.method}, expected GET`);
  assert(
    JSON.stringify(record.query) === JSON.stringify(expected),
    `analytics query mismatch: ${JSON.stringify(record.query)} != ${JSON.stringify(expected)}`,
  );
  const expectedSearch = new URLSearchParams(expected).toString();
  assert(
    record.search === expectedSearch,
    `analytics query encoding mismatch: ${record.search} != ${expectedSearch}`,
  );
  assert(record.authorization === `Bearer ${token}`, 'analytics Bearer header mismatch');
}

function assertEvidenceQuery(record, pathname, expected, absent = []) {
  assert(record.role === 'director', `evidence used ${record.role}, expected director`);
  assert(record.method === 'GET', `evidence used ${record.method}, expected GET`);
  assert(record.pathname === pathname, `evidence path ${record.pathname} != ${pathname}`);
  for (const [key, value] of Object.entries(expected)) {
    assert(
      record.query[key] === String(value),
      `${pathname} query ${key}=${record.query[key]} != ${value}`,
    );
  }
  for (const key of absent) {
    assert(!(key in record.query), `${pathname} unexpectedly sent ${key}`);
  }
  assert(record.authorization === `Bearer ${token}`, `${pathname} Bearer header mismatch`);
}

function attachPageDiagnostics(page, diagnostics) {
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location().url;
    if (message.text().includes('503') && location.includes('/api/director/analytics')) {
      diagnostics.expectedConsoleErrors.push(message.text());
      return;
    }
    diagnostics.consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (!response.url().includes('/api/') || response.status() < 400) return;
    if (
      response.status() === 503 &&
      new URL(response.url()).pathname === '/api/director/analytics'
    ) {
      diagnostics.expectedApiErrors.push(`503 ${response.url()}`);
      return;
    }
    diagnostics.apiErrors.push(`${response.status()} ${response.url()}`);
  });
}

async function openDirectorPage(context, diagnostics) {
  const page = await context.newPage();
  attachPageDiagnostics(page, diagnostics);
  await page.goto(`${baseUrl}/?role=director&section=${encodeURIComponent('Контроль')}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.app-shell[data-active-role="director"]').waitFor({ timeout: 15_000 });
  return page;
}

async function assertGeometry(page, viewport) {
  const analytics = page.locator('.director-production-analytics');
  await analytics.waitFor({ state: 'visible', timeout: 15_000 });
  await analytics
    .locator('.director-analytics-summary-card[data-analytics-tab="production"]')
    .click();
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    for (const element of document.querySelectorAll('*')) {
      if (element.scrollTop !== 0) element.scrollTop = 0;
      if (element.scrollLeft !== 0) element.scrollLeft = 0;
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  const geometry = await page.evaluate(() => {
    const scrollerSelector = [
      '.director-analytics-chart',
      '.director-analytics-plot-scroll',
      '.director-analytics-table-scroll',
    ].join(',');
    const summary = document.querySelector('.director-analytics-summary');
    const tick = document.querySelector('.director-analytics-y-axis-ticks span');
    const axis = document.querySelector('.director-analytics-y-axis');
    const legend = document.querySelector('.director-analytics-legend');
    const tablist = document.querySelector(
      '.director-analytics-details ' +
        '[role="tablist"]' +
        '[aria-label="Раздел производственной аналитики"]',
    );
    const bar = document.querySelector('.director-analytics-bar');
    const summaryRect = summary?.getBoundingClientRect();
    const unexpectedHorizontalScrollers = Array.from(
      document.querySelectorAll('.director-production-analytics *'),
    )
      .filter((element) => {
        const style = getComputedStyle(element);
        const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll';
        return scrollable && element.scrollWidth > element.clientWidth + 1;
      })
      .filter(
        (element) =>
          !element.matches(
            '.director-analytics-chart, ' +
              '.director-analytics-plot-scroll, ' +
              '.director-analytics-table-scroll',
          ),
      )
      .map((element) => element.className || element.tagName);
    return {
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth,
      summaryTop: summaryRect?.top ?? Number.NEGATIVE_INFINITY,
      summaryBottom: summaryRect?.bottom ?? Number.POSITIVE_INFINITY,
      firstViewport: window.innerHeight,
      tickFontSize: tick ? Number.parseFloat(getComputedStyle(tick).fontSize) : 0,
      axisExists: Boolean(axis),
      legendExists: Boolean(legend),
      tablistExists: Boolean(tablist),
      axisInsideScroll: Boolean(axis?.closest(scrollerSelector)),
      legendInsideScroll: Boolean(legend?.closest(scrollerSelector)),
      tablistInsideScroll: Boolean(tablist?.closest(scrollerSelector)),
      barTransitionDuration: bar ? getComputedStyle(bar).transitionDuration : null,
      barAnimationName: bar ? getComputedStyle(bar).animationName : null,
      unexpectedHorizontalScrollers,
    };
  });
  assert(!geometry.documentOverflow, `${viewport.width}px document has horizontal overflow`);
  assert(!geometry.bodyOverflow, `${viewport.width}px body has horizontal overflow`);
  assert(
    geometry.summaryTop >= 0,
    `${viewport.width}px summary is above first fold: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.summaryBottom <= geometry.firstViewport,
    `${viewport.width}px summary is below first fold: ${JSON.stringify(geometry)}`,
  );
  assert(geometry.axisExists, `${viewport.width}px production axis is missing`);
  assert(geometry.legendExists, `${viewport.width}px production legend is missing`);
  assert(geometry.tablistExists, `${viewport.width}px semantic tablist is missing`);
  assert(geometry.tickFontSize >= 11, `axis tick font is ${geometry.tickFontSize}px`);
  assert(!geometry.axisInsideScroll, 'fixed chart axis was placed inside plot scroller');
  assert(!geometry.legendInsideScroll, 'fixed chart legend was placed inside plot scroller');
  assert(!geometry.tablistInsideScroll, 'semantic tabs were placed inside a data scroller');
  assert(
    geometry.unexpectedHorizontalScrollers.length === 0,
    `unexpected analytics scrollers: ${geometry.unexpectedHorizontalScrollers.join(', ')}`,
  );
  assert(
    geometry.barTransitionDuration === '0s' && geometry.barAnimationName === 'none',
    `bar motion is enabled: ${JSON.stringify(geometry)}`,
  );
}

async function assertFreshViewportGeometry(browser, diagnostics, viewport) {
  const before = aggregateRequests.length;
  const scenario = `geometry-${viewport.width}x${viewport.height}`;
  const context = await createContext(browser, 'director', viewport, diagnostics, { scenario });
  const page = await openDirectorPage(context, diagnostics);
  await assertGeometry(page, viewport);
  const request = await waitForRequest(aggregateRequests, before);
  assertExactQuery(request, { ...monthRange(), bucket: 'day' });
  assert(
    request.scenario === scenario,
    `${scenario} request was attributed to ${request.scenario}`,
  );
  assert(
    aggregateRequests.length === before + 1,
    `${scenario} issued ${aggregateRequests.length - before} aggregate requests`,
  );
  await context.close();
}

async function waitForEvidenceRequest(previousCount, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = evidenceRequests.slice(previousCount).find(predicate);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Expected evidence request after ${previousCount}, received ${evidenceRequests.length}`,
  );
}

function evidenceRequestCount(scenario, pathname) {
  return evidenceRequests.filter(
    (record) => record.scenario === scenario && record.pathname === pathname,
  ).length;
}

async function assertEvidenceGeometry(page, viewport) {
  const sections = [
    page.getByRole('region', { name: 'Баланс смен' }),
    page.getByRole('region', { name: 'Факты BigBag' }),
  ];
  for (const section of sections) {
    await section.getByRole('button', { name: /^Фильтры/u }).click();
  }

  const geometry = await page.evaluate(() => {
    const sections = Array.from(
      document.querySelectorAll(
        '.director-analytics-panel[aria-label="Баланс смен"], ' +
          '.director-analytics-panel[aria-label="Факты BigBag"]',
      ),
    );
    return {
      documentOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth + 1,
      panels: sections.map((section) => {
        const panel = section.querySelector('.director-evidence-toolbar__panel');
        const scroller = section.querySelector('.director-analytics-table-scroll');
        const table = scroller?.querySelector('table');
        const pagination = section.querySelector('.director-analytics-pagination');
        const sectionRect = section.getBoundingClientRect();
        const scrollerRect = scroller?.getBoundingClientRect();
        return {
          tableInScroller: Boolean(table && table.parentElement === scroller),
          tableWidth: table?.scrollWidth ?? 0,
          scrollerClientWidth: scroller?.clientWidth ?? 0,
          scrollerScrollWidth: scroller?.scrollWidth ?? 0,
          scrollerContained:
            Boolean(scrollerRect) &&
            scrollerRect.left >= sectionRect.left - 1 &&
            scrollerRect.right <= sectionRect.right + 1,
          sectionRect: {
            left: sectionRect.left,
            right: sectionRect.right,
            width: sectionRect.width,
          },
          scrollerRect: scrollerRect
            ? {
                left: scrollerRect.left,
                right: scrollerRect.right,
                width: scrollerRect.width,
              }
            : null,
          paginationInsideScroller: Boolean(
            pagination?.closest('.director-analytics-table-scroll'),
          ),
          filterColumns: panel
            ? getComputedStyle(panel).gridTemplateColumns.split(' ').filter(Boolean).length
            : 0,
          panelVisible: panel ? !panel.hidden : false,
        };
      }),
    };
  });

  assert(!geometry.documentOverflow, `${viewport.width}px evidence overflows document`);
  assert(!geometry.bodyOverflow, `${viewport.width}px evidence overflows body`);
  assert(geometry.panels.length === 2, `${viewport.width}px evidence panels are missing`);
  for (const panel of geometry.panels) {
    assert(panel.panelVisible, `${viewport.width}px evidence filters did not open`);
    assert(panel.tableInScroller, `${viewport.width}px evidence table escaped its scroller`);
    assert(
      panel.scrollerScrollWidth >= panel.tableWidth,
      `${viewport.width}px table width is not owned by its scroller`,
    );
    assert(
      panel.scrollerContained,
      `${viewport.width}px evidence scroller escaped its panel: ${JSON.stringify(panel)}`,
    );
    assert(
      !panel.paginationInsideScroller,
      `${viewport.width}px pagination is inside table scroll`,
    );
  }
  const expectedColumns = viewport.width === 1024 ? 1 : 2;
  assert(
    geometry.panels.every((panel) => panel.filterColumns === expectedColumns),
    `${viewport.width}px filter grid is not compact: ${JSON.stringify(geometry.panels)}`,
  );
}

async function assertEvidenceViewport(browser, diagnostics, viewport) {
  const scenario = `evidence-${viewport.width}x${viewport.height}`;
  const shiftPath = '/api/director/analytics/shift-balances';
  const bigBagPath = '/api/director/analytics/big-bags';
  const beforeInitial = evidenceRequests.length;
  const context = await createContext(browser, 'director', viewport, diagnostics, { scenario });
  const page = await context.newPage();
  attachPageDiagnostics(page, diagnostics);
  await page.goto(
    `${baseUrl}/?role=director&section=${encodeURIComponent('Контроль')}&sb_open=1&bb_open=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('.app-shell[data-active-role="director"]').waitFor({ timeout: 15_000 });
  await page.locator('.director-analytics-summary').waitFor({ timeout: 15_000 });

  const initialShift = await waitForEvidenceRequest(
    beforeInitial,
    (record) => record.scenario === scenario && record.pathname === shiftPath,
  );
  const initialBigBag = await waitForEvidenceRequest(
    beforeInitial,
    (record) => record.scenario === scenario && record.pathname === bigBagPath,
  );
  const baseQuery = { ...monthRange(), bucket: 'day', limit: '20' };
  assertEvidenceQuery(initialShift, shiftPath, baseQuery, ['cursor']);
  assertEvidenceQuery(initialBigBag, bigBagPath, baseQuery, ['cursor']);

  const shiftSection = page.getByRole('region', { name: 'Баланс смен' });
  const bigBagSection = page.getByRole('region', { name: 'Факты BigBag' });
  await shiftSection.getByRole('table', { name: 'Точный баланс смен' }).waitFor();
  await bigBagSection.getByRole('table', { name: 'Неизменяемые факты BigBag' }).waitFor();
  await shiftSection.getByText('Баланс смен · Показано: 1', { exact: true }).waitFor();
  await bigBagSection.getByText('Факты BigBag · Показано: 1', { exact: true }).waitFor();

  for (const section of [shiftSection, bigBagSection]) {
    const filterButton = section.getByRole('button', { name: /^Фильтры/u });
    await filterButton.click();
    await section.locator('button[aria-expanded="true"]').waitFor();
    await section.locator('.director-evidence-toolbar__panel:not([hidden])').waitFor();
  }

  let before = evidenceRequests.length;
  const shiftCountBeforeBigBagSelect = evidenceRequestCount(scenario, shiftPath);
  await bigBagSection.locator('#big-bag-filter-bigBagStatus').selectOption('in_use');
  const bigBagSelectRequest = await waitForEvidenceRequest(
    before,
    (record) =>
      record.scenario === scenario &&
      record.pathname === bigBagPath &&
      record.query.bigBagStatus === 'in_use',
  );
  assertEvidenceQuery(bigBagSelectRequest, bigBagPath, {
    ...baseQuery,
    bigBagStatus: 'in_use',
  });
  assert(
    evidenceRequestCount(scenario, shiftPath) === shiftCountBeforeBigBagSelect,
    `${viewport.width}px BigBag select reloaded shift balances`,
  );

  before = evidenceRequests.length;
  const bigBagCountBeforeShiftText = evidenceRequestCount(scenario, bigBagPath);
  await shiftSection.locator('#shift-search').fill('Оператор проверки');
  const shiftTextRequest = await waitForEvidenceRequest(
    before,
    (record) =>
      record.scenario === scenario &&
      record.pathname === shiftPath &&
      record.query.q === 'Оператор проверки',
  );
  assertEvidenceQuery(shiftTextRequest, shiftPath, {
    ...baseQuery,
    q: 'Оператор проверки',
  });
  assert(
    evidenceRequestCount(scenario, bigBagPath) === bigBagCountBeforeShiftText,
    `${viewport.width}px shift text filter reloaded BigBag`,
  );

  before = evidenceRequests.length;
  const bigBagCountBeforeShiftNumber = evidenceRequestCount(scenario, bigBagPath);
  await shiftSection.locator('#shift-filter-producedKgMin').fill('100');
  const shiftNumberRequest = await waitForEvidenceRequest(
    before,
    (record) =>
      record.scenario === scenario &&
      record.pathname === shiftPath &&
      record.query.producedKgMin === '100',
  );
  assertEvidenceQuery(shiftNumberRequest, shiftPath, {
    ...baseQuery,
    q: 'Оператор проверки',
    producedKgMin: '100',
  });
  assert(
    evidenceRequestCount(scenario, bigBagPath) === bigBagCountBeforeShiftNumber,
    `${viewport.width}px shift numeric filter reloaded BigBag`,
  );

  before = evidenceRequests.length;
  const bigBagCountBeforeCursor = evidenceRequestCount(scenario, bigBagPath);
  await shiftSection
    .getByRole('navigation', { name: 'Страницы баланса смен' })
    .getByRole('button', { name: 'Следующая' })
    .click();
  const shiftCursorRequest = await waitForEvidenceRequest(
    before,
    (record) =>
      record.scenario === scenario &&
      record.pathname === shiftPath &&
      record.query.cursor === 'shift-cursor-2',
  );
  assertEvidenceQuery(shiftCursorRequest, shiftPath, {
    ...baseQuery,
    q: 'Оператор проверки',
    producedKgMin: '100',
    cursor: 'shift-cursor-2',
  });
  await shiftSection.getByText('Стр. 2', { exact: true }).waitFor();
  await shiftSection.getByText('Смена графиков 002', { exact: true }).waitFor();
  assert(
    evidenceRequestCount(scenario, bigBagPath) === bigBagCountBeforeCursor,
    `${viewport.width}px shift cursor reloaded BigBag`,
  );

  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search);
    return (
      params.get('sb_open') === '1' &&
      params.get('bb_open') === '1' &&
      params.get('sb_q') === 'Оператор проверки' &&
      params.get('sb_producedKgMin') === '100' &&
      params.get('bb_bigBagStatus') === 'in_use' &&
      !params.has('sb_cursor') &&
      !params.has('bb_cursor')
    );
  });

  const beforeReload = evidenceRequests.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell[data-active-role="director"]').waitFor({ timeout: 15_000 });
  const reloadedShift = await waitForEvidenceRequest(
    beforeReload,
    (record) => record.scenario === scenario && record.pathname === shiftPath,
  );
  const reloadedBigBag = await waitForEvidenceRequest(
    beforeReload,
    (record) => record.scenario === scenario && record.pathname === bigBagPath,
  );
  assertEvidenceQuery(
    reloadedShift,
    shiftPath,
    {
      ...baseQuery,
      q: 'Оператор проверки',
      producedKgMin: '100',
    },
    ['cursor'],
  );
  assertEvidenceQuery(
    reloadedBigBag,
    bigBagPath,
    {
      ...baseQuery,
      bigBagStatus: 'in_use',
    },
    ['cursor'],
  );

  const reloadedShiftSection = page.getByRole('region', { name: 'Баланс смен' });
  const reloadedBigBagSection = page.getByRole('region', { name: 'Факты BigBag' });
  assert(
    await reloadedShiftSection.locator('details').evaluate((element) => element.open),
    `${viewport.width}px shift open state was not restored`,
  );
  assert(
    await reloadedBigBagSection.locator('details').evaluate((element) => element.open),
    `${viewport.width}px BigBag open state was not restored`,
  );
  await reloadedShiftSection.getByRole('button', { name: /^Фильтры/u }).click();
  await reloadedBigBagSection.getByRole('button', { name: /^Фильтры/u }).click();
  assert(
    (await reloadedShiftSection.locator('#shift-search').inputValue()) === 'Оператор проверки',
    `${viewport.width}px shift text filter was not restored`,
  );
  assert(
    (await reloadedShiftSection.locator('#shift-filter-producedKgMin').inputValue()) === '100',
    `${viewport.width}px shift numeric filter was not restored`,
  );
  assert(
    (await reloadedBigBagSection.locator('#big-bag-filter-bigBagStatus').inputValue()) === 'in_use',
    `${viewport.width}px BigBag select was not restored`,
  );
  await reloadedShiftSection.getByRole('button', { name: /^Фильтры/u }).click();
  await reloadedBigBagSection.getByRole('button', { name: /^Фильтры/u }).click();
  await assertEvidenceGeometry(page, viewport);
  await context.close();
}

async function assertDirectorAnalytics(page) {
  const analytics = page.locator('.director-production-analytics');
  await analytics.waitFor({ state: 'visible', timeout: 15_000 });

  const summaries = analytics.locator('.director-analytics-summary-card');
  assert((await summaries.count()) === 4, 'summary strip does not contain four controls');
  assert(
    (await summaries.first().getAttribute('data-analytics-tab')) === 'overPlan' &&
      (await summaries.first().getAttribute('aria-pressed')) === 'true',
    'over-plan is not the default analytics section',
  );
  assert(
    (await analytics.getByRole('tab', { name: 'Перерасход' }).getAttribute('aria-selected')) ===
      'true',
    'over-plan detail tab is not selected by default',
  );

  const partial = analytics.getByLabel('Неполные данные');
  await partial.getByText('План не зафиксирован: 2 рул.').waitFor();
  await partial.getByText('Исполнитель не определён: 1 рул.').waitFor();

  await summaries.first().focus();
  await page.keyboard.press('Tab');
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('data-analytics-tab'))) ===
      'production',
    'summary controls are not keyboard traversable',
  );

  const mode = analytics.getByRole('group', { name: 'Вид данных' });
  const beforeFirstPage = drilldownRequests.length;
  await mode.getByRole('button', { name: 'Точные данные' }).click();
  const firstPageRequest = await waitForRequest(drilldownRequests, beforeFirstPage);
  assertExactQuery(firstPageRequest, { ...monthRange(), limit: '25' });
  const rollTable = analytics.getByRole('table', {
    name: 'История веса по каждому рулону',
  });
  await rollTable.waitFor();
  let rollCells = await rollTable.locator('tbody tr').first().locator('td').allInnerTexts();
  assert(rollCells[0] === 'A-001', `first drilldown order is ${rollCells[0]}`);
  assert(rollCells[1] === 'ROLL-001', `first drilldown roll is ${rollCells[1]}`);
  assert(numericValue(rollCells[2]) === 40, `A-001 planned kg is ${rollCells[2]}`);
  assert(numericValue(rollCells[3]) === 45, `A-001 actual kg is ${rollCells[3]}`);
  assert(numericValue(rollCells[4]) === 5, `A-001 variance kg is ${rollCells[4]}`);

  const beforeCursorPage = drilldownRequests.length;
  await analytics.getByRole('button', { name: 'Вперёд' }).click();
  const cursorRequest = await waitForRequest(drilldownRequests, beforeCursorPage);
  assertExactQuery(cursorRequest, {
    ...monthRange(),
    cursor: 'cursor-2',
    limit: '25',
  });
  await analytics.getByText('Стр. 2').waitFor();
  rollCells = await rollTable.locator('tbody tr').first().locator('td').allInnerTexts();
  assert(rollCells[0] === 'A-002', `second drilldown order is ${rollCells[0]}`);
  assert(rollCells[1] === 'ROLL-002', `second drilldown roll is ${rollCells[1]}`);
  assert(numericValue(rollCells[2]) === 40, `A-002 planned kg is ${rollCells[2]}`);
  assert(numericValue(rollCells[3]) === 43, `A-002 actual kg is ${rollCells[3]}`);
  assert(numericValue(rollCells[4]) === 3, `A-002 variance kg is ${rollCells[4]}`);
  await mode.getByRole('button', { name: 'График' }).click();

  await summaries.filter({ has: page.getByText('Производство', { exact: true }) }).click();
  await onec.assertDirectorAccountingProductionChart(analytics);
  const qualityUnit = analytics.getByRole('group', { name: 'Единица качества' });
  assert(
    (await qualityUnit.getByRole('button', { name: 'кг' }).getAttribute('aria-pressed')) === 'true',
    'production quality does not default to kg',
  );
  await qualityUnit.getByRole('button', { name: 'шт.' }).click();
  assert(
    (await analytics.locator('[data-value-rolls="7"]').count()) > 0,
    'count mode did not render roll values',
  );
  await onec.assertDirectorAccountingExcludedFromCountMode(analytics, 4);
  const defectPattern = analytics.locator('.director-analytics-bar.is-defect-pattern').first();
  const defectBackground = await defectPattern.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  assert(defectBackground.includes('repeating-linear-gradient'), 'defect hatch is not rendered');
  assert(
    (await analytics
      .locator('[data-unverified-defect-warning="true"]')
      .getByText('Без подтверждённого веса: 1')
      .count()) === 1,
    'unverified defect warning badge is missing',
  );
  await mode.getByRole('button', { name: 'Точные данные' }).click();
  const productionTable = analytics.getByRole('table', {
    name: 'Точные данные производства и брака',
  });
  await productionTable.waitFor();
  const productionCells = await productionTable
    .locator('tbody tr')
    .first()
    .locator('td:not([data-column-id])')
    .allInnerTexts();
  assert(
    numericValue(productionCells[1]) === fixtureValueByBucket.day,
    `production exact value is ${productionCells[1]}`,
  );
  await onec.assertDirectorAccountingProductionRow(productionTable, {
    producedKg: fixtureValueByBucket.day + 12,
    documentCount: 4,
  });
  await mode.getByRole('button', { name: 'График' }).click();

  await summaries.filter({ has: page.getByText('Материалы', { exact: true }) }).click();
  await onec.assertDirectorAccountingMaterialSemantics(analytics);
  const negativeBar = analytics.locator('.director-analytics-bar.is-negative-pattern').first();
  assert((await negativeBar.count()) === 1, 'negative material value has no hatch marker');
  assert(
    (await negativeBar.getAttribute('aria-label'))?.includes('отрицательное значение'),
    'negative material value has no textual signal',
  );
  await mode.getByRole('button', { name: 'Точные данные' }).click();
  const materialTable = analytics.getByRole('table', {
    name: 'Точные производственные свидетельства расхода',
  });
  await materialTable.waitFor();
  const materialCells = await materialTable
    .locator('tbody tr')
    .first()
    .locator('td:not([data-column-id])')
    .allInnerTexts();
  assert(numericValue(materialCells[0]) === -5, `material fact is ${materialCells[0]}`);
  await onec.assertDirectorAccountingMaterialRow(materialTable, 119.5);
  assert(numericValue(materialCells[1]) === 6, `spool count is ${materialCells[1]}`);
  assert(numericValue(materialCells[2]) === 12, `spool tare is ${materialCells[2]}`);
  assert(numericValue(materialCells[3]) === 1, `missing spool count is ${materialCells[3]}`);
  await mode.getByRole('button', { name: 'График' }).click();

  await summaries.filter({ has: page.getByText('Заявки', { exact: true }) }).click();
  const expectedCounts = {
    week: 4,
    month: 6,
    '3_months': 8,
    '6_months': 10,
  };
  for (const [period, count] of Object.entries(expectedCounts)) {
    await analytics
      .locator(`[data-application-period="${period}"]`)
      .getByText(`${count} шт.`, { exact: true })
      .waitFor();
  }

  await analytics.getByText('Баланс смен · Показано: 1', { exact: true }).click();
  const balanceTable = analytics.getByRole('table', {
    name: 'Точный баланс смен',
  });
  await balanceTable.waitFor();
  const balanceText = await balanceTable.locator('tbody tr').first().innerText();
  assert(
    balanceText.includes(String(fixtureValueByBucket.day).replace('.', ',')),
    `shift produced kg is missing: ${balanceText}`,
  );

  await analytics.getByText('Факты BigBag · Показано: 1', { exact: true }).click();
  const usageTable = analytics.getByRole('table', {
    name: 'Неизменяемые факты BigBag',
  });
  await usageTable.waitFor();
  const usageText = await usageTable.locator('tbody tr').first().innerText();
  assert(usageText.includes('383,889 кг'), `BigBag snapshot is missing: ${usageText}`);
  assert(usageText.includes('116,111 кг'), `BigBag usage is missing: ${usageText}`);
  assert(
    (await page.locator('.management-period-dashboard, .management-period-table-panel').count()) ===
      0,
    'live analytics exposed the demonstration period projection',
  );
  assert(
    (await page.locator('.management-executive-kpis, .management-report-layout').count()) === 0,
    'live control exposed the demonstration report projection',
  );

  await summaries.first().click();
}

async function assertProducedValue(page, expectedValue) {
  const analytics = page.locator('.director-production-analytics');
  await analytics.waitFor({ state: 'visible', timeout: 10_000 });
  await analytics
    .locator('.director-analytics-summary-card[data-analytics-tab="production"]')
    .click();
  const mode = analytics.getByRole('group', { name: 'Вид данных' });
  const chartButton = mode.getByRole('button', { name: 'График' });
  if ((await chartButton.getAttribute('aria-pressed')) !== 'true') await chartButton.click();
  const qualityUnit = analytics.getByRole('group', { name: 'Единица качества' });
  const kgButton = qualityUnit.getByRole('button', { name: 'кг' });
  if ((await kgButton.getAttribute('aria-pressed')) !== 'true') await kgButton.click();
  const productionBar = analytics.locator('.director-analytics-bar.is-production').first();
  const deadline = Date.now() + 10_000;
  let chartValue = await productionBar.getAttribute('data-value-kg');
  while (Number(chartValue) !== expectedValue && Date.now() < deadline) {
    await page.waitForTimeout(25);
    chartValue = await productionBar.getAttribute('data-value-kg').catch(() => null);
  }
  assert(Number(chartValue) === expectedValue, `chart value ${chartValue} != ${expectedValue}`);
  await analytics
    .locator('.director-analytics-summary-card[data-analytics-tab="overPlan"]')
    .click();
}

async function assertZeroState(browser, diagnostics) {
  const before = aggregateRequests.length;
  const context = await createContext(
    browser,
    'director',
    { width: 1024, height: 768 },
    diagnostics,
    { scenario: 'zero-state', fixtureMode: 'zero' },
  );
  const page = await openDirectorPage(context, diagnostics);
  const emptyState = page.locator('.director-analytics-state.is-empty');
  const emptyText = 'За выбранный период агрегированных рядов нет.';
  await emptyState.waitFor({ state: 'visible', timeout: 15_000 });
  await emptyState.getByText(emptyText, { exact: true }).waitFor();
  await onec.assertEmptyDirectorAccountingSourceAbsent(page);
  assert(
    (await page.locator('.director-analytics-summary').count()) === 0,
    'zero fixture rendered aggregate analytics panels',
  );
  const request = await waitForRequest(aggregateRequests, before);
  assertExactQuery(request, { ...monthRange(), bucket: 'day' });
  assert(request.scenario === 'zero-state', 'zero fixture request was not isolated');
  assert(
    aggregateRequests.length === before + 1,
    `zero state issued ${aggregateRequests.length - before} aggregate requests`,
  );
  await context.close();
}

await assertPortAvailable();
const preview = spawn(
  process.execPath,
  [
    path.join(frontendDir, 'node_modules/vite/bin/vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { cwd: frontendDir, stdio: ['ignore', 'pipe', 'pipe'] },
);
preview.output = '';
const collect = (chunk) => {
  preview.output = `${preview.output}${chunk}`.slice(-8_000);
};
preview.stdout.on('data', collect);
preview.stderr.on('data', collect);

let browser;
try {
  await waitForPreview(preview);
  browser = await chromium.launch({ headless: true });
  const diagnostics = {
    pageErrors: [],
    consoleErrors: [],
    expectedConsoleErrors: [],
    apiErrors: [],
    expectedApiErrors: [],
    authFailures: [],
    unknownRequests: [],
  };

  const mainRequestStart = aggregateRequests.length;
  const directorContext = await createContext(
    browser,
    'director',
    { width: 1440, height: 900 },
    diagnostics,
    { scenario: 'main' },
  );
  const page = await openDirectorPage(directorContext, diagnostics);
  await page.locator('.management-control-board').waitFor({ state: 'visible' });
  await page.getByText('Данные платформы · Europe/Moscow', { exact: true }).waitFor();

  const ranges = currentMoscowRanges();
  const range = ranges.month;
  const initial = await waitForRequest(aggregateRequests, mainRequestStart);
  assertExactQuery(initial, { ...range, bucket: 'day' });
  await assertDirectorAnalytics(page);
  await assertProducedValue(page, fixtureValueByBucket.day);

  const grouping = page.getByLabel('Группировка');
  await grouping.waitFor({ state: 'visible' });
  const groupingChecks = [
    { label: 'Недели', bucket: 'week' },
    { label: 'Месяцы', bucket: 'month' },
    { label: 'Дни', bucket: 'day' },
  ];
  for (const check of groupingChecks) {
    const before = aggregateRequests.length;
    await grouping.selectOption(check.bucket);
    const record = await waitForRequest(aggregateRequests, before);
    assertExactQuery(record, { ...range, bucket: check.bucket });
    await assertProducedValue(page, fixtureValueByBucket[check.bucket]);
    assert(
      aggregateRequests.length === before + 1,
      `${check.label} issued ${aggregateRequests.length - before} aggregate requests`,
    );
  }

  const presetSelector = page.locator('.management-period-selector');
  await presetSelector.waitFor({ state: 'visible' });
  const presetChecks = [
    { label: 'Сегодня', range: ranges.today },
    { label: 'Вчера', range: ranges.yesterday },
    { label: 'Неделя', range: ranges.week },
    { label: 'Месяц', range: ranges.month },
  ];
  for (const check of presetChecks) {
    const before = aggregateRequests.length;
    await presetSelector.getByRole('button', { name: check.label, exact: true }).click();
    const record = await waitForRequest(aggregateRequests, before);
    assertExactQuery(record, { ...check.range, bucket: 'day' });
    await assertProducedValue(page, normalFixtureValue({ ...check.range, bucket: 'day' }));
    assert(
      (await presetSelector
        .getByRole('button', { name: check.label, exact: true })
        .getAttribute('aria-pressed')) === 'true',
      `${check.label} did not expose its selected state`,
    );
    assert(
      aggregateRequests.length === before + 1,
      `${check.label} issued ${aggregateRequests.length - before} aggregate requests`,
    );
  }

  holdNextWeekAnalytics = true;
  let before = aggregateRequests.length;
  await grouping.selectOption('week');
  const staleRequest = await waitForRequest(aggregateRequests, before);
  assertExactQuery(staleRequest, { ...range, bucket: 'week' });
  assert(heldAnalytics !== null, 'the deliberately stale response was not held');
  await page.locator('.director-analytics-state.is-loading').waitFor({ state: 'visible' });

  before = aggregateRequests.length;
  await grouping.selectOption('month');
  const currentRequest = await waitForRequest(aggregateRequests, before);
  assertExactQuery(currentRequest, { ...range, bucket: 'month' });
  await assertProducedValue(page, fixtureValueByBucket.month);
  await fulfillJson(
    heldAnalytics.route,
    analyticsFixture(heldAnalytics.query, heldAnalytics.producedKg),
  );
  heldAnalytics = null;
  await page.waitForTimeout(250);
  await assertProducedValue(page, fixtureValueByBucket.month);
  assert(
    (await page.locator('[data-value-kg="777.777"]').count()) === 0,
    'a delayed stale response replaced the current analytics view',
  );

  failNextAnalytics = true;
  before = aggregateRequests.length;
  await grouping.selectOption('week');
  const failedRequest = await waitForRequest(aggregateRequests, before);
  assertExactQuery(failedRequest, { ...range, bucket: 'week' });
  const errorState = page.locator('.director-analytics-state.is-error');
  await errorState.waitFor({ state: 'visible' });
  await errorState
    .getByText('Производственная аналитика недоступна', {
      exact: true,
    })
    .waitFor();
  assert(
    (await page.locator('.director-analytics-summary, .director-analytics-details').count()) === 0,
    '503 retained the previous aggregate analytics view',
  );
  assert(
    (await page.locator('[data-value-kg="333.333"], .management-period-dashboard').count()) === 0,
    '503 rendered stale or demonstration values',
  );

  before = aggregateRequests.length;
  await errorState.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  const retryRequest = await waitForRequest(aggregateRequests, before);
  assertExactQuery(retryRequest, { ...range, bucket: 'week' });
  assert(
    aggregateRequests.length === before + 1,
    'retry did not issue exactly one aggregate request',
  );
  await assertProducedValue(page, fixtureValueByBucket.week);

  const historicalFrom = '2024-01-01';
  const historicalTo = '2024-01-31';
  await page.locator('.management-period-calendar-toggle').click();
  let calendar = page.getByRole('dialog', { name: 'Выбор периода' });
  await calendar.waitFor({ state: 'visible' });
  assert(
    (await calendar.getByLabel('Начало').getAttribute('min')) === null,
    'historical input has an absolute minimum',
  );
  assert(
    (await calendar.getByLabel('Начало').getAttribute('max')) === ranges.today.to,
    'historical input is missing its Moscow-today maximum',
  );

  const tomorrow = addDays(ranges.today.to, 1);
  before = aggregateRequests.length;
  await calendar.getByLabel('Начало').fill(tomorrow);
  await page.waitForTimeout(250);
  assert(
    aggregateRequests.length === before,
    'a manually typed future date issued an aggregate request',
  );

  await calendar.getByLabel('Начало').fill(historicalFrom);
  let historicalRequest = await waitForRequest(aggregateRequests, before);
  assertExactQuery(historicalRequest, {
    from: historicalFrom,
    to: historicalFrom,
    bucket: 'week',
  });

  calendar = page.getByRole('dialog', { name: 'Выбор периода' });
  before = aggregateRequests.length;
  await calendar.getByLabel('Конец').fill(historicalTo);
  historicalRequest = await waitForRequest(aggregateRequests, before);
  assertExactQuery(historicalRequest, {
    from: historicalFrom,
    to: historicalTo,
    bucket: 'week',
  });
  await assertProducedValue(page, fixtureValueByBucket.week);

  const mainRequests = aggregateRequests.filter((request) => request.scenario === 'main');
  assert(mainRequests.length === 14, `expected 14 main requests, received ${mainRequests.length}`);
  await directorContext.close();

  await assertFreshViewportGeometry(browser, diagnostics, { width: 1440, height: 900 });
  await assertFreshViewportGeometry(browser, diagnostics, { width: 1024, height: 768 });
  await onec.assertDirectorAccountingSourceAbsentViewport({
    browser,
    diagnostics,
    aggregateRequests,
    createContext,
    openDirectorPage,
    waitForRequest,
    assertExactQuery,
    expectedQuery: { ...monthRange(), bucket: 'day' },
  });
  await assertEvidenceViewport(browser, diagnostics, { width: 1440, height: 900 });
  await assertEvidenceViewport(browser, diagnostics, { width: 1024, height: 768 });
  await assertZeroState(browser, diagnostics);

  const operatorRequestStart = aggregateRequests.length;
  const operatorDrilldownStart = drilldownRequests.length;
  const operatorEvidenceStart = evidenceRequests.length;
  const operatorContext = await createContext(
    browser,
    'operator',
    { width: 1024, height: 768 },
    diagnostics,
    { scenario: 'operator-denial' },
  );
  const operatorPage = await operatorContext.newPage();
  attachPageDiagnostics(operatorPage, diagnostics);
  await operatorPage.goto(`${baseUrl}/?role=operator`, { waitUntil: 'domcontentloaded' });
  await operatorPage
    .locator('.app-shell[data-active-role="operator"]')
    .waitFor({ timeout: 15_000 });
  assert(
    (await operatorPage.locator('.director-production-analytics').count()) === 0,
    'operator session can see director analytics',
  );
  assert(
    aggregateRequests.length === operatorRequestStart,
    'operator session requested director aggregate analytics',
  );
  assert(
    drilldownRequests.length === operatorDrilldownStart,
    'operator session requested director roll drilldown',
  );
  assert(
    evidenceRequests.length === operatorEvidenceStart,
    'operator session requested director evidence tables',
  );
  await operatorContext.close();

  assert(diagnostics.pageErrors.length === 0, `page errors: ${diagnostics.pageErrors.join('; ')}`);
  assert(
    diagnostics.authFailures.length === 0,
    `Bearer failures: ${diagnostics.authFailures.join('; ')}`,
  );
  assert(
    diagnostics.unknownRequests.length === 0,
    `unknown requests: ${diagnostics.unknownRequests.join('; ')}`,
  );
  assert(
    diagnostics.consoleErrors.length === 0,
    `console errors: ${diagnostics.consoleErrors.join('; ')}`,
  );
  assert(diagnostics.apiErrors.length === 0, `API errors: ${diagnostics.apiErrors.join('; ')}`);
  assert(
    diagnostics.expectedApiErrors.length === 1,
    `expected one forced 503, got ${diagnostics.expectedApiErrors.length}`,
  );
  assert(
    diagnostics.expectedConsoleErrors.length <= 1,
    `forced 503 produced duplicate console errors: ${diagnostics.expectedConsoleErrors.join('; ')}`,
  );

  console.log(
    'PASS director analytics: V2 UI, exact evidence, 14 range/stale/503 requests, ' +
      'independent responsive filters, URL reload, cursor pages, zero state and operator denial',
  );
} finally {
  if (heldAnalytics) {
    await fulfillJson(
      heldAnalytics.route,
      analyticsFixture(heldAnalytics.query, heldAnalytics.producedKg),
    ).catch(() => undefined);
  }
  await browser?.close().catch(() => undefined);
  if (preview.exitCode === null) preview.kill('SIGTERM');
}
