import { chromium } from 'playwright';

const baseUrl = process.env.ADMIN_SMOKE_BASE_URL ?? 'http://127.0.0.1:5173';
const password = process.env.ADMIN_SMOKE_PASSWORD ?? 'plenka-dev';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function login(page, loginName, section = '') {
  const url = new URL(baseUrl);
  if (section) url.searchParams.set('section', section);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  const loginCard = page.locator('.auth-card');
  if (await loginCard.isVisible().catch(() => false)) {
    await page.locator('.auth-input').nth(0).fill(loginName);
    await page.locator('.auth-input').nth(1).fill(password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForLoadState('domcontentloaded');
  }
}

async function openSection(page, label, testId) {
  let button = page.locator('button').filter({ hasText: label }).filter({ visible: true }).first();
  if (!(await button.count())) {
    const more = page.locator('.mobile-section-nav-more:visible').first();
    if (await more.count()) await more.click();
    button = page.locator('button').filter({ hasText: label }).filter({ visible: true }).first();
  }
  await button.click();
  await page.getByTestId(testId).waitFor({ state: 'visible' });
}

async function closeDialog(page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Закрыть' }).last().click();
  await dialog.waitFor({ state: 'detached' });
}

async function runAdminFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await login(page, 'админ', 'Доступы');
  await page.getByTestId('admin-accounts').waitFor({ state: 'visible' });
  assert(!(await page.locator('body').innerText()).includes('new-operator@example.com'), 'fixture account leaked into live admin');

  await page.getByTestId('admin-accounts').getByRole('button', { name: 'Сессии' }).first().click();
  await page.getByRole('dialog', { name: /Сессии:/ }).waitFor({ state: 'visible' });
  await closeDialog(page);

  await openSection(page, '1С', 'admin-onec');
  await page.getByRole('button', { name: 'Проверить соединение' }).click();
  await page
    .getByText(
      /Демо-1С доступна: HTTP-проверка прошла\.|Проверка вернула mock-адаптер; live-обмен с 1С не подтверждён\./,
    )
    .waitFor({ state: 'visible' });
  const importResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/admin/onec/imports') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Контрагенты' }).click();
  const importResponse = await importResponsePromise;
  assert(importResponse.ok(), `live 1C import failed with HTTP ${importResponse.status()}`);
  const importedPayload = await importResponse.json();
  const importedSnapshots = Array.isArray(importedPayload) ? importedPayload : [importedPayload];
  assert(importedSnapshots.length > 0, 'live 1C import returned no snapshots');
  for (const snapshot of importedSnapshots) {
    assert(snapshot?.subjectType === 'counterparty', 'current import returned another subject type');
    assert(
      snapshot?.sourceKind === '1C' || snapshot?.sourceKind === 'mock_1C',
      'current import returned an unsupported source kind',
    );
    assert(!('rawPayload' in snapshot), 'business-safe import response leaked rawPayload');
  }
  await page.getByText('Импорт «counterparty» завершён.').waitFor({ state: 'visible' });
  const snapshots = page.getByRole('table', { name: 'Безопасные снимки 1С' });
  const importedExternalId = importedSnapshots[0]?.externalId;
  assert(typeof importedExternalId === 'string' && importedExternalId, 'import lacks externalId');
  const importedCounterparty = snapshots
    .locator('tbody tr')
    .filter({ hasText: importedExternalId })
    .first();
  await importedCounterparty.waitFor({ state: 'visible' });
  const importedText = await importedCounterparty.innerText();
  assert(importedText.includes('counterparty'), 'current import row has another subject type');
  assert(
    importedText.includes(importedSnapshots[0].sourceKind),
    'current import row does not show the exact returned source kind',
  );
  assert((await page.locator('.admin-live-raw').count()) === 0, 'raw diagnostics loaded without an explicit action');
  const rawButton = page.getByTestId('admin-open-raw').first();
  if (await rawButton.count()) {
    await rawButton.click();
    await page.locator('.admin-live-raw').waitFor({ state: 'visible' });
    await closeDialog(page);
  }

  await openSection(page, 'Устройства', 'admin-devices');
  const testButton = page.getByTestId('admin-devices').locator('button:not([disabled])').filter({ hasText: /^Тест$/ }).first();
  if (await testButton.count()) {
    await testButton.click();
    await page.getByRole('status').waitFor({ state: 'visible' });
  }
  await page.getByTestId('admin-devices').getByRole('button', { name: 'Качество' }).first().click();
  await page.getByTestId('admin-quality').waitFor({ state: 'visible' });
  await closeDialog(page);

  await openSection(page, 'Посты', 'admin-posts');
  await page.getByTestId('admin-posts').getByRole('button', { name: 'Качество' }).first().click();
  await page.getByTestId('admin-quality').waitFor({ state: 'visible' });
  await closeDialog(page);

  await openSection(page, 'Состояние платформы', 'admin-platform-health');
  await page.getByRole('button', { name: 'Проверить платформу' }).click();
  await page.getByText('Полная проверка платформы выполнена.').waitFor({ state: 'visible' });

  await openSection(page, 'Инциденты', 'admin-incidents');
  const openAction = page.getByTestId('admin-incidents').getByRole('button', { name: 'Принять' }).first();
  const resolveAction = page.getByTestId('admin-incidents').getByRole('button', { name: 'Закрыть' }).first();
  const action = (await openAction.count()) ? openAction : resolveAction;
  if (await action.count()) {
    await action.click();
    const reason = page.getByRole('dialog').locator('textarea');
    await reason.fill('Автоматическая full-stack проверка администратора');
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }

  assert(pageErrors.length === 0, `browser errors: ${pageErrors.join('; ')}`);
  await context.close();
}

async function runRoleLeakageCheck(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await login(page, 'оператор');
  await page.goto(`${baseUrl}/?role=admin&section=${encodeURIComponent('Доступы')}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(300);
  assert((await page.getByTestId('admin-control-plane').count()) === 0, 'operator opened admin control plane');
  assert(!(await page.locator('body').innerText()).includes('Шаблоны ролей'), 'admin navigation leaked to operator');
  await context.close();
}

const browser = await chromium.launch({ headless: true });
try {
  await runAdminFlow(browser);
  await runRoleLeakageCheck(browser);
  console.log('OK admin A1–A5 live smoke');
} finally {
  await browser.close();
}
