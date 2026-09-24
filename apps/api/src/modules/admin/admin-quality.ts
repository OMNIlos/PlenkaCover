export interface ConnectionQualityInput {
  lastSeenAt: Date | null;
  thresholdSec: number;
  checks: Array<{ status: string; latencyMs: number | null }>;
  openIncidentCount?: number;
  now?: Date;
}

export function calculateConnectionQuality(input: ConnectionQualityInput) {
  const now = input.now ?? new Date();
  const ageSec = input.lastSeenAt
    ? Math.max(0, (now.getTime() - input.lastSeenAt.getTime()) / 1000)
    : null;
  const passedChecks = input.checks.filter((check) => check.status === 'passed').length;
  const failedChecks = input.checks.filter((check) => check.status === 'failed').length;
  const latencies = input.checks
    .map((check) => check.latencyMs)
    .filter((latency): latency is number => latency !== null)
    .sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  const medianLatencyMs =
    latencies.length === 0
      ? null
      : latencies.length % 2 === 1
        ? latencies[middle]
        : (latencies[middle - 1] + latencies[middle]) / 2;

  return {
    state:
      ageSec === null ? ('unknown' as const) : ageSec <= input.thresholdSec ? 'online' : 'stale',
    heartbeatAgeSec: ageSec === null ? null : Math.round(ageSec * 100) / 100,
    thresholdSec: input.thresholdSec,
    totalChecks: input.checks.length,
    passedChecks,
    failedChecks,
    successRate:
      input.checks.length === 0
        ? null
        : Math.round((passedChecks / input.checks.length) * 10_000) / 100,
    medianLatencyMs,
    openIncidentCount: input.openIncidentCount ?? 0,
  };
}
