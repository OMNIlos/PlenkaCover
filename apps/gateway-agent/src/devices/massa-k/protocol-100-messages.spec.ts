import {
  decodeProtocol100Frame,
  PROTOCOL_100_COMMAND,
  Protocol100FrameError,
} from './protocol-100-frame';
import { parseProtocol100Response } from './protocol-100-messages';

const parseHex = (hex: string) =>
  parseProtocol100Response(decodeProtocol100Frame(Buffer.from(hex, 'hex')));

const parseBody = (body: Buffer) => parseProtocol100Response({ body, raw: Buffer.from(body) });
const CRLF = Buffer.from('\r\n', 'ascii');

const singleByteWire = (value: string): Buffer => Buffer.from(value, 'latin1');

// Explicit single-byte high values keep the fixture honest. They spell the manual's
// examples in CP1251, but the parser deliberately returns latin1 and does not assert a charset.
const KG_WIRE = Buffer.from([0xea, 0xe3]);
const G_WIRE = Buffer.from([0xe3]);
const OFFICIAL_PARAMETER_EXAMPLES = [
  { manual: 'Max 6/15 кг', wire: Buffer.concat([Buffer.from('Max 6/15 '), KG_WIRE]) },
  { manual: 'Min 0,04 кг', wire: Buffer.concat([Buffer.from('Min 0,04 '), KG_WIRE]) },
  { manual: 'e = 2/5 г', wire: Buffer.concat([Buffer.from('e = 2/5 '), G_WIRE]) },
  { manual: 'T = - 6 кг', wire: Buffer.concat([Buffer.from('T = - 6 '), KG_WIRE]) },
  { manual: 'Fix = 0', wire: Buffer.from('Fix = 0') },
  { manual: 'Code = 012345', wire: Buffer.from('Code = 012345') },
  { manual: 'V3', wire: Buffer.from('V3') },
  { manual: 'F855CE01', wire: Buffer.from('F855CE01') },
] as const;

function nameBody(scaleId: number, name: Buffer): Buffer {
  const id = Buffer.alloc(4);
  id.writeInt32LE(scaleId);
  return Buffer.concat([Buffer.from([PROTOCOL_100_COMMAND.ackName]), id, name, CRLF]);
}

function parametersBody(fields: readonly Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([PROTOCOL_100_COMMAND.ackScaleParameters]),
    ...fields.map((field) => Buffer.concat([field, CRLF])),
  ]);
}

function massBody({
  weight,
  division,
  stable = 1,
  net = 0,
  zero = 0,
  tare,
}: {
  weight: number;
  division: number;
  stable?: number;
  net?: number;
  zero?: number;
  tare?: number;
}): Buffer {
  const body = Buffer.alloc(tare === undefined ? 9 : 13);
  body[0] = PROTOCOL_100_COMMAND.ackMass;
  body.writeInt32LE(weight, 1);
  body[5] = division;
  body[6] = stable;
  body[7] = net;
  body[8] = zero;
  if (tare !== undefined) body.writeInt32LE(tare, 9);
  return body;
}

function expectLengthError(body: Buffer, message: string): void {
  try {
    parseBody(body);
  } catch (error) {
    expect(error).toBeInstanceOf(Protocol100FrameError);
    expect(error).toMatchObject({ reason: 'length' });
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error('Expected Protocol100FrameError');
}

describe('Protocol 100 response parser', () => {
  it('normalizes a stable 43.40 kg reading without tare', () => {
    expect(parseHex('f855ce090024f410000002010000df40')).toEqual({
      kind: 'mass',
      weightKg: 43.4,
      divisionKg: 0.01,
      stable: true,
      net: false,
      zero: false,
      tareKg: null,
    });
  });

  it('normalizes net 41.40 kg plus 2.00 kg tare', () => {
    expect(parseHex('f855ce0d00242c10000002010100c8000000e70f')).toEqual({
      kind: 'mass',
      weightKg: 41.4,
      divisionKg: 0.01,
      stable: true,
      net: true,
      zero: false,
      tareKg: 2,
    });
  });

  it('decodes a negative signed little-endian weight', () => {
    expect(parseBody(massBody({ weight: -4340, division: 2 }))).toEqual({
      kind: 'mass',
      weightKg: -43.4,
      divisionKg: 0.01,
      stable: true,
      net: false,
      zero: false,
      tareKg: null,
    });
  });

  it('decodes a negative signed little-endian tare', () => {
    expect(parseBody(massBody({ weight: 4140, division: 2, net: 1, tare: -200 }))).toEqual({
      kind: 'mass',
      weightKg: 41.4,
      divisionKg: 0.01,
      stable: true,
      net: true,
      zero: false,
      tareKg: -2,
    });
  });

  it.each([
    [0, 0.0001, 12345, 1.2345],
    [1, 0.001, 1234, 1.234],
    [3, 0.1, 123, 12.3],
    [4, 1, 12, 12],
  ])('normalizes division code %i at %d kg per unit', (division, divisionKg, units, weightKg) => {
    expect(parseBody(massBody({ weight: units, division }))).toEqual({
      kind: 'mass',
      weightKg,
      divisionKg,
      stable: true,
      net: false,
      zero: false,
      tareKg: null,
    });
  });

  it('parses a user-defined scale name and signed ScalesID', () => {
    expect(parseBody(nameBody(-12345, singleByteWire('Line A / 01')))).toEqual({
      kind: 'name',
      scaleId: -12345,
      name: 'Line A / 01',
    });
  });

  it('treats ACK_NAME byte limits as including the terminal CRLF', () => {
    expect(parseBody(nameBody(-0x80000000, Buffer.alloc(25, 0xff)))).toEqual({
      kind: 'name',
      scaleId: -0x80000000,
      name: Buffer.alloc(25, 0xff).toString('latin1'),
    });
    expect(parseBody(nameBody(0, Buffer.alloc(0)))).toEqual({
      kind: 'name',
      scaleId: 0,
      name: '',
    });
    expectLengthError(nameBody(0, Buffer.alloc(26, 0x41)), '2..27');
  });

  it.each([
    ['an embedded CRLF', Buffer.from('Line\r\nA', 'latin1')],
    ['an ASCII tab', Buffer.from('Line\tA', 'latin1')],
    ['ASCII DEL', Buffer.from([0x41, 0x7f])],
    ['a C1 control byte', Buffer.from([0x41, 0x80])],
  ])('rejects ACK_NAME with %s', (_case, name) => {
    expectLengthError(nameBody(1, name), 'control');
  });

  it.each([
    ['f855ce02002808878a', { kind: 'device_error', code: 0x08, message: 'overload' }],
    ['f855ce0100f08323', { kind: 'nack' }],
  ])('parses error response %s', (hex, expected) => {
    expect(parseHex(hex)).toEqual(expected);
  });

  it.each([
    [Buffer.from('24f410000005010000', 'hex'), 'division'],
    [Buffer.from('24f410000002020000', 'hex'), 'stable'],
    [Buffer.from('24f4100000020100', 'hex'), 'length'],
  ])('rejects invalid mass body %s', (body, message) => {
    expectLengthError(body, message);
  });

  it('parses the eight official examples without guessing their single-byte encoding', () => {
    const body = parametersBody(OFFICIAL_PARAMETER_EXAMPLES.map(({ wire }) => wire));

    expect(parseProtocol100Response({ body, raw: Buffer.from(body) })).toEqual({
      kind: 'scale_parameters',
      maximum: OFFICIAL_PARAMETER_EXAMPLES[0].wire.toString('latin1'),
      minimum: OFFICIAL_PARAMETER_EXAMPLES[1].wire.toString('latin1'),
      verificationInterval: OFFICIAL_PARAMETER_EXAMPLES[2].wire.toString('latin1'),
      maximumTare: OFFICIAL_PARAMETER_EXAMPLES[3].wire.toString('latin1'),
      fixation: 'Fix = 0',
      calibrationCode: 'Code = 012345',
      softwareVersion: 'V3',
      softwareChecksum: 'F855CE01',
    });
  });

  it('parses the exact parameter frame returned by the pilot terminal firmware', () => {
    expect(
      parseHex(
        'f855ce5800764d61783d3135302f333030206b670d0a4d696e3d31206b670d0a653d35302f31303020670d0a543d2d313530206b670d0a4669783d300d0a436f64653d3633343038390d0a552033382e312e360d0a3137463337390d0a5bc5',
      ),
    ).toEqual({
      kind: 'scale_parameters',
      maximum: 'Max=150/300 kg',
      minimum: 'Min=1 kg',
      verificationInterval: 'e=50/100 g',
      maximumTare: 'T=-150 kg',
      fixation: 'Fix=0',
      calibrationCode: 'Code=634089',
      softwareVersion: 'U 38.1.6',
      softwareChecksum: '17F379',
    });
  });

  it.each([
    ['P_Max below minimum', 0, 1],
    ['P_Max above maximum', 0, 21],
    ['P_Min below minimum', 1, 1],
    ['P_Min above maximum', 1, 21],
    ['P_e below minimum', 2, 1],
    ['P_e above maximum', 2, 11],
    ['P_T below minimum', 3, 1],
    ['P_T above maximum', 3, 11],
    ['Fix below supported firmware length', 4, 4],
    ['Fix above supported firmware length', 4, 8],
    ['Calcode below supported firmware length', 5, 10],
    ['Calcode above compatibility length', 5, 14],
    ['PO_Ver below minimum', 6, 1],
    ['PO_Ver above maximum', 6, 10],
    ['PO_Summ below minimum', 7, 1],
    ['PO_Summ above maximum', 7, 9],
  ])('rejects %s by original content-byte length', (_case, fieldIndex, bytes) => {
    const fields = OFFICIAL_PARAMETER_EXAMPLES.map(({ wire }) => Buffer.from(wire));
    fields[fieldIndex] = Buffer.alloc(bytes, 0x41);

    expectLengthError(parametersBody(fields), 'byte length');
  });

  it.each([
    ['ASCII tab', Buffer.from('Max\t6', 'latin1')],
    ['ASCII DEL', Buffer.from([0x41, 0x7f])],
    ['a C1 control byte', Buffer.from([0x41, 0x80])],
  ])('rejects a scale-parameter field containing %s', (_case, unsafeField) => {
    const fields = OFFICIAL_PARAMETER_EXAMPLES.map(({ wire }) => Buffer.from(wire));
    fields[0] = unsafeField;

    expectLengthError(parametersBody(fields), 'control');
  });

  it.each([
    [Buffer.from('213930000054562d4d', 'hex'), 'CRLF'],
    [Buffer.from([0x76, ...Buffer.from('one\r\ntwo\r\n', 'latin1')]), 'eight fields'],
    [Buffer.from([0x28, 0x08, 0x09]), 'one or two'],
    [Buffer.from([0xf0, 0x00]), 'unexpected response command'],
  ])('rejects malformed response body %s', (body, message) => {
    expectLengthError(body, message);
  });

  it('rejects an empty body with a typed length error', () => {
    expectLengthError(Buffer.alloc(0), 'response body must not be empty');
  });

  it('rejects a truly unknown command with a typed length error', () => {
    expectLengthError(Buffer.from([0x99]), 'unexpected response command 0x99');
  });

  it.each([
    [
      'without a code',
      Buffer.from([PROTOCOL_100_COMMAND.error]),
      null,
      'device_error_without_code',
    ],
    [
      'with an unknown code',
      Buffer.from([PROTOCOL_100_COMMAND.error, 0x12]),
      0x12,
      'unknown_error',
    ],
  ])('types CMD_ERROR %s safely', (_case, body, code, message) => {
    expect(parseBody(body)).toEqual({ kind: 'device_error', code, message });
  });
});
