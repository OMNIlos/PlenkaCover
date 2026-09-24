import {
  BadRequestException,
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
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { OperatorRollReweighResult, OperatorRollStepBackResult } from '@plenka/contracts';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RoleInboxQueryDto } from '../../common/role-inbox/dto/role-inbox-query.dto';
import {
  RoleInboxPageResponseDto,
  RoleInboxReadResponseDto,
} from '../../common/role-inbox/dto/role-inbox-response.dto';
import { RoleInboxProjectionService } from '../../common/role-inbox/role-inbox.service';
import { OperatorService } from './operator.service';
import { OperatorSessionService } from './operator-session.service';
import { OperatorShiftService } from './operator-shift.service';
import { AddShiftBagDto, CloseShiftDto, OpenShiftDto, ReleaseShiftBagDto } from './dto/shift.dto';
import { OperatorShiftCloseResponseDto } from './dto/operator-shift-close-response.dto';
import { DeferRollDto } from './dto/defer.dto';
import { WeightCaptureDto } from './dto/weight.dto';
import { OperatorRollReweighResponseDto, ReweighRollDto } from './dto/reweigh.dto';
import { OpenPostSessionDto } from './dto/post-session.dto';
import { RecordDefectDto } from './dto/defect.dto';
import { QrPrintDto, QrVerifyAndHandoverDto, QrVerifyDto } from './dto/qr.dto';
import { BigBagWeightDto } from './dto/bigbag.dto';
import { DefectBagPrintDto, DefectBagWeightDto } from './dto/defect-bag.dto';
import { OperatorOperationDto } from './dto/operation.dto';
import { OperatorRollStepBackResponseDto } from './dto/step-back.dto';
import { OperatorPhysicalService } from './operator-physical.service';
import { OperatorStepBackService } from './operator-step-back.service';
import { OperatorDefectBagService } from './operator-defect-bag.service';
import { ProductionShiftCommandService } from '../production/production-shift-command.service';
import { FinalizeMachineChangeDto } from '../production/dto/machine-change.dto';
import {
  MachineBreakdownDto,
  OperatorProblemDto,
  OperatorProblemResponseDto,
} from './dto/problem.dto';

@ApiTags('operator')
@Controller('operator')
export class OperatorController {
  constructor(
    private readonly service: OperatorService,
    private readonly sessions: OperatorSessionService,
    private readonly shift: OperatorShiftService,
    private readonly inbox: RoleInboxProjectionService,
    private readonly physical: OperatorPhysicalService,
    private readonly shiftCommands: ProductionShiftCommandService,
    private readonly stepBackService: OperatorStepBackService,
    private readonly defectBags: OperatorDefectBagService,
  ) {}

  @Get('notifications')
  @RequireCapabilities('operator_task:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Operator notification capability is required' })
  notifications(@CurrentActor() actor: Actor, @Query() query: RoleInboxQueryDto) {
    return this.inbox.list(actor, 'operator', query);
  }

  @Put('notifications/:eventId/read')
  @RequireCapabilities('operator_task:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxReadResponseDto })
  @ApiBadRequestResponse({ description: 'Event id is invalid' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Operator notification capability is required' })
  @ApiNotFoundResponse({ description: 'Event is not an operator notification' })
  markNotificationRead(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.inbox.markRead(actor, 'operator', eventId);
  }

  // --- Shift with big bags (design 2026-07-13 §6) ----------------------------

  @Get('scale/reading')
  @RequireCapabilities('roll:weigh')
  @ApiOperation({ summary: 'Живое чтение весов поста для интерактивного виджета (без фиксации)' })
  scaleReading(@CurrentActor() actor: Actor, @Query('kind') kind?: string) {
    const normalized = kind === 'roll' ? 'roll' : kind === 'spool' ? 'spool' : null;
    if (!normalized) {
      throw new BadRequestException('kind must be spool or roll');
    }
    return this.service.readScale({ userId: actor.userId, role: actor.role }, normalized);
  }

  @Get('big-bags')
  @RequireCapabilities('operator_task:read')
  @ApiOperation({ summary: 'Big bags available for the shift-open picker' })
  bigBags() {
    return this.shift.listBigBags();
  }

  @Post('shift/open')
  @RequireCapabilities('post_session:manage')
  @ApiOperation({ summary: 'Открыть смену: пост-сессия + первый мешок со стартовым весом' })
  openShift(@CurrentActor() actor: Actor, @Body() dto: OpenShiftDto) {
    return this.shift.open({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('shift/bags')
  @RequireCapabilities('post_session:manage')
  @ApiOperation({ summary: 'Добавить доступный или ранее сданный Big-Bag в открытую смену' })
  addShiftBag(@CurrentActor() actor: Actor, @Body() dto: AddShiftBagDto) {
    return this.shift.addBag({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('shift/bags/:bigBagId/release')
  @RequireCapabilities('post_session:manage')
  @ApiOperation({
    summary: 'Взвесить и сдать Big-Bag без причины, не закрывая смену оператора',
  })
  @ApiConflictResponse({
    description: 'Big-Bag не используется текущей активной сессией или уже освобождён',
  })
  releaseShiftBag(
    @CurrentActor() actor: Actor,
    @Param('bigBagId') bigBagId: string,
    @Body() dto: ReleaseShiftBagDto,
  ) {
    return this.shift.releaseBag({ userId: actor.userId, role: actor.role }, bigBagId, dto);
  }

  @Post('shift/close')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('post_session:manage')
  @ApiBearerAuth('session')
  @ApiOperation({ summary: 'Сдать смену: финальные веса всех мешков + баланс-проверка' })
  @ApiOkResponse({ type: OperatorShiftCloseResponseDto })
  @ApiBadRequestResponse({ description: 'Невалидный operationKey или неполные финальные веса' })
  @ApiUnauthorizedResponse({ description: 'Требуется реальная сессия оператора' })
  @ApiForbiddenResponse({ description: 'Требуется управление собственной пост-сессией' })
  @ApiConflictResponse({ description: 'Смена изменилась или operationKey уже занят' })
  closeShift(@CurrentActor() actor: Actor, @Body() dto: CloseShiftDto) {
    return this.shift.close({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('shift/defect-bag/weigh')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('defect_bag:weigh')
  @ApiOperation({ summary: 'Зафиксировать ручной вес мешка брака текущей смены' })
  @ApiOkResponse({ description: 'Безопасная проекция взвешенного мешка' })
  @ApiBadRequestResponse({ description: 'Вес должен быть числом от 0 до 10000 кг' })
  @ApiConflictResponse({ description: 'Нет активной смены или мешок уже взвешен' })
  defectBagWeigh(@CurrentActor() actor: Actor, @Body() dto: DefectBagWeightDto) {
    return this.defectBags.weigh({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('shift/defect-bag/print')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('defect_bag:print')
  @ApiOperation({ summary: 'Напечатать QR-этикетку мешка брака' })
  @ApiOkResponse({ description: 'Мешок готов к сдаче на склад' })
  @ApiBadRequestResponse({ description: 'Для повторной печати нужна причина' })
  @ApiConflictResponse({ description: 'Мешок не взвешен или исход печати неизвестен' })
  @ApiServiceUnavailableResponse({ description: 'Принтер поста недоступен' })
  defectBagPrint(@CurrentActor() actor: Actor, @Body() dto: DefectBagPrintDto) {
    return this.defectBags.print({ userId: actor.userId, role: actor.role }, dto);
  }

  // --- Post sessions (V2 S3): who is at this post right now -----------------

  @Post('post-sessions')
  @RequireCapabilities('post_session:manage')
  openSession(@CurrentActor() actor: Actor, @Body() dto: OpenPostSessionDto) {
    return this.sessions.open({ userId: actor.userId, role: actor.role }, dto.postCode);
  }

  @Post('post-sessions/close')
  @RequireCapabilities('post_session:manage')
  closeSession(@CurrentActor() actor: Actor) {
    return this.sessions.close({ userId: actor.userId, role: actor.role });
  }

  @Get('post-sessions/current')
  @RequireCapabilities('post_session:manage')
  currentSession(@CurrentActor() actor: Actor) {
    return actor.userId ? this.sessions.getCurrent(actor.userId) : null;
  }

  @Post('machine-breakdown')
  @RequireCapabilities('operator_problem:create')
  @ApiOperation({
    summary: 'Станок сломался: пост помечается broken, заявка уходит зав. производства',
  })
  @ApiConflictResponse({ description: 'Нет активной сессии поста или пустое описание' })
  reportMachineBreakdown(@CurrentActor() actor: Actor, @Body() dto: MachineBreakdownDto) {
    return this.sessions.reportMachineBreakdown({ userId: actor.userId, role: actor.role }, dto);
  }

  @Get('tasks/current')
  @RequireCapabilities('operator_task:read')
  current(@CurrentActor() actor: Actor) {
    return this.service.getCurrentTask(actor.userId ?? undefined);
  }

  @Get('runtime')
  @RequireCapabilities('operator_task:read')
  runtime(@CurrentActor() actor: Actor) {
    return this.service.getRuntime({ userId: actor.userId, role: actor.role });
  }

  @Get('machine-changes/current')
  @RequireCapabilities('operator_task:read')
  @ApiOperation({ summary: 'Восстановить последнюю persistent смену станка после reload' })
  currentMachineChange(@CurrentActor() actor: Actor) {
    return this.shiftCommands.getCurrentMachineChange({ userId: actor.userId });
  }

  @Post('machine-changes/:changeId/finalize')
  @RequireCapabilities('post_session:manage')
  @ApiOperation({
    summary: 'Зафиксировать финальный Big-Bag и продолжить смену на новом посту',
  })
  @ApiOkResponse({ description: 'Machine change completed idempotently' })
  @ApiConflictResponse({ description: 'Нестабильный вес или изменившаяся топология' })
  finalizeMachineChange(
    @CurrentActor() actor: Actor,
    @Param('changeId') changeId: string,
    @Body() dto: FinalizeMachineChangeDto,
  ) {
    return this.shiftCommands.finalizeMachineChange(
      { userId: actor.userId, role: actor.role },
      changeId,
      dto,
    );
  }

  @Get('rolls')
  @RequireCapabilities('operator_task:read')
  rolls(@CurrentActor() actor: Actor, @Query('status') status?: string) {
    return this.service.listRolls(actor.userId ?? undefined, status);
  }

  @Get('penalties')
  @RequireCapabilities('operator_task:read')
  penalties(@CurrentActor() actor: Actor) {
    return this.service.listPenalties({ userId: actor.userId, role: actor.role });
  }

  @Post('rolls/:rollId/accept')
  @RequireCapabilities('roll:accept')
  accept(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: OperatorOperationDto,
  ) {
    return this.physical.accept({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/spool-weight')
  @RequireCapabilities('roll:weigh')
  spoolWeight(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: WeightCaptureDto,
  ) {
    return this.physical.captureSpoolWeight(
      { userId: actor.userId, role: actor.role },
      rollId,
      dto,
    );
  }

  @Post('rolls/:rollId/roll-weight')
  @RequireCapabilities('roll:weigh')
  rollWeight(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: WeightCaptureDto,
  ) {
    return this.physical.captureRollWeight({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/reweigh')
  @RequireCapabilities('roll:weigh')
  @ApiOperation({ summary: 'Повторно взвесить текущий рулон до запуска печати QR' })
  @ApiCreatedResponse({ type: OperatorRollReweighResponseDto })
  @ApiConflictResponse({ description: 'Рулон или печать уже вышли из допустимого состояния' })
  reweighRoll(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: ReweighRollDto,
  ): Promise<OperatorRollReweighResult> {
    return this.physical.reweighRoll({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/step-back')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('roll:weigh')
  @ApiOperation({ summary: 'Вернуть текущий рулон на один безопасный этап до печати QR' })
  @ApiOkResponse({ type: OperatorRollStepBackResponseDto })
  @ApiConflictResponse({
    description: 'Этап изменился, физическая операция выполняется или печать уже началась',
  })
  stepBack(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: OperatorOperationDto,
  ): Promise<OperatorRollStepBackResult> {
    return this.stepBackService.stepBack({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/defects')
  @RequireCapabilities('roll:defect')
  defect(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: RecordDefectDto,
  ) {
    return this.physical.recordDefect({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/defer')
  @RequireCapabilities('roll:defect')
  @ApiOperation({ summary: 'Отложить рулон (вкладка «Отложены») с причиной' })
  defer(@CurrentActor() actor: Actor, @Param('rollId') rollId: string, @Body() dto: DeferRollDto) {
    return this.physical.defer({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/resume')
  @RequireCapabilities('roll:defect')
  @ApiOperation({ summary: 'Вернуть отложенный рулон в работу' })
  resume(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: OperatorOperationDto,
  ) {
    return this.physical.resume({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/qr-print')
  @RequireCapabilities('roll:qr')
  qrPrint(@CurrentActor() actor: Actor, @Param('rollId') rollId: string, @Body() dto: QrPrintDto) {
    return this.physical.printQr({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/qr-verify')
  @RequireCapabilities('roll:qr')
  qrVerify(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: QrVerifyDto,
  ) {
    return this.physical.verifyQr({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/qr-verify-and-handover')
  @RequireCapabilities('roll:qr', 'roll:handover')
  @ApiOperation({
    summary: 'Проверить QR и автоматически передать рулон в складскую приёмку',
  })
  qrVerifyAndHandover(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: QrVerifyAndHandoverDto,
  ) {
    return this.physical.verifyQrAndHandover(
      { userId: actor.userId, role: actor.role },
      rollId,
      dto,
    );
  }

  @Post('rolls/:rollId/handover')
  @RequireCapabilities('roll:handover')
  handover(
    @CurrentActor() actor: Actor,
    @Param('rollId') rollId: string,
    @Body() dto: OperatorOperationDto,
  ) {
    return this.physical.handover({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('big-bags/:bigBagId/weight')
  @RequireCapabilities('bigbag:weigh')
  bigBag(
    @CurrentActor() actor: Actor,
    @Param('bigBagId') bigBagId: string,
    @Body() dto: BigBagWeightDto,
  ) {
    return this.service.bigBagWeight({ userId: actor.userId, role: actor.role }, bigBagId, dto);
  }

  @Post('problems')
  @RequireCapabilities('operator_problem:create')
  @ApiOperation({
    summary: 'Report an operator problem; shortage is scoped to the actor roll/post',
  })
  @ApiCreatedResponse({
    description: 'Problem recorded and routed',
    type: OperatorProblemResponseDto,
  })
  @ApiBadRequestResponse({ description: 'rollId/type is invalid' })
  @ApiForbiddenResponse({ description: 'The actor cannot report operator-contour problems' })
  @ApiNotFoundResponse({ description: 'The roll is outside the operator/post projection' })
  @ApiConflictResponse({ description: 'No active post session or transaction conflict' })
  problem(@CurrentActor() actor: Actor, @Body() dto: OperatorProblemDto) {
    return this.service.reportProblem({ userId: actor.userId, role: actor.role }, dto);
  }
}
