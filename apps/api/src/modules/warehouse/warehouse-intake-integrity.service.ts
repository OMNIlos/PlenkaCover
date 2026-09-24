import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { WarehousePalletSelectionScanResult } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import {
  bindingIncident,
  bindingIncidentFingerprint,
  deviceConnectionFingerprint,
  deviceConnectionIncident,
  type PhysicalDeviceKind,
} from '../../common/operational-incidents/device-incident-signals';
import { OperationalIncidentReporter } from '../../common/operational-incidents/operational-incident-reporter.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RollTokenService } from '../../common/roll-token/roll-token.service';
import { isDeviceBackedWeightEvidence } from '../../common/weight-capture/device-backed-evidence';
import { SCANNER_ADAPTER, type ScannerAdapter } from '../../integrations/scanner/scanner.adapter';
import { SCALE_ADAPTER, type ScaleAdapter } from '../../integrations/scale/scale.adapter';
import { ProductionService } from '../production/production.service';
import type { ControlWeightDto, RollDamagedDto, ScanDto } from './dto/scan.dto';
import { WarehouseIntakeService } from './warehouse-intake.service';
import {
  WarehouseOperationService,
  type WarehouseOperationKind,
} from './warehouse-operation.service';
import { WarehousePalletService } from './warehouse-pallet.service';
import { WarehousePalletSelectionService } from './warehouse-pallet-selection.service';
import { WarehouseBrowserSessionService } from './warehouse-browser-session.service';
import { lockCoverageInventoryEpoch } from '../warehouse-coverage/warehouse-coverage-transaction';
import { deliverWarehouseRoll } from './warehouse-delivery-roll-transition';

type SafeScanResult = {
  operationId: string;
  taskId: string;
  rollCode: string;
  mode: string;
  scanStatus: 'accepted';
};

type SafeWeightResult = {
  operationId: string;
  taskId: string;
  rollCode: string;
  grossKg: number;
  spoolKg: number;
  netKg: number;
  toleranceOk: boolean;
  replacementRollCode: string | null;
};

type SafeDamageResult = {
  operationId: string;
  taskId: string;
  rollCode: string;
  scanStatus: 'damaged';
  problemId: string | null;
};

@Injectable()
export class WarehouseIntakeIntegrityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: RollTokenService,
    private readonly browserSession: WarehouseBrowserSessionService,
    private readonly operations: WarehouseOperationService,
    private readonly intake: WarehouseIntakeService,
    _production: ProductionService,
    @Inject(SCANNER_ADAPTER) private readonly scanner: ScannerAdapter,
    @Inject(SCALE_ADAPTER) _scale: ScaleAdapter,
    private readonly incidents: OperationalIncidentReporter,
    private readonly pallets: WarehousePalletService,
    private readonly palletSelection: WarehousePalletSelectionService,
  ) {}

  async scanByPayload(actor: Actor, dto: ScanDto) {
    const label = await this.resolveTokenOrAudit(actor, null, dto.payload);
    const rows = await this.prisma.scanRow.findMany({
      where: {
        rollCode: label.rollCode,
        task: {
          mode: 'receiving',
          status: { in: ['open', 'partial'] },
          coverageDecisionId: null,
        },
        scanStatus: { in: ['expected', 'accepted'] },
      },
      select: { taskId: true },
      take: 2,
    });
    if (rows.length !== 1) {
      const code = rows.length === 0 ? 'WAREHOUSE_TASK_ROLL_MISMATCH' : 'WAREHOUSE_TASK_AMBIGUOUS';
      await this.recordRejectedScan(actor, null, code, label.rollCode);
      throw new ConflictException({
        code,
        message: 'Метка не относится ровно к одной активной задаче приёмки.',
      });
    }
    return this.scanResolved(actor, rows[0].taskId, dto, label.rollCode);
  }

  async scan(actor: Actor, taskId: string, dto: ScanDto) {
    await this.assertLegacyTaskEndpoint(taskId);
    const label = await this.resolveTokenOrAudit(actor, taskId, dto.payload);
    try {
      return await this.scanResolved(actor, taskId, dto, label.rollCode);
    } catch (error) {
      if (this.exceptionCode(error) === 'WAREHOUSE_TASK_ROLL_MISMATCH') {
        await this.recordRejectedScan(
          actor,
          taskId,
          'WAREHOUSE_TASK_ROLL_MISMATCH',
          label.rollCode,
        );
      }
      throw error;
    }
  }

  async scanPalletSelection(
    actor: Actor,
    taskId: string,
    dto: ScanDto,
  ): Promise<WarehousePalletSelectionScanResult> {
    await this.assertLegacyTaskEndpoint(taskId);
    const label = await this.resolveTokenOrAudit(actor, taskId, dto.payload);
    const row = await this.prisma.scanRow.findFirst({
      where: { taskId, rollCode: label.rollCode, scanStatus: 'accepted' },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!row) {
      await this.recordRejectedScan(
        actor,
        taskId,
        'WAREHOUSE_PALLET_ROLL_NOT_ACCEPTED',
        label.rollCode,
      );
      throw this.palletRollNotAccepted();
    }

    const selection = await this.palletSelection.setSelection(actor, taskId, row.id, {
      operationKey: dto.operationKey,
      selected: true,
    });
    if (!selection.activePallet) throw this.inventoryConflict();
    return {
      operationKey: dto.operationKey.toLowerCase(),
      taskId,
      scanRowId: row.id,
      rollCode: label.rollCode,
      outcome: selection.selectionChanged ? 'added' : 'already_selected',
      activePallet: selection.activePallet,
    };
  }

  private async scanResolved(actor: Actor, taskId: string, dto: ScanDto, rollCode: string) {
    const outcome = await this.serializable(async (tx) => {
      const identity = await this.browserSession.resolve(actor, tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-roll:${rollCode}`}))`;
      await lockCoverageInventoryEpoch(tx);
      await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${taskId} FOR UPDATE`;

      const task = await tx.warehouseAcceptanceTask.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          mode: true,
          status: true,
          orderId: true,
          positionId: true,
          proposalId: true,
          coverageDecisionId: true,
        },
      });
      if (!task) throw this.taskNotFound();
      this.assertLegacyTaskRecord(task);
      if (!['open', 'partial'].includes(task.status)) {
        throw new ConflictException({
          code: 'WAREHOUSE_TASK_CLOSED',
          message: 'Закрытая складская задача неизменяема.',
        });
      }
      const row = await tx.scanRow.findFirst({
        where: { taskId, rollCode, scanStatus: { in: ['expected', 'accepted'] } },
        orderBy: { id: 'asc' },
      });
      if (!row) {
        throw new ConflictException({
          code: 'WAREHOUSE_TASK_ROLL_MISMATCH',
          message: 'Метка не относится к выбранной задаче.',
        });
      }
      await tx.$queryRaw`SELECT "id" FROM "scan_rows" WHERE "id" = ${row.id} FOR UPDATE`;

      const kind = this.scanKind(task.mode);
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        kind,
        taskId,
        scanRowId: row.id,
        rollCode,
        actorId: actor.userId!,
        sessionId: identity.session.id,
        postId: null,
        deviceId: null,
        captureChannel: 'warehouse_browser_hid',
        fingerprintInput: {},
      });
      if (claim.kind === 'replay') {
        return {
          kind: 'result' as const,
          result: this.savedResult(claim.operation.safeResult),
          replayed: true,
        };
      }
      if (row.scanStatus !== 'expected') {
        throw new ConflictException({
          code: 'WAREHOUSE_SCAN_ALREADY_ACCEPTED',
          message: 'Рулон уже обработан другой физической операцией.',
        });
      }

      const acceptedAt = new Date();
      await this.applyInventoryTransition(tx, task, row.id, rollCode);
      const user = await tx.user.findUnique({
        where: { id: actor.userId! },
        select: { displayName: true },
      });
      const accepted = await tx.scanRow.updateMany({
        where: { id: row.id, taskId, rollCode, scanStatus: 'expected' },
        data: {
          scanStatus: 'accepted',
          lastScanAt: acceptedAt,
          scannedByName: user?.displayName ?? undefined,
        },
      });
      if (accepted.count !== 1) throw this.inventoryConflict();

      const safe: SafeScanResult = {
        operationId: claim.operation.id,
        taskId,
        rollCode,
        mode: task.mode,
        scanStatus: 'accepted',
      };
      await this.audit.record(
        {
          type: this.scanEvent(task.mode),
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: rollCode,
          detail: {
            warehouseOperationId: claim.operation.id,
            taskId,
            scanRowId: row.id,
            rollCode,
            mode: task.mode,
            captureChannel: 'warehouse_browser_hid',
          },
        },
        tx,
      );
      if (task.mode === 'receiving') {
        const acceptedStock = await tx.warehouseRoll.findUnique({
          where: { rollCode },
          select: { id: true, producedForStockOrderId: true },
        });
        if (acceptedStock?.producedForStockOrderId) {
          await this.audit.record(
            {
              type: 'audit:finished_stock_created',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: acceptedStock.id,
              detail: {
                rollCode,
                sourceStockOrderId: acceptedStock.producedForStockOrderId,
                taskId,
              },
            },
            tx,
          );
        }
      }
      await this.recordRecovery(tx, actor, {
        operationId: claim.operation.id,
        recoveredOperationId: claim.recoveryFromId,
        taskId,
        scanRowId: row.id,
        rollCode,
        kind,
      });
      await this.operations.complete(tx, claim.operation.id, safe);
      return {
        kind: 'result' as const,
        result: safe,
        replayed: false,
      };
    });
    return {
      ...outcome.result,
      replayed: outcome.replayed,
      task: await this.intake.projectTaskById(taskId, actor.role),
    };
  }

  async controlWeight(actor: Actor, taskId: string, _dto: ControlWeightDto): Promise<never> {
    await this.assertLegacyTaskEndpoint(taskId);
    await this.browserSession.resolve(actor);
    throw new ServiceUnavailableException({
      code: 'WAREHOUSE_SCALE_NOT_CONFIGURED',
      message: 'Контрольное взвешивание недоступно: отдельные весы склада ещё не настроены.',
    });
  }

  async markDamaged(actor: Actor, taskId: string, dto: RollDamagedDto) {
    await this.assertLegacyTaskEndpoint(taskId);
    const reason = dto.reason.trim();
    if (!reason || reason.length > 500) {
      throw new UnprocessableEntityException({
        code: 'WAREHOUSE_DEFECT_REASON_INVALID',
        message: 'Укажите причину повреждения длиной от 1 до 500 символов.',
      });
    }
    const outcome = await this.serializable(async (tx) => {
      const identity = await this.browserSession.resolve(actor, tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-roll:${dto.rollCode}`}))`;
      await lockCoverageInventoryEpoch(tx);
      await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${taskId} FOR UPDATE`;
      const task = await tx.warehouseAcceptanceTask.findUnique({ where: { id: taskId } });
      if (!task) throw this.taskNotFound();
      this.assertLegacyTaskRecord(task);
      if (!['open', 'partial'].includes(task.status)) throw this.taskClosed();
      if (task.mode !== 'receiving') {
        throw new ConflictException({
          code: 'WAREHOUSE_DAMAGE_TASK_MODE_INVALID',
          message: 'Повреждение рулона фиксируется только в задаче приёмки.',
        });
      }
      const row = await tx.scanRow.findFirst({
        where: {
          taskId,
          rollCode: dto.rollCode,
          scanStatus: { in: ['accepted', 'damaged'] },
        },
        orderBy: { id: 'asc' },
      });
      if (!row) throw this.taskRollMismatch();
      await tx.$queryRaw`SELECT "id" FROM "scan_rows" WHERE "id" = ${row.id} FOR UPDATE`;
      await this.requireCompletedScan(tx, row.id);
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        kind: 'mark_damaged',
        taskId,
        scanRowId: row.id,
        rollCode: dto.rollCode,
        actorId: actor.userId!,
        sessionId: identity.session.id,
        postId: null,
        deviceId: null,
        captureChannel: 'warehouse_role_action',
        fingerprintInput: { reason },
      });
      if (claim.kind === 'replay') {
        return { result: this.savedDamageResult(claim.operation.safeResult), replayed: true };
      }
      if (row.scanStatus !== 'accepted') throw this.rollNotReady();
      const line = await tx.operatorRollLine.findFirst({
        where: { rollDispatchItem: { rollCode: dto.rollCode } },
        include: { rollDispatchItem: { include: { productionOrder: true } } },
      });
      const roll = await tx.warehouseRoll.findUnique({ where: { rollCode: dto.rollCode } });
      if (!line || roll?.warehouseStatus !== 'received') {
        throw this.rollNotReady();
      }
      const orderId = line.rollDispatchItem.productionOrder?.commercialOrderId ?? null;
      if (!orderId) {
        throw new ConflictException({
          code: 'WAREHOUSE_DEFECT_ORDER_INTEGRITY_ERROR',
          message: 'Принятый рулон не связан с коммерческим заказом.',
        });
      }
      const evidence = await tx.weightCapture.findFirst({
        where: {
          operatorRollLineId: line.id,
          kind: 'control',
          deviceId: { not: null },
          deviceStatus: 'ready',
          stable: true,
          grossKg: { gt: 0 },
          spoolKg: { gte: 0 },
          netKg: { gt: 0 },
          warehouseOperation: {
            taskId,
            rollCode: dto.rollCode,
            kind: 'control_weight',
            status: 'succeeded',
          },
        },
        select: {
          id: true,
          deviceId: true,
          deviceStatus: true,
          stable: true,
          grossKg: true,
          spoolKg: true,
          netKg: true,
          postId: true,
          postSessionId: true,
          operationId: true,
          warehouseOperationId: true,
          operation: {
            select: {
              id: true,
              action: true,
              status: true,
              deviceId: true,
              postId: true,
              postSessionId: true,
              resultRef: true,
            },
          },
          warehouseOperation: {
            select: {
              id: true,
              kind: true,
              status: true,
              taskId: true,
              rollCode: true,
              deviceId: true,
              postId: true,
              safeResult: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (
        !isDeviceBackedWeightEvidence(evidence, {
          source: 'warehouse',
          expectedRollCode: dto.rollCode,
        })
      ) {
        throw new ConflictException({
          code: 'WAREHOUSE_DEFECT_CONTROL_WEIGHT_REQUIRED',
          message: 'Сначала выполните контрольное взвешивание на весах склада.',
        });
      }
      const existingProblem = await tx.productionProblem.findFirst({
        where: { rollId: dto.rollCode, type: 'defect', status: 'open' },
      });
      if (existingProblem) {
        throw new ConflictException({
          code: 'WAREHOUSE_DEFECT_ALREADY_REPORTED',
          message: 'По рулону уже открыта проблема брака.',
        });
      }
      await this.pallets.releaseActiveMembership(tx, {
        actor,
        taskId,
        scanRowId: row.id,
        reason: 'defect_reported',
      });
      const damaged = await tx.scanRow.updateMany({
        where: { id: row.id, scanStatus: 'accepted' },
        data: { scanStatus: 'damaged' },
      });
      const inventory = await tx.warehouseRoll.updateMany({
        where: { id: roll.id, warehouseStatus: 'received' },
        data: { warehouseStatus: 'defect' },
      });
      const lineUpdate = await tx.operatorRollLine.updateMany({
        where: { id: line.id, warehouseState: 'received' },
        data: { warehouseState: 'defect' },
      });
      if (damaged.count !== 1 || inventory.count !== 1 || lineUpdate.count !== 1) {
        throw this.inventoryConflict();
      }
      const defect = await tx.defectRecord.create({
        data: {
          operatorRollLineId: line.id,
          weightCaptureId: evidence.id,
          sourceRole: actor.role,
          weightKg: evidence.netKg,
          comment: reason,
          blocking: true,
        },
      });
      const problem = await tx.productionProblem.create({
        data: {
          type: 'defect',
          orderId,
          rollId: dto.rollCode,
          actorRole: actor.role,
          reason,
          defectRecordId: defect.id,
        },
      });
      await this.audit.record(
        {
          type: 'audit:defect_recorded',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: dto.rollCode,
          reason,
          detail: {
            warehouseOperationId: claim.operation.id,
            taskId,
            problemId: problem.id,
            defectId: defect.id,
            evidenceId: evidence.id,
            rollId: dto.rollCode,
            rollCode: dto.rollCode,
            weightKg: evidence.netKg,
            source: 'warehouse_control_scale',
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'problem:warehouse_defect_reported',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          reason,
          detail: {
            warehouseOperationId: claim.operation.id,
            taskId,
            problemId: problem.id,
            defectId: defect.id,
            evidenceId: evidence.id,
            rollId: dto.rollCode,
            rollCode: dto.rollCode,
            weightKg: evidence.netKg,
          },
        },
        tx,
      );
      const safe: SafeDamageResult = {
        operationId: claim.operation.id,
        taskId,
        rollCode: dto.rollCode,
        scanStatus: 'damaged',
        problemId: problem.id,
      };
      await this.recordRecovery(tx, actor, {
        operationId: claim.operation.id,
        recoveredOperationId: claim.recoveryFromId,
        taskId,
        scanRowId: row.id,
        rollCode: dto.rollCode,
        kind: 'mark_damaged',
      });
      await this.operations.complete(tx, claim.operation.id, safe);
      return { result: safe, replayed: false };
    });
    return {
      ...outcome.result,
      replayed: outcome.replayed,
      task: await this.intake.projectTaskById(taskId, actor.role),
    };
  }

  private async failWeight(
    actor: Actor,
    claim: {
      operationId: string;
      rowId: string;
      postId: string;
      sessionId: string;
      deviceId: string;
      leaseToken: string;
    },
    status: string,
    errorCode = 'WAREHOUSE_SCALE_UNAVAILABLE',
  ) {
    const failed = await this.serializable(async (tx) => {
      const operation = await tx.warehouseOperation.findFirst({
        where: {
          id: claim.operationId,
          status: 'in_progress',
          leaseToken: claim.leaseToken,
        },
      });
      if (!operation) return false;
      await this.operations.fail(tx, operation.id, errorCode, 503, claim.leaseToken);
      await this.audit.record(
        {
          type:
            errorCode === 'WAREHOUSE_SCALE_UNAVAILABLE'
              ? 'device.scale.offline'
              : 'audit:warehouse_control_weight_failed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: operation.rollCode,
          detail: {
            warehouseOperationId: operation.id,
            taskId: operation.taskId,
            scanRowId: claim.rowId,
            postId: claim.postId,
            sessionId: claim.sessionId,
            reasonCode:
              errorCode === 'WAREHOUSE_SCALE_UNAVAILABLE'
                ? this.safeDeviceStatus(status)
                : errorCode,
          },
        },
        tx,
      );
      return true;
    });
    if (failed && errorCode === 'WAREHOUSE_SCALE_UNAVAILABLE') {
      await this.reportDeviceFailure(claim.deviceId, 'scale');
    }
  }

  private async recordRecovery(
    tx: Prisma.TransactionClient,
    actor: Actor,
    input: {
      operationId: string;
      recoveredOperationId: string | null | undefined;
      taskId: string;
      scanRowId: string;
      rollCode: string;
      kind: WarehouseOperationKind;
    },
  ) {
    if (!input.recoveredOperationId) return;
    await this.audit.record(
      {
        type: 'audit:warehouse_physical_operation_recovered',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: input.rollCode,
        detail: {
          warehouseOperationId: input.operationId,
          recoveredOperationId: input.recoveredOperationId,
          taskId: input.taskId,
          scanRowId: input.scanRowId,
          rollCode: input.rollCode,
          kind: input.kind,
        },
      },
      tx,
    );
  }

  private reportBindingFailure(postId: string, kind: PhysicalDeviceKind): Promise<void> {
    return this.incidents.signal(bindingIncident(postId, kind));
  }

  private async reportUnavailableBinding(
    postId: string,
    kind: PhysicalDeviceKind,
    deviceId: string | null,
  ): Promise<void> {
    if (!deviceId) {
      await this.reportBindingFailure(postId, kind);
      return;
    }
    await Promise.all([
      this.reportBindingReady(postId, kind),
      this.reportDeviceFailure(deviceId, kind),
    ]);
  }

  private reportBindingReady(postId: string, kind: PhysicalDeviceKind): Promise<void> {
    return this.incidents.resolve(
      bindingIncidentFingerprint(postId, kind),
      'Warehouse post binding verified.',
    );
  }

  private reportDeviceFailure(deviceId: string, kind: PhysicalDeviceKind): Promise<void> {
    return this.incidents.signal(deviceConnectionIncident(deviceId, kind));
  }

  private reportDeviceReady(deviceId: string): Promise<void> {
    return this.incidents.resolve(
      deviceConnectionFingerprint(deviceId),
      'Warehouse physical device operation succeeded.',
    );
  }

  private async expireStaleControlWeights(
    tx: Prisma.TransactionClient,
    actor: Actor,
    taskId: string,
    scanRowId: string,
  ) {
    const expired = await this.operations.expireStaleControlWeights(tx, { taskId, scanRowId });
    for (const operation of expired) {
      await this.audit.record(
        {
          type: 'audit:warehouse_physical_operation_expired',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: operation.rollCode,
          detail: {
            warehouseOperationId: operation.id,
            taskId: operation.taskId,
            scanRowId: operation.scanRowId,
            rollCode: operation.rollCode,
            postId: operation.postId,
            sessionId: operation.sessionId,
            reasonCode: 'WAREHOUSE_CONTROL_WEIGHT_LEASE_EXPIRED',
          },
        },
        tx,
      );
    }
    return expired;
  }

  private async requireCompletedScan(tx: Prisma.TransactionClient, scanRowId: string) {
    const scan = await tx.warehouseOperation.findFirst({
      where: {
        scanRowId,
        kind: { in: ['receiving_scan', 'reserve_scan', 'delivery_scan'] },
        status: 'succeeded',
      },
      select: { id: true },
    });
    if (!scan) throw this.rollNotReady();
  }

  private savedWeightResult(value: Prisma.JsonValue | null): SafeWeightResult {
    const source = this.savedObject(value);
    if (
      typeof source.operationId !== 'string' ||
      typeof source.taskId !== 'string' ||
      typeof source.rollCode !== 'string' ||
      typeof source.grossKg !== 'number' ||
      typeof source.spoolKg !== 'number' ||
      typeof source.netKg !== 'number' ||
      typeof source.toleranceOk !== 'boolean' ||
      !(typeof source.replacementRollCode === 'string' || source.replacementRollCode === null)
    ) {
      throw this.inventoryConflict();
    }
    return source as SafeWeightResult;
  }

  private savedDamageResult(value: Prisma.JsonValue | null): SafeDamageResult {
    const source = this.savedObject(value);
    if (
      typeof source.operationId !== 'string' ||
      typeof source.taskId !== 'string' ||
      typeof source.rollCode !== 'string' ||
      source.scanStatus !== 'damaged' ||
      !(typeof source.problemId === 'string' || source.problemId === null)
    ) {
      throw this.inventoryConflict();
    }
    return source as SafeDamageResult;
  }

  private savedObject(value: Prisma.JsonValue | null): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw this.inventoryConflict();
    }
    return value as Record<string, unknown>;
  }

  private async resolveTokenOrAudit(actor: Actor, taskId: string | null, payload: string) {
    try {
      return await this.resolveToken(payload);
    } catch (error) {
      if (this.exceptionCode(error) === 'WAREHOUSE_SCAN_TOKEN_INVALID') {
        await this.recordRejectedScan(actor, taskId, 'WAREHOUSE_SCAN_TOKEN_INVALID');
      }
      throw error;
    }
  }

  private async recordRejectedScan(
    actor: Actor,
    taskId: string | null,
    reasonCode: string,
    rollCode?: string,
  ) {
    await this.audit.record({
      type: 'device.scan.mismatch',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: rollCode ?? taskId,
      detail: { taskId, reasonCode },
    });
  }

  private async resolveToken(
    payload: string,
    client: Pick<Prisma.TransactionClient, 'rollScanToken'> = this.prisma,
  ) {
    let parsed: ReturnType<ScannerAdapter['parse']>;
    try {
      parsed = this.scanner.parse(payload);
    } catch {
      parsed = { token: null, valid: false };
    }
    const label =
      parsed.valid && parsed.token ? await this.tokens.findExact(parsed.token, client) : null;
    if (!label) {
      throw new UnprocessableEntityException({
        code: 'WAREHOUSE_SCAN_TOKEN_INVALID',
        message: 'Физическая метка не распознана.',
      });
    }
    return label;
  }

  private async applyInventoryTransition(
    tx: Prisma.TransactionClient,
    task: {
      mode: string;
      orderId: string | null;
      positionId: string | null;
      proposalId: string | null;
    },
    rowId: string,
    rollCode: string,
  ) {
    void rowId;
    if (task.mode === 'delivery') {
      await deliverWarehouseRoll(tx, task, rollCode);
      return;
    }

    await tx.$queryRaw`SELECT "id" FROM "warehouse_rolls" WHERE "rollCode" = ${rollCode} FOR UPDATE`;
    const roll = await tx.warehouseRoll.findUnique({ where: { rollCode } });
    if (!roll) throw this.rollNotReady();

    if (task.mode === 'receiving') {
      const line = await tx.operatorRollLine.findFirst({
        where: { rollDispatchItem: { rollCode } },
        include: { rollDispatchItem: true },
      });
      if (
        !line ||
        line.step !== 'warehouse' ||
        line.warehouseState !== 'sent' ||
        line.rollDispatchItem.status !== 'ready_for_warehouse' ||
        roll.warehouseStatus !== 'sent'
      ) {
        throw this.rollNotReady();
      }
      const inventory = await tx.warehouseRoll.updateMany({
        where: { id: roll.id, warehouseStatus: 'sent' },
        data: { warehouseStatus: 'received', receivedAt: new Date() },
      });
      const lineUpdate = await tx.operatorRollLine.updateMany({
        where: { id: line.id, step: 'warehouse', warehouseState: 'sent' },
        data: { warehouseState: 'received' },
      });
      const dispatch = await tx.rollDispatchItem.updateMany({
        where: { id: line.rollDispatchItemId, status: 'ready_for_warehouse' },
        data: { status: 'done', completedAt: new Date() },
      });
      if (inventory.count !== 1 || lineUpdate.count !== 1 || dispatch.count !== 1) {
        throw this.inventoryConflict();
      }
      return;
    }

    if (roll.warehouseStatus !== 'received') throw this.rollNotReady();
    if (task.mode !== 'reserve') throw this.rollNotReady();
    if (!task.orderId || roll.reservedForOrderId !== task.orderId) throw this.rollNotReady();
    if (task.positionId && roll.reservedForPositionId !== task.positionId) {
      throw this.rollNotReady();
    }
    if (!task.proposalId || roll.reservedByProposalId !== task.proposalId) {
      throw this.rollNotReady();
    }
  }

  private scanKind(mode: string): WarehouseOperationKind {
    if (mode === 'receiving') return 'receiving_scan';
    if (mode === 'reserve') return 'reserve_scan';
    if (mode === 'delivery') return 'delivery_scan';
    throw this.rollNotReady();
  }

  private scanEvent(mode: string) {
    if (mode === 'receiving') return 'audit:warehouse_roll_received';
    if (mode === 'delivery') return 'audit:warehouse_roll_shipped';
    return 'audit:warehouse_reserve_roll_verified';
  }

  private savedResult(value: Prisma.JsonValue | null): SafeScanResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw this.inventoryConflict();
    }
    const source = value as Record<string, unknown>;
    if (
      typeof source.operationId !== 'string' ||
      typeof source.taskId !== 'string' ||
      typeof source.rollCode !== 'string' ||
      typeof source.mode !== 'string' ||
      source.scanStatus !== 'accepted'
    ) {
      throw this.inventoryConflict();
    }
    return source as SafeScanResult;
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (this.isSerializationFailure(error) && attempt < 2) continue;
        if (this.isSerializationFailure(error)) throw this.inventoryConflict();
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          if (attempt < 2) continue;
          throw this.inventoryConflict();
        }
        throw error;
      }
    }
    throw this.inventoryConflict();
  }

  private async assertLegacyTaskEndpoint(taskId: string): Promise<void> {
    const task = await this.prisma.warehouseAcceptanceTask.findUnique({
      where: { id: taskId },
      select: { coverageDecisionId: true },
    });
    if (!task) throw this.taskNotFound();
    this.assertLegacyTaskRecord(task);
  }

  private assertLegacyTaskRecord(task: { coverageDecisionId?: string | null }): void {
    if (task.coverageDecisionId) {
      throw new ConflictException({
        statusCode: 409,
        code: 'warehouse_coverage_decision_managed_task',
        decisionId: task.coverageDecisionId,
      });
    }
  }

  private taskNotFound() {
    return new NotFoundException({
      code: 'WAREHOUSE_TASK_NOT_FOUND',
      message: 'Складская задача не найдена.',
    });
  }

  private taskClosed() {
    return new ConflictException({
      code: 'WAREHOUSE_TASK_CLOSED',
      message: 'Закрытая складская задача неизменяема.',
    });
  }

  private taskRollMismatch() {
    return new ConflictException({
      code: 'WAREHOUSE_TASK_ROLL_MISMATCH',
      message: 'Рулон не относится к выбранной задаче.',
    });
  }

  private palletRollNotAccepted() {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_ROLL_NOT_ACCEPTED',
      message: 'В палетный лист можно добавить только принятый рулон текущей задачи.',
    });
  }

  private rollNotReady() {
    return new ConflictException({
      code: 'WAREHOUSE_ROLL_NOT_READY',
      message: 'Рулон не находится в допустимом физическом состоянии.',
    });
  }

  private inventoryConflict() {
    return new ConflictException({
      code: 'WAREHOUSE_INVENTORY_CONFLICT',
      message: 'Складское состояние изменилось конкурентно. Обновите задачу.',
    });
  }

  private scaleUnavailable() {
    return new ServiceUnavailableException({
      code: 'WAREHOUSE_SCALE_UNAVAILABLE',
      message: 'Весы склада не вернули допустимое стабильное измерение.',
    });
  }

  private controlWeightCommitFailed() {
    return new ServiceUnavailableException({
      code: 'WAREHOUSE_CONTROL_WEIGHT_COMMIT_FAILED',
      message: 'Измерение получено, но складской факт не удалось атомарно зафиксировать.',
    });
  }

  private deviceUnavailable(code: 'WAREHOUSE_SCANNER_NOT_BOUND' | 'WAREHOUSE_SCALE_NOT_BOUND') {
    return new ServiceUnavailableException({
      code,
      message: 'Оборудование складского поста отсутствует, неоднозначно или не готово.',
    });
  }

  private exceptionCode(error: unknown): string | null {
    const response = this.exceptionResponse(error);
    const code = response.code;
    return typeof code === 'string' ? code : null;
  }

  private isDeviceBindingFailure(
    code: string | null,
    warehouseCode: 'WAREHOUSE_SCANNER_NOT_BOUND' | 'WAREHOUSE_SCALE_NOT_BOUND',
  ): boolean {
    return (
      code === warehouseCode ||
      code?.startsWith('POST_') === true ||
      code?.startsWith('GATEWAY_') === true
    );
  }

  private exceptionResponse(error: unknown): Record<string, unknown> {
    if (!error || typeof error !== 'object') return {};
    const source = error as {
      response?: unknown;
      getResponse?: () => unknown;
    };
    const response =
      typeof source.getResponse === 'function' ? source.getResponse() : source.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return {};
    return response as Record<string, unknown>;
  }

  private exceptionDeviceId(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const source = error as { response?: unknown; getResponse?: () => unknown };
    const response =
      typeof source.getResponse === 'function' ? source.getResponse() : source.response;
    if (!response || typeof response !== 'object') return null;
    const deviceId = (response as { deviceId?: unknown }).deviceId;
    return typeof deviceId === 'string' && deviceId.length > 0 ? deviceId : null;
  }

  private isSerializationFailure(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code === 'P2034') return true;
    const meta = error.meta as { code?: unknown } | undefined;
    return error.code === 'P2010' && meta?.code === '40001';
  }

  private safeDeviceStatus(status: string) {
    return ['offline', 'unstable', 'stale', 'error'].includes(status) ? status : 'unavailable';
  }
}
