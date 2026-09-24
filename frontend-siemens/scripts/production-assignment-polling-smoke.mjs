import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = Number(process.env.ASSIGNMENT_POLLING_PORT ?? 5298);
const base = `http://127.0.0.1:${port}`;
const vite = spawn(
  process.execPath,
  [
    './node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, VITE_REQUIRE_AUTH: 'off', VITE_LIVE_CONTOURS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let viteOutput = '';
const collect = (chunk) => {
  viteOutput = `${viteOutput}${chunk}`.slice(-8_000);
};
vite.stdout.on('data', collect);
vite.stderr.on('data', collect);

async function waitForVite() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early.\n${viteOutput}`);
    try {
      const response = await fetch(`${base}/scripts/production-assignment-polling-harness.html`);
      if (response.ok) return;
    } catch {
      // Retry within the bounded startup window.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start.\n${viteOutput}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

let browser;
try {
  await waitForVite();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.setDefaultTimeout(3_000);
  await page.goto(`${base}/scripts/production-assignment-polling-harness.html`, {
    waitUntil: 'networkidle',
  });

  const rollOperator = page.getByLabel('Оператор для рулона A-9-roll-new');
  await rollOperator.selectOption('operator-b');
  await page.getByRole('button', { name: /Сервер обновил рулоны/ }).click();
  assertEqual(
    await rollOperator.inputValue(),
    'operator-b',
    'A fresh polling array overwrote the dirty roll operator',
  );

  const orderOperator = page.getByLabel('Оператор для рулона A-9-roll-order');
  const orderCheckbox = page.getByLabel('Выбрать рулон A-9-roll-order');
  await orderCheckbox.check();
  await orderOperator.selectOption('operator-b');
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Оператор для рулона A-9-roll-order"]')?.disabled ===
      true,
  );
  assertEqual(
    await orderOperator.isDisabled(),
    true,
    'A second operator choice was not locked while the first assignment was in flight',
  );
  assertEqual(
    await orderCheckbox.isDisabled(),
    true,
    'A pending immediate row remained selectable for a parallel bulk mutation',
  );
  const bulkBar = page.locator('.production-roll-selection-bar');
  const bulkCommit = bulkBar.getByRole('button', { name: 'Записать' });
  assertEqual(
    await bulkCommit.isDisabled(),
    true,
    'Bulk commit remained enabled for a selected pending row',
  );
  await bulkCommit.evaluate((button) => {
    button.disabled = false;
    button.click();
  });
  assertEqual(
    await page.getByText(/Пакетных назначений:/).textContent(),
    'Пакетных назначений: 0',
    'commitBulkAssign bypassed the pending-row guard',
  );
  await page.getByRole('button', { name: 'Сервер назначил C' }).click();
  await page.getByRole('button', { name: 'Отклонить назначение' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Оператор для рулона A-9-roll-order"]')?.disabled ===
      false,
  );
  assertEqual(
    await orderOperator.inputValue(),
    'operator-c',
    'A rejected B assignment overwrote the newer external C value',
  );
  assertEqual(
    await page.getByText(/Попыток назначения:/).textContent(),
    'Попыток назначения: 1',
    'The rejected assignment was not sent exactly once',
  );
  await page.getByRole('button', { name: 'Сервер вернул A' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Оператор для рулона A-9-roll-order"]')?.value ===
      '',
  );
  await orderOperator.selectOption('operator-b');
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Оператор для рулона A-9-roll-order"]')?.disabled ===
      true,
  );
  await page.getByRole('button', { name: 'Подтвердить без обновления' }).click();
  await page.waitForFunction(() => {
    const select = document.querySelector(
      'select[aria-label="Оператор для рулона A-9-roll-order"]',
    );
    return select?.value === 'operator-b' && select.disabled === false;
  });
  await orderOperator.selectOption('');
  await page.waitForTimeout(50);
  assertEqual(
    await orderOperator.inputValue(),
    'operator-b',
    'The unsupported “Не назначен” choice replaced a recorded assignment',
  );
  assertEqual(
    await page.getByText(/Попыток назначения:/).textContent(),
    'Попыток назначения: 2',
    'The unsupported unassign choice called the assignment API',
  );

  const machine = page.getByLabel('Станок смены для Анна Соколова');
  await machine.selectOption('post-2');
  await page.getByRole('button', { name: /Сервер обновил план/ }).click();
  assertEqual(
    await machine.inputValue(),
    'post-2',
    'A fresh planning view overwrote the dirty operator post',
  );
  await page.getByRole('button', { name: 'Открыть другую смену' }).click();
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="Станок смены для Анна Соколова"]')?.value === '',
  );
  assertEqual(await machine.inputValue(), '', 'A dirty post choice leaked into another shift');
  assertEqual(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'The assignment harness overflows the 1024px viewport',
  );

  console.log('OK production assignments survive polling without leaking across shifts');
} finally {
  await browser?.close();
  if (vite.exitCode === null) vite.kill('SIGTERM');
}
