import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
  test,
} from 'playwright/test';

const outputDir = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'output/warehouse-coverage-v2',
);

const fixtureNames = [
  'accept-full-recovery',
  'accept-unavailable-production',
  'accept-unknown-recheck',
  'accept-v1-unchanged',
] as const;

type AcceptanceFixtureName = (typeof fixtureNames)[number];
type FrontendRole = 'commercial' | 'finance' | 'production' | 'warehouse';
type JsonRecord = Record<string, unknown>;
type AcceptanceAuthSession = {
  version: 1;
  token: string;
  role: FrontendRole;
  serverRole: string;
  userId: string;
  displayName: string | null;
  expiresAt: string;
  passwordChangeRequired: boolean;
};

type CommercialFixture = {
  name: AcceptanceFixtureName;
  id: string;
  orderNumber: string;
  counterpartyId: string;
  bucket: 'incoming' | 'drafts' | 'in_work' | 'completed';
  workflowVersion: 1 | 2;
  detail: JsonRecord;
};

const serverRole = {
  commercial: 'commercial',
  finance: 'finance',
  production: 'production_lead',
  warehouse: 'warehouse',
} satisfies Record<FrontendRole, string>;

const sectionByBucket = {
  incoming: 'Входящие заявки',
  drafts: 'Черновики',
  in_work: 'В работе',
  completed: 'Выполненные',
} satisfies Record<CommercialFixture['bucket'], string>;

const apiFailures = new WeakMap<Page, string[]>();
const browserFailures = new WeakMap<Page, string[]>();
let acceptanceSessions: Record<FrontendRole, AcceptanceAuthSession> | null = null;

if (process.env.VITEST) {
  const { test: vitestTest } = await import('vitest');
  vitestTest.skip('Warehouse Coverage V2 acceptance is executed only by Playwright.');
} else {
  registerPlaywrightAcceptance();
}

function registerPlaywrightAcceptance(): void {
  test.beforeEach(async ({ page }, testInfo) => {
    apiFailures.set(page, []);
    browserFailures.set(page, []);
    const projectSessions = acceptanceSessionsForProject(testInfo.project.name);
    acceptanceSessions = projectSessions;
    await page.addInitScript(
      ({ sessions }) => {
        const role = new URL(window.location.href).searchParams.get('role');
        const session = role ? sessions[role] : undefined;
        if (session) localStorage.setItem('plenki.auth.v1', JSON.stringify(session));
      },
      { sessions: projectSessions },
    );
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') && response.status() >= 400) {
        apiFailures
          .get(page)
          ?.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      }
    });
    page.on('pageerror', (error) => browserFailures.get(page)?.push(error.message));
  });

  test.afterEach(async ({ page }) => {
    expect(apiFailures.get(page), 'Live UI must not fall back after an API failure').toEqual([]);
    expect(browserFailures.get(page), 'Browser runtime must stay error-free').toEqual([]);
  });

  test('accept-v1-unchanged keeps the legacy proposal and approval flow', async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await readCommercialFixture(request, 'accept-v1-unchanged');
    expect(fixture.workflowVersion).toBe(1);

    const commercialDetail = await openCommercialFixture(page, fixture);
    const primaryAction = asRecord(fixture.detail.nextAction);
    expect(primaryAction.code).toBe('request_cover');
    expect(primaryAction.ownerRole).toBe('commercial');
    expect(primaryAction.allowed).toBe(true);
    await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        decodedResponsePath(response).endsWith(
          `/api/commercial/orders/${fixture.id}/warehouse-cover/recheck`,
        ),
      commercialDetail.getByRole('button', {
        name: 'Запросить',
        exact: true,
      }),
    );

    await openRole(page, 'warehouse', 'Все рулоны');
    const legacyPanel = page.getByRole('region', { name: 'Проверки покрытия заказов' });
    await expect(legacyPanel).toBeVisible();
    await expect(page.getByRole('region', { name: 'Перепроверки покрытия заказов' })).toHaveCount(
      0,
    );

    const queue = legacyPanel.getByRole('list', { name: 'Очередь проверок' });
    const queueItem = queue.getByRole('listitem').filter({ hasText: fixture.orderNumber });
    await expect(queueItem).toHaveCount(1);
    await queueItem.click();

    const compatibleRoll = legacyPanel
      .locator('.warehouse-cover-rolls input[type="checkbox"]')
      .first();
    await expect(compatibleRoll).toBeVisible();
    await compatibleRoll.check();
    const proposalResponse = await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        decodedResponsePath(response).endsWith(
          `/api/warehouse/orders/${fixture.id}/cover-proposals`,
        ),
      legacyPanel.getByRole('button', { name: 'Предложить покрытие', exact: true }),
    );
    assertRealId(asRecord(await proposalResponse.json()).id, 'legacy proposal');

    const refreshed = await readCommercialFixture(request, fixture.name);
    const refreshedCommercialDetail = await openCommercialFixture(page, refreshed);
    const legacyCoverage = refreshedCommercialDetail.getByRole('region', {
      name: 'Покрытие склада',
    });
    await expect(legacyCoverage).toBeVisible();
    await expect(legacyCoverage).not.toHaveClass(/commercial-cover-panel-v2/u);
    const approvalResponse = await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/commercial-approval'),
      legacyCoverage.getByRole('button', { name: 'Закрыть полностью со склада', exact: true }),
    );
    expect(approvalResponse.ok()).toBe(true);

    await openRole(page, 'production', 'Заказ-наряды', fixture.id);
    const technicalRow = page
      .getByRole('table', { name: 'Таблица заказ-нарядов' })
      .getByRole('row')
      .filter({ hasText: fixture.orderNumber });
    await expect(technicalRow).toHaveCount(1);
    await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/technical-approval'),
      technicalRow.getByRole('button', {
        name: 'Подтвердить техническую пригодность',
        exact: true,
      }),
    );

    const approved = await readCommercialFixture(request, fixture.name);
    expect(readPath(approved.detail, ['indicators', 'warehouseCover'])).toBe('full_confirmed');
    expect(approved.workflowVersion).toBe(1);
    await openCommercialFixture(page, approved);
    await expect(page.locator('.commercial-cover-panel-v2')).toHaveCount(0);
    await assertStableSurfaceAfterReload(
      page,
      page.locator('.commercial-cover-panel').first(),
      'V1 coverage proposal',
    );

    const switchTarget = await readCommercialFixture(request, 'accept-unavailable-production');
    await switchCommercialFixtureWithoutReload(page, approved, switchTarget);
    await openCommercialFixture(page, approved);
    await assertNoForbiddenAlert(page);
    await assertNoForeignCoverageActions(page, 'commercial', 1);
    await captureAtRequiredViewports(page, testInfo, fixture.name);
  });

  test('accept-unavailable-production exposes only the atomic production route', async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await readCommercialFixture(request, 'accept-unavailable-production');
    expect(fixture.workflowVersion).toBe(2);
    const finance = await readLinkedFinanceOrder(request, fixture);
    await prepareSystemCoverage(
      request,
      requiredString(finance.id, 'unavailable finance id'),
      'production_required',
    );
    const financeCard = await openFinanceCoverage(page, fixture, finance.id);
    await expect(financeCard).toContainText('Заказ полностью направлен в производство');
    await expect(
      financeCard.getByRole('button', { name: 'Использовать рулоны со склада', exact: true }),
    ).toHaveCount(0);
    await expect(
      financeCard.getByRole('button', { name: 'Произвести весь заказ', exact: true }),
    ).toHaveCount(0);
    await assertNoForbiddenAlert(page);
    await assertNoForeignCoverageActions(page, 'finance', 2);

    const freshFixture = await readCommercialFixture(request, fixture.name);
    const commercialDetail = await openCommercialFixture(page, freshFixture);
    const primaryAction = asRecord(freshFixture.detail.nextAction);
    expect(primaryAction.code).toBe('send_to_production');
    expect(primaryAction.ownerRole).toBe('commercial');
    expect(primaryAction.allowed).toBe(true);
    await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        decodedResponsePath(response).endsWith(
          `/api/commercial/orders/${fixture.id}/send-to-production`,
        ),
      commercialDetail.getByRole('button', { name: 'Передать в производство', exact: true }),
    );

    const production = await expect
      .poll(() => readLinkedProductionOrder(request, fixture), {
        message: 'Atomic production handoff must create a linked production order',
      })
      .not.toBeNull()
      .then(() => readLinkedProductionOrder(request, fixture));
    expect(production).not.toBeNull();
    const productionOrder = production!;
    assertRealId(productionOrder.id, 'production order');
    const productionCoverage = asRecord(productionOrder.coverage);
    expect(productionCoverage.state).toBe('production_required');
    const sourceGeneration = requiredNumber(
      productionOrder.sourceGeneration,
      'safe source coverage generation',
    );
    expect(sourceGeneration).toBe(productionCoverage.generation);
    expect(productionOrder).not.toHaveProperty('sourceCoverageCalculationId');
    expect(productionOrder).not.toHaveProperty('sourceCoverageDecisionId');
    expect(productionOrder).not.toHaveProperty('sourceCoverageInputFingerprint');

    const productionSurface = await openProductionOrder(page, fixture, productionOrder.id);
    const productionRolls = productionSurface.getByRole('table', {
      name: `Рулоны заказа ${productionOrder.id}`,
      exact: true,
    });
    const dispatchItems = requiredArray(productionOrder.dispatchItems, 'production dispatch items');
    expect(dispatchItems).toHaveLength(
      requiredNumber(productionOrder.productionQty, 'production quantity'),
    );
    await expect(productionRolls.locator('tbody tr')).toHaveCount(dispatchItems.length);
    for (const item of dispatchItems) {
      await expect(
        productionRolls.getByText(requiredString(asRecord(item).rollCode, 'production roll code'), {
          exact: true,
        }),
      ).toHaveCount(1);
    }
    await assertStableProductionCoverageAfterReload(
      page,
      fixture,
      productionOrder.id,
      productionRolls,
    );
    await assertNoForbiddenAlert(page);
    await assertNoForeignCoverageActions(page, 'production', 2);
    await captureAtRequiredViewports(page, testInfo, fixture.name);
  });

  test('accept-unknown-recheck resolves a real warehouse case into a fresh generation', async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await readCommercialFixture(request, 'accept-unknown-recheck');
    expect(fixture.workflowVersion).toBe(2);
    const finance = await readLinkedFinanceOrder(request, fixture);
    await prepareSystemCoverage(
      request,
      requiredString(finance.id, 'unknown finance id'),
      'unknown',
    );
    const financeCard = await openFinanceCoverage(page, fixture, finance.id);
    await expect(financeCard).toHaveAttribute('data-coverage-state', 'unknown');
    await expect(financeCard).toContainText('Требуется безопасная проверка данных');

    const openRecheck = financeCard.getByRole('button', {
      name: 'Отправить на перепроверку склада',
      exact: true,
    });
    await expect(openRecheck).toBeVisible();
    await openRecheck.click();
    await financeCard.getByLabel('Причина перепроверки').fill('Acceptance: проверить владельца');
    const requestedResponse = await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        decodedResponsePath(response).endsWith(
          `/api/finance/orders/${finance.id}/warehouse-coverage/recheck`,
        ),
      financeCard.getByRole('button', { name: 'Подтвердить перепроверку', exact: true }),
    );
    const requested = asRecord(await requestedResponse.json());
    const caseId = requiredString(requested.caseId, 'warehouse coverage case id');
    const requestedGeneration = requiredNumber(requested.generation, 'requested generation');
    assertRealId(caseId, 'warehouse coverage case');

    await openRole(page, 'warehouse', 'Все рулоны');
    const recheckQueue = page.getByRole('list', { name: 'Очередь перепроверок покрытия' });
    const caseRow = recheckQueue.locator(`[data-recheck-case-id="${caseId}"]`);
    await expect(caseRow).toHaveCount(1);
    await caseRow.click();
    const recheck = page.locator(`[data-recheck-case-id="${caseId}"].warehouse-coverage-recheck`);
    await expect(recheck).toBeVisible();
    const membership = recheck.locator('[data-membership-id]').first();
    const membershipId = await membership.getAttribute('data-membership-id');
    assertRealId(membershipId, 'warehouse coverage membership');
    const rollCode = (await membership.locator('header strong').first().innerText()).trim();
    expect(rollCode).not.toBe('');
    await expect(membership).toContainText('Проверить владельца');
    await membership.getByLabel(`ID владельца ${rollCode}`).fill(fixture.counterpartyId);
    await recheck.getByLabel('Причина исправления').fill('Acceptance: владелец подтверждён');

    const resolvedResponse = await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        decodedResponsePath(response).endsWith(
          `/api/warehouse/warehouse-coverage/rechecks/${caseId}/resolve`,
        ),
      recheck.getByRole('button', { name: 'Подтвердить перепроверку', exact: true }),
    );
    const resolved = asRecord(await resolvedResponse.json());
    const resolvedGeneration = requiredNumber(resolved.generation, 'resolved generation');
    expect(resolvedGeneration).toBeGreaterThan(requestedGeneration);
    await expect(recheckQueue.locator(`[data-recheck-case-id="${caseId}"]`)).toHaveCount(0);

    const openRechecks = await apiJson<unknown[]>(
      request,
      '/api/warehouse/warehouse-coverage/rechecks',
      'warehouse',
    );
    expect(openRechecks.some((item) => asRecord(item).caseId === caseId)).toBe(false);

    const refreshedCard = await openFinanceCoverage(page, fixture, finance.id);
    await expect(refreshedCard).not.toHaveAttribute('data-coverage-state', 'recheck_requested');
    const refreshedCoverage = await apiJson<JsonRecord>(
      request,
      `/api/finance/orders/${finance.id}/warehouse-coverage`,
      'finance',
    );
    expect(requiredNumber(refreshedCoverage.generation, 'fresh generation')).toBeGreaterThan(
      requestedGeneration,
    );
    await assertStableSurfaceAfterReload(page, refreshedCard, 'resolved finance coverage');
    await assertNoForbiddenAlert(page);
    await assertNoForeignCoverageActions(page, 'finance', 2);
    await captureAtRequiredViewports(page, testInfo, fixture.name);
  });

  test('accept-full-recovery releases reserve and opens the decision-linked recovery', async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await readCommercialFixture(request, 'accept-full-recovery');
    expect(fixture.workflowVersion).toBe(2);
    const finance = await readLinkedFinanceOrder(request, fixture);
    await prepareSystemCoverage(
      request,
      requiredString(finance.id, 'full-recovery finance id'),
      'awaiting_finance',
    );
    const financeCard = await openFinanceCoverage(page, fixture, finance.id);
    await expect(financeCard).toContainText(/Подтверждено \d+ из \d+ рулонов/u);
    const matchedRollCodes = await financeCard
      .locator('[data-coverage-roll]')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute('data-coverage-roll')?.trim())
          .filter((value): value is string => Boolean(value)),
      );
    expect(matchedRollCodes.length).toBeGreaterThan(0);

    await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        decodedResponsePath(response).endsWith(
          `/api/finance/orders/${finance.id}/warehouse-coverage/decide`,
        ),
      financeCard.getByRole('button', {
        name: 'Использовать рулоны со склада',
        exact: true,
      }),
    );
    await expect(financeCard).toHaveAttribute('data-coverage-state', 'warehouse_reserved');

    const task = await expect
      .poll(() => readDecisionLinkedTask(request, fixture.id), {
        message: 'Warehouse decision must create a task linked to the commercial order',
      })
      .not.toBeNull()
      .then(() => readDecisionLinkedTask(request, fixture.id));
    expect(task).not.toBeNull();
    const decisionTask = task!;
    const taskId = requiredString(decisionTask.id ?? decisionTask.taskId, 'decision task id');
    assertRealId(taskId, 'warehouse decision task');

    await openRole(page, 'warehouse', 'Выдача', `delivery-${taskId}`);
    const physical = page.locator(`[data-coverage-task-id="${taskId}"]`);
    await expect(physical).toBeVisible();
    const taskProjection = await apiJson<JsonRecord>(
      request,
      `/api/warehouse/tasks/${taskId}`,
      'warehouse',
    );
    const firstRow = asRecord(requiredArray(taskProjection.rows, 'decision task rows')[0]);
    const scanRowId = requiredString(firstRow.scanRowId, 'decision task scan row id');
    const rollCode = requiredString(firstRow.rollCode, 'decision task roll code');
    assertRealId(scanRowId, 'warehouse decision scan row');
    expect(matchedRollCodes).toContain(rollCode);

    const row = physical.locator(`[data-scan-row-id="${scanRowId}"]`);
    await row.getByRole('button', { name: 'Рулон повреждён', exact: true }).click();
    await physical
      .getByLabel('Причина физического расхождения')
      .fill('Acceptance: физически повреждён');
    const exceptionResponse = await clickForResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        decodedResponsePath(response).endsWith(
          `/api/warehouse/tasks/${taskId}/coverage-physical-exception`,
        ),
      physical.getByRole('button', { name: 'Сообщить о расхождении', exact: true }),
    );
    const exception = asRecord(await exceptionResponse.json());
    const recoveryCaseId = requiredString(exception.caseId, 'physical recovery case id');
    assertRealId(recoveryCaseId, 'physical recovery case');
    await expect(page.getByText('Расхождение зафиксировано.', { exact: false })).toBeVisible();

    const reservedRolls = await apiJson<JsonRecord[]>(
      request,
      '/api/warehouse/rolls?ownership=reserved',
      'warehouse',
    );
    expect(
      reservedRolls.filter((reserved) => reserved.reservedForOrderId === fixture.id),
      'Physical exception must release every order reservation',
    ).toEqual([]);

    const rechecks = await apiJson<JsonRecord[]>(
      request,
      '/api/warehouse/warehouse-coverage/rechecks',
      'warehouse',
    );
    const recoveryCases = rechecks.filter((item) => item.caseId === recoveryCaseId);
    expect(recoveryCases).toHaveLength(1);
    expect(recoveryCases[0].coverageOrigin).toBe('decision_linked_physical_exception');

    await clickVisibleSection(page, 'Все рулоны');
    await expect(page.locator(`[data-coverage-task-id="${taskId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-recheck-case-id="${recoveryCaseId}"]`).first()).toBeVisible();
    const switchedUrl = new URL(page.url());
    expect(switchedUrl.searchParams.get('section')).toBe('Все рулоны');
    expect(switchedUrl.searchParams.get('object')).not.toBe(`delivery-${taskId}`);
    await assertNoForbiddenAlert(page);
    await assertNoForeignCoverageActions(page, 'warehouse', 2);
    await captureAtRequiredViewports(page, testInfo, `${fixture.name}-warehouse-recovery`);

    const recoveryFinanceCard = await openFinanceCoverage(page, fixture, finance.id);
    await expect(recoveryFinanceCard).toHaveAttribute('data-coverage-state', 'recheck_requested');
    await assertStableSurfaceAfterReload(page, recoveryFinanceCard, 'finance physical recovery');
    await captureAtRequiredViewports(page, testInfo, fixture.name);
  });
}

async function apiJson<T>(
  request: APIRequestContext,
  pathName: string,
  role: FrontendRole,
): Promise<T> {
  const response = await request.get(pathName, {
    headers: { 'x-role': serverRole[role] },
  });
  if (!response.ok()) {
    throw new Error(
      `${role} GET ${pathName} failed with ${response.status()}: ${await response.text()}`,
    );
  }
  return response.json() as Promise<T>;
}

function acceptanceSessionsForProject(
  projectName: string,
): Record<FrontendRole, AcceptanceAuthSession> {
  const rawSessions = process.env.COVERAGE_V2_ACCEPTANCE_SESSIONS;
  if (!rawSessions) {
    throw new Error('Coverage V2 global setup did not provide acceptance sessions.');
  }
  const sessionsByProject = asRecord(JSON.parse(rawSessions));
  const projectSessions = asRecord(sessionsByProject[projectName]);
  const sessions = {} as Record<FrontendRole, AcceptanceAuthSession>;
  for (const role of Object.keys(serverRole) as FrontendRole[]) {
    const session = asRecord(projectSessions[role]);
    sessions[role] = {
      version: 1,
      token: requiredString(session.token, `${role} token`),
      role,
      serverRole: requiredString(session.serverRole, `${role} server role`),
      userId: requiredString(session.userId, `${role} user id`),
      displayName: typeof session.displayName === 'string' ? session.displayName : null,
      expiresAt: requiredString(session.expiresAt, `${role} token expiry`),
      passwordChangeRequired: session.passwordChangeRequired === true,
    };
  }
  return sessions;
}

async function readCommercialFixture(
  request: APIRequestContext,
  name: AcceptanceFixtureName,
): Promise<CommercialFixture> {
  const matches: JsonRecord[] = [];
  for (const bucket of ['incoming', 'drafts', 'in_work', 'completed'] as const) {
    const page = await apiJson<JsonRecord>(
      request,
      `/api/commercial/orders?bucket=${bucket}&mode=current&limit=100`,
      'commercial',
    );
    for (const item of requiredArray(page.items, `commercial ${bucket} items`).map(asRecord)) {
      if (hasExactFixtureMarker(item, name)) matches.push(item);
    }
  }
  const unique = [
    ...new Map(matches.map((item) => [requiredString(item.id, 'order id'), item])).values(),
  ];
  if (unique.length !== 1) {
    throw new Error(
      `Expected exactly one explicit browser fixture "${name}", found ${unique.length}. ` +
        'Demo/production data is not accepted as a fallback.',
    );
  }
  const summary = unique[0];
  const id = requiredString(summary.id, `${name} commercial order id`);
  assertRealId(id, `${name} commercial order`);
  const detail = await apiJson<JsonRecord>(
    request,
    `/api/commercial/orders/${encodeURIComponent(id)}`,
    'commercial',
  );
  if (!hasExactFixtureMarker(detail, name)) {
    throw new Error(`Commercial detail ${id} lost the exact acceptance fixture marker "${name}".`);
  }
  const workflowVersion =
    detail.warehouseCoverageWorkflowVersion ?? (name === 'accept-v1-unchanged' ? 1 : null);
  if (workflowVersion !== 1 && workflowVersion !== 2) {
    throw new Error(`${name} has no explicit warehouseCoverageWorkflowVersion.`);
  }
  const counterparty = asRecord(detail.counterparty);
  const bucket = detail.bucket;
  if (!['incoming', 'drafts', 'in_work', 'completed'].includes(String(bucket))) {
    throw new Error(`${name} has an unsupported commercial bucket: ${String(bucket)}`);
  }
  return {
    name,
    id,
    orderNumber: requiredString(detail.orderNumber, `${name} order number`),
    counterpartyId: requiredString(counterparty.id, `${name} counterparty id`),
    bucket: bucket as CommercialFixture['bucket'],
    workflowVersion,
    detail,
  };
}

async function readLinkedFinanceOrder(
  request: APIRequestContext,
  fixture: CommercialFixture,
): Promise<JsonRecord> {
  const orders = await apiJson<JsonRecord[]>(request, '/api/finance/orders', 'finance');
  const matches = orders.filter((order) => order.commercialOrderId === fixture.id);
  if (matches.length !== 1) {
    throw new Error(
      `${fixture.name}: expected one financeOrder linked by commercialOrderId, found ${matches.length}.`,
    );
  }
  assertRealId(matches[0].id, `${fixture.name} finance order`);
  return matches[0];
}

async function readLinkedProductionOrder(
  request: APIRequestContext,
  fixture: CommercialFixture,
): Promise<JsonRecord | null> {
  const orders = await apiJson<JsonRecord[]>(request, '/api/production/orders', 'production');
  const matches = orders.filter((order) => order.commercialOrderId === fixture.id);
  if (matches.length > 1) {
    throw new Error(`${fixture.name}: atomic handoff created ${matches.length} production orders.`);
  }
  return matches[0] ?? null;
}

async function readDecisionLinkedTask(
  request: APIRequestContext,
  commercialOrderId: string,
): Promise<JsonRecord | null> {
  const tasks = await apiJson<JsonRecord[]>(
    request,
    '/api/warehouse/tasks?mode=reserve',
    'warehouse',
  );
  const matches = tasks.filter((task) => {
    if (task.orderId === commercialOrderId) return true;
    return requiredArray(task.rows ?? [], 'warehouse task rows')
      .map(asRecord)
      .some((row) => row.fromOrderId === commercialOrderId);
  });
  if (matches.length > 1) {
    throw new Error(`Order ${commercialOrderId} has ${matches.length} decision-linked tasks.`);
  }
  return matches[0] ?? null;
}

function hasExactFixtureMarker(value: JsonRecord, name: AcceptanceFixtureName): boolean {
  const counterparty = asRecord(value.counterparty);
  return (
    value.acceptanceFixtureName === name ||
    value.orderNumber === name ||
    value.title === name ||
    value.externalId === name ||
    counterparty.displayName === name
  );
}

async function openRole(
  page: Page,
  role: FrontendRole,
  section: string,
  objectId?: string,
): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'x-role': serverRole[role] });
  const search = new URLSearchParams({ role, section });
  if (objectId) search.set('object', objectId);
  await page.goto(`/?${search.toString()}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(`.app-shell[data-active-role="${role}"]`)).toBeVisible();
}

async function openCommercialFixture(page: Page, fixture: CommercialFixture): Promise<Locator> {
  await openRole(page, 'commercial', sectionByBucket[fixture.bucket], fixture.id);
  const row = page.locator(`[data-commercial-order-id="${fixture.id}"]`);
  await expect(row).toHaveCount(1);
  const detail = page.locator('.commercial-live-detail-panel');
  if (!(await detail.getByText(fixture.orderNumber, { exact: true }).count())) {
    await row.click();
  }
  await expect(detail.locator('.commercial-order-overview')).toContainText(fixture.orderNumber);
  expect(new URL(page.url()).searchParams.get('object')).toBe(fixture.id);
  return detail;
}

async function switchCommercialFixtureWithoutReload(
  page: Page,
  previous: CommercialFixture,
  next: CommercialFixture,
): Promise<void> {
  if (previous.bucket !== next.bucket) {
    await clickVisibleSection(page, sectionByBucket[next.bucket]);
  }
  const nextRow = page.locator(`[data-commercial-order-id="${next.id}"]`);
  await expect(nextRow).toHaveCount(1);
  await nextRow.click();
  const detail = page.locator('.commercial-live-detail-panel .commercial-order-overview');
  await expect(detail).toContainText(next.orderNumber);
  expect(new URL(page.url()).searchParams.get('object')).toBe(next.id);
  expect(new URL(page.url()).searchParams.get('object')).not.toBe(previous.id);
  const previousRow = page.locator(`[data-commercial-order-id="${previous.id}"]`);
  if (await previousRow.count()) await expect(previousRow).toHaveAttribute('aria-pressed', 'false');
}

async function openFinanceCoverage(
  page: Page,
  fixture: CommercialFixture,
  financeOrderIdValue: unknown,
): Promise<Locator> {
  const financeOrderId = requiredString(financeOrderIdValue, `${fixture.name} finance id`);
  assertRealId(financeOrderId, `${fixture.name} finance order`);
  await openRole(page, 'finance', 'Счета', financeOrderId);
  const row = page.locator('.finance-ledger-row').filter({ hasText: fixture.orderNumber }).first();
  const card = page.getByRole('region', { name: 'Складское покрытие заказа' });
  await expect
    .poll(async () => (await card.isVisible()) || (await row.count()) === 1, {
      message: `${fixture.name} finance detail or exact ledger row must hydrate`,
    })
    .toBe(true);
  if (!(await card.isVisible())) {
    await row.click();
  }
  await expect(card).toBeVisible();
  expect(new URL(page.url()).searchParams.get('object')).toBe(financeOrderId);
  return card;
}

async function openProductionOrder(
  page: Page,
  fixture: CommercialFixture,
  productionOrderIdValue: unknown,
): Promise<Locator> {
  const productionOrderId = requiredString(productionOrderIdValue, `${fixture.name} production id`);
  await openRole(page, 'production', 'Заказ-наряды', productionOrderId);
  const surface = page.getByRole('region', { name: 'Заказ-наряды и их рулоны' });
  await expandProductionOrder(surface, fixture, productionOrderId);
  return surface;
}

async function expandProductionOrder(
  surface: Locator,
  fixture: CommercialFixture,
  productionOrderId: string,
): Promise<Locator> {
  await expect(surface).toBeVisible();
  const disclosure = surface
    .locator('.production-order-disclosure')
    .filter({ hasText: fixture.orderNumber })
    .first();
  await expect(disclosure).toBeVisible();
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
  const expanded = surface.locator(`#production-order-rolls-${productionOrderId}`);
  await expect(expanded).toBeVisible();
  return expanded;
}

async function prepareSystemCoverage(
  request: APIRequestContext,
  financeOrderId: string,
  expectedState: string,
): Promise<void> {
  const current = await apiJson<JsonRecord>(
    request,
    `/api/finance/orders/${encodeURIComponent(financeOrderId)}/warehouse-coverage`,
    'finance',
  );
  const response = await request.post(
    `/api/finance/orders/${encodeURIComponent(financeOrderId)}/warehouse-coverage/refresh`,
    {
      headers: {
        authorization: `Bearer ${requiredString(
          acceptanceSessions?.finance.token,
          'finance acceptance token',
        )}`,
      },
      data: {
        clientRequestId: randomUUID(),
        expectedGeneration: current.generation ?? null,
        expectedStateVersion: requiredNumber(
          current.stateVersion,
          `${financeOrderId} coverage state version`,
        ),
      },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `System coverage preparation failed with ${response.status()}: ${await response.text()}`,
    );
  }
  const refreshed = asRecord(await response.json());
  expect(refreshed.state, `${financeOrderId} prepared coverage state`).toBe(expectedState);
}

async function clickForResponse(
  page: Page,
  predicate: (response: Response) => boolean,
  control: Locator,
): Promise<Response> {
  const responsePromise = page.waitForResponse(predicate, { timeout: 15_000 });
  await control.click();
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(
      `${response.request().method()} ${response.url()} failed with ${response.status()}: ` +
        (await response.text()),
    );
  }
  return response;
}

function decodedResponsePath(response: Response): string {
  return decodeURIComponent(new URL(response.url()).pathname);
}

async function clickVisibleSection(page: Page, label: string): Promise<void> {
  const controls = page
    .locator('.role-nav, .role-top-nav, .mobile-section-nav')
    .getByRole('button', { name: label, exact: true });
  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    if (await control.isVisible()) {
      await control.click();
      await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe(label);
      return;
    }
  }
  const more = page.getByRole('button', { name: /^Еще разделы:/u });
  await expect(more).toBeVisible();
  await more.click();
  await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe(label);
}

async function assertStableSurfaceAfterReload(
  page: Page,
  surface: Locator,
  label: string,
): Promise<void> {
  const before = await surfaceFingerprint(surface);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(surface).toBeVisible();
  await expect
    .poll(() => surfaceFingerprint(surface), {
      message: `${label} changed across reload`,
    })
    .toEqual(before);
}

async function assertStableProductionCoverageAfterReload(
  page: Page,
  fixture: CommercialFixture,
  productionOrderIdValue: unknown,
  surface: Locator,
): Promise<void> {
  const productionOrderId = requiredString(productionOrderIdValue, `${fixture.name} production id`);
  const before = await surfaceFingerprint(surface);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const productionSurface = page.getByRole('region', { name: 'Заказ-наряды и их рулоны' });
  const expanded = await expandProductionOrder(productionSurface, fixture, productionOrderId);
  const rehydrated = expanded.getByRole('table', {
    name: `Рулоны заказа ${productionOrderId}`,
    exact: true,
  });
  await expect(rehydrated).toBeVisible();
  await expect
    .poll(() => surfaceFingerprint(rehydrated), {
      message: 'production coverage route changed across reload',
    })
    .toEqual(before);
}

async function surfaceFingerprint(surface: Locator): Promise<{
  text: string;
  coverageState: string | null;
  caseId: string | null;
  taskId: string | null;
}> {
  return surface.evaluate((node) => ({
    text: (node.textContent ?? '').replace(/\s+/gu, ' ').trim(),
    coverageState: node.getAttribute('data-coverage-state'),
    caseId: node.getAttribute('data-recheck-case-id'),
    taskId: node.getAttribute('data-coverage-task-id'),
  }));
}

async function assertNoForbiddenAlert(page: Page): Promise<void> {
  await expect(
    page.getByRole('alert').filter({
      hasText: /нет прав|недостаточно прав|forbidden|not authorized/iu,
    }),
  ).toHaveCount(0);
}

async function assertNoForeignCoverageActions(
  page: Page,
  role: FrontendRole,
  workflowVersion: 1 | 2,
): Promise<void> {
  const forbiddenByRole: Record<FrontendRole, string[]> = {
    commercial:
      workflowVersion === 2
        ? [
            'Использовать рулоны со склада',
            'Произвести весь заказ',
            'Отправить на перепроверку склада',
            'Подтвердить перепроверку',
            'Рулон повреждён',
          ]
        : ['Использовать рулоны со склада', 'Подтвердить перепроверку', 'Рулон повреждён'],
    finance: ['Подтвердить перепроверку', 'Рулон повреждён', 'Сообщить о расхождении'],
    production: [
      'Использовать рулоны со склада',
      'Произвести весь заказ',
      'Отправить на перепроверку склада',
      'Подтвердить перепроверку',
      'Рулон повреждён',
    ],
    warehouse: [
      'Использовать рулоны со склада',
      'Произвести весь заказ',
      'Отправить на перепроверку склада',
    ],
  };
  for (const label of forbiddenByRole[role]) {
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
}

async function captureAtRequiredViewports(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const viewport = page.viewportSize();
  expect(
    viewport &&
      ((viewport.width === 1024 && viewport.height === 768) ||
        (viewport.width === 1440 && viewport.height === 900)),
    'Task 27 must run only at an explicitly required production viewport',
  ).toBe(true);
  if (!viewport) throw new Error('Playwright viewport is required for Task 27 acceptance.');

  await assertProductionLayoutInvariants(page, `${name} ${viewport.width}x${viewport.height}`);
  const screenshotPath = path.join(
    outputDir,
    `${testInfo.project.name}-${name}-${viewport.width}x${viewport.height}.png`,
  );
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await testInfo.attach(`${testInfo.project.name}-${name}`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
}

async function assertProductionLayoutInvariants(page: Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const shellSelectors = [
      '.app-shell',
      '.app-body',
      '.application-content',
      '.main-grid',
      '.workspace-content',
    ];
    const nestedVerticalRoots = shellSelectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)]
        .filter(visible)
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            ['auto', 'scroll'].includes(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 2
          );
        })
        .map(
          (element) =>
            selector + (element.className ? `.${String(element.className).split(/\s+/u)[0]}` : ''),
        ),
    );
    const emptyBottomOverlays = [...document.body.querySelectorAll('*')]
      .filter(visible)
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const meaningfulChild = element.querySelector(
          'button,input,textarea,select,img,svg,canvas',
        );
        return (
          style.position === 'fixed' &&
          style.pointerEvents !== 'none' &&
          rect.bottom >= innerHeight - 24 &&
          rect.height >= 24 &&
          !(element.textContent ?? '').trim() &&
          !meaningfulChild
        );
      })
      .map((element) => {
        const htmlElement = element as HTMLElement;
        return htmlElement.id || htmlElement.className || htmlElement.tagName;
      });
    const emptyBulkBars = [...document.querySelectorAll('.plenki-bulk-bar')]
      .filter(visible)
      .filter((element) => {
        const text = (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
        return !/[1-9]\d*/u.test(text) || !element.querySelector('button');
      })
      .map((element) => (element.textContent ?? '').replace(/\s+/gu, ' ').trim());
    return {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      nestedVerticalRoots,
      emptyBottomOverlays,
      emptyBulkBars,
    };
  });
  expect(
    Math.max(metrics.documentWidth, metrics.bodyWidth),
    `${label}: horizontal document overflow`,
  ).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.nestedVerticalRoots, `${label}: nested page scroll root`).toEqual([]);
  expect(metrics.emptyBottomOverlays, `${label}: empty fixed bottom overlay`).toEqual([]);
  expect(metrics.emptyBulkBars, `${label}: empty bulk action overlay`).toEqual([]);
  await assertNoForbiddenAlert(page);
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a string.`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function readPath(value: JsonRecord, pathSegments: string[]): unknown {
  return pathSegments.reduce<unknown>((current, segment) => asRecord(current)[segment], value);
}

function assertRealId(value: unknown, label: string): asserts value is string {
  const id = requiredString(value, label);
  if (
    id.length < 20 ||
    !/^[a-z0-9:_-]+$/iu.test(id) ||
    fixtureNames.includes(id as AcceptanceFixtureName) ||
    /^(?:demo|fixture|placeholder|fake)[-_]/iu.test(id)
  ) {
    throw new Error(`${label} is not a persisted backend id: ${id}`);
  }
}
