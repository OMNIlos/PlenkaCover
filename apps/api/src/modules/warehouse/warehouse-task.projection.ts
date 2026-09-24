import { Prisma } from '@prisma/client';
import type { ScanStatus } from '@plenka/contracts';

export type WarehouseTaskWithRows = Prisma.WarehouseAcceptanceTaskGetPayload<{
  include: { rows: true };
}>;

export type WarehouseScanRowProjectionSource = {
  rollCode: string;
  scanStatus: string;
  lastScanAt: Date | null;
};

export function projectParsedRollCode(row: WarehouseScanRowProjectionSource): string | null {
  return row.scanStatus === 'wrong' ? null : row.rollCode;
}

export function projectLastScanResult(rows: WarehouseScanRowProjectionSource[]) {
  const latest = rows.reduce<WarehouseScanRowProjectionSource | null>((current, row) => {
    if (!row.lastScanAt) return current;
    if (!current?.lastScanAt || row.lastScanAt > current.lastScanAt) return row;
    return current;
  }, null);
  if (!latest?.lastScanAt) return null;
  return {
    rollCode: projectParsedRollCode(latest),
    scanStatus: latest.scanStatus as ScanStatus,
    scannedAt: latest.lastScanAt.toISOString(),
  };
}

export function projectWarehouseTask(
  task: WarehouseTaskWithRows,
  customerAliasByOrderReference?: ReadonlyMap<string, string>,
) {
  return {
    id: task.id,
    mode: task.mode,
    status: task.status,
    operationCode: task.operationCode,
    orderId: task.orderId,
    positionId: task.positionId,
    proposalId: task.proposalId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    lastScanResult: projectLastScanResult(task.rows),
    rows: task.rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      rollCode: projectParsedRollCode(row),
      fromOrderId: row.fromOrderId,
      customerAlias:
        customerAliasByOrderReference?.get(row.fromOrderId ?? task.orderId ?? '') ?? null,
      scanStatus: row.scanStatus,
      lastScanAt: row.lastScanAt,
      scannedByName: row.scannedByName,
    })),
  };
}
