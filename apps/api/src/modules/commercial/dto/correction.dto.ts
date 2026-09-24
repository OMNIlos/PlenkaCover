import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { COMMERCIAL_CURRENT_ROLL_RESOLUTIONS } from '@plenka/contracts';
import { RecipeParamDto } from './create-order.dto';

export class CreateCorrectionDto {
  @ApiProperty()
  @IsString()
  positionId!: string;

  @ApiProperty({ required: false, description: 'Apply the correction from this roll onward' })
  @IsOptional()
  @IsString()
  fromRollId?: string;

  @ApiProperty({ description: 'Why the recipe is corrected (audited)' })
  @IsString()
  reason!: string;

  @ApiProperty({ type: [RecipeParamDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeParamDto)
  newParameters!: RecipeParamDto[];
}

export class ProblemCorrectionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  positionId!: string;

  @ApiProperty({ description: 'First roll code that receives the new immutable recipe version' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  fromRollId!: string;

  @ApiProperty({ example: 'v3' })
  @IsString()
  @Matches(/^v[1-9]\d*$/)
  expectedRecipeVersion!: string;

  @ApiProperty({ enum: COMMERCIAL_CURRENT_ROLL_RESOLUTIONS })
  @IsIn(COMMERCIAL_CURRENT_ROLL_RESOLUTIONS)
  currentRollResolution!: (typeof COMMERCIAL_CURRENT_ROLL_RESOLUTIONS)[number];

  @ApiProperty({ type: [RecipeParamDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RecipeParamDto)
  newParameters!: RecipeParamDto[];

  @ApiProperty({ description: 'Audited business reason' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}

export class ProblemCorrectionResponseDto {
  @ApiProperty()
  caseId!: string;

  @ApiProperty()
  problemId!: string;

  @ApiProperty({ enum: ['resolved'] })
  status!: 'resolved';

  @ApiProperty()
  oldRecipeVersionId!: string;

  @ApiProperty()
  newRecipeVersionId!: string;

  @ApiProperty({ example: 'v4' })
  recipeVersion!: string;

  @ApiProperty({ type: [String] })
  affectedRollIds!: string[];
}
