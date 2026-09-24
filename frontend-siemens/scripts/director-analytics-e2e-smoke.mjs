import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const frontendDir = process.cwd();
const apiPort = 3027;
const webPort = 5227;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const fixedBrowserTime = '2026-07-24T09:00:00+03:00';
const screenshotDir = path.join(
  frontendDir,
  'output',
  'playwright',
  'director-analytics-v2',
);
const ownedChildren = new Set();
const analyticsRequests = [];
const diagnostics = {
  apiErrors: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
};

let browser;
let context;
let cleanupPromise;
let receivedSignal = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateDatabaseUrl(value) {
  if (!value) throw new Error('DIRECTOR_PREVIEW_DATABASE_URL is required');

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DIRECTOR_PREVIEW_DATABASE_URL is not a valid URL');
  }

  const schemas = parsed.searchParams.getAll('schema');
  const keys = [...parsed.searchParams.keys()];
  if (
    !new Set(['postgres:', 'postgresql:']).has(parsed.protocol) ||
    !new Set(['localhost', '127.0.0.1']).has(parsed.hostname) ||
    schemas.length !== 1 ||
    !/^local_graph_[a-z0-9_]+$/.test(schemas[0] ?? '') ||
    keys.length !== 1 ||
    keys[0] !== 'schema' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'DIRECTOR_PREVIEW_DATABASE_URL must target local PostgreSQL with exactly one ' +
        'schema=local_graph_* query parameter',
    );
  }
  return parsed;
}

const databaseUrl = process.env.DIRECTOR_PREVIEW_DATABASE_URL;
const parsedDatabaseUrl = validateDatabaseUrl(databaseUrl);
const seedPassword =
  process.env.DIRECTOR_PREVIEW_SEED_PASSWORD ?? randomBytes(24).toString('base64url');

function redact(value) {
  let safe = String(value);
  for (const secret of [
    databaseUrl,
    parsedDatabaseUrl.password,
    encodeURIComponent(parsedDatabaseUrl.password),
    seedPassword,
  ]) {
    if (secret) safe = safe.replaceAll(secret, '<redacted>');
  }
  return safe;
}

function backendCandidateIsValid(candidate) {
  return (
    existsSync(path.join(candidate, 'package.json')) &&
    existsSync(path.join(candidate, 'apps', 'api', 'scripts', 'seed-director-analytics-demo.ts'))
  );
}

function resolveBackendDir() {
  const repositoryRoot = path.resolve(frontendDir, '../../../..');
  const candidates = [
    process.env.PLENKA_BACKEND_DIR,
    path.join(repositoryRoot, '.worktrees', 'director-analytics-v2-20260724'),
    repositoryRoot,
  ].filter(Boolean);
  const backend = candidates.find(backendCandidateIsValid);
  if (!backend) {
    throw new Error(
      'Backend worktree was not found; set PLENKA_BACKEND_DIR to the analytics backend worktree',
    );
  }
  return backend;
}

const backendDir = resolveBackendDir();
const apiEntry = path.join(backendDir, 'apps', 'api', 'dist', 'main.js');
const viteEntry = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
assert(existsSync(apiEntry), `Backend build is missing: ${apiEntry}`);
assert(existsSync(viteEntry), `Vite executable is missing: ${viteEntry}`);

const backendEnv = {
  ...process.env,
  APP_ENV: 'test',
  NODE_ENV: 'test',
  AUTH_DEV_XROLE: 'off',
  DATABASE_URL: databaseUrl,
  MIGRATION_DATABASE_URL: databaseUrl,
  DIRECTOR_PREVIEW_DATABASE_URL: databaseUrl,
  SEED_PROFILE: 'demo',
  DEMO_SEED_SCOPE: 'accounts',
  SEED_PASSWORD: seedPassword,
  DEVICE_GATEWAY_PRINTER: 'off',
  DEVICE_GATEWAY_SCALE: 'off',
  GATEWAY_SIMULATOR: 'off',
  ONEC_LIVE: 'false',
  ONEC_WRITE: 'false',
  WAREHOUSE_COVERAGE_V2_ENABLED: 'false',
  PORT: String(apiPort),
};

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => {
      reject(new Error(`Required local port ${port} is already in use`));
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function spawnOwned(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  const collect = (chunk) => {
    child.output = `${child.output}${chunk}`.slice(-16_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  ownedChildren.add(child);
  child.once('exit', () => ownedChildren.delete(child));
  return child;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function signalChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, 'SIGTERM');
  if (!(await waitForExit(child, 3_000))) {
    signalChild(child, 'SIGKILL');
    await waitForExit(child, 2_000);
  }
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    const children = [...ownedChildren].reverse();
    for (const child of children) await terminateChild(child);
  })();
  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (receivedSignal) return;
    receivedSignal = signal;
    void cleanup().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  });
}

async function runCommand(label, command, args, options) {
  console.log(`${label}…`);
  const child = spawnOwned(command, args, options);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    throw new Error(
      `${label} failed (${exit.signal ?? exit.code})\n${redact(child.output)}`,
    );
  }
}

async function waitForHttp(label, url, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before readiness\n${redact(child.output)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Bounded readiness retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready\n${redact(child.output)}`);
}

function textOf(locator) {
  return locator.textContent().then((value) => value ?? '');
}

function assertIncludes(haystack, expected, label) {
  assert(
    haystack.includes(expected),
    `${label} is missing "${expected}": ${haystack}`,
  );
}

async function saveScreenshot(page, name) {
  await page.screenshot({
    path: path.join(screenshotDir, name),
    animations: 'disabled',
  });
}

async function assertNoHorizontalOverflow(page) {
  const geometry = await page.evaluate(() => ({
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
    documentClient: document.documentElement.clientWidth,
    documentScroll: document.documentElement.scrollWidth,
  }));
  assert(
    geometry.bodyScroll <= geometry.bodyClient &&
      geometry.documentScroll <= geometry.documentClient,
    `1024px page has horizontal overflow: ${JSON.stringify(geometry)}`,
  );
}

async function openRealDirectorPage(page) {
  await page.goto(
    `${webUrl}/?role=director&section=${encodeURIComponent('Контроль')}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.getByLabel('Логин').fill('director');
  await page.getByLabel('Пароль').fill(seedPassword);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('.app-shell[data-active-role="director"]').waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  await page.locator('.director-production-analytics').waitFor({
    state: 'visible',
    timeout: 20_000,
  });
}

async function assertOverPlan(page, analytics) {
  const card = analytics.locator('[data-analytics-tab="overPlan"]').first();
  const cardText = await textOf(card);
  assertIncludes(cardText, '7 дней: 8 кг', 'over-plan summary');
  assertIncludes(cardText, '30 дней: 8 кг', 'over-plan summary');

  const totals = await textOf(analytics.getByLabel('Итоги перерасхода'));
  assertIncludes(totals, '7 дней8 кг2 рул. · 1 опер.', 'seven-day totals');
  assertIncludes(totals, '30 дней8 кг2 рул. · 1 опер.', 'thirty-day totals');

  const topOperators = await textOf(analytics.getByLabel('Операторы с перерасходом'));
  assertIncludes(topOperators, 'Алексей Орлов', 'top operators');
  assertIncludes(topOperators, '2 рул.', 'top operators');
  assertIncludes(topOperators, '8 кг', 'top operators');

  const partial = await textOf(analytics.getByLabel('Неполные данные'));
  assertIncludes(partial, 'План не зафиксирован: 1 рул.', 'partial counters');
  assertIncludes(partial, 'Исполнитель не определён: 1 рул.', 'partial counters');

  const plotScroll = await analytics
    .getByRole('img', { name: 'График перерасхода по рулонам' })
    .evaluate((element) => ({
      left: element.scrollLeft,
      maximum: element.scrollWidth - element.clientWidth,
    }));
  assert(plotScroll.maximum > 0, 'month chart fixture does not exercise horizontal scrolling');
  assert(
    plotScroll.maximum - plotScroll.left <= 1,
    `month chart did not reveal the latest data: ${JSON.stringify(plotScroll)}`,
  );

  await analytics.scrollIntoViewIfNeeded();
  await assertNoHorizontalOverflow(page);
  await saveScreenshot(page, '01-summary-overplan-1024x768.png');
}

async function assertExactRolls(page, analytics) {
  await analytics
    .getByRole('group', { name: 'Вид данных' })
    .getByRole('button', { name: 'Точные данные' })
    .click();
  const table = analytics.getByRole('table', {
    name: 'История веса по каждому рулону',
  });
  await table.waitFor({ state: 'visible' });

  const row07 = table.getByRole('row').filter({ hasText: 'LOCAL-GRAPH-ROLL-07' });
  const row07Text = await textOf(row07);
  for (const value of ['40 кг', '39 кг', '−1 кг', '0 кг', 'Мария Волкова']) {
    assertIncludes(row07Text, value, 'roll 07');
  }

  const row06 = table.getByRole('row').filter({ hasText: 'LOCAL-GRAPH-ROLL-06' });
  const row06Text = await textOf(row06);
  for (const value of [
    '40 кг',
    '43 кг',
    '3 кг',
    'Алексей Орлов',
    '23.07.2026, 12:00',
    '24.07.2026, 12:00',
  ]) {
    assertIncludes(row06Text, value, 'reweighed roll 06');
  }

  await table.scrollIntoViewIfNeeded();
  await assertNoHorizontalOverflow(page);
  await saveScreenshot(page, '02-exact-rolls-1024x768.png');
}

async function assertProduction(page, analytics) {
  await analytics.locator('[data-analytics-tab="production"]').first().click();
  const cardText = await textOf(
    analytics.locator('.director-analytics-summary-card[data-analytics-tab="production"]'),
  );
  for (const value of [
    '7 рул. · 290 кг',
    'Брак: 2 рул.',
    'Подтверждённый вес брака: 82 кг',
  ]) {
    assertIncludes(cardText, value, 'production summary');
  }
  const defectText = await textOf(analytics.getByLabel('Учёт брака'));
  assertIncludes(defectText, 'Записей брака: 3', 'defect summary');
  assertIncludes(defectText, 'Без подтверждённого веса: 1', 'defect summary');

  await analytics
    .getByRole('group', { name: 'Вид данных' })
    .getByRole('button', { name: 'Точные данные' })
    .click();
  await analytics
    .getByRole('table', { name: 'Точные данные производства и брака' })
    .waitFor();
  await assertNoHorizontalOverflow(page);
  await saveScreenshot(page, '03-production-defects-1024x768.png');
}

async function assertMaterials(page, analytics) {
  await analytics.locator('[data-analytics-tab="materials"]').first().click();
  const cardText = await textOf(
    analytics.locator('.director-analytics-summary-card[data-analytics-tab="materials"]'),
  );
  for (const value of [
    'Гранулы: 213 кг',
    '6 шт. · 12 кг',
    'Без замера шпули: 1 рул.',
  ]) {
    assertIncludes(cardText, value, 'materials summary');
  }

  const negativeBar = analytics.locator('[data-value-kg="-5"]').first();
  await negativeBar.waitFor({ state: 'visible' });
  assert(
    (await negativeBar.getAttribute('aria-label'))?.includes('отрицательное значение'),
    'negative material correction has no textual signal',
  );
  const spoolText = await textOf(
    analytics.getByLabel('Производственные свидетельства по шпулям'),
  );
  for (const value of [
    'Зафиксировано шпуль: 6',
    'Измеренная тара: 12 кг',
    'Без замера шпули: 1',
  ]) {
    assertIncludes(spoolText, value, 'spool evidence');
  }
  await assertNoHorizontalOverflow(page);
  await saveScreenshot(page, '04-materials-1024x768.png');
}

async function assertApplications(page, analytics) {
  await analytics.locator('[data-analytics-tab="applications"]').first().click();
  const expected = {
    week: ['4 шт.', 'Клиентские: 3 шт. · Резерв: 1 шт.'],
    month: ['6 шт.', 'Клиентские: 4 шт. · Резерв: 2 шт.'],
    '3_months': ['8 шт.', 'Клиентские: 5 шт. · Резерв: 3 шт.'],
    '6_months': ['10 шт.', 'Клиентские: 6 шт. · Резерв: 4 шт.'],
  };
  for (const [period, values] of Object.entries(expected)) {
    const periodText = await textOf(
      analytics.locator(`[data-application-period="${period}"]`),
    );
    for (const value of values) assertIncludes(periodText, value, `application ${period}`);
  }
  await assertNoHorizontalOverflow(page);
  await saveScreenshot(page, '05-applications-1024x768.png');
}

async function assertEvidence(page, analytics) {
  const shiftDetails = analytics
    .getByLabel('Баланс закрытых смен')
    .locator('details');
  const bagDetails = analytics.getByLabel('Факты BigBag').locator('details');
  await shiftDetails.locator('summary').click();
  await bagDetails.locator('summary').click();
  await analytics
    .getByRole('table', { name: 'Точный баланс закрытых смен' })
    .waitFor();
  const bagTable = analytics.getByRole('table', {
    name: 'Неизменяемая история использования BigBag',
  });
  await bagTable.waitFor();
  const bagText = await textOf(bagTable);
  assertIncludes(bagText, 'LOCAL-GRAPH-BIGBAG-NEGATIVE', 'BigBag evidence');
  assertIncludes(bagText, '−5 кг', 'BigBag negative evidence');
  assertIncludes(bagText, 'LOCAL-GRAPH-BIGBAG-OPEN', 'BigBag open evidence');
  assertIncludes(bagText, 'Ожидает закрытия', 'BigBag open evidence');
  await bagDetails.scrollIntoViewIfNeeded();
  await assertNoHorizontalOverflow(page);
  await saveScreenshot(page, '06-evidence-1024x768.png');
}

async function runBrowserAcceptance() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    timezoneId: 'Europe/Moscow',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(fixedBrowserTime));

  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) {
      diagnostics.requestFailures.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
      );
    }
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/director/analytics') {
      analyticsRequests.push(Object.fromEntries(url.searchParams.entries()));
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      diagnostics.apiErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  await openRealDirectorPage(page);
  const analytics = page.locator('.director-production-analytics');
  await mkdir(screenshotDir, { recursive: true });
  await assertOverPlan(page, analytics);
  await assertExactRolls(page, analytics);
  await assertProduction(page, analytics);
  await assertMaterials(page, analytics);
  await assertApplications(page, analytics);
  await assertEvidence(page, analytics);

  assert(
    analyticsRequests.some(
      (query) =>
        query.from === '2026-07-01' &&
        query.to === '2026-07-24' &&
        query.bucket === 'day',
    ),
    `exact month analytics request was not observed: ${JSON.stringify(analyticsRequests)}`,
  );
  for (const [label, errors] of Object.entries(diagnostics)) {
    assert(errors.length === 0, `${label}: ${errors.map(redact).join('; ')}`);
  }
}

async function main() {
  await assertPortAvailable(apiPort);
  await assertPortAvailable(webPort);

  await runCommand('Database migrations', 'npm', ['run', 'db:deploy'], {
    cwd: backendDir,
    env: backendEnv,
  });
  await runCommand('Account-only seed', 'npm', ['run', 'db:seed'], {
    cwd: backendDir,
    env: backendEnv,
  });
  await runCommand(
    'Director analytics dataset',
    'npm',
    ['run', 'db:seed:director-demo', '-w', '@plenka/api'],
    { cwd: backendDir, env: backendEnv },
  );

  const api = spawnOwned(process.execPath, [apiEntry], {
    cwd: backendDir,
    env: backendEnv,
  });
  await waitForHttp('API', `${apiUrl}/api/health`, api);

  const vite = spawnOwned(
    process.execPath,
    [
      viteEntry,
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    {
      cwd: frontendDir,
      env: {
        ...process.env,
        API_PROXY_TARGET: apiUrl,
        VITE_LIVE_CONTOURS: 'director',
        VITE_REQUIRE_AUTH: 'on',
      },
    },
  );
  await waitForHttp('Vite', webUrl, vite);
  await runBrowserAcceptance();

  console.log(
    'PASS director analytics real DB/API/UI: 1024x768, 7 rolls / 290 kg, ' +
      '8 kg over-plan, defects, materials, 4/6/8/10 applications and exact evidence',
  );
}

try {
  await main();
} catch (error) {
  console.error(redact(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
} finally {
  await cleanup();
}
