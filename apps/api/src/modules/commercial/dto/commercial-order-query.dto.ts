import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  COMMERCIAL_BUCKETS,
  COMMERCIAL_QUEUE_MODES,
  type CommercialBucket,
  type CommercialQueueMode,
} from '@plenka/contracts';

export class CommercialOrderQueryDto {
  @ApiPropertyOptional({ enum: COMMERCIAL_BUCKETS, default: 'incoming' })
  @IsOptional()
  @IsIn([...COMMERCIAL_BUCKETS])
  bucket: CommercialBucket = 'incoming';

  @ApiPropertyOptional({ enum: COMMERCIAL_QUEUE_MODES, default: 'current' })
  @IsOptional()
  @IsIn([...COMMERCIAL_QUEUE_MODES])
  mode: CommercialQueueMode = 'current';

  @ApiPropertyOptional({ example: '2026-07-01', description: 'Inclusive UTC calendar date' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: '2026-07-31', description: 'Inclusive UTC calendar date' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ description: 'Opaque workspace cursor' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
