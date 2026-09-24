import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { POST_STATUSES } from '@plenka/contracts';

export class CreatePostDto {
  @ApiProperty({ example: 'POST-6', description: 'Stable post code (used as machineId).' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ example: 'Пнд новая' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ required: false, enum: POST_STATUSES })
  @IsOptional()
  @IsIn([...POST_STATUSES])
  status?: string;
}
