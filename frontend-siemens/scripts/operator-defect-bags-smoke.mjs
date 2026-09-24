import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:5297';
const out = 'qa-screenshots/multiple-defect-bags-2026-09-11';
const vite = spawn(
  process.execPath,
  ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5297', '--strictPort'],
  {
    env: { ...process.env, VITE_LIVE_CONTOURS: 'operator', VITE_REQUIRE_AUTH: 'on' },
    stdio: 'ignore',
  },
);
let browser;
let page;
const bags = [];
const commands = new Map();
const weighRequests = [];
const printRequests = [];
const pageErrors = [];
let loseFirstResponse = true;
const now = new Date().toISOString();
const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
const session = {
  version: 1,
  token: 'local-smoke-token',
  role: 'operator',
  serverRole: 'operator',
  userId: 'smoke-operator',
  displayName: 'Оператор проверки',
  expiresAt,
  passwordChangeRequired: false,
};
const me = {
  userId: session.userId,
  role: 'operator',
  displayName: session.displayName,
  capabilities: [],
  isActive: true,
  sessionPurpose: 'full',
  session: {
    id: 'smoke-session',
    purpose: 'full',
    state: 'active',
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
  },
  workContext: {
    kind: 'operator_post',
    assignment: { workplace: 'POST-1', shift: 'Смена проверки' },
  },
  passwordChangeRequired: false,
};

try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* bounded startup retry */
    }
    if (attempt >= 60) throw new Error('Vite did not start in 15 seconds');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await mkdir(out, { recursive: true });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(
    (value) => localStorage.setItem('plenki.auth.v1', JSON.stringify(value)),
    session,
  );
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/api/auth/me') return json(me);
    if (pathname.endsWith('/notifications'))
      return json({ items: [], nextCursor: null, unreadCount: 0 });
    if (pathname === '/api/operator/runtime')
      return json({
        generatedAt: now,
        orders: [],
        shift: {
          id: 'smoke-shift',
          status: 'close_pending',
          operatorName: session.displayName,
          workplace: 'POST-1',
          bags: [],
          defectBags: bags,
          defectBag: bags[0],
          balance: {
            producedKg: 0,
            defectKg: 0,
            expectedUsageKg: 0,
            actualUsageKg: 0,
            deviationPercent: 0,
            status: 'ok',
          },
        },
      });
    if (pathname === '/api/operator/machine-changes/current') return json(null);
    if (pathname.endsWith('/defect-bag/weigh')) {
      const data = route.request().postDataJSON();
      weighRequests.push(data);
      const previous = commands.get(data.operationKey);
      if (previous) {
        if (previous.weightKg !== data.weightKg || previous.defectType !== data.defectType) {
          return json(
            {
              code: 'DEFECT_BAG_OPERATION_KEY_REUSED',
              message: 'UUID операции уже использован для другого запроса.',
            },
            409,
          );
        }
        return json(previous);
      }
      const bag = {
        id: `smoke-bag-${bags.length + 1}`,
        code: `DEF-20260911-POST-1-00000${bags.length + 1}`,
        status: 'weighed',
        defectType: data.defectType,
        weightKg: data.weightKg,
        recordedDefectKg: 0,
        differenceKg: data.weightKg,
        labelState: 'not_printed',
        weighedAt: now,
      };
      bags.push(bag);
      commands.set(data.operationKey, bag);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        return route.abort('failed');
      }
      return json(bag);
    }
    if (pathname.endsWith('/defect-bag/print')) {
      const data = route.request().postDataJSON();
      printRequests.push(data);
      const bag = bags.find(({ id }) => id === data.defectBagId);
      assert(bag, 'Print must target a specific bag');
      Object.assign(bag, { status: 'ready_for_warehouse', labelState: 'submitted' });
      return json(bag);
    }
    return json([]);
  });
  await page.goto(`${base}/?role=operator&section=${encodeURIComponent('Смена')}`, {
    waitUntil: 'domcontentloaded',
  });
  const weight = page.getByRole('spinbutton', { name: 'Вес мешка брака, кг', exact: true });
  const save = page.getByRole('button', { name: 'Зафиксировать вес мешка брака', exact: true });
  const add = page.getByRole('button', { name: 'Добавить биг-бег брака', exact: true });
  await weight.waitFor();
  await page.getByRole('button', { name: 'Тип брака: Вторичка', exact: true }).click();
  await weight.fill('12.4');
  await save.click();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Зафиксировать вес мешка брака"]')?.disabled,
  );
  assert.equal(bags.length, 1);
  // Same draft, changed payload and repeated terminal conflicts must never create a second bag.
  await weight.fill('15');
  for (let attempt = 0; attempt < 2; attempt++) {
    await save.click();
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Зафиксировать вес мешка брака"]')?.disabled,
    );
  }
  assert.equal(bags.length, 1);
  assert.equal(new Set(weighRequests.map(({ operationKey }) => operationKey)).size, 1);
  await weight.fill('12.4');
  await save.click();
  await weight.waitFor({ state: 'detached' });
  await add.click();
  await page.getByRole('button', { name: 'Тип брака: Вторичка', exact: true }).click();
  await weight.fill('12.4');
  await save.click();
  await weight.waitFor({ state: 'detached' });
  assert.equal(bags.length, 2);
  assert.equal(new Set(weighRequests.map(({ operationKey }) => operationKey)).size, 2);
  await page
    .getByRole('button', { name: `Напечатать QR мешка ${bags[1].code}`, exact: true })
    .click();
  await add.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Добавить биг-бег брака"]')?.disabled,
  );
  assert.equal(printRequests.at(-1).defectBagId, bags[1].id);
  assert.equal(bags[0].status, 'weighed');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(bags[1].code, { exact: true }).waitFor();
  await add.click();
  await page.getByRole('button', { name: 'Тип брака: Айка', exact: true }).click();
  await weight.fill('7.5');
  await save.click();
  await weight.waitFor({ state: 'detached' });
  // Exercise saved failed/unknown states and an unfinished fourth draft at all target widths.
  bags[0].labelState = 'failed';
  bags[2].labelState = 'delivery_unknown';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Исход печати неизвестен. Обратитесь к администратору.').waitFor();
  await add.click();
  for (const width of [1440, 1366, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const panel = page.locator('.defect-bags-panel');
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await panel.locator('.defect-bag-handoff').count(), 4);
    const layout = await panel.evaluate((element) => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      buttons: [...element.querySelectorAll('button')].map(
        (button) => button.getBoundingClientRect().height,
      ),
    }));
    assert.equal(layout.overflow, false, `Horizontal overflow at ${width}`);
    assert(
      layout.buttons.every((height) => height >= 44),
      `Small touch target at ${width}`,
    );
    await page.screenshot({ path: `${out}/${width}.png`, fullPage: true });
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        bags: bags.length,
        requests: weighRequests.length,
        distinctWeighKeys: new Set(weighRequests.map(({ operationKey }) => operationKey)).size,
        targetedPrint: true,
        reload: true,
        viewports: [1440, 1366, 390],
        pageErrors,
      },
      null,
      2,
    ),
  );
  console.log(`PASS: multiple bags, lost response, targeted print, reload, 3 viewports. ${out}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${out}/failure.png`, fullPage: true });
    console.error((await page.locator('body').innerText()).slice(0, 3000), pageErrors);
  }
  throw error;
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
