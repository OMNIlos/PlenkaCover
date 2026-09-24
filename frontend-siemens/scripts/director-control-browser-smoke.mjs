import path from 'node:path';

import { chromium } from 'playwright';

import {
  businessPerformanceControlFixture,
  installBusinessPerformanceSmokeFixture,
} from './business-performance-smoke-fixture.mjs';
import {
  assertSmokeHealthy,
  collectVisibleErrors,
  installPageFailureTracker,
  startOwnedVite,
} from './release-smoke-runtime.mjs';

const viteBin = path.resolve('node_modules/.bin/vite');
const expectedChartIds = ['control-period-c', 'control-period-a', 'control-period-b'];
const expectedTableIds = ['control-period-a', 'control-period-b', 'control-period-c'];
const expectedControlColumns = [
  'Период',
  'Изготовлено, рул.',
  'Изготовлено, кг',
  'Рулонов с браком',
  'Брак, кг',
];
const expectedBigBagColumns = [
  'BigBag / материал',
  'Начальный вес',
  'Фактический остаток',
  'Расчётный расход',
  'Расчётный остаток',
  'Отклонение, кг',
  'Эквивалент, ₽',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalized(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

function controlFixture() {
  const fixture = structuredClone(businessPerformanceControlFixture);
  const [first, second] = fixture.productionQualitySeries;
  fixture.productionQualitySeries = [
    {
      ...first,
      id: 'control-period-b',
      bucketStartDate: '2026-08-07',
      producedRollCount: 8,
      producedKg: 300,
    },
    {
      ...second,
      id: 'control-period-a',
      bucketStartDate: '2026-08-07',
      producedRollCount: 8,
      producedKg: 300,
    },
    {
      ...first,
      id: 'control-period-c',
      bucketStartDate: '2026-08-06',
      producedRollCount: 6,
      producedKg: 200,
    },
  ];
  return fixture;
}

function bigBagEvidencePage() {
  const source = {
    usage: 'shift_bag_usage',
    production: 'canonical_roll_weight_capture',
    defects: 'linked_stable_defect_weight_capture',
    latestEvidenceAt: '2026-08-07T10:00:00.000Z',
    freshness: 'fresh',
  };
  const base = {
    id: 'usage-plus',
    bigBagId: 'bag-plus',
    bigBagCode: 'BB-PLUS',
    materialId: 'material-1',
    material: 'ПНД',
    bigBagStatus: 'consumed',
    sessionId: 'session-1',
    shiftId: 'shift-1',
    shiftLabel: 'Смена 1',
    operatorId: 'operator-1',
    operatorName: 'Оператор 1',
    postId: 'post-1',
    postCode: 'POST-1',
    postName: 'Экструдер 1',
    openedAt: '2026-08-07T06:00:00.000Z',
    closedAt: '2026-08-07T14:00:00.000Z',
    startKg: 500,
    endKg: 450,
    currentKg: 460,
    currentMeasuredAt: '2026-08-07T14:00:00.000Z',
    priceKopecksPerKg: 2_500,
    totalKopecks: 1_125_000,
    priceEffectiveAt: '2026-08-01T09:00:00.000Z',
    bagUsageKg: 50,
    actualUsageKg: 40,
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
    source,
  };
  return {
    items: [
      base,
      {
        ...base,
        id: 'usage-minus',
        bigBagId: 'bag-minus',
        bigBagCode: 'BB-MINUS',
        deviationKg: -5,
        deviationPercent: -11.111,
      },
      {
        ...base,
        id: 'usage-zero',
        bigBagId: 'bag-zero',
        bigBagCode: 'BB-ZERO',
        deviationKg: 0,
        deviationPercent: 0,
      },
      {
        ...base,
        id: 'usage-missing',
        bigBagId: 'bag-missing',
        bigBagCode: 'BB-MISSING',
        bagUsageKg: null,
        actualUsageKg: null,
        expectedUsageKg: null,
        calculatedRemainderKg: null,
        producedKg: null,
        rollCount: null,
        defectKg: null,
        defectCount: null,
        unverifiedDefectCount: null,
        deviationKg: null,
        deviationPercent: null,
        status: 'pending',
      },
    ],
    nextCursor: null,
  };
}

async function waitForControl(page) {
  const workspace = page.locator('.commercial-performance-workspace');
  await workspace.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => {
    const root = document.querySelector('.commercial-performance-workspace');
    const refresh = root?.querySelector('.commercial-performance-refresh button');
    return (
      root !== null &&
      !root.textContent?.includes('Загрузка показателей') &&
      refresh instanceof HTMLButtonElement &&
      !refresh.disabled
    );
  });
  return workspace;
}

async function chartGroupIds(workspace) {
  return workspace
    .locator('.director-production-quality-panel [data-chart-group-id]')
    .evaluateAll((groups) => groups.map((group) => group.getAttribute('data-chart-group-id')));
}

async function tableRowIds(workspace) {
  return workspace
    .locator('.director-production-quality-panel tbody [data-control-period-id]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-control-period-id')));
}

async function assertMaximumGeometry(workspace, viewportLabel) {
  const panel = workspace.locator('.director-production-quality-panel');
  const annotation = panel.locator('[data-max-annotation="control-period-a:produced"]');
  await annotation.waitFor({ state: 'visible', timeout: 10_000 });
  assert((await panel.locator('[data-max-annotation]').count()) === 1, 'maximum label duplicated');
  assert((await panel.locator('[data-bar-annotation]').count()) === 5, 'not every bar is labelled');
  assert(
    normalized((await annotation.textContent()) ?? '') === '300 кг',
    'maximum value differs',
  );
  const geometry = await annotation.evaluate((element) => {
    const plot = element.closest('.director-analytics-chart');
    const group = element.closest('.director-analytics-bar-group');
    const bar = group?.querySelector('[data-series-id="produced"]');
    const leader = element.querySelector('.director-analytics-max-leader');
    const label = element.querySelector('strong');
    return {
      position: getComputedStyle(element).position,
      plot: plot?.getBoundingClientRect().toJSON(),
      bar: bar?.getBoundingClientRect().toJSON(),
      leader: leader?.getBoundingClientRect().toJSON(),
      label: label?.getBoundingClientRect().toJSON(),
      documentOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  assert(geometry.position === 'absolute', `${viewportLabel}: maximum participates in layout`);
  assert(
    geometry.plot && geometry.bar && geometry.leader && geometry.label,
    `${viewportLabel}: maximum geometry is incomplete`,
  );
  assert(
    geometry.label.left >= geometry.plot.left - 1 &&
      geometry.label.right <= geometry.plot.right + 1,
    `${viewportLabel}: maximum label escapes plot`,
  );
  assert(
    geometry.leader.width <= 1.5 && geometry.leader.height >= 5,
    `${viewportLabel}: maximum leader is not visible`,
  );
  assert(
    Math.abs(
      geometry.leader.left +
        geometry.leader.width / 2 -
        (geometry.bar.left + geometry.bar.width / 2),
    ) <= 2,
    `${viewportLabel}: maximum leader misses bar`,
  );
  assert(!geometry.documentOverflow, `${viewportLabel}: document has horizontal overflow`);
}

async function assertBigBagContract(workspace) {
  const details = workspace.locator('section[aria-label="Факты BigBag"] details');
  await details.locator('summary').click();
  await details.locator('table').waitFor({ state: 'visible' });
  const headings = (await details.locator('th[scope="col"]').allTextContents()).map(normalized);
  assert(
    JSON.stringify(headings) === JSON.stringify(expectedBigBagColumns),
    `BigBag columns differ: ${JSON.stringify(headings)}`,
  );
  const deviationColumnIndex = headings.slice(1).indexOf('Отклонение, кг');
  assert(deviationColumnIndex >= 0, 'BigBag deviation column is missing');
  const deviations = await details.locator('tbody tr').evaluateAll((rows, columnIndex) =>
    rows.map((row) => {
      const cells = row.querySelectorAll('td');
      return (cells[columnIndex]?.textContent ?? '').replace(/\s+/gu, ' ').trim();
    }),
    deviationColumnIndex,
  );
  assert(
    JSON.stringify(deviations) ===
      JSON.stringify(['+5 кг', '−5 кг', '0 кг', 'Нет данных']),
    `BigBag deviations differ: ${JSON.stringify(deviations)}`,
  );
  return details;
}

async function refreshWithoutMovingFocus(page) {
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname === '/api/commercial/performance/control' && candidate.ok();
  });
  await page.evaluate(() => {
    const refresh = document.querySelector('.commercial-performance-refresh button');
    if (!(refresh instanceof HTMLButtonElement)) throw new Error('Control refresh is missing');
    refresh.click();
  });
  await response;
  await waitForControl(page);
}

let ownedVite;
let browser;
try {
  ownedVite = await startOwnedVite({
    viteBin,
    cwd: process.cwd(),
    env: {
      ...process.env,
      CI: 'true',
      VITE_LIVE_CONTOURS: '',
      VITE_REQUIRE_AUTH: 'off',
    },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const tracker = installPageFailureTracker(page);
  const controlRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/commercial/performance/control') {
      controlRequests.push(request.url());
    }
  });
  await page.addInitScript(() => {
    window.__directorControlLayoutShifts = [];
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__directorControlLayoutShifts.push(entry.value);
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
    } catch {
      window.__directorControlLayoutShifts = null;
    }
  });
  await installBusinessPerformanceSmokeFixture(page, {
    controlResponse: controlFixture(),
    bigBagEvidenceResponse: bigBagEvidencePage(),
  });

  await page.goto(
    `${ownedVite.baseUrl}/?role=director&section=${encodeURIComponent('Контроль')}`,
    { waitUntil: 'domcontentloaded' },
  );
  let workspace = await waitForControl(page);
  assert(
    (await page
      .locator(
        '.management-control-board, ' +
          '.director-production-analytics:not(.business-control-evidence)',
      )
      .count()) === 0,
    'legacy director analytics surface is still rendered',
  );
  assert(
    JSON.stringify(await chartGroupIds(workspace)) === JSON.stringify(expectedChartIds),
    'equal-period chart identity/order is not stable',
  );
  await assertMaximumGeometry(workspace, '1024px');

  await workspace.getByLabel('Дата с').fill('2026-08-01');
  await workspace.getByLabel('Дата по').fill('2026-08-08');
  await workspace.getByLabel('Группировка').selectOption('week');
  const applied = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/commercial/performance/control' &&
      url.searchParams.get('bucket') === 'week' &&
      response.ok()
    );
  });
  await workspace.getByRole('button', { name: 'Применить', exact: true }).click();
  await applied;
  workspace = await waitForControl(page);
  await workspace.getByRole('button', { name: 'Таблица', exact: true }).click();

  const controlHeadings = (
    await workspace
      .locator('.director-production-quality-panel th[scope="col"]')
      .allTextContents()
  ).map(normalized);
  assert(
    JSON.stringify(controlHeadings) === JSON.stringify(expectedControlColumns),
    `Control columns differ: ${JSON.stringify(controlHeadings)}`,
  );
  assert(
    JSON.stringify(await tableRowIds(workspace)) === JSON.stringify(expectedTableIds),
    'equal-period table identity/order is not stable',
  );
  const bigBagDetails = await assertBigBagContract(workspace);

  const periodSort = workspace
    .locator('.director-production-quality-panel th[scope="col"]')
    .filter({ hasText: 'Период' })
    .getByRole('button');
  await periodSort.focus();
  const continuityBefore = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-control-period-id]'));
    window.__directorControlRows = new Map(
      rows.map((row) => [row.getAttribute('data-control-period-id'), row]),
    );
    window.__directorControlFocus = document.activeElement;
    window.__directorControlLayoutShifts = [];
    const candidates = [
      document.scrollingElement,
      ...document.querySelectorAll('.director-analytics-table-scroll'),
    ].filter(Boolean);
    const scrollTarget = candidates
      .flatMap((element) => [
        {
          element,
          axis: 'x',
          maximum: element.scrollWidth - element.clientWidth,
        },
        {
          element,
          axis: 'y',
          maximum: element.scrollHeight - element.clientHeight,
        },
      ])
      .sort((left, right) => right.maximum - left.maximum)[0];
    window.__directorControlScroller = scrollTarget?.element;
    window.__directorControlScrollAxis = scrollTarget?.axis;
    if (scrollTarget?.axis === 'x') {
      scrollTarget.element.scrollLeft = Math.min(160, scrollTarget.maximum);
    } else if (scrollTarget) {
      scrollTarget.element.scrollTop = Math.min(160, scrollTarget.maximum);
    }
    return {
      scrollValue:
        scrollTarget?.axis === 'x'
          ? scrollTarget.element.scrollLeft
          : (scrollTarget?.element.scrollTop ?? 0),
      maximum: scrollTarget?.maximum ?? 0,
    };
  });
  assert(continuityBefore.maximum > 0, 'Control fixture does not provide a real scroll position');
  const requestCountBeforeRefresh = controlRequests.length;
  await refreshWithoutMovingFocus(page);
  await refreshWithoutMovingFocus(page);
  workspace = page.locator('.commercial-performance-workspace');

  const continuityAfter = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-control-period-id]'));
    const stable = rows.every(
      (row) =>
        window.__directorControlRows.get(row.getAttribute('data-control-period-id')) === row,
    );
    return {
      stable,
      sameFocus: document.activeElement === window.__directorControlFocus,
      scrollTargetConnected: window.__directorControlScroller?.isConnected ?? false,
      scrollValue:
        window.__directorControlScrollAxis === 'x'
          ? (window.__directorControlScroller?.scrollLeft ?? 0)
          : (window.__directorControlScroller?.scrollTop ?? 0),
      layoutShifts: window.__directorControlLayoutShifts,
    };
  });
  assert(
    controlRequests.length === requestCountBeforeRefresh + 2,
    'two Control refetches not proven',
  );
  assert(continuityAfter.stable, 'Control row DOM nodes changed across refetches');
  assert(continuityAfter.sameFocus, 'Control focus changed across refetches');
  assert(
    continuityAfter.scrollTargetConnected,
    'Control scroll container changed across refetches',
  );
  assert(
    Math.abs(continuityAfter.scrollValue - continuityBefore.scrollValue) <= 1,
    'Control scroll position changed across refetches',
  );
  assert(
    Array.isArray(continuityAfter.layoutShifts) && continuityAfter.layoutShifts.length === 0,
    `Control refetch caused layout shifts: ${JSON.stringify(continuityAfter.layoutShifts)}`,
  );
  assert((await bigBagDetails.getAttribute('open')) !== null, 'BigBag details closed on refetch');
  assert(
    (await workspace.getByLabel('Дата с').inputValue()) === '2026-08-01',
    'from date changed',
  );
  assert(
    (await workspace.getByLabel('Дата по').inputValue()) === '2026-08-08',
    'to date changed',
  );
  assert(
    (await workspace.getByLabel('Группировка').inputValue()) === 'week',
    'bucket changed',
  );

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  workspace = await waitForControl(page);
  assert(
    JSON.stringify(await chartGroupIds(workspace)) === JSON.stringify(expectedChartIds),
    'hard reload changed equal-period chart order',
  );
  await assertMaximumGeometry(workspace, '1366px');
  await workspace.getByRole('button', { name: 'Таблица', exact: true }).click();
  assert(
    JSON.stringify(await tableRowIds(workspace)) === JSON.stringify(expectedTableIds),
    'hard reload changed equal-period table order',
  );

  ownedVite.assertAlive('director Control browser contract');
  assertSmokeHealthy(
    tracker,
    await collectVisibleErrors(page),
    'director Control browser contract',
  );
  await page.close();
  console.log(
    'PASS director Control: current workspace, stable identities, BigBag signs and max geometry',
  );
} finally {
  await browser?.close().catch(() => undefined);
  ownedVite?.server.kill('SIGTERM');
}
