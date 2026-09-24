import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  BigBagCompositionItem,
  BigBagLocation,
  BigBagMaterialPresetId,
  BigBagMaterialSelectionKind,
  BigBagMovementResult,
  BigBagRegistrationStatus,
  BigBagStatus,
  BigBagWeightComparison,
  Role,
} from '@plenka/contracts';
import { BIG_BAG_LOCATIONS, BIG_BAG_MATERIAL_PRESETS } from '@plenka/contracts';
import { BigBagLabelPrintResponseDto } from './bigbag-print.dto';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

type BigBagMovementMetadata = BigBagMovementResult['movement'];

export class CreateBigBagDto {
  @ApiPropertyOptional({
    enum: BIG_BAG_MATERIAL_PRESETS.map((preset) => preset.id),
    description: 'Один из шести производственных видов сырья для ручной регистрации Big-Bag.',
  })
  @IsOptional()
  @IsString()
  @IsIn(BIG_BAG_MATERIAL_PRESETS.map((preset) => preset.id))
  materialPreset?: BigBagMaterialPresetId;

  @ApiPropertyOptional({
    description:
      'Legacy physical-stock identity. New clients use baseRawMaterialDefinitionId or recipeDefinitionVersionId.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  materialId?: string;

  @ApiPropertyOptional({
    description:
      'One active admin-managed raw-material type from the shared commercial/warehouse catalog.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  baseRawMaterialDefinitionId?: string;

  @ApiPropertyOptional({
    description: 'Current immutable recipe version from the shared recipe catalog.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  recipeDefinitionVersionId?: string;

  @ApiProperty({ description: 'Начальный фактический вес Big-Bag, кг.' })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @IsPositive()
  weightKg!: number;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Цена одного килограмма в копейках; итог рассчитывает сервер.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceKopecksPerKg?: number;

  @ApiPropertyOptional({ description: 'Код мешка; по умолчанию BB-<материал>-NN' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  code?: string;

  @ApiPropertyOptional({ description: 'Честный код партии сырья, если он известен.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  batchCode?: string;

  @ApiPropertyOptional({
    description: 'Подтверждённый складом поставщик этой партии; неизвестное значение не выводится.',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  supplierName?: string;
}

export class MoveBigBagDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({
    pattern: '^bbt_[0-9a-f]{64}$',
    description: 'Opaque QR value scanned from the physical Big-Bag label.',
  })
  @IsString()
  @Matches(/^bbt_[0-9a-f]{64}$/u)
  qrCode!: string;

  @ApiProperty({ enum: BIG_BAG_LOCATIONS })
  @IsIn(BIG_BAG_LOCATIONS)
  destination!: BigBagLocation;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Manual warehouse control weight; required on return from production.',
  })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 3 })
  @Min(0)
  warehouseWeightKg?: number;
}

export class BigBagCompositionItemResponseDto implements BigBagCompositionItem {
  @ApiProperty({ nullable: true, type: String })
  rawMaterialDefinitionId!: string | null;

  @ApiProperty()
  materialId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ minimum: 1, maximum: 10_000 })
  shareBasisPoints!: number;

  @ApiProperty({ minimum: 0 })
  initialKg!: number;
}

export class BigBagResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  material!: string;

  @ApiProperty({ nullable: true, type: String })
  materialId!: string | null;

  @ApiProperty({ enum: ['legacy', 'material', 'recipe', 'preset'] })
  materialSelectionKind!: BigBagMaterialSelectionKind;

  @ApiProperty({ nullable: true, enum: BIG_BAG_MATERIAL_PRESETS.map((preset) => preset.id) })
  materialPreset!: BigBagMaterialPresetId | null;

  @ApiProperty({ nullable: true, type: String })
  baseRawMaterialDefinitionId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  recipeDefinitionVersionId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  recipeName!: string | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 1 })
  recipeVersionNumber!: number | null;

  @ApiProperty({ nullable: true, type: String })
  supplierName!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  receivedAt!: string | null;

  @ApiProperty({ type: BigBagCompositionItemResponseDto, isArray: true })
  composition!: BigBagCompositionItem[];

  @ApiProperty({ enum: ['available', 'in_use', 'consumed'] })
  status!: BigBagStatus;

  @ApiProperty({ enum: ['pending_scan', 'registered'] })
  registrationStatus!: BigBagRegistrationStatus;

  @ApiProperty({ enum: BIG_BAG_LOCATIONS })
  location!: BigBagLocation;

  @ApiProperty({ minimum: 0 })
  locationRevision!: number;

  @ApiProperty({ nullable: true, type: Number })
  initialKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  currentKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  lastMeasuredKg!: number | null;

  @ApiProperty({ nullable: true, type: String })
  lastActorRole!: Role | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastMeasuredAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  machineId!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  lastWarehouseMeasuredKg!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastWarehouseMeasuredAt!: string | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  priceKopecksPerKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  totalKopecks!: number | null;

  @ApiProperty({ nullable: true, type: String })
  priceSource!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  priceEffectiveAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  createdByRole!: Role | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ nullable: true, type: BigBagLabelPrintResponseDto })
  latestLabelPrint!: BigBagLabelPrintResponseDto | null;
}

export class BigBagWeightComparisonResponseDto implements BigBagWeightComparison {
  @ApiProperty()
  operatorReportedKg!: number;

  @ApiProperty()
  warehouseMeasuredKg!: number;

  @ApiProperty()
  differenceKg!: number;

  @ApiProperty({ nullable: true, type: Number })
  differencePercent!: number | null;
}

export class BigBagMovementMetadataResponseDto implements BigBagMovementMetadata {
  @ApiProperty({ enum: ['registration', 'to_production', 'to_warehouse'] })
  kind!: BigBagMovementResult['movement']['kind'];

  @ApiProperty({ nullable: true, enum: BIG_BAG_LOCATIONS })
  fromLocation!: BigBagLocation | null;

  @ApiProperty({ enum: BIG_BAG_LOCATIONS })
  toLocation!: BigBagLocation;

  @ApiProperty({ minimum: 1 })
  locationRevision!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class BigBagMovementResponseDto implements BigBagMovementResult {
  @ApiProperty({ type: BigBagResponseDto })
  bag!: BigBagResponseDto;

  @ApiProperty({ type: BigBagMovementMetadataResponseDto })
  movement!: BigBagMovementMetadataResponseDto;

  @ApiProperty({ nullable: true, type: BigBagWeightComparisonResponseDto })
  weightComparison!: BigBagWeightComparisonResponseDto | null;
}
