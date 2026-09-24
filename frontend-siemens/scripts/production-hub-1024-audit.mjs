import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5238;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer(server, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Vite exited before ready.\n${logs.join('\n').slice(-2_000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/?role=production`);
      if (response.ok) return;
    } catch {
      // Keep polling until the bounded deadline.
    }
    await sleep(200);
  }
  throw new Error(`Vite did not start in time.\n${logs.join('\n').slice(-2_000)}`);
}

async function openProductionRollQueue(page) {
  await page.goto(`${baseUrl}/?role=production`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 7_000 });

  const candidates = page
    .locator('.section-nav-button, .role-top-nav-item, .mobile-section-nav-item')
    .filter({ hasText: 'Все рулоны' });
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) {
      await candidate.click();
      await page.locator('.production-roll-dispatch-table').waitFor({ state: 'visible' });
      return;
    }
  }
  throw new Error('Production section "Все рулоны" is not reachable');
}

const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    VITE_LIVE_CONTOURS: '',
    VITE_REQUIRE_AUTH: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
server.stdout.on('data', (chunk) => logs.push(String(chunk)));
server.stderr.on('data', (chunk) => logs.push(String(chunk)));

let browser;
try {
  await waitForServer(server, logs);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await openProductionRollQueue(page);

  const metrics = await page.locator('.production-roll-dispatch-table').evaluate((table) => ({
    clientWidth: table.clientWidth,
    scrollWidth: table.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
  const labelFontSizes = await page
    .locator('.production-roll-dispatch-row:not(.is-head) > span[data-label]')
    .evaluateAll((cells) =>
      cells.map((cell) => ({
        label: cell.getAttribute('data-label') ?? '',
        fontSize: Number.parseFloat(getComputedStyle(cell, '::before').fontSize),
      })),
    );

  if (metrics.scrollWidth > metrics.clientWidth) {
    throw new Error(
      `Production roll table overflows at 1024x768: ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );
  }
  if (metrics.documentScrollWidth > metrics.documentClientWidth) {
    throw new Error(
      `Production page overflows at 1024x768: ${metrics.documentScrollWidth} > ${metrics.documentClientWidth}`,
    );
  }
  const undersizedLabel = labelFontSizes.find(({ fontSize }) => fontSize < 13);
  if (undersizedLabel) {
    throw new Error(
      `Production roll label "${undersizedLabel.label}" is below 13px at 1024x768: ${undersizedLabel.fontSize}px`,
    );
  }

  console.log(
    `Production 1024x768 audit passed: table ${metrics.scrollWidth}/${metrics.clientWidth}, document ${metrics.documentScrollWidth}/${metrics.documentClientWidth}, labels >=13px`,
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
