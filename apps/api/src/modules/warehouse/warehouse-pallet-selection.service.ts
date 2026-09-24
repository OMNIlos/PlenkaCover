import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
  type WarehousePalletDocumentSummary,
  type WarehousePalletSelectionPalletView,
  type WarehousePalletSelectionResult,
  type WarehousePalletStatus,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { SetPalletSelectionDto } from './dto/set-pallet-selection.dto';
import type { VoidPalletDto } from './dto/void-pallet.dto';
import { immutablePalletLabelProfile, isPalletLabelProfile } from './pallet-label-snapshot';
import { WarehousePalletService } from './warehouse-pallet.service';

const COMMAND_SELECT = {
  kind: true,
  taskId: true,
  scanRowId: true,
  palletId: true,
  actorId: true,
  requestFingerprint: true,
  resultSnapshot: true,
} satisfies Prisma.WarehousePalletCommandSelect;

const VOID_PALLET_SELECT = {
  id: true,
  taskId: true,
  orderId: true,
  palletCode: true,
  status: true,
} satisfies Prisma.WarehousePalletSelect;

const VOID_DOCUMENT_SELECT = {
  id: true,
  palletId: true,
  warehousePalletId: true,
  acceptanceTaskId: true,
  origin: true,
  rollIds: true,
  orderIds: true,
  payload: true,
  voidedAt: true,
  createdAt: true,
  warehousePallet: { select: { orderId: true } },
  printJobs: {
    where: { status: { in: ['submitted', 'failed', 'delivery_unknown'] } },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { status: true },
  },
} satisfies Prisma.PalletListDocumentSelect;

const VOID_ITEM_SELECT = {
  id: true,
  rollCode: true,
  position: true,
} satisfies Prisma.WarehousePalletItemSelect;

const SNAPSHOT_IDENTIFIER_MAX_LENGTH = 128;
const SNAPSHOT_SCANNED_BY_NAME_MAX_LENGTH = 256;
const SNAPSHOT_ISO_DATE_MAX_LENGTH = 32;

const TASK_SELECT = {
  id: true,
  mode: true,
  status: true,
  orderId: true,
  updatedAt: true,
} satisfies Prisma.WarehouseAcceptanceTaskSelect;

const ROW_SELECT = {
  id: true,
  taskId: true,
  rollCode: true,
  fromOrderId: true,
  scanStatus: true,
  lastScanAt: true,
  scannedByName: true,
} satisfies Prisma.ScanRowSelect;

const ACTIVE_MEMBERSHIP_SELECT = {
  id: true,
  palletId: true,
  orderId: true,
  rollCode: true,
  position: true,
  acceptedAt: true,
  pallet: {
    select: {
      id: true,
      palletCode: true,
      taskId: true,
      orderId: true,
      sequenceNo: true,
      status: true,
    },
  },
} satisfies Prisma.WarehousePalletItemSelect;

const PALLET_VIEW_SELECT = {
  id: true,
  palletCode: true,
  orderId: true,
  sequenceNo: true,
  status: true,
  openedAt: true,
  order: { select: { orderNumber: true } },
  items: {
    where: { releasedAt: null },
    orderBy: { position: 'asc' as const },
    take: WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
    select: {
      rollCode: true,
      position: true,
      acceptedAt: true,
      scanRow: { select: { scannedByName: true } },
    },
  },
  _count: {
    select: {
      items: { where: { releasedAt: null } },
    },
  },
} satisfies Prisma.WarehousePalletSelect;

type StoredCommand = Prisma.WarehousePalletCommandGetPayload<{
  select: typeof COMMAND_SELECT;
}>;
type LockedTask = Prisma.WarehouseAcceptanceTaskGetPayload<{ select: typeof TASK_SELECT }>;
type LockedRow = Prisma.ScanRowGetPayload<{ select: typeof ROW_SELECT }>;
type ActiveMembership = Prisma.WarehousePalletItemGetPayload<{
  select: typeof ACTIVE_MEMBERSHIP_SELECT;
}>;
type PalletProjection = Prisma.WarehousePalletGetPayload<{ select: typeof PALLET_VIEW_SELECT }>;
type VoidDocument = Prisma.PalletListDocumentGetPayload<{ select: typeof VOID_DOCUMENT_SELECT }>;
type VoidItem = Prisma.WarehousePalletItemGetPayload<{ select: typeof VOID_ITEM_SELECT }>;

type SelectionCommand = {
  operationKey: string;
  selected: boolean;
  fingerprint: string;
};

type VoidCommand = {
  operationKey: string;
  reasonCode: VoidPalletDto['reasonCode'];
  note: string | null;
  fingerprint: string;
};

function selectionFingerprint(taskId: string, scanRowId: string, selected: boolean): string {
  return requestFingerprint({
    command: 'warehouse_pallet_set_selection',
    taskId,
    scanRowId,
    selected,
  });
}

function voidFingerprint(
  taskId: string,
  palletId: string,
  reasonCode: VoidPalletDto['reasonCode'],
  note: string | null,
): string {
  return requestFingerprint({
    command: 'warehouse_pallet_void',
    taskId,
    palletId,
    reasonCode,
    note,
  });
}

@Injectable()
export class WarehousePalletSelectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pallets: WarehousePalletService,
  ) {}

  async setSelection(
    actor: Actor,
    taskId: string,
    scanRowId: string,
    dto: SetPalletSelectionDto,
  ): Promise<WarehousePalletSelectionResult> {
    const command: SelectionCommand = {
      operationKey: dto.operationKey.toLowerCase(),
      selected: dto.selected,
      fingerprint: selectionFingerprint(taskId, scanRowId, dto.selected),
    };
    const existing = await this.prisma.warehousePalletCommand.findUnique({
      where: { operationKey: command.operationKey },
      select: COMMAND_SELECT,
    });
    if (existing) return this.replay(existing, actor, taskId, scanRowId, command);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.execute(tx, actor, taskId, scanRowId, command),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (!this.retryable(error)) throw error;

        if (this.uniqueViolation(error)) {
          const winner = await this.prisma.warehousePalletCommand.findUnique({
            where: { operationKey: command.operationKey },
            select: COMMAND_SELECT,
          });
          if (winner) return this.replay(winner, actor, taskId, scanRowId, command);
        }
        if (attempt < 2) continue;
        throw this.selectionLocked(null, 'concurrent_change');
      }
    }
    throw this.selectionLocked(null, 'concurrent_change');
  }

  async voidPallet(
    actor: Actor,
    taskId: string,
    palletId: string,
    dto: VoidPalletDto,
  ): Promise<WarehousePalletDocumentSummary> {
    const command: VoidCommand = {
      operationKey: dto.operationKey.toLowerCase(),
      reasonCode: dto.reasonCode,
      note: dto.note ?? null,
      fingerprint: voidFingerprint(taskId, palletId, dto.reasonCode, dto.note ?? null),
    };
    const existing = await this.prisma.warehousePalletCommand.findUnique({
      where: { operationKey: command.operationKey },
      select: COMMAND_SELECT,
    });
    if (existing) return this.replayVoid(existing, actor, taskId, palletId, command);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.executeVoid(tx, actor, taskId, palletId, command),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (!this.retryable(error)) throw error;
        if (this.uniqueViolation(error)) {
          const winner = await this.prisma.warehousePalletCommand.findUnique({
            where: { operationKey: command.operationKey },
            select: COMMAND_SELECT,
          });
          if (winner) return this.replayVoid(winner, actor, taskId, palletId, command);
        }
        if (attempt < 2) continue;
        throw this.voidStateConflict();
      }
    }
    throw this.voidStateConflict();
  }

  private async executeVoid(
    tx: Prisma.TransactionClient,
    actor: Actor,
    taskId: string,
    palletId: string,
    command: VoidCommand,
  ): Promise<WarehousePalletDocumentSummary> {
    await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${taskId} FOR UPDATE`;
    const task = await tx.warehouseAcceptanceTask.findUnique({
      where: { id: taskId },
      select: { id: true, status: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: 'WAREHOUSE_TASK_NOT_FOUND',
        message: 'Складская задача не найдена.',
      });
    }
    if (task.status === 'closed') {
      throw new ConflictException({
        code: 'WAREHOUSE_TASK_CLOSED',
        message: 'Закрытая приёмка и её палетные листы неизменяемы.',
      });
    }

    await tx.$queryRaw`
      SELECT "id" FROM "warehouse_pallets"
      WHERE "id" = ${palletId} AND "taskId" = ${taskId}
      FOR UPDATE
    `;
    const pallet = await tx.warehousePallet.findFirst({
      where: { id: palletId, taskId },
      select: VOID_PALLET_SELECT,
    });
    if (!pallet) throw this.voidStateConflict();

    await tx.$queryRaw`
      SELECT "id" FROM "pallet_list_documents"
      WHERE "warehousePalletId" = ${palletId}
      FOR UPDATE
    `;
    const document = await tx.palletListDocument.findUnique({
      where: { warehousePalletId: palletId },
      select: VOID_DOCUMENT_SELECT,
    });
    if (!document) throw this.voidStateConflict();

    await tx.$queryRaw`
      SELECT "id" FROM "warehouse_pallet_items"
      WHERE "palletId" = ${palletId} AND "releasedAt" IS NULL
      ORDER BY "position", "id"
      FOR UPDATE
    `;
    const lockedItems = await tx.warehousePalletItem.findMany({
      where: { palletId, releasedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: VOID_ITEM_SELECT,
    });

    const replay = await tx.warehousePalletCommand.findUnique({
      where: { operationKey: command.operationKey },
      select: COMMAND_SELECT,
    });
    if (replay) return this.replayVoid(replay, actor, taskId, palletId, command);
    if (pallet.status !== 'sealed' || document.voidedAt !== null) throw this.voidStateConflict();
    const activePrint = await tx.palletPrintJob.findFirst({
      where: {
        palletListDocumentId: document.id,
        status: 'queued',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (activePrint) throw this.voidPrintInProgress(activePrint.id);
    this.assertVoidSeal(taskId, pallet, document, lockedItems);

    const voidedAt = new Date();
    const released = await tx.warehousePalletItem.updateMany({
      where: { palletId, releasedAt: null },
      data: {
        releasedAt: voidedAt,
        releasedById: actor.userId,
        releaseReason: 'pallet_voided',
      },
    });
    if (released.count !== lockedItems.length) throw this.voidStateConflict();
    const voidedPallet = await tx.warehousePallet.updateMany({
      where: { id: palletId, taskId, status: 'sealed' },
      data: {
        status: 'voided',
        voidedAt,
        voidedById: actor.userId,
        voidReason: command.reasonCode,
      },
    });
    if (voidedPallet.count !== 1) throw this.voidStateConflict();
    const voidedDocument = await tx.palletListDocument.updateMany({
      where: { id: document.id, warehousePalletId: palletId, voidedAt: null },
      data: {
        voidedAt,
        voidedById: actor.userId,
        voidReasonCode: command.reasonCode,
        voidNote: command.note,
      },
    });
    if (voidedDocument.count !== 1) throw this.voidStateConflict();

    const result = this.documentSummary(document, 'voided');
    await tx.warehousePalletCommand.create({
      data: {
        operationKey: command.operationKey,
        requestFingerprint: command.fingerprint,
        kind: 'void_pallet',
        taskId,
        scanRowId: null,
        palletId,
        actorId: actor.userId,
        resultSnapshot: result as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(
      {
        type: 'audit:warehouse_pallet_voided',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: pallet.id,
        reason: command.reasonCode,
        oldValue: { status: 'sealed' },
        newValue: { status: 'voided' },
        detail: {
          taskId,
          palletId: pallet.id,
          palletCode: pallet.palletCode,
          orderId: pallet.orderId,
          documentId: document.id,
          releasedRollCount: released.count,
          reasonCode: command.reasonCode,
        },
      },
      tx,
    );
    await this.audit.record(
      {
        type: 'audit:pallet_list_voided',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: document.id,
        reason: command.reasonCode,
        oldValue: { documentStatus: 'sealed' },
        newValue: { documentStatus: 'voided' },
        detail: {
          taskId,
          palletId: document.palletId,
          warehousePalletId: pallet.id,
          reasonCode: command.reasonCode,
          releasedRollCount: released.count,
        },
      },
      tx,
    );
    return result;
  }

  private assertVoidSeal(
    taskId: string,
    pallet: {
      id: string;
      taskId: string;
      orderId: string;
      palletCode: string;
    },
    document: VoidDocument,
    lockedItems: VoidItem[],
  ): void {
    const templateVersion = immutablePalletLabelProfile(document.payload);
    if (
      pallet.taskId !== taskId ||
      document.acceptanceTaskId !== taskId ||
      document.origin !== 'physical_pallet' ||
      document.warehousePalletId !== pallet.id ||
      document.warehousePallet?.orderId !== pallet.orderId ||
      document.palletId !== pallet.palletCode ||
      !templateVersion
    ) {
      throw this.voidStateConflict();
    }

    const orderIds = this.exactJsonStrings(document.orderIds);
    const rollIds = this.exactJsonStrings(document.rollIds);
    if (
      orderIds === null ||
      orderIds.length !== 1 ||
      orderIds[0] !== pallet.orderId ||
      rollIds === null ||
      lockedItems.length === 0 ||
      rollIds.length !== lockedItems.length ||
      new Set(rollIds).size !== rollIds.length
    ) {
      throw this.voidStateConflict();
    }

    const itemIds = new Set<string>();
    const itemRollCodes = new Set<string>();
    const itemPositions = new Set<number>();
    for (const [index, item] of lockedItems.entries()) {
      if (
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        typeof item.rollCode !== 'string' ||
        item.rollCode.length === 0 ||
        !Number.isSafeInteger(item.position) ||
        item.position <= 0 ||
        itemIds.has(item.id) ||
        itemRollCodes.has(item.rollCode) ||
        itemPositions.has(item.position) ||
        rollIds[index] !== item.rollCode
      ) {
        throw this.voidStateConflict();
      }
      itemIds.add(item.id);
      itemRollCodes.add(item.rollCode);
      itemPositions.add(item.position);
    }
  }

  private async execute(
    tx: Prisma.TransactionClient,
    actor: Actor,
    taskId: string,
    scanRowId: string,
    command: SelectionCommand,
  ): Promise<WarehousePalletSelectionResult> {
    await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${taskId} FOR UPDATE`;
    const task = await tx.warehouseAcceptanceTask.findUnique({
      where: { id: taskId },
      select: TASK_SELECT,
    });
    if (!task) {
      throw new NotFoundException({
        code: 'WAREHOUSE_TASK_NOT_FOUND',
        message: 'Складская задача не найдена.',
      });
    }

    await tx.$queryRaw`SELECT "id" FROM "scan_rows" WHERE "id" = ${scanRowId} FOR UPDATE`;
    const row = await tx.scanRow.findUnique({
      where: { id: scanRowId },
      select: ROW_SELECT,
    });
    if (!row || row.taskId !== taskId) throw this.rollNotAccepted();

    const replay = await tx.warehousePalletCommand.findUnique({
      where: { operationKey: command.operationKey },
      select: COMMAND_SELECT,
    });
    if (replay) return this.replay(replay, actor, taskId, scanRowId, command);

    if (
      task.mode !== 'receiving' ||
      !['open', 'partial'].includes(task.status) ||
      row.scanStatus !== 'accepted'
    ) {
      throw this.rollNotAccepted();
    }
    const order = await this.resolveOrder(tx, task, row);
    const active = await tx.warehousePalletItem.findFirst({
      where: { scanRowId, releasedAt: null },
      select: ACTIVE_MEMBERSHIP_SELECT,
    });
    if (active) this.assertMutableMembership(active, taskId, order.id);

    if (command.selected) {
      return this.include(tx, actor, task, row, order, active, command);
    }
    return this.exclude(tx, actor, task, row, order, active, command);
  }

  private async include(
    tx: Prisma.TransactionClient,
    actor: Actor,
    task: LockedTask,
    row: LockedRow,
    order: { id: string; orderNumber: string },
    active: ActiveMembership | null,
    command: SelectionCommand,
  ): Promise<WarehousePalletSelectionResult> {
    if (active) {
      const result = await this.palletView(tx, active.palletId, false);
      await this.persistCommand(tx, actor, task.id, row.id, active.palletId, command, result);
      return result;
    }

    const pallet = await this.pallets.prepareOpenPallet(tx, {
      taskId: task.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      actor,
    });
    const item = await this.pallets.attachAcceptedRoll(tx, {
      pallet,
      scanRowId: row.id,
      rollCode: row.rollCode,
      acceptedAt: row.lastScanAt ?? task.updatedAt,
      actorId: actor.userId,
    });
    const result = await this.palletView(tx, pallet.id, true);
    await this.persistCommand(tx, actor, task.id, row.id, pallet.id, command, result);
    await this.audit.record(
      {
        type: 'audit:warehouse_pallet_roll_selected',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: row.rollCode,
        oldValue: { selected: false },
        newValue: { selected: true },
        detail: {
          taskId: task.id,
          palletId: pallet.id,
          palletCode: pallet.palletCode,
          orderId: order.id,
          scanRowId: row.id,
          rollCode: row.rollCode,
          position: item.position,
        },
      },
      tx,
    );
    return result;
  }

  private async exclude(
    tx: Prisma.TransactionClient,
    actor: Actor,
    task: LockedTask,
    row: LockedRow,
    order: { id: string; orderNumber: string },
    active: ActiveMembership | null,
    command: SelectionCommand,
  ): Promise<WarehousePalletSelectionResult> {
    if (!active) {
      const open = await tx.warehousePallet.findFirst({
        where: { taskId: task.id, status: 'open' },
        select: { id: true },
      });
      if (!open) {
        const result: WarehousePalletSelectionResult = {
          selectionChanged: false,
          activePallet: null,
        };
        await this.persistCommand(tx, actor, task.id, row.id, null, command, result);
        return result;
      }
      const result = await this.palletView(tx, open.id, false);
      await this.persistCommand(tx, actor, task.id, row.id, open.id, command, result);
      return result;
    }

    const released = await this.pallets.releaseActiveMembership(tx, {
      actor,
      taskId: task.id,
      scanRowId: row.id,
      reason: 'manual_deselection',
    });
    if (!released) {
      throw this.selectionLocked(active.palletId, active.pallet.status);
    }
    const result: WarehousePalletSelectionResult = released.palletVoided
      ? { selectionChanged: true, activePallet: null }
      : await this.palletView(tx, active.palletId, true);
    await this.persistCommand(tx, actor, task.id, row.id, active.palletId, command, result);
    return result;
  }

  private async resolveOrder(
    tx: Prisma.TransactionClient,
    task: LockedTask,
    row: LockedRow,
  ): Promise<{ id: string; orderNumber: string }> {
    if (task.orderId) {
      const order = await tx.commercialOrder.findFirst({
        where: { id: task.orderId },
        select: { id: true, orderNumber: true },
      });
      if (!order) throw this.orderMismatch(task.orderId, row.fromOrderId);
      if (
        row.fromOrderId &&
        row.fromOrderId !== order.id &&
        row.fromOrderId !== order.orderNumber
      ) {
        throw this.orderMismatch(order.id, row.fromOrderId);
      }
      return order;
    }
    const orderReference = row.fromOrderId?.trim();
    if (!orderReference) throw this.orderMismatch(task.orderId, null);
    const order = await tx.commercialOrder.findFirst({
      where: {
        OR: [{ id: orderReference }, { orderNumber: orderReference }],
      },
      select: { id: true, orderNumber: true },
    });
    if (!order) throw this.orderMismatch(task.orderId, orderReference);
    return order;
  }

  private assertMutableMembership(active: ActiveMembership, taskId: string, orderId: string): void {
    if (active.pallet.status !== 'open' || active.pallet.taskId !== taskId) {
      throw this.selectionLocked(active.palletId, active.pallet.status);
    }
    if (active.orderId !== orderId || active.pallet.orderId !== orderId) {
      throw this.orderMismatch(orderId, active.orderId);
    }
  }

  private async palletView(
    tx: Prisma.TransactionClient,
    palletId: string,
    selectionChanged: boolean,
  ): Promise<WarehousePalletSelectionResult> {
    const pallet = await tx.warehousePallet.findUnique({
      where: { id: palletId },
      select: PALLET_VIEW_SELECT,
    });
    if (!pallet) throw this.selectionLocked(palletId, 'missing');
    return this.projectPallet(pallet, selectionChanged);
  }

  private projectPallet(
    pallet: PalletProjection,
    selectionChanged: boolean,
  ): WarehousePalletSelectionResult {
    const status = this.palletStatus(pallet.status);
    const rows = pallet.items.slice(0, WAREHOUSE_PALLET_SELECTION_ROW_LIMIT);
    const activePallet: WarehousePalletSelectionPalletView = {
      id: pallet.id,
      palletCode: pallet.palletCode,
      orderId: pallet.orderId,
      orderNumber: pallet.order.orderNumber,
      sequenceNo: pallet.sequenceNo,
      status,
      totalCount: pallet._count.items,
      hasMore: pallet._count.items > rows.length,
      openedAt: pallet.openedAt.toISOString(),
      rows: rows.map((item) => ({
        rollCode: item.rollCode,
        position: item.position,
        acceptedAt: item.acceptedAt.toISOString(),
        scannedByName: item.scanRow.scannedByName,
      })),
    };
    return { selectionChanged, activePallet };
  }

  private async persistCommand(
    tx: Prisma.TransactionClient,
    actor: Actor,
    taskId: string,
    scanRowId: string,
    palletId: string | null,
    command: SelectionCommand,
    result: WarehousePalletSelectionResult,
  ): Promise<void> {
    await tx.warehousePalletCommand.create({
      data: {
        operationKey: command.operationKey,
        requestFingerprint: command.fingerprint,
        kind: 'set_selection',
        taskId,
        scanRowId,
        palletId,
        actorId: actor.userId,
        resultSnapshot: result as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private replay(
    stored: StoredCommand,
    actor: Actor,
    taskId: string,
    scanRowId: string,
    command: SelectionCommand,
  ): WarehousePalletSelectionResult {
    if (
      stored.kind !== 'set_selection' ||
      stored.taskId !== taskId ||
      stored.scanRowId !== scanRowId ||
      stored.actorId !== actor.userId ||
      stored.requestFingerprint !== command.fingerprint
    ) {
      throw new ConflictException({
        code: 'WAREHOUSE_PALLET_SELECTION_OPERATION_CONFLICT',
        message: 'Ключ операции уже относится к другому изменению палетного листа.',
      });
    }
    return this.resultSnapshot(stored.resultSnapshot);
  }

  private replayVoid(
    stored: StoredCommand,
    actor: Actor,
    taskId: string,
    palletId: string,
    command: VoidCommand,
  ): WarehousePalletDocumentSummary {
    if (
      stored.kind !== 'void_pallet' ||
      stored.taskId !== taskId ||
      stored.palletId !== palletId ||
      stored.scanRowId !== null ||
      stored.actorId !== actor.userId ||
      stored.requestFingerprint !== command.fingerprint
    ) {
      throw new ConflictException({
        code: 'WAREHOUSE_PALLET_VOID_OPERATION_CONFLICT',
        message: 'Ключ операции уже относится к другому аннулированию палетного листа.',
      });
    }
    return this.voidResultSnapshot(stored.resultSnapshot);
  }

  private documentSummary(
    document: VoidDocument,
    documentStatus: WarehousePalletDocumentSummary['documentStatus'] = document.voidedAt
      ? 'voided'
      : 'sealed',
  ): WarehousePalletDocumentSummary {
    const rollCodes = this.jsonStrings(document.rollIds);
    const orderIds = this.jsonStrings(document.orderIds);
    const payload = this.jsonRecord(document.payload);
    const templateVersion = immutablePalletLabelProfile(document.payload);
    if (!templateVersion) throw this.voidStateConflict();
    const printStatus = document.printJobs[0]?.status;
    return {
      id: document.id,
      palletId: document.palletId,
      warehousePalletId: document.warehousePalletId,
      origin: document.origin === 'physical_pallet' ? 'physical_pallet' : 'legacy',
      createdAt: document.createdAt.toISOString(),
      templateVersion,
      documentStatus,
      printReady: payload.printReady === true,
      printStatus:
        printStatus === 'delivery_unknown'
          ? 'needs_admin'
          : printStatus === 'failed'
            ? 'failed'
            : printStatus === 'submitted'
              ? 'submitted'
              : 'not_printed',
      rollCount: rollCodes.length,
      rollCodes: rollCodes.slice(0, WAREHOUSE_PALLET_SELECTION_ROW_LIMIT),
      rollCodesHasMore: rollCodes.length > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
      orderId: document.warehousePallet?.orderId ?? (orderIds.length === 1 ? orderIds[0] : null),
    };
  }

  private voidResultSnapshot(value: Prisma.JsonValue): WarehousePalletDocumentSummary {
    if (!this.isObject(value)) throw this.voidOperationResultCorrupted();
    const source = value;
    const printStatuses = ['not_printed', 'submitted', 'failed', 'needs_admin'];
    if (
      !this.boundedString(source.id, SNAPSHOT_IDENTIFIER_MAX_LENGTH) ||
      !this.boundedString(source.palletId, SNAPSHOT_IDENTIFIER_MAX_LENGTH) ||
      (source.warehousePalletId !== null &&
        !this.boundedString(source.warehousePalletId, SNAPSHOT_IDENTIFIER_MAX_LENGTH)) ||
      (source.origin !== 'legacy' && source.origin !== 'physical_pallet') ||
      !this.isoDate(source.createdAt) ||
      !isPalletLabelProfile(source.templateVersion) ||
      source.documentStatus !== 'voided' ||
      typeof source.printReady !== 'boolean' ||
      typeof source.printStatus !== 'string' ||
      !printStatuses.includes(source.printStatus) ||
      !this.nonNegativeInteger(source.rollCount) ||
      !Array.isArray(source.rollCodes) ||
      source.rollCodes.length > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT ||
      typeof source.rollCodesHasMore !== 'boolean' ||
      (source.orderId !== null &&
        !this.boundedString(source.orderId, SNAPSHOT_IDENTIFIER_MAX_LENGTH))
    ) {
      throw this.voidOperationResultCorrupted();
    }
    const rollCodes = source.rollCodes.map((rollCode) => {
      if (!this.boundedString(rollCode, SNAPSHOT_IDENTIFIER_MAX_LENGTH)) {
        throw this.voidOperationResultCorrupted();
      }
      return rollCode;
    });
    if (
      rollCodes.length !== Math.min(source.rollCount, WAREHOUSE_PALLET_SELECTION_ROW_LIMIT) ||
      source.rollCodesHasMore !== source.rollCount > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT
    ) {
      throw this.voidOperationResultCorrupted();
    }
    return {
      id: source.id,
      palletId: source.palletId,
      warehousePalletId: source.warehousePalletId,
      origin: source.origin,
      createdAt: source.createdAt,
      templateVersion: source.templateVersion,
      documentStatus: source.documentStatus,
      printReady: source.printReady,
      printStatus: source.printStatus as WarehousePalletDocumentSummary['printStatus'],
      rollCount: source.rollCount,
      rollCodes,
      rollCodesHasMore: source.rollCodesHasMore,
      orderId: source.orderId,
    };
  }

  private jsonStrings(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private exactJsonStrings(value: Prisma.JsonValue): string[] | null {
    return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
      ? value
      : null;
  }

  private jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
    return this.isObject(value) ? value : {};
  }

  private resultSnapshot(value: Prisma.JsonValue): WarehousePalletSelectionResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw this.operationResultCorrupted();
    }
    const source = value as Record<string, Prisma.JsonValue>;
    const selectionChanged =
      typeof source.selectionChanged === 'boolean' ? source.selectionChanged : false;
    if (
      !('activePallet' in source) ||
      (source.activePallet !== null && !this.isObject(source.activePallet))
    ) {
      throw this.operationResultCorrupted();
    }
    if (source.activePallet === null) return { selectionChanged, activePallet: null };
    const pallet = source.activePallet;
    if (
      !this.boundedString(pallet.id, SNAPSHOT_IDENTIFIER_MAX_LENGTH) ||
      !this.boundedString(pallet.palletCode, SNAPSHOT_IDENTIFIER_MAX_LENGTH) ||
      !this.boundedString(pallet.orderId, SNAPSHOT_IDENTIFIER_MAX_LENGTH) ||
      !this.boundedString(pallet.orderNumber, SNAPSHOT_IDENTIFIER_MAX_LENGTH) ||
      !this.positiveInteger(pallet.sequenceNo) ||
      typeof pallet.status !== 'string' ||
      !this.nonNegativeInteger(pallet.totalCount) ||
      typeof pallet.hasMore !== 'boolean' ||
      !this.isoDate(pallet.openedAt) ||
      !Array.isArray(pallet.rows) ||
      pallet.rows.length > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT
    ) {
      throw this.operationResultCorrupted();
    }
    const status = this.palletStatus(pallet.status);
    const rows = pallet.rows.map((value) => {
      if (!this.isObject(value)) {
        throw this.operationResultCorrupted();
      }
      const row = value as Record<string, Prisma.JsonValue>;
      if (
        !this.boundedString(row.rollCode, SNAPSHOT_IDENTIFIER_MAX_LENGTH) ||
        !this.positiveInteger(row.position) ||
        !this.isoDate(row.acceptedAt) ||
        (row.scannedByName !== null &&
          !this.boundedString(row.scannedByName, SNAPSHOT_SCANNED_BY_NAME_MAX_LENGTH))
      ) {
        throw this.operationResultCorrupted();
      }
      return {
        rollCode: row.rollCode,
        position: row.position,
        acceptedAt: row.acceptedAt,
        scannedByName: row.scannedByName,
      };
    });
    const expectedRowCount = Math.min(pallet.totalCount, WAREHOUSE_PALLET_SELECTION_ROW_LIMIT);
    const expectedHasMore = pallet.totalCount > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT;
    if (rows.length !== expectedRowCount || pallet.hasMore !== expectedHasMore) {
      throw this.operationResultCorrupted();
    }
    return {
      selectionChanged,
      activePallet: {
        id: pallet.id,
        palletCode: pallet.palletCode,
        orderId: pallet.orderId,
        orderNumber: pallet.orderNumber,
        sequenceNo: pallet.sequenceNo,
        status,
        totalCount: pallet.totalCount,
        hasMore: pallet.hasMore,
        openedAt: pallet.openedAt,
        rows,
      },
    };
  }

  private isObject(value: Prisma.JsonValue): value is Record<string, Prisma.JsonValue> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private boundedString(value: Prisma.JsonValue, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  }

  private positiveInteger(value: Prisma.JsonValue): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  }

  private nonNegativeInteger(value: Prisma.JsonValue): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }

  private isoDate(value: Prisma.JsonValue): value is string {
    if (typeof value !== 'string' || value.length > SNAPSHOT_ISO_DATE_MAX_LENGTH) return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.toISOString() === value;
  }

  private palletStatus(value: string): WarehousePalletStatus {
    if (value === 'open' || value === 'sealed' || value === 'voided') return value;
    throw this.operationResultCorrupted();
  }

  private operationResultCorrupted(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_SELECTION_OPERATION_CONFLICT',
      message: 'Сохранённый результат изменения палетного листа повреждён.',
    });
  }

  private voidOperationResultCorrupted(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_VOID_OPERATION_CONFLICT',
      message: 'Сохранённый результат аннулирования палетного листа повреждён.',
    });
  }

  private rollNotAccepted(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_ROLL_NOT_ACCEPTED',
      message: 'В палетный лист можно добавить только принятый рулон текущей задачи.',
    });
  }

  private orderMismatch(taskOrderId: string | null, rowOrderReference: string | null) {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_ORDER_MISMATCH',
      message: 'Рулон относится к другому заказу и не может войти в текущий палет.',
      taskOrderId,
      rowOrderReference,
    });
  }

  private selectionLocked(palletId: string | null, palletStatus: string) {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_SELECTION_LOCKED',
      message: 'Состав палета уже зафиксирован или изменился конкурентно.',
      palletId,
      palletStatus,
    });
  }

  private voidStateConflict(): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_VOID_STATE_CONFLICT',
      message: 'Аннулировать можно только закрытый неизменённый палетный лист.',
    });
  }

  private voidPrintInProgress(printJobId: string): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_VOID_PRINT_IN_PROGRESS',
      message: 'Дождитесь завершения текущего задания печати перед аннулированием.',
      printJobId,
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
