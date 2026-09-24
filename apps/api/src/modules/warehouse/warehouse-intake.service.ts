import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Role,
  WarehousePalletDocumentSummary,
  WarehouseIntake,
  WarehouseIntakeRollView,
  WarehouseIntakeStats,
  WarehouseIntakeTaskStatus,
  WarehouseIntakeTaskView,
} from '@plenka/contracts';
import { WAREHOUSE_PALLET_SELECTION_ROW_LIMIT } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RuntimeConfig } from '../../common/runtime-config';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import { AuditService } from '../../common/audit/audit.service';
import { type PalletExportFormat, PalletExportService } from './pallet-export.service';
import { buildPalletListPayload, type PalletListPayload } from './pallet-list.builder';
import {
  hasExactPalletDocumentComposition,
  hasRenderablePalletDocumentSnapshot,
  palletLabelDocumentFormat,
  palletLabelFieldSetStatus,
} from './pallet-label-snapshot';
import {
  type OperatorLineProjection,
  projectWarehouseIntakeRoll,
  type ScanRowProjection,
  WAREHOUSE_ARRIVED_STATES,
  type WarehouseRollProjection,
} from './warehouse-intake-roll.projection';
import { WarehousePalletService } from './warehouse-pallet.service';
import { projectLastScanResult, projectParsedRollCode } from './warehouse-task.projection';

export interface WarehouseIntakeActor {
  userId: string | null;
  role: Role;
}

type TaskWithRows = {
  id: string;
  mode: string;
  status: string;
  operationCode: string | null;
  orderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  rows: ScanRowProjection[];
};

const ERROR_STATUSES = ['wrong', 'duplicate', 'excess'];

const uniqueStrings = (values: Array<string | null>): string[] => [
  ...new Set(values.filter((value): value is string => value !== null && value.length > 0)),
];

const oneOrNull = (values: string[]): string | null => (values.length === 1 ? values[0] : null);

/**
 * Приёмка склада (design 2026-07-13 §9): read-model over acceptance tasks enriched with
 * REAL roll facts from the operator contour, plus the global scan-by-payload entry that
 * auto-targets the owning order. The warehouse sees customer aliases only (ТЗ §4).
 */
@Injectable()
export class WarehouseIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly palletExport: PalletExportService,
    private readonly pallets: WarehousePalletService,
    @Inject(RUNTIME_CONFIG) private readonly config: Pick<RuntimeConfig, 'palletLabelProfile'>,
  ) {}

  // --- Палетный лист ---------------------------------------------------------

  /** Черновик палетного листа по задаче приёмки — данные без персиста. */
  async getPalletDraft(actor: WarehouseIntakeActor, taskId: string): Promise<PalletListPayload> {
    const task = await this.projectTaskById(taskId, actor.role);
    if (!task) throw new NotFoundException(`Acceptance task ${taskId} not found`);
    if (!task.activePallet || task.activePallet.rollCount === 0) {
      throw new ConflictException({
        code: 'WAREHOUSE_OPEN_PALLET_NOT_FOUND',
        message: 'В задаче нет непустого открытого палета.',
      });
    }
    return buildPalletListPayload(
      task,
      await this.actorName(actor),
      new Date().toISOString(),
      {
        palletId: task.activePallet.palletCode,
        rollCodes: task.activePallet.rows
          .slice()
          .sort((left, right) => left.position - right.position)
          .map((row) => row.rollCode),
        printReady: true,
      },
      this.config.palletLabelProfile,
    );
  }

  /** Персист палетного листа с полным снапшотом полей. */
  async createPalletList(actor: WarehouseIntakeActor, taskId: string) {
    const payload = await this.getPalletDraft(actor, taskId);
    const rollIds = payload.rows.map((row) => row.rollCode);
    if (!hasExactPalletDocumentComposition(payload, rollIds)) {
      throw new ConflictException({
        code: 'PALLET_LABEL_COMPOSITION_INVALID',
        message: 'Состав палетного листа не совпадает с палетом.',
        palletId: payload.palletId,
      });
    }
    if (!hasRenderablePalletDocumentSnapshot(payload)) {
      throw new ConflictException({
        code: 'PALLET_LABEL_NOT_RENDERABLE',
        message: 'Данные палетного листа не помещаются в печатный шаблон.',
        palletId: payload.palletId,
      });
    }
    const doc = await this.prisma.palletListDocument.create({
      data: {
        palletId: payload.palletId,
        rollIds,
        orderIds: payload.orderIds,
        generatedByRole: actor.role,
        format: palletLabelDocumentFormat(payload.templateVersion),
        fieldSetStatus: palletLabelFieldSetStatus(payload.templateVersion),
        payload,
      },
    });
    await this.audit.record({
      type: 'audit:pallet_list_created',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: doc.id,
      detail: { palletId: payload.palletId, rolls: payload.rows.length, taskId },
    });
    return doc;
  }

  /** Файл палетного листа и неизменяемый факт экспорта. */
  async exportPalletList(
    actor: WarehouseIntakeActor,
    palletListId: string,
    format: PalletExportFormat,
  ) {
    const doc = await this.prisma.palletListDocument.findUnique({ where: { id: palletListId } });
    if (!doc) throw new NotFoundException(`Pallet list ${palletListId} not found`);
    this.assertPalletDocumentActive(doc);
    const file = await this.palletExport.export(
      {
        id: doc.id,
        palletId: doc.palletId,
        payload: doc.payload as PalletListPayload | null,
        layoutPublicationId: doc.layoutPublicationId,
      },
      format,
    );
    await this.audit.record({
      type: 'audit:pallet_list_exported',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: doc.id,
      detail: { format },
    });
    return file;
  }

  /** PNG preview of the persisted immutable label; read-only and therefore not audited. */
  async previewPalletList(actor: WarehouseIntakeActor, palletListId: string) {
    void actor;
    const doc = await this.prisma.palletListDocument.findUnique({ where: { id: palletListId } });
    if (!doc) throw new NotFoundException(`Pallet list ${palletListId} not found`);
    this.assertPalletDocumentActive(doc);
    return this.palletExport.preview({
      id: doc.id,
      palletId: doc.palletId,
      payload: doc.payload as PalletListPayload | null,
      layoutPublicationId: doc.layoutPublicationId,
    });
  }

  private assertPalletDocumentActive(document: { voidedAt?: Date | null }): void {
    if (!document.voidedAt) return;
    throw new ConflictException({
      code: 'PALLET_LIST_DOCUMENT_VOIDED',
      message: 'Аннулированный палетный лист нельзя открыть или выгрузить.',
    });
  }

  private async actorName(actor: WarehouseIntakeActor): Promise<string | null> {
    if (!actor.userId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { displayName: true },
    });
    return user?.displayName ?? null;
  }

  async getIntake(actorRole: Role): Promise<WarehouseIntake> {
    const tasks = (await this.prisma.warehouseAcceptanceTask.findMany({
      where: { mode: 'receiving' },
      include: { rows: true },
      orderBy: { createdAt: 'desc' },
    })) as TaskWithRows[];
    const businessRollCodes = tasks.flatMap((task) =>
      task.rows.flatMap((row) => {
        const rollCode = projectParsedRollCode(row);
        return rollCode ? [rollCode] : [];
      }),
    );
    const [lineByCode, rollByCode, palletByTaskId] = await Promise.all([
      this.loadLines(businessRollCodes),
      this.loadWarehouseRolls(businessRollCodes),
      this.pallets.projectForTasks(tasks.map((task) => task.id)),
    ]);
    const plannedRollCountByOrderId = await this.loadPlannedRollCounts(tasks, lineByCode);
    return {
      stats: await this.computeStats(tasks),
      tasks: tasks.map((task) =>
        this.projectTask(
          task,
          lineByCode,
          rollByCode,
          plannedRollCountByOrderId,
          palletByTaskId,
          actorRole,
        ),
      ),
      generatedAt: new Date().toISOString(),
    };
  }

  async projectTaskById(taskId: string, actorRole: Role): Promise<WarehouseIntakeTaskView | null> {
    const task = (await this.prisma.warehouseAcceptanceTask.findUnique({
      where: { id: taskId },
      include: { rows: true },
    })) as TaskWithRows | null;
    if (!task) return null;
    const rollCodes = task.rows.flatMap((row) => {
      const rollCode = projectParsedRollCode(row);
      return rollCode ? [rollCode] : [];
    });
    const [lineByCode, rollByCode, palletByTaskId] = await Promise.all([
      this.loadLines(rollCodes),
      this.loadWarehouseRolls(rollCodes),
      this.pallets.projectForTasks([task.id]),
    ]);
    const plannedRollCountByOrderId = await this.loadPlannedRollCounts([task], lineByCode);
    return this.projectTask(
      task,
      lineByCode,
      rollByCode,
      plannedRollCountByOrderId,
      palletByTaskId,
      actorRole,
    );
  }

  private async loadLines(rollCodes: string[]): Promise<Map<string, OperatorLineProjection>> {
    const unique = [...new Set(rollCodes)];
    if (unique.length === 0) return new Map();
    const lines = (await this.prisma.operatorRollLine.findMany({
      where: { rollDispatchItem: { rollCode: { in: unique } } },
      include: {
        rollDispatchItem: {
          include: {
            assignedOperator: { select: { displayName: true } },
            post: { select: { id: true, name: true, code: true } },
            productionOrder: { include: { commercialOrder: { include: { counterparty: true } } } },
          },
        },
      },
    })) as OperatorLineProjection[];
    return new Map(lines.map((line) => [line.rollDispatchItem.rollCode, line]));
  }

  private async loadWarehouseRolls(
    rollCodes: string[],
  ): Promise<Map<string, WarehouseRollProjection>> {
    const unique = [...new Set(rollCodes)];
    if (unique.length === 0) return new Map();
    const rolls = (await this.prisma.warehouseRoll.findMany({
      where: { rollCode: { in: unique } },
      select: {
        rollCode: true,
        ownerCounterpartyId: true,
        reservedForOrderId: true,
        warehouseStatus: true,
        positionSnapshot: true,
      },
    })) as WarehouseRollProjection[];
    return new Map(rolls.map((roll) => [roll.rollCode, roll]));
  }

  private orderIdsForTask(
    task: TaskWithRows,
    lineByCode: Map<string, OperatorLineProjection>,
  ): string[] {
    return uniqueStrings([
      task.orderId ?? null,
      ...task.rows.map((row) => {
        const rollCode = projectParsedRollCode(row);
        return rollCode
          ? (lineByCode.get(rollCode)?.rollDispatchItem.productionOrder?.commercialOrder?.id ??
              null)
          : null;
      }),
    ]);
  }

  private async loadPlannedRollCounts(
    tasks: TaskWithRows[],
    lineByCode: Map<string, OperatorLineProjection>,
  ): Promise<Map<string, number>> {
    const orderIds = uniqueStrings(tasks.flatMap((task) => this.orderIdsForTask(task, lineByCode)));
    if (orderIds.length === 0) return new Map();
    const totals = await this.prisma.commercialOrderPosition.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orderIds } },
      _sum: { rollCount: true },
    });
    return new Map(totals.map((total) => [total.orderId, total._sum.rollCount ?? 0]));
  }

  private projectTask(
    task: TaskWithRows,
    lineByCode: Map<string, OperatorLineProjection>,
    rollByCode: Map<string, WarehouseRollProjection>,
    plannedRollCountByOrderId: Map<string, number>,
    palletByTaskId: Awaited<ReturnType<WarehousePalletService['projectForTasks']>>,
    actorRole: Role,
  ): WarehouseIntakeTaskView {
    const palletProjection = palletByTaskId.get(task.id) ?? {
      activePallet: null,
      history: [],
      hasMore: false,
      selectionsByScanRowId: new Map(),
    };
    const selectionsByScanRowId = palletProjection.selectionsByScanRowId ?? new Map();
    const rolls: WarehouseIntakeRollView[] = task.rows
      .filter((row) => projectParsedRollCode(row) !== null)
      .map((row) => ({
        ...projectWarehouseIntakeRoll(
          row,
          lineByCode.get(row.rollCode),
          rollByCode.get(row.rollCode),
          actorRole,
        ),
        palletSelection: selectionsByScanRowId.get(row.id) ?? {
          selected: false,
          locked: false,
          palletId: null,
          palletCode: null,
        },
      }))
      .sort((a, b) => a.sequence - b.sequence);

    const expected = task.rows.filter((row) => row.scanStatus === 'expected').length;
    const accepted = task.rows.filter((row) => row.scanStatus === 'accepted').length;
    const plannedRollCount = Math.max(
      expected + accepted,
      this.orderIdsForTask(task, lineByCode).reduce(
        (sum, orderId) => sum + (plannedRollCountByOrderId.get(orderId) ?? 0),
        0,
      ),
    );
    const errors = task.rows.filter((row) => ERROR_STATUSES.includes(row.scanStatus)).length;
    const closable = task.status !== 'closed' && task.rows.length > 0 && expected === 0;
    const orderNumbers = uniqueStrings(rolls.map((roll) => roll.orderNumber));
    const customerAliases = uniqueStrings(rolls.map((roll) => roll.customerAlias));
    const palletHistory = palletProjection.history.map((document) =>
      this.safePalletDocumentSummary(document),
    );
    const palletDoc = palletHistory[0] ?? null;

    return {
      taskId: task.id,
      operationCode: task.operationCode,
      orderNumbers,
      customerAliases,
      orderNumber: oneOrNull(orderNumbers),
      customerAlias: oneOrNull(customerAliases),
      status: this.taskStatus(task, rolls, closable),
      plannedRollCount,
      expected,
      accepted,
      errors,
      closable,
      lastScanResult: projectLastScanResult(task.rows),
      rolls,
      activePallet: palletProjection.activePallet,
      palletHistory,
      palletHistoryHasMore: palletProjection.hasMore,
      palletList: palletDoc
        ? {
            id: palletDoc.id,
            createdAt: palletDoc.createdAt,
            templateVersion: palletDoc.templateVersion,
            printReady: palletDoc.printReady,
            printStatus: palletDoc.printStatus,
          }
        : null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };
  }

  private taskStatus(
    task: TaskWithRows,
    rolls: WarehouseIntakeRollView[],
    closable: boolean,
  ): WarehouseIntakeTaskStatus {
    if (task.status === 'closed') return 'accepted';
    if (rolls.some((roll) => roll.scanStatus === 'damaged')) return 'has_defect';
    if (rolls.some((roll) => roll.scanStatus === 'reserved')) return 'has_reserve';
    if (
      rolls.some(
        (roll) =>
          roll.scanStatus === 'expected' && !WAREHOUSE_ARRIVED_STATES.has(roll.warehouseState),
      )
    ) {
      return 'awaiting_rolls';
    }
    if (closable) return 'pallet_open';
    return 'scanning';
  }

  private safePalletDocumentSummary(
    document: WarehousePalletDocumentSummary,
  ): WarehousePalletDocumentSummary {
    const rollCodes = Array.isArray(document.rollCodes)
      ? document.rollCodes.filter((rollCode): rollCode is string => typeof rollCode === 'string')
      : [];
    const boundedRollCodes = rollCodes.slice(0, WAREHOUSE_PALLET_SELECTION_ROW_LIMIT);
    return {
      id: document.id,
      palletId: document.palletId,
      warehousePalletId: document.warehousePalletId,
      origin: document.origin,
      createdAt: document.createdAt,
      templateVersion: document.templateVersion,
      documentStatus: document.documentStatus === 'voided' ? 'voided' : 'sealed',
      printReady: document.printReady,
      printStatus: document.printStatus,
      rollCount: document.rollCount,
      rollCodes: boundedRollCodes,
      rollCodesHasMore:
        document.rollCodesHasMore || rollCodes.length > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
      orderId: document.orderId,
    };
  }

  private async computeStats(tasks: TaskWithRows[]): Promise<WarehouseIntakeStats> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [todayOps, errors] = await Promise.all([
      this.prisma.scanRow.count({ where: { lastScanAt: { gte: todayStart } } }),
      this.prisma.scanRow.count({
        where: { lastScanAt: { gte: todayStart }, scanStatus: { in: ERROR_STATUSES } },
      }),
    ]);
    const remainingQr = tasks
      .filter((task) => task.status === 'open' || task.status === 'partial')
      .flatMap((task) => task.rows)
      .filter((row) => row.scanStatus === 'expected').length;
    return { todayOps, remainingQr, errors };
  }
}
