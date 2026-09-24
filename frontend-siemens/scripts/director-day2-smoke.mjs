import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5197;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = path.resolve('qa-screenshots/director-day2-2026-06-16');
const reportPath = path.join(screenshotDir, 'director-day2-smoke-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');

const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1366', width: 1366, height: 768 },
  { name: '390', width: 390, height: 1200 },
];

const sections = ['Контроль', 'Требуют решения', 'Финансы', 'Производство', 'Склад', 'Сырье', 'Штрафы', 'Аудит / QR'];
const forbiddenTerms = ['зарплат', 'удерж', 'вычет', 'расчетный лист', 'production-ready', 'онлайн 1С', 'real sync', 'real-time 1С', 'payroll', 'OEE'];
const forbiddenControlTerms = [
  'риск начисления',
  'ожидаемые штрафы',
  'потенциальные удерж',
  'отклонение от маржи',
  'маржа',
  'прибыль',
  'полная себестоимость',
  'прибыльность заказа',
  'планы менеджерам',
];

function waitForServer(server, serverLogs) {
  const deadline = Date.now() + 25_000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (server.exitCode !== null || server.signalCode !== null) {
        reject(new Error(`Vite dev server exited before ready.\n${serverLogs.join('\n').slice(-2000)}`));
        return;
      }
      try {
        const response = await fetch(`${baseUrl}/?role=director`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Retry until the demo-mode dev server is reachable.
      }
      if (Date.now() > deadline) {
        reject(new Error(`Vite dev server did not start in time.\n${serverLogs.join('\n').slice(-2000)}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function collectText(page) {
  const bodyText = await page.locator('body').innerText();
  const attributeText = await page.locator('[title], [aria-label]').evaluateAll((elements) =>
    elements.map((element) => [element.getAttribute('title'), element.getAttribute('aria-label')].filter(Boolean).join('\n')).join('\n')
  );
  return `${bodyText}\n${attributeText}`;
}

async function bodySignature(page) {
  return page.locator('body').innerText().then((text) => text.replace(/\s+/g, ' ').slice(0, 2400));
}

function findForbidden(text) {
  const normalized = text.toLowerCase();
  return forbiddenTerms.filter((term) => normalized.includes(term.toLowerCase()));
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
          text: String(element.textContent ?? '').trim().slice(0, 90),
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

async function assertDirectorSplitView(page, context) {
  const geometry = await page.evaluate(() => {
    const table = document.querySelector('.director-table-surface')?.getBoundingClientRect();
    const drawer = document.querySelector('.director-drawer-inline')?.getBoundingClientRect();
    if (!table || !drawer) return null;
    return {
      viewportHeight: window.innerHeight,
      table: { top: Math.round(table.top), left: Math.round(table.left), right: Math.round(table.right), width: Math.round(table.width) },
      drawer: { top: Math.round(drawer.top), left: Math.round(drawer.left), right: Math.round(drawer.right), width: Math.round(drawer.width) },
    };
  });

  assert(geometry, `${context}: split geometry is missing`);
  assert(geometry.drawer.left > geometry.table.right - 4, `${context}: drawer is not side-by-side with table ${JSON.stringify(geometry)}`);
  assert(Math.abs(geometry.drawer.top - geometry.table.top) <= 36, `${context}: drawer is not aligned with table top ${JSON.stringify(geometry)}`);
  assert(geometry.drawer.top >= 0 && geometry.drawer.top < geometry.viewportHeight, `${context}: drawer top is outside first viewport ${JSON.stringify(geometry)}`);
  assert(geometry.drawer.width >= 320, `${context}: drawer is too narrow ${JSON.stringify(geometry)}`);
}

async function assertDecisionQueueContract(page, context) {
  const firstRow = page.locator('.director-table tbody tr').first();
  await firstRow.click();
  await page.waitForTimeout(250);

  const gridClass = await page.locator('.director-main-grid').first().getAttribute('class');
  assert(gridClass?.includes('is-list-only'), `${context}: decision queue is not full-width list-only`);
  assert(await page.locator('.director-drawer-inline, .director-mobile-detail-layer').count() === 0, `${context}: old decision detail layer is visible`);
  assert(await page.locator('.director-table-surface').count() === 1, `${context}: full-width decision table is missing`);
}

async function clickSection(page, section) {
  const sectionNavSelector = '.section-nav-button, .role-top-nav-item, .mobile-section-nav-item:not(.mobile-section-nav-more), .mobile-nav-drawer-item';
  let visibleButton = page.locator(sectionNavSelector).filter({ hasText: section }).filter({ visible: true }).first();
  if (!(await visibleButton.count())) {
    const drawerIsOpen = (await page.locator('.mobile-nav-drawer-layer').filter({ visible: true }).count()) > 0;
    const moreButton = page.locator('.mobile-section-nav-more').filter({ visible: true }).first();
    if (!drawerIsOpen && await moreButton.count()) {
      await moreButton.click();
      await page.waitForTimeout(150);
      visibleButton = page.locator(sectionNavSelector).filter({ hasText: section }).filter({ visible: true }).first();
    }
  }
  if (await visibleButton.count()) {
    await visibleButton.click();
    await page.waitForTimeout(250);
    return;
  }

  await page.evaluate((targetSection) => {
    const button = Array.from(document.querySelectorAll('.section-nav-button, .role-top-nav-item, .mobile-section-nav-item:not(.mobile-section-nav-more), .mobile-nav-drawer-item'))
      .find((item) => (item.textContent ?? '').includes(targetSection));
    if (!button) throw new Error(`Section button not found: ${targetSection}`);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, section);
  await page.waitForTimeout(250);
}

async function resetDirector(page) {
  await page.goto(`${baseUrl}/?role=director`, { waitUntil: 'domcontentloaded' });
  await page.locator('.management-control-board').waitFor({ state: 'attached', timeout: 10000 });
  await page.locator('.section-nav-button, .role-top-nav-item, .mobile-section-nav-item:not(.mobile-section-nav-more), .mobile-nav-drawer-item').first().waitFor({ state: 'attached', timeout: 10000 });
}

async function clickFirstDirectorRow(page) {
  const firstRow = page.locator('.director-table tbody tr').first();
  assert(await firstRow.count() === 1, 'director action sweep: expected at least one director table row');
  await firstRow.click();
  await page.waitForTimeout(180);
}

async function assertSignatureChangedAfterClick(page, locator, context) {
  assert(await locator.count() >= 1, `${context}: action is missing`);
  const before = await bodySignature(page);
  await locator.first().click();
  await page.waitForTimeout(300);
  const after = await bodySignature(page);
  assert(before !== after, `${context}: click did not produce a visible state change`);
}

async function assertControlKpiLinks(page) {
  await resetDirector(page);
  const kpiCards = page.locator('.management-report-kpi');
  assert(await kpiCards.count() === 6, 'control: expected six KPI cards before link checks');
  assert(await page.locator('.management-report-kpi button, button.management-report-kpi').count() === 6, 'control: expected one KPI link per card');

  const checks = [
    { card: 'План счетов', action: 'К счетам', title: 'Финансы', selector: '.director-finance-surface' },
    { card: 'Оплачено', action: 'К оплатам', title: 'Финансы', selector: '.director-finance-surface' },
    { card: 'Просрочено', action: 'Разобрать', title: 'Финансы', selector: '.director-finance-surface' },
    { card: 'Выработка', action: 'К производству', title: 'Производство', selector: '.director-table-surface' },
    { card: 'Средняя', action: 'К приемке', title: 'Склад', selector: '.director-table-surface' },
    { card: 'Штрафы', action: 'К штрафам', title: 'Штрафы', selector: '.penalty-workbench' },
  ];

  for (const check of checks) {
    await resetDirector(page);
    const card = page.locator('.management-report-kpi').filter({ hasText: check.card }).first();
    assert(await card.count() === 1, `control: KPI card missing for ${check.card}`);
    const nestedButton = card.getByRole('button', { name: check.action }).first();
    if (await nestedButton.count() > 0) {
      await nestedButton.click();
    } else {
      await card.click();
    }
    await page.waitForTimeout(350);
    assert(await page.locator('.director-topbar h1').filter({ hasText: check.title }).count() >= 1, `control: KPI ${check.card} did not open ${check.title}`);
    assert(await page.locator(check.selector).count() >= 1, `control: KPI ${check.card} did not open expected surface ${check.selector}`);
  }
}

async function assertControlPeriodLinks(page) {
  const checks = [
    { card: 'Рулоны', action: 'К производству', title: 'Производство', selector: '.director-table-surface' },
    { card: 'Штрафы', action: 'К штрафам', title: 'Штрафы', selector: '.penalty-workbench' },
    { card: 'Просрочка', action: 'К финансам', title: 'Финансы', selector: '.director-finance-surface' },
  ];

  for (const check of checks) {
    await resetDirector(page);
    const summary = page.locator('.management-period-summary').filter({ hasText: check.card }).first();
    assert(await summary.count() === 1, `control: period summary missing for ${check.card}`);
    await summary.click();
    await page.waitForTimeout(350);
    assert(await page.locator('.director-topbar h1').filter({ hasText: check.title }).count() >= 1, `control: period summary ${check.card} did not open ${check.title}`);
    assert(await page.locator(check.selector).count() >= 1, `control: period summary ${check.card} did not open expected surface ${check.selector}`);
  }
}

async function assertControlPeriodCalendar(page) {
  await resetDirector(page);
  await page.locator('.management-period-calendar-toggle').click();
  await page.locator('.management-period-calendar').waitFor({ state: 'visible', timeout: 5000 });
  assert(await page.locator('.management-period-date-fields input[type="date"]').count() === 2, 'control: custom range date inputs are missing');
  assert(await page.locator('.management-period-month').count() === 2, 'control: two-month calendar view is missing');
  assert(await page.locator('.management-period-days button').count() >= 58, 'control: calendar day buttons are missing');
  await page.locator('.management-period-calendar-foot button').click();
  await page.waitForTimeout(150);
  assert(await page.locator('.management-period-calendar').count() === 0, 'control: period calendar did not close after apply');
}

async function assertDirectorActionSweep(page) {
  await assertControlKpiLinks(page);
  await assertControlPeriodLinks(page);
  await assertControlPeriodCalendar(page);

  await resetDirector(page);
  const firstFinanceReportRow = page.locator('.management-report-table tbody tr').first();
  assert(await firstFinanceReportRow.count() === 1, 'control: expected a finance report row');
  assert(await firstFinanceReportRow.getAttribute('role') === 'button', 'control: finance report row is not keyboard actionable');
  await firstFinanceReportRow.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert(await page.locator('.director-finance-surface').count() === 1, 'control: finance report row keyboard action did not open finance');

  await resetDirector(page);
  await page.getByRole('button', { name: /Очередь решений/i }).first().click();
  await page.waitForTimeout(300);
  assert(await page.locator('.director-table tbody tr').count() >= 1, 'control: decision queue button did not open director decisions');

  await resetDirector(page);
  await clickSection(page, 'Требуют решения');
  await clickFirstDirectorRow(page);
  assert(await page.locator('.director-drawer-inline, .director-mobile-detail-layer').count() === 0, 'decisions: old drawer must stay removed from the common queue');

  await resetDirector(page);
  await clickSection(page, 'Финансы');
  await page.locator('.director-finance-row').first().click();
  await page.waitForTimeout(180);
  const reasonField = page.locator('.director-finance-reason-field textarea');
  assert(await reasonField.count() === 1, 'finance: director reason field is missing');
  const recheckButton = page.getByRole('button', { name: /^Перепроверить$/ });
  const recordButton = page.getByRole('button', { name: /^Записать решение$/ });
  assert(await recheckButton.isDisabled(), 'finance: recheck must require a reason');
  assert(await recordButton.isDisabled(), 'finance: record decision must require a reason');
  await reasonField.fill('Проверено директором: нужен записанный результат.');
  assert(!(await recheckButton.isDisabled()), 'finance: recheck stays disabled after reason');
  assert(!(await recordButton.isDisabled()), 'finance: record decision stays disabled after reason');
  await assertSignatureChangedAfterClick(page, recordButton, 'finance: director action');

  await resetDirector(page);
  await clickSection(page, 'Производство');
  await clickFirstDirectorRow(page);
  await page.locator('.director-supervisor-actions button').first().click();
  await page.waitForTimeout(250);
  assert(await page.locator('[role="dialog"], .action-confirm-dialog').count() >= 1, 'production: supervisor action did not open confirmation dialog');

  await resetDirector(page);
  await clickSection(page, 'Склад');
  await clickFirstDirectorRow(page);
  await page.locator('.director-supervisor-actions button').first().click();
  await page.waitForTimeout(250);
  assert(await page.locator('[role="dialog"], .action-confirm-dialog').count() >= 1, 'warehouse: supervisor action did not open confirmation dialog');

  await resetDirector(page);
  await clickSection(page, 'Штрафы');
  await page.getByRole('button', { name: /Открыть операторов/ }).first().click();
  await page.waitForTimeout(250);
  assert((await collectText(page)).toLowerCase().includes('карточка оператора'), 'penalties: open operators action did not switch page');
  await resetDirector(page);
  await clickSection(page, 'Штрафы');
  await page.getByRole('button', { name: /Открыть журнал/ }).first().click();
  await page.waitForTimeout(250);
  assert((await collectText(page)).toLowerCase().includes('журнал штрафов') || await page.locator('.penalty-table').count() >= 1, 'penalties: open register action did not switch page');
}

async function verifySection(page, section, viewport) {
  const text = await collectText(page);
  const leaks = findForbidden(text);
  assert(leaks.length === 0, `${section}: forbidden terms visible: ${leaks.join(', ')}`);
  assert(!text.includes('Дашборд'), `${section}: old dashboard wording is visible`);

  if (section === 'Контроль') {
    assert(await page.locator('.management-control-board').count() === 1, 'control: single control board is missing');
    assert(await page.locator('.management-decision-focus').count() === 0, 'control: primary decision focus block must stay removed');
    assert(await page.locator('.management-selected-decision').count() === 0, 'control: old selected decision/evidence block must stay removed');
    assert(await page.locator('.management-health-strip').count() === 0, 'control: old health strip must stay removed');
    assert(await page.locator('.management-cockpit-grid').count() === 0, 'control: old situation cockpit must stay removed');
    assert(await page.locator('.management-situations').count() === 0, 'control: old situation lanes must stay removed');
    assert(await page.locator('.management-executive-kpis').count() === 1, 'control: KPI row is missing');
    assert(await page.locator('.management-report-kpi').count() === 6, 'control: expected six executive KPI cards');
    assert(await page.locator('.management-period-comparison').count() === 1, 'control: period comparison block is missing');
    assert(await page.locator('.management-period-toolbar').count() === 1, 'control: period toolbar is missing');
    assert(await page.locator('.management-period-selector').count() === 1, 'control: period selector is missing');
    assert(await page.locator('.management-period-calendar-toggle').count() === 1, 'control: period calendar control is missing');
    assert(await page.locator('.management-period-summary').count() === 6, 'control: expected six period summary metrics');
    assert(await page.locator('.management-period-chart-panel').count() === 0, 'control: fake daily period chart must not render');
    assert(await page.locator('.management-period-chart-column').count() === 0, 'control: fake daily chart columns must not render');
    assert(await page.locator('.management-period-signal-row').count() === 0, 'control: duplicate period signal rows must not render');
    assert(await page.locator('.management-period-report-row').count() === 0, 'control: old period report-row table must stay removed');
    assert(await page.locator('.management-period-table tbody tr').count() >= 5, 'control: period detail rows are missing');
    assert(await page.locator('.management-planfact-card').count() === 0, 'control: duplicate plan/fact cards must stay removed');
    assert(await page.locator('.management-report-table tbody tr').count() >= 1, 'control: finance table rows are missing');
    assert(await page.locator('.management-secondary-metrics').count() === 0, 'control: separate secondary metrics block must not render');
    assert(await page.locator('.management-report').count() === 0, 'control: metric cards must not render on first layer');
    const lowerText = text.toLowerCase();
    assert(lowerText.includes('финансы и производство'), 'control: report heading is missing');
    assert(lowerText.includes('план счетов') && lowerText.includes('оплачено') && lowerText.includes('просрочено'), 'control: finance KPI row is incomplete');
    assert(lowerText.includes('выработка') && lowerText.includes('средняя') && lowerText.includes('штрафы'), 'control: production/penalty KPI row is incomplete');
    assert(
      lowerText.includes('сегодня') && lowerText.includes('вчера') && lowerText.includes('неделя') && lowerText.includes('месяц'),
      'control: required period presets are missing',
    );
    await page.getByRole('button', { name: /^Вчера$/ }).click();
    await page.waitForTimeout(100);
    assert((await collectText(page)).includes('05.07'), 'control: yesterday preset did not update selected range');
    assert(lowerText.includes('производство по периодам'), 'control: period production table is missing');
    assert(lowerText.includes('рулоны') && lowerText.includes('брак') && lowerText.includes('склад принял') && lowerText.includes('не закрыто'), 'control: period production rows are incomplete');
    assert(!lowerText.includes('план: 0%'), 'control: internal payment percent leaked into KPI caption');
    assert(lowerText.includes('финансовая таблица'), 'control: finance table is missing');
    const controlLeaks = forbiddenControlTerms.filter((term) => lowerText.includes(term));
    assert(controlLeaks.length === 0, `control: unsupported KPI/penalty wording visible: ${controlLeaks.join(', ')}`);
    assert(!text.includes('Группы'), 'control: old group block label is visible');
    assert(!lowerText.includes('что требует решения сейчас'), 'control: old selected-situation heading is visible');
    assert(!lowerText.includes('где нужно решение'), 'control: old situation queue heading is visible');
    assert(!lowerText.includes('очередь ситуаций'), 'control: old situation queue wording is visible');
    assert(!text.includes('Назначить штраф'), 'control: penalty form leaked into first layer');
    assert(!text.includes('Журнал штрафов'), 'control: full penalty journal leaked into first layer');
  }

  if (section === 'Требуют решения') {
    assert(await page.locator('.director-table tbody tr').count() >= 1, 'decisions: decision rows are missing');
    assert(text.includes('Требуют решения'), 'decisions: concise queue heading is missing');
    assert(!text.toLowerCase().includes('что требует решения сейчас'), 'decisions: old large decision heading is visible');
    assert(!text.toLowerCase().includes('что ждет директора'), 'decisions: old fallback decision heading is visible');
    assert(!text.toLowerCase().includes('где нужно решение'), 'decisions: old grouped queue heading is visible');
    assert(await page.locator('.director-overview, .management-situation-lanes').filter({ visible: true }).count() === 0, 'decisions: old overview/situation blocks must stay removed');
    await assertDecisionQueueContract(page, `${viewport.name} decisions`);
  }

  if (section === 'Финансы') {
    assert(await page.locator('.director-finance-surface').count() === 1, 'finance: director finance surface is missing');
    assert(await page.locator('.director-finance-row').count() >= 1, 'finance: director finance situations are missing');
    await page.locator('.director-finance-row').first().click();
    await page.waitForTimeout(120);
    assert(await page.locator('.director-finance-reason-field textarea').count() === 1, 'finance: director reason field is missing');
    assert(text.includes('На чем основано') || text.includes('Финансовые ситуации'), 'finance: director finance evidence is missing');
    assert(text.includes('Источник') || text.includes('источник'), 'finance: source-aware wording is missing');
  }

  if (section === 'Производство') {
    assert(text.includes('Рецепт') || text.includes('Производственный риск'), 'production: recipe/production decisions are missing');
    assert(!text.includes('Примите заказ'), 'production: operator CTA leaked into director section');
  }

  if (section === 'Склад') {
    assert(text.includes('Частичная приемка') || text.includes('Склад'), 'warehouse: warehouse exceptions are missing');
    assert(!text.includes('Сканируйте QR подряд'), 'warehouse: routine scan workflow leaked into director section');
  }

  if (section === 'Штрафы') {
    assert(await page.locator('.penalty-assign-command').count() === 1, 'penalties: large assign command is missing');
    assert(text.includes('Назначение') && text.includes('Назначить штраф'), 'penalties: primary assign CTA is missing');
    for (const label of ['Сводка', 'Операторы', 'Журнал']) {
      assert(text.includes(label), `penalties: missing subpage ${label}`);
    }
    const assignTabCount = await page.locator('.penalty-subnav').getByRole('button', { name: /Назначить/i }).count();
    assert(assignTabCount === 0, 'penalties: assign must be a popup CTA, not a subpage tab');
    await page.locator('.penalty-assign-command-button').click();
    await page.locator('.penalty-dialog').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('.penalty-dialog').waitFor({ state: 'detached', timeout: 5000 });
    assert(!text.includes('Причины'), 'penalties: standalone reasons page is visible');
  }

  if (section === 'Аудит / QR') {
    assert(await page.locator('.director-qr-surface').count() === 1, 'audit: QR history surface is missing');
    assert(text.includes('Открыть историю рулона') && await page.locator('.director-qr-card').count() === 1, 'audit: QR history card is missing');
    assert(!text.includes('Переиздать этикетку'), 'audit: director must not expose label reprint action');
    await page.getByRole('button', { name: /Добавить комментарий к QR/ }).first().click();
    await page.locator('.director-qr-action-feedback').filter({ hasText: 'комментарий директора сохранен' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('button', { name: /Назначить владельца разбора/ }).first().click();
    await page.locator('.director-qr-action-feedback').filter({ hasText: 'владелец разбора назначен' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('.director-qr-scan-panel input').fill('QR-WRONG-2606');
    await page.locator('.director-qr-hero button').filter({ hasText: 'Открыть' }).first().click();
    await page.waitForTimeout(250);
    const afterScanText = await collectText(page);
    assert(afterScanText.toLowerCase().includes('qr не связан') || afterScanText.includes('Создать проблему'), 'audit: not-found history path is missing');
    await page.locator('.director-qr-scan-panel input').fill('QR-R-D09-01');
    await page.locator('.director-qr-hero button').filter({ hasText: 'Открыть' }).first().click();
    await page.getByRole('button', { name: /Открыть связанный заказ/ }).first().click();
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return text.includes('Складской QR-контекст WH-2606-042') || !document.querySelector('.director-qr-surface');
    });
    const linkedOrderText = await collectText(page);
    if (viewport.width >= 1200) {
      assert(linkedOrderText.includes('Складской QR-контекст WH-2606-042'), 'audit: linked order action did not open the selected warehouse QR context');
    } else {
      assert(await page.locator('.director-qr-surface').count() === 0 && linkedOrderText.includes('Склад'), 'audit: linked order action did not leave QR surface for warehouse context');
    }
  }
}

await mkdir(screenshotDir, { recursive: true });

const serverLogs = [];
const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  env: {
    ...process.env,
    VITE_LIVE_CONTOURS: '',
    VITE_REQUIRE_AUTH: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

let browser;
const report = { baseUrl, screenshotDir, viewports, sections, results: [] };

try {
  await waitForServer(server, serverLogs);
  browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}/?role=director`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    const navText = await collectText(page);
    for (const section of sections) {
      assert(navText.includes(section), `${viewport.name}: nav missing ${section}`);
    }

    for (const section of sections) {
      if (section !== 'Контроль') await clickSection(page, section);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.documentElement.scrollLeft = 0;
        document.body.scrollLeft = 0;
      });
      await checkNoHorizontalOverflow(page, `${viewport.name} ${section}`);
      await verifySection(page, section, viewport);
      const fileName = `director-${viewport.name}-${section.toLowerCase().replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-')}.png`;
      await page.screenshot({ path: path.join(screenshotDir, fileName), fullPage: true });
      report.results.push({ viewport: viewport.name, section, screenshot: fileName, status: 'passed' });
    }

    if (viewport.width >= 1200) {
      await assertDirectorActionSweep(page);
      report.results.push({ viewport: viewport.name, section: 'action-sweep', screenshot: null, status: 'passed' });
    }

    await page.close();
  }

  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Director Day 2 smoke passed: ${reportPath}`);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
