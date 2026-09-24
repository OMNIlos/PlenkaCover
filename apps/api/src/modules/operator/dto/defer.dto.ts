import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { OperatorOperationDto } from './operation.dto';

export class DeferRollDto extends OperatorOperationDto {
  @ApiProperty({ description: 'Причина откладывания рулона (обязательна)' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/u)
  @MaxLength(500)
  reason!: string;
}
