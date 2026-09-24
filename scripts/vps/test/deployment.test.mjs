import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VALIDATOR = resolve(ROOT, 'scripts/vps/validate-env.sh');
const FRESH_PILOT_DATABASE = resolve(ROOT, 'scripts/vps/fresh-pilot-database.sh');
const RESET_PILOT_DEMO = resolve(ROOT, 'scripts/vps/reset-pilot-demo.sh');
const PURGE_PILOT_ORDER_HISTORY = resolve(ROOT, 'scripts/vps/purge-pilot-order-history.sh');
const VPS_SMOKE = resolve(ROOT, 'scripts/vps/smoke-vps.sh');
const RECOVERY_GUARD = resolve(ROOT, 'scripts/vps/recovery-guard.sh');
const DISASTER_RECOVER = resolve(ROOT, 'scripts/vps/disaster-recover.sh');

const PILOT_SMOKE_ACCOUNTS = [
  {
    login: 'коммерция',
    passwordKey: 'SEED_PILOT_PASSWORD_COMMERCIAL',
    role: 'commercial',
  },
  {
    login: 'производство',
    passwordKey: 'SEED_PILOT_PASSWORD_PRODUCTION',
    role: 'production_lead',
  },
  { login: 'ахметов булат', passwordKey: 'SEED_PILOT_PASSWORD_OPERATOR', role: 'operator' },
  {
    login: 'хабибулин руслан',
    passwordKey: 'SEED_PILOT_PASSWORD_OPERATOR_2',
    role: 'operator',
  },
  {
    login: 'гайнулин ильназ',
    passwordKey: 'SEED_PILOT_PASSWORD_OPERATOR_3',
    role: 'operator',
  },
  { login: 'склад', passwordKey: 'SEED_PILOT_PASSWORD_WAREHOUSE', role: 'warehouse' },
  { login: 'бухгалтерия', passwordKey: 'SEED_PILOT_PASSWORD_FINANCE', role: 'finance' },
  { login: 'директор', passwordKey: 'SEED_PILOT_PASSWORD_DIRECTOR', role: 'director' },
  { login: 'админ', passwordKey: 'SEED_PILOT_PASSWORD_ADMIN', role: 'admin' },
];

const PILOT_PASSWORD_KEYS = PILOT_SMOKE_ACCOUNTS.map((account) => account.passwordKey).sort();
const POST_AGENT_TOKEN_KEYS = [
  'SEED_PILOT_AGENT_TOKEN_POST_1',
  'SEED_PILOT_AGENT_TOKEN_POST_2',
  'SEED_PILOT_AGENT_TOKEN_POST_3',
  'SEED_PILOT_AGENT_TOKEN_POST_4',
  'SEED_PILOT_AGENT_TOKEN_POST_5',
];

function sortedCapturedKeys(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]).sort();
}

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function runbookSection(runbook, title) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const heading = new RegExp(`^(#{1,6})[ \\t]+${escapedTitle}[ \\t]*$`, 'mu').exec(runbook);
  assert.ok(heading, `runbook section "${title}" must exist`);
  const content = runbook.slice(heading.index + heading[0].length);
  const nextHeading = new RegExp(`^#{1,${heading[1].length}}[ \\t]+`, 'mu').exec(content);
  return nextHeading ? content.slice(0, nextHeading.index) : content;
}

const PUBLIC_HOST_POLICY_VECTORS = JSON.parse(read('deploy/vps/public-host-policy.vectors.json'));

function originForHost(host) {
  return host.includes(':') ? `https://[${host}]` : `https://${host}`;
}

function pilotEnvironment() {
  const values = {
    ACME_EMAIL: 'ops@example.test',
    APP_ENV: 'pilot',
    AUTH_DEV_XROLE: 'off',
    BACKUP_DIR: '/opt/plenka/backups',
    BACKUP_RETENTION_COUNT: '14',
    BACKUP_RETENTION_DAYS: '30',
    COMPOSE_PROJECT_NAME: 'plenka-pilot-test',
    DATABASE_APP_PASSWORD: 'DatabasePassword_0123456789abcdef',
    DATABASE_APP_USER: 'plenka_app',
    DATABASE_URL:
      'postgresql://plenka_app:DatabasePassword_0123456789abcdef@db:5432/plenka_pilot?schema=public',
    DATABASE_OWNER_PASSWORD: 'OwnerPassword_0123456789abcdef',
    DATABASE_OWNER_USER: 'plenka_owner',
    DEVICE_GATEWAY_PRINTER: 'on',
    DEVICE_GATEWAY_SCALE: 'on',
    GATEWAY_COMMAND_TIMEOUT_MS: '15000',
    GATEWAY_SIMULATOR: 'off',
    LOGIN_RATE_MAX: '10',
    LOGIN_RATE_MAX_KEYS: '10000',
    LOGIN_RATE_WINDOW_MS: '60000',
    NODE_ENV: 'production',
    ONEC_FINANCE_SYNC_ENABLED: 'false',
    ONEC_FINANCE_SYNC_INTERVAL_MS: '300000',
    ONEC_LIVE: 'false',
    ONEC_PAYMENT_AUTO_APPLY_ENABLED: 'false',
    ONEC_PAYMENT_SYNC_ENABLED: 'false',
    ONEC_SYNC_ENABLED: 'false',
    ONEC_SYNC_INTERVAL_MS: '900000',
    ONEC_SYNC_PAGE_SIZE: '250',
    ONEC_TIMEOUT_MS: '5000',
    ONEC_WRITE: 'false',
    PASSWORD_SETUP_TTL: '1800',
    PALLET_LABEL_PROFILE: 'pallet-100x100-extended-v6',
    PILOT_SHORT_PASSWORDS_ENABLED: 'false',
    MIGRATION_DATABASE_URL:
      'postgresql://plenka_owner:OwnerPassword_0123456789abcdef@db:5432/plenka_pilot?schema=public',
    PLENKA_API_IMAGE: 'plenka-api:0123456789ab',
    PLENKA_MIGRATION_IMAGE: 'plenka-migration:0123456789ab',
    PLENKA_WEB_IMAGE: 'plenka-web:0123456789ab',
    PORT: '3000',
    POSTGRES_ADMIN_PASSWORD: 'AdminPassword_0123456789abcdef',
    POSTGRES_ADMIN_USER: 'plenka_admin',
    POSTGRES_DB: 'plenka_pilot',
    PRODUCTION_COST_RECONCILER_ENABLED: 'true',
    PUBLIC_HOST: 'pilot.plenka-kontur.ru',
    PUBLIC_ORIGIN: 'https://pilot.plenka-kontur.ru',
    SEED_PROFILE: 'pilot',
    SESSION_TTL: '43200',
    WAREHOUSE_COVERAGE_V2_ENABLED: 'false',
  };

  const accounts = [
    'COMMERCIAL',
    'PRODUCTION',
    'OPERATOR',
    'OPERATOR_2',
    'OPERATOR_3',
    'WAREHOUSE',
    'FINANCE',
    'DIRECTOR',
    'ADMIN',
  ];
  for (const [index, suffix] of accounts.entries()) {
    values[`SEED_PILOT_PASSWORD_${suffix}`] = `PilotPassword_${index}_${randomBytes(18).toString(
      'base64url',
    )}`;
  }
  for (let index = 1; index <= 5; index += 1) {
    values[`SEED_PILOT_AGENT_TOKEN_POST_${index}`] = `ptk_${randomBytes(32).toString('base64url')}`;
  }
  return values;
}

function oneCDisabledPilotEnvironment() {
  return pilotEnvironment();
}

function nonCanonicalPilotToken() {
  const payload = randomBytes(32).toString('base64url');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const finalIndex = alphabet.indexOf(payload.at(-1));
  return `ptk_${payload.slice(0, -1)}${alphabet[finalIndex + 1]}`;
}

function writeEnvironment(directory, overrides = {}) {
  const values = { ...pilotEnvironment(), ...overrides };
  const path = resolve(directory, 'pilot.env');
  writeFileSync(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  return { path, values };
}

function writeVpsSmokeFakes(directory) {
  const binDirectory = resolve(directory, 'bin');
  mkdirSync(binDirectory);
  const statePath = resolve(directory, 'curl-state.json');
  writeFileSync(
    statePath,
    JSON.stringify({ loginAttempts: 0, logoutAttempts: 0, meAttempts: 0, sessions: {} }),
    { mode: 0o600 },
  );

  const fakeDocker = resolve(binDirectory, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${1-}" == info ]]; then exit 0; fi
if [[ "\${1-}" == compose && "\${2-}" == version ]]; then exit 0; fi
if [[ "\${1-}" == inspect ]]; then exit 0; fi
case " $* " in
  *" ps --status running -q api"*) printf '%s\\n' 'api-container' ;;
  *" ps --status running -q db"*) printf '%s\\n' 'db-container' ;;
  *" ps --status running"*) printf '%s\\n' 'services-running' ;;
  *) exit 91 ;;
esac
`,
  );
  chmodSync(fakeDocker, 0o755);

  const fakeCurl = resolve(binDirectory, 'curl');
  writeFileSync(
    fakeCurl,
    `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');

const accounts = ${JSON.stringify(PILOT_SMOKE_ACCOUNTS)};
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const url = args.at(-1) ?? '';
const statePath = process.env.FAKE_CURL_STATE;
const scenario = process.env.FAKE_CURL_SCENARIO ?? 'success';
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { loginAttempts: 0, logoutAttempts: 0, meAttempts: 0, sessions: {} };
const body = readFileSync(0, 'utf8');
const headers = args.flatMap((arg, index) =>
  arg === '--header' && args[index + 1] ? [args[index + 1]] : [],
);
const authorization = headers.find((header) => header.startsWith('Authorization: Bearer '));
const env = Object.fromEntries(
  readFileSync(process.env.PLENKA_ENV_FILE, 'utf8')
    .trim()
    .split('\\n')
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

function finish(status, payload) {
  if (outputPath) writeFileSync(outputPath, JSON.stringify(payload));
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  if (args.includes('--write-out')) process.stdout.write(String(status));
  process.exit(status >= 200 && status < 300 ? 0 : 0);
}

if (url.endsWith('/api/health') || url.endsWith('/api/health/ready')) {
  finish(200, { ok: true });
}

if (url.endsWith('/api/auth/login')) {
  state.loginAttempts += 1;
  const account = accounts[state.loginAttempts - 1];
  let submitted = null;
  try {
    submitted = JSON.parse(body);
  } catch {}
  if (
    !account ||
    submitted?.login !== account.login ||
    submitted?.password !== env[account.passwordKey]
  ) {
    finish(account ? 401 : 429, { privateResponseMarker: 'private-response-marker' });
  }
  const token = createHash('sha256').update('pilot-smoke-' + state.loginAttempts).digest('hex');
  state.sessions[token] = { index: state.loginAttempts - 1, role: account.role };
  finish(201, {
    token: scenario === 'missing-token' && state.loginAttempts === 2 ? '' : token,
    passwordChangeRequired:
      scenario === 'password-required-login' && state.loginAttempts === 3,
    user: {
      id: 'test-user-' + state.loginAttempts,
      role:
        scenario === 'wrong-login-role' && state.loginAttempts === 4 ? 'admin' : account.role,
    },
    privateResponseMarker: 'private-response-marker',
  });
}

if (url.endsWith('/api/auth/me')) {
  state.meAttempts += 1;
  const token = authorization?.slice('Authorization: Bearer '.length) ?? '';
  const session = state.sessions[token];
  if (!session) finish(401, { privateResponseMarker: 'private-response-marker' });
  const nestedRoleDecoy = scenario === 'nested-role-decoy' && state.meAttempts === 4;
  finish(200, {
    role:
      (scenario === 'wrong-me-role' && state.meAttempts === 4) || nestedRoleDecoy
        ? 'admin'
        : session.role,
    decoy: nestedRoleDecoy ? { role: session.role } : undefined,
    passwordChangeRequired:
      scenario === 'password-required-me' && state.meAttempts === 6,
    privateResponseMarker: 'private-response-marker',
  });
}

if (url.endsWith('/api/auth/logout')) {
  state.logoutAttempts += 1;
  const token = authorization?.slice('Authorization: Bearer '.length) ?? '';
  if (!state.sessions[token]) finish(401, { privateResponseMarker: 'private-response-marker' });
  delete state.sessions[token];
  finish(201, { ok: true, privateResponseMarker: 'private-response-marker' });
}

finish(404, { privateResponseMarker: 'private-response-marker' });
`,
  );
  chmodSync(fakeCurl, 0o755);
  return { binDirectory, statePath };
}

function runVpsSmokeScenario(scenario = 'success') {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-account-smoke-'));
  const pinOverrides = { PILOT_SHORT_PASSWORDS_ENABLED: 'true' };
  for (const [index, account] of PILOT_SMOKE_ACCOUNTS.entries()) {
    pinOverrides[account.passwordKey] = String(1100 + index);
  }
  const { path: environmentPath, values } = writeEnvironment(directory, pinOverrides);
  const { binDirectory, statePath } = writeVpsSmokeFakes(directory);
  const result = spawnSync(VPS_SMOKE, [], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_CURL_SCENARIO: scenario,
      FAKE_CURL_STATE: statePath,
      PATH: `${binDirectory}:${process.env.PATH}`,
      PLENKA_ENV_FILE: environmentPath,
    },
  });
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  return {
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    result,
    state,
    values,
  };
}

function composeConfig(envFile) {
  return composeConfigViaCanonicalWrapper(envFile);
}

function composeConfigViaCanonicalWrapper(envFile, inherited = {}) {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -Eeuo pipefail
export PLENKA_ENV_FILE="$1"
source "$2/scripts/vps/lib.sh"
validate_environment
compose --profile bootstrap --profile maintenance config --format json`,
      'compose-wrapper-test',
      envFile,
      ROOT,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ...inherited },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('production compose exposes only web 80/443 and keeps state private', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-compose-test-'));
  try {
    const { path, values } = writeEnvironment(directory);
    const config = composeConfig(path);

    assert.deepEqual(Object.keys(config.services).sort(), [
      'api',
      'db',
      'migrate',
      'purge-pilot-order-history',
      'reset-pilot-demo',
      'seed-pilot',
      'web',
    ]);
    assert.equal(config.services.api.ports, undefined);
    assert.equal(config.services.db.ports, undefined);
    assert.deepEqual(
      config.services.web.ports.map(({ published, target }) => [Number(published), target]),
      [
        [80, 80],
        [443, 443],
      ],
    );

    const backendNetwork = Object.entries(config.networks).find(([, network]) => network.internal);
    assert.ok(backendNetwork, 'an internal backend network must exist');
    const backendName = backendNetwork[0];
    assert.ok(backendName in config.services.db.networks);
    assert.ok(backendName in config.services.api.networks);
    assert.ok(backendName in config.services.web.networks);
    const apiExternalNetworks = Object.entries(config.services.api.networks)
      .map(([name]) => name)
      .filter((name) => config.networks[name]?.internal !== true);
    assert.deepEqual(apiExternalNetworks, [], 'API must not keep 1C outbound network access');
    assert.ok(config.volumes['db-data']);
    assert.ok(config.volumes['caddy-data']);
    assert.ok(config.volumes['caddy-config']);
    const frontendRoutesMount = config.services.web.volumes.find(
      (mount) => mount.target === '/etc/caddy/frontend-routes.caddy',
    );
    assert.ok(frontendRoutesMount, 'web must mount the shared frontend route policy');
    assert.equal(frontendRoutesMount.type, 'bind');
    assert.equal(frontendRoutesMount.read_only, true);
    assert.match(frontendRoutesMount.source, /deploy\/vps\/frontend-routes\.caddy$/u);
    assert.equal(config.services.api.environment.DATABASE_URL, values.DATABASE_URL);
    assert.equal(config.services.api.environment.ONEC_BASE_URL, values.ONEC_BASE_URL);
    assert.equal(config.services.api.environment.ONEC_USERNAME, values.ONEC_USERNAME);
    assert.equal(config.services.api.environment.ONEC_PASSWORD, values.ONEC_PASSWORD);
    assert.equal(
      config.services.api.environment.PILOT_SHORT_PASSWORDS_ENABLED,
      values.PILOT_SHORT_PASSWORDS_ENABLED,
    );
    assert.equal(config.services.api.environment.WAREHOUSE_COVERAGE_V2_ENABLED, 'false');
    assert.equal(config.services.api.environment.PRODUCTION_COST_RECONCILER_ENABLED, 'true');
    assert.equal(config.services.migrate.environment.ONEC_PASSWORD, undefined);
    assert.equal(config.services.migrate.environment.WAREHOUSE_COVERAGE_V2_ENABLED, undefined);
    assert.equal(config.services['reset-pilot-demo'].profiles[0], 'maintenance');
    assert.equal(
      config.services['reset-pilot-demo'].environment.DATABASE_URL,
      values.MIGRATION_DATABASE_URL,
    );
    assert.equal(config.services['reset-pilot-demo'].environment.APP_ENV, values.APP_ENV);
    assert.equal(config.services['reset-pilot-demo'].environment.SEED_PROFILE, values.SEED_PROFILE);
    assert.equal(
      config.services['reset-pilot-demo'].environment.SEED_PILOT_PASSWORD_ADMIN,
      undefined,
    );
    assert.deepEqual(config.services['reset-pilot-demo'].command, [
      'npm',
      'run',
      'db:reset:pilot-demo',
      '-w',
      '@plenka/api',
    ]);
    assert.equal(
      Object.hasOwn(config.services['reset-pilot-demo'].environment, 'PILOT_DEMO_RESET_CONFIRM'),
      false,
    );
    assert.equal(config.services['seed-pilot'].environment.ONEC_PASSWORD, undefined);
    assert.equal(
      config.services['seed-pilot'].environment.WAREHOUSE_COVERAGE_V2_ENABLED,
      undefined,
    );
    assert.equal(
      config.services['seed-pilot'].environment.PILOT_SHORT_PASSWORDS_ENABLED,
      values.PILOT_SHORT_PASSWORDS_ENABLED,
    );
    assert.equal(
      config.services['seed-pilot'].environment.NODE_OPTIONS,
      '--max-old-space-size=512',
    );
    assert.equal(
      config.services['reset-pilot-demo'].environment.NODE_OPTIONS,
      '--max-old-space-size=512',
    );
    assert.equal(config.services['purge-pilot-order-history'].profiles[0], 'maintenance');
    assert.equal(
      config.services['purge-pilot-order-history'].environment.DATABASE_URL,
      values.MIGRATION_DATABASE_URL,
    );
    assert.equal(config.services['purge-pilot-order-history'].environment.APP_ENV, values.APP_ENV);
    assert.equal(
      config.services['purge-pilot-order-history'].environment.SEED_PROFILE,
      values.SEED_PROFILE,
    );
    assert.deepEqual(config.services['purge-pilot-order-history'].command, [
      'npm',
      'run',
      'db:purge:pilot-order-history',
      '-w',
      '@plenka/api',
    ]);
    assert.equal(
      Object.hasOwn(
        config.services['purge-pilot-order-history'].environment,
        'PILOT_ORDER_HISTORY_PURGE_CONFIRM',
      ),
      false,
    );
    assert.equal(
      Object.hasOwn(
        config.services['purge-pilot-order-history'].environment,
        'PILOT_GATEWAYS_STOPPED',
      ),
      false,
    );
    assert.equal(config.services.migrate.environment.DATABASE_URL, values.MIGRATION_DATABASE_URL);
    assert.equal(config.services.db.environment.POSTGRES_USER, values.POSTGRES_ADMIN_USER);
    assert.notEqual(
      config.services.db.environment.POSTGRES_USER,
      config.services.api.environment.DATABASE_URL.match(/^postgresql:\/\/([^:]+)/)?.[1],
    );
    assert.match(JSON.stringify(config.services.db.volumes), /init-database\.sh/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('compose orders migration, seed and readiness without automatic bootstrap', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-compose-order-test-'));
  try {
    const { path } = writeEnvironment(directory);
    const config = composeConfig(path);
    const migrateCommand = JSON.stringify(config.services.migrate.command);
    const seedCommand = JSON.stringify(config.services['seed-pilot'].command);

    assert.match(migrateCommand, /prisma.*migrate.*deploy/);
    assert.doesNotMatch(migrateCommand, /migrate.*dev/);
    assert.match(seedCommand, /db:seed/);
    assert.deepEqual(config.services['seed-pilot'].profiles, ['bootstrap']);
    assert.equal(config.services.api.depends_on.db.condition, 'service_healthy');
    assert.equal(
      config.services.api.depends_on.migrate.condition,
      'service_completed_successfully',
    );
    assert.equal(config.services.web.depends_on.api.condition, 'service_healthy');
    assert.equal(config.services.api.environment.PORT, '3000');
    assert.match(JSON.stringify(config.services.api.healthcheck.test), /127\.0\.0\.1:3000/);

    for (const serviceName of ['db', 'api', 'web']) {
      const service = config.services[serviceName];
      assert.ok(service.healthcheck?.test, `${serviceName} healthcheck`);
      assert.equal(service.restart, 'unless-stopped');
      assert.equal(service.logging?.driver, 'json-file');
      assert.ok(service.logging?.options?.['max-size']);
      assert.ok(service.logging?.options?.['max-file']);
    }
    assert.match(JSON.stringify(config.services.web.healthcheck.test), /127\.0\.0\.1:2019\/config/);
    for (const serviceName of ['api', 'migrate', 'seed-pilot', 'web']) {
      assert.match(config.services[serviceName].image, /^[^:]+(?::[^/]+|@sha256:)/);
      assert.doesNotMatch(config.services[serviceName].image, /:latest$/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recovery guard is a bounded systemd timer over the existing healthchecks', () => {
  const service = read('deploy/vps/plenka-recovery-guard.service');
  const timer = read('deploy/vps/plenka-recovery-guard.timer');

  assert.match(service, /^Type=oneshot$/mu);
  assert.match(
    service,
    /^ConditionFileIsExecutable=\/opt\/plenka\/current\/backend\/scripts\/vps\/recovery-guard\.sh$/mu,
  );
  assert.match(
    service,
    /^ExecStart=\/opt\/plenka\/current\/backend\/scripts\/vps\/recovery-guard\.sh$/mu,
  );
  assert.match(service, /^Environment=PLENKA_ENV_FILE=\/opt\/plenka\/shared\/pilot\.env$/mu);
  assert.match(timer, /^OnBootSec=2min$/mu);
  assert.match(timer, /^OnUnitActiveSec=1min$/mu);
  assert.match(timer, /^Persistent=true$/mu);
});

test('recovery guard restarts only an unhealthy app while its database is healthy', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-recovery-guard-'));
  try {
    const { path: environmentPath } = writeEnvironment(directory);
    const binDirectory = resolve(directory, 'bin');
    const dockerLog = resolve(directory, 'docker.log');
    mkdirSync(binDirectory);
    const fakeDocker = resolve(binDirectory, 'docker');
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${1-}" == info ]]; then exit 0; fi
if [[ "\${1-}" == compose && "\${2-}" == version ]]; then exit 0; fi
printf '%s\\n' "$*" >>"\${PLENKA_TEST_DOCKER_LOG:?}"
case " $* " in
  *" ps --status running -q db "*) printf '%s\\n' 'db-container' ;;
  *" ps --status running -q api "*) printf '%s\\n' 'api-container' ;;
  *" ps --status running -q web "*) printf '%s\\n' 'web-container' ;;
  *" inspect "*" db-container "*) printf '%s\\n' "\${PLENKA_TEST_DB_HEALTH:-healthy}" ;;
  *" inspect "*" api-container "*) printf '%s\\n' "\${PLENKA_TEST_API_HEALTH:-unhealthy}" ;;
  *" inspect "*" web-container "*) printf '%s\\n' "\${PLENKA_TEST_WEB_HEALTH:-healthy}" ;;
  *" restart api "*) exit 0 ;;
  *) exit 91 ;;
esac
`,
      { mode: 0o755 },
    );

    const result = spawnSync(RECOVERY_GUARD, [], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        PLENKA_ENV_FILE: environmentPath,
        PLENKA_TEST_DOCKER_LOG: dockerLog,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const commands = readFileSync(dockerLog, 'utf8');
    assert.match(commands, /restart api/u);
    assert.doesNotMatch(commands, /restart (?:db|web)/u);

    writeFileSync(dockerLog, '');
    const databaseFailure = spawnSync(RECOVERY_GUARD, [], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        PLENKA_ENV_FILE: environmentPath,
        PLENKA_TEST_DB_HEALTH: 'unhealthy',
        PLENKA_TEST_DOCKER_LOG: dockerLog,
      },
    });
    assert.equal(databaseFailure.status, 0, `${databaseFailure.stdout}${databaseFailure.stderr}`);
    assert.doesNotMatch(readFileSync(dockerLog, 'utf8'), /restart (?:api|db|web)/u);
    assert.match(databaseFailure.stdout, /api restart skipped/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('new-host disaster recovery is one guarded command with check-before-restore ordering', () => {
  const script = read('scripts/vps/disaster-recover.sh');
  const check = script.indexOf('restore.sh" --check');
  const emptyDatabase = script.indexOf('pg_catalog.pg_tables');
  const migration = script.indexOf('compose run --rm --no-deps migrate');
  const liveRestore = script.indexOf('restore.sh" --live');
  const deploy = script.indexOf('deploy.sh"');
  const smoke = script.indexOf('smoke-vps.sh"');

  assert.match(script, /RECOVER_EMPTY_VPS_PLENKA/u);
  assert.match(script, /ONEC_WRITE.*false/u);
  assert.match(script, /ps --status running -q "\$service"/u);
  assert.ok(emptyDatabase >= 0 && check >= 0 && check < emptyDatabase);
  assert.ok(emptyDatabase < migration && migration < liveRestore);
  assert.ok(liveRestore < deploy && deploy < smoke);

  const refusal = spawnSync(DISASTER_RECOVER, ['/tmp/not-a-backup', 'WRONG_CONFIRMATION'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(refusal.status, 0);
  assert.match(refusal.stderr, /confirmation mismatch/u);
});

test('internet-facing web container has an immutable root filesystem', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-compose-web-hardening-test-'));
  try {
    const { path } = writeEnvironment(directory);
    const web = composeConfig(path).services.web;

    assert.equal(web.read_only, true);
    assert.ok(web.tmpfs.some((mount) => String(mount).startsWith('/tmp')));
    assert.ok(web.volumes.some((mount) => mount.target === '/data' && mount.type === 'volume'));
    assert.ok(web.volumes.some((mount) => mount.target === '/config' && mount.type === 'volume'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backend image is multi-stage, pinned and non-root at runtime', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /FROM\s+\S+@sha256:[a-f0-9]{64}\s+AS\s+build/i);
  assert.match(dockerfile, /\sAS\s+migration/i);
  assert.match(dockerfile, /\sAS\s+runtime/i);
  assert.match(dockerfile, /USER\s+node/i);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.doesNotMatch(dockerfile, /:latest/i);
  assert.doesNotMatch(dockerfile, /npm\s+install(?!\s+--)/);
});

test('immutable release extraction remains readable by non-root image users', () => {
  const runbook = read('docs/operations/vps-pilot-runbook.md');
  const restoreReadPermissions = runbook.indexOf('chmod -R a+rX "$RELEASE_DIR"');
  const removeWritePermissions = runbook.indexOf('chmod -R a-w "$RELEASE_DIR"');

  assert.ok(restoreReadPermissions >= 0, 'strict root umask must not create root-only sources');
  assert.ok(
    removeWritePermissions > restoreReadPermissions,
    'release must become immutable only after runtime read/search permissions are restored',
  );
});

test('backend build and runtime use the reviewed Node 22.23.1 image digest', () => {
  const expected =
    'public.ecr.aws/docker/library/node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';
  const bases = [...read('Dockerfile').matchAll(/^FROM\s+(\S+)/gmu)].map((match) => match[1]);

  assert.deepEqual(bases, [expected, 'build', 'build', expected]);
});

test('CI gates deployment contracts, Compose, Caddy and both backend image targets locally', () => {
  const workflow = read('.github/workflows/ci.yml');
  const marker = '\n  deployment-contracts:\n';
  const start = workflow.indexOf(marker);

  assert.ok(start >= 0, 'CI must define the deployment-contracts job');
  const job = workflow.slice(start + marker.length);
  assert.match(job, /\.\/scripts\/vps\/test\/run\.sh/u);
  assert.match(job, /\.\/scripts\/vps\/check-compose\.sh --example-only/u);
  assert.match(job, /\.\/scripts\/vps\/check-caddy\.sh/u);
  assert.match(job, /docker build --target runtime\b/u);
  assert.match(job, /docker build --target migration\b/u);
  assert.doesNotMatch(job, /secrets\.|\b(?:ssh|scp|rsync)\b/u);
});

test('CI lint is check-only and keeps mutation behind an explicit developer command', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const apiPackage = JSON.parse(read('apps/api/package.json'));
  const workflow = read('.github/workflows/ci.yml');

  assert.doesNotMatch(rootPackage.scripts.lint, /--fix\b/u);
  assert.doesNotMatch(apiPackage.scripts.lint, /--fix\b/u);
  assert.match(rootPackage.scripts['lint:fix'], /lint:fix/u);
  assert.match(apiPackage.scripts['lint:fix'], /--fix\b/u);
  assert.match(workflow, /run: npm run lint$/mu);
  assert.doesNotMatch(workflow, /run: npm run lint(?::fix|[^\n]*--fix)/u);
});

test('database uses the reviewed PostgreSQL 16.14 image digest', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-postgres-pin-test-'));
  try {
    const { path } = writeEnvironment(directory);
    const database = composeConfig(path).services.db;

    assert.equal(
      database.image,
      'public.ecr.aws/docker/library/postgres:16.14-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production and runtime Caddy configs import one shared frontend route policy', () => {
  const caddyfile = read('deploy/vps/Caddyfile');
  const runtimeFixture = read('scripts/vps/fixtures/Caddyfile.runtime');
  const frontendRoutes = read('deploy/vps/frontend-routes.caddy');
  const globalOptionsEnd = caddyfile.indexOf('\n}\n');
  const globalOptions = caddyfile.slice(0, globalOptionsEnd + 2);
  const apiRoute = frontendRoutes.indexOf('handle /api/*');
  const sourceMapRoute = frontendRoutes.indexOf('@sourceMaps path *.map');
  const assetRoute = frontendRoutes.indexOf('handle /assets/*');
  const spaRoute = frontendRoutes.indexOf('try_files {path} /index.html');

  assert.ok(globalOptionsEnd > 0, 'Caddy global options block must exist');
  assert.match(globalOptions, /^\tdefault_sni \{\$PUBLIC_HOST\}$/mu);
  assert.equal((caddyfile.match(/\bdefault_sni\b/gu) ?? []).length, 1);
  assert.match(caddyfile, /^import frontend-routes\.caddy$/mu);
  assert.match(caddyfile, /^\timport plenka_frontend_routes$/mu);
  assert.match(runtimeFixture, /^import frontend-routes\.caddy$/mu);
  assert.match(runtimeFixture, /^\timport plenka_frontend_routes$/mu);
  assert.ok(
    apiRoute >= 0 &&
      sourceMapRoute > apiRoute &&
      assetRoute > sourceMapRoute &&
      spaRoute > assetRoute,
  );
  assert.match(frontendRoutes, /reverse_proxy\s+api:3000/);
  assert.match(caddyfile, /profile\s+shortlived/);
  assert.doesNotMatch(caddyfile, /tls\s+internal/);
  assert.match(runtimeFixture, /auto_https off/u);
  assert.doesNotMatch(runtimeFixture, /\b(?:tls|acme)\b/u);
});

test('shared frontend policy rejects stale assets and applies exact cache boundaries', () => {
  const frontendRoutes = read('deploy/vps/frontend-routes.caddy');
  assert.match(
    frontendRoutes,
    /@sourceMaps path \*\.map[\s\S]*handle @sourceMaps \{[\s\S]*respond 404/u,
  );
  const assetHandleStart = frontendRoutes.indexOf('handle /assets/*');
  const spaHandleStart = frontendRoutes.indexOf('\n\t\thandle {', assetHandleStart);
  const assetHandle = frontendRoutes.slice(assetHandleStart, spaHandleStart);
  const spaHandle = frontendRoutes.slice(spaHandleStart);

  assert.match(
    assetHandle,
    /try_files \{path\} =404[\s\S]*header Cache-Control "public, max-age=31536000, immutable"/u,
  );
  assert.doesNotMatch(assetHandle, /\/index\.html/u);
  assert.match(spaHandle, /try_files \{path\} \/index\.html/u);
  assert.match(spaHandle, /header Cache-Control "no-cache, no-store, must-revalidate"/u);
});

test('Caddy validation and runtime smoke cover the same imported policy', () => {
  const validator = read('scripts/vps/check-caddy.sh');
  const smoke = read('scripts/vps/smoke-caddy-runtime.sh');

  assert.match(validator, /frontend-routes\.caddy/u);
  assert.match(validator, /Caddyfile\.runtime/u);
  assert.match(smoke, /^set -Eeuo pipefail$/mu);
  assert.match(smoke, /\bWEB_IMAGE\b/u);
  assert.match(smoke, /docker network create/u);
  assert.match(smoke, /127\.0\.0\.1::8080/u);
  assert.match(smoke, /\/srv\/index\.html/u);
  assert.match(smoke, /sha256/u);
  assert.match(smoke, /Cache-Control/u);
  assert.match(smoke, /\/api\//u);
  assert.match(smoke, /\/assets\//u);
  assert.match(smoke, /\.map/u);
  assert.doesNotMatch(smoke, /(?:^|\s)(?:-k|--insecure)(?:\s|$)/u);
});

test('deployment configuration defines exactly nine pilot accounts and retires operator 4', () => {
  const compose = read('deploy/vps/compose.yml');
  const envExample = read('deploy/vps/.env.example');
  const rootEnvExample = read('.env.example');

  assert.doesNotMatch(compose, /SEED_PILOT_PASSWORD_OPERATOR_4/u);
  assert.doesNotMatch(envExample, /SEED_PILOT_PASSWORD_OPERATOR_4/u);
  assert.doesNotMatch(rootEnvExample, /SEED_PILOT_PASSWORD_OPERATOR_4/u);
  assert.doesNotMatch(read('scripts/vps/validate-env.sh'), /SEED_PILOT_PASSWORD_OPERATOR_4/u);
  assert.doesNotMatch(read('scripts/vps/smoke-vps.sh'), /SEED_PILOT_PASSWORD_OPERATOR_4/u);
});

test('active deployment contracts keep exact pilot password and post-token key sets', () => {
  const rootEnvExample = read('.env.example');
  const vpsEnvExample = read('deploy/vps/.env.example');
  const compose = read('deploy/vps/compose.yml');
  const validator = read('scripts/vps/validate-env.sh');
  const smoke = read('scripts/vps/smoke-vps.sh');
  const validatorPasswords = validator.match(/split\("([^"]+)", passwords\)/u)?.[1].split(' ');
  const validatorTokens = validator.match(/split\("([^"]+)", tokens\)/u)?.[1].split(' ');

  assert.deepEqual(
    sortedCapturedKeys(rootEnvExample, /^\s*#\s*(SEED_PILOT_PASSWORD_[A-Z0-9_]+)\s*$/gmu),
    PILOT_PASSWORD_KEYS,
  );
  assert.deepEqual(
    sortedCapturedKeys(vpsEnvExample, /^\s*(SEED_PILOT_PASSWORD_[A-Z0-9_]+)=/gmu),
    PILOT_PASSWORD_KEYS,
  );
  assert.deepEqual(
    sortedCapturedKeys(compose, /^\s{6}(SEED_PILOT_PASSWORD_[A-Z0-9_]+):/gmu),
    PILOT_PASSWORD_KEYS,
  );
  assert.deepEqual([...new Set(validatorPasswords ?? [])].sort(), PILOT_PASSWORD_KEYS);
  assert.deepEqual(
    sortedCapturedKeys(smoke, /^\s*'[^|']+\|(SEED_PILOT_PASSWORD_[A-Z0-9_]+)\|[a-z_]+'$/gmu),
    PILOT_PASSWORD_KEYS,
  );

  for (const source of [rootEnvExample, vpsEnvExample, compose]) {
    assert.deepEqual(
      sortedCapturedKeys(source, /^\s*#?\s*(SEED_PILOT_AGENT_TOKEN_POST_[1-5])(?:=|:|\s*$)/gmu),
      POST_AGENT_TOKEN_KEYS,
    );
  }
  assert.deepEqual([...new Set(validatorTokens ?? [])].sort(), POST_AGENT_TOKEN_KEYS);
});

test('current pilot docs exclude fourth-operator guidance and stale account counts', () => {
  const runbook = read('docs/operations/vps-pilot-runbook.md');
  const pipeline = read('docs/Пайплайн-тестирования.md');
  const zoomRunbook = read('docs/qa/home-zoom-vps-beta-test.md');
  const browserRunbook = read('docs/qa/mac-vps-browser-only.md');

  assert.match(runbook, /9 login-попыток canonical Russian pilot accounts/u);
  assert.doesNotMatch(runbook, /\b10 (?:login-попыток|canonical pilot (?:accounts|logins))\b/u);
  assert.match(runbook, /Нужны девять уникальных\nпаролей аккаунтов/u);
  assert.doesNotMatch(runbook, /Нужны десять уникальных\nпаролей аккаунтов/u);
  assert.match(runbook, /SEED_PILOT_PASSWORD_OPERATOR_4/u);
  assert.match(runbook, /sudo sh -c '\nset -eu\numask 077/u);
  assert.doesNotMatch(runbook, /sudo sh -c '\nset -Eeuo pipefail/u);
  assert.match(runbook, /source_env="\$1"\nnext_env="\$2"/u);
  assert.match(runbook, /trap cleanup EXIT INT TERM/u);
  assert.match(runbook, /awk "!\/\^SEED_PILOT_PASSWORD_OPERATOR_4=\//u);
  assert.match(runbook, /grep -q "\^SEED_PILOT_PASSWORD_OPERATOR_4=/u);
  assert.doesNotMatch(pipeline, /operator \(2,3,4\)/u);
  assert.doesNotMatch(pipeline, /"login":"operator"/u);
  assert.doesNotMatch(pipeline, /Bearer-логин \(`operator`\)/u);
  assert.match(pipeline, /"login":"ахметов булат"/u);
  assert.match(pipeline, /Bearer-логин \(`ахметов булат`\)/u);
  assert.match(pipeline, /seed-operator[\s\S]*Ахметов Булат/u);
  for (const stalePhrase of [
    'назначение `operator → POST-1`',
    'пользователя `operator`',
    'login: operator',
    '`operator → POST-1` стало locked',
    'входит как `operator`',
    'Logout operator → login warehouse',
  ]) {
    assert.equal(zoomRunbook.includes(stalePhrase), false, stalePhrase);
  }
  assert.match(zoomRunbook, /seed-operator \(Ахметов Булат\) → `POST-1`/u);
  assert.doesNotMatch(browserRunbook, /резервирует для неё simulator lane/u);
  assert.match(browserRunbook, /резервирует для него simulator lane/u);
});

test('runbook retires the fourth password key with a portable and fail-closed POSIX script', () => {
  const runbook = read('docs/operations/vps-pilot-runbook.md');
  const innerScript = runbook.match(
    /sudo sh -c '\n(?<script>[\s\S]*?)\n' sh "\$PILOT_ENV" "\$PILOT_ENV_NEXT"/u,
  )?.groups?.script;
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-retired-account-runbook-'));
  const source = resolve(directory, 'pilot.env');
  const temporary = resolve(directory, 'pilot.env.operator-4-retired');
  const original = [
    'APP_ENV=pilot',
    'SEED_PILOT_PASSWORD_OPERATOR=keep-first-password',
    'SEED_PILOT_PASSWORD_OPERATOR_4=retired-test-only-password',
    'SEED_PILOT_PASSWORD_ADMIN=keep-last-password',
    '',
  ].join('\n');
  const expected = original.replace(/^SEED_PILOT_PASSWORD_OPERATOR_4=.*\n/mu, '');

  assert.ok(innerScript, 'runbook must contain an executable POSIX retirement script');
  assert.match(innerScript, /set -eu\numask 077/u);
  assert.match(innerScript, /\[ ! -f "\$source_env" \]/u);
  assert.match(innerScript, /\[ -L "\$source_env" \]/u);
  assert.match(innerScript, /\[ -e "\$next_env" \]/u);
  assert.match(innerScript, /\[ -L "\$next_env" \]/u);
  assert.match(innerScript, /mv -f "\$next_env" "\$source_env"/u);
  assert.doesNotMatch(innerScript, /mv -Tf/u);

  try {
    writeFileSync(source, original, { mode: 0o600 });
    const success = spawnSync('sh', ['-c', innerScript, 'retire-test', source, temporary], {
      encoding: 'utf8',
    });

    assert.equal(success.status, 0, 'retirement script succeeds');
    assert.equal(readFileSync(source, 'utf8'), expected);
    assert.equal(statSync(source).mode & 0o777, 0o600);
    assert.equal(existsSync(temporary), false);
    assert.equal(`${success.stdout}${success.stderr}`, '');

    writeFileSync(source, original, { mode: 0o600 });
    const fakeBin = resolve(directory, 'fake-bin');
    mkdirSync(fakeBin);
    const fakeMv = resolve(fakeBin, 'mv');
    writeFileSync(fakeMv, '#!/bin/sh\nexit 73\n', { mode: 0o700 });
    chmodSync(fakeMv, 0o700);
    const failure = spawnSync('sh', ['-c', innerScript, 'retire-test', source, temporary], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });

    assert.equal(failure.status, 73);
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.equal(existsSync(temporary), false);
    assert.equal(`${failure.stdout}${failure.stderr}`, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('tracked environment template contains no deployable or development secret', () => {
  const example = read('deploy/vps/.env.example');
  assert.match(example, /replace-me/);
  assert.match(example, /^PRODUCTION_COST_RECONCILER_ENABLED=true$/mu);
  assert.doesNotMatch(example, /plenka-dev|agent-post-|postgresql:\/\/plenka:plenka/i);
  assert.doesNotMatch(example, /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
});

test('new pilot pallet documents use the accepted immutable v6 profile', () => {
  const profile = 'pallet-100x100-extended-v6';

  assert.equal(pilotEnvironment().PALLET_LABEL_PROFILE, profile);
  assert.match(
    read('deploy/vps/.env.example'),
    new RegExp(`^PALLET_LABEL_PROFILE=${profile}$`, 'mu'),
  );
  assert.match(
    read('scripts/vps/smoke-local.sh'),
    new RegExp(`'PALLET_LABEL_PROFILE=${profile}'`, 'u'),
  );
});

test('deployment secret filenames are excluded from Git and Docker build contexts', () => {
  const gitIgnore = spawnSync(
    'git',
    ['check-ignore', '--no-index', '--quiet', 'deploy/vps/pilot.env'],
    { cwd: ROOT },
  );
  const trackedExample = spawnSync(
    'git',
    ['check-ignore', '--no-index', '--quiet', 'deploy/vps/.env.example'],
    { cwd: ROOT },
  );
  const dockerIgnore = read('.dockerignore');

  assert.equal(gitIgnore.status, 0, 'pilot.env must be ignored even if copied into the repo');
  assert.notEqual(trackedExample.status, 0, 'tracked .env.example must remain includable');
  assert.match(dockerIgnore, /(?:^|\n)(?:\*\*\/)?\*\.env(?:\n|$)/u);
  assert.match(dockerIgnore, /!\*\*\/\.env\.example/u);
});

test('environment validator accepts a valid pilot file without echoing secrets', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-valid-'));
  try {
    const { path, values } = writeEnvironment(directory);
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /PASS/);
    for (const secretKey of [
      'POSTGRES_ADMIN_PASSWORD',
      'DATABASE_OWNER_PASSWORD',
      'DATABASE_APP_PASSWORD',
      'SEED_PILOT_PASSWORD_ADMIN',
      'SEED_PILOT_AGENT_TOKEN_POST_1',
    ]) {
      assert.doesNotMatch(
        output,
        new RegExp(values[secretKey].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production validator accepts fully disabled 1C without endpoint or credentials', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-onec-disabled-'));
  try {
    const path = resolve(directory, 'pilot.env');
    const values = oneCDisabledPilotEnvironment();
    writeFileSync(
      path,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    );

    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production Compose omits all 1C connection material in disabled mode', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-compose-onec-disabled-'));
  try {
    const path = resolve(directory, 'pilot.env');
    const values = oneCDisabledPilotEnvironment();
    writeFileSync(
      path,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    );

    const config = composeConfig(path);
    const apiEnvironment = config.services.api.environment;

    assert.equal(apiEnvironment.ONEC_LIVE, 'false');
    assert.equal(apiEnvironment.ONEC_WRITE, 'false');
    assert.equal(apiEnvironment.ONEC_SYNC_ENABLED, 'false');
    assert.equal(apiEnvironment.ONEC_FINANCE_SYNC_ENABLED, 'false');
    assert.equal(apiEnvironment.ONEC_PAYMENT_SYNC_ENABLED, 'false');
    assert.equal(apiEnvironment.ONEC_PAYMENT_AUTO_APPLY_ENABLED, 'false');
    assert.equal(apiEnvironment.ONEC_BASE_URL, undefined);
    assert.equal(apiEnvironment.ONEC_USERNAME, undefined);
    assert.equal(apiEnvironment.ONEC_PASSWORD, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment validator accepts the exact enabled warehouse coverage rollout flag', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-coverage-enabled-'));
  try {
    const { path } = writeEnvironment(directory, {
      WAREHOUSE_COVERAGE_V2_ENABLED: 'true',
    });
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment validator accepts the square v4 pallet label profile', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-pallet-square-v4-'));
  try {
    const { path } = writeEnvironment(directory, {
      PALLET_LABEL_PROFILE: 'pallet-100x100-square-v4',
    });
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment validator accepts the browser-only safe v5 pallet label profile', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-pallet-safe-v5-'));
  try {
    const { path } = writeEnvironment(directory, {
      PALLET_LABEL_PROFILE: 'pallet-100x100-safe-v5',
    });
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment validator accepts the browser-only extended v6 pallet label profile', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-pallet-extended-v6-'));
  try {
    const { path } = writeEnvironment(directory, {
      PALLET_LABEL_PROFILE: 'pallet-100x100-extended-v6',
    });
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment validator rejects the undeployed landscape v3 pallet label profile', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-pallet-retired-v3-'));
  try {
    const { path } = writeEnvironment(directory, {
      PALLET_LABEL_PROFILE: 'pallet-100x150-landscape-v3',
    });
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /PALLET_LABEL_PROFILE/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment validator accepts distinct four-digit pilot PINs only with the opt-in flag', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-short-pins-enabled-'));
  try {
    const overrides = { PILOT_SHORT_PASSWORDS_ENABLED: 'true' };
    const accounts = [
      'COMMERCIAL',
      'PRODUCTION',
      'OPERATOR',
      'OPERATOR_2',
      'OPERATOR_3',
      'WAREHOUSE',
      'FINANCE',
      'DIRECTOR',
      'ADMIN',
    ];
    for (const [index, suffix] of accounts.entries()) {
      overrides[`SEED_PILOT_PASSWORD_${suffix}`] = String(1100 + index);
    }
    const { path } = writeEnvironment(directory, overrides);
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment validator rejects enabling 1C stock writes', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-onec-write-'));
  try {
    const { path } = writeEnvironment(directory, {
      ONEC_WRITE: 'true',
      ONEC_WRITE_CONFIRM: 'I_UNDERSTAND_DEMO_1C_STOCK_POSTING',
    });
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment validator rejects scheduled 1C synchronization', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-onec-sync-'));
  try {
    const { path } = writeEnvironment(directory, { ONEC_SYNC_ENABLED: 'true' });
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production validator rejects finance and payment 1C polling', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-compose-onec-finance-sync-'));
  try {
    const { path } = writeEnvironment(directory, {
      ONEC_FINANCE_SYNC_ENABLED: 'true',
      ONEC_FINANCE_SYNC_INTERVAL_MS: '180000',
      ONEC_PAYMENT_AUTO_APPLY_ENABLED: 'true',
      ONEC_PAYMENT_SYNC_ENABLED: 'true',
    });
    const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const host of PUBLIC_HOST_POLICY_VECTORS.accepted) {
  test(`environment validator accepts canonical public host ${host}`, () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-public-host-'));
    try {
      const { path } = writeEnvironment(directory, {
        PUBLIC_HOST: host,
        PUBLIC_ORIGIN: originForHost(host),
      });
      const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('canonical Compose wrapper ignores inherited deployment variables', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-compose-inherited-env-'));
  try {
    const { path, values } = writeEnvironment(directory);
    const config = composeConfigViaCanonicalWrapper(path, {
      AUTH_DEV_XROLE: 'on',
      COMPOSE_PROJECT_NAME: 'override-project',
      DATABASE_URL: 'postgresql://override:override@db:5432/override',
      MIGRATION_DATABASE_URL: 'postgresql://override:override@db:5432/override',
      PLENKA_API_IMAGE: 'evil/image:latest',
      PLENKA_MIGRATION_IMAGE: 'evil/migration:latest',
      PLENKA_WEB_IMAGE: 'evil/web:latest',
      POSTGRES_ADMIN_USER: 'override_admin',
      PUBLIC_HOST: 'override.attacker.test',
      PUBLIC_ORIGIN: 'https://override.attacker.test',
    });

    assert.equal(config.name, values.COMPOSE_PROJECT_NAME);
    assert.equal(config.services.api.image, values.PLENKA_API_IMAGE);
    assert.equal(config.services.migrate.image, values.PLENKA_MIGRATION_IMAGE);
    assert.equal(config.services.web.image, values.PLENKA_WEB_IMAGE);
    assert.equal(config.services.web.environment.PUBLIC_HOST, values.PUBLIC_HOST);
    assert.equal(config.services.api.environment.DATABASE_URL, values.DATABASE_URL);
    assert.equal(config.services.migrate.environment.DATABASE_URL, values.MIGRATION_DATABASE_URL);
    assert.equal(config.services.db.environment.POSTGRES_USER, values.POSTGRES_ADMIN_USER);
    assert.equal(config.services.api.environment.AUTH_DEV_XROLE, values.AUTH_DEV_XROLE);
    assert.equal(
      config.services.api.environment.PALLET_LABEL_PROFILE,
      'pallet-100x100-extended-v6',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'missing required value', overrides: { PUBLIC_HOST: '' } },
  {
    name: 'omitted pallet label profile',
    mutate(values) {
      delete values.PALLET_LABEL_PROFILE;
    },
  },
  {
    name: 'invalid pallet label profile',
    overrides: { PALLET_LABEL_PROFILE: 'pallet-100x150-v2' },
  },
  {
    name: 'omitted warehouse coverage rollout flag',
    mutate(values) {
      delete values.WAREHOUSE_COVERAGE_V2_ENABLED;
    },
  },
  {
    name: 'empty warehouse coverage rollout flag',
    overrides: { WAREHOUSE_COVERAGE_V2_ENABLED: '' },
  },
  {
    name: 'numeric warehouse coverage rollout flag',
    overrides: { WAREHOUSE_COVERAGE_V2_ENABLED: '1' },
  },
  {
    name: 'title-case warehouse coverage rollout flag',
    overrides: { WAREHOUSE_COVERAGE_V2_ENABLED: 'False' },
  },
  {
    name: 'upper-case warehouse coverage rollout flag',
    overrides: { WAREHOUSE_COVERAGE_V2_ENABLED: 'TRUE' },
  },
  {
    name: 'invalid pilot short-password flag',
    overrides: { PILOT_SHORT_PASSWORDS_ENABLED: 'TRUE' },
  },
  {
    name: 'omitted production cost reconciler flag',
    mutate(values) {
      delete values.PRODUCTION_COST_RECONCILER_ENABLED;
    },
  },
  {
    name: 'disabled production cost reconciler flag',
    overrides: { PRODUCTION_COST_RECONCILER_ENABLED: 'false' },
  },
  {
    name: 'omitted scheduled 1C sync flag',
    mutate(values) {
      delete values.ONEC_SYNC_ENABLED;
    },
  },
  {
    name: 'omitted finance invoice sync flag',
    mutate(values) {
      delete values.ONEC_FINANCE_SYNC_ENABLED;
    },
  },
  {
    name: 'omitted finance sync interval',
    mutate(values) {
      delete values.ONEC_FINANCE_SYNC_INTERVAL_MS;
    },
  },
  {
    name: 'enabled finance invoice sync without an exact 1C reference field',
    overrides: {
      ONEC_FINANCE_SYNC_ENABLED: 'true',
      ONEC_INVOICE_ORDER_REFERENCE_FIELD: '',
    },
  },
  {
    name: 'omitted payment sync flag',
    mutate(values) {
      delete values.ONEC_PAYMENT_SYNC_ENABLED;
    },
  },
  {
    name: 'omitted payment auto-apply flag',
    mutate(values) {
      delete values.ONEC_PAYMENT_AUTO_APPLY_ENABLED;
    },
  },
  {
    name: 'non-canonical finance invoice sync flag',
    overrides: { ONEC_FINANCE_SYNC_ENABLED: 'TRUE' },
  },
  {
    name: 'non-canonical payment sync flag',
    overrides: { ONEC_PAYMENT_SYNC_ENABLED: 'TRUE' },
  },
  {
    name: 'non-canonical payment auto-apply flag',
    overrides: { ONEC_PAYMENT_AUTO_APPLY_ENABLED: 'TRUE' },
  },
  {
    name: 'payment auto-apply without payment sync',
    overrides: {
      ONEC_PAYMENT_AUTO_APPLY_ENABLED: 'true',
      ONEC_PAYMENT_SYNC_ENABLED: 'false',
    },
  },
  { name: 'short finance sync interval', overrides: { ONEC_FINANCE_SYNC_INTERVAL_MS: '59999' } },
  {
    name: 'large finance sync interval',
    overrides: { ONEC_FINANCE_SYNC_INTERVAL_MS: '86400001' },
  },
  { name: 'non-canonical scheduled 1C sync flag', overrides: { ONEC_SYNC_ENABLED: 'TRUE' } },
  {
    name: 'scheduled 1C sync with writes enabled',
    overrides: {
      ONEC_SYNC_ENABLED: 'true',
      ONEC_WRITE: 'true',
      ONEC_WRITE_CONFIRM: 'I_UNDERSTAND_DEMO_1C_STOCK_POSTING',
    },
  },
  { name: 'short scheduled 1C interval', overrides: { ONEC_SYNC_INTERVAL_MS: '59999' } },
  { name: 'large scheduled 1C interval', overrides: { ONEC_SYNC_INTERVAL_MS: '86400001' } },
  { name: 'small scheduled 1C page', overrides: { ONEC_SYNC_PAGE_SIZE: '49' } },
  { name: 'large scheduled 1C page', overrides: { ONEC_SYNC_PAGE_SIZE: '501' } },
  { name: 'enabled live 1C adapter', overrides: { ONEC_LIVE: 'true' } },
  { name: 'missing 1C endpoint', overrides: { ONEC_BASE_URL: '' } },
  { name: 'insecure 1C endpoint', overrides: { ONEC_BASE_URL: 'http://onec.example.test/odata' } },
  { name: 'missing 1C username', overrides: { ONEC_USERNAME: '' } },
  { name: 'missing 1C password', overrides: { ONEC_PASSWORD: '' } },
  { name: 'unconfirmed 1C write', overrides: { ONEC_WRITE: 'true' } },
  { name: 'non-topology API port', overrides: { PORT: '4000' } },
  { name: 'known development value', overrides: { SEED_PILOT_PASSWORD_ADMIN: 'plenka-dev' } },
  {
    name: 'overlong pilot password',
    overrides: { SEED_PILOT_PASSWORD_ADMIN: `Pilot_${'A'.repeat(123)}` },
  },
  { name: 'octal-looking retention count', overrides: { BACKUP_RETENTION_COUNT: '010' } },
  { name: 'invalid-octal retention count', overrides: { BACKUP_RETENTION_COUNT: '08' } },
  { name: 'filesystem backup root', overrides: { BACKUP_DIR: '/' } },
  { name: 'system backup root', overrides: { BACKUP_DIR: '/etc' } },
  { name: 'shared application parent as backup root', overrides: { BACKUP_DIR: '/opt' } },
  {
    name: 'repository release tree as backup root',
    overrides: { BACKUP_DIR: resolve(ROOT, 'deploy/vps/backups') },
  },
  {
    name: 'PostgreSQL maintenance database postgres',
    mutate(values) {
      values.POSTGRES_DB = 'postgres';
      values.DATABASE_URL = `postgresql://${values.DATABASE_APP_USER}:${values.DATABASE_APP_PASSWORD}@db:5432/postgres?schema=public`;
      values.MIGRATION_DATABASE_URL = `postgresql://${values.DATABASE_OWNER_USER}:${values.DATABASE_OWNER_PASSWORD}@db:5432/postgres?schema=public`;
    },
  },
  {
    name: 'PostgreSQL template database template1',
    mutate(values) {
      values.POSTGRES_DB = 'template1';
      values.DATABASE_URL = `postgresql://${values.DATABASE_APP_USER}:${values.DATABASE_APP_PASSWORD}@db:5432/template1?schema=public`;
      values.MIGRATION_DATABASE_URL = `postgresql://${values.DATABASE_OWNER_USER}:${values.DATABASE_OWNER_PASSWORD}@db:5432/template1?schema=public`;
    },
  },
  {
    name: 'duplicate bootstrap values',
    mutate(values) {
      values.SEED_PILOT_PASSWORD_ADMIN = values.SEED_PILOT_PASSWORD_DIRECTOR;
    },
  },
  {
    name: 'duplicate database credentials',
    mutate(values) {
      values.DATABASE_OWNER_PASSWORD = values.POSTGRES_ADMIN_PASSWORD;
      values.MIGRATION_DATABASE_URL = `postgresql://${values.DATABASE_OWNER_USER}:${values.DATABASE_OWNER_PASSWORD}@db:5432/${values.POSTGRES_DB}?schema=public`;
    },
  },
  {
    name: 'noncanonical agent token',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: 'agent-post-1' },
  },
  {
    name: 'agent token with invalid base64url alphabet',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: `ptk_${randomBytes(32).toString('base64url')}+` },
  },
  {
    name: 'padded agent token',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: `ptk_${randomBytes(32).toString('base64url')}=` },
  },
  {
    name: 'non-canonical base64url agent token',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: nonCanonicalPilotToken() },
  },
  {
    name: 'agent token shorter than 32 decoded bytes',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: `ptk_${randomBytes(31).toString('base64url')}` },
  },
  {
    name: '32-character repeated-pattern agent token',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: `ptk_${'abcdefgh'.repeat(4)}` },
  },
  {
    name: 'longer repeated-pattern agent token',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: `ptk_${'abcdefgh'.repeat(6)}` },
  },
  {
    name: 'low-entropy agent token',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: `ptk_${'A'.repeat(37)}BCDEFGH` },
  },
  {
    name: 'repeated-block agent token',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: `ptk_${'Ab3_xY9-kLmN0pQr'.repeat(3)}` },
  },
  {
    name: 'one-character agent-token payload',
    overrides: { SEED_PILOT_AGENT_TOKEN_POST_1: `ptk_${'A'.repeat(44)}` },
  },
  {
    name: 'Compose dollar interpolation',
    overrides: { PUBLIC_HOST: '$PUBLIC_HOST', PUBLIC_ORIGIN: 'https://$PUBLIC_HOST' },
  },
  {
    name: 'Caddy whitespace tokens',
    overrides: {
      PUBLIC_HOST: 'pilot.example.test extra',
      PUBLIC_ORIGIN: 'https://pilot.example.test extra',
    },
  },
  { name: 'Caddy braces', overrides: { ACME_EMAIL: 'ops{env}@example.test' } },
  {
    name: 'quoted env value',
    overrides: {
      PUBLIC_HOST: '"pilot.example.test"',
      PUBLIC_ORIGIN: '"https://pilot.example.test"',
    },
  },
  { name: 'mutable image tag', overrides: { PLENKA_API_IMAGE: 'plenka-api:stable' } },
  { name: 'malformed project name', overrides: { COMPOSE_PROJECT_NAME: 'Plenka Pilot' } },
  { name: 'malformed ACME email', overrides: { ACME_EMAIL: 'ops@@example.test' } },
  {
    name: 'invalid IPv4 host',
    overrides: { PUBLIC_HOST: '999.0.0.1', PUBLIC_ORIGIN: 'https://999.0.0.1' },
  },
  {
    name: 'loopback IPv4 host',
    overrides: { PUBLIC_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://127.0.0.1' },
  },
  {
    name: 'unspecified IPv4 host',
    overrides: { PUBLIC_HOST: '0.0.0.0', PUBLIC_ORIGIN: 'https://0.0.0.0' },
  },
  ...PUBLIC_HOST_POLICY_VECTORS.rejected.map((host) => ({
    name: `non-public or non-canonical host ${host}`,
    overrides: { PUBLIC_HOST: host, PUBLIC_ORIGIN: originForHost(host) },
  })),
]) {
  test(`environment validator rejects ${scenario.name} without leaking the value`, () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'plenka-env-invalid-'));
    try {
      const generated = pilotEnvironment();
      scenario.mutate?.(generated);
      const path = resolve(directory, 'pilot.env');
      const values = { ...generated, ...scenario.overrides };
      writeFileSync(
        path,
        `${Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n')}\n`,
        { mode: 0o600 },
      );
      const result = spawnSync(VALIDATOR, [path], { encoding: 'utf8' });
      assert.ok(
        Number.isInteger(result.status) && result.status !== 0,
        result.error?.message ?? 'validator must execute and reject the file',
      );
      const output = `${result.stdout}${result.stderr}`;
      for (const value of Object.values(values).filter((value) => value.length >= 24)) {
        assert.equal(
          output.includes(value),
          false,
          'validator output leaked a long environment value',
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('backup and restore scripts encode atomic checksum and disposable recovery invariants', () => {
  const backup = read('scripts/vps/backup.sh');
  const restore = read('scripts/vps/restore.sh');
  assert.match(backup, /flock/);
  assert.match(backup, /pg_dump/);
  assert.match(backup, /--format=custom/);
  assert.match(backup, /sha256/);
  assert.match(backup, /mv\s+--?/);
  assert.ok(backup.lastIndexOf('apply_retention') > backup.indexOf('restore.sh'));
  assert.match(backup, /\.complete/);
  assert.match(restore, /pg_restore/);
  assert.match(restore, /_prisma_migrations/);
  assert.match(restore, /DROP DATABASE/);
  assert.match(restore, /trap/);
  assert.match(restore, /trap 'exit 129' HUP/);
  assert.match(restore, /trap 'exit 130' INT/);
  assert.match(restore, /trap 'exit 143' TERM/);
  assert.match(restore, /trap '' HUP INT TERM/);
  assert.match(restore, /RESTORE_LIVE_PLENKA/);
  assert.match(restore, /--check-migrate/);
  assert.match(restore, /run --rm --no-deps --pull never migrate/);
  assert.match(restore, /migration_rehearsal_pre/);
  assert.match(restore, /migration_rehearsal_post/);
  assert.match(restore, /GRANT EXECUTE ON FUNCTION public\.hard_delete_commercial_order/);
  assert.match(restore, /expected_uid=0/);
  assert.match(restore, /expected_uid="\$\(id -u\)"/);
  assert.match(restore, /"\$links" == 1/);
  assert.equal(restore.match(/create_owned_disposable_database "\$restore_database"/gu)?.length, 2);
  assert.match(restore, /maintenance\.lock/);
  assert.match(restore, /--lock-held/);
  assert.doesNotMatch(restore, /\b(?:seed|down)\b/);
});

test('fresh pilot database archive is explicit, backup-bound and rejects physical facts', () => {
  const archive = read('scripts/vps/fresh-pilot-database.sh');

  assert.match(archive, /--confirm-archive/);
  assert.match(archive, /\.complete/);
  assert.match(archive, /checksum sidecar does not name the selected backup artifact/);
  assert.match(archive, /restore\.sh" --check "\$backup_artifact"/);
  assert.match(archive, /\.maintenance\.lock/);
  assert.match(archive, /flock -n 9/);
  assert.match(archive, /-mmin -240/);
  assert.match(archive, /for service in api web/);
  assert.match(archive, /must be stopped before archiving the pilot database/);
  for (const table of [
    'operator_post_sessions',
    'shift_bag_usages',
    'gateway_commands',
    'weight_captures',
    'operator_roll_operations',
    'label_print_jobs',
  ]) {
    assert.match(archive, new RegExp(table));
  }
  assert.match(archive, /pilot database archive blocked by active or physical facts/);
});

test('pilot demo reset is backup-bound, owner-only and restarts the maintenance window', () => {
  const reset = read('scripts/vps/reset-pilot-demo.sh');

  assert.match(reset, /--confirm[^\n]+RESET_PILOT_DEMO_DATA/u);
  assert.match(reset, /\.maintenance\.lock/u);
  assert.match(reset, /backup\.sh"[^\n]+--check[^\n]+--lock-held/u);
  assert.match(reset, /compose stop api web/u);
  assert.match(reset, /--profile maintenance run --rm/u);
  assert.match(reset, /PILOT_DEMO_RESET_CONFIRM=RESET_PILOT_DEMO_DATA/u);
  assert.match(reset, /PILOT_GATEWAYS_STOPPED/u);
  assert.match(reset, /reset_committed/u);
  assert.match(reset, /validation_passed/u);
  assert.match(reset, /leave api\/web stopped/u);
  assert.match(reset, /tail -n 1/u);
  assert.match(reset, /reset-pilot-demo/u);
  assert.match(reset, /compose up -d --wait api web/u);
  assert.match(reset, /commercial_orders/u);
  assert.match(reset, /counterparty_templates=2/u);
  assert.match(reset, /stock_templates=1/u);
  assert.match(reset, /invalid_template_dimensions=0/u);
  assert.match(reset, /jsonb_array_elements/u);
  assert.match(reset, /production_problems/u);
  assert.match(reset, /notification_receipts/u);
  assert.match(reset, /big_bag_units=0/u);
  assert.match(reset, /big_bag_scan_tokens=0/u);
  assert.match(reset, /big_bag_movements=0/u);
  assert.match(reset, /big_bag_label_print_jobs=0/u);
  assert.ok(existsSync(RESET_PILOT_DEMO));
});

test('pilot order-history purge is backup-bound, externally verified and fail-closed', () => {
  const purge = read('scripts/vps/purge-pilot-order-history.sh');

  assert.match(purge, /--confirm[^\n]+PURGE_PILOT_ORDER_HISTORY/u);
  assert.match(purge, /PILOT_GATEWAYS_STOPPED[^\n]+yes/u);
  assert.match(purge, /PILOT_OFFHOST_BACKUP_VERIFIED[^\n]+yes/u);
  assert.match(purge, /PILOT_OFFHOST_BACKUP_REFERENCE/u);
  assert.match(purge, /^#!\/bin\/bash -p$/mu);
  assert.match(purge, /^#!\/bin\/bash -p\n\nif \[\[/u);
  assert.match(purge, /unset BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH/u);
  assert.match(purge, /if \[\[ "\$-" == \*p\* && "\$EUID" =~ \^\[0-9\]\+\$ && "\$EUID" == 0/u);
  assert.match(purge, /"\$\(<\/proc\/self\/status\)" =~ \(\^\|\$'\\n'\)Uid:/u);
  assert.match(
    purge,
    /"\$\{BASH_VERSINFO\[999\]:\?ERROR: pilot order-history purge must run from a root owner shell\}"/u,
  );
  assert.doesNotMatch(purge, /builtin|declare -p|while read|\/usr\/bin\/id|\$\(id\b/u);
  assert.doesNotMatch(purge, /root_gate_ok/u);
  assert.match(purge, /unset PLENKA_LOCAL_SMOKE/u);
  assert.doesNotMatch(purge, /PLENKA_TEST_EFFECTIVE_UID/u);
  const helperSourceIndex = purge.indexOf('source "$SCRIPT_DIR/lib.sh"');
  const rootGateStartIndex = purge.indexOf('if [[ "$-" == *p*');
  const rootGateElseIndex = purge.lastIndexOf('\nelse\n');
  assert.ok(helperSourceIndex > rootGateStartIndex);
  assert.ok(helperSourceIndex < rootGateElseIndex);
  assert.ok(helperSourceIndex > purge.indexOf('unset PLENKA_LOCAL_SMOKE'));
  assert.match(purge, /\.maintenance\.lock/u);
  assert.match(purge, /backup\.sh"[^\n]+--check[^\n]+--lock-held/u);
  assert.match(purge, /backup\.sh"[^\n]+--check[^\n]+--lock-held[^\n]+--no-retention/u);
  assert.match(purge, /compose stop api web/u);
  assert.match(purge, /--profile maintenance run --rm/u);
  assert.match(purge, /PILOT_ORDER_HISTORY_PURGE_CONFIRM=PURGE_PILOT_ORDER_HISTORY/u);
  assert.match(purge, /--include-accumulated-runtime[\s\S]+PURGE_ACCUMULATED_RUNTIME/u);
  assert.match(purge, /PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRM=PURGE_ACCUMULATED_RUNTIME/u);
  assert.match(purge, /purge-pilot-order-history/u);
  assert.match(purge, /leave api\/web stopped/u);
  assert.match(purge, /Restore instruction/u);
  assert.match(purge, /restore\.sh/u);
  assert.match(purge, /--live/u);
  assert.match(purge, /compose up -d --wait api web/u);
  assert.match(purge, /role_inbox_events=0/u);
  assert.match(purge, /notification_receipts=0/u);
  assert.match(purge, /gateway_unsafe_commands=0/u);
  assert.match(purge, /unsafe_print_jobs=0/u);
  assert.match(purge, /onec_active_runs=0/u);
  assert.match(purge, /sync_journal_active_claims=0/u);
  assert.match(
    purge,
    /sync_journals[\s\S]+status NOT IN \('ready', 'error'\)[\s\S]+"activeScopeKey" IS NOT NULL[\s\S]+"leaseExpiresAt" IS NOT NULL/u,
  );
  assert.match(purge, /active_layout_fingerprint/u);
  assert.match(purge, /big_bag_physical/u);
  assert.match(purge, /accumulated_runtime_rows=0/u);
  assert.match(purge, /payroll_tariff_fingerprint/u);
  assert.match(purge, /_prisma_migrations/u);
  assert.match(purge, /operational_checks[\s\S]+operational_incidents/u);
  assert.doesNotMatch(purge, /\bTRUNCATE\b|\bCASCADE\b|reset-pilot-demo|db:seed/u);
  assert.match(read('scripts/vps/backup.sh'), /NO_RETENTION[\s\S]+apply_retention/u);
  assert.ok(existsSync(PURGE_PILOT_ORDER_HISTORY));
});

test('pilot purge rejects hostile Bash startup traps before Docker', (t) => {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    t.skip('non-root rejection requires a non-root test process');
    return;
  }
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.purge-nonroot.'));
  const binDirectory = resolve(directory, 'bin');
  const dockerLog = resolve(directory, 'docker.log');
  mkdirSync(binDirectory);
  const { path: environmentPath } = writeEnvironment(directory);
  const fakeDocker = resolve(binDirectory, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >>"\${PLENKA_TEST_DOCKER_LOG:?}"
exit 0
`,
  );
  chmodSync(fakeDocker, 0o755);
  const bashEnvironment = resolve(directory, 'hostile-bash-env.sh');
  writeFileSync(
    bashEnvironment,
    `builtin() {
  case "\${1-}" in
    declare) printf '%s\\n' 'declare -ir EUID="0"' ;;
    read)
      key='Uid:'
      real_uid=0
      effective_uid=0
      saved_uid=0
      filesystem_uid=0
      ;;
  esac
}
declare() { :; }
read() {
  :
}
 :() { return 0; }
exit() { return 0; }
command() { return 0; }
root_gate_ok=1
trap 'root_gate_ok=1; set -p' DEBUG
trap 'root_gate_ok=1' RETURN
trap 'root_gate_ok=1' ERR
`,
    { mode: 0o600 },
  );

  try {
    const outputs = [];
    for (const args of [
      [PURGE_PILOT_ORDER_HISTORY, '--confirm', 'PURGE_PILOT_ORDER_HISTORY'],
      ['-p', PURGE_PILOT_ORDER_HISTORY, '--confirm', 'PURGE_PILOT_ORDER_HISTORY'],
    ]) {
      const result = spawnSync('/bin/bash', args, {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
          BASH_ENV: bashEnvironment,
          PLENKA_ENV_FILE: environmentPath,
          EUID: '0',
          UID: '0',
          PLENKA_LOCAL_SMOKE: '1',
          PLENKA_TEST_EFFECTIVE_UID: '0',
          PLENKA_TEST_DOCKER_LOG: dockerLog,
          PILOT_GATEWAYS_STOPPED: 'yes',
          PILOT_OFFHOST_BACKUP_VERIFIED: 'yes',
          PILOT_OFFHOST_BACKUP_REFERENCE: `plenka-20260812T000000Z.dump:${'a'.repeat(64)}`,
        },
      });
      const output = `${result.stdout}${result.stderr}`;

      assert.notEqual(result.status, 0);
      outputs.push(output);
    }
    assert.equal(existsSync(dockerLog), false, 'hostile startup traps must not reach Docker');
    for (const output of outputs) {
      assert.match(output, /must run from a root owner shell/u);
      assert.doesNotMatch(output, /Environment validation/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pilot purge fails closed when the kernel EUID source is unavailable', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.purge-uid-probe.'));
  const harness = resolve(directory, 'purge-uid-probe-harness.sh');
  try {
    const source = readFileSync(PURGE_PILOT_ORDER_HISTORY, 'utf8');
    const euidGuard = '"$EUID" =~ ^[0-9]+$ && "$EUID" == 0 &&';
    assert.ok(source.includes(euidGuard));
    writeFileSync(
      harness,
      source
        .replace(euidGuard, '1 == 1 &&')
        .replaceAll('/proc/self/status', '/missing/plenka-status'),
      {
        mode: 0o700,
      },
    );
    const result = spawnSync(harness, ['--confirm', 'PURGE_PILOT_ORDER_HISTORY'], {
      encoding: 'utf8',
      env: { ...process.env, BASH_ENV: '' },
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /must run from a root owner shell/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function purgeRestartFailureFixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.purge-restart.'));
  const backupDirectory = resolve(directory, 'backups');
  const binDirectory = resolve(directory, 'bin');
  const dockerLog = resolve(directory, 'docker.log');
  const serviceState = resolve(directory, 'service.state');
  mkdirSync(backupDirectory, { mode: 0o700 });
  mkdirSync(binDirectory);
  writeFileSync(serviceState, 'running\n', { mode: 0o600 });
  const { path: environmentPath } = writeEnvironment(directory, {
    BACKUP_DIR: backupDirectory,
  });
  const purgeHarness = resolve(directory, 'purge-restart-harness.sh');
  const rootGate = [
    'if [[ "$-" == *p* && "$EUID" =~ ^[0-9]+$ && "$EUID" == 0 &&',
    `  "$(</proc/self/status)" =~ (^|$'\\n')Uid:[[:blank:]]+[0-9]+[[:blank:]]+0[[:blank:]]+[0-9]+[[:blank:]]+[0-9]+($|$'\\n') ]]; then`,
  ].join('\n');
  const smokeSanitizer = 'unset PLENKA_LOCAL_SMOKE';
  const scriptDirectoryAssignment = 'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"';
  let harnessSource = readFileSync(PURGE_PILOT_ORDER_HISTORY, 'utf8');
  assert.ok(harnessSource.includes(rootGate), 'production purge root gate must be instrumentable');
  assert.ok(
    harnessSource.includes(smokeSanitizer),
    'production purge smoke sanitizer must be instrumentable',
  );
  assert.ok(
    harnessSource.includes(scriptDirectoryAssignment),
    'production purge SCRIPT_DIR must be instrumentable',
  );
  harnessSource = harnessSource
    .replace(
      rootGate,
      "if [[ 1 == 1 ]]; then\n  : 'test harness: production root gate is exercised separately'",
    )
    .replace(smokeSanitizer, 'export PLENKA_LOCAL_SMOKE=1')
    .replace(
      scriptDirectoryAssignment,
      `SCRIPT_DIR=${JSON.stringify(resolve(ROOT, 'scripts/vps'))}`,
    );
  writeFileSync(purgeHarness, harnessSource, { mode: 0o700 });

  const fakeDocker = resolve(binDirectory, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"\${PLENKA_TEST_DOCKER_LOG:?}"
if [[ \${1-} == info ]]; then exit 0; fi
if [[ \${1-} == compose && \${2-} == version ]]; then exit 0; fi
args=" $* "
case "$args" in
  *' ps --status running -q api '*|*' ps --status running -q web '*)
    [[ "$(cat "\${PLENKA_TEST_SERVICE_STATE:?}")" == running ]] && printf '%s\n' 'container-id'
    ;;
  *' stop api web '*) printf '%s\n' 'stopped' >"\${PLENKA_TEST_SERVICE_STATE:?}" ;;
  *' exec -T db pg_dump '*) printf '%s\n' 'synthetic-purge-backup' ;;
  *' exec -T db pg_restore '*) cat >/dev/null ;;
  *' exec -T db psql '*)
    input="$(cat)"
    if [[ "$args" == *'_prisma_migrations'* ]]; then
      printf '%s\n' '1'
    elif [[ "$input" == *"SELECT 'users='"* ]]; then
      printf '%s\n' 'users=fingerprint' 'migrations=fingerprint' 'access=fingerprint' \
        'catalogs=fingerprint' 'topology=fingerprint' 'raw_stock=fingerprint' \
        'big_bag_physical=fingerprint' 'shift_big_bag=fingerprint' \
        'defect_bag_physical=fingerprint' 'spoolMovementPhysical=fingerprint' \
        'shift_physical=fingerprint' 'payroll_tariff_fingerprint=fingerprint' \
        'onec_reference=fingerprint' \
        'onec_freshness=fingerprint' 'coverage_epoch=fingerprint' \
        'active_layout_fingerprint=fingerprint'
    elif [[ "$input" == *"order_runtime_rows="* ]]; then
      printf '%s\n' 'order_runtime_rows=0' 'notification_receipts=0' \
        'role_inbox_events=0' 'gateway_unsafe_commands=0' 'unsafe_print_jobs=0' 'gateway_commands=0' \
          'gateway_events=0' 'onec_active_runs=0' 'sync_journal_active_claims=0' \
          'template_usage_nonzero=0' 'accumulated_runtime_rows=0' \
          'accumulated_runtime_events=0' \
        'spool_movements_with_deleted_defect=0'
    fi
    ;;
  *' --profile maintenance run --rm '*) exit 0 ;;
  *' up -d --wait api web '*)
    printf '%s\n' 'restart-attempted' >>"\${PLENKA_TEST_DOCKER_LOG:?}"
    exit 73
    ;;
esac
exit 0
`,
  );
  chmodSync(fakeDocker, 0o755);
  const fakeFlock = resolve(binDirectory, 'flock');
  writeFileSync(fakeFlock, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeFlock, 0o755);

  return {
    dockerLog,
    serviceState,
    run(args = ['--confirm', 'PURGE_PILOT_ORDER_HISTORY']) {
      return spawnSync(purgeHarness, args, {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
          PLENKA_ENV_FILE: environmentPath,
          PLENKA_TEST_DOCKER_LOG: dockerLog,
          PLENKA_TEST_SERVICE_STATE: serviceState,
          PILOT_GATEWAYS_STOPPED: 'yes',
          PILOT_OFFHOST_BACKUP_VERIFIED: 'yes',
          PILOT_OFFHOST_BACKUP_REFERENCE: `plenka-20260812T000000Z.dump:${'a'.repeat(64)}`,
        },
      });
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('pilot purge requires and forwards the second confirmation for accumulated runtime', () => {
  const fixture = purgeRestartFailureFixture();
  try {
    const wrong = fixture.run([
      '--confirm',
      'PURGE_PILOT_ORDER_HISTORY',
      '--include-accumulated-runtime',
      'wrong',
    ]);
    assert.notEqual(wrong.status, 0);
    assert.match(`${wrong.stdout}${wrong.stderr}`, /usage:/u);
    assert.equal(existsSync(fixture.dockerLog), false);

    const result = fixture.run([
      '--confirm',
      'PURGE_PILOT_ORDER_HISTORY',
      '--include-accumulated-runtime',
      'PURGE_ACCUMULATED_RUNTIME',
    ]);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, 'the fixture must reach its injected restart failure');
    assert.match(
      readFileSync(fixture.dockerLog, 'utf8'),
      /PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRM=PURGE_ACCUMULATED_RUNTIME/u,
    );
    assert.match(output, /purge did not reach PASS; leave api\/web stopped/u);
  } finally {
    fixture.cleanup();
  }
});

test('pilot purge keeps services stopped and prints recovery when restart itself fails', () => {
  const fixture = purgeRestartFailureFixture();
  try {
    const result = fixture.run();
    const output = `${result.stdout}${result.stderr}`;

    assert.notEqual(result.status, 0, 'injected compose restart failure must propagate');
    assert.equal(readFileSync(fixture.serviceState, 'utf8').trim(), 'stopped', output);
    assert.match(readFileSync(fixture.dockerLog, 'utf8'), /restart-attempted/u);
    assert.match(output, /purge did not reach PASS; leave api\/web stopped/u);
    assert.match(output, /Restore instruction:[\s\S]+restore\.sh[\s\S]+--live/u);
    assert.doesNotMatch(output, /Pilot order-history purge: PASS/u);
  } finally {
    fixture.cleanup();
  }
});

test('fresh pilot database archive preserves the old database and encodes rollback grants', () => {
  const archive = read('scripts/vps/fresh-pilot-database.sh');

  assert.match(archive, /ALTER DATABASE %I RENAME TO %I/);
  assert.match(archive, /CREATE DATABASE %I OWNER %I/);
  assert.match(archive, /DROP DATABASE IF EXISTS %I WITH \(FORCE\)/);
  assert.match(archive, /ALTER SCHEMA public OWNER TO %I/);
  assert.match(archive, /ALTER DEFAULT PRIVILEGES FOR ROLE %I/);
  assert.match(archive, /rollback\(\)[\s\S]*verify_original_state/);
  assert.match(archive, /ALLOW_CONNECTIONS false/);
  assert.match(archive, /ALLOW_CONNECTIONS true/);
  assert.match(archive, /state=%s/);
  assert.match(archive, /on_signal\(\)[\s\S]*exit "\$status"/);
  assert.match(archive, /pilot\.legacy\.database/);
  assert.doesNotMatch(archive, /down\s+--volumes|down\s+-v/);
  assert.doesNotMatch(archive, /DROP DATABASE[^\n]*legacy_name/);
});

function freshArchiveFixture({
  databaseName = 'plenka_pilot',
  databaseDriverExit = '0',
  flockExit = '0',
  checksumTarget = 'selected',
} = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.'));
  const backupDirectory = resolve(directory, 'backups');
  const binDirectory = resolve(directory, 'bin');
  const dockerLog = resolve(directory, 'docker.log');
  const databaseInput = resolve(directory, 'database-driver.sql');
  const marker = resolve(directory, 'pilot.legacy.database');
  mkdirSync(backupDirectory, { mode: 0o700 });
  mkdirSync(binDirectory);

  const databasePassword = 'DatabasePassword_0123456789abcdef';
  const ownerPassword = 'OwnerPassword_0123456789abcdef';
  const { path: environmentPath } = writeEnvironment(directory, {
    BACKUP_DIR: backupDirectory,
    POSTGRES_DB: databaseName,
    DATABASE_URL: `postgresql://plenka_app:${databasePassword}@db:5432/${databaseName}?schema=public`,
    MIGRATION_DATABASE_URL: `postgresql://plenka_owner:${ownerPassword}@db:5432/${databaseName}?schema=public`,
  });

  const timestamp = new Date()
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const artifact = resolve(backupDirectory, `plenka-${timestamp}.dump`);
  const otherArtifact = resolve(backupDirectory, 'plenka-20000101T000000Z.dump');
  const payload = 'synthetic checked pilot dump';
  writeFileSync(artifact, payload, { mode: 0o600 });
  writeFileSync(otherArtifact, payload, { mode: 0o600 });
  const sidecarName =
    checksumTarget === 'selected' ? artifact.split('/').at(-1) : otherArtifact.split('/').at(-1);
  writeFileSync(`${artifact}.sha256`, `${sha256(payload)}  ${sidecarName}\n`, { mode: 0o600 });
  writeFileSync(`${artifact}.complete`, 'complete\n', { mode: 0o600 });

  const fakeDocker = resolve(binDirectory, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"\${FAKE_DOCKER_LOG:?}"
if [[ \${1-} == info ]]; then exit 0; fi
if [[ \${1-} == compose && \${2-} == version ]]; then exit 0; fi
case " $* " in
  *' ps --all -q api '*|*' ps --all -q web '*) exit 0 ;;
  *' exec -T db pg_restore '*)
    printf '%s\n' 'RESTORE_CHECK' >>"\${FAKE_DOCKER_LOG:?}"
    cat >/dev/null
    exit 0
    ;;
  *'_prisma_migrations'*) printf '%s\n' '1'; exit 0 ;;
  *' exec -T db sh -s -- '*)
    printf '%s\n' 'MAIN_DATABASE_DRIVER' >>"\${FAKE_DOCKER_LOG:?}"
    cat >"\${FAKE_DATABASE_INPUT:?}"
    exit "\${FAKE_DATABASE_DRIVER_EXIT:-0}"
    ;;
esac
exit 0
`,
  );
  chmodSync(fakeDocker, 0o755);

  const fakeFlock = resolve(binDirectory, 'flock');
  writeFileSync(
    fakeFlock,
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' 'FLOCK' >>"\${FAKE_DOCKER_LOG:?}"
exit "\${FAKE_FLOCK_EXIT:-0}"
`,
  );
  chmodSync(fakeFlock, 0o755);

  // Prevent the RED baseline from writing its hard-coded production marker on the host.
  const fakeInstall = resolve(binDirectory, 'install');
  writeFileSync(fakeInstall, '#!/usr/bin/env bash\nexit 90\n');
  chmodSync(fakeInstall, 0o755);

  const baseEnvironment = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
    PLENKA_ENV_FILE: environmentPath,
    PLENKA_LOCAL_SMOKE: '1',
    PLENKA_FRESH_DB_MARKER: marker,
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_DATABASE_INPUT: databaseInput,
    FAKE_DATABASE_DRIVER_EXIT: databaseDriverExit,
    FAKE_FLOCK_EXIT: flockExit,
  };

  return {
    artifact,
    databaseInput,
    dockerLog,
    marker,
    run(overrides = {}) {
      return spawnSync(FRESH_PILOT_DATABASE, ['--confirm-archive', artifact], {
        encoding: 'utf8',
        env: { ...baseEnvironment, ...overrides },
      });
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('fresh archive rejects a checksum sidecar bound to another artifact before DB access', () => {
  const fixture = freshArchiveFixture({ checksumTarget: 'other' });
  try {
    const result = fixture.run();
    assert.notEqual(result.status, 0, 'mismatched sidecar target must be rejected');
    assert.match(`${result.stdout}${result.stderr}`, /checksum.*selected|sidecar.*artifact/i);
    const log = existsSync(fixture.dockerLog) ? readFileSync(fixture.dockerLog, 'utf8') : '';
    assert.doesNotMatch(log, /RESTORE_CHECK|MAIN_DATABASE_DRIVER/);
  } finally {
    fixture.cleanup();
  }
});

test('fresh archive preclaims a durable marker and refuses retry after a DB driver failure', () => {
  const fixture = freshArchiveFixture({ databaseDriverExit: '73' });
  try {
    const failed = fixture.run();
    assert.notEqual(failed.status, 0, 'injected database failure must propagate');
    assert.equal(
      existsSync(fixture.marker),
      true,
      'preclaim must survive a failed database switch',
    );
    assert.match(readFileSync(fixture.marker, 'utf8'), /^state=(?:pending|failed)$/mu);

    const retried = fixture.run({ FAKE_DATABASE_DRIVER_EXIT: '0' });
    assert.notEqual(retried.status, 0, 'an unresolved preclaim must prohibit a second archive');
    assert.match(`${retried.stdout}${retried.stderr}`, /already registered|recovery state/i);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    assert.equal((log.match(/MAIN_DATABASE_DRIVER/gu) ?? []).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('fresh archive holds maintenance lock, restore-checks, freezes legacy DB and caps its name', () => {
  const fixture = freshArchiveFixture({ databaseName: 'p'.repeat(63) });
  try {
    const result = fixture.run();
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    assert.ok(log.indexOf('FLOCK') < log.indexOf('RESTORE_CHECK'));
    assert.ok(log.indexOf('RESTORE_CHECK') < log.indexOf('MAIN_DATABASE_DRIVER'));

    const marker = readFileSync(fixture.marker, 'utf8');
    assert.match(marker, /^state=complete$/mu);
    const legacyName = marker.match(/^legacy_database=(.+)$/mu)?.[1] ?? '';
    assert.ok(legacyName.length > 0 && Buffer.byteLength(legacyName) <= 63, legacyName);

    const databaseProgram = readFileSync(fixture.databaseInput, 'utf8');
    assert.match(databaseProgram, /ALLOW_CONNECTIONS false/);
    assert.match(databaseProgram, /datallowconn/);
    assert.match(databaseProgram, /on_signal[\s\S]*exit/);
  } finally {
    fixture.cleanup();
  }
});

test('fresh archive refuses to inspect or mutate the database when maintenance lock is held', () => {
  const fixture = freshArchiveFixture({ flockExit: '1' });
  try {
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /backup|restore|archive|maintenance.*running/i,
    );
    const log = readFileSync(fixture.dockerLog, 'utf8');
    assert.match(log, /FLOCK/);
    assert.doesNotMatch(log, /RESTORE_CHECK|MAIN_DATABASE_DRIVER/);
    assert.equal(existsSync(fixture.marker), false);
  } finally {
    fixture.cleanup();
  }
});

test('local smoke accepts only its dedicated real backup directory and rejects symlink escape', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.'));
  const outside = mkdtempSync(resolve(tmpdir(), 'plenka-vps-outside.'));
  try {
    const backupDirectory = resolve(directory, 'backups');
    const environment = writeEnvironment(directory, { BACKUP_DIR: backupDirectory });
    const accepted = spawnSync(VALIDATOR, ['--local-smoke', environment.path], {
      encoding: 'utf8',
    });
    assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);

    symlinkSync(outside, backupDirectory, 'dir');
    const rejected = spawnSync(VALIDATOR, ['--local-smoke', environment.path], {
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0, 'backup symlink escape must be rejected');
    assert.match(`${rejected.stdout}${rejected.stderr}`, /backup|BACKUP_DIR|symlink/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function runRestoreArtifactBoundaryScenario(scenario) {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.'));
  const backupDirectory = resolve(directory, 'backups');
  const binDirectory = resolve(directory, 'bin');
  mkdirSync(backupDirectory, { mode: 0o700 });
  mkdirSync(binDirectory);
  const environment = writeEnvironment(directory, { BACKUP_DIR: backupDirectory });
  const expectedArtifact = resolve(backupDirectory, 'plenka-20000101T000000Z.dump');
  const outsideArtifact = resolve(directory, 'outside.dump');
  const outsideChecksum = resolve(directory, 'outside.sha256');
  const outsideCompletion = resolve(directory, 'outside.complete');
  const payload = 'synthetic-target-dump';
  let artifact = expectedArtifact;

  writeFileSync(outsideArtifact, payload, { mode: 0o600 });
  if (scenario === 'external') {
    artifact = outsideArtifact;
  } else if (scenario === 'noncanonical') {
    artifact = `${backupDirectory}/./plenka-20000101T000000Z.dump`;
    writeFileSync(artifact, payload, { mode: 0o600 });
  } else if (scenario === 'artifact-symlink') {
    symlinkSync(outsideArtifact, artifact, 'file');
  } else {
    writeFileSync(artifact, payload, { mode: 0o600 });
  }
  if (scenario === 'artifact-mode') {
    chmodSync(artifact, 0o640);
  } else if (scenario === 'artifact-hardlink') {
    linkSync(artifact, resolve(directory, 'artifact-hardlink.dump'));
  }

  const checksum = `${sha256(payload)}  ${artifact.split('/').at(-1)}\n`;
  if (scenario === 'checksum-symlink') {
    writeFileSync(outsideChecksum, checksum, { mode: 0o600 });
    symlinkSync(outsideChecksum, `${artifact}.sha256`, 'file');
  } else if (scenario === 'checksum-wrong-target') {
    writeFileSync(`${artifact}.sha256`, `${sha256(payload)}  another-backup.dump\n`, {
      mode: 0o600,
    });
  } else if (scenario === 'checksum-extra-record') {
    writeFileSync(
      `${artifact}.sha256`,
      `${sha256(payload)}  ${artifact.split('/').at(-1)}\n${'0'.repeat(64)}  extra.dump\n`,
      { mode: 0o600 },
    );
  } else {
    writeFileSync(`${artifact}.sha256`, checksum, { mode: 0o600 });
  }
  if (scenario === 'checksum-mode') {
    chmodSync(`${artifact}.sha256`, 0o640);
  }
  if (scenario === 'completion-symlink') {
    writeFileSync(outsideCompletion, 'complete\n', { mode: 0o600 });
    symlinkSync(outsideCompletion, `${artifact}.complete`, 'file');
  } else if (scenario === 'completion-invalid') {
    writeFileSync(`${artifact}.complete`, 'pending\n', { mode: 0o600 });
  } else {
    writeFileSync(`${artifact}.complete`, 'complete\n', { mode: 0o600 });
  }
  if (scenario === 'completion-mode') {
    chmodSync(`${artifact}.complete`, 0o640);
  }

  const fakeDocker = resolve(binDirectory, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ \${1-} == info ]]; then exit 0; fi
if [[ \${1-} == compose && \${2-} == version ]]; then exit 0; fi
if [[ " $* " == *'_prisma_migrations'* ]]; then printf '1\\n'; exit 0; fi
exit 0
`,
  );
  chmodSync(fakeDocker, 0o755);

  const result = spawnSync(resolve(ROOT, 'scripts/vps/restore.sh'), ['--check', artifact], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      PLENKA_ENV_FILE: environment.path,
      PLENKA_LOCAL_SMOKE: '1',
    },
  });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

for (const scenario of [
  'external',
  'noncanonical',
  'artifact-symlink',
  'checksum-symlink',
  'completion-symlink',
  'checksum-wrong-target',
  'checksum-extra-record',
  'completion-invalid',
  'artifact-mode',
  'artifact-hardlink',
  'checksum-mode',
  'completion-mode',
]) {
  test(`restore rejects ${scenario} maintenance artifacts`, () => {
    const result = runRestoreArtifactBoundaryScenario(scenario);

    assert.notEqual(result.status, 0, `${scenario} artifact must fail closed`);
    assert.match(`${result.stdout}${result.stderr}`, /artifact|backup|regular|symlink/i);
  });
}

function migrationRehearsalFixture({
  createExitStatus = 0,
  flockExitStatus = 0,
  migrationExitStatus = 0,
  migrationHealth = '0:2:1:0',
  preMigrationHealth = '0:0',
  restoreExitStatus = 0,
  signalDuringCreate = '',
  staleDatabaseCount = '0',
} = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.'));
  const backupDirectory = resolve(directory, 'backups');
  const binDirectory = resolve(directory, 'bin');
  const commandLog = resolve(directory, 'docker.log');
  const migrationCapture = resolve(directory, 'migration-env.capture');
  const migrationEnvironmentPath = resolve(directory, 'migration-env.path');
  mkdirSync(backupDirectory, { mode: 0o700 });
  mkdirSync(binDirectory);

  const ownerPassword = 'RehearsalOwnerSecret_0123456789abcdef';
  const { path: environmentPath } = writeEnvironment(directory, {
    BACKUP_DIR: backupDirectory,
    DATABASE_OWNER_PASSWORD: ownerPassword,
    MIGRATION_DATABASE_URL: `postgresql://plenka_owner:${ownerPassword}@db:5432/plenka_pilot?schema=public`,
  });
  const artifact = resolve(backupDirectory, 'plenka-20000101T000000Z.dump');
  const payload = 'synthetic checked migration rehearsal dump';
  writeFileSync(artifact, payload, { mode: 0o600 });
  writeFileSync(`${artifact}.sha256`, `${sha256(payload)}  ${artifact.split('/').at(-1)}\n`, {
    mode: 0o600,
  });
  writeFileSync(`${artifact}.complete`, 'complete\n', { mode: 0o600 });

  const fakeFlock = resolve(binDirectory, 'flock');
  writeFileSync(
    fakeFlock,
    '#!/usr/bin/env bash\nset -Eeuo pipefail\nexit "${PLENKA_TEST_FLOCK_EXIT_STATUS:-0}"\n',
  );
  chmodSync(fakeFlock, 0o755);

  const fakeDocker = resolve(binDirectory, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" >>"\${PLENKA_TEST_DOCKER_LOG:?}"
if [[ \${1-} == info ]]; then exit 0; fi
if [[ \${1-} == compose && \${2-} == version ]]; then exit 0; fi

if [[ " $* " == *'CREATE DATABASE "plenka_migration_check_'* ||
  " $* " == *'CREATE DATABASE "plenka_restore_check_'* ]]; then
  if [[ -n "\${PLENKA_TEST_SIGNAL_DURING_CREATE:-}" ]]; then
    sleep 0.05
    candidate_pid="$PPID"
    restore_pid=''
    while [[ "$candidate_pid" =~ ^[0-9]+$ && "$candidate_pid" -gt 1 ]]; do
      command_line="$(ps -o command= -p "$candidate_pid" 2>/dev/null || true)"
      if [[ "$command_line" == *'scripts/vps/restore.sh'* ]]; then
        restore_pid="$candidate_pid"
      fi
      candidate_pid="$(ps -o ppid= -p "$candidate_pid" 2>/dev/null | tr -d ' ')"
    done
    [[ -n "$restore_pid" ]] || exit 92
    kill -"\${PLENKA_TEST_SIGNAL_DURING_CREATE}" "$restore_pid"
    sleep 0.05
  fi
  exit "\${PLENKA_TEST_CREATE_EXIT_STATUS:-0}"
fi

if [[ " $* " == *" exec -T db pg_restore "* ]]; then
  printf '%s\\n' 'RESTORE' >>"\${PLENKA_TEST_DOCKER_LOG:?}"
  cat >/dev/null
  exit "\${PLENKA_TEST_RESTORE_EXIT_STATUS:-0}"
fi

if [[ " $* " == *" run --rm --no-deps --pull never migrate"* ]]; then
  environment_file=''
  previous=''
  for argument in "$@"; do
    if [[ "$previous" == --env-file ]]; then
      environment_file="$argument"
      break
    fi
    previous="$argument"
  done
  [[ -n "$environment_file" && -f "$environment_file" ]]
  printf '%s' "$environment_file" >"\${PLENKA_TEST_MIGRATION_ENV_PATH:?}"
  if mode="$(stat -c '%a' "$environment_file" 2>/dev/null)"; then
    :
  else
    mode="$(stat -f '%Lp' "$environment_file")"
  fi
  printf 'mode=%s\\n' "$mode" >"\${PLENKA_TEST_MIGRATION_CAPTURE:?}"
  grep -E '^(POSTGRES_DB|DATABASE_URL|MIGRATION_DATABASE_URL)=' "$environment_file" \
    >>"\${PLENKA_TEST_MIGRATION_CAPTURE:?}"
  printf '%s\\n' "\${PLENKA_TEST_SECRET_NOISE:?}"
  printf '%s\\n' "\${PLENKA_TEST_SECRET_NOISE:?}" >&2
  exit "\${PLENKA_TEST_MIGRATION_EXIT_STATUS:-0}"
fi

if [[ " $* " == *'migration_rehearsal_post'* ]]; then
  printf '%s\\n' "\${PLENKA_TEST_MIGRATION_HEALTH:-0:2:1:0}"
  exit 0
fi
if [[ " $* " == *'migration_rehearsal_pre'* ]]; then
  printf '%s\\n' "\${PLENKA_TEST_PRE_MIGRATION_HEALTH:-0:0}"
  exit 0
fi
if [[ " $* " == *'_prisma_migrations'* ]]; then
  printf '%s\\n' '1'
  exit 0
fi
if [[ " $* " == *'pg_database'* && " $* " == *'plenka_migration_check_'* ]]; then
  printf '%s\\n' "\${PLENKA_TEST_STALE_DATABASE_COUNT:-0}"
  exit 0
fi
exit 0
`,
  );
  chmodSync(fakeDocker, 0o755);

  const baseEnvironment = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
    PLENKA_ENV_FILE: environmentPath,
    PLENKA_LOCAL_SMOKE: '1',
    PLENKA_TEST_DOCKER_LOG: commandLog,
    PLENKA_TEST_CREATE_EXIT_STATUS: String(createExitStatus),
    PLENKA_TEST_FLOCK_EXIT_STATUS: String(flockExitStatus),
    PLENKA_TEST_MIGRATION_CAPTURE: migrationCapture,
    PLENKA_TEST_MIGRATION_ENV_PATH: migrationEnvironmentPath,
    PLENKA_TEST_MIGRATION_EXIT_STATUS: String(migrationExitStatus),
    PLENKA_TEST_MIGRATION_HEALTH: migrationHealth,
    PLENKA_TEST_PRE_MIGRATION_HEALTH: preMigrationHealth,
    PLENKA_TEST_RESTORE_EXIT_STATUS: String(restoreExitStatus),
    PLENKA_TEST_SECRET_NOISE: ownerPassword,
    PLENKA_TEST_SIGNAL_DURING_CREATE: signalDuringCreate,
    PLENKA_TEST_STALE_DATABASE_COUNT: staleDatabaseCount,
  };

  return {
    artifact,
    commandLog,
    environmentPath,
    migrationCapture,
    migrationEnvironmentPath,
    ownerPassword,
    run(expectedMigration = '20260723130000_add_material_recipe_catalog') {
      return spawnSync(
        resolve(ROOT, 'scripts/vps/restore.sh'),
        ['--check-migrate', artifact, expectedMigration],
        {
          encoding: 'utf8',
          env: baseEnvironment,
        },
      );
    },
    runCheck() {
      return spawnSync(resolve(ROOT, 'scripts/vps/restore.sh'), ['--check', artifact], {
        encoding: 'utf8',
        env: baseEnvironment,
      });
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function assertDisposableDatabaseCleanup(commands, prefix) {
  const databasePattern = new RegExp(
    `(?:CREATE DATABASE|DROP DATABASE IF EXISTS) "(${prefix}[a-zA-Z0-9_]+)"`,
    'gu',
  );
  const names = [...commands.matchAll(databasePattern)].map((match) => match[1]);

  assert.equal(names.length, 2, 'cleanup must issue exactly one CREATE and one DROP');
  assert.equal(names[1], names[0], 'cleanup must drop only the database successfully created');
  assert.doesNotMatch(commands, /DROP DATABASE IF EXISTS "plenka_pilot"/u);
}

function assertRehearsalCleanup(fixture, commands) {
  const createdDatabase =
    commands.match(/CREATE DATABASE "(plenka_migration_check_[a-zA-Z0-9_]+)"/u)?.[1] ?? '';

  assert.ok(createdDatabase.length > 0, 'rehearsal must create a bounded disposable database');
  assertDisposableDatabaseCleanup(commands, 'plenka_migration_check_');
  if (existsSync(fixture.migrationEnvironmentPath)) {
    const temporaryEnvironment = readFileSync(fixture.migrationEnvironmentPath, 'utf8');
    assert.equal(
      existsSync(temporaryEnvironment),
      false,
      'temporary secret environment must be deleted',
    );
  }
}

test('checked-backup migration rehearsal uses canonical migrate service without secret leakage', () => {
  const fixture = migrationRehearsalFixture();
  try {
    const result = fixture.run();
    const output = `${result.stdout}${result.stderr}`;
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.equal(result.status, 0, output);
    assert.match(output, /Migration rehearsal: PASS/u);
    assert.doesNotMatch(output, new RegExp(fixture.ownerPassword, 'u'));
    assert.doesNotMatch(commands, new RegExp(fixture.ownerPassword, 'u'));
    assert.match(commands, / run --rm --no-deps --pull never migrate(?:\n|$)/u);
    assert.match(commands, /20260723130000_add_material_recipe_catalog/u);
    assert.doesNotMatch(commands, /\b(?:seed|down|stop api)\b/u);
    assert.ok(
      commands.indexOf('RESTORE') < commands.indexOf(' run --rm --no-deps --pull never migrate'),
      'checked restore and preflight must precede candidate migration',
    );
    assert.ok(
      commands.indexOf(' run --rm --no-deps --pull never migrate') <
        commands.indexOf('migration_rehearsal_post'),
      'migration health verification must follow candidate migration',
    );

    const captured = readFileSync(fixture.migrationCapture, 'utf8');
    assert.match(captured, /^mode=600$/mu);
    assert.match(captured, /^POSTGRES_DB=plenka_migration_check_[a-zA-Z0-9_]+$/mu);
    assert.match(
      captured,
      /DATABASE_URL=postgresql:\/\/plenka_app:[^@\n]+@db:5432\/plenka_migration_check_[a-zA-Z0-9_]+\?schema=public/u,
    );
    assert.match(
      captured,
      /MIGRATION_DATABASE_URL=postgresql:\/\/plenka_owner:[^@\n]+@db:5432\/plenka_migration_check_[a-zA-Z0-9_]+\?schema=public/u,
    );
    assert.doesNotMatch(captured, /\/plenka_pilot\?schema=public/u);
    assert.match(
      readFileSync(fixture.environmentPath, 'utf8'),
      /MIGRATION_DATABASE_URL=.*\/plenka_pilot\?schema=public/u,
      'canonical environment must remain unchanged',
    );
    assertRehearsalCleanup(fixture, commands);
  } finally {
    fixture.cleanup();
  }
});

test('HUP after successful restore-check CREATE drops the exact owned disposable database', () => {
  const fixture = migrationRehearsalFixture({ signalDuringCreate: 'HUP' });
  try {
    const result = fixture.runCheck();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.equal(result.status, 129, `${result.stdout}${result.stderr}`);
    assertDisposableDatabaseCleanup(commands, 'plenka_restore_check_');
    assert.doesNotMatch(commands, /plenka_migration_check_/u);
  } finally {
    fixture.cleanup();
  }
});

test('HUP after successful migration-check CREATE drops the exact owned disposable database', () => {
  const fixture = migrationRehearsalFixture({ signalDuringCreate: 'HUP' });
  try {
    const result = fixture.run();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.equal(result.status, 129, `${result.stdout}${result.stderr}`);
    assertDisposableDatabaseCleanup(commands, 'plenka_migration_check_');
    assert.doesNotMatch(commands, /DROP DATABASE IF EXISTS "plenka_restore_check_/u);
  } finally {
    fixture.cleanup();
  }
});

test('migration rehearsal rejects an unsafe expected migration before database access', () => {
  const fixture = migrationRehearsalFixture();
  try {
    const result = fixture.run('../not-a-migration');
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'unsafe migration name must fail closed');
    assert.match(`${result.stdout}${result.stderr}`, /expected migration|migration name/i);
    assert.doesNotMatch(commands, /CREATE DATABASE|pg_restore| run --rm --no-deps migrate/u);
  } finally {
    fixture.cleanup();
  }
});

test('migration rehearsal refuses a stale disposable database without mutating it', () => {
  const fixture = migrationRehearsalFixture({ staleDatabaseCount: '1' });
  try {
    const result = fixture.run();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'stale rehearsal database must require manual recovery');
    assert.match(`${result.stdout}${result.stderr}`, /stale migration rehearsal database/i);
    assert.doesNotMatch(commands, /CREATE DATABASE|DROP DATABASE|pg_restore| migrate(?:\n|$)/u);
  } finally {
    fixture.cleanup();
  }
});

test('failed disposable database creation never claims cleanup ownership', () => {
  const fixture = migrationRehearsalFixture({ createExitStatus: 75 });
  try {
    const result = fixture.run();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'database creation failure must propagate');
    assert.match(commands, /CREATE DATABASE "plenka_migration_check_/u);
    assert.doesNotMatch(commands, /DROP DATABASE IF EXISTS "plenka_migration_check_/u);
    assert.doesNotMatch(commands, /pg_restore| migrate(?:\n|$)/u);
  } finally {
    fixture.cleanup();
  }
});

test('migration rehearsal refuses concurrent maintenance before database access', () => {
  const fixture = migrationRehearsalFixture({ flockExitStatus: 76 });
  try {
    const result = fixture.run();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'held maintenance lock must fail closed');
    assert.match(`${result.stdout}${result.stderr}`, /already running/i);
    assert.doesNotMatch(commands, /pg_database|CREATE DATABASE|DROP DATABASE|pg_restore/u);
  } finally {
    fixture.cleanup();
  }
});

test('migration rehearsal rejects a checked backup that already contains the candidate', () => {
  const fixture = migrationRehearsalFixture({ preMigrationHealth: '1:0' });
  try {
    const result = fixture.run();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'already-applied expected migration must fail closed');
    assert.match(`${result.stdout}${result.stderr}`, /already present/i);
    assert.doesNotMatch(commands, / run --rm --no-deps --pull never migrate(?:\n|$)/u);
    assertRehearsalCleanup(fixture, commands);
  } finally {
    fixture.cleanup();
  }
});

test('failed candidate migration is generic, secret-free and drops the disposable database', () => {
  const fixture = migrationRehearsalFixture({ migrationExitStatus: 73 });
  try {
    const result = fixture.run();
    const output = `${result.stdout}${result.stderr}`;
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'candidate migration failure must propagate');
    assert.match(output, /candidate migration rehearsal failed/i);
    assert.doesNotMatch(output, new RegExp(fixture.ownerPassword, 'u'));
    assert.doesNotMatch(commands, new RegExp(fixture.ownerPassword, 'u'));
    assert.match(commands, / run --rm --no-deps --pull never migrate(?:\n|$)/u);
    assert.doesNotMatch(commands, /migration_rehearsal_post/u);
    assertRehearsalCleanup(fixture, commands);
  } finally {
    fixture.cleanup();
  }
});

test('successful migrate command cannot pass when the exact expected migration is absent', () => {
  const fixture = migrationRehearsalFixture({ migrationHealth: '0:2:0:0' });
  try {
    const result = fixture.run();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'a no-op or old migrate image must fail rehearsal');
    assert.match(`${result.stdout}${result.stderr}`, /omitted the expected migration/i);
    assert.match(commands, / run --rm --no-deps --pull never migrate(?:\n|$)/u);
    assertRehearsalCleanup(fixture, commands);
  } finally {
    fixture.cleanup();
  }
});

test('failed restore preflight never starts candidate migration and still cleans up', () => {
  const fixture = migrationRehearsalFixture({ restoreExitStatus: 74 });
  try {
    const result = fixture.run();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'restore preflight failure must propagate');
    assert.doesNotMatch(commands, / run --rm --no-deps --pull never migrate(?:\n|$)/u);
    assertRehearsalCleanup(fixture, commands);
  } finally {
    fixture.cleanup();
  }
});

test('failed post-migration health verification drops the disposable database', () => {
  const fixture = migrationRehearsalFixture({ migrationHealth: '1:2:1:0' });
  try {
    const result = fixture.run();
    const commands = existsSync(fixture.commandLog) ? readFileSync(fixture.commandLog, 'utf8') : '';

    assert.notEqual(result.status, 0, 'incomplete migration journal must fail rehearsal');
    assert.match(`${result.stdout}${result.stderr}`, /migration journal|incomplete/i);
    assert.match(commands, / run --rm --no-deps --pull never migrate(?:\n|$)/u);
    assert.match(commands, /migration_rehearsal_post/u);
    assertRehearsalCleanup(fixture, commands);
  } finally {
    fixture.cleanup();
  }
});

function runDeployWithApiState(apiState, migrationExitStatus = 0) {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.'));
  const backupDirectory = resolve(directory, 'backups');
  const binDirectory = resolve(directory, 'bin');
  const commandLog = resolve(directory, 'docker.log');
  mkdirSync(backupDirectory, { mode: 0o700 });
  mkdirSync(binDirectory);
  const environment = writeEnvironment(directory, { BACKUP_DIR: backupDirectory });
  const fakeDocker = resolve(binDirectory, 'docker');

  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" >>"$PLENKA_TEST_DOCKER_LOG"
if [[ \${1-} == info ]]; then exit 0; fi
if [[ \${1-} == compose && \${2-} == version ]]; then exit 0; fi
if [[ " $* " == *" ps --all -q api "* ]]; then
  [[ "$PLENKA_TEST_API_STATE" == missing ]] || printf 'api-container\\n'
  exit 0
fi
if [[ " $* " == *" ps --status running -q api "* ]]; then
  [[ "$PLENKA_TEST_API_STATE" != running ]] || printf 'api-container\\n'
  exit 0
fi
if [[ \${1-} == inspect && " $* " == *State.Status* ]]; then
  printf '%s\\n' "$PLENKA_TEST_API_STATE"
  exit 0
fi
if [[ " $* " == *" run --rm --no-deps migrate "* ]]; then
  exit "$PLENKA_TEST_MIGRATION_EXIT_STATUS"
fi
if [[ " $* " == *" ps -q api "* ]]; then printf 'api-container\\n'; exit 0; fi
if [[ \${1-} == inspect && " $* " == *State.Health* ]]; then printf 'healthy\\n'; exit 0; fi
exit 0
`,
  );
  chmodSync(fakeDocker, 0o755);

  const result = spawnSync(resolve(ROOT, 'scripts/vps/deploy.sh'), [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      PLENKA_ENV_FILE: environment.path,
      PLENKA_LOCAL_SMOKE: '1',
      PLENKA_TEST_API_STATE: apiState,
      PLENKA_TEST_DOCKER_LOG: commandLog,
      PLENKA_TEST_MIGRATION_EXIT_STATUS: String(migrationExitStatus),
    },
  });
  const commands = existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '';
  rmSync(directory, { recursive: true, force: true });
  return { commands, result };
}

test('deploy restores a running API only after migration', () => {
  const { commands, result } = runDeployWithApiState('running');

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(commands, / stop api(?:\n|$)/u);
  assert.match(commands, / up -d --no-deps api(?:\n|$)/u);
  assert.ok(commands.indexOf(' stop api\n') < commands.indexOf(' run --rm --no-deps migrate\n'));
});

test('deploy leaves an API that was stopped before maintenance stopped', () => {
  const { commands, result } = runDeployWithApiState('exited');

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(commands, / up --no-start --no-deps api(?:\n|$)/u);
  assert.doesNotMatch(commands, / up -d --no-deps api(?:\n|$)/u);
  assert.match(result.stdout, /Deploy: UPDATED; API remains stopped/u);
  assert.doesNotMatch(result.stdout, /Deploy: STARTED/u);
});

test('deploy leaves the previous API stopped when migration fails', () => {
  const { commands, result } = runDeployWithApiState('running', 23);

  assert.notEqual(result.status, 0, 'migration failure must abort deployment');
  assert.match(commands, / stop api(?:\n|$)/u);
  assert.doesNotMatch(commands, / up -d --no-deps api(?:\n|$)/u);
});

test('deploy stops and restores an API caught in restart backoff', () => {
  const { commands, result } = runDeployWithApiState('restarting');

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(commands, / stop api(?:\n|$)/u);
  assert.match(commands, / up -d --no-deps api(?:\n|$)/u);
});

test('deploy starts the API during a fresh deployment', () => {
  const { commands, result } = runDeployWithApiState('missing');

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(commands, / up -d --no-deps api(?:\n|$)/u);
});

test('deploy stops a running API before migration and starts it only after migration succeeds', () => {
  const deploy = read('scripts/vps/deploy.sh');
  const stopApi = deploy.indexOf('compose stop api');
  const migrate = deploy.indexOf('compose run --rm --no-deps migrate');
  const startApi = deploy.indexOf('compose up -d --no-deps api');

  assert.ok(stopApi >= 0, 'deploy must explicitly stop the old API writer');
  assert.ok(stopApi < migrate, 'old API must stop before schema migration');
  assert.ok(migrate < startApi, 'new API may start only after migration succeeds');
});

test('deployment recreates web and VPS smoke inspects actual private port bindings', () => {
  const deploy = read('scripts/vps/deploy.sh');
  const smoke = read('scripts/vps/smoke-vps.sh');
  assert.match(deploy, /^compose up -d --wait --no-deps --force-recreate web$/mu);
  assert.doesNotMatch(deploy, /Deploy: PASS/);
  assert.doesNotMatch(smoke, /compose port/);
  assert.match(smoke, /compose ps --status running -q/);
  assert.match(smoke, /docker inspect[\s\S]*\.NetworkSettings\.Ports/);
  assert.match(smoke, /\$\{#host_binding_markers\}/);
  assert.match(smoke, /PARTIAL/);
  assert.doesNotMatch(smoke, /VPS smoke: PASS/);
});

test('VPS smoke account table exactly matches the canonical pilot seed manifest', () => {
  const smoke = read('scripts/vps/smoke-vps.sh');
  const seedProfile = read('apps/api/src/common/seed/seed-profile.ts');
  const loginBlock = seedProfile.match(
    /export const PILOT_LOGINS = \{(?<body>[\s\S]*?)\} as const;/u,
  )?.groups?.body;
  const manifestBlock = seedProfile.match(
    /export const PILOT_ACCOUNT_MANIFEST = \[(?<body>[\s\S]*?)\] as const;/u,
  )?.groups?.body;
  const smokeBlock = smoke.match(/readonly -a pilot_accounts=\((?<body>[\s\S]*?)^\)$/mu)?.groups
    ?.body;

  assert.ok(loginBlock, 'seed profile must expose canonical pilot logins');
  assert.ok(manifestBlock, 'seed profile must expose the pilot account manifest');
  assert.ok(smokeBlock, 'VPS smoke must declare its complete account table');

  const logins = Object.fromEntries(
    [...loginBlock.matchAll(/^\s*([a-z0-9]+):\s*'([^']+)',?$/gmu)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const expected = [
    ...manifestBlock.matchAll(
      /login:\s*PILOT_LOGINS\.([a-z0-9]+),[\s\S]*?role:\s*Role\.([a-z_]+),[\s\S]*?passwordKey:\s*'([A-Z0-9_]+)'/gu,
    ),
  ].map((match) => ({
    login: logins[match[1]],
    passwordKey: match[3],
    role: match[2],
  }));
  const actual = [...smokeBlock.matchAll(/^\s*'([^|']+)\|([A-Z0-9_]+)\|([a-z_]+)'$/gmu)].map(
    (match) => ({ login: match[1], passwordKey: match[2], role: match[3] }),
  );

  assert.equal(expected.length, 9);
  assert.deepEqual(actual, expected);
});

test('VPS smoke validates all nine pilot identities without an extra login or secret output', () => {
  const scenario = runVpsSmokeScenario();
  try {
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;
    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.state.loginAttempts, 9);
    assert.equal(scenario.state.meAttempts, 9);
    assert.equal(scenario.state.logoutAttempts, 9);
    assert.deepEqual(scenario.state.sessions, {});
    assert.match(output, /9 canonical pilot accounts/u);
    assert.doesNotMatch(output, /private-response-marker/u);
    for (const account of PILOT_SMOKE_ACCOUNTS) {
      assert.equal(output.includes(account.login), false);
      assert.equal(output.includes(scenario.values[account.passwordKey]), false);
    }
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const token = createHash('sha256').update(`pilot-smoke-${attempt}`).digest('hex');
      assert.equal(output.includes(token), false);
    }
  } finally {
    scenario.cleanup();
  }
});

for (const failure of [
  { scenario: 'missing-token', expectedLogins: 2 },
  { scenario: 'password-required-login', expectedLogins: 3 },
  { scenario: 'wrong-login-role', expectedLogins: 4 },
  { scenario: 'wrong-me-role', expectedLogins: 4 },
  { scenario: 'nested-role-decoy', expectedLogins: 4 },
  { scenario: 'password-required-me', expectedLogins: 6 },
]) {
  test(`VPS smoke fails closed on ${failure.scenario} without exhausting the limiter`, () => {
    const scenario = runVpsSmokeScenario(failure.scenario);
    try {
      const output = `${scenario.result.stdout}${scenario.result.stderr}`;
      assert.notEqual(scenario.result.status, 0);
      assert.equal(scenario.state.loginAttempts, failure.expectedLogins);
      assert.ok(scenario.state.loginAttempts <= 10);
      if (failure.scenario === 'missing-token') {
        assert.equal(Object.keys(scenario.state.sessions).length, 1);
        assert.equal(scenario.state.logoutAttempts, failure.expectedLogins - 1);
      } else {
        assert.deepEqual(scenario.state.sessions, {});
        assert.equal(scenario.state.logoutAttempts, failure.expectedLogins);
      }
      assert.doesNotMatch(output, /private-response-marker/u);
      for (const account of PILOT_SMOKE_ACCOUNTS) {
        assert.equal(output.includes(account.login), false);
        assert.equal(output.includes(scenario.values[account.passwordKey]), false);
      }
    } finally {
      scenario.cleanup();
    }
  });
}

test('local smoke cleanup reuses the sanitized canonical Compose wrapper', () => {
  const smoke = read('scripts/vps/smoke-local.sh');

  assert.match(smoke, /compose_ready=false/u);
  assert.match(smoke, /compose_ready=true/u);
  assert.match(smoke, /ONEC_LIVE=false/u);
  assert.match(smoke, /ONEC_SYNC_ENABLED=false/u);
  assert.match(smoke, /ONEC_SYNC_INTERVAL_MS=900000/u);
  assert.match(smoke, /ONEC_SYNC_PAGE_SIZE=250/u);
  assert.doesNotMatch(smoke, /ONEC_(?:BASE_URL|USERNAME|PASSWORD|WRITE_CONFIRM)=/u);
  assert.match(smoke, /WAREHOUSE_COVERAGE_V2_ENABLED=false/u);
  assert.match(smoke, /PRODUCTION_COST_RECONCILER_ENABLED=true/u);
  assert.doesNotMatch(smoke, /ONEC_LIVE=true/u);
  assert.match(smoke, /env -u PLENKA_LOCAL_SMOKE .*test\/run\.sh/u);
  assert.match(smoke, /compose down --volumes --remove-orphans/u);
  assert.doesNotMatch(smoke, /docker compose[\s\\]+--env-file/u);
});

test('local smoke generates exactly the canonical pilot password and post-token keys', () => {
  const smoke = read('scripts/vps/smoke-local.sh');
  const passwordSuffixBlock = smoke.match(
    /for suffix in \\\n(?<suffixes>[\s\S]*?); do\n\s+printf 'SEED_PILOT_PASSWORD_%s=/u,
  )?.groups?.suffixes;
  const postBlock = smoke.match(
    /for post in (?<posts>[0-9 ]+); do\n\s+printf 'SEED_PILOT_AGENT_TOKEN_POST_%s=/u,
  )?.groups?.posts;

  assert.ok(passwordSuffixBlock, 'local smoke must declare its complete password suffix list');
  assert.ok(postBlock, 'local smoke must declare its complete post-token list');
  assert.deepEqual(
    [...passwordSuffixBlock.matchAll(/[A-Z][A-Z0-9_]*/gu)]
      .map((match) => `SEED_PILOT_PASSWORD_${match[0]}`)
      .sort(),
    PILOT_PASSWORD_KEYS,
  );
  assert.deepEqual(
    postBlock
      .trim()
      .split(/\s+/u)
      .map((post) => `SEED_PILOT_AGENT_TOKEN_POST_${post}`)
      .sort(),
    POST_AGENT_TOKEN_KEYS,
  );
  assert.equal(
    [
      ...smoke.matchAll(
        /^compose --profile bootstrap run --rm --no-deps seed-pilot >\/dev\/null$/gmu,
      ),
    ].length,
    2,
  );
});

test('runbook keeps warehouse coverage V2 disabled in both rollout preparation paths', () => {
  const runbook = read('docs/operations/vps-pilot-runbook.md');

  assert.match(
    runbookSection(runbook, 'First install safe values'),
    /^WAREHOUSE_COVERAGE_V2_ENABLED=false$/mu,
  );
  assert.match(
    runbookSection(runbook, 'Upgrade compatibility before validation'),
    /^WAREHOUSE_COVERAGE_V2_ENABLED=false$/mu,
  );
  assert.match(
    runbookSection(runbook, 'First install safe values'),
    /^PRODUCTION_COST_RECONCILER_ENABLED=true$/mu,
  );
  assert.match(
    runbookSection(runbook, 'Upgrade compatibility before validation'),
    /^PRODUCTION_COST_RECONCILER_ENABLED=true$/mu,
  );
});

test('upgrade runbook enables the approved short-PIN policy without bootstrap password changes', () => {
  const runbook = read('docs/operations/vps-pilot-runbook.md');
  const upgrade = runbookSection(runbook, 'Upgrade compatibility before validation');
  const smoke = runbookSection(runbook, '6. Smoke');

  assert.match(upgrade, /^PILOT_SHORT_PASSWORDS_ENABLED=true$/mu);
  assert.doesNotMatch(upgrade, /^PILOT_SHORT_PASSWORDS_ENABLED=false$/mu);
  assert.match(upgrade, /9[\s\S]*четыр[её]хзначн/u);
  assert.match(smoke, /passwordChangeRequired=false/u);
  assert.doesNotMatch(smoke, /обязательн\w* смен\w* парол/u);
  assert.doesNotMatch(smoke, /bootstrap password/u);
});

test('runbook rehearses candidate migration on the checked backup before source activation', () => {
  const runbook = read('docs/operations/vps-pilot-runbook.md');
  const predeploy = runbookSection(runbook, '5.1. Обязательные pre-deploy gates');
  const backup = predeploy.indexOf('./scripts/vps/backup.sh --check');
  const rehearsal = predeploy.indexOf('./scripts/vps/restore.sh --check-migrate');
  const activation = predeploy.indexOf('ln -s "$RELEASE_DIR" /opt/plenka/current.next');

  assert.ok(backup >= 0);
  assert.ok(rehearsal > backup, 'checked backup must exist before migration rehearsal');
  assert.ok(activation > rehearsal, 'candidate source must stay inactive until rehearsal passes');
});

test('upgrade rollback source follows the verified running image pair, not a stale current symlink', () => {
  const runbook = read('docs/operations/vps-pilot-runbook.md');
  const upgrade = runbookSection(runbook, 'Upgrade compatibility before validation');

  assert.match(upgrade, /docker inspect[\s\S]*\.Config\.Image/u);
  assert.match(upgrade, /RUNNING_RELEASE_ID/u);
  assert.match(upgrade, /RUNNING_RELEASE=/u);
  assert.match(upgrade, /sha256sum -c/u);
  assert.match(upgrade, /"\$RUNNING_RELEASE"[\s\S]*pilot\.previous\.release/u);
  assert.doesNotMatch(upgrade, /CURRENT_RELEASE="\$\(readlink -f \/opt\/plenka\/current\)"/u);
});

test('failed restore-check preserves the previous backup generation', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.'));
  try {
    const backupDirectory = resolve(directory, 'backups');
    const binDirectory = resolve(directory, 'bin');
    mkdirSync(backupDirectory, { mode: 0o700 });
    mkdirSync(binDirectory);
    const environment = writeEnvironment(directory, {
      BACKUP_DIR: backupDirectory,
      BACKUP_RETENTION_COUNT: '1',
      BACKUP_RETENTION_DAYS: '1',
    });
    const previous = resolve(backupDirectory, 'plenka-20000101T000000Z.dump');
    writeFileSync(previous, 'known-good');
    writeFileSync(`${previous}.sha256`, '0'.repeat(64) + '  plenka-20000101T000000Z.dump\n');
    writeFileSync(`${previous}.complete`, 'complete\n');

    const fakeDocker = resolve(binDirectory, 'docker');
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ \${1-} == info ]]; then exit 0; fi
if [[ \${1-} == compose && \${2-} == version ]]; then exit 0; fi
if [[ " $* " == *" pg_dump "* ]]; then printf 'synthetic-dump'; exit 0; fi
if [[ " $* " == *" pg_restore "* ]]; then exit 23; fi
exit 0
`,
    );
    chmodSync(fakeDocker, 0o755);

    const result = spawnSync(resolve(ROOT, 'scripts/vps/backup.sh'), ['--check'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        PLENKA_ENV_FILE: environment.path,
        PLENKA_LOCAL_SMOKE: '1',
      },
    });

    assert.notEqual(result.status, 0, 'forced restore-check must fail');
    assert.equal(existsSync(previous), true, 'previous dump was deleted before restore proof');
    assert.equal(existsSync(`${previous}.sha256`), true);
    assert.equal(existsSync(`${previous}.complete`), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runLiveRestoreFailureInjection(failingRestoreNumber) {
  const directory = mkdtempSync(resolve(tmpdir(), 'plenka-vps-smoke.'));
  const backupDirectory = resolve(directory, 'backups');
  const binDirectory = resolve(directory, 'bin');
  const commandLog = resolve(directory, 'docker.log');
  const restoreCount = resolve(directory, 'restore.count');
  mkdirSync(backupDirectory, { mode: 0o700 });
  mkdirSync(binDirectory);
  const environment = writeEnvironment(directory, { BACKUP_DIR: backupDirectory });
  const artifact = resolve(backupDirectory, 'plenka-20000101T000000Z.dump');
  const payload = 'synthetic-target-dump';
  writeFileSync(artifact, payload, { mode: 0o600 });
  writeFileSync(`${artifact}.sha256`, `${sha256(payload)}  ${artifact.split('/').at(-1)}\n`, {
    mode: 0o600,
  });
  writeFileSync(`${artifact}.complete`, 'complete\n', { mode: 0o600 });

  const fakeDocker = resolve(binDirectory, 'docker');
  const fakeFlock = resolve(binDirectory, 'flock');
  writeFileSync(fakeFlock, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeFlock, 0o755);
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" >>"$PLENKA_TEST_DOCKER_LOG"
if [[ \${1-} == info ]]; then exit 0; fi
if [[ \${1-} == compose && \${2-} == version ]]; then exit 0; fi
if [[ " $* " == *" ps -q api "* ]]; then exit 0; fi
if [[ " $* " == *" pg_dump "* ]]; then printf 'synthetic-pre-restore-dump'; exit 0; fi
if [[ " $* " == *" pg_restore "* ]]; then
  count=0
  [[ ! -f "$PLENKA_TEST_RESTORE_COUNT" ]] || count="$(<"$PLENKA_TEST_RESTORE_COUNT")"
  count=$((count + 1))
  printf '%s' "$count" >"$PLENKA_TEST_RESTORE_COUNT"
  [[ "$count" -ne "$PLENKA_TEST_FAIL_RESTORE_NUMBER" ]] || exit 23
  exit 0
fi
if [[ " $* " == *'_prisma_migrations'* ]]; then printf '1\\n'; exit 0; fi
exit 0
`,
  );
  chmodSync(fakeDocker, 0o755);

  const result = spawnSync(
    resolve(ROOT, 'scripts/vps/restore.sh'),
    ['--live', artifact, 'RESTORE_LIVE_PLENKA'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        PLENKA_ENV_FILE: environment.path,
        PLENKA_LOCAL_SMOKE: '1',
        PLENKA_TEST_DOCKER_LOG: commandLog,
        PLENKA_TEST_FAIL_RESTORE_NUMBER: String(failingRestoreNumber),
        PLENKA_TEST_RESTORE_COUNT: restoreCount,
      },
    },
  );
  const commands = existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '';
  rmSync(directory, { recursive: true, force: true });
  return { commands, result };
}

test('live restore never drops the live database when target disposable verification fails', () => {
  const { commands, result } = runLiveRestoreFailureInjection(1);

  assert.notEqual(
    result.status,
    0,
    `injected target verification failure must abort restore\n${result.stdout}${result.stderr}`,
  );
  assert.doesNotMatch(commands, /DROP DATABASE IF EXISTS.*plenka_pilot/u);
});

test('live restore never drops the live database when pre-restore backup verification fails', () => {
  const { commands, result } = runLiveRestoreFailureInjection(2);

  assert.notEqual(
    result.status,
    0,
    `injected pre-restore verification failure must abort restore\n${result.stdout}${result.stderr}`,
  );
  assert.doesNotMatch(commands, /DROP DATABASE IF EXISTS.*plenka_pilot/u);
});
