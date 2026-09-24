import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BIG_BAG_STATUSES,
  DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES,
  DIRECTOR_ANALYTICS_BUCKETS,
  DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS,
  DIRECTOR_ANALYTICS_EVIDENCE_STATUSES,
  type BigBagStatus,
  type DirectorAnalyticsBucket,
  type DirectorAnalyticsBigBagEvidenceQuery,
  type DirectorAnalyticsBigBagUsageState,
  type DirectorAnalyticsEvidenceFreshness,
  type DirectorAnalyticsEvidenceQuery,
  type DirectorAnalyticsEvidenceQueryBase,
  type DirectorAnalyticsEvidenceStatus,
  type DirectorAnalyticsQuery,
  type DirectorAnalyticsShiftEvidenceQuery,
  type DirectorOperatorRollVarianceQuery,
} from '@plenka/contracts';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateBy,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  DIRECTOR_ANALYTICS_MAX_INCLUSIVE_DAYS,
  DIRECTOR_ANALYTICS_MIN_AS_OF_DATE,
  directorAnalyticsInclusiveDays,
  isSupportedDirectorAnalyticsAsOfDate,
  isStrictDirectorAnalyticsDate,
} from '../director-analytics.time';

@ValidatorConstraint({ name: 'strictDirectorAnalyticsDate', async: false })
class StrictDirectorAnalyticsDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isStrictDirectorAnalyticsDate(value);
  }

  defaultMessage(args: ValidationArguments) {
    return `${args.property} must be a supported calendar date in YYYY-MM-DD format`;
  }
}

@ValidatorConstraint({ name: 'supportedDirectorAnalyticsAsOfDate', async: false })
class SupportedDirectorAnalyticsAsOfDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isSupportedDirectorAnalyticsAsOfDate(value);
  }

  defaultMessage() {
    return `to must be on or after ${DIRECTOR_ANALYTICS_MIN_AS_OF_DATE} to support six-month analytics windows`;
  }
}

@ValidatorConstraint({ name: 'directorAnalyticsRange', async: false })
class DirectorAnalyticsRangeConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const query = args.object as Partial<DirectorAnalyticsQuery>;
    if (typeof query.from !== 'string' || typeof query.to !== 'string') return false;
    const inclusiveDays = directorAnalyticsInclusiveDays(query.from, query.to);
    return (
      inclusiveDays !== null &&
      inclusiveDays >= 1 &&
      inclusiveDays <= DIRECTOR_ANALYTICS_MAX_INCLUSIVE_DAYS
    );
  }

  defaultMessage() {
    return 'to must be on or after from and span no more than 366 days';
  }
}

function OptionalTrimmedText(maxLength = 100): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    IsString(),
    MinLength(1),
    MaxLength(maxLength),
  );
}

function OptionalNonNegativeDecimal(): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Type(() => Number),
    IsNumber({ allowInfinity: false, allowNaN: false }),
    Min(0),
  );
}

function OptionalSignedDecimal(): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Type(() => Number),
    IsNumber({ allowInfinity: false, allowNaN: false }),
  );
}

function OptionalNonNegativeInteger(): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Type(() => Number),
    IsInt(),
    Min(0),
  );
}

function OptionalAnalyticsDate(): PropertyDecorator {
  return applyDecorators(IsOptional(), IsString(), Validate(StrictDirectorAnalyticsDateConstraint));
}

function RangeEndFor(minField: string): PropertyDecorator {
  return ValidateBy({
    name: 'rangeEndFor',
    constraints: [minField],
    validator: {
      validate(max: unknown, args: ValidationArguments) {
        if (max === undefined) return true;
        const min = (args.object as Record<string, unknown>)[minField];
        if (min === undefined) return true;
        return typeof min === typeof max && (min as number) <= (max as number);
      },
      defaultMessage: (args) =>
        `${args?.property ?? 'range maximum'} must be greater than or equal to ${minField}`,
    },
  });
}

export class DirectorAnalyticsQueryDto implements DirectorAnalyticsQuery {
  @ApiProperty({
    format: 'date',
    example: '2026-07-01',
    description: 'Moscow-local date; supported years are 0001 through 9998.',
  })
  @IsString()
  @Validate(StrictDirectorAnalyticsDateConstraint)
  from!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-07-31',
    description:
      'Inclusive Moscow-local as-of date; earliest supported value is 0001-07-01 and maximum year is 9998.',
  })
  @IsString()
  @Validate(StrictDirectorAnalyticsDateConstraint)
  @Validate(SupportedDirectorAnalyticsAsOfDateConstraint)
  @Validate(DirectorAnalyticsRangeConstraint)
  to!: string;

  @ApiProperty({ enum: DIRECTOR_ANALYTICS_BUCKETS, example: 'day' })
  @IsIn([...DIRECTOR_ANALYTICS_BUCKETS])
  bucket!: DirectorAnalyticsBucket;
}

export class DirectorAnalyticsEvidenceQueryBaseDto
  extends DirectorAnalyticsQueryDto
  implements DirectorAnalyticsEvidenceQueryBase
{
  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  operatorId?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  postId?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  shiftId?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  bigBagId?: string;

  @ApiPropertyOptional({
    description: 'Case-insensitive search across safe evidence identifiers and labels.',
    maxLength: 100,
  })
  @OptionalTrimmedText()
  q?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  operatorQuery?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  postQuery?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  shiftQuery?: string;

  @ApiPropertyOptional({ enum: DIRECTOR_ANALYTICS_EVIDENCE_STATUSES })
  @IsOptional()
  @IsIn([...DIRECTOR_ANALYTICS_EVIDENCE_STATUSES])
  status?: DirectorAnalyticsEvidenceStatus;

  @ApiPropertyOptional({ enum: DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS })
  @IsOptional()
  @IsIn([...DIRECTOR_ANALYTICS_EVIDENCE_FRESHNESS])
  freshness?: DirectorAnalyticsEvidenceFreshness;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  latestEvidenceFrom?: string;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  latestEvidenceTo?: string;

  @ApiPropertyOptional({ description: 'Opaque timestamp/id cursor', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

/** @deprecated Use the endpoint-specific evidence query DTO. */
export class DirectorAnalyticsEvidenceQueryDto
  extends DirectorAnalyticsEvidenceQueryBaseDto
  implements DirectorAnalyticsEvidenceQuery {}

export class DirectorAnalyticsShiftEvidenceQueryDto
  extends DirectorAnalyticsEvidenceQueryBaseDto
  implements DirectorAnalyticsShiftEvidenceQuery
{
  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  startedFrom?: string;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  startedTo?: string;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  endedFrom?: string;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  endedTo?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  startKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('startKgMin')
  startKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  remainingKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('remainingKgMin')
  remainingKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  actualUsageKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('actualUsageKgMin')
  actualUsageKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  expectedUsageKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('expectedUsageKgMin')
  expectedUsageKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  producedKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('producedKgMin')
  producedKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  rollCountMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  @RangeEndFor('rollCountMin')
  rollCountMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  defectKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('defectKgMin')
  defectKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  defectCountMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  @RangeEndFor('defectCountMin')
  defectCountMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  unverifiedDefectCountMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  @RangeEndFor('unverifiedDefectCountMin')
  unverifiedDefectCountMax?: number;

  @ApiPropertyOptional()
  @OptionalSignedDecimal()
  deviationKgMin?: number;

  @ApiPropertyOptional()
  @OptionalSignedDecimal()
  @RangeEndFor('deviationKgMin')
  deviationKgMax?: number;

  @ApiPropertyOptional()
  @OptionalSignedDecimal()
  deviationPercentMin?: number;

  @ApiPropertyOptional()
  @OptionalSignedDecimal()
  @RangeEndFor('deviationPercentMin')
  deviationPercentMax?: number;
}

export class DirectorAnalyticsBigBagEvidenceQueryDto
  extends DirectorAnalyticsEvidenceQueryBaseDto
  implements DirectorAnalyticsBigBagEvidenceQuery
{
  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  bigBagQuery?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @OptionalTrimmedText()
  materialQuery?: string;

  @ApiPropertyOptional({ enum: BIG_BAG_STATUSES })
  @IsOptional()
  @IsIn([...BIG_BAG_STATUSES])
  bigBagStatus?: BigBagStatus;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  openedFrom?: string;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  openedTo?: string;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  closedFrom?: string;

  @ApiPropertyOptional({ format: 'date' })
  @OptionalAnalyticsDate()
  closedTo?: string;

  @ApiPropertyOptional({ enum: DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES })
  @IsOptional()
  @IsIn([...DIRECTOR_ANALYTICS_BIG_BAG_USAGE_STATES])
  usageState?: DirectorAnalyticsBigBagUsageState;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  startKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('startKgMin')
  startKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  endKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('endKgMin')
  endKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  currentKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('currentKgMin')
  currentKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  bagUsageKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('bagUsageKgMin')
  bagUsageKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  actualUsageKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('actualUsageKgMin')
  actualUsageKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  expectedUsageKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('expectedUsageKgMin')
  expectedUsageKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  producedKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('producedKgMin')
  producedKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  rollCountMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  @RangeEndFor('rollCountMin')
  rollCountMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  defectKgMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeDecimal()
  @RangeEndFor('defectKgMin')
  defectKgMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  defectCountMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  @RangeEndFor('defectCountMin')
  defectCountMax?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  unverifiedDefectCountMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @OptionalNonNegativeInteger()
  @RangeEndFor('unverifiedDefectCountMin')
  unverifiedDefectCountMax?: number;

  @ApiPropertyOptional()
  @OptionalSignedDecimal()
  deviationKgMin?: number;

  @ApiPropertyOptional()
  @OptionalSignedDecimal()
  @RangeEndFor('deviationKgMin')
  deviationKgMax?: number;

  @ApiPropertyOptional()
  @OptionalSignedDecimal()
  deviationPercentMin?: number;

  @ApiPropertyOptional()
  @OptionalSignedDecimal()
  @RangeEndFor('deviationPercentMin')
  deviationPercentMax?: number;
}

export class DirectorOperatorRollVarianceQueryDto implements DirectorOperatorRollVarianceQuery {
  @ApiProperty({
    format: 'date',
    example: '2026-07-01',
    description: 'Moscow-local date; supported years are 0001 through 9998.',
  })
  @IsString()
  @Validate(StrictDirectorAnalyticsDateConstraint)
  from!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-07-31',
    description: 'Inclusive Moscow-local date; supported years are 0001 through 9998.',
  })
  @IsString()
  @Validate(StrictDirectorAnalyticsDateConstraint)
  @Validate(DirectorAnalyticsRangeConstraint)
  to!: string;

  @ApiPropertyOptional({ description: 'Opaque producedAt/rollId cursor', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
