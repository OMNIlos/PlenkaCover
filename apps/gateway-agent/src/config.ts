import * as fs from 'node:fs';
import { isIP } from 'node:net';
import * as path from 'node:path';
import { isCanonicalPilotAgentToken } from '@plenka/contracts';

export type ScaleMode = 'simulated' | 'serial' | 'massa-k-protocol-100';
export type ScaleSerialParity = 'none' | 'even';
export type PrinterMode = 'simulated' | 'tcp9100' | 'windows-command' | 'cups-zpl';
export type GatewayDeploymentMode = 'development' | 'physical';

export interface LoadConfigOptions {
  requireAgentToken?: boolean;
}

export interface AgentConfig {
  deploymentMode: GatewayDeploymentMode;
  apiUrl: string;
  agentToken: string;
  postCode: string;
  scaleDeviceId: string;
  printerDeviceId: string;
  scannerDeviceId: string | null;
  scannerHidPath: string | null;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  scaleMode: ScaleMode;
  scaleSerialPort: string | null;
  scaleSerialBaud: number;
  scaleSerialParity: ScaleSerialParity;
  scalePollCommand: string | null;
  scaleReadTimeoutMs: number;
  scaleAssumeStable: boolean;
  scaleSimulatedOffline: boolean;
  printerMode: PrinterMode;
  printerTcpHost: string | null;
  printerTcpPort: number;
  printerWindowsCommand: string | null;
  printerCupsQueue: string | null;
  printerWarehouseCupsQueue: string | null;
  printerSimulatedFail: boolean;
  printerDpi: number;
  printerMaxWidthDots: number;
  bufferDir: string;
}

/** Minimal .env reader (KEY=VALUE lines, # comments, optional quotes). No dotenv dependency. */
export function readDotEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
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

const on = (v: string | undefined) => v === 'on' || v === 'true' || v === '1';
const num = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/**
 * Config resolution: real environment variables win over `.env` in the working directory
 * (npm workspace scripts run with cwd = apps/gateway-agent). Secrets come only from
 * env/.env — nothing is baked into the repo.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  options: LoadConfigOptions = {},
): AgentConfig {
  const file = readDotEnv(path.join(cwd, '.env'));
  const get = (key: string): string | undefined => env[key] ?? file[key];

  const scaleMode = (get('SCALE_MODE') ?? 'simulated') as ScaleMode;
  const printerMode = (get('PRINTER_MODE') ?? 'simulated') as PrinterMode;
  const deploymentMode = (get('GATEWAY_DEPLOYMENT_MODE') ?? 'development') as GatewayDeploymentMode;
  const configuredApiUrl = get('GATEWAY_API_URL') ?? 'http://localhost:3000/api';
  const defaultScaleBaud = scaleMode === 'massa-k-protocol-100' ? 57_600 : 9_600;

  const cfg: AgentConfig = {
    deploymentMode,
    apiUrl: configuredApiUrl.replace(/\/$/, ''),
    agentToken: get('GATEWAY_AGENT_TOKEN') ?? '',
    postCode: get('GATEWAY_POST_CODE') ?? 'POST-1',
    scaleDeviceId: get('GATEWAY_SCALE_DEVICE_ID') ?? 'dev-scale-1',
    printerDeviceId: get('GATEWAY_PRINTER_DEVICE_ID') ?? 'dev-printer-1',
    scannerDeviceId: get('GATEWAY_SCANNER_DEVICE_ID') ?? null,
    scannerHidPath: get('SCANNER_HID_PATH') ?? null,
    pollIntervalMs: num(get('GATEWAY_POLL_INTERVAL_MS'), 1000),
    heartbeatIntervalMs: num(get('GATEWAY_HEARTBEAT_INTERVAL_MS'), 5000),
    scaleMode,
    scaleSerialPort: get('SCALE_SERIAL_PORT') ?? null,
    scaleSerialBaud: num(get('SCALE_SERIAL_BAUD'), defaultScaleBaud),
    scaleSerialParity: (get('SCALE_SERIAL_PARITY') ?? 'none') as ScaleSerialParity,
    scalePollCommand: get('SCALE_POLL_COMMAND') || null,
    scaleReadTimeoutMs: num(get('SCALE_READ_TIMEOUT_MS'), 1500),
    scaleAssumeStable: on(get('SCALE_ASSUME_STABLE')),
    scaleSimulatedOffline: on(get('SCALE_SIMULATED_OFFLINE')),
    printerMode,
    printerTcpHost: get('PRINTER_TCP_HOST') ?? null,
    printerTcpPort: num(get('PRINTER_TCP_PORT'), 9100),
    printerWindowsCommand: get('PRINTER_WINDOWS_COMMAND') || null,
    printerCupsQueue: get('PRINTER_CUPS_QUEUE') || null,
    printerWarehouseCupsQueue: get('PRINTER_WAREHOUSE_CUPS_QUEUE') || null,
    printerSimulatedFail: on(get('PRINTER_SIMULATED_FAIL')),
    printerDpi: num(get('PRINTER_DPI'), 203),
    printerMaxWidthDots: num(get('PRINTER_MAX_WIDTH_DOTS'), 864),
    bufferDir: get('GATEWAY_BUFFER_DIR') ?? '.gateway-buffer',
  };

  const errors: string[] = [];
  if (options.requireAgentToken !== false && !cfg.agentToken) {
    errors.push('GATEWAY_AGENT_TOKEN is required');
  }
  if (!['simulated', 'serial', 'massa-k-protocol-100'].includes(scaleMode)) {
    errors.push(`unknown SCALE_MODE ${scaleMode}`);
  }
  if (!['simulated', 'tcp9100', 'windows-command', 'cups-zpl'].includes(printerMode)) {
    errors.push(`unknown PRINTER_MODE ${printerMode}`);
  }
  if (['serial', 'massa-k-protocol-100'].includes(scaleMode) && !cfg.scaleSerialPort) {
    errors.push(`SCALE_SERIAL_PORT is required when SCALE_MODE=${scaleMode}`);
  }
  if (!['none', 'even'].includes(cfg.scaleSerialParity)) {
    errors.push('SCALE_SERIAL_PARITY must be none or even');
  }
  if (printerMode === 'tcp9100' && !cfg.printerTcpHost) {
    errors.push('PRINTER_TCP_HOST is required when PRINTER_MODE=tcp9100');
  }
  if (printerMode === 'windows-command' && !cfg.printerWindowsCommand) {
    errors.push('PRINTER_WINDOWS_COMMAND is required when PRINTER_MODE=windows-command');
  }
  if (printerMode === 'cups-zpl' && !isPhysicalCupsQueue(cfg.printerCupsQueue)) {
    errors.push('PRINTER_CUPS_QUEUE must name the local queue when PRINTER_MODE=cups-zpl');
  }
  if (
    cfg.printerWarehouseCupsQueue !== null &&
    !isPhysicalCupsQueue(cfg.printerWarehouseCupsQueue)
  ) {
    errors.push('PRINTER_WAREHOUSE_CUPS_QUEUE must name a CUPS queue');
  }
  if (cfg.printerDpi !== 203) errors.push('PRINTER_DPI must be 203');
  if (cfg.printerMaxWidthDots < 800) {
    errors.push('PRINTER_MAX_WIDTH_DOTS must be at least 800');
  }
  if (!['development', 'physical'].includes(deploymentMode)) {
    errors.push(`unknown GATEWAY_DEPLOYMENT_MODE ${deploymentMode}`);
  }
  if (deploymentMode === 'physical') {
    if (!isTrustedHttpsApiUrl(configuredApiUrl)) {
      errors.push('GATEWAY_API_URL must be a trusted HTTPS URL in physical deployment');
    }
    if (scaleMode !== 'massa-k-protocol-100') {
      errors.push('SCALE_MODE must be massa-k-protocol-100 in physical deployment');
    }
    if (!isPhysicalProtocol100SerialProfile(cfg.scaleSerialBaud, cfg.scaleSerialParity)) {
      errors.push(
        'SCALE_SERIAL_BAUD/SCALE_SERIAL_PARITY must be 57600/none (USB) or 4800/even (RS-232) in physical deployment',
      );
    }
    if (!['tcp9100', 'cups-zpl'].includes(printerMode)) {
      errors.push('PRINTER_MODE must be tcp9100 or cups-zpl in physical deployment');
    }
    if (printerMode === 'cups-zpl' && cfg.printerWarehouseCupsQueue === null) {
      errors.push(
        'PRINTER_WAREHOUSE_CUPS_QUEUE is required when PRINTER_MODE=cups-zpl in physical deployment',
      );
    }
    if (
      printerMode === 'cups-zpl' &&
      cfg.printerWarehouseCupsQueue !== null &&
      cfg.printerWarehouseCupsQueue === cfg.printerCupsQueue
    ) {
      errors.push(
        'PRINTER_WAREHOUSE_CUPS_QUEUE must be separate from PRINTER_CUPS_QUEUE in physical deployment',
      );
    }
    if (!isCanonicalPilotAgentToken(cfg.agentToken)) {
      errors.push('GATEWAY_AGENT_TOKEN must be a canonical pilot token in physical deployment');
    }
    if (!isStableUbuntuSerialPath(cfg.scaleSerialPort)) {
      errors.push('SCALE_SERIAL_PORT must use /dev/serial/by-id/<device> in physical deployment');
    }
    if (cfg.scannerHidPath !== null && !isStableUbuntuHidPath(cfg.scannerHidPath)) {
      errors.push(
        'SCANNER_HID_PATH must use /dev/input/by-id/<device>-event-kbd in physical deployment',
      );
    }
    if (printerMode === 'tcp9100' && !isPhysicalPrinterHost(cfg.printerTcpHost)) {
      errors.push('PRINTER_TCP_HOST must be a real printer host in physical deployment');
    }
    for (const [key, value] of [
      ['GATEWAY_POST_CODE', get('GATEWAY_POST_CODE')],
      ['GATEWAY_SCALE_DEVICE_ID', get('GATEWAY_SCALE_DEVICE_ID')],
      ['GATEWAY_PRINTER_DEVICE_ID', get('GATEWAY_PRINTER_DEVICE_ID')],
      ['GATEWAY_SCANNER_DEVICE_ID', get('GATEWAY_SCANNER_DEVICE_ID')],
    ] as const) {
      if (!isPhysicalIdentifier(value)) {
        errors.push(`${key} must be explicitly set to a non-placeholder identifier`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`gateway-agent config invalid: ${errors.join('; ')}`);
  }
  return cfg;
}

function isPhysicalProtocol100SerialProfile(baudRate: number, parity: ScaleSerialParity): boolean {
  return (baudRate === 57_600 && parity === 'none') || (baudRate === 4_800 && parity === 'even');
}

function isPhysicalCupsQueue(value: string | null): boolean {
  return Boolean(
    value &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u.test(value) &&
    !/replace|example|placeholder|changeme/iu.test(value),
  );
}

function isTrustedHttpsApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const local =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '[::1]' ||
      host === '::' ||
      host === '[::]' ||
      host === '0.0.0.0' ||
      /^127(?:\.|$)/u.test(host);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/api' &&
      !local &&
      !isDocumentationHost(host)
    );
  } catch {
    return false;
  }
}

function isStableUbuntuSerialPath(value: string | null): boolean {
  return (
    value !== null &&
    /^\/dev\/serial\/by-id\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/u.test(value) &&
    !value.includes('..') &&
    !/replace|example|placeholder|changeme/iu.test(value)
  );
}

function isStableUbuntuHidPath(value: string | null): boolean {
  return (
    value !== null &&
    /^\/dev\/input\/by-id\/[A-Za-z0-9][A-Za-z0-9._:+-]*-event-kbd$/u.test(value) &&
    !value.includes('..') &&
    !/replace|example|placeholder|changeme/iu.test(value)
  );
}

function isDocumentationHost(host: string): boolean {
  return (
    /replace|example|placeholder|changeme/iu.test(host) ||
    ['example', 'invalid', 'test'].some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    ) ||
    /^192\.0\.2\./u.test(host) ||
    /^198\.51\.100\./u.test(host) ||
    /^203\.0\.113\./u.test(host) ||
    /^\[?2001:db8:/u.test(host)
  );
}

function isPhysicalPrinterHost(value: string | null): boolean {
  if (!value || value !== value.trim() || /[<>/\\\s]/u.test(value)) return false;
  const host = value.toLowerCase();
  if (isDocumentationHost(host) || /replace|example|placeholder|changeme/iu.test(host)) {
    return false;
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return !/^127\./u.test(host) && host !== '0.0.0.0';
  }
  if (ipVersion === 6) return !['::', '::1'].includes(host);
  return (
    host !== 'localhost' &&
    !host.endsWith('.localhost') &&
    host.length <= 253 &&
    host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  );
}

function isPhysicalIdentifier(value: string | undefined): boolean {
  return Boolean(
    value &&
    value === value.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) &&
    !/replace|example|placeholder|changeme|unused/iu.test(value) &&
    !/^(?:dev|demo|test)[._:-]/iu.test(value),
  );
}
