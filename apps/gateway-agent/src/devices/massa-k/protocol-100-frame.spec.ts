import { crc16Ccitt, decodeProtocol100Frame, encodeProtocol100Command } from './protocol-100-frame';

describe('Protocol 100 CRC-16-CCITT', () => {
  it.each([
    [Buffer.alloc(0), 0x1d0f],
    [Buffer.from('A', 'ascii'), 0x9479],
    [Buffer.from('123456789', 'ascii'), 0xe5cc],
    [Buffer.from([0x23]), 0xd89d],
  ])('matches independent reference vector %p → %i', (body, expected) => {
    expect(crc16Ccitt(body)).toBe(expected);
  });
});

describe('Protocol 100 frame envelope', () => {
  it('encodes CMD_GET_MASSA with the checksum used by the physical MASSA-K terminal', () => {
    expect(encodeProtocol100Command(0x23).toString('hex')).toBe('f855ce0100232300');
  });

  it('decodes a fixed ACK_MASSA frame and preserves raw bytes', () => {
    const raw = Buffer.from('f855ce090024f410000002010000df40', 'hex');
    expect(decodeProtocol100Frame(raw)).toEqual({
      body: Buffer.from('24f410000002010000', 'hex'),
      raw,
    });
  });

  it('decodes the exact 4800/even ACK_MASSA frame observed on the pilot terminal', () => {
    const raw = Buffer.from('f855ce0d00240000000002010001000000001ced', 'hex');
    expect(decodeProtocol100Frame(raw)).toEqual({
      body: Buffer.from('24000000000201000100000000', 'hex'),
      raw,
    });
  });

  it.each([
    ['0055ce0100239dd8', 'header'],
    ['f855ce0000000000', 'length'],
    ['f855ce090024f410000002010000df41', 'crc'],
    ['f855ce090024f410000002010000', 'size'],
  ])('rejects malformed frame %s with reason %s', (hex, reason) => {
    expect(() => decodeProtocol100Frame(Buffer.from(hex, 'hex'))).toThrow(reason);
  });
});
