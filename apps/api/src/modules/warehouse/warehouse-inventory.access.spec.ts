import { Reflector } from '@nestjs/core';
import { capabilitiesForRole, type Capability } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { WarehouseAccountingController } from './warehouse-accounting.controller';
import { WarehouseInventoryController } from './warehouse-inventory.controller';

describe('warehouse accounting inventory access', () => {
  const reflector = new Reflector();

  it.each([
    [WarehouseInventoryController.prototype.rawMaterials, 'warehouse_task:read'],
    [WarehouseInventoryController.prototype.rolls, 'warehouse_inventory:read'],
    [WarehouseInventoryController.prototype.roll, 'warehouse_inventory:read'],
    [WarehouseAccountingController.prototype.stock, 'warehouse_task:read'],
    [WarehouseAccountingController.prototype.movements, 'warehouse_task:read'],
  ] as const)('%p requires %s', (handler, capability) => {
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([capability]);
  });

  it('grants the roll registry to warehouse and director without routine warehouse access', () => {
    expect(capabilitiesForRole('warehouse')).toContain('warehouse_inventory:read');
    expect(capabilitiesForRole('director')).toContain('warehouse_inventory:read');
    expect(capabilitiesForRole('director')).not.toContain('warehouse_task:read');
  });
});
