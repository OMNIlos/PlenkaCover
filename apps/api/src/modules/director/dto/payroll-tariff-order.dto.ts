import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  PAYROLL_TARIFF_ORDER_ERROR_CODES,
  PAYROLL_TARIFF_ORDER_STATUSES,
  type PayrollTariffMatrixV1,
} from '@plenka/contracts';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

class PayrollTariffThresholdDto {
  @ApiProperty({ type: 'integer', format: 'int64', minimum: 1, nullable: true })
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(1)
  @Max(MAX_SAFE_INTEGER)
  maxInclusiveGrams!: number | null;
}

export class PayrollTariffUrpBandDto extends PayrollTariffThresholdDto {
  @ApiProperty({ type: 'integer', format: 'int64', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_INTEGER)
  primaryRateKopecksPerKg!: number;

  @ApiProperty({ type: 'integer', format: 'int64', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_INTEGER)
  secondaryRateKopecksPerKg!: number;
}

export class PayrollTariffAbcBandDto extends PayrollTariffThresholdDto {
  @ApiProperty({ type: 'integer', format: 'int64', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_INTEGER)
  standardRateKopecksPerKg!: number;

  @ApiProperty({ type: 'integer', format: 'int64', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_INTEGER)
  blackWhiteRateKopecksPerKg!: number;
}

export class PayrollTariffLaddersDto {
  @ApiProperty({ type: [PayrollTariffUrpBandDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PayrollTariffUrpBandDto)
  urp12h!: PayrollTariffUrpBandDto[];

  @ApiProperty({ type: [PayrollTariffUrpBandDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PayrollTariffUrpBandDto)
  urp24h!: PayrollTariffUrpBandDto[];

  @ApiProperty({ type: [PayrollTariffAbcBandDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PayrollTariffAbcBandDto)
  abc12h!: PayrollTariffAbcBandDto[];

  @ApiProperty({ type: [PayrollTariffAbcBandDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PayrollTariffAbcBandDto)
  abc24h!: PayrollTariffAbcBandDto[];
}

export class PayrollTariffThinRollRuleDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ type: 'integer', format: 'int64', minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_SAFE_INTEGER)
  maxExclusiveGrams!: number;

  @ApiProperty({ type: 'integer', format: 'int64', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_INTEGER)
  rateKopecksPerKg!: number;
}

export class PayrollTariffAlabugaRuleDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ enum: ['abc_new'] })
  @Equals('abc_new')
  machineFamily!: 'abc_new';

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  normalizedLegalName!: string;

  @ApiProperty({ type: 'integer', format: 'int64', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_INTEGER)
  rateKopecksPerKg!: number;
}

export class PayrollTariffSpecialRulesDto {
  @ApiProperty({ type: PayrollTariffThinRollRuleDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PayrollTariffThinRollRuleDto)
  thinRoll!: PayrollTariffThinRollRuleDto;

  @ApiProperty({ type: PayrollTariffAlabugaRuleDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PayrollTariffAlabugaRuleDto)
  alabuga!: PayrollTariffAlabugaRuleDto;
}

export class PayrollTariffMatrixDto implements PayrollTariffMatrixV1 {
  @ApiProperty({ enum: [1] })
  @Equals(1)
  schemaVersion!: 1;

  @ApiProperty({ type: PayrollTariffLaddersDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PayrollTariffLaddersDto)
  ladders!: PayrollTariffLaddersDto;

  @ApiProperty({ type: PayrollTariffSpecialRulesDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PayrollTariffSpecialRulesDto)
  specialRules!: PayrollTariffSpecialRulesDto;
}

class PayrollTariffOrderDraftDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ format: 'date' })
  @IsDateString({ strict: true, strictSeparator: true })
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @ApiProperty({ type: PayrollTariffMatrixDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PayrollTariffMatrixDto)
  matrix!: PayrollTariffMatrixDto;
}

export class CreatePayrollTariffOrderDto extends PayrollTariffOrderDraftDto {}

export class UpdatePayrollTariffOrderDto extends PayrollTariffOrderDraftDto {
  @ApiProperty({ type: 'integer', format: 'int32', minimum: 1 })
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}

export class ReviewPayrollTariffOrderDto {
  @ApiProperty({ type: 'integer', format: 'int32', minimum: 1 })
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}

export class PublishPayrollTariffOrderDto extends ReviewPayrollTariffOrderDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ pattern: SHA256.source })
  @IsString()
  @Matches(SHA256)
  reviewedMatrixHash!: string;
}

export class PayrollTariffOrderFieldErrorResponseDto {
  @ApiProperty()
  path!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;
}

export class PayrollTariffOrderErrorResponseDto {
  @ApiProperty({ enum: PAYROLL_TARIFF_ORDER_ERROR_CODES })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ type: [PayrollTariffOrderFieldErrorResponseDto], required: false })
  fieldErrors?: PayrollTariffOrderFieldErrorResponseDto[];
}

export class PayrollTariffOrderReferenceResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ format: 'date' })
  effectiveFrom!: string;

  @ApiProperty({ enum: ['RUB'] })
  currency!: 'RUB';
}

export class PayrollTariffOrderListItemResponseDto extends PayrollTariffOrderReferenceResponseDto {
  @ApiProperty({ enum: PAYROLL_TARIFF_ORDER_STATUSES })
  status!: 'draft' | 'published';

  @ApiProperty({ type: 'integer', format: 'int32' })
  revision!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  publishedAt!: string | null;
}

export class PayrollTariffOrderViewResponseDto extends PayrollTariffOrderListItemResponseDto {
  @ApiProperty({ type: PayrollTariffMatrixDto })
  matrix!: PayrollTariffMatrixDto;

  @ApiProperty({ nullable: true })
  createdById!: string | null;

  @ApiProperty({ nullable: true })
  updatedById!: string | null;

  @ApiProperty({ nullable: true })
  publishedById!: string | null;
}

export class PayrollTariffOrderListResponseDto {
  @ApiProperty({ type: [PayrollTariffOrderListItemResponseDto] })
  items!: PayrollTariffOrderListItemResponseDto[];

  @ApiProperty({ nullable: true })
  activeOrderId!: string | null;

  @ApiProperty({ nullable: true })
  latestPublishedOrderId!: string | null;

  @ApiProperty({ format: 'date' })
  minimumPublishEffectiveFrom!: string;

  @ApiProperty({ enum: ['Europe/Moscow'] })
  timezone!: 'Europe/Moscow';

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}

export class PayrollTariffOrderResultResponseDto {
  @ApiProperty({ type: PayrollTariffOrderViewResponseDto })
  order!: PayrollTariffOrderViewResponseDto;

  @ApiProperty()
  replayed!: boolean;
}

export class PayrollTariffOrderReviewResponseDto {
  @ApiProperty()
  orderId!: string;

  @ApiProperty({ type: 'integer', format: 'int32' })
  revision!: number;

  @ApiProperty({ pattern: SHA256.source })
  matrixHash!: string;

  @ApiProperty({ format: 'date' })
  minimumPublishEffectiveFrom!: string;

  @ApiProperty()
  publishable!: boolean;

  @ApiProperty({ type: [PayrollTariffOrderFieldErrorResponseDto] })
  fieldErrors!: PayrollTariffOrderFieldErrorResponseDto[];
}
