import { ApiProperty } from '@nestjs/swagger';
import type { DirectorPayrollQuery } from '@plenka/contracts';
import {
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  DIRECTOR_ANALYTICS_MAX_INCLUSIVE_DAYS,
  directorAnalyticsInclusiveDays,
  isStrictDirectorAnalyticsDate,
} from '../director-analytics.time';

@ValidatorConstraint({ name: 'strictDirectorPayrollDate', async: false })
class StrictDirectorPayrollDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isStrictDirectorAnalyticsDate(value);
  }

  defaultMessage(args: ValidationArguments) {
    return `${args.property} must be a real Moscow calendar date in YYYY-MM-DD format`;
  }
}

@ValidatorConstraint({ name: 'directorPayrollRange', async: false })
class DirectorPayrollRangeConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const query = args.object as Partial<DirectorPayrollQuery>;
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

export class DirectorPayrollQueryDto implements DirectorPayrollQuery {
  @ApiProperty({
    format: 'date',
    example: '2026-07-01',
    description: 'Inclusive Moscow-local date.',
  })
  @Validate(StrictDirectorPayrollDateConstraint)
  from!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-07-31',
    description: 'Inclusive Moscow-local date; the range may span at most 366 days.',
  })
  @Validate(StrictDirectorPayrollDateConstraint)
  @Validate(DirectorPayrollRangeConstraint)
  to!: string;
}
