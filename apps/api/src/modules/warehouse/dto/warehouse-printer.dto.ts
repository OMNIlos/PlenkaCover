import { ApiProperty } from '@nestjs/swagger';

class WarehousePrinterPostResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;
}

export class WarehousePrinterResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  code!: string | null;

  @ApiProperty()
  label!: string;

  @ApiProperty({ type: WarehousePrinterPostResponseDto })
  post!: WarehousePrinterPostResponseDto;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  ready!: boolean;

  @ApiProperty({ nullable: true })
  unavailableReason!: string | null;
}
