import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { UtcIsoString, UuidString } from '@plenka/contracts';

export class CoveragePhysicalExceptionDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4')
  clientRequestId!: UuidString;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedGeneration!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedStateVersion!: number;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/Z$/u)
  expectedTaskUpdatedAt!: UtcIsoString;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  scanRowId!: string;

  @ApiProperty({ enum: ['missing', 'damaged'] })
  @IsIn(['missing', 'damaged'])
  kind!: 'missing' | 'damaged';

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : value,
  )
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @MaxLength(500)
  evidenceRef?: string;
}
