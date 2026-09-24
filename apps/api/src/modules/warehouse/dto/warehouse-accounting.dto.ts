import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  WAREHOUSE_ACCOUNTING_STOCK_SCOPES,
  type WarehouseAccountingStockScope,
} from '@plenka/contracts';
import type {
  WarehouseAccountingMovementQuery,
  WarehouseAccountingStockQuery,
} from '../warehouse-accounting.service';

class WarehouseAccountingPageQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;

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

export class WarehouseAccountingStockQueryDto
  extends WarehouseAccountingPageQueryDto
  implements WarehouseAccountingStockQuery
{
  @ApiProperty({ enum: WAREHOUSE_ACCOUNTING_STOCK_SCOPES, default: 'goods' })
  @Transform(({ value }) => value ?? 'goods')
  @IsIn(WAREHOUSE_ACCOUNTING_STOCK_SCOPES)
  scope: WarehouseAccountingStockScope = 'goods';
}

export class WarehouseAccountingMovementQueryDto
  extends WarehouseAccountingPageQueryDto
  implements WarehouseAccountingMovementQuery {}

export class WarehouseAccountingStockItemResponseDto {
  @ApiProperty()
  nomenclatureExternalId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  kind!: string | null;

  @ApiProperty({ nullable: true, type: String })
  unit!: string | null;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ enum: ['positive', 'zero', 'negative'] })
  balanceStatus!: string;

  @ApiProperty({ format: 'date-time' })
  capturedAt!: string;

  @ApiProperty({ format: 'date-time' })
  importedAt!: string;

  @ApiProperty()
  stale!: boolean;

  @ApiProperty({ enum: ['unavailable'] })
  physicalTraceability!: 'unavailable';
}

export class WarehouseAccountingStockPageResponseDto {
  @ApiProperty({ type: [WarehouseAccountingStockItemResponseDto] })
  items!: WarehouseAccountingStockItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;

  @ApiProperty({ enum: ['41.01'] })
  accountCode!: '41.01';

  @ApiProperty({ enum: WAREHOUSE_ACCOUNTING_STOCK_SCOPES })
  scope!: WarehouseAccountingStockScope;

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}

export class WarehouseAccountingMovementLineResponseDto {
  @ApiProperty()
  lineNumber!: number;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ nullable: true, type: String })
  unit!: string | null;
}

export class WarehouseAccountingMovementResponseDto {
  @ApiProperty()
  externalId!: string;

  @ApiProperty()
  documentNumber!: string;

  @ApiProperty({ format: 'date-time' })
  documentDate!: string;

  @ApiProperty({ enum: ['outbound'] })
  direction!: 'outbound';

  @ApiProperty({ enum: ['Отгрузка по 1С'] })
  sourceLabel!: 'Отгрузка по 1С';

  @ApiProperty({ format: 'date-time' })
  capturedAt!: string;

  @ApiProperty({ format: 'date-time' })
  importedAt!: string;

  @ApiProperty({ enum: ['unavailable'] })
  physicalTraceability!: 'unavailable';

  @ApiProperty({ type: [WarehouseAccountingMovementLineResponseDto] })
  lines!: WarehouseAccountingMovementLineResponseDto[];
}

export class WarehouseAccountingMovementPageResponseDto {
  @ApiProperty({ type: [WarehouseAccountingMovementResponseDto] })
  items!: WarehouseAccountingMovementResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}
