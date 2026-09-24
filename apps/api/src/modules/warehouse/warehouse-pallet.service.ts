import {
  BadRequestException,
  ConflictException,
  Inject,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PALLET_LABEL_CONFIGURABLE_PROFILE,
  WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
} from '@plenka/contracts';
import type {
  WarehouseIntakeTaskView,
  WarehousePalletDocumentSummary,
  WarehousePalletHistoryPage,
  WarehousePalletSelectionView,
  WarehousePalletView,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PalletLabelLayoutPublicationService } from '../../common/pallet-label-layout/pallet-label-layout-publication.service';
import type { RuntimeConfig } from '../../common/runtime-config';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import type { CloseAndPrintCurrentPalletDto } from './dto/close-and-print-pallet.dto';
import type { SealCurrentPalletDto } from './dto/seal-current-pallet.dto';
import type { PalletHistoryQueryDto } from './dto/pallet-history-query.dto';
import { buildPalletListPayload } from './pallet-list.builder';
import {
  hasExactPalletDocumentComposition,
  hasRenderablePalletDocumentSnapshot,
  immutablePalletLabelProfile,
  isBrowserOnlyPalletLabelProfile,
  palletLabelDocumentFormat,
  palletLabelFieldSetStatus,
} from './pallet-label-snapshot';
import { PalletPrintService, type PalletPrintResponse } from './pallet-print.service';
import {
  type OperatorLineProjection,
  projectWarehouseIntakeRoll,
  type ScanRowProjection,
  type WarehouseRollProjection,
} from './warehouse-intake-roll.projection';

export type PalletAssignmentTarget = {
  id: string;
  palletCode: string;
  orderId: string;
  sequenceNo: number;
};

export type PalletMembershipReleaseReason =
  | 'manual_deselection'
  | 'control_reweigh'
  | 'defect_reported';

type PrepareOpenPalletInput = {
  taskId: string;
  orderId: string;
  orderNumber: string;
  actor: Actor;
};

type AttachAcceptedRollInput = {
  pallet: PalletAssignmentTarget;
  scanRowId: string;
  rollCode: string;
  acceptedAt: Date;
  actorId: string | null;
};

const PALLET_TARGET_SELECT = {
  id: true,
  palletCode: true,
  orderId: true,
  sequenceNo: true,
} satisfies Prisma.WarehousePalletSelect;

const PALLET_DETAIL_INCLUDE = {
  order: { select: { id: true, orderNumber: true } },
  items: {
    where: { releasedAt: null },
    orderBy: { position: 'asc' as const },
    include: { scanRow: true },
  },
  document: {
    include: {
      printJobs: {
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: { status: true },
      },
    },
  },
} satisfies Prisma.WarehousePalletInclude;

const PALLET_SELECTION_ITEM_SELECT = {
  scanRowId: true,
  releasedAt: true,
  pallet: {
    select: {
      id: true,
      taskId: true,
      palletCode: true,
      status: true,
    },
  },
} satisfies Prisma.WarehousePalletItemSelect;

type PalletDetail = Prisma.WarehousePalletGetPayload<{
  include: typeof PALLET_DETAIL_INCLUDE;
}>;

type DocumentProjection = {
  id: string;
  palletId: string;
  warehousePalletId: string | null;
  origin: string;
  rollIds: Prisma.JsonValue;
  orderIds: Prisma.JsonValue;
  payload: Prisma.JsonValue | null;
  voidedAt: Date | null;
  createdAt: Date;
  printJobs?: Array<{ status: string }>;
  warehousePallet?: { orderId: string } | null;
};

type PalletSelectionItem = Prisma.WarehousePalletItemGetPayload<{
  select: typeof PALLET_SELECTION_ITEM_SELECT;
}>;

const ACTIVE_MEMBERSHIP_LIFECYCLE_SELECT = {
  id: true,
  palletId: true,
  orderId: true,
  rollCode: true,
  position: true,
  pallet: {
    select: {
      id: true,
      palletCode: true,
      taskId: true,
      orderId: true,
      status: true,
    },
  },
} satisfies Prisma.WarehousePalletItemSelect;

type ActiveMembershipLifecycle = Prisma.WarehousePalletItemGetPayload<{
  select: typeof ACTIVE_MEMBERSHIP_LIFECYCLE_SELECT;
}>;

export type ReleasedPalletMembership = {
  palletId: string;
  palletCode: string;
  orderId: string;
  rollCode: string;
  position: number;
  palletVoided: boolean;
};

type TaskPalletProjection = {
  activePallet: WarehousePalletView | null;
  history: WarehousePalletDocumentSummary[];
  hasMore: boolean;
  selectionsByScanRowId: Map<string, WarehousePalletSelectionView>;
};

export type CloseAndPrintCurrentPalletResult = {
  pallet: WarehousePalletView;
  document: WarehousePalletDocumentSummary;
  printJob: PalletPrintResponse;
};

export type SealCurrentPalletResult = {
  pallet: WarehousePalletView;
  document: WarehousePalletDocumentSummary;
};

const HISTORY_LIMIT = 20;

@Injectable()
export class WarehousePalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly palletPrint: PalletPrintService,
    @Inject(RUNTIME_CONFIG) private readonly config: Pick<RuntimeConfig, 'palletLabelProfile'>,
    private readonly fulfillment: OrderFulfillmentHandoffService,
    @Optional() private readonly layoutPublications?: PalletLabelLayoutPublicationService,
  ) {}

  async prepareOpenPallet(
    tx: Prisma.TransactionClient,
    input: PrepareOpenPalletInput,
  ): Promise<PalletAssignmentTarget> {
    const current = await this.findOpen(tx, input.taskId);
    if (current) return this.assertSameOrder(current, input.orderId);

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-pallet-sequence:${input.orderId}`}))`;

    const afterLock = await this.findOpen(tx, input.taskId);
    if (afterLock) return this.assertSameOrder(afterLock, input.orderId);

    const latest = await tx.warehousePallet.findFirst({
      where: { orderId: input.orderId },
      orderBy: { sequenceNo: 'desc' },
      select: { sequenceNo: true },
    });
    const sequenceNo = (latest?.sequenceNo ?? 0) + 1;
    const pallet = await tx.warehousePallet.create({
      data: {
        palletCode: this.palletCode(input.orderNumber, input.orderId, sequenceNo),
        taskId: input.taskId,
        orderId: input.orderId,
        sequenceNo,
        openedById: input.actor.userId,
      },
      select: PALLET_TARGET_SELECT,
    });

    await this.audit.record(
      {
        type: 'audit:warehouse_pallet_opened',
        actorRole: input.actor.role,
        actorId: input.actor.userId,
        objectId: pallet.id,
        detail: {
          palletCode: pallet.palletCode,
          taskId: input.taskId,
          orderId: input.orderId,
          sequenceNo,
        },
      },
      tx,
    );

    return pallet;
  }

  async attachAcceptedRoll(
    tx: Prisma.TransactionClient,
    input: AttachAcceptedRollInput,
  ): Promise<{ position: number }> {
    const existing = await tx.warehousePalletItem.findFirst({
      where: { scanRowId: input.scanRowId, releasedAt: null },
      select: {
        palletId: true,
        orderId: true,
        rollCode: true,
        position: true,
      },
    });
    if (existing) {
      if (
        existing.palletId === input.pallet.id &&
        existing.orderId === input.pallet.orderId &&
        existing.rollCode === input.rollCode
      ) {
        return { position: existing.position };
      }
      throw new ConflictException({
        code: 'WAREHOUSE_PALLET_ITEM_CONFLICT',
        message: 'Принятый рулон уже относится к другому палету.',
      });
    }

    const positions = await tx.warehousePalletItem.aggregate({
      where: { palletId: input.pallet.id },
      _max: { position: true },
    });
    const position = (positions._max.position ?? 0) + 1;

    return tx.warehousePalletItem.create({
      data: {
        palletId: input.pallet.id,
        scanRowId: input.scanRowId,
        orderId: input.pallet.orderId,
        rollCode: input.rollCode,
        position,
        acceptedAt: input.acceptedAt,
        assignedById: input.actorId,
      },
      select: { position: true },
    });
  }

  async assertMembershipMutable(
    tx: Prisma.TransactionClient,
    taskId: string,
    scanRowId: string,
  ): Promise<void> {
    const active = await this.findActiveMembership(tx, scanRowId);
    if (active) this.assertActiveMembershipMutable(active, taskId);
  }

  async releaseActiveMembership(
    tx: Prisma.TransactionClient,
    input: {
      actor: Actor;
      taskId: string;
      scanRowId: string;
      reason: PalletMembershipReleaseReason;
    },
  ): Promise<ReleasedPalletMembership | null> {
    const active = await this.findActiveMembership(tx, input.scanRowId);
    if (!active) return null;
    this.assertActiveMembershipMutable(active, input.taskId);

    const releasedAt = new Date();
    const released = await tx.warehousePalletItem.updateMany({
      where: {
        id: active.id,
        releasedAt: null,
        pallet: { status: 'open' },
      },
      data: {
        releasedAt,
        releasedById: input.actor.userId,
        releaseReason: input.reason,
      },
    });
    if (released.count !== 1) {
      throw this.membershipLocked(active.palletId, active.pallet.status);
    }

    await this.audit.record(
      {
        type: 'audit:warehouse_pallet_roll_deselected',
        actorRole: input.actor.role,
        actorId: input.actor.userId,
        objectId: active.rollCode,
        reason: input.reason,
        oldValue: { selected: true },
        newValue: { selected: false },
        detail: {
          taskId: input.taskId,
          palletId: active.palletId,
          palletCode: active.pallet.palletCode,
          orderId: active.orderId,
          scanRowId: input.scanRowId,
          rollCode: active.rollCode,
          position: active.position,
          releaseReason: input.reason,
        },
      },
      tx,
    );

    const palletVoided = await this.voidEmptyOpenPallet(
      tx,
      input.actor,
      active,
      input.reason,
      releasedAt,
    );
    return {
      palletId: active.palletId,
      palletCode: active.pallet.palletCode,
      orderId: active.orderId,
      rollCode: active.rollCode,
      position: active.position,
      palletVoided,
    };
  }

  private async sealCurrentPalletSnapshot(
    actor: Actor,
    taskId: string,
    dto: Pick<CloseAndPrintCurrentPalletDto, 'requestId'>,
    mode: 'seal' | 'close-and-print' = 'seal',
  ): Promise<{ pallet: WarehousePalletView; document: DocumentProjection }> {
    const sealed = await this.serializable(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${taskId} FOR UPDATE`;
      const task = await tx.warehouseAcceptanceTask.findUnique({ where: { id: taskId } });
      if (!task) {
        throw new NotFoundException({
          code: 'WAREHOUSE_TASK_NOT_FOUND',
          message: 'Складская задача не найдена.',
        });
      }
      if (task.mode !== 'receiving') {
        throw new ConflictException({
          code: 'WAREHOUSE_PALLET_TASK_MODE_INVALID',
          message: 'Физический палет закрывается только во время приёмки.',
        });
      }

      const replay = await tx.warehousePallet.findFirst({
        where: { taskId, closeRequestId: dto.requestId },
        include: PALLET_DETAIL_INCLUDE,
      });
      if (replay) {
        if (replay.status !== 'sealed' || !replay.document) {
          throw this.palletStateConflict();
        }
        return {
          pallet: this.palletView(replay),
          document: replay.document,
        };
      }

      const candidate = await tx.warehousePallet.findFirst({
        where: { taskId, status: 'open' },
        include: PALLET_DETAIL_INCLUDE,
      });
      if (!candidate) {
        throw new ConflictException({
          code: 'WAREHOUSE_OPEN_PALLET_NOT_FOUND',
          message: 'В задаче нет открытого палета для закрытия.',
        });
      }
      const pallet = await this.lockAndValidateSealComposition(tx, candidate);
      if (pallet.items.length === 0) {
        throw new ConflictException({
          code: 'WAREHOUSE_PALLET_EMPTY',
          message: 'Пустой палет нельзя закрыть или распечатать.',
          palletId: pallet.palletCode,
        });
      }

      const documentRollIds = pallet.items.map((item) => item.rollCode);
      const activePublication = (await this.layoutPublications?.activeForNewDocument(tx)) ?? null;
      const effectiveProfile = activePublication
        ? PALLET_LABEL_CONFIGURABLE_PROFILE
        : this.config.palletLabelProfile;
      if (mode === 'close-and-print' && isBrowserOnlyPalletLabelProfile(effectiveProfile)) {
        throw new ConflictException({
          code: 'PALLET_LABEL_BROWSER_PRINT_ONLY',
          message: 'Закройте палет и распечатайте квадратный палетный лист из браузера.',
        });
      }
      const builtPayload = await this.buildPhysicalPayload(
        tx,
        task,
        pallet,
        actor,
        effectiveProfile,
      );
      const payload = activePublication
        ? { ...builtPayload, layoutPublication: activePublication }
        : builtPayload;
      if (!hasExactPalletDocumentComposition(payload, documentRollIds)) {
        throw new ConflictException({
          code: 'PALLET_LABEL_COMPOSITION_INVALID',
          message: 'Состав палетного листа не совпадает с закрываемым палетом.',
          palletId: pallet.id,
          palletCode: pallet.palletCode,
        });
      }
      if (!hasRenderablePalletDocumentSnapshot(payload)) {
        throw new ConflictException({
          code: 'PALLET_LABEL_NOT_RENDERABLE',
          message: 'Данные палетного листа не помещаются в печатный шаблон.',
          palletId: pallet.id,
          palletCode: pallet.palletCode,
        });
      }
      const document = await tx.palletListDocument.create({
        data: {
          palletId: pallet.palletCode,
          warehousePalletId: pallet.id,
          acceptanceTaskId: taskId,
          origin: 'physical_pallet',
          rollIds: documentRollIds,
          orderIds: [pallet.orderId],
          generatedByRole: actor.role,
          format: palletLabelDocumentFormat(payload.templateVersion),
          fieldSetStatus: palletLabelFieldSetStatus(payload.templateVersion),
          payload,
          ...(activePublication ? { layoutPublicationId: activePublication.id } : {}),
        },
      });
      const sealedAt = new Date();
      const updated = await tx.warehousePallet.updateMany({
        where: { id: pallet.id, status: 'open' },
        data: {
          status: 'sealed',
          closeRequestId: dto.requestId,
          sealedAt,
          sealedById: actor.userId,
        },
      });
      if (updated.count !== 1) throw this.palletStateConflict();

      await this.audit.record(
        {
          type: 'audit:warehouse_pallet_sealed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: pallet.id,
          detail: {
            taskId,
            palletCode: pallet.palletCode,
            orderId: pallet.orderId,
            sequenceNo: pallet.sequenceNo,
            rollCount: pallet.items.length,
            documentId: document.id,
            closeRequestId: dto.requestId,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'audit:pallet_list_created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: document.id,
          detail: {
            taskId,
            palletId: pallet.palletCode,
            warehousePalletId: pallet.id,
            orderId: pallet.orderId,
            rolls: pallet.items.length,
          },
        },
        tx,
      );

      await this.fulfillment.reconcilePalletScan(
        { userId: actor.userId, role: actor.role },
        pallet.orderId,
        documentRollIds,
        tx,
      );

      return {
        pallet: this.palletView({
          ...pallet,
          status: 'sealed',
        }),
        document,
      };
    });

    return sealed;
  }

  async sealCurrentPallet(
    actor: Actor,
    taskId: string,
    dto: SealCurrentPalletDto,
  ): Promise<SealCurrentPalletResult> {
    const sealed = await this.sealCurrentPalletSnapshot(actor, taskId, dto);
    return {
      pallet: sealed.pallet,
      document: this.documentSummary(sealed.document),
    };
  }

  async closeAndPrint(
    actor: Actor,
    taskId: string,
    dto: CloseAndPrintCurrentPalletDto,
  ): Promise<CloseAndPrintCurrentPalletResult> {
    if (isBrowserOnlyPalletLabelProfile(this.config.palletLabelProfile)) {
      throw new ConflictException({
        code: 'PALLET_LABEL_BROWSER_PRINT_ONLY',
        message: 'Закройте палет и распечатайте квадратный палетный лист из браузера.',
      });
    }
    const sealed = await this.sealCurrentPalletSnapshot(actor, taskId, dto, 'close-and-print');
    try {
      const printJob = await this.palletPrint.print(actor, sealed.document.id, dto);
      return {
        pallet: sealed.pallet,
        document: this.documentSummary(
          sealed.document,
          printJob.status === 'submitted' ? 'submitted' : 'not_printed',
        ),
        printJob,
      };
    } catch (error) {
      this.throwPrintError(error, sealed.document, sealed.pallet);
    }
  }

  async projectForTasks(taskIds: string[]): Promise<Map<string, TaskPalletProjection>> {
    const uniqueTaskIds = [...new Set(taskIds)];
    const result = new Map<string, TaskPalletProjection>(
      uniqueTaskIds.map((taskId) => [
        taskId,
        { activePallet: null, history: [], hasMore: false, selectionsByScanRowId: new Map() },
      ]),
    );
    if (uniqueTaskIds.length === 0) return result;

    const [activePallets, historyByTask, selectionItems] = await Promise.all([
      this.prisma.warehousePallet.findMany({
        where: { taskId: { in: uniqueTaskIds }, status: 'open' },
        include: PALLET_DETAIL_INCLUDE,
      }),
      Promise.all(
        uniqueTaskIds.map(async (taskId) => ({
          taskId,
          documents: await this.prisma.palletListDocument.findMany({
            where: { acceptanceTaskId: taskId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: HISTORY_LIMIT + 1,
            include: {
              warehousePallet: { select: { orderId: true } },
              printJobs: {
                where: { status: { in: ['submitted', 'failed', 'delivery_unknown'] } },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { status: true },
              },
            },
          }),
        })),
      ),
      this.prisma.warehousePalletItem.findMany({
        where: {
          releasedAt: null,
          pallet: { taskId: { in: uniqueTaskIds }, status: { in: ['open', 'sealed'] } },
        },
        select: PALLET_SELECTION_ITEM_SELECT,
      }),
    ]);

    for (const pallet of activePallets) {
      const projection = result.get(pallet.taskId);
      if (projection) projection.activePallet = this.palletView(pallet);
    }
    for (const { taskId, documents } of historyByTask) {
      const projection = result.get(taskId);
      if (!projection) continue;
      projection.hasMore = documents.length > HISTORY_LIMIT;
      projection.history = documents
        .slice(0, HISTORY_LIMIT)
        .map((document) => this.documentSummary(document));
    }
    for (const item of selectionItems as PalletSelectionItem[]) {
      if (item.releasedAt || item.pallet.status === 'voided') continue;
      const projection = result.get(item.pallet.taskId);
      if (!projection) continue;
      projection.selectionsByScanRowId.set(item.scanRowId, {
        selected: true,
        locked: item.pallet.status === 'sealed',
        palletId: item.pallet.id,
        palletCode: item.pallet.palletCode,
      });
    }
    return result;
  }

  async listTaskPallets(
    taskId: string,
    query: Pick<PalletHistoryQueryDto, 'cursor' | 'limit'>,
  ): Promise<WarehousePalletHistoryPage> {
    const limit = query.limit ?? HISTORY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('Pallet history limit must be between 1 and 100');
    }
    const cursor = this.decodeHistoryCursor(query.cursor);
    const task = await this.prisma.warehouseAcceptanceTask.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: 'WAREHOUSE_TASK_NOT_FOUND',
        message: 'Складская задача не найдена.',
      });
    }

    const [activePallet, documents] = await Promise.all([
      this.prisma.warehousePallet.findFirst({
        where: { taskId, status: 'open' },
        include: PALLET_DETAIL_INCLUDE,
      }),
      this.prisma.palletListDocument.findMany({
        where: {
          acceptanceTaskId: taskId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: {
          warehousePallet: { select: { orderId: true } },
          printJobs: {
            where: { status: { in: ['submitted', 'failed', 'delivery_unknown'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true },
          },
        },
      }),
    ]);
    const hasMore = documents.length > limit;
    const visible = documents.slice(0, limit);
    const last = hasMore ? visible.at(-1) : null;
    return {
      activePallet: activePallet ? this.palletView(activePallet) : null,
      items: visible.map((document) => this.documentSummary(document)),
      nextCursor: last ? this.encodeHistoryCursor(last) : null,
    };
  }

  async assertNoOpenItems(tx: Prisma.TransactionClient, taskId: string): Promise<void> {
    const pallet = await tx.warehousePallet.findFirst({
      where: { taskId, status: 'open' },
      select: {
        id: true,
        palletCode: true,
        _count: { select: { items: { where: { releasedAt: null } } } },
      },
    });
    if (!pallet || pallet._count.items === 0) return;

    throw new ConflictException({
      code: 'WAREHOUSE_OPEN_PALLET_NOT_SEALED',
      message: 'Сначала закройте и распечатайте текущий палет.',
      palletId: pallet.id,
      palletCode: pallet.palletCode,
      rollCount: pallet._count.items,
    });
  }

  private findOpen(tx: Prisma.TransactionClient, taskId: string) {
    return tx.warehousePallet.findFirst({
      where: { taskId, status: 'open' },
      select: PALLET_TARGET_SELECT,
    });
  }

  private findActiveMembership(
    tx: Prisma.TransactionClient,
    scanRowId: string,
  ): Promise<ActiveMembershipLifecycle | null> {
    return tx.warehousePalletItem.findFirst({
      where: { scanRowId, releasedAt: null },
      select: ACTIVE_MEMBERSHIP_LIFECYCLE_SELECT,
    });
  }

  private assertActiveMembershipMutable(active: ActiveMembershipLifecycle, taskId: string): void {
    if (active.pallet.status !== 'open' || active.pallet.taskId !== taskId) {
      throw this.membershipLocked(active.palletId, active.pallet.status);
    }
  }

  private async voidEmptyOpenPallet(
    tx: Prisma.TransactionClient,
    actor: Actor,
    active: ActiveMembershipLifecycle,
    triggerReleaseReason: PalletMembershipReleaseReason,
    voidedAt: Date,
  ): Promise<boolean> {
    const remaining = await tx.warehousePalletItem.count({
      where: { palletId: active.palletId, releasedAt: null },
    });
    if (remaining > 0) return false;

    const voided = await tx.warehousePallet.updateMany({
      where: {
        id: active.palletId,
        status: 'open',
        items: { none: { releasedAt: null } },
      },
      data: {
        status: 'voided',
        voidedAt,
        voidedById: actor.userId,
        voidReason: 'empty_after_last_release',
      },
    });
    if (voided.count !== 1) {
      throw this.membershipLocked(active.palletId, active.pallet.status);
    }

    await this.audit.record(
      {
        type: 'audit:warehouse_pallet_voided',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: active.palletId,
        reason: 'empty_after_last_release',
        oldValue: { status: 'open' },
        newValue: { status: 'voided' },
        detail: {
          taskId: active.pallet.taskId,
          palletId: active.palletId,
          palletCode: active.pallet.palletCode,
          orderId: active.orderId,
          reasonCode: 'empty_after_last_release',
          triggerReleaseReason,
          documentId: null,
        },
      },
      tx,
    );
    return true;
  }

  private async lockAndValidateSealComposition(
    tx: Prisma.TransactionClient,
    candidate: PalletDetail,
  ): Promise<PalletDetail> {
    await tx.$queryRaw`
      SELECT item."id"
      FROM "warehouse_pallet_items" item
      INNER JOIN "scan_rows" scan ON scan."id" = item."scanRowId"
      WHERE item."palletId" = ${candidate.id}
        AND item."releasedAt" IS NULL
      ORDER BY item."position"
      FOR UPDATE OF item, scan
    `;
    const pallet = await tx.warehousePallet.findUnique({
      where: { id: candidate.id },
      include: PALLET_DETAIL_INCLUDE,
    });
    if (!pallet || pallet.status !== 'open') throw this.palletStateConflict();

    const invalid = pallet.items.filter((item) => item.scanRow.scanStatus !== 'accepted');
    if (invalid.length > 0) {
      throw new ConflictException({
        code: 'WAREHOUSE_PALLET_COMPOSITION_INVALID',
        message: 'Состав палета изменился. Обновите задачу и сформируйте палет заново.',
        palletId: pallet.id,
        palletCode: pallet.palletCode,
        invalidRollCount: invalid.length,
      });
    }
    return pallet;
  }

  private async buildPhysicalPayload(
    tx: Prisma.TransactionClient,
    task: {
      id: string;
      operationCode: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    pallet: PalletDetail,
    actor: Actor,
    profile = this.config.palletLabelProfile,
  ) {
    const rollCodes = pallet.items.map((item) => item.rollCode);
    const [lines, warehouseRolls, user] = await Promise.all([
      tx.operatorRollLine.findMany({
        where: { rollDispatchItem: { rollCode: { in: rollCodes } } },
        include: {
          rollDispatchItem: {
            include: {
              assignedOperator: { select: { displayName: true } },
              post: { select: { id: true, name: true, code: true } },
              productionOrder: {
                include: { commercialOrder: { include: { counterparty: true } } },
              },
            },
          },
        },
      }),
      tx.warehouseRoll.findMany({
        where: { rollCode: { in: rollCodes } },
        select: {
          rollCode: true,
          ownerCounterpartyId: true,
          reservedForOrderId: true,
          warehouseStatus: true,
          positionSnapshot: true,
        },
      }),
      actor.userId
        ? tx.user.findUnique({
            where: { id: actor.userId },
            select: { displayName: true },
          })
        : Promise.resolve(null),
    ]);
    const lineByCode = new Map(
      (lines as unknown as OperatorLineProjection[]).map((line) => [
        line.rollDispatchItem.rollCode,
        line,
      ]),
    );
    const warehouseRollByCode = new Map(
      (warehouseRolls as WarehouseRollProjection[]).map((roll) => [roll.rollCode, roll]),
    );
    const rolls = pallet.items.map((item) => ({
      ...projectWarehouseIntakeRoll(
        item.scanRow as ScanRowProjection,
        lineByCode.get(item.rollCode),
        warehouseRollByCode.get(item.rollCode),
        actor.role,
      ),
      orderId: pallet.orderId,
      orderNumber: pallet.order.orderNumber,
      scanStatus: 'accepted' as const,
    }));
    const customerAliases = [
      ...new Set(
        rolls
          .map((roll) => roll.customerAlias)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ];
    const taskView: WarehouseIntakeTaskView = {
      taskId: task.id,
      operationCode: task.operationCode,
      orderNumbers: [pallet.order.orderNumber],
      customerAliases,
      orderNumber: pallet.order.orderNumber,
      customerAlias: customerAliases.length === 1 ? customerAliases[0] : null,
      status: 'scanning',
      plannedRollCount: rolls.length,
      expected: 0,
      accepted: rolls.length,
      errors: 0,
      closable: false,
      lastScanResult: null,
      rolls,
      activePallet: null,
      palletHistory: [],
      palletHistoryHasMore: false,
      palletList: null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };

    return buildPalletListPayload(
      taskView,
      user?.displayName ?? null,
      new Date().toISOString(),
      {
        palletId: pallet.palletCode,
        rollCodes,
        printReady: true,
      },
      profile,
    );
  }

  private palletView(
    pallet: Pick<
      PalletDetail,
      'id' | 'palletCode' | 'orderId' | 'sequenceNo' | 'status' | 'openedAt' | 'order' | 'items'
    >,
  ): WarehousePalletView {
    return {
      id: pallet.id,
      palletCode: pallet.palletCode,
      orderId: pallet.orderId,
      orderNumber: pallet.order.orderNumber,
      sequenceNo: pallet.sequenceNo,
      status: pallet.status === 'sealed' ? 'sealed' : 'open',
      rollCount: pallet.items.length,
      openedAt: pallet.openedAt.toISOString(),
      rows: pallet.items.map((item) => ({
        rollCode: item.rollCode,
        position: item.position,
        acceptedAt: item.acceptedAt.toISOString(),
        scannedByName: item.scanRow.scannedByName,
      })),
    };
  }

  private documentSummary(
    document: DocumentProjection,
    printStatus?: WarehousePalletDocumentSummary['printStatus'],
  ): WarehousePalletDocumentSummary {
    const rollIds = this.jsonStrings(document.rollIds);
    const orderIds = this.jsonStrings(document.orderIds);
    const payload = this.jsonRecord(document.payload);
    const templateVersion = immutablePalletLabelProfile(document.payload);
    if (!templateVersion) {
      throw new ConflictException({
        code: 'PALLET_LABEL_SNAPSHOT_INVALID',
        message: 'Профиль неизменяемого палетного листа повреждён.',
      });
    }
    return {
      id: document.id,
      palletId: document.palletId,
      warehousePalletId: document.warehousePalletId,
      origin: document.origin === 'physical_pallet' ? 'physical_pallet' : 'legacy',
      createdAt: document.createdAt.toISOString(),
      templateVersion,
      documentStatus: document.voidedAt ? 'voided' : 'sealed',
      printReady: payload.printReady === true,
      printStatus: printStatus ?? this.printStatus(document.printJobs?.[0]?.status),
      rollCount: rollIds.length,
      rollCodes: rollIds.slice(0, WAREHOUSE_PALLET_SELECTION_ROW_LIMIT),
      rollCodesHasMore: rollIds.length > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT,
      orderId: document.warehousePallet?.orderId ?? (orderIds.length === 1 ? orderIds[0] : null),
    };
  }

  private printStatus(status?: string): WarehousePalletDocumentSummary['printStatus'] {
    if (status === 'delivery_unknown') return 'needs_admin';
    if (status === 'failed') return 'failed';
    if (status === 'submitted') return 'submitted';
    return 'not_printed';
  }

  private jsonStrings(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Prisma.JsonValue>)
      : {};
  }

  private throwPrintError(
    error: unknown,
    document: DocumentProjection,
    pallet: WarehousePalletView,
  ): never {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      const safe =
        response && typeof response === 'object' && !Array.isArray(response)
          ? (response as Record<string, unknown>)
          : { message: typeof response === 'string' ? response : 'Печать не выполнена.' };
      throw new HttpException(
        {
          ...safe,
          documentId: document.id,
          palletId: pallet.palletCode,
          warehousePalletId: pallet.id,
        },
        error.getStatus(),
      );
    }
    throw new ServiceUnavailableException({
      code: 'PALLET_PRINT_FAILED',
      message: 'Палет закрыт, но отправить документ на печать не удалось.',
      documentId: document.id,
      palletId: pallet.palletCode,
      warehousePalletId: pallet.id,
    });
  }

  private palletStateConflict() {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_STATE_CONFLICT',
      message: 'Состояние палета изменилось конкурентно. Обновите задачу.',
    });
  }

  private membershipLocked(palletId: string, palletStatus: string) {
    return new ConflictException({
      code: 'WAREHOUSE_PALLET_SELECTION_LOCKED',
      message: 'Состав закрытого палета нельзя изменить.',
      palletId,
      palletStatus,
    });
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (this.retryable(error) && attempt < 2) continue;
        if (this.retryable(error)) throw this.palletStateConflict();
        throw error;
      }
    }
    throw this.palletStateConflict();
  }

  private retryable(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code === 'P2002' || error.code === 'P2034') return true;
    const meta = error.meta as { code?: unknown } | undefined;
    return error.code === 'P2010' && meta?.code === '40001';
  }

  private decodeHistoryCursor(value?: string): { createdAt: Date; id: string } | null {
    if (!value) return null;
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
        createdAt?: unknown;
        id?: unknown;
      };
      if (
        typeof decoded.createdAt !== 'string' ||
        Number.isNaN(Date.parse(decoded.createdAt)) ||
        typeof decoded.id !== 'string' ||
        decoded.id.length === 0
      ) {
        throw new Error('invalid cursor');
      }
      return { createdAt: new Date(decoded.createdAt), id: decoded.id };
    } catch {
      throw new BadRequestException('Invalid pallet history cursor');
    }
  }

  private encodeHistoryCursor(value: { createdAt: Date; id: string }): string {
    return Buffer.from(
      JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id }),
    ).toString('base64url');
  }

  private assertSameOrder(pallet: PalletAssignmentTarget, orderId: string): PalletAssignmentTarget {
    if (pallet.orderId === orderId) return pallet;

    throw new ConflictException({
      code: 'WAREHOUSE_PALLET_ORDER_MISMATCH',
      message: 'Сначала закройте и распечатайте текущий палет.',
      activePalletCode: pallet.palletCode,
      activeOrderId: pallet.orderId,
      attemptedOrderId: orderId,
    });
  }

  private palletCode(orderNumber: string, orderId: string, sequenceNo: number): string {
    const safeOrderNumber =
      orderNumber
        .normalize('NFKC')
        .trim()
        .toUpperCase()
        .replace(/[^A-ZА-ЯЁ0-9]+/giu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) ||
      orderId
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '')
        .slice(0, 16);
    return `PAL-${safeOrderNumber}-${String(sequenceNo).padStart(2, '0')}`;
  }
}
