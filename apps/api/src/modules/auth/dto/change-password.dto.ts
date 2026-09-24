import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ required: false, description: 'Required for a regular full session.' })
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @ApiProperty({ minLength: 4, maxLength: 128 })
  @IsString()
  @Length(4, 128)
  newPassword!: string;
}
