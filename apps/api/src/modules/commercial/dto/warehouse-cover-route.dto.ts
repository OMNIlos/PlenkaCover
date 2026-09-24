import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class WarehouseCoverRouteDto {
  @ApiProperty({ description: 'Commercial order position id.' })
  @IsString()
  positionId!: string;

  @ApiProperty({
    enum: ['partial_proposed', 'full_proposed', 'needs_production'],
    description: 'Commercial-selected route for the position.',
  })
  @IsIn(['partial_proposed', 'full_proposed', 'needs_production'])
  status!: 'partial_proposed' | 'full_proposed' | 'needs_production';

  @ApiPropertyOptional({ description: 'Roll count covered by warehouse raw material.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  coverQty?: number;

  @ApiPropertyOptional({ description: 'Audited reason/comment for the commercial decision.' })
  @IsOptional()
  @IsString()
  reason?: string;
}
