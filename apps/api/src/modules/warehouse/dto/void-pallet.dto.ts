import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  WAREHOUSE_PALLET_VOID_NOTE_MAX_LENGTH,
  type WarehousePalletVoidReasonCode,
} from '@plenka/contracts';

const VOID_REASON_CODES: WarehousePalletVoidReasonCode[] = [
  'wrong_composition',
  'print_problem',
  'other',
];

export class VoidPalletDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ enum: VOID_REASON_CODES })
  @IsIn(VOID_REASON_CODES)
  reasonCode!: WarehousePalletVoidReasonCode;

  @ApiPropertyOptional({ maxLength: WAREHOUSE_PALLET_VOID_NOTE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(WAREHOUSE_PALLET_VOID_NOTE_MAX_LENGTH)
  note?: string;
}
