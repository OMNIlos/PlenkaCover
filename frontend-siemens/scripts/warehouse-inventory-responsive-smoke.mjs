import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { warehouseInventoryFixtureResponse } from './warehouse-inventory-smoke-fixture.mjs';

const port = 5276;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');
const screenshotDir = process.env.WAREHOUSE_RESPONSIVE_SCREENSHOT_DIR;
const unhandledApiRoutes = new Set();
const obsoletePostRouteRequests = [];
const WAREHOUSE_STOCK_SECTION = 'Все рулоны';
const WAREHOUSE_PROCESSED_VIEW = 'Обработанные';
const inventorySections = [
  'Сырье',
  WAREHOUSE_STOCK_SECTION,
  WAREHOUSE_PROCESSED_VIEW,
];
const warehouseBigBags = Array.from({ length: 10 }, (_, index) => {
  const number = index + 1;
  return {
    id: `qa-warehouse-bag-${number}`,
    code: `BB-ПВД-ВТОРИЧНОЕ-${String(number).padStart(2, '0')}`,
    material: 'ПВД Вторичное',
    materialId: 'rm-pvd-secondary',
    materialSelectionKind: 'material',
    materialPreset: null,
    baseRawMaterialDefinitionId: 'rm-pvd-secondary',
    recipeDefinitionVersionId: null,
    recipeName: null,
    recipeVersionNumber: null,
    supplierName: null,
    receivedAt: null,
    composition: [
      {
        rawMaterialDefinitionId: 'rm-pvd-secondary',
        materialId: 'rm-pvd-secondary',
        name: 'ПВД Вторичное',
        shareBasisPoints: 10_000,
        initialKg: 1_000,
      },
    ],
    status: 'available',
    registrationStatus: 'registered',
    location: index < 2 ? 'warehouse' : 'production',
    locationRevision: 1,
    initialKg: 1_000,
    currentKg: 1_000 - index * 10,
    lastMeasuredKg: 1_000 - index * 10,
    lastActorRole: 'warehouse',
    lastMeasuredAt: '2026-08-20T12:00:00.000Z',
    machineId: index < 2 ? null : 'machine-1',
    lastWarehouseMeasuredKg: 1_000,
    lastWarehouseMeasuredAt: '2026-08-20T11:00:00.000Z',
    priceKopecksPerKg: null,
    totalKopecks: null,
    priceSource: null,
    priceEffectiveAt: null,
    createdByRole: 'warehouse',
    createdAt: '2026-08-20T10:00:00.000Z',
    latestLabelPrint: null,
  };
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
      throw new Error(`Vite exited before ready.\n${logs.join('\n').slice(-2000)}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not start in time.\n${logs.join('\n').slice(-2000)}`);
}

function inventoryUrl(section) {
  const url = new URL(baseUrl);
  url.searchParams.set('role', 'warehouse');
  url.searchParams.set(
    'section',
    section === WAREHOUSE_PROCESSED_VIEW ? WAREHOUSE_STOCK_SECTION : section,
  );
  if (section === WAREHOUSE_PROCESSED_VIEW) url.searchParams.set('view', 'processed');
  url.searchParams.set('object', 'WH-INV-RAW');
  return url.toString();
}

function screenshotName(section, viewport) {
  const sectionId = section.toLocaleLowerCase('ru-RU').replaceAll(' / ', '-').replaceAll(' ', '-');
  return path.join(screenshotDir, `${sectionId}-${viewport.width}x${viewport.height}.png`);
}

async function captureScreenshot(page, section, viewport) {
  if (!screenshotDir) return;
  await page.screenshot({
    path: screenshotName(section, viewport),
    fullPage: true,
  });
}

async function installWarehouseApiFixture(page) {
  await page.route('**/api/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!requestUrl.pathname.startsWith('/api/')) return route.continue();
    if (
      ['/api/warehouse/physical-posts', '/api/warehouse/post-binding'].includes(requestUrl.pathname)
    ) {
      obsoletePostRouteRequests.push(`${route.request().method()} ${requestUrl.pathname}`);
    }
    const json = (body) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (requestUrl.pathname === '/api/auth/me') {
      return json({
        userId: 'qa-warehouse',
        role: 'warehouse',
        capabilities: ['warehouse.view', 'warehouse_task:read', 'bigbag:move', 'bigbag:print'],
        displayName: 'QA Склад',
        isActive: true,
        sessionPurpose: 'full',
        session: {
          id: 'qa-warehouse-session',
          purpose: 'full',
          state: 'active',
          createdAt: '2026-07-26T08:00:00.000Z',
          expiresAt: '2030-01-01T00:00:00.000Z',
          lastSeenAt: null,
        },
        workContext: { kind: 'office', assignment: null },
        passwordChangeRequired: false,
      });
    }
    if (requestUrl.pathname === '/api/warehouse/big-bags') return json(warehouseBigBags);
    if (requestUrl.pathname === '/api/material-catalog') return json([]);
    if (requestUrl.pathname === '/api/recipe-catalog') return json([]);
    if (requestUrl.pathname === '/api/raw-materials/big-bags') {
      return json({
        items: [
          {
            id: 'qa-bag-1',
            code: 'BB-QA-001',
            material: 'ПВД 10803-020',
            batch: 'ПАРТИЯ-QA',
            createdAt: '2026-07-26T08:00:00.000Z',
            status: 'in_use',
            location: {
              kind: 'post',
              postCode: 'POST-2',
              postName: 'Экструдер 2',
            },
            currentWeightKg: 249.5,
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      });
    }
    if (requestUrl.pathname === '/api/warehouse/notifications') {
      return json({ items: [], nextCursor: null });
    }
    if (requestUrl.pathname === '/api/warehouse/raw-materials') {
      return json([
        {
          id: 'qa-stock-10803',
          materialId: 'rm-pvd-10803',
          label: 'ПВД 10803-020',
          actualQty: 90,
          unit: 'кг',
          package: null,
          factStatus: 'warehouse_fact',
          updatedAt: '2026-07-26T08:00:00.000Z',
          externalId: 'qa-ext-10803',
        },
        {
          id: 'qa-stock-15803',
          materialId: 'rm-pvd-15803',
          label: 'ПВД 15803-020',
          actualQty: 320,
          unit: 'кг',
          package: null,
          factStatus: 'warehouse_fact',
          updatedAt: '2026-07-26T08:00:00.000Z',
          externalId: 'qa-ext-15803',
        },
      ]);
    }
    if (requestUrl.pathname === '/api/warehouse/raw-material-inventory') {
      return json({
        items: [
          {
            materialId: 'rm-pvd-10803',
            materialName: 'ПВД 10803-020',
            category: 'primary',
            unit: 'кг',
            erpActualQty: 90,
            oneCQty: 88,
            reservedQty: null,
            availableQty: 90,
            expectedUsageQty: null,
            openBigBagQty: null,
            recycledQty: null,
            sourceStatus: 'fresh',
            source: {
              snapshotId: 'qa-stock-snapshot',
              sourceKind: '1C',
              capturedAt: '2026-07-26T07:55:00.000Z',
              importedAt: '2026-07-26T08:00:00.000Z',
            },
            conflicts: [],
            updatedAt: '2026-07-26T08:00:00.000Z',
          },
        ],
        nextCursor: null,
        sourceUnavailable: false,
        generatedAt: '2026-07-26T08:01:00.000Z',
      });
    }
    if (requestUrl.pathname === '/api/warehouse/accounting-stock') {
      const consumables = requestUrl.searchParams.get('scope') === 'consumables';
      return json({
        items: [
          {
            nomenclatureExternalId: consumables ? 'qa-tape' : 'qa-goods',
            name: consumables ? 'Скотч упаковочный' : 'Пленка готовая',
            kind: consumables ? 'Материалы' : 'Товары',
            unit: consumables ? 'шт' : 'кг',
            quantity: consumables ? 12 : 240,
            balanceStatus: 'positive',
            capturedAt: '2026-07-26T07:55:00.000Z',
            importedAt: '2026-07-26T08:00:00.000Z',
            stale: false,
            physicalTraceability: 'unavailable',
          },
        ],
        nextCursor: null,
        accountCode: '41.01',
        scope: consumables ? 'consumables' : 'goods',
        generatedAt: '2026-07-26T08:01:00.000Z',
      });
    }
    if (requestUrl.pathname === '/api/warehouse/accounting-movements') {
      return json({
        items: [
          {
            externalId: 'qa-shipment',
            documentNumber: 'РТУ-QA-1',
            documentDate: '2026-07-25T08:00:00.000Z',
            direction: 'outbound',
            sourceLabel: 'Отгрузка по 1С',
            capturedAt: '2026-07-26T07:55:00.000Z',
            importedAt: '2026-07-26T08:00:00.000Z',
            physicalTraceability: 'unavailable',
            lines: [{ lineNumber: 1, name: 'Пленка готовая', quantity: 4, unit: 'кг' }],
          },
        ],
        nextCursor: null,
        generatedAt: '2026-07-26T08:01:00.000Z',
      });
    }
    if (requestUrl.pathname === '/api/warehouse/cover-checks') {
      return json({ items: [], nextCursor: null });
    }
    if (requestUrl.pathname === '/api/warehouse/warehouse-coverage/rechecks') return json([]);
    const inventoryResponse = warehouseInventoryFixtureResponse(requestUrl);
    if (inventoryResponse !== undefined) {
      return inventoryResponse === null
        ? route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Складской рулон не найден' }),
          })
        : json(inventoryResponse);
    }
    if (requestUrl.pathname === '/api/warehouse/rolls') return json([]);
    if (requestUrl.pathname === '/api/warehouse/intake') {
      return json({
        stats: { todayOps: 0, remainingQr: 0, errors: 0 },
        tasks: [],
        generatedAt: '2026-07-26T08:00:00.000Z',
      });
    }
    if (requestUrl.pathname === '/api/warehouse/tasks') return json([]);
    unhandledApiRoutes.add(`${requestUrl.pathname}${requestUrl.search}`);
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: `Unhandled QA route: ${requestUrl.pathname}` }),
    });
  });
}

async function openInventory(page, section, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(inventoryUrl(section), { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('.app-shell[data-active-role="warehouse"]').waitFor({
      state: 'visible',
      timeout: 10_000,
    });
  } catch {
    throw new Error(
      `${section}: warehouse shell did not render at ${page.url()}\n${(
        await page.locator('body').innerText()
      ).slice(0, 1_500)}`,
    );
  }
  try {
    await page.locator('.warehouse-inventory-cockpit').waitFor({
      state: 'visible',
      timeout: 10_000,
    });
  } catch {
    const pageText = (await page.locator('body').innerText()).slice(0, 1_500);
    const structure = await page.evaluate(() => ({
      children: Array.from(document.querySelector('main')?.children ?? []).map((element) => ({
        tag: element.tagName,
        className: element.className,
        display: getComputedStyle(element).display,
        text: (element.textContent ?? '').trim().slice(0, 120),
      })),
      detailPanelCount: document.querySelectorAll('.detail-panel').length,
      detailViewCount: document.querySelectorAll('.detail-view').length,
    }));
    throw new Error(
      `${section}: inventory surface did not render at ${page.url()}\n${pageText}\n${JSON.stringify(structure)}`,
    );
  }
  if (section === WAREHOUSE_STOCK_SECTION || section === WAREHOUSE_PROCESSED_VIEW) {
    await page.locator('.warehouse-stock-workspace').waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    await page.locator('.warehouse-stock-data-table tbody tr.is-interactive').first().waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    const selectedView = section === WAREHOUSE_PROCESSED_VIEW ? 'Обработанные' : 'Рулоны';
    await page
      .getByRole('tab', { name: selectedView, exact: true })
      .waitFor({ state: 'visible', timeout: 10_000 });
    assert(
      (await page
        .getByRole('tab', { name: selectedView, exact: true })
        .getAttribute('aria-selected')) === 'true',
      `${section}: expected inventory view is not selected`,
    );
    assert(
      (await page.locator('.warehouse-finished-stock, .warehouse-cover-tasks-panel').count()) === 0,
      `${section}: legacy stock surfaces are still rendered`,
    );
  }
  await page.waitForTimeout(100);
}

async function collectLayoutMetrics(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.warehouse-inventory-hub-page .role-top-nav');
    const view = document.querySelector('.detail-view.role-warehouse');
    const main = document.querySelector('.warehouse-inventory-main');
    const detail = document.querySelector('.warehouse-inventory-detail');
    const stockWorkspace = document.querySelector('.warehouse-stock-workspace');
    const stockTable = document.querySelector('.warehouse-stock-data-table');
    const accounting = document.querySelector('.warehouse-accounting-panel');
    const accountingTable = accounting?.querySelector('.safe-inventory-table');
    const navRect = nav?.getBoundingClientRect();
    const viewRect = view?.getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect();
    const detailRect = detail?.getBoundingClientRect();
    const stockWorkspaceRect = stockWorkspace?.getBoundingClientRect();
    const stockTableRect = stockTable?.getBoundingClientRect();
    const accountingRect = accounting?.getBoundingClientRect();
    const accountingTableRect = accountingTable?.getBoundingClientRect();
    const firstDataRow = document.querySelector(
      '.warehouse-inventory-data-table tbody tr.is-interactive',
    );

    return {
      gapAfterNav: navRect && viewRect ? viewRect.top - navRect.bottom : Number.POSITIVE_INFINITY,
      viewWidth: viewRect?.width ?? 0,
      mainWidth: mainRect?.width ?? 0,
      detailWidth: detailRect?.width ?? 0,
      mainLeft: mainRect?.left ?? Number.POSITIVE_INFINITY,
      mainRight: mainRect?.right ?? Number.NEGATIVE_INFINITY,
      detailLeft: detailRect?.left ?? Number.POSITIVE_INFINITY,
      detailRight: detailRect?.right ?? Number.NEGATIVE_INFINITY,
      mainTop: mainRect?.top ?? Number.POSITIVE_INFINITY,
      mainBottom: mainRect?.bottom ?? Number.POSITIVE_INFINITY,
      detailTop: detailRect?.top ?? Number.NEGATIVE_INFINITY,
      stockWorkspaceWidth: stockWorkspaceRect?.width ?? 0,
      stockWorkspaceTop: stockWorkspaceRect?.top ?? Number.POSITIVE_INFINITY,
      stockTableWidth: stockTableRect?.width ?? 0,
      accountingWidth: accountingRect?.width ?? 0,
      accountingTop: accountingRect?.top ?? Number.POSITIVE_INFINITY,
      accountingTableWidth: accountingTableRect?.width ?? 0,
      viewportWidth: document.documentElement.clientWidth,
      pageScrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      firstDataRowHeight: firstDataRow?.getBoundingClientRect().height ?? 0,
    };
  });
}

function assertNoPageOverflow(metrics, context) {
  assert(
    metrics.pageScrollWidth <= metrics.viewportWidth + 2,
    `${context}: page overflow ${JSON.stringify(metrics)}`,
  );
}

async function assertWideLayout(page, section) {
  const viewport = { width: 2048, height: 1200 };
  await openInventory(page, section, viewport);
  const metrics = await collectLayoutMetrics(page);
  assert(metrics.gapAfterNav <= 32, `${section}: vertical gap remains ${JSON.stringify(metrics)}`);
  assert(
    metrics.viewWidth >= metrics.viewportWidth - 64,
    `${section}: inventory view remains capped ${JSON.stringify(metrics)}`,
  );
  if (section === WAREHOUSE_STOCK_SECTION || section === WAREHOUSE_PROCESSED_VIEW) {
    assert(
      metrics.stockWorkspaceWidth >= metrics.viewWidth - 64 && metrics.stockTableWidth > 0,
      `${section}: unified stock workspace is not the primary surface ${JSON.stringify(metrics)}`,
    );
    assertNoPageOverflow(metrics, `${section} wide`);
    await captureScreenshot(page, section, viewport);
    return;
  }
  if (section === 'Расходники' || section === 'Движения') {
    assert(
      metrics.accountingWidth >= metrics.viewWidth - 64 && metrics.accountingTableWidth > 0,
      `${section}: accounting table is not the primary surface ${JSON.stringify(metrics)}`,
    );
    assertNoPageOverflow(metrics, `${section} wide`);
    await captureScreenshot(page, section, viewport);
    return;
  }
  assert(
    metrics.mainWidth > metrics.detailWidth * 1.5,
    `${section}: table is not the primary column ${JSON.stringify(metrics)}`,
  );
  assertNoPageOverflow(metrics, `${section} wide`);
  await captureScreenshot(page, section, viewport);
}

async function assertCompactLayout(page, section) {
  const viewport = { width: 1024, height: 768 };
  await openInventory(page, section, viewport);
  const metrics = await collectLayoutMetrics(page);
  assert(
    metrics.gapAfterNav <= 32,
    `${section}: compact vertical gap remains ${JSON.stringify(metrics)}`,
  );
  if (section === WAREHOUSE_STOCK_SECTION || section === WAREHOUSE_PROCESSED_VIEW) {
    assert(
      metrics.stockWorkspaceTop < Number.POSITIVE_INFINITY && metrics.stockTableWidth > 0,
      `${section}: compact unified stock workspace did not render ${JSON.stringify(metrics)}`,
    );
    assertNoPageOverflow(metrics, `${section} compact`);
    await captureScreenshot(page, section, viewport);
    return;
  }
  if (section === 'Расходники' || section === 'Движения') {
    assert(
      metrics.accountingTop < Number.POSITIVE_INFINITY && metrics.accountingTableWidth > 0,
      `${section}: compact accounting table did not render ${JSON.stringify(metrics)}`,
    );
    assertNoPageOverflow(metrics, `${section} compact`);
    await captureScreenshot(page, section, viewport);
    return;
  }
  assert(
    Math.abs(metrics.detailLeft - metrics.mainLeft) <= 1 &&
      metrics.detailTop >= metrics.mainBottom &&
      metrics.mainWidth >= metrics.viewWidth - 2 &&
      metrics.detailWidth >= metrics.viewWidth - 2 &&
      metrics.detailRight <= metrics.viewportWidth + 1,
    `${section}: compact master/detail is not safely stacked ${JSON.stringify(metrics)}`,
  );
  if (section === 'Сырье') {
    assert(
      metrics.firstDataRowHeight > 0 && metrics.firstDataRowHeight <= 320,
      `${section}: compact row remains excessively tall ${JSON.stringify(metrics)}`,
    );
  }
  assertNoPageOverflow(metrics, `${section} compact`);
  await captureScreenshot(page, section, viewport);
}

const { server, logs } = startServer();
let browser;

try {
  await waitForServer(server, logs);
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  await installWarehouseApiFixture(page);
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  for (const section of inventorySections) {
    await assertWideLayout(page, section);
    await assertCompactLayout(page, section);
  }

  await openInventory(page, 'Сырье', { width: 1366, height: 768 });
  assertNoPageOverflow(await collectLayoutMetrics(page), 'Сырье 1366');
  const firstRawMaterialRow = page
    .locator('.warehouse-inventory-data-table-raw tbody tr.is-interactive')
    .first();
  await firstRawMaterialRow.click();
  await page.locator('.warehouse-inventory-detail h3').waitFor({ state: 'visible' });
  assert(
    (await page.locator('.warehouse-inventory-detail h3').innerText()).includes('ПВД'),
    'Сырье: row selection did not open the detail panel',
  );

  await openInventory(page, 'Сырье', { width: 1024, height: 768 });
  const bigBagListMetrics = await page.locator('.warehouse-bigbag-list').evaluate((list) => {
    const items = Array.from(list.querySelectorAll(':scope > button')).map((item) => ({
      clientHeight: item.clientHeight,
      scrollHeight: item.scrollHeight,
      top: item.getBoundingClientRect().top,
      bottom: item.getBoundingClientRect().bottom,
    }));
    return {
      count: items.length,
      scrolls: list.scrollHeight > list.clientHeight,
      clipsContent: items.some((item) => item.scrollHeight > item.clientHeight + 1),
      overlaps: items.some((item, index) => index > 0 && item.top < items[index - 1].bottom),
    };
  });
  assert(
    bigBagListMetrics.count === warehouseBigBags.length,
    `Сырье: incomplete Big-Bag list ${JSON.stringify(bigBagListMetrics)}`,
  );
  assert(
    bigBagListMetrics.scrolls,
    `Сырье: long Big-Bag list must scroll ${JSON.stringify(bigBagListMetrics)}`,
  );
  assert(
    !bigBagListMetrics.clipsContent && !bigBagListMetrics.overlaps,
    `Сырье: Big-Bag card content escapes its bounds ${JSON.stringify(bigBagListMetrics)}`,
  );
  const secondBigBag = page.locator('.warehouse-bigbag-list > button').nth(1);
  await secondBigBag.click();
  assert(
    (await secondBigBag.getAttribute('aria-pressed')) === 'true',
    'Сырье: Big-Bag selection did not update',
  );

  const mobileViewport = { width: 390, height: 844 };
  await openInventory(page, WAREHOUSE_STOCK_SECTION, mobileViewport);
  assertNoPageOverflow(await collectLayoutMetrics(page), `${WAREHOUSE_STOCK_SECTION} 390`);
  await captureScreenshot(page, WAREHOUSE_STOCK_SECTION, mobileViewport);

  assert(
    unhandledApiRoutes.size === 0,
    `warehouse responsive unhandled API routes: ${[...unhandledApiRoutes].join(', ')}`,
  );
  assert(
    obsoletePostRouteRequests.length === 0,
    `warehouse responsive requested obsolete post routes: ${obsoletePostRouteRequests.join(', ')}`,
  );
  assert(
    consoleErrors.length === 0,
    `warehouse responsive console errors: ${consoleErrors.join(' | ')}; unhandled API routes: ${[
      ...unhandledApiRoutes,
    ].join(', ')}`,
  );
  console.log('Warehouse inventory responsive smoke passed.');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
