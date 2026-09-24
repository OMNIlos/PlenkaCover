import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES,
  WAREHOUSE_INVENTORY_SORT_DIRECTIONS,
  WAREHOUSE_INVENTORY_SORT_KEYS,
  WAREHOUSE_INVENTORY_VIEWS,
  type WarehouseInventoryLifecycleStatus,
  type WarehouseInventorySortDirection,
  type WarehouseInventorySortKey,
  type WarehouseInventoryView,
} from '@plenka/contracts';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class WarehouseInventoryQueryDto {
  @ApiPropertyOptional({ enum: WAREHOUSE_INVENTORY_VIEWS })
  @IsOptional()
  @IsIn([...WAREHOUSE_INVENTORY_VIEWS])
  view?: WarehouseInventoryView;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  batch?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 3650 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  minAgeDays?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 3650 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  maxAgeDays?: number;

  @ApiPropertyOptional({ enum: WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES })
  @IsOptional()
  @IsIn([...WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES])
  status?: WarehouseInventoryLifecycleStatus;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  counterparty?: string;

  @ApiPropertyOptional({ enum: WAREHOUSE_INVENTORY_SORT_KEYS, default: 'receivedAt' })
  @IsOptional()
  @IsIn([...WAREHOUSE_INVENTORY_SORT_KEYS])
  sort: WarehouseInventorySortKey = 'receivedAt';

  @ApiPropertyOptional({ enum: WAREHOUSE_INVENTORY_SORT_DIRECTIONS, default: 'desc' })
  @IsOptional()
  @IsIn([...WAREHOUSE_INVENTORY_SORT_DIRECTIONS])
  direction: WarehouseInventorySortDirection = 'desc';

  @ApiPropertyOptional({ description: 'Opaque inventory cursor', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  cursor?: string;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
}
