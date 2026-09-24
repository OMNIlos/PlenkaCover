import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMAIN_EVENTS, ROLE_CAPABILITIES } from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260803220000_raw_material_bigbag_lifecycle/migration.sql',
);
const valuationMigration = resolve(
  prismaRoot,
  'migrations/20260806013000_bigbag_valuation/migration.sql',
);
const supplierReceiptMigration = resolve(
  prismaRoot,
  'migrations/20260811113000_bigbag_supplier_receipt_facts/migration.sql',
);
const browserSystemPrintMigration = resolve(
  prismaRoot,
  'migrations/20260811122500_bigbag_browser_system_print/migration.sql',
);

describe('Big-Bag lifecycle persistence and authorization', () => {
  it('publishes granular warehouse capabilities and audited facts', () => {
    expect(ROLE_CAPABILITIES.warehouse).toEqual(
      expect.arrayContaining(['bigbag:create', 'bigbag:print', 'bigbag:move']),
    );
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'audit:bigbag_label_print_requested',
        'audit:bigbag_label_reprint_requested',
        'audit:bigbag_registration_confirmed',
        'audit:bigbag_moved_to_production',
        'audit:bigbag_returned_to_warehouse',
        'audit:bigbag_warehouse_weight_recorded',
        'audit:operator_shift_bag_released',
      ]),
    );
  });

  it('models opaque tokens, idempotent movements and durable print requests', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toMatch(
      /model BigBagUnit \{[\s\S]*registrationStatus\s+String\s+@default\("pending_scan"\)/,
    );
    expect(schema).toMatch(/model BigBagUnit \{[\s\S]*location\s+String\s+@default\("warehouse"\)/);
    expect(schema).toMatch(/locationRevision\s+Int\s+@default\(0\)/);
    expect(schema).toContain('model BigBagScanToken {');
    expect(schema).toMatch(/token\s+String\s+@unique\s+@db\.Char\(68\)/);
    expect(schema).toContain('model BigBagMovement {');
    expect(schema).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/);
    expect(schema).toMatch(/requestFingerprint\s+String\s+@db\.Char\(64\)/);
    expect(schema).toMatch(/resultSnapshot\s+Json/);
    expect(schema).toContain('model BigBagLabelPrintJob {');
    expect(schema).toMatch(/requestId\s+String\s+@unique\s+@db\.Uuid/);
    expect(schema).toMatch(/priceKopecksPerKg\s+Int\?/);
    expect(schema).toMatch(/priceSource\s+String\?/);
    expect(schema).toMatch(/priceEffectiveAt\s+DateTime\?/);
    expect(schema).toMatch(/supplierName\s+String\?/);
    expect(schema).toMatch(/receivedAt\s+DateTime\?/);
  });

  it('migrates existing bags conservatively and constrains lifecycle values', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain(`SET "registrationStatus" = 'registered'`);
    expect(sql).toContain('big_bag_scan_tokens_token_format_check');
    expect(sql).toContain('big_bag_units_registration_status_check');
    expect(sql).toContain('big_bag_units_location_check');
    expect(sql).toContain('big_bag_movements_destination_check');
    expect(sql).toContain('big_bag_label_print_jobs_status_check');
    expect(sql).toContain(`'ПВД Первичное'`);
    expect(sql).toContain(`'Краситель синей'`);
    expect(sql).toContain(`'Уф - стабилизатор'`);
  });

  it('persists optional price provenance without storing a stale total', () => {
    expect(existsSync(valuationMigration)).toBe(true);
    if (!existsSync(valuationMigration)) return;

    const sql = readFileSync(valuationMigration, 'utf8');
    expect(sql).toContain('"priceKopecksPerKg" INTEGER');
    expect(sql).toContain('"priceSource" TEXT');
    expect(sql).toContain('"priceEffectiveAt" TIMESTAMP(3)');
    expect(sql).toContain('big_bag_units_price_non_negative_check');
    expect(sql).toContain('big_bag_units_price_provenance_check');
    expect(sql).not.toContain('"totalKopecks"');
  });

  it('adds nullable supplier and confirmed receipt facts without rewriting legacy bags', () => {
    expect(existsSync(supplierReceiptMigration)).toBe(true);
    if (!existsSync(supplierReceiptMigration)) return;

    const sql = readFileSync(supplierReceiptMigration, 'utf8');
    expect(sql).toContain('ADD COLUMN "supplierName" TEXT');
    expect(sql).toContain('ADD COLUMN "receivedAt" TIMESTAMP(3)');
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\b/iu);
    expect(sql).not.toContain('NOT NULL');
  });

  it('adds browser-owned Big-Bag printing without assigning a production-post printer', () => {
    expect(existsSync(browserSystemPrintMigration)).toBe(true);
    if (!existsSync(browserSystemPrintMigration)) return;

    const sql = readFileSync(browserSystemPrintMigration, 'utf8');
    expect(sql).toContain('ALTER COLUMN "printerId" DROP NOT NULL');
    expect(sql).toContain('ADD COLUMN "channel" TEXT NOT NULL DEFAULT \'gateway\'');
    expect(sql).toContain("'intent_recorded'");
    expect(sql).toContain('big_bag_label_print_jobs_channel_check');
    expect(sql).toContain('big_bag_label_print_jobs_printer_channel_check');
    expect(sql).toContain('big_bag_label_print_jobs_channel_state_check');
    expect(sql).toContain('"status" <> \'intent_recorded\'');
    expect(sql).toContain('"status" = \'intent_recorded\'');
    expect(sql).toContain('"gatewayCommandId" IS NULL');
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\b/iu);
  });
});
