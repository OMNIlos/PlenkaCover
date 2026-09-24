import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

assert.match(
  source,
  /if \(role === 'warehouse'\) return resolveWarehouseSection\(section, searchParams\)\.section;/u,
);
assert.match(source, /normalizeSectionForRole\(role, requestedSection, searchParams\)/u);
assert.match(
  source,
  /normalizeSectionForRole\(\s*activeRole,\s*section,\s*new URLSearchParams\(window\.location\.search\),\s*\)/u,
);
assert.match(source, /normalizeWarehouseSectionUrl\(requestedHref, requestedSection\)/u);
assert.doesNotMatch(source, /\['Приемка', 'Отгрузка', 'Выдача'\]\.includes\(activeSection\)/u);

const suppliedBase = process.env.SMOKE_BASE;
const port = 5277;
const base = suppliedBase ?? `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');

function startServer() {
  const logs = [];
  const server = spawn(
    viteBin,
    ['--host', '127.0.0.1', '--port', String(port), '--strictPort', '--mode', 'test'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VITE_LIVE_CONTOURS: 'warehouse',
        VITE_REQUIRE_AUTH: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { logs, server };
}

async function waitForServer(server, logs) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Vite exited before ready.\n${logs.join('\n').slice(-2000)}`);
    }
    try {
      const response = await fetch(base);
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Vite did not start in time.\n${logs.join('\n').slice(-2000)}`);
}

const isolatedServer = suppliedBase ? null : startServer();
let browser;

try {
  if (isolatedServer) await waitForServer(isolatedServer.server, isolatedServer.logs);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const url = new URL(base);
  url.searchParams.set('role', 'warehouse');
  url.searchParams.set('section', 'Входящие заявки');

  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  await page.locator('.app-shell').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.get('section') === 'Приемка',
  );

  const denied = page.locator('.access-denied-banner');
  if ((await denied.count()) !== 0) {
    throw new Error('A stale foreign section still renders the useless access-denied banner.');
  }

  const current = new URL(page.url());
  if (current.searchParams.get('section') !== 'Приемка') {
    const role = await page.locator('.app-shell').getAttribute('data-active-role');
    throw new Error(
      `Expected warehouse default section in URL, got ${current.searchParams.get('section')} (role=${role}).`,
    );
  }

  const legacyUrl = new URL(base);
  legacyUrl.searchParams.set('role', 'warehouse');
  legacyUrl.searchParams.set('section', 'Отгрузка');
  legacyUrl.searchParams.set('object', 'WH-2606-047');

  await page.goto(legacyUrl.toString(), { waitUntil: 'networkidle' });
  await page.locator('.app-shell[data-active-role="warehouse"]').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.get('section') === 'Выдача',
  );

  const normalizedLegacyUrl = new URL(page.url());
  if (normalizedLegacyUrl.searchParams.get('object') !== 'WH-2606-047') {
    throw new Error('Legacy warehouse route normalization discarded the selected object context.');
  }

  const obsoleteWarehouseNavigation = page.locator(
    '.role-top-nav-item[aria-label="Отгрузка"], .mobile-section-nav-item[aria-label="Отгрузка"], .mobile-nav-drawer-item[aria-label="Отгрузка"]',
  );
  if ((await obsoleteWarehouseNavigation.count()) !== 0) {
    throw new Error('Warehouse navigation still renders the obsolete shipment item.');
  }
  const canonicalWarehouseNavigation = page.locator(
    '.role-top-nav-item[aria-label="Выдача"], .mobile-section-nav-item[aria-label="Выдача"], .mobile-nav-drawer-item[aria-label="Выдача"]',
  );
  if ((await canonicalWarehouseNavigation.count()) !== 1) {
    throw new Error('Warehouse navigation must render exactly one canonical delivery item.');
  }

  const legacyStockUrl = new URL(base);
  legacyStockUrl.searchParams.set('role', 'warehouse');
  legacyStockUrl.searchParams.set('section', 'Запасы / резерв');
  legacyStockUrl.searchParams.set('stockBucket', 'available');
  legacyStockUrl.searchParams.set('debug', '1');

  await page.goto(legacyStockUrl.toString(), { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.get('section') === 'Все рулоны',
  );
  const normalizedStockUrl = new URL(page.url());
  if (
    normalizedStockUrl.searchParams.has('view') ||
    normalizedStockUrl.searchParams.has('stockBucket') ||
    normalizedStockUrl.searchParams.get('debug') !== '1'
  ) {
    throw new Error('Legacy reserve route did not fail closed to rolls or preserve debug context.');
  }
  if (
    (await page
      .locator('.role-top-nav-item[aria-label="Все рулоны"][aria-current="page"]')
      .count()) !== 1
  ) {
    throw new Error('Legacy reserve route did not activate the canonical stock section.');
  }

  const legacyProcessedUrl = new URL(base);
  legacyProcessedUrl.searchParams.set('role', 'warehouse');
  legacyProcessedUrl.searchParams.set('section', 'Запасы / резерв');
  legacyProcessedUrl.searchParams.set('stockBucket', 'processed');
  legacyProcessedUrl.searchParams.set('debug', '1');

  await page.goto(legacyProcessedUrl.toString(), { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      new URL(window.location.href).searchParams.get('section') === 'Все рулоны' &&
      new URL(window.location.href).searchParams.get('view') === 'processed',
  );
  const normalizedProcessedUrl = new URL(page.url());
  if (
    normalizedProcessedUrl.searchParams.has('stockBucket') ||
    normalizedProcessedUrl.searchParams.get('debug') !== '1'
  ) {
    throw new Error('Legacy processed route was cleaned before its stock bucket was resolved.');
  }
  if (
    (await page
      .locator('.role-top-nav-item[aria-label="Все рулоны"][aria-current="page"]')
      .count()) !== 1
  ) {
    throw new Error('Legacy processed route did not activate the canonical stock section.');
  }

  const obsoleteStockNavigation = page.locator(
    '.role-top-nav-item[aria-label="Склад рулонов"], .role-top-nav-item[aria-label="Запасы / резерв"]',
  );
  if ((await obsoleteStockNavigation.count()) !== 0) {
    throw new Error('Warehouse navigation still renders legacy duplicate stock items.');
  }
  const canonicalStockNavigation = page.locator('.role-top-nav-item[aria-label="Все рулоны"]');
  if ((await canonicalStockNavigation.count()) !== 1) {
    throw new Error('Warehouse navigation must render exactly one canonical stock item.');
  }

  console.log('OK stale, delivery, and stock warehouse routes are silently normalized');
} finally {
  if (browser) await browser.close();
  isolatedServer?.server.kill('SIGTERM');
}
