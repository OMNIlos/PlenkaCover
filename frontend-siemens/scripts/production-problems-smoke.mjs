import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5284;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');
const screenshotDir = process.env.PRODUCTION_PROBLEMS_SCREENSHOT_DIR;
const unhandledApiRoutes = new Set();

const problem = {
  id: 'problem-qa-defect',
  type: 'defect',
  status: 'open',
  orderId: 'order-qa-1',
  positionId: 'position-qa-1',
  rollId: 'ROLL-QA-1',
  actorRole: 'operator',
  reason: 'Разрыв полотна на контрольном участке',
  recovery: null,
  createdAt: '2026-08-16T08:30:00.000Z',
  resolvedAt: null,
  postId: 'post-qa-1',
  post: {
    id: 'post-qa-1',
    code: 'POST-QA-1',
    name: 'Экструдер QA-1',
    status: 'online',
  },
  order: { id: 'order-qa-1', orderNumber: 'З-QA-1' },
  defectWeightKg: 42.6,
  defectWeightCapturedAt: '2026-08-16T08:29:30.000Z',
  defectWeightSource: 'operator_scale',
};

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
        VITE_LIVE_CONTOURS: 'production,director',
        VITE_REQUIRE_AUTH: 'on',
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
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not start in time.\n${logs.join('\n').slice(-2_000)}`);
}

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function activeRole(page) {
  return new URL(page.url()).searchParams.get('role') === 'director' ? 'director' : 'production';
}

function profile(role) {
  const director = role === 'director';
  return {
    userId: director ? 'qa-director' : 'qa-production',
    role: director ? 'director' : 'production_lead',
    capabilities: director ? ['director:read'] : ['production_order:read', 'problem:resolve'],
    displayName: director ? 'Директор' : 'Зав. производства',
    isActive: true,
    sessionPurpose: 'full',
    session: {
      id: director ? 'qa-director-session' : 'qa-production-session',
      purpose: 'full',
      state: 'active',
      createdAt: '2026-08-16T08:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
      lastSeenAt: '2026-08-16T08:30:00.000Z',
    },
    workContext: { kind: 'office', assignment: null },
    passwordChangeRequired: false,
  };
}

async function installApiFixture(page) {
  await page.route('**/api/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const pathname = requestUrl.pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    const authorization = route.request().headers().authorization ?? '';
    const role = authorization.includes('director') ? 'director' : activeRole(page);

    if (pathname === '/api/auth/me') return json(route, profile(role));
    if (pathname.endsWith('/notifications')) {
      return json(route, { items: [], nextCursor: null, unreadCount: 0 });
    }
    if (pathname === '/api/production/problems' || pathname === '/api/director/problems') {
      return json(route, [problem]);
    }
    if (pathname === '/api/production/orders') return json(route, []);
    if (pathname === '/api/commercial/orders') {
      return json(route, { items: [], nextCursor: null });
    }
    if (
      pathname === '/api/production/shifts' ||
      pathname === '/api/production/posts' ||
      pathname === '/api/production/operators/workload' ||
      pathname === '/api/production/penalties'
    ) {
      return json(route, []);
    }
    if (pathname === '/api/director/control') {
      return json(route, {
        pendingDecisions: 0,
        penalties: 0,
        overdueOrders: 0,
        penaltiesAmount: 0,
        plannedInvoicedAmount: 0,
        paidAmount: 0,
        unbilledAmount: 0,
        overdueAmount: 0,
        producedKg: 42.6,
        defectKg: 42.6,
        warehouseAcceptedRolls: 0,
      });
    }
    if (
      pathname === '/api/director/decisions' ||
      pathname === '/api/director/penalties' ||
      pathname === '/api/director/penalty-targets' ||
      pathname === '/api/director/finance' ||
      pathname === '/api/director/production' ||
      pathname === '/api/director/warehouse' ||
      pathname === '/api/material-catalog' ||
      pathname === '/api/recipe-catalog' ||
      pathname.includes('/counterparties/')
    ) {
      return json(route, []);
    }

    unhandledApiRoutes.add(`${pathname}${requestUrl.search}`);
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: `Unhandled QA route: ${pathname}` }),
    });
  });
}

function roleUrl(role) {
  return `${baseUrl}/?role=${role}&section=${encodeURIComponent('Проблемы')}`;
}

async function openProblems(page, role, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((currentRole) => {
    const director = currentRole === 'director';
    window.localStorage.setItem(
      'plenki.auth.v1',
      JSON.stringify({
        version: 1,
        token: director ? 'qa-director-token' : 'qa-production-token',
        role: currentRole,
        serverRole: director ? 'director' : 'production_lead',
        userId: director ? 'qa-director' : 'qa-production',
        displayName: director ? 'Директор' : 'Зав. производства',
        expiresAt: '2030-01-01T00:00:00.000Z',
        passwordChangeRequired: false,
      }),
    );
  }, role);
  await page.goto(roleUrl(role), { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('.production-problems-surface').waitFor({
      state: 'visible',
      timeout: 12_000,
    });
  } catch {
    const storedSession = await page.evaluate(() => window.localStorage.getItem('plenki.auth.v1'));
    throw new Error(
      `${role}: problems surface did not render at ${page.url()}\n${(
        await page.locator('body').innerText()
      ).slice(0, 2_000)}\nSession: ${storedSession}\nUnhandled: ${[...unhandledApiRoutes].join(', ')}`,
    );
  }
  await page.locator('.production-problem-card-trigger').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(100);
}

async function layoutMetrics(page) {
  return page.locator('.production-problems-surface').evaluate((surface) => {
    const card = surface.querySelector('.production-problem-card-trigger');
    const weight = surface.querySelector('.production-problem-weight');
    const surfaceStyle = getComputedStyle(surface);
    const cardStyle = card ? getComputedStyle(card) : null;
    const weightStyle = weight ? getComputedStyle(weight) : null;
    return {
      surfacePaddingInline: Number.parseFloat(surfaceStyle.paddingInlineStart),
      surfacePaddingBlock: Number.parseFloat(surfaceStyle.paddingTop),
      cardPaddingInline: Number.parseFloat(cardStyle?.paddingInlineStart ?? '0'),
      cardPaddingBlock: Number.parseFloat(cardStyle?.paddingTop ?? '0'),
      weightPaddingBlock: Number.parseFloat(weightStyle?.paddingTop ?? '0'),
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

function assertLayout(metrics, role, viewport) {
  const wide = viewport.width >= 1366;
  assert(
    metrics.surfacePaddingInline >= (wide ? 18 : 14),
    `${role} ${viewport.width}: surface inline padding ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.surfacePaddingBlock >= (wide ? 18 : 14),
    `${role} ${viewport.width}: surface block padding ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.cardPaddingInline >= (wide ? 16 : 14),
    `${role} ${viewport.width}: card inline padding ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.cardPaddingBlock >= (wide ? 14 : 12),
    `${role} ${viewport.width}: card block padding ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.weightPaddingBlock >= 12,
    `${role} ${viewport.width}: weight padding ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.pageWidth <= metrics.viewportWidth + 2,
    `${role} ${viewport.width}: page overflow ${JSON.stringify(metrics)}`,
  );
}

async function verifyInteraction(page, role) {
  const filter = page.getByRole('tab', { name: /Брак рулона/u });
  await filter.click();
  assert((await filter.getAttribute('aria-selected')) === 'true', `${role}: filter did not select`);
  await page.locator('.production-problem-card-trigger').first().click();
  await page.getByRole('dialog').waitFor({ state: 'visible' });

  const dialogMetrics = await page.getByRole('dialog').evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  assert(dialogMetrics.left >= -1, `${role}: dialog overflows left ${JSON.stringify(dialogMetrics)}`);
  assert(dialogMetrics.top >= -1, `${role}: dialog overflows top ${JSON.stringify(dialogMetrics)}`);
  assert(
    dialogMetrics.right <= dialogMetrics.viewportWidth + 1,
    `${role}: dialog overflows right ${JSON.stringify(dialogMetrics)}`,
  );
  assert(
    dialogMetrics.bottom <= dialogMetrics.viewportHeight + 1,
    `${role}: dialog overflows bottom ${JSON.stringify(dialogMetrics)}`,
  );
  assert(
    dialogMetrics.pageWidth <= dialogMetrics.viewportWidth + 2,
    `${role}: dialog causes page overflow ${JSON.stringify(dialogMetrics)}`,
  );

  const dialogText = await page.getByRole('dialog').innerText();
  assert(dialogText.includes('42,6 кг'), `${role}: confirmed weight is missing`);
  if (role === 'production') {
    assert(dialogText.includes('Переделка'), 'production: rework action is missing');
    assert(dialogText.includes('Списание'), 'production: write-off action is missing');
  } else {
    assert(!dialogText.includes('Переделка'), 'director: routine rework action leaked');
    assert(!dialogText.includes('Списание'), 'director: routine write-off action leaked');
    assert(
      (await page.locator('.production-problem-dialog-actions').count()) === 0,
      'director: routine action footer leaked',
    );
  }
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
}

async function capture(page, role, viewport) {
  if (!screenshotDir) return;
  await page.screenshot({
    path: path.join(screenshotDir, `${role}-${viewport.width}x${viewport.height}.png`),
  });
}

const { server, logs } = startServer();
let browser;

try {
  await waitForServer(server, logs);
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await installApiFixture(page);

  for (const role of ['production', 'director']) {
    for (const viewport of [
      { width: 2048, height: 1230 },
      { width: 1366, height: 768 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
    ]) {
      await openProblems(page, role, viewport);
      assertLayout(await layoutMetrics(page), role, viewport);
      if (viewport.width === 2048 || viewport.width === 390) {
        await verifyInteraction(page, role);
      }
      await capture(page, role, viewport);
    }
  }

  for (const role of ['production', 'director']) {
    const sourceMatchPage = await browser.newPage({
      viewport: { width: 1470, height: 874 },
      deviceScaleFactor: 2,
    });
    sourceMatchPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    sourceMatchPage.on('pageerror', (error) => consoleErrors.push(String(error)));
    await installApiFixture(sourceMatchPage);
    await openProblems(sourceMatchPage, role, { width: 1470, height: 874 });
    assertLayout(await layoutMetrics(sourceMatchPage), role, { width: 1470, height: 874 });
    if (screenshotDir) {
      await sourceMatchPage.screenshot({
        path: path.join(screenshotDir, `${role}-source-match-2940x1748.png`),
      });
    }
    await sourceMatchPage.close();
  }

  assert(unhandledApiRoutes.size === 0, `Unhandled API routes: ${[...unhandledApiRoutes].join(', ')}`);
  assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join('\n')}`);
  console.log('Production/director problems smoke passed.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
