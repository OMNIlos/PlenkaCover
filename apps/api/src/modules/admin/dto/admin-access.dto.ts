import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { CAPABILITIES, ROLES, type Capability, type Role } from '@plenka/contracts';
import { Trim } from './trimmed-string';

export class ReplaceUserAccessDto {
  @ApiProperty({ enum: ROLES })
  @IsIn([...ROLES])
  role!: Role;

  @ApiProperty({ enum: CAPABILITIES, isArray: true })
  @IsArray()
  @IsIn([...CAPABILITIES], { each: true })
  grants!: Capability[];

  @ApiProperty({ enum: CAPABILITIES, isArray: true })
  @IsArray()
  @IsIn([...CAPABILITIES], { each: true })
  denials!: Capability[];

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class CreateAccessTemplateDto extends ReplaceUserAccessDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Trim()
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ enum: ['draft', 'active'], default: 'draft' })
  @IsOptional()
  @IsIn(['draft', 'active'])
  setupStatus?: 'draft' | 'active';
}

export class UpdateAccessTemplateDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn([...ROLES])
  role?: Role;

  @ApiPropertyOptional({ enum: CAPABILITIES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn([...CAPABILITIES], { each: true })
  grants?: Capability[];

  @ApiPropertyOptional({ enum: CAPABILITIES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn([...CAPABILITIES], { each: true })
  denials?: Capability[];

  @ApiPropertyOptional({ enum: ['draft', 'active'] })
  @IsOptional()
  @IsIn(['draft', 'active'])
  setupStatus?: 'draft' | 'active';

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class ApplyAccessTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  templateId?: string;

  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn([...ROLES])
  role?: Role;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}
