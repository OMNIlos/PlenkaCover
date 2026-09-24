import type {
  DirectorAnalyticsBigBagEvidence,
  DirectorAnalyticsBigBagEvidenceQuery,
  DirectorAnalyticsEvidenceQueryBase,
  DirectorAnalyticsShiftEvidence,
  DirectorAnalyticsShiftEvidenceQuery,
} from '@plenka/contracts';
import { directorAnalyticsBucketKey } from './director-analytics.time';

type EvidenceRow = Pick<
  DirectorAnalyticsShiftEvidence,
  | 'sessionId'
  | 'shiftId'
  | 'shiftLabel'
  | 'operatorId'
  | 'operatorName'
  | 'postId'
  | 'postCode'
  | 'postName'
  | 'status'
  | 'source'
>;

function inRange(value: number | null, min: number | undefined, max: number | undefined): boolean {
  if (min === undefined && max === undefined) return true;
  if (value === null || !Number.isFinite(value)) return false;
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

function contains(value: string | null, query: string | undefined): boolean {
  if (!query) return true;
  return value?.toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU')) ?? false;
}

function containsAny(values: Array<string | null>, query: string | undefined): boolean {
  return !query || values.some((value) => contains(value, query));
}

function equals(value: string | null, expected: string | undefined): boolean {
  return expected === undefined || value === expected;
}

function isWithinMoscowDates(
  value: string | null,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (from === undefined && to === undefined) return true;
  if (value === null) return false;

  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return false;

  const date = directorAnalyticsBucketKey(timestamp, 'day');
  return (from === undefined || date >= from) && (to === undefined || date <= to);
}

function matchesBaseEvidence(row: EvidenceRow, query: DirectorAnalyticsEvidenceQueryBase): boolean {
  return (
    equals(row.operatorId, query.operatorId) &&
    equals(row.postId, query.postId) &&
    equals(row.shiftId, query.shiftId) &&
    equals(row.status, query.status) &&
    equals(row.source.freshness, query.freshness) &&
    containsAny([row.sessionId, row.shiftId, row.shiftLabel], query.shiftQuery) &&
    containsAny([row.operatorId, row.operatorName], query.operatorQuery) &&
    containsAny([row.postId, row.postCode, row.postName], query.postQuery) &&
    isWithinMoscowDates(
      row.source.latestEvidenceAt,
      query.latestEvidenceFrom,
      query.latestEvidenceTo,
    )
  );
}

export function matchesShiftEvidence(
  row: DirectorAnalyticsShiftEvidence,
  query: DirectorAnalyticsShiftEvidenceQuery,
): boolean {
  const remainingKg = row.currentKg ?? row.endKg;
  const safeSearchValues = [
    row.sessionId,
    row.shiftId,
    row.shiftLabel,
    row.operatorName,
    row.postCode,
    row.postName,
    ...row.bigBags.flatMap((bigBag) => [bigBag.bigBagCode, bigBag.material]),
  ];

  return (
    matchesBaseEvidence(row, query) &&
    (query.bigBagId === undefined ||
      row.bigBags.some((bigBag) => bigBag.bigBagId === query.bigBagId)) &&
    containsAny(safeSearchValues, query.q) &&
    isWithinMoscowDates(row.startedAt, query.startedFrom, query.startedTo) &&
    isWithinMoscowDates(row.endedAt, query.endedFrom, query.endedTo) &&
    inRange(row.startKg, query.startKgMin, query.startKgMax) &&
    inRange(remainingKg, query.remainingKgMin, query.remainingKgMax) &&
    inRange(row.actualUsageKg, query.actualUsageKgMin, query.actualUsageKgMax) &&
    inRange(row.expectedUsageKg, query.expectedUsageKgMin, query.expectedUsageKgMax) &&
    inRange(row.producedKg, query.producedKgMin, query.producedKgMax) &&
    inRange(row.rollCount, query.rollCountMin, query.rollCountMax) &&
    inRange(row.defectKg, query.defectKgMin, query.defectKgMax) &&
    inRange(row.defectCount, query.defectCountMin, query.defectCountMax) &&
    inRange(
      row.unverifiedDefectCount,
      query.unverifiedDefectCountMin,
      query.unverifiedDefectCountMax,
    ) &&
    inRange(row.deviationKg, query.deviationKgMin, query.deviationKgMax) &&
    inRange(row.deviationPercent, query.deviationPercentMin, query.deviationPercentMax)
  );
}

export function matchesBigBagEvidence(
  row: DirectorAnalyticsBigBagEvidence,
  query: DirectorAnalyticsBigBagEvidenceQuery,
): boolean {
  const safeSearchValues = [
    row.sessionId,
    row.shiftId,
    row.shiftLabel,
    row.operatorName,
    row.postCode,
    row.postName,
    row.bigBagCode,
    row.material,
  ];

  return (
    matchesBaseEvidence(row, query) &&
    equals(row.bigBagId, query.bigBagId) &&
    equals(row.bigBagStatus, query.bigBagStatus) &&
    containsAny([row.bigBagId, row.bigBagCode], query.bigBagQuery) &&
    containsAny([row.materialId, row.material], query.materialQuery) &&
    containsAny(safeSearchValues, query.q) &&
    isWithinMoscowDates(row.openedAt, query.openedFrom, query.openedTo) &&
    isWithinMoscowDates(row.closedAt, query.closedFrom, query.closedTo) &&
    (query.usageState === undefined ||
      (query.usageState === 'open' ? row.closedAt === null : row.closedAt !== null)) &&
    inRange(row.startKg, query.startKgMin, query.startKgMax) &&
    inRange(row.endKg, query.endKgMin, query.endKgMax) &&
    inRange(row.currentKg, query.currentKgMin, query.currentKgMax) &&
    inRange(row.bagUsageKg, query.bagUsageKgMin, query.bagUsageKgMax) &&
    inRange(row.actualUsageKg, query.actualUsageKgMin, query.actualUsageKgMax) &&
    inRange(row.expectedUsageKg, query.expectedUsageKgMin, query.expectedUsageKgMax) &&
    inRange(row.producedKg, query.producedKgMin, query.producedKgMax) &&
    inRange(row.rollCount, query.rollCountMin, query.rollCountMax) &&
    inRange(row.defectKg, query.defectKgMin, query.defectKgMax) &&
    inRange(row.defectCount, query.defectCountMin, query.defectCountMax) &&
    inRange(
      row.unverifiedDefectCount,
      query.unverifiedDefectCountMin,
      query.unverifiedDefectCountMax,
    ) &&
    inRange(row.deviationKg, query.deviationKgMin, query.deviationKgMax) &&
    inRange(row.deviationPercent, query.deviationPercentMin, query.deviationPercentMax)
  );
}
