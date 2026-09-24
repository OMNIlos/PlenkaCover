import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5246;
const baseUrl = `http://127.0.0.1:${port}`;
const harnessUrl = `${baseUrl}/scripts/fixtures/warehouse-hid-harness.html`;
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
        `Vite exited before the HID harness was ready.\n${logs.join('\n').slice(-2000)}`,
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
  throw new Error(`Vite did not start the HID harness.\n${logs.join('\n').slice(-2000)}`);
}

async function harnessSnapshot(page) {
  return page.evaluate(() => window.warehouseHidHarness.snapshot());
}

async function setOutcome(page, outcome) {
  await page.evaluate((nextOutcome) => {
    window.warehouseHidHarness.setOutcome(nextOutcome);
  }, outcome);
}

async function waitForSettledInput(page, expectedValue, submissionCount, alertExpected) {
  await page.waitForFunction(
    ({ alertExpected: shouldHaveAlert, expectedValue: value, submissionCount: count }) => {
      const input = document.querySelector('input[aria-label="Сканирование QR"]');
      const alert = document.querySelector('[role="alert"]');
      const snapshot = window.warehouseHidHarness.snapshot();
      return (
        input instanceof HTMLInputElement &&
        !input.disabled &&
        input.value === value &&
        document.activeElement === input &&
        snapshot.submissions.length === count &&
        (shouldHaveAlert
          ? alert?.textContent?.includes('Скан не отправлен') === true
          : alert === null)
      );
    },
    { alertExpected, expectedValue, submissionCount },
  );
}

async function submitOutcome(
  page,
  outcome,
  payload,
  expectedValue,
  alertExpected,
  trigger = 'enter',
) {
  const input = page.locator('input[aria-label="Сканирование QR"]');
  const before = await harnessSnapshot(page);
  await setOutcome(page, outcome);
  await input.fill(payload);
  if (trigger === 'button') {
    const submitButton = page.getByRole('button', { name: 'Принять QR' });
    await submitButton.focus();
    assert(
      await submitButton.evaluate((button) => document.activeElement === button),
      `${outcome}: submit button focus setup failed.`,
    );
    await submitButton.press('Enter');
  } else {
    await input.press('Enter');
  }
  await waitForSettledInput(page, expectedValue, before.submissions.length + 1, alertExpected);
  const after = await harnessSnapshot(page);
  assert(
    after.submissions.at(-1) === payload,
    `${outcome}: controlled submit received a different payload.`,
  );
  assert(
    after.unhandledRejections.length === 0,
    `${outcome}: unhandled rejection leaked: ${after.unhandledRejections.join(', ')}`,
  );
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
  const scannerInput = page.locator('input[aria-label="Сканирование QR"]');
  await scannerInput.waitFor({ state: 'visible' });
  assert(
    await page.evaluate(() => window.matchMedia('(pointer: fine)').matches),
    'Behavior harness must run with a fine pointer.',
  );

  const searchInput = page.getByPlaceholder('Поиск по операции, QR, статусу');
  await searchInput.focus();
  assert(
    await searchInput.evaluate((input) => document.activeElement === input),
    'Search focus setup failed.',
  );
  await page.locator('tbody tr[role="button"]').click();
  await page.locator('tbody tr.is-selected').waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'Сканирование QR',
  );

  await submitOutcome(page, 'false', 'QR-FALSE-0001', 'QR-FALSE-0001', true);
  await submitOutcome(page, 'reject', 'QR-REJECT-0002', 'QR-REJECT-0002', true, 'button');
  await submitOutcome(page, 'success', 'QR-SUCCESS-0003', '', false, 'button');

  await page.waitForTimeout(50);
  const finalSnapshot = await harnessSnapshot(page);
  assert(
    finalSnapshot.unhandledRejections.length === 0,
    `Unhandled rejections: ${finalSnapshot.unhandledRejections.join(', ')}`,
  );
  assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join(', ')}`);
  console.log('Warehouse HID behavior checks passed.');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
