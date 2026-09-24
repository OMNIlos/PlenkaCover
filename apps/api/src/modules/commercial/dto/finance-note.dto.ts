import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class FinanceNoteDto {
  @ApiProperty({
    nullable: true,
    maxLength: 2000,
    description: 'Свободный комментарий для бухгалтерии; не является суммой счета.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  commercialFinanceNote!: string | null;

  @ApiProperty({ minimum: 1, description: 'Последняя версия заявки в интерфейсе.' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiProperty({ format: 'uuid', description: 'UUIDv4 одной логической мутации.' })
  @IsUUID(4)
  operationKey!: string;
}
