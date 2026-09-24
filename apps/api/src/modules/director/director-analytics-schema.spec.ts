import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260721172000_director_material_analytics_indexes/migration.sql',
);
const defectIndexMigration = resolve(
  prismaRoot,
  'migrations/20260724160000_director_analytics_v2_defect_index/migration.sql',
);
const indexNames = [
  'wc_analytics_scan_idx',
  'wc_line_canon_idx',
  'wc_session_scan_idx',
  'sbu_analytics_period_idx',
  'sbu_bag_period_idx',
  'sbu_closed_period_idx',
  'bbu_active_period_idx',
  'ops_closed_period_idx',
] as const;

describe('director analytics read indexes', () => {
  it('keeps the migration additive and limited to the expected CREATE INDEX statements', () => {
    const sql = readFileSync(migration, 'utf8');
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    expect(statements).toHaveLength(indexNames.length);
    expect(
      statements.every((statement) => /^CREATE INDEX\s+"[^"]+"\s+ON\s+/i.test(statement)),
    ).toBe(true);
    expect(sql).not.toMatch(/\b(?:ALTER|DROP|UPDATE|DELETE|INSERT|TRUNCATE|CREATE TABLE)\b/i);
    for (const name of indexNames) expect(sql).toContain(`CREATE INDEX "${name}"`);
  });

  it('maps every migration index in the Prisma schema', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    for (const name of indexNames) expect(schema).toContain(`map: "${name}"`);
  });

  it('keeps the defect period index additive and mapped in Prisma', () => {
    const sql = readFileSync(defectIndexMigration, 'utf8');
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(sql.trim()).toBe(
      'CREATE INDEX "defect_records_created_at_id_idx" ' +
        'ON "defect_records"("createdAt", "id");',
    );
    expect(schema).toContain('@@index([createdAt, id], map: "defect_records_created_at_id_idx")');
  });
});
