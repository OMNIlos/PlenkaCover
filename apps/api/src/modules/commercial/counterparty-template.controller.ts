import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { CounterpartyTemplateService } from './counterparty-template.service';
import {
  CreateCounterpartyTemplateDto,
  UpdateCounterpartyTemplateDto,
  UpdateCounterpartyTemplateStatusDto,
} from './dto/counterparty-template.dto';

@ApiTags('commercial')
@Controller('commercial/counterparties/:counterpartyId/templates')
export class CounterpartyTemplateController {
  constructor(private readonly service: CounterpartyTemplateService) {}

  @Get()
  @RequireCapabilities('counterparty_template:read')
  @ApiUnprocessableEntityResponse({ description: 'Template catalog exceeds safe list bounds' })
  list(@Param('counterpartyId') counterpartyId: string) {
    return this.service.listForCounterparty(counterpartyId);
  }

  @Post()
  @RequireCapabilities('counterparty_template:write')
  create(
    @CurrentActor() actor: Actor,
    @Param('counterpartyId') counterpartyId: string,
    @Body() dto: CreateCounterpartyTemplateDto,
  ) {
    return this.service.create({ userId: actor.userId, role: actor.role }, counterpartyId, dto);
  }

  @Patch(':templateId')
  @RequireCapabilities('counterparty_template:write')
  update(
    @CurrentActor() actor: Actor,
    @Param('counterpartyId') counterpartyId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateCounterpartyTemplateDto,
  ) {
    return this.service.update(
      { userId: actor.userId, role: actor.role },
      counterpartyId,
      templateId,
      dto,
    );
  }

  @Patch(':templateId/status')
  @RequireCapabilities('counterparty_template:write')
  updateStatus(
    @CurrentActor() actor: Actor,
    @Param('counterpartyId') counterpartyId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateCounterpartyTemplateStatusDto,
  ) {
    return this.service.updateStatus(
      { userId: actor.userId, role: actor.role },
      counterpartyId,
      templateId,
      dto.status,
    );
  }
}
