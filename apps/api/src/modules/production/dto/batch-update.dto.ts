import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class DispatchDraftChangeDto {
  @ApiProperty({ description: 'Stable roll code used by dispatch routes.' })
  @IsString()
  rollId!: string;

  @ApiProperty()
  @IsString()
  operatorId!: string;

  @ApiProperty({ required: false, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;
}

export class BatchUpdateDispatchDto {
  @ApiProperty({ type: [DispatchDraftChangeDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DispatchDraftChangeDto)
  changes!: DispatchDraftChangeDto[];
}
