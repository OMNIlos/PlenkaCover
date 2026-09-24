import type { OperatorWorkload, ProductionPriority, ProductionRollDispatchItem } from './types';
import type { ProductionOperator } from './operators';

export type ProductionRollSortMode =
  | 'manual'
  | 'roll'
  | 'order'
  | 'parameters'
  | 'priority'
  | 'operator'
  | 'machine'
  | 'weight'
  | 'meterage'
  | 'estimated'
  | 'status';

export type ProductionRollSortDirection = 'asc' | 'desc';

export type ProductionRollSort = {
  key: ProductionRollSortMode;
  direction: ProductionRollSortDirection;
};

const statusRank: Record<ProductionRollDispatchItem['status'], number> = {
  in_work: 0,
  assigned: 1,
  queued: 2,
  blocked: 3,
  handover_ready: 4,
  warehouse_pending: 5,
  warehouse_handed_off: 6,
  warehouse_accepted: 7,
  warehouse_delivered: 8,
};

export function productionPriorityRank(priority: ProductionPriority) {
  const priorityRank: Record<ProductionPriority, number> = {
    критично: 0,
    срочно: 1,
    обычный: 2,
  };
  return priorityRank[priority];
}

export function productionRollDispatchStatusLabel(status: ProductionRollDispatchItem['status']) {
  const labels: Record<ProductionRollDispatchItem['status'], string> = {
    queued: 'В очереди',
    assigned: 'Назначен',
    in_work: 'В работе',
    handover_ready: 'К передаче',
    warehouse_pending: 'Ждет склад',
    warehouse_handed_off: 'Передан на склад',
    warehouse_accepted: 'Принят складом',
    warehouse_delivered: 'Выдан со склада',
    blocked: 'Блокер',
  };
  return labels[status];
}

export function productionRollIsWarehouseLifecycle(status: ProductionRollDispatchItem['status']) {
  return [
    'warehouse_pending',
    'warehouse_handed_off',
    'warehouse_accepted',
    'warehouse_delivered',
  ].includes(status);
}

export function productionRollQueueRank(item: ProductionRollDispatchItem) {
  return item.queueRank ?? productionPriorityRank(item.priority) * 1000 + item.sequenceNumber;
}

export function productionRollMeterage(item: ProductionRollDispatchItem) {
  if (typeof item.meterageMeters === 'number') return item.meterageMeters;
  const parsed = Number.parseFloat(item.sizeMeters.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function productionRollPlannedWeightTotal(
  items: ReadonlyArray<ProductionRollDispatchItem>,
): number | undefined {
  if (items.some((item) => item.plannedNetKg === undefined)) return undefined;
  return Number(items.reduce((sum, item) => sum + item.plannedNetKg!, 0).toFixed(1));
}

function productionValueWithUnit(value: string | undefined, unit: string) {
  const normalized = value?.trim();
  if (!normalized || normalized === 'из заявки' || normalized === 'нет данных') return null;
  return normalized.toLocaleLowerCase('ru').includes(unit) ? normalized : `${normalized} ${unit}`;
}

function positiveProductionNumber(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function productionRollSpecificationLabel(item: ProductionRollDispatchItem) {
  const actualThickness = productionValueWithUnit(item.actualThickness ?? item.micron, 'мкм');
  const accountingThickness = productionValueWithUnit(item.accountingThickness, 'мкм');
  const thickness =
    actualThickness && accountingThickness
      ? `${actualThickness} (${accountingThickness})`
      : actualThickness;
  const widthMm = positiveProductionNumber(item.widthMm);
  const plannedLengthM =
    positiveProductionNumber(item.plannedLengthM) ??
    positiveProductionNumber(item.meterageMeters) ??
    positiveProductionNumber(productionRollMeterage(item));
  const plannedNetKg =
    item.plannedNetKg === undefined
      ? 'План не указан'
      : Number.isFinite(item.plannedNetKg)
        ? `${item.plannedNetKg} кг`
        : null;
  const parts = [
    item.filmType.trim(),
    thickness,
    widthMm === null ? null : `${widthMm} мм`,
    plannedLengthM === null ? null : `${plannedLengthM} м`,
    plannedNetKg,
  ].filter((value): value is string => Boolean(value));

  return parts.join(' · ') || item.characteristics;
}

export function productionRollOrderNumber(item: ProductionRollDispatchItem) {
  return item.orderNumber ?? item.orderId.replace(/^ЗН-\d{4}-/, '');
}

/**
 * Ярлык заказа для строки рулона. В live-режиме orderId — это технический cuid
 * (шум для пользователя), поэтому показываем читаемый номер заказа; в demo/прототипе
 * orderId уже читаемый (ЗН-2606-014) и его сохраняем как есть.
 */
export function productionRollOrderLabel(item: ProductionRollDispatchItem) {
  const isTechnicalId = /^c[a-z0-9]{20,}$/.test(item.orderId);
  return isTechnicalId ? productionRollOrderNumber(item) : item.orderId;
}

/**
 * Читаемая ссылка на позицию заказа для строки рулона. В live orderLineId — cuid,
 * который прячем; в demo это читаемый код (POS-012-01) — оставляем как ориентир.
 */
export function productionRollLineLabel(item: ProductionRollDispatchItem) {
  if (!item.orderLineId || /^c[a-z0-9]{20,}$/.test(item.orderLineId)) return '';
  return item.orderLineId;
}

function normalizeProductionRollSort(
  sort: ProductionRollSortMode | ProductionRollSort,
): ProductionRollSort {
  if (typeof sort !== 'string') return sort;
  return { key: sort, direction: 'asc' };
}

function compareProductionRolls(
  left: ProductionRollDispatchItem,
  right: ProductionRollDispatchItem,
  key: ProductionRollSortMode,
) {
  if (key === 'priority')
    return productionPriorityRank(left.priority) - productionPriorityRank(right.priority);
  if (key === 'operator') return left.operatorLabel.localeCompare(right.operatorLabel, 'ru');
  if (key === 'machine') return left.machineLabel.localeCompare(right.machineLabel, 'ru');
  if (key === 'weight') {
    if (left.plannedNetKg === undefined) return right.plannedNetKg === undefined ? 0 : 1;
    if (right.plannedNetKg === undefined) return -1;
    return left.plannedNetKg - right.plannedNetKg;
  }
  if (key === 'meterage') return productionRollMeterage(left) - productionRollMeterage(right);
  if (key === 'estimated') return (left.estimatedMinutes ?? 0) - (right.estimatedMinutes ?? 0);
  if (key === 'status') return statusRank[left.status] - statusRank[right.status];
  if (key === 'roll')
    return (
      left.rollId.localeCompare(right.rollId, 'ru') || left.sequenceNumber - right.sequenceNumber
    );
  if (key === 'order') {
    return (
      left.orderId.localeCompare(right.orderId, 'ru') ||
      productionRollOrderNumber(left).localeCompare(productionRollOrderNumber(right), 'ru')
    );
  }
  if (key === 'parameters') {
    return (
      left.characteristics.localeCompare(right.characteristics, 'ru') ||
      left.filmType.localeCompare(right.filmType, 'ru') ||
      left.micron.localeCompare(right.micron, 'ru') ||
      left.sizeMeters.localeCompare(right.sizeMeters, 'ru')
    );
  }

  return productionRollQueueRank(left) - productionRollQueueRank(right);
}

export function sortProductionRolls(
  items: ProductionRollDispatchItem[],
  sort: ProductionRollSortMode | ProductionRollSort = 'manual',
) {
  const normalized = normalizeProductionRollSort(sort);
  const directionFactor = normalized.direction === 'desc' ? -1 : 1;
  const sorted = [...items];
  return sorted.sort((left, right) => {
    const primary = compareProductionRolls(left, right, normalized.key);
    if (primary !== 0) return primary * directionFactor;

    if (normalized.key === 'order') {
      return (
        productionRollQueueRank(left) - productionRollQueueRank(right) ||
        left.rollId.localeCompare(right.rollId, 'ru') ||
        left.sequenceNumber - right.sequenceNumber
      );
    }

    return (
      productionRollQueueRank(left) - productionRollQueueRank(right) ||
      productionPriorityRank(left.priority) - productionPriorityRank(right.priority) ||
      left.orderId.localeCompare(right.orderId, 'ru') ||
      left.sequenceNumber - right.sequenceNumber
    );
  });
}

export function aggregateProductionRollDispatchItems(
  objects: Array<{ productionRollDispatchItems?: ProductionRollDispatchItem[] }>,
) {
  return sortProductionRolls(
    objects
      .flatMap((object) => object.productionRollDispatchItems ?? [])
      .filter((item) => !productionRollIsWarehouseLifecycle(item.status)),
    'manual',
  );
}

export function assignedProductionOperatorCount(items: ProductionRollDispatchItem[]) {
  return new Set(items.map((item) => item.operatorId).filter(Boolean)).size;
}

export function operatorWorkloadsFromDispatch(
  items: ProductionRollDispatchItem[],
  operators: ProductionOperator[],
): OperatorWorkload[] {
  return operators.map((operator) => {
    const assigned = items.filter((item) => item.operatorId === operator.id);
    const capacityKnown = operator.capacityKnown !== false;
    const estimatedMinutesTotal = assigned.reduce(
      (sum, item) => sum + (item.estimatedMinutes ?? 0),
      0,
    );
    const availableCapacityMinutes = capacityKnown
      ? Math.max(0, operator.remainingShiftMinutes - estimatedMinutesTotal)
      : 0;
    const overCapacityMinutes = capacityKnown
      ? Math.max(0, estimatedMinutesTotal - operator.remainingShiftMinutes)
      : 0;
    const averageRollMinutes =
      assigned.length > 0
        ? Math.max(
            45,
            Math.round(
              assigned.reduce((sum, item) => sum + (item.estimatedMinutes ?? 75), 0) /
                assigned.length,
            ),
          )
        : 75;
    const canAcceptRollCount = capacityKnown
      ? Math.floor(availableCapacityMinutes / averageRollMinutes)
      : 0;
    const capacityBasisLabel = capacityKnown
      ? assigned.length > 0
        ? `среднее ${averageRollMinutes} мин/рулон`
        : 'план 75 мин/рулон'
      : 'Без временного лимита';
    const loadState: OperatorWorkload['loadState'] =
      operator.status === 'blocked'
        ? 'blocked'
        : !capacityKnown
          ? 'available'
          : overCapacityMinutes > 0
            ? 'overloaded'
            : availableCapacityMinutes < 90 || canAcceptRollCount === 0
              ? 'near_limit'
              : 'available';

    return {
      operatorId: operator.id,
      operatorLabel: operator.name,
      shiftId: operator.shiftId,
      defaultMachineId: operator.defaultMachineId,
      defaultMachineLabel: operator.defaultMachineLabel,
      assignedRollIds: assigned.map((item) => item.rollId),
      assignedRollCount: assigned.length,
      plannedWeightKg: productionRollPlannedWeightTotal(assigned),
      plannedMeterageMeters: assigned.reduce((sum, item) => sum + productionRollMeterage(item), 0),
      estimatedMinutesTotal,
      capacityKnown,
      shiftCapacityMinutes: operator.shiftCapacityMinutes,
      remainingShiftMinutes: operator.remainingShiftMinutes,
      availableCapacityMinutes,
      averageRollMinutes,
      capacityBasisLabel,
      overCapacityMinutes,
      canAcceptRollCount,
      loadState,
    };
  });
}
