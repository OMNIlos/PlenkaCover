import type {
  WarehouseBusinessPage,
  WarehouseBusinessRow,
  WarehouseBusinessTemplate,
} from '@plenka/contracts';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WarehouseBusinessQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;
}

export class WarehouseBusinessTemplateResponseDto implements WarehouseBusinessTemplate {
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' })
  fingerprint!: string;

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
  birka!: string;

  @ApiProperty()
  spoolType!: string;

  @ApiProperty()
  plannedWeightKg!: number;

  @ApiProperty({ nullable: true, type: String })
  recipeVersion!: string | null;
}

export class WarehouseBusinessRowResponseDto implements WarehouseBusinessRow {
  @ApiProperty({ enum: ['client_order', 'reserve'] })
  kind!: WarehouseBusinessRow['kind'];

  @ApiProperty()
  id!: string;

  @ApiProperty({ type: WarehouseBusinessTemplateResponseDto, isArray: true })
  templates!: WarehouseBusinessTemplate[];

  @ApiProperty({ enum: ['awaiting_shipment', 'reserve', 'processing'] })
  status!: WarehouseBusinessRow['status'];

  @ApiProperty({ nullable: true, type: String })
  orderNumber!: string | null;

  @ApiProperty({ nullable: true, type: String })
  counterpartyName!: string | null;
}

export class WarehouseBusinessPageResponseDto implements WarehouseBusinessPage {
  @ApiProperty({ type: WarehouseBusinessRowResponseDto, isArray: true })
  items!: WarehouseBusinessRow[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}
