import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, Matches } from 'class-validator';

const DEFECT_BAG_MODES = ['receiving', 'shipping'] as const;

export class DefectBagQueryDto {
  @ApiProperty({ enum: DEFECT_BAG_MODES })
  @IsIn(DEFECT_BAG_MODES)
  mode!: (typeof DEFECT_BAG_MODES)[number];
}

export class DefectBagScanDto {
  @ApiProperty({ format: 'uuid', description: 'Stable UUID-v4 for one scan intent' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ description: 'Exact opaque bytes entered by the HID scanner' })
  @IsString()
  @Matches(/^bbt_[0-9a-f]{64}$/u)
  payload!: string;
}
