import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/** Warehouse closing is never automatic — the user confirms full or partial (ТЗ §3). */
export class CloseTaskDto {
  @ApiProperty({ enum: ['full', 'partial'] })
  @IsIn(['full', 'partial'])
  mode!: 'full' | 'partial';
}
