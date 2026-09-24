import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DOMAIN_EVENTS,
  type WarehousePalletDeliveryScanResult,
  type WarehousePalletHandoffScanResult,
} from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260731180000_warehouse_incremental_pallets/migration.sql',
);
const handoffCommandMigration = resolve(
  prismaRoot,
  'migrations/20260817100000_warehouse_pallet_handoff_command_kind/migration.sql',
);
const deliveryCommandMigration = resolve(
  prismaRoot,
  'migrations/20260817120000_warehouse_pallet_delivery_scan_command_kind/migration.sql',
);

describe('warehouse physical pallet persistence', () => {
  it('registers the audited physical pallet lifecycle', () => {
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'audit:warehouse_pallet_opened',
        'audit:warehouse_pallet_sealed',
        'audit:warehouse_pallet_order_mismatch_rejected',
        'audit:warehouse_pallet_cutover_applied',
        'audit:warehouse_pallet_handoff_scanned',
        'audit:warehouse_pallet_delivery_scanned',
      ]),
    );
  });

  it('shares the bounded pallet handoff response contract', () => {
    const result: WarehousePalletHandoffScanResult = {
      operationKey: '123e4567-e89b-42d3-a456-426614174000',
      documentId: 'document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      deliveryCreated: true,
      rollCount: 2,
      replayed: false,
    };

    expect(result).toEqual({
      operationKey: '123e4567-e89b-42d3-a456-426614174000',
      documentId: 'document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      deliveryCreated: true,
      rollCount: 2,
      replayed: false,
    });
  });

  it('shares the bounded pallet delivery response contract', () => {
    const result: WarehousePalletDeliveryScanResult = {
      operationKey: '123e4567-e89b-42d3-a456-426614174000',
      documentId: 'document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      rollCount: 2,
      newlyDeliveredRollCount: 2,
      alreadyDeliveredRollCount: 0,
      remainingRollCount: 0,
      taskStatus: 'closed',
      deliveryClosed: true,
      replayed: false,
    };

    expect(result).toEqual({
      operationKey: '123e4567-e89b-42d3-a456-426614174000',
      documentId: 'document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      rollCount: 2,
      newlyDeliveredRollCount: 2,
      alreadyDeliveredRollCount: 0,
      remainingRollCount: 0,
      taskStatus: 'closed',
      deliveryClosed: true,
      replayed: false,
    });
  });

  it('models one-order pallets and ordered scan membership', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toContain('model WarehousePallet {');
    expect(schema).toContain('model WarehousePalletItem {');
    expect(schema).toMatch(/closeRequestId\s+String\?\s+@unique\s+@db\.Uuid/);
    expect(schema).toMatch(
      /@@unique\(\[orderId, sequenceNo\], map: "warehouse_pallets_order_id_sequence_no_key"\)/,
    );
    expect(schema).toMatch(/palletItems\s+WarehousePalletItem\[\]/);
    expect(schema).not.toMatch(/scanRowId[^\n]*@unique/);
    expect(schema).toMatch(
      /@@unique\(\[palletId, position\], map: "warehouse_pallet_items_pallet_id_position_key"\)/,
    );
    expect(schema).toMatch(/warehousePalletId\s+String\?\s+@unique/);
    expect(schema).toMatch(/acceptanceTaskId\s+String\?/);
    expect(schema).toMatch(/origin\s+String\s+@default\("legacy"\)/);
    expect(schema).toMatch(
      /kind\s+String\s+\/\/ set_selection \| void_pallet \| pallet_handoff_scan \| pallet_delivery_scan/,
    );
  });

  it('creates additive constraints including one open pallet per task', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain('CREATE TABLE "warehouse_pallets"');
    expect(sql).toContain('CREATE TABLE "warehouse_pallet_items"');
    expect(sql).toContain('warehouse_pallets_one_open_per_task_uq');
    expect(sql).toContain(`WHERE "status" = 'open'`);
    expect(sql).toContain('warehouse_pallet_items_scan_row_id_key');
    expect(sql).toContain('warehouse_pallet_items_pallet_id_position_key');
    expect(sql).toContain('ADD COLUMN "warehousePalletId" TEXT');
    expect(sql).toContain('ADD COLUMN "acceptanceTaskId" TEXT');
    expect(sql).toContain('ADD COLUMN "origin" TEXT NOT NULL DEFAULT');
  });

  it('extends the immutable command journal for pallet handoff scans', () => {
    expect(existsSync(handoffCommandMigration)).toBe(true);
    if (!existsSync(handoffCommandMigration)) return;

    const sql = readFileSync(handoffCommandMigration, 'utf8');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain('DROP CONSTRAINT "warehouse_pallet_commands_kind_check"');
    expect(sql).toContain('DROP CONSTRAINT "warehouse_pallet_commands_scope_check"');
    expect(sql).toContain(
      `CHECK ("kind" IN ('set_selection', 'void_pallet', 'pallet_handoff_scan'))`,
    );
    expect(sql).toMatch(
      /"kind" = 'pallet_handoff_scan'[\s\S]*?"scanRowId" IS NULL[\s\S]*?"palletId" IS NOT NULL/u,
    );
    expect(sql).not.toMatch(
      /DELETE\s+FROM|TRUNCATE|UPDATE\s+"warehouse_pallet_commands"|DROP\s+(?:TABLE|COLUMN)/iu,
    );
  });

  it('extends the immutable command journal for pallet delivery scans', () => {
    expect(existsSync(deliveryCommandMigration)).toBe(true);
    if (!existsSync(deliveryCommandMigration)) return;

    const sql = readFileSync(deliveryCommandMigration, 'utf8');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain('DROP CONSTRAINT "warehouse_pallet_commands_kind_check"');
    expect(sql).toContain('DROP CONSTRAINT "warehouse_pallet_commands_scope_check"');
    expect(sql).toContain(
      `CHECK ("kind" IN ('set_selection', 'void_pallet', 'pallet_handoff_scan', 'pallet_delivery_scan'))`,
    );
    expect(sql).toMatch(
      /"kind" = 'pallet_delivery_scan'[\s\S]*?"scanRowId" IS NULL[\s\S]*?"palletId" IS NOT NULL/u,
    );
    expect(sql).toContain(
      'VALIDATE CONSTRAINT "warehouse_pallet_commands_kind_check"',
    );
    expect(sql).toContain(
      'VALIDATE CONSTRAINT "warehouse_pallet_commands_scope_check"',
    );
    expect(sql).not.toMatch(
      /DELETE\s+FROM|TRUNCATE|UPDATE\s+"warehouse_pallet_commands"|DROP\s+(?:TABLE|COLUMN)/iu,
    );
  });
});
