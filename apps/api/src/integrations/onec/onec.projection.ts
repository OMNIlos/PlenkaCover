import type { OneCSnapshot } from '@plenka/contracts';

/** A business-safe view of a 1С snapshot — everything EXCEPT rawPayload (ТЗ §8). */
export type OneCSnapshotProjection<TParsed> = Omit<OneCSnapshot<TParsed>, 'rawPayload'>;

/**
 * Project a 1С snapshot for business roles (commercial/finance/director/…): parsed + staleness
 * metadata only. `rawPayload` is admin-diagnostics and MUST NOT reach these projections (ТЗ §8).
 */
export function projectOneCSnapshot<TParsed>(
  snap: OneCSnapshot<TParsed>,
): OneCSnapshotProjection<TParsed> {
  const { rawPayload: _raw, ...safe } = snap;
  return safe;
}
