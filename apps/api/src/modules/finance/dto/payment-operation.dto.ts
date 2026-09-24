import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNumber, IsPositive, IsUUID, Max } from 'class-validator';
import { PAYMENT_OPERATION_TYPES, type PaymentOperationType } from '@plenka/contracts';

/** Technical safe-cents ceiling until the business approves a lower accounting limit. */
export const MAX_PAYMENT_OPERATION_AMOUNT = 1_000_000_000_000;

export class PaymentOperationDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value), {
    toClassOnly: true,
  })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ enum: PAYMENT_OPERATION_TYPES })
  @IsIn([...PAYMENT_OPERATION_TYPES])
  operationType!: PaymentOperationType;

  @ApiProperty({ maximum: MAX_PAYMENT_OPERATION_AMOUNT })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_PAYMENT_OPERATION_AMOUNT)
  amount!: number;
}
