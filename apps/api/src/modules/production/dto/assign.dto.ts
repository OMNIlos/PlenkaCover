import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AssignRollDto {
  @ApiProperty()
  @IsString()
  operatorId!: string;
}
