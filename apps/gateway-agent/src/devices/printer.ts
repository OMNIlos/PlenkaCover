import { exec, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { PrinterPayload } from '@plenka/contracts';
import { buildPrintBytes, buildZplPrintBytes, type PrinterProfile } from '../label';
import { log } from '../logger';

export type PrinterStatus = 'ready' | 'offline';

export type PrintResult =
  | { ok: true; jobId: string; status: 'printed' | 'submitted' }
  | { ok: false; status: 'failed' | 'delivery_unknown'; error: string };

export interface PrinterDevice {
  print(payload: PrinterPayload): Promise<PrintResult>;
  /** Optional asynchronous transport readiness probe, invoked before heartbeats. */
  probe?(): Promise<PrinterStatus>;
  /** Last-known status for heartbeats — must not touch the hardware. */
  status(): PrinterStatus;
}

export type CupsZplQueues = {
  primary: string;
  warehouse?: string | null;
};

let jobSeq = 0;
const nextJobId = (prefix: string): string => `${prefix}-${Date.now()}-${++jobSeq}`;
const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

/** No-hardware demo printer; still builds the exact bytes so contract errors stay visible. */
export class SimulatedPrinter implements PrinterDevice {
  constructor(
    private readonly profile: PrinterProfile,
    private readonly fail = false,
  ) {}

  async print(payload: PrinterPayload): Promise<PrintResult> {
    try {
      buildPrintBytes(payload, this.profile);
    } catch (error) {
      return { ok: false, status: 'failed', error: errorText(error) };
    }
    if (this.fail) {
      return { ok: false, status: 'failed', error: 'simulated printer failure' };
    }
    log.info('simulated label printed', { kind: payload.kind });
    return { ok: true, jobId: nextJobId('sim'), status: 'printed' };
  }

  status(): PrinterStatus {
    return this.fail ? 'offline' : 'ready';
  }
}

/** TLP4 over Ethernet RAW :9100 — the label is sent as one binary TSPL buffer. */
export class Tcp9100Printer implements PrinterDevice {
  private lastStatus: PrinterStatus = 'ready';

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly profile: PrinterProfile,
    private readonly connectTimeoutMs = 3000,
  ) {}

  print(payload: PrinterPayload): Promise<PrintResult> {
    let bytes: Buffer;
    try {
      bytes = buildPrintBytes(payload, this.profile);
    } catch (error) {
      this.lastStatus = 'offline';
      return Promise.resolve({ ok: false, status: 'failed', error: errorText(error) });
    }

    return new Promise<PrintResult>((resolve) => {
      let settled = false;
      let submitted = false;
      const done = (result: PrintResult): void => {
        if (settled) return;
        settled = true;
        this.lastStatus = result.ok ? 'ready' : 'offline';
        resolve(result);
      };
      const fail = (error: string): void =>
        done({ ok: false, status: submitted ? 'delivery_unknown' : 'failed', error });
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setTimeout(this.connectTimeoutMs);
      socket.on('connect', () => {
        submitted = true;
        socket.end(bytes);
      });
      socket.on('close', (hadError) => {
        if (hadError || !submitted) {
          fail(`printer ${this.host}:${this.port} disconnected`);
        } else {
          done({ ok: true, jobId: nextJobId('tcp'), status: 'submitted' });
        }
      });
      socket.on('timeout', () => {
        fail(`printer ${this.host}:${this.port} timed out`);
        socket.destroy();
      });
      socket.on('error', (error) => fail(errorText(error)));
    });
  }

  status(): PrinterStatus {
    return this.lastStatus;
  }
}

/**
 * Honest Windows USB path: writes binary TSPL to a file, then invokes an administrator-owned
 * local spool command. Only the generated path enters the command; label data never does.
 */
export class WindowsCommandPrinter implements PrinterDevice {
  private lastStatus: PrinterStatus = 'ready';

  constructor(
    private readonly commandTemplate: string,
    private readonly labelDir: string,
    private readonly profile: PrinterProfile,
    private readonly execTimeoutMs = 15000,
  ) {}

  async print(payload: PrinterPayload): Promise<PrintResult> {
    let file: string;
    try {
      const bytes = buildPrintBytes(payload, this.profile);
      fs.mkdirSync(this.labelDir, { recursive: true });
      file = path.join(this.labelDir, `label-${Date.now()}.prn`);
      fs.writeFileSync(file, bytes);
    } catch (error) {
      this.lastStatus = 'offline';
      return { ok: false, status: 'failed', error: errorText(error) };
    }

    // The full command is authored in the post's LOCAL .env. Only our generated path is inserted.
    const command = this.commandTemplate.replaceAll('{file}', file);
    return new Promise<PrintResult>((resolve) => {
      exec(command, { timeout: this.execTimeoutMs, windowsHide: true }, (error, _out, stderr) => {
        const result: PrintResult = error
          ? {
              ok: false,
              status: 'delivery_unknown',
              error: errorText(stderr.trim() || error),
            }
          : { ok: true, jobId: nextJobId('cmd'), status: 'submitted' };
        this.lastStatus = result.ok ? 'ready' : 'offline';
        if (!result.ok) log.warn('windows print command failed', { category: result.status });
        resolve(result);
      });
    });
  }

  status(): PrinterStatus {
    return this.lastStatus;
  }
}

/** Ubuntu USB path verified on MERTECH TLP4: raw ZPL handed to one named CUPS queue. */
export class CupsZplPrinter implements PrinterDevice {
  private static readonly STALE_LABEL_AGE_MS = 5 * 60 * 1000;
  private static readonly CLEANUP_SCAN_LIMIT = 256;
  private static readonly CLEANUP_DELETE_LIMIT = 32;
  private static readonly LABEL_FILE_PATTERN =
    /^label-(?:\d{10,17}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.zpl$/iu;

  private lastStatus: PrinterStatus = 'offline';
  private operationGeneration = 0;
  private printsInFlight = 0;
  private readonly primaryQueue: string;
  private readonly warehouseQueue: string | null;

  constructor(
    queues: string | CupsZplQueues,
    private readonly labelDir: string,
    private readonly profile: PrinterProfile,
    private readonly executable = '/usr/bin/lp',
    private readonly execTimeoutMs = 15000,
    private readonly statusExecutable = '/usr/bin/lpstat',
  ) {
    this.primaryQueue = typeof queues === 'string' ? queues : queues.primary;
    this.warehouseQueue = typeof queues === 'string' ? null : (queues.warehouse ?? null);
    this.cleanupStaleLabels();
  }

  probe(): Promise<PrinterStatus> {
    const observedOperationGeneration = this.operationGeneration;
    return this.probeQueue(this.primaryQueue).then((status) => {
      if (observedOperationGeneration === this.operationGeneration && this.printsInFlight === 0) {
        this.lastStatus = status;
      }
      return status;
    });
  }

  private probeQueue(queue: string): Promise<PrinterStatus> {
    return new Promise<PrinterStatus>((resolve) => {
      const done = (status: PrinterStatus): void => {
        resolve(status);
      };
      try {
        execFile(
          this.statusExecutable,
          ['-p', queue, '-a', queue],
          {
            timeout: this.execTimeoutMs,
            env: { ...process.env, LC_ALL: 'C' },
          },
          (error, stdout) => {
            if (error) {
              done('offline');
              return;
            }
            const lines = stdout.split(/\r?\n/u);
            const queueEnabled = lines.some(
              (line) =>
                line.startsWith(`printer ${queue} `) &&
                line.includes(' enabled since ') &&
                !line.includes(' disabled since '),
            );
            const queueAccepting = lines.some((line) =>
              line.startsWith(`${queue} accepting requests`),
            );
            done(queueEnabled && queueAccepting ? 'ready' : 'offline');
          },
        );
      } catch {
        done('offline');
      }
    });
  }

  async print(payload: PrinterPayload): Promise<PrintResult> {
    const queue = this.queueFor(payload);
    if (
      payload.kind !== 'roll_label' &&
      this.warehouseQueue !== null &&
      queue === this.warehouseQueue &&
      queue !== this.primaryQueue &&
      (await this.probeQueue(queue)) !== 'ready'
    ) {
      return {
        ok: false,
        status: 'failed',
        error: 'warehouse printer queue is unavailable',
      };
    }
    const affectsPrimaryStatus = queue === this.primaryQueue;
    this.beginPrintOperation(affectsPrimaryStatus);
    let file = '';
    try {
      const bytes = buildZplPrintBytes(payload, this.profile);
      fs.mkdirSync(this.labelDir, { recursive: true, mode: 0o700 });
      file = path.join(this.labelDir, `label-${randomUUID()}.zpl`);
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (file) this.removeLabelFile(file);
      this.completePrintOperation('offline', affectsPrimaryStatus);
      return { ok: false, status: 'failed', error: errorText(error) };
    }

    return new Promise<PrintResult>((resolve) => {
      const done = (result: PrintResult): void => {
        this.removeLabelFile(file);
        this.completePrintOperation(result.ok ? 'ready' : 'offline', affectsPrimaryStatus);
        if (!result.ok) log.warn('CUPS print submission failed', { category: result.status });
        resolve(result);
      };
      try {
        execFile(
          this.executable,
          ['-d', queue, '-o', 'raw', file],
          {
            timeout: this.execTimeoutMs,
            env: { ...process.env, LC_ALL: 'C' },
          },
          (error, stdout, stderr) => {
            if (!error) {
              const jobId = cupsRequestId(stdout, queue);
              if (!jobId) {
                done({
                  ok: false,
                  status: 'delivery_unknown',
                  error: 'CUPS accepted the job but returned no request id',
                });
                return;
              }
              done({ ok: true, jobId, status: 'submitted' });
              return;
            }
            done({
              ok: false,
              status: cupsFailureStatus(error),
              error: errorText(stderr.trim() || error),
            });
          },
        );
      } catch (error) {
        done({ ok: false, status: 'failed', error: errorText(error) });
      }
    });
  }

  status(): PrinterStatus {
    return this.lastStatus;
  }

  private queueFor(payload: PrinterPayload): string {
    return payload.kind === 'roll_label' ||
      (payload.kind === 'big_bag_label' && payload.destination === 'operator')
      ? this.primaryQueue
      : (this.warehouseQueue ?? this.primaryQueue);
  }

  private beginPrintOperation(affectsPrimaryStatus: boolean): void {
    if (!affectsPrimaryStatus) return;
    this.printsInFlight += 1;
    this.operationGeneration += 1;
  }

  private completePrintOperation(status: PrinterStatus, affectsPrimaryStatus: boolean): void {
    if (!affectsPrimaryStatus) return;
    this.printsInFlight -= 1;
    this.operationGeneration += 1;
    this.lastStatus = status;
  }

  private cleanupStaleLabels(): void {
    let directory: fs.Dir | undefined;
    try {
      directory = fs.opendirSync(this.labelDir);
      const cutoff = Date.now() - CupsZplPrinter.STALE_LABEL_AGE_MS;
      let removed = 0;
      for (let scanned = 0; scanned < CupsZplPrinter.CLEANUP_SCAN_LIMIT; scanned += 1) {
        const entry = directory.readSync();
        if (!entry) break;
        if (removed >= CupsZplPrinter.CLEANUP_DELETE_LIMIT) continue;
        if (!CupsZplPrinter.LABEL_FILE_PATTERN.test(entry.name)) continue;
        const file = path.join(this.labelDir, entry.name);
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
          fs.unlinkSync(file);
          removed += 1;
        } catch {
          // A concurrent print or cleanup may already own/remove this file.
        }
      }
    } catch {
      // Startup cleanup is best-effort and must not block the gateway.
    } finally {
      try {
        directory?.closeSync();
      } catch {
        // The directory may already be invalidated by a concurrent filesystem change.
      }
    }
  }

  private removeLabelFile(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {
      // Cleanup must never change the already-determined physical delivery outcome.
    }
  }
}

function cupsRequestId(stdout: string, queue: string): string | null {
  const prefix = `${queue}-`;
  return (
    stdout
      .trim()
      .split(/\s+/u)
      .find(
        (token) => token.startsWith(prefix) && /^[1-9][0-9]*$/u.test(token.slice(prefix.length)),
      ) ?? null
  );
}

function cupsFailureStatus(error: unknown): 'failed' | 'delivery_unknown' {
  if (typeof error !== 'object' || error === null) return 'delivery_unknown';
  const details = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    syscall?: unknown;
  };
  if (
    details.killed === true ||
    (typeof details.signal === 'string' && details.signal.length > 0) ||
    details.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  ) {
    return 'delivery_unknown';
  }
  if (typeof details.syscall === 'string' && /^spawn(?:\s|$)/u.test(details.syscall)) {
    return 'failed';
  }
  return 'delivery_unknown';
}
