import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import {
  BIG_BAG_STATUSES,
  DIRECTOR_ANALYTICS_BUCKETS,
  DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS,
  DIRECTOR_ANALYTICS_EVIDENCE_STATUSES,
  DIRECTOR_ANALYTICS_FIXED_PERIODS,
  DIRECTOR_APPLICATION_PERIODS,
  DIRECTOR_PAYROLL_TARIFF_RULES,
  DIRECTOR_PAYROLL_UNRESOLVED_REASONS,
  DIRECTOR_ROLL_PROVENANCE,
  type BigBagStatus,
  type DirectorAccountingMaterialPoint,
  type DirectorAccountingProduction,
  type DirectorAccountingProductionPoint,
  type DirectorAnalyticsFixedPeriod,
  type DirectorAnalyticsBigBag,
  type DirectorAnalyticsBigBagEvidence,
  type DirectorAnalyticsBigBagEvidencePage,
  type DirectorAnalyticsBigBagSnapshot,
  type DirectorAnalyticsBigBagUsage,
  type DirectorAnalyticsBucket,
  type DirectorAnalyticsEvidenceBagLink,
  type DirectorAnalyticsEvidenceFreshness,
  type DirectorAnalyticsEvidenceSource,
  type DirectorAnalyticsMaterialPoint,
  type DirectorAnalyticsMaterialSpendPoint,
  type DirectorAnalyticsOperatorOverPlan,
  type DirectorAnalyticsOverPlanSeriesPoint,
  type DirectorAnalyticsOverPlanTotal,
  type DirectorAnalyticsProductionPoint,
  type DirectorAnalyticsProductionQualityPoint,
  type DirectorAnalyticsRange,
  type DirectorAnalyticsResponse,
  type DirectorAnalyticsShiftBalance,
  type DirectorAnalyticsShiftBalanceStatus,
  type DirectorAnalyticsShiftPayroll,
  type DirectorAnalyticsShiftEvidence,
  type DirectorAnalyticsShiftEvidencePage,
  type DirectorAnalyticsSpoolEvidence,
  type DirectorAnalyticsTopOperator,
  type DirectorApplicationPeriod,
  type DirectorCommercialApplicationPeriod,
  type DirectorCommercialApplications,
  type DirectorOperatorRollVariance,
  type DirectorOperatorRollVariancePage,
  type DirectorRollProvenance,
} from '@plenka/contracts';
import { PayrollTariffOrderReferenceResponseDto } from './payroll-tariff-order.dto';

type DirectorAccountingProductionSource = DirectorAccountingProduction['source'];
type DirectorAccountingProductionCoverage = DirectorAccountingProduction['coverage'];

export class DirectorAnalyticsRequestedRangeResponseDto {
  @ApiProperty({ format: 'date' })
  from!: string;

  @ApiProperty({ format: 'date' })
  to!: string;
}

export class DirectorAnalyticsEffectiveRangeResponseDto {
  @ApiProperty({ format: 'date-time' })
  fromUtc!: string;

  @ApiProperty({ format: 'date-time' })
  toExclusiveUtc!: string;
}

export class DirectorAnalyticsRangeResponseDto implements DirectorAnalyticsRange {
  @ApiProperty({ enum: ['Europe/Moscow'] })
  timezone!: 'Europe/Moscow';

  @ApiProperty({ type: DirectorAnalyticsRequestedRangeResponseDto })
  requested!: DirectorAnalyticsRequestedRangeResponseDto;

  @ApiProperty({ type: DirectorAnalyticsEffectiveRangeResponseDto })
  effective!: DirectorAnalyticsEffectiveRangeResponseDto;

  @ApiProperty({ enum: DIRECTOR_ANALYTICS_BUCKETS })
  bucket!: DirectorAnalyticsBucket;

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}

export class DirectorAnalyticsProductionPointResponseDto implements DirectorAnalyticsProductionPoint {
  @ApiProperty({ format: 'date', description: 'Natural Moscow-local bucket start.' })
  bucketStartDate!: string;

  @ApiProperty({ minimum: 0 })
  rollCount!: number;

  @ApiProperty({ minimum: 0 })
  producedKg!: number;
}

export class DirectorAnalyticsMaterialPointResponseDto implements DirectorAnalyticsMaterialPoint {
  @ApiProperty({ format: 'date', description: 'Natural Moscow-local bucket start.' })
  bucketStartDate!: string;

  @ApiProperty({ minimum: 0, description: 'Canonical roll net kilograms, accounted 1:1.' })
  expectedUsageKg!: number;

  @ApiProperty({ description: 'Closed BigBag usage delta; negative anomalies are preserved.' })
  actualUsageKg!: number;
}

export class DirectorAccountingProductionSourceResponseDto implements DirectorAccountingProductionSource {
  @ApiProperty({ enum: ['1C'] })
  sourceKind!: '1C';

  @ApiProperty({ enum: ['1С · Отчет производства за смену'] })
  label!: '1С · Отчет производства за смену';

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  latestImportedAt!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  latestDocumentDate!: string | null;

  @ApiProperty()
  stale!: boolean;
}

export class DirectorAccountingProductionCoverageResponseDto implements DirectorAccountingProductionCoverage {
  @ApiProperty({ minimum: 0 })
  documentCount!: number;

  @ApiProperty({ minimum: 0 })
  excludedOutputLineCount!: number;

  @ApiProperty({ minimum: 0 })
  excludedMaterialLineCount!: number;
}

export class DirectorAccountingProductionPointResponseDto implements DirectorAccountingProductionPoint {
  @ApiProperty({ format: 'date', description: 'Natural Moscow-local bucket start.' })
  bucketStartDate!: string;

  @ApiProperty({ minimum: 0 })
  documentCount!: number;

  @ApiProperty({ minimum: 0 })
  producedKg!: number;
}

export class DirectorAccountingMaterialPointResponseDto implements DirectorAccountingMaterialPoint {
  @ApiProperty({ format: 'date', description: 'Natural Moscow-local bucket start.' })
  bucketStartDate!: string;

  @ApiProperty({ minimum: 0 })
  consumedKg!: number;
}

export class DirectorAccountingProductionResponseDto implements DirectorAccountingProduction {
  @ApiProperty({ type: DirectorAccountingProductionSourceResponseDto })
  source!: DirectorAccountingProductionSourceResponseDto;

  @ApiProperty({ type: DirectorAccountingProductionCoverageResponseDto })
  coverage!: DirectorAccountingProductionCoverageResponseDto;

  @ApiProperty({ type: [DirectorAccountingProductionPointResponseDto] })
  productionSeries!: DirectorAccountingProductionPointResponseDto[];

  @ApiProperty({ type: [DirectorAccountingMaterialPointResponseDto] })
  materialSeries!: DirectorAccountingMaterialPointResponseDto[];
}

export class DirectorAnalyticsResolvedShiftPayrollResponseDto implements Extract<
  DirectorAnalyticsShiftPayroll,
  { status: 'resolved' }
> {
  @ApiProperty({ enum: ['resolved'] })
  status!: 'resolved';

  @ApiProperty({ type: PayrollTariffOrderReferenceResponseDto })
  tariffOrder!: PayrollTariffOrderReferenceResponseDto;

  @ApiProperty({ type: 'integer', format: 'int32', minimum: 0, nullable: true })
  rateKopecksPerKg!: number | null;

  @ApiProperty({ type: 'integer', format: 'int64', minimum: 0 })
  amountKopecks!: number;

  @ApiProperty({ enum: DIRECTOR_PAYROLL_TARIFF_RULES, nullable: true })
  tariffRule!: Extract<DirectorAnalyticsShiftPayroll, { status: 'resolved' }>['tariffRule'];

  @ApiProperty()
  basisLabel!: string;
}

export class DirectorAnalyticsUnresolvedShiftPayrollResponseDto implements Extract<
  DirectorAnalyticsShiftPayroll,
  { status: 'unresolved' }
> {
  @ApiProperty({ enum: ['unresolved'] })
  status!: 'unresolved';

  @ApiProperty({ enum: DIRECTOR_PAYROLL_UNRESOLVED_REASONS, isArray: true })
  reasons!: Extract<DirectorAnalyticsShiftPayroll, { status: 'unresolved' }>['reasons'];
}

@ApiExtraModels(
  DirectorAnalyticsResolvedShiftPayrollResponseDto,
  DirectorAnalyticsUnresolvedShiftPayrollResponseDto,
)
export class DirectorAnalyticsShiftBalanceResponseDto implements DirectorAnalyticsShiftBalance {
  @ApiProperty()
  sessionId!: string;

  @ApiProperty({ nullable: true, type: String })
  shiftId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  shiftLabel!: string | null;

  @ApiProperty()
  operatorId!: string;

  @ApiProperty()
  operatorName!: string;

  @ApiProperty()
  postId!: string;

  @ApiProperty()
  postCode!: string;

  @ApiProperty()
  postName!: string;

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiProperty({ format: 'date-time' })
  endedAt!: string;

  @ApiProperty({ minimum: 0 })
  rollCount!: number;

  @ApiProperty({ minimum: 0 })
  producedKg!: number;

  @ApiProperty({ minimum: 0 })
  expectedUsageKg!: number;

  @ApiProperty({ nullable: true, type: Number })
  actualUsageKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  deviationPercent!: number | null;

  @ApiProperty({ enum: ['pending', 'ok', 'mismatch'] })
  status!: DirectorAnalyticsShiftBalanceStatus;

  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(DirectorAnalyticsResolvedShiftPayrollResponseDto) },
      { $ref: getSchemaPath(DirectorAnalyticsUnresolvedShiftPayrollResponseDto) },
    ],
  })
  payroll!: DirectorAnalyticsShiftPayroll;
}

export class DirectorAnalyticsBigBagSnapshotResponseDto implements DirectorAnalyticsBigBagSnapshot {
  @ApiProperty({ nullable: true, type: Number })
  measuredKg!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  measuredAt!: string | null;
}

export class DirectorAnalyticsBigBagUsageResponseDto implements DirectorAnalyticsBigBagUsage {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty({ nullable: true, type: String })
  shiftId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  shiftLabel!: string | null;

  @ApiProperty()
  operatorId!: string;

  @ApiProperty()
  operatorName!: string;

  @ApiProperty()
  postId!: string;

  @ApiProperty()
  postCode!: string;

  @ApiProperty()
  postName!: string;

  @ApiProperty()
  startKg!: number;

  @ApiProperty({ nullable: true, type: Number })
  endKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  deltaKg!: number | null;

  @ApiProperty({ format: 'date-time' })
  openedAt!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  closedAt!: string | null;
}

export class DirectorAnalyticsBigBagResponseDto implements DirectorAnalyticsBigBag {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ nullable: true, type: String })
  materialId!: string | null;

  @ApiProperty()
  material!: string;

  @ApiProperty({ enum: BIG_BAG_STATUSES })
  status!: BigBagStatus;

  @ApiProperty({ nullable: true, type: Number })
  initialKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  priceKopecksPerKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  totalKopecks!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  priceEffectiveAt!: string | null;

  @ApiProperty({ type: DirectorAnalyticsBigBagSnapshotResponseDto })
  currentSnapshot!: DirectorAnalyticsBigBagSnapshotResponseDto;

  @ApiProperty({ type: [DirectorAnalyticsBigBagUsageResponseDto] })
  usageHistory!: DirectorAnalyticsBigBagUsageResponseDto[];
}

export class DirectorAnalyticsEvidenceSourceResponseDto implements DirectorAnalyticsEvidenceSource {
  @ApiProperty({ enum: ['shift_bag_usage'] })
  usage!: 'shift_bag_usage';

  @ApiProperty({ enum: ['canonical_roll_weight_capture'] })
  production!: 'canonical_roll_weight_capture';

  @ApiProperty({ enum: ['linked_stable_defect_weight_capture'] })
  defects!: 'linked_stable_defect_weight_capture';

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Latest timestamp among the explicitly projected evidence facts.',
  })
  latestEvidenceAt!: string | null;

  @ApiProperty({
    enum: DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS,
    description:
      'Current BigBag measurement relative to the relevant usage timestamp; no arbitrary TTL is inferred.',
  })
  freshness!: DirectorAnalyticsEvidenceFreshness;
}

export class DirectorAnalyticsEvidenceBagLinkResponseDto implements DirectorAnalyticsEvidenceBagLink {
  @ApiProperty()
  usageId!: string;

  @ApiProperty()
  bigBagId!: string;

  @ApiProperty()
  bigBagCode!: string;

  @ApiProperty({ nullable: true, type: String })
  materialId!: string | null;

  @ApiProperty()
  material!: string;

  @ApiProperty({ enum: BIG_BAG_STATUSES })
  bigBagStatus!: BigBagStatus;

  @ApiProperty()
  startKg!: number;

  @ApiProperty({ nullable: true, type: Number })
  endKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  currentKg!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  currentMeasuredAt!: string | null;

  @ApiProperty({ enum: DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS })
  currentFreshness!: DirectorAnalyticsEvidenceFreshness;

  @ApiProperty({ format: 'date-time' })
  openedAt!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  closedAt!: string | null;
}

export class DirectorAnalyticsShiftEvidenceResponseDto implements DirectorAnalyticsShiftEvidence {
  @ApiProperty()
  sessionId!: string;

  @ApiProperty({ nullable: true, type: String })
  shiftId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  shiftLabel!: string | null;

  @ApiProperty()
  operatorId!: string;

  @ApiProperty()
  operatorName!: string;

  @ApiProperty()
  postId!: string;

  @ApiProperty()
  postCode!: string;

  @ApiProperty()
  postName!: string;

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiProperty({ format: 'date-time' })
  endedAt!: string;

  @ApiProperty({ type: [DirectorAnalyticsEvidenceBagLinkResponseDto] })
  bigBags!: DirectorAnalyticsEvidenceBagLinkResponseDto[];

  @ApiProperty({ nullable: true, type: Number })
  startKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  endKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  currentKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  actualUsageKg!: number | null;

  @ApiProperty({ minimum: 0 })
  expectedUsageKg!: number;

  @ApiProperty({ minimum: 0 })
  producedKg!: number;

  @ApiProperty({ minimum: 0 })
  rollCount!: number;

  @ApiProperty({ minimum: 0, description: 'Verified linked defect weight only.' })
  defectKg!: number;

  @ApiProperty({ minimum: 0 })
  defectCount!: number;

  @ApiProperty({ minimum: 0 })
  unverifiedDefectCount!: number;

  @ApiProperty({ nullable: true, type: Number })
  deviationKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  deviationPercent!: number | null;

  @ApiProperty({ enum: DIRECTOR_ANALYTICS_EVIDENCE_STATUSES })
  status!: DirectorAnalyticsShiftBalanceStatus;

  @ApiProperty({ type: DirectorAnalyticsEvidenceSourceResponseDto })
  source!: DirectorAnalyticsEvidenceSourceResponseDto;
}

export class DirectorAnalyticsBigBagEvidenceResponseDto implements DirectorAnalyticsBigBagEvidence {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  bigBagId!: string;

  @ApiProperty()
  bigBagCode!: string;

  @ApiProperty({ nullable: true, type: String })
  materialId!: string | null;

  @ApiProperty()
  material!: string;

  @ApiProperty({ enum: BIG_BAG_STATUSES })
  bigBagStatus!: BigBagStatus;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty({ nullable: true, type: String })
  shiftId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  shiftLabel!: string | null;

  @ApiProperty()
  operatorId!: string;

  @ApiProperty()
  operatorName!: string;

  @ApiProperty()
  postId!: string;

  @ApiProperty()
  postCode!: string;

  @ApiProperty()
  postName!: string;

  @ApiProperty({ format: 'date-time' })
  openedAt!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  closedAt!: string | null;

  @ApiProperty()
  startKg!: number;

  @ApiProperty({ nullable: true, type: Number })
  endKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  currentKg!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  currentMeasuredAt!: string | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  priceKopecksPerKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  totalKopecks!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  priceEffectiveAt!: string | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'This BigBag usage delta; null until its final weight is recorded.',
  })
  bagUsageKg!: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Total usage for the linked session; never allocated to one bag.',
  })
  actualUsageKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  expectedUsageKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, description: 'Server-calculated bag remainder.' })
  calculatedRemainderKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  producedKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  rollCount!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  defectKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  defectCount!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  unverifiedDefectCount!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  deviationKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  deviationPercent!: number | null;

  @ApiProperty({ enum: ['usage_episodes'] })
  balanceScope!: 'usage_episodes';

  @ApiProperty({ enum: DIRECTOR_ANALYTICS_EVIDENCE_STATUSES })
  status!: DirectorAnalyticsShiftBalanceStatus;

  @ApiProperty({ type: DirectorAnalyticsEvidenceSourceResponseDto })
  source!: DirectorAnalyticsEvidenceSourceResponseDto;
}

export class DirectorAnalyticsShiftEvidencePageResponseDto implements DirectorAnalyticsShiftEvidencePage {
  @ApiProperty({ type: [DirectorAnalyticsShiftEvidenceResponseDto] })
  items!: DirectorAnalyticsShiftEvidenceResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class DirectorAnalyticsBigBagEvidencePageResponseDto implements DirectorAnalyticsBigBagEvidencePage {
  @ApiProperty({ type: [DirectorAnalyticsBigBagEvidenceResponseDto] })
  items!: DirectorAnalyticsBigBagEvidenceResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class DirectorAnalyticsOverPlanSeriesPointResponseDto implements DirectorAnalyticsOverPlanSeriesPoint {
  @ApiProperty({ format: 'date' })
  bucketStartDate!: string;

  @ApiProperty({ minimum: 0 })
  affectedRollCount!: number;

  @ApiProperty({ minimum: 0 })
  affectedOperatorCount!: number;

  @ApiProperty({ minimum: 0 })
  overPlanKg!: number;
}

export class DirectorAnalyticsOverPlanTotalResponseDto implements DirectorAnalyticsOverPlanTotal {
  @ApiProperty({ enum: DIRECTOR_ANALYTICS_FIXED_PERIODS })
  period!: DirectorAnalyticsFixedPeriod;

  @ApiProperty({ format: 'date' })
  fromDate!: string;

  @ApiProperty({ format: 'date' })
  toDate!: string;

  @ApiProperty({ minimum: 0 })
  affectedRollCount!: number;

  @ApiProperty({ minimum: 0 })
  affectedOperatorCount!: number;

  @ApiProperty({ minimum: 0 })
  overPlanKg!: number;
}

export class DirectorAnalyticsTopOperatorResponseDto implements DirectorAnalyticsTopOperator {
  @ApiProperty()
  operatorId!: string;

  @ApiProperty()
  operatorName!: string;

  @ApiProperty({ minimum: 0 })
  affectedRollCount!: number;

  @ApiProperty({ minimum: 0 })
  overPlanKg!: number;
}

export class DirectorAnalyticsOperatorOverPlanResponseDto implements DirectorAnalyticsOperatorOverPlan {
  @ApiProperty({ type: [DirectorAnalyticsOverPlanSeriesPointResponseDto] })
  series!: DirectorAnalyticsOverPlanSeriesPointResponseDto[];

  @ApiProperty({ type: [DirectorAnalyticsOverPlanTotalResponseDto] })
  totals!: DirectorAnalyticsOverPlanTotalResponseDto[];

  @ApiProperty({ type: [DirectorAnalyticsTopOperatorResponseDto] })
  topOperators!: DirectorAnalyticsTopOperatorResponseDto[];

  @ApiProperty({ minimum: 0 })
  missingPlanCount!: number;

  @ApiProperty({ minimum: 0 })
  missingActorCount!: number;
}

export class DirectorAnalyticsProductionQualityPointResponseDto implements DirectorAnalyticsProductionQualityPoint {
  @ApiProperty({ example: 'day:2026-07-21' })
  id!: string;

  @ApiProperty({ format: 'date' })
  bucketStartDate!: string;

  @ApiProperty({ minimum: 0 })
  producedRollCount!: number;

  @ApiProperty({ minimum: 0 })
  producedKg!: number;

  @ApiProperty({ minimum: 0 })
  defectRecordCount!: number;

  @ApiProperty({ minimum: 0 })
  defectiveRollCount!: number;

  @ApiProperty({ minimum: 0 })
  verifiedDefectKg!: number;

  @ApiProperty({ minimum: 0 })
  unverifiedDefectCount!: number;

  @ApiProperty({ minimum: 0 })
  returnedSpoolCount!: number;
}

export class DirectorAnalyticsMaterialSpendPointResponseDto implements DirectorAnalyticsMaterialSpendPoint {
  @ApiProperty({ format: 'date' })
  bucketStartDate!: string;

  @ApiProperty({ description: 'Closed BigBag delta; negative corrections are preserved.' })
  consumedGranulesKg!: number;

  @ApiProperty({ minimum: 0 })
  recordedSpoolCount!: number;

  @ApiProperty({ minimum: 0 })
  recordedSpoolTareKg!: number;

  @ApiProperty({ minimum: 0 })
  missingSpoolEvidenceCount!: number;
}

export class DirectorAnalyticsSpoolEvidenceResponseDto implements DirectorAnalyticsSpoolEvidence {
  @ApiProperty({ enum: ['measured_evidence_only'] })
  availability!: 'measured_evidence_only';

  @ApiProperty()
  explanation!: string;
}

export class DirectorCommercialApplicationPeriodResponseDto implements DirectorCommercialApplicationPeriod {
  @ApiProperty({ enum: DIRECTOR_APPLICATION_PERIODS })
  period!: DirectorApplicationPeriod;

  @ApiProperty({ format: 'date' })
  fromDate!: string;

  @ApiProperty({ format: 'date' })
  toDate!: string;

  @ApiProperty({ minimum: 0 })
  totalCount!: number;

  @ApiProperty({ minimum: 0 })
  clientOrderCount!: number;

  @ApiProperty({ minimum: 0 })
  stockReserveCount!: number;
}

export class DirectorCommercialApplicationsResponseDto implements DirectorCommercialApplications {
  @ApiProperty({ enum: ['submitted'] })
  definition!: 'submitted';

  @ApiProperty({ format: 'date' })
  asOfDate!: string;

  @ApiProperty({ type: [DirectorCommercialApplicationPeriodResponseDto] })
  periods!: DirectorCommercialApplicationPeriodResponseDto[];
}

export class DirectorOperatorRollVarianceResponseDto implements DirectorOperatorRollVariance {
  @ApiProperty({ nullable: true, type: String })
  operatorId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  operatorName!: string | null;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty()
  rollId!: string;

  @ApiProperty()
  rollCode!: string;

  @ApiProperty({ format: 'date-time' })
  producedAt!: string;

  @ApiProperty({ format: 'date-time' })
  actualCapturedAt!: string;

  @ApiProperty({ nullable: true, type: Number })
  plannedKg!: number | null;

  @ApiProperty()
  actualKg!: number;

  @ApiProperty({ nullable: true, type: Number })
  varianceKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  overPlanKg!: number | null;

  @ApiProperty({ enum: DIRECTOR_ROLL_PROVENANCE })
  provenance!: DirectorRollProvenance;
}

export class DirectorOperatorRollVariancePageResponseDto implements DirectorOperatorRollVariancePage {
  @ApiProperty({ type: [DirectorOperatorRollVarianceResponseDto] })
  items!: DirectorOperatorRollVarianceResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class DirectorAnalyticsResponseDto implements DirectorAnalyticsResponse {
  @ApiProperty({ type: DirectorAnalyticsRangeResponseDto })
  range!: DirectorAnalyticsRangeResponseDto;

  @ApiProperty({ type: [DirectorAnalyticsProductionPointResponseDto] })
  productionSeries!: DirectorAnalyticsProductionPointResponseDto[];

  @ApiProperty({ type: [DirectorAnalyticsMaterialPointResponseDto] })
  materialSeries!: DirectorAnalyticsMaterialPointResponseDto[];

  @ApiProperty({ type: [DirectorAnalyticsShiftBalanceResponseDto] })
  shiftBalances!: DirectorAnalyticsShiftBalanceResponseDto[];

  @ApiProperty({ type: [DirectorAnalyticsBigBagResponseDto] })
  bigBags!: DirectorAnalyticsBigBagResponseDto[];

  @ApiProperty({ type: DirectorAnalyticsOperatorOverPlanResponseDto })
  operatorOverPlan!: DirectorAnalyticsOperatorOverPlanResponseDto;

  @ApiProperty({ type: [DirectorAnalyticsProductionQualityPointResponseDto] })
  productionQualitySeries!: DirectorAnalyticsProductionQualityPointResponseDto[];

  @ApiProperty({ type: [DirectorAnalyticsMaterialSpendPointResponseDto] })
  materialSpendSeries!: DirectorAnalyticsMaterialSpendPointResponseDto[];

  @ApiProperty({ type: DirectorAnalyticsSpoolEvidenceResponseDto })
  spoolEvidence!: DirectorAnalyticsSpoolEvidenceResponseDto;

  @ApiProperty({ type: DirectorCommercialApplicationsResponseDto })
  commercialApplications!: DirectorCommercialApplicationsResponseDto;

  @ApiProperty({ type: DirectorAccountingProductionResponseDto })
  accountingProduction!: DirectorAccountingProductionResponseDto;
}
