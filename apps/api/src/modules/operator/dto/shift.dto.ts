import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class OpenShiftDto {
  @ApiPropertyOptional({ description: 'Код поста; по умолчанию — из назначения завпроизводства' })
  @IsOptional()
  @IsString()
  postCode?: string;

  @ApiProperty({ description: 'Выбранный Big-Bag (id карточки)' })
  @IsString()
  @IsNotEmpty()
  bigBagId!: string;

  @ApiProperty({ description: 'Стартовый вес мешка, кг (ручной ввод после взвешивания)' })
  @IsNumber()
  @IsPositive()
  startKg!: number;
}

export class AddShiftBagDto {
  @ApiProperty({ description: 'Big-Bag, добавляемый в открытую смену' })
  @IsString()
  @IsNotEmpty()
  bigBagId!: string;

  @ApiProperty({ description: 'Стартовый вес добавленного мешка, кг' })
  @IsNumber()
  @IsPositive()
  startKg!: number;

  @ApiPropertyOptional({
    description: 'Необязательная служебная пометка для обратной совместимости',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CloseShiftBagDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  bigBagId!: string;

  @ApiProperty({ description: 'Финальный вес мешка, кг' })
  @IsNumber()
  @Min(0)
  endKg!: number;
}

export class ReleaseShiftBagDto {
  @ApiProperty({ format: 'uuid', description: 'Стабильный ключ сдачи и movement-факта' })
  @IsUUID()
  operationKey!: string;

  @ApiProperty({ description: 'Финальный вес сдаваемого Big-Bag, кг' })
  @IsNumber()
  @Min(0)
  endKg!: number;

  @ApiPropertyOptional({
    description: 'Устаревшее поле; сдача Big-Bag не требует причины',
    deprecated: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CloseShiftDto {
  @ApiProperty({ format: 'uuid', description: 'Стабильный ключ повторной отправки закрытия' })
  @IsUUID()
  operationKey!: string;

  @ApiProperty({
    type: [CloseShiftBagDto],
    description: 'Финальный вес каждого Big-Bag, который ещё активен при сдаче смены',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CloseShiftBagDto)
  bags!: CloseShiftBagDto[];
}
