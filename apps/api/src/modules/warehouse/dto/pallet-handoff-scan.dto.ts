import { ApiProperty } from '@nestjs/swagger';
import type { WarehousePalletHandoffScanResult } from '@plenka/contracts';
import { IsString, IsUUID, Matches } from 'class-validator';

export class PalletHandoffScanDto {
  @ApiProperty({ format: 'uuid', description: 'Stable key generated once for this scan action.' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({
    pattern: '^plt_[0-9a-f]{64}$',
    description: 'Exact opaque payload typed from a sealed physical pallet label.',
  })
  @IsString()
  @Matches(/^plt_[0-9a-f]{64}$/u)
  payload!: string;
}

export class PalletHandoffScanResponseDto implements WarehousePalletHandoffScanResult {
  @ApiProperty({ format: 'uuid' })
  operationKey!: string;

  @ApiProperty()
  documentId!: string;

  @ApiProperty()
  palletId!: string;

  @ApiProperty()
  palletCode!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  deliveryTaskId!: string;

  @ApiProperty()
  deliveryCreated!: boolean;

  @ApiProperty({ minimum: 1 })
  rollCount!: number;

  @ApiProperty()
  replayed!: boolean;
}
