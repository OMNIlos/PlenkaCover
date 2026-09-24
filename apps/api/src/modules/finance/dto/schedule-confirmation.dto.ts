import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsUUID } from 'class-validator';

export class ScheduleConfirmationDto {
  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'Client-generated idempotency key; generated server-side for legacy clients.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsUUID(4)
  operationKey?: string;
}
