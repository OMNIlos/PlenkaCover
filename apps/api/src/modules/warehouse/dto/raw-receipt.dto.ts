import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** Additive warehouse receipt. The UUID makes retries safe after an uncertain response. */
export class RawReceiptDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value), {
    toClassOnly: true,
  })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ description: 'Quantity physically received into warehouse stock.' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(1_000_000)
  receivedQty!: number;

  @ApiProperty({ description: 'Receipt document or other audited basis.', maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class RawMaterialStockResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  materialId!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  actualQty!: number;

  @ApiProperty()
  unit!: string;

  @ApiProperty({ nullable: true })
  package!: string | null;

  @ApiProperty({ enum: ['warehouse_fact', 'manual', 'source'] })
  factStatus!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty()
  revision!: number;

  @ApiProperty({ nullable: true })
  externalId!: string | null;

  @ApiProperty({ nullable: true })
  sourceVersion!: string | null;
}
