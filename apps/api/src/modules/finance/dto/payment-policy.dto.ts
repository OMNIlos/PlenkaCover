import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  PAYMENT_STAGE_TRIGGERS,
  type PaymentPolicyInput,
  type PaymentPolicyStageInput,
  type PaymentScheduleDateKind,
  type PaymentStageTrigger,
} from '@plenka/contracts';

const PAYMENT_PREVIEW_DATE_KINDS = ['actual', 'condition'] as const;

export class PaymentPolicyStageDto implements PaymentPolicyStageInput {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  sequence!: number;

  @ApiProperty({ enum: PAYMENT_STAGE_TRIGGERS })
  @IsIn([...PAYMENT_STAGE_TRIGGERS])
  trigger!: PaymentStageTrigger;

  @ApiProperty({ minimum: 1, maximum: 10_000 })
  @IsInt()
  @Min(1)
  @Max(10_000)
  percentageBasisPoints!: number;

  @ApiProperty({ minimum: 0, maximum: 3650 })
  @IsInt()
  @Min(0)
  @Max(3650)
  offsetDays!: number;

  @ApiProperty({ required: false, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class PaymentPolicyDto implements PaymentPolicyInput {
  @ApiProperty({ minimum: 0, maximum: 3650 })
  @IsInt()
  @Min(0)
  @Max(3650)
  installmentDays!: number;

  @ApiProperty({ type: [PaymentPolicyStageDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PaymentPolicyStageDto)
  stages!: PaymentPolicyStageDto[];
}

export class PreviewPaymentPolicyDto {
  @ApiPropertyOptional({
    minimum: 0.01,
    multipleOf: 0.01,
    description:
      'Draft amount used before manual invoice creation. Existing invoices always use their recorded amount.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  @ApiProperty({ type: PaymentPolicyDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PaymentPolicyDto)
  paymentPolicy!: PaymentPolicyDto;
}

export class PaymentPolicyPreviewRowDto implements PaymentPolicyStageInput {
  @ApiProperty({ minimum: 1 })
  sequence!: number;

  @ApiProperty({ enum: PAYMENT_STAGE_TRIGGERS })
  trigger!: PaymentStageTrigger;

  @ApiProperty({ minimum: 1, maximum: 10_000 })
  percentageBasisPoints!: number;

  @ApiProperty({ minimum: 0, maximum: 3650 })
  offsetDays!: number;

  @ApiProperty({ required: false, maxLength: 120 })
  label?: string;

  @ApiProperty({ minimum: 0.01, multipleOf: 0.01 })
  amount!: number;

  @ApiProperty({ type: String, nullable: true, example: '2026-08-30' })
  date!: string | null;

  @ApiProperty({ enum: PAYMENT_PREVIEW_DATE_KINDS })
  dateKind!: Extract<PaymentScheduleDateKind, 'actual' | 'condition'>;
}

export class PaymentPolicyPreviewDto {
  @ApiProperty({ type: [PaymentPolicyPreviewRowDto] })
  rows!: PaymentPolicyPreviewRowDto[];
}

export class UpdatePaymentPolicyDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ type: PaymentPolicyDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PaymentPolicyDto)
  paymentPolicy!: PaymentPolicyDto;
}
