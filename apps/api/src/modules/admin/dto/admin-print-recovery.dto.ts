import type { BagPrintRecoveryKind } from '@plenka/contracts';
import type { LabelPrintReconciliationOutcome } from './admin-label-print-reconciliation.dto';
import { ApiProperty } from '@nestjs/swagger';
import {
  PRINT_RECOVERY_KINDS,
  type PrintRecoveryKind,
  type UnresolvedPrintJob,
} from '@plenka/contracts';

export class AdminUnresolvedPrintJobDto implements UnresolvedPrintJob {
  @ApiProperty({ enum: PRINT_RECOVERY_KINDS })
  kind!: PrintRecoveryKind;

  @ApiProperty()
  printJobId!: string;

  @ApiProperty()
  objectCode!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminBagPrintReconciliationResponseDto {
  @ApiProperty({ format: 'uuid' })
  operationKey!: string;

  @ApiProperty()
  printJobId!: string;

  @ApiProperty({ enum: ['defect_bag', 'big_bag'] })
  kind!: BagPrintRecoveryKind;

  @ApiProperty({ enum: ['label_observed', 'not_printed'] })
  outcome!: LabelPrintReconciliationOutcome;

  @ApiProperty({ enum: ['submitted', 'failed'] })
  status!: 'submitted' | 'failed';
}
