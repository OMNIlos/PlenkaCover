import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { OperatorOrderMass } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { resolveCanonicalRollCaptures } from '../../common/weight-capture/canonical-roll-capture';
import { PrismaService } from '../../common/prisma/prisma.service';

type OrderMassActor = { userId: string | null };

const orderMassSelect = Prisma.validator<Prisma.ProductionOrderSelect>()({
  id: true,
  dispatchItems: {
    where: { status: { not: 'cancelled' } },
    select: {
      id: true,
      orderLineId: true,
      status: true,
      replacesDispatchItemId: true,
      plannedWeightKg: true,
      operatorLine: {
        select: {
          id: true,
          planKg: true,
          weightCaptures: {
            select: {
              id: true,
              operatorRollLineId: true,
              kind: true,
              stable: true,
              netKg: true,
              supersedesCaptureId: true,
              createdAt: true,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      },
    },
    orderBy: { id: 'asc' },
  },
});

type OrderMassRow = Prisma.ProductionOrderGetPayload<{ select: typeof orderMassSelect }>;

function kilogramsToGrams(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new ConflictException({
      code: 'OPERATOR_ORDER_MASS_INVALID_SOURCE',
      message: `Некорректное значение массы: ${field}.`,
    });
  }
  const grams = Math.round(value * 1_000);
  if (!Number.isSafeInteger(grams)) {
    throw new ConflictException({
      code: 'OPERATOR_ORDER_MASS_INVALID_SOURCE',
      message: `Значение массы выходит за безопасный диапазон: ${field}.`,
    });
  }
  return grams;
}

function addSafe(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new ConflictException({
      code: 'OPERATOR_ORDER_MASS_OVERFLOW',
      message: 'Суммарная масса заказа выходит за безопасный диапазон.',
    });
  }
  return result;
}

function kilograms(grams: number): number {
  return grams / 1_000;
}

@Injectable()
export class OperatorOrderMassService {
  constructor(private readonly prisma: PrismaService) {}

  async getForOrder(actor: OrderMassActor, orderNumber: string): Promise<OperatorOrderMass> {
    if (!actor.userId || orderNumber.trim() !== orderNumber || orderNumber.length === 0) {
      throw new NotFoundException('Заказ оператора не найден.');
    }

    const ownedOrder = await this.prisma.productionOrder.findFirst({
      where: {
        commercialOrder: { orderNumber },
        dispatchItems: {
          some: { assignedOperatorId: actor.userId, status: { not: 'new' } },
        },
      },
      select: { id: true },
    });
    if (!ownedOrder) throw new NotFoundException('Заказ оператора не найден.');

    const order = (await this.prisma.productionOrder.findUnique({
      where: { id: ownedOrder.id },
      select: orderMassSelect,
    })) as OrderMassRow | null;
    if (!order) throw new NotFoundException('Заказ оператора не найден.');

    return this.aggregate(order.dispatchItems);
  }

  private aggregate(items: OrderMassRow['dispatchItems']): OperatorOrderMass {
    const currentItems = items.filter((item) => item.status !== 'cancelled');
    const byId = new Map(currentItems.map((item) => [item.id, item]));
    const childByParent = new Map<string, (typeof items)[number]>();
    for (const item of currentItems) {
      if (!item.replacesDispatchItemId) continue;
      if (
        !byId.has(item.replacesDispatchItemId) ||
        childByParent.has(item.replacesDispatchItemId)
      ) {
        throw new ConflictException({
          code: 'OPERATOR_ORDER_MASS_INVALID_REPLACEMENT_CHAIN',
          message: 'Цепочка замен рулонов заказа неконсистентна.',
        });
      }
      childByParent.set(item.replacesDispatchItemId, item);
    }

    const roots = currentItems
      .filter((item) => item.replacesDispatchItemId === null)
      .sort((left, right) => left.id.localeCompare(right.id));
    const visited = new Set<string>();
    const leaves = roots.map((root) => {
      let current = root;
      while (true) {
        if (visited.has(current.id)) {
          throw new ConflictException({
            code: 'OPERATOR_ORDER_MASS_INVALID_REPLACEMENT_CHAIN',
            message: 'Цепочка замен рулонов заказа содержит цикл.',
          });
        }
        visited.add(current.id);
        const child = childByParent.get(current.id);
        if (!child) return current;
        current = child;
      }
    });
    if (visited.size !== currentItems.length) {
      throw new ConflictException({
        code: 'OPERATOR_ORDER_MASS_INVALID_REPLACEMENT_CHAIN',
        message: 'Не все рулоны заказа входят в каноническую цепочку замен.',
      });
    }

    const captures = currentItems.flatMap((item) => item.operatorLine?.weightCaptures ?? []);
    const canonicalByLine = new Map(
      resolveCanonicalRollCaptures(captures).map((capture) => [
        capture.operatorRollLineId,
        capture,
      ]),
    );

    let orderPlannedGrams = 0;
    let weighedPlannedGrams = 0;
    let actualGrams = 0;
    let weighedRollCount = 0;
    for (const leaf of leaves) {
      const planGrams =
        kilogramsToGrams(leaf.plannedWeightKg, `${leaf.id}.plannedWeightKg`) ??
        kilogramsToGrams(leaf.operatorLine?.planKg ?? null, `${leaf.id}.operatorLine.planKg`);
      if (planGrams === null) {
        throw new ConflictException({
          code: 'OPERATOR_ORDER_MASS_PLAN_UNRESOLVED',
          message: 'Не определена плановая масса одного из рулонов заказа.',
        });
      }
      orderPlannedGrams = addSafe(orderPlannedGrams, planGrams);

      const lineId = leaf.operatorLine?.id;
      const canonical = lineId ? canonicalByLine.get(lineId) : undefined;
      if (
        !canonical ||
        canonical.netKg == null ||
        !Number.isFinite(canonical.netKg) ||
        canonical.netKg <= 0
      ) {
        continue;
      }
      const netGrams = kilogramsToGrams(canonical.netKg, `${canonical.id}.netKg`);
      if (netGrams === null) continue;
      weighedPlannedGrams = addSafe(weighedPlannedGrams, planGrams);
      actualGrams = addSafe(actualGrams, netGrams);
      weighedRollCount += 1;
    }

    return {
      orderPlannedNetKg: kilograms(orderPlannedGrams),
      weighedPlannedNetKg: kilograms(weighedPlannedGrams),
      actualNetKg: kilograms(actualGrams),
      deviationKg: kilograms(actualGrams - weighedPlannedGrams),
      weighedRollCount,
      totalRollCount: leaves.length,
    };
  }
}
