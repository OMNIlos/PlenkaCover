import { computeStaleness } from './staleness';

const base = {
  storedVersion: 'v1',
  upstreamVersion: 'v1',
  lastCheckedAt: new Date('2026-07-02T10:00:00Z'),
  now: new Date('2026-07-02T10:00:30Z'),
  ttlMs: 60_000,
  lastFetchFailed: false,
};

describe('computeStaleness (ТЗ §8 / S6 D5)', () => {
  it('unknown when never fetched', () => {
    expect(computeStaleness({ ...base, lastCheckedAt: null })).toBe('unknown');
  });

  it('fresh right after a good GET (versions equal, within TTL)', () => {
    expect(computeStaleness(base)).toBe('fresh');
  });

  it('stale when the upstream sourceVersion changed', () => {
    expect(computeStaleness({ ...base, upstreamVersion: 'v2' })).toBe('stale');
  });

  it('stale when the TTL elapsed', () => {
    expect(computeStaleness({ ...base, now: new Date('2026-07-02T10:05:00Z') })).toBe('stale');
  });

  it('stale when the last fetch failed', () => {
    expect(computeStaleness({ ...base, lastFetchFailed: true })).toBe('stale');
  });
});
