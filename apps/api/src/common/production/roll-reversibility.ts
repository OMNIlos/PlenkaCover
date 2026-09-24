export type RollReversibilityFacts = {
  status: string;
  completedAt: Date | null;
  coverageFactId: string | null;
  operatorLine: {
    spoolKg: number | null;
    grossKg: number | null;
    netKg: number | null;
    warehouseState: string;
    weightCaptures: readonly unknown[];
    labelJobs: readonly unknown[];
    operations: readonly unknown[];
  } | null;
};

const REVERSIBLE_STATUSES = new Set(['new', 'assigned']);

export function hasIrreversiblePhysicalFacts(facts: RollReversibilityFacts): boolean {
  if (!REVERSIBLE_STATUSES.has(facts.status)) return true;
  if (facts.completedAt || facts.coverageFactId) return true;
  const line = facts.operatorLine;
  if (!line) return false;
  return (
    line.spoolKg !== null ||
    line.grossKg !== null ||
    line.netKg !== null ||
    line.warehouseState !== 'not_ready' ||
    line.weightCaptures.length > 0 ||
    line.labelJobs.length > 0 ||
    line.operations.length > 0
  );
}
