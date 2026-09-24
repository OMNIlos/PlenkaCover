import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const PRODUCTION_ORDER_BUCKETS = ['needs_approval', 'approved'] as const;
export type ProductionOrderBucket = (typeof PRODUCTION_ORDER_BUCKETS)[number];

export function isProductionOrderBucket(value: unknown): value is ProductionOrderBucket {
  return (
    typeof value === 'string' && (PRODUCTION_ORDER_BUCKETS as readonly string[]).includes(value)
  );
}

export class ProductionOrderQueryDto {
  @ApiPropertyOptional({ enum: PRODUCTION_ORDER_BUCKETS })
  @IsOptional()
  @IsIn([...PRODUCTION_ORDER_BUCKETS])
  bucket?: ProductionOrderBucket;
}
