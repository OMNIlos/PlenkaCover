import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SearchCounterpartiesQueryDto {
  @ApiPropertyOptional({ description: 'Display/legal name or normalized INN', maxLength: 200 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: 'Opaque (displayName,id) cursor', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class CounterpartyResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ nullable: true, type: String })
  legalName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  inn!: string | null;

  @ApiProperty()
  billingSource!: string;

  @ApiProperty()
  syncStatus!: string;
}

export class SearchCounterpartiesPageResponseDto {
  @ApiProperty({ type: [CounterpartyResponseDto] })
  items!: CounterpartyResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
