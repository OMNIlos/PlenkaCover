import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RejectCoverDto {
  @ApiProperty({ description: 'Why the proposal is rejected (audited)' })
  @IsString()
  reason!: string;

  @ApiProperty({ required: false, description: 'If set, request a recheck instead of hard reject' })
  @IsOptional()
  @IsString()
  recheck?: string;
}
