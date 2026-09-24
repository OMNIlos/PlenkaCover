import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  assertSmokeHealthy,
  collectVisibleErrors,
  installPageFailureTracker,
  startOwnedVite,
} from './release-smoke-runtime.mjs';

const screenshotDir = path.resolve('output/playwright/fixes-1433-finance');
const reportPath = path.join(screenshotDir, 'finance-acceptance-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');
const financeSections = ['Счета', 'Рассрочка', 'Сырьё', 'Просрочки'];
const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1366', width: 1366, height: 768 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];

let baseUrl = '';
let ownedVite;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedText(value) {
  return value.replace(/\s+/gu, ' ').trim();
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

async function gotoFinanceSection(page, viewport, section) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/?role=finance&section=${encodeURIComponent(section)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .locator('.app-shell[data-active-role="finance"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  const surface = page.locator('.finance-workbench, .finance-raw-material-surface').first();
  await surface.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(200);
  return surface;
}

async function assertExactNavigation(page, context) {
  const labels = (
    await page
      .locator('.section-nav-button, .role-top-nav-item, .mobile-section-nav-item')
      .allTextContents()
  )
    .map(normalizedText)
    .map((label) => label.replace(/\d+$/u, ''))
    .filter(Boolean);
  for (const section of financeSections) {
    assert(labels.includes(section), `${context}: missing section ${section}`);
  }
  for (const legacy of ['Обзор', 'Оплаты', 'История', 'Сверка источников', 'Исключения']) {
    assert(!labels.includes(legacy), `${context}: legacy section ${legacy} is still exposed`);
  }
}

async function assertNoHorizontalOverflow(page, context) {
  const geometry = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const clippedActions = Array.from(
      document.querySelectorAll('.finance-workbench button, .finance-raw-material-surface button'),
    )
      .filter(visible)
      .map((element) => ({
        label: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        rect: element.getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.left < -1 || rect.right > window.innerWidth + 1)
      .map(({ label }) => label);
    return {
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      clippedActions,
    };
  });
  assert(
    geometry.documentWidth <= geometry.viewport + 1 && geometry.bodyWidth <= geometry.viewport + 1,
    `${context}: horizontal overflow ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.clippedActions.length === 0,
    `${context}: clipped actions ${geometry.clippedActions.join(', ')}`,
  );
}

async function assertFinanceTypographyFloor(page, context) {
  const typography = await page.evaluate(() => {
    const root = document.querySelector('.finance-workbench, .finance-raw-material-surface');
    if (!root) return { primary: [], secondary: [] };
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const sizes = (selector) =>
      Array.from(root.querySelectorAll(selector))
        .filter(visible)
        .map((element) => ({
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
          size: Number.parseFloat(getComputedStyle(element).fontSize),
        }))
        .filter(({ text }) => text.length > 0);
    return {
      primary: sizes('button, input, select, td, dd, p, strong'),
      secondary: sizes(
        'small, .eyebrow, th, .finance-ledger-status, .finance-registry-toolbar label > span',
      ),
    };
  });
  assert(typography.primary.length > 0, `${context}: no primary finance text measured`);
  assert(typography.secondary.length > 0, `${context}: no secondary finance text measured`);
  const smallPrimary = typography.primary.filter(({ size }) => size < 15.99);
  const smallSecondary = typography.secondary.filter(({ size }) => size < 13.99);
  assert(
    smallPrimary.length === 0,
    `${context}: primary text below 16px ${JSON.stringify(smallPrimary.slice(0, 8))}`,
  );
  assert(
    smallSecondary.length === 0,
    `${context}: secondary text below 14px ${JSON.stringify(smallSecondary.slice(0, 8))}`,
  );
}

async function selectFinanceRow(page, id) {
  const row = page.locator(`.finance-ledger-row[data-object-id="${id}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 5_000 });
  await row.click();
  await page.locator('.finance-selected-command').waitFor({ state: 'visible' });
}

async function assertInvoiceTableContract(page, context) {
  const headings = await page
    .locator('.finance-ledger-table thead th')
    .allTextContents()
    .then((values) => values.map(normalizedText));
  for (const heading of ['Счёт / заказ', 'Контрагент', 'Оплачено', 'Остаток', 'Статус']) {
    assert(headings.includes(heading), `${context}: missing invoice column ${heading}`);
  }
}

async function assertFinanceContentStates(page, viewport) {
  const context = `finance ${viewport.name}`;
  await gotoFinanceSection(page, viewport, 'Счета');
  await assertExactNavigation(page, context);
  let text = await collectText(page);
  await assertInvoiceTableContract(page, context);
  assertIncludes(
    text,
    ['Реестр: Счета', 'Оплачено', 'Остаток', 'Статус'],
    `${context} invoice table`,
  );
  await selectFinanceRow(page, 'FIN-2606-021');
  text = await collectText(page);
  const longComment = await page
    .locator('.finance-context-history-list p')
    .allTextContents()
    .then(
      (values) => values.map(normalizedText).sort((left, right) => right.length - left.length)[0],
    );
  assert(
    (longComment?.length ?? 0) >= 48,
    `${context}: contextual history has no long comment (${JSON.stringify(longComment)})`,
  );
  assertIncludes(
    text,
    ['История счёта', 'Просроч', 'Счет и сумма', 'Оплата и рассрочка'],
    `${context} overdue detail and long comment`,
  );
  await assertFinanceTypographyFloor(page, `${context} selected invoice`);
  await assertNoHorizontalOverflow(page, `${context} selected invoice`);

  await gotoFinanceSection(page, viewport, 'Рассрочка');
  await selectFinanceRow(page, 'FIN-2606-020');
  text = await collectText(page);
  const installment = 'Полный график рассрочки';
  assertIncludes(text, [installment, 'Оплачено', 'Остаток'], `${context} installment`);
  await assertNoHorizontalOverflow(page, `${context} installment`);

  await gotoFinanceSection(page, viewport, 'Просрочки');
  text = await collectText(page);
  const overdue = 'Реестр: Просрочки';
  assertIncludes(text, [overdue, 'Просроч', '420 000 ₽'], `${context} overdue registry`);
  await assertNoHorizontalOverflow(page, `${context} overdue registry`);
}

const report = { generatedAt: new Date().toISOString(), scenarios: [] };

async function record(name, action) {
  try {
    await action();
    report.scenarios.push({ name, status: 'PASS' });
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
      VITE_LIVE_CONTOURS: '',
      VITE_REQUIRE_AUTH: 'off',
    },
  });
  baseUrl = ownedVite.baseUrl;
  report.baseUrl = baseUrl;
  browser = await chromium.launch({ headless: true });

  for (const viewport of viewports) {
    await record(`finance ${viewport.name}`, async () => {
      const page = await browser.newPage({ viewport });
      const tracker = installPageFailureTracker(page);
      await assertFinanceContentStates(page, viewport);
      assertSmokeHealthy(
        tracker,
        await collectVisibleErrors(page),
        `finance acceptance ${viewport.name}`,
      );
      await page.screenshot({
        path: path.join(screenshotDir, `finance-${viewport.name}.png`),
        fullPage: true,
      });
      await page.close();
    });
  }

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`PASS finance fixes-1433 acceptance: ${viewports.length} responsive viewports`);
} catch (error) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(
    () => undefined,
  );
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  ownedVite?.server.kill('SIGTERM');
}
