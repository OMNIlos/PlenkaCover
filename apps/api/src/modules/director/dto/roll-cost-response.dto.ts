import { ApiProperty } from '@nestjs/swagger';
import type {
  DirectorRollCostAdditionalSource,
  DirectorRollCostMaterialSource,
  DirectorRollCostPayrollSource,
  DirectorRollCostPreview,
  DirectorRollCostRow,
  ProductionCostUnresolvedReason,
} from '@plenka/contracts';
import { ProductionCostPayrollSourceResponseDto } from '../../../common/production-cost/production-cost-payroll-source.dto';

export class DirectorRollCostMaterialSourceResponseDto implements DirectorRollCostMaterialSource {
  @ApiProperty({ enum: ['shift_bigbag', 'material_reference'] })
  kind!: 'shift_bigbag' | 'material_reference';

  @ApiProperty()
  sourceId!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ format: 'date-time' })
  effectiveAt!: string;

  @ApiProperty()
  consumedKg!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  priceKopecksPerKg!: number;

  @ApiProperty({ type: 'integer', format: 'int64' })
  allocatedAmountKopecks!: number;
}

export class DirectorRollCostAdditionalSourceResponseDto implements DirectorRollCostAdditionalSource {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ['direct', 'finished_net_kg'] })
  allocationBasis!: 'direct' | 'finished_net_kg';

  @ApiProperty()
  source!: string;

  @ApiProperty({ format: 'date-time' })
  effectiveAt!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: 'integer', format: 'int64' })
  allocatedAmountKopecks!: number;
}

export class DirectorRollCostPayrollSourceResponseDto
  extends ProductionCostPayrollSourceResponseDto
  implements DirectorRollCostPayrollSource {}

export class DirectorRollCostRowResponseDto implements DirectorRollCostRow {
  @ApiProperty()
  rollId!: string;

  @ApiProperty()
  rollCode!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ format: 'date-time' })
  producedAt!: string;

  @ApiProperty()
  netKg!: number;

  @ApiProperty({ nullable: true })
  operatorName!: string | null;

  @ApiProperty({ enum: ['complete', 'partial'] })
  status!: 'complete' | 'partial';

  @ApiProperty({ type: 'integer', format: 'int64', nullable: true })
  materialAmountKopecks!: number | null;

  @ApiProperty({ type: 'integer', format: 'int64', nullable: true })
  payrollAmountKopecks!: number | null;

  @ApiProperty({ type: () => DirectorRollCostPayrollSourceResponseDto, nullable: true })
  payrollSource!: DirectorRollCostPayrollSource | null;

  @ApiProperty({ type: 'integer', format: 'int64' })
  additionalAmountKopecks!: number;

  @ApiProperty({ type: 'integer', format: 'int64', nullable: true })
  totalAmountKopecks!: number | null;

  @ApiProperty({ type: () => [DirectorRollCostMaterialSourceResponseDto] })
  materialSources!: DirectorRollCostMaterialSource[];

  @ApiProperty({ type: () => [DirectorRollCostAdditionalSourceResponseDto] })
  additionalSources!: DirectorRollCostAdditionalSource[];

  @ApiProperty({
    enum: ['material_usage_unresolved', 'material_price_unresolved', 'payroll_unresolved'],
    isArray: true,
  })
  unresolvedReasons!: ProductionCostUnresolvedReason[];
}

export class DirectorRollCostRangeResponseDto {
  @ApiProperty({ format: 'date' })
  fromDate!: string;

  @ApiProperty({ format: 'date' })
  toDate!: string;

  @ApiProperty()
  timezone!: string;

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}

export class DirectorRollCostSummaryResponseDto {
  @ApiProperty({ type: 'integer', format: 'int32' })
  rollCount!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  completeRollCount!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  partialRollCount!: number;

  @ApiProperty({ type: 'integer', format: 'int64' })
  completeCostKopecks!: number;
}

export class DirectorRollCostPreviewResponseDto implements DirectorRollCostPreview {
  @ApiProperty({ enum: ['empty', 'complete', 'partial'] })
  status!: 'empty' | 'complete' | 'partial';

  @ApiProperty({ type: () => DirectorRollCostRangeResponseDto })
  range!: DirectorRollCostPreview['range'];

  @ApiProperty({ type: () => DirectorRollCostSummaryResponseDto })
  summary!: DirectorRollCostPreview['summary'];

  @ApiProperty({ type: () => [DirectorRollCostRowResponseDto] })
  rows!: DirectorRollCostRow[];
}
