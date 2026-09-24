import { LoginRateLimiter, type LoginRateLimiterOptions } from './login-rate-limiter';

describe('LoginRateLimiter', () => {
  it('allows up to the limit within the window, then blocks', () => {
    const now = { t: 1_000 };
    const limiter = new LoginRateLimiter({ max: 3, windowMs: 60_000, clock: () => now.t });
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(false); // 4th within window
  });

  it('tracks keys independently', () => {
    const limiter = new LoginRateLimiter({ max: 1, windowMs: 60_000, clock: () => 0 });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(true);
  });

  it('resets after the window elapses', () => {
    const now = { t: 0 };
    const limiter = new LoginRateLimiter({ max: 1, windowMs: 1_000, clock: () => now.t });
    expect(limiter.check('ip')).toBe(true);
    expect(limiter.check('ip')).toBe(false);
    now.t = 1_500; // window passed
    expect(limiter.check('ip')).toBe(true);
  });

  it('fails closed at the hard key bound under rotating IPv6 clients', () => {
    const limiter = new LoginRateLimiter({
      max: 1,
      windowMs: 60_000,
      maxKeys: 2,
      clock: () => 0,
    } as LoginRateLimiterOptions & { maxKeys: number });

    expect(limiter.check('2001:db8::1')).toBe(true);
    expect(limiter.check('2001:db8::2')).toBe(true);
    expect(limiter.check('2001:db8::3')).toBe(false);
    expect((limiter as unknown as { hits: Map<string, number[]> }).hits.size).toBe(2);
    expect(limiter.check('2001:db8::1')).toBe(false);
  });

  it('evicts expired keys when a different client arrives', () => {
    const now = { t: 0 };
    const limiter = new LoginRateLimiter({
      max: 1,
      windowMs: 1_000,
      maxKeys: 2,
      clock: () => now.t,
    } as LoginRateLimiterOptions & { maxKeys: number });
    limiter.check('2001:db8::1');
    limiter.check('2001:db8::2');

    now.t = 1_001;
    expect(limiter.check('2001:db8::3')).toBe(true);
    expect([
      ...(limiter as unknown as { hits: Map<string, number[]> }).hits.keys(),
    ]).toEqual(['2001:db8::3']);
  });

  it('keeps still-active keys while sweeping an expired prefix', () => {
    const now = { t: 0 };
    const limiter = new LoginRateLimiter({
      max: 1,
      windowMs: 1_000,
      maxKeys: 2,
      clock: () => now.t,
    } as LoginRateLimiterOptions & { maxKeys: number });
    limiter.check('old');
    now.t = 500;
    limiter.check('active');

    now.t = 1_001;
    expect(limiter.check('new')).toBe(true);
    expect([
      ...(limiter as unknown as { hits: Map<string, number[]> }).hits.keys(),
    ]).toEqual(['active', 'new']);
  });
});
