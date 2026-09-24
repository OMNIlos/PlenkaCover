import type { ProductionRollDispatchItem } from './types';

export type PenaltyWorkOrderOption = {
  productionOrderId: string;
  orderNumber: string;
  rollCodes: string[];
};

export type PenaltyWorkCatalog = Record<string, PenaltyWorkOrderOption[]>;

type PenaltyWorkLink = {
  employeeId: string;
  productionOrderId?: string;
  rollCode?: string;
};

export function buildPenaltyWorkCatalog(rolls: ProductionRollDispatchItem[]): PenaltyWorkCatalog {
  const byOperator = new Map<
    string,
    Map<string, { orderNumber: string; rollCodes: Set<string> }>
  >();

  for (const roll of rolls) {
    const operatorId = roll.operatorId.trim();
    const productionOrderId = roll.productionOrderId.trim();
    const orderNumber = roll.orderNumber?.trim();
    const rollCode = roll.rollId.trim();
    if (!operatorId || !productionOrderId || !orderNumber || !rollCode) continue;

    const orders = byOperator.get(operatorId) ?? new Map();
    const order = orders.get(productionOrderId) ?? {
      orderNumber,
      rollCodes: new Set<string>(),
    };
    order.rollCodes.add(rollCode);
    orders.set(productionOrderId, order);
    byOperator.set(operatorId, orders);
  }

  return Object.fromEntries(
    [...byOperator.entries()].map(([operatorId, orders]) => [
      operatorId,
      [...orders.entries()]
        .map(([productionOrderId, order]) => ({
          productionOrderId,
          orderNumber: order.orderNumber,
          rollCodes: [...order.rollCodes].sort((left, right) =>
            left.localeCompare(right, 'ru', { numeric: true }),
          ),
        }))
        .sort((left, right) =>
          left.orderNumber.localeCompare(right.orderNumber, 'ru', { numeric: true }),
        ),
    ]),
  );
}

export function resetPenaltyWorkLinkOnEmployeeChange<T extends PenaltyWorkLink>(
  value: T,
  employeeId: string,
): T {
  return { ...value, employeeId, productionOrderId: '', rollCode: '' };
}

export function isPenaltyWorkLinkValid(
  orders: PenaltyWorkOrderOption[],
  productionOrderId: string | undefined,
  rollCode: string | undefined,
) {
  const order = orders.find((item) => item.productionOrderId === productionOrderId);
  if (!order) return false;
  return !rollCode || order.rollCodes.includes(rollCode);
}

export function resetPenaltyRollOnOrderChange<T extends PenaltyWorkLink>(
  value: T,
  productionOrderId: string,
): T {
  return { ...value, productionOrderId, rollCode: '' };
}
