import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SAFE_INVENTORY_SOURCE_STATUSES } from '@plenka/contracts';
import type { InventoryProjectionQuery } from './inventory-projection.service';

const INVENTORY_CATEGORIES = ['primary', 'secondary', 'additive', 'custom'] as const;
const INVENTORY_AVAILABILITY_FILTERS = ['available', 'unavailable'] as const;

export class InventoryProjectionQueryDto implements InventoryProjectionQuery {
  @ApiProperty({ required: false, description: 'Material name or stable platform material id.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiProperty({ required: false, enum: INVENTORY_CATEGORIES })
  @IsOptional()
  @IsIn(INVENTORY_CATEGORIES)
  category?: string;

  @ApiProperty({ required: false, enum: SAFE_INVENTORY_SOURCE_STATUSES })
  @IsOptional()
  @IsIn(SAFE_INVENTORY_SOURCE_STATUSES)
  sourceStatus?: (typeof SAFE_INVENTORY_SOURCE_STATUSES)[number];

  @ApiProperty({ required: false, enum: INVENTORY_AVAILABILITY_FILTERS })
  @IsOptional()
  @IsIn(INVENTORY_AVAILABILITY_FILTERS)
  availability?: (typeof INVENTORY_AVAILABILITY_FILTERS)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1_024)
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 20 })
  @Transform(({ value }) => (value === undefined ? 20 : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class SafeInventorySourceResponseDto {
  @ApiProperty()
  snapshotId!: string;

  @ApiProperty()
  sourceKind!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  capturedAt!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  importedAt!: string | null;
}

export class SafeInventoryConflictResponseDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;
}

export class SafeInventoryItemResponseDto {
  @ApiProperty()
  materialId!: string;

  @ApiProperty()
  materialName!: string;

  @ApiProperty({ nullable: true, type: String })
  category!: string | null;

  @ApiProperty({ nullable: true, type: String })
  unit!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  erpActualQty!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  oneCQty!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  reservedQty!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  availableQty!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  expectedUsageQty!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  openBigBagQty!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  recycledQty!: number | null;

  @ApiProperty({ enum: SAFE_INVENTORY_SOURCE_STATUSES })
  sourceStatus!: (typeof SAFE_INVENTORY_SOURCE_STATUSES)[number];

  @ApiProperty({ nullable: true, type: SafeInventorySourceResponseDto })
  source!: SafeInventorySourceResponseDto | null;

  @ApiProperty({ type: [SafeInventoryConflictResponseDto] })
  conflicts!: SafeInventoryConflictResponseDto[];

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  updatedAt!: string | null;
}

export class SafeInventoryPageResponseDto {
  @ApiProperty({ type: [SafeInventoryItemResponseDto] })
  items!: SafeInventoryItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;

  @ApiProperty()
  sourceUnavailable!: boolean;

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}
