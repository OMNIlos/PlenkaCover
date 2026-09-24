import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const DIRECTOR_DECISION_SCOPES = ['finance', 'production', 'warehouse'] as const;
export const DIRECTOR_DECISION_STATUSES = ['pending', 'approved', 'returned'] as const;

export class DirectorDecisionQueryDto {
  @ApiPropertyOptional({ enum: DIRECTOR_DECISION_SCOPES })
  @IsOptional()
  @IsIn(DIRECTOR_DECISION_SCOPES)
  scope?: (typeof DIRECTOR_DECISION_SCOPES)[number];

  @ApiPropertyOptional({ enum: DIRECTOR_DECISION_STATUSES })
  @IsOptional()
  @IsIn(DIRECTOR_DECISION_STATUSES)
  status?: (typeof DIRECTOR_DECISION_STATUSES)[number];
}
