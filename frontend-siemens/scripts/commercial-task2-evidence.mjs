import path from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function settleLayout(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
    );
  });
}

async function inspectQueue(page, viewportLabel, { desktop = false, mobile = false } = {}) {
  await settleLayout(page);
  const metrics = await page.evaluate(() => {
    const requireElement = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Task 2 evidence element is absent: ${selector}`);
      return element;
    };
    const round = (value) => Math.round(value * 100) / 100;
    const bounds = (element) => {
      const box = element.getBoundingClientRect();
      return {
        top: round(box.top),
        right: round(box.right),
        bottom: round(box.bottom),
        left: round(box.left),
        width: round(box.width),
        height: round(box.height),
      };
    };
    const rail = requireElement('.commercial-live-list-panel');
    const queue = requireElement('.commercial-live-queue');
    const detail = requireElement('.commercial-live-detail-panel');
    const rows = [...document.querySelectorAll('.commercial-live-order-row')];
    const rowOverflow = rows.map((row) => Math.max(0, row.scrollWidth - row.clientWidth));
    const contentOutside = rows.flatMap((row) => {
      const rowBox = row.getBoundingClientRect();
      return [...row.children].map((child) => {
        const childBox = child.getBoundingClientRect();
        return Math.max(0, rowBox.left - childBox.left, childBox.right - rowBox.right);
      });
    });

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      rail: bounds(rail),
      queue: bounds(queue),
      detail: bounds(detail),
      railOverflowPx: Math.max(0, rail.scrollWidth - rail.clientWidth),
      queueOverflowPx: Math.max(0, queue.scrollWidth - queue.clientWidth),
      maxRowOverflowPx: Math.max(0, ...rowOverflow),
      maxContentOutsideRowPx: round(Math.max(0, ...contentOutside)),
      rowCount: rows.length,
      selectedRowCount: rows.filter((row) => row.getAttribute('aria-pressed') === 'true').length,
    };
  });

  assert(metrics.rowCount > 0, `Commercial queue is empty at ${viewportLabel}`);
  assert(
    metrics.documentOverflowPx <= 1,
    `Commercial page overflows ${viewportLabel} by ${metrics.documentOverflowPx}px`,
  );
  assert(
    metrics.railOverflowPx <= 1 && metrics.queueOverflowPx <= 1,
    `Commercial rail content overflows ${viewportLabel}`,
  );
  assert(metrics.maxRowOverflowPx <= 1, `Commercial row overflows ${viewportLabel}`);
  assert(
    metrics.maxContentOutsideRowPx <= 1,
    `Commercial row content clips at ${viewportLabel}`,
  );
  assert(
    metrics.selectedRowCount === 1,
    `Commercial queue must expose one selected row at ${viewportLabel}`,
  );

  if (desktop) {
    assert(
      metrics.rail.width >= 304 && metrics.rail.width <= 340,
      `Commercial rail is ${metrics.rail.width}px at ${viewportLabel}; expected 304-340px`,
    );
  }

  if (mobile) {
    assert(
      metrics.rail.left >= -1 && metrics.rail.right <= metrics.viewport.width + 1,
      `Commercial mobile queue is outside the viewport at ${viewportLabel}`,
    );
    assert(
      metrics.detail.left >= -1 && metrics.detail.right <= metrics.viewport.width + 1,
      `Commercial mobile detail is outside the viewport at ${viewportLabel}`,
    );
    assert(
      metrics.rail.top < metrics.detail.top && metrics.rail.bottom <= metrics.detail.top + 2,
      `Commercial mobile queue/detail order is not operable at ${viewportLabel}`,
    );
  }

  return { label: viewportLabel, ...metrics };
}

export async function captureTask2Viewport(
  page,
  evidenceDir,
  { width, height, fileName, desktop, mobile },
) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const rail = document.querySelector('.commercial-live-list-panel');
    if (rail) rail.scrollTop = 0;
  });
  const label = `${width}x${height}`;
  const metrics = await inspectQueue(page, label, { desktop, mobile });
  const screenshot = path.join(evidenceDir, fileName);
  await page.screenshot({ path: screenshot });
  return { ...metrics, screenshot };
}

export async function exerciseTask2KeyboardFocus(page, evidenceDir, orderId) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sourceRow = page.locator(`[data-commercial-order-id="${orderId}"]`);
  await sourceRow.scrollIntoViewIfNeeded();
  await sourceRow.focus();
  const detailResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      /^\/api\/commercial\/orders\/[^/]+$/.test(url.pathname) &&
      response.request().method() === 'GET'
    );
  });
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((previousId) => {
    const active = document.activeElement;
    return (
      active instanceof HTMLElement &&
      active.dataset.commercialOrderId &&
      active.dataset.commercialOrderId !== previousId &&
      active.getAttribute('aria-pressed') === 'true'
    );
  }, orderId);
  const detailResponse = await detailResponsePromise;
  assert(
    detailResponse.status() === 200,
    `ArrowDown detail returned HTTP ${detailResponse.status()}`,
  );
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) throw new Error('No focused queue row');
    const style = getComputedStyle(active);
    return {
      orderId: active.dataset.commercialOrderId,
      selected: active.getAttribute('aria-pressed') === 'true',
      focusVisible: active.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
    };
  });
  assert(focus.orderId && focus.orderId !== orderId, 'ArrowDown did not move queue selection');
  assert(focus.selected, 'ArrowDown focus is not the selected queue row');
  assert(focus.focusVisible, 'Keyboard-selected queue row has no :focus-visible state');
  assert(
    focus.outlineStyle !== 'none' && Number.parseFloat(focus.outlineWidth) >= 2,
    `Keyboard focus outline is not visible: ${focus.outlineStyle} ${focus.outlineWidth}`,
  );
  const screenshot = path.join(evidenceDir, '01-keyboard-focus-1440x900.png');
  await page.screenshot({ path: screenshot });
  return { ...focus, screenshot };
}
