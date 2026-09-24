import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Quick-create of a counterparty from the commercial intake form (V2 C1).
 * Only fields the Counterparty model persists today (displayName/legalName/inn);
 * kpp/ogrn/address/contacts from the UI need a schema extension — deferred.
 */
export class CreateCounterpartyDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  legalName?: string;

  @ApiProperty({ required: false, description: 'ИНН — idempotency key when present' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  inn?: string;
}
