import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { Trim } from './trimmed-string';

export class RevokeAdminSessionsDto {
  @ApiPropertyOptional({ description: 'Omit to revoke every active session for the user.' })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}
