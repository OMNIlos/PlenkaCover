import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { PayrollTariffOrderExceptionFilter } from '../../common/payroll-tariffs/payroll-tariff-order-exception.filter';
import { PayrollTariffOrderService } from '../../common/payroll-tariffs/payroll-tariff-order.service';
import {
  CreatePayrollTariffOrderDto,
  PayrollTariffOrderErrorResponseDto,
  PayrollTariffOrderListResponseDto,
  PayrollTariffOrderResultResponseDto,
  PayrollTariffOrderReviewResponseDto,
  PayrollTariffOrderViewResponseDto,
  PublishPayrollTariffOrderDto,
  ReviewPayrollTariffOrderDto,
  UpdatePayrollTariffOrderDto,
} from './dto/payroll-tariff-order.dto';

@ApiTags('director payroll tariff orders')
@Controller('director/payroll-tariff-orders')
@UseFilters(PayrollTariffOrderExceptionFilter)
export class DirectorPayrollTariffOrdersController {
  constructor(private readonly service: PayrollTariffOrderService) {}

  @Get('')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: PayrollTariffOrderListResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director read capability is required' })
  @ApiInternalServerErrorResponse({ type: PayrollTariffOrderErrorResponseDto })
  list() {
    return this.service.list();
  }

  @Get(':id')
  @RequireCapabilities('director:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: PayrollTariffOrderViewResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Director read capability is required' })
  @ApiNotFoundResponse({ type: PayrollTariffOrderErrorResponseDto })
  @ApiInternalServerErrorResponse({ type: PayrollTariffOrderErrorResponseDto })
  detail(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post('')
  @RequireCapabilities('payroll_tariff:manage')
  @ApiBearerAuth('session')
  @ApiCreatedResponse({ type: PayrollTariffOrderResultResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Payroll tariff management capability is required' })
  @ApiConflictResponse({ type: PayrollTariffOrderErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: PayrollTariffOrderErrorResponseDto })
  create(@CurrentActor() actor: Actor, @Body() dto: CreatePayrollTariffOrderDto) {
    return this.service.create(actor, dto);
  }

  @Patch(':id')
  @RequireCapabilities('payroll_tariff:manage')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: PayrollTariffOrderResultResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Payroll tariff management capability is required' })
  @ApiNotFoundResponse({ type: PayrollTariffOrderErrorResponseDto })
  @ApiConflictResponse({ type: PayrollTariffOrderErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: PayrollTariffOrderErrorResponseDto })
  update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: UpdatePayrollTariffOrderDto,
  ) {
    return this.service.update(actor, id, dto);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('payroll_tariff:manage')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: PayrollTariffOrderReviewResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Payroll tariff management capability is required' })
  @ApiNotFoundResponse({ type: PayrollTariffOrderErrorResponseDto })
  @ApiConflictResponse({ type: PayrollTariffOrderErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: PayrollTariffOrderErrorResponseDto })
  review(@Param('id') id: string, @Body() dto: ReviewPayrollTariffOrderDto) {
    return this.service.review(id, dto);
  }

  @Post(':id/publish')
  @RequireCapabilities('payroll_tariff:manage')
  @ApiBearerAuth('session')
  @ApiCreatedResponse({ type: PayrollTariffOrderResultResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Payroll tariff management capability is required' })
  @ApiNotFoundResponse({ type: PayrollTariffOrderErrorResponseDto })
  @ApiConflictResponse({ type: PayrollTariffOrderErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: PayrollTariffOrderErrorResponseDto })
  publish(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: PublishPayrollTariffOrderDto,
  ) {
    return this.service.publish(actor, id, dto);
  }
}
