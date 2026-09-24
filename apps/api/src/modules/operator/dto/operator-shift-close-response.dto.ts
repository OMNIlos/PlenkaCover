import { ApiProperty } from '@nestjs/swagger';
import type { OperatorShiftBalance, OperatorShiftCloseResult } from '@plenka/contracts';
import { OperatorShiftClosingPayrollResponseDto } from './operator-payroll-response.dto';

class OperatorShiftBalanceResponseDto implements OperatorShiftBalance {
  @ApiProperty()
  producedKg!: number;

  @ApiProperty()
  defectKg!: number;

  @ApiProperty()
  expectedUsageKg!: number;

  @ApiProperty({ nullable: true })
  actualUsageKg!: number | null;

  @ApiProperty({ nullable: true })
  deviationPercent!: number | null;

  @ApiProperty({ enum: ['pending', 'ok', 'mismatch'] })
  status!: OperatorShiftBalance['status'];
}

export class OperatorShiftCloseResponseDto implements OperatorShiftCloseResult {
  @ApiProperty({ type: OperatorShiftBalanceResponseDto })
  balance!: OperatorShiftBalanceResponseDto;

  @ApiProperty({ nullable: true })
  problemId!: string | null;

  @ApiProperty({ type: [String] })
  releasedRollIds!: string[];

  @ApiProperty({ type: OperatorShiftClosingPayrollResponseDto })
  closingPayroll!: OperatorShiftClosingPayrollResponseDto;
}
