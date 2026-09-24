import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import {
  PALLET_LABEL_PROFILE,
  type BigBagLabelPrinterPayload,
  type PalletLabelPrinterPayload,
  type RollLabelPrinterPayload,
} from '@plenka/contracts';
import { buildPrintBytes, type PrinterProfile } from '../label';
import { CupsZplPrinter, SimulatedPrinter, Tcp9100Printer, WindowsCommandPrinter } from './printer';

jest.mock('node:child_process', () => ({ exec: jest.fn(), execFile: jest.fn() }));
jest.mock('node:fs', () => ({
  lstatSync: jest.fn(),
  mkdirSync: jest.fn(),
  opendirSync: jest.fn(() => ({
    closeSync: jest.fn(),
    readSync: jest.fn(() => null),
  })),
  readdirSync: jest.fn().mockReturnValue([]),
  unlinkSync: jest.fn(),
  writeFileSync: jest.fn(),
}));
jest.mock('node:net', () => ({ createConnection: jest.fn() }));

const PROFILE: PrinterProfile = { dpi: 203, maxWidthDots: 864 };
const PALLET_PAYLOAD: PalletLabelPrinterPayload = {
  kind: 'pallet_label',
  documentId: 'document-1',
  templateVersion: PALLET_LABEL_PROFILE.templateVersion,
  widthMm: PALLET_LABEL_PROFILE.widthMm,
  heightMm: PALLET_LABEL_PROFILE.heightMm,
  dpi: PALLET_LABEL_PROFILE.dpi,
  widthDots: PALLET_LABEL_PROFILE.widthDots,
  heightDots: PALLET_LABEL_PROFILE.heightDots,
  bitmapBase64: Buffer.alloc(PALLET_LABEL_PROFILE.bitmapBytes, 0xaa).toString('base64'),
  copies: PALLET_LABEL_PROFILE.copies,
};
const ROLL_PAYLOAD: RollLabelPrinterPayload = {
  kind: 'roll_label',
  rollCode: 'ROLL-1',
  qrCode: `prt_${'a'.repeat(64)}`,
};
const BIG_BAG_PAYLOAD: BigBagLabelPrinterPayload = {
  kind: 'big_bag_label',
  destination: 'warehouse',
  bigBagCode: 'BB-1',
  material: 'ПВД',
  qrCode: `bbt_${'b'.repeat(64)}`,
};
const DEFECT_BAG_PAYLOAD: BigBagLabelPrinterPayload = {
  ...BIG_BAG_PAYLOAD,
  destination: 'operator',
  bigBagCode: 'DEF-1',
  material: 'БРАК · 12.345 кг',
};

type SocketHandler = (...args: unknown[]) => void;

function mockSocket() {
  const handlers: Record<string, SocketHandler> = {};
  const socket = {
    setTimeout: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
    on: jest.fn((event: string, handler: SocketHandler) => {
      handlers[event] = handler;
    }),
  };
  (net.createConnection as unknown as jest.Mock).mockReturnValue(socket);
  return { handlers, socket };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('printer transports', () => {
  it('sends byte-identical pallet TSPL through TCP and the Windows spool file', async () => {
    const expected = buildPrintBytes(PALLET_PAYLOAD, PROFILE);
    const tcp = mockSocket();
    const tcpPrinter = new Tcp9100Printer('192.168.1.50', 9100, PROFILE);
    const tcpResult = tcpPrinter.print(PALLET_PAYLOAD);
    tcp.handlers.connect();
    const tcpBytes = tcp.socket.end.mock.calls[0][0] as Buffer;
    tcp.handlers.close(false);

    let commandCallback: (...args: unknown[]) => void = () => undefined;
    (childProcess.exec as unknown as jest.Mock).mockImplementation(
      (_command: string, _options: unknown, callback: (...args: unknown[]) => void) => {
        commandCallback = callback;
      },
    );
    const windowsPrinter = new WindowsCommandPrinter('print {file}', '/labels', PROFILE);
    const windowsResult = windowsPrinter.print(PALLET_PAYLOAD);
    const windowsBytes = (fs.writeFileSync as unknown as jest.Mock).mock.calls[0][1] as Buffer;
    commandCallback(null, '', '');

    await expect(tcpResult).resolves.toMatchObject({ ok: true, status: 'submitted' });
    await expect(windowsResult).resolves.toMatchObject({ ok: true, status: 'submitted' });
    expect(tcpPrinter.status()).toBe('ready');
    expect(windowsPrinter.status()).toBe('ready');
    expect(Buffer.isBuffer(tcpBytes)).toBe(true);
    expect(Buffer.isBuffer(windowsBytes)).toBe(true);
    expect(tcpBytes).toEqual(expected);
    expect(windowsBytes).toEqual(expected);
    expect(tcp.socket.end).toHaveBeenCalledWith(expected);
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expected);
  });

  it('reports delivery_unknown when TCP times out after bytes were submitted', async () => {
    const tcp = mockSocket();
    const printer = new Tcp9100Printer('192.168.1.50', 9100, PROFILE, 50);
    const result = printer.print(PALLET_PAYLOAD);

    tcp.handlers.connect();
    tcp.handlers.timeout();
    tcp.handlers.close(false);

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'delivery_unknown',
      error: expect.stringMatching(/timed/),
    });
    expect(printer.status()).toBe('offline');
  });

  it('keeps TCP status offline after a socket error', async () => {
    const tcp = mockSocket();
    const printer = new Tcp9100Printer('192.168.1.50', 9100, PROFILE);
    const result = printer.print(PALLET_PAYLOAD);

    tcp.handlers.error(new Error('ECONNREFUSED'));
    tcp.handlers.close(true);

    await expect(result).resolves.toMatchObject({ ok: false, status: 'failed' });
    expect(printer.status()).toBe('offline');
  });

  it('marks the Windows transport offline when the spool command fails', async () => {
    (childProcess.exec as unknown as jest.Mock).mockImplementation(
      (_command: string, _options: unknown, callback: (...args: unknown[]) => void) => {
        callback(new Error('spooler unavailable'), '', 'spooler unavailable');
      },
    );
    const printer = new WindowsCommandPrinter('print {file}', '/labels', PROFILE);

    await expect(printer.print(PALLET_PAYLOAD)).resolves.toMatchObject({
      ok: false,
      status: 'delivery_unknown',
    });
    expect(printer.status()).toBe('offline');
  });

  it('submits raw ZPL to one configured CUPS queue without invoking a shell', async () => {
    let callback: (...args: unknown[]) => void = () => undefined;
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _options: unknown, cb: (...args: unknown[]) => void) => {
        callback = cb;
      },
    );
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    const result = printer.print(PALLET_PAYLOAD);
    const [labelFile, bytes] = (fs.writeFileSync as unknown as jest.Mock).mock.calls[0] as [
      string,
      Buffer,
    ];
    callback(null, 'request id is TLP4-1', '');

    await expect(result).resolves.toEqual({
      ok: true,
      jobId: 'TLP4-1',
      status: 'submitted',
    });
    expect(labelFile).toMatch(/^\/labels\/label-[0-9a-f-]{36}\.zpl$/u);
    expect(bytes.toString('ascii')).toContain('^GFA,99900,99900,100,');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      labelFile,
      bytes,
      expect.objectContaining({ flag: 'wx', mode: 0o600 }),
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(labelFile);
    expect(childProcess.execFile).toHaveBeenCalledWith(
      '/usr/bin/lp',
      ['-d', 'TLP4', '-o', 'raw', labelFile],
      expect.objectContaining({ timeout: 15000 }),
      expect.any(Function),
    );
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it('routes operator and warehouse labels to their own queues', async () => {
    let requestNumber = 0;
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (file: string, args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
        if (file === '/usr/bin/lpstat') {
          callback(
            null,
            `printer ${args[1]} is idle. enabled since Thursday\n${args[1]} accepting requests since Thursday`,
            '',
          );
          return;
        }
        callback(null, `request id is ${args[1]}-${++requestNumber} (1 file(s))`, '');
      },
    );
    const queues = { primary: 'TLP4', warehouse: 'TLP4_WH' };
    const printer = new CupsZplPrinter(queues, '/labels', PROFILE);

    await expect(printer.print(ROLL_PAYLOAD)).resolves.toMatchObject({ ok: true });
    await expect(printer.print(DEFECT_BAG_PAYLOAD)).resolves.toMatchObject({ ok: true });
    await expect(printer.print(BIG_BAG_PAYLOAD)).resolves.toMatchObject({ ok: true });
    await expect(printer.print(PALLET_PAYLOAD)).resolves.toMatchObject({ ok: true });

    const destinations = (childProcess.execFile as unknown as jest.Mock).mock.calls
      .filter(([file]: [string]) => file === '/usr/bin/lp')
      .map(([, args]: [string, string[]]) => args[1]);
    expect(destinations).toEqual(['TLP4', 'TLP4', 'TLP4_WH', 'TLP4_WH']);

    const [rollZpl, defectBagZpl, bigBagZpl, palletZpl] = (
      fs.writeFileSync as unknown as jest.Mock
    ).mock.calls.map(([, bytes]: [string, Buffer]) => bytes.toString('ascii'));
    expect([...rollZpl.matchAll(/\^BQN/gu)]).toHaveLength(1);
    expect([...rollZpl.matchAll(/\^PQ1/gu)]).toHaveLength(1);
    expect([...defectBagZpl.matchAll(/\^BQN/gu)]).toHaveLength(1);
    expect([...defectBagZpl.matchAll(/\^PQ1/gu)]).toHaveLength(1);
    expect([...bigBagZpl.matchAll(/\^BQN/gu)]).toHaveLength(1);
    expect([...bigBagZpl.matchAll(/\^PQ1/gu)]).toHaveLength(1);
    expect([...palletZpl.matchAll(/\^BQN/gu)]).toHaveLength(0);
    expect([...palletZpl.matchAll(/\^PQ1/gu)]).toHaveLength(1);
  });

  it('reports delivery_unknown instead of inventing an id when CUPS omits its request id', async () => {
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) =>
        callback(null, 'request accepted', ''),
    );
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    await expect(printer.print(ROLL_PAYLOAD)).resolves.toMatchObject({
      ok: false,
      status: 'delivery_unknown',
      error: expect.stringMatching(/request id/iu),
    });
  });

  it('starts offline and marks a CUPS queue ready only after a successful local probe', async () => {
    let callback: (...args: unknown[]) => void = () => undefined;
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _options: unknown, cb: (...args: unknown[]) => void) => {
        callback = cb;
      },
    );
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    expect(printer.status()).toBe('offline');
    const result = printer.probe();
    callback(
      null,
      'printer TLP4 is idle. enabled since Thursday\nTLP4 accepting requests since Thursday',
      '',
    );

    await expect(result).resolves.toBe('ready');
    expect(printer.status()).toBe('ready');
    expect(childProcess.execFile).toHaveBeenCalledWith(
      '/usr/bin/lpstat',
      ['-p', 'TLP4', '-a', 'TLP4'],
      expect.objectContaining({ timeout: 15000 }),
      expect.any(Function),
    );
  });

  it('probes the primary queue without coupling it to the optional warehouse queue', async () => {
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) =>
        callback(
          null,
          [
            'printer TLP4 is idle. enabled since Thursday',
            'TLP4 accepting requests since Thursday',
          ].join('\n'),
          '',
        ),
    );
    const printer = new CupsZplPrinter(
      { primary: 'TLP4', warehouse: 'TLP4_WH' },
      '/labels',
      PROFILE,
    );

    await expect(printer.probe()).resolves.toBe('ready');
    expect(childProcess.execFile).toHaveBeenCalledWith(
      '/usr/bin/lpstat',
      ['-p', 'TLP4', '-a', 'TLP4'],
      expect.objectContaining({ timeout: 15000 }),
      expect.any(Function),
    );
  });

  it('rejects an unavailable warehouse queue before writing or submitting a pallet job', async () => {
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (
        executable: string,
        args: string[],
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => {
        if (executable === '/usr/bin/lpstat') {
          const queue = args[1];
          if (queue === 'TLP4_WH') {
            callback(Object.assign(new Error('warehouse queue unavailable'), { code: 1 }), '', '');
            return;
          }
          callback(
            null,
            'printer TLP4 is idle. enabled since Thursday\nTLP4 accepting requests since Thursday',
            '',
          );
          return;
        }
        callback(null, 'request id is TLP4_WH-1', '');
      },
    );
    const printer = new CupsZplPrinter(
      { primary: 'TLP4', warehouse: 'TLP4_WH' },
      '/labels',
      PROFILE,
    );

    await expect(printer.probe()).resolves.toBe('ready');
    await expect(printer.print(PALLET_PAYLOAD)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: expect.stringMatching(/warehouse printer queue/iu),
    });
    expect(printer.status()).toBe('ready');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalledWith(
      '/usr/bin/lp',
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('keeps CUPS offline when the configured queue rejects jobs', async () => {
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => {
        callback(new Error('queue unavailable'), '', 'TLP4 not accepting requests');
      },
    );
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    await expect(printer.probe()).resolves.toBe('offline');
    expect(printer.status()).toBe('offline');
  });

  it.each([
    [
      'missing lp executable',
      Object.assign(new Error('spawn /usr/bin/lp ENOENT'), {
        code: 'ENOENT',
        killed: false,
        syscall: 'spawn /usr/bin/lp',
      }),
    ],
    [
      'explicit spawn resource failure',
      Object.assign(new Error('spawn /usr/bin/lp EAGAIN'), {
        code: 'EAGAIN',
        killed: false,
        syscall: 'spawn /usr/bin/lp',
      }),
    ],
  ])(
    'reports %s as a failed pre-submission and removes the sensitive ZPL file',
    async (_case, submissionError) => {
      (childProcess.execFile as unknown as jest.Mock).mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (...args: unknown[]) => void,
        ) => {
          callback(submissionError, '', 'printer unavailable');
        },
      );
      const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

      await expect(printer.print(PALLET_PAYLOAD)).resolves.toMatchObject({
        ok: false,
        status: 'failed',
        error: 'printer unavailable',
      });
      expect(printer.status()).toBe('offline');
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/\.zpl$/u));
    },
  );

  it('reports a synchronous execFile failure before process start as failed', async () => {
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(() => {
      throw new Error('execFile failed before process start');
    });
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    await expect(printer.print(PALLET_PAYLOAD)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
    });
    expect(printer.status()).toBe('offline');
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/\.zpl$/u));
  });

  it.each([
    ['timeout kill', Object.assign(new Error('lp timed out'), { killed: true, signal: 'SIGTERM' })],
    [
      'child signal with killed:false',
      Object.assign(new Error('lp terminated'), {
        code: null,
        killed: false,
        signal: 'SIGTERM',
      }),
    ],
    [
      'post-spawn output-limit termination',
      Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: false,
      }),
    ],
    [
      'non-zero lp exit after process start',
      Object.assign(new Error('destination TLP4 does not exist'), {
        code: 1,
        killed: false,
      }),
    ],
    ['callback error without exit evidence', new Error('unknown child-process outcome')],
  ])('reports %s as delivery_unknown', async (_case, submissionError) => {
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => {
        callback(submissionError, '', '');
      },
    );
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    await expect(printer.print(PALLET_PAYLOAD)).resolves.toMatchObject({
      ok: false,
      status: 'delivery_unknown',
    });
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/\.zpl$/u));
  });

  it('does not let an older successful queue probe overwrite a later ambiguous print', async () => {
    let probeCallback: (...args: unknown[]) => void = () => undefined;
    let printCallback: (...args: unknown[]) => void = () => undefined;
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (
        executable: string,
        _args: string[],
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => {
        if (executable === '/usr/bin/lpstat') probeCallback = callback;
        else printCallback = callback;
      },
    );
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    const probe = printer.probe();
    const print = printer.print(PALLET_PAYLOAD);
    printCallback(Object.assign(new Error('queue rejected job'), { code: 1 }), '', '');
    await expect(print).resolves.toMatchObject({ ok: false, status: 'delivery_unknown' });
    probeCallback(
      null,
      'printer TLP4 is idle. enabled since Thursday\nTLP4 accepting requests since Thursday',
      '',
    );
    await expect(probe).resolves.toBe('ready');

    expect(printer.status()).toBe('offline');
  });

  it('does not let a ready probe started during printing overwrite an ambiguous print', async () => {
    let probeCallback: (...args: unknown[]) => void = () => undefined;
    let printCallback: (...args: unknown[]) => void = () => undefined;
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (
        executable: string,
        _args: string[],
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => {
        if (executable === '/usr/bin/lpstat') probeCallback = callback;
        else printCallback = callback;
      },
    );
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    const print = printer.print(PALLET_PAYLOAD);
    const probe = printer.probe();
    printCallback(Object.assign(new Error('queue rejected job'), { code: 1 }), '', '');
    await expect(print).resolves.toMatchObject({ ok: false, status: 'delivery_unknown' });
    expect(printer.status()).toBe('offline');

    probeCallback(
      null,
      'printer TLP4 is idle. enabled since Thursday\nTLP4 accepting requests since Thursday',
      '',
    );
    await expect(probe).resolves.toBe('ready');
    expect(printer.status()).toBe('offline');
  });

  it('does not let an offline probe started during printing overwrite a successful print', async () => {
    let probeCallback: (...args: unknown[]) => void = () => undefined;
    let printCallback: (...args: unknown[]) => void = () => undefined;
    (childProcess.execFile as unknown as jest.Mock).mockImplementation(
      (
        executable: string,
        _args: string[],
        _options: unknown,
        callback: (...args: unknown[]) => void,
      ) => {
        if (executable === '/usr/bin/lpstat') probeCallback = callback;
        else printCallback = callback;
      },
    );
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    const print = printer.print(PALLET_PAYLOAD);
    const probe = printer.probe();
    printCallback(null, 'request id is TLP4-1', '');
    await expect(print).resolves.toMatchObject({ ok: true, status: 'submitted' });
    expect(printer.status()).toBe('ready');

    probeCallback(new Error('lpstat timed out'), '', '');
    await expect(probe).resolves.toBe('offline');
    expect(printer.status()).toBe('ready');
  });

  it('bounds startup cleanup to 256 directory reads and 32 deletions', () => {
    let index = 0;
    const readSync = jest.fn(() => {
      const current = index++;
      return {
        name:
          current % 8 === 7
            ? `label-00000000-0000-4000-8000-${String(current).padStart(12, '0')}.zpl`
            : `unrelated-${current}.txt`,
      };
    });
    const closeSync = jest.fn();
    (fs.opendirSync as unknown as jest.Mock).mockReturnValue({ readSync, closeSync });
    (fs.lstatSync as unknown as jest.Mock).mockReturnValue({
      isFile: () => true,
      mtimeMs: 0,
    });

    new CupsZplPrinter('TLP4', '/labels', PROFILE);

    expect(readSync).toHaveBeenCalledTimes(256);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(32);
    expect(closeSync).toHaveBeenCalledTimes(1);
  });

  it('closes the startup cleanup directory when iteration fails', () => {
    const closeSync = jest.fn();
    (fs.opendirSync as unknown as jest.Mock).mockReturnValue({
      readSync: jest.fn(() => {
        throw new Error('directory read failed');
      }),
      closeSync,
    });

    expect(() => new CupsZplPrinter('TLP4', '/labels', PROFILE)).not.toThrow();
    expect(closeSync).toHaveBeenCalledTimes(1);
  });

  it('removes a partially-created label when the exclusive write fails', async () => {
    (fs.writeFileSync as unknown as jest.Mock).mockImplementationOnce(() => {
      throw new Error('disk write failed');
    });
    const printer = new CupsZplPrinter('TLP4', '/labels', PROFILE);

    await expect(printer.print(PALLET_PAYLOAD)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
    });
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/\.zpl$/u));
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('makes the simulator validate the full payload before reporting success', async () => {
    const printer = new SimulatedPrinter(PROFILE);
    const invalid = { ...PALLET_PAYLOAD, copies: 2 } as unknown as PalletLabelPrinterPayload;

    await expect(printer.print(invalid)).resolves.toMatchObject({ ok: false });
  });

  it('does not write a roll/document reference into operational logs', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const printer = new SimulatedPrinter(PROFILE);

    try {
      await printer.print(PALLET_PAYLOAD);
      const output = write.mock.calls.map(([line]) => String(line)).join('');
      expect(output).not.toContain(PALLET_PAYLOAD.documentId);
      expect(output).toContain('simulated label printed');
    } finally {
      write.mockRestore();
    }
  });
});
