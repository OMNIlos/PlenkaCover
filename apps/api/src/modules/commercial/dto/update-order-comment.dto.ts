import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import { VersionedCommandDto } from './versioned-command.dto';

export class UpdateOrderCommentDto extends VersionedCommandDto {
  @ApiProperty({ maxLength: 1000, description: 'Empty text clears the comment' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  comment!: string;
}
