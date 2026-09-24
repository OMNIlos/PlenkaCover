import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PAYMENT_TERM_TYPES, type PaymentTermType } from '@plenka/contracts';

export class SetPaymentTermsDto {
  @ApiProperty({ enum: PAYMENT_TERM_TYPES, deprecated: true })
  @IsIn([...PAYMENT_TERM_TYPES])
  paymentTermsType!: PaymentTermType;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
