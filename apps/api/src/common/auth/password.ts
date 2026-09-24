import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for V2 S1 identity. Uses Node's built-in `crypto.scrypt` — an
 * OWASP-acceptable password KDF with ZERO extra dependencies (nothing to compile,
 * nothing to break in CI). Stored format is self-describing so parameters can change
 * without invalidating existing hashes: `scrypt$N$r$p$<saltB64>$<hashB64>`.
 */
const N = 16384; // CPU/memory cost (2^14) — ~16 MiB, within scrypt's default maxmem
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_BYTES = 16;
const DUMMY_LOGIN_PASSWORD_HASH =
  'scrypt$16384$8$1$cGxlbmthLWxvZ2luLWR1bW15LXYx$GQczE3ogqstbf2bwOVrkQBYDyU8RTCykHjDwkM5WMk8=';

type PasswordVerifier = (password: string, stored: string) => boolean;

interface ParsedPasswordHash {
  expected: Buffer;
  n: number;
  p: number;
  r: number;
  salt: Buffer;
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 &&
    decoded.toString('base64').replace(/=+$/u, '') === value.replace(/=+$/u, '')
    ? decoded
    : null;
}

function parseSupportedPasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = decodeCanonicalBase64(saltB64);
  const expected = decodeCanonicalBase64(hashB64);
  if (
    nStr !== String(N) ||
    rStr !== String(R) ||
    pStr !== String(P) ||
    n !== N ||
    r !== R ||
    p !== P ||
    !salt ||
    salt.length < SALT_BYTES ||
    !expected ||
    expected.length !== KEY_LEN
  ) {
    return null;
  }
  return { expected, n, p, r, salt };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseSupportedPasswordHash(stored);
  if (!parsed) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password, parsed.salt, parsed.expected.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    });
  } catch {
    return false;
  }
  return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
}

/** Always performs one password KDF, including for unknown and non-local accounts. */
export function verifyLoginPassword(
  password: string,
  stored: string | null | undefined,
  verifier: PasswordVerifier = verifyPassword,
): boolean {
  const supported = !!stored && parseSupportedPasswordHash(stored) !== null;
  const selected = supported ? stored : DUMMY_LOGIN_PASSWORD_HASH;
  const matches = verifier(password, selected);
  return supported && matches;
}
