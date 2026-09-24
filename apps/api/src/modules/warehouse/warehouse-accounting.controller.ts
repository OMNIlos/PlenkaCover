import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import {
  WarehouseAccountingMovementPageResponseDto,
  WarehouseAccountingMovementQueryDto,
  WarehouseAccountingStockPageResponseDto,
  WarehouseAccountingStockQueryDto,
} from './dto/warehouse-accounting.dto';
import { WarehouseAccountingService } from './warehouse-accounting.service';

@ApiTags('warehouse')
@Controller('warehouse')
export class WarehouseAccountingController {
  constructor(private readonly accounting: WarehouseAccountingService) {}

  @Get('accounting-stock')
  @RequireCapabilities('warehouse_task:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: WarehouseAccountingStockPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid stock scope, filter, cursor, or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Warehouse read capability is required' })
  stock(@Query() query: WarehouseAccountingStockQueryDto) {
    return this.accounting.listStock(query);
  }

  @Get('accounting-movements')
  @RequireCapabilities('warehouse_task:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: WarehouseAccountingMovementPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid movement filter, cursor, or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Warehouse read capability is required' })
  movements(@Query() query: WarehouseAccountingMovementQueryDto) {
    return this.accounting.listMovements(query);
  }
}
