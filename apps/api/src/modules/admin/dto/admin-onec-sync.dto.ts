import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ONEC_SYNC_MODES,
  ONEC_SYNC_STATUSES,
  type OneCSyncMode,
  type OneCSyncStatus,
} from '@plenka/contracts';

export class AdminOneCSyncRunsQueryDto {
  @ApiPropertyOptional({ enum: ONEC_SYNC_MODES })
  @IsOptional()
  @IsIn([...ONEC_SYNC_MODES])
  mode?: OneCSyncMode;

  @ApiPropertyOptional({ enum: ONEC_SYNC_STATUSES })
  @IsOptional()
  @IsIn([...ONEC_SYNC_STATUSES])
  status?: OneCSyncStatus;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
