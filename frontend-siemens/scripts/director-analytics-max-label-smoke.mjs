import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { buildDirectorAccountingProductionFixture } from './director-accounting-production-smoke-helpers.mjs';

const frontendDir = process.cwd();
const port = Number(process.env.DIRECTOR_MAX_LABEL_SMOKE_PORT ?? 5228);
const baseUrl = `http://127.0.0.1:${port}`;
const viteEntry = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
const screenshotPath = path.join(tmpdir(), 'director-analytics-max-label-1024.png');
const token = 'qa-director-max-label-token';
const evidenceRequests = [];
const diagnostics = { consoleErrors: [], pageErrors: [], requestFailures: [] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPortAvailable() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Smoke port ${port} is already in use`)));
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
      // Bounded readiness retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite preview did not start at ${baseUrl}\n${child.output}`);
}

function analyticsFixture(query) {
  const firstDate = query.from;
  const secondDate = query.to === query.from ? query.from : query.to;
  return {
    range: {
      timezone: 'Europe/Moscow',
      requested: { from: query.from, to: query.to },
      effective: {
        fromUtc: `${query.from}T00:00:00.000Z`,
        toExclusiveUtc: `${query.to}T23:59:59.999Z`,
      },
      bucket: query.bucket,
      generatedAt: '2026-07-27T03:00:00.000Z',
    },
    productionSeries: [
      { bucketStartDate: firstDate, rollCount: 2, producedKg: 80 },
      { bucketStartDate: secondDate, rollCount: 2, producedKg: 80 },
    ],
    materialSeries: [
      { bucketStartDate: firstDate, expectedUsageKg: 80, actualUsageKg: 82 },
      { bucketStartDate: secondDate, expectedUsageKg: 80, actualUsageKg: 82 },
    ],
    shiftBalances: [],
    bigBags: [],
    operatorOverPlan: {
      series: [
        {
          bucketStartDate: firstDate,
          affectedRollCount: 1,
          affectedOperatorCount: 1,
          overPlanKg: 2,
        },
      ],
      totals: [
        {
          period: 'week',
          fromDate: query.from,
          toDate: query.to,
          affectedRollCount: 1,
          affectedOperatorCount: 1,
          overPlanKg: 2,
        },
        {
          period: 'month',
          fromDate: query.from,
          toDate: query.to,
          affectedRollCount: 1,
          affectedOperatorCount: 1,
          overPlanKg: 2,
        },
      ],
      topOperators: [],
      missingPlanCount: 0,
      missingActorCount: 0,
    },
    productionQualitySeries: [
      {
        bucketStartDate: firstDate,
        producedRollCount: 2,
        producedKg: 80,
        defectRecordCount: 1,
        defectiveRollCount: 1,
        verifiedDefectKg: 5,
        unverifiedDefectCount: 0,
      },
      {
        bucketStartDate: secondDate,
        producedRollCount: 2,
        producedKg: 80,
        defectRecordCount: 1,
        defectiveRollCount: 1,
        verifiedDefectKg: 5,
        unverifiedDefectCount: 0,
      },
    ],
    materialSpendSeries: [
      {
        bucketStartDate: firstDate,
        consumedGranulesKg: 82,
        recordedSpoolCount: 2,
        recordedSpoolTareKg: 3,
        missingSpoolEvidenceCount: 0,
      },
    ],
    accountingProduction: buildDirectorAccountingProductionFixture({
      latestImportedAt: '2026-07-27T02:00:00.000Z',
      latestDocumentDate: '2026-07-26T19:00:00.000Z',
      documentCount: 4,
      productionSeries: [
        { bucketStartDate: firstDate, documentCount: 2, producedKg: 120 },
        { bucketStartDate: secondDate, documentCount: 2, producedKg: 120 },
      ],
      materialSeries: [
        { bucketStartDate: firstDate, consumedKg: 96 },
        { bucketStartDate: secondDate, consumedKg: 96 },
      ],
    }),
    spoolEvidence: {
      availability: 'measured_evidence_only',
      explanation: 'Только подтверждённые измерения.',
    },
    commercialApplications: {
      definition: 'submitted',
      asOfDate: query.to,
      periods: [],
    },
  };
}

function actor() {
  return {
    userId: 'director-safe',
    role: 'director',
    capabilities: ['director:read'],
    displayName: 'Директор проверки',
    isActive: true,
    sessionPurpose: 'full',
    session: {
      id: 'session-director-safe',
      purpose: 'full',
      state: 'active',
      createdAt: '2026-07-27T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      lastSeenAt: null,
    },
    workContext: { kind: 'office', assignment: null },
    passwordChangeRequired: false,
  };
}

function control() {
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

async function fulfillJson(route, body) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function attachDiagnostics(page) {
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push(`${request.method()} ${request.url()}`);
  });
}

async function assertMaxGeometry(page, expectedIdentity) {
  const annotation = page.locator(`[data-max-annotation="${expectedIdentity}"]`);
  await annotation.waitFor({ state: 'visible', timeout: 15_000 });
  assert(
    (await page.locator('[data-max-annotation]').count()) === 1,
    'maximum label is duplicated',
  );
  assert(
    (await annotation.textContent())?.trim() === '120 кг',
    'maximum 1C label is not an exact value',
  );
  const geometry = await annotation.evaluate((element) => {
    const plot = element.closest('.director-analytics-chart');
    const identity = element.getAttribute('data-max-annotation') ?? '';
    const seriesId = identity.slice(identity.indexOf(':') + 1);
    const bar = element
      .closest('.director-analytics-bar-group')
      ?.querySelector(`[data-series-id="${CSS.escape(seriesId)}"]`);
    const leader = element.querySelector('.director-analytics-max-leader');
    const label = element.querySelector('strong');
    const annotationRect = element.getBoundingClientRect();
    const plotRect = plot?.getBoundingClientRect();
    const leaderRect = leader?.getBoundingClientRect();
    const labelRect = label?.getBoundingClientRect();
    const barRect = bar?.getBoundingClientRect();
    return {
      annotation: annotationRect.toJSON(),
      plot: plotRect?.toJSON(),
      leader: leaderRect?.toJSON(),
      label: labelRect?.toJSON(),
      bar: barRect?.toJSON(),
      position: getComputedStyle(element).position,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  assert(geometry.position === 'absolute', `maximum participates in layout: ${geometry.position}`);
  assert(
    geometry.plot && geometry.label && geometry.leader && geometry.bar,
    'maximum geometry is incomplete',
  );
  assert(
    geometry.label.left >= geometry.plot.left - 1 &&
      geometry.label.right <= geometry.plot.right + 1,
    `maximum label escapes the plot: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.leader.width <= 1.5 && geometry.leader.height >= 5,
    `maximum leader is not thin and visible: ${JSON.stringify(geometry.leader)}`,
  );
  assert(
    Math.abs(
      geometry.leader.left +
        geometry.leader.width / 2 -
        (geometry.bar.left + geometry.bar.width / 2),
    ) <= 2,
    `maximum leader misses the bar: ${JSON.stringify(geometry)}`,
  );
  assert(!geometry.documentOverflow, '1024px page has horizontal overflow');
}

assert(existsSync(path.join(frontendDir, 'dist', 'index.html')), 'Run npm run build first');
assert(existsSync(viteEntry), 'Vite executable is missing');
await assertPortAvailable();

const preview = spawn(
  process.execPath,
  [viteEntry, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: frontendDir, stdio: ['ignore', 'pipe', 'pipe'] },
);
preview.output = '';
for (const stream of [preview.stdout, preview.stderr]) {
  stream.on('data', (chunk) => {
    preview.output = `${preview.output}${chunk}`.slice(-8_000);
  });
}

let browser;
try {
  await waitForPreview(preview);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await context.addInitScript(
    ({ storedToken }) => {
      localStorage.setItem(
        'plenki.auth.v1',
        JSON.stringify({
          version: 1,
          token: storedToken,
          role: 'director',
          serverRole: 'director',
          userId: 'director-safe',
          displayName: 'Директор проверки',
          expiresAt: '2099-01-01T00:00:00.000Z',
          passwordChangeRequired: false,
        }),
      );
    },
    { storedToken: token },
  );
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') return fulfillJson(route, actor());
    if (url.pathname === '/api/director/control') return fulfillJson(route, control());
    if (url.pathname === '/api/director/notifications') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }
    if (url.pathname === '/api/director/analytics') {
      return fulfillJson(route, analyticsFixture(Object.fromEntries(url.searchParams)));
    }
    if (
      url.pathname === '/api/director/analytics/shift-balances' ||
      url.pathname === '/api/director/analytics/big-bags'
    ) {
      evidenceRequests.push({
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
      });
      return fulfillJson(route, { items: [], nextCursor: null });
    }
    if (url.pathname === '/api/director/analytics/operator-rolls') {
      return fulfillJson(route, { items: [], nextCursor: null });
    }
    return fulfillJson(route, []);
  });

  const page = await context.newPage();
  attachDiagnostics(page);
  await page.goto(
    `${baseUrl}/?role=director&section=${encodeURIComponent(
      'Контроль',
    )}&period=month&bucket=week&operatorId=operator-safe&status=mismatch&q=${encodeURIComponent(
      'Ночная смена',
    )}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('.director-production-analytics').waitFor({ timeout: 15_000 });
  assert(
    (await page.locator('.management-period-selector').count()) === 1,
    'period control duplicated',
  );
  assert((await page.getByLabel('Группировка').inputValue()) === 'week', 'bucket was not restored');
  assert(
    (await page.locator('#shift-filter-operatorQuery').inputValue()) === 'operator-safe',
    'operator filter was not restored',
  );
  assert(
    (await page.locator('#shift-search').inputValue()) === 'Ночная смена',
    'search filter was not restored',
  );
  await page.locator('.director-analytics-summary-card[data-analytics-tab="production"]').click();
  const firstDate = evidenceRequests[0]?.query.from;
  assert(firstDate, 'server evidence query was not issued');
  await assertMaxGeometry(page, `${firstDate}:onec-produced`);
  await page.locator(`[data-max-annotation="${firstDate}:onec-produced"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath, animations: 'disabled' });

  const expectedEvidence = new Set([
    '/api/director/analytics/shift-balances',
    '/api/director/analytics/big-bags',
  ]);
  for (const request of evidenceRequests.slice(0, 2)) {
    expectedEvidence.delete(request.pathname);
    assert(request.query.bucket === 'week', `wrong evidence bucket: ${request.query.bucket}`);
    assert(request.query.operatorQuery === 'operator-safe', 'operator filter stayed client-side');
    assert(request.query.status === 'mismatch', 'status filter stayed client-side');
    assert(request.query.q === 'Ночная смена', 'search stayed client-side');
    assert(request.query.limit === '20', 'evidence page is not bounded');
  }
  assert(expectedEvidence.size === 0, 'one evidence endpoint was not queried');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.director-production-analytics').waitFor({ timeout: 15_000 });
  assert((await page.getByLabel('Группировка').inputValue()) === 'week', 'reload lost bucket');
  assert(
    (await page.locator('#shift-filter-operatorQuery').inputValue()) === 'operator-safe',
    'reload lost evidence filters',
  );
  assert(diagnostics.pageErrors.length === 0, `page errors: ${diagnostics.pageErrors.join('; ')}`);
  assert(
    diagnostics.consoleErrors.length === 0,
    `console errors: ${diagnostics.consoleErrors.join('; ')}`,
  );
  assert(
    diagnostics.requestFailures.length === 0,
    `request failures: ${diagnostics.requestFailures.join('; ')}`,
  );
  await context.close();
  console.log('PASS director analytics max label: stable tie, URL filters and 1024 geometry');
} finally {
  await browser?.close().catch(() => undefined);
  if (preview.exitCode === null) preview.kill('SIGTERM');
}
