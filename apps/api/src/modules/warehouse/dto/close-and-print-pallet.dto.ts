import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class CloseAndPrintCurrentPalletDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  printerId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  requestId!: string;
}
