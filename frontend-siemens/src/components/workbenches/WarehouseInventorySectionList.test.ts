import { describe, expect, it } from 'vitest';

import { isWarehouseInventorySection } from './WarehouseInventorySectionList';

describe('warehouse inventory role routing', () => {
  it('adds only the shared roll registry to the director inventory routes', () => {
    expect(isWarehouseInventorySection('warehouse', 'Все рулоны')).toBe(true);
    expect(isWarehouseInventorySection('warehouse', 'Сырье')).toBe(true);
    expect(isWarehouseInventorySection('director', 'Все рулоны')).toBe(true);
    expect(isWarehouseInventorySection('director', 'Сырье')).toBe(false);
    expect(isWarehouseInventorySection('production', 'Все рулоны')).toBe(false);
  });
});
