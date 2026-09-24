import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class WarehouseQrInspectDto {
  @ApiProperty({
    pattern: '^(?:prt|bbt|plt)_[0-9a-f]{64}$',
    description: 'Exact opaque payload from a roll, Big-Bag or pallet QR label.',
  })
  @IsString()
  @Matches(/^(?:prt|bbt|plt)_[0-9a-f]{64}$/u)
  payload!: string;
}

export class WarehouseQrRollResponseDto {
  @ApiProperty()
  rollCode!: string;

  @ApiProperty({ nullable: true, type: String })
  orderId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  orderNumber!: string | null;

  @ApiProperty({ nullable: true, type: String })
  customerAlias!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  requestCreatedAt!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  readyForShipmentAt!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  shipmentCompletedAt!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  sequence!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  plannedKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  spoolKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  grossKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  netKg!: number | null;

  @ApiProperty({ nullable: true, type: Boolean })
  toleranceOk!: boolean | null;

  @ApiProperty({ nullable: true, type: String })
  filmType!: string | null;

  @ApiProperty({ nullable: true, type: String })
  actualThickness!: string | null;

  @ApiProperty({ nullable: true, type: String })
  accountingThickness!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  widthMm!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  plannedLengthM!: number | null;

  @ApiProperty({ nullable: true, type: String })
  spoolType!: string | null;

  @ApiProperty({ nullable: true, type: String })
  birka!: string | null;

  @ApiProperty()
  productionStatus!: string;

  @ApiProperty()
  warehouseStatus!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  producedAt!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  receivedAt!: string | null;
}

export class WarehouseQrBigBagResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  material!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  registrationStatus!: string;

  @ApiProperty()
  location!: string;

  @ApiProperty({ nullable: true, type: Number })
  initialKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  currentKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  lastMeasuredKg!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastMeasuredAt!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  priceKopecksPerKg!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  totalKopecks!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  priceEffectiveAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class WarehouseQrRollInspectionResponseDto {
  @ApiProperty({ enum: ['roll'] })
  kind!: 'roll';

  @ApiProperty({ type: WarehouseQrRollResponseDto })
  roll!: WarehouseQrRollResponseDto;

  @ApiProperty({ format: 'date-time' })
  inspectedAt!: string;
}

export class WarehouseQrBigBagInspectionResponseDto {
  @ApiProperty({ enum: ['big_bag'] })
  kind!: 'big_bag';

  @ApiProperty({ type: WarehouseQrBigBagResponseDto })
  bigBag!: WarehouseQrBigBagResponseDto;

  @ApiProperty({ format: 'date-time' })
  inspectedAt!: string;
}

export class WarehouseQrPalletResponseDto {
  @ApiProperty()
  palletCode!: string;

  @ApiProperty({ nullable: true, enum: ['open', 'sealed', 'voided'] })
  status!: 'open' | 'sealed' | 'voided' | null;

  @ApiProperty({ enum: ['sealed', 'voided'] })
  documentStatus!: 'sealed' | 'voided';

  @ApiProperty()
  materialMark!: string;

  @ApiProperty({ type: [String] })
  productNames!: string[];

  @ApiProperty({ nullable: true, type: String })
  article!: string | null;

  @ApiProperty()
  rollCount!: number;

  @ApiProperty({ type: [String] })
  rollCodes!: string[];

  @ApiProperty({ nullable: true, type: String })
  packagingMaterial!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  packagingCount!: number | null;

  @ApiProperty()
  netKg!: number;

  @ApiProperty({ nullable: true, type: Number })
  grossKg!: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Display value from the immutable label, not necessarily an ISO date.',
  })
  productionDate!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  shelfLifeMonths!: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Display value from the immutable label, not necessarily an ISO date.',
  })
  deliveryDate!: string | null;

  @ApiProperty({ nullable: true, type: String })
  storageConditions!: string | null;

  @ApiProperty({ type: [String] })
  orderNumbers!: string[];

  @ApiProperty({ type: [String] })
  customerAliases!: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  sealedAt!: string | null;
}

export class WarehouseQrPalletInspectionResponseDto {
  @ApiProperty({ enum: ['pallet'] })
  kind!: 'pallet';

  @ApiProperty({ type: WarehouseQrPalletResponseDto })
  pallet!: WarehouseQrPalletResponseDto;

  @ApiProperty({ format: 'date-time' })
  inspectedAt!: string;
}
