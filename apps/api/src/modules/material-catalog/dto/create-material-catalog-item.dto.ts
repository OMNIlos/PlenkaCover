import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CreateMaterialCatalogItemDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 120,
    example: 'ПНД гранула',
    description: 'Название нового вида сырья для заявок коммерции и Big-Bag.',
  })
  @IsString()
  @Length(1, 120)
  name!: string;
}
