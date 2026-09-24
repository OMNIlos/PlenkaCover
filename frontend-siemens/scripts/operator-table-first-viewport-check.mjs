import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5198;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');
const screenshotDir = path.resolve('qa-screenshots/operator-rolls-hub-2026-07-06');
const reportPath = path.join(screenshotDir, 'operator-rolls-hub-viewport-report.json');

const viewports = [
  {
    name: '1024x768',
    width: 1024,
    height: 768,
    strictFirstViewport: true,
    ubuntuWorkstation: true,
  },
  {
    name: '1024x768-125pct',
    width: 819,
    height: 614,
    deviceScaleFactor: 1.25,
    ubuntuWorkstation: true,
    allowVerticalScroll: true,
  },
  { name: '1366x768', width: 1366, height: 768, strictFirstViewport: true },
  { name: '1440x900', width: 1440, height: 900, strictFirstViewport: true },
  { name: '900x768', width: 900, height: 768, strictFirstViewport: false },
  { name: '834x1194', width: 834, height: 1194, strictFirstViewport: false },
  { name: '640x900', width: 640, height: 900, strictFirstViewport: false },
  { name: '520x900', width: 520, height: 900, strictFirstViewport: false },
  { name: '390x844', width: 390, height: 844, strictFirstViewport: false },
];

function waitForServer() {
  const deadline = Date.now() + 20_000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // retry until deadline
      }
      if (Date.now() > deadline) {
        reject(new Error('Vite preview did not start in time'));
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

async function selectFirstOperatorOrder(page, requestedObjectId = null) {
  const url = new URL(baseUrl);
  url.searchParams.set('role', 'operator');
  if (requestedObjectId) {
    url.searchParams.set('section', 'Рулоны и заказы');
    url.searchParams.set('object', requestedObjectId);
  }
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  const rollHub = page.locator('.operator-rolls-hub').first();
  if (!(await rollHub.isVisible())) {
    await page
      .locator('.role-nav, .role-top-nav')
      .getByRole('button', { name: /Мои рулоны|Рулоны и заказы/i })
      .first()
      .click();
  }
  const selectedRow = rollHub.locator('.operator-rolls-hub-row.is-selected').first();
  if (requestedObjectId) {
    const initialSelection = {
      objectId: new URL(page.url()).searchParams.get('object'),
      selectedRowLabel: await selectedRow.getAttribute('aria-label'),
    };
    assert(
      initialSelection.objectId === requestedObjectId &&
        initialSelection.selectedRowLabel?.includes(requestedObjectId),
      `1024x768: direct URL object was not hydrated ${JSON.stringify(initialSelection)}`,
    );
  } else {
    await waitForTwoAnimationFrames(page);
    await assertOperatorSelectionCleared(page, '1024x768 on fresh operator load');
  }
  const targetRow = requestedObjectId
    ? rollHub.getByRole('row', { name: `Открыть рулон ${requestedObjectId}` }).first()
    : rollHub.locator('.operator-rolls-hub-row:not(.is-head)').first();
  await targetRow.click();
  await page.waitForTimeout(450);
}

async function waitForTwoAnimationFrames(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function assertOperatorSelectionCleared(page, context) {
  const state = await page.evaluate(() => {
    const navigationRect = document
      .querySelector('.operator-rolls-hub-page > .role-top-nav')
      ?.getBoundingClientRect();
    const hubRect = document.querySelector('.operator-rolls-hub')?.getBoundingClientRect();
    return {
      detailCount: document.querySelectorAll('.operator-rolls-hub-page > .detail-view').length,
      emptyDetailCount: document.querySelectorAll(
        '.operator-rolls-hub-page > .detail-blank-state[aria-label="Карточка не выбрана"]',
      ).length,
      hasDetail: document
        .querySelector('.operator-rolls-hub-page')
        ?.getAttribute('data-has-detail'),
      selectedRowCount: document.querySelectorAll('.operator-rolls-hub-row.is-selected').length,
      objectId: new URL(window.location.href).searchParams.get('object'),
      navigationBottom: navigationRect?.bottom ?? null,
      hubTop: hubRect?.top ?? null,
    };
  });
  assert(
    state.detailCount === 0 && state.emptyDetailCount === 0 && state.hasDetail === 'false',
    `${context}: operator detail was reselected ${JSON.stringify(state)}`,
  );
  assert(
    state.selectedRowCount === 0,
    `${context}: operator row was reselected ${JSON.stringify(state)}`,
  );
  assert(
    state.navigationBottom !== null &&
      state.hubTop !== null &&
      state.hubTop - state.navigationBottom <= 12,
    `${context}: empty detail left a vertical hole ${JSON.stringify(state)}`,
  );
  assert(state.objectId === null, `${context}: URL object was restored ${JSON.stringify(state)}`);
  return state;
}

async function assertOperatorRoleSwitchStartsEmpty(page) {
  await page.goto(`${baseUrl}/?role=commercial`, { waitUntil: 'networkidle' });
  await page.locator('.demo-role-button').filter({ hasText: 'Оператор' }).first().click();
  await waitForTwoAnimationFrames(page);
  const activeRole = new URL(page.url()).searchParams.get('role');
  assert(
    activeRole === 'operator',
    `1024x768: demo role switch did not open operator ${JSON.stringify({ activeRole })}`,
  );
  return assertOperatorSelectionCleared(page, '1024x768 after switching into operator role');
}

function rectFitsInside(inner, outer, tolerance = 1) {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.right <= outer.right + tolerance &&
    inner.bottom <= outer.bottom + tolerance
  );
}

function pairwiseRectOverlaps(rects, tolerance = 1) {
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
      const left = rects[leftIndex];
      const right = rects[rightIndex];
      const overlapWidth = Math.min(left.right, right.right) - Math.max(left.x, right.x);
      const overlapHeight = Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y);
      if (overlapWidth > tolerance && overlapHeight > tolerance) {
        overlaps.push({ left: left.label, right: right.label, overlapWidth, overlapHeight });
      }
    }
  }
  return overlaps;
}

async function driveCurrentOperatorRollToQrPrint(page, viewportName) {
  const detail = page.locator('.operator-rolls-hub-page > .detail-view').first();
  assert(await detail.isVisible(), `${viewportName}: selected operator detail is missing`);

  const actions = [
    { label: 'Примите заказ', name: /^Примите заказ(?:\.|$)/u },
    { label: 'Зафиксировать вес шпули', name: /^Зафиксировать вес шпули(?:\.|$)/u },
    { label: 'Зафиксировать вес рулона', name: /^Зафиксировать вес рулона(?:\.|$)/u },
  ];
  for (const { label, name } of actions) {
    const action = detail.getByRole('button', { name }).first();
    assert(await action.isVisible(), `${viewportName}: demo flow action «${label}» is missing`);
    assert(await action.isEnabled(), `${viewportName}: demo flow action «${label}» is disabled`);
    await action.click();
    await waitForTwoAnimationFrames(page);
  }

  const reweigh = detail.getByRole('button', { name: 'Перевзвесить рулон', exact: true }).first();
  const flowState = {
    currentStep: await detail.locator('.operator-focus h3').first().textContent(),
    reweighVisible: await reweigh.isVisible(),
    reweighEnabled: await reweigh.isEnabled(),
  };
  assert(
    flowState.currentStep?.toLowerCase().includes('напечатайте qr'),
    `${viewportName}: demo flow did not reach qr_print ${JSON.stringify(flowState)}`,
  );
  assert(
    flowState.reweighVisible && flowState.reweighEnabled,
    `${viewportName}: demo flow did not expose enabled reweigh ${JSON.stringify(flowState)}`,
  );
  return flowState;
}

async function inspectOperatorProcessingSurface(page, viewportName, workstation) {
  const detail = page.locator('.operator-rolls-hub-page > .detail-view').first();
  assert(await detail.isVisible(), `${viewportName}: selected operator detail is missing`);
  assert(
    (await detail.locator('.operator-roll-detail-drawer').count()) === 0,
    `${viewportName}: removed roll detail drawer is still rendered`,
  );

  await detail.evaluate((element, injectLongTextProbe) => {
    if (!injectLongTextProbe) return;
    const heading = element.querySelector('.operator-focus h3');
    const instruction = element.querySelector('.operator-step-instruction');
    if (heading) {
      heading.textContent = 'Контрольное перевзвешивание рулона';
      heading.setAttribute('data-viewport-probe', 'step-heading');
    }
    if (instruction) {
      instruction.textContent = 'Ожидает подтверждения стабильного сигнала от весового поста';
      instruction.setAttribute('data-viewport-probe', 'step-instruction');
    }
  }, workstation);
  await waitForTwoAnimationFrames(page);

  const geometry = await page.evaluate(() => {
    const detailElement = document.querySelector('.operator-rolls-hub-page > .detail-view');
    const essentials = detailElement?.querySelector('.operator-roll-essentials');
    const focus = detailElement?.querySelector('.operator-focus');
    const appShell = document.querySelector('.app-shell');
    const rect = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        right: bounds.right,
        bottom: bounds.bottom,
      };
    };
    const isVisible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const textMetric = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim() ?? '',
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    };
    const actionSelector = [
      '.detail-close-button',
      '.operator-current-actions button',
      '.operator-roll-primary-action',
      '.operator-row-secondary-action',
    ].join(',');
    const actionRects = detailElement
      ? Array.from(detailElement.querySelectorAll(actionSelector))
          .filter(isVisible)
          .map((element) => {
            const label =
              element.getAttribute('aria-label') ??
              element.textContent?.trim() ??
              'operator-action';
            const bounds = rect(element);
            const hitTarget = document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            );
            return {
              ...bounds,
              label,
              isClose: element.matches('.detail-close-button'),
              isPrimary:
                Boolean(element.closest('.primary-actions')) ||
                element.matches('.operator-roll-primary-action'),
              isProblem: /проблем/u.test(label.toLowerCase()),
              isReweigh: /перевзв/u.test(label.toLowerCase()),
              disabled: element.matches(':disabled'),
              hitTarget: hitTarget === element || element.contains(hitTarget),
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
            };
          })
      : [];
    const regionSelector = [
      '.operator-roll-essentials',
      '.operator-focus',
      '.operator-row-secondary-rail:not(.is-inline)',
      '.operator-roll-table',
    ].join(',');

    return {
      detail: detailElement ? rect(detailElement) : null,
      essentials: essentials ? rect(essentials) : null,
      focus: focus ? rect(focus) : null,
      drawerCount: detailElement?.querySelectorAll('.operator-roll-detail-drawer').length ?? 0,
      duplicateDetailsText: detailElement?.textContent?.includes('Детали рулона и QR') ?? false,
      factLine: textMetric(essentials?.querySelector('.operator-roll-product-summary dl') ?? null),
      weightText:
        essentials?.querySelector('.operator-roll-weight-summary')?.textContent?.trim() ?? '',
      probeTextMetrics: detailElement
        ? Array.from(detailElement.querySelectorAll('[data-viewport-probe]'))
            .filter(isVisible)
            .map((element) => ({
              probe: element.getAttribute('data-viewport-probe'),
              ...textMetric(element),
            }))
        : [],
      regionRects: detailElement
        ? Array.from(detailElement.querySelectorAll(regionSelector))
            .filter(isVisible)
            .map((element) => ({
              ...rect(element),
              label: element.className || element.tagName.toLowerCase(),
            }))
        : [],
      actionRects,
      overflow: {
        document: {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        },
        body: { clientWidth: document.body.clientWidth, scrollWidth: document.body.scrollWidth },
        appShell: appShell
          ? { clientWidth: appShell.clientWidth, scrollWidth: appShell.scrollWidth }
          : null,
        detail: detailElement
          ? { clientWidth: detailElement.clientWidth, scrollWidth: detailElement.scrollWidth }
          : null,
      },
    };
  });

  assert(
    geometry.detail && geometry.essentials && geometry.focus,
    `${viewportName}: compact processing surface is incomplete ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.drawerCount === 0 && !geometry.duplicateDetailsText,
    `${viewportName}: removed roll details returned ${JSON.stringify(geometry)}`,
  );
  assertTextIsReadable(geometry.factLine, `${viewportName}: roll fact line`);
  for (const token of ['мкм', 'м', 'кг']) {
    assert(
      geometry.factLine.text.includes(token),
      `${viewportName}: roll fact line misses ${token} ${JSON.stringify(geometry.factLine)}`,
    );
  }
  assert(
    geometry.factLine.text.includes('мм') ||
      /\d+(?:[.,]\d+)?\s*м\s*[x×]\s*\d+(?:[.,]\d+)?\s*м/iu.test(geometry.factLine.text) ||
      /Ширина\s*\d+(?:[.,]\d+)?\s*м[\s\S]*Метраж\s*[\d\s\u00a0]+м/iu.test(geometry.factLine.text),
    `${viewportName}: roll fact line misses width/length dimensions ${JSON.stringify(geometry.factLine)}`,
  );
  for (const weightLabel of ['Шпуля', 'Брутто', 'Нетто']) {
    assert(
      geometry.weightText.includes(weightLabel),
      `${viewportName}: current roll weights miss ${weightLabel}`,
    );
  }
  assert(
    geometry.essentials.bottom <= geometry.focus.y + 1,
    `${viewportName}: roll facts do not precede the current step`,
  );
  const regionOverlaps = pairwiseRectOverlaps(geometry.regionRects);
  assert(
    regionOverlaps.length === 0,
    `${viewportName}: processing regions overlap ${JSON.stringify(regionOverlaps)}`,
  );
  for (const [surface, widths] of Object.entries(geometry.overflow)) {
    assert(
      widths && widths.scrollWidth <= widths.clientWidth + 2,
      `${viewportName}: processing surface overflows ${surface} ${JSON.stringify(widths)}`,
    );
  }
  assert(
    geometry.actionRects.some((action) => action.isClose),
    `${viewportName}: operator detail has no close action`,
  );
  assert(
    geometry.actionRects.some((action) => action.isPrimary),
    `${viewportName}: operator detail has no primary action`,
  );
  assert(
    geometry.actionRects.some((action) => action.isProblem),
    `${viewportName}: operator detail has no problem action`,
  );
  const reweighAction = geometry.actionRects.find((action) => action.isReweigh);
  assert(
    reweighAction && !reweighAction.disabled && reweighAction.hitTarget,
    `${viewportName}: operator detail has no enabled reweigh action ${JSON.stringify(geometry.actionRects)}`,
  );
  const actionOverlaps = pairwiseRectOverlaps(geometry.actionRects);
  assert(
    actionOverlaps.length === 0,
    `${viewportName}: operator detail actions overlap ${JSON.stringify(actionOverlaps)}`,
  );
  for (const action of geometry.actionRects) {
    assert(
      rectFitsInside(action, geometry.detail),
      `${viewportName}: operator action escapes detail surface ${JSON.stringify({ action, detail: geometry.detail })}`,
    );
    assert(
      action.scrollWidth <= action.clientWidth + 1,
      `${viewportName}: operator action content overflows ${JSON.stringify(action)}`,
    );
  }

  if (workstation) {
    for (const probe of geometry.probeTextMetrics) {
      assertTextIsReadable(probe, `${viewportName}: ${probe.probe}`);
    }
  }

  return geometry;
}

async function exerciseWorkstationNavigation(page) {
  const closeCardButton = page.getByRole('button', { name: 'Закрыть карточку' }).first();
  assert(await closeCardButton.isVisible(), '1024x768: selected roll detail has no close button');
  await closeCardButton.click();
  await waitForTwoAnimationFrames(page);
  const stateAfterClose = await assertOperatorSelectionCleared(
    page,
    '1024x768 after explicit close',
  );

  const desktopNavigation = page.locator(
    '.operator-rolls-hub-page > .role-top-nav .role-top-nav-list',
  );
  assert(await desktopNavigation.isVisible(), '1024x768: desktop navigation is not visible');
  const selectionButton = desktopNavigation.getByRole('button', {
    name: 'Переданы на склад',
    exact: true,
  });
  await selectionButton.click();
  await waitForTwoAnimationFrames(page);
  const selectedSection = new URL(page.url()).searchParams.get('section');
  assert(
    selectedSection === 'Переданы на склад',
    `1024x768: desktop navigation did not navigate ${JSON.stringify({ selectedSection })}`,
  );
  const stateAfterHandover = await assertOperatorSelectionCleared(
    page,
    '1024x768 after navigating to Переданы на склад',
  );

  await page
    .locator('.role-nav, .role-top-nav')
    .getByRole('button', { name: 'Рулоны и заказы', exact: true })
    .first()
    .click();
  await waitForTwoAnimationFrames(page);
  const stateAfterReturn = await assertOperatorSelectionCleared(
    page,
    '1024x768 after returning to Рулоны и заказы',
  );
  await page.locator('.operator-rolls-hub-row:not(.is-head)').first().click();
  await waitForTwoAnimationFrames(page);

  return {
    selectedSection,
    stateAfterClose,
    stateAfterHandover,
    stateAfterReturn,
  };
}

async function assertStationaryOperatorProcessingPane(page, viewportName, screenshotPath) {
  const snapshot = () =>
    page.evaluate(() => {
      const detail = document.querySelector('.operator-rolls-hub-page > .detail-view');
      const hub = document.querySelector('.operator-rolls-hub-page > .operator-rolls-hub');
      const applicationContent = document
        .querySelector('ix-application')
        ?.shadowRoot?.querySelector('main.content');
      const detailStyle = detail ? getComputedStyle(detail) : null;
      return {
        detailTop: detail?.getBoundingClientRect().top ?? null,
        hubTop: hub?.getBoundingClientRect().top ?? null,
        detailPosition: detailStyle?.position ?? null,
        detailScrollTop: detail?.scrollTop ?? null,
        windowScrollTop: window.scrollY,
        applicationScrollTop: applicationContent?.scrollTop ?? null,
      };
    });

  await page.evaluate(() => {
    const detail = document.querySelector('.operator-rolls-hub-page > .detail-view');
    const applicationContent = document
      .querySelector('ix-application')
      ?.shadowRoot?.querySelector('main.content');
    if (detail) detail.scrollTop = 0;
    if (applicationContent) applicationContent.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await waitForTwoAnimationFrames(page);
  const before = await snapshot();

  const scroll = await page.evaluate(async () => {
    const applicationContent = document
      .querySelector('ix-application')
      ?.shadowRoot?.querySelector('main.content');
    const applicationCanScroll =
      applicationContent && applicationContent.scrollHeight > applicationContent.clientHeight + 1;
    const scrollHeight = applicationCanScroll
      ? applicationContent.scrollHeight
      : document.documentElement.scrollHeight;
    const clientHeight = applicationCanScroll
      ? applicationContent.clientHeight
      : document.documentElement.clientHeight;
    const target = Math.min(180, Math.max(0, scrollHeight - clientHeight));
    if (applicationCanScroll) {
      applicationContent.scrollTop = target;
    } else {
      window.scrollTo({ top: target, behavior: 'instant' });
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      owner: applicationCanScroll ? 'application' : 'document',
      target,
      actual: applicationCanScroll ? applicationContent.scrollTop : window.scrollY,
    };
  });
  const after = await snapshot();

  assert(
    scroll.actual >= 80,
    `${viewportName}: left list did not scroll far enough ${JSON.stringify(scroll)}`,
  );
  assert(
    before.hubTop !== null && after.hubTop !== null && after.hubTop <= before.hubTop - 80,
    `${viewportName}: left list did not retain its scrolling behavior ${JSON.stringify({ before, after, scroll })}`,
  );
  assert(
    before.detailTop !== null &&
      after.detailTop !== null &&
      Math.abs(after.detailTop - before.detailTop) <= 8,
    `${viewportName}: processing pane moved with the left list ${JSON.stringify({ before, after, scroll })}`,
  );
  assert(
    ['fixed', 'sticky'].includes(after.detailPosition),
    `${viewportName}: processing pane is not stationary ${JSON.stringify(after)}`,
  );

  await page.screenshot({ path: screenshotPath });
  await page.evaluate(() => {
    const detail = document.querySelector('.operator-rolls-hub-page > .detail-view');
    const applicationContent = document
      .querySelector('ix-application')
      ?.shadowRoot?.querySelector('main.content');
    if (detail) detail.scrollTop = 0;
    if (applicationContent) applicationContent.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await waitForTwoAnimationFrames(page);

  return { before, after, scroll };
}

async function collectGeometry(page) {
  return page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    };
    const textMetric = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim() ?? '',
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    };
    const visibleCount = (selector) =>
      Array.from(document.querySelectorAll(selector)).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      }).length;
    const table = document.querySelector('.operator-rolls-hub-table');
    const page = document.querySelector('.operator-rolls-hub-page');
    const applicationContent = document
      .querySelector('ix-application')
      ?.shadowRoot?.querySelector('main.content');
    const moreButton = document.querySelector(
      '.operator-rolls-hub-page > .role-top-nav .mobile-section-nav-more',
    );
    const childRegions = page
      ? Array.from(page.children).map((element) => {
          if (element.matches('.role-top-nav')) return 'navigation';
          if (element.matches('.operator-rolls-hub')) return 'hub';
          if (element.matches('.detail-view')) return 'detail';
          return 'other';
        })
      : [];
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollY: window.scrollY,
      docWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      hub: rectFor('.operator-rolls-hub'),
      detail: rectFor('.operator-rolls-hub-page > .detail-view'),
      focus: rectFor('.operator-focus.operator-focus-compact'),
      currentActions: rectFor('.operator-current-actions .action-tile'),
      currentRow: rectFor('.operator-rolls-hub-row.is-current'),
      selectedRow: rectFor('.operator-rolls-hub-row.is-selected'),
      compactNavigation: visibleCount(
        '.operator-rolls-hub-page > .role-top-nav .floor-mobile-section-nav',
      ),
      desktopNavigation: visibleCount(
        '.operator-rolls-hub-page > .role-top-nav .role-top-nav-list',
      ),
      moreButton: moreButton
        ? {
            ariaLabel: moreButton.getAttribute('aria-label'),
            text: moreButton.textContent?.trim() ?? '',
          }
        : null,
      table: table
        ? {
            clientWidth: table.clientWidth,
            scrollWidth: table.scrollWidth,
          }
        : null,
      statusLabel: textMetric('.operator-rolls-hub-row.is-selected [data-column="status"] strong'),
      stepLabel: textMetric('.operator-rolls-hub-row.is-selected [data-column="step"] strong'),
      primaryActionLabel: textMetric(
        '.operator-current-actions .action-tile .action-tile-text strong',
      ),
      childRegions,
      scrollRoots: {
        window: window.scrollY,
        document: document.scrollingElement?.scrollTop ?? null,
        appShell: document.querySelector('.app-shell')?.scrollTop ?? null,
        detailPanel: document.querySelector('.detail-panel')?.scrollTop ?? null,
        applicationContent: applicationContent?.scrollTop ?? null,
      },
      oldTerminalActions: visibleCount(
        '.operator-terminal.operator-table-terminal .terminal-actions',
      ),
      mobileEvidence: visibleCount(
        '.operator-terminal.operator-table-terminal .operator-roll-mobile-evidence',
      ),
    };
  });
}

function assertTextIsReadable(metric, context) {
  assert(metric, `${context}: label missing`);
  assert(metric.text.length > 0, `${context}: label is empty`);
  assert(
    metric.textOverflow !== 'ellipsis',
    `${context}: label uses ellipsis ${JSON.stringify(metric)}`,
  );
  assert(
    metric.scrollWidth <= metric.clientWidth + 1 && metric.scrollHeight <= metric.clientHeight + 1,
    `${context}: label is clipped ${JSON.stringify(metric)}`,
  );
}

await mkdir(screenshotDir, { recursive: true });
// Dev-сервер вместо preview: PROD-сборка всегда требует вход (AuthGate),
// а смоук проверяет операторский экран без сессии — как dom-leakage-check.
const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(),
  env: { ...process.env, VITE_LIVE_CONTOURS: '', VITE_REQUIRE_AUTH: 'off' },
  stdio: 'pipe',
  shell: false,
});

const report = { baseUrl, screenshotDir, viewports, results: [] };

try {
  await waitForServer();
  const browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    });
    let emptyScreenshot = null;
    if (viewport.ubuntuWorkstation) {
      await assertOperatorRoleSwitchStartsEmpty(page);
      emptyScreenshot = path.join(screenshotDir, `${viewport.name}-empty.png`);
      await page.screenshot({ path: emptyScreenshot });
      await selectFirstOperatorOrder(page, 'R-B11-01');
      await selectFirstOperatorOrder(page);
    } else {
      await selectFirstOperatorOrder(page, 'R-A17-01');
    }
    const navigationState = viewport.ubuntuWorkstation
      ? await exerciseWorkstationNavigation(page)
      : null;
    const reweighFlowState = ['1024x768', '1366x768'].includes(viewport.name)
      ? await driveCurrentOperatorRollToQrPrint(page, viewport.name)
      : null;
    const processingSurfaceState = ['1024x768', '1366x768'].includes(viewport.name)
      ? await inspectOperatorProcessingSurface(page, viewport.name, viewport.ubuntuWorkstation)
      : null;
    const stationaryScreenshot = path.join(
      screenshotDir,
      `${viewport.name}-stationary-processing-pane.png`,
    );
    const stationaryProcessingPaneState = ['1024x768', '1024x768-125pct', '1366x768'].includes(
      viewport.name,
    )
      ? await assertStationaryOperatorProcessingPane(page, viewport.name, stationaryScreenshot)
      : null;
    const geometry = await collectGeometry(page);
    const screenshot = path.join(screenshotDir, `${viewport.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: !viewport.ubuntuWorkstation });

    assert(geometry.hub, `${viewport.name}: operator roll hub missing`);
    assert(geometry.focus, `${viewport.name}: operator current-step block missing`);
    assert(geometry.currentActions, `${viewport.name}: operator current action block missing`);
    assert(geometry.currentRow, `${viewport.name}: current roll hub row missing`);
    assert(geometry.selectedRow, `${viewport.name}: selected roll hub row missing`);
    assert(
      geometry.oldTerminalActions === 0,
      `${viewport.name}: old terminal action panel is still visible`,
    );
    assert(
      geometry.mobileEvidence === 0,
      `${viewport.name}: competing mobile evidence cards are visible`,
    );
    assert(
      geometry.docWidth <= geometry.viewport.width + 2 &&
        geometry.bodyWidth <= geometry.viewport.width + 2,
      `${viewport.name}: horizontal overflow ${JSON.stringify(geometry)}`,
    );
    assert(
      geometry.currentActions.height >= 56,
      `${viewport.name}: current action touch target too small ${JSON.stringify(geometry.currentActions)}`,
    );
    assert(
      geometry.selectedRow.height >= 40,
      `${viewport.name}: selected hub row touch target too small ${JSON.stringify(geometry.selectedRow)}`,
    );
    assert(
      geometry.selectedRow.x >= -2 && geometry.selectedRow.right <= geometry.viewport.width + 2,
      `${viewport.name}: selected hub row is horizontally clipped ${JSON.stringify(geometry.selectedRow)}`,
    );
    if (viewport.strictFirstViewport && !viewport.ubuntuWorkstation) {
      assert(
        geometry.hub.y <= 260,
        `${viewport.name}: roll hub starts too low ${JSON.stringify(geometry.hub)}`,
      );
      assert(
        geometry.currentActions.bottom <= geometry.viewport.height + 2,
        `${viewport.name}: current action requires vertical scroll ${JSON.stringify(geometry.currentActions)}`,
      );
      assert(
        geometry.selectedRow.y <= geometry.viewport.height + 2,
        `${viewport.name}: selected row starts below first viewport ${JSON.stringify(geometry.selectedRow)}`,
      );
    } else if (!viewport.ubuntuWorkstation && geometry.viewport.width <= 1240) {
      assert(
        geometry.currentActions.y >= -2 &&
          geometry.currentActions.bottom <= geometry.viewport.height + 2,
        `${viewport.name}: selected roll action is outside the viewport ${JSON.stringify(geometry.currentActions)}`,
      );
    } else if (!viewport.ubuntuWorkstation) {
      assert(
        geometry.currentRow.y <= geometry.viewport.height + 2,
        `${viewport.name}: current row is not in initial viewport ${JSON.stringify(geometry.currentRow)}`,
      );
    }
    if (viewport.ubuntuWorkstation) {
      const detailIndex = geometry.childRegions.indexOf('detail');
      const hubIndex = geometry.childRegions.indexOf('hub');
      assert(
        geometry.desktopNavigation === 1 && geometry.compactNavigation === 0,
        `${viewport.name}: operator desktop navigation is not active ${JSON.stringify(geometry)}`,
      );
      assert(
        navigationState?.selectedSection === 'Переданы на склад',
        `${viewport.name}: workstation navigation is not operable ${JSON.stringify(navigationState)}`,
      );
      assert(
        detailIndex >= 0 && hubIndex >= 0 && hubIndex < detailIndex,
        `${viewport.name}: DOM order does not match list-first layout ${JSON.stringify(geometry.childRegions)}`,
      );
      assert(
        geometry.detail &&
          geometry.hub.x < geometry.detail.x &&
          geometry.hub.right <= geometry.detail.x + 2 &&
          geometry.hub.y < geometry.detail.bottom &&
          geometry.detail.y < geometry.hub.bottom,
        `${viewport.name}: list and processing panels are not side by side ${JSON.stringify({ detail: geometry.detail, hub: geometry.hub })}`,
      );
      assert(
        Object.values(geometry.scrollRoots).every(
          (scrollTop) => scrollTop === null || Math.abs(scrollTop) <= 1,
        ),
        `${viewport.name}: operator scroll roots were not reset ${JSON.stringify(geometry.scrollRoots)}`,
      );
      if (!viewport.allowVerticalScroll) {
        assert(
          geometry.currentActions.x >= -2 &&
            geometry.currentActions.right <= geometry.viewport.width + 2 &&
            geometry.currentActions.y >= -2 &&
            geometry.currentActions.bottom <= geometry.viewport.height + 2,
          `${viewport.name}: primary action is outside first fold ${JSON.stringify(geometry.currentActions)}`,
        );
      }
      assert(
        geometry.table && geometry.table.scrollWidth <= geometry.table.clientWidth + 1,
        `${viewport.name}: roll table overflows its container ${JSON.stringify(geometry.table)}`,
      );
      assertTextIsReadable(geometry.statusLabel, `${viewport.name}: status`);
      assertTextIsReadable(geometry.stepLabel, `${viewport.name}: step`);
      assertTextIsReadable(geometry.primaryActionLabel, `${viewport.name}: primary action`);
    } else if (geometry.viewport.width <= 1240) {
      const detailIndex = geometry.childRegions.indexOf('detail');
      const hubIndex = geometry.childRegions.indexOf('hub');
      assert(
        detailIndex >= 0 && hubIndex >= 0 && detailIndex < hubIndex,
        `${viewport.name}: selected detail is not before the roll hub ${JSON.stringify(geometry.childRegions)}`,
      );
    } else {
      assert(
        geometry.childRegions.indexOf('hub') < geometry.childRegions.indexOf('detail'),
        `${viewport.name}: desktop/mobile DOM order changed ${JSON.stringify(geometry.childRegions)}`,
      );
    }

    report.results.push({
      viewport: viewport.name,
      status: 'passed',
      screenshot,
      emptyScreenshot,
      navigationState,
      reweighFlowState,
      processingSurfaceState,
      stationaryScreenshot: stationaryProcessingPaneState ? stationaryScreenshot : null,
      stationaryProcessingPaneState,
      geometry,
    });
    await page.close();
  }

  await browser.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Operator rolls hub viewport check passed. Report: ${reportPath}`);
} catch (error) {
  await writeFile(reportPath, JSON.stringify({ ...report, error: String(error) }, null, 2));
  throw error;
} finally {
  server.kill('SIGTERM');
}
