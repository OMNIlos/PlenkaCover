import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Hand a commercial order off into production (V2 C2). */
export class CreateProductionOrderDto {
  @ApiProperty({ description: 'Commercial order id to hand off into production' })
  @IsString()
  @MinLength(1)
  commercialOrderId!: string;
}
