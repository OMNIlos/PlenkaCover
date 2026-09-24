import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMAIN_EVENTS } from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(prismaRoot, 'migrations/20260806023000_defect_spool_stock/migration.sql');
const purgeDetachMigration = resolve(
  prismaRoot,
  'migrations/20260812120000_preserve_spool_movements_on_order_purge/migration.sql',
);

describe('defect spool stock persistence', () => {
  it('models one physical warehouse return with nullable defect provenance', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toContain('model SpoolStockMovement {');
    expect(schema).toMatch(/defectRecordId\s+String\?\s+@unique/);
    expect(schema).toMatch(
      /defectRecord\s+DefectRecord\?\s+@relation\(fields: \[defectRecordId\], references: \[id\], onDelete: SetNull, onUpdate: Restrict\)/,
    );
    expect(schema).toMatch(/quantity\s+Int\s+@default\(1\)/);
    expect(schema).toMatch(/location\s+String\s+@default\("warehouse"\)/);
    expect(DOMAIN_EVENTS).toContain('audit:defect_spool_returned');
  });

  it('adds only a constrained table and does not rewrite historical defects', () => {
    const sql = readFileSync(migration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE "spool_stock_movements"');
    expect(sql).toContain('"spool_stock_movements_defectRecordId_key"');
    expect(sql).toContain('"spool_stock_movements_quantity_check"');
    expect(sql).toContain('"spool_stock_movements_tare_check"');
    expect(sql).toContain('"spool_stock_movements_location_check"');
    expect(sql).toContain('FOREIGN KEY ("defectRecordId") REFERENCES "defect_records"("id")');
    expect(sql).not.toMatch(/UPDATE\s+"defect_records"/u);
    expect(sql).not.toMatch(/DELETE\s+FROM/u);
  });

  it('detaches only defect provenance without rewriting physical spool facts', () => {
    const sql = readFileSync(purgeDetachMigration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('ALTER COLUMN "defectRecordId" DROP NOT NULL');
    expect(sql).toContain('ON DELETE SET NULL ON UPDATE RESTRICT');
    expect(sql).not.toMatch(/UPDATE\s+"|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE/u);
    expect(sql).not.toMatch(/"tareKg"|"quantity"|"spoolType"|"location"/u);
  });
});
