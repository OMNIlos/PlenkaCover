import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
  type WarehousePalletDeliveryScanResult,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  deliveryScopeKey,
  OrderFulfillmentHandoffService,
} from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { lockCoverageInventoryEpoch } from '../warehouse-coverage/warehouse-coverage-transaction';
import type { PalletDeliveryScanDto } from './dto/pallet-delivery-scan.dto';
import { deliverWarehouseRoll } from './warehouse-delivery-roll-transition';
import { WarehouseBrowserSessionService } from './warehouse-browser-session.service';
import { WarehouseOperationService } from './warehouse-operation.service';
import {
  exactPalletStrings,
  PALLET_SCAN_TOKEN_SELECT,
  PHYSICAL_PALLET_DOCUMENT_SELECT,
  type ValidatedPhysicalPallet,
  validatedPhysicalPallet,
} from './warehouse-pallet-scan-evidence';
import { WarehouseService } from './warehouse.service';

const COMMAND_SELECT = {
  kind: true,
  taskId: true,
  scanRowId: true,
  palletId: true,
  actorId: true,
  requestFingerprint: true,
  resultSnapshot: true,
} satisfies Prisma.WarehousePalletCommandSelect;

const DELIVERY_TASK_SELECT = {
  id: true,
  mode: true,
  status: true,
  orderId: true,
  positionId: true,
  proposalId: true,
  coverageDecisionId: true,
  receivingScopeKey: true,
  deliveryScopeKey: true,
  rows: {
    select: {
      id: true,
      taskId: true,
      rollCode: true,
      fromOrderId: true,
      scanStatus: true,
      lastScanAt: true,
      operations: {
        where: { kind: 'delivery_scan', status: 'succeeded' },
        select: {
          taskId: true,
          scanRowId: true,
          rollCode: true,
          kind: true,
          status: true,
        },
      },
    },
    orderBy: [{ rollCode: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.WarehouseAcceptanceTaskSelect;

const DELIVERY_ROLL_SELECT = {
  id: true,
  rollCode: true,
  warehouseStatus: true,
  receivedAt: true,
  reservedForOrderId: true,
  reservedForPositionId: true,
  producedForOrderId: true,
  releasedFromOrderId: true,
  producedForPositionId: true,
  producedByCoverageDecisionId: true,
} satisfies Prisma.WarehouseRollSelect;

type StoredCommand = Prisma.WarehousePalletCommandGetPayload<{
  select: typeof COMMAND_SELECT;
}>;
type DeliveryTask = Prisma.WarehouseAcceptanceTaskGetPayload<{
  select: typeof DELIVERY_TASK_SELECT;
}>;
type DeliveryRoll = Prisma.WarehouseRollGetPayload<{
  select: typeof DELIVERY_ROLL_SELECT;
}>;
type ScanCommand = {
  operationKey: string;
  payload: string;
  fingerprint: string;
};
type ValidatedDelivery = {
  task: DeliveryTask;
  expectedPalletRows: DeliveryTask['rows'];
  alreadyDeliveredPalletCount: number;
};

const RESULT_IDENTIFIER_MAX_LENGTH = 200;

function scanFingerprint(payload: string): string {
  return requestFingerprint({ command: 'warehouse_pallet_delivery_scan', payload });
}

function compareBinary(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

@Injectable()
export class WarehousePalletDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly fulfillment: OrderFulfillmentHandoffService,
    private readonly browserSession: WarehouseBrowserSessionService,
    private readonly operations: WarehouseOperationService,
    private readonly warehouse: WarehouseService,
  ) {}

  async scan(actor: Actor, dto: PalletDeliveryScanDto): Promise<WarehousePalletDeliveryScanResult> {
    const command: ScanCommand = {
      operationKey: dto.operationKey.toLowerCase(),
      payload: dto.payload,
      fingerprint: scanFingerprint(dto.payload),
    };
    const existing = await this.prisma.warehousePalletCommand.findUnique({
      where: { operationKey: command.operationKey },
      select: COMMAND_SELECT,
    });
    if (existing) return this.replay(existing, actor, command);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.execute(tx, actor, command), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!this.retryable(error)) throw error;
        if (this.uniqueViolation(error)) {
          const winner = await this.prisma.warehousePalletCommand.findUnique({
            where: { operationKey: command.operationKey },
            select: COMMAND_SELECT,
          });
          if (winner) return this.replay(winner, actor, command);
        }
        if (attempt < 2) continue;
        throw this.concurrentChange();
      }
    }
    throw this.concurrentChange();
  }

  private async execute(
    tx: Prisma.TransactionClient,
    actor: Actor,
    command: ScanCommand,
  ): Promise<WarehousePalletDeliveryScanResult> {
    const identity = await this.browserSession.resolve(actor, tx);
    if (!actor.userId) throw this.stateConflict();

    const token = await tx.palletScanToken.findUnique({
      where: { token: command.payload },
      select: PALLET_SCAN_TOKEN_SELECT,
    });
    if (!token) throw this.qrNotFound();
    const preliminary = token.document;
    const receivingTaskId = preliminary.acceptanceTaskId;
    const palletId = preliminary.warehousePalletId;
    const orderId = preliminary.warehousePallet?.orderId;
    if (!receivingTaskId || !palletId || !orderId) throw this.stateConflict();

    await tx.$queryRaw`
      SELECT "id"
      FROM "warehouse_acceptance_tasks"
      WHERE "id" = ${receivingTaskId}
      FOR UPDATE
    `;
    const lockProof = await this.fulfillment.acquireDeliveryScopeLock(tx, orderId);
    await tx.$queryRaw`SELECT "id" FROM "warehouse_pallets" WHERE "id" = ${palletId} FOR UPDATE`;
    await tx.$queryRaw`
      SELECT "id"
      FROM "pallet_list_documents"
      WHERE "id" = ${token.documentId}
      FOR UPDATE
    `;

    const document = await tx.palletListDocument.findUnique({
      where: { id: token.documentId },
      select: PHYSICAL_PALLET_DOCUMENT_SELECT,
    });
    if (!document) throw this.stateConflict();
    const rollCodes = exactPalletStrings(document.rollIds);
    if (
      !rollCodes ||
      rollCodes.length === 0 ||
      rollCodes.length > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT
    ) {
      throw this.stateConflict();
    }
    const pallet = validatedPhysicalPallet(document, rollCodes);
    if (!pallet) throw this.stateConflict();

    await tx.$queryRaw`
      SELECT "id"
      FROM "warehouse_pallet_items"
      WHERE "palletId" = ${palletId} AND "releasedAt" IS NULL
      ORDER BY "position", "id"
      FOR UPDATE
    `;

    const order = await tx.commercialOrder.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true },
    });
    if (!order) throw this.deliveryMismatch();
    let scopedTask = await tx.warehouseAcceptanceTask.findUnique({
      where: { deliveryScopeKey: deliveryScopeKey(orderId) },
      select: DELIVERY_TASK_SELECT,
    });
    let orderCompletionState: 'incomplete' | 'ready_for_shipment' = 'ready_for_shipment';
    if (scopedTask?.status !== 'closed') {
      const handoff = await this.fulfillment.reconcilePalletScan(
        { userId: actor.userId, role: actor.role },
        pallet.orderId,
        pallet.rollCodes,
        tx,
        lockProof,
      );
      if (
        (handoff.state !== 'incomplete' && handoff.state !== 'ready_for_shipment') ||
        !handoff.deliveryTaskId ||
        handoff.reason !== null
      ) {
        throw this.deliveryMismatch();
      }
      orderCompletionState = handoff.state;
      scopedTask = await tx.warehouseAcceptanceTask.findUnique({
        where: { deliveryScopeKey: deliveryScopeKey(orderId) },
        select: DELIVERY_TASK_SELECT,
      });
      if (scopedTask?.id !== handoff.deliveryTaskId) throw this.deliveryMismatch();
    }
    this.validateTaskEnvelope(scopedTask, pallet, order.orderNumber);

    const taskRollCodes = scopedTask!.rows.map((row) => row.rollCode).sort(compareBinary);
    for (const rollCode of taskRollCodes) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`warehouse-roll:${rollCode}`}))
      `;
    }
    await lockCoverageInventoryEpoch(tx);
    await tx.$queryRaw`
      SELECT "id"
      FROM "warehouse_acceptance_tasks"
      WHERE "id" = ${scopedTask!.id}
      FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT "id"
      FROM "scan_rows"
      WHERE "taskId" = ${scopedTask!.id}
      ORDER BY "rollCode" COLLATE "C", "id"
      FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT "id"
      FROM "warehouse_rolls"
      WHERE "rollCode" = ANY(${taskRollCodes}::text[])
      ORDER BY "rollCode" COLLATE "C", "id"
      FOR UPDATE
    `;

    const replay = await tx.warehousePalletCommand.findUnique({
      where: { operationKey: command.operationKey },
      select: COMMAND_SELECT,
    });
    if (replay) return this.replay(replay, actor, command);

    const task = await tx.warehouseAcceptanceTask.findUnique({
      where: { id: scopedTask!.id },
      select: DELIVERY_TASK_SELECT,
    });
    const rolls = await tx.warehouseRoll.findMany({
      where: { rollCode: { in: taskRollCodes } },
      select: DELIVERY_ROLL_SELECT,
      orderBy: [{ rollCode: 'asc' }, { id: 'asc' }],
    });
    const delivery = this.validateDeliveryState(task, pallet, order.orderNumber, rolls);

    const user = await tx.user.findUnique({
      where: { id: actor.userId },
      select: { displayName: true },
    });
    let newlyDeliveredRollCount = 0;
    for (const row of delivery.expectedPalletRows) {
      const claim = await this.operations.claim(tx, {
        operationKey: randomUUID(),
        kind: 'delivery_scan',
        taskId: delivery.task.id,
        scanRowId: row.id,
        rollCode: row.rollCode,
        actorId: actor.userId,
        sessionId: identity.session.id,
        postId: null,
        deviceId: null,
        captureChannel: 'warehouse_browser_hid',
        fingerprintInput: {
          source: 'pallet_delivery_scan',
          documentId: pallet.documentId,
          palletId: pallet.palletId,
        },
      });
      if (claim.kind !== 'claimed') throw this.stateConflict();

      await deliverWarehouseRoll(tx, delivery.task, row.rollCode);
      const acceptedAt = new Date();
      const accepted = await tx.scanRow.updateMany({
        where: {
          id: row.id,
          taskId: delivery.task.id,
          rollCode: row.rollCode,
          scanStatus: 'expected',
        },
        data: {
          scanStatus: 'accepted',
          lastScanAt: acceptedAt,
          scannedByName: user?.displayName ?? undefined,
        },
      });
      if (accepted.count !== 1) throw this.concurrentChange();

      const safeResult = {
        operationId: claim.operation.id,
        taskId: delivery.task.id,
        rollCode: row.rollCode,
        mode: 'delivery',
        scanStatus: 'accepted' as const,
      };
      await this.audit.record(
        {
          type: 'audit:warehouse_roll_shipped',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: row.rollCode,
          detail: {
            warehouseOperationId: claim.operation.id,
            taskId: delivery.task.id,
            scanRowId: row.id,
            rollCode: row.rollCode,
            mode: 'delivery',
            documentId: pallet.documentId,
            palletId: pallet.palletId,
            captureChannel: 'warehouse_browser_hid',
          },
        },
        tx,
      );
      await this.operations.complete(
        tx,
        claim.operation.id,
        safeResult as unknown as Prisma.InputJsonValue,
      );
      newlyDeliveredRollCount += 1;
    }

    const remainingRollCount = await tx.scanRow.count({
      where: { taskId: delivery.task.id, scanStatus: 'expected' },
    });
    let taskStatus = delivery.task.status as WarehousePalletDeliveryScanResult['taskStatus'];
    if (remainingRollCount === 0 && delivery.task.status !== 'closed') {
      const closeMode = orderCompletionState === 'ready_for_shipment' ? 'full' : 'partial';
      if (delivery.task.status !== closeMode) {
        await this.warehouse.closeTaskInTransaction(
          actor,
          delivery.task.id,
          { mode: closeMode },
          tx,
        );
      }
      taskStatus = closeMode === 'full' ? 'closed' : 'partial';
    }
    const deliveryClosed = taskStatus === 'closed';
    const result: WarehousePalletDeliveryScanResult = {
      operationKey: command.operationKey,
      documentId: pallet.documentId,
      palletId: pallet.palletId,
      palletCode: pallet.palletCode,
      orderId: pallet.orderId,
      deliveryTaskId: delivery.task.id,
      rollCount: pallet.rollCodes.length,
      newlyDeliveredRollCount,
      alreadyDeliveredRollCount: delivery.alreadyDeliveredPalletCount,
      remainingRollCount,
      taskStatus,
      deliveryClosed,
      replayed: false,
    };
    await tx.warehousePalletCommand.create({
      data: {
        operationKey: command.operationKey,
        requestFingerprint: command.fingerprint,
        kind: 'pallet_delivery_scan',
        taskId: delivery.task.id,
        scanRowId: null,
        palletId: pallet.palletId,
        actorId: actor.userId,
        resultSnapshot: result as unknown as Prisma.InputJsonValue,
      },
    });
    const remainingOpenProductionProblemCount = await tx.productionProblem.count({
      where: { orderId: pallet.orderId, status: 'open' },
    });
    await this.audit.record(
      {
        type: 'audit:warehouse_pallet_delivery_scanned',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: pallet.palletId,
        newValue: { taskStatus, deliveryClosed },
        detail: {
          documentId: pallet.documentId,
          palletId: pallet.palletId,
          palletCode: pallet.palletCode,
          orderId: pallet.orderId,
          deliveryTaskId: delivery.task.id,
          rollCount: pallet.rollCodes.length,
          newlyDeliveredRollCount,
          alreadyDeliveredRollCount: delivery.alreadyDeliveredPalletCount,
          remainingRollCount,
          taskStatus,
          deliveryClosed,
          remainingOpenProductionProblemCount,
          captureChannel: 'warehouse_browser_hid',
        },
      },
      tx,
    );
    return result;
  }

  private validateTaskEnvelope(
    task: DeliveryTask | null,
    pallet: ValidatedPhysicalPallet,
    orderNumber: string,
  ): asserts task is DeliveryTask {
    if (
      !task ||
      task.mode !== 'delivery' ||
      !['open', 'partial', 'closed'].includes(task.status) ||
      task.orderId !== pallet.orderId ||
      task.positionId !== null ||
      task.proposalId !== null ||
      task.coverageDecisionId !== null ||
      task.receivingScopeKey !== null ||
      task.deliveryScopeKey !== deliveryScopeKey(pallet.orderId) ||
      task.rows.length === 0 ||
      task.rows.length > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT ||
      task.rows.some(
        (row) => row.taskId !== task.id || row.fromOrderId !== orderNumber || !row.rollCode,
      )
    ) {
      throw this.deliveryMismatch();
    }
    const taskRollCodes = task.rows.map((row) => row.rollCode);
    const taskCodeSet = new Set(taskRollCodes);
    if (
      taskCodeSet.size !== taskRollCodes.length ||
      pallet.rollCodes.some((rollCode) => !taskCodeSet.has(rollCode))
    ) {
      throw this.deliveryMismatch();
    }
  }

  private validateDeliveryState(
    task: DeliveryTask | null,
    pallet: ValidatedPhysicalPallet,
    orderNumber: string,
    rolls: DeliveryRoll[],
  ): ValidatedDelivery {
    this.validateTaskEnvelope(task, pallet, orderNumber);
    if (rolls.length !== task.rows.length) throw this.rollsInvalid();
    const rollByCode = new Map(rolls.map((roll) => [roll.rollCode, roll]));
    if (rollByCode.size !== task.rows.length) throw this.rollsInvalid();

    const palletCodes = new Set(pallet.rollCodes);
    const expectedPalletRows: DeliveryTask['rows'] = [];
    let alreadyDeliveredPalletCount = 0;
    for (const row of task.rows) {
      const roll = rollByCode.get(row.rollCode);
      if (
        !roll ||
        !(roll.receivedAt instanceof Date) ||
        !this.hasExactOrderProvenance(task, roll)
      ) {
        throw this.rollsInvalid();
      }
      const exactOperations = row.operations.filter(
        (operation) =>
          operation.taskId === task.id &&
          operation.scanRowId === row.id &&
          operation.rollCode === row.rollCode &&
          operation.kind === 'delivery_scan' &&
          operation.status === 'succeeded',
      );
      const expectedPair =
        row.scanStatus === 'expected' &&
        row.lastScanAt === null &&
        roll.warehouseStatus === 'received' &&
        row.operations.length === 0;
      const deliveredPair =
        row.scanStatus === 'accepted' &&
        row.lastScanAt instanceof Date &&
        roll.warehouseStatus === 'delivered' &&
        exactOperations.length === 1 &&
        row.operations.length === 1;
      if (!expectedPair && !deliveredPair) throw this.rollsInvalid();
      if (task.status === 'closed' && !deliveredPair) throw this.rollsInvalid();
      if (!palletCodes.has(row.rollCode)) continue;
      if (expectedPair) expectedPalletRows.push(row);
      else alreadyDeliveredPalletCount += 1;
    }
    if (expectedPalletRows.length + alreadyDeliveredPalletCount !== pallet.rollCodes.length) {
      throw this.deliveryMismatch();
    }
    return { task, expectedPalletRows, alreadyDeliveredPalletCount };
  }

  private hasExactOrderProvenance(task: DeliveryTask, roll: DeliveryRoll): boolean {
    const exactReservation =
      roll.reservedForOrderId === task.orderId &&
      (!task.positionId || roll.reservedForPositionId === task.positionId);
    const exactProduction =
      !roll.releasedFromOrderId &&
      roll.producedForOrderId === task.orderId &&
      roll.producedForPositionId !== null &&
      roll.producedByCoverageDecisionId !== null &&
      (!task.positionId || roll.producedForPositionId === task.positionId);
    return exactReservation || exactProduction;
  }

  private replay(
    stored: StoredCommand,
    actor: Actor,
    command: ScanCommand,
  ): WarehousePalletDeliveryScanResult {
    if (
      stored.kind !== 'pallet_delivery_scan' ||
      stored.scanRowId !== null ||
      stored.actorId !== actor.userId ||
      stored.requestFingerprint !== command.fingerprint
    ) {
      throw this.operationConflict();
    }
    const result = this.resultSnapshot(stored.resultSnapshot);
    if (
      result.operationKey !== command.operationKey ||
      stored.taskId !== result.deliveryTaskId ||
      stored.palletId !== result.palletId
    ) {
      throw this.operationResultCorrupted();
    }
    return { ...result, replayed: true };
  }

  private resultSnapshot(value: Prisma.JsonValue): WarehousePalletDeliveryScanResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw this.operationResultCorrupted();
    }
    const source = value as Record<string, unknown>;
    const identifiers = [
      source.operationKey,
      source.documentId,
      source.palletId,
      source.palletCode,
      source.orderId,
      source.deliveryTaskId,
    ];
    const counts = [
      source.rollCount,
      source.newlyDeliveredRollCount,
      source.alreadyDeliveredRollCount,
      source.remainingRollCount,
    ];
    const taskStatus = source.taskStatus;
    if (
      identifiers.some(
        (identifier) =>
          typeof identifier !== 'string' ||
          identifier.length === 0 ||
          identifier.length > RESULT_IDENTIFIER_MAX_LENGTH ||
          identifier.trim() !== identifier,
      ) ||
      counts.some(
        (count) =>
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
      ) ||
      source.rollCount === 0 ||
      (source.newlyDeliveredRollCount as number) + (source.alreadyDeliveredRollCount as number) !==
        source.rollCount ||
      !['open', 'partial', 'closed'].includes(taskStatus as string) ||
      typeof source.deliveryClosed !== 'boolean' ||
      source.deliveryClosed !== (taskStatus === 'closed') ||
      (taskStatus === 'closed' && source.remainingRollCount !== 0) ||
      typeof source.replayed !== 'boolean' ||
      source.replayed
    ) {
      throw this.operationResultCorrupted();
    }
    return {
      operationKey: source.operationKey as string,
      documentId: source.documentId as string,
      palletId: source.palletId as string,
      palletCode: source.palletCode as string,
      orderId: source.orderId as string,
      deliveryTaskId: source.deliveryTaskId as string,
      rollCount: source.rollCount as number,
      newlyDeliveredRollCount: source.newlyDeliveredRollCount as number,
      alreadyDeliveredRollCount: source.alreadyDeliveredRollCount as number,
      remainingRollCount: source.remainingRollCount as number,
      taskStatus: taskStatus as 'open' | 'partial' | 'closed',
      deliveryClosed: source.deliveryClosed as boolean,
      replayed: false,
    };
  }

  private qrNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'WAREHOUSE_PALLET_QR_NOT_FOUND',
      message: 'Палетный QR-код не найден.',
    });
  }

  private stateConflict(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_DELIVERY_STATE_CONFLICT',
      message: 'Палетный лист не готов к подтверждению выдачи.',
    });
  }

  private deliveryMismatch(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_DELIVERY_TASK_MISMATCH',
      message: 'Палета не относится к единственной действующей задаче выдачи.',
    });
  }

  private rollsInvalid(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_DELIVERY_ROLLS_INVALID',
      message: 'Строки выдачи и физическое состояние рулонов не совпадают.',
    });
  }

  private operationConflict(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_DELIVERY_OPERATION_CONFLICT',
      message: 'Ключ операции уже относится к другому сканированию палеты.',
    });
  }

  private operationResultCorrupted(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_DELIVERY_RESULT_CORRUPTED',
      message: 'Сохранённый результат подтверждения палеты требует проверки.',
    });
  }

  private concurrentChange(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_DELIVERY_CONCURRENT_CHANGE',
      message: 'Состояние выдачи изменилось конкурентно. Повторите сканирование после обновления.',
    });
  }

  private retryable(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code === 'P2002' || error.code === 'P2034') return true;
    const meta = error.meta as { code?: unknown } | undefined;
    return error.code === 'P2010' && meta?.code === '40001';
  }

  private uniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
