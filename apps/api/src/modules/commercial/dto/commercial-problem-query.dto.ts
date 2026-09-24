import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  COMMERCIAL_PROBLEM_FILTERS,
  type CommercialProblemFilter,
} from '@plenka/contracts';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CommercialProblemQueryDto {
  @ApiPropertyOptional({ enum: COMMERCIAL_PROBLEM_FILTERS, default: 'open' })
  @IsOptional()
  @IsIn([...COMMERCIAL_PROBLEM_FILTERS])
  filter: CommercialProblemFilter = 'open';

  @ApiPropertyOptional({ description: 'Opaque problem cursor' })
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
