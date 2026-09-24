import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;

export class ListDispatchQueryDto {
  @ApiPropertyOptional({ pattern: DATE_KEY.source, example: '2026-07-10' })
  @IsOptional()
  @Matches(DATE_KEY)
  date?: string;

  @ApiPropertyOptional({ description: 'Exact operator account id', maxLength: 128 })
  @IsOptional()
  @IsString()
  @Matches(/\S/u)
  @MaxLength(128)
  operatorId?: string;

  @ApiPropertyOptional({ enum: ['active', 'archive'] })
  @IsOptional()
  @IsIn(['active', 'archive'])
  scope?: 'active' | 'archive';

  @ApiPropertyOptional({ pattern: DATE_KEY.source, example: '2026-07-01' })
  @IsOptional()
  @Matches(DATE_KEY)
  dateFrom?: string;

  @ApiPropertyOptional({ pattern: DATE_KEY.source, example: '2026-07-10' })
  @IsOptional()
  @Matches(DATE_KEY)
  dateTo?: string;
}
