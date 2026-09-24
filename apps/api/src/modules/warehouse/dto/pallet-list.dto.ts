import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsOptional, IsString } from 'class-validator';

export class CreatePalletListDto {
  @ApiProperty()
  @IsString()
  palletId!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  rollIds!: string[];

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  orderIds?: string[];

  @ApiProperty({ required: false, enum: ['word', 'excel', 'pdf'] })
  @IsOptional()
  @IsString()
  format?: string;
}
