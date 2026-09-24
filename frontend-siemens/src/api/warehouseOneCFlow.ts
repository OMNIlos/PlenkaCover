import type { WarehouseOneCStockPushPreview, WarehouseOneCStockPushResult } from './warehouse';

export const WAREHOUSE_ONEC_CONFIRMATION = 'ПРОВЕСТИ';

export function isExactWarehouseOneCConfirmation(value: string | undefined): boolean {
  return value?.trim() === WAREHOUSE_ONEC_CONFIRMATION;
}

export function isValidWarehouseOneCPreview(preview: WarehouseOneCStockPushPreview): boolean {
  if (
    !Number.isInteger(preview.count) ||
    preview.count < 1 ||
    preview.items.length !== preview.count ||
    !/^[a-f0-9]{64}$/u.test(preview.snapshotHash) ||
    !Number.isFinite(preview.totalQty)
  ) {
    return false;
  }
  const totalQty = preview.items.reduce((sum, item) => sum + item.qty, 0);
  return Math.abs(totalQty - preview.totalQty) < 1e-9;
}

export function warehouseOneCReadinessError(preview: WarehouseOneCStockPushPreview): string | null {
  if (preview.writeReady) return null;
  return preview.readinessMessage || 'Демо-1С сейчас не готова к тестовой записи.';
}

export function isVerifiedWarehouseOneCResult(
  result: WarehouseOneCStockPushResult,
  expectedOperationKey: string,
  expectedSnapshotHash: string,
): boolean {
  return (
    result.operationKey === expectedOperationKey &&
    result.snapshotHash === expectedSnapshotHash &&
    result.ack.accepted === true &&
    result.ack.mode === 'http' &&
    result.ack.documentCreated === true &&
    result.ack.count === result.pushed &&
    result.count === result.pushed &&
    result.items.length === result.pushed &&
    result.pushed > 0 &&
    Boolean(result.ack.ref) &&
    result.ack.ref !== 'noop' &&
    !result.ack.ref.startsWith('mock-')
  );
}

export function warehouseOneCSuccessTitle(result: WarehouseOneCStockPushResult): string {
  return result.replayed
    ? 'Ранее проведённый документ найден'
    : 'Тестовый документ проведён в демо-1С';
}
