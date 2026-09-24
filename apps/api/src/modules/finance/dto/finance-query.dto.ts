import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

export const FINANCE_ORDER_BUCKETS = [
  'actual',
  'actions',
  'problems',
  'completed',
  'unpaid',
  'overdue',
] as const;
export type FinanceOrderBucket = (typeof FINANCE_ORDER_BUCKETS)[number];

export function isFinanceOrderBucket(value: unknown): value is FinanceOrderBucket {
  return typeof value === 'string' && (FINANCE_ORDER_BUCKETS as readonly string[]).includes(value);
}

const EXACT_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isExactCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = EXACT_DATE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_PER_MONTH[month - 1];
  return day <= maxDay;
}

@ValidatorConstraint({ name: 'exactFinanceCalendarDate', async: false })
class ExactFinanceCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isExactCalendarDate(value);
  }

  defaultMessage(args: ValidationArguments) {
    return `${args.property} must be a real calendar date in YYYY-MM-DD format`;
  }
}

export class FinanceOrderQueryDto {
  @ApiPropertyOptional({ enum: FINANCE_ORDER_BUCKETS })
  @IsOptional()
  @IsIn([...FINANCE_ORDER_BUCKETS])
  bucket?: FinanceOrderBucket;
}

export class FinanceOverviewQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    pattern: EXACT_DATE.source,
    example: '2026-08-10',
    description: 'Exact real calendar date in YYYY-MM-DD format.',
  })
  @IsOptional()
  @Validate(ExactFinanceCalendarDateConstraint)
  date?: string;
}
