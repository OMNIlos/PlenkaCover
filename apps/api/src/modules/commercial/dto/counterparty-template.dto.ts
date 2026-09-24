import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  COMMERCIAL_BIRKA_OPTIONS,
  COMMERCIAL_FILM_TYPES,
  COMMERCIAL_SPOOL_OPTIONS,
  type CommercialBirka,
  type CommercialFilmType,
  type CommercialSpoolType,
} from '@plenka/contracts';
import { CreatePositionDto } from './create-order.dto';

export type CounterpartyTemplatePosition = Omit<
  CreatePositionDto,
  'baseRawMaterialDefinitionId' | 'recipeDefinitionVersionId'
> & {
  baseRawMaterialDefinitionId?: string;
  recipeDefinitionVersionId?: string;
  rawMaterialId?: string;
};

export class CounterpartyTemplatePositionDto extends CreatePositionDto {
  @ApiProperty({ enum: COMMERCIAL_FILM_TYPES })
  @IsIn(COMMERCIAL_FILM_TYPES)
  declare filmType: CommercialFilmType;

  @ApiProperty({ required: false, enum: COMMERCIAL_SPOOL_OPTIONS })
  @IsOptional()
  @IsIn(COMMERCIAL_SPOOL_OPTIONS)
  declare spoolType?: CommercialSpoolType;

  @ApiProperty({ required: false, enum: COMMERCIAL_BIRKA_OPTIONS })
  @IsOptional()
  @IsIn(COMMERCIAL_BIRKA_OPTIONS)
  declare birka?: CommercialBirka;
}

export class CreateCounterpartyTemplateDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ type: [CounterpartyTemplatePositionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CounterpartyTemplatePositionDto)
  positions!: CounterpartyTemplatePosition[];
}

export class UpdateCounterpartyTemplateDto extends CreateCounterpartyTemplateDto {}

export const COUNTERPARTY_TEMPLATE_STATUSES = ['active', 'archived'] as const;
export type CounterpartyTemplateStatus = (typeof COUNTERPARTY_TEMPLATE_STATUSES)[number];

export class UpdateCounterpartyTemplateStatusDto {
  @ApiProperty({ enum: COUNTERPARTY_TEMPLATE_STATUSES })
  @IsIn(COUNTERPARTY_TEMPLATE_STATUSES)
  status!: CounterpartyTemplateStatus;
}
