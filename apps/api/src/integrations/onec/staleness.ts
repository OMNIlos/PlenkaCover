import type { OneCStaleness } from '@plenka/contracts';

export interface StalenessInput {
  /** sourceVersion of the previously stored snapshot (null if none stored yet). */
  storedVersion: string | null;
  /** sourceVersion observed upstream on the latest probe (null if unknown). */
  upstreamVersion: string | null;
  /** when we last successfully checked (null = never fetched). */
  lastCheckedAt: Date | null;
  now: Date;
  ttlMs: number;
  lastFetchFailed: boolean;
}

/**
 * Staleness of a stored 1С snapshot (ТЗ §8, S6 D5):
 * unknown = never fetched; stale = failed fetch, OR upstream DataVersion changed, OR TTL elapsed;
 * fresh otherwise (i.e. right after a successful GET with an unchanged version, within TTL).
 *
 * S6 scope note: this is the staleness PRIMITIVE. It is evaluated at READ/RECONCILE time —
 * i.e. when comparing an already-stored snapshot against a fresh upstream probe. S6 (contract +
 * mock + flag-gated read) has no read/reconcile consumer yet, so the import write path
 * (`OneCImportService`) correctly persists `fresh` for every just-fetched snapshot and only stamps
 * `checkedAt`. Wiring this into a live consumer belongs to the later reconcile/sync-cadence slice
 * (out of S6 scope per the spec's non-goals); calling it at import time would wrongly mark a
 * freshly-imported snapshot `stale` on any version change.
 */
export function computeStaleness(i: StalenessInput): OneCStaleness {
  if (i.lastCheckedAt === null) return 'unknown';
  if (i.lastFetchFailed) return 'stale';
  if (
    i.upstreamVersion !== null &&
    i.storedVersion !== null &&
    i.upstreamVersion !== i.storedVersion
  ) {
    return 'stale';
  }
  if (i.now.getTime() - i.lastCheckedAt.getTime() > i.ttlMs) return 'stale';
  return 'fresh';
}
