import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class OperatorOperationDto {
  @ApiProperty({
    format: 'uuid',
    description: 'UUID-v4 idempotency key generated once for this user intent',
  })
  @IsUUID('4')
  operationKey!: string;
}
