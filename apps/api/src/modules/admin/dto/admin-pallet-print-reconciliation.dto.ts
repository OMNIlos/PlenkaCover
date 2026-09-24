import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Trim } from './trimmed-string';

export const PALLET_PRINT_RECONCILIATION_OUTCOMES = ['label_observed', 'not_printed'] as const;
export type PalletPrintReconciliationOutcome =
  (typeof PALLET_PRINT_RECONCILIATION_OUTCOMES)[number];

export class AdminPalletPrintReconciliationQueryDto {
  @ApiProperty({ required: false, default: 25, minimum: 1, maximum: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 25;
}

export class AdminUnresolvedPalletPrintJobResponseDto {
  @ApiProperty()
  printJobId!: string;

  @ApiProperty()
  palletListDocumentId!: string;

  @ApiProperty()
  palletId!: string;

  @ApiProperty({ enum: ['delivery_unknown'] })
  status!: 'delivery_unknown';

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt!: string | null;
}

export class AdminPalletPrintReconciliationDto {
  @ApiProperty({ format: 'uuid', description: 'Stable idempotency key for this decision.' })
  @IsUUID()
  operationKey!: string;

  @ApiProperty({ enum: PALLET_PRINT_RECONCILIATION_OUTCOMES })
  @IsIn([...PALLET_PRINT_RECONCILIATION_OUTCOMES])
  outcome!: PalletPrintReconciliationOutcome;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class AdminPalletPrintReconciliationResponseDto {
  @ApiProperty({ format: 'uuid' })
  operationKey!: string;

  @ApiProperty()
  printJobId!: string;

  @ApiProperty()
  palletListDocumentId!: string;

  @ApiProperty({ enum: PALLET_PRINT_RECONCILIATION_OUTCOMES })
  outcome!: PalletPrintReconciliationOutcome;

  @ApiProperty({ enum: ['submitted', 'failed'] })
  status!: 'submitted' | 'failed';
}
