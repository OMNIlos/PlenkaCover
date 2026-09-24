import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
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
import { WarehouseCoverageCalculationService } from '../warehouse-coverage/warehouse-coverage-calculation.service';
import { WarehouseCoverageDecisionService } from '../warehouse-coverage/warehouse-coverage-decision.service';
import { WarehouseCoverageRecheckService } from '../warehouse-coverage/warehouse-coverage-recheck.service';
import {
  DecideWarehouseCoverageDto,
  RefreshWarehouseCoverageDto,
  RequestWarehouseCoverageRecheckDto,
} from './dto/warehouse-coverage.dto';

@ApiTags('finance', 'warehouse-coverage')
@ApiBearerAuth('session')
@Controller('finance/orders/:financeOrderId/warehouse-coverage')
export class FinanceWarehouseCoverageController {
  constructor(
    private readonly coverage: WarehouseCoverageCalculationService,
    private readonly decisions: WarehouseCoverageDecisionService,
    private readonly rechecks: WarehouseCoverageRecheckService,
  ) {}

  @Get()
  @RequireCapabilities('finance_order:read')
  @ApiOkResponse({ description: 'Protected finance warehouse-coverage projection.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Finance order read capability is required.' })
  @ApiNotFoundResponse({ description: 'Finance order was not found.' })
  @ApiConflictResponse({ description: 'The order does not use warehouse coverage V2.' })
  read(@CurrentActor() actor: Actor, @Param('financeOrderId') financeOrderId: string) {
    return this.coverage.readForFinance(actor, financeOrderId);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('warehouse_coverage:refresh')
  @ApiOkResponse({ description: 'Fresh protected finance warehouse-coverage projection.' })
  @ApiBadRequestResponse({ description: 'The idempotency key or CAS values are invalid.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Warehouse coverage refresh capability is required.' })
  @ApiNotFoundResponse({ description: 'Finance order was not found.' })
  @ApiConflictResponse({ description: 'The coverage snapshot changed concurrently.' })
  refresh(
    @CurrentActor() actor: Actor,
    @Param('financeOrderId') financeOrderId: string,
    @Body() dto: RefreshWarehouseCoverageDto,
  ) {
    return this.coverage.refreshForFinance(actor, financeOrderId, dto);
  }

  @Post('decide')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('warehouse_coverage:decide')
  @ApiOkResponse({ description: 'Terminal protected finance warehouse-coverage projection.' })
  @ApiBadRequestResponse({
    description: 'The idempotency key, CAS values, or decision are invalid.',
  })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Warehouse coverage decision capability is required.' })
  @ApiNotFoundResponse({ description: 'Finance order was not found.' })
  @ApiConflictResponse({ description: 'The coverage snapshot changed concurrently.' })
  decide(
    @CurrentActor() actor: Actor,
    @Param('financeOrderId') financeOrderId: string,
    @Body() dto: DecideWarehouseCoverageDto,
  ) {
    return this.decisions.decide(actor, financeOrderId, dto);
  }

  @Post('recheck')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('warehouse_coverage:request_recheck')
  @ApiOkResponse({ description: 'Protected finance projection with the exact recheck case ID.' })
  @ApiBadRequestResponse({
    description: 'The idempotency key, CAS values, or reason are invalid.',
  })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Warehouse recheck request capability is required.' })
  @ApiNotFoundResponse({ description: 'Finance order was not found.' })
  @ApiConflictResponse({ description: 'The coverage snapshot changed concurrently.' })
  requestRecheck(
    @CurrentActor() actor: Actor,
    @Param('financeOrderId') financeOrderId: string,
    @Body() dto: RequestWarehouseCoverageRecheckDto,
  ) {
    return this.rechecks.requestFromFinance(actor, financeOrderId, dto);
  }
}
