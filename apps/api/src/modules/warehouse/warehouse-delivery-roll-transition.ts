import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type DeliveryRollTask = {
  mode: string;
  orderId: string | null;
  positionId: string | null;
};

export async function deliverWarehouseRoll(
  tx: Prisma.TransactionClient,
  task: DeliveryRollTask,
  rollCode: string,
): Promise<void> {
  if (task.mode !== 'delivery' || !task.orderId) throw rollNotReady();

  await tx.$queryRaw`
    SELECT "id"
    FROM "warehouse_rolls"
    WHERE "rollCode" = ${rollCode}
    FOR UPDATE
  `;
  const roll = await tx.warehouseRoll.findUnique({ where: { rollCode } });
  if (!roll || roll.warehouseStatus !== 'received') throw rollNotReady();

  const exactReservation =
    roll.reservedForOrderId === task.orderId &&
    (!task.positionId || roll.reservedForPositionId === task.positionId);
  const exactProduction =
    !roll.releasedFromOrderId &&
    roll.producedForOrderId === task.orderId &&
    roll.producedForPositionId !== null &&
    roll.producedByCoverageDecisionId !== null &&
    (!task.positionId || roll.producedForPositionId === task.positionId);
  if (!exactReservation && !exactProduction) throw rollNotReady();

  const delivered = await tx.warehouseRoll.updateMany({
    where: { id: roll.id, warehouseStatus: 'received' },
    data: { warehouseStatus: 'delivered' },
  });
  if (delivered.count !== 1) throw inventoryConflict();

  await tx.operatorRollLine.updateMany({
    where: { rollDispatchItem: { rollCode }, warehouseState: 'received' },
    data: { warehouseState: 'delivered' },
  });
}

function rollNotReady(): ConflictException {
  return new ConflictException({
    code: 'WAREHOUSE_ROLL_NOT_READY',
    message: 'Рулон не находится в допустимом физическом состоянии.',
  });
}

function inventoryConflict(): ConflictException {
  return new ConflictException({
    code: 'WAREHOUSE_INVENTORY_CONFLICT',
    message: 'Складское состояние изменилось конкурентно. Обновите задачу.',
  });
}
