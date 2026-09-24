import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  DirectorAnalyticsBigBagEvidence,
  DirectorAnalyticsBigBagEvidencePage,
  DirectorAnalyticsBigBagEvidenceQuery,
  DirectorAnalyticsBigBag,
  DirectorAnalyticsBigBagUsage,
  DirectorAnalyticsEvidenceBagLink,
  DirectorAnalyticsEvidenceFreshness,
  DirectorAnalyticsEvidenceQueryBase,
  DirectorAnalyticsEvidenceSource,
  DirectorAnalyticsMaterialPoint,
  DirectorAnalyticsMaterialSpendPoint,
  DirectorAnalyticsOperatorOverPlan,
  DirectorAnalyticsOverPlanSeriesPoint,
  DirectorAnalyticsProductionPoint,
  DirectorAnalyticsProductionQualityPoint,
  DirectorAnalyticsQuery,
  DirectorAnalyticsResponse,
  DirectorAnalyticsShiftBalance,
  DirectorAnalyticsShiftEvidence,
  DirectorAnalyticsShiftEvidencePage,
  DirectorAnalyticsShiftEvidenceQuery,
  DirectorCommercialApplications,
  DirectorOperatorRollVariance,
  DirectorOperatorRollVariancePage,
  DirectorOperatorRollVarianceQuery,
} from '@plenka/contracts';
import { valueBigBag } from '../../common/money/big-bag-valuation';
import { resolveCanonicalShiftBagUsageFacts } from '../../common/shift-bag/canonical-shift-bag-episodes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PayrollTariffOrderRepository } from '../../common/payroll-tariffs/payroll-tariff-order.repository';
import { PayrollTariffResolver } from '../../common/payroll-tariffs/payroll-tariff-resolver';
import { balanceTolerance } from '../operator/operator-shift.service';
import { buildDirectorRollFacts, type DirectorRollFact } from './director-analytics.roll-facts';
import {
  directorAnalyticsBucketKey,
  directorAnalyticsFixedWindows,
  enumerateDirectorAnalyticsBuckets,
  moscowDateToUtcStart,
  parseDirectorAnalyticsRange,
  type ParsedDirectorAnalyticsRange,
} from './director-analytics.time';
import { matchesBigBagEvidence, matchesShiftEvidence } from './director-evidence.filter';
import { collectFilteredEvidencePage, type EvidenceCursor } from './director-evidence.page';
import { buildDirectorAccountingProduction } from './director-accounting-production';

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function isInHalfOpenRange(value: Date, from: Date, toExclusive: Date): boolean {
  return value >= from && value < toExclusive;
}

function balanceDeviation(expectedUsageKg: number, actualUsageKg: number): number {
  if (expectedUsageKg > 0) return (actualUsageKg - expectedUsageKg) / expectedUsageKg;
  if (actualUsageKg === 0) return 0;
  return actualUsageKg > 0 ? 1 : -1;
}

function balanceStatus(deviation: number): 'ok' | 'mismatch' {
  const tolerance = balanceTolerance();
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(deviation), tolerance) * 8;
  return Math.abs(deviation) <= tolerance + epsilon ? 'ok' : 'mismatch';
}

type BigBagBalanceInput = {
  initialKg: number | null;
  currentKg: number | null;
  producedKg: number | null;
  confirmedDefectKg: number | null;
};

type BigBagBalance = {
  actualUsageKg: number | null;
  calculatedConsumptionKg: number | null;
  calculatedRemainderKg: number | null;
  deviationKg: number | null;
  deviationPercent: number | null;
  status: 'pending' | 'ok' | 'mismatch';
};

type DirectorBigBagEvidenceWithBalance = DirectorAnalyticsBigBagEvidence & {
  calculatedRemainderKg: number | null;
};

function nonNegativeGrams(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  const grams = Math.round(value * 1_000);
  return Number.isSafeInteger(grams) ? grams : null;
}

export type BigBagFactWindow = {
  episodeId: string;
  usageId: string;
  openedAt: Date;
  closedAt: Date | null;
};

export type BigBagWeightFact = {
  id: string;
  weightKg: number;
  capturedAt: Date | null;
};

export type BigBagTimestampFact = {
  id: string;
  capturedAt: Date | null;
};

export type BigBagUsageFactAttribution = {
  producedKg: number;
  rollCount: number;
  confirmedDefectKg: number;
  defectCount: number;
  unverifiedDefectCount: number;
};

export function attributeBigBagFactsToUsages(input: {
  usageIds: readonly string[];
  windows: readonly BigBagFactWindow[];
  producedFacts: readonly BigBagWeightFact[];
  confirmedDefectFacts: readonly BigBagWeightFact[];
  unverifiedDefectFacts: readonly BigBagTimestampFact[];
}): Map<string, BigBagUsageFactAttribution> | null {
  const usageIds = new Set(input.usageIds);
  if (usageIds.size !== input.usageIds.length) return null;

  const episodeIds = new Set<string>();
  const usageIdsWithWindows = new Set<string>();
  const windows = input.windows.map((window) => {
    const openedAt = window.openedAt.getTime();
    const closedAt = window.closedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (
      episodeIds.has(window.episodeId) ||
      !usageIds.has(window.usageId) ||
      !Number.isFinite(openedAt) ||
      closedAt <= openedAt
    ) {
      return null;
    }
    episodeIds.add(window.episodeId);
    usageIdsWithWindows.add(window.usageId);
    return { ...window, openedAt, closedAt };
  });
  if (windows.some((window) => window === null) || usageIdsWithWindows.size !== usageIds.size) {
    return null;
  }
  const validWindows = windows.filter(
    (window): window is NonNullable<typeof window> => window !== null,
  );
  for (let leftIndex = 0; leftIndex < validWindows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < validWindows.length; rightIndex += 1) {
      const left = validWindows[leftIndex];
      const right = validWindows[rightIndex];
      if (left.openedAt < right.closedAt && right.openedAt < left.closedAt) return null;
    }
  }

  const gramsByUsage = new Map(
    input.usageIds.map((usageId) => [
      usageId,
      {
        producedGrams: 0,
        rollCount: 0,
        confirmedDefectGrams: 0,
        defectCount: 0,
        unverifiedDefectCount: 0,
      },
    ]),
  );
  const ownerOf = (fact: BigBagTimestampFact) => {
    const capturedAt = fact.capturedAt?.getTime();
    if (capturedAt === undefined || !Number.isFinite(capturedAt)) return null;
    const owners = validWindows.filter(
      (window) => capturedAt >= window.openedAt && capturedAt < window.closedAt,
    );
    return owners.length === 1 ? owners[0].usageId : null;
  };
  const seenFactIds = new Set<string>();
  for (const fact of input.producedFacts) {
    const owner = ownerOf(fact);
    const grams = nonNegativeGrams(fact.weightKg);
    const totals = owner === null ? undefined : gramsByUsage.get(owner);
    if (seenFactIds.has(`roll:${fact.id}`) || grams === null || !totals) return null;
    seenFactIds.add(`roll:${fact.id}`);
    totals.producedGrams += grams;
    totals.rollCount += 1;
  }
  for (const fact of input.confirmedDefectFacts) {
    const owner = ownerOf(fact);
    const grams = nonNegativeGrams(fact.weightKg);
    const totals = owner === null ? undefined : gramsByUsage.get(owner);
    if (seenFactIds.has(`defect:${fact.id}`) || grams === null || !totals) return null;
    seenFactIds.add(`defect:${fact.id}`);
    totals.confirmedDefectGrams += grams;
    totals.defectCount += 1;
  }
  for (const fact of input.unverifiedDefectFacts) {
    const owner = ownerOf(fact);
    const totals = owner === null ? undefined : gramsByUsage.get(owner);
    if (seenFactIds.has(`unverified-defect:${fact.id}`) || !totals) return null;
    seenFactIds.add(`unverified-defect:${fact.id}`);
    totals.defectCount += 1;
    totals.unverifiedDefectCount += 1;
  }

  return new Map(
    [...gramsByUsage].map(([usageId, totals]) => [
      usageId,
      {
        producedKg: round3(totals.producedGrams / 1_000),
        rollCount: totals.rollCount,
        confirmedDefectKg: round3(totals.confirmedDefectGrams / 1_000),
        defectCount: totals.defectCount,
        unverifiedDefectCount: totals.unverifiedDefectCount,
      },
    ]),
  );
}

export function calculateBigBagBalance(input: BigBagBalanceInput): BigBagBalance {
  const initialGrams = nonNegativeGrams(input.initialKg);
  const currentGrams = nonNegativeGrams(input.currentKg);
  const producedGrams = nonNegativeGrams(input.producedKg);
  const defectGrams = nonNegativeGrams(input.confirmedDefectKg);
  if (
    initialGrams === null ||
    currentGrams === null ||
    producedGrams === null ||
    defectGrams === null
  ) {
    return {
      actualUsageKg: null,
      calculatedConsumptionKg: null,
      calculatedRemainderKg: null,
      deviationKg: null,
      deviationPercent: null,
      status: 'pending',
    };
  }

  const consumptionGrams = producedGrams + defectGrams;
  const remainderGrams = initialGrams - consumptionGrams;
  const deviationGrams = currentGrams - remainderGrams;
  const ratio =
    remainderGrams === 0
      ? deviationGrams === 0
        ? 0
        : Math.sign(deviationGrams)
      : deviationGrams / Math.abs(remainderGrams);
  return {
    actualUsageKg: round3((initialGrams - currentGrams) / 1_000),
    calculatedConsumptionKg: round3(consumptionGrams / 1_000),
    calculatedRemainderKg: round3(remainderGrams / 1_000),
    deviationKg: round3(deviationGrams / 1_000),
    deviationPercent: round3(ratio * 100),
    status: balanceStatus(ratio),
  };
}

function rollVariance(fact: DirectorRollFact) {
  const varianceKg = fact.plannedKg === null ? null : round3(fact.actualKg - fact.plannedKg);
  const overPlanKg = varianceKg === null ? null : round3(Math.max(0, varianceKg));
  return { fact, varianceKg, overPlanKg };
}

type OperatorRollCursor = {
  producedAt: string;
  rollId: string;
};

const OPERATOR_ROLL_CURSOR_MAX_LENGTH = 500;
const STRICT_BASE64URL = /^[A-Za-z0-9_-]+$/;

const directorRollFactSelect = {
  id: true,
  operatorRollLineId: true,
  postSessionId: true,
  kind: true,
  stable: true,
  grossKg: true,
  spoolKg: true,
  netKg: true,
  deviceId: true,
  deviceStatus: true,
  actorId: true,
  supersedesCaptureId: true,
  createdAt: true,
  postSession: {
    select: {
      operator: { select: { id: true, displayName: true } },
    },
  },
  operation: {
    select: {
      status: true,
      actor: { select: { id: true, displayName: true } },
    },
  },
  line: {
    select: {
      id: true,
      planKg: true,
      defects: { select: { createdAt: true } },
      rollDispatchItem: {
        select: {
          id: true,
          rollCode: true,
          characteristicsSnapshot: true,
          productionOrder: {
            select: {
              commercialOrder: {
                select: { id: true, orderNumber: true },
              },
            },
          },
        },
      },
    },
  },
} as const;

const directorEvidenceBagSelect = {
  id: true,
  code: true,
  materialId: true,
  material: true,
  status: true,
  currentKg: true,
  lastMeasuredKg: true,
  lastMeasuredAt: true,
  initialKg: true,
  priceKopecksPerKg: true,
  priceEffectiveAt: true,
} as const;

const directorEvidenceBagUsageSelect = {
  id: true,
  sessionId: true,
  bigBagId: true,
  startKg: true,
  endKg: true,
  releasedReason: true,
  createdAt: true,
  closedAt: true,
  episodes: {
    // Weights included: measured consumption is the sum over episodes, not the
    // stable row, which only carries the latest leg of a re-taken Big-Bag.
    select: {
      id: true,
      usageId: true,
      sequence: true,
      startKg: true,
      endKg: true,
      closeKind: true,
      openedAt: true,
      closedAt: true,
    },
  },
  bigBag: { select: directorEvidenceBagSelect },
} as const;

const directorEvidenceSessionSelect = {
  id: true,
  status: true,
  startedAt: true,
  endedAt: true,
  operator: { select: { id: true, displayName: true } },
  post: { select: { id: true, code: true, name: true } },
  shift: { select: { id: true, label: true } },
  bagUsages: {
    select: directorEvidenceBagUsageSelect,
  },
} as const;

const directorEvidenceUsageSelect = {
  ...directorEvidenceBagUsageSelect,
  session: { select: directorEvidenceSessionSelect },
} as const;

const directorEvidenceDefectSelect = {
  id: true,
  operatorRollLineId: true,
  createdAt: true,
  weightCapture: {
    select: {
      operatorRollLineId: true,
      kind: true,
      stable: true,
      netKg: true,
      createdAt: true,
    },
  },
} as const;

type DirectorEvidenceSessionRow = Prisma.OperatorPostSessionGetPayload<{
  select: typeof directorEvidenceSessionSelect;
}>;

type DirectorEvidenceUsageRow = Prisma.ShiftBagUsageGetPayload<{
  select: typeof directorEvidenceUsageSelect;
}>;

type DirectorEvidenceDefectRow = Prisma.DefectRecordGetPayload<{
  select: typeof directorEvidenceDefectSelect;
}>;

type DirectorEvidenceCursorKind = EvidenceCursor['kind'];

type DirectorEvidenceFacts = {
  rollFacts: DirectorRollFact[];
  defects: DirectorEvidenceDefectRow[];
};

type DirectorEvidenceSessionMetrics = {
  bagLinks: DirectorAnalyticsEvidenceBagLink[];
  startKg: number | null;
  endKg: number | null;
  currentKg: number | null;
  actualUsageKg: number | null;
  expectedUsageKg: number;
  producedKg: number;
  rollCount: number;
  defectKg: number;
  defectCount: number;
  unverifiedDefectCount: number;
  deviationKg: number | null;
  deviationPercent: number | null;
  status: 'pending' | 'ok' | 'mismatch';
  source: DirectorAnalyticsEvidenceSource;
};

const DIRECTOR_EVIDENCE_CURSOR_MAX_LENGTH = 500;

function invalidEvidenceCursor(): never {
  throw new BadRequestException('Invalid analytics evidence cursor');
}

function decodeEvidenceCursor(
  value: string,
  expectedKind: DirectorEvidenceCursorKind,
): EvidenceCursor {
  if (
    value.length === 0 ||
    value.length > DIRECTOR_EVIDENCE_CURSOR_MAX_LENGTH ||
    !STRICT_BASE64URL.test(value)
  ) {
    return invalidEvidenceCursor();
  }

  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return invalidEvidenceCursor();
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return invalidEvidenceCursor();
    }
    const keys = Object.keys(parsed).sort();
    if (keys.length !== 3 || keys[0] !== 'id' || keys[1] !== 'kind' || keys[2] !== 'timestamp') {
      return invalidEvidenceCursor();
    }

    const cursor = parsed as Partial<EvidenceCursor>;
    if (
      cursor.kind !== expectedKind ||
      typeof cursor.id !== 'string' ||
      cursor.id.trim().length === 0 ||
      typeof cursor.timestamp !== 'string'
    ) {
      return invalidEvidenceCursor();
    }
    const timestamp = new Date(cursor.timestamp);
    if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== cursor.timestamp) {
      return invalidEvidenceCursor();
    }
    return {
      kind: expectedKind,
      timestamp: cursor.timestamp,
      id: cursor.id,
    };
  } catch {
    return invalidEvidenceCursor();
  }
}

function evidenceLimit(query: DirectorAnalyticsEvidenceQueryBase): number {
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestException('Invalid analytics evidence limit');
  }
  return limit;
}

const EVIDENCE_DAY_MS = 24 * 60 * 60 * 1_000;

function evidenceText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function insensitiveContains(value: string) {
  return { contains: value, mode: 'insensitive' as const };
}

function evidenceDateBounds(input: {
  baseFrom?: Date;
  baseToExclusive?: Date;
  from?: string;
  to?: string;
}): { gte?: Date; lt?: Date } | undefined {
  const lowerBounds = [
    input.baseFrom,
    input.from === undefined ? undefined : moscowDateToUtcStart(input.from),
  ].filter((value): value is Date => value !== undefined);
  const upperBounds = [
    input.baseToExclusive,
    input.to === undefined
      ? undefined
      : new Date(moscowDateToUtcStart(input.to).getTime() + EVIDENCE_DAY_MS),
  ].filter((value): value is Date => value !== undefined);

  if (lowerBounds.length === 0 && upperBounds.length === 0) return undefined;
  return {
    ...(lowerBounds.length > 0
      ? { gte: new Date(Math.max(...lowerBounds.map((value) => value.getTime()))) }
      : {}),
    ...(upperBounds.length > 0
      ? { lt: new Date(Math.min(...upperBounds.map((value) => value.getTime()))) }
      : {}),
  };
}

function numericBounds(
  min: number | undefined,
  max: number | undefined,
): { gte?: number; lte?: number } | undefined {
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min === undefined ? {} : { gte: min }),
    ...(max === undefined ? {} : { lte: max }),
  };
}

function buildShiftEvidenceWhere(
  query: DirectorAnalyticsShiftEvidenceQuery,
  range: ParsedDirectorAnalyticsRange,
  cursor: EvidenceCursor | null,
): Prisma.OperatorPostSessionWhereInput {
  const and: Prisma.OperatorPostSessionWhereInput[] = [];
  const q = evidenceText(query.q);
  const operatorQuery = evidenceText(query.operatorQuery);
  const postQuery = evidenceText(query.postQuery);
  const shiftQuery = evidenceText(query.shiftQuery);

  if (q) {
    const contains = insensitiveContains(q);
    and.push({
      OR: [
        { id: contains },
        { shiftId: contains },
        { operator: { displayName: contains } },
        { post: { code: contains } },
        { post: { name: contains } },
        { shift: { label: contains } },
        { bagUsages: { some: { bigBag: { code: contains } } } },
        { bagUsages: { some: { bigBag: { material: contains } } } },
      ],
    });
  }
  if (operatorQuery) {
    const contains = insensitiveContains(operatorQuery);
    and.push({
      OR: [{ operatorId: contains }, { operator: { displayName: contains } }],
    });
  }
  if (postQuery) {
    const contains = insensitiveContains(postQuery);
    and.push({
      OR: [{ postId: contains }, { post: { code: contains } }, { post: { name: contains } }],
    });
  }
  if (shiftQuery) {
    const contains = insensitiveContains(shiftQuery);
    and.push({
      OR: [{ id: contains }, { shiftId: contains }, { shift: { label: contains } }],
    });
  }
  if (cursor) {
    and.push({
      OR: [
        { endedAt: { lt: new Date(cursor.timestamp) } },
        {
          endedAt: new Date(cursor.timestamp),
          id: { gt: cursor.id },
        },
      ],
    });
  }

  const startedAt = evidenceDateBounds({
    from: query.startedFrom,
    to: query.startedTo,
  });
  return {
    status: 'closed',
    endedAt: evidenceDateBounds({
      baseFrom: range.fromUtc,
      baseToExclusive: range.toExclusiveUtc,
      from: query.endedFrom,
      to: query.endedTo,
    }),
    ...(startedAt ? { startedAt } : {}),
    ...(query.operatorId ? { operatorId: query.operatorId } : {}),
    ...(query.postId ? { postId: query.postId } : {}),
    ...(query.shiftId ? { shiftId: query.shiftId } : {}),
    ...(query.bigBagId ? { bagUsages: { some: { bigBagId: query.bigBagId } } } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
}

function buildBigBagEvidenceWhere(
  query: DirectorAnalyticsBigBagEvidenceQuery,
  range: ParsedDirectorAnalyticsRange,
  cursor: EvidenceCursor | null,
): Prisma.ShiftBagUsageWhereInput {
  const and: Prisma.ShiftBagUsageWhereInput[] = [
    {
      OR: [{ closedAt: null }, { closedAt: { gte: range.fromUtc } }],
    },
  ];
  const sessionWhere: Prisma.OperatorPostSessionWhereInput = {
    ...(query.operatorId ? { operatorId: query.operatorId } : {}),
    ...(query.postId ? { postId: query.postId } : {}),
    ...(query.shiftId ? { shiftId: query.shiftId } : {}),
  };
  const q = evidenceText(query.q);
  const operatorQuery = evidenceText(query.operatorQuery);
  const postQuery = evidenceText(query.postQuery);
  const shiftQuery = evidenceText(query.shiftQuery);
  const bigBagQuery = evidenceText(query.bigBagQuery);
  const materialQuery = evidenceText(query.materialQuery);

  if (q) {
    const contains = insensitiveContains(q);
    and.push({
      OR: [
        { sessionId: contains },
        { session: { shiftId: contains } },
        { session: { operator: { displayName: contains } } },
        { session: { post: { code: contains } } },
        { session: { post: { name: contains } } },
        { session: { shift: { label: contains } } },
        { bigBag: { code: contains } },
        { bigBag: { material: contains } },
      ],
    });
  }
  if (operatorQuery) {
    const contains = insensitiveContains(operatorQuery);
    and.push({
      OR: [
        { session: { operatorId: contains } },
        { session: { operator: { displayName: contains } } },
      ],
    });
  }
  if (postQuery) {
    const contains = insensitiveContains(postQuery);
    and.push({
      OR: [
        { session: { postId: contains } },
        { session: { post: { code: contains } } },
        { session: { post: { name: contains } } },
      ],
    });
  }
  if (shiftQuery) {
    const contains = insensitiveContains(shiftQuery);
    and.push({
      OR: [
        { sessionId: contains },
        { session: { shiftId: contains } },
        { session: { shift: { label: contains } } },
      ],
    });
  }
  if (bigBagQuery) {
    const contains = insensitiveContains(bigBagQuery);
    and.push({
      OR: [{ bigBagId: contains }, { bigBag: { code: contains } }],
    });
  }
  if (materialQuery) {
    const contains = insensitiveContains(materialQuery);
    and.push({
      OR: [{ bigBag: { materialId: contains } }, { bigBag: { material: contains } }],
    });
  }
  if (query.usageState) {
    and.push(query.usageState === 'open' ? { closedAt: null } : { closedAt: { not: null } });
  }
  if (cursor) {
    and.push({
      OR: [
        { createdAt: { lt: new Date(cursor.timestamp) } },
        {
          createdAt: new Date(cursor.timestamp),
          id: { gt: cursor.id },
        },
      ],
    });
  }

  const closedAt = evidenceDateBounds({
    from: query.closedFrom,
    to: query.closedTo,
  });
  const startKg = numericBounds(query.startKgMin, query.startKgMax);
  const endKg = numericBounds(query.endKgMin, query.endKgMax);
  return {
    createdAt: evidenceDateBounds({
      baseToExclusive: range.toExclusiveUtc,
      from: query.openedFrom,
      to: query.openedTo,
    }),
    ...(closedAt ? { closedAt } : {}),
    ...(startKg ? { startKg } : {}),
    ...(endKg ? { endKg } : {}),
    ...(query.bigBagId ? { bigBagId: query.bigBagId } : {}),
    ...(query.bigBagStatus ? { bigBag: { status: query.bigBagStatus } } : {}),
    ...(Object.keys(sessionWhere).length > 0 ? { session: { is: sessionWhere } } : {}),
    AND: and,
  };
}

function shiftEvidenceCursor(session: DirectorEvidenceSessionRow): EvidenceCursor {
  if (session.endedAt === null) {
    throw new Error('Closed evidence session is missing endedAt');
  }
  return {
    kind: 'shift',
    timestamp: session.endedAt.toISOString(),
    id: session.id,
  };
}

function bigBagEvidenceCursor(usage: DirectorEvidenceUsageRow): EvidenceCursor {
  return {
    kind: 'bigbag',
    timestamp: usage.createdAt.toISOString(),
    id: usage.id,
  };
}

function currentBagKg(
  bag: Pick<DirectorEvidenceUsageRow['bigBag'], 'currentKg' | 'lastMeasuredKg'>,
): number | null {
  return bag.currentKg ?? bag.lastMeasuredKg ?? null;
}

function currentEvidenceFreshness(
  usage: Pick<DirectorEvidenceUsageRow, 'createdAt' | 'closedAt' | 'bigBag'>,
): DirectorAnalyticsEvidenceFreshness {
  const measuredAt = usage.bigBag.lastMeasuredAt;
  if (measuredAt === null) return 'unknown';
  const requiredAt = usage.closedAt ?? usage.createdAt;
  return measuredAt >= requiredAt ? 'fresh' : 'stale';
}

function aggregateEvidenceFreshness(
  usages: readonly Pick<DirectorEvidenceUsageRow, 'createdAt' | 'closedAt' | 'bigBag'>[],
): DirectorAnalyticsEvidenceFreshness {
  if (usages.length === 0) return 'unknown';
  const freshness = usages.map(currentEvidenceFreshness);
  if (freshness.includes('stale')) return 'stale';
  return freshness.includes('unknown') ? 'unknown' : 'fresh';
}

function latestEvidenceAt(values: readonly (Date | null)[]): string | null {
  const available = values.filter((value): value is Date => value !== null);
  if (available.length === 0) return null;
  return new Date(Math.max(...available.map((value) => value.getTime()))).toISOString();
}

function evidenceBagLink(usage: DirectorEvidenceSessionRow['bagUsages'][number]) {
  return {
    usageId: usage.id,
    bigBagId: usage.bigBag.id,
    bigBagCode: usage.bigBag.code,
    materialId: usage.bigBag.materialId,
    material: usage.bigBag.material,
    bigBagStatus: usage.bigBag.status as DirectorAnalyticsEvidenceBagLink['bigBagStatus'],
    startKg: usage.startKg,
    endKg: usage.endKg,
    currentKg: currentBagKg(usage.bigBag),
    currentMeasuredAt: usage.bigBag.lastMeasuredAt?.toISOString() ?? null,
    currentFreshness: currentEvidenceFreshness(usage),
    openedAt: usage.createdAt.toISOString(),
    closedAt: usage.closedAt?.toISOString() ?? null,
  } satisfies DirectorAnalyticsEvidenceBagLink;
}

function sessionEvidenceMetrics(
  session: DirectorEvidenceSessionRow,
  facts: DirectorEvidenceFacts,
): DirectorEvidenceSessionMetrics {
  const sessionFacts = facts.rollFacts.filter(({ rootSessionId }) => rootSessionId === session.id);
  const factByLine = new Map(sessionFacts.map((fact) => [fact.lineId, fact]));
  const sessionDefects = facts.defects.filter(({ operatorRollLineId }) =>
    factByLine.has(operatorRollLineId),
  );
  const verifiedDefects = sessionDefects.filter(({ operatorRollLineId, weightCapture }) => {
    return (
      weightCapture !== null &&
      weightCapture.operatorRollLineId === operatorRollLineId &&
      weightCapture.kind === 'roll' &&
      weightCapture.stable &&
      weightCapture.netKg !== null &&
      Number.isFinite(weightCapture.netKg)
    );
  });
  const orderedUsages = [...session.bagUsages].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
  );
  const bagLinks = orderedUsages.map(evidenceBagLink);
  const hasUsage = session.bagUsages.length > 0;
  const completeUsage =
    hasUsage && session.bagUsages.every((usage) => usage.closedAt !== null && usage.endKg !== null);
  const startKg = hasUsage
    ? round3(session.bagUsages.reduce((sum, usage) => sum + usage.startKg, 0))
    : null;
  const endKg = completeUsage
    ? round3(session.bagUsages.reduce((sum, usage) => sum + (usage.endKg ?? 0), 0))
    : null;
  const currentKg =
    hasUsage && session.bagUsages.every((usage) => currentBagKg(usage.bigBag) !== null)
      ? round3(session.bagUsages.reduce((sum, usage) => sum + (currentBagKg(usage.bigBag) ?? 0), 0))
      : null;
  // Consumption aggregates the immutable episodes: a Big-Bag released and
  // re-taken inside one session leaves the stable row holding only its last
  // leg, which reads as no consumption at all.
  const episodeUsageKg = session.bagUsages.reduce<number | null>((sum, usage) => {
    if (sum === null) return null;
    const measured = resolveCanonicalShiftBagUsageFacts(usage).actualUsageKg;
    return measured === null ? null : sum + measured;
  }, 0);
  const actualUsageKg = completeUsage && episodeUsageKg !== null ? round3(episodeUsageKg) : null;
  const defectKg = round3(
    verifiedDefects.reduce((sum, defect) => sum + (defect.weightCapture?.netKg ?? 0), 0),
  );
  const confirmedDefectLineIds = new Set(
    verifiedDefects.map(({ operatorRollLineId }) => operatorRollLineId),
  );
  const producedKg = round3(
    sessionFacts
      .filter(({ lineId }) => !confirmedDefectLineIds.has(lineId))
      .reduce((sum, fact) => sum + fact.actualKg, 0),
  );
  const expectedUsageKg = round3(producedKg + defectKg);
  const deviationKg = actualUsageKg === null ? null : round3(actualUsageKg - expectedUsageKg);
  const deviation =
    actualUsageKg === null ? null : balanceDeviation(expectedUsageKg, actualUsageKg);
  const evidenceDates = [
    session.startedAt,
    session.endedAt,
    ...session.bagUsages.flatMap((usage) => [
      usage.createdAt,
      usage.closedAt,
      usage.bigBag.lastMeasuredAt,
    ]),
    ...sessionFacts.flatMap((fact) => [fact.producedAt, fact.actualCapturedAt]),
    ...sessionDefects.map(({ createdAt }) => createdAt),
  ];

  return {
    bagLinks,
    startKg,
    endKg,
    currentKg,
    actualUsageKg,
    expectedUsageKg,
    producedKg,
    rollCount: sessionFacts.length,
    defectKg,
    defectCount: sessionDefects.length,
    unverifiedDefectCount: sessionDefects.length - verifiedDefects.length,
    deviationKg,
    deviationPercent: deviation === null ? null : round3(deviation * 100),
    status: deviation === null ? 'pending' : balanceStatus(deviation),
    source: {
      usage: 'shift_bag_usage',
      production: 'canonical_roll_weight_capture',
      defects: 'linked_stable_defect_weight_capture',
      latestEvidenceAt: latestEvidenceAt(evidenceDates),
      freshness: aggregateEvidenceFreshness(session.bagUsages),
    },
  };
}

function sessionBigBagFactAttribution(
  session: DirectorEvidenceSessionRow,
  facts: DirectorEvidenceFacts,
): Map<string, BigBagUsageFactAttribution> | null {
  const sessionFacts = facts.rollFacts.filter(({ rootSessionId }) => rootSessionId === session.id);
  const lineIds = new Set(sessionFacts.map(({ lineId }) => lineId));
  const sessionDefects = facts.defects.filter(({ operatorRollLineId }) =>
    lineIds.has(operatorRollLineId),
  );
  const confirmedDefects = sessionDefects.flatMap((defect) => {
    const capture = defect.weightCapture;
    const weightKg = capture?.netKg ?? null;
    if (
      capture === null ||
      capture.operatorRollLineId !== defect.operatorRollLineId ||
      capture.kind !== 'roll' ||
      !capture.stable ||
      weightKg === null ||
      !Number.isFinite(weightKg)
    ) {
      return [];
    }
    return [{ defect, capture, weightKg }];
  });
  const confirmedDefectLineIds = new Set(
    confirmedDefects.map(({ defect }) => defect.operatorRollLineId),
  );
  const confirmedDefectIds = new Set(confirmedDefects.map(({ defect }) => defect.id));

  return attributeBigBagFactsToUsages({
    usageIds: session.bagUsages.map(({ id }) => id),
    windows: session.bagUsages.flatMap((usage) =>
      usage.episodes.map((episode) => ({
        episodeId: episode.id,
        usageId: usage.id,
        openedAt: episode.openedAt,
        closedAt: episode.closedAt,
      })),
    ),
    producedFacts: sessionFacts.map((fact) => ({
      id: fact.leafCaptureId,
      weightKg: confirmedDefectLineIds.has(fact.lineId) ? 0 : fact.actualKg,
      capturedAt: fact.actualCapturedAt,
    })),
    confirmedDefectFacts: confirmedDefects.map(({ defect, capture, weightKg }) => ({
      id: defect.id,
      weightKg,
      capturedAt: capture.createdAt,
    })),
    unverifiedDefectFacts: sessionDefects
      .filter(({ id }) => !confirmedDefectIds.has(id))
      .map((defect) => ({ id: defect.id, capturedAt: defect.createdAt })),
  });
}

function invalidOperatorRollCursor(): never {
  throw new BadRequestException('Invalid analytics cursor');
}

function encodeOperatorRollCursor(value: OperatorRollCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeOperatorRollCursor(value: string): OperatorRollCursor {
  if (
    value.length === 0 ||
    value.length > OPERATOR_ROLL_CURSOR_MAX_LENGTH ||
    !STRICT_BASE64URL.test(value)
  ) {
    return invalidOperatorRollCursor();
  }

  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return invalidOperatorRollCursor();

    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return invalidOperatorRollCursor();
    }

    const keys = Object.keys(parsed).sort();
    if (keys.length !== 2 || keys[0] !== 'producedAt' || keys[1] !== 'rollId') {
      return invalidOperatorRollCursor();
    }

    const cursor = parsed as Partial<OperatorRollCursor>;
    if (
      typeof cursor.producedAt !== 'string' ||
      typeof cursor.rollId !== 'string' ||
      cursor.rollId.trim().length === 0
    ) {
      return invalidOperatorRollCursor();
    }

    const producedAt = new Date(cursor.producedAt);
    if (Number.isNaN(producedAt.getTime()) || producedAt.toISOString() !== cursor.producedAt) {
      return invalidOperatorRollCursor();
    }

    return { producedAt: cursor.producedAt, rollId: cursor.rollId };
  } catch {
    return invalidOperatorRollCursor();
  }
}

function compareDirectorRollFacts(left: DirectorRollFact, right: DirectorRollFact): number {
  const producedAtDifference = right.producedAt.getTime() - left.producedAt.getTime();
  return producedAtDifference === 0
    ? left.rollId.localeCompare(right.rollId)
    : producedAtDifference;
}

@Injectable()
export class DirectorAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffOrders: PayrollTariffOrderRepository,
    private readonly tariffResolver: PayrollTariffResolver,
  ) {}

  async getShiftBalanceEvidence(
    query: DirectorAnalyticsShiftEvidenceQuery,
  ): Promise<DirectorAnalyticsShiftEvidencePage> {
    const range = parseDirectorAnalyticsRange(query);
    const limit = evidenceLimit(query);
    const cursor = query.cursor === undefined ? null : decodeEvidenceCursor(query.cursor, 'shift');

    return collectFilteredEvidencePage({
      limit,
      initialCursor: cursor,
      readChunk: (scanCursor, take) =>
        this.prisma.operatorPostSession.findMany({
          where: buildShiftEvidenceWhere(query, range, scanCursor),
          select: directorEvidenceSessionSelect,
          orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
          take,
        }),
      projectChunk: (sessions) => this.projectShiftEvidenceChunk(sessions, range.toExclusiveUtc),
      matches: (item) => matchesShiftEvidence(item, query),
      cursorOf: shiftEvidenceCursor,
    });
  }

  async getBigBagEvidence(
    query: DirectorAnalyticsBigBagEvidenceQuery,
  ): Promise<DirectorAnalyticsBigBagEvidencePage> {
    const range = parseDirectorAnalyticsRange(query);
    const limit = evidenceLimit(query);
    const cursor = query.cursor === undefined ? null : decodeEvidenceCursor(query.cursor, 'bigbag');

    return collectFilteredEvidencePage({
      limit,
      initialCursor: cursor,
      readChunk: (scanCursor, take) =>
        this.prisma.shiftBagUsage.findMany({
          where: buildBigBagEvidenceWhere(query, range, scanCursor),
          select: directorEvidenceUsageSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take,
        }),
      projectChunk: (usages) => this.projectBigBagEvidenceChunk(usages, range.toExclusiveUtc),
      matches: (item) => matchesBigBagEvidence(item, query),
      cursorOf: bigBagEvidenceCursor,
    });
  }

  private async projectShiftEvidenceChunk(
    sessions: DirectorEvidenceSessionRow[],
    toExclusiveUtc: Date,
  ) {
    const facts = await this.loadEvidenceFacts(
      sessions.map(({ id }) => id),
      toExclusiveUtc,
    );
    return sessions.flatMap((session) => {
      if (session.endedAt === null) return [];
      const metrics = sessionEvidenceMetrics(session, facts);
      const item: DirectorAnalyticsShiftEvidence = {
        sessionId: session.id,
        shiftId: session.shift?.id ?? null,
        shiftLabel: session.shift?.label ?? null,
        operatorId: session.operator.id,
        operatorName: session.operator.displayName,
        postId: session.post.id,
        postCode: session.post.code,
        postName: session.post.name,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt.toISOString(),
        bigBags: metrics.bagLinks,
        startKg: metrics.startKg,
        endKg: metrics.endKg,
        currentKg: metrics.currentKg,
        actualUsageKg: metrics.actualUsageKg,
        expectedUsageKg: metrics.expectedUsageKg,
        producedKg: metrics.producedKg,
        rollCount: metrics.rollCount,
        defectKg: metrics.defectKg,
        defectCount: metrics.defectCount,
        unverifiedDefectCount: metrics.unverifiedDefectCount,
        deviationKg: metrics.deviationKg,
        deviationPercent: metrics.deviationPercent,
        status: metrics.status,
        source: metrics.source,
      };
      return [{ candidate: session, item }];
    });
  }

  private async projectBigBagEvidenceChunk(
    usages: DirectorEvidenceUsageRow[],
    toExclusiveUtc: Date,
  ) {
    const uniqueSessions = [
      ...new Map(usages.map((usage) => [usage.session.id, usage.session])).values(),
    ];
    const facts = await this.loadEvidenceFacts(
      uniqueSessions.map(({ id }) => id),
      toExclusiveUtc,
    );
    const metricsBySession = new Map(
      uniqueSessions.map((session) => [session.id, sessionEvidenceMetrics(session, facts)]),
    );
    const attributionBySession = new Map(
      uniqueSessions.map((session) => [session.id, sessionBigBagFactAttribution(session, facts)]),
    );
    return usages.flatMap((usage) => {
      const metrics = metricsBySession.get(usage.session.id);
      if (!metrics) return [];
      const attribution = attributionBySession.get(usage.session.id)?.get(usage.id) ?? null;
      const currentKg = currentBagKg(usage.bigBag);
      const balance = calculateBigBagBalance({
        initialKg: usage.bigBag.initialKg,
        currentKg,
        producedKg: attribution?.producedKg ?? null,
        confirmedDefectKg: attribution?.confirmedDefectKg ?? null,
      });
      const valuation = valueBigBag({
        kg: currentKg ?? usage.bigBag.initialKg ?? 0,
        priceKopecksPerKg: usage.bigBag.priceKopecksPerKg,
      });
      const item: DirectorBigBagEvidenceWithBalance = {
        id: usage.id,
        bigBagId: usage.bigBag.id,
        bigBagCode: usage.bigBag.code,
        materialId: usage.bigBag.materialId,
        material: usage.bigBag.material,
        bigBagStatus: usage.bigBag.status as DirectorAnalyticsBigBagEvidence['bigBagStatus'],
        sessionId: usage.session.id,
        shiftId: usage.session.shift?.id ?? null,
        shiftLabel: usage.session.shift?.label ?? null,
        operatorId: usage.session.operator.id,
        operatorName: usage.session.operator.displayName,
        postId: usage.session.post.id,
        postCode: usage.session.post.code,
        postName: usage.session.post.name,
        openedAt: usage.createdAt.toISOString(),
        closedAt: usage.closedAt?.toISOString() ?? null,
        startKg: usage.bigBag.initialKg ?? usage.startKg,
        endKg: usage.endKg,
        currentKg,
        currentMeasuredAt: usage.bigBag.lastMeasuredAt?.toISOString() ?? null,
        ...valuation,
        priceEffectiveAt: usage.bigBag.priceEffectiveAt?.toISOString() ?? null,
        bagUsageKg:
          usage.closedAt === null || usage.endKg === null
            ? null
            : round3(usage.startKg - usage.endKg),
        actualUsageKg: balance.actualUsageKg,
        expectedUsageKg:
          attribution === null
            ? null
            : round3(attribution.producedKg + attribution.confirmedDefectKg),
        calculatedRemainderKg: balance.calculatedRemainderKg,
        producedKg: attribution?.producedKg ?? null,
        rollCount: attribution?.rollCount ?? null,
        defectKg: attribution?.confirmedDefectKg ?? null,
        defectCount: attribution?.defectCount ?? null,
        unverifiedDefectCount: attribution?.unverifiedDefectCount ?? null,
        deviationKg: balance.deviationKg,
        deviationPercent: balance.deviationPercent,
        balanceScope: 'usage_episodes',
        status: balance.status,
        source: metrics.source,
      };
      return [{ candidate: usage, item }];
    });
  }

  private async loadEvidenceFacts(
    sessionIds: string[],
    toExclusiveUtc: Date,
  ): Promise<DirectorEvidenceFacts> {
    if (sessionIds.length === 0) return { rollFacts: [], defects: [] };
    const candidateLines = await this.prisma.weightCapture.findMany({
      where: {
        postSessionId: { in: sessionIds },
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        createdAt: { lt: toExclusiveUtc },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
    });
    const candidateLineIds = [
      ...new Set(candidateLines.map(({ operatorRollLineId }) => operatorRollLineId)),
    ];
    if (candidateLineIds.length === 0) return { rollFacts: [], defects: [] };
    const [orderedCaptures, defects] = await Promise.all([
      this.prisma.weightCapture.findMany({
        where: {
          operatorRollLineId: { in: candidateLineIds },
          createdAt: { lt: toExclusiveUtc },
        },
        select: directorRollFactSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.defectRecord.findMany({
        where: {
          operatorRollLineId: { in: candidateLineIds },
          createdAt: { lt: toExclusiveUtc },
        },
        select: directorEvidenceDefectSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      rollFacts: buildDirectorRollFacts(orderedCaptures),
      defects,
    };
  }

  async getOperatorRollVariances(
    query: DirectorOperatorRollVarianceQuery,
  ): Promise<DirectorOperatorRollVariancePage> {
    const range = parseDirectorAnalyticsRange({
      from: query.from,
      to: query.to,
      bucket: 'day',
    });
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('Invalid analytics limit');
    }

    const cursor = query.cursor === undefined ? null : decodeOperatorRollCursor(query.cursor);
    const candidateLines = await this.prisma.weightCapture.findMany({
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        createdAt: { gte: range.fromUtc, lt: range.toExclusiveUtc },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
    });
    const candidateLineIds = [
      ...new Set(candidateLines.map(({ operatorRollLineId }) => operatorRollLineId)),
    ];
    const orderedCaptures =
      candidateLineIds.length === 0
        ? []
        : await this.prisma.weightCapture.findMany({
            where: {
              operatorRollLineId: { in: candidateLineIds },
              createdAt: { lt: range.toExclusiveUtc },
            },
            select: directorRollFactSelect,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
    const facts = buildDirectorRollFacts(
      orderedCaptures.filter(({ createdAt }) => createdAt < range.toExclusiveUtc),
    )
      .filter((fact) => isInHalfOpenRange(fact.producedAt, range.fromUtc, range.toExclusiveUtc))
      .sort(compareDirectorRollFacts);
    const cursorDate = cursor === null ? null : new Date(cursor.producedAt);
    const afterCursor =
      cursor === null || cursorDate === null
        ? facts
        : facts.filter(
            (fact) =>
              fact.producedAt.getTime() < cursorDate.getTime() ||
              (fact.producedAt.getTime() === cursorDate.getTime() &&
                fact.rollId.localeCompare(cursor.rollId) > 0),
          );
    const pageFacts = afterCursor.slice(0, limit + 1);
    const hasNextPage = pageFacts.length > limit;
    const returnedFacts = hasNextPage ? pageFacts.slice(0, limit) : pageFacts;
    const items: DirectorOperatorRollVariance[] = returnedFacts.map((fact) => {
      const { varianceKg, overPlanKg } = rollVariance(fact);
      return {
        operatorId: fact.operatorId,
        operatorName: fact.operatorName,
        orderId: fact.orderId,
        orderNumber: fact.orderNumber,
        rollId: fact.rollId,
        rollCode: fact.rollCode,
        producedAt: fact.producedAt.toISOString(),
        actualCapturedAt: fact.actualCapturedAt.toISOString(),
        plannedKg: fact.plannedKg,
        actualKg: fact.actualKg,
        varianceKg,
        overPlanKg,
        provenance: fact.provenance,
      };
    });
    const lastFact = returnedFacts.at(-1);

    return {
      items,
      nextCursor:
        hasNextPage && lastFact
          ? encodeOperatorRollCursor({
              producedAt: lastFact.producedAt.toISOString(),
              rollId: lastFact.rollId,
            })
          : null,
    };
  }

  async getAnalytics(query: DirectorAnalyticsQuery): Promise<DirectorAnalyticsResponse> {
    const generatedAt = new Date();
    const range = parseDirectorAnalyticsRange(query);
    const fixedWindows = directorAnalyticsFixedWindows(range.to);
    const weekWindow = fixedWindows[0];
    const monthWindow = fixedWindows[1];
    const applicationWindow = fixedWindows[3];
    const rollFactsFromUtc = new Date(
      Math.min(range.fromUtc.getTime(), moscowDateToUtcStart(monthWindow.fromDate).getTime()),
    );
    const applicationFromUtc = moscowDateToUtcStart(applicationWindow.fromDate);
    const touchedUsageWhere = {
      createdAt: { lt: range.toExclusiveUtc },
      OR: [{ closedAt: null }, { closedAt: { gte: range.fromUtc } }],
    };

    const [
      closedSessions,
      rangeUsages,
      selectedBags,
      defects,
      directApplications,
      promotionEvents,
    ] = await Promise.all([
      this.prisma.operatorPostSession.findMany({
        where: {
          status: 'closed',
          endedAt: { gte: range.fromUtc, lt: range.toExclusiveUtc },
        },
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          operator: { select: { id: true, displayName: true } },
          post: { select: { id: true, code: true, name: true } },
          shift: { select: { id: true, label: true } },
          bagUsages: {
            select: {
              id: true,
              bigBagId: true,
              startKg: true,
              endKg: true,
              releasedReason: true,
              createdAt: true,
              closedAt: true,
              episodes: {
                select: {
                  sequence: true,
                  startKg: true,
                  endKg: true,
                  closeKind: true,
                  closedAt: true,
                },
                orderBy: { sequence: 'asc' },
              },
              bigBag: { select: { material: true } },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.shiftBagUsage.findMany({
        where: touchedUsageWhere,
        select: {
          id: true,
          sessionId: true,
          bigBagId: true,
          startKg: true,
          endKg: true,
          createdAt: true,
          closedAt: true,
          session: {
            select: {
              operator: { select: { id: true, displayName: true } },
              post: { select: { id: true, code: true, name: true } },
              shift: { select: { id: true, label: true } },
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.bigBagUnit.findMany({
        where: {
          createdAt: { lt: range.toExclusiveUtc },
          OR: [
            { status: { in: ['available', 'in_use'] } },
            {
              shiftUsages: {
                some: {
                  OR: [
                    { closedAt: { gte: range.fromUtc } },
                    { createdAt: { lt: range.toExclusiveUtc }, closedAt: null },
                  ],
                },
              },
            },
          ],
        },
        select: {
          id: true,
          code: true,
          material: true,
          materialId: true,
          status: true,
          initialKg: true,
          currentKg: true,
          lastMeasuredKg: true,
          lastMeasuredAt: true,
          priceKopecksPerKg: true,
          priceEffectiveAt: true,
          createdAt: true,
        },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.defectRecord.findMany({
        where: {
          createdAt: { gte: range.fromUtc, lt: range.toExclusiveUtc },
        },
        select: {
          id: true,
          operatorRollLineId: true,
          createdAt: true,
          weightCapture: {
            select: {
              operatorRollLineId: true,
              kind: true,
              stable: true,
              netKg: true,
            },
          },
          spoolStockMovement: {
            select: {
              quantity: true,
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.commercialOrder.findMany({
        where: {
          draftedAt: null,
          commercialStage: { not: 'draft' },
          createdAt: { gte: applicationFromUtc, lt: range.toExclusiveUtc },
        },
        select: {
          id: true,
          requestType: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.domainEvent.findMany({
        where: {
          type: 'audit:commercial_draft_promoted',
          objectId: { not: null },
          createdAt: { gte: applicationFromUtc, lt: range.toExclusiveUtc },
        },
        select: {
          id: true,
          objectId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const closedSessionIds = closedSessions.map(({ id }) => id);
    const candidateLines = await this.prisma.weightCapture.findMany({
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        OR: [
          { createdAt: { gte: rollFactsFromUtc, lt: range.toExclusiveUtc } },
          { postSessionId: { in: closedSessionIds } },
        ],
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
    });
    const candidateLineIds = [
      ...new Set(candidateLines.map(({ operatorRollLineId }) => operatorRollLineId)),
    ];
    const orderedCaptures =
      candidateLineIds.length === 0
        ? []
        : await this.prisma.weightCapture.findMany({
            where: {
              operatorRollLineId: { in: candidateLineIds },
              createdAt: {
                lte: new Date(Math.max(generatedAt.getTime(), range.toExclusiveUtc.getTime())),
              },
            },
            select: directorRollFactSelect,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });

    const rollFacts = buildDirectorRollFacts(
      orderedCaptures.filter(({ createdAt }) => createdAt < range.toExclusiveUtc),
    );

    const buckets = enumerateDirectorAnalyticsBuckets(range);
    const productionSeries: DirectorAnalyticsProductionPoint[] = buckets.map(({ key }) => ({
      bucketStartDate: key,
      rollCount: 0,
      producedKg: 0,
    }));
    const productionByBucket = new Map(
      productionSeries.map((point) => [point.bucketStartDate, point]),
    );
    for (const fact of rollFacts) {
      if (!isInHalfOpenRange(fact.producedAt, range.fromUtc, range.toExclusiveUtc)) continue;
      const point = productionByBucket.get(
        directorAnalyticsBucketKey(fact.producedAt, range.bucket),
      );
      if (!point) continue;
      point.rollCount += 1;
      point.producedKg += fact.actualKg;
    }
    productionSeries.forEach((point) => {
      point.producedKg = round3(point.producedKg);
    });

    const materialSeries: DirectorAnalyticsMaterialPoint[] = productionSeries.map((point) => ({
      bucketStartDate: point.bucketStartDate,
      expectedUsageKg: point.producedKg,
      actualUsageKg: 0,
    }));
    const materialByBucket = new Map(materialSeries.map((point) => [point.bucketStartDate, point]));
    for (const usage of rangeUsages) {
      if (
        usage.closedAt === null ||
        usage.endKg === null ||
        !isInHalfOpenRange(usage.closedAt, range.fromUtc, range.toExclusiveUtc)
      ) {
        continue;
      }
      const point = materialByBucket.get(directorAnalyticsBucketKey(usage.closedAt, range.bucket));
      if (!point) continue;
      point.actualUsageKg += usage.startKg - usage.endKg;
    }
    materialSeries.forEach((point) => {
      point.actualUsageKg = round3(point.actualUsageKg);
    });

    const selectedVariances = rollFacts
      .filter((fact) => isInHalfOpenRange(fact.producedAt, range.fromUtc, range.toExclusiveUtc))
      .map(rollVariance);
    const overPlanSeries: DirectorAnalyticsOverPlanSeriesPoint[] = buckets.map(({ key }) => ({
      bucketStartDate: key,
      affectedRollCount: 0,
      affectedOperatorCount: 0,
      overPlanKg: 0,
    }));
    const overPlanByBucket = new Map(overPlanSeries.map((point) => [point.bucketStartDate, point]));
    const affectedOperatorsByBucket = new Map<string, Set<string>>();
    const topOperatorsById = new Map<
      string,
      {
        operatorId: string;
        operatorName: string;
        affectedRollCount: number;
        overPlanKg: number;
      }
    >();
    for (const { fact, overPlanKg } of selectedVariances) {
      if (
        overPlanKg === null ||
        overPlanKg <= 0 ||
        fact.operatorId === null ||
        fact.operatorName === null
      ) {
        continue;
      }
      const bucketKey = directorAnalyticsBucketKey(fact.producedAt, range.bucket);
      const point = overPlanByBucket.get(bucketKey);
      if (!point) continue;
      point.affectedRollCount += 1;
      point.overPlanKg += overPlanKg;
      const operators = affectedOperatorsByBucket.get(bucketKey) ?? new Set<string>();
      operators.add(fact.operatorId);
      affectedOperatorsByBucket.set(bucketKey, operators);

      const operator = topOperatorsById.get(fact.operatorId) ?? {
        operatorId: fact.operatorId,
        operatorName: fact.operatorName,
        affectedRollCount: 0,
        overPlanKg: 0,
      };
      operator.affectedRollCount += 1;
      operator.overPlanKg += overPlanKg;
      topOperatorsById.set(fact.operatorId, operator);
    }
    overPlanSeries.forEach((point) => {
      point.affectedOperatorCount = affectedOperatorsByBucket.get(point.bucketStartDate)?.size ?? 0;
      point.overPlanKg = round3(point.overPlanKg);
    });

    const overPlanWindows = [
      {
        period: 'week' as const,
        fromDate: weekWindow.fromDate,
        toDate: weekWindow.toDate,
      },
      {
        period: 'month' as const,
        fromDate: monthWindow.fromDate,
        toDate: monthWindow.toDate,
      },
    ];
    const overPlanTotals = overPlanWindows.map((window) => {
      const fromUtc = moscowDateToUtcStart(window.fromDate);
      const affectedOperators = new Set<string>();
      let affectedRollCount = 0;
      let overPlanKg = 0;

      for (const fact of rollFacts) {
        if (
          !isInHalfOpenRange(fact.producedAt, fromUtc, range.toExclusiveUtc) ||
          fact.operatorId === null ||
          fact.operatorName === null
        ) {
          continue;
        }
        const variance = rollVariance(fact);
        if (variance.overPlanKg === null || variance.overPlanKg <= 0) continue;
        affectedRollCount += 1;
        affectedOperators.add(fact.operatorId);
        overPlanKg += variance.overPlanKg;
      }

      return {
        ...window,
        affectedRollCount,
        affectedOperatorCount: affectedOperators.size,
        overPlanKg: round3(overPlanKg),
      };
    });
    const operatorOverPlan: DirectorAnalyticsOperatorOverPlan = {
      series: overPlanSeries,
      totals: overPlanTotals,
      topOperators: [...topOperatorsById.values()]
        .map((operator) => ({ ...operator, overPlanKg: round3(operator.overPlanKg) }))
        .sort(
          (left, right) =>
            right.overPlanKg - left.overPlanKg ||
            left.operatorName.localeCompare(right.operatorName) ||
            left.operatorId.localeCompare(right.operatorId),
        ),
      missingPlanCount: selectedVariances.filter(({ fact }) => fact.plannedKg === null).length,
      missingActorCount: selectedVariances.filter(({ fact }) => fact.operatorId === null).length,
    };

    const productionQualitySeries: DirectorAnalyticsProductionQualityPoint[] = productionSeries.map(
      (point) => ({
        id: `${range.bucket}:${point.bucketStartDate}`,
        bucketStartDate: point.bucketStartDate,
        producedRollCount: point.rollCount,
        producedKg: point.producedKg,
        defectRecordCount: 0,
        defectiveRollCount: 0,
        verifiedDefectKg: 0,
        unverifiedDefectCount: 0,
        returnedSpoolCount: 0,
      }),
    );
    const qualityByBucket = new Map(
      productionQualitySeries.map((point) => [point.bucketStartDate, point]),
    );
    const defectiveLinesByBucket = new Map<string, Set<string>>();
    for (const defect of defects) {
      const bucketKey = directorAnalyticsBucketKey(defect.createdAt, range.bucket);
      const point = qualityByBucket.get(bucketKey);
      if (!point) continue;
      point.defectRecordCount += 1;
      const lines = defectiveLinesByBucket.get(bucketKey) ?? new Set<string>();
      lines.add(defect.operatorRollLineId);
      defectiveLinesByBucket.set(bucketKey, lines);

      const evidence = defect.weightCapture;
      if (
        evidence !== null &&
        evidence.operatorRollLineId === defect.operatorRollLineId &&
        evidence.kind === 'roll' &&
        evidence.stable &&
        evidence.netKg !== null &&
        Number.isFinite(evidence.netKg)
      ) {
        point.verifiedDefectKg += evidence.netKg;
      } else {
        point.unverifiedDefectCount += 1;
      }
      point.returnedSpoolCount += defect.spoolStockMovement?.quantity ?? 0;
    }
    productionQualitySeries.forEach((point) => {
      point.defectiveRollCount = defectiveLinesByBucket.get(point.bucketStartDate)?.size ?? 0;
      point.verifiedDefectKg = round3(point.verifiedDefectKg);
    });

    const materialSpendSeries: DirectorAnalyticsMaterialSpendPoint[] = buckets.map(({ key }) => ({
      bucketStartDate: key,
      consumedGranulesKg: 0,
      recordedSpoolCount: 0,
      recordedSpoolTareKg: 0,
      missingSpoolEvidenceCount: 0,
    }));
    const materialSpendByBucket = new Map(
      materialSpendSeries.map((point) => [point.bucketStartDate, point]),
    );
    for (const usage of rangeUsages) {
      if (
        usage.closedAt === null ||
        usage.endKg === null ||
        !isInHalfOpenRange(usage.closedAt, range.fromUtc, range.toExclusiveUtc)
      ) {
        continue;
      }
      const point = materialSpendByBucket.get(
        directorAnalyticsBucketKey(usage.closedAt, range.bucket),
      );
      if (point) point.consumedGranulesKg += usage.startKg - usage.endKg;
    }
    for (const { fact } of selectedVariances) {
      const point = materialSpendByBucket.get(
        directorAnalyticsBucketKey(fact.producedAt, range.bucket),
      );
      if (!point) continue;
      if (fact.spoolTareKg === null) {
        point.missingSpoolEvidenceCount += 1;
      } else {
        point.recordedSpoolCount += 1;
        point.recordedSpoolTareKg += fact.spoolTareKg;
      }
    }
    materialSpendSeries.forEach((point) => {
      point.consumedGranulesKg = round3(point.consumedGranulesKg);
      point.recordedSpoolTareKg = round3(point.recordedSpoolTareKg);
    });

    const factsBySession = new Map<string, DirectorRollFact[]>();
    for (const fact of rollFacts) {
      if (fact.rootSessionId === null) continue;
      const facts = factsBySession.get(fact.rootSessionId) ?? [];
      facts.push(fact);
      factsBySession.set(fact.rootSessionId, facts);
    }
    const payrollFactsBySession = new Map<string, DirectorRollFact[]>();
    for (const fact of buildDirectorRollFacts(
      orderedCaptures.filter(({ createdAt }) => createdAt <= generatedAt),
    )) {
      if (fact.rootSessionId === null) continue;
      const facts = payrollFactsBySession.get(fact.rootSessionId) ?? [];
      facts.push(fact);
      payrollFactsBySession.set(fact.rootSessionId, facts);
    }
    const maxSessionEndedAtMs = closedSessions.reduce(
      (max, session) => Math.max(max, session.endedAt?.getTime() ?? Number.NEGATIVE_INFINITY),
      Number.NEGATIVE_INFINITY,
    );
    const payrollSchedule = Number.isFinite(maxSessionEndedAtMs)
      ? await this.tariffOrders.loadPublishedSchedule(new Date(maxSessionEndedAtMs))
      : [];
    const shiftBalances: DirectorAnalyticsShiftBalance[] = [];
    for (const session of closedSessions) {
      if (session.endedAt === null) continue;
      const facts = factsBySession.get(session.id) ?? [];
      const producedKg = round3(facts.reduce((sum, fact) => sum + fact.actualKg, 0));
      const expectedUsageKg = producedKg;
      const canonicalUsages = session.bagUsages.map((usage) => ({
        source: usage,
        facts: resolveCanonicalShiftBagUsageFacts({
          ...usage,
          releasedReason: usage.releasedReason ?? null,
          episodes: usage.episodes ?? [],
        }),
      }));
      const completeUsage = canonicalUsages.every(({ facts }) => facts.actualUsageKg !== null);
      const actualUsageKg = completeUsage
        ? round3(canonicalUsages.reduce((sum, { facts }) => sum + (facts.actualUsageKg ?? 0), 0))
        : null;
      const payrollRolls = (payrollFactsBySession.get(session.id) ?? [])
        .filter(
          (fact) => fact.actualKg > 0 && (fact.defectAt === null || fact.defectAt > generatedAt),
        )
        .map((fact) => ({ grams: Math.round(fact.actualKg * 1_000), birka: fact.birka }));
      const payrollRate = this.tariffResolver.resolveSession(payrollSchedule, {
        postName: session.post.name,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        processedGrams: payrollRolls.reduce((sum, roll) => sum + roll.grams, 0),
        rolls: payrollRolls,
        materialNames: canonicalUsages.map(({ source }) => source.bigBag?.material ?? ''),
      });
      const payroll =
        payrollRate.kind === 'resolved'
          ? {
              status: 'resolved' as const,
              tariffOrder: payrollRate.groups[0]!.tariffOrder,
              rateKopecksPerKg:
                payrollRate.groups.length === 1 ? payrollRate.groups[0]!.rateKopecksPerKg : null,
              amountKopecks: payrollRate.groups.reduce(
                (sum, group) => sum + group.amountKopecks,
                0,
              ),
              tariffRule:
                payrollRate.groups.length === 1 ? payrollRate.groups[0]!.tariffRule : null,
              basisLabel:
                payrollRate.groups.length === 1
                  ? payrollRate.groups[0]!.basisLabel
                  : payrollRate.groups
                      .map(
                        (group) =>
                          `${group.materialClass === 'primary' ? 'Первичка' : group.materialClass === 'secondary' ? 'Вторичка' : 'Тонкие рулоны'}: ${(group.payableGrams / 1_000).toFixed(3)} кг × ${group.rateKopecksPerKg / 100} ₽/кг`,
                      )
                      .join('; '),
            }
          : {
              status: 'unresolved' as const,
              reasons: payrollRate.reasons,
            };
      const deviation =
        actualUsageKg === null ? null : balanceDeviation(expectedUsageKg, actualUsageKg);
      shiftBalances.push({
        sessionId: session.id,
        shiftId: session.shift?.id ?? null,
        shiftLabel: session.shift?.label ?? null,
        operatorId: session.operator.id,
        operatorName: session.operator.displayName,
        postId: session.post.id,
        postCode: session.post.code,
        postName: session.post.name,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt.toISOString(),
        rollCount: facts.length,
        producedKg,
        expectedUsageKg,
        actualUsageKg,
        deviationPercent: deviation === null ? null : round3(deviation * 100),
        status: deviation === null ? 'pending' : balanceStatus(deviation),
        payroll,
      });
    }

    const touchedUsages = rangeUsages.filter(
      (usage) =>
        usage.createdAt < range.toExclusiveUtc &&
        (usage.closedAt === null || usage.closedAt >= range.fromUtc),
    );
    const historyByBag = new Map<string, DirectorAnalyticsBigBagUsage[]>();
    for (const usage of touchedUsages) {
      const history = historyByBag.get(usage.bigBagId) ?? [];
      history.push({
        id: usage.id,
        sessionId: usage.sessionId,
        shiftId: usage.session.shift?.id ?? null,
        shiftLabel: usage.session.shift?.label ?? null,
        operatorId: usage.session.operator.id,
        operatorName: usage.session.operator.displayName,
        postId: usage.session.post.id,
        postCode: usage.session.post.code,
        postName: usage.session.post.name,
        startKg: usage.startKg,
        endKg: usage.endKg,
        deltaKg: usage.endKg === null ? null : round3(usage.startKg - usage.endKg),
        openedAt: usage.createdAt.toISOString(),
        closedAt: usage.closedAt?.toISOString() ?? null,
      });
      historyByBag.set(usage.bigBagId, history);
    }
    const bigBags: DirectorAnalyticsBigBag[] = selectedBags.map((bag) => {
      const measuredKg = bag.currentKg ?? bag.lastMeasuredKg ?? null;
      const valuation = valueBigBag({
        kg: measuredKg ?? bag.initialKg ?? 0,
        priceKopecksPerKg: bag.priceKopecksPerKg,
      });
      return {
        id: bag.id,
        code: bag.code,
        materialId: bag.materialId,
        material: bag.material,
        status: bag.status as DirectorAnalyticsBigBag['status'],
        initialKg: bag.initialKg,
        ...valuation,
        priceEffectiveAt: bag.priceEffectiveAt?.toISOString() ?? null,
        currentSnapshot: {
          measuredKg,
          measuredAt: bag.lastMeasuredAt?.toISOString() ?? null,
        },
        usageHistory: historyByBag.get(bag.id) ?? [],
      };
    });

    const earliestPromotionByOrder = new Map<string, Date>();
    for (const event of promotionEvents) {
      if (event.objectId === null) continue;
      const current = earliestPromotionByOrder.get(event.objectId);
      if (current === undefined || event.createdAt < current) {
        earliestPromotionByOrder.set(event.objectId, event.createdAt);
      }
    }
    const promotedOrderIds = [...earliestPromotionByOrder.keys()];
    const promotedApplications =
      promotedOrderIds.length === 0
        ? []
        : await this.prisma.commercialOrder.findMany({
            where: { id: { in: promotedOrderIds } },
            select: { id: true, requestType: true },
            orderBy: [{ id: 'asc' }],
          });
    const promotedRequestTypeById = new Map(
      promotedApplications.map((application) => [application.id, application.requestType]),
    );
    const submittedApplications = [
      ...directApplications.map((application) => ({
        submittedAt: application.createdAt,
        requestType: application.requestType,
      })),
      ...promotedOrderIds.flatMap((orderId) => {
        const requestType = promotedRequestTypeById.get(orderId);
        const submittedAt = earliestPromotionByOrder.get(orderId);
        return requestType === undefined || submittedAt === undefined
          ? []
          : [{ submittedAt, requestType }];
      }),
    ];
    const commercialApplications: DirectorCommercialApplications = {
      definition: 'submitted',
      asOfDate: range.to,
      periods: fixedWindows.map((window) => {
        const fromUtc = moscowDateToUtcStart(window.fromDate);
        const applications = submittedApplications.filter(({ submittedAt }) =>
          isInHalfOpenRange(submittedAt, fromUtc, range.toExclusiveUtc),
        );
        const clientOrderCount = applications.filter(
          ({ requestType }) => requestType === 'client_order',
        ).length;
        const stockReserveCount = applications.filter(
          ({ requestType }) => requestType === 'stock_reserve',
        ).length;
        return {
          period: window.period,
          fromDate: window.fromDate,
          toDate: window.toDate,
          totalCount: clientOrderCount + stockReserveCount,
          clientOrderCount,
          stockReserveCount,
        };
      }),
    };
    const spoolEvidence = {
      availability: 'measured_evidence_only' as const,
      explanation:
        'Spool tare is measured production evidence, not exact warehouse inventory consumption.',
    };
    const accountingProduction = await buildDirectorAccountingProduction(this.prisma, range);

    return {
      range: {
        timezone: range.timezone,
        requested: { from: range.from, to: range.to },
        effective: {
          fromUtc: range.fromUtc.toISOString(),
          toExclusiveUtc: range.toExclusiveUtc.toISOString(),
        },
        bucket: range.bucket,
        generatedAt: new Date().toISOString(),
      },
      productionSeries,
      materialSeries,
      shiftBalances,
      bigBags,
      operatorOverPlan,
      productionQualitySeries,
      materialSpendSeries,
      spoolEvidence,
      commercialApplications,
      accountingProduction,
    };
  }
}
