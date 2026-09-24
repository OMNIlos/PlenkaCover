import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  AdditionalProductionCostView,
  MaterialPriceReferenceView,
  RecordAdditionalProductionCostInput,
  SetMaterialPriceInput,
} from '@plenka/contracts';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const MAX_KOPECKS = 2_000_000_000;

export class SetMaterialPriceDto implements SetMaterialPriceInput {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  rawMaterialDefinitionId!: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_KOPECKS })
  @IsInt()
  @Min(1)
  @Max(MAX_KOPECKS)
  priceKopecksPerKg!: number;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  source!: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class RecordAdditionalProductionCostDto implements RecordAdditionalProductionCostInput {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiPropertyOptional({ description: 'Provide exactly one target id.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  rollDispatchItemId?: string;

  @ApiPropertyOptional({ description: 'Provide exactly one target id.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  productionOrderId?: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: MAX_KOPECKS })
  @IsInt()
  @Min(0)
  @Max(MAX_KOPECKS)
  amountKopecks!: number;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  source!: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  effectiveAt!: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class MaterialPriceReferenceResponseDto implements MaterialPriceReferenceView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rawMaterialDefinitionId!: string;

  @ApiProperty()
  materialName!: string;

  @ApiProperty({ type: 'integer', format: 'int32' })
  priceKopecksPerKg!: number;

  @ApiProperty()
  source!: string;

  @ApiProperty({ format: 'date-time' })
  effectiveFrom!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdditionalProductionCostResponseDto implements AdditionalProductionCostView {
  @ApiProperty({ enum: ['roll', 'order'] })
  targetKind!: 'roll' | 'order';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  targetId!: string;

  @ApiProperty({ enum: ['direct', 'finished_net_kg'] })
  allocationBasis!: 'direct' | 'finished_net_kg';

  @ApiProperty({ type: 'integer', format: 'int32' })
  amountKopecks!: number;

  @ApiProperty()
  source!: string;

  @ApiProperty({ format: 'date-time' })
  effectiveAt!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
