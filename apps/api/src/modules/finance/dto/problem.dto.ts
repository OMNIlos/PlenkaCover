import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class FinanceProblemDto {
  @ApiProperty({ description: 'What is wrong (audited)' })
  @IsString()
  reason!: string;

  @ApiProperty({ required: false, enum: ['sync', 'overdue', 'other'] })
  @IsOptional()
  @IsIn(['sync', 'overdue', 'other'])
  kind?: 'sync' | 'overdue' | 'other';

  @ApiProperty({ required: false, description: 'Evidence forwarded to director queue' })
  @IsOptional()
  @IsString()
  evidence?: string;
}
