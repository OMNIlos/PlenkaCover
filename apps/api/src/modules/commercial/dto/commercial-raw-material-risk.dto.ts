import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  BIG_BAG_LOCATIONS,
  BIG_BAG_STATUSES,
  COMMERCIAL_MATERIAL_RISK_STATES,
  type CommercialBigBagValue,
} from '@plenka/contracts';

export class CommercialRawMaterialRiskQueryDto {
  @ApiProperty({
    required: false,
    maxLength: 120,
    description: 'Case-insensitive search by normalized material name',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 20 })
  @Transform(({ value }) => (value === undefined ? 20 : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class CommercialRawMaterialAffectedOrderDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty()
  rollCount!: number;
}

export class CommercialRawMaterialRiskResponseDto {
  @ApiProperty()
  rawMaterialDefinitionId!: string;

  @ApiProperty({ nullable: true, type: String })
  materialId!: string | null;

  @ApiProperty()
  label!: string;

  @ApiProperty({ enum: ['available', 'unavailable'] })
  stockAvailability!: string;

  @ApiProperty({ nullable: true, enum: ['stock_fact_missing'], type: String })
  reason!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  actualQty!: number | null;

  @ApiProperty({ nullable: true, type: String })
  unit!: string | null;

  @ApiProperty({ nullable: true, type: String })
  package!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  oneCQty!: number | null;

  @ApiProperty({ nullable: true, type: String })
  oneCUnit!: string | null;

  @ApiProperty({ nullable: true, type: Object })
  oneCSource!: {
    capturedAt: string;
    importedAt: string;
    stale: boolean;
  } | null;

  @ApiProperty({ nullable: true, type: Number })
  reservedQty!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  plannedNeedQty!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  deficitQty!: number | null;

  @ApiProperty({ type: [CommercialRawMaterialAffectedOrderDto] })
  affectedOrders!: CommercialRawMaterialAffectedOrderDto[];

  @ApiProperty({ nullable: true, type: Number })
  rollsInMovement!: number | null;

  @ApiProperty({ enum: COMMERCIAL_MATERIAL_RISK_STATES })
  risk!: string;

  @ApiProperty({ nullable: true, type: Object })
  source!: { kind: string; capturedAt: string; stale: boolean } | null;

  @ApiProperty({ enum: ['available', 'unavailable'] })
  planningAvailability!: string;

  @ApiProperty({ nullable: true, type: String })
  planningUnavailableReason!: string | null;

  @ApiProperty({ enum: ['available', 'unavailable'] })
  reservationAvailability!: string;

  @ApiProperty({ nullable: true, type: String })
  reservationUnavailableReason!: string | null;

  @ApiProperty({ type: Object })
  monetaryMetrics!: { available: false };
}

export class CommercialRawMaterialRiskPageResponseDto {
  @ApiProperty({ type: [CommercialRawMaterialRiskResponseDto] })
  items!: CommercialRawMaterialRiskResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class CommercialBigBagValueResponseDto implements CommercialBigBagValue {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  material!: string;

  @ApiProperty({ enum: BIG_BAG_STATUSES })
  status!: CommercialBigBagValue['status'];

  @ApiProperty({ enum: BIG_BAG_LOCATIONS })
  location!: CommercialBigBagValue['location'];

  @ApiProperty({ minimum: 0 })
  currentKg!: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  currentMeasuredAt!: string | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  priceKopecksPerKg!: number | null;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  totalKopecks!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  priceEffectiveAt!: string | null;
}
