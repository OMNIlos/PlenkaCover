import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  InventoryProjectionQueryDto,
  SafeInventoryPageResponseDto,
} from '../../common/inventory/inventory-projection.dto';
import { InventoryProjectionService } from '../../common/inventory/inventory-projection.service';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';

@ApiTags('production')
@Controller('production')
export class ProductionInventoryController {
  constructor(private readonly inventory: InventoryProjectionService) {}

  @Get('raw-materials')
  @RequireCapabilities('material_catalog:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: SafeInventoryPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid inventory filter, cursor, or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Material catalog read capability is required' })
  rawMaterials(@Query() query: InventoryProjectionQueryDto) {
    return this.inventory.list(query);
  }
}
