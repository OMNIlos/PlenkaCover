import { ApiProperty } from '@nestjs/swagger';
import type { WarehousePalletDeliveryScanResult } from '@plenka/contracts';
import { IsString, IsUUID, Matches } from 'class-validator';

export class PalletDeliveryScanDto {
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

export class PalletDeliveryScanResponseDto implements WarehousePalletDeliveryScanResult {
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

  @ApiProperty({ minimum: 1, maximum: 100 })
  rollCount!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  newlyDeliveredRollCount!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  alreadyDeliveredRollCount!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  remainingRollCount!: number;

  @ApiProperty({ enum: ['open', 'partial', 'closed'] })
  taskStatus!: 'open' | 'partial' | 'closed';

  @ApiProperty()
  deliveryClosed!: boolean;

  @ApiProperty()
  replayed!: boolean;
}
