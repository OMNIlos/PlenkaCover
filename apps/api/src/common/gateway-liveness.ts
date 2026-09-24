export function gatewayStaleAfterSec(): number {
  const configured = Number(process.env.GATEWAY_STALE_AFTER_SEC ?? 90);
  return Number.isFinite(configured) && configured > 0 ? configured : 90;
}

export function gatewayOfflineAfterSec(): number {
  const onlineThreshold = gatewayStaleAfterSec();
  const configured = Number(process.env.GATEWAY_OFFLINE_AFTER_SEC ?? 300);
  return Number.isFinite(configured) && configured > onlineThreshold
    ? configured
    : Math.max(300, onlineThreshold * 3);
}

export function gatewayHeartbeatIsFresh(lastSeenAt: Date | null, now = new Date()): boolean {
  return Boolean(
    lastSeenAt && now.getTime() - lastSeenAt.getTime() <= gatewayStaleAfterSec() * 1000,
  );
}

export type GatewayConnectionState = 'online' | 'stale' | 'offline' | 'unknown';

/** Stored agentStatus is only a hint; a dead agent cannot update it after losing power. */
export function gatewayConnectionState(
  agentStatus: string,
  lastSeenAt: Date | null,
  now = new Date(),
): GatewayConnectionState {
  if (!lastSeenAt) return agentStatus === 'offline' ? 'offline' : 'unknown';
  if (agentStatus === 'offline') return 'offline';
  const ageMs = Math.max(0, now.getTime() - lastSeenAt.getTime());
  if (ageMs <= gatewayStaleAfterSec() * 1000) return 'online';
  return ageMs <= gatewayOfflineAfterSec() * 1000 ? 'stale' : 'offline';
}
