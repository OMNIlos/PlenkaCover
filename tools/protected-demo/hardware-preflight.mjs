import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootCandidates = [path.resolve(__dirname, '..'), path.resolve(__dirname, '../..')];
const root =
  rootCandidates.find((candidate) => existsSync(path.join(candidate, 'apps/gateway-agent'))) ??
  rootCandidates[0];
const args = new Set(process.argv.slice(2));
const printTest = args.has('--print-test');
const protocol100 = 'massa-k-protocol-100';
const acceptedDivisionsKg = new Set([0.0001, 0.001, 0.01, 0.1, 1]);
const safeOutputKeys = new Set(['probe', 'reading']);
const safeProbeKeys = new Set(['ok', 'status', 'protocol', 'simulated', 'identity', 'parameters']);
const safeIdentityKeys = new Set(['manufacturer', 'scaleId', 'name']);
const safeParameterKeys = new Set([
  'maximum',
  'minimum',
  'verificationInterval',
  'maximumTare',
  'fixation',
  'calibrationCode',
  'softwareVersion',
  'softwareChecksum',
]);
const safeParameterBounds = {
  maximum: { min: 2, max: 20 },
  minimum: { min: 2, max: 20 },
  verificationInterval: { min: 2, max: 10 },
  maximumTare: { min: 2, max: 10 },
  fixation: { min: 7, max: 7 },
  calibrationCode: { min: 12, max: 13 },
  softwareVersion: { min: 2, max: 9 },
  softwareChecksum: { min: 2, max: 8 },
};
const safeReadingKeys = new Set([
  'status',
  'stable',
  'grossKg',
  'netKg',
  'tareKg',
  'divisionKg',
  'net',
  'zero',
]);
const unsafeText =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|(?:\/dev\/|[A-Za-z]:\\|\\\\|token|password|secret|credential)/iu;

function readDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function ok(message, detail = {}) {
  console.log(JSON.stringify({ ok: true, message, ...detail }));
}

function fail(message, detail = {}) {
  console.log(JSON.stringify({ ok: false, message, ...detail }));
}

async function checkApi(apiUrl) {
  try {
    const res = await fetch(`${apiUrl.replace(/\/api\/?$/, '')}/api/health`);
    if (!res.ok) {
      fail('API health failed', { status: res.status });
      return false;
    }
    ok('API health reachable');
    return true;
  } catch {
    fail('API health unreachable', { category: 'api_request_failed' });
    return false;
  }
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeText(value, allowEmpty = false) {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= 128 &&
    !unsafeText.test(value)
  );
}

function isSafeParameter(key, value) {
  const bounds = safeParameterBounds[key];
  if (!bounds || !isSafeText(value)) return false;
  const bytes = Buffer.byteLength(value, 'latin1');
  return bytes >= bounds.min && bytes <= bounds.max;
}

function isOptionalFiniteNumber(value) {
  return value === undefined || value === null || Number.isFinite(value);
}

function isOptionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

function isSafePhysicalProjection(value) {
  const output = record(value);
  if (!output || !hasOnlyKeys(output, safeOutputKeys)) return false;

  const probe = record(output.probe);
  const identity = record(probe?.identity);
  const parameters = record(probe?.parameters);
  if (
    !probe ||
    !hasOnlyKeys(probe, safeProbeKeys) ||
    probe.ok !== true ||
    probe.status !== 'ready' ||
    probe.protocol !== protocol100 ||
    probe.simulated !== false ||
    !identity ||
    !hasOnlyKeys(identity, safeIdentityKeys) ||
    identity.manufacturer !== 'MASSA-K' ||
    !Number.isInteger(identity.scaleId) ||
    identity.scaleId < -0x80000000 ||
    identity.scaleId > 0x7fffffff ||
    !isSafeText(identity.name, true) ||
    Buffer.byteLength(identity.name, 'latin1') > 25 ||
    !parameters ||
    !hasOnlyKeys(parameters, safeParameterKeys) ||
    ![...safeParameterKeys].every((key) => Object.prototype.hasOwnProperty.call(parameters, key)) ||
    !Object.entries(parameters).every(([key, parameter]) => isSafeParameter(key, parameter))
  ) {
    return false;
  }

  const reading = record(output.reading);
  return Boolean(
    reading &&
    hasOnlyKeys(reading, safeReadingKeys) &&
    reading.status === 'ready' &&
    reading.stable === true &&
    Number.isFinite(reading.grossKg) &&
    reading.grossKg >= 0 &&
    acceptedDivisionsKg.has(reading.divisionKg) &&
    isOptionalFiniteNumber(reading.netKg) &&
    isOptionalFiniteNumber(reading.tareKg) &&
    isOptionalBoolean(reading.net) &&
    isOptionalBoolean(reading.zero),
  );
}

function scaleFailure(emit, category) {
  emit({
    ok: false,
    message: 'Physical Protocol 100 scale validation failed',
    mode: protocol100,
    category,
    authoritative: false,
  });
  return false;
}

export async function checkScale(cfg, options = {}) {
  const emit = options.emit ?? ((entry) => console.log(JSON.stringify(entry)));
  const mode = typeof cfg.SCALE_MODE === 'string' ? cfg.SCALE_MODE.trim() : '';
  if (!mode) {
    emit({
      ok: false,
      message: 'SCALE_MODE must be explicitly configured',
      mode: 'unknown',
      category: 'missing_scale_mode',
      authoritative: false,
    });
    return false;
  }
  if (mode === 'simulated') {
    emit({
      ok: true,
      message: 'Scale check skipped: simulated no-hardware demo',
      mode,
      authoritative: false,
      physicalPass: false,
      skipped: true,
    });
    return true;
  }
  if (mode === 'serial') {
    emit({
      ok: false,
      message: 'Legacy serial scale mode is not an authoritative physical check',
      mode,
      category: 'legacy_non_authoritative',
      authoritative: false,
    });
    return false;
  }
  if (mode !== protocol100) {
    emit({
      ok: false,
      message: 'Unknown scale mode',
      mode: 'unknown',
      category: 'unsupported_scale_mode',
      authoritative: false,
    });
    return false;
  }

  const agentDir = options.agentDir ?? path.join(root, 'apps/gateway-agent');
  const probeFile = path.join(agentDir, 'dist', 'probe-scale.js');
  const configuredTimeout = Number(cfg.HARDWARE_PREFLIGHT_SCALE_TIMEOUT_MS ?? 30000);
  const timeout =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30000;
  let result;
  try {
    result = (options.runChild ?? spawnSync)(process.execPath, [probeFile], {
      cwd: agentDir,
      env: { ...(options.baseEnv ?? process.env), ...cfg },
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
      timeout,
    });
  } catch {
    return scaleFailure(emit, 'probe_execution_failed');
  }

  if (result?.status !== 0) {
    const category =
      result?.status === 2
        ? 'probe_non_authoritative'
        : result?.status === 1
          ? 'probe_execution_failed'
          : 'probe_process_failed';
    return scaleFailure(emit, category);
  }

  let projection;
  try {
    projection = JSON.parse(String(result.stdout ?? '').trim());
  } catch {
    return scaleFailure(emit, 'invalid_probe_output');
  }
  if (!isSafePhysicalProjection(projection)) {
    return scaleFailure(emit, 'unsafe_or_non_authoritative_probe_output');
  }

  emit({
    ok: true,
    message: 'Physical Protocol 100 scale validated',
    mode: protocol100,
    status: 'ready',
    stable: true,
    authoritative: true,
  });
  return true;
}

function tsplTestLabel() {
  return [
    'SIZE 50 mm,30 mm',
    'GAP 2 mm,0',
    'CLS',
    'TEXT 20,20,"3",0,1,1,"PLENKA TEST"',
    'QRCODE 20,70,L,4,A,0,"prt_0000000000000000000000000000000000000000000000000000000000000000"',
    'PRINT 1',
    '',
  ].join('\r\n');
}

async function checkTcpPrinter(cfg) {
  const host = cfg.PRINTER_TCP_HOST;
  const port = Number(cfg.PRINTER_TCP_PORT ?? 9100);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 2000 }, () => {
      ok('Printer TCP port reachable', { transport: 'tcp9100', port });
      if (printTest) socket.write(tsplTestLabel());
      socket.end();
    });
    socket.on('close', resolve);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('connection timed out'));
    });
    socket.on('error', reject);
  });
  if (printTest) ok('Printer test label sent over TCP9100');
  return true;
}

async function checkWindowsCommandPrinter(cfg) {
  const command = cfg.PRINTER_WINDOWS_COMMAND;
  if (!command) {
    fail('PRINTER_WINDOWS_COMMAND is empty');
    return false;
  }
  if (!printTest) {
    ok('Printer command is configured', { transport: 'windows-command', printTest: false });
    return true;
  }

  const dir = path.join(os.tmpdir(), 'plenka-hardware-preflight');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'test-label.prn');
  writeFileSync(file, tsplTestLabel());

  const expanded = command.replaceAll('{file}', file);
  const result = spawnSync(expanded, {
    shell: true,
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail('Printer command failed', {
      category: 'spool_command_failed',
      status: result.status,
    });
    return false;
  }
  ok('Printer test label sent through windows-command', { transport: 'windows-command' });
  return true;
}

async function checkPrinter(cfg) {
  const mode = cfg.PRINTER_MODE ?? 'simulated';
  if (mode === 'simulated') {
    ok('Printer check skipped: PRINTER_MODE is simulated', { physicalPass: false });
    return true;
  }
  try {
    if (mode === 'tcp9100') return await checkTcpPrinter(cfg);
    if (mode === 'windows-command') return await checkWindowsCommandPrinter(cfg);
    fail('Unknown PRINTER_MODE', { mode });
    return false;
  } catch {
    fail('Printer check failed', { mode, category: 'printer_transport_failed' });
    return false;
  }
}

async function main() {
  const cfg = {
    ...readDotEnv(path.join(root, '.env')),
    ...readDotEnv(path.join(root, 'apps/gateway-agent/.env')),
    ...process.env,
  };
  const apiOk = await checkApi(cfg.GATEWAY_API_URL ?? 'http://localhost:3000/api');
  const scaleOk = await checkScale(cfg).catch(() => {
    fail('Scale check failed', { category: 'unexpected_scale_check_error' });
    return false;
  });
  const printerOk = await checkPrinter(cfg);

  if (!apiOk || !scaleOk || !printerOk) process.exit(1);
  ok('Operational preflight passed; physical hardware PENDING', {
    printTest,
    physicalPass: false,
    scaleAuthoritative: cfg.SCALE_MODE === protocol100 && scaleOk,
    printerObserved: false,
    scannerObserved: false,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
