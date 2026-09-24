import { log } from '../../logger';
import {
  Protocol100FrameError,
  encodeProtocol100Command,
  type DecodedProtocol100Frame,
} from './protocol-100-frame';
import { Protocol100StreamDecoder } from './protocol-100-stream';

interface SerialPortLike {
  isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  write(data: Buffer, callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
  on(event: 'data', callback: (data: Buffer) => void): this;
  on(event: 'close', callback: () => void): this;
  on(event: 'error', callback: (error: Error) => void): this;
}

export type SerialPortConstructor = new (options: {
  path: string;
  baudRate: number;
  dataBits: 8;
  parity: 'none' | 'even';
  stopBits: 1;
  autoOpen: false;
}) => SerialPortLike;

export interface Protocol100Exchange {
  request(command: number, timeoutMs: number): Promise<DecodedProtocol100Frame>;
  close(): Promise<void>;
}

export interface SerialProtocol100Options {
  path: string;
  baudRate: number;
  parity?: 'none' | 'even';
}

export class Protocol100TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Protocol 100 response timed out after ${timeoutMs} ms`);
    this.name = 'Protocol100TimeoutError';
  }
}

type PendingRequest = {
  resolve: (frame: DecodedProtocol100Frame) => void;
  reject: (error: Error) => void;
};

type OpeningPort = {
  port: SerialPortLike;
  abandoned: boolean;
};

function loadSerialPort(): SerialPortConstructor {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('serialport') as { SerialPort: SerialPortConstructor }).SerialPort;
  } catch {
    throw new Error('serialport module is not installed');
  }
}

export class SerialProtocol100Exchange implements Protocol100Exchange {
  private port: SerialPortLike | null = null;
  private opening: OpeningPort | null = null;
  private decoder = new Protocol100StreamDecoder();
  private pending: PendingRequest | null = null;
  private requestActive = false;
  private cancelActiveRequest: ((error: Error) => void) | null = null;
  private lifecycleVersion = 0;

  constructor(
    private readonly options: SerialProtocol100Options,
    private readonly PortConstructor?: SerialPortConstructor,
  ) {}

  async request(command: number, timeoutMs: number): Promise<DecodedProtocol100Frame> {
    if (this.requestActive) {
      throw new Error('Protocol 100 exchange already has an active request');
    }
    this.requestActive = true;
    const lifecycleVersion = this.lifecycleVersion;
    try {
      const requestFrame = encodeProtocol100Command(command);
      let timeout: NodeJS.Timeout | null = null;
      let cancelRequest!: (error: Error) => void;
      const abort = new Promise<never>((_, reject) => {
        cancelRequest = reject;
        timeout = setTimeout(() => reject(new Protocol100TimeoutError(timeoutMs)), timeoutMs);
      });
      this.cancelActiveRequest = cancelRequest;
      try {
        const port = await Promise.race([this.ensureOpen(), abort]);
        if (lifecycleVersion !== this.lifecycleVersion) {
          throw new Error('Protocol 100 exchange closed');
        }
        this.decoder = new Protocol100StreamDecoder();
        const response = new Promise<DecodedProtocol100Frame>((resolve, reject) => {
          const pending: PendingRequest = { resolve, reject };
          this.pending = pending;
          try {
            port.write(requestFrame, (error) => {
              if (error) this.rejectPending(error, pending);
            });
          } catch (error) {
            this.rejectPending(
              error instanceof Error ? error : new Error('serial write failed'),
              pending,
            );
          }
        });
        return await Promise.race([response, abort]);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error('Protocol 100 request failed');
        this.rejectPending(failure);
        await this.invalidateConnection();
        throw failure;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (this.cancelActiveRequest === cancelRequest) this.cancelActiveRequest = null;
      }
    } finally {
      this.requestActive = false;
    }
  }

  async close(): Promise<void> {
    this.lifecycleVersion += 1;
    const error = new Error('Protocol 100 exchange closed');
    this.cancelActiveRequest?.(error);
    this.rejectPending(error);
    for (const port of this.detachConnection()) await this.closePort(port);
  }

  private async ensureOpen(): Promise<SerialPortLike> {
    if (this.port?.isOpen) return this.port;
    const Constructor = this.PortConstructor ?? loadSerialPort();
    const port = new Constructor({
      path: this.options.path,
      baudRate: this.options.baudRate,
      dataBits: 8,
      parity: this.options.parity ?? 'none',
      stopBits: 1,
      autoOpen: false,
    });
    port.on('data', (chunk) => {
      if (this.port === port) this.onData(chunk);
    });
    port.on('close', () => {
      if (this.port !== port) return;
      this.port = null;
      this.rejectPending(new Error('serial port closed'));
    });
    port.on('error', (error) => {
      log.warn('Protocol 100 serial port error', { error: String(error) });
      if (this.port === port) this.rejectPending(error);
    });
    const opening: OpeningPort = { port, abandoned: false };
    this.opening = opening;
    const opened = new Promise<void>((resolve, reject) =>
      port.open((error) => (error ? reject(error) : resolve())),
    );
    try {
      await opened;
      if (opening.abandoned || this.opening !== opening) {
        await this.closePortSafely(port);
        throw new Error('Protocol 100 serial session was abandoned');
      }
      this.opening = null;
      this.port = port;
      return port;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async closePort(port: SerialPortLike): Promise<void> {
    if (this.port === port) this.port = null;
    if (!port.isOpen) return;
    await new Promise<void>((resolve, reject) =>
      port.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async invalidateConnection(): Promise<void> {
    for (const port of this.detachConnection()) await this.closePortSafely(port);
  }

  private detachConnection(): SerialPortLike[] {
    const ports = new Set<SerialPortLike>();
    if (this.port) ports.add(this.port);
    if (this.opening) {
      this.opening.abandoned = true;
      if (this.opening.port.isOpen) ports.add(this.opening.port);
      this.opening = null;
    }
    this.port = null;
    this.decoder = new Protocol100StreamDecoder();
    return [...ports];
  }

  private async closePortSafely(port: SerialPortLike): Promise<void> {
    try {
      await this.closePort(port);
    } catch (error) {
      log.warn('Protocol 100 serial port close failed', { error: String(error) });
    }
  }

  private onData(chunk: Buffer): void {
    for (const event of this.decoder.push(chunk)) {
      if (!this.pending) return;
      if (!event.ok) {
        this.rejectPending(event.error);
        return;
      }
      const pending = this.takePending();
      pending?.resolve(event.frame);
      return;
    }
  }

  private rejectPending(error: Error | Protocol100FrameError, expected?: PendingRequest): void {
    if (expected && this.pending !== expected) return;
    const pending = this.takePending();
    pending?.reject(error);
  }

  private takePending(): PendingRequest | null {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    return pending;
  }
}
