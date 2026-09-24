import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class OpenPostSessionDto {
  @ApiProperty({ example: 'POST-1', description: 'Code of the machine-post to sit at.' })
  @IsString()
  @IsNotEmpty()
  postCode!: string;
}
