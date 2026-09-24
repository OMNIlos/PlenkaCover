import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { assertCompleteNightlyCoverage } from './nightly-show-ready-audit-support.mjs';

const port = 5193;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = path.resolve('qa-screenshots/nightly-show-ready-2026-06-05');
const reportPath = path.join(screenshotDir, 'nightly-show-ready-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');

const roles = ['commercial', 'production', 'finance', 'director', 'operator', 'warehouse', 'admin'];
const viewports = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'desktop-1366', width: 1366, height: 768 },
  { name: 'tablet-1024', width: 1024, height: 768 },
  { name: 'mobile-390', width: 390, height: 844 },
];
const pictogramRoles = new Set(['operator', 'warehouse', 'admin']);
const maxRowCasesPerRole = 1;

const roleRowSelectors = {
  commercial: [
    '[data-commercial-order-id]:visible',
    '.queue-row[data-object-id]:visible',
  ],
  production: [
    '.production-orders-table-panel .plenki-data-table tbody > tr:not(.plenki-data-table-expanded-row):not(.plenki-data-table-empty-row):visible',
    '.production-roll-dispatch-row:not(.is-head):visible',
    '.queue-row[data-object-id]:visible',
  ],
  finance: [
    '.finance-queue-card[data-object-id]:visible',
    '.queue-row[data-object-id]:visible',
  ],
  operator: [
    '.operator-rolls-hub-row:not(.is-head):visible',
    '.queue-row[data-object-id]:visible',
  ],
  warehouse: [
    '.warehouse-scan-station-data-table tbody tr:not(.plenki-data-table-empty-row):visible',
    '.warehouse-inventory-table tbody tr:not(.plenki-data-table-empty-row):visible',
    '.queue-row[data-object-id]:visible',
  ],
  admin: [
    '.admin-users-table tbody tr:not(.plenki-data-table-empty-row):visible',
    '[data-testid="admin-incidents"] tbody tr:not(.plenki-data-table-empty-row):visible',
    '.queue-row[data-object-id]:visible',
  ],
};

const explicitStateSelectors = [
  {
    variant: 'error-state',
    selector:
      '[role="alert"]:visible, .commercial-live-error-state:visible, .live-role-unavailable:visible',
  },
  {
    variant: 'loading-state',
    selector:
      '.commercial-live-skeleton:visible, .admin-live-loading:visible, [aria-busy="true"]:visible',
  },
  {
    variant: 'empty-state',
    selector:
      '.commercial-live-empty-state:visible, .plenki-empty-state:visible, ix-empty-state:visible, .warehouse-inventory-empty:visible, .production-operator-load-empty:visible, .detail-blank-state:visible',
  },
];

const globalForbidden = [
  'Демо-роли',
  'Демо',
  'demo',
  'mock',
  'adapter',
  'source of truth',
  'ProductionOrder',
  'AuditEvent',
  'OperationalEvent',
  'production-интеграция',
  'started',
  'closed facts',
  'payload',
  'Проверить QR',
  'Наклеил этикетку',
  'Завпроизводство',
  'Evidence',
  'Event',
  'Detail',
  'Audit',
  'missing',
  'owner',
  'OK',
];

const roleForbidden = {
  operator: ['Счет', 'Оплата', 'Статус оплаты', 'Бухгалтерская толщина', 'Отгрузка', 'Откат', '1С', 'ООО', 'Контрагент', 'Заказчик', 'Сумма', 'Рассрочка', 'Штраф'],
  warehouse: ['Откат', 'Статус оплаты', 'Бухгалтерская толщина', 'Сумма', 'Влияние на стоимость', 'Оплата', 'Рассрочка', 'Штраф', 'ООО', 'Контрагент', 'Заказчик', 'Рецептура', 'Частично оплачен', 'Не оплачен', 'Просрочка'],
};

function waitForServer(server, serverLogs) {
  const deadline = Date.now() + 25_000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (server.exitCode !== null || server.signalCode !== null) {
        reject(new Error(`Vite server exited before it was ready.\n${serverLogs.join('\n').slice(-2000)}`));
        return;
      }

      try {
        const response = await fetch(`${baseUrl}/?role=operator`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // retry
      }
      if (Date.now() > deadline) {
        reject(new Error(`Vite server did not start in time.\n${serverLogs.join('\n').slice(-2000)}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function safeName(value) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'state';
}

function findLeaks(text, terms) {
  const normalized = text.toLowerCase();
  return terms.filter((term) => {
    if (term === '1С') {
      return /(^|[\s"'«(])1с(?=$|[\s"'»:;,.!?)])/.test(normalized);
    }
    if (term === 'Счет') {
      return /(^|[\s"'«(])счет(?=$|[\s"'»:;,.!?)])/.test(normalized);
    }
    if (term === 'Event') {
      return /(^|[\s"'«(])event(?=$|[\s"'»:;,.!?)])/.test(normalized);
    }
    if (term === 'Демо') {
      return /(^|[\s"'«(])демо(?=$|[\s"'»:;,.!?)])/.test(normalized);
    }
    return normalized.includes(term.toLowerCase());
  });
}

function leakContexts(text, leaks) {
  const normalized = text.toLowerCase();
  return leaks.map((term) => {
    const index = normalized.indexOf(term.toLowerCase());
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + term.length + 80);
    return `${term}: ${text.slice(start, end).replace(/\s+/g, ' ')}`;
  });
}

function isIgnoredDevConsoleError(text) {
  return (
	    text.includes('WebSocket connection to') && text.includes('ERR_CONNECTION_REFUSED') ||
	    text.includes('WebSocket connection to') && text.includes('Unexpected response code: 200') ||
	    text.includes('WebSocket connection to') && text.includes('Unexpected response code: 400') ||
    text.includes('[vite] failed to connect to websocket') ||
    text.includes('Failed to send error to Vite server') && text.includes('WebSocket closed without opened')
  );
}

async function collectText(page) {
  const bodyText = await page.locator('body').innerText();
  const attributeText = await page
    .locator('[title], [aria-label], ix-tooltip')
    .evaluateAll((elements) =>
      elements
        .map((element) => [element.getAttribute('title'), element.getAttribute('aria-label'), element.textContent].filter(Boolean).join('\n'))
        .join('\n')
    );
  return `${bodyText}\n${attributeText}`;
}

async function collectRoleSurfaceText(page) {
  return page.locator('main.app-shell').evaluate((main) => {
    const clone = main.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return '';
    clone
      .querySelectorAll('.role-nav, .role-top-nav, .demo-role-switcher')
      .forEach((element) => element.remove());
    const attributeText = Array.from(clone.querySelectorAll('[title], [aria-label], ix-tooltip'))
      .map((element) =>
        [
          element.getAttribute('title'),
          element.getAttribute('aria-label'),
          element.textContent,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');
    return `${clone.innerText}\n${attributeText}`;
  });
}

async function checkOverflow(page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const docWidth = document.documentElement.scrollWidth;
    const bodyWidth = document.body.scrollWidth;
    const offenders = Array.from(document.querySelectorAll('*'))
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
      .filter((entry) => entry.width > 0 && (entry.left < -1 || entry.right > viewport + 1))
      .slice(0, 10);
    return { viewport, docWidth, bodyWidth, offenders };
  });
}

async function checkTooltips(page) {
  const targets = page.locator('.help-tooltip-target[title]:visible, .help-icon-frame[title]:visible');
  const count = await targets.count();
  const focusableCount = await page.locator('.help-tooltip-target[title][tabindex="0"], .help-icon-frame[title][tabindex="0"]').count();
  const ixTooltipCount = await page.locator('ix-tooltip').count();
  const firstTitle = count > 0 ? await targets.first().getAttribute('title') : null;
  const emptyTitleCount = await page.locator('.help-tooltip-target[title=""], .help-icon-frame[title=""]').count();
  const verboseTitleCount = await page
    .locator('[title]')
    .evaluateAll((elements) => elements.filter((element) => String(element.getAttribute('title') ?? '').length > 140).length);
  const hoverSamples = [];

  for (let index = 0; index < Math.min(count, 3); index += 1) {
    const target = targets.nth(index);
    const title = await target.getAttribute('title');
    const box = await target.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      await target.hover({ timeout: 2500 }).catch(() => null);
      await page.waitForTimeout(120);
      hoverSamples.push({ index, title: title ?? '' });
    }
  }

  if (focusableCount > 0) {
    await page.locator('.help-tooltip-target[title][tabindex="0"], .help-icon-frame[title][tabindex="0"]').first().focus();
    await page.waitForTimeout(80);
  }

  return {
    count,
    focusableCount,
    ixTooltipCount,
    emptyTitleCount,
    verboseTitleCount,
    firstTitle,
    hoverSamples,
    ok: emptyTitleCount === 0 && verboseTitleCount === 0 && (count === 0 || hoverSamples.every((sample) => sample.title.length > 0)),
  };
}

async function checkPictogram(page, role) {
  if (!pictogramRoles.has(role)) return { required: false, visible: true, count: 0, iconName: null, box: null };
  const illustration = page.locator('.step-illustration').first();
  const count = await page.locator('.step-illustration').count();
  const box = count > 0 ? await illustration.boundingBox() : null;
  const iconName = count > 0 ? await illustration.locator('ix-icon').first().getAttribute('name') : null;
  return {
    required: true,
    count,
    iconName,
    visible: Boolean(box && box.width >= 44 && box.height >= 44 && iconName),
    box,
  };
}

async function checkFirstLayer(page, role) {
  return page.evaluate((currentRole) => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? '';
    const order = (first, second) => {
      const firstNode = document.querySelector(first);
      const secondNode = document.querySelector(second);
      if (!firstNode || !secondNode) return true;
      return Boolean(firstNode.compareDocumentPosition(secondNode) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const detailHeading = text(
      '.detail-panel h2, .director-drawer h2, .director-workbench h1, .operator-rolls-hub h2, .warehouse-command-title h2, .admin-access-surface h2',
    );
    const listHeading = text(
      '.list-panel h1, .director-table-header h2, .production-workbench-header h3, .commercial-workspace h1, main h1',
    );
    const status = text('.severity-pill, .commercial-state-badge, .production-state-badge, .finance-state-badge, .admin-state-badge');
    const directorRows = document.querySelectorAll(
      '.director-table tbody tr, .management-report-table tbody tr',
    ).length;
    const directorKpis = document.querySelectorAll('.management-report-kpi').length;
    const currentRows = document.querySelectorAll(
      '[data-commercial-order-id], .queue-row[data-object-id], .finance-queue-card[data-object-id], .production-roll-dispatch-row:not(.is-head), .operator-rolls-hub-row:not(.is-head), .plenki-data-table tbody tr:not(.plenki-data-table-empty-row)',
    ).length;
    const explicitState = text(
      '[role="alert"], .commercial-live-empty-state, .commercial-live-skeleton, .plenki-empty-state, ix-empty-state, .warehouse-inventory-empty, .production-operator-load-empty, .detail-blank-state',
    );
    const actionButtons = Array.from(document.querySelectorAll('.detail-panel .action-surface button, .director-drawer .action-surface button'))
      .filter((button) => button instanceof HTMLButtonElement && !button.disabled)
      .map((button) => button.textContent?.trim() ?? button.getAttribute('aria-label') ?? '');
    const blockers = Array.from(document.querySelectorAll('.problem-card, .drawer-problem, .operator-blocker, .warehouse-blocker, .admin-recovery-card, .commercial-inline-problem, .production-inline-problem, .finance-inline-problem'))
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean);
    const firstOperatorSurface = document.querySelector('.operator-shift-panel, .operator-terminal');
    const firstOperatorButtons = firstOperatorSurface
      ? Array.from(firstOperatorSurface.querySelectorAll('.action-surface button')).filter((button) => button instanceof HTMLButtonElement && !button.disabled)
      : [];
    const operatorFacts = firstOperatorSurface ? firstOperatorSurface.querySelectorAll('.shift-summary-strip > div, .metric-tile').length : 0;
    const brokenWords = Array.from(document.querySelectorAll('.operator-shift-panel strong, .warehouse-bigbag-evidence strong'))
      .filter((element) => {
        const textValue = element.textContent?.trim() ?? '';
        if (!textValue || textValue.includes(' ')) return false;
        const style = window.getComputedStyle(element);
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2 || 16;
        const rect = element.getBoundingClientRect();
        return rect.height > lineHeight * 2.4;
      })
      .map((element) => element.textContent?.trim() ?? '');
    const roleChecks = {
      operator: !firstOperatorSurface || (firstOperatorButtons.length <= 1 && operatorFacts <= 4 && brokenWords.length === 0),
      warehouse: order('.warehouse-actions-inline', '.warehouse-bigbag-evidence'),
      director: order('.director-table-surface', '.management-center') && (directorRows > 0 || directorKpis > 0),
      default: true,
    };

    return {
      role: currentRole,
      detailHeading,
      listHeading,
      status,
      currentRows,
      explicitState,
      actionButtons: actionButtons.slice(0, 8),
      blockers: blockers.slice(0, 4),
      firstOperatorButtons: firstOperatorButtons.length,
      operatorFacts,
      brokenWords,
      roleCheck: roleChecks[currentRole] ?? roleChecks.default,
      ok:
        Boolean(detailHeading || listHeading) &&
        Boolean(
          status ||
            actionButtons.length > 0 ||
            blockers.length > 0 ||
            currentRows > 0 ||
            explicitState ||
            (currentRole === 'director' && (directorRows > 0 || directorKpis > 0)),
        ) &&
        (roleChecks[currentRole] ?? roleChecks.default),
    };
  }, role);
}

async function checkFocusableLabels(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button, [tabindex="0"], [role="button"]'))
      .map((element) => {
        const text = element.textContent?.trim() ?? '';
        const aria = element.getAttribute('aria-label') ?? '';
        const title = element.getAttribute('title') ?? '';
        const className = element.getAttribute('class') ?? '';
        const iconOnly = text.length === 0 || (text.length <= 2 && element.querySelector('ix-icon'));
        return {
          tag: element.tagName.toLowerCase(),
          className,
          text,
          aria,
          title,
          ok: !iconOnly || Boolean(aria || title),
        };
      })
      .filter((entry) => !entry.ok)
      .slice(0, 10)
  );
}

async function checkKeyboard(page, role) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const firstFocusable = page
    .locator(
      'button:visible, input:visible, select:visible, textarea:visible, [tabindex="0"]:visible, [role="button"]:visible',
    )
    .first();
  if (await firstFocusable.count()) await firstFocusable.focus();

  const sequence = [];
  for (let index = 0; index < 48; index += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      return {
        tag: element.tagName.toLowerCase(),
        className: element.getAttribute('class') ?? '',
        text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
        aria: element.getAttribute('aria-label') ?? '',
        title: element.getAttribute('title') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
      };
    });
    if (active) sequence.push(active);
  }

  const joined = sequence
    .map(
      (entry) =>
        `${entry.className} ${entry.text} ${entry.aria} ${entry.title} ${entry.placeholder}`,
    )
    .join('\n');
  return {
    sequence: sequence.slice(0, 40),
    hasRole: /role-button|Коммерция|Оператор|Склад|Админ/.test(joined),
    hasFilter:
      /filter-chip|plenki-filter-row|operator-rolls-hub-(?:view-toggle|filters)|production-priority|finance-calendar-day|Предыдущий месяц|Требуют действия|Заблокированы|С проблемами|Завершены|director-tabs|overview-tile|Требуют решения|Все заказы|Решения|Деньги|Риски|По заказам|По очереди|Поиск|Критичные|Без назначения/.test(
        joined,
      ),
    hasList:
      role === 'director'
        ? /director-table|Рецептура|Склад|Деньги|Риски/.test(joined)
        : /queue-row|commercial-live-order-row|finance-queue-card|finance-calendar-(?:day|agenda-item)|production-roll-dispatch|production-order-disclosure|operator-rolls-hub-row|plenki-data-table|Заказ-наряд|Задача|Приемка|Финансы|Заявка|Весы/.test(
            joined,
          ),
    hasAction: /action-|compact-action-button|action-tile|Подтвердить|Сканировать|Проверить|Показать|Открыть|Отметить оплату вручную|График|История/.test(joined),
  };
}

async function clearState(page, viewport) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate((width) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelectorAll('*').forEach((element) => {
      if (element instanceof HTMLElement) {
        element.scrollLeft = 0;
        element.scrollTop = 0;
      }
    });
    if (width <= 900) {
      document.querySelector('.detail-panel')?.scrollIntoView({ block: 'start' });
    }
  }, viewport.width);
  await page.mouse.move(Math.max(1, viewport.width - 4), Math.max(1, viewport.height - 4));
  await page.waitForTimeout(120);
}

async function explicitStateCase(page, role) {
  for (const state of explicitStateSelectors) {
    const target = page.locator(state.selector).first();
    if (!(await target.isVisible().catch(() => false))) continue;
    const text = (await target.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
    if (!text) continue;
    return {
      index: 0,
      variant: state.variant,
      label: text.slice(0, 120),
      selector: state.selector,
      isState: true,
    };
  }
  return {
    index: 0,
    variant: 'missing-state',
    label: `${role}: rows and an explicit state were not found`,
    selector: null,
    isState: true,
  };
}

async function discoverCasesFromSelectors(page, role, selectors) {
  for (const selector of selectors) {
    const rows = page.locator(selector);
    const count = Math.min(await rows.count(), maxRowCasesPerRole);
    if (count === 0) continue;
    const cases = [];
    for (let index = 0; index < count; index += 1) {
      const label = (await rows.nth(index).innerText().catch(() => `${role} row ${index + 1}`))
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 120);
      cases.push({
        index,
        variant: 'row',
        label: label || `${role} row ${index + 1}`,
        selector,
        isState: false,
      });
    }
    return cases;
  }
  return [await explicitStateCase(page, role)];
}

async function nonDirectorCases(page, role) {
  return discoverCasesFromSelectors(page, role, roleRowSelectors[role] ?? []);
}

async function selectDirectorRow(rows, index) {
  if ((await rows.count()) <= index) return false;
  await rows.nth(index).evaluate((row) => row.click());
  return true;
}

async function clickRoleSection(page, section) {
  return page.locator('.role-nav button').evaluateAll((buttons, targetSection) => {
    const button = buttons.find((item) => item.querySelector('strong')?.textContent?.trim() === targetSection);
    if (!button) return false;
    button.click();
    return true;
  }, section);
}

async function directorCases(page) {
  const cases = [];
  const tabs = page.locator('.director-tabs');
  if (await tabs.count()) {
    const views = [
      { name: 'decisions', button: 'Нужно решение' },
      { name: 'orders', button: 'Все заказы' },
    ];

    for (const view of views) {
      if (cases.length >= maxRowCasesPerRole) break;
      await tabs.getByRole('button', { name: view.button, exact: true }).click();
      await page.waitForTimeout(160);
      const rows = page.locator('.director-table tbody tr');
      const count = Math.min(await rows.count(), maxRowCasesPerRole);
      for (let index = 0; index < count; index += 1) {
        await selectDirectorRow(rows, index);
        await page.waitForTimeout(160);
        const drawerHeading = page.locator('.director-drawer h2').first();
        const label = await drawerHeading
          .innerText({ timeout: 250 })
          .catch(async () => rows.nth(index).innerText({ timeout: 250 }));
        cases.push({ index, variant: view.name, label });
      }
    }

    return cases.length > 0 ? cases : [await explicitStateCase(page, 'director')];
  }

  const sections = ['Требуют решения', 'Производство', 'Финансы', 'Склад', 'Штрафы'];
  for (const section of sections) {
    if (cases.length >= maxRowCasesPerRole) break;
    if (!await clickRoleSection(page, section)) continue;
    await page.waitForTimeout(160);
    const rows = page.locator('.director-table tbody tr');
    const count = Math.min(await rows.count(), maxRowCasesPerRole);
    for (let index = 0; index < count; index += 1) {
      await selectDirectorRow(rows, index);
      await page.waitForTimeout(160);
      const drawerHeading = page.locator('.director-drawer h2').first();
      const label = await drawerHeading
        .innerText({ timeout: 250 })
        .catch(async () => rows.nth(index).innerText({ timeout: 250 }));
      cases.push({ index, variant: 'section', section, label });
    }
  }

  return cases.length > 0 ? cases : [await explicitStateCase(page, 'director')];
}

await mkdir(screenshotDir, { recursive: true });

const serverLogs = [];
const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  env: {
    ...process.env,
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
  viewports,
  roles,
  results: [],
  keyboard: [],
};

try {
  await waitForServer(server, serverLogs);
  browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(8_000);
    page.setDefaultNavigationTimeout(12_000);
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (!isIgnoredDevConsoleError(text)) consoleErrors.push(text);
    });

    for (const role of roles) {
      const url = `${baseUrl}/?role=${role}`;
      await withTimeout(page.goto(url, { waitUntil: 'networkidle' }), 12_000, `initial navigation ${role}/${viewport.name}`);
      await withTimeout(clearState(page, viewport), 8_000, `initial clearState ${role}/${viewport.name}`);

      const cases = await withTimeout(
        role === 'director' ? directorCases(page) : nonDirectorCases(page, role),
        15_000,
        `case discovery ${role}/${viewport.name}`
      );

      for (const [scenarioPosition, scenario] of cases.entries()) {
        await withTimeout(page.goto(url, { waitUntil: 'networkidle' }), 12_000, `scenario navigation ${role}/${viewport.name}/${scenario.label}`);
        await withTimeout(clearState(page, viewport), 8_000, `scenario clearState ${role}/${viewport.name}/${scenario.label}`);
        const consoleStart = consoleErrors.length;
        let scenarioTargetVisible = scenario.variant !== 'missing-state';

        if (scenarioPosition === 0) {
          const keyboard = await withTimeout(checkKeyboard(page, role), 10_000, `keyboard ${role}/${viewport.name}`);
          report.keyboard.push({
            role,
            viewport: viewport.name,
            ok: keyboard.hasRole && keyboard.hasFilter && keyboard.hasList && keyboard.hasAction,
            ...keyboard,
          });
          await withTimeout(clearState(page, viewport), 8_000, `post-keyboard clearState ${role}/${viewport.name}`);
        }

        if (scenario.isState) {
          scenarioTargetVisible =
            scenario.selector !== null &&
            (await page.locator(scenario.selector).first().isVisible().catch(() => false));
        } else if (role === 'director') {
          const tabs = page.locator('.director-tabs');
          if (scenario.variant === 'section') {
            await clickRoleSection(page, scenario.section);
          } else if (await tabs.count()) {
            await tabs
              .getByRole('button', { name: scenario.variant === 'orders' ? 'Все заказы' : 'Нужно решение', exact: true })
              .click();
          }
          await page.waitForTimeout(100);
          scenarioTargetVisible = await selectDirectorRow(
            page.locator('.director-table tbody tr'),
            scenario.index,
          );
        } else {
          const rows = page.locator(scenario.selector);
          scenarioTargetVisible = (await rows.count()) > scenario.index;
          if (scenarioTargetVisible) {
            await rows.nth(scenario.index).evaluate((row) => row.click());
          }
        }
        await page.waitForTimeout(220);

        const text = await withTimeout(
          collectText(page),
          8_000,
          `collectText ${role}/${viewport.name}/${scenario.label}`,
        );
        const roleSurfaceText = await withTimeout(
          collectRoleSurfaceText(page),
          8_000,
          `collectRoleSurfaceText ${role}/${viewport.name}/${scenario.label}`,
        );
        const globalLeaks = findLeaks(text, globalForbidden);
        const roleLeaks = findLeaks(roleSurfaceText, roleForbidden[role] ?? []);
        const leaks = [...globalLeaks, ...roleLeaks];
        const overflow = await withTimeout(checkOverflow(page), 8_000, `overflow ${role}/${viewport.name}/${scenario.label}`);
        const tooltip = await withTimeout(checkTooltips(page), 8_000, `tooltip audit ${role}/${viewport.name}/${scenario.label}`);
        const pictogram = await withTimeout(checkPictogram(page, role), 8_000, `pictogram ${role}/${viewport.name}/${scenario.label}`);
        const firstLayer = await withTimeout(checkFirstLayer(page, role), 8_000, `first layer ${role}/${viewport.name}/${scenario.label}`);
        const focusableIssues = await withTimeout(checkFocusableLabels(page), 8_000, `focusable labels ${role}/${viewport.name}/${scenario.label}`);

        await withTimeout(clearState(page, viewport), 8_000, `pre-screenshot clearState ${role}/${viewport.name}/${scenario.label}`);
        const screenshotPath = path.join(
          screenshotDir,
          `${role}-${viewport.name}-${scenario.variant}-${String(scenario.index + 1).padStart(2, '0')}-${safeName(scenario.label)}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });

        const scenarioConsoleErrors = consoleErrors.slice(consoleStart);
        const ok =
          scenarioTargetVisible &&
          leaks.length === 0 &&
          overflow.docWidth <= overflow.viewport + 1 &&
          overflow.bodyWidth <= overflow.viewport + 1 &&
          tooltip.ok &&
          pictogram.visible &&
          firstLayer.ok &&
          focusableIssues.length === 0 &&
          scenarioConsoleErrors.length === 0;

        report.results.push({
          role,
          viewport: viewport.name,
          variant: scenario.variant,
          index: scenario.index,
          label: scenario.label,
          scenarioTargetVisible,
          screenshotPath,
          leaks,
          leakContexts: [
            ...leakContexts(text, globalLeaks),
            ...leakContexts(roleSurfaceText, roleLeaks),
          ],
          overflow,
          tooltip,
          pictogram,
          firstLayer,
          focusableIssues,
          consoleErrors: scenarioConsoleErrors,
          ok,
        });
      }
    }

    await page.close();
  }

  let coverageError = null;
  try {
    assertCompleteNightlyCoverage(report);
  } catch (error) {
    coverageError = error instanceof Error ? error.message : String(error);
  }
  report.coverage = {
    expected: roles.length * viewports.length,
    scenarios: new Set(report.results.map((entry) => `${entry.role}/${entry.viewport}`)).size,
    keyboard: new Set(report.keyboard.map((entry) => `${entry.role}/${entry.viewport}`)).size,
    error: coverageError,
  };
  const failedKeyboard = report.keyboard.filter((entry) => !entry.ok);
  const failed = report.results.filter((result) => !result.ok);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (coverageError || failed.length > 0 || failedKeyboard.length > 0) {
    const scenarioSummary = failed
      .slice(0, 20)
      .map((result) =>
        `${result.role}/${result.viewport}/${result.variant}/${result.index + 1}: target=${result.scenarioTargetVisible}, leaks=${result.leaks.join(',') || 'none'}, overflow=${result.overflow.docWidth}/${result.overflow.bodyWidth}/${result.overflow.viewport}, tooltips=${result.tooltip.count}, pictogram=${result.pictogram.visible}, firstLayer=${result.firstLayer.ok}, focusIssues=${result.focusableIssues.length}, console=${result.consoleErrors.length}`
      )
      .join('\n');
    const keyboardSummary = failedKeyboard
      .map((entry) => `${entry.role}/${entry.viewport}: role=${entry.hasRole}, filter=${entry.hasFilter}, list=${entry.hasList}, action=${entry.hasAction}`)
      .join('\n');
    throw new Error(
      `Nightly show-ready audit failed.${coverageError ? `\nCoverage: ${coverageError}` : ''}\nScenarios:\n${scenarioSummary || 'none'}\nKeyboard:\n${keyboardSummary || 'none'}\nReport: ${reportPath}`,
    );
  }

  console.log(`Nightly show-ready audit passed. Scenarios: ${report.results.length}. Screenshots: ${screenshotDir}`);
} catch (error) {
  if (serverLogs.length > 0) {
    console.error(`Nightly server logs before failure:\n${serverLogs.join('').slice(-4000)}`);
  }
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
