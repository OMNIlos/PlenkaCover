import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ReserveDto {
  @ApiProperty({ description: 'Commercial order id the roll is reserved for' })
  @IsString()
  orderId!: string;
}
