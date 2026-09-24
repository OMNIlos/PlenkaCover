import { log } from '../logger';
import { decodePollCommand, parseScaleFrame } from '../scale-frame';

export type ScaleReadStatus = 'ready' | 'offline' | 'unstable';
export type ScaleProtocol = 'simulated' | 'legacy-ascii' | 'massa-k-protocol-100';

export interface ScaleIdentity {
  manufacturer: string;
  scaleId: number;
  name: string;
}

export interface ScaleProbeResult {
  ok: boolean;
  status: ScaleReadStatus;
  protocol: ScaleProtocol;
  simulated: boolean;
  identity?: ScaleIdentity;
  parameters?: Record<string, string>;
  error?: string;
}

export interface ScaleReadResult {
  status: ScaleReadStatus;
  stable: boolean;
  grossKg: number;
  netKg?: number;
  tareKg?: number | null;
  divisionKg?: number;
  net?: boolean;
  zero?: boolean;
  errorCode?: string;
  /** Raw device frame — forwarded ONLY into gateway ingest rawPayload (admin diagnostics, ТЗ §8). */
  raw?: string;
}

export interface ScaleDevice {
  probe(): Promise<ScaleProbeResult>;
  read(kind: 'spool' | 'roll'): Promise<ScaleReadResult>;
  /** Last-known status for heartbeats — must not touch the hardware. */
  status(): ScaleReadStatus;
  close(): Promise<void>;
}

/** No-hardware demo scale: same weights as the backend SimulatedGatewayAgent. */
export class SimulatedScale implements ScaleDevice {
  constructor(private readonly offline = false) {}

  async probe(): Promise<ScaleProbeResult> {
    const status = this.status();
    return {
      ok: status !== 'offline',
      status,
      protocol: 'simulated',
      simulated: true,
      error: status === 'offline' ? 'simulated scale is offline' : undefined,
    };
  }

  async read(kind: 'spool' | 'roll'): Promise<ScaleReadResult> {
    if (this.offline) return { status: 'offline', stable: false, grossKg: 0 };
    const grossKg = kind === 'spool' ? 2.0 : 43.4;
    return { status: 'ready', stable: true, grossKg, raw: `SIM,${kind},${grossKg}kg` };
  }

  status(): ScaleReadStatus {
    return this.offline ? 'offline' : 'ready';
  }

  async close(): Promise<void> {}
}

export interface SerialScaleOptions {
  path: string;
  baudRate: number;
  pollCommand: string | null;
  readTimeoutMs: number;
  /** Treat marker-less (bare-number) frames as stable — only for scales in print-on-stable mode. */
  assumeStable: boolean;
}

// The slice of `serialport` we use, typed locally: `serialport` is an OPTIONAL native
// dependency, and the build must not require it to be installed.
interface SerialPortLike {
  isOpen: boolean;
  open(cb: (err: Error | null) => void): void;
  close(cb?: (err: Error | null) => void): void;
  write(data: Buffer): void;
  on(event: 'data' | 'close' | 'error', cb: (arg?: unknown) => void): void;
}
type SerialPortCtor = new (opts: {
  path: string;
  baudRate: number;
  autoOpen: boolean;
}) => SerialPortLike;

function loadSerialPortModule(): SerialPortCtor | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('serialport') as { SerialPort: SerialPortCtor }).SerialPort;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ТВ-М-300-class scale on a Windows COM port (USB or USB-COM adapter). ASCII frames are
 * accumulated from the port and parsed with `parseScaleFrame`; no frame within the timeout
 * or a failed parse yields offline/unstable — the platform then blocks weighing with 503
 * instead of accepting a guess (ТЗ §9).
 */
export class SerialScale implements ScaleDevice {
  private port: SerialPortLike | null = null;
  private buffer = '';
  private lastStatus: ScaleReadStatus = 'offline';

  constructor(private readonly opts: SerialScaleOptions) {}

  async probe(): Promise<ScaleProbeResult> {
    const reading = await this.read('spool');
    return {
      ok: reading.status !== 'offline',
      status: reading.status,
      protocol: 'legacy-ascii',
      simulated: false,
      error: reading.status === 'offline' ? 'legacy serial scale did not respond' : undefined,
    };
  }

  async read(kind: 'spool' | 'roll'): Promise<ScaleReadResult> {
    const port = await this.ensureOpen();
    if (!port) return this.mark({ status: 'offline', stable: false, grossKg: 0 });

    this.buffer = '';
    if (this.opts.pollCommand) port.write(decodePollCommand(this.opts.pollCommand));

    const raw = await this.waitForFrame();
    if (raw === null) {
      log.warn('scale read timed out — no frame from device', { kind, port: this.opts.path });
      return this.mark({ status: 'offline', stable: false, grossKg: 0 });
    }
    const parsed = parseScaleFrame(raw);
    if (!parsed.ok) {
      log.warn('scale frame not recognized', { kind, raw, reason: parsed.reason });
      return this.mark({ status: 'unstable', stable: false, grossKg: 0, raw });
    }
    const stable = parsed.frame.stable ?? this.opts.assumeStable;
    return this.mark({
      status: stable ? 'ready' : 'unstable',
      stable,
      grossKg: parsed.frame.weightKg,
      raw,
    });
  }

  status(): ScaleReadStatus {
    return this.lastStatus;
  }

  async close(): Promise<void> {
    if (this.port?.isOpen) await new Promise<void>((r) => this.port!.close(() => r()));
    this.port = null;
  }

  private mark(result: ScaleReadResult): ScaleReadResult {
    this.lastStatus = result.status;
    return result;
  }

  private async ensureOpen(): Promise<SerialPortLike | null> {
    if (this.port?.isOpen) return this.port;
    const SerialPort = loadSerialPortModule();
    if (!SerialPort) {
      log.error('serialport module is not installed — run `npm install` (optional dep)', {
        hint: 'npm install serialport -w @plenka/gateway-agent',
      });
      return null;
    }
    try {
      const port = new SerialPort({
        path: this.opts.path,
        baudRate: this.opts.baudRate,
        autoOpen: false,
      });
      await new Promise<void>((resolve, reject) =>
        port.open((err) => (err ? reject(err) : resolve())),
      );
      port.on('data', (chunk) => {
        this.buffer += (chunk as Buffer).toString('latin1');
        // Keep the tail only — a chatty scale must not grow the buffer unbounded.
        if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-1024);
      });
      port.on('close', () => {
        this.lastStatus = 'offline';
        this.port = null;
      });
      port.on('error', (err) => log.warn('serial port error', { error: String(err) }));
      this.port = port;
      log.info('serial port opened', { port: this.opts.path, baudRate: this.opts.baudRate });
      return port;
    } catch (err) {
      log.warn('serial port open failed', { port: this.opts.path, error: String(err) });
      this.port = null;
      return null;
    }
  }

  /** Wait for one complete CR/LF-delimited frame, up to the configured timeout. */
  private async waitForFrame(): Promise<string | null> {
    const deadline = Date.now() + this.opts.readTimeoutMs;
    while (Date.now() < deadline) {
      const match = /([^\r\n]+)[\r\n]/.exec(this.buffer);
      if (match) {
        this.buffer = this.buffer.slice(match.index + match[0].length);
        if (match[1].trim()) return match[1];
        continue;
      }
      await sleep(50);
    }
    return null;
  }
}
