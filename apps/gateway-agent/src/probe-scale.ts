import { basename } from 'node:path';
import { loadConfig } from './config';
import {
  PROTOCOL_100_NAME_WIRE_BYTE_BOUNDS,
  PROTOCOL_100_PARAMETER_BYTE_BOUNDS,
} from './devices/massa-k/protocol-100-messages';
import { buildScale } from './devices/scale-factory';
import type {
  ScaleDevice,
  ScaleIdentity,
  ScaleProbeResult,
  ScaleProtocol,
  ScaleReadStatus,
} from './devices/scale';
import { withSuppressedLogs } from './logger';

const ACCEPTED_DIVISIONS_KG = new Set([0.0001, 0.001, 0.01, 0.1, 1]);
const SCALE_PROTOCOLS = new Set<ScaleProtocol>([
  'simulated',
  'legacy-ascii',
  'massa-k-protocol-100',
]);
const SCALE_STATUSES = new Set<ScaleReadStatus>(['ready', 'offline', 'unstable']);
const SAFE_PROBE_ERRORS = new Set([
  'command_not_supported',
  'overload',
  'not_in_weighing_mode',
  'invalid_input',
  'save_failed',
  'wifi_not_supported',
  'ethernet_not_supported',
  'zero_not_possible',
  'weighing_module_unreachable',
  'loaded_during_startup',
  'device_fault',
  'unknown_error',
  'device_error_without_code',
  'timeout',
  'transport_unavailable',
  'protocol_header',
  'protocol_length',
  'protocol_size',
  'protocol_crc',
]);
const SAFE_READING_ERRORS = new Set([
  ...SAFE_PROBE_ERRORS,
  'net_without_tare',
  'invalid_gross_weight',
  'unexpected_name',
  'unexpected_scale_parameters',
  'unexpected_nack',
  'unexpected_mass',
]);
const UNSAFE_TEXT_CATEGORIES = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const SAFE_PARAMETER_KEYS = [
  'maximum',
  'minimum',
  'verificationInterval',
  'maximumTare',
  'fixation',
  'calibrationCode',
  'softwareVersion',
  'softwareChecksum',
] as const;

type ProbeOutput = Awaited<ReturnType<typeof probeScale>>;
type ProbeWriter = (line: string) => void;
type SafeProbeResult = Omit<ScaleProbeResult, 'protocol'> & { protocol?: ScaleProtocol };
type SafeParameterKey = (typeof SAFE_PARAMETER_KEYS)[number];

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function scaleProtocol(value: unknown): ScaleProtocol | undefined {
  return typeof value === 'string' && SCALE_PROTOCOLS.has(value as ScaleProtocol)
    ? (value as ScaleProtocol)
    : undefined;
}

function scaleStatus(value: unknown): ScaleReadStatus | undefined {
  return typeof value === 'string' && SCALE_STATUSES.has(value as ScaleReadStatus)
    ? (value as ScaleReadStatus)
    : undefined;
}

function hasUnsafeText(value: string): boolean {
  if (UNSAFE_TEXT_CATEGORIES.test(value)) return true;
  if (/(?:\/dev\/|[A-Za-z]:\\|\\\\|token|password|secret|credential)/i.test(value)) {
    return true;
  }
  return false;
}

function isSafeText(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.byteLength(value, 'latin1');
  return bytes >= minBytes && bytes <= maxBytes && !hasUnsafeText(value);
}

function isPhysicalIdentity(value: unknown): value is ScaleIdentity {
  const identity = record(value);
  return (
    identity?.manufacturer === 'MASSA-K' &&
    isSafeText(
      identity.name,
      PROTOCOL_100_NAME_WIRE_BYTE_BOUNDS.min - 2,
      PROTOCOL_100_NAME_WIRE_BYTE_BOUNDS.max - 2,
    ) &&
    Number.isInteger(identity.scaleId) &&
    (identity.scaleId as number) >= -0x80000000 &&
    (identity.scaleId as number) <= 0x7fffffff
  );
}

function projectIdentity(
  value: unknown,
  protocol: ScaleProtocol,
  required: boolean,
): { identity?: ScaleIdentity; valid: boolean } {
  if (value === undefined) return { valid: !required };
  const identity = record(value);
  if (
    !identity ||
    !isSafeText(identity.manufacturer, 1, 64) ||
    !isSafeText(identity.name, 0, 64) ||
    !Number.isInteger(identity.scaleId) ||
    (identity.scaleId as number) < -0x80000000 ||
    (identity.scaleId as number) > 0x7fffffff ||
    (protocol === 'massa-k-protocol-100' && !isPhysicalIdentity(identity))
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    identity: {
      manufacturer: identity.manufacturer,
      scaleId: identity.scaleId as number,
      name: identity.name,
    },
  };
}

function validParameter(key: SafeParameterKey, value: unknown): value is string {
  const bounds = PROTOCOL_100_PARAMETER_BYTE_BOUNDS[key];
  return isSafeText(value, bounds.min, bounds.max);
}

export function hasCompleteProtocol100Parameters(
  value: unknown,
): value is Record<SafeParameterKey, string> {
  const parameters = record(value);
  return Boolean(
    parameters &&
    SAFE_PARAMETER_KEYS.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(parameters, key) &&
        validParameter(key, parameters[key]),
    ),
  );
}

function projectParameters(value: unknown): {
  parameters?: Record<string, string>;
  valid: boolean;
} {
  if (value === undefined) return { valid: true };
  const parameters = record(value);
  if (!parameters) return { valid: false };
  const projected: Record<string, string> = {};
  for (const key of SAFE_PARAMETER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parameters, key)) continue;
    const value = parameters[key];
    if (!validParameter(key, value)) return { valid: false };
    projected[key] = value;
  }
  return {
    valid: true,
    parameters: Object.keys(projected).length > 0 ? projected : undefined,
  };
}

function invalidProbeResult(
  error: 'invalid_probe_metadata' | 'invalid_probe_identity' | 'invalid_probe_parameters',
  protocol?: ScaleProtocol,
  simulated = false,
): SafeProbeResult {
  return {
    ok: false,
    status: 'offline',
    protocol,
    simulated,
    error,
  };
}

export function projectScaleProbeResult(value: unknown): SafeProbeResult {
  const probe = record(value);
  const protocol = scaleProtocol(probe?.protocol);
  const status = scaleStatus(probe?.status);
  const simulated = typeof probe?.simulated === 'boolean' ? probe.simulated : false;
  if (
    !probe ||
    typeof probe.ok !== 'boolean' ||
    !status ||
    !protocol ||
    typeof probe.simulated !== 'boolean' ||
    probe.simulated !== (protocol === 'simulated')
  ) {
    return invalidProbeResult('invalid_probe_metadata', protocol, simulated);
  }

  const projectedIdentity = projectIdentity(
    probe.identity,
    protocol,
    probe.ok && protocol === 'massa-k-protocol-100',
  );
  if (!projectedIdentity.valid) {
    return invalidProbeResult('invalid_probe_identity', protocol, simulated);
  }

  const projectedParameters = projectParameters(probe.parameters);
  if (!projectedParameters.valid) {
    return invalidProbeResult('invalid_probe_parameters', protocol, simulated);
  }

  const error =
    probe.error === undefined
      ? undefined
      : typeof probe.error === 'string' && SAFE_PROBE_ERRORS.has(probe.error)
        ? probe.error
        : 'device_probe_failed';
  const ok = probe.ok && error === undefined;
  return {
    ok,
    status: probe.ok && !ok ? 'offline' : status,
    protocol,
    simulated,
    identity: projectedIdentity.identity,
    parameters: projectedParameters.parameters,
    error,
  };
}

export async function probeScale(scale: ScaleDevice) {
  const probe = projectScaleProbeResult(await scale.probe());
  const reading = probe.ok ? await scale.read('roll') : undefined;
  return {
    probe,
    reading: reading
      ? {
          status: reading.status,
          stable: reading.stable,
          grossKg: reading.grossKg,
          netKg: reading.netKg,
          tareKg: reading.tareKg,
          divisionKg: reading.divisionKg,
          net: reading.net,
          zero: reading.zero,
          errorCode: reading.errorCode
            ? SAFE_READING_ERRORS.has(reading.errorCode)
              ? reading.errorCode
              : 'device_read_failed'
            : undefined,
        }
      : undefined,
  };
}

function isAuthoritativePhysicalReading(output: ProbeOutput): boolean {
  const { probe, reading } = output;
  return (
    probe.ok === true &&
    probe.status === 'ready' &&
    probe.protocol === 'massa-k-protocol-100' &&
    probe.simulated === false &&
    probe.error === undefined &&
    isPhysicalIdentity(probe.identity) &&
    hasCompleteProtocol100Parameters(probe.parameters) &&
    reading?.status === 'ready' &&
    reading.stable === true &&
    Number.isFinite(reading.grossKg) &&
    reading.grossKg >= 0 &&
    reading.divisionKg !== undefined &&
    ACCEPTED_DIVISIONS_KG.has(reading.divisionKg) &&
    reading.errorCode === undefined
  );
}

function failureOutput(error: 'scale_probe_failed' | 'scale_cleanup_failed') {
  return {
    probe: {
      ok: false,
      status: 'offline' as const,
      simulated: false,
      error,
    },
  };
}

export async function runProbeScale(
  scale: ScaleDevice,
  write: ProbeWriter = (line) => {
    process.stdout.write(line);
  },
): Promise<number> {
  const result = await withSuppressedLogs(async () => {
    let output: ProbeOutput | ReturnType<typeof failureOutput>;
    let code: number;

    try {
      output = await probeScale(scale);
      code = isAuthoritativePhysicalReading(output) ? 0 : 2;
    } catch {
      output = failureOutput('scale_probe_failed');
      code = 1;
    }

    try {
      await scale.close();
    } catch {
      output = failureOutput('scale_cleanup_failed');
      code = 1;
    }

    return { output, code };
  });

  write(`${JSON.stringify(result.output)}\n`);
  return result.code;
}

async function run(): Promise<number> {
  const config = loadConfig(process.env, process.cwd(), { requireAgentToken: false });
  return runProbeScale(buildScale(config));
}

if (require.main === module && basename(process.argv[1] ?? '') === 'probe-scale.js') {
  void run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify(failureOutput('scale_probe_failed'))}\n`);
      process.exitCode = 1;
    });
}
