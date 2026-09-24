import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RoleInboxQueryDto } from '../../common/role-inbox/dto/role-inbox-query.dto';
import {
  RoleInboxPageResponseDto,
  RoleInboxReadResponseDto,
} from '../../common/role-inbox/dto/role-inbox-response.dto';
import { RoleInboxProjectionService } from '../../common/role-inbox/role-inbox.service';
import { DirectorAnalyticsService } from './director-analytics.service';
import { DirectorService } from './director.service';
import {
  DirectorAnalyticsBigBagEvidenceQueryDto,
  DirectorAnalyticsQueryDto,
  DirectorAnalyticsShiftEvidenceQueryDto,
  DirectorOperatorRollVarianceQueryDto,
} from './dto/analytics-query.dto';
import {
  DirectorAnalyticsBigBagEvidencePageResponseDto,
  DirectorAnalyticsResponseDto,
  DirectorAnalyticsShiftEvidencePageResponseDto,
  DirectorOperatorRollVariancePageResponseDto,
} from './dto/analytics-response.dto';
import { FinanceOverrideDto, OverrideDto, ProductionOverrideDto } from './dto/override.dto';
import { CreatePenaltyDto } from './dto/penalty.dto';
import { ResolveDecisionDto } from './dto/decision.dto';
import { DirectorDecisionQueryDto } from './dto/director-decision-query.dto';
import {
  TraceabilityContextParamsDto,
  TraceabilityContextResponseDto,
  TraceabilitySearchPageResponseDto,
  TraceabilitySearchQueryDto,
} from './dto/traceability.dto';
import { DirectorTraceabilityService } from './director-traceability.service';
import {
  WarehouseBusinessPageResponseDto,
  WarehouseBusinessQueryDto,
} from '../../common/business-projections/dto/warehouse-business.dto';
import { WarehouseBusinessProjectionService } from '../../common/business-projections/warehouse-business-projection.service';
import { ProductionService } from '../production/production.service';
import { ProductionProblemResponseDto } from '../production/dto/production-problem-response.dto';

@ApiTags('director')
@Controller('director')
export class DirectorController {
  constructor(
    private readonly service: DirectorService,
    private readonly inbox: RoleInboxProjectionService,
    private readonly analyticsService: DirectorAnalyticsService,
    private readonly traceabilityService: DirectorTraceabilityService,
    private readonly warehouseBusiness: WarehouseBusinessProjectionService,
    private readonly productionService: ProductionService,
  ) {}

  @Get('analytics')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: DirectorAnalyticsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid analytics date range or bucket' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director analytics capability is required' })
  analytics(@Query() query: DirectorAnalyticsQueryDto) {
    return this.analyticsService.getAnalytics(query);
  }

  @Get('analytics/shift-balances')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: DirectorAnalyticsShiftEvidencePageResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid analytics date range, evidence filter, cursor, or limit',
  })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director analytics capability is required' })
  shiftBalanceEvidence(@Query() query: DirectorAnalyticsShiftEvidenceQueryDto) {
    return this.analyticsService.getShiftBalanceEvidence(query);
  }

  @Get('analytics/big-bags')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: DirectorAnalyticsBigBagEvidencePageResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid analytics date range, evidence filter, cursor, or limit',
  })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director analytics capability is required' })
  bigBagEvidence(@Query() query: DirectorAnalyticsBigBagEvidenceQueryDto) {
    return this.analyticsService.getBigBagEvidence(query);
  }

  @Get('analytics/operator-rolls')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: DirectorOperatorRollVariancePageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid analytics date range, cursor, or limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director analytics capability is required' })
  operatorRolls(@Query() query: DirectorOperatorRollVarianceQueryDto) {
    return this.analyticsService.getOperatorRollVariances(query);
  }

  @Get('traceability/search')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: TraceabilitySearchPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid traceability query, cursor, or limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director traceability capability is required' })
  traceabilitySearch(@Query() query: TraceabilitySearchQueryDto) {
    return this.traceabilityService.search(query);
  }

  @Get('traceability/:objectType/:objectId')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: TraceabilityContextResponseDto })
  @ApiBadRequestResponse({ description: 'Unsupported traceability object type or identifier' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director traceability capability is required' })
  @ApiNotFoundResponse({ description: 'Traceability object was not found' })
  traceabilityContext(@Param() params: TraceabilityContextParamsDto) {
    return this.traceabilityService.getContext(params.objectType, params.objectId);
  }

  @Get('notifications')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director notification capability is required' })
  notifications(@CurrentActor() actor: Actor, @Query() query: RoleInboxQueryDto) {
    return this.inbox.list(actor, 'director', query);
  }

  @Put('notifications/:eventId/read')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxReadResponseDto })
  @ApiBadRequestResponse({ description: 'Event id is invalid' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director notification capability is required' })
  @ApiNotFoundResponse({ description: 'Event is not a director notification' })
  markNotificationRead(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.inbox.markRead(actor, 'director', eventId);
  }

  @Get('control')
  @RequireCapabilities('director:read')
  control() {
    return this.service.getControl();
  }

  @Get('problems')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: ProductionProblemResponseDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director read capability is required' })
  @ApiUnprocessableEntityResponse({
    description: 'The bounded production problem list is too large.',
  })
  problems() {
    return this.productionService.listProblems();
  }

  @Get('decisions')
  @RequireCapabilities('director:read')
  @ApiBadRequestResponse({ description: 'Unsupported decision scope or status.' })
  @ApiUnprocessableEntityResponse({ description: 'The bounded decision queue is too large.' })
  decisions(@Query() query: DirectorDecisionQueryDto) {
    return this.service.listDecisions(query);
  }

  @Post('decisions/:decisionId/approve')
  @RequireCapabilities('decision:approve')
  approve(@CurrentActor() actor: Actor, @Param('decisionId') decisionId: string) {
    return this.service.approveDecision({ userId: actor.userId, role: actor.role }, decisionId);
  }

  @Post('decisions/:decisionId/return')
  @RequireCapabilities('decision:approve')
  return(
    @CurrentActor() actor: Actor,
    @Param('decisionId') decisionId: string,
    @Body() dto: ResolveDecisionDto,
  ) {
    return this.service.returnDecision({ userId: actor.userId, role: actor.role }, decisionId, dto);
  }

  @Get('finance')
  @RequireCapabilities('director:read')
  @ApiUnprocessableEntityResponse({ description: 'The bounded director list is too large.' })
  financeList(@CurrentActor() actor: Actor) {
    return this.service.listFinance(actor.role);
  }

  @Get('production')
  @RequireCapabilities('director:read')
  @ApiUnprocessableEntityResponse({ description: 'The bounded director list is too large.' })
  productionList(@CurrentActor() actor: Actor) {
    return this.service.listProduction(actor.role);
  }

  @Get('warehouse')
  @RequireCapabilities('director:read')
  @ApiUnprocessableEntityResponse({ description: 'The bounded director list is too large.' })
  warehouseList() {
    return this.service.listWarehouse();
  }

  @Get('performance/warehouse')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: WarehouseBusinessPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid page or page size.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Director read capability is required.' })
  performanceWarehouse(@Query() query: WarehouseBusinessQueryDto) {
    return this.warehouseBusiness.list(query);
  }

  @Get('finance/:objectId')
  @RequireCapabilities('director:read')
  finance(@CurrentActor() actor: Actor, @Param('objectId') objectId: string) {
    return this.service.getFinance(actor.role, objectId);
  }

  @Post('finance/:objectId/override')
  @RequireCapabilities('override:finance')
  overrideFinance(
    @CurrentActor() actor: Actor,
    @Param('objectId') objectId: string,
    @Body() dto: FinanceOverrideDto,
  ) {
    return this.service.overrideFinance({ userId: actor.userId, role: actor.role }, objectId, dto);
  }

  @Get('production/:objectId')
  @RequireCapabilities('director:read')
  @ApiUnprocessableEntityResponse({ description: 'The production drilldown is too large.' })
  production(@Param('objectId') objectId: string) {
    return this.service.getProduction(objectId);
  }

  @Post('production/:objectId/override')
  @RequireCapabilities('override:production')
  overrideProduction(
    @CurrentActor() actor: Actor,
    @Param('objectId') objectId: string,
    @Body() dto: ProductionOverrideDto,
  ) {
    return this.service.overrideProduction(
      { userId: actor.userId, role: actor.role },
      objectId,
      dto,
    );
  }

  @Post('warehouse/:objectId/override')
  @RequireCapabilities('override:warehouse')
  overrideWarehouse(
    @CurrentActor() actor: Actor,
    @Param('objectId') objectId: string,
    @Body() dto: OverrideDto,
  ) {
    return this.service.overrideWarehouse(
      { userId: actor.userId, role: actor.role },
      objectId,
      dto,
    );
  }

  @Get('penalties/summary')
  @RequireCapabilities('director:read')
  penaltiesSummary() {
    return this.service.penaltiesSummary();
  }

  @Get('penalties')
  @RequireCapabilities('director:read')
  penalties() {
    return this.service.listPenalties();
  }

  @Get('penalty-targets')
  @RequireCapabilities('director:read')
  penaltyTargets() {
    return this.service.listPenaltyTargets();
  }

  @Get('penalties/operators/:operatorId')
  @RequireCapabilities('director:read')
  penaltiesForOperator(@Param('operatorId') operatorId: string) {
    return this.service.penaltiesForOperator(operatorId);
  }

  @Post('penalties')
  @RequireCapabilities('penalty:create')
  createPenalty(@CurrentActor() actor: Actor, @Body() dto: CreatePenaltyDto) {
    return this.service.createPenalty({ userId: actor.userId, role: actor.role }, dto);
  }

  @Get('audit')
  @RequireCapabilities('audit:read')
  audit(@Query('objectId') objectId: string) {
    return this.service.getAudit(objectId);
  }
}
