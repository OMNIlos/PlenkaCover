import { extractBearerToken } from './bearer';

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header (scheme case-insensitive)', () => {
    expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(extractBearerToken('bearer abc.def')).toBe('abc.def');
  });

  it('returns null for missing, empty, or non-Bearer headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('abc')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
    expect(extractBearerToken('Basic xyz')).toBeNull();
  });
});
