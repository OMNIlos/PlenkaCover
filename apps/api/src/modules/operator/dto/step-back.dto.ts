import { ApiProperty } from '@nestjs/swagger';
import type { OperatorRollStepBackResult } from '@plenka/contracts';

export class OperatorRollStepBackResponseDto implements OperatorRollStepBackResult {
  @ApiProperty()
  rollCode!: string;

  @ApiProperty({ enum: ['qr_print', 'roll_weight'] })
  previousStep!: 'qr_print' | 'roll_weight';

  @ApiProperty({ enum: ['roll_weight', 'spool_weight'] })
  step!: 'roll_weight' | 'spool_weight';
}
