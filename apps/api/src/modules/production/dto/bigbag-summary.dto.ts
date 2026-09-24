import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProductionBigBagSummaryCountsDto {
  @ApiProperty()
  total!: number;

  @ApiProperty()
  inUse!: number;

  @ApiProperty()
  idle!: number;

  @ApiProperty()
  notRequired!: number;
}

export class ProductionBigBagSummaryItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  material!: string;

  @ApiPropertyOptional({ nullable: true })
  materialDefinitionId!: string | null;

  @ApiProperty({ enum: ['available', 'in_use', 'consumed'] })
  status!: string;

  @ApiPropertyOptional({ nullable: true })
  currentKg!: number | null;

  @ApiProperty({
    enum: ['in_use', 'idle_required', 'idle_not_required', 'idle_unclassified'],
  })
  classification!: string;
}

export class ProductionBigBagSummaryResponseDto {
  @ApiProperty({ type: ProductionBigBagSummaryCountsDto })
  counts!: ProductionBigBagSummaryCountsDto;

  @ApiProperty({ type: [ProductionBigBagSummaryItemDto] })
  bags!: ProductionBigBagSummaryItemDto[];

  @ApiProperty({ type: [ProductionBigBagSummaryItemDto] })
  returnCandidates!: ProductionBigBagSummaryItemDto[];

  @ApiProperty()
  generatedAt!: string;
}
