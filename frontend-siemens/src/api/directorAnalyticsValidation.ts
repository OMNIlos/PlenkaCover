import type {
  DirectorAnalyticsQuery,
  ServerDirectorAnalyticsBigBagEvidencePage,
  ServerDirectorAnalyticsResponse,
  ServerDirectorAnalyticsShiftBalancePage,
  ServerDirectorOperatorRollVariancePage,
} from './director';

type Validator = (value: unknown) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shape(
  required: Record<string, Validator>,
  optional: Record<string, Validator> = {},
): Validator {
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  return (value) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) return false;
    for (const [key, validate] of Object.entries(required)) {
      if (!Object.hasOwn(value, key) || !validate(value[key])) return false;
    }
    for (const [key, validate] of Object.entries(optional)) {
      if (Object.hasOwn(value, key) && !validate(value[key])) return false;
    }
    return true;
  };
}

function arrayOf(validate: Validator): Validator {
  return (value) => Array.isArray(value) && value.every(validate);
}

function nullable(validate: Validator): Validator {
  return (value) => value === null || validate(value);
}

function oneOf<const T extends readonly unknown[]>(values: T): Validator {
  return (value) => values.includes(value);
}

const nonEmptyString: Validator = (value) => typeof value === 'string' && value.trim().length > 0;
const finiteNumber: Validator = (value) => typeof value === 'number' && Number.isFinite(value);
const nonNegativeNumber: Validator = (value) => finiteNumber(value) && (value as number) >= 0;
const nonNegativeInteger: Validator = (value) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const booleanValue: Validator = (value) => typeof value === 'boolean';

const dateKey: Validator = (value) => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
};

const timestamp: Validator = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
  Number.isFinite(Date.parse(value));

const payrollTariffOrderReference = shape({
  id: nonEmptyString,
  name: nonEmptyString,
  effectiveFrom: dateKey,
  currency: oneOf(['RUB'] as const),
});

const resolvedShiftPayroll = shape({
  status: oneOf(['resolved'] as const),
  tariffOrder: payrollTariffOrderReference,
  rateKopecksPerKg: nullable(nonNegativeInteger),
  amountKopecks: nonNegativeInteger,
  tariffRule: nullable(oneOf([
    'primary',
    'secondary',
    'thin_roll',
    'abc_standard',
    'abc_black_white',
    'alabuga_override',
  ] as const)),
  basisLabel: nonEmptyString,
});

const unresolvedShiftPayroll = shape({
  status: oneOf(['unresolved'] as const),
  reasons: arrayOf(
    oneOf([
      'before_policy_effective_date',
      'shift_not_closed',
      'production_operator_unresolved',
      'post_session_unresolved',
      'shift_unresolved',
      'machine_family_unresolved',
      'shift_duration_unresolved',
      'material_class_unresolved',
      'film_type_unresolved',
      'counterparty_unresolved',
    ] as const),
  ),
});

const shiftPayroll: Validator = (value) =>
  (isRecord(value) &&
    resolvedShiftPayroll(value) &&
    (value.rateKopecksPerKg === null) === (value.tariffRule === null)) ||
  unresolvedShiftPayroll(value);

const productionPoint = shape({
  bucketStartDate: dateKey,
  rollCount: nonNegativeInteger,
  producedKg: finiteNumber,
});

const materialPoint = shape({
  bucketStartDate: dateKey,
  expectedUsageKg: nullable(nonNegativeNumber),
  actualUsageKg: finiteNumber,
});

const shiftBalance = shape({
  sessionId: nonEmptyString,
  shiftId: nullable(nonEmptyString),
  shiftLabel: nullable(nonEmptyString),
  operatorId: nonEmptyString,
  operatorName: nonEmptyString,
  postId: nonEmptyString,
  postCode: nonEmptyString,
  postName: nonEmptyString,
  startedAt: timestamp,
  endedAt: timestamp,
  rollCount: nonNegativeInteger,
  producedKg: finiteNumber,
  expectedUsageKg: nonNegativeNumber,
  actualUsageKg: nullable(finiteNumber),
  deviationPercent: nullable(finiteNumber),
  status: oneOf(['pending', 'ok', 'mismatch'] as const),
  payroll: shiftPayroll,
});

const bigBagUsage = shape({
  id: nonEmptyString,
  sessionId: nonEmptyString,
  shiftId: nullable(nonEmptyString),
  shiftLabel: nullable(nonEmptyString),
  operatorId: nonEmptyString,
  operatorName: nonEmptyString,
  postId: nonEmptyString,
  postCode: nonEmptyString,
  postName: nonEmptyString,
  startKg: finiteNumber,
  endKg: nullable(finiteNumber),
  deltaKg: nullable(finiteNumber),
  openedAt: timestamp,
  closedAt: nullable(timestamp),
});

const bigBag = shape({
  id: nonEmptyString,
  code: nonEmptyString,
  materialId: nullable(nonEmptyString),
  material: nonEmptyString,
  status: oneOf(['available', 'in_use', 'consumed'] as const),
  initialKg: nullable(finiteNumber),
  priceKopecksPerKg: nullable(nonNegativeInteger),
  totalKopecks: nullable(nonNegativeInteger),
  priceEffectiveAt: nullable(timestamp),
  currentSnapshot: shape({
    measuredKg: nullable(finiteNumber),
    measuredAt: nullable(timestamp),
  }),
  usageHistory: arrayOf(bigBagUsage),
});

const evidenceSource = shape({
  usage: oneOf(['shift_bag_usage'] as const),
  production: oneOf(['canonical_roll_weight_capture'] as const),
  defects: oneOf(['linked_stable_defect_weight_capture'] as const),
  latestEvidenceAt: nullable(timestamp),
  freshness: oneOf(['fresh', 'stale', 'unknown'] as const),
});

const shiftBigBag = shape({
  usageId: nonEmptyString,
  bigBagId: nonEmptyString,
  bigBagCode: nonEmptyString,
  materialId: nullable(nonEmptyString),
  material: nonEmptyString,
  bigBagStatus: oneOf(['available', 'in_use', 'consumed'] as const),
  startKg: finiteNumber,
  endKg: nullable(finiteNumber),
  currentKg: nullable(finiteNumber),
  currentMeasuredAt: nullable(timestamp),
  currentFreshness: oneOf(['fresh', 'stale', 'unknown'] as const),
  openedAt: timestamp,
  closedAt: nullable(timestamp),
});

const shiftBalanceEvidence = shape({
  sessionId: nonEmptyString,
  shiftId: nullable(nonEmptyString),
  shiftLabel: nullable(nonEmptyString),
  operatorId: nonEmptyString,
  operatorName: nonEmptyString,
  postId: nonEmptyString,
  postCode: nonEmptyString,
  postName: nonEmptyString,
  startedAt: timestamp,
  endedAt: timestamp,
  bigBags: arrayOf(shiftBigBag),
  startKg: nullable(finiteNumber),
  endKg: nullable(finiteNumber),
  currentKg: nullable(finiteNumber),
  actualUsageKg: nullable(finiteNumber),
  expectedUsageKg: nonNegativeNumber,
  producedKg: finiteNumber,
  rollCount: nonNegativeInteger,
  defectKg: nonNegativeNumber,
  defectCount: nonNegativeInteger,
  unverifiedDefectCount: nonNegativeInteger,
  deviationKg: nullable(finiteNumber),
  deviationPercent: nullable(finiteNumber),
  status: oneOf(['pending', 'ok', 'mismatch'] as const),
  source: evidenceSource,
});

const bigBagEvidence = shape({
  id: nonEmptyString,
  bigBagId: nonEmptyString,
  bigBagCode: nonEmptyString,
  materialId: nullable(nonEmptyString),
  material: nonEmptyString,
  bigBagStatus: oneOf(['available', 'in_use', 'consumed'] as const),
  sessionId: nonEmptyString,
  shiftId: nullable(nonEmptyString),
  shiftLabel: nullable(nonEmptyString),
  operatorId: nonEmptyString,
  operatorName: nonEmptyString,
  postId: nonEmptyString,
  postCode: nonEmptyString,
  postName: nonEmptyString,
  openedAt: timestamp,
  closedAt: nullable(timestamp),
  startKg: finiteNumber,
  endKg: nullable(finiteNumber),
  currentKg: nullable(finiteNumber),
  currentMeasuredAt: nullable(timestamp),
  priceKopecksPerKg: nullable(nonNegativeInteger),
  totalKopecks: nullable(nonNegativeInteger),
  priceEffectiveAt: nullable(timestamp),
  bagUsageKg: nullable(finiteNumber),
  actualUsageKg: nullable(finiteNumber),
  expectedUsageKg: nullable(nonNegativeNumber),
  calculatedRemainderKg: nullable(finiteNumber),
  producedKg: nullable(finiteNumber),
  rollCount: nullable(nonNegativeInteger),
  defectKg: nullable(nonNegativeNumber),
  defectCount: nullable(nonNegativeInteger),
  unverifiedDefectCount: nullable(nonNegativeInteger),
  deviationKg: nullable(finiteNumber),
  deviationPercent: nullable(finiteNumber),
  balanceScope: oneOf(['usage_episodes'] as const),
  status: oneOf(['pending', 'ok', 'mismatch'] as const),
  source: evidenceSource,
});

const operatorRollVariance = shape({
  operatorId: nullable(nonEmptyString),
  operatorName: nullable(nonEmptyString),
  orderId: nonEmptyString,
  orderNumber: nonEmptyString,
  rollId: nonEmptyString,
  rollCode: nonEmptyString,
  producedAt: timestamp,
  actualCapturedAt: timestamp,
  plannedKg: nullable(finiteNumber),
  actualKg: finiteNumber,
  varianceKg: nullable(finiteNumber),
  overPlanKg: nullable(nonNegativeNumber),
  provenance: oneOf(['post_session', 'operation_actor', 'actor_missing', 'plan_missing'] as const),
});

const pageOf = (item: Validator): Validator =>
  shape({ items: arrayOf(item), nextCursor: nullable(nonEmptyString) });

const shiftBalancePage = pageOf(shiftBalanceEvidence);
const bigBagEvidencePage = pageOf(bigBagEvidence);
const operatorRollVariancePage = pageOf(operatorRollVariance);

const overPlanSeriesPoint = shape({
  bucketStartDate: dateKey,
  affectedRollCount: nonNegativeInteger,
  affectedOperatorCount: nonNegativeInteger,
  overPlanKg: nonNegativeNumber,
});

const overPlanTotal = shape({
  period: oneOf(['week', 'month'] as const),
  fromDate: dateKey,
  toDate: dateKey,
  affectedRollCount: nonNegativeInteger,
  affectedOperatorCount: nonNegativeInteger,
  overPlanKg: nonNegativeNumber,
});

const topOperator = shape({
  operatorId: nonEmptyString,
  operatorName: nonEmptyString,
  affectedRollCount: nonNegativeInteger,
  overPlanKg: nonNegativeNumber,
});

const operatorOverPlan = shape({
  series: arrayOf(overPlanSeriesPoint),
  totals: arrayOf(overPlanTotal),
  topOperators: arrayOf(topOperator),
  missingPlanCount: nonNegativeInteger,
  missingActorCount: nonNegativeInteger,
});

const productionQualityPoint = shape(
  {
    id: nonEmptyString,
    bucketStartDate: dateKey,
    producedRollCount: nonNegativeInteger,
    producedKg: finiteNumber,
    defectRecordCount: nonNegativeInteger,
    defectiveRollCount: nonNegativeInteger,
    verifiedDefectKg: nonNegativeNumber,
    unverifiedDefectCount: nonNegativeInteger,
  },
  { returnedSpoolCount: nonNegativeInteger },
);

const materialSpendPoint = shape({
  bucketStartDate: dateKey,
  consumedGranulesKg: nonNegativeNumber,
  recordedSpoolCount: nonNegativeInteger,
  recordedSpoolTareKg: nonNegativeNumber,
  missingSpoolEvidenceCount: nonNegativeInteger,
});

const commercialApplicationPeriod = shape({
  period: oneOf(['week', 'month', '3_months', '6_months'] as const),
  fromDate: dateKey,
  toDate: dateKey,
  totalCount: nonNegativeInteger,
  clientOrderCount: nonNegativeInteger,
  stockReserveCount: nonNegativeInteger,
});

const accountingProduction = shape({
  source: shape({
    sourceKind: oneOf(['1C'] as const),
    label: oneOf(['1С · Отчет производства за смену'] as const),
    latestImportedAt: nullable(timestamp),
    latestDocumentDate: nullable(timestamp),
    stale: booleanValue,
  }),
  coverage: shape({
    documentCount: nonNegativeInteger,
    excludedOutputLineCount: nonNegativeInteger,
    excludedMaterialLineCount: nonNegativeInteger,
  }),
  productionSeries: arrayOf(
    shape({
      bucketStartDate: dateKey,
      documentCount: nonNegativeInteger,
      producedKg: finiteNumber,
    }),
  ),
  materialSeries: arrayOf(
    shape({
      bucketStartDate: dateKey,
      consumedKg: finiteNumber,
    }),
  ),
});

const analyticsResponse = shape({
  range: shape({
    timezone: oneOf(['Europe/Moscow'] as const),
    requested: shape({ from: dateKey, to: dateKey }),
    effective: shape({ fromUtc: timestamp, toExclusiveUtc: timestamp }),
    bucket: oneOf(['day', 'week', 'month'] as const),
    generatedAt: timestamp,
  }),
  productionSeries: arrayOf(productionPoint),
  materialSeries: arrayOf(materialPoint),
  shiftBalances: arrayOf(shiftBalance),
  bigBags: arrayOf(bigBag),
  operatorOverPlan,
  productionQualitySeries: arrayOf(productionQualityPoint),
  materialSpendSeries: arrayOf(materialSpendPoint),
  spoolEvidence: shape({
    availability: oneOf(['measured_evidence_only'] as const),
    explanation: nonEmptyString,
  }),
  commercialApplications: shape({
    definition: oneOf(['submitted'] as const),
    asOfDate: dateKey,
    periods: arrayOf(commercialApplicationPeriod),
  }),
  accountingProduction,
});

export function parseDirectorAnalyticsResponse(
  value: unknown,
  expected?: DirectorAnalyticsQuery,
): ServerDirectorAnalyticsResponse {
  if (!analyticsResponse(value)) {
    throw new Error('Некорректные данные производственной аналитики');
  }
  const response = value as ServerDirectorAnalyticsResponse;
  if (
    expected &&
    (response.range.requested.from !== expected.from ||
      response.range.requested.to !== expected.to ||
      response.range.bucket !== expected.bucket)
  ) {
    throw new Error('Диапазон производственной аналитики не совпадает с запросом');
  }
  return response;
}

export function parseDirectorShiftBalancePage(
  value: unknown,
): ServerDirectorAnalyticsShiftBalancePage {
  if (!shiftBalancePage(value)) {
    throw new Error('Некорректные данные баланса смен');
  }
  return value as ServerDirectorAnalyticsShiftBalancePage;
}

export function parseDirectorBigBagEvidencePage(
  value: unknown,
): ServerDirectorAnalyticsBigBagEvidencePage {
  if (!bigBagEvidencePage(value)) {
    throw new Error('Некорректные данные фактов BigBag');
  }
  return value as ServerDirectorAnalyticsBigBagEvidencePage;
}

export function parseDirectorOperatorRollVariancePage(
  value: unknown,
): ServerDirectorOperatorRollVariancePage {
  if (!operatorRollVariancePage(value)) {
    throw new Error('Некорректные данные перерасхода по рулонам');
  }
  return value as ServerDirectorOperatorRollVariancePage;
}
