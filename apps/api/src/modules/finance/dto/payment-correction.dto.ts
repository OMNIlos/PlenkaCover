import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { PAYMENT_UPDATE_STATUSES, type PaymentUpdateStatus } from '@plenka/contracts';

export const PAYMENT_CORRECTION_TARGET_KINDS = [
  'payment_update',
  'schedule_confirmation',
  'payment_operation',
] as const;

export type PaymentCorrectionTargetKind = (typeof PAYMENT_CORRECTION_TARGET_KINDS)[number];

export class PaymentCorrectionTargetDto {
  @ApiProperty({ enum: PAYMENT_CORRECTION_TARGET_KINDS })
  @IsIn(PAYMENT_CORRECTION_TARGET_KINDS)
  kind!: PaymentCorrectionTargetKind;

  @ApiProperty({ maxLength: 100 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  id!: string;
}

export class PaymentCorrectionDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsUUID(4)
  operationKey!: string;

  @ApiProperty({ type: PaymentCorrectionTargetDto })
  @ValidateNested()
  @Type(() => PaymentCorrectionTargetDto)
  target!: PaymentCorrectionTargetDto;

  @ApiProperty({ enum: PAYMENT_UPDATE_STATUSES })
  @IsIn(PAYMENT_UPDATE_STATUSES)
  expectedPaymentStatus!: PaymentUpdateStatus;

  @ApiProperty({ maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class PaymentCorrectionResponseDto {
  @ApiProperty()
  commandId!: string;

  @ApiProperty({ enum: PAYMENT_CORRECTION_TARGET_KINDS })
  targetKind!: PaymentCorrectionTargetKind;

  @ApiProperty()
  targetId!: string;

  @ApiProperty({ nullable: true, type: String })
  reversalOperationId!: string | null;

  @ApiProperty({ enum: PAYMENT_UPDATE_STATUSES })
  paymentStatus!: PaymentUpdateStatus;

  @ApiProperty({ nullable: true, type: String })
  productionClearedAt!: string | null;
}
