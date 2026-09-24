import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
  type WarehousePalletHandoffScanResult,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PalletHandoffScanDto } from './dto/pallet-handoff-scan.dto';
import {
  exactPalletStrings,
  PALLET_SCAN_TOKEN_SELECT,
  PHYSICAL_PALLET_DOCUMENT_SELECT,
  type ValidatedPhysicalPallet,
  validatedPhysicalPallet,
} from './warehouse-pallet-scan-evidence';

const COMMAND_SELECT = {
  kind: true,
  taskId: true,
  scanRowId: true,
  palletId: true,
  actorId: true,
  requestFingerprint: true,
  resultSnapshot: true,
} satisfies Prisma.WarehousePalletCommandSelect;

const WAREHOUSE_ROLL_SELECT = {
  id: true,
  rollCode: true,
  warehouseStatus: true,
  receivedAt: true,
  producedForOrderId: true,
  releasedFromOrderId: true,
  reservedForOrderId: true,
} satisfies Prisma.WarehouseRollSelect;

const DELIVERY_TASK_SELECT = {
  id: true,
  mode: true,
  orderId: true,
  rows: {
    select: { id: true, rollCode: true },
    orderBy: [{ rollCode: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.WarehouseAcceptanceTaskSelect;

type StoredCommand = Prisma.WarehousePalletCommandGetPayload<{
  select: typeof COMMAND_SELECT;
}>;
type HandoffWarehouseRoll = Prisma.WarehouseRollGetPayload<{
  select: typeof WAREHOUSE_ROLL_SELECT;
}>;

type ScanCommand = {
  operationKey: string;
  payload: string;
  fingerprint: string;
};

const RESULT_IDENTIFIER_MAX_LENGTH = 200;

function scanFingerprint(payload: string): string {
  return requestFingerprint({ command: 'warehouse_pallet_handoff_scan', payload });
}

@Injectable()
export class WarehousePalletHandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly fulfillment: OrderFulfillmentHandoffService,
  ) {}

  async scan(actor: Actor, dto: PalletHandoffScanDto): Promise<WarehousePalletHandoffScanResult> {
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
  ): Promise<WarehousePalletHandoffScanResult> {
    const token = await tx.palletScanToken.findUnique({
      where: { token: command.payload },
      select: PALLET_SCAN_TOKEN_SELECT,
    });
    if (!token) throw this.qrNotFound();
    const preliminary = token.document;
    const taskId = preliminary.acceptanceTaskId;
    const palletId = preliminary.warehousePalletId;
    const orderId = preliminary.warehousePallet?.orderId;
    if (!taskId || !palletId || !orderId) throw this.stateConflict();

    await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${taskId} FOR UPDATE`;
    const lockProof = await this.fulfillment.acquireDeliveryScopeLock(tx, orderId);
    await tx.$queryRaw`SELECT "id" FROM "warehouse_pallets" WHERE "id" = ${palletId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "pallet_list_documents" WHERE "id" = ${token.documentId} FOR UPDATE`;

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

    await tx.$queryRaw`
      SELECT "id"
      FROM "warehouse_pallet_items"
      WHERE "palletId" = ${palletId} AND "releasedAt" IS NULL
      ORDER BY "position", "id"
      FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT "id"
      FROM "warehouse_rolls"
      WHERE "rollCode" = ANY(${rollCodes}::text[])
      ORDER BY "rollCode" COLLATE "C", "id"
      FOR UPDATE
    `;

    const replay = await tx.warehousePalletCommand.findUnique({
      where: { operationKey: command.operationKey },
      select: COMMAND_SELECT,
    });
    if (replay) return this.replay(replay, actor, command);

    const pallet = validatedPhysicalPallet(document, rollCodes);
    if (!pallet) throw this.stateConflict();
    const rolls = await tx.warehouseRoll.findMany({
      where: { rollCode: { in: pallet.rollCodes } },
      select: WAREHOUSE_ROLL_SELECT,
      orderBy: [{ rollCode: 'asc' }, { id: 'asc' }],
    });
    this.validateWarehouseRolls(pallet, rolls);

    const handoff = await this.fulfillment.reconcilePalletScan(
      { userId: actor.userId, role: actor.role },
      pallet.orderId,
      pallet.rollCodes,
      tx,
      lockProof,
    );
    if (
      !['incomplete', 'ready_for_shipment'].includes(handoff.state) ||
      !handoff.deliveryTaskId ||
      handoff.reason !== null
    ) {
      throw this.incomplete(handoff.reason);
    }

    const delivery = await tx.warehouseAcceptanceTask.findUnique({
      where: { id: handoff.deliveryTaskId },
      select: DELIVERY_TASK_SELECT,
    });
    if (!this.deliveryContainsPallet(delivery, pallet)) throw this.deliveryMismatch();
    const remainingOpenProductionProblemCount = await tx.productionProblem.count({
      where: { orderId: pallet.orderId, status: 'open' },
    });

    const result: WarehousePalletHandoffScanResult = {
      operationKey: command.operationKey,
      documentId: pallet.documentId,
      palletId: pallet.palletId,
      palletCode: pallet.palletCode,
      orderId: pallet.orderId,
      deliveryTaskId: handoff.deliveryTaskId,
      deliveryCreated: handoff.created,
      rollCount: pallet.rollCodes.length,
      replayed: false,
    };
    await tx.warehousePalletCommand.create({
      data: {
        operationKey: command.operationKey,
        requestFingerprint: command.fingerprint,
        kind: 'pallet_handoff_scan',
        taskId: pallet.taskId,
        scanRowId: null,
        palletId: pallet.palletId,
        actorId: actor.userId,
        resultSnapshot: result as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(
      {
        type: 'audit:warehouse_pallet_handoff_scanned',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: pallet.palletId,
        newValue: {
          deliveryTaskId: handoff.deliveryTaskId,
          deliveryCreated: handoff.created,
        },
        detail: {
          acceptanceTaskId: pallet.taskId,
          documentId: pallet.documentId,
          palletId: pallet.palletId,
          palletCode: pallet.palletCode,
          orderId: pallet.orderId,
          deliveryTaskId: handoff.deliveryTaskId,
          deliveryCreated: handoff.created,
          rollCount: pallet.rollCodes.length,
          remainingOpenProductionProblemCount,
          captureChannel: 'warehouse_browser_hid',
        },
      },
      tx,
    );
    return result;
  }

  private validateWarehouseRolls(
    pallet: ValidatedPhysicalPallet,
    rolls: HandoffWarehouseRoll[],
  ): void {
    if (rolls.length !== pallet.rollCodes.length) throw this.rollsInvalid();
    const seen = new Set<string>();
    for (const roll of rolls) {
      const belongsToOrder =
        (!roll.releasedFromOrderId && roll.producedForOrderId === pallet.orderId) ||
        roll.reservedForOrderId === pallet.orderId;
      if (
        !pallet.rollCodes.includes(roll.rollCode) ||
        seen.has(roll.rollCode) ||
        roll.warehouseStatus !== 'received' ||
        !(roll.receivedAt instanceof Date) ||
        !belongsToOrder
      ) {
        throw this.rollsInvalid();
      }
      seen.add(roll.rollCode);
    }
  }

  private deliveryContainsPallet(
    delivery: Prisma.WarehouseAcceptanceTaskGetPayload<{
      select: typeof DELIVERY_TASK_SELECT;
    }> | null,
    pallet: ValidatedPhysicalPallet,
  ): boolean {
    if (!delivery || delivery.mode !== 'delivery' || delivery.orderId !== pallet.orderId) {
      return false;
    }
    const rowCodes = delivery.rows.map((row) => row.rollCode);
    if (new Set(rowCodes).size !== rowCodes.length) return false;
    const rowCodeSet = new Set(rowCodes);
    return pallet.rollCodes.every((rollCode) => rowCodeSet.has(rollCode));
  }

  private replay(
    stored: StoredCommand,
    actor: Actor,
    command: ScanCommand,
  ): WarehousePalletHandoffScanResult {
    if (
      stored.kind !== 'pallet_handoff_scan' ||
      stored.scanRowId !== null ||
      stored.actorId !== actor.userId ||
      stored.requestFingerprint !== command.fingerprint
    ) {
      throw this.operationConflict();
    }
    const result = this.resultSnapshot(stored.resultSnapshot);
    if (
      result.operationKey !== command.operationKey ||
      stored.taskId.length === 0 ||
      stored.palletId !== result.palletId
    ) {
      throw this.operationResultCorrupted();
    }
    return { ...result, replayed: true };
  }

  private resultSnapshot(value: Prisma.JsonValue): WarehousePalletHandoffScanResult {
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
    if (
      identifiers.some(
        (identifier) =>
          typeof identifier !== 'string' ||
          identifier.length === 0 ||
          identifier.length > RESULT_IDENTIFIER_MAX_LENGTH ||
          identifier.trim() !== identifier,
      ) ||
      typeof source.deliveryCreated !== 'boolean' ||
      typeof source.replayed !== 'boolean' ||
      source.replayed ||
      typeof source.rollCount !== 'number' ||
      !Number.isSafeInteger(source.rollCount) ||
      source.rollCount <= 0 ||
      source.rollCount > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT
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
      deliveryCreated: source.deliveryCreated as boolean,
      rollCount: source.rollCount as number,
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
      code: 'WAREHOUSE_PALLET_HANDOFF_STATE_CONFLICT',
      message: 'Палетный лист не готов к передаче в выдачу.',
    });
  }

  private rollsInvalid(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_HANDOFF_ROLLS_INVALID',
      message: 'Не все рулоны палеты приняты складом с подтверждённым источником.',
    });
  }

  private incomplete(reason: string | null): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_HANDOFF_INCOMPLETE',
      message: 'Заказ ещё не готов к созданию выдачи.',
      reason,
    });
  }

  private deliveryMismatch(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_HANDOFF_DELIVERY_MISMATCH',
      message: 'Состав выдачи не содержит все рулоны палеты.',
    });
  }

  private operationConflict(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_HANDOFF_OPERATION_CONFLICT',
      message: 'Ключ операции уже относится к другому сканированию палеты.',
    });
  }

  private operationResultCorrupted(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_HANDOFF_RESULT_CORRUPTED',
      message: 'Сохранённый результат сканирования палеты требует проверки.',
    });
  }

  private concurrentChange(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_HANDOFF_CONCURRENT_CHANGE',
      message: 'Состояние палеты изменилось конкурентно. Повторите сканирование после обновления.',
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
