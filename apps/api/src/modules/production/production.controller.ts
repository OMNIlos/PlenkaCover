import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
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
import { ProductionService } from './production.service';
import { ProductionShiftCommandService } from './production-shift-command.service';
import { AssignRollDto } from './dto/assign.dto';
import { BulkAssignDto } from './dto/bulk-assign.dto';
import { SetPriorityDto } from './dto/priority.dto';
import { AssignMachineDto } from './dto/machine.dto';
import {
  CompleteMachineRepairDto,
  MarkRollDefectDto,
  ReportMachineBreakdownDto,
  ReportProblemDto,
  ResolveProblemDto,
} from './dto/problem.dto';
import { CreateProductionOrderDto } from './dto/create-production-order.dto';
import { CreateIndividualShiftDto, CreateShiftDto } from './dto/shift.dto';
import {
  CancelMachineChangeDto,
  MachineChangeCancellationResponseDto,
  MachineChangeRequestDto,
} from './dto/machine-change.dto';
import { AssignOperatorMachineDto, BreakdownReassignDto } from './dto/operator-machine.dto';
import { BatchUpdateDispatchDto } from './dto/batch-update.dto';
import { ReorderDispatchDto } from './dto/reorder.dto';
import { CreateOperatorPenaltyDto } from './dto/operator-penalty.dto';
import { ProductionBigBagSummaryResponseDto } from './dto/bigbag-summary.dto';
import { ProductionBigBagSummaryService } from './production-bigbag-summary.service';
import {
  AssignmentCancellationDto,
  AssignmentCancellationResponseDto,
} from './dto/assignment-cancellation.dto';
import { ProductionAssignmentCancellationService } from './production-assignment-cancellation.service';
import { ListDispatchQueryDto } from './dto/list-dispatch-query.dto';
import { ProductionOrderQueryDto } from './dto/production-order-query.dto';
import { ProductionProblemQueryDto } from './dto/production-problem-query.dto';

@ApiTags('production')
@Controller('production')
export class ProductionController {
  constructor(
    private readonly service: ProductionService,
    private readonly shiftCommands: ProductionShiftCommandService,
    private readonly inbox: RoleInboxProjectionService,
    private readonly bigBagSummary: ProductionBigBagSummaryService,
    private readonly assignmentCancellations: ProductionAssignmentCancellationService,
  ) {}

  @Get('notifications')
  @RequireCapabilities('production_order:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Production notification capability is required' })
  notifications(@CurrentActor() actor: Actor, @Query() query: RoleInboxQueryDto) {
    return this.inbox.list(actor, 'production_lead', query);
  }

  @Put('notifications/:eventId/read')
  @RequireCapabilities('production_order:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxReadResponseDto })
  @ApiBadRequestResponse({ description: 'Event id is invalid' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Production notification capability is required' })
  @ApiNotFoundResponse({ description: 'Event is not a production notification' })
  markNotificationRead(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.inbox.markRead(actor, 'production_lead', eventId);
  }

  @Get('orders')
  @RequireCapabilities('production_order:read')
  @ApiBadRequestResponse({ description: 'Unsupported production order bucket' })
  @ApiUnprocessableEntityResponse({ description: 'Production order catalog exceeds safe bounds' })
  listOrders(@CurrentActor() actor: Actor, @Query() query: ProductionOrderQueryDto) {
    return this.service.listOrders(actor, query.bucket);
  }

  @Get('big-bags/summary')
  @RequireCapabilities('production_order:read')
  @ApiBearerAuth('session')
  @ApiOperation({ summary: 'Сводка Big-Bag в производстве и кандидаты на возврат' })
  @ApiOkResponse({ type: ProductionBigBagSummaryResponseDto })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Production read capability is required' })
  bigBagsSummary() {
    return this.bigBagSummary.getSummary();
  }

  @Post('orders')
  @RequireCapabilities('production_order:handoff')
  createOrder(@CurrentActor() actor: Actor, @Body() dto: CreateProductionOrderDto) {
    return this.service.createFromCommercial(
      { userId: actor.userId, role: actor.role },
      dto.commercialOrderId,
    );
  }

  @Get('shifts')
  @RequireCapabilities('production_order:read')
  shifts() {
    return this.service.listShifts();
  }

  @Post('shifts')
  @RequireCapabilities('machine:assign')
  createShift(@CurrentActor() actor: Actor, @Body() dto: CreateShiftDto) {
    return this.service.createShift({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('operator-shifts')
  @RequireCapabilities('machine:assign')
  @ApiOperation({ summary: 'Создать индивидуальную смену без планового окна времени' })
  @ApiCreatedResponse({
    description: 'Смена, назначение поста и автоматически привязанные задания',
  })
  @ApiConflictResponse({
    description: 'Оператор, пост, ключ команды или назначения конфликтуют',
  })
  createIndividualShift(@CurrentActor() actor: Actor, @Body() dto: CreateIndividualShiftDto) {
    return this.shiftCommands.createIndividualShift(
      { userId: actor.userId, role: actor.role },
      dto,
    );
  }

  @Get('shifts/:shiftId/operator-machines')
  @RequireCapabilities('production_order:read')
  operatorMachines(@Param('shiftId') shiftId: string) {
    return this.service.listOperatorMachines(shiftId);
  }

  @Put('shifts/:shiftId/operators/:operatorId/machine')
  @RequireCapabilities('machine:assign')
  assignOperatorMachine(
    @CurrentActor() actor: Actor,
    @Param('shiftId') shiftId: string,
    @Param('operatorId') operatorId: string,
    @Body() dto: AssignOperatorMachineDto,
  ) {
    return this.service.assignOperatorMachine(
      { userId: actor.userId, role: actor.role },
      shiftId,
      operatorId,
      dto,
    );
  }

  @Post('shifts/:shiftId/assignments/:assignmentId/cancel')
  @RequireCapabilities('machine_assignment:cancel')
  @ApiBearerAuth('session')
  @ApiOperation({ summary: 'Отменить не начатое назначение оператора на пост' })
  @ApiCreatedResponse({ type: AssignmentCancellationResponseDto })
  @ApiConflictResponse({
    description: 'Смена началась, появились физические факты или команда конфликтует',
  })
  @ApiNotFoundResponse({ description: 'Назначение не найдено в указанной смене' })
  cancelAssignment(
    @CurrentActor() actor: Actor,
    @Param('shiftId') shiftId: string,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: AssignmentCancellationDto,
  ) {
    return this.assignmentCancellations.cancel(
      { userId: actor.userId, role: actor.role },
      shiftId,
      assignmentId,
      dto,
    );
  }

  @Post('operator-machines/:assignmentId/breakdown-reassign')
  @RequireCapabilities('machine:assign')
  breakdownReassign(
    @CurrentActor() actor: Actor,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: BreakdownReassignDto,
  ) {
    return this.service.breakdownReassign(
      { userId: actor.userId, role: actor.role },
      assignmentId,
      dto,
    );
  }

  @Post('operator-machines/:assignmentId/machine-change')
  @RequireCapabilities('machine:assign')
  @ApiOperation({ summary: 'Запросить преднамеренную смену исправного станка' })
  @ApiCreatedResponse({ description: 'Persistent machine-change operation' })
  @ApiConflictResponse({ description: 'Назначение или целевой пост изменились/заняты' })
  requestMachineChange(
    @CurrentActor() actor: Actor,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: MachineChangeRequestDto,
  ) {
    return this.shiftCommands.requestMachineChange(
      { userId: actor.userId, role: actor.role },
      assignmentId,
      dto,
    );
  }

  @Post('machine-changes/:changeId/cancel')
  @RequireCapabilities('machine_change:cancel')
  @ApiBearerAuth('session')
  @ApiOperation({ summary: 'Отменить незавершённую смену исправного станка' })
  @ApiCreatedResponse({ type: MachineChangeCancellationResponseDto })
  @ApiConflictResponse({
    description: 'Перенос завершён, появился физический факт или команда конфликтует',
  })
  @ApiNotFoundResponse({ description: 'Операция смены станка не найдена' })
  cancelMachineChange(
    @CurrentActor() actor: Actor,
    @Param('changeId') changeId: string,
    @Body() dto: CancelMachineChangeDto,
  ) {
    return this.shiftCommands.cancelMachineChange(
      { userId: actor.userId, role: actor.role },
      changeId,
      dto,
    );
  }

  @Get('posts')
  @RequireCapabilities('production_order:read')
  posts() {
    return this.service.listPosts();
  }

  @Post('posts/:postId/breakdown')
  @RequireCapabilities('machine:assign')
  reportMachineBreakdown(
    @CurrentActor() actor: Actor,
    @Param('postId') postId: string,
    @Body() dto: ReportMachineBreakdownDto,
  ) {
    return this.service.reportMachineBreakdown(
      { userId: actor.userId, role: actor.role },
      postId,
      dto,
    );
  }

  @Post('posts/:postId/repair-start')
  @RequireCapabilities('machine:assign')
  startMachineRepair(@CurrentActor() actor: Actor, @Param('postId') postId: string) {
    return this.service.startMachineRepair({ userId: actor.userId, role: actor.role }, postId);
  }

  @Post('posts/:postId/repair')
  @RequireCapabilities('machine:assign')
  completeMachineRepair(
    @CurrentActor() actor: Actor,
    @Param('postId') postId: string,
    @Body() dto: CompleteMachineRepairDto,
  ) {
    return this.service.completeMachineRepair(
      { userId: actor.userId, role: actor.role },
      postId,
      dto,
    );
  }

  @Post('rolls/:rollCode/defect')
  @RequireCapabilities('production_defect:create')
  markRollDefect(
    @CurrentActor() actor: Actor,
    @Param('rollCode') rollCode: string,
    @Body() dto: MarkRollDefectDto,
  ) {
    return this.service.markRollDefect({ userId: actor.userId, role: actor.role }, rollCode, dto);
  }

  @Get('orders/:orderId')
  @RequireCapabilities('production_order:read')
  getOrder(@CurrentActor() actor: Actor, @Param('orderId') orderId: string) {
    return this.service.getOrder(actor, orderId);
  }

  @Post('orders/:orderId/approve')
  @RequireCapabilities('production_order:approve')
  approve(@CurrentActor() actor: Actor, @Param('orderId') orderId: string) {
    return this.service.approve({ userId: actor.userId, role: actor.role }, orderId);
  }

  @Post('orders/:orderId/problems')
  @RequireCapabilities('problem:create')
  reportProblem(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: ReportProblemDto,
  ) {
    return this.service.reportProblem({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Get('problems')
  @RequireCapabilities('production_order:read')
  @ApiBadRequestResponse({ description: 'Invalid production problem filter' })
  @ApiUnprocessableEntityResponse({ description: 'Problem queue exceeds the safe response cap' })
  listProblems(@Query() query: ProductionProblemQueryDto) {
    return this.service.listProblems(query);
  }

  @Post('problems/:problemId/resolve')
  @RequireCapabilities('problem:resolve')
  resolveProblem(
    @CurrentActor() actor: Actor,
    @Param('problemId') problemId: string,
    @Body() dto: ResolveProblemDto,
  ) {
    return this.service.resolveProblem({ userId: actor.userId, role: actor.role }, problemId, dto);
  }

  @Get('roll-dispatch')
  @RequireCapabilities('production_order:read')
  @ApiBadRequestResponse({ description: 'Invalid scope or unsafe date window' })
  @ApiConflictResponse({ description: 'Impossible Moscow calendar date' })
  @ApiUnprocessableEntityResponse({ description: 'Result exceeds the bounded list contract' })
  listDispatch(@Query() query: ListDispatchQueryDto) {
    return this.service.listDispatch(query);
  }

  @Get('roll-dispatch/summary')
  @RequireCapabilities('production_order:read')
  summary() {
    return this.service.getSummary();
  }

  @Post('roll-dispatch/bulk-assign')
  @RequireCapabilities('roll_dispatch:assign')
  bulkAssign(@CurrentActor() actor: Actor, @Body() dto: BulkAssignDto) {
    return this.service.bulkAssign({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('roll-dispatch/batch-update')
  @RequireCapabilities('roll_dispatch:assign')
  batchUpdate(@CurrentActor() actor: Actor, @Body() dto: BatchUpdateDispatchDto) {
    return this.service.batchUpdate({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('roll-dispatch/reorder')
  @RequireCapabilities('roll_dispatch:priority')
  reorder(@CurrentActor() actor: Actor, @Body() dto: ReorderDispatchDto) {
    return this.service.reorder({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('roll-dispatch/:rollId/assign')
  @RequireCapabilities('roll_dispatch:assign')
  assignRoll(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: AssignRollDto,
  ) {
    return this.service.assignRoll({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('roll-dispatch/:rollId/priority')
  @RequireCapabilities('roll_dispatch:priority')
  setPriority(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: SetPriorityDto,
  ) {
    return this.service.setPriority({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('roll-dispatch/:rollId/machine')
  @RequireCapabilities('machine:assign')
  assignMachine(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: AssignMachineDto,
  ) {
    return this.service.assignMachine({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Get('operators/workload')
  @RequireCapabilities('production_order:read')
  workload() {
    return this.service.operatorWorkload();
  }

  @Get('penalties')
  @RequireCapabilities('production_order:read')
  listPenalties(@CurrentActor() actor: Actor) {
    return this.service.listOperatorPenalties({ userId: actor.userId, role: actor.role });
  }

  @Post('penalties')
  @RequireCapabilities('penalty:create')
  createOperatorPenalty(@CurrentActor() actor: Actor, @Body() dto: CreateOperatorPenaltyDto) {
    return this.service.createOperatorPenalty({ userId: actor.userId, role: actor.role }, dto);
  }
}
