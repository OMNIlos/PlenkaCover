import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Min } from 'class-validator';

export class IdempotentCommandDto {
  @ApiProperty({ format: 'uuid', description: 'Stable across retries of the same command' })
  @IsUUID()
  clientRequestId!: string;
}

export class VersionedCommandDto {
  @ApiProperty({ minimum: 1, description: 'Optimistic concurrency version last seen by the user' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
