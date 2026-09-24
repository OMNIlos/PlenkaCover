import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { CounterpartyService } from './counterparty.service';
import { CreateCounterpartyDto } from './dto/create-counterparty.dto';
import {
  SearchCounterpartiesPageResponseDto,
  SearchCounterpartiesQueryDto,
} from './dto/search-counterparties-query.dto';

@ApiTags('commercial')
@Controller('commercial/counterparties')
export class CounterpartyController {
  constructor(private readonly service: CounterpartyService) {}

  @Get('search')
  @RequireCapabilities('order:read')
  @ApiOkResponse({ type: SearchCounterpartiesPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid search, cursor, or page limit' })
  search(@CurrentActor() actor: Actor, @Query() query: SearchCounterpartiesQueryDto) {
    return this.service.search(actor.role, query);
  }

  @Get()
  @RequireCapabilities('order:read')
  @ApiUnprocessableEntityResponse({ description: 'Counterparty catalog exceeds safe list bounds' })
  list(@CurrentActor() actor: Actor) {
    return this.service.list(actor.role);
  }

  @Post()
  @RequireCapabilities('order:create')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateCounterpartyDto) {
    return this.service.create({ userId: actor.userId, role: actor.role }, dto);
  }
}
