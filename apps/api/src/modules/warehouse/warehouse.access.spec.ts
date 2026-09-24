import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { WarehouseController } from './warehouse.controller';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctxFor(handler: (...args: any[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => WarehouseController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: null, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctxWithoutActor(handler: (...args: any[]) => unknown) {
  return {
    getHandler: () => handler,
    getClass: () => WarehouseController,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as never;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctxForCapabilities(handler: (...args: any[]) => unknown, capabilities: Capability[]) {
  return {
    getHandler: () => handler,
    getClass: () => WarehouseController,
    switchToHttp: () => ({
      getRequest: () => ({ actor: { userId: 'warehouse-user', role: 'warehouse', capabilities } }),
    }),
  } as never;
}

describe('warehouse role-leakage', () => {
  const guard = new CapabilityGuard(new Reflector());
  const proto = WarehouseController.prototype;

  it('warehouse notification routes are capability-gated without leaking to other roles', () => {
    const reflector = new Reflector();
    const inboxProto = proto as unknown as {
      notifications?: typeof proto.getIntake;
      markNotificationRead?: typeof proto.getIntake;
    };

    for (const handler of [inboxProto.notifications, inboxProto.markNotificationRead]) {
      expect(handler).toBeDefined();
      if (!handler) continue;

      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual([
        'warehouse_task:read',
      ]);
      expect(guard.canActivate(ctxFor(handler, 'warehouse'))).toBe(true);
      for (const role of [
        'commercial',
        'finance',
        'production_lead',
        'operator',
        'director',
      ] as const) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow();
      }
    }
  });

  it('commercial cannot scan', () => {
    expect(() => guard.canActivate(ctxFor(proto.scan, 'commercial'))).toThrow();
  });

  it('operator cannot adjust raw material stock', () => {
    expect(() => guard.canActivate(ctxFor(proto.adjust, 'operator'))).toThrow();
  });

  it('commercial cannot read warehouse raw materials route', () => {
    expect(() => guard.canActivate(ctxFor(proto.rawMaterials, 'commercial'))).toThrow();
  });

  it('warehouse CAN scan and close', () => {
    expect(guard.canActivate(ctxFor(proto.scan, 'warehouse'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.close, 'warehouse'))).toBe(true);
  });

  it('does not expose production reweigh or defect mutations through warehouse routes', () => {
    expect(proto).not.toHaveProperty('controlWeight');
    expect(proto).not.toHaveProperty('damaged');
    expect(capabilitiesForRole('operator')).toEqual(
      expect.arrayContaining(['roll:weigh', 'roll:defect']),
    );
    expect(capabilitiesForRole('warehouse')).not.toContain('roll:weigh');
    expect(capabilitiesForRole('warehouse')).not.toContain('roll:defect');
  });

  it('does not expose production-post discovery or binding to warehouse clients', () => {
    expect(proto).not.toHaveProperty('listPhysicalPosts');
    expect(proto).not.toHaveProperty('bindPost');
  });

  it('read-only universal QR inspection is restricted to the warehouse scan capability', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.inspectQr)).toEqual([
      'warehouse:scan',
    ]);
    expect(guard.canActivate(ctxFor(proto.inspectQr, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.inspectQr, role))).toThrow();
    }
  });

  it('restricts the state-changing pallet handoff scan to the warehouse scan capability', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.scanPalletHandoff)).toEqual([
      'warehouse:scan',
    ]);
    expect(guard.canActivate(ctxFor(proto.scanPalletHandoff, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.scanPalletHandoff, role))).toThrow();
    }
  });

  it('requires both scan and close capabilities for one-scan pallet delivery', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.scanPalletDelivery)).toEqual([
      'warehouse:scan',
      'warehouse:close',
    ]);
    expect(guard.canActivate(ctxFor(proto.scanPalletDelivery, 'warehouse'))).toBe(true);
    expect(() =>
      guard.canActivate(ctxForCapabilities(proto.scanPalletDelivery, ['warehouse:scan'])),
    ).toThrow();
    expect(() =>
      guard.canActivate(ctxForCapabilities(proto.scanPalletDelivery, ['warehouse:close'])),
    ).toThrow();
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.scanPalletDelivery, role))).toThrow();
    }
  });

  it('only the warehouse Big-Bag capability can create a composed bag', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.createBigBag)).toEqual([
      'bigbag:create',
    ]);
    expect(guard.canActivate(ctxFor(proto.createBigBag, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.createBigBag, role))).toThrow();
    }
  });

  it('only the warehouse reserve-roll capability can register finished stock', () => {
    const reflector = new Reflector();
    expect(
      reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.createFinishedStockRoll),
    ).toEqual(['reserve_roll:create']);
    expect(guard.canActivate(ctxFor(proto.createFinishedStockRoll, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.createFinishedStockRoll, role))).toThrow();
    }
  });

  it('gates Big-Bag movement separately from creation and never grants it cross-role', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.moveBigBag)).toEqual([
      'bigbag:move',
    ]);
    expect(guard.canActivate(ctxFor(proto.moveBigBag, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.moveBigBag, role))).toThrow();
    }
  });

  it('gates Big-Bag label printing with its dedicated capability', () => {
    const reflector = new Reflector();
    for (const handler of [
      proto.previewBigBagLabel,
      proto.recordBigBagSystemPrintIntent,
      proto.printBigBagLabel,
    ]) {
      expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler)).toEqual(['bigbag:print']);
      expect(guard.canActivate(ctxFor(handler, 'warehouse'))).toBe(true);
      expect(() => guard.canActivate(ctxFor(handler, 'operator'))).toThrow();
      expect(() => guard.canActivate(ctxFor(handler, 'admin'))).toThrow();
    }
  });

  it('keeps defect-bag queues and transitions warehouse-only', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.defectBags)).toEqual([
      'defect_bag:read',
    ]);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.receiveDefectBag)).toEqual([
      'defect_bag:receive',
    ]);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.shipDefectBag)).toEqual([
      'defect_bag:ship',
    ]);
    for (const handler of [proto.defectBags, proto.receiveDefectBag, proto.shipDefectBag]) {
      expect(guard.canActivate(ctxFor(handler, 'warehouse'))).toBe(true);
      expect(() => guard.canActivate(ctxFor(handler, 'operator'))).toThrow();
      expect(() => guard.canActivate(ctxFor(handler, 'admin'))).toThrow();
    }
  });

  it('physical coverage recovery is dedicated to the warehouse capability', () => {
    const reflector = new Reflector();
    expect(
      reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.reportCoveragePhysicalException),
    ).toEqual(['warehouse_coverage:report_physical_exception']);
    expect(guard.canActivate(ctxFor(proto.reportCoveragePhysicalException, 'warehouse'))).toBe(
      true,
    );
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() =>
        guard.canActivate(ctxFor(proto.reportCoveragePhysicalException, role)),
      ).toThrow();
    }
  });

  it('warehouse keeps raw material read and adjust capabilities', () => {
    expect(capabilitiesForRole('warehouse')).toContain('raw_material:read');
    expect(capabilitiesForRole('warehouse')).toContain('raw_material:adjust');
  });

  it('every warehouse mutation route declares a capability', () => {
    const reflector = new Reflector();
    for (const handler of [
      proto.scan,
      proto.scanPalletHandoff,
      proto.scanPalletDelivery,
      proto.close,
      proto.reserve,
      proto.release,
      proto.reportCoveragePhysicalException,
      proto.createPalletList,
      proto.createIntakePalletList,
      proto.setPalletSelection,
      proto.scanPalletSelection,
      proto.sealCurrentPallet,
      proto.closeAndPrintCurrentPallet,
      proto.recordPalletSystemPrintIntent,
      proto.printPalletList,
      proto.pushToOneC,
      proto.adjust,
      proto.createFinishedStockRoll,
      proto.createBigBag,
      proto.moveBigBag,
      proto.recordBigBagSystemPrintIntent,
      proto.printBigBagLabel,
      proto.receiveDefectBag,
      proto.shipDefectBag,
    ]) {
      const caps = reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler);
      expect(caps && caps.length).toBeTruthy();
    }
  });

  it('keeps disabled 1C stock routes hidden while retaining their capability metadata', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.previewOneCPush)).toEqual([
      'raw_material:adjust',
    ]);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.pushToOneC)).toEqual([
      'raw_material:adjust',
    ]);
    expect(() => guard.canActivate(ctxFor(proto.previewOneCPush, 'warehouse'))).toThrow(
      NotFoundException,
    );
    expect(() => guard.canActivate(ctxFor(proto.pushToOneC, 'warehouse'))).toThrow(
      NotFoundException,
    );
    expect(() => guard.canActivate(ctxFor(proto.previewOneCPush, 'admin'))).toThrow();
    expect(() => guard.canActivate(ctxFor(proto.pushToOneC, 'admin'))).toThrow();
  });

  it('raw materials route requires warehouse_task:read', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.rawMaterials)).toEqual([
      'warehouse_task:read',
    ]);
  });

  it('pallet preview is read-only and requires warehouse_task:read', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.previewPalletList)).toEqual([
      'warehouse_task:read',
    ]);
  });

  it('printer discovery is safe read access and direct print requires pallet creation', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.listPrinters)).toEqual([
      'warehouse_task:read',
    ]);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.printPalletList)).toEqual([
      'pallet_list:create',
    ]);
    expect(
      reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.recordPalletSystemPrintIntent),
    ).toEqual(['pallet_list:create']);
    expect(() => guard.canActivate(ctxWithoutActor(proto.recordPalletSystemPrintIntent))).toThrow();
    expect(guard.canActivate(ctxFor(proto.recordPalletSystemPrintIntent, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.recordPalletSystemPrintIntent, role))).toThrow();
    }
  });

  it('exposes Big-Bag printer discovery only through warehouse safe read access', () => {
    const reflector = new Reflector();
    const { listBigBagPrinters } = proto;

    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, listBigBagPrinters)).toEqual([
      'warehouse_task:read',
    ]);
    expect(guard.canActivate(ctxFor(listBigBagPrinters, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(listBigBagPrinters, role))).toThrow();
    }
  });

  it('physical pallet history, seal and close-and-print use explicit warehouse capabilities', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.listTaskPallets)).toEqual([
      'warehouse_task:read',
    ]);
    expect(
      reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.closeAndPrintCurrentPallet),
    ).toEqual(['pallet_list:create']);
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.sealCurrentPallet)).toEqual([
      'pallet_list:create',
    ]);
    expect(guard.canActivate(ctxFor(proto.listTaskPallets, 'warehouse'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.sealCurrentPallet, 'warehouse'))).toBe(true);
    expect(guard.canActivate(ctxFor(proto.closeAndPrintCurrentPallet, 'warehouse'))).toBe(true);

    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.listTaskPallets, role))).toThrow();
      expect(() => guard.canActivate(ctxFor(proto.sealCurrentPallet, role))).toThrow();
      expect(() => guard.canActivate(ctxFor(proto.closeAndPrintCurrentPallet, role))).toThrow();
    }
  });

  it('allows only warehouse to change pallet selection', () => {
    const reflector = new Reflector();
    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.setPalletSelection)).toEqual([
      'pallet_list:create',
    ]);
    expect(guard.canActivate(ctxFor(proto.setPalletSelection, 'warehouse'))).toBe(true);

    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.setPalletSelection, role))).toThrow();
    }
  });

  it('requires scan and pallet-creation capabilities for QR pallet selection', () => {
    const reflector = new Reflector();
    expect(
      reflector.get<Capability[]>(REQUIRE_CAPABILITIES, proto.scanPalletSelection),
    ).toEqual(['warehouse:scan', 'pallet_list:create']);
    expect(guard.canActivate(ctxFor(proto.scanPalletSelection, 'warehouse'))).toBe(true);
    expect(() =>
      guard.canActivate(ctxForCapabilities(proto.scanPalletSelection, ['warehouse:scan'])),
    ).toThrow();
    expect(() =>
      guard.canActivate(ctxForCapabilities(proto.scanPalletSelection, ['pallet_list:create'])),
    ).toThrow();

    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(proto.scanPalletSelection, role))).toThrow();
    }
  });

  it('allows only warehouse to annul a sealed pallet list', () => {
    const reflector = new Reflector();
    const voidPallet = (proto as unknown as { voidPallet: typeof proto.setPalletSelection })
      .voidPallet;

    expect(reflector.get<Capability[]>(REQUIRE_CAPABILITIES, voidPallet)).toEqual([
      'pallet_list:create',
    ]);
    expect(guard.canActivate(ctxFor(voidPallet, 'warehouse'))).toBe(true);
    for (const role of [
      'commercial',
      'finance',
      'production_lead',
      'operator',
      'director',
      'admin',
    ] as const) {
      expect(() => guard.canActivate(ctxFor(voidPallet, role))).toThrow();
    }
  });
});
