import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5278;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'compact', width: 390, height: 844 },
];
const controlNames = [
  'Создать заявку',
  'Произвести на запас',
  'Актуальные',
  'Требуют действий',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Vite did not start in time');
}

async function readControlMetrics(page, name) {
  const control = page.getByRole('button', { name, exact: true }).first();
  await control.waitFor({ state: 'visible' });
  return control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: box.width,
      height: box.height,
      borderRadius: Number.parseFloat(style.borderRadius),
      clipsText:
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1,
    };
  });
}

async function readPanelHeaderMetrics(page) {
  const panelHeader = page.locator('.commercial-live-list-panel > .panel-header');
  await panelHeader.waitFor({ state: 'visible' });
  return panelHeader.evaluate((element) => {
    const title = element.firstElementChild;
    const firstTitleLine = title?.querySelector('.eyebrow');
    if (!(title instanceof HTMLElement) || !(firstTitleLine instanceof HTMLElement)) {
      throw new Error('Commercial panel title is missing');
    }

    const headerBox = element.getBoundingClientRect();
    const titleBox = firstTitleLine.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      cornerRadii: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ].map(Number.parseFloat),
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingRight: Number.parseFloat(style.paddingRight),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      paddingLeft: Number.parseFloat(style.paddingLeft),
      titleLeftInset: titleBox.left - headerBox.left,
    };
  });
}

function assertPanelHeaderMetrics(viewportName, section, metrics) {
  assert(
    metrics.cornerRadii.every((radius) => radius >= 20),
    `${viewportName}/${section}: panel header corners are too sharp: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.titleLeftInset >= 16,
    `${viewportName}/${section}: panel title left inset is too small: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.paddingTop >= 16 &&
      metrics.paddingRight >= 10 &&
      metrics.paddingBottom >= 16 &&
      metrics.paddingLeft >= 10,
    `${viewportName}/${section}: panel header padding is too small: ${JSON.stringify(metrics)}`,
  );
}

const server = spawn(
  viteBin,
  ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: process.cwd(),
    env: { ...process.env, VITE_LIVE_CONTOURS: 'commercial', VITE_REQUIRE_AUTH: 'off' },
    stdio: 'pipe',
    shell: false,
  },
);

let browser;

try {
  await waitForServer();
  browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(
      `${baseUrl}/?role=commercial&section=${encodeURIComponent('Входящие заявки')}`,
      { waitUntil: 'domcontentloaded' },
    );

    const actionGroup = page.locator('.commercial-live-create-actions');
    await actionGroup.waitFor({ state: 'visible' });
    const headerMetrics = await readPanelHeaderMetrics(page);
    const controls = Object.fromEntries(
      await Promise.all(
        controlNames.map(async (name) => [name, await readControlMetrics(page, name)]),
      ),
    );
    const reference = controls[controlNames[0]];

    assertPanelHeaderMetrics(viewport.name, 'Входящие заявки', headerMetrics);

    for (const [name, metrics] of Object.entries(controls)) {
      assert(
        Math.abs(metrics.width - reference.width) <= 0.5,
        `${viewport.name}: ${name} width ${metrics.width}px differs from ${reference.width}px`,
      );
      assert(
        Math.abs(metrics.height - reference.height) <= 0.5,
        `${viewport.name}: ${name} height ${metrics.height}px differs from ${reference.height}px`,
      );
      assert(
        metrics.borderRadius >= 8,
        `${viewport.name}: ${name} radius is only ${metrics.borderRadius}px`,
      );
      assert(!metrics.clipsText, `${viewport.name}: ${name} clips its label`);
    }

    for (const section of ['В работе', 'Выполненные']) {
      await page.goto(
        `${baseUrl}/?role=commercial&section=${encodeURIComponent(section)}`,
        { waitUntil: 'domcontentloaded' },
      );
      await page
        .locator('.commercial-live-list-panel > .panel-header h1')
        .filter({ hasText: section })
        .waitFor({ state: 'visible' });
      assertPanelHeaderMetrics(
        viewport.name,
        section,
        await readPanelHeaderMetrics(page),
      );
    }

    assert(
      pageErrors.length === 0,
      `${viewport.name}: browser errors: ${pageErrors.join('; ')}`,
    );
    await page.close();
  }

  console.log('Commercial action controls layout check passed.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
