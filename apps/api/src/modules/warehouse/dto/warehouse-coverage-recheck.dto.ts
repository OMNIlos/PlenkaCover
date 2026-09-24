import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  Max,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';
import type { DecimalKgString, UuidString } from '@plenka/contracts';

export class WarehouseCoverageFactCorrectionIngredientDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  rawMaterialDefinitionId!: string;

  @ApiProperty({ minimum: 1, maximum: 10_000 })
  @IsInt()
  @Min(1)
  shareBasisPoints!: number;
}

export class WarehouseCoverageFactCorrectionSpec {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  filmType!: string;

  @ApiProperty({ example: '80 мкм' })
  @IsString()
  @Length(1, 50)
  actualThickness!: string;

  @ApiProperty({ example: '80 мкм' })
  @IsString()
  @Length(1, 50)
  accountingThickness!: string;

  @ApiProperty({ minimum: 0.001, maximum: 100_000, example: 1700 })
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100_000)
  widthMm!: number;

  @ApiProperty({ minimum: 0.001, maximum: 10_000_000, example: 275 })
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(10_000_000)
  plannedLengthM!: number;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  birka!: string;

  @ApiProperty({ example: '76 мм' })
  @IsString()
  @Length(1, 100)
  spoolType!: string;

  @ApiProperty({ example: '275.000' })
  @IsString()
  @Length(1, 50)
  actualWeightKg!: DecimalKgString;

  @ApiProperty({ example: '275.000' })
  @IsString()
  @Length(1, 50)
  plannedWeightKg!: DecimalKgString;

  @ApiProperty({ nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Length(1, 200)
  recipeId!: string | null;

  @ApiProperty({ nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Length(1, 200)
  recipeVersion!: string | null;

  @ApiProperty({ nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Length(1, 200)
  recipeDefinitionId!: string | null;

  @ApiProperty({ nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Length(1, 200)
  recipeDefinitionVersionId!: string | null;

  @ApiProperty({ nullable: true, minimum: 1 })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  recipeVersionNumber!: number | null;

  @ApiProperty({ type: [WarehouseCoverageFactCorrectionIngredientDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WarehouseCoverageFactCorrectionIngredientDto)
  ingredients!: WarehouseCoverageFactCorrectionIngredientDto[];
}

@ValidatorConstraint({ name: 'warehouseCoverageCorrectionPatch', async: false })
class WarehouseCoverageCorrectionPatchConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const correction = args.object as WarehouseCoverageFactCorrectionDto;
    return correction.ownerCounterpartyId !== undefined || correction.spec !== undefined;
  }

  defaultMessage(): string {
    return 'ownerCounterpartyId or spec correction is required';
  }
}

export class WarehouseCoverageFactCorrectionDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  @Validate(WarehouseCoverageCorrectionPatchConstraint)
  membershipId!: string;

  @ApiProperty({ nullable: true, minimum: 1 })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  expectedFactVersion!: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  ownerCounterpartyId?: string;

  @ApiPropertyOptional({ type: WarehouseCoverageFactCorrectionSpec })
  @IsOptional()
  @ValidateNested()
  @Type(() => WarehouseCoverageFactCorrectionSpec)
  spec?: WarehouseCoverageFactCorrectionSpec;
}

export class ResolveWarehouseCoverageRecheckDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4')
  clientRequestId!: UuidString;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedCaseVersion!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedGeneration!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedStateVersion!: number;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : value,
  )
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiProperty({ type: [WarehouseCoverageFactCorrectionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WarehouseCoverageFactCorrectionDto)
  corrections!: WarehouseCoverageFactCorrectionDto[];
}
