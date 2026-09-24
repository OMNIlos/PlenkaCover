import { describe, expect, it } from 'vitest';

import type { WarehouseInventoryRow } from './warehouseInventoryDashboard';
import { selectedWarehouseInventoryRow } from './warehouseInventorySelection';

const rows = [
  { id: 'raw-1' },
  { id: 'raw-2' },
] as WarehouseInventoryRow[];

describe('selectedWarehouseInventoryRow', () => {
  it('keeps the inventory detail closed until a row is selected', () => {
    expect(selectedWarehouseInventoryRow(rows, null)).toBeUndefined();
    expect(selectedWarehouseInventoryRow(rows, undefined)).toBeUndefined();
  });

  it('returns only the explicitly selected visible row', () => {
    expect(selectedWarehouseInventoryRow(rows, 'raw-2')).toBe(rows[1]);
    expect(selectedWarehouseInventoryRow(rows, 'missing')).toBeUndefined();
  });
});
