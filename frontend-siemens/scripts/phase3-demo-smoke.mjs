import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { installBusinessPerformanceSmokeFixture } from './business-performance-smoke-fixture.mjs';
import { resolvePhase3ArtifactPaths } from './phase3-demo-artifacts.mjs';

const configuredPort = process.env.PHASE3_DEMO_SMOKE_PORT;
const port = Number(configuredPort ?? 5193);
const baseUrl = `http://127.0.0.1:${port}`;
const { screenshotDir, reportPath } = resolvePhase3ArtifactPaths({
  cwd: process.cwd(),
  runId: process.env.PHASE3_DEMO_SMOKE_RUN_ID,
  callerPort: configuredPort ? port : undefined,
});
const viteBin = path.resolve('node_modules/.bin/vite');

const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };
const roleLeakageForbidden = {
  operator: ['Статус оплаты', 'Источник оплаты', 'Бухгалтерская толщина', 'Откат', 'ООО', '1С'],
  warehouse: [
    'Статус оплаты',
    'Источник оплаты',
    'Бухгалтерская толщина',
    'Откат',
    'Частично оплачен',
    'Просрочка',
  ],
};
const internalForbidden = [
  ['source', 'stale'].join(' '),
  ['Q18', 'blocker'].join(' '),
  ['ждем', 'ответа', 'клиента'].join(' '),
  ['1С', 'не', 'подтверждена'].join(' '),
  ['pending', 'C07'].join(' '),
  ['Осп', 'орить'].join(''),
  ['осп', 'орить'].join(''),
  ['По', 'финансовому', 'событию'].join(' '),
  'mock',
  'adapter',
  'payload',
];

function waitForServer(server, serverLogs) {
  const deadline = Date.now() + 25_000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (server.exitCode !== null || server.signalCode !== null) {
        reject(
          new Error(`Vite demo server exited before ready.\n${serverLogs.join('\n').slice(-2000)}`),
        );
        return;
      }

      try {
        const response = await fetch(`${baseUrl}/?role=commercial`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Retry until preview is reachable.
      }

      if (Date.now() > deadline) {
        reject(
          new Error(
            `Vite demo server did not start in time.\n${serverLogs.join('\n').slice(-2000)}`,
          ),
        );
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, needles, context) {
  const missing = needles.filter((needle) => !text.includes(needle));
  assert(missing.length === 0, `${context}: missing ${missing.join(', ')}`);
}

function findTerms(text, terms) {
  const normalized = text.toLowerCase();
  return terms.filter((term) => {
    if (term === '1С') {
      return /(^|[\s"'«(])1с(?=$|[\s"'»:;,.!?)])/.test(normalized);
    }
    return normalized.includes(term.toLowerCase());
  });
}

async function checkNoForbidden(page, terms, context) {
  const text = await collectText(page);
  const leaks = findTerms(text, terms);
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

async function gotoRole(page, role, viewport = desktop) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
  });
}

async function switchRole(page, roleLabel) {
  await page.locator('.demo-role-button').filter({ hasText: roleLabel }).first().click();
  await page.waitForTimeout(300);
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function clickButton(page, name) {
  await page.locator('button:visible').filter({ hasText: name }).first().click();
  await page.waitForTimeout(250);
}

async function clickActionDialogButton(page, name) {
  const dialog = page.locator('.action-confirm-dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: 5_000 });
  await dialog.locator('button:visible').filter({ hasText: name }).first().click();
  await page.waitForTimeout(250);
}

async function fillActionDialogReason(page, reason) {
  const dialog = page.locator('.action-confirm-dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: 5_000 });
  await dialog.locator('textarea').fill(reason);
}

async function selectQueueRow(page, rowId) {
  const legacyRow = page.locator('.queue-row-main').filter({ hasText: rowId }).first();
  if (await legacyRow.count()) {
    await legacyRow.click();
    await page.waitForTimeout(250);
    return;
  }

  const buttonRow = page.locator('button:visible').filter({ hasText: rowId }).first();
  if (await buttonRow.count()) {
    await buttonRow.click();
    await page.waitForTimeout(250);
    return;
  }

  const tableRow = page.locator('tr:visible').filter({ hasText: rowId }).first();
  if (await tableRow.count()) {
    await tableRow.click();
    await page.waitForTimeout(250);
    return;
  }

  await page.locator('article:visible').filter({ hasText: rowId }).first().click();
  await page.waitForTimeout(250);
}

async function selectFinanceRegistryRow(page, rowId) {
  const registry = page.locator('[aria-label="Финансовые дела заказов"]');
  await registry.locator('input[type="search"]').fill(rowId);
  const row = registry.locator('tr:visible').filter({ hasText: rowId }).first();
  await row.waitFor({ state: 'visible', timeout: 5_000 });
  await row.click();
  await page.waitForTimeout(250);
}

async function clickSection(page, section) {
  const sectionButton = page
    .locator('.section-nav-button, .role-top-nav-item')
    .filter({ hasText: section })
    .first();
  await sectionButton.click();
  await page.waitForTimeout(250);
}

async function runCommercialSmoke(page) {
  await gotoRole(page, 'commercial');
  await selectQueueRow(page, 'З-2606-021');
  let text = await collectText(page);
  assertIncludes(
    text,
    [
      'Оплата',
      'Выдача',
      'Резерв',
      'Со склада',
      'Итог решения сохранен в истории заказа.',
      'Направить в бухгалтерию',
    ],
    'commercial full warehouse cover evidence',
  );
  assert(
    !text.includes('Подтвердить складское покрытие'),
    'commercial must not expose the removed manual warehouse-cover confirmation',
  );

  await clickButton(page, /Направить в бухгалтерию/i);
  await page.getByText('Заявка передана', { exact: true }).waitFor({
    state: 'visible',
    timeout: 5_000,
  });
  text = await collectText(page);
  assert(
    !text.includes('История рулона/QR'),
    'commercial should not expose a dead roll/QR history action',
  );
  assert(
    !text.includes('Запрос переиздания записан'),
    'commercial QR history must not write label reprint outcome',
  );
  await checkNoForbidden(page, internalForbidden, 'commercial');
  await screenshot(page, 'commercial-desktop');
}

async function runWarehouseSmoke(page) {
  await gotoRole(page, 'warehouse');
  await clickSection(page, 'Сырье');
  await page.waitForTimeout(250);
  let text = await collectText(page);
  assertIncludes(
    text,
    [
      'Сырье',
      'Все',
      'Внимание',
      'найдено',
      'Сбросить',
      'Объект',
      'На складе',
      'По учету / эффект',
      'Статус',
      'Откуда',
      'расхождение с учётом',
      'факт склада',
      '1186 кг',
    ],
    'warehouse inventory cockpit actual/reference split',
  );
  await page
    .getByRole('button')
    .filter({ hasText: 'ПВД 15803-020' })
    .filter({ hasText: '1186 кг' })
    .first()
    .click();
  await page.getByText('Факт склада используется, учетный снимок не блокирует выдачу').waitFor({
    state: 'visible',
    timeout: 5_000,
  });
  text = await collectText(page);
  assertIncludes(
    text,
    ['Факт склада используется'],
    'warehouse selected inventory source-of-truth detail',
  );
  assert(
    !text.includes('Что важно'),
    'warehouse inventory cockpit must not render legacy generic facts block',
  );

  const warehouseNavigationText = await page
    .locator('nav[aria-label="Разделы текущей роли"]')
    .first()
    .innerText();
  assert(
    !warehouseNavigationText.includes('Расходники') &&
      !warehouseNavigationText.includes('Движения'),
    'warehouse navigation must not expose removed consumables or movements tabs',
  );

  await checkNoForbidden(
    page,
    [...internalForbidden, ...roleLeakageForbidden.warehouse],
    'warehouse',
  );
  await screenshot(page, 'warehouse-desktop');
}

async function runFinanceSmoke(page) {
  await gotoRole(page, 'finance');
  await selectFinanceRegistryRow(page, 'ЗН-2606-025');
  let text = await collectText(page);
  let evidenceText = await page.locator('.finance-evidence-column').innerText();
  assertIncludes(
    evidenceText,
    ['Счет отправлен', '920 000 ₽', '300 000 ₽', '620 000 ₽'],
    'finance imported payment evidence',
  );
  let removedEvidence = findTerms(evidenceText, [
    'Номер счета',
    'Тип операции',
    'Статус оплаты',
    'Оплата и выдача',
  ]);
  assert(
    removedEvidence.length === 0,
    `finance simplified evidence: removed terms visible: ${removedEvidence.join(', ')}`,
  );

  await clickButton(page, 'К списку счетов');
  await selectFinanceRegistryRow(page, 'ЗН-2606-020');
  text = await collectText(page);
  assertIncludes(
    text,
    ['Рассрочка', 'Со следующих суток после отгрузки'],
    'finance shipment/installment split evidence',
  );

  await clickButton(page, 'К списку счетов');
  await selectFinanceRegistryRow(page, 'CASH-2606-01');
  text = await collectText(page);
  assertIncludes(
    text,
    ['120 000 ₽', 'наличные / ручная операция'],
    'finance cash operation evidence',
  );
  evidenceText = await page.locator('.finance-evidence-column').innerText();
  removedEvidence = findTerms(evidenceText, ['Номер счета', 'Тип операции', 'Статус оплаты']);
  assert(
    removedEvidence.length === 0,
    `finance cash simplified evidence: removed terms visible: ${removedEvidence.join(', ')}`,
  );
  await checkNoForbidden(page, internalForbidden, 'finance');
  await screenshot(page, 'finance-desktop');
}

async function runDirectorSmoke(page) {
  await gotoRole(page, 'director');
  const sharedWorkspaces = await page.locator('.commercial-performance-workspace').count();
  assert(
    sharedWorkspaces === 1,
    `director control must render one shared business workspace, got ${sharedWorkspaces}`,
  );
  const controlHeading = await page
    .locator('.commercial-performance-workspace')
    .getByRole('heading', { name: 'Контроль' })
    .count();
  assert(
    controlHeading === 1,
    `director shared workspace must keep the Control heading, got ${controlHeading}`,
  );

  const legacyDirectorBlocks = await page
    .locator(
      [
        '.management-control-board',
        '.management-selected-decision',
        '.management-health-strip',
        '.management-cockpit-grid',
        '.management-situations',
      ].join(', '),
    )
    .count();
  assert(
    legacyDirectorBlocks === 0,
    `director control must not render legacy control blocks, got ${legacyDirectorBlocks}`,
  );

  await page.getByRole('button', { name: 'Таблица', exact: true }).click();
  const controlColumns = await page
    .locator('.director-production-quality-panel .director-analytics-table th[scope="col"]')
    .allTextContents();
  const expectedControlColumns = [
    'Период',
    'Изготовлено, рул.',
    'Изготовлено, кг',
    'Рулонов с браком',
    'Брак, кг',
  ];
  assert(
    JSON.stringify(controlColumns) === JSON.stringify(expectedControlColumns),
    `director shared Control columns differ: ${controlColumns.join(' | ')}`,
  );
  const sharedControlText = await collectText(page);
  assertIncludes(
    sharedControlText.toLocaleLowerCase('ru-RU'),
    [
      'бизнес-показатели',
      'выставлено',
      'оплачено',
      'бракованные рулоны',
      'принято складом',
    ],
    'director shared Control facts',
  );
  await checkNoForbidden(page, internalForbidden, 'director control');
  await screenshot(page, 'director-dashboard-desktop');

  await clickSection(page, 'Штрафы');
  await page.locator('.penalty-assign-command-button').click();
  await page.waitForTimeout(250);
  const penaltyAssign = page.locator('.penalty-dialog');
  await penaltyAssign.waitFor({ state: 'visible', timeout: 5_000 });
  await penaltyAssign.locator('select').selectOption('production-lead-a');
  await penaltyAssign.locator('input').nth(0).fill('3 000 ₽');
  await penaltyAssign.locator('input').nth(1).fill('ЗН-2606-025');
  await penaltyAssign.locator('textarea').fill('Нарушен порядок подтверждения резерва');
  await penaltyAssign.getByRole('button', { name: /^Назначить штраф$/i }).click();
  await page.waitForTimeout(250);
  await penaltyAssign.waitFor({ state: 'detached', timeout: 5_000 });
  const penaltyText = await collectText(page);
  assertIncludes(
    penaltyText,
    ['Зав. производства Артур', 'Уведомлен', 'Нарушен порядок подтверждения резерва'],
    'director penalty to production lead',
  );
  await checkNoForbidden(page, internalForbidden, 'director penalties');
  await screenshot(page, 'director-penalty-desktop');

  await switchRole(page, 'Зав. производства');
  await clickSection(page, 'Штрафы');
  const productionPenaltyText = await collectText(page);
  assertIncludes(
    productionPenaltyText,
    ['Зав. производства Артур', 'Уведомлен', 'Нарушен порядок подтверждения резерва'],
    'production lead penalty notice',
  );
  await checkNoForbidden(page, internalForbidden, 'production penalty notice');
}

async function runRoleLeakageSmoke(page) {
  for (const role of ['operator', 'warehouse']) {
    await gotoRole(page, role);
    await checkNoForbidden(
      page,
      [...internalForbidden, ...roleLeakageForbidden[role]],
      `${role} leakage`,
    );
  }
}

async function runMobileSmoke(page) {
  for (const role of ['commercial', 'warehouse', 'director']) {
    await gotoRole(page, role, mobile);
    await checkNoHorizontalOverflow(page, `${role} mobile`);
    await checkNoForbidden(page, internalForbidden, `${role} mobile`);
    await screenshot(page, `${role}-mobile-390`);
  }
}

await mkdir(screenshotDir, { recursive: true });

const serverLogs = [];
// This scenario intentionally exercises the fixture-backed role switcher. A production
// preview enables AuthGate unconditionally and would only test the login screen.
const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  env: {
    ...process.env,
    CI: 'true',
    VITE_LIVE_CONTOURS: '',
    VITE_REQUIRE_AUTH: 'off',
  },
});
server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

let browser;
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

try {
  await waitForServer(server, serverLogs);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: desktop });
  await installBusinessPerformanceSmokeFixture(page);

  await record('commercial detail + read-only reserve evidence + handoff', () =>
    runCommercialSmoke(page),
  );
  await record('warehouse raw materials + secondary movement signature', () =>
    runWarehouseSmoke(page),
  );
  await record('finance imported payment + shipment/installment split', () =>
    runFinanceSmoke(page),
  );
  await record('director shared Control table + production lead penalty notice', () =>
    runDirectorSmoke(page),
  );
  await record('operator/warehouse leakage', () => runRoleLeakageSmoke(page));
  await record('mobile 390px no horizontal overflow on changed surfaces', () =>
    runMobileSmoke(page),
  );

  await page.close();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Phase 3 demo smoke passed. Report: ${reportPath}`);
} catch (error) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
