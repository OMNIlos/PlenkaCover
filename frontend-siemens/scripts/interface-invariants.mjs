import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { installBusinessPerformanceSmokeFixture } from './business-performance-smoke-fixture.mjs';
import {
  assertDirectorControlState,
  assertSmokeHealthy,
  collectVisibleErrors,
  installPageFailureTracker,
  startOwnedVite,
} from './release-smoke-runtime.mjs';

function read(filePath) {
  return readFileSync(path.resolve(filePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const templates = read('src/domain/templates.ts');
const workObjectSurfaces = read('src/components/shell/workObjectSurfaces.tsx');
const orderSurfacePrimitives = read('src/components/shell/orderSurfacePrimitives.tsx');
const officeWorkbenches = read('src/components/workbenches/officeWorkbenches.tsx');
const commercialSectionHeader = read('src/components/workbenches/CommercialSectionHeader.tsx');
const warehouseInventory = read('src/domain/warehouseInventoryDashboard.ts');
const actionPresentation = read('src/components/shell/actionPresentation.ts');
const shellCss = read('src/styles/01-shell-navigation.css');
const listDetailCss = read('src/styles/02-list-detail.css');
const responsiveCss = read('src/styles/90-responsive-motion.css');
const commercialCss = read('src/styles/31-commercial-golden-slice.css');
const commercialLiveCss = [
  read('src/styles/91-commercial-live.css'),
  read('src/styles/94-commercial-mobile.css'),
].join('\n');
const productionFixture = read('src/domain/fixtures/production.ts');

assert(
  templates.includes('export function resolveOrderTemplateForObject'),
  'template resolver is missing',
);
assert(
  !workObjectSurfaces.includes('?? counterpartyTemplatesList[0]'),
  'OrderTemplateWorkbench must not silently fallback to the first recent template',
);
assert(
  /if \(object\.id === 'ЗН-2606-020'\)[\s\S]+templateThickness[\s\S]+return \[\]/.test(templates),
  'ЗН-2606-020 must not create template differences when the resolved template thickness matches the order',
);
assert(
  /id: 'ЗН-2606-020'[\s\S]+label: 'Шаблон', value: 'УралПак · рукав 60 мкм'[\s\S]+label: 'Толщина', value: '60 мкм'/.test(
    productionFixture,
  ),
  'ЗН-2606-020 fixture must keep the 60 мкм order facts that seed the invariant',
);
assert(
  !productionFixture.includes('Не выбран станок') &&
    !productionFixture.includes('Выбрать станок') &&
    productionFixture.includes("label: 'Рабочее место', value: 'После назначения оператора'"),
  'production fixture must model workplace as operator-profile data, not a manual machine blocker',
);
assert(
  !officeWorkbenches.includes('qrPanelOpen') &&
    !officeWorkbenches.includes('aria-label="История рулона и QR"') &&
    !officeWorkbenches.includes('Сохранить строку'),
  'commercial selected order must not render the old standalone QR panel or template save button',
);
assert(
  !commercialSectionHeader.includes('commercial-section-help-button') &&
    !commercialSectionHeader.includes('role="tooltip"'),
  'commercial section headers must not render visible business tips',
);
assert(
  commercialSectionHeader.includes('owner?: string') &&
    commercialSectionHeader.includes('owner && <span className="commercial-owner-chip"'),
  'commercial section owner chip must be optional instead of always rendering role labels',
);
assert(
  !officeWorkbenches.includes('Главный блок коммерции') &&
    !officeWorkbenches.includes('Ожидает: Коммерция') &&
    !officeWorkbenches.includes('owner="Коммерция"') &&
    !officeWorkbenches.includes('owner="Коммерция + Склад"'),
  'commercial workbench must not render current role as decorative owner/chip copy',
);
assert(
  orderSurfacePrimitives.includes('isSelfRoleLabel') &&
    orderSurfacePrimitives.includes('showOwner && <span>{identity.owner}</span>') &&
    orderSurfacePrimitives.includes('ownerLabel && showOwner'),
  'order surface primitives must suppress owner labels when they repeat the current role',
);
assert(
  actionPresentation.includes('export function actionIntent') &&
    actionPresentation.includes('export function actionVisualLevel') &&
    actionPresentation.includes("return 'navigation'"),
  'action presentation must expose an intent-aware quiet navigation style',
);
assert(
  commercialCss.includes('.compact-action-button.action-navigation') &&
    commercialCss.includes('.action-tile.action-navigation'),
  'commercial action CSS must keep navigation actions visually quiet',
);
assert(
  listDetailCss.includes('.queue-filter-group') &&
    listDetailCss.includes('.queue-control-label') &&
    listDetailCss.includes('.date-scope-trigger-copy'),
  'queue controls must separate status filters from date scope instead of rendering identical pills',
);

assert(
  !/source:\s*'WarehouseCoverProposal'/.test(warehouseInventory),
  'warehouse inventory must not expose WarehouseCoverProposal as visible source',
);
assert(
  !/source:\s*event\.sourceSnapshot/.test(warehouseInventory),
  'warehouse inventory audit rows must pass sourceSnapshot through a business label',
);
assert(
  !/status:\s*event\.actionLabel\.startsWith\('problem:'\) \? 'Проблема' : 'Audit'/.test(
    warehouseInventory,
  ),
  'warehouse inventory must not show Audit as a worker-facing status',
);
assert(
  warehouseInventory.includes('visibleAuditActionLabel(event.actionLabel)'),
  'warehouse inventory audit rows must use visible audit action labels',
);

assert(
  /\.app-shell\[data-active-role="warehouse"\]\[data-direct-detail="true"\]\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(
    shellCss,
  ),
  'warehouse direct-detail must occupy a single full-width app-shell column',
);
assert(
  /@media \(max-width:\s*900px\)[\s\S]+\.app-shell\s*\{[\s\S]+grid-template-columns:\s*1fr/.test(
    responsiveCss,
  ),
  'mobile app-shell must explicitly drop desktop grid columns',
);
assert(
  /@media \(max-width:\s*900px\)[\s\S]+\.commercial-live-list-panel,[\s\S]+\.commercial-live-detail-panel,[\s\S]+\.commercial-live-raw-shell\s*\{[\s\S]+grid-column:\s*1/.test(
    commercialLiveCss,
  ) &&
    /@media \(max-width:\s*900px\)[\s\S]+\.commercial-live-list-panel,[\s\S]+\.commercial-live-detail-panel\s*\{[\s\S]+overflow:\s*visible/.test(
      commercialLiveCss,
    ),
  'commercial live mobile layout must collapse to one column without hidden overflow',
);

console.log('Static interface invariants passed.');
if (process.env.INTERFACE_INVARIANTS_CONTRACT_ONLY === '1') {
  console.log('Interface invariant contract checks passed.');
  process.exit(0);
}

let baseUrl = '';
const screenshotDir = path.resolve('qa-screenshots/action-semantics-copy-dedupe-2026-06-22');
const reportPath = path.join(screenshotDir, 'action-semantics-copy-dedupe-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');
const roles = ['commercial', 'production', 'finance', 'director', 'operator', 'warehouse', 'admin'];
const nonAdminRoles = roles.filter((role) => role !== 'admin');
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
  'evidence',
  'Supervisor override',
  'Director override',
  'prototype/mock',
  'routine scan',
  'scan-first workflow',
  'reason + audit',
  'учетный факт',
  'остается за бухгалтерией',
  'индикатор оплаты',
  'Владелец факта',
  'Клиентский gate',
];

const report = {
  baseUrl,
  screenshotDir,
  checks: [],
};

async function gotoRole(page, role, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(350);
}

async function assertDirectorControlLoaded(page, context) {
  await page
    .waitForFunction(
      () => {
        const content = document.querySelector('.commercial-performance-content');
        const alert = document.querySelector('.commercial-performance-workspace [role="alert"]');
        return Boolean(content || alert);
      },
      undefined,
      { timeout: 5000 },
    )
    .catch(() => undefined);
  const state = await page.evaluate(() => {
    const workspace = document.querySelector('.commercial-performance-workspace');
    const content = workspace?.querySelector('.commercial-performance-content');
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    return {
      workspaceVisible: isVisible(workspace),
      contentVisible: isVisible(content),
      metricLabels: Array.from(
        workspace?.querySelectorAll('.commercial-performance-metrics article span') ?? [],
        (element) => element.textContent?.trim() ?? '',
      ).filter(Boolean),
      alertTexts: Array.from(workspace?.querySelectorAll('[role="alert"]') ?? [])
        .filter(isVisible)
        .map((element) => element.textContent?.trim() ?? '')
        .filter(Boolean),
    };
  });
  assertDirectorControlState(state, context);
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

async function collectVisibleText(page) {
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

function assertNoTerms(text, terms, context) {
  const normalized = text.toLowerCase();
  const hits = terms.filter((term) => normalized.includes(term.toLowerCase()));
  assert(hits.length === 0, `${context}: forbidden raw terms visible: ${hits.join(', ')}`);
}

async function screenshot(page, name, fullPage = false) {
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage });
}

async function assertNoHorizontalOverflow(page, context) {
  const metrics = await page.evaluate(() => {
    function hasHorizontalScrollContainer(element) {
      let current = element.parentElement;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        if (
          ['auto', 'scroll'].includes(style.overflowX) &&
          current.scrollWidth > current.clientWidth + 1
        )
          return true;
        current = current.parentElement;
      }
      return false;
    }
    const offenders = Array.from(document.body.querySelectorAll('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        )
          return null;
        if (hasHorizontalScrollContainer(element)) return null;
        if (rect.left < -1 || rect.right > window.innerWidth + 1) {
          return {
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
          };
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, 8);
    return {
      docWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewport: window.innerWidth,
      offenders,
    };
  });
  assert(
    metrics.docWidth <= metrics.viewport + 1 &&
      metrics.bodyWidth <= metrics.viewport + 1 &&
      metrics.offenders.length === 0,
    `${context}: horizontal overflow detected ${JSON.stringify(metrics)}`,
  );
  return metrics;
}

async function firstViewportElement(page, selector, context, maxTop = 760) {
  await page
    .waitForFunction(
      ({ selector: targetSelector, maxTop: targetMaxTop }) =>
        Array.from(document.querySelectorAll(targetSelector)).some((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= 0 &&
            rect.top < targetMaxTop &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          );
        }),
      { selector, maxTop },
      { timeout: 2000 },
    )
    .catch(() => undefined);
  const candidates = await page.locator(selector).evaluateAll((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          text: (element.textContent ?? '').trim(),
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none',
        };
      })
      .filter((item) => item.visible),
  );
  const visible = candidates.find((item) => item.top >= 0 && item.top < maxTop);
  assert(
    Boolean(visible),
    `${context}: primary/current action is not visible above fold via ${selector}`,
  );
  return visible;
}

async function disabledOperationalButtons(page, context) {
  const offenders = await page
    .locator('button:disabled, button[aria-disabled="true"]')
    .evaluateAll((buttons) => {
      const reasonPattern =
        /(нельзя|недоступ|доступно после|заполн|сначала|нет |ожида|треб|выберите|закрыт|введите|ручн|восстанов|первое|последнее|нет дел)/i;
      const whitelistSelector = [
        '.finance-calendar-month-controls',
        '.finance-registry-pagination',
        '.finance-record-stepper',
        '.section-nav',
        '.role-top-nav',
        '.queue-archive-date-controls',
        '[aria-label*="Пагинация"]',
        '[aria-label*="Перейти к соседнему"]',
      ].join(',');

      return buttons
        .map((button) => {
          if (!(button instanceof HTMLButtonElement)) return null;
          if (button.closest(whitelistSelector)) return null;
          const rect = button.getBoundingClientRect();
          const style = window.getComputedStyle(button);
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            style.display === 'none' ||
            style.visibility === 'hidden'
          )
            return null;
          const label = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
          const title = button.getAttribute('title') ?? '';
          const aria = button.getAttribute('aria-label') ?? '';
          const container = button.closest(
            '.template-editor-actions, .disabled-actions, .finance-disabled-actions, .action-surface, .finance-command-stack, .penalty-form',
          );
          const contextText = (container?.textContent ?? '').replace(/\s+/g, ' ').trim();
          const combined = `${label} ${title} ${aria} ${contextText}`;
          if (reasonPattern.test(combined) && combined.length > label.length + 12) return null;
          return { label, title, aria, contextText: contextText.slice(0, 180) };
        })
        .filter(Boolean);
    });
  assert(
    offenders.length === 0,
    `${context}: disabled operational buttons without reason/recovery: ${JSON.stringify(offenders)}`,
  );
}

async function countCompetingPrimary(page, context, maxCount = 2) {
  const count = await page.locator('button').evaluateAll(
    (buttons) =>
      buttons.filter((button) => {
        if (!(button instanceof HTMLButtonElement)) return false;
        if (button.disabled) return false;
        if (
          button.closest(
            '.finance-command-counters, .finance-command-mode-row, .finance-registry-filter-row, .finance-registry-pagination, .finance-calendar-month-controls, .finance-calendar-grid, .finance-calendar-agenda, .warehouse-inventory-tabs, .section-nav, .role-top-nav',
          )
        )
          return false;
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.top < 0 ||
          rect.top > 760 ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        )
          return false;
        return (
          button.matches(
            '.action-recommended, .finance-command-primary, .penalty-assign-command-button, .create-intake-button',
          ) || button.classList.contains('action-recommended')
        );
      }).length,
  );
  assert(
    count <= maxCount,
    `${context}: too many competing primary actions in first viewport (${count} > ${maxCount})`,
  );
  return count;
}

async function assertNavigationButtonsAreQuiet(page, context) {
  const offenders = await page.locator('button').evaluateAll((buttons) => {
    const navigationTextPattern = /(открыть|показать|перейти|история|график|статус|к оплате)/i;
    const whitelistSelector = [
      '.section-nav',
      '.role-top-nav',
      '.finance-calendar-month-controls',
      '.finance-registry-pagination',
      '.finance-record-stepper',
      '.queue-archive-date-controls',
      '.drawer-close-button',
      '[aria-label*="Пагинация"]',
      '[aria-label*="Перейти к соседнему"]',
    ].join(',');

    return buttons
      .map((button) => {
        if (!(button instanceof HTMLButtonElement)) return null;
        if (button.disabled || button.closest(whitelistSelector)) return null;
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.top < 0 ||
          rect.top > 820 ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        )
          return null;
        const label =
          `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`
            .replace(/\s+/g, ' ')
            .trim();
        if (!navigationTextPattern.test(label)) return null;
        const isPrimary =
          button.classList.contains('action-recommended') ||
          button.classList.contains('finance-command-primary') ||
          button.classList.contains('office-command-primary') ||
          button.classList.contains('create-intake-button') ||
          button.classList.contains('penalty-assign-command-button');
        const isQuiet =
          button.classList.contains('action-navigation') ||
          button.classList.contains('action-secondary');
        if (!isPrimary || isQuiet) return null;
        return { label, className: String(button.className), top: Math.round(rect.top) };
      })
      .filter(Boolean);
  });
  assert(
    offenders.length === 0,
    `${context}: navigation/inspect buttons rendered as primary actions: ${JSON.stringify(offenders)}`,
  );
}

async function assertQueueControlsAreLegible(page, context) {
  const state = await page
    .locator('.queue-toolbar')
    .first()
    .evaluate((toolbar) => {
      const filterGroup = toolbar.querySelector('.queue-filter-group');
      const filterRow = toolbar.querySelector('.filter-row');
      const dateTrigger = toolbar.querySelector('.date-scope-trigger');
      const filterButtons = Array.from(toolbar.querySelectorAll('.filter-chip'));
      const activeFilter = toolbar.querySelector('.filter-chip.is-active');
      const activeFilterStyle = activeFilter ? window.getComputedStyle(activeFilter) : null;
      return {
        hasFilterGroup: Boolean(filterGroup),
        groupLabel: filterGroup?.querySelector('.queue-control-label')?.textContent?.trim() ?? '',
        filterRole: filterRow?.getAttribute('role') ?? '',
        filterButtonRoles: filterButtons.map((button) => button.getAttribute('role')),
        filterButtonCounts: filterButtons.map(
          (button) => button.querySelector('small')?.textContent?.trim() ?? '',
        ),
        dateIsFilterChip: Boolean(dateTrigger?.classList.contains('filter-chip')),
        dateLabel:
          dateTrigger?.querySelector('.date-scope-trigger-copy small')?.textContent?.trim() ?? '',
        dateValue:
          dateTrigger?.querySelector('.date-scope-trigger-copy strong')?.textContent?.trim() ?? '',
        activeFilterShadow: activeFilterStyle?.boxShadow ?? '',
      };
    })
    .catch(() => null);
  assert(Boolean(state), `${context}: queue toolbar is missing`);
  assert(
    state.hasFilterGroup && state.groupLabel !== 'Строки',
    `${context}: queue status filters must keep aria context without visible generic label (${JSON.stringify(state)})`,
  );
  assert(
    state.filterRole === 'radiogroup',
    `${context}: queue status filters must be a radiogroup (${JSON.stringify(state)})`,
  );
  assert(
    state.filterButtonRoles.every((role) => role === 'radio'),
    `${context}: queue filter buttons must be radio controls (${JSON.stringify(state)})`,
  );
  assert(
    state.filterButtonCounts.every((count) => /^\d+$/.test(count)),
    `${context}: queue filter buttons must show scoped counts (${JSON.stringify(state)})`,
  );
  assert(
    !state.dateIsFilterChip && ['Дата', 'Период'].includes(state.dateLabel) && state.dateValue,
    `${context}: date filter must be a separate labeled dropdown (${JSON.stringify(state)})`,
  );
  assert(
    !state.activeFilterShadow.includes('-2px 0'),
    `${context}: active queue filter must not look like primary/navigation rail (${JSON.stringify(state)})`,
  );
}

async function assertCommercialRouteIsDeduped(page, context) {
  const route = await page
    .locator('.commercial-status-rail, .order-route-strip')
    .first()
    .evaluate((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
    .catch(() => '');
  const forbidden = ['индикатор оплаты', 'предложение склада', 'из позиций и склада'];
  const hits = forbidden.filter((term) => route.includes(term));
  assert(
    hits.length === 0,
    `${context}: commercial route repeats facts owned by lower blocks: ${hits.join(', ')} in "${route}"`,
  );
}

async function checkMobileShell(page, role) {
  await gotoRole(page, role, { width: 390, height: 844 });
  if (role === 'finance') {
    const financeQueueItem = page.locator('.finance-queue-card-button').first();
    await financeQueueItem.waitFor({ state: 'visible', timeout: 5000 });
    await financeQueueItem.click();
    await page.waitForTimeout(250);
    await firstViewportElement(
      page,
      '.finance-mobile-primary-action button.finance-command-primary, .finance-primary-action-panel button.finance-command-primary',
      'finance mobile primary action',
      724,
    );
  }
  if (role === 'admin') {
    await firstViewportElement(
      page,
      '.admin-primary-safe-action button:not(:disabled), .admin-primary-safe-action button',
      'admin mobile primary action',
      700,
    );
  }
  if (role === 'commercial') {
    assert(
      (await page.locator('.list-panel .queue-row').count()) > 0,
      'commercial mobile: work queue must be visible on role open',
    );
    assert(
      (await page.locator('.queue-row.is-selected').count()) === 0,
      'commercial mobile: role open must not preselect a row',
    );
    assert(
      (await page.locator('.detail-view').count()) === 0,
      'commercial mobile: detail must stay empty until row selection',
    );
    const queueText = await page
      .locator('.list-panel')
      .first()
      .evaluate((element) => element.textContent ?? '');
    assert(
      !queueText.includes('уйдет в производство'),
      'commercial mobile: incoming cards must show order composition, not the already accepted warehouse decision',
    );
    await page
      .locator('.queue-row')
      .filter({ hasText: '5 рул. · Рукав' })
      .first()
      .locator('.queue-row-main')
      .click();
    await page.waitForTimeout(250);
    const commercialMobile = await page.evaluate(() => {
      const pendingCoverVisible = Array.from(
        document.querySelectorAll('.commercial-cover-panel.is-pending:not(.is-resolution-open)'),
      ).some((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
      const secondary = document.querySelector(
        '.commercial-secondary-actions, .order-secondary-actions',
      );
      const route = document.querySelector(
        '.commercial-status-rail, .order-route-strip, .commercial-main-grid',
      );
      const secondaryRect = secondary?.getBoundingClientRect();
      const routeRect = route?.getBoundingClientRect();
      const secondaryButtonCount = document.querySelectorAll(
        '.commercial-secondary-actions button:not(:disabled), .order-secondary-actions button:not(:disabled)',
      ).length;
      const bodyText = document.body.textContent ?? '';
      const enabledButtonLabels = Array.from(
        document.querySelectorAll('button:not(:disabled)'),
        (button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      );
      const transitionText =
        document.querySelector(
          '.commercial-secondary-actions, .order-secondary-actions, .commercial-domain-action-bar',
        )?.textContent ?? '';
      return {
        pendingCoverVisible,
        hasCoverPrimary: enabledButtonLabels.includes('Показать недостачу для выпуска'),
        hasOldReserveDecision: bodyText.includes('Выбрать решение по резерву'),
        transitionDuplicatesCoverDecision:
          transitionText.includes('Решить складское покрытие') ||
          transitionText.includes('Выбрать решение по резерву'),
        secondaryButtonCount,
        secondaryTop: secondaryRect ? Math.round(secondaryRect.top) : null,
        routeTop: routeRect ? Math.round(routeRect.top) : null,
      };
    });
    assert(
      !commercialMobile.pendingCoverVisible,
      'commercial mobile: pending warehouse cover panel must stay deferred until the resolution action is opened',
    );
    assert(
      commercialMobile.hasCoverPrimary,
      'commercial mobile: cover block must expose the concrete missing-roll primary action',
    );
    assert(
      !commercialMobile.hasOldReserveDecision,
      'commercial mobile: old reserve-decision label must not be visible',
    );
    assert(
      !commercialMobile.transitionDuplicatesCoverDecision,
      'commercial mobile: cover decision must not be duplicated in available transitions',
    );
    assert(
      commercialMobile.secondaryButtonCount === 0 ||
        (commercialMobile.secondaryTop !== null &&
          commercialMobile.routeTop !== null &&
          commercialMobile.secondaryTop < commercialMobile.routeTop),
      `commercial mobile: secondary actions must sit before route facts (${JSON.stringify(commercialMobile)})`,
    );
  }
  if (role === 'production') {
    await page.goto(
      `${baseUrl}/?role=production&section=${encodeURIComponent('Операторы / загрузка')}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(350);
    const assignmentList = await page
      .locator('.production-operator-load-table')
      .first()
      .evaluate((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const cards = Array.from(
          element.querySelectorAll('.production-operator-load-row:not(.is-head)'),
        ).map((card) => {
          const cardRect = card.getBoundingClientRect();
          return {
            left: cardRect.left,
            right: cardRect.right,
            width: cardRect.width,
          };
        });
        return {
          display: style.display,
          overflowX: style.overflowX,
          width: rect.width,
          cards,
        };
      });
    assert(
      assignmentList.display !== 'flex' && !['auto', 'scroll'].includes(assignmentList.overflowX),
      `production mobile: operator assignment must be a visible vertical list, got display=${assignmentList.display} overflowX=${assignmentList.overflowX}`,
    );
    const clippedCards = assignmentList.cards.filter(
      (card) => card.left < 0 || card.right > 390 || card.width > assignmentList.width + 1,
    );
    assert(
      clippedCards.length === 0,
      `production mobile: operator cards are clipped: ${JSON.stringify(clippedCards)}`,
    );
  }
  const metrics = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    const style = shell ? window.getComputedStyle(shell) : null;
    return {
      docWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewport: window.innerWidth,
      shellColumns: style?.gridTemplateColumns ?? '',
      shellDisplay: style?.display ?? '',
    };
  });
  assert(
    metrics.docWidth <= metrics.viewport,
    `${role} mobile: document is wider than viewport (${metrics.docWidth} > ${metrics.viewport})`,
  );
  assert(
    !/minmax\(300px|minmax\(460px|188px/.test(metrics.shellColumns),
    `${role} mobile: desktop shell columns are still active (${metrics.shellColumns})`,
  );
  await assertNoHorizontalOverflow(page, `${role} mobile`);
  await screenshot(page, `mobile-${role}-390-first`);
  return metrics;
}

async function checkRoleRawText(page, role) {
  await gotoRole(page, role);
  assertNoTerms(await collectVisibleText(page), rawForbidden, `${role} default raw-label contract`);
}

async function checkPrimaryPlacementAtViewport(page, viewportName, viewport) {
  const maxTop = Math.max(520, viewport.height - 120);

  await gotoRole(page, 'finance', viewport);
  await assertQueueControlsAreLegible(page, `finance queue controls ${viewportName}`);
  const financeQueueItem = page.locator('.finance-queue-card-button').first();
  await financeQueueItem.waitFor({ state: 'visible', timeout: 5000 });
  await financeQueueItem.click();
  await page.waitForTimeout(250);
  await firstViewportElement(
    page,
    '.finance-primary-action-panel button.finance-command-primary',
    `finance selected ${viewportName}`,
    maxTop,
  );
  await countCompetingPrimary(page, `finance selected ${viewportName}`, 2);
  await assertNavigationButtonsAreQuiet(page, `finance selected ${viewportName}`);
  await assertNoHorizontalOverflow(page, `finance selected ${viewportName}`);
  await screenshot(page, `finance-selected-${viewportName}-first`);
  if (viewportName === 'desktop1440')
    await screenshot(page, 'finance-selected-desktop1440-full', true);

  await gotoRole(page, 'director', viewport);
  await assertDirectorControlLoaded(page, `director control ${viewportName}`);
  await firstViewportElement(
    page,
    '.commercial-performance-content',
    `director control ${viewportName}`,
    maxTop,
  );
  await countCompetingPrimary(page, `director control ${viewportName}`, 3);
  await assertNavigationButtonsAreQuiet(page, `director control ${viewportName}`);
  await assertNoHorizontalOverflow(page, `director control ${viewportName}`);
  await screenshot(page, `director-control-${viewportName}-first`);

  await gotoRole(page, 'warehouse', viewport);
  await clickSection(page, 'Все рулоны');
  await page.locator('.warehouse-stock-workspace').waitFor({ state: 'visible', timeout: 5000 });
  const legacyStockSurfaces = await page
    .locator('.warehouse-cover-tasks-panel, .warehouse-finished-stock')
    .count();
  assert(
    legacyStockSurfaces === 0,
    `warehouse reserve ${viewportName}: legacy stock surfaces are visible`,
  );
  const legacyInventoryRows = await page
    .locator('.warehouse-inventory-data-table tbody tr')
    .count();
  assert(
    legacyInventoryRows === 0,
    `warehouse reserve ${viewportName}: legacy raw inventory rows are visible`,
  );
  await firstViewportElement(
    page,
    '.warehouse-stock-workspace',
    `warehouse reserve ${viewportName}`,
    maxTop,
  );
  await assertNavigationButtonsAreQuiet(page, `warehouse reserve ${viewportName}`);
  await assertNoHorizontalOverflow(page, `warehouse reserve ${viewportName}`);
  await screenshot(page, `warehouse-reserve-${viewportName}-first`);

  await clickSection(page, 'Сырье');
  const warehouseInventoryRow = page
    .locator('.warehouse-inventory-data-table tbody tr.is-interactive')
    .first();
  await warehouseInventoryRow.waitFor({ state: 'visible', timeout: 5000 });
  await warehouseInventoryRow.click();
  await page.waitForTimeout(250);
  await firstViewportElement(
    page,
    '.warehouse-inventory-detail-head',
    `warehouse inventory selected row ${viewportName}`,
    maxTop,
  );
  await assertNavigationButtonsAreQuiet(page, `warehouse inventory ${viewportName}`);
  await assertNoHorizontalOverflow(page, `warehouse inventory ${viewportName}`);
  await screenshot(page, `warehouse-inventory-${viewportName}-first`);
  if (viewportName === 'desktop1440')
    await screenshot(page, 'warehouse-inventory-desktop1440-full', true);

  await gotoRole(page, 'commercial', viewport);
  await clickSection(page, 'Черновики');
  await assertQueueControlsAreLegible(page, `commercial queue controls ${viewportName}`);
  await page.locator('.queue-row-main').first().click();
  await page.waitForTimeout(250);
  await firstViewportElement(
    page,
    '.commercial-primary-action button:not(:disabled), .commercial-next-action button:not(:disabled), .order-primary-action button:not(:disabled), .action-surface button.action-recommended:not(:disabled)',
    `commercial drafts ${viewportName}`,
    maxTop,
  );
  await countCompetingPrimary(page, `commercial drafts ${viewportName}`, 3);
  await assertNavigationButtonsAreQuiet(page, `commercial drafts ${viewportName}`);
  await assertCommercialRouteIsDeduped(page, `commercial drafts ${viewportName}`);
  await assertNoHorizontalOverflow(page, `commercial drafts ${viewportName}`);
  await screenshot(page, `commercial-drafts-${viewportName}-first`);

  await gotoRole(page, 'production', viewport);
  await clickSection(page, 'Штрафы');
  await disabledOperationalButtons(page, `production penalties ${viewportName}`);
  await assertNoHorizontalOverflow(page, `production penalties ${viewportName}`);
  await screenshot(page, `production-penalties-${viewportName}-first`);

  await gotoRole(page, 'admin', viewport);
  await firstViewportElement(
    page,
    '.admin-system-focus, .admin-access-focus, .admin-primary-safe-action, .queue-row, .queue-row-main',
    `admin default first object ${viewportName}`,
    maxTop,
  );
  await countCompetingPrimary(page, `admin default ${viewportName}`, 3);
  await assertNavigationButtonsAreQuiet(page, `admin default ${viewportName}`);
  await assertNoHorizontalOverflow(page, `admin default ${viewportName}`);
  await screenshot(page, `admin-default-${viewportName}-first`);
}

async function checkPrimaryPlacement(page) {
  const viewports = [
    ['desktop1440', { width: 1440, height: 900 }],
    ['desktop1366', { width: 1366, height: 768 }],
  ];
  for (const [viewportName, viewport] of viewports) {
    await checkPrimaryPlacementAtViewport(page, viewportName, viewport);
  }
}

async function workstationContainerMetrics(page, containerSelector, actionSelector) {
  return page.locator(containerSelector).evaluate((container, targetActionSelector) => {
    const containerRect = container.getBoundingClientRect();
    const actions = targetActionSelector
      ? Array.from(container.querySelectorAll(targetActionSelector)).map((action) => {
          const rect = action.getBoundingClientRect();
          const style = window.getComputedStyle(action);
          return {
            label: (action.textContent ?? '').replace(/\s+/g, ' ').trim(),
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden',
            contained: rect.left >= containerRect.left - 1 && rect.right <= containerRect.right + 1,
          };
        })
      : [];
    return {
      clientWidth: container.clientWidth,
      scrollWidth: container.scrollWidth,
      actions,
    };
  }, actionSelector);
}

function assertWorkstationContainerFits(metrics, context, requireActions = false) {
  assert(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${context}: internal horizontal scroll remains ${JSON.stringify(metrics)}`,
  );
  if (requireActions) {
    assert(metrics.actions.length > 0, `${context}: no visible actions found`);
    assert(
      metrics.actions.every((action) => action.visible && action.contained),
      `${context}: action is hidden or clipped ${JSON.stringify(metrics)}`,
    );
  }
}

async function assertStackedWorkstation(page, selector, context) {
  const columns = await page.locator(selector).evaluate((layout) =>
    Array.from(layout.children).map((column) => {
      const rect = column.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
      };
    }),
  );
  assert(
    columns.length >= 2 &&
      columns[0].width > 0 &&
      columns[1].width > 0 &&
      Math.abs(columns[1].left - columns[0].left) <= 1 &&
      columns[1].top >= columns[0].bottom,
    `${context}: master/detail is not safely stacked at 1024px ${JSON.stringify(columns)}`,
  );
  return columns;
}

async function visibleWorkstationHeaders(page, tableSelector) {
  return page.locator(`${tableSelector} thead th`).evaluateAll((headers) =>
    headers.map((header) => {
      const rect = header.getBoundingClientRect();
      const style = window.getComputedStyle(header);
      const sortControl = header.querySelector('button');
      const sortRect = sortControl?.getBoundingClientRect();
      const sortStyle = sortControl ? window.getComputedStyle(sortControl) : null;
      return {
        label: (header.textContent ?? '').replace(/\s+/g, ' ').trim(),
        sortable: Boolean(sortControl),
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden',
        sortControlVisible:
          !sortControl ||
          (Boolean(sortRect?.width) &&
            Boolean(sortRect?.height) &&
            sortStyle?.display !== 'none' &&
            sortStyle?.visibility !== 'hidden'),
        sortControlContained:
          !sortControl ||
          (Boolean(sortRect) && sortRect.left >= rect.left - 1 && sortRect.right <= rect.right + 1),
      };
    }),
  );
}

async function workstationRollCopyAlignment(page) {
  return page
    .locator(
      '.warehouse-scan-station-detail .warehouse-roll-row:not(.is-head) > span:not(.warehouse-row-actions)',
    )
    .evaluateAll((cells) =>
      cells
        .map((cell) => {
          const primary = cell.querySelector('strong');
          const secondary = cell.querySelector('small');
          if (!primary || !secondary) return null;
          const primaryRect = primary.getBoundingClientRect();
          const secondaryRect = secondary.getBoundingClientRect();
          return {
            label: cell.getAttribute('data-label') ?? '',
            primaryLeft: primaryRect.left,
            secondaryLeft: secondaryRect.left,
          };
        })
        .filter(Boolean),
    );
}

async function workstationEmptyStateMetrics(page, tableSelector) {
  return page.locator(`${tableSelector} .plenki-data-table-empty-row td`).evaluate((cell) => {
    const cellRect = cell.getBoundingClientRect();
    const tableRect = cell.closest('table')?.getBoundingClientRect();
    const child = cell.firstElementChild;
    const childRect = child?.getBoundingClientRect();
    return {
      cellDisplay: window.getComputedStyle(cell).display,
      pseudoDisplay: window.getComputedStyle(cell, '::before').display,
      colSpan: cell.colSpan,
      cellWidth: cellRect.width,
      tableWidth: tableRect?.width ?? null,
      childLeftOffset: childRect ? childRect.left - cellRect.left : null,
      childRightOffset: childRect ? cellRect.right - childRect.right : null,
    };
  });
}

function assertWorkstationEmptyState(metrics, context, mode) {
  if (mode === 'cards') {
    assert(
      metrics.cellDisplay === 'block',
      `${context}: card-layout empty cell is not a full-width block ${JSON.stringify(metrics)}`,
    );
  } else {
    assert(
      metrics.cellDisplay === 'table-cell' &&
        metrics.colSpan > 1 &&
        metrics.tableWidth !== null &&
        Math.abs(metrics.cellWidth - metrics.tableWidth) <= 1,
      `${context}: table-layout empty cell does not span the table ${JSON.stringify(metrics)}`,
    );
  }
  assert(metrics.pseudoDisplay === 'none', `${context}: synthetic empty label remains visible`);
  assert(
    metrics.childLeftOffset !== null && Math.abs(metrics.childLeftOffset) <= 1,
    `${context}: empty content is shifted ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.childRightOffset !== null && Math.abs(metrics.childRightOffset) <= 1,
    `${context}: empty content is narrowed ${JSON.stringify(metrics)}`,
  );
}

async function checkWarehouseWorkstationInternalFit(page) {
  const viewport = { width: 1024, height: 768 };
  await page.setViewportSize(viewport);
  await page.goto(
    `${baseUrl}/?role=warehouse&section=${encodeURIComponent('Приемка')}&object=WH-2606-044`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('.warehouse-roll-table').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(250);
  const intakeColumns = await assertStackedWorkstation(
    page,
    '.warehouse-scan-station-layout',
    'warehouse intake workstation',
  );
  const queue = await workstationContainerMetrics(page, '.warehouse-scan-queue-scroll', '');
  const intake = await workstationContainerMetrics(page, '.warehouse-roll-table', 'button');
  const queueHeaders = await visibleWorkstationHeaders(page, '.warehouse-scan-station-data-table');
  const rollCopyAlignment = await workstationRollCopyAlignment(page);
  assertWorkstationContainerFits(queue, 'warehouse intake queue');
  assertWorkstationContainerFits(intake, 'warehouse intake roll table', true);
  const truthfulQueueHeaders = queueHeaders.filter((header) => header.label);
  assert(
    truthfulQueueHeaders.length > 0 &&
      truthfulQueueHeaders.every(
        (header) => header.visible && header.sortControlVisible && header.sortControlContained,
      ),
    `warehouse intake queue: truthful headers are hidden or clipped ${JSON.stringify(queueHeaders)}`,
  );
  assert(rollCopyAlignment.length > 0, 'warehouse intake roll table: no roll copy found');
  assert(
    rollCopyAlignment.every((cell) => Math.abs(cell.primaryLeft - cell.secondaryLeft) <= 1),
    `warehouse intake roll table: primary/secondary copy is misaligned ${JSON.stringify(rollCopyAlignment)}`,
  );
  await assertNoHorizontalOverflow(page, 'warehouse intake workstation');
  await screenshot(page, 'warehouse-intake-workstation1024-first');

  await page
    .locator('.warehouse-scan-station-table input[placeholder="Поиск по операции, QR, статусу"]')
    .fill('__no_warehouse_operation__');
  const queueEmpty = await workstationEmptyStateMetrics(page, '.warehouse-scan-station-data-table');
  assertWorkstationEmptyState(queueEmpty, 'warehouse intake queue', 'table');

  await page.goto(
    `${baseUrl}/?role=warehouse&section=${encodeURIComponent('Сырье')}&object=WH-INV-RAW`,
    { waitUntil: 'domcontentloaded' },
  );
  await page
    .locator('.warehouse-inventory-data-table')
    .waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(250);
  const inventoryColumns = await assertStackedWorkstation(
    page,
    '.warehouse-inventory-layout',
    'warehouse inventory workstation',
  );
  const inventory = await workstationContainerMetrics(
    page,
    '.warehouse-inventory-main .plenki-data-table-shell',
    '.warehouse-row-edit-actions button',
  );
  const inventoryHeaders = await visibleWorkstationHeaders(page, '.warehouse-inventory-data-table');
  assertWorkstationContainerFits(inventory, 'warehouse inventory table', true);
  const sortableInventoryHeaders = inventoryHeaders.filter((header) => header.sortable);
  assert(
    sortableInventoryHeaders.length > 0 &&
      sortableInventoryHeaders.every(
        (header) => header.visible && header.sortControlVisible && header.sortControlContained,
      ),
    `warehouse inventory table: sort controls are hidden ${JSON.stringify(inventoryHeaders)}`,
  );
  await assertNoHorizontalOverflow(page, 'warehouse inventory workstation');
  await screenshot(page, 'warehouse-inventory-workstation1024-first');

  await page
    .locator('.warehouse-inventory-toolbar input[placeholder="Поиск"]')
    .fill('__no_warehouse_inventory__');
  const inventoryEmpty = await workstationEmptyStateMetrics(
    page,
    '.warehouse-inventory-data-table',
  );
  assertWorkstationEmptyState(inventoryEmpty, 'warehouse inventory table', 'cards');

  return {
    viewport,
    intakeColumns,
    queue,
    queueHeaders,
    queueEmpty,
    intake,
    rollCopyAlignment,
    inventoryColumns,
    inventory,
    inventoryHeaders,
    inventoryEmpty,
  };
}

async function productionWorkloadBreakpointMetrics(page, width) {
  await page.setViewportSize({ width, height: 768 });
  await page.waitForTimeout(100);
  return page.evaluate(() => {
    const applicationContent = document
      .querySelector('ix-application')
      ?.shadowRoot?.querySelector('main.content');
    const surface = document.querySelector(
      '.production-operator-planning-page > .production-operator-load-surface',
    );
    const planningPage = document.querySelector('.production-operator-planning-page');
    const machineSurface = planningPage?.querySelector('.production-machine-planning-surface');
    const workloadTable = surface?.querySelector('.production-operator-load-table');
    const header = surface?.querySelector('.production-operator-load-row.is-head');
    const row = surface?.querySelector('.production-operator-load-row:not(.is-head)');
    const columns = row
      ? window.getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/).length
      : 0;
    return {
      application: applicationContent
        ? {
            clientWidth: applicationContent.clientWidth,
            scrollWidth: applicationContent.scrollWidth,
          }
        : null,
      planning: planningPage
        ? { clientWidth: planningPage.clientWidth, scrollWidth: planningPage.scrollWidth }
        : null,
      machineSurface: machineSurface
        ? { clientWidth: machineSurface.clientWidth, scrollWidth: machineSurface.scrollWidth }
        : null,
      workload: workloadTable
        ? { clientWidth: workloadTable.clientWidth, scrollWidth: workloadTable.scrollWidth }
        : null,
      headerDisplay: header ? window.getComputedStyle(header).display : null,
      columns,
    };
  });
}

async function checkProductionWorkloadExpansionLifecycle(page) {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(async () => {
    const [
      reactModule,
      reactDomClientModule,
      { ProductionOperatorLoadSurface },
      { productionOperators },
    ] = await Promise.all([
      import('/@id/react'),
      import('/@id/react-dom/client'),
      import('/src/components/workbenches/productionDispatchPanel.tsx'),
      import('/src/domain/operators.ts'),
    ]);
    const { createElement } = reactModule.default;
    const { createRoot } = reactDomClientModule.default;
    const mount = document.createElement('div');
    mount.dataset.interfaceFixture = 'production-workload-state';
    Object.assign(mount.style, {
      position: 'fixed',
      left: '10px',
      top: '10px',
      zIndex: '2147483647',
      width: '700px',
      maxHeight: '740px',
      overflow: 'auto',
    });
    document.body.append(mount);
    const root = createRoot(mount);
    const operators = productionOperators.slice(0, 2).map((operator) => ({ ...operator }));
    const render = (operatorIds) => {
      root.render(
        createElement(ProductionOperatorLoadSurface, {
          rollDispatchItems: [],
          operators: operators.filter((operator) => operatorIds.includes(operator.id)),
        }),
      );
    };
    render(operators.map((operator) => operator.id));
    window.__productionWorkloadStateFixture = { mount, operators, render, root };
  });

  const fixture = page.locator('[data-interface-fixture="production-workload-state"]');
  await fixture
    .locator('.production-operator-load-row:not(.is-head)')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });

  const readState = () =>
    fixture.evaluate((element) => ({
      expandedCount: element.querySelectorAll(
        '.production-operator-load-disclosure[aria-expanded="true"]',
      ).length,
      detailCount: element.querySelectorAll('.production-operator-load-detail').length,
    }));

  const initial = await readState();
  await fixture.locator('.production-operator-load-disclosure').first().click();
  await page.waitForTimeout(100);
  const explicit = await readState();
  await page.evaluate(() => {
    const fixtureState = window.__productionWorkloadStateFixture;
    fixtureState.render(fixtureState.operators.map((operator) => operator.id));
  });
  await page.waitForTimeout(100);
  const retained = await readState();
  await page.evaluate(() => {
    const fixtureState = window.__productionWorkloadStateFixture;
    fixtureState.render([fixtureState.operators[1].id]);
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const fixtureState = window.__productionWorkloadStateFixture;
    fixtureState.render(fixtureState.operators.map((operator) => operator.id));
  });
  await page.waitForTimeout(100);
  const pruned = await readState();

  assert(
    initial.expandedCount === 0 && initial.detailCount === 0,
    `production workload lifecycle: initial state is expanded ${JSON.stringify(initial)}`,
  );
  assert(
    explicit.expandedCount === 1 &&
      explicit.detailCount === 1 &&
      retained.expandedCount === 1 &&
      retained.detailCount === 1,
    `production workload lifecycle: explicit expansion was not retained ${JSON.stringify({ explicit, retained })}`,
  );
  assert(
    pruned.expandedCount === 0 && pruned.detailCount === 0,
    `production workload lifecycle: removed operator expansion was not pruned ${JSON.stringify(pruned)}`,
  );

  await page.evaluate(() => {
    const fixtureState = window.__productionWorkloadStateFixture;
    fixtureState.root.unmount();
    fixtureState.mount.remove();
    delete window.__productionWorkloadStateFixture;
  });
  return { initial, explicit, retained, pruned };
}

async function checkProductionOperatorAssignmentWorkstation(page) {
  const viewport = { width: 1024, height: 768 };
  await page.setViewportSize(viewport);
  await page.goto(
    `${baseUrl}/?role=production&section=${encodeURIComponent('Операторы / загрузка')}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page
    .locator('.production-operator-load-table')
    .waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(350);

  await page.evaluate(async () => {
    const planningPage = document.querySelector('.production-operator-planning-page');
    if (!planningPage) throw new Error('production workstation: planning page did not mount');

    const { mountInterfaceProductionMachinePlanningFixture } =
      await import('/scripts/interface-production-machine-planning-fixture.tsx');
    mountInterfaceProductionMachinePlanningFixture(planningPage);
  });
  await page
    .locator('[data-interface-fixture="production-machine-planning"]')
    .locator('.production-machine-planning-surface')
    .waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(100);

  const collapsed = await page.evaluate(() => {
    const applicationContent = document
      .querySelector('ix-application')
      ?.shadowRoot?.querySelector('main.content');
    const planningPage = document.querySelector('.production-operator-planning-page');
    const planningSurface = document.querySelector('.production-machine-planning-surface');
    const machineTable = document.querySelector('.production-machine-planning-table');
    const machineRow = machineTable?.querySelector('.production-machine-planning-row');
    const workloadTable = document.querySelector('.production-operator-load-table');
    const workloadRows = Array.from(
      document.querySelectorAll('.production-operator-load-row:not(.is-head)'),
    );
    const applicationRect = applicationContent?.getBoundingClientRect();
    const planningRect = planningPage?.getBoundingClientRect();
    const surfaceRect = planningSurface?.getBoundingClientRect();
    const tableRect = machineTable?.getBoundingClientRect();
    const actionRects = Array.from(
      planningSurface?.querySelectorAll('input, select, button') ?? [],
      (control) => {
        const rect = control.getBoundingClientRect();
        const owner = control.closest('[role="cell"], label, .production-shift-create-grid');
        const ownerRect = owner?.getBoundingClientRect();
        const localScroller = control.closest('.production-machine-planning-table');
        const localScrollerRect = localScroller?.getBoundingClientRect();
        const containedInOwner = Boolean(
          ownerRect && rect.left >= ownerRect.left - 1 && rect.right <= ownerRect.right + 1,
        );
        const locallyClipped = localScroller
          ? Boolean(
              surfaceRect &&
              localScrollerRect &&
              window.getComputedStyle(localScroller).overflowX === 'auto' &&
              localScrollerRect.left >= surfaceRect.left - 1 &&
              localScrollerRect.right <= surfaceRect.right + 1,
            )
          : true;
        return {
          label: (
            control.getAttribute('aria-label') ||
            control.textContent ||
            control.getAttribute('value') ||
            control.tagName
          )
            .replace(/\s+/g, ' ')
            .trim(),
          contained: containedInOwner && locallyClipped,
        };
      },
    );
    return {
      application: applicationContent
        ? {
            clientWidth: applicationContent.clientWidth,
            scrollWidth: applicationContent.scrollWidth,
          }
        : null,
      planning: planningRect
        ? {
            left: planningRect.left,
            right: planningRect.right,
            width: planningRect.width,
            contained: Boolean(
              applicationRect &&
              planningRect.left >= applicationRect.left - 1 &&
              planningRect.right <= applicationRect.right + 1,
            ),
          }
        : null,
      surface: surfaceRect
        ? {
            left: surfaceRect.left,
            right: surfaceRect.right,
            width: surfaceRect.width,
            contained: Boolean(
              planningRect &&
              surfaceRect.left >= planningRect.left - 1 &&
              surfaceRect.right <= planningRect.right + 1,
            ),
          }
        : null,
      machineTable: machineTable
        ? {
            clientWidth: machineTable.clientWidth,
            scrollWidth: machineTable.scrollWidth,
            overflowX: window.getComputedStyle(machineTable).overflowX,
            contained: Boolean(
              surfaceRect &&
              tableRect &&
              tableRect.left >= surfaceRect.left - 1 &&
              tableRect.right <= surfaceRect.right + 1,
            ),
            rowWidth: machineRow?.getBoundingClientRect().width ?? 0,
          }
        : null,
      workload: workloadTable
        ? {
            clientWidth: workloadTable.clientWidth,
            scrollWidth: workloadTable.scrollWidth,
            expandedCount: workloadRows.filter(
              (row) => row.getAttribute('aria-expanded') === 'true',
            ).length,
            detailCount: document.querySelectorAll('.production-operator-load-detail').length,
            columnCount: workloadRows[0]
              ? window.getComputedStyle(workloadRows[0]).gridTemplateColumns.split(' ').length
              : 0,
          }
        : null,
      realMachineComponent:
        planningSurface?.getAttribute('aria-label') === 'Назначение станков операторам по смене' &&
        Boolean(planningSurface.closest('[data-interface-fixture="production-machine-planning"]')),
      actionRects,
    };
  });

  assert(
    collapsed.application &&
      collapsed.application.scrollWidth <= collapsed.application.clientWidth + 1,
    `production workstation: IX content overflow ${JSON.stringify(collapsed)}`,
  );
  assert(
    collapsed.planning?.contained && collapsed.surface?.contained,
    `production workstation: planning surface escapes its content track ${JSON.stringify(collapsed)}`,
  );
  assert(
    collapsed.machineTable?.contained &&
      collapsed.machineTable.overflowX === 'auto' &&
      collapsed.machineTable.scrollWidth <= collapsed.machineTable.clientWidth + 1 &&
      collapsed.machineTable.rowWidth > 0 &&
      collapsed.machineTable.rowWidth <= collapsed.machineTable.clientWidth + 1,
    `production workstation: machine grid must fit without horizontal scrolling ${JSON.stringify(collapsed)}`,
  );
  assert(
    collapsed.workload?.expandedCount === 0 && collapsed.workload.detailCount === 0,
    `production workstation: workload must start collapsed ${JSON.stringify(collapsed)}`,
  );
  assert(
    collapsed.workload?.columnCount === 6 &&
      collapsed.workload.scrollWidth <= collapsed.workload.clientWidth + 1,
    `production workstation: workload is not a compact six-column grid ${JSON.stringify(collapsed)}`,
  );
  assert(
    collapsed.actionRects.length > 0 && collapsed.actionRects.every((action) => action.contained),
    `production workstation: planning control escapes its card ${JSON.stringify(collapsed)}`,
  );
  assert(
    collapsed.realMachineComponent &&
      ['Новый станок после поломки', 'Причина поломки', 'Сменить по поломке'].every((label) =>
        collapsed.actionRects.some((action) => action.label.includes(label)),
      ),
    `production workstation: real breakdown controls are not covered ${JSON.stringify(collapsed)}`,
  );

  const firstWorkload = page.locator('.production-operator-load-disclosure').first();
  await firstWorkload.click();
  await page.waitForTimeout(100);
  const expanded = await page.evaluate(() => {
    const applicationContent = document
      .querySelector('ix-application')
      ?.shadowRoot?.querySelector('main.content');
    const workloadTable = document.querySelector('.production-operator-load-table');
    const detail = document.querySelector('.production-operator-load-detail');
    const tableRect = workloadTable?.getBoundingClientRect();
    const detailRect = detail?.getBoundingClientRect();
    return {
      application: applicationContent
        ? {
            clientWidth: applicationContent.clientWidth,
            scrollWidth: applicationContent.scrollWidth,
          }
        : null,
      expandedCount: document.querySelectorAll(
        '.production-operator-load-disclosure[aria-expanded="true"]',
      ).length,
      detailCount: document.querySelectorAll('.production-operator-load-detail').length,
      detailContained: Boolean(
        tableRect &&
        detailRect &&
        detailRect.left >= tableRect.left - 1 &&
        detailRect.right <= tableRect.right + 1,
      ),
    };
  });
  assert(
    expanded.expandedCount === 1 && expanded.detailCount === 1 && expanded.detailContained,
    `production workstation: explicit workload expansion is not bounded ${JSON.stringify(expanded)}`,
  );
  assert(
    expanded.application &&
      expanded.application.scrollWidth <= expanded.application.clientWidth + 1,
    `production workstation: expanded workload overflows IX content ${JSON.stringify(expanded)}`,
  );
  await assertNoHorizontalOverflow(page, 'production operator assignment workstation');
  await screenshot(page, 'production-operator-assignment-workstation1024-expanded');

  const mobileBoundary = await productionWorkloadBreakpointMetrics(page, 900);
  assert(
    mobileBoundary.headerDisplay === 'none' &&
      mobileBoundary.columns === 1 &&
      mobileBoundary.planning?.scrollWidth <= mobileBoundary.planning?.clientWidth + 1 &&
      mobileBoundary.workload?.scrollWidth <= mobileBoundary.workload?.clientWidth + 1,
    `production workstation: 900px must use bounded mobile cards ${JSON.stringify(mobileBoundary)}`,
  );
  const workstationBoundary = await productionWorkloadBreakpointMetrics(page, 901);
  assert(
    workstationBoundary.headerDisplay !== 'none' &&
      workstationBoundary.columns === 6 &&
      workstationBoundary.planning?.scrollWidth <= workstationBoundary.planning?.clientWidth + 1 &&
      workstationBoundary.workload?.scrollWidth <= workstationBoundary.workload?.clientWidth + 1,
    `production workstation: 901px must keep the compact table ${JSON.stringify(workstationBoundary)}`,
  );
  const expansionLifecycle = await checkProductionWorkloadExpansionLifecycle(page);

  return {
    viewport,
    collapsed,
    expanded,
    breakpoints: { mobileBoundary, workstationBoundary },
    expansionLifecycle,
  };
}

async function record(name, fn) {
  try {
    const detail = await fn();
    ownedVite.assertAlive(name);
    assertSmokeHealthy(smokeTracker, await collectVisibleErrors(smokePage), name);
    report.checks.push({ name, status: 'PASS', detail });
  } catch (error) {
    report.checks.push({
      name,
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

let browser;
let ownedVite;
let smokePage;
let smokeTracker;
try {
  await mkdir(screenshotDir, { recursive: true });
  ownedVite = await startOwnedVite({
    viteBin,
    cwd: process.cwd(),
    env: {
      ...process.env,
      VITE_LIVE_CONTOURS: '',
      VITE_REQUIRE_AUTH: 'off',
    },
  });
  baseUrl = ownedVite.baseUrl;
  report.baseUrl = baseUrl;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  smokePage = page;
  smokeTracker = installPageFailureTracker(page);
  await installBusinessPerformanceSmokeFixture(page);

  await record('non-admin raw label contract', async () => {
    for (const role of nonAdminRoles) await checkRoleRawText(page, role);
    return { roles: nonAdminRoles };
  });
  await record('disabled operational actions have recovery', async () => {
    for (const role of roles) {
      await gotoRole(page, role);
      await disabledOperationalButtons(page, `${role} default`);
    }
    return { roles };
  });
  await record('primary action and first viewport placement', () => checkPrimaryPlacement(page));
  await record('production operator assignment workstation fit', () =>
    checkProductionOperatorAssignmentWorkstation(page),
  );
  await record('warehouse workstation internal tables fit', () =>
    checkWarehouseWorkstationInternalFit(page),
  );
  await record('mobile shell is single column', async () => {
    const metrics = [];
    for (const role of roles) metrics.push({ role, ...(await checkMobileShell(page, role)) });
    return metrics;
  });

  await page.close();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Interface invariants passed. Report: ${reportPath}`);
} catch (error) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  ownedVite?.server.kill('SIGTERM');
}
