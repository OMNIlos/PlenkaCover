import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsUUID } from 'class-validator';

export class SetPalletSelectionDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty()
  @IsBoolean()
  selected!: boolean;
}
