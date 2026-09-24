import { ApiProperty } from '@nestjs/swagger';
import type { OperatorOrderMass } from '@plenka/contracts';

export class OperatorOrderMassResponseDto implements OperatorOrderMass {
  @ApiProperty({ example: 120 })
  orderPlannedNetKg!: number;

  @ApiProperty({ example: 80 })
  weighedPlannedNetKg!: number;

  @ApiProperty({ example: 81.25 })
  actualNetKg!: number;

  @ApiProperty({ example: 1.25, description: 'Signed actual minus weighed plan' })
  deviationKg!: number;

  @ApiProperty({ example: 2 })
  weighedRollCount!: number;

  @ApiProperty({ example: 3 })
  totalRollCount!: number;
}
