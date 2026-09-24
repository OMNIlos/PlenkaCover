import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';
import {
  PAYMENT_STATUSES,
  PRODUCTION_INDICATORS,
  PRODUCTION_COST_UNRESOLVED_REASONS,
  SHIPMENT_STATUSES,
  WAREHOUSE_COVER_STATUSES,
  type BusinessOperationalProblem,
  type BusinessOperationalProblemPage,
  type BusinessPerformanceRollItem,
  type BusinessPerformanceRollPage,
  type CommercialPerformanceControl,
  type CommercialPerformanceControlSummary,
  type CommercialPerformanceFinanceItem,
  type CommercialPerformanceProductionItem,
  type CommercialPerformanceSource,
  type CommercialPerformanceWarehouseItem,
  type DirectorAccountingProduction,
  type DirectorAnalyticsProductionPoint,
  type DirectorAnalyticsProductionQualityPoint,
  type DirectorCommercialApplicationPeriod,
  type DirectorCommercialApplications,
  type ProductionCostUnresolvedReason,
  type RollProductionCostView,
} from '@plenka/contracts';
import {
  DirectorAnalyticsQueryDto,
  DirectorOperatorRollVarianceQueryDto,
} from '../../director/dto/analytics-query.dto';
import {
  DirectorAccountingProductionResponseDto,
  DirectorAnalyticsRangeResponseDto,
} from '../../director/dto/analytics-response.dto';
import { ProductionCostPayrollSourceResponseDto } from '../../../common/production-cost/production-cost-payroll-source.dto';

export class CommercialPerformanceControlQueryDto extends DirectorAnalyticsQueryDto {}

export class CommercialPerformancePageQueryDto extends DirectorOperatorRollVarianceQueryDto {}

export class CommercialPerformanceSourceResponseDto implements CommercialPerformanceSource {
  @ApiProperty({ enum: ['platform_runtime'] })
  kind!: 'platform_runtime';

  @ApiProperty({ enum: ['ready', 'partial', 'unavailable'] })
  status!: 'ready' | 'partial' | 'unavailable';

  @ApiProperty({ enum: ['fresh', 'stale', 'unknown'] })
  freshness!: 'fresh' | 'stale' | 'unknown';

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}

export class CommercialPerformanceControlSummaryResponseDto implements CommercialPerformanceControlSummary {
  @ApiProperty()
  invoicedAmount!: number;

  @ApiProperty()
  paidAmount!: number;

  @ApiProperty()
  receivableAmount!: number;

  @ApiProperty()
  overdueAmount!: number;

  @ApiProperty()
  producedKg!: number;

  @ApiProperty()
  producedRolls!: number;

  @ApiProperty()
  defectKg!: number;

  @ApiProperty()
  defectRollCount!: number;

  @ApiProperty()
  returnedSpoolCount!: number;

  @ApiProperty()
  warehouseAcceptedRolls!: number;
}

export class CommercialPerformanceProductionPointResponseDto implements DirectorAnalyticsProductionPoint {
  @ApiProperty({ format: 'date' })
  bucketStartDate!: string;

  @ApiProperty()
  rollCount!: number;

  @ApiProperty()
  producedKg!: number;
}

export class CommercialPerformanceQualityPointResponseDto implements DirectorAnalyticsProductionQualityPoint {
  @ApiProperty({ example: 'day:2026-07-21' })
  id!: string;

  @ApiProperty({ format: 'date' })
  bucketStartDate!: string;

  @ApiProperty()
  producedRollCount!: number;

  @ApiProperty()
  producedKg!: number;

  @ApiProperty()
  defectRecordCount!: number;

  @ApiProperty()
  defectiveRollCount!: number;

  @ApiProperty()
  verifiedDefectKg!: number;

  @ApiProperty()
  unverifiedDefectCount!: number;

  @ApiProperty()
  returnedSpoolCount!: number;
}

export class CommercialPerformanceApplicationPeriodResponseDto implements DirectorCommercialApplicationPeriod {
  @ApiProperty({ enum: ['week', 'month', '3_months', '6_months'] })
  period!: DirectorCommercialApplicationPeriod['period'];

  @ApiProperty({ format: 'date' })
  fromDate!: string;

  @ApiProperty({ format: 'date' })
  toDate!: string;

  @ApiProperty()
  totalCount!: number;

  @ApiProperty()
  clientOrderCount!: number;

  @ApiProperty()
  stockReserveCount!: number;
}

export class CommercialPerformanceApplicationsResponseDto implements DirectorCommercialApplications {
  @ApiProperty({ enum: ['submitted'] })
  definition!: 'submitted';

  @ApiProperty({ format: 'date' })
  asOfDate!: string;

  @ApiProperty({ type: CommercialPerformanceApplicationPeriodResponseDto, isArray: true })
  periods!: DirectorCommercialApplicationPeriod[];
}

export class CommercialPerformanceControlResponseDto implements CommercialPerformanceControl {
  @ApiProperty({ type: DirectorAnalyticsRangeResponseDto })
  range!: CommercialPerformanceControl['range'];

  @ApiProperty({ type: CommercialPerformanceSourceResponseDto })
  source!: CommercialPerformanceSource;

  @ApiProperty({ type: CommercialPerformanceControlSummaryResponseDto })
  summary!: CommercialPerformanceControlSummary;

  @ApiProperty({ type: CommercialPerformanceProductionPointResponseDto, isArray: true })
  productionSeries!: DirectorAnalyticsProductionPoint[];

  @ApiProperty({ type: CommercialPerformanceQualityPointResponseDto, isArray: true })
  productionQualitySeries!: DirectorAnalyticsProductionQualityPoint[];

  @ApiProperty({ type: DirectorAccountingProductionResponseDto })
  accountingProduction!: DirectorAccountingProduction;

  @ApiProperty({ type: CommercialPerformanceApplicationsResponseDto })
  commercialApplications!: DirectorCommercialApplications;
}

export class CommercialPerformanceFinanceItemResponseDto implements CommercialPerformanceFinanceItem {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ nullable: true })
  counterpartyName!: string | null;

  @ApiProperty()
  invoiceStatus!: string;

  @ApiProperty({ enum: PAYMENT_STATUSES })
  paymentStatus!: CommercialPerformanceFinanceItem['paymentStatus'];

  @ApiProperty({ enum: ['full', 'half_split', 'custom', 'not_set'] })
  paymentPlanKind!: CommercialPerformanceFinanceItem['paymentPlanKind'];

  @ApiProperty({ enum: ['100%', '50/50', 'Индивидуально', 'Не задано'] })
  paymentPlanLabel!: CommercialPerformanceFinanceItem['paymentPlanLabel'];

  @ApiProperty({ nullable: true })
  invoicedAmount!: number | null;

  @ApiProperty()
  paidAmount!: number;

  @ApiProperty({ nullable: true })
  remainingAmount!: number | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  nextConfirmedDueAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class CommercialPerformanceProductionItemResponseDto implements CommercialPerformanceProductionItem {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ nullable: true })
  counterpartyName!: string | null;

  @ApiProperty({ enum: PRODUCTION_INDICATORS })
  productionStatus!: CommercialPerformanceProductionItem['productionStatus'];

  @ApiProperty({
    enum: [
      'in_production',
      'ready_for_warehouse',
      'warehouse_handed_off',
      'warehouse_accepted',
      'warehouse_delivered',
      'defect',
      'unknown',
    ],
  })
  lifecycleStatus!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty()
  plannedRollCount!: number;

  @ApiProperty()
  completedRollCount!: number;

  @ApiProperty({ nullable: true })
  plannedKg!: number | null;

  @ApiProperty({ nullable: true })
  actualKg!: number | null;

  @ApiProperty()
  defectKg!: number;

  @ApiProperty()
  defectRollCount!: number;

  @ApiProperty()
  returnedSpoolCount!: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

@Exclude()
class BusinessPerformanceRollWeightsResponseDto {
  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  plannedNetKg!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  actualNetKg!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  actualGrossKg!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  deviationKg!: number | null;
}

export class CommercialPerformanceWarehouseItemResponseDto implements CommercialPerformanceWarehouseItem {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ enum: WAREHOUSE_COVER_STATUSES })
  warehouseCoverageStatus!: CommercialPerformanceWarehouseItem['warehouseCoverageStatus'];

  @ApiProperty({ enum: SHIPMENT_STATUSES })
  shipmentStatus!: CommercialPerformanceWarehouseItem['shipmentStatus'];

  @ApiProperty()
  readyRollCount!: number;

  @ApiProperty()
  reservedRollCount!: number;

  @ApiProperty()
  acceptedRollCount!: number;

  @ApiProperty()
  shippedRollCount!: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

class CommercialPerformancePageResponseDto {
  @ApiProperty({ nullable: true })
  nextCursor!: string | null;

  @ApiProperty({ type: CommercialPerformanceSourceResponseDto })
  source!: CommercialPerformanceSource;
}

export class CommercialPerformanceFinancePageResponseDto extends CommercialPerformancePageResponseDto {
  @ApiProperty({ type: CommercialPerformanceFinanceItemResponseDto, isArray: true })
  items!: CommercialPerformanceFinanceItem[];
}

export class CommercialPerformanceProductionPageResponseDto extends CommercialPerformancePageResponseDto {
  @ApiProperty({ type: CommercialPerformanceProductionItemResponseDto, isArray: true })
  items!: CommercialPerformanceProductionItem[];
}

export class CommercialPerformanceWarehousePageResponseDto extends CommercialPerformancePageResponseDto {
  @ApiProperty({ type: CommercialPerformanceWarehouseItemResponseDto, isArray: true })
  items!: CommercialPerformanceWarehouseItem[];
}

type BusinessPerformanceRollParameters = BusinessPerformanceRollItem['parameters'];
type BusinessOperationalProblemResponse = Omit<BusinessOperationalProblem, 'kind'> & {
  kind: BusinessOperationalProblem['kind'];
};

@Exclude()
export class BusinessPerformanceRollParametersResponseDto implements BusinessPerformanceRollParameters {
  @Expose()
  @ApiProperty({ type: String, nullable: true })
  filmType!: string | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  actualThicknessUm!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  accountingThicknessUm!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  widthMm!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  plannedLengthM!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  weightKg!: number | null;
}

@Exclude()
export class RollProductionCostViewResponseDto {
  @Expose()
  @ApiProperty({ enum: ['planned_preview', 'actual_snapshot', 'actual_pending'] })
  kind!: RollProductionCostView['kind'];

  @Expose()
  @ApiProperty({ enum: ['complete', 'partial', 'pending'] })
  status!: RollProductionCostView['status'];

  @Expose()
  @ApiProperty()
  calculationVersion!: string;

  @Expose()
  @ApiPropertyOptional()
  snapshotId?: string;

  @Expose()
  @ApiPropertyOptional({ type: 'integer', minimum: 1 })
  version?: number;

  @Expose()
  @ApiPropertyOptional({ format: 'date-time' })
  producedAt?: string;

  @Expose()
  @ApiPropertyOptional({ format: 'date-time' })
  closedAt?: string;

  @Expose()
  @ApiPropertyOptional({ format: 'date-time' })
  createdAt?: string;

  @Expose()
  @ApiProperty({
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['planned', 'actual'] },
      weightGrams: { type: 'integer', nullable: true },
    },
  })
  basis!: RollProductionCostView['basis'];

  @Expose()
  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  materialAmountKopecks!: number | null;

  @Expose()
  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  spoolAmountKopecks!: number | null;

  @Expose()
  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  payrollAmountKopecks!: number | null;

  @Expose()
  @Type(() => ProductionCostPayrollSourceResponseDto)
  @ApiProperty({ type: ProductionCostPayrollSourceResponseDto, nullable: true })
  payrollSource!: RollProductionCostView['payrollSource'];

  @Expose()
  @ApiProperty({ type: 'integer', format: 'int64' })
  additionalAmountKopecks!: number;

  @Expose()
  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  totalAmountKopecks!: number | null;

  @Expose()
  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  totalKopecksPerKg!: number | null;

  @Expose()
  @ApiProperty({ enum: PRODUCTION_COST_UNRESOLVED_REASONS, isArray: true })
  unresolvedReasons!: ProductionCostUnresolvedReason[];
}

@Exclude()
export class BusinessPerformanceRollItemResponseDto implements BusinessPerformanceRollItem {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty()
  rollName!: string;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  rollCode!: string | null;

  @Expose()
  @ApiProperty()
  orderNumber!: string;

  @Expose()
  @Type(() => BusinessPerformanceRollParametersResponseDto)
  @ApiProperty({ type: BusinessPerformanceRollParametersResponseDto })
  parameters!: BusinessPerformanceRollItem['parameters'];

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  operatorName!: string | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  machineName!: string | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  priority!: number | null;

  @Expose()
  @ApiProperty()
  status!: string;

  @Expose()
  @ApiProperty({
    enum: [
      'in_production',
      'ready_for_warehouse',
      'warehouse_handed_off',
      'warehouse_accepted',
      'warehouse_delivered',
      'defect',
      'unknown',
    ],
  })
  lifecycleStatus!: string;

  @Expose()
  @ApiProperty({ format: 'date-time', nullable: true })
  createdAt!: string | null;

  @Expose()
  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt!: string | null;

  @Expose()
  @Type(() => BusinessPerformanceRollWeightsResponseDto)
  @ApiProperty({ type: BusinessPerformanceRollWeightsResponseDto })
  weights!: BusinessPerformanceRollWeightsResponseDto;

  @Expose()
  @Type(() => RollProductionCostViewResponseDto)
  @ApiProperty({ type: RollProductionCostViewResponseDto })
  productionCost!: RollProductionCostView;
}

@Exclude()
export class BusinessPerformanceRollPageResponseDto implements BusinessPerformanceRollPage {
  @Expose()
  @Type(() => BusinessPerformanceRollItemResponseDto)
  @ApiProperty({ type: BusinessPerformanceRollItemResponseDto, isArray: true })
  items!: BusinessPerformanceRollItem[];

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

@Exclude()
export class BusinessOperationalProblemResponseDto implements BusinessOperationalProblemResponse {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  orderId!: string | null;

  @Expose()
  @ApiProperty({
    enum: ['weight_deviation', 'general', 'raw_material_shortage', 'defect', 'machine_breakdown'],
  })
  kind!: BusinessOperationalProblem['kind'];

  @Expose()
  @ApiProperty({ enum: ['open', 'resolved'] })
  status!: BusinessOperationalProblem['status'];

  @Expose()
  @ApiProperty()
  label!: string;

  @Expose()
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  orderNumber!: string | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  rollCode!: string | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  machineName!: string | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;
}

@Exclude()
export class BusinessOperationalProblemPageResponseDto implements BusinessOperationalProblemPage {
  @Expose()
  @Type(() => BusinessOperationalProblemResponseDto)
  @ApiProperty({ type: BusinessOperationalProblemResponseDto, isArray: true })
  items!: BusinessOperationalProblem[];

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
