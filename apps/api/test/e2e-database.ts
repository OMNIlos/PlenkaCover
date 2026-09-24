import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(API_ROOT, 'prisma/schema.prisma');
const SEED_SCRIPT = resolve(API_ROOT, 'prisma/seed.ts');
const E2E_SCHEMA_ENV = 'PLENKA_E2E_SCHEMA';
const E2E_DATABASE_NAME_ENV = 'PLENKA_E2E_DATABASE_NAME';
const E2E_DATABASE_MARKER_ENV = 'PLENKA_E2E_DATABASE_MARKER';
const PREVIOUS_SEED_PROFILE_ENV = 'PLENKA_E2E_PREVIOUS_SEED_PROFILE';
const UNSET_SEED_PROFILE = '__PLENKA_E2E_UNSET__';
const E2E_SCHEMA_PATTERN = /^e2e_[1-9]\d*_[0-9a-f]{12}$/;
const E2E_DATABASE_NAME_PATTERN = /^plenka_e2e_[a-z0-9_]{1,51}$/;
const E2E_DATABASE_MARKER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLEANUP_FAILURE = 'Failed to remove the isolated e2e database schema';
const SETUP_CLEANUP_FAILURE = `${CLEANUP_FAILURE} after setup failure`;
const LOCAL_DATABASE_ERROR = 'E2E DATABASE_URL must target PostgreSQL on a loopback host';
const DATABASE_TARGET_OVERRIDE_PARAMETERS = new Set(['host', 'hostaddr']);

type E2eGlobal = typeof globalThis & { __PLENKA_E2E_SCHEMA__?: string };

export interface E2eDatabaseClient {
  $executeRawUnsafe(query: string): Promise<unknown>;
  $disconnect(): Promise<void>;
}

export interface E2eDatabaseIdentityClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
  $disconnect(): Promise<void>;
}

export interface E2eCommandResult {
  status: number | null;
  error?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

type RunCommand = (label: string, entrypoint: string, args: string[]) => void;
type DropSchema = (schema: string, databaseUrl: string) => Promise<void>;
type VerifyDisposableTarget = (databaseUrl: string) => Promise<void>;

interface PrepareE2eDatabaseOptions {
  createSchemaName?: () => string;
  runCommand?: RunCommand;
  dropSchema?: DropSchema;
  verifyDisposableTarget?: VerifyDisposableTarget;
}

interface CleanupE2eDatabaseOptions {
  createClient?: () => E2eDatabaseClient;
  verifyDisposableTarget?: VerifyDisposableTarget;
}

export interface E2eCleanupAction {
  label: string;
  run(): void | Promise<void>;
}

class E2eInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eInfrastructureError';
  }
}

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new E2eInfrastructureError(
      'DATABASE_URL is required to create an isolated e2e database schema',
    );
  }
  return value;
}

function isLoopbackDatabaseHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return isIP(normalized) === 4 && normalized.split('.', 1)[0] === '127';
}

function parsePostgresDatabaseUrl(databaseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new E2eInfrastructureError('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new E2eInfrastructureError('E2E database isolation requires a PostgreSQL DATABASE_URL');
  }
  const hasTargetOverride = [...url.searchParams.keys()].some((parameter) =>
    DATABASE_TARGET_OVERRIDE_PARAMETERS.has(parameter.toLowerCase()),
  );
  if (!isLoopbackDatabaseHost(url.hostname) || hasTargetOverride) {
    throw new E2eInfrastructureError(LOCAL_DATABASE_ERROR);
  }
  return url;
}

function databaseUrlForSchema(databaseUrl: string, schema: string): string {
  const url = parsePostgresDatabaseUrl(databaseUrl);
  const callerOptions = url.searchParams
    .getAll('options')
    .map((value) => value.trim())
    .filter(Boolean);
  url.searchParams.set('schema', schema);
  url.searchParams.set('options', [...callerOptions, '-c timezone=UTC'].join(' '));
  return url.toString();
}

function createIdentityClient(databaseUrl: string): E2eDatabaseIdentityClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

export async function assertDisposableDatabaseTarget(
  databaseUrl: string,
  createClient: (databaseUrl: string) => E2eDatabaseIdentityClient = createIdentityClient,
): Promise<void> {
  const url = parsePostgresDatabaseUrl(databaseUrl);
  const configuredName = process.env[E2E_DATABASE_NAME_ENV]?.trim();
  const marker = process.env[E2E_DATABASE_MARKER_ENV]?.trim();
  let urlDatabaseName = '';
  try {
    urlDatabaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new E2eInfrastructureError('E2E database disposable identity is not configured');
  }
  if (
    process.env.NODE_ENV !== 'test' ||
    !configuredName ||
    !marker ||
    !E2E_DATABASE_NAME_PATTERN.test(configuredName) ||
    !E2E_DATABASE_MARKER_PATTERN.test(marker) ||
    urlDatabaseName !== configuredName
  ) {
    throw new E2eInfrastructureError('E2E database disposable identity is not configured');
  }

  const client = createClient(databaseUrl);
  let rows: Array<{ databaseComment: string | null; databaseName: string }> = [];
  let probeFailed = false;
  try {
    rows = await client.$queryRawUnsafe<
      Array<{ databaseComment: string | null; databaseName: string }>
    >(
      `SELECT current_database() AS "databaseName", shobj_description(oid, 'pg_database') AS "databaseComment" FROM pg_database WHERE datname = current_database()`,
    );
  } catch {
    probeFailed = true;
  } finally {
    try {
      await client.$disconnect();
    } catch {
      probeFailed = true;
    }
  }
  const expectedComment = `plenka:e2e-disposable:v1:${marker}`;
  if (
    probeFailed ||
    rows.length !== 1 ||
    rows[0]?.databaseName !== configuredName ||
    rows[0]?.databaseComment !== expectedComment
  ) {
    throw new E2eInfrastructureError('E2E database disposable identity is not verified');
  }
}

export function createE2eSchemaName(
  processId = process.pid,
  entropy: Buffer = randomBytes(6),
): string {
  if (!Number.isSafeInteger(processId) || processId <= 0 || entropy.length !== 6) {
    throw new E2eInfrastructureError('Unable to create a valid isolated e2e schema name');
  }
  return `e2e_${processId}_${entropy.toString('hex')}`;
}

export function assertSchemaDestructionTarget(schema: string, databaseUrl: string): void {
  if (!E2E_SCHEMA_PATTERN.test(schema)) {
    throw new E2eInfrastructureError(
      'Refusing to drop a database schema outside the exact e2e namespace',
    );
  }
  const schemaParameters = parsePostgresDatabaseUrl(databaseUrl).searchParams.getAll('schema');
  if (schemaParameters.length !== 1 || schemaParameters[0] !== schema) {
    throw new E2eInfrastructureError(
      'Refusing to drop an e2e schema that does not match DATABASE_URL',
    );
  }
}

export function assertCommandSucceeded(label: string, result: E2eCommandResult): void {
  if (result.error) {
    throw new E2eInfrastructureError(`${label} failed to start`);
  }
  if (result.status !== 0) {
    const suffix =
      typeof result.status === 'number'
        ? ` with exit code ${result.status}`
        : ' without an exit code';
    throw new E2eInfrastructureError(`${label} failed${suffix}`);
  }
}

export async function runE2eWithCleanup<T>(
  work: () => Promise<T>,
  cleanupActions: readonly E2eCleanupAction[],
): Promise<T> {
  let workOutcome: { ok: true; value: T } | { error: unknown; ok: false };
  try {
    workOutcome = { ok: true, value: await work() };
  } catch (error) {
    workOutcome = { error, ok: false };
  }

  const cleanupFailures: Array<{ error: unknown; label: string }> = [];
  for (const cleanupAction of cleanupActions) {
    try {
      await cleanupAction.run();
    } catch (error) {
      cleanupFailures.push({ error, label: cleanupAction.label });
    }
  }

  if (cleanupFailures.length > 0) {
    const errors = cleanupFailures.map(({ error }) => error);
    const failedLabels = cleanupFailures.map(({ label }) => label).join(', ');
    if (!workOutcome.ok) errors.unshift(workOutcome.error);
    const prefix = workOutcome.ok ? 'E2E cleanup actions failed' : 'E2E work and cleanup failed';
    throw new AggregateError(errors, `${prefix}: ${failedLabels}`);
  }
  if (!workOutcome.ok) throw workOutcome.error;
  return workOutcome.value;
}

function runNodeCommand(label: string, entrypoint: string, args: string[]): void {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: API_ROOT,
    env: process.env,
    stdio: 'ignore',
  });
  assertCommandSucceeded(label, result);
}

function createPrismaClient(): E2eDatabaseClient {
  return new PrismaClient();
}

async function dropE2eSchema(
  schema: string,
  databaseUrl: string,
  createClient: () => E2eDatabaseClient = createPrismaClient,
): Promise<void> {
  assertSchemaDestructionTarget(schema, databaseUrl);
  const prisma = createClient();
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}

function clearE2eState(): void {
  delete (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__;
  delete process.env[E2E_SCHEMA_ENV];
  const previousSeedProfile = process.env[PREVIOUS_SEED_PROFILE_ENV];
  if (previousSeedProfile === UNSET_SEED_PROFILE) {
    delete process.env.SEED_PROFILE;
  } else if (previousSeedProfile !== undefined) {
    process.env.SEED_PROFILE = previousSeedProfile;
  }
  delete process.env[PREVIOUS_SEED_PROFILE_ENV];
}

function safeSetupFailure(error: unknown): E2eInfrastructureError {
  return error instanceof E2eInfrastructureError
    ? error
    : new E2eInfrastructureError('E2E database setup failed');
}

export async function prepareE2eDatabase(options: PrepareE2eDatabaseOptions = {}): Promise<void> {
  const baseDatabaseUrl = requireDatabaseUrl();
  await (options.verifyDisposableTarget ?? assertDisposableDatabaseTarget)(baseDatabaseUrl);
  const schema = (options.createSchemaName ?? createE2eSchemaName)();
  const databaseUrl = databaseUrlForSchema(baseDatabaseUrl, schema);
  assertSchemaDestructionTarget(schema, databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env[PREVIOUS_SEED_PROFILE_ENV] = process.env.SEED_PROFILE ?? UNSET_SEED_PROFILE;
  process.env.SEED_PROFILE = 'demo';
  process.env.SEED_PASSWORD ||= randomBytes(32).toString('base64url');
  process.env.AUTH_DEV_XROLE ??= 'on';
  process.env[E2E_SCHEMA_ENV] = schema;
  (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__ = schema;

  const runCommand = options.runCommand ?? runNodeCommand;
  const dropSchema = options.dropSchema ?? dropE2eSchema;
  try {
    runCommand('Prisma e2e migration', require.resolve('prisma/build/index.js'), [
      'migrate',
      'deploy',
      '--schema',
      PRISMA_SCHEMA,
    ]);
    runCommand('E2E seed', require.resolve('ts-node/dist/bin.js'), [SEED_SCRIPT]);
  } catch (error) {
    const setupFailure = safeSetupFailure(error);
    try {
      await dropSchema(schema, databaseUrl);
    } catch {
      throw new AggregateError(
        [setupFailure, new E2eInfrastructureError(SETUP_CLEANUP_FAILURE)],
        'E2E database setup failed and cleanup failed',
      );
    }
    clearE2eState();
    throw setupFailure;
  }
}

export async function cleanupE2eDatabase(options: CleanupE2eDatabaseOptions = {}): Promise<void> {
  const schema = (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__ ?? process.env[E2E_SCHEMA_ENV];
  if (!schema) return;
  const databaseUrl = requireDatabaseUrl();
  assertSchemaDestructionTarget(schema, databaseUrl);
  await (options.verifyDisposableTarget ?? assertDisposableDatabaseTarget)(databaseUrl);
  try {
    await dropE2eSchema(schema, databaseUrl, options.createClient);
  } catch {
    throw new E2eInfrastructureError(CLEANUP_FAILURE);
  }
  clearE2eState();
}
