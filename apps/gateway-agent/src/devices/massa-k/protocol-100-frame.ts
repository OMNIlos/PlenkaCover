export const PROTOCOL_100_HEADER = Buffer.from([0xf8, 0x55, 0xce]);
export const PROTOCOL_100_MAX_BODY_BYTES = 512;

export const PROTOCOL_100_COMMAND = {
  getName: 0x20,
  ackName: 0x21,
  getMass: 0x23,
  ackMass: 0x24,
  error: 0x28,
  getScaleParameters: 0x75,
  ackScaleParameters: 0x76,
  nack: 0xf0,
} as const;

export interface DecodedProtocol100Frame {
  body: Buffer;
  raw: Buffer;
}

export class Protocol100FrameError extends Error {
  constructor(
    readonly reason: 'header' | 'length' | 'size' | 'crc',
    message: string,
  ) {
    super(message);
    this.name = 'Protocol100FrameError';
  }
}

export function crc16Ccitt(body: Buffer): number {
  let crc = 0xffff;
  for (const byte of body) {
    for (let mask = 0x80; mask !== 0; mask >>= 1) {
      const highBit = (crc & 0x8000) !== 0;
      crc = (crc << 1) & 0xffff;
      if ((byte & mask) !== 0) crc |= 1;
      if (highBit) crc ^= 0x1021;
    }
  }
  for (let bit = 0; bit < 16; bit += 1) {
    const highBit = (crc & 0x8000) !== 0;
    crc = (crc << 1) & 0xffff;
    if (highBit) crc ^= 0x1021;
  }
  return crc;
}

/** CRC variant published in MASSA-K's PC connection guide and emitted by the pilot terminal. */
function massaKWireCrc(body: Buffer): number {
  let crc = 0;
  for (const byte of body) {
    let remainder = 0;
    let highByte = crc & 0xff00;
    for (let bit = 0; bit < 8; bit += 1) {
      remainder =
        (highByte ^ remainder) & 0x8000
          ? ((remainder << 1) ^ 0x1021) & 0xffff
          : (remainder << 1) & 0xffff;
      highByte = (highByte << 1) & 0xffff;
    }
    crc = (remainder ^ ((crc << 8) & 0xffff) ^ byte) & 0xffff;
  }
  return crc;
}

export function encodeProtocol100Command(command: number): Buffer {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw new Protocol100FrameError('length', 'command must be one byte');
  }
  const body = Buffer.from([command]);
  const frame = Buffer.alloc(PROTOCOL_100_HEADER.length + 2 + body.length + 2);
  PROTOCOL_100_HEADER.copy(frame, 0);
  frame.writeUInt16LE(body.length, 3);
  body.copy(frame, 5);
  frame.writeUInt16LE(massaKWireCrc(body), 5 + body.length);
  return frame;
}

export function decodeProtocol100Frame(frame: Buffer): DecodedProtocol100Frame {
  if (frame.length < 8) {
    throw new Protocol100FrameError('size', 'frame size is below the minimum');
  }
  if (!frame.subarray(0, 3).equals(PROTOCOL_100_HEADER)) {
    throw new Protocol100FrameError('header', 'invalid Protocol 100 header');
  }
  const bodyLength = frame.readUInt16LE(3);
  if (bodyLength < 1 || bodyLength > PROTOCOL_100_MAX_BODY_BYTES) {
    throw new Protocol100FrameError('length', `invalid body length ${bodyLength}`);
  }
  const expectedSize = 3 + 2 + bodyLength + 2;
  if (frame.length !== expectedSize) {
    throw new Protocol100FrameError(
      'size',
      `frame size ${frame.length} does not match ${expectedSize}`,
    );
  }
  const body = Buffer.from(frame.subarray(5, 5 + bodyLength));
  const expectedCrc = frame.readUInt16LE(5 + bodyLength);
  const wireCrc = massaKWireCrc(body);
  const specificationCrc = crc16Ccitt(body);
  if (wireCrc !== expectedCrc && specificationCrc !== expectedCrc) {
    throw new Protocol100FrameError(
      'crc',
      `crc mismatch: expected ${expectedCrc.toString(16)}, got ${wireCrc.toString(16)}`,
    );
  }
  return { body, raw: Buffer.from(frame) };
}
