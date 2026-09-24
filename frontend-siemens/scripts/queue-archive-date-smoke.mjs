import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { startOwnedVite } from './release-smoke-runtime.mjs';

let baseUrl = '';
const screenshotDir = path.resolve('qa-screenshots/queue-archive-date-2026-06-18');
const reportPath = path.join(screenshotDir, 'queue-archive-date-smoke-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');

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

async function checkNoHorizontalOverflow(page, context) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert(
    overflow.docWidth <= overflow.viewport + 1 && overflow.bodyWidth <= overflow.viewport + 1,
    `${context}: horizontal overflow doc=${overflow.docWidth}, body=${overflow.bodyWidth}, viewport=${overflow.viewport}`,
  );
}

async function gotoRole(page, role, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(600);
}

async function clickSection(page, label) {
  const directButton = page
    .locator('.section-nav-button, .role-top-nav-item, .mobile-section-nav-item')
    .filter({ hasText: label })
    .filter({ visible: true });
  if ((await directButton.count()) > 0) {
    await directButton.first().click();
  } else {
    await page
      .getByRole('button', { name: /^Еще разделы:/ })
      .filter({ visible: true })
      .click();
    const drawerButton = page.locator('.mobile-nav-drawer-item').filter({ hasText: label }).first();
    await drawerButton.waitFor({ state: 'visible', timeout: 5000 });
    await drawerButton.click();
  }
  await page.waitForTimeout(350);
}

async function clickQueueFilter(page, label) {
  const button = page.locator('.queue-toolbar .filter-chip').filter({ hasText: label }).first();
  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await page.waitForTimeout(350);
}

async function queueRowCount(page) {
  return page.locator('.object-list [data-object-id], .object-list .queue-row').count();
}

async function queueHasObject(page, objectId) {
  return page
    .locator(
      `.object-list [data-object-id="${objectId}"], .object-list .queue-row:has-text("${objectId}")`,
    )
    .count();
}

async function operatorHubRowCount(page) {
  return page.locator('.operator-rolls-hub-row:not(.is-head)').count();
}

async function operatorHubHasRoll(page, rollId) {
  return page.getByRole('row', { name: `Открыть рулон ${rollId}` }).count();
}

async function openDateDropdown(page) {
  const trigger = page.getByRole('button', { name: /(?:Дата|Период) (списка|очереди):/ }).first();
  await trigger.waitFor({ state: 'visible', timeout: 5000 });
  await trigger.click();
  await page.locator('.date-scope-popover').waitFor({ state: 'visible', timeout: 5000 });
}

const monthIndexByName = new Map(
  [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь',
  ].map((name, index) => [name, index]),
);

function calendarMonthOrdinal(label) {
  const [monthName, yearText] = label.trim().toLowerCase().split(/\s+/u);
  const monthIndex = monthIndexByName.get(monthName);
  const year = Number(yearText);
  assert(monthIndex !== undefined && Number.isInteger(year), `invalid calendar month: ${label}`);
  return year * 12 + monthIndex;
}

async function showCalendarMonth(page, targetLabel) {
  const targetOrdinal = calendarMonthOrdinal(targetLabel);
  const popover = page.locator('.date-scope-popover');
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const currentLabel = await popover.locator('.date-scope-head strong').innerText();
    const currentOrdinal = calendarMonthOrdinal(currentLabel);
    if (currentOrdinal === targetOrdinal) return;
    await popover
      .getByRole('button', {
        name: currentOrdinal < targetOrdinal ? 'Следующий месяц' : 'Предыдущий месяц',
        exact: true,
      })
      .click();
  }
  throw new Error(`calendar did not reach ${targetLabel}`);
}

async function assertDateDropdownVisible(page, context) {
  const metrics = await page
    .locator('.date-scope-popover')
    .first()
    .evaluate((popover) => {
      const rect = popover.getBoundingClientRect();
      const grid = popover.querySelector('.date-scope-grid');
      const gridStyle = grid ? window.getComputedStyle(grid) : null;
      const popoverRect = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
      const overlapTargets = Array.from(
        document.querySelectorAll('.queue-row, .finance-queue-card'),
      )
        .filter((target) => {
          const targetRect = target.getBoundingClientRect();
          const isVisible = targetRect.width > 0 && targetRect.height > 0;
          if (!isVisible) return false;
          const xOverlap = Math.max(
            0,
            Math.min(popoverRect.right, targetRect.right) -
              Math.max(popoverRect.left, targetRect.left),
          );
          const yOverlap = Math.max(
            0,
            Math.min(popoverRect.bottom, targetRect.bottom) -
              Math.max(popoverRect.top, targetRect.top),
          );
          return xOverlap > 2 && yOverlap > 2;
        })
        .map((target) => {
          const targetRect = target.getBoundingClientRect();
          return {
            className: target.getAttribute('class') ?? '',
            text: target.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
            top: Math.round(targetRect.top),
            bottom: Math.round(targetRect.bottom),
          };
        })
        .slice(0, 4);
      const visibleDays = Array.from(popover.querySelectorAll('.date-scope-weekday')).filter(
        (day) => {
          const dayRect = day.getBoundingClientRect();
          return (
            dayRect.width > 0 &&
            dayRect.height > 0 &&
            dayRect.left >= -1 &&
            dayRect.right <= window.innerWidth + 1
          );
        },
      ).length;
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        columns: gridStyle?.gridTemplateColumns ?? '',
        visibleDays,
        overlapTargets,
      };
    });
  assert(
    metrics.left >= 0 && metrics.right <= metrics.viewportWidth,
    `${context}: date dropdown is clipped horizontally ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.top >= 0 && metrics.bottom <= metrics.viewportHeight,
    `${context}: date dropdown is clipped vertically ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.visibleDays === 7,
    `${context}: date dropdown must show all 7 weekday columns ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.overlapTargets.length === 0,
    `${context}: date dropdown overlaps queue cards ${JSON.stringify(metrics)}`,
  );
}

async function screenshot(page, name) {
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function smokeFinanceArchiveAndDate(page) {
  await gotoRole(page, 'finance');
  await clickSection(page, 'Оплаты');
  let activeCount = await queueRowCount(page);
  assert(activeCount > 0, 'finance payments active queue is empty');
  assert(
    (await queueHasObject(page, 'FIN-2606-026')) === 0,
    'finance active payments should exclude paid FIN-2606-026',
  );

  await clickQueueFilter(page, 'Завершенные');
  const archiveCount = await queueRowCount(page);
  assert(archiveCount > 0, 'finance payments archive queue is empty');
  assert(
    activeCount !== archiveCount,
    `finance active/archive counts should differ, active=${activeCount}, archive=${archiveCount}`,
  );
  assert(
    (await queueHasObject(page, 'FIN-2606-026')) > 0,
    'finance archive should show paid FIN-2606-026',
  );
  assertIncludes(
    await collectText(page),
    ['Завершенные заказы', 'Только просмотр', 'Архив: оплата закрыта', 'Закрыто:', 'Остаток 0 ₽'],
    'finance archive paid card',
  );
  assert(
    (await page.locator('.finance-queue-card.is-archived[data-queue-bucket="completed"]').count()) >
      0,
    'finance archive cards must be marked as archived completed rows',
  );

  await clickQueueFilter(page, 'Актуальные');
  await clickSection(page, 'Обзор');
  activeCount = await queueRowCount(page);
  await openDateDropdown(page);
  await assertDateDropdownVisible(page, 'finance desktop date dropdown');
  await showCalendarMonth(page, 'Июнь 2026');
  const financeDay = page.getByRole('button', { name: /18 июня: .*строк/ });
  await financeDay.click();
  await financeDay.click();
  await page.waitForTimeout(500);
  const dateFilteredCount = await queueRowCount(page);
  assert(dateFilteredCount > 0, 'finance date-filtered queue is empty');
  assert(
    dateFilteredCount < activeCount,
    `finance date filter did not narrow queue, before=${activeCount}, after=${dateFilteredCount}`,
  );
  assert(
    (await queueHasObject(page, 'FIN-2606-023')) > 0,
    'finance 18 June date filter should show FIN-2606-023',
  );
  const dueTodayCard = page.locator('.finance-queue-card[data-object-id="FIN-2606-023"]').first();
  await dueTodayCard.waitFor({ state: 'visible', timeout: 5000 });
  await dueTodayCard.getByRole('button').click();
  await page.waitForTimeout(350);
  assertIncludes(
    await collectText(page),
    ['FIN-2606-023', 'Действие'],
    'finance date filter selected first object of day',
  );
  await screenshot(page, 'finance-archive-date-1440');
}

async function smokeOtherRoleArchiveBoundaries(page) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await gotoRole(page, 'commercial');
  await clickSection(page, 'В работе');
  await openDateDropdown(page);
  await assertDateDropdownVisible(page, 'commercial 1366 date dropdown');
  await page.keyboard.press('Escape');
  await page.locator('.date-scope-popover').waitFor({ state: 'hidden', timeout: 5000 });
  await page.setViewportSize({ width: 1440, height: 900 });

  await gotoRole(page, 'operator');
  assertIncludes(
    await collectText(page),
    ['Рулоны и заказы', 'R-A17-01', 'Принять'],
    'operator current-task boundary remains visible',
  );
  await clickSection(page, 'Переданы на склад');
  await page.locator('.operator-rolls-hub').waitFor({ state: 'visible', timeout: 5000 });
  const operatorArchiveCount = await operatorHubRowCount(page);
  assert(
    operatorArchiveCount >= 3,
    `operator handover hub should show transferred roll examples, count=${operatorArchiveCount}`,
  );
  assert(
    (await operatorHubHasRoll(page, 'R-E12-01')) > 0,
    'operator handover hub should show R-E12-01',
  );
  assert(
    (await operatorHubHasRoll(page, 'R-E12-02')) > 0,
    'operator handover hub should show R-E12-02',
  );
  assert(
    (await operatorHubHasRoll(page, 'R-E12-03')) > 0,
    'operator handover hub should show R-E12-03',
  );
  await openDateDropdown(page);
  await assertDateDropdownVisible(page, 'operator handover date dropdown');
  await showCalendarMonth(page, 'Июль 2026');
  const emptyDate = page.getByRole('button', { name: '1 июля: 0 строк', exact: true });
  await emptyDate.waitFor({ state: 'visible', timeout: 5000 });
  assert(
    !(await emptyDate.isDisabled()),
    'operator period calendar should allow an empty range boundary',
  );
  const operatorDay = page.getByRole('button', {
    name: '6 июля: 1 строк',
    exact: true,
  });
  await operatorDay.click();
  await operatorDay.click();
  await page.waitForTimeout(500);
  const operatorDateCount = await operatorHubRowCount(page);
  assert(
    operatorDateCount > 0 && operatorDateCount < operatorArchiveCount,
    `operator date filter should narrow transferred rolls, before=${operatorArchiveCount}, after=${operatorDateCount}`,
  );
  assert(
    (await operatorHubHasRoll(page, 'R-E12-03')) > 0,
    'operator 6 July filter should show R-E12-03',
  );
  assert(
    (await operatorHubHasRoll(page, 'R-E12-01')) === 0,
    'operator 6 July filter should hide R-E12-01',
  );
  const selectedHandoverRow = page
    .getByRole('row', { name: 'Открыть рулон R-E12-03' })
    .first();
  await selectedHandoverRow.click();
  await page.waitForTimeout(350);
  assert(
    (await selectedHandoverRow.getAttribute('aria-current')) === 'true',
    'operator handover selected row is not exposed as current',
  );
  await openDateDropdown(page);
  await page.getByRole('button', { name: 'Сбросить' }).click();
  await page.waitForTimeout(500);
  assert(
    (await operatorHubRowCount(page)) === operatorArchiveCount,
    'operator handover reset should restore transferred rolls',
  );
  await screenshot(page, 'operator-handover-date-1440');

  await gotoRole(page, 'production');
  assertIncludes(
    await collectText(page),
    ['Заказ-наряды', 'ЗН-2606-014', 'Готов к согласованию'],
    'production pre-handoff remains in active hub',
  );

  await gotoRole(page, 'warehouse');
  assertIncludes(
    await collectText(page),
    ['Приемка', 'Готово к приемке'],
    'warehouse hard-stop/scan queue remains visible',
  );
  const closedWarehouseRow = page
    .locator('.warehouse-scan-station-data-table tbody tr')
    .filter({ hasText: 'WH-2606-046' })
    .first();
  await closedWarehouseRow.waitFor({ state: 'visible', timeout: 5000 });
  assertIncludes(
    await closedWarehouseRow.innerText(),
    ['WH-2606-046', '2/2', 'Принято'],
    'warehouse closed receiving row',
  );
  await closedWarehouseRow.click();
  assertIncludes(
    await page.locator('.warehouse-scan-station-detail').innerText(),
    ['WH-2606-046', 'Принято', 'Сканировать нечего', 'История'],
    'warehouse closed receiving history boundary',
  );
  await screenshot(page, 'warehouse-archive-1440');
}

async function smokeMobileNoOverflow(page) {
  await gotoRole(page, 'finance', { width: 390, height: 844 });
  await checkNoHorizontalOverflow(page, 'finance archive date mobile');
  await openDateDropdown(page);
  await assertDateDropdownVisible(page, 'finance mobile date dropdown');
  await checkNoHorizontalOverflow(page, 'finance date dropdown mobile');
  await page.keyboard.press('Escape');
  await page.locator('.date-scope-popover').waitFor({ state: 'hidden', timeout: 5000 });
  await screenshot(page, 'finance-date-mobile-390');

  await gotoRole(page, 'operator', { width: 390, height: 844 });
  await clickSection(page, 'Переданы на склад');
  await page.locator('.operator-rolls-hub').waitFor({ state: 'visible', timeout: 5000 });
  await checkNoHorizontalOverflow(page, 'operator handover mobile');
  await openDateDropdown(page);
  await assertDateDropdownVisible(page, 'operator handover mobile date dropdown');
  await checkNoHorizontalOverflow(page, 'operator handover date dropdown mobile');
  await page.keyboard.press('Escape');
  await page.locator('.date-scope-popover').waitFor({ state: 'hidden', timeout: 5000 });
  await screenshot(page, 'operator-handover-mobile-390');
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
let ownedVite;
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
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

  await record('finance active archive and date dropdown', () => smokeFinanceArchiveAndDate(page));
  await record('other role archive and hard-stop boundaries', () =>
    smokeOtherRoleArchiveBoundaries(page),
  );
  await record('mobile date dropdown no overflow', () => smokeMobileNoOverflow(page));

  await page.close();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Queue archive/date smoke passed. Report: ${reportPath}`);
} catch (error) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  ownedVite?.server.kill('SIGTERM');
}
