export type RollCaptureFact = {
  id: string;
  operatorRollLineId: string;
  kind: string;
  stable: boolean;
  netKg: number | null;
  supersedesCaptureId: string | null;
  createdAt: Date;
};

export function isValidRollNetKg(netKg: number | null): netKg is number {
  return netKg !== null && Number.isFinite(netKg) && netKg > 0;
}

function isEligibleRollCapture(capture: RollCaptureFact): boolean {
  return capture.kind === 'roll' && capture.stable && isValidRollNetKg(capture.netKg);
}

function isRollCaptureEvidence(capture: RollCaptureFact): boolean {
  return capture.kind === 'roll' && capture.stable && capture.netKg !== null;
}

function compareCaptures(left: RollCaptureFact, right: RollCaptureFact): number {
  const createdAtDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdAtDifference !== 0) {
    return createdAtDifference;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

function resolveCanonicalRollCaptureChains<T extends RollCaptureFact>(
  captures: readonly T[],
  isEligible: (capture: T) => boolean,
): T[] {
  const eligibleCaptures = captures.filter(isEligible).sort(compareCaptures);
  const basesByLine = new Map<string, T>();
  const successorsByCapture = new Map<string, T[]>();

  for (const capture of eligibleCaptures) {
    if (capture.supersedesCaptureId !== null) {
      continue;
    }
    if (!basesByLine.has(capture.operatorRollLineId)) {
      basesByLine.set(capture.operatorRollLineId, capture);
    }
  }

  for (const capture of captures) {
    if (capture.supersedesCaptureId === null) {
      continue;
    }

    const successors = successorsByCapture.get(capture.supersedesCaptureId) ?? [];
    successors.push(capture);
    successorsByCapture.set(capture.supersedesCaptureId, successors);
  }

  return [...basesByLine.values()].map((base) => {
    let current = base;
    const visited = new Set([base.id]);

    while (true) {
      const successors = successorsByCapture.get(current.id) ?? [];
      if (successors.length !== 1) {
        return current;
      }

      const [next] = successors;
      if (
        next.operatorRollLineId !== base.operatorRollLineId ||
        !isEligible(next) ||
        visited.has(next.id)
      ) {
        return current;
      }

      visited.add(next.id);
      current = next;
    }
  });
}

export function resolveCanonicalRollCaptureEvidence<T extends RollCaptureFact>(
  captures: readonly T[],
): T[] {
  return resolveCanonicalRollCaptureChains(captures, isRollCaptureEvidence);
}

export function resolveCanonicalRollCaptures<T extends RollCaptureFact>(
  captures: readonly T[],
): T[] {
  const canonicalFacts = resolveCanonicalRollCaptureChains(captures, isEligibleRollCapture);
  const resolvedLineIds = new Set(canonicalFacts.map((capture) => capture.operatorRollLineId));
  const recoveredFacts = resolveCanonicalRollCaptureEvidence(captures).filter(
    (capture) => !resolvedLineIds.has(capture.operatorRollLineId) && isEligibleRollCapture(capture),
  );
  return [...canonicalFacts, ...recoveredFacts];
}
