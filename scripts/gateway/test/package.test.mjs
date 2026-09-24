import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const require = createRequire(import.meta.url);
const {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
} = require('../../../packages/contracts/dist/index.js');

test('Ubuntu service is outbound-only and runs with a dedicated unprivileged identity', () => {
  const service = read('deploy/gateway-agent/plenka-gateway.service');

  assert.match(
    service,
    /^Documentation=file:\/usr\/share\/doc\/plenka-gateway-agent\/README\.md$/mu,
  );
  assert.match(service, /^User=plenka-gateway$/mu);
  assert.match(service, /^Group=plenka-gateway$/mu);
  assert.match(service, /^SupplementaryGroups=dialout$/mu);
  assert.match(service, /^EnvironmentFile=\/etc\/plenka-gateway\/agent\.env$/mu);
  assert.match(service, /^WorkingDirectory=\/var\/lib\/plenka-gateway$/mu);
  assert.match(
    service,
    /^ExecStart=\/opt\/plenka-gateway\/node \/opt\/plenka-gateway\/main\.js$/mu,
  );
  assert.match(
    service,
    /^ExecStartPre=\/opt\/plenka-gateway\/node --env-file=\/etc\/plenka-gateway\/agent\.env \/opt\/plenka-gateway\/main\.js --check-config$/mu,
  );
  assert.match(service, /^NoNewPrivileges=true$/mu);
  assert.match(service, /^ProtectSystem=strict$/mu);
  assert.match(service, /^ProtectHome=true$/mu);
  assert.match(service, /^PrivateTmp=true$/mu);
  assert.match(service, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/mu);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/plenka-gateway$/mu);
  assert.match(service, /^Restart=always$/mu);
  assert.doesNotMatch(service, /ListenStream|ListenDatagram|0\.0\.0\.0/u);
});

test('physical config template cannot be mistaken for a simulator deployment', () => {
  const env = read('deploy/gateway-agent/agent.env.example');

  assert.match(env, /^GATEWAY_DEPLOYMENT_MODE=physical$/mu);
  assert.match(env, /^GATEWAY_API_URL=https:\/\/replace-with-vps-host\/api$/mu);
  assert.match(env, /^GATEWAY_AGENT_TOKEN=replace-with-one-post-token$/mu);
  assert.match(env, /^SCALE_MODE=massa-k-protocol-100$/mu);
  assert.match(env, /^SCALE_SERIAL_PORT=\/dev\/serial\/by-id\/replace-with-scale$/mu);
  assert.match(env, /^PRINTER_MODE=cups-zpl$/mu);
  assert.match(env, /^PRINTER_CUPS_QUEUE=replace-with-cups-queue$/mu);
  assert.match(env, /^PRINTER_WAREHOUSE_CUPS_QUEUE=replace-with-warehouse-cups-queue$/mu);
  assert.match(env, /^GATEWAY_BUFFER_DIR=\/var\/lib\/plenka-gateway$/mu);
  assert.doesNotMatch(env, /^.*=(?:simulated|serial)$/mu);
  assert.doesNotMatch(env, /agent-post-1|plenka-dev/u);
});

test('package lifecycle preserves state and restarts only an active upgraded service', () => {
  const postinst = read('deploy/gateway-agent/DEBIAN/postinst');
  const prerm = read('deploy/gateway-agent/DEBIAN/prerm');
  const postrm = read('deploy/gateway-agent/DEBIAN/postrm');

  assert.match(postinst, /adduser[\s\S]*--system[\s\S]*plenka-gateway/u);
  assert.match(
    postinst,
    /if ! getent passwd plenka-gateway[\s\S]*install -d -o root -g root -m 0755 \/var\/lib\/plenka-gateway[\s\S]*adduser/u,
  );
  assert.match(
    postinst,
    /install -d -o plenka-gateway -g plenka-gateway -m 0750 \/var\/lib\/plenka-gateway/u,
  );
  assert.match(postinst, /systemctl daemon-reload >\/dev\/null 2>&1 \|\| true/u);
  assert.match(postinst, /\/run\/plenka-gateway-agent\.was-active/u);
  assert.match(postinst, /systemctl start plenka-gateway\.service/u);
  assert.doesNotMatch(postinst, /systemctl (?:enable|restart)/u);
  assert.match(prerm, /systemctl is-active --quiet plenka-gateway\.service/u);
  assert.match(prerm, /systemctl disable --now plenka-gateway\.service/u);
  assert.match(prerm, /systemctl stop plenka-gateway\.service/u);
  assert.doesNotMatch(prerm, /rm -rf \/(?:etc|var\/lib)\/plenka-gateway/u);
  assert.match(postrm, /remove\|purge\|disappear/u);
  assert.match(postrm, /systemctl daemon-reload/u);
  assert.doesNotMatch(postrm, /rm -rf \/(?:etc|var\/lib)\/plenka-gateway/u);
});

test('failed upgrade restart keeps its marker so dpkg configure retry starts the service again', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'plenka-gateway-postinst-'));
  try {
    const bin = join(sandbox, 'bin');
    const marker = join(sandbox, 'plenka-gateway-agent.was-active');
    const startFailure = join(sandbox, 'fail-start-once');
    const systemctlLog = join(sandbox, 'systemctl.log');
    mkdirSync(bin);
    writeFileSync(marker, '');
    writeFileSync(startFailure, '');

    const command = (name, body) => {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`);
      chmodSync(file, 0o755);
    };
    command('getent', 'exit 0');
    command('install', 'exit 0');
    command(
      'systemctl',
      [
        'printf "%s\\n" "$*" >>"$PACKAGE_TEST_SYSTEMCTL_LOG"',
        'if [ "${1:-}" = start ] && [ -f "$PACKAGE_TEST_START_FAILURE" ]; then',
        '  rm -f "$PACKAGE_TEST_START_FAILURE"',
        '  exit 1',
        'fi',
      ].join('\n'),
    );

    const script = read('deploy/gateway-agent/DEBIAN/postinst').replaceAll(
      '/run/plenka-gateway-agent.was-active',
      marker,
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PACKAGE_TEST_START_FAILURE: startFailure,
      PACKAGE_TEST_SYSTEMCTL_LOG: systemctlLog,
    };
    const configure = () =>
      spawnSync('/bin/sh', ['-s', 'configure'], { input: script, env, encoding: 'utf8' });

    const failed = configure();
    assert.notEqual(failed.status, 0);
    assert.equal(existsSync(marker), true);

    const retried = configure();
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(existsSync(marker), false);
    const starts = readFileSync(systemctlLog, 'utf8')
      .split('\n')
      .filter((line) => line === 'start plenka-gateway.service');
    assert.equal(starts.length, 2);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('package declares the Debian account-management commands used by postinst', () => {
  const control = read('deploy/gateway-agent/DEBIAN/control.in');

  assert.match(
    control,
    /^Depends: adduser, cups, cups-client, libc6 \(>= 2\.36\), libstdc\+\+6$/mu,
  );
});

test('release build is full-history bound, descendant-monotonic and cannot erase its target', () => {
  const build = read('scripts/gateway/build-deb.sh');

  assert.match(build, /git diff-index --quiet HEAD --/u);
  assert.match(build, /git rev-parse --is-shallow-repository/u);
  assert.match(build, /git rev-list --count/u);
  assert.match(build, /PLENKA_RELEASE_REVISION/u);
  assert.match(build, /release_sha.*head_sha/u);
  assert.match(build, /git show -s --format=%ct/u);
  assert.match(build, /version=.*release_revision.*source_date_epoch/u);
  assert.match(build, /debian_version="1:\$\{artifact_version\}"/u);
  assert.match(build, /legacy_timestamp_version/u);
  assert.match(build, /dpkg --compare-versions/u);
  assert.match(build, /process\.versions\.node.*22\.23\.1/u);
  assert.match(build, /dpkg-deb[\s\S]*-Zxz/u);
  assert.doesNotMatch(build, /--compression=xz/u);
  assert.doesNotMatch(build, /rm -rf/u);
  assert.match(build, /OUTPUT_DIR must be empty/u);
  assert.match(build, /SOURCE_DATE_EPOCH/u);
  assert.match(build, /GATEWAY_PROTOCOL_VERSION/u);
  assert.match(build, /GATEWAY_CAPABILITIES/u);
});

test('release wrapper pins the complete amd64 builder and needs no host Node toolchain', () => {
  const wrapper = read('scripts/gateway/build-deb-container.sh');

  assert.match(
    wrapper,
    /node:22\.23\.1-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37/u,
  );
  assert.match(wrapper, /--platform linux\/amd64/u);
  assert.match(wrapper, /git diff-index --quiet HEAD --/u);
  assert.match(wrapper, /git rev-parse --is-shallow-repository/u);
  assert.match(wrapper, /git clone --quiet --no-local \/source \/build/u);
  assert.match(wrapper, /npm run build -w @plenka\/contracts/u);
  assert.match(wrapper, /scripts\/gateway\/build-deb\.sh \/out/u);
  assert.doesNotMatch(wrapper, /apt-get|curl|latest/u);
});

test('Ubuntu 24.04 package carries its pinned Node runtime', () => {
  const readme = read('deploy/gateway-agent/README.md');
  const smoke = read('docs/qa/first-hardware-smoke.md');
  const control = read('deploy/gateway-agent/DEBIAN/control.in');
  const probe = read('deploy/gateway-agent/plenka-gateway-probe');

  for (const document of [readme, smoke]) {
    assert.match(document, /Node\.js 22 runtime is bundled/u);
  }
  assert.match(smoke, /\.\/scripts\/gateway\/build-deb-container\.sh release\/gateway/u);
  assert.doesNotMatch(control, /Depends:.*nodejs/u);
  assert.match(
    control,
    /^Depends: adduser, cups, cups-client, libc6 \(>= 2\.36\), libstdc\+\+6$/mu,
  );
  assert.match(probe, /\/opt\/plenka-gateway\/node/u);
  assert.match(smoke, /cd release\/gateway && sha256sum -c/u);
  assert.doesNotMatch(smoke, /> \/tmp\/plenka-scale-/u);
  assert.doesNotMatch(smoke, /journalctl --rotate/u);
  assert.match(readme, /Normal package removal preserves/u);
});

test('stage-only build produces a secret-free amd64 package tree and checksums', () => {
  const output = mkdtempSync(join(tmpdir(), 'plenka-gateway-package-'));
  try {
    execFileSync('bash', ['scripts/gateway/build-deb.sh', '--stage-only', output], {
      cwd: root,
      env: {
        ...process.env,
        PLENKA_RELEASE_SHA: '0123456789abcdef0123456789abcdef01234567',
        PLENKA_RELEASE_REVISION: '123',
        PLENKA_SOURCE_TREE: '89abcdef0123456789abcdef0123456789abcdef',
        SOURCE_DATE_EPOCH: '1784260000',
      },
      stdio: 'pipe',
    });

    const control = readFileSync(join(output, 'root/DEBIAN/control'), 'utf8');
    const manifest = readFileSync(join(output, 'SHA256SUMS'), 'utf8');
    const buildInfo = readFileSync(
      join(output, 'root/usr/share/doc/plenka-gateway-agent/BUILD-INFO'),
      'utf8',
    );
    const installedEnv = readFileSync(
      join(output, 'root/usr/share/doc/plenka-gateway-agent/agent.env.example'),
      'utf8',
    );
    const checkConfig = join(output, 'root/opt/plenka-gateway/check-config.js');
    const main = join(output, 'root/opt/plenka-gateway/main.js');
    const testToken = `ptk_${Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url')}`;
    const physicalEnv = {
      ...process.env,
      GATEWAY_DEPLOYMENT_MODE: 'physical',
      GATEWAY_API_URL: 'https://pilot.plenka.ru/api',
      GATEWAY_AGENT_TOKEN: testToken,
      GATEWAY_POST_CODE: 'POST-1',
      GATEWAY_SCALE_DEVICE_ID: 'scale-post-1',
      GATEWAY_PRINTER_DEVICE_ID: 'printer-post-1',
      GATEWAY_SCANNER_DEVICE_ID: 'scanner-post-1',
      SCANNER_HID_PATH: '/dev/input/by-id/usb-0581_011a-event-kbd',
      SCALE_MODE: 'massa-k-protocol-100',
      SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K_MK-15.2-1234',
      PRINTER_MODE: 'cups-zpl',
      PRINTER_CUPS_QUEUE: 'TLP4',
      PRINTER_WAREHOUSE_CUPS_QUEUE: 'TLP4_WH',
    };

    assert.match(control, /^Package: plenka-gateway-agent$/mu);
    assert.match(control, /^Architecture: amd64$/mu);
    assert.match(control, /^Version: 1:0\.0\.1\+git123\.[0-9]+\.0123456789ab$/mu);
    assert.match(
      control,
      /^Depends: adduser, cups, cups-client, libc6 \(>= 2\.36\), libstdc\+\+6$/mu,
    );
    assert.match(manifest, /opt\/plenka-gateway\/main\.js/u);
    assert.match(manifest, /opt\/plenka-gateway\/probe-scale\.js/u);
    assert.match(buildInfo, /^Release-Commit: 0123456789abcdef0123456789abcdef01234567$/mu);
    assert.match(buildInfo, /^Release-Revision: 123$/mu);
    assert.match(buildInfo, /^Debian-Version: 1:0\.0\.1\+git123\.[0-9]+\.0123456789ab$/mu);
    assert.match(buildInfo, /^Source-Tree: 89abcdef0123456789abcdef0123456789abcdef$/mu);
    assert.match(buildInfo, /^Node-Runtime: 22\.23\.1$/mu);
    assert.match(
      buildInfo,
      new RegExp(`^Gateway-Protocol-Version: ${GATEWAY_PROTOCOL_VERSION}$`, 'mu'),
    );
    assert.match(
      buildInfo,
      new RegExp(
        `^Gateway-Capabilities: ${GATEWAY_CAPABILITIES.join(',').replaceAll('.', '\\.')}$`,
        'mu',
      ),
    );
    assert.doesNotMatch(installedEnv, /agent-post-1|plenka-dev/u);
    assert.match(
      installedEnv,
      /^PRINTER_WAREHOUSE_CUPS_QUEUE=replace-with-warehouse-cups-queue$/mu,
    );
    assert.doesNotMatch(manifest, /agent\.env$/u);

    const valid = spawnSync(process.execPath, [checkConfig], {
      cwd: root,
      env: physicalEnv,
      encoding: 'utf8',
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, 'gateway configuration valid: physical\n');
    assert.doesNotMatch(`${valid.stdout}${valid.stderr}`, new RegExp(testToken, 'u'));

    const missingWarehouseQueue = spawnSync(process.execPath, [checkConfig], {
      cwd: root,
      env: { ...physicalEnv, PRINTER_WAREHOUSE_CUPS_QUEUE: '' },
      encoding: 'utf8',
    });
    assert.equal(missingWarehouseQueue.status, 1);
    assert.equal(missingWarehouseQueue.stdout, '');
    assert.equal(missingWarehouseQueue.stderr, 'gateway configuration invalid\n');
    assert.doesNotMatch(
      `${missingWarehouseQueue.stdout}${missingWarehouseQueue.stderr}`,
      new RegExp(testToken, 'u'),
    );

    const sharedWarehouseQueue = spawnSync(process.execPath, [checkConfig], {
      cwd: root,
      env: { ...physicalEnv, PRINTER_WAREHOUSE_CUPS_QUEUE: physicalEnv.PRINTER_CUPS_QUEUE },
      encoding: 'utf8',
    });
    assert.equal(sharedWarehouseQueue.status, 1);
    assert.equal(sharedWarehouseQueue.stdout, '');
    assert.equal(sharedWarehouseQueue.stderr, 'gateway configuration invalid\n');
    assert.doesNotMatch(
      `${sharedWarehouseQueue.stdout}${sharedWarehouseQueue.stderr}`,
      new RegExp(testToken, 'u'),
    );

    const invalid = spawnSync(process.execPath, [checkConfig], {
      cwd: root,
      env: { ...physicalEnv, GATEWAY_API_URL: 'http://pilot.plenka.ru/api' },
      encoding: 'utf8',
    });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr, 'gateway configuration invalid\n');
    assert.doesNotMatch(`${invalid.stdout}${invalid.stderr}`, new RegExp(testToken, 'u'));

    const bundledValid = spawnSync(process.execPath, [main, '--check-config'], {
      cwd: root,
      env: { ...physicalEnv, NODE_PATH: join(root, 'node_modules') },
      encoding: 'utf8',
    });
    assert.equal(bundledValid.status, 0, bundledValid.stderr);
    assert.equal(bundledValid.stdout, 'gateway configuration valid: physical\n');
    assert.equal(bundledValid.stderr, '');

    const bundledMissingWarehouseQueue = spawnSync(process.execPath, [main, '--check-config'], {
      cwd: root,
      env: {
        ...physicalEnv,
        NODE_PATH: join(root, 'node_modules'),
        PRINTER_WAREHOUSE_CUPS_QUEUE: '',
      },
      encoding: 'utf8',
    });
    assert.equal(bundledMissingWarehouseQueue.status, 1);
    assert.equal(bundledMissingWarehouseQueue.stdout, '');
    assert.equal(bundledMissingWarehouseQueue.stderr, 'gateway configuration invalid\n');
    assert.doesNotMatch(
      `${bundledMissingWarehouseQueue.stdout}${bundledMissingWarehouseQueue.stderr}`,
      new RegExp(testToken, 'u'),
    );

    const bundledInvalid = spawnSync(process.execPath, [main, '--check-config'], {
      cwd: root,
      env: {
        ...physicalEnv,
        NODE_PATH: join(root, 'node_modules'),
        GATEWAY_API_URL: 'http://pilot.plenka.ru/api',
      },
      encoding: 'utf8',
    });
    assert.equal(bundledInvalid.status, 1);
    assert.equal(bundledInvalid.stdout, '');
    assert.equal(bundledInvalid.stderr, 'gateway configuration invalid\n');
    assert.doesNotMatch(
      `${bundledInvalid.stdout}${bundledInvalid.stderr}`,
      new RegExp(testToken, 'u'),
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
