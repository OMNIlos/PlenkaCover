import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  PRODUCTION_PROBLEM_STATUSES,
  PRODUCTION_PROBLEM_TYPES,
  type ProductionProblemStatus,
  type ProductionProblemType,
} from '@plenka/contracts';
import { IsIn, IsOptional } from 'class-validator';

export function isProductionProblemStatus(value: unknown): value is ProductionProblemStatus {
  return (
    typeof value === 'string' && (PRODUCTION_PROBLEM_STATUSES as readonly string[]).includes(value)
  );
}

export function isProductionProblemType(value: unknown): value is ProductionProblemType {
  return (
    typeof value === 'string' && (PRODUCTION_PROBLEM_TYPES as readonly string[]).includes(value)
  );
}

export class ProductionProblemQueryDto {
  @ApiPropertyOptional({ enum: PRODUCTION_PROBLEM_STATUSES })
  @IsOptional()
  @IsIn([...PRODUCTION_PROBLEM_STATUSES])
  status?: ProductionProblemStatus;

  @ApiPropertyOptional({ enum: PRODUCTION_PROBLEM_TYPES })
  @IsOptional()
  @IsIn([...PRODUCTION_PROBLEM_TYPES])
  type?: ProductionProblemType;
}
