import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { RequestType } from '@plenka/contracts';
import { IdempotentCommandDto } from './versioned-command.dto';

export const COMMERCIAL_PLANNED_WEIGHT_ERROR =
  'Введите вес от 0,001 до 100 000 кг, не более трёх знаков после запятой.';

export class RecipeParamDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  value!: string;
}

@ValidatorConstraint({ name: 'exactlyOneMaterialSelection', async: false })
class ExactlyOneMaterialSelectionConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const position = args.object as CreatePositionDto;
    return (
      Number(typeof position.baseRawMaterialDefinitionId === 'string') +
        Number(typeof position.recipeDefinitionVersionId === 'string') ===
      1
    );
  }

  defaultMessage() {
    return 'position must provide exactly one material selector';
  }
}

export class CreatePositionDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(10_000)
  @Validate(ExactlyOneMaterialSelectionConstraint)
  rollCount!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  filmType!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  actualThickness!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  accountingThickness!: string;

  @ApiProperty({ minimum: 0.001, maximum: 100000 })
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100_000)
  widthMm?: number;

  @ApiProperty({ minimum: 0.001, maximum: 10000000 })
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(10_000_000)
  plannedLengthM?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  baseRawMaterialDefinitionId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  recipeDefinitionVersionId?: string;

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

  @ApiProperty({ type: [RecipeParamDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RecipeParamDto)
  recipeParameters?: RecipeParamDto[];
}

export class CreateOrderDto extends IdempotentCommandDto {
  @ApiProperty({ required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({
    required: false,
    maxLength: 2000,
    description: 'Свободный комментарий для бухгалтерии; не является суммой счета.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  commercialFinanceNote?: string;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @ApiProperty({ required: false, enum: ['draft', 'submit'] })
  @IsOptional()
  @IsIn(['draft', 'submit'])
  mode?: 'draft' | 'submit';

  @ApiProperty({
    required: false,
    description: 'Human order number. Server generates a unique one when omitted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  orderNumber?: string;

  @ApiProperty({
    required: false,
    description: 'Required for client_order and omitted for stock_reserve.',
  })
  @ValidateIf(
    (order: CreateOrderDto) =>
      order.requestType !== 'stock_reserve' ||
      (order.counterpartyId !== undefined && order.counterpartyId !== null),
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  counterpartyId?: string;

  @ApiProperty({ required: false, description: 'Counterparty template selected in intake wizard.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  templateId?: string;

  @ApiProperty({ required: false, description: 'Immutable selected template revision.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  templateVersionId?: string;

  @ApiProperty({
    required: false,
    description: 'Save the submitted client-order positions as a counterparty template.',
  })
  @IsOptional()
  @IsBoolean()
  saveAsTemplate?: boolean;

  @ApiProperty({
    required: false,
    description: 'Company-owned stock production template selected for stock_reserve.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  stockProductionTemplateId?: string;

  @ApiProperty({
    required: false,
    description: 'Immutable selected stock production template revision.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  stockProductionTemplateVersionId?: string;

  @ApiProperty({ enum: ['client_order', 'stock_reserve'] })
  @IsIn(['client_order', 'stock_reserve'])
  requestType!: RequestType;

  @ApiProperty({
    type: [CreatePositionDto],
    required: false,
    description:
      'Current editable values. Required unless templateId is provided; overrides the template snapshot when present.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreatePositionDto)
  positions?: CreatePositionDto[];

  @ApiProperty({ required: false, description: 'production_lead creating on behalf of commercial' })
  @IsOptional()
  @IsBoolean()
  onBehalfOfCommercial?: boolean;
}
