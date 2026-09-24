import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import {
  assertSmokeHealthy,
  collectVisibleErrors,
  installPageFailureTracker,
} from './release-smoke-runtime.mjs';

const viteBin = path.resolve('node_modules/.bin/vite');
const evidenceDirectory = await mkdtemp(
  path.join(tmpdir(), 'plenka-payroll-tariff-orders-'),
);
const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '390x844', width: 390, height: 844 },
  { name: 'reference-1470x834', width: 1470, height: 834, deviceScaleFactor: 2 },
];
const tariffBasePath = '/api/director/payroll-tariff-orders';
const forbiddenApiPrefixes = ['/api/gateway', '/api/admin/devices', '/api/onec'];
const activeOrderId = 'payroll-tariff-order-8-09-25-2025-09-29';
const flowDraftId = '11111111-1111-4111-8111-111111111111';
const conflictDraftId = '22222222-2222-4222-8222-222222222222';
const reviewedMatrixHash = 'a'.repeat(64);
const minimumPublishEffectiveFrom = '2026-08-14';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tariffMatrix() {
  return {
    schemaVersion: 1,
    ladders: {
      urp12h: [
        {
          maxInclusiveGrams: 750_000,
          primaryRateKopecksPerKg: 400,
          secondaryRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: 1_000_000,
          primaryRateKopecksPerKg: 450,
          secondaryRateKopecksPerKg: 550,
        },
        {
          maxInclusiveGrams: 1_250_000,
          primaryRateKopecksPerKg: 500,
          secondaryRateKopecksPerKg: 600,
        },
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: 550,
          secondaryRateKopecksPerKg: 650,
        },
      ],
      urp24h: [
        {
          maxInclusiveGrams: 1_500_000,
          primaryRateKopecksPerKg: 400,
          secondaryRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: 2_000_000,
          primaryRateKopecksPerKg: 450,
          secondaryRateKopecksPerKg: 550,
        },
        {
          maxInclusiveGrams: 2_500_000,
          primaryRateKopecksPerKg: 500,
          secondaryRateKopecksPerKg: 600,
        },
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: 550,
          secondaryRateKopecksPerKg: 650,
        },
      ],
      abc12h: [
        {
          maxInclusiveGrams: 1_300_000,
          standardRateKopecksPerKg: 450,
          blackWhiteRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: null,
          standardRateKopecksPerKg: 500,
          blackWhiteRateKopecksPerKg: 550,
        },
      ],
      abc24h: [
        {
          maxInclusiveGrams: 2_600_000,
          standardRateKopecksPerKg: 450,
          blackWhiteRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: null,
          standardRateKopecksPerKg: 500,
          blackWhiteRateKopecksPerKg: 550,
        },
      ],
    },
    specialRules: {
      thinRoll: { enabled: true, maxExclusiveGrams: 7_000, rateKopecksPerKg: 650 },
      alabuga: {
        enabled: true,
        machineFamily: 'abc_new',
        normalizedLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
        rateKopecksPerKg: 400,
      },
    },
  };
}

function activeOrder() {
  return {
    id: activeOrderId,
    name: 'Приказ № 8-09/25',
    effectiveFrom: '2025-09-29',
    currency: 'RUB',
    status: 'published',
    revision: 1,
    createdAt: '2025-09-29T00:00:00.000Z',
    updatedAt: '2025-09-29T00:00:00.000Z',
    publishedAt: '2025-09-29T00:00:00.000Z',
    matrix: tariffMatrix(),
    createdById: null,
    updatedById: null,
    publishedById: null,
  };
}

function listItem(order) {
  const {
    matrix: _matrix,
    createdById: _createdById,
    updatedById: _updatedById,
    publishedById: _publishedById,
    ...item
  } = order;
  return item;
}

function payrollPreview() {
  const order = activeOrder();
  return {
    status: 'complete',
    appliedTariffOrders: [
      {
        id: order.id,
        name: order.name,
        effectiveFrom: order.effectiveFrom,
        currency: order.currency,
        matrix: order.matrix,
      },
    ],
    range: {
      fromDate: '2026-08-01',
      toDate: '2026-08-13',
      timezone: 'Europe/Moscow',
      generatedAt: '2026-08-13T09:30:00.000Z',
    },
    summary: {
      payableAmountKopecks: 458_550,
      payableKg: 1_019,
      machineShiftCount: 2,
      operatorCount: 2,
      unresolvedKg: 0,
      unresolvedFactCount: 0,
      excludedDefectKg: 25,
      excludedDefectRollCount: 2,
    },
    operators: [
      {
        operatorId: 'operator-ruslan',
        operatorName: 'Хабибуллин Руслан',
        payableKg: 1_000,
        amountKopecks: 450_000,
        machineShiftCount: 1,
        unresolvedFactCount: 0,
      },
      {
        operatorId: 'operator-bulat',
        operatorName: 'Ахметов Булат',
        payableKg: 19,
        amountKopecks: 8_550,
        machineShiftCount: 1,
        unresolvedFactCount: 0,
      },
    ],
    breakdown: [
      {
        id: 'payroll-row-ruslan-2026-08-03',
        tariffOrderId: order.id,
        operatorId: 'operator-ruslan',
        operatorName: 'Хабибуллин Руслан',
        shiftId: 'shift-ruslan-2026-08-03',
        shiftLabel: 'Смена 03.08',
        shiftDate: '2026-08-03',
        postId: 'post-urp-1',
        postCode: 'УРП-1',
        postName: 'УРП',
        machineFamily: 'urp',
        shiftDuration: '12h',
        shiftOutputKg: 1_000,
        payableKg: 1_000,
        rateKopecksPerKg: 450,
        amountKopecks: 450_000,
        tariffRule: 'primary',
        basisLabel: 'Первичное сырьё, 12 часов',
        materialClass: 'primary',
        filmClass: null,
        specialCustomer: false,
      },
      {
        id: 'payroll-row-bulat-2026-08-04',
        tariffOrderId: order.id,
        operatorId: 'operator-bulat',
        operatorName: 'Ахметов Булат',
        shiftId: 'shift-bulat-2026-08-04',
        shiftLabel: 'Смена 04.08',
        shiftDate: '2026-08-04',
        postId: 'post-abc-1',
        postCode: 'АВС-1',
        postName: 'АВС новая',
        machineFamily: 'abc_new',
        shiftDuration: '12h',
        shiftOutputKg: 19,
        payableKg: 19,
        rateKopecksPerKg: 450,
        amountKopecks: 8_550,
        tariffRule: 'abc_standard',
        basisLabel: 'Стандартная плёнка, 12 часов',
        materialClass: null,
        filmClass: 'standard',
        specialCustomer: false,
      },
    ],
    unresolved: [],
  };
}

function actor() {
  return {
    userId: 'director-payroll-smoke',
    role: 'director',
    capabilities: ['director:read', 'payroll_tariff:manage'],
    displayName: 'Директор проверки',
    isActive: true,
    sessionPurpose: 'full',
    session: {
      id: 'session-director-payroll-smoke',
      purpose: 'full',
      state: 'active',
      createdAt: '2026-08-13T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      lastSeenAt: null,
    },
    workContext: { kind: 'office', assignment: null },
    passwordChangeRequired: false,
  };
}

function directorControl() {
  return {
    pendingDecisions: 8,
    penalties: 1,
    overdueOrders: 0,
    penaltiesAmount: 0,
    plannedInvoicedAmount: 0,
    paidAmount: 0,
    unbilledAmount: 0,
    overdueAmount: 0,
    producedKg: 0,
    defectKg: 0,
    warehouseAcceptedRolls: 0,
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function createFixtureState() {
  return {
    phase: 'initial',
    orders: new Map([[activeOrderId, activeOrder()]]),
    apiRequests: [],
    mutations: [],
    unhandledRequests: [],
    prohibitedRequests: [],
    conflictReturned: false,
  };
}

function tariffOrderList(state) {
  const items = [...state.orders.values()].map(listItem);
  const published = items.filter(({ status }) => status === 'published');
  return {
    items,
    activeOrderId,
    latestPublishedOrderId: published.at(-1)?.id ?? activeOrderId,
    minimumPublishEffectiveFrom,
    timezone: 'Europe/Moscow',
    generatedAt: '2026-08-13T09:30:00.000Z',
  };
}

function mutationBody(request) {
  const body = request.postDataJSON();
  assert(body && typeof body === 'object', 'mutation body is missing');
  return body;
}

function assertOperationKey(value, context) {
  assert(
    typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      ),
    `${context}: operationKey is not UUID v4`,
  );
}

async function installApiFixture(page, state) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    state.apiRequests.push(`${request.method()} ${pathname}${url.search}`);

    if (forbiddenApiPrefixes.some((prefix) => pathname.startsWith(prefix))) {
      state.prohibitedRequests.push(pathname);
      return json(route, { message: 'Forbidden integration route' }, 500);
    }

    if (pathname === '/api/auth/me') return json(route, actor());
    if (pathname === '/api/director/control') return json(route, directorControl());
    if (pathname === '/api/director/notifications') {
      return json(route, { items: [], nextCursor: null });
    }
    if (pathname === '/api/penalties/snapshot') {
      return json(route, {
        items: [],
        summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
      });
    }
    if (
      pathname === '/api/director/finance' ||
      pathname === '/api/director/production' ||
      pathname === '/api/director/warehouse' ||
      pathname === '/api/director/decisions' ||
      pathname === '/api/director/penalty-targets'
    ) {
      return json(route, []);
    }
    if (pathname === '/api/director/payroll-preview') {
      return json(route, payrollPreview());
    }

    if (pathname === tariffBasePath && request.method() === 'GET') {
      return json(route, tariffOrderList(state));
    }
    if (pathname === tariffBasePath && request.method() === 'POST') {
      const input = mutationBody(request);
      assertOperationKey(input.operationKey, 'create');
      assert(
        input.effectiveFrom >= minimumPublishEffectiveFrom,
        'create accepted a backdated effective date',
      );
      const id = state.phase === 'conflict' ? conflictDraftId : flowDraftId;
      const now = '2026-08-13T10:00:00.000Z';
      const order = {
        id,
        name: input.name,
        effectiveFrom: input.effectiveFrom,
        currency: 'RUB',
        status: 'draft',
        revision: 1,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
        matrix: structuredClone(input.matrix),
        createdById: 'director-payroll-smoke',
        updatedById: 'director-payroll-smoke',
        publishedById: null,
      };
      state.orders.set(id, order);
      state.mutations.push({ kind: 'create', id, input: structuredClone(input) });
      return json(route, { order, replayed: false }, 201);
    }

    if (pathname.startsWith(`${tariffBasePath}/`)) {
      const suffix = pathname.slice(tariffBasePath.length + 1);
      const [encodedId, action] = suffix.split('/');
      const id = decodeURIComponent(encodedId ?? '');
      const current = state.orders.get(id);
      if (!current) return json(route, { message: 'Приказ не найден' }, 404);

      if (!action && request.method() === 'GET') return json(route, current);
      if (!action && request.method() === 'PATCH') {
        const input = mutationBody(request);
        assertOperationKey(input.operationKey, 'update');
        assert(
          input.effectiveFrom >= minimumPublishEffectiveFrom,
          'update accepted a backdated effective date',
        );
        state.mutations.push({ kind: 'update', id, input: structuredClone(input) });
        if (state.phase === 'conflict' && !state.conflictReturned) {
          state.conflictReturned = true;
          state.orders.set(id, {
            ...current,
            name: 'Серверная параллельная редакция',
            revision: 2,
            updatedAt: '2026-08-13T10:05:00.000Z',
          });
          return json(
            route,
            {
              code: 'PAYROLL_TARIFF_ORDER_DRAFT_STALE',
              message: 'Черновик изменён другим пользователем',
            },
            409,
          );
        }
        assert(
          input.expectedRevision === current.revision,
          `update expectedRevision ${input.expectedRevision} does not match ${current.revision}`,
        );
        const order = {
          ...current,
          name: input.name,
          effectiveFrom: input.effectiveFrom,
          matrix: structuredClone(input.matrix),
          revision: current.revision + 1,
          updatedAt: '2026-08-13T10:10:00.000Z',
        };
        state.orders.set(id, order);
        return json(route, { order, replayed: false });
      }
      if (action === 'review' && request.method() === 'POST') {
        const input = mutationBody(request);
        assert(
          input.expectedRevision === current.revision,
          'review expectedRevision does not match saved draft',
        );
        state.mutations.push({ kind: 'review', id, input: structuredClone(input) });
        return json(route, {
          orderId: id,
          revision: current.revision,
          matrixHash: reviewedMatrixHash,
          minimumPublishEffectiveFrom,
          publishable: true,
          fieldErrors: [],
        });
      }
      if (action === 'publish' && request.method() === 'POST') {
        const input = mutationBody(request);
        assertOperationKey(input.operationKey, 'publish');
        assert(input.expectedRevision === current.revision, 'publish revision drifted');
        assert(input.reviewedMatrixHash === reviewedMatrixHash, 'review hash drifted');
        state.mutations.push({ kind: 'publish', id, input: structuredClone(input) });
        const order = {
          ...current,
          status: 'published',
          publishedAt: '2026-08-13T10:15:00.000Z',
          publishedById: 'director-payroll-smoke',
          updatedAt: '2026-08-13T10:15:00.000Z',
        };
        state.orders.set(id, order);
        return json(route, { order, replayed: false });
      }
    }

    state.unhandledRequests.push(`${request.method()} ${pathname}`);
    return json(route, { message: 'Unhandled payroll tariff smoke route' }, 500);
  });
}

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address === 'object', 'Could not reserve preview port');
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function startPreview() {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const vitePreviewArgs = [
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ];
  const server = spawn(viteBin, vitePreviewArgs, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Vite preview exited before ready.\n${logs.join('').slice(-2_000)}`);
    }
    try {
      if ((await fetch(baseUrl, { cache: 'no-store' })).ok) return { baseUrl, server };
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server.kill('SIGTERM');
  throw new Error(`Vite preview did not start.\n${logs.join('').slice(-2_000)}`);
}

async function stopPreview(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    once(server, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}

async function seedDirectorSession(context) {
  await context.addInitScript(() => {
    localStorage.setItem(
      'plenki.auth.v1',
      JSON.stringify({
        version: 1,
        token: 'payroll-tariff-smoke-token',
        role: 'director',
        serverRole: 'director',
        userId: 'director-payroll-smoke',
        displayName: 'Директор проверки',
        expiresAt: '2099-01-01T00:00:00.000Z',
        passwordChangeRequired: false,
      }),
    );
  });
}

async function waitForPayrollSurface(page) {
  const surface = page.locator('.director-payroll-surface');
  await surface.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => {
    const root = document.querySelector('.director-payroll-surface');
    return root && !root.textContent?.includes('Загрузка расчёта зарплаты');
  });
  return surface;
}

async function assertNoHorizontalOverflow(page, context) {
  const horizontalOverflow = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert(
    horizontalOverflow.documentWidth <= horizontalOverflow.viewportWidth + 1 &&
      horizontalOverflow.bodyWidth <= horizontalOverflow.viewportWidth + 1,
    `${context}: horizontal overflow ${JSON.stringify(horizontalOverflow)}`,
  );
}

async function assertDialogLayout(page, viewport) {
  const layout = await page.getByRole('dialog', { name: 'Приказы по тарифам' }).evaluate(
    (dialog, expected) => {
      const rect = dialog.getBoundingClientRect();
      const body = dialog.querySelector('.payroll-tariff-order-dialog-body');
      const footer = dialog.querySelector('.payroll-tariff-order-dialog-footer');
      const footerRect = footer?.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        withinViewport:
          rect.left >= -1 &&
          rect.top >= -1 &&
          rect.right <= expected.width + 1 &&
          rect.bottom <= expected.height + 1,
        bodyOverflowX: body ? getComputedStyle(body).overflowX : null,
        bodyClientWidth: body?.clientWidth ?? null,
        bodyScrollWidth: body?.scrollWidth ?? null,
        footerVisible:
          footerRect !== undefined &&
          footerRect.top >= rect.top - 1 &&
          footerRect.bottom <= rect.bottom + 1,
      };
    },
    viewport,
  );
  assert(layout.withinViewport, `${viewport.name}: tariff dialog is clipped`);
  assert(layout.footerVisible, `${viewport.name}: workflow footer is clipped`);
  if (viewport.width === 390) {
    assert(layout.width === 390, `390px: dialog width is ${layout.width}`);
    assert(layout.height === 844, `390px: dialog height is ${layout.height}`);
    assert(layout.bodyOverflowX !== 'hidden', '390px: dialog masks a desktop layout');
    assert(
      layout.bodyClientWidth !== null &&
        layout.bodyScrollWidth !== null &&
        layout.bodyScrollWidth <= layout.bodyClientWidth + 1,
      `390px: dialog body leaks horizontally ${JSON.stringify(layout)}`,
    );
  }
}

async function assertDisclosureKeyboard(page) {
  const disclosure = page.getByRole('button', {
    name: 'Показать тарифы по применённым приказам',
  });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  assert((await disclosure.getAttribute('aria-expanded')) === 'true', 'disclosure did not open');
  await page.locator('[data-payroll-tariff-order="true"]').waitFor({ state: 'visible' });
  assert(
    (await disclosure.innerText()).includes('Нажмите, чтобы посмотреть тарифы'),
    'disclosure hint is missing',
  );
  await page.keyboard.press('Enter');
  assert((await disclosure.getAttribute('aria-expanded')) === 'false', 'disclosure did not close');
}

async function openTariffDialog(page) {
  const trigger = page.getByRole('button', {
    name: 'Создать новый приказ по тарифам',
    exact: true,
  });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Приказы по тарифам' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel('Название приказа').waitFor();
  return { dialog, trigger };
}

async function closeWithFocusRestore(page, dialog, trigger, context) {
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert(
    await trigger.evaluate((element) => document.activeElement === element),
    `${context}: Escape did not restore focus`,
  );
}

async function closeWithButtonAndFocusRestore(dialog, trigger, context) {
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert(
    await trigger.evaluate((element) => document.activeElement === element),
    `${context}: close button did not restore focus`,
  );
}

async function assertCancelCreatesNoDraft(page, state, viewport) {
  const mutationCount = state.mutations.length;
  const { dialog, trigger } = await openTariffDialog(page);
  await assertDialogLayout(page, viewport);
  await dialog.getByText(/^Опубликован · редакция \d+$/u).first().waitFor({ state: 'visible' });
  assert(
    await dialog.getByText('Дата указана по Москве', { exact: true }).isVisible(),
    'Moscow date help is absent',
  );
  await closeWithFocusRestore(page, dialog, trigger, `${viewport.name} cancel`);
  assert(state.mutations.length === mutationCount, 'Cancel created an orphan draft');
}

async function assertPublishedReadOnly(dialog) {
  await dialog
    .getByText('Опубликованная версия доступна только для чтения', { exact: true })
    .waitFor();
  assert(
    (await dialog.getByRole('button', { name: 'Сохранить черновик', exact: true }).count()) === 0,
    'published order still exposes Save',
  );
  assert(
    (await dialog.getByRole('button', { name: 'Опубликовать', exact: true }).count()) === 0,
    'published order still exposes Publish',
  );
  assert(!(await dialog.innerText()).includes('Удалить приказ'), 'delete action leaked');
}

async function assertCreateSaveReviewPublish(page, state) {
  state.phase = 'flow';
  const { dialog, trigger } = await openTariffDialog(page);
  await dialog.getByLabel('Название приказа').fill('Приказ № 10-08/26');
  const rate = dialog.locator('input[aria-label*="Первичное сырьё"]').first();
  await rate.fill('777');

  const createResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === tariffBasePath &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await createResponse;
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Проверить приказ',
    );
    return button instanceof HTMLButtonElement && !button.disabled;
  });

  const reviewResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/review') && response.request().method() === 'POST';
  });
  await dialog.getByRole('button', { name: 'Проверить приказ', exact: true }).click();
  await reviewResponse;
  await dialog.getByText('Редакция 1 проверена', { exact: true }).waitFor();

  const publishResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/publish') && response.request().method() === 'POST';
  });
  await dialog.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await publishResponse;
  await assertPublishedReadOnly(dialog);

  const flowMutations = state.mutations.filter(({ id }) => id === flowDraftId);
  assert(
    JSON.stringify(flowMutations.map(({ kind }) => kind)) ===
      JSON.stringify(['create', 'review', 'publish']),
    `create/review/publish order drifted: ${JSON.stringify(flowMutations)}`,
  );
  assert(
    flowMutations[0].input.matrix.ladders.urp12h[0].primaryRateKopecksPerKg === 777,
    'edited integer kopeck rate did not reach create payload',
  );
  assertOperationKey(flowMutations[0].input.operationKey, 'flow create');
  assertOperationKey(flowMutations[2].input.operationKey, 'flow publish');
  assert(
    flowMutations[0].input.operationKey !== flowMutations[2].input.operationKey,
    'create and publish reused one operation key',
  );
  await closeWithButtonAndFocusRestore(dialog, trigger, 'published flow');
}

async function assertStaleConflictRetainsInput(page, state) {
  state.phase = 'conflict';
  const { dialog, trigger } = await openTariffDialog(page);
  const save = dialog.getByRole('button', { name: 'Сохранить черновик', exact: true });
  const createResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === tariffBasePath &&
      response.request().method() === 'POST',
  );
  await save.click();
  await createResponse;
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Проверить приказ',
    );
    return button instanceof HTMLButtonElement && !button.disabled;
  });

  const localName = 'Локальная редакция после конфликта';
  await dialog.getByLabel('Название приказа').fill(localName);
  const conflictResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${tariffBasePath}/${conflictDraftId}` &&
      response.request().method() === 'PATCH' &&
      response.status() === 409,
  );
  await save.click();
  await conflictResponse;
  await dialog.getByText('Черновик изменён другим пользователем', { exact: true }).waitFor();
  assert((await dialog.getByLabel('Название приказа').inputValue()) === localName, 'local input lost');

  const reloadResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${tariffBasePath}/${conflictDraftId}` &&
      response.request().method() === 'GET',
  );
  await dialog
    .getByRole('button', { name: 'Загрузить актуальную редакцию', exact: true })
    .click();
  await reloadResponse;
  assert(
    (await dialog.getByLabel('Название приказа').inputValue()) === localName,
    'reload overwrote local input',
  );

  const updateResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${tariffBasePath}/${conflictDraftId}` &&
      response.request().method() === 'PATCH' &&
      response.ok(),
  );
  await save.click();
  await updateResponse;

  const updates = state.mutations.filter(
    ({ kind, id }) => kind === 'update' && id === conflictDraftId,
  );
  assert(updates.length === 2, 'conflict flow did not perform two explicit update intents');
  assert(updates[0].input.expectedRevision === 1, 'first conflict revision drifted');
  assert(updates[1].input.expectedRevision === 2, 'reloaded revision was not used');
  assert(
    updates[0].input.operationKey !== updates[1].input.operationKey,
    'resolved conflict reused the stale operation key',
  );
  await closeWithButtonAndFocusRestore(dialog, trigger, 'conflict recovery');
}

async function runViewport(browser, baseUrl, viewport, fullFlow) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
  });
  await seedDirectorSession(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const state = createFixtureState();
  const tracker = installPageFailureTracker(page);
  await installApiFixture(page, state);

  await page.goto(
    `${baseUrl}/?role=director&section=${encodeURIComponent('Зарплаты')}`,
    { waitUntil: 'domcontentloaded' },
  );
  const surface = await waitForPayrollSurface(page);
  const surfaceText = await surface.innerText();
  assert(surfaceText.includes('Предварительный сдельный расчёт'), 'payroll surface is missing');
  assert(surfaceText.includes('Тарифы по приказу № 8-09/25'), 'applied order is missing');
  await assertNoHorizontalOverflow(page, `${viewport.name} initial`);
  await assertDisclosureKeyboard(page);
  await page.screenshot({
    path: path.join(evidenceDirectory, `payroll-${viewport.name}.png`),
    fullPage: false,
  });

  const opened = await openTariffDialog(page);
  await assertDialogLayout(page, viewport);
  await assertNoHorizontalOverflow(page, `${viewport.name} dialog`);
  await page.screenshot({
    path: path.join(evidenceDirectory, `dialog-${viewport.name}.png`),
    fullPage: false,
  });
  await closeWithFocusRestore(page, opened.dialog, opened.trigger, `${viewport.name} screenshot`);
  assert(state.mutations.length === 0, `${viewport.name}: initial dialog open mutated data`);

  await assertCancelCreatesNoDraft(page, state, viewport);
  if (fullFlow) {
    await assertCreateSaveReviewPublish(page, state);
    await assertStaleConflictRetainsInput(page, state);
  }

  assert(state.unhandledRequests.length === 0, `unhandled APIs: ${state.unhandledRequests}`);
  assert(state.prohibitedRequests.length === 0, `prohibited APIs: ${state.prohibitedRequests}`);
  const expectedConflictFailures = tracker.apiFailures.filter(
    (failure) =>
      failure.status === 409 && new URL(failure.url).pathname === `${tariffBasePath}/${conflictDraftId}`,
  );
  assert(
    expectedConflictFailures.length === (fullFlow ? 1 : 0),
    `${viewport.name}: expected conflict accounting drifted`,
  );
  const expectedConflictConsoleErrors = tracker.pageErrors.filter((message) =>
    message.includes('server responded with a status of 409'),
  );
  assert(
    expectedConflictConsoleErrors.length === (fullFlow ? 1 : 0),
    `${viewport.name}: expected browser conflict diagnostic drifted`,
  );
  const cleanTracker = {
    ...tracker,
    apiFailures: tracker.apiFailures.filter((failure) => !expectedConflictFailures.includes(failure)),
    pageErrors: tracker.pageErrors.filter(
      (message) => !expectedConflictConsoleErrors.includes(message),
    ),
  };
  assertSmokeHealthy(cleanTracker, await collectVisibleErrors(page), viewport.name);
  await context.close();
  return {
    viewport: viewport.name,
    apiRequestCount: state.apiRequests.length,
    mutationKinds: state.mutations.map(({ kind }) => kind),
  };
}

let browser;
let preview;
try {
  preview = await startPreview();
  browser = await chromium.launch({ headless: true });
  const results = [];
  for (const viewport of viewports) {
    results.push(await runViewport(browser, preview.baseUrl, viewport, viewport.width === 1440));
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        evidenceDirectory,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (preview) await stopPreview(preview.server);
}
