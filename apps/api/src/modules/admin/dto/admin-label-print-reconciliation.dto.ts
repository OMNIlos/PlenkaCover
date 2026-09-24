import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, Length } from 'class-validator';
import { Trim } from './trimmed-string';

export const LABEL_PRINT_RECONCILIATION_OUTCOMES = ['label_observed', 'not_printed'] as const;
export type LabelPrintReconciliationOutcome = (typeof LABEL_PRINT_RECONCILIATION_OUTCOMES)[number];

export class AdminLabelPrintReconciliationDto {
  @ApiProperty({ format: 'uuid', description: 'Stable idempotency key for this decision.' })
  @IsUUID()
  operationKey!: string;

  @ApiProperty({ enum: LABEL_PRINT_RECONCILIATION_OUTCOMES })
  @IsIn([...LABEL_PRINT_RECONCILIATION_OUTCOMES])
  outcome!: LabelPrintReconciliationOutcome;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}
