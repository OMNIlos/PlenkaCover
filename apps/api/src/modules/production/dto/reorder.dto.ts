import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class ReorderDispatchDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(2)
  @IsString({ each: true })
  orderedRollIds!: string[];

  @ApiProperty({ example: 'Ручной порядок изготовления' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
