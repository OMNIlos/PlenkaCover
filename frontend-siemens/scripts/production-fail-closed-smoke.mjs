import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const port = Number(process.env.PRODUCTION_FAIL_CLOSED_PORT ?? 5199);
const baseUrl = `http://127.0.0.1:${port}`;
const expiresAt = '2099-01-01T00:00:00.000Z';

const cases = [
  {
    role: 'operator',
    serverRole: 'operator',
    queryRole: 'operator',
    errorTitle: 'Задания оператора не загружены',
    forbidden: /R-A17-01|A-17|Напечатайте QR|Передайте рулон на склад/u,
  },
  {
    role: 'warehouse',
    serverRole: 'warehouse',
    queryRole: 'operator',
    errorTitle: 'Складская очередь не загружена',
    forbidden: /WH-2606-044|QR-R-A17-01|WH-INV-RAW|A-17/u,
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPortAvailable() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Production fail-closed port ${port} is already in use`));
    });
    socket.once('error', () => resolve());
  });
}

async function waitForPreview(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview exited before startup\n${child.output}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Retry until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite preview did not start at ${baseUrl}\n${child.output}`);
}

function stop(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

await assertPortAvailable();
const preview = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
preview.output = '';
const collect = (chunk) => {
  preview.output = `${preview.output}${chunk}`.slice(-8_000);
};
preview.stdout.on('data', collect);
preview.stderr.on('data', collect);

let browser;
try {
  await waitForPreview(preview);
  browser = await chromium.launch({ headless: true });

  for (const testCase of cases) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const session = {
      version: 1,
      token: `fail-closed-${testCase.role}-token`,
      role: testCase.role,
      serverRole: testCase.serverRole,
      userId: `fail-closed-${testCase.role}`,
      displayName: `Fail-closed ${testCase.role}`,
      expiresAt,
      passwordChangeRequired: false,
    };
    await context.addInitScript(
      ({ storedSession }) => {
        localStorage.setItem('plenki.auth.v1', JSON.stringify(storedSession));
      },
      { storedSession: session },
    );
    await context.route('**/api/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/auth/me') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            userId: session.userId,
            role: session.serverRole,
            capabilities: [],
            displayName: session.displayName,
            isActive: true,
            sessionPurpose: 'full',
            session: {
              id: `session-${testCase.role}`,
              purpose: 'full',
              state: 'active',
              createdAt: '2026-07-17T00:00:00.000Z',
              expiresAt,
              lastSeenAt: null,
            },
            workContext: { kind: 'office', assignment: null },
            passwordChangeRequired: false,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEST_API_DOWN', message: 'API unavailable for regression' }),
      });
    });

    const page = await context.newPage();
    await page.goto(`${baseUrl}/?role=${testCase.queryRole}`, { waitUntil: 'domcontentloaded' });
    const shell = page.locator(`.app-shell[data-active-role="${testCase.role}"]`);
    await shell.waitFor({ timeout: 15_000 });
    const unavailable = page.locator('.live-role-unavailable');
    await unavailable.getByText(testCase.errorTitle, { exact: true }).waitFor({ timeout: 15_000 });
    const text = await page.locator('body').innerText();

    assert(!testCase.forbidden.test(text), `${testCase.role} exposed a demo fixture during 503`);
    assert(
      (await page.locator('.operator-current-actions, .warehouse-command-actions').count()) === 0,
      `${testCase.role} exposed live mutation controls during 503`,
    );
    assert(
      new URL(page.url()).searchParams.get('object') === null,
      `${testCase.role} retained an object selection before a valid snapshot`,
    );
    assert(
      (await page.evaluate(() => document.documentElement.scrollWidth)) <=
        (await page.evaluate(() => document.documentElement.clientWidth)),
      `${testCase.role} unavailable state overflows the mobile viewport`,
    );

    await context.close();
  }

  console.log('PASS production live contours fail closed on API 503');
} finally {
  await browser?.close().catch(() => undefined);
  stop(preview);
}
