export interface LoginRateLimiterOptions {
  max: number;
  maxKeys?: number;
  windowMs: number;
  clock?: () => number;
}

/**
 * In-memory sliding-window rate limiter for the login route (V2 S7 hardening).
 * Single-instance only — a multi-node deployment should back this with Redis.
 * Kept as a pure, injectable unit so it is trivially testable.
 */
export class LoginRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly maxKeys: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(opts: LoginRateLimiterOptions) {
    this.max = opts.max;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.windowMs = opts.windowMs;
    this.clock = opts.clock ?? Date.now;
    if (!Number.isInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new RangeError('LoginRateLimiter maxKeys must be a positive integer');
    }
  }

  private evictExpired(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const latest = timestamps[timestamps.length - 1];
      if (latest !== undefined && latest > cutoff) break;
      this.hits.delete(key);
    }
  }

  /** Returns true if the attempt is allowed, false if the key is over the limit. */
  check(key: string): boolean {
    const now = this.clock();
    this.evictExpired(now);
    const cutoff = now - this.windowMs;
    const existing = this.hits.get(key);
    if (!existing && this.hits.size >= this.maxKeys) return false;

    const recent = (existing ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    if (existing) this.hits.delete(key);
    this.hits.set(key, recent);
    return true;
  }
}
