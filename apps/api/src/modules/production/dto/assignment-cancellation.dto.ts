import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class AssignmentCancellationDto {
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

export class AssignmentCancellationResponseDto {
  @ApiProperty()
  commandId!: string;

  @ApiProperty()
  assignmentId!: string;

  @ApiProperty()
  shiftId!: string;

  @ApiProperty({ enum: ['cancelled'] })
  status!: 'cancelled';

  @ApiProperty({ type: [String] })
  releasedDispatchItemIds!: string[];

  @ApiProperty({ example: false })
  shiftClosed!: false;
}
