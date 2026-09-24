import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const LOOPBACK = '127.0.0.1';
const SCHEMA_PATTERN = /^e2e_\d+_[0-9a-f]{12}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE_MATERIAL_NAMES = [
  'ПВД Первичное',
  'ПВД Вторичное',
  'ПВД Айка',
  'ПВД ТСП',
  'Данафлекс',
  'Стрейч',
];
const FILM_OPTIONS = ['', 'Рукав', 'Полотно', 'Полурукав', 'Фальц'];
const BIRKA_OPTIONS = ['', 'ГОСТ', 'i', 'Тех', 'ГОСТ103', 'ГОСТ259'];
const SPOOL_OPTIONS = ['', 'Тонкая', 'Толстая'];
const INVENTORY_EVENT_TYPES = [
  'audit:inventory_manual_correction',
  'audit:raw_material_received',
  'problem:raw_material_shortage',
  'integration.onec_imported',
  'integration.onec_import_failed',
];
const UNSAFE_COMMERCIAL_TEXT = [
  'rawPayload',
  'passwordHash',
  'sourceSnapshotId',
  'amountValue',
  'fixture-only',
  'mock-order-a-1024',
  'Backend API',
  'Проекция backend',
  'снимок backend',
];
const ROLE_ACCESS = [
  { login: 'коммерция', role: 'commercial', read: 200, create: 201 },
  { login: 'склад', role: 'warehouse', read: 200, create: 403 },
  { login: 'производство', role: 'production_lead', read: 200, create: 201 },
  { login: 'ахметов булат', role: 'operator', read: 403, create: 403 },
  { login: 'бухгалтерия', role: 'finance', read: 403, create: 403 },
  { login: 'директор', role: 'director', read: 403, create: 403 },
  { login: 'админ', role: 'admin', read: 200, create: 403 },
];

const frontendDir = process.cwd();
const schemaName = `e2e_${process.pid}_${randomBytes(6).toString('hex')}`;
const runTag = `${process.pid}-${randomBytes(5).toString('hex')}`;
const smokePassword = randomBytes(24).toString('base64url');
const artifactDir = mkdtempSync(path.join(tmpdir(), 'plenka-recipe-live-'));
const children = [];
const contexts = [];
const checkpoints = [];
const abortController = new AbortController();

let backendDir;
let databaseUrl;
let apiBase;
let webBase;
let browser;
let verifier;
let PrismaClient;
let schemaOwned = false;

function invariant(condition, message) {
  assert.ok(condition, message);
}

function normalizeCatalogName(value) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
}

function checkpoint(number, label) {
  checkpoints.push({ number, label });
  console.log(`CHECKPOINT ${number}/9 ${label}`);
}

function throwIfAborted() {
  if (abortController.signal.aborted) {
    throw abortController.signal.reason instanceof Error
      ? abortController.signal.reason
      : new Error('Smoke interrupted');
  }
}

function tail(value, limit = 20_000) {
  return `${value}${''}`.slice(-limit);
}

function signalProcessGroup(child, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Cleanup reports a surviving process after the bounded wait.
    }
  }
}

function captureChild(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: false,
  });
  child.output = '';
  child.startError = null;
  const collect = (chunk) => {
    child.output = tail(`${child.output}${chunk}`);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (error) => {
    child.startError = error;
  });
  children.push(child);
  return child;
}

function runCommand(command, args, options) {
  throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = captureChild(command, args, options);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      abortController.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      signalProcessGroup(child, 'SIGTERM');
      finish(
        abortController.signal.reason instanceof Error
          ? abortController.signal.reason
          : new Error('Smoke interrupted'),
      );
    };
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish(null, child.output.trim());
        return;
      }
      finish(
        new Error(
          `${command} ${args.join(' ')} failed (${code ?? signal ?? 'unknown'})\n${child.output}`,
        ),
      );
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const complete = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(failTimer);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => complete();
    const forceTimer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), 3_000);
    const failTimer = setTimeout(
      () => complete(new Error(`Process group ${child.pid} did not stop`)),
      7_000,
    );
    child.once('exit', onExit);
    signalProcessGroup(child, 'SIGTERM');
  });
}

async function allocatePort(excluded = new Set()) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
        const address = server.address();
        invariant(address && typeof address === 'object', 'Dynamic port allocation failed');
        const selected = address.port;
        server.close((error) => (error ? reject(error) : resolve(selected)));
      });
    });
    if (!excluded.has(port)) return port;
  }
  throw new Error('Could not allocate two distinct loopback ports');
}

async function waitForHttp(url, label, child, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    throwIfAborted();
    if (child.startError) throw child.startError;
    if (child.exitCode !== null) {
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
  throw new Error(`${label} did not become ready at ${url}\n${child.output}`);
}

async function waitUntil(label, predicate, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    throwIfAborted();
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(
    `${label} did not complete within ${timeout}ms${lastError ? `: ${lastError}` : ''}`,
  );
}

async function apiRequest(
  pathname,
  {
    token,
    method = 'GET',
    body,
    expectedStatus = method === 'POST' ? 201 : 200,
    headers = {},
  } = {},
) {
  throwIfAborted();
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  assert.equal(
    response.status,
    expectedStatus,
    `${method} ${pathname} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

async function loginApi(login, expectedRole) {
  const session = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { login, password: smokePassword },
    expectedStatus: 201,
  });
  invariant(typeof session?.token === 'string' && session.token, `${login} returned no token`);
  assert.equal(session.user?.role, expectedRole, `${login} resolved to the wrong role`);
  return session;
}

function isApiUrl(url) {
  try {
    return new URL(url).pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function attachBrowserDiagnostics(page, label, intentional503) {
  const state = {
    label,
    failures: [],
    pending: new Set(),
  };
  page.on('pageerror', (error) => state.failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const isRegistered503Console =
      intentional503 &&
      intentional503.served === 1 &&
      intentional503.consoleObserved === 0 &&
      text.includes('Failed to load resource') &&
      text.includes('503');
    if (isRegistered503Console) {
      intentional503.consoleObserved += 1;
      return;
    }
    state.failures.push(`console: ${text}`);
  });
  page.on('request', (request) => {
    if (isApiUrl(request.url())) state.pending.add(request);
  });
  page.on('requestfinished', (request) => state.pending.delete(request));
  page.on('requestfailed', (request) => {
    state.pending.delete(request);
    const failure = request.failure()?.errorText ?? '';
    if (isApiUrl(request.url()) && failure !== 'net::ERR_ABORTED') {
      state.failures.push(
        `requestfailed: ${request.method()} ${new URL(request.url()).pathname} ${failure}`,
      );
    }
  });
  page.on('response', (response) => {
    if (!isApiUrl(response.url()) || response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    const isRegistered503 =
      response.status() === 503 &&
      pathname === '/api/commercial/orders' &&
      response.request().method() === 'POST' &&
      intentional503 &&
      intentional503.served === 1 &&
      intentional503.observed === 0;
    if (isRegistered503) {
      intentional503.observed += 1;
      return;
    }
    state.failures.push(
      `response: ${response.request().method()} ${pathname} HTTP ${response.status()}`,
    );
  });
  return state;
}

async function waitForApiIdle(state, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let quietSince = null;
  while (Date.now() < deadline) {
    throwIfAborted();
    if (state.pending.size === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 750) return;
    } else {
      quietSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `${state.label} API did not become idle: ${[...state.pending]
      .map((request) => `${request.method()} ${new URL(request.url()).pathname}`)
      .join(', ')}`,
  );
}

function assertDiagnosticsClean(...states) {
  const failures = states.flatMap((state) =>
    state.failures.map((failure) => `${state.label}: ${failure}`),
  );
  assert.deepEqual(failures, [], `Browser diagnostics failed:\n${failures.join('\n')}`);
}

async function loginBrowser(page, login, expectedRole, section) {
  const loginResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/login' &&
      response.request().method() === 'POST',
  );
  await page.goto(
    `${webBase}/?role=${encodeURIComponent(login)}&section=${encodeURIComponent(section)}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.getByLabel('Логин', { exact: true }).fill(login);
  await page.getByLabel('Пароль', { exact: true }).fill(smokePassword);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const response = await loginResponse;
  assert.equal(response.status(), 201, `${login} browser login returned ${response.status()}`);
  const session = await response.json();
  invariant(typeof session?.token === 'string' && session.token, `${login} browser token missing`);
  assert.equal(session.user?.role, expectedRole, `${login} browser role mismatch`);
  await page
    .locator(
      `.app-shell[data-active-role="${expectedRole === 'production_lead' ? 'production' : expectedRole}"]`,
    )
    .waitFor({ state: 'visible', timeout: 20_000 });
  return session;
}

async function optionProjection(select) {
  return select.evaluate((node) =>
    Array.from(node.options).map((option) => ({
      value: option.value,
      text: option.textContent?.trim() ?? '',
      disabled: option.disabled,
    })),
  );
}

function expectedSimpleOptions(values, disabledPlaceholder) {
  return values.map((value, index) => ({
    value,
    text: value || (disabledPlaceholder ? disabledPlaceholder.text : ''),
    disabled: index === 0 ? Boolean(disabledPlaceholder?.disabled) : false,
  }));
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  invariant(
    overflow.document <= 1 && overflow.body <= 1,
    `${label} horizontal overflow: ${JSON.stringify(overflow)}`,
  );
}

async function assertSurfaceNoOverflow(locator, label) {
  if ((await locator.count()) === 0 || !(await locator.first().isVisible())) return;
  const overflow = await locator.first().evaluate((node) => node.scrollWidth - node.clientWidth);
  invariant(overflow <= 1, `${label} overflows horizontally by ${overflow}px`);
}

async function assertRecipeEditorLayout(page) {
  const editor = page.getByRole('dialog', { name: 'Рецептура', exact: true });
  await editor.waitFor({ state: 'visible' });
  const layout = await editor.evaluate((node) => {
    const header = node.querySelector('.recipe-editor-header');
    const body = node.querySelector('.recipe-editor-body');
    const footer = node.querySelector('.recipe-editor-footer');
    if (
      !(header instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(footer instanceof HTMLElement)
    ) {
      return null;
    }
    const headerBox = header.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    const bodyStyle = getComputedStyle(body);
    return {
      headerVisible: headerBox.top >= 0 && headerBox.bottom <= window.innerHeight,
      footerVisible: footerBox.top >= 0 && footerBox.bottom <= window.innerHeight,
      editorOverflowX: node.scrollWidth - node.clientWidth,
      bodyOverflowX: body.scrollWidth - body.clientWidth,
      bodyOverflowY: bodyStyle.overflowY,
      editorOverflow: getComputedStyle(node).overflow,
    };
  });
  invariant(layout, 'Recipe editor layout elements are missing');
  invariant(layout.headerVisible, 'Recipe editor header is outside the viewport');
  invariant(layout.footerVisible, 'Recipe editor footer is outside the viewport');
  invariant(layout.editorOverflowX <= 1, `Recipe editor overflows by ${layout.editorOverflowX}px`);
  invariant(layout.bodyOverflowX <= 1, `Recipe body overflows by ${layout.bodyOverflowX}px`);
  invariant(
    ['auto', 'scroll'].includes(layout.bodyOverflowY),
    `Recipe body is not the vertical scroll owner: ${layout.bodyOverflowY}`,
  );
  assert.equal(layout.editorOverflow, 'hidden', 'Recipe editor shell must not scroll');
}

async function assertNoFrameworkOverlay(page) {
  const overlayCount = await page
    .locator(
      'vite-error-overlay, #webpack-dev-server-client-overlay, nextjs-portal [data-nextjs-dialog-overlay]',
    )
    .count();
  assert.equal(overlayCount, 0, 'Framework error overlay is visible');
}

async function assertNoUnsafeText(page) {
  const body = await page.locator('body').innerText();
  for (const value of UNSAFE_COMMERCIAL_TEXT) {
    invariant(!body.includes(value), `Unsafe commercial text leaked: ${value}`);
  }
}

async function roleSectionButton(page, name) {
  const candidates = page
    .locator('.role-nav, .role-top-nav')
    .getByRole('button', { name, exact: true });
  const moreCandidates = page.getByRole('button', { name: /^Еще разделы:/u });
  const visibleCandidate = async () => {
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      if (await candidates.nth(index).isVisible()) return candidates.nth(index);
    }
    return null;
  };
  const visibleMore = async () => {
    const count = await moreCandidates.count();
    for (let index = 0; index < count; index += 1) {
      if (await moreCandidates.nth(index).isVisible()) return moreCandidates.nth(index);
    }
    return null;
  };
  await waitUntil(`role navigation for ${name}`, async () =>
    Boolean((await visibleCandidate()) ?? (await visibleMore())),
  );
  const directlyVisible = await visibleCandidate();
  if (directlyVisible) return directlyVisible;

  const more = await visibleMore();
  invariant(more, `Role section ${name} has no visible More button`);
  await more.click();
  const drawerButton = page.getByRole('dialog').getByRole('button', { name, exact: true });
  await drawerButton.waitFor({ state: 'visible' });
  return drawerButton;
}

async function formProjection(dialog) {
  return dialog.evaluate((node) =>
    Array.from(node.querySelectorAll('input, select, textarea')).map((control, index) => ({
      index,
      tag: control.tagName,
      label: control.getAttribute('aria-label') ?? '',
      type: control.getAttribute('type') ?? '',
      value: control.value,
      checked: control instanceof HTMLInputElement ? control.checked : undefined,
    })),
  );
}

function recipeCommand(name, ingredients) {
  return {
    clientRequestId: randomUUID(),
    name,
    ingredients,
  };
}

function assertUuid(value, label) {
  invariant(typeof value === 'string' && UUID_PATTERN.test(value), `${label} is not a UUID`);
}

function assertStructuredRecipePosition(position, recipeVersionId, label) {
  assert.equal(position.recipeDefinitionVersionId, recipeVersionId, `${label} recipe selector`);
  invariant(!Object.hasOwn(position, 'rawMaterialId'), `${label} leaked rawMaterialId`);
  invariant(!Object.hasOwn(position, 'recipeParameters'), `${label} leaked recipeParameters`);
  invariant(
    !Object.hasOwn(position, 'baseRawMaterialDefinitionId'),
    `${label} contains both structured selectors`,
  );
}

function assertNoLegacyOrderFields(orderCommand, label) {
  const serialized = JSON.stringify(orderCommand);
  invariant(!serialized.includes('"rawMaterialId"'), `${label} contains rawMaterialId`);
  invariant(!serialized.includes('"recipeParameters"'), `${label} contains recipeParameters`);
}

async function createRecipeInOpenEditor(
  page,
  { name, existingMaterialId, secondMaterialId, existingShare, secondShare },
) {
  const editor = page.getByRole('dialog', { name: 'Рецептура', exact: true });
  await editor.waitFor({ state: 'visible' });
  await assertRecipeEditorLayout(page);
  await editor.getByLabel('Название рецептуры', { exact: true }).fill(name);

  const firstRow = editor.locator('.recipe-editor-ingredient').first();
  await firstRow.locator('select').selectOption(existingMaterialId);
  await firstRow.locator('input[inputmode="decimal"]').fill(String(existingShare));

  await editor.getByRole('button', { name: 'Добавить продукт +', exact: true }).click();
  assert.equal(
    await editor.locator('.recipe-editor-ingredient').count(),
    2,
    'Recipe editor did not add the second component',
  );
  const secondRow = editor.locator('.recipe-editor-ingredient').nth(1);
  await secondRow.locator('select').selectOption(secondMaterialId);
  await secondRow.locator('input[inputmode="decimal"]').fill(String(secondShare));
  assert.equal(
    await editor.getByRole('button', { name: 'Добавить +', exact: true }).count(),
    0,
    'Recipe editor exposed forbidden inline raw-material creation',
  );
  await assertRecipeEditorLayout(page);

  const requestPromise = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/recipe-catalog' && request.method() === 'POST',
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/recipe-catalog' &&
      response.request().method() === 'POST',
  );
  await editor.getByRole('button', { name: 'Сохранить рецептуру', exact: true }).click();
  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  assert.equal(response.status(), 201, `Recipe create returned HTTP ${response.status()}`);
  const command = request.postDataJSON();
  const recipe = await response.json();
  assertUuid(command.clientRequestId, 'Recipe clientRequestId');
  assert.equal(command.name, name, 'Recipe command changed its name');
  assert.deepEqual(
    command.ingredients,
    [
      { rawMaterialDefinitionId: existingMaterialId, shareBasisPoints: existingShare * 100 },
      { rawMaterialDefinitionId: secondMaterialId, shareBasisPoints: secondShare * 100 },
    ],
    'Recipe command ingredients differ from the editor',
  );
  await editor.waitFor({ state: 'detached' });
  return { command, recipe };
}

async function fillPosition(
  dialog,
  index,
  {
    rollCount,
    actualThickness,
    accountingThickness,
    filmType,
    weight,
    birka,
    spool,
    materialValue,
    comment,
  },
) {
  const number = index + 1;
  await dialog
    .getByLabel(`Количество рулонов, позиция ${number}`, { exact: true })
    .fill(String(rollCount));
  await dialog
    .getByLabel(`Фактическая толщина, позиция ${number}`, { exact: true })
    .fill(actualThickness);
  await dialog
    .getByLabel(`Бухгалтерская толщина, позиция ${number}`, { exact: true })
    .fill(accountingThickness);
  await dialog.getByLabel(`Ширина, мм, позиция ${number}`, { exact: true }).fill('1700');
  await dialog.getByLabel(`Метраж, м, позиция ${number}`, { exact: true }).fill('275');
  await dialog
    .getByLabel(`Тип пленки, позиция ${number}`, { exact: true })
    .selectOption({ label: filmType });
  await dialog.getByLabel(`Вес, позиция ${number}`, { exact: true }).fill(String(weight));
  await dialog
    .getByLabel(`Бирка, позиция ${number}`, { exact: true })
    .selectOption({ label: birka });
  await dialog
    .getByLabel(`Шпуля, позиция ${number}`, { exact: true })
    .selectOption({ label: spool });
  if (materialValue) {
    await dialog
      .getByLabel(`Рецептуры, позиция ${number}`, { exact: true })
      .selectOption(materialValue);
  }
  await dialog.getByLabel(`Комментарий, позиция ${number}`, { exact: true }).fill(comment);
}

function canonicalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortByKey(items, key) {
  return [...items].sort((left, right) =>
    String(left?.[key] ?? '').localeCompare(String(right?.[key] ?? ''), 'ru'),
  );
}

async function inventorySnapshot(warehouseToken) {
  const [stockRows, preview, pushOperationCount, events] = await Promise.all([
    apiRequest('/api/warehouse/raw-materials', { token: warehouseToken }),
    apiRequest('/api/warehouse/raw-materials/onec-push-preview', { token: warehouseToken }),
    verifier.oneCStockPushOperation.count(),
    verifier.domainEvent.findMany({
      where: { type: { in: INVENTORY_EVENT_TYPES } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        family: true,
        type: true,
        objectId: true,
        actorRole: true,
        actorId: true,
        label: true,
        detail: true,
        oldValue: true,
        newValue: true,
        reason: true,
        sourceSnapshotId: true,
        createdAt: true,
      },
    }),
  ]);
  invariant(Array.isArray(stockRows), 'Warehouse raw-material response is not an array');
  const sortedPreview =
    preview && Array.isArray(preview.items)
      ? { ...preview, items: sortByKey(preview.items, 'materialId') }
      : preview;
  return canonicalize({
    stockRows: sortByKey(stockRows, 'materialId'),
    preview: sortedPreview,
    pushOperationCount,
    events,
  });
}

async function findCommercialOrder(token, orderNumber) {
  let cursor = null;
  do {
    const params = new URLSearchParams({
      bucket: 'in_work',
      mode: 'current',
      limit: '100',
    });
    if (cursor) params.set('cursor', cursor);
    const page = await apiRequest(`/api/commercial/orders?${params}`, { token });
    const found = page.items?.find((item) => item.orderNumber === orderNumber);
    if (found) return found;
    cursor = page.nextCursor ?? null;
  } while (cursor);
  throw new Error(`${orderNumber} was not found in the in_work commercial bucket`);
}

async function routeOrderToProduction(order, commercialToken, warehouseToken) {
  const position = order.positions?.[0];
  invariant(position?.id, 'Second order response has no persisted position');
  const coverRequest = await apiRequest(
    `/api/commercial/orders/${encodeURIComponent(order.id)}/warehouse-cover/recheck`,
    {
      token: commercialToken,
      method: 'POST',
      body: {},
      expectedStatus: 201,
    },
  );
  invariant(coverRequest?.case?.id, 'Warehouse-cover recheck returned no case');
  const proposal = await apiRequest(
    `/api/warehouse/orders/${encodeURIComponent(order.id)}/cover-proposals`,
    {
      token: warehouseToken,
      method: 'POST',
      body: {
        positionId: position.id,
        rollIds: [],
        comment: `Recipe live smoke production route ${runTag}`,
      },
      expectedStatus: 201,
    },
  );
  invariant(proposal?.id && Number.isInteger(proposal.version), 'Cover proposal is incomplete');
  const approval = await apiRequest(
    `/api/commercial/orders/${encodeURIComponent(order.id)}/positions/` +
      `${encodeURIComponent(position.id)}/warehouse-cover/${encodeURIComponent(proposal.id)}/` +
      'commercial-approval',
    {
      token: commercialToken,
      method: 'POST',
      body: { expectedVersion: proposal.version, route: 'production_only' },
      expectedStatus: 201,
    },
  );
  assert.equal(approval.route, 'production_only', 'Commercial route was not production_only');
}

async function assertAccessMatrix(sessions, baseMaterialId) {
  const unauthenticatedCommand = recipeCommand(`Unauth recipe ${runTag}`, [
    { rawMaterialDefinitionId: baseMaterialId, shareBasisPoints: 10_000 },
  ]);
  await apiRequest('/api/recipe-catalog', { expectedStatus: 401 });
  await apiRequest('/api/recipe-catalog', {
    method: 'POST',
    body: unauthenticatedCommand,
    expectedStatus: 401,
  });

  const xRoleCommand = recipeCommand(`X role recipe ${runTag}`, [
    { rawMaterialDefinitionId: baseMaterialId, shareBasisPoints: 10_000 },
  ]);
  await apiRequest('/api/recipe-catalog', {
    headers: { 'x-role': 'commercial' },
    expectedStatus: 401,
  });
  await apiRequest('/api/recipe-catalog', {
    method: 'POST',
    headers: { 'x-role': 'commercial' },
    body: xRoleCommand,
    expectedStatus: 401,
  });

  for (const access of ROLE_ACCESS) {
    let session = sessions.get(access.role);
    if (!session) {
      session = await loginApi(access.login, access.role);
      sessions.set(access.role, session);
    }
    await apiRequest('/api/recipe-catalog', {
      token: session.token,
      expectedStatus: access.read,
    });
    const command = recipeCommand(`Matrix ${access.role} recipe ${runTag}`, [
      { rawMaterialDefinitionId: baseMaterialId, shareBasisPoints: 10_000 },
    ]);
    await apiRequest('/api/recipe-catalog', {
      token: session.token,
      method: 'POST',
      body: command,
      expectedStatus: access.create,
    });
  }
}

async function dropExactSchema() {
  if (!schemaOwned || !databaseUrl || !PrismaClient) return;
  invariant(SCHEMA_PATTERN.test(schemaName), `Refusing to drop invalid schema ${schemaName}`);
  invariant(schemaName !== 'public', 'Refusing to drop public schema');
  const cleanupClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await cleanupClient.$connect();
    await cleanupClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await cleanupClient.$disconnect();
  }
}

async function cleanup() {
  const failures = [];
  const attempt = async (label, action) => {
    try {
      await action();
    } catch (error) {
      failures.push(
        new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  };

  for (const context of [...contexts].reverse()) {
    await attempt('close browser context', () => context.close());
  }
  await attempt('close browser', async () => {
    if (browser) await browser.close();
  });
  for (const child of [...children].reverse()) {
    await attempt(`stop process group ${child.pid}`, () => stopChild(child));
  }
  await attempt('disconnect verification Prisma', async () => {
    if (verifier) {
      await verifier.$disconnect();
      verifier = null;
    }
  });
  await attempt(`drop schema ${schemaName}`, dropExactSchema);
  return failures;
}

async function runWorkflow() {
  assert.match(schemaName, SCHEMA_PATTERN);
  const configuredBackend = process.env.PLENKA_BACKEND_DIR;
  invariant(configuredBackend, 'PLENKA_BACKEND_DIR is required');
  backendDir = path.resolve(configuredBackend);
  const backendManifestPath = path.join(backendDir, 'package.json');
  invariant(existsSync(backendManifestPath), `Backend package.json missing at ${backendDir}`);
  const backendManifest = JSON.parse(readFileSync(backendManifestPath, 'utf8'));
  assert.equal(backendManifest.name, 'plenka-cover', 'PLENKA_BACKEND_DIR is not plenka-cover');

  const baseDatabaseUrl = process.env.DATABASE_URL;
  invariant(baseDatabaseUrl, 'DATABASE_URL PostgreSQL base URL is required');
  let isolatedUrl;
  try {
    isolatedUrl = new URL(baseDatabaseUrl);
  } catch (error) {
    throw new Error('DATABASE_URL is not a valid URL', { cause: error });
  }
  invariant(
    isolatedUrl.protocol === 'postgresql:' || isolatedUrl.protocol === 'postgres:',
    'DATABASE_URL must use PostgreSQL',
  );
  invariant(isolatedUrl.pathname.length > 1, 'DATABASE_URL must select a database');
  isolatedUrl.searchParams.delete('schema');
  isolatedUrl.searchParams.append('schema', schemaName);
  assert.deepEqual(
    isolatedUrl.searchParams.getAll('schema'),
    [schemaName],
    'Isolated URL must contain exactly one schema parameter',
  );
  databaseUrl = isolatedUrl.toString();
  schemaOwned = true;

  const backendRequire = createRequire(backendManifestPath);
  ({ PrismaClient } = backendRequire('@prisma/client'));
  invariant(typeof PrismaClient === 'function', 'Backend PrismaClient is unavailable');

  const apiPort = await allocatePort();
  const webPort = await allocatePort(new Set([apiPort]));
  apiBase = `http://${LOOPBACK}:${apiPort}`;
  webBase = `http://${LOOPBACK}:${webPort}`;
  const smokeEnvironment = {
    ...process.env,
    APP_ENV: 'test',
    SEED_PROFILE: 'demo',
    SEED_PASSWORD: smokePassword,
    AUTH_DEV_XROLE: 'off',
    LOGIN_RATE_MAX: '100',
    DATABASE_URL: databaseUrl,
    ONEC_LIVE: 'false',
    ONEC_WRITE: 'false',
  };

  console.log(`ISOLATED_SCHEMA ${schemaName}`);
  console.log(`BACKEND ${backendDir}`);
  console.log(`PORTS api=${apiPort} web=${webPort}`);
  console.log(`ARTIFACTS ${artifactDir}`);

  await runCommand('npm', ['run', 'db:deploy'], {
    cwd: backendDir,
    env: smokeEnvironment,
  });
  await runCommand('npm', ['run', 'db:seed'], {
    cwd: backendDir,
    env: smokeEnvironment,
  });

  const backendEntry = path.join(backendDir, 'apps/api/dist/main.js');
  await runCommand('npm', ['run', 'build'], {
    cwd: backendDir,
    env: smokeEnvironment,
  });
  const backend = captureChild(process.execPath, [backendEntry], {
    cwd: path.join(backendDir, 'apps/api'),
    env: { ...smokeEnvironment, PORT: String(apiPort) },
  });
  await waitForHttp(`${apiBase}/api/health`, 'Backend', backend);

  verifier = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await verifier.$connect();

  const vite = captureChild(
    process.execPath,
    [
      path.resolve(frontendDir, 'node_modules/vite/bin/vite.js'),
      '--host',
      LOOPBACK,
      '--port',
      String(webPort),
      '--strictPort',
    ],
    {
      cwd: frontendDir,
      env: {
        ...process.env,
        API_PROXY_TARGET: apiBase,
        VITE_LIVE_CONTOURS: 'commercial,warehouse',
        VITE_REQUIRE_AUTH: 'on',
      },
    },
  );
  await waitForHttp(webBase, 'Vite', vite);

  browser = await chromium.launch({ headless: true });
  const intentional503 = {
    served: 0,
    observed: 0,
    consoleObserved: 0,
    firstCommand: null,
  };
  const commercialContext = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  contexts.push(commercialContext);
  await commercialContext.route('**/api/commercial/orders', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && intentional503.served === 0) {
      intentional503.served = 1;
      intentional503.firstCommand = request.postDataJSON();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'x-plenka-smoke-intentional': 'order-create-503' },
        body: JSON.stringify({
          statusCode: 503,
          code: 'SMOKE_INTENTIONAL_RETRY',
          message: 'Synthetic first-attempt failure',
        }),
      });
      return;
    }
    await route.continue();
  });

  const commercialPage = await commercialContext.newPage();
  const commercialDiagnostics = attachBrowserDiagnostics(
    commercialPage,
    'commercial',
    intentional503,
  );
  const commercialSession = await loginBrowser(
    commercialPage,
    'коммерция',
    'commercial',
    'Входящие заявки',
  );
  const sessions = new Map([['commercial', commercialSession]]);
  const commercialMe = await apiRequest('/api/auth/me', {
    token: commercialSession.token,
  });
  assert.equal(commercialMe.role, 'commercial', '/auth/me did not confirm commercial identity');
  assert.equal(
    commercialMe.userId,
    commercialSession.user.id,
    '/auth/me user differs from browser login',
  );
  await waitForApiIdle(commercialDiagnostics);
  await assertNoHorizontalOverflow(commercialPage, 'commercial initial workspace');

  const liveMaterialCatalog = await apiRequest('/api/material-catalog', {
    token: commercialSession.token,
  });
  const initialRecipeCatalog = await apiRequest('/api/recipe-catalog', {
    token: commercialSession.token,
  });
  invariant(Array.isArray(liveMaterialCatalog), 'Material catalog is not an array');
  invariant(Array.isArray(initialRecipeCatalog), 'Recipe catalog is not an array');
  const baseMaterials = BASE_MATERIAL_NAMES.flatMap((name) => {
    const material = liveMaterialCatalog.find((item) => item.kind === 'base' && item.name === name);
    return material ? [material] : [];
  });
  assert.equal(
    baseMaterials.length,
    BASE_MATERIAL_NAMES.length,
    'Seeded base material catalog is incomplete',
  );
  const baseMaterial = baseMaterials[0];

  const incomingButton = await roleSectionButton(commercialPage, 'Входящие заявки');
  if ((await incomingButton.getAttribute('aria-current')) !== 'page') await incomingButton.click();
  await commercialPage.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  const intake = commercialPage.getByRole('dialog', {
    name: 'Создать заявку',
    exact: true,
  });
  await intake.waitFor({ state: 'visible' });
  await assertNoHorizontalOverflow(commercialPage, 'commercial intake');
  await assertSurfaceNoOverflow(intake, 'commercial intake');

  const filmOptions = await optionProjection(
    intake.getByLabel('Тип пленки, позиция 1', { exact: true }),
  );
  assert.deepEqual(
    filmOptions,
    expectedSimpleOptions(FILM_OPTIONS, { text: 'Выберите тип', disabled: false }),
    'Film options differ from the exact catalog',
  );
  const birkaOptions = await optionProjection(
    intake.getByLabel('Бирка, позиция 1', { exact: true }),
  );
  assert.deepEqual(
    birkaOptions,
    expectedSimpleOptions(BIRKA_OPTIONS, { text: 'Выберите бирку', disabled: false }),
    'Birka options differ from the exact catalog',
  );
  const spoolOptions = await optionProjection(
    intake.getByLabel('Шпуля, позиция 1', { exact: true }),
  );
  assert.deepEqual(
    spoolOptions,
    expectedSimpleOptions(SPOOL_OPTIONS, { text: 'Выберите шпулю', disabled: false }),
    'Spool options differ from the exact catalog',
  );
  const expectedMaterialOptions = [
    { value: '', text: 'Выберите продукт или рецептуру', disabled: true },
    ...liveMaterialCatalog.map((material) => ({
      value: `material:${material.id}`,
      text: material.name,
      disabled: false,
    })),
    ...initialRecipeCatalog.map((recipe) => ({
      value: `recipe:${recipe.version.id}`,
      text: recipe.name,
      disabled: false,
    })),
  ];
  assert.deepEqual(
    await optionProjection(intake.getByLabel('Рецептуры, позиция 1', { exact: true })),
    expectedMaterialOptions,
    'Unified material and recipe options differ from live catalogs',
  );
  assert.equal(
    await intake.getByLabel('Сырье, позиция 1', { exact: true }).count(),
    0,
    'Commercial intake exposed a separate raw-material selector',
  );
  assert.equal(
    await intake.getByLabel('Рецептура, позиция 1', { exact: true }).count(),
    0,
    'Commercial intake exposed a second recipe selector',
  );
  checkpoint(1, 'commercial Bearer login, identity and one exact unified dropdown');

  await intake.getByRole('button', { name: 'Добавить позицию', exact: true }).click();
  assert.equal(
    await intake.locator('.intake-position-card').count(),
    2,
    'Second order position was not added',
  );
  const originCard = intake.locator('.intake-position-card').nth(0);
  await originCard.getByRole('heading', { name: 'Позиция 1', exact: true }).waitFor();
  const originTrigger = originCard.getByRole('button', {
    name: 'Создать рецептуру',
    exact: true,
  });
  await originTrigger.click();
  const escapedEditor = commercialPage.getByRole('dialog', {
    name: 'Рецептура',
    exact: true,
  });
  await escapedEditor.waitFor({ state: 'visible' });
  await assertRecipeEditorLayout(commercialPage);
  await commercialPage.keyboard.press('Escape');
  await escapedEditor.waitFor({ state: 'detached' });
  await intake.waitFor({ state: 'visible' });
  await commercialPage.waitForFunction(
    () => document.activeElement?.textContent?.trim() === 'Создать рецептуру',
  );

  await originTrigger.click();
  const firstRecipeName = `Коммерческая смесь ${runTag}`;
  const firstRecipeResult = await createRecipeInOpenEditor(commercialPage, {
    name: firstRecipeName,
    existingMaterialId: baseMaterial.id,
    secondMaterialId: baseMaterials[1].id,
    existingShare: 70,
    secondShare: 30,
  });
  const firstRecipe = firstRecipeResult.recipe;
  invariant(firstRecipe?.version?.id, 'Commercial recipe response has no version');
  const firstRecipeValue = `recipe:${firstRecipe.version.id}`;
  assert.equal(
    await intake.getByLabel('Рецептуры, позиция 1', { exact: true }).inputValue(),
    firstRecipeValue,
    'Origin unified selector did not select the new recipe',
  );
  assert.equal(
    await intake.getByLabel('Рецептуры, позиция 2', { exact: true }).inputValue(),
    '',
    'Second-position unified selector changed',
  );
  for (const positionNumber of [1, 2]) {
    const options = await optionProjection(
      intake.getByLabel(`Рецептуры, позиция ${positionNumber}`, { exact: true }),
    );
    assert.equal(
      options.filter((option) => option.value === firstRecipeValue).length,
      1,
      `Unified selector position ${positionNumber} contains duplicate recipe options`,
    );
  }
  checkpoint(2, 'nested Escape focus and origin-only recipe creation');

  await intake.getByLabel('Контрагент', { exact: true }).selectOption({ label: 'УралПак' });
  await fillPosition(intake, 0, {
    rollCount: 2,
    actualThickness: '80 мкм',
    accountingThickness: '78 мкм',
    filmType: 'Рукав',
    weight: 50,
    birka: 'ГОСТ',
    spool: 'Тонкая',
    materialValue: firstRecipeValue,
    comment: `Первая позиция ${runTag}`,
  });
  await fillPosition(intake, 1, {
    rollCount: 1,
    actualThickness: '60 мкм',
    accountingThickness: '58 мкм',
    filmType: 'Полотно',
    weight: 25,
    birka: 'Тех',
    spool: 'Толстая',
    materialValue: `material:${baseMaterials[1].id}`,
    comment: `Вторая позиция ${runTag}`,
  });
  const beforeFailedSubmit = await formProjection(intake);
  const failureResponsePromise = commercialPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/commercial/orders' &&
      response.request().method() === 'POST' &&
      response.status() === 503,
  );
  await intake.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  const failureResponse = await failureResponsePromise;
  assert.equal(failureResponse.status(), 503, 'First order create was not the synthetic 503');
  assert.equal(intentional503.served, 1, 'Synthetic order failure was not served exactly once');
  await intake.waitFor({ state: 'visible' });
  await waitUntil('order submit recovers after synthetic 503', async () =>
    intake.getByRole('button', { name: 'Создать заявку', exact: true }).isEnabled(),
  );
  assert.deepEqual(
    await formProjection(intake),
    beforeFailedSubmit,
    'The complete intake draft changed after the synthetic failure',
  );

  const retryRequestPromise = commercialPage.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/commercial/orders' && request.method() === 'POST',
  );
  const retryResponsePromise = commercialPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/commercial/orders' &&
      response.request().method() === 'POST',
  );
  await intake.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  const [retryRequest, retryResponse] = await Promise.all([
    retryRequestPromise,
    retryResponsePromise,
  ]);
  const retryCommand = retryRequest.postDataJSON();
  assert.equal(retryResponse.status(), 201, `Order retry returned HTTP ${retryResponse.status()}`);
  const firstOrder = await retryResponse.json();
  assert.deepEqual(
    retryCommand,
    intentional503.firstCommand,
    'Order retry did not preserve the complete command',
  );
  assertUuid(retryCommand.clientRequestId, 'First order clientRequestId');
  assertStructuredRecipePosition(
    retryCommand.positions[0],
    firstRecipe.version.id,
    'First order position',
  );
  assertNoLegacyOrderFields(retryCommand, 'First order');
  await intake.waitFor({ state: 'detached' });
  assert.equal(intentional503.observed, 1, 'Intentional 503 was not observed exactly once');
  await waitForApiIdle(commercialDiagnostics);
  assertDiagnosticsClean(commercialDiagnostics);
  checkpoint(3, 'single 503, intact draft, identical UUID retry and structured selector');

  const firstOrderDetail = await apiRequest(
    `/api/commercial/orders/${encodeURIComponent(firstOrder.id)}`,
    { token: commercialSession.token },
  );
  const snapshotPosition = firstOrderDetail.positions.find(
    (position) => position.recipeDefinitionVersionId === firstRecipe.version.id,
  );
  invariant(snapshotPosition, 'First order detail has no recipe position');
  assert.deepEqual(
    snapshotPosition.recipe,
    {
      recipeDefinitionId: firstRecipe.id,
      recipeDefinitionVersionId: firstRecipe.version.id,
      recipeVersionNumber: firstRecipe.version.version,
      recipeName: firstRecipe.name,
      ingredients: firstRecipe.version.ingredients,
    },
    'Order recipe snapshot differs from the catalog result',
  );
  const replayedRecipe = await apiRequest('/api/recipe-catalog', {
    token: commercialSession.token,
    method: 'POST',
    body: firstRecipeResult.command,
    expectedStatus: 201,
  });
  assert.deepEqual(replayedRecipe, firstRecipe, 'Exact recipe replay changed the result');
  const catalogAfterReplay = await apiRequest('/api/recipe-catalog', {
    token: commercialSession.token,
  });
  assert.equal(
    catalogAfterReplay.filter(
      (recipe) => normalizeCatalogName(recipe.name) === normalizeCatalogName(firstRecipeName),
    ).length,
    1,
    'Exact recipe replay created a duplicate catalog row',
  );
  checkpoint(4, 'immutable order snapshot and idempotent recipe replay');

  const warehouseContext = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  contexts.push(warehouseContext);
  const warehousePage = await warehouseContext.newPage();
  const warehouseDiagnostics = attachBrowserDiagnostics(warehousePage, 'warehouse', null);
  const warehouseSession = await loginBrowser(warehousePage, 'склад', 'warehouse', 'Сырье');
  sessions.set('warehouse', warehouseSession);
  const warehouseMe = await apiRequest('/api/auth/me', { token: warehouseSession.token });
  assert.equal(warehouseMe.role, 'warehouse', '/auth/me did not confirm warehouse identity');

  await waitForApiIdle(warehouseDiagnostics);
  const authenticatedRawResponse = warehousePage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/warehouse/raw-materials' &&
      response.request().method() === 'GET',
  );
  await warehousePage.goto(
    `${webBase}/?role=warehouse&section=${encodeURIComponent('Сырье')}` +
      `&warehouseBust=${randomUUID()}`,
    { waitUntil: 'domcontentloaded' },
  );
  assert.equal(
    (await authenticatedRawResponse).status(),
    200,
    'Authenticated warehouse raw-material load failed',
  );
  await warehousePage
    .locator('.app-shell[data-active-role="warehouse"]')
    .waitFor({ state: 'visible', timeout: 20_000 });
  const warehouseInventory = warehousePage.locator('[aria-label="Остатки склада"]');
  if (!(await warehouseInventory.isVisible().catch(() => false))) {
    const warehouseRawButton = await roleSectionButton(warehousePage, 'Сырье');
    const rawResponsePromise = warehousePage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/warehouse/raw-materials' &&
        response.request().method() === 'GET',
    );
    await warehouseRawButton.click();
    assert.equal((await rawResponsePromise).status(), 200, 'Warehouse raw-material load failed');
  }
  await warehouseInventory.waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(
    await warehouseInventory.locator('tbody tr[aria-selected="true"]').count(),
    0,
    'Warehouse inventory starts with a selected stock row',
  );
  await assertNoHorizontalOverflow(warehousePage, 'warehouse raw-material workspace');
  await assertSurfaceNoOverflow(warehouseInventory, 'warehouse raw-material inventory');
  await waitForApiIdle(warehouseDiagnostics);
  const inventoryBefore = await inventorySnapshot(warehouseSession.token);

  const secondRecipeName = `Складская смесь ${runTag}`;
  const secondNewMaterialName = `Складской компонент ${runTag}`;
  const adminSession = await loginApi('админ', 'admin');
  sessions.set('admin', adminSession);
  const secondMaterial = await apiRequest('/api/material-catalog', {
    token: adminSession.token,
    method: 'POST',
    body: { name: secondNewMaterialName },
    expectedStatus: 201,
  });
  const secondRecipeCommand = recipeCommand(secondRecipeName, [
    { rawMaterialDefinitionId: baseMaterials[2].id, shareBasisPoints: 6_000 },
    { rawMaterialDefinitionId: secondMaterial.id, shareBasisPoints: 4_000 },
  ]);
  const productionSession = await loginApi('производство', 'production_lead');
  sessions.set('production_lead', productionSession);
  const secondRecipe = await apiRequest('/api/recipe-catalog', {
    token: productionSession.token,
    method: 'POST',
    body: secondRecipeCommand,
    expectedStatus: 201,
  });
  invariant(secondRecipe?.version?.id, 'Production recipe response has no version');
  assert.equal(
    await warehouseInventory
      .locator('.warehouse-inventory-table-actions')
      .getByRole('button', { name: 'Создать рецептуру', exact: true })
      .count(),
    0,
    'Warehouse exposed recipe creation forbidden by the final role contract',
  );
  await apiRequest('/api/recipe-catalog', {
    token: warehouseSession.token,
    method: 'POST',
    body: { ...secondRecipeCommand, clientRequestId: randomUUID() },
    expectedStatus: 403,
  });
  assert.equal(
    await warehouseInventory.locator('tbody tr[aria-selected="true"]').count(),
    0,
    'Catalog refresh selected a warehouse stock row',
  );
  const warehouseCatalog = await apiRequest('/api/recipe-catalog', {
    token: warehouseSession.token,
  });
  assert.equal(
    warehouseCatalog.filter((recipe) => recipe.id === secondRecipe.id).length,
    1,
    'Production-created recipe is missing or duplicated in the warehouse catalog projection',
  );
  const inventoryAfter = await inventorySnapshot(warehouseSession.token);
  assert.deepEqual(
    inventoryAfter,
    inventoryBefore,
    'Recipe catalog activity changed stock rows, 1C preview, push operations or inventory events',
  );
  await waitForApiIdle(warehouseDiagnostics);
  assertDiagnosticsClean(commercialDiagnostics, warehouseDiagnostics);
  checkpoint(
    5,
    'admin product creation, production recipe creation and warehouse stock invariance',
  );

  await waitForApiIdle(commercialDiagnostics);
  await commercialPage.goto(
    `${webBase}/?role=commercial&section=${encodeURIComponent('Входящие заявки')}` +
      `&catalogBust=${randomUUID()}`,
    { waitUntil: 'domcontentloaded' },
  );
  await commercialPage
    .locator('.app-shell[data-active-role="commercial"]')
    .waitFor({ state: 'visible', timeout: 20_000 });
  const freshMaterialResponse = commercialPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/material-catalog' &&
      response.request().method() === 'GET',
  );
  const freshRecipeResponse = commercialPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/recipe-catalog' &&
      response.request().method() === 'GET',
  );
  await commercialPage.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  const [materialReload, recipeReload] = await Promise.all([
    freshMaterialResponse,
    freshRecipeResponse,
  ]);
  assert.equal(materialReload.status(), 200, 'Cache-busted material catalog reload failed');
  assert.equal(recipeReload.status(), 200, 'Cache-busted recipe catalog reload failed');
  const secondIntake = commercialPage.getByRole('dialog', {
    name: 'Создать заявку',
    exact: true,
  });
  await secondIntake.waitFor({ state: 'visible' });
  const secondRecipeValue = `recipe:${secondRecipe.version.id}`;
  const secondOptions = await optionProjection(
    secondIntake.getByLabel('Рецептуры, позиция 1', { exact: true }),
  );
  assert.equal(
    secondOptions.filter(
      (option) => option.value === secondRecipeValue && option.text === secondRecipe.name,
    ).length,
    1,
    'Unified selector did not expose the cache-busted recipe exactly once',
  );
  assert.equal(
    secondOptions.filter(
      (option) =>
        option.value === `material:${secondMaterial.id}` && option.text === secondMaterial.name,
    ).length,
    1,
    'Unified selector did not expose the admin-created product exactly once',
  );
  await assertNoHorizontalOverflow(commercialPage, 'cache-busted commercial intake');
  await assertSurfaceNoOverflow(secondIntake, 'cache-busted commercial intake');
  checkpoint(6, 'cache-busted commercial catalog sees product and recipe in one selector');

  await secondIntake.getByLabel('Контрагент', { exact: true }).selectOption({ label: 'УралПак' });
  await fillPosition(secondIntake, 0, {
    rollCount: 1,
    actualThickness: '80 мкм',
    accountingThickness: '78 мкм',
    filmType: 'Рукав',
    weight: 100,
    birka: 'ГОСТ',
    spool: 'Тонкая',
    materialValue: secondRecipeValue,
    comment: `Split demand ${runTag}`,
  });
  assert.equal(
    await secondIntake.getByLabel('Рецептуры, позиция 1', { exact: true }).inputValue(),
    secondRecipeValue,
    'Second order unified selector lost the selected recipe',
  );
  const secondOrderRequestPromise = commercialPage.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/commercial/orders' && request.method() === 'POST',
  );
  const secondOrderResponsePromise = commercialPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/commercial/orders' &&
      response.request().method() === 'POST',
  );
  await secondIntake.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  const [secondOrderRequest, secondOrderResponse] = await Promise.all([
    secondOrderRequestPromise,
    secondOrderResponsePromise,
  ]);
  const secondOrderCommand = secondOrderRequest.postDataJSON();
  assert.equal(
    secondOrderResponse.status(),
    201,
    `Second order returned HTTP ${secondOrderResponse.status()}`,
  );
  const secondOrder = await secondOrderResponse.json();
  assertUuid(secondOrderCommand.clientRequestId, 'Second order clientRequestId');
  assert.notEqual(
    secondOrderCommand.clientRequestId,
    retryCommand.clientRequestId,
    'Successful first order did not rotate the intake UUID',
  );
  assertStructuredRecipePosition(
    secondOrderCommand.positions[0],
    secondRecipe.version.id,
    'Second order position',
  );
  assertNoLegacyOrderFields(secondOrderCommand, 'Second order');
  await secondIntake.waitFor({ state: 'detached' });

  await routeOrderToProduction(secondOrder, commercialSession.token, warehouseSession.token);
  const secondOrderDetail = await apiRequest(
    `/api/commercial/orders/${encodeURIComponent(secondOrder.id)}`,
    { token: commercialSession.token },
  );
  const secondSnapshotPosition = secondOrderDetail.positions.find(
    (position) => position.id === secondOrder.positions[0].id,
  );
  invariant(secondSnapshotPosition, 'Second order detail has no persisted recipe position');
  assert.equal(
    secondSnapshotPosition.warehouseCoverStatus,
    'needs_production',
    'Production-only approval did not persist the position route',
  );
  assert.deepEqual(
    secondSnapshotPosition.recipe?.ingredients,
    secondRecipe.version.ingredients,
    'Approved order recipe snapshot differs from the selected immutable recipe version',
  );
  await waitForApiIdle(commercialDiagnostics);
  assertDiagnosticsClean(commercialDiagnostics, warehouseDiagnostics);
  checkpoint(7, 'rotated second UUID, approved route and immutable 60/40 recipe snapshot');

  await assertAccessMatrix(sessions, baseMaterial.id);
  checkpoint(8, 'seven-role, unauthenticated and x-role-only access matrix');

  const legacySummary = await findCommercialOrder(commercialSession.token, 'A-1024');
  const legacyDetail = await apiRequest(
    `/api/commercial/orders/${encodeURIComponent(legacySummary.id)}`,
    { token: commercialSession.token },
  );
  assert.equal(legacyDetail.orderNumber, 'A-1024', 'Historical detail returned the wrong order');
  const inWorkButton = await roleSectionButton(commercialPage, 'В работе');
  if ((await inWorkButton.getAttribute('aria-current')) !== 'page') await inWorkButton.click();
  const legacyRow = commercialPage.locator(`[data-commercial-order-id="${legacySummary.id}"]`);
  await legacyRow.waitFor({ state: 'visible', timeout: 20_000 });
  await legacyRow.click();
  const legacyPanel = commercialPage.locator('.commercial-live-detail-panel');
  await waitUntil('A-1024 detail renders', async () => {
    if (!(await legacyPanel.isVisible())) return false;
    return (await legacyPanel.innerText()).includes('A-1024');
  });
  await assertNoFrameworkOverlay(commercialPage);
  await assertNoUnsafeText(commercialPage);
  await assertNoHorizontalOverflow(commercialPage, 'A-1024 at 1024x768');
  await assertSurfaceNoOverflow(legacyPanel, 'A-1024 commercial detail');
  await waitForApiIdle(commercialDiagnostics);
  assertDiagnosticsClean(commercialDiagnostics, warehouseDiagnostics);
  await commercialPage.screenshot({
    path: path.join(artifactDir, 'task13-a1024-1024x768.png'),
  });
  checkpoint(9, 'safe historical A-1024 render without overlays or raw diagnostics');

  assert.equal(intentional503.served, 1, 'Synthetic 503 count changed');
  assert.equal(intentional503.observed, 1, 'Synthetic 503 observation count changed');
  assert.equal(
    intentional503.consoleObserved,
    1,
    'Synthetic 503 console observation count changed',
  );
  assert.equal(checkpoints.length, 9, 'Not all nine checkpoints completed');
  console.log(
    [
      'PASS commercial recipe catalog live smoke',
      `schema=${schemaName}`,
      `checkpoints=${checkpoints.map((item) => item.number).join(',')}`,
      `artifacts=${artifactDir}`,
    ].join('\n'),
  );
}

const signalHandlers = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  const handler = () => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error(`Smoke interrupted by ${signal}`));
    }
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

let primaryError = null;
try {
  await runWorkflow();
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
}

const cleanupErrors = await cleanup();
for (const [signal, handler] of signalHandlers) process.off(signal, handler);
if (!primaryError && abortController.signal.aborted) {
  primaryError =
    abortController.signal.reason instanceof Error
      ? abortController.signal.reason
      : new Error('Smoke interrupted');
}

if (primaryError && cleanupErrors.length > 0) {
  throw new AggregateError(
    [primaryError, ...cleanupErrors],
    `${primaryError.message}; cleanup also failed`,
    { cause: primaryError },
  );
}
if (primaryError) throw primaryError;
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, 'Smoke cleanup failed');
}
