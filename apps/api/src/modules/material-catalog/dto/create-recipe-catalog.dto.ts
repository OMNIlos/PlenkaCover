import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IdempotentCommandDto } from '../../commercial/dto/versioned-command.dto';

export class CreateRecipeIngredientDto {
  @ApiProperty({
    description: 'Existing product from the admin-managed raw-material catalog.',
  })
  @IsString()
  @Length(1, 128)
  rawMaterialDefinitionId!: string;

  @ApiProperty({ minimum: 1, maximum: 10_000 })
  @IsInt()
  @Min(1)
  @Max(10_000)
  shareBasisPoints!: number;
}

export class CreateRecipeCatalogDto extends IdempotentCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({ type: [CreateRecipeIngredientDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => CreateRecipeIngredientDto)
  ingredients!: CreateRecipeIngredientDto[];
}
