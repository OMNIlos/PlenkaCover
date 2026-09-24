import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Warehouse answer to the «проверка сырья/остатков» step (ТЗ §5.3): the склад
 * proposes concrete free rolls and their position-level compatibility facts.
 * Quantity and cover type are derived server-side; the commercial role chooses the route.
 */
export class CoverProposeDto {
  @ApiProperty({ description: 'Commercial order position id' })
  @IsString()
  @MaxLength(100)
  positionId!: string;

  @ApiProperty({ type: [String], description: 'Exact free WarehouseRoll ids; may be empty' })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  rollIds!: string[];

  @ApiPropertyOptional({ description: 'Explicit proposal expiry timestamp' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Комментарий склада (audited)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
