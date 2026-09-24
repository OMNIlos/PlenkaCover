import { EventEmitter } from 'node:events';
import { log } from '../../logger';
import {
  Protocol100TimeoutError,
  SerialProtocol100Exchange,
  type SerialPortConstructor,
} from './serial-protocol-100-exchange';

class FakeSerialPort extends EventEmitter {
  static latest: FakeSerialPort | null = null;
  static deferOpen = false;
  isOpen = false;
  writes: Buffer[] = [];
  deferWriteCallbacks = false;
  writeCallbackError: Error | null = null;
  writeError: Error | null = null;
  private openCallback: ((error: Error | null) => void) | null = null;
  private readonly writeCallbacks: Array<(error: Error | null) => void> = [];

  constructor(readonly options: Record<string, unknown>) {
    super();
    FakeSerialPort.latest = this;
  }

  open(callback: (error: Error | null) => void): void {
    if (FakeSerialPort.deferOpen) {
      this.openCallback = callback;
      return;
    }
    this.isOpen = true;
    callback(null);
  }

  write(data: Buffer, callback: (error: Error | null) => void): void {
    this.writes.push(Buffer.from(data));
    if (this.writeError) throw this.writeError;
    if (this.deferWriteCallbacks) this.writeCallbacks.push(callback);
    else callback(this.writeCallbackError);
  }

  close(callback: (error: Error | null) => void): void {
    this.isOpen = false;
    callback(null);
    this.emit('close');
  }

  completeNextWrite(error: Error | null): void {
    this.writeCallbacks.shift()?.(error);
  }

  completeOpen(error: Error | null): void {
    const callback = this.openCallback;
    if (!callback) return;
    this.openCallback = null;
    if (!error) this.isOpen = true;
    callback(error);
  }
}

const Constructor = FakeSerialPort as unknown as SerialPortConstructor;

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('SerialProtocol100Exchange', () => {
  beforeEach(() => {
    FakeSerialPort.latest = null;
    FakeSerialPort.deferOpen = false;
  });

  it('opens the pilot RS-232 link with even parity', async () => {
    const exchange = new SerialProtocol100Exchange(
      {
        path: '/dev/ttyUSB0',
        baudRate: 4_800,
        parity: 'even',
      },
      Constructor,
    );
    const pending = exchange.request(0x23, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const port = FakeSerialPort.latest!;
    port.emit('data', Buffer.from('f855ce090024f410000002010000df40', 'hex'));
    await pending;
    await exchange.close();

    expect(port.options).toMatchObject({ baudRate: 4_800, parity: 'even' });
  });

  it('writes one exact request and resolves a fragmented binary response', async () => {
    const exchange = new SerialProtocol100Exchange(
      { path: '/dev/ttyACM0', baudRate: 57_600 },
      Constructor,
    );
    const pending = exchange.request(0x23, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const port = FakeSerialPort.latest!;
    expect(port.writes[0].toString('hex')).toBe('f855ce0100232300');
    const response = Buffer.from('f855ce090024f410000002010000df40', 'hex');
    port.emit('data', response.subarray(0, 4));
    port.emit('data', response.subarray(4));
    await expect(pending).resolves.toMatchObject({ body: response.subarray(5, 14) });
    await exchange.close();
  });

  it('rejects a CRC-corrupted response', async () => {
    const exchange = new SerialProtocol100Exchange(
      { path: '/dev/ttyACM0', baudRate: 57_600 },
      Constructor,
    );
    const pending = exchange.request(0x23, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const corruptedPort = FakeSerialPort.latest!;
    corruptedPort.emit('data', Buffer.from('f855ce02002808878b', 'hex'));
    await expect(pending).rejects.toMatchObject({ reason: 'crc' });

    const retry = exchange.request(0x23, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retryPort = FakeSerialPort.latest!;
    retryPort.emit('data', Buffer.from('f855ce090024f410000002010000df40', 'hex'));
    await expect(retry).resolves.toMatchObject({ body: Buffer.from('24f410000002010000', 'hex') });
    await exchange.close();

    expect(retryPort).not.toBe(corruptedPort);
  });

  it('reopens after timeout so a delayed response cannot complete the next request', async () => {
    const exchange = new SerialProtocol100Exchange(
      { path: '/dev/ttyACM0', baudRate: 57_600 },
      Constructor,
    );
    const first = exchange.request(0x23, 25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstPort = FakeSerialPort.latest!;
    await expect(first).rejects.toBeInstanceOf(Protocol100TimeoutError);

    const second = exchange.request(0x23, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondPort = FakeSerialPort.latest!;
    let secondSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    const response = Buffer.from('f855ce090024f410000002010000df40', 'hex');
    firstPort.emit('data', response);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledByDelayedResponse = secondSettled;

    if (!secondSettled) secondPort.emit('data', response);
    await expect(second).resolves.toMatchObject({ body: response.subarray(5, 14) });
    await exchange.close();

    expect(secondPort).not.toBe(firstPort);
    expect(settledByDelayedResponse).toBe(false);
  });

  it('drops a timed-out partial frame before the next request', async () => {
    const exchange = new SerialProtocol100Exchange(
      { path: '/dev/ttyACM0', baudRate: 57_600 },
      Constructor,
    );
    const first = exchange.request(0x23, 25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    FakeSerialPort.latest!.emit('data', Buffer.from('f855ce090024f4', 'hex'));
    await expect(first).rejects.toBeInstanceOf(Protocol100TimeoutError);

    const second = exchange.request(0x23, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    FakeSerialPort.latest!.emit('data', Buffer.from('f855ce090024f410000002010000df40', 'hex'));
    await expect(second).resolves.toMatchObject({
      body: Buffer.from('24f410000002010000', 'hex'),
    });
    await exchange.close();
  });

  it('rejects a concurrent request while the first request is opening the port', async () => {
    const exchange = new SerialProtocol100Exchange(
      { path: '/dev/ttyACM0', baudRate: 57_600 },
      Constructor,
    );
    const first = exchange.request(0x23, 100);

    await expect(exchange.request(0x23, 100)).rejects.toThrow(
      'Protocol 100 exchange already has an active request',
    );

    await flushMicrotasks();
    const response = Buffer.from('f855ce090024f410000002010000df40', 'hex');
    FakeSerialPort.latest!.emit('data', response);
    await expect(first).resolves.toMatchObject({ body: response.subarray(5, 14) });
    await exchange.close();
  });

  it('ignores a delayed write callback after its request has settled', async () => {
    const exchange = new SerialProtocol100Exchange(
      { path: '/dev/ttyACM0', baudRate: 57_600 },
      Constructor,
    );
    const first = exchange.request(0x23, 100);
    const port = FakeSerialPort.latest!;
    port.deferWriteCallbacks = true;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const response = Buffer.from('f855ce090024f410000002010000df40', 'hex');
    port.emit('data', response);
    await expect(first).resolves.toMatchObject({ body: response.subarray(5, 14) });

    const second = exchange.request(0x23, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    port.completeNextWrite(new Error('late write failure'));
    port.emit('data', response);

    await expect(second).resolves.toMatchObject({ body: response.subarray(5, 14) });
    port.completeNextWrite(null);
    await exchange.close();
  });

  it('does not leave a response timer when request encoding fails', async () => {
    jest.useFakeTimers();
    try {
      const exchange = new SerialProtocol100Exchange(
        { path: '/dev/ttyACM0', baudRate: 57_600 },
        Constructor,
      );

      await expect(exchange.request(0x100, 100)).rejects.toMatchObject({ reason: 'length' });

      expect(jest.getTimerCount()).toBe(0);
      await exchange.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the response timer when the serial write throws', async () => {
    jest.useFakeTimers();
    try {
      const exchange = new SerialProtocol100Exchange(
        { path: '/dev/ttyACM0', baudRate: 57_600 },
        Constructor,
      );
      const pending = exchange.request(0x23, 100);
      FakeSerialPort.latest!.writeError = new Error('serial write failed');

      await expect(pending).rejects.toThrow('serial write failed');
      expect(jest.getTimerCount()).toBe(0);

      const failedPort = FakeSerialPort.latest!;
      const retry = exchange.request(0x23, 100);
      const retryPort = FakeSerialPort.latest!;
      retryPort.writeError = null;
      await flushMicrotasks();
      const response = Buffer.from('f855ce090024f410000002010000df40', 'hex');
      retryPort.emit('data', response);
      await expect(retry).resolves.toMatchObject({ body: response.subarray(5, 14) });
      await exchange.close();

      expect(retryPort).not.toBe(failedPort);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the response timer when the serial write callback reports an error', async () => {
    jest.useFakeTimers();
    try {
      const exchange = new SerialProtocol100Exchange(
        { path: '/dev/ttyACM0', baudRate: 57_600 },
        Constructor,
      );
      const pending = exchange.request(0x23, 100);
      FakeSerialPort.latest!.writeCallbackError = new Error('serial callback failed');

      await expect(pending).rejects.toThrow('serial callback failed');

      expect(jest.getTimerCount()).toBe(0);
      await exchange.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects on a current port error and clears the response timer', async () => {
    jest.useFakeTimers();
    const warning = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const exchange = new SerialProtocol100Exchange(
        { path: '/dev/ttyACM0', baudRate: 57_600 },
        Constructor,
      );
      const pending = exchange.request(0x23, 100);
      await flushMicrotasks();

      FakeSerialPort.latest!.emit('error', new Error('serial port failed'));

      await expect(pending).rejects.toThrow('serial port failed');
      expect(jest.getTimerCount()).toBe(0);
      await exchange.close();
    } finally {
      warning.mockRestore();
      jest.useRealTimers();
    }
  });

  it('rejects on an external current port close and clears the response timer', async () => {
    jest.useFakeTimers();
    try {
      const exchange = new SerialProtocol100Exchange(
        { path: '/dev/ttyACM0', baudRate: 57_600 },
        Constructor,
      );
      const pending = exchange.request(0x23, 100);
      await flushMicrotasks();
      const port = FakeSerialPort.latest!;

      port.isOpen = false;
      port.emit('close');

      await expect(pending).rejects.toThrow('serial port closed');
      expect(jest.getTimerCount()).toBe(0);
      await exchange.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out a never-completing open without making close wait for its callback', async () => {
    jest.useFakeTimers();
    FakeSerialPort.deferOpen = true;
    const exchange = new SerialProtocol100Exchange(
      { path: '/dev/ttyACM0', baudRate: 57_600 },
      Constructor,
    );
    const pending = exchange.request(0x23, 25);
    const outcome = pending.then(
      () => ({ status: 'resolved' as const, error: null }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const port = FakeSerialPort.latest!;
    let openingCompleted = false;

    try {
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(25);
      await expect(outcome).resolves.toEqual({
        status: 'rejected',
        error: expect.any(Protocol100TimeoutError),
      });

      const closing = exchange.close();
      const closeOutcome = Promise.race([
        closing.then(() => 'closed' as const),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1)),
      ]);
      await jest.advanceTimersByTimeAsync(1);
      await expect(closeOutcome).resolves.toBe('closed');

      port.completeOpen(null);
      openingCompleted = true;
      await Promise.resolve();
      await Promise.resolve();
      expect(port.isOpen).toBe(false);
    } finally {
      if (!openingCompleted) port.completeOpen(null);
      await Promise.resolve();
      await Promise.resolve();
      await jest.runOnlyPendingTimersAsync();
      await outcome;
      await exchange.close();
      jest.useRealTimers();
    }
  });

  it('cancels an opening request when close races a missing open callback', async () => {
    jest.useFakeTimers();
    FakeSerialPort.deferOpen = true;
    const exchange = new SerialProtocol100Exchange(
      { path: '/dev/ttyACM0', baudRate: 57_600 },
      Constructor,
    );
    const pending = exchange.request(0x23, 100);
    const requestOutcome = pending.then(
      () => ({ status: 'resolved' as const, error: null }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const port = FakeSerialPort.latest!;
    const closing = exchange.close();
    let openingCompleted = false;

    try {
      const closeOutcome = Promise.race([
        closing.then(() => 'closed' as const),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1)),
      ]);
      const earlyRequestOutcome = Promise.race([
        requestOutcome,
        new Promise<{ status: 'pending'; error: null }>((resolve) =>
          setTimeout(() => resolve({ status: 'pending', error: null }), 1),
        ),
      ]);
      await jest.advanceTimersByTimeAsync(1);

      await expect(closeOutcome).resolves.toBe('closed');
      await expect(earlyRequestOutcome).resolves.toEqual({
        status: 'rejected',
        error: expect.objectContaining({ message: 'Protocol 100 exchange closed' }),
      });

      port.completeOpen(null);
      openingCompleted = true;
      await Promise.resolve();
      await Promise.resolve();
      expect(port.isOpen).toBe(false);
    } finally {
      if (!openingCompleted) port.completeOpen(null);
      await Promise.resolve();
      await Promise.resolve();
      await jest.runOnlyPendingTimersAsync();
      await requestOutcome;
      await closing.catch(() => undefined);
      await exchange.close();
      jest.useRealTimers();
    }
  });
});
