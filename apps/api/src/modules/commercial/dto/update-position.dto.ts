import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { COMMERCIAL_PLANNED_WEIGHT_ERROR, RecipeParamDto } from './create-order.dto';
import { VersionedCommandDto } from './versioned-command.dto';

export class UpdatePositionDto extends VersionedCommandDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  rollCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  filmType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  actualThickness?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountingThickness?: string;

  @ApiProperty({ required: false, minimum: 0.001, maximum: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100_000)
  widthMm?: number;

  @ApiProperty({ required: false, minimum: 0.001, maximum: 10000000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(10_000_000)
  plannedLengthM?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  rawMaterialId?: string;

  @ApiProperty({ required: false, nullable: true, type: String })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  baseRawMaterialDefinitionId?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  recipeDefinitionVersionId?: string | null;

  @ApiProperty({ required: false, type: [RecipeParamDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RecipeParamDto)
  recipeParameters?: RecipeParamDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  spoolType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  birka?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  manualBirka?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @ApiProperty({ required: false, minimum: 0.001, maximum: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 },
    { message: COMMERCIAL_PLANNED_WEIGHT_ERROR },
  )
  @Min(0.001, { message: COMMERCIAL_PLANNED_WEIGHT_ERROR })
  @Max(100_000, { message: COMMERCIAL_PLANNED_WEIGHT_ERROR })
  plannedWeightKg?: number;
}
