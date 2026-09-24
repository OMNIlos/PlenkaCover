import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260717160000_onec_stock_push_idempotency/migration.sql',
);
const stockRevisionMigration = resolve(
  prismaRoot,
  'migrations/20260717161000_raw_material_stock_revision/migration.sql',
);

describe('1C stock push persistence', () => {
  it('defines durable operation-key and snapshot-level deduplication', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');
    expect(schema).toContain('model OneCStockPushOperation {');
    expect(schema).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/);
    expect(schema).toMatch(/snapshotHash\s+String\s+@unique/);
    expect(schema).toMatch(/safeResult\s+Json\?/);
    expect(schema).toMatch(/model RawMaterialStock \{[\s\S]*revision\s+Int\s+@default\(1\)/);
  });

  it('constrains hashes and conservative terminal states in PostgreSQL', () => {
    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain('onec_stock_push_operations_operationKey_key');
    expect(sql).toContain('onec_stock_push_operations_snapshotHash_key');
    expect(sql).toContain("'in_progress', 'succeeded', 'outcome_unknown'");
    expect(sql).toContain('snapshotHash_lowercase_sha256_check');
  });

  it('increments the stock revision only when an outbound 1С stock field changes', () => {
    const sql = readFileSync(stockRevisionMigration, 'utf8');
    expect(sql).toContain('bump_raw_material_stock_revision');
    expect(sql).toContain('IS DISTINCT FROM');
    expect(sql).toContain('OLD."revision" + 1');
  });
});
