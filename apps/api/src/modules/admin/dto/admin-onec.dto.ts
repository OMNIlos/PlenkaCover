import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ONEC_SUBJECT_TYPES, type OneCStaleness, type OneCSubjectType } from '@plenka/contracts';

export class AdminOneCImportDto {
  @ApiProperty({ enum: ONEC_SUBJECT_TYPES })
  @IsIn([...ONEC_SUBJECT_TYPES])
  subjectType!: OneCSubjectType;

  @ApiPropertyOptional({ description: 'Required for invoice or a single counterparty import.' })
  @IsOptional()
  @IsString()
  externalId?: string;
}

export class AdminOneCSnapshotQueryDto {
  @ApiPropertyOptional({ enum: ONEC_SUBJECT_TYPES })
  @IsOptional()
  @IsIn([...ONEC_SUBJECT_TYPES])
  subjectType?: OneCSubjectType;

  @ApiPropertyOptional({ enum: ['fresh', 'stale', 'unknown'] })
  @IsOptional()
  @IsIn(['fresh', 'stale', 'unknown'])
  staleness?: OneCStaleness;

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
