export type ShiftBagEpisodeFact = {
  startKg: number;
  endKg: number | null;
  closeKind: 'released' | 'shift_closed' | null;
};

export type ShiftBagUsageFactSource = {
  startKg: number;
  endKg: number | null;
  closedAt: Date | null;
  releasedReason: string | null;
  episodes: ReadonlyArray<
    Omit<ShiftBagEpisodeFact, 'closeKind'> & {
      closeKind: string | null;
      sequence: number;
      closedAt: Date | null;
    }
  >;
};

export type CanonicalShiftBagUsageFacts = {
  episodes: ShiftBagEpisodeFact[];
  episodeCount: number;
  confirmedUsageKg: number;
  actualUsageKg: number | null;
};

function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function calculateExpectedActiveResidueKg(
  episodes: readonly ShiftBagEpisodeFact[],
  canonicalExpectedUsageKg: number,
): number {
  const confirmedStartKg = episodes.reduce((sum, episode) => sum + episode.startKg, 0);
  const returnedKg = episodes.reduce(
    (sum, episode) =>
      episode.closeKind === 'released' && episode.endKg !== null
        ? sum + episode.endKg
        : sum,
    0,
  );
  return round3(confirmedStartKg - returnedKg - canonicalExpectedUsageKg);
}

export function calculateActualEpisodeUsageKg(
  episodes: readonly ShiftBagEpisodeFact[],
): number | null {
  if (episodes.some((episode) => episode.endKg === null)) return null;
  return round3(
    episodes.reduce((sum, episode) => sum + episode.startKg - episode.endKg!, 0),
  );
}

/**
 * Cross-contour read seam for consumers such as production-cost snapshots. The stable
 * ShiftBagUsage row is only a current/latest projection; measured material usage must
 * aggregate every immutable episode. Rows created before the episode migration remain
 * readable as one legacy fact without inventing additional history.
 */
export function resolveCanonicalShiftBagUsageFacts(
  usage: ShiftBagUsageFactSource,
): CanonicalShiftBagUsageFacts {
  const episodes: ShiftBagEpisodeFact[] =
    usage.episodes.length > 0
      ? [...usage.episodes]
          .sort((left, right) => left.sequence - right.sequence)
          .map(({ startKg, endKg, closeKind }) => {
            if (closeKind !== null && closeKind !== 'released' && closeKind !== 'shift_closed') {
              throw new RangeError(`Unknown shift BigBag episode close kind: ${closeKind}`);
            }
            return { startKg, endKg, closeKind };
          })
      : [
          {
            startKg: usage.startKg,
            endKg: usage.endKg,
            closeKind:
              usage.closedAt === null
                ? null
                : usage.releasedReason
                  ? 'released'
                  : 'shift_closed',
          },
        ];
  const confirmedUsageKg = round3(
    episodes.reduce(
      (sum, episode) =>
        episode.endKg === null ? sum : sum + episode.startKg - episode.endKg,
      0,
    ),
  );
  return {
    episodes,
    episodeCount: episodes.length,
    confirmedUsageKg,
    actualUsageKg: calculateActualEpisodeUsageKg(episodes),
  };
}
