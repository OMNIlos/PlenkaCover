import { ApiProperty } from '@nestjs/swagger';
import type {
  RecordSpoolPriceReferenceInput,
  RecordSpoolStockReceiptInput,
  Role,
  SpoolPriceReferenceView,
  SpoolPriceTypeView,
  SpoolStockReceiptView,
  SpoolStockSummaryItemView,
} from '@plenka/contracts';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class RecordSpoolPriceReferenceDto implements RecordSpoolPriceReferenceInput {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  spoolTypeLabel!: string;

  @ApiProperty({ type: 'integer', format: 'int64', minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  priceKopecksPerMeter!: number;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  source!: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class SpoolPriceTypeResponseDto implements SpoolPriceTypeView {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  label!: string;
}

export class SpoolPriceReferenceResponseDto implements SpoolPriceReferenceView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  spoolTypeKey!: string;

  @ApiProperty()
  spoolTypeLabel!: string;

  @ApiProperty({ type: 'integer', format: 'int64' })
  priceKopecksPerMeter!: number;

  @ApiProperty()
  source!: string;

  @ApiProperty({ format: 'date-time' })
  effectiveFrom!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty()
  createdById!: string;

  @ApiProperty({
    enum: [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'warehouse',
      'director',
      'admin',
    ],
  })
  createdByRole!: Role;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class RecordSpoolStockReceiptDto
  extends RecordSpoolPriceReferenceDto
  implements RecordSpoolStockReceiptInput
{
  @ApiProperty({ type: 'integer', format: 'int64', minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  quantityMillimeters!: number;
}

export class SpoolStockReceiptResponseDto implements SpoolStockReceiptView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  spoolTypeKey!: string;

  @ApiProperty()
  spoolTypeLabel!: string;

  @ApiProperty({ type: 'integer', format: 'int64' })
  quantityMillimeters!: number;

  @ApiProperty()
  priceReferenceId!: string;

  @ApiProperty({ type: 'integer', format: 'int64' })
  priceKopecksPerMeter!: number;

  @ApiProperty({ format: 'date-time' })
  effectiveFrom!: string;

  @ApiProperty({ format: 'date-time' })
  receivedAt!: string;

  @ApiProperty()
  receivedById!: string;

  @ApiProperty({
    enum: [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'warehouse',
      'director',
      'admin',
    ],
  })
  receivedByRole!: Role;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class SpoolStockSummaryItemResponseDto implements SpoolStockSummaryItemView {
  @ApiProperty()
  spoolTypeKey!: string;

  @ApiProperty()
  spoolTypeLabel!: string;

  @ApiProperty({ type: 'integer', format: 'int64' })
  totalReceivedMillimeters!: number;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastReceivedAt!: string | null;
}
