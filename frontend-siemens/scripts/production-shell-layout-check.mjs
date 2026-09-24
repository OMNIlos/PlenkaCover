import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5199;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');
const evidenceDir = path.resolve('qa-screenshots/production-shell-layout-2026-07-22');
const viewports = [
  { name: '1920x1080', width: 1920, height: 1080, fixedShell: true },
  { name: '1366x768', width: 1366, height: 768, fixedShell: true },
  { name: '1024x768', width: 1024, height: 768, fixedShell: true },
  { name: '900x768', width: 900, height: 768, fixedShell: true },
  { name: '520x844', width: 520, height: 844, fixedShell: false },
];
const roles = [
  'commercial',
  'production',
  'finance',
  'director',
  'operator',
  'warehouse',
  'admin',
];
const panels = [
  { name: 'account', button: '.account-button', selector: '.floating-panel.account-panel' },
  {
    name: 'notifications',
    button: '.header-icon-button',
    selector: '.floating-panel.notification-panel',
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readShellMetrics(page, panelSelector) {
  return page.evaluate((selector) => {
    const rect = (candidate) => {
      const box = document.querySelector(candidate)?.getBoundingClientRect();
      return box
        ? {
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            left: box.left,
            width: box.width,
            height: box.height,
          }
        : null;
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      header: rect('.product-header'),
      shell: rect('.app-shell'),
      panel: rect(selector),
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    };
  }, panelSelector);
}

function assertPanelMetrics(label, metrics, fixedShell) {
  assert(metrics.header && metrics.shell && metrics.panel, `${label}: shell region missing`);
  const panelGap = metrics.panel.top - metrics.header.bottom;
  assert(panelGap >= 6 && panelGap <= 10, `${label}: panel gap is ${panelGap}px`);
  assert(
    metrics.panel.left >= -1 && metrics.panel.right <= metrics.viewport.width + 1,
    `${label}: panel escapes viewport ${JSON.stringify(metrics.panel)}`,
  );
  assert(
    metrics.documentWidth <= metrics.viewport.width + 1 &&
      metrics.bodyWidth <= metrics.viewport.width + 1,
    `${label}: horizontal overflow ${JSON.stringify(metrics)}`,
  );
  if (fixedShell) {
    assert(
      Math.abs(metrics.shell.bottom - metrics.viewport.height) <= 1,
      `${label}: shell leaves bottom gap ${JSON.stringify(metrics.shell)}`,
    );
  }
  return panelGap;
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Retry until Vite becomes available.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Vite did not start in time');
}

await mkdir(evidenceDir, { recursive: true });
const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(),
  env: { ...process.env, VITE_LIVE_CONTOURS: '', VITE_REQUIRE_AUTH: 'off' },
  stdio: 'pipe',
  shell: false,
});

const report = [];

try {
  await waitForServer();
  const browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    await page.goto(`${baseUrl}/?role=commercial`, { waitUntil: 'networkidle' });
    for (const panel of panels) {
      await page.locator(panel.button).click();
      const metrics = await readShellMetrics(page, panel.selector);
      const label = `commercial-${panel.name}-${viewport.name}`;
      const panelGap = assertPanelMetrics(label, metrics, viewport.fixedShell);
      const screenshot = path.join(evidenceDir, `${label}.png`);
      await page.screenshot({ path: screenshot });
      report.push({
        viewport: viewport.name,
        role: 'commercial',
        panel: panel.name,
        panelGap,
        metrics,
        screenshot,
      });
      await page.locator(panel.button).click();
    }
    await page.close();
  }

  for (const role of roles.filter((candidate) => candidate !== 'commercial')) {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
    });
    await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'networkidle' });
    for (const panel of panels) {
      await page.locator(panel.button).click();
      const metrics = await readShellMetrics(page, panel.selector);
      const label = `${role}-${panel.name}-1024x768`;
      const panelGap = assertPanelMetrics(label, metrics, false);
      report.push({ viewport: '1024x768', role, panel: panel.name, panelGap, metrics });
      await page.locator(panel.button).click();
    }
    await page.close();
  }

  const operatorPage = await browser.newPage({
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
  });
  await operatorPage.goto(
    `${baseUrl}/?role=operator&section=${encodeURIComponent('Рулоны и заказы')}`,
    { waitUntil: 'networkidle' },
  );
  await operatorPage.locator('ix-application').evaluate((application) => {
    const scrollRoot = application.shadowRoot?.querySelector('main.content');
    scrollRoot?.scrollTo({ top: 220, behavior: 'auto' });
  });
  await operatorPage.getByRole('button', { name: 'Смена', exact: true }).click();
  await operatorPage.locator('.operator-shift-page').waitFor();
  const operatorMetrics = await operatorPage.evaluate(() => {
    const application = document.querySelector('ix-application');
    const scrollRoot = application?.shadowRoot?.querySelector('main.content');
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box
        ? { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width }
        : null;
    };
    return {
      scrollTop: scrollRoot?.scrollTop ?? -1,
      shell: rect('.app-shell'),
      header: rect('.product-header'),
      navigation: rect('.operator-shift-page > .role-top-nav'),
      surface: rect('.operator-shift-surface'),
      listCount: document.querySelectorAll('.list-panel').length,
      summaryCount: document.querySelectorAll('.operator-shift-list-summary').length,
      shiftCount: document.querySelectorAll('.operator-shift-surface').length,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  assert(operatorMetrics.scrollTop === 0, `operator scroll was not reset: ${operatorMetrics.scrollTop}`);
  assert(operatorMetrics.shell?.left === 0, `operator shell keeps a false left gutter: ${JSON.stringify(operatorMetrics.shell)}`);
  assert(operatorMetrics.listCount === 0, 'operator Shift still renders a duplicate list panel');
  assert(operatorMetrics.summaryCount === 0, 'operator Shift still renders a duplicate summary');
  assert(operatorMetrics.shiftCount === 1, `operator Shift rendered ${operatorMetrics.shiftCount} surfaces`);
  assert(
    operatorMetrics.navigation &&
      operatorMetrics.surface &&
      operatorMetrics.surface.top >= operatorMetrics.navigation.bottom,
    `operator Shift regions overlap: ${JSON.stringify(operatorMetrics)}`,
  );
  assert(
    operatorMetrics.documentWidth <= operatorMetrics.viewportWidth + 1,
    `operator Shift overflows horizontally: ${JSON.stringify(operatorMetrics)}`,
  );
  const operatorScreenshot = path.join(evidenceDir, 'operator-shift-1024x768.png');
  await operatorPage.screenshot({ path: operatorScreenshot });
  report.push({ viewport: 'operator-1024x768', metrics: operatorMetrics, screenshot: operatorScreenshot });
  await operatorPage.close();

  await browser.close();
  await writeFile(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    `Production shell layout check passed. Report: ${path.join(evidenceDir, 'report.json')}`,
  );
} finally {
  server.kill('SIGTERM');
}
