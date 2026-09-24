import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateShiftDto {
  @ApiProperty({ example: 'Смена A' })
  @IsString()
  @IsNotEmpty()
  label!: string;

  @ApiProperty({ example: '2026-07-11T05:00:00.000Z' })
  @IsISO8601()
  plannedStartAt!: string;

  @ApiProperty({ example: '2026-07-11T13:00:00.000Z' })
  @IsISO8601()
  plannedEndAt!: string;
}

export class CreateIndividualShiftDto {
  @ApiProperty({ example: 'cm-operator-1' })
  @IsString()
  @IsNotEmpty()
  operatorId!: string;

  @ApiProperty({ example: 'cm-post-2' })
  @IsString()
  @IsNotEmpty()
  postId!: string;

  @ApiPropertyOptional({ example: 'Ночная линия' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;
}
