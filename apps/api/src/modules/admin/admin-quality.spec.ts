import { calculateConnectionQuality } from './admin-quality';

describe('calculateConnectionQuality', () => {
  const now = new Date('2026-07-13T12:00:00.000Z');

  it('marks a recent heartbeat online and calculates success rate plus median latency', () => {
    const result = calculateConnectionQuality({
      lastSeenAt: new Date('2026-07-13T11:59:30.000Z'),
      thresholdSec: 60,
      now,
      checks: [
        { status: 'passed', latencyMs: 10 },
        { status: 'failed', latencyMs: 50 },
        { status: 'passed', latencyMs: 30 },
      ],
      openIncidentCount: 1,
    });

    expect(result).toMatchObject({
      state: 'online',
      totalChecks: 3,
      passedChecks: 2,
      failedChecks: 1,
      successRate: 66.67,
      medianLatencyMs: 30,
      openIncidentCount: 1,
    });
  });

  it('marks an old heartbeat stale and missing heartbeat unknown', () => {
    expect(
      calculateConnectionQuality({
        lastSeenAt: new Date('2026-07-13T11:00:00.000Z'),
        thresholdSec: 60,
        now,
        checks: [],
      }).state,
    ).toBe('stale');
    expect(
      calculateConnectionQuality({ lastSeenAt: null, thresholdSec: 60, now, checks: [] }).state,
    ).toBe('unknown');
  });

  it('returns null rates for an empty history', () => {
    const result = calculateConnectionQuality({
      lastSeenAt: now,
      thresholdSec: 60,
      now,
      checks: [],
    });
    expect(result.successRate).toBeNull();
    expect(result.medianLatencyMs).toBeNull();
  });
});
