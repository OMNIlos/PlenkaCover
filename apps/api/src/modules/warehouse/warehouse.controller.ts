import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiServiceUnavailableResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RequireOneCRuntime } from '../../common/auth/require-onec-runtime.decorator';
import { RoleInboxQueryDto } from '../../common/role-inbox/dto/role-inbox-query.dto';
import {
  RoleInboxPageResponseDto,
  RoleInboxReadResponseDto,
} from '../../common/role-inbox/dto/role-inbox-response.dto';
import { RoleInboxProjectionService } from '../../common/role-inbox/role-inbox.service';
import { WarehouseService } from './warehouse.service';
import { WarehouseIntakeService } from './warehouse-intake.service';
import { ScanDto } from './dto/scan.dto';
import { CloseTaskDto } from './dto/close.dto';
import { ReserveDto } from './dto/reserve.dto';
import { CreatePalletListDto } from './dto/pallet-list.dto';
import {
  BigBagMovementResponseDto,
  BigBagResponseDto,
  CreateBigBagDto,
  MoveBigBagDto,
} from './dto/bigbag.dto';
import { RawAdjustDto } from './dto/raw-adjust.dto';
import { RawMaterialStockResponseDto, RawReceiptDto } from './dto/raw-receipt.dto';
import { CoverProposeDto } from './dto/cover-propose.dto';
import {
  CoverCheckQueryDto,
  WarehouseCoverCheckPageResponseDto,
} from './dto/cover-check-query.dto';
import type { PalletExportFormat } from './pallet-export.service';
import { PrintPalletListDto } from './dto/pallet-print.dto';
import { PalletPrintService } from './pallet-print.service';
import { WarehouseIntakeIntegrityService } from './warehouse-intake-integrity.service';
import {
  OneCStockPushDto,
  OneCStockPushPreviewResponseDto,
  OneCStockPushResponseDto,
} from './dto/onec-stock-push.dto';
import { WarehouseOneCStockPushService } from './warehouse-onec-stock-push.service';
import { WarehouseRollResponseDto } from './dto/warehouse-roll-response.dto';
import { WarehouseRollQueryDto } from './dto/warehouse-roll-query.dto';
import { CoveragePhysicalExceptionDto } from './dto/coverage-physical-exception.dto';
import { WarehouseCoverageReservationRecoveryService } from '../warehouse-coverage/warehouse-coverage-reservation-recovery.service';
import { FinishedStockPageResponseDto, FinishedStockQueryDto } from './dto/finished-stock.dto';
import { WarehouseFinishedStockService } from './warehouse-finished-stock.service';
import { CloseAndPrintCurrentPalletDto } from './dto/close-and-print-pallet.dto';
import { SealCurrentPalletDto } from './dto/seal-current-pallet.dto';
import { WarehousePalletService } from './warehouse-pallet.service';
import { PalletHistoryQueryDto } from './dto/pallet-history-query.dto';
import { WarehouseBigBagService } from './warehouse-bigbag.service';
import { BigBagLabelPrintResponseDto, PrintBigBagLabelDto } from './dto/bigbag-print.dto';
import { WarehousePrinterResponseDto } from './dto/warehouse-printer.dto';
import { WarehouseBigBagPrintService } from './warehouse-bigbag-print.service';
import { BigBagSystemPrintIntentDto } from './dto/bigbag-system-print.dto';
import { WarehouseBigBagSystemPrintService } from './warehouse-bigbag-system-print.service';
import {
  WarehouseQrBigBagInspectionResponseDto,
  WarehouseQrInspectDto,
  WarehouseQrPalletInspectionResponseDto,
  WarehouseQrRollInspectionResponseDto,
} from './dto/warehouse-qr-inspection.dto';
import { WarehouseQrInspectionService } from './warehouse-qr-inspection.service';
import {
  CreateWarehouseReserveRollDto,
  WarehouseReserveRollResponseDto,
} from './dto/reserve-roll.dto';
import { WarehouseReserveRollService } from './warehouse-reserve-roll.service';
import { SetPalletSelectionDto } from './dto/set-pallet-selection.dto';
import { VoidPalletDto } from './dto/void-pallet.dto';
import { WarehousePalletSelectionService } from './warehouse-pallet-selection.service';
import {
  PalletSystemPrintIntentDto,
  PalletSystemPrintIntentResponseDto,
} from './dto/pallet-system-print-intent.dto';
import { PalletSystemPrintIntentService } from './pallet-system-print-intent.service';
import { PalletHandoffScanDto, PalletHandoffScanResponseDto } from './dto/pallet-handoff-scan.dto';
import { WarehousePalletHandoffService } from './warehouse-pallet-handoff.service';
import {
  PalletDeliveryScanDto,
  PalletDeliveryScanResponseDto,
} from './dto/pallet-delivery-scan.dto';
import { WarehousePalletDeliveryService } from './warehouse-pallet-delivery.service';
import { WarehousePalletSelectionScanResponseDto } from './dto/pallet-selection-scan.dto';
import { DefectBagQueryDto, DefectBagScanDto } from './dto/defect-bag.dto';
import { WarehouseDefectBagService } from './warehouse-defect-bag.service';

const PALLET_EXPORT_FORMATS: PalletExportFormat[] = ['docx', 'pdf', 'xlsx'];

function isPalletExportFormat(format: string | undefined): format is PalletExportFormat {
  return PALLET_EXPORT_FORMATS.some((candidate) => candidate === format);
}

@ApiTags('warehouse')
@Controller('warehouse')
export class WarehouseController {
  @Inject(WarehouseCoverageReservationRecoveryService)
  private readonly reservationRecovery!: WarehouseCoverageReservationRecoveryService;

  @Inject(WarehouseBigBagService)
  private readonly bigBagService!: WarehouseBigBagService;

  @Inject(WarehouseBigBagPrintService)
  private readonly bigBagPrint!: WarehouseBigBagPrintService;

  @Inject(WarehouseBigBagSystemPrintService)
  private readonly bigBagSystemPrint!: WarehouseBigBagSystemPrintService;

  @Inject(WarehouseQrInspectionService)
  private readonly qrInspection!: WarehouseQrInspectionService;

  @Inject(WarehouseReserveRollService)
  private readonly reserveRolls!: WarehouseReserveRollService;

  @Inject(WarehousePalletSelectionService)
  private readonly palletSelection!: WarehousePalletSelectionService;

  @Inject(PalletSystemPrintIntentService)
  private readonly systemPrintIntent!: PalletSystemPrintIntentService;

  @Inject(WarehousePalletHandoffService)
  private readonly palletHandoff!: WarehousePalletHandoffService;

  @Inject(WarehousePalletDeliveryService)
  private readonly palletDelivery!: WarehousePalletDeliveryService;

  @Inject(WarehouseDefectBagService)
  private readonly defectBagLogistics!: WarehouseDefectBagService;

  constructor(
    private readonly service: WarehouseService,
    private readonly intake: WarehouseIntakeService,
    private readonly integrity: WarehouseIntakeIntegrityService,
    private readonly palletPrint: PalletPrintService,
    private readonly inbox: RoleInboxProjectionService,
    private readonly onecStockPush: WarehouseOneCStockPushService,
    private readonly finishedStock: WarehouseFinishedStockService,
    private readonly pallets: WarehousePalletService,
  ) {}

  // --- Приёмка (design 2026-07-13 §9) ----------------------------------------

  @Get('intake')
  @RequireCapabilities('warehouse_task:read')
  getIntake(@CurrentActor() actor: Actor) {
    return this.intake.getIntake(actor.role);
  }

  @Post('intake/scans')
  @RequireCapabilities('warehouse:scan')
  scanByPayload(@CurrentActor() actor: Actor, @Body() dto: ScanDto) {
    return this.integrity.scanByPayload(actor, dto);
  }

  @Post('pallets/scans')
  @RequireCapabilities('warehouse:scan')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('session')
  @ApiOkResponse({
    type: PalletHandoffScanResponseDto,
    description: 'The sealed pallet members are routed into one exact order delivery task.',
  })
  @ApiBadRequestResponse({ description: 'The operation key or exact pallet QR format is invalid.' })
  @ApiUnauthorizedResponse({ description: 'An authenticated warehouse session is required.' })
  @ApiForbiddenResponse({ description: 'The actor cannot perform warehouse scans.' })
  @ApiNotFoundResponse({ description: 'The opaque pallet QR token is unknown.' })
  @ApiConflictResponse({
    description:
      'The pallet, receiving evidence, order fulfillment or delivery composition conflicts.',
  })
  scanPalletHandoff(@CurrentActor() actor: Actor, @Body() dto: PalletHandoffScanDto) {
    return this.palletHandoff.scan(actor, dto);
  }

  @Post('pallets/delivery-scans')
  @RequireCapabilities('warehouse:scan', 'warehouse:close')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('session')
  @ApiOkResponse({
    type: PalletDeliveryScanResponseDto,
    description:
      'Every delivery row on the exact sealed pallet is confirmed; the task closes after its last pallet.',
  })
  @ApiBadRequestResponse({ description: 'The operation key or exact pallet QR format is invalid.' })
  @ApiUnauthorizedResponse({ description: 'An authenticated full warehouse session is required.' })
  @ApiForbiddenResponse({ description: 'Both warehouse scan and close capabilities are required.' })
  @ApiNotFoundResponse({ description: 'The opaque pallet QR token is unknown.' })
  @ApiConflictResponse({
    description: 'The immutable pallet, delivery scope, row evidence or roll provenance conflicts.',
  })
  scanPalletDelivery(@CurrentActor() actor: Actor, @Body() dto: PalletDeliveryScanDto) {
    return this.palletDelivery.scan(actor, dto);
  }

  @Post('qr/inspect')
  @RequireCapabilities('warehouse:scan')
  @HttpCode(HttpStatus.OK)
  @ApiExtraModels(
    WarehouseQrRollInspectionResponseDto,
    WarehouseQrBigBagInspectionResponseDto,
    WarehouseQrPalletInspectionResponseDto,
  )
  @ApiOkResponse({
    description: 'Current safe business facts for a roll, Big-Bag or pallet; no state is changed.',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(WarehouseQrRollInspectionResponseDto) },
        { $ref: getSchemaPath(WarehouseQrBigBagInspectionResponseDto) },
        { $ref: getSchemaPath(WarehouseQrPalletInspectionResponseDto) },
      ],
    },
  })
  @ApiNotFoundResponse({ description: 'The opaque QR token is unknown.' })
  inspectQr(@Body() dto: WarehouseQrInspectDto) {
    return this.qrInspection.inspect(dto.payload);
  }

  @Get('intake/:taskId/pallet-list')
  @RequireCapabilities('warehouse_task:read')
  palletDraft(@CurrentActor() actor: Actor, @Param('taskId') taskId: string) {
    return this.intake.getPalletDraft({ userId: actor.userId, role: actor.role }, taskId);
  }

  @Post('intake/:taskId/pallet-list')
  @RequireCapabilities('pallet_list:create')
  @ApiAcceptedResponse({ description: 'Идемпотентное задание печати ещё выполняется.' })
  async createIntakePalletList(
    @CurrentActor() actor: Actor,
    @Param('taskId') taskId: string,
    @Body() dto: CloseAndPrintCurrentPalletDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.pallets.closeAndPrint(actor, taskId, dto);
    if (result.printJob.status === 'queued') response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Get('intake/:taskId/pallets')
  @RequireCapabilities('warehouse_task:read')
  @ApiOkResponse({ description: 'Текущий физический палет и последние закрытые документы.' })
  listTaskPallets(@Param('taskId') taskId: string, @Query() query: PalletHistoryQueryDto) {
    return this.pallets.listTaskPallets(taskId, query);
  }

  @Put('intake/:taskId/pallet-selection/:scanRowId')
  @RequireCapabilities('pallet_list:create')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Текущий состав открытого физического палета.' })
  @ApiNotFoundResponse({ description: 'Складская задача не найдена.' })
  @ApiConflictResponse({
    description: 'Рулон не принят, относится к другому заказу или состав уже зафиксирован.',
  })
  setPalletSelection(
    @CurrentActor() actor: Actor,
    @Param('taskId') taskId: string,
    @Param('scanRowId') scanRowId: string,
    @Body() dto: SetPalletSelectionDto,
  ) {
    return this.palletSelection.setSelection(actor, taskId, scanRowId, dto);
  }

  @Post('intake/:taskId/pallet-selection/scans')
  @RequireCapabilities('warehouse:scan', 'pallet_list:create')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: WarehousePalletSelectionScanResponseDto })
  @ApiBadRequestResponse({ description: 'The operation key or roll QR format is invalid.' })
  @ApiUnauthorizedResponse({ description: 'An authenticated warehouse session is required.' })
  @ApiForbiddenResponse({ description: 'Both scan and pallet creation capabilities are required.' })
  @ApiNotFoundResponse({ description: 'The receiving task is unknown.' })
  @ApiConflictResponse({
    description: 'The roll is not accepted, belongs to another order, or the pallet is locked.',
  })
  scanPalletSelection(
    @CurrentActor() actor: Actor,
    @Param('taskId') taskId: string,
    @Body() dto: ScanDto,
  ) {
    return this.integrity.scanPalletSelection(actor, taskId, dto);
  }

  @Post('intake/:taskId/pallets/:palletId/void')
  @RequireCapabilities('pallet_list:create')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description: 'Аннулированный палетный лист остаётся в истории и QR-трассировке.',
  })
  @ApiNotFoundResponse({ description: 'Складская задача не найдена.' })
  @ApiConflictResponse({ description: 'Аннулировать можно только закрытый неизменённый палет.' })
  voidPallet(
    @CurrentActor() actor: Actor,
    @Param('taskId') taskId: string,
    @Param('palletId') palletId: string,
    @Body() dto: VoidPalletDto,
  ) {
    return this.palletSelection.voidPallet(actor, taskId, palletId, dto);
  }

  @Post('intake/:taskId/pallets/current/close-and-print')
  @RequireCapabilities('pallet_list:create')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Палет закрыт неизменяемым снимком и отправлен на печать.' })
  @ApiAcceptedResponse({ description: 'Идемпотентное задание печати ещё выполняется.' })
  @ApiConflictResponse({
    description: 'Нет открытого непустого палета или результат печати требует проверки.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Палет закрыт, но принтер не принял задание.',
  })
  async closeAndPrintCurrentPallet(
    @CurrentActor() actor: Actor,
    @Param('taskId') taskId: string,
    @Body() dto: CloseAndPrintCurrentPalletDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.pallets.closeAndPrint(actor, taskId, dto);
    if (result.printJob.status === 'queued') response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Post('intake/:taskId/pallets/current/seal')
  @RequireCapabilities('pallet_list:create')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description: 'Палет закрыт неизменяемым снимком для печати через системный диалог браузера.',
  })
  @ApiConflictResponse({
    description: 'Нет открытого непустого палета или его состав изменился.',
  })
  sealCurrentPallet(
    @CurrentActor() actor: Actor,
    @Param('taskId') taskId: string,
    @Body() dto: SealCurrentPalletDto,
  ) {
    return this.pallets.sealCurrentPallet(actor, taskId, dto);
  }

  @Get('pallet-lists/:palletListId/export')
  @RequireCapabilities('warehouse_task:read')
  @ApiQuery({ name: 'format', enum: PALLET_EXPORT_FORMATS, required: true })
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @ApiOkResponse({ description: 'Файл палетного листа.' })
  @ApiConflictResponse({ description: 'Аннулированный палетный лист нельзя выгрузить.' })
  async exportPalletList(
    @CurrentActor() actor: Actor,
    @Param('palletListId') palletListId: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!isPalletExportFormat(format)) {
      throw new BadRequestException('format must be one of: docx, pdf, xlsx');
    }
    const file = await this.intake.exportPalletList(actor, palletListId, format);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return new StreamableFile(file.buffer);
  }

  @Get('printers')
  @RequireCapabilities('warehouse_task:read')
  listPrinters() {
    return this.palletPrint.listPrinters();
  }

  @Get('pallet-lists/:palletListId/preview')
  @RequireCapabilities('warehouse_task:read')
  @ApiProduces('image/png')
  @ApiOkResponse({ description: 'PNG неизменяемого профиля палетного листа.' })
  @ApiConflictResponse({ description: 'Аннулированный палетный лист нельзя открыть.' })
  async previewPalletList(
    @CurrentActor() actor: Actor,
    @Param('palletListId') palletListId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const preview = await this.intake.previewPalletList(actor, palletListId);
    response.setHeader('Content-Type', preview.contentType);
    response.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
    return new StreamableFile(preview.buffer);
  }

  @Post('pallet-lists/:palletListId/system-print-intents')
  @RequireCapabilities('pallet_list:create')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('session')
  @ApiOkResponse({
    type: PalletSystemPrintIntentResponseDto,
    description:
      'Идемпотентно фиксирует намерение открыть системную печать; не подтверждает печать.',
  })
  @ApiBadRequestResponse({
    description: 'Для reprint требуется фактическая причина длиной от 3 до 500 символов.',
  })
  @ApiUnauthorizedResponse({ description: 'Требуется сессия пользователя.' })
  @ApiForbiddenResponse({ description: 'Нет права открывать палетный лист для печати.' })
  @ApiNotFoundResponse({ description: 'Палетный лист не найден.' })
  @ApiConflictResponse({
    description: 'Палетный лист аннулирован или requestId уже связан с другим намерением.',
  })
  recordPalletSystemPrintIntent(
    @CurrentActor() actor: Actor,
    @Param('palletListId') palletListId: string,
    @Body() dto: PalletSystemPrintIntentDto,
  ) {
    return this.systemPrintIntent.record(actor, palletListId, dto);
  }

  @Post('pallet-lists/:palletListId/print')
  @RequireCapabilities('pallet_list:create')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Print bytes submitted to the selected gateway printer.' })
  @ApiAcceptedResponse({ description: 'The same idempotent print request is already queued.' })
  async printPalletList(
    @CurrentActor() actor: Actor,
    @Param('palletListId') palletListId: string,
    @Body() dto: PrintPalletListDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.palletPrint.print(
      { userId: actor.userId, role: actor.role },
      palletListId,
      dto,
    );
    if (result.status === 'queued') response.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Get('notifications')
  @RequireCapabilities('warehouse_task:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or page limit' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Warehouse notification capability is required' })
  notifications(@CurrentActor() actor: Actor, @Query() query: RoleInboxQueryDto) {
    return this.inbox.list(actor, 'warehouse', query);
  }

  @Put('notifications/:eventId/read')
  @RequireCapabilities('warehouse_task:read')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: RoleInboxReadResponseDto })
  @ApiBadRequestResponse({ description: 'Event id is invalid' })
  @ApiUnauthorizedResponse({ description: 'A real user session is required' })
  @ApiForbiddenResponse({ description: 'Warehouse notification capability is required' })
  @ApiNotFoundResponse({ description: 'Event is not a warehouse notification' })
  markNotificationRead(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.inbox.markRead(actor, 'warehouse', eventId);
  }

  // --- Big bags ---------------------------------------------------------------

  @Get('big-bags/printers')
  @RequireCapabilities('warehouse_task:read')
  @ApiOkResponse({
    type: WarehousePrinterResponseDto,
    isArray: true,
    description: 'Принтеры с проверкой готовности к точной операции печати Big-Bag.',
  })
  listBigBagPrinters() {
    return this.bigBagPrint.listPrinters();
  }

  @Get('big-bags/:bigBagId/label-preview')
  @RequireCapabilities('bigbag:print')
  @ApiProduces('image/png')
  @ApiOkResponse({ description: 'Неизменяемая PNG-этикетка Big-Bag для системной печати.' })
  @ApiNotFoundResponse({ description: 'Big-Bag не найден.' })
  @ApiConflictResponse({ description: 'Для Big-Bag ещё не создан QR-код.' })
  async previewBigBagLabel(
    @Param('bigBagId') bigBagId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const preview = await this.bigBagSystemPrint.preview(bigBagId);
    response.setHeader('Content-Type', preview.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(preview.buffer);
  }

  @Post('big-bags/:bigBagId/system-print-intents')
  @RequireCapabilities('bigbag:print')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: BigBagLabelPrintResponseDto,
    description: 'Фиксирует намерение открыть системную печать, но не заявляет физический успех.',
  })
  @ApiBadRequestResponse({ description: 'Для повторной печати нужна фактическая причина.' })
  @ApiNotFoundResponse({ description: 'Big-Bag не найден.' })
  @ApiConflictResponse({ description: 'QR не создан или requestId уже использован иначе.' })
  recordBigBagSystemPrintIntent(
    @CurrentActor() actor: Actor,
    @Param('bigBagId') bigBagId: string,
    @Body() dto: BigBagSystemPrintIntentDto,
  ) {
    return this.bigBagSystemPrint.record(actor, bigBagId, dto);
  }

  @Get('big-bags')
  @RequireCapabilities('warehouse_task:read')
  @ApiOkResponse({ type: BigBagResponseDto, isArray: true })
  bigBags() {
    return this.bigBagService.list();
  }

  @Post('big-bags')
  @RequireCapabilities('bigbag:create')
  @ApiCreatedResponse({ type: BigBagResponseDto })
  @ApiBadRequestResponse({ description: 'Exactly one supported Big-Bag material is required.' })
  @ApiNotFoundResponse({ description: 'The selected physical stock was not found.' })
  @ApiConflictResponse({
    description: 'The material/recipe is unavailable, stale, or has insufficient stock.',
  })
  createBigBag(@CurrentActor() actor: Actor, @Body() dto: CreateBigBagDto) {
    return this.bigBagService.create({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('big-bags/scans')
  @RequireCapabilities('bigbag:move')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: BigBagMovementResponseDto,
    description: 'Idempotent explicit Big-Bag registration or location transition.',
  })
  @ApiNotFoundResponse({ description: 'The opaque Big-Bag QR token is unknown.' })
  @ApiConflictResponse({
    description: 'The transition, control weight, current usage, or operation key is invalid.',
  })
  moveBigBag(@CurrentActor() actor: Actor, @Body() dto: MoveBigBagDto) {
    return this.bigBagService.move({ userId: actor.userId, role: actor.role }, dto);
  }

  @Post('big-bags/:bigBagId/label-prints')
  @RequireCapabilities('bigbag:print')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: BigBagLabelPrintResponseDto,
    description: 'Honest durable result of a Device Gateway Big-Bag label print.',
  })
  @ApiNotFoundResponse({ description: 'Big-Bag or selected printer was not found.' })
  @ApiConflictResponse({
    description: 'Print is active/uncertain, reprint reason is absent, or request id conflicts.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Gateway printing is disabled or the selected printer is unavailable.',
  })
  printBigBagLabel(
    @CurrentActor() actor: Actor,
    @Param('bigBagId') bigBagId: string,
    @Body() dto: PrintBigBagLabelDto,
  ) {
    return this.bigBagPrint.print({ userId: actor.userId, role: actor.role }, bigBagId, dto);
  }

  @Get('defect-bags')
  @RequireCapabilities('defect_bag:read')
  @ApiOperation({ summary: 'Список мешков брака на прием или отгрузку' })
  @ApiOkResponse({ description: 'Безопасная складская очередь без QR и raw payload' })
  defectBags(@Query() query: DefectBagQueryDto) {
    return this.defectBagLogistics.list(query.mode);
  }

  @Post('defect-bags/receipts')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('defect_bag:receive')
  @ApiOperation({ summary: 'Принять мешок брака по QR-коду' })
  @ApiOkResponse({ description: 'Мешок принят на склад' })
  @ApiConflictResponse({ description: 'Мешок не готов к приему' })
  receiveDefectBag(@CurrentActor() actor: Actor, @Body() dto: DefectBagScanDto) {
    return this.defectBagLogistics.receive(actor, dto);
  }

  @Post('defect-bags/shipments')
  @HttpCode(HttpStatus.OK)
  @RequireCapabilities('defect_bag:ship')
  @ApiOperation({ summary: 'Отгрузить принятый мешок брака по QR-коду' })
  @ApiOkResponse({ description: 'Мешок брака отгружен' })
  @ApiConflictResponse({ description: 'Мешок еще не принят на склад' })
  shipDefectBag(@CurrentActor() actor: Actor, @Body() dto: DefectBagScanDto) {
    return this.defectBagLogistics.ship(actor, dto);
  }

  @Get('tasks')
  @RequireCapabilities('warehouse_task:read')
  tasks(@Query('mode') mode?: string) {
    return this.service.listTasks(mode);
  }

  @Get('tasks/:taskId')
  @RequireCapabilities('warehouse_task:read')
  async task(@CurrentActor() actor: Actor, @Param('taskId') taskId: string) {
    const decisionTask = await this.reservationRecovery.readDecisionTask(actor, taskId);
    return decisionTask ?? this.service.getTask(taskId);
  }

  @Post('tasks/:taskId/coverage-physical-exception')
  @RequireCapabilities('warehouse_coverage:report_physical_exception')
  @ApiConflictResponse({
    description: 'Task, row, decision reservation, or coverage CAS changed.',
  })
  reportCoveragePhysicalException(
    @CurrentActor() actor: Actor,
    @Param('taskId') taskId: string,
    @Body() dto: CoveragePhysicalExceptionDto,
  ) {
    return this.reservationRecovery.reportPhysicalException(actor, taskId, dto);
  }

  @Post('tasks/:taskId/scans')
  @RequireCapabilities('warehouse:scan')
  scan(@CurrentActor() actor: Actor, @Param('taskId') taskId: string, @Body() dto: ScanDto) {
    return this.integrity.scan(actor, taskId, dto);
  }

  @Post('tasks/:taskId/close')
  @RequireCapabilities('warehouse:close')
  close(@CurrentActor() actor: Actor, @Param('taskId') taskId: string, @Body() dto: CloseTaskDto) {
    return this.service.closeTask({ userId: actor.userId, role: actor.role }, taskId, dto);
  }

  @Get('cover-checks')
  @RequireCapabilities('warehouse_task:read')
  @ApiOkResponse({ type: WarehouseCoverCheckPageResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor, page limit, or state' })
  coverChecks(@CurrentActor() actor: Actor, @Query() query: CoverCheckQueryDto) {
    return this.service.listCoverChecks(actor.role, query);
  }

  @Post('orders/:orderId/cover-proposals')
  @RequireCapabilities('warehouse_cover:propose')
  @ApiConflictResponse({ description: 'Manual warehouse proposals are available only for V1' })
  proposeCover(
    @CurrentActor() actor: Actor,
    @Param('orderId') orderId: string,
    @Body() dto: CoverProposeDto,
  ) {
    return this.service.proposeCover({ userId: actor.userId, role: actor.role }, orderId, dto);
  }

  @Get('rolls')
  @RequireCapabilities('warehouse_task:read')
  @ApiOkResponse({ type: WarehouseRollResponseDto, isArray: true })
  rolls(@Query() query: WarehouseRollQueryDto) {
    return this.service.listRolls(query.ownership);
  }

  @Get('finished-stock')
  @RequireCapabilities('warehouse_task:read')
  @ApiOkResponse({ type: FinishedStockPageResponseDto })
  finishedStockRolls(@Query() query: FinishedStockQueryDto) {
    return this.finishedStock.list(query);
  }

  @Post('finished-stock')
  @RequireCapabilities('reserve_roll:create')
  @ApiCreatedResponse({ type: WarehouseReserveRollResponseDto })
  @ApiBadRequestResponse({ description: 'The roll facts or material selection are invalid.' })
  @ApiConflictResponse({ description: 'The operation, roll code, or batch conflicts.' })
  createFinishedStockRoll(
    @CurrentActor() actor: Actor,
    @Body() dto: CreateWarehouseReserveRollDto,
  ) {
    return this.reserveRolls.create(actor, dto);
  }

  @Post('rolls/:rollId/reserve')
  @RequireCapabilities('roll:reserve')
  @ApiConflictResponse({ description: 'The roll is managed by an immutable V2 decision' })
  reserve(@CurrentActor() actor: Actor, @Param('rollId') rollId: string, @Body() dto: ReserveDto) {
    return this.service.reserveRoll({ userId: actor.userId, role: actor.role }, rollId, dto);
  }

  @Post('rolls/:rollId/release-reserve')
  @RequireCapabilities('roll:reserve')
  @ApiConflictResponse({ description: 'The roll is managed by an immutable V2 decision' })
  release(@CurrentActor() actor: Actor, @Param('rollId') rollId: string) {
    return this.service.releaseReserve({ userId: actor.userId, role: actor.role }, rollId);
  }

  @Post('pallet-lists')
  @RequireCapabilities('pallet_list:create')
  createPalletList(@CurrentActor() actor: Actor, @Body() dto: CreatePalletListDto) {
    return this.service.createPalletList({ userId: actor.userId, role: actor.role }, dto);
  }

  @Get('pallet-lists/:palletListId')
  @RequireCapabilities('warehouse_task:read')
  palletList(@Param('palletListId') palletListId: string) {
    return this.service.getPalletList(palletListId);
  }

  @Get('raw-materials')
  @RequireCapabilities('warehouse_task:read')
  rawMaterials() {
    return this.service.listRawMaterials();
  }

  @Post('raw-materials/push-to-1c')
  @RequireOneCRuntime()
  @RequireCapabilities('raw_material:adjust')
  @ApiOkResponse({ type: OneCStockPushResponseDto })
  @ApiConflictResponse({
    description: 'Snapshot already claimed, changed, or needs reconciliation.',
  })
  @ApiServiceUnavailableResponse({ description: '1С posting outcome requires reconciliation.' })
  pushToOneC(@CurrentActor() actor: Actor, @Body() dto: OneCStockPushDto) {
    return this.onecStockPush.push({ userId: actor.userId, role: actor.role }, dto);
  }

  @Get('raw-materials/onec-push-preview')
  @RequireOneCRuntime()
  @RequireCapabilities('raw_material:adjust')
  @ApiOkResponse({ type: OneCStockPushPreviewResponseDto })
  previewOneCPush() {
    return this.onecStockPush.preview();
  }

  @Post('raw-materials/:materialId/adjustments')
  @RequireCapabilities('raw_material:adjust')
  @ApiCreatedResponse({
    type: RawMaterialStockResponseDto,
    description: 'Updated stock; an identical correction retry is replayed without another fact.',
  })
  @ApiConflictResponse({
    description: 'The operation key is already used for another raw-material command.',
  })
  adjust(
    @CurrentActor() actor: Actor,
    @Param('materialId') materialId: string,
    @Body() dto: RawAdjustDto,
  ) {
    return this.service.adjustRawMaterial(
      { userId: actor.userId, role: actor.role },
      materialId,
      dto,
    );
  }

  @Post('raw-materials/:materialId/receipts')
  @RequireCapabilities('raw_material:adjust')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: RawMaterialStockResponseDto,
    description: 'Updated stock; an identical receipt retry is replayed safely.',
  })
  @ApiConflictResponse({
    description: 'The operation key is already used for another raw-material command.',
  })
  receiveRawMaterial(
    @CurrentActor() actor: Actor,
    @Param('materialId') materialId: string,
    @Body() dto: RawReceiptDto,
  ) {
    return this.service.receiveRawMaterial(
      { userId: actor.userId, role: actor.role },
      materialId,
      dto,
    );
  }
}
