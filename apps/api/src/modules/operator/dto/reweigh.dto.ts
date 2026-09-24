import { ApiProperty } from '@nestjs/swagger';
import type { OperatorRollReweighResult, OperatorWeightProjection } from '@plenka/contracts';
import { OperatorOperationDto } from './operation.dto';

/** Pre-print reweigh accepts only the idempotency key; weight and device stay server-owned. */
export class ReweighRollDto extends OperatorOperationDto {}

class OperatorWeightProjectionResponseDto implements OperatorWeightProjection {
  @ApiProperty()
  grossKg!: number;

  @ApiProperty()
  netKg!: number;

  @ApiProperty({ nullable: true, type: Boolean })
  toleranceOk!: boolean | null;
}

export class OperatorRollReweighResponseDto implements OperatorRollReweighResult {
  @ApiProperty()
  rollCode!: string;

  @ApiProperty({ enum: ['qr_print'] })
  step!: 'qr_print';

  @ApiProperty({ type: OperatorWeightProjectionResponseDto })
  previousWeight!: OperatorWeightProjection;

  @ApiProperty({ type: OperatorWeightProjectionResponseDto })
  currentWeight!: OperatorWeightProjection;
}
