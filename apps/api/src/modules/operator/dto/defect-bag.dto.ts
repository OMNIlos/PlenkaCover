import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DEFECT_BAG_TYPES, type DefectBagType } from '@plenka/contracts';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OperatorOperationDto } from './operation.dto';
import { QrPrintDto } from './qr.dto';

export class DefectBagPrintDto extends QrPrintDto {
  @ApiProperty({
    required: false,
    description: 'Мешок брака; обязателен, если в смене их несколько',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  defectBagId?: string;
}

export class DefectBagWeightDto extends OperatorOperationDto {
  @ApiPropertyOptional({
    enum: DEFECT_BAG_TYPES,
    description: 'Тип брака; обязателен при весе больше 0',
  })
  @IsOptional()
  @IsIn(DEFECT_BAG_TYPES)
  defectType?: DefectBagType;

  @ApiProperty({ description: 'Вес мешка брака, введённый оператором вручную, кг' })
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(10_000)
  weightKg!: number;
}
