import { ApiProperty } from '@nestjs/swagger';
import {
  WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES,
  WAREHOUSE_INVENTORY_NEXT_ROUTES,
  WAREHOUSE_INVENTORY_ORIGINS,
  WAREHOUSE_INVENTORY_PHYSICAL_STATUSES,
  WAREHOUSE_INVENTORY_PROVENANCE_KINDS,
  type WarehouseInventoryProvenance,
  type WarehouseInventoryRollDetail,
  type WarehouseInventoryRollItem,
  type WarehouseInventoryRollPage,
  type WarehouseInventorySpecificationDetails,
} from '@plenka/contracts';
import { Exclude, Expose, Type } from 'class-transformer';

@Exclude()
export class WarehouseInventoryRollItemResponseDto implements WarehouseInventoryRollItem {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty()
  rollCode!: string;

  @Expose()
  @ApiProperty({ enum: WAREHOUSE_INVENTORY_ORIGINS })
  origin!: WarehouseInventoryRollItem['origin'];

  @Expose()
  @ApiProperty({ enum: WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES })
  lifecycleStatus!: WarehouseInventoryRollItem['lifecycleStatus'];

  @Expose()
  @ApiProperty()
  lifecycleStatusLabel!: WarehouseInventoryRollItem['lifecycleStatusLabel'];

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  orderNumber!: string | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  positionId!: string | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  positionSequence!: number | null;

  @Expose()
  @ApiProperty({ enum: WAREHOUSE_INVENTORY_PHYSICAL_STATUSES })
  warehouseStatus!: WarehouseInventoryRollItem['warehouseStatus'];

  @Expose()
  @ApiProperty()
  warehouseStatusLabel!: WarehouseInventoryRollItem['warehouseStatusLabel'];

  @Expose()
  @ApiProperty({ enum: WAREHOUSE_INVENTORY_NEXT_ROUTES })
  nextRoute!: WarehouseInventoryRollItem['nextRoute'];

  @Expose()
  @ApiProperty()
  nextRouteLabel!: WarehouseInventoryRollItem['nextRouteLabel'];

  @Expose()
  @ApiProperty()
  counterpartyName!: string;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  weightKg!: number | null;

  @Expose()
  @ApiProperty()
  specification!: string;

  @Expose()
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  receivedAt!: string | null;

  @Expose()
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processedAt!: string | null;
}

@Exclude()
export class WarehouseInventorySpecificationDetailsResponseDto implements WarehouseInventorySpecificationDetails {
  @Expose()
  @ApiProperty({ type: String, nullable: true })
  filmType!: string | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  actualThicknessMicron!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  accountingThicknessMicron!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  widthMm!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  plannedLengthM!: number | null;

  @Expose()
  @ApiProperty({ type: Number, nullable: true })
  netKg!: number | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  spoolType!: string | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  birka!: string | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  recipeName!: string | null;

  @Expose()
  @ApiProperty({ type: String, isArray: true })
  ingredients!: string[];
}

@Exclude()
export class WarehouseInventoryProvenanceResponseDto implements WarehouseInventoryProvenance {
  @Expose()
  @ApiProperty({ enum: WAREHOUSE_INVENTORY_PROVENANCE_KINDS })
  kind!: WarehouseInventoryProvenance['kind'];

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  orderNumber!: string | null;

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;
}

@Exclude()
export class WarehouseInventoryRollDetailResponseDto
  extends WarehouseInventoryRollItemResponseDto
  implements WarehouseInventoryRollDetail
{
  @Expose()
  @Type(() => WarehouseInventorySpecificationDetailsResponseDto)
  @ApiProperty({ type: WarehouseInventorySpecificationDetailsResponseDto })
  specificationDetails!: WarehouseInventorySpecificationDetails;

  @Expose()
  @Type(() => WarehouseInventoryProvenanceResponseDto)
  @ApiProperty({ type: WarehouseInventoryProvenanceResponseDto })
  provenance!: WarehouseInventoryProvenance;
}

@Exclude()
export class WarehouseInventoryRollPageResponseDto implements WarehouseInventoryRollPage {
  @Expose()
  @Type(() => WarehouseInventoryRollItemResponseDto)
  @ApiProperty({ type: WarehouseInventoryRollItemResponseDto, isArray: true })
  items!: WarehouseInventoryRollItem[];

  @Expose()
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
