import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.WAREHOUSE_AUDIT_URL ?? 'http://127.0.0.1:5174';
const outputDir = path.resolve('qa-screenshots/warehouse-account-2026-07-14');
const sections = [
  'Приемка',
  'Все рулоны',
  'Выдача',
  'Сырье',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function slug(value) {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-|-$/g, '');
}

async function layoutMetrics(page) {
  return page.evaluate(() => {
    const queue = document.querySelector('.warehouse-scan-queue-scroll');
    const activeNav = document.querySelector(
      '.role-top-nav-item[aria-current="page"], .mobile-section-nav-item[aria-current="page"]',
    );
    return {
      viewportWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      htmlScrollWidth: document.documentElement.scrollWidth,
      activeSection: activeNav?.textContent?.trim() ?? '',
      queue: queue
        ? {
            clientHeight: queue.clientHeight,
            scrollHeight: queue.scrollHeight,
            overflowY: getComputedStyle(queue).overflowY,
          }
        : null,
    };
  });
}

async function assertNoBodyOverflow(page, context) {
  const metrics = await layoutMetrics(page);
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.htmlScrollWidth) <= metrics.viewportWidth + 2,
    `${context}: horizontal body overflow ${JSON.stringify(metrics)}`,
  );
  return metrics;
}

async function clickDesktopSection(page, section) {
  const target = page.locator('.role-top-nav-item:visible').filter({ hasText: section }).first();
  await target.waitFor({ state: 'visible', timeout: 10_000 });
  await target.click();
  await page.waitForFunction(
    (expected) => new URL(window.location.href).searchParams.get('section') === expected,
    section,
  );
  await page.waitForTimeout(180);
}

async function loginWarehouse(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const login = page.getByLabel('Логин');
  if (await login.isVisible().catch(() => false)) {
    await login.fill('warehouse');
    await page.getByLabel('Пароль').fill('plenka-dev');
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes('/api/auth/login') && response.status() === 201,
      ),
      page.getByRole('button', { name: 'Войти' }).click(),
    ]);
  }
  await page.locator('.app-shell[data-active-role="warehouse"]').waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  await page.locator('input[aria-label="Сканирование QR"]').waitFor({
    state: 'visible',
    timeout: 15_000,
  });
}

async function liveIntakeTasks(page) {
  return page.evaluate(async () => {
    const raw = localStorage.getItem('plenki.auth.v1');
    const token = raw ? JSON.parse(raw).token : '';
    const response = await fetch('/api/warehouse/intake', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`intake ${response.status}`);
    const body = await response.json();
    return Array.isArray(body) ? body : (body.items ?? body.tasks ?? []);
  });
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const failedRequests = [];
const requestedUrls = [];
const expectedAborts = new Set();

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('request', (request) => requestedUrls.push(request.url()));
page.on('response', (response) => {
  if (response.status() >= 400) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});
page.on('requestfailed', (request) => {
  const error = request.failure()?.errorText ?? 'failed';
  if (!expectedAborts.has(request.url()) && error !== 'net::ERR_ABORTED') {
    failedRequests.push({ url: request.url(), error });
  }
});

const report = { baseUrl, sections: [], responsive: [], downloads: [], scan: null };

try {
  await loginWarehouse(page);
  const tasksBeforeScan = await liveIntakeTasks(page);
  const scanTarget = tasksBeforeScan
    .flatMap((task) =>
      (task.rolls ?? []).map((roll) => ({
        taskId: task.taskId,
        orderNumber: task.orderNumber,
        scanStatus: roll.scanStatus,
        payload: roll.qrCode,
      })),
    )
    .find((roll) => roll.scanStatus === 'expected' && roll.payload);
  assert(scanTarget, 'No live expected QR is available for the scan audit.');

  await clickDesktopSection(page, 'Приемка');
  await page.getByText('Выберите заказ или отсканируйте QR', { exact: true }).waitFor();
  const scanInput = page.locator('input[aria-label="Сканирование QR"]');
  let abortNextScan = true;
  await page.route('**/api/warehouse/intake/scans', async (route) => {
    if (abortNextScan) {
      abortNextScan = false;
      expectedAborts.add(route.request().url());
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await scanInput.fill(scanTarget.payload);
  await scanInput.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Скан не отправлен' }).waitFor();
  assert(
    (await scanInput.inputValue()) === scanTarget.payload,
    'Failed scan must preserve payload.',
  );

  const scanResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/warehouse/intake/scans') && response.status() === 201,
  );
  await scanInput.press('Enter');
  await scanResponse;
  await page.waitForFunction(
    (taskId) => new URL(window.location.href).searchParams.get('object') === `intake-${taskId}`,
    scanTarget.taskId,
  );
  assert((await scanInput.inputValue()) === '', 'Accepted scan must clear payload.');
  await page.getByRole('button', { name: 'Закрыть складскую операцию' }).waitFor();

  const queueMetrics = await page.locator('.warehouse-scan-queue-scroll').evaluate((queue) => {
    queue.scrollTop = Math.max(1, queue.scrollHeight - queue.clientHeight);
    return {
      clientHeight: queue.clientHeight,
      scrollHeight: queue.scrollHeight,
      scrollTop: queue.scrollTop,
      overflowY: getComputedStyle(queue).overflowY,
    };
  });
  assert(
    queueMetrics.scrollHeight > queueMetrics.clientHeight,
    'Queue must have its own overflow.',
  );
  assert(queueMetrics.scrollTop > 0, 'Queue must scroll independently.');
  assert(queueMetrics.overflowY === 'auto', 'Queue overflow-y must be auto.');

  await page.screenshot({
    path: path.join(outputDir, 'desktop-scan-selected.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Закрыть складскую операцию' }).click();
  await page.getByText('Выберите заказ или отсканируйте QR', { exact: true }).waitFor();
  assert(
    !new URL(page.url()).searchParams.has('object'),
    'Close must remove the object query parameter.',
  );
  report.scan = { target: scanTarget, queue: queueMetrics };

  await page.unroute('**/api/warehouse/intake/scans');
  await page.waitForTimeout(4_600);

  for (const section of sections) {
    await clickDesktopSection(page, section);
    const metrics = await assertNoBodyOverflow(page, `desktop ${section}`);
    if (section === 'Склад рулонов') {
      await page.getByText('Выберите позицию', { exact: true }).waitFor();
      const firstRow = page
        .locator('.warehouse-inventory-data-table tbody tr.is-interactive')
        .first();
      await firstRow.click();
      await page.getByRole('button', { name: 'Закрыть позицию склада' }).click();
      await page.getByText('Выберите позицию', { exact: true }).waitFor();
    }
    if (section === 'Выдача') {
      const firstRow = page
        .locator('.warehouse-scan-station-data-table tbody tr.is-interactive')
        .first();
      if ((await firstRow.count()) > 0) {
        await firstRow.click();
        await page.getByText('Палетный лист недоступен', { exact: true }).waitFor();
        assert(
          requestedUrls.every((url) => !url.includes('/pallet-lists/PLD-PAL-')),
          'Fixture pallet document must not request a live preview.',
        );
      }
    }
    await page.screenshot({
      path: path.join(outputDir, `desktop-${slug(section)}.png`),
      fullPage: true,
    });
    report.sections.push({ section, metrics });
  }
  for (const viewport of [
    { name: 'tablet', width: 1024, height: 768 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const section of ['Приемка', 'Склад рулонов']) {
      const url = `${baseUrl}/?role=warehouse&section=${encodeURIComponent(section)}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('.app-shell[data-active-role="warehouse"]').waitFor();
      if (section === 'Приемка') {
        await page.locator('input[aria-label="Сканирование QR"]').waitFor();
      } else {
        await page.locator('.warehouse-inventory-cockpit').waitFor();
      }
      const metrics = await assertNoBodyOverflow(page, `${viewport.name} ${section}`);
      await page.screenshot({
        path: path.join(outputDir, `${viewport.name}-${slug(section)}.png`),
        fullPage: true,
      });
      report.responsive.push({ viewport, section, metrics });
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const tasksAfterScan = await liveIntakeTasks(page);
  const exportTask = tasksAfterScan.find((task) => task.palletList?.id);
  assert(exportTask, 'No live pallet list is available for browser downloads.');
  const exportUrl = `${baseUrl}/?role=warehouse&section=${encodeURIComponent('Приемка')}&object=${encodeURIComponent(`intake-${exportTask.taskId}`)}`;
  await page.goto(exportUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.warehouse-pallet-label-panel').waitFor({ timeout: 15_000 });
  for (const [label, extension] of [
    ['Word', 'docx'],
    ['Excel', 'xlsx'],
    ['PDF', 'pdf'],
  ]) {
    const button = page
      .locator('.warehouse-pallet-export-button')
      .filter({ hasText: label })
      .first();
    await button.waitFor({ state: 'visible' });
    await page.waitForFunction(
      (buttonLabel) => {
        const buttons = Array.from(document.querySelectorAll('.warehouse-pallet-export-button'));
        const candidate = buttons.find((element) => element.textContent?.includes(buttonLabel));
        return candidate instanceof HTMLButtonElement && !candidate.disabled;
      },
      label,
      { timeout: 15_000 },
    );
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    const target = path.join(outputDir, `pallet-list.${extension}`);
    await download.saveAs(target);
    report.downloads.push({ label, target, suggestedFilename: download.suggestedFilename() });
  }

  const unexpectedConsoleErrors = [...consoleErrors];
  const expectedScanErrorIndex = unexpectedConsoleErrors.indexOf(
    'Failed to load resource: net::ERR_FAILED',
  );
  if (expectedScanErrorIndex >= 0) unexpectedConsoleErrors.splice(expectedScanErrorIndex, 1);
  assert(
    unexpectedConsoleErrors.length === 0,
    `Console errors: ${JSON.stringify(unexpectedConsoleErrors)}`,
  );
  assert(pageErrors.length === 0, `Page errors: ${JSON.stringify(pageErrors)}`);
  assert(failedRequests.length === 0, `Failed requests: ${JSON.stringify(failedRequests)}`);
  assert(failedResponses.length === 0, `HTTP errors: ${JSON.stringify(failedResponses)}`);
  await writeFile(
    path.join(outputDir, 'warehouse-account-audit.json'),
    JSON.stringify(
      {
        ...report,
        status: 'passed',
        consoleErrors,
        pageErrors,
        failedRequests,
        failedResponses,
      },
      null,
      2,
    ),
  );
  console.log(`Warehouse account audit passed: ${outputDir}`);
} catch (error) {
  await writeFile(
    path.join(outputDir, 'warehouse-account-audit.json'),
    JSON.stringify(
      {
        ...report,
        status: 'failed',
        error: String(error),
        consoleErrors,
        pageErrors,
        failedRequests,
        failedResponses,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
}
