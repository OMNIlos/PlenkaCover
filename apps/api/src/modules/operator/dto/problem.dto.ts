import { ApiProperty } from '@nestjs/swagger';
import {
  MACHINE_BREAKDOWN_TYPES,
  OPERATOR_REPORTABLE_PROBLEM_TYPES,
  PRODUCTION_PROBLEM_STATUSES,
  PRODUCTION_PROBLEM_TYPES,
  type MachineBreakdownRequest,
  type OperatorReportableProblemType,
  type ProductionProblemStatus,
  type ProductionProblemType,
  type Role,
} from '@plenka/contracts';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class OperatorProblemDto {
  @ApiProperty({ format: 'uuid', description: 'Stable UUID-v4 for this report intent' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ required: false, enum: OPERATOR_REPORTABLE_PROBLEM_TYPES, default: 'general' })
  @IsOptional()
  @IsIn(OPERATOR_REPORTABLE_PROBLEM_TYPES)
  type?: OperatorReportableProblemType;

  @ApiProperty({ required: true, description: 'Affected roll code' })
  @IsString()
  @Matches(/\S/)
  rollId!: string;

  @ApiProperty({ description: 'What blocks the operator' })
  @IsString()
  @Matches(/\S/)
  reason!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  recovery?: string;
}

export class MachineBreakdownDto implements MachineBreakdownRequest {
  @ApiProperty({ enum: MACHINE_BREAKDOWN_TYPES, description: 'Тип поломки станка' })
  @IsIn(MACHINE_BREAKDOWN_TYPES)
  type!: MachineBreakdownRequest['type'];

  @ApiProperty({
    required: false,
    maxLength: 500,
    description: 'Необязательные детали поломки',
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(500)
  details?: string;
}

export class OperatorProblemResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: PRODUCTION_PROBLEM_TYPES })
  type!: ProductionProblemType;

  @ApiProperty({ enum: PRODUCTION_PROBLEM_STATUSES })
  status!: ProductionProblemStatus;

  @ApiProperty()
  orderId!: string;

  @ApiProperty({ nullable: true, type: String })
  positionId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  rollId!: string | null;

  @ApiProperty()
  actorRole!: Role;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ nullable: true, type: String })
  recovery!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
