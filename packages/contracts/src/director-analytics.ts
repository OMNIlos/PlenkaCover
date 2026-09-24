import type { BigBagStatus } from './statuses';
import type { SafeInventorySourceSummary } from './inventory';
import type {
  DirectorPayrollTariffRule,
  DirectorPayrollUnresolvedReason,
} from './director-payroll';
import type { PayrollTariffOrderReference } from './payroll-tariff-orders';

export const DIRECTOR_ANALYTICS_BUCKETS = ['day', 'week', 'month'] as const;
export type DirectorAnalyticsBucket = (typeof DIRECTOR_ANALYTICS_BUCKETS)[number];

export const DIRECTOR_ANALYTICS_EVIDENCE_STATUSES = ['pending', 'ok', 'mismatch'] as const;
export type DirectorAnalyticsEvidenceStatus = (typeof DIRECTOR_ANALYTICS_EVIDENCE_STATUSES)[number];

export const DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type DirectorAnalyticsEvidenceFreshness =
  (typeof DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS)[number];

export const DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES = ['open', 'closed'] as const;
export type DirectorAnalyticsBigBagUsageState =
  (typeof DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES)[number];

export const DIRECTOR_ANALYTICS_FIXED_PERIODS = ['week', 'month'] as const;
export type DirectorAnalyticsFixedPeriod = (typeof DIRECTOR_ANALYTICS_FIXED_PERIODS)[number];

export const DIRECTOR_APPLICATION_PERIODS = ['week', 'month', '3_months', '6_months'] as const;
export type DirectorApplicationPeriod = (typeof DIRECTOR_APPLICATION_PERIODS)[number];

export const DIRECTOR_ROLL_PROVENANCE = [
  'post_session',
  'operation_actor',
  'actor_missing',
  'plan_missing',
] as const;
export type DirectorRollProvenance = (typeof DIRECTOR_ROLL_PROVENANCE)[number];

export type DirectorAnalyticsQuery = {
  from: string;
  to: string;
  bucket: DirectorAnalyticsBucket;
};

export type DirectorAnalyticsEvidenceQueryBase = DirectorAnalyticsQuery & {
  operatorId?: string;
  postId?: string;
  shiftId?: string;
  bigBagId?: string;
  q?: string;
  operatorQuery?: string;
  postQuery?: string;
  shiftQuery?: string;
  status?: DirectorAnalyticsEvidenceStatus;
  freshness?: DirectorAnalyticsEvidenceFreshness;
  latestEvidenceFrom?: string;
  latestEvidenceTo?: string;
  cursor?: string;
  limit?: number;
};

type ShiftEvidenceFields = {
  startedFrom?: string;
  startedTo?: string;
  endedFrom?: string;
  endedTo?: string;
  startKgMin?: number;
  startKgMax?: number;
  remainingKgMin?: number;
  remainingKgMax?: number;
  actualUsageKgMin?: number;
  actualUsageKgMax?: number;
  expectedUsageKgMin?: number;
  expectedUsageKgMax?: number;
  producedKgMin?: number;
  producedKgMax?: number;
  rollCountMin?: number;
  rollCountMax?: number;
  defectKgMin?: number;
  defectKgMax?: number;
  defectCountMin?: number;
  defectCountMax?: number;
  unverifiedDefectCountMin?: number;
  unverifiedDefectCountMax?: number;
  deviationKgMin?: number;
  deviationKgMax?: number;
  deviationPercentMin?: number;
  deviationPercentMax?: number;
};

type BigBagEvidenceFields = {
  bigBagQuery?: string;
  materialQuery?: string;
  bigBagStatus?: BigBagStatus;
  openedFrom?: string;
  openedTo?: string;
  closedFrom?: string;
  closedTo?: string;
  usageState?: DirectorAnalyticsBigBagUsageState;
  startKgMin?: number;
  startKgMax?: number;
  endKgMin?: number;
  endKgMax?: number;
  currentKgMin?: number;
  currentKgMax?: number;
  bagUsageKgMin?: number;
  bagUsageKgMax?: number;
  actualUsageKgMin?: number;
  actualUsageKgMax?: number;
  expectedUsageKgMin?: number;
  expectedUsageKgMax?: number;
  producedKgMin?: number;
  producedKgMax?: number;
  rollCountMin?: number;
  rollCountMax?: number;
  defectKgMin?: number;
  defectKgMax?: number;
  defectCountMin?: number;
  defectCountMax?: number;
  unverifiedDefectCountMin?: number;
  unverifiedDefectCountMax?: number;
  deviationKgMin?: number;
  deviationKgMax?: number;
  deviationPercentMin?: number;
  deviationPercentMax?: number;
};

export type DirectorAnalyticsShiftEvidenceQuery = DirectorAnalyticsEvidenceQueryBase &
  ShiftEvidenceFields;

export type DirectorAnalyticsBigBagEvidenceQuery = DirectorAnalyticsEvidenceQueryBase &
  BigBagEvidenceFields;

/** @deprecated Use the endpoint-specific evidence query type. */
export type DirectorAnalyticsEvidenceQuery = DirectorAnalyticsEvidenceQueryBase;

export type DirectorOperatorRollVariance = {
  operatorId: string | null;
  operatorName: string | null;
  orderId: string;
  orderNumber: string;
  rollId: string;
  rollCode: string;
  producedAt: string;
  actualCapturedAt: string;
  plannedKg: number | null;
  actualKg: number;
  varianceKg: number | null;
  overPlanKg: number | null;
  provenance: DirectorRollProvenance;
};

export type DirectorOperatorRollVarianceQuery = {
  from: string;
  to: string;
  cursor?: string;
  limit?: number;
};

export type DirectorOperatorRollVariancePage = {
  items: DirectorOperatorRollVariance[];
  nextCursor: string | null;
};

export type DirectorAnalyticsRange = {
  timezone: 'Europe/Moscow';
  requested: {
    from: string;
    to: string;
  };
  effective: {
    fromUtc: string;
    toExclusiveUtc: string;
  };
  bucket: DirectorAnalyticsBucket;
  generatedAt: string;
};

export type DirectorAnalyticsProductionPoint = {
  bucketStartDate: string;
  rollCount: number;
  producedKg: number;
};

export type DirectorAnalyticsMaterialPoint = {
  bucketStartDate: string;
  expectedUsageKg: number;
  actualUsageKg: number;
};

export type DirectorAccountingProductionPoint = {
  bucketStartDate: string;
  documentCount: number;
  producedKg: number;
};

export type DirectorAccountingMaterialPoint = {
  bucketStartDate: string;
  consumedKg: number;
};

export type DirectorAccountingProduction = {
  source: {
    sourceKind: '1C';
    label: '1С · Отчет производства за смену';
    latestImportedAt: string | null;
    latestDocumentDate: string | null;
    stale: boolean;
  };
  coverage: {
    documentCount: number;
    excludedOutputLineCount: number;
    excludedMaterialLineCount: number;
  };
  productionSeries: DirectorAccountingProductionPoint[];
  materialSeries: DirectorAccountingMaterialPoint[];
};

export type DirectorAnalyticsOverPlanSeriesPoint = {
  bucketStartDate: string;
  affectedRollCount: number;
  affectedOperatorCount: number;
  overPlanKg: number;
};

export type DirectorAnalyticsOverPlanTotal = {
  period: DirectorAnalyticsFixedPeriod;
  fromDate: string;
  toDate: string;
  affectedRollCount: number;
  affectedOperatorCount: number;
  overPlanKg: number;
};

export type DirectorAnalyticsTopOperator = {
  operatorId: string;
  operatorName: string;
  affectedRollCount: number;
  overPlanKg: number;
};

export type DirectorAnalyticsOperatorOverPlan = {
  series: DirectorAnalyticsOverPlanSeriesPoint[];
  totals: DirectorAnalyticsOverPlanTotal[];
  topOperators: DirectorAnalyticsTopOperator[];
  missingPlanCount: number;
  missingActorCount: number;
};

export type DirectorAnalyticsProductionQualityPoint = {
  id: string;
  bucketStartDate: string;
  producedRollCount: number;
  producedKg: number;
  defectRecordCount: number;
  defectiveRollCount: number;
  verifiedDefectKg: number;
  unverifiedDefectCount: number;
  returnedSpoolCount: number;
};

export type DirectorAnalyticsMaterialSpendPoint = {
  bucketStartDate: string;
  consumedGranulesKg: number;
  recordedSpoolCount: number;
  recordedSpoolTareKg: number;
  missingSpoolEvidenceCount: number;
};

export type DirectorAnalyticsSpoolEvidence = {
  availability: 'measured_evidence_only';
  explanation: string;
};

export type DirectorCommercialApplicationPeriod = {
  period: DirectorApplicationPeriod;
  fromDate: string;
  toDate: string;
  totalCount: number;
  clientOrderCount: number;
  stockReserveCount: number;
};

export type DirectorCommercialApplications = {
  definition: 'submitted';
  asOfDate: string;
  periods: DirectorCommercialApplicationPeriod[];
};

export type DirectorAnalyticsShiftBalanceStatus = DirectorAnalyticsEvidenceStatus;

export type DirectorAnalyticsShiftPayroll =
  | {
      status: 'resolved';
      tariffOrder: PayrollTariffOrderReference;
      rateKopecksPerKg: number | null;
      amountKopecks: number;
      tariffRule: DirectorPayrollTariffRule | null;
      basisLabel: string;
    }
  | {
      status: 'unresolved';
      reasons: DirectorPayrollUnresolvedReason[];
    };

export type DirectorAnalyticsShiftBalance = {
  sessionId: string;
  shiftId: string | null;
  shiftLabel: string | null;
  operatorId: string;
  operatorName: string;
  postId: string;
  postCode: string;
  postName: string;
  startedAt: string;
  endedAt: string;
  rollCount: number;
  producedKg: number;
  expectedUsageKg: number;
  actualUsageKg: number | null;
  deviationPercent: number | null;
  status: DirectorAnalyticsShiftBalanceStatus;
  payroll: DirectorAnalyticsShiftPayroll;
};

export type DirectorAnalyticsBigBagSnapshot = {
  measuredKg: number | null;
  measuredAt: string | null;
};

export type DirectorAnalyticsBigBagUsage = {
  id: string;
  sessionId: string;
  shiftId: string | null;
  shiftLabel: string | null;
  operatorId: string;
  operatorName: string;
  postId: string;
  postCode: string;
  postName: string;
  startKg: number;
  endKg: number | null;
  deltaKg: number | null;
  openedAt: string;
  closedAt: string | null;
};

export type DirectorAnalyticsBigBag = {
  id: string;
  code: string;
  materialId: string | null;
  material: string;
  status: BigBagStatus;
  initialKg: number | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceEffectiveAt: string | null;
  currentSnapshot: DirectorAnalyticsBigBagSnapshot;
  usageHistory: DirectorAnalyticsBigBagUsage[];
};

export type DirectorAnalyticsEvidenceSource = {
  usage: 'shift_bag_usage';
  production: 'canonical_roll_weight_capture';
  defects: 'linked_stable_defect_weight_capture';
  latestEvidenceAt: string | null;
  freshness: DirectorAnalyticsEvidenceFreshness;
};

export type DirectorAnalyticsEvidenceBagLink = {
  usageId: string;
  bigBagId: string;
  bigBagCode: string;
  materialId: string | null;
  material: string;
  bigBagStatus: BigBagStatus;
  startKg: number;
  endKg: number | null;
  currentKg: number | null;
  currentMeasuredAt: string | null;
  currentFreshness: DirectorAnalyticsEvidenceFreshness;
  openedAt: string;
  closedAt: string | null;
};

export type DirectorAnalyticsShiftEvidence = {
  sessionId: string;
  shiftId: string | null;
  shiftLabel: string | null;
  operatorId: string;
  operatorName: string;
  postId: string;
  postCode: string;
  postName: string;
  startedAt: string;
  endedAt: string;
  bigBags: DirectorAnalyticsEvidenceBagLink[];
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
  status: DirectorAnalyticsEvidenceStatus;
  source: DirectorAnalyticsEvidenceSource;
};

export type DirectorAnalyticsBigBagEvidence = {
  id: string;
  bigBagId: string;
  bigBagCode: string;
  materialId: string | null;
  material: string;
  bigBagStatus: BigBagStatus;
  sessionId: string;
  shiftId: string | null;
  shiftLabel: string | null;
  operatorId: string;
  operatorName: string;
  postId: string;
  postCode: string;
  postName: string;
  openedAt: string;
  closedAt: string | null;
  startKg: number;
  endKg: number | null;
  currentKg: number | null;
  currentMeasuredAt: string | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceEffectiveAt: string | null;
  bagUsageKg: number | null;
  actualUsageKg: number | null;
  expectedUsageKg: number | null;
  producedKg: number | null;
  rollCount: number | null;
  defectKg: number | null;
  defectCount: number | null;
  unverifiedDefectCount: number | null;
  deviationKg: number | null;
  deviationPercent: number | null;
  balanceScope: 'usage_episodes';
  status: DirectorAnalyticsEvidenceStatus;
  source: DirectorAnalyticsEvidenceSource;
};

export type DirectorAnalyticsShiftEvidencePage = {
  items: DirectorAnalyticsShiftEvidence[];
  nextCursor: string | null;
};

export type DirectorAnalyticsBigBagEvidencePage = {
  items: DirectorAnalyticsBigBagEvidence[];
  nextCursor: string | null;
};

export type DirectorAnalyticsResponse = {
  range: DirectorAnalyticsRange;
  productionSeries: DirectorAnalyticsProductionPoint[];
  materialSeries: DirectorAnalyticsMaterialPoint[];
  shiftBalances: DirectorAnalyticsShiftBalance[];
  bigBags: DirectorAnalyticsBigBag[];
  operatorOverPlan: DirectorAnalyticsOperatorOverPlan;
  productionQualitySeries: DirectorAnalyticsProductionQualityPoint[];
  materialSpendSeries: DirectorAnalyticsMaterialSpendPoint[];
  spoolEvidence: DirectorAnalyticsSpoolEvidence;
  commercialApplications: DirectorCommercialApplications;
  accountingProduction: DirectorAccountingProduction;
  inventorySource?: SafeInventorySourceSummary;
};
