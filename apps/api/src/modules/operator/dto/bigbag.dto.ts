import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

/** Big-bag manual weight — the allowed manual exception, audited (ТЗ §9). */
export class BigBagWeightDto {
  @ApiProperty({ description: 'Manually weighed kg (physical big-bag)' })
  @IsNumber()
  @Min(0)
  kg!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
