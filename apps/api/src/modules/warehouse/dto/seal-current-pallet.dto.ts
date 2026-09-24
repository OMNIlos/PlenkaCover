import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class SealCurrentPalletDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  requestId!: string;
}
