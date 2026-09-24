import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { warehouseInventoryFixtureResponse } from './warehouse-inventory-smoke-fixture.mjs';

const port = 5235;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');
const screenshotDir = path.resolve('qa-screenshots/warehouse-roll-table-2026-08-07');
const reportPath = path.join(screenshotDir, 'warehouse-roll-table-report.json');
const stockSection = 'Все рулоны';
const warehouseStockUrl = `${baseUrl}/?role=warehouse&section=${encodeURIComponent(
  stockSection,
)}&object=WH-INV-RAW`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, needles, context) {
  const normalized = text.toLocaleLowerCase('ru-RU');
  const missing = needles.filter(
    (needle) => !normalized.includes(needle.toLocaleLowerCase('ru-RU')),
  );
  assert(missing.length === 0, `${context}: missing ${missing.join(', ')}`);
}

function assertNotIncludes(text, needles, context) {
  const normalized = text.toLocaleLowerCase('ru-RU');
  const hits = needles.filter((needle) => normalized.includes(needle.toLocaleLowerCase('ru-RU')));
  assert(hits.length === 0, `${context}: forbidden ${hits.join(', ')}`);
}

async function assertWarehouseScanStationStructure() {
  const readSource = (relativePath) =>
    readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8').catch(() => '');
  const [appSource, scanSurface, workbenchSource, warehouseStyles] = await Promise.all([
    readSource('src/App.tsx'),
    readSource('src/components/workbenches/WarehouseScanStationSurface.tsx'),
    readSource('src/components/workbenches/warehouseWorkbench.tsx'),
    Promise.all([
      readSource('src/styles/52-warehouse.css'),
      readSource('src/styles/106-warehouse-layout-sanity.css'),
      readSource('src/styles/107-warehouse-responsive-sanity.css'),
    ]).then((parts) => parts.join('\n')),
  ]);

  assertIncludes(appSource, ['WarehouseScanStationSurface'], 'warehouse scan-station route');
  assertIncludes(
    scanSurface,
    [
      'warehouse-scan-input-form',
      'warehouse-scan-queue-scroll',
      'Выберите заказ или отсканируйте QR',
      'Операция',
      'Осталось QR',
    ],
    'warehouse scan-station surface',
  );
  assertIncludes(
    workbenchSource,
    ['Ожидаемые рулоны', 'К сканированию сейчас', 'warehouse-detail-close'],
    'warehouse scan-station workbench',
  );
  assertIncludes(
    warehouseStyles,
    [
      'warehouse-scan-station-layout',
      '.warehouse-scan-input-form',
      '.warehouse-scan-queue-scroll',
      '.warehouse-detail-close',
      'scrollbar-width',
    ],
    'warehouse scan-station styles',
  );
}

function startServer() {
  const server = spawn(
    viteBin,
    ['--host', '127.0.0.1', '--port', String(port), '--strictPort', '--mode', 'test'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_LIVE_CONTOURS: 'warehouse',
        VITE_REQUIRE_AUTH: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logs = [];
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { server, logs };
}

async function waitForServer(server, logs) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Vite exited before ready.\n${logs.join('\n').slice(-2_000)}`);
    }
    try {
      const response = await fetch(warehouseStockUrl);
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not start in time.\n${logs.join('\n').slice(-2_000)}`);
}

async function installApiFixture(
  page,
  observedInventoryRequests,
  unhandledApiRoutes,
  obsoletePostRouteRequests,
) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (['/api/warehouse/physical-posts', '/api/warehouse/post-binding'].includes(url.pathname)) {
      obsoletePostRouteRequests.push(`${route.request().method()} ${url.pathname}`);
    }
    const json = (body) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    const inventoryResponse = warehouseInventoryFixtureResponse(url);
    if (inventoryResponse !== undefined) {
      observedInventoryRequests.push(`${route.request().method()} ${url.pathname}${url.search}`);
      return inventoryResponse === null
        ? route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Складской рулон не найден' }),
          })
        : json(inventoryResponse);
    }
    if (url.pathname === '/api/auth/me') {
      return json({
        userId: 'qa-warehouse',
        role: 'warehouse',
        capabilities: ['warehouse.view'],
        displayName: null,
        isActive: true,
        sessionPurpose: 'full',
        session: {
          id: 'qa-warehouse-session',
          purpose: 'full',
          state: 'active',
          createdAt: '2026-08-07T00:00:00.000Z',
          expiresAt: '2030-01-01T00:00:00.000Z',
          lastSeenAt: null,
        },
        workContext: { kind: 'office', assignment: null },
        passwordChangeRequired: false,
      });
    }
    if (url.pathname === '/api/material-catalog' || url.pathname === '/api/recipe-catalog') {
      return json([]);
    }
    if (url.pathname === '/api/warehouse/notifications') {
      return json({ items: [], nextCursor: null });
    }
    if (url.pathname === '/api/warehouse/raw-materials') return json([]);
    if (url.pathname === '/api/warehouse/cover-checks') {
      return json({ items: [], nextCursor: null });
    }
    if (url.pathname === '/api/warehouse/rolls') return json([]);
    if (url.pathname === '/api/warehouse/intake') {
      return json({
        stats: { todayOps: 0, remainingQr: 0, errors: 0 },
        tasks: [],
        generatedAt: '2026-08-07T08:00:00.000Z',
      });
    }
    if (url.pathname === '/api/warehouse/tasks') return json([]);
    unhandledApiRoutes.add(`${route.request().method()} ${url.pathname}${url.search}`);
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: `Unhandled QA route: ${url.pathname}` }),
    });
  });
}

async function gotoStock(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(warehouseStockUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell[data-active-role="warehouse"]').waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  await page.locator('.warehouse-stock-workspace').waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  await page.locator('.warehouse-stock-data-table tbody tr.is-interactive').first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
}

async function tableMetrics(page) {
  return page.evaluate(() => {
    const table = document.querySelector('.warehouse-stock-data-table');
    const rows = Array.from(table?.querySelectorAll('tbody tr.is-interactive') ?? []);
    const tableRect = table?.getBoundingClientRect();
    return {
      rowCount: rows.length,
      rowKeys: rows.map((row) => row.textContent?.trim() ?? ''),
      viewportWidth: document.documentElement.clientWidth,
      pageScrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      tableWidth: tableRect?.width ?? 0,
      tableRight: tableRect?.right ?? 0,
    };
  });
}

async function desktopScenario(page, observedInventoryRequests) {
  await gotoStock(page, { width: 1440, height: 900 });
  const workspace = page.locator('.warehouse-stock-workspace');
  const text = await workspace.innerText();
  assertIncludes(
    text,
    [
      'Рулоны на складе',
      'Рулоны',
      'Обработанные',
      'Поиск',
      'Партия',
      'Возраст от',
      'Возраст до',
      'Статус',
      'Контрагент',
      'Код рулона',
      'Заказ',
      'Позиция',
      'Фактический статус',
      'Следующий маршрут',
      'R-STOCK-001',
      'A-1',
      'Принят складом',
      'Выдача',
      'Свободный резерв',
      'Складской резерв',
    ],
    'unified warehouse stock desktop surface',
  );
  assertNotIncludes(
    text,
    ['Готовая продукция', 'Проверки покрытия', 'Статус оплаты', 'Сумма оплаты', 'real-time 1С'],
    'unified warehouse stock desktop surface',
  );
  assert(
    (await page.locator('.warehouse-finished-stock, .warehouse-cover-tasks-panel').count()) === 0,
    'legacy warehouse stock surfaces are still rendered',
  );
  assert(
    (await page.locator('.warehouse-stock-data-table').count()) === 1,
    'unified warehouse stock table must render exactly once',
  );

  let metrics = await tableMetrics(page);
  assert(
    metrics.rowCount === 25,
    `first cursor page must contain 25 rows: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.pageScrollWidth <= metrics.viewportWidth + 2,
    `desktop stock workspace overflows the page: ${JSON.stringify(metrics)}`,
  );

  const loadMoreResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/warehouse/inventory/rolls' &&
        url.searchParams.get('cursor') === 'qa-inventory-25'
      );
    },
    { timeout: 8_000 },
  );
  await workspace.getByRole('button', { name: 'Загрузить ещё', exact: true }).click();
  await loadMoreResponse;
  await page.locator('.warehouse-stock-data-table tbody tr').nth(26).waitFor({
    state: 'visible',
    timeout: 8_000,
  });
  metrics = await tableMetrics(page);
  assert(
    metrics.rowCount === 27,
    `cursor append lost or duplicated rows: ${JSON.stringify(metrics)}`,
  );
  assert(
    new Set(metrics.rowKeys).size === metrics.rowCount,
    `cursor append rendered duplicate rows: ${JSON.stringify(metrics.rowKeys)}`,
  );

  const searchResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/warehouse/inventory/rolls' &&
        url.searchParams.get('q') === 'R-STOCK-001' &&
        !url.searchParams.has('cursor')
      );
    },
    { timeout: 8_000 },
  );
  await page.getByLabel('Поиск рулонов').fill('R-STOCK-001');
  await searchResponse;
  await page.waitForTimeout(100);
  metrics = await tableMetrics(page);
  assert(
    metrics.rowCount === 1,
    `server-side search returned the wrong page: ${JSON.stringify(metrics)}`,
  );
  assertIncludes(
    await workspace.innerText(),
    ['R-STOCK-001', 'A-1', 'Принят складом', 'Выдача'],
    'server-side warehouse stock search',
  );

  const row = page.locator('.warehouse-stock-data-table tbody tr.is-interactive').first();
  const detailRequest = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/warehouse/inventory/rolls/qa-current-001',
    { timeout: 8_000 },
  );
  await row.click();
  await detailRequest;
  const detail = page.locator('.warehouse-stock-detail-modal');
  await detail.waitFor({ state: 'visible', timeout: 8_000 });
  assertIncludes(
    await detail.innerText(),
    ['R-STOCK-001', 'ПВД 70/30', 'ПВД 15803-020', 'STOCK-S-17'],
    'warehouse roll detail',
  );
  await detail.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await detail.waitFor({ state: 'detached' });

  const clearedSearchResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/warehouse/inventory/rolls' &&
        !url.searchParams.has('q') &&
        url.searchParams.get('view') === 'current'
      );
    },
    { timeout: 8_000 },
  );
  await page.getByLabel('Поиск рулонов').fill('');
  await clearedSearchResponse;

  const processedResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/warehouse/inventory/rolls' &&
        url.searchParams.get('view') === 'processed'
      );
    },
    { timeout: 8_000 },
  );
  await page.getByRole('tab', { name: 'Обработанные', exact: true }).click();
  await processedResponse;
  await page
    .locator('.warehouse-stock-data-table tbody tr', { hasText: 'R-PROCESSED-001' })
    .waitFor({
      state: 'visible',
      timeout: 8_000,
    });
  assert(
    new URL(page.url()).searchParams.get('view') === 'processed',
    'processed view URL was not canonicalized',
  );
  const processedText = await workspace.innerText();
  assertIncludes(
    processedText,
    ['История обработанных рулонов', 'R-PROCESSED-001', 'Обработан'],
    'processed warehouse stock view',
  );
  assert(
    (await workspace.getByLabel('Статус').count()) === 0,
    'processed view must not expose current lifecycle filter',
  );
  assert(
    (await workspace.getByRole('button', { name: 'Добавить рулон' }).count()) === 0,
    'processed view must not expose manual create action',
  );

  assert(
    observedInventoryRequests.some(
      (request) =>
        request.includes('/api/warehouse/inventory/rolls?') &&
        request.includes('sort=receivedAt') &&
        request.includes('limit=25'),
    ),
    `workspace never requested the unified inventory API: ${JSON.stringify(observedInventoryRequests)}`,
  );

  await page.screenshot({
    path: path.join(screenshotDir, 'warehouse-stock-workspace-desktop-1440.png'),
    fullPage: true,
  });
  return { scenario: 'desktop unified warehouse stock', metrics };
}

async function mobileScenario(page) {
  await gotoStock(page, { width: 390, height: 844 });
  const text = await page.locator('.warehouse-stock-workspace').innerText();
  assertIncludes(
    text,
    ['Рулоны на складе', 'Рулоны', 'Обработанные', 'Поиск', 'R-STOCK-001'],
    'unified warehouse stock mobile surface',
  );
  const metrics = await tableMetrics(page);
  assert(
    metrics.rowCount === 25,
    `mobile first cursor page is incomplete: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.pageScrollWidth <= metrics.viewportWidth + 2,
    `mobile stock workspace overflows the page: ${JSON.stringify(metrics)}`,
  );
  await page.screenshot({
    path: path.join(screenshotDir, 'warehouse-stock-workspace-mobile-390.png'),
    fullPage: true,
  });
  return { scenario: 'mobile unified warehouse stock', metrics };
}

await assertWarehouseScanStationStructure();
await mkdir(screenshotDir, { recursive: true });
const { server, logs } = startServer();
const observedInventoryRequests = [];
const unhandledApiRoutes = new Set();
const obsoletePostRouteRequests = [];
const report = { baseUrl, results: [] };
const browserErrors = [];
let browser;

try {
  await waitForServer(server, logs);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await installApiFixture(
    page,
    observedInventoryRequests,
    unhandledApiRoutes,
    obsoletePostRouteRequests,
  );
  page.on('pageerror', (error) => browserErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  report.results.push(await desktopScenario(page, observedInventoryRequests));
  report.results.push(await mobileScenario(page));
  assert(
    unhandledApiRoutes.size === 0,
    `warehouse stock smoke has unhandled API routes: ${[...unhandledApiRoutes].join(', ')}`,
  );
  assert(
    obsoletePostRouteRequests.length === 0,
    `warehouse stock smoke requested obsolete post routes: ${obsoletePostRouteRequests.join(', ')}`,
  );
  assert(
    browserErrors.length === 0,
    `warehouse stock smoke browser errors: ${browserErrors.join(' | ')}`,
  );
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        ...report,
        status: 'passed',
        observedInventoryRequests,
      },
      null,
      2,
    ),
  );
  console.log(`Warehouse stock workspace smoke passed. Report: ${reportPath}`);
} catch (error) {
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        ...report,
        status: 'failed',
        error: String(error),
        logs: logs.join('\n').slice(-2_000),
        observedInventoryRequests,
        obsoletePostRouteRequests,
        unhandledApiRoutes: [...unhandledApiRoutes],
        browserErrors,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
