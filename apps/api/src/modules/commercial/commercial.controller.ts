import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { CommercialService } from './commercial.service';
import { ProductionService } from '../production/production.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { UpdateOrderCommentDto } from './dto/update-order-comment.dto';
import {
  CreateCorrectionDto,
  ProblemCorrectionDto,
  ProblemCorrectionResponseDto,
} from './dto/correction.dto';
import { InvoiceHandoffDto } from './dto/invoice-handoff.dto';
import { ForceProductionDto } from './dto/force-production.dto';
import {
  MaterialShortageCorrectionDto,
  MaterialShortageCorrectionResponseDto,
} from './dto/material-shortage-correction.dto';
import { MaterialShortageCorrectionService } from './material-shortage-correction.service';
import { CommercialWorkspaceService } from './commercial-workspace.service';
import { CommercialOrderQueryDto } from './dto/commercial-order-query.dto';
import {
  CommercialOrderDetailResponseDto,
  CommercialOrderCommentResponseDto,
  CommercialOrderPageResponseDto,
  WarehouseCoverRequestResponseDto,
  WarehouseCoverProposalResponseDto,
} from './dto/commercial-response.dto';
import { CommercialCoverService } from './commercial-cover.service';
import { CommercialResolutionService } from './commercial-resolution.service';
import {
  WarehouseCoverDecisionDto,
  WarehouseCoverRecheckDto,
  WarehouseCoverTechnicalApprovalDto,
} from './dto/warehouse-cover-decision.dto';
import { FinanceNoteDto } from './dto/finance-note.dto';
import { CommercialFinanceNoteService } from './commercial-finance-note.service';
import {
  CommercialOrderAmendmentDto,
  CommercialOrderAmendmentResponseDto,
  OrderCancellationCommandDto,
  OrderCancellationResponseDto,
} from './dto/order-amendment.dto';
import { CommercialOrderAmendmentService } from './commercial-order-amendment.service';

@ApiTags('commercial')
@ApiBearerAuth('session')
@ApiUnauthorizedResponse({ description: 'A valid Bearer session is required' })
@ApiForbiddenResponse({ description: 'The actor lacks the required capability' })
@Controller('commercial/orders')
export class CommercialController {
  constructor(
    private readonly service: CommercialService,
    private readonly production: ProductionService,
    private readonly materialShortageCorrections: MaterialShortageCorrectionService,
    private readonly workspace: CommercialWorkspaceService,
    private readonly cover: CommercialCoverService,
    private readonly resolutions: CommercialResolutionService,
    private readonly financeNotes: CommercialFinanceNoteService,
    private readonly amendments: CommercialOrderAmendmentService,
  ) {}

  @Get()
  @RequireCapabilities('order:read')
  @ApiOkResponse({ type: CommercialOrderPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid bucket, date range or cursor' })
  list(@CurrentActor() actor: Actor, @Query() query: CommercialOrderQueryDto) {
    return this.workspace.list(actor, query);
  }

  @Get(':orderId')
  @RequireCapabilities('order:read')
  @ApiOkResponse({ type: CommercialOrderDetailResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found or draft is not visible to the actor' })
  get(@CurrentActor() actor: Actor, @Param('orderId') orderId: string) {
    return this.workspace.detail(actor, orderId);
  }

  @Post()
  @RequireCapabilities('order:create')
  @ApiOperation({ summary: 'Create an idempotent commercial order or draft' })
  @ApiCreatedResponse({ description: 'Order created or an idempotent retry returned' })
  @ApiBadRequestResponse({ description: 'Order payload or template snapshot is invalid' })
  @ApiNotFoundResponse({ description: 'Counterparty or selected template was not found' })
  @ApiConflictResponse({ description: 'Order number or request id is already allocated' })
  create(@CurrentActor() actor: Actor, @Body() dto: CreateOrderDto) {
    return this.service.createOrder({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post(':orderId/send-to-production')
  @RequireCapabilities('production_order:handoff')
  @ApiOperation({ summary: 'Create the production delta after finance and cover gates' })
  @ApiCreatedResponse({ description: 'Production order or a no-production result' })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({ description: 'Finance or warehouse-cover facts are not final' })
  sendToProduction(@CurrentActor() actor: Actor, @Param('orderId') orderId: string) {
    return this.production.createFromCommercial(
      { userId: actor.userId, role: actor.role },
      orderId,
    );
  }

  @Patch(':orderId/comment')
  @RequireCapabilities('order:update_position')
  @ApiOperation({ summary: 'Update the general order comment using optimistic concurrency' })
  @ApiOkResponse({ type: CommercialOrderCommentResponseDto })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({ description: 'Comment version is stale' })
  updateOrderComment(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: UpdateOrderCommentDto,
  ) {
    return this.service.updateOrderComment(
      { userId: actor.userId, role: actor.role },
      orderId,
      dto,
    );
  }

  @Patch(':orderId/positions/:positionId')
  @RequireCapabilities('order:update_position')
  @ApiOperation({ summary: 'Update an editable order position using optimistic concurrency' })
  @ApiOkResponse({ description: 'Position updated' })
  @ApiNotFoundResponse({ description: 'Order position was not found' })
  @ApiConflictResponse({ description: 'Position is stale or the commercial order is locked' })
  updatePosition(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Param('positionId') positionId: string,
    @Body() dto: UpdatePositionDto,
  ) {
    return this.service.updatePosition(
      { userId: actor.userId, role: actor.role },
      orderId,
      positionId,
      dto,
    );
  }

  @Patch(':orderId/finance-note')
  @RequireCapabilities('order:update_finance_note')
  @ApiOperation({
    summary: 'Update the free-form accounting note using optimistic concurrency',
  })
  @ApiOkResponse({ description: 'Finance note updated or idempotent replay returned' })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({
    description: 'Order version changed, invoice is already posted or operationKey conflicts',
  })
  updateFinanceNote(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: FinanceNoteDto,
  ) {
    return this.financeNotes.update({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post(':orderId/amendments')
  @RequireCapabilities('order:amend')
  @ApiOperation({ summary: 'Amend the desired order specification after invoice handoff' })
  @ApiCreatedResponse({ type: CommercialOrderAmendmentResponseDto })
  @ApiNotFoundResponse({ description: 'Commercial order or position was not found' })
  @ApiConflictResponse({
    description: 'Operation key, order version, position version or reconciliation conflicts',
  })
  amend(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: CommercialOrderAmendmentDto,
  ) {
    return this.amendments.apply({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post(':orderId/unfinished-rolls/cancel')
  @RequireCapabilities('override:production')
  @ApiOperation({
    summary: 'Cancel every unfinished production roll while retaining completed work',
  })
  @ApiCreatedResponse({ type: CommercialOrderAmendmentResponseDto })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({ description: 'Order version or reconciliation state changed' })
  cancelUnfinished(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: OrderCancellationCommandDto,
  ) {
    return this.amendments.cancelUnfinished(
      { userId: actor.userId, role: actor.role },
      orderId,
      dto,
    );
  }

  @Post(':orderId/cancellations')
  @RequireCapabilities('order:cancel')
  @ApiOperation({ summary: 'Cancel unfinished work while retaining physical facts' })
  @ApiCreatedResponse({ type: OrderCancellationResponseDto })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({
    description: 'Operation key, order version or reconciliation conflicts',
  })
  cancel(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: OrderCancellationCommandDto,
  ) {
    return this.amendments.cancel({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Delete(':orderId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireCapabilities('order:cancel')
  @ApiOperation({ summary: 'Permanently delete an order at any lifecycle stage' })
  @ApiNoContentResponse({ description: 'Order permanently deleted' })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  delete(@CurrentActor() actor: Actor, @Param('orderId') orderId: string) {
    return this.service.deleteOrder({ userId: actor.userId, role: actor.role }, orderId);
  }

  @Post(':orderId/warehouse-cover/recheck')
  @RequireCapabilities('warehouse_cover:request')
  @ApiOperation({ summary: 'Request a fresh warehouse-cover calculation' })
  @ApiCreatedResponse({
    description: 'Recheck requested or an idempotent retry returned',
    type: WarehouseCoverRequestResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({ description: 'This manual recheck route is available only for V1' })
  requestCoverCheck(@CurrentActor() actor: Actor, @Param('orderId') orderId: string) {
    return this.service.requestCoverCheck({ userId: actor.userId, role: actor.role }, orderId);
  }

  @Post(':orderId/positions/:positionId/warehouse-cover/:proposalId/commercial-approval')
  @RequireCapabilities('warehouse_cover:confirm')
  @ApiOperation({ summary: 'Approve a warehouse-cover route as commercial' })
  @ApiCreatedResponse({ type: WarehouseCoverProposalResponseDto })
  @ApiBadRequestResponse({ description: 'Route and compatible matched quantity disagree' })
  @ApiNotFoundResponse({ description: 'Proposal was not found for this order position' })
  @ApiConflictResponse({
    description: 'V1-only proposal is stale, changed or already approved otherwise',
  })
  approveWarehouseCover(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Param('positionId') positionId: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: WarehouseCoverDecisionDto,
  ) {
    return this.cover.approveCommercial(
      { userId: actor.userId, role: actor.role },
      orderId,
      positionId,
      proposalId,
      dto,
    );
  }

  @Post(':orderId/positions/:positionId/warehouse-cover/:proposalId/technical-approval')
  @RequireCapabilities('warehouse_cover:technical_approve')
  @ApiOperation({ summary: 'Technically approve and atomically reserve matched warehouse rolls' })
  @ApiCreatedResponse({ type: WarehouseCoverProposalResponseDto })
  @ApiBadRequestResponse({ description: 'Production-only routes need no technical approval' })
  @ApiNotFoundResponse({ description: 'Proposal was not found for this order position' })
  @ApiConflictResponse({
    description: 'V1-only proposal lacks approval, is stale or lost a roll race',
  })
  approveWarehouseCoverTechnically(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Param('positionId') positionId: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: WarehouseCoverTechnicalApprovalDto,
  ) {
    return this.cover.finalizeTechnicalApproval(
      { userId: actor.userId, role: actor.role },
      orderId,
      positionId,
      proposalId,
      dto,
    );
  }

  @Post(':orderId/positions/:positionId/warehouse-cover/:proposalId/recheck')
  @RequireCapabilities('warehouse_cover:request')
  @ApiOperation({ summary: 'Reject a proposal version and request recalculation' })
  @ApiCreatedResponse({ type: WarehouseCoverProposalResponseDto })
  @ApiNotFoundResponse({ description: 'Proposal was not found for this order position' })
  @ApiConflictResponse({ description: 'V1-only proposal is stale or already reserved' })
  requestPositionCoverRecheck(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Param('positionId') positionId: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: WarehouseCoverRecheckDto,
  ) {
    return this.cover.requestRecheck(
      { userId: actor.userId, role: actor.role },
      orderId,
      positionId,
      proposalId,
      dto,
    );
  }

  @Post(':orderId/force-production')
  @RequireCapabilities('warehouse_cover:override')
  @ApiOperation({ summary: 'Override warehouse cover and force production with an audited reason' })
  @ApiCreatedResponse({ description: 'Production override recorded' })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({
    description: 'V1-only override was used for V2 or the order is already in production',
  })
  forceProduction(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: ForceProductionDto,
  ) {
    return this.service.forceProduction({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post(':orderId/promote-draft')
  @RequireCapabilities('order:create')
  @ApiOperation({ summary: 'Promote an editable draft into the incoming queue' })
  @ApiCreatedResponse({ description: 'Draft promoted or idempotent retry returned' })
  @ApiNotFoundResponse({ description: 'Draft was not found' })
  @ApiConflictResponse({ description: 'Draft is locked or already has finance facts' })
  promoteDraft(@CurrentActor() actor: Actor, @Param('orderId') orderId: string) {
    return this.service.promoteDraft({ userId: actor.userId, role: actor.role }, orderId);
  }

  @Post(':orderId/corrections')
  @RequireCapabilities('correction:create')
  @ApiOperation({ summary: 'Apply a legacy audited recipe correction' })
  @ApiCreatedResponse({ description: 'Correction applied' })
  @ApiNotFoundResponse({ description: 'Order position or recipe was not found' })
  @ApiConflictResponse({ description: 'Order or target roll can no longer be corrected' })
  correction(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: CreateCorrectionDto,
  ) {
    return this.service.applyCorrection({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post(':orderId/problems/:problemId/correction')
  @RequireCapabilities('correction:create')
  @ApiOperation({ summary: 'Apply an immutable recipe correction scoped to a production problem' })
  @ApiCreatedResponse({ type: ProblemCorrectionResponseDto })
  @ApiBadRequestResponse({ description: 'Correction payload is invalid' })
  @ApiForbiddenResponse({ description: 'The actor cannot create commercial corrections' })
  @ApiNotFoundResponse({ description: 'Order, position, recipe or roll was not found' })
  @ApiConflictResponse({
    description: 'Problem is closed, recipe is stale, roll is consumed or correction raced',
  })
  problemCorrection(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Param('problemId') problemId: string,
    @Body() dto: ProblemCorrectionDto,
  ) {
    return this.resolutions.apply(
      { userId: actor.userId, role: actor.role },
      orderId,
      problemId,
      dto,
    );
  }

  @Post(':orderId/material-shortage-corrections')
  @RequireCapabilities('correction:create')
  @ApiOperation({ summary: 'Apply a correction scoped to an open material shortage' })
  @ApiCreatedResponse({
    description: 'Shortage resolved and future roll snapshots updated',
    type: MaterialShortageCorrectionResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Correction payload is invalid' })
  @ApiForbiddenResponse({ description: 'The actor cannot create commercial corrections' })
  @ApiNotFoundResponse({ description: 'The position, recipe or roll was not found' })
  @ApiConflictResponse({ description: 'Problem/roll mismatch, consumed material or race' })
  materialShortageCorrection(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: MaterialShortageCorrectionDto,
  ) {
    return this.materialShortageCorrections.apply(
      { userId: actor.userId, role: actor.role },
      orderId,
      dto,
    );
  }

  @Post(':orderId/invoice-handoff')
  @RequireCapabilities('invoice:handoff')
  @ApiOperation({ summary: 'Create the nullable finance handoff exactly once' })
  @ApiCreatedResponse({ description: 'Finance handoff created or idempotent retry returned' })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({
    description: 'V2 specification is incomplete, order is locked or retry payload differs',
  })
  invoiceHandoff(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: InvoiceHandoffDto,
  ) {
    return this.service.invoiceHandoff({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Post(':orderId/submit-to-finance')
  @RequireCapabilities('invoice:handoff')
  @ApiOperation({ summary: 'Compatibility alias for invoice handoff' })
  @ApiCreatedResponse({ description: 'Finance handoff created or idempotent retry returned' })
  @ApiNotFoundResponse({ description: 'Commercial order was not found' })
  @ApiConflictResponse({
    description: 'V2 specification is incomplete, order is locked or retry payload differs',
  })
  submitToFinance(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: InvoiceHandoffDto,
  ) {
    return this.service.invoiceHandoff({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Get(':orderId/audit')
  @RequireCapabilities('audit:read')
  @ApiOperation({ summary: 'Read append-only events for a commercial order' })
  @ApiOkResponse({ description: 'Chronological append-only domain events' })
  audit(@Param('orderId') orderId: string) {
    return this.service.getAudit(orderId);
  }
}
