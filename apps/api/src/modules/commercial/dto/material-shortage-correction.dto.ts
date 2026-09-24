import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { RecipeParamDto } from './create-order.dto';

export class MaterialShortageCorrectionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  problemId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  fromRollId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  newRawMaterialId!: string;

  @ApiProperty({ type: [RecipeParamDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecipeParamDto)
  newParameters!: RecipeParamDto[];

  @ApiProperty({ description: 'Audited business reason for the replacement' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  reason!: string;
}

export class MaterialShortageCorrectionResponseDto {
  @ApiProperty()
  caseId!: string;

  @ApiProperty()
  problemId!: string;

  @ApiProperty({ enum: ['resolved'] })
  status!: 'resolved';

  @ApiProperty()
  recipeVersion!: string;

  @ApiProperty()
  oldRecipeVersionId!: string;

  @ApiProperty()
  newRecipeVersionId!: string;

  @ApiProperty({ type: [String] })
  affectedRollIds!: string[];
}
