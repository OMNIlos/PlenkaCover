import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMAIN_EVENTS } from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');
const selectionMigrationName = '20260807071000_warehouse_pallet_selection';
const voidLifecycleMigrationName = '20260807072000_warehouse_pallet_void_lifecycle';
const migration = readFileSync(
  resolve(prismaRoot, `migrations/${selectionMigrationName}/migration.sql`),
  'utf8',
);
const voidLifecycleMigrationPath = resolve(
  prismaRoot,
  `migrations/${voidLifecycleMigrationName}/migration.sql`,
);
const voidLifecycleMigration = existsSync(voidLifecycleMigrationPath)
  ? readFileSync(voidLifecycleMigrationPath, 'utf8')
  : '';
const runtimeContracts = readFileSync(
  resolve(__dirname, '../../../../../packages/contracts/src/warehouse-runtime.ts'),
  'utf8',
);

function model(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, 'u'));
  if (!match) throw new Error(`Missing Prisma model ${name}`);
  return match[0];
}

describe('warehouse pallet selection persistence', () => {
  it('keeps the applied migration immutable and appends void DDL in order', () => {
    const migrationNames = readdirSync(resolve(prismaRoot, 'migrations'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const addColumns = voidLifecycleMigration.indexOf('ADD COLUMN "voidedAt"');
    const legacyBackfill = voidLifecycleMigration.indexOf('UPDATE "warehouse_pallets"');
    const replaceSealConstraint = voidLifecycleMigration.indexOf(
      'DROP CONSTRAINT "warehouse_pallets_seal_state_check"',
    );
    const addVoidConstraint = voidLifecycleMigration.indexOf(
      'ADD CONSTRAINT "warehouse_pallets_void_state_check"',
    );

    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      '6c753d92155cfd98fee71926be5293502381215c2ef09cd16642d33aa7b6132b',
    );
    expect(existsSync(voidLifecycleMigrationPath)).toBe(true);
    expect(migrationNames.indexOf(voidLifecycleMigrationName)).toBeGreaterThan(
      migrationNames.indexOf(selectionMigrationName),
    );
    expect(voidLifecycleMigration).toMatch(
      /ALTER TABLE "warehouse_pallets"\s+ADD COLUMN "voidedAt" TIMESTAMP\(3\),\s+ADD COLUMN "voidedById" TEXT,\s+ADD COLUMN "voidReason" TEXT;/u,
    );
    expect(voidLifecycleMigration).toContain('"warehouse_pallets_void_state_check"');
    expect(voidLifecycleMigration).toContain(`'empty_after_last_release'`);
    expect(addColumns).toBeGreaterThan(-1);
    expect(legacyBackfill).toBeGreaterThan(addColumns);
    expect(replaceSealConstraint).toBeGreaterThan(legacyBackfill);
    expect(addVoidConstraint).toBeGreaterThan(replaceSealConstraint);
    expect(voidLifecycleMigration).not.toContain('"pallet_list_documents"');
  });

  it('keeps released memberships as history and permits one active membership per scan', () => {
    const scanRow = model('ScanRow');
    const item = model('WarehousePalletItem');

    expect(scanRow).toMatch(/palletItems\s+WarehousePalletItem\[\]/u);
    expect(item).toMatch(/scanRowId\s+String/u);
    expect(item).not.toMatch(/scanRowId[^\n]*@unique/u);
    expect(item).toMatch(/releasedAt\s+DateTime\?/u);
    expect(item).toMatch(/releasedById\s+String\?/u);
    expect(item).toMatch(/releaseReason\s+String\?/u);
    expect(migration).toContain('warehouse_pallet_items_active_scan_row_uq');
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "warehouse_pallet_items_active_scan_row_uq"\s+ON "warehouse_pallet_items" \("scanRowId"\)\s+WHERE "releasedAt" IS NULL;/u,
    );
  });

  it('adds a void lifecycle without mutating the immutable document snapshot', () => {
    const pallet = model('WarehousePallet');
    const document = model('PalletListDocument');

    expect(pallet).toMatch(/status\s+String\s+@default\("open"\).*voided/u);
    expect(pallet).toMatch(/voidedAt\s+DateTime\?/u);
    expect(pallet).toMatch(/voidedById\s+String\?/u);
    expect(pallet).toMatch(/voidReason\s+String\?/u);
    expect(document).toMatch(/voidedAt\s+DateTime\?/u);
    expect(document).toMatch(/voidedById\s+String\?/u);
    expect(document).toMatch(/voidReasonCode\s+String\?/u);
    expect(document).toMatch(/voidNote\s+String\?/u);
    expect(migration).toMatch(
      /"warehouse_pallets_status_check"[\s\S]*'open'[\s\S]*'sealed'[\s\S]*'voided'/u,
    );
    expect(voidLifecycleMigration).toContain('"warehouse_pallets_void_state_check"');
    expect(voidLifecycleMigration).toContain(`'empty_after_last_release'`);
    expect(`${migration}\n${voidLifecycleMigration}`).not.toMatch(
      /(?:DELETE FROM|TRUNCATE)\s+"(?:warehouse_pallet_items|warehouse_pallets|pallet_list_documents)"/iu,
    );
    expect(`${migration}\n${voidLifecycleMigration}`).not.toMatch(
      /UPDATE\s+"pallet_list_documents"\s+SET\s+"(?:payload|rollIds|orderIds)"/iu,
    );
  });

  it('persists one UUID-idempotent command journal for selection and voiding', () => {
    const command = model('WarehousePalletCommand');

    expect(command).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/u);
    expect(command).toMatch(/requestFingerprint\s+String\s+@db\.Char\(64\)/u);
    expect(command).toMatch(/kind\s+String/u);
    expect(command).toMatch(/taskId\s+String/u);
    expect(command).toMatch(/scanRowId\s+String\?/u);
    expect(command).toMatch(/palletId\s+String\?/u);
    expect(command).toMatch(/resultSnapshot\s+Json/u);
    expect(migration).toContain(`CHECK ("kind" IN ('set_selection', 'void_pallet'))`);
    expect(migration).toContain('warehouse_pallet_commands_append_only');
  });

  it('preflights active membership before replacing the legacy global unique index', () => {
    const preflight = migration.indexOf(
      'warehouse pallet selection migration found duplicate active scan memberships',
    );
    const dropLegacy = migration.indexOf('DROP INDEX "warehouse_pallet_items_scan_row_id_key"');
    const createActive = migration.indexOf(
      'CREATE UNIQUE INDEX "warehouse_pallet_items_active_scan_row_uq"',
    );

    expect(preflight).toBeGreaterThan(-1);
    expect(dropLegacy).toBeGreaterThan(preflight);
    expect(createActive).toBeGreaterThan(dropLegacy);
  });

  it('refreshes the order-change physical-fact guard for active non-voided pallet facts', () => {
    const releaseColumn = migration.indexOf('ADD COLUMN "releasedAt"');
    const voidedStatus = migration.indexOf(`CHECK ("status" IN ('open', 'sealed', 'voided'))`);
    const guardStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION "warehouse_coverage_decision_has_physical_facts"',
    );
    const guardEnd = migration.indexOf('ALTER TABLE "pallet_list_documents"', guardStart);
    const guard = migration.slice(guardStart, guardEnd);

    expect(guardStart).toBeGreaterThan(releaseColumn);
    expect(guardStart).toBeGreaterThan(voidedStatus);
    expect(guard).toContain('pallet."status" <> \'voided\'');
    expect(guard).toContain('item."releasedAt" IS NULL');
    expect(guard).toContain('item_pallet."id" = item."palletId"');
    expect(guard).toContain('item_pallet."status" <> \'voided\'');
  });

  it('creates command indexes before the append-only triggers deterministically', () => {
    const table = migration.indexOf('CREATE TABLE "warehouse_pallet_commands"');
    const operationIndex = migration.indexOf(
      'CREATE UNIQUE INDEX "warehouse_pallet_commands_operationKey_key"',
    );
    const triggerFunction = migration.indexOf(
      'CREATE FUNCTION "reject_warehouse_pallet_command_mutation"',
    );
    const trigger = migration.indexOf('CREATE TRIGGER "warehouse_pallet_commands_append_only"');

    expect(table).toBeGreaterThan(-1);
    expect(operationIndex).toBeGreaterThan(table);
    expect(triggerFunction).toBeGreaterThan(operationIndex);
    expect(trigger).toBeGreaterThan(triggerFunction);
  });

  it('publishes the lifecycle requests, status, and four audit facts', () => {
    expect(runtimeContracts).toContain(
      `export type WarehousePalletStatus = 'open' | 'sealed' | 'voided';`,
    );
    expect(runtimeContracts).toContain('export type SetPalletSelectionRequest = {');
    expect(runtimeContracts).toContain('export type VoidPalletRequest = {');
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'audit:warehouse_pallet_roll_selected',
        'audit:warehouse_pallet_roll_deselected',
        'audit:warehouse_pallet_voided',
        'audit:pallet_list_voided',
      ]),
    );
  });
});
