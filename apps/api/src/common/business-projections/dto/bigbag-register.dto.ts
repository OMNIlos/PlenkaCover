import type {
  BigBagRegisterLocation,
  BigBagRegisterPage,
  BigBagRegisterRow,
} from '@plenka/contracts';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BigBagRegisterQueryDto {
  @ApiPropertyOptional({
    description: 'Код, сырьё, партия, статус, местоположение или оператор.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ enum: ['all', 'current'] })
  @IsOptional()
  @IsIn(['all', 'current'])
  view?: 'all' | 'current';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 25;
}

export class BigBagRegisterLocationResponseDto implements BigBagRegisterLocation {
  @ApiProperty({ enum: ['warehouse', 'production', 'post', 'consumed', 'unknown'] })
  kind!: BigBagRegisterLocation['kind'];

  @ApiProperty({ nullable: true, type: String })
  postCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  postName!: string | null;
}

export class BigBagRegisterRowResponseDto implements BigBagRegisterRow {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  material!: string;

  @ApiProperty({ nullable: true, type: String })
  batch!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ enum: ['available', 'in_use', 'consumed'] })
  status!: BigBagRegisterRow['status'];

  @ApiProperty({ type: BigBagRegisterLocationResponseDto })
  location!: BigBagRegisterLocation;

  @ApiProperty({ nullable: true, type: String, description: 'Current operator display name.' })
  operatorName!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  currentWeightKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, description: 'Current Big-Bag value in kopecks.' })
  totalKopecks!: number | null;
}

export class BigBagRegisterPageResponseDto implements BigBagRegisterPage {
  @ApiProperty({ type: BigBagRegisterRowResponseDto, isArray: true })
  items!: BigBagRegisterRow[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}
