import { ApiProperty } from '@nestjs/swagger';
import {
  DIRECTOR_PAYROLL_MACHINE_FAMILIES,
  DIRECTOR_PAYROLL_MATERIAL_CLASSES,
  DIRECTOR_PAYROLL_SHIFT_DURATIONS,
  DIRECTOR_PAYROLL_TARIFF_RULES,
  DIRECTOR_PAYROLL_TIMEZONE,
  DIRECTOR_PAYROLL_UNRESOLVED_REASONS,
  type AppliedPayrollTariffOrder,
  type DirectorPayrollBreakdownRow,
  type DirectorPayrollOperatorSummary,
  type DirectorPayrollPreview,
  type DirectorPayrollUnresolvedFact,
} from '@plenka/contracts';
import {
  PayrollTariffMatrixDto,
  PayrollTariffOrderReferenceResponseDto,
} from './payroll-tariff-order.dto';

type DirectorPayrollRange = DirectorPayrollPreview['range'];
type DirectorPayrollSummary = DirectorPayrollPreview['summary'];

export class AppliedPayrollTariffOrderResponseDto
  extends PayrollTariffOrderReferenceResponseDto
  implements AppliedPayrollTariffOrder
{
  @ApiProperty({ type: PayrollTariffMatrixDto })
  matrix!: PayrollTariffMatrixDto;
}

export class DirectorPayrollRangeResponseDto implements DirectorPayrollRange {
  @ApiProperty({ format: 'date' })
  fromDate!: string;

  @ApiProperty({ format: 'date' })
  toDate!: string;

  @ApiProperty({ enum: [DIRECTOR_PAYROLL_TIMEZONE] })
  timezone!: typeof DIRECTOR_PAYROLL_TIMEZONE;

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}

export class DirectorPayrollSummaryResponseDto implements DirectorPayrollSummary {
  @ApiProperty({ type: 'integer', format: 'int64' })
  payableAmountKopecks!: number;

  @ApiProperty({ type: Number })
  payableKg!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  machineShiftCount!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  operatorCount!: number;

  @ApiProperty({ type: Number })
  unresolvedKg!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  unresolvedFactCount!: number;

  @ApiProperty({ type: Number })
  excludedDefectKg!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  excludedDefectRollCount!: number;
}

export class DirectorPayrollOperatorSummaryResponseDto implements DirectorPayrollOperatorSummary {
  @ApiProperty()
  operatorId!: string;

  @ApiProperty()
  operatorName!: string;

  @ApiProperty({ type: Number })
  payableKg!: number;

  @ApiProperty({ type: 'integer', format: 'int64' })
  amountKopecks!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  machineShiftCount!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  unresolvedFactCount!: number;
}

export class DirectorPayrollBreakdownResponseDto implements DirectorPayrollBreakdownRow {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  tariffOrderId!: string;

  @ApiProperty()
  operatorId!: string;

  @ApiProperty()
  operatorName!: string;

  @ApiProperty()
  shiftId!: string;

  @ApiProperty()
  shiftLabel!: string;

  @ApiProperty({ format: 'date' })
  shiftDate!: string;

  @ApiProperty()
  postId!: string;

  @ApiProperty()
  postCode!: string;

  @ApiProperty()
  postName!: string;

  @ApiProperty({ enum: DIRECTOR_PAYROLL_MACHINE_FAMILIES })
  machineFamily!: DirectorPayrollBreakdownRow['machineFamily'];

  @ApiProperty({ enum: DIRECTOR_PAYROLL_SHIFT_DURATIONS })
  shiftDuration!: DirectorPayrollBreakdownRow['shiftDuration'];

  @ApiProperty({ type: Number })
  shiftOutputKg!: number;

  @ApiProperty({ type: Number })
  payableKg!: number;

  @ApiProperty({ type: 'integer', format: 'int32' })
  rateKopecksPerKg!: number;

  @ApiProperty({ type: 'integer', format: 'int64' })
  amountKopecks!: number;

  @ApiProperty({ enum: DIRECTOR_PAYROLL_TARIFF_RULES })
  tariffRule!: DirectorPayrollBreakdownRow['tariffRule'];

  @ApiProperty()
  basisLabel!: string;

  @ApiProperty({ nullable: true, type: String, enum: DIRECTOR_PAYROLL_MATERIAL_CLASSES })
  materialClass!: DirectorPayrollBreakdownRow['materialClass'];

  @ApiProperty({ nullable: true, type: String, enum: ['standard', 'black_white'] })
  filmClass!: DirectorPayrollBreakdownRow['filmClass'];

  @ApiProperty()
  specialCustomer!: boolean;
}

export class DirectorPayrollUnresolvedFactResponseDto implements DirectorPayrollUnresolvedFact {
  @ApiProperty()
  rollId!: string;

  @ApiProperty()
  rollCode!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ format: 'date-time' })
  producedAt!: string;

  @ApiProperty({ type: Number })
  netKg!: number;

  @ApiProperty({ nullable: true, type: String })
  operatorId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  operatorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  shiftId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  shiftLabel!: string | null;

  @ApiProperty({ nullable: true, type: String })
  postId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  postCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  postName!: string | null;

  @ApiProperty({ enum: DIRECTOR_PAYROLL_UNRESOLVED_REASONS, isArray: true })
  reasons!: DirectorPayrollUnresolvedFact['reasons'];
}

export class DirectorPayrollPreviewResponseDto implements DirectorPayrollPreview {
  @ApiProperty({ enum: ['complete', 'partial', 'empty'] })
  status!: DirectorPayrollPreview['status'];

  @ApiProperty({ type: [AppliedPayrollTariffOrderResponseDto] })
  appliedTariffOrders!: AppliedPayrollTariffOrderResponseDto[];

  @ApiProperty({ type: DirectorPayrollRangeResponseDto })
  range!: DirectorPayrollRangeResponseDto;

  @ApiProperty({ type: DirectorPayrollSummaryResponseDto })
  summary!: DirectorPayrollSummaryResponseDto;

  @ApiProperty({ type: [DirectorPayrollOperatorSummaryResponseDto] })
  operators!: DirectorPayrollOperatorSummaryResponseDto[];

  @ApiProperty({ type: [DirectorPayrollBreakdownResponseDto] })
  breakdown!: DirectorPayrollBreakdownResponseDto[];

  @ApiProperty({ type: [DirectorPayrollUnresolvedFactResponseDto] })
  unresolved!: DirectorPayrollUnresolvedFactResponseDto[];
}
