import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export const PALLET_SYSTEM_PRINT_INTENT_KINDS = ['initial', 'reprint'] as const;

export type PalletSystemPrintIntentKind = (typeof PALLET_SYSTEM_PRINT_INTENT_KINDS)[number];

export class PalletSystemPrintIntentDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({ enum: PALLET_SYSTEM_PRINT_INTENT_KINDS })
  @IsIn(PALLET_SYSTEM_PRINT_INTENT_KINDS)
  kind!: PalletSystemPrintIntentKind;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    description:
      'Required for a new browser/system reprint intent; omitted only to replay a legacy pre-reason request id.',
  })
  @ValidateIf((command: PalletSystemPrintIntentDto) => command.reason !== undefined)
  @IsString()
  @Matches(/\S/u)
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

export class PalletSystemPrintIntentResponseDto {
  @ApiProperty()
  eventId!: string;

  @ApiProperty({ format: 'uuid' })
  requestId!: string;

  @ApiProperty()
  palletListDocumentId!: string;

  @ApiProperty({ enum: PALLET_SYSTEM_PRINT_INTENT_KINDS })
  kind!: PalletSystemPrintIntentKind;

  @ApiProperty({ enum: ['intent_recorded'] })
  status!: 'intent_recorded';

  @ApiProperty()
  replayed!: boolean;

  @ApiProperty({ format: 'date-time' })
  requestedAt!: string;
}
