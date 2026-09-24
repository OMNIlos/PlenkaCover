import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const viteBin = path.resolve('node_modules/.bin/vite');
const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'plenka-recipe-editor-check-'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address === 'object', 'Could not reserve a loopback port.');
  const port = address.port;
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function startVite(port) {
  const logs = [];
  const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 80) logs.shift();
  };
  server.stdout.on('data', record);
  server.stderr.on('data', record);
  return { logs, server };
}

async function waitForVite(server, logs, harnessUrl) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `Vite exited before the recipe harness was ready.\n${logs.join('').slice(-4_000)}`,
      );
    }
    try {
      const response = await fetch(harnessUrl, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // Keep polling until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Vite did not start the recipe harness.\n${logs.join('').slice(-4_000)}`);
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

function signalProcessTree(server, signal) {
  if (server.pid && process.platform !== 'win32') {
    try {
      process.kill(-server.pid, signal);
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
    }
  }
  server.kill(signal);
}

async function stopVite(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  signalProcessTree(server, 'SIGTERM');
  if (await waitForExit(server, 2_500)) return;
  signalProcessTree(server, 'SIGKILL');
  if (!(await waitForExit(server, 2_500))) {
    throw new Error('Vite did not exit after SIGKILL.');
  }
}

function attachDiagnostics(page) {
  const diagnostics = {
    consoleErrors: [],
    failedRequests: [],
    httpErrors: [],
    pageErrors: [],
  };
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    diagnostics.failedRequests.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`,
    );
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      diagnostics.httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  return diagnostics;
}

function assertCleanDiagnostics(diagnostics) {
  for (const [kind, entries] of Object.entries(diagnostics)) {
    assert(entries.length === 0, `${kind}: ${entries.join(' | ')}`);
  }
}

async function openOuterAndRecipe(page) {
  if ((await page.getByRole('dialog', { name: 'Внешний диалог' }).count()) === 0) {
    const outerTrigger = page.getByTestId('outer-trigger');
    await outerTrigger.focus();
    await outerTrigger.click();
    await page.getByRole('dialog', { name: 'Внешний диалог' }).waitFor();
  }
  const recipeTrigger = page.getByTestId('recipe-trigger');
  await recipeTrigger.focus();
  await recipeTrigger.click();
  await page.getByRole('dialog', { name: 'Рецептура' }).waitFor();
  await page.waitForFunction(
    () => document.activeElement === document.querySelector('.recipe-editor-name input'),
  );
}

async function populateMaximumRecipe(page) {
  const editor = page.getByRole('dialog', { name: 'Рецептура' });
  await editor.locator('.recipe-editor-name input').fill('Рецептура максимальной загрузки');

  const rows = editor.locator('.recipe-editor-ingredient');
  const addProduct = editor.getByRole('button', {
    name: 'Добавить продукт +',
    exact: true,
  });
  for (let expected = 2; expected <= 50; expected += 1) {
    await addProduct.click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('[aria-label="Рецептура"] .recipe-editor-ingredient').length ===
        count,
      expected,
    );
  }
  assert((await rows.count()) === 50, 'Recipe editor did not reach the 50-row maximum.');

  assert(
    (await editor.getByRole('button', { name: 'Добавить +', exact: true }).count()) === 0,
    'Recipe editor must not expose inline raw-material creation.',
  );

  for (let index = 0; index < 50; index += 1) {
    const row = rows.nth(index);
    await row.locator('select').selectOption(`raw-material-${index + 1}`);
    await row.locator('input[inputmode="decimal"]').fill('2');
  }

  assert(
    (await rows.locator('input[type="text"]:not([inputmode="decimal"])').count()) === 0,
    'Recipe rows must only select existing catalog products.',
  );

  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Рецептура"] .recipe-editor-total')
      ?.textContent?.includes('Итого: 100%'),
  );
  assert(await addProduct.isDisabled(), 'The 51st ingredient action is not disabled.');
}

async function captureFormState(page) {
  return page.getByRole('dialog', { name: 'Рецептура' }).evaluate((editor) => ({
    name: editor.querySelector('.recipe-editor-name input')?.value ?? null,
    rows: Array.from(editor.querySelectorAll('.recipe-editor-ingredient')).map((row) => {
      const select = row.querySelector('select');
      const share = row.querySelector('input[inputmode="decimal"]');
      const newMaterial = Array.from(row.querySelectorAll('input[type="text"]')).find(
        (input) => input !== share,
      );
      return {
        source: select ? 'existing' : 'new',
        material: select?.value ?? newMaterial?.value ?? null,
        share: share?.value ?? null,
      };
    }),
  }));
}

async function readLayout(page) {
  return page.getByRole('dialog', { name: 'Рецептура' }).evaluate((editor) => {
    const body = editor.querySelector('.recipe-editor-body');
    const header = editor.querySelector('.recipe-editor-header');
    const footer = editor.querySelector('.recipe-editor-footer');
    const ingredient = editor.querySelector('.recipe-editor-ingredient');
    if (!body || !header || !footer || !ingredient) {
      throw new Error('Recipe editor layout nodes are missing.');
    }
    body.scrollTop = body.scrollHeight;
    const editorRect = editor.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const scrollRoots = [editor, ...editor.querySelectorAll('*')]
      .filter((element) => {
        const overflowY = getComputedStyle(element).overflowY;
        return (
          (overflowY === 'auto' || overflowY === 'scroll') &&
          element.scrollHeight > element.clientHeight
        );
      })
      .map((element) => element.className);

    return {
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      bodyNoHorizontalOverflow: body.scrollWidth <= body.clientWidth,
      bodyOverflowY: getComputedStyle(body).overflowY,
      documentNoHorizontalOverflow:
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
      editorClientHeight: editor.clientHeight,
      editorClientWidth: editor.clientWidth,
      editorNoHorizontalOverflow: editor.scrollWidth <= editor.clientWidth,
      footerVisible:
        footerRect.top >= editorRect.top &&
        footerRect.bottom <= editorRect.bottom &&
        footerRect.top >= 0 &&
        footerRect.bottom <= window.innerHeight,
      gridColumnCount: getComputedStyle(ingredient)
        .gridTemplateColumns.split(/\s+/u)
        .filter(Boolean).length,
      headerVisible:
        headerRect.top >= editorRect.top &&
        headerRect.bottom <= editorRect.bottom &&
        headerRect.top >= 0 &&
        headerRect.bottom <= window.innerHeight,
      scrollRoots,
      viewport: { height: window.innerHeight, width: window.innerWidth },
    };
  });
}

function assertDesktopLayout(layout) {
  assert(layout.viewport.width === 1024, 'Desktop viewport width drifted.');
  assert(layout.viewport.height === 768, 'Desktop viewport height drifted.');
  assert(
    layout.editorClientHeight <= 768 - 32,
    'Recipe editor exceeds the bounded viewport height.',
  );
  assert(layout.editorNoHorizontalOverflow, 'Recipe editor has horizontal overflow.');
  assert(layout.bodyScrollHeight > layout.bodyClientHeight, 'Recipe body does not scroll.');
  assert(layout.bodyNoHorizontalOverflow, 'Recipe body has horizontal overflow.');
  assert(layout.documentNoHorizontalOverflow, 'Document has horizontal overflow.');
  assert(layout.bodyOverflowY === 'auto', 'Recipe body is not the vertical scroll owner.');
  assert(layout.scrollRoots.length === 1, 'Recipe editor has competing scroll roots.');
  assert(
    String(layout.scrollRoots[0]).includes('recipe-editor-body'),
    'The recipe body is not the sole effective scroll root.',
  );
  assert(layout.headerVisible, 'Recipe header is not visible after body scroll.');
  assert(layout.footerVisible, 'Recipe footer is not visible after body scroll.');
  assert(layout.gridColumnCount === 3, 'Desktop ingredient row is not a three-column grid.');
}

function assertNarrowLayout(layout) {
  assert(layout.viewport.width <= 640, 'Narrow viewport exceeds the 640px contract.');
  assert(layout.editorNoHorizontalOverflow, 'Narrow recipe editor has horizontal overflow.');
  assert(layout.bodyNoHorizontalOverflow, 'Narrow recipe body has horizontal overflow.');
  assert(layout.documentNoHorizontalOverflow, 'Narrow document has horizontal overflow.');
  assert(layout.gridColumnCount === 1, 'Narrow ingredient row did not stack.');
  assert(layout.headerVisible, 'Narrow recipe header is outside the viewport.');
  assert(layout.footerVisible, 'Narrow recipe footer is outside the viewport.');
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const harnessUrl = `${baseUrl}/scripts/fixtures/recipe-editor-harness.html`;
const { logs, server } = startVite(port);
let browser;
const report = {
  evidenceDirectory,
  harnessUrl,
  narrow: null,
  workstation: null,
};

try {
  await waitForVite(server, logs, harnessUrl);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const diagnostics = attachDiagnostics(page);

  await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
  assert(
    (await page.title()) === 'Recipe editor responsive harness',
    'Recipe harness page identity is wrong.',
  );
  await page.getByTestId('outer-trigger').waitFor();

  await openOuterAndRecipe(page);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Рецептура' }).waitFor({ state: 'detached' });
  assert(
    await page.getByRole('dialog', { name: 'Внешний диалог' }).isVisible(),
    'First Escape closed the outer modal.',
  );
  assert(
    await page
      .getByTestId('recipe-trigger')
      .evaluate((trigger) => document.activeElement === trigger),
    'First Escape did not restore focus to the nested trigger.',
  );

  await openOuterAndRecipe(page);
  await populateMaximumRecipe(page);
  const stateBeforeFailure = await captureFormState(page);
  assert(stateBeforeFailure.rows.length === 50, 'Pre-save state lost ingredient rows.');

  report.workstation = await readLayout(page);
  assertDesktopLayout(report.workstation);
  await page.screenshot({
    path: path.join(evidenceDirectory, 'recipe-editor-1024x768.png'),
  });

  const saveButton = page.getByRole('button', {
    name: 'Сохранить рецептуру',
    exact: true,
  });
  await saveButton.focus();
  await page.keyboard.press('Tab');
  assert(
    await page
      .getByRole('dialog', { name: 'Рецептура' })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .evaluate((button) => document.activeElement === button),
    'Tab did not wrap from Save to the first nested-dialog action.',
  );
  await page.keyboard.press('Shift+Tab');
  assert(
    await saveButton.evaluate((button) => document.activeElement === button),
    'Shift+Tab did not wrap from the first action back to Save.',
  );

  const saveBox = await saveButton.boundingBox();
  assert(saveBox, 'Save button has no clickable bounding box.');
  await page.mouse.dblclick(saveBox.x + saveBox.width / 2, saveBox.y + saveBox.height / 2, {
    delay: 20,
  });
  await page.waitForFunction(() => window.recipeEditorHarness.snapshot().saveCalls.length === 1);
  await page.getByRole('alert').filter({ hasText: 'Не удалось сохранить рецептуру' }).waitFor();

  const rejectedSnapshot = await page.evaluate(() => window.recipeEditorHarness.snapshot());
  assert(
    rejectedSnapshot.saveCalls.length === 1,
    'Client double-click produced more than one save request.',
  );
  assert(rejectedSnapshot.created.length === 0, 'Rejected save created a recipe.');
  const stateAfterFailure = await captureFormState(page);
  assert(
    JSON.stringify(stateAfterFailure) === JSON.stringify(stateBeforeFailure),
    'Rejected save did not retain every recipe field.',
  );

  await saveButton.click();
  await page.getByRole('dialog', { name: 'Рецептура' }).waitFor({ state: 'detached' });
  const successfulSnapshot = await page.evaluate(() => window.recipeEditorHarness.snapshot());
  assert(successfulSnapshot.saveCalls.length === 2, 'Retry did not issue exactly one request.');
  assert(successfulSnapshot.created.length === 1, 'Retry did not create exactly one recipe.');
  assert(
    successfulSnapshot.saveCalls[1].ingredients.length === 50,
    'Successful retry did not submit all 50 ingredients.',
  );
  assert(
    successfulSnapshot.saveCalls[1].ingredients.reduce(
      (sum, ingredient) => sum + ingredient.shareBasisPoints,
      0,
    ) === 10_000,
    'Successful retry did not submit an exact 100% total.',
  );
  assert(
    successfulSnapshot.saveCalls[1].ingredients.filter(
      (ingredient) => ingredient.rawMaterialDefinitionId !== null,
    ).length === 50 &&
      successfulSnapshot.saveCalls[1].ingredients.filter(
        (ingredient) => ingredient.newMaterialName !== null,
      ).length === 0,
    'Successful retry did not preserve 50 existing catalog materials.',
  );
  assert(
    await page
      .getByTestId('recipe-trigger')
      .evaluate((trigger) => document.activeElement === trigger),
    'Successful save did not restore focus to the nested trigger.',
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await openOuterAndRecipe(page);
  const narrowEditor = page.getByRole('dialog', { name: 'Рецептура' });
  await narrowEditor.locator('.recipe-editor-ingredient select').selectOption('raw-material-1');
  const narrowAddProduct = narrowEditor.getByRole('button', {
    name: 'Добавить продукт +',
    exact: true,
  });
  for (let expected = 2; expected <= 9; expected += 1) {
    await narrowAddProduct.click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('[aria-label="Рецептура"] .recipe-editor-ingredient').length ===
        count,
      expected,
    );
  }
  report.narrow = await readLayout(page);
  assertNarrowLayout(report.narrow);
  await page.screenshot({
    path: path.join(evidenceDirectory, 'recipe-editor-390x844.png'),
  });

  assertCleanDiagnostics(diagnostics);
  await writeFile(
    path.join(evidenceDirectory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `Recipe editor checks passed at 1024x768 and 390x844. Evidence: ${evidenceDirectory}`,
  );
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    await stopVite(server);
  }
}
