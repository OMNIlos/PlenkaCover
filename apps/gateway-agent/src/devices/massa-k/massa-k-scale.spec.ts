import { Protocol100FrameError, type DecodedProtocol100Frame } from './protocol-100-frame';
import { MassaKProtocol100Scale } from './massa-k-scale';
import { Protocol100TimeoutError, type Protocol100Exchange } from './serial-protocol-100-exchange';

const decoded = (bodyHex: string): DecodedProtocol100Frame => {
  const body = Buffer.from(bodyHex, 'hex');
  return { body, raw: Buffer.from(body) };
};

const decodedBody = (body: Buffer): DecodedProtocol100Frame => ({
  body,
  raw: Buffer.from(body),
});

const singleByteWire = (value: string): Buffer => Buffer.from(value, 'latin1');
const KG_WIRE = Buffer.from([0xea, 0xe3]);
const G_WIRE = Buffer.from([0xe3]);

function nameReply(scaleId = -12345, name = 'Line A / 01'): DecodedProtocol100Frame {
  const id = Buffer.alloc(4);
  id.writeInt32LE(scaleId);
  return decodedBody(Buffer.concat([Buffer.from([0x21]), id, singleByteWire(`${name}\r\n`)]));
}

function officialParametersReply(): DecodedProtocol100Frame {
  const fields = [
    Buffer.concat([Buffer.from('Max 6/15 '), KG_WIRE]),
    Buffer.concat([Buffer.from('Min 0,04 '), KG_WIRE]),
    Buffer.concat([Buffer.from('e = 2/5 '), G_WIRE]),
    Buffer.concat([Buffer.from('T = - 6 '), KG_WIRE]),
    Buffer.from('Fix = 0'),
    Buffer.from('Code = 012345'),
    Buffer.from('V3'),
    Buffer.from('F855CE01'),
  ];
  return decodedBody(
    Buffer.concat([
      Buffer.from([0x76]),
      ...fields.map((field) => Buffer.concat([field, Buffer.from('\r\n')])),
    ]),
  );
}

class FakeExchange implements Protocol100Exchange {
  readonly commands: number[] = [];
  closed = false;

  constructor(private readonly replies: Array<DecodedProtocol100Frame | Error>) {}

  async request(command: number): Promise<DecodedProtocol100Frame> {
    this.commands.push(command);
    const next = this.replies.shift();
    if (!next) throw new Error('fake response queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('MassaKProtocol100Scale', () => {
  it('returns a stable gross reading when NET is off', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([decoded('24f410000002010000')]),
      1_500,
    );
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'ready',
      stable: true,
      grossKg: 43.4,
      netKg: 43.4,
      tareKg: null,
      divisionKg: 0.01,
      net: false,
    });
  });

  it('does not add a transmitted tare when the NET flag is off', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([decoded('24f410000002010000c8000000')]),
      1_500,
    );
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'ready',
      grossKg: 43.4,
      netKg: 43.4,
      tareKg: 2,
      net: false,
    });
  });

  it('calculates gross as net plus tare when NET is on', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([decoded('242c10000002010100c8000000')]),
      1_500,
    );
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'ready',
      grossKg: 43.4,
      netKg: 41.4,
      tareKg: 2,
      net: true,
    });
  });

  it('never marks an unstable flag as ready', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([decoded('24f410000002000000')]),
      1_500,
    );
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'unstable',
      stable: false,
      grossKg: 43.4,
    });
  });

  it('maps module-unreachable to offline with zero non-authoritative weight', async () => {
    const scale = new MassaKProtocol100Scale(new FakeExchange([decoded('2817')]), 1_500);
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'offline',
      stable: false,
      grossKg: 0,
      errorCode: 'weighing_module_unreachable',
    });
  });

  it('keeps non-offline device errors unstable with zero non-authoritative weight', async () => {
    const scale = new MassaKProtocol100Scale(new FakeExchange([decoded('2808')]), 1_500);
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'unstable',
      stable: false,
      grossKg: 0,
      errorCode: 'overload',
    });
  });

  it('maps malformed/CRC exchange failure to unstable, not ready', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([new Protocol100FrameError('crc', 'bad CRC')]),
      1_500,
    );
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'unstable',
      stable: false,
      grossKg: 0,
      errorCode: 'protocol_crc',
    });
  });

  it('maps a malformed response body to unstable, not ready', async () => {
    const scale = new MassaKProtocol100Scale(new FakeExchange([decoded('24')]), 1_500);
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'unstable',
      stable: false,
      grossKg: 0,
      errorCode: 'protocol_length',
    });
  });

  it('maps an unexpected non-mass response to unstable', async () => {
    const scale = new MassaKProtocol100Scale(new FakeExchange([decoded('f0')]), 1_500);
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'unstable',
      stable: false,
      grossKg: 0,
      errorCode: 'unexpected_nack',
    });
  });

  it('maps a timeout to offline with zero non-authoritative weight', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([new Protocol100TimeoutError(1_500)]),
      1_500,
    );
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'offline',
      stable: false,
      grossKg: 0,
      errorCode: 'timeout',
    });
    expect(scale.status()).toBe('offline');
  });

  it('categorizes transport errors without leaking a local serial path', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([new Error('open /dev/serial/by-id/private-device: permission denied')]),
      1_500,
    );
    const reading = await scale.read('roll');
    expect(reading).toMatchObject({
      status: 'offline',
      stable: false,
      grossKg: 0,
      errorCode: 'transport_unavailable',
    });
    expect(JSON.stringify(reading)).not.toContain('/dev/serial');
  });

  it('rejects a negative gross as invalid and non-authoritative', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([decoded('240cefffff02010000')]),
      1_500,
    );
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'unstable',
      stable: false,
      grossKg: 0,
      errorCode: 'invalid_gross_weight',
    });
  });

  it('rejects a NET reading without tare as non-authoritative', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([decoded('242c10000002010100')]),
      1_500,
    );
    await expect(scale.read('roll')).resolves.toMatchObject({
      status: 'unstable',
      stable: false,
      grossKg: 0,
      errorCode: 'net_without_tare',
    });
  });

  it('bounds the raw frame retained for admin diagnostics', async () => {
    const frame = decoded('24f410000002010000');
    frame.raw = Buffer.alloc(1_024, 0xaa);
    const scale = new MassaKProtocol100Scale(new FakeExchange([frame]), 1_500);
    const reading = await scale.read('roll');
    expect(reading.raw).toHaveLength(512);
  });

  it('probes identity and tolerates optional scale-parameters NACK', async () => {
    const exchange = new FakeExchange([nameReply(), decoded('f0')]);
    const scale = new MassaKProtocol100Scale(exchange, 1_500);
    await expect(scale.probe()).resolves.toEqual({
      ok: true,
      status: 'ready',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      identity: { manufacturer: 'MASSA-K', scaleId: -12345, name: 'Line A / 01' },
    });
    expect(exchange.commands).toEqual([0x20, 0x75]);
  });

  it('returns safe scale parameters when the optional command is supported', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([nameReply(), officialParametersReply()]),
      1_500,
    );
    await expect(scale.probe()).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      identity: { manufacturer: 'MASSA-K', scaleId: -12345, name: 'Line A / 01' },
      parameters: {
        maximum: 'Max 6/15 êã',
        minimum: 'Min 0,04 êã',
        verificationInterval: 'e = 2/5 ã',
        maximumTare: 'T = - 6 êã',
        fixation: 'Fix = 0',
        calibrationCode: 'Code = 012345',
        softwareVersion: 'V3',
        softwareChecksum: 'F855CE01',
      },
    });
  });

  it('does not tolerate a device error from the optional parameters request', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([nameReply(), decoded('2817')]),
      1_500,
    );
    await expect(scale.probe()).resolves.toMatchObject({
      ok: false,
      status: 'offline',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      error: 'weighing_module_unreachable',
    });
  });

  it('does not identify a device when the name request returns a device error', async () => {
    const scale = new MassaKProtocol100Scale(new FakeExchange([decoded('2817')]), 1_500);
    await expect(scale.probe()).resolves.toEqual({
      ok: false,
      status: 'offline',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      error: 'weighing_module_unreachable',
    });
  });

  it('categorizes a parameters timeout and never leaks identity or a serial path', async () => {
    const scale = new MassaKProtocol100Scale(
      new FakeExchange([nameReply(), new Protocol100TimeoutError(1_500)]),
      1_500,
    );
    const probe = await scale.probe();
    expect(probe).toEqual({
      ok: false,
      status: 'offline',
      protocol: 'massa-k-protocol-100',
      simulated: false,
      error: 'timeout',
    });
    expect(probe).not.toHaveProperty('identity');
  });

  it('closes the underlying exchange', async () => {
    const exchange = new FakeExchange([]);
    const scale = new MassaKProtocol100Scale(exchange, 1_500);
    await scale.close();
    expect(exchange.closed).toBe(true);
  });
});
