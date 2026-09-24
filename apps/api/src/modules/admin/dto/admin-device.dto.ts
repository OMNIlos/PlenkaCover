import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Trim } from './trimmed-string';

const DEVICE_KINDS = ['scale', 'scanner', 'printer'] as const;

export class CreateAdminDeviceDto {
  @ApiProperty({ example: 'SCALE-6' })
  @Trim()
  @IsString()
  @Length(2, 80)
  code!: string;

  @ApiProperty({ example: 'Весы станка 6' })
  @Trim()
  @IsString()
  @Length(1, 120)
  label!: string;

  @ApiProperty({ enum: DEVICE_KINDS })
  @IsIn([...DEVICE_KINDS])
  kind!: (typeof DEVICE_KINDS)[number];

  @ApiPropertyOptional({ example: 'usb-rs232' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 80)
  connectionKind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  postId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  isEnabled?: boolean;
}

export class UpdateAdminDeviceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 80)
  connectionKind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class BindAdminDeviceDto {
  @ApiProperty()
  @IsString()
  postId!: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}
