import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import {
  InventoryProjectionQueryDto,
  SafeInventoryPageResponseDto,
} from '../../common/inventory/inventory-projection.dto';
import { InventoryProjectionService } from '../../common/inventory/inventory-projection.service';
import { WarehouseInventoryQueryDto } from './dto/warehouse-inventory-query.dto';
import {
  WarehouseInventoryRollDetailResponseDto,
  WarehouseInventoryRollPageResponseDto,
} from './dto/warehouse-inventory-response.dto';
import { WarehouseInventoryService } from './warehouse-inventory.service';

@ApiTags('warehouse')
@Controller('warehouse')
export class WarehouseInventoryController {
  constructor(
    private readonly inventory: InventoryProjectionService,
    private readonly rollsInventory: WarehouseInventoryService,
  ) {}

  @Get('raw-material-inventory')
  @RequireCapabilities('warehouse_task:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: SafeInventoryPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid inventory filter, cursor, or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Warehouse read capability is required' })
  rawMaterials(@Query() query: InventoryProjectionQueryDto) {
    return this.inventory.list(query);
  }

  @Get('inventory/rolls')
  @RequireCapabilities('warehouse_inventory:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: WarehouseInventoryRollPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid inventory filter, cursor, or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Warehouse read capability is required' })
  rolls(@Query() query: WarehouseInventoryQueryDto) {
    return this.rollsInventory.list(query);
  }

  @Get('inventory/rolls/:rollId')
  @RequireCapabilities('warehouse_inventory:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: WarehouseInventoryRollDetailResponseDto })
  @ApiNotFoundResponse({ description: 'The inventory roll is not visible or does not exist' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Warehouse read capability is required' })
  roll(@Param('rollId') rollId: string) {
    return this.rollsInventory.get(rollId);
  }
}
