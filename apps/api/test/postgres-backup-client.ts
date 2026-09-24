import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { basename } from 'node:path';

export interface PostgresBackupClientBinaries {
  dump: string;
  restore: string;
  sql: string;
}

interface LoopbackPostgresTarget {
  database: string;
  host: string;
  password: string;
  port: string;
  user: string;
}

const verifiedContainers = new Set<string>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RESTORE_DATABASE_PATTERN = /^plenka_e2e_restore_[0-9a-f]{32}$/u;
const RESTORE_DATABASE_MARKER_PATTERN =
  /^plenka:e2e-restore:v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface DisposableRestoreDatabaseIdentity {
  database: string;
  marker: string;
}

export type PostgresCommandOutcome = 'confirmed' | 'failed' | 'uncertain';
export type DisposableRestoreCreationState = PostgresCommandOutcome | 'not_attempted';

function sanitizedProcessEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith('PG')),
  );
}

function loopbackPostgresTarget(databaseUrl: string): LoopbackPostgresTarget {
  const url = new URL(databaseUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const isLoopback =
    host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.', 1)[0] === '127');
  const overridesTarget = [...url.searchParams.keys()].some((key) =>
    ['host', 'hostaddr'].includes(key.toLowerCase()),
  );
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  if (!isLoopback || overridesTarget) {
    throw new Error('Backup/restore e2e requires a loopback PostgreSQL target');
  }
  if (!database || !user) {
    throw new Error('E2E DATABASE_URL must include a database and user');
  }
  return {
    database,
    host,
    password: decodeURIComponent(url.password),
    port: url.port || '5432',
    user,
  };
}

function databaseUrlForDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function requireRestoreIdentity(identity: DisposableRestoreDatabaseIdentity): void {
  if (
    !RESTORE_DATABASE_PATTERN.test(identity.database) ||
    !RESTORE_DATABASE_MARKER_PATTERN.test(identity.marker)
  ) {
    throw new Error('Disposable restore database identity is invalid');
  }
}

export function createDisposableRestoreDatabaseIdentity(
  parentMarker = process.env.PLENKA_E2E_DATABASE_MARKER?.trim(),
  targetMarker = randomUUID(),
): DisposableRestoreDatabaseIdentity {
  if (!parentMarker || !UUID_PATTERN.test(parentMarker) || !UUID_PATTERN.test(targetMarker)) {
    throw new Error('Disposable restore database identity is not configured');
  }
  return {
    database: `plenka_e2e_restore_${targetMarker.replaceAll('-', '').toLowerCase()}`,
    marker: `plenka:e2e-restore:v1:${parentMarker.toLowerCase()}:${targetMarker.toLowerCase()}`,
  };
}

export function postgresCommandOutcome(result: SpawnSyncReturns<Buffer>): PostgresCommandOutcome {
  if (result.error || result.signal || result.status === null) return 'uncertain';
  return result.status === 0 ? 'confirmed' : 'failed';
}

export function shouldDropDisposableRestoreDatabase(
  state: DisposableRestoreCreationState,
): boolean {
  if (state === 'uncertain') {
    throw new Error('Disposable restore database creation outcome is uncertain; refusing cleanup');
  }
  return state === 'confirmed';
}

export function postgresClientEnvironment(
  databaseUrl: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const target = loopbackPostgresTarget(databaseUrl);
  return {
    ...sanitizedProcessEnvironment(source),
    PGHOST: target.host,
    PGPORT: target.port,
    PGUSER: target.user,
    PGPASSWORD: target.password,
    PGDATABASE: target.database,
  };
}

function postgresContainer(): string | null {
  const container = process.env.PLENKA_E2E_POSTGRES_CONTAINER?.trim();
  if (!container) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(container)) {
    throw new Error('PLENKA_E2E_POSTGRES_CONTAINER is not a valid container name');
  }
  return container;
}

function requireContainerMatchesTarget(container: string, databaseUrl: string): void {
  const target = loopbackPostgresTarget(databaseUrl);
  const cacheKey = `${container}:${target.host}:${target.port}`;
  if (verifiedContainers.has(cacheKey)) return;
  const inspect = spawnSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{json .NetworkSettings.Ports}}|{{.Config.Image}}|{{.State.Running}}',
      container,
    ],
    {
      env: sanitizedProcessEnvironment(),
      maxBuffer: 1024 * 1024,
    },
  );
  requirePostgresCommandSuccess('PostgreSQL test container inspection', inspect);
  const [portsJson, image, running] = inspect.stdout.toString('utf8').trim().split('|');
  let ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  try {
    ports = JSON.parse(portsJson ?? '') as typeof ports;
  } catch {
    throw new Error('PostgreSQL test container returned invalid port metadata');
  }
  const mapped = ports['5432/tcp'] ?? [];
  if (
    running !== 'true' ||
    !/^postgres:\d+(?:[.-]|$)/u.test(image ?? '') ||
    !mapped.some((binding) => binding.HostPort === target.port)
  ) {
    throw new Error(
      'PLENKA_E2E_POSTGRES_CONTAINER does not match the validated loopback PostgreSQL target',
    );
  }
  verifiedContainers.add(cacheKey);
}

export function runPostgresClient(
  command: string,
  databaseUrl: string,
  args: string[],
  maxBuffer: number,
  input?: Buffer,
): SpawnSyncReturns<Buffer> {
  const container = postgresContainer();
  if (container) {
    requireContainerMatchesTarget(container, databaseUrl);
    const tool = basename(command);
    if (!['pg_dump', 'pg_restore', 'psql'].includes(tool)) {
      throw new Error(`Unsupported PostgreSQL container client: ${tool}`);
    }
    return spawnSync(
      'docker',
      [
        'exec',
        '--interactive',
        '--env',
        'PGHOST',
        '--env',
        'PGPORT',
        '--env',
        'PGUSER',
        '--env',
        'PGPASSWORD',
        '--env',
        'PGDATABASE',
        container,
        tool,
        ...args,
      ],
      {
        env: {
          ...postgresClientEnvironment(databaseUrl),
          PGHOST: '127.0.0.1',
          PGPORT: '5432',
        },
        input,
        maxBuffer,
      },
    );
  }
  return spawnSync(command, args, {
    env: postgresClientEnvironment(databaseUrl),
    input,
    maxBuffer,
  });
}

function commandOutput(result: SpawnSyncReturns<Buffer>): string {
  return `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`.trim();
}

export function requirePostgresCommandSuccess(
  label: string,
  result: SpawnSyncReturns<Buffer>,
): void {
  if (result.error) {
    const code = 'code' in result.error ? String(result.error.code) : result.error.name;
    throw new Error(`${label} failed to start (${code})`);
  }
  if (result.signal) {
    throw new Error(`${label} terminated by signal ${result.signal}: ${commandOutput(result)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${String(result.status)}: ${commandOutput(result)}`,
    );
  }
}

export function postgresMajorVersion(output: string): number {
  const match = output.match(/(?:PostgreSQL\)?\s+)?(\d+)(?:\.\d+)?/u);
  const major = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(major) || major < 10) {
    throw new Error(`Cannot determine PostgreSQL major version from: ${output.trim()}`);
  }
  return major;
}

function commandVersion(label: string, command: string, databaseUrl: string): number {
  const result = runPostgresClient(command, databaseUrl, ['--version'], 1024 * 1024);
  requirePostgresCommandSuccess(label, result);
  return postgresMajorVersion(commandOutput(result));
}

export function requireBackupClientCompatibility(
  databaseUrl: string,
  binaries: PostgresBackupClientBinaries,
): { dumpMajor: number; restoreMajor: number; serverMajor: number } {
  const server = runPostgresClient(
    binaries.sql,
    databaseUrl,
    ['--no-psqlrc', '--tuples-only', '--no-align', '--command=SHOW server_version_num'],
    1024 * 1024,
  );
  requirePostgresCommandSuccess('PostgreSQL server version probe', server);
  const versionNumber = Number(server.stdout.toString('utf8').trim());
  const serverMajor = Math.floor(versionNumber / 10_000);
  if (!Number.isSafeInteger(versionNumber) || serverMajor < 10) {
    throw new Error('PostgreSQL server returned an invalid server_version_num');
  }

  const dumpMajor = commandVersion('pg_dump version probe', binaries.dump, databaseUrl);
  const restoreMajor = commandVersion('pg_restore version probe', binaries.restore, databaseUrl);
  if (dumpMajor !== restoreMajor || dumpMajor < serverMajor) {
    throw new Error(
      `Backup/restore client mismatch: server=${serverMajor}, pg_dump=${dumpMajor}, pg_restore=${restoreMajor}. Configure matching PLENKA_E2E_PG_*_BIN paths.`,
    );
  }
  return { dumpMajor, restoreMajor, serverMajor };
}

export function markDisposableRestoreDatabase(
  maintenanceDatabaseUrl: string,
  identity: DisposableRestoreDatabaseIdentity,
  sqlBinary: string,
  runClient = runPostgresClient,
): void {
  requireRestoreIdentity(identity);
  const result = runClient(
    sqlBinary,
    maintenanceDatabaseUrl,
    [
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--command',
      `COMMENT ON DATABASE ${quoteIdentifier(identity.database)} IS ${quoteLiteral(identity.marker)};`,
    ],
    1024 * 1024,
  );
  requirePostgresCommandSuccess('Disposable restore database marker creation', result);
}

export function requireDisposableRestoreDatabase(
  baseDatabaseUrl: string,
  identity: DisposableRestoreDatabaseIdentity,
  sqlBinary: string,
  runClient = runPostgresClient,
): void {
  requireRestoreIdentity(identity);
  const targetUrl = databaseUrlForDatabase(baseDatabaseUrl, identity.database);
  const result = runClient(
    sqlBinary,
    targetUrl,
    [
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--field-separator=\t',
      '--command',
      `SELECT current_database(), COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()`,
    ],
    1024 * 1024,
  );
  requirePostgresCommandSuccess('Disposable restore database identity probe', result);
  const [database, marker, ...extra] = result.stdout.toString('utf8').trimEnd().split('\t');
  if (extra.length > 0 || database !== identity.database || marker !== identity.marker) {
    throw new Error('Disposable restore database identity is not verified');
  }
}

export function dropDisposableRestoreDatabase(
  baseDatabaseUrl: string,
  maintenanceDatabaseUrl: string,
  identity: DisposableRestoreDatabaseIdentity,
  sqlBinary: string,
  runClient = runPostgresClient,
): void {
  requireDisposableRestoreDatabase(baseDatabaseUrl, identity, sqlBinary, runClient);
  const result = runClient(
    sqlBinary,
    maintenanceDatabaseUrl,
    [
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--command',
      `DROP DATABASE ${quoteIdentifier(identity.database)} WITH (FORCE);`,
    ],
    1024 * 1024,
  );
  requirePostgresCommandSuccess('Disposable restore database cleanup', result);
}
