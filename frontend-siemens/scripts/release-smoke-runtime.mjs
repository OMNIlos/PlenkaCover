import { spawn } from 'node:child_process';
import net from 'node:net';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function assertOwnedServerAlive(server, serverLogs, context = 'Vite') {
  if (server.exitCode === null && server.signalCode === null) return;
  const tail = serverLogs.join('').slice(-2000);
  throw new Error(
    `${context}: own Vite child exited ` +
      `(code=${server.exitCode}, signal=${server.signalCode}).\n${tail}`,
  );
}

async function availablePort(host) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, host, resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error('Could not allocate an isolated Vite port');
  return port;
}

export async function startOwnedVite({
  viteBin,
  cwd,
  env,
  mode,
  host = '127.0.0.1',
  timeoutMs = 25_000,
}) {
  const port = await availablePort(host);
  const baseUrl = `http://${host}:${port}`;
  const args = ['--host', host, '--port', String(port), '--strictPort'];
  if (mode) args.push('--mode', mode);
  const server = spawn(viteBin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLogs = [];
  server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      assertOwnedServerAlive(server, serverLogs, 'Vite readiness');
      const ownedUrlWasAnnounced = serverLogs.join('').includes(`${baseUrl}/`);
      if (ownedUrlWasAnnounced) {
        try {
          const response = await fetch(`${baseUrl}/`);
          assertOwnedServerAlive(server, serverLogs, 'Vite readiness');
          if (response.ok) {
            return {
              baseUrl,
              port,
              server,
              serverLogs,
              assertAlive(context = 'release smoke') {
                assertOwnedServerAlive(server, serverLogs, context);
              },
            };
          }
        } catch (error) {
          assertOwnedServerAlive(server, serverLogs, 'Vite readiness');
          if (!(error instanceof TypeError)) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    server.kill('SIGTERM');
    throw error;
  }
  server.kill('SIGTERM');
  throw new Error(`Vite did not start on its isolated port.\n${serverLogs.join('').slice(-2000)}`);
}

export function installPageFailureTracker(page) {
  const tracker = { apiFailures: [], pageErrors: [] };
  page.on('response', (response) => {
    const url = response.url();
    if (!new URL(url).pathname.startsWith('/api/') || response.ok()) return;
    tracker.apiFailures.push({
      method: response.request().method(),
      status: response.status(),
      statusText: response.statusText(),
      url,
    });
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!new URL(url).pathname.startsWith('/api/')) return;
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
    tracker.apiFailures.push({
      method: request.method(),
      status: 0,
      statusText: request.failure()?.errorText ?? 'request failed',
      url,
    });
  });
  page.on('pageerror', (error) => tracker.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') tracker.pageErrors.push(message.text());
  });
  return tracker;
}

export async function collectVisibleErrors(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .filter(visible)
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim());
    const technicalError = new RegExp(
      'Ошибка\\s+(?:4|5)\\d\\d|Bad Gateway|Unhandled .+ route|Failed to fetch|' +
        'NetworkError|Не удалось (?:загрузить|получить|обновить)',
      'iu',
    );
    const bodyLines = (document.body.innerText ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => technicalError.test(line));
    return [...new Set([...alerts, ...bodyLines].filter(Boolean))];
  });
}

export function assertSmokeHealthy(tracker, visibleErrors, context) {
  const apiFailures = tracker.apiFailures.map(
    (failure) =>
      `${failure.method} ${failure.status} ${failure.statusText} ${new URL(failure.url).pathname}`,
  );
  const runtimeErrors = unique(tracker.pageErrors);
  if (apiFailures.length > 0) {
    throw new Error(`${context}: non-2xx/unhandled API requests: ${apiFailures.join(' | ')}`);
  }
  if (runtimeErrors.length > 0) {
    throw new Error(`${context}: browser runtime errors: ${runtimeErrors.join(' | ')}`);
  }
  if (visibleErrors.length > 0) {
    throw new Error(`${context}: visible errors: ${unique(visibleErrors).join(' | ')}`);
  }
}

export function assertDirectorControlState(state, context) {
  if (state.alertTexts.length > 0) {
    throw new Error(`${context}: visible errors: ${state.alertTexts.join(' | ')}`);
  }
  const expectedMetrics = ['Выставлено', 'Оплачено', 'Произведено'];
  const missingMetrics = expectedMetrics.filter((label) => !state.metricLabels.includes(label));
  if (!state.workspaceVisible || !state.contentVisible || missingMetrics.length > 0) {
    throw new Error(
      `${context}: director Control did not load concrete metrics (${missingMetrics.join(', ')})`,
    );
  }
}

export function assertFinancePositiveDefaultState(state, context) {
  const problems = [];
  if (state.activeSection !== 'Счета') problems.push('active invoices are not proven');
  if (!state.registryVisible) problems.push('healthy invoice registry is not visible');
  if (state.explicitObject || state.selectedDetails > 0) {
    problems.push('selected detail/exception exists before explicit selection');
  }
  if (state.visibleAlerts.length > 0) {
    problems.push(`visible alerts: ${state.visibleAlerts.join(' | ')}`);
  }
  if (problems.length > 0) {
    throw new Error(`${context}: ${problems.join('; ')} (${JSON.stringify(state)})`);
  }
}
