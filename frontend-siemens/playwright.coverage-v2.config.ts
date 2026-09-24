import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { defineConfig } from 'playwright/test';

const frontendDir = fileURLToPath(new URL('.', import.meta.url));
const backendDir = process.env.COVERAGE_V2_BACKEND_DIR ?? path.resolve(frontendDir, '..', '..');
const backendAcceptanceSpec = path.join(
  backendDir,
  'apps/api/test/warehouse-coverage-v2-acceptance.e2e-spec.ts',
);
const databaseBaseUrl = process.env.COVERAGE_V2_DATABASE_URL;
const acceptancePassword = process.env.COVERAGE_V2_ACCEPTANCE_PASSWORD;

if (!databaseBaseUrl) {
  throw new Error(
    'Use npm run check:warehouse-coverage-v2 so the gate can allocate a disposable schema.',
  );
}
if (!acceptancePassword) {
  throw new Error(
    'Use npm run check:warehouse-coverage-v2 so the gate can allocate acceptance credentials.',
  );
}

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new Error(`${name} must be an unprivileged TCP port allocated by the release gate.`);
  }
  return value;
}

const acceptanceProfiles = [
  {
    name: 'coverage-v2-1024x768',
    viewport: { width: 1024, height: 768 },
    apiPort: requiredPort('COVERAGE_V2_API_PORT_1024'),
    webPort: requiredPort('COVERAGE_V2_WEB_PORT_1024'),
    schemaSuffix: '1024x768',
  },
  {
    name: 'coverage-v2-1440x900',
    viewport: { width: 1440, height: 900 },
    apiPort: requiredPort('COVERAGE_V2_API_PORT_1440'),
    webPort: requiredPort('COVERAGE_V2_WEB_PORT_1440'),
    schemaSuffix: '1440x900',
  },
] as const;

const acceptancePorts = acceptanceProfiles.flatMap(({ apiPort, webPort }) => [apiPort, webPort]);
if (new Set(acceptancePorts).size !== acceptancePorts.length) {
  throw new Error('Coverage V2 API and frontend ports must be unique.');
}

function assertDisposableDatabase(rawUrl: string): void {
  const url = new URL(rawUrl);
  const schema = url.searchParams.get('schema') ?? '';
  const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !localHost ||
    url.port !== '5433' ||
    url.pathname !== '/plenka' ||
    !/^coverage_v2_acceptance_[a-z0-9_]+$/u.test(schema)
  ) {
    throw new Error(
      'Coverage V2 browser acceptance refuses a non-local/non-disposable DATABASE_URL. ' +
        'Use localhost:5433/plenka with a schema named coverage_v2_acceptance_*.',
    );
  }
}

assertDisposableDatabase(databaseBaseUrl);

function profileDatabaseUrl(schemaSuffix: string): string {
  const url = new URL(databaseBaseUrl);
  const baseSchema = url.searchParams.get('schema');
  if (!baseSchema) throw new Error('Coverage V2 browser acceptance requires a schema.');
  url.searchParams.set('schema', `${baseSchema}_${schemaSuffix}`);
  const profileUrl = url.toString();
  assertDisposableDatabase(profileUrl);
  return profileUrl;
}

const missingBackendFixtureCommand = [
  process.execPath,
  '-e',
  JSON.stringify(
    "throw new Error('Backend Task 27 is missing: create apps/api/test/warehouse-coverage-v2-acceptance.e2e-spec.ts before running browser acceptance.')",
  ),
].join(' ');

const prepareBackendCommand = existsSync(backendAcceptanceSpec)
  ? [
      'npm run db:deploy',
      'npm run db:seed',
      [
        'npx ts-node',
        'apps/api/test/warehouse-coverage-v2-acceptance.e2e-spec.ts',
        '--prepare-browser-fixtures',
      ].join(' '),
      'npm run dev',
    ].join(' && ')
  : missingBackendFixtureCommand;

const webServer = acceptanceProfiles.flatMap((profile) => {
  const apiBaseUrl = `http://127.0.0.1:${profile.apiPort}`;
  const webBaseUrl = `http://127.0.0.1:${profile.webPort}`;
  return [
    {
      command: prepareBackendCommand,
      cwd: backendDir,
      env: {
        APP_ENV: 'development',
        AUTH_DEV_XROLE: 'on',
        SEED_PASSWORD: acceptancePassword,
        SEED_PROFILE: 'demo',
        WAREHOUSE_COVERAGE_V2_ENABLED: 'true',
        DATABASE_URL: profileDatabaseUrl(profile.schemaSuffix),
        PORT: String(profile.apiPort),
      },
      url: `${apiBaseUrl}/api/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${profile.webPort} --strictPort`,
      cwd: frontendDir,
      env: {
        API_PROXY_TARGET: apiBaseUrl,
        VITE_LIVE_CONTOURS: 'commercial,production,finance,warehouse',
        VITE_REQUIRE_AUTH: 'on',
      },
      url: webBaseUrl,
      timeout: 90_000,
      reuseExistingServer: false,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    },
  ];
});

export default defineConfig({
  globalSetup: './tests/warehouse-coverage-v2.global-setup.ts',
  testDir: './tests',
  testMatch: 'warehouse-coverage-v2.acceptance.spec.ts',
  outputDir: './output/warehouse-coverage-v2/test-results',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  globalTimeout: 15 * 60_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: acceptanceProfiles.map((profile) => ({
    name: profile.name,
    use: {
      baseURL: `http://127.0.0.1:${profile.webPort}`,
      viewport: profile.viewport,
    },
  })),
  webServer,
});
