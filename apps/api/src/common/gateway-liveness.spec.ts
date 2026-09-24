import { gatewayConnectionState, gatewayHeartbeatIsFresh } from './gateway-liveness';

describe('gateway liveness is derived from heartbeat freshness', () => {
  const now = new Date('2026-07-17T10:00:00.000Z');

  beforeEach(() => {
    process.env.GATEWAY_STALE_AFTER_SEC = '90';
    process.env.GATEWAY_OFFLINE_AFTER_SEC = '300';
  });

  afterEach(() => {
    delete process.env.GATEWAY_STALE_AFTER_SEC;
    delete process.env.GATEWAY_OFFLINE_AFTER_SEC;
  });

  it('is online only while an online agent heartbeat is fresh', () => {
    const heartbeat = new Date('2026-07-17T09:59:00.000Z');
    expect(gatewayHeartbeatIsFresh(heartbeat, now)).toBe(true);
    expect(gatewayConnectionState('online', heartbeat, now)).toBe('online');
  });

  it('does not trust a stale persisted online flag', () => {
    expect(
      gatewayConnectionState('online', new Date('2026-07-17T09:58:00.000Z'), now),
    ).toBe('stale');
  });

  it('derives offline after the second server-time threshold', () => {
    expect(
      gatewayConnectionState('online', new Date('2026-07-17T09:54:59.999Z'), now),
    ).toBe('offline');
  });

  it('keeps never-seen posts unknown and respects an explicit offline state', () => {
    expect(gatewayConnectionState('offline', now, now)).toBe('offline');
    expect(gatewayConnectionState('online', null, now)).toBe('unknown');
    expect(gatewayConnectionState('unknown', null, now)).toBe('unknown');
  });
});
