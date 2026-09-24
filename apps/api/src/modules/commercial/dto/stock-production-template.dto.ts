import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreatePositionDto } from './create-order.dto';

export class StockProductionTemplatePositionDto extends CreatePositionDto {}

export class CreateStockProductionTemplateDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ type: StockProductionTemplatePositionDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StockProductionTemplatePositionDto)
  positions!: StockProductionTemplatePositionDto[];
}

export class UpdateStockProductionTemplateDto extends CreateStockProductionTemplateDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class StockProductionTemplateVersionResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  templateId!: string;

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty({ type: StockProductionTemplatePositionDto, isArray: true })
  positions!: StockProductionTemplatePositionDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class StockProductionTemplateResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ enum: ['active', 'archived'] })
  @IsIn(['active', 'archived'])
  status!: 'active' | 'archived';

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty({ type: StockProductionTemplatePositionDto, isArray: true })
  positions!: StockProductionTemplatePositionDto[];

  @ApiProperty({ type: StockProductionTemplateVersionResponseDto, isArray: true })
  versions!: StockProductionTemplateVersionResponseDto[];

  @ApiProperty({ minimum: 0 })
  usageCount!: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastUsedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
