import { ApiProperty } from '@nestjs/swagger';
import type {
  WarehousePalletItemView,
  WarehousePalletSelectionPalletView,
  WarehousePalletSelectionScanResult,
} from '@plenka/contracts';

class PalletSelectionScanRowResponseDto implements WarehousePalletItemView {
  @ApiProperty()
  rollCode!: string;

  @ApiProperty({ minimum: 1 })
  position!: number;

  @ApiProperty({ format: 'date-time' })
  acceptedAt!: string;

  @ApiProperty({ nullable: true })
  scannedByName!: string | null;
}

class PalletSelectionScanPalletResponseDto implements WarehousePalletSelectionPalletView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  palletCode!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ minimum: 1 })
  sequenceNo!: number;

  @ApiProperty({ enum: ['open', 'sealed', 'voided'] })
  status!: 'open' | 'sealed' | 'voided';

  @ApiProperty({ minimum: 0 })
  totalCount!: number;

  @ApiProperty()
  hasMore!: boolean;

  @ApiProperty({ format: 'date-time' })
  openedAt!: string;

  @ApiProperty({ type: () => [PalletSelectionScanRowResponseDto], maxItems: 100 })
  rows!: WarehousePalletItemView[];
}

export class WarehousePalletSelectionScanResponseDto
  implements WarehousePalletSelectionScanResult
{
  @ApiProperty({ format: 'uuid' })
  operationKey!: string;

  @ApiProperty()
  taskId!: string;

  @ApiProperty()
  scanRowId!: string;

  @ApiProperty()
  rollCode!: string;

  @ApiProperty({ enum: ['added', 'already_selected'] })
  outcome!: 'added' | 'already_selected';

  @ApiProperty({ type: () => PalletSelectionScanPalletResponseDto })
  activePallet!: WarehousePalletSelectionPalletView;
}
