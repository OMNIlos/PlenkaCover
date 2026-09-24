import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5195;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = path.resolve('qa-screenshots/admin-day4-2026-06-17');
const reportPath = path.join(screenshotDir, 'admin-day4-smoke-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');

const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1366', width: 1366, height: 768 },
  { name: '390', width: 390, height: 844 },
];

const adminSections = ['Доступы', 'Шаблоны ролей', 'Устройства', 'Источники', 'Проблемы / история'];
const nonAdminRoles = ['commercial', 'production', 'finance', 'director', 'operator', 'warehouse'];
const adminProductionActions = ['Зафиксировать вес', 'Сканировать QR', 'Закрыть приемку', 'Проверить оплату', 'Отметить оплату вручную', 'Обновить оплату', 'Выставить счет'];
const nonAdminForbidden = ['rawDiagnostics', 'raw payload', 'parsed payload', 'Служебный сигнал', 'Снимок источника', 'source_id', 'role_template_id', 'hiddenScopes', 'Скрытые группы'];
const forbiddenSourceWording = ['недействительные данные', '1С не подтвердила', 'данные невалидны'];

const server = spawn(viteBin, ['preview', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLogs = [];
server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Vite preview exited before ready.\n${serverLogs.join('\n').slice(-2000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/?role=admin`);
      if (response.ok) return;
    } catch {
      // Keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite preview did not start in time.\n${serverLogs.join('\n').slice(-2000)}`);
}

async function collectText(page) {
  const bodyText = await page.locator('body').innerText();
  const attributeText = await page
    .locator('[title], [aria-label]')
    .evaluateAll((elements) =>
      elements
        .map((element) => [element.getAttribute('title'), element.getAttribute('aria-label')].filter(Boolean).join('\n'))
        .join('\n')
    );
  return `${bodyText}\n${attributeText}`;
}

function findTerms(text, terms) {
  const normalized = text.toLowerCase();
  return terms.filter((term) => {
    if (term === '1С') return /(^|[\s"'«(])1с(?=$|[\s"'»:;,.!?)])/.test(normalized);
    return normalized.includes(term.toLowerCase());
  });
}

function assertIncludes(text, needles, context) {
  const missing = needles.filter((needle) => !text.toLowerCase().includes(needle.toLowerCase()));
  assert(missing.length === 0, `${context}: missing ${missing.join(', ')}`);
}

async function assertNoTerms(page, terms, context) {
  const leaks = findTerms(await collectText(page), terms);
  assert(leaks.length === 0, `${context}: forbidden terms visible: ${leaks.join(', ')}`);
}

async function checkNoHorizontalOverflow(page, context) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    offenders: Array.from(document.querySelectorAll('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: String(element.getAttribute('class') ?? ''),
          text: String(element.textContent ?? '').trim().slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter((entry) => entry.width > 0 && (entry.left < -1 || entry.right > window.innerWidth + 1))
      .slice(0, 8),
  }));
  assert(
    overflow.docWidth <= overflow.viewport + 1 && overflow.bodyWidth <= overflow.viewport + 1,
    `${context}: horizontal overflow ${overflow.docWidth}/${overflow.bodyWidth}/${overflow.viewport}; offenders=${JSON.stringify(overflow.offenders)}`
  );
}

async function gotoRole(page, role) {
  await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(350);
}

async function clickSection(page, section) {
  const sectionNavSelector = '.section-nav-button, .role-top-nav-item, .mobile-section-nav-item:not(.mobile-section-nav-more), .mobile-nav-drawer-item';
  let button = page.locator(sectionNavSelector).filter({ hasText: section }).filter({ visible: true }).first();
  if (!(await button.count())) {
    const moreButton = page.locator('.mobile-section-nav-more').filter({ visible: true }).first();
    if (await moreButton.count()) {
      await moreButton.click();
      await page.waitForTimeout(150);
      button = page.locator(sectionNavSelector).filter({ hasText: section }).filter({ visible: true }).first();
    }
  }
  if (await button.count()) {
    await button.click();
    await page.waitForTimeout(300);
    return;
  }
  await page.evaluate((targetSection) => {
    const target = Array.from(document.querySelectorAll('.section-nav-button, .role-top-nav-item, .mobile-section-nav-item:not(.mobile-section-nav-more), .mobile-nav-drawer-item'))
      .find((item) => (item.textContent ?? '').includes(targetSection));
    if (!target) throw new Error(`Section button not found: ${targetSection}`);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, section);
  await page.waitForTimeout(300);
}

async function selectQueueRow(page, text) {
  const row = page.locator('.queue-row').filter({ hasText: text }).first();
  await row.waitFor({ state: 'visible', timeout: 5000 });
  await row.locator('.queue-row-main').click();
  await page.waitForTimeout(300);
}

async function clickButton(page, pattern) {
  const scoped = page.locator('.detail-panel button:visible, .admin-access-surface button:visible').filter({ hasText: pattern }).first();
  const fallback = page.locator('button:visible').filter({ hasText: pattern }).first();
  const button = await scoped.count() > 0 ? scoped : fallback;
  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await page.waitForTimeout(300);
}

async function screenshot(page, name) {
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function smokeAdminViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  await gotoRole(page, 'admin');

  for (const section of adminSections) {
    await clickSection(page, section);
    await checkNoHorizontalOverflow(page, `admin ${section} ${viewport.name}`);
    const text = await collectText(page);
    assertIncludes(text, [section], `admin section visible ${section} ${viewport.name}`);
    if (!['Доступы', 'Шаблоны ролей'].includes(section)) {
      const firstLayerContract = section === 'Проблемы / история'
        ? ['Проблемы / история', 'Журнал', 'Журнал и диагностика']
        : section === 'Источники'
          ? ['1С', 'Система', 'Владелец', 'Снимок', 'Статус', 'Служебные детали']
        : ['Объект', 'Владелец', 'Результат', 'Служебные детали'];
      assertIncludes(text, firstLayerContract, `admin first layer ${section} ${viewport.name}`);
      await assertNoTerms(page, ['Открыть карточку'], `admin duplicate selected-card action ${section} ${viewport.name}`);
    }
    await assertNoTerms(page, forbiddenSourceWording, `admin source wording ${section} ${viewport.name}`);
    await assertNoTerms(page, adminProductionActions, `admin production actions ${section} ${viewport.name}`);
    await screenshot(page, `admin-${section.replace(/\s|\\|\//g, '-')}-${viewport.name}`);
  }

  await page.close();
}

async function smokeAdminStatesAndActions(page) {
  await gotoRole(page, 'admin');

  await clickSection(page, 'Доступы');
  let text = await collectText(page);
  assertIncludes(text, ['Доступ выдан', 'Отозван', 'Редактировать', 'Отозвать доступ', 'Выдать доступ'], 'access assignment surface');
  await assertNoTerms(page, ['Приглашение', 'Приглашен', 'Активен'], 'access assignment must not expose invite/active statuses');
  await clickButton(page, /Выдать доступ/i);
  assertIncludes(await collectText(page), ['Выдать доступ', 'Шаблон роли'], 'assign access modal');
  const assignEmail = await page.locator('.admin-access-modal input').first().inputValue();
  assert(assignEmail === 'new-operator@example.com', `assign modal email mismatch: ${assignEmail}`);
  await page.locator('.admin-access-modal button').filter({ hasText: /Выдать доступ/i }).last().click();
  await page.waitForTimeout(300);
  assertIncludes(await collectText(page), ['Доступ выдан', 'new-operator@example.com'], 'assign template action');

  await clickSection(page, 'Шаблоны ролей');
  text = await collectText(page);
  assertIncludes(text, ['Шаблон выбран', 'Требует настройки'], 'template states');
  assert(/Сохранить шаблон/i.test(text), 'template states: missing save action');
  await clickButton(page, /Сохранить шаблон/i);
  assertIncludes(await collectText(page), ['Шаблон сохранен'], 'save template action');

  await clickSection(page, 'Устройства');
  await selectQueueRow(page, 'Весы линии A-01');
  assertIncludes(await collectText(page), ['Готово', 'Служебные детали'], 'device ready state');
  await selectQueueRow(page, 'Весы линии E-04');
  assertIncludes(await collectText(page), ['Офлайн', 'Проверить связь'], 'device offline state');
  await clickButton(page, /Проверить связь/i);
  assertIncludes(await collectText(page), ['Связь не восстановлена', 'Весы не отвечают', 'Передать админу смены'], 'device check action keeps issue actionable');
  await assertNoTerms(page, ['Устройство проверено'], 'offline device check must not become green success');
  await selectQueueRow(page, 'Сканер склада S-01');
  assertIncludes(await collectText(page), ['требует настройки', 'Проверить привязку'], 'device misconfigured state');
  await selectQueueRow(page, 'Принтер этикеток P-03');
  assertIncludes(await collectText(page), ['тест не пройден', 'Проверить очередь печати', 'Передать владельцу'], 'device test failed state');

  await clickSection(page, 'Источники');
  await selectQueueRow(page, '1С: счета');
  assertIncludes(await collectText(page), ['Счет из 1С требует проверки', 'Передать бухгалтерии'], 'source manual check state');
  await clickButton(page, /Повторить проверку 1С/i);
  assertIncludes(await collectText(page), ['1С проверена', 'История'], 'retry source action');

  await clickSection(page, 'Проблемы / история');
  assertIncludes(await collectText(page), ['Проблемы / история', 'Журнал и диагностика'], 'history section');
}

async function smokeLeakage(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  for (const role of nonAdminRoles) {
    await gotoRole(page, role);
    await assertNoTerms(page, nonAdminForbidden, `${role} admin leakage`);
  }

  await gotoRole(page, 'admin');
  await assertNoTerms(page, adminProductionActions, 'admin production execution leakage');
  await assertNoTerms(page, forbiddenSourceWording, 'global forbidden source wording');
  await page.close();
}

const report = {
  baseUrl,
  screenshotDir,
  scenarios: [],
};

async function record(name, fn) {
  try {
    await fn();
    report.scenarios.push({ name, status: 'PASS', detail: '' });
  } catch (error) {
    report.scenarios.push({ name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

let browser;
try {
  await mkdir(screenshotDir, { recursive: true });
  await waitForServer();
  browser = await chromium.launch();

  for (const viewport of viewports) {
    await record(`admin sections ${viewport.name}`, () => smokeAdminViewport(browser, viewport));
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await record('admin states and actions', () => smokeAdminStatesAndActions(page));
  await page.close();

  await record('admin leakage boundaries', () => smokeLeakage(browser));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

const failures = report.scenarios.filter((scenario) => scenario.status !== 'PASS');
if (failures.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));
