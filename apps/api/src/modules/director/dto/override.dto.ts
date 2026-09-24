import { ApiProperty } from '@nestjs/swagger';
import {
  PAYMENT_UPDATE_STATUSES,
  PRODUCTION_INDICATORS,
  type PaymentUpdateStatus,
  type ProductionIndicator,
} from '@plenka/contracts';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Director override is NOT routine role ownership (ТЗ §4, §5.6 OverrideAction):
 * reason AND evidence are required, and the action is double-audited
 * (override_requested + override_applied).
 */
export class OverrideDto {
  @ApiProperty({ description: 'Why the override is needed (required, audited)' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @Length(3, 500)
  reason!: string;

  @ApiProperty({ description: 'Evidence backing the override (required, audited)' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @Length(3, 500)
  evidence!: string;

  @ApiProperty({ required: false, description: 'Optional new status/value to apply to the target' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 80)
  value?: string;
}

export class FinanceOverrideDto extends OverrideDto {
  @ApiProperty({ required: false, enum: PAYMENT_UPDATE_STATUSES })
  @IsOptional()
  @IsIn([...PAYMENT_UPDATE_STATUSES])
  declare value?: PaymentUpdateStatus;
}

export class ProductionOverrideDto extends OverrideDto {
  @ApiProperty({ required: false, enum: PRODUCTION_INDICATORS })
  @IsOptional()
  @IsIn([...PRODUCTION_INDICATORS])
  declare value?: ProductionIndicator;
}
