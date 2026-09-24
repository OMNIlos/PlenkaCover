import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkScale } from './hardware-preflight.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'hardware-preflight.mjs'), 'utf8');
const buildSource = readFileSync(path.join(here, 'build-protected-demo.mjs'), 'utf8');
const installSource = readFileSync(path.join(here, 'windows/install.ps1'), 'utf8');
const customerReadme = readFileSync(path.join(here, 'README.customer.md'), 'utf8');
const docsDir = path.resolve(here, '../../docs');
const windowsRunbook = readFileSync(path.join(docsDir, 'protected-windows-demo.md'), 'utf8');
const productionRunbook = readFileSync(
  path.join(docsDir, 'device-gateway-production-demo.md'),
  'utf8',
);
const hardwareGuide = readFileSync(path.join(docsDir, 'hardware-integration-guide.md'), 'utf8');
const protocol = 'massa-k-protocol-100';
const physicalProjection = {
  probe: {
    ok: true,
    status: 'ready',
    protocol,
    simulated: false,
    identity: { manufacturer: 'MASSA-K', scaleId: -12345, name: 'Весы МК-15.2' },
    parameters: {
      maximum: 'Max 6/15 кг',
      minimum: 'Min 0,04 кг',
      verificationInterval: 'e = 2/5 г',
      maximumTare: 'T = - 6 кг',
      fixation: 'Fix = 0',
      calibrationCode: 'Code = 012345',
      softwareVersion: 'V3',
      softwareChecksum: 'F855CE01',
    },
  },
  reading: {
    status: 'ready',
    stable: true,
    grossKg: 43.4,
    divisionKg: 0.01,
    net: false,
    zero: false,
  },
};

function harness(result) {
  const calls = [];
  const records = [];
  const agentDir = path.join(path.sep, 'protected-demo', 'apps', 'gateway-agent');
  return {
    agentDir,
    calls,
    records,
    options: {
      agentDir,
      baseEnv: { SYSTEM_SETTING: 'preserved' },
      emit: (record) => records.push(record),
      runChild: (...args) => {
        calls.push(args);
        return result;
      },
    },
  };
}

test('exposes an import-safe scale-check seam', () => {
  assert.match(source, /export async function checkScale\(/);
  assert.doesNotMatch(source, /^void main\(\);$/m);
  assert.doesNotMatch(
    source,
    /decodePollCommand|Scale raw frame received|import\(['"]serialport['"]\)/,
  );
});

test('runs the exact compiled Protocol 100 probe from the gateway directory', async () => {
  const execution = harness({
    status: 0,
    stdout: `${JSON.stringify(physicalProjection)}\n`,
    stderr: '',
  });
  const cfg = {
    SCALE_MODE: protocol,
    SCALE_SERIAL_PORT: 'COM7',
    SCALE_SERIAL_BAUD: '57600',
  };

  const passed = await checkScale(cfg, execution.options);

  assert.equal(passed, true);
  assert.equal(execution.calls.length, 1);
  const [command, args, options] = execution.calls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [path.join(execution.agentDir, 'dist', 'probe-scale.js')]);
  assert.equal(options.cwd, execution.agentDir);
  assert.equal(options.env.SYSTEM_SETTING, 'preserved');
  assert.equal(options.env.SCALE_MODE, protocol);
  assert.equal(options.env.SCALE_SERIAL_PORT, 'COM7');
  assert.equal(options.env.SCALE_SERIAL_BAUD, '57600');
  assert.deepEqual(execution.records, [
    {
      ok: true,
      message: 'Physical Protocol 100 scale validated',
      mode: protocol,
      status: 'ready',
      stable: true,
      authoritative: true,
    },
  ]);
});

for (const [caseName, childResult] of [
  [
    'probe exit 1',
    {
      status: 1,
      stdout: '{"raw":"f855ce-private-frame"}',
      stderr: 'token=platform-private at C:\\devices\\COM7',
    },
  ],
  [
    'probe exit 2',
    {
      status: 2,
      stdout: '{"raw":"f855ce-private-frame"}',
      stderr: 'token=platform-private at /dev/ttyUSB0',
    },
  ],
  [
    'non-JSON output',
    {
      status: 0,
      stdout: 'f855ce-private-frame at /dev/ttyUSB0 token=platform-private',
      stderr: 'credential=private',
    },
  ],
  [
    'JSON with a raw field',
    {
      status: 0,
      stdout: JSON.stringify({
        ...physicalProjection,
        reading: { ...physicalProjection.reading, raw: 'f855ce-private-frame' },
      }),
      stderr: 'C:\\devices\\COM7 token=platform-private',
    },
  ],
]) {
  test(`fails safely for ${caseName} without leaking child output`, async () => {
    const execution = harness(childResult);

    const passed = await checkScale({ SCALE_MODE: protocol }, execution.options);

    assert.equal(passed, false);
    assert.equal(execution.records.length, 1);
    const emitted = JSON.stringify(execution.records);
    assert.doesNotMatch(emitted, /f855ce-private-frame/i);
    assert.doesNotMatch(emitted, /platform-private/i);
    assert.doesNotMatch(emitted, /\/dev\/ttyUSB0/i);
    assert.doesNotMatch(emitted, /C:\\devices\\COM7/i);
  });
}

for (const [caseName, identity] of [
  ['an out-of-range scale ID', { ...physicalProjection.probe.identity, scaleId: 2_147_483_648 }],
  ['an overlong scale name', { ...physicalProjection.probe.identity, name: 'A'.repeat(26) }],
]) {
  test(`rejects status-zero output with ${caseName}`, async () => {
    const execution = harness({
      status: 0,
      stdout: JSON.stringify({
        ...physicalProjection,
        probe: { ...physicalProjection.probe, identity },
      }),
      stderr: '',
    });

    const passed = await checkScale({ SCALE_MODE: protocol }, execution.options);

    assert.equal(passed, false);
    assert.equal(execution.records.length, 1);
    assert.equal(execution.records[0].authoritative, false);
  });
}

for (const [caseName, parameters] of [
  ['missing', undefined],
  ['empty', {}],
  ['partial', { maximum: 'Max 6/15 кг' }],
  ['malformed', { ...physicalProjection.probe.parameters, fixation: 'bad' }],
  ['a string', 'raw token parameter-marker'],
  ['null', null],
  ['an array', ['parameter-marker']],
]) {
  test(`rejects status-zero output when parameters is ${caseName}`, async () => {
    const execution = harness({
      status: 0,
      stdout: JSON.stringify({
        ...physicalProjection,
        probe:
          parameters === undefined
            ? Object.fromEntries(
                Object.entries(physicalProjection.probe).filter(([key]) => key !== 'parameters'),
              )
            : { ...physicalProjection.probe, parameters },
      }),
      stderr: '',
    });

    const passed = await checkScale({ SCALE_MODE: protocol }, execution.options);

    assert.equal(passed, false);
    assert.equal(execution.calls.length, 1);
    assert.equal(execution.records.length, 1);
    assert.equal(execution.records[0].category, 'unsafe_or_non_authoritative_probe_output');
    assert.doesNotMatch(JSON.stringify(execution.records), /raw|token|parameter-marker/i);
  });
}

test('legacy serial mode can never report physical validation', async () => {
  const execution = harness({ status: 0, stdout: JSON.stringify(physicalProjection), stderr: '' });

  const passed = await checkScale(
    { SCALE_MODE: 'serial', SCALE_SERIAL_PORT: 'COM-NOT-A-DEVICE' },
    execution.options,
  );

  assert.equal(passed, false);
  assert.equal(execution.calls.length, 0);
  assert.deepEqual(execution.records, [
    {
      ok: false,
      message: 'Legacy serial scale mode is not an authoritative physical check',
      mode: 'serial',
      category: 'legacy_non_authoritative',
      authoritative: false,
    },
  ]);
});

for (const [caseName, cfg] of [
  ['missing', {}],
  ['blank', { SCALE_MODE: '' }],
  ['whitespace-only', { SCALE_MODE: '   ' }],
]) {
  test(`${caseName} SCALE_MODE fails categorically without running a child`, async () => {
    const execution = harness({
      status: 0,
      stdout: JSON.stringify(physicalProjection),
      stderr: '',
    });

    const passed = await checkScale(cfg, execution.options);

    assert.equal(passed, false);
    assert.equal(execution.calls.length, 0);
    assert.deepEqual(execution.records, [
      {
        ok: false,
        message: 'SCALE_MODE must be explicitly configured',
        mode: 'unknown',
        category: 'missing_scale_mode',
        authoritative: false,
      },
    ]);
  });
}

test('simulated mode is an explicit no-hardware skip', async () => {
  const execution = harness({ status: 0, stdout: JSON.stringify(physicalProjection), stderr: '' });

  const passed = await checkScale({ SCALE_MODE: 'simulated' }, execution.options);

  assert.equal(passed, true);
  assert.equal(execution.calls.length, 0);
  assert.deepEqual(execution.records, [
    {
      ok: true,
      message: 'Scale check skipped: simulated no-hardware demo',
      mode: 'simulated',
      authoritative: false,
      physicalPass: false,
      skipped: true,
    },
  ]);
});

test('top-level preflight never labels simulator/connectivity as hardware PASS', () => {
  assert.doesNotMatch(source, /Hardware preflight passed/iu);
  assert.match(source, /physical hardware PENDING/iu);
  assert.match(source, /physicalPass:\s*false/u);
});

test('preflight output and setup label do not expose driver details or emit an invalid QR', () => {
  assert.doesNotMatch(source, /error:\s*String\(err\)/u);
  assert.doesNotMatch(source, /stderr:\s*result\.stderr/u);
  assert.doesNotMatch(source, /stdout:\s*result\.stdout/u);
  assert.doesNotMatch(source, /command:\s*expanded/u);
  assert.doesNotMatch(source, /QR-PLENKA-TEST/u);
  assert.match(source, /prt_0{64}/u);
});

test('turns a thrown child error into a categorical record without leaking it', async () => {
  const records = [];

  const passed = await checkScale(
    { SCALE_MODE: protocol },
    {
      agentDir: path.join(path.sep, 'protected-demo', 'apps', 'gateway-agent'),
      emit: (record) => records.push(record),
      runChild: () => {
        throw new Error('f855ce-private-frame at C:\\devices\\COM7 token=platform-private');
      },
    },
  );

  assert.equal(passed, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].category, 'probe_execution_failed');
  assert.doesNotMatch(JSON.stringify(records), /f855ce|COM7|platform-private/i);
});

test('protected artifact documents Protocol 100 as the physical default', () => {
  assert.match(buildSource, /SCALE_MODE=massa-k-protocol-100/);
  assert.match(buildSource, /SCALE_SERIAL_BAUD=57600/);
  assert.match(buildSource, /USB virtual COM: terminal setup is not required/);
  assert.match(buildSource, /RS-232: terminal mode 1C, 57600 baud, 8-N-1/);
  assert.match(buildSource, /No-hardware alternative: set SCALE_MODE=simulated/);

  assert.match(customerReadme, /SCALE_MODE=massa-k-protocol-100/);
  assert.match(customerReadme, /SCALE_SERIAL_BAUD=57600/);
  assert.match(customerReadme, /USB virtual COM[^.]*не требует настройки режима терминала/iu);
  assert.match(customerReadme, /RS-232[^.]*`1C`[^.]*`57600`[^.]*`8-N-1`/su);
  assert.match(customerReadme, /SCALE_MODE=simulated/);

  const protectedText = `${source}\n${buildSource}\n${customerReadme}`;
  assert.doesNotMatch(protectedText, /SCALE_MODE=serial/);
  assert.doesNotMatch(protectedText, /SCALE_SERIAL_BAUD=9600/);
  assert.doesNotMatch(protectedText, /SCALE_POLL_COMMAND|SCALE_ASSUME_STABLE/);
  assert.doesNotMatch(protectedText, /raw[- ](?:кадр|frame)/iu);
});

test('generated protected API environment pins an explicit safe development start contract', () => {
  const body = buildSource.match(/function apiEnvExample\(\) \{\s*return `([\s\S]*?)`;\s*\}/u)?.[1];
  assert.ok(body, 'apiEnvExample template must remain inspectable by the packaging regression');
  const entries = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/gu, '')];
    });
  const env = Object.fromEntries(entries);

  assert.equal(env.APP_ENV, 'development');
  assert.equal(env.PUBLIC_ORIGIN, 'http://localhost:5173');
  assert.equal(env.AUTH_DEV_XROLE, 'off');
  assert.equal(env.GATEWAY_SIMULATOR, 'off');
  assert.equal(env.ONEC_LIVE, 'false');
  assert.equal(env.ONEC_WRITE, 'false');
  assert.equal(env.ONEC_ADAPTER, undefined);
  assert.match(
    installSource,
    /Copy-Item \(Join-Path \$Root "\.env\.example"\) \(Join-Path \$Root "\.env"\)/u,
  );
});

test('runbooks describe the authoritative smoke and exact physical profiles', () => {
  assert.match(
    windowsRunbook,
    /test-hardware\.ps1[\s\S]*prebuilt `apps\\gateway-agent\\dist\\probe-scale\.js`[\s\S]*Protocol 100 `ready\+stable`/u,
  );
  assert.doesNotMatch(windowsRunbook, /наличие настроенного COM-порта/iu);
  assert.match(windowsRunbook, /физический S1 gate[\s\S]{0,100}\*\*PENDING\*\*/u);

  assert.match(
    productionRunbook,
    /Статус `submitted`[\s\S]{0,320}S1[\s\S]{0,320}physical verification[\s\S]{0,320}S4/u,
  );
  assert.doesNotMatch(productionRunbook, /transport submission[^\n]{0,120}`printed`/iu);
  assert.match(hardwareGuide, /Физический S1 gate на Ubuntu — PENDING/u);
  assert.match(hardwareGuide, /статус физического gate остаётся \*\*PENDING\*\*/u);

  for (const runbook of [windowsRunbook, productionRunbook]) {
    assert.match(runbook, /RS-232[\s\S]{0,180}`1C`[\s\S]{0,80}`57600`[\s\S]{0,80}`8-N-1`/u);
  }
  assert.match(hardwareGuide, /RS-232→USB[\s\S]{0,80}`4800\/even`/u);
  assert.match(
    hardwareGuide,
    /терминальный режим[\s\S]{0,40}`100`[\s\S]{0,40}`4800 baud`[\s\S]{0,40}even parity/u,
  );
  assert.match(
    hardwareGuide,
    /`57600\/none`[\s\S]{0,100}не был рабочим transport этого[\s\S]{0,40}первого комплекта/u,
  );
  const combined = `${windowsRunbook}\n${productionRunbook}\n${hardwareGuide}`;
  assert.doesNotMatch(combined, /baud\/parity\/stop|параметры резервного RS-232 из меню/iu);
  assert.doesNotMatch(
    combined,
    /(?:пришлите|отправьте|получение)[^\n]{0,80}raw[- ](?:кадр|frame)/iu,
  );
});
