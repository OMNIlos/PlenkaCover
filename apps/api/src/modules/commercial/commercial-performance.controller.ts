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
  CommercialPerformanceControlQueryDto,
  CommercialPerformanceControlResponseDto,
  CommercialPerformanceFinancePageResponseDto,
  CommercialPerformancePageQueryDto,
  CommercialPerformanceProductionPageResponseDto,
  BusinessPerformanceRollPageResponseDto,
  BusinessOperationalProblemPageResponseDto,
  BusinessOperationalProblemResponseDto,
} from './dto/commercial-performance.dto';
import { CommercialProblemQueryDto as BusinessOperationalProblemQueryDto } from './dto/commercial-problem-query.dto';
import { CommercialPerformanceRollQueryDto } from './dto/commercial-performance-roll-query.dto';
import {
  DirectorAnalyticsBigBagEvidenceQueryDto,
  DirectorAnalyticsShiftEvidenceQueryDto,
} from '../director/dto/analytics-query.dto';
import {
  DirectorAnalyticsBigBagEvidencePageResponseDto,
  DirectorAnalyticsShiftEvidencePageResponseDto,
} from '../director/dto/analytics-response.dto';
import { BusinessOperationalProblemService } from './business-operational-problem.service';
import { CommercialPerformanceService } from './commercial-performance.service';
import {
  WarehouseBusinessPageResponseDto,
  WarehouseBusinessQueryDto,
} from '../../common/business-projections/dto/warehouse-business.dto';
import { WarehouseBusinessProjectionService } from '../../common/business-projections/warehouse-business-projection.service';

@ApiTags('commercial-performance')
@ApiBearerAuth('session')
@Controller('commercial/performance')
export class CommercialPerformanceController {
  constructor(
    private readonly service: CommercialPerformanceService,
    private readonly operationalProblems: BusinessOperationalProblemService,
    private readonly warehouseBusiness: WarehouseBusinessProjectionService,
  ) {}

  @Get('control')
  @RequireCapabilities('business_performance:read')
  @ApiOkResponse({ type: CommercialPerformanceControlResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid date range or bucket.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  control(@Query() query: CommercialPerformanceControlQueryDto) {
    return this.service.getControl(query);
  }

  @Get('control/shift-balances')
  @RequireCapabilities('business_performance:read')
  @ApiOkResponse({ type: DirectorAnalyticsShiftEvidencePageResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid date range, shift-balance filter, cursor, or page limit.',
  })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  controlShiftBalances(@Query() query: DirectorAnalyticsShiftEvidenceQueryDto) {
    return this.service.getControlShiftBalanceEvidence(query);
  }

  @Get('control/big-bags')
  @RequireCapabilities('business_performance:read')
  @ApiOkResponse({ type: DirectorAnalyticsBigBagEvidencePageResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid date range, BigBag filter, cursor, or page limit.',
  })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  controlBigBags(@Query() query: DirectorAnalyticsBigBagEvidenceQueryDto) {
    return this.service.getControlBigBagEvidence(query);
  }

  @Get('finance')
  @RequireCapabilities('business_performance:read')
  @ApiOkResponse({ type: CommercialPerformanceFinancePageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid date range, cursor, or page limit.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  finance(@Query() query: CommercialPerformancePageQueryDto) {
    return this.service.listFinance(query);
  }

  @Get('production')
  @RequireCapabilities('business_performance:read')
  @ApiOkResponse({ type: CommercialPerformanceProductionPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid date range, cursor, or page limit.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  production(@Query() query: CommercialPerformancePageQueryDto) {
    return this.service.listProduction(query);
  }

  @Get('production/:productionOrderId/rolls')
  @RequireCapabilities('business_performance:read', 'production_cost:read')
  @ApiOkResponse({ type: BusinessPerformanceRollPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  productionRolls(
    @Param('productionOrderId') productionOrderId: string,
    @Query() query: CommercialPerformanceRollQueryDto,
  ) {
    return this.service.listProductionRolls(productionOrderId, query);
  }

  @Get('warehouse')
  @RequireCapabilities('business_performance:read')
  @ApiOkResponse({ type: WarehouseBusinessPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid page or page size.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  warehouse(@Query() query: WarehouseBusinessQueryDto) {
    return this.warehouseBusiness.list(query);
  }

  @Get('problems')
  @RequireCapabilities('business_performance:read')
  @ApiOkResponse({ type: BusinessOperationalProblemPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid filter, cursor, or page limit.' })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  problems(@Query() query: BusinessOperationalProblemQueryDto) {
    return this.operationalProblems.listProblems(query);
  }

  @Get('problems/:problemId')
  @RequireCapabilities('business_performance:read')
  @ApiOkResponse({ type: BusinessOperationalProblemResponseDto })
  @ApiUnauthorizedResponse({ description: 'A valid Bearer session is required.' })
  @ApiForbiddenResponse({ description: 'Safe business performance access is required.' })
  @ApiNotFoundResponse({ description: 'The production problem does not exist.' })
  problem(@Param('problemId') problemId: string) {
    return this.operationalProblems.getProblem(problemId);
  }
}
