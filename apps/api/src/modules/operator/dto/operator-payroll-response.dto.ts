import { ApiProperty, OmitType } from '@nestjs/swagger';
import type { OperatorPayrollPreview, OperatorShiftClosingPayroll } from '@plenka/contracts';
import {
  DirectorPayrollBreakdownResponseDto,
  DirectorPayrollRangeResponseDto,
  DirectorPayrollSummaryResponseDto,
  DirectorPayrollUnresolvedFactResponseDto,
} from '../../director/dto/payroll-response.dto';
import { PayrollTariffOrderReferenceResponseDto } from '../../director/dto/payroll-tariff-order.dto';

export class OperatorPayrollSummaryResponseDto extends OmitType(DirectorPayrollSummaryResponseDto, [
  'operatorCount',
] as const) {}

export class OperatorPayrollBreakdownResponseDto extends OmitType(
  DirectorPayrollBreakdownResponseDto,
  ['operatorId', 'operatorName'] as const,
) {}

export class OperatorPayrollUnresolvedFactResponseDto extends OmitType(
  DirectorPayrollUnresolvedFactResponseDto,
  ['operatorId', 'operatorName'] as const,
) {}

export class OperatorPayrollPreviewResponseDto implements OperatorPayrollPreview {
  @ApiProperty({ enum: ['complete', 'partial', 'empty'] })
  status!: OperatorPayrollPreview['status'];

  @ApiProperty({ type: [PayrollTariffOrderReferenceResponseDto] })
  appliedTariffOrders!: PayrollTariffOrderReferenceResponseDto[];

  @ApiProperty({ type: DirectorPayrollRangeResponseDto })
  range!: DirectorPayrollRangeResponseDto;

  @ApiProperty({ type: OperatorPayrollSummaryResponseDto })
  summary!: OperatorPayrollSummaryResponseDto;

  @ApiProperty({ type: [OperatorPayrollBreakdownResponseDto] })
  breakdown!: OperatorPayrollBreakdownResponseDto[];

  @ApiProperty({ type: [OperatorPayrollUnresolvedFactResponseDto] })
  unresolved!: OperatorPayrollUnresolvedFactResponseDto[];
}

export class OperatorShiftClosingPayrollResponseDto implements OperatorShiftClosingPayroll {
  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  shiftId!: string;

  @ApiProperty({ enum: ['complete', 'partial', 'empty'] })
  status!: OperatorShiftClosingPayroll['status'];

  @ApiProperty({ type: [PayrollTariffOrderReferenceResponseDto] })
  appliedTariffOrders!: PayrollTariffOrderReferenceResponseDto[];

  @ApiProperty({ type: OperatorPayrollSummaryResponseDto })
  summary!: OperatorPayrollSummaryResponseDto;

  @ApiProperty({ type: [OperatorPayrollBreakdownResponseDto] })
  breakdown!: OperatorPayrollBreakdownResponseDto[];

  @ApiProperty({ type: [OperatorPayrollUnresolvedFactResponseDto] })
  unresolved!: OperatorPayrollUnresolvedFactResponseDto[];
}
