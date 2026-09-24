import { MockScannerAdapter } from './mock-scanner.adapter';

describe('MockScannerAdapter', () => {
  const scanner = new MockScannerAdapter();
  const token = `prt_${'a'.repeat(64)}`;

  it('accepts only the exact opaque pilot token bytes', () => {
    expect(scanner.parse(token)).toEqual({ token, valid: true });
  });

  it.each([
    'QR-A-1024-roll-1',
    '{"v":1,"roll":"A-1024-roll-1"}',
    '....',
    '',
    ` ${token}`,
    `${token} `,
    `${token}\r`,
    `${token}\n`,
    `prt_${'A'.repeat(64)}`,
    `prt_${'a'.repeat(63)}`,
    `prt_${'a'.repeat(65)}`,
    token.replace('p', '%70'),
  ])('rejects legacy, normalized or malformed payload %j', (payload) => {
    expect(scanner.parse(payload)).toEqual({ token: null, valid: false });
  });
});
