import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import {
  CreateStockProductionTemplateDto,
  StockProductionTemplateResponseDto,
  UpdateStockProductionTemplateDto,
} from './dto/stock-production-template.dto';
import { StockProductionTemplateService } from './stock-production-template.service';

@ApiTags('commercial')
@ApiBearerAuth('session')
@Controller('commercial/stock-production-templates')
export class StockProductionTemplateController {
  constructor(private readonly service: StockProductionTemplateService) {}

  @Get()
  @RequireCapabilities('stock_production_template:read')
  @ApiOkResponse({
    type: StockProductionTemplateResponseDto,
    isArray: true,
    description: 'Active company-owned stock production templates.',
  })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Stock-template read capability is required.' })
  @ApiUnprocessableEntityResponse({ description: 'The bounded template catalog is too large.' })
  list() {
    return this.service.list();
  }

  @Post()
  @RequireCapabilities('stock_production_template:write')
  @ApiCreatedResponse({
    type: StockProductionTemplateResponseDto,
    description: 'Created template with immutable version 1.',
  })
  @ApiBadRequestResponse({ description: 'The template or one of its positions is invalid.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Stock-template write capability is required.' })
  @ApiConflictResponse({ description: 'The normalized template name is already in use.' })
  create(@CurrentActor() actor: Actor, @Body() dto: CreateStockProductionTemplateDto) {
    return this.service.create({ userId: actor.userId, role: actor.role }, dto);
  }

  @Patch(':templateId')
  @RequireCapabilities('stock_production_template:write')
  @ApiOkResponse({
    type: StockProductionTemplateResponseDto,
    description: 'Updated template with a newly appended immutable version.',
  })
  @ApiBadRequestResponse({ description: 'The template or one of its positions is invalid.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Stock-template write capability is required.' })
  @ApiNotFoundResponse({ description: 'The active template was not found.' })
  @ApiConflictResponse({
    description: 'The normalized name is in use or the expected version is stale.',
  })
  update(
    @CurrentActor() actor: Actor,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateStockProductionTemplateDto,
  ) {
    return this.service.update({ userId: actor.userId, role: actor.role }, templateId, dto);
  }
}
