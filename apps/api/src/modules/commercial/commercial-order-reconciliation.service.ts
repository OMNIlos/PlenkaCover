import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Role } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { hasIrreversiblePhysicalFacts } from '../../common/production/roll-reversibility';
import {
  COMMERCIAL_HANDOFF_POSITION_INCLUDE,
  productionRecipeSnapshot,
  recipeNumber,
} from '../warehouse-coverage/warehouse-coverage-production-handoff.service';
import { compareOpaqueIdsBinary } from '../warehouse-coverage/warehouse-coverage-canonical';
import {
  WarehouseCoverageOrderChangeService,
  type WarehouseCoverageOrderChangeContext,
} from '../warehouse-coverage/warehouse-coverage-order-change.service';
import type { CommercialAmendmentKind } from './dto/order-amendment.dto';

type CommercialReconciliationKind =
  | CommercialAmendmentKind
  | 'cancel_order'
  | 'reactivate_order'
  | 'cancel_unfinished_order';

const REVERSIBILITY_SELECT = {
  id: true,
  rollCode: true,
  productionOrderId: true,
  orderLineId: true,
  positionSequence: true,
  status: true,
  completedAt: true,
  queueRank: true,
  coverageFact: { select: { id: true } },
  operatorLine: {
    select: {
      spoolKg: true,
      grossKg: true,
      netKg: true,
      warehouseState: true,
      weightCaptures: { select: { id: true } },
      labelJobs: { select: { id: true } },
      operations: { select: { id: true } },
    },
  },
} satisfies Prisma.RollDispatchItemSelect;

type ReconciliationRoll = Prisma.RollDispatchItemGetPayload<{
  select: typeof REVERSIBILITY_SELECT;
}>;
type ReconciliationPosition = Prisma.CommercialOrderPositionGetPayload<{
  include: typeof COMMERCIAL_HANDOFF_POSITION_INCLUDE;
}>;

export type CommercialOrderReconciliationResult = {
  reconciliation: 'applied' | 'needs_production_review';
  changedFutureRollIds: string[];
  preservedPhysicalRollIds: string[];
  preservedRollCountByPosition: Record<string, number>;
  completedRollCount: number;
  remainingCancelledRollCount: number;
};

export type CommercialOrderReconciliationInput = {
  actor: { userId: string | null; role: Role };
  orderId: string;
  orderNumber: string;
  productionOrderId: string | null;
  positionIds: string[];
  kind: CommercialReconciliationKind;
  reason: string;
  coverageContext: WarehouseCoverageOrderChangeContext;
};

type DispatchPlan = {
  rawMaterialId: string | null;
  recipeVersion: string | null;
  filmType: string;
  plannedWeightKg: number | null;
  widthMm: number | null;
  plannedLengthM: number | null;
  characteristicsSnapshot: Prisma.InputJsonValue;
};

function physicalFacts(row: ReconciliationRoll) {
  return {
    status: row.status,
    completedAt: row.completedAt,
    coverageFactId: row.coverageFact?.id ?? null,
    operatorLine: row.operatorLine,
  };
}

function dispatchPlan(position: ReconciliationPosition): DispatchPlan {
  const materialRecipe = productionRecipeSnapshot(position);
  const plannedWeightKg =
    recipeNumber(position.recipe, ['План. вес, кг']) ?? position.plannedWeightKg;
  const plannedLengthM =
    position.plannedLengthM ?? recipeNumber(position.recipe, ['Метраж, м', 'Длина, м']);
  const widthMm =
    position.widthMm ??
    recipeNumber(position.recipe, ['Ширина', 'Ширина, мм', 'Ширина (мм)', 'Размер, мм']);
  return {
    rawMaterialId: materialRecipe.rawMaterialId,
    recipeVersion: position.recipe?.version ?? null,
    filmType: position.filmType,
    plannedWeightKg,
    widthMm,
    plannedLengthM,
    characteristicsSnapshot: {
      filmType: position.filmType,
      actualThickness: position.actualThickness,
      accountingThickness: position.accountingThickness,
      rawMaterialId: materialRecipe.rawMaterialId,
      spoolType: position.spoolType,
      birka: position.birka,
      manualBirka: position.manualBirka,
      comment: position.comment,
      widthMm,
      plannedLengthM,
      recipeParameters: position.recipe?.parameters ?? [],
      ...(materialRecipe.recipe ? { recipe: materialRecipe.recipe } : {}),
      recipeVersion: position.recipe?.version ?? null,
    } as unknown as Prisma.InputJsonValue,
  };
}

function maxNumericRollSuffix(orderNumber: string, rollCodes: readonly string[]): number {
  const prefix = `${orderNumber}-roll-`;
  return rollCodes.reduce((maximum, rollCode) => {
    if (!rollCode.startsWith(prefix)) return maximum;
    const value = Number(rollCode.slice(prefix.length));
    return Number.isSafeInteger(value) && value > maximum ? value : maximum;
  }, 0);
}

function reconciliationConflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

@Injectable()
export class CommercialOrderReconciliationService {
  constructor(private readonly coverage: WarehouseCoverageOrderChangeService) {}

  lockOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<WarehouseCoverageOrderChangeContext> {
    return this.coverage.lockForOrderChange(tx, orderId);
  }

  async reconcile(
    tx: Prisma.TransactionClient,
    input: CommercialOrderReconciliationInput,
  ): Promise<CommercialOrderReconciliationResult> {
    const reconcileCoverage = () =>
      this.coverage.reconcileAfterOrderChange(tx, input.coverageContext, input.actor, input.reason);
    let coverage = input.kind === 'cancel_unfinished_order' ? null : await reconcileCoverage();
    if (!input.productionOrderId) {
      if (!coverage) coverage = await reconcileCoverage();
      return {
        reconciliation: coverage.needsProductionReview ? 'needs_production_review' : 'applied',
        changedFutureRollIds: [],
        preservedPhysicalRollIds: [],
        preservedRollCountByPosition: Object.fromEntries(
          input.positionIds.map((positionId) => [positionId, 0]),
        ),
        completedRollCount: 0,
        remainingCancelledRollCount: 0,
      };
    }

    const productionOrder = await tx.productionOrder.findFirst({
      where: { id: input.productionOrderId, commercialOrderId: input.orderId },
      select: { id: true },
    });
    if (!productionOrder) {
      throw new NotFoundException(
        `Production order ${input.productionOrderId} not found for order ${input.orderId}`,
      );
    }
    const positions = await tx.commercialOrderPosition.findMany({
      where: { orderId: input.orderId, id: { in: input.positionIds } },
      include: COMMERCIAL_HANDOFF_POSITION_INCLUDE,
      orderBy: { id: 'asc' },
    });
    if (positions.length !== new Set(input.positionIds).size) {
      throw reconciliationConflict(
        'COMMERCIAL_AMENDMENT_POSITION_SET_CONFLICT',
        'Состав позиций изменился во время сверки.',
      );
    }

    const initialRows = await tx.rollDispatchItem.findMany({
      where: {
        productionOrderId: productionOrder.id,
        orderLineId: { in: input.positionIds },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const sortedIds = initialRows.map(({ id }) => id).sort(compareOpaqueIdsBinary);
    if (sortedIds.length > 0) {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
                   WHERE "id" IN (${Prisma.join(sortedIds)})
                   ORDER BY "id" COLLATE "C" FOR UPDATE`,
      );
      if (
        locked.length !== sortedIds.length ||
        locked.some((row, index) => row.id !== sortedIds[index])
      ) {
        throw reconciliationConflict(
          'COMMERCIAL_AMENDMENT_DISPATCH_SET_CONFLICT',
          'Набор производственных рулонов изменился во время сверки.',
        );
      }
    }
    const rows = await tx.rollDispatchItem.findMany({
      where: {
        productionOrderId: productionOrder.id,
        orderLineId: { in: input.positionIds },
      },
      select: REVERSIBILITY_SELECT,
      orderBy: [{ orderLineId: 'asc' }, { positionSequence: 'asc' }, { id: 'asc' }],
    });
    if (
      rows.length !== initialRows.length ||
      rows.some((row, index) => row.id !== sortedIds[index])
    ) {
      const rowIds = rows.map(({ id }) => id).sort(compareOpaqueIdsBinary);
      if (
        rowIds.length !== sortedIds.length ||
        rowIds.some((id, index) => id !== sortedIds[index])
      ) {
        throw reconciliationConflict(
          'COMMERCIAL_AMENDMENT_DISPATCH_SET_CONFLICT',
          'Набор производственных рулонов изменился во время сверки.',
        );
      }
    }
    const allRolls = await tx.rollDispatchItem.findMany({
      where: { productionOrderId: productionOrder.id },
      select: { rollCode: true, queueRank: true, positionSequence: true },
    });
    let nextRollSuffix = maxNumericRollSuffix(
      input.orderNumber,
      allRolls.map(({ rollCode }) => rollCode),
    );
    let nextQueueRank = allRolls.reduce((maximum, row) => Math.max(maximum, row.queueRank), 0);
    const changedFutureRollIds: string[] = [];
    const preservedPhysicalRollIds: string[] = [];
    const preservedRollCountByPosition: Record<string, number> = {};
    let completedRollCount = 0;
    let remainingCancelledRollCount = 0;
    const rowsToCreate: Prisma.RollDispatchItemCreateManyInput[] = [];
    const now = new Date();

    for (const position of positions) {
      const positionRows = rows
        .filter((row) => row.orderLineId === position.id && row.status !== 'cancelled')
        .sort(
          (left, right) =>
            left.positionSequence - right.positionSequence ||
            compareOpaqueIdsBinary(left.id, right.id),
        );
      const cancelUnfinished = input.kind === 'cancel_unfinished_order';
      const completed = (row: ReconciliationRoll) =>
        ['ready_for_warehouse', 'done'].includes(row.status);
      const preserved = positionRows.filter((row) =>
        cancelUnfinished ? completed(row) : hasIrreversiblePhysicalFacts(physicalFacts(row)),
      );
      const reversible = positionRows.filter((row) =>
        cancelUnfinished ? !completed(row) : !hasIrreversiblePhysicalFacts(physicalFacts(row)),
      );
      preservedPhysicalRollIds.push(...preserved.map(({ rollCode }) => rollCode));
      preservedRollCountByPosition[position.id] = preserved.length;
      completedRollCount += preserved.filter(
        (row) => row.completedAt !== null || ['ready_for_warehouse', 'done'].includes(row.status),
      ).length;

      const cancellingOrder = input.kind === 'cancel_order';
      const effectiveRollCount =
        cancellingOrder || cancelUnfinished
          ? preserved.length
          : Math.max(position.rollCount, preserved.length);
      if (!cancellingOrder && effectiveRollCount !== position.rollCount) {
        const adjusted = await tx.commercialOrderPosition.updateMany({
          where: {
            id: position.id,
            orderId: input.orderId,
            rollCount: position.rollCount,
            ...(cancelUnfinished ? { version: position.version } : {}),
          },
          data: {
            rollCount: effectiveRollCount,
            ...(cancelUnfinished ? { version: { increment: 1 } } : {}),
          },
        });
        if (adjusted.count !== 1) {
          throw reconciliationConflict(
            'COMMERCIAL_AMENDMENT_POSITION_SET_CONFLICT',
            'Желаемое количество рулонов изменилось во время сверки.',
          );
        }
      }

      const futureCount = Math.max(0, effectiveRollCount - preserved.length);
      const kept = reversible.slice(0, futureCount);
      const surplus = reversible.slice(futureCount);
      remainingCancelledRollCount += surplus.length;
      const plan = dispatchPlan(position);
      for (const row of kept) {
        const updated = await tx.rollDispatchItem.updateMany({
          where: { id: row.id },
          data: plan,
        });
        if (updated.count !== 1) {
          throw reconciliationConflict(
            'COMMERCIAL_AMENDMENT_DISPATCH_SET_CONFLICT',
            'Будущий рулон изменился во время сверки.',
          );
        }
        changedFutureRollIds.push(row.rollCode);
      }
      for (const row of surplus) {
        const updated = await tx.rollDispatchItem.updateMany({
          where: { id: row.id },
          data: {
            status: 'cancelled',
            cancelledAt: now,
            cancellationReason: input.reason,
            assignedOperatorId: null,
            machineId: null,
            workplaceId: null,
            postId: null,
            plannedShiftId: null,
          },
        });
        if (updated.count !== 1) {
          throw reconciliationConflict(
            'COMMERCIAL_AMENDMENT_DISPATCH_SET_CONFLICT',
            'Будущий рулон изменился во время отмены.',
          );
        }
        changedFutureRollIds.push(row.rollCode);
      }

      const newCount = futureCount - kept.length;
      let nextSequence = rows
        .filter((row) => row.orderLineId === position.id)
        .reduce((maximum, row) => Math.max(maximum, row.positionSequence), 0);
      for (let index = 0; index < newCount; index += 1) {
        nextRollSuffix += 1;
        nextQueueRank += 1;
        nextSequence += 1;
        const rollCode = `${input.orderNumber}-roll-${nextRollSuffix}`;
        rowsToCreate.push({
          rollCode,
          productionOrderId: productionOrder.id,
          orderLineId: position.id,
          positionSequence: nextSequence,
          ...plan,
          status: 'new',
          queueRank: nextQueueRank,
          priority: 0,
        });
        changedFutureRollIds.push(rollCode);
      }
    }
    if (rowsToCreate.length > 0) {
      const created = await tx.rollDispatchItem.createMany({ data: rowsToCreate });
      if (created.count !== rowsToCreate.length) {
        throw reconciliationConflict(
          'COMMERCIAL_AMENDMENT_DISPATCH_SET_CONFLICT',
          'Не удалось создать полный набор будущих рулонов.',
        );
      }
    }
    if (!coverage) coverage = await reconcileCoverage();

    changedFutureRollIds.sort(compareOpaqueIdsBinary);
    preservedPhysicalRollIds.sort(compareOpaqueIdsBinary);
    return {
      reconciliation:
        coverage.needsProductionReview || preservedPhysicalRollIds.length > 0
          ? 'needs_production_review'
          : 'applied',
      changedFutureRollIds,
      preservedPhysicalRollIds,
      preservedRollCountByPosition,
      completedRollCount,
      remainingCancelledRollCount,
    };
  }
}
