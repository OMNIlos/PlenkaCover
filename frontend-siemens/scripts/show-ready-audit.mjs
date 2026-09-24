import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { installBusinessPerformanceSmokeFixture } from './business-performance-smoke-fixture.mjs';
import { entriesForRoute } from './show-ready-audit-support.mjs';

const port = 5192;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = path.resolve('qa-screenshots/show-ready-2026-06-04');
const reportPath = path.join(screenshotDir, 'show-ready-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');

const roles = ['commercial', 'production', 'finance', 'director', 'operator', 'warehouse', 'admin'];
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const pictogramRoles = new Set(['operator', 'warehouse']);
const hoverEvidenceRoles = new Set(['commercial', 'operator', 'warehouse', 'admin']);
const operatorMassSummaryPath = /^\/api\/operator\/orders\/[^/]+\/mass-summary$/;

async function installOperatorMassSummarySmokeFixture(browserPage) {
  await browserPage.route('**/api/operator/orders/*/mass-summary', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!operatorMassSummaryPath.test(pathname)) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        orderPlannedNetKg: 200,
        weighedPlannedNetKg: 100,
        actualNetKg: 101,
        deviationKg: 1,
        weighedRollCount: 1,
        totalRollCount: 2,
      }),
    });
  });
}

const globalForbidden = [
  'Демо-роли',
  'demo',
  'mock',
  'adapter',
  'source of truth',
  'ProductionOrder',
  'AuditEvent',
  'OperationalEvent',
  'production-интеграция',
  'started',
  'closed facts',
  'payload',
  'Проверить QR',
  'Наклеил этикетку',
  'Завпроизводство',
  'Event',
];

const roleForbidden = {
  operator: [
    'Счет',
    'Оплата',
    'Статус оплаты',
    'Бухгалтерская толщина',
    'Отгрузка',
    'Откат',
    '1С',
    'ООО',
  ],
  warehouse: [
    'Откат',
    'Статус оплаты',
    'Бухгалтерская толщина',
    'Сумма',
    'Влияние на стоимость',
    'Частично оплачен',
    'Не оплачен',
    'Просрочка',
  ],
};

function waitForServer(server, serverLogs) {
  const deadline = Date.now() + 25_000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (server.exitCode !== null || server.signalCode !== null) {
        reject(
          new Error(
            `Vite preview server exited before it was ready.\n${serverLogs.join('\n').slice(-2000)}`,
          ),
        );
        return;
      }

      try {
        const response = await fetch(`${baseUrl}/?role=operator`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Retry until the Vite dev server is reachable.
      }

      if (Date.now() > deadline) {
        reject(
          new Error(
            `Vite preview server did not start in time.\n${serverLogs.join('\n').slice(-2000)}`,
          ),
        );
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function collectText(page) {
  const bodyText = await page.locator('body').innerText();
  const attributeText = await page
    .locator('[title], [aria-label], ix-tooltip')
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          [element.getAttribute('title'), element.getAttribute('aria-label'), element.textContent]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n'),
    );

  return `${bodyText}\n${attributeText}`;
}

function findLeaks(text, terms) {
  const normalized = text.toLowerCase();
  return terms.filter((term) => {
    if (term === '1С') {
      return /(^|[\s"'«(])1с(?=$|[\s"'»:;,.!?)])/.test(normalized);
    }
    return normalized.includes(term.toLowerCase());
  });
}

function isIgnoredDevConsoleError(text) {
  return (
    (text.includes('WebSocket connection to') && text.includes('ERR_CONNECTION_REFUSED')) ||
    (text.includes('WebSocket connection to') && text.includes('Unexpected response code: 200')) ||
    text.includes('[vite] failed to connect to websocket') ||
    (text.includes('Failed to send error to Vite server') &&
      text.includes('WebSocket closed without opened'))
  );
}

async function checkOverflow(page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const docWidth = document.documentElement.scrollWidth;
    const bodyWidth = document.body.scrollWidth;
    const offenders = Array.from(document.querySelectorAll('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: String(element.getAttribute('class') ?? ''),
          text: String(element.textContent ?? '')
            .trim()
            .slice(0, 90),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter((entry) => entry.width > 0 && (entry.left < -1 || entry.right > viewport + 1))
      .slice(0, 8);

    return { viewport, docWidth, bodyWidth, offenders };
  });
}

async function checkPictogram(page) {
  const illustration = page.locator('.step-illustration').first();
  const count = await page.locator('.step-illustration').count();
  const box = count > 0 ? await illustration.boundingBox() : null;
  const iconName =
    count > 0 ? await illustration.locator('ix-icon').first().getAttribute('name') : null;

  return {
    count,
    iconName,
    visible: Boolean(box && box.width >= 44 && box.height >= 44 && iconName),
    box,
  };
}

async function selectFirstWorkspaceObject(page, role) {
  if (role === 'operator') {
    await page
      .locator('.operator-rolls-hub-row:not(.is-head), .operator-orders-row:not(.is-head)')
      .first()
      .click();
    return;
  }
  const candidate = page
    .locator(
      [
        '.queue-row-main',
        '.queue-row button',
        '.warehouse-roll-row:not(.is-head)',
        '.warehouse-inventory-row',
        '.warehouse-pallet-sheet-row',
      ].join(', '),
    )
    .first();
  await candidate.click();
}

async function scrollToTop(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.documentElement.scrollLeft = 0;
    document.body.scrollTop = 0;
    document.body.scrollLeft = 0;
    document.querySelectorAll('*').forEach((element) => {
      if (element instanceof HTMLElement) {
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
    });
  });
  await page.waitForTimeout(150);
}

async function checkTooltips(page, role, viewportName) {
  const targets = page.locator('.help-tooltip-target[title], .help-icon-frame[title]');
  const count = await targets.count();
  const focusableCount = await page
    .locator('.help-tooltip-target[title][tabindex="0"], .help-icon-frame[title][tabindex="0"]')
    .count();
  const ixTooltipCount = await page.locator('ix-tooltip').count();
  const first = targets.first();
  const firstTitle = count > 0 ? await first.getAttribute('title') : null;
  const emptyTitleCount = await page
    .locator('.help-tooltip-target[title=""], .help-icon-frame[title=""]')
    .count();
  const verboseTitleCount = await page
    .locator('[title]')
    .evaluateAll(
      (elements) =>
        elements.filter((element) => String(element.getAttribute('title') ?? '').length > 140)
          .length,
    );

  if (count > 0) {
    await first.hover();
    await page.waitForTimeout(350);
  }

  if (viewportName === 'desktop' && hoverEvidenceRoles.has(role) && count > 0) {
    await page.screenshot({
      path: path.join(screenshotDir, `${role}-${viewportName}-tooltip.png`),
      fullPage: true,
    });
  }

  if (focusableCount > 0) {
    await page
      .locator('.help-tooltip-target[title][tabindex="0"], .help-icon-frame[title][tabindex="0"]')
      .first()
      .focus();
    await page.waitForTimeout(150);
  }

  return {
    count,
    focusableCount,
    ixTooltipCount,
    emptyTitleCount,
    verboseTitleCount,
    firstTitle,
    ok: emptyTitleCount === 0 && verboseTitleCount === 0 && (count === 0 || Boolean(firstTitle)),
  };
}

async function clearTooltipState(page, viewport) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(Math.max(1, viewport.width - 4), Math.max(1, viewport.height - 4));
  await page.waitForTimeout(500);
}

await mkdir(screenshotDir, { recursive: true });

const serverLogs = [];
const server = spawn(
  viteBin,
  ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: { ...process.env, VITE_LIVE_CONTOURS: '', VITE_REQUIRE_AUTH: 'off' },
  },
);

server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

let browser;
const report = {
  baseUrl,
  screenshotDir,
  roles,
  viewports,
  results: [],
};

try {
  await waitForServer(server, serverLogs);
  browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    await installBusinessPerformanceSmokeFixture(page);
    await installOperatorMassSummarySmokeFixture(page);
    const consoleErrors = [];
    const requestErrors = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        const text = message.text();
        if (!isIgnoredDevConsoleError(text)) consoleErrors.push(text);
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        requestErrors.push(
          `${response.status()} ${response.request().method()} ${response.url()}`,
        );
      }
    });

    for (const role of roles) {
      const consoleErrorStart = consoleErrors.length;
      const requestErrorStart = requestErrors.length;
      const url = `${baseUrl}/?role=${role}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.mouse.move(0, 0);
      await scrollToTop(page);

      const text = await collectText(page);
      const leaks = [
        ...findLeaks(text, globalForbidden),
        ...findLeaks(text, roleForbidden[role] ?? []),
      ];
      const overflow = await checkOverflow(page);
      let pictogram = { count: 0, visible: true, iconName: null, box: null };
      if (pictogramRoles.has(role)) {
        await selectFirstWorkspaceObject(page, role);
        await page.waitForTimeout(150);
        pictogram = await checkPictogram(page);
      }
      const tooltip = await checkTooltips(page, role, viewport.name);
      const screenshotPath = path.join(screenshotDir, `${role}-${viewport.name}.png`);

      await clearTooltipState(page, viewport);
      await page.goto(url, { waitUntil: 'networkidle' });
      await scrollToTop(page);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const routeConsoleErrors = entriesForRoute(consoleErrors, consoleErrorStart);
      const routeRequestErrors = entriesForRoute(requestErrors, requestErrorStart);

      const ok =
        leaks.length === 0 &&
        overflow.docWidth <= overflow.viewport + 1 &&
        overflow.bodyWidth <= overflow.viewport + 1 &&
        tooltip.ok &&
        pictogram.visible &&
        routeConsoleErrors.length === 0 &&
        routeRequestErrors.length === 0;

      report.results.push({
        role,
        viewport: viewport.name,
        url,
        screenshotPath,
        leaks,
        overflow,
        tooltip,
        pictogram,
        consoleErrors: routeConsoleErrors,
        requestErrors: routeRequestErrors,
        ok,
      });
    }

    await page.close();
  }

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const failed = report.results.filter((result) => !result.ok);
  if (failed.length > 0) {
    const summary = failed
      .map(
        (result) =>
          `${result.role}/${result.viewport}: leaks=${result.leaks.join(',') || 'none'}, overflow=${result.overflow.docWidth}/${result.overflow.bodyWidth}/${result.overflow.viewport}, tooltips=${result.tooltip.count}, pictogram=${result.pictogram.visible}, consoleErrors=${result.consoleErrors.length}, requestErrors=${result.requestErrors.length}`,
      )
      .join('\n');
    throw new Error(`Show-ready audit failed:\n${summary}\nReport: ${reportPath}`);
  }

  console.log(`Show-ready audit passed. Screenshots: ${screenshotDir}`);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
