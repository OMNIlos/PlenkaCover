import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import type { Role } from '@plenka/contracts';

export const DIRECTOR_PENALTY_TARGET_ROLES = ['operator', 'production_lead'] as const satisfies
  readonly Role[];

export class CreatePenaltyDto {
  @ApiProperty({ enum: DIRECTOR_PENALTY_TARGET_ROLES })
  @IsIn([...DIRECTOR_PENALTY_TARGET_ROLES])
  targetRole!: Role;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ description: 'Why the penalty is issued (audited)' })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiProperty({ description: 'Active operator or production lead user id' })
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @ApiProperty({
    required: false,
    description: 'Object that triggered the penalty (roll/order id)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sourceObjectId?: string;
}
