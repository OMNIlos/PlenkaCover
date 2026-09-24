import {
  PALLET_LABEL_CONFIGURABLE_PROFILE,
  PALLET_LABEL_SNAPSHOT_PROFILES,
  type PalletLabelSnapshotProfile,
} from '@plenka/contracts';

export const APP_ENVIRONMENTS = ['development', 'test', 'pilot', 'production'] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export interface RuntimeConfig {
  appEnv: AppEnvironment;
  corsOrigins: string[];
  devXRoleEnabled: boolean;
  deviceGatewayPrinterEnabled: boolean;
  deviceGatewayScaleEnabled: boolean;
  gatewayCommandTimeoutMs: number;
  gatewaySimulatorEnabled: boolean;
  gatewayStaleAfterSec: number;
  isSecureProfile: boolean;
  loginRateMax: number;
  loginRateMaxKeys: number;
  loginRateWindowMs: number;
  onecLiveEnabled: boolean;
  onecFinanceSyncEnabled: boolean;
  onecFinanceSyncIntervalMs: number;
  onecPaymentSyncEnabled: boolean;
  onecPaymentAutoApplyEnabled: boolean;
  onecSyncEnabled: boolean;
  onecSyncIntervalMs: number;
  onecSyncPageSize: number;
  onecTimeoutMs: number;
  onecWriteEnabled: boolean;
  passwordSetupTtlSeconds: number;
  palletLabelProfile: PalletLabelSnapshotProfile;
  pilotShortPasswordsEnabled: boolean;
  port: number;
  productionCostReconcilerBatchSize: number;
  productionCostReconcilerEnabled: boolean;
  productionCostReconcilerIntervalMs: number;
  publicOrigin?: string;
  sessionTtlSeconds: number;
  warehouseCoverageV2Enabled: boolean;
}

export const GATEWAY_COMMAND_TIMEOUT_MAX_MS = 120_000;

type Environment = Record<string, string | undefined>;

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(`Invalid runtime configuration: ${message}`);
    this.name = 'RuntimeConfigError';
  }
}

function readOnOff(env: Environment, key: string): boolean {
  const value = env[key];
  if (value === undefined || value === 'off') return false;
  if (value === 'on') return true;
  throw new RuntimeConfigError(`${key} must be exactly "on" or "off"`);
}

function readTrueFalse(env: Environment, key: string): boolean {
  const value = env[key];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new RuntimeConfigError(`${key} must be exactly "true" or "false"`);
}

function readPalletLabelProfile(env: Environment): PalletLabelSnapshotProfile {
  const value = env.PALLET_LABEL_PROFILE ?? 'pallet-100x150-v1';
  const runtimeProfiles = PALLET_LABEL_SNAPSHOT_PROFILES.filter(
    (profile) => profile !== PALLET_LABEL_CONFIGURABLE_PROFILE,
  );
  if ((runtimeProfiles as readonly string[]).includes(value)) {
    return value as PalletLabelSnapshotProfile;
  }
  throw new RuntimeConfigError(
    `PALLET_LABEL_PROFILE must be exactly one of: ${runtimeProfiles.join(', ')}`,
  );
}

function readBoundedInteger(
  env: Environment,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = env[key] === undefined ? defaultValue : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RuntimeConfigError(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseExactOrigin(value: string, key: string, requireHttps: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigError(`${key} must contain exact HTTP origins`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    (requireHttps && url.protocol !== 'https:') ||
    url.origin !== value ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new RuntimeConfigError(`${key} must contain exact HTTP origins without paths`);
  }
  return url.origin;
}

function parseCorsOrigins(value: string | undefined, requireHttps: boolean): string[] {
  if (value === undefined || value === '') return [];
  const origins = value.split(',').map((origin) => origin.trim());
  if (origins.some((origin) => origin === '' || origin === '*')) {
    throw new RuntimeConfigError('CORS_ORIGINS cannot contain empty or wildcard origins');
  }
  const parsed = origins.map((origin) => parseExactOrigin(origin, 'CORS_ORIGINS', requireHttps));
  if (new Set(parsed).size !== parsed.length) {
    throw new RuntimeConfigError('CORS_ORIGINS cannot contain duplicate origins');
  }
  return parsed;
}

function parseIpv4Part(part: string): bigint | null {
  try {
    if (/^0x[0-9a-f]+$/i.test(part)) return BigInt(part);
    if (/^0[0-7]+$/.test(part) && part.length > 1) return BigInt(`0o${part.slice(1)}`);
    if (/^\d+$/.test(part)) return BigInt(part);
  } catch {
    return null;
  }
  return null;
}

/** Parses the decimal/octal/hex and abbreviated IPv4 forms accepted by common resolvers. */
function parseNumericIpv4(hostname: string): bigint | null {
  const parts = hostname.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values = parts.map(parseIpv4Part);
  if (values.some((value) => value === null)) return null;
  const numericValues = values as bigint[];
  const [a, b = 0n, c = 0n, d = 0n] = numericValues;

  if (parts.length === 1) return a <= 0xffff_ffffn ? a : null;
  if (parts.length === 2) {
    return a <= 0xffn && b <= 0xff_ffffn ? (a << 24n) + b : null;
  }
  if (parts.length === 3) {
    return a <= 0xffn && b <= 0xffn && c <= 0xffffn ? (a << 24n) + (b << 16n) + c : null;
  }
  return numericValues.every((value) => value <= 0xffn)
    ? (a << 24n) + (b << 16n) + (c << 8n) + d
    : null;
}

function isLocalIpv4(value: bigint | null): boolean {
  if (value === null) return false;
  const firstOctet = Number(value >> 24n);
  return firstOctet === 0 || firstOctet === 127;
}

function isLocalOrUnspecifiedHost(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::' || hostname === '::1') return true;

  if (hostname.startsWith('::ffff:')) {
    const mapped = hostname.slice('::ffff:'.length);
    const pair = mapped.split(':');
    const mappedIpv4 =
      pair.length === 2 && pair.every((part) => /^[0-9a-f]{1,4}$/i.test(part))
        ? (BigInt(`0x${pair[0]}`) << 16n) + BigInt(`0x${pair[1]}`)
        : parseNumericIpv4(mapped);
    return isLocalIpv4(mappedIpv4);
  }

  return isLocalIpv4(parseNumericIpv4(hostname));
}

function parseCanonicalIpv4(value: string): readonly [number, number, number, number] | null {
  const parts = value.split('.');
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)
  ) {
    return null;
  }
  return parts.map(Number) as [number, number, number, number];
}

/** IANA special-purpose ranges that cannot identify this deployment's public ACME endpoint. */
function isSpecialUseIpv4([first, second, third]: readonly number[]): boolean {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 31 && third === 196) ||
    (first === 192 && second === 52 && third === 193) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 175 && third === 48) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

const PUBLIC_ACME_INELIGIBLE_DNS_SUFFIXES = [
  'localhost',
  'test',
  'invalid',
  'example',
  'local',
  'onion',
  'internal',
  'alt',
  'arpa',
  'home.arpa',
  'example.com',
  'example.net',
  'example.org',
] as const;

function isCanonicalDnsHost(value: string): boolean {
  if (value.length < 3 || value.length > 253) return false;
  const labels = value.split('.');
  return (
    labels.length >= 2 &&
    /^[a-z]/.test(labels.at(-1) ?? '') &&
    !labels.some((label) => label.startsWith('xn--')) &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9])$/.test(label),
    ) &&
    !PUBLIC_ACME_INELIGIBLE_DNS_SUFFIXES.some(
      (suffix) => value === suffix || value.endsWith(`.${suffix}`),
    )
  );
}

export function isPublicDeploymentHost(value: string): boolean {
  const ipv4 = parseCanonicalIpv4(value);
  if (ipv4) return !isSpecialUseIpv4(ipv4);
  if (parseNumericIpv4(value) !== null || isLocalOrUnspecifiedHost(value)) return false;
  return isCanonicalDnsHost(value);
}

function decodeDatabaseCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RuntimeConfigError('DATABASE_URL contains invalid encoded credentials');
  }
}

const RESERVED_POSTGRES_DATABASES = new Set(['postgres', 'template0', 'template1']);

function readApplicationDatabaseName(url: URL): string | null {
  try {
    const name = decodeURIComponent(url.pathname.slice(1));
    return /^[a-z][a-z0-9_]{2,62}$/.test(name) && !RESERVED_POSTGRES_DATABASES.has(name)
      ? name
      : null;
  } catch {
    return null;
  }
}

function requireSecureDatabaseUrl(value: string | undefined): void {
  if (!value) {
    throw new RuntimeConfigError('DATABASE_URL is required in pilot and production');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigError('DATABASE_URL must be a valid PostgreSQL URL');
  }

  const username = decodeDatabaseCredential(url.username);
  const password = decodeDatabaseCredential(url.password);
  const weakCredentials =
    !username ||
    !password ||
    password.length < 16 ||
    (username === 'plenka' && password === 'plenka');
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    isLocalOrUnspecifiedHost(url.hostname) ||
    readApplicationDatabaseName(url) === null ||
    weakCredentials
  ) {
    throw new RuntimeConfigError(
      'DATABASE_URL must use PostgreSQL, a non-local host and non-development credentials',
    );
  }
}

function requireSecurePublicOrigin(value: string | undefined): string {
  if (!value) {
    throw new RuntimeConfigError('PUBLIC_ORIGIN is required in pilot and production');
  }

  const origin = parseExactOrigin(value, 'PUBLIC_ORIGIN', true);
  if (!isPublicDeploymentHost(new URL(origin).hostname)) {
    throw new RuntimeConfigError(
      'PUBLIC_ORIGIN must use a canonical globally routable deployment host',
    );
  }
  return origin;
}

function rejectSharedSeedPasswordDefaults(value: string | undefined): void {
  if (value && /^plenka-(?:dev|demo)(?:$|-)/i.test(value)) {
    throw new RuntimeConfigError(
      'SEED_PASSWORD must not use a documented shared development or demo value',
    );
  }
}

function validateOneCConfiguration(
  env: Environment,
  liveEnabled: boolean,
  writeEnabled: boolean,
  secureProfile: boolean,
): void {
  if (writeEnabled && !liveEnabled) {
    throw new RuntimeConfigError('ONEC_WRITE requires ONEC_LIVE=true');
  }
  if (
    secureProfile &&
    writeEnabled &&
    env.ONEC_WRITE_CONFIRM !== 'I_UNDERSTAND_DEMO_1C_STOCK_POSTING'
  ) {
    throw new RuntimeConfigError(
      'ONEC_WRITE_CONFIRM must explicitly acknowledge demo 1C stock posting',
    );
  }
  if (!liveEnabled) {
    if (secureProfile) {
      const staleConnectionKey = [
        'ONEC_BASE_URL',
        'ONEC_USERNAME',
        'ONEC_PASSWORD',
        'ONEC_WRITE_CONFIRM',
        'ONEC_INVOICE_ORDER_REFERENCE_FIELD',
        'ONEC_ORG_KEY',
        'ONEC_WAREHOUSE_KEY',
        'ONEC_GOODS_ACCOUNT_KEY',
        'ONEC_STOCK_NOMENCLATURE',
      ].find((key) => env[key] !== undefined);
      if (staleConnectionKey) {
        throw new RuntimeConfigError(
          `${staleConnectionKey} must be absent when ONEC_LIVE=false`,
        );
      }
    }
    return;
  }

  const baseUrl = env.ONEC_BASE_URL;
  if (!baseUrl) {
    throw new RuntimeConfigError('ONEC_BASE_URL is required when ONEC_LIVE=true');
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RuntimeConfigError('ONEC_BASE_URL must be a valid HTTP URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    (secureProfile && url.protocol !== 'https:')
  ) {
    throw new RuntimeConfigError('ONEC_BASE_URL must use an allowed secure protocol');
  }
  if (!env.ONEC_USERNAME) {
    throw new RuntimeConfigError('ONEC_USERNAME is required when ONEC_LIVE=true');
  }
  if (!env.ONEC_PASSWORD) {
    throw new RuntimeConfigError('ONEC_PASSWORD is required when ONEC_LIVE=true');
  }
}

function validateOneCSyncConfiguration(
  syncEnabled: boolean,
  financeSyncEnabled: boolean,
  paymentSyncEnabled: boolean,
  paymentAutoApplyEnabled: boolean,
  liveEnabled: boolean,
  writeEnabled: boolean,
): void {
  const requestedBackgroundFlag = [
    ['ONEC_SYNC_ENABLED', syncEnabled],
    ['ONEC_FINANCE_SYNC_ENABLED', financeSyncEnabled],
    ['ONEC_PAYMENT_SYNC_ENABLED', paymentSyncEnabled],
    ['ONEC_PAYMENT_AUTO_APPLY_ENABLED', paymentAutoApplyEnabled],
  ].find(([, enabled]) => enabled)?.[0];
  if (requestedBackgroundFlag && !liveEnabled) {
    throw new RuntimeConfigError(`${requestedBackgroundFlag}=true requires ONEC_LIVE=true`);
  }
  if (syncEnabled && writeEnabled) {
    throw new RuntimeConfigError('ONEC_SYNC_ENABLED=true requires ONEC_WRITE=false');
  }
}

export function loadRuntimeConfig(env: Environment): RuntimeConfig {
  const appEnv = env.APP_ENV;
  if (!(APP_ENVIRONMENTS as readonly string[]).includes(appEnv ?? '')) {
    throw new RuntimeConfigError(`APP_ENV must be exactly one of: ${APP_ENVIRONMENTS.join(', ')}`);
  }

  const devXRoleRequested = readOnOff(env, 'AUTH_DEV_XROLE');
  if (env.NODE_ENV === 'production' && devXRoleRequested) {
    throw new RuntimeConfigError('AUTH_DEV_XROLE must be off when NODE_ENV=production');
  }
  const deviceGatewayPrinterEnabled = readOnOff(env, 'DEVICE_GATEWAY_PRINTER');
  const deviceGatewayScaleEnabled = readOnOff(env, 'DEVICE_GATEWAY_SCALE');
  const gatewayCommandTimeoutMs = readBoundedInteger(
    env,
    'GATEWAY_COMMAND_TIMEOUT_MS',
    5_000,
    100,
    GATEWAY_COMMAND_TIMEOUT_MAX_MS,
  );
  const gatewaySimulatorEnabled = readOnOff(env, 'GATEWAY_SIMULATOR');
  const gatewayStaleAfterSec = readBoundedInteger(env, 'GATEWAY_STALE_AFTER_SEC', 90, 1, 86_400);
  const isSecureProfile = appEnv === 'pilot' || appEnv === 'production';
  const devXRoleEnabled = appEnv === 'development' && devXRoleRequested;
  const onecLiveEnabled = readTrueFalse(env, 'ONEC_LIVE');
  const onecFinanceSyncEnabled = readTrueFalse(env, 'ONEC_FINANCE_SYNC_ENABLED');
  const onecFinanceSyncIntervalMs = readBoundedInteger(
    env,
    'ONEC_FINANCE_SYNC_INTERVAL_MS',
    300_000,
    60_000,
    86_400_000,
  );
  const onecPaymentSyncEnabled = readTrueFalse(env, 'ONEC_PAYMENT_SYNC_ENABLED');
  const onecPaymentAutoApplyEnabled = readTrueFalse(env, 'ONEC_PAYMENT_AUTO_APPLY_ENABLED');
  const onecSyncEnabled = readTrueFalse(env, 'ONEC_SYNC_ENABLED');
  const onecSyncIntervalMs = readBoundedInteger(
    env,
    'ONEC_SYNC_INTERVAL_MS',
    900_000,
    60_000,
    86_400_000,
  );
  const onecSyncPageSize = readBoundedInteger(env, 'ONEC_SYNC_PAGE_SIZE', 250, 50, 500);
  const onecTimeoutMs = readBoundedInteger(env, 'ONEC_TIMEOUT_MS', 5_000, 100, 120_000);
  const onecWriteEnabled = readTrueFalse(env, 'ONEC_WRITE');
  const pilotShortPasswordsEnabled = readTrueFalse(env, 'PILOT_SHORT_PASSWORDS_ENABLED');
  const warehouseCoverageV2Enabled = readTrueFalse(env, 'WAREHOUSE_COVERAGE_V2_ENABLED');
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS, isSecureProfile);
  const loginRateMax = readBoundedInteger(env, 'LOGIN_RATE_MAX', 10, 1, 100);
  const loginRateMaxKeys = readBoundedInteger(env, 'LOGIN_RATE_MAX_KEYS', 10_000, 100, 100_000);
  const loginRateWindowMs = readBoundedInteger(
    env,
    'LOGIN_RATE_WINDOW_MS',
    60_000,
    1_000,
    3_600_000,
  );
  const passwordSetupTtlSeconds = readBoundedInteger(env, 'PASSWORD_SETUP_TTL', 1_800, 300, 3_600);
  const palletLabelProfile = readPalletLabelProfile(env);
  const port = readBoundedInteger(env, 'PORT', 3_000, 1, 65_535);
  const productionCostReconcilerEnabled = readTrueFalse(env, 'PRODUCTION_COST_RECONCILER_ENABLED');
  const productionCostReconcilerIntervalMs = readBoundedInteger(
    env,
    'PRODUCTION_COST_RECONCILER_INTERVAL_MS',
    60_000,
    60_000,
    86_400_000,
  );
  const productionCostReconcilerBatchSize = readBoundedInteger(
    env,
    'PRODUCTION_COST_RECONCILER_BATCH_SIZE',
    100,
    1,
    1_000,
  );
  const sessionTtlSeconds = readBoundedInteger(env, 'SESSION_TTL', 43_200, 300, 604_800);
  let publicOrigin: string | undefined;

  if (pilotShortPasswordsEnabled && appEnv !== 'pilot') {
    throw new RuntimeConfigError('PILOT_SHORT_PASSWORDS_ENABLED=true requires APP_ENV=pilot');
  }
  if (onecPaymentAutoApplyEnabled && !onecPaymentSyncEnabled) {
    throw new RuntimeConfigError(
      'ONEC_PAYMENT_AUTO_APPLY_ENABLED=true requires ONEC_PAYMENT_SYNC_ENABLED=true',
    );
  }

  if (isSecureProfile) {
    if (devXRoleRequested) {
      throw new RuntimeConfigError('AUTH_DEV_XROLE must be off in pilot and production');
    }
    if (gatewaySimulatorEnabled) {
      throw new RuntimeConfigError('GATEWAY_SIMULATOR must be off in pilot and production');
    }
    requireSecureDatabaseUrl(env.DATABASE_URL);
    publicOrigin = requireSecurePublicOrigin(env.PUBLIC_ORIGIN);
    rejectSharedSeedPasswordDefaults(env.SEED_PASSWORD);
  }

  validateOneCConfiguration(env, onecLiveEnabled, onecWriteEnabled, isSecureProfile);
  validateOneCSyncConfiguration(
    onecSyncEnabled,
    onecFinanceSyncEnabled,
    onecPaymentSyncEnabled,
    onecPaymentAutoApplyEnabled,
    onecLiveEnabled,
    onecWriteEnabled,
  );

  return {
    appEnv: appEnv as AppEnvironment,
    corsOrigins,
    devXRoleEnabled,
    deviceGatewayPrinterEnabled,
    deviceGatewayScaleEnabled,
    gatewayCommandTimeoutMs,
    gatewaySimulatorEnabled,
    gatewayStaleAfterSec,
    isSecureProfile,
    loginRateMax,
    loginRateMaxKeys,
    loginRateWindowMs,
    onecLiveEnabled,
    onecFinanceSyncEnabled,
    onecFinanceSyncIntervalMs,
    onecPaymentSyncEnabled,
    onecPaymentAutoApplyEnabled,
    onecSyncEnabled,
    onecSyncIntervalMs,
    onecSyncPageSize,
    onecTimeoutMs,
    onecWriteEnabled,
    passwordSetupTtlSeconds,
    palletLabelProfile,
    pilotShortPasswordsEnabled,
    port,
    productionCostReconcilerBatchSize,
    productionCostReconcilerEnabled,
    productionCostReconcilerIntervalMs,
    publicOrigin,
    sessionTtlSeconds,
    warehouseCoverageV2Enabled,
  };
}
