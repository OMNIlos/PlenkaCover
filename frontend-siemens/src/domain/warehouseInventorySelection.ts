import type { WarehouseInventoryRow } from './warehouseInventoryDashboard';

export function selectedWarehouseInventoryRow(
  rows: WarehouseInventoryRow[],
  selectedRowId?: string | null,
) {
  if (!selectedRowId) return undefined;
  return rows.find((row) => row.id === selectedRowId);
}
