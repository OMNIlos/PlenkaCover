import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  createPhysicalDeviceManifest,
  validatePhysicalDeviceManifest,
  verifyPhysicalDeviceManifest,
} from './physical-device-manifest.mjs';

const require = createRequire(import.meta.url);
const {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
} = require('../../packages/contracts/dist/index.js');
const root = resolve(import.meta.dirname, '../..');

const BACKEND_COMMIT = 'a'.repeat(40);
const FRONTEND_COMMIT = 'b'.repeat(40);
const GATEWAY_COMMIT = 'c'.repeat(40);
const BACKEND_DIGEST = `sha256:${'d'.repeat(64)}`;
const FRONTEND_DIGEST = `sha256:${'e'.repeat(64)}`;
const PACKAGE_VERSION = `1:0.0.1+git901.1785844317.${GATEWAY_COMMIT.slice(0, 12)}`;

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'plenka-physical-release-'));
  const packagePath = join(directory, 'plenka-gateway-agent.deb');
  const buildInfoPath = join(directory, 'BUILD-INFO');
  const outputPath = join(directory, 'physical-device-manifest.json');
  const packageBytes = Buffer.from('immutable-gateway-package-fixture');
  writeFileSync(packagePath, packageBytes);
  writeFileSync(
    buildInfoPath,
    [
      `Release-Commit: ${GATEWAY_COMMIT}`,
      'Release-Revision: 901',
      `Debian-Version: ${PACKAGE_VERSION}`,
      `Source-Tree: ${'f'.repeat(40)}`,
      'Source-Date-Epoch: 1785844317',
      'Node-Runtime: 22.23.1',
      `Gateway-Protocol-Version: ${GATEWAY_PROTOCOL_VERSION}`,
      `Gateway-Capabilities: ${GATEWAY_CAPABILITIES.join(',')}`,
      '',
    ].join('\n'),
  );
  return {
    directory,
    packagePath,
    buildInfoPath,
    outputPath,
    packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
  };
}

function createInput(fixture) {
  return {
    outputPath: fixture.outputPath,
    createdAt: '2026-08-04T18:00:00.000Z',
    backendCommit: BACKEND_COMMIT,
    backendImageDigest: BACKEND_DIGEST,
    frontendCommit: FRONTEND_COMMIT,
    frontendImageDigest: FRONTEND_DIGEST,
    gatewayPackagePath: fixture.packagePath,
    gatewayBuildInfoPath: fixture.buildInfoPath,
  };
}

test('creates and verifies an immutable manifest against package bytes and BUILD-INFO', () => {
  const fixture = createFixture();
  try {
    const manifest = createPhysicalDeviceManifest(createInput(fixture));

    assert.deepEqual(manifest.protocol.requiredCapabilities, GATEWAY_CAPABILITIES);
    assert.deepEqual(manifest.protocol.agentCapabilities, GATEWAY_CAPABILITIES);
    assert.equal(manifest.protocol.version, GATEWAY_PROTOCOL_VERSION);
    assert.equal(manifest.gateway.packageSha256, fixture.packageSha256);
    assert.equal(manifest.gateway.sourceCommit, GATEWAY_COMMIT);
    assert.equal(manifest.gateway.packageVersion, PACKAGE_VERSION);
    assert.deepEqual(JSON.parse(readFileSync(fixture.outputPath, 'utf8')), manifest);
    assert.deepEqual(
      verifyPhysicalDeviceManifest({
        manifestPath: fixture.outputPath,
        gatewayPackagePath: fixture.packagePath,
        gatewayBuildInfoPath: fixture.buildInfoPath,
      }),
      manifest,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects missing, duplicate and unknown gateway capabilities', () => {
  const fixture = createFixture();
  try {
    const manifest = createPhysicalDeviceManifest(createInput(fixture));
    const missing = structuredClone(manifest);
    missing.protocol.agentCapabilities.pop();
    assert.throws(() => validatePhysicalDeviceManifest(missing), /agent capability is missing/u);

    const duplicate = structuredClone(manifest);
    duplicate.protocol.agentCapabilities.push(duplicate.protocol.agentCapabilities[0]);
    assert.throws(
      () => validatePhysicalDeviceManifest(duplicate),
      /agentCapabilities contains duplicates/u,
    );

    const unknown = structuredClone(manifest);
    unknown.protocol.agentCapabilities.push('printer.future.v99');
    assert.throws(() => validatePhysicalDeviceManifest(unknown), /unknown agent capability/u);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects protocol drift, malformed immutable identifiers and extra fields', () => {
  const fixture = createFixture();
  try {
    const manifest = createPhysicalDeviceManifest(createInput(fixture));
    assert.throws(
      () =>
        validatePhysicalDeviceManifest({
          ...manifest,
          protocol: { ...manifest.protocol, version: GATEWAY_PROTOCOL_VERSION + 1 },
        }),
      /protocol version/u,
    );
    assert.throws(
      () =>
        validatePhysicalDeviceManifest({
          ...manifest,
          backend: { ...manifest.backend, commit: 'latest' },
        }),
      /backend.commit/u,
    );
    assert.throws(
      () =>
        validatePhysicalDeviceManifest({
          ...manifest,
          frontend: { ...manifest.frontend, imageDigest: 'frontend:latest' },
        }),
      /frontend.imageDigest/u,
    );
    assert.throws(
      () => validatePhysicalDeviceManifest({ ...manifest, credential: 'secret' }),
      /unknown manifest field/u,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('detects package tampering and BUILD-INFO drift after manifest creation', () => {
  const fixture = createFixture();
  try {
    createPhysicalDeviceManifest(createInput(fixture));
    writeFileSync(fixture.packagePath, 'tampered-package');
    assert.throws(
      () =>
        verifyPhysicalDeviceManifest({
          manifestPath: fixture.outputPath,
          gatewayPackagePath: fixture.packagePath,
          gatewayBuildInfoPath: fixture.buildInfoPath,
        }),
      /package checksum/u,
    );

    writeFileSync(fixture.packagePath, 'immutable-gateway-package-fixture');
    writeFileSync(
      fixture.buildInfoPath,
      readFileSync(fixture.buildInfoPath, 'utf8').replace(
        `Gateway-Protocol-Version: ${GATEWAY_PROTOCOL_VERSION}`,
        'Gateway-Protocol-Version: 1',
      ),
    );
    assert.throws(
      () =>
        verifyPhysicalDeviceManifest({
          manifestPath: fixture.outputPath,
          gatewayPackagePath: fixture.packagePath,
          gatewayBuildInfoPath: fixture.buildInfoPath,
        }),
      /BUILD-INFO protocol/u,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('never overwrites an existing manifest or creates missing parent directories', () => {
  const fixture = createFixture();
  try {
    createPhysicalDeviceManifest(createInput(fixture));
    assert.throws(
      () => createPhysicalDeviceManifest(createInput(fixture)),
      /manifest output already exists/u,
    );

    const missingParent = join(fixture.directory, 'missing', 'manifest.json');
    assert.throws(
      () =>
        createPhysicalDeviceManifest({
          ...createInput(fixture),
          outputPath: missingParent,
        }),
      /manifest output parent does not exist/u,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('publishes a strict schema and wires the release gate into local and CI checks', () => {
  const schema = JSON.parse(
    readFileSync(join(root, 'deploy/release/physical-device-manifest.schema.json'), 'utf8'),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'createdAt',
    'backend',
    'frontend',
    'gateway',
    'protocol',
  ]);
  assert.equal(schema.properties.gateway.additionalProperties, false);
  assert.equal(schema.properties.protocol.additionalProperties, false);

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts['test:physical-release'],
    'node --test scripts/release/physical-device-manifest.test.mjs',
  );
  assert.match(packageJson.scripts.test, /test:physical-release/u);

  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /npm run test:physical-release/u);
  assert.match(workflow, /build-deb\.sh --stage-only/u);
});

test('CLI creates and verifies a manifest while rejecting unknown secret-like options', () => {
  const fixture = createFixture();
  const script = join(root, 'scripts/release/physical-device-manifest.mjs');
  try {
    const createArgs = [
      script,
      'create',
      '--output',
      fixture.outputPath,
      '--created-at',
      '2026-08-04T18:00:00.000Z',
      '--backend-commit',
      BACKEND_COMMIT,
      '--backend-image-digest',
      BACKEND_DIGEST,
      '--frontend-commit',
      FRONTEND_COMMIT,
      '--frontend-image-digest',
      FRONTEND_DIGEST,
      '--gateway-package',
      fixture.packagePath,
      '--gateway-build-info',
      fixture.buildInfoPath,
    ];
    const created = spawnSync(process.execPath, createArgs, {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /physical manifest created/u);

    const verified = spawnSync(
      process.execPath,
      [
        script,
        'verify',
        '--manifest',
        fixture.outputPath,
        '--gateway-package',
        fixture.packagePath,
        '--gateway-build-info',
        fixture.buildInfoPath,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /physical manifest verified/u);

    const unknownOutput = join(fixture.directory, 'unknown-option.json');
    const rejected = spawnSync(
      process.execPath,
      [
        ...createArgs.slice(0, 2),
        '--output',
        unknownOutput,
        ...createArgs.slice(4),
        '--credential',
        'must-not-be-printed',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Unknown option: --credential/u);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /must-not-be-printed/u);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
