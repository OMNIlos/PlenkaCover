import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type {
  PalletLabelLayoutDefinition,
  PalletLabelLayoutDefinitionV2,
} from '@plenka/contracts';

export class PalletLabelLayoutElementResponseDto {
  @ApiProperty({
    enum: ['order', 'customer', 'formedAt', 'rollCount', 'qr', 'storage'],
  })
  id!: string;

  @ApiProperty({ enum: ['text', 'qr'] })
  kind!: string;

  @ApiProperty({ type: Number })
  xDots!: number;

  @ApiProperty({ type: Number })
  yDots!: number;

  @ApiProperty({ type: Number })
  widthDots!: number;

  @ApiProperty({ type: Number })
  heightDots!: number;

  @ApiProperty({ type: Number })
  maxFontSize!: number;

  @ApiProperty({ type: Number })
  minFontSize!: number;

  @ApiProperty({ type: Boolean })
  locked!: boolean;
}

export class PalletLabelLayoutResponseDto {
  @ApiProperty({ enum: [2] })
  schemaVersion!: 2;

  @ApiProperty({ enum: ['pallet-100x100-configurable-v7'] })
  profile!: 'pallet-100x100-configurable-v7';

  @ApiProperty({ type: PalletLabelLayoutElementResponseDto, isArray: true })
  elements!: PalletLabelLayoutElementResponseDto[];
}

export class LegacyPalletLabelLayoutElementResponseDto {
  @ApiProperty({
    enum: ['header', 'identity', 'product', 'rollCodes', 'qr', 'summary', 'packaging', 'storage'],
  })
  id!: string;

  @ApiProperty({ enum: ['text', 'list', 'qr'] })
  kind!: string;

  @ApiProperty({ type: Number })
  xDots!: number;

  @ApiProperty({ type: Number })
  yDots!: number;

  @ApiProperty({ type: Number })
  widthDots!: number;

  @ApiProperty({ type: Number })
  heightDots!: number;

  @ApiProperty({ type: Number })
  maxFontSize!: number;

  @ApiProperty({ type: Number })
  minFontSize!: number;

  @ApiProperty({ type: Boolean })
  locked!: boolean;
}

export class LegacyPalletLabelLayoutResponseDto {
  @ApiProperty({ enum: [1] })
  schemaVersion!: 1;

  @ApiProperty({ enum: ['pallet-100x100-configurable-v7'] })
  profile!: 'pallet-100x100-configurable-v7';

  @ApiProperty({ type: LegacyPalletLabelLayoutElementResponseDto, isArray: true })
  elements!: LegacyPalletLabelLayoutElementResponseDto[];
}

export class PalletLabelLayoutCanvasResponseDto {
  @ApiProperty({ example: 800 })
  widthDots!: 800;

  @ApiProperty({ example: 800 })
  heightDots!: 800;

  @ApiProperty({ example: 8 })
  dotsPerMm!: 8;

  @ApiProperty({ example: 20 })
  safeInsetDots!: 20;

  @ApiProperty({ example: 570 })
  provenCutYDots!: 570;
}

export class PalletLabelLayoutSourceResponseDto {
  @ApiProperty({ example: 'cm123' })
  documentId!: string;

  @ApiProperty({ enum: ['control', 'document'] })
  kind!: 'control' | 'document';

  @ApiProperty({ example: 'Контрольный синтетический источник' })
  label!: string;

  @ApiProperty({ example: 'PAL-A-2-06' })
  palletId!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ example: 1 })
  rollCount!: number;
}

export class PalletLabelLayoutEditorBootstrapResponseDto {
  @ApiProperty({ enum: [2] })
  schemaVersion!: 2;

  @ApiProperty({ enum: ['pallet-100x100-configurable-v7'] })
  profile!: 'pallet-100x100-configurable-v7';

  @ApiProperty({ type: PalletLabelLayoutCanvasResponseDto })
  canvas!: PalletLabelLayoutCanvasResponseDto;

  @ApiProperty({ type: PalletLabelLayoutResponseDto })
  editorLayout!: PalletLabelLayoutResponseDto;

  @ApiPropertyOptional({ type: () => PalletLabelLayoutPublicationResponseDto, nullable: true })
  activePublication!: PalletLabelLayoutPublicationResponseDto | null;

  @ApiProperty({ type: PalletLabelLayoutSourceResponseDto, isArray: true })
  sources!: PalletLabelLayoutSourceResponseDto[];
}

export class PreviewPalletLabelLayoutDto {
  @ApiProperty({ example: 'cm123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sourceDocumentId!: string;

  @ApiProperty({ type: PalletLabelLayoutResponseDto })
  @IsObject()
  layout!: PalletLabelLayoutDefinitionV2;
}

@ApiExtraModels(LegacyPalletLabelLayoutResponseDto, PalletLabelLayoutResponseDto)
export class PalletLabelLayoutPublicationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ minimum: 1 }) version!: number;
  @ApiProperty({ minLength: 64, maxLength: 64 }) contentHash!: string;
  @ApiProperty({ format: 'date-time' }) activatedAt!: string;
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(LegacyPalletLabelLayoutResponseDto) },
      { $ref: getSchemaPath(PalletLabelLayoutResponseDto) },
    ],
  })
  layout!: PalletLabelLayoutDefinition;
}

export class PublishPalletLabelLayoutDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  expectedActivePublicationId!: string | null;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sourceDocumentId!: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ type: PalletLabelLayoutResponseDto })
  @IsObject()
  layout!: PalletLabelLayoutDefinitionV2;
}

export class PublishPalletLabelLayoutResponseDto {
  @ApiProperty({ type: PalletLabelLayoutPublicationResponseDto })
  publication!: PalletLabelLayoutPublicationResponseDto;

  @ApiProperty()
  replayed!: boolean;
}
