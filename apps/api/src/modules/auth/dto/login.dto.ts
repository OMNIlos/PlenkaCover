import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'оператор', description: 'Account login (Latin or Cyrillic).' })
  @IsString()
  @IsNotEmpty()
  login!: string;

  @ApiProperty({ example: 'plenka-dev', description: 'Account password.' })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
