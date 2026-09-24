import { requestFingerprint } from './request-fingerprint';

describe('requestFingerprint', () => {
  it('ignores object-key order but preserves semantic values and array order', () => {
    expect(requestFingerprint({ b: 2, a: { y: 1, x: 0 } })).toBe(
      requestFingerprint({ a: { x: 0, y: 1 }, b: 2 }),
    );
    expect(requestFingerprint({ items: ['a', 'b'] })).not.toBe(
      requestFingerprint({ items: ['b', 'a'] }),
    );
    expect(requestFingerprint({ value: null })).toMatch(/^[0-9a-f]{64}$/u);
  });
});
