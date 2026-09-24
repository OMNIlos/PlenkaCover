import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class SetPriorityDto {
  @ApiProperty({ description: 'Higher = more urgent', minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  priority!: number;
}
