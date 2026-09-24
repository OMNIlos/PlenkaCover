import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsUUID, Matches } from 'class-validator';

export class OneCStockPushDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value), {
    toClassOnly: true,
  })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description: 'SHA-256 returned by the immediately preceding stock preview.',
  })
  @Matches(/^[0-9a-f]{64}$/)
  snapshotHash!: string;
}

export class OneCStockItemResponseDto {
  @ApiProperty()
  materialId!: string;

  @ApiProperty()
  qty!: number;

  @ApiProperty()
  unit!: string;
}

export class OneCStockPushPreviewResponseDto {
  @ApiProperty({ type: [OneCStockItemResponseDto] })
  items!: OneCStockItemResponseDto[];

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  snapshotHash!: string;

  @ApiProperty()
  count!: number;

  @ApiProperty()
  totalQty!: number;

  @ApiProperty({
    description: 'True only for an enabled live HTTP adapter whose health probe is ready.',
  })
  writeReady!: boolean;

  @ApiProperty({
    enum: ['ready', 'mock_adapter', 'write_disabled', 'onec_unavailable'],
  })
  readinessCode!: 'ready' | 'mock_adapter' | 'write_disabled' | 'onec_unavailable';

  @ApiProperty({ description: 'Business-safe readiness explanation; never contains credentials.' })
  readinessMessage!: string;
}

class OneCStockPushAckResponseDto {
  @ApiProperty({ enum: ['http'] })
  mode!: 'http';

  @ApiProperty({ enum: [true] })
  accepted!: true;

  @ApiProperty({ enum: [true] })
  documentCreated!: true;

  @ApiProperty()
  count!: number;

  @ApiProperty()
  ref!: string;
}

export class OneCStockPushResponseDto extends OneCStockPushPreviewResponseDto {
  @ApiProperty({ format: 'uuid' })
  operationKey!: string;

  @ApiProperty()
  pushed!: number;

  @ApiProperty()
  replayed!: boolean;

  @ApiProperty({ type: OneCStockPushAckResponseDto })
  ack!: OneCStockPushAckResponseDto;
}
