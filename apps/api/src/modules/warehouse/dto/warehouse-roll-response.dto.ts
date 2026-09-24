import { ApiProperty } from '@nestjs/swagger';

export class WarehouseRollFactsResponseDto {
  @ApiProperty({ type: String, nullable: true })
  filmType!: string | null;

  @ApiProperty({ type: String, nullable: true })
  actualThickness!: string | null;

  @ApiProperty({ type: String, nullable: true })
  birka!: string | null;

  @ApiProperty({ type: String, nullable: true })
  spoolType!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  plannedWeightKg!: number | null;
}

export class WarehouseRollResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rollCode!: string;

  @ApiProperty()
  warehouseStatus!: string;

  @ApiProperty({ type: WarehouseRollFactsResponseDto })
  facts!: WarehouseRollFactsResponseDto;
}
