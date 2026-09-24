import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { installBusinessPerformanceSmokeFixture } from './business-performance-smoke-fixture.mjs';

const port = 5206;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = path.resolve('qa-screenshots/final-human-ux-2026-07-02-operator-table-first');
const overlapReportPath = path.join(screenshotDir, 'overlap-report.json');
const walkthroughReportPath = path.join(screenshotDir, 'role-cognitive-walkthrough.json');
const findingsPath = path.join(screenshotDir, 'human-ux-findings.md');
const beforeAfterPath = path.join(screenshotDir, 'human-ux-before-after.md');
const viteBin = path.resolve('node_modules/.bin/vite');
const operatorMassSummaryPath = /^\/api\/operator\/orders\/[^/]+\/mass-summary$/;

const roles = ['commercial', 'production', 'finance', 'director', 'operator', 'warehouse', 'admin'];
const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '834x1194', width: 834, height: 1194 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1180x740', width: 1180, height: 740 },
  { name: '390x844', width: 390, height: 844 },
];

const badTerms = [
  'mock',
  'adapter',
  'payload',
  'contract',
  'contract-only',
  'discovery',
  'invoice handoff',
  'manual operation',
  'cash/manual',
  'default_30_days',
  'source_error',
  'Mixed pallet',
  'черновой предпросмотр',
  'AuditEvent',
  'OperationalEvent',
  'prototype/mock',
  'production-ready',
  'backend RBAC',
  'real inventory sync',
  'payroll',
  'source of truth',
  'raw enum',
  'internal enum',
  'Не выбран станок',
  'Выбрать станок',
  'Сохранить строку',
  'История рулона и QR',
  'История рулона/QR',
];

const roleForbidden = {
  operator: ['Счет', 'Оплата', 'Статус оплаты', 'Бухгалтерская толщина', 'Откат', 'Сумма', 'Рассрочка', 'Контрагент'],
  warehouse: ['Откат', 'Статус оплаты', 'Бухгалтерская толщина', 'Сумма', 'Оплата', 'Рассрочка', 'Контрагент', 'raw payload', 'parsed payload'],
  admin: ['Сканировать QR', 'Закрыть приемку', 'Зафиксировать вес', 'Выставить счет', 'Обновить оплату'],
};

const roleNoiseTerms = {
  commercial: ['Главный блок коммерции', 'Ожидает: Коммерция', 'Владелец: Коммерция'],
  production: ['Владелец: Зав. производства'],
  finance: ['Владелец: Бухгалтерия'],
  warehouse: ['Владелец: Склад'],
};
const roleNoiseLabels = {
  commercial: 'Коммерция',
  production: 'Зав. производства',
  finance: 'Бухгалтерия',
  warehouse: 'Склад',
};

const criticalSelectors = [
  '.commercial-next-action',
  '.order-primary-action',
  '.production-decision-strip',
  '.production-current-roll',
  '.finance-primary-action-panel',
  '.finance-mobile-primary-action',
  '.director-decision-card',
  '.operator-current-roll',
  '.operator-focus',
  '.operator-shift-panel',
  '.operator-roll-primary-params',
  '.operator-roll-parameter-strip',
  '.warehouse-scan-session-strip',
  '.scan-focus-strip',
  '.warehouse-action-deck',
  '.action-surface',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIgnoredDevConsoleError(text) {
  return (
    text.includes('WebSocket connection to') ||
    text.includes('[vite] failed to connect to websocket') ||
    text.includes('Failed to send error to Vite server')
  );
}

function safeName(value) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'state';
}

function findTerms(text, terms) {
  const normalized = text.toLowerCase();
  return terms.filter((term) => {
    if (term === '1С') return /(^|[\s"'«(])1с(?=$|[\s"'»:;,.!?)])/.test(normalized);
    return normalized.includes(term.toLowerCase());
  });
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findRoleNoise(text, role) {
  const terms = findTerms(text, roleNoiseTerms[role] ?? []);
  const roleLabel = roleNoiseLabels[role];
  if (roleLabel && new RegExp(`Владелец\\s+${escapedRegex(roleLabel)}`, 'i').test(text)) {
    terms.push(`Владелец ${roleLabel}`);
  }
  return terms;
}

async function waitForServer(server, serverLogs) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Vite preview exited before ready.\n${serverLogs.join('\n').slice(-2000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/?role=operator`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await sleep(250);
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

async function gotoRole(page, role, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 7000 });
  await page.waitForTimeout(450);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
    document.querySelectorAll('*').forEach((element) => {
      if (element instanceof HTMLElement) {
        element.scrollLeft = 0;
        if (!element.matches('.list-panel, .detail-panel, .director-workbench')) element.scrollTop = 0;
      }
    });
  });
}

async function clickSection(page, label) {
  const sections = page.locator('.section-nav-button, .role-top-nav-item, .mobile-section-nav-item').filter({ hasText: label });
  const count = await sections.count();
  for (let index = 0; index < count; index += 1) {
    const section = sections.nth(index);
    if (await section.isVisible().catch(() => false)) {
      await section.click();
      await page.waitForTimeout(350);
      return;
    }
  }
  await sections.first().waitFor({ state: 'visible', timeout: 5000 });
  await sections.first().click();
  await page.waitForTimeout(350);
}

async function clickFirstQueueItem(page) {
  const candidate = page.locator('.queue-row button, .queue-row-main, .finance-queue-card-button, .operator-rolls-hub-row:not(.is-head), .operator-orders-row:not(.is-head)').first();
  if (await candidate.count()) {
    await candidate.click({ timeout: 4000 }).catch(() => null);
    await page.waitForTimeout(300);
  }
}

async function collectGeometry(page, role, viewport) {
  return page.evaluate(({ currentRole, criticalSelectorList }) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    function isInsideHorizontalScroller(element) {
      let current = element.parentElement;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        if (['auto', 'scroll'].includes(style.overflowX) && current.scrollWidth > current.clientWidth + 1) return true;
        current = current.parentElement;
      }
      return false;
    }
    const allVisible = Array.from(document.body.querySelectorAll('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < viewportHeight &&
          rect.left < viewportWidth &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
        if (!visible) return null;
        return {
          tag: element.tagName.toLowerCase(),
          selector: element.id ? `#${element.id}` : element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}` : element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className.slice(0, 160) : '',
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          position: style.position,
          zIndex: style.zIndex,
          insideHorizontalScroller: isInsideHorizontalScroller(element),
        };
      })
      .filter(Boolean);

    const offenders = allVisible
      .filter((entry) => entry.left < -2 || entry.right > viewportWidth + 2)
      .filter((entry) => !entry.insideHorizontalScroller)
      .filter((entry) => !/ix-|svg|path/.test(entry.tag))
      .slice(0, 16);

    const maxRight = allVisible.reduce((max, entry) => Math.max(max, entry.right), 0);
    const navRects = Array.from(document.querySelectorAll('.role-nav, .role-top-nav, .mobile-section-nav, .product-header'))
      .map((element) => ({ element, name: element.className || element.tagName, rect: element.getBoundingClientRect() }))
      .filter((entry) => entry.rect.width > 0 && entry.rect.height > 0);
    const criticalRects = criticalSelectorList.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => ({ element, selector, text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100), rect: element.getBoundingClientRect() }))
    ).filter((entry) => entry.rect.width > 0 && entry.rect.height > 0);

    const overlaps = [];
    for (const nav of navRects) {
      for (const critical of criticalRects) {
        if (nav.element.contains(critical.element) || critical.element.contains(nav.element)) continue;
        const a = nav.rect;
        const b = critical.rect;
        const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        if (overlapX > 2 && overlapY > 2) {
          overlaps.push({
            severity: 'P1',
            type: 'nav-critical-overlap',
            nav: nav.name,
            critical: critical.selector,
            text: critical.text,
            overlapX: Math.round(overlapX),
            overlapY: Math.round(overlapY),
          });
        }
      }
    }

    const hiddenMeaningful = Array.from(document.querySelectorAll('.director-mobile-detail-layer, .director-drawer, .mobile-nav-drawer-layer, .finance-evidence-drawer'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const hasMeaning = (element.textContent ?? '').replace(/\s+/g, ' ').trim().length > 20;
        return {
          selector: element.className || element.tagName,
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: style.display,
          visibility: style.visibility,
          ariaHidden: element.getAttribute('aria-hidden'),
          hasMeaning,
        };
      })
      .filter((entry) => entry.hasMeaning && entry.width === 0 && entry.height === 0 && entry.ariaHidden !== 'true');

    const stickyCriticalOverlap = [];
    const stickyRects = Array.from(document.body.querySelectorAll('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          element,
          selector: element.id ? `#${element.id}` : element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}` : element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className.slice(0, 160) : '',
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          position: style.position,
        };
      })
      .filter((entry) => ['sticky', 'fixed'].includes(entry.position) && entry.width > 0 && entry.height > 0);
    for (const sticky of stickyRects) {
      for (const critical of criticalRects) {
        if (sticky.element.contains(critical.element) || critical.element.contains(sticky.element)) continue;
        const a = sticky;
        const b = critical.rect;
        const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        if (overlapX > 2 && overlapY > 2 && !String(sticky.className).includes(String(critical.selector).replace('.', ''))) {
          stickyCriticalOverlap.push({
            severity: 'P1',
            type: 'sticky-critical-overlap',
            sticky: sticky.selector,
            critical: critical.selector,
            text: critical.text,
            overlapX: Math.round(overlapX),
            overlapY: Math.round(overlapY),
          });
        }
      }
    }

    return {
      role: currentRole,
      viewport: `${viewportWidth}x${viewportHeight}`,
      docWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewportWidth,
      maxRight,
      offenders,
      overlaps,
      stickyCriticalOverlap,
      hiddenMeaningful,
    };
  }, { currentRole: role, criticalSelectorList: criticalSelectors, viewport });
}

async function firstVisible(page, selector, maxTop = 760) {
  return page.locator(selector).evaluateAll((elements, topLimit) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < topLimit && style.display !== 'none' && style.visibility !== 'hidden',
        };
      })
      .find((entry) => entry.visible) ?? null,
    maxTop
  );
}

async function runWalkthrough(page, role, viewportName) {
  const checks = [];
  const pass = async (name, selector, options = {}) => {
    const target = await firstVisible(page, selector, options.maxTop ?? 760);
    checks.push({
      name,
      selector,
      pass: Boolean(target),
      evidence: target,
      question: options.question ?? 'Will users notice the right action/state and understand progress?',
    });
  };
  const text = await collectText(page);
  const contains = (name, needles) => {
    const missing = needles.filter((needle) => !text.toLowerCase().includes(needle.toLowerCase()));
    checks.push({ name, pass: missing.length === 0, missing, question: 'Will users associate labels with the expected result?' });
  };

  if (role === 'commercial') {
    await pass('positions context visible', '.commercial-positions-panel, .commercial-position-matrix, .commercial-next-action');
    contains('commercial order context readable', ['Позиции и параметры', 'Резерв склада']);
  }
  if (role === 'production') {
    await pass('production orders hub progress visible', '.production-orders-hub, .production-orders-table-panel, .production-decision-strip, .production-current-roll, .production-progress-panel, .production-dispatch-strip');
    contains('operator and roll progress labels readable', ['оператор', 'рулон']);
  }
  if (role === 'finance') {
    await pass('first viewport finance command surface visible', '.finance-workbench, .finance-primary-action-panel, .finance-calendar-panel');
    contains('finance source honesty visible', ['Источник', 'остаток']);
  }
  if (role === 'director') {
    await pass(
      'director control or decision surface visible',
      '.commercial-performance-workspace .commercial-performance-content, .director-decision-card, .director-main-grid, .director-workbench',
    );
    contains('director control language visible', ['Контроль', 'решени']);
  }
  if (role === 'operator') {
    await pass('current task/current roll visible', '.operator-rolls-hub, .operator-rolls-hub-row, .operator-focus, .operator-current-roll, .operator-shift-panel');
    await clickSection(page, 'Смена').catch(() => null);
    const bigBagSelector = '.operator-shift-panel input, .manual-bigbag-row input, .operator-bigbag-input, .operator-shift-strip-inline';
    let bigBagTarget = await firstVisible(page, bigBagSelector);
    if (!bigBagTarget) {
      const shiftCommand = page
        .locator('.operator-shift-panel button, .operator-shift-strip-button')
        .filter({ hasText: /Сдать смену|Открыть смену/ })
        .first();
      if (await shiftCommand.count()) {
        await shiftCommand.click({ timeout: 4000 }).catch(() => null);
        await page.waitForTimeout(350);
        bigBagTarget = await firstVisible(page, bigBagSelector);
      }
    }
    checks.push({
      name: 'big-bag input visible in shift',
      selector: bigBagSelector,
      pass: Boolean(bigBagTarget),
      evidence: bigBagTarget,
      question: 'Will users notice the manual Big-bag evidence field at the moment the shift needs it?',
    });
    contains('big-bag audit exception visible', ['Big-bag']);
  }
  if (role === 'warehouse') {
    await pass(
      'scan-first strip visible',
      '.warehouse-scan-session-strip, .scan-focus-strip, .warehouse-scan, .warehouse-scan-input-form',
    );
    contains('warehouse active scan counters readable', ['ожида', 'принят']);
  }
  if (role === 'admin') {
    await pass('admin diagnostics/access surface visible', '.admin-system-focus, .admin-access-surface, .admin-diagnostics, .admin-diagnostics-workbench');
    const mutations = findTerms(text, roleForbidden.admin);
    checks.push({ name: 'admin has no business mutation actions', pass: mutations.length === 0, mutations, question: 'Will admin avoid business workflow actions?' });
  }

  return { role, viewportName, checks, pass: checks.every((check) => check.pass) };
}

async function collectFinanceEchoIssues(page) {
  if ((await page.locator('.finance-workbench').count()) === 0) return [];
  return page.evaluate(() => {
    const layerText = (selector) => (document.querySelector(selector)?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const layerChunks = (selector, layerId) => Array.from(document.querySelectorAll(selector))
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase())
      .filter((text) => text.length >= 24)
      .map((text) => ({ text, layer: layerId }));
    const layers = [
      { id: 'header', text: layerText('.finance-command-header') },
      { id: 'action-context', text: layerText('.finance-action-context-list') },
      { id: 'decision-evidence', text: layerText('.finance-evidence-drawer') },
      { id: 'problem', text: layerText('.finance-problem-panel') },
      { id: 'right-rail', text: layerText('.finance-evidence-column') },
    ];
    const terms = [
      'источник не подтвердил',
      'ошибка источника',
      'остаток',
      'риск суммы',
      'сумма: нет данных',
      'нет данных',
      'требует проверки',
    ];
    return terms
      .map((term) => ({
        term,
        layers: layers.filter((layer) => layer.text.includes(term)).map((layer) => layer.id),
      }))
      .filter((hit) => hit.layers.length > 2 || (hit.layers.includes('right-rail') && hit.layers.filter((layer) => layer !== 'right-rail').length > 1))
      .concat((() => {
        const chunks = [
          ...layerChunks('.finance-command-header :is(small, span)', 'header'),
          ...layerChunks('.finance-action-context-list strong', 'action-context'),
          ...layerChunks('.finance-evidence-drawer strong', 'decision-evidence'),
          ...layerChunks('.finance-problem-panel :is(strong, span, small)', 'problem'),
          ...layerChunks('.finance-evidence-column :is(.finance-panel-heading span, .finance-rail-panel .fact-value, .finance-timeline strong)', 'right-rail'),
        ];
        const grouped = new Map();
        for (const chunk of chunks) {
          const bucket = grouped.get(chunk.text) ?? new Set();
          bucket.add(chunk.layer);
          grouped.set(chunk.text, bucket);
        }
        return Array.from(grouped.entries())
          .map(([term, layerSet]) => ({ term, layers: Array.from(layerSet) }))
          .filter((hit) => hit.layers.length > 1);
      })());
  });
}

async function collectProductionActionDupes(page) {
  if ((await page.locator('.production-workbench').count()) === 0) return [];
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalize = (text) => text
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const issues = [];
    const actionSurfaces = Array.from(document.querySelectorAll('.detail-view.role-production .action-surface'))
      .filter(visible)
      .map((surface) => ({
        text: normalize(surface.textContent ?? '').slice(0, 180),
        inDecisionStrip: Boolean(surface.closest('.production-decision-strip')),
        inDetailGrid: Boolean(surface.closest('.detail-grid')),
      }));
    if (actionSurfaces.length > 1) {
      issues.push({
        type: 'production-duplicate-action-surface',
        detail: `${actionSurfaces.length} action surfaces: ${JSON.stringify(actionSurfaces)}`,
      });
    }

    const labels = Array.from(document.querySelectorAll(
      '.production-decision-strip button.compact-action-button, .detail-grid .action-surface button.compact-action-button'
    ))
      .filter(visible)
      .map((button) => normalize(button.textContent ?? ''))
      .filter(Boolean);
    const counts = labels.reduce((acc, label) => {
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {});
    const repeated = Object.entries(counts).filter(([, count]) => count > 1);
    for (const [label, count] of repeated) {
      issues.push({
        type: 'production-duplicate-action-label',
        detail: `${label}: ${count}`,
      });
    }
    return issues;
  });
}

async function collectCompactTextFitIssues(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const targets = [
      { selector: '.finance-action-context-list li', minWidth: 118, label: 'finance-action-context' },
      { selector: '.finance-calendar-agenda-item', minWidth: 140, label: 'finance-calendar-agenda' },
      { selector: '.finance-timeline li', minWidth: 126, label: 'finance-timeline' },
      { selector: '.finance-mini-kpi', minWidth: 150, label: 'finance-mini-kpi' },
    ];
    const issues = [];
    for (const target of targets) {
      for (const card of Array.from(document.querySelectorAll(target.selector)).filter(isVisible)) {
        const cardRect = card.getBoundingClientRect();
        const cardText = (card.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (cardRect.width < target.minWidth && cardText.length > 10) {
          issues.push({
            type: 'compact-card-too-narrow',
            detail: `${target.label}: ${Math.round(cardRect.width)}px "${cardText.slice(0, 80)}"`,
          });
        }
        for (const textNode of Array.from(card.querySelectorAll('span,strong,small')).filter(isVisible)) {
          const textRect = textNode.getBoundingClientRect();
          const text = (textNode.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          if (textRect.left < cardRect.left - 1 || textRect.right > cardRect.right + 1) {
            issues.push({
              type: 'compact-text-escapes-card',
              detail: `${target.label}: "${text.slice(0, 80)}" text ${Math.round(textRect.left)}-${Math.round(textRect.right)} outside card ${Math.round(cardRect.left)}-${Math.round(cardRect.right)}`,
            });
          }
        }
      }
    }
    return issues;
  });
}

function reportIssue(lines, issue) {
  lines.push(`| ${issue.severity} | ${issue.role} | ${issue.viewport} | ${issue.type} | ${issue.detail.replace(/\|/g, '/')} |`);
}

async function installOperatorMassSummarySmokeFixture(browserPage) {
  await browserPage.route('**/api/operator/orders/*/mass-summary', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!operatorMassSummaryPath.test(pathname)) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        orderPlannedNetKg: 200,
        weighedPlannedNetKg: 100,
        actualNetKg: 101,
        deviationKg: 1,
        weighedRollCount: 1,
        totalRollCount: 2,
      }),
    });
  });
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
const issues = [];
const geometryResults = [];
const walkthroughResults = [];
const consoleErrors = [];
const requestFailures = [];

try {
  await waitForServer(server, serverLogs);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await installBusinessPerformanceSmokeFixture(page);
  await installOperatorMassSummarySmokeFixture(page);
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      if (!isIgnoredDevConsoleError(text)) consoleErrors.push(text);
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = request.failure()?.errorText ?? '';
    if (!url.includes('/@vite') && !url.includes('sockjs') && failure !== 'net::ERR_ABORTED') {
      requestFailures.push(`${request.method()} ${url} ${failure}`);
    }
  });

  for (const viewport of viewports) {
    for (const role of roles) {
      await gotoRole(page, role, viewport);
      await clickFirstQueueItem(page);
      const text = await collectText(page);
      const leaks = [...findTerms(text, badTerms), ...findTerms(text, roleForbidden[role] ?? [])];
      if (leaks.length > 0) {
        issues.push({ severity: role === 'admin' || role === 'operator' || role === 'warehouse' ? 'P1' : 'P2', role, viewport: viewport.name, type: 'bad-term-or-role-leakage', detail: leaks.join(', ') });
      }
      const roleNoise = findRoleNoise(text, role);
      if (roleNoise.length > 0) {
        issues.push({ severity: 'P1', role, viewport: viewport.name, type: 'self-role-owner-chip-noise', detail: roleNoise.join(', ') });
      }

      const geometry = await collectGeometry(page, role, viewport);
      geometryResults.push(geometry);
      if (geometry.docWidth > geometry.viewportWidth + 2 || geometry.bodyWidth > geometry.viewportWidth + 2 || geometry.offenders.length > 0) {
        issues.push({ severity: 'P1', role, viewport: viewport.name, type: 'horizontal-overflow', detail: JSON.stringify({ docWidth: geometry.docWidth, bodyWidth: geometry.bodyWidth, viewport: geometry.viewportWidth, offenders: geometry.offenders.slice(0, 4) }) });
      }
      for (const overlap of [...geometry.overlaps, ...geometry.stickyCriticalOverlap]) {
        issues.push({ severity: 'P1', role, viewport: viewport.name, type: overlap.type, detail: JSON.stringify(overlap) });
      }
      if (role === 'director' && viewport.width <= 390 && geometry.hiddenMeaningful.length > 0) {
        issues.push({ severity: 'P1', role, viewport: viewport.name, type: 'hidden-0x0-drawer-dom', detail: JSON.stringify(geometry.hiddenMeaningful.slice(0, 4)) });
      }
      if (role === 'finance') {
        const echoIssues = await collectFinanceEchoIssues(page);
        for (const issue of echoIssues) {
          issues.push({ severity: 'P1', role, viewport: viewport.name, type: 'finance-echoed-fact', detail: `${issue.term}: ${issue.layers.join(' -> ')}` });
        }
      }
      if (role === 'production') {
        const actionDupes = await collectProductionActionDupes(page);
        for (const issue of actionDupes) {
          issues.push({ severity: 'P1', role, viewport: viewport.name, type: issue.type, detail: issue.detail });
        }
      }
      const compactTextIssues = await collectCompactTextFitIssues(page);
      for (const issue of compactTextIssues) {
        issues.push({ severity: 'P1', role, viewport: viewport.name, type: issue.type, detail: issue.detail });
      }

      await page.screenshot({ path: path.join(screenshotDir, `${role}-${viewport.name}.png`), fullPage: true });

      if (viewport.name === '390x844' || viewport.name === '1366x768') {
        walkthroughResults.push(await runWalkthrough(page, role, viewport.name));
      }
    }
  }

  if (consoleErrors.length > 0) {
    issues.push({ severity: 'P1', role: 'all', viewport: 'all', type: 'console-errors', detail: consoleErrors.slice(0, 8).join(' / ') });
  }
  if (requestFailures.length > 0) {
    issues.push({ severity: 'P1', role: 'all', viewport: 'all', type: 'request-failures', detail: requestFailures.slice(0, 8).join(' / ') });
  }

  for (const walkthrough of walkthroughResults) {
    if (!walkthrough.pass) {
      const failed = walkthrough.checks.filter((check) => !check.pass).map((check) => check.name).join(', ');
      issues.push({ severity: 'P1', role: walkthrough.role, viewport: walkthrough.viewportName, type: 'cognitive-walkthrough-fail', detail: failed });
    }
  }

  await writeFile(overlapReportPath, JSON.stringify({ baseUrl, screenshotDir, viewports, roles, issues, geometryResults, consoleErrors, requestFailures }, null, 2));
  await writeFile(walkthroughReportPath, JSON.stringify({ baseUrl, walkthroughResults }, null, 2));

  const findingLines = [
    '# Final Human UX Findings',
    '',
    `Дата: 2026-07-02`,
    `Target: ${baseUrl}`,
    `Evidence: ${screenshotDir}`,
    '',
    '## Метод',
    '',
    '- NN/g heuristic evaluation: visibility, match to process, recognition, error recovery, minimalist operational surface, role boundary.',
    '- Cognitive walkthrough: correct goal, visible action, understandable label, visible progress.',
    '- Aura routing: ui-audit-and-quality-review, details-that-make-interfaces-feel-better, responsive-design.',
    '- Project lens: role-first UI; integrations and devices stay discovery-bound.',
    '',
    '## Findings',
    '',
  ];
  if (issues.length === 0) {
    findingLines.push('No P0/P1 findings from automated final-human-ux smoke.');
  } else {
    findingLines.push('| Severity | Role | Viewport | Type | Detail |');
    findingLines.push('|---|---|---|---|---|');
    for (const issue of issues) reportIssue(findingLines, issue);
  }
  findingLines.push('');
  findingLines.push('## Screenshots');
  findingLines.push('');
  for (const viewport of viewports) {
    findingLines.push(`- ${viewport.name}: ${roles.map((role) => `${role}-${viewport.name}.png`).join(', ')}`);
  }
  await writeFile(findingsPath, `${findingLines.join('\n')}\n`);

  const beforeAfterLines = [
    '# Final Human UX Before / After',
    '',
    '| Before | After | Why |',
    '|---|---|---|',
    '| Разрозненные smoke-отчеты по старым папкам | Единый `final-human-ux` smoke на 7 ролей и 5 viewport | Client-show gate должен доказывать именно текущий human UX и MacBook 13 overlap blocker |',
    '| Overflow/overlap проверялись частично | `overlap-report.json` фиксирует body overflow, right-edge offenders, nav/sticky critical overlaps and hidden 0x0 drawer DOM | P1 blockers должны падать до deploy |',
    '| Walkthrough оставался ручной договоренностью | `role-cognitive-walkthrough.json` фиксирует pass/fail по ключевым задачам ролей | Проверяем learnability для нового пользователя роли |',
  ];
  await writeFile(beforeAfterPath, `${beforeAfterLines.join('\n')}\n`);

  const blockers = issues.filter((issue) => issue.severity === 'P0' || issue.severity === 'P1');
  assert(blockers.length === 0, `Final human UX smoke found ${blockers.length} P0/P1 issue(s). See ${findingsPath}`);
  console.log(`Final human UX smoke passed. Evidence: ${screenshotDir}`);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
