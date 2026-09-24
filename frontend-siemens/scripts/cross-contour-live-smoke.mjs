import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { build as viteBuild } from 'vite';

import { createBusinessPerformanceLiveSmoke } from './business-performance-live-smoke.mjs';

const frontendDir = process.cwd();
const frontendWorktreeName = path.basename(path.dirname(frontendDir));
const ancestors = [];
for (let current = frontendDir; ; current = path.dirname(current)) {
  ancestors.push(current);
  if (path.dirname(current) === current) break;
}
const backendCandidates = [
  process.env.PLENKA_BACKEND_DIR,
  ...ancestors.flatMap((root) => [
    path.join(root, '.worktrees', 'vps-test-ready'),
    path.join(root, '.worktrees', frontendWorktreeName),
    root,
  ]),
].filter(Boolean);
const backendDir = backendCandidates.find((candidate) => {
  const manifest = path.join(candidate, 'package.json');
  return existsSync(manifest) && readFileSync(manifest, 'utf8').includes('"name": "plenka-cover"');
});
if (!backendDir) {
  throw new Error(`Backend repository was not found. Checked: ${backendCandidates.join(', ')}`);
}

const apiPort = Number(process.env.CROSS_CONTOUR_SMOKE_API_PORT ?? 3022);
const webPort = Number(process.env.CROSS_CONTOUR_SMOKE_WEB_PORT ?? 5202);
const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const baseDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://plenka:plenka@127.0.0.1:5433/plenka?schema=public';
const runId = `${Date.now()}-${process.pid}`;
const smokeSchema = `cross_contour_live_${runId.replaceAll('-', '_')}`;
const rawPayloadCanary = `RAW_PAYLOAD_MUST_NOT_LEAK_${runId}`;
const plannedWeightError =
  'Введите вес от 0,001 до 100 000 кг, не более трёх знаков после запятой.';
const roleSafeBusinessCodeCases = [
  ['received', 'Принят складом'],
  ['receiving scan', 'Приёмка по QR'],
  ['production_handover', 'Передан из производства'],
  ['audit:warehouse_pallet_roll_selected', 'Рулон добавлен в палетный лист'],
  ['audit:warehouse pallet roll deselected', 'Рулон исключён из палетного листа'],
  ['manual_deselection', 'Исключён вручную'],
];
const unknownRoleSafeBusinessCode = 'new_internal_backend_code';
const databaseUrlObject = new URL(baseDatabaseUrl);
databaseUrlObject.searchParams.set('schema', smokeSchema);
const databaseUrl = databaseUrlObject.toString();
const adminDatabaseUrlObject = new URL(baseDatabaseUrl);
adminDatabaseUrlObject.searchParams.set('schema', 'public');
const adminDatabaseUrl = adminDatabaseUrlObject.toString();
const password = process.env.SEED_PASSWORD ?? 'plenka-dev';
const smokeEnvironment = {
  ...process.env,
  APP_ENV: process.env.APP_ENV ?? 'test',
  SEED_PROFILE: process.env.SEED_PROFILE ?? 'demo',
  GATEWAY_SIMULATOR: process.env.GATEWAY_SIMULATOR ?? 'on',
  GATEWAY_STALE_AFTER_SEC: process.env.GATEWAY_STALE_AFTER_SEC ?? '3600',
  GATEWAY_OFFLINE_AFTER_SEC: process.env.GATEWAY_OFFLINE_AFTER_SEC ?? '7200',
  DEVICE_GATEWAY_PRINTER: process.env.DEVICE_GATEWAY_PRINTER ?? 'on',
  DEVICE_GATEWAY_SCALE: process.env.DEVICE_GATEWAY_SCALE ?? 'on',
  PALLET_LABEL_PROFILE: process.env.PALLET_LABEL_PROFILE ?? 'pallet-100x100-extended-v6',
  WAREHOUSE_COVERAGE_V2_ENABLED: process.env.WAREHOUSE_COVERAGE_V2_ENABLED ?? 'true',
};
const outputDir = path.resolve(frontendDir, 'output/playwright/cross-contour-live', runId);
const roleSafePresentationAssetName = `cross-contour-cd1-${runId.replaceAll('-', '_')}`;
const roleSafePresentationAssetPath = path.join(
  frontendDir,
  'dist/assets',
  `${roleSafePresentationAssetName}.js`,
);
const children = [];
const checkpoints = [];
const backendRequire = createRequire(path.join(backendDir, 'package.json'));
const { PrismaClient } = backendRequire('@prisma/client');
const { GATEWAY_CAPABILITIES, GATEWAY_PROTOCOL_VERSION } = backendRequire('@plenka/contracts');
const { WAREHOUSE_COVERAGE_POLICY_VERSION, canonicalizeRollCoverageSpec, fingerprintRollFact } =
  backendRequire('./apps/api/dist/modules/warehouse-coverage/warehouse-coverage-canonical.js');

const roleConfig = {
  commercial: { login: 'коммерция', serverRole: 'commercial', section: 'Входящие заявки' },
  finance: { login: 'бухгалтерия', serverRole: 'finance', section: 'Счета' },
  production: { login: 'производство', serverRole: 'production_lead', section: 'Заказ-наряды' },
  operator: { login: 'ахметов булат', serverRole: 'operator', section: 'Рулоны и заказы' },
  warehouse: { login: 'склад', serverRole: 'warehouse', section: 'Все рулоны' },
  director: { login: 'директор', serverRole: 'director', section: 'Контроль' },
  admin: { login: 'админ', serverRole: 'admin', section: 'Инциденты' },
};
const actorConfig = {
  ...Object.fromEntries(
    Object.entries(roleConfig).map(([role, config]) => [role, { ...config, uiRole: role }]),
  ),
  operatorB: {
    login: 'хабибулин руслан',
    uiRole: 'operator',
    serverRole: 'operator',
    section: 'Рулоны и заказы',
  },
  adminB: {
    login: 'admin2',
    uiRole: 'admin',
    serverRole: 'admin',
    section: 'Инциденты',
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function builtAssetSnapshot() {
  const indexPath = path.join(frontendDir, 'dist/index.html');
  assert(existsSync(indexPath), 'Frontend dist/index.html is missing; run npm run build first');
  const index = readFileSync(indexPath, 'utf8');
  const match = index.match(/(?:src|href)="\/?(assets\/[^"?]+\.js)"/u);
  assert(match, 'Frontend build did not expose one hashed JavaScript entry asset');
  const assetPath = path.join(frontendDir, 'dist', match[1]);
  assert(existsSync(assetPath), `Frontend built JavaScript asset is missing: ${match[1]}`);
  const body = readFileSync(assetPath);
  return {
    relativePath: match[1],
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    modifiedAtMs: statSync(assetPath).mtimeMs,
  };
}

async function buildRoleSafePresentationAsset() {
  const entryPath = path.join(outputDir, `${roleSafePresentationAssetName}.mjs`);
  writeFileSync(
    entryPath,
    `export { visibleBusinessCodeLabel } from ${JSON.stringify(path.join(frontendDir, 'src/domain/displayContracts.ts'))};\n`,
  );
  await viteBuild({
    root: frontendDir,
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      outDir: path.join(frontendDir, 'dist/assets'),
      target: 'es2022',
      minify: true,
      sourcemap: false,
      lib: {
        entry: entryPath,
        formats: ['es'],
        fileName: () => `${roleSafePresentationAssetName}.js`,
      },
    },
  });
  assert(
    existsSync(roleSafePresentationAssetPath),
    `CD-1 built presentation asset is missing: ${roleSafePresentationAssetPath}`,
  );
  const body = readFileSync(roleSafePresentationAssetPath);
  return {
    absolutePath: roleSafePresentationAssetPath,
    url: `/assets/${roleSafePresentationAssetName}.js`,
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
  };
}

async function browserEntrySnapshot(page) {
  const resource = await page.evaluate(async () => {
    const script = document.querySelector('script[type="module"][src]');
    if (!(script instanceof HTMLScriptElement)) throw new Error('Module entry script is missing');
    const response = await fetch(script.src, { cache: 'reload' });
    return {
      url: new URL(script.src).pathname,
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      etag: response.headers.get('etag'),
      body: await response.text(),
      serviceWorkerControlled: navigator.serviceWorker?.controller !== null,
      serviceWorkerRegistrations: navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0,
      cacheKeys: 'caches' in window ? await caches.keys() : [],
    };
  });
  return {
    ...resource,
    sha256: createHash('sha256').update(resource.body).digest('hex'),
    bytes: Buffer.byteLength(resource.body),
    body: undefined,
  };
}

async function enableIsolatedSimulatedTopology(postCodes) {
  assert(
    smokeSchema.startsWith('cross_contour_live_'),
    'Simulator topology may only be enabled in the owned smoke schema',
  );
  await prisma.$transaction(async (tx) => {
    const posts = await tx.post.findMany({
      where: { code: { in: postCodes } },
      include: { devices: { where: { isEnabled: true } } },
      orderBy: { code: 'asc' },
    });
    assert(posts.length === postCodes.length, 'Simulated smoke post topology is incomplete');
    for (const post of posts) {
      for (const kind of ['scale', 'printer', 'scanner']) {
        assert(
          post.devices.filter((device) => device.kind === kind).length === 1,
          `${post.code} must have exactly one enabled ${kind} in the smoke schema`,
        );
      }
    }
    const now = new Date();
    await tx.post.updateMany({
      where: { id: { in: posts.map((post) => post.id) } },
      data: {
        commissioningState: 'commissioned',
        commissionedAt: now,
        agentStatus: 'online',
        lastSeenAt: now,
        agentProtocolVersion: GATEWAY_PROTOCOL_VERSION,
        agentPackageVersion: 'cross-contour-simulated',
        agentReleaseCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        agentCapabilities: [...GATEWAY_CAPABILITIES],
        agentCompatibility: 'compatible',
      },
    });
    await tx.deviceRuntime.updateMany({
      where: { id: { in: posts.flatMap((post) => post.devices.map((device) => device.id)) } },
      data: { status: 'ready', lastSeenAt: now, lastProbeAt: now },
    });
  });
}

function start(command, args, options) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: false,
    ...options,
  });
  child.output = '';
  const collect = (chunk) => {
    child.output = `${child.output}${chunk}`.slice(-16_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push(child);
  return child;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options,
    });
    let output = '';
    const collect = (chunk) => {
      output = `${output}${chunk}`.slice(-16_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${output}`)),
    );
  });
}

function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          const force = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), 3_000);
          child.once('exit', () => {
            clearTimeout(force);
            resolve();
          });
          signalProcessGroup(child, 'SIGTERM');
        }),
    ),
  );
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

async function waitForHttp(url, label, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${label} stopped before startup\n${child.output}`);
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

async function apiRequest(pathname, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${method} ${pathname} returned ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function gatewayRequest(pathname, agentToken, body) {
  return apiRequest(pathname, {
    method: 'POST',
    headers: { 'x-agent-token': agentToken },
    body,
  });
}

async function waitUntil(label, predicate, timeout = 8_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeout) {
    try {
      if (await predicate()) {
        const elapsedMs = Date.now() - startedAt;
        checkpoints.push({ label, elapsedMs });
        console.log(`CHECKPOINT ${label} ${elapsedMs}ms`);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `${label} was not visible within ${timeout}ms${lastError ? `: ${lastError}` : ''}`,
  );
}

async function focusRefresh(page) {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

async function refreshRolePage(page) {
  const explicitRefresh = page.getByRole('button', {
    name: 'Обновить данные вкладки',
    exact: true,
  });
  if ((await explicitRefresh.count()) === 0) {
    await focusRefresh(page);
    return;
  }
  await waitUntil('director explicit refresh is ready', () => explicitRefresh.isEnabled());
  await explicitRefresh.click();
  await waitUntil('director explicit refresh completed', () => explicitRefresh.isEnabled());
}

async function awaitTwoAnimationFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
}

function waitForRequestBodyOrAbort(page, request, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const cleanup = () => {
      clearTimeout(timeoutId);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onResponse = async (response) => {
      if (response.request() !== request) return;
      if (!response.ok()) {
        fail(new Error(`${label} returned HTTP ${response.status()}`));
        return;
      }
      try {
        const failure = await response.finished();
        finish(failure ? 'aborted' : 'finished');
      } catch {
        // An abort after response headers is reported through requestfailed.
      }
    };
    const onRequestFailed = (failedRequest) => {
      if (failedRequest === request) finish('aborted');
    };
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);
    timeoutId = setTimeout(
      () => fail(new Error(`${label} did not finish or abort within 8000ms`)),
      8_000,
    );
  });
}

async function waitForBodyText(page, text, label) {
  await focusRefresh(page);
  try {
    await waitUntil(label, async () => (await page.locator('body').innerText()).includes(text));
  } catch (error) {
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 1_200);
    throw new Error(`${label} failed at ${page.url()}; body: ${body}`, { cause: error });
  }
}

async function verifyRoleSafeBusinessCodePresentation(pages, rollCode) {
  assert(roleSafeBusinessCodeCases.length === 6, 'CD-1 bounded mapping matrix is incomplete');
  await openTopNavigationSection(pages.director, 'Аудит / QR');
  const traceability = pages.director.locator('.director-qr-surface');
  await traceability.getByLabel('QR, номер или название').fill(rollCode);
  await traceability.getByRole('button', { name: 'Найти', exact: true }).click();
  await waitUntil('CD-1 director renders canonical traceability labels', async () => {
    const context = traceability.locator('.director-traceability-context');
    if ((await context.count()) !== 1) return false;
    const text = await context.innerText();
    return text.includes('Передан из производства') && text.includes('Принят складом');
  });

  assert(roleSafePresentationAsset, 'CD-1 built presentation asset was not prepared');
  for (const actor of ['commercial', 'director', 'warehouse']) {
    const page = pages[actor];
    await focusRefresh(page);
    const presentation = await page.evaluate(
      async ({ assetUrl, cases, unknownCode, actorName }) => {
        const response = await fetch(assetUrl, { cache: 'reload' });
        const body = await response.text();
        const { visibleBusinessCodeLabel } = await import(assetUrl);
        const mapped = cases.map(([code]) => visibleBusinessCodeLabel(code));
        const unknown = visibleBusinessCodeLabel(unknownCode);
        const rendered = document.createElement('output');
        rendered.dataset.cd1PresentationSeam = actorName;
        rendered.style.cssText =
          'position:fixed;inset:8px auto auto 8px;z-index:2147483647;white-space:pre-line;background:white;color:black;padding:8px';
        rendered.textContent = [...mapped, unknown].join('\n');
        document.body.append(rendered);
        return {
          status: response.status,
          cacheControl: response.headers.get('cache-control'),
          etag: response.headers.get('etag'),
          body,
          mapped,
          unknown,
        };
      },
      {
        assetUrl: roleSafePresentationAsset.url,
        cases: roleSafeBusinessCodeCases,
        unknownCode: unknownRoleSafeBusinessCode,
        actorName: actor,
      },
    );
    const expectedLabels = roleSafeBusinessCodeCases.map(([, label]) => label);
    assert(
      presentation.status === 200 &&
        presentation.cacheControl?.includes('no-cache') &&
        Boolean(presentation.etag) &&
        createHash('sha256').update(presentation.body).digest('hex') ===
          roleSafePresentationAsset.sha256 &&
        Buffer.byteLength(presentation.body) === roleSafePresentationAsset.bytes &&
        JSON.stringify(presentation.mapped) === JSON.stringify(expectedLabels) &&
        presentation.unknown === 'Неизвестное событие',
      `CD-1 ${actor} built runtime violated the bounded RU presentation: ${JSON.stringify({
        ...presentation,
        body: undefined,
      })}`,
    );
    const renderedPresentation = page.locator(`[data-cd1-presentation-seam="${actor}"]`);
    await renderedPresentation.waitFor({ state: 'visible', timeout: 5_000 });
    assert(
      (await renderedPresentation.innerText()).split('\n').join('|') ===
        [...expectedLabels, 'Неизвестное событие'].join('|'),
      `CD-1 ${actor} did not render the exact bounded RU matrix`,
    );
    const visibleText = await page.locator('body').innerText();
    const leakedCodes = [
      ...roleSafeBusinessCodeCases.map(([code]) => code),
      unknownRoleSafeBusinessCode,
    ].filter((code) => visibleText.includes(code));
    assert(
      leakedCodes.length === 0,
      `CD-1 ${actor} DOM leaked raw business codes: ${leakedCodes.join(', ')}`,
    );
    await renderedPresentation.evaluate((element) => element.remove());
  }
  checkpoints.push({ label: 'CD-1 bounded RU mapping and fail-closed role DOMs', elapsedMs: 0 });
  console.log('CHECKPOINT CD-1 bounded RU mapping and fail-closed role DOMs 0ms');
}

async function waitForControl(page, notificationTitle, objectId, label, { open = false } = {}) {
  await refreshRolePage(page);
  const trigger = page.locator('[aria-label^="Контроль:"]');
  await trigger.click();
  const panel = page.locator('.notification-panel');
  await panel.waitFor({ state: 'visible' });
  let card = panel.locator('.notification-card').filter({ hasText: notificationTitle });
  if (objectId !== null) card = card.filter({ hasText: `Объект: ${objectId}` });
  card = card.first();
  try {
    await waitUntil(label, async () => (await card.count()) === 1 && (await card.isVisible()));
  } catch (error) {
    const text = (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 2_000);
    throw new Error(
      `${label} missing Control title=${notificationTitle} object=${objectId}; panel: ${text}`,
      { cause: error },
    );
  }
  if (open) {
    await card.getByRole('button', { name: 'Открыть', exact: true }).click();
    await panel.waitFor({ state: 'detached' });
  } else {
    await panel.getByRole('button', { name: 'Закрыть уведомления' }).click();
  }
}

async function openControlPanel(page) {
  await refreshRolePage(page);
  const trigger = page.locator('[aria-label^="Контроль:"]');
  await trigger.click();
  const panel = page.locator('.notification-panel');
  await panel.waitFor({ state: 'visible' });
  return panel;
}

async function assertControlAbsent(page, objectId, label) {
  const panel = await openControlPanel(page);
  const matchingCards = panel.locator('.notification-card').filter({ hasText: objectId });
  assert((await matchingCards.count()) === 0, `${label}: unexpected notification for ${objectId}`);
  await panel.getByRole('button', { name: 'Закрыть уведомления' }).click();
  checkpoints.push({ label, elapsedMs: 0 });
  console.log(`CHECKPOINT ${label} 0ms`);
}

async function loadCompleteControlPanel(page, label, expectedUnreadCount) {
  const panel = await openControlPanel(page);
  if (expectedUnreadCount !== undefined) {
    await waitUntil(`${label} server unread total`, async () =>
      (await panel.innerText()).includes(`${expectedUnreadCount} непрочитано`),
    );
  }
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const pagination = panel.locator('.notification-pagination');
    if ((await pagination.count()) === 0) return panel;
    const loadMore = pagination.getByRole('button', { name: 'Показать ещё', exact: true });
    await loadMore.waitFor({ state: 'visible' });
    const previousCount = await panel.locator('.notification-card').count();
    await loadMore.click();
    await waitUntil(`${label} page ${pageIndex + 2}`, async () => {
      const nextCount = await panel.locator('.notification-card').count();
      return nextCount > previousCount || (await pagination.count()) === 0;
    });
  }
  throw new Error(`${label}: notification pagination exceeded the safety bound`);
}

async function markControlCardRead(page, title, objectId, label) {
  const panel = await openControlPanel(page);
  const card = panel
    .locator('.notification-card')
    .filter({ hasText: title })
    .filter({ hasText: `Объект: ${objectId}` });
  await waitUntil(label, async () => (await card.count()) === 1 && (await card.isVisible()));
  const read = card.getByRole('button', { name: 'Прочитано', exact: true });
  await read.click();
  await waitUntil(`${label} marked`, async () => (await read.count()) === 0);
  await panel.getByRole('button', { name: 'Закрыть уведомления' }).click();
}

async function openControlByTitle(page, title, label) {
  const panel = await openControlPanel(page);
  const card = panel.locator('.notification-card').filter({ hasText: title }).first();
  await waitUntil(label, async () => (await card.count()) === 1 && (await card.isVisible()));
  await card.getByRole('button', { name: 'Открыть', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
}

async function openProblemControl(page, title, problemId, rollCode, label) {
  await waitForControl(page, title, problemId, label, { open: true });
  const target = page.locator(`li[data-problem-id="${problemId}"]`);
  try {
    await waitUntil(`${label} exact route`, async () => {
      const url = new URL(page.url());
      return (
        url.searchParams.get('problem') === problemId &&
        url.searchParams.get('roll') === rollCode &&
        (await target.count()) === 1 &&
        (await target.isVisible())
      );
    });
  } catch (error) {
    const url = new URL(page.url());
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 2_000);
    throw new Error(
      `${label} route mismatch: url=${url.search}; targetCount=${await target.count()}; body=${body}`,
      { cause: error },
    );
  }
}

async function openOwnedCommercialControl(
  page,
  token,
  notificationTitle,
  orderId,
  orderNumber,
  detail,
  label,
  expectedRollCodes,
) {
  const inbox = await apiRequest('/api/commercial/notifications?limit=20', { token });
  const ownedItems = inbox.items.filter(
    (item) => item.title === notificationTitle && item.cta?.targetId === orderId,
  );
  assert(
    ownedItems.length === expectedRollCodes.length &&
      ownedItems.every((item) => item.eventType === 'audit:warehouse_roll_shipped') &&
      new Set(ownedItems.map((item) => item.rollId)).size === expectedRollCodes.length &&
      expectedRollCodes.every((rollCode) => ownedItems.some((item) => item.rollId === rollCode)),
    `Commercial inbox did not resolve ${notificationTitle} to owned order ${orderId}`,
  );

  await focusRefresh(page);
  await page.locator('[aria-label^="Контроль:"]').click();
  const panel = page.locator('.commercial-control-panel');
  await panel.waitFor({ state: 'visible' });
  const card = panel
    .locator('.notification-card')
    .filter({ has: page.getByText(notificationTitle, { exact: true }) })
    .first();
  await waitUntil(`${label} exact card`, async () => {
    return (await card.count()) === 1 && (await card.isVisible());
  });
  await card.getByRole('button', { name: 'Открыть заявку', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  await waitUntil(label, async () => {
    const text = await detail.innerText();
    return (
      new URL(page.url()).searchParams.get('object') === orderId &&
      text.includes(orderNumber) &&
      text.includes('Отгружено')
    );
  });
}

async function clickAndWait(page, buttonName, responsePredicate, scope = page) {
  const buttonLabel = buttonName instanceof RegExp ? buttonName.source : buttonName;
  const observedPosts = [];
  const observePost = (request) => {
    if (request.method() === 'POST') observedPosts.push(new URL(request.url()).pathname);
  };
  page.on('request', observePost);
  const responsePromise = page
    .waitForResponse(
      (response) => responsePredicate(response) && response.request().method() === 'POST',
      { timeout: 8_000 },
    )
    .then(
      (response) => ({ response, error: null }),
      (error) => ({ response: null, error }),
    );
  try {
    const escapedButtonName =
      typeof buttonName === 'string' ? buttonName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
    const accessibleButtonName =
      buttonName instanceof RegExp ? buttonName : new RegExp(`^${escapedButtonName}(?:\\.|$)`);
    await scope.getByRole('button', { name: accessibleButtonName }).click({ timeout: 8_000 });
    const { response, error } = await responsePromise;
    if (error || !response) throw error ?? new Error('Expected response was not observed');
    assert(response.ok(), `${buttonLabel} returned HTTP ${response.status()}`);
    return response.json().catch(() => null);
  } catch (error) {
    const availableButtons = await scope
      .getByRole('button')
      .allTextContents()
      .catch(() => []);
    throw new Error(
      `${buttonLabel} failed; available buttons: ${availableButtons.join(' | ')}; observed POSTs: ${observedPosts.join(', ')}`,
      { cause: error },
    );
  } finally {
    page.off('request', observePost);
  }
}

async function createCommercialOrder(page, fixtureName) {
  await page.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Создать заявку' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Новый контрагент', exact: true }).click();
  const counterparty = page.getByRole('dialog', { name: 'Быстро создать контрагента' });
  await counterparty.getByLabel('Название', { exact: true }).fill(fixtureName);
  await counterparty.getByLabel('ИНН', { exact: true }).fill(String(Date.now()).slice(-10));
  await counterparty.getByRole('button', { name: 'Сохранить и подставить' }).click();
  await counterparty.waitFor({ state: 'detached' });

  await dialog.getByLabel('Количество рулонов, позиция 1').fill('1');
  await dialog.getByLabel('Фактическая толщина, позиция 1').fill('80 мкм');
  await dialog.getByLabel('Бухгалтерская толщина, позиция 1').fill('78 мкм');
  await dialog.getByLabel('Ширина, мм, позиция 1').fill('1700');
  await dialog.getByLabel('Метраж, м, позиция 1').fill('275');
  await dialog.getByLabel('Тип пленки, позиция 1').selectOption({ label: 'Рукав' });
  await dialog.getByLabel('Вес, позиция 1').fill('41.2');
  await dialog.getByLabel('Бирка, позиция 1', { exact: true }).selectOption({ label: 'ГОСТ' });
  const materialSelector = dialog.getByLabel('Рецептуры, позиция 1');
  await materialSelector.selectOption({ index: 1 });
  await dialog.getByLabel('Шпуля, позиция 1').selectOption({ label: 'Тонкая' });
  await dialog
    .locator('.intake-position-card')
    .first()
    .getByRole('button', { name: 'Дублировать', exact: true })
    .click();
  await dialog.getByLabel('Вес, позиция 2').fill('37.5');

  const counterpartyCreationPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/commercial/counterparties' &&
      response.request().method() === 'POST',
  );
  const orderResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/commercial/orders' &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Создать заявку', exact: true }).click();
  const [counterpartyResponse, response] = await Promise.all([
    counterpartyCreationPromise,
    orderResponsePromise,
  ]);
  assert(
    counterpartyResponse.status() === 201,
    `Counterparty creation returned ${counterpartyResponse.status()}`,
  );
  const createdCounterparty = await counterpartyResponse.json();
  counterpartyId = createdCounterparty.id;
  assert(response.status() === 201, `Commercial order creation returned ${response.status()}`);
  return response.json();
}

async function verifyCommercialPlannedWeightBoundary(page, detail, orderId, orderNumber, token) {
  let position = detail.locator('.commercial-position-list > li').first();
  const edit = async () => {
    await position.getByRole('button', { name: 'Изменить параметры', exact: true }).click();
    const input = position.getByLabel('Плановый вес, кг', { exact: true });
    await input.waitFor({ state: 'visible', timeout: 8_000 });
    return input;
  };
  let input = await edit();
  const inputAttributes = {
    min: await input.getAttribute('min'),
    max: await input.getAttribute('max'),
    step: await input.getAttribute('step'),
  };

  const positionId = (await apiRequest(`/api/commercial/orders/${orderId}`, { token })).positions[0]
    .id;
  let expected = 41.2;
  for (const value of ['38', '37.5', '37.001']) {
    await input.fill(value);
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/commercial/orders/${orderId}/positions/${positionId}` &&
        response.request().method() === 'PATCH',
      { timeout: 8_000 },
    );
    await position.getByRole('button', { name: 'Сохранить параметры', exact: true }).click();
    const response = await responsePromise;
    assert(response.ok(), `CD-8 valid planned weight ${value} returned ${response.status()}`);
    expected = Number(value);
    await position
      .getByRole('button', { name: 'Изменить параметры', exact: true })
      .waitFor({ state: 'visible', timeout: 8_000 });
    const reloadResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/commercial/orders/${orderId}` &&
        response.request().method() === 'GET',
      { timeout: 8_000 },
    );
    await focusRefresh(page);
    assert((await reloadResponse).ok(), `CD-8 reload for ${value} failed`);
    const persisted = await apiRequest(`/api/commercial/orders/${orderId}`, { token });
    assert(
      persisted.positions.find((candidate) => candidate.id === positionId)?.plannedWeightKg ===
        expected,
      `CD-8 reload changed valid planned weight ${value}`,
    );
    input = await edit();
    assert(
      (await input.inputValue()) === value,
      `CD-8 edit prefill changed ${value} to ${await input.inputValue()}`,
    );
  }

  expectedReloads.set('commercial', (expectedReloads.get('commercial') ?? 0) + 1);
  intentionalReloadCount += 1;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page
    .locator('.app-shell[data-active-role="commercial"]')
    .waitFor({ state: 'visible', timeout: 20_000 });
  const reloadedDetail = await openCommercialOrder(page, 'Входящие заявки', orderId, orderNumber);
  position = reloadedDetail.locator('.commercial-position-list > li').first();
  input = await edit();
  assert(
    (await input.inputValue()) === '37.001',
    `CD-8 real browser reload lost exact ${orderId}/${positionId} planned weight`,
  );

  for (const value of ['0', '-1', '37.0001', '100000.001']) {
    let mutationCalls = 0;
    const countMutation = (request) => {
      if (
        request.method() === 'PATCH' &&
        new URL(request.url()).pathname ===
          `/api/commercial/orders/${orderId}/positions/${positionId}`
      ) {
        mutationCalls += 1;
      }
    };
    page.on('request', countMutation);
    try {
      await input.fill(value);
      await position.getByRole('button', { name: 'Сохранить параметры', exact: true }).click();
      const alert = position.getByRole('alert');
      await alert.waitFor({ state: 'visible', timeout: 2_000 });
      assert(
        (await alert.innerText()) === plannedWeightError,
        `CD-8 invalid ${value} rendered the wrong RU error: ${await alert.innerText()}`,
      );
      assert(mutationCalls === 0, `CD-8 invalid ${value} reached the PATCH API`);
      const unchanged = await apiRequest(`/api/commercial/orders/${orderId}`, { token });
      assert(
        unchanged.positions.find((candidate) => candidate.id === positionId)?.plannedWeightKg ===
          expected,
        `CD-8 invalid ${value} mutated the canonical API value`,
      );
    } finally {
      page.off('request', countMutation);
    }
  }
  await position.getByRole('button', { name: 'Отмена', exact: true }).click();
  return inputAttributes;
}

async function openCommercialOrder(page, section, orderId, orderNumber) {
  await focusRefresh(page);
  const roleNavigation = page.locator('.role-nav');
  const sectionButton = roleNavigation.getByRole('button', { name: section, exact: true });
  if ((await sectionButton.getAttribute('aria-current')) !== 'page') await sectionButton.click();
  const row = page.locator(`[data-commercial-order-id="${orderId}"]`);
  await waitUntil(`commercial ${section} contains ${orderNumber}`, async () => {
    return (await row.count()) === 1 && (await row.isVisible());
  });
  await row.click();
  const detail = page.locator('.commercial-live-detail-panel');
  await waitUntil(`commercial ${section} selects ${orderNumber}`, async () => {
    return (await detail.innerText()).includes(orderNumber);
  });
  return detail;
}

async function openFinanceOrder(page, orderNumber) {
  const selectedDetail = page
    .locator('article.detail-view')
    .filter({ hasText: orderNumber })
    .filter({ has: page.locator('.finance-selected-command') })
    .first();
  const row = page.locator('.finance-ledger-row').filter({ hasText: orderNumber }).first();
  await waitUntil(`finance selects ${orderNumber}`, async () => {
    if ((await selectedDetail.count()) === 1 && (await selectedDetail.isVisible())) return true;
    if ((await row.count()) !== 1 || !(await row.isVisible())) return false;
    await row.click();
    return false;
  });
}

async function openOperatorRoll(page, rollCode) {
  await focusRefresh(page);
  const row = page.getByRole('row', { name: `Открыть рулон ${rollCode}` }).first();
  await waitUntil(`operator hub selects ${rollCode}`, async () => {
    return (await row.count()) === 1 && (await row.isVisible());
  });
  await row.click();
  const detail = page.locator('article.detail-view.role-operator').first();
  const actions = detail.locator('.operator-current-actions');
  await waitUntil(`operator detail opens ${rollCode}`, async () => {
    const url = new URL(page.url());
    return (
      url.searchParams.get('object') === rollCode &&
      (await detail.count()) === 1 &&
      (await detail.isVisible()) &&
      (await actions.count()) === 1 &&
      (await actions.isVisible())
    );
  });
  return actions;
}

async function openOperatorShift(page, expectedBigBagCode) {
  const roleNavigation = page.locator('.role-top-nav');
  await roleNavigation.getByRole('button', { name: 'Смена', exact: true }).click();
  const shiftSurface = page.locator('.operator-shift-panel');
  await shiftSurface.waitFor({ state: 'visible', timeout: 8_000 });
  let selectedBigBag = null;
  if (!(await shiftSurface.innerText()).includes('Смена открыта')) {
    const availableBag = shiftSurface
      .locator('[role="option"]:not([disabled])')
      .filter({ hasText: expectedBigBagCode })
      .first();
    const bagText = await availableBag.innerText();
    await availableBag.click();
    const startWeight = shiftSurface.getByLabel('Стартовый вес Big-bag', { exact: true });
    assert(
      (await startWeight.inputValue()) === '5000',
      `OP-1 expected the selected canonical BigBag to prefill 5000 kg: ${bagText}`,
    );
    selectedBigBag = { code: bagText.split('\n')[0], startKg: 5_000 };
    await clickAndWait(
      page,
      'Открыть смену',
      (response) => new URL(response.url()).pathname.endsWith('/operator/shift/open'),
      shiftSurface,
    );
    await waitUntil('operator shift opens through UI', async () => {
      return (await shiftSurface.innerText()).includes('Смена открыта');
    });
  }
  await roleNavigation.getByRole('button', { name: 'Рулоны и заказы', exact: true }).click();
  return selectedBigBag;
}

async function openTopNavigationSection(page, section) {
  const candidates = page
    .locator(
      '.section-nav-button, .role-top-nav-item, .mobile-section-nav-item:not(.mobile-section-nav-more)',
    )
    .filter({ hasText: section });
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) {
      await candidate.click();
      return;
    }
  }

  const navigation = page.locator('.role-top-nav');
  const more = navigation.getByRole('button', { name: /^Еще разделы:/u });
  if ((await more.count()) !== 1 || !(await more.isVisible())) {
    const available = await page
      .locator(
        '.section-nav-button, .role-top-nav-item, .mobile-section-nav-item:not(.mobile-section-nav-more)',
      )
      .allTextContents();
    throw new Error(
      `Navigation section "${section}" is unavailable; visible sections: ${available.join(' | ')}`,
    );
  }
  await more.click();
  const drawer = page.locator('.mobile-nav-drawer[role="dialog"]');
  await drawer.waitFor({ state: 'visible', timeout: 5_000 });
  await drawer.getByRole('button', { name: section, exact: true }).click();
}

async function openBusinessProductionRolls(page, orderNumber, { refresh = true } = {}) {
  await openTopNavigationSection(page, 'Производство');
  if (refresh) await refreshRolePage(page);
  const workspace = page.locator('.commercial-performance-workspace');
  await waitUntil(`business Production loads ${orderNumber}`, async () => {
    if ((await workspace.count()) !== 1 || !(await workspace.isVisible())) return false;
    return (await workspace.innerText()).includes(orderNumber);
  });
  const toggle = workspace
    .locator('.production-roll-drilldown-toggle')
    .filter({ hasText: orderNumber })
    .first();
  await toggle.waitFor({ state: 'visible', timeout: 8_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const table = workspace.locator('.production-roll-drilldown-table');
  await table.waitFor({ state: 'visible', timeout: 8_000 });
  return { workspace, toggle, table };
}

async function businessPerformanceControls(workspace) {
  return {
    from: await workspace.getByLabel('Дата с', { exact: true }).inputValue(),
    to: await workspace.getByLabel('Дата по', { exact: true }).inputValue(),
    grouping: await workspace.getByLabel('Группировка', { exact: true }).inputValue(),
  };
}

async function ownedRollDomOrder(table, rolls) {
  const texts = await table.locator('.production-roll-drilldown-item').allTextContents();
  return texts
    .map((text) => rolls.find((candidate) => text.includes(candidate.rollCode))?.rollCode ?? null)
    .filter(Boolean);
}

async function assertBusinessProductionLifecycle({
  pages,
  sessions,
  productionOrderId,
  orderNumber,
  rolls,
  lifecycleStatus,
  label,
}) {
  const rollPath =
    `/api/commercial/performance/production/${encodeURIComponent(productionOrderId)}` +
    '/rolls?limit=100';
  const [commercialRolls, directorRolls, productionOrders] = await Promise.all([
    apiRequest(rollPath, { token: sessions.commercial.token }),
    apiRequest(rollPath, { token: sessions.director.token }),
    apiRequest('/api/production/orders', { token: sessions.production.token }),
  ]);
  for (const [role, snapshot] of [
    ['commercial', commercialRolls],
    ['director', directorRolls],
  ]) {
    const owned = snapshot.items.filter((item) =>
      rolls.some((candidate) => candidate.rollCode === item.rollCode),
    );
    assert(
      owned.length === 2 &&
        new Set(owned.map((item) => item.id)).size === 2 &&
        new Set(owned.map((item) => item.rollCode)).size === 2 &&
        rolls.every((candidate) =>
          owned.some(
            (item) =>
              item.id === candidate.id &&
              item.rollCode === candidate.rollCode &&
              item.lifecycleStatus === lifecycleStatus,
          ),
        ),
      `CD-7 ${role} ${label} lifecycle is not exact: ${JSON.stringify(owned)}`,
    );
  }
  assert(
    JSON.stringify(commercialRolls) === JSON.stringify(directorRolls),
    `CD-7 ${label} differs between commercial and director`,
  );
  const productionOrder = productionOrders.find((item) => item.id === productionOrderId);
  const expectedWarehouseState = {
    warehouse_handed_off: 'sent',
    warehouse_accepted: 'received',
    warehouse_delivered: 'delivered',
  }[lifecycleStatus];
  assert(expectedWarehouseState, `Unsupported production lifecycle ${lifecycleStatus}`);
  assert(
    productionOrder?.dispatchItems.length === 2 &&
      new Set(productionOrder.dispatchItems.map((item) => item.id)).size === 2 &&
      rolls.every((candidate) =>
        productionOrder.dispatchItems.some(
          (item) =>
            item.id === candidate.id &&
            item.rollCode === candidate.rollCode &&
            item.operatorLine?.warehouseState === expectedWarehouseState,
        ),
      ),
    `CD-7 production ${label} snapshot is not exact: ${JSON.stringify(productionOrder)}`,
  );

  for (const [role, page] of [
    ['commercial', pages.commercial],
    ['director', pages.director],
  ]) {
    const { table } = await openBusinessProductionRolls(page, orderNumber);
    const rows = table.locator('.production-roll-drilldown-item');
    await waitUntil(`CD-7 ${role} renders ${label}`, async () =>
      Promise.all(
        rolls.map(async (candidate) => {
          const exact = rows.filter({ hasText: candidate.rollCode });
          return (await exact.count()) === 1 && (await exact.innerText()).includes(label);
        }),
      ).then((states) => states.every(Boolean)),
    );
    const ownedRows = await Promise.all(
      rolls.map((candidate) => rows.filter({ hasText: candidate.rollCode }).innerText()),
    );
    assert(new Set(ownedRows).size === 2, `CD-7 ${role} collapsed two roll identities`);
  }
  return { rollPath, commercialRolls };
}

async function verifyDirectorProductionManualRefresh({ page, orderNumber, rollPath, rolls }) {
  let { workspace, toggle, table } = await openBusinessProductionRolls(page, orderNumber);
  const from = workspace.getByLabel('Дата с', { exact: true });
  const to = workspace.getByLabel('Дата по', { exact: true });
  const grouping = workspace.getByLabel('Группировка', { exact: true });
  const initialControls = await businessPerformanceControls(workspace);
  const selectedControls = {
    from: initialControls.to,
    to: initialControls.to,
    grouping: 'week',
  };
  assert(
    initialControls.from !== selectedControls.from &&
      initialControls.grouping !== selectedControls.grouping,
    `CD-3 controls were not changed from canonical defaults: ${JSON.stringify(initialControls)}`,
  );
  const selectedProductionResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/commercial/performance/production' &&
        url.searchParams.get('from') === selectedControls.from &&
        url.searchParams.get('to') === selectedControls.to &&
        response.request().method() === 'GET'
      );
    },
    { timeout: 8_000 },
  );
  await from.fill(selectedControls.from);
  await to.fill(selectedControls.to);
  await grouping.selectOption(selectedControls.grouping);
  await workspace.getByRole('button', { name: 'Применить', exact: true }).click();
  const selectedProductionResult = await selectedProductionResponse;
  assert(
    selectedProductionResult.ok(),
    `CD-3 selected-range request returned ${selectedProductionResult.status()}`,
  );
  const selectedProductionFailure = await selectedProductionResult.finished();
  assert(
    !selectedProductionFailure,
    `CD-3 selected-range body failed: ${selectedProductionFailure}`,
  );
  await awaitTwoAnimationFrames(page);
  const selectedRollResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === new URL(`${apiBase}${rollPath}`).pathname &&
      response.request().method() === 'GET',
    { timeout: 8_000 },
  );
  ({ workspace, toggle, table } = await openBusinessProductionRolls(page, orderNumber, {
    refresh: false,
  }));
  const selectedRollResult = await selectedRollResponse;
  assert(
    selectedRollResult.ok(),
    `CD-3 selected-range roll request returned ${selectedRollResult.status()}`,
  );
  const selectedRollFailure = await selectedRollResult.finished();
  assert(!selectedRollFailure, `CD-3 selected-range roll body failed: ${selectedRollFailure}`);
  const controlsAfterApply = await businessPerformanceControls(workspace);
  assert(
    JSON.stringify(controlsAfterApply) === JSON.stringify(selectedControls),
    `CD-3 failed to apply non-default controls: ${JSON.stringify(controlsAfterApply)}`,
  );

  const stableRow = table
    .locator('.production-roll-drilldown-item')
    .filter({ hasText: rolls[0].rollCode });
  await waitUntil(
    'CD-3 stable director roll row is exact after applying filters',
    async () => (await stableRow.count()) === 1,
  );
  await toggle.focus();
  await toggle.scrollIntoViewIfNeeded();
  await page.evaluate((order) => {
    const candidate = [...document.querySelectorAll('.production-roll-drilldown-toggle')].find(
      (element) => element.textContent?.includes(order),
    );
    const row = [...document.querySelectorAll('.production-roll-drilldown-item')].find((element) =>
      element.textContent?.includes(order),
    );
    window.__crossContourCd3 = {
      toggle: candidate,
      row,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      shifts: [],
    };
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput && entry.value > 0)
          window.__crossContourCd3.shifts.push(entry.value);
      }
    });
    observer.observe({ type: 'layout-shift', buffered: false });
    window.__crossContourCd3.observer = observer;
  }, orderNumber);

  let productionRequests = 0;
  let rollRequests = 0;
  const countRequest = (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') return;
    const isRoll = url.pathname === new URL(`${apiBase}${rollPath}`).pathname;
    const isProduction = url.pathname === '/api/commercial/performance/production';
    if (!isRoll && !isProduction) return;
    if (isRoll) rollRequests += 1;
    if (isProduction) productionRequests += 1;
  };
  page.on('request', countRequest);
  try {
    await focusRefresh(page);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(
      productionRequests === 0 && rollRequests === 0,
      `CD-3 director refreshed in the background: ${JSON.stringify({
        productionRequests,
        rollRequests,
      })}`,
    );

    const manualProductionResponse = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/commercial/performance/production' &&
          url.searchParams.get('from') === selectedControls.from &&
          url.searchParams.get('to') === selectedControls.to &&
          response.request().method() === 'GET'
        );
      },
      { timeout: 8_000 },
    );
    const manualRollResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === new URL(`${apiBase}${rollPath}`).pathname &&
        response.request().method() === 'GET',
      { timeout: 8_000 },
    );
    await refreshRolePage(page);
    for (const response of await Promise.all([manualProductionResponse, manualRollResponse])) {
      assert(response.ok(), `CD-3 manual refresh returned ${response.status()}`);
      const failure = await response.finished();
      assert(!failure, `CD-3 manual refresh response body failed: ${failure}`);
    }
    assert(
      productionRequests === 1 && rollRequests === 1,
      `CD-3 manual refresh request count is not exact: ${JSON.stringify({
        productionRequests,
        rollRequests,
      })}`,
    );
  } finally {
    page.off('request', countRequest);
  }
  await awaitTwoAnimationFrames(page);
  const controlsAfterManualRefresh = await businessPerformanceControls(workspace);

  const stability = await page.evaluate((order) => {
    const state = window.__crossContourCd3;
    const currentToggle = [...document.querySelectorAll('.production-roll-drilldown-toggle')].find(
      (element) => element.textContent?.includes(order),
    );
    const currentRow = [...document.querySelectorAll('.production-roll-drilldown-item')].find(
      (element) => element.textContent?.includes(order),
    );
    state.observer.disconnect();
    return {
      sameToggle: currentToggle === state.toggle,
      sameRow: currentRow === state.row,
      expanded: currentToggle?.getAttribute('aria-expanded'),
      focusOnRefresh: document.activeElement?.matches('.director-refresh-button') ?? false,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      originalScrollX: state.scrollX,
      originalScrollY: state.scrollY,
      shifts: state.shifts,
    };
  }, orderNumber);
  assert(
    stability.sameToggle &&
      stability.sameRow &&
      stability.expanded === 'true' &&
      stability.scrollX === stability.originalScrollX &&
      stability.scrollY === stability.originalScrollY &&
      stability.shifts.length === 0,
    `CD-3 director Production manual refresh was not stable: ${JSON.stringify(stability)}`,
  );
  assert(
    JSON.stringify(controlsAfterManualRefresh) === JSON.stringify(selectedControls),
    `CD-3 manual refresh changed non-default controls: ${JSON.stringify(controlsAfterManualRefresh)}`,
  );
  const rollIdentityBeforeReload = await ownedRollDomOrder(table, rolls);
  assert(
    rollIdentityBeforeReload.length === 2 && new Set(rollIdentityBeforeReload).size === 2,
    `CD-2 pre-reload roll order is not exact: ${JSON.stringify(rollIdentityBeforeReload)}`,
  );

  expectedReloads.set('director', (expectedReloads.get('director') ?? 0) + 1);
  intentionalReloadCount += 1;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page
    .locator('.app-shell[data-active-role="director"]')
    .waitFor({ state: 'visible', timeout: 20_000 });
  ({ workspace, toggle, table } = await openBusinessProductionRolls(page, orderNumber));
  const controlsAfterReload = await businessPerformanceControls(workspace);
  const rollIdentityAfterReload = await ownedRollDomOrder(table, rolls);
  const lifecycleAfterReload = await Promise.all(
    rolls.map(async (candidate) => {
      const row = table
        .locator('.production-roll-drilldown-item')
        .filter({ hasText: candidate.rollCode });
      return (await row.count()) === 1 && (await row.innerText()).includes('Принят складом');
    }),
  );
  assert(
    JSON.stringify(controlsAfterReload) === JSON.stringify(initialControls),
    `CD-3 hard reload did not restore canonical defaults: ${JSON.stringify(controlsAfterReload)}`,
  );
  assert(
    JSON.stringify(rollIdentityAfterReload) === JSON.stringify(rollIdentityBeforeReload) &&
      lifecycleAfterReload.every(Boolean),
    `CD-2 hard reload changed roll order/lifecycle: ${JSON.stringify({
      rollIdentityBeforeReload,
      rollIdentityAfterReload,
    })}`,
  );
  return {
    productionRequests,
    rollRequests,
    stability,
    initialControls,
    selectedControls,
    controlsAfterManualRefresh,
    controlsAfterReload,
    rollIdentityBeforeReload,
    rollIdentityAfterReload,
  };
}

async function verifyDelayedProductionLifecycleCannotRegress({
  page,
  orderNumber,
  rollPath,
  acceptedRolls,
  rolls,
}) {
  const { workspace, table } = await openBusinessProductionRolls(page, orderNumber);
  const staleRolls = {
    ...acceptedRolls,
    items: acceptedRolls.items.map((item) =>
      rolls.some((candidate) => candidate.rollCode === item.rollCode)
        ? { ...item, status: 'warehouse_handed_off', lifecycleStatus: 'warehouse_handed_off' }
        : item,
    ),
  };
  let routeCalls = 0;
  let staleRequest;
  let releaseStale;
  const staleReleased = new Promise((resolve) => {
    releaseStale = resolve;
  });
  let interceptStale;
  const staleIntercepted = new Promise((resolve) => {
    interceptStale = resolve;
  });
  const routePattern = `**${new URL(`${apiBase}${rollPath}`).pathname}*`;
  await page.route(routePattern, async (route) => {
    routeCalls += 1;
    if (routeCalls === 1) {
      staleRequest = route.request();
      interceptStale();
      await staleReleased;
      await route
        .fulfill({ status: 200, contentType: 'application/json', json: staleRolls })
        .catch(() => undefined);
      return;
    }
    await route.continue();
  });
  try {
    await workspace.getByRole('button', { name: 'Обновить данные вкладки', exact: true }).click();
    await staleIntercepted;
    assert(staleRequest, 'CD-7 stale supplemental request was not captured');
    const staleOutcomePromise = waitForRequestBodyOrAbort(
      page,
      staleRequest,
      'CD-7 stale supplemental response',
    );
    const newerResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === new URL(`${apiBase}${rollPath}`).pathname &&
        response.request().method() === 'GET' &&
        response.request() !== staleRequest,
      { timeout: 8_000 },
    );
    await refreshRolePage(page);
    const newerResponse = await newerResponsePromise;
    assert(newerResponse.ok(), `CD-7 newer response returned HTTP ${newerResponse.status()}`);
    const newerFailure = await newerResponse.finished();
    assert(!newerFailure, `CD-7 newer response body failed: ${newerFailure}`);
    await awaitTwoAnimationFrames(page);
    await waitUntil('CD-7 newer accepted supplemental response commits', async () =>
      Promise.all(
        rolls.map(async (candidate) => {
          const row = table
            .locator('.production-roll-drilldown-item')
            .filter({ hasText: candidate.rollCode });
          return (await row.count()) === 1 && (await row.innerText()).includes('Принят складом');
        }),
      ).then((states) => states.every(Boolean)),
    );
    releaseStale();
    const staleOutcome = await staleOutcomePromise;
    assert(
      staleOutcome === 'aborted' || staleOutcome === 'finished',
      `CD-7 stale response had an invalid outcome: ${staleOutcome}`,
    );
    await awaitTwoAnimationFrames(page);
    await waitUntil('CD-7 delayed older handover response cannot regress accepted UI', async () =>
      Promise.all(
        rolls.map(async (candidate) => {
          const row = table
            .locator('.production-roll-drilldown-item')
            .filter({ hasText: candidate.rollCode });
          return (await row.count()) === 1 && (await row.innerText()).includes('Принят складом');
        }),
      ).then((states) => states.every(Boolean)),
    );
  } finally {
    releaseStale?.();
    await page.unroute(routePattern);
  }
  assert(routeCalls >= 2, `CD-7 stale-response scenario made only ${routeCalls} roll requests`);
  return routeCalls;
}

const businessPerformanceSmoke = createBusinessPerformanceLiveSmoke({
  apiRequest,
  assert,
  focusRefresh,
  refreshRolePage,
  openTopNavigationSection,
  waitUntil,
});

async function openWarehouseTask(page, objectId, rowLabel, rollCode, label) {
  const row = page
    .locator('.warehouse-scan-station-data-table tbody tr[role="button"]')
    .filter({ has: page.getByText(rowLabel, { exact: true }) });
  try {
    await waitUntil(
      `${label} row`,
      async () => (await row.count()) === 1 && (await row.isVisible()),
    );
  } catch (error) {
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 2_000);
    throw new Error(`${label} row failed for ${objectId}; body: ${body}`, { cause: error });
  }
  await row.click();
  const detail = page.locator('.warehouse-scan-station-detail');
  await waitUntil(label, async () => {
    return (
      new URL(page.url()).searchParams.get('object') === objectId &&
      (await detail.innerText()).includes(rollCode)
    );
  });
  return detail;
}

async function issuePostpayInvoice(page) {
  await page.getByRole('button', { name: 'Выставить счёт', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'Оформить счёт вручную' });
  await wizard.waitFor({ state: 'visible', timeout: 8_000 });
  await wizard.getByPlaceholder('Например, 120000').fill('150000');
  await wizard.getByRole('button', { name: '100% через 30 дней', exact: true }).click();
  const submit = wizard.getByRole('button', { name: 'Оформить счёт', exact: true });
  await waitUntil('finance payment policy preview is ready', async () => await submit.isEnabled());
  const responsePromise = page.waitForResponse(
    (response) =>
      /\/api\/finance\/orders\/[^/]+\/invoices$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  await submit.click();
  const response = await responsePromise;
  assert(response.status() === 201, `Postpay invoice returned ${response.status()}`);
  const responsePayload = await response.json().catch(() => null);
  await waitUntil('finance invoice wizard closes after successful create', async () => {
    if ((await wizard.count()) === 0) return true;
    const alert = wizard.getByRole('alert');
    if ((await alert.count()) === 1 && (await alert.isVisible())) {
      throw new Error(
        `strict invoice client rejected the 201 response: ${await alert.innerText()}; response=${JSON.stringify(responsePayload)}`,
      );
    }
    return false;
  });
  assert((await wizard.count()) === 0, 'Finance invoice wizard remained open after client success');
}

async function screenshot(page, fileName, width, height) {
  await page.setViewportSize({ width, height });
  await page.screenshot({ path: path.join(outputDir, fileName) });
}

async function createUnifiedInventoryFixture(operatorId) {
  const material = await prisma.rawMaterialDefinition.findFirst({
    where: { status: 'active' },
    orderBy: { id: 'asc' },
    select: { id: true, name: true },
  });
  assert(material, 'Unified inventory smoke requires one active material definition');

  const orderNumber = `S-SMOKE-${runId}`;
  const batchCode = `STOCK-SMOKE-${runId}`;
  const rollCode = `STOCK-ROLL-${runId}`;
  const ingredients = [
    {
      rawMaterialDefinitionId: material.id,
      shareBasisPoints: 10_000,
    },
  ];
  const stockOrder = await prisma.commercialOrder.create({
    data: {
      orderNumber,
      title: 'Cross-contour unified inventory UI fixture',
      creatorRole: 'commercial',
      requestType: 'stock_reserve',
      stockBatchCode: batchCode,
      counterpartyId: null,
      warehouseCoverageWorkflowVersion: 1,
      productionIndicator: 'ready',
      paymentStatus: 'not_applicable',
      shipmentStatus: 'not_applicable',
      commercialStage: 'in_work',
      positions: {
        create: {
          rollCount: 1,
          filmType: 'Полотно',
          actualThickness: '70 мкм',
          accountingThickness: '70 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
          rawMaterialId: material.id,
          baseRawMaterialDefinitionId: material.id,
          spoolType: '76 мм',
          birka: 'SMOKE STOCK',
          plannedWeightKg: 37.5,
          recipe: {
            create: {
              parameters: [],
              source: 'cross_contour_smoke_fixture',
              createdBy: 'cross_contour_smoke',
              version: 'v1',
              recipeName: material.name,
              ingredients,
            },
          },
        },
      },
    },
    include: { positions: { include: { recipe: true } } },
  });
  const position = stockOrder.positions[0];
  assert(position?.recipe, 'Unified inventory smoke source position has no recipe');

  const productionOrder = await prisma.productionOrder.create({
    data: {
      commercialOrderId: stockOrder.id,
      indicator: 'ready',
      approvalState: 'approved',
    },
  });
  const dispatch = await prisma.rollDispatchItem.create({
    data: {
      rollCode,
      productionOrderId: productionOrder.id,
      orderLineId: position.id,
      positionSequence: 1,
      rawMaterialId: material.id,
      recipeVersion: position.recipe.version,
      filmType: position.filmType,
      plannedWeightKg: position.plannedWeightKg,
      assignedOperatorId: operatorId,
      status: 'done',
      completedAt: new Date(),
      characteristicsSnapshot: {
        filmType: position.filmType,
        actualThickness: position.actualThickness,
        accountingThickness: position.accountingThickness,
        widthMm: position.widthMm,
        plannedLengthM: position.plannedLengthM,
        birka: position.birka,
        spoolType: position.spoolType,
        ingredients,
        recipeId: position.recipe.id,
        recipeVersion: position.recipe.version,
      },
      operatorLine: {
        create: {
          sequence: 1,
          planKg: 37.5,
          grossKg: 39.5,
          spoolKg: 2,
          netKg: 37.5,
          toleranceOk: true,
          step: 'handed_over',
          labelState: 'verified',
          warehouseState: 'received',
        },
      },
    },
    include: { operatorLine: true },
  });
  assert(dispatch.operatorLine, 'Finished-stock smoke dispatch has no operator line');
  const capture = await prisma.weightCapture.create({
    data: {
      operatorRollLineId: dispatch.operatorLine.id,
      kind: 'roll',
      stable: true,
      grossKg: 39.5,
      spoolKg: 2,
      netKg: 37.5,
      toleranceOk: true,
      actorRole: 'operator',
      actorId: operatorId,
    },
  });
  const roll = await prisma.warehouseRoll.create({
    data: {
      rollCode,
      positionSnapshot: dispatch.characteristicsSnapshot,
      ownerCounterpartyId: null,
      producedForStockOrderId: stockOrder.id,
      warehouseStatus: 'received',
      receivedAt: new Date(),
    },
  });
  const spec = canonicalizeRollCoverageSpec({
    rollCode,
    sourceOrderId: stockOrder.id,
    sourcePositionId: position.id,
    ownerCounterpartyId: null,
    filmType: position.filmType,
    actualThicknessMilliMicron: 70_000,
    accountingThicknessMilliMicron: 70_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: position.birka,
    spoolType: position.spoolType,
    actualWeightMilliKg: 37_500,
    plannedWeightMilliKg: 37_500,
    ingredients,
    recipeId: position.recipe.id,
    recipeVersion: position.recipe.version,
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
  });
  const fact = await prisma.warehouseRollCoverageFact.create({
    data: {
      rollId: roll.id,
      version: 1,
      source: 'production_handover',
      specVersion: 'warehouse-roll-coverage/v1',
      specFingerprint: fingerprintRollFact(spec),
      spec,
      sourceOrderId: stockOrder.id,
      sourcePositionId: position.id,
      sourceDispatchItemId: dispatch.id,
      sourceWeightCaptureId: capture.id,
      actorKind: 'user',
      actorRole: 'operator',
      actorId: operatorId,
    },
  });
  await prisma.warehouseRoll.update({
    where: { id: roll.id },
    data: { currentCoverageFactId: fact.id },
  });
  return { batchCode, orderId: stockOrder.id, orderNumber, rollCode };
}

let browser;
let prisma;
let roleSafePresentationAsset = null;
let counterpartyId = null;
const contexts = [];
const navigationViolations = [];
const expectedReloads = new Map();
let intentionalReloadCount = 0;
const browserErrors = [];
const browserConsoleErrors = [];
const browserRequestErrors = [];
let expectingOperatorBShiftCloseConflict = false;
let operatorBShiftCloseConflictConsoleCount = 0;
const networkCanaryLeaks = [];
const responseInspections = [];
const obsoleteWarehousePostRequests = [];
const forbiddenWarehousePrintRequests = [];

async function dropOwnedSchema() {
  const client = prisma ?? new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } } });
  const ownsClient = client !== prisma;
  try {
    await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${smokeSchema}" CASCADE`);
  } finally {
    if (ownsClient) await client.$disconnect();
  }
}

try {
  mkdirSync(outputDir, { recursive: true });
  await Promise.all([
    assertPortAvailable(apiPort, 'Backend'),
    assertPortAvailable(webPort, 'Vite'),
  ]);
  const databaseEnvironment = {
    ...smokeEnvironment,
    DATABASE_URL: databaseUrl,
    SEED_PASSWORD: password,
  };
  await run('npm', ['run', 'db:deploy'], { cwd: backendDir, env: databaseEnvironment });
  await run('npm', ['run', 'db:seed'], { cwd: backendDir, env: databaseEnvironment });

  const backendCommit = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: backendDir });
  const frontendCommit = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: frontendDir });
  const frontendCommitEpochSeconds = Number(
    await run('git', ['log', '-1', '--format=%ct'], { cwd: frontendDir }),
  );
  const initialBuiltAsset = builtAssetSnapshot();
  assert(
    initialBuiltAsset.modifiedAtMs >= frontendCommitEpochSeconds * 1_000,
    `Built asset ${initialBuiltAsset.relativePath} predates frontend ${frontendCommit}`,
  );
  roleSafePresentationAsset = await buildRoleSafePresentationAsset();
  console.log(`BACKEND ${backendDir} ${backendCommit}`);
  console.log(`DATABASE_SCHEMA ${smokeSchema}`);
  const backend = start(process.execPath, [path.join(backendDir, 'apps/api/dist/main.js')], {
    cwd: path.join(backendDir, 'apps/api'),
    env: {
      ...smokeEnvironment,
      AUTH_DEV_XROLE: 'off',
      DATABASE_URL: databaseUrl,
      PORT: String(apiPort),
    },
  });
  await waitForHttp(`${apiBase}/api/health`, 'Backend', backend);

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  await enableIsolatedSimulatedTopology(['POST-1', 'POST-2', 'POST-5']);

  const seededAdmin = await prisma.user.findUniqueOrThrow({ where: { login: 'админ' } });
  assert(seededAdmin.passwordHash, 'Seeded admin does not have a local password hash');
  await prisma.user.create({
    data: {
      externalId: `smoke-admin-b-${runId}`,
      login: 'admin2',
      passwordHash: seededAdmin.passwordHash,
      identityProvider: seededAdmin.identityProvider,
      displayName: 'Администратор B (smoke)',
      role: 'admin',
      isActive: true,
      mustChangePassword: false,
      passwordChangedAt: seededAdmin.passwordChangedAt,
    },
  });

  const sessions = {};
  for (const [actor, config] of Object.entries(actorConfig)) {
    const login = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { login: config.login, password },
    });
    assert(login.user.role === config.serverRole, `${actor} resolved as ${login.user.role}`);
    const me = await apiRequest('/api/auth/me', { token: login.token });
    assert(me.userId === login.user.id, `${actor} session identity changed after login`);
    sessions[actor] = {
      version: 1,
      token: login.token,
      role: config.uiRole,
      serverRole: config.serverRole,
      userId: login.user.id,
      displayName: login.user.displayName,
      expiresAt: login.expiresAt,
      passwordChangeRequired: login.passwordChangeRequired,
    };
  }
  const createdBigBag = await apiRequest('/api/warehouse/big-bags', {
    token: sessions.warehouse.token,
    method: 'POST',
    body: {
      materialPreset: 'pvd_tsp',
      weightKg: 5_000,
      priceKopecksPerKg: 0,
      code: `BB-SMOKE-${runId}`,
      batchCode: `BB-BATCH-${runId}`,
      supplierName: 'Cross-contour live smoke',
    },
  });
  assert(
    createdBigBag.code === `BB-SMOKE-${runId}` && createdBigBag.currentKg === 5_000,
    `OP-1 warehouse API did not register the canonical 5000 kg BigBag: ${JSON.stringify(createdBigBag)}`,
  );
  const createdBigBagToken = await prisma.bigBagScanToken.findUniqueOrThrow({
    where: { bigBagId: createdBigBag.id },
    select: { token: true },
  });
  await apiRequest('/api/warehouse/big-bags/scans', {
    token: sessions.warehouse.token,
    method: 'POST',
    body: {
      operationKey: crypto.randomUUID(),
      qrCode: createdBigBagToken.token,
      destination: 'warehouse',
    },
  });
  const initialProductionMove = await apiRequest('/api/warehouse/big-bags/scans', {
    token: sessions.warehouse.token,
    method: 'POST',
    body: {
      operationKey: crypto.randomUUID(),
      qrCode: createdBigBagToken.token,
      destination: 'production',
    },
  });
  assert(
    initialProductionMove.bag.id === createdBigBag.id &&
      initialProductionMove.bag.currentKg === 5_000 &&
      initialProductionMove.bag.location === 'production',
    'OP-1 initial BigBag warehouse-to-production handoff was not canonical',
  );
  const inventoryFixture = await createUnifiedInventoryFixture(sessions.operator.userId);

  const vite = start(
    process.execPath,
    [
      path.resolve(frontendDir, 'node_modules/vite/bin/vite.js'),
      'preview',
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
        API_PROXY_TARGET: apiBase,
        VITE_LIVE_CONTOURS: Object.keys(roleConfig).join(','),
        VITE_REQUIRE_AUTH: 'on',
      },
    },
  );
  await waitForHttp(webBase, 'Vite', vite);

  browser = await chromium.launch({ headless: true });
  const pages = {};
  for (const [actor, config] of Object.entries(actorConfig)) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    contexts.push(context);
    await context.addInitScript(
      ({ session }) => localStorage.setItem('plenki.auth.v1', JSON.stringify(session)),
      { session: sessions[actor] },
    );
    if (actor === 'warehouse') {
      await context.addInitScript(() => {
        Object.defineProperty(window, 'print', {
          configurable: true,
          value() {
            const topWindow = window.top;
            topWindow.__plenkaWarehouseSystemPrintCalls =
              (topWindow.__plenkaWarehouseSystemPrintCalls ?? 0) + 1;
            window.dispatchEvent(new Event('afterprint'));
          },
        });
      });
    }
    const page = await context.newPage();
    pages[actor] = page;
    page.on('pageerror', (error) => browserErrors.push(`${actor}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (
        actor === 'operatorB' &&
        expectingOperatorBShiftCloseConflict &&
        message.text() ===
          'Failed to load resource: the server responded with a status of 409 (Conflict)'
      ) {
        operatorBShiftCloseConflictConsoleCount += 1;
        return;
      }
      browserConsoleErrors.push(`${actor}: ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'unknown request failure';
      if (!failure.includes('ERR_ABORTED')) {
        browserRequestErrors.push(`${actor}: ${request.method()} ${request.url()} ${failure}`);
      }
    });
    page.on('response', (response) => {
      if (!new URL(response.url()).pathname.startsWith('/api/')) return;
      const inspection = response
        .text()
        .then((body) => {
          if (body.includes(rawPayloadCanary)) {
            networkCanaryLeaks.push(`${actor}: ${response.status()} ${response.url()}`);
          }
        })
        .catch(() => undefined);
      responseInspections.push(inspection);
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        actor === 'warehouse' &&
        (['/api/warehouse/physical-posts', '/api/warehouse/post-binding'].includes(url.pathname) ||
          /\/api\/operator\/rolls\/[^/]+\/(?:reweigh|defects)$/u.test(url.pathname))
      ) {
        obsoleteWarehousePostRequests.push(`${request.method()} ${url.pathname}`);
      }
      if (
        actor === 'warehouse' &&
        (url.pathname === '/api/warehouse/printers' ||
          url.pathname.endsWith('/close-and-print') ||
          /\/api\/warehouse\/pallet-lists\/[^/]+\/print$/u.test(url.pathname))
      ) {
        forbiddenWarehousePrintRequests.push(`${request.method()} ${url.pathname}`);
      }
    });
    await page.goto(
      `${webBase}/?role=${config.uiRole}&section=${encodeURIComponent(config.section)}`,
      {
        waitUntil: 'domcontentloaded',
      },
    );
    await page
      .locator(`.app-shell[data-active-role="${config.uiRole}"]`)
      .waitFor({ timeout: 20_000 });
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const remainingExpected = expectedReloads.get(actor) ?? 0;
        if (remainingExpected > 0) expectedReloads.set(actor, remainingExpected - 1);
        else navigationViolations.push(`${actor}: ${request.method()} ${request.url()}`);
      }
    });
  }
  const initialBrowserEntry = await browserEntrySnapshot(pages.commercial);
  assert(
    initialBrowserEntry.status === 200 &&
      initialBrowserEntry.url === `/${initialBuiltAsset.relativePath}` &&
      initialBrowserEntry.sha256 === initialBuiltAsset.sha256 &&
      initialBrowserEntry.bytes === initialBuiltAsset.bytes &&
      initialBrowserEntry.cacheControl?.includes('no-cache') &&
      Boolean(initialBrowserEntry.etag) &&
      initialBrowserEntry.serviceWorkerControlled === false &&
      initialBrowserEntry.serviceWorkerRegistrations === 0 &&
      initialBrowserEntry.cacheKeys.length === 0,
    `CD-8 browser entry freshness boundary failed: ${JSON.stringify(initialBrowserEntry)}`,
  );

  const stockWorkspace = pages.warehouse.locator('.warehouse-stock-workspace');
  try {
    await waitUntil('current unified warehouse inventory UI is populated', async () => {
      if ((await stockWorkspace.count()) !== 1 || !(await stockWorkspace.isVisible())) {
        return false;
      }
      const text = await stockWorkspace.innerText();
      return (
        text.includes('Рулоны на складе') &&
        text.includes(inventoryFixture.rollCode) &&
        text.includes('Складской резерв')
      );
    });
  } catch (error) {
    throw new Error(
      `Unified inventory bootstrap failed: ${JSON.stringify({
        body: (await pages.warehouse.locator('body').innerText())
          .replace(/\s+/gu, ' ')
          .slice(0, 2_000),
        browserErrors,
      })}`,
      { cause: error },
    );
  }
  assert(
    (await stockWorkspace
      .getByRole('button', { name: /Зарезервировать|Предложить производство/u })
      .count()) === 0,
    'Unified warehouse inventory exposed a stale manual reserve/coverage action',
  );
  assert(
    (await pages.warehouse
      .locator('.warehouse-finished-stock, .warehouse-cover-tasks-panel')
      .count()) === 0,
    'Unified warehouse inventory rendered a legacy stock surface',
  );
  const stockSearch = stockWorkspace.getByLabel('Поиск рулонов');
  const stockFilterResponse = pages.warehouse.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/warehouse/inventory/rolls' &&
        url.searchParams.get('q') === inventoryFixture.rollCode &&
        response.request().method() === 'GET'
      );
    },
    { timeout: 8_000 },
  );
  await stockSearch.fill(inventoryFixture.rollCode);
  const stockFilterPayload = await (await stockFilterResponse).json();
  assert(
    stockFilterPayload.items.length === 1 &&
      stockFilterPayload.items[0].rollCode === inventoryFixture.rollCode &&
      stockFilterPayload.items[0].batchCode === inventoryFixture.batchCode &&
      stockFilterPayload.items[0].origin === 'reserve' &&
      stockFilterPayload.items[0].lifecycleStatus === 'available' &&
      stockFilterPayload.items[0].counterpartyName === 'Резерв',
    `Unified inventory filter returned the wrong live projection: ${JSON.stringify(stockFilterPayload)}`,
  );
  await waitUntil('unified inventory filter keeps the exact live row', async () => {
    const text = await stockWorkspace.innerText();
    return text.includes(inventoryFixture.rollCode) && text.includes('Складской резерв');
  });

  const fixtureName = `Cross contour live smoke ${Date.now()}-${process.pid}`;
  const order = await createCommercialOrder(pages.commercial, fixtureName);
  assert(
    order.positions?.length === 2,
    `WH-5 requires exactly two live commercial positions; received ${order.positions?.length ?? 0}`,
  );
  const orderId = order.id;
  counterpartyId = order.counterpartyId;
  const orderNumber = order.orderNumber;
  console.log(`FIXTURE order=${orderNumber} id=${orderId}`);
  const createdOrderDetail = await apiRequest(`/api/commercial/orders/${orderId}`, {
    token: sessions.commercial.token,
  });
  assert(
    createdOrderDetail.warehouseCoverageWorkflowVersion === 2 &&
      createdOrderDetail.warehouseCoverage?.workflowVersion === 2 &&
      createdOrderDetail.warehouseCoverage.state === 'calculating' &&
      createdOrderDetail.warehouseCoverage.nextOwner === 'system',
    `New client order did not enter automatic V2 coverage: ${JSON.stringify(createdOrderDetail.warehouseCoverage)}`,
  );
  const createdRow = pages.commercial.locator(`[data-commercial-order-id="${orderId}"]`);
  await createdRow.waitFor({ state: 'visible' });
  await createdRow.click();
  const commercialDetail = pages.commercial.locator('.commercial-live-detail-panel');
  await waitUntil('created commercial order detail selected', async () =>
    (await commercialDetail.innerText()).includes(orderNumber),
  );
  const plannedWeightInputAttributes = await verifyCommercialPlannedWeightBoundary(
    pages.commercial,
    commercialDetail,
    orderId,
    orderNumber,
    sessions.commercial.token,
  );
  const commercialCoveragePanel = commercialDetail.locator(
    '.commercial-cover-panel-v2[aria-label="Покрытие склада"]',
  );
  await waitUntil('commercial renders automatic V2 coverage without manual decisions', async () => {
    return (
      (await commercialCoveragePanel.count()) === 1 &&
      (await commercialCoveragePanel.isVisible()) &&
      (await commercialCoveragePanel.innerText()).includes('Проверка выполняется')
    );
  });
  assert(
    (await commercialDetail
      .getByRole('button', {
        name: /Запросить проверку склада|Запросить перепроверку|Произвести всё/u,
      })
      .count()) === 0,
    'Commercial V2 detail exposed a legacy manual warehouse-coverage decision',
  );
  const [routineWarehouseRechecks, routineWarehouseInbox] = await Promise.all([
    apiRequest('/api/warehouse/warehouse-coverage/rechecks', {
      token: sessions.warehouse.token,
    }),
    apiRequest('/api/warehouse/notifications?limit=100', {
      token: sessions.warehouse.token,
    }),
  ]);
  assert(
    routineWarehouseRechecks.every((item) => item.orderId !== orderId) &&
      routineWarehouseInbox.items.every(
        (item) => item.orderId !== orderId && item.cta?.targetId !== orderId,
      ),
    'Routine automatic V2 calculation leaked a manual warehouse task or notification',
  );
  await clickAndWait(
    pages.commercial,
    'Передать в бухгалтерию',
    (response) => new URL(response.url()).pathname.endsWith(`/${orderId}/invoice-handoff`),
    commercialDetail,
  );
  await waitForBodyText(pages.finance, orderNumber, 'invoice handoff visible in finance Actual');
  const financeOrders = await apiRequest('/api/finance/orders', { token: sessions.finance.token });
  const financeOrder = financeOrders.find((candidate) => candidate.commercialOrder?.id === orderId);
  assert(financeOrder?.id, 'Finance order was not returned to finance');
  const automaticCoverage = await apiRequest(
    `/api/finance/orders/${financeOrder.id}/warehouse-coverage`,
    { token: sessions.finance.token },
  );
  assert(
    automaticCoverage.workflowVersion === 2 &&
      automaticCoverage.state === 'production_required' &&
      automaticCoverage.availability === 'unavailable' &&
      automaticCoverage.requiredRollCount === 2 &&
      automaticCoverage.matchedRollCount === 0 &&
      automaticCoverage.nextOwner === 'system' &&
      automaticCoverage.availableActions.length === 1 &&
      automaticCoverage.availableActions[0] === 'request_recheck',
    `V2 automatic coverage did not choose the all-production route: ${JSON.stringify(automaticCoverage)}`,
  );
  const automaticCoverageEvents = await prisma.domainEvent.findMany({
    where: {
      objectId: orderId,
      type: {
        in: ['audit:warehouse_coverage_calculated', 'audit:warehouse_coverage_decided'],
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      type: true,
      actorKind: true,
      actorRole: true,
      actorId: true,
      systemActorKey: true,
    },
  });
  assert(
    automaticCoverageEvents.length === 2 &&
      automaticCoverageEvents[0].type === 'audit:warehouse_coverage_calculated' &&
      automaticCoverageEvents[1].type === 'audit:warehouse_coverage_decided' &&
      automaticCoverageEvents.every(
        (event) =>
          event.actorKind === 'system' &&
          event.actorRole === null &&
          event.actorId === null &&
          event.systemActorKey === 'warehouse_coverage_engine',
      ),
    `V2 automatic coverage audit sequence is not exact: ${JSON.stringify(automaticCoverageEvents)}`,
  );
  await waitForControl(
    pages.finance,
    'Новая заявка на счёт',
    financeOrder.id,
    'invoice handoff visible in finance Control',
    { open: true },
  );

  await openFinanceOrder(pages.finance, orderNumber);
  const financeCoverageCard = pages.finance.locator(
    '.finance-coverage-decision[data-coverage-state="production_required"]',
  );
  assert(
    (await financeCoverageCard.count()) === 0,
    'Finance duplicated warehouse coverage controls after the automatic backend decision',
  );
  await issuePostpayInvoice(pages.finance);
  const postpayOrder = await apiRequest(`/api/commercial/orders/${orderId}`, {
    token: sessions.commercial.token,
  });
  assert(
    postpayOrder.nextAction?.code === 'send_to_production' &&
      postpayOrder.nextAction?.allowed === true,
    `Postpay policy did not open the server production gate: ${JSON.stringify({
      nextAction: postpayOrder.nextAction,
      financeSummary: postpayOrder.financeSummary,
    })}`,
  );
  await openCommercialOrder(pages.commercial, 'Входящие заявки', orderId, orderNumber);
  await waitUntil('postpay enables the V2 commercial production handoff', async () => {
    const button = pages.commercial.getByRole('button', {
      name: 'Передать в производство',
      exact: true,
    });
    return (await button.count()) === 1 && (await button.isEnabled());
  });
  assert(
    !(await pages.production.locator('body').innerText()).includes(orderNumber),
    'Production auto-created before commercial click',
  );

  await clickAndWait(
    pages.commercial,
    'Передать в производство',
    (response) => new URL(response.url()).pathname.endsWith(`/${orderId}/send-to-production`),
    commercialDetail,
  );
  const productionOrders = await apiRequest('/api/production/orders', {
    token: sessions.production.token,
  });
  const productionOrder = productionOrders.find(
    (candidate) => candidate.commercialOrderId === orderId,
  );
  assert(productionOrder?.id, 'Production order was not returned to production after handoff');
  await waitForBodyText(
    pages.production,
    orderNumber,
    'commercial click visible in production queue',
  );
  await waitForControl(
    pages.production,
    'Новый заказ-наряд',
    productionOrder.id,
    'commercial click visible in production Control',
  );

  const rolls = productionOrder.dispatchItems;
  assert(
    rolls.length === 2 && new Set(rolls.map((item) => item.rollCode)).size === 2,
    `WH-5 production handoff must create two distinct rolls: ${JSON.stringify(rolls)}`,
  );
  const roll = rolls[0];

  const shifts = await apiRequest('/api/production/shifts', { token: sessions.production.token });
  const shift = shifts.find(
    (candidate) =>
      candidate.status === 'open' &&
      candidate.machineAssignments.some(
        (assignment) => assignment.operatorId === sessions.operator.userId,
      ),
  );
  assert(shift, 'No open seed shift/machine assignment for operator');
  const assignment = shift.machineAssignments.find(
    (candidate) => candidate.operatorId === sessions.operator.userId,
  );
  const productionHub = pages.production.locator('.production-orders-hub');
  const productionOrderRow = productionHub
    .locator('.plenki-data-table tbody > tr:not(.plenki-data-table-expanded-row)')
    .filter({ hasText: orderNumber })
    .first();
  await waitUntil(`production UI selects ${orderNumber}`, async () => {
    return (await productionOrderRow.count()) === 1 && (await productionOrderRow.isVisible());
  });
  await productionOrderRow.getByRole('checkbox').check();
  await productionHub.getByRole('button', { name: 'Открыть рулоны', exact: true }).click();
  for (const ownedRoll of rolls) {
    const operatorSelect = productionHub.getByLabel(`Оператор для рулона ${ownedRoll.rollCode}`);
    await operatorSelect.waitFor({ state: 'visible' });
    const assignmentResponsePromise = pages.production.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(
          `/roll-dispatch/${encodeURIComponent(ownedRoll.rollCode)}/assign`,
        ) && response.request().method() === 'POST',
      { timeout: 8_000 },
    );
    await operatorSelect.selectOption(sessions.operator.userId);
    const assignmentResponse = await assignmentResponsePromise;
    assert(
      assignmentResponse.ok(),
      `Production UI assignment for ${ownedRoll.rollCode} returned ${assignmentResponse.status()}`,
    );
    await waitUntil(`production UI assigned ${ownedRoll.rollCode}`, async () => {
      return (await operatorSelect.inputValue()) === sessions.operator.userId;
    });
  }
  const automaticallyPublishedOrder = (
    await apiRequest('/api/production/orders', { token: sessions.production.token })
  ).find((candidate) => candidate.id === productionOrder.id);
  assert(
    automaticallyPublishedOrder?.approvalState === 'approved' &&
      automaticallyPublishedOrder.dispatchItems.length === 2 &&
      automaticallyPublishedOrder.dispatchItems.every(
        (item) => item.assignedOperatorId === sessions.operator.userId,
      ),
    `Ready assignment did not publish atomically: ${JSON.stringify(automaticallyPublishedOrder)}`,
  );
  await productionHub.getByRole('button', { name: 'Заказы', exact: true }).click();
  await waitUntil(
    'production removes obsolete manual approval after automatic publication',
    async () => {
      return (
        (await productionOrderRow
          .getByRole('button', { name: 'Согласовать', exact: true })
          .count()) === 0
      );
    },
  );
  const activePostSession = await prisma.operatorPostSession.findFirst({
    where: { operatorId: sessions.operator.userId, status: 'active' },
    select: { id: true },
  });
  const postSession = await apiRequest('/api/operator/post-sessions', {
    token: sessions.operator.token,
    method: 'POST',
    body: { postCode: assignment.post.code },
  });
  assert(activePostSession || postSession?.id, 'Operator post session was not available');

  await waitForBodyText(
    pages.operator,
    roll.rollCode,
    'automatic assignment visible in operator rolls',
  );
  await waitForControl(
    pages.operator,
    'Назначен заказ',
    null,
    'automatic assignment visible in operator Control',
    { open: true },
  );
  const publishedOperatorInbox = await apiRequest('/api/operator/notifications?limit=100', {
    token: sessions.operator.token,
  });
  const publishedCard = publishedOperatorInbox.items.find(
    (item) =>
      item.eventType === 'audit:task_assigned' &&
      item.orderId === orderId &&
      item.rollId === null &&
      item.cta?.kind === 'operator_queue' &&
      item.cta.targetId === orderId,
  );
  assert(
    publishedCard,
    `Automatic assignment did not create one exact operator card for ${roll.rollCode}`,
  );

  const operatorBShift = shifts.find(
    (candidate) =>
      candidate.status === 'open' &&
      candidate.machineAssignments.some(
        (candidateAssignment) => candidateAssignment.operatorId === sessions.operatorB.userId,
      ),
  );
  const operatorBAssignment = operatorBShift?.machineAssignments.find(
    (candidate) => candidate.operatorId === sessions.operatorB.userId,
  );
  assert(operatorBShift && operatorBAssignment, 'No open seed shift for operator B');
  await apiRequest(`/api/production/roll-dispatch/${encodeURIComponent(roll.rollCode)}/assign`, {
    token: sessions.production.token,
    method: 'POST',
    body: { operatorId: sessions.operatorB.userId },
  });
  let operatorAReassignment;
  let operatorBReassignment;
  await waitUntil('reassignment reaches both operator inboxes', async () => {
    const [operatorAInbox, operatorBInbox] = await Promise.all([
      apiRequest('/api/operator/notifications?limit=100', {
        token: sessions.operator.token,
      }),
      apiRequest('/api/operator/notifications?limit=100', {
        token: sessions.operatorB.token,
      }),
    ]);
    operatorAReassignment = operatorAInbox.items.find(
      (item) =>
        item.eventType === 'audit:task_reassigned' &&
        item.cta.kind === 'operator_queue' &&
        item.orderId === orderId &&
        item.rollId === null &&
        item.cta.targetId === orderId,
    );
    operatorBReassignment = operatorBInbox.items.find(
      (item) =>
        item.eventType === 'audit:task_reassigned' &&
        item.cta.kind === 'operator_queue' &&
        item.orderId === orderId &&
        item.rollId === null &&
        item.cta.targetId === orderId,
    );
    return Boolean(operatorAReassignment && operatorBReassignment);
  });
  await openControlByTitle(
    pages.operator,
    'Назначение заказа изменено',
    'previous operator receives informational reassignment',
  );
  await waitUntil('operator queue route clears stale roll selection', async () => {
    const url = new URL(pages.operator.url());
    return (
      url.searchParams.get('section') === 'Рулоны и заказы' &&
      !url.searchParams.has('object') &&
      !url.searchParams.has('problem') &&
      !url.searchParams.has('roll') &&
      (await pages.operator
        .locator('article.detail-view')
        .filter({ hasText: roll.rollCode })
        .count()) === 0
    );
  });
  await waitForControl(
    pages.operatorB,
    'Назначение заказа изменено',
    null,
    'new operator receives reassigned order queue',
    { open: true },
  );
  await waitUntil('operator B opens the reassigned order queue', async () => {
    const url = new URL(pages.operatorB.url());
    return (
      url.searchParams.get('section') === 'Рулоны и заказы' &&
      !url.searchParams.has('object') &&
      !url.searchParams.has('problem') &&
      !url.searchParams.has('roll') &&
      (await pages.operatorB.locator('body').innerText()).includes(roll.rollCode)
    );
  });

  const operatorBDeferredBigBag = await openOperatorShift(pages.operatorB, createdBigBag.code);
  assert(
    operatorBDeferredBigBag?.startKg === 5_000,
    'OP-2 operator B shift did not start with the owned BigBag',
  );
  const operatorBDeferredActions = await openOperatorRoll(pages.operatorB, roll.rollCode);
  await clickAndWait(
    pages.operatorB,
    'Примите заказ',
    (response) => new URL(response.url()).pathname.endsWith('/accept'),
    operatorBDeferredActions,
  );
  await pages.operatorB
    .locator('.role-top-nav')
    .getByRole('button', { name: 'Смена', exact: true })
    .click();
  const operatorBShiftSurface = pages.operatorB.locator('.operator-shift-panel');
  const activeRollCloseRequest = operatorBShiftSurface.getByRole('button', {
    name: 'Сдать смену',
  });
  try {
    await waitUntil('OP-2 delegates active-roll close eligibility to the backend', async () => {
      return (
        (await activeRollCloseRequest.count()) === 1 &&
        (await activeRollCloseRequest.isEnabled()) &&
        !(await operatorBShiftSurface.innerText()).includes(
          'Вернуться к заказам и завершить текущий рулон',
        )
      );
    });
  } catch (error) {
    throw new Error(
      `OP-2 server-owned close eligibility mismatch: ${JSON.stringify({
        shift: await operatorBShiftSurface.innerText(),
        buttons: await operatorBShiftSurface.getByRole('button').allTextContents(),
      })}`,
      { cause: error },
    );
  }
  await activeRollCloseRequest.click();
  const activeRollCloseWeight = operatorBShiftSurface.locator('.bigbag-close-list input').first();
  await activeRollCloseWeight.fill('5000');
  const activeRollCloseConfirm = operatorBShiftSurface.getByRole('button', {
    name: 'Закрыть',
  });
  await waitUntil('OP-2 active-roll close confirmation is enabled', async () => {
    return (
      (await activeRollCloseConfirm.count()) === 1 && (await activeRollCloseConfirm.isEnabled())
    );
  });
  const rejectedActiveRollClosePromise = pages.operatorB.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/operator/shift/close' &&
      response.request().method() === 'POST',
    { timeout: 8_000 },
  );
  expectingOperatorBShiftCloseConflict = true;
  let rejectedActiveRollClose;
  let rejectedActiveRollCloseBody;
  try {
    await activeRollCloseConfirm.click();
    rejectedActiveRollClose = await rejectedActiveRollClosePromise;
    rejectedActiveRollCloseBody = await rejectedActiveRollClose.json();
    await pages.operatorB.waitForTimeout(0);
  } finally {
    expectingOperatorBShiftCloseConflict = false;
  }
  assert(
    rejectedActiveRollClose.status() === 409 &&
      rejectedActiveRollCloseBody.code === 'OPERATOR_SHIFT_STARTED_ROLLS_INCOMPLETE',
    `OP-2 backend did not reject the active roll at shift close: ${JSON.stringify({
      status: rejectedActiveRollClose.status(),
      body: rejectedActiveRollCloseBody,
    })}`,
  );
  const operatorBSessionAfterRejectedClose = await prisma.operatorPostSession.findFirstOrThrow({
    where: { operatorId: sessions.operatorB.userId, status: 'active' },
    select: { status: true, endedAt: true },
  });
  assert(
    operatorBSessionAfterRejectedClose.status === 'active' &&
      operatorBSessionAfterRejectedClose.endedAt === null,
    `OP-2 rejected close partially changed the session: ${JSON.stringify(operatorBSessionAfterRejectedClose)}`,
  );
  await waitUntil('OP-2 rejected close remains cancellable', async () => {
    const cancel = operatorBShiftSurface.getByRole('button', { name: 'Отменить сдачу' });
    return (await cancel.count()) === 1 && (await cancel.isEnabled());
  });
  await operatorBShiftSurface.getByRole('button', { name: 'Отменить сдачу' }).click();
  await pages.operatorB
    .locator('.role-top-nav')
    .getByRole('button', { name: 'Рулоны и заказы', exact: true })
    .click();
  await openOperatorRoll(pages.operatorB, roll.rollCode);
  await clickAndWait(
    pages.operatorB,
    'Отложить заказ',
    (response) => new URL(response.url()).pathname.endsWith('/defer'),
    pages.operatorB,
  );
  const deferredIdentity = await prisma.operatorRollLine.findUniqueOrThrow({
    where: { rollDispatchItemId: roll.id },
    select: { id: true, step: true, deferredFromStep: true, rollDispatchItemId: true },
  });
  assert(
    deferredIdentity.step === 'deferred' && deferredIdentity.deferredFromStep === 'spool_weight',
    `OP-2 did not preserve the exact deferred predecessor: ${JSON.stringify(deferredIdentity)}`,
  );

  await pages.operatorB
    .locator('.role-top-nav')
    .getByRole('button', { name: 'Смена', exact: true })
    .click();
  await operatorBShiftSurface.getByRole('button', { name: 'Сдать смену', exact: true }).click();
  const operatorBCloseWeight = operatorBShiftSurface.locator('.bigbag-close-list input').first();
  await operatorBCloseWeight.fill('5000');
  const confirmShiftClose = operatorBShiftSurface.getByRole('button', {
    name: 'Закрыть',
  });
  try {
    await waitUntil('OP-2 shift close confirmation is enabled', async () => {
      return (await confirmShiftClose.count()) === 1 && (await confirmShiftClose.isEnabled());
    });
  } catch (error) {
    throw new Error(
      `OP-2 close confirmation mismatch: ${JSON.stringify({
        shift: await operatorBShiftSurface.innerText(),
        buttons: await operatorBShiftSurface.getByRole('button').allTextContents(),
        input: await operatorBCloseWeight.inputValue(),
      })}`,
      { cause: error },
    );
  }
  const closeShiftResponsePromise = pages.operatorB.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/operator/shift/close' &&
      response.request().method() === 'POST',
    { timeout: 8_000 },
  );
  await confirmShiftClose.click();
  const closeShiftResponse = await closeShiftResponsePromise;
  const closeShiftRequest = closeShiftResponse.request().postDataJSON();
  const closeShiftResult = await closeShiftResponse.json();
  assert(
    closeShiftResponse.ok() &&
      Array.isArray(closeShiftResult.releasedRollIds) &&
      closeShiftResult.closingPayroll?.sessionId,
    `OP-2 shift close result is not canonical: ${JSON.stringify(closeShiftResult)}`,
  );
  const deferredAfterClose = await prisma.operatorRollLine.findUniqueOrThrow({
    where: { id: deferredIdentity.id },
    select: { id: true, step: true, deferredFromStep: true, rollDispatchItemId: true },
  });
  assert(
    JSON.stringify(deferredAfterClose) === JSON.stringify(deferredIdentity),
    `OP-2 shift close changed the deferred roll identity/state: ${JSON.stringify(deferredAfterClose)}`,
  );
  const [closeCommandCount, closeAuditCount] = await Promise.all([
    prisma.operatorShiftCloseCommand.count({
      where: { operationKey: closeShiftRequest.operationKey },
    }),
    prisma.domainEvent.count({
      where: {
        actorId: sessions.operatorB.userId,
        type: 'audit:operator_shift_closed',
      },
    }),
  ]);
  const replayedClose = await apiRequest('/api/operator/shift/close', {
    token: sessions.operatorB.token,
    method: 'POST',
    body: closeShiftRequest,
  });
  const [replayedCommandCount, replayedAuditCount] = await Promise.all([
    prisma.operatorShiftCloseCommand.count({
      where: { operationKey: closeShiftRequest.operationKey },
    }),
    prisma.domainEvent.count({
      where: {
        actorId: sessions.operatorB.userId,
        type: 'audit:operator_shift_closed',
      },
    }),
  ]);
  assert(
    replayedClose.closingPayroll.sessionId === closeShiftResult.closingPayroll.sessionId &&
      closeCommandCount === 1 &&
      replayedCommandCount === closeCommandCount &&
      replayedAuditCount === closeAuditCount,
    'OP-2 close replay duplicated payroll/close audit facts',
  );
  const nextOperatorBShift = await apiRequest('/api/production/operator-shifts', {
    token: sessions.production.token,
    method: 'POST',
    body: {
      operatorId: sessions.operatorB.userId,
      postId: operatorBAssignment.post.id,
      label: `OP-2 resume ${runId}`,
      operationKey: crypto.randomUUID(),
    },
  });
  assert(
    nextOperatorBShift.assignment?.operatorId === sessions.operatorB.userId,
    `OP-2 next available shift was not created for the same operator: ${JSON.stringify(nextOperatorBShift)}`,
  );
  await apiRequest(
    `/api/production/roll-dispatch/${encodeURIComponent(rolls[1].rollCode)}/assign`,
    {
      token: sessions.production.token,
      method: 'POST',
      body: { operatorId: sessions.operatorB.userId },
    },
  );
  expectedReloads.set('operatorB', (expectedReloads.get('operatorB') ?? 0) + 1);
  intentionalReloadCount += 1;
  await pages.operatorB.reload({ waitUntil: 'domcontentloaded' });
  await pages.operatorB
    .locator('.app-shell[data-active-role="operator"]')
    .waitFor({ timeout: 20_000 });
  const resumedOperatorBigBag = await openOperatorShift(pages.operatorB, createdBigBag.code);
  assert(
    resumedOperatorBigBag?.startKg === 5_000,
    'OP-2 next operator session did not reuse the canonical 5000 kg BigBag',
  );
  await waitUntil('OP-2 deferred roll survives real browser reload in the next queue', async () => {
    const body = await pages.operatorB.locator('body').innerText();
    return body.includes(roll.rollCode) && body.includes('Отложен');
  });
  const resumeActions = await openOperatorRoll(pages.operatorB, roll.rollCode);
  await clickAndWait(
    pages.operatorB,
    'Возобновите заказ',
    (response) => new URL(response.url()).pathname.endsWith('/resume'),
    resumeActions,
  );
  const resumedIdentity = await prisma.operatorRollLine.findUniqueOrThrow({
    where: { id: deferredIdentity.id },
    select: { id: true, step: true, deferredFromStep: true, rollDispatchItemId: true },
  });
  assert(
    resumedIdentity.id === deferredIdentity.id &&
      resumedIdentity.rollDispatchItemId === roll.id &&
      resumedIdentity.step === 'spool_weight' &&
      resumedIdentity.deferredFromStep === null,
    `OP-2 did not resume the exact deferred identity: ${JSON.stringify(resumedIdentity)}`,
  );

  const productionInboxBeforePagination = await apiRequest(
    '/api/production/notifications?limit=100',
    { token: sessions.production.token },
  );
  const paginationMarkers = Array.from(
    { length: 27 },
    (_, index) => `Pagination marker ${String(index + 1).padStart(2, '0')} ${runId}`,
  );
  const paginationEvents = await Promise.all(
    paginationMarkers.map((marker, index) =>
      prisma.domainEvent.create({
        data: {
          family: 'notification',
          type: 'notification:penalty_created',
          objectId: `smoke-penalty-${runId}-${index + 1}`,
          actorRole: 'production_lead',
          actorId: sessions.production.userId,
          label: 'Notification pagination smoke',
          detail: {
            targetRole: 'production_lead',
            employeeId: sessions.production.userId,
            employeeName: sessions.production.displayName,
            reason: marker,
            amount: index + 1,
          },
          createdAt: new Date(Date.now() + index),
        },
      }),
    ),
  );
  let firstProductionPage;
  await waitUntil('production unread total includes all 27 events', async () => {
    firstProductionPage = await apiRequest('/api/production/notifications?limit=20', {
      token: sessions.production.token,
    });
    return (
      firstProductionPage.unreadCount ===
        productionInboxBeforePagination.unreadCount + paginationEvents.length &&
      firstProductionPage.items.length === 20 &&
      Boolean(firstProductionPage.nextCursor)
    );
  });
  const pagedProductionIds = new Set();
  let productionCursor = null;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await apiRequest(
      `/api/production/notifications?limit=20${
        productionCursor ? `&cursor=${encodeURIComponent(productionCursor)}` : ''
      }`,
      { token: sessions.production.token },
    );
    for (const item of page.items) {
      assert(!pagedProductionIds.has(item.id), `Duplicate production inbox item ${item.id}`);
      pagedProductionIds.add(item.id);
    }
    productionCursor = page.nextCursor;
    if (!productionCursor) break;
  }
  assert(
    paginationEvents.every((event) => pagedProductionIds.has(event.id)),
    'Production pagination did not return all 27 deterministic events',
  );
  const completeProductionPanel = await loadCompleteControlPanel(
    pages.production,
    'production notification pagination',
    firstProductionPage.unreadCount,
  );
  const completeProductionText = await completeProductionPanel.innerText();
  for (const marker of paginationMarkers) {
    const occurrences = completeProductionText.split(marker).length - 1;
    assert(
      occurrences === 1,
      `Production notification marker occurrence count is ${occurrences}: ${marker}`,
    );
  }
  const productionUnreadHeading = completeProductionPanel.getByRole('heading', {
    name: `${firstProductionPage.unreadCount} непрочитано`,
    exact: true,
  });
  assert(
    (await productionUnreadHeading.count()) === 1,
    'Production badge/panel did not render the server unread total',
  );
  await completeProductionPanel.getByRole('button', { name: 'Закрыть уведомления' }).click();

  const defectFixtures = [
    {
      actorRole: 'production_lead',
      actorId: sessions.production.userId,
      eventType: 'problem:production_defect_reported',
      title: 'Зафиксирован производственный брак',
      reason: `Production defect ${runId}`,
      rollId: `${roll.rollCode}-PRODUCTION-DEFECT`,
    },
    {
      actorRole: 'operator',
      actorId: sessions.operator.userId,
      eventType: 'problem:operator_defect_reported',
      title: 'Оператор сообщил о дефекте',
      reason: `Operator defect ${runId}`,
      rollId: `${roll.rollCode}-OPERATOR-DEFECT`,
    },
    {
      actorRole: 'warehouse',
      actorId: sessions.warehouse.userId,
      eventType: 'problem:warehouse_defect_reported',
      title: 'Склад сообщил о дефекте',
      reason: `Warehouse defect ${runId}`,
      rollId: `${roll.rollCode}-WAREHOUSE-DEFECT`,
    },
  ];
  const verifyProblemsRefresh = await businessPerformanceSmoke.assertProblemsRefresh(
    pages,
    defectFixtures[0].reason,
  );
  const createdDefects = [];
  const operatorRollLine = await prisma.operatorRollLine.findUniqueOrThrow({
    where: { rollDispatchItemId: roll.id },
  });
  for (const fixture of defectFixtures) {
    const defect = await prisma.defectRecord.create({
      data: {
        operatorRollLineId: operatorRollLine.id,
        sourceRole: fixture.actorRole,
        comment: fixture.reason,
        // These records exercise recipient routing only; they must not block the independent
        // physical QR handover scenario that follows in the same isolated order.
        blocking: false,
      },
    });
    const problem = await prisma.productionProblem.create({
      data: {
        orderId,
        positionId: roll.orderLineId,
        rollId: fixture.rollId,
        actorRole: fixture.actorRole,
        reason: fixture.reason,
        recovery: 'Проверить рулон и выбрать производственное решение.',
        status: 'open',
        type: 'defect',
        defectRecordId: defect.id,
      },
    });
    const event = await prisma.domainEvent.create({
      data: {
        family: 'problem',
        type: fixture.eventType,
        objectId: problem.id,
        actorRole: fixture.actorRole,
        actorId: fixture.actorId,
        label: fixture.reason,
        detail: {
          problemId: problem.id,
          orderId,
          productionOrderId: productionOrder.id,
          positionId: roll.orderLineId,
          rollId: fixture.rollId,
        },
      },
    });
    createdDefects.push({ ...fixture, defect, problem, event });
  }
  await verifyProblemsRefresh(sessions, createdDefects[0].problem.id);
  for (const fixture of createdDefects) {
    await openProblemControl(
      pages.production,
      fixture.title,
      fixture.problem.id,
      fixture.rollId,
      `${fixture.actorRole} defect opens exact production problem`,
    );
  }
  await prisma.productionProblem.updateMany({
    where: { id: { in: createdDefects.map((fixture) => fixture.problem.id) } },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedById: sessions.production.userId,
    },
  });

  const activeOperatorPage = pages.operatorB;
  const activeOperatorSession = sessions.operatorB;
  const printedQrByRoll = new Map();
  const handovers = [];
  for (const ownedRoll of rolls) {
    const operatorPrimaryActions = await openOperatorRoll(activeOperatorPage, ownedRoll.rollCode);
    for (const action of [
      ['Примите заказ', '/accept'],
      [/^Зафиксировать (?:вес шпули|0,7 кг)(?:\.|$)/u, '/spool-weight'],
      ['Зафиксировать вес рулона', '/roll-weight'],
      ['Напечатайте QR', '/qr-print'],
    ]) {
      if (ownedRoll.rollCode === roll.rollCode && action[1] === '/accept') continue;
      await clickAndWait(
        activeOperatorPage,
        action[0],
        (response) => new URL(response.url()).pathname.endsWith(action[1]),
        operatorPrimaryActions,
      );
    }
    const printedToken = await prisma.rollScanToken.findUnique({
      where: { rollCode: ownedRoll.rollCode },
      select: { token: true },
    });
    const printedQrPayload = printedToken?.token ?? null;
    assert(
      typeof printedQrPayload === 'string' && /^prt_[0-9a-f]{64}$/u.test(printedQrPayload),
      `Operator did not persist the print token for ${ownedRoll.rollCode}`,
    );
    printedQrByRoll.set(ownedRoll.rollCode, printedQrPayload);
    const operatorScanner = activeOperatorPage.getByLabel('Сканирование QR оператора');
    await operatorScanner.waitFor({ state: 'visible', timeout: 8_000 });
    assert((await operatorScanner.inputValue()) === '', 'Operator HID input must start blank');
    const verifyResponsePromise = activeOperatorPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/qr-verify-and-handover') &&
        response.request().method() === 'POST',
      { timeout: 8_000 },
    );
    await operatorScanner.fill(printedQrPayload);
    await operatorScanner.press('Enter');
    const verifyResponse = await verifyResponsePromise;
    const handoverResult = await verifyResponse.json().catch(() => null);
    assert(
      verifyResponse.ok(),
      `Operator QR handover for ${ownedRoll.rollCode} returned ${verifyResponse.status()}: ${JSON.stringify(handoverResult)}`,
    );
    handovers.push(handoverResult);
    assert(
      (await operatorPrimaryActions
        .getByRole('button', { name: 'Передайте рулон на склад' })
        .count()) === 0,
      'Operator must not expose a manual warehouse handover after QR scan',
    );
  }
  const handover = handovers[0];
  assert(
    handover?.id && handovers.every((candidate) => candidate?.id === handover.id),
    `WH-5 requires one canonical receiving task: ${JSON.stringify(handovers)}`,
  );
  const handedOffLifecycle = await assertBusinessProductionLifecycle({
    pages,
    sessions,
    productionOrderId: productionOrder.id,
    orderNumber,
    rolls,
    lifecycleStatus: 'warehouse_handed_off',
    label: 'Передан на склад',
  });

  await activeOperatorPage
    .locator('.role-top-nav')
    .getByRole('button', { name: 'Смена', exact: true })
    .click();
  const operatorShiftSurface = activeOperatorPage.locator('.operator-shift-panel');
  const activeBigBag = operatorShiftSurface
    .locator('.operator-active-bigbags-list article')
    .filter({ hasText: createdBigBag.code });
  await activeBigBag.waitFor({ state: 'visible', timeout: 8_000 });
  await activeBigBag.getByLabel(`Финальный вес ${createdBigBag.code}, кг`).fill('4000');
  let interceptStaleBigBag;
  let releaseStaleBigBag;
  const staleBigBagIntercepted = new Promise((resolve) => {
    interceptStaleBigBag = resolve;
  });
  const staleBigBagReleased = new Promise((resolve) => {
    releaseStaleBigBag = resolve;
  });
  const bigBagRoute = '**/api/operator/big-bags';
  let staleBigBagRequest;
  let staleBigBagPayload;
  let bigBagRouteCalls = 0;
  await activeOperatorPage.route(bigBagRoute, async (route) => {
    bigBagRouteCalls += 1;
    if (bigBagRouteCalls > 1) {
      await route.continue();
      return;
    }
    staleBigBagRequest = route.request();
    const upstream = await route.fetch();
    staleBigBagPayload = await upstream.json();
    interceptStaleBigBag();
    await staleBigBagReleased;
    await route.fulfill({ response: upstream, json: staleBigBagPayload }).catch(() => undefined);
  });
  await focusRefresh(activeOperatorPage);
  await staleBigBagIntercepted;
  assert(staleBigBagRequest, 'OP-1 pre-mutation BigBag request was not captured');
  assert(
    Array.isArray(staleBigBagPayload) &&
      staleBigBagPayload.find((candidate) => candidate.id === createdBigBag.id)?.currentKg ===
        5_000,
    `OP-1 held response was not the real pre-mutation 5000 kg fact: ${JSON.stringify(staleBigBagPayload)}`,
  );
  const staleBigBagOutcomePromise = waitForRequestBodyOrAbort(
    activeOperatorPage,
    staleBigBagRequest,
    'OP-1 pre-mutation BigBag response',
  );
  const newerBigBagResponsePromise = activeOperatorPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/operator/big-bags' &&
      response.request().method() === 'GET' &&
      response.request() !== staleBigBagRequest,
    { timeout: 8_000 },
  );
  const releaseResponsePromise = activeOperatorPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/operator/shift/bags/${createdBigBag.id}/release` &&
      response.request().method() === 'POST',
    { timeout: 8_000 },
  );
  await activeBigBag.getByRole('button', { name: 'Сдать Big-Bag', exact: true }).click();
  const releaseResponse = await releaseResponsePromise;
  const releaseRequest = releaseResponse.request().postDataJSON();
  const releaseResult = await releaseResponse.json();
  assert(
    releaseResponse.ok() &&
      releaseRequest.endKg === 4_000 &&
      typeof releaseRequest.operationKey === 'string' &&
      releaseResult.bagId === createdBigBag.id &&
      releaseResult.startKg === 5_000 &&
      releaseResult.endKg === 4_000,
    `OP-1 operator release was not exact: ${JSON.stringify(releaseResult)}`,
  );
  const newerBigBagResponse = await newerBigBagResponsePromise;
  assert(
    newerBigBagResponse.ok(),
    `OP-1 post-mutation BigBag refetch returned HTTP ${newerBigBagResponse.status()}`,
  );
  const newerBigBagFailure = await newerBigBagResponse.finished();
  assert(!newerBigBagFailure, `OP-1 post-mutation BigBag refetch failed: ${newerBigBagFailure}`);
  const newerBigBagPayload = await newerBigBagResponse.json();
  assert(
    newerBigBagPayload.find((candidate) => candidate.id === createdBigBag.id)?.currentKg === 4_000,
    `OP-1 post-mutation refetch omitted the canonical 4000 kg fact: ${JSON.stringify(newerBigBagPayload)}`,
  );
  await awaitTwoAnimationFrames(activeOperatorPage);
  releaseStaleBigBag();
  const staleBigBagOutcome = await staleBigBagOutcomePromise;
  assert(
    staleBigBagOutcome === 'aborted' || staleBigBagOutcome === 'finished',
    `OP-1 pre-mutation BigBag response had an invalid outcome: ${staleBigBagOutcome}`,
  );
  await awaitTwoAnimationFrames(activeOperatorPage);
  await activeOperatorPage.unroute(bigBagRoute);
  assert(bigBagRouteCalls >= 2, 'OP-1 release did not trigger a newer BigBag refetch');
  const immediateAddBigBag = operatorShiftSurface.locator('details.bigbag-add');
  if (!(await immediateAddBigBag.getAttribute('open'))) {
    await immediateAddBigBag.locator('summary').click();
  }
  const immediateReaddOption = immediateAddBigBag
    .getByRole('option')
    .filter({ hasText: createdBigBag.code })
    .first();
  await waitUntil('OP-1 pre-reload UI rejects the settled stale 5000 kg body', async () =>
    (await immediateReaddOption.innerText()).includes('4000 кг'),
  );
  await immediateReaddOption.click();
  assert(
    (await immediateAddBigBag.locator('#bigbag-add-weight').inputValue()) === '4000',
    'OP-1 pre-reload UI did not prefill the canonical 4000 kg fact',
  );
  const [releaseMovementCount, releaseAuditCount] = await Promise.all([
    prisma.bigBagMovement.count({
      where: { bigBagId: createdBigBag.id, kind: 'operator_shift_release' },
    }),
    prisma.domainEvent.count({
      where: {
        objectId: createdBigBag.code,
        type: 'audit:operator_shift_bag_released',
      },
    }),
  ]);
  const replayedRelease = await apiRequest(`/api/operator/shift/bags/${createdBigBag.id}/release`, {
    token: activeOperatorSession.token,
    method: 'POST',
    body: releaseRequest,
  });
  assert(
    replayedRelease.endKg === 4_000 &&
      (await prisma.bigBagMovement.count({
        where: { bigBagId: createdBigBag.id, kind: 'operator_shift_release' },
      })) === releaseMovementCount &&
      (await prisma.domainEvent.count({
        where: {
          objectId: createdBigBag.code,
          type: 'audit:operator_shift_bag_released',
        },
      })) === releaseAuditCount,
    'OP-1 replay duplicated the append-only release movement/audit',
  );

  const warehouseReturn = await apiRequest('/api/warehouse/big-bags/scans', {
    token: sessions.warehouse.token,
    method: 'POST',
    body: {
      operationKey: crypto.randomUUID(),
      qrCode: createdBigBagToken.token,
      destination: 'warehouse',
      warehouseWeightKg: 4_000,
    },
  });
  assert(
    warehouseReturn.bag.id === createdBigBag.id &&
      warehouseReturn.bag.currentKg === 4_000 &&
      warehouseReturn.bag.lastWarehouseMeasuredKg === 4_000 &&
      warehouseReturn.weightComparison?.operatorReportedKg === 4_000 &&
      warehouseReturn.weightComparison.warehouseMeasuredKg === 4_000,
    `OP-1 warehouse measurement was not canonical: ${JSON.stringify(warehouseReturn)}`,
  );
  const returnedToProduction = await apiRequest('/api/warehouse/big-bags/scans', {
    token: sessions.warehouse.token,
    method: 'POST',
    body: {
      operationKey: crypto.randomUUID(),
      qrCode: createdBigBagToken.token,
      destination: 'production',
    },
  });
  assert(
    returnedToProduction.bag.currentKg === 4_000 &&
      returnedToProduction.bag.location === 'production',
    'OP-1 warehouse return-to-production changed the canonical 4000 kg fact',
  );

  const canonicalOperatorBags = await apiRequest('/api/operator/big-bags', {
    token: activeOperatorSession.token,
  });
  const canonicalOperatorBag = canonicalOperatorBags.find(
    (candidate) => candidate.id === createdBigBag.id,
  );
  assert(
    canonicalOperatorBag?.currentKg === 4_000,
    `OP-1 operator refetch did not expose 4000 kg: ${JSON.stringify(canonicalOperatorBag)}`,
  );
  expectedReloads.set('operatorB', (expectedReloads.get('operatorB') ?? 0) + 1);
  intentionalReloadCount += 1;
  await activeOperatorPage.reload({ waitUntil: 'domcontentloaded' });
  await activeOperatorPage
    .locator('.app-shell[data-active-role="operator"]')
    .waitFor({ timeout: 20_000 });
  await activeOperatorPage
    .locator('.role-top-nav')
    .getByRole('button', { name: 'Смена', exact: true })
    .click();
  await operatorShiftSurface.waitFor({ state: 'visible', timeout: 8_000 });

  const addBigBag = operatorShiftSurface.locator('details.bigbag-add');
  if (!(await addBigBag.getAttribute('open'))) await addBigBag.locator('summary').click();
  const readdOption = addBigBag.getByRole('option').filter({ hasText: createdBigBag.code }).first();
  await waitUntil('OP-1 delayed stale BigBag response cannot roll back 4000 kg', async () => {
    return (await readdOption.innerText()).includes('4000 кг');
  });
  await readdOption.click();
  const readdWeight = addBigBag.locator('#bigbag-add-weight');
  assert(
    (await readdWeight.inputValue()) === '4000',
    `OP-1 re-add prefilled ${await readdWeight.inputValue()} instead of 4000`,
  );
  const readdResponsePromise = activeOperatorPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/operator/shift/bags' &&
      response.request().method() === 'POST',
    { timeout: 8_000 },
  );
  await addBigBag.getByRole('button', { name: 'Добавить в смену', exact: true }).click();
  const readdResponse = await readdResponsePromise;
  assert(
    readdResponse.ok() && readdResponse.request().postDataJSON().startKg === 4_000,
    'OP-1 real re-add did not send the canonical 4000 kg value',
  );
  const latestBigBag = await prisma.bigBagUnit.findUniqueOrThrow({
    where: { id: createdBigBag.id },
    select: { currentKg: true, lastMeasuredKg: true, status: true },
  });
  assert(
    latestBigBag.currentKg === 4_000 &&
      latestBigBag.lastMeasuredKg === 4_000 &&
      latestBigBag.status === 'in_use',
    `OP-1 DB latest BigBag fact is not 4000 kg: ${JSON.stringify(latestBigBag)}`,
  );
  await activeOperatorPage
    .locator('.role-top-nav')
    .getByRole('button', { name: 'Рулоны и заказы', exact: true })
    .click();

  const intakeContract = await apiRequest('/api/warehouse/intake', {
    token: sessions.warehouse.token,
  });
  const ownedIntakeTasks = intakeContract.tasks.filter((task) =>
    task.rolls.some((candidate) => rolls.some((item) => item.rollCode === candidate.rollCode)),
  );
  assert(
    ownedIntakeTasks.length === 1 &&
      ownedIntakeTasks[0].taskId === handover.id &&
      ownedIntakeTasks[0].rolls.length === 2 &&
      new Set(ownedIntakeTasks[0].rolls.map((candidate) => candidate.rollCode)).size === 2 &&
      rolls.every((item) =>
        ownedIntakeTasks[0].rolls.some((candidate) => candidate.rollCode === item.rollCode),
      ),
    `Warehouse intake contract is not one exact two-row task: ${JSON.stringify(ownedIntakeTasks)}`,
  );

  await openTopNavigationSection(pages.warehouse, 'Приемка');
  await pages.warehouse.getByLabel('Сканирование QR').waitFor();
  assert(
    (await pages.warehouse.locator('.warehouse-post-binding-form').count()) === 0,
    'Warehouse must not expose industrial-post configuration',
  );
  const warehouseRoleLeakageText = await pages.warehouse.locator('body').innerText();
  assert(
    !/Выбор поста|Привязать пост|Перевзвесить рулон|Взвесить брак/u.test(warehouseRoleLeakageText),
    'Warehouse DOM exposed post binding, operator reweigh, or operator defect controls',
  );
  assert(
    obsoleteWarehousePostRequests.length === 0,
    `Warehouse browser requested obsolete post routes: ${obsoleteWarehousePostRequests.join(', ')}`,
  );
  const intakeRefresh = pages.warehouse.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/warehouse/intake' &&
      response.request().method() === 'GET',
    { timeout: 8_000 },
  );
  await focusRefresh(pages.warehouse);
  const intakeRefreshResponse = await intakeRefresh;
  assert(intakeRefreshResponse.ok(), 'Warehouse intake UI refresh failed');
  const intakeRefreshFailure = await intakeRefreshResponse.finished();
  assert(!intakeRefreshFailure, `Warehouse intake UI body failed: ${intakeRefreshFailure}`);
  const warehouseIntakeSnapshot = await intakeRefreshResponse.json();
  assert(
    warehouseIntakeSnapshot.tasks.some(
      (task) =>
        task.taskId === handover.id &&
        task.rolls.length === 2 &&
        rolls.every((item) => task.rolls.some((candidate) => candidate.rollCode === item.rollCode)),
    ),
    `Warehouse frontend snapshot omitted handover ${handover.id}`,
  );
  const receivingDetail = await openWarehouseTask(
    pages.warehouse,
    `intake-${handover.id}`,
    orderNumber,
    roll.rollCode,
    'operator handover visible in warehouse intake',
  );
  await waitForControl(
    pages.warehouse,
    'Рулон ожидает приёмки',
    `intake-${handover.id}`,
    'operator handover visible in warehouse Control',
  );
  const scanInput = pages.warehouse.getByLabel('Сканирование QR');
  const receivedRolls = [];
  for (const [index, ownedRoll] of rolls.entries()) {
    const receivingScan = pages.warehouse.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/warehouse/intake/scans' &&
        response.request().method() === 'POST',
      { timeout: 8_000 },
    );
    await scanInput.fill(printedQrByRoll.get(ownedRoll.rollCode));
    await scanInput.press('Enter');
    const receivingScanResponse = await receivingScan;
    const receivingScanResult = await receivingScanResponse.json();
    assert(
      receivingScanResponse.status() === 201,
      `Receiving scan for ${ownedRoll.rollCode} failed (${receivingScanResponse.status()}): ${JSON.stringify(receivingScanResult)}`,
    );
    assert(
      receivingScanResult.taskId === handover.id &&
        receivingScanResult.rollCode === ownedRoll.rollCode &&
        receivingScanResult.scanStatus === 'accepted' &&
        receivingScanResult.task?.closable === (index === rolls.length - 1),
      `Receiving scan rejected ${ownedRoll.rollCode}: ${JSON.stringify(receivingScanResult)}`,
    );
    const receivedRoll = receivingScanResult.task.rolls.find(
      (candidate) => candidate.rollCode === ownedRoll.rollCode,
    );
    assert(
      typeof receivedRoll?.scanRowId === 'string' &&
        receivedRoll.scanRowId.length > 0 &&
        receivedRoll.scanStatus === 'accepted' &&
        receivedRoll.palletSelection?.selected === false &&
        receivedRoll.palletSelection?.locked === false,
      `Receiving scan did not expose ${ownedRoll.rollCode} as selectable`,
    );
    receivedRolls.push(receivedRoll);
  }
  const receivingRefresh = pages.warehouse.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/warehouse/intake' &&
      response.request().method() === 'GET',
    { timeout: 8_000 },
  );
  await focusRefresh(pages.warehouse);
  const receivingRefreshPayload = await (await receivingRefresh).json();
  const refreshedReceivingTask = receivingRefreshPayload.tasks.find(
    (task) => task.taskId === handover.id,
  );
  assert(
    refreshedReceivingTask?.closable === true,
    'Warehouse intake refresh did not expose the owned task as closable',
  );
  assert(
    refreshedReceivingTask.activePallet === null &&
      refreshedReceivingTask.rolls.length === 2 &&
      receivedRolls.every((receivedRoll) =>
        refreshedReceivingTask.rolls.some(
          (candidate) =>
            candidate.scanRowId === receivedRoll.scanRowId &&
            candidate.rollCode === receivedRoll.rollCode &&
            candidate.palletSelection.selected === false &&
            candidate.palletSelection.locked === false,
        ),
      ),
    'Warehouse intake refresh inferred pallet membership before explicit selection',
  );

  let selectionResult = null;
  for (const receivedRoll of receivedRolls) {
    const palletSelectionPath = `/api/warehouse/intake/${handover.id}/pallet-selection/${receivedRoll.scanRowId}`;
    const palletSelectionResponse = pages.warehouse.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === palletSelectionPath &&
        response.request().method() === 'PUT',
      { timeout: 8_000 },
    );
    const palletSelectionButton = receivingDetail.getByLabel(
      `Добавить ${receivedRoll.rollCode} в палетный лист`,
    );
    await waitUntil(`warehouse can select ${receivedRoll.rollCode} into pallet`, async () => {
      return (
        (await palletSelectionButton.count()) === 1 &&
        (await palletSelectionButton.isVisible()) &&
        (await palletSelectionButton.isEnabled())
      );
    });
    await palletSelectionButton.click();
    const selectionResponse = await palletSelectionResponse;
    selectionResult = await selectionResponse.json();
    assert(
      selectionResponse.status() === 200 &&
        typeof selectionResult.activePallet?.palletCode === 'string' &&
        receivedRolls
          .slice(0, selectionResult.activePallet.rows.length)
          .every((candidate) =>
            selectionResult.activePallet.rows.some((row) => row.rollCode === candidate.rollCode),
          ),
      `Warehouse pallet selection rejected ${receivedRoll.rollCode}: ${JSON.stringify(selectionResult)}`,
    );
  }
  const activePallet = receivingDetail.locator(
    'section.warehouse-active-pallet[aria-label="Текущий палет"]',
  );
  await waitUntil('warehouse explicit pallet selection is visible', async () => {
    if ((await activePallet.count()) !== 1 || !(await activePallet.isVisible())) return false;
    for (const ownedRoll of rolls) {
      const selectedButton = receivingDetail.getByLabel(`${ownedRoll.rollCode} в палетном листе`);
      if (
        (await selectedButton.count()) !== 1 ||
        !(await selectedButton.isVisible()) ||
        (await selectedButton.getAttribute('aria-pressed')) !== 'true'
      ) {
        return false;
      }
    }
    const palletCode = activePallet.getByText(selectionResult.activePallet.palletCode, {
      exact: true,
    });
    return (
      (await palletCode.count()) === 1 &&
      (await palletCode.isVisible()) &&
      (
        await Promise.all(
          rolls.map(async (ownedRoll) => {
            const palletRoll = activePallet.getByText(ownedRoll.rollCode, { exact: true });
            return (await palletRoll.count()) === 1 && (await palletRoll.isVisible());
          }),
        )
      ).every(Boolean)
    );
  });
  const palletSelectionRefresh = pages.warehouse.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/warehouse/intake' &&
      response.request().method() === 'GET',
    { timeout: 8_000 },
  );
  await focusRefresh(pages.warehouse);
  const selectionRefreshResponse = await palletSelectionRefresh;
  const selectionRefreshPayload = await selectionRefreshResponse.json();
  const selectedReceivingTask = selectionRefreshPayload.tasks.find(
    (task) => task.taskId === handover.id,
  );
  assert(
    selectionRefreshResponse.ok() &&
      selectedReceivingTask?.activePallet?.rows.length === 2 &&
      receivedRolls.every(
        (receivedRoll) =>
          selectedReceivingTask.activePallet.rows.some(
            (row) => row.rollCode === receivedRoll.rollCode,
          ) &&
          selectedReceivingTask.rolls.some(
            (candidate) =>
              candidate.scanRowId === receivedRoll.scanRowId &&
              candidate.palletSelection.selected === true &&
              candidate.palletSelection.locked === false,
          ),
      ),
    'Warehouse intake refresh omitted the explicitly selected physical pallet membership',
  );

  assert(
    (await activePallet.getByLabel('Принтер для текущего палета').count()) === 0,
    'Browser-owned pallet printing must not expose a physical printer selector',
  );
  const forbiddenWarehousePrintRequestBaseline = forbiddenWarehousePrintRequests.length;
  const closePallet = activePallet.getByRole('button', {
    name: 'Закрыть и распечатать текущий палет',
  });
  await waitUntil('warehouse system-print pallet readiness', async () => {
    return (await closePallet.count()) === 1 && (await closePallet.isEnabled());
  });
  await closePallet.click();
  const palletDialog = pages.warehouse.getByRole('dialog', {
    name: new RegExp(`Закрыть ${selectedReceivingTask.activePallet.palletCode}`, 'u'),
  });
  await palletDialog.waitFor({ state: 'visible', timeout: 8_000 });
  await palletDialog.getByText('Системное окно Windows', { exact: true }).waitFor();
  const sealPalletResponse = pages.warehouse.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/warehouse/intake/${handover.id}/pallets/current/seal` &&
      response.request().method() === 'POST',
    { timeout: 8_000 },
  );
  const systemPrintIntentResponse = pages.warehouse.waitForResponse(
    (response) =>
      /\/api\/warehouse\/pallet-lists\/[^/]+\/system-print-intents$/u.test(
        new URL(response.url()).pathname,
      ) && response.request().method() === 'POST',
    { timeout: 8_000 },
  );
  const palletPreviewResponse = pages.warehouse.waitForResponse(
    (response) =>
      /\/api\/warehouse\/pallet-lists\/[^/]+\/preview$/u.test(new URL(response.url()).pathname) &&
      response.request().method() === 'GET',
    { timeout: 8_000 },
  );
  await palletDialog.getByRole('button', { name: 'Подтвердить закрытие палета' }).click();
  const [sealResponse, intentResponse, previewResponse] = await Promise.all([
    sealPalletResponse,
    systemPrintIntentResponse,
    palletPreviewResponse,
  ]);
  const sealResult = await sealResponse.json();
  assert(
    sealResponse.status() === 200 &&
      sealResult.pallet?.id === selectionResult.activePallet.id &&
      sealResult.pallet.palletCode === selectionResult.activePallet.palletCode &&
      sealResult.pallet.status === 'sealed' &&
      sealResult.pallet.rollCount === 2 &&
      sealResult.pallet.rows?.length === 2 &&
      rolls.every((ownedRoll) =>
        sealResult.pallet.rows.some((row) => row.rollCode === ownedRoll.rollCode),
      ) &&
      typeof sealResult.document?.id === 'string' &&
      sealResult.document.warehousePalletId === sealResult.pallet.id &&
      sealResult.document.palletId === sealResult.pallet.palletCode &&
      sealResult.document.origin === 'physical_pallet' &&
      sealResult.document.documentStatus === 'sealed' &&
      sealResult.document.templateVersion === 'pallet-100x100-extended-v6' &&
      sealResult.document.printStatus === 'not_printed' &&
      sealResult.document.rollCodes?.length === 2 &&
      rolls.every((ownedRoll) => sealResult.document.rollCodes.includes(ownedRoll.rollCode)),
    `Warehouse pallet seal returned a non-canonical result (${sealResponse.status()}): ${JSON.stringify(sealResult)}`,
  );
  const sealedDocumentId = sealResult.document.id;
  const systemPrintIntentPath = `/api/warehouse/pallet-lists/${sealedDocumentId}/system-print-intents`;
  const intentResult = await intentResponse.json();
  const intentRequest = intentResponse.request().postDataJSON();
  assert(
    intentResponse.status() === 200 &&
      new URL(intentResponse.url()).pathname === systemPrintIntentPath &&
      intentRequest.kind === 'initial' &&
      typeof intentRequest.requestId === 'string' &&
      intentResult.requestId === intentRequest.requestId &&
      intentResult.palletListDocumentId === sealedDocumentId &&
      intentResult.kind === 'initial' &&
      intentResult.status === 'intent_recorded' &&
      intentResult.replayed === false,
    `Warehouse system-print intent was not exact (${intentResponse.status()}): ${JSON.stringify(intentResult)}`,
  );
  const palletPreviewPath = `/api/warehouse/pallet-lists/${sealedDocumentId}/preview`;
  const previewContentType = previewResponse.headers()['content-type'] ?? null;
  assert(
    previewResponse.status() === 200 &&
      new URL(previewResponse.url()).pathname === palletPreviewPath &&
      previewContentType?.startsWith('image/png'),
    `Warehouse browser did not request the canonical PNG preview: ${JSON.stringify({
      status: previewResponse.status(),
      path: new URL(previewResponse.url()).pathname,
      contentType: previewContentType,
    })}`,
  );
  await pages.warehouse
    .getByText('Палет закрыт. Открыта системная печать.', { exact: true })
    .waitFor({ state: 'visible', timeout: 8_000 });
  assert(
    (await pages.warehouse.evaluate(() => window.__plenkaWarehouseSystemPrintCalls ?? 0)) === 1,
    'Warehouse pallet preview did not reach the mocked browser system-print boundary',
  );
  const canonicalPreviewResponse = await fetch(`${apiBase}${palletPreviewPath}`, {
    headers: { Authorization: `Bearer ${sessions.warehouse.token}` },
  });
  const canonicalPreviewBody = Buffer.from(await canonicalPreviewResponse.arrayBuffer());
  const canonicalPreviewContentType = canonicalPreviewResponse.headers.get('content-type');
  const canonicalPreviewPrefix = canonicalPreviewBody.subarray(0, 8).toString('hex');
  assert(
    canonicalPreviewResponse.status === 200 &&
      canonicalPreviewContentType?.startsWith('image/png') &&
      canonicalPreviewBody.length >= 24 &&
      canonicalPreviewPrefix === '89504e470d0a1a0a' &&
      canonicalPreviewBody.readUInt32BE(16) === 800 &&
      canonicalPreviewBody.readUInt32BE(20) === 800,
    `Warehouse immutable preview failed its PNG boundary: ${JSON.stringify({
      status: canonicalPreviewResponse.status,
      contentType: canonicalPreviewContentType,
      bytes: canonicalPreviewBody.length,
      prefix: canonicalPreviewPrefix,
    })}`,
  );
  const forbiddenPalletActionRequests = forbiddenWarehousePrintRequests.slice(
    forbiddenWarehousePrintRequestBaseline,
  );
  assert(
    forbiddenPalletActionRequests.length === 0,
    `Browser-only pallet printing called a forbidden physical-print route: ${forbiddenPalletActionRequests.join(', ')}`,
  );

  const receivingCloseScope = receivingDetail.locator(
    '.warehouse-roll-table > .operator-panel-title',
  );
  await waitUntil('warehouse receiving close enabled for owned task', async () => {
    const button = receivingCloseScope.locator('.warehouse-close-inline-action');
    return (await button.count()) === 1 && (await button.isEnabled());
  });
  await clickAndWait(
    pages.warehouse,
    'Закрыть приемку',
    (response) => new URL(response.url()).pathname.endsWith(`/tasks/${handover.id}/close`),
    receivingCloseScope,
  );

  const acceptedLifecycle = await assertBusinessProductionLifecycle({
    pages,
    sessions,
    productionOrderId: productionOrder.id,
    orderNumber,
    rolls,
    lifecycleStatus: 'warehouse_accepted',
    label: 'Принят складом',
  });
  for (const actor of ['commercial', 'production', 'warehouse', 'director']) {
    expectedReloads.set(actor, (expectedReloads.get(actor) ?? 0) + 1);
    intentionalReloadCount += 1;
    await pages[actor].reload({ waitUntil: 'domcontentloaded' });
    await pages[actor]
      .locator(`.app-shell[data-active-role="${actor}"]`)
      .waitFor({ timeout: 20_000 });
  }
  const productionReloadSnapshot = await apiRequest('/api/production/orders', {
    token: sessions.production.token,
  });
  const productionReloadOrders = productionReloadSnapshot.filter(
    (candidate) => candidate.id === productionOrder.id,
  );
  await openTopNavigationSection(pages.production, 'Заказ-наряды');
  await waitForBodyText(
    pages.production,
    orderNumber,
    'CD-7 production browser reload renders accepted order',
  );
  const acceptedProductionRow = pages.production
    .locator(
      '.production-orders-hub .plenki-data-table tbody > tr:not(.plenki-data-table-expanded-row)',
    )
    .filter({ hasText: orderNumber });
  assert(
    (await acceptedProductionRow.count()) === 1 &&
      (await acceptedProductionRow.innerText()).includes('Принят складом'),
    'CD-7 production order row omitted the accepted terminal label',
  );
  await acceptedProductionRow.locator('.production-order-disclosure').click();
  const acceptedProductionRollRows = pages.production.locator(
    '.production-order-expanded .plenki-nested-table tbody > tr.status-warehouse_accepted',
  );
  assert(
    (await acceptedProductionRollRows.count()) === 2 &&
      (
        await Promise.all(
          rolls.map(async (candidate) => {
            const exact = acceptedProductionRollRows.filter({ hasText: candidate.rollCode });
            return (
              (await exact.count()) === 1 && (await exact.innerText()).includes('Принят складом')
            );
          }),
        )
      ).every(Boolean),
    'CD-7 production expanded row lost accepted roll identities',
  );
  const productionReloadText = await pages.production.locator('body').innerText();
  assert(
    productionReloadOrders.length === 1 &&
      productionReloadOrders[0].dispatchItems?.length === 2 &&
      rolls.every((candidate) =>
        productionReloadOrders[0].dispatchItems.some(
          (item) =>
            item.id === candidate.id &&
            item.rollCode === candidate.rollCode &&
            item.operatorLine?.warehouseState === 'received',
        ),
      ) &&
      productionReloadText.includes(orderNumber) &&
      productionReloadText.includes('Принят складом'),
    `CD-7 production browser reload lost or duplicated ${orderNumber}: ${JSON.stringify(productionReloadOrders)}`,
  );
  for (const [role, page] of [
    ['commercial', pages.commercial],
    ['director', pages.director],
  ]) {
    const { table } = await openBusinessProductionRolls(page, orderNumber);
    await waitUntil(`CD-7 ${role} browser reload keeps accepted identities`, async () =>
      Promise.all(
        rolls.map(async (candidate) => {
          const row = table
            .locator('.production-roll-drilldown-item')
            .filter({ hasText: candidate.rollCode });
          return (await row.count()) === 1 && (await row.innerText()).includes('Принят складом');
        }),
      ).then((states) => states.every(Boolean)),
    );
  }
  await openTopNavigationSection(pages.warehouse, 'Все рулоны');
  const acceptedStockWorkspace = pages.warehouse.locator('.warehouse-stock-workspace');
  const acceptedStockResponse = pages.warehouse.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/warehouse/inventory/rolls' &&
        url.searchParams.get('q') === orderNumber &&
        response.request().method() === 'GET'
      );
    },
    { timeout: 8_000 },
  );
  await acceptedStockWorkspace.getByLabel('Поиск рулонов').fill(orderNumber);
  const acceptedStockPayload = await (await acceptedStockResponse).json();
  const ownedAcceptedStock = acceptedStockPayload.items.filter((item) =>
    rolls.some((candidate) => candidate.rollCode === item.rollCode),
  );
  assert(
    ownedAcceptedStock.length === 2 &&
      new Set(ownedAcceptedStock.map((item) => item.rollCode)).size === 2 &&
      ownedAcceptedStock.every(
        (item) =>
          item.orderNumber === orderNumber && item.warehouseStatusLabel === 'Принят складом',
      ),
    `CD-7 warehouse reload lost accepted roll identities: ${JSON.stringify(ownedAcceptedStock)}`,
  );
  for (const candidate of rolls) {
    assert(
      (await acceptedStockWorkspace.getByText(candidate.rollCode, { exact: true }).count()) === 1,
      `CD-7 warehouse UI duplicated or omitted ${candidate.rollCode}`,
    );
  }
  await verifyRoleSafeBusinessCodePresentation(pages, rolls[0].rollCode);
  const staleLifecycleRequestCount = await verifyDelayedProductionLifecycleCannotRegress({
    page: pages.director,
    orderNumber,
    rollPath: acceptedLifecycle.rollPath,
    acceptedRolls: acceptedLifecycle.commercialRolls,
    rolls,
  });
  const directorManualRefresh = await verifyDirectorProductionManualRefresh({
    page: pages.director,
    orderNumber,
    rollPath: handedOffLifecycle.rollPath,
    rolls,
  });

  let deliveryTask = null;
  try {
    await waitUntil('automatic warehouse delivery task', async () => {
      deliveryTask = await prisma.warehouseAcceptanceTask.findUnique({
        where: { deliveryScopeKey: `warehouse_delivery:${orderId}` },
        include: { rows: true },
      });
      return Boolean(deliveryTask);
    });
  } catch (error) {
    const [warehouseRoll, commercialOrder] = await Promise.all([
      prisma.warehouseRoll.findUnique({
        where: { rollCode: roll.rollCode },
        select: {
          warehouseStatus: true,
          reservedForOrderId: true,
          reservedForPositionId: true,
          reservedByCoverageDecisionId: true,
        },
      }),
      prisma.commercialOrder.findUnique({
        where: { id: orderId },
        select: {
          productionIndicator: true,
          shipmentStatus: true,
          warehouseCoverageWorkflowVersion: true,
        },
      }),
    ]);
    throw new Error(
      `Automatic delivery handoff failed: ${JSON.stringify({ warehouseRoll, commercialOrder })}`,
      { cause: error },
    );
  }
  assert(
    deliveryTask?.rows.length === 2 &&
      rolls.every((ownedRoll) =>
        deliveryTask.rows.some((row) => row.rollCode === ownedRoll.rollCode),
      ),
    'Automatic delivery task has the wrong roll set',
  );
  await openTopNavigationSection(pages.warehouse, 'Выдача');
  const deliveryRefresh = pages.warehouse.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/warehouse/tasks' &&
      new URL(response.url()).searchParams.get('mode') === 'delivery' &&
      response.request().method() === 'GET',
    { timeout: 8_000 },
  );
  await focusRefresh(pages.warehouse);
  const deliveryRefreshPayload = await (await deliveryRefresh).json();
  assert(
    deliveryRefreshPayload.some((task) => task.id === deliveryTask.id),
    'Warehouse delivery refresh did not expose the owned task',
  );
  const deliveryDetail = await openWarehouseTask(
    pages.warehouse,
    `delivery-${deliveryTask.id}`,
    orderNumber,
    roll.rollCode,
    'owned delivery task visible in warehouse UI',
  );
  for (const [index, ownedRoll] of rolls.entries()) {
    const deliveryScan = pages.warehouse.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/tasks/${deliveryTask.id}/scans`) &&
        response.request().method() === 'POST',
      { timeout: 8_000 },
    );
    await pages.warehouse
      .getByLabel('Сканирование QR')
      .fill(printedQrByRoll.get(ownedRoll.rollCode));
    await pages.warehouse.getByLabel('Сканирование QR').press('Enter');
    const deliveryScanResponse = await deliveryScan;
    assert(
      deliveryScanResponse.status() === 201,
      `Delivery UI scan for ${ownedRoll.rollCode} failed`,
    );
    const deliveryScanResult = await deliveryScanResponse.json();
    assert(
      deliveryScanResult.taskId === deliveryTask.id &&
        deliveryScanResult.rollCode === ownedRoll.rollCode &&
        deliveryScanResult.scanStatus === 'accepted' &&
        deliveryScanResult.task?.closable === (index === rolls.length - 1),
      `Delivery UI scan rejected ${ownedRoll.rollCode}: ${JSON.stringify(deliveryScanResult)}`,
    );
  }
  const deliveryPostScanRefresh = pages.warehouse.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/warehouse/tasks' &&
      new URL(response.url()).searchParams.get('mode') === 'delivery' &&
      response.request().method() === 'GET',
    { timeout: 8_000 },
  );
  await focusRefresh(pages.warehouse);
  const deliveryPostScanPayload = await (await deliveryPostScanRefresh).json();
  assert(
    deliveryPostScanPayload.some(
      (task) =>
        task.id === deliveryTask.id &&
        task.rows.length === 2 &&
        rolls.every((ownedRoll) =>
          task.rows.some(
            (row) => row.rollCode === ownedRoll.rollCode && row.scanStatus === 'accepted',
          ),
        ),
    ),
    'Warehouse delivery refresh did not expose the accepted owned roll',
  );
  const deliveryCloseScope = deliveryDetail.locator(
    '.warehouse-roll-table > .operator-panel-title',
  );
  await waitUntil('warehouse delivery close enabled for owned task', async () => {
    const button = deliveryCloseScope.locator('.warehouse-close-inline-action');
    return (await button.count()) === 1 && (await button.isEnabled());
  });
  await clickAndWait(
    pages.warehouse,
    'Закрыть выдачу',
    (response) => new URL(response.url()).pathname.endsWith(`/tasks/${deliveryTask.id}/close`),
    deliveryCloseScope,
  );

  for (const actor of ['commercial', 'production', 'warehouse', 'director']) {
    expectedReloads.set(actor, (expectedReloads.get(actor) ?? 0) + 1);
    intentionalReloadCount += 1;
    await pages[actor].reload({ waitUntil: 'domcontentloaded' });
    await pages[actor]
      .locator(`.app-shell[data-active-role="${actor}"]`)
      .waitFor({ state: 'visible', timeout: 20_000 });
  }
  await assertBusinessProductionLifecycle({
    pages,
    sessions,
    productionOrderId: productionOrder.id,
    orderNumber,
    rolls,
    lifecycleStatus: 'warehouse_delivered',
    label: 'Выдан со склада',
  });

  await openTopNavigationSection(pages.production, 'Заказ-наряды');
  await waitForBodyText(
    pages.production,
    orderNumber,
    'CD-7 production post-delivery reload renders exact order',
  );
  const deliveredProductionRow = pages.production
    .locator(
      '.production-orders-hub .plenki-data-table tbody > tr:not(.plenki-data-table-expanded-row)',
    )
    .filter({ hasText: orderNumber });
  assert(
    (await deliveredProductionRow.count()) === 1 &&
      (await deliveredProductionRow.innerText()).includes('Выдан со склада'),
    'CD-7 production post-delivery reload omitted the terminal order label',
  );
  await deliveredProductionRow.locator('.production-order-disclosure').click();
  const deliveredProductionRollRows = pages.production.locator(
    '.production-order-expanded .plenki-nested-table tbody > tr.status-warehouse_delivered',
  );
  const deliveredProductionIdentities = await Promise.all(
    rolls.map(async (candidate) => {
      const exact = deliveredProductionRollRows.filter({ hasText: candidate.rollCode });
      return (await exact.count()) === 1 && (await exact.innerText()).includes('Выдан со склада');
    }),
  );
  assert(
    (await deliveredProductionRollRows.count()) === 2 &&
      deliveredProductionIdentities.every(Boolean),
    'CD-7 production post-delivery reload lost or duplicated terminal roll identities',
  );

  await openTopNavigationSection(pages.warehouse, 'Выдача');
  const closedDeliveryResponse = pages.warehouse.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/warehouse/tasks' &&
        url.searchParams.get('mode') === 'delivery' &&
        response.request().method() === 'GET'
      );
    },
    { timeout: 8_000 },
  );
  await focusRefresh(pages.warehouse);
  const closedDeliveryResult = await closedDeliveryResponse;
  assert(closedDeliveryResult.ok(), 'CD-7 closed delivery task refresh failed after hard reload');
  const closedDeliveryFailure = await closedDeliveryResult.finished();
  assert(!closedDeliveryFailure, `CD-7 closed delivery task body failed: ${closedDeliveryFailure}`);
  const closedDeliveryPayload = await closedDeliveryResult.json();
  const ownedClosedTasks = closedDeliveryPayload.filter((task) => task.id === deliveryTask.id);
  const ownedClosedTask = ownedClosedTasks[0];
  const ownedClosedRows = ownedClosedTask?.rows ?? [];
  assert(
    ownedClosedTasks.length === 1 &&
      ownedClosedTask.mode === 'delivery' &&
      ownedClosedTask.status === 'closed' &&
      ownedClosedRows.length === 2 &&
      new Set(ownedClosedRows.map((row) => row.id)).size === 2 &&
      new Set(ownedClosedRows.map((row) => row.rollCode)).size === 2 &&
      rolls.every((candidate) => {
        const expected = deliveryTask.rows.find((row) => row.rollCode === candidate.rollCode);
        const row = ownedClosedRows.find((entry) => entry.rollCode === candidate.rollCode);
        return Boolean(expected && row && expected.id === row.id && row.scanStatus === 'accepted');
      }),
    `CD-7 warehouse post-delivery reload lost the closed task identities: ${JSON.stringify(ownedClosedTasks)}`,
  );
  const closedDeliveryDetail = await openWarehouseTask(
    pages.warehouse,
    `delivery-${deliveryTask.id}`,
    orderNumber,
    roll.rollCode,
    'CD-7 closed delivery task visible after warehouse hard reload',
  );
  assert(
    (await closedDeliveryDetail.innerText()).includes('Выдача закрыта'),
    'CD-7 warehouse post-delivery UI omitted the closed terminal label',
  );
  const closedDeliveryRollRows = closedDeliveryDetail.locator('[data-roll-code]');
  const closedDeliveryIdentities = await Promise.all(
    rolls.map(async (candidate) => {
      const exact = closedDeliveryDetail.locator(`[data-roll-code="${candidate.rollCode}"]`);
      return (await exact.count()) === 1 && (await exact.innerText()).includes('Принят');
    }),
  );
  assert(
    (await closedDeliveryRollRows.count()) === 2 && closedDeliveryIdentities.every(Boolean),
    'CD-7 warehouse post-delivery UI lost or duplicated closed delivery roll identities',
  );

  const shippedCommercialDetail = await openCommercialOrder(
    pages.commercial,
    'Выполненные',
    orderId,
    orderNumber,
  );
  await waitUntil('CD-7 commercial post-delivery reload keeps exact shipment', async () => {
    const text = await shippedCommercialDetail.innerText();
    return text.includes(orderNumber) && text.includes('Отгружено');
  });
  await openOwnedCommercialControl(
    pages.commercial,
    sessions.commercial.token,
    'Заказ отгружен',
    orderId,
    orderNumber,
    shippedCommercialDetail,
    'warehouse close visible in commercial Control',
    rolls.map((candidate) => candidate.rollCode),
  );
  await focusRefresh(pages.finance);
  const shippedFinanceDetail = pages.finance
    .locator('article.detail-view')
    .filter({ hasText: orderNumber })
    .filter({ has: pages.finance.locator('.finance-selected-command') });
  await waitUntil('warehouse close updates owned finance order status', async () => {
    if ((await shippedFinanceDetail.count()) !== 1 || !(await shippedFinanceDetail.isVisible())) {
      return false;
    }
    return (await shippedFinanceDetail.innerText()).toLocaleLowerCase('ru').includes('отгружено');
  });
  await waitForControl(
    pages.finance,
    'Заказ отгружен',
    financeOrder.id,
    'warehouse close visible in finance Control',
  );

  await apiRequest(`/api/finance/orders/${financeOrder.id}/problems`, {
    token: sessions.finance.token,
    method: 'POST',
    body: {
      kind: 'overdue',
      reason: `Cross-contour live smoke overdue ${orderNumber}`,
      evidence: 'Time-based overdue setup is not exposed as a deterministic MVP UI action.',
    },
  });
  console.log('SETUP_SEAM overdue clock: deterministic time travel is not exposed by MVP UI');
  await waitForControl(
    pages.director,
    'Просрочка требует контроля',
    financeOrder.id,
    'overdue problem visible in director Control',
  );

  const incidentPost = await prisma.post.findUniqueOrThrow({
    where: { code: 'POST-5' },
    include: { devices: { where: { kind: 'scale', isEnabled: true } } },
  });
  assert(incidentPost.devices.length === 1, 'POST-5 must have exactly one enabled smoke scale');
  const incidentDevice = incidentPost.devices[0];
  const gatewayToken = 'agent-post-5';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await gatewayRequest('/api/gateway/ingest', gatewayToken, {
      eventId: `smoke-outage-${runId}-${attempt + 1}`,
      kind: 'status',
      payload: { deviceId: incidentDevice.id, status: 'offline' },
      rawPayload: { canary: rawPayloadCanary, attempt },
    });
  }
  let incident;
  await waitUntil('device outage creates one durable incident episode', async () => {
    incident = await prisma.operationalIncident.findFirst({
      where: { targetId: incidentDevice.id, status: { not: 'resolved' } },
    });
    if (!incident) return false;
    const openedEvents = await prisma.domainEvent.count({
      where: { type: 'admin.incident.opened', objectId: incident.id },
    });
    return openedEvents === 1;
  });
  assert(incident, 'Gateway outage did not create an incident');
  const initialDetectedAt = incident.detectedAt;
  await waitForControl(
    pages.admin,
    'Открыт технический инцидент',
    incident.id,
    'admin A receives one outage card across retries',
  );
  await waitForControl(
    pages.adminB,
    'Открыт технический инцидент',
    incident.id,
    'admin B receives the same independent outage card',
  );

  await markControlCardRead(
    pages.admin,
    'Открыт технический инцидент',
    incident.id,
    'admin A marks outage read',
  );
  await waitUntil('admin read state remains independent', async () => {
    const [adminAInbox, adminBInbox] = await Promise.all([
      apiRequest('/api/admin/notifications?limit=100', { token: sessions.admin.token }),
      apiRequest('/api/admin/notifications?limit=100', { token: sessions.adminB.token }),
    ]);
    const adminAItem = adminAInbox.items.find(
      (item) => item.id && item.cta?.targetId === incident.id,
    );
    const adminBItem = adminBInbox.items.find(
      (item) => item.id && item.cta?.targetId === incident.id,
    );
    return adminAItem === undefined && adminBItem?.unread === true;
  });
  await waitForControl(
    pages.adminB,
    'Открыт технический инцидент',
    incident.id,
    'admin incident opens exact row',
    { open: true },
  );
  await waitUntil('admin incident URL and focus are exact', async () => {
    const target = pages.adminB.locator(`[data-incident-id="${incident.id}"]`);
    return (
      new URL(pages.adminB.url()).searchParams.get('incident') === incident.id &&
      (await target.count()) === 1 &&
      (await target.isVisible()) &&
      (await target.evaluate((element) => document.activeElement === element))
    );
  });

  const nonAdminInboxRoutes = {
    commercial: '/api/commercial/notifications?limit=100',
    finance: '/api/finance/notifications?limit=100',
    production: '/api/production/notifications?limit=100',
    operator: '/api/operator/notifications?limit=100',
    warehouse: '/api/warehouse/notifications?limit=100',
    director: '/api/director/notifications?limit=100',
  };
  for (const [role, pathname] of Object.entries(nonAdminInboxRoutes)) {
    const inbox = await apiRequest(pathname, { token: sessions[role].token });
    assert(
      inbox.items.every(
        (item) =>
          item.eventType !== 'admin.incident.opened' &&
          item.eventType !== 'admin.incident.reopened' &&
          item.cta?.targetId !== incident.id,
      ),
      `${role} received an admin diagnostic incident`,
    );
  }

  await gatewayRequest('/api/gateway/heartbeat', gatewayToken, {
    devices: [{ deviceId: incidentDevice.id, status: 'ready' }],
  });
  await waitUntil('device recovery resolves the current incident', async () => {
    const recovered = await prisma.operationalIncident.findUnique({
      where: { id: incident.id },
    });
    return recovered?.status === 'resolved' && Boolean(recovered.resolvedAt);
  });
  await gatewayRequest('/api/gateway/ingest', gatewayToken, {
    eventId: `smoke-reopen-${runId}`,
    kind: 'status',
    payload: { deviceId: incidentDevice.id, status: 'offline' },
    rawPayload: { canary: rawPayloadCanary, episode: 2 },
  });
  await waitUntil('recovery plus outage opens a new incident episode', async () => {
    const [reopened, reopenedEvents] = await Promise.all([
      prisma.operationalIncident.findUnique({ where: { id: incident.id } }),
      prisma.domainEvent.count({
        where: { type: 'admin.incident.reopened', objectId: incident.id },
      }),
    ]);
    return (
      reopened?.status === 'open' &&
      reopened.detectedAt.getTime() > initialDetectedAt.getTime() &&
      reopenedEvents === 1
    );
  });
  await waitForControl(
    pages.admin,
    'Технический инцидент повторился',
    incident.id,
    'reopened incident creates a new admin card',
  );
  const incidentEvents = await prisma.domainEvent.findMany({
    where: {
      objectId: incident.id,
      type: { in: ['admin.incident.opened', 'admin.incident.reopened'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  assert(
    incidentEvents.map((event) => event.type).join(',') ===
      'admin.incident.opened,admin.incident.reopened',
    `Incident retry/reopen event sequence is not exact: ${incidentEvents
      .map((event) => event.type)
      .join(',')}`,
  );

  await businessPerformanceSmoke.assertApiContract(sessions, orderNumber, productionOrder.id);
  for (const section of ['Контроль', 'Финансы', 'Производство', 'Склад']) {
    await businessPerformanceSmoke.assertUiSection(pages, section, orderNumber);
  }
  await businessPerformanceSmoke.assertProductionDrilldown(pages, orderNumber);
  await businessPerformanceSmoke.assertDirectorOnlyBoundary(pages);

  for (const page of Object.values(pages)) await focusRefresh(page);
  await Promise.all(responseInspections);
  for (const [actor, page] of Object.entries(pages)) {
    const visibleText = await page.locator('body').innerText();
    assert(!visibleText.includes(rawPayloadCanary), `${actor} DOM leaked the raw payload canary`);
  }
  assert(
    networkCanaryLeaks.length === 0,
    `Browser API responses leaked raw payload: ${networkCanaryLeaks.join('; ')}`,
  );
  const finalBuiltAsset = builtAssetSnapshot();
  const finalBrowserEntry = await browserEntrySnapshot(pages.commercial);
  assert(
    finalBuiltAsset.relativePath === initialBuiltAsset.relativePath &&
      finalBuiltAsset.sha256 === initialBuiltAsset.sha256 &&
      finalBuiltAsset.bytes === initialBuiltAsset.bytes &&
      finalBrowserEntry.url === `/${finalBuiltAsset.relativePath}` &&
      finalBrowserEntry.url === initialBrowserEntry.url &&
      finalBrowserEntry.sha256 === finalBuiltAsset.sha256 &&
      finalBrowserEntry.sha256 === initialBrowserEntry.sha256 &&
      finalBrowserEntry.bytes === finalBuiltAsset.bytes &&
      finalBrowserEntry.bytes === initialBrowserEntry.bytes &&
      finalBrowserEntry.cacheControl?.includes('no-cache') &&
      finalBrowserEntry.etag === initialBrowserEntry.etag &&
      finalBrowserEntry.serviceWorkerControlled === false &&
      finalBrowserEntry.serviceWorkerRegistrations === 0 &&
      finalBrowserEntry.cacheKeys.length === 0,
    `CD-8 JavaScript asset changed or came from stale browser cache: ${JSON.stringify({
      initialBuiltAsset,
      finalBuiltAsset,
      initialBrowserEntry,
      finalBrowserEntry,
    })}`,
  );

  await screenshot(pages.commercial, 'final-commercial-1024x768.png', 1024, 768);
  await screenshot(pages.production, 'final-production-1024x768.png', 1024, 768);
  await screenshot(pages.operator, 'final-operator-1024x768.png', 1024, 768);
  await screenshot(pages.warehouse, 'final-warehouse-1024x768.png', 1024, 768);
  await screenshot(pages.admin, 'final-admin-1024x768.png', 1024, 768);
  await screenshot(pages.director, 'final-director-1440x900.png', 1440, 900);
  await screenshot(pages.warehouse, 'final-warehouse-390x844.png', 390, 844);
  for (const [label, page] of [
    ['director 1440x900', pages.director],
    ['warehouse 390x844', pages.warehouse],
  ]) {
    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    assert(
      layout.documentWidth <= layout.viewportWidth,
      `${label} leaked horizontal page overflow: ${JSON.stringify(layout)}`,
    );
  }

  assert(
    navigationViolations.length === 0,
    `Unexpected navigation/reload: ${navigationViolations.join('; ')}`,
  );
  assert(
    [...expectedReloads.values()].every((remaining) => remaining === 0),
    `Expected browser reload was not observed: ${JSON.stringify(Object.fromEntries(expectedReloads))}`,
  );
  assert(browserErrors.length === 0, `Browser page errors: ${browserErrors.join('; ')}`);
  assert(
    browserConsoleErrors.length === 0,
    `Browser console errors: ${browserConsoleErrors.join('; ')}`,
  );
  assert(
    operatorBShiftCloseConflictConsoleCount === 1,
    `Expected exactly one browser console entry for the verified shift-close conflict, got ${operatorBShiftCloseConflictConsoleCount}`,
  );
  assert(
    browserRequestErrors.length === 0,
    `Browser request errors: ${browserRequestErrors.join('; ')}`,
  );
  assert(
    obsoleteWarehousePostRequests.length === 0,
    `Warehouse navigation requested obsolete post routes: ${obsoleteWarehousePostRequests.join(', ')}`,
  );
  assert(
    plannedWeightInputAttributes.min === '0.001' &&
      plannedWeightInputAttributes.max === '100000' &&
      plannedWeightInputAttributes.step === '0.001',
    `CD-8 planned-weight input attributes are not exact: ${JSON.stringify(plannedWeightInputAttributes)}`,
  );
  const result = [
    `PASS cross-contour live smoke`,
    `backend=${backendDir}@${backendCommit}`,
    `run=${runId}`,
    `order=${orderNumber}`,
    `roll=${roll.rollCode}`,
    `incident=${incident.id}`,
    `contexts=${Object.keys(actorConfig).join(',')}`,
    `viewports=390x844,1024x768,1440x900`,
    `checkpoints=${checkpoints.map((item) => `${item.label}:${item.elapsedMs}ms`).join(' | ')}`,
    `reloads=${intentionalReloadCount}`,
    `builtAsset=${initialBuiltAsset.relativePath}@${initialBuiltAsset.sha256}`,
    `rawPayloadLeaks=0`,
    `sharedBusinessWorkspace=verified`,
    `artifacts=ephemeral-cleaned:${outputDir}`,
  ].join('\n');
  writeFileSync(
    path.join(outputDir, 'evidence.json'),
    `${JSON.stringify(
      {
        runId,
        backend: { directory: backendDir, commit: backendCommit },
        databaseSchema: smokeSchema,
        viewports: [
          { width: 390, height: 844 },
          { width: 1024, height: 768 },
          { width: 1440, height: 900 },
        ],
        fixture: {
          orderId,
          orderNumber,
          productionOrderId: productionOrder.id,
          rollCode: roll.rollCode,
          unifiedInventory: inventoryFixture,
          defectProblemIds: createdDefects.map((fixture) => fixture.problem.id),
          incidentId: incident.id,
          paginationEventIds: paginationEvents.map((event) => event.id),
        },
        actors: Object.fromEntries(
          Object.entries(sessions).map(([actor, session]) => [
            actor,
            {
              userId: session.userId,
              role: session.serverRole,
            },
          ]),
        ),
        assertions: {
          currentUnifiedInventoryUiExact: true,
          automaticCoverageV2: true,
          automaticCoverageSystemAuditExact: true,
          routineWarehouseTaskAbsent: true,
          automaticAssignmentPublished: true,
          obsoleteManualApprovalAbsent: true,
          assignmentCardExact: true,
          reassignmentRecipientsExact: true,
          paginationComplete: true,
          defectRoutesExact: true,
          oneIncidentAcrossRetries: true,
          independentAdminReadState: true,
          incidentReopened: true,
          adminDiagnosticsExcludedFromOtherRoles: true,
          rawPayloadAbsentFromBrowser: true,
          sharedBusinessWorkspaceRoleParity: true,
          sharedControlColumnsExact: true,
          sharedFinancePaymentLabelExact: true,
          sharedProductionRollDrilldownSafe: true,
          sharedProblemsLiveRefresh: true,
          commercialDirectorActionsAbsent: true,
          directorOnlySurfacesReachable: true,
          warehouseTwoRollFlowExact: true,
          handoverLifecycleExact: true,
          acceptedLifecycleExact: true,
          deliveredLifecycleAfterHardReloadExact: true,
          deliveredWarehouseIdentityAfterHardReloadExact: true,
          delayedLifecycleResponseCannotRegress: staleLifecycleRequestCount >= 2,
          plannedWeightBoundaryExact: true,
          operatorBigBagCanonicalWeightExact: true,
          operatorBigBagPreReloadStaleResponseRejected: true,
          deferredRollResumeExact: true,
          directorProductionManualRefresh: directorManualRefresh,
          builtAssetStableAcrossReload: true,
          builtAsset: initialBuiltAsset,
          builtRoleSafePresentationAsset: {
            url: roleSafePresentationAsset.url,
            sha256: roleSafePresentationAsset.sha256,
            bytes: roleSafePresentationAsset.bytes,
          },
          browserEntry: finalBrowserEntry,
          intentionalReloads: intentionalReloadCount,
          unexpectedReloads: navigationViolations.length,
          browserErrors: browserErrors.length,
          browserConsoleErrors: browserConsoleErrors.length,
          expectedShiftCloseConflictConsoleErrors: operatorBShiftCloseConflictConsoleCount,
          browserRequestErrors: browserRequestErrors.length,
        },
        checkpoints,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(outputDir, 'result.txt'), `${result}\n`);
  console.log(result);
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  await browser?.close().catch(() => undefined);
  await stopChildren();
  try {
    await dropOwnedSchema();
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
    rmSync(roleSafePresentationAssetPath, { force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
}
