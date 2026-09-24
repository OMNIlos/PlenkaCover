import { hashPassword, verifyLoginPassword, verifyPassword } from './password';

describe('password (scrypt)', () => {
  it('hashes to a non-plaintext scrypt-tagged string', () => {
    const hash = hashPassword('secret-1');
    expect(hash).not.toBe('secret-1');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('verifies the correct password', () => {
    const hash = hashPassword('secret-1');
    expect(verifyPassword('secret-1', hash)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const hash = hashPassword('secret-1');
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('uses a random salt — same password hashes differently each time', () => {
    expect(hashPassword('secret-1')).not.toBe(hashPassword('secret-1'));
  });

  it('returns false (not throw) on a malformed stored hash', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'scrypt$only$three')).toBe(false);
  });

  it.each([
    undefined,
    null,
    '',
    'garbage',
    'legacy$sha256$digest',
    'scrypt$only$three',
    'scrypt$016384$8$1$c2FsdC1ieXRlcy0xMjM0NQ==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'scrypt$16384$8$1$YQ==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ])(
    'uses one fixed valid dummy KDF input for an unusable login hash (%s)',
    (stored) => {
      const verifier = jest.fn().mockReturnValue(false);
      const dummyVerifier = jest.fn().mockReturnValue(false);
      verifyLoginPassword('candidate', undefined, dummyVerifier);
      expect(verifyLoginPassword('candidate', stored, verifier)).toBe(false);
      expect(verifier).toHaveBeenCalledTimes(1);
      expect(verifier.mock.calls[0][1]).toBe(dummyVerifier.mock.calls[0][1]);
    },
  );

  it('reuses the same dummy hash and passes a valid stored hash through unchanged', () => {
    const verifier = jest.fn().mockReturnValue(false);
    expect(verifyLoginPassword('candidate-1', undefined, verifier)).toBe(false);
    expect(verifyLoginPassword('candidate-2', 'legacy$hash', verifier)).toBe(false);
    const valid = hashPassword('candidate-3');
    expect(verifyLoginPassword('candidate-3', valid, verifier)).toBe(false);
    expect(verifier.mock.calls[1][1]).toBe(verifier.mock.calls[0][1]);
    expect(verifier.mock.calls[2][1]).toBe(valid);
  });

  it.each([undefined, null, '', 'legacy$hash', 'scrypt$only$three'])(
    'never authenticates an unusable stored hash even when the dummy verifier returns true (%s)',
    (stored) => {
      const verifier = jest.fn().mockReturnValue(true);

      expect(verifyLoginPassword('dummy-preimage', stored, verifier)).toBe(false);
      expect(verifier).toHaveBeenCalledTimes(1);
    },
  );

  it('returns the verifier result only for a supported stored hash', () => {
    const stored = hashPassword('candidate');
    const verifier = jest.fn().mockReturnValue(true);

    expect(verifyLoginPassword('candidate', stored, verifier)).toBe(true);
    expect(verifier).toHaveBeenCalledWith('candidate', stored);
  });
});
