import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const requiredProjects = ['coverage-v2-1024x768', 'coverage-v2-1440x900'];
const requiredCases = [
  'accept-v1-unchanged keeps the legacy proposal and approval flow',
  'accept-unavailable-production exposes only the atomic production route',
  'accept-unknown-recheck resolves a real warehouse case into a fresh generation',
  'accept-full-recovery releases reserve and opens the decision-linked recovery',
];
const expectedCaseCount = requiredProjects.length * requiredCases.length;
const frontendDir = fileURLToPath(new URL('..', import.meta.url));
const playwrightCli = path.join(frontendDir, 'node_modules/playwright/cli.js');
const backendFixturePath = 'apps/api/test/warehouse-coverage-v2-acceptance.e2e-spec.ts';

export function assertExpectedCoverageCases(output) {
  const total = Number(output.match(/Total:\s+(\d+)\s+tests?/u)?.[1] ?? Number.NaN);
  const wrongCases = requiredCases.filter(
    (name) => output.split(name).length - 1 !== requiredProjects.length,
  );
  if (total !== expectedCaseCount || wrongCases.length > 0) {
    throw new Error(
      `Coverage V2 release gate expected ${expectedCaseCount} Playwright cases ` +
        `(${requiredCases.length} flows × ${requiredProjects.length} viewports), got ` +
        `${Number.isFinite(total) ? total : 'an unreadable list'}.`,
    );
  }
}

export function assertDistinctPorts(ports) {
  if (
    ports.some((port) => !Number.isSafeInteger(port) || port < 1_024 || port > 65_535) ||
    new Set(ports).size !== ports.length
  ) {
    throw new Error('Coverage V2 API and frontend ports must be unique unprivileged TCP ports.');
  }
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed with ${result.status}.`);
  }
  return result;
}

function candidateBackendDirs() {
  const candidates = [];
  if (process.env.COVERAGE_V2_BACKEND_DIR) {
    candidates.push(path.resolve(process.env.COVERAGE_V2_BACKEND_DIR));
  }

  const frontendCheckout = path.dirname(frontendDir);
  if (frontendCheckout.split(path.sep).includes('.worktrees')) {
    const backendRoot = path.resolve(frontendDir, '..', '..', '..', '..');
    candidates.push(path.join(backendRoot, '.worktrees', path.basename(frontendCheckout)));
    candidates.push(backendRoot);
  } else {
    candidates.push(path.resolve(frontendDir, '..', '..'));
  }
  return [...new Set(candidates)];
}

function resolveBackendDir() {
  const backendDir = candidateBackendDirs().find(
    (candidate) =>
      existsSync(path.join(candidate, 'package.json')) &&
      existsSync(path.join(candidate, backendFixturePath)),
  );
  if (!backendDir) {
    throw new Error(
      `Coverage V2 release gate requires a backend checkout containing ${backendFixturePath}. ` +
        'Set COVERAGE_V2_BACKEND_DIR explicitly when frontend and backend worktrees differ.',
    );
  }
  return backendDir;
}

async function allocatePort(excluded) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close((error) => {
          if (error) reject(error);
          else if (address && typeof address === 'object') resolve(address.port);
          else reject(new Error('Unable to allocate a loopback port.'));
        });
      });
    });
    if (!excluded.has(port)) return port;
  }
  throw new Error('Unable to allocate four distinct loopback ports.');
}

async function allocatePorts(count) {
  const selected = new Set();
  while (selected.size < count) selected.add(await allocatePort(selected));
  const ports = [...selected];
  assertDistinctPorts(ports);
  return ports;
}

function createDatabaseUrl() {
  const url = new URL(
    process.env.COVERAGE_V2_DATABASE_URL ??
      'postgresql://plenka:plenka@127.0.0.1:5433/plenka',
  );
  const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !localHost ||
    url.port !== '5433' ||
    url.pathname !== '/plenka'
  ) {
    throw new Error(
      'Coverage V2 release gate accepts only localhost:5433/plenka for disposable schemas.',
    );
  }
  url.searchParams.set(
    'schema',
    `coverage_v2_acceptance_${process.pid}_${randomBytes(6).toString('hex')}`,
  );
  return url.toString();
}

function profileDatabaseUrls(baseUrl) {
  return ['1024x768', '1440x900'].map((suffix) => {
    const url = new URL(baseUrl);
    url.searchParams.set('schema', `${url.searchParams.get('schema')}_${suffix}`);
    return url.toString();
  });
}

function cleanupSchemas(backendDir, databaseUrls) {
  const cleanupProgram = `
const { PrismaClient } = require('@prisma/client');
const urls = process.argv.slice(1);
(async () => {
  for (const rawUrl of urls) {
    const url = new URL(rawUrl);
    const schema = url.searchParams.get('schema') || '';
    if (
      !/^coverage_v2_acceptance_[a-z0-9_]+_(?:1024x768|1440x900)$/.test(schema) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.port !== '5433' ||
      url.pathname !== '/plenka'
    ) {
      throw new Error('Refusing to drop a non-disposable Coverage V2 schema');
    }
    url.searchParams.set('schema', 'public');
    const prisma = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    } finally {
      await prisma.$disconnect();
    }
  }
})().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\\n');
  process.exitCode = 1;
});`;
  runChecked(process.execPath, ['-e', cleanupProgram, ...databaseUrls], {
    cwd: backendDir,
    env: process.env,
    stdio: 'inherit',
  });
}

async function runReleaseGate() {
  const backendDir = resolveBackendDir();
  const [api1024, web1024, api1440, web1440] = await allocatePorts(4);
  const databaseUrl = createDatabaseUrl();
  const databaseUrls = profileDatabaseUrls(databaseUrl);
  const gateEnv = {
    ...process.env,
    COVERAGE_V2_ACCEPTANCE_PASSWORD: randomBytes(32).toString('base64url'),
    COVERAGE_V2_BACKEND_DIR: backendDir,
    COVERAGE_V2_DATABASE_URL: databaseUrl,
    COVERAGE_V2_API_PORT_1024: String(api1024),
    COVERAGE_V2_WEB_PORT_1024: String(web1024),
    COVERAGE_V2_API_PORT_1440: String(api1440),
    COVERAGE_V2_WEB_PORT_1440: String(web1440),
    FORCE_COLOR: '0',
  };

  runChecked('npm', ['run', 'build', '-w', '@plenka/contracts'], {
    cwd: backendDir,
    env: gateEnv,
    stdio: 'inherit',
  });
  runChecked('npm', ['run', 'db:generate'], {
    cwd: backendDir,
    env: gateEnv,
    stdio: 'inherit',
  });

  const listResult = runChecked(
    process.execPath,
    [playwrightCli, 'test', '--config', 'playwright.coverage-v2.config.ts', '--list'],
    {
      cwd: frontendDir,
      env: gateEnv,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  process.stdout.write(listResult.stdout);
  process.stderr.write(listResult.stderr);
  assertExpectedCoverageCases(listResult.stdout);

  let testError;
  try {
    runChecked(
      process.execPath,
      [playwrightCli, 'test', '--config', 'playwright.coverage-v2.config.ts'],
      {
        cwd: frontendDir,
        env: gateEnv,
        stdio: 'inherit',
      },
    );
  } catch (error) {
    testError = error;
  }

  let cleanupError;
  try {
    cleanupSchemas(backendDir, databaseUrls);
  } catch (error) {
    cleanupError = error;
  }
  if (testError && cleanupError) {
    throw new AggregateError([testError, cleanupError], 'Coverage V2 tests and cleanup failed.');
  }
  if (testError) throw testError;
  if (cleanupError) throw cleanupError;
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entrypoint === import.meta.url) {
  runReleaseGate().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Coverage V2 release gate failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
