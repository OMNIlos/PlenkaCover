import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { WAREHOUSE_COVER_STATUSES } from '@plenka/contracts';

export class CoverCheckQueryDto {
  @ApiPropertyOptional({ description: 'Opaque (updatedAt,id) cursor' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ enum: ['open'], default: 'open' })
  @IsOptional()
  @IsIn(['open'])
  state = 'open' as const;
}

export class WarehouseCoverCheckPositionResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rollCount!: number;

  @ApiProperty()
  filmType!: string;

  @ApiProperty()
  actualThickness!: string;

  @ApiProperty()
  accountingThickness!: string;

  @ApiProperty({ nullable: true, type: String })
  rawMaterialId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  spoolType!: string | null;

  @ApiProperty({ nullable: true, type: String })
  birka!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  plannedWeightKg!: number | null;

  @ApiProperty({ enum: WAREHOUSE_COVER_STATUSES })
  warehouseCoverStatus!: string;
}

export class WarehouseCoverCheckItemResponseDto {
  @ApiProperty()
  caseId!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ description: 'Safe customer alias; legal identity is omitted' })
  customerAlias!: string;

  @ApiProperty({ enum: ['open'] })
  state!: 'open';

  @ApiProperty({ format: 'date-time' })
  requestedAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ type: [WarehouseCoverCheckPositionResponseDto] })
  positions!: WarehouseCoverCheckPositionResponseDto[];
}

export class WarehouseCoverCheckPageResponseDto {
  @ApiProperty({ type: [WarehouseCoverCheckItemResponseDto] })
  items!: WarehouseCoverCheckItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
