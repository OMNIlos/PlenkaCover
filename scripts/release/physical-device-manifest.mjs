import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
} = require('../../packages/contracts/dist/index.js');

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const PACKAGE_VERSION_PATTERN = /^1:[0-9]+\.[0-9]+\.[0-9]+(?:[~+][0-9A-Za-z.+~-]+)?$/u;
const ROOT_FIELDS = ['schemaVersion', 'createdAt', 'backend', 'frontend', 'gateway', 'protocol'];
const SOURCE_FIELDS = ['commit', 'imageDigest'];
const GATEWAY_FIELDS = ['sourceCommit', 'packageVersion', 'packageSha256'];
const PROTOCOL_FIELDS = ['version', 'requiredCapabilities', 'agentCapabilities'];

function fail(message) {
  throw new Error(`Physical device manifest invalid: ${message}`);
}

function record(value, label) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function exactFields(value, fields, label) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  const unknown = actual.filter((field) => !expected.includes(field));
  const missing = expected.filter((field) => !actual.includes(field));
  if (unknown.length > 0) fail(`unknown ${label} field: ${unknown.join(', ')}`);
  if (missing.length > 0) fail(`missing ${label} field: ${missing.join(', ')}`);
}

function stringMatching(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${label} has an invalid immutable value`);
  }
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${label} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${label} contains duplicates`);
  }
  return value;
}

function sameArray(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function requireRegularFile(path, label) {
  if (!existsSync(path)) fail(`${label} does not exist`);
  const link = lstatSync(path);
  if (link.isSymbolicLink() || !statSync(path).isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
}

function sha256File(path) {
  requireRegularFile(path, 'gateway package');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseBuildInfo(path) {
  requireRegularFile(path, 'gateway BUILD-INFO');
  const fields = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf(': ');
    if (separator <= 0) fail('gateway BUILD-INFO contains a malformed line');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      fail(`gateway BUILD-INFO contains duplicate field ${key}`);
    }
    fields[key] = value;
  }
  for (const required of [
    'Release-Commit',
    'Debian-Version',
    'Gateway-Protocol-Version',
    'Gateway-Capabilities',
  ]) {
    if (!fields[required]) fail(`gateway BUILD-INFO is missing ${required}`);
  }
  const protocolVersion = Number(fields['Gateway-Protocol-Version']);
  if (!Number.isSafeInteger(protocolVersion)) {
    fail('gateway BUILD-INFO protocol is invalid');
  }
  const capabilities = fields['Gateway-Capabilities'].split(',');
  if (capabilities.length === 0 || capabilities.some((capability) => capability.length === 0)) {
    fail('gateway BUILD-INFO capabilities are invalid');
  }
  return {
    sourceCommit: fields['Release-Commit'],
    packageVersion: fields['Debian-Version'],
    protocolVersion,
    capabilities,
  };
}

export function validatePhysicalDeviceManifest(value) {
  const manifest = record(value, 'manifest');
  exactFields(manifest, ROOT_FIELDS, 'manifest');
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (
    typeof manifest.createdAt !== 'string' ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    new Date(manifest.createdAt).toISOString() !== manifest.createdAt
  ) {
    fail('createdAt must be an exact UTC ISO timestamp');
  }

  const backend = record(manifest.backend, 'backend');
  const frontend = record(manifest.frontend, 'frontend');
  const gateway = record(manifest.gateway, 'gateway');
  const protocol = record(manifest.protocol, 'protocol');
  exactFields(backend, SOURCE_FIELDS, 'backend');
  exactFields(frontend, SOURCE_FIELDS, 'frontend');
  exactFields(gateway, GATEWAY_FIELDS, 'gateway');
  exactFields(protocol, PROTOCOL_FIELDS, 'protocol');

  stringMatching(backend.commit, COMMIT_PATTERN, 'backend.commit');
  stringMatching(backend.imageDigest, DIGEST_PATTERN, 'backend.imageDigest');
  stringMatching(frontend.commit, COMMIT_PATTERN, 'frontend.commit');
  stringMatching(frontend.imageDigest, DIGEST_PATTERN, 'frontend.imageDigest');
  stringMatching(gateway.sourceCommit, COMMIT_PATTERN, 'gateway.sourceCommit');
  stringMatching(gateway.packageVersion, PACKAGE_VERSION_PATTERN, 'gateway.packageVersion');
  stringMatching(gateway.packageSha256, CHECKSUM_PATTERN, 'gateway.packageSha256');
  if (!gateway.packageVersion.endsWith(gateway.sourceCommit.slice(0, 12))) {
    fail('gateway.packageVersion is not bound to gateway.sourceCommit');
  }

  if (protocol.version !== GATEWAY_PROTOCOL_VERSION) {
    fail(
      `protocol version ${String(protocol.version)} does not match backend ${String(
        GATEWAY_PROTOCOL_VERSION,
      )}`,
    );
  }
  const requiredCapabilities = stringArray(protocol.requiredCapabilities, 'requiredCapabilities');
  const agentCapabilities = stringArray(protocol.agentCapabilities, 'agentCapabilities');
  if (!sameArray(requiredCapabilities, GATEWAY_CAPABILITIES)) {
    fail('requiredCapabilities do not match the backend contract');
  }
  for (const capability of agentCapabilities) {
    if (!GATEWAY_CAPABILITIES.includes(capability)) {
      fail(`unknown agent capability: ${capability}`);
    }
  }
  for (const capability of requiredCapabilities) {
    if (!agentCapabilities.includes(capability)) {
      fail(`agent capability is missing: ${capability}`);
    }
  }
  return manifest;
}

function assertBuildInfoMatches(manifest, buildInfo) {
  if (buildInfo.sourceCommit !== manifest.gateway.sourceCommit) {
    fail('gateway BUILD-INFO release commit does not match manifest');
  }
  if (buildInfo.packageVersion !== manifest.gateway.packageVersion) {
    fail('gateway BUILD-INFO package version does not match manifest');
  }
  if (buildInfo.protocolVersion !== manifest.protocol.version) {
    fail('gateway BUILD-INFO protocol does not match manifest');
  }
  if (!sameArray(buildInfo.capabilities, manifest.protocol.agentCapabilities)) {
    fail('gateway BUILD-INFO capabilities do not match manifest');
  }
}

export function createPhysicalDeviceManifest({
  outputPath,
  createdAt,
  backendCommit,
  backendImageDigest,
  frontendCommit,
  frontendImageDigest,
  gatewayPackagePath,
  gatewayBuildInfoPath,
}) {
  const parent = dirname(outputPath);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    fail('manifest output parent does not exist');
  }
  if (existsSync(outputPath)) fail('manifest output already exists');

  const buildInfo = parseBuildInfo(gatewayBuildInfoPath);
  const manifest = {
    schemaVersion: 1,
    createdAt,
    backend: { commit: backendCommit, imageDigest: backendImageDigest },
    frontend: { commit: frontendCommit, imageDigest: frontendImageDigest },
    gateway: {
      sourceCommit: buildInfo.sourceCommit,
      packageVersion: buildInfo.packageVersion,
      packageSha256: sha256File(gatewayPackagePath),
    },
    protocol: {
      version: buildInfo.protocolVersion,
      requiredCapabilities: [...GATEWAY_CAPABILITIES],
      agentCapabilities: [...buildInfo.capabilities],
    },
  };
  validatePhysicalDeviceManifest(manifest);
  assertBuildInfoMatches(manifest, buildInfo);
  try {
    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o640,
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail('manifest output already exists');
    }
    throw error;
  }
  return manifest;
}

export function verifyPhysicalDeviceManifest({
  manifestPath,
  gatewayPackagePath,
  gatewayBuildInfoPath,
}) {
  requireRegularFile(manifestPath, 'manifest');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('manifest is not valid JSON');
  }
  validatePhysicalDeviceManifest(manifest);
  const checksum = sha256File(gatewayPackagePath);
  if (checksum !== manifest.gateway.packageSha256) {
    fail('gateway package checksum does not match manifest');
  }
  assertBuildInfoMatches(manifest, parseBuildInfo(gatewayBuildInfoPath));
  return manifest;
}

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('Every option must be passed as --name value.');
    }
    const key = flag.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      throw new Error(`Duplicate option: --${key}`);
    }
    options[key] = value;
  }
  return options;
}

function requiredOption(options, key) {
  const value = options[key];
  if (!value) throw new Error(`Missing required option: --${key}`);
  return value;
}

function cli() {
  const [command, ...optionArgs] = process.argv.slice(2);
  if (command === 'create') {
    const options = parseOptions(
      optionArgs,
      new Set([
        'output',
        'created-at',
        'backend-commit',
        'backend-image-digest',
        'frontend-commit',
        'frontend-image-digest',
        'gateway-package',
        'gateway-build-info',
      ]),
    );
    const manifest = createPhysicalDeviceManifest({
      outputPath: resolve(requiredOption(options, 'output')),
      createdAt: options['created-at'] ?? new Date().toISOString(),
      backendCommit: requiredOption(options, 'backend-commit'),
      backendImageDigest: requiredOption(options, 'backend-image-digest'),
      frontendCommit: requiredOption(options, 'frontend-commit'),
      frontendImageDigest: requiredOption(options, 'frontend-image-digest'),
      gatewayPackagePath: resolve(requiredOption(options, 'gateway-package')),
      gatewayBuildInfoPath: resolve(requiredOption(options, 'gateway-build-info')),
    });
    process.stdout.write(
      `physical manifest created: protocol=${manifest.protocol.version} package=${manifest.gateway.packageVersion} sha256=${manifest.gateway.packageSha256}\n`,
    );
    return;
  }
  if (command === 'verify') {
    const options = parseOptions(
      optionArgs,
      new Set(['manifest', 'gateway-package', 'gateway-build-info']),
    );
    const manifest = verifyPhysicalDeviceManifest({
      manifestPath: resolve(requiredOption(options, 'manifest')),
      gatewayPackagePath: resolve(requiredOption(options, 'gateway-package')),
      gatewayBuildInfoPath: resolve(requiredOption(options, 'gateway-build-info')),
    });
    process.stdout.write(
      `physical manifest verified: protocol=${manifest.protocol.version} package=${manifest.gateway.packageVersion} sha256=${manifest.gateway.packageSha256}\n`,
    );
    return;
  }
  throw new Error('Usage: physical-device-manifest.mjs create|verify with explicit release paths.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    cli();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`ERROR: ${message}\n`);
    process.exitCode = 1;
  }
}
