import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PAYMENT_TERM_TYPES, type PaymentTermType } from '@plenka/contracts';
import { PaymentPolicyDto } from './payment-policy.dto';

export class CreateInvoiceDto {
  @ApiProperty()
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({ required: false, type: PaymentPolicyDto })
  @ValidateIf((_object, value) => value !== undefined)
  @ValidateNested()
  @Type(() => PaymentPolicyDto)
  paymentPolicy?: PaymentPolicyDto;

  @ApiProperty({ enum: PAYMENT_TERM_TYPES, required: false, deprecated: true })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn([...PAYMENT_TERM_TYPES])
  paymentTermsType?: PaymentTermType;
}
