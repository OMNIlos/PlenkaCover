import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import {
  AdditionalProductionCostResponseDto,
  MaterialPriceReferenceResponseDto,
  RecordAdditionalProductionCostDto,
  SetMaterialPriceDto,
} from './dto/production-cost-input.dto';
import { ProductionCostInputService } from './production-cost-input.service';

@ApiTags('finance')
@ApiBearerAuth('session')
@Controller('finance/production-costs')
export class ProductionCostInputController {
  constructor(private readonly inputs: ProductionCostInputService) {}

  @Post('material-prices')
  @RequireCapabilities('material_cost:manage')
  @ApiCreatedResponse({ type: MaterialPriceReferenceResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid price reference.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Material cost management capability is required.' })
  @ApiNotFoundResponse({ description: 'Raw material definition was not found.' })
  @ApiConflictResponse({ description: 'Idempotency or effective-date conflict.' })
  setMaterialPrice(@CurrentActor() actor: Actor, @Body() dto: SetMaterialPriceDto) {
    return this.inputs.setMaterialPrice(actor, dto);
  }

  @Post('additional')
  @RequireCapabilities('material_cost:manage')
  @ApiCreatedResponse({ type: AdditionalProductionCostResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid amount or target.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Material cost management capability is required.' })
  @ApiNotFoundResponse({ description: 'Roll or production order was not found.' })
  @ApiConflictResponse({ description: 'Idempotency conflict.' })
  recordAdditionalCost(
    @CurrentActor() actor: Actor,
    @Body() dto: RecordAdditionalProductionCostDto,
  ) {
    return this.inputs.recordAdditionalCost(actor, dto);
  }
}
