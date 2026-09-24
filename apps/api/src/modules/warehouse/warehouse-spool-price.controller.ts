import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import {
  RecordSpoolPriceReferenceDto,
  RecordSpoolStockReceiptDto,
  SpoolPriceReferenceResponseDto,
  SpoolPriceTypeResponseDto,
  SpoolStockReceiptResponseDto,
  SpoolStockSummaryItemResponseDto,
} from './dto/warehouse-spool-price.dto';
import { WarehouseSpoolPriceService } from './warehouse-spool-price.service';

@ApiTags('warehouse')
@ApiBearerAuth('session')
@Controller('warehouse')
export class WarehouseSpoolPriceController {
  constructor(private readonly prices: WarehouseSpoolPriceService) {}

  @Get('spool-price-types')
  @RequireCapabilities('spool_price:manage')
  @ApiOkResponse({ type: SpoolPriceTypeResponseDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Spool price management capability is required.' })
  @ApiConflictResponse({ description: 'Observed spool labels are ambiguous or exceed the bound.' })
  listTypes() {
    return this.prices.listObservedTypes();
  }

  @Get('spool-stock')
  @RequireCapabilities('spool_stock:read')
  @ApiOkResponse({ type: SpoolStockSummaryItemResponseDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Spool stock read capability is required.' })
  @ApiConflictResponse({ description: 'Observed spool labels are ambiguous or exceed the bound.' })
  listStock() {
    return this.prices.listStock();
  }

  @Post('spool-price-references')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('spool_price:manage')
  @ApiOkResponse({ type: SpoolPriceReferenceResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid spool price reference.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Spool price management capability is required.' })
  @ApiNotFoundResponse({ description: 'The spool label is not in the observed business catalog.' })
  @ApiConflictResponse({ description: 'Idempotency, identity, or effective-date conflict.' })
  record(@CurrentActor() actor: Actor, @Body() dto: RecordSpoolPriceReferenceDto) {
    return this.prices.record(actor, dto);
  }

  @Post('spool-stock-receipts')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('spool_stock:receive')
  @ApiOkResponse({ type: SpoolStockReceiptResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid spool price or receipt quantity.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Spool stock receipt capability is required.' })
  @ApiNotFoundResponse({ description: 'The spool label is not in the observed business catalog.' })
  @ApiConflictResponse({ description: 'Idempotency, identity, or effective-date conflict.' })
  recordReceipt(@CurrentActor() actor: Actor, @Body() dto: RecordSpoolStockReceiptDto) {
    return this.prices.recordReceipt(actor, dto);
  }
}
