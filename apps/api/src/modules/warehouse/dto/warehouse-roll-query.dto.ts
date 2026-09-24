import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

const WAREHOUSE_ROLL_OWNERSHIP = ['free', 'reserved'] as const;

export class WarehouseRollQueryDto {
  @ApiPropertyOptional({ enum: WAREHOUSE_ROLL_OWNERSHIP })
  @IsOptional()
  @IsIn(WAREHOUSE_ROLL_OWNERSHIP)
  ownership?: (typeof WAREHOUSE_ROLL_OWNERSHIP)[number];
}
