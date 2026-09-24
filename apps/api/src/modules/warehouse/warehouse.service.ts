import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Role,
  WarehouseCoverCheckPage,
  WarehouseCoverCheckState,
  WarehouseCoverStatus,
  WarehouseCoverageWorkflowVersion,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { WAREHOUSE_COVER_ACTIONABLE_WHERE } from '../../common/warehouse-cover-task';
import type { CloseTaskDto } from './dto/close.dto';
import type { ReserveDto } from './dto/reserve.dto';
import type { CreatePalletListDto } from './dto/pallet-list.dto';
import type { RawAdjustDto } from './dto/raw-adjust.dto';
import type { RawReceiptDto } from './dto/raw-receipt.dto';
import type { CoverProposeDto } from './dto/cover-propose.dto';
import { DeferredPaymentService } from '../finance/deferred-payment.service';
import {
  criteriaAreCompatible,
  evaluateWarehouseCoverCompatibility,
} from '../commercial/commercial-cover.service';
import { projectWarehouseTask, type WarehouseTaskWithRows } from './warehouse-task.projection';
import { WarehouseOperationService } from './warehouse-operation.service';
import type { WarehouseRollResponseDto } from './dto/warehouse-roll-response.dto';
import { assertCoverageWorkflow } from '../warehouse-coverage/warehouse-coverage-workflow';
import { WarehousePalletService } from './warehouse-pallet.service';

export interface WarehouseActor {
  userId: string | null;
  role: Role;
}

export interface WarehouseCoverCheckQuery {
  cursor?: string;
  limit?: number;
  state?: WarehouseCoverCheckState;
}

type WarehouseCoverCursor = { updatedAt: string; id: string };
type RawMaterialCommandKind = 'adjustment' | 'receipt';
type RawMaterialCommandFingerprint = {
  kind: RawMaterialCommandKind;
  operationKey: string;
  materialId: string;
  quantity: number;
  reason: string;
  actor: WarehouseActor;
};
type RawMaterialCommandEvent = {
  type: string;
  objectId: string | null;
  actorId: string | null;
  actorRole: Role | null;
  detail: Prisma.JsonValue | null;
  reason: string | null;
};

const RAW_MATERIAL_COMMAND_EVENT_TYPES = [
  'audit:inventory_manual_correction',
  'audit:raw_material_received',
] as const;

const CURRENT_COVER_PROPOSAL_STATUSES = [
  'partial_proposed',
  'full_proposed',
  'partial_confirmed',
  'full_confirmed',
  'needs_production',
] as const;

const WAREHOUSE_ROLL_SAFE_SELECT = {
  id: true,
  rollCode: true,
  warehouseStatus: true,
  positionSnapshot: true,
} satisfies Prisma.WarehouseRollSelect;

type WarehouseRollSafeRow = Prisma.WarehouseRollGetPayload<{
  select: typeof WAREHOUSE_ROLL_SAFE_SELECT;
}>;

function snapshotRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return value as Record<string, Prisma.JsonValue>;
}

function snapshotString(snapshot: Record<string, Prisma.JsonValue>, key: string): string | null {
  const value = snapshot[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function snapshotNumber(snapshot: Record<string, Prisma.JsonValue>, key: string): number | null {
  const value = snapshot[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeRawCommandQuantity(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function projectWarehouseRoll(row: WarehouseRollSafeRow): WarehouseRollResponseDto {
  const snapshot = snapshotRecord(row.positionSnapshot);
  return {
    id: row.id,
    rollCode: row.rollCode,
    warehouseStatus: row.warehouseStatus,
    facts: {
      filmType: snapshotString(snapshot, 'filmType'),
      actualThickness: snapshotString(snapshot, 'actualThickness'),
      birka: snapshotString(snapshot, 'birka'),
      spoolType: snapshotString(snapshot, 'spoolType'),
      plannedWeightKg: snapshotNumber(snapshot, 'plannedWeightKg'),
    },
  };
}

function requiredCoverPositionIds(
  affectedPositionIds: Prisma.JsonValue,
  currentPositionIds: string[],
): string[] {
  if (
    !Array.isArray(affectedPositionIds) ||
    affectedPositionIds.length === 0 ||
    affectedPositionIds.some((positionId) => typeof positionId !== 'string')
  ) {
    throw new ConflictException('Warehouse cover task scope is invalid');
  }
  const requiredPositionIds = [...new Set(affectedPositionIds as string[])];
  const currentPositionIdSet = new Set(currentPositionIds);
  if (requiredPositionIds.some((positionId) => !currentPositionIdSet.has(positionId))) {
    throw new ConflictException(
      'Warehouse cover task contains positions outside the current order',
    );
  }
  return requiredPositionIds;
}

const COVER_CHECK_CASE_SELECT = {
  id: true,
  status: true,
  affectedPositionIds: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      counterparty: { select: { displayName: true } },
      positions: {
        select: {
          id: true,
          rollCount: true,
          filmType: true,
          actualThickness: true,
          accountingThickness: true,
          rawMaterialId: true,
          spoolType: true,
          birka: true,
          plannedWeightKg: true,
          warehouseCoverStatus: true,
        },
        orderBy: { id: 'asc' },
      },
    },
  },
} satisfies Prisma.OrderResolutionCaseSelect;

function decodeCoverCursor(value?: string): WarehouseCoverCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as WarehouseCoverCursor;
    if (
      typeof cursor.id !== 'string' ||
      !cursor.id ||
      typeof cursor.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(cursor.updatedAt))
    ) {
      throw new Error('invalid cursor');
    }
    return cursor;
  } catch {
    throw new BadRequestException('Invalid warehouse cover-check cursor');
  }
}

function encodeCoverCursor(cursor: { updatedAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deferredPayment: DeferredPaymentService,
    private readonly fulfillmentHandoff: OrderFulfillmentHandoffService,
    private readonly operations: WarehouseOperationService,
    private readonly pallets: WarehousePalletService,
  ) {}

  async listTasks(mode?: string) {
    const tasks = await this.prisma.warehouseAcceptanceTask.findMany({
      where: mode ? { mode } : {},
      include: { rows: true },
      orderBy: { createdAt: 'desc' },
    });
    return this.projectTasks(tasks);
  }

  async getTask(taskId: string) {
    const task = await this.prisma.warehouseAcceptanceTask.findUnique({
      where: { id: taskId },
      include: { rows: true },
    });
    if (!task) throw new NotFoundException(`Acceptance task ${taskId} not found`);
    return (await this.projectTasks([task]))[0]!;
  }

  private async projectTasks(tasks: WarehouseTaskWithRows[]) {
    const orderReferences = Array.from(
      new Set(
        tasks
          .filter((task) => ['delivery', 'reserve'].includes(task.mode))
          .flatMap((task) => [task.orderId, ...task.rows.map((row) => row.fromOrderId)])
          .filter((reference): reference is string => Boolean(reference)),
      ),
    );
    const orders = orderReferences.length
      ? await this.prisma.commercialOrder.findMany({
          where: {
            OR: [{ id: { in: orderReferences } }, { orderNumber: { in: orderReferences } }],
          },
          select: {
            id: true,
            orderNumber: true,
            counterparty: { select: { displayName: true } },
          },
        })
      : [];
    const customerAliasByOrderReference = new Map<string, string>();
    for (const order of orders) {
      const customerAlias = order.counterparty?.displayName.trim();
      if (!customerAlias) continue;
      customerAliasByOrderReference.set(order.id, customerAlias);
      customerAliasByOrderReference.set(order.orderNumber, customerAlias);
    }
    return tasks.map((task) => projectWarehouseTask(task, customerAliasByOrderReference));
  }

  async closeTask(actor: WarehouseActor, taskId: string, dto: CloseTaskDto) {
    const current = await this.requireTask(taskId);
    this.assertLegacyTaskMutable(current);
    if (current.status === 'closed') return this.getTask(taskId);
    if (dto.mode === 'full') await this.expireStaleControlWeights(actor, taskId);

    await this.prisma.$transaction((tx) => this.closeTaskInTransaction(actor, taskId, dto, tx));
    return this.getTask(taskId);
  }

  async closeTaskInTransaction(
    actor: WarehouseActor,
    taskId: string,
    dto: CloseTaskDto,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${taskId} FOR UPDATE`;
    const task = await tx.warehouseAcceptanceTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Acceptance task ${taskId} not found`);
    this.assertLegacyTaskMutable(task);
    const nextStatus = dto.mode === 'full' ? 'closed' : 'partial';
    if (task.status === 'closed' || task.status === nextStatus) return;

    if (dto.mode === 'full') {
      await this.pallets.assertNoOpenItems(tx, taskId);
      const active = await tx.warehouseOperation.findFirst({
        where: { taskId, kind: 'control_weight', status: 'in_progress' },
        select: { id: true },
      });
      if (active) {
        throw new ConflictException({
          code: 'WAREHOUSE_PHYSICAL_OPERATION_IN_PROGRESS',
          message: 'Дождитесь завершения физической операции и повторите закрытие.',
        });
      }
    }

    const assertFullyScanned = async () => {
      const rows = await tx.scanRow.findMany({ where: { taskId } });
      if (
        task.mode === 'receiving' &&
        task.orderId &&
        task.receivingScopeKey === `commercial-order:${task.orderId}`
      ) {
        const activeDispatches = await tx.rollDispatchItem.findMany({
          where: {
            productionOrder: { commercialOrderId: task.orderId },
            cancelledAt: null,
            status: { notIn: ['cancelled', 'defect'] },
          },
          select: { rollCode: true },
          orderBy: { rollCode: 'asc' },
        });
        const presentRollCodes = new Set(rows.map(({ rollCode }) => rollCode));
        const missingRollCodes = activeDispatches
          .map(({ rollCode }) => rollCode)
          .filter((rollCode) => !presentRollCodes.has(rollCode));
        if (missingRollCodes.length > 0) {
          throw new ConflictException({
            code: 'WAREHOUSE_ORDER_INTAKE_INCOMPLETE',
            message: 'Нельзя закрыть приёмку: не все рулоны заказа переданы на склад.',
            missingRollCount: missingRollCodes.length,
            missingRollCodes: missingRollCodes.slice(0, 20),
          });
        }
      }
      const remaining = rows.filter((row) => row.scanStatus === 'expected').length;
      if (remaining > 0) {
        throw new ConflictException(
          `Нельзя закрыть заказ полностью: не отсканировано рулонов — ${remaining}.`,
        );
      }
      for (const row of rows) {
        if (!['accepted', 'reserved', 'damaged'].includes(row.scanStatus)) {
          throw new ConflictException({
            code: 'WAREHOUSE_TASK_EVIDENCE_INCOMPLETE',
            message: 'Задача содержит строку без допустимого физического результата.',
          });
        }
        const scan = await tx.warehouseOperation.findFirst({
          where: {
            scanRowId: row.id,
            kind: { in: ['receiving_scan', 'reserve_scan', 'delivery_scan'] },
            status: 'succeeded',
          },
          select: { id: true },
        });
        const requiredFollowup =
          row.scanStatus === 'reserved'
            ? 'control_weight'
            : row.scanStatus === 'damaged'
              ? 'mark_damaged'
              : null;
        const followup = requiredFollowup
          ? await tx.warehouseOperation.findFirst({
              where: { scanRowId: row.id, kind: requiredFollowup, status: 'succeeded' },
              select: { id: true },
            })
          : { id: 'not-required' };
        if (!scan || !followup) {
          throw new ConflictException({
            code: 'WAREHOUSE_TASK_EVIDENCE_INCOMPLETE',
            message: 'Физическое подтверждение строки отсутствует.',
          });
        }
      }
      if (task.mode === 'receiving') {
        await this.assertReceivingPalletEvidence(tx, taskId);
      }
    };
    if (dto.mode === 'full') await assertFullyScanned();

    let claimed = await tx.warehouseAcceptanceTask.updateMany({
      where: { id: taskId, status: task.status },
      data: { status: nextStatus },
    });
    if (claimed.count !== 1) {
      const winner = await tx.warehouseAcceptanceTask.findUnique({ where: { id: taskId } });
      if (!winner) throw new NotFoundException(`Acceptance task ${taskId} not found`);
      if (dto.mode === 'partial' && ['partial', 'closed'].includes(winner.status)) return;
      if (dto.mode === 'full' && winner.status === 'closed') return;
      if (dto.mode === 'full' && winner.status === 'partial') {
        await assertFullyScanned();
        claimed = await tx.warehouseAcceptanceTask.updateMany({
          where: { id: taskId, status: 'partial' },
          data: { status: 'closed' },
        });
        if (claimed.count === 1) {
          // This request owns the partial -> closed transition and must finish its side effects.
        } else {
          const retried = await tx.warehouseAcceptanceTask.findUnique({
            where: { id: taskId },
          });
          if (retried?.status === 'closed') return;
          throw new ConflictException({
            code: 'WAREHOUSE_TASK_CLOSE_STALE',
            message: 'Состояние складской задачи изменилось. Обновите задачу.',
          });
        }
      } else {
        throw new ConflictException({
          code: 'WAREHOUSE_TASK_CLOSE_STALE',
          message: 'Состояние складской задачи изменилось. Обновите задачу.',
        });
      }
    }

    const completedRows = await tx.scanRow.findMany({
      where: { taskId, scanStatus: { in: ['accepted', 'reserved', 'damaged'] } },
    });
    const orderNumbers = [
      ...new Set(
        completedRows
          .map((row) => row.fromOrderId)
          .filter((orderNumber): orderNumber is string => Boolean(orderNumber)),
      ),
    ];
    const isDelivery = task.mode === 'delivery';
    const shipmentCompletedAt = new Date();

    const orderFilters: Prisma.CommercialOrderWhereInput[] = [];
    if (task.orderId) orderFilters.push({ id: task.orderId });
    if (orderNumbers.length > 0) orderFilters.push({ orderNumber: { in: orderNumbers } });
    const orders =
      orderFilters.length > 0
        ? await tx.commercialOrder.findMany({
            where: { OR: orderFilters },
            select: { id: true, orderNumber: true },
          })
        : [];
    const orderIds = [
      ...new Set(
        [task.orderId, ...orders.map((order) => order.id)].filter((orderId): orderId is string =>
          Boolean(orderId),
        ),
      ),
    ].sort();
    const safeOrderNumbers = [
      ...new Set([...orderNumbers, ...orders.map((order) => order.orderNumber)]),
    ];
    await this.audit.record(
      {
        type: 'audit:warehouse_acceptance_task_closed',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: taskId,
        detail: {
          orderIds,
          orderNumbers: safeOrderNumbers,
          closeMode: dto.mode,
          mode: task.mode,
          rows: completedRows.length,
        },
      },
      tx,
    );

    if (!isDelivery && dto.mode === 'full') {
      for (const orderId of orderIds) {
        await this.fulfillmentHandoff.reconcile(actor, orderId, tx);
      }
    }

    if (isDelivery && dto.mode === 'full') {
      await this.deferredPayment.activatePostDeliveryPayments(
        {
          actor,
          orderIds,
          orderNumbers: safeOrderNumbers,
          shipmentCompletedAt,
          warehouseTaskId: taskId,
        },
        tx,
      );
    }
  }

  private async assertReceivingPalletEvidence(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<void> {
    const uncovered = await tx.scanRow.findFirst({
      where: {
        taskId,
        scanStatus: { in: ['accepted', 'reserved', 'damaged'] },
        palletItems: {
          none: {
            releasedAt: null,
            pallet: {
              taskId,
              status: 'sealed',
              voidedAt: null,
              document: {
                is: {
                  acceptanceTaskId: taskId,
                  origin: 'physical_pallet',
                  voidedAt: null,
                },
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      select: { id: true, rollCode: true },
    });
    if (!uncovered) return;

    throw new ConflictException({
      code: 'WAREHOUSE_TASK_PALLET_EVIDENCE_INCOMPLETE',
      message: 'Нельзя закрыть приёмку: рулон отсутствует в действующем палетном листе.',
      scanRowId: uncovered.id,
      rollCode: uncovered.rollCode,
    });
  }

  private async expireStaleControlWeights(actor: WarehouseActor, taskId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${taskId} FOR UPDATE`;
      const expired = await this.operations.expireStaleControlWeights(tx, { taskId });
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
    });
  }

  // --- Cover checks (проверка сырья/остатков, ТЗ §5.3) -----------------------

  /** Explicit warehouse-owned cover-check cases; never infer tasks from legacy order indicators. */
  async listCoverChecks(
    _actorRole: Role,
    query: WarehouseCoverCheckQuery = {},
  ): Promise<WarehouseCoverCheckPage> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const cursor = decodeCoverCursor(query.cursor);
    const rows = await this.prisma.orderResolutionCase.findMany({
      where: {
        type: 'warehouse_cover_check',
        status: query.state ?? 'open',
        ownerRole: 'warehouse',
        openScopeKey: { not: null },
        order: WAREHOUSE_COVER_ACTIONABLE_WHERE,
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: new Date(cursor.updatedAt) } },
                { updatedAt: new Date(cursor.updatedAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: COVER_CHECK_CASE_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map((row) => {
        const affectedPositionIds = new Set(
          requiredCoverPositionIds(
            row.affectedPositionIds,
            row.order.positions.map((position) => position.id),
          ),
        );
        return {
          caseId: row.id,
          orderId: row.order.id,
          orderNumber: row.order.orderNumber,
          customerAlias: row.order.counterparty?.displayName ?? 'Собственный запас',
          state: 'open',
          requestedAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          positions: row.order.positions
            .filter((position) => affectedPositionIds.has(position.id))
            .map((position) => ({
              ...position,
              warehouseCoverStatus: position.warehouseCoverStatus as WarehouseCoverStatus,
            })),
        };
      }),
      nextCursor:
        rows.length > limit && pageRows.length > 0
          ? encodeCoverCursor(pageRows[pageRows.length - 1]!)
          : null,
    };
  }

  /** Warehouse proposes exact free rolls; quantities and compatibility are server-derived. */
  async proposeCover(actor: WarehouseActor, orderId: string, dto: CoverProposeDto) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const now = new Date();
          const position = await tx.commercialOrderPosition.findFirst({
            where: { id: dto.positionId, orderId },
            include: { order: { include: { positions: true } } },
          });
          if (!position) {
            throw new NotFoundException(
              `Position ${dto.positionId} not found for commercial order ${orderId}`,
            );
          }
          assertCoverageWorkflow(
            position.order.warehouseCoverageWorkflowVersion as WarehouseCoverageWorkflowVersion,
            1,
          );
          const openScopeKey = `warehouse_cover:${orderId}`;
          const resolutionCase = await tx.orderResolutionCase.findUnique({
            where: { openScopeKey },
          });
          if (
            !resolutionCase ||
            resolutionCase.orderId !== orderId ||
            resolutionCase.type !== 'warehouse_cover_check' ||
            resolutionCase.status !== 'open' ||
            resolutionCase.ownerRole !== 'warehouse'
          ) {
            throw new ConflictException(`Open warehouse cover task for order ${orderId} not found`);
          }
          const requiredPositionIds = requiredCoverPositionIds(
            resolutionCase.affectedPositionIds,
            position.order.positions.map((current) => current.id),
          );
          if (!requiredPositionIds.includes(position.id)) {
            throw new ConflictException(
              `Position ${position.id} is outside the active warehouse cover task`,
            );
          }
          if (dto.rollIds.length > position.rollCount) {
            throw new BadRequestException(
              'Proposal contains more rolls than the position requests',
            );
          }

          const rolls =
            dto.rollIds.length === 0
              ? []
              : await tx.warehouseRoll.findMany({
                  where: { id: { in: dto.rollIds } },
                  orderBy: { id: 'asc' },
                });
          if (rolls.length !== dto.rollIds.length) {
            throw new NotFoundException('One or more proposed warehouse rolls do not exist');
          }

          const matches = rolls.map((roll) => {
            if (roll.reservedForOrderId) {
              throw new ConflictException(`Warehouse roll ${roll.rollCode} is already reserved`);
            }
            if (roll.producedForOrderId && !roll.releasedFromOrderId) {
              throw new ConflictException(
                `Warehouse roll ${roll.rollCode} belongs to a production order`,
              );
            }
            if (roll.warehouseStatus !== 'received') {
              throw new ConflictException(
                `Warehouse roll ${roll.rollCode} is not available for coverage`,
              );
            }
            const criteria = evaluateWarehouseCoverCompatibility(position, roll.positionSnapshot);
            if (!criteriaAreCompatible(criteria)) {
              throw new BadRequestException(
                `Warehouse roll ${roll.rollCode} is incompatible with position ${position.id}`,
              );
            }
            return { roll, criteria };
          });

          const coverQty = matches.length;
          const status =
            coverQty === position.rollCount && coverQty > 0 ? 'full_proposed' : 'partial_proposed';
          const proposal = await tx.warehouseCoverProposal.create({
            data: {
              orderId,
              positionId: position.id,
              coverType: status === 'full_proposed' ? 'full' : 'partial',
              route: 'production_only',
              coverQty,
              reserveQty: 0,
              productionQty: Math.max(0, position.rollCount - coverQty),
              matchedRollIds: matches.map(({ roll }) => roll.id),
              status,
              sourceCapturedAt: now,
              expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
              matches: {
                create: matches.map(({ roll, criteria }) => ({
                  rollId: roll.id,
                  compatible: true,
                  criteria: criteria as unknown as Prisma.InputJsonValue,
                })),
              },
            },
            include: { matches: { include: { roll: true } } },
          });
          await tx.commercialOrderPosition.update({
            where: { id: position.id },
            data: { warehouseCoverStatus: status },
          });
          const orderStatus = this.aggregateProposedCoverStatus(
            position.order.positions.map((item) =>
              item.id === position.id ? status : item.warehouseCoverStatus,
            ),
          );
          await tx.commercialOrder.update({
            where: { id: orderId },
            data: { warehouseCoverStatus: orderStatus, version: { increment: 1 } },
          });
          const currentProposals = await tx.warehouseCoverProposal.findMany({
            where: {
              orderId,
              positionId: { in: requiredPositionIds },
              createdAt: { gte: resolutionCase.createdAt },
            },
            select: {
              id: true,
              positionId: true,
              status: true,
              createdAt: true,
              expiresAt: true,
            },
            orderBy: [{ positionId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
          });
          const latestByPosition = new Map<string, (typeof currentProposals)[number]>();
          for (const current of currentProposals) {
            if (current.createdAt < resolutionCase.createdAt) continue;
            if (!latestByPosition.has(current.positionId)) {
              latestByPosition.set(current.positionId, current);
            }
          }
          const hasCurrentProposalForEveryPosition = requiredPositionIds.every((positionId) => {
            const latest = latestByPosition.get(positionId);
            return (
              latest !== undefined &&
              CURRENT_COVER_PROPOSAL_STATUSES.some((status) => status === latest.status) &&
              (!latest.expiresAt || latest.expiresAt > now)
            );
          });
          if (hasCurrentProposalForEveryPosition) {
            const closed = await tx.orderResolutionCase.updateMany({
              where: {
                id: resolutionCase.id,
                status: 'open',
                version: resolutionCase.version,
                openScopeKey,
              },
              data: {
                status: 'resolved',
                openScopeKey: null,
                outcome: 'cover_proposed_for_all_positions',
                nextOwnerRole: 'commercial',
                resolvedAt: now,
                version: { increment: 1 },
              },
            });
            if (closed.count !== 1) {
              throw new ConflictException('Warehouse cover task changed concurrently');
            }
          }
          await this.audit.record(
            {
              type: 'audit:warehouse_cover_proposed',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              reason: dto.comment,
              detail: {
                orderId,
                orderNumber: position.order.orderNumber,
                caseId: resolutionCase.id,
                proposalId: proposal.id,
                positionId: position.id,
              },
              newValue: {
                proposalId: proposal.id,
                positionId: position.id,
                version: proposal.version,
                matchedRollIds: matches.map(({ roll }) => roll.id),
                coverQty,
                status,
              },
            },
            tx,
          );
          return proposal;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException(
          'Warehouse cover proposal conflicted with another request; reload and retry',
        );
      }
      throw error;
    }
  }

  // --- Rolls / reserve ------------------------------------------------------

  async listRolls(ownership?: string): Promise<WarehouseRollResponseDto[]> {
    const where: Prisma.WarehouseRollWhereInput =
      ownership === 'reserved'
        ? { reservedForOrderId: { not: null } }
        : ownership === 'free'
          ? {
              reservedForOrderId: null,
              OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
              warehouseStatus: 'received',
            }
          : {};
    const rows = await this.prisma.warehouseRoll.findMany({
      where,
      select: WAREHOUSE_ROLL_SAFE_SELECT,
      orderBy: { rollCode: 'asc' },
    });
    return rows.map(projectWarehouseRoll);
  }

  async reserveRoll(actor: WarehouseActor, rollCode: string, dto: ReserveDto) {
    const roll = await this.requireRoll(rollCode);
    this.assertLegacyReservationMutable(roll);
    if (roll.reservedForOrderId === dto.orderId) return roll;
    return this.prisma.$transaction(async (tx) => {
      const reserved = await tx.warehouseRoll.updateMany({
        where: {
          rollCode,
          reservedForOrderId: null,
          OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
        },
        data: { reservedForOrderId: dto.orderId, reservedAt: new Date() },
      });
      if (reserved.count !== 1) {
        throw new ConflictException(`Warehouse roll ${rollCode} is already reserved`);
      }
      await this.audit.record(
        {
          type: 'audit:roll_reserved_for_order',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: rollCode,
          newValue: { reservedForOrderId: dto.orderId },
        },
        tx,
      );
      return tx.warehouseRoll.findUniqueOrThrow({ where: { rollCode } });
    });
  }

  async releaseReserve(actor: WarehouseActor, rollCode: string) {
    const roll = await this.requireRoll(rollCode);
    this.assertLegacyReservationMutable(roll);
    const updated = await this.prisma.warehouseRoll.update({
      where: { rollCode },
      data: {
        reservedForOrderId: null,
        reservedForPositionId: null,
        reservedByProposalId: null,
        reservedAt: null,
      },
    });
    await this.audit.record({
      type: 'audit:roll_reservation_released',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: rollCode,
      oldValue: { reservedForOrderId: roll.reservedForOrderId },
    });
    return updated;
  }

  // --- Pallet list ----------------------------------------------------------

  async createPalletList(actor: WarehouseActor, dto: CreatePalletListDto) {
    const distinctOrderIds = new Set(dto.orderIds ?? []);
    if (distinctOrderIds.size > 1) {
      throw new ConflictException({
        code: 'WAREHOUSE_MIXED_PALLET_FORBIDDEN',
        message: 'Один палет не может содержать рулоны из разных заказов.',
      });
    }

    const doc = await this.prisma.palletListDocument.create({
      data: {
        palletId: dto.palletId,
        rollIds: dto.rollIds,
        orderIds: dto.orderIds ?? [],
        generatedByRole: actor.role,
        format: dto.format ?? 'pdf',
      },
    });
    await this.audit.record({
      type: 'audit:pallet_list_created',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: doc.id,
      detail: { palletId: dto.palletId, rolls: dto.rollIds.length },
    });
    return doc;
  }

  async getPalletList(id: string) {
    const doc = await this.prisma.palletListDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException(`Pallet list ${id} not found`);
    return doc;
  }

  // --- Raw materials --------------------------------------------------------

  listRawMaterials() {
    return this.prisma.rawMaterialStock.findMany({ orderBy: { label: 'asc' } });
  }

  async adjustRawMaterial(actor: WarehouseActor, materialId: string, dto: RawAdjustDto) {
    return this.prisma.$transaction(async (tx) => {
      const command: RawMaterialCommandFingerprint = {
        kind: 'adjustment',
        operationKey: dto.operationKey.toLowerCase(),
        materialId,
        quantity: normalizeRawCommandQuantity(dto.actualQty),
        reason: dto.reason.trim(),
        actor,
      };
      const isReplay = await this.claimRawMaterialCommand(tx, command);
      if (isReplay) {
        const material = await tx.rawMaterialStock.findUnique({ where: { materialId } });
        if (!material) throw new NotFoundException(`Raw material ${materialId} not found`);
        return material;
      }

      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "raw_material_stocks" WHERE "materialId" = ${materialId} FOR UPDATE`,
      );
      const material = await tx.rawMaterialStock.findUnique({ where: { materialId } });
      if (!material) throw new NotFoundException(`Raw material ${materialId} not found`);

      const updated = await tx.rawMaterialStock.update({
        where: { materialId },
        data: { actualQty: command.quantity, factStatus: 'manual' },
      });
      await this.audit.record(
        {
          type: 'audit:inventory_manual_correction',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: materialId,
          reason: command.reason,
          oldValue: { actualQty: material.actualQty },
          newValue: { actualQty: command.quantity },
          detail: { operationKey: command.operationKey, actualQty: command.quantity },
        },
        tx,
      );
      if (command.quantity <= 0) {
        await this.audit.record(
          {
            type: 'problem:raw_material_shortage',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: materialId,
            detail: { materialId, actualQty: command.quantity },
          },
          tx,
        );
      }
      return updated;
    });
  }

  async receiveRawMaterial(actor: WarehouseActor, materialId: string, dto: RawReceiptDto) {
    return this.prisma.$transaction(async (tx) => {
      const command: RawMaterialCommandFingerprint = {
        kind: 'receipt',
        operationKey: dto.operationKey.toLowerCase(),
        materialId,
        quantity: normalizeRawCommandQuantity(dto.receivedQty),
        reason: dto.reason.trim(),
        actor,
      };
      const isReplay = await this.claimRawMaterialCommand(tx, command);
      if (isReplay) {
        const material = await tx.rawMaterialStock.findUnique({ where: { materialId } });
        if (!material) throw new NotFoundException(`Raw material ${materialId} not found`);
        return material;
      }

      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "raw_material_stocks" WHERE "materialId" = ${materialId} FOR UPDATE`,
      );
      const material = await tx.rawMaterialStock.findUnique({ where: { materialId } });
      if (!material) throw new NotFoundException(`Raw material ${materialId} not found`);

      const nextActualQty = Number((material.actualQty + command.quantity).toFixed(3));
      const updated = await tx.rawMaterialStock.update({
        where: { materialId },
        data: { actualQty: nextActualQty, factStatus: 'warehouse_fact' },
      });
      await this.audit.record(
        {
          type: 'audit:raw_material_received',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: materialId,
          reason: command.reason,
          oldValue: { actualQty: material.actualQty },
          newValue: { actualQty: nextActualQty },
          detail: { operationKey: command.operationKey, receivedQty: command.quantity },
        },
        tx,
      );
      return updated;
    });
  }

  private async claimRawMaterialCommand(
    tx: Prisma.TransactionClient,
    command: RawMaterialCommandFingerprint,
  ): Promise<boolean> {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`warehouse-raw-command:${command.operationKey}`}, 0))`,
    );
    const [replay] = await tx.$queryRaw<RawMaterialCommandEvent[]>(Prisma.sql`
      SELECT "type", "objectId", "actorId", "actorRole", "detail", "reason"
      FROM "domain_events"
      WHERE "type" IN (${Prisma.join(RAW_MATERIAL_COMMAND_EVENT_TYPES)})
        AND "detail" ? 'operationKey'
        AND "detail"->>'operationKey' IS NOT NULL
        AND lower("detail"->>'operationKey') = ${command.operationKey}
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
    `);
    if (!replay) return false;

    const expectedType =
      command.kind === 'adjustment'
        ? 'audit:inventory_manual_correction'
        : 'audit:raw_material_received';
    const quantityField = command.kind === 'adjustment' ? 'actualQty' : 'receivedQty';
    const replayQuantity = snapshotNumber(snapshotRecord(replay.detail), quantityField);
    if (
      replay.type !== expectedType ||
      replay.objectId !== command.materialId ||
      replayQuantity !== command.quantity ||
      replay.reason !== command.reason ||
      replay.actorId !== command.actor.userId ||
      replay.actorRole !== command.actor.role
    ) {
      throw new ConflictException({
        code: 'RAW_MATERIAL_OPERATION_KEY_REUSED',
        message: 'Ключ операции сырья уже использован для другой команды.',
      });
    }
    return true;
  }

  private async requireTask(taskId: string) {
    const task = await this.prisma.warehouseAcceptanceTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Acceptance task ${taskId} not found`);
    return task;
  }

  private async requireMutableTask(taskId: string) {
    const task = await this.requireTask(taskId);
    this.assertLegacyTaskMutable(task);
    if (task.status === 'closed') {
      throw new ConflictException(`Warehouse task ${taskId} is closed and immutable`);
    }
    return task;
  }

  private async requireRoll(rollCode: string) {
    const roll = await this.prisma.warehouseRoll.findUnique({ where: { rollCode } });
    if (!roll) throw new NotFoundException(`Warehouse roll ${rollCode} not found`);
    return roll;
  }

  private assertLegacyReservationMutable(roll: {
    reservedByCoverageDecisionId: string | null;
    producedByCoverageDecisionId: string | null;
  }): void {
    if (roll.producedByCoverageDecisionId) {
      throw new ConflictException({
        statusCode: 409,
        code: 'warehouse_production_managed_roll',
        decisionId: roll.producedByCoverageDecisionId,
      });
    }
    if (roll.reservedByCoverageDecisionId) {
      throw new ConflictException({
        statusCode: 409,
        code: 'warehouse_coverage_decision_managed_reservation',
        decisionId: roll.reservedByCoverageDecisionId,
      });
    }
  }

  private assertLegacyTaskMutable(task: { coverageDecisionId: string | null }): void {
    if (task.coverageDecisionId) {
      throw new ConflictException({
        statusCode: 409,
        code: 'warehouse_coverage_decision_managed_task',
        decisionId: task.coverageDecisionId,
      });
    }
  }

  private aggregateProposedCoverStatus(statuses: string[]) {
    if (statuses.some((status) => status === 'recheck_requested')) return 'recheck_requested';
    if (statuses.length > 0 && statuses.every((status) => status === 'full_proposed')) {
      return 'full_proposed';
    }
    if (statuses.some((status) => ['partial_proposed', 'full_proposed'].includes(status))) {
      return 'partial_proposed';
    }
    return 'not_checked';
  }
}
