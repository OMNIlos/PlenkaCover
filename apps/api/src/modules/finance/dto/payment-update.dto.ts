import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsUUID } from 'class-validator';
import type { PaymentUpdateStatus } from '@plenka/contracts';

export const MANUAL_PAYMENT_UPDATE_STATUSES = [
  'partial',
  'paid',
] as const satisfies readonly PaymentUpdateStatus[];

export type ManualPaymentUpdateStatus = (typeof MANUAL_PAYMENT_UPDATE_STATUSES)[number];

export class PaymentUpdateDto {
  @ApiProperty({ format: 'uuid', description: 'Stable key for retries of this status update.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value), {
    toClassOnly: true,
  })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ enum: MANUAL_PAYMENT_UPDATE_STATUSES })
  @IsIn([...MANUAL_PAYMENT_UPDATE_STATUSES])
  paymentStatus!: ManualPaymentUpdateStatus;
}
