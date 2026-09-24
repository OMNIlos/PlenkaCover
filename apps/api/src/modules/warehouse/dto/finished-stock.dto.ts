import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const FINISHED_STOCK_AVAILABILITY = ['all', 'available', 'reserved', 'in_transit'] as const;
export type FinishedStockAvailability = (typeof FINISHED_STOCK_AVAILABILITY)[number];
export const FINISHED_STOCK_BUCKETS = ['available', 'processed'] as const;
export type FinishedStockBucket = (typeof FINISHED_STOCK_BUCKETS)[number];

export class FinishedStockQueryDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    enum: FINISHED_STOCK_BUCKETS,
    default: 'available',
    description: 'Lifecycle bucket. Defaults to available.',
  })
  @IsOptional()
  @IsIn(FINISHED_STOCK_BUCKETS)
  bucket?: FinishedStockBucket;

  @ApiPropertyOptional({
    enum: FINISHED_STOCK_AVAILABILITY,
    deprecated: true,
    description:
      'Deprecated cached-client input. It is accepted but does not select mixed lifecycle results.',
  })
  @IsOptional()
  @IsIn(FINISHED_STOCK_AVAILABILITY)
  availability?: FinishedStockAvailability;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  batch?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 3650 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  minAgeDays?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 3650 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  maxAgeDays?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@Exclude()
export class FinishedStockItemResponseDto {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty()
  rollCode!: string;

  @Expose()
  @ApiProperty()
  batchCode!: string;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  weightKg!: number | null;

  @Expose()
  @ApiProperty()
  recipe!: string;

  @Expose()
  @ApiProperty()
  specification!: string;

  @Expose()
  @ApiProperty()
  ageDays!: number;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  processedAt!: string | null;
}

export class FinishedStockSummaryResponseDto {
  @ApiProperty()
  totalCount!: number;

  @ApiProperty()
  totalWeightKg!: number;

  @ApiProperty()
  pageCount!: number;

  @ApiProperty()
  pageWeightKg!: number;
}

export class FinishedStockPageResponseDto {
  @ApiProperty({ type: [FinishedStockItemResponseDto] })
  items!: FinishedStockItemResponseDto[];

  @ApiProperty({ type: FinishedStockSummaryResponseDto })
  summary!: FinishedStockSummaryResponseDto;

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
