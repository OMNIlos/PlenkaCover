import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { installBusinessPerformanceSmokeFixture } from './business-performance-smoke-fixture.mjs';
import { installWarehouseApiFixture as installSafeWarehouseApiFixture } from './role-display-contract-smoke-fixture.mjs';
import {
  assertFinancePositiveDefaultState,
  assertSmokeHealthy,
  collectVisibleErrors,
  installPageFailureTracker,
  startOwnedVite,
} from './release-smoke-runtime.mjs';

let baseUrl = '';
const screenshotDir = path.resolve('qa-screenshots/role-display-contract-2026-06-18');
const reportPath = path.join(screenshotDir, 'role-display-contract-smoke-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');

const rawForbidden = [
  'audit:',
  'problem:',
  'notification:',
  'mock_1C',
  'warehouse_delivery_mock',
  'payment_schedule_mock',
  'source error',
  'Source snapshot',
  'source snapshots',
  'source layer',
  'payload',
  'WarehouseCoverProposal',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function collectText(page) {
  const bodyText = await page.locator('body').innerText();
  const attributeText = await page
    .locator('[title], [aria-label]')
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          [element.getAttribute('title'), element.getAttribute('aria-label')]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n'),
    );
  return `${bodyText}\n${attributeText}`;
}

function assertIncludes(text, needles, context) {
  const normalized = text.toLowerCase();
  const missing = needles.filter((needle) => !normalized.includes(needle.toLowerCase()));
  assert(missing.length === 0, `${context}: missing ${missing.join(', ')}`);
}

function assertNoTerms(text, terms, context) {
  const normalized = text.toLowerCase();
  const hits = terms.filter((term) => normalized.includes(term.toLowerCase()));
  assert(hits.length === 0, `${context}: forbidden terms visible: ${hits.join(', ')}`);
}

async function gotoRole(page, role, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);
}

async function clickSection(page, label) {
  const button = page
    .locator('.section-nav-button, .role-top-nav-item')
    .filter({ hasText: label })
    .first();
  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await page.waitForTimeout(300);
}

async function assertFinancePositiveDefault(page, context) {
  const activeSection = await page
    .locator('.section-nav-button[aria-current="page"], .role-top-nav-item[aria-current="page"]')
    .first()
    .innerText();
  const visibleAlerts = await page
    .locator('[role="alert"]:visible')
    .allTextContents()
    .then((values) => values.map((value) => value.trim()).filter(Boolean));
  assertFinancePositiveDefaultState(
    {
      activeSection: activeSection.trim().split('\n')[0].replace(/\d+$/u, ''),
      registryVisible: await page.locator('.finance-ledger-table').isVisible(),
      selectedDetails: await page.locator('.finance-selected-command:visible').count(),
      explicitObject: new URL(page.url()).searchParams.has('object'),
      visibleAlerts,
    },
    context,
  );
}

async function screenshot(page, name) {
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function smokeFinanceDisplay(page) {
  await gotoRole(page, 'finance');
  await assertFinancePositiveDefault(page, 'finance display positive-first default');
  await page.locator('[data-object-id="FIN-2606-014"]').first().click();
  await page.waitForTimeout(250);
  let text = await collectText(page);
  assertIncludes(
    text,
    ['FIN-2606-014', 'Выставить счет', 'Счет и сумма', 'Оплата и рассрочка'],
    'finance positive-first invoice detail',
  );
  assertNoTerms(text, rawForbidden, 'finance positive-first raw labels');

  await gotoRole(page, 'finance');
  await clickSection(page, 'Рассрочка');
  await page.locator('[data-object-id="FIN-2606-020"]').first().click();
  await page.waitForTimeout(250);
  text = await collectText(page);
  assertIncludes(
    text,
    ['Полный график рассрочки', 'Оплачено', 'Остаток'],
    'finance installment display labels',
  );
  assertNoTerms(text, rawForbidden, 'finance installment raw contract labels');

  await clickSection(page, 'Просрочки');
  text = await collectText(page);
  assertIncludes(
    text,
    ['Реестр: Просрочки', 'Просроч', '420 000 ₽'],
    'finance overdue display labels',
  );
  assertNoTerms(text, rawForbidden, 'finance overdue raw labels');

  await clickSection(page, 'Сырьё');
  text = await collectText(page);
  assertIncludes(text, ['Сырьё'], 'finance raw-material display labels');
  assertNoTerms(text, rawForbidden, 'finance raw-material safe projection');
  await screenshot(page, 'finance-four-section-contract');
}

async function smokeDirectorDisplay(page) {
  await gotoRole(page, 'director');
  let text = await collectText(page);
  assertIncludes(text, ['Финансы', 'Источник'], 'director finance overview labels');
  assertNoTerms(text, rawForbidden, 'director raw labels');

  await clickSection(page, 'Финансы');
  const financeRow = page.getByRole('row').filter({ hasText: 'ЗН-2606-021' }).first();
  await financeRow.waitFor({ state: 'visible', timeout: 5000 });
  text = await collectText(page);
  assertIncludes(
    text,
    [
      'Бизнес-показатели',
      'Заказ',
      'Контрагент',
      'Условия оплаты',
      'ЗН-2606-021',
      'Частично оплачено',
    ],
    'director finance table labels',
  );
  assertNoTerms(text, rawForbidden, 'director finance table raw labels');
  await screenshot(page, 'director-finance-contract');
}

async function smokeSafeRoles(page) {
  await gotoRole(page, 'commercial');
  await page.locator('.queue-row').first().getByRole('button').first().click();
  await page.waitForTimeout(250);
  let text = await collectText(page);
  assertIncludes(text, ['Оплата', 'Выдача'], 'commercial safe finance indicators');
  assertNoTerms(
    text,
    [
      ...rawForbidden,
      'Статус счета',
      'Источник данных',
      'Выставить счет',
      'Проверить оплату',
      'Отметить оплату вручную',
      'Обновить оплату',
    ],
    'commercial safe finance boundary',
  );

  await gotoRole(page, 'operator', { width: 390, height: 844 });
  text = await collectText(page);
  assertNoTerms(
    text,
    [
      ...rawForbidden,
      'Статус оплаты',
      'Сумма',
      'Остаток',
      'Источник данных',
      '1С',
      'Контрагент',
      'Заказчик',
    ],
    'operator finance display boundary',
  );

  await gotoRole(page, 'warehouse', { width: 390, height: 844 });
  text = await collectText(page);
  assertNoTerms(
    text,
    [
      ...rawForbidden,
      'Статус оплаты',
      'Сумма',
      'Остаток',
      'Источник данных',
      '1С',
      'Контрагент',
      'Заказчик',
    ],
    'warehouse finance display boundary',
  );
}

async function selectedSurfaceText(page, role) {
  const locator =
    role === 'director'
      ? page.locator('.director-drawer').first()
      : page.locator('.detail-panel').first();
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  return locator.innerText();
}

async function mobilePrimaryNavLabels(page) {
  return page
    .locator(
      '.mobile-section-nav .mobile-section-nav-item:not(.mobile-section-nav-more) .section-nav-copy strong',
    )
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const element = node;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          );
        })
        .map((node) => node.textContent?.trim() ?? '')
        .filter(Boolean),
    );
}

async function assertMobilePositiveNav(page, role) {
  await gotoRole(page, role, { width: 390, height: 844 });
  const labels = await mobilePrimaryNavLabels(page);
  const forbidden = [
    'Исключения',
    'Просрочка',
    'Ошибки QR',
    'Заблокированы',
    'Штрафы',
    'Проблемы / история',
  ];
  const hits = labels.filter((label) => forbidden.includes(label));
  assert(
    hits.length === 0,
    `${role} mobile primary nav must be positive-first; got ${labels.join(' / ')}`,
  );
}

async function smokeMobilePositiveNavigation(page) {
  for (const role of [
    'commercial',
    'production',
    'finance',
    'director',
    'operator',
    'warehouse',
    'admin',
  ]) {
    await assertMobilePositiveNav(page, role);
  }
}

async function smokeExplicitExceptionFirst(page) {
  await gotoRole(page, 'finance');
  await clickSection(page, 'Просрочки');
  const firstFinanceException = await page.locator('.finance-ledger-row').first().innerText();
  assertIncludes(
    firstFinanceException,
    ['Просрочка'],
    'finance explicit exception section first row',
  );

  const labels = await page
    .locator('.section-nav-button, .role-top-nav-item')
    .allTextContents()
    .then((values) =>
      values.map((value) => value.replace(/\s+/gu, ' ').trim().replace(/\d+$/u, '')),
    );
  for (const legacy of ['Исключения', 'Сверка источников', 'Обзор', 'Оплаты', 'История']) {
    assert(!labels.includes(legacy), `finance legacy section ${legacy} is still exposed`);
  }
}

async function smokePositiveFirstDefaults(page) {
  await gotoRole(page, 'commercial');
  assert(
    (await page.locator('.list-panel .queue-row').count()) > 0,
    'commercial default must render work queue',
  );
  assert(
    (await page.locator('.queue-row.is-selected').count()) === 0,
    'commercial default must not preselect a queue row',
  );
  assert(
    (await page.locator('.detail-view').count()) === 0,
    'commercial default must leave detail empty until selection',
  );
  await page.locator('.queue-row-main').first().click();
  await page.waitForTimeout(250);
  assert(
    (await page.locator('.list-panel .queue-row').count()) > 0,
    'commercial selected detail must keep work queue visible',
  );
  let text = await selectedSurfaceText(page, 'commercial');
  assertIncludes(text, ['З-2606'], 'commercial selected surface after explicit row click');

  const defaults = [
    ['production', 'ЗН-2606-014'],
    ['finance', 'FIN-2606-014'],
    ['operator', 'A-17'],
    ['warehouse', 'WH-2606-042'],
    ['admin', 'Весы линии A-01'],
  ];

  await gotoRole(page, 'director');
  text = await collectText(page);
  assertIncludes(text, ['Контроль'], 'director default control surface');
  await clickSection(page, 'Финансы');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    (await page.locator('.commercial-performance-workspace tbody tr').count()) > 0,
    'director finance must render a full-width queue',
  );
  assert(
    (await page
      .locator('.director-drawer:visible, .director-mobile-detail-layer:visible')
      .count()) === 0,
    'director finance queue must not auto-open a selected detail card',
  );
  text = await collectText(page);
  assertIncludes(text, ['ЗН-2606-021'], 'director finance queue');

  for (const [role, expected] of defaults) {
    await gotoRole(page, role);
    if (role === 'finance') {
      await assertFinancePositiveDefault(page, 'finance positive-first default');
      await clickSection(page, 'Счета');
      await page.locator('[data-object-id="FIN-2606-014"]').first().click();
      await page.waitForTimeout(250);
    }
    text = await selectedSurfaceText(page, role);
    assertIncludes(text, [expected], `${role} positive-first selected surface`);
  }

  await gotoRole(page, 'warehouse');
  await clickSection(page, 'Все рулоны');
  const stockWorkspace = page.locator('.warehouse-stock-workspace');
  await stockWorkspace.waitFor({ state: 'visible', timeout: 5000 });
  await stockWorkspace.locator('.warehouse-stock-data-table').waitFor({
    state: 'visible',
    timeout: 5000,
  });
  assert(
    (await page.locator('.warehouse-stock-workspace').count()) === 1,
    'warehouse inventory must render one stock workspace',
  );
  assert(
    (await page.locator('.warehouse-stock-data-table').count()) === 1,
    'warehouse inventory must render one primary table',
  );
  assert(
    (await page
      .locator(
        '.warehouse-section-list, .warehouse-inventory-table, .warehouse-inventory-data-table',
      )
      .count()) === 0,
    'warehouse inventory must not render legacy duplicate lists or tables',
  );
  const inventoryText = await stockWorkspace.innerText();
  assertIncludes(
    inventoryText,
    ['Все рулоны', 'Рулоны на складе', 'Рулоны', 'Обработанные'],
    'warehouse inventory direct detail',
  );
  assertNoTerms(inventoryText, rawForbidden, 'warehouse inventory raw labels');
}

const report = {
  baseUrl,
  screenshotDir,
  scenarios: [],
};

let ownedVite;
let smokePage;
let smokeTracker;

async function record(name, fn) {
  try {
    await fn();
    ownedVite.assertAlive(name);
    assertSmokeHealthy(smokeTracker, await collectVisibleErrors(smokePage), name);
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
  ownedVite = await startOwnedVite({
    viteBin,
    cwd: process.cwd(),
    mode: 'test',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_LIVE_CONTOURS: 'warehouse',
      VITE_REQUIRE_AUTH: 'off',
    },
  });
  baseUrl = ownedVite.baseUrl;
  report.baseUrl = baseUrl;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  smokePage = page;
  smokeTracker = installPageFailureTracker(page);
  await page.addInitScript(
    ({ now }) => {
      const NativeDate = Date;
      class FixedDate extends NativeDate {
        constructor(...args) {
          super(...(args.length === 0 ? [now] : args));
        }

        static now() {
          return now;
        }
      }
      window.Date = FixedDate;
    },
    { now: Date.parse('2026-06-18T09:00:00.000+03:00') },
  );
  await installSafeWarehouseApiFixture(page);
  await installBusinessPerformanceSmokeFixture(page, {
    financeItems: [
      {
        id: 'role-display-finance-021',
        orderNumber: 'ЗН-2606-021',
        counterpartyName: 'Контур',
        invoiceStatus: 'invoiced',
        paymentStatus: 'partial',
        paymentPlanKind: 'half_split',
        paymentPlanLabel: '50/50',
        invoicedAmount: 420_000,
        paidAmount: 210_000,
        remainingAmount: 210_000,
        nextConfirmedDueAt: '2026-06-18T09:00:00.000Z',
        updatedAt: '2026-06-18T09:00:00.000Z',
      },
    ],
  });

  await record('positive-first defaults', () => smokePositiveFirstDefaults(page));
  await record('mobile positive-first navigation', () => smokeMobilePositiveNavigation(page));
  await record('explicit exception-first sections', () => smokeExplicitExceptionFirst(page));
  await record('finance display contract', () => smokeFinanceDisplay(page));
  await record('director display contract', () => smokeDirectorDisplay(page));
  await record('safe role display boundaries', () => smokeSafeRoles(page));

  await page.close();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Role display contract smoke passed. Report: ${reportPath}`);
} catch (error) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  ownedVite?.server.kill('SIGTERM');
}
