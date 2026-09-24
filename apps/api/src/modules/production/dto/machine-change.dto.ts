import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class MachineChangeRequestDto {
  @ApiProperty({ example: 'cm-post-2' })
  @IsString()
  @IsNotEmpty()
  postId!: string;

  @ApiProperty({ example: 'Плановая переналадка' })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  operationKey!: string;
}

export class FinalizeMachineChangeDto {
  @ApiPropertyOptional({
    description: 'Big-Bag being weighed; required when more than one bag remains open',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  bigBagId?: string;
}

export class CancelMachineChangeDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsUUID(4)
  operationKey!: string;

  @ApiProperty({ maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class MachineChangeCancellationResponseDto {
  @ApiProperty()
  changeId!: string;

  @ApiProperty({ enum: ['cancelled'] })
  status!: 'cancelled';

  @ApiProperty({ format: 'date-time' })
  cancelledAt!: string;

  @ApiProperty()
  cancellationReason!: string;
}
