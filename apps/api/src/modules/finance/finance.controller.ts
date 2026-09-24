import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
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
import { RequireOneCRuntime } from '../../common/auth/require-onec-runtime.decorator';
import { RoleInboxQueryDto } from '../../common/role-inbox/dto/role-inbox-query.dto';
import {
  RoleInboxPageResponseDto,
  RoleInboxReadResponseDto,
} from '../../common/role-inbox/dto/role-inbox-response.dto';
import { RoleInboxProjectionService } from '../../common/role-inbox/role-inbox.service';
import { FinanceService } from './finance.service';
import { CreateInvoiceDto } from './dto/invoice.dto';
import { PaymentUpdateDto } from './dto/payment-update.dto';
import { PaymentOperationDto } from './dto/payment-operation.dto';
import { FinanceProblemDto } from './dto/problem.dto';
import { SetPaymentTermsDto } from './dto/payment-terms.dto';
import { SourceRetryDto } from './dto/source-retry.dto';
import {
  PaymentPolicyPreviewDto,
  PreviewPaymentPolicyDto,
  UpdatePaymentPolicyDto,
} from './dto/payment-policy.dto';
import { InvoiceLinkDto } from './dto/invoice-link.dto';
import { OneCInvoiceSyncService } from './onec-invoice-sync.service';
import { PaymentSourceSyncDto } from './dto/payment-source-sync.dto';
import { PaymentAllocationResolveDto } from './dto/payment-allocation-resolve.dto';
import { OneCPaymentSyncService } from './onec-payment-sync.service';
import { PaymentAllocationService } from './payment-allocation.service';
import { PaymentCorrectionDto, PaymentCorrectionResponseDto } from './dto/payment-correction.dto';
import { PaymentCorrectionService } from './payment-correction.service';
import { ScheduleConfirmationDto } from './dto/schedule-confirmation.dto';
import { FinanceOrderQueryDto, FinanceOverviewQueryDto } from './dto/finance-query.dto';

@ApiTags('finance')
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly service: FinanceService,
    private readonly inbox: RoleInboxProjectionService,
    private readonly invoiceSync: OneCInvoiceSyncService,
    private readonly paymentSync: OneCPaymentSyncService,
    private readonly paymentAllocation: PaymentAllocationService,
    private readonly paymentCorrections: PaymentCorrectionService,
  ) {}

  @Get('notifications')
  @RequireCapabilities('finance_order:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Finance notification capability is required' })
  notifications(@CurrentActor() actor: Actor, @Query() query: RoleInboxQueryDto) {
    return this.inbox.list(actor, 'finance', query);
  }

  @Put('notifications/:eventId/read')
  @RequireCapabilities('finance_order:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxReadResponseDto })
  @ApiBadRequestResponse({ description: 'Event id is invalid' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Finance notification capability is required' })
  @ApiNotFoundResponse({ description: 'Event is not a finance notification' })
  markNotificationRead(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.inbox.markRead(actor, 'finance', eventId);
  }

  @Get('orders')
  @RequireCapabilities('finance_order:read')
  @ApiBadRequestResponse({ description: 'Unsupported finance order bucket' })
  @ApiUnprocessableEntityResponse({ description: 'Finance order catalog exceeds safe bounds' })
  list(@CurrentActor() actor: Actor, @Query() query: FinanceOrderQueryDto) {
    return this.service.listOrders(actor, query.bucket);
  }

  @Get('overview')
  @ApiOkResponse({ description: 'Finance overview read model.' })
  @ApiBadRequestResponse({ description: 'Date must be a real YYYY-MM-DD calendar date' })
  @ApiUnprocessableEntityResponse({ description: 'Finance overview exceeds safe bounds' })
  @RequireCapabilities('finance_order:read')
  overview(@CurrentActor() actor: Actor, @Query() query: FinanceOverviewQueryDto) {
    return this.service.getOverview(actor, query.date);
  }

  @Get('orders/:orderId')
  @RequireCapabilities('finance_order:read')
  @ApiUnprocessableEntityResponse({ description: 'Finance order detail exceeds safe bounds' })
  get(@CurrentActor() actor: Actor, @Param('orderId') orderId: string) {
    return this.service.getOrder(actor, orderId);
  }

  @Post('orders/:orderId/invoices')
  @RequireCapabilities('invoice:create')
  invoice(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.service.createInvoice({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Put('orders/:orderId/invoice-link')
  @RequireOneCRuntime()
  @RequireCapabilities('invoice:create')
  @ApiBearerAuth('session')
  @ApiOkResponse({ description: 'Exact 1С invoice match and its safe business projection.' })
  @ApiBadRequestResponse({ description: 'Specify exactly one invoice identifier and a reason.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Invoice management capability is required.' })
  @ApiNotFoundResponse({ description: 'Finance order or exact 1С invoice was not found.' })
  invoiceLink(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: InvoiceLinkDto,
  ) {
    return this.invoiceSync.link({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post('orders/:orderId/payment-policy/preview')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('installment_plan:manage')
  @ApiBearerAuth('session')
  @ApiOkResponse({
    type: PaymentPolicyPreviewDto,
    description: 'Calculated payment rows with actual dates or trigger conditions.',
  })
  @ApiBadRequestResponse({ description: 'The payment policy or invoice amount is invalid.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Installment plan management capability is required.' })
  @ApiNotFoundResponse({ description: 'Finance order was not found.' })
  previewPaymentPolicy(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: PreviewPaymentPolicyDto,
  ) {
    return this.service.previewPaymentPolicy(
      { userId: actor.userId, role: actor.role },
      orderId,
      dto,
    );
  }

  @Put('orders/:orderId/payment-policy')
  @RequireCapabilities('installment_plan:manage')
  @ApiBearerAuth('session')
  @ApiOkResponse({ description: 'Refreshed finance order after payment policy replacement.' })
  @ApiBadRequestResponse({ description: 'The policy or replacement reason is invalid.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Installment plan management capability is required.' })
  @ApiNotFoundResponse({ description: 'Finance order was not found.' })
  setPaymentPolicy(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: UpdatePaymentPolicyDto,
  ) {
    return this.service.setPaymentPolicy({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Put('orders/:orderId/payment-terms')
  @RequireCapabilities('installment_plan:manage')
  setPaymentTerms(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: SetPaymentTermsDto,
  ) {
    return this.service.setPaymentTerms({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post('orders/:orderId/payment-schedules/:scheduleId/confirm')
  @RequireCapabilities('payment:update')
  confirmSchedule(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Param('scheduleId') scheduleId: string,
    @Body() dto?: ScheduleConfirmationDto,
  ) {
    return this.service.confirmSchedule(
      { userId: actor.userId, role: actor.role },
      orderId,
      scheduleId,
      dto?.operationKey,
    );
  }

  @Post('orders/:orderId/payment-updates')
  @RequireCapabilities('payment:update')
  paymentUpdate(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: PaymentUpdateDto,
  ) {
    return this.service.updatePayment({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post('orders/:orderId/payment-corrections')
  @RequireCapabilities('payment:correct')
  @ApiBearerAuth('session')
  @ApiCreatedResponse({ type: PaymentCorrectionResponseDto })
  @ApiBadRequestResponse({ description: 'The target, reason or operation key is invalid.' })
  @ApiNotFoundResponse({ description: 'Finance order or target payment fact was not found.' })
  @ApiConflictResponse({
    description: 'The target is stale, already corrected, or must be corrected in 1C.',
  })
  correctPayment(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: PaymentCorrectionDto,
  ) {
    return this.paymentCorrections.correct(
      { userId: actor.userId, role: actor.role },
      orderId,
      dto,
    );
  }

  @Post('orders/:orderId/payment-operations')
  @RequireCapabilities('payment_operation:create')
  async paymentOperation(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: PaymentOperationDto,
  ) {
    await this.service.recordOperation({ userId: actor.userId, role: actor.role }, orderId, dto);
    return this.service.getOrder(actor, orderId);
  }

  @Post('orders/:orderId/source-retry')
  @RequireOneCRuntime()
  @RequireCapabilities('source:retry')
  @ApiBearerAuth('session')
  sourceRetry(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: SourceRetryDto,
  ) {
    return this.invoiceSync.refresh({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post('payment-source-sync')
  @RequireOneCRuntime()
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('source:retry')
  @ApiBearerAuth('session')
  @ApiOkResponse({ description: 'Safe summary of imported 1С incoming bank receipts.' })
  @ApiBadRequestResponse({ description: 'The operation key is invalid.' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Source retry capability is required.' })
  paymentSourceSync(@CurrentActor() actor: Actor, @Body() dto: PaymentSourceSyncDto) {
    return this.paymentSync.sync({ userId: actor.userId, role: actor.role }, dto);
  }

  @Get('reconciliation')
  @RequireCapabilities('admin:diagnostics')
  @ApiBearerAuth('session')
  @ApiOkResponse({ description: 'Unresolved or exceptional payment receipt reconciliation rows.' })
  @ApiForbiddenResponse({ description: 'Administrative diagnostics capability is required.' })
  reconciliation() {
    return this.paymentAllocation.reconciliation();
  }

  @Post('payment-allocations/:allocationId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('payment:update')
  @ApiBearerAuth('session')
  @ApiOkResponse({ description: 'Append-only manual payment allocation result.' })
  @ApiBadRequestResponse({
    description: 'Allocation targets, reason or operation key are invalid.',
  })
  @ApiUnauthorizedResponse({ description: 'A real user session is required.' })
  @ApiForbiddenResponse({ description: 'Payment update capability is required.' })
  @ApiNotFoundResponse({ description: 'The reconciliation receipt was not found.' })
  resolvePaymentAllocation(
    @CurrentActor() actor: Actor,
    @Param('allocationId') allocationId: string,
    @Body() dto: PaymentAllocationResolveDto,
  ) {
    return this.paymentAllocation.resolve(
      { userId: actor.userId, role: actor.role },
      allocationId,
      dto,
    );
  }

  @Post('orders/:orderId/problems')
  @RequireCapabilities('problem:create')
  problem(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: FinanceProblemDto,
  ) {
    return this.service.reportProblem({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Get('source-snapshots/:snapshotId')
  @RequireCapabilities('finance_order:read')
  snapshot(@Param('snapshotId') snapshotId: string) {
    return this.service.getSourceSnapshot(snapshotId);
  }

  @Get('orders/:orderId/audit')
  @RequireCapabilities('finance_order:read')
  audit(@Param('orderId') orderId: string) {
    return this.service.getAudit(orderId);
  }
}
