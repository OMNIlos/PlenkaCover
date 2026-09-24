import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { ROLES, type Role } from '@plenka/contracts';
import { Trim } from './trimmed-string';

export class CreateAdminUserDto {
  @ApiProperty({ example: 'operator.2' })
  @IsString()
  login!: string;

  @ApiProperty({ example: 'Оператор 2', minLength: 1, maxLength: 120 })
  @Trim()
  @IsString()
  @Length(1, 120)
  displayName!: string;

  @ApiProperty({ enum: ROLES })
  @IsIn([...ROLES])
  role!: Role;
}

export class UpdateAdminUserDto {
  @ApiPropertyOptional({ example: 'operator.2' })
  @IsOptional()
  @IsString()
  login?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  displayName?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class AdminReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}
