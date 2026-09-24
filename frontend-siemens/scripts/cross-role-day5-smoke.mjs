import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { installBusinessPerformanceSmokeFixture } from './business-performance-smoke-fixture.mjs';

const port = 5196;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = path.resolve('qa-screenshots/cross-role-day5-2026-06-17');
const reportPath = path.join(screenshotDir, 'cross-role-day5-smoke-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');

const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1366', width: 1366, height: 768 },
  { name: '390', width: 390, height: 844 },
];

const roles = ['commercial', 'production', 'finance', 'director', 'operator', 'warehouse', 'admin'];

const globalForbiddenCopy = [
  'данные невалидны',
  '1С не подтвердила',
  'internal enum',
  'mock',
  'adapter',
  'raw enum',
];

const nonAdminDiagnosticsForbidden = [
  'rawDiagnostics',
  'raw payload',
  'parsed payload',
  'source_id',
  'role_template_id',
  'hiddenScopes',
  'Скрытые группы',
  'Служебный сигнал',
  'Диагностика устройства',
];

const financeWorkForbidden = [
  'Бухгалтерия / финансовый контур',
  'Выставить счет',
  'Выставить счет к оплате',
  'Проверить оплату',
  'Отметить оплату вручную',
  'Обновить оплату',
  'Повторить проверку',
];

const productionExecutionActions = [
  'Зафиксировать вес',
  'Сигнал весов готов',
  'Печать QR',
  'Скан QR',
  'Сканировать QR',
  'Закрыть приемку',
  'Принять рулон',
];

const adminProductionForbidden = [
  'Зафиксировать вес',
  'Сигнал весов готов',
  'Сканировать QR',
  'Закрыть приемку',
  'Выставить счет',
  'Проверить оплату',
  'Отметить оплату вручную',
  'Обновить оплату',
];

const mobileTypographySelectors = {
  commercial: [
    '.commercial-next-action',
    '.commercial-decision-header',
    '.commercial-document-meta',
    '.commercial-key-values',
    '.commercial-cover-summary',
    '.commercial-payment-shipment-strip',
  ],
  production: [
    '.production-workbench',
    '.production-orders-hub',
    '.production-orders-table',
    '.production-order-expanded',
    '.production-decision-strip',
    '.production-actions',
    '.production-snapshot-grid',
  ],
  finance: [
    '.finance-action-surface',
    '.finance-primary-action-panel',
    '.finance-now-block',
    '.finance-timeline',
  ],
  director: ['.management-control-board', '.management-executive-kpis', '.management-report-kpi'],
  operator: ['.operator-focus', '.operator-runtime'],
  warehouse: ['.warehouse-scan-panel', '.warehouse-workbench'],
  admin: ['.admin-system-focus', '.admin-access-focus', '.admin-access-surface'],
};

let server;
let serverLogs = [];

function startServer() {
  serverLogs = [];
  // The smoke verifies the deterministic demo projection, not production authentication or APIs.
  server = spawn(
    viteBin,
    ['--host', '127.0.0.1', '--port', String(port), '--strictPort', '--mode', 'test'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_LIVE_CONTOURS: '',
        VITE_REQUIRE_AUTH: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1_000);
    server.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    server.kill('SIGTERM');
  });
}

async function restartServer() {
  await stopServer();
  startServer();
  await waitForServer();
}

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
      const response = await fetch(`${baseUrl}/?role=commercial`);
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
    .locator('[title], [aria-label], ix-tooltip')
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          [element.getAttribute('title'), element.getAttribute('aria-label'), element.textContent]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n'),
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
  const normalized = text.toLowerCase();
  const missing = needles.filter((needle) => !normalized.includes(needle.toLowerCase()));
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
          text: String(element.textContent ?? '')
            .trim()
            .slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter(
        (entry) => entry.width > 0 && (entry.left < -1 || entry.right > window.innerWidth + 1),
      )
      .slice(0, 8),
  }));

  assert(
    overflow.docWidth <= overflow.viewport + 1 && overflow.bodyWidth <= overflow.viewport + 1,
    `${context}: horizontal overflow ${overflow.docWidth}/${overflow.bodyWidth}/${overflow.viewport}; offenders=${JSON.stringify(overflow.offenders)}`,
  );
}

async function assertNoVisibleSub13(page, selectors, context) {
  const offenders = await page.evaluate((selectorList) => {
    const matches = selectorList.flatMap((selector) =>
      Array.from(document.querySelectorAll(`${selector}, ${selector} *`)),
    );
    return matches
      .map((element) => {
        const text = String(element.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        const rect = element.getBoundingClientRect();
        const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
        return {
          tag: element.tagName.toLowerCase(),
          className: String(element.getAttribute('class') ?? ''),
          text: text.slice(0, 80),
          top: Math.round(rect.top),
          fontSize,
          visible:
            text.length > 1 &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            fontSize > 0 &&
            fontSize < 13,
        };
      })
      .filter((entry) => entry.visible)
      .slice(0, 12);
  }, selectors);

  assert(offenders.length === 0, `${context}: visible sub-13px text ${JSON.stringify(offenders)}`);
}

async function gotoRole(page, role) {
  try {
    await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('ERR_CONNECTION_REFUSED')) throw error;
    await restartServer();
    await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
  }
  await page
    .locator(`.app-shell[data-active-role="${role}"]`)
    .waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(450);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
  });
}

async function clickSection(page, section) {
  const button = page
    .locator('.section-nav-button, .role-top-nav-item, .role-nav button, .role-top-nav button')
    .filter({ hasText: section })
    .first();
  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await page.waitForTimeout(300);
}

async function screenshot(page, name) {
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function firstVisibleTop(page, selectors) {
  return page.evaluate((selectorList) => {
    const matches = selectorList.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    const visible = matches
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: selectorList.find((selector) => element.matches(selector)) ?? '',
          text: String(element.textContent ?? '')
            .trim()
            .slice(0, 80),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter(
        (entry) =>
          entry.width > 0 && entry.height > 0 && entry.bottom > 0 && entry.top < window.innerHeight,
      );
    return visible.sort((a, b) => a.top - b.top)[0] ?? null;
  }, selectors);
}

async function assertFirstScreen(page, selectors, context, maxTop = 760) {
  const target = await firstVisibleTop(page, selectors);
  assert(target, `${context}: no target first-screen element found for ${selectors.join(', ')}`);
  assert(
    target.top <= maxTop,
    `${context}: first-screen element too low top=${target.top}, target=${JSON.stringify(target)}`,
  );
}

async function checkRoleBasics(page, role, viewportName) {
  await gotoRole(page, role);
  if (role === 'commercial') {
    await page.locator('.queue-row').first().getByRole('button').first().click();
    await page.waitForTimeout(700);
  }
  await checkNoHorizontalOverflow(page, `${role} ${viewportName}`);
  await assertNoTerms(page, globalForbiddenCopy, `${role} global forbidden copy ${viewportName}`);
  if (viewportName === '390') {
    await assertNoVisibleSub13(
      page,
      mobileTypographySelectors[role],
      `${role} mobile typography ${viewportName}`,
    );
  }

  if (role !== 'admin') {
    await assertNoTerms(
      page,
      nonAdminDiagnosticsForbidden,
      `${role} admin diagnostics leakage ${viewportName}`,
    );
  }

  const text = await collectText(page);
  switch (role) {
    case 'commercial':
      assertIncludes(text, ['Оплата', 'Выдача'], `commercial safe indicators ${viewportName}`);
      await assertNoTerms(
        page,
        ['Снимок источника', 'Источник данных', ...financeWorkForbidden, 'Назначить шаблон'],
        `commercial role leakage ${viewportName}`,
      );
      await assertFirstScreen(
        page,
        ['.commercial-primary-action', '.commercial-next-action', '.order-primary-action'],
        `commercial first action ${viewportName}`,
      );
      break;
    case 'production':
      assertIncludes(
        text,
        ['Заказ-наряды', 'Заказы', 'Рулоны'],
        `production orders hub ${viewportName}`,
      );
      assert(
        (await page.locator('.production-orders-hub').count()) === 1,
        `production orders hub surface ${viewportName}`,
      );
      {
        const ordersTable = page
          .locator('.production-orders-table-panel .plenki-data-table-shell')
          .first();
        assert((await ordersTable.count()) === 1, `production orders table ${viewportName}`);
        assert(
          (await ordersTable.locator('tbody tr:not(.plenki-data-table-expanded-row)').count()) > 0,
          `production orders rows ${viewportName}`,
        );
      }
      {
        if (viewportName !== '390') {
          const ordersTable = page
            .locator('.production-orders-table-panel .plenki-data-table-shell')
            .first();
          const orderSortCell = ordersTable.locator('thead th').nth(1);
          const orderSortHeader = orderSortCell.getByRole('button').first();
          await orderSortHeader.click();
          await page.waitForFunction(() => {
            const cell = document.querySelector(
              '.production-orders-table-panel .plenki-data-table-shell thead th:nth-child(2)',
            );
            return ['ascending', 'descending'].includes(cell?.getAttribute('aria-sort') ?? '');
          });
          const orderSortState = await orderSortCell.getAttribute('aria-sort');
          assert(
            ['ascending', 'descending'].includes(orderSortState ?? ''),
            `production order sort aria ${viewportName}`,
          );
        }
        const firstOrder = page.locator('.production-order-disclosure').first();
        if ((await firstOrder.getAttribute('aria-expanded')) !== 'true') {
          await firstOrder.click();
          await page.waitForTimeout(100);
        }
        assert(
          (await page.locator('.production-order-expanded').count()) > 0,
          `production order expanded rolls ${viewportName}`,
        );
      }
      assert(
        (await page.locator('.detail-panel .production-operator-load-card').count()) === 0,
        `production order detail must not embed operator workload ${viewportName}`,
      );
      await assertNoTerms(
        page,
        [
          'Сортировка',
          'Снимок источника',
          'Источник данных',
          ...financeWorkForbidden,
          'Назначить шаблон',
          'Параметры заказ-наряда',
        ],
        `production role leakage ${viewportName}`,
      );
      await assertFirstScreen(
        page,
        ['.production-orders-hub', '.plenki-data-table-shell', '.production-workbench'],
        `production first hub ${viewportName}`,
      );
      await screenshot(page, `production-hub-${viewportName}`);
      assert(
        (await page
          .locator('.production-orders-hub-tabs')
          .getByRole('button', { name: /^(Архив|Сводка)$/i })
          .count()) === 0,
        `production archive views stay out of order-selection ${viewportName}`,
      );
      await page
        .getByRole('button', { name: /^Все рулоны$/i })
        .first()
        .click();
      await page.waitForTimeout(150);
      assertIncludes(
        await page.locator('.production-orders-hub-tabs').innerText(),
        ['Рулоны', 'Архив', 'Сводка'],
        `production all-rolls views ${viewportName}`,
      );
      await page
        .locator('.production-orders-hub-tabs')
        .getByRole('button', { name: /^Рулоны$/i })
        .first()
        .click();
      await page.waitForTimeout(150);
      assert(
        (await page.locator('.production-roll-dispatch-table').count()) === 1,
        `production all-rolls dispatch table ${viewportName}`,
      );
      assert(
        (await page.locator('.production-roll-table-toolbar').count()) === 0,
        `production old all-rolls toolbar removed ${viewportName}`,
      );
      assert(
        (await page.locator('.production-priority-group-strip').count()) === 0,
        `production priority group cards removed ${viewportName}`,
      );
      assert(
        (await page.getByLabel(/Выбрать все рулоны/i).count()) > 0,
        `production roll select all ${viewportName}`,
      );
      assert(
        (await page.getByLabel(/Поднять рулон/i).count()) > 0,
        `production manual queue up ${viewportName}`,
      );
      assert(
        (await page.getByLabel(/Опустить рулон/i).count()) > 0,
        `production manual queue down ${viewportName}`,
      );
      await screenshot(page, `production-rolls-${viewportName}`);
      if (viewportName !== '390') {
        await page
          .locator('.production-roll-dispatch-table')
          .getByRole('button', { name: /Заказ/i })
          .first()
          .click();
        await page.waitForTimeout(80);
      }
      {
        const dispatchText = await page
          .locator('.production-roll-dispatch-table')
          .first()
          .innerText();
        assertIncludes(
          dispatchText,
          ['ЗН-2606-014', 'ЗН-2606-020'],
          `production global roll queue ${viewportName}`,
        );
        assert(
          !dispatchText.includes('Сортировка'),
          `production roll table must not show old sort toolbar copy ${viewportName}`,
        );
      }
      await page
        .locator('.production-orders-hub-tabs')
        .getByRole('button', { name: /^Архив$/i })
        .first()
        .click();
      await page.waitForTimeout(100);
      assertIncludes(
        await collectText(page),
        ['ЗН-2606-009', 'ЗН-2606-011'],
        `production archive examples ${viewportName}`,
      );
      await page
        .locator('.production-orders-hub-tabs')
        .getByRole('button', { name: /^Сводка$/i })
        .first()
        .click();
      await page.waitForTimeout(100);
      assertIncludes(
        await collectText(page),
        ['Блокеры', 'Операторы', 'Архив'],
        `production summary ${viewportName}`,
      );
      await page
        .getByRole('button', { name: /Операторы \/ загрузка/i })
        .first()
        .click();
      await page.waitForTimeout(150);
      assert(
        (await page.locator('.production-operator-load-surface').count()) === 1,
        `production operator workload standalone page ${viewportName}`,
      );
      assert(
        (await page.locator('.production-operator-load-table').count()) === 1,
        `production operator workload table ${viewportName}`,
      );
      assert(
        (await page.locator('.detail-view').count()) === 0,
        `production operator workload must not render order detail ${viewportName}`,
      );
      break;
    case 'finance':
      // Обзор-лендинг: календарь, счетчики и реестр; действие по делу открывается после выбора заказа.
      assertIncludes(
        text,
        ['Финансовый контур', 'Платежный календарь', 'Действие'],
        `finance overview landing ${viewportName}`,
      );
      await assertNoTerms(
        page,
        ['Назначить шаблон', ...productionExecutionActions],
        `finance role leakage ${viewportName}`,
      );
      await assertFirstScreen(
        page,
        ['.finance-payment-calendar-band', '.finance-command-counters', '.finance-command-header'],
        `finance first action ${viewportName}`,
      );
      if ((await page.locator('.finance-ledger-row').count()) > 0) {
        await page.locator('.finance-ledger-row').first().click();
        await page.waitForTimeout(250);
        const financeDetailText = await collectText(page);
        assertIncludes(
          financeDetailText,
          ['Счет и сумма', 'Действие'],
          `finance selected detail ${viewportName}`,
        );
        assert(
          (await page.locator('.finance-primary-action-panel').count()) >= 1,
          `finance selected action panel ${viewportName}`,
        );
      }
      break;
    case 'director':
      assertIncludes(
        text,
        ['Контроль', 'Бизнес-показатели', 'Выставлено', 'Оплачено', 'Произведено'],
        `director control surface ${viewportName}`,
      );
      assert(
        (await page.locator('.commercial-performance-metrics').count()) === 1,
        `director business KPI row ${viewportName}`,
      );
      assert(
        (await page.locator('.commercial-performance-metrics article').count()) === 9,
        `director business KPI card count ${viewportName}`,
      );
      assert(
        (await page
          .locator(
            '.management-selected-decision, .management-health-strip, .management-cockpit-grid, .management-situations, .management-situation-lanes',
          )
          .count()) === 0,
        `director old control blocks ${viewportName}`,
      );
      await assertNoTerms(
        page,
        ['Группы', 'Очередь ситуаций', 'Контроль решений'],
        `director duplicate control blocks ${viewportName}`,
      );
      await assertNoTerms(
        page,
        [
          'Бухгалтерия / финансовый контур',
          'Назначить шаблон',
          'raw payload',
          ...productionExecutionActions,
        ],
        `director role leakage ${viewportName}`,
      );
      assert(
        (await page.locator('.management-control-board, .management-planfact-card').count()) === 0,
        `director legacy control blocks ${viewportName}`,
      );
      await assertFirstScreen(
        page,
        ['.commercial-performance-workspace', '.commercial-performance-metrics'],
        `director first report ${viewportName}`,
      );
      break;
    case 'operator':
      {
        const rollSectionLabel = /Мои рулоны|Рулоны и заказы/i;
        const isRollSectionActive = await page
          .locator(
            '.section-nav-button.is-active, .role-top-nav-item.is-active, [aria-current="page"]',
          )
          .filter({ hasText: rollSectionLabel })
          .count();
        const hasOperatorRollRows = await page
          .locator('.operator-rolls-hub-row:not(.is-head), .operator-orders-row:not(.is-head)')
          .count();
        if (isRollSectionActive === 0 && hasOperatorRollRows === 0)
          await clickSection(page, rollSectionLabel);
      }
      await page
        .locator('.operator-rolls-hub-row:not(.is-head), .operator-orders-row:not(.is-head)')
        .first()
        .click();
      await page.waitForTimeout(450);
      {
        const operatorText = await collectText(page);
        assert(
          /Мои рулоны|Рулоны и заказы/i.test(operatorText),
          `operator roll section label ${viewportName}`,
        );
        assertIncludes(
          operatorText,
          ['R-A17-01', 'Принять'],
          `operator terminal current task ${viewportName}`,
        );
      }
      await assertNoTerms(
        page,
        [
          'Штрафы по операторам',
          'Сводка периода',
          'Счет и сумма',
          'Источник данных',
          'Снимок источника',
          '1С',
          ...financeWorkForbidden,
          'Назначить шаблон',
        ],
        `operator role leakage ${viewportName}`,
      );
      await assertFirstScreen(
        page,
        ['.operator-rolls-hub', '.operator-rolls-hub-row', '.operator-focus'],
        `operator first roll hub ${viewportName}`,
      );
      break;
    case 'warehouse':
      assertIncludes(
        text,
        ['Приемка', 'WH-2606-044', 'Готово к приемке'],
        `warehouse scan-first ${viewportName}`,
      );
      assertIncludes(text, ['Ожидаемые рулоны'], `warehouse roll intake ${viewportName}`);
      {
        const mixedPalletRow = page
          .locator('.warehouse-scan-station-data-table tbody tr')
          .filter({ hasText: /PAL-2606-07|Сборная палета/i })
          .first();
        assert(
          (await mixedPalletRow.count()) > 0,
          `warehouse mixed pallet row missing ${viewportName}`,
        );
        await mixedPalletRow.click();
        await page.waitForTimeout(500);
        const mixedText = await collectText(page);
        assertIncludes(
          mixedText,
          ['Ожидаемые рулоны', 'Палетный лист'],
          `warehouse mixed pallet roll intake ${viewportName}`,
        );
      }
      await assertNoTerms(
        page,
        [
          'Счет и сумма',
          'Источник данных',
          'Снимок источника',
          '1С',
          ...financeWorkForbidden,
          'Назначить шаблон',
        ],
        `warehouse role leakage ${viewportName}`,
      );
      await assertFirstScreen(
        page,
        [
          '.warehouse-scan-station-page',
          '.warehouse-scan',
          '.warehouse-inventory-cockpit',
          '.warehouse-scan-panel',
          '.warehouse-workbench',
          '.queue-row',
          '.queue-row-main',
        ],
        `warehouse first action ${viewportName}`,
      );
      break;
    case 'admin':
      if (viewportName === '390') {
        assertIncludes(
          text,
          ['Доступы', 'Устройства', '1С', 'Еще'],
          `admin mobile primary sections ${viewportName}`,
        );
        await page.locator('.mobile-section-nav-more').click();
        await page.waitForTimeout(250);
        const drawerText = await collectText(page);
        assertIncludes(
          drawerText,
          ['Шаблоны ролей', 'Проблемы / история'],
          `admin mobile secondary sections ${viewportName}`,
        );
      } else {
        assertIncludes(
          text,
          ['Доступы', 'Шаблоны ролей', 'Устройства', '1С', 'Проблемы / история'],
          `admin Day 4 sections ${viewportName}`,
        );
      }
      await assertNoTerms(
        page,
        adminProductionForbidden,
        `admin production/finance action leakage ${viewportName}`,
      );
      await assertFirstScreen(
        page,
        [
          '.admin-system-focus',
          '.admin-access-focus',
          '.admin-primary-safe-action',
          '.queue-row',
          '.queue-row-main',
        ],
        `admin first safe action ${viewportName}`,
      );
      break;
    default:
      throw new Error(`Unknown role ${role}`);
  }

  await screenshot(page, `${role}-${viewportName}`);
}

async function checkDirectorPenalties(page) {
  await gotoRole(page, 'director');
  await clickSection(page, 'Штрафы');
  const text = await collectText(page);
  assertIncludes(text, ['Штрафы', 'Операторы'], 'director penalties section');
  await assertNoTerms(
    page,
    ['Бухгалтерия / финансовый контур', 'Назначить шаблон'],
    'director penalties leakage',
  );
  await screenshot(page, 'director-penalties-1440');
}

async function checkAdminSections(page) {
  await gotoRole(page, 'admin');
  for (const section of ['Доступы', 'Шаблоны ролей', 'Устройства', '1С', 'Проблемы / история']) {
    await clickSection(page, section);
    const text = await collectText(page);
    assertIncludes(text, [section], `admin section ${section}`);
    await checkNoHorizontalOverflow(page, `admin section ${section}`);
    await assertNoTerms(
      page,
      adminProductionForbidden,
      `admin section ${section} production leakage`,
    );
  }
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
    report.scenarios.push({
      name,
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

let browser;
try {
  await mkdir(screenshotDir, { recursive: true });
  startServer();
  await waitForServer();
  browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    await installBusinessPerformanceSmokeFixture(page);
    for (const role of roles) {
      await record(`${role} ${viewport.name}`, () => checkRoleBasics(page, role, viewport.name));
    }
    await page.close();
  }

  const desktopPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await installBusinessPerformanceSmokeFixture(desktopPage);
  await record('director penalties separated', () => checkDirectorPenalties(desktopPage));
  await record('admin Day 4 sections', () => checkAdminSections(desktopPage));
  await desktopPage.close();
} finally {
  if (browser) await browser.close();
  await stopServer();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

const failures = report.scenarios.filter((scenario) => scenario.status !== 'PASS');
if (failures.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));
