import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PRODUCTION_COST_UNRESOLVED_REASONS,
  type CorrectRollProductionCostInput,
  type ProductionCostUnresolvedReason,
} from '@plenka/contracts';
import { IsInt, IsNotEmpty, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { ProductionCostPayrollSourceResponseDto } from '../../../common/production-cost/production-cost-payroll-source.dto';

export class CorrectRollProductionCostDto implements CorrectRollProductionCostInput {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ type: 'integer', minimum: 1 })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class RollProductionCostSnapshotResponseDto {
  @ApiProperty({ enum: ['actual_snapshot'] })
  kind!: 'actual_snapshot';

  @ApiProperty({ enum: ['complete', 'partial'] })
  status!: 'complete' | 'partial';

  @ApiProperty()
  calculationVersion!: string;

  @ApiProperty()
  snapshotId!: string;

  @ApiProperty({ type: 'integer', minimum: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  producedAt!: string;

  @ApiProperty({ format: 'date-time' })
  closedAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    type: 'object',
    properties: { kind: { type: 'string', enum: ['actual'] }, weightGrams: { type: 'integer' } },
  })
  basis!: { kind: 'actual'; weightGrams: number };

  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  materialAmountKopecks!: number | null;

  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  spoolAmountKopecks!: number | null;

  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  payrollAmountKopecks!: number | null;

  @ApiProperty({ type: ProductionCostPayrollSourceResponseDto, nullable: true })
  payrollSource!: ProductionCostPayrollSourceResponseDto | null;

  @ApiProperty({ type: 'integer', format: 'int64' })
  additionalAmountKopecks!: number;

  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  totalAmountKopecks!: number | null;

  @ApiPropertyOptional({ type: 'integer', format: 'int64', nullable: true })
  totalKopecksPerKg!: number | null;

  @ApiProperty({ enum: PRODUCTION_COST_UNRESOLVED_REASONS, isArray: true })
  unresolvedReasons!: ProductionCostUnresolvedReason[];
}
