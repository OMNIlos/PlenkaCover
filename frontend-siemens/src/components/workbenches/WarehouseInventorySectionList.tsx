import type { Role, WorkObject } from '../../domain/types';
import { buildWarehouseInventoryDashboard } from '../../domain/warehouseInventoryDashboard';
import {
  isWarehouseInventorySection as isInventorySection,
  isWarehouseStockSection,
  warehouseInventoryCategoryForSection,
} from '../../domain/warehouseSections';

export function warehouseInventorySectionCount(section: string, sourceObject?: WorkObject) {
  if (isWarehouseStockSection(section)) return 0;
  const dashboard = buildWarehouseInventoryDashboard(sourceObject);
  const categoryId = warehouseInventoryCategoryForSection(section);
  return dashboard.categories.find((category) => category.id === categoryId)?.rows.length ?? 0;
}

export function isWarehouseInventorySection(role: Role, section: string) {
  if (role === 'warehouse') return isInventorySection(section);
  return role === 'director' && isWarehouseStockSection(section);
}
