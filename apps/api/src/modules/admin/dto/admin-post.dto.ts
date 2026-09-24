import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { POST_STATUSES, type PostStatus } from '@plenka/contracts';
import { Trim } from './trimmed-string';

export class CreateAdminPostDto {
  @ApiProperty({ example: 'POST-6' })
  @Trim()
  @IsString()
  @Length(2, 80)
  code!: string;

  @ApiProperty({ example: 'Пнд новая' })
  @Trim()
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ enum: POST_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn([...POST_STATUSES])
  status?: PostStatus;
}

export class UpdateAdminPostDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ enum: POST_STATUSES })
  @IsOptional()
  @IsIn([...POST_STATUSES])
  status?: PostStatus;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}
