import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** Manual stock correction — warehouse fact is operational truth, always audited (ТЗ §3, §5.4). */
export class RawAdjustDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value), {
    toClassOnly: true,
  })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ description: 'New actual (warehouse-fact) quantity' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(1_000_000)
  actualQty!: number;

  @ApiProperty({
    description: 'Why the stock was corrected (audited)',
    maxLength: 500,
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
