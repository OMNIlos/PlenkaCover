import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PaymentAllocationTargetDto {
  @ApiProperty({ description: 'Finance order identifier.' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  financeOrderId!: string;

  @ApiProperty({ minimum: 0.01, multipleOf: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;
}

export class PaymentAllocationResolveDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value), {
    toClassOnly: true,
  })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ minLength: 4, maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value), {
    toClassOnly: true,
  })
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ type: [PaymentAllocationTargetDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationTargetDto)
  allocations!: PaymentAllocationTargetDto[];
}
