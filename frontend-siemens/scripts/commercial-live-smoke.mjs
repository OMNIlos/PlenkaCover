import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { captureTask2Viewport, exerciseTask2KeyboardFocus } from './commercial-task2-evidence.mjs';

const frontendDir = process.cwd();
const frontendWorktree = path.basename(path.dirname(frontendDir));
const backendCandidates = [
  process.env.PLENKA_BACKEND_DIR,
  path.resolve(frontendDir, '../..'),
  path.resolve(frontendDir, '../../../..'),
  path.resolve(frontendDir, '../../../..', '.worktrees', frontendWorktree),
].filter(Boolean);
const backendDir = backendCandidates.find((candidate) => {
  const manifest = path.join(candidate, 'package.json');
  return existsSync(manifest) && readFileSync(manifest, 'utf8').includes('"name": "plenka-cover"');
});
if (!backendDir) {
  throw new Error(`Backend repository was not found. Checked: ${backendCandidates.join(', ')}`);
}
const backendRequire = createRequire(path.join(backendDir, 'package.json'));
const { PrismaClient } = backendRequire('@prisma/client');

const apiPort = Number(process.env.COMMERCIAL_SMOKE_API_PORT ?? 3017);
const webPort = Number(process.env.COMMERCIAL_SMOKE_WEB_PORT ?? 5197);
const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const baseDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://plenka:plenka@127.0.0.1:5433/plenka?schema=public';
const smokeSchema = `commercial_live_${Date.now()}_${process.pid}`;
const databaseUrlObject = new URL(baseDatabaseUrl);
databaseUrlObject.searchParams.set('schema', smokeSchema);
const databaseUrl = databaseUrlObject.toString();
const adminDatabaseUrlObject = new URL(baseDatabaseUrl);
adminDatabaseUrlObject.searchParams.set('schema', 'public');
const adminDatabaseUrl = adminDatabaseUrlObject.toString();
const password = process.env.COMMERCIAL_SMOKE_PASSWORD ?? process.env.SEED_PASSWORD ?? 'plenka-dev';
const task2EvidenceDir = path.resolve(frontendDir, 'output/playwright/commercial-task2-review');
const task2Evidence = { viewports: [], focus: null };
const finalEvidenceDir = path.resolve(frontendDir, 'output/playwright/commercial-redesign-final');
const finalEvidence = [];
const children = [];
const forbiddenCommercialText = [
  'rawPayload',
  'passwordHash',
  'sourceSnapshotId',
  'amountValue',
  'fixture-only',
  'Олег Чернов',
  'Backend API',
  'Проекция backend',
  'снимок backend',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function start(command, args, options) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: true,
    ...options,
  });
  child.output = '';
  const collect = (chunk) => {
    child.output = `${child.output}${chunk}`.slice(-12_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push(child);
  return child;
}

function assertPortAvailable(port, label) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`${label} port ${port} is already in use`));
    });
    socket.once('error', () => resolve());
  });
}

function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options,
    });
    let output = '';
    const collect = (chunk) => {
      output = `${output}${chunk}`.slice(-12_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${output}`));
    });
  });
}

async function waitForHttp(url, label, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`${label} stopped before startup\n${child.output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready at ${url}\n${child?.output ?? ''}`);
}

async function waitForPendingApiRequests(pendingRequests, label) {
  const deadline = Date.now() + 10_000;
  while (pendingRequests.size > 0) {
    if (Date.now() >= deadline) {
      const pending = [...pendingRequests].map((request) => request.url()).join(', ');
      throw new Error(`${label} still has pending API requests: ${pending}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function apiRequest(pathname, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${method} ${pathname} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function loginApi(login) {
  const session = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { login, password },
  });
  assert(typeof session.token === 'string', `${login} login returned no token`);
  return session.token;
}

async function createCoverScenario({
  commercialToken,
  warehouseToken,
  counterpartyId,
  baseRawMaterialDefinitionId,
  title,
  rollCount,
  rollIds,
}) {
  const order = await apiRequest('/api/commercial/orders', {
    token: commercialToken,
    method: 'POST',
    body: {
      clientRequestId: randomUUID(),
      title,
      counterpartyId,
      requestType: 'client_order',
      positions: [
        {
          rollCount,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
          baseRawMaterialDefinitionId,
          spoolType: 'Шпуля 76 мм',
          birka: 'Прозрачная',
          plannedWeightKg: 41.2,
        },
      ],
    },
  });
  const position = order.positions?.[0];
  assert(position?.id, `${title} has no persisted position`);
  const coverRequest = await apiRequest(
    `/api/commercial/orders/${order.id}/warehouse-cover/recheck`,
    {
      token: commercialToken,
      method: 'POST',
    },
  );
  assert(coverRequest.case?.id, `${title} warehouse-cover request returned no case`);
  await apiRequest(`/api/warehouse/orders/${order.id}/cover-proposals`, {
    token: warehouseToken,
    method: 'POST',
    body: { positionId: position.id, rollIds, comment: 'Live commercial acceptance' },
  });
  return { id: order.id, positionId: position.id, title };
}

async function waitForAppShell(page) {
  try {
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '<body unavailable>');
    throw new Error(
      `App shell missing at ${page.url()}\n${body.slice(0, 4_000)}\n${String(error)}`,
    );
  }
}

async function assertNoHorizontalOverflow(page, viewportLabel) {
  await waitForAppShell(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(overflow <= 1, `Commercial workspace overflows ${viewportLabel} by ${overflow}px`);
}

async function assertNoCommercialSurfaceOverflow(page, viewportLabel) {
  const selectors = [
    '.commercial-live-list-panel',
    '.commercial-live-detail-panel',
    '.commercial-control-panel',
    '.commercial-live-intake-dialog',
    '.commercial-raw-materials',
  ];
  for (const selector of selectors) {
    const surface = page.locator(selector).first();
    if ((await surface.count()) === 0 || !(await surface.isVisible())) continue;
    const overflow = await surface.evaluate((node) => node.scrollWidth - node.clientWidth);
    assert(overflow <= 1, `${selector} overflows ${viewportLabel} by ${overflow}px`);
  }
}

async function assertNoForbiddenCommercialText(page) {
  const visibleText = await page.locator('body').innerText();
  for (const forbidden of forbiddenCommercialText) {
    assert(!visibleText.includes(forbidden), `Forbidden commercial text leaked: ${forbidden}`);
  }
}

async function captureFinalEvidence(page, { fileName, width, height, state, anchorSelector }) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    for (const selector of [
      '.commercial-live-list-panel',
      '.commercial-live-detail-panel',
      '.commercial-control-panel',
      '.commercial-live-intake-dialog',
      '.commercial-raw-materials',
    ]) {
      const element = document.querySelector(selector);
      if (element) element.scrollTop = 0;
    }
  });
  await page.waitForFunction(() => (document.scrollingElement?.scrollTop ?? 0) <= 1);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    });
  });
  await assertNoHorizontalOverflow(page, state);
  await assertNoCommercialSurfaceOverflow(page, state);
  const viewport = page.viewportSize();
  assert(
    viewport?.width === width && viewport.height === height,
    `${state} viewport is ${viewport?.width}x${viewport?.height}, expected ${width}x${height}`,
  );
  if (anchorSelector) {
    const anchor = page.locator(anchorSelector);
    await anchor.waitFor({ state: 'visible' });
    const box = await anchor.boundingBox();
    assert(
      box && box.y >= 0 && box.y < height / 2,
      `${state} anchor ${anchorSelector} is outside the first viewport: ${JSON.stringify(box)}`,
    );
  }
  mkdirSync(finalEvidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(finalEvidenceDir, fileName) });
  finalEvidence.push({ fileName, width, height, state });
}

async function findCommercialOrderRow(page, orderId) {
  const queue = page.locator('.commercial-live-queue');
  await queue.waitFor({ state: 'visible' });
  await queue.getByText('Загрузка заявок…', { exact: true }).waitFor({ state: 'hidden' });
  await queue.getByRole('button', { name: 'Загрузка…', exact: true }).waitFor({
    state: 'hidden',
  });
  const row = page.locator(`[data-commercial-order-id="${orderId}"]`);
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    if (await row.isVisible()) return row;
    const loadMore = page.getByRole('button', { name: 'Показать ещё', exact: true });
    if ((await loadMore.count()) === 0 || !(await loadMore.isVisible())) break;
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/commercial/orders?') && response.request().method() === 'GET',
    );
    await loadMore.click();
    const response = await responsePromise;
    assert(response.status() === 200, `Commercial pagination returned HTTP ${response.status()}`);
    await queue.locator('[aria-busy="true"]').waitFor({ state: 'hidden' });
  }
  throw new Error(`Commercial order ${orderId} was not found in the complete queue`);
}

async function openCommercialOrder(
  page,
  scenario,
  section = 'Входящие заявки',
  { forceRefresh = false } = {},
) {
  const bucketBySection = {
    'Входящие заявки': 'incoming',
    Черновики: 'drafts',
    'В работе': 'in_work',
    Выполненные: 'completed',
  };
  const waitForSectionResponse = (targetSection) =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/commercial/orders' &&
        url.searchParams.get('bucket') === bucketBySection[targetSection] &&
        response.request().method() === 'GET'
      );
    });
  let currentSection = await page
    .locator('.commercial-live-list-panel h1')
    .textContent()
    .catch(() => null);
  if (forceRefresh && currentSection?.trim() === section) {
    const alternateSection = section === 'Черновики' ? 'Входящие заявки' : 'Черновики';
    const alternateResponsePromise = waitForSectionResponse(alternateSection);
    await page.getByRole('button', { name: alternateSection, exact: true }).click();
    await page
      .getByRole('heading', { name: alternateSection, exact: true })
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'visible' });
    const alternateResponse = await alternateResponsePromise;
    assert(
      alternateResponse.status() === 200,
      `${alternateSection} queue returned HTTP ${alternateResponse.status()}`,
    );
    currentSection = alternateSection;
  }
  const pageResponsePromise =
    currentSection?.trim() === section ? null : waitForSectionResponse(section);
  await page.getByRole('button', { name: section, exact: true }).click();
  await page
    .getByRole('heading', { name: section, exact: true })
    .filter({ visible: true })
    .first()
    .waitFor({ state: 'visible' });
  if (pageResponsePromise) {
    const response = await pageResponsePromise;
    assert(response.status() === 200, `${section} queue returned HTTP ${response.status()}`);
    if (forceRefresh) {
      const responseBody = await response.json();
      assert(
        Array.isArray(responseBody.items) &&
          responseBody.items.some((item) => item.id === scenario.id),
        `${section} force-refreshed API page did not contain ${scenario.id}`,
      );
      await page
        .locator(`[data-commercial-order-id="${scenario.id}"]`)
        .waitFor({ state: 'visible' });
    }
  }
  const row = await findCommercialOrderRow(page, scenario.id);
  await row.click();
  await page
    .getByRole('heading', { name: scenario.title, exact: true })
    .filter({ visible: true })
    .first()
    .waitFor({ state: 'visible' });
}

async function approveCoverScenario(
  page,
  scenario,
  actionName,
  routeLabel,
  technicalLabel,
  options,
) {
  await openCommercialOrder(page, scenario, 'Входящие заявки', options);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/commercial-approval') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: actionName, exact: true }).click();
  const response = await responsePromise;
  assert(response.status() === 201, `${actionName} returned HTTP ${response.status()}`);
  await page.getByText(`Маршрут коммерции подтверждён: ${routeLabel}.`, { exact: false }).waitFor({
    state: 'visible',
  });
  await page.getByText(technicalLabel, { exact: false }).waitFor({ state: 'visible' });
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          signalProcessGroup(child, 'SIGTERM');
          if (child.exitCode !== null) return resolve();
          const forceKill = setTimeout(() => {
            signalProcessGroup(child, 'SIGKILL');
          }, 3_000).unref();
          child.once('exit', () => {
            clearTimeout(forceKill);
            resolve();
          });
        }),
    ),
  );
}

let browser;
try {
  await assertPortAvailable(apiPort, 'Backend');
  await assertPortAvailable(webPort, 'Vite');

  if (process.env.COMMERCIAL_SMOKE_PREPARE_DB !== 'off') {
    const backendEnv = {
      ...process.env,
      APP_ENV: process.env.APP_ENV ?? 'test',
      DATABASE_URL: databaseUrl,
      SEED_PROFILE: process.env.SEED_PROFILE ?? 'demo',
    };
    await run('npm', ['run', 'db:deploy'], { cwd: backendDir, env: backendEnv });
    await run('npm', ['run', 'db:seed'], { cwd: backendDir, env: backendEnv });
  }

  const backend = start('npm', ['run', 'start', '-w', '@plenka/api'], {
    cwd: backendDir,
    env: {
      ...process.env,
      APP_ENV: process.env.APP_ENV ?? 'test',
      AUTH_DEV_XROLE: 'off',
      DATABASE_URL: databaseUrl,
      PORT: String(apiPort),
    },
  });
  await waitForHttp(`${apiBase}/api/health`, 'Backend', backend);

  const [commercialToken, warehouseToken, financeToken, productionToken] = await Promise.all([
    loginApi('коммерция'),
    loginApi('склад'),
    loginApi('бухгалтерия'),
    loginApi('производство'),
  ]);
  const materialCatalog = await apiRequest('/api/material-catalog', {
    token: commercialToken,
  });
  const baseMaterialDefinition =
    materialCatalog.find((material) => material.kind === 'base' && material.name === 'Первичное') ??
    materialCatalog.find((material) => material.kind === 'base');
  assert(
    typeof baseMaterialDefinition?.id === 'string',
    'Live material catalog has no active base definition',
  );
  const acceptanceId = `${Date.now()}-${process.pid}`;
  const counterparty = await apiRequest('/api/commercial/counterparties', {
    token: commercialToken,
    method: 'POST',
    body: { displayName: `Live acceptance ${acceptanceId}` },
  });
  const freeRolls = await apiRequest('/api/warehouse/rolls?ownership=free', {
    token: warehouseToken,
  });
  const freeRoll = freeRolls.find((roll) => roll.rollCode === 'SEED-COVER-FREE-1');
  assert(freeRoll?.id, 'Seeded compatible free roll SEED-COVER-FREE-1 is absent');
  const noCoverScenario = await createCoverScenario({
    commercialToken,
    warehouseToken,
    counterpartyId: counterparty.id,
    baseRawMaterialDefinitionId: baseMaterialDefinition.id,
    title: `Live no cover ${acceptanceId}`,
    rollCount: 2,
    rollIds: [],
  });
  const partialCoverScenario = await createCoverScenario({
    commercialToken,
    warehouseToken,
    counterpartyId: counterparty.id,
    baseRawMaterialDefinitionId: baseMaterialDefinition.id,
    title: `Live partial cover ${acceptanceId}`,
    rollCount: 2,
    rollIds: [freeRoll.id],
  });
  const fullCoverScenario = await createCoverScenario({
    commercialToken,
    warehouseToken,
    counterpartyId: counterparty.id,
    baseRawMaterialDefinitionId: baseMaterialDefinition.id,
    title: `Live full cover ${acceptanceId}`,
    rollCount: 1,
    rollIds: [freeRoll.id],
  });

  const vite = start(
    path.resolve(frontendDir, 'node_modules/.bin/vite'),
    ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    {
      cwd: frontendDir,
      env: {
        ...process.env,
        API_PROXY_TARGET: apiBase,
        VITE_LIVE_CONTOURS: 'commercial,production',
        VITE_REQUIRE_AUTH: 'on',
      },
    },
  );
  await waitForHttp(webBase, 'Vite', vite);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedApiRequests = [];
  const pendingApiRequests = new Set();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/')) pendingApiRequests.add(request);
  });
  page.on('requestfinished', (request) => pendingApiRequests.delete(request));
  page.on('requestfailed', (request) => {
    pendingApiRequests.delete(request);
    const error = request.failure()?.errorText ?? 'failed';
    if (request.url().includes('/api/') && error !== 'net::ERR_ABORTED') {
      failedApiRequests.push(`${request.method()} ${request.url()}: ${error}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      failedApiRequests.push(
        `${response.request().method()} ${response.url()}: HTTP ${response.status()}`,
      );
    }
  });

  await page.goto(webBase, { waitUntil: 'domcontentloaded' });
  await page.locator('.auth-input').nth(0).fill('коммерция');
  await page.locator('.auth-input').nth(1).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await waitForAppShell(page);
  assert(
    (await page.locator('.app-shell').getAttribute('data-active-role')) === 'commercial',
    'Bearer session did not resolve to the commercial role',
  );
  await assertNoHorizontalOverflow(page, 'a 1440px viewport');
  await assertNoCommercialSurfaceOverflow(page, 'a 1440px viewport');

  const sections = ['Входящие заявки', 'Черновики', 'В работе', 'Выполненные', 'Сырьё'];
  for (const section of sections) {
    await page.getByRole('button', { name: section, exact: true }).waitFor({ state: 'visible' });
  }

  const actionModeResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/commercial/orders' &&
      url.searchParams.get('mode') === 'action_required' &&
      response.request().method() === 'GET'
    );
  });
  await page.getByRole('button', { name: 'Требуют действий', exact: true }).click();
  assert((await actionModeResponsePromise).status() === 200, 'Action-required queue mode failed');

  const currentModeResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/commercial/orders' &&
      url.searchParams.get('mode') === 'current' &&
      response.request().method() === 'GET'
    );
  });
  await page.getByRole('button', { name: 'Актуальные', exact: true }).click();
  assert((await currentModeResponsePromise).status() === 200, 'Current queue mode failed');

  await page.locator('.commercial-queue-period summary').click();
  const today = new Date().toISOString().slice(0, 10);
  const fromResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/commercial/orders' &&
      url.searchParams.get('mode') === 'current' &&
      url.searchParams.get('from') === today &&
      response.request().method() === 'GET'
    );
  });
  await page.getByLabel('Дата от включительно', { exact: true }).fill(today);
  assert((await fromResponsePromise).status() === 200, 'Inclusive from filter failed');

  const toResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/commercial/orders' &&
      url.searchParams.get('mode') === 'current' &&
      url.searchParams.get('from') === today &&
      url.searchParams.get('to') === today &&
      response.request().method() === 'GET'
    );
  });
  await page.getByLabel('Дата до включительно', { exact: true }).fill(today);
  assert((await toResponsePromise).status() === 200, 'Inclusive to filter failed');

  const resetResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/commercial/orders' &&
      url.searchParams.get('mode') === 'current' &&
      !url.searchParams.has('from') &&
      !url.searchParams.has('to') &&
      response.request().method() === 'GET'
    );
  });
  await page.getByRole('button', { name: 'Сбросить период', exact: true }).click();
  assert((await resetResponsePromise).status() === 200, 'Queue period reset failed');

  mkdirSync(task2EvidenceDir, { recursive: true });
  await openCommercialOrder(page, noCoverScenario);
  task2Evidence.focus = await exerciseTask2KeyboardFocus(
    page,
    task2EvidenceDir,
    noCoverScenario.id,
  );
  await openCommercialOrder(page, noCoverScenario);
  task2Evidence.viewports.push(
    await captureTask2Viewport(page, task2EvidenceDir, {
      width: 1366,
      height: 768,
      fileName: '03-populated-1366x768.png',
      desktop: true,
      mobile: false,
    }),
    await captureTask2Viewport(page, task2EvidenceDir, {
      width: 1440,
      height: 900,
      fileName: '02-populated-1440x900.png',
      desktop: true,
      mobile: false,
    }),
    await captureTask2Viewport(page, task2EvidenceDir, {
      width: 1280,
      height: 720,
      fileName: '04-populated-1280x720.png',
      desktop: true,
      mobile: false,
    }),
    await captureTask2Viewport(page, task2EvidenceDir, {
      width: 390,
      height: 844,
      fileName: '05-populated-390x844.png',
      desktop: false,
      mobile: true,
    }),
  );
  writeFileSync(
    path.join(task2EvidenceDir, 'task2-live-metrics.json'),
    `${JSON.stringify(task2Evidence, null, 2)}\n`,
  );
  console.log(`TASK2_EVIDENCE ${JSON.stringify(task2Evidence)}`);
  await openCommercialOrder(page, noCoverScenario);
  await captureFinalEvidence(page, {
    fileName: '01-incoming-desktop-1440.png',
    width: 1440,
    height: 900,
    state: 'incoming desktop with queue and selected detail',
  });

  await page.locator('.account-button').click();
  const account = page.locator('.account-panel');
  await account.waitFor({ state: 'visible' });
  assert((await account.innerText()).includes('Коммерция'), 'Real /auth/me profile is absent');
  assert(!(await account.innerText()).includes('(seed)'), 'Seed marker leaked into the profile');
  assert(!(await account.innerText()).includes('Олег'), 'Static commercial identity leaked');
  await account.getByRole('button', { name: 'Закрыть личный кабинет' }).click();

  await page.locator('[aria-label^="Контроль:"]').click();
  const control = page
    .locator('.notification-panel, .notification-center, [aria-label="Уведомления"]')
    .first();
  await control.waitFor({ state: 'visible' });
  const controlText = await control.innerText();
  assert(
    !/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(
      controlText,
    ),
    'Control rendered a raw object UUID',
  );
  assert(
    !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.test(controlText),
    'Control rendered a raw ISO timestamp',
  );
  await captureFinalEvidence(page, {
    fileName: '02-control-desktop-1440.png',
    width: 1440,
    height: 900,
    state: 'Control panel desktop',
  });
  const markRead = control.getByRole('button', { name: 'Прочитано', exact: true }).first();
  await markRead.waitFor({ state: 'visible' });
  const readResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/commercial/notifications/') &&
      response.url().endsWith('/read') &&
      response.request().method() === 'PUT',
  );
  await markRead.click();
  const readResponse = await readResponsePromise;
  assert(readResponse.status() === 200, `Notification read returned HTTP ${readResponse.status()}`);

  const openNotification = control
    .getByRole('button', { name: 'Открыть заявку', exact: true })
    .first();
  const notificationDetailPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      /^\/api\/commercial\/orders\/[^/]+$/.test(url.pathname) &&
      response.request().method() === 'GET'
    );
  });
  await openNotification.click();
  const notificationDetail = await notificationDetailPromise;
  assert(
    notificationDetail.status() === 200,
    `Notification navigation returned HTTP ${notificationDetail.status()}`,
  );
  await control.waitFor({ state: 'hidden' });
  await page.locator('.commercial-live-detail-panel h2').waitFor({ state: 'visible' });

  await approveCoverScenario(
    page,
    noCoverScenario,
    'Произвести всё',
    'только производство',
    'Техническое подтверждение не требуется.',
  );
  await approveCoverScenario(
    page,
    partialCoverScenario,
    'Принять резерв и произвести остаток',
    'частичное покрытие',
    'Ожидается зав. производства.',
  );
  await approveCoverScenario(
    page,
    fullCoverScenario,
    'Закрыть полностью со склада',
    'полное покрытие',
    'Ожидается зав. производства.',
  );

  await page.getByRole('button', { name: 'Входящие заявки', exact: true }).click();
  await page.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Создать заявку' });
  await dialog.waitFor({ state: 'visible' });
  await assertNoCommercialSurfaceOverflow(page, 'the 1440px intake dialog');
  await dialog.getByRole('button', { name: 'Закрыть форму', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(
    () => document.activeElement?.textContent?.trim() === 'Создать заявку',
  );
  await page.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  await dialog.waitFor({ state: 'visible' });
  await assertNoForbiddenCommercialText(page);
  await captureFinalEvidence(page, {
    fileName: '03-intake-desktop-1440.png',
    width: 1440,
    height: 900,
    state: 'intake dialog desktop',
  });
  await dialog.getByLabel('Контрагент', { exact: true }).selectOption({ label: 'УралПак' });
  await dialog.getByLabel('Количество рулонов, позиция 1', { exact: true }).fill('1');
  await dialog.getByLabel('Фактическая толщина, позиция 1', { exact: true }).fill('80 мкм');
  await dialog.getByLabel('Бухгалтерская толщина, позиция 1', { exact: true }).fill('78 мкм');
  await dialog.getByLabel('Ширина, мм, позиция 1', { exact: true }).fill('1700');
  await dialog.getByLabel('Метраж, м, позиция 1', { exact: true }).fill('275');
  await dialog
    .getByLabel('Тип пленки, позиция 1', { exact: true })
    .selectOption({ label: 'Рукав' });
  await dialog.getByLabel('Вес, позиция 1', { exact: true }).fill('41.2');
  await dialog.getByLabel('Бирка, позиция 1', { exact: true }).selectOption({ label: 'ГОСТ' });
  await dialog
    .getByLabel('Рецептуры, позиция 1', { exact: true })
    .selectOption({ value: `material:${baseMaterialDefinition.id}` });
  await dialog.getByLabel('Шпуля, позиция 1', { exact: true }).selectOption({ label: 'Тонкая' });
  const draftResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/commercial/orders') && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Сохранить черновик' }).click();
  const draft = await draftResponse;
  assert(draft.status() === 201, `Draft creation returned HTTP ${draft.status()}`);
  const draftBody = await draft.json();
  await dialog.waitFor({ state: 'detached' });
  await page
    .getByRole('heading', { name: 'Черновики', exact: true })
    .filter({ visible: true })
    .first()
    .waitFor();
  const draftPositionId = draftBody.positions?.[0]?.id;
  assert(draftPositionId, 'Draft creation returned no persisted position');
  const draftPosition = draftBody.positions.find((position) => position.id === draftPositionId);
  assert(Number.isInteger(draftPosition?.version), 'Draft creation returned no position version');
  // Legacy correction fixture: correction remains covered without weakening the create contract.
  const correctionFixtureOrder = await apiRequest(
    `/api/commercial/orders/${draftBody.id}/positions/${draftPositionId}`,
    {
      token: commercialToken,
      method: 'PATCH',
      body: {
        expectedVersion: draftPosition.version,
        recipeParameters: [{ label: 'Сырьё', value: 'Первичное' }],
      },
    },
  );
  const correctionFixturePosition = correctionFixtureOrder.positions?.find(
    (position) => position.id === draftPositionId,
  );
  assert(
    correctionFixturePosition?.version === draftPosition.version + 1,
    'Legacy correction fixture did not advance the position version',
  );
  const draftScenario = {
    id: draftBody.id,
    title: draftBody.title || draftBody.orderNumber,
  };
  const draftRow = page.locator(`[data-commercial-order-id="${draftBody.id}"]`);
  await draftRow.waitFor({ state: 'visible' });
  await draftRow.click();
  await page
    .getByRole('heading', { name: draftScenario.title, exact: true })
    .filter({ visible: true })
    .first()
    .waitFor({ state: 'visible' });
  const promoteButton = page
    .locator('.commercial-live-detail-panel')
    .getByRole('button', { name: 'Передать в работу', exact: true });
  try {
    await promoteButton.waitFor({ state: 'visible', timeout: 8_000 });
  } catch (error) {
    const detailText = (await page.locator('.commercial-live-detail-panel').innerText()).replace(
      /\s+/g,
      ' ',
    );
    throw new Error(
      `Draft promotion action is absent for ${draftBody.id}: ${detailText.slice(0, 2_000)}`,
      { cause: error },
    );
  }
  const promoteResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/commercial/orders/${draftBody.id}/promote-draft`) &&
      response.request().method() === 'POST',
  );
  await promoteButton.click();
  const promoteResponse = await promoteResponsePromise;
  assert(
    promoteResponse.status() === 201,
    `Draft promotion returned HTTP ${promoteResponse.status()}`,
  );
  const promotedBody = await promoteResponse.json();
  draftScenario.title = promotedBody.title || promotedBody.orderNumber;
  assert(draftScenario.title, 'Draft promotion returned no official order label');

  const promotedCoverRequest = await apiRequest(
    `/api/commercial/orders/${draftBody.id}/warehouse-cover/recheck`,
    {
      token: commercialToken,
      method: 'POST',
    },
  );
  assert(promotedCoverRequest.case?.id, 'Promoted draft warehouse-cover request returned no case');
  await apiRequest(`/api/warehouse/orders/${draftBody.id}/cover-proposals`, {
    token: warehouseToken,
    method: 'POST',
    body: {
      positionId: draftPositionId,
      rollIds: [],
      comment: 'Live promoted draft acceptance',
    },
  });
  await approveCoverScenario(
    page,
    draftScenario,
    'Произвести всё',
    'только производство',
    'Техническое подтверждение не требуется.',
    { forceRefresh: true },
  );

  const invoiceResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/commercial/orders/${draftBody.id}/invoice-handoff`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Передать в бухгалтерию', exact: true }).click();
  const invoiceResponse = await invoiceResponsePromise;
  assert(
    invoiceResponse.status() === 201,
    `Invoice handoff returned HTTP ${invoiceResponse.status()}`,
  );

  const financeOrders = await apiRequest('/api/finance/orders', { token: financeToken });
  const financeOrder = financeOrders.find((order) => order.commercialOrderId === draftBody.id);
  assert(financeOrder?.id, 'Finance handoff did not create a finance order');
  await apiRequest(`/api/finance/orders/${financeOrder.id}/invoices`, {
    token: financeToken,
    method: 'POST',
    body: {
      amount: 1_000,
      label: 'Live commercial acceptance',
      paymentTermsType: 'postpay_100_30d',
    },
  });
  const paymentOperationKey = randomUUID();
  await apiRequest(`/api/finance/orders/${financeOrder.id}/payment-operations`, {
    token: financeToken,
    method: 'POST',
    body: { operationKey: paymentOperationKey, operationType: 'manual_adjustment', amount: 1 },
  });
  await apiRequest(`/api/finance/orders/${financeOrder.id}/payment-updates`, {
    token: financeToken,
    method: 'POST',
    body: {
      operationKey: paymentOperationKey,
      paymentStatus: 'partial',
    },
  });

  await openCommercialOrder(page, draftScenario, 'Входящие заявки', { forceRefresh: true });
  const partiallyPaidDetail = await apiRequest(`/api/commercial/orders/${draftBody.id}`, {
    token: commercialToken,
  });
  assert(
    partiallyPaidDetail.indicators?.payment === 'partial',
    `Commercial payment projection is not partial: ${JSON.stringify(
      partiallyPaidDetail.indicators,
    )}`,
  );
  const productionResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/commercial/orders/${draftBody.id}/send-to-production`) &&
      response.request().method() === 'POST',
  );
  const refreshedQueuePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/commercial/orders' &&
      url.searchParams.get('bucket') === 'incoming' &&
      url.searchParams.get('mode') === 'current' &&
      response.request().method() === 'GET'
    );
  });
  const refreshedDetailPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/commercial/orders/${draftBody.id}` &&
      response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'Передать в производство', exact: true }).click();
  const productionResponse = await productionResponsePromise;
  assert(
    productionResponse.status() === 201,
    `Production handoff returned HTTP ${productionResponse.status()}`,
  );
  const correctionDetail = await apiRequest(`/api/commercial/orders/${draftBody.id}`, {
    token: commercialToken,
  });
  assert(correctionDetail.productionOrderId, 'Production handoff returned no production order id');
  const productionOrder = await apiRequest(
    `/api/production/orders/${correctionDetail.productionOrderId}`,
    { token: productionToken },
  );
  const reportedRoll = productionOrder.dispatchItems?.find(
    (roll) => roll.orderLineId === draftPositionId,
  );
  assert(reportedRoll?.id, 'Production handoff returned no correctable roll');
  const correctionProblemReason = `Live correction ${acceptanceId}`;
  await apiRequest(`/api/production/orders/${correctionDetail.productionOrderId}/problems`, {
    token: productionToken,
    method: 'POST',
    body: {
      positionId: draftPositionId,
      rollId: reportedRoll.id,
      reason: correctionProblemReason,
      recovery: 'Уточнить рецептуру с коммерцией',
    },
  });
  await page.getByText('Действие выполнено.', { exact: true }).waitFor({ state: 'visible' });
  const refreshedQueue = await refreshedQueuePromise;
  assert(
    refreshedQueue.status() === 200,
    `Workspace refresh returned HTTP ${refreshedQueue.status()}`,
  );
  const refreshedDetail = await refreshedDetailPromise;
  assert(
    refreshedDetail.status() === 200,
    `Workspace detail refresh returned HTTP ${refreshedDetail.status()}`,
  );
  await waitForPendingApiRequests(pendingApiRequests, 'Production refresh');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppShell(page);
  assert(
    (await page.locator('.app-shell').getAttribute('data-active-role')) === 'commercial',
    'Bearer session was lost after reload',
  );
  await openCommercialOrder(page, draftScenario, 'В работе', { forceRefresh: true });
  const reloadedCommercialDetail = await apiRequest(`/api/commercial/orders/${draftBody.id}`, {
    token: commercialToken,
  });
  assert(
    reloadedCommercialDetail.indicators?.payment === 'partial',
    'Partial payment did not survive the commercial reload',
  );
  await page.getByText(correctionProblemReason, { exact: true }).waitFor({ state: 'visible' });
  await page
    .getByLabel('Причина изменения', { exact: true })
    .fill('Клиент подтвердил параметры в live acceptance');
  const correctionResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/commercial/orders/${draftBody.id}/problems/`) &&
      response.url().endsWith('/correction') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Применить корректировку', exact: true }).click();
  const correctionResponse = await correctionResponsePromise;
  assert(
    correctionResponse.status() === 201,
    `Commercial correction returned HTTP ${correctionResponse.status()}`,
  );
  await page.getByText(correctionProblemReason, { exact: true }).waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: 'Выполненные', exact: true }).click();
  const completed = page
    .locator('[data-commercial-order-id]')
    .filter({ hasText: 'Полностью закрыто складским рулоном' });
  await completed.waitFor({ state: 'visible' });
  await completed.click();
  await page.getByText('Готов к отгрузке', { exact: true }).waitFor({ state: 'visible' });

  await page.getByRole('button', { name: 'Сырьё', exact: true }).click();
  const materials = page.locator('.shared-bigbag-register');
  await materials.waitFor({ state: 'visible' });
  await materials.locator('tbody tr').first().waitFor({ state: 'visible' });
  await assertNoForbiddenCommercialText(page);
  await captureFinalEvidence(page, {
    fileName: '04-raw-materials-desktop-1440.png',
    width: 1440,
    height: 900,
    state: 'raw-material risk desktop',
  });

  await page.setViewportSize({ width: 1366, height: 768 });
  await assertNoHorizontalOverflow(page, 'a 1366px viewport');
  await assertNoCommercialSurfaceOverflow(page, 'a 1366px viewport');

  await page.setViewportSize({ width: 1024, height: 768 });
  await openCommercialOrder(page, partialCoverScenario, 'Входящие заявки');
  await page.locator('.commercial-live-list-panel').waitFor({ state: 'visible' });
  await page.locator('.commercial-live-detail-panel').waitFor({ state: 'visible' });
  await assertNoHorizontalOverflow(page, 'a 1024px viewport');
  await assertNoCommercialSurfaceOverflow(page, 'a 1024px viewport');
  await captureFinalEvidence(page, {
    fileName: '05-incoming-intermediate-1024.png',
    width: 1024,
    height: 768,
    state: 'incoming intermediate with queue and selected detail',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Входящие заявки', exact: true }).click();
  const mobileList = page.locator('.commercial-live-list-panel');
  const mobileDetail = page.locator('.commercial-live-detail-panel');
  await mobileList.waitFor({ state: 'visible' });
  await mobileDetail.waitFor({ state: 'hidden' });
  await captureFinalEvidence(page, {
    fileName: '06-queue-mobile-390.png',
    width: 390,
    height: 844,
    state: 'mobile incoming queue',
  });

  const mobileRow = await findCommercialOrderRow(page, partialCoverScenario.id);
  await mobileRow.click();
  await mobileDetail.waitFor({ state: 'visible' });
  await mobileList.waitFor({ state: 'hidden' });
  await page
    .getByRole('heading', { name: partialCoverScenario.title, exact: true })
    .filter({ visible: true })
    .first()
    .waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.activeElement?.id === 'commercial-order-detail-heading',
  );
  await captureFinalEvidence(page, {
    fileName: '07-detail-mobile-390.png',
    width: 390,
    height: 844,
    state: 'mobile selected order detail',
    anchorSelector: '#commercial-order-detail-heading',
  });

  await page.getByRole('button', { name: 'К очереди', exact: true }).click();
  await mobileList.waitFor({ state: 'visible' });
  await mobileDetail.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    (orderId) => document.activeElement?.getAttribute('data-commercial-order-id') === orderId,
    partialCoverScenario.id,
  );
  await assertNoHorizontalOverflow(page, 'a 390px viewport');
  await assertNoCommercialSurfaceOverflow(page, 'a 390px viewport');

  await page.setViewportSize({ width: 1440, height: 900 });
  await assertNoForbiddenCommercialText(page);
  await assertNoHorizontalOverflow(page, 'the final 1440px viewport');
  await assertNoCommercialSurfaceOverflow(page, 'the final 1440px viewport');
  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join('; ')}`);
  assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('; ')}`);
  assert(failedApiRequests.length === 0, `Failed API requests: ${failedApiRequests.join('; ')}`);
  console.log(`FINAL_EVIDENCE ${JSON.stringify(finalEvidence)}`);

  await context.close();
  console.log(
    'OK commercial live Bearer smoke: profile, Control, five sections, draft promotion, finance lock, production handoff, governed correction, full/partial/no cover, reload persistence, completion, raw materials, 1440/1366/1024/390px',
  );
} finally {
  await browser?.close();
  await stopChildren();
  if (/^commercial_live_[0-9]+_[0-9]+$/.test(smokeSchema)) {
    const cleanup = new PrismaClient({
      datasources: { db: { url: adminDatabaseUrl } },
    });
    try {
      await cleanup.$connect();
      await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${smokeSchema}" CASCADE`);
    } finally {
      await cleanup.$disconnect();
    }
  }
}
