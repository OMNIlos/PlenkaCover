import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5247;
const baseUrl = `http://127.0.0.1:${port}`;
const harnessUrl = `${baseUrl}/scripts/fixtures/plenki-modal-focus-harness.html`;
const viteBin = path.resolve('node_modules/.bin/vite');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer() {
  const logs = [];
  const server = spawn(
    viteBin,
    ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { logs, server };
}

async function waitForServer(server, logs) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `Vite exited before the modal harness was ready.\n${logs.join('\n').slice(-2000)}`,
      );
    }
    try {
      const response = await fetch(harnessUrl);
      if (response.ok) return;
    } catch {
      // Retry until the isolated harness is reachable.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Vite did not start the modal harness.\n${logs.join('\n').slice(-2000)}`);
}

async function activeTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

async function openModal(
  page,
  scenario = 'usable-autofocus',
  expectedSelector = '[data-testid="modal-autofocus"]',
) {
  await page.evaluate((nextScenario) => {
    window.plenkiModalFocusHarness.setScenario(nextScenario);
  }, scenario);
  const trigger = page.getByTestId('modal-trigger');
  await trigger.focus();
  await trigger.click();
  await page.getByRole('dialog', { name: 'Проверка фокуса' }).waitFor();
  await page.waitForFunction(
    (selector) => document.activeElement?.matches(selector) === true,
    expectedSelector,
  );
  assert(
    await page.locator(expectedSelector).evaluate((element) => document.activeElement === element),
    `${scenario}: modal selected the wrong initial focus target.`,
  );
}

async function assertTriggerRestored(page, closeLabel) {
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert(
    (await activeTestId(page)) === 'modal-trigger',
    `${closeLabel}: focus was not restored to the opening trigger.`,
  );
}

async function waitForExit(server, timeoutMs) {
  if (server.exitCode !== null || server.signalCode !== null) return true;
  let timeout;
  try {
    return await Promise.race([
      once(server, 'exit').then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  if (await waitForExit(server, 2_000)) return;
  server.kill('SIGKILL');
  if (!(await waitForExit(server, 2_000))) {
    throw new Error('Vite did not exit after SIGKILL.');
  }
}

const { logs, server } = startServer();
let browser;

try {
  await waitForServer(server, logs);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.setDefaultTimeout(7_500);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(harnessUrl, { waitUntil: 'networkidle' });

  await openModal(page);
  const dialogBox = await page.getByRole('dialog', { name: 'Проверка фокуса' }).boundingBox();
  assert(dialogBox, 'Modal dialog has no rendered bounds.');
  const dialogOwnsLeftCenterPoint = await page.evaluate(({ x, y }) => {
    const dialog = document.querySelector('[role="dialog"]');
    const topElement = document.elementFromPoint(x, y);
    return Boolean(dialog && topElement && dialog.contains(topElement));
  }, {
    x: dialogBox.x + 8,
    y: dialogBox.y + dialogBox.height / 2,
  });
  assert(
    dialogOwnsLeftCenterPoint,
    'A sibling stacking context painted above the modal overlay.',
  );
  await page.getByTestId('modal-last').focus();
  await page.keyboard.press('Tab');
  assert(
    await page.getByRole('button', { name: 'Закрыть' }).evaluate(
      (button) => document.activeElement === button,
    ),
    'Tab did not wrap from the last modal control to the first.',
  );
  await page.keyboard.press('Shift+Tab');
  assert(
    (await activeTestId(page)) === 'modal-last',
    'Shift+Tab did not wrap from the first modal control to the last.',
  );

  await page.getByTestId('modal-autofocus').focus();
  await page.keyboard.press('Escape');
  await assertTriggerRestored(page, 'Escape');
  const escapeSnapshot = await page.evaluate(() => window.plenkiModalFocusHarness.snapshot());
  assert(escapeSnapshot.escapeEvents.length === 1, 'Escape did not reach the modal key lifecycle.');
  assert(
    escapeSnapshot.escapeEvents[0].defaultPrevented,
    'Escape leaked without preventDefault().',
  );

  for (const scenario of [
    'hidden-autofocus',
    'disabled-autofocus',
    'non-focusable-autofocus',
  ]) {
    await openModal(page, scenario, 'button[aria-label="Закрыть"]');
    await page.getByRole('button', { name: 'Закрыть' }).click();
    await assertTriggerRestored(page, scenario);
  }

  await openModal(page, 'contenteditable-last');
  await page.getByTestId('modal-contenteditable-last').focus();
  await page.keyboard.press('Tab');
  assert(
    await page.getByRole('button', { name: 'Закрыть' }).evaluate(
      (button) => document.activeElement === button,
    ),
    'Tab did not wrap from the last contenteditable control to the first modal control.',
  );
  await page.keyboard.press('Escape');
  await assertTriggerRestored(page, 'Contenteditable Escape');

  await openModal(page);
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await assertTriggerRestored(page, 'Close button');

  await openModal(page);
  await page.locator('.plenki-overlay').click({ position: { x: 4, y: 4 } });
  await assertTriggerRestored(page, 'Backdrop');

  assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join(', ')}`);
  console.log('Plenki modal focus lifecycle checks passed.');
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    await stopServer(server);
  }
}
