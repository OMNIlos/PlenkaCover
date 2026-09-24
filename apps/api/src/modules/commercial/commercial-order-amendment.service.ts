import { isDeepStrictEqual } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { PositionMaterialSelection, RecipeIngredientShare, Role } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { WarehouseRollCoverageFactService } from '../warehouse-coverage/warehouse-roll-coverage-fact.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE,
  invoiceLocksCommercialParameters,
  readInvoiceBoundaryForCommercialOrder,
  tryLockCommercialInvoiceBoundary,
} from '../../common/invoice-boundary/commercial-invoice-boundary';
import {
  RecipeCatalogService,
  type ResolvedRecipeSelection,
} from '../material-catalog/recipe-catalog.service';
import {
  lockCoverageInventoryEpoch,
  WarehouseCoverageTransaction,
} from '../warehouse-coverage/warehouse-coverage-transaction';
import {
  CommercialOrderReconciliationService,
  type CommercialOrderReconciliationResult,
} from './commercial-order-reconciliation.service';
import type {
  CommercialOrderAmendmentDto,
  CommercialPositionChangesDto,
  OrderCancellationCommandDto,
} from './dto/order-amendment.dto';
import type { CreatePositionDto } from './dto/create-order.dto';

const AMENDMENT_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  version: true,
  cancellationStatus: true,
  cancellationVersion: true,
  cancelledAt: true,
  cancelledById: true,
  cancellationReason: true,
  warehouseCoverageWorkflowVersion: true,
  productionIndicator: true,
  warehouseCoverStatus: true,
  paymentStatus: true,
  shipmentStatus: true,
  positions: {
    select: { id: true, rollCount: true, version: true },
    orderBy: { id: 'asc' },
  },
  financeOrder: {
    select: {
      id: true,
      invoiceStatus: true,
      invoiceIssuedAt: true,
      invoiceSyncState: true,
      paymentStatus: true,
      productionClearedAt: true,
    },
  },
  productionOrder: { select: { id: true } },
} satisfies Prisma.CommercialOrderSelect;

const AMENDMENT_POSITION_INCLUDE = {
  recipe: true,
} satisfies Prisma.CommercialOrderPositionInclude;

type AmendmentOrder = Prisma.CommercialOrderGetPayload<{
  select: typeof AMENDMENT_ORDER_SELECT;
}>;
type AmendmentPosition = Prisma.CommercialOrderPositionGetPayload<{
  include: typeof AMENDMENT_POSITION_INCLUDE;
}>;

export type CommercialOrderAmendmentResult = {
  commandId: string;
  orderId: string;
  orderVersion: number;
  reconciliation: 'applied' | 'needs_production_review';
  affectedPositionIds: string[];
  changedFutureRollIds: string[];
  preservedPhysicalRollIds: string[];
};

export type OrderCancellationResult = CommercialOrderAmendmentResult & {
  cancellationStatus: 'active' | 'cancelled';
  cancellationVersion: number;
  completedRollCount: number;
  remainingCancelledRollCount: number;
};

type PositionMutation = {
  affectedPositionIds: string[];
  changedFields: string[];
  oldValue: Prisma.InputJsonValue | undefined;
  newValue: Prisma.InputJsonValue;
};

type CommercialOrderAmendmentActor = {
  userId: string | null;
  role: Role;
};

type CancelUnfinishedOrderCommand = {
  kind: 'cancel_unfinished_order';
  operationKey: string;
  expectedOrderVersion: number;
  reason: string;
};

type ReconciliationAmendmentCommand = CommercialOrderAmendmentDto | CancelUnfinishedOrderCommand;

type MaterialSelectionInput = {
  baseRawMaterialDefinitionId?: string | null;
  recipeDefinitionVersionId?: string | null;
};

const INVOICE_BOUNDARY_RETRY = {
  maxAttempts: 50,
  baseDelayMs: 5,
  maxDelayMs: 50,
} as const;

class CommercialInvoiceBoundaryBusyError extends Error {
  constructor() {
    super('Commercial invoice boundary is busy');
    this.name = 'CommercialInvoiceBoundaryBusyError';
  }
}

function normalizedText(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : value.trim() || null;
}

function canonicalRecipeParameters(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((parameter) => {
    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
      return parameter;
    }
    const entry = parameter as Record<string, unknown>;
    return { label: entry.label, value: entry.value };
  });
}

function invoiceBoundaryRetryDelay(attempt: number): Promise<void> {
  const delayMs = Math.min(
    INVOICE_BOUNDARY_RETRY.maxDelayMs,
    INVOICE_BOUNDARY_RETRY.baseDelayMs * attempt,
  );
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function nextRecipeVersion(value: string | null | undefined): string {
  const current = Number(String(value ?? 'v0').replace(/^v/u, ''));
  return `v${Number.isFinite(current) ? current + 1 : 1}`;
}

function copySelection(selection: ResolvedRecipeSelection): ResolvedRecipeSelection {
  return {
    baseRawMaterialDefinitionId: selection.baseRawMaterialDefinitionId,
    recipeDefinitionId: selection.recipeDefinitionId,
    recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
    version: selection.version,
    name: selection.name,
    ingredients: selection.ingredients.map(
      (ingredient): RecipeIngredientShare => ({
        rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
        name: ingredient.name,
        shareBasisPoints: ingredient.shareBasisPoints,
      }),
    ),
  };
}

function safePositionSnapshot(position: AmendmentPosition): Prisma.InputJsonObject {
  return {
    positionId: position.id,
    version: position.version,
    rollCount: position.rollCount,
    filmType: position.filmType,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    widthMm: position.widthMm ?? null,
    plannedLengthM: position.plannedLengthM ?? null,
    rawMaterialId: position.rawMaterialId ?? null,
    baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId ?? null,
    recipeDefinitionVersionId: position.recipeDefinitionVersionId ?? null,
    spoolType: position.spoolType ?? null,
    birka: position.birka ?? null,
    manualBirka: position.manualBirka ?? null,
    comment: position.comment ?? null,
    plannedWeightKg: position.plannedWeightKg ?? null,
    recipeVersion: position.recipe?.version ?? null,
    recipeParameters: position.recipe?.parameters ?? [],
  };
}

function resultFromJson(value: Prisma.JsonValue): CommercialOrderAmendmentResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidReplay();
  }
  const candidate = value as Record<string, unknown>;
  const reconciliation = candidate.reconciliation;
  if (
    typeof candidate.commandId !== 'string' ||
    typeof candidate.orderId !== 'string' ||
    typeof candidate.orderVersion !== 'number' ||
    (reconciliation !== 'applied' && reconciliation !== 'needs_production_review') ||
    !isStringArray(candidate.affectedPositionIds) ||
    !isStringArray(candidate.changedFutureRollIds) ||
    !isStringArray(candidate.preservedPhysicalRollIds)
  ) {
    throw invalidReplay();
  }
  return {
    commandId: candidate.commandId,
    orderId: candidate.orderId,
    orderVersion: candidate.orderVersion,
    reconciliation,
    affectedPositionIds: candidate.affectedPositionIds,
    changedFutureRollIds: candidate.changedFutureRollIds,
    preservedPhysicalRollIds: candidate.preservedPhysicalRollIds,
  };
}

function cancellationResultFromJson(value: Prisma.JsonValue): OrderCancellationResult {
  const base = resultFromJson(value);
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.cancellationStatus !== 'active' && candidate.cancellationStatus !== 'cancelled') ||
    typeof candidate.cancellationVersion !== 'number' ||
    typeof candidate.completedRollCount !== 'number' ||
    typeof candidate.remainingCancelledRollCount !== 'number'
  ) {
    throw invalidReplay();
  }
  return {
    ...base,
    cancellationStatus: candidate.cancellationStatus,
    cancellationVersion: candidate.cancellationVersion,
    completedRollCount: candidate.completedRollCount,
    remainingCancelledRollCount: candidate.remainingCancelledRollCount,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function invalidReplay(): ConflictException {
  return new ConflictException({
    code: 'COMMERCIAL_AMENDMENT_REPLAY_INVALID',
    message: 'Сохранённый результат изменения заказа повреждён.',
  });
}

export function commercialOrderAmendmentFingerprintInput(
  orderId: string,
  dto: CommercialOrderAmendmentDto,
) {
  return {
    orderId,
    kind: dto.kind,
    operationKey: dto.operationKey.trim().toLowerCase(),
    expectedOrderVersion: dto.expectedOrderVersion,
    expectedPositionVersion: dto.expectedPositionVersion,
    reason: dto.reason.trim(),
    positionId: dto.positionId,
    position: dto.position,
    changes: dto.changes,
  };
}

export function orderCancellationFingerprintInput(
  orderId: string,
  kind: 'cancel_order' | 'reactivate_order' | 'cancel_unfinished_order',
  dto: OrderCancellationCommandDto,
) {
  return {
    orderId,
    kind,
    operationKey: dto.operationKey.trim().toLowerCase(),
    expectedVersion: dto.expectedVersion,
    reason: dto.reason.trim(),
  };
}

@Injectable()
export class CommercialOrderAmendmentService {
  constructor(
    private readonly audit: AuditService,
    private readonly recipeCatalog: RecipeCatalogService,
    private readonly coverageTransaction: WarehouseCoverageTransaction,
    private readonly reconciliation: CommercialOrderReconciliationService,
    private readonly coverageFacts: WarehouseRollCoverageFactService,
    private readonly fulfillment: OrderFulfillmentHandoffService,
  ) {}

  async apply(
    actor: CommercialOrderAmendmentActor,
    orderId: string,
    dto: CommercialOrderAmendmentDto,
  ): Promise<CommercialOrderAmendmentResult> {
    const fingerprint = requestFingerprint(commercialOrderAmendmentFingerprintInput(orderId, dto));
    return this.applyCommand(actor, orderId, dto, fingerprint);
  }

  cancelUnfinished(
    actor: CommercialOrderAmendmentActor,
    orderId: string,
    dto: OrderCancellationCommandDto,
  ): Promise<CommercialOrderAmendmentResult> {
    const command: CancelUnfinishedOrderCommand = {
      kind: 'cancel_unfinished_order',
      operationKey: dto.operationKey,
      expectedOrderVersion: dto.expectedVersion,
      reason: dto.reason,
    };
    return this.applyCommand(
      actor,
      orderId,
      command,
      requestFingerprint(orderCancellationFingerprintInput(orderId, command.kind, dto)),
    );
  }

  private async applyCommand(
    actor: CommercialOrderAmendmentActor,
    orderId: string,
    dto: ReconciliationAmendmentCommand,
    fingerprint: string,
  ): Promise<CommercialOrderAmendmentResult> {
    const operationKey = dto.operationKey.trim().toLowerCase();
    for (let attempt = 1; attempt <= INVOICE_BOUNDARY_RETRY.maxAttempts; attempt += 1) {
      try {
        return await this.coverageTransaction.run(async (tx) => {
          // Keep this as the first SQL statement of every Serializable attempt. When the
          // boundary is busy, the transaction is discarded so no stale snapshot is reused.
          if (!(await tryLockCommercialInvoiceBoundary(tx, orderId))) {
            throw new CommercialInvoiceBoundaryBusyError();
          }
          await tx.$queryRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(
              hashtextextended(${`commercial-amendment:${operationKey}`}, 0)
            )::text AS "lock"`,
          );
          const replay = await tx.commercialOrderAmendmentCommand.findUnique({
            where: { operationKey },
            select: { requestFingerprint: true, result: true },
          });
          if (replay) {
            if (replay.requestFingerprint !== fingerprint) {
              throw new ConflictException({
                code: 'COMMERCIAL_AMENDMENT_OPERATION_KEY_CONFLICT',
                message: 'operationKey уже связан с другим изменением заказа.',
              });
            }
            return resultFromJson(replay.result);
          }

          const coverageContext = await this.reconciliation.lockOrder(tx, orderId);
          const invoiceBoundary = await readInvoiceBoundaryForCommercialOrder(tx, orderId);
          if (
            dto.kind !== 'cancel_unfinished_order' &&
            invoiceLocksCommercialParameters(invoiceBoundary)
          ) {
            throw new ConflictException({
              code: COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE,
              message: 'Параметры заказа закрыты после выставления счёта.',
            });
          }
          const order = await tx.commercialOrder.findUnique({
            where: { id: orderId },
            select: AMENDMENT_ORDER_SELECT,
          });
          this.assertOrderVersion(order, orderId, dto.expectedOrderVersion);
          if (dto.kind === 'cancel_unfinished_order' && !order.productionOrder) {
            throw new ConflictException({
              code: 'COMMERCIAL_ORDER_HAS_NO_PRODUCTION',
              message: 'У заявки нет производственного заказа.',
            });
          }

          const mutation: PositionMutation =
            dto.kind === 'cancel_unfinished_order'
              ? {
                  affectedPositionIds: order.positions.map(({ id }) => id),
                  changedFields: ['rollCount'],
                  oldValue: {
                    positions: order.positions.map(({ id, rollCount }) => ({
                      positionId: id,
                      rollCount,
                    })),
                  },
                  newValue: { positions: [] },
                }
              : await this.mutateDesiredSpecification(tx, order, dto, actor);
          const orderUpdate = await tx.commercialOrder.updateMany({
            where: {
              id: order.id,
              version: order.version,
              cancellationStatus: 'active',
            },
            data: { version: { increment: 1 } },
          });
          if (orderUpdate.count !== 1) {
            throw new ConflictException({
              code: 'COMMERCIAL_AMENDMENT_VERSION_CONFLICT',
              message: 'Заявка уже изменена. Обновите её и повторите действие.',
            });
          }

          const reconciled = await this.reconciliation.reconcile(tx, {
            actor: { userId: actor.userId, role: actor.role },
            orderId: order.id,
            orderNumber: order.orderNumber,
            productionOrderId: order.productionOrder?.id ?? null,
            positionIds: mutation.affectedPositionIds,
            kind: dto.kind,
            reason: dto.reason.trim(),
            coverageContext,
          });
          if (dto.kind === 'cancel_unfinished_order') {
            mutation.newValue = {
              positions: order.positions.map(({ id }) => ({
                positionId: id,
                rollCount: reconciled.preservedRollCountByPosition[id] ?? 0,
              })),
            };
          } else {
            const effectiveRollCount = this.effectiveReconciledRollCount(dto, reconciled);
            if (effectiveRollCount !== null) {
              mutation.newValue = {
                ...(mutation.newValue as Prisma.InputJsonObject),
                rollCount: effectiveRollCount,
              };
            }
          }

          const command = await tx.commercialOrderAmendmentCommand.create({
            data: {
              orderId: order.id,
              operationKey,
              requestFingerprint: fingerprint,
              kind: dto.kind,
              expectedOrderVersion: dto.expectedOrderVersion,
              reason: dto.reason.trim(),
              actorRole: actor.role,
              actorId: actor.userId,
            },
            select: { id: true },
          });
          const result: CommercialOrderAmendmentResult = {
            commandId: command.id,
            orderId: order.id,
            orderVersion: order.version + 1,
            reconciliation: reconciled.reconciliation,
            affectedPositionIds: mutation.affectedPositionIds,
            changedFutureRollIds: reconciled.changedFutureRollIds,
            preservedPhysicalRollIds: reconciled.preservedPhysicalRollIds,
          };
          await tx.commercialOrderAmendmentCommand.update({
            where: { id: command.id },
            data: { result: result as unknown as Prisma.InputJsonValue },
          });
          await this.recordEvents(tx, actor, order, dto, mutation, reconciled, result);
          return result;
        });
      } catch (error) {
        if (!(error instanceof CommercialInvoiceBoundaryBusyError)) throw error;
        if (attempt === INVOICE_BOUNDARY_RETRY.maxAttempts) {
          throw new ConflictException({
            code: 'COMMERCIAL_INVOICE_BOUNDARY_BUSY',
            message: 'Счёт изменяется прямо сейчас. Обновите заявку и повторите действие.',
          });
        }
        await invoiceBoundaryRetryDelay(attempt);
      }
    }
    throw new Error('unreachable');
  }

  cancel(
    actor: CommercialOrderAmendmentActor,
    orderId: string,
    dto: OrderCancellationCommandDto,
  ): Promise<OrderCancellationResult> {
    return this.transitionCancellation(actor, orderId, dto, 'cancel_order');
  }

  reactivate(
    actor: CommercialOrderAmendmentActor,
    orderId: string,
    dto: OrderCancellationCommandDto,
  ): Promise<OrderCancellationResult> {
    return this.transitionCancellation(actor, orderId, dto, 'reactivate_order');
  }

  private transitionCancellation(
    actor: CommercialOrderAmendmentActor,
    orderId: string,
    dto: OrderCancellationCommandDto,
    kind: 'cancel_order' | 'reactivate_order',
  ): Promise<OrderCancellationResult> {
    const operationKey = dto.operationKey.trim().toLowerCase();
    const reason = dto.reason.trim();
    const fingerprint = requestFingerprint(orderCancellationFingerprintInput(orderId, kind, dto));
    return this.coverageTransaction.run(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`commercial-amendment:${operationKey}`}, 0)
        )::text AS "lock"`,
      );
      const replay = await tx.commercialOrderAmendmentCommand.findUnique({
        where: { operationKey },
        select: { requestFingerprint: true, result: true },
      });
      if (replay) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new ConflictException({
            code: 'COMMERCIAL_AMENDMENT_OPERATION_KEY_CONFLICT',
            message: 'operationKey уже связан с другим изменением заказа.',
          });
        }
        return cancellationResultFromJson(replay.result);
      }

      await this.fulfillment.acquireDeliveryScopeLock(tx, orderId);
      await lockCoverageInventoryEpoch(tx);
      const coverageContext = await this.reconciliation.lockOrder(tx, orderId);
      const order = await tx.commercialOrder.findUnique({
        where: { id: orderId },
        select: AMENDMENT_ORDER_SELECT,
      });
      if (!order) throw new NotFoundException(`Order ${orderId} not found`);
      if (
        kind === 'reactivate_order' &&
        (await tx.warehouseRoll.count({ where: { releasedFromOrderId: orderId } }))
      ) {
        throw new ConflictException(
          'Готовые рулоны переданы в свободный запас. Создайте новый заказ.',
        );
      }
      if (kind === 'cancel_order') {
        const activeOperation = await tx.operatorRollOperation.count({
          where: {
            status: 'in_progress',
            line: { rollDispatchItem: { productionOrder: { commercialOrderId: orderId } } },
          },
        });
        if (activeOperation)
          throw new ConflictException(
            'Дождитесь завершения текущей операции оператора и повторите отмену.',
          );
        const delivered = await tx.warehouseRoll.count({
          where: {
            warehouseStatus: 'delivered',
            OR: [{ producedForOrderId: orderId }, { reservedForOrderId: orderId }],
          },
        });
        if (['shipped', 'partial_shipped'].includes(order.shipmentStatus) || delivered > 0) {
          throw new ConflictException('Заказ уже отгружен. Сначала оформите возврат.');
        }
      }
      if (order.version !== dto.expectedVersion) {
        throw new ConflictException({
          code: 'COMMERCIAL_AMENDMENT_VERSION_CONFLICT',
          message: 'Заявка уже изменена. Обновите её и повторите действие.',
        });
      }
      const expectedStatus = kind === 'cancel_order' ? 'active' : 'cancelled';
      const nextStatus = kind === 'cancel_order' ? 'cancelled' : 'active';
      if (order.cancellationStatus !== expectedStatus) {
        throw new ConflictException({
          code:
            kind === 'cancel_order'
              ? 'COMMERCIAL_ORDER_ALREADY_CANCELLED'
              : 'COMMERCIAL_ORDER_NOT_CANCELLED',
          message:
            kind === 'cancel_order'
              ? 'Заявка уже отменена.'
              : 'Возобновить можно только отменённую заявку.',
        });
      }

      const cancelledAt = kind === 'cancel_order' ? new Date() : null;
      const updated = await tx.commercialOrder.updateMany({
        where: {
          id: order.id,
          version: order.version,
          cancellationStatus: expectedStatus,
          cancellationVersion: order.cancellationVersion,
        },
        data: {
          cancellationStatus: nextStatus,
          cancellationVersion: { increment: 1 },
          cancelledAt,
          cancelledById: kind === 'cancel_order' ? actor.userId : null,
          cancellationReason: kind === 'cancel_order' ? reason : null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException({
          code: 'COMMERCIAL_AMENDMENT_VERSION_CONFLICT',
          message: 'Заявка уже изменена. Обновите её и повторите действие.',
        });
      }

      const affectedPositionIds = order.positions.map(({ id }) => id);
      const reconciled = await this.reconciliation.reconcile(tx, {
        actor: { userId: actor.userId, role: actor.role },
        orderId: order.id,
        orderNumber: order.orderNumber,
        productionOrderId: order.productionOrder?.id ?? null,
        positionIds: affectedPositionIds,
        kind,
        reason,
        coverageContext,
      });
      if (kind === 'cancel_order') {
        await tx.warehouseAcceptanceTask.updateMany({
          where: { orderId, mode: { in: ['delivery', 'reserve'] }, status: { not: 'cancelled' } },
          data: { status: 'cancelled' },
        });
        await this.coverageFacts.releaseCancelledOrderRolls(tx, orderId, actor, reason);
        const released = await tx.warehouseRoll.updateMany({
          where: { reservedForOrderId: orderId },
          data: {
            reservedForOrderId: null,
            reservedForPositionId: null,
            reservedByProposalId: null,
            reservedByCoverageDecisionId: null,
            reservedAt: null,
          },
        });
        if (released.count) {
          await this.audit.record(
            {
              type: 'audit:warehouse_coverage_reservation_cancelled',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              reason,
              detail: { orderId, releasedRollCount: released.count, cause: 'order_cancellation' },
            },
            tx,
          );
        }
      }
      const command = await tx.commercialOrderAmendmentCommand.create({
        data: {
          orderId: order.id,
          operationKey,
          requestFingerprint: fingerprint,
          kind,
          expectedOrderVersion: dto.expectedVersion,
          reason,
          actorRole: actor.role,
          actorId: actor.userId,
        },
        select: { id: true },
      });
      const result: OrderCancellationResult = {
        commandId: command.id,
        orderId: order.id,
        orderVersion: order.version + 1,
        cancellationStatus: nextStatus,
        cancellationVersion: order.cancellationVersion + 1,
        reconciliation: reconciled.reconciliation,
        affectedPositionIds,
        changedFutureRollIds: reconciled.changedFutureRollIds,
        preservedPhysicalRollIds: reconciled.preservedPhysicalRollIds,
        completedRollCount: reconciled.completedRollCount,
        remainingCancelledRollCount: reconciled.remainingCancelledRollCount,
      };
      await tx.commercialOrderAmendmentCommand.update({
        where: { id: command.id },
        data: { result: result as unknown as Prisma.InputJsonValue },
      });
      await this.recordCancellationEvents(tx, actor, order, kind, reason, cancelledAt, result);
      return result;
    });
  }

  private assertOrderVersion(
    order: AmendmentOrder | null,
    orderId: string,
    expectedVersion: number,
  ): asserts order is AmendmentOrder {
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.cancellationStatus !== 'active') {
      throw new ConflictException({
        code: 'COMMERCIAL_AMENDMENT_ORDER_CANCELLED',
        message: 'Отменённую заявку сначала нужно возобновить.',
      });
    }
    if (order.version !== expectedVersion) {
      throw new ConflictException({
        code: 'COMMERCIAL_AMENDMENT_VERSION_CONFLICT',
        message: 'Заявка уже изменена. Обновите её и повторите действие.',
      });
    }
  }

  private async mutateDesiredSpecification(
    tx: Prisma.TransactionClient,
    order: AmendmentOrder,
    dto: CommercialOrderAmendmentDto,
    actor: CommercialOrderAmendmentActor,
  ): Promise<PositionMutation> {
    if (dto.kind === 'add_position') {
      if (!dto.position) throw new BadRequestException('position is required');
      return this.addPosition(tx, order, dto.position, actor);
    }
    if (!dto.positionId || dto.expectedPositionVersion === undefined) {
      throw new BadRequestException('positionId and expectedPositionVersion are required');
    }
    const position = await tx.commercialOrderPosition.findFirst({
      where: { id: dto.positionId, orderId: order.id },
      include: AMENDMENT_POSITION_INCLUDE,
    });
    if (!position) {
      throw new NotFoundException(`Position ${dto.positionId} not found for order ${order.id}`);
    }
    if (position.version !== dto.expectedPositionVersion) {
      throw new ConflictException({
        code: 'COMMERCIAL_AMENDMENT_POSITION_VERSION_CONFLICT',
        message: 'Позиция уже изменена. Обновите заявку и повторите действие.',
      });
    }
    return dto.kind === 'cancel_remaining_position'
      ? this.cancelRemainingPosition(tx, position)
      : this.updatePosition(tx, order, position, dto.changes);
  }

  private async addPosition(
    tx: Prisma.TransactionClient,
    order: AmendmentOrder,
    position: CreatePositionDto,
    actor: CommercialOrderAmendmentActor,
  ): Promise<PositionMutation> {
    const selection = await this.resolveSelection(tx, position);
    const created = await tx.commercialOrderPosition.create({
      data: {
        orderId: order.id,
        rollCount: position.rollCount,
        filmType: position.filmType.trim(),
        actualThickness: position.actualThickness.trim(),
        accountingThickness: position.accountingThickness.trim(),
        rawMaterialId: null,
        baseRawMaterialDefinitionId: selection.baseRawMaterialDefinitionId,
        recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
        spoolType: normalizedText(position.spoolType),
        birka: normalizedText(position.birka),
        manualBirka: normalizedText(position.manualBirka),
        comment: normalizedText(position.comment),
        plannedWeightKg: position.plannedWeightKg,
        widthMm: position.widthMm,
        plannedLengthM: position.plannedLengthM,
        recipe: {
          create: {
            recipeOwnerRole: 'commercial',
            parameters: (position.recipeParameters ?? []) as unknown as Prisma.InputJsonValue,
            source: 'commercial_amendment',
            createdBy: actor.userId ?? actor.role,
            recipeDefinitionId: selection.recipeDefinitionId,
            recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
            recipeVersionNumber: selection.version,
            recipeName: selection.name,
            ingredients: selection.ingredients as unknown as Prisma.InputJsonValue,
          },
        },
      },
      select: { id: true, version: true },
    });
    return {
      affectedPositionIds: [created.id],
      changedFields: Object.keys(position).sort(),
      oldValue: undefined,
      newValue: {
        positionId: created.id,
        version: created.version,
        rollCount: position.rollCount,
        filmType: position.filmType.trim(),
        actualThickness: position.actualThickness.trim(),
        accountingThickness: position.accountingThickness.trim(),
        widthMm: position.widthMm ?? null,
        plannedLengthM: position.plannedLengthM ?? null,
        spoolType: normalizedText(position.spoolType) ?? null,
        birka: normalizedText(position.birka) ?? null,
        manualBirka: normalizedText(position.manualBirka) ?? null,
        comment: normalizedText(position.comment) ?? null,
        plannedWeightKg: position.plannedWeightKg ?? null,
        baseRawMaterialDefinitionId: selection.baseRawMaterialDefinitionId,
        recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
        recipeParameters: position.recipeParameters ?? [],
      } as unknown as Prisma.InputJsonValue,
    };
  }

  private async updatePosition(
    tx: Prisma.TransactionClient,
    order: AmendmentOrder,
    position: AmendmentPosition,
    changes: CommercialPositionChangesDto | undefined,
  ): Promise<PositionMutation> {
    if (!changes || Object.keys(changes).length === 0) {
      throw new BadRequestException('changes must not be empty');
    }
    const changedFields = this.actualChangedFields(position, changes);
    if (changedFields.length === 0) {
      throw new BadRequestException({
        code: 'COMMERCIAL_AMENDMENT_NO_CHANGES',
        message: 'Параметры позиции не изменились.',
      });
    }
    const effectiveChanges = this.effectiveChanges(changes, changedFields);
    const positionData = this.positionUpdateData(effectiveChanges);
    const selection = await this.resolveChangedSelection(tx, effectiveChanges);
    if (selection) {
      positionData.rawMaterialId = null;
      positionData.baseRawMaterialDefinitionId = selection.baseRawMaterialDefinitionId;
      positionData.recipeDefinitionVersionId = selection.recipeDefinitionVersionId;
    }
    const updated = await tx.commercialOrderPosition.updateMany({
      where: { id: position.id, orderId: order.id, version: position.version },
      data: { ...positionData, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw this.positionVersionConflict();
    await this.updateRecipeSnapshot(tx, position, effectiveChanges, selection);
    const recipeParametersChanged = effectiveChanges.recipeParameters !== undefined;

    return {
      affectedPositionIds: [position.id],
      changedFields,
      oldValue: safePositionSnapshot(position),
      newValue: {
        ...safePositionSnapshot(position),
        ...positionData,
        version: position.version + 1,
        ...(selection
          ? {
              baseRawMaterialDefinitionId: selection.baseRawMaterialDefinitionId,
              recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
            }
          : {}),
        ...(selection || recipeParametersChanged
          ? { recipeVersion: nextRecipeVersion(position.recipe?.version) }
          : {}),
        ...(recipeParametersChanged
          ? { recipeParameters: canonicalRecipeParameters(effectiveChanges.recipeParameters) }
          : {}),
      } as unknown as Prisma.InputJsonValue,
    };
  }

  private async cancelRemainingPosition(
    tx: Prisma.TransactionClient,
    position: AmendmentPosition,
  ): Promise<PositionMutation> {
    const updated = await tx.commercialOrderPosition.updateMany({
      where: { id: position.id, orderId: position.orderId, version: position.version },
      data: { rollCount: 0, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw this.positionVersionConflict();
    return {
      affectedPositionIds: [position.id],
      changedFields: ['rollCount'],
      oldValue: safePositionSnapshot(position),
      newValue: {
        ...safePositionSnapshot(position),
        rollCount: 0,
        version: position.version + 1,
      },
    };
  }

  private effectiveReconciledRollCount(
    dto: CommercialOrderAmendmentDto,
    reconciliation: CommercialOrderReconciliationResult,
  ): number | null {
    if (!dto.positionId) return null;
    const preserved = reconciliation.preservedRollCountByPosition[dto.positionId] ?? 0;
    if (dto.kind === 'cancel_remaining_position') return preserved;
    if (dto.kind !== 'update_position' || dto.changes?.rollCount === undefined) return null;
    return Math.max(dto.changes.rollCount, preserved);
  }

  private positionUpdateData(
    changes: CommercialPositionChangesDto,
  ): Prisma.CommercialOrderPositionUncheckedUpdateManyInput {
    const data: Prisma.CommercialOrderPositionUncheckedUpdateManyInput = {};
    if (changes.rollCount !== undefined) data.rollCount = changes.rollCount;
    if (changes.filmType !== undefined) data.filmType = changes.filmType.trim();
    if (changes.actualThickness !== undefined) {
      data.actualThickness = changes.actualThickness.trim();
    }
    if (changes.accountingThickness !== undefined) {
      data.accountingThickness = changes.accountingThickness.trim();
    }
    if (changes.widthMm !== undefined) data.widthMm = changes.widthMm;
    if (changes.plannedLengthM !== undefined) data.plannedLengthM = changes.plannedLengthM;
    if (changes.rawMaterialId !== undefined) data.rawMaterialId = changes.rawMaterialId;
    if (changes.spoolType !== undefined) data.spoolType = normalizedText(changes.spoolType);
    if (changes.birka !== undefined) data.birka = normalizedText(changes.birka);
    if (changes.manualBirka !== undefined) {
      data.manualBirka = normalizedText(changes.manualBirka);
    }
    if (changes.comment !== undefined) data.comment = normalizedText(changes.comment);
    if (changes.plannedWeightKg !== undefined) data.plannedWeightKg = changes.plannedWeightKg;
    return data;
  }

  private actualChangedFields(
    position: AmendmentPosition,
    changes: CommercialPositionChangesDto,
  ): string[] {
    const changed = new Set<string>();
    const compare = (
      field: keyof CommercialPositionChangesDto,
      current: unknown,
      requested: unknown,
    ) => {
      if (requested !== undefined && !isDeepStrictEqual(current, requested)) changed.add(field);
    };

    compare('rollCount', position.rollCount, changes.rollCount);
    compare('filmType', position.filmType, changes.filmType?.trim());
    compare('actualThickness', position.actualThickness, changes.actualThickness?.trim());
    compare(
      'accountingThickness',
      position.accountingThickness,
      changes.accountingThickness?.trim(),
    );
    compare('widthMm', position.widthMm, changes.widthMm);
    compare('plannedLengthM', position.plannedLengthM, changes.plannedLengthM);
    compare('rawMaterialId', position.rawMaterialId, changes.rawMaterialId);
    compare(
      'baseRawMaterialDefinitionId',
      position.baseRawMaterialDefinitionId,
      changes.baseRawMaterialDefinitionId,
    );
    compare(
      'recipeDefinitionVersionId',
      position.recipeDefinitionVersionId,
      changes.recipeDefinitionVersionId,
    );
    compare('spoolType', position.spoolType, normalizedText(changes.spoolType));
    compare('birka', position.birka, normalizedText(changes.birka));
    compare('manualBirka', position.manualBirka, normalizedText(changes.manualBirka));
    compare('comment', position.comment, normalizedText(changes.comment));
    compare('plannedWeightKg', position.plannedWeightKg, changes.plannedWeightKg);
    compare(
      'recipeParameters',
      canonicalRecipeParameters(position.recipe?.parameters ?? []),
      changes.recipeParameters === undefined
        ? undefined
        : canonicalRecipeParameters(changes.recipeParameters),
    );
    return [...changed].sort();
  }

  private effectiveChanges(
    changes: CommercialPositionChangesDto,
    changedFields: readonly string[],
  ): CommercialPositionChangesDto {
    const source = changes as Record<string, unknown>;
    const effective: Record<string, unknown> = {};
    for (const field of changedFields) {
      effective[field] =
        field === 'recipeParameters' ? canonicalRecipeParameters(source[field]) : source[field];
    }
    return effective as CommercialPositionChangesDto;
  }

  private async resolveSelection(
    tx: Prisma.TransactionClient,
    position: MaterialSelectionInput,
  ): Promise<ResolvedRecipeSelection> {
    const selector = this.materialSelector(position);
    const resolved = await this.recipeCatalog.resolveSelections(tx, [selector]);
    if (resolved.length !== 1 || !resolved[0]) {
      throw new InternalServerErrorException({
        code: 'RECIPE_SELECTION_RESOLUTION_INVARIANT',
        message: 'Recipe selection resolution returned an unexpected number of results.',
      });
    }
    return copySelection(resolved[0]);
  }

  private resolveChangedSelection(
    tx: Prisma.TransactionClient,
    changes: CommercialPositionChangesDto,
  ): Promise<ResolvedRecipeSelection | null> {
    const hasBase = Object.prototype.hasOwnProperty.call(changes, 'baseRawMaterialDefinitionId');
    const hasRecipe = Object.prototype.hasOwnProperty.call(changes, 'recipeDefinitionVersionId');
    return hasBase || hasRecipe ? this.resolveSelection(tx, changes) : Promise.resolve(null);
  }

  private materialSelector(value: MaterialSelectionInput): PositionMaterialSelection {
    const baseId =
      typeof value.baseRawMaterialDefinitionId === 'string'
        ? value.baseRawMaterialDefinitionId
        : null;
    const recipeId =
      typeof value.recipeDefinitionVersionId === 'string' ? value.recipeDefinitionVersionId : null;
    if (Number(Boolean(baseId)) + Number(Boolean(recipeId)) !== 1) {
      throw new BadRequestException({
        code: 'INVALID_MATERIAL_SELECTION',
        message: 'A position must select exactly one base material or recipe version.',
      });
    }
    return baseId
      ? { baseRawMaterialDefinitionId: baseId }
      : { recipeDefinitionVersionId: recipeId as string };
  }

  private async updateRecipeSnapshot(
    tx: Prisma.TransactionClient,
    position: AmendmentPosition,
    changes: CommercialPositionChangesDto,
    selection: ResolvedRecipeSelection | null,
  ): Promise<void> {
    if (!selection && changes.recipeParameters === undefined) return;
    if (!position.recipe) {
      throw new NotFoundException(`Recipe for position ${position.id} not found`);
    }
    const updated = await tx.recipeSnapshot.updateMany({
      where: { positionId: position.id, version: position.recipe.version },
      data: {
        ...(changes.recipeParameters !== undefined
          ? {
              parameters: changes.recipeParameters as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(selection
          ? {
              recipeDefinitionId: selection.recipeDefinitionId,
              recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
              recipeVersionNumber: selection.version,
              recipeName: selection.name,
              ingredients: selection.ingredients as unknown as Prisma.InputJsonValue,
            }
          : {}),
        version: nextRecipeVersion(position.recipe.version),
      },
    });
    if (updated.count !== 1) throw this.positionVersionConflict();
  }

  private positionVersionConflict(): ConflictException {
    return new ConflictException({
      code: 'COMMERCIAL_AMENDMENT_POSITION_VERSION_CONFLICT',
      message: 'Позиция уже изменена. Обновите заявку и повторите действие.',
    });
  }

  private async recordCancellationEvents(
    tx: Prisma.TransactionClient,
    actor: CommercialOrderAmendmentActor,
    order: AmendmentOrder,
    kind: 'cancel_order' | 'reactivate_order',
    reason: string,
    cancelledAt: Date | null,
    result: OrderCancellationResult,
  ): Promise<void> {
    const cancelled = kind === 'cancel_order';
    const indicators = {
      productionIndicator: order.productionIndicator,
      warehouseCoverStatus: order.warehouseCoverStatus,
      paymentStatus: order.paymentStatus,
      shipmentStatus: order.shipmentStatus,
    };
    const finance = order.financeOrder
      ? {
          financeOrderId: order.financeOrder.id,
          invoiceStatus: order.financeOrder.invoiceStatus,
          paymentStatus: order.financeOrder.paymentStatus,
          productionClearedAt: order.financeOrder.productionClearedAt?.toISOString() ?? null,
        }
      : null;
    await this.audit.record(
      {
        type: cancelled ? 'audit:commercial_order_cancelled' : 'audit:commercial_order_reactivated',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: order.id,
        reason,
        oldValue: {
          version: order.version,
          cancellationStatus: order.cancellationStatus,
          cancellationVersion: order.cancellationVersion,
          cancelledAt: order.cancelledAt?.toISOString() ?? null,
          cancelledById: order.cancelledById,
          cancellationReason: order.cancellationReason,
          ...indicators,
          finance,
        },
        newValue: {
          version: result.orderVersion,
          cancellationStatus: result.cancellationStatus,
          cancellationVersion: result.cancellationVersion,
          cancelledAt: cancelledAt?.toISOString() ?? null,
          cancelledById: cancelled ? actor.userId : null,
          cancellationReason: cancelled ? reason : null,
          ...indicators,
          finance,
        },
        detail: {
          commandId: result.commandId,
          orderId: order.id,
          completedRollCount: result.completedRollCount,
          remainingCancelledRollCount: result.remainingCancelledRollCount,
          changedFutureRollIds: result.changedFutureRollIds,
          preservedPhysicalRollIds: result.preservedPhysicalRollIds,
        },
      },
      tx,
    );
    await this.audit.record(
      {
        type: 'audit:commercial_amendment_reconciled',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: order.id,
        reason,
        detail: {
          commandId: result.commandId,
          orderId: order.id,
          kind,
          reconciliation: result.reconciliation,
          changedFutureRollIds: result.changedFutureRollIds,
          preservedPhysicalRollIds: result.preservedPhysicalRollIds,
        },
      },
      tx,
    );
    await this.audit.record(
      {
        type: cancelled
          ? 'notification:commercial_order_cancelled'
          : 'notification:commercial_order_reactivated',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: order.id,
        detail: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          cancellationStatus: result.cancellationStatus,
          reconciliation: result.reconciliation,
          completedRollCount: result.completedRollCount,
          remainingCancelledRollCount: result.remainingCancelledRollCount,
          recipientRoles: ['commercial', 'production_lead', 'finance', 'warehouse'],
        },
      },
      tx,
    );
  }

  private async recordEvents(
    tx: Prisma.TransactionClient,
    actor: CommercialOrderAmendmentActor,
    order: AmendmentOrder,
    dto: Pick<ReconciliationAmendmentCommand, 'kind' | 'reason'>,
    mutation: PositionMutation,
    reconciled: CommercialOrderReconciliationResult,
    result: CommercialOrderAmendmentResult,
  ): Promise<void> {
    const positionId =
      mutation.affectedPositionIds.length === 1 ? (mutation.affectedPositionIds[0] ?? null) : null;
    await this.audit.record(
      {
        type: 'audit:commercial_order_amended',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: order.id,
        reason: dto.reason.trim(),
        oldValue: mutation.oldValue,
        newValue: mutation.newValue,
        detail: {
          commandId: result.commandId,
          orderId: order.id,
          kind: dto.kind,
          positionId,
          positionIds: mutation.affectedPositionIds,
          changedFields: mutation.changedFields,
        },
      },
      tx,
    );
    await this.audit.record(
      {
        type: 'audit:commercial_amendment_reconciled',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: order.id,
        reason: dto.reason.trim(),
        detail: {
          commandId: result.commandId,
          orderId: order.id,
          reconciliation: reconciled.reconciliation,
          changedFutureRollIds: reconciled.changedFutureRollIds,
          preservedPhysicalRollIds: reconciled.preservedPhysicalRollIds,
        },
      },
      tx,
    );
    const recipientRoles: Role[] = [
      ...(order.financeOrder ? (['finance'] as const) : []),
      ...(order.productionOrder ? (['production_lead'] as const) : []),
      ...(order.warehouseCoverageWorkflowVersion === 2 ? (['warehouse'] as const) : []),
    ];
    if (recipientRoles.length === 0) return;
    await this.audit.record(
      {
        type: 'notification:commercial_order_amended',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: order.id,
        detail: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          financeOrderId: order.financeOrder?.id ?? null,
          notificationKey: `commercial-order-amended:${result.commandId}`,
          commandId: result.commandId,
          positionId,
          positionIds: mutation.affectedPositionIds,
          changedFields: mutation.changedFields,
          orderVersion: result.orderVersion,
          reconciliation: reconciled.reconciliation,
          recipientRoles,
        },
      },
      tx,
    );
  }
}
