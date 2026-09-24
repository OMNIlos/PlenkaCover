import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateWarehouseReserveRollDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  rollCode!: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  batchCode!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  filmType!: string;

  @ApiProperty({ minimum: 0.001, maximum: 10_000 })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(10_000)
  actualThicknessMicron!: number;

  @ApiProperty({ minimum: 0.001, maximum: 10_000 })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(10_000)
  accountingThicknessMicron!: number;

  @ApiProperty({ minimum: 0.001, maximum: 100_000 })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100_000)
  widthMm!: number;

  @ApiProperty({ minimum: 0.001, maximum: 10_000_000 })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(10_000_000)
  plannedLengthM!: number;

  @ApiProperty({ minimum: 0.001, maximum: 100_000 })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100_000)
  grossKg!: number;

  @ApiProperty({ minimum: 0.001, maximum: 10_000 })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(10_000)
  spoolKg!: number;

  @ApiPropertyOptional({
    minimum: 0.001,
    maximum: 100_000,
    description: 'Expected net weight; defaults to the registered physical net weight.',
  })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100_000)
  plannedNetKg?: number;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  spoolType!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  birka!: string;

  @ApiPropertyOptional({ description: 'Exactly one material selector must be provided.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  baseRawMaterialDefinitionId?: string;

  @ApiPropertyOptional({ description: 'Exactly one material selector must be provided.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  recipeDefinitionVersionId?: string;
}

export class WarehouseReserveRollResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rollCode!: string;

  @ApiProperty()
  batchCode!: string;

  @ApiProperty()
  sourceOrderId!: string;

  @ApiProperty()
  sourceOrderNumber!: string;

  @ApiProperty()
  filmType!: string;

  @ApiProperty()
  actualThicknessMicron!: number;

  @ApiProperty()
  accountingThicknessMicron!: number;

  @ApiProperty()
  widthMm!: number;

  @ApiProperty()
  plannedLengthM!: number;

  @ApiProperty()
  grossKg!: number;

  @ApiProperty()
  spoolKg!: number;

  @ApiProperty()
  netKg!: number;

  @ApiProperty()
  plannedNetKg!: number;

  @ApiProperty()
  spoolType!: string;

  @ApiProperty()
  birka!: string;

  @ApiProperty()
  materialLabel!: string;

  @ApiProperty({ enum: ['platform'] })
  source!: 'platform';

  @ApiProperty({ enum: ['available'] })
  availability!: 'available';

  @ApiProperty({ format: 'date-time' })
  receivedAt!: string;

  @ApiProperty()
  qrReady!: boolean;
}
