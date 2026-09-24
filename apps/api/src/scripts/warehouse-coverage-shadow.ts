import { writeFile } from 'node:fs/promises';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  WAREHOUSE_COVERAGE_AVAILABILITIES,
  WAREHOUSE_COVERAGE_REASON_CODES,
  type UtcIsoString,
  type WarehouseCoverageAvailability,
  type WarehouseCoverageReasonCode,
} from '@plenka/contracts';
import {
  canonicalizeRollCoverageSpec,
  compareOpaqueIdsBinary,
  fingerprintRollFact,
  normalizeCoverageText,
  normalizeIngredients,
  normalizeSpool,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
  type CanonicalIngredient,
} from '../modules/warehouse-coverage/warehouse-coverage-canonical';
import { resolveCoverageCandidateRollIdsAfterCoreLocks } from '../modules/warehouse-coverage/warehouse-coverage-calculation.service';
import {
  buildVerifiedCandidate,
  matchWarehouseCoverage,
  type CandidateKnownCoverageFields,
  type UncertainCoverageCandidate,
  type VerifiedCoverageCandidate,
} from '../modules/warehouse-coverage/warehouse-coverage-matcher';
import { validateV2CoverageCompleteness } from '../modules/warehouse-coverage/warehouse-coverage-workflow';

const FACT_SPEC_VERSION = 'warehouse-roll-coverage/v1';
const READ_ONLY_SQL = 'SET TRANSACTION READ ONLY';

const SHADOW_ORDER_SELECT = {
  id: true,
  version: true,
  warehouseCoverageWorkflowVersion: true,
  counterpartyId: true,
  positions: {
    include: { recipe: true },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.CommercialOrderSelect;

const SHADOW_CANDIDATE_SELECT = {
  id: true,
  rollCode: true,
  ownerCounterpartyId: true,
  producedForStockOrderId: true,
  producedForOrderId: true,
  releasedFromOrderId: true,
  releasedFromOrder: { select: { cancellationStatus: true, positions: { select: { id: true } } } },
  producedForStockOrder: {
    select: {
      requestType: true,
      positions: {
        select: { id: true },
        orderBy: { id: 'asc' as const },
      },
    },
  },
  warehouseStatus: true,
  reservedForOrderId: true,
  reservedForPositionId: true,
  reservedByProposalId: true,
  reservedByCoverageDecisionId: true,
  currentCoverageFactId: true,
  currentCoverageFact: {
    select: {
      id: true,
      specVersion: true,
      specFingerprint: true,
      spec: true,
      sourceOrderId: true,
      sourcePositionId: true,
    },
  },
  coverageMemberships: {
    select: {
      orderId: true,
      case: { select: { status: true } },
    },
  },
} satisfies Prisma.WarehouseRollSelect;

type ShadowCandidateRoll = Prisma.WarehouseRollGetPayload<{
  select: typeof SHADOW_CANDIDATE_SELECT;
}>;

export interface ShadowWriteSensitiveCounts {
  reservations: number;
  tasks: number;
  facts: number;
  calculations: number;
  decisions: number;
  commands: number;
  epoch: string;
}

export interface WarehouseCoverageShadowReportV1 {
  schemaVersion: 'warehouse-coverage-shadow-report/v1';
  generatedAt: UtcIsoString;
  evaluatedOrders: number;
  completeOrders: number;
  skippedOrders: number;
  byAvailability: Record<WarehouseCoverageAvailability, number>;
  byReason: Partial<Record<WarehouseCoverageReasonCode, number>>;
  errors: number;
  before: ShadowWriteSensitiveCounts;
  after: ShadowWriteSensitiveCounts;
  passed: boolean;
}

export interface WarehouseCoverageShadowClient {
  $transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

export interface WarehouseCoverageShadowAggregates {
  evaluatedOrders: number;
  completeOrders: number;
  skippedOrders: number;
  byAvailability: Record<WarehouseCoverageAvailability, number>;
  byReason: Readonly<Record<string, number>>;
  errors: number;
}

export async function runWarehouseCoverageShadow(
  prisma: WarehouseCoverageShadowClient,
  outputPath: string,
  now: () => Date = () => new Date(),
): Promise<WarehouseCoverageShadowReportV1> {
  requireOutputPath(outputPath);
  const report = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(READ_ONLY_SQL);
    const before = await readShadowSensitiveCounts(tx);
    const aggregates = await evaluateEligibleOrdersWithoutPersistence(tx);
    const after = await readShadowSensitiveCounts(tx);
    return buildWarehouseCoverageShadowReport(before, after, aggregates, now());
  });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
  return report;
}

export function buildWarehouseCoverageShadowReport(
  before: ShadowWriteSensitiveCounts,
  after: ShadowWriteSensitiveCounts,
  aggregates: WarehouseCoverageShadowAggregates,
  generatedAt: Date,
): WarehouseCoverageShadowReportV1 {
  const supportedReasonSet = new Set<string>(WAREHOUSE_COVERAGE_REASON_CODES);
  const reasonEntries = Object.entries(aggregates.byReason);
  const reasonsArePublic = reasonEntries.every(
    ([reason, count]) => supportedReasonSet.has(reason) && isNonNegativeInteger(count),
  );
  const byReason: Partial<Record<WarehouseCoverageReasonCode, number>> = {};
  for (const reason of WAREHOUSE_COVERAGE_REASON_CODES) {
    const count = aggregates.byReason[reason];
    if (isNonNegativeInteger(count) && count > 0) byReason[reason] = count;
  }

  const availabilityCountsAreValid = WAREHOUSE_COVERAGE_AVAILABILITIES.every((availability) =>
    isNonNegativeInteger(aggregates.byAvailability[availability]),
  );
  const availabilityTotal = WAREHOUSE_COVERAGE_AVAILABILITIES.reduce(
    (total, availability) => total + aggregates.byAvailability[availability],
    0,
  );
  const orderCountsAreValid = [
    aggregates.evaluatedOrders,
    aggregates.completeOrders,
    aggregates.skippedOrders,
    aggregates.errors,
  ].every(isNonNegativeInteger);
  const totalsReconcile =
    aggregates.evaluatedOrders === aggregates.completeOrders + aggregates.skippedOrders &&
    availabilityTotal === aggregates.completeOrders;
  const writeSensitiveCountsAreValid =
    validWriteSensitiveCounts(before) && validWriteSensitiveCounts(after);

  return {
    schemaVersion: 'warehouse-coverage-shadow-report/v1',
    generatedAt: generatedAt.toISOString(),
    evaluatedOrders: aggregates.evaluatedOrders,
    completeOrders: aggregates.completeOrders,
    skippedOrders: aggregates.skippedOrders,
    byAvailability: { ...aggregates.byAvailability },
    byReason,
    errors: aggregates.errors,
    before: { ...before },
    after: { ...after },
    passed:
      orderCountsAreValid &&
      availabilityCountsAreValid &&
      totalsReconcile &&
      reasonsArePublic &&
      writeSensitiveCountsAreValid &&
      sameWriteSensitiveCounts(before, after) &&
      aggregates.errors === 0,
  };
}

async function readShadowSensitiveCounts(
  tx: Prisma.TransactionClient,
): Promise<ShadowWriteSensitiveCounts> {
  const [reservations, tasks, facts, calculations, decisions, commands, epochRow] =
    await Promise.all([
      tx.warehouseRoll.count({
        where: {
          OR: [
            { reservedForOrderId: { not: null } },
            { reservedForPositionId: { not: null } },
            { reservedByProposalId: { not: null } },
            { reservedByCoverageDecisionId: { not: null } },
          ],
        },
      }),
      tx.warehouseAcceptanceTask.count({
        where: { coverageDecisionId: { not: null } },
      }),
      tx.warehouseRollCoverageFact.count(),
      tx.warehouseCoverageCalculation.count(),
      tx.warehouseCoverageDecision.count(),
      tx.warehouseCoverageCommand.count(),
      tx.warehouseCoverageInventoryEpoch.findUnique({
        where: { id: 1 },
        select: { epoch: true },
      }),
    ]);
  if (!epochRow) throw new Error('warehouse coverage inventory epoch is missing');
  return {
    reservations,
    tasks,
    facts,
    calculations,
    decisions,
    commands,
    epoch: epochRow.epoch.toString(),
  };
}

async function evaluateEligibleOrdersWithoutPersistence(
  tx: Prisma.TransactionClient,
): Promise<WarehouseCoverageShadowAggregates> {
  const orders = await tx.commercialOrder.findMany({
    where: { warehouseCoverageWorkflowVersion: 2 },
    select: SHADOW_ORDER_SELECT,
    orderBy: { id: 'asc' },
  });
  const aggregates = emptyAggregates();

  for (const order of orders) {
    aggregates.evaluatedOrders += 1;
    if (!order.counterpartyId) {
      aggregates.skippedOrders += 1;
      continue;
    }
    const completeness = validateV2CoverageCompleteness(order);
    if (!completeness.ok) {
      aggregates.skippedOrders += 1;
      incrementReason(aggregates.byReason, completeness.reasonCode);
      continue;
    }

    const candidateIds = await resolveCoverageCandidateRollIdsAfterCoreLocks(tx, order);
    const candidateRows = await tx.warehouseRoll.findMany({
      where: { id: { in: candidateIds } },
      select: SHADOW_CANDIDATE_SELECT,
    });
    try {
      assertExactCandidateRows(candidateIds, candidateRows);
      const candidates = classifyCandidates(
        candidateRows,
        order.id,
        order.counterpartyId,
        new Set(order.positions.map(({ id }) => id)),
      );
      const plan = matchWarehouseCoverage({
        orderId: order.id,
        counterpartyId: order.counterpartyId,
        positions: completeness.positions,
        verifiedRolls: candidates.verified,
        uncertainRolls: candidates.uncertain,
      });
      aggregates.completeOrders += 1;
      aggregates.byAvailability[plan.availability] += 1;
      for (const reason of new Set(plan.reasonCodes)) {
        incrementReason(aggregates.byReason, reason);
      }
    } catch {
      aggregates.skippedOrders += 1;
      aggregates.errors += 1;
    }
  }
  return aggregates;
}

function emptyAggregates(): WarehouseCoverageShadowAggregates {
  return {
    evaluatedOrders: 0,
    completeOrders: 0,
    skippedOrders: 0,
    byAvailability: {
      verified_full: 0,
      unavailable: 0,
      unknown: 0,
    },
    byReason: {},
    errors: 0,
  };
}

function classifyCandidates(
  rows: readonly ShadowCandidateRoll[],
  orderId: string,
  counterpartyId: string,
  positionIds: ReadonlySet<string>,
): {
  verified: VerifiedCoverageCandidate[];
  uncertain: UncertainCoverageCandidate[];
} {
  const verified: VerifiedCoverageCandidate[] = [];
  const uncertain: UncertainCoverageCandidate[] = [];
  for (const row of rows) {
    if (
      row.warehouseStatus !== 'received' ||
      row.reservedForOrderId !== null ||
      row.reservedForPositionId !== null ||
      row.reservedByProposalId !== null ||
      row.reservedByCoverageDecisionId !== null ||
      (row.producedForOrderId !== null && !row.releasedFromOrderId)
    ) {
      continue;
    }
    const fact = row.currentCoverageFact;
    const rawSpec = asRecord(fact?.spec);
    const sourceOrderId = nullableOpaque(fact?.sourceOrderId ?? rawSpec?.sourceOrderId);
    const sourcePositionId = nullableOpaque(fact?.sourcePositionId ?? rawSpec?.sourcePositionId);
    const inActiveCase = row.coverageMemberships.some(
      (membership) => membership.orderId === orderId && membership.case.status === 'open',
    );
    const sourceRelevant =
      sourceOrderId === orderId && sourcePositionId !== null && positionIds.has(sourcePositionId);
    const companyStock =
      row.ownerCounterpartyId === null &&
      ((row.producedForStockOrderId !== null &&
        row.producedForStockOrder?.requestType === 'stock_reserve') ||
        (Boolean(row.releasedFromOrderId) &&
          row.releasedFromOrder?.cancellationStatus === 'cancelled'));
    if (
      row.ownerCounterpartyId !== counterpartyId &&
      !(row.ownerCounterpartyId === null && (companyStock || inActiveCase || sourceRelevant))
    ) {
      continue;
    }

    const canonical = canonicalFactOrNull(fact);
    const companyStockProvenanceVerified =
      companyStock &&
      canonical !== null &&
      fact?.sourceOrderId === canonical.spec.sourceOrderId &&
      fact?.sourcePositionId === canonical.spec.sourcePositionId &&
      canonical.spec.sourceOrderId === (row.releasedFromOrderId ?? row.producedForStockOrderId) &&
      canonical.spec.sourcePositionId !== null &&
      (row.releasedFromOrder ?? row.producedForStockOrder)?.positions.some(
        ({ id }) => id === canonical.spec.sourcePositionId,
      ) === true;
    const ownershipVerified =
      (row.ownerCounterpartyId === counterpartyId &&
        canonical?.spec.ownerCounterpartyId === counterpartyId) ||
      (companyStockProvenanceVerified && canonical?.spec.ownerCounterpartyId === null);
    if (canonical && ownershipVerified && canonical.spec.rollCode === row.rollCode) {
      verified.push(
        buildVerifiedCandidate({
          rollId: row.id,
          coverageFactId: canonical.factId,
          ownerScope: companyStock ? 'company_stock' : 'counterparty',
          spec: canonical.spec,
        }),
      );
      continue;
    }

    uncertain.push({
      rollId: row.id,
      rollCode: row.rollCode,
      ownerCounterpartyId: row.ownerCounterpartyId,
      sourceOrderId,
      sourcePositionId,
      recheckCaseId: inActiveCase ? `active:${orderId}:${row.id}` : null,
      recheckOrderId: inActiveCase ? orderId : null,
      coverageFactId: fact?.id ?? null,
      companyStock,
      known: knownCoverageFields(rawSpec),
      reasonCodes: uncertainReasonCodes(row, rawSpec, canonical, companyStock),
    });
  }
  verified.sort(candidateOrder);
  uncertain.sort(candidateOrder);
  return { verified, uncertain };
}

function uncertainReasonCodes(
  row: ShadowCandidateRoll,
  rawSpec: Record<string, unknown> | null,
  canonical: ReturnType<typeof canonicalFactOrNull>,
  companyStock: boolean,
): UncertainCoverageCandidate['reasonCodes'] {
  const reasons = new Set<UncertainCoverageCandidate['reasonCodes'][number]>();
  if (
    !row.currentCoverageFact ||
    row.currentCoverageFact.specVersion !== FACT_SPEC_VERSION ||
    !rawSpec ||
    !canonical ||
    canonical.spec.rollCode !== row.rollCode
  ) {
    reasons.add('roll_facts_incomplete');
  }
  if (
    rawSpec &&
    rawSpec.policyVersion != null &&
    rawSpec.policyVersion !== WAREHOUSE_COVERAGE_POLICY_VERSION
  ) {
    reasons.add('unsupported_policy_version');
  }
  if (
    (!companyStock && row.ownerCounterpartyId === null) ||
    (rawSpec !== null &&
      'ownerCounterpartyId' in rawSpec &&
      nullableOpaque(rawSpec.ownerCounterpartyId) !== row.ownerCounterpartyId)
  ) {
    reasons.add('roll_ownership_unverified');
  }
  if (reasons.size === 0) reasons.add('roll_facts_incomplete');
  return [
    'roll_facts_incomplete',
    'roll_ownership_unverified',
    'unsupported_policy_version',
  ].filter((reason) =>
    reasons.has(reason as UncertainCoverageCandidate['reasonCodes'][number]),
  ) as UncertainCoverageCandidate['reasonCodes'];
}

function canonicalFactOrNull(fact: ShadowCandidateRoll['currentCoverageFact']) {
  if (!fact || fact.specVersion !== FACT_SPEC_VERSION) return null;
  try {
    const spec = canonicalizeRollCoverageSpec(fact.spec);
    if (fingerprintRollFact(spec) !== fact.specFingerprint) return null;
    return { factId: fact.id, spec };
  } catch {
    return null;
  }
}

function knownCoverageFields(source: Record<string, unknown> | null): CandidateKnownCoverageFields {
  return {
    filmType: safeText(source?.filmType),
    actualThicknessMilliMicron: positiveIntegerOrNull(source?.actualThicknessMilliMicron),
    accountingThicknessMilliMicron: positiveIntegerOrNull(source?.accountingThicknessMilliMicron),
    widthMilliMm: positiveIntegerOrNull(source?.widthMilliMm),
    plannedLengthMilliM: positiveIntegerOrNull(source?.plannedLengthMilliM),
    birka: safeText(source?.birka),
    spoolType: safeSpool(source?.spoolType),
    actualWeightMilliKg: positiveIntegerOrNull(source?.actualWeightMilliKg),
    plannedWeightMilliKg: positiveIntegerOrNull(source?.plannedWeightMilliKg),
    ingredients: safeIngredients(source?.ingredients),
    policyVersion: typeof source?.policyVersion === 'string' ? source.policyVersion : null,
  };
}

function assertExactCandidateRows(
  candidateIds: readonly string[],
  rows: readonly ShadowCandidateRoll[],
): void {
  const rowIds = rows.map(({ id }) => id).sort(compareOpaqueIdsBinary);
  const expectedIds = [...candidateIds].sort(compareOpaqueIdsBinary);
  if (
    rowIds.length !== expectedIds.length ||
    rowIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error('warehouse coverage candidate set changed during shadow evaluation');
  }
}

function candidateOrder(
  left: VerifiedCoverageCandidate | UncertainCoverageCandidate,
  right: VerifiedCoverageCandidate | UncertainCoverageCandidate,
): number {
  const leftCode = 'spec' in left ? left.spec.rollCode : left.rollCode;
  const rightCode = 'spec' in right ? right.spec.rollCode : right.rollCode;
  return (
    compareOpaqueIdsBinary(leftCode, rightCode) || compareOpaqueIdsBinary(left.rollId, right.rollId)
  );
}

function incrementReason(target: Record<string, number>, reason: string): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

function sameWriteSensitiveCounts(
  before: ShadowWriteSensitiveCounts,
  after: ShadowWriteSensitiveCounts,
): boolean {
  return (
    before.reservations === after.reservations &&
    before.tasks === after.tasks &&
    before.facts === after.facts &&
    before.calculations === after.calculations &&
    before.decisions === after.decisions &&
    before.commands === after.commands &&
    before.epoch === after.epoch
  );
}

function validWriteSensitiveCounts(counts: ShadowWriteSensitiveCounts): boolean {
  return (
    [
      counts.reservations,
      counts.tasks,
      counts.facts,
      counts.calculations,
      counts.decisions,
      counts.commands,
    ].every(isNonNegativeInteger) && /^(?:0|[1-9]\d*)$/u.test(counts.epoch)
  );
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableOpaque(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function safeText(value: unknown): string | null {
  try {
    return normalizeCoverageText(value);
  } catch {
    return null;
  }
}

function safeSpool(value: unknown): string | null {
  try {
    return normalizeSpool(value);
  } catch {
    return null;
  }
}

function safeIngredients(value: unknown): readonly CanonicalIngredient[] | null {
  try {
    return normalizeIngredients(value);
  } catch {
    return null;
  }
}

function requireOutputPath(outputPath: string): void {
  if (outputPath.length === 0 || outputPath.trim() !== outputPath) {
    throw new Error('--output must be a non-empty path');
  }
}

function parseOutputPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--output') {
    throw new Error('Usage: coverage:shadow -- --output <report.json>');
  }
  requireOutputPath(argv[1]);
  return argv[1];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const report = await runWarehouseCoverageShadow(prisma, parseOutputPath(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown shadow runner error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
